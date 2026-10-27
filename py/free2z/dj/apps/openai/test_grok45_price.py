"""grok-4.5 is charged at least what xAI bills for it.

xAI, https://docs.x.ai/docs/models (fetched 2026-10-04), per 1M tokens:

    prompt < 200k tokens:   $2.00 in   $6.00 out
    prompt >= 200k tokens:  $4.00 in  $12.00 out   (for ALL tokens of the request)

Migration ``0016`` seeded $1.25 / $2.50, and the live Django charge
(``AIModel.get_tuzi_price``, markup 1.5) therefore sold it at $1.875 / $3.75.
``0023_grok45_xai_price`` raises the row to xAI's price and caps its window so
a trimmed prompt stays below the long-context threshold.
"""

import importlib
from decimal import Decimal

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

from f2z.ai.providers import XAI

from .management.commands.seed_ai_models import (
    DEFAULT_MARKUP, DJANGO_CHARGE_OVERRIDES, LINEUP, django_lineup,
    rate_card_rows,
)
from .models import DEFAULT_SAFETY_FACTOR_BPS, AIModel

MIGRATION = importlib.import_module(
    "dj.apps.openai.migrations.0023_grok45_xai_price")

BEFORE = [("openai", "0022_aimodel_idle_timeout_ms")]
AFTER = [("openai", "0023_grok45_xai_price")]

# xAI's own numbers, written out here rather than imported, so the test checks
# the code against the provider and not against itself. USD per 1M tokens.
XAI_SHORT_IN, XAI_SHORT_OUT = Decimal("2.00"), Decimal("6.00")
XAI_LONG_CONTEXT_THRESHOLD = 200_000

# (prompt tokens, reply tokens): a one-liner, a typical exchange, a long reply,
# an output-only reply, and a maximally packed conversation (filled in below).
SAMPLE_REPLIES = [(1, 1), (40, 300), (2_000, 800), (12_000, 8_192), (0, 8_192)]


def _xai_cost_2z(prompt_tokens, reply_tokens):
    """What xAI bills us for one short-context request, in 2Z ($0.01 each)."""
    usd = (prompt_tokens * XAI_SHORT_IN + reply_tokens * XAI_SHORT_OUT) / 1_000_000
    return usd * 100


# The migration tests below roll the schema back to 0022, where any column a
# LATER migration adds does not exist yet; a plain ``AIModel.objects`` read
# would SELECT it and fail. Read only the columns this file is about.
_COLUMNS = ("provider", "model", "input_price", "output_price", "max_tokens",
            "max_output_tokens", "max_response_tokens", "markup", "updated_at")


def _rows():
    return AIModel.objects.only(*_COLUMNS)


def _live_row():
    return _rows().get(provider=XAI, model="grok-4.5")


@pytest.mark.django_db
def test_every_sample_reply_is_charged_at_least_what_xai_bills():
    """The row ``migrate`` leaves behind (this DB was built by running every
    migration, 0016 included) charges no reply below provider cost.

    SCOPE: per token, for the tokens Django counts -- the prompt and the
    VISIBLE reply. xAI also bills reasoning tokens, which ``generate_reply``
    never counts ( §3.4, pre-existing); this test says nothing about
    them, and neither does the price fix."""
    row = _live_row()
    samples = SAMPLE_REPLIES + [(row.get_input_token_budget(),
                                 row.get_output_token_reserve())]
    for prompt_tokens, reply_tokens in samples:
        charged = row.get_tuzi_price(prompt_tokens, reply_tokens)
        cost = _xai_cost_2z(prompt_tokens, reply_tokens)
        assert charged >= cost, (prompt_tokens, reply_tokens, charged, cost)


@pytest.mark.django_db
def test_a_packed_prompt_stays_below_the_long_context_threshold():
    """A short-context price x1.5 cannot cover xAI's 2x long-context rate
    ($3.00 charged vs $4.00 billed per 1M input), so the trimmed prompt must
    never reach 200k -- even if xAI's tokenizer counts 15% more than our
    tiktoken estimate does."""
    row = _live_row()
    margin = Decimal(DEFAULT_SAFETY_FACTOR_BPS) / 10_000
    assert row.get_input_token_budget() * margin < XAI_LONG_CONTEXT_THRESHOLD
    assert row.max_tokens <= MIGRATION.MAX_TOKENS
    # Codex review: it must hold for ANY reserve, not just today's 8192 --
    # the reserve is clamped to max_response_tokens and both are editable.
    for ceiling in (8192, 4096, 1, 0):
        row.max_response_tokens = ceiling
        assert row.get_input_token_budget() * margin < XAI_LONG_CONTEXT_THRESHOLD, ceiling
    # And the reason the cap is needed at all: at the long-context rate the
    # short-context price would lose money.
    assert Decimal(row.input_price) * Decimal(DEFAULT_MARKUP) * 1_000_000 < 2 * XAI_SHORT_IN


