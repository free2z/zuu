"""Room evidence commits before financial locks; receipts still settle atomically."""
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from django.db import close_old_connections, connection, transaction
from django.urls import resolve

from dj.apps.dyte import views
from dj.apps.dyte.models import CreatorMeeting, WebhookDelivery
from dj.apps.dyte.test_webhook_idempotency import (
    _meeting, _post, keypair as keypair, webhook_boundaries as webhook_boundaries,
)
from dj.apps.economy import products, services as money
from dj.apps.economy.models import PayableJournal
from dj.apps.economy.tests.test_integration import (
    ppv_fixture, reset_isolated_policy as reset_isolated_policy,
)

pytestmark = pytest.mark.django_db(transaction=True)


def test_session_observation_commits_before_settlement_and_survives_financial_rollback(
        creator_factory, api_client, keypair, mocker):
    host, viewer, cm, admission = ppv_fixture(creator_factory)
    room = dict(_meeting(cm.meeting_id), sessionId=str(cm.provider_session_id),
        startedAt=cm.provider_session_started_at.isoformat())
    # An immutable admission is bound to B, while a legacy writer has retained
    # A's reusable room projection. B's viewer departure must invalidate A even
    # when settlement fails and the provider retries the exact delivery.
    older_id = uuid.uuid4()
    older_at = cm.provider_session_started_at - timedelta(seconds=10)
    CreatorMeeting.objects.filter(pk=cm.pk).update(provider_session_id=older_id,
        provider_session_started_at=older_at, host_presence_session_id=older_id,
        host_presence_session_started_at=older_at)
    assert 'default' in resolve('/api/dyte/webhook').func._non_atomic_requests
    observe = views._observe_provider_session

    def outside_request_transaction(**kwargs):
        assert not connection.in_atomic_block
        return observe(**kwargs)

    mocker.patch.object(views, '_observe_provider_session', side_effect=outside_request_transaction)
    settle = products.settle_livestream_delivery
    attempts = []

    def read_and_lock_from_another_connection():
        close_old_connections()
        try:
            with transaction.atomic():
                # NOWAIT would fail if the observer still held its row lock
                # inside the request or financial transaction.
                observed = CreatorMeeting.objects.select_for_update(nowait=True).get(pk=cm.pk)
                return observed.provider_session_id, observed.lifecycle_state, observed.host_peer_id
        finally:
            close_old_connections()

    def checked_settlement(**kwargs):
        assert connection.in_atomic_block
        with ThreadPoolExecutor(max_workers=1) as executor:
            observed = executor.submit(read_and_lock_from_another_connection).result(timeout=5)
        assert observed == (uuid.UUID(room['sessionId']), 'starting', None)
        result = settle(**kwargs)
        attempts.append(result.pk)
        if len(attempts) == 1:
            raise RuntimeError('synthetic failure after settlement writes')
        return result

    mocker.patch.object(products, 'settle_livestream_delivery', side_effect=checked_settlement)
    payload = json.dumps({'event': 'meeting.participantLeft', 'meeting': room, 'participant': {
        'peerId': str(uuid.uuid4()), 'userDisplayName': 'Synthetic viewer',
        'customParticipantId': 'ea_' + admission.pk.hex,
        'joinedAt': admission.admitted_at.isoformat(), 'leftAt': money._db_now().isoformat(),
    }}).encode()
    delivery = uuid.uuid4()
    viewer.refresh_from_db()
    balance = viewer.tuzis
    with pytest.raises(RuntimeError, match='synthetic failure after settlement writes'):
        _post(api_client, keypair[0], payload, delivery, drain=False)
    cm.refresh_from_db()
    viewer.refresh_from_db()
    assert cm.provider_session_id == uuid.UUID(room['sessionId']) and cm.host_peer_id is None
    assert cm.lifecycle_state == 'starting'
    assert viewer.tuzis == balance
    assert not WebhookDelivery.objects.filter(provider_event_id=delivery).exists()
    assert not PayableJournal.objects.filter(admission=admission).exists()
    assert _post(api_client, keypair[0], payload, delivery, drain=False).status_code == 200
    assert _post(api_client, keypair[0], payload, delivery, drain=False).status_code == 200
    assert len(attempts) == 2
    assert WebhookDelivery.objects.filter(provider_event_id=delivery).count() == 1
    assert PayableJournal.objects.filter(admission=admission).count() == 1
    host.refresh_from_db()
    viewer.refresh_from_db()
    assert host.tuzis == 0 and viewer.tuzis == 90
