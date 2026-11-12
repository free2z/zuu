"""Real OAuth wire requests, PostgreSQL receipts, balances and renewal races."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from threading import Barrier, Event
from uuid import uuid4
import time

import pytest
from django.db import close_old_connections, connection
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator, Subscription
from dj.apps.oidc.consent import revoke_authorization
from dj.apps.oidc.models import MCPAccountGrant, MCPActionAudit
from dj.apps.oidc.tests.test_mcp_connections import issue, link
from dj.apps.tuzis.models import IdempotencyKey
from .financial import DONATE, PURCHASE, CAP, CANCEL, RECOVER, STATUS
from .test_catalog import call
from .test_operations import _hosted_settings, tool  # noqa: F401

pytestmark = pytest.mark.django_db(transaction=True)


def donation(star, **kw):
    return {
        "path": {"username": star.username},
        "body": {"recipient_id": star.pk, "amount": 3, "anon": False},
        "idempotency_key": str(uuid4()),
        "max_charge_tuzis": "3",
        **kw,
    }


def purchase(star, renewal=0):
    return {
        "path": {"username": star.username},
        "body": {
            "recipient_id": star.pk,
            "expected_price": 5,
            "renewal_max_price": renewal,
        },
        "idempotency_key": str(uuid4()),
        "max_charge_tuzis": "5",
    }


def policy(star, **fields):
    return {
        "path": {"username": star.username},
        "body": {"recipient_id": star.pk, **fields},
    }


def threaded(fn):
    close_old_connections()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET statement_timeout='15s'")
            cursor.execute("SET lock_timeout='10s'")
        return fn()
    finally:
        close_old_connections()


def test_linked_donation_lost_response_rename_and_revocation(
    signed_in, user, creator_factory
):
    raw = issue(signed_in, user)[2]["access_token"]
    fan = creator_factory(username="payer", tuzis=100)
    star = creator_factory(username="recipient", tuzis=0)
    grant, _ = link(raw, fan, scopes=["mcp:transfer"])
    before_owner = Creator.objects.get(pk=user.pk).tuzis
    args = donation(star)
    # Commit the actual request, discard the reply, retry with the durable handle.
    first = call(raw, grant["id"], DONATE, **args)
    assert first["status"] == 200, first
    assert first["data"] == {"balance": "97.000", "charged": "3.000", "replayed": False}
    assert first["payer_account_id"] == grant["id"] and first["recipient_id"] == star.pk
    Creator.objects.filter(pk=star.pk).update(username="renamed")
    creator_factory(username="recipient")
    replay = call(raw, grant["id"], DONATE, **args)
    assert replay["status"] == 200 and replay["data"]["replayed"], replay
    args["path"]["username"] = "renamed"
    assert call(raw, grant["id"], DONATE, **args)["data"]["replayed"]
    for field, value in [("amount", 4), ("anon", True), ("recipient_id", user.pk)]:
        changed = {
            **args,
            "body": {**args["body"], field: value},
            "max_charge_tuzis": "10",
        }
        assert call(raw, grant["id"], DONATE, **changed)["status"] == 409
    Creator.objects.filter(pk=star.pk).update(is_active=False)
    assert call(raw, grant["id"], DONATE, **args)["data"]["replayed"]
    assert (
        call(raw, grant["id"], DONATE, **{**args, "idempotency_key": str(uuid4())})[
            "status"
        ]
        == 404
    )
    assert Creator.objects.get(pk=fan.pk).tuzis == 97
    assert Creator.objects.get(pk=star.pk).tuzis == 3
    assert Creator.objects.get(pk=user.pk).tuzis == before_owner
    audit = MCPActionAudit.objects.filter(operation=DONATE, status=200).first()
    assert audit.primary_user_id == user.pk and audit.target_user_id == fan.pk
    assert (
        IdempotencyKey.objects.filter(
            user=fan, scope="donate-idempotent", response_status=200
        ).count()
        == 1
    )
    MCPAccountGrant.objects.filter(pk=grant["id"]).update(revoked_at=timezone.now())
    assert call(raw, grant["id"], DONATE, **args)["status"] == 403


def test_separate_consent_limits_keys_and_connection_revoke(
    signed_in, user, creator_factory
):
    app, _, tokens = issue(signed_in, user)
    raw = tokens["access_token"]
    fan = creator_factory(username="limitedpayer", tuzis=100)
    star = creator_factory(username="payee", member_price=5)
    grant, _ = link(raw, fan, scopes=["mcp:spend", "mcp:account"])
    assert call(raw, grant["id"], DONATE, **donation(star))["status"] == 403
    assert call(raw, grant["id"], PURCHASE, **purchase(star))["status"] == 403
    grant, _ = link(raw, fan, scopes=["mcp:transfer"])
    for key, value in [
        ("idempotency_key", None),
        ("idempotency_key", str(uuid4()).upper()),
        ("max_charge_tuzis", None),
        ("max_charge_tuzis", "2.999"),
    ]:
        assert (
            call(raw, grant["id"], DONATE, **donation(star, **{key: value}))["status"]
            == 400
        )
    assert call(raw, grant["id"], PURCHASE, **purchase(star, 5))["status"] == 403
    omitted = purchase(star)
    del omitted["body"]["renewal_max_price"]
    assert call(raw, grant["id"], PURCHASE, **omitted)["status"] == 400
    assert not Subscription.objects.filter(fan=fan, star=star).exists()
    assert call(raw, grant["id"], PURCHASE, **purchase(star))["status"] == 200
    other = issue(signed_in, user, app)[2]["access_token"]
    assert call(other, grant["id"], DONATE, **donation(star))["status"] == 403
    revoke_authorization(user, app)
    assert (
        APIClient()
        .post(
            "/api/mcp",
            {},
            format="json",
            secure=True,
            HTTP_AUTHORIZATION=f"Bearer {raw}",
        )
        .status_code
        == 401
    )


@pytest.mark.parametrize("renewal", [0, 5])
def test_membership_receipt_policy_changes_rename_and_recovery(
    signed_in, user, creator_factory, renewal
):
    raw = issue(signed_in, user)[2]["access_token"]
    fan = creator_factory(username="memberpayer", tuzis=100)
    star = creator_factory(username="membercreator", tuzis=0, member_price=5)
    grant, _ = link(raw, fan, scopes=["mcp:transfer", "mcp:renew", "mcp:account"])
    args = purchase(star, renewal)
    first = call(raw, grant["id"], PURCHASE, **args)
    assert first["status"] == 200, first
    assert first["data"]["charged"] is True and not first["data"]["replayed"]
    sub = Subscription.objects.get(fan=fan, star=star)
    assert sub.max_price == renewal
    assert Decimal(first["data"]["subscription"]["max_price"]) == renewal
    cap = call(raw, grant["id"], CAP, **policy(star, max_price=7))
    assert cap["status"] == 200 and Decimal(cap["renewal_policy"]["max_price"]) == 7, (
        cap
    )
    Creator.objects.filter(pk=star.pk).update(username="newmembername")
    creator_factory(username=star.username)
    replay = call(raw, grant["id"], PURCHASE, **args)
    assert replay["status"] == 200 and replay["data"]["replayed"], replay
    assert Decimal(replay["renewal_policy"]["max_price"]) == 7
    for field, value in [
        ("expected_price", 6),
        ("renewal_max_price", 7),
        ("recipient_id", user.pk),
    ]:
        changed = {
            **args,
            "body": {**args["body"], field: value},
            "max_charge_tuzis": "10",
        }
        assert call(raw, grant["id"], PURCHASE, **changed)["status"] == 409
    status = call(
        raw,
        grant["id"],
        STATUS,
        read=True,
        path={"username": "membercreator"},
        query={"recipient_id": star.pk},
    )
    assert status["status"] == 200 and Decimal(status["data"]["max_price"]) == 7, status
    Creator.objects.filter(pk=star.pk).update(is_active=False)
    cancelled = call(raw, grant["id"], CANCEL, **policy(star))
    assert (
        cancelled["status"] == 200
        and not cancelled["renewal_policy"]["automatic_renewal"]
    ), cancelled
    replay = call(raw, grant["id"], PURCHASE, **args)
    assert (
        replay["status"] == 200 and not replay["renewal_policy"]["automatic_renewal"]
    ), replay
    recovered = call(
        raw,
        grant["id"],
        RECOVER,
        path={"creator_id": star.pk},
        body={"key": args["idempotency_key"]},
    )
    assert recovered["status"] == 200 and recovered["data"]["status"] == "resolved", (
        recovered
    )
    sub.refresh_from_db()
    assert sub.max_price == 0 and sub.expires.isoformat() == first["data"]["expires"]
    assert Creator.objects.get(pk=fan.pk).tuzis == 95
    assert Creator.objects.get(pk=star.pk).tuzis == 5


@pytest.mark.parametrize("linked", [False, True])
def test_reciprocal_concurrent_donations(signed_in, user, creator_factory, linked):
    owners = [user, creator_factory(username="otherowner", tuzis=100)]
    actors = (
        [creator_factory(username=f"selected{i}", tuzis=100) for i in range(2)]
        if linked
        else owners
    )
    Creator.objects.filter(pk__in=[x.pk for x in actors]).update(tuzis=100)
    app, _, tokens = issue(signed_in, user)
    browser = APIClient()
    browser.force_login(owners[1])
    raws = [tokens["access_token"], issue(browser, owners[1], app)[2]["access_token"]]
    if linked:
        for raw, actor in zip(raws, actors):
            link(raw, actor, scopes=["mcp:transfer"])
    ready = Barrier(2)

    def action(i):
        ready.wait(timeout=10)
        return call(raws[i], actors[i].username, DONATE, **donation(actors[1 - i]))

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(threaded, lambda i=i: action(i)) for i in range(2)]
        results = [f.result(timeout=25) for f in futures]
    assert [r["status"] for r in results] == [200, 200], results
    assert [Creator.objects.get(pk=x.pk).tuzis for x in actors] == [100, 100]


@pytest.mark.parametrize("winner", ["cancel", "renew"])
def test_cancellation_races_native_renewal(
    signed_in, user, creator_factory, monkeypatch, winner
):
    from dj.apps.g12f.tasks import renew_subscription
    from dj.apps.tuzis import ledger
    from . import financial

    raw = issue(signed_in, user)[2]["access_token"]
    fan = creator_factory(username="racingpayer", tuzis=100)
    star = creator_factory(username="racingstar", tuzis=0, member_price=5)
    grant, _ = link(raw, fan, scopes=["mcp:transfer", "mcp:renew"])
    first = call(raw, grant["id"], PURCHASE, **purchase(star, 5))
    assert first["status"] == 200, first
    sub = Subscription.objects.get(fan=fan, star=star)
    expiry = timezone.now() + timedelta(hours=1)
    Subscription.objects.filter(pk=sub.pk).update(
        expires=expiry, last_charged_at=timezone.now() - timedelta(days=29)
    )
    locked, release, contender = Event(), Event(), Event()
    original_financial, original_lock = financial.execute, ledger.lock_in_order
    if winner == "cancel":

        def gated_financial(*a, **kw):
            locked.set()
            assert release.wait(10)
            return original_financial(*a, **kw)

        monkeypatch.setattr(financial, "execute", gated_financial)
    else:

        def gated_lock(*a, **kw):
            original_lock(*a, **kw)
            if not locked.is_set():
                locked.set()
                assert release.wait(10)

        monkeypatch.setattr(ledger, "lock_in_order", gated_lock)

    def cancel():
        contender.set()
        return call(raw, grant["id"], CANCEL, **policy(star))

    def renew():
        contender.set()
        renew_subscription(subscription_id=sub.pk)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_job = pool.submit(threaded, cancel if winner == "cancel" else renew)
        assert locked.wait(10)
        contender.clear()
        second_job = pool.submit(threaded, renew if winner == "cancel" else cancel)
        assert contender.wait(10)
        try:
            deadline = time.monotonic() + 8
            while True:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid)) > 0)"
                    )
                    if cursor.fetchone()[0]:
                        break
                assert time.monotonic() < deadline, (
                    "the competing transaction never waited on the winner's lock"
                )
                Event().wait(0.01)
        finally:
            release.set()
        one, two = first_job.result(timeout=25), second_job.result(timeout=25)
    cancelled = one if winner == "cancel" else two
    assert cancelled["status"] == 200, cancelled
    sub.refresh_from_db()
    assert sub.max_price == 0
    if winner == "cancel":
        assert sub.expires == expiry
    else:
        assert sub.expires > expiry
    expected = 95 if winner == "cancel" else 90
    assert Creator.objects.get(pk=fan.pk).tuzis == expected
    renew_subscription(subscription_id=sub.pk)
    assert Creator.objects.get(pk=fan.pk).tuzis == expected


def test_free_membership_and_native_financial_refusals(
    signed_in, user, creator_factory
):
    raw = issue(signed_in, user)[2]["access_token"]
    fan = creator_factory(username="freepayer", tuzis=2)
    star = creator_factory(username="freecreator", tuzis=0, member_price=0)
    grant, _ = link(raw, fan, scopes=["mcp:transfer"])
    args = purchase(star)
    args["body"]["expected_price"] = 0
    args["max_charge_tuzis"] = "0"
    result = call(raw, grant["id"], PURCHASE, **args)
    assert result["status"] == 200 and result["data"]["charged"] is True, result
    assert (
        result["charge_tuzis"] == "0"
        and not result["renewal_policy"]["automatic_renewal"]
    )
    assert Creator.objects.get(pk=fan.pk).tuzis == 2
    # Real native insufficient-funds and price validation, no provider calls.
    assert call(raw, grant["id"], DONATE, **donation(star))["status"] == 402
    changed = purchase(star)
    assert call(raw, grant["id"], PURCHASE, **changed)["status"] == 409
    Creator.objects.filter(pk=star.pk).update(is_active=False)
    assert (
        call(raw, grant["id"], PURCHASE, **{**args, "idempotency_key": str(uuid4())})[
            "status"
        ]
        == 404
    )


def test_recovery_fences_native_pending_intent(signed_in, user, creator_factory):
    from dj.apps.tuzis import models as native
    from dj.apps.tuzis.views import CONFIRMED_SUBSCRIBE_SCOPE

    raw = issue(signed_in, user)[2]["access_token"]
    fan = creator_factory(username="recoverpayer", tuzis=100)
    star = creator_factory(username="recovercreator", member_price=5)
    grant, _ = link(raw, fan, scopes=["mcp:transfer"])
    args = purchase(star)
    native.claim(
        CONFIRMED_SUBSCRIBE_SCOPE,
        fan,
        args["idempotency_key"],
        request_hash=native.fingerprint(
            {
                "creator": star.pk,
                "creator_username": star.username,
                "expected_price": "5",
            }
        ),
        initial_body={"_creator_pk": star.pk, "_subscription_intent": "pending"},
    )
    recovered = call(
        raw,
        grant["id"],
        RECOVER,
        path={"creator_id": star.pk},
        body={"key": args["idempotency_key"]},
    )
    assert recovered["status"] == 200 and recovered["data"]["status"] == "abandoned", (
        recovered
    )
    assert call(raw, grant["id"], PURCHASE, **args)["status"] == 409
    assert Creator.objects.get(pk=fan.pk).tuzis == 100
    assert not Subscription.objects.filter(fan=fan, star=star).exists()


def test_expired_debounce_snapshot_cannot_fall_through_to_debit(creator_factory):
    from dj.apps.tuzis import ledger

    fan = creator_factory(username="snapshotpayer", tuzis=100)
    star = creator_factory(username="snapshotstar", member_price=5)
    sub = Subscription.objects.create(
        fan=fan,
        star=star,
        max_price=5,
        last_charged_at=timezone.now() - timedelta(days=2),
    )
    with pytest.raises(ledger.SubscriptionRetryRequired):
        sub.extend(expected_price=5, _debounce_at=timezone.now())
    assert Creator.objects.get(pk=fan.pk).tuzis == 100


@pytest.mark.parametrize("operation", [DONATE, PURCHASE])
def test_retry_cannot_switch_selected_payer(
    signed_in, user, creator_factory, operation
):
    raw = issue(signed_in, user)[2]["access_token"]
    payers = [creator_factory(username=f"exactpayer{i}", tuzis=100) for i in range(2)]
    grants = [link(raw, payer, scopes=["mcp:transfer"])[0] for payer in payers]
    star = creator_factory(username="exactrecipient", tuzis=0, member_price=5)
    args = donation(star) if operation == DONATE else purchase(star)
    assert call(raw, grants[0]["id"], operation, **args)["status"] == 200
    changed = call(raw, grants[1]["id"], operation, **args)
    assert changed["status"] == 409, changed
    assert Creator.objects.get(pk=payers[1].pk).tuzis == 100
    assert Creator.objects.get(pk=star.pk).tuzis == (3 if operation == DONATE else 5)
