"""Tests for the zPage funding endpoint, against real Postgres.

``FundPageView`` had no ``permission_classes`` (DRF default AllowAny), so an
anonymous ``POST /api/zpage/fund/`` reached ``request.user.tuzis`` on an
``AnonymousUser`` → 500.
"""
import uuid
from decimal import Decimal

import pytest

from dj.apps.g12f.models import zPage


def _page(creator):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"fund-{uuid.uuid4().hex[:8]}",
        title="A page",
        content="Some content.",
        is_published=True,
    )


@pytest.mark.django_db
def test_fund_rejects_anonymous(api_client, creator_factory):
    page = _page(creator_factory())
    response = api_client.post(
        "/api/zpage/fund/", {"id": page.free2zaddr, "amount": 5}, format="json"
    )
    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db(transaction=True)
def test_fund_debits_funder_and_credits_page(api_client, creator_factory):
    funder = creator_factory()          # tuzis=1000
    owner = creator_factory()
    page = _page(owner)

    api_client.force_authenticate(user=funder)
    response = api_client.post(
        "/api/zpage/fund/", {"id": page.free2zaddr, "amount": 10}, format="json"
    )

    assert response.status_code == 200, response.content
    page.refresh_from_db()
    owner.refresh_from_db()
    funder.refresh_from_db()
    assert funder.tuzis == Decimal("990")
    assert page.tuzi_total == Decimal("10")
    assert owner.total == Decimal("0.01")
    # The old code recomputed the funder's cache instead of the recipient's.
    assert funder.total == Decimal("0")
    # The score arrives as the exact decimal string, not a lossy float.
    assert response.json() == {
        "score": str(page.f2z_score),
        "replayed": False,
    }


@pytest.mark.django_db
@pytest.mark.parametrize("amount", [0, -1, "1e100", "NaN", "Infinity"])
def test_fund_rejects_non_positive_or_unrepresentable_amounts(
    api_client, creator_factory, amount,
):
    funder = creator_factory(tuzis=Decimal("10"))
    page = _page(creator_factory())
    api_client.force_authenticate(user=funder)

    response = api_client.post(
        "/api/zpage/fund/", {"id": page.free2zaddr, "amount": amount},
        format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 400, response.content
    funder.refresh_from_db()
    page.refresh_from_db()
    assert funder.tuzis == Decimal("10")
    assert page.tuzi_total == 0


@pytest.mark.django_db(transaction=True)
def test_fund_retry_with_same_key_debits_once(api_client, creator_factory):
    funder = creator_factory(tuzis=Decimal("10"))
    page = _page(creator_factory())
    api_client.force_authenticate(user=funder)
    key = str(uuid.uuid4())

    first = api_client.post(
        "/api/zpage/fund/",
        {"id": page.free2zaddr, "amount": 2},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )
    second = api_client.post(
        "/api/zpage/fund/",
        {"id": page.free2zaddr, "amount": 2},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert first.status_code == second.status_code == 200
    first_body = first.json()
    second_body = second.json()
    assert first_body["replayed"] is False
    assert second_body["replayed"] is True
    assert {**second_body, "replayed": False} == first_body
    funder.refresh_from_db()
    page.refresh_from_db()
    assert funder.tuzis == Decimal("8")
    assert page.tuzi_total == 2


@pytest.mark.django_db(transaction=True)
def test_fund_rejects_amount_above_page_integer_capacity(
    api_client, creator_factory
):
    funder = creator_factory(tuzis=Decimal("3000000000"))
    page = _page(creator_factory())

    api_client.force_authenticate(user=funder)
    response = api_client.post(
        "/api/zpage/fund/",
        {"id": page.free2zaddr, "amount": 2147483648},
        format="json",
    )

    assert response.status_code == 400, response.content
    funder.refresh_from_db()
    page.refresh_from_db()
    assert funder.tuzis == Decimal("3000000000")
    assert page.tuzi_total == 0


@pytest.mark.django_db(transaction=True)
def test_fund_rejects_cumulative_page_integer_overflow(
    api_client, creator_factory
):
    funder = creator_factory(tuzis=Decimal("1000"))
    page = _page(creator_factory())
    page.tuzi_total = 2_147_483_647
    page.save(update_fields=["tuzi_total"])

    api_client.force_authenticate(user=funder)
    response = api_client.post(
        "/api/zpage/fund/",
        {"id": page.free2zaddr, "amount": 1},
        format="json",
    )

    assert response.status_code == 400, response.content
    funder.refresh_from_db()
    page.refresh_from_db()
    assert funder.tuzis == Decimal("1000")
    assert page.tuzi_total == 2_147_483_647


@pytest.mark.django_db(transaction=True)
def test_fund_owner_total_can_cross_the_old_numeric_limit(
    api_client, creator_factory
):
    funder = creator_factory(tuzis=Decimal("1000"))
    owner = creator_factory()
    page = _page(owner)
    page.tuzi_total = 99_999
    page.save(update_fields=["tuzi_total"])
    owner.cache_total()

    api_client.force_authenticate(user=funder)
    response = api_client.post(
        "/api/zpage/fund/", {"id": page.free2zaddr, "amount": 1}, format="json"
    )

    assert response.status_code == 200, response.content
    owner.refresh_from_db()
    assert owner.total == Decimal("100")


@pytest.mark.django_db(transaction=True)
def test_creator_cache_failure_cannot_rollback_funding(
    api_client, creator_factory, monkeypatch
):
    funder = creator_factory(tuzis=Decimal("10"))
    page = _page(creator_factory())

    callback_options = []

    def broken_cache(_creator, **options):
        callback_options.append(options)
        raise RuntimeError("simulated derived-cache failure")

    monkeypatch.setattr(type(funder), "cache_total", broken_cache)
    api_client.force_authenticate(user=funder)

    response = api_client.post(
        "/api/zpage/fund/", {"id": page.free2zaddr, "amount": 3}, format="json"
    )

    assert response.status_code == 200, response.content
    funder.refresh_from_db()
    page.refresh_from_db()
    assert funder.tuzis == Decimal("7")
    assert page.tuzi_total == 3
    assert callback_options == [{"nowait": True}]
