"""AIModel gateway-catalogue fields.

What these pin:

* the columns are MIXED-FLEET safe -- an INSERT written by an old pod, which
  names none of them, still succeeds and gets the defaults;
* every catalogue member the zuu f2z-ai-proto ``CatalogModel`` needs can be
  read off a row with no lossy conversion, and the seeded lineup is a valid
  catalogue (the crate's ``Catalog::validate`` rules);
* NO existing behaviour moved: ``get_tuzi_price`` charges what it charged, and
  the serialized model is byte-for-byte the pre- shape.
"""
import io
import uuid
from decimal import Decimal

import pytest
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction

from dj.apps.openai.management.commands import seed_ai_models
from dj.apps.openai.models import (
    API_STYLES,
    DEFAULT_SAFETY_FACTOR_BPS,
    DEFAULT_TTFB_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    MAX_IDLE_TIMEOUT_MS,
    AIModel,
)
from dj.apps.openai.serializers import AIModelSerializer
from f2z.ai.providers import ANTHROPIC, KIMI, OPENAI, XAI

pytestmark = pytest.mark.django_db

NEW_COLUMNS = {"provider_model_id", "api_style", "ttfb_timeout_ms", "idle_timeout_ms", "safety_factor_bps",
               "supports_tools", "supports_vision", "supports_reasoning",
               "supports_structured_output", "supports_strict_tools",
               "supports_reasoning_effort", "reasoning_effort_levels"}

# The serializer's keys before  (fields='__all__' over the old columns).
PRE_2222_SERIALIZED_KEYS = {
    "id", "provider", "model", "display_name", "system_message", "max_tokens",
    "max_output_tokens", "max_response_tokens", "is_ga", "is_enabled",
    "created_at", "updated_at", "order", "input_price", "output_price", "markup",
}


def _model(**kw):
    defaults = dict(
        provider=OPENAI, model=f"m-{uuid.uuid4().hex[:8]}", display_name="M",
        system_message="s", max_tokens=128000,
    )
    return AIModel.objects.create(**{**defaults, **kw})


def test_an_old_pods_insert_still_succeeds_and_gets_the_defaults():
    old_columns = [
        f.column for f in AIModel._meta.concrete_fields if f.name not in NEW_COLUMNS
    ]
    assert len(old_columns) == len(PRE_2222_SERIALIZED_KEYS)
    values = {
        "id": uuid.uuid4(), "provider": ANTHROPIC, "model": "old-pod-model",
        "display_name": "Old", "system_message": "s", "max_tokens": 200000,
        "max_output_tokens": 8192, "max_response_tokens": 8192, "is_ga": False,
        "is_enabled": True, "order": 0, "input_price": Decimal("0.000003"),
        "output_price": Decimal("0.000015"), "markup": Decimal("1.5"),
    }
    cols = [c for c in old_columns if c not in ("created_at", "updated_at")]
    assert set(cols) == set(values)
    sql = (
        f'INSERT INTO {AIModel._meta.db_table} '
        f'({", ".join(connection.ops.quote_name(c) for c in cols)}, created_at, updated_at) '
        f'VALUES ({", ".join(["%s"] * len(cols))}, now(), now())'
    )
    with connection.cursor() as cur:
        cur.execute(sql, [values[c] for c in cols])
    row = AIModel.objects.get(model="old-pod-model")
    assert row.provider_model_id == ""
    assert row.api_style == ""
    assert row.ttfb_timeout_ms == DEFAULT_TTFB_TIMEOUT_MS == 60_000
    assert row.idle_timeout_ms == DEFAULT_IDLE_TIMEOUT_MS == 60_000
    assert row.safety_factor_bps == DEFAULT_SAFETY_FACTOR_BPS == 11_500
    assert (row.supports_tools, row.supports_vision, row.supports_reasoning,
            row.supports_structured_output, row.supports_strict_tools,
            row.supports_reasoning_effort) == (False, False, False, False, False, False)
    assert row.reasoning_effort_levels == []
    assert row.effective_api_style == "anthropic_messages"
    assert row.upstream_model_id == "old-pod-model"


