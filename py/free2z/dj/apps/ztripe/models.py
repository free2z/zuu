import uuid

from django.db import models


class StripeTransaction(models.Model):
    user = models.ForeignKey(
        'g12f.Creator',
        on_delete=models.CASCADE,
        help_text="Reference to the creator that made the transaction."
    )
    # This will include fees and other charges
    amount = models.PositiveIntegerField(
        help_text="Total amount paid to stripe in cents"
    )
    tuzis_credited = models.PositiveIntegerField(
        help_text="Number of Tuzis credited to the user."
    )
    timestamp = models.DateTimeField(
        auto_now_add=True,
        help_text="Timestamp when the transaction was made."
    )
    stripe_charge_id = models.CharField(
        max_length=255,
        unique=True,
        help_text="Unique identifier for the transaction from Stripe."
    )

    def __str__(self):
        return f"{self.user} {self.tuzis_credited} {self.stripe_charge_id}"

    class Meta:
        ordering = ['-timestamp']


class CheckoutIntent(models.Model):
    """Server-owned card quote that a Stripe Session is allowed to fulfill."""

    class State(models.TextChoices):
        CREATING = 'creating', 'Creating provider session'
        OPEN = 'open', 'Open at provider'
        PROVIDER_FAILED = 'provider_failed', 'Provider creation failed'
        FULFILLED = 'fulfilled', 'Credited from verified webhook'

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    user = models.ForeignKey(
        'g12f.Creator',
        on_delete=models.PROTECT,
        related_name='stripe_checkout_intents',
    )
    tuzis = models.PositiveIntegerField()
    amount_cents = models.PositiveIntegerField()
    currency = models.CharField(max_length=3)
    pricing_version = models.CharField(max_length=32)
    stripe_account_id = models.CharField(max_length=255)
    stripe_mode = models.CharField(max_length=16)
    stripe_livemode = models.BooleanField()
    stripe_checkout_session_id = models.CharField(
        max_length=255, unique=True, null=True, blank=True,
    )
    stripe_payment_intent_id = models.CharField(
        max_length=255, unique=True, null=True, blank=True,
    )
    state = models.CharField(
        max_length=32, choices=State.choices, default=State.CREATING,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    fulfilled_at = models.DateTimeField(null=True, blank=True)
    # The SDK purchase intent this Session pays (PU1), or NULL for the
    # web wallet's own checkout. Nullable and additive: a pod on the previous
    # release inserts rows without it, and fulfilment treats NULL exactly as
    # before. See dj.apps.purchases.services.record_card_fulfillment.
    purchase_intent = models.ForeignKey(
        'purchases.PurchaseIntent',
        on_delete=models.PROTECT,
        related_name='checkout_intents',
        null=True,
        blank=True,
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(
                fields=['state', 'created_at'],
                name='ztripe_int_state_6f6b0a_idx',
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(tuzis__gte=1),
                name='ztripe_intent_tuzis_positive',
            ),
            models.CheckConstraint(
                condition=models.Q(amount_cents__gte=1),
                name='ztripe_intent_amount_positive',
            ),
            models.CheckConstraint(
                condition=models.Q(stripe_mode='payment'),
                name='ztripe_intent_mode_payment',
            ),
            models.CheckConstraint(
                condition=models.Q(stripe_account_id__startswith='acct_'),
                name='ztripe_intent_account_canonical',
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=[
                    'creating', 'open', 'provider_failed', 'fulfilled',
                ]),
                name='ztripe_intent_state_known',
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        state='fulfilled',
                        stripe_checkout_session_id__isnull=False,
                        stripe_payment_intent_id__isnull=False,
                        fulfilled_at__isnull=False,
                    )
                    | (
                        ~models.Q(state='fulfilled')
                        & models.Q(
                            stripe_payment_intent_id__isnull=True,
                            fulfilled_at__isnull=True,
                        )
                    )
                ),
                name='ztripe_intent_fulfillment_consistent',
            ),
            models.CheckConstraint(
                condition=(
                    ~models.Q(state='open')
                    | models.Q(stripe_checkout_session_id__isnull=False)
                ),
                name='ztripe_intent_open_has_session',
            ),
        ]


class StripeWebhookReadiness(models.Model):
    """Account-bound proof that the configured webhook secret delivered here."""

    singleton = models.PositiveSmallIntegerField(
        primary_key=True, default=1, editable=False,
    )
    stripe_account_id = models.CharField(max_length=255)
    stripe_livemode = models.BooleanField()
    webhook_endpoint_id = models.CharField(max_length=255)
    secret_key_fingerprint = models.CharField(max_length=64)
    signing_secret_fingerprint = models.CharField(max_length=64)
    provider_event_id = models.CharField(max_length=255)
    verified_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(singleton=1),
                name='ztripe_webhook_ready_singleton',
            ),
            models.CheckConstraint(
                condition=models.Q(stripe_account_id__startswith='acct_'),
                name='ztripe_webhook_ready_account',
            ),
            models.CheckConstraint(
                condition=models.Q(webhook_endpoint_id__startswith='we_'),
                name='ztripe_webhook_ready_endpoint',
            ),
        ]


