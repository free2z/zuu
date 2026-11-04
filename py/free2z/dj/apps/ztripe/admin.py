from django.contrib import admin
from .models import (
    CheckoutFulfillmentAudit,
    CheckoutIntent,
    StripeTransaction,
    StripeWebhookReadiness,
)


class StripeTransactionAdmin(admin.ModelAdmin):
    list_display = ('user', 'amount', 'tuzis_credited',
                    'timestamp', 'stripe_charge_id')
    search_fields = ('user__username', 'stripe_charge_id')
    readonly_fields = ('timestamp',)
    ordering = ('-timestamp',)


admin.site.register(StripeTransaction, StripeTransactionAdmin)


class FinancialEvidenceAdmin(admin.ModelAdmin):
    """Expose settlement evidence for inspection without an edit backdoor."""

    def get_readonly_fields(self, request, obj=None):
        return tuple(field.name for field in self.model._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(CheckoutIntent)
class CheckoutIntentAdmin(FinancialEvidenceAdmin):
    list_display = (
        'public_id', 'user', 'tuzis', 'amount_cents', 'currency',
        'pricing_version', 'stripe_account_id', 'stripe_mode',
        'stripe_livemode', 'state', 'created_at',
    )
    search_fields = (
        'public_id', 'user__username', 'stripe_checkout_session_id',
        'stripe_payment_intent_id',
    )
    list_filter = (
        'state', 'currency', 'pricing_version', 'stripe_account_id',
        'stripe_mode', 'stripe_livemode',
    )


@admin.register(StripeWebhookReadiness)
class StripeWebhookReadinessAdmin(FinancialEvidenceAdmin):
    list_display = (
        'stripe_account_id', 'stripe_livemode', 'webhook_endpoint_id',
        'provider_event_id', 'verified_at',
    )
    search_fields = (
        'stripe_account_id', 'webhook_endpoint_id', 'provider_event_id',
    )
    list_filter = ('stripe_livemode',)


@admin.register(CheckoutFulfillmentAudit)
class CheckoutFulfillmentAuditAdmin(FinancialEvidenceAdmin):
    list_display = (
        'idempotency_key', 'outcome', 'reason', 'intent',
        'stripe_transaction', 'attempts', 'first_seen_at',
    )
    search_fields = (
        'idempotency_key', 'provider_event_id',
        'received_checkout_session_id', 'received_payment_intent_id',
    )
    list_filter = (
        'outcome', 'reason', 'received_currency',
        'expected_stripe_account_id', 'expected_stripe_mode',
        'expected_stripe_livemode',
    )
