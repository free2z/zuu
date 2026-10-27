"""Concurrency and idempotency tests for the 2Z money paths.

These are deliberately *racing* tests. Every one of them fails on the code as
it stood before this change — that is the point. A test that passes on both is
not evidence of anything.

Mechanics that matter:

* ``@pytest.mark.django_db(transaction=True)`` is mandatory. The default
  ``django_db`` wraps the test in a transaction that never commits, so a second
  thread on a second connection cannot see the fixture data and the race being
  tested cannot physically occur.
* Each worker thread must close its own connection when it finishes, or
  Postgres accumulates idle connections until the test DB refuses new ones.
* A ``threading.Barrier`` lines the threads up so they hit the critical section
  together. Without it the OS almost always runs them back to back and the
  race never fires.
* The database is REAL Postgres (project rule). Nothing here is mocked — the
  guarantees under test are Postgres guarantees, so a fake DB would test
  nothing.
"""
from datetime import timedelta
from decimal import Decimal
import hashlib
import json
import sys
from unittest.mock import patch
import threading
import time
import traceback
from types import SimpleNamespace
import uuid

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator, Subscription
from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import IdempotencyKey
# The Stripe deliveries in this file are signed for real rather than stubbed
#. They used to replace `stripe.Webhook.construct_event` with a lambda
# returning a plain dict, which had two costs. The obvious one: nothing in the
# repo exercised signature verification at all. The subtle one: in
# stripe-python 15 a `StripeObject` is NOT a dict, so a handler that grew
# `session.get(...)` or `**session` would have passed here and 500'd on every
# real delivery. Signing costs one line and hands the view a genuine
# `stripe.Event`, so these stay tests about atomicity while the object under
# test has the real shape.
from dj.apps.ztripe.test_webhook_signature import (
    SIGNING_SECRET, checkout_completed, sign,
)
from dj.apps.ztripe.models import StripeCheckoutRollout


def contract_key(label):
    """Encode readable test labels as deterministic UUIDv4 keys."""
    return str(uuid.UUID(bytes=hashlib.md5(label.encode()).digest(), version=4))


def run_concurrently(fn, n=2):
    """Run ``fn(i)`` in ``n`` threads released simultaneously.

    Returns the list of results in thread order; a result is the return value
    or the raised exception.
    """
    barrier = threading.Barrier(n)
    results = [None] * n

    def worker(i):
        try:
            barrier.wait(timeout=10)
            results[i] = fn(i)
        except Exception as exc:  # recorded, asserted on by the caller
            results[i] = exc
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    for t in threads:
        assert not t.is_alive(), "worker thread deadlocked"
    return results


def balance(creator):
    return Creator.objects.values_list("tuzis", flat=True).get(pk=creator.pk)


# ---------------------------------------------------------------------------
# The ledger primitive
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_concurrent_debits_cannot_overspend(creator_factory):
    """Two simultaneous full-balance debits: exactly one may win.

    Old behaviour: both threads read tuzis=100, both passed the `< amount`
    check, both wrote 0 — 200 2Z of value spent out of a 100 2Z balance.
    """
    user = creator_factory(tuzis=Decimal("100"))

    def spend(_i):
        return ledger.debit(user, Decimal("100"))

    results = run_concurrently(spend, n=2)

    wins = [r for r in results if not isinstance(r, Exception)]
    losses = [r for r in results if isinstance(r, ledger.InsufficientFunds)]
    assert len(wins) == 1, f"expected exactly one successful debit: {results}"
    assert len(losses) == 1, f"expected exactly one refusal: {results}"
    assert balance(user) == Decimal("0")


@pytest.mark.django_db(transaction=True)
def test_many_concurrent_debits_settle_exactly(creator_factory):
    """10 threads, 10 2Z each, 50 2Z of balance: exactly 5 succeed."""
    user = creator_factory(tuzis=Decimal("50"))

    def spend(_i):
        return ledger.debit(user, Decimal("10"))

    results = run_concurrently(spend, n=10)
    ok = sum(1 for r in results if not isinstance(r, Exception))
    refused = sum(1 for r in results if isinstance(r, ledger.InsufficientFunds))
    unexpected = [
        r for r in results
        if isinstance(r, Exception) and not isinstance(r, ledger.InsufficientFunds)
    ]
    assert not unexpected, unexpected
    assert (ok, refused) == (5, 5), results
    assert balance(user) == Decimal("0")


@pytest.mark.django_db(transaction=True)
def test_concurrent_credits_are_not_lost(creator_factory):
    """Read-modify-write lost updates on the credit side, too.

    Old behaviour: two Stripe webhooks crediting the same user both read the
    same starting balance and one credit silently disappeared.
    """
    user = creator_factory(tuzis=Decimal("0"))

    def top_up(i):
        # Five distinct grants (five keys): the lost-update race is on the
        # balance row, not on one idempotency key.
        return ledger.credit(
            user, Decimal("100"), source="sys:promo", ref_kind="tuzi_grant",
            ref_id=f"topup-{i}", idem=f"test-topup:{uuid.uuid4()}",
        )

    results = run_concurrently(top_up, n=5)
    assert not [r for r in results if isinstance(r, Exception)], results
    assert balance(user) == Decimal("500")


@pytest.mark.django_db
def test_debit_more_than_balance_changes_nothing(creator_factory):
    user = creator_factory(tuzis=Decimal("5"))
    with pytest.raises(ledger.InsufficientFunds):
        ledger.debit(user, Decimal("6"))
    assert balance(user) == Decimal("5")


@pytest.mark.django_db
def test_debit_up_to_clamps_at_zero(creator_factory):
    user = creator_factory(tuzis=Decimal("3"))
    assert ledger.debit_up_to(user, Decimal("10")) == Decimal("3")
    assert balance(user) == Decimal("0")
    assert ledger.debit_up_to(user, Decimal("10")) == Decimal("0")
    assert balance(user) == Decimal("0")


@pytest.mark.django_db
def test_transfer_is_all_or_nothing(creator_factory):
    """A failed debit must not leave the recipient credited."""
    poor = creator_factory(tuzis=Decimal("1"))
    rich = creator_factory(tuzis=Decimal("0"))

    with pytest.raises(ledger.InsufficientFunds):
        ledger.transfer(poor, rich, Decimal("100"))

    assert balance(poor) == Decimal("1")
    assert balance(rich) == Decimal("0")


