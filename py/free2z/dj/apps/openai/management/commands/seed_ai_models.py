"""Seed / update the AIModel catalog for the multi-provider AI backend.

Idempotent: re-running updates the pricing/metadata for each (provider, model)
pair without creating duplicates.

NOTE: The exact non-Anthropic model IDs (OpenAI, xAI, Kimi) shift month to
month. They are admin-adjustable in the Django admin — treat the values here as
sensible defaults, not gospel. ``input_price`` / ``output_price`` are PER-TOKEN
decimals (e.g. $5 / 1M tokens == 0.000005).

Three token columns, and they mean three different things:

* ``max_tokens`` — the model's TOTAL context window. Prompt and reply are
  charged against this one number by every provider.
* ``max_output_tokens`` — the RESERVE, despite the name: the slice of that
  window ``build_messages`` keeps free when trimming, i.e. the shortest reply a
  maximally packed conversation is still guaranteed room for. The name is
  's and is kept deliberately -- see the note at the top of
  ``dj/apps/openai/models.py``.
* ``max_response_tokens`` — the LONGEST single reply the model will produce.
  The ceiling on a request's ``max_output_tokens`` body field, and the default
  when a request names none. Set it above what the provider accepts and the
  requests that reach for it earn a 400.
"""

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q

from dj.apps.openai.cache_pricing import (
    CACHE_PRICE_FRACTIONS, MODEL_CACHE_PRICE_FRACTIONS,
)
from dj.apps.openai.models import MAX_IDLE_TIMEOUT_MS, AIModel
from dj.apps.pricing.ai import nusd_per_mtok_from_usd_per_token
from dj.apps.pricing.models import RateCard
from dj.apps.pricing.provider_billing import TOKEN_BILLED_IMAGE_PROVIDERS
from dj.apps.pricing.rate_card_seeds import (
    newest_seed,
    next_seed_migration_name,
    seed_migrations,
    seed_rows,
)
from f2z.ai.providers import (
    ANTHROPIC, OPENAI, XAI, KIMI, POLICY_DISABLED_PROVIDERS,
    model_is_retired,
)


GENERIC_SYSTEM_MESSAGE = (
    "You are a helpful, knowledgeable, and friendly assistant. "
    "Answer clearly and concisely, and ask for clarification when a request is "
    "ambiguous."
)

DEFAULT_MARKUP = "1.5"

# NOTE: this lineup is mirrored (frozen) in the data migrations
# ``0016_seed_multiprovider_ai_models`` (the first lineup) and
# ``0026_seed_lineup_v3`` (this one), so stage/prod get seeded on deploy.
# ``test_lineup_v3_migration.py`` enforces that 0026's copy equals LINEUP;
# changing a price or a window here means a NEW openai data migration (and a
# NEW rate-card seed, see below), never an edit to an applied one.
#
# SAFE DEFAULT: the ZUULI picker defaults to the highest-``order`` GA model.
# On stage/prod only ``OPENAI_API_KEY`` is guaranteed set, so ``gpt-4o`` — a
# valid, keyed-today OpenAI model — gets the TOP order. Every other model sits
# below it. Once the operator sets ANTHROPIC/XAI/MOONSHOT keys and verifies
# the exact model IDs, they can promote a flagship (raise its ``order``) via
# the Django admin. A keyless provider must never be the crashing default.
#
# AVAILABILITY IS DISCOVERED, NOT ASSERTED ( follow-up, "programmatic
# discovery"). A row here is only SOLD -- by the signed gateway catalogue and
# by the chat picker -- when the provider's own model list (``GET
# /v1/models``, recorded by ``manage.py discover_ai_models`` into
# ``ProviderModel``) names its upstream id. See ``AIModelQuerySet.discovered``.
#
# PRICES ARE THE PROVIDERS' OFFICIAL LIST PRICES, USD PER TOKEN, verified on
# 2026-10-05 against:
#   OpenAI    https://developers.openai.com/api/docs/pricing.md and
#             https://developers.openai.com/api/docs/models/<id>.md (per row)
#   Anthropic https://platform.claude.com/docs/en/docs/about-claude/pricing
#   xAI       https://docs.x.ai/docs/models
#   Moonshot  https://platform.moonshot.ai/docs/pricing/chat (2026-10-04)
# Cache-class prices are in ``MODEL_CACHE_PRICE_FRACTIONS`` below.
#
# LONG-CONTEXT TIERS ARE CAPPED OUT, NOT PRICED ( decision (b)). OpenAI
# bills a request whose input exceeds 272K tokens at 2x input / 1.5x output
# FOR THE WHOLE REQUEST on gpt-6-*, gpt-5.6-*, gpt-5.5 and gpt-5.4; xAI does
# the same from a 200K prompt on every grok model. The card has ONE price per
# class, so those rows' ``max_tokens`` (the context window ``build_messages``
# trims to and the catalogue's ``context_window``) is capped BELOW the
# threshold divided by the x1.15 tokenizer safety factor: 236000 x 1.15 =
# 271400 < 272000 (OpenAI), 172000 x 1.15 = 197800 < 200000 (xAI, as
# ``0023_grok45_xai_price`` set it). Tiered pricing is zuu#1121 /  and
# lifts the caps when it lands. ``test_lineup_v3_migration.py`` pins every
# cap against the provider threshold.
#
# (provider, model, display_name, input_price, output_price, max_tokens,
#  max_output_tokens (= the RESERVE), max_response_tokens, order, is_ga)
#
# ``max_output_tokens`` is unchanged from  in name AND value (8192, or
# 16384 for the reasoning families -- gpt-5.x, gpt-6, o-series -- where
# reasoning tokens are billed as output and consume the same budget). It is
# what a maximally packed conversation still has room to answer with, so it is
# deliberately NOT the ceiling: reserving the ceiling would take 112k tokens of
# memory away from every gpt-5.6 conversation to guarantee a length hardly any
# request asks for.
#
# ``max_response_tokens`` is each provider's own DOCUMENTED maximum output for
# that model, because the requester -- not us -- decides how long a reply they
# want and pre-covers it ( §3.1 follow-up). It exists to bound a 400 from
# the provider for asking beyond its limit, which is why it is only raised
# where the number is documented: a request that names no length now reaches
# this ceiling, so a guess that is too high breaks the model for every ordinary
# request rather than shortening one long answer. What actually limits ONE
# reply in production is neither of these but nginx's 200s
# `proxy_read_timeout` on /api -- see AI_CHAT_DEADLINE_SECONDS.

