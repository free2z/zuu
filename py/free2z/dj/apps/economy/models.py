"""USD contractual obligations, never another type of tuzi.

Amounts use integer nano-USD. One allocated m2Z under the existing nominal
service price is 10,000 nano-USD. No usage balance is redeemable through this
app. Records of old rights are retained separately and never initialize new
creator earnings.
"""
import uuid

from django.db import models
from django.db.models import Q, F
from django.db.models.functions import Now
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateTimeRangeField, RangeOperators


class EconomicPolicy(models.Model):
    id = models.BooleanField(primary_key=True, default=True)
    version = models.PositiveIntegerField(db_default=0)
    fenced = models.BooleanField(db_default=False)
    activated_at = models.DateTimeField(null=True)
    account_daily_limit_m2z = models.BigIntegerField(db_default=200_000_000)
    purchaser_daily_limit_nusd = models.BigIntegerField(db_default=10_000_000_000_000)
    manifest = models.JSONField(db_default={})

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(id=True), name='economy_policy_singleton'),
            models.CheckConstraint(condition=Q(version__in=[0, 1]), name='economy_policy_version'),
            models.CheckConstraint(condition=Q(account_daily_limit_m2z__gt=0, account_daily_limit_m2z__lte=200_000_000), name='economy_funding_limit'),
            models.CheckConstraint(condition=Q(purchaser_daily_limit_nusd__gt=0, purchaser_daily_limit_nusd__lte=10_000_000_000_000), name='economy_sales_limit'),
        ]


class LegalPayee(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    legal_name = models.TextField()
    jurisdiction = models.CharField(max_length=64)
    verification = models.JSONField()
    verified_at = models.DateTimeField()
    verified_by = models.CharField(max_length=128)


class CreatorPayable(models.Model):
    creator = models.OneToOneField('g12f.Creator', models.PROTECT)
    legal_payee = models.ForeignKey(LegalPayee, models.PROTECT, null=True)
    currency = models.CharField(max_length=3, db_default='USD')
    balance_nusd = models.BigIntegerField(db_default=0)
    held_nusd = models.BigIntegerField(db_default=0)
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(currency='USD'), name='economy_payable_usd'),
            models.CheckConstraint(condition=Q(held_nusd__gte=0), name='economy_held_nonnegative'),
            models.CheckConstraint(condition=Q(balance_nusd__gte=0), name='economy_owed_nonnegative'),
        ]


class CompensationAgreement(models.Model):
    creator = models.ForeignKey('g12f.Creator', models.PROTECT, related_name='+')
    accepted_by = models.ForeignKey('g12f.Creator', models.PROTECT, related_name='+')
    legal_payee = models.ForeignKey(LegalPayee, models.PROTECT)
    contract_version = models.CharField(max_length=64)
    contract_digest = models.CharField(max_length=64)
    accepted_at = models.DateTimeField()
    effective_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True)
    acceptance_evidence = models.JSONField()

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(effective_at__gte=F('accepted_at')), name='economy_agreement_effective')]


class CompensationSchedule(models.Model):
    service = models.CharField(max_length=64)
    version = models.CharField(max_length=64)
    contract_version = models.CharField(max_length=64)
    nusd_per_allocated_m2z = models.BigIntegerField()
    effective_at = models.DateTimeField()
    ends_at = models.DateTimeField(null=True)
    published_digest = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['service', 'version'], name='economy_schedule_version'),
            models.CheckConstraint(condition=Q(nusd_per_allocated_m2z__gt=0), name='economy_schedule_rate'),
            models.CheckConstraint(condition=Q(ends_at__isnull=True) | Q(ends_at__gt=F('effective_at')), name='economy_schedule_period'),
        ]


