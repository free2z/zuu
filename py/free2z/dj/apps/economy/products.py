"""Internal product adapters. HTTP authorization/serialization live elsewhere.

Prepared purchases deliberately require a later dedicated SQL setoff ABI.
There is no generic conversion of usage balances into contractual USD debt.
"""
from datetime import timedelta
from decimal import Decimal

from django.core import signing
from django.db import connection, transaction
from django.utils import timezone

from dj.apps.ledger import api as usage

from . import services as money
from .models import CompensationAgreement, CompensationSchedule, CreatorPayable, PayableJournal

USAGE_QUANTUM_NUSD = 10_000
QUOTE_TTL_SECONDS = 300
QUOTE_SALT = 'economy.usage-retail-v1'


def usd_string(nusd):
    return format(Decimal(nusd) / 1_000_000_000, '.9f')


def get_effective_compensation_schedule(service, at=None):
    from .contracts import SERVICE_SCHEDULES
    # Historical resources exist for actual old obligations, not new work.
    # Membership and ordinary sharing stay closed-loop utility transfers.
    if service not in {'livestream_ppv', 'sdk_application'}:
        raise money.EconomicRefusal('compensation_schedule_unavailable')
    resource = SERVICE_SCHEDULES.get(service)
    if resource is None:
        raise money.EconomicRefusal('compensation_schedule_unavailable')
    at = at or money._db_now()
    candidates = CompensationSchedule.objects.filter(service=service, effective_at__lte=at)
    from django.db.models import Q
    candidates = candidates.filter(Q(ends_at__isnull=True) | Q(ends_at__gt=at))
    for schedule in candidates.order_by('-effective_at', '-pk'):
        if (schedule.version, schedule.published_digest, schedule.nusd_per_allocated_m2z, schedule.contract_version) == (
            resource['version'], resource['digest'], resource['rate_nusd_per_allocated_m2z'], resource['contract_version']
        ):
            return schedule
    raise money.EconomicRefusal('compensation_schedule_unavailable')


@transaction.atomic
def admit_product_service(*, creator_id, subject_creator_id, service, event_id, source):
    """Capture actual offered contribution and preapproved supplier identity."""
    from .contracts import CREATOR_CONTRACT_DIGEST, CREATOR_CONTRACT_VERSION
    money.pin_policy()
    eligibility_at = money._db_now()
    money._evidence(source, 'source_kind', 'source_id', 'authorization_reference', 'delivery_scope_reference')
    if creator_id == subject_creator_id:
        raise money.EconomicRefusal('compensated_self_service_unsupported')
    account = CreatorPayable.objects.filter(creator_id=creator_id).first()
    if account is None or account.legal_payee_id is None:
        raise money.EconomicRefusal('compensation_onboarding_required')
    supplier = account.legal_payee
    buyer = CreatorPayable.objects.select_related('legal_payee').filter(creator_id=subject_creator_id).first()
    supplier_person = supplier.verification.get('legal_person_reference')
    buyer_person = buyer.legal_payee.verification.get('legal_person_reference') if buyer and buyer.legal_payee_id else None
    if buyer and (buyer.legal_payee_id == account.legal_payee_id or
        (supplier_person and buyer_person and supplier_person == buyer_person)):
        raise money.EconomicRefusal('compensated_self_service_unsupported')
    agreement = CompensationAgreement.objects.filter(creator_id=creator_id, legal_payee_id=account.legal_payee_id,
        contract_version=CREATOR_CONTRACT_VERSION, contract_digest=CREATOR_CONTRACT_DIGEST,
        revoked_at__isnull=True, effective_at__lte=eligibility_at).order_by('-effective_at', '-pk').first()
    if agreement is None:
        raise money.EconomicRefusal('compensation_onboarding_required')
    schedule = get_effective_compensation_schedule(service, at=eligibility_at)
    accepted_schedules = agreement.acceptance_evidence.get('schedules', [])
    if {'service': schedule.service, 'version': schedule.version, 'digest': schedule.published_digest} not in accepted_schedules:
        raise money.EconomicRefusal('compensation_schedule_acceptance_required')
    return money.admit_service(creator_id=creator_id, service=service, event_id=event_id,
        agreement_id=agreement.pk, schedule_id=schedule.pk,
        source=dict(source, subject_creator_id=subject_creator_id))


def _retail():
    from .contracts import USAGE_RETAIL_DIGEST, USAGE_RETAIL_VERSION
    return USAGE_RETAIL_VERSION, USAGE_RETAIL_DIGEST


def _purchase_amount(amount_nusd):
    money._integer(amount_nusd, positive=True)
    if amount_nusd % USAGE_QUANTUM_NUSD:
        raise money.EconomicRefusal('usage_purchase_precision')
    return amount_nusd // USAGE_QUANTUM_NUSD


