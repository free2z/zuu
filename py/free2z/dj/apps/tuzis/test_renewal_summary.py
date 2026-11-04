"""Regression coverage for the aggregate renewal-affordability contract."""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.g12f.models import Subscription
from dj.apps.tuzis.views import (
    RENEWAL_CYCLE,
    RENEWAL_EXPIRY_CUTOFF,
    RENEWAL_HORIZON,
    RENEWAL_LEAD,
    _subscription_renewal_summary,
)


def _subscription(fan, star, now, *, days=30, max_price):
    return Subscription.objects.create(
        fan=fan,
        star=star,
        expires=now + timedelta(days=days),
        max_price=max_price,
    )


@pytest.mark.django_db
def test_summary_counts_only_chargeable_next_renewals(creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("50"))
    other_fan = creator_factory(tuzis=Decimal("1000"))

    chargeable_a = creator_factory(member_price=Decimal("40"))
    chargeable_b = creator_factory(member_price=Decimal("30"))
    over_ceiling = creator_factory(member_price=Decimal("100"))
    unpriced = creator_factory(member_price=Decimal("0"))  # free (: no NULL price)
    cancelled = creator_factory(member_price=Decimal("5"))
    expired = creator_factory(member_price=Decimal("5"))
    other_fan_star = creator_factory(member_price=Decimal("900"))

    _subscription(fan, chargeable_a, now, days=10, max_price=Decimal("40"))
    _subscription(fan, chargeable_b, now, days=20, max_price=Decimal("50"))
    _subscription(fan, over_ceiling, now, days=1, max_price=Decimal("10"))
    _subscription(fan, unpriced, now, days=2, max_price=Decimal("100"))
    _subscription(fan, cancelled, now, days=3, max_price=Decimal("0"))
    _subscription(fan, expired, now, days=-1, max_price=Decimal("5"))
    _subscription(
        other_fan,
        other_fan_star,
        now,
        days=1,
        max_price=Decimal("900"),
    )

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["status"] == "shortfall"
    assert summary["balance"] == Decimal("50")
    assert summary["total_upcoming"] == Decimal("70")
    assert summary["shortfall"] == Decimal("20")
    assert summary["next_renewal"] == now + timedelta(days=10)


@pytest.mark.django_db
def test_summary_reports_ok_when_balance_covers_next_renewal(creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("50"))
    star = creator_factory(member_price=Decimal("40"))

    _subscription(fan, star, now, max_price=Decimal("40"))

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["status"] == "ok"
    assert summary["total_upcoming"] == Decimal("40")
    assert summary["shortfall"] == Decimal("0")


@pytest.mark.django_db
def test_summary_returns_none_without_chargeable_subscriptions(creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("50"))
    unpriced = creator_factory(member_price=Decimal("0"))  # free (: no NULL price)
    over_ceiling = creator_factory(member_price=Decimal("100"))
    cancelled = creator_factory(member_price=Decimal("5"))
    expired = creator_factory(member_price=Decimal("5"))

    _subscription(fan, unpriced, now, max_price=Decimal("100"))
    _subscription(fan, over_ceiling, now, max_price=Decimal("10"))
    _subscription(fan, cancelled, now, max_price=Decimal("0"))
    _subscription(fan, expired, now, days=-1, max_price=Decimal("5"))

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary == {
        "status": "none",
        "balance": Decimal("50"),
        "total_upcoming": Decimal("0"),
        "shortfall": Decimal("0"),
        "next_renewal": None,
        "horizon_days": RENEWAL_HORIZON.days,
    }


# --------------------------------------------------------------------------
# The headline case the adversarial review blocked on: a subscription the
# renewal worker will REFUSE to charge (creator price above the fan's ceiling)
# must not appear in the amount we tell the fan they owe. Counting it does not
# just inflate a number — it asks the fan to buy 2Z that cannot possibly make
# the renewal happen, because no balance satisfies `max_price >= price`.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_over_ceiling_subscription_is_never_billed_to_the_fan(creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("20"))
    star = creator_factory(member_price=Decimal("100"))

    _subscription(fan, star, now, max_price=Decimal("10"))

    summary = _subscription_renewal_summary(fan, now=now)

    # Not "add 80 2Z" — there is nothing to add 2Z FOR.
    assert summary["status"] == "none"
    assert summary["total_upcoming"] == Decimal("0")
    assert summary["shortfall"] == Decimal("0")
    assert summary["next_renewal"] is None


