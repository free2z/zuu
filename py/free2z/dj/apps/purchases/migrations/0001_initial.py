"""The purchases app (#2239, migration PU1 of #2202 Pillar 2).

Two new tables, nothing else: ``purchases_purchaseintent`` and
``purchases_purchasereceipt``. Additive and mixed-fleet safe: pods on the
previous release have no model for either table and never touch them, and a
code rollback leaves unused tables behind rather than a broken schema.

The locks worth naming: the foreign keys to ``g12f_creator`` and
``oidc_f2zapplication`` take SHARE ROW EXCLUSIVE on those tables while the
constraints are added. Validation is instant (the new tables are empty), but
acquiring the lock queues behind a long transaction on ``g12f_creator``;
``lock_timeout`` turns that into a fast, retryable ``migrate`` failure rather
than a wedged deploy. ``SET LOCAL`` scopes it to this migration's transaction.

Both Postgres majors run every statement here: prod is PG14, CI is PG16.
"""

import django.db.models.deletion
import django.utils.timezone
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
        migrations.swappable_dependency(settings.OAUTH2_PROVIDER_APPLICATION_MODEL),
    ]

    operations = [
        migrations.RunPython(set_lock_timeout, migrations.RunPython.noop),
        migrations.CreateModel(
            name='PurchaseIntent',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('rail', models.CharField(choices=[('stripe', 'Card (Stripe)'), ('zec', 'Zcash')], max_length=16)),
                ('platform', models.CharField(choices=[('desktop', 'Desktop'), ('ios', 'iOS'), ('android', 'Android'), ('web', 'Web')], max_length=16)),
                ('status', models.CharField(choices=[('created', 'Created'), ('pending', 'Waiting for payment'), ('paid', 'Paid, not yet credited'), ('credited', 'Credited'), ('expired', 'Expired'), ('failed', 'Failed'), ('refunded', 'Refunded'), ('partially_refunded', 'Partially refunded'), ('disputed', 'Disputed'), ('clawed_back', 'Clawed back')], default='created', max_length=32)),
                ('quantity_2z', models.PositiveIntegerField()),
                ('quote', models.JSONField()),
                ('pricing_version', models.CharField(max_length=32)),
                ('price_minor', models.PositiveIntegerField()),
                ('currency', models.CharField(max_length=3)),
                ('return_url', models.TextField(blank=True, default='')),
                ('rail_data', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('expires_at', models.DateTimeField()),
                ('credited_at', models.DateTimeField(blank=True, null=True)),
                ('credited_milli_2z', models.BigIntegerField(blank=True, null=True)),
                ('application', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='purchase_intents', to=settings.OAUTH2_PROVIDER_APPLICATION_MODEL)),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='purchase_intents', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='PurchaseReceipt',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('rail', models.CharField(choices=[('stripe', 'Card (Stripe)'), ('zec', 'Zcash')], max_length=16)),
                ('provider_event_id', models.CharField(max_length=255)),
                ('amount_minor', models.PositiveIntegerField()),
                ('currency', models.CharField(max_length=3)),
                ('credited_milli_2z', models.BigIntegerField()),
                ('ledger_ref_kind', models.CharField(max_length=32)),
                ('ledger_ref_id', models.CharField(max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('intent', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='receipts', to='purchases.purchaseintent')),
            ],
            options={
                'ordering': ['created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='purchaseintent',
            index=models.Index(fields=['creator', 'created_at'], name='purchases_int_creator_idx'),
        ),
        migrations.AddIndex(
            model_name='purchaseintent',
            index=models.Index(fields=['status', 'expires_at'], name='purchases_int_status_exp_idx'),
        ),
        migrations.AddConstraint(
            model_name='purchaseintent',
            constraint=models.CheckConstraint(condition=models.Q(('status__in', ['created', 'pending', 'paid', 'credited', 'expired', 'failed', 'refunded', 'partially_refunded', 'disputed', 'clawed_back'])), name='purchases_intent_status_known'),
        ),
        migrations.AddConstraint(
            model_name='purchaseintent',
            constraint=models.CheckConstraint(condition=models.Q(('rail__in', ['stripe', 'zec'])), name='purchases_intent_rail_known'),
        ),
        migrations.AddConstraint(
            model_name='purchaseintent',
            constraint=models.CheckConstraint(condition=models.Q(('platform__in', ['desktop', 'ios', 'android', 'web'])), name='purchases_intent_platform_known'),
        ),
        migrations.AddConstraint(
            model_name='purchaseintent',
            constraint=models.CheckConstraint(condition=models.Q(('quantity_2z__gte', 1)), name='purchases_intent_quantity_positive'),
        ),
        migrations.AddConstraint(
            model_name='purchaseintent',
            constraint=models.CheckConstraint(condition=models.Q(('price_minor__gte', 1)), name='purchases_intent_price_positive'),
        ),
        migrations.AddConstraint(
            model_name='purchaseintent',
            constraint=models.CheckConstraint(condition=models.Q(('expires_at__gt', models.F('created_at'))), name='purchases_intent_expires_after_created'),
        ),
        migrations.AddConstraint(
            model_name='purchaseintent',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('credited_at__isnull', False), ('credited_milli_2z__gte', 1), ('credited_milli_2z__isnull', False), ('status__in', ['clawed_back', 'credited', 'disputed', 'partially_refunded', 'refunded'])), models.Q(models.Q(('status__in', ['clawed_back', 'credited', 'disputed', 'partially_refunded', 'refunded']), _negated=True), ('credited_at__isnull', True), ('credited_milli_2z__isnull', True)), _connector='OR'), name='purchases_intent_credit_consistent'),
        ),
        migrations.AddConstraint(
            model_name='purchasereceipt',
            constraint=models.UniqueConstraint(fields=('rail', 'provider_event_id'), name='purchases_receipt_rail_event_uniq'),
        ),
        migrations.AddConstraint(
            model_name='purchasereceipt',
            constraint=models.CheckConstraint(condition=models.Q(('rail__in', ['stripe', 'zec'])), name='purchases_receipt_rail_known'),
        ),
        migrations.AddConstraint(
            model_name='purchasereceipt',
            constraint=models.CheckConstraint(condition=models.Q(('credited_milli_2z__gte', 0)), name='purchases_receipt_credit_nonnegative'),
        ),
    ]