def quote_usage_purchase(*, creator_id, amount_nusd):
    """Read-only actor-bound preview; live split is rechecked under POST locks."""
    total = _purchase_amount(amount_nusd)
    from .models import EconomicPolicy
    policy = EconomicPolicy.objects.get()
    if policy.version != 1 or policy.fenced:
        raise money.EconomicRefusal('economic_policy_disabled')
    account = CreatorPayable.objects.filter(creator_id=creator_id).first()
    if account is None or amount_nusd > account.balance_nusd - account.held_nusd:
        raise money.EconomicRefusal('insufficient_available_earnings')
    balance = usage.read_balance(creator_id)
    if balance is None:
        raise money.EconomicRefusal('creator_not_found')
    version, digest = _retail()
    debt = min(balance.debt, total)
    payload = {'creator_id': creator_id, 'amount_nusd': amount_nusd, 'total_m2z': total,
        'debt_m2z': debt, 'credited_m2z': total - debt, 'policy_version': 1,
        'quote_version': version, 'quote_digest': digest}
    return {'currency': 'USD', 'amount': usd_string(amount_nusd), 'quote_version': version,
        'quote_digest': digest, 'usd_per_tuzi': '0.010000000',
        'usage_total_m2z': str(total), 'usage_debt_repaid_m2z': str(debt),
        'usage_credited_m2z': str(total - debt),
        'expires_at': (timezone.now() + timedelta(seconds=QUOTE_TTL_SECONDS)).isoformat(),
        'quote_token': signing.dumps(payload, salt=QUOTE_SALT, compress=True)}


@transaction.atomic
def purchase_usage_from_payable(*, creator_id, amount_nusd, idempotency_key, quote_token,
    actor_authentication, acknowledged=True, expected_version=1):
    """Replay original receipt before quote expiry; no rounding of USD debt.

    The exclusive SQL integration must atomically bind the USD journal, actual
    funding reservation, retail ledger credit/debt split and original receipt.
    Until that reviewed ABI exists this function refuses before any debit.
    """
    _purchase_amount(amount_nusd)
    if acknowledged is not True or not isinstance(idempotency_key, str) or not idempotency_key or len(idempotency_key) > 200:
        raise money.EconomicRefusal('usage_purchase_authorization_required')
    money._evidence(actor_authentication, 'authentication_reference')
    identity = {'creator_id': creator_id, 'amount_nusd': amount_nusd, 'quote_token': quote_token, 'acknowledged': True}
    fingerprint = money._digest(identity)
    key = f'usage-purchase:{creator_id}:{idempotency_key}'
    replay = lookup_usage_purchase_receipt(creator_id=creator_id, amount_nusd=amount_nusd,
        idempotency_key=idempotency_key, quote_token=quote_token, acknowledged=acknowledged)
    if replay is not None:
        return replay
    try:
        quote = signing.loads(quote_token, salt=QUOTE_SALT, max_age=QUOTE_TTL_SECONDS)
    except signing.SignatureExpired as exc:
        raise money.EconomicRefusal('usage_purchase_quote_expired') from exc
    except (signing.BadSignature, TypeError, ValueError) as exc:
        raise money.EconomicRefusal('usage_purchase_quote_invalid') from exc
    version, digest = _retail()
    if quote.get('creator_id') != creator_id or quote.get('amount_nusd') != amount_nusd:
        raise money.EconomicRefusal('usage_purchase_quote_invalid')
    if (quote.get('policy_version'), quote.get('quote_version'), quote.get('quote_digest')) != (expected_version, version, digest):
        raise money.EconomicRefusal('usage_purchase_quote_changed')
    money.pin_policy(expected_version)
    creator = usage.lock_creator(creator_id)
    if creator is None or not creator.is_active:
        raise money.EconomicRefusal('inactive_funding_actor')
    from dj.apps.g12f.models import Creator
    epoch = Creator.objects.values_list('kt_account_epoch', flat=True).get(pk=creator_id)
    if type(actor_authentication.get('account_epoch')) is not int or actor_authentication['account_epoch'] != epoch:
        raise money.EconomicRefusal('actor_authentication_changed')
    usage.lock_account(creator.id, creator.balance)
    account = CreatorPayable.objects.select_for_update().get(creator_id=creator_id)
    # Recheck replay after the financial serialization lock.
    existing = PayableJournal.objects.filter(idempotency_key=key).first()
    if existing:
        if existing.basis.get('request_digest') != fingerprint:
            raise money.IdempotencyConflict('usage_purchase_identity_changed')
        return dict(existing.basis['receipt'], replayed=True)
    if amount_nusd > account.balance_nusd - account.held_nusd:
        raise money.EconomicRefusal('insufficient_available_earnings')
    if min(usage.debt_m2z(creator_id), quote['total_m2z']) != quote['debt_m2z']:
        raise money.EconomicRefusal('usage_purchase_quote_changed')
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regprocedure('ledger.purchase_from_payable(bigint,bigint,text,jsonb)')")
        if cursor.fetchone()[0] is None:
            raise money.EconomicRefusal('usage_purchase_integration_unavailable')
        import json
        cursor.execute('SELECT ledger.purchase_from_payable(%s,%s,%s,%s::jsonb)',
            [creator_id, amount_nusd, key, json.dumps({'request_digest': fingerprint,
                'authorization': identity, 'actor_authentication': actor_authentication, 'quote': quote})])
        return cursor.fetchone()[0]