@pytest.mark.django_db
def test_price_exactly_at_the_ceiling_is_chargeable(creator_factory):
    """The worker's guard is `max_price >= price`, so equality renews."""
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(member_price=Decimal("40"))

    _subscription(fan, star, now, max_price=Decimal("40"))

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["status"] == "ok"
    assert summary["total_upcoming"] == Decimal("40")


@pytest.mark.django_db
def test_one_cent_over_the_ceiling_is_not_chargeable(creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("1000"))
    star = creator_factory(member_price=Decimal("41"))

    _subscription(fan, star, now, max_price=Decimal("40"))

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["status"] == "none"
    assert summary["total_upcoming"] == Decimal("0")


@pytest.mark.django_db
def test_total_matches_what_the_renewal_worker_would_charge(creator_factory):
    """Parity with ``renew_subscription``'s static eligibility guards.

    The worker (``py/dj/apps/g12f/tasks.py``) charges when

        price is not None and sub.max_price >= price and fan.tuzis >= price

    after rejecting ``max_price <= 0`` (cancelled) and ``expires < now``
    (lapsed). The summary deliberately drops the per-row balance guard — the
    shared balance is what it is diagnosing — so parity is asserted against the
    other guards, over a population that lands on both sides of each one.

    A creator price of exactly 0 is the one documented divergence: the worker
    would "charge" it and the summary skips it, but it contributes 0 2Z either
    way, so the amount the fan is shown is identical.
    """
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("1"))

    rows = []
    for price, ceiling, days in [
        (Decimal("10"), Decimal("10"), 1),     # at the ceiling -> charged
        (Decimal("10"), Decimal("11"), 2),     # under -> charged
        (Decimal("12"), Decimal("11"), 3),     # over -> refused
        (Decimal("0"), Decimal("50"), 4),      # free  -> 0 2Z
        (Decimal("7"), Decimal("0"), 5),       # cancelled -> refused
        (Decimal("9"), Decimal("9"), -1),      # lapsed -> refused
        (Decimal("999"), Decimal("999"), 6),   # huge but eligible -> charged
    ]:
        star = creator_factory(member_price=price)
        rows.append(_subscription(fan, star, now, days=days, max_price=ceiling))

    expected = Decimal("0")
    for sub in rows:
        price = sub.star.member_price
        if not sub.max_price or sub.max_price <= 0:
            continue
        if sub.expires < now:
            continue
        if price is None or price <= 0:
            continue
        if sub.max_price < price:
            continue
        expected += price

    # 10 (at ceiling) + 10 (under ceiling) + 999 (eligible) — and nothing for
    # the over-ceiling, unpriced, cancelled or lapsed rows.
    assert expected == Decimal("1019")

    summary = _subscription_renewal_summary(fan, now=now)
    assert summary["total_upcoming"] == expected


@pytest.mark.django_db
def test_unpriced_subscription_contributes_zero_without_poisoning_the_rest(
    creator_factory,
):
    """A creator clearing their price must not blank the whole indicator."""
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("100"))
    priced = creator_factory(member_price=Decimal("40"))
    unpriced = creator_factory(member_price=Decimal("0"))  # free (: no NULL price)
    zero_priced = creator_factory(member_price=Decimal("0"))

    _subscription(fan, priced, now, max_price=Decimal("40"))
    _subscription(fan, unpriced, now, max_price=Decimal("100"))
    _subscription(fan, zero_priced, now, max_price=Decimal("100"))

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["status"] == "ok"
    assert summary["total_upcoming"] == Decimal("40")
    assert summary["shortfall"] == Decimal("0")


@pytest.mark.django_db
def test_fan_with_no_subscriptions_at_all_is_quiet(creator_factory):
    """No subscriptions must not render 'your balance covers 0 2Z'."""
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("500"))

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["status"] == "none"
    assert summary["total_upcoming"] == Decimal("0")
    assert summary["next_renewal"] is None


@pytest.mark.django_db
def test_summary_is_scoped_to_the_authenticated_fan(creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("100"))
    other = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("60"))
    another_star = creator_factory(member_price=Decimal("70"))

    _subscription(other, star, now, max_price=Decimal("60"))
    _subscription(fan, another_star, now, max_price=Decimal("70"))

    assert _subscription_renewal_summary(fan, now=now)["total_upcoming"] == (
        Decimal("70")
    )