@pytest.mark.django_db(transaction=True)
def test_transfer_conserves_value_under_concurrency(creator_factory):
    """Money is neither created nor destroyed while 8 transfers race."""
    fan = creator_factory(tuzis=Decimal("40"))
    star = creator_factory(tuzis=Decimal("0"))

    def send(_i):
        return ledger.transfer(fan, star, Decimal("10"))

    results = run_concurrently(send, n=8)
    ok = sum(1 for r in results if not isinstance(r, Exception))
    assert ok == 4, results
    assert balance(fan) == Decimal("0")
    assert balance(star) == Decimal("40")


@pytest.mark.django_db(transaction=True)
def test_opposing_transfers_do_not_deadlock(creator_factory):
    """A pays B while B pays A.

    Lock ordering by primary key is what stops this from deadlocking; without
    it one of the threads dies with a Postgres deadlock detection error.
    """
    a = creator_factory(tuzis=Decimal("100"))
    b = creator_factory(tuzis=Decimal("100"))

    def send(i):
        for _ in range(10):
            if i == 0:
                ledger.transfer(a, b, Decimal("1"))
            else:
                ledger.transfer(b, a, Decimal("1"))
        return "done"

    results = run_concurrently(send, n=2)
    assert not [r for r in results if isinstance(r, Exception)], results
    # 10 each way, net zero
    assert balance(a) == Decimal("100")
    assert balance(b) == Decimal("100")


# ---------------------------------------------------------------------------
# The database constraint — the floor under everything above
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_db_rejects_negative_balance_via_update(creator_factory):
    """Even a raw queryset UPDATE that bypasses every validator is refused."""
    user = creator_factory(tuzis=Decimal("1"))
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            Creator.objects.filter(pk=user.pk).update(tuzis=Decimal("-1"))


@pytest.mark.django_db
def test_db_rejects_negative_balance_via_save(creator_factory):
    """`save(update_fields=[...])` skips validators; the constraint does not."""
    user = creator_factory(tuzis=Decimal("1"))
    user.tuzis = Decimal("-0.001")
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            user.save(update_fields=["tuzis"])


# ---------------------------------------------------------------------------
# Donate2Z, through the real HTTP surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_concurrent_donations_cannot_double_spend(creator_factory):
    """One balance, two simultaneous donations that each consume all of it.

    Old behaviour: both POSTs returned 200, the fan's balance ended at -100,
    and 200 2Z of value appeared out of nowhere in the stars' accounts.
    """
    fan = creator_factory(tuzis=Decimal("100"))
    star_a = creator_factory(tuzis=Decimal("0"))
    star_b = creator_factory(tuzis=Decimal("0"))
    stars = [star_a, star_b]

    def donate(i):
        client = APIClient()
        client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
        return client.post(
            f"/api/tuzis/donate/{stars[i].username}",
            {"amount": 100},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code

    results = run_concurrently(donate, n=2)
    assert sorted(results) == [200, 402], results

    assert balance(fan) == Decimal("0")
    total_received = balance(star_a) + balance(star_b)
    assert total_received == Decimal("100"), "value was created or destroyed"


@pytest.mark.django_db
def test_donation_is_one_transaction(api_client, creator_factory, monkeypatch):
    """If the Events fail, the transfer rolls back — no money vanishes.

    Old behaviour: the debit and the credit were separate saves and the Events
    came after both, so an exception anywhere past the first save left the
    system in a state no amount of retrying could repair.
    """
    from dj.apps.events.models import Event

    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"))

    def boom(*args, **kwargs):
        raise RuntimeError("event write failed")

    monkeypatch.setattr(Event.objects, "create", boom)

    api_client.force_authenticate(user=fan)
    with pytest.raises(RuntimeError):
        api_client.post(
            f"/api/tuzis/donate/{star.username}", {"amount": 50}, format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )

    assert balance(fan) == Decimal("100")
    assert balance(star) == Decimal("0")


# ---------------------------------------------------------------------------
# Subscribe idempotency
# ---------------------------------------------------------------------------


def subscribe(fan, star, key=None):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    headers = {
        "HTTP_IDEMPOTENCY_KEY": contract_key(key)
    } if key else {}
    return client.post(f"/api/tuzis/subscribe/{star.username}", **headers)


@pytest.mark.django_db
def test_repeated_subscribe_charges_once(creator_factory):
    """The  scenario: the client gave up, the user re-clicked.

    Old behaviour: every POST called extend() and charged another month.
    """
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = subscribe(fan, star)
    second = subscribe(fan, star)

    assert first.status_code == 200, first.content
    # A retry must look like success to the client, not like an error — an
    # error is exactly what makes a user click a third time.
    assert second.status_code == 200, second.content

    assert balance(fan) == Decimal("990"), "the fan was charged twice"
    assert balance(star) == Decimal("10")

    sub = Subscription.objects.get(fan=fan, star=star)
    # One month, not two.
    assert (sub.expires - timezone.now()).days == 29


@pytest.mark.django_db
def test_subscribe_again_after_debounce_window_does_charge(creator_factory):
    """The debounce must not permanently block a genuine second month."""
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    assert subscribe(fan, star).status_code == 200
    # Pretend the first charge happened well outside the debounce window.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(hours=1))
    assert subscribe(fan, star).status_code == 200

    assert balance(fan) == Decimal("980")
    assert balance(star) == Decimal("20")


@pytest.mark.django_db(transaction=True)
def test_concurrent_subscribe_charges_once(creator_factory):
    """Double-submit: two identical POSTs in flight at the same instant.

    Old behaviour: both read the same balance, both charged, the fan paid
    twice for one month.
    """
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    def go(_i):
        return subscribe(fan, star).status_code

    results = run_concurrently(go, n=2)
    assert results == [200, 200], results
    assert balance(fan) == Decimal("990"), "the fan was charged twice"
    assert balance(star) == Decimal("10")
    assert Subscription.objects.filter(fan=fan, star=star).count() == 1


@pytest.mark.django_db
def test_idempotency_key_survives_the_debounce_window(creator_factory):
    """A client-supplied key is exact, not time-boxed.

    The debounce is a heuristic with a 60s horizon. A retry that carries the
    original Idempotency-Key must be recognised as a retry no matter how long
    it took to arrive.
    """
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = subscribe(fan, star, key="abc-123")
    assert first.status_code == 200, first.content

    # Age the debounce out, so only the key can catch the duplicate.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(days=1)
    )

    second = subscribe(fan, star, key="abc-123")
    assert second.status_code == 200, second.content
    assert first.data["replayed"] is False
    assert second.data["replayed"] is True
    assert {**second.data, "replayed": False} == first.data

    assert balance(fan) == Decimal("990"), "the fan was charged twice"
    assert balance(star) == Decimal("10")


