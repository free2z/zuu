"""Signed tools/effort admission for GPT-5.4 Chat Completions (zuu#1177).

Evidence verified 2026-11-04:
https://developers.openai.com/api/docs/guides/migrate-to-responses
Starting with GPT-5.4, Chat Completions tool calling requires effort none.
The gpt-5.4, gpt-5.4-mini and gpt-5.4-nano model pages document none as
the default. These are the tool-enabled affected rows in our lineup.
Only exact alias rows using openai_chat are declared; snapshot overrides
are not evidence-backed by this declaration. Other GPT-5.4+ rows already
refuse tools entirely (0027). No capability is granted by this control.
"""
from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone

TOOLS_REQUIRE_EFFORT_NONE = frozenset({
    ("openai", "gpt-5.4"),
    ("openai", "gpt-5.4-mini"),
    ("openai", "gpt-5.4-nano"),
})


def declare(apps, schema_editor):
    AIModel = apps.get_model("openai", "AIModel")
    now = timezone.now()
    for provider, model in TOOLS_REQUIRE_EFFORT_NONE:
        AIModel.objects.filter(provider=provider, model=model).filter(
            Q(provider_model_id="") | Q(provider_model_id=model),
        ).filter(Q(api_style="") | Q(api_style="openai_chat")).update(
            tools_require_effort_none=True, updated_at=now,
        )


class Migration(migrations.Migration):
    dependencies = [("openai", "0031_retire_october_2026_models")]
    operations = [
        migrations.AddField(
            model_name="aimodel",
            name="tools_require_effort_none",
            field=models.BooleanField(
                default=False, db_default=False,
                help_text="Signed controls.tools_require_effort_none: tools require the provider's "
                "non-reasoning default; explicit non-none effort with tools is refused before "
                "a hold (zuu#1177). Enable only with reviewed provider evidence.",
            ),
        ),
        migrations.RunPython(declare, migrations.RunPython.noop),
    ]
