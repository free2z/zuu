"""A member price of 0 is a FREE membership. MONEY PATH.

Owner decision (2026-10-06): subscribing to a 0-price creator grants the same
30 days of member access as a paid membership and moves NO 2Z -- no ledger
``Transfer``, no balance change on either side, at any fan balance including
zero. Every idempotency/replay rule of the paid path still holds, and a price
change in either direction is answered by the existing exact-price contract
(409 ``price_changed``), never by a charge the fan did not confirm.

Real Postgres; nothing mocked.
"""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator, Subscription
from dj.apps.ledger.models import Transfer
from dj.apps.tuzis.test_safe_money_contracts import (
    balance,
    confirmed_subscribe,
    contract_key,
    legacy_subscribe,
)


def _status(fan, star):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=fan.pk))
    return client.get(f"/api/tuzis/subscription-status/{star.username}")


@pytest.mark.django_db
def test_confirmed_free_subscribe_grants_30_days_and_moves_no_2z(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("0"))
    star = creator_factory(tuzis=Decimal("5"), member_price=Decimal("0"))
    transfers = Transfer.objects.count()

    response = confirmed_subscribe(fan, star, key="free-confirmed", price="0")

    assert response.status_code == 200, response.content
    assert response.data["charged"] is True
    assert response.data["replayed"] is False
    assert Decimal(response.data["balance"]) == Decimal("0")
    sub = Subscription.objects.get(fan=fan, star=star)
    assert sub.expires > timezone.now() + timedelta(days=29)
    # The free follow carries no recurring consent: a later price rise can
    # never charge it automatically (max_price 0 is cancellation).
    assert sub.max_price == Decimal("0")
    assert balance(fan) == Decimal("0")
    assert balance(star) == Decimal("5")
    assert Transfer.objects.count() == transfers

    # Same key again: a replay, not a second extension.
    expires = sub.expires
    again = confirmed_subscribe(fan, star, key="free-confirmed", price="0")
    assert again.status_code == 200, again.content
    assert again.data["replayed"] is True
    sub.refresh_from_db()
    assert sub.expires == expires
    assert Transfer.objects.count() == transfers


@pytest.mark.django_db
def test_legacy_free_subscribe_grants_membership_and_moves_no_2z(
    creator_factory,
):
    fan = creator_factory(tuzis=Decimal("0"))
    star = creator_factory(tuzis=Decimal("0"), member_price=Decimal("0"))
    transfers = Transfer.objects.count()
    key = contract_key("free-legacy")

    response = legacy_subscribe(fan, star, raw_key=key)

    assert response.status_code == 200, response.content
    assert response.data["charged"] is True
    assert balance(fan) == Decimal("0")
    assert balance(star) == Decimal("0")
    assert Transfer.objects.count() == transfers
    status = _status(fan, star)
    assert status.status_code == 200, status.content
    assert status.data["active"] is True
    assert status.data["current_price"] == "0"

    replay = legacy_subscribe(fan, star, raw_key=key)
    assert replay.status_code == 200, replay.content
    assert replay.data["replayed"] is True
    assert Transfer.objects.count() == transfers


@pytest.mark.django_db
def test_free_renewal_by_hand_tops_up_without_charging(creator_factory):
    """Following again near the end tops access back up to 30 days, free."""
    fan = creator_factory(tuzis=Decimal("3"))
    star = creator_factory(member_price=Decimal("0"))
    assert confirmed_subscribe(
        fan, star, key="free-1", price="0").status_code == 200
    sub = Subscription.objects.get(fan=fan, star=star)
    # Near the end of the free month, past the debounce window.
    Subscription.objects.filter(pk=sub.pk).update(
        expires=timezone.now() + timedelta(days=1),
        last_charged_at=timezone.now() - timedelta(days=29))

    second = confirmed_subscribe(fan, star, key="free-2", price="0")

    assert second.status_code == 200, second.content
    assert second.data["charged"] is True
    sub.refresh_from_db()
    assert sub.expires > timezone.now() + timedelta(days=29)
    assert balance(fan) == Decimal("3")


@pytest.mark.django_db
def test_free_follows_do_not_stack_into_banked_paid_access(creator_factory):
    """Codex review: with no cost per request, stacking free months would let
    a fan bank years of access while the price is 0 and keep it after the
    creator starts charging. Free never extends past now + 30 days."""
    fan = creator_factory(tuzis=Decimal("0"))
    star = creator_factory(member_price=Decimal("0"))
    for i in range(5):
        Subscription.objects.filter(fan=fan, star=star).update(
            last_charged_at=timezone.now() - timedelta(minutes=5))
        response = confirmed_subscribe(
            fan, star, key=f"bank-{i}", price="0")
        assert response.status_code == 200, response.content

    sub = Subscription.objects.get(fan=fan, star=star)
    assert sub.expires < timezone.now() + timedelta(days=31)


@pytest.mark.django_db
def test_price_rise_after_a_free_confirmation_is_refused_not_charged(
    creator_factory,
):
    """0 -> N: a fan who confirmed "free" is never charged N."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("0"))
    Creator.objects.filter(pk=star.pk).update(member_price=10)

    response = confirmed_subscribe(fan, star, key="free-then-10", price="0")

    assert response.status_code == 409, response.content
    assert response.data["code"] == "price_changed"
    assert response.data["current_price"] == "10"
    assert balance(fan) == Decimal("100")
    assert not Subscription.objects.filter(
        fan=fan, star=star, expires__gt=timezone.now()).exists()


@pytest.mark.django_db
def test_price_drop_to_free_after_a_paid_confirmation_is_refused(
    creator_factory,
):
    """N -> 0: the exact-price contract answers 409; nothing moves."""
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("10"))
    Creator.objects.filter(pk=star.pk).update(member_price=0)

    response = confirmed_subscribe(fan, star, key="10-then-free", price="10")

    assert response.status_code == 409, response.content
    assert response.data["code"] == "price_changed"
    assert response.data["current_price"] == "0"
    assert balance(fan) == Decimal("100")


@pytest.mark.django_db
def test_negative_expected_price_is_refused(creator_factory):
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("0"))

    response = confirmed_subscribe(fan, star, key="negative", price="-1")

    assert response.status_code == 400, response.content
    assert balance(fan) == Decimal("100")
    assert not Subscription.objects.filter(fan=fan, star=star).exists()


@pytest.mark.django_db
def test_a_paid_subscriber_keeps_free_renewals_after_a_price_drop(
    creator_factory,
):
    """N -> 0 for an existing subscriber: their ceiling still covers 0, so the
    renewal worker extends them for free instead of failing."""
    from dj.apps.g12f.tasks import renew_subscription

    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("10"))
    sub = Subscription.objects.create(
        fan=fan, star=star, max_price=Decimal("10"),
        expires=timezone.now() + timedelta(hours=1),
    )
    Creator.objects.filter(pk=star.pk).update(member_price=0)
    transfers = Transfer.objects.count()

    renew_subscription(subscription_id=sub.pk)

    sub.refresh_from_db()
    assert sub.expires > timezone.now() + timedelta(days=29)
    assert balance(fan) == Decimal("100")
    assert Transfer.objects.count() == transfers
