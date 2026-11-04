"""PostgreSQL races and authenticated recovery for subscription intents."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
import threading
import uuid
from unittest.mock import patch

import pytest
from django.db import IntegrityError, OperationalError, connection, transaction
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator, Subscription
from dj.apps.tuzis import ledger
from dj.apps.tuzis import views as tuzis_views
from dj.apps.tuzis.models import (
    IdempotencyKey,
    SubscriptionIntentAbandonment,
    SubscriptionIntentEvidence,
)
from dj.apps.tuzis.views import (
    CONFIRMED_SUBSCRIBE_SCOPE,
    LEGACY_SUBSCRIBE_SCOPE,
    SUBSCRIBE_SHARED_SCOPE,
    _abandon_subscription_intent,
)


pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        connection.vendor != "postgresql",
        reason="subscription recovery races require PostgreSQL",
    ),
]


def make_key(label):
    # Subscription routes intentionally accept UUIDv4 keys only.  The label
    # keeps call sites self-documenting while every request gets a valid key.
    del label
    return str(uuid.uuid4())


def scopes(star):
    return (
        f"{SUBSCRIBE_SHARED_SCOPE}:{star.pk}",
        f"{LEGACY_SUBSCRIBE_SCOPE}:{star.pk}",
        CONFIRMED_SUBSCRIBE_SCOPE,
    )


def pending_receipts(fan, star, key, *, include_confirmed=True):
    body = {"_creator_pk": star.pk, "_subscription_intent": "pending"}
    result = []
    for scope in scopes(star):
        if scope == CONFIRMED_SUBSCRIBE_SCOPE and not include_confirmed:
            continue
        result.append(IdempotencyKey.objects.create(
            scope=scope,
            user=fan,
            key=key,
            request_hash="historical-request",
            response_body=body,
        ))
    return result


def post_recovery(client, star, key, **extra):
    return client.post(
        f"/api/tuzis/subscribe-recovery/{star.pk}",
        {"key": key, "username": star.username, "expected_price": "10", **extra},
        format="json",
    )


def test_authenticated_recovery_retains_and_fences_all_route_receipts(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("all-routes")
    records = pending_receipts(fan, star, key)
    client = APIClient()
    client.force_authenticate(user=fan)

    other = creator_factory(tuzis=Decimal("100"))
    other_client = APIClient()
    other_client.force_authenticate(user=other)
    unauthorized_recovery = post_recovery(other_client, star, key)
    assert unauthorized_recovery.status_code == 200
    assert unauthorized_recovery.data == {"status": "unchanged"}
    assert not SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).exists()

    response = post_recovery(client, star, key)

    assert response.status_code == 200, response.content
    assert response.data == {"status": "abandoned"}
    assert SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key, user=fan,
    ).exists()
    for record in records:
        record.refresh_from_db()
        assert record.response_status == 409
        assert record.abandoned_at is not None
        assert record.response_body["_creator_pk"] == star.pk

    retry = client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert retry.status_code == 409, retry.content
    assert retry.data["code"] == "subscription_intent_abandoned"
    legacy_retry = client.post(
        f"/api/tuzis/subscribe/{star.username}",
        {},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert legacy_retry.status_code == 409, legacy_retry.content
    assert legacy_retry.data["code"] == "subscription_intent_abandoned"
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("100")

    old_key_for_b = other_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert old_key_for_b.status_code == 409
    assert old_key_for_b.data["code"] == "subscription_intent_abandoned"
    fresh_for_b = other_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=make_key("fresh-b"),
        format="json",
    )
    assert fresh_for_b.status_code == 200, fresh_for_b.content


def test_recovery_ignores_a_confirmed_receipt_for_another_creator(
    creator_factory,
):
    """A fan-wide confirmed receipt must not resolve creator B's attempt."""
    fan = creator_factory(tuzis=Decimal("100"))
    creator_a = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    creator_b = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("other-creator-receipt")
    IdempotencyKey.objects.create(
        scope=CONFIRMED_SUBSCRIBE_SCOPE,
        user=fan,
        key=key,
        response_status=200,
        response_body={"_creator_pk": creator_a.pk, "charged": True},
    )
    pending_receipts(fan, creator_b, key, include_confirmed=False)

    client = APIClient()
    client.force_authenticate(user=fan)
    response = post_recovery(client, creator_b, key)

    assert response.data == {"status": "abandoned"}
    assert SubscriptionIntentAbandonment.objects.filter(
        creator_id=creator_b.pk, key=key,
    ).exists()
    assert not SubscriptionIntentAbandonment.objects.filter(
        creator_id=creator_a.pk, key=key,
    ).exists()


