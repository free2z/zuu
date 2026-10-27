"""Account-verified capture/refund/dispute adapters, never browser authority.

Stripe event delivery is duplicated and unordered. Reconciliation reads the
current provider object, then serializes the original purchase cursor. Actual
external outcomes remain durable even when local fulfillment must be refused.
"""
from dataclasses import dataclass
from datetime import timedelta
import json
from pathlib import Path
import subprocess
import sys
import logging
import threading
import time

import stripe
from django.conf import settings
from django.db import DatabaseError, transaction
from django.utils import timezone

from dj.apps.economy import services as money
from dj.apps.economy.models import FundingReservation
from dj.apps.economy.epoch import is_explicit_policy_refusal
from dj.apps.ledger.models import PurchaseRefund, TransferKey
from dj.apps.tuzis.models import IdempotencyKey

from .models import CheckoutIntent, StripeTransaction
from .stripe_identity import STRIPE_API_VERSION, configured_stripe_identity
from .webhook_readiness import StripeWebhookReadinessError

FINANCIAL_EVENT_TYPES = frozenset({'refund.created', 'refund.updated', 'refund.failed', 'charge.refunded',
    'charge.dispute.created', 'charge.dispute.closed', 'charge.dispute.updated',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'})
CAPTURE_EVENT_TYPES = frozenset({'payment_intent.amount_capturable_updated', 'payment_intent.succeeded'})
CREATION_VALIDATION_CODES = frozenset({'parameter_unknown', 'parameter_missing', 'parameter_invalid_integer',
    'parameter_invalid_empty', 'parameter_invalid_string_blank'})
FINANCIAL_PROVIDER_RECORD_LIMIT = 10
FINANCIAL_PROVIDER_READ_LIMIT = 23
FINANCIAL_PROVIDER_READ_SECONDS = 24
FINANCIAL_PROVIDER_REQUEST_TIMEOUT_SECONDS = 1
FINANCIAL_PROVIDER_RESPONSE_BYTES = 1024 * 1024
FINANCIAL_PROVIDER_CLEANUP_SECONDS = 0.25
_PROVIDER_READ_WORKER = Path(__file__).with_name("provider_read_worker.py")
FINANCIAL_PROVIDER_READ_WORKERS = 4
_financial_provider_read_slots = threading.BoundedSemaphore(FINANCIAL_PROVIDER_READ_WORKERS)


def _financial_snapshot_started_at():
    """Capture ordering before any provider request for this snapshot."""
    return timezone.now().isoformat()


class ProviderReadUnavailable(Exception):
    """An incomplete provider read that must remain a no-mutation decision."""

    def __init__(self, reason='provider_read_unavailable', partial=None):
        self.reason = reason
        self.partial = partial or {}
        super().__init__(reason)


class FinancialProviderReadBudget:
    """Shared call-count and elapsed-time fence for one signed event."""

    def __init__(self, *, max_calls=FINANCIAL_PROVIDER_READ_LIMIT,
                 seconds=FINANCIAL_PROVIDER_READ_SECONDS, clock=time.monotonic):
        self.max_calls = max_calls
        self.deadline = clock() + seconds
        self.clock = clock
        self.calls = 0

    def read(self, request):
        remaining = self.deadline - self.clock()
        if self.calls >= self.max_calls or remaining <= FINANCIAL_PROVIDER_CLEANUP_SECONDS:
            raise ProviderReadUnavailable('provider_read_budget_exhausted')
        if not _financial_provider_read_slots.acquire(blocking=False):
            raise ProviderReadUnavailable('provider_read_unavailable')
        self.calls += 1
        child = None
        try:
            # Spawn a fresh interpreter: never fork a Django connection/thread.
            # Credentials travel only through stdin, never argv or a log.
            payload = json.dumps(request).encode('utf-8')
            if len(payload) > 65536:
                raise ProviderReadUnavailable('provider_read_request_too_large')
            child = subprocess.Popen([sys.executable, '-I', str(_PROVIDER_READ_WORKER)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            remaining = self.deadline - self.clock() - FINANCIAL_PROVIDER_CLEANUP_SECONDS
            if remaining <= 0:
                raise subprocess.TimeoutExpired('stripe-provider-read', 0)
            output, _ = child.communicate(payload, timeout=remaining)
            if child.returncode != 0 or len(output) > FINANCIAL_PROVIDER_RESPONSE_BYTES:
                raise ProviderReadUnavailable('provider_read_unavailable')
            result = json.loads(output)
            if not isinstance(result, dict) or result.get('status') != 'ok':
                raise ProviderReadUnavailable('provider_read_unavailable')
            if self.clock() >= self.deadline:
                raise ProviderReadUnavailable('provider_read_budget_exhausted')
            return result['value']
        except subprocess.TimeoutExpired as exc:
            raise ProviderReadUnavailable('provider_read_budget_exhausted') from exc
        except (OSError, ValueError, KeyError) as exc:
            raise ProviderReadUnavailable('provider_read_unavailable') from exc
        finally:
            try:
                if child is not None:
                    _cleanup_provider_read(child)
            finally:
                # An unreaped child may still be running. Quarantine its slot
                # until this application worker restarts, rather than spawning
                # unbounded replacements after repeated cleanup failures.
                if child is None or child.returncode is not None:
                    _financial_provider_read_slots.release()


def _cleanup_provider_read(child):
    """Bound owned-child cleanup; unknown liveness keeps admission closed."""
    failed = False
    try:
        if child.poll() is None:
            try:
                child.terminate()
            except ProcessLookupError:
                pass  # The child exited between poll and signal.
            try:
                child.wait(timeout=0.1)
            except subprocess.TimeoutExpired:
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
                child.wait(timeout=0.1)
    except (OSError, subprocess.SubprocessError):
        failed = True
    finally:
        for stream in (child.stdin, child.stdout):
            if stream is not None:
                try:
                    stream.close()
                except (OSError, ValueError):
                    failed = True
    if failed:
        logging.getLogger(__name__).error('stripe_provider_read_cleanup_failed',
            extra={'worker_pid': child.pid})
        raise ProviderReadUnavailable('provider_read_cleanup_failed')


class StripeFinancialProvider:
    """Bounded read-only SDK calls in individually owned worker processes."""

    def __init__(self, identity, *, budget=None):
        self.identity = identity
        self.budget = budget or FinancialProviderReadBudget()

    def _request(self, resource, operation, *args):
        return self.budget.read({'api_key': settings.STRIPE_SECRET_KEY,
            'api_version': STRIPE_API_VERSION, 'timeout': FINANCIAL_PROVIDER_REQUEST_TIMEOUT_SECONDS,
            'resource': resource, 'operation': operation, 'args': args})

    def event(self, event_id):
        return self._request('events', 'retrieve', event_id)

    def charge(self, charge_id):
        return self._request('charges', 'retrieve', charge_id)

    def refunds(self, charge_id):
        return self._request('refunds', 'list',
            {'charge': charge_id, 'limit': FINANCIAL_PROVIDER_RECORD_LIMIT + 1})

    def balance_transaction(self, movement_id):
        return self._request('balance_transactions', 'retrieve', movement_id)

    def disputes(self, charge_id):
        return self._request('disputes', 'list',
            {'charge': charge_id, 'limit': FINANCIAL_PROVIDER_RECORD_LIMIT + 1})

    def dispute(self, dispute_id):
        return self._request('disputes', 'retrieve', dispute_id,
            {'expand': ['balance_transactions']})


def release_preexecution_creation_refusal(checkout, error, *, ambiguous=False):
    """Only documented parameter validation proves a first creation did not run.

    A timeout, a prior attempt, or an unclassified provider error retains the
    original authorization for resolution. Never infer cancellation from 4xx.
    """
    if (ambiguous or not isinstance(error, stripe.error.InvalidRequestError) or
        error.http_status != 400 or error.code not in CREATION_VALIDATION_CODES or not error.param):
        return False
    reservation = FundingReservation.objects.filter(
        idempotency_key=f'stripe-intent:{checkout.public_id}').first()
    if reservation is None:
        return False
    proof = {'checkout_id': str(checkout.public_id), 'code': error.code,
        'parameter': error.param, 'provider_request_id': error.request_id,
        'observed_at': timezone.now().isoformat()}
    with transaction.atomic():
        record, _ = IdempotencyKey.objects.get_or_create(scope='stripe-create-refusal', user_id=checkout.user_id,
            key=str(checkout.public_id), defaults={'request_hash': money._digest(proof),
                'response_status': 200, 'response_body': {'observation': proof}})
    try:
        money.release_funding(reservation_id=reservation.pk,
            reason=f'stripe:{checkout.public_id}:preexecution_parameter_validation')
    except (DatabaseError, money.EconomicRefusal):
        # The attributable refusal remains available for bounded cleanup.
        return False
    record.response_body = dict(record.response_body, cleanup_status='released')
    record.save(update_fields=['response_body'])
    return True


def reconcile_creation_refusals(*, creator_id, checkout_id=None, limit=20):
    """Retry only attributable no-execution cleanup; preserve unknown calls."""
    records = IdempotencyKey.objects.filter(scope='stripe-create-refusal', user_id=creator_id,
        response_body__cleanup_status__isnull=True)
    if checkout_id is not None:
        records = records.filter(key=str(checkout_id))
    for record in records.order_by('-created_at')[:limit]:
        proof = record.response_body.get('observation', {})
        if (proof.get('checkout_id') != record.key or proof.get('code') not in CREATION_VALIDATION_CODES or
            not proof.get('parameter') or record.request_hash != money._digest(proof)):
            continue
        checkout = CheckoutIntent.objects.filter(public_id=record.key, user_id=creator_id,
            state=CheckoutIntent.State.PROVIDER_FAILED, stripe_checkout_session_id__isnull=True).first()
        if checkout is None:
            continue
        reservation = FundingReservation.objects.filter(
            idempotency_key=f'stripe-intent:{checkout.public_id}', recipient_id=creator_id,
            state__in=['reserved', 'released']).first()
        reason = f'stripe:{checkout.public_id}:preexecution_parameter_validation'
        if reservation is None or (reservation.state == 'released' and
            reservation.external_receipt != {'release_reason': reason}) or (
                reservation.state == 'reserved' and reservation.external_receipt):
            continue
        try:
            if reservation.state == 'reserved':
                money.release_funding(reservation_id=reservation.pk, reason=reason)
        except (DatabaseError, money.EconomicRefusal):
            # Retain evidence/capacity; another original retry can clean up.
            continue
        record.response_body = dict(record.response_body, cleanup_status='released')
        record.save(update_fields=['response_body'])


@dataclass(frozen=True)
class EventOutcome:
    status: str
    reason: str = ''
    resolution_id: str | None = None


def _plain(value):
    return value.to_dict() if isinstance(value, stripe.StripeObject) else value


def financial_provider_reader(identity, *, read_budget=None):
    return StripeFinancialProvider(identity, budget=read_budget)


def verified_financial_event(received, *, read_budget=None):
    """Require raw signature upstream and actual configured account retrieval."""
    received = _plain(received)
    identity = configured_stripe_identity()
    read_budget = read_budget or FinancialProviderReadBudget()
    provider = StripeFinancialProvider(identity, budget=read_budget)
    try:
        event = provider.event(received['id'])
    except ProviderReadUnavailable as exc:
        exc.identity = identity
        raise
    event = _plain(event)
    if (event['id'], event['type'], event['livemode'], event.get('account'), event['data']['object']['id']) != (
        received['id'], received['type'], identity.livemode, received.get('account'), received['data']['object']['id']
    ) or event.get('account') not in (None, identity.account_id):
        raise StripeWebhookReadinessError('financial event account or object mismatch')
    return event, identity


def record_financial_event_retrieval_failure(received, identity, failure):
    """Retain signed input as unverified evidence after a bounded retrieve fails.

    The signed envelope is useful for retry correlation, but none of its object,
    account, or livemode fields authorize a ledger decision without the
    canonical Event.retrieve response.
    """
    received = _plain(received)
    data = _plain(received.get('data'))
    obj = _plain(data.get('object')) if isinstance(data, dict) else None
    if not isinstance(obj, dict):
        raise StripeWebhookReadinessError('financial event object unavailable')
    charge_id = obj.get('id') if received.get('type') == 'charge.refunded' else obj.get('charge')
    if not isinstance(charge_id, str) or not charge_id.startswith('ch_'):
        raise StripeWebhookReadinessError('financial event charge identity unavailable')
    payment_id = obj.get('payment_intent')
    candidate_payment_id = payment_id if isinstance(payment_id, str) else charge_id
    if not isinstance(received.get('id'), str) or not isinstance(received.get('type'), str):
        raise StripeWebhookReadinessError('financial event identity unavailable')

    purchase = StripeTransaction.objects.filter(stripe_charge_id=candidate_payment_id).first()
    checkout = CheckoutIntent.objects.filter(stripe_payment_intent_id=candidate_payment_id).first()
    reservations = list(FundingReservation.objects.filter(
        external_receipt__provider_reference=candidate_payment_id).order_by('pk')[:2])
    if len(reservations) > 1:
        raise StripeWebhookReadinessError('financial event funding receipt is ambiguous')
    reservation = reservations[0] if reservations else None
    if purchase is None and checkout is None and reservation is None:
        return EventOutcome('retry', 'original_purchase_not_yet_available')
    owner_id = purchase.user_id if purchase else (checkout.user_id if checkout else reservation.recipient_id)
    signed_event = {'provider_event_id': received['id'], 'event_type': received['type'],
        'event_created': received.get('created'), 'signed_account_claim': received.get('account'),
        'signed_livemode_claim': received.get('livemode'), 'configured_account_id': identity.account_id,
        'configured_livemode': identity.livemode, 'charge_id': charge_id,
        'event_payment_intent_id': payment_id, 'provider_event_retrieved': False}
    event_hash = money._digest({'event_id': received['id'], 'charge': charge_id})
    with transaction.atomic():
        record, _ = IdempotencyKey.objects.get_or_create(scope='stripe-financial-event', user_id=owner_id,
            key=received['id'], defaults={'response_status': 200, 'request_hash': event_hash,
                'response_body': {'observation': signed_event, 'status': 'pending_resolution',
                    'reason': 'provider_event_retrieval_unavailable'}})
    if record.request_hash != event_hash:
        raise StripeWebhookReadinessError('financial event identity changed on replay')
    plan = {'payment_intent_id': candidate_payment_id, 'charge_id': charge_id,
        'provider_event_retrieved': False, 'provider_event_account_verified': False,
        'provider_event_livemode_verified': False, 'provider_snapshot_complete': False,
        'provider_read_reason': failure.reason,
        'financial_mutation_enabled': bool(settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED)}
    evidence = _record_financial_snapshot(owner_id=owner_id, signed_event=signed_event,
        observation={'provider_event_retrieved': False, 'provider_read_reason': failure.reason}, plan=plan)
    reason = failure.reason
    _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
        reason=reason, plan=plan)
    return EventOutcome('retry', reason, f'stripe-event:{record.pk}')


def _cursor(payment_intent_id, owner_id):
    reservation = FundingReservation.objects.filter(external_receipt__provider_reference=payment_intent_id,
        recipient_id=owner_id, state='issued').first()
    if reservation:
        return PurchaseRefund.objects.get(ref_kind='funding_reservation', ref_id=str(reservation.pk))
    purchase = StripeTransaction.objects.get(stripe_charge_id=payment_intent_id, user_id=owner_id)
    return PurchaseRefund.objects.get(ref_kind='stripe_transaction', ref_id=str(purchase.pk))


def _session_and_payment(checkout, identity, expected_payment_id=None):
    """Anchor authorization to the exact Session we actually created."""
    from .fulfillment import checkout_metadata
    if not checkout.stripe_checkout_session_id:
        raise StripeWebhookReadinessError('capture session not yet recorded')
    session = _plain(stripe.checkout.Session.retrieve(checkout.stripe_checkout_session_id,
        api_key=settings.STRIPE_SECRET_KEY, max_network_retries=0))
    required = checkout_metadata(checkout)
    if (session.get('id') != checkout.stripe_checkout_session_id or
        session.get('livemode') is not identity.livemode or session.get('mode') != 'payment' or
        session.get('account') not in (None, identity.account_id) or
        session.get('client_reference_id') != str(checkout.user_id) or
        session.get('amount_total') != checkout.amount_cents or session.get('currency') != checkout.currency or
        any(session.get('metadata', {}).get(key) != value for key, value in required.items())):
        raise StripeWebhookReadinessError('capture session contract mismatch')
    payment_id = session.get('payment_intent')
    if not isinstance(payment_id, str) or not payment_id.startswith('pi_') or (
        expected_payment_id and payment_id != expected_payment_id):
        raise StripeWebhookReadinessError('capture payment not attached to original session')
    payment = _plain(stripe.PaymentIntent.retrieve(payment_id,
        api_key=settings.STRIPE_SECRET_KEY, max_network_retries=0))
    if (payment.get('id') != payment_id or payment.get('livemode') is not identity.livemode or
        payment.get('amount') != checkout.amount_cents or payment.get('currency') != checkout.currency or
        any(payment.get('metadata', {}).get(key) != value for key, value in required.items())):
        raise StripeWebhookReadinessError('capture payment contract mismatch')
    return session, payment


def _record_terminal_authorization(checkout, reservation, payment, event):
    """Commit actual no-capture proof before trying to release local capacity."""
    proof = {'provider_event_id': event['id'], 'payment_intent_id': payment['id'],
        'session_id': checkout.stripe_checkout_session_id, 'status': payment['status'],
        'amount_received': payment.get('amount_received'), 'observed_at': timezone.now().isoformat()}
    if payment['status'] != 'canceled' or payment.get('amount_received') != 0:
        raise StripeWebhookReadinessError('authorization cancellation not proven')
    with transaction.atomic():
        IdempotencyKey.objects.get_or_create(scope='stripe-authorization-terminal', user_id=checkout.user_id,
            key=payment['id'], defaults={'request_hash': money._digest({'payment_intent_id': payment['id']}),
                'response_status': 200, 'response_body': {'observation': proof, 'status': 'cancelled'}})
    try:
        money.release_funding(reservation_id=reservation.pk,
            reason=f'stripe:{payment["id"]}:actual_cancelled_no_capture')
    except (DatabaseError, money.EconomicRefusal):
        # The terminal proof remains durable during a fence; retry cleanup
        # using the original provider object, never another authorization.
        return EventOutcome('retry', 'cancelled_authorization_release_pending')
    return EventOutcome('authorization_cancelled', 'funding_capacity_unavailable')


def _capture_checkout(checkout, event, identity, expected_payment_id=None):
    if transaction.get_connection().in_atomic_block:
        raise RuntimeError('processor capture requires committed funding validation')
    session, payment = _session_and_payment(checkout, identity, expected_payment_id)
    reservation = FundingReservation.objects.filter(idempotency_key=f'stripe-intent:{checkout.public_id}').first()
    if reservation is None:
        return EventOutcome('observed', 'legacy_automatic_capture')
    if (reservation.recipient_id != checkout.user_id or reservation.purchaser_id != checkout.user_id or
        reservation.amount_m2z != checkout.tuzis * 1000 or reservation.sale_nusd != checkout.amount_cents * 10_000_000):
        raise StripeWebhookReadinessError('capture reservation quote mismatch')
    if payment['status'] == 'canceled':
        return _record_terminal_authorization(checkout, reservation, payment, event)
    if payment['status'] == 'requires_capture':
        if payment.get('amount_capturable') != checkout.amount_cents or session.get('status') != 'complete':
            raise StripeWebhookReadinessError('capture amount or completion mismatch')
        try:
            money.validate_reserved_funding_for_capture(reservation_id=reservation.pk)
        except (money.EconomicRefusal, DatabaseError) as exc:
            if isinstance(exc, DatabaseError) and not is_explicit_policy_refusal(exc):
                raise
            cancelled = _plain(stripe.PaymentIntent.cancel(payment['id'], api_key=settings.STRIPE_SECRET_KEY,
                max_network_retries=0, idempotency_key=f'economy-capture-cancel:{reservation.pk}'))
            if cancelled.get('id') != payment['id']:
                raise StripeWebhookReadinessError('cancellation identity mismatch')
            return _record_terminal_authorization(checkout, reservation, cancelled, event)
        stripe.PaymentIntent.capture(payment['id'], amount_to_capture=checkout.amount_cents,
            api_key=settings.STRIPE_SECRET_KEY, max_network_retries=0,
            idempotency_key=f'economy-capture:{reservation.pk}')
        # A timeout/unknown capture returns an error and provider retry. The
        # next delivery retrieves canonical status before ever resending.
        session, payment = _session_and_payment(checkout, identity, payment['id'])
    if payment['status'] != 'succeeded' or payment.get('amount_received') != checkout.amount_cents:
        return EventOutcome('retry', 'capture_not_yet_succeeded')
    if session.get('payment_status') != 'paid':
        return EventOutcome('retry', 'paid_session_not_yet_available')
    from .fulfillment import fulfill_checkout_completed
    canonical = {'id': event['id'], 'livemode': event['livemode'], 'account': event.get('account'),
        'data': {'object': session}}
    result = fulfill_checkout_completed(canonical, provider_identity=identity)
    if result.outcome in {'credited', 'duplicate'}:
        # Correlate the canonical post-capture PI, even when the browser's
        # original native-return token was issued while authorization was unpaid.
        from .native_return import NativeReturnUnavailable, record_status_resolution
        try:
            record_status_resolution(checkout.user_id, session['id'], payment['id'])
        except (NativeReturnUnavailable, TypeError, ValueError):
            logging.getLogger(__name__).warning('stripe_native_status_correlation_unavailable')
    return EventOutcome(result.outcome, result.reason)


def handle_checkout_capture(event, identity):
    """The subscribed completion event is the core manual-capture driver."""
    event = _plain(event)
    session = _plain(event['data']['object'])
    checkout = CheckoutIntent.objects.filter(stripe_checkout_session_id=session.get('id')).first()
    if checkout is None or checkout.stripe_account_id != identity.account_id or checkout.stripe_livemode != identity.livemode:
        return EventOutcome('retry', 'capture_intent_unproven')
    return _capture_checkout(checkout, event, identity, session.get('payment_intent'))


def handle_capture_event(event, identity):
    """Optional additional event; completion alone is sufficient for release."""
    event = _plain(event)
    payment = _plain(stripe.PaymentIntent.retrieve(event['data']['object']['id'],
        api_key=settings.STRIPE_SECRET_KEY, max_network_retries=0))
    checkout = CheckoutIntent.objects.filter(public_id=payment.get('metadata', {}).get('checkout_intent_id')).first()
    if checkout is None or checkout.stripe_account_id != identity.account_id or checkout.stripe_livemode != identity.livemode:
        return EventOutcome('retry', 'capture_intent_unproven')
    return _capture_checkout(checkout, event, identity, payment['id'])


def reconcile_expired_card_authorizations(*, creator_id, identity, limit=20):
    """Read actual terminal Sessions before releasing abandoned capacity.

    No expiry/status guess releases a possibly captured authorization. Rows
    without a known provider Session remain visible for operator resolution.
    The bounded reconciliation runs before admitting another checkout.
    """
    reconcile_creation_refusals(creator_id=creator_id, limit=limit)
    reservations = FundingReservation.objects.filter(recipient_id=creator_id,
        state='reserved', idempotency_key__startswith='stripe-intent:')
    ids = [row.idempotency_key.removeprefix('stripe-intent:') for row in reservations]
    checkouts = CheckoutIntent.objects.filter(user_id=creator_id, public_id__in=ids,
        stripe_account_id=identity.account_id, stripe_livemode=identity.livemode,
        created_at__lt=timezone.now() - timedelta(minutes=30),
        stripe_checkout_session_id__isnull=False).exclude(state=CheckoutIntent.State.FULFILLED).order_by('created_at')[:limit]
    for checkout in checkouts:
        session = _plain(stripe.checkout.Session.retrieve(checkout.stripe_checkout_session_id,
            api_key=settings.STRIPE_SECRET_KEY, max_network_retries=0))
        if session.get('status') != 'expired':
            continue
        from .fulfillment import checkout_metadata
        if (session.get('id') != checkout.stripe_checkout_session_id or
            session.get('livemode') is not identity.livemode or session.get('mode') != 'payment' or
            session.get('client_reference_id') != str(creator_id) or
            any(session.get('metadata', {}).get(key) != value for key, value in checkout_metadata(checkout).items())):
            raise StripeWebhookReadinessError('expired session identity mismatch')
        payment_id = session.get('payment_intent')
        payment = _plain(stripe.PaymentIntent.retrieve(payment_id,
            api_key=settings.STRIPE_SECRET_KEY, max_network_retries=0)) if payment_id else None
        if payment and (payment.get('id') != payment_id or payment.get('livemode') is not identity.livemode or
            payment.get('status') != 'canceled' or payment.get('amount_received') != 0):
            continue
        reservation = reservations.get(idempotency_key=f'stripe-intent:{checkout.public_id}')
        with transaction.atomic():
            IdempotencyKey.objects.get_or_create(scope='stripe-session-terminal', user_id=creator_id,
                key=session['id'], defaults={'request_hash': money._digest({'session_id': session['id']}),
                    'response_status': 200, 'response_body': {'status': 'expired_without_capture',
                        'session_id': session['id'], 'payment_intent_id': payment_id,
                        'observed_at': timezone.now().isoformat()}})
        money.release_funding(reservation_id=reservation.pk,
            reason=f'stripe-session:{session["id"]}:actual_expired_no_capture')


def dispute_principal(dispute, charge):
    """Net principal actually withdrawn, excluding fees and status guesses.

    A dispute label is not a funds movement. Each balance transaction must
    name this dispute and carry exactly its principal; processor fees are
    evidence only and never enter the returned amount.
    """
    amount = dispute.get('amount')
    movements = dispute.get('balance_transactions')
    if type(amount) is not int or not 0 < amount <= charge['amount'] or not isinstance(movements, list) or len(movements) > 100:
        raise money.EconomicRefusal('dispute_principal_unproven')
    if not movements:
        return 0, []
    seen, principal, evidence = set(), 0, []
    for movement in movements:
        if not isinstance(movement, dict):
            raise money.EconomicRefusal('dispute_movement_unproven')
        value = movement.get('amount')
        fee = movement.get('fee', 0)
        if (not isinstance(movement.get('id'), str) or movement['id'] in seen or movement.get('source') != dispute['id'] or
            movement.get('currency') != charge['currency'] or type(value) is not int or abs(value) != amount):
            raise money.EconomicRefusal('dispute_movement_unproven')
        if type(fee) is not int:
            raise money.EconomicRefusal('dispute_movement_unproven')
        seen.add(movement['id'])
        principal -= value
        evidence.append({'id': movement['id'], 'principal_cents': value,
            'currency': movement['currency'], 'source': movement['source'],
            'fee_cents': movement.get('fee'), 'net_cents': movement.get('net')})
    if not 0 <= principal <= amount:
        raise money.EconomicRefusal('dispute_movement_unproven')
    return principal, evidence


def _page_rows(page, *, kind):
    page = _plain(page)
    rows = page.get('data') if isinstance(page, dict) else getattr(page, 'data', None)
    has_more = page.get('has_more') if isinstance(page, dict) else getattr(page, 'has_more', None)
    if not isinstance(rows, list) or type(has_more) is not bool:
        raise money.EconomicRefusal(f'{kind}_page_unproven')
    if has_more or len(rows) > FINANCIAL_PROVIDER_RECORD_LIMIT:
        raise money.EconomicRefusal(f'{kind}_count_exceeds_reconciliation_bound')
    return rows


def _current_disputes(charge, identity, provider, expected_event_dispute_id=None):
    """Reconcile all charge disputes from actual principal movements."""
    listed = provider.disputes(charge['id'])
    total, evidence, seen = 0, [], set()
    event_dispute_seen = expected_event_dispute_id is None
    for value in _page_rows(listed, kind='dispute'):
        item = _plain(value)
        dispute_id = item.get('id') if isinstance(item, dict) else None
        if not isinstance(dispute_id, str) or dispute_id in seen:
            raise money.EconomicRefusal('dispute_identity_unproven')
        seen.add(dispute_id)
        try:
            dispute = _plain(provider.dispute(dispute_id))
        except ProviderReadUnavailable as exc:
            raise ProviderReadUnavailable(exc.reason, partial={
                'dispute_principal_cents': total, 'dispute_balance_transactions': evidence}) from exc
        if (dispute.get('id') != dispute_id or dispute.get('charge') != charge['id'] or
            dispute.get('currency') != charge['currency'] or dispute.get('livemode') is not identity.livemode):
            raise money.EconomicRefusal('dispute_charge_identity_unproven')
        if dispute_id == expected_event_dispute_id:
            event_dispute_seen = True
        principal, rows = dispute_principal(dispute, charge)
        total += principal
        evidence.extend(dict(row, dispute_id=dispute_id) for row in rows)
    if not event_dispute_seen:
        raise money.EconomicRefusal('event_dispute_not_in_current_provider_state')
    if total > charge['amount']:
        raise money.EconomicRefusal('dispute_principal_exceeds_charge')
    return total, evidence


def _completed_refunds(charge, provider):
    """Return completed refund principal backed by Stripe balance movements."""
    succeeded = 0
    seen_refunds, seen_movements = set(), set()
    evidence, statuses, failure_evidence = [], [], []
    try:
        refunds = provider.refunds(charge['id'])
    except ProviderReadUnavailable as exc:
        raise ProviderReadUnavailable(exc.reason, partial={
            'refund_succeeded_cents': succeeded, 'refund_ids': sorted(seen_refunds),
            'refund_movement_ids': sorted(seen_movements), 'refund_balance_transactions': evidence,
            'refund_statuses': statuses, 'refund_failure_balance_transactions': failure_evidence}) from exc
    for value in _page_rows(refunds, kind='refund'):
        refund = _plain(value)
        if (not isinstance(refund, dict) or not isinstance(refund.get('id'), str) or
            refund['id'] in seen_refunds or refund.get('charge') != charge['id'] or
            refund.get('currency') != charge['currency'] or type(refund.get('amount')) is not int or
            not 0 < refund['amount'] <= charge['amount']):
            raise money.EconomicRefusal('refund_observation_unproven')
        seen_refunds.add(refund['id'])
        status = refund.get('status')
        status_row = {'id': refund['id'], 'status': status, 'amount': refund['amount']}
        statuses.append(status_row)
        if status in {'failed', 'canceled'}:
            failure_id = refund.get('failure_balance_transaction')
            if failure_id:
                try:
                    movement = _plain(provider.balance_transaction(failure_id))
                except ProviderReadUnavailable as exc:
                    partial = {'refund_succeeded_cents': succeeded, 'refund_ids': sorted(seen_refunds),
                        'refund_movement_ids': sorted(seen_movements), 'refund_balance_transactions': list(evidence),
                        'refund_statuses': list(statuses),
                        'refund_failure_balance_transactions': list(failure_evidence)}
                    raise ProviderReadUnavailable(exc.reason, partial=partial) from exc
                if (not isinstance(movement, dict) or movement.get('id') != failure_id or
                    movement.get('source') != refund['id'] or movement.get('currency') != charge['currency'] or
                    movement.get('amount') != refund['amount'] or
                    movement.get('type') not in {'refund_failure', 'payment_failure_refund'}):
                    raise money.EconomicRefusal('refund_failure_movement_unproven')
                status_row['failure_movement_id'] = failure_id
                failure_evidence.append({'refund_id': refund['id'], 'refund_amount_cents': refund['amount'],
                    'balance_transaction_id': failure_id, 'principal_cents': movement['amount'],
                    'currency': movement['currency'], 'source': movement['source'],
                    'type': movement['type'], 'fee_cents': movement.get('fee'), 'net_cents': movement.get('net')})
            continue
        if status == 'pending':
            continue
        if status != 'succeeded' or not refund.get('balance_transaction'):
            raise money.EconomicRefusal('refund_movement_unproven')
        try:
            movement = _plain(provider.balance_transaction(refund['balance_transaction']))
        except ProviderReadUnavailable as exc:
            partial = {'refund_succeeded_cents': succeeded, 'refund_ids': sorted(seen_refunds),
                'refund_movement_ids': sorted(seen_movements), 'refund_balance_transactions': list(evidence),
                'refund_statuses': list(statuses),
                'refund_failure_balance_transactions': list(failure_evidence)}
            raise ProviderReadUnavailable(exc.reason, partial=partial) from exc
        if (not isinstance(movement, dict) or movement.get('id') != refund['balance_transaction'] or
            movement['id'] in seen_movements or movement.get('source') != refund['id'] or
            movement.get('currency') != charge['currency'] or movement.get('amount') != -refund['amount'] or
            movement.get('type') != 'refund'):
            raise money.EconomicRefusal('refund_movement_unproven')
        seen_movements.add(movement['id'])
        succeeded += refund['amount']
        evidence.append({'refund_id': refund['id'], 'refund_amount_cents': refund['amount'],
            'balance_transaction_id': movement['id'], 'principal_cents': movement['amount'],
            'currency': movement['currency'], 'source': movement['source'],
            'fee_cents': movement.get('fee'), 'net_cents': movement.get('net')})
    if succeeded != charge.get('amount_refunded') or succeeded > charge['amount']:
        raise money.EconomicRefusal('refund_total_unproven')
    return succeeded, sorted(seen_refunds), sorted(seen_movements), evidence, statuses, failure_evidence


def _record_financial_snapshot(*, owner_id, signed_event, observation, plan):
    """Insert a durable provider snapshot once; never replace its contents."""
    snapshot = {'signed_event': signed_event, 'provider_snapshot': observation, 'plan': plan}
    fingerprint = money._digest(snapshot)
    key = fingerprint
    row, created = IdempotencyKey.objects.get_or_create(scope='stripe-financial-evidence',
        user_id=owner_id, key=key, defaults={'request_hash': fingerprint,
            'response_status': 200, 'response_body': {'snapshot': snapshot, 'outcomes': []}})
    if not created and (row.request_hash != fingerprint or row.response_body.get('snapshot') != snapshot):
        raise StripeWebhookReadinessError('financial evidence identity changed')
    return row


def _record_financial_outcome(*, record, evidence, status, reason, plan=None, ledger_operation=None):
    """Append an immutable decision and refresh the bounded queue projection."""
    outcome = {'status': status, 'reason': reason, 'plan': plan,
        'ledger_operation': ledger_operation}
    outcome_id = money._digest(outcome)
    with transaction.atomic():
        durable = IdempotencyKey.objects.select_for_update().get(pk=evidence.pk)
        body = durable.response_body if isinstance(durable.response_body, dict) else {}
        outcomes = list(body.get('outcomes', []))
        if not any(item.get('outcome_id') == outcome_id for item in outcomes):
            outcomes.append(dict(outcome, outcome_id=outcome_id, recorded_at=timezone.now().isoformat()))
            durable.response_body = dict(body, outcomes=outcomes)
            durable.save(update_fields=['response_body'])
        current = IdempotencyKey.objects.select_for_update().get(pk=record.pk)
        projection = dict(current.response_body or {})
        projection.update(status=status, reason=reason, evidence_id=str(durable.pk))
        if plan is not None:
            projection['plan'] = plan
        current.response_body = projection
        current.save(update_fields=['response_body'])
    if status == 'pending_resolution':
        logging.getLogger(__name__).warning('stripe_financial_reconciliation_pending', extra={
            'provider_event_id': record.key, 'owner_id': record.user_id,
            'reason': reason, 'evidence_id': str(evidence.pk),
            'payment_intent_id': (plan or {}).get('payment_intent_id'),
        })


def _restoration_is_proven(previous, plan, cursor, target_m2z):
    """Require a newly observed provider return before lowering the cursor."""
    previous = previous if isinstance(previous, dict) else {}
    prior_plan = previous.get('applied_plan') or {}
    prior_refund_statuses = {item.get('id'): item for item in prior_plan.get('refund_statuses', [])
        if isinstance(item, dict) and isinstance(item.get('id'), str)}
    failed_refund_cents = sum(item.get('amount', 0) for item in plan.get('refund_statuses', [])
        if isinstance(item, dict) and item.get('status') == 'failed' and
        prior_refund_statuses.get(item.get('id'), {}).get('status') == 'succeeded' and
        isinstance(item.get('failure_movement_id'), str) and type(item.get('amount')) is int)
    prior_refund_ids = {item.get('refund_id') for item in prior_plan.get('refund_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('refund_id'), str)}
    new_refund_cents = sum(item.get('refund_amount_cents', 0) for item in plan.get('refund_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('refund_id'), str) and
        item.get('refund_id') not in prior_refund_ids and type(item.get('refund_amount_cents')) is int)
    prior_dispute_ids = set(prior_plan.get('dispute_movement_ids', []))
    reinstated_cents = sum(item.get('principal_cents', 0) for item in plan.get('dispute_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('id'), str) and item['id'] not in prior_dispute_ids and
        type(item.get('principal_cents')) is int and item['principal_cents'] > 0)
    new_dispute_outflow_cents = sum(-item.get('principal_cents', 0) for item in plan.get('dispute_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('id'), str) and item['id'] not in prior_dispute_ids and
        type(item.get('principal_cents')) is int and item['principal_cents'] < 0)
    captured_cents = plan.get('captured_cents')
    issued_m2z = plan.get('issued_m2z')
    previous_refunds = prior_plan.get('refund_completed_cents')
    previous_disputes = prior_plan.get('dispute_outstanding_cents')
    current_refunds = plan.get('refund_completed_cents')
    current_disputes = plan.get('dispute_outstanding_cents')
    previous_target = prior_plan.get('target_m2z')
    if (type(captured_cents) is not int or captured_cents <= 0 or not str(issued_m2z or '').isdigit() or
        any(type(value) is not int for value in (previous_refunds, previous_disputes, current_refunds, current_disputes)) or
        not str(previous_target or '').isdigit()):
        return False
    issued_m2z = int(issued_m2z)
    decrease = int(cursor.refunded_m2z) - target_m2z
    refund_change_cents = current_refunds - previous_refunds
    dispute_change_cents = current_disputes - previous_disputes
    refund_change_proven = refund_change_cents == new_refund_cents - failed_refund_cents
    dispute_change_proven = dispute_change_cents == new_dispute_outflow_cents - reinstated_cents
    previous_outflow = min(captured_cents, previous_refunds + previous_disputes)
    current_outflow = min(captured_cents, current_refunds + current_disputes)
    expected_previous_target = (issued_m2z * previous_outflow) // captured_cents
    expected_current_target = (issued_m2z * current_outflow) // captured_cents
    return (decrease > 0 and int(previous_target) == int(cursor.refunded_m2z) and
        expected_previous_target == int(cursor.refunded_m2z) and expected_current_target == target_m2z and
        refund_change_proven and dispute_change_proven and
        failed_refund_cents + reinstated_cents > 0 and
        expected_previous_target - expected_current_target == decrease)


def _snapshot_preserves_applied_movements(previous, plan):
    """A later-started but stale provider read cannot erase applied evidence."""
    prior_plan = previous.get('applied_plan') or {}
    current_dispute_ids = set(plan.get('dispute_movement_ids', []))
    if not set(prior_plan.get('dispute_movement_ids', [])).issubset(current_dispute_ids):
        return False
    prior_refunds = {item.get('refund_id'): item for item in prior_plan.get('refund_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('refund_id'), str)}
    current_refunds = {item.get('refund_id') for item in plan.get('refund_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('refund_id'), str)}
    current_statuses = {item.get('id'): item for item in plan.get('refund_statuses', [])
        if isinstance(item, dict) and isinstance(item.get('id'), str)}
    prior_failures = {item.get('refund_id'): item for item in prior_plan.get('refund_failure_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('refund_id'), str)}
    current_failures = {item.get('refund_id'): item for item in plan.get('refund_failure_balance_transactions', [])
        if isinstance(item, dict) and isinstance(item.get('refund_id'), str)}
    for refund_id in prior_refunds.keys() - current_refunds:
        status = current_statuses.get(refund_id, {})
        if status.get('status') not in {'failed', 'canceled'} or not status.get('failure_movement_id'):
            return False
    for refund_id, prior_failure in prior_failures.items():
        status = current_statuses.get(refund_id, {})
        current_failure = current_failures.get(refund_id, {})
        if (status.get('status') not in {'failed', 'canceled'} or
            status.get('failure_movement_id') != prior_failure.get('balance_transaction_id') or
            current_failure.get('balance_transaction_id') != prior_failure.get('balance_transaction_id')):
            return False
    return True


def _apply_financial_plan(*, record, evidence, owner_id, cursor, plan):
    """Apply one provider-state snapshot through the installed ledger API.

    The cursor row serializes overlapping refund/dispute events in SQL. The
    snapshot digest shares an idempotency key across duplicate/reordered
    events that observe the same provider state, while allowing changed
    canonical provider state to be reconciled later.
    """
    from dj.apps.ledger import api as usage
    snapshot_identity = {'payment_intent_id': plan['payment_intent_id'],
        'refund_movement_ids': plan['refund_movement_ids'],
        'dispute_movement_ids': plan['dispute_movement_ids'],
        'target_m2z': plan['target_m2z']}
    # A refund may succeed and fail entirely between reads. Its return proves
    # a later success-only snapshot stale even if credits never changed. Keep
    # existing identities stable when no failure movement has been observed.
    failure_ids = sorted(row['balance_transaction_id']
        for row in plan.get('refund_failure_balance_transactions', []))
    if failure_ids:
        snapshot_identity['refund_failure_movement_ids'] = failure_ids
    state_key = money._digest(snapshot_identity)
    target_m2z = int(plan['target_m2z'])
    try:
        with transaction.atomic():
            money.pin_policy()
            # Match the installed SQL writer order before taking any adapter
            # state/cursor lock. Direct ledger adjustments share these locks.
            creator = usage.lock_creator(owner_id)
            if creator is None:
                raise ValueError('original_creator_unavailable')
            usage.lock_account(owner_id, creator.balance)
            state, _ = IdempotencyKey.objects.get_or_create(scope='stripe-financial-state',
                user_id=owner_id, key=plan['payment_intent_id'], defaults={
                    'request_hash': money._digest({'payment_intent_id': plan['payment_intent_id']}),
                    'response_status': 200, 'response_body': {}})
            state = IdempotencyKey.objects.select_for_update().get(pk=state.pk)
            previous = state.response_body if isinstance(state.response_body, dict) else {}
            previous_fingerprint = previous.get('snapshot_fingerprint')
            if previous_fingerprint == state_key:
                cursor = PurchaseRefund.objects.select_for_update().get(pk=cursor.pk)
                if cursor.refunded_m2z != target_m2z:
                    reason = 'provider_snapshot_cursor_mismatch'
                    _record_financial_outcome(record=record, evidence=evidence,
                        status='pending_resolution', reason=reason, plan=plan)
                    return EventOutcome('pending_resolution', reason, f'stripe-event:{record.pk}')
                if plan['snapshot_read_started_at'] > previous.get('snapshot_read_started_at', ''):
                    state.response_body = dict(previous,
                        snapshot_read_started_at=plan['snapshot_read_started_at'],
                        latest_event_created=plan['event_created'], provider_event_id=plan['provider_event_id'])
                    state.save(update_fields=['response_body'])
                _record_financial_outcome(record=record, evidence=evidence, status='reconciled',
                    reason='provider_snapshot_already_applied', plan=plan,
                    ledger_operation=previous.get('ledger_operation'))
                return EventOutcome('reconciled', 'provider_snapshot_already_applied', f'stripe-event:{record.pk}')
            if (previous_fingerprint and
                plan['snapshot_read_started_at'] < previous.get('snapshot_read_started_at', '')):
                # Even a complete return observed by an earlier read must be
                # confirmed by a fresh read after the current watermark. Keep
                # its evidence and ask the provider to redeliver the event.
                reason = 'provider_snapshot_read_superseded'
                _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
                    reason=reason, plan=plan)
                return EventOutcome('retry', reason, f'stripe-event:{record.pk}')
            if previous_fingerprint and not _snapshot_preserves_applied_movements(previous, plan):
                reason = 'provider_snapshot_regressed'
                _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
                    reason=reason, plan=plan)
                return EventOutcome('pending_resolution', reason, f'stripe-event:{record.pk}')
            # Creator/account -> payment watermark -> original cursor -> SQL
            # writer. Never decide against the stale pre-lock cursor read.
            cursor = PurchaseRefund.objects.select_for_update().get(pk=cursor.pk)
            operation_kind = 'restore' if target_m2z < cursor.refunded_m2z else 'refund'
            idem = f"stripe-financial:{plan['payment_intent_id']}:{money._digest({
                'snapshot': state_key, 'operation': operation_kind,
                'preimage_refunded_m2z': str(cursor.refunded_m2z)})}"
            if target_m2z < cursor.refunded_m2z:
                if not _restoration_is_proven(previous, plan, cursor, target_m2z):
                    _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
                        reason='provider_restoration_unproven', plan=plan)
                    return EventOutcome('pending_resolution', 'provider_restoration_unproven', f'stripe-event:{record.pk}')
                restored = usage.restore_purchase(owner_id, cursor.ref_kind, cursor.ref_id,
                    target_m2z, idem)
                cursor.refresh_from_db()
                if restored.status != 'posted' or cursor.refunded_m2z != target_m2z:
                    _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
                        reason='ledger_transition_not_applied', plan=plan)
                    return EventOutcome('pending_resolution', 'ledger_transition_not_applied', f'stripe-event:{record.pk}')
                freeze_idem = None
                if plan['dispute_outstanding_cents'] > 0:
                    freeze_idem = f"stripe-financial:{plan['payment_intent_id']}:{money._digest({
                        'snapshot': state_key, 'operation': 'freeze',
                        'post_restore_refunded_m2z': str(cursor.refunded_m2z)})}"
                    frozen = usage.refund_purchase(owner_id, cursor.ref_kind, cursor.ref_id,
                        target_m2z, 'stripe:verified_financial_movement', freeze_idem, freeze=True)
                    cursor.refresh_from_db()
                    if frozen.status != 'posted' or cursor.refunded_m2z != target_m2z:
                        _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
                            reason='ledger_transition_not_applied', plan=plan)
                        return EventOutcome('pending_resolution', 'ledger_transition_not_applied', f'stripe-event:{record.pk}')
                reason = 'dispute_principal_reinstated'
                ledger_operation = {'idempotency_key': idem, 'cursor_ref_kind': cursor.ref_kind,
                    'cursor_ref_id': cursor.ref_id, 'target_m2z': str(target_m2z),
                    'restored_m2z': str(restored.restored), 'debt_repaid_m2z': str(restored.debt_repaid),
                    'transfer_id': restored.transfer_id, 'repay_transfer_id': restored.repay_transfer_id,
                    'freeze_idempotency_key': freeze_idem}
            elif target_m2z == cursor.refunded_m2z and plan['dispute_outstanding_cents'] == 0:
                reason = 'no_cursor_change'
                ledger_operation = None
            else:
                freeze = plan['dispute_outstanding_cents'] > 0
                result = usage.refund_purchase(owner_id, cursor.ref_kind, cursor.ref_id,
                    target_m2z, 'stripe:verified_financial_movement', idem, freeze=freeze)
                cursor.refresh_from_db()
                if result.status not in {'posted'} or cursor.refunded_m2z != target_m2z:
                    _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
                        reason='ledger_transition_not_applied', plan=plan)
                    return EventOutcome('pending_resolution', 'ledger_transition_not_applied', f'stripe-event:{record.pk}')
                reason = 'verified_provider_movement_applied'
                ledger_operation = {'idempotency_key': idem, 'cursor_ref_kind': cursor.ref_kind,
                    'cursor_ref_id': cursor.ref_id, 'target_m2z': str(target_m2z),
                    'clawed_m2z': str(result.clawed), 'debt_added_m2z': str(result.debt_added),
                    'cursor_refunded_m2z': str(result.refunded_m2z)}
            if ledger_operation is not None:
                key_row = TransferKey.objects.filter(idem=idem).first()
                ledger_operation['transfer_key'] = ({'transfer_id': key_row.transfer_id,
                    'detail': key_row.detail} if key_row else None)
            _record_financial_outcome(record=record, evidence=evidence, status='reconciled',
                reason=reason, plan=plan, ledger_operation=ledger_operation)
            state.response_body = {'latest_event_created': plan['event_created'],
                'snapshot_read_started_at': plan['snapshot_read_started_at'],
                'snapshot_fingerprint': state_key, 'provider_event_id': plan['provider_event_id'],
                'ledger_operation': ledger_operation, 'applied_plan': plan}
            state.save(update_fields=['response_body'])
        return EventOutcome('reconciled', 'verified_provider_movement_applied', f'stripe-event:{record.pk}')
    except (DatabaseError, money.EconomicRefusal, ValueError) as exc:
        cause = getattr(exc, '__cause__', None)
        funding_cap_refusal = (getattr(cause, 'sqlstate', None) == '23514' and
            getattr(getattr(cause, 'diag', None), 'message_primary', None) == 'usage_daily_funding_limit')
        if isinstance(exc, DatabaseError) and not (is_explicit_policy_refusal(exc) or funding_cap_refusal):
            # Rolled-back database failures are not terminal provider outcomes.
            # Keep the observation, but request delivery again after recovery.
            reason = 'ledger_temporarily_unavailable'
            _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
                reason=reason, plan=plan)
            return EventOutcome('retry', reason, f'stripe-event:{record.pk}')
        reason = str(exc)
        if 'funding_limit' in reason or 'daily_funding_limit' in reason:
            reason = 'restoration_blocked_by_funding_limit'
        elif 'disabled' in reason or 'fenced' in reason or 'policy' in reason:
            reason = 'economic_policy_unavailable'
        else:
            reason = 'ledger_mutation_refused'
        # The external observation was committed before this savepoint. Keep
        # it and the precise attributable plan when a fence/cap refuses.
        _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
            reason=reason, plan=plan)
        return EventOutcome('pending_resolution', reason, f'stripe-event:{record.pk}')