def lookup_usage_purchase_receipt(*, creator_id, amount_nusd, idempotency_key, quote_token, acknowledged=True):
    """Original durable receipt for the same authenticated actor/request.

    A new session for that actor can replay without reauthorizing a changed
    quote or paying twice; current ownership authentication remains upstream.
    """
    _purchase_amount(amount_nusd)
    if acknowledged is not True or not isinstance(idempotency_key, str) or not idempotency_key or len(idempotency_key) > 200:
        raise money.EconomicRefusal('usage_purchase_authorization_required')
    fingerprint = money._digest({'creator_id': creator_id, 'amount_nusd': amount_nusd,
        'quote_token': quote_token, 'acknowledged': True})
    entry = PayableJournal.objects.select_related('account').filter(
        idempotency_key=f'usage-purchase:{creator_id}:{idempotency_key}').first()
    if entry is None:
        return None
    if entry.kind != 'usage_purchase' or entry.account.creator_id != creator_id or entry.basis.get('request_digest') != fingerprint:
        raise money.IdempotencyConflict('usage_purchase_identity_changed')
    return dict(entry.basis['receipt'], replayed=True)


@transaction.atomic
def prepare_livestream_admission(*, host_id, viewer_id, meeting_id, price_per_minute, viewer_account_epoch=None):
    """Capture the supplier before a viewer receives a provider join token.

    Repeated provider delivery requires the reviewed child-receipt ABI. Its
    absence refuses paid admission before delivery or a customer charge.
    """
    import uuid
    money.pin_policy()
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regprocedure('economy.settle_service_delivery(uuid,text,bigint,jsonb)')")
        if cursor.fetchone()[0] is None:
            raise money.EconomicRefusal('livestream_compensation_integration_unavailable')
    price = Decimal(str(price_per_minute))
    if not price.is_finite() or price <= 0 or price != price.quantize(Decimal('.01')):
        raise money.EconomicRefusal('livestream_price_invalid')
    from dj.apps.g12f.models import Creator
    from dj.apps.dyte.models import CreatorMeeting, PAY_PER_VIEW, LIFECYCLE_LIVE
    # Read the actual offer under locks before accepting a supplied price or
    # issuing a join token. A reusable room cannot redirect the admission to
    # a later host, provider session, or changed price.
    actors = list(Creator.objects.select_for_update().filter(
        pk__in=sorted({host_id, viewer_id})).order_by('pk'))
    if len(actors) != 2 or any(not actor.is_active for actor in actors):
        raise money.EconomicRefusal('livestream_actor_unavailable')
    viewer = next(actor for actor in actors if actor.pk == viewer_id)
    if viewer_account_epoch is None or viewer.kt_account_epoch != viewer_account_epoch:
        raise money.EconomicRefusal('actor_authentication_changed')
    meeting = CreatorMeeting.objects.select_for_update(of=('self',)).filter(
        meeting_id=meeting_id, creator_id=host_id, meeting_type=PAY_PER_VIEW,
        is_public=True, live_now=True, lifecycle_state=LIFECYCLE_LIVE).first()
    if meeting is None or meeting.provider_session_id is None or meeting.host_session_id is None:
        raise money.EconomicRefusal('livestream_offer_unavailable')
    if meeting.price_per_minute != price:
        raise money.EconomicRefusal('livestream_price_changed')
    return admit_product_service(creator_id=host_id, subject_creator_id=viewer_id,
        service='livestream_ppv', event_id=str(uuid.uuid4()), source={
            'source_kind': 'licensed_livestream', 'source_id': str(meeting_id),
            'authorization_reference': f'authenticated-viewer:{viewer_id}',
            'delivery_scope_reference': f'live-room:{meeting_id}',
            'meeting_id': str(meeting_id), 'host_creator_id': host_id,
            'creator_meeting_id': meeting.pk,
            'provider_session_id': str(meeting.provider_session_id),
            'host_session_id': str(meeting.host_session_id),
            'price_per_minute_2z': str(price), 'price_currency': 'restricted_usage_2Z',
            'allocation_method': 'whole-minute duration rounded up; platform fee collected first; creator allocation is the collected portion of ceil(price_per_minute_2z * whole_minutes)',
            'subject_creator_id': viewer_id})


@transaction.atomic
def settle_livestream_delivery(*, admission_id, event_key, evidence, expected_allocated_m2z=None):
    """Verified provider callback; original captured supplier owns the debt.

    SQL computes the exact collected allocation and validates its interval,
    original provider identity and webhook claim before any customer debit.
    """
    import json
    money.pin_policy()
    with connection.cursor() as cursor:
        cursor.execute('SELECT economy.settle_service_delivery(%s,%s,%s,%s::jsonb)',
            [admission_id,event_key,expected_allocated_m2z,json.dumps(evidence)])
        return PayableJournal.objects.select_related('delivery').get(pk=cursor.fetchone()[0])