@pytest.mark.parametrize("provider,style", [
    (OPENAI, "openai_chat"),
    (XAI, "openai_chat"),
    (KIMI, "openai_chat"),
    (ANTHROPIC, "anthropic_messages"),
])
def test_api_style_derives_from_provider_unless_overridden(provider, style):
    row = _model(provider=provider)
    assert row.effective_api_style == style
    row.api_style = "openai_responses"
    assert row.effective_api_style == "openai_responses"


def test_catalogue_values_are_the_crates_vocabulary():
    # zuu f2z-ai-proto ApiStyle, serde snake_case.
    assert set(API_STYLES) == {"openai_responses", "openai_chat", "anthropic_messages"}


def test_provider_model_id_override():
    row = _model(model="claude-sonnet-5", provider=ANTHROPIC)
    assert row.upstream_model_id == "claude-sonnet-5"
    row.provider_model_id = "claude-sonnet-5-20260101"
    assert row.upstream_model_id == "claude-sonnet-5-20260101"


def test_context_window_and_output_ceiling_are_the_existing_columns():
    row = _model(max_tokens=400000, max_output_tokens=16384, max_response_tokens=128000)
    assert row.context_window == 400000
    # The catalogue's max_output_tokens is the CEILING, not the legacy reserve.
    assert row.catalogue_max_output_tokens == 128000


def test_checks_refuse_nonsense():
    for bad in (
        dict(safety_factor_bps=9999), dict(ttfb_timeout_ms=0),
        dict(idle_timeout_ms=0), dict(idle_timeout_ms=MAX_IDLE_TIMEOUT_MS + 1),
        dict(api_style="grpc"),
    ):
        with pytest.raises(IntegrityError):
            with transaction.atomic():
                _model(**bad)


def test_seeded_lineup_is_a_valid_catalogue():
    """The crate's Catalog::validate rules, over what the lineup seeds."""
    call_command("seed_ai_models", stdout=io.StringIO())
    ids = []
    for row in AIModel.objects.filter(
        model__in=[m for _, m, *_ in seed_ai_models.LINEUP]
    ):
        ids.append(row.model)
        assert row.safety_factor_bps >= 10_000
        assert row.catalogue_max_output_tokens <= row.context_window
        assert row.effective_api_style in API_STYLES
        assert row.ttfb_timeout_ms > 0
        assert 1 <= row.idle_timeout_ms <= MAX_IDLE_TIMEOUT_MS
    assert sorted(ids) == sorted(m for _, m, *_ in seed_ai_models.LINEUP)
    assert len(ids) == len(set(ids)), "catalogue ids must be unique"


# ------------------------------------------------ nothing existing moved


def test_get_tuzi_price_is_unchanged():
    row = _model(input_price="0.0000025", output_price="0.00001", markup="1.5")
    # (1000 x 0.0000025 + 500 x 0.00001) x 100 x 1.5 = 1.125 -> ceil 2
    assert row.get_tuzi_price(1000, 500) == 2
    # (10000 x 0.0000025 + 5000 x 0.00001) x 100 x 1.5 = 11.25 -> 12
    assert row.get_tuzi_price(10000, 5000) == 12
    assert row.get_tuzi_price(0, 0) == 0


def test_serialized_model_shape_is_unchanged():
    data = AIModelSerializer(_model()).data
    assert set(data) == PRE_2222_SERIALIZED_KEYS
    assert not NEW_COLUMNS & set(data)


# ------------------------------------------- structured_output (zuu#1128)