def handle_financial_event(event, identity, *, read_budget=None):
    obj = event['data']['object']
    charge_id = obj['id'] if event['type'] == 'charge.refunded' else obj['charge']
    event_payment_id = obj.get('payment_intent')
    candidate_payment_id = event_payment_id if isinstance(event_payment_id, str) else charge_id
    purchase = StripeTransaction.objects.filter(stripe_charge_id=candidate_payment_id).first()
    checkout = CheckoutIntent.objects.filter(stripe_payment_intent_id=candidate_payment_id).first()
    reservations = list(FundingReservation.objects.filter(
        external_receipt__provider_reference=candidate_payment_id).order_by('pk')[:2])
    if len(reservations) > 1:
        raise StripeWebhookReadinessError('refund funding receipt is ambiguous')
    reservation = reservations[0] if reservations else None
    if purchase is None and checkout is None and reservation is None:
        return EventOutcome('retry', 'original_purchase_not_yet_available')
    owner_id = purchase.user_id if purchase else (checkout.user_id if checkout else reservation.recipient_id)
    signed_event = {'provider_event_id': event['id'], 'event_type': event['type'],
        'event_created': event.get('created'), 'event_livemode': event.get('livemode'),
        'provider_account_id': identity.account_id, 'livemode': identity.livemode,
        'charge_id': charge_id, 'event_payment_intent_id': event_payment_id}
    event_hash = money._digest({'event_id': event['id'], 'charge': charge_id})
    with transaction.atomic():
        record, _ = IdempotencyKey.objects.get_or_create(scope='stripe-financial-event', user_id=owner_id, key=event['id'],
            defaults={'response_status': 200, 'request_hash': event_hash,
                'response_body': {'observation': signed_event, 'status': 'pending_resolution',
                    'reason': 'provider_reconciliation_in_progress'}})
    if record.request_hash != event_hash:
        raise StripeWebhookReadinessError('financial event identity changed on replay')
    try:
        snapshot_read_started_at = _financial_snapshot_started_at()
        provider = (financial_provider_reader(identity, read_budget=read_budget) if read_budget is not None
            else financial_provider_reader(identity))
        charge = _plain(provider.charge(charge_id))
    except (ProviderReadUnavailable, stripe.error.StripeError) as exc:
        provider_reason = exc.reason if isinstance(exc, ProviderReadUnavailable) else 'provider_read_unavailable'
        plan = {'payment_intent_id': candidate_payment_id, 'charge_id': charge_id,
            'provider_snapshot_complete': False, 'provider_read_reason': provider_reason,
            'snapshot_read_started_at': snapshot_read_started_at,
            'financial_mutation_enabled': bool(settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED)}
        evidence = _record_financial_snapshot(owner_id=owner_id, signed_event=signed_event,
            observation={'provider_snapshot_complete': False, 'provider_read_reason': provider_reason}, plan=plan)
        _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
            reason='provider_read_unavailable', plan=plan)
        if provider_reason.startswith('provider_read_'):
            return EventOutcome('retry', provider_reason, f'stripe-event:{record.pk}')
        return EventOutcome('pending_resolution', 'provider_read_unavailable', f'stripe-event:{record.pk}')
    if (not isinstance(charge, dict) or charge.get('id') != charge_id or
        charge.get('livemode') is not identity.livemode or charge.get('currency') != 'usd' or
        type(charge.get('amount')) is not int or charge['amount'] <= 0 or
        not isinstance(charge.get('payment_intent'), str) or not charge['payment_intent'].startswith('pi_') or
        len(charge['payment_intent']) > 200 or charge['payment_intent'] != candidate_payment_id):
        reason = 'provider_charge_identity_unproven'
        plan = {'payment_intent_id': candidate_payment_id, 'charge_id': charge_id,
            'provider_snapshot_complete': False, 'provider_read_reason': reason,
            'financial_mutation_enabled': bool(settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED)}
        evidence = _record_financial_snapshot(owner_id=owner_id, signed_event=signed_event,
            observation={'provider_charge': charge, 'provider_snapshot_complete': False}, plan=plan)
        _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
            reason=reason, plan=plan)
        return EventOutcome('pending_resolution', reason, f'stripe-event:{record.pk}')
    payment_id = charge['payment_intent']
    purchase = StripeTransaction.objects.filter(stripe_charge_id=payment_id).first()
    checkout = CheckoutIntent.objects.filter(stripe_payment_intent_id=payment_id).first()
    reservations = list(FundingReservation.objects.filter(
        external_receipt__provider_reference=payment_id).order_by('pk')[:2])
    if len(reservations) > 1:
        raise StripeWebhookReadinessError('refund funding receipt is ambiguous')
    reservation = reservations[0] if reservations else None
    if purchase is None and checkout is None and reservation is None:
        return EventOutcome('retry', 'original_purchase_not_yet_available')
    if ((purchase and purchase.user_id != owner_id) or (checkout and checkout.user_id != owner_id) or
        (reservation and reservation.recipient_id != owner_id)):
        raise StripeWebhookReadinessError('financial receipt owner changed')
    if checkout is not None and (checkout.user_id != owner_id or checkout.stripe_account_id != identity.account_id or
        checkout.stripe_livemode is not identity.livemode or checkout.state not in {
            CheckoutIntent.State.OPEN, CheckoutIntent.State.FULFILLED}):
        raise StripeWebhookReadinessError('refund original checkout account mismatch')
    if reservation is not None and (reservation.recipient_id != owner_id or reservation.purchaser_id != owner_id or
        reservation.state not in {'issued', 'resolution'} or
        reservation.external_receipt.get('provider_reference') != payment_id):
        raise StripeWebhookReadinessError('refund original funding receipt mismatch')
    if checkout is not None and reservation is not None and reservation.idempotency_key != f'stripe-intent:{checkout.public_id}':
        raise StripeWebhookReadinessError('refund checkout and funding reservation mismatch')
    if purchase is not None and purchase.user_id != owner_id:
        raise StripeWebhookReadinessError('refund original receipt owner mismatch')
    expected_amount = purchase.amount if purchase else (checkout.amount_cents if checkout else reservation.external_receipt.get('amount_cents'))
    if type(expected_amount) is not int:
        raise StripeWebhookReadinessError('refund original captured amount unavailable')
    if charge['amount'] != expected_amount:
        raise StripeWebhookReadinessError('refund original captured amount mismatch')
    if event_payment_id is not None and event_payment_id != payment_id:
        raise StripeWebhookReadinessError('financial event payment identity mismatch')
    event_created = event.get('created')
    event_time_proven = type(event_created) is int and event_created > 0
    observation = {'provider_event_id': event['id'], 'event_type': event['type'],
        'charge_id': charge_id, 'payment_intent_id': payment_id,
        'captured_cents': charge['amount'], 'provider_account_id': identity.account_id,
        'livemode': identity.livemode, 'provider_event_created': event_created}
    original_account_proven = bool(
        checkout is not None or (reservation is not None and
            reservation.external_receipt.get('stripe_account_id') == identity.account_id and
            reservation.external_receipt.get('stripe_livemode') is identity.livemode))
    movement_error = '' if event_time_proven else 'provider_event_time_unproven'
    try:
        succeeded, refund_ids, refund_movement_ids, refund_evidence, refund_statuses, refund_failure_evidence = _completed_refunds(charge, provider)
    except money.EconomicRefusal as exc:
        succeeded, refund_ids, refund_movement_ids, refund_evidence, refund_statuses, refund_failure_evidence = 0, [], [], [], [], []
        movement_error = str(exc)
    except ProviderReadUnavailable as exc:
        partial = exc.partial
        succeeded = partial.get('refund_succeeded_cents', 0)
        refund_ids = partial.get('refund_ids', [])
        refund_movement_ids = partial.get('refund_movement_ids', [])
        refund_evidence = partial.get('refund_balance_transactions', [])
        refund_statuses = partial.get('refund_statuses', [])
        refund_failure_evidence = partial.get('refund_failure_balance_transactions', [])
        movement_error = exc.reason
    if succeeded > charge['amount']:
        raise StripeWebhookReadinessError('refund exceeds original charge')
    dispute_id = obj.get('id') if event['type'].startswith('charge.dispute.') else None
    try:
        dispute_outstanding, dispute_evidence = _current_disputes(charge, identity, provider, dispute_id)
    except money.EconomicRefusal as exc:
        dispute_outstanding, dispute_evidence = 0, []
        movement_error = movement_error or str(exc)
    except ProviderReadUnavailable as exc:
        dispute_outstanding = exc.partial.get('dispute_principal_cents', 0)
        dispute_evidence = exc.partial.get('dispute_balance_transactions', [])
        movement_error = movement_error or exc.reason
    cursor = None
    try:
        cursor = _cursor(payment_id, owner_id)
    except (PurchaseRefund.DoesNotExist, StripeTransaction.DoesNotExist):
        pass
    issuance_proven = False
    if cursor is not None and cursor.credited_m2z > 0:
        from dj.apps.economy.funding import _cursor_issuance_status, transaction_issuance_status
        if cursor.ref_kind == 'funding_reservation' and reservation is not None:
            proof = _cursor_issuance_status(cursor, creator_id=owner_id, rail='stripe',
                expected_total=reservation.amount_m2z)
            issuance_proven = (proof['credited'] and int(proof['credited_m2z']) == cursor.credited_m2z)
        elif cursor.ref_kind == 'stripe_transaction' and purchase is not None:
            proof = transaction_issuance_status(purchase)
            issuance_proven = (proof['credited'] and int(proof['credited_m2z']) == cursor.credited_m2z)
    issuance_cursor = cursor
    issued_m2z = issuance_cursor.credited_m2z if issuance_proven else 0
    # A durable provider capture is not proof that usage credits were issued.
    # Preserve the event for manual attribution; never create a cursor here.
    if not original_account_proven:
        reason = 'original_provider_account_unproven'
    elif not issuance_proven:
        reason = 'original_issuance_unproven'
    else:
        reason = ''
    total_outflow = min(charge['amount'], succeeded + dispute_outstanding)
    refund_target = (issued_m2z * succeeded) // charge['amount'] if issued_m2z else 0
    target = (issued_m2z * total_outflow) // charge['amount'] if issued_m2z else 0
    plan = {'payment_intent_id': payment_id, 'charge_id': charge_id,
        'snapshot_read_started_at': snapshot_read_started_at,
        'captured_cents': charge['amount'], 'refund_completed_cents': succeeded,
        'refund_ids': refund_ids, 'refund_movement_ids': refund_movement_ids,
        'refund_statuses': refund_statuses,
        'refund_failure_balance_transactions': refund_failure_evidence,
        'refund_balance_transactions': refund_evidence,
        'dispute_id': dispute_id, 'dispute_outstanding_cents': dispute_outstanding,
        'dispute_movement_ids': [row['id'] for row in dispute_evidence],
        'dispute_balance_transactions': dispute_evidence,
        'provider_event_id': event['id'], 'event_created': event_created,
        'issuance_proven': issuance_proven,
        'issuance_ref_kind': issuance_cursor.ref_kind if issuance_proven else None,
        'issuance_ref_id': issuance_cursor.ref_id if issuance_proven else None,
        'issued_m2z': str(issued_m2z) if issuance_proven else None,
        'cursor_refunded_m2z': str(issuance_cursor.refunded_m2z) if issuance_proven else None,
        'refund_target_m2z': str(refund_target) if issuance_proven else None,
        'target_m2z': str(target) if issuance_proven else None,
        'financial_mutation_enabled': bool(settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED)}
    if movement_error:
        plan['provider_movement_proven'] = False
        plan['movement_reason'] = movement_error
    else:
        plan['provider_movement_proven'] = True
    observation.update(provider_snapshot_complete=not bool(movement_error),
        refund_succeeded_cents=succeeded, refund_ids=refund_ids,
        refund_movement_ids=refund_movement_ids, refund_balance_transactions=refund_evidence,
        dispute_id=dispute_id,
        dispute_status=obj.get('status') if dispute_id else None,
        dispute_balance_transactions=dispute_evidence,
        provider_movement_proven=not movement_error)
    evidence = _record_financial_snapshot(owner_id=owner_id, signed_event=signed_event,
        observation=observation, plan=plan)
    if reason or movement_error:
        reason = reason or 'provider_movement_unproven'
        _record_financial_outcome(record=record, evidence=evidence,
            status='pending_resolution', reason=reason, plan=plan)
        if movement_error.startswith('provider_read_'):
            return EventOutcome('retry', movement_error, f'stripe-event:{record.pk}')
        return EventOutcome('pending_resolution', reason, f'stripe-event:{record.pk}')
    if not settings.STRIPE_FINANCIAL_RECONCILIATION_ENABLED:
        _record_financial_outcome(record=record, evidence=evidence, status='pending_resolution',
            reason='financial_reconciliation_disabled', plan=plan)
        return EventOutcome('pending_resolution', 'financial_reconciliation_disabled', f'stripe-event:{record.pk}')
    return _apply_financial_plan(record=record, evidence=evidence, owner_id=owner_id,
        cursor=issuance_cursor, plan={
        **plan,
        'refund_movement_ids': refund_movement_ids,
        'dispute_movement_ids': plan['dispute_movement_ids']})
