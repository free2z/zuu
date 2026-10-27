"""Seed the multi-provider AIModel catalog on deploy.

The multi-provider lineup previously lived only in the ``seed_ai_models``
management command, which was never run on deploy — so stage/prod still had only
the old OpenAI rows (gpt-4o, gpt-4-turbo, gpt-3.5-turbo) and ZUULI defaulted to
the now-retired ``gpt-3.5-turbo``, which 500s on chat.

This data migration seeds the full lineup idempotently on the deploy's migrate
step and retires the dead defaults, so ``/api/ai/models/`` (is_ga=True only)
returns the real lineup.

The LINEUP / RETIRED values below are a frozen mirror of
``dj/apps/openai/management/commands/seed_ai_models.py`` — keep the two in sync.

SAFE DEFAULT: the ZUULI picker defaults to the highest-``order`` GA model. On
stage/prod only ``OPENAI_API_KEY`` is guaranteed set, so ``gpt-4o`` (valid +
keyed today) gets the TOP order; the premium flagships sit below it. Once the
operator sets ANTHROPIC/XAI/MOONSHOT keys and verifies the exact model IDs, they
can promote a flagship (raise its ``order``) via the Django admin. A mis-typed
``gpt-5.6-*`` id or a keyless provider must never be the crashing default.
"""

from django.db import migrations


GENERIC_SYSTEM_MESSAGE = (
    "You are a helpful, knowledgeable, and friendly assistant. "
    "Answer clearly and concisely, and ask for clarification when a request is "
    "ambiguous."
)

DEFAULT_MARKUP = "1.5"

# (provider, model, display_name, input_price, output_price, max_tokens, order, is_ga)
LINEUP = [
    # --- OpenAI ---
    # Safe default: valid + keyed today, so it sits at the top of the picker.
    ("openai", "gpt-4o", "GPT-4o", "0.0000025", "0.00001", 128000, 200, True),

    # --- Anthropic ---
    ("anthropic", "claude-opus-4-8", "Claude Opus 4.8", "0.000005", "0.000025", 200000, 100, True),
    ("anthropic", "claude-sonnet-5", "Claude Sonnet 5", "0.000003", "0.000015", 200000, 90, True),
    ("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "0.000001", "0.000005", 200000, 50, True),

    # --- OpenAI (premium) ---
    ("openai", "gpt-5.6-sol", "GPT-5.6 Sol", "0.000005", "0.00003", 400000, 95, True),
    ("openai", "gpt-5.6-terra", "GPT-5.6 Terra", "0.0000025", "0.000015", 400000, 85, True),
    ("openai", "gpt-5.6-luna", "GPT-5.6 Luna", "0.000001", "0.000006", 400000, 40, True),

    # --- xAI ---
    ("xai", "grok-4.5", "Grok 4.5", "0.00000125", "0.0000025", 256000, 80, True),
    ("xai", "grok-4.3", "Grok 4.3", "0.00000125", "0.0000025", 256000, 70, True),

    # --- Kimi (Moonshot) ---
    ("kimi", "kimi-k3", "Kimi K3", "0.0000006", "0.0000025", 256000, 60, True),
    ("kimi", "kimi-k2.6", "Kimi K2.6", "0.0000006", "0.0000025", 256000, 45, True),
]

# Retire the dead OpenAI defaults so they leave the picker (is_ga=False):
# gpt-3.5-turbo is retired at OpenAI (chatting with it 500s); gpt-4-turbo is
# superseded.
RETIRED = [
    ("openai", "gpt-3.5-turbo"),
    ("openai", "gpt-4-turbo"),
]


def seed(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")

    for (
        provider,
        model,
        display_name,
        input_price,
        output_price,
        max_tokens,
        order,
        is_ga,
    ) in LINEUP:
        AIModel.objects.update_or_create(
            provider=provider,
            model=model,
            defaults={
                "display_name": display_name,
                "system_message": GENERIC_SYSTEM_MESSAGE,
                "input_price": input_price,
                "output_price": output_price,
                "max_tokens": max_tokens,
                "order": order,
                "is_ga": is_ga,
                "markup": DEFAULT_MARKUP,
            },
        )

    for provider, model in RETIRED:
        AIModel.objects.filter(provider=provider, model=model).update(is_ga=False)


def unseed(apps, schema_editor):
    """Best-effort reverse: hide the seeded rows again.

    We can't restore the pre-migration catalog state, so reversing simply drops
    the newly-seeded models out of the picker (is_ga=False) rather than deleting
    any operator-tuned rows.
    """
    AIModel = apps.get_model("openai", "AIModel")
    for provider, model, *_ in LINEUP:
        AIModel.objects.filter(provider=provider, model=model).update(is_ga=False)


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0015_alter_aimodel_model"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