@pytest.mark.django_db
def test_different_idempotency_key_is_a_new_request(creator_factory):
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    assert subscribe(fan, star, key="key-1").status_code == 200
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(days=1)
    )
    assert subscribe(fan, star, key="key-2").status_code == 200

    assert balance(fan) == Decimal("980")


@pytest.mark.django_db
def test_failed_subscribe_does_not_burn_the_idempotency_key(creator_factory):
    """A 402 must be retryable: the key is released when no money moved."""
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    failed = subscribe(fan, star, key="retry-me")
    assert failed.status_code == 402, failed.content
    assert not IdempotencyKey.objects.filter(
        key=contract_key("retry-me")
    ).exists()

    Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("100"))
    assert subscribe(fan, star, key="retry-me").status_code == 200
    assert balance(fan) == Decimal("90")


@pytest.mark.django_db
def test_idempotency_key_is_scoped_per_user(creator_factory):
    """One user's key must never satisfy another user's request."""
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    fan_a = creator_factory(tuzis=Decimal("100"))
    fan_b = creator_factory(tuzis=Decimal("100"))

    assert subscribe(fan_a, star, key="shared").status_code == 200
    assert subscribe(fan_b, star, key="shared").status_code == 200

    assert balance(fan_a) == Decimal("90")
    assert balance(fan_b) == Decimal("90")
    assert balance(star) == Decimal("20")


@pytest.mark.django_db
def test_subscribe_with_insufficient_funds_moves_nothing(creator_factory):
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    assert subscribe(fan, star).status_code == 402
    assert balance(fan) == Decimal("5")
    assert balance(star) == Decimal("0")


# ---------------------------------------------------------------------------
# The other spend paths: votes and page funding
# ---------------------------------------------------------------------------


@pytest.fixture
def comment_on_a_page(creator_factory):
    from django.contrib.contenttypes.models import ContentType

    from dj.apps.comments.models import Comment
    from dj.apps.g12f.models import zPage

    author = creator_factory(tuzis=Decimal("100"))
    # Published: these tests exercise concurrent-vote/funding atomicity, not
    # comment visibility. Comment voting is now gated on the parent being
    # visible to the voter, so the container page must be public
    # for the voter to legitimately reach the comment.
    page = zPage.objects.create(
        creator=author, title="a page", free2zaddr="votepage",
        is_published=True)
    comment = Comment.objects.create(
        author=author, content="hi", tuzis=1,
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.id,
    )
    return page, comment


@pytest.mark.django_db(transaction=True)
def test_concurrent_comment_votes_cannot_overspend(
        creator_factory, comment_on_a_page):
    """One 2Z, two simultaneous votes. The code here said "not threadsafe!!!".

    Old behaviour: both votes were accepted and the voter's balance went to
    -1 — one 2Z bought two votes.
    """
    _page, comment = comment_on_a_page
    voter = creator_factory(tuzis=Decimal("1"))

    def vote(_i):
        client = APIClient()
        client.force_authenticate(user=Creator.objects.get(pk=voter.pk))
        return client.post(
            f"/api/comments/{comment.uuid}/vote/",
            {"vote": "up"}, format="json",
        ).status_code

    results = run_concurrently(vote, n=2)
    assert sorted(results) == [200, 402], results
    assert balance(voter) == Decimal("0")

    comment.refresh_from_db()
    assert comment.tuzis == 2, "exactly one vote should have landed"