# --------------------------------------------------------------------------
# End-to-end through the endpoint, so `ok` / `shortfall` / `none` are each
# proven over the serializer and not only over the helper.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_endpoint_reports_ok(api_client, creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("40"))
    _subscription(fan, star, now, max_price=Decimal("40"))
    api_client.force_authenticate(user=fan)

    response = api_client.get("/api/tuzis/my-subscriptions-summary")

    assert response.status_code == 200
    assert response.data["status"] == "ok"
    assert Decimal(response.data["total_upcoming"]) == Decimal("40")
    assert Decimal(response.data["shortfall"]) == Decimal("0")
    assert response.data["next_renewal"] is not None


@pytest.mark.django_db
def test_endpoint_reports_shortfall_across_subscriptions(
    api_client, creator_factory,
):
    """Two individually affordable renewals that together are not.

    This is the whole point of: a per-card check passes both.
    """
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("60"))
    star_a = creator_factory(member_price=Decimal("50"))
    star_b = creator_factory(member_price=Decimal("50"))
    _subscription(fan, star_a, now, days=5, max_price=Decimal("50"))
    _subscription(fan, star_b, now, days=9, max_price=Decimal("50"))
    api_client.force_authenticate(user=fan)

    response = api_client.get("/api/tuzis/my-subscriptions-summary")

    assert response.status_code == 200
    assert response.data["status"] == "shortfall"
    assert Decimal(response.data["total_upcoming"]) == Decimal("100")
    assert Decimal(response.data["shortfall"]) == Decimal("40")


@pytest.mark.django_db
def test_endpoint_reports_none_for_only_unchargeable_rows(
    api_client, creator_factory,
):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("5"))
    over_ceiling = creator_factory(member_price=Decimal("900"))
    _subscription(fan, over_ceiling, now, max_price=Decimal("10"))
    api_client.force_authenticate(user=fan)

    response = api_client.get("/api/tuzis/my-subscriptions-summary")

    assert response.status_code == 200
    assert response.data["status"] == "none"
    assert Decimal(response.data["total_upcoming"]) == Decimal("0")
    assert Decimal(response.data["shortfall"]) == Decimal("0")
    assert response.data["next_renewal"] is None


# --------------------------------------------------------------------------
# The horizon. `Subscription.extend()` sets expires to at least `now + 30d`,
# so within one 30-day window each subscription is charged AT MOST ONCE — that
# is what makes the sum a statement rather than a projection. An unbounded
# "one next renewal each" sum overstates affordability whenever two expiries
# are more than a cycle apart. (Raised by the human review and re-demonstrated
# by the codex review of this PR.)
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_renewal_beyond_one_cycle_is_not_counted_as_covered(creator_factory):
    """The exact sequence the unbounded sum called 'ok' and got wrong.

    Balance 20. Sub A costs 10 and expires tomorrow; prepaid sub B costs 10 and
    expires in 61 days. Unbounded, the total is 20 and the page says "covered".
    In reality A renews tomorrow AND again ~31 days later, spending the whole
    20 before B is ever charged, and B lapses.
    """
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("20"))
    star_a = creator_factory(member_price=Decimal("10"))
    star_b = creator_factory(member_price=Decimal("10"))

    _subscription(fan, star_a, now, days=1, max_price=Decimal("10"))
    _subscription(fan, star_b, now, days=61, max_price=Decimal("10"))

    summary = _subscription_renewal_summary(fan, now=now)

    # Only A comes due inside the window, and 10 <= 20 really is covered.
    assert summary["total_upcoming"] == Decimal("10")
    assert summary["status"] == "ok"
    assert summary["horizon_days"] == RENEWAL_HORIZON.days == 29


@pytest.mark.django_db
def test_the_expiry_cutoff_is_the_horizon_plus_the_workers_lead(
    creator_factory,
):
    """Charges, not expiries, are what the window is measured in.

    `renew_subscription` fires at ``expires - RENEWAL_LEAD``, so a charge lands
    inside the advertised ``RENEWAL_HORIZON`` iff the row expires within
    ``HORIZON + LEAD`` — exactly one billing cycle.
    """
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("1000"))
    inside = creator_factory(member_price=Decimal("7"))
    on_the_edge = creator_factory(member_price=Decimal("11"))
    outside = creator_factory(member_price=Decimal("500"))

    assert RENEWAL_EXPIRY_CUTOFF == timedelta(days=30)

    _subscription(fan, inside, now, days=29, max_price=Decimal("7"))
    _subscription(fan, on_the_edge, now, days=30, max_price=Decimal("11"))
    _subscription(fan, outside, now, days=31, max_price=Decimal("500"))

    summary = _subscription_renewal_summary(fan, now=now)

    # Inclusive at exactly one cycle; the day-31 renewal is charged on day 30,
    # past the 29-day window this endpoint speaks for.
    assert summary["total_upcoming"] == Decimal("18")


