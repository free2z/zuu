"""
Single source of truth for how a 2Z ("tuzi") is priced.

A 2Z is worth **$0.01** on the platform. Everything else — the credit-card
charge and the live Zcash exchange rate — derives from that one fact so the two
payment paths stay consistent.

  * Card:  base price is $0.01/2Z, plus a fee of **max($0.50, 10% of base)** --
           the percentage rounded up to a whole cent. The $0.50 floor keeps a
           tiny purchase above Stripe's 2.9% + $0.30 cost; the card markup
           is independent of Zcash settlement. The floor
           and the percentage are equal at exactly 500 2Z, which is also the
           thinnest margin on the curve. Charges priced under the earlier
           5% + $1.00 shape remain interpretable only through the frozen legacy
           reconciliation helper below.
  * Zcash: actual received value uses the fresh processing-time price and
           the settlement spread (currently zero). A separate 10% buffer makes
           the displayed ZEC estimate conservative; it is never deducted from
           actual credits and never guarantees a minimum quantity.
"""
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, ROUND_DOWN

# --- Core value of a 2Z ------------------------------------------------------
# 1 USD buys this many 2Z at face value (2Z == $0.01).
TUZI_PER_USD: int = 100
USD_PER_TUZI: Decimal = Decimal('0.01')

# --- Zcash spread ------------------------------------------------------------
# Independent server parameters: display estimates and actual settlement.
# Changing an estimate never changes how a received note is credited.
ZEC_ESTIMATE_BUFFER: Decimal = Decimal('0.10')
ZEC_SETTLEMENT_SPREAD: Decimal = Decimal('0')
# Retained import name means actual settlement; estimates must opt in.
ZEC_SPREAD: Decimal = ZEC_SETTLEMENT_SPREAD

# --- Credit-card fees --------------------------------------------------------
# fee = max(CARD_MIN_FEE_CENTS, ceil(base_cents * CARD_PERCENT_FEE))
CARD_PERCENT_FEE: Decimal = Decimal('0.10')   # 10% processing markup
CARD_MIN_FEE_CENTS: int = 50                  # $0.50 minimum fee
CARD_CURRENCY: str = 'usd'

# --- Frozen legacy card fees -------------------------------------------------
# The pre-``card-v3`` fee shape (5% + $1.00). These constants exist ONLY so an
# already-settled charge stays interpretable: ``historical_card_quantity`` is
# the sole way to recover a quantity from a legacy cent amount, and it must not
# follow the live fee when that changes. Never reuse them for a new quote.
HISTORICAL_CARD_PRICING_VERSION: str = 'card-v1'
HISTORICAL_CARD_PERCENT_FEE: Decimal = Decimal('0.05')
HISTORICAL_CARD_FLAT_FEE_CENTS: int = 100

# Version every durable card quote and Stripe Session carries. It is recorded
# on the ``CheckoutIntent`` row before the Stripe Session exists, and
# settlement credits the quantity pinned on that row -- it never re-derives a
# quantity from the live formula. So the version is not a dispatch key for
# fulfillment; it is what makes a historical row readable under a later fee.
#
#   card-v1  5% + $1.00, percentage floored.
#   card-v2  5% + $1.00, percentage rounded up (deliberately still recoverable
#            by the pre-v2 floor inverse during that rolling deploy).
#   card-v3  max($0.50, 10%), percentage rounded up (this file, issue ).
CARD_PRICING_VERSION: str = 'card-v3'

# --- Aggregation knobs -------------------------------------------------------
# Reject any exchange whose quote deviates from the median by more than this
# fraction (rules out stale/glitched books before averaging).
OUTLIER_THRESHOLD: Decimal = Decimal('0.10')
# Minimum number of healthy sources that must respond to trust a fresh
# aggregate. Below this we refuse to record a new snapshot and keep serving the
# last good price (the spread covers short staleness).
MIN_SOURCES: int = 3
# Minimum number that must survive outlier rejection (agree within the band).
# Guards the pathological "few sources, all far apart" case.
MIN_AGREEING_SOURCES: int = 2
# A snapshot older than this (seconds) is considered stale. Public reads serve
# it with ``stale: true``; the non-web crediting path makes one bounded refresh
# attempt before falling back to the last good value.
SNAPSHOT_MAX_AGE_SECONDS: int = 120
# Settlement has the same freshness limit. An outage defers credit until a
# real price is available; the display buffer is not a stale-price allowance.
CREDIT_MAX_SNAPSHOT_AGE_SECONDS: int = SNAPSHOT_MAX_AGE_SECONDS

# Per-source HTTP timeout when polling exchanges.
SOURCE_TIMEOUT_SECONDS: float = 4.0
# Total wall-clock budget for one concurrent source-fetch batch. This is
# separate from SOURCE_TIMEOUT_SECONDS: requests applies the latter per socket
# inactivity interval, so it is not a bound on a whole response or batch.
SOURCE_BATCH_TIMEOUT_SECONDS: float = 15.0

