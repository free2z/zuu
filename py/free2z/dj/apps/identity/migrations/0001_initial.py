"""Passkeys, recovery codes and auth context (#2226, migration I2 of #2202).

Additive and mixed-fleet safe: three new tables that the previous release
has no model for, so during the rollout old pods never touch them, and a code
rollback leaves them unused rather than breaking anything.

The one lock worth naming: each new table's foreign key to ``g12f_creator``
takes a SHARE ROW EXCLUSIVE lock on that table (the busiest one we have)
while the constraint is added. Validating it is instant because the new
tables are empty, but *acquiring* the lock queues behind any long-running
transaction on ``g12f_creator`` and blocks writers queued after it. The
``lock_timeout`` below turns that into a fast, loud, retryable failure of
``migrate`` rather than a wedged deploy, the same pattern as
``emails/0007``. ``SET LOCAL`` scopes it to this migration's transaction.
"""

import django.db.models.deletion
import django.db.models.functions.text
import django.db.models.lookups
from django.conf import settings
from django.db import migrations, models

LOCK_TIMEOUT = '10s'


def set_lock_timeout(apps, schema_editor):
    if schema_editor.connection.vendor != 'postgresql':
        return
    schema_editor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # Fail fast instead of wedging the deploy behind a lock. See above.
        migrations.RunPython(set_lock_timeout, migrations.RunPython.noop),
        migrations.CreateModel(
            name='AuthContext',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('credential_kind', models.CharField(choices=[('session', 'Django session'), ('knox', 'Knox token')], max_length=8)),
                ('credential_hash', models.CharField(editable=False, max_length=64)),
                ('auth_time', models.DateTimeField()),
                ('amr', models.JSONField(blank=True, default=list)),
                ('acr', models.CharField(blank=True, max_length=64)),
                ('account_epoch', models.PositiveIntegerField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('expires_at', models.DateTimeField()),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='auth_contexts', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'indexes': [models.Index(fields=['expires_at'], name='identity_authctx_expires')],
                'constraints': [models.UniqueConstraint(fields=('credential_kind', 'credential_hash'), name='identity_authcontext_credential_unique'), models.CheckConstraint(condition=models.Q(('credential_kind__in', ['session', 'knox'])), name='identity_authcontext_kind_known'), models.CheckConstraint(condition=models.Q(('credential_hash__regex', '^[0-9a-f]{64}$')), name='identity_authcontext_hash_is_sha256_hex'), models.CheckConstraint(condition=models.Q(('expires_at__gt', models.F('auth_time'))), name='identity_authcontext_expires_after_auth')],
            },
        ),
        migrations.CreateModel(
            name='RecoveryCode',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('digest', models.CharField(editable=False, max_length=64)),
                ('issued_at_epoch', models.PositiveIntegerField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('used_at', models.DateTimeField(blank=True, null=True)),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='recovery_codes', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('creator', 'digest'), name='identity_recoverycode_creator_digest_unique'), models.CheckConstraint(condition=models.Q(('digest__regex', '^[0-9a-f]{64}$')), name='identity_recoverycode_digest_is_sha256_hex')],
            },
        ),
        migrations.CreateModel(
            name='WebAuthnCredential',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('credential_id', models.BinaryField(max_length=1023, unique=True)),
                ('public_key', models.BinaryField()),
                ('sign_count', models.PositiveBigIntegerField(default=0)),
                ('transports', models.JSONField(blank=True, default=list)),
                ('aaguid', models.UUIDField(blank=True, null=True)),
                ('rp_id', models.CharField(max_length=253)),
                ('name', models.CharField(blank=True, max_length=64)),
                ('user_verified', models.BooleanField(default=False)),
                ('backup_eligible', models.BooleanField(default=False)),
                ('backed_up', models.BooleanField(default=False)),
                ('linked_at_epoch', models.PositiveIntegerField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_used_at', models.DateTimeField(blank=True, null=True)),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='webauthn_credentials', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Passkey',
                'constraints': [models.CheckConstraint(condition=models.Q(django.db.models.lookups.GreaterThanOrEqual(django.db.models.functions.text.Length('credential_id'), 16), django.db.models.lookups.LessThanOrEqual(django.db.models.functions.text.Length('credential_id'), 1023)), name='identity_webauthn_credential_id_length'), models.CheckConstraint(condition=models.Q(('rp_id', ''), _negated=True), name='identity_webauthn_rp_id_present'), models.CheckConstraint(condition=models.Q(('linked_at_epoch__gte', 1)), name='identity_webauthn_linked_at_epoch_positive')],
            },
        ),
    ]
