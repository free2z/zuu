"""Silent-reasoning rows carry ``ttfb_timeout_ms`` and ``idle_timeout_ms``
= 300000.

A reasoning model's Chat Completions stream can send no body byte until it
has finished thinking, so both gateway deadlines must step aside for the
gateway's 300 s absolute call deadline. Migration
``0029_reasoning_idle_timeouts`` moves the existing rows; the seed command
gives a freshly created row the same values; the signed catalogue emits
them. The 1M-window gpt-4.1 rows get ``ttfb_timeout_ms`` 300000 only (a
~900K-token prefill must not end unaccepted at 60 s). Every OpenAI row's ``safety_factor_bps`` drops to 11000 (the gateway's
OpenAI input estimate is tokenizer-exact now); other providers keep 11500.
The ConfigMap's ``allowed_models`` still keeps the reasoning rows off the
gateway until zuu#1179; the timeouts are in place for when it does not.
gpt-4.1 is on it since openai 0030 capped it to gpt-4o's class.
"""
import importlib
from io import StringIO

import pytest
from django.apps import apps
from django.core.management import call_command
from django.utils import timezone

from .management.commands import seed_ai_models as seed
from .models import (
    DEFAULT_IDLE_TIMEOUT_MS,
    DEFAULT_SAFETY_FACTOR_BPS,
    DEFAULT_TTFB_TIMEOUT_MS,
    MAX_IDLE_TIMEOUT_MS,
    AIModel,
)

LINEUP_V3 = importlib.import_module("dj.apps.openai.migrations.0026_seed_lineup_v3")
MIGRATION = importlib.import_module("dj.apps.openai.migrations.0029_reasoning_idle_timeouts")

DEFAULTS = (DEFAULT_TTFB_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS)
RAISED = (300_000, 300_000)
LONG_PREFILL_TIMEOUTS = (300_000, DEFAULT_IDLE_TIMEOUT_MS)
OPENAI_SAFETY = 11_000

# Written out by hand, not derived from the prefix rule under test.
REASONING = {
    "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.5", "gpt-5.4",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-5-nano", "o3", "o4-mini",
    "o3-mini", "o1",
}
STREAMING = {
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "grok-4.5", "grok-4.3",
    "kimi-k3", "kimi-k2.6",
}
OPENAI_ROWS = {m for p, m, *_ in seed.LINEUP if p == "openai"}
LONG_PREFILL = {"gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"}


def _safety():
    return dict(AIModel.objects.values_list("model", "safety_factor_bps"))


def _timeouts():
    """model -> (ttfb_timeout_ms, idle_timeout_ms)."""
    return {m: (t, i) for m, t, i in AIModel.objects.values_list(
        "model", "ttfb_timeout_ms", "idle_timeout_ms")}


def test_the_migration_mirrors_the_seed_rule():
    assert MIGRATION.SILENT_REASONING_PREFIXES == seed.SILENT_REASONING_PREFIXES
    assert MIGRATION.LONG_PREFILL_PREFIXES == seed.LONG_PREFILL_PREFIXES
    assert MIGRATION.REASONING_TIMEOUT_MS == seed.REASONING_TIMEOUT_MS == MAX_IDLE_TIMEOUT_MS
    assert MIGRATION.DEFAULT_IDLE_TIMEOUT_MS == DEFAULT_IDLE_TIMEOUT_MS
    assert MIGRATION.DEFAULT_TTFB_TIMEOUT_MS == DEFAULT_TTFB_TIMEOUT_MS
    assert MIGRATION.MAX_IDLE_TIMEOUT_MS == MAX_IDLE_TIMEOUT_MS
    assert MIGRATION.DEFAULT_SAFETY_FACTOR_BPS == DEFAULT_SAFETY_FACTOR_BPS
    assert MIGRATION.OPENAI_SAFETY_FACTOR_BPS == seed.OPENAI_SAFETY_FACTOR_BPS == OPENAI_SAFETY
    assert 10_000 <= OPENAI_SAFETY < DEFAULT_SAFETY_FACTOR_BPS, "never below x1.0"


def test_the_rule_selects_exactly_the_reasoning_rows():
    assert len(REASONING) == 20
    assert REASONING | STREAMING == {m for _, m, *_ in seed.LINEUP}
    assert {m for p, m, *_ in seed.LINEUP if seed.is_silent_reasoning(p, m)} == REASONING
    assert {m for p, m, *_ in seed.LINEUP if seed.is_long_prefill(p, m)} == LONG_PREFILL


