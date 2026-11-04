"""Exact public amounts and consent; no JSON floating point on money paths."""
import re

from rest_framework import serializers


class USDField(serializers.CharField):
    def to_internal_value(self, data):
        if not isinstance(data, str) or len(data) > 20 or not re.fullmatch(r'(0|[1-9][0-9]*)\.[0-9]{9}', data):
            raise serializers.ValidationError('Use a USD string with exactly nine decimal places.')
        amount = int(data.replace('.', ''))
        if not 0 < amount <= 9223372036854775807:
            raise serializers.ValidationError('Amount is outside the supported positive range.')
        return data


class AcknowledgementField(serializers.BooleanField):
    def to_internal_value(self, data):
        if data is not True:
            raise serializers.ValidationError('An explicit boolean true acknowledgement is required.')
        return True


class ActorIDField(serializers.IntegerField):
    def to_internal_value(self, data):
        if type(data) is not int or not 0 < data <= 9223372036854775807:
            raise serializers.ValidationError('An exact authenticated actor ID is required.')
        return data


class ScheduleReferenceSerializer(serializers.Serializer):
    service = serializers.CharField()
    version = serializers.CharField()
    digest = serializers.CharField()


class PublishedScheduleSerializer(ScheduleReferenceSerializer):
    text = serializers.CharField()
    currency = serializers.ChoiceField(choices=['USD'])
    usd_per_allocated_m2z = serializers.CharField()


class AgreementSerializer(serializers.Serializer):
    version = serializers.CharField()
    digest = serializers.CharField()
    text = serializers.CharField()
    schedules = PublishedScheduleSerializer(many=True)


class AcceptAgreementSerializer(serializers.Serializer):
    expected_actor_id = ActorIDField()
    version = serializers.CharField()
    digest = serializers.CharField()
    schedules = ScheduleReferenceSerializer(many=True)
    acknowledged = AcknowledgementField()

    def validate_acknowledged(self, value):
        if value is not True:
            raise serializers.ValidationError('Explicit agreement is required.')
        return value


class AcceptedAgreementSerializer(serializers.Serializer):
    version = serializers.CharField()
    digest = serializers.CharField()
    accepted_at = serializers.DateTimeField()
    agreement_accepted = serializers.BooleanField()


class FundingMethodSerializer(serializers.Serializer):
    version = serializers.CharField()
    text = serializers.CharField()
    digest = serializers.CharField()


class CapabilitiesSerializer(serializers.Serializer):
    policy_version = serializers.ChoiceField(choices=[0, 1])
    active = serializers.BooleanField()
    creator_compensation_available = serializers.BooleanField()
    zec_funding_method = FundingMethodSerializer()


class LegalPayeeSerializer(serializers.Serializer):
    display_name = serializers.CharField()
    jurisdiction = serializers.CharField()


class EarningsActivitySerializer(serializers.Serializer):
    id = serializers.CharField(help_text='Opaque original payable journal reference.')
    service = serializers.ChoiceField(choices=['livestream_ppv', 'sdk_application'])
    currency = serializers.ChoiceField(choices=['USD'])
    amount = serializers.CharField(help_text='Exact recorded service compensation in fixed-nine-decimal USD.')
    created_at = serializers.DateTimeField()


class EarningsSerializer(serializers.Serializer):
    actor_id = ActorIDField()
    currency = serializers.ChoiceField(choices=['USD'])
    balance = serializers.CharField()
    held = serializers.CharField()
    available = serializers.CharField()
    payment_in_flight = serializers.CharField()
    recovery = serializers.CharField(allow_null=True)
    recovery_available = serializers.BooleanField()
    agreement_accepted = serializers.BooleanField()
    compensation_eligible = serializers.BooleanField()
    legal_payee = LegalPayeeSerializer(allow_null=True)
    onboarding_required = serializers.BooleanField()
    legacy_review_pending = serializers.BooleanField(required=False)
    recent_activity = EarningsActivitySerializer(many=True)


