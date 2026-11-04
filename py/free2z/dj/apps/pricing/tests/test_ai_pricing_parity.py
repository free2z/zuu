"""Parity: ``dj.apps.pricing.ai`` against zuu f2z-ai-proto's own fixtures.

Every case in every vendored fixture file is run -- the file list is globbed,
and the case count asserted per file -- so a fixture added upstream and
re-vendored is covered without editing this test. No database: pure integer
arithmetic.

Negative control, run while writing this: rounding ``p`` and ``d`` separately
(``ceil(p) + ceil(d)``) fails ``single_rounding_with_markup``; truncating ``p``
before the ceil fails ``metering_boundary_estimate_matches_settle``; pricing
the exact (un-metered) cost fails the same case. Each is re-checked below
with a deliberately wrong implementation, so the fixtures are proven to
discriminate rather than merely to pass.
"""
import hashlib
import json
import math
import random
from fractions import Fraction
from pathlib import Path

import pytest

from dj.apps.pricing import ai
from dj.apps.pricing.ai import (
    Charge,
    ModelPrices,
    PricingOverflow,
    Usage,
    apply_safety_factor,
    metered_cost_nusd,
    nusd_per_mtok_from_usd_per_token,
    price_2z,
    price_nusd,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "f2z_ai_proto" / "pricing"

# git blob ids of the vendored files at free2z/zuu 5603cae9 (see the README
# next to them). Changing a fixture is changing the pricing contract: it must
# be a deliberate re-vendor that updates these ids, never a silent edit.
RECORDED_BLOBS = {
    "worked_examples.json": "806947d6f2e8088dfe762171645ab0317d05614b",
    "from_usage.json": "c02a9357d8a9ac65ea92baf6c196ac86bd063a35",
}
# Per-file case counts at that commit (12 + 5 = 17, ledger-v2 §9).
RECORDED_CASE_COUNTS = {
    "worked_examples.json": 12,
    "from_usage.json": 5,
}


def _git_blob_id(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _load(name):
    return json.loads((FIXTURES / name).read_text())


def _cases(name):
    return [pytest.param(c, id=c["name"]) for c in _load(name)["cases"]]


def _charge(expected):
    return Charge(
        total_milli=expected["total_milli"],
        provider_milli=expected["provider_milli"],
        developer_milli=expected["developer_milli"],
        platform_milli=expected["platform_milli"],
    )


# ----------------------------------------------------------- vendoring guard


def test_vendored_fixture_set_is_the_recorded_set():
    assert sorted(p.name for p in FIXTURES.glob("*.json")) == sorted(RECORDED_BLOBS)


@pytest.mark.parametrize("name", sorted(RECORDED_BLOBS))
def test_vendored_fixtures_match_recorded_blobs(name):
    actual = _git_blob_id((FIXTURES / name).read_bytes())
    assert actual == RECORDED_BLOBS[name], (
        f"{name} differs from the vendored zuu copy. Re-vendoring is "
        "deliberate: follow fixtures/f2z_ai_proto/README.md and update "
        "RECORDED_BLOBS in the same PR."
    )


@pytest.mark.parametrize("name", sorted(RECORDED_CASE_COUNTS))
def test_every_case_is_counted(name):
    data = _load(name)
    assert data["schema"] == 1
    assert len(data["cases"]) == RECORDED_CASE_COUNTS[name]
    names = [c["name"] for c in data["cases"]]
    assert len(names) == len(set(names))


# ----------------------------------------------------------------- parity


@pytest.mark.parametrize("case", _cases("worked_examples.json"))
def test_price_nusd_matches_crate_fixture(case):
    i = case["input"]
    charge = price_nusd(
        i["cost_nusd"], i["platform_margin_bps"], i["dev_markup_bps"], i["min_charge_2z"]
    )
    assert charge == _charge(case["expected"])


@pytest.mark.parametrize("case", _cases("from_usage.json"))
def test_price_2z_matches_crate_fixture(case):
    i = case["input"]
    usage = Usage.from_crate(i["usage"])
    prices = ModelPrices.from_crate(i["prices"])
    assert metered_cost_nusd(usage, prices) == case["expected"]["cost_nusd"]
    charge = price_2z(
        usage, prices, i["platform_margin_bps"], i["dev_markup_bps"], i["min_charge_2z"]
    )
    assert charge == _charge(case["expected"])
    # The estimate prices the same integer settle receives.
    assert charge == price_nusd(
        case["expected"]["cost_nusd"],
        i["platform_margin_bps"],
        i["dev_markup_bps"],
        i["min_charge_2z"],
    )


# ------------------------------------------- the fixtures discriminate


def _wrong_round_separately(c, m, k, mn):
    p = Fraction(c, 10**9) * 100 * (1 + Fraction(m, 10000))
    d = p * Fraction(k, 10000)
    return max(mn, math.ceil(p) + math.ceil(d)) * 1000


def _wrong_truncate_p(c, m, k, mn):
    p_nusd = c * (10000 + m) // 10000
    return max(mn, math.ceil(Fraction(p_nusd * (10000 + k), 10000 * 10**7))) * 1000


def test_negative_controls_fail_on_the_fixtures():
    by_name = {c["name"]: c for c in _load("worked_examples.json")["cases"]}
    case = by_name["single_rounding_with_markup"]
    i = case["input"]
    args = (i["cost_nusd"], i["platform_margin_bps"], i["dev_markup_bps"], i["min_charge_2z"])
    assert _wrong_round_separately(*args) != case["expected"]["total_milli"]

    usage_cases = {c["name"]: c for c in _load("from_usage.json")["cases"]}
    boundary = usage_cases["metering_boundary_estimate_matches_settle"]
    bi = boundary["input"]
    cost = boundary["expected"]["cost_nusd"]
    assert _wrong_truncate_p(cost, bi["platform_margin_bps"], 0, 1) != boundary["expected"]["total_milli"]
    # Pricing the EXACT (un-metered) cost instead of the metered integer.
    exact_usd = Fraction(bi["usage"]["input_tokens"] * bi["prices"]["input_nusd_per_mtok"], 10**15)
    exact_total = max(1, math.ceil(exact_usd * 100 * Fraction(10000 + bi["platform_margin_bps"], 10000))) * 1000
    assert exact_total != boundary["expected"]["total_milli"]


# ---------------------------------------------- the crate's own unit tests


def test_crate_unit_cases():
    assert price_nusd(21_000_000, 0, 0, 1) == Charge(3000, 2100, 0, 900)
    assert price_nusd(21_000_000, 0, 1000, 1).total_2z == 3
    assert price_nusd(0, 5000, 0, 1) == Charge(1000, 0, 0, 1000)
    assert price_nusd(20_000_000, 0, 0, 0) == Charge(2000, 2000, 0, 0)
    one = price_2z(Usage(input_tokens=1), ModelPrices(input_nusd_per_mtok=1), 0, 0, 0)
    assert one.total_milli == 1000 and one.provider_milli == 1
    assert apply_safety_factor(100, 11_500) == 115
    assert apply_safety_factor(1, 11_500) == 2
    assert apply_safety_factor(7, 10_000) == 7


def test_overflow_is_refused_where_the_crate_refuses_it():
    with pytest.raises(PricingOverflow):
        price_2z(
            Usage(output_tokens=ai.U64_MAX),
            ModelPrices(output_nusd_per_mtok=ai.U64_MAX),
            0, 0, 0,
        )
    with pytest.raises(PricingOverflow):
        price_nusd(ai.U64_MAX, ai.U32_MAX, ai.U32_MAX, 0)
    with pytest.raises(PricingOverflow):
        price_nusd(0, ai.U32_MAX + 1, 0, 1)


def test_inputs_are_integers_only():
    with pytest.raises(TypeError):
        price_nusd(1.5, 0, 0, 1)
    with pytest.raises(TypeError):
        price_nusd(True, 0, 0, 1)
    with pytest.raises(ValueError):
        price_nusd(-1, 0, 0, 1)


# ------------------------------------------------------- properties


def _reference(c, m, k, mn):
    """The fixtures' own exact-rational derivation (zuu reference.py)."""
    cost_usd = Fraction(c, 10**9)
    p = cost_usd * 100 * (1 + Fraction(m, 10000))
    d = p * Fraction(k, 10000)
    total = max(mn, math.ceil(p + d)) * 1000
    provider = math.ceil(cost_usd * 100 * 1000)
    developer = math.floor(d * 1000)
    return Charge(total, provider, developer, total - provider - developer)


def test_random_inputs_match_the_exact_rational_reference():
    rng = random.Random(2222)
    for _ in range(3000):
        c = rng.choice([rng.randrange(0, 10**6), rng.randrange(0, 10**12), rng.randrange(0, 1 << 63)])
        m = rng.choice([0, 2000, 5000, rng.randrange(0, 100_001)])
        k = rng.choice([0, 1000, rng.randrange(0, 20_001)])
        mn = rng.randrange(0, 20)
        got = price_nusd(c, m, k, mn)
        assert got == _reference(c, m, k, mn)
        assert got.total_milli % 1000 == 0
        assert got.total_milli >= got.provider_milli + got.developer_milli
        if mn >= 1:
            assert got.total_milli >= 1000


def test_monotone_in_cost_margin_and_markup():
    rng = random.Random(22220)
    for _ in range(1000):
        c = rng.randrange(0, 10**11)
        m = rng.randrange(0, 20_000)
        k = rng.randrange(0, 20_000)
        base = price_nusd(c, m, k, 1).total_milli
        assert price_nusd(c + rng.randrange(1, 10**7), m, k, 1).total_milli >= base
        assert price_nusd(c, m + rng.randrange(1, 1000), k, 1).total_milli >= base
        assert price_nusd(c, m, k + rng.randrange(1, 1000), 1).total_milli >= base


# --------------------------------------------- decoding and the 5m/1h split


def test_from_crate_refuses_unknown_and_missing_members():
    good = {
        "input_nusd_per_mtok": 1,
        "cached_input_nusd_per_mtok": 0,
        "cache_write_nusd_per_mtok": 7,
        "output_nusd_per_mtok": 0,
        "image_nusd": 0,
        "tool_call_nusd": 0,
    }
    assert ModelPrices.from_crate(good).cache_write_5m_nusd_per_mtok == 7
    assert ModelPrices.from_crate(good).cache_write_1h_nusd_per_mtok == 0
    with pytest.raises(ValueError, match="unknown"):
        ModelPrices.from_crate({**good, "cache_write_1h_nusd_per_mtok": 9})
    missing = dict(good)
    del missing["tool_call_nusd"]
    with pytest.raises(ValueError, match="missing"):
        ModelPrices.from_crate(missing)
    with pytest.raises(ValueError, match="unknown"):
        Usage.from_crate({"input_tokens": 1, "cache_write_1h_tokens": 1})


def test_one_hour_cache_writes_are_metered_at_their_own_price():
    prices = ModelPrices(
        cache_write_5m_nusd_per_mtok=3_750_000_000,
        cache_write_1h_nusd_per_mtok=6_000_000_000,
    )
    assert metered_cost_nusd(Usage(cache_write_tokens=1000), prices) == 3_750_000
    assert metered_cost_nusd(Usage(cache_write_1h_tokens=1000), prices) == 6_000_000
    # reasoning_tokens is informational only.
    assert metered_cost_nusd(Usage(reasoning_tokens=10**9), ModelPrices(output_nusd_per_mtok=1)) == 0


def test_usd_per_token_conversion_is_exact_or_refused():
    assert nusd_per_mtok_from_usd_per_token("0.0000025") == 2_500_000_000
    assert nusd_per_mtok_from_usd_per_token("0.000000001") == 1_000_000
    with pytest.raises(ValueError):
        nusd_per_mtok_from_usd_per_token("0.0000000000000001")