class ServiceAdmission(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    service = models.CharField(max_length=64)
    event_id = models.CharField(max_length=200)
    creator = models.ForeignKey('g12f.Creator', models.PROTECT)
    agreement = models.ForeignKey(CompensationAgreement, models.PROTECT)
    schedule = models.ForeignKey(CompensationSchedule, models.PROTECT)
    legal_payee = models.ForeignKey(LegalPayee, models.PROTECT)
    policy_version = models.PositiveIntegerField()
    admitted_at = models.DateTimeField()
    account = models.ForeignKey(CreatorPayable, models.PROTECT)
    source = models.JSONField()
    source_digest = models.CharField(max_length=64)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['service', 'event_id'], name='economy_service_identity')]


class PayableJournal(models.Model):
    account = models.ForeignKey(CreatorPayable, models.PROTECT)
    idempotency_key = models.CharField(max_length=240, unique=True)
    admission = models.ForeignKey(ServiceAdmission, models.PROTECT, null=True)
    delivery = models.OneToOneField('ServiceDelivery', models.PROTECT, null=True)
    payment = models.OneToOneField('PaymentRequest', models.PROTECT, null=True)
    delta_nusd = models.BigIntegerField()
    kind = models.CharField(max_length=24)
    allocated_m2z = models.BigIntegerField(null=True)
    basis = models.JSONField()
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['admission'], condition=Q(delivery__isnull=True), name='economy_original_admission_journal'),
            models.CheckConstraint(condition=~Q(delta_nusd=0) | Q(kind='service', allocated_m2z=0), name='economy_journal_nonzero'),
            models.CheckConstraint(condition=Q(kind__in=['service', 'adjustment', 'payment', 'usage_purchase']), name='economy_journal_kind'),
            models.CheckConstraint(condition=(Q(kind='service', admission__isnull=False, delta_nusd__gte=0, allocated_m2z__gte=0, allocated_m2z__isnull=False) | (~Q(kind='service') & Q(admission__isnull=True))), name='economy_service_journal'),
            models.CheckConstraint(condition=Q(kind='payment', payment__isnull=False, delta_nusd__lt=0) | (~Q(kind='payment') & Q(payment__isnull=True)), name='economy_payment_journal'),
        ]


class PaymentRequest(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    account = models.ForeignKey(CreatorPayable, models.PROTECT)
    idempotency_key = models.CharField(max_length=200)
    amount_nusd = models.BigIntegerField()
    address = models.TextField()
    legal_payee = models.ForeignKey(LegalPayee, models.PROTECT)
    requested_by = models.ForeignKey('g12f.Creator', models.PROTECT)
    address_authorization = models.JSONField()
    state = models.CharField(max_length=24, db_default='requested')
    review = models.JSONField(db_default={})
    settlement = models.JSONField(db_default={})
    txid = models.CharField(max_length=64, null=True, unique=True)
    created_at = models.DateTimeField(db_default=Now())
    updated_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['account', 'idempotency_key'], name='economy_payment_identity'),
            models.CheckConstraint(condition=Q(amount_nusd__gt=0), name='economy_payment_amount'),
            models.CheckConstraint(condition=Q(state__in=['requested', 'approved', 'signing', 'broadcast_unknown', 'broadcast', 'confirmed', 'rejected']), name='economy_payment_state'),
        ]


class LegacyClaim(models.Model):
    creator = models.ForeignKey('g12f.Creator', models.PROTECT)
    snapshot_key = models.CharField(max_length=128)
    snapshot_at = models.DateTimeField()
    usage_snapshot_m2z = models.BigIntegerField()
    classification = models.CharField(max_length=32, db_default='unclassified')
    liability_nusd = models.BigIntegerField(null=True)
    evidence = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['creator', 'snapshot_key'], name='economy_legacy_identity'),
            models.CheckConstraint(condition=Q(liability_nusd__isnull=True) | Q(liability_nusd__gte=0), name='economy_legacy_liability'),
        ]


class LegacyClaimDecision(models.Model):
    claim = models.ForeignKey(LegacyClaim, models.PROTECT, related_name='decisions')
    classification = models.CharField(max_length=32)
    liability_nusd = models.BigIntegerField(null=True)
    basis = models.JSONField()
    operator = models.CharField(max_length=128)
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(liability_nusd__isnull=True) | Q(liability_nusd__gte=0), name='economy_legacy_decision_amount')]


