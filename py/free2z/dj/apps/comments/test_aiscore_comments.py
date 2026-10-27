import json
import threading
import types
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
import openai
from django.db import OperationalError, close_old_connections
from django.utils import timezone

from dj.apps.comments.management.commands import aiscore_comments
from dj.apps.comments.models import Comment
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.tuzis.models import IdempotencyKey
from f2z.openai import util as openai_util


class _FakeOpenAIClient:
    """Returns a canned function-call payload and counts provider calls."""

    def __init__(self, arguments):
        self.arguments = arguments
        self.calls = 0

        def _create(*_args, **_kwargs):
            self.calls += 1
            message = types.SimpleNamespace(
                function_call=types.SimpleNamespace(arguments=self.arguments))
            return types.SimpleNamespace(
                choices=[types.SimpleNamespace(message=message)])

        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=_create))


class Message:
    def __init__(self, comment):
        self.data = json.dumps({
            'uuid': str(comment.uuid),
            'content': comment.content,
            # Deliberately not authoritative: callback must resolve the owner
            # from the comment row, whose UUID is the durable event identity.
            'author': comment.author.username,
        }).encode('utf-8')
        self.acks = 0
        self.nacks = 0

    def ack(self):
        self.acks += 1

    def nack(self):
        self.nacks += 1


class MissingCommentMessage(Message):
    def __init__(self):
        self.data = json.dumps({
            'uuid': '00000000-0000-0000-0000-000000000000',
            'content': 'missing',
            'author': 'missing',
        }).encode('utf-8')
        self.acks = 0
        self.nacks = 0


def balance(user):
    return Creator.objects.values_list('tuzis', flat=True).get(pk=user.pk)


def make_comment(creator_factory, **creator_fields):
    author = creator_factory(**creator_fields)
    comment = Comment.objects.create(author=author, content='hello', tuzis=1)
    return author, comment


@pytest.mark.django_db(transaction=True)
def test_replayed_score_credits_once(creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='author')
    monkeypatch.setattr(aiscore_comments, 'score_content', lambda _content: 5)

    first = Message(comment)
    replay = Message(comment)
    aiscore_comments.callback(first)
    aiscore_comments.callback(replay)

    comment.refresh_from_db()
    assert balance(author) == Decimal('15')
    assert comment.tuzis == 6
    assert Event.objects.filter(
        type='AISCORE_COMMENT', object_id=str(comment.uuid)).count() == 1
    claim = IdempotencyKey.objects.get(
        scope='aiscore_comment', user=author, key=str(comment.uuid))
    assert claim.response_status == 200
    assert (first.acks, first.nacks) == (1, 0)
    assert (replay.acks, replay.nacks) == (1, 0)


@pytest.mark.django_db(transaction=True)
def test_concurrent_first_deliveries_commit_effects_once(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='concurrent')
    scoring_barrier = threading.Barrier(2)
    score_calls = 0
    score_calls_lock = threading.Lock()

    def score_together(_content):
        nonlocal score_calls
        with score_calls_lock:
            score_calls += 1
        # Reaching this barrier proves both callbacks observed no preflight
        # claim and entered scoring before either may call claim().
        scoring_barrier.wait(timeout=5)
        return 5

    monkeypatch.setattr(aiscore_comments, 'score_content', score_together)
    messages = [Message(comment), Message(comment)]

    def deliver(message):
        try:
            aiscore_comments.callback(message)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(deliver, message) for message in messages]
        for future in futures:
            future.result(timeout=10)

    comment.refresh_from_db()
    assert score_calls == 2
    assert balance(author) == Decimal('15')
    assert comment.tuzis == 6
    assert Event.objects.filter(
        type='AISCORE_COMMENT', object_id=str(comment.uuid)).count() == 1
    assert IdempotencyKey.objects.filter(
        scope='aiscore_comment', user=author, key=str(comment.uuid),
        response_status=200).count() == 1
    assert sum(message.acks for message in messages) >= 1
    assert all(
        message.acks + message.nacks == 1 for message in messages)


