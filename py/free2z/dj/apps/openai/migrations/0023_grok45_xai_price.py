"""Stop selling grok-4.5 below what xAI charges for it (#2224).

THE LOSS. ``0016_seed_multiprovider_ai_models`` seeded grok-4.5 at $1.25 in /
$2.50 out per 1M tokens. The live Django chat charge is
``AIModel.get_tuzi_price`` = (in * input_price + out * output_price) * 100 *
markup, and markup is 1.5, so a user paid $1.875 / $3.75 per 1M. xAI now bills
grok-4.5 at $2.00 in / $6.00 out (https://docs.x.ai/docs/models, fetched
2026-10-04: ``promptTextTokenPrice "20000"`` and ``completionTextTokenPrice
"60000"`` in units of $0.0001 per 1M). Every grok-4.5 reply lost money on
output, and on input too.

THE FIX, AND ONLY THIS. The grok-4.5 row(s) get xAI's current short-context
prices, so markup 1.5 now charges $3.00 / $9.00 per 1M. Nothing else changes:
not grok-4.3, not the markup, and not the gateway's rate card (``pricing``
cards are immutable and repricing them is a separate decision, tracked on
#2224).

THE LONG-CONTEXT TIER. xAI bills a request "whose prompt reaches the listed
token threshold" at the higher rate for ALL its tokens: grok-4.5's
``longContextThreshold`` is 200000, at $4.00 in / $12.00 out. A single
short-context price cannot cover that ($3.00 charged < $4.00 cost), so the row's
context window (``max_tokens``, which ``build_messages`` trims the prompt to,
less the reserve) is capped at 172000. The cap is sized on the WHOLE window,
not on window minus today's 8192 reserve: the reserve is clamped to
``max_response_tokens`` and both are admin-editable, so a cap that relied on
it would quietly stop holding when an operator shortened replies (codex
review). Any trimmed prompt is therefore under 172000 tokens BY OUR COUNT --
tiktoken ``cl100k_base``, not xAI's own tokenizer -- and 172000 * 1.15 (the
repo's default tokenizer safety factor, ``DEFAULT_SAFETY_FACTOR_BPS``) is
197800, still under the threshold.
The same number is the signed gateway catalogue's ``context_window``.

What the cap does NOT cover: a conversation whose FIRST turn alone is bigger
than the budget. ``build_messages`` cannot trim below [system, current turn],
and the conversation path sends that turn anyway with a shrunken output cap, so
a single >200k-token message still reaches xAI and is billed long-context.
Pre-existing, documented on #2224 as a follow-up; the conversation-less prompt
endpoint already refuses it with a 400.

NEVER LOWERS. A price already ABOVE xAI's (an operator who raised it in the
admin) is kept, and so is a context window already below the cap. The
migration only ever moves a row toward "charges at least cost".

IDEMPOTENT: a second run finds nothing to raise and writes nothing.

REVERSIBLE, best-effort: the reverse restores 0016's prices and 256000 window
only on a row whose price AND window are all exactly what the forward writes.
A row the forward only partly changed, or one an operator has edited since,
is left alone -- restoring field by field would lower a value the forward
never touched (an operator's own $6.00 output, say). Residual, accepted: a row
an operator had ALREADY hand-set to exactly some of these values before the
forward ran is indistinguishable from one the forward wrote, and is restored
too. Nothing recorded the pre-forward state, and the reverse only runs when a
human deliberately migrates back (an image rollback does not reverse data). It cannot recover a
pre-forward admin edit that the forward overwrote (there is nowhere to have
stored it); the forward's only overwrite is a value that was below cost.

The 1.15 tokenizer margin is an ASSUMPTION, not a measured bound on how
xAI's tokenizer counts against ``cl100k_base``. And the charge counts visible
reply text only, never the reasoning tokens xAI also bills (#1033 §3.4) --
this migration fixes the per-token price, not what is counted.

``updated_at`` is stamped because ``QuerySet.update()`` skips ``auto_now``,
and the signed catalogue's version is ``max(updated_at)``: stamping it puts
the new window in front of a running gateway on its next poll instead of
within the next minute.

The values are a frozen copy of ``DJANGO_CHARGE_OVERRIDES`` in
``dj/apps/openai/management/commands/seed_ai_models.py`` (migrations must not
import live code); ``test_grok45_price.py`` enforces the mirror.
"""

from decimal import Decimal

from django.db import migrations
from django.utils import timezone


PROVIDER = "xai"
MODEL = "grok-4.5"

# xAI short-context list price, USD per token.
INPUT_PRICE = Decimal("0.000002")    # $2.00 / 1M
OUTPUT_PRICE = Decimal("0.000006")   # $6.00 / 1M
# Context window cap: 172000 * 1.15 < xAI's 200000-token long-context
# threshold, whatever the reserve is set to (see docstring).
MAX_TOKENS = 172000

# What 0016 seeded -- the reverse's target.
PREVIOUS_INPUT_PRICE = Decimal("0.00000125")
PREVIOUS_OUTPUT_PRICE = Decimal("0.0000025")
PREVIOUS_MAX_TOKENS = 256000


def raise_to_cost(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    for row in AIModel.objects.filter(provider=PROVIDER, model=MODEL):
        changes = {}
        if row.input_price < INPUT_PRICE:
            changes["input_price"] = INPUT_PRICE
        if row.output_price < OUTPUT_PRICE:
            changes["output_price"] = OUTPUT_PRICE
        if row.max_tokens > MAX_TOKENS:
            changes["max_tokens"] = MAX_TOKENS
        if changes:
            changes["updated_at"] = timezone.now()
            AIModel.objects.filter(pk=row.pk).update(**changes)


def restore_previous(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    AIModel.objects.filter(
        provider=PROVIDER, model=MODEL,
        input_price=INPUT_PRICE, output_price=OUTPUT_PRICE,
        max_tokens=MAX_TOKENS,
    ).update(
        input_price=PREVIOUS_INPUT_PRICE,
        output_price=PREVIOUS_OUTPUT_PRICE,
        max_tokens=PREVIOUS_MAX_TOKENS,
        updated_at=timezone.now(),
    )


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0022_aimodel_idle_timeout_ms"),
    ]

    operations = [
        migrations.RunPython(raise_to_cost, restore_previous),
    ]