#OpenAI's ">272K input tokens" long-context threshold, and the window that
#keeps a x1.15-counted prompt under it.
OPENAI_LONG_CONTEXT_THRESHOLD = 272_000
OPENAI_TIERED_CONTEXT_CAP = 236_000
#xAI's ">= 200K prompt tokens" threshold and the window 0023 chose for it.
XAI_LONG_CONTEXT_THRESHOLD = 200_000
XAI_TIERED_CONTEXT_CAP = 172_000

LINEUP = [
    # --- OpenAI ---
    # Safe default: valid + keyed today, so it sits at the top of the picker.
    # 16384 is gpt-4o's documented maximum output -- 's 8192 halved it.
    (OPENAI, "gpt-4o", "GPT-4o", "0.0000025", "0.00001", 128000, 8192, 16384, 200, True),

    # OpenAI, long-context TIERED (window capped at OPENAI_TIERED_CONTEXT_CAP).
    # Documented window 1,050,000 / max output 128,000 for every one of these.
    (OPENAI, "gpt-6.1-sol", "GPT-6.1 Sol", "0.000002", "0.00001", 236000, 16384, 128000, 150, True),
    (OPENAI, "gpt-6-astra", "GPT-6 Astra", "0.00001", "0.00005", 236000, 8192, 128000, 145, True),
    (OPENAI, "gpt-6-sol", "GPT-6 Sol", "0.000002", "0.00001", 236000, 16384, 128000, 140, True),
    (OPENAI, "gpt-6-luna", "GPT-6 Luna", "0.0000001", "0.0000005", 236000, 16384, 128000, 135, True),
    (OPENAI, "gpt-5.5", "GPT-5.5", "0.000005", "0.00003", 236000, 16384, 128000, 130, True),
    (OPENAI, "gpt-5.4", "GPT-5.4", "0.0000025", "0.000015", 236000, 16384, 128000, 125, True),
    # gpt-5.6-sol is on a PROMO ($4 / $20 "at least through 2026-11-21") that
    # the page calls a 20 % / 33 % reduction, i.e. from $5 / $30. Priced at the
    # pre-promo rate on purpose: a card is immutable and nothing here can
    # expire a price, so passing the promo through would turn into an
    # undercharge the day it ends. Passing it through is a new card plus a
    # follow-up card before 2026-11-21 -- an owner decision .
    (OPENAI, "gpt-5.6-sol", "GPT-5.6 Sol", "0.000005", "0.00003", 236000, 16384, 128000, 95, True),
    (OPENAI, "gpt-5.6-terra", "GPT-5.6 Terra", "0.000002", "0.000012", 236000, 16384, 128000, 85, True),
    (OPENAI, "gpt-5.6-luna", "GPT-5.6 Luna", "0.0000002", "0.0000012", 236000, 16384, 128000, 40, True),

    # OpenAI, flat-priced (no long-context tier on the pricing page).
    (OPENAI, "gpt-5.4-mini", "GPT-5.4 mini", "0.00000075", "0.0000045", 400000, 16384, 128000, 120, True),
    (OPENAI, "gpt-5.4-nano", "GPT-5.4 nano", "0.0000002", "0.00000125", 400000, 16384, 128000, 115, True),
    (OPENAI, "gpt-5.2", "GPT-5.2", "0.00000175", "0.000014", 400000, 16384, 128000, 110, True),
    (OPENAI, "gpt-5.1", "GPT-5.1", "0.00000125", "0.00001", 400000, 16384, 128000, 105, True),
    (OPENAI, "gpt-5", "GPT-5", "0.00000125", "0.00001", 400000, 16384, 128000, 103, True),
    (OPENAI, "gpt-5-mini", "GPT-5 mini", "0.00000025", "0.000002", 400000, 16384, 128000, 102, True),
    (OPENAI, "gpt-5-nano", "GPT-5 nano", "0.00000005", "0.0000004", 400000, 16384, 128000, 101, True),
    (OPENAI, "gpt-4.1", "GPT-4.1", "0.000002", "0.000008", 1047576, 8192, 32768, 75, True),
    (OPENAI, "gpt-4.1-mini", "GPT-4.1 mini", "0.0000004", "0.0000016", 1047576, 8192, 32768, 72, True),
    (OPENAI, "gpt-4.1-nano", "GPT-4.1 nano", "0.0000001", "0.0000004", 1047576, 8192, 32768, 71, True),
    (OPENAI, "gpt-4o-mini", "GPT-4o mini", "0.00000015", "0.0000006", 128000, 8192, 16384, 65, True),
    (OPENAI, "o3", "o3", "0.000002", "0.000008", 200000, 16384, 100000, 35, True),
    (OPENAI, "o4-mini", "o4-mini", "0.0000011", "0.0000044", 200000, 16384, 100000, 34, True),
    (OPENAI, "o3-mini", "o3-mini", "0.0000011", "0.0000044", 200000, 16384, 100000, 33, True),
    (OPENAI, "o1", "o1", "0.000015", "0.00006", 200000, 8192, 100000, 32, True),

    # --- Anthropic ---
    # Sonnet 5: the $2 / $10 launch price "is now the standard price" (the
    # page's footnote 3); v1/v2 carried $3 / $15.
    (ANTHROPIC, "claude-opus-4-8", "Claude Opus 4.8", "0.000005", "0.000025", 200000, 8192, 32000, 100, True),
    (ANTHROPIC, "claude-sonnet-5", "Claude Sonnet 5", "0.000002", "0.00001", 200000, 8192, 64000, 90, True),
    (ANTHROPIC, "claude-haiku-4-5", "Claude Haiku 4.5", "0.000001", "0.000005", 200000, 8192, 64000, 50, True),

    # --- xAI ---
    # Both rows are capped at XAI_TIERED_CONTEXT_CAP (see above; grok-4.5's
    # cap and price came from ``0023_grok45_xai_price``, grok-4.3's cap is
    # new: its $2.50 / $5.00 tier from 200K is 2x the short-context price).
    # xAI publishes a context window but NOT a separate output limit, so grok
    # keeps exactly 's number. The default reply length now reaches this
    # ceiling on every ordinary request, so a guess that is too high is a
    # provider 400 for the whole model -- much worse than one shortened
    # answer. Raise it in the admin once the real limit is known.
    (XAI, "grok-4.5", "Grok 4.5", "0.000002", "0.000006", 172000, 8192, 8192, 80, True),
    (XAI, "grok-4.3", "Grok 4.3", "0.00000125", "0.0000025", 172000, 8192, 8192, 70, True),

    # --- Kimi (Moonshot) ---
    # Left at is_ga=True on purpose even though Kimi is flagged off: the
    # policy is expressed ONCE, in DISABLED_PROVIDERS, and `handle()` derives
    # the effective `is_ga` from it. Hardcoding False here would make removing
    # Kimi from the policy list restore translation (which keys off
    # `is_enabled`) but silently NOT restore chat (which keys off `is_ga`) --
    # and any manual admin fix would be undone by the next seed run. Found by
    # the codex adversarial review. Priced at Moonshot's list price so that
    # lifting the ban can never silently undercharge .
    (KIMI, "kimi-k3", "Kimi K3", "0.000003", "0.000015", 256000, 8192, 16384, 60, True),
    (KIMI, "kimi-k2.6", "Kimi K2.6", "0.00000095", "0.000004", 256000, 8192, 16384, 45, True),
]