@pytest.mark.django_db(transaction=True)
def test_zero_score_is_finished_and_cannot_change_on_replay(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='zero')
    monkeypatch.setattr(
        aiscore_comments, 'score_content', lambda _content: 0)

    aiscore_comments.callback(Message(comment))
    aiscore_comments.callback(Message(comment))

    comment.refresh_from_db()
    assert balance(author) == Decimal('10')
    assert comment.tuzis == 1
    assert not Event.objects.filter(
        type='AISCORE_COMMENT', object_id=str(comment.uuid)).exists()
    assert IdempotencyKey.objects.get(
        scope='aiscore_comment', user=author,
        key=str(comment.uuid)).response_status == 200


@pytest.mark.django_db(transaction=True)
def test_finished_duplicate_is_acked_without_repeating_effects(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='finished')
    IdempotencyKey.objects.create(
        scope='aiscore_comment', user=author, key=str(comment.uuid),
        response_status=200)
    monkeypatch.setattr(
        aiscore_comments, 'score_content',
        lambda _content: pytest.fail('finished duplicate was rescored'))
    message = Message(comment)

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (1, 0)
    assert balance(author) == Decimal('10')
    assert not Event.objects.filter(type='AISCORE_COMMENT').exists()


@pytest.mark.django_db(transaction=True)
def test_in_flight_duplicate_is_nacked_for_redelivery(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='inflight')
    IdempotencyKey.objects.create(
        scope='aiscore_comment', user=author, key=str(comment.uuid))
    monkeypatch.setattr(
        aiscore_comments, 'score_content',
        lambda _content: pytest.fail('in-flight duplicate was rescored'))
    message = Message(comment)

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)
    assert balance(author) == Decimal('10')
    assert not Event.objects.filter(type='AISCORE_COMMENT').exists()


@pytest.mark.django_db(transaction=True)
def test_in_flight_duplicate_nack_failure_is_not_converted_to_ack(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='nack-fails')
    IdempotencyKey.objects.create(
        scope='aiscore_comment', user=author, key=str(comment.uuid))
    monkeypatch.setattr(
        aiscore_comments, 'score_content',
        lambda _content: pytest.fail('in-flight duplicate was rescored'))
    message = Message(comment)

    def fail_nack():
        message.nacks += 1
        raise RuntimeError('nack unavailable')

    message.nack = fail_nack

    with pytest.raises(RuntimeError, match='nack unavailable'):
        aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)


@pytest.mark.django_db(transaction=True)
def test_openai_failure_is_nacked_before_claim(creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='openai-fails')
    monkeypatch.setattr(
        aiscore_comments, 'score_content',
        lambda _content: (_ for _ in ()).throw(
            openai.OpenAIError('provider unavailable')))
    message = Message(comment)

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)
    assert balance(author) == Decimal('10')
    assert not IdempotencyKey.objects.filter(
        scope='aiscore_comment', user=author, key=str(comment.uuid)).exists()


@pytest.mark.django_db(transaction=True)
def test_untyped_scorer_failure_is_nacked_before_claim(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='scorer-bug')
    monkeypatch.setattr(
        aiscore_comments, 'score_content',
        lambda _content: (_ for _ in ()).throw(
            RuntimeError('client initialization failed')))
    message = Message(comment)

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)
    assert balance(author) == Decimal('10')
    assert not IdempotencyKey.objects.filter(
        scope='aiscore_comment', user=author, key=str(comment.uuid)).exists()


@pytest.mark.django_db(transaction=True)
def test_comment_lookup_database_failure_is_nacked(
        creator_factory, monkeypatch):
    _author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='lookup-fails')
    monkeypatch.setattr(
        aiscore_comments.Comment.objects, 'select_related',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OperationalError('database unavailable')))
    message = Message(comment)

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)


@pytest.mark.django_db(transaction=True)
def test_claim_database_failure_is_nacked(creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='claim-fails')
    monkeypatch.setattr(aiscore_comments, 'score_content', lambda _content: 5)
    monkeypatch.setattr(
        aiscore_comments.idempotency, 'claim',
        lambda **_kwargs: (_ for _ in ()).throw(
            OperationalError('database unavailable')))
    message = Message(comment)

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)
    assert balance(author) == Decimal('10')
    assert not Event.objects.filter(type='AISCORE_COMMENT').exists()


