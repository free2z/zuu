"""Audit zero-charge membership terms without changing financial tables."""

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('g12f', '0122_canonicalize_yue_languages'),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.CreateModel(
            name='SubscriptionContinuation',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('period_start', models.DateTimeField()),
                ('period_end', models.DateTimeField()),
                ('recorded_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('reason', models.CharField(default='usage_daily_funding_limit', editable=False, max_length=40)),
                ('refused_price', models.DecimalField(decimal_places=0, max_digits=7)),
                ('recurring_ceiling', models.DecimalField(decimal_places=0, max_digits=7)),
                ('subscription', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='zero_charge_continuations', to='g12f.subscription')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('subscription', 'period_start'), name='g12f_continuation_cycle_uniq'), models.CheckConstraint(condition=models.Q(('period_end__gt', models.F('period_start'))), name='g12f_continuation_positive_term'), models.CheckConstraint(condition=models.Q(('reason', 'usage_daily_funding_limit'), ('recurring_ceiling__gte', models.F('refused_price')), ('refused_price__gt', 0)), name='g12f_continuation_valid_refusal')],
            },
        ),
    ]
