"""Restore one ordinary term for historical funding-cap refusals.

Dry-run is the default. It locks, revalidates, rolls back, and prints one
JSON receipt. ``--apply`` writes only when ``MEMBERSHIP_RECOVERY_APPLY`` is
exactly ``1`` and ``--decision-id`` matches the file. Any conflict or a new
expiry that would still be in the past writes nothing.

The entitlement write is ``_continue_after_receiving_cap_refusal``. This
command does not debit, credit, or accept a caller-supplied SQLSTATE.
Real account identifiers stay outside the repository.
"""
import json
import logging
import os
import re
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

MAX_MEMBERSHIPS = 50
MAX_BYTES = 1024 * 1024
_DECISION_ID = re.compile(r'[A-Za-z0-9._-]{1,80}\Z')
_SHA256 = re.compile(r'[0-9a-fA-F]{64}\Z')
_MONEY = re.compile(r'-?\d{1,7}\Z')
_DECISION_KEYS = frozenset({'decision_id', 'evidence_sha256', 'memberships'})
_ROW_KEYS = frozenset({
    'subscription_id', 'fan_id', 'star_id', 'expires', 'last_charged_at', 'max_price',
})
_PAYMENT_EVENTS = ('SUBSCRIPTION_RECEIVED', 'SUBSCRIPTION_SENT')
_OPEN_RENEWAL = ('todo', 'doing')


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate JSON field')
        result[key] = value
    return result


def _nonfinite(_value):
    raise ValueError('nonfinite JSON')


def _bigint(value, label):
    if type(value) is not int or not 0 < value < 2**63:
        raise ValueError(f'{label} must be a positive integer')
    return value


def _money(value):
    if type(value) is int:
        text = str(value)
    elif type(value) is str:
        text = value
    else:
        raise ValueError('max_price must be an integer')
    if _MONEY.fullmatch(text) is None:
        raise ValueError('max_price must be an integer with at most 7 digits')
    return Decimal(text)


def _timestamp(value, label):
    if type(value) is not str or not value:
        raise ValueError(f'{label} must be an ISO-8601 timestamp')
    text = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f'{label} must be an ISO-8601 timestamp') from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f'{label} must include a timezone')
    return parsed


def _optional_timestamp(value, label):
    if value is None:
        return None
    return _timestamp(value, label)


def load_decision(path):
    """Read one bounded decision file. Raises ValueError when it is unusable."""
    file_path = Path(path)
    with file_path.open('rb') as source:
        raw = source.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('decision file exceeds 1 MiB')
    try:
        value = json.loads(
            raw, object_pairs_hook=_pairs, parse_constant=_nonfinite,
        )
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError('decision file is not JSON') from None
    if type(value) is not dict or set(value) != _DECISION_KEYS:
        raise ValueError('decision file fields are invalid')
    decision_id = value['decision_id']
    if type(decision_id) is not str or _DECISION_ID.fullmatch(decision_id) is None:
        raise ValueError('decision_id must be 1-80 characters of [A-Za-z0-9._-]')
    digest = value['evidence_sha256']
    if type(digest) is not str or _SHA256.fullmatch(digest) is None:
        raise ValueError('evidence_sha256 must be 64 hex characters')
    rows = value['memberships']
    if type(rows) is not list or not 1 <= len(rows) <= MAX_MEMBERSHIPS:
        raise ValueError(f'memberships must contain 1 to {MAX_MEMBERSHIPS} rows')
    memberships = []
    seen = set()
    for row in rows:
        if type(row) is not dict or set(row) != _ROW_KEYS:
            raise ValueError('membership fields are invalid')
        subscription_id = _bigint(row['subscription_id'], 'subscription_id')
        if subscription_id in seen:
            raise ValueError('duplicate subscription_id')
        seen.add(subscription_id)
        memberships.append({
            'subscription_id': subscription_id,
            'fan_id': _bigint(row['fan_id'], 'fan_id'),
            'star_id': _bigint(row['star_id'], 'star_id'),
            'expires': _timestamp(row['expires'], 'expires'),
            'last_charged_at': _optional_timestamp(
                row['last_charged_at'], 'last_charged_at',
            ),
            'max_price': _money(row['max_price']),
        })
    return {
        'decision_id': decision_id,
        'evidence_sha256': digest.lower(),
        'memberships': memberships,
    }


def _iso(value):
    if value is None:
        return None
    return value.isoformat()


def _money_text(value):
    if value is None:
        return None
    return format(value, 'f')


def _before(sub):
    if sub is None:
        return {
            'fan_id': None, 'star_id': None, 'expires': None,
            'last_charged_at': None, 'max_price': None,
        }
    return {
        'fan_id': sub.fan_id,
        'star_id': sub.star_id,
        'expires': _iso(sub.expires),
        'last_charged_at': _iso(sub.last_charged_at),
        'max_price': _money_text(sub.max_price),
    }


