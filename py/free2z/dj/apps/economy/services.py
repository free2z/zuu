"""Trusted, transaction-bound primitives for the economic-policy adapters.

These are internal services, not public authorization endpoints. Product
adapters must authenticate actors, verify service delivery and server-owned
allocation, and pass stable receipt identities. New behavior refuses policy 0.
"""
from __future__ import annotations


import hashlib
import json
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import timedelta, timezone as datetime_timezone

from django.db import connection, transaction
from django.db.models import F, Sum
from django.utils import timezone

from dj.apps.ledger import api as usage
from dj.apps.g12f.validators import validate_zcash_address
from .models import (
    CompensationAgreement, CompensationSchedule, CreatorPayable, EconomicPolicy,
    FundingDay, FundingReservation, LegalPayee, LegacyClaim, LegacyClaimDecision, PayableJournal,
    PaymentRequest, PurchaserDay, ServiceAdmission,
)

NUSD_PER_USD = 1_000_000_000
NUSD_PER_NOMINAL_M2Z = 10_000
from .contracts import CREATOR_CONTRACT_VERSION

CONTRACT_VERSION = CREATOR_CONTRACT_VERSION


class EconomicRefusal(ValueError):
    """Expected refusal; callers preserve captured external receipts."""


class IdempotencyConflict(EconomicRefusal):
    pass


def _integer(value, *, positive=False):
    if type(value) is not int or (positive and value <= 0):
        raise ValueError('economic amounts must be exact positive integers' if positive else 'economic amounts must be exact integers')
    return value


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _evidence(value, *keys):
    if not isinstance(value, dict) or any(not value.get(key) for key in keys):
        raise EconomicRefusal('missing attributable evidence')
    _digest(value)  # refuse non-JSON and NaN before touching money
    return value


def pin_policy(expected_version=1):
    """Pin policy in this transaction. Old unversioned DB writers fail closed.

    Call before acquiring any creator/account locks, before economic mutations.
    The central DB trigger uses NOWAIT for stale writers that already hold them.
    The SHARE lock lasts through commit and fences a simultaneous activation.
    """
    if not connection.in_atomic_block:
        raise RuntimeError('pin_policy requires transaction.atomic()')
    with connection.cursor() as cursor:
        cursor.execute("SELECT set_config('free2z.economic_policy_version',%s,true)", [str(expected_version)])
        cursor.execute('SELECT version,fenced FROM economy.policy()')
        row = cursor.fetchone()
    if row is None or row[0] != expected_version:
        raise EconomicRefusal('economic_policy_disabled')
    if row[1]:
        raise EconomicRefusal('economic_writers_fenced')
    return expected_version


def _payable(creator_id):
    if usage.lock_creator(creator_id) is None:
        raise EconomicRefusal('creator_not_found')
    account, _ = CreatorPayable.objects.get_or_create(creator_id=creator_id)
    return CreatorPayable.objects.select_for_update().get(pk=account.pk)


@transaction.atomic
def register_legal_payee(*, creator_id, legal_name, jurisdiction, verification, operator):
    """Record an attributable manual identity decision; no inferred approval."""
    _evidence(verification, 'identity_reference', 'authority_reference')
    if not legal_name.strip() or not jurisdiction.strip() or not operator.strip():
        raise EconomicRefusal('missing legal payee identity')
    account = _payable(creator_id)
    if account.legal_payee_id is not None:
        raise EconomicRefusal('payee_already_bound_requires_assignment_review')
    payee = LegalPayee.objects.create(legal_name=legal_name, jurisdiction=jurisdiction,
        verification=dict(verification, creator_id=creator_id), verified_at=timezone.now(), verified_by=operator)
    account.legal_payee = payee
    account.save(update_fields=['legal_payee'])
    return payee


@transaction.atomic
def accept_agreement(*, creator_id, legal_payee_id, contract_digest, acceptance_evidence,
                     contract_version=CONTRACT_VERSION):
    """Adapters must serve and verify the canonical document digest first."""
    _evidence(acceptance_evidence, 'document_reference', 'actor_authentication', 'authority_reference')
    if len(contract_digest) != 64 or any(c not in '0123456789abcdef' for c in contract_digest):
        raise EconomicRefusal('invalid_contract_digest')
    if contract_version != CONTRACT_VERSION:
        raise EconomicRefusal('unsupported_contract_version')
    account = _payable(creator_id)
    payee = LegalPayee.objects.get(pk=legal_payee_id)
    if account.legal_payee_id != payee.pk:
        raise EconomicRefusal('legal_payee_change_requires_assignment_review')
    # Acceptance can precede activation; its effective time is never backdated.
    now = _db_now()
    existing = CompensationAgreement.objects.filter(creator_id=creator_id, legal_payee=payee,
        contract_version=contract_version, contract_digest=contract_digest, revoked_at__isnull=True).first()
    if existing:
        if existing.acceptance_evidence.get('schedules') != acceptance_evidence.get('schedules'):
            raise IdempotencyConflict('agreement_schedule_acceptance_changed')
        return existing
    return CompensationAgreement.objects.create(creator_id=creator_id, accepted_by_id=creator_id,
        legal_payee=payee, contract_version=contract_version, contract_digest=contract_digest,
        accepted_at=now, effective_at=now, acceptance_evidence=acceptance_evidence)