def test_structured_output_declaration_names_exact_rows_only():
    """Migration 0024 declares ``true`` for the reviewed OpenAI aliases only.
    A row pinned to another upstream snapshot, another provider's row, and a
    look-alike name all stay ``false`` -- nothing is inferred."""
    import importlib

    from django.apps import apps

    migration = importlib.import_module(
        "dj.apps.openai.migrations.0024_aimodel_supports_structured_output")
    AIModel.objects.filter(model__in=["gpt-4o", "gpt-5.6-luna", "gpt-5.6-sol"]).delete()
    alias = _model(model="gpt-4o")
    explicit = _model(model="gpt-5.6-luna", provider_model_id="gpt-5.6-luna")
    pinned = _model(model="gpt-5.6-sol", provider_model_id="gpt-5.6-sol-2025-01-01")
    lookalike = _model(model="gpt-4o-mini")
    other = _model(provider=XAI, model=f"grok-{uuid.uuid4().hex[:6]}")
    migration.declare(apps, None)
    got = {r.pk: r.supports_structured_output for r in AIModel.objects.all()}
    assert got[alias.pk] is True and got[explicit.pk] is True
    assert got[pinned.pk] is False and got[lookalike.pk] is False and got[other.pk] is False
    assert {m for p, m in migration.STRUCTURED_OUTPUT_MODELS} <= {
        m for p, m, *_ in seed_ai_models.LINEUP if p == OPENAI}


# --------------------------------------- tools / strict_tools (zuu#1142)


def test_tools_declaration_names_exact_rows_only():
    """Migration 0027 declares ``tools`` + ``strict_tools`` for the reviewed
    OpenAI aliases only. A pinned snapshot, an excluded gpt-6 row, another
    provider's row and an unlisted name all stay ``false``."""
    import importlib

    from django.apps import apps

    migration = importlib.import_module(
        "dj.apps.openai.migrations.0027_aimodel_supports_strict_tools")
    names = ["gpt-4o", "o3-mini", "gpt-5.4", "gpt-5.6-luna", "gpt-6-sol", "gpt-6.1-sol",
             "gpt-6-astra"]
    AIModel.objects.filter(model__in=names).delete()
    alias = _model(model="gpt-4o")
    explicit = _model(model="o3-mini", provider_model_id="o3-mini")
    pinned = _model(model="gpt-5.4", provider_model_id="gpt-5.4-2026-03-05")
    medium_default = _model(model="gpt-5.6-luna")
    excluded = _model(model="gpt-6-sol")
    responses_only = _model(model="gpt-6.1-sol")
    astra = _model(model="gpt-6-astra")
    unlisted = _model(model=f"gpt-{uuid.uuid4().hex[:6]}")
    other = _model(provider=XAI, model=f"grok-{uuid.uuid4().hex[:6]}")
    migration.declare(apps, None)
    got = {r.pk: (r.supports_tools, r.supports_strict_tools) for r in AIModel.objects.all()}
    assert got[alias.pk] == got[explicit.pk] == (True, True)
    for row in (pinned, medium_default, excluded, responses_only, astra, unlisted, other):
        assert got[row.pk] == (False, False), row.model


def test_tools_declaration_mirrors_the_seed_and_never_strict_without_tools():
    import importlib

    migration = importlib.import_module(
        "dj.apps.openai.migrations.0027_aimodel_supports_strict_tools")
    assert set(migration.TOOL_MODELS) == set(seed_ai_models.TOOL_MODELS)
    assert set(migration.STRICT_TOOL_MODELS) == set(seed_ai_models.STRICT_TOOL_MODELS)
    assert set(migration.STRICT_TOOL_MODELS) <= set(migration.TOOL_MODELS)
    assert len(migration.TOOL_MODELS) == len(set(migration.TOOL_MODELS)) == 17
    lineup = {(p, m) for p, m, *_ in seed_ai_models.LINEUP}
    assert set(migration.TOOL_MODELS) <= lineup
    assert {p for p, _ in migration.TOOL_MODELS} == {OPENAI}
    # OpenAI restricts these on Chat Completions at the gateway's (absent =
    # model default) reasoning effort; see 0027's docstring.
    assert {m for p, m, *_ in seed_ai_models.LINEUP
            if p == OPENAI and (OPENAI, m) not in set(migration.TOOL_MODELS)} == {
        "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
        "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"}