def _conflicts(sub, expected, now):
    """Current-state reasons this row must not be restored. Empty means eligible."""
    if sub is None:
        return ['subscription_missing']
    from dj.apps.events.models import Event
    from dj.apps.g12f.models import SubscriptionContinuation
    from dj.apps.g12f.models.creator import SUBSCRIPTION_PERIOD
    from dj.apps.ledger.models import Account, Transfer
    from procrastinate.contrib.django.models import ProcrastinateJob

    conflicts = []
    if sub.fan_id != expected['fan_id']:
        conflicts.append('fan_id_mismatch')
    if sub.star_id != expected['star_id']:
        conflicts.append('star_id_mismatch')
    if sub.expires != expected['expires']:
        conflicts.append('expires_mismatch')
    if sub.last_charged_at != expected['last_charged_at']:
        conflicts.append('last_charged_at_mismatch')
    if sub.max_price != expected['max_price']:
        conflicts.append('max_price_mismatch')
    if not sub.fan.is_active:
        conflicts.append('inactive_fan')
    if not sub.star.is_active:
        conflicts.append('inactive_creator')
    if sub.max_price is None or sub.max_price <= 0:
        conflicts.append('recurring_consent_cancelled')
    price = sub.star.member_price
    if price is None or price <= 0:
        conflicts.append('member_price_missing_or_nonpositive')
    elif sub.max_price is not None and price > sub.max_price:
        conflicts.append('current_price_above_recurring_ceiling')
    if sub.expires >= now:
        conflicts.append('current_entitlement_active')
    if sub.expires + SUBSCRIPTION_PERIOD <= now:
        conflicts.append('new_expiry_still_past')
    if SubscriptionContinuation.objects.filter(
            subscription_id=sub.pk, period_start=sub.expires,
    ).exists():
        conflicts.append('continuation_exists')
    if ProcrastinateJob.objects.filter(
            task_name='g12f.renew_subscription',
            args={'subscription_id': sub.pk},
            status__in=_OPEN_RENEWAL,
    ).exists():
        conflicts.append('renewal_job_pending_or_running')
    # No retained job history is available here. The decision row's expires
    # is the failed-cycle boundary, matching the preview's conservative
    # transfer and payment-event checks.
    boundary = expected['expires']
    charged_at = sub.last_charged_at
    if (charged_at is not None and (
            charged_at >= boundary or charged_at >= sub.expires)):
        conflicts.append('charge_at_or_after_cycle_boundary')
    if Event.objects.filter(
            type__in=_PAYMENT_EVENTS,
            contributor_id=sub.fan_id, payee_id=sub.star_id,
            amount__gt=0, created_at__gte=boundary,
    ).exists():
        conflicts.append('payment_event_at_or_after_cycle_boundary')
    fan_accounts = Account.objects.filter(owner_id=sub.fan_id).values('pk')
    if Transfer.objects.filter(
            debit_account_id__in=fan_accounts,
            ref_kind='subscription', created_at__gte=boundary,
    ).exists():
        conflicts.append('subscription_transfer_at_or_after_cycle_boundary')
    return conflicts


