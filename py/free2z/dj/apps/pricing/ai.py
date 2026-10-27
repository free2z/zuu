"""The AI cost-plus formula, ported bit-for-bit from zuu ``f2z-ai-proto``.

This is the Python twin of ``rs/crates/f2z-ai-proto/src/pricing.rs`` and of the
SQL ``ledger.price`` described in ``docs/tuzis/ledger-v2.md`` §9. The three
must agree on every input, and the crate's JSON fixtures — vendored under
``dj/apps/pricing/tests/fixtures/f2z_ai_proto/`` — are the oracle that proves
it (``tests/test_ai_pricing_parity.py`` runs every case in them).

Two steps, exactly as the crate::

    1. meter   cost_nusd = ceil( Σ quantity × unit price )          whole nano-USD
    2. price   p     = cost_usd × 100 × (1 + platform_margin)       2Z
               d     = p × dev_markup                               2Z
               total = max(min_charge, ceil(p + d))                 whole 2Z, ONE ceil
               provider  = ceil(cost)                  milli-2Z
               developer = floor(d)                    milli-2Z
               platform  = total − provider − developer  milli-2Z

**Integers only.** Python ints are arbitrary precision, so the crate's ``u128``
exact numerators are reproduced without overflow; there is no ``float`` and no
``Decimal`` anywhere on the pricing path. The crate reports an ``Overflow``
error when a value leaves ``u64``; this port raises:class:`PricingOverflow`
at the same boundaries, so an input the crate refuses is refused here too
rather than being priced by one side only.

**Nothing in Django charges through this yet.** ``AIModel.get_tuzi_price`` is
deliberately unchanged in  — this module exists for the rate card, the
future signed catalogue, and the ledger's settle parity tests.

The one deliberate extension over the crate's catalogue schema 1 is the
5-minute / 1-hour cache-write split (zuu#1059)::class:`ModelPrices` carries
both, and:meth:`ModelPrices.from_crate` maps schema 1's single
``cache_write_nusd_per_mtok`` onto the 5-minute price (the TTL a bare
``cache_control`` gets). A 1-hour write is metered only from
``Usage.cache_write_1h_tokens``, which schema 1 has no member for and is
therefore always 0 on crate input — so every crate fixture prices identically.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
from decimal import Decimal

# 1 2Z = $0.01 = 10^7 nano-USD.
NUSD_PER_2Z = 10_000_000
# nano-USD in one milli-2Z.
NUSD_PER_MILLI_2Z = 10_000
# milli-2Z in one 2Z.
MILLI_PER_2Z = 1_000
# Token prices are quoted per million tokens.
TOKENS_PER_PRICE_UNIT = 1_000_000
# 10 000 bps = 100 %.
BPS_DENOMINATOR = 10_000
_BPS_SQUARED = BPS_DENOMINATOR * BPS_DENOMINATOR

# The crate's integer widths. A value outside them is an Overflow there, so it
# is one here: parity includes agreeing on what cannot be priced.
U32_MAX = (1 << 32) - 1
U64_MAX = (1 << 64) - 1

# nano-USD in one USD.
NUSD_PER_USD = 1_000_000_000


class PricingOverflow(ArithmeticError):
    """An input or result does not fit the crate's integer types."""


