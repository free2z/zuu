"""``AIModel.supports_strict_tools`` + the reviewed tools declarations.

Function calling for the ¡AHA! app (zuu#1142). Two signed capabilities move:

* ``capabilities.tools`` -- the gateway relays client function tools and
  tool-result history only for a model whose signed catalogue says so;
* ``capabilities.strict_tools`` (new) -- ``tools[i].strict: true``. The gateway
  reads it TRI-STATE like ``structured_output``: an ABSENT member makes it
  apply an interim rule (``provider == "openai"``), so the signer always emits
  it, and ``false`` is a real refusal.

``true`` is declared here, once, by exact (provider, model) and only for a row
whose upstream id is the alias itself (0024's rule: a pin to another snapshot
stays ``false``). Evidence: each model's page on developers.openai.com
(fetched 2026-10-05) lists ``function_calling`` and ``structured_outputs`` and
``v1/chat/completions`` -- the only adapter these rows use (``openai_chat``)
-- and OpenAI's function-calling guide says strict mode "works by leveraging
structured outputs". EXCLUDED, although their pages list function calling:

* ``gpt-5.5``, ``gpt-5.6-luna``, ``gpt-5.6-sol``, ``gpt-5.6-terra``,
  ``gpt-6-luna``, ``gpt-6-sol`` -- "Starting with GPT-5.4, Chat Completions
  does not support tool calling with ``reasoning_effort`` values other than
  ``none``" (the migrate-to-responses guide; the gpt-6-luna/sol pages say the
  same). Each defaults to ``medium`` and the gateway sends no
  ``reasoning_effort``. (The gpt-5.4 family defaults to ``none``, so it is
  declared.)
* ``gpt-6-astra``, ``gpt-6.1-sol`` -- "Chat Completions does not support
  function calling with GPT-6 Astra or GPT-6.1 Sol" (the reasoning guide; the
  gpt-6.1-sol page says the same, the gpt-6-astra page does not).

Every other provider stays ``false`` (xAI documents no ``strict``; Anthropic
and Kimi are not declared). Operators change either flag in the admin.

The reverse is a no-op for ``supports_tools`` (the column predates this
migration and an operator may have set it since) and drops
``supports_strict_tools`` with its values.
"""
from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone

# Frozen mirror of seed_ai_models.TOOL_MODELS at this commit.
TOOL_MODELS = (
    ("openai", "gpt-4o"),
    ("openai", "gpt-4o-mini"),
    ("openai", "gpt-4.1"),
    ("openai", "gpt-4.1-mini"),
    ("openai", "gpt-4.1-nano"),
    ("openai", "gpt-5"),
    ("openai", "gpt-5-mini"),
    ("openai", "gpt-5-nano"),
    ("openai", "gpt-5.1"),
    ("openai", "gpt-5.2"),
    ("openai", "gpt-5.4"),
    ("openai", "gpt-5.4-mini"),
    ("openai", "gpt-5.4-nano"),
    ("openai", "o1"),
    ("openai", "o3"),
    ("openai", "o3-mini"),
    ("openai", "o4-mini"),
)
# Frozen mirror of seed_ai_models.STRICT_TOOL_MODELS: the same rows (each
# lists structured_outputs), and never a row without tools.
STRICT_TOOL_MODELS = TOOL_MODELS


def declare(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    strict = set(STRICT_TOOL_MODELS)
    for provider, model in TOOL_MODELS:
        # updated_at moves so the signed catalogue's content revision does.
        AIModel.objects.filter(provider=provider, model=model).filter(
            Q(provider_model_id="") | Q(provider_model_id=model)
        ).update(
            supports_tools=True,
            supports_strict_tools=(provider, model) in strict,
            updated_at=now,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0026_seed_lineup_v3"),
    ]

    operations = [
        migrations.AddField(
            model_name="aimodel",
            name="supports_strict_tools",
            field=models.BooleanField(db_default=False, default=False, help_text="Signed gateway policy: this exact provider/model honours `strict: true` on a function tool (provider-enforced argument schemas). Always signed explicitly, true or false: the gateway reads an ABSENT member as 'catalogue silent' and applies its own interim rule, so false is a real refusal. Meaningless without supports_tools. Enable only after reviewed provider evidence."),
        ),
        migrations.RunPython(declare, migrations.RunPython.noop),
    ]
