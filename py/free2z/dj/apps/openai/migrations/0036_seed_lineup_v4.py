"""Reviewed 2026-11-07 standard text prices; timed promotion fails closed.

Sources and service caps: docs/free2z/ai-provider-catalog.md.
Historical seeds are immutable. Operator kill switches, narrower windows,
and separately priced pinned snapshots survive this migration.
"""
from decimal import Decimal
from datetime import date, datetime, timezone as datetime_timezone

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
RETIRED_OPENAI_IDS = (
    "gpt-4.1-nano", "gpt-4.1-nano-2025-04-14", "gpt-4o-2024-05-13",
    "o1", "o1-2024-12-17", "o3-mini", "o3-mini-2025-01-31",
    "o4-mini", "o4-mini-2025-04-16",
)

# (provider, model, display_name, input_price, output_price, max_tokens,
#  max_output_tokens (= the RESERVE), max_response_tokens, order, is_ga)
# USD per token. Frozen mirror of seed_ai_models.LINEUP.
LINEUP = [('openai', 'gpt-4o', 'GPT-4o', '0.0000025', '0.00001', 128000, 8192, 16384, 200, True),
 ('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', '0.000002', '0.00001', 236000, 16384, 128000, 150, True),
 ('openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', '0.000001', '0.000005', 236000, 16384, 128000, 148, True),
 ('openai', 'gpt-6-astra', 'GPT-6 Astra', '0.00001', '0.00005', 236000, 8192, 128000, 145, True),
 ('openai', 'gpt-6-sol', 'GPT-6 Sol', '0.000002', '0.00001', 236000, 16384, 128000, 140, True),
 ('openai', 'gpt-6-luna', 'GPT-6 Luna', '0.0000001', '0.0000005', 236000, 16384, 128000, 135, True),
 ('openai', 'gpt-5.5', 'GPT-5.5', '0.000005', '0.00003', 236000, 16384, 128000, 130, True),
 ('openai', 'gpt-5.4', 'GPT-5.4', '0.0000025', '0.000015', 236000, 16384, 128000, 125, True),
 ('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', '0.000004', '0.00002', 236000, 16384, 128000, 95, True),
 ('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', '0.000002', '0.000012', 236000, 16384, 128000, 85, True),
 ('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', '0.0000002', '0.0000012', 236000, 16384, 128000, 40, True),
 ('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', '0.00000075', '0.0000045', 400000, 16384, 128000, 120, True),
 ('openai', 'gpt-5.4-nano', 'GPT-5.4 nano', '0.0000002', '0.00000125', 400000, 16384, 128000, 115, True),
 ('openai', 'gpt-5.2', 'GPT-5.2', '0.00000175', '0.000014', 400000, 16384, 128000, 110, True),
 ('openai', 'gpt-5.1', 'GPT-5.1', '0.00000125', '0.00001', 400000, 16384, 128000, 105, True),
 ('openai', 'gpt-5', 'GPT-5', '0.00000125', '0.00001', 400000, 16384, 128000, 103, True),
 ('openai', 'gpt-5-mini', 'GPT-5 mini', '0.00000025', '0.000002', 400000, 16384, 128000, 102, True),
 ('openai', 'gpt-5-nano', 'GPT-5 nano', '0.00000005', '0.0000004', 400000, 16384, 128000, 101, True),
 ('openai', 'gpt-4.1', 'GPT-4.1', '0.000002', '0.000008', 1047576, 8192, 32768, 75, True),
 ('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', '0.0000004', '0.0000016', 1047576, 8192, 32768, 72, True),
 ('openai', 'gpt-4.1-nano', 'GPT-4.1 nano', '0.0000001', '0.0000004', 1047576, 8192, 32768, 71, True),
 ('openai', 'gpt-4o-mini', 'GPT-4o mini', '0.00000015', '0.0000006', 128000, 8192, 16384, 65, True),
 ('openai', 'o3', 'o3', '0.000002', '0.000008', 200000, 16384, 100000, 35, True),
 ('openai', 'o4-mini', 'o4-mini', '0.0000011', '0.0000044', 200000, 16384, 100000, 34, True),
 ('openai', 'o3-mini', 'o3-mini', '0.0000011', '0.0000044', 200000, 16384, 100000, 33, True),
 ('openai', 'o1', 'o1', '0.000015', '0.00006', 200000, 8192, 100000, 32, True),
 ('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', '0.000005', '0.000025', 200000, 8192, 128000, 97, True),
 ('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', '0.000005', '0.000025', 200000, 8192, 128000, 96, True),
 ('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', '0.000005', '0.000025', 172000, 8192, 64000, 94, True),
 ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', '0.000003', '0.000015', 200000, 8192, 128000, 89, True),
 ('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', '0.00001', '0.00005', 200000, 8192, 128000, 149, True),
 ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', '0.000004', '0.00002', 200000, 8192, 128000, 147, True),
 ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', '0.000002', '0.00001', 200000, 8192, 128000, 146, True),
 ('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', '0.0000001', '0.0000005', 86000, 8192, 64000, 134, True),
 ('anthropic', 'claude-fable-5', 'Claude Fable 5', '0.00001', '0.00005', 200000, 8192, 128000, 99, True),
 ('anthropic', 'claude-opus-5', 'Claude Opus 5', '0.000005', '0.000025', 200000, 8192, 128000, 98, True),
 ('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', '0.000005', '0.000025', 200000, 8192, 32000, 100, True),
 ('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', '0.000002', '0.00001', 200000, 8192, 64000, 90, True),
 ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '0.000001', '0.000005', 200000, 8192, 64000, 50, True),
 ('xai',
  'grok-4.20-0309-reasoning',
  'Grok 4.20 Reasoning',
  '0.00000125',
  '0.0000025',
  172000,
  8192,
  8192,
  69,
  True),
 ('xai',
  'grok-4.20-0309-non-reasoning',
  'Grok 4.20 Non-Reasoning',
  '0.00000125',
  '0.0000025',
  172000,
  8192,
  8192,
  68,
  True),
 ('xai', 'grok-build-0.1', 'Grok Build 0.1', '0.000001', '0.000002', 172000, 8192, 8192, 67, True),
 ('xai', 'grok-4.7', 'Grok 4.7', '0.000002', '0.000006', 172000, 8192, 8192, 144, True),
 ('xai', 'grok-4.6', 'Grok 4.6', '0.000002', '0.000006', 172000, 8192, 8192, 143, True),
 ('xai', 'grok-4.5', 'Grok 4.5', '0.000002', '0.000006', 172000, 8192, 8192, 80, True),
 ('xai', 'grok-4.3', 'Grok 4.3', '0.00000125', '0.0000025', 172000, 8192, 8192, 70, True),
 ('kimi', 'kimi-k3', 'Kimi K3', '0.000003', '0.000015', 256000, 8192, 16384, 60, True),
 ('kimi', 'kimi-k2.6', 'Kimi K2.6', '0.00000095', '0.000004', 256000, 8192, 16384, 45, True)]

