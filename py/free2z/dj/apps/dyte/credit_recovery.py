"""Durable authenticated PPV evidence; credits post only when the ledger permits."""
import logging
import time
from datetime import timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone

from dj.apps.economy.services import EconomicRefusal
from dj.apps.events.dispatch import create_durable_event
from dj.apps.jobs.logs import emit_json_line
from .models import PpvCreditObservation, PpvCreditDelivery
from .ppv_credits import settle_credit_delivery
from .recovery_db import recovery_database

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 12
BATCH_SIZE = 50
RECOVERY_BUDGET_SECONDS = 30


@recovery_database()
def capture_observation(*, admission_id, event_key, evidence):
    """Called only after webhook signature and canonical provider proof succeed."""
    observation, created = PpvCreditObservation.objects.get_or_create(
        provider_key=event_key, defaults={'admission_id':admission_id, 'evidence':evidence})
    semantic = lambda value: {k:v for k,v in value.items()
        if k not in ('provider_event_id', 'payload_sha256')}
    if not created and (observation.admission_id != admission_id
            or semantic(observation.evidence) != semantic(evidence)):
        raise EconomicRefusal('credit_observation_identity_conflict')
    return observation


def _post_observation(observation):
    from .views import claim_webhook_digest
    evidence = observation.evidence
    if not claim_webhook_digest(provider_event_id=evidence['provider_event_id'],
            event_type='meeting.participantLeft', endpoint='general',
            payload_sha256=evidence['payload_sha256'], business_event_key=observation.pk):
        if PpvCreditDelivery.objects.filter(provider_key=observation.pk,
                admission_id=observation.admission_id).exists():
            return
        raise EconomicRefusal('credit_delivery_claim_conflict')
    delivery = settle_credit_delivery(admission_id=observation.admission_id,
        event_key=observation.pk, evidence=evidence)
    admission = observation.admission
    amount = Decimal(delivery.creator_collected_m2z) / 1000
    create_durable_event(wake_up=False, type='PLATFORM_FEE', receiving_user_id=admission.viewer_id,
        amount=Decimal(delivery.platform_collected_m2z) / 1000)
    create_durable_event(wake_up=False, type='PAY_PER_VIEW_REVENUE', receiving_user_id=admission.host_id,
        contributor_id=admission.viewer_id, payee_id=admission.host_id, amount=amount)
    create_durable_event(wake_up=False, type='PAY_PER_VIEW_SPEND', receiving_user_id=admission.viewer_id,
        contributor_id=admission.viewer_id, payee_id=admission.host_id, amount=amount)


def attempt_observation(key, *, force=False, raise_failure=False, deadline=None, skip_locked=False):
    """One serialized attempt; failed claims/ledger/events roll back together."""
    failure = None
    with recovery_database(deadline=deadline):
        query = PpvCreditObservation.objects.select_for_update(skip_locked=skip_locked)
        if skip_locked:
            observation = query.filter(pk=key).first()
            if observation is None:
                return False
        else:
            observation = query.get(pk=key)
        if observation.completed_at is not None:
            return True
        if not force and (observation.review_required_at is not None
                or observation.next_retry_at > timezone.now()):
            return False
        observation.attempts += 1
        try:
            with transaction.atomic():
                _post_observation(observation)
        except Exception as exc:
            failure = exc
            # Record fixed classifications only, never provider payloads or SQL values.
            observation.last_error = ('recipient_credit_cap' if 'usage_daily_funding_limit' in str(exc)
                else 'claim_conflict' if str(exc) == 'credit_delivery_claim_conflict'
                else 'settlement_refused')
            if observation.attempts >= MAX_ATTEMPTS:
                observation.review_required_at = timezone.now()
            observation.next_retry_at = timezone.now() + timedelta(
                seconds=min(300 * 2 ** min(observation.attempts-1, 7), 21600))
            emit_json_line(logger, {'alert':'ppv_credit_recovery_required',
                'observation_key':observation.pk, 'reason':observation.last_error,
                'manual_review':observation.review_required_at is not None}, 'ERROR',
                'PPV credit recovery pending')
        else:
            observation.completed_at = timezone.now()
            observation.last_error = ''
        observation.save(update_fields=['attempts','completed_at','review_required_at','next_retry_at','last_error'])
    if failure is not None and raise_failure:
        raise failure
    return failure is None


def recover_credit_observations():
    """Bounded durable scan, independent of provider redelivery and queue retries."""
    deadline = time.monotonic() + RECOVERY_BUDGET_SECONDS
    # Report age before attempts can consume the batch budget.
    with recovery_database(deadline=deadline):
        stuck = PpvCreditObservation.objects.filter(completed_at__isnull=True,
            created_at__lte=timezone.now()-timedelta(hours=1)).aggregate(
                pending_count=Count('pk'), manual_review_count=Count('pk',
                    filter=Q(review_required_at__isnull=False)))
    if stuck['pending_count']:
        emit_json_line(logger, {'alert':'ppv_credit_recovery_required', 'reason':'stuck',
            **stuck}, 'ERROR', 'PPV credit evidence requires recovery')
    with recovery_database(deadline=deadline):
        # Skip unavailable rows before LIMIT, then release these selection
        # locks. Each attempt owns only its own row/financial transaction.
        keys = list(PpvCreditObservation.objects.select_for_update(skip_locked=True).filter(completed_at__isnull=True,
            review_required_at__isnull=True, next_retry_at__lte=timezone.now()).order_by(
            'next_retry_at','provider_key').values_list('pk',flat=True)[:BATCH_SIZE])
    for key in keys:
        if time.monotonic() >= deadline:
            raise TimeoutError('credit recovery budget exhausted')
        try:
            attempt_observation(key, deadline=deadline, skip_locked=True)
        except Exception:
            emit_json_line(logger, {
                'alert':'ppv_credit_recovery_required', 'observation_key':key,
                'reason':'recovery_unavailable'}, 'ERROR', 'PPV credit recovery unavailable')
    return len(keys)
