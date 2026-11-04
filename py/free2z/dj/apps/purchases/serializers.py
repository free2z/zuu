"""Wire shapes: zuu ``docs/free2z/sdk/spec/purchase.md`` §1.2 / §2 and the error
envelope of ``errors.md`` §1."""
from __future__ import annotations

import datetime

from rest_framework import serializers
from dj.apps.economy.serializers import ActorIDField

from .models import CREDITED_STATUSES, Platform, Status

WIRE_RAILS = ("card", "zcash", "apple_iap", "google_iap")


class PurchaseIntentCreateSerializer(serializers.Serializer):
    expected_actor_id = ActorIDField(required=False, help_text='Required for authenticated Zcash funding. Assert the actor who reviewed the intent; it is not authorization.')
    rail = serializers.ChoiceField(choices=WIRE_RAILS)
    quantity_2z = serializers.IntegerField(
        help_text="Whole 2Z. Card: 100 to 10,000. Zcash: 1 to 200,000, subject to current account and purchaser funding capacity.",
    )
    platform = serializers.ChoiceField(choices=[p.value for p in Platform])
    return_url = serializers.CharField(
        required=False,
        max_length=2048,
        trim_whitespace=False,
        help_text=(
            "Card only, and required for card. Where the hosted checkout sends "
            "the browser afterwards: a loopback URI (`http://127.0.0.1:<port>/...` "
            "or `http://[::1]:<port>/...`), one of the calling app's registered "
            "https redirect URIs exactly, or -- for a first-party session -- an "
            "https URL on a Free2Z origin. No query string and no fragment: "
            "the platform appends `?purchase_id=<id>&status=success` "
            "(or `status=cancel`)."
        ),
    )
    embed = serializers.BooleanField(
        required=False,
        default=False,
        help_text="The embedded payment element (spec §3) is not offered yet; `true` is 400.",
    )


class PriceSerializer(serializers.Serializer):
    currency = serializers.CharField(help_text="ISO 4217, upper case.")
    amount_minor = serializers.IntegerField(help_text="Minor units: 550 USD is $5.50.")


class ZcashFundingSerializer(serializers.Serializer):
    funding_method_version = serializers.CharField()
    funding_method_digest = serializers.CharField()
    funding_method_text = serializers.CharField()
    address = serializers.CharField()
    amount_zec = serializers.CharField(help_text='Exact eight-decimal ZEC amount sent to the company; wallet network fee is separate.')
    memo = serializers.CharField()
    gross_usd = serializers.CharField()
    associated_value_usd = serializers.CharField()
    payment_observed = serializers.BooleanField()
    quoted_at = serializers.DateTimeField()
    source_names = serializers.ListField(child=serializers.CharField())
    zec_usd = serializers.CharField()
    spread = serializers.CharField()
    tuzis_per_zec = serializers.CharField()
    bonus_m2z = serializers.CharField()
    expires_at = serializers.DateTimeField()


class PurchaseIntentSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    rail = serializers.ChoiceField(choices=WIRE_RAILS)
    status = serializers.ChoiceField(choices=[s.value for s in Status])
    quantity_2z = serializers.IntegerField()
    price = PriceSerializer()
    pricing_version = serializers.CharField()
    created_at = serializers.DateTimeField()
    expires_at = serializers.DateTimeField()
    credited_at = serializers.DateTimeField(allow_null=True)
    credited_milli_2z = serializers.IntegerField(allow_null=True)
    can_replace_instruction = serializers.BooleanField(help_text='True only for an expired, unobserved ZEC instruction whose original funding capacity is actually released. Retain its reference: later actual funds remain under original resolution.')
    usage_credited_m2z = serializers.CharField(allow_null=True, help_text='Exact original m2Z added to usage; digit string, null when original ledger issuance is unproved.')
    usage_debt_repaid_m2z = serializers.CharField(allow_null=True, help_text='Exact original purchase m2Z applied to prior usage debt; digit string, null when unproved. Its sum with usage_credited_m2z equals total credited_milli_2z.')
    rail_data = serializers.DictField(
        help_text="Rail-specific. Card: `{\"checkout_url\": \"https://checkout.stripe.com/...\"}`.",
    )
    zcash_funding = ZcashFundingSerializer(required=False)


