"""NEW_COMMENT publication is transactional and durable.

 moved the publish behind ``transaction.on_commit`` so a subscriber
could never see an event for an uncommitted row.  replaced that callback
with an outbox row, because on_commit is ordered but NOT durable: a process
killed between COMMIT and the callback published nothing and nothing retried
it, so the comment was silently never scored and never tweeted.

Both properties are asserted below, against real Postgres, with Pub/Sub
mocked at the client boundary the relay owns.
"""
import pytest
from django.db import transaction

from dj.apps.comments.models import Comment
from dj.apps.jobs import outbox
from dj.apps.jobs.models import OutboxMessage


class RecordingPubSubClient:
    def __init__(self, published):
        self.published = published

    def publish(self, topic, data, *, ensure_topic=True, attributes=None,
                timeout=None, admin_timeout=None):
        self.published.append((topic, data))
        return None


@pytest.fixture
def published(monkeypatch):
    calls = []
    monkeypatch.setattr(
        outbox, 'PubSubClient', lambda: RecordingPubSubClient(calls))
    return calls


@pytest.mark.django_db(transaction=True)
def test_new_comment_is_published_only_after_commit(
        creator_factory, published):
    author = creator_factory(username='commit-author')

    with transaction.atomic():
        comment = Comment.objects.create(
            author=author, content='committed comment', tuzis=1)
        assert published == []
        # The PROMISE, however, is already in the same transaction. That is
        # what a crash after this point can no longer lose.
        assert OutboxMessage.objects.filter(
            ordering_key=f'comment:{comment.uuid}').count() == 1

    assert published == [], 'the relay, not the signal, talks to Pub/Sub'

    outbox.drain()

    assert len(published) == 1
    _topic, data = published[0]
    assert data['uuid'] == str(comment.uuid)
    assert Comment.objects.filter(uuid=data['uuid']).exists()


@pytest.mark.django_db(transaction=True)
def test_rolled_back_comment_is_never_published(creator_factory, published):
    with pytest.raises(RuntimeError, match='roll back comment'):
        with transaction.atomic():
            comment = Comment.objects.create(
                author=creator_factory(username='rollback-author'),
                content='rolled back comment', tuzis=1)
            raise RuntimeError('roll back comment')

    assert published == []
    assert not Comment.objects.filter(uuid=comment.uuid).exists()
    # And nothing is left promising to publish it later, either.
    assert OutboxMessage.objects.count() == 0
    outbox.drain()
    assert published == []


@pytest.mark.django_db(transaction=True)
def test_a_lost_on_commit_callback_still_publishes(
        creator_factory, published, monkeypatch):
    """The durability half. This is the failure on_commit could not survive.

    Simulate the process dying between COMMIT and the callback by making the
    defer a no-op. The periodic sweep (`jobs.sweep_outbox`) is what finds the
    row; before  there was no row and nothing to find.
    """
    monkeypatch.setattr(outbox, 'defer_relay', lambda: None)

    with transaction.atomic():
        comment = Comment.objects.create(
            author=creator_factory(username='orphan-author'),
            content='comment whose callback never ran', tuzis=1)

    assert published == []
    outbox.drain()
    assert [d['uuid'] for _t, d in published] == [str(comment.uuid)]


@pytest.mark.django_db(transaction=True)
def test_the_comment_topic_still_auto_creates(creator_factory, monkeypatch):
    """`ensure_topic` must stay True for comments.

    Namespaced dev/test comment topics are created lazily by the client.
    Flipping this to False (as the recording producer legitimately does)
    would make every non-prod namespace fail to publish.
    """
    seen = []

    class _Client:
        def publish(self, topic, data, *, ensure_topic=True,
                    attributes=None, timeout=None, admin_timeout=None):
            seen.append(ensure_topic)
            return None

    monkeypatch.setattr(outbox, 'PubSubClient', _Client)

    with transaction.atomic():
        Comment.objects.create(
            author=creator_factory(username='ensure-topic-author'),
            content='comment', tuzis=1)
    outbox.drain()

    assert seen == [True]
