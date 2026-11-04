"""``AIModel.supports_reasoning_effort`` + ``reasoning_effort_levels`` and the
reviewed declarations (zuu#1170, ¡AHA! reasoning effort).

The gateway takes ``ChatRequest.reasoning_effort`` only for a model whose
signed catalogue declares ``capabilities.reasoning_effort: true``, and, where
``controls.effort_levels`` is signed, only at a listed level -- anything else
is refused before any hold. Absent reads as ``false`` (not tri-state), but the
signer emits it explicitly anyway, like every other member.

Declared here, once, by exact (provider, model) and only for a row whose
upstream id is the alias itself (0024's rule: a pin to another snapshot stays
off). ``supports_reasoning`` is declared on the same rows. Levels, from each
model page on developers.openai.com/api/docs/models/<id> and docs.x.ai's
reasoning guide (fetched 2026-10-05), restricted to minimal/low/medium/high/
xhigh (``none`` and ``max`` wait for the gateway slice that adds them):

* o1, o3, o3-mini, o4-mini: low, medium, high (pages list no levels; the
  o-series' long-standing set);
* gpt-5 (page: minimal..high), gpt-5-mini, gpt-5-nano (pages silent; GPT-5
  family): minimal, low, medium, high;
* gpt-5.1: low, medium, high (page: none/low/medium/high);
* gpt-5.2, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.5, gpt-5.6-sol/terra/
  luna, gpt-6-sol, gpt-6-luna, gpt-6-astra, gpt-6.1-sol: low, medium, high,
  xhigh (each page lists xhigh; the gateway wire cannot send it yet, so it is
  inert until it can);
* xai grok-4.5: low, medium, high (the guide: "grok-4.7, grok-4.6, and
  grok-4.5 support the reasoning_effort parameter"; xhigh "is treated as
  high" on grok-4.5); docs.x.ai's OpenAPI ``ChatRequest`` (the
  /v1/chat/completions body) carries ``reasoning_effort``.

Everything else stays off: gpt-4o/4o-mini/4.1* (not reasoning models),
grok-4.3 (outside the guide's list; its model page disagrees), Anthropic (the
gateway's Messages adapter refuses effort whatever is signed), Kimi.

CAVEAT for callers (not encoded here): from GPT-5.4 on, OpenAI's Chat
Completions refuses tool calling with a ``reasoning_effort`` other than
``none``; gpt-5.4/-mini/-nano also sign ``tools``, so tools + effort on them
fails as the provider's own 400 before any output (uncharged).

The reverse drops both columns with their values and leaves
``supports_reasoning`` alone (it predates this migration).
"""
from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone

import dj.apps.openai.models

# Frozen mirror of seed_ai_models.REASONING_EFFORT_LEVELS at this commit.
_O_SERIES = ("low", "medium", "high")
_GPT5 = ("minimal", "low", "medium", "high")
_XHIGH = ("low", "medium", "high", "xhigh")
REASONING_EFFORT_LEVELS = {
    ("openai", "o1"): _O_SERIES,
    ("openai", "o3"): _O_SERIES,
    ("openai", "o3-mini"): _O_SERIES,
    ("openai", "o4-mini"): _O_SERIES,
    ("openai", "gpt-5"): _GPT5,
    ("openai", "gpt-5-mini"): _GPT5,
    ("openai", "gpt-5-nano"): _GPT5,
    ("openai", "gpt-5.1"): ("low", "medium", "high"),
    ("openai", "gpt-5.2"): _XHIGH,
    ("openai", "gpt-5.4"): _XHIGH,
    ("openai", "gpt-5.4-mini"): _XHIGH,
    ("openai", "gpt-5.4-nano"): _XHIGH,
    ("openai", "gpt-5.5"): _XHIGH,
    ("openai", "gpt-5.6-sol"): _XHIGH,
    ("openai", "gpt-5.6-terra"): _XHIGH,
    ("openai", "gpt-5.6-luna"): _XHIGH,
    ("openai", "gpt-6-sol"): _XHIGH,
    ("openai", "gpt-6-luna"): _XHIGH,
    ("openai", "gpt-6-astra"): _XHIGH,
    ("openai", "gpt-6.1-sol"): _XHIGH,
    ("xai", "grok-4.5"): ("low", "medium", "high"),
}


def declare(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    for (provider, model), levels in REASONING_EFFORT_LEVELS.items():
        # updated_at moves so the signed catalogue's content revision does.
        AIModel.objects.filter(provider=provider, model=model).filter(
            Q(provider_model_id="") | Q(provider_model_id=model)
        ).update(
            supports_reasoning=True,
            supports_reasoning_effort=True,
            reasoning_effort_levels=list(levels),
            updated_at=now,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("openai", "0027_aimodel_supports_strict_tools"),
    ]

    operations = [
        migrations.AddField(
            model_name="aimodel",
            name="supports_reasoning_effort",
            field=models.BooleanField(db_default=False, default=False, help_text="Signed gateway policy: this exact provider/model takes the provider's `reasoning_effort` control (zuu#1170). Signed explicitly, true or false; NOT implied by supports_reasoning. Enable only after reviewed provider evidence."),
        ),
        migrations.AddField(
            model_name="aimodel",
            name="reasoning_effort_levels",
            field=models.JSONField(blank=True, db_default=[], default=list, help_text='Signed `controls.effort_levels`: the reasoning_effort levels this model documents (e.g. ["low", "medium", "high"]). Signed only while supports_reasoning_effort is on; empty = no list, so the gateway forwards any level and the provider refuses one it does not take (uncharged). List them from the model page.', validators=[dj.apps.openai.models.validate_reasoning_effort_levels]),
        ),
        migrations.RunPython(declare, migrations.RunPython.noop),
    ]
