"""The v3 lineup ( audit, 2026-10-05): official prices, caps, the mirror.

Three records must agree and this file is where they meet:

* ``seed_ai_models.LINEUP`` (what the seed command and the rate card derive
  from),
* migration ``0026_seed_lineup_v3`` (its frozen copy, what prod gets), and
* the providers' OFFICIAL figures, written out HERE by hand from the pages
  named in ``seed_ai_models`` so the code is checked against the provider
  rather than against itself.

Plus the long-context guard: every model whose provider bills a higher tier
above an input threshold has its window capped so that the x1.15 tokenizer
safety factor still lands under the threshold.
"""
import importlib
from decimal import Decimal

import pytest
from django.apps import apps
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone

from f2z.ai.providers import ANTHROPIC, KIMI, OPENAI, XAI, model_is_retired

from .management.commands import seed_ai_models as seed
from .models import AIModel

MIGRATION = importlib.import_module("dj.apps.openai.migrations.0026_seed_lineup_v3")
CAP_MIGRATION = importlib.import_module("dj.apps.openai.migrations.0030_cap_gpt41_window")

def _seed_historical_lineup():
    # Applied migrations use historical models, never the live save policy.
    state = MigrationLoader(connection).project_state([("openai", "0030_cap_gpt41_window")])
    MIGRATION.seed(state.apps, None)


# USD per 1M tokens: (input, cached read, cache write, output). Fetched
# 2026-10-05 from https://developers.openai.com/api/docs/pricing.md ("Short
# context" columns) and each model's page. gpt-5.6-sol is listed at its
# PRE-promo price ($4/$20 promo through at least 2026-11-21, "a 20 % and 33 %
# reduction"); see LINEUP. Cache writes: 1.25x on GPT-5.6 and later, free
# (= input here) before.
OPENAI_OFFICIAL = {
    "gpt-6-astra": ("10", "1", "12.5", "50"),
    "gpt-6.1-sol": ("2", "0.10", "2.5", "10"),
    "gpt-6-sol": ("2", "0.20", "2.5", "10"),
    "gpt-6-luna": ("0.10", "0.01", "0.125", "0.50"),
    "gpt-5.6-sol": ("5", "0.50", "6.25", "30"),
    "gpt-5.6-terra": ("2", "0.20", "2.5", "12"),
    "gpt-5.6-luna": ("0.20", "0.02", "0.25", "1.20"),
    "gpt-5.5": ("5", "0.50", "5", "30"),
    "gpt-5.4": ("2.50", "0.25", "2.50", "15"),
    "gpt-5.4-mini": ("0.75", "0.075", "0.75", "4.50"),
    "gpt-5.4-nano": ("0.20", "0.02", "0.20", "1.25"),
    "gpt-5.2": ("1.75", "0.175", "1.75", "14"),
    "gpt-5.1": ("1.25", "0.125", "1.25", "10"),
    "gpt-5": ("1.25", "0.125", "1.25", "10"),
    "gpt-5-mini": ("0.25", "0.025", "0.25", "2"),
    "gpt-5-nano": ("0.05", "0.005", "0.05", "0.40"),
    "gpt-4.1": ("2", "0.50", "2", "8"),
    "gpt-4.1-mini": ("0.40", "0.10", "0.40", "1.60"),
    "gpt-4.1-nano": ("0.10", "0.025", "0.10", "0.40"),
    "gpt-4o": ("2.50", "1.25", "2.50", "10"),
    "gpt-4o-mini": ("0.15", "0.075", "0.15", "0.60"),
    "o3": ("2", "0.50", "2", "8"),
    "o4-mini": ("1.10", "0.275", "1.10", "4.40"),
    "o3-mini": ("1.10", "0.55", "1.10", "4.40"),
    "o1": ("15", "7.50", "15", "60"),
}
# https://platform.claude.com/docs/en/docs/about-claude/pricing, 2026-10-05:
# (input, cache read, 5m write, 1h write, output).
ANTHROPIC_OFFICIAL = {
    "claude-opus-4-8": ("5", "0.50", "6.25", "10", "25"),
    "claude-sonnet-5": ("2", "0.20", "2.50", "4", "10"),
    "claude-haiku-4-5": ("1", "0.10", "1.25", "2", "5"),
}
# https://docs.x.ai/docs/models, 2026-10-05: (input, cached, output).
XAI_OFFICIAL = {
    "grok-4.5": ("2", "0.30", "6"),
    "grok-4.3": ("1.25", "0.20", "2.50"),
}
# https://platform.moonshot.ai/docs/pricing/chat, 2026-10-04.
KIMI_OFFICIAL = {
    "kimi-k3": ("3", "0.30", "3", "6", "15"),
    "kimi-k2.6": ("0.95", "0.16", "0.95", "0.95", "4"),
}