# Django chat-charge values that DELIBERATELY differ from LINEUP.
#
# LINEUP's prices also derive the gateway's rate card (``rate_card_rows``
# below), and a card is an immutable, reviewed publication -- so a provider
# raising its price cannot wait for the next card when the LIVE Django charge
# (``AIModel.get_tuzi_price``) is selling below cost. Values here reach only
# the ``AIModel`` row this command writes; ``rate_card_rows`` keeps reading
# LINEUP. Delete an entry once a published card carries the same prices and
# LINEUP has been updated to match (the card-drift test will demand both).
#
# EMPTY since rate card v3: grok-4.5's  override ($2 / $6, 172000 window,
# frozen in ``0023_grok45_xai_price``) is now LINEUP's own value and on the
# card. The mechanism stays for the next time a provider moves first.
DJANGO_CHARGE_OVERRIDES = {}


# SELLABLE window / output ceiling below the provider's documented one, so a
# row can go through the gateway's ``allowed_models`` fence
# (``k8s/f2z-ai/configmap.yaml``) at gpt-4o's risk class. The fence exists for
# the one path that still releases a whole hold: a request written to the
# provider that fails before any response head (a reset, or the 300 s hard
# limit) refunds the input the provider may already have billed. gpt-4.1's
# documented 1M window makes that ~$1.80 per call (900K x $2/M); capped at
# gpt-4o's 128000 it is 128K x $2/M = ~$0.26, the same order as gpt-4o's
# ~$0.32. Its documented 32768 output can also outlive the 300 s deadline;
# 16384 is gpt-4o's ceiling. The gateway enforces both: an estimate over
# ``context_window`` is refused and output is clamped to
# ``max_output_tokens`` (zuu f2z-ai meter.rs).
#
# gpt-4.1-mini / -nano are NOT capped: at a full 1M prompt they refund about
# $0.36 / $0.09 (within gpt-4o's order) and stream far faster, which is why
# the earlier admission admitted them uncapped. LINEUP keeps the DOCUMENTED figures (0026
# mirrors it, the flat-window test checks it against the provider);
# migration ``0030_cap_gpt41_window`` applies these caps to the live row and
# ``test_lineup_v3_migration`` pins that the fence admits gpt-4.1 only
# while both hold. Lifting a cap is a deliberate ConfigMap + migration pair.
GATEWAY_FENCE_CAPS = {
    (OPENAI, "gpt-4.1"): {"max_tokens": 128000, "max_response_tokens": 16384},
}