def test_recovery_requires_authentication_and_survives_username_reuse(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    old_username = star.username
    key = make_key("rename-reuse")
    pending_receipts(fan, star, key)
    anonymous = APIClient()

    response = post_recovery(anonymous, star, key)

    assert response.status_code in {401, 403}
    assert not SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).exists()

    Creator.objects.filter(pk=star.pk).update(username=f"{old_username}-new")
    replacement = creator_factory(
        username=old_username,
        tuzis=Decimal("0"),
        member_price=Decimal("10"),
    )
    client = APIClient()
    client.force_authenticate(user=fan)

    response = post_recovery(client, star, key, username=old_username)

    assert response.status_code == 200
    assert response.data == {"status": "abandoned"}
    reused_route = client.post(
        f"/api/tuzis/subscribe-confirmed/{replacement.username}",
        {"creator_id": replacement.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert reused_route.status_code == 409
    assert reused_route.data["code"] == "idempotency_mismatch"
    assert reused_route.data["key_resolved"] is True
    replacement.refresh_from_db()
    assert replacement.tuzis == Decimal("0")


def test_recovery_rolls_back_every_marker_on_crash(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("recovery-crash")
    records = pending_receipts(fan, star, key)

    def crash(**kwargs):
        raise RuntimeError("lost before recovery commit")

    with patch.object(
        SubscriptionIntentAbandonment.objects,
        "get_or_create",
        side_effect=crash,
    ):
        with pytest.raises(RuntimeError):
            _abandon_subscription_intent(fan, star, key)

    assert not SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).exists()
    for record in records:
        record.refresh_from_db()
        assert record.response_status is None
        assert record.abandoned_at is None

    client = APIClient()
    client.force_authenticate(user=fan)
    response = post_recovery(client, star, key)
    assert response.data == {"status": "abandoned"}


def test_recovery_race_is_retryable_instead_of_rotating_the_key(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("recovery-retryable")
    records = pending_receipts(fan, star, key)
    client = APIClient()
    client.force_authenticate(user=fan)

    with patch.object(
        SubscriptionIntentAbandonment.objects,
        "get_or_create",
        side_effect=IntegrityError("recovery fence raced"),
    ):
        response = post_recovery(client, star, key)

    assert response.status_code == 409, response.content
    assert response.data["code"] == "subscription_recovery_retryable"
    assert not SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).exists()
    for record in records:
        record.refresh_from_db()
        assert record.response_status is None
        assert record.abandoned_at is None


def test_recovery_retryable_exception_is_an_http_409(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    client = APIClient()
    client.force_authenticate(user=fan)

    with patch.object(
        tuzis_views,
        "_abandon_subscription_intent",
        side_effect=tuzis_views._SubscriptionRecoveryRetryable,
    ):
        response = post_recovery(client, star, make_key("boundary"))

    assert response.status_code == 409, response.content
    assert response.data["code"] == "subscription_recovery_retryable"


def _lock_timeout_error():
    class PostgresLockTimeout(Exception):
        sqlstate = "55P03"

    error = OperationalError("canceling statement due to lock timeout")
    error.__cause__ = PostgresLockTimeout()
    return error


@pytest.mark.parametrize("route", ["confirmed", "legacy"])
def test_subscription_lock_timeout_releases_claim_and_returns_retryable_409(
    creator_factory, route,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    client = APIClient()
    client.force_authenticate(user=fan)
    key = make_key("lock-timeout")
    if route == "confirmed":
        path = f"/api/tuzis/subscribe-confirmed/{star.username}"
        body = {"creator_id": star.pk, "expected_price": "10"}
    else:
        path = f"/api/tuzis/subscribe/{star.username}"
        body = {}

    with patch.object(
        tuzis_views,
        "_lock_subscription_intent",
        side_effect=_lock_timeout_error(),
    ):
        response = client.post(
            path,
            body,
            HTTP_IDEMPOTENCY_KEY=key,
            format="json",
        )

    assert response.status_code == 409, response.content
    assert response.data["code"] == "subscription_retryable"
    assert not IdempotencyKey.objects.filter(key=key, user=fan).exists()


def test_recovery_lock_timeout_is_retryable_409(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    client = APIClient()
    client.force_authenticate(user=fan)
    with patch.object(
        tuzis_views,
        "_abandon_subscription_intent",
        side_effect=_lock_timeout_error(),
    ):
        response = post_recovery(client, star, make_key("recovery-lock-timeout"))

    assert response.status_code == 409, response.content
    assert response.data["code"] == "subscription_recovery_retryable"


def test_recovery_is_idempotent_and_does_not_turn_402_into_a_tombstone(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("5"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("released-402")
    client = APIClient()
    client.force_authenticate(user=fan)

    failed = client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert failed.status_code == 402
    assert not IdempotencyKey.objects.filter(user=fan, key=key).exists()
    evidence = SubscriptionIntentEvidence.objects.get(
        creator_id=star.pk, user=fan, key=key,
    )
    assert evidence.resolved_at is None
    assert not SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).exists()

    Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("100"))
    retried = client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert retried.status_code == 200, retried.content

    # Losing the recovery response does not make the next recovery unsafe.
    again = post_recovery(client, star, key)
    assert again.data == {"status": "resolved"}
    evidence.refresh_from_db()
    assert evidence.resolved_at is not None

    abandoned_key = make_key("released-402-abandoned")
    Creator.objects.filter(pk=fan.pk).update(tuzis=Decimal("5"))
    Subscription.objects.filter(fan=fan, star=star).update(
        last_charged_at=timezone.now() - timedelta(days=1),
    )
    failed_again = client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=abandoned_key,
        format="json",
    )
    assert failed_again.status_code == 402
    abandoned = post_recovery(client, star, abandoned_key)
    assert abandoned.data == {"status": "abandoned"}
    old_retry = client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=abandoned_key,
        format="json",
    )
    assert old_retry.status_code == 409
    assert old_retry.data["code"] == "subscription_intent_abandoned"


def test_abandonment_wins_before_finish_and_rolls_back_the_debit(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("finish-race")
    record = IdempotencyKey.objects.create(
        scope=f"{SUBSCRIBE_SHARED_SCOPE}:{star.pk}",
        user=fan,
        key=key,
        request_hash="same-request",
        response_body={"_creator_pk": star.pk},
    )
    charge_started = threading.Event()
    recovery_done = threading.Event()
    charge_error = []

    def charge():
        try:
            with transaction.atomic():
                ledger.debit(fan, Decimal("10"), action="subscription")
                charge_started.set()
                assert recovery_done.wait(timeout=10)
                record.finish(200, {"charged": True})
        except Exception as exc:
            charge_error.append(exc)
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(charge)
        assert charge_started.wait(timeout=10)
        outcome = _abandon_subscription_intent(fan, star, key)
        recovery_done.set()
        future.result(timeout=10)

    assert outcome == "abandoned"
    assert charge_error, "the stale owner unexpectedly finished the charge"
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("100")
    record.refresh_from_db()
    assert record.response_status == 409
    assert record.abandoned_at is not None


def test_two_same_key_charges_and_new_payer_intent_are_separate(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    other = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("same-key")

    def charge(user):
        client = APIClient()
        client.force_authenticate(user=user)
        response = client.post(
            f"/api/tuzis/subscribe-confirmed/{star.username}",
            {"creator_id": star.pk, "expected_price": "10"},
            HTTP_IDEMPOTENCY_KEY=key,
            format="json",
        )
        connection.close()
        return response.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(charge, [fan, fan]))
    assert set(statuses).issubset({200, 409}), statuses
    assert 200 in statuses
    fan.refresh_from_db()
    assert fan.tuzis == Decimal("90")

    blocked_old_key = charge(other)
    assert blocked_old_key == 200  # a different payer has an independent intent
    other.refresh_from_db()
    assert other.tuzis == Decimal("90")


def test_recovery_wins_against_a_preflighted_other_payer_http_charge(
    creator_factory,
):
    payer_a = creator_factory(tuzis=Decimal("5"))
    payer_b = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("http-recovery-wins")

    a_client = APIClient()
    a_client.force_authenticate(user=payer_a)
    failed = a_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert failed.status_code == 402

    b_started = threading.Event()
    allow_b_to_settle = threading.Event()
    call_lock = threading.Lock()
    call_count = 0
    original_lock = tuzis_views._lock_subscription_intent

    def gate(star_arg, key_arg, **kwargs):
        nonlocal call_count
        with call_lock:
            call_count += 1
            first = call_count == 1
        if first:
            b_started.set()
            assert allow_b_to_settle.wait(timeout=10)
        return original_lock(star_arg, key_arg, **kwargs)

    result = []

    def charge_as_b():
        client = APIClient()
        client.force_authenticate(user=payer_b)
        try:
            result.append(client.post(
                f"/api/tuzis/subscribe-confirmed/{star.username}",
                {"creator_id": star.pk, "expected_price": "10"},
                HTTP_IDEMPOTENCY_KEY=key,
                format="json",
            ))
        finally:
            connection.close()

    with patch.object(tuzis_views, "_lock_subscription_intent", side_effect=gate):
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(charge_as_b)
            assert b_started.wait(timeout=10)
            recovery = post_recovery(a_client, star, key)
            assert recovery.status_code == 200
            assert recovery.data == {"status": "abandoned"}
            allow_b_to_settle.set()
            future.result(timeout=10)

    assert len(result) == 1
    assert result[0].status_code == 409, result[0].content
    assert result[0].data["code"] == "subscription_intent_abandoned"
    payer_b.refresh_from_db()
    assert payer_b.tuzis == Decimal("100")

    fresh = APIClient()
    fresh.force_authenticate(user=payer_b)
    next_purchase = fresh.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=make_key("http-recovery-wins-fresh"),
        format="json",
    )
    assert next_purchase.status_code == 200, next_purchase.content
    payer_b.refresh_from_db()
    assert payer_b.tuzis == Decimal("90")


def test_recovery_holds_the_advisory_lock_before_a_charge_can_settle(
    creator_factory,
):
    payer_a = creator_factory(tuzis=Decimal("5"))
    payer_b = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("lock-order")
    pending_receipts(payer_a, star, key)
    original_lock = tuzis_views._lock_subscription_intent
    recovery_lock_acquired = threading.Event()
    charge_attempted_lock = threading.Event()
    charge_entered_lock = threading.Event()
    release_recovery = threading.Event()
    first = True
    lock_state = threading.Lock()

    def pause_after_lock(star_arg, key_arg, **kwargs):
        nonlocal first
        with lock_state:
            is_recovery = first
            first = False
        if not is_recovery:
            charge_attempted_lock.set()
        try:
            original_lock(star_arg, key_arg, **kwargs)
        except tuzis_views._SubscriptionIntentAbandoned:
            if not is_recovery:
                charge_entered_lock.set()
            raise
        if is_recovery:
            recovery_lock_acquired.set()
            assert release_recovery.wait(timeout=10)
        else:
            charge_entered_lock.set()

    charge_result = []

    def recover_as_a():
        client = APIClient()
        client.force_authenticate(user=payer_a)
        try:
            return post_recovery(client, star, key)
        finally:
            connection.close()

    def charge_as_b():
        client = APIClient()
        client.force_authenticate(user=payer_b)
        try:
            charge_result.append(client.post(
                f"/api/tuzis/subscribe-confirmed/{star.username}",
                {"creator_id": star.pk, "expected_price": "10"},
                HTTP_IDEMPOTENCY_KEY=key,
                format="json",
            ))
        finally:
            connection.close()

    with patch.object(
        tuzis_views, "_lock_subscription_intent", side_effect=pause_after_lock,
    ):
        with ThreadPoolExecutor(max_workers=2) as pool:
            recovery_future = pool.submit(recover_as_a)
            assert recovery_lock_acquired.wait(timeout=10)
            charge_future = pool.submit(charge_as_b)
            assert charge_attempted_lock.wait(timeout=10)
            assert not charge_entered_lock.wait(timeout=0.5)
            release_recovery.set()
            recovery = recovery_future.result(timeout=10)
            charge_future.result(timeout=10)

    assert recovery.status_code == 200, recovery.content
    assert recovery.data == {"status": "abandoned"}
    assert charge_entered_lock.is_set()
    assert len(charge_result) == 1
    assert charge_result[0].status_code == 409, charge_result[0].content
    assert charge_result[0].data["code"] == "subscription_intent_abandoned"


def test_http_charge_then_recovery_replays_the_payers_own_receipt(
    creator_factory,
):
    payer_a = creator_factory(tuzis=Decimal("5"))
    payer_b = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("http-charge-wins")
    a_client = APIClient()
    a_client.force_authenticate(user=payer_a)
    assert a_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    ).status_code == 402

    b_client = APIClient()
    b_client.force_authenticate(user=payer_b)
    charged = b_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert charged.status_code == 200, charged.content
    assert post_recovery(a_client, star, key).data == {"status": "abandoned"}

    old_retry = b_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert old_retry.status_code == 200, old_retry.content
    assert old_retry.data["replayed"] is True
    payer_b.refresh_from_db()
    assert payer_b.tuzis == Decimal("90")

    Subscription.objects.filter(fan=payer_b, star=star).update(
        last_charged_at=timezone.now() - timedelta(days=1),
    )
    fresh_retry = b_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=make_key("http-charge-wins-fresh"),
        format="json",
    )
    assert fresh_retry.status_code == 200, fresh_retry.content
    payer_b.refresh_from_db()
    assert payer_b.tuzis == Decimal("80")


def test_legacy_charge_then_recovery_replays_own_receipt_without_double_charge(
    creator_factory,
):
    payer_a = creator_factory(tuzis=Decimal("5"))
    payer_b = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("legacy-charge-wins")

    a_client = APIClient()
    a_client.force_authenticate(user=payer_a)
    assert a_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    ).status_code == 402

    b_client = APIClient()
    b_client.force_authenticate(user=payer_b)
    charged = b_client.post(
        f"/api/tuzis/subscribe/{star.username}",
        {},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert charged.status_code == 200, charged.content
    assert charged.data["charged"] is True
    payer_b.refresh_from_db()
    assert payer_b.tuzis == Decimal("90")

    assert post_recovery(a_client, star, key).data == {"status": "abandoned"}

    confirmed_replay = b_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert confirmed_replay.status_code == 200, confirmed_replay.content
    assert confirmed_replay.data["replayed"] is True
    payer_b.refresh_from_db()
    assert payer_b.tuzis == Decimal("90")

    replayed = b_client.post(
        f"/api/tuzis/subscribe/{star.username}",
        {},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert replayed.status_code == 200, replayed.content
    assert replayed.data["replayed"] is True
    payer_b.refresh_from_db()
    assert payer_b.tuzis == Decimal("90"), (
        "a legacy receipt hidden behind the recovery fence was charged twice"
    )


def test_concurrent_http_recovery_returns_only_committed_outcomes(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("concurrent-recovery")
    pending_receipts(fan, star, key)

    def recover():
        client = APIClient()
        client.force_authenticate(user=fan)
        try:
            return post_recovery(client, star, key).data
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: recover(), range(2)))
    assert outcomes == [{"status": "abandoned"}, {"status": "abandoned"}]
    assert SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).count() == 1