# Provider long-context thresholds (input tokens) and which rows they bind.
OPENAI_THRESHOLD = 272_000
OPENAI_TIERED = {"gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol",
                 "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"}
XAI_THRESHOLD = 200_000
SAFETY = Decimal("1.15")  # DEFAULT_SAFETY_FACTOR_BPS

NUSD = 1_000_000_000


def _usd_per_mtok(usd_per_token):
    return Decimal(usd_per_token) * 1_000_000


def _lineup():
    return {m: row for _, m, *_ in seed.LINEUP for row in [next(r for r in seed.LINEUP if r[1] == m)]}


def _card():
    return {r["model_id"]: r for r in seed.rate_card_rows()}


# ---------------------------------------------------------------- prices


@pytest.mark.parametrize("model", sorted(OPENAI_OFFICIAL))
def test_openai_lineup_and_card_carry_the_official_price(model):
    inp, cached, write, out = (Decimal(x) for x in OPENAI_OFFICIAL[model])
    row = _lineup()[model]
    assert row[0] == OPENAI
    assert _usd_per_mtok(row[3]) == inp and _usd_per_mtok(row[4]) == out
    card = _card()[model]
    assert card["input_nusd_per_mtok"] == inp * NUSD
    assert card["cached_input_nusd_per_mtok"] == cached * NUSD
    assert card["cache_write_5m_nusd_per_mtok"] == write * NUSD
    assert card["cache_write_1h_nusd_per_mtok"] == write * NUSD
    assert card["output_nusd_per_mtok"] == out * NUSD
    assert card["image_nusd"] == 0 and card["tool_call_nusd"] == 0 and card["min_charge_2z"] == 1


@pytest.mark.parametrize("model", sorted(ANTHROPIC_OFFICIAL))
def test_anthropic_lineup_and_card_carry_the_official_price(model):
    inp, cached, w5, w1h, out = (Decimal(x) for x in ANTHROPIC_OFFICIAL[model])
    row = _lineup()[model]
    assert row[0] == ANTHROPIC
    assert _usd_per_mtok(row[3]) == inp and _usd_per_mtok(row[4]) == out
    card = _card()[model]
    assert (card["input_nusd_per_mtok"], card["cached_input_nusd_per_mtok"],
            card["cache_write_5m_nusd_per_mtok"], card["cache_write_1h_nusd_per_mtok"],
            card["output_nusd_per_mtok"]) == tuple(x * NUSD for x in (inp, cached, w5, w1h, out))


@pytest.mark.parametrize("model", sorted(XAI_OFFICIAL))
def test_xai_lineup_and_card_carry_the_official_price(model):
    inp, cached, out = (Decimal(x) for x in XAI_OFFICIAL[model])
    row = _lineup()[model]
    assert row[0] == XAI
    assert _usd_per_mtok(row[3]) == inp and _usd_per_mtok(row[4]) == out
    card = _card()[model]
    assert card["input_nusd_per_mtok"] == inp * NUSD
    assert card["cached_input_nusd_per_mtok"] == cached * NUSD
    # Write prices unpublished: never below input.
    assert card["cache_write_5m_nusd_per_mtok"] == card["cache_write_1h_nusd_per_mtok"] == inp * NUSD
    assert card["output_nusd_per_mtok"] == out * NUSD


@pytest.mark.parametrize("model", sorted(KIMI_OFFICIAL))
def test_kimi_lineup_and_card_carry_the_official_price(model):
    inp, cached, w5, w1h, out = (Decimal(x) for x in KIMI_OFFICIAL[model])
    row = _lineup()[model]
    assert row[0] == KIMI
    assert _usd_per_mtok(row[3]) == inp and _usd_per_mtok(row[4]) == out
    card = _card()[model]
    assert (card["input_nusd_per_mtok"], card["cached_input_nusd_per_mtok"],
            card["cache_write_5m_nusd_per_mtok"], card["cache_write_1h_nusd_per_mtok"],
            card["output_nusd_per_mtok"]) == tuple(x * NUSD for x in (inp, cached, w5, w1h, out))