def test_the_seed_command_declares_tools_on_create_only():
    """A fresh row gets the declaration; an operator's ``false`` on an
    existing row survives a reseed (0024's create-only rule)."""
    AIModel.objects.filter(provider=OPENAI, model__in=["gpt-4.1", "gpt-6.1-sol"]).delete()
    call_command("seed_ai_models", stdout=io.StringIO())
    fresh = AIModel.objects.get(provider=OPENAI, model="gpt-4.1")
    assert (fresh.supports_tools, fresh.supports_strict_tools) == (True, True)
    sol = AIModel.objects.get(provider=OPENAI, model="gpt-6.1-sol")
    assert (sol.supports_tools, sol.supports_strict_tools) == (False, False)
    AIModel.objects.filter(pk=fresh.pk).update(supports_tools=False, supports_strict_tools=False)
    call_command("seed_ai_models", stdout=io.StringIO())
    fresh.refresh_from_db()
    assert (fresh.supports_tools, fresh.supports_strict_tools) == (False, False)


# ------------------------------------------ reasoning_effort (zuu#1170)

_0028 = "dj.apps.openai.migrations.0028_aimodel_reasoning_effort"


def test_reasoning_effort_declaration_names_exact_rows_only():
    """Migration 0028 declares ``reasoning_effort`` (+ its levels, +
    ``reasoning``) for the reviewed aliases only. A pinned snapshot, a
    non-reasoning model, grok-4.3, another provider's row and an unlisted
    name all stay off with no list."""
    import importlib

    from django.apps import apps

    migration = importlib.import_module(_0028)
    names = ["gpt-5", "o3", "gpt-6.1-sol", "gpt-5.4", "gpt-4o", "grok-4.5", "grok-4.3",
             "claude-sonnet-5"]
    AIModel.objects.filter(model__in=names).delete()
    alias = _model(model="gpt-5")
    explicit = _model(model="o3", provider_model_id="o3")
    xhigh = _model(model="gpt-6.1-sol")
    grok = _model(provider=XAI, model="grok-4.5")
    pinned = _model(model="gpt-5.4", provider_model_id="gpt-5.4-2026-03-05")
    not_reasoning = _model(model="gpt-4o")
    grok43 = _model(provider=XAI, model="grok-4.3")
    claude = _model(provider=ANTHROPIC, model="claude-sonnet-5")
    unlisted = _model(model=f"gpt-{uuid.uuid4().hex[:6]}")
    wrong_provider = _model(provider=KIMI, model="o3-mini")
    import datetime
    old = datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc)
    AIModel.objects.update(updated_at=old)
    migration.declare(apps, None)
    # updated_at moves on a declared row (the signed catalogue's content
    # revision follows it) and stays put elsewhere.
    assert AIModel.objects.get(pk=alias.pk).updated_at > old
    assert AIModel.objects.get(pk=pinned.pk).updated_at == old
    got = {r.pk: (r.supports_reasoning_effort, r.supports_reasoning, r.reasoning_effort_levels)
           for r in AIModel.objects.all()}
    assert got[alias.pk] == (True, True, ["minimal", "low", "medium", "high"])
    assert got[explicit.pk] == (True, True, ["low", "medium", "high"])
    assert got[xhigh.pk] == (True, True, ["low", "medium", "high", "xhigh"])
    assert got[grok.pk] == (True, True, ["low", "medium", "high"])
    for row in (pinned, not_reasoning, grok43, claude, unlisted, wrong_provider):
        assert got[row.pk] == (False, False, []), row.model