@transaction.atomic
def admit_service(*, creator_id, service, event_id, agreement_id, schedule_id, source, expected_version=1):
    """Capture payee + agreement + schedule BEFORE a compensated service starts.

    Source evidence must come from the product's verified app/meeting owner and
    consumer admission. There is deliberately no balance-to-payable operation.
    """
    _evidence(source, 'source_kind', 'source_id', 'authorization_reference')
    pin_policy(expected_version)
    account = _payable(creator_id)
    fingerprint = _digest(source)
    existing = ServiceAdmission.objects.filter(service=service, event_id=event_id).first()
    if existing:
        if (existing.creator_id, existing.agreement_id, existing.schedule_id, existing.source_digest) != (creator_id, agreement_id, schedule_id, fingerprint):
            raise IdempotencyConflict('service identity reused with different admission')
        return existing
    agreement = CompensationAgreement.objects.get(pk=agreement_id)
    schedule = CompensationSchedule.objects.get(pk=schedule_id)
    # The DB validates effective dates, revocation and all captured identities.
    return ServiceAdmission.objects.create(service=service, event_id=event_id,
        creator_id=creator_id, account=account, agreement=agreement, schedule=schedule,
        legal_payee=agreement.legal_payee, policy_version=expected_version,
        admitted_at=_db_now(), source=source, source_digest=fingerprint)


@transaction.atomic
def settle_service(*, admission_id, allocated_m2z, delivery_evidence, expected_version=1):
    """Book actual USD debt exactly once for VERIFIED DELIVERED service.

    allocated_m2z is the contractual service allocation, never a held or shared
    balance. Prior admissions retain their payee when app ownership changes.
    """
    _integer(allocated_m2z)
    if allocated_m2z < 0:
        raise EconomicRefusal('negative_service_allocation')
    _evidence(delivery_evidence, 'delivery_reference', 'allocation_reference')
    admission = ServiceAdmission.objects.get(pk=admission_id)
    pin_policy(expected_version)
    from django.db.models import Q
    existing = PayableJournal.objects.filter(admission=admission).filter(
        Q(delivery__isnull=True)|Q(delivery__provider_key=delivery_evidence['delivery_reference'])).first()
    if existing:
        relevant = ('provider_event_id','payload_sha256','provider_session_id','meeting_id','participant_id','joined_at','left_at')
        same_basis = (existing.basis == delivery_evidence if existing.delivery_id is None else
            all(existing.basis.get(key)==delivery_evidence.get(key) for key in relevant))
        if existing.allocated_m2z != allocated_m2z or not same_basis:
            raise IdempotencyConflict('service settlement changed on replay')
        return existing
    if admission.service == 'livestream_ppv':
        _evidence(delivery_evidence,'provider_event_id','payload_sha256','provider_session_id',
            'meeting_id','participant_id','joined_at','left_at')
        from .products import settle_livestream_delivery
        return settle_livestream_delivery(admission_id=admission.pk,
            event_key=delivery_evidence['delivery_reference'],evidence=delivery_evidence,
            expected_allocated_m2z=allocated_m2z)
    raise EconomicRefusal('sdk_settlement_requires_original_usage_delivery')


@transaction.atomic
def adjust_payable(*, creator_id, delta_nusd, idempotency_key, basis, operator):
    _integer(delta_nusd)
    if delta_nusd == 0 or not operator.strip():
        raise EconomicRefusal('adjustment_requires_nonzero_amount_and_operator')
    _evidence(basis, 'contractual_basis', 'reason', 'source_reference')
    pin_policy()
    account = _payable(creator_id)
    payload = dict(basis, operator=operator)
    existing = PayableJournal.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        if (existing.account_id, existing.kind, existing.delta_nusd, existing.basis) != (account.pk, 'adjustment', delta_nusd, payload):
            raise IdempotencyConflict('adjustment changed on replay')
        return existing
    if account.legal_payee_id is None or account.balance_nusd + delta_nusd < account.held_nusd:
        raise EconomicRefusal('adjustment_exceeds_owed_amount_requires_separate_recovery')
    # Recovery receivables are never disguised as negative creator earnings.
    return PayableJournal.objects.create(account=account, idempotency_key=idempotency_key,
        kind='adjustment', delta_nusd=delta_nusd, basis=payload)


