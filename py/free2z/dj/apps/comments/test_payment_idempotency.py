"""Paid comment surfaces replay a completed request instead of debiting twice."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import threading
import time

import pytest

from dj.apps.comments.models import Comment
from dj.apps.comments import views as comment_views
from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.tuzis.models import IdempotencyKey


pytestmark = pytest.mark.django_db


def _key():
    return str(uuid.uuid4())


def test_root_comment_retry_charges_once(api_client, creator_factory):
    author = creator_factory(username="comment-idem-author", tuzis=Decimal("10"))
    api_client.force_authenticate(user=author)
    key = _key()
    body = {"content": "once", "tuzis": 3, "parent": None}

    first = api_client.post("/api/comments/", body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    second = api_client.post("/api/comments/", body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert first.status_code == second.status_code == 201
    assert first.data["replayed"] is False
    assert second.data["replayed"] is True
    assert {**second.data, "replayed": False} == first.data
    author.refresh_from_db()
    assert author.tuzis == Decimal("7")
    assert Comment.objects.filter(author=author, content="once").count() == 1


def test_reply_retry_charges_once(api_client, creator_factory):
    author = creator_factory(username="reply-idem-author", tuzis=Decimal("10"))
    parent = Comment.objects.create(author=author, content="parent", tuzis=1)
    api_client.force_authenticate(user=author)
    key = _key()
    body = {"content": "reply once", "tuzis": 2, "parent": str(parent.uuid)}

    first = api_client.post(
        f"/api/comments/{parent.uuid}/replies/",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    second = api_client.post(
        f"/api/comments/{parent.uuid}/replies/",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert first.status_code == second.status_code == 201
    assert first.data["replayed"] is False
    assert second.data["replayed"] is True
    assert {**second.data, "replayed": False} == first.data
    author.refresh_from_db()
    assert author.tuzis == Decimal("8")
    assert Comment.objects.filter(parent=parent, content="reply once").count() == 1


def test_vote_retry_charges_once(api_client, creator_factory):
    author = creator_factory(username="vote-idem-author", tuzis=Decimal("10"))
    voter = creator_factory(username="vote-idem-voter", tuzis=Decimal("10"))
    comment = Comment.objects.create(author=author, content="vote me", tuzis=0)
    api_client.force_authenticate(user=voter)
    key = _key()
    body = {"vote": "up"}

    first = api_client.post(
        f"/api/comments/{comment.uuid}/vote/",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    second = api_client.post(
        f"/api/comments/{comment.uuid}/vote/",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert first.status_code == second.status_code == 200
    assert first.data["replayed"] is False
    assert second.data["replayed"] is True
    assert {**second.data, "replayed": False} == first.data
    voter.refresh_from_db()
    comment.refresh_from_db()
    assert voter.tuzis == Decimal("9")
    assert comment.tuzis == 1
    assert Event.objects.filter(type="VOTE_COMMENT_SENT", contributor=voter).count() == 1
    assert IdempotencyKey.objects.filter(
        scope="comment_vote", user=voter, key=key, response_status=200
    ).exists()


def test_insufficient_comment_funds_release_key_for_retry(api_client, creator_factory):
    author = creator_factory(username="comment-idem-poor", tuzis=Decimal("1"))
    api_client.force_authenticate(user=author)
    key = _key()
    body = {"content": "not yet", "tuzis": 2, "parent": None}

    refused = api_client.post(
        "/api/comments/", body, format="json", HTTP_IDEMPOTENCY_KEY=key
    )
    assert refused.status_code == 402
    assert not IdempotencyKey.objects.filter(
        scope="comment", user=author, key=key
    ).exists()


def test_optional_and_malformed_keys_are_controlled(api_client, creator_factory):
    author = creator_factory(tuzis=Decimal("10"))
    api_client.force_authenticate(user=author)
    body = {"content": "legacy client", "tuzis": 1}

    missing = api_client.post("/api/comments/", body, format="json")
    malformed = api_client.post(
        "/api/comments/", body, format="json", HTTP_IDEMPOTENCY_KEY="nope"
    )

    assert missing.status_code == 201, missing.content
    assert malformed.status_code == 400
    assert malformed.data["code"] == "idempotency_key_required"
    author.refresh_from_db()
    assert author.tuzis == Decimal("9")


@pytest.mark.django_db(transaction=True)
def test_simultaneous_duplicate_votes_debit_once(
    creator_factory, monkeypatch,
):
    author = creator_factory(username="concurrent-vote-author", tuzis=Decimal("0"))
    voter = creator_factory(username="concurrent-vote-voter", tuzis=Decimal("10"))
    comment = Comment.objects.create(author=author, content="vote me", tuzis=0)
    key = _key()
    entered_debit = threading.Event()
    real_debit = comment_views.ledger.debit
    calls = []
    calls_lock = threading.Lock()

    def slow_debit(*args, **kwargs):
        with calls_lock:
            calls.append(1)
        entered_debit.set()
        time.sleep(0.15)
        return real_debit(*args, **kwargs)

    monkeypatch.setattr("dj.apps.comments.views.ledger.debit", slow_debit)

    def send():
        from django.db import close_old_connections
        from rest_framework.test import APIClient

        close_old_connections()
        client = APIClient()
        client.force_authenticate(user=Creator.objects.get(pk=voter.pk))
        response = client.post(
            f"/api/comments/{comment.uuid}/vote/", {"vote": "up"},
            format="json", HTTP_IDEMPOTENCY_KEY=key,
        )
        close_old_connections()
        return response.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda _: send(), range(2)))

    assert entered_debit.is_set()
    assert statuses in ([200, 200], [200, 409], [409, 200])
    assert len(calls) == 1
    voter.refresh_from_db()
    comment.refresh_from_db()
    assert voter.tuzis == Decimal("9")
    assert comment.tuzis == 1
