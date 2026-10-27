import logging
from concurrent.futures import Future

import pytest
from django.conf import settings
from django.db import transaction

from dj.apps.events import signals
from dj.apps.events.models import Event


class RecordingPubSubClient:
    def __init__(self, published):
        self.published = published

    def publish(self, topic, data, *, ensure_topic=True):
        self.published.append((topic, data, ensure_topic))


class FailingPubSubClient:
    def publish(self, topic, data, *, ensure_topic=True):
        raise RuntimeError('publisher unavailable')


class AsyncFailingPubSubClient:
    def publish(self, topic, data, *, ensure_topic=True):
        future = Future()
        future.set_exception(RuntimeError('publish was rejected'))
        return future


@pytest.mark.django_db(transaction=True)
def test_new_event_is_published_only_after_commit(
        creator_factory, monkeypatch):
    recipient = creator_factory(username='event-commit-recipient')
    published = []
    monkeypatch.setattr(
        signals, 'PubSubClient',
        lambda: RecordingPubSubClient(published))

    with transaction.atomic():
        event = Event.objects.create(
            type='BOUGHT_TUZI', amount=10, receiving_user=recipient)
        assert published == []

    assert len(published) == 1
    topic, data, ensure_topic = published[0]
    assert topic == settings.PUBSUB['NEW_EVENT']['topic']
    assert data['id'] == str(event.id)
    assert ensure_topic is False
    assert Event.objects.filter(id=data['id']).exists()


@pytest.mark.django_db(transaction=True)
def test_new_event_is_published_immediately_in_autocommit(
        creator_factory, monkeypatch):
    recipient = creator_factory(username='event-autocommit-recipient')
    published = []
    monkeypatch.setattr(
        signals, 'PubSubClient',
        lambda: RecordingPubSubClient(published))

    event = Event.objects.create(
        type='BOUGHT_TUZI', amount=10, receiving_user=recipient)

    assert len(published) == 1
    _topic, data, ensure_topic = published[0]
    assert data['id'] == str(event.id)
    assert ensure_topic is False


@pytest.mark.django_db(transaction=True)
def test_rolled_back_event_is_never_published(
        creator_factory, monkeypatch):
    recipient = creator_factory(username='event-rollback-recipient')
    published = []
    monkeypatch.setattr(
        signals, 'PubSubClient',
        lambda: RecordingPubSubClient(published))

    with pytest.raises(RuntimeError, match='roll back event'):
        with transaction.atomic():
            event = Event.objects.create(
                type='BOUGHT_TUZI', amount=10,
                receiving_user=recipient,
            )
            raise RuntimeError('roll back event')

    assert published == []
    assert not Event.objects.filter(id=event.id).exists()


@pytest.mark.django_db(transaction=True)
def test_publish_failure_does_not_fail_a_committed_write(
        creator_factory, monkeypatch):
    recipient = creator_factory(username='event-publish-failure-recipient')
    monkeypatch.setattr(signals, 'PubSubClient', FailingPubSubClient)

    with transaction.atomic():
        event = Event.objects.create(
            type='BOUGHT_TUZI', amount=10, receiving_user=recipient)

    assert Event.objects.filter(id=event.id).exists()


@pytest.mark.django_db(transaction=True)
def test_async_publish_failure_is_logged_without_failing_the_write(
        creator_factory, monkeypatch, caplog):
    recipient = creator_factory(username='event-async-failure-recipient')
    monkeypatch.setattr(signals, 'PubSubClient', AsyncFailingPubSubClient)

    with caplog.at_level(logging.ERROR, logger=signals.__name__):
        event = Event.objects.create(
            type='BOUGHT_TUZI', amount=10, receiving_user=recipient)

    assert Event.objects.filter(id=event.id).exists()
    assert f'Failed to publish committed Event {event.id}' in caplog.text