def execute(decision, *, apply):
    """Revalidate one cohort in one repeatable transaction.

    Returns ``(receipt, outcome)`` where outcome is ``dry_run``, ``applied``,
    or ``blocked``. Dry-run and blocked both roll back. Ledger or entitlement
    drift raises ``CommandError`` and rolls back.
    """
    from dj.apps.events.models import Event
    from dj.apps.g12f.models import Subscription, SubscriptionContinuation
    from dj.apps.g12f.models.creator import SUBSCRIPTION_PERIOD, Creator
    from dj.apps.g12f.tasks import RENEWAL_LEAD, _continue_after_receiving_cap_refusal
    from dj.apps.ledger.models import Transfer
    from dj.apps.tuzis import ledger

    if connection.vendor != 'postgresql':
        raise CommandError('PostgreSQL is required')
    if connection.in_atomic_block:
        raise CommandError('refusing to run inside an existing transaction')

    outcome = 'blocked'
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            cursor.execute("SET LOCAL lock_timeout = '3s'")
            cursor.execute("SET LOCAL statement_timeout = '15s'")
        now = timezone.now()
        memberships = decision['memberships']
        # Creators in primary-key order, then subscriptions in primary-key
        # order. ``of=('self',)`` keeps the join from locking actors again
        # in planner order. SELECT FOR UPDATE cannot run read-only, so a
        # dry run is a read-write transaction that rolls back.
        actor_ids = {row['fan_id'] for row in memberships}
        actor_ids.update(row['star_id'] for row in memberships)
        ledger.lock_in_order(*(Creator(pk=pk) for pk in actor_ids))
        locked = {}
        for row in sorted(memberships, key=lambda item: item['subscription_id']):
            subscription_id = row['subscription_id']
            locked[subscription_id] = (
                Subscription.objects.select_for_update(of=('self',))
                .select_related('fan', 'star')
                .filter(pk=subscription_id)
                .first()
            )
        prepared = []
        for expected in memberships:
            sub = locked[expected['subscription_id']]
            conflicts = _conflicts(sub, expected, now)
            before = _before(sub)
            planned = None if sub is None else sub.expires + SUBSCRIPTION_PERIOD
            prepared.append({
                'subscription_id': expected['subscription_id'],
                'eligible': not conflicts,
                'conflicts': conflicts,
                'before': before,
                'planned': planned,
                'sub': sub,
            })
        can_apply = all(row['eligible'] for row in prepared)
        receipt_rows = []
        for row in prepared:
            after = dict(row['before'])
            scheduled = None
            if row['eligible'] and can_apply:
                after['expires'] = _iso(row['planned'])
                scheduled = _iso(row['planned'] - RENEWAL_LEAD)
            receipt_rows.append({
                'subscription_id': row['subscription_id'],
                'eligible': row['eligible'],
                'conflicts': row['conflicts'],
                'before': row['before'],
                'after': after,
                'continuation_id': None,
                'scheduled_renewal_at': scheduled,
            })
        receipt = {
            'decision_id': decision['decision_id'],
            'evidence_sha256': decision['evidence_sha256'],
            'mode': 'apply' if apply else 'dry_run',
            'can_apply': can_apply,
            'applied': False,
            'ledger_rows_created': 0,
            'observed_at': _iso(now),
            'rows': receipt_rows,
        }
        if not apply or not can_apply:
            transaction.set_rollback(True)
            outcome = 'dry_run' if not apply else 'blocked'
        else:
            transfers_before = Transfer.objects.count()
            events_before = Event.objects.filter(type__in=_PAYMENT_EVENTS).count()
            by_id = {row['subscription_id']: row for row in receipt_rows}
            for row in sorted(prepared, key=lambda item: item['subscription_id']):
                sub = row['sub']
                old_expiry = sub.expires
                old_charged = sub.last_charged_at
                old_max = sub.max_price
                _continue_after_receiving_cap_refusal(sub, now)
                sub.refresh_from_db()
                if (sub.expires != old_expiry + SUBSCRIPTION_PERIOD
                        or sub.last_charged_at != old_charged
                        or sub.max_price != old_max):
                    raise CommandError(
                        'continuation changed a field it must not change')
                continuation_id = SubscriptionContinuation.objects.values_list(
                    'pk', flat=True,
                ).get(subscription_id=sub.pk, period_start=old_expiry)
                by_id[sub.pk]['continuation_id'] = continuation_id
                by_id[sub.pk]['after'] = _before(sub)
                by_id[sub.pk]['scheduled_renewal_at'] = _iso(
                    sub.expires - RENEWAL_LEAD)
            created = Transfer.objects.count() - transfers_before
            events_created = (
                Event.objects.filter(type__in=_PAYMENT_EVENTS).count()
                - events_before
            )
            receipt['ledger_rows_created'] = created
            if created != 0 or events_created != 0:
                raise CommandError(
                    'apply rolled back: a ledger or payment row was created')
            receipt['applied'] = True
            outcome = 'applied'
    return receipt, outcome


class Command(BaseCommand):
    help = (
        'Dry-run or apply one ordinary zero-charge term for a decision file '
        'of historical membership refusals.'
    )

    def add_arguments(self, parser):
        parser.add_argument('decision_file', type=Path)
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--decision-id', default=None)

    def handle(self, *args, **options):
        try:
            decision = load_decision(options['decision_file'])
        except ValueError as exc:
            raise CommandError(str(exc)) from None
        except OSError:
            raise CommandError('decision file could not be read') from None
        if options['apply']:
            if os.environ.get('MEMBERSHIP_RECOVERY_APPLY') != '1':
                raise CommandError(
                    'apply refused: MEMBERSHIP_RECOVERY_APPLY must be exactly 1')
            if options['decision_id'] != decision['decision_id']:
                raise CommandError(
                    'apply refused: --decision-id does not match the decision file')
        receipt, outcome = execute(decision, apply=options['apply'])
        self.stdout.write(json.dumps(receipt, indent=2, sort_keys=True))
        logger.info(
            'restore_refused_memberships decision %s outcome %s can_apply %s',
            decision['decision_id'], outcome, receipt['can_apply'],
        )
        if outcome == 'blocked':
            raise CommandError(
                'apply refused: a selected membership is not eligible; '
                'nothing written')