@transaction.atomic
def request_payment(*, creator_id, amount_nusd, address, idempotency_key, address_authorization):
    _integer(amount_nusd, positive=True)
    validate_zcash_address(address)
    if not address.startswith(('u1', 'zs')):
        raise EconomicRefusal('shielded_payment_address_required')
    _evidence(address_authorization, 'actor_authentication', 'address_reference',
              'pricing_method_version', 'pricing_method_digest', 'compensation_agreement_id', 'payment_terms_reference')
    pin_policy()
    account = _payable(creator_id)
    existing = PaymentRequest.objects.filter(account=account, idempotency_key=idempotency_key).first()
    if existing:
        if (existing.amount_nusd, existing.address, existing.address_authorization) != (amount_nusd, address, address_authorization):
            raise IdempotencyConflict('payment request changed on replay')
        return existing
    if account.legal_payee_id is None or amount_nusd > account.balance_nusd - account.held_nusd:
        raise EconomicRefusal('insufficient_payable')
    method_digest = address_authorization['pricing_method_digest']
    if not isinstance(method_digest, str) or len(method_digest)!=64 or any(c not in '0123456789abcdef' for c in method_digest):
        raise EconomicRefusal('invalid_payment_pricing_method_digest')
    agreement = CompensationAgreement.objects.filter(pk=address_authorization['compensation_agreement_id'],
        creator_id=creator_id, legal_payee_id=account.legal_payee_id, effective_at__lte=_db_now()).first()
    if agreement is None:
        raise EconomicRefusal('payment_method_requires_actual_accepted_agreement')
    # Prospective revocation stops future service admission, not payment of
    # vested obligations. The canonical contract's payment terms survive it.
    if address_authorization['payment_terms_reference'] != f'{agreement.contract_version}:surviving-payment-terms':
        raise EconomicRefusal('payment_surviving_terms_reference_required')
    request = PaymentRequest.objects.create(account=account, amount_nusd=amount_nusd,
        address=address, legal_payee_id=account.legal_payee_id, requested_by_id=creator_id,
        address_authorization=address_authorization, idempotency_key=idempotency_key)
    account.held_nusd += amount_nusd
    account.save(update_fields=['held_nusd'])
    return request


def _payment(payment_id):
    untrusted = PaymentRequest.objects.get(pk=payment_id)
    pin_policy()
    account = _payable(untrusted.account.creator_id)
    payment = PaymentRequest.objects.select_for_update().get(pk=payment_id)
    if payment.legal_payee_id != account.legal_payee_id:
        raise EconomicRefusal('payment_legal_payee_mismatch')
    return account, payment


def _review_is_current(review):
    _evidence(review, 'reviewer', 'identity_reference', 'screening_reference',
              'tax_reference', 'address_reference', 'screened_at')
    if review.get('screening_result') != 'clear' or review.get('tax_eligible') is not True or review.get('identity_eligible') is not True:
        raise EconomicRefusal('payment_review_not_clear')
    if review.get('withholding_required') is not False or review.get('fee_bearer') != 'platform':
        raise EconomicRefusal('withholding_or_creator_fee_requires_separate_settlement_flow')
    from django.utils.dateparse import parse_datetime
    screened_at = parse_datetime(review['screened_at'])
    now = timezone.now()
    if screened_at is None or timezone.is_naive(screened_at) or not now - timedelta(hours=24) <= screened_at <= now:
        raise EconomicRefusal('payment_screening_stale')


def _latest_review(review):
    observations = review.get('rescreening_observations', [])
    return observations[-1] if observations else review


@transaction.atomic
def review_payment(*, payment_id, review):
    account, payment = _payment(payment_id)
    if 'rescreening_observations' in review or 'rejection' in review:
        raise EconomicRefusal('payment_review_reserved_history')
    _review_is_current(review)
    if review.get('legal_payee_id') != str(payment.legal_payee_id) or review.get('address') != payment.address:
        raise EconomicRefusal('payment_review_identity_mismatch')
    if payment.state != 'requested':
        if payment.state != 'approved':
            raise EconomicRefusal('payment_not_reviewable')
        if _latest_review(payment.review) == review:
            return payment
        observations = list(payment.review.get('rescreening_observations', []))
        payment.review = dict(payment.review, rescreening_observations=observations + [review])
    else:
        payment.review = review
    payment.state = 'approved'
    payment.updated_at = timezone.now()
    payment.save(update_fields=['review', 'state', 'updated_at'])
    return payment