def intent_payload(intent) -> dict:
    """The spec §1.2 object for ``intent``."""
    credited = intent.status in CREDITED_STATUSES
    from dj.apps.economy.funding import purchase_intent_issuance_status
    issuance = purchase_intent_issuance_status(intent)
    payload = {
        "id": intent.pk,
        "rail": intent.wire_rail,
        "status": intent.status,
        "quantity_2z": intent.quantity_2z,
        "price": {"currency": intent.currency, "amount_minor": intent.price_minor},
        "pricing_version": intent.pricing_version,
        "created_at": intent.created_at,
        "expires_at": intent.expires_at,
        "credited_at": intent.credited_at if credited else None,
        "credited_milli_2z": intent.credited_milli_2z if credited else None,
        "can_replace_instruction": False,
        "usage_credited_m2z": issuance['usage_credited_m2z'],
        "usage_debt_repaid_m2z": issuance['usage_debt_repaid_m2z'],
        "rail_data": intent.rail_data or {},
    }
    if intent.wire_rail == 'zcash':
        from dj.apps.economy.captured_notes import original_intent_has_captured_payment
        if original_intent_has_captured_payment(intent):
            payload['rail_data'] = dict(payload['rail_data'], payment_observed=True)
        from dj.apps.economy.models import FundingReservation
        payload['can_replace_instruction'] = bool(intent.status == 'expired' and not payload['rail_data'].get('payment_observed') and
            FundingReservation.objects.filter(idempotency_key=f'zec-intent:{intent.pk}', recipient_id=intent.creator_id,
                purchaser_id=intent.creator_id, state='released').exists())
        from dj.apps.economy import contracts
        allowed = ('address', 'amount_zec', 'memo', 'gross_usd', 'associated_value_usd', 'payment_observed')
        payload['rail_data'] = {key: payload['rail_data'][key] for key in allowed if key in payload['rail_data']}
        quote = intent.quote or {}
        method = contracts.zec_funding_method(quote.get('pricing_version'), quote.get('funding_method_digest'))
        if method is not None:
            from dj.apps.pricing.sources import SOURCES
            payload['zcash_funding'] = dict(payload['rail_data'],
                funding_method_version=method['version'], funding_method_digest=method['digest'],
                funding_method_text=method['text'], quoted_at=quote['quoted_at'],
                source_names=sorted(key for key in quote['sources'] if key in SOURCES), zec_usd=quote['zec_usd'], spread=quote['spread'],
                tuzis_per_zec=quote['tuzis_per_zec'], bonus_m2z=quote['bonus_m2z'], expires_at=intent.expires_at)
    return PurchaseIntentSerializer(payload).data


class BalanceSerializer(serializers.Serializer):
    """Spec §1.1, and ``f2z_ai_proto::balance::Balance`` field for field:
    four non-negative integers of milli-2Z and an RFC 3339 UTC instant."""

    available_milli_2z = serializers.IntegerField(
        min_value=0,
        help_text="What can be spent now: `balance - held`, and `0` while `debt_milli_2z` is non-zero. Apps show this.",
    )
    held_milli_2z = serializers.IntegerField(
        min_value=0, help_text="The sum of open AI-call holds; normally `0` when nothing is streaming.",
    )
    balance_milli_2z = serializers.IntegerField(
        min_value=0, help_text="The balance, holds included. Never has the debt folded into it.",
    )
    debt_milli_2z = serializers.IntegerField(
        min_value=0,
        help_text=(
            "What the account owes after a reversal took back 2Z already spent. Always present, "
            "never negative; while non-zero every spend is refused with 403 `account_in_debt`."
        ),
    )
    as_of = serializers.DateTimeField(
        format="%Y-%m-%dT%H:%M:%SZ",
        default_timezone=datetime.timezone.utc,
        help_text="When the numbers were read, RFC 3339 UTC.",
    )


class ErrorBodySerializer(serializers.Serializer):
    code = serializers.CharField(
        help_text=(
            "`invalid_request`, `invalid_quantity`, `rail_unavailable`, "
            "`idempotency_conflict`, `purchase_not_found`, "
            "`checkout_not_activated`, `checkout_not_configured`, "
            "`checkout_host_policy_unavailable`, `stripe_unavailable`, "
            "`stripe_invalid_session`, `checkout_state_conflict`."
        ),
    )
    message = serializers.CharField()
    details = serializers.DictField(required=False)


class ErrorEnvelopeSerializer(serializers.Serializer):
    error = ErrorBodySerializer()