def test_the_lineup_is_exactly_the_audited_set():
    assert {m for _, m, *_ in seed.LINEUP} == (
        set(OPENAI_OFFICIAL) | set(ANTHROPIC_OFFICIAL) | set(XAI_OFFICIAL) | set(KIMI_OFFICIAL))
    assert len(seed.LINEUP) == len({m for _, m, *_ in seed.LINEUP})


def test_gpt_4o_is_untouched_and_still_the_default():
    """The ¡AHA! app is live on it; nothing about its row may move."""
    row = _lineup()["gpt-4o"]
    assert row == (OPENAI, "gpt-4o", "GPT-4o", "0.0000025", "0.00001", 128000, 8192, 16384, 200, True)
    assert row[8] == max(r[8] for r in seed.LINEUP)
    assert _card()["gpt-4o"] == {
        "model_id": "gpt-4o", "input_nusd_per_mtok": 2_500_000_000,
        "cached_input_nusd_per_mtok": 1_250_000_000, "cache_write_5m_nusd_per_mtok": 2_500_000_000,
        "cache_write_1h_nusd_per_mtok": 2_500_000_000, "output_nusd_per_mtok": 10_000_000_000,
        "image_nusd": 0, "tool_call_nusd": 0, "min_charge_2z": 1,
    }


# ------------------------------------------------------ long-context caps


@pytest.mark.parametrize("model", sorted(OPENAI_TIERED))
def test_openai_tiered_models_are_capped_under_the_threshold(model):
    window = _lineup()[model][5]
    assert window == seed.OPENAI_TIERED_CONTEXT_CAP
    assert window * SAFETY < OPENAI_THRESHOLD
    assert _lineup()[model][7] <= window, "ceiling fits the capped window"


def test_openai_flat_models_keep_their_documented_window():
    for model, row in _lineup().items():
        if row[0] == OPENAI and model not in OPENAI_TIERED:
            assert row[5] in (128000, 200000, 400000, 1047576), model


@pytest.mark.parametrize("model", sorted(XAI_OFFICIAL))
def test_xai_models_are_capped_under_the_threshold(model):
    window = _lineup()[model][5]
    assert window == seed.XAI_TIERED_CONTEXT_CAP
    assert window * SAFETY < XAI_THRESHOLD


def test_the_cap_is_a_real_control():
    """Negative control for the two tests above: the threshold minus one
    token would NOT survive the safety factor."""
    assert (OPENAI_THRESHOLD - 1) * SAFETY >= OPENAI_THRESHOLD
    assert (XAI_THRESHOLD - 1) * SAFETY >= XAI_THRESHOLD


# ------------------------------------------------------------ the mirror


def test_the_migration_mirrors_the_lineup_exactly():
    assert [tuple(r) for r in MIGRATION.LINEUP] == [tuple(r) for r in seed.LINEUP]
    assert set(MIGRATION.STRUCTURED_OUTPUT_MODELS) == set(seed.STRUCTURED_OUTPUT_MODELS)
    assert MIGRATION.DEFAULT_MARKUP == seed.DEFAULT_MARKUP
    assert MIGRATION.GENERIC_SYSTEM_MESSAGE == seed.GENERIC_SYSTEM_MESSAGE
    assert set(MIGRATION.POLICY_DISABLED_PROVIDERS) == set(seed.DISABLED_PROVIDERS)


def test_structured_output_is_declared_for_every_openai_row_and_nothing_else():
    assert seed.STRUCTURED_OUTPUT_MODELS == frozenset((OPENAI, m) for m in OPENAI_OFFICIAL)


