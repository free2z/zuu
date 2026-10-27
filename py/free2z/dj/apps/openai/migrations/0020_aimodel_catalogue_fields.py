"""AIModel gateway-catalogue fields (#2222): provider_model_id, api_style,
ttfb_timeout_ms, safety_factor_bps.

MIXED-FLEET SAFE. ``migrate`` runs before the new pods roll, so for a while
old pods write this table without knowing the columns exist. Every column
therefore has a DATABASE default (``db_default``), not only a Python one: an
old pod's INSERT (e.g. an operator adding a model in the admin) omits them
and Postgres fills them in, instead of failing a NOT NULL. On PG11+ adding a
column with a constant default is a catalogue-only change (no table rewrite).
The CHECKs are satisfied by those defaults, so they validate every existing
row; the table is ~15 rows, so the brief ACCESS EXCLUSIVE lock is nothing.

Nothing in Django reads the new columns (the chat path still sends
``model``), and ``AIModelSerializer`` excludes them, so no API response
changes and a code rollback is a no-op.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('openai', '0019_aimodel_is_enabled'),
    ]

    operations = [
        migrations.AddField(
            model_name='aimodel',
            name='api_style',
            field=models.CharField(blank=True, choices=[('', 'Derived from provider'), ('openai_responses', 'OpenAI Responses'), ('openai_chat', 'OpenAI Chat Completions (and compatible)'), ('anthropic_messages', 'Anthropic Messages')], db_default='', default='', help_text='Upstream API shape the gateway speaks to this model. Blank = derived from `provider` (anthropic -> anthropic_messages, everything else -> openai_chat).', max_length=32),
        ),
        migrations.AddField(
            model_name='aimodel',
            name='provider_model_id',
            field=models.CharField(blank=True, db_default='', default='', help_text="The provider's own model id the GATEWAY sends upstream, when it differs from `model` (e.g. a dated snapshot). Blank = same as `model`. Django's own chat path still sends `model`.", max_length=200),
        ),
        migrations.AddField(
            model_name='aimodel',
            name='safety_factor_bps',
            field=models.PositiveIntegerField(db_default=11500, default=11500, help_text="Tokenizer safety factor for the gateway's input ESTIMATE, in basis points (11500 = x1.15). Never below 10000: it may only scale an estimate up. A charge always settles from provider usage, never from this."),
        ),
        migrations.AddField(
            model_name='aimodel',
            name='ttfb_timeout_ms',
            field=models.PositiveIntegerField(db_default=60000, default=60000, help_text='Gateway time-to-first-byte timeout, in MILLISECONDS. Generous by default: a reasoning model can be silent for most of a minute.'),
        ),
        migrations.AddConstraint(
            model_name='aimodel',
            constraint=models.CheckConstraint(condition=models.Q(('safety_factor_bps__gte', 10000)), name='openai_aimodel_safety_factor_gte_1'),
        ),
        migrations.AddConstraint(
            model_name='aimodel',
            constraint=models.CheckConstraint(condition=models.Q(('ttfb_timeout_ms__gte', 1)), name='openai_aimodel_ttfb_timeout_positive'),
        ),
        migrations.AddConstraint(
            model_name='aimodel',
            constraint=models.CheckConstraint(condition=models.Q(('api_style__in', ['', 'openai_responses', 'openai_chat', 'anthropic_messages'])), name='openai_aimodel_api_style_known'),
        ),
    ]