@transaction.atomic(durable=True)
def begin_payment_signing(*, payment_id, settlement):
    account, payment = _payment(payment_id)
    _evidence(settlement, 'operator', 'rate_reference', 'usd_per_zec', 'amount_zec', 'fee_zec', 'signing_reference', 'quoted_at',
              'pricing_method_version', 'pricing_method_digest', 'compensation_agreement_id')
    if payment.state != 'approved':
        raise EconomicRefusal('payment_already_started_or_not_approved')
    latest_review = _latest_review(payment.review)
    _review_is_current(latest_review)
    if latest_review.get('legal_payee_id') != str(payment.legal_payee_id) or latest_review.get('address') != payment.address:
        raise EconomicRefusal('payment_review_identity_mismatch')
    from django.utils.dateparse import parse_datetime
    quoted_at = parse_datetime(settlement['quoted_at'])
    now = timezone.now()
    if quoted_at is None or timezone.is_naive(quoted_at) or not now-timedelta(minutes=5)<=quoted_at<=now:
        raise EconomicRefusal('payment_market_quote_stale')
    for key in ('pricing_method_version', 'pricing_method_digest', 'compensation_agreement_id'):
        if settlement[key] != payment.address_authorization[key]:
            raise EconomicRefusal('payment_pricing_method_authorization_mismatch')
    try:
        if any(type(settlement[key]) is not str for key in ('usd_per_zec','amount_zec','fee_zec')):
            raise ValueError('settlement decimals must be strings')
        rate = Decimal(settlement['usd_per_zec'])
        amount = Decimal(settlement['amount_zec'])
        fee = Decimal(settlement['fee_zec'])
        if not all(v.is_finite() for v in (rate, amount, fee)) or rate<=0 or amount<=0 or fee<0:
            raise ValueError('invalid settlement value')
        if amount != amount.quantize(Decimal('.00000001')) or fee != fee.quantize(Decimal('.00000001')):
            raise ValueError('Zcash precision exceeds zatoshi')
        calculated = amount*rate*NUSD_PER_USD
        rounding = int(calculated.to_integral_value(rounding=ROUND_HALF_UP))-payment.amount_nusd
        if not Decimal(0)<=calculated-payment.amount_nusd<rate*Decimal('10'):
            raise ValueError('Zcash must cover debt; company rounding expense must be less than one zatoshi')
        if settlement.get('usd_satisfaction_nusd')!=str(payment.amount_nusd) or settlement.get('rounding_nusd')!=str(rounding):
            raise ValueError('missing exact USD satisfaction/rounding evidence')
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise EconomicRefusal('invalid_payment_fx_evidence') from exc
    if payment.amount_nusd > account.balance_nusd:
        raise EconomicRefusal('payment_obligation_under_review')
    # durable=True refuses an enclosing application transaction (including
    # AtomicMiddleware): the signing claim has committed before return.
    # Reserve the only signing attempt durably BEFORE signing or network I/O.
    # A crash leaves signing, requiring reconciliation, never an automatic resend.
    payment.settlement = dict(settlement, signing_admitted_at=_db_now().isoformat())
    payment.state = 'signing'
    payment.updated_at = timezone.now()
    payment.save(update_fields=['settlement', 'state', 'updated_at'])
    return payment


@transaction.atomic
def record_payment_broadcast(*, payment_id, txid=None, observation):
    account, payment = _payment(payment_id)
    _evidence(observation, 'operator', 'broadcast_reference')
    if txid is not None and (len(txid) != 64 or any(c not in '0123456789abcdef' for c in txid)):
        raise EconomicRefusal('invalid_payment_txid')
    if payment.state not in {'signing', 'broadcast_unknown'}:
        if payment.state == 'broadcast' and payment.txid == txid:
            return payment
        raise EconomicRefusal('payment_broadcast_transition_refused')
    if payment.txid is not None and payment.txid != txid:
        raise EconomicRefusal('replacement_payment_forbidden')
    payment.state = 'broadcast' if txid else 'broadcast_unknown'
    payment.txid = txid
    observations = list(payment.settlement.get('broadcast_observations', []))
    observations.append(dict(observation, txid=txid))
    payment.settlement = dict(payment.settlement, broadcast_observations=observations)
    payment.updated_at = timezone.now()
    payment.save(update_fields=['state', 'txid', 'settlement', 'updated_at'])
    return payment


@transaction.atomic
def confirm_payment(*, payment_id, evidence):
    account, payment = _payment(payment_id)
    _evidence(evidence, 'operator', 'chain_reference', 'confirmed_txid')
    if payment.state == 'confirmed':
        if evidence['confirmed_txid'] != payment.txid:
            raise IdempotencyConflict('different confirmation txid')
        return payment
    if payment.state != 'broadcast' or payment.txid != evidence['confirmed_txid']:
        raise EconomicRefusal('unconfirmed_or_unknown_payment')
    PayableJournal.objects.create(account=account, payment=payment, idempotency_key=f'payment:{payment.pk}',
        kind='payment', delta_nusd=-payment.amount_nusd,
        basis={'payment_id': str(payment.pk), 'txid': payment.txid, 'confirmation': evidence,
               'settlement': payment.settlement, 'legal_payee_id': str(payment.legal_payee_id)})
    CreatorPayable.objects.filter(pk=account.pk).update(held_nusd=F('held_nusd') - payment.amount_nusd)
    payment.state = 'confirmed'
    payment.updated_at = timezone.now()
    payment.save(update_fields=['state', 'updated_at'])
    return payment


@transaction.atomic
def reject_payment(*, payment_id, operator, reason):
    account, payment = _payment(payment_id)
    if not operator.strip() or not reason.strip() or payment.state not in {'requested', 'approved'}:
        raise EconomicRefusal('payment_cannot_be_released_after_signing')
    account.held_nusd -= payment.amount_nusd
    account.save(update_fields=['held_nusd'])
    payment.state = 'rejected'
    payment.review = dict(payment.review, rejection={'operator': operator, 'reason': reason})
    payment.updated_at = timezone.now()
    payment.save(update_fields=['state', 'review', 'updated_at'])
    return payment