def _u32(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")
    if value < 0:
        raise ValueError(f"{name} must be >= 0, got {value}")
    if value > U32_MAX:
        raise PricingOverflow(f"{name} does not fit u32: {value}")
    return value


def _u64(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")
    if value < 0:
        raise ValueError(f"{name} must be >= 0, got {value}")
    if value > U64_MAX:
        raise PricingOverflow(f"{name} does not fit u64: {value}")
    return value


def _ceil_div(n: int, d: int) -> int:
    # Both operands are non-negative here; -(-n // d) is exact integer ceil.
    return -(-n // d)


@dataclass(frozen=True)
class ModelPrices:
    """Per-model prices. Token prices are nano-USD per MILLION tokens; image
    and tool prices are nano-USD per image / per tool call (crate units)."""

    input_nusd_per_mtok: int = 0
    cached_input_nusd_per_mtok: int = 0
    cache_write_5m_nusd_per_mtok: int = 0
    cache_write_1h_nusd_per_mtok: int = 0
    output_nusd_per_mtok: int = 0
    image_nusd: int = 0
    tool_call_nusd: int = 0

    def __post_init__(self):
        for f in fields(self):
            _u64(getattr(self, f.name), f.name)

    # Schema-1 member names of the crate's ModelPrices, in the crate's order.
    CRATE_V1_MEMBERS = (
        "input_nusd_per_mtok",
        "cached_input_nusd_per_mtok",
        "cache_write_nusd_per_mtok",
        "output_nusd_per_mtok",
        "image_nusd",
        "tool_call_nusd",
    )

    @classmethod
    def from_crate(cls, prices: dict) -> "ModelPrices":
        """Decode the crate's schema-1 ``ModelPrices`` JSON object.

        Mirrors ``#[serde(deny_unknown_fields)]``: an unknown member is refused
        rather than silently priced at zero, and every member is required.
        """
        unknown = set(prices) - set(cls.CRATE_V1_MEMBERS)
        if unknown:
            raise ValueError(f"unknown ModelPrices member(s): {sorted(unknown)}")
        missing = set(cls.CRATE_V1_MEMBERS) - set(prices)
        if missing:
            raise ValueError(f"missing ModelPrices member(s): {sorted(missing)}")
        return cls(
            input_nusd_per_mtok=prices["input_nusd_per_mtok"],
            cached_input_nusd_per_mtok=prices["cached_input_nusd_per_mtok"],
            cache_write_5m_nusd_per_mtok=prices["cache_write_nusd_per_mtok"],
            cache_write_1h_nusd_per_mtok=0,
            output_nusd_per_mtok=prices["output_nusd_per_mtok"],
            image_nusd=prices["image_nusd"],
            tool_call_nusd=prices["tool_call_nusd"],
        )


@dataclass(frozen=True)
class Usage:
    """A call's usage vector (crate ``chat::Usage``, plus the 1h cache-write
    split). ``reasoning_tokens`` is informational: it is already inside
    ``output_tokens`` and is never priced a second time."""

    input_tokens: int = 0
    cached_input_tokens: int = 0
    # The crate's ``cache_write_tokens``: writes at the default (5-minute) TTL.
    cache_write_tokens: int = 0
    # 1-hour-TTL cache writes (zuu#1059). Not in crate schema 1.
    cache_write_1h_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    images: int = 0
    tool_calls: int = 0

    def __post_init__(self):
        for f in fields(self):
            _u64(getattr(self, f.name), f.name)

    CRATE_V1_MEMBERS = (
        "input_tokens",
        "cached_input_tokens",
        "cache_write_tokens",
        "output_tokens",
        "reasoning_tokens",
        "images",
        "tool_calls",
    )

    @classmethod
    def from_crate(cls, usage: dict) -> "Usage":
        unknown = set(usage) - set(cls.CRATE_V1_MEMBERS)
        if unknown:
            raise ValueError(f"unknown Usage member(s): {sorted(unknown)}")
        return cls(**{name: usage.get(name, 0) for name in cls.CRATE_V1_MEMBERS})


@dataclass(frozen=True)
class Charge:
    """A priced call, in milli-2Z. ``total_milli`` is a multiple of 1000 and
    ``provider + developer + platform == total``."""

    total_milli: int
    provider_milli: int
    developer_milli: int
    platform_milli: int

    @property
    def total_2z(self) -> int:
        return self.total_milli // MILLI_PER_2Z


def metered_cost_nusd(usage: Usage, prices: ModelPrices) -> int:
    """Step 1: the cost of ``usage`` at ``prices``, rounded UP to whole nUSD."""
    per_mtok = (
        (usage.input_tokens, prices.input_nusd_per_mtok),
        (usage.cached_input_tokens, prices.cached_input_nusd_per_mtok),
        (usage.cache_write_tokens, prices.cache_write_5m_nusd_per_mtok),
        (usage.cache_write_1h_tokens, prices.cache_write_1h_nusd_per_mtok),
        (usage.output_tokens, prices.output_nusd_per_mtok),
    )
    per_unit = (
        (usage.images, prices.image_nusd),
        (usage.tool_calls, prices.tool_call_nusd),
    )
    # Accumulate in 10^-6 nUSD: tokens × (nUSD / 10^6 tokens), exactly.
    micro_nusd = 0
    for quantity, price in per_mtok:
        micro_nusd += quantity * price
    for quantity, price in per_unit:
        micro_nusd += quantity * price * TOKENS_PER_PRICE_UNIT
    # The crate's accumulator is u128; a sum beyond it is an Overflow there.
    if micro_nusd >= 1 << 128:
        raise PricingOverflow("metered cost accumulator does not fit u128")
    return _u64(_ceil_div(micro_nusd, TOKENS_PER_PRICE_UNIT), "cost_nusd")


def price_nusd(
    cost_nusd: int,
    platform_margin_bps: int,
    dev_markup_bps: int,
    min_charge_2z: int,
) -> Charge:
    """Step 2: price a metered cost in nano-USD. One ``ceil``, at the total."""
    c = _u64(cost_nusd, "cost_nusd")
    m = _u32(platform_margin_bps, "platform_margin_bps")
    k = _u32(dev_markup_bps, "dev_markup_bps")
    minimum = _u64(min_charge_2z, "min_charge_2z")

    one_plus_m = BPS_DENOMINATOR + m
    one_plus_k = BPS_DENOMINATOR + k

    # p + d = c·(1+m)·(1+k), in nUSD × BPS².
    p_plus_d = c * one_plus_m * one_plus_k
    if p_plus_d >= 1 << 128:
        raise PricingOverflow("p + d does not fit u128")
    # THE rounding: ceil to whole 2Z, over the exact numerator.
    raw_2z = _ceil_div(p_plus_d, _BPS_SQUARED * NUSD_PER_2Z)
    total_2z = max(raw_2z, minimum)
    total_milli = total_2z * MILLI_PER_2Z

    # provider = ceil(c) in milli-2Z.
    provider_milli = _ceil_div(c, NUSD_PER_MILLI_2Z)
    # developer = floor(d) in milli-2Z, d = c·(1+m)·k (nUSD × BPS²).
    developer_milli = (c * one_plus_m * k) // (_BPS_SQUARED * NUSD_PER_MILLI_2Z)
    platform_milli = total_milli - provider_milli - developer_milli
    if platform_milli < 0:  # the crate's checked_sub; unreachable for m >= 0
        raise PricingOverflow("platform split would be negative")

    return Charge(
        total_milli=_u64(total_milli, "total_milli"),
        provider_milli=_u64(provider_milli, "provider_milli"),
        developer_milli=_u64(developer_milli, "developer_milli"),
        platform_milli=_u64(platform_milli, "platform_milli"),
    )


def price_2z(
    usage: Usage,
    prices: ModelPrices,
    platform_margin_bps: int,
    dev_markup_bps: int,
    min_charge_2z: int,
) -> Charge:
    """Meter and price: ``price_nusd(metered_cost_nusd(usage, prices), …)``.

    Always prices the METERED integer, never the exact sub-nano cost, so an
    estimate and the ledger's settle agree (fixture
    ``metering_boundary_estimate_matches_settle``).
    """
    return price_nusd(
        metered_cost_nusd(usage, prices),
        platform_margin_bps,
        dev_markup_bps,
        min_charge_2z,
    )


def apply_safety_factor(tokens: int, safety_factor_bps: int) -> int:
    """Stand-in-tokenizer count scaled by ``safety_factor_bps``, rounded up."""
    t = _u64(tokens, "tokens")
    f = _u32(safety_factor_bps, "safety_factor_bps")
    return _u64(_ceil_div(t * f, BPS_DENOMINATOR), "scaled tokens")


def nusd_per_mtok_from_usd_per_token(price) -> int:
    """Convert a per-token USD price (``AIModel.input_price``) to integer
    nano-USD per million tokens, EXACTLY.

    ``$0.0000025`` per token is ``2_500_000_000`` nUSD per Mtok. Refuses a
    price that is not a whole number of nUSD per Mtok instead of rounding it:
    a rate card is signed money, and a silent round is a silent reprice.
    ``AIModel``'s columns have 9 decimal places, so every value they can hold
    converts exactly.
    """
    value = Decimal(str(price)) * NUSD_PER_USD * TOKENS_PER_PRICE_UNIT
    if value != value.to_integral_value():
        raise ValueError(f"{price} USD/token is not a whole nUSD per Mtok")
    return _u64(int(value), "price")