def test_reasoning_effort_declaration_mirrors_the_seed_and_the_vocabulary():
    import importlib

    from dj.apps.openai.models import REASONING_EFFORT_LEVELS

    migration = importlib.import_module(_0028)
    assert {k: tuple(v) for k, v in migration.REASONING_EFFORT_LEVELS.items()} == {
        k: tuple(v) for k, v in seed_ai_models.REASONING_EFFORT_LEVELS.items()}
    lineup = {(p, m) for p, m, *_ in seed_ai_models.LINEUP}
    assert set(migration.REASONING_EFFORT_LEVELS) <= lineup
    assert {p for p, _ in migration.REASONING_EFFORT_LEVELS} == {OPENAI, XAI}
    order = {level: i for i, level in enumerate(REASONING_EFFORT_LEVELS)}
    for key, levels in migration.REASONING_EFFORT_LEVELS.items():
        assert levels, key
        # Distinct, known, in increasing effort; nothing the wire refuses as
        # a provider default (`none`/`max` wait for the gateway slice).
        assert [order[level] for level in levels] == sorted({order[l] for l in levels}), key
        assert not {"none", "max"} & set(levels), key
    # Per-model evidence (0028's docstring): minimal only on the GPT-5
    # family, xhigh only where the model page lists it, grok-4.3 off.
    assert {m for (_, m), lv in migration.REASONING_EFFORT_LEVELS.items() if "minimal" in lv} == {
        "gpt-5", "gpt-5-mini", "gpt-5-nano"}
    assert {m for (_, m), lv in migration.REASONING_EFFORT_LEVELS.items() if "xhigh" in lv} == {
        "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "gpt-5.6-sol",
        "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra",
        "gpt-6.1-sol"}
    assert (XAI, "grok-4.3") not in migration.REASONING_EFFORT_LEVELS
    assert not any(m.startswith(("gpt-4o", "gpt-4.1")) for _, m in migration.REASONING_EFFORT_LEVELS)


def test_the_seed_command_declares_reasoning_effort_on_create_only():
    AIModel.objects.filter(provider=OPENAI, model__in=["o4-mini", "gpt-4.1"]).delete()
    call_command("seed_ai_models", stdout=io.StringIO())
    fresh = AIModel.objects.get(provider=OPENAI, model="o4-mini")
    assert (fresh.supports_reasoning_effort, fresh.reasoning_effort_levels) == (
        True, ["low", "medium", "high"])
    plain = AIModel.objects.get(provider=OPENAI, model="gpt-4.1")
    assert (plain.supports_reasoning_effort, plain.reasoning_effort_levels) == (False, [])
    AIModel.objects.filter(pk=fresh.pk).update(supports_reasoning_effort=False)
    call_command("seed_ai_models", stdout=io.StringIO())
    fresh.refresh_from_db()
    assert fresh.supports_reasoning_effort is False


@pytest.mark.parametrize("levels,ok", [
    ([], True), (["low"], True), (["none", "minimal", "low", "medium", "high", "xhigh", "max"], True),
    (["low", "low"], False), (["High"], False), (["ultra"], False), ("low", False),
    ([1], False), (None, False),
])
def test_level_validator_refuses_what_the_signer_would_exclude(levels, ok):
    from django.core.exceptions import ValidationError

    from dj.apps.openai.models import validate_reasoning_effort_levels

    if ok:
        validate_reasoning_effort_levels(levels)
    else:
        with pytest.raises(ValidationError):
            validate_reasoning_effort_levels(levels)


@pytest.mark.parametrize("value", [{}, "", None, 0, ["High"]])
def test_full_clean_refuses_empty_non_list_levels_the_field_validator_skips(value):
    """``blank=True`` skips field validators for {}/""/None; ``clean()``
    must still refuse them, or the admin saves a value that excludes the
    model from the signed catalogue."""
    from django.core.exceptions import ValidationError

    row = _model()
    row.reasoning_effort_levels = value
    with pytest.raises(ValidationError) as exc:
        row.full_clean()
    assert "reasoning_effort_levels" in exc.value.message_dict
    # Negative control: the empty LIST is the legitimate "no list".
    row.reasoning_effort_levels = []
    row.full_clean()
