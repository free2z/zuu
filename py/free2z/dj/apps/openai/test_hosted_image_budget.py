from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone as datetime_timezone
import threading
import uuid

from decimal import Decimal

import pytest

from dj.apps.openai import views
from dj.apps.tuzis.models import IdempotencyKey


@pytest.mark.django_db(transaction=True)
def test_admission_day_survives_finish_and_midnight_rollover(creator_factory, mocker):
    creator = creator_factory()
    prior_day_claim = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=str(uuid.uuid4()),
        response_body={"operation": "ai_image", "state": "provider_pending"},
    )
    IdempotencyKey.objects.filter(pk=prior_day_claim.pk).update(
        created_at=datetime(2026, 12, 31, 23, 59, tzinfo=datetime_timezone.utc),
    )
    now = datetime(2027, 1, 1, 0, 1, tzinfo=datetime_timezone.utc)
    mocker.patch("dj.apps.openai.views.timezone.now", side_effect=lambda: now)

    assert views._reserve_hosted_image_budget(prior_day_claim, Decimal("0.003"), Decimal("0.003"))
    admitted_day = prior_day_claim.response_body["_image_operation"]["budget_day"]
    terminal = views._retain_hosted_budget_day(prior_day_claim, {
        "budget_state": "uncertain", "budget_reserved_usd": "0.003",
    })
    prior_day_claim.finish(503, {"_image_operation": terminal})
    assert prior_day_claim.response_body["_image_operation"]["budget_day"] == admitted_day
    assert prior_day_claim.created_at.date().isoformat() == "2027-01-01"

    same_day_claim = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=str(uuid.uuid4()),
        response_body={"operation": "ai_image", "state": "provider_pending"},
    )
    IdempotencyKey.objects.filter(pk=same_day_claim.pk).update(
        created_at=datetime(2027, 1, 1, 0, 2, tzinfo=datetime_timezone.utc),
    )
    assert not views._reserve_hosted_image_budget(
        same_day_claim, Decimal("0.003"), Decimal("0.003"),
    )

    now = datetime(2027, 1, 2, 0, 1, tzinfo=datetime_timezone.utc)
    next_day_claim = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=str(uuid.uuid4()),
        response_body={"operation": "ai_image", "state": "provider_pending"},
    )
    IdempotencyKey.objects.filter(pk=next_day_claim.pk).update(
        created_at=datetime(2027, 1, 2, 0, 2, tzinfo=datetime_timezone.utc),
    )
    assert views._reserve_hosted_image_budget(
        next_day_claim, Decimal("0.003"), Decimal("0.003"),
    )
    assert next_day_claim.response_body["_image_operation"]["budget_day"] == "2027-01-02"


@pytest.mark.django_db(transaction=True)
def test_two_workers_share_one_image_daily_budget(creator_factory):
    creator = creator_factory()
    amount = Decimal("0.003")
    claims = [
        IdempotencyKey.objects.create(
            scope="ai_image", user=creator, key=str(uuid.uuid4()),
            response_body={"operation": "ai_image", "state": "provider_pending"},
        )
        for _ in range(2)
    ]
    gate = threading.Barrier(2)

    def reserve(claim):
        from django.db import close_old_connections

        close_old_connections()
        gate.wait(timeout=5)
        try:
            return views._reserve_hosted_image_budget(claim, amount, amount)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(reserve, claims))

    assert sorted(results) == [False, True]
    operations = list(
        IdempotencyKey.objects.filter(scope="ai_image")
        .values_list("response_body", flat=True)
    )
    reservations = [
        body["_image_operation"]
        for body in operations
        if isinstance(body, dict)
        and isinstance(body.get("_image_operation"), dict)
        and body["_image_operation"].get("budget_state") == "reserved"
    ]
    assert len(reservations) == 1
    assert Decimal(reservations[0]["budget_reserved_usd"]) == amount