def django_lineup():
    """LINEUP as the ``AIModel`` rows should hold it: with
    :data:`DJANGO_CHARGE_OVERRIDES` and:data:`GATEWAY_FENCE_CAPS` applied.
    Same tuple shape as LINEUP."""
    rows = []
    for row in LINEUP:
        (provider, model, display_name, input_price, output_price, max_tokens,
         max_output_tokens, max_response_tokens, order, is_ga) = row
        override = DJANGO_CHARGE_OVERRIDES.get((provider, model), {})
        cap = GATEWAY_FENCE_CAPS.get((provider, model), {})
        window = min(override.get("max_tokens", max_tokens), cap.get("max_tokens", max_tokens))
        rows.append((
            provider, model, display_name,
            override.get("input_price", input_price),
            override.get("output_price", output_price),
            window,
            min(max_output_tokens, window),
            min(max_response_tokens, cap.get("max_response_tokens", max_response_tokens), window),
            order, is_ga,
        ))
    return rows


# Signed ``capabilities.structured_output`` (zuu#1128, migration 0024): every
# OpenAI row above documents strict JSON-schema Structured Outputs on its model
# page (``structured_outputs`` in the Features list, fetched 2026-10-05). The
# declaration is by exact (provider, model) and only for a row whose upstream
# id is the alias itself -- an operator pin to another snapshot stays false
# (0024's rule). Other providers stay false until their adapter lands.
# Mirrored (frozen) by migration ``0026_seed_lineup_v3``.
STRUCTURED_OUTPUT_MODELS = frozenset(
    (provider, model) for provider, model, *_ in LINEUP if provider == OPENAI
)

