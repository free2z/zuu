"""POST /api/zpage/ honours an optional ``Idempotency-Key``.

The failure this exists for: the editor abandons a create at its 30 s bound
, the server commits it anyway, and every POST mints a fresh page -- so
the only safe client behaviour was to stop and tell the creator to go look.
With a key the retry is safe: the same key and body return the ORIGINAL page,
a changed body is refused, and nothing ever makes a second row.

Every test counts rows in ``zPage``; a response that merely *looks* right while
a duplicate row sits in the table is exactly the bug.
"""
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
from django.core.management import call_command
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.g12f.views import zpage as zpage_views
from dj.apps.tuzis.models import IdempotencyKey

SCOPE = "zpage-create"


def _key():
    return str(uuid.uuid4())


def _body(**overrides):
    body = {
        "title": "An idempotent page",
        "content": "Created exactly once.",
        "description": "",
        "tags": [],
    }
    body.update(overrides)
    return body


def _client(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


def _create(client, body, key=None):
    headers = {} if key is None else {"HTTP_IDEMPOTENCY_KEY": key}
    return client.post("/api/zpage/", body, format="json", **headers)


@pytest.mark.django_db
def test_same_key_same_body_returns_the_original_page(creator_factory):
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()

    first = _create(client, _body(), key)
    second = _create(client, _body(), key)

    assert first.status_code == 201
    assert "Idempotent-Replayed" not in first
    assert second.status_code == 201
    assert second["Idempotent-Replayed"] == "true"
    assert second.data["free2zaddr"] == first.data["free2zaddr"]
    # The replay is the page's read representation, with a usable validator.
    assert second["ETag"] == first["ETag"]
    assert zPage.objects.filter(creator=creator).count() == 1
    assert IdempotencyKey.objects.filter(
        scope=SCOPE, user=creator, response_status=201,
    ).count() == 1


@pytest.mark.django_db
def test_replay_is_the_page_as_it_is_now(creator_factory):
    """A later edit is reflected: the replay names the page, not a snapshot."""
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()
    first = _create(client, _body(), key)
    zPage.objects.filter(free2zaddr=first.data["free2zaddr"]).update(title="Renamed since")

    replay = _create(client, _body(), key)

    assert replay.status_code == 201
    assert replay.data["free2zaddr"] == first.data["free2zaddr"]
    assert replay.data["title"] == "Renamed since"
    assert zPage.objects.filter(creator=creator).count() == 1


@pytest.mark.django_db
def test_replay_etag_is_the_creation_validator_so_a_stale_update_412s(
    creator_factory,
):
    """Another tab edited the page before the retry: the replaying client's
    update, conditioned on the replay's ETag, must be refused -- not
    authorized to overwrite that edit with the draft it still holds."""
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()
    first = _create(client, _body(), key)
    address = first.data["free2zaddr"]
    edited = client.patch(
        f"/api/zpage/{address}/", {"content": "Edited in another tab."},
        format="json", HTTP_IF_MATCH=first["ETag"],
    )
    assert edited.status_code == 200

    replay = _create(client, _body(), key)
    stale = client.put(
        f"/api/zpage/{address}/", _body(content="The stale draft."),
        format="json", HTTP_IF_MATCH=replay["ETag"],
    )

    assert replay.status_code == 201
    assert replay["ETag"] == first["ETag"]
    assert replay["ETag"] != edited["ETag"]
    assert stale.status_code == 412
    assert zPage.objects.get(free2zaddr=address).content == (
        "Edited in another tab."
    )


@pytest.mark.django_db
def test_other_spellings_of_one_uuid_are_the_same_key(creator_factory):
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()

    first = _create(client, _body(), key)
    second = _create(client, _body(), "{" + key.upper() + "}")

    assert second.status_code == 201
    assert second.data["free2zaddr"] == first.data["free2zaddr"]
    assert zPage.objects.filter(creator=creator).count() == 1


@pytest.mark.django_db
def test_same_key_different_body_is_refused_with_a_stable_code(
    creator_factory,
):
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()
    _create(client, _body(), key)

    refused = _create(client, _body(content="A different page."), key)

    assert refused.status_code == 409
    assert refused.data["code"] == "idempotency_mismatch"
    assert refused.data["key_resolved"] is True
    assert zPage.objects.filter(creator=creator).count() == 1


@pytest.mark.django_db
def test_another_users_key_is_isolated(creator_factory):
    alice = creator_factory(username="idem-alice", tuzis=Decimal("5"))
    bob = creator_factory(username="idem-bob", tuzis=Decimal("5"))
    key = _key()

    by_alice = _create(_client(alice), _body(), key)
    # Same key, same body, different account: Bob gets his own page, never a
    # replay of Alice's (which would hand him her draft).
    by_bob = _create(_client(bob), _body(), key)
    #...and a different body from Bob is not a mismatch against Alice's key.
    bob_other = _create(_client(bob), _body(content="Bob's."), _key())

    assert by_alice.status_code == 201
    assert by_bob.status_code == 201
    assert "Idempotent-Replayed" not in by_bob
    assert by_bob.data["free2zaddr"] != by_alice.data["free2zaddr"]
    assert bob_other.status_code == 201
    assert zPage.objects.filter(creator=alice).count() == 1
    assert zPage.objects.filter(creator=bob).count() == 2


@pytest.mark.django_db
def test_without_a_key_every_post_still_creates(creator_factory):
    """The header is optional; clients that never send it are unchanged."""
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)

    first = _create(client, _body())
    second = _create(client, _body())

    assert first.status_code == second.status_code == 201
    assert first.data["free2zaddr"] != second.data["free2zaddr"]
    assert zPage.objects.filter(creator=creator).count() == 2
    assert not IdempotencyKey.objects.filter(scope=SCOPE).exists()