@pytest.mark.django_db(transaction=True)
def test_admission_does_not_wait_for_reconciliation_lock(creator_factory):
    from django.db import connection, transaction, close_old_connections
    from dj.apps.openai.hosted_image import BUDGET_ADVISORY_LOCK

    creator = creator_factory()
    claim = IdempotencyKey.objects.create(scope="ai_image", user=creator, key=str(uuid.uuid4()))
    def reserve():
        close_old_connections()
        try:
            return views._reserve_hosted_image_budget(claim, Decimal("0.006"), Decimal("1"))
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=1) as workers:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(%s)", [BUDGET_ADVISORY_LOCK])
            result = workers.submit(reserve)
            assert result.result(timeout=2) is False
    claim.refresh_from_db()
    assert not (claim.response_body or {}).get("_image_operation")


@pytest.mark.django_db(transaction=True)
def test_account_daily_cap_counts_refunded_uncertain_requests_without_blocking_other_accounts(creator_factory, settings):
    settings.FAL_IMAGE_ACCOUNT_DAILY_BUDGET_USD = "0.012"
    first_user, second_user = creator_factory(), creator_factory()
    def claim(user):
        return IdempotencyKey.objects.create(scope="ai_image", user=user, key=str(uuid.uuid4()))
    for _ in range(2):
        receipt = claim(first_user)
        assert views._reserve_hosted_image_budget(receipt, Decimal("0.006"), Decimal("1"))
        receipt.finish(400, {"_image_operation": views._retain_hosted_budget_day(receipt, {
            "provider": "fal", "budget_state": "uncertain", "budget_reserved_usd": "0.006",
        })})
    from dj.apps.openai.hosted_image import ImageProviderAccountBudgetExceeded
    with pytest.raises(ImageProviderAccountBudgetExceeded):
        views._reserve_hosted_image_budget(claim(first_user), Decimal("0.006"), Decimal("1"))
    assert views._reserve_hosted_image_budget(claim(second_user), Decimal("0.006"), Decimal("1"))


@pytest.mark.django_db(transaction=True)
def test_concurrent_admission_cannot_exceed_account_cap(creator_factory, settings):
    from django.db import close_old_connections
    from dj.apps.openai.hosted_image import ImageProviderAccountBudgetExceeded
    settings.FAL_IMAGE_ACCOUNT_DAILY_BUDGET_USD = "0.006"
    creator = creator_factory()
    claims = [IdempotencyKey.objects.create(scope="ai_image", user=creator, key=str(uuid.uuid4())) for _ in range(2)]
    barrier = threading.Barrier(2)
    def reserve(claim):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            try:
                return views._reserve_hosted_image_budget(claim, Decimal("0.006"), Decimal("1"))
            except ImageProviderAccountBudgetExceeded:
                return False
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=2) as workers:
        assert sorted(workers.map(reserve, claims)) == [False, True]
    assert IdempotencyKey.objects.filter(user=creator, response_body__contains={"_image_operation": {"budget_state": "reserved"}}).count() == 1


@pytest.mark.django_db
def test_admission_budget_day_is_utc_when_local_timezone_differs(creator_factory, mocker):
    from django.utils import timezone
    creator = creator_factory()
    claim = IdempotencyKey.objects.create(scope="ai_image", user=creator, key=str(uuid.uuid4()))
    mocker.patch("dj.apps.openai.views.timezone.now", return_value=datetime(2027, 1, 1, 0, 1, tzinfo=datetime_timezone.utc))
    with timezone.override("America/Los_Angeles"):
        assert views._reserve_hosted_image_budget(claim, Decimal("0.006"), Decimal("1"))
    assert claim.response_body["_image_operation"]["budget_day"] == "2027-01-01"


@pytest.mark.django_db
def test_unrelated_openai_unknown_outcome_does_not_close_fal_budget(creator_factory):
    creator = creator_factory()
    IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key=str(uuid.uuid4()), response_status=409,
        response_body={"_image_operation": {
            "provider": "openai", "budget_state": "uncertain", "billed_usd": None,
        }},
    )
    claim = IdempotencyKey.objects.create(scope="ai_image", user=creator, key=str(uuid.uuid4()))
    assert views._reserve_hosted_image_budget(claim, Decimal("0.006"), Decimal("1"))