@pytest.mark.django_db(transaction=True)
def test_concurrent_page_votes_cannot_overspend(
        creator_factory, comment_on_a_page):
    page, _comment = comment_on_a_page
    voter = creator_factory(tuzis=Decimal("1"))

    def vote(_i):
        client = APIClient()
        client.force_authenticate(user=Creator.objects.get(pk=voter.pk))
        return client.post(
            f"/api/zpage/{page.free2zaddr}/vote/",
            {"vote": "up"}, format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code

    results = run_concurrently(vote, n=2)
    assert sorted(results) == [200, 402], results
    assert balance(voter) == Decimal("0")

    page.refresh_from_db()
    assert page.tuzi_total == 1, "exactly one vote should have landed"


@pytest.mark.django_db(transaction=True)
def test_concurrent_page_funding_cannot_overspend(
        creator_factory, comment_on_a_page):
    """Two simultaneous full-balance fundings of the same page.

    Old behaviour: both succeeded, the page banked 200 from a 100 2Z balance.
    """
    page, _comment = comment_on_a_page
    funder = creator_factory(tuzis=Decimal("100"))

    def fund(_i):
        client = APIClient()
        client.force_authenticate(user=Creator.objects.get(pk=funder.pk))
        return client.post(
            "/api/zpage/fund/",
            {"id": page.free2zaddr, "amount": 100}, format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code

    results = run_concurrently(fund, n=2)
    assert sorted(results) == [200, 402], results
    assert balance(funder) == Decimal("0")

    page.refresh_from_db()
    assert page.tuzi_total == 100, "value was created"


def run_in_lockstep(fn, *, rounds, n=2):
    """Run ``fn(i, r)`` in ``n`` threads, re-synchronised at EVERY round.

    ``run_concurrently`` lines the threads up once; two loops released
    together drift apart within a round or two and the race under test stops
    firing. A Barrier resets itself once every party passes, so one Barrier
    paces every round. A failure in any thread aborts it, releasing the peer
    with ``BrokenBarrierError`` at once instead of leaving it to time out
    against a partner that is already dead.

    Returns, per thread, the list of ``fn`` results or the raised exception.
    """
    round_barrier = threading.Barrier(n)

    def work(i):
        out = []
        try:
            for r in range(rounds):
                round_barrier.wait(timeout=10)
                out.append(fn(i, r))
        except BaseException:
            round_barrier.abort()
            raise
        return out

    return run_concurrently(work, n=n)


def _vote_as(user, page):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return client.post(
        f"/api/zpage/{page.free2zaddr}/vote/",
        {"vote": "up"}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    ).status_code


def _fund_as(user, page, amount):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return client.post(
        "/api/zpage/fund/",
        {"id": page.free2zaddr, "amount": amount}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    ).status_code


@pytest.mark.django_db(transaction=True)
def test_concurrent_vote_and_fund_on_one_page_cannot_deadlock(
        creator_factory, comment_on_a_page):
    """One user votes on a page while funding it.

    The two spend paths above are each safe against themselves. Against each
    other they were not: ``vote_page`` locked the page row and then the
    voter's balance, ``FundPageView`` locked the balance and then the page
    row. Run together, each held one row and waited for the other, and
    Postgres aborted one side with ``deadlock detected`` -- a 500 on a money
    endpoint, from a user doing two perfectly ordinary things at once. Both
    paths now take the Creator row first (``ledger.lock_in_order``), so the
    pair serialize on the balance and every request lands.

    Without the fix this deadlocks within a handful of rounds. With it every
    request is a 200, and the balance and the score account for exactly one
    charge per request -- no lost update hidden behind a retry.
    """
    page, _comment = comment_on_a_page
    user = creator_factory(tuzis=Decimal("1000"))
    rounds = 20
    fund_amount = 2

    def work(i, _r):
        if i == 0:
            return _vote_as(user, page)
        return _fund_as(user, page, fund_amount)

    results = run_in_lockstep(work, rounds=rounds)
    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, (
        "a vote or fund request died instead of serializing on the balance "
        f"row (deadlock?): {errors!r}")
    assert results == [[200] * rounds, [200] * rounds], results

    charged = rounds * 1 + rounds * fund_amount
    assert balance(user) == Decimal("1000") - charged, (
        "the balance does not reflect one charge per request")
    page.refresh_from_db()
    assert page.tuzi_total == charged, (
        "the score does not reflect one increment per request")


@pytest.mark.django_db(transaction=True)
def test_owner_funding_while_others_vote_cannot_deadlock_on_the_event_fk(
        creator_factory, comment_on_a_page):
    """The lock the fix takes must be no stronger than the one it orders.

    Found by the codex adversarial review of the  fix. A voter's first
    vote INSERTs the page owner's ``PAGE_VOTE`` Event, and that row's foreign
    key takes ``FOR KEY SHARE`` on the OWNER's Creator row when the voter's
    transaction commits (Django's FKs are deferred). Plain
    ``select_for_update()`` is ``FOR UPDATE``, which conflicts with KEY
    SHARE; the balance UPDATE the ledger issues is only ``FOR NO KEY
    UPDATE``, which does not. So an owner funding their own page who took
    ``FOR UPDATE`` on their row and then waited for the page row a voter
    holds deadlocked against that voter's commit -- a cycle the pre-fix code
    could not form, because it never held anything stronger than the UPDATE.
    ``lock_in_order`` takes ``FOR NO KEY UPDATE`` for exactly this reason.

    Every round is a first vote from a fresh voter (an INSERT, so the FK
    check fires) paired with the owner funding their own page.
    """
    page, _comment = comment_on_a_page
    owner = page.creator
    rounds = 12
    voters = [creator_factory(tuzis=Decimal("1")) for _ in range(rounds)]
    Creator.objects.filter(pk=owner.pk).update(tuzis=Decimal("1000"))

    def work(i, r):
        if i == 0:
            return _vote_as(voters[r], page)
        return _fund_as(owner, page, 1)

    results = run_in_lockstep(work, rounds=rounds)
    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, (
        "a voter's commit and the owner's fund deadlocked on the owner's "
        f"Creator row: {errors!r}")
    assert results == [[200] * rounds, [200] * rounds], results

    assert balance(owner) == Decimal("1000") - rounds
    assert all(balance(v) == Decimal("0") for v in voters)
    page.refresh_from_db()
    assert page.tuzi_total == 2 * rounds, (
        "the score does not reflect every vote and every fund")


def _wait_until_a_peer_waits_on_a_row_lock(timeout=10):
    """Block until some OTHER connection to this database is queued on a lock.

    Read from ``pg_stat_activity`` on the calling thread's own connection, so
    it works from inside an open transaction. This is what makes the race
    below deterministic without an injected sleep: the thread holding the
    first lock does not continue until the peer has committed to the lock
    order under test -- it has taken its first row and is waiting for the
    second.

    ``pg_stat_clear_snapshot()`` first, every time: inside a transaction
    Postgres serves ``pg_stat_activity`` from the snapshot taken on FIRST
    access, so without it a peer that connected after the first poll never
    appears and this times out against a peer that is genuinely queued.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with connection.cursor() as cur:
            cur.execute("SELECT pg_stat_clear_snapshot()")
            cur.execute(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() "
                "AND pid <> pg_backend_pid() "
                "AND wait_event_type = 'Lock'"
            )
            if cur.fetchone()[0]:
                return
        time.sleep(0.01)
    with connection.cursor() as cur:
        cur.execute("SELECT pg_stat_clear_snapshot()")
        cur.execute(
            "SELECT pid, state, wait_event_type, wait_event, query "
            "FROM pg_stat_activity WHERE datname = current_database() "
            "AND pid <> pg_backend_pid()"
        )
        peers = cur.fetchall()
    raise AssertionError(
        f"the peer request never queued on a row lock; peers: {peers!r}")


def _sellable_translation_model():
    """An enabled ``AIModel`` the purchase resolves to.

    ``test_translation_purchase.ai_model`` FETCHES the row migration
    ``openai.0016`` seeds, and says why. That does not survive here: a
    ``transaction=True`` test flushes every table at teardown, seed rows
    included, and pytest-django runs all transactional tests after the
    ordinary ones -- so by the time this module runs the catalogue is
    usually empty. Recreate the effective first choice of
    ``DEFAULT_MODEL_PREFERENCE`` with the seed's pricing shape; which row wins
    is not what this test is about.
    """
    from dj.apps.openai.models import AIModel

    row, _ = AIModel.objects.update_or_create(
        provider="anthropic", model="claude-haiku-4-5",
        defaults={
            "display_name": "Claude Haiku 4.5",
            "system_message": "",
            "max_tokens": 200_000,
            "is_enabled": True,
        },
    )
    return row


@pytest.mark.django_db(transaction=True)
def test_owner_buying_a_translation_while_voting_cannot_deadlock(
        creator_factory, monkeypatch):
    """The translation purchase must lock the buyer before the page.

    The adversarial review of  found the pair the first cut missed:
    ``ZPageTranslationView.post`` locked the page row
    (``lock_zpages_for_translation_write``) and THEN debited the buyer, i.e.
    page -> Creator. Moving ``vote_page`` onto Creator -> page closed the
    vote/fund cycle and opened this one: an owner buying a translation while
    voting on (or funding) their own page held one row each and waited on the
    other, and Postgres killed one side with ``deadlock detected`` -- a 500
    on a money endpoint. The purchase now takes ``lock_in_order`` on the buyer
    first, like every other 2Z spend on a zPage.

    Deterministic, no injected delay: the purchase's page lock is wrapped so
    that, once taken, it releases the vote and does not return until the vote
    is queued on a row lock. With the fix the vote is queued on the buyer's
    Creator row, which the purchase already holds, and the purchase runs to
    commit. Without it the vote holds the Creator row and is queued on the
    page; the purchase's debit then waits on the vote, and Postgres aborts
    one of them within ``deadlock_timeout``. Every time.
    """
    from dj.apps.g12f.models import zPage
    from dj.apps.g12f.translation import service
    from dj.apps.g12f.translation.tasks import translate_zpage
    from dj.apps.g12f.views import translate as translate_views

    owner = creator_factory(tuzis=Decimal("1000"))
    page = zPage.objects.create(
        creator=owner, free2zaddr=str(uuid.uuid4()),
        title="Free2Z is for creators",
        description="A short summary of the article.",
        content="Support the work. It costs $5 a month, and it is worth it.",
        source_language="en", is_published=True,
    )
    _sellable_translation_model()
    # No provider I/O either way: every provider "has" a key, and the job is
    # captured rather than handed to a real queue.
    monkeypatch.setattr(service, "get_client", lambda provider: object())
    jobs = []
    monkeypatch.setattr(
        translate_zpage, "defer", lambda **kwargs: jobs.append(kwargs)
    )

    buyer = APIClient()
    buyer.force_authenticate(user=Creator.objects.get(pk=owner.pk))
    translate_url = f"/api/zpage/{page.free2zaddr}/variants/es/translate/"
    price = buyer.get(translate_url + "quote/").data["price"]
    assert price >= 1

    page_locked = threading.Event()
    real_lock = translate_views.lock_zpages_for_translation_write

    def lock_then_let_the_vote_queue(*page_ids):
        locked = real_lock(*page_ids)
        page_locked.set()
        _wait_until_a_peer_waits_on_a_row_lock()
        return locked

    monkeypatch.setattr(
        translate_views, "lock_zpages_for_translation_write",
        lock_then_let_the_vote_queue,
    )

    def work(i):
        if i == 0:
            return buyer.post(
                translate_url, {"expected_price": price}, format="json",
                HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
            ).status_code
        assert page_locked.wait(timeout=10), "the purchase never locked"
        return _vote_as(owner, page)

    results = run_concurrently(work, n=2)
    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, (
        "the purchase and the vote held one row each and waited on the other "
        "(deadlock?):\n" + "".join(
            "".join(traceback.format_exception(e)) for e in errors))
    assert results == [202, 200], results

    assert balance(owner) == Decimal("1000") - price - 1, (
        "the balance does not reflect one translation and one vote")
    page.refresh_from_db()
    assert page.tuzi_total == 1
    assert len(jobs) == 1, "the charge committed but nothing was enqueued"


def _run_comment_vote_and_score_race(creator_factory, monkeypatch, *, ordered):
    """Race a real self-vote against a real positive AI score.

    The vote is held after it has acquired the Comment lock. The scorer is
    then released to acquire the author's Creator lock and queue on that same
    Comment. ``pg_stat_activity`` is the handshake: the vote is not allowed to
    debit until the scorer is genuinely waiting on a row lock.

    ``ordered=False`` is the negative control for the pre- code. It
    removes only the vote's Creator-first lock; the scorer and the endpoint
    remain real, so the test proves the old deadlock rather than asserting
    source text.
    """
    from dj.apps.comments import views as comment_views
    from dj.apps.comments.management.commands import aiscore_comments
    from dj.apps.comments.models import Comment

    author = creator_factory(tuzis=Decimal("10"))
    comment = Comment.objects.create(
        author=author, content="score and vote", tuzis=1)
    comment_locked = threading.Event()
    scorer_may_start = threading.Event()
    real_debit = ledger.debit

    def coordinated_debit(*args, **kwargs):
        comment_locked.set()
        assert scorer_may_start.wait(timeout=10), (
            "the scorer did not start after the vote acquired the Comment")
        _wait_until_a_peer_waits_on_a_row_lock()
        return real_debit(*args, **kwargs)

    # Keep the vote's debit spy isolated from aiscore_comments' shared ledger
    # module. The negative control emulates the old Comment -> Creator path;
    # the fixed case calls the real helper.
    vote_ledger = SimpleNamespace(
        debit=coordinated_debit,
        lock_in_order=(ledger.lock_in_order if ordered else lambda *_: None),
        insufficient_funds_payload=ledger.insufficient_funds_payload,
    )
    monkeypatch.setattr(comment_views, "ledger", vote_ledger)

    class ScoreMessage:
        data = json.dumps({
            "uuid": str(comment.uuid),
            "content": comment.content,
            "author": author.username,
        }).encode("utf-8")

        def __init__(self):
            self.acks = 0
            self.nacks = 0

        def ack(self):
            self.acks += 1

        def nack(self):
            self.nacks += 1

    message = ScoreMessage()
    monkeypatch.setattr(aiscore_comments, "score_content", lambda _content: 5)
    scorer_errors = []
    real_print_exc = aiscore_comments.traceback.print_exc

    def capture_scorer_error():
        error = sys.exc_info()[1]
        if error is not None:
            scorer_errors.append(error)
        # Keep the production callback's traceback reporting unchanged.
        real_print_exc()

    monkeypatch.setattr(
        aiscore_comments.traceback, "print_exc", capture_scorer_error)

    def work(i):
        if i == 0:
            client = APIClient()
            client.force_authenticate(user=Creator.objects.get(pk=author.pk))
            return client.post(
                f"/api/comments/{comment.uuid}/vote/", {"vote": "up"},
                format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
            ).status_code

        assert comment_locked.wait(timeout=10), (
            "the vote never acquired the Comment before the scorer started")
        scorer_may_start.set()
        aiscore_comments.callback(message)
        return message

    results = run_concurrently(work, n=2)
    return author, comment, message, results, scorer_errors


def _sqlstate(error):
    """Return the deepest chained database SQLSTATE from a test failure."""
    while error is not None:
        sqlstate = getattr(error, "sqlstate", None)
        if sqlstate is not None:
            return sqlstate
        error = error.__cause__
    return None


@pytest.mark.django_db(transaction=True)
def test_unordered_comment_vote_and_score_deadlock_is_reproduced(
        creator_factory, monkeypatch):
    """Negative control: the old Comment -> Creator order deadlocks."""
    author, comment, message, results, scorer_errors = (
        _run_comment_vote_and_score_race(
            creator_factory, monkeypatch, ordered=False))

    vote_failed = isinstance(results[0], Exception)
    scorer_failed = bool(scorer_errors)
    assert vote_failed != scorer_failed, (
        "the old lock inversion did not produce exactly one transaction "
        f"victim: results={results!r}, scorer_errors={scorer_errors!r}")

    if vote_failed:
        assert _sqlstate(results[0]) == "40P01", results[0]
        assert message.acks == 1 and message.nacks == 0
        assert balance(author) == Decimal("15")
        comment.refresh_from_db()
        assert comment.tuzis == 6
        assert Event.objects.filter(
            type="AISCORE_COMMENT", object_id=str(comment.uuid)).count() == 1
    else:
        assert len(scorer_errors) == 1
        assert _sqlstate(scorer_errors[0]) == "40P01", scorer_errors[0]
        assert message.acks == 0 and message.nacks == 1
        assert results[0] == 200, results
        assert balance(author) == Decimal("9")
        comment.refresh_from_db()
        assert comment.tuzis == 2
        assert not Event.objects.filter(
            type="AISCORE_COMMENT", object_id=str(comment.uuid)).exists()


@pytest.mark.django_db(transaction=True)
def test_comment_self_vote_and_score_use_one_lock_order(
        creator_factory, monkeypatch):
    """A self-vote and positive AI score serialize without losing money."""
    author, comment, message, results, scorer_errors = (
        _run_comment_vote_and_score_race(
            creator_factory, monkeypatch, ordered=True))

    assert results[0] == 200, results
    assert message.acks == 1 and message.nacks == 0
    assert not scorer_errors
    assert balance(author) == Decimal("14")
    comment.refresh_from_db()
    assert comment.tuzis == 7


# ---------------------------------------------------------------------------
# Crash-window regressions found by the codex adversarial review of this PR
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_crashed_subscribe_does_not_double_charge_on_stale_retry(
        creator_factory, monkeypatch):
    """The claim row and the charge must commit together, or not at all.

    The scenario codex found: the charge commits, the pod dies before the claim
    is marked finished, and five minutes later a retry takes over the
    'abandoned' claim. If claim.finish() were outside the money transaction,
    that retry would charge a second month using the very idempotency key whose
    job is to prevent exactly that.

    Here the crash is simulated *after* extend() has charged. Because finish()
    is inside the same transaction, everything rolls back, the retry
    legitimately re-runs, and the fan is charged exactly once in total.
    """
    from dj.apps.g12f.models.creator import Subscription as Sub

    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    real_extend = Sub.extend

    def crash_after_charging(self, *args, **kwargs):
        real_extend(self, *args, **kwargs)
        raise RuntimeError("pod evicted mid-request")

    monkeypatch.setattr(Sub, "extend", crash_after_charging)
    with pytest.raises(RuntimeError):
        subscribe(fan, star, key="crash-key")

    # The charge rolled back together with the claim.
    assert balance(fan) == Decimal("1000"), "a rolled-back request charged"
    assert balance(star) == Decimal("0")

    monkeypatch.undo()
    # Age the claim past STALE_CLAIM so the retry takes it over.
    IdempotencyKey.objects.filter(key=contract_key("crash-key")).update(
        created_at=timezone.now() - timedelta(hours=1))

    assert subscribe(fan, star, key="crash-key").status_code == 200
    assert balance(fan) == Decimal("990"), "charged twice across the crash"
    assert balance(star) == Decimal("10")


@pytest.fixture
def stripe_signing_secret(settings):
    settings.STRIPE_SIGNING_SECRET = SIGNING_SECRET
    settings.STRIPE_SECRET_KEY = "sk_test_money_atomicity"
    settings.STRIPE_EXPECTED_ACCOUNT_ID = "acct_testMoneyAtomicity"
    settings.STRIPE_EXPECTED_LIVEMODE = "false"
    settings.STRIPE_CHECKOUT_ENABLED = "true"
    settings.STRIPE_WEBHOOK_ENDPOINT_ID = "we_testMoneyAtomicity"
    StripeCheckoutRollout.objects.get_or_create(
        singleton=1,
        defaults={
            "legacy_session_created_at_or_before_epoch": 1_735_689_600,
        },
    )
    with patch('dj.apps.ztripe.views.verify_and_record_checkout_event'):
        yield SIGNING_SECRET


def _post_webhook(client, payload):
    """POST an honestly signed delivery of the exact bytes in `payload`."""
    return client.post(
        "/api/stripe/webhook/", data=payload,
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE=sign(payload),
    )


@pytest.mark.django_db
def test_stripe_credit_and_marker_commit_together(creator_factory,
                                                  stripe_signing_secret,
                                                  monkeypatch):
    """A crash between the StripeTransaction row and the credit loses money.

    Old behaviour: get_or_create committed the "already credited" marker in its
    own transaction. Crash before the credit and Stripe's retry sees
    created=False, skips crediting, and the user has paid real money for 2Z
    that will never arrive. Found by the codex adversarial review.

    Drives the real webhook view end to end -- real signature, real
    `stripe.Event`, real Postgres. Only `Event.objects.create` is replaced, and
    only to make the crash happen on cue.
    """
    from django.test import Client

    from dj.apps.events.models import Event
    from dj.apps.ztripe.models import StripeTransaction

    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_crash_test")

    def boom(*args, **kwargs):
        raise RuntimeError("crash after the marker was written")

    monkeypatch.setattr(Event.objects, "create", boom)

    client = Client()
    with pytest.raises(RuntimeError):
        _post_webhook(client, payload)

    # Neither the marker nor the credit survived, so Stripe's retry can work.
    assert not StripeTransaction.objects.filter(
        stripe_charge_id="pi_crash_test").exists(), (
        "the 'already credited' marker outlived the credit it marks")
    assert balance(user) == Decimal("0")

    # And the retry does in fact credit.
    monkeypatch.undo()
    assert _post_webhook(client, payload).status_code == 200
    assert balance(user) > Decimal("0"), "the retry did not credit the user"


@pytest.mark.django_db
def test_stripe_webhook_replay_credits_once(creator_factory,
                                            stripe_signing_secret):
    """The ordinary replay path still credits exactly once."""
    from django.test import Client

    user = creator_factory(tuzis=Decimal("0"))
    payload = checkout_completed(user, "pi_replay_test")
    client = Client()

    assert _post_webhook(client, payload).status_code == 200
    credited = balance(user)
    assert credited > Decimal("0")
    assert _post_webhook(client, payload).status_code == 200
    assert balance(user) == credited, "a replayed webhook credited twice"


@pytest.mark.django_db(transaction=True)
def test_ai_chat_settlement_failure_rolls_back_answer_and_preserves_hold(
        creator_factory, monkeypatch):
    """Only spendable funds race; a failed settlement rolls the answer back."""
    from dj.apps.ledger import api
    from dj.apps.openai.models import (
        AIModel, Conversation, GenerationResult, PromptResponse,
    )

    user = creator_factory(tuzis=Decimal("500"))
    model = AIModel.objects.create(
        model="test-model", display_name="Test", system_message="hi",
        # A real window: a turn the trim loop cannot fit is now a 400 before
        # any charge (tuzi#2490), and these tests are about the charge.
        max_tokens=8192,
    )
    conversation = Conversation.objects.create(
        user=user, ai_model=model, display_name="c")

    # The view reserves 250 2Z before generation. A concurrent spend can use
    # only the remaining 250 2Z, so the L2 hold remains protected.
    def fake_generate(self, user_input, **kwargs):
        results = run_concurrently(
            lambda _i: ledger.debit(
                Creator.objects.get(pk=user.pk), Decimal("250")), n=2)
        assert sum(not isinstance(r, Exception) for r in results) == 1
        assert sum(isinstance(r, ledger.InsufficientFunds)
                   for r in results) == 1
        return GenerationResult("the expensive answer", 1000, 1000, 1000)

    monkeypatch.setattr(Conversation, "generate", fake_generate)
    monkeypatch.setattr(
        AIModel, "get_tuzi_price", lambda self, i, o, **_cache_counts: Decimal("250"))

    def fail_settlement(reservation, *, amount=None):
        raise ledger.InsufficientFunds(
            Creator.objects.get(pk=user.pk), amount,
            balance=Decimal("250"), action="ai_chat")

    monkeypatch.setattr(ledger, "settle_reservation", fail_settlement)

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    response = client.post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {"user_input": "hello"}, format="json",
    )

    assert response.status_code == 402, response.content
    assert response.data["code"] == "insufficient_funds"
    assert Decimal(response.data["cost"]) == Decimal("250")
    assert Decimal(response.data["balance"]) == Decimal("250")
    assert response.data["action"] == "ai_chat"
    ledger_balance = api.read_balance(user.pk)
    assert ledger_balance.available == 250_000
    assert ledger_balance.held == 0, "failed settlement left the hold behind"
    assert balance(user) == Decimal("250")
    assert not PromptResponse.objects.filter(
        response="the expensive answer").exists(), (
        "the unpaid-for AI response survived the rollback")


@pytest.mark.django_db
def test_ai_chat_charges_the_full_price_on_success(creator_factory,
                                                   monkeypatch):
    from dj.apps.openai.models import AIModel, Conversation, GenerationResult

    user = creator_factory(tuzis=Decimal("1000"))
    model = AIModel.objects.create(
        model="test-model", display_name="Test", system_message="hi",
        # A real window: a turn the trim loop cannot fit is now a 400 before
        # any charge (tuzi#2490), and these tests are about the charge.
        max_tokens=8192,
    )
    conversation = Conversation.objects.create(
        user=user, ai_model=model, display_name="c")

    def fake_generate(self, user_input, **kwargs):
        return GenerationResult("answer", 10, 10, 10)

    monkeypatch.setattr(Conversation, "generate", fake_generate)
    monkeypatch.setattr(
        AIModel, "get_tuzi_price",
        lambda self, i, o, **_cache_counts: Decimal("250"))

    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    response = client.post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {"user_input": "hello"}, format="json",
    )
    assert response.status_code == 200, response.content
    assert balance(user) == Decimal("750")




@pytest.mark.django_db
def test_idempotency_key_is_scoped_per_target_creator(creator_factory):
    """The same key against a different creator is a different request.

    Replaying the first creator's "OK" would silently swallow a paid
    subscription to the second. Found by the codex adversarial review.
    """
    fan = creator_factory(tuzis=Decimal("1000"))
    star_a = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    star_b = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    assert subscribe(fan, star_a, key="same-key").status_code == 200
    assert subscribe(fan, star_b, key="same-key").status_code == 200

    assert balance(star_a) == Decimal("10")
    assert balance(star_b) == Decimal("10"), (
        "the second creator's subscription was swallowed as a duplicate")
    assert balance(fan) == Decimal("980")
    assert Subscription.objects.filter(fan=fan).count() == 2


@pytest.mark.django_db
def test_release_cannot_delete_a_claim_taken_over_by_someone_else(
        creator_factory):
    """Only the current owner may release a claim.

    Without the owner token, a request that outlived its own takeover could
    delete the claim row out from under the handler now using it, letting a
    third retry charge again. Found by the codex adversarial review.
    """
    from dj.apps.tuzis import models as idem

    fan = creator_factory(tuzis=Decimal("1000"))

    original = idem.claim("subscribe:1", fan, "k")
    # Age it out and let a "retry" take it over.
    IdempotencyKey.objects.filter(pk=original.pk).update(
        created_at=timezone.now() - timedelta(hours=1))
    taken_over = idem.claim("subscribe:1", fan, "k")
    assert taken_over.owner != original.owner

    # The zombie original tries to clean up after itself.
    idem.release(original)
    assert IdempotencyKey.objects.filter(pk=taken_over.pk).exists(), (
        "a stale handler deleted the live handler's claim")

    # The current owner still can.
    idem.release(taken_over)
    assert not IdempotencyKey.objects.filter(pk=taken_over.pk).exists()


@pytest.mark.django_db
def test_finish_by_a_stale_owner_is_rejected(creator_factory):
    """A zombie handler must not be able to stamp a result it did not produce."""
    from dj.apps.tuzis import models as idem

    fan = creator_factory(tuzis=Decimal("1000"))
    original = idem.claim("subscribe:1", fan, "k2")
    IdempotencyKey.objects.filter(pk=original.pk).update(
        created_at=timezone.now() - timedelta(hours=1))
    idem.claim("subscribe:1", fan, "k2")

    with pytest.raises(idem.DuplicateRequest):
        original.finish(200, "OK")


# ---------------------------------------------------------------------------
# Deploy-safety invariants for the money migration
# ---------------------------------------------------------------------------


def test_creator_constraint_migration_bounds_its_lock_wait():
    """The CHECK constraint must never queue unboundedly for its lock.

    `manage.py migrate` runs in its own cloudbuild step BEFORE bazel-apply, so
    this migration alters g12f_creator -- the auth user table -- while the old
    code serves 100% of traffic. ACCESS EXCLUSIVE conflicts with the ACCESS
    SHARE every SELECT takes, so one long-running transaction can make our
    20ms ALTER queue, and every subsequent request queues behind it: a
    site-wide stall.

    `SET LOCAL lock_timeout` turns that into a failed deploy you retry. This
    asserts the guard is present, sets the lock *before* the operations it
    protects, and is inside a transaction (SET LOCAL is a no-op outside one).
    """
    from django.db import migrations as dj_migrations
    from django.db.migrations.loader import MigrationLoader

    migration = MigrationLoader(None, load=True).disk_migrations[
        ('g12f', '0085_subscription_last_charged_at_and_more')]

    # SET LOCAL only has meaning inside a transaction.
    assert migration.atomic, (
        "migration must stay atomic or SET LOCAL lock_timeout does nothing")

    ops = migration.operations
    timeout_at = [
        i for i, op in enumerate(ops)
        if isinstance(op, dj_migrations.RunSQL)
        and "lock_timeout" in str(op.sql).lower()
    ]
    assert timeout_at, "no lock_timeout guard in the migration"

    constraint_at = [
        i for i, op in enumerate(ops)
        if isinstance(op, dj_migrations.AddConstraint)
    ]
    assert constraint_at, "expected an AddConstraint operation"
    assert min(timeout_at) < min(constraint_at), (
        "lock_timeout must be set BEFORE the AddConstraint it protects")


# ---------------------------------------------------------------------------
# Multi-balance settlements must acquire locks in a single global order
# ---------------------------------------------------------------------------


def _ppv_shaped_settlement(participant, creator, ordered):
    """The dyte PPV settlement shape: debit the participant, credit the
    creator, in that order regardless of their ids."""
    with transaction.atomic():
        if ordered:
            ledger.lock_in_order(participant, creator)
        ledger.debit_up_to(participant, Decimal("1"))
        taken = ledger.debit_up_to(participant, Decimal("1"))
        ledger.credit(
            creator, taken, source="sys:platform_revenue", ref_kind="ppv",
            ref_id=str(uuid.uuid4()), idem=f"test-ppv:{uuid.uuid4()}",
        )


@pytest.mark.django_db(transaction=True)
def test_ppv_shaped_settlement_deadlocks_without_ordered_locks(
        creator_factory):
    """Proves the hazard is real before proving the fix closes it.

    A settlement that always touches the participant first, racing a transfer
    that touches rows in pk order, acquires the two rows in opposite orders.
    Postgres detects the cycle and kills one side. If this ever stops failing,
    the test below is no longer proving anything.
    """
    from django.db import OperationalError

    low = creator_factory(tuzis=Decimal("500"))
    high = creator_factory(tuzis=Decimal("500"))
    # participant must sort AFTER the creator for the orders to conflict.
    participant, creator = (high, low) if high.pk > low.pk else (low, high)
    assert participant.pk > creator.pk

    def work(i):
        for _ in range(25):
            if i == 0:
                _ppv_shaped_settlement(participant, creator, ordered=False)
            else:
                # A donation from the creator back to the participant: locks
                # in pk order, i.e. creator's row first.
                ledger.transfer(creator, participant, Decimal("1"))
        return "done"

    results = run_concurrently(work, n=2)
    deadlocks = [r for r in results if isinstance(r, OperationalError)]
    assert deadlocks, (
        "expected Postgres to detect a deadlock with unordered locking; "
        f"got {results}"
    )


@pytest.mark.django_db(transaction=True)
def test_ordered_locks_close_the_ppv_deadlock(creator_factory):
    """Same race, with lock_in_order — nobody deadlocks and value is conserved."""
    low = creator_factory(tuzis=Decimal("500"))
    high = creator_factory(tuzis=Decimal("500"))
    participant, creator = (high, low) if high.pk > low.pk else (low, high)

    opening = balance(participant) + balance(creator)
    rounds = 25

    def work(i):
        for _ in range(rounds):
            if i == 0:
                _ppv_shaped_settlement(participant, creator, ordered=True)
            else:
                ledger.transfer(creator, participant, Decimal("1"))
        return "done"

    results = run_concurrently(work, n=2)
    assert not [r for r in results if isinstance(r, Exception)], results

    # Each settlement takes a 1 2Z platform fee, which leaves this pair for
    # the platform; the creator's cut and the donations only move between the
    # two. So the pair's total must be down by exactly the fees collected --
    # not a round number, an accounted one.
    assert balance(participant) + balance(creator) == opening - rounds, (
        "value was created or destroyed beyond the platform fees")


@pytest.mark.django_db
def test_subscribe_response_says_whether_it_charged(creator_factory):
    """A money endpoint must not answer identically for "charged" and "no-op".

    Without this the client cannot tell a swallowed duplicate from a real
    charge, and neither can anyone reading logs during an incident.
    """
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))

    first = subscribe(fan, star)
    assert first.status_code == 200, first.content
    assert first.data["charged"] is True
    first_expires = first.data["expires"]
    assert first_expires

    # Duplicate inside the debounce: still 200 (the caller IS subscribed),
    # but honest about not having taken any money.
    second = subscribe(fan, star)
    assert second.status_code == 200, second.content
    assert second.data["charged"] is False, "a no-op claimed it charged"
    assert second.data["expires"] == first_expires, (
        "a swallowed duplicate must not move the expiry either")

    assert balance(fan) == Decimal("990")

    # A genuine second month outside the window reports a charge and a later
    # expiry.
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(hours=1))
    third = subscribe(fan, star)
    assert third.data["charged"] is True
    assert third.data["expires"] > first_expires
    assert balance(fan) == Decimal("980")