# Frozen mirror of seed_ai_models.STRUCTURED_OUTPUT_MODELS: every OpenAI row.
STRUCTURED_OUTPUT_MODELS = tuple(
    (provider, model) for provider, model, *_ in LINEUP if provider == "openai"
)


CAPABILITIES = {'claude-fable-5': {'idle_timeout_ms': 300000,
                    'reasoning_effort_levels': [],
                    'supports_reasoning': True,
                    'supports_reasoning_effort': False,
                    'ttfb_timeout_ms': 300000},
 'claude-fable-5-1': {'idle_timeout_ms': 300000,
                      'reasoning_effort_levels': [],
                      'supports_reasoning': True,
                      'supports_reasoning_effort': False,
                      'ttfb_timeout_ms': 300000},
 'claude-haiku-5-5': {'reasoning_effort_levels': [],
                      'supports_reasoning': True,
                      'supports_reasoning_effort': False},
 'claude-opus-5': {'idle_timeout_ms': 300000,
                   'reasoning_effort_levels': [],
                   'supports_reasoning': True,
                   'supports_reasoning_effort': False,
                   'ttfb_timeout_ms': 300000},
 'claude-opus-5-5': {'idle_timeout_ms': 300000,
                     'reasoning_effort_levels': [],
                     'supports_reasoning': True,
                     'supports_reasoning_effort': False,
                     'ttfb_timeout_ms': 300000},
 'claude-sonnet-5-5': {'reasoning_effort_levels': [],
                       'supports_reasoning': True,
                       'supports_reasoning_effort': False},
 'gpt-6.1-terra': {'idle_timeout_ms': 300000,
                   'reasoning_effort_levels': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
                   'safety_factor_bps': 11000,
                   'supports_reasoning': True,
                   'supports_reasoning_effort': True,
                   'ttfb_timeout_ms': 300000},
 'grok-4.20-0309-reasoning': {'reasoning_effort_levels': [],
                              'supports_reasoning': True,
                              'supports_reasoning_effort': False},
 'grok-4.6': {'reasoning_effort_levels': ['low', 'medium', 'high', 'xhigh'],
              'supports_reasoning': True,
              'supports_reasoning_effort': True},
 'grok-4.7': {'reasoning_effort_levels': ['low', 'medium', 'high', 'xhigh'],
              'supports_reasoning': True,
              'supports_reasoning_effort': True},
 'grok-build-0.1': {'reasoning_effort_levels': [],
                    'supports_reasoning': True,
                    'supports_reasoning_effort': False}}
