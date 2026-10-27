"""Give every AIModel an explicit output cap (#1033 §3.1/§3.2).

Two things depended on this column not existing:

1. ``Conversation.generate`` passed no ``max_output_tokens``, so for the three
   OpenAI-compatible providers (openai / xai / kimi) the reply was capped by
   nothing at all. Anthropic was bounded only by accident, at the
   ``ANTHROPIC_MAX_OUTPUT = 8192`` module default.
2. Admission to the chat endpoint was a flat 100 2Z while the charge was
   computed after generation, so an unbounded reply had an unbounded price and
   the floor guarded nothing.

The values below are the *charged* ceiling, so they are chosen to keep the
resulting admission threshold under the historical 100-2Z floor for a normal
conversation on every seeded GA model. Concretely, at
``markup=1.5`` the output half of the ceiling is
``cap * output_price * 100 * 1.5`` 2Z:

* 8192 on ``claude-opus-4-8`` (the priciest 8192 row) => ~31 2Z
* 16384 on ``gpt-5.6-sol``    (the priciest 16384 row) => ~74 2Z

The gpt-5.6 family gets the larger cap because reasoning tokens are billed as
output and consume this same budget on those models; 8192 there risks
truncating the visible answer to nothing. Everything else gets 8192, which is
exactly what Anthropic already enforced.

BE HONEST ABOUT THE TRADE, though: for openai / xai / kimi the reply was
previously bounded by NOTHING, so a generation that would have run past 8192
tokens is now cut short — gpt-4o alone documents a 16 384-token maximum output.
That is the intended direction (an uncapped completion is an uncapped charge
and an uncapped latency), but it is a behaviour change for the longest replies,
not a no-op. We also do not yet read ``finish_reason``, so a truncated reply is
persisted and charged as a normal one; surfacing "this answer was cut off"
belongs with the provider-usage work in #1033 §3.4. Raise a cap in the admin if
a model's users genuinely need longer answers and the arithmetic above still
leaves the threshold under 100.

Operators may raise a cap in the Django admin. Doing so raises the 2Z a user
must hold to start a chat on that model — that is the point, and it is now
visible in the field's help_text.
"""

from django.db import migrations, models


DEFAULT_MAX_OUTPUT_TOKENS = 4096

# (provider, model): max_output_tokens. Mirrored in
# ``dj/apps/openai/management/commands/seed_ai_models.py`` — keep in sync.
OUTPUT_CAPS = {
    ("openai", "gpt-4o"): 8192,
    ("openai", "gpt-5.6-sol"): 16384,
    ("openai", "gpt-5.6-terra"): 16384,
    ("openai", "gpt-5.6-luna"): 16384,
    ("anthropic", "claude-opus-4-8"): 8192,
    ("anthropic", "claude-sonnet-5"): 8192,
    ("anthropic", "claude-haiku-4-5"): 8192,
    ("xai", "grok-4.5"): 8192,
    ("xai", "grok-4.3"): 8192,
    ("kimi", "kimi-k3"): 8192,
    ("kimi", "kimi-k2.6"): 8192,
}


def set_caps(apps, schema_editor):
    """Apply the per-model caps to rows that already exist.

    Rows not in the table above (operator-added, or the retired gpt-3.5-turbo /
    gpt-4-turbo) keep the column default, which is the conservative
    ``DEFAULT_MAX_OUTPUT_TOKENS``. There is deliberately no "leave it
    unbounded" value: ``AIModel.get_max_output_tokens`` treats 0/NULL as the
    default rather than as "no cap".
    """
    AIModel = apps.get_model("openai", "AIModel")
    for (provider, model), cap in OUTPUT_CAPS.items():
        AIModel.objects.filter(provider=provider, model=model).update(
            max_output_tokens=cap
        )


def unset_caps(apps, schema_editor):
    """Reverse: put the seeded rows back on the column default.

    Reversing this migration does NOT restore uncapped generation — the
    RemoveField below does that, and it is a downgrade in every sense.
    """
    AIModel = apps.get_model("openai", "AIModel")
    for provider, model in OUTPUT_CAPS:
        AIModel.objects.filter(provider=provider, model=model).update(
            max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS
        )


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0016_seed_multiprovider_ai_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="aimodel",
            name="max_output_tokens",
            field=models.IntegerField(
                default=DEFAULT_MAX_OUTPUT_TOKENS,
                help_text=(
                    "Hard cap on GENERATED tokens, enforced by the provider. "
                    "This is what bounds the worst-case charge for a request, "
                    "so the pre-flight check in "
                    "PromptResponseViewSet.create can refuse a request the "
                    "user cannot pay for BEFORE we call the provider. Count "
                    "reasoning tokens in here too: on models that bill them, "
                    "they consume this budget. Raising it raises the 2Z a "
                    "user must hold to start a chat on this model."
                ),
            ),
        ),
        migrations.AlterField(
            model_name="aimodel",
            name="max_tokens",
            field=models.IntegerField(
                help_text=(
                    "INPUT context-trim budget: build_messages() drops the "
                    "oldest exchanges until the prompt fits under this. NOT "
                    "an output cap -- see max_output_tokens."
                ),
            ),
        ),
        migrations.RunPython(set_caps, unset_caps),
    ]
