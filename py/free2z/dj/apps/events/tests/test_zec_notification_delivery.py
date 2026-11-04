"""A node credit and its normal notification survive transport outages.

Use real Postgres for receipts, ledger credit, Event and outbox transactions;
only Pub/Sub and the channel layer are replaced at external boundaries.
"""
import asyncio
import json
import os
import uuid
from concurrent.futures import Future
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.db import DatabaseError, IntegrityError, transaction
from django.test import override_settings
from django.utils import timezone

from dj.apps.events import dispatch, signals
from dj.apps.events.consumers import EventConsumer
from dj.apps.events.management.commands import push_events
from dj.apps.events.models import Event
from dj.apps.events.serializers import REDACTED_EVENT_MESSAGE
from dj.apps.g12f.models import Creator, CreatorBlock
from dj.apps.jobs import outbox
from dj.apps.jobs.models import OutboxMessage
from dj.apps.tuzis import zec
from dj.apps.tuzis.models import ZecCreditReceipt, ZecPendingNotice
from dj.free2z.channel_layer_config import redis_channel_layer_config

pytestmark = pytest.mark.django_db
REAL_DEFER_RELAY = outbox.defer_relay


@pytest.fixture(autouse=True)
def transport_boundaries(monkeypatch):
    # Keep tests' enclosing Postgres transaction; real callbacks otherwise
    # retire its connection because tests configure CONN_MAX_AGE=0.
    monkeypatch.setattr(push_events, 'close_old_connections', lambda: None)
    monkeypatch.setattr(push_events.time, 'sleep', lambda _: None)
    monkeypatch.setattr(outbox, 'defer_relay', lambda: None)


def purchase(buyer):
    return zec.credit_zec_purchase(
        creator=buyer, txid='a1' * 32, pool='orchard', output_index=0,
        amount_zec=Decimal('0.01'), tuzis_per_zec=Decimal('3690'),
        confirmations=3,
    )


def pending(buyer):
    return zec.notify_pending_note(
        creator=buyer, txid='a1' * 32, pool='orchard', output_index=0,
        amount_zec=Decimal('0.01'), tuzis_per_zec=Decimal('3690'),
        confirmations=1,
    )


def envelope(data):
    return SimpleNamespace(
        data=json.dumps(data).encode(), ack=Mock(), nack=Mock(),
    )


class Layer:
    def __init__(self):
        self.sent = []
        self.fail = False

    async def group_send(self, group, data):
        if self.fail:
            raise ConnectionError('Redis temporarily unavailable')
        self.sent.append((group, data))


def test_credit_commits_unread_event_and_outbox_without_node_pubsub(
        creator_factory, monkeypatch, api_client):
    buyer = creator_factory(tuzis=Decimal('0'))
    legacy_client = Mock()
    monkeypatch.setattr(signals, 'PubSubClient', legacy_client)
    receipt = purchase(buyer)
    buyer.refresh_from_db()
    event = Event.objects.get(receiving_user=buyer)
    promise = OutboxMessage.objects.get()
    assert buyer.tuzis == receipt.tuzis_credited == Decimal('36.900')
    assert event.type == 'BOUGHT_TUZI' and event.read is False
    assert event.amount == receipt.tuzis_credited
    assert promise.topic == settings.PUBSUB['NEW_EVENT']['topic']
    assert promise.payload['id'] == str(event.pk)
    assert promise.payload['amount'] == 36.9
    assert promise.dedup_key == f'event:{event.pk}'
    assert promise.attributes == {
        'event_id': str(event.pk), 'event_type': 'BOUGHT_TUZI',
    }
    legacy_client.assert_not_called()
    api_client.force_authenticate(user=buyer)
    assert api_client.get('/api/events/unread_count/').json() == 1
    assert api_client.get('/api/events/unread_count/?include_recipient=1').json() == {
        'unread_count': 1, 'recipient_username': buyer.username,
    }
    items = api_client.get('/api/events/?type=social').json()['results']
    assert [(e['id'], e['type']) for e in items] == [
        (str(event.pk), 'BOUGHT_TUZI'),
    ]
    with pytest.raises(zec.AlreadyCredited):
        purchase(buyer)
    assert Event.objects.count() == OutboxMessage.objects.count() == 1


def test_pending_then_credit_share_relay_key_and_do_not_duplicate(
        creator_factory):
    buyer = creator_factory(tuzis=Decimal('0'))
    assert pending(buyer)
    assert pending(buyer) is None
    purchase(buyer)
    promises = list(OutboxMessage.objects.order_by('created_at'))
    # The relay starts these in order; Pub/Sub's existing subscription does
    # not enable message ordering, so browser delivery order is not promised.
    assert [p.payload['type'] for p in promises] == ['ZEC_PENDING', 'BOUGHT_TUZI']
    assert {p.ordering_key for p in promises} == {f'event-user:{buyer.pk}'}
    assert len({p.payload['id'] for p in promises}) == 2
    assert ZecPendingNotice.objects.count() == 1