@pytest.mark.django_db
def test_the_migration_seeds_new_rows_reprices_old_ones_and_keeps_narrower_windows():
    AIModel.objects.all().delete()
    # A pre-existing gpt-5.6-luna at v2's price, with an operator kill switch
    # and an operator-narrowed window; a pinned snapshot row too.
    luna = AIModel.objects.create(
        provider=OPENAI, model="gpt-5.6-luna", display_name="old", system_message="s",
        input_price=Decimal("0.000001"), output_price=Decimal("0.000006"),
        max_tokens=100_000, max_output_tokens=16384, max_response_tokens=128000,
        is_ga=True, is_enabled=False, order=1,
    )
    pinned = AIModel.objects.create(
        provider=OPENAI, model="gpt-5.5", display_name="pinned", system_message="s",
        provider_model_id="gpt-5.5-2026-04-23",
        max_tokens=400_000, max_output_tokens=16384, max_response_tokens=128000,
    )
    stamp = timezone.now() - timezone.timedelta(days=1)
    AIModel.objects.update(updated_at=stamp)
    _seed_historical_lineup()
    rows = {r.model: r for r in AIModel.objects.all()}
    assert set(rows) == {m for _, m, *_ in seed.LINEUP}
    luna.refresh_from_db()
    assert (luna.input_price, luna.output_price) == (Decimal("0.0000002"), Decimal("0.0000012"))
    assert luna.max_tokens == 100_000, "an operator-narrowed window is kept"
    assert luna.max_response_tokens == 100_000 and luna.max_output_tokens == 16384, (
        "the ceiling is clamped to the kept window so the catalogue still accepts the row")
    assert luna.catalogue_max_output_tokens <= luna.context_window
    assert luna.is_enabled is False, "an operator kill switch survives"
    assert luna.supports_structured_output is True and luna.updated_at > stamp
    pinned.refresh_from_db()
    assert pinned.supports_structured_output is False, "0024's alias-only rule"
    assert pinned.max_tokens == 236_000, "a window ABOVE the cap is lowered to it"
    # A pinned snapshot keeps the cost the operator recorded for it (the
    # model default here), not the alias price -- and is therefore excluded
    # by the cost floor until a card prices the snapshot.
    assert (pinned.input_price, pinned.output_price) == (Decimal("0.0000015"), Decimal("0.000002"))
    astra = rows["gpt-6-astra"]
    assert astra.is_enabled and astra.is_ga and astra.supports_structured_output
    assert astra.max_tokens == 236_000 and astra.markup == Decimal("1.5")
    assert (astra.supports_tools, astra.supports_vision, astra.supports_reasoning) == (False, False, False)
    kimi = rows["kimi-k3"]
    assert kimi.is_enabled is False and kimi.is_ga is False, "policy-disabled provider lands off"
    assert rows["claude-sonnet-5"].input_price == Decimal("0.000002")
    # Idempotent: a second run changes nothing.
    snapshot = list(AIModel.objects.order_by("model").values_list(
        "model", "input_price", "output_price", "max_tokens", "is_enabled", "is_ga",
        "supports_structured_output"))
    _seed_historical_lineup()
    assert list(AIModel.objects.order_by("model").values_list(
        "model", "input_price", "output_price", "max_tokens", "is_enabled", "is_ga",
        "supports_structured_output")) == snapshot


@pytest.mark.django_db
def test_the_seed_command_agrees_with_the_migration():
    from io import StringIO

    from django.core.management import call_command

    AIModel.objects.all().delete()
    _seed_historical_lineup()
    CAP_MIGRATION.cap(apps, None)
    retirement = importlib.import_module("dj.apps.openai.migrations.0031_retire_october_2026_models")
    from types import SimpleNamespace
    retirement.retire(apps, SimpleNamespace(connection=connection))
    before = list(AIModel.objects.order_by("model").values_list(
        "model", "input_price", "output_price", "max_tokens", "max_output_tokens",
        "max_response_tokens", "order", "is_ga", "is_enabled", "supports_structured_output"))
    call_command("seed_ai_models", stdout=StringIO())
    after = list(AIModel.objects.order_by("model").values_list(
        "model", "input_price", "output_price", "max_tokens", "max_output_tokens",
        "max_response_tokens", "order", "is_ga", "is_enabled", "supports_structured_output"))
    assert after == before


@pytest.mark.django_db
def test_the_public_model_list_fits_on_one_page(settings, api_client):
    """ZUULI's picker reads page one of ``GET /api/ai/models/``; every keyed,
    discovered row must be on it (the default page size was 12)."""
    settings.OPENAI_API_KEY = "sk-test"
    AIModel.objects.all().delete()
    _seed_historical_lineup()
    response = api_client.get("/api/ai/models/")
    assert response.status_code == 200
    openai_rows = [m for p, m, *_ in seed.LINEUP if p == OPENAI and not model_is_retired(p, m)]
    assert response.data["count"] == len(openai_rows)
    assert len(response.data["results"]) == len(openai_rows)
    assert response.data["next"] is None
    assert response.data["results"][0]["model"] == "gpt-4o", "the safe default stays first"