@pytest.mark.django_db
def test_a_malformed_key_is_refused_and_creates_nothing(creator_factory):
    creator = creator_factory(tuzis=Decimal("5"))

    response = _create(_client(creator), _body(), "not-a-uuid")

    assert response.status_code == 400
    assert response.data["code"] == "idempotency_key_required"
    assert not zPage.objects.filter(creator=creator).exists()


@pytest.mark.django_db
def test_a_refused_create_does_not_spend_the_key(creator_factory):
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()

    rejected = _create(client, _body(source_language="und"), key)
    accepted = _create(client, _body(), key)

    assert rejected.status_code == 400
    assert accepted.status_code == 201
    assert "Idempotent-Replayed" not in accepted
    assert zPage.objects.filter(creator=creator).count() == 1


@pytest.mark.django_db
def test_a_vanity_collision_does_not_spend_the_key(creator_factory):
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    _create(client, _body(vanity="taken-vanity-2079"))
    key = _key()

    collided = _create(client, _body(vanity="taken-vanity-2079"), key)
    retried = _create(client, _body(vanity="free-vanity-2079"), key)

    assert collided.status_code == 400
    assert retried.status_code == 201
    assert zPage.objects.filter(creator=creator).count() == 2


@pytest.mark.django_db
def test_a_quota_refusal_after_the_claim_releases_the_key(creator_factory):
    """The refusal that happens AFTER the key is claimed (review probe).

    A serializer ValidationError rolls back by exception on its own; the
    page-quota refusal is a plain 402 *response*, so only the savepoint exit
    in ``_create_page_idempotently`` keeps its claim from committing. If it
    committed, the retry after a top-up would be a mismatch-free replay of a
    page that does not exist -- 409 `idempotency_page_gone`, never a page.
    """
    creator = creator_factory(tuzis=Decimal("0"))
    client = _client(creator)
    _create(client, _body(content="The one free page."))
    key = _key()

    refused = _create(client, _body(), key)
    assert refused.status_code == 402
    assert refused.data["code"] == "insufficient_funds"
    assert not IdempotencyKey.objects.filter(scope=SCOPE, key=key).exists()

    creator.tuzis = Decimal("5")
    creator.save(update_fields=["tuzis"])
    retried = _create(client, _body(), key)

    assert retried.status_code == 201
    assert "Idempotent-Replayed" not in retried
    assert zPage.objects.filter(creator=creator).count() == 2