@transaction.atomic
def snapshot_legacy_claim(*, creator_id, snapshot_key, evidence):
    """Preserve observed old state; it is NOT a finding that tuzis are USD debt."""
    _evidence(evidence, 'operator', 'snapshot_reference')
    creator = usage.lock_creator(creator_id)
    account = usage.lock_account(creator.id, creator.balance)
    claim, _ = LegacyClaim.objects.get_or_create(creator_id=creator_id, snapshot_key=snapshot_key,
        defaults={'snapshot_at': timezone.now(), 'usage_snapshot_m2z': account.balance, 'evidence': evidence})
    return claim


@transaction.atomic
def adjudicate_legacy_claim(*, claim_id, classification, liability_nusd, basis, operator):
    """Append legal/finance disposition, preserving original snapshot evidence."""
    _evidence(basis, 'legal_basis', 'source_reference', 'decision_reference')
    if liability_nusd is not None:
        _integer(liability_nusd)
        if liability_nusd < 0:
            raise EconomicRefusal('negative_legacy_liability')
    if not classification.strip() or not operator.strip():
        raise EconomicRefusal('legacy_decision_requires_classification_and_operator')
    claim = LegacyClaim.objects.select_for_update().get(pk=claim_id)
    return LegacyClaimDecision.objects.create(claim=claim, classification=classification,
        liability_nusd=liability_nusd, basis=basis, operator=operator)


def activation_readiness(manifest=None):
    """Actual local denominators plus reviewed external cutover attestations."""
    from dj.apps.ledger.models import Config, LedgerHold, LedgerAiSplitQueue, LedgerDevMarkupPending
    from dj.apps.tuzis.models import ProviderReservation
    config = Config.objects.first()
    from dj.apps.ledger.models import Account
    policy = EconomicPolicy.objects.first()
    discrepancy_counts = _usage_discrepancy_counts()
    from .epoch import product_integration_available
    installed=product_integration_available()
    blockers=['writer_and_product_integration_not_installed']
    if installed:
        with connection.cursor() as cursor:
            cursor.execute('SELECT economy.activation_blockers(%s::jsonb)',[json.dumps(manifest or (policy.manifest if policy else {}))])
            blockers=cursor.fetchone()[0]
    return {
        'ready': installed and not blockers,
        'blockers': blockers,
        'writer_boundary': bool(config and config.writer_boundary),
        'healing_disabled': bool(config and not config.heal_enabled),
        'active_holds': LedgerHold.objects.count(),
        'legacy_reservations': ProviderReservation.objects.filter(status=ProviderReservation.ACTIVE).count(),
        'sdk_split_queue_rows': LedgerAiSplitQueue.objects.count(),
        'sdk_pending_developers': LedgerDevMarkupPending.objects.count(),
        'sdk_pending_m2z': LedgerDevMarkupPending.objects.aggregate(n=Sum('amount_m2z'))['n'] or 0,
        'usage_projection_discrepancies': discrepancy_counts['accounts_with_discrepancy'],
        'usage_projection_discrepancy_counts': discrepancy_counts,
        'over_limit_usage_accounts': Account.objects.filter(kind='user', balance__gt=policy.account_daily_limit_m2z if policy else 200_000_000).count(),
    }


def _usage_discrepancy_counts():
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FILTER (WHERE a.id IS NULL AND c.tuzis=0), "
            "count(*) FILTER (WHERE a.id IS NULL AND c.tuzis<>0), "
            "count(*) FILTER (WHERE a.id IS NOT NULL AND a.balance<>c.tuzis*1000), "
            "count(*) FILTER (WHERE a.id IS NOT NULL AND a.balance<a.held), "
            "count(*) FILTER (WHERE a.id IS NULL OR a.balance<>c.tuzis*1000 OR a.balance<a.held) "
            "FROM g12f_creator c LEFT JOIN ledger_account a ON a.owner_id=c.id AND a.kind='user'")
        missing_zero, missing_nonzero, mismatch, below_holds, total = cursor.fetchone()
    return {'missing_zero_accounts': missing_zero, 'missing_nonzero_accounts': missing_nonzero,
            'projection_mismatches': mismatch, 'balances_below_holds': below_holds,
            'accounts_with_discrepancy': total}


def _known_purchaser_ids(purchaser_id):
    """Aggregate actual verified linkage; account IDs alone are not people."""
    account = CreatorPayable.objects.select_related('legal_payee').filter(creator_id=purchaser_id).first()
    reference = account.legal_payee.verification.get('legal_person_reference') if account and account.legal_payee_id else None
    if not isinstance(reference, str) or not reference.strip():
        return {purchaser_id}
    return {purchaser_id, *CreatorPayable.objects.filter(
        legal_payee__verification__legal_person_reference=reference
    ).values_list('creator_id', flat=True)}


