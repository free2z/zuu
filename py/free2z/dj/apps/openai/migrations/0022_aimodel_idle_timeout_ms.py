"""Add the signed gateway's per-model stream inactivity timeout (#2232)."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('openai', '0021_aimodel_signed_capabilities'),
    ]

    operations = [
        migrations.AddField(
            model_name='aimodel',
            name='idle_timeout_ms',
            field=models.PositiveIntegerField(
                db_default=60000,
                default=60000,
                help_text=(
                    "Maximum gateway stream silence, in MILLISECONDS. Defaults to 60s "
                    "for models that emit keepalives; never above the gateway's 300s "
                    "absolute call deadline. Increase for silent-reasoning models."
                ),
            ),
        ),
        migrations.AddConstraint(
            model_name='aimodel',
            constraint=models.CheckConstraint(
                condition=models.Q(('idle_timeout_ms__gte', 1), ('idle_timeout_ms__lte', 300000)),
                name='openai_aimodel_idle_timeout_ms_range',
            ),
        ),
    ]
