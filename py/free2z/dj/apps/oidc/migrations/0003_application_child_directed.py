"""``F2ZApplication.child_directed`` and its append-only audit table.

The column is NOT NULL with a database default (``db_default``) so an old pod
can still insert a registration during the rollout; on PostgreSQL 11+ adding
it is a catalogue-only change. It still takes an ACCESS EXCLUSIVE lock on
``oidc_f2zapplication`` for that instant, and the audit table's foreign keys
take SHARE ROW EXCLUSIVE locks on it and on ``g12f_creator``. ``lock_timeout``
(as in the other oidc migrations) turns waiting behind a long transaction
into a fast, loud, retryable ``migrate`` failure instead of a write stall;
``SET LOCAL`` scopes it to this migration's transaction.
"""
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


LOCK_TIMEOUT = '10s'


def set_lock_timeout(apps, schema_editor):
    if schema_editor.connection.vendor != 'postgresql':
        return
    schema_editor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


class Migration(migrations.Migration):

    dependencies = [
        ('oidc', '0002_ai_output_report'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # Fail fast instead of wedging the deploy behind a lock. See above.
        migrations.RunPython(set_lock_timeout, migrations.RunPython.noop),
        migrations.AddField(
            model_name='f2zapplication',
            name='child_directed',
            field=models.BooleanField(db_default=False, default=False, help_text='The app is directed to children or to all ages. The consent screen addresses the adult account holder, and access tokens carry `child_directed` for the AI gateway. A developer may set it; only staff may unset it. Every change is recorded in AudienceChange.'),
        ),
        migrations.CreateModel(
            name='AudienceChange',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('previous', models.BooleanField(help_text='The value before the change; null for a new registration.', null=True)),
                ('child_directed', models.BooleanField(help_text='The value after the change.')),
                ('via', models.CharField(choices=[('console', 'Developer console'), ('admin', 'Admin')], max_length=8)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('application', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='audience_changes', to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL)),
                ('changed_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'audience change',
                'indexes': [models.Index(fields=['application', '-created_at'], name='oidc_audience_app_created')],
            },
        ),
    ]