def test_the_seed_command_writes_what_the_migration_writes():
    """A hand-run ``seed_ai_models`` must not undo 0023 (it update_or_creates
    prices). Since rate card v3 the override is LINEUP's own value, so the
    lineup -- not an override -- must carry at least what 0023 wrote, and the
    override table must be empty rather than silently re-lowering it."""
    assert DJANGO_CHARGE_OVERRIDES == {}
    # Prices only: GATEWAY_FENCE_CAPS (openai 0030) deliberately narrows
    # gpt-4.1's window/ceiling, which is not a charge override.
    assert [r[:5] for r in django_lineup()] == [r[:5] for r in LINEUP]
    seeded = {row[:2]: row for row in LINEUP}[(XAI, "grok-4.5")]
    assert Decimal(seeded[3]) >= MIGRATION.INPUT_PRICE
    assert Decimal(seeded[4]) >= MIGRATION.OUTPUT_PRICE
    assert seeded[5] <= MIGRATION.MAX_TOKENS


def test_the_rate_card_carries_the_same_price_as_the_django_row():
    """v2 sold grok-4.5 on the card at $1.25 / $2.50 while 0023 charged the
    Django path $2 / $6 -- the split  item 3 named. v3 closes it: the
    card row is derived from LINEUP and equals xAI's price exactly."""
    grok = {r["model_id"]: r for r in rate_card_rows()}["grok-4.5"]
    assert grok["input_nusd_per_mtok"] == int(XAI_SHORT_IN * 1_000_000_000)
    assert grok["output_nusd_per_mtok"] == int(XAI_SHORT_OUT * 1_000_000_000)


# --- the migration itself, forward and back -------------------------------


def _migrate(targets):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(targets)


def _set(**fields):
    AIModel.objects.filter(provider=XAI, model="grok-4.5").update(**fields)


def _state():
    row = _live_row()
    return row.input_price, row.output_price, row.max_tokens


OLD = (MIGRATION.PREVIOUS_INPUT_PRICE, MIGRATION.PREVIOUS_OUTPUT_PRICE,
       MIGRATION.PREVIOUS_MAX_TOKENS)
NEW = (MIGRATION.INPUT_PRICE, MIGRATION.OUTPUT_PRICE, MIGRATION.MAX_TOKENS)


@pytest.mark.django_db
def test_forward_then_back_then_forward_again():
    _migrate(BEFORE)
    assert _state() == OLD  # what 0016 seeded
    _migrate(AFTER)
    assert _state() == NEW
    _migrate(BEFORE)
    assert _state() == OLD
    _migrate(AFTER)
    assert _state() == NEW


@pytest.mark.django_db
def test_forward_is_idempotent_and_stamps_updated_at_once():
    _migrate(BEFORE)
    _migrate(AFTER)
    stamped = _live_row().updated_at
    # The historical models AT 0023, as `migrate` would hand them over -- the
    # live registry has columns later migrations add, absent from this schema.
    apps = MigrationExecutor(connection).loader.project_state(AFTER).apps
    MIGRATION.raise_to_cost(apps, None)
    assert _state() == NEW
    assert _live_row().updated_at == stamped  # nothing to raise, nothing written


@pytest.mark.django_db
def test_forward_never_lowers_an_operator_raised_price_or_window():
    _migrate(BEFORE)
    _set(input_price=Decimal("0.000003"), output_price=Decimal("0.00001"),
         max_tokens=120_000)
    _migrate(AFTER)
    assert _state() == (Decimal("0.000003"), Decimal("0.00001"), 120_000)
    #...and the reverse leaves a row it did not write alone.
    _migrate(BEFORE)
    assert _state() == (Decimal("0.000003"), Decimal("0.00001"), 120_000)


@pytest.mark.django_db
def test_reverse_leaves_a_row_edited_after_the_forward_alone():
    _migrate(BEFORE)
    _migrate(AFTER)
    _set(output_price=Decimal("0.000008"))
    _migrate(BEFORE)
    assert _state() == (MIGRATION.INPUT_PRICE, Decimal("0.000008"),
                        MIGRATION.MAX_TOKENS)


@pytest.mark.django_db
def test_reverse_never_lowers_a_value_the_forward_did_not_write():
    """Codex review: an operator at $3 in / $6 out / 172000 is a row the
    forward leaves untouched (nothing below cost). Restoring field by field
    would then drop their output to $2.50 and widen the window to 256000."""
    _migrate(BEFORE)
    _set(input_price=Decimal("0.000003"), output_price=Decimal("0.000006"),
         max_tokens=172_000)
    _migrate(AFTER)
    _migrate(BEFORE)
    assert _state() == (Decimal("0.000003"), Decimal("0.000006"), 172_000)


@pytest.mark.django_db
def test_no_other_row_moves():
    _migrate(BEFORE)
    before = {
        (m.provider, m.model): (m.input_price, m.output_price, m.max_tokens,
                                m.markup)
        for m in _rows().exclude(provider=XAI, model="grok-4.5")
    }
    assert ("xai", "grok-4.3") in before
    _migrate(AFTER)
    after = {
        (m.provider, m.model): (m.input_price, m.output_price, m.max_tokens,
                                m.markup)
        for m in _rows().exclude(provider=XAI, model="grok-4.5")
    }
    assert after == before