@pytest.mark.django_db
def test_forward_raises_reasoning_rows_and_reverse_restores_them():
    AIModel.objects.all().delete()
    LINEUP_V3.seed(apps, None)
    assert set(_timeouts().values()) == {DEFAULTS}, "the premise"
    assert set(_safety().values()) == {DEFAULT_SAFETY_FACTOR_BPS}, "the premise"
    # An operator's explicit values on reasoning rows (one field each); a
    # non-OpenAI row that happens to match a prefix.
    AIModel.objects.filter(model="o1").update(idle_timeout_ms=120_000)
    AIModel.objects.filter(model="gpt-5.2").update(ttfb_timeout_ms=90_000)
    AIModel.objects.filter(model="gpt-4.1").update(safety_factor_bps=12_000)
    AIModel.objects.create(provider="xai", model="o3-lookalike", display_name="x",
                           system_message="s", max_tokens=128_000)
    stamp = timezone.now() - timezone.timedelta(days=1)
    AIModel.objects.update(updated_at=stamp)

    MIGRATION.tune_openai_rows(apps, None)
    after = _timeouts()
    for model in REASONING - {"o1", "gpt-5.2"}:
        assert after[model] == RAISED, model
    for model in LONG_PREFILL:
        assert after[model] == LONG_PREFILL_TIMEOUTS, model
    for model in STREAMING - LONG_PREFILL | {"o3-lookalike"}:
        assert after[model] == DEFAULTS, model
    assert after["o1"] == (300_000, 120_000), "an operator's explicit idle is kept"
    assert after["gpt-5.2"] == (90_000, 300_000), "an operator's explicit ttfb is kept"
    safety = _safety()
    assert safety["gpt-4o"] == safety["o3"] == safety["gpt-4.1-mini"] == OPENAI_SAFETY
    assert {safety[m] for m in OPENAI_ROWS - {"gpt-4.1"}} == {OPENAI_SAFETY}
    assert safety["gpt-4.1"] == 12_000, "an operator's explicit safety factor is kept"
    for model in STREAMING - OPENAI_ROWS | {"o3-lookalike"}:
        assert safety[model] == DEFAULT_SAFETY_FACTOR_BPS, model
    assert safety["claude-sonnet-5"] == 11_500
    moved = set(AIModel.objects.filter(updated_at__gt=stamp).values_list("model", flat=True))
    assert moved == OPENAI_ROWS, "updated_at moves the catalogue version"
    # supports_reasoning is another slice's.
    assert not AIModel.objects.filter(supports_reasoning=True).exists()

    MIGRATION.tune_openai_rows(apps, None)
    assert _timeouts() == after and _safety() == safety, "idempotent"

    MIGRATION.untune_openai_rows(apps, None)
    restored = _timeouts()
    assert restored["o1"] == (DEFAULT_TTFB_TIMEOUT_MS, 120_000)
    assert restored["gpt-5.2"] == (90_000, DEFAULT_IDLE_TIMEOUT_MS)
    assert {v for m, v in restored.items() if m not in ("o1", "gpt-5.2")} == {DEFAULTS}
    restored_safety = _safety()
    assert restored_safety.pop("gpt-4.1") == 12_000
    assert set(restored_safety.values()) == {DEFAULT_SAFETY_FACTOR_BPS}


@pytest.mark.django_db
def test_the_seed_command_creates_reasoning_rows_at_the_ceiling():
    AIModel.objects.all().delete()
    call_command("seed_ai_models", stdout=StringIO())
    seeded = _timeouts()
    assert {m for m, v in seeded.items() if v == RAISED} == REASONING
    assert {seeded[m] for m in LONG_PREFILL} == {LONG_PREFILL_TIMEOUTS}
    assert {seeded[m] for m in STREAMING - LONG_PREFILL} == {DEFAULTS}
    safety = _safety()
    assert {m for m, v in safety.items() if v == OPENAI_SAFETY} == OPENAI_ROWS
    assert {safety[m] for m in STREAMING - OPENAI_ROWS} == {DEFAULT_SAFETY_FACTOR_BPS}
    # Create-only: a reseed keeps an operator's values.
    AIModel.objects.filter(model="gpt-5").update(
        ttfb_timeout_ms=45_000, idle_timeout_ms=90_000, safety_factor_bps=12_500)
    call_command("seed_ai_models", stdout=StringIO())
    assert _timeouts()["gpt-5"] == (45_000, 90_000)
    assert _safety()["gpt-5"] == 12_500


@pytest.mark.django_db
def test_the_signed_catalogue_emits_the_raised_timeouts():
    from dj.apps.pricing import catalog

    AIModel.objects.all().delete()
    LINEUP_V3.seed(apps, None)
    call_command("seed_ai_models", stdout=StringIO())  # the card
    MIGRATION.tune_openai_rows(apps, None)
    built = catalog.build_catalog(catalog.now_unix())
    by_id = {m["id"]: m for m in built["models"]}
    for model in ("o3", "gpt-6-sol"):
        assert (by_id[model]["ttfb_timeout_ms"], by_id[model]["idle_timeout_ms"]) == RAISED
    assert (by_id["gpt-4o"]["ttfb_timeout_ms"], by_id["gpt-4o"]["idle_timeout_ms"]) == DEFAULTS
    assert by_id["gpt-4o"]["safety_factor_bps"] == OPENAI_SAFETY
    assert (by_id["gpt-4.1"]["ttfb_timeout_ms"], by_id["gpt-4.1"]["idle_timeout_ms"]) == (
        LONG_PREFILL_TIMEOUTS)
    catalog.validate_catalog(built)