# gpt-4.1 goes through the fence only at gpt-4o's class: a sellable window of
# at most 128000 (a refunded sent-but-no-head call is then ~$0.26, not ~$1.80)
# and an output ceiling of at most 16384 (a reply that fits the 300 s deadline).
GPT41_FENCE_WINDOW = 128_000
GPT41_FENCE_OUTPUT = 16_384




def _fence_violations(allowed, rows):
    """Why ``allowed`` must not ship, given ``rows`` (model -> django_lineup
    tuple, i.e. what the ``AIModel`` row and so the signed catalogue hold).
    Empty means the fence is sound."""
    found = []
    openai_rows = {m for p, m, *_ in seed.LINEUP if p == OPENAI}
    found += [f"{m}: not an OpenAI lineup row" for m in sorted(allowed - openai_rows)]
    found += [f"{m}: not on the card" for m in sorted(allowed - set(_card()))]
    if allowed and "gpt-4o" not in allowed:
        found.append("gpt-4o: missing (a live app depends on it)")
    for model in sorted(allowed & openai_rows):
        # Not a reasoning row ('s signed set, and 0029's timeout rule),
        # and a non-reasoning ceiling (reasoning rows carry 128000/100000).
        if (OPENAI, model) in seed.REASONING_EFFORT_LEVELS or seed.is_silent_reasoning(OPENAI, model):
            found.append(f"{model}: a reasoning row")
        if rows[model][7] > 32768:
            found.append(f"{model}: a reasoning-class output ceiling")
    if "gpt-4.1" in allowed:
        window, output = rows["gpt-4.1"][5], rows["gpt-4.1"][7]
        if window > GPT41_FENCE_WINDOW or output > GPT41_FENCE_OUTPUT:
            found.append(f"gpt-4.1: admitted at {window}/{output}, over "
                         f"{GPT41_FENCE_WINDOW}/{GPT41_FENCE_OUTPUT}")
    return found


def _django_rows():
    return {r[1]: tuple(r) for r in seed.django_lineup()}




def test_the_fence_check_refuses_an_uncapped_gpt_4_1():
    """Negative control: the documented 1M / 32K gpt-4.1 row (LINEUP's own
    figures, what 0026 seeded) must NOT pass the fence, nor must a row
    capped on only one of the two axes."""
    documented = _lineup()
    assert documented["gpt-4.1"][5:8] == (1047576, 8192, 32768)
    fence = {"gpt-4o", "gpt-4.1"}
    assert _fence_violations(fence, documented) == [
        "gpt-4.1: admitted at 1047576/32768, over 128000/16384"]
    capped = _django_rows()
    assert _fence_violations(fence, capped) == []
    for index, value in ((5, 128_001), (7, 16_385)):
        row = list(capped["gpt-4.1"])
        row[index] = value
        assert _fence_violations(fence, {**capped, "gpt-4.1": tuple(row)}), index
    #...and a fence without gpt-4.1 never consults its row.
    assert _fence_violations({"gpt-4o"}, documented) == []


def test_only_gpt_4_1_is_capped_and_the_migration_mirrors_the_seed():
    assert seed.GATEWAY_FENCE_CAPS == {(OPENAI, "gpt-4.1"): {
        "max_tokens": CAP_MIGRATION.CAP_WINDOW, "max_response_tokens": CAP_MIGRATION.CAP_RESPONSE}}
    assert (CAP_MIGRATION.CAP_WINDOW, CAP_MIGRATION.CAP_RESPONSE) == (
        GPT41_FENCE_WINDOW, GPT41_FENCE_OUTPUT)
    assert (CAP_MIGRATION.DOCUMENTED_WINDOW, CAP_MIGRATION.DOCUMENTED_RESPONSE) == (
        _lineup()["gpt-4.1"][5], _lineup()["gpt-4.1"][7])
    django_rows = _django_rows()
    assert django_rows["gpt-4.1"][5:8] == (128000, 8192, 16384)
    for model, row in _lineup().items():
        if model != "gpt-4.1":
            assert django_rows[model] == row, model
    # Worst refunded input at the cap, USD: the same order as gpt-4o's.
    usd = lambda m, w: Decimal(_lineup()[m][3]) * w  # noqa: E731
    assert usd("gpt-4.1", CAP_MIGRATION.CAP_WINDOW) <= usd("gpt-4o", 128000)