def _purchaser_exposure(purchaser_id, day, exclude_reservation=None):
    identities = _known_purchaser_ids(purchaser_id)
    sold = PurchaserDay.objects.filter(purchaser_id__in=identities, day=day).aggregate(n=Sum('sold_nusd'))['n'] or 0
    reservations = FundingReservation.objects.filter(purchaser_id__in=identities, state='reserved')
    if exclude_reservation is not None:
        reservations = reservations.exclude(pk=exclude_reservation)
    pending = reservations.aggregate(n=Sum('sale_nusd'))['n'] or 0
    return sold + pending


def funding_capacity_preview(creator_id):
    """Read current funding headroom without admitting or reserving a purchase.

    Processing-time prices and concurrent activity can change these numbers.
    The actual writer rechecks the same limits under financial locks.
    """
    from dj.apps.g12f.models import Creator
    from dj.apps.ledger.models import Account
    policy=EconomicPolicy.objects.get(pk=True)
    if policy.version!=1:
        return None
    now=_db_now()
    day=now.astimezone(datetime_timezone.utc).date()
    actor=Creator.objects.get(pk=creator_id)
    account=Account.objects.filter(kind='user',owner_id=creator_id).first()
    funded=FundingDay.objects.filter(account_id=account.pk,day=day).first() if account else None
    opening=funded.opening_m2z if funded else max(account.balance if account else int(actor.tuzis*1000),0)
    incoming=funded.incoming_m2z if funded else 0
    pending=(FundingReservation.objects.filter(account_id=account.pk,state='reserved').aggregate(n=Sum('amount_m2z'))['n'] or 0) if account else 0
    usage_remaining=max(policy.account_daily_limit_m2z-opening-incoming-pending,0)
    sale_remaining=max(policy.purchaser_daily_limit_nusd-_purchaser_exposure(creator_id,day),0)
    if policy.fenced or not actor.is_active or account and account.frozen:
        usage_remaining=sale_remaining=0
    return {'as_of':now,'remaining_m2z':str(usage_remaining),'remaining_sale_nusd':str(sale_remaining)}


def _funding_locks(recipient_id, purchaser_id):
    creators = {}
    for creator_id in sorted({recipient_id, *_known_purchaser_ids(purchaser_id)}):
        creator = usage.lock_creator(creator_id)
        if creator is None or (creator_id in {recipient_id, purchaser_id} and not creator.is_active):
            raise EconomicRefusal('inactive_funding_actor')
        creators[creator_id] = creator
    recipient = creators[recipient_id]
    account = usage.lock_account(recipient_id, recipient.balance)
    return account


def _db_now():
    with connection.cursor() as cursor:
        cursor.execute('SELECT clock_timestamp()')
        return cursor.fetchone()[0]


def _today():
    return _db_now().astimezone(datetime_timezone.utc).date()


def _funding_day(account, day):
    record, _ = FundingDay.objects.get_or_create(account_id=account.id, day=day,
        defaults={'opening_m2z': max(account.balance, 0)})
    return FundingDay.objects.select_for_update().get(pk=record.pk)


def _purchaser_day(purchaser_id, day):
    record, _ = PurchaserDay.objects.get_or_create(purchaser_id=purchaser_id, day=day)
    return PurchaserDay.objects.select_for_update().get(pk=record.pk)


@transaction.atomic
def reserve_funding(*, recipient_id, purchaser_id, amount_m2z, sale_nusd, idempotency_key):
    """Reserve BEFORE checkout/capture, including purchases sent as gifts.

    sale_nusd records conservative gross purchaser exposure, including card
    fees. Credited usage and prices are unchanged. Active reservations carry
    across UTC midnight.
    """
    _integer(amount_m2z, positive=True)
    _integer(sale_nusd)
    if sale_nusd < 0:
        raise ValueError('negative sale amount')
    pin_policy()
    account = _funding_locks(recipient_id, purchaser_id)
    existing = FundingReservation.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        if (existing.account_id, existing.purchaser_id, existing.amount_m2z, existing.sale_nusd) != (account.id, purchaser_id, amount_m2z, sale_nusd):
            raise IdempotencyConflict('funding reservation changed on replay')
        return existing
    day = _today()
    funded = _funding_day(account, day)
    sales = _purchaser_day(purchaser_id, day)
    policy = EconomicPolicy.objects.get()
    pending = FundingReservation.objects.filter(account_id=account.id, state='reserved').aggregate(n=Sum('amount_m2z'))['n'] or 0
    if funded.opening_m2z + funded.incoming_m2z + pending + amount_m2z > policy.account_daily_limit_m2z:
        raise EconomicRefusal('usage_daily_funding_limit')
    if _purchaser_exposure(purchaser_id, day) + sale_nusd > policy.purchaser_daily_limit_nusd:
        raise EconomicRefusal('purchaser_daily_sales_limit')
    reservation = FundingReservation.objects.create(recipient_id=recipient_id, account_id=account.id, purchaser_id=purchaser_id,
        amount_m2z=amount_m2z, sale_nusd=sale_nusd, day=day, idempotency_key=idempotency_key)
    funded.reserved_m2z += amount_m2z
    funded.save(update_fields=['reserved_m2z'])
    sales.reserved_nusd += sale_nusd
    sales.save(update_fields=['reserved_nusd'])
    return reservation