@pytest.mark.django_db
def test_the_horizon_leaves_room_for_the_24h_renewal_lead(creator_factory):
    """The bug a naive 30-day window has, pinned.

    A subscription expiring in 12 hours is charged NOW (attempts start 24h
    early). `extend()` then moves expiry to ~day 30.5, and the following charge
    is attempted on ~day 29.5. Advertising 30 days would promise to cover both
    debits while counting only one. 29 days cannot: the second attempt is
    always at least `CYCLE - LEAD` after the first, i.e. outside the window.
    """
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("15"))
    star = creator_factory(member_price=Decimal("10"))

    sub = _subscription(fan, star, now, days=1, max_price=Decimal("10"))
    sub.expires = now + timedelta(hours=12)
    sub.save()

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["total_upcoming"] == Decimal("10")
    assert summary["status"] == "ok"

    # The second charge for this subscription. Its attempt time must fall
    # OUTSIDE the window the copy names, or "covered" was a lie by one charge.
    second_charge_at = (
        sub.expires + RENEWAL_CYCLE - RENEWAL_LEAD
    )
    assert second_charge_at > now + RENEWAL_HORIZON


@pytest.mark.django_db
def test_only_far_future_renewals_are_a_quiet_page(creator_factory):
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("1"))
    star = creator_factory(member_price=Decimal("900"))

    _subscription(fan, star, now, days=45, max_price=Decimal("900"))

    summary = _subscription_renewal_summary(fan, now=now)

    # Nothing is due yet, so there is nothing to warn about — and in
    # particular no "short by 899 2Z" for a charge that is over a month away.
    assert summary["status"] == "none"
    assert summary["total_upcoming"] == Decimal("0")


@pytest.mark.django_db
def test_endpoint_publishes_the_window_it_measured(api_client, creator_factory):
    """The client must never hardcode the horizon the server used."""
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("40"))
    _subscription(fan, star, now, days=3, max_price=Decimal("40"))
    api_client.force_authenticate(user=fan)

    response = api_client.get("/api/tuzis/my-subscriptions-summary")

    assert response.status_code == 200
    assert response.data["horizon_days"] == RENEWAL_HORIZON.days


@pytest.mark.django_db
def test_the_balance_is_read_with_the_subscriptions_not_before_them(
    creator_factory,
):
    """A charge that lands between authentication and this query.

    `request.user` is loaded during authentication. If the balance came from
    that instance, a renewal committing in between would be compared as a
    PRE-charge balance against a POST-charge subscription set — the exact
    false "covered" this endpoint exists to prevent. Simulated by handing the
    helper a stale in-memory fan.
    """
    now = timezone.now()
    fan = creator_factory(tuzis=Decimal("100"))
    star = creator_factory(member_price=Decimal("60"))
    _subscription(fan, star, now, days=5, max_price=Decimal("60"))

    # The renewal of some other subscription drains the account after this
    # request's `fan` object was loaded.
    type(fan).objects.filter(pk=fan.pk).update(tuzis=Decimal("40"))
    assert fan.tuzis == Decimal("100")  # the stale in-memory copy

    summary = _subscription_renewal_summary(fan, now=now)

    assert summary["balance"] == Decimal("40")
    assert summary["status"] == "shortfall"
    assert summary["shortfall"] == Decimal("20")


@pytest.mark.django_db
def test_the_horizon_is_derived_from_the_model_billing_period():
    """The window may never be a literal that can drift from `extend()`."""
    from dj.apps.g12f.models.creator import SUBSCRIPTION_PERIOD

    assert RENEWAL_CYCLE is SUBSCRIPTION_PERIOD
    assert RENEWAL_HORIZON == SUBSCRIPTION_PERIOD - RENEWAL_LEAD
    assert RENEWAL_EXPIRY_CUTOFF == SUBSCRIPTION_PERIOD
