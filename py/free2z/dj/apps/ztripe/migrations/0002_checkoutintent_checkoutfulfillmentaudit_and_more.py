import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ztripe', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='CheckoutIntent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('public_id', models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ('tuzis', models.PositiveIntegerField()),
                ('amount_cents', models.PositiveIntegerField()),
                ('currency', models.CharField(max_length=3)),
                ('pricing_version', models.CharField(max_length=32)),
                ('stripe_account_id', models.CharField(max_length=255)),
                ('stripe_mode', models.CharField(max_length=16)),
                ('stripe_livemode', models.BooleanField()),
                ('stripe_checkout_session_id', models.CharField(blank=True, max_length=255, null=True, unique=True)),
                ('stripe_payment_intent_id', models.CharField(blank=True, max_length=255, null=True, unique=True)),
                ('state', models.CharField(choices=[('creating', 'Creating provider session'), ('open', 'Open at provider'), ('provider_failed', 'Provider creation failed'), ('fulfilled', 'Credited from verified webhook')], default='creating', max_length=32)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('fulfilled_at', models.DateTimeField(blank=True, null=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='stripe_checkout_intents', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='CheckoutFulfillmentAudit',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('idempotency_key', models.CharField(max_length=320, unique=True)),
                ('provider_event_id', models.CharField(blank=True, max_length=255, null=True)),
                ('outcome', models.CharField(choices=[('credited', 'Credited'), ('duplicate', 'Duplicate delivery'), ('rejected', 'Rejected contract'), ('reconciled', 'Historical under-credit reconciled')], max_length=32)),
                ('reason', models.CharField(max_length=64)),
                ('received_checkout_session_id', models.CharField(blank=True, max_length=255)),
                ('received_payment_intent_id', models.CharField(blank=True, max_length=255)),
                ('received_session_created_epoch', models.PositiveBigIntegerField(blank=True, null=True)),
                ('expected_legacy_session_created_at_or_before_epoch', models.PositiveBigIntegerField(blank=True, null=True)),
                ('received_user_id', models.PositiveBigIntegerField(blank=True, null=True)),
                ('received_tuzis', models.PositiveIntegerField(blank=True, null=True)),
                ('received_amount_cents', models.PositiveIntegerField(blank=True, null=True)),
                ('received_currency', models.CharField(blank=True, max_length=16)),
                ('received_pricing_version', models.CharField(blank=True, max_length=32)),
                ('expected_stripe_account_id', models.CharField(max_length=255)),
                ('expected_stripe_mode', models.CharField(max_length=16)),
                ('expected_stripe_livemode', models.BooleanField()),
                ('received_event_account_id', models.CharField(blank=True, max_length=255)),
                ('received_stripe_mode', models.CharField(blank=True, max_length=16)),
                ('received_stripe_livemode', models.BooleanField(blank=True, null=True)),
                ('received_event_livemode', models.BooleanField(blank=True, null=True)),
                ('received_metadata_account_id', models.CharField(blank=True, max_length=255)),
                ('received_metadata_mode', models.CharField(blank=True, max_length=16)),
                ('received_metadata_livemode', models.BooleanField(blank=True, null=True)),
                ('adjustment_tuzis', models.PositiveIntegerField(default=0)),
                ('attempts', models.PositiveIntegerField(default=1)),
                ('first_seen_at', models.DateTimeField(auto_now_add=True)),
                ('last_seen_at', models.DateTimeField(auto_now=True)),
                ('stripe_transaction', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='fulfillment_audits', to='ztripe.stripetransaction')),
                ('intent', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name='fulfillment_audits', to='ztripe.checkoutintent')),
            ],
            options={
                'ordering': ['-first_seen_at'],
            },
        ),
        migrations.CreateModel(
            name='StripeWebhookReadiness',
            fields=[
                ('singleton', models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
                ('stripe_account_id', models.CharField(max_length=255)),
                ('stripe_livemode', models.BooleanField()),
                ('webhook_endpoint_id', models.CharField(max_length=255)),
                ('secret_key_fingerprint', models.CharField(max_length=64)),
                ('signing_secret_fingerprint', models.CharField(max_length=64)),
                ('provider_event_id', models.CharField(max_length=255)),
                ('verified_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('singleton', 1)), name='ztripe_webhook_ready_singleton'), models.CheckConstraint(condition=models.Q(('stripe_account_id__startswith', 'acct_')), name='ztripe_webhook_ready_account'), models.CheckConstraint(condition=models.Q(('webhook_endpoint_id__startswith', 'we_')), name='ztripe_webhook_ready_endpoint')],
            },
        ),
        migrations.CreateModel(
            name='StripeCheckoutRollout',
            fields=[
                ('singleton', models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
                ('legacy_session_created_at_or_before_epoch', models.PositiveBigIntegerField()),
                ('initialized_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'constraints': [models.CheckConstraint(condition=models.Q(('singleton', 1)), name='ztripe_checkout_rollout_singleton'), models.CheckConstraint(condition=models.Q(('legacy_session_created_at_or_before_epoch__gte', 1)), name='ztripe_checkout_rollout_cutoff_positive')],
            },
        ),
        migrations.AddIndex(
            model_name='checkoutintent',
            index=models.Index(fields=['state', 'created_at'], name='ztripe_int_state_6f6b0a_idx'),
        ),
        migrations.AddConstraint(
            model_name='checkoutintent',
            constraint=models.CheckConstraint(condition=models.Q(('tuzis__gte', 1)), name='ztripe_intent_tuzis_positive'),
        ),
        migrations.AddConstraint(
            model_name='checkoutintent',
            constraint=models.CheckConstraint(condition=models.Q(('amount_cents__gte', 1)), name='ztripe_intent_amount_positive'),
        ),
        migrations.AddConstraint(
            model_name='checkoutintent',
            constraint=models.CheckConstraint(condition=models.Q(('stripe_mode', 'payment')), name='ztripe_intent_mode_payment'),
        ),
        migrations.AddConstraint(
            model_name='checkoutintent',
            constraint=models.CheckConstraint(condition=models.Q(('stripe_account_id__startswith', 'acct_')), name='ztripe_intent_account_canonical'),
        ),
        migrations.AddConstraint(
            model_name='checkoutintent',
            constraint=models.CheckConstraint(condition=models.Q(('state__in', ['creating', 'open', 'provider_failed', 'fulfilled'])), name='ztripe_intent_state_known'),
        ),
        migrations.AddConstraint(
            model_name='checkoutintent',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('fulfilled_at__isnull', False), ('state', 'fulfilled'), ('stripe_checkout_session_id__isnull', False), ('stripe_payment_intent_id__isnull', False)), models.Q(models.Q(('state', 'fulfilled'), _negated=True), ('fulfilled_at__isnull', True), ('stripe_payment_intent_id__isnull', True)), _connector='OR'), name='ztripe_intent_fulfillment_consistent'),
        ),
        migrations.AddConstraint(
            model_name='checkoutintent',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('state', 'open'), _negated=True), ('stripe_checkout_session_id__isnull', False), _connector='OR'), name='ztripe_intent_open_has_session'),
        ),
        migrations.AddIndex(
            model_name='checkoutfulfillmentaudit',
            index=models.Index(fields=['outcome', 'first_seen_at'], name='ztripe_aud_outcome_a5ce13_idx'),
        ),
        migrations.AddIndex(
            model_name='checkoutfulfillmentaudit',
            index=models.Index(fields=['provider_event_id', 'outcome'], name='ztripe_aud_event_outcome_idx'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('attempts__gte', 1)), name='ztripe_audit_attempts_positive'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('expected_stripe_mode', 'payment')), name='ztripe_audit_expected_mode_payment'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('expected_stripe_account_id__startswith', 'acct_')), name='ztripe_audit_account_canonical'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('outcome__in', ['credited', 'duplicate', 'rejected', 'reconciled'])), name='ztripe_audit_outcome_known'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.UniqueConstraint(condition=models.Q(('outcome__in', ['credited', 'duplicate'])), fields=('provider_event_id',), name='ztripe_audit_one_success_event'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('outcome', 'rejected'), ('stripe_transaction__isnull', False), _connector='OR'), name='ztripe_audit_success_has_transaction'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('outcome__in', ['rejected', 'reconciled']), ('provider_event_id__isnull', False), _connector='OR'), name='ztripe_audit_fulfillment_has_event'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('outcome__in', ['rejected', 'reconciled']), ('received_session_created_epoch__isnull', False), _connector='OR'), name='ztripe_audit_fulfillment_has_created'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(('outcome__in', ['rejected', 'reconciled']), ('intent__isnull', False), ('expected_legacy_session_created_at_or_before_epoch__isnull', False), _connector='OR'), name='ztripe_audit_legacy_success_has_cutoff'),
        ),
        migrations.AddConstraint(
            model_name='checkoutfulfillmentaudit',
            constraint=models.CheckConstraint(condition=models.Q(models.Q(('adjustment_tuzis__gte', 1), ('outcome', 'reconciled')), models.Q(models.Q(('outcome', 'reconciled'), _negated=True), ('adjustment_tuzis', 0)), _connector='OR'), name='ztripe_audit_adjustment_consistent'),
        ),
    ]