@transaction.atomic
def validate_reserved_funding_for_capture(*, reservation_id):
    """Revalidate immediately BEFORE processor capture, especially UTC rollover.

    Do not hold the DB transaction over provider I/O. Existing reservations
    serialize all competing authorizations and protect their capacity.
    """
    pin_policy()
    hint = FundingReservation.objects.get(pk=reservation_id)
    account = _funding_locks(hint.recipient_id, hint.purchaser_id)
    reservation = FundingReservation.objects.select_for_update().get(pk=reservation_id)
    if reservation.state != 'reserved' or reservation.external_receipt:
        raise EconomicRefusal('funding_not_available_for_capture')
    day = _today()
    funded = _funding_day(account, day)
    _purchaser_day(reservation.purchaser_id, day)
    policy = EconomicPolicy.objects.get()
    pending = FundingReservation.objects.filter(account_id=account.id, state='reserved').aggregate(n=Sum('amount_m2z'))['n'] or 0
    if funded.opening_m2z + funded.incoming_m2z + pending > policy.account_daily_limit_m2z:
        raise EconomicRefusal('usage_daily_funding_limit')
    if _purchaser_exposure(reservation.purchaser_id, day) > policy.purchaser_daily_limit_nusd:
        raise EconomicRefusal('purchaser_daily_sales_limit')
    return reservation


@transaction.atomic
def release_funding(*, reservation_id, reason):
    """Release unconsumed authorization, never a completed external sale."""
    if not reason.strip():
        raise EconomicRefusal('funding_release_reason_required')
    pin_policy()
    hint = FundingReservation.objects.get(pk=reservation_id)
    # A proved unconsumed authorization can be released after an actor is
    # deactivated; inactivity must not strand purchaser capacity forever.
    actors = {actor_id: _receipt_creator(actor_id)
        for actor_id in sorted({hint.recipient_id, hint.purchaser_id})}
    usage.lock_account(hint.recipient_id, actors[hint.recipient_id].tuzis)
    reservation = FundingReservation.objects.select_for_update().get(pk=reservation_id)
    if reservation.state == 'released':
        return reservation
    if reservation.state != 'reserved' or reservation.external_receipt:
        raise EconomicRefusal('captured_funding_requires_resolution')
    FundingDay.objects.filter(account_id=reservation.account_id, day=reservation.day).update(reserved_m2z=F('reserved_m2z') - reservation.amount_m2z)
    PurchaserDay.objects.filter(purchaser_id=reservation.purchaser_id, day=reservation.day).update(reserved_nusd=F('reserved_nusd') - reservation.sale_nusd)
    reservation.state = 'released'
    reservation.external_receipt = {'release_reason': reason}
    reservation.save(update_fields=['state', 'external_receipt'])
    return reservation