@pytest.mark.parametrize('create', [purchase, pending])
@pytest.mark.parametrize('error', [DatabaseError, IntegrityError])
def test_failed_delivery_promise_rolls_back_domain_and_event(
        creator_factory, monkeypatch, create, error):
    buyer = creator_factory(tuzis=Decimal('0'))
    monkeypatch.setattr(outbox, 'enqueue', Mock(side_effect=error('outbox unavailable')))
    with pytest.raises(error):
        create(buyer)
    buyer.refresh_from_db()
    assert buyer.tuzis == Decimal('0')
    assert not ZecCreditReceipt.objects.exists()
    assert not ZecPendingNotice.objects.exists()
    assert not Event.objects.exists()
    assert not OutboxMessage.objects.exists()


def test_outer_rollback_discards_credit_notification_and_delivery(
        creator_factory):
    buyer = creator_factory(tuzis=Decimal('0'))
    with pytest.raises(RuntimeError):
        with transaction.atomic():
            purchase(buyer)
            raise RuntimeError('node died before commit')
    buyer.refresh_from_db()
    assert buyer.tuzis == Decimal('0')
    assert not ZecCreditReceipt.objects.exists()
    assert not Event.objects.exists()
    assert not OutboxMessage.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_node_commit_survives_failed_relay_wakeup(creator_factory, monkeypatch):
    from dj.apps.jobs import tasks

    buyer = creator_factory(tuzis=Decimal('0'))
    monkeypatch.setattr(outbox, 'defer_relay', REAL_DEFER_RELAY)
    monkeypatch.setattr(
        tasks.publish_outbox_task, 'configure',
        Mock(return_value=SimpleNamespace(defer=Mock(
            side_effect=DatabaseError('job queue temporarily unavailable'),
        ))),
    )
    receipt = purchase(buyer)
    buyer.refresh_from_db()
    assert buyer.tuzis == receipt.tuzis_credited == Decimal('36.900')
    assert Event.objects.count() == 1
    # No process-local callback remains after a node restart. The periodic
    # GKE sweep sees this durable promise and can still publish it.
    assert OutboxMessage.objects.get().published_at is None


def test_pubsub_outage_retries_existing_promise_then_pushes_normal_event(
        creator_factory, monkeypatch):
    buyer = creator_factory(tuzis=Decimal('0'))
    purchase(buyer)
    promise = OutboxMessage.objects.get()
    publisher = Mock()
    publisher.publish.side_effect = ConnectionError('Pub/Sub unavailable')
    assert outbox.drain(client=publisher)['failed'] == 1
    promise.refresh_from_db()
    assert promise.published_at is None and promise.attempts == 1
    future = Future()
    future.set_result('message-1')
    publisher.publish.side_effect = None
    publisher.publish.return_value = future
    OutboxMessage.objects.filter(pk=promise.pk).update(next_attempt_at=timezone.now())
    assert outbox.drain(client=publisher)['published'] == 1
    promise.refresh_from_db()
    assert promise.published_at is not None
    layer = Layer()
    monkeypatch.setattr(push_events, 'get_channel_layer', lambda: layer)
    message = envelope(publisher.publish.call_args.args[1])
    push_events.callback(message)
    message.ack.assert_called_once()
    message.nack.assert_not_called()
    assert layer.sent == [(f'user_{buyer.pk}', {
        'type': 'events_message', 'content': Event.objects.get().to_dict(),
    })]
    assert Event.objects.count() == ZecCreditReceipt.objects.count() == 1


def test_redis_outage_nacks_then_redelivery_uses_same_event_identity(
        creator_factory, monkeypatch):
    buyer = creator_factory(tuzis=Decimal('0'))
    purchase(buyer)
    layer = Layer()
    layer.fail = True
    monkeypatch.setattr(push_events, 'get_channel_layer', lambda: layer)
    message = envelope(OutboxMessage.objects.get().payload)
    push_events.callback(message)
    message.ack.assert_not_called()
    message.nack.assert_called_once()
    layer.fail = False
    push_events.callback(message)
    message.ack.assert_called_once()
    assert layer.sent[0][1]['content']['id'] == str(Event.objects.get().pk)
    assert Event.objects.count() == ZecCreditReceipt.objects.count() == 1


