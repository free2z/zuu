"""Pure pricing math — no DB required."""
from decimal import Decimal, ROUND_HALF_UP

import pytest

from dj.apps.pricing import constants as c


class TestTuzisPerZec:
    def test_issue_example_1000_usd_10pct_spread(self):
        # ZEC at $1000, 10% spread -> 1 ZEC buys 90,000 2Z.
        assert c.tuzis_per_zec(Decimal('1000')) == Decimal('100000.0000')
        assert c.tuzis_per_zec(Decimal('1000'), c.ZEC_ESTIMATE_BUFFER) == Decimal('90000.0000')

    def test_no_spread_is_face_value(self):
        # 2Z == $0.01, so with no spread $50 ZEC -> 5000 2Z.
        assert c.tuzis_per_zec(Decimal('50'), spread=Decimal('0')) == Decimal('5000.0000')

    def test_custom_spread(self):
        # 20% spread on $10 -> 10 * 0.8 * 100 = 800.
        assert c.tuzis_per_zec(Decimal('10'), spread=Decimal('0.20')) == Decimal('800.0000')

    def test_rate_scales_with_price(self):
        low = c.tuzis_per_zec(Decimal('100'))
        high = c.tuzis_per_zec(Decimal('200'))
        assert high == low * 2


class TestZecForTuzis:
    def test_round_trip_at_1000(self):
        # 90,000 2Z should cost ~1 ZEC when ZEC=$1000 (10% spread).
        assert c.zec_for_tuzis(90000, Decimal('1000'), c.ZEC_ESTIMATE_BUFFER) == Decimal('1.00000000')

    def test_rounds_up_so_buyer_never_underpays(self):
        # A quantity that doesn't divide evenly rounds the ZEC amount up.
        zec = c.zec_for_tuzis(1, Decimal('1000'), c.ZEC_ESTIMATE_BUFFER)
        # 1 / 90000 = 0.0000111... -> rounded up at 8dp
        assert zec == Decimal('0.00001112')


# (quantity, base_cents, fee_cents, charge_cents) -- the owner's card-v3 table.
# Fee is max($0.50, ceil(10% of base)); base is quantity, since 2Z == $0.01.
CARD_V3_TIERS = [
    (1, 1, 50, 51),
    (2, 2, 50, 52),
    (50, 50, 50, 100),
    (100, 100, 50, 150),
    (499, 499, 50, 549),
    (500, 500, 50, 550),          # floor and 10% are equal here
    (501, 501, 51, 552),          # first quantity the percentage exceeds the floor
    (1_000, 1_000, 100, 1_100),   # the owner's worked example: 1000 2Z bills at $11
    (2_000, 2_000, 200, 2_200),
    (100_000, 100_000, 10_000, 110_000),
    (1_000_000, 1_000_000, 100_000, 1_100_000),
]

# Stripe's US card cost, in cents, for a charge of `cents`: 2.9% + $0.30.
def stripe_cost_cents(cents: int) -> Decimal:
    return (Decimal(cents) * Decimal("0.029")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    ) + Decimal(30)