@pytest.mark.django_db(transaction=True)
def test_permanently_missing_comment_is_acked_without_provider_call(
        monkeypatch):
    monkeypatch.setattr(
        aiscore_comments, 'score_content',
        lambda _content: pytest.fail('missing comment reached provider'))
    message = MissingCommentMessage()

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (1, 0)


@pytest.mark.django_db(transaction=True)
def test_stale_in_flight_claim_is_taken_over_after_scoring(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='stale')
    original = IdempotencyKey.objects.create(
        scope='aiscore_comment', user=author, key=str(comment.uuid))
    IdempotencyKey.objects.filter(pk=original.pk).update(
        created_at=timezone.now() - timedelta(hours=1))
    monkeypatch.setattr(aiscore_comments, 'score_content', lambda _content: 5)
    message = Message(comment)

    aiscore_comments.callback(message)

    claim = IdempotencyKey.objects.get(pk=original.pk)
    assert claim.owner != original.owner
    assert claim.response_status == 200
    assert balance(author) == Decimal('15')
    assert (message.acks, message.nacks) == (1, 0)


@pytest.mark.django_db(transaction=True)
def test_moderation_and_marker_commit_with_negative_score(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory,
        tuzis=Decimal('10'), strikes=2, username='moderated')
    monkeypatch.setattr(aiscore_comments, 'score_content', lambda _content: -3)

    aiscore_comments.callback(Message(comment))

    author.refresh_from_db()
    comment.refresh_from_db()
    assert author.tuzis == Decimal('7')
    assert author.strikes == 3
    assert author.is_active is False
    assert comment.tuzis == -2
    assert comment.is_banned is True
    assert Event.objects.get(
        type='AISCORE_COMMENT', object_id=str(comment.uuid)).amount == -3
    assert IdempotencyKey.objects.get(
        scope='aiscore_comment', user=author,
        key=str(comment.uuid)).response_status == 200


@pytest.mark.django_db(transaction=True)
def test_strike_update_advances_creator_admin_concurrency_version(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory,
        tuzis=Decimal('100'), strikes=0, username='versioned-strike')
    loaded_version = author.updated_at
    monkeypatch.setattr(aiscore_comments, 'score_content', lambda _content: -1)

    aiscore_comments.callback(Message(comment))

    author.refresh_from_db()
    assert author.strikes == 1
    assert author.is_active is True
    assert author.updated_at != loaded_version


@pytest.mark.django_db(transaction=True)
def test_failure_rolls_back_effects_and_releases_claim(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), strikes=2, username='rollback')
    monkeypatch.setattr(aiscore_comments, 'score_content', lambda _content: -3)

    def fail_finish(self, status, body=None):
        raise RuntimeError('process failed before recording completion')

    real_finish = IdempotencyKey.finish
    monkeypatch.setattr(IdempotencyKey, 'finish', fail_finish)
    message = Message(comment)

    aiscore_comments.callback(message)

    author.refresh_from_db()
    comment.refresh_from_db()
    assert author.tuzis == Decimal('10')
    assert author.strikes == 2
    assert author.is_active is True
    assert comment.tuzis == 1
    assert comment.is_banned is False
    assert not Event.objects.filter(type='AISCORE_COMMENT').exists()
    assert not IdempotencyKey.objects.filter(
        scope='aiscore_comment', user=author, key=str(comment.uuid)).exists()
    assert (message.acks, message.nacks) == (0, 1)

    # The redelivery can claim the released key and settle exactly once.
    monkeypatch.setattr(IdempotencyKey, 'finish', real_finish)
    retry = Message(comment)
    aiscore_comments.callback(retry)
    author.refresh_from_db()
    comment.refresh_from_db()
    assert author.tuzis == Decimal('7')
    assert author.strikes == 3
    assert comment.tuzis == -2
    assert Event.objects.filter(
        type='AISCORE_COMMENT', object_id=str(comment.uuid)).count() == 1
    assert (retry.acks, retry.nacks) == (1, 0)