@transaction.atomic
def issue_reserved_funding(*, reservation_id, rail, receipt):
    """Persist captured receipt, then issue atomically in a savepoint.

    A late/over-limit/fenced/inactive receipt survives as `resolution`;
    callers route it to refund/support. NEVER report fulfilled success, or
    raise a DRF exception inside AtomicMiddleware after recording resolution: an
    enclosing rollback would discard this evidence. Use a committed receipt
    handler or an explicit non-error pending-resolution response.
    """
    from django.db import DatabaseError
    _evidence(receipt, 'provider_reference', 'captured_at')
    policy_available = True
    try:
        with transaction.atomic():
            pin_policy()
    except DatabaseError as exc:
        from .epoch import is_explicit_policy_refusal
        if not is_explicit_policy_refusal(exc):
            raise
        policy_available = False
    except EconomicRefusal:
        policy_available = False
    if rail=='zec':
        from dj.apps.tuzis.zec import _take_instant_credit_lock,unresolved_unbacked_credits
        _take_instant_credit_lock()
        policy_available=policy_available and not unresolved_unbacked_credits().exists()
    hint = FundingReservation.objects.get(pk=reservation_id)
    actors = {}
    for creator_id in sorted({hint.recipient_id, *_known_purchaser_ids(hint.purchaser_id)}):
        actors[creator_id] = _receipt_creator(creator_id)
    policy_available = policy_available and all(actors[actor_id] is not None and actors[actor_id].is_active
        for actor_id in {hint.recipient_id, hint.purchaser_id})
    from dj.apps.ledger.models import Account
    account = Account.objects.select_for_update().get(pk=hint.account_id)
    reservation = FundingReservation.objects.select_for_update().get(pk=reservation_id)
    was_released = reservation.state == 'released'
    existing_receipt = {key:value for key,value in reservation.external_receipt.items() if key!='prior_release'}
    if not was_released and existing_receipt and existing_receipt != receipt:
        raise IdempotencyConflict('different captured receipt')
    if reservation.state in {'issued', 'resolution'}:
        return reservation
    if reservation.state not in {'reserved','released'}:
        raise EconomicRefusal('funding_not_reserved')
    reservation.external_receipt = dict(receipt, prior_release=reservation.external_receipt) if was_released else receipt
    reservation.save(update_fields=['external_receipt'])
    old_funded = FundingDay.objects.select_for_update().get(account_id=account.id, day=reservation.day)
    old_sales = _purchaser_day(reservation.purchaser_id, reservation.day)
    if not was_released:
        old_funded.reserved_m2z -= reservation.amount_m2z
        old_funded.save(update_fields=['reserved_m2z'])
        old_sales.reserved_nusd -= reservation.sale_nusd
        old_sales.save(update_fields=['reserved_nusd'])
    day = _today()
    sales = _purchaser_day(reservation.purchaser_id, day)
    # Count an actual captured sale even if fulfillment needs a refund; it
    # cannot be erased by spending, a failed credit, or a chargeback.
    sales.sold_nusd += reservation.sale_nusd
    sales.save(update_fields=['sold_nusd'])
    limit = EconomicPolicy.objects.get().purchaser_daily_limit_nusd
    if was_released or not policy_available or _purchaser_exposure(
        reservation.purchaser_id, day, exclude_reservation=reservation.pk) > limit:
        reservation.state = 'resolution'
    else:
        reservation.state = 'issuing'
        reservation.save(update_fields=['state'])
        try:
            with transaction.atomic():
                result = usage.credit_purchase(account_owner_id(account.id), reservation.amount_m2z,
                    rail, 'funding_reservation', str(reservation.pk), f'funding:{reservation.pk}')
                if result.status not in {'posted', 'replayed'}:
                    raise EconomicRefusal('funding_issuance_refused')
            reservation.state = 'issued'
        except DatabaseError as exc:
            from .epoch import is_explicit_policy_refusal
            cause = getattr(exc, '__cause__', None)
            daily_cap = getattr(cause, 'sqlstate', None) == '23514' and getattr(
                getattr(cause, 'diag', None), 'message_primary', None) == 'usage_daily_funding_limit'
            if not daily_cap and not is_explicit_policy_refusal(exc):
                raise
            reservation.state = 'resolution'
        except EconomicRefusal:
            # The savepoint removes partial issuance. The external receipt
            # and conservative daily sale count remain durable for resolution.
            reservation.state = 'resolution'
    reservation.save(update_fields=['state'])
    return reservation


def account_owner_id(account_id):
    from dj.apps.ledger.models import Account
    return Account.objects.get(pk=account_id).owner_id


@transaction.atomic
def record_unreserved_funding_receipt(*, recipient_id, purchaser_id, amount_m2z, sale_nusd, idempotency_key, receipt):
    """Durably queue unavoidable/unreserved external funds; issue NO credits.

    Examples: a Zcash transfer not authorized in advance, expired checkout,
    historical callback. A later operator refunds or separately reauthorizes;
    this record is neither a payable nor a hidden over-limit usage balance.
    """
    _integer(amount_m2z, positive=True)
    _integer(sale_nusd)
    if sale_nusd < 0:
        raise ValueError('negative sale amount')
    _evidence(receipt, 'provider_reference', 'captured_at', 'resolution_reason')
    # Recording money already received is allowed during a writer fence. It
    # creates no entitlement and cannot bypass a cap or erase a refund claim.
    from dj.apps.ledger.models import Account
    for creator_id in sorted({recipient_id, purchaser_id}):
        if _receipt_creator(creator_id) is None:
            raise EconomicRefusal('unknown_receipt_actor')
    account_id = Account.objects.filter(owner_id=recipient_id, kind='user').values_list('id', flat=True).first()
    record, created = FundingReservation.objects.get_or_create(idempotency_key=idempotency_key,
        defaults={'recipient_id': recipient_id, 'account_id': account_id, 'purchaser_id': purchaser_id, 'day': _today(),
                  'amount_m2z': amount_m2z, 'sale_nusd': sale_nusd,
                  'state': 'resolution', 'external_receipt': receipt})
    if not created and (record.recipient_id, record.purchaser_id, record.amount_m2z, record.sale_nusd, record.external_receipt) != (recipient_id, purchaser_id, amount_m2z, sale_nusd, receipt):
        raise IdempotencyConflict('unreserved receipt changed on replay')
    if created:
        sales = _purchaser_day(purchaser_id, _today())
        sales.sold_nusd += sale_nusd
        sales.save(update_fields=['sold_nusd'])
    return record


def _receipt_creator(creator_id):
    """Lock an observation subject without granting usage or bypassing a cap."""
    from dj.apps.g12f.models import Creator
    return Creator.objects.select_for_update(no_key=True).filter(pk=creator_id).first()