def test_wedged_channel_send_is_bounded_and_retried(creator_factory, monkeypatch):
    buyer = creator_factory(tuzis=Decimal('0'))
    purchase(buyer)

    class WedgedLayer:
        async def group_send(self, *args):
            await asyncio.Future()

    monkeypatch.setattr(push_events, 'get_channel_layer', WedgedLayer)
    monkeypatch.setattr(push_events, 'CHANNEL_SEND_TIMEOUT_SECONDS', 0.01)
    message = envelope(OutboxMessage.objects.get().payload)
    push_events.callback(message)
    message.ack.assert_not_called()
    message.nack.assert_called_once()


def test_delivery_reloads_current_recipient_read_state_and_redactions(
        creator_factory, monkeypatch):
    buyer = creator_factory()
    counterparty = creator_factory()
    event = dispatch.create_durable_event(
        type='DONATION_RECEIVED', amount=10, receiving_user=buyer,
        contributor=counterparty,
    )
    message = envelope(OutboxMessage.objects.get().payload)
    # The published snapshot has a stale counterparty and unread state; the
    # worker must use the row, and never trust a payload's routing identity.
    Creator.objects.filter(pk=counterparty.pk).update(is_active=False)
    Event.objects.filter(pk=event.pk).update(read=True)
    payload = json.loads(message.data)
    payload['receiving_user'] = {'id': counterparty.pk, 'username': 'wrong-user'}
    message.data = json.dumps(payload).encode()
    layer = Layer()
    monkeypatch.setattr(push_events, 'get_channel_layer', lambda: layer)
    push_events.callback(message)
    group, wire = layer.sent[0]
    assert group == f'user_{buyer.pk}'
    assert wire['content']['id'] == str(event.pk)
    assert wire['content']['read'] is True
    assert wire['content']['contributor'] is None
    assert wire['content']['message'] == REDACTED_EVENT_MESSAGE
    message.ack.assert_called_once()


def test_blocked_social_event_is_acked_without_push(creator_factory, monkeypatch):
    buyer, sender = creator_factory(), creator_factory()
    event = Event.objects.create(
        type='NEW_REPLY', receiving_user=buyer, contributor=sender,
    )
    CreatorBlock.objects.create(blocker=buyer, blocked=sender)
    layer = Layer()
    monkeypatch.setattr(push_events, 'get_channel_layer', lambda: layer)
    message = envelope({'id': str(event.pk)})
    push_events.callback(message)
    message.ack.assert_called_once()
    message.nack.assert_not_called()
    assert layer.sent == []


@pytest.mark.parametrize('data', [{}, [], {'id': 'invalid'}, {'id': str(uuid.uuid4())}])
def test_poison_or_deleted_event_is_terminal(data, monkeypatch):
    layer = Layer()
    monkeypatch.setattr(push_events, 'get_channel_layer', lambda: layer)
    message = envelope(data)
    push_events.callback(message)
    message.ack.assert_called_once()
    message.nack.assert_not_called()
    assert layer.sent == []


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('redis_transport', [
    False,
    pytest.param(True, marks=pytest.mark.skipif(
        not os.environ.get('REDIS_HOST'), reason='REDIS_HOST not configured',
    )),
])
async def test_committed_node_receipt_reaches_profile_websocket(
        creator_factory, redis_transport):
    buyer = await database_sync_to_async(creator_factory)(tuzis=Decimal('0'))
    await database_sync_to_async(purchase)(buyer)
    payload = await database_sync_to_async(
        lambda: OutboxMessage.objects.get().payload,
    )()
    layer = (
        redis_channel_layer_config(
            host=os.environ['REDIS_HOST'],
            port=int(os.environ.get('REDIS_PORT', '6379')),
            prefix=f'test-zec-push-{uuid.uuid4()}',
        ) if redis_transport else {'BACKEND': 'channels.layers.InMemoryChannelLayer'}
    )
    with override_settings(CHANNEL_LAYERS={'default': layer}):
        socket = WebsocketCommunicator(EventConsumer.as_asgi(), '/ws/profile')
        socket.scope['user'] = buyer
        assert (await socket.connect())[0]
        try:
            message = envelope(payload)
            await database_sync_to_async(push_events.callback)(message)
            wire = await socket.receive_json_from(timeout=5)
            assert wire['type'] == 'events_message'
            assert wire['content']['id'] == payload['id']
            assert wire['content']['type'] == 'BOUGHT_TUZI'
            assert wire['content']['amount'] == 36.9
            assert wire['content']['read'] is False
            message.ack.assert_called_once()
            message.nack.assert_not_called()
        finally:
            await socket.disconnect()