@pytest.mark.django_db(transaction=True)
def test_release_failure_cannot_turn_retryable_rollback_into_ack(
        creator_factory, monkeypatch):
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='cleanup-fails')
    monkeypatch.setattr(aiscore_comments, 'score_content', lambda _content: 5)
    monkeypatch.setattr(
        IdempotencyKey, 'finish',
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('finish')))
    monkeypatch.setattr(
        aiscore_comments.idempotency, 'release',
        lambda _claim: (_ for _ in ()).throw(RuntimeError('release')))
    message = Message(comment)

    aiscore_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)
    assert balance(author) == Decimal('10')
    assert IdempotencyKey.objects.filter(
        scope='aiscore_comment', user=author, key=str(comment.uuid),
        response_status__isnull=True).exists()


@pytest.mark.django_db(transaction=True)
def test_null_score_is_dropped_without_retry_loop(creator_factory, monkeypatch):
    """A null/off-schema score must ACK once, never NACK into a paid loop.

    The subscription has no dead-letter policy, so a non-int score that
    reached the transaction's numeric comparison would raise, NACK, and
    re-buy an OpenAI call on every redelivery forever. The scorer boundary
    coerces it to a terminal, no-money 0 instead.
    """
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='null-score')
    client = _FakeOpenAIClient(json.dumps({'score': None}))
    monkeypatch.setattr(openai_util, 'oai_client', client)
    message = Message(comment)

    aiscore_comments.callback(message)

    comment.refresh_from_db()
    assert (message.acks, message.nacks) == (1, 0)
    assert client.calls == 1
    assert balance(author) == Decimal('10')
    assert comment.tuzis == 1
    assert not Event.objects.filter(
        type='AISCORE_COMMENT', object_id=str(comment.uuid)).exists()
    assert IdempotencyKey.objects.get(
        scope='aiscore_comment', user=author,
        key=str(comment.uuid)).response_status == 200


@pytest.mark.django_db(transaction=True)
def test_stringified_score_is_coerced_and_acked_once(
        creator_factory, monkeypatch):
    """A numeric string score ("5") is coerced to an int and applied once,
    never crashing the transaction into a NACK/redelivery loop."""
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='string-score')
    client = _FakeOpenAIClient(json.dumps({'score': '5'}))
    monkeypatch.setattr(openai_util, 'oai_client', client)
    message = Message(comment)

    aiscore_comments.callback(message)

    comment.refresh_from_db()
    assert (message.acks, message.nacks) == (1, 0)
    assert client.calls == 1
    assert balance(author) == Decimal('15')
    assert comment.tuzis == 6
    assert Event.objects.filter(
        type='AISCORE_COMMENT', object_id=str(comment.uuid)).count() == 1
    assert IdempotencyKey.objects.get(
        scope='aiscore_comment', user=author,
        key=str(comment.uuid)).response_status == 200


@pytest.mark.django_db(transaction=True)
def test_out_of_range_score_is_clamped_before_crediting(
        creator_factory, monkeypatch):
    """An out-of-range/injected magnitude must not credit an unbacked balance.

    The score moves money, so a prompt-injected comment that coaxes the model
    into returning a huge number ("100000000000000") is clamped to the
    documented max of 5 at the provider boundary, never credited in full.
    """
    author, comment = make_comment(
        creator_factory, tuzis=Decimal('10'), username='huge-score')
    client = _FakeOpenAIClient(json.dumps({'score': '100000000000000'}))
    monkeypatch.setattr(openai_util, 'oai_client', client)
    message = Message(comment)

    aiscore_comments.callback(message)

    comment.refresh_from_db()
    assert (message.acks, message.nacks) == (1, 0)
    assert client.calls == 1
    # Clamped to MAX_SCORE (5), not the raw magnitude.
    assert balance(author) == Decimal('15')
    assert comment.tuzis == 6
