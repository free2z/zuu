"""Withdraw October 23 models without deleting price or provider-call history.

Frozen from https://developers.openai.com/api/docs/deprecations (2026-10-17).
Rollback deliberately does not re-enable unavailable models. Historical rate
cards, conversation foreign keys and pending/replayed call records are untouched.
"""
from django.db import migrations
from django.db.models import Q
from django.utils import timezone


RETIRED_IDS = (
    "gpt-4.1-nano", "gpt-4.1-nano-2025-04-14",
    "gpt-4o-2024-05-13",
    "o1", "o1-2024-12-17",
    "o3-mini", "o3-mini-2025-01-31",
    "o4-mini", "o4-mini-2025-04-16",
)


def retire(apps, schema_editor):
    models = apps.get_model("openai", "AIModel")
    models.objects.using(schema_editor.connection.alias).filter(provider="openai").filter(
        Q(model__in=RETIRED_IDS) | Q(provider_model_id__in=RETIRED_IDS)
    ).update(is_enabled=False, is_ga=False, updated_at=timezone.now())


class Migration(migrations.Migration):
    dependencies = [("openai", "0030_cap_gpt41_window")]
    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';",
            migrations.RunSQL.noop,
        ),
        migrations.RunPython(retire, migrations.RunPython.noop),
    ]