@pytest.mark.django_db
def test_every_create_answer_carries_the_capability_signal(creator_factory):
    """`Idempotency-Key-Honored: true` on success, replay, refusal and a
    DRF-raised validation error alike; the editor only auto-retries a keyed
    create after it has seen this from the backend it is talking to."""
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()

    answers = [
        _create(client, _body()),
        _create(client, _body(), key),
        _create(client, _body(), key),
        _create(client, _body(content="other"), key),
        _create(client, _body(source_language="und"), _key()),
        _create(client, _body(), "not-a-uuid"),
    ]

    assert [a.status_code for a in answers] == [201, 201, 201, 409, 400, 400]
    for answer in answers:
        assert answer["Idempotency-Key-Honored"] == "true"
    # Not stamped on other zPage operations.
    listed = client.get("/api/zpage/")
    assert "Idempotency-Key-Honored" not in listed


@pytest.mark.django_db
def test_replay_is_not_refused_by_the_one_free_page_rule(creator_factory):
    """A 0-2Z creator may make one page. Its replay must not 402 as a second."""
    creator = creator_factory(tuzis=Decimal("0"))
    client = _client(creator)
    key = _key()

    first = _create(client, _body(), key)
    replay = _create(client, _body(), key)

    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.data["free2zaddr"] == first.data["free2zaddr"]
    assert zPage.objects.filter(creator=creator).count() == 1


@pytest.mark.django_db
def test_a_deleted_page_is_not_resurrected_by_its_key(creator_factory):
    creator = creator_factory(tuzis=Decimal("5"))
    client = _client(creator)
    key = _key()
    first = _create(client, _body(), key)
    zPage.objects.filter(free2zaddr=first.data["free2zaddr"]).delete()

    retry = _create(client, _body(), key)

    assert retry.status_code == 409
    assert retry.data["code"] == "idempotency_page_gone"
    assert not zPage.objects.filter(creator=creator).exists()


@pytest.mark.django_db
def test_receipts_expire_with_the_shared_horizon(creator_factory):
    creator = creator_factory(tuzis=Decimal("5"))
    key = _key()
    _create(_client(creator), _body(), key)
    IdempotencyKey.objects.filter(scope=SCOPE).update(
        created_at=IdempotencyKey.objects.get(scope=SCOPE).created_at
        - timedelta(days=366),
    )

    call_command("cleanup_idempotency")

    assert not IdempotencyKey.objects.filter(scope=SCOPE).exists()
    # The page itself is untouched; only the retry receipt expired.
    assert zPage.objects.filter(creator=creator).count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicates_create_exactly_one_page(
    creator_factory, monkeypatch,
):
    """Two POSTs with one key, in flight at once, make ONE page.

    The first request is held inside its transaction, after its page row is
    written and before it commits; the second is released into that window.
    Without the claim it would insert a second page there.
    """
    creator = creator_factory(tuzis=Decimal("5"))
    key = _key()
    entered = threading.Event()
    calls = []
    calls_lock = threading.Lock()
    real_create_page = zpage_views.zPageView._create_page

    def slow_create_page(self, request):
        response = real_create_page(self, request)
        with calls_lock:
            calls.append(response.status_code)
        entered.set()
        time.sleep(0.5)
        return response

    monkeypatch.setattr(
        zpage_views.zPageView, "_create_page", slow_create_page,
    )

    def send(delay):
        from django.db import close_old_connections

        close_old_connections()
        try:
            if delay:
                assert entered.wait(10), "the first create never started"
            response = _create(_client(creator), _body(), key)
            return response.status_code, response.data.get("free2zaddr"), (
                response.get("Idempotent-Replayed")
            )
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(send, [False, True]))

    assert entered.is_set()
    statuses = sorted(status for status, _, _ in results)
    ids = {page_id for _, page_id, _ in results}
    replayed = sorted(str(flag) for _, _, flag in results)
    assert statuses == [201, 201]
    assert len(ids) == 1
    # Exactly one of the two did the work; the other waited and replayed it.
    assert calls == [201]
    assert replayed == ["None", "true"]
    assert zPage.objects.filter(creator=creator).count() == 1