# Signed ``capabilities.tools`` / ``capabilities.strict_tools`` (zuu#1142,
# migration 0027). Every OpenAI row above lists ``function_calling`` and
# ``structured_outputs`` (strict mode "works by leveraging structured outputs"
# -- the function-calling guide) on its model page, fetched 2026-10-05, EXCEPT
# the rows OpenAI restricts on Chat Completions, the only adapter these rows
# use. "Starting with GPT-5.4, Chat Completions does not support tool calling
# with ``reasoning_effort`` values other than ``none``" (migrate-to-responses
# guide): gpt-5.5, gpt-5.6-*, gpt-6-luna and gpt-6-sol default to medium and
# the gateway sends none (the gpt-5.4 family defaults to none, so it stays).
# gpt-6-astra and gpt-6.1-sol: "Chat Completions does not support function
# calling with GPT-6 Astra or GPT-6.1 Sol" (reasoning guide).
# Same alias-only, create-only rule as STRUCTURED_OUTPUT_MODELS.
# Mirrored (frozen) by migration ``0027_aimodel_supports_strict_tools``.
NO_CHAT_COMPLETIONS_TOOLS = frozenset({
    (OPENAI, "gpt-5.5"),
    (OPENAI, "gpt-5.6-luna"),
    (OPENAI, "gpt-5.6-sol"),
    (OPENAI, "gpt-5.6-terra"),
    (OPENAI, "gpt-6-astra"),
    (OPENAI, "gpt-6-luna"),
    (OPENAI, "gpt-6-sol"),
    (OPENAI, "gpt-6.1-sol"),
})
TOOL_MODELS = STRUCTURED_OUTPUT_MODELS - NO_CHAT_COMPLETIONS_TOOLS
STRICT_TOOL_MODELS = TOOL_MODELS

# Signed ``capabilities.reasoning_effort`` + ``controls.effort_levels``
# (zuu#1170, migration 0028). Each model's levels from its own page on
# developers.openai.com/api/docs/models/<id> ("Reasoning.effort supports:..."),
# docs.x.ai's reasoning guide for grok-4.5, fetched 2026-10-05. Only the
# levels in {minimal, low, medium, high, xhigh} are signed: ``none`` and
# ``max`` are documented on several rows but deliberately left for the slice
# that adds them to the gateway wire. Pages that list no levels (o-series,
# gpt-5-mini, gpt-5-nano) get the family's long-standing set (o-series
# low/medium/high; gpt-5 family adds minimal); a wrong level is refused by
# the provider before any output, uncharged. ``supports_reasoning`` is
# declared on the same rows. EVERYTHING ELSE stays false: gpt-4o/4.1 are not
# reasoning models; grok-4.3 is outside the guide's reasoning_effort list
# (its model page disagrees -- off until they agree); Anthropic's Messages
# adapter refuses effort whatever is signed; Kimi is policy-disabled.
# Same alias-only, create-only rule as STRUCTURED_OUTPUT_MODELS.
# Mirrored (frozen) by migration ``0028_aimodel_reasoning_effort``.
_O_SERIES = ("low", "medium", "high")
_GPT5 = ("minimal", "low", "medium", "high")
_XHIGH = ("low", "medium", "high", "xhigh")
REASONING_EFFORT_LEVELS = {
    (OPENAI, "o1"): _O_SERIES,
    (OPENAI, "o3"): _O_SERIES,
    (OPENAI, "o3-mini"): _O_SERIES,
    (OPENAI, "o4-mini"): _O_SERIES,
    (OPENAI, "gpt-5"): _GPT5,
    (OPENAI, "gpt-5-mini"): _GPT5,
    (OPENAI, "gpt-5-nano"): _GPT5,
    (OPENAI, "gpt-5.1"): ("low", "medium", "high"),
    (OPENAI, "gpt-5.2"): _XHIGH,
    (OPENAI, "gpt-5.4"): _XHIGH,
    (OPENAI, "gpt-5.4-mini"): _XHIGH,
    (OPENAI, "gpt-5.4-nano"): _XHIGH,
    (OPENAI, "gpt-5.5"): _XHIGH,
    (OPENAI, "gpt-5.6-sol"): _XHIGH,
    (OPENAI, "gpt-5.6-terra"): _XHIGH,
    (OPENAI, "gpt-5.6-luna"): _XHIGH,
    (OPENAI, "gpt-6-sol"): _XHIGH,
    (OPENAI, "gpt-6-luna"): _XHIGH,
    (OPENAI, "gpt-6-astra"): _XHIGH,
    (OPENAI, "gpt-6.1-sol"): _XHIGH,
    (XAI, "grok-4.5"): ("low", "medium", "high"),
}

# Signed ``ttfb_timeout_ms`` / ``idle_timeout_ms`` for OpenAI's
# silent-reasoning families (migration
# ``0029_reasoning_idle_timeouts``). A reasoning model streams nothing while
# it thinks -- a Chat Completions stream can send no body byte at all until
# reasoning ends -- so the gateway's 60 s first-byte and idle defaults cut a
# long think off. These rows carry 300000 for both: the gateway clamps every
# deadline to its 300 s absolute call deadline, so only that one applies. An
# interrupted call settles on the gateway's estimate since zuu#1164, so a
# longer silence no longer risks a refunded hold. Same create-only rule as the
# capabilities above: an operator's explicit value survives a reseed.
# Mirrored (frozen) by 0029.
SILENT_REASONING_PREFIXES = ("gpt-5", "gpt-6", "o1", "o3", "o4")
REASONING_TIMEOUT_MS = MAX_IDLE_TIMEOUT_MS

