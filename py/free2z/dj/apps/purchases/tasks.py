"""Scheduled write cleanup for original, unused ZEC purchase instructions."""
import logging
from time import monotonic
from datetime import timezone as dt_timezone

from django.db import DatabaseError, connection, transaction
from django.db.models import Case, F, Q, TextField, When
from django.db.models.fields.json import KeyTextTransform
from django.utils import timezone
from procrastinate import RetryStrategy
from procrastinate.contrib.django import app


@app.task(name='purchases.expire_zec_intent', queue='billing',
          retry=RetryStrategy(max_attempts=12, linear_wait=60))
def expire_zec_intent(purchase_id: str):
    """Release only unobserved expired capacity; failures retain the hold.

    Economic fences and database failures propagate to bounded job retries.
    Duplicate runs and timely observed payments are harmless no-ops. No
    provider IO occurs, and the next authenticated purchase is a write backup.
    """
    from .models import PurchaseIntent, Rail
    from .services import expire_if_due
    intent = PurchaseIntent.objects.filter(pk=purchase_id, rail=Rail.ZEC).first()
    if intent is not None:
        expire_if_due(intent)


logger = logging.getLogger(__name__)
EXPIRY_BATCH_SIZE = 50
EXPIRY_TICK_SECONDS = 30


def _sqlstate(exc):
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        state = getattr(exc, 'sqlstate', None)
        if state:
            return state
        exc = exc.__cause__ or exc.__context__
    return None


@app.periodic(cron='* * * * *')
@app.task(name='purchases.reconcile_zec_expiry', queue='billing', retry=False,
          queueing_lock='purchases-zec-expiry-reconcile')
def reconcile_zec_expiry(timestamp: int | None = None):
    """Repair missing, killed or exhausted deadline jobs from original rows.

    A finite batch and short per-row waits keep a locked old instruction from
    blocking later buyers. Each failed row keeps its capacity and original
    reference; the next tick retries it. This never calls a payment provider.
    """
    from dj.apps.economy.epoch import is_explicit_policy_refusal, pin_supported_policy
    from .models import EXPIRABLE_STATUSES, PurchaseIntent, Rail
    from .services import expire_if_due
    deadline = monotonic() + EXPIRY_TICK_SECONDS
    result = {'expired': 0, 'deferred': 0, 'attempted': 0, 'fenced': False, 'budget_exhausted': False}
    stamp = timezone.now().astimezone(dt_timezone.utc).isoformat()
    # This is nonfinancial retry scheduling. Commit/release every intent lock
    # before cleanup acquires any actor/account lock. Selection rotates even
    # when the worker dies or its budget expires before processing the batch.
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '1s'")
            cursor.execute("SET LOCAL statement_timeout = '5s'")
            pin_supported_policy()
            candidates = PurchaseIntent.objects.filter(rail=Rail.ZEC,
                status__in=EXPIRABLE_STATUSES, expires_at__lte=timezone.now()).filter(
                Q(rail_data__payment_observed=False) | Q(rail_data__payment_observed__isnull=True)
            ).annotate(previous_attempt=KeyTextTransform('expiry_cleanup_attempted_at', 'rail_data'))
            # Never cast legacy metadata: malformed/future values are treated
            # as unattempted instead of poisoning or indefinitely hiding rows.
            candidates = candidates.annotate(expiry_priority=Case(When(
                previous_attempt__regex=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$',
                previous_attempt__lte=stamp, then=F('previous_attempt')),
                default=None, output_field=TextField()))
            ids = list(candidates.order_by(F('expiry_priority').asc(nulls_first=True), 'expires_at', 'pk')
                .select_for_update(skip_locked=True).values_list('pk', flat=True)[:EXPIRY_BATCH_SIZE])
            if ids:
                cursor.execute("UPDATE purchases_purchaseintent SET rail_data=jsonb_set("
                    "rail_data,'{expiry_cleanup_attempted_at}',to_jsonb(%s::text),true) "
                    "WHERE id=ANY(%s::uuid[])", [stamp, [str(value) for value in ids]])
    except DatabaseError as exc:
        if not is_explicit_policy_refusal(exc):
            raise
        result['fenced'] = True
        logger.warning('ZEC expiry retry scan deferred by economic fence')
        return result
    for purchase_id in ids:
        if monotonic() >= deadline:
            result['budget_exhausted'] = True
            break
        result['attempted'] += 1
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout = '1s'")
                cursor.execute("SET LOCAL statement_timeout = '5s'")
                intent = PurchaseIntent.objects.get(pk=purchase_id)
                current = expire_if_due(intent)
                if current.status == 'expired':
                    result['expired'] += 1
        except PurchaseIntent.DoesNotExist:
            continue
        except DatabaseError as exc:
            if is_explicit_policy_refusal(exc):
                result['fenced'] = True
                result['deferred'] += 1
                logger.warning('ZEC expiry deferred by economic fence: purchase_id=%s', purchase_id)
                break
            if _sqlstate(exc) not in {'55P03', '57014', '40P01', '40001'}:
                raise
            result['deferred'] += 1
            logger.warning('ZEC expiry deferred: purchase_id=%s sqlstate=%s', purchase_id, _sqlstate(exc))
    return result
