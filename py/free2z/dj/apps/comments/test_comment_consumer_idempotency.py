"""Each NEW_COMMENT side-effect consumer claims its comment before spending.

These tests stub only the paid/external boundaries.  The claim table and the
comment rows are real PostgreSQL state, so a duplicate delivery exercises the
same uniqueness race the subscribers use in production.
"""

import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import OperationalError, close_old_connections, transaction

from dj.apps.comments.management.commands import tag_comments
from dj.apps.comments.models import (
    Comment,
    CommentConsumerClaim,
    claim_comment_consumer,
)


class Message:
    def __init__(self, comment, **extra):
        self.data = json.dumps({
            "uuid": str(comment.uuid),
            "author": comment.author.username,
            "content": comment.content,
            **extra,
        }).encode("utf-8")
        self.acks = 0
        self.nacks = 0

    def ack(self):
        self.acks += 1

    def nack(self):
        self.nacks += 1


def _live_claims(comment):
    """Claims by live consumers. Every new comment also carries the fence
    claim for the RETIRED `tweet_comments` listener, written in the
    creating transaction; it is not what these tests are about."""
    from dj.apps.twitter.announcements import LEGACY_TWEETER_CONSUMER

    return CommentConsumerClaim.objects.filter(comment=comment).exclude(
        consumer=LEGACY_TWEETER_CONSUMER,
    )


def _comment(creator_factory, **fields):
    author = creator_factory(username=f"commenter-{uuid.uuid4()}")
    return Comment.objects.create(
        author=author,
        content="A comment with enough substance to tag.",
        **fields,
    )


@pytest.mark.django_db(transaction=True)
def test_duplicate_tag_delivery_buys_one_completion_and_writes_once(
    creator_factory, mocker
):
    comment = _comment(creator_factory)
    tagger = mocker.patch(
        "dj.apps.comments.management.commands.tag_comments.tag_content",
        return_value=["one", "two"],
    )

    first = Message(comment)
    replay = Message(comment)
    tag_comments.callback(first)
    tag_comments.callback(replay)

    comment.refresh_from_db()
    assert tagger.call_count == 1
    assert set(comment.tags.names()) == {"one", "two"}
    assert first.acks == replay.acks == 1
    assert CommentConsumerClaim.objects.filter(
        comment=comment, consumer=tag_comments.CONSUMER,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_tag_deliveries_have_one_database_winner(
    creator_factory, mocker
):
    """Two callback connections can buy only one tagging completion."""
    comment = _comment(creator_factory)
    start = threading.Barrier(2)
    calls = []
    calls_lock = threading.Lock()

    def paid_tagger(_content):
        with calls_lock:
            calls.append("tag")
        return ["one"]

    mocker.patch(
        "dj.apps.comments.management.commands.tag_comments.tag_content",
        side_effect=paid_tagger,
    )
    messages = [Message(comment), Message(comment)]

    def deliver(message):
        close_old_connections()
        try:
            start.wait(timeout=10)
            tag_comments.callback(message)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(deliver, messages))

    assert calls == ["tag"]
    assert [message.acks for message in messages] == [1, 1]
    assert CommentConsumerClaim.objects.filter(
        comment=comment, consumer=tag_comments.CONSUMER,
    ).count() == 1


@pytest.mark.django_db(transaction=True)
def test_preclaim_database_failure_is_nacked_without_provider_call(
    creator_factory, mocker, monkeypatch
):
    comment = _comment(creator_factory)
    tagger = mocker.patch(
        "dj.apps.comments.management.commands.tag_comments.tag_content",
    )

    def fail_claim(*_args, **_kwargs):
        raise OperationalError("database unavailable")

    monkeypatch.setattr(tag_comments, "claim_comment_consumer", fail_claim)
    message = Message(comment)
    tag_comments.callback(message)

    assert (message.acks, message.nacks) == (0, 1)
    assert tagger.call_count == 0
    assert not _live_claims(comment).exists()


@pytest.mark.django_db(transaction=True)
def test_ambiguous_tag_failure_keeps_claim_and_replay_does_not_retry(
    creator_factory, mocker, caplog
):
    comment = _comment(creator_factory)
    tagger = mocker.patch(
        "dj.apps.comments.management.commands.tag_comments.tag_content",
        side_effect=RuntimeError("provider timed out after accepting request"),
    )

    first = Message(comment)
    tag_comments.callback(first)
    replay = Message(comment)
    tag_comments.callback(replay)

    assert tagger.call_count == 1
    assert first.acks == replay.acks == 1
    assert CommentConsumerClaim.objects.filter(
        comment=comment, consumer=tag_comments.CONSUMER,
    ).exists()
    assert str(comment.uuid) in caplog.text
    assert tag_comments.CONSUMER in caplog.text


@pytest.mark.django_db(transaction=True)
def test_each_consumer_has_an_independent_claim(creator_factory):
    comment = _comment(creator_factory)

    assert claim_comment_consumer(comment, tag_comments.CONSUMER) is True
    assert claim_comment_consumer(comment, tag_comments.CONSUMER) is False
    # Any second consumer name; `aiscore`-style subscribers claim the same way.
    assert claim_comment_consumer(comment, "another_consumer") is True

    assert _live_claims(comment).count() == 2


@pytest.mark.django_db(transaction=True)
def test_claim_rejects_an_outer_transaction(creator_factory):
    comment = _comment(creator_factory)

    with transaction.atomic():
        with pytest.raises(RuntimeError, match="commit before external work"):
            claim_comment_consumer(comment, tag_comments.CONSUMER)

    assert not _live_claims(comment).exists()


@pytest.mark.django_db(transaction=True)
def test_tag_duplicate_negative_control_without_claim_guard(
    creator_factory, mocker, monkeypatch
):
    """Removing the guard restores the real two-provider-call failure."""
    comment = _comment(creator_factory)
    tagger = mocker.patch(
        "dj.apps.comments.management.commands.tag_comments.tag_content",
        return_value=["one"],
    )
    monkeypatch.setattr(
        tag_comments,
        "claim_comment_consumer",
        lambda *_args, **_kwargs: True,
    )

    tag_comments.callback(Message(comment))
    tag_comments.callback(Message(comment))

    assert tagger.call_count == 2
