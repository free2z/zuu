"""The OIDC provider (#2233, migration I3 of #2202 Pillar 1).

Seven new tables, nothing else: the registration (``oidc_f2zapplication``,
UUID primary key -- the ledger's ``ledger_app`` id), the grant
(``oidc_appauthorization``), and django-oauth-toolkit's swapped models
(``oidc_authorizationcode``, ``oidc_accesstoken``, ``oidc_refreshtoken``,
``oidc_idtoken``, ``oidc_devicegrant``). Every one of the library's models is
swapped, so its own migrations create no table in this database.

Additive and mixed-fleet safe: pods on the previous release have no model for
any of these tables and never touch them, so the rollout window has nothing
to disagree about, and a code rollback leaves unused tables behind rather
than a broken schema. Nothing here alters an existing table.

The one lock worth naming, same as ``identity/0001``: each foreign key to
``g12f_creator`` takes a SHARE ROW EXCLUSIVE lock on that table while the
constraint is added. Validation is instant (the new tables are empty), but
acquiring the lock queues behind any long transaction on ``g12f_creator``
and blocks writers queued after it. ``lock_timeout`` turns that into a fast,
loud, retryable ``migrate`` failure rather than a wedged deploy; ``SET
LOCAL`` scopes it to this migration's transaction.

Both Postgres majors run every statement here: prod is PG14, CI is PG16.
"""