class FundingDay(models.Model):
    account = models.ForeignKey('ledger.Account', models.PROTECT)
    day = models.DateField()
    opening_m2z = models.BigIntegerField()
    incoming_m2z = models.BigIntegerField(db_default=0)
    reserved_m2z = models.BigIntegerField(db_default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['account', 'day'], name='economy_funding_day_identity'),
            models.CheckConstraint(condition=Q(opening_m2z__gte=0, incoming_m2z__gte=0, reserved_m2z__gte=0), name='economy_funding_day_nonnegative'),
        ]


class PurchaserDay(models.Model):
    purchaser = models.ForeignKey('g12f.Creator', models.PROTECT)
    day = models.DateField()
    sold_nusd = models.BigIntegerField(db_default=0)
    reserved_nusd = models.BigIntegerField(db_default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['purchaser', 'day'], name='economy_purchaser_day_identity'),
            models.CheckConstraint(condition=Q(sold_nusd__gte=0, reserved_nusd__gte=0), name='economy_purchaser_nonnegative'),
        ]


class FundingReservation(models.Model):
    recipient = models.ForeignKey('g12f.Creator', models.PROTECT, related_name='+')
    idempotency_key = models.CharField(max_length=200, unique=True)
    account = models.ForeignKey('ledger.Account', models.PROTECT, null=True)
    purchaser = models.ForeignKey('g12f.Creator', models.PROTECT)
    day = models.DateField()
    amount_m2z = models.BigIntegerField()
    sale_nusd = models.BigIntegerField()
    state = models.CharField(max_length=24, db_default='reserved')
    external_receipt = models.JSONField(db_default={})
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(amount_m2z__gt=0, sale_nusd__gte=0), name='economy_funding_res_amount'),
            models.CheckConstraint(condition=Q(state__in=['reserved', 'issuing', 'issued', 'released', 'resolution']), name='economy_funding_res_state'),
            models.CheckConstraint(condition=Q(account__isnull=False) | Q(state='resolution'), name='economy_funding_res_account'),
        ]


class SupplierOfferApproval(models.Model):
    """Actual licensed app contribution, bound to the original supplier."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    app = models.ForeignKey('ledger.LedgerApp', models.PROTECT)
    creator = models.ForeignKey('g12f.Creator', models.PROTECT)
    account = models.ForeignKey(CreatorPayable, models.PROTECT)
    legal_payee = models.ForeignKey(LegalPayee, models.PROTECT)
    agreement = models.ForeignKey(CompensationAgreement, models.PROTECT)
    schedule = models.ForeignKey(CompensationSchedule, models.PROTECT)
    markup_bps = models.PositiveIntegerField()
    evidence = models.JSONField()
    evidence_digest = models.CharField(max_length=64)
    approved_by = models.ForeignKey('g12f.Creator', models.PROTECT, related_name='+')
    approved_at = models.DateTimeField(db_default=Now())


class SupplierOfferRevocation(models.Model):
    offer = models.OneToOneField(SupplierOfferApproval, models.PROTECT)
    operator = models.ForeignKey('g12f.Creator', models.PROTECT)
    evidence = models.JSONField()
    created_at = models.DateTimeField(db_default=Now())


class SdkServiceAdmission(models.Model):
    call = models.OneToOneField('ledger.LedgerGatewayCall', models.PROTECT)
    admission = models.OneToOneField(ServiceAdmission, models.PROTECT)
    offer = models.ForeignKey(SupplierOfferApproval, models.PROTECT)
    subject = models.ForeignKey('g12f.Creator', models.PROTECT)


class ServiceDelivery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    admission = models.ForeignKey(ServiceAdmission, models.PROTECT)
    service = models.CharField(max_length=64)
    provider_key = models.CharField(max_length=240, unique=True)
    # Same original provider session + buyer across DIFFERENT admission IDs.
    cohort = models.CharField(max_length=240)
    interval = DateTimeRangeField(null=True)
    allocated_m2z = models.BigIntegerField()
    evidence = models.JSONField()
    evidence_digest = models.CharField(max_length=64)
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(allocated_m2z__gte=0), name='economy_delivery_allocation'),
            ExclusionConstraint(name='economy_ppv_nonoverlap', expressions=[
                ('cohort', RangeOperators.EQUAL), ('interval', RangeOperators.OVERLAPS)],
                condition=Q(service='livestream_ppv', interval__isnull=False)),
        ]


class CapturedZecNote(models.Model):
    """Raw wallet fact; no actor is invented to retain a received note."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    txid = models.CharField(max_length=64)
    pool = models.CharField(max_length=16)
    output_index = models.PositiveBigIntegerField()
    amount_zatoshi = models.BigIntegerField()
    memo_hex = models.CharField(max_length=1024, null=True)
    memo_plain = models.TextField(null=True)
    first_seen_at = models.DateTimeField(db_default=Now())
    source = models.JSONField()
    source_digest = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['txid', 'pool', 'output_index'], name='economy_global_note_identity'),
            models.CheckConstraint(condition=Q(pool__in=['sapling', 'orchard', 'ironwood']), name='economy_global_note_pool'),
            models.CheckConstraint(condition=Q(amount_zatoshi__gte=0, amount_zatoshi__lte=2_100_000_000_000_000), name='economy_global_note_amount'),
            models.CheckConstraint(condition=Q(output_index__lte=4_294_967_295), name='economy_global_note_index'),
        ]


