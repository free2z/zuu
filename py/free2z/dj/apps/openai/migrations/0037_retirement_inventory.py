"""Withdraw reviewed retired aliases and pins; preserve all history.

Sources verified 2026-11-10: f2z/ai/retirements.py and
 docs/free2z/ai-provider-catalog.md. Frozen IDs; rollback never reactivates.
"""
from django.db import migrations
from django.db.models import Q
from django.utils import timezone

RETIRED_IDS = {'anthropic': ('claude-opus-4',
               'claude-opus-4-1',
               'claude-opus-4-1-20250805',
               'claude-opus-4-20250514',
               'claude-sonnet-4',
               'claude-sonnet-4-20250514'),
 'openai': ('babbage-002',
            'dall-e-2',
            'dall-e-3',
            'davinci-002',
            'ft-o4-mini-2025-04-16',
            'gpt-3.5-turbo',
            'gpt-3.5-turbo-0125',
            'gpt-3.5-turbo-1106',
            'gpt-3.5-turbo-completions',
            'gpt-3.5-turbo-instruct',
            'gpt-4',
            'gpt-4-0125-preview',
            'gpt-4-0314',
            'gpt-4-0613',
            'gpt-4-0613-completions',
            'gpt-4-1106-preview',
            'gpt-4-completions',
            'gpt-4-turbo',
            'gpt-4-turbo-2024-04-09',
            'gpt-4-turbo-completions',
            'gpt-4-turbo-preview',
            'gpt-4-turbo-preview-completions',
            'gpt-4.1-nano',
            'gpt-4.1-nano-2025-04-14',
            'gpt-4o-2024-05-13',
            'gpt-5.2-chat-latest',
            'gpt-5.3-chat-latest',
            'gpt-image-1',
            'o1',
            'o1-2024-12-17',
            'o1-pro',
            'o1-pro-2025-03-19',
            'o3-mini',
            'o3-mini-2025-01-31',
            'o4-mini',
            'o4-mini-2025-04-16'),
 'xai': ('grok-3',
         'grok-4-0709',
         'grok-4-1-fast-non-reasoning',
         'grok-4-1-fast-reasoning',
         'grok-4-fast-non-reasoning',
         'grok-4-fast-reasoning',
         'grok-code-fast-1',
         'grok-imagine-image-pro',
         'grok-imagine-image-quality')}


def retire(apps, schema_editor):
    rows = apps.get_model("openai", "AIModel").objects.using(schema_editor.connection.alias)
    for provider, ids in RETIRED_IDS.items():
        identities = Q(model__in=ids) | Q(provider_model_id__in=ids)
        if provider == "openai":
            for model in ids:
                identities |= (Q(model__startswith=f"ft:{model}:")
                               | Q(provider_model_id__startswith=f"ft:{model}:"))
        rows.filter(provider=provider).filter(identities).update(is_enabled=False, is_ga=False, updated_at=timezone.now())


class Migration(migrations.Migration):
    dependencies = [("openai", "0036_seed_lineup_v4")]
    operations = [
        migrations.RunSQL("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';",
                          migrations.RunSQL.noop),
        migrations.RunPython(retire, migrations.RunPython.noop),
    ]