# Signed ``safety_factor_bps`` for every OpenAI row (0029): the
# gateway tokenises OpenAI prompts exactly (estimate 1.077-1.079x over the
# billed count on the AHA corpus, never under), so x1.10 rather than the
# byte bound's x1.15 default, which other providers keep. Create-only.
OPENAI_SAFETY_FACTOR_BPS = 11_000


def is_silent_reasoning(provider, model):
    return provider == OPENAI and model.startswith(SILENT_REASONING_PREFIXES)


# Signed ``ttfb_timeout_ms`` for the 1M-window gpt-4.1 family
# (0029): a ~900K-token prompt can take most of a minute to its first byte, and
# a first-byte timeout before the response head ends the call unaccepted (hold
# released; OpenAI may bill the input). These rows wait up to the hard deadline
# for their first byte; idle stays 60 s (tokens flow once started).
# Create-only. Mirrored (frozen) by 0029.
LONG_PREFILL_PREFIXES = ("gpt-4.1",)


def is_long_prefill(provider, model):
    return provider == OPENAI and model.startswith(LONG_PREFILL_PREFIXES)


# Retired OpenAI models: retire from the picker (is_ga=False) so they stop being
# the default. gpt-3.5-turbo is retired at OpenAI (chatting with it 500s);
# gpt-4-turbo is superseded.
RETIRED = [
    (OPENAI, "gpt-3.5-turbo"),
    (OPENAI, "gpt-4-turbo"),
]

# ---------------------------------------------------------------------------
# Rate cards  -- the gateway's price list, DERIVED from LINEUP so the
# two cannot disagree on a model's input/output price. New data only: nothing
# in Django charges on it (``AIModel.get_tuzi_price`` still uses the
# ``input_price`` / ``output_price`` / ``markup`` columns above).
#
# CARDS REACH PROD ONLY THROUGH SEED MIGRATIONS (``pricing/NNNN_seed_rate_
# card_vN.py``; see ``dj.apps.pricing.rate_card_seeds``). A published card is
# immutable, and so is an APPLIED migration: editing an old seed changes what
# a fresh database gets while prod keeps what it already has -- two different
# "vN" cards. So when LINEUP's prices or models change, the remedy is a NEW
# seed migration carrying ``rate_card_rows()`` as the next version, never an
# edit to an existing one. ``test_rate_card.py`` compares LINEUP against the
# NEWEST seed and fails with exactly that instruction.
# ---------------------------------------------------------------------------
# Owner decision 2026-09-26 (ledger-v2 §9): 20 %, not DEFAULT_MARKUP's 50 %.
RATE_CARD_PLATFORM_MARGIN_BPS = 2000
RATE_CARD_MIN_CHARGE_2Z = 1

RATE_CARD_IMAGE_NUSD = 0
RATE_CARD_TOOL_CALL_NUSD = 0


