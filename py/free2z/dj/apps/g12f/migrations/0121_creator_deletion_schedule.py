"""Self-service deletion's 30-day grace period (``g12f.account_deletion``).

Three nullable ``Creator`` columns (catalog-only additions, no backfill) and
the ``AccountDeletionEvent`` audit table. ``lock_timeout`` bounds the ACCESS
EXCLUSIVE wait on ``g12f_creator`` so the deploy fails and retries rather
than queueing every request behind a long transaction.
"""
import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('g12f', '0120_creator_deleted_at'),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name='creator',
            name='deletion_cancelled_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creator',
            name='deletion_requested_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creator',
            name='purge_after',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.CreateModel(
            name='AccountDeletionEvent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('kind', models.CharField(choices=[('scheduled', 'Deletion requested'), ('cancelled', 'Kept by a sign-in'), ('purge_blocked', 'Purge blocked'), ('purged', 'Purged'), ('banned', 'Banned while pending (cannot be kept)'), ('purge_attempt', 'Purge attempted')], max_length=16)),
                ('at', models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ('detail', models.JSONField(blank=True, default=dict)),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='account_deletion_events', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'indexes': [models.Index(fields=['creator', 'kind', 'at'], name='g12f_acctdel_event_lookup')],
            },
        ),
    ]