def test_abandonment_fence_survives_original_payer_deletion(
    creator_factory,
):
    payer_a = creator_factory(tuzis=Decimal("5"))
    payer_b = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("payer-delete")
    a_client = APIClient()
    a_client.force_authenticate(user=payer_a)
    assert a_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    ).status_code == 402
    assert post_recovery(a_client, star, key).data == {"status": "abandoned"}

    fence = SubscriptionIntentAbandonment.objects.get(
        creator_id=star.pk, key=key,
    )
    Creator.objects.filter(pk=payer_a.pk).delete()
    fence.refresh_from_db()
    assert fence.user_id is None

    b_client = APIClient()
    b_client.force_authenticate(user=payer_b)
    blocked = b_client.post(
        f"/api/tuzis/subscribe-confirmed/{star.username}",
        {"creator_id": star.pk, "expected_price": "10"},
        HTTP_IDEMPOTENCY_KEY=key,
        format="json",
    )
    assert blocked.status_code == 409
    assert blocked.data["code"] == "subscription_intent_abandoned"


def test_historical_confirmed_fingerprint_uses_immutable_creator_encoding(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("historical-fingerprint")
    historical_hash = tuzis_views.idempotency.fingerprint({
        "creator": star.pk,
        "creator_username": star.username,
        "expected_price": "10",
    })
    IdempotencyKey.objects.create(
        scope=CONFIRMED_SUBSCRIBE_SCOPE,
        user=fan,
        key=key,
        request_hash=historical_hash,
        response_body={"_subscription_intent": "pending"},
    )
    client = APIClient()
    client.force_authenticate(user=fan)
    response = post_recovery(client, star, key)
    assert response.data == {"status": "abandoned"}


def test_cleanup_prunes_expired_abandoned_receipts_and_recovery_evidence(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("10"))
    key = make_key("cleanup-retention")
    client = APIClient()
    client.force_authenticate(user=fan)
    pending_receipts(fan, star, key)
    SubscriptionIntentEvidence.objects.create(
        creator_id=star.pk, user=fan, key=key,
    )

    response = post_recovery(client, star, key)
    assert response.data == {"status": "abandoned"}
    old = timezone.now() - timedelta(days=400)
    IdempotencyKey.objects.filter(user=fan, key=key).update(created_at=old)
    SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).update(created_at=old)
    SubscriptionIntentEvidence.objects.filter(
        creator_id=star.pk, user=fan, key=key,
    ).update(created_at=old)

    call_command("cleanup_idempotency", retention_days=1)

    assert not SubscriptionIntentAbandonment.objects.filter(
        creator_id=star.pk, key=key,
    ).exists()
    assert IdempotencyKey.objects.filter(user=fan, key=key).count() == 0
    assert not SubscriptionIntentEvidence.objects.filter(
        creator_id=star.pk, user=fan, key=key,
    ).exists()