def _fraction_ceil(value: int, fraction) -> int:
    num, den = fraction
    return -(-value * num // den)


def rate_card_rows():
    """The v1 per-model rows, as plain dicts keyed like ``RateCardModel``."""
    rows = []
    for provider, model, _name, input_price, output_price, *_rest in LINEUP:
        input_nusd = nusd_per_mtok_from_usd_per_token(input_price)
        cached, write_5m, write_1h = MODEL_CACHE_PRICE_FRACTIONS.get(
            (provider, model), CACHE_PRICE_FRACTIONS[provider])
        image_nusd = RATE_CARD_IMAGE_NUSD
        if provider in TOKEN_BILLED_IMAGE_PROVIDERS and image_nusd:
            raise ValueError(
                f"{model}: image_nusd must be zero because {provider} bills images as input tokens"
            )
        rows.append({
            "model_id": model,
            "input_nusd_per_mtok": input_nusd,
            "cached_input_nusd_per_mtok": _fraction_ceil(input_nusd, cached),
            "cache_write_5m_nusd_per_mtok": _fraction_ceil(input_nusd, write_5m),
            "cache_write_1h_nusd_per_mtok": _fraction_ceil(input_nusd, write_1h),
            "output_nusd_per_mtok": nusd_per_mtok_from_usd_per_token(output_price),
            "image_nusd": image_nusd,
            "tool_call_nusd": RATE_CARD_TOOL_CALL_NUSD,
            "min_charge_2z": RATE_CARD_MIN_CHARGE_2Z,
        })
    return rows


def lineup_drift(seed_module=None):
    """How ``rate_card_rows()`` differs from the NEWEST seed migration.

    Pure (no database). Returns human-readable lines; empty means LINEUP and
    the newest card agree. When not empty, the LAST line is the remedy and
    names the migration file to ADD.
    """
    if seed_module is None:
        _version, name, seed_module = newest_seed()
    else:
        name = seed_module.__name__.rsplit(".", 1)[-1]
    version = seed_module.VERSION
    drift = []
    if seed_module.PLATFORM_MARGIN_BPS != RATE_CARD_PLATFORM_MARGIN_BPS:
        drift.append(
            f"platform_margin_bps: card v{version} has "
            f"{seed_module.PLATFORM_MARGIN_BPS}, LINEUP wants "
            f"{RATE_CARD_PLATFORM_MARGIN_BPS}")
    have = {row["model_id"]: row for row in seed_rows(seed_module)}
    want = {row["model_id"]: row for row in rate_card_rows()}
    for model_id in sorted(set(have) | set(want)):
        if model_id not in have:
            drift.append(f"{model_id}: in LINEUP, not on card v{version}")
        elif model_id not in want:
            drift.append(f"{model_id}: on card v{version}, not in LINEUP")
        elif have[model_id] != want[model_id]:
            changed = {
                k: (have[model_id][k], want[model_id][k])
                for k in want[model_id]
                if have[model_id][k] != want[model_id][k]
            }
            drift.append(f"{model_id}: (card v{version}, LINEUP) = {changed}")
    if drift:
        drift.append(
            f"REMEDY: add a NEW migration pricing/migrations/"
            f"{next_seed_migration_name()} (copy {name}.py, bump VERSION, "
            f"paste rate_card_rows() as ROWS). Do NOT edit {name}.py: it is "
            f"already applied in prod, so editing it would give fresh "
            f"databases a different v{version} than prod has.")
    return drift


def ensure_rate_card():
    """Make sure every seed-migration card exists, then report LINEUP drift.

    Missing cards are created by the seed migrations' OWN ``seed`` functions
    (each a no-op when its version exists), so a database whose rows were
    flushed converges on exactly what ``migrate`` gives prod -- never on a
    card built from whatever LINEUP says today. Nothing existing is ever
    modified: a published card may already be captured on ledger holds.

    Returns ``(newest_card, created_versions, drift)``.
    """
    from django.apps import apps

    created = []
    with transaction.atomic():
        for version, _name, module in seed_migrations():
            if not RateCard.objects.filter(version=version).exists():
                module.seed(apps, None)
                created.append(version)
    card = RateCard.objects.order_by("-version").first()
    return card, created, lineup_drift()


# Providers free2z is not permitted to send ANY content to. The list itself
# lives in ``f2z.ai.providers`` next to the provider identifiers, because
# ``AIModel.save`` enforces it on every write -- this command is one consumer,
# not the owner. Migration ``0019_aimodel_is_enabled`` carries a frozen copy
# (migrations must not import live code); keep that one in sync.
DISABLED_PROVIDERS = POLICY_DISABLED_PROVIDERS


class Command(BaseCommand):
    help = "Idempotently seed/update the AIModel catalog across all providers."

    def handle(self, *args, **options):
        created_count = 0
        updated_count = 0
        for (
            provider,
            model,
            display_name,
            input_price,
            output_price,
            max_tokens,
            max_output_tokens,
            max_response_tokens,
            order,
            is_ga,
        ) in django_lineup():
            # LINEUP also prices immutable history; retirement is availability
            # policy, not deletion of a historical price or a new rate card.
            permitted = provider not in DISABLED_PROVIDERS and not model_is_retired(provider, model)
            # A flagged-off provider leaves the picker too, not just the
            # content path. `is_enabled` is only honoured by code that ships
            # WITH it, and `migrate` runs before the new image is serving --
            # old pods, during the roll and indefinitely after a
            # `prod-healthcheck.sh` image rollback, filter on `is_ga` alone.
            # DERIVED rather than hardcoded in LINEUP so removing a provider
            # from DISABLED_PROVIDERS restores BOTH flags in one edit.
            effective_is_ga = is_ga and permitted
            existing = AIModel.objects.filter(provider=provider, model=model).first()
            # Same protections as migration 0026: a
            # row pinned to ANOTHER upstream snapshot keeps the cost the
            # operator recorded for it (the alias price cannot vouch for a
            # snapshot or a fine-tune), and an operator-narrowed window is
            # kept, with the reserve and ceiling clamped to it.
            pinned_elsewhere = (
                existing is not None and existing.provider_model_id not in ("", model))
            window = max_tokens if existing is None else min(existing.max_tokens, max_tokens)
            defaults = {
                "display_name": display_name,
                "system_message": GENERIC_SYSTEM_MESSAGE,
                "max_tokens": window,
                "max_output_tokens": min(max_output_tokens, window),
                "max_response_tokens": min(max_response_tokens, window),
                "order": order,
                "is_ga": effective_is_ga,
                "markup": DEFAULT_MARKUP,
            }
            if not pinned_elsewhere:
                defaults["input_price"] = input_price
                defaults["output_price"] = output_price
            _, created = AIModel.objects.update_or_create(
                provider=provider,
                model=model,
                defaults=defaults,
                # `is_enabled` is set ON CREATE ONLY, and is deliberately
                # absent from `defaults`. It is an operator kill switch, and a
                # switch that a routine catalogue reseed silently flips back on
                # is not a switch: an operator who disables a model in the
                # admin during a vendor incident must not have it returned to
                # the public picker by the next `seed_ai_models` run. Flagging
                # a provider off goes the other way and IS enforced on every
                # run, by the DISABLED_PROVIDERS sweep below -- that direction
                # is safe, because it can only ever remove availability.
                # Found by the codex adversarial review.
                #
                # NOTE: `create_defaults` REPLACES `defaults` on the create
                # path rather than adding to it, hence the explicit merge.
                create_defaults={
                    **defaults,
                    "is_enabled": permitted,
                    # Declared capability, written on CREATE only (0024's
                    # rule: an operator who pinned the row to another
                    # snapshot or turned it off keeps their decision).
                    "supports_structured_output": (provider, model) in STRUCTURED_OUTPUT_MODELS,
                    "supports_tools": (provider, model) in TOOL_MODELS,
                    "supports_strict_tools": (provider, model) in STRICT_TOOL_MODELS,
                    "supports_reasoning": (provider, model) in REASONING_EFFORT_LEVELS,
                    "supports_reasoning_effort": (provider, model) in REASONING_EFFORT_LEVELS,
                    "reasoning_effort_levels": list(
                        REASONING_EFFORT_LEVELS.get((provider, model), ())),
                    **({"ttfb_timeout_ms": REASONING_TIMEOUT_MS,
                        "idle_timeout_ms": REASONING_TIMEOUT_MS}
                       if is_silent_reasoning(provider, model) else {}),
                    **({"ttfb_timeout_ms": REASONING_TIMEOUT_MS}
                       if is_long_prefill(provider, model) else {}),
                    **({"safety_factor_bps": OPENAI_SAFETY_FACTOR_BPS}
                       if provider == OPENAI else {}),
                },
            )
            if created:
                created_count += 1
            else:
                updated_count += 1
            self.stdout.write(
                f"{'created' if created else 'updated'}: "
                f"{provider}/{model} ({display_name})"
            )

        retired_count = 0
        for provider, model in RETIRED:
            retired_count += AIModel.objects.filter(
                provider=provider, model=model, is_ga=True
            ).update(is_ga=False)
            self.stdout.write(f"retired (is_ga=False): {provider}/{model}")

        # Catch rows a flagged-off provider has that the LINEUP does not --
        # an operator-added model, or one seeded before the provider was
        # flagged. The loop above only covers what is in the LINEUP.
        disabled_count = 0
        for provider, reason in DISABLED_PROVIDERS.items():
            disabled_count += AIModel.objects.filter(provider=provider).filter(
                Q(is_enabled=True) | Q(is_ga=True)
            ).update(is_enabled=False, is_ga=False)
            self.stdout.write(
                f"disabled (is_enabled=False, is_ga=False): {provider} — {reason}"
            )

        card, created_versions, drift = ensure_rate_card()
        for version in created_versions:
            self.stdout.write(
                f"rate card v{version}: created from its seed migration")
        if drift:
            # Not a failure here: a published card is immutable by design,
            # and publishing a new one is a reviewed migration, not a side
            # effect of re-seeding. CI fails on this drift instead.
            self.stdout.write(self.style.WARNING(
                f"LINEUP differs from the newest rate card v{card.version} "
                f"(nothing was changed):"))
            for line in drift:
                self.stdout.write(f"  {line}")
        else:
            self.stdout.write(f"rate card v{card.version}: matches LINEUP")

        self.stdout.write(
            self.style.SUCCESS(
                f"Done. {created_count} created, {updated_count} updated, "
                f"{retired_count} retired, {disabled_count} disabled, "
                f"{len(LINEUP)} total."
            )
        )