class StripeCheckoutRollout(models.Model):
    """Immutable trust boundary for metadata-free rolling-deploy Sessions."""

    singleton = models.PositiveSmallIntegerField(
        primary_key=True, default=1, editable=False,
    )
    legacy_session_created_at_or_before_epoch = models.PositiveBigIntegerField()
    initialized_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(singleton=1),
                name='ztripe_checkout_rollout_singleton',
            ),
            models.CheckConstraint(
                condition=models.Q(
                    legacy_session_created_at_or_before_epoch__gte=1,
                ),
                name='ztripe_checkout_rollout_cutoff_positive',
            ),
        ]


class CheckoutFulfillmentAudit(models.Model):
    """Credential-free evidence for webhook and reconciliation decisions."""

    class Outcome(models.TextChoices):
        CREDITED = 'credited', 'Credited'
        DUPLICATE = 'duplicate', 'Duplicate delivery'
        REJECTED = 'rejected', 'Rejected contract'
        RECONCILED = 'reconciled', 'Historical under-credit reconciled'

    idempotency_key = models.CharField(max_length=320, unique=True)
    provider_event_id = models.CharField(
        max_length=255, null=True, blank=True,
    )
    intent = models.ForeignKey(
        CheckoutIntent,
        on_delete=models.PROTECT,
        related_name='fulfillment_audits',
        null=True,
        blank=True,
    )
    stripe_transaction = models.ForeignKey(
        StripeTransaction,
        on_delete=models.PROTECT,
        related_name='fulfillment_audits',
        null=True,
        blank=True,
    )
    outcome = models.CharField(max_length=32, choices=Outcome.choices)
    reason = models.CharField(max_length=64)
    received_checkout_session_id = models.CharField(max_length=255, blank=True)
    received_payment_intent_id = models.CharField(max_length=255, blank=True)
    received_session_created_epoch = models.PositiveBigIntegerField(
        null=True, blank=True,
    )
    expected_legacy_session_created_at_or_before_epoch = (
        models.PositiveBigIntegerField(null=True, blank=True)
    )
    received_user_id = models.PositiveBigIntegerField(null=True, blank=True)
    received_tuzis = models.PositiveIntegerField(null=True, blank=True)
    received_amount_cents = models.PositiveIntegerField(null=True, blank=True)
    received_currency = models.CharField(max_length=16, blank=True)
    received_pricing_version = models.CharField(max_length=32, blank=True)
    expected_stripe_account_id = models.CharField(max_length=255)
    expected_stripe_mode = models.CharField(max_length=16)
    expected_stripe_livemode = models.BooleanField()
    received_event_account_id = models.CharField(max_length=255, blank=True)
    received_stripe_mode = models.CharField(max_length=16, blank=True)
    received_stripe_livemode = models.BooleanField(null=True, blank=True)
    received_event_livemode = models.BooleanField(null=True, blank=True)
    received_metadata_account_id = models.CharField(max_length=255, blank=True)
    received_metadata_mode = models.CharField(max_length=16, blank=True)
    received_metadata_livemode = models.BooleanField(null=True, blank=True)
    adjustment_tuzis = models.PositiveIntegerField(default=0)
    attempts = models.PositiveIntegerField(default=1)
    first_seen_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-first_seen_at']
        indexes = [
            models.Index(
                fields=['outcome', 'first_seen_at'],
                name='ztripe_aud_outcome_a5ce13_idx',
            ),
            models.Index(
                fields=['provider_event_id', 'outcome'],
                name='ztripe_aud_event_outcome_idx',
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(attempts__gte=1),
                name='ztripe_audit_attempts_positive',
            ),
            models.CheckConstraint(
                condition=models.Q(expected_stripe_mode='payment'),
                name='ztripe_audit_expected_mode_payment',
            ),
            models.CheckConstraint(
                condition=models.Q(
                    expected_stripe_account_id__startswith='acct_'
                ),
                name='ztripe_audit_account_canonical',
            ),
            models.CheckConstraint(
                condition=models.Q(outcome__in=[
                    'credited', 'duplicate', 'rejected', 'reconciled',
                ]),
                name='ztripe_audit_outcome_known',
            ),
            models.UniqueConstraint(
                fields=['provider_event_id'],
                condition=models.Q(outcome__in=['credited', 'duplicate']),
                name='ztripe_audit_one_success_event',
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(outcome='rejected')
                    | models.Q(stripe_transaction__isnull=False)
                ),
                name='ztripe_audit_success_has_transaction',
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(outcome__in=['rejected', 'reconciled'])
                    | models.Q(provider_event_id__isnull=False)
                ),
                name='ztripe_audit_fulfillment_has_event',
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(outcome__in=['rejected', 'reconciled'])
                    | models.Q(received_session_created_epoch__isnull=False)
                ),
                name='ztripe_audit_fulfillment_has_created',
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(outcome__in=['rejected', 'reconciled'])
                    | models.Q(intent__isnull=False)
                    | models.Q(
                        expected_legacy_session_created_at_or_before_epoch__isnull=False
                    )
                ),
                name='ztripe_audit_legacy_success_has_cutoff',
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(outcome='reconciled', adjustment_tuzis__gte=1)
                    | (
                        ~models.Q(outcome='reconciled')
                        & models.Q(adjustment_tuzis=0)
                    )
                ),
                name='ztripe_audit_adjustment_consistent',
            ),
        ]
