"""Seed the v3 lineup: official prices, 24 new OpenAI rows, long-context caps.

The sibling of ``pricing.0006_seed_rate_card_v3`` for the Django side of the
same audit (#2224, 2026-10-05). ``AIModel`` is what the chat path charges on
(``get_tuzi_price`` = tokens x price x 100 x markup) and what the signed
gateway catalogue reads its window, ceiling and capabilities from, so it has
to move with the card.

What this writes, per LINEUP row (a frozen mirror of
``seed_ai_models.LINEUP`` at this commit; ``test_lineup_v3_migration.py``
enforces the mirror):

* prices: the provider's official list price, up OR down (gpt-5.6-luna's
  $1.00 / $6.00 becomes $0.20 / $1.20; claude-sonnet-5 $3 / $15 becomes
  $2 / $10; kimi-k3 $0.60 / $2.50 becomes $3 / $15). Unlike ``0023`` this
  does overwrite a price an operator raised: the lineup is now the audited
  source of truth and the card is derived from it, and a Django price that
  disagrees with the card would be excluded from the catalogue by
  ``card_below_model_cost``. EXCEPT a row pinned to another upstream
  snapshot (``provider_model_id`` set and not the alias): its recorded cost
  is the snapshot's, which the alias price cannot vouch for, so it is kept.
* ``max_tokens``: the LINEUP window, except that a window an operator has
  already narrowed below it is kept (``min``) -- a cap is a ceiling, and
  raising one silently is how a long-context tier gets undercharged. The
  reserve and the output ceiling are clamped to that kept window, so the
  row stays a valid catalogue entry (ceiling <= window).
  OpenAI's tiered models (gpt-6-*, gpt-5.6-*, gpt-5.5, gpt-5.4) get 236000
  (x1.15 = 271400 < 272000) and grok-4.3 joins grok-4.5 at 172000.
* new rows: created with ``is_enabled`` derived from the policy list and
  ``supports_structured_output`` declared for the OpenAI aliases (0024's
  rule: alias upstream id only), every other capability false.
* existing rows: ``is_enabled`` is NOT touched (an operator's kill switch
  survives a reseed, as in ``seed_ai_models``); ``supports_structured_output``
  is declared true for the named OpenAI aliases exactly as 0024 did.

Every write stamps ``updated_at`` (``save()`` does; the ``update()`` calls do
it explicitly) so the signed catalogue's version moves on the next poll.

Reverse: hide the rows this migration CREATED (``is_ga=False``); prices and
windows of rows that existed before cannot be restored (there is nowhere to
have stored the pre-forward values). An image rollback does not reverse data.
"""
from decimal import Decimal

from django.db import migrations
from django.db.models import Q
from django.utils import timezone


GENERIC_SYSTEM_MESSAGE = (
    "You are a helpful, knowledgeable, and friendly assistant. "
    "Answer clearly and concisely, and ask for clarification when a request is "
    "ambiguous."
)

DEFAULT_MARKUP = "1.5"

# Frozen copy of f2z.ai.providers.POLICY_DISABLED_PROVIDERS at this commit.
POLICY_DISABLED_PROVIDERS = ("kimi",)