@pytest.mark.django_db
def test_0030_caps_gpt_4_1_keeps_a_narrower_row_and_reverses():
    AIModel.objects.all().delete()
    _seed_historical_lineup()
    other = AIModel.objects.get(model="gpt-4.1-mini")
    before_other = (other.max_tokens, other.max_output_tokens, other.max_response_tokens)
    narrowed = AIModel.objects.create(
        provider=OPENAI, model="gpt-4.1", display_name="n", system_message="s",
        provider_model_id="gpt-4.1-2025-04-14",
        max_tokens=50_000, max_output_tokens=8192, max_response_tokens=32768,
    )
    CAP_MIGRATION.cap(apps, None)
    row = AIModel.objects.get(model="gpt-4.1", provider_model_id="")
    assert (row.max_tokens, row.max_output_tokens, row.max_response_tokens) == (128000, 8192, 16384)
    assert (row.context_window, row.catalogue_max_output_tokens) == (128000, 16384)
    narrowed.refresh_from_db()
    assert (narrowed.max_tokens, narrowed.max_response_tokens) == (50_000, 16384)
    other.refresh_from_db()
    assert (other.max_tokens, other.max_output_tokens, other.max_response_tokens) == before_other
    CAP_MIGRATION.uncap(apps, None)
    row.refresh_from_db()
    assert (row.max_tokens, row.max_response_tokens) == (1047576, 32768)
    narrowed.refresh_from_db()
    assert narrowed.max_tokens == 50_000, "reverse leaves an operator-narrowed row alone"


@pytest.mark.django_db
def test_the_seed_command_keeps_pinned_costs_and_narrow_windows_like_0026():
    """`seed_ai_models` is what an operator runs by hand; it must not undo
    what 0026 protects."""
    from io import StringIO

    from django.core.management import call_command

    AIModel.objects.all().delete()
    pinned = AIModel.objects.create(
        provider=OPENAI, model="gpt-4.1", display_name="ft", system_message="s",
        provider_model_id="ft:gpt-4.1:acme::abc123",
        input_price=Decimal("0.000004"), output_price=Decimal("0.000016"),
        max_tokens=1_047_576, max_output_tokens=8192, max_response_tokens=32768,
    )
    narrowed = AIModel.objects.create(
        provider=OPENAI, model="gpt-5.5", display_name="n", system_message="s",
        max_tokens=50_000, max_output_tokens=16384, max_response_tokens=128000,
    )
    call_command("seed_ai_models", stdout=StringIO())
    pinned.refresh_from_db()
    assert (pinned.input_price, pinned.output_price) == (Decimal("0.000004"), Decimal("0.000016"))
    narrowed.refresh_from_db()
    assert narrowed.max_tokens == 50_000
    assert narrowed.max_response_tokens == 50_000 and narrowed.max_output_tokens == 16384
    assert narrowed.input_price == Decimal("0.000005"), "an unpinned row takes the lineup price"


def test_the_budget_count_never_undercounts_the_models_tokenizer():
    """`count_prompt_tokens` is the max over the shipped encodings: a string
    o200k_base splits finer than cl100k_base must count at o200k's number,
    whatever model name is passed."""
    import tiktoken

    from dj.apps.openai.models import BUDGET_ENCODINGS, count_prompt_tokens, num_tokens_from_messages

    assert set(BUDGET_ENCODINGS) == {"cl100k_base", "o200k_base"}
    messages = [{"role": "user", "content": " className " * 1000}]
    o200k = len(tiktoken.get_encoding("o200k_base").encode(messages[0]["content"]))
    cl100k = len(tiktoken.get_encoding("cl100k_base").encode(messages[0]["content"]))
    assert o200k > cl100k * 1.15, "the premise: the margin alone does not cover it"
    for model in ("gpt-5.4", "gpt-6-astra", "gpt-3.5-turbo", "claude-sonnet-5", "grok-4.5"):
        assert count_prompt_tokens(messages, model) >= o200k + 6, model
    #...and the legacy single-encoding count (unchanged callers) is the
    # smaller cl100k number the budget used to be checked against.
    assert num_tokens_from_messages(messages) < count_prompt_tokens(messages, "gpt-5.4")
    assert num_tokens_from_messages(messages) <= cl100k + 8
