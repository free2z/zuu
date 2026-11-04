"""In-app AI output reports (SDK ``reportCall``): one new table.

The foreign keys to ``g12f_creator`` and ``oidc_f2zapplication`` take a SHARE
ROW EXCLUSIVE lock on those tables while the constraints are added. The table
is new and empty, so validation is instant, but acquiring the lock queues
behind any long transaction on ``g12f_creator`` and blocks writers queued
after it. ``lock_timeout`` (as in 0001) turns that into a fast, loud,
retryable ``migrate`` failure instead of a production-wide write stall;
``SET LOCAL`` scopes it to this migration's transaction.
"""
import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


LOCK_TIMEOUT = '10s'


def set_lock_timeout(apps, schema_editor):
    if schema_editor.connection.vendor != 'postgresql':
        return
    schema_editor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


class Migration(migrations.Migration):

    dependencies = [
        ('oidc', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # Fail fast instead of wedging the deploy behind a lock. See above.
        migrations.RunPython(set_lock_timeout, migrations.RunPython.noop),
        migrations.CreateModel(
            name='AiOutputReport',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('call_id', models.UUIDField()),
                ('model', models.CharField(blank=True, default='', max_length=128)),
                ('reason', models.CharField(choices=[('incorrect', 'Incorrect'), ('inappropriate', 'Inappropriate'), ('unsafe', 'Unsafe'), ('other', 'Other')], max_length=16)),
                ('detail', models.CharField(blank=True, default='', max_length=200)),
                ('status', models.CharField(choices=[('open', 'Open'), ('reviewing', 'Reviewing'), ('resolved', 'Resolved')], default='open', max_length=12)),
                ('staff_notes', models.TextField(blank=True, default='')),
                ('unsafe_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('application', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='ai_output_reports', to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL)),
                ('reporter', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='ai_output_reports', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'AI output report',
                'indexes': [models.Index(fields=['application', '-created_at'], name='oidc_aireport_app_created'), models.Index(fields=['reporter', 'created_at'], name='oidc_aireport_reporter_created'), models.Index(fields=['status', 'reason', 'created_at'], name='oidc_aireport_queue')],
                'constraints': [models.UniqueConstraint(fields=('reporter', 'call_id'), name='oidc_aioutputreport_reporter_call_unique'), models.CheckConstraint(condition=models.Q(('reason__in', ['incorrect', 'inappropriate', 'unsafe', 'other'])), name='oidc_aioutputreport_reason_known')],
            },
        ),
    ]