PRICE_VALID_UNTIL = {"gpt-5.6-sol": datetime(2026, 11, 21, tzinfo=datetime_timezone.utc)}

def seed(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    created_ids = []
    for (provider, model, display_name, input_price, output_price, max_tokens,
         max_output_tokens, max_response_tokens, order, is_ga) in LINEUP:
        # Preserve the existing gateway fence introduced by 0030. LINEUP
        # records provider specifications; the service deliberately offers less.
        if provider == "openai" and model == "gpt-4.1":
            max_tokens = min(max_tokens, 128000)
            max_response_tokens = min(max_response_tokens, 16384)
        permitted = provider not in POLICY_DISABLED_PROVIDERS
        # Older rollback images honor is_enabled but do not know expiry.
        # Leave this one promotional alias off until a guarded activation.
        staged_promotion = provider == "openai" and model == "gpt-5.6-sol"
        declared = (provider, model) in STRUCTURED_OUTPUT_MODELS
        existing = AIModel.objects.filter(provider=provider, model=model).first()
        permitted = permitted and not (provider == "openai" and (
            model in RETIRED_OPENAI_IDS or
            (existing is not None and existing.provider_model_id in RETIRED_OPENAI_IDS)))
        if existing is None:
            row = AIModel.objects.create(
                provider=provider, model=model, display_name=display_name,
                system_message=GENERIC_SYSTEM_MESSAGE,
                input_price=Decimal(input_price), output_price=Decimal(output_price),
                max_tokens=max_tokens, max_output_tokens=max_output_tokens,
                max_response_tokens=max_response_tokens, order=order,
                is_ga=is_ga and permitted, is_enabled=permitted and not staged_promotion,
                markup=Decimal(DEFAULT_MARKUP),
                supports_structured_output=declared,
                **CAPABILITIES.get(model, {}),
                **({"sampling_temperature": False, "sampling_top_p": False}
                   if model in ("claude-sonnet-5-5", "claude-haiku-5-5") else {}),
                price_checked_at=date(2026, 11, 7),
                price_valid_until=PRICE_VALID_UNTIL.get(model),
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
            **({"is_enabled": False} if staged_promotion else {}),
            **prices,
            **({"price_checked_at": date(2026, 11, 7), "price_valid_until": PRICE_VALID_UNTIL.get(model)} if not pinned_elsewhere else {}),
            max_tokens=window,
            max_output_tokens=min(max_output_tokens, window,
                existing.max_output_tokens if existing.max_output_tokens > 0 else max_output_tokens),
            # The catalogue refuses a ceiling above the window
            # (``max_output_tokens exceeds context_window``), so a ceiling
            # the lineup raised is clamped to a window an operator kept
            # narrow (codex review of #2490).
            max_response_tokens=min(max_response_tokens, window,
                existing.max_response_tokens if existing.max_response_tokens > 0 else max_response_tokens),
            order=order, is_ga=is_ga and permitted,
            updated_at=now,
        )
    # 0024's declaration, extended to the new aliases: exact rows, alias
    # upstream id only; a pin to another snapshot stays false.
    for provider, model in STRUCTURED_OUTPUT_MODELS:
        AIModel.objects.filter(provider=provider, model=model).filter(
            Q(provider_model_id="") | Q(provider_model_id=model)
        ).exclude(supports_structured_output=True).update(
            supports_structured_output=True, updated_at=now)


class Migration(migrations.Migration):
    dependencies = [("openai", "0035_price_validity")]
    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