import dj.apps.oidc.models
import django.db.models.deletion
import django.utils.timezone
import oauth2_provider.generators
import oauth2_provider.models
import uuid
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
            name='AccessToken',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('token', models.TextField(verbose_name='token')),
                ('token_checksum', oauth2_provider.models.TokenChecksumField(db_index=True, max_length=64, unique=True, verbose_name='token checksum')),
                ('expires', models.DateTimeField(verbose_name='expires')),
                ('scope', models.TextField(blank=True, verbose_name='scope')),
                ('resource', oauth2_provider.models.ResourceJSONField(blank=True, default=list, verbose_name='resource')),
                ('created', models.DateTimeField(auto_now_add=True, verbose_name='created')),
                ('updated', models.DateTimeField(auto_now=True, verbose_name='updated')),
                ('account_epoch', models.PositiveIntegerField()),
                ('grant_generation', models.PositiveIntegerField()),
                ('auth_time', models.DateTimeField(blank=True, null=True)),
                ('acr', models.CharField(blank=True, max_length=64)),
                ('amr', models.JSONField(blank=True, default=list)),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='%(app_label)s_%(class)s', to=settings.AUTH_USER_MODEL, verbose_name='user')),
            ],
            options={
                'abstract': False,
                'swappable': 'OAUTH2_PROVIDER_ACCESS_TOKEN_MODEL',
            },
        ),
        migrations.CreateModel(
            name='F2ZApplication',
            fields=[
                ('client_id', models.CharField(db_index=True, default=oauth2_provider.generators.generate_client_id, max_length=255, unique=True, verbose_name='client ID')),
                ('redirect_uris', models.TextField(blank=True, help_text='Allowed URIs list, space separated', verbose_name='redirect URIs')),
                ('post_logout_redirect_uris', models.TextField(blank=True, default='', help_text='Allowed Post Logout URIs list, space separated', verbose_name='post logout redirect URIs')),
                ('client_type', models.CharField(choices=[('confidential', 'Confidential'), ('public', 'Public')], max_length=32, verbose_name='client type')),
                ('hash_client_secret', models.BooleanField(default=True, verbose_name='hash client secret')),
                ('name', models.CharField(blank=True, max_length=255, verbose_name='name')),
                ('skip_authorization', models.BooleanField(default=False, verbose_name='skip authorization')),
                ('created', models.DateTimeField(auto_now_add=True, verbose_name='created')),
                ('updated', models.DateTimeField(auto_now=True, verbose_name='updated')),
                ('allowed_origins', models.TextField(blank=True, default='', help_text='Allowed origins list to enable CORS, space separated', verbose_name='allowed origins')),
                ('registration_source', models.CharField(choices=[('manual', 'Manual'), ('dcr', 'Dynamic Client Registration'), ('cimd', 'Client ID Metadata Document')], default='manual', help_text='How this application was registered (manual, DCR per RFC 7591, or CIMD)', max_length=32, verbose_name='registration source')),
                ('cimd_expires_at', models.DateTimeField(blank=True, default=None, help_text='When the cached Client ID Metadata Document should be re-fetched', null=True, verbose_name='CIMD expires at')),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('authorization_grant_type', models.CharField(choices=[('authorization-code', 'Authorization code'), ('urn:ietf:params:oauth:grant-type:device_code', 'Device Code'), ('implicit', 'Implicit'), ('password', 'Resource owner password-based'), ('client-credentials', 'Client credentials'), ('openid-hybrid', 'OpenID connect hybrid')], default='authorization-code', editable=False, max_length=44)),
                ('algorithm', models.CharField(choices=[('', 'No OIDC support'), ('RS256', 'RSA with SHA-2 256'), ('HS256', 'HMAC with SHA-2 256')], default='RS256', editable=False, max_length=5)),
                ('client_secret', dj.apps.oidc.models.OptionalClientSecretField(blank=True, db_index=True, default='', max_length=255)),
                ('first_party', models.BooleanField(default=False, help_text="Free2Z's own app. Same PKCE flow as everyone else; the flag only selects first-party features such as IAP rails.")),
                ('markup_bps', models.PositiveIntegerField(default=0, help_text='The developer markup the app ASKS for, in basis points (0..5000). Applied only up to approved_markup_bps.')),
                ('approved_markup_bps', models.PositiveIntegerField(blank=True, help_text='Set by an operator, by hand. NULL = never reviewed; 0 = refused. Effective markup = min(markup_bps, approved).', null=True)),
                ('allowed_scopes', models.TextField(blank=True, help_text='Space-separated subset of the platform scopes the app may request.')),
                ('allow_zcash_assertion', models.BooleanField(default=False, help_text='May use the Zcash sign-in grant once it exists (spec §9.4).')),
                ('default_spend_cap_2z', models.PositiveIntegerField(blank=True, help_text='Pre-selected cap on a first consent when ai:invoke is requested.', null=True)),
                ('default_cap_period', models.CharField(choices=[('day', 'per day'), ('week', 'per week'), ('month', 'per month'), ('total', 'in total')], default='month', max_length=8)),
                ('logo_url', models.URLField(blank=True, max_length=1024)),
                ('privacy_url', models.URLField(blank=True, max_length=1024)),
                ('terms_url', models.URLField(blank=True, max_length=1024)),
                ('frozen', models.BooleanField(default=False, help_text='A frozen app cannot authorize or mint tokens; existing access tokens are refused at use.')),
                ('user', models.ForeignKey(blank=True, help_text='The developer account: where markup is credited as 2Z.', null=True, on_delete=django.db.models.deletion.PROTECT, related_name='developed_apps', to=settings.AUTH_USER_MODEL, verbose_name='developer')),
            ],
            options={
                'verbose_name': 'registered app',
                'abstract': False,
                'swappable': 'OAUTH2_PROVIDER_APPLICATION_MODEL',
            },
        ),
        migrations.CreateModel(
            name='AuthorizationCode',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('code', models.CharField(max_length=255, unique=True, verbose_name='code')),
                ('expires', models.DateTimeField(verbose_name='expires')),
                ('redirect_uri', models.TextField(verbose_name='redirect URI')),
                ('scope', models.TextField(blank=True, verbose_name='scope')),
                ('created', models.DateTimeField(auto_now_add=True, verbose_name='created')),
                ('updated', models.DateTimeField(auto_now=True, verbose_name='updated')),
                ('code_challenge', models.CharField(blank=True, default='', max_length=128, verbose_name='code challenge')),
                ('code_challenge_method', models.CharField(blank=True, choices=[('plain', 'plain'), ('S256', 'S256')], default='', max_length=10, verbose_name='code challenge method')),
                ('nonce', models.CharField(blank=True, default='', max_length=255, verbose_name='nonce')),
                ('claims', models.TextField(blank=True, verbose_name='claims')),
                ('resource', oauth2_provider.models.ResourceJSONField(blank=True, default=list, verbose_name='resource')),
                ('account_epoch', models.PositiveIntegerField()),
                ('auth_time', models.DateTimeField(blank=True, null=True)),
                ('acr', models.CharField(blank=True, max_length=64)),
                ('amr', models.JSONField(blank=True, default=list)),
                ('redeemed_at', models.DateTimeField(blank=True, null=True)),
                ('redeemed_family', models.UUIDField(blank=True, editable=False, null=True)),
                ('redeemed_access_token', models.OneToOneField(blank=True, editable=False, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='source_authorization_code', to=settings.OAUTH2_PROVIDER_ACCESS_TOKEN_MODEL)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='%(app_label)s_%(class)s', to=settings.AUTH_USER_MODEL, verbose_name='user')),
                ('application', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL, verbose_name='application')),
            ],
            options={
                'abstract': False,
                'swappable': 'OAUTH2_PROVIDER_GRANT_MODEL',
            },
        ),
        migrations.AddField(
            model_name='accesstoken',
            name='application',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL, verbose_name='application'),
        ),
        migrations.CreateModel(
            name='IDToken',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('jti', models.UUIDField(default=uuid.uuid4, editable=False, unique=True, verbose_name='JWT Token ID')),
                ('expires', models.DateTimeField(verbose_name='expires')),
                ('scope', models.TextField(blank=True, verbose_name='scope')),
                ('created', models.DateTimeField(auto_now_add=True, verbose_name='created')),
                ('updated', models.DateTimeField(auto_now=True, verbose_name='updated')),
                ('application', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL, verbose_name='application')),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='%(app_label)s_%(class)s', to=settings.AUTH_USER_MODEL, verbose_name='user')),
            ],
            options={
                'abstract': False,
                'swappable': 'OAUTH2_PROVIDER_ID_TOKEN_MODEL',
            },
        ),
        migrations.AddField(
            model_name='accesstoken',
            name='id_token',
            field=models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='access_token', to=settings.OAUTH2_PROVIDER_ID_TOKEN_MODEL, verbose_name='ID token'),
        ),
        migrations.CreateModel(
            name='RefreshToken',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('token', models.TextField(verbose_name='token')),
                ('token_checksum', oauth2_provider.models.TokenChecksumField(max_length=64, verbose_name='token checksum')),
                ('token_family', models.UUIDField(blank=True, editable=False, null=True, verbose_name='token family')),
                ('resource', oauth2_provider.models.ResourceJSONField(blank=True, default=list, verbose_name='resource')),
                ('created', models.DateTimeField(auto_now_add=True, verbose_name='created')),
                ('updated', models.DateTimeField(auto_now=True, verbose_name='updated')),
                ('revoked', models.DateTimeField(null=True, verbose_name='revoked')),
                ('account_epoch', models.PositiveIntegerField()),
                ('access_token', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='refresh_token', to=settings.OAUTH2_PROVIDER_ACCESS_TOKEN_MODEL, verbose_name='access token')),
                ('application', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL, verbose_name='application')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='%(app_label)s_%(class)s', to=settings.AUTH_USER_MODEL, verbose_name='user')),
            ],
            options={
                'abstract': False,
                'swappable': 'OAUTH2_PROVIDER_REFRESH_TOKEN_MODEL',
            },
        ),
        migrations.AddField(
            model_name='accesstoken',
            name='source_refresh_token',
            field=models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='refreshed_access_token', to=settings.OAUTH2_PROVIDER_REFRESH_TOKEN_MODEL, verbose_name='source refresh token'),
        ),
        migrations.CreateModel(
            name='AppAuthorization',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('scope', models.TextField(blank=True)),
                ('spend_cap_2z', models.PositiveIntegerField(blank=True, help_text='Whole 2Z; NULL = no cap.', null=True)),
                ('cap_period', models.CharField(choices=[('day', 'per day'), ('week', 'per week'), ('month', 'per month'), ('total', 'in total')], default='month', max_length=8)),
                ('markup_bps', models.PositiveIntegerField(default=0)),
                ('generation', models.PositiveIntegerField(default=1)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('consented_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('application', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='authorizations', to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='app_authorizations', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'app authorization',
            },
        ),
        migrations.CreateModel(
            name='DeviceGrant',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('device_code', models.CharField(max_length=100, verbose_name='device code')),
                ('user_code', models.CharField(max_length=100, verbose_name='user code')),
                ('scope', models.TextField(blank=True, verbose_name='scope')),
                ('interval', models.IntegerField(default=5, verbose_name='interval')),
                ('expires', models.DateTimeField(verbose_name='expires')),
                ('status', models.CharField(blank=True, choices=[('authorized', 'Authorized'), ('authorization-pending', 'Authorization pending'), ('expired', 'Expired'), ('denied', 'Denied')], default='authorization-pending', max_length=64, verbose_name='status')),
                ('client_id', models.CharField(db_index=True, max_length=100, verbose_name='client ID')),
                ('last_checked', models.DateTimeField(auto_now=True, verbose_name='last checked')),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='%(app_label)s_%(class)s', to=settings.AUTH_USER_MODEL, verbose_name='user')),
            ],
            options={
                'abstract': False,
                'swappable': 'OAUTH2_PROVIDER_DEVICE_GRANT_MODEL',
                'constraints': [models.UniqueConstraint(fields=('device_code',), name='oidc_devicegrant_unique_device_code')],
            },
        ),
        migrations.AddConstraint(
            model_name='f2zapplication',
            constraint=models.CheckConstraint(condition=models.Q(('markup_bps__lte', 5000)), name='oidc_application_markup_within_cap'),
        ),
        migrations.AddConstraint(
            model_name='f2zapplication',
            constraint=models.CheckConstraint(condition=models.Q(('approved_markup_bps__isnull', True), ('approved_markup_bps__lte', 5000), _connector='OR'), name='oidc_application_approved_markup_within_cap'),
        ),
        migrations.AddConstraint(
            model_name='f2zapplication',
            constraint=models.CheckConstraint(condition=models.Q(('client_type__in', ['public', 'confidential'])), name='oidc_application_client_type_known'),
        ),
        migrations.AddIndex(
            model_name='refreshtoken',
            index=models.Index(fields=['token_family'], name='oidc_refres_token_f_5f39f6_idx'),
        ),
        migrations.AlterUniqueTogether(
            name='refreshtoken',
            unique_together={('token_checksum', 'revoked')},
        ),
        migrations.AddConstraint(
            model_name='accesstoken',
            constraint=models.CheckConstraint(condition=models.Q(('account_epoch__gte', 1), ('grant_generation__gte', 1)), name='oidc_accesstoken_stamps_positive'),
        ),
        migrations.AddConstraint(
            model_name='appauthorization',
            constraint=models.UniqueConstraint(fields=('user', 'application'), name='oidc_appauthorization_user_application_unique'),
        ),
        migrations.AddConstraint(
            model_name='appauthorization',
            constraint=models.CheckConstraint(condition=models.Q(('generation__gte', 1)), name='oidc_appauthorization_generation_positive'),
        ),
        migrations.AddConstraint(
            model_name='appauthorization',
            constraint=models.CheckConstraint(condition=models.Q(('markup_bps__lte', 5000)), name='oidc_appauthorization_markup_within_cap'),
        ),
        migrations.AddConstraint(
            model_name='appauthorization',
            constraint=models.CheckConstraint(condition=models.Q(('cap_period__in', ['day', 'week', 'month', 'total'])), name='oidc_appauthorization_cap_period_known'),
        ),
    ]