class PaymentCreateSerializer(serializers.Serializer):
    expected_actor_id = ActorIDField()
    amount = USDField()
    address = serializers.CharField(max_length=512, trim_whitespace=False)
    idempotency_key = serializers.RegexField(r'^[A-Za-z0-9._:-]{1,128}$')


class PaymentSettlementSerializer(serializers.Serializer):
    usd_per_zec = serializers.CharField()
    amount_zec = serializers.CharField()
    fee_zec = serializers.CharField()
    quoted_at = serializers.CharField()
    rate_source = serializers.CharField(allow_null=True)
    usd_satisfaction = serializers.CharField()
    rounding_expense = serializers.CharField()
    pricing_method_version = serializers.CharField()


class PaymentSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    currency = serializers.ChoiceField(choices=['USD'])
    amount = serializers.CharField()
    state = serializers.ChoiceField(choices=['requested', 'approved', 'signing', 'broadcast_unknown', 'broadcast', 'confirmed', 'rejected'])
    held = serializers.BooleanField()
    created_at = serializers.DateTimeField()
    updated_at = serializers.DateTimeField()
    txid = serializers.CharField(allow_null=True)
    settlement = PaymentSettlementSerializer(allow_null=True)


class PaymentListSerializer(serializers.Serializer):
    actor_id = ActorIDField()
    results = PaymentSerializer(many=True)


class UsageQuoteSerializer(serializers.Serializer):
    currency = serializers.CharField()
    amount = serializers.CharField()
    quote_version = serializers.CharField()
    quote_digest = serializers.CharField()
    usd_per_tuzi = serializers.CharField()
    usage_total_m2z = serializers.CharField()
    usage_debt_repaid_m2z = serializers.CharField()
    usage_credited_m2z = serializers.CharField()
    expires_at = serializers.DateTimeField()
    quote_token = serializers.CharField()


class UsagePurchaseSerializer(serializers.Serializer):
    expected_actor_id = ActorIDField()
    amount = USDField()
    idempotency_key = serializers.RegexField(r'^[A-Za-z0-9._:-]{1,128}$')
    quote_token = serializers.CharField(max_length=8192, trim_whitespace=False)
    acknowledged = AcknowledgementField()

    def validate_acknowledged(self, value):
        if value is not True:
            raise serializers.ValidationError('Confirm the displayed purchase quote.')
        return value


class UsageReceiptSerializer(serializers.Serializer):
    id = serializers.CharField(help_text='Opaque stable receipt reference.')
    status = serializers.ChoiceField(choices=['completed'])
    replayed = serializers.BooleanField()
    currency = serializers.CharField()
    amount = serializers.CharField()
    created_at = serializers.DateTimeField()
    usage_total_m2z = serializers.CharField()
    usage_credited_m2z = serializers.CharField()
    usage_debt_repaid_m2z = serializers.CharField()
    usage_balance_m2z = serializers.CharField()
    payable_balance = serializers.CharField()
    quote_version = serializers.CharField()
    quote_digest = serializers.CharField()


class FundingResolutionSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=['pending_resolution'])
    credited = serializers.BooleanField()
    resolution_id = serializers.CharField(help_text='Opaque, namespace-bearing reference; not a UUID.')
    reason = serializers.CharField()
    created_at = serializers.DateTimeField()


class FundingCapacitySerializer(serializers.Serializer):
    as_of = serializers.DateTimeField()
    remaining_m2z = serializers.CharField(help_text='Current usage-credit capacity in m2Z; advisory, not reserved.')
    remaining_sale_nusd = serializers.CharField(help_text='Current gross purchaser capacity in nano-USD; advisory, not reserved.')


class FundingResolutionListSerializer(serializers.Serializer):
    actor_id = ActorIDField()
    results = FundingResolutionSerializer(many=True)
    zec_funding_capacity = FundingCapacitySerializer(allow_null=True)


class EconomyErrorSerializer(serializers.Serializer):
    code = serializers.CharField()
    detail = serializers.CharField()