# --- Cold-start bootstrap -----------------------------------------------------
# Absolute last-resort ZEC/USD guess, used ONLY for *display* when we have never
# recorded a real snapshot AND the exchanges are unreachable (e.g. a fresh
# deploy before the first refresh runs). It is never used to credit a purchase —
# crediting waits for a real price. Ops can override via the
# ``PRICING_BOOTSTRAP_ZEC_USD`` Django setting / env var; keep this roughly in
# the right ballpark so a cold UI shows a sane "estimated" number, not $25.
BOOTSTRAP_ZEC_USD: Decimal = Decimal('500')


def tuzis_per_zec(zec_usd: Decimal, spread: Decimal = ZEC_SPREAD) -> Decimal:
    """How many 2Z one ZEC buys, after the spread.

    tuzis_per_zec = zec_usd * (1 - spread) * TUZI_PER_USD
    """
    zec_usd = Decimal(zec_usd)
    rate = zec_usd * (Decimal(1) - Decimal(spread)) * TUZI_PER_USD
    # 2Z balances carry 3 decimal places; keep the rate at 4 for headroom.
    return rate.quantize(Decimal('0.0001'), rounding=ROUND_DOWN)


def zec_for_tuzis(tuzis, zec_usd: Decimal, spread: Decimal = ZEC_SPREAD) -> Decimal:
    """ZEC needed to buy `tuzis` 2Z at the current spread-adjusted rate."""
    rate = tuzis_per_zec(zec_usd, spread)
    if rate <= 0:
        return Decimal('0')
    # Round the ZEC amount UP (8dp) so the buyer never underpays for the memo.
    from decimal import ROUND_UP
    return (Decimal(tuzis) / rate).quantize(
        Decimal('0.00000001'), rounding=ROUND_UP
    )


@dataclass(frozen=True)
class CardQuote:
    tuzis: int
    amount_cents: int
    currency: str = CARD_CURRENCY
    pricing_version: str = CARD_PRICING_VERSION


def card_base_cents(quantity_tuzis: int) -> int:
    """Face value of `quantity_tuzis` 2Z in USD cents, before any fee."""
    return int(
        (Decimal(int(quantity_tuzis)) * USD_PER_TUZI * 100).to_integral_value()
    )


def card_fee_cents(quantity_tuzis: int) -> int:
    """The card fee in USD cents: ``max($0.50, ceil(10% of base))``.

    The percentage rounds UP to a whole cent, so we charge the stated
    percentage rather than silently shaving a fraction of a cent. The floor
    keeps a small purchase above Stripe's own 2.9% + $0.30: at 50 2Z the buyer
    pays $1.00, Stripe takes $0.33, and $0.17 is left over. Floor and
    percentage meet at exactly 500 2Z, the thinnest point on the curve
    (+$0.04).
    """
    base_cents = card_base_cents(quantity_tuzis)
    percentage_fee = (
        Decimal(base_cents) * CARD_PERCENT_FEE
    ).to_integral_value(rounding=ROUND_CEILING)
    return max(CARD_MIN_FEE_CENTS, int(percentage_fee))


def card_charge_cents(quantity_tuzis: int) -> int:
    """USD cents Stripe should charge for `quantity_tuzis` 2Z (base + fee)."""
    return card_base_cents(quantity_tuzis) + card_fee_cents(quantity_tuzis)


def card_quote(quantity_tuzis: int) -> CardQuote:
    """Return the complete authoritative card quote for an integer quantity."""
    if isinstance(quantity_tuzis, bool) or not isinstance(quantity_tuzis, int):
        raise ValueError('card quantity must be an integer')
    if quantity_tuzis < 1 or quantity_tuzis > 1_000_000:
        raise ValueError('card quantity is outside the supported range')
    return CardQuote(
        tuzis=quantity_tuzis,
        amount_cents=card_charge_cents(quantity_tuzis),
    )


def historical_card_quantity(amount_cents: int) -> int | None:
    """Recover an exact quantity from a pre-v2, floor-priced charge.

    Frozen at the legacy 5% + $1.00 shape on purpose: it is the only way to
    read an already-settled charge, so it must not follow the live fee.

    This exists only for already-created legacy Checkout Sessions and the
    historical reconciliation command. It returns ``None`` for a cent amount
    the old forward formula could never have produced; new fulfillment must
    consume the quantity from a durable ``CheckoutIntent`` instead.

    It is **not** a general inverse of the current formula and must never be
    applied to a card-v3 charge -- the two cent spaces overlap (a 151c v3
    charge for 101 2Z is also a well-formed legacy charge for 49 2Z). Both
    callers are scoped away from that: the webhook path only reaches here for a
    Session created at or before the immutable ``StripeCheckoutRollout``
    cutoff, and the reconciliation command only for an intent-less
    ``StripeTransaction`` older than ``--legacy-before``.
    """
    net = Decimal(int(amount_cents) - HISTORICAL_CARD_FLAT_FEE_CENTS)
    if net <= 0:
        return None
    candidate = int(
        (net / (Decimal(1) + HISTORICAL_CARD_PERCENT_FEE)).to_integral_value(
            rounding=ROUND_CEILING
        )
    )
    historical_amount = (
        int(Decimal(candidate) * (Decimal(1) + HISTORICAL_CARD_PERCENT_FEE))
        + HISTORICAL_CARD_FLAT_FEE_CENTS
    )
    return (
        candidate
        if 1 <= candidate <= 1_000_000 and historical_amount == amount_cents
        else None
    )