class TestCardCharge:
    @pytest.mark.parametrize(
        ("quantity", "base", "fee", "charge"),
        CARD_V3_TIERS,
        ids=[str(t[0]) for t in CARD_V3_TIERS],
    )
    def test_card_v3_tier_bills_exact_cents(self, quantity, base, fee, charge):
        assert c.card_base_cents(quantity) == base
        assert c.card_fee_cents(quantity) == fee
        assert c.card_charge_cents(quantity) == charge
        assert base + fee == charge

    @pytest.mark.parametrize(
        ("quantity", "base", "fee", "charge"),
        CARD_V3_TIERS,
        ids=[str(t[0]) for t in CARD_V3_TIERS],
    )
    def test_every_tier_clears_stripes_own_cost(
        self, quantity, base, fee, charge
    ):
        """The point of the $0.50 floor: never sell 2Z below what Stripe takes.

        Margin is what is left after Stripe's cut and after honouring the
        buyer's 2Z at face value.
        """
        margin = Decimal(charge) - stripe_cost_cents(charge) - Decimal(base)
        assert margin > 0, f"{quantity} 2Z loses money"

    def test_the_thinnest_margin_on_the_whole_curve_is_still_positive(self):
        """500 2Z is where the floor stops covering us and 10% takes over."""
        worst = min(
            (
                Decimal(c.card_charge_cents(q))
                - stripe_cost_cents(c.card_charge_cents(q))
                - Decimal(c.card_base_cents(q))
            )
            for q in range(1, 2_001)
        )
        assert worst > 0
        # ~4 cents at the crossover, and that is the floor of the curve.
        assert worst == Decimal("4.05")

    def test_floor_binds_below_the_crossover_and_percentage_above(self):
        assert all(c.card_fee_cents(q) == 50 for q in range(1, 501))
        assert all(c.card_fee_cents(q) > 50 for q in range(501, 1_001))

    def test_percentage_rounds_up_so_we_never_shave_a_fraction_of_a_cent(self):
        # 5,001 base cents -> 10% is 500.1c, which must bill as 501c not 500c.
        assert c.card_fee_cents(5_001) == 501
        assert c.card_charge_cents(5_001) == 5_502

    @pytest.mark.parametrize(
        ("quantity", "base", "fee", "charge"),
        CARD_V3_TIERS,
        ids=[str(t[0]) for t in CARD_V3_TIERS],
    )
    def test_charge_and_credit_round_trip_exactly(
        self, quantity, base, fee, charge
    ):
        """: what we bill and what we credit must never disagree.

        Quantity 1 is the case that regressed: it was charged 101c and credited
        0 2Z. There is no lossy inverse now -- the quote carries the exact
        integer quantity, and settlement credits that pinned value -- so this
        asserts the identity the whole card path rests on.
        """
        quote = c.card_quote(quantity)
        assert quote.tuzis == quantity
        assert quote.amount_cents == charge
        assert quote.amount_cents == c.card_charge_cents(quote.tuzis)

    def test_charge_and_credit_round_trip_over_the_full_allowed_range(self):
        for q in range(1, 1_000_001):
            quote = c.card_quote(q)
            assert quote.tuzis == q
            assert quote.amount_cents == c.card_charge_cents(q)
            assert quote.amount_cents > q  # never credit more value than billed

    def test_quote_carries_the_versioned_full_charge(self):
        quote = c.card_quote(2000)
        assert quote.tuzis == 2000
        assert quote.amount_cents == 2200
        assert quote.currency == "usd"
        assert quote.pricing_version == "card-v3"

    @pytest.mark.parametrize("quantity", [0, -1, 1_000_001])
    def test_quote_refuses_a_quantity_outside_the_supported_range(
        self, quantity
    ):
        with pytest.raises(ValueError):
            c.card_quote(quantity)


class TestFrozenLegacyInverse:
    """``card-v1`` reconciliation must not move when the live fee moves."""

    def test_legacy_constants_are_pinned_to_the_pre_v3_shape(self):
        assert c.HISTORICAL_CARD_PRICING_VERSION == "card-v1"
        assert c.HISTORICAL_CARD_PERCENT_FEE == Decimal("0.05")
        assert c.HISTORICAL_CARD_FLAT_FEE_CENTS == 100

    def test_the_legacy_inverse_does_not_track_the_live_fee(self):
        """If it read CARD_PERCENT_FEE/CARD_MIN_FEE_CENTS this would break.

        205c is a real settled 100-2Z charge under 5% + $1.00. Under the live
        card-v3 fee 100 2Z bills 150c, so any helper that followed the live
        constants would fail to recover 100 here.
        """
        assert c.historical_card_quantity(205) == 100
        assert c.card_charge_cents(100) == 150

    @pytest.mark.parametrize(
        ("quantity", "historical_cents"),
        [(1, 101), (2, 102), (19, 119), (20, 121), (21, 122),
         (100, 205), (2000, 2200)],
    )
    def test_historical_floor_charge_has_one_exact_quantity(
        self, quantity, historical_cents
    ):
        assert c.historical_card_quantity(historical_cents) == quantity

    @pytest.mark.parametrize("cents", [100, 120, 141, 999_999_999])
    def test_historical_inverse_rejects_amounts_old_pricing_never_created(
        self, cents
    ):
        assert c.historical_card_quantity(cents) is None

    def test_a_card_v3_charge_must_never_be_read_by_the_legacy_inverse(self):
        """The two cent spaces overlap; only the callers' scoping keeps them apart.

        101 2Z bills 151c under card-v3. 151c is *also* a well-formed legacy
        charge for 49 2Z, so the inverse answers 49 -- a wrong credit if it were
        ever applied to a v3 charge. Both callers are scoped away from that: the
        webhook only takes the legacy branch for a Session created at or before
        the immutable StripeCheckoutRollout cutoff, and reconciliation only for
        an intent-less StripeTransaction older than --legacy-before. This pins
        the hazard so the scoping is never quietly removed.
        """
        assert c.card_charge_cents(101) == 151
        assert c.historical_card_quantity(151) == 49