class ZecNoteDisposition(models.Model):
    note = models.ForeignKey(CapturedZecNote, models.PROTECT, related_name='dispositions')
    event_key = models.CharField(max_length=240, unique=True)
    kind = models.CharField(max_length=32)
    actor = models.ForeignKey('g12f.Creator', models.PROTECT, null=True)
    intent = models.ForeignKey('purchases.PurchaseIntent', models.PROTECT, null=True)
    receipt = models.OneToOneField('tuzis.ZecCreditReceipt', models.PROTECT, null=True)
    funding = models.OneToOneField(FundingReservation, models.PROTECT, null=True)
    evidence = models.JSONField()
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [models.CheckConstraint(condition=Q(kind__in=[
            'observed', 'pending_confirmation', 'pending_resolution', 'ignored_zero', 'issued', 'legacy_issued', 'revoked']),
            name='economy_note_disposition_kind')]


class ZecPromotion(models.Model):
    """One global or code offer; evaluated only when a payment is processed."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True, blank=True, default='')
    title = models.CharField(max_length=160)
    multiplier = models.DecimalField(max_digits=8, decimal_places=4, default=1)
    enabled = models.BooleanField(default=False)
    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)

    def clean(self):
        from django.core.exceptions import ValidationError
        from dj.apps.pricing.promotions import normalize_code
        normalized = normalize_code(self.code)
        if self.code and normalized is None:
            raise ValidationError({'code': 'Use up to 64 ASCII letters, digits, underscores or hyphens.'})
        self.code = normalized or ''
        if not self.multiplier.is_finite() or self.multiplier < 1:
            raise ValidationError({'multiplier': 'Use a finite multiplier of at least one.'})
        if self.enabled and self.ends_at is None:
            raise ValidationError({'ends_at': 'Set an end time before enabling an offer.'})
        if self.starts_at and self.ends_at and self.ends_at <= self.starts_at:
            raise ValidationError({'ends_at': 'The end must follow the start.'})

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(multiplier__gte=1, multiplier__lte=9999), name='economy_zec_promo_multiplier'),
            models.CheckConstraint(condition=Q(code='') | Q(code__regex=r'^[A-Z0-9_-]{1,64}$'), name='economy_zec_promo_code'),
            models.CheckConstraint(condition=Q(ends_at__isnull=True) | Q(starts_at__isnull=True) | Q(ends_at__gt=F('starts_at')), name='economy_zec_promo_period'),
            models.CheckConstraint(condition=Q(enabled=False) | Q(ends_at__isnull=False), name='economy_zec_promo_enabled_end'),
        ]