# (provider, model, display_name, input_price, output_price, max_tokens,
#  max_output_tokens (= the RESERVE), max_response_tokens, order, is_ga)
# USD per token. Frozen mirror of seed_ai_models.LINEUP.
LINEUP = [
    ("openai", "gpt-4o", "GPT-4o", "0.0000025", "0.00001", 128000, 8192, 16384, 200, True),
    ("openai", "gpt-6.1-sol", "GPT-6.1 Sol", "0.000002", "0.00001", 236000, 16384, 128000, 150, True),
    ("openai", "gpt-6-astra", "GPT-6 Astra", "0.00001", "0.00005", 236000, 8192, 128000, 145, True),
    ("openai", "gpt-6-sol", "GPT-6 Sol", "0.000002", "0.00001", 236000, 16384, 128000, 140, True),
    ("openai", "gpt-6-luna", "GPT-6 Luna", "0.0000001", "0.0000005", 236000, 16384, 128000, 135, True),
    ("openai", "gpt-5.5", "GPT-5.5", "0.000005", "0.00003", 236000, 16384, 128000, 130, True),
    ("openai", "gpt-5.4", "GPT-5.4", "0.0000025", "0.000015", 236000, 16384, 128000, 125, True),
    ("openai", "gpt-5.6-sol", "GPT-5.6 Sol", "0.000005", "0.00003", 236000, 16384, 128000, 95, True),
    ("openai", "gpt-5.6-terra", "GPT-5.6 Terra", "0.000002", "0.000012", 236000, 16384, 128000, 85, True),
    ("openai", "gpt-5.6-luna", "GPT-5.6 Luna", "0.0000002", "0.0000012", 236000, 16384, 128000, 40, True),
    ("openai", "gpt-5.4-mini", "GPT-5.4 mini", "0.00000075", "0.0000045", 400000, 16384, 128000, 120, True),
    ("openai", "gpt-5.4-nano", "GPT-5.4 nano", "0.0000002", "0.00000125", 400000, 16384, 128000, 115, True),
    ("openai", "gpt-5.2", "GPT-5.2", "0.00000175", "0.000014", 400000, 16384, 128000, 110, True),
    ("openai", "gpt-5.1", "GPT-5.1", "0.00000125", "0.00001", 400000, 16384, 128000, 105, True),
    ("openai", "gpt-5", "GPT-5", "0.00000125", "0.00001", 400000, 16384, 128000, 103, True),
    ("openai", "gpt-5-mini", "GPT-5 mini", "0.00000025", "0.000002", 400000, 16384, 128000, 102, True),
    ("openai", "gpt-5-nano", "GPT-5 nano", "0.00000005", "0.0000004", 400000, 16384, 128000, 101, True),
    ("openai", "gpt-4.1", "GPT-4.1", "0.000002", "0.000008", 1047576, 8192, 32768, 75, True),
    ("openai", "gpt-4.1-mini", "GPT-4.1 mini", "0.0000004", "0.0000016", 1047576, 8192, 32768, 72, True),
    ("openai", "gpt-4.1-nano", "GPT-4.1 nano", "0.0000001", "0.0000004", 1047576, 8192, 32768, 71, True),
    ("openai", "gpt-4o-mini", "GPT-4o mini", "0.00000015", "0.0000006", 128000, 8192, 16384, 65, True),
    ("openai", "o3", "o3", "0.000002", "0.000008", 200000, 16384, 100000, 35, True),
    ("openai", "o4-mini", "o4-mini", "0.0000011", "0.0000044", 200000, 16384, 100000, 34, True),
    ("openai", "o3-mini", "o3-mini", "0.0000011", "0.0000044", 200000, 16384, 100000, 33, True),
    ("openai", "o1", "o1", "0.000015", "0.00006", 200000, 8192, 100000, 32, True),
    ("anthropic", "claude-opus-4-8", "Claude Opus 4.8", "0.000005", "0.000025", 200000, 8192, 32000, 100, True),
    ("anthropic", "claude-sonnet-5", "Claude Sonnet 5", "0.000002", "0.00001", 200000, 8192, 64000, 90, True),
    ("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "0.000001", "0.000005", 200000, 8192, 64000, 50, True),
    ("xai", "grok-4.5", "Grok 4.5", "0.000002", "0.000006", 172000, 8192, 8192, 80, True),
    ("xai", "grok-4.3", "Grok 4.3", "0.00000125", "0.0000025", 172000, 8192, 8192, 70, True),
    ("kimi", "kimi-k3", "Kimi K3", "0.000003", "0.000015", 256000, 8192, 16384, 60, True),
    ("kimi", "kimi-k2.6", "Kimi K2.6", "0.00000095", "0.000004", 256000, 8192, 16384, 45, True),
]

# Frozen mirror of seed_ai_models.STRUCTURED_OUTPUT_MODELS: every OpenAI row.
STRUCTURED_OUTPUT_MODELS = tuple(
    (provider, model) for provider, model, *_ in LINEUP if provider == "openai"
)


def seed(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    created_ids = []
    for (provider, model, display_name, input_price, output_price, max_tokens,
         max_output_tokens, max_response_tokens, order, is_ga) in LINEUP:
        permitted = provider not in POLICY_DISABLED_PROVIDERS
        declared = (provider, model) in STRUCTURED_OUTPUT_MODELS
        existing = AIModel.objects.filter(provider=provider, model=model).first()
        if existing is None:
            row = AIModel.objects.create(
                provider=provider, model=model, display_name=display_name,
                system_message=GENERIC_SYSTEM_MESSAGE,
                input_price=Decimal(input_price), output_price=Decimal(output_price),
                max_tokens=max_tokens, max_output_tokens=max_output_tokens,
                max_response_tokens=max_response_tokens, order=order,
                is_ga=is_ga and permitted, is_enabled=permitted,
                markup=Decimal(DEFAULT_MARKUP),
                supports_structured_output=declared,
            )
            created_ids.append(row.pk)
            continue
        window = min(existing.max_tokens, max_tokens)
        # A row an operator pinned to ANOTHER upstream snapshot keeps the
        # cost the operator recorded for that snapshot: a dated id can be
        # priced differently from the alias (gpt-4o-2024-05-13 is $5/$15
        # against gpt-4o's $2.50/$10), and the alias price here would make
        # the card's cost-floor check pass while the gateway called the
        # expensive snapshot (codex review of #2490). Such a row is sold
        # only if the card covers the cost the operator recorded.
        pinned_elsewhere = existing.provider_model_id not in ("", model)
        prices = {} if pinned_elsewhere else {
            "input_price": Decimal(input_price), "output_price": Decimal(output_price)}
        AIModel.objects.filter(pk=existing.pk).update(
            display_name=display_name,
            **prices,
            max_tokens=window,
            max_output_tokens=min(max_output_tokens, window),
            # The catalogue refuses a ceiling above the window
            # (``max_output_tokens exceeds context_window``), so a ceiling
            # the lineup raised is clamped to a window an operator kept
            # narrow (codex review of #2490).
            max_response_tokens=min(max_response_tokens, window),
            order=order, is_ga=is_ga and permitted,
            markup=Decimal(DEFAULT_MARKUP),
            updated_at=now,
        )
    # 0024's declaration, extended to the new aliases: exact rows, alias
    # upstream id only; a pin to another snapshot stays false.
    for provider, model in STRUCTURED_OUTPUT_MODELS:
        AIModel.objects.filter(provider=provider, model=model).filter(
            Q(provider_model_id="") | Q(provider_model_id=model)
        ).exclude(supports_structured_output=True).update(
            supports_structured_output=True, updated_at=now)


def unseed(apps, schema_editor):
    """Best-effort reverse: hide the rows 0016 did not already seed."""
    AIModel = apps.get_model("openai", "AIModel")
    previously_seeded = {
        "gpt-4o", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5",
        "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "grok-4.5", "grok-4.3",
        "kimi-k3", "kimi-k2.6",
    }
    for provider, model, *_ in LINEUP:
        if model not in previously_seeded:
            AIModel.objects.filter(provider=provider, model=model).update(
                is_ga=False, updated_at=timezone.now())


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0025_providermodel"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
