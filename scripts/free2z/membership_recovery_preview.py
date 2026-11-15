#!/usr/bin/env python3
"""Prepare and revalidate read-only historical membership recovery manifests.

Application job tables do not retain the exact SQL failure diagnostic. This
tool reports current conflicts; it cannot authorize or apply restoration.
"""
import argparse
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from uuid import UUID


MAX_JOBS = 50
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_SECONDS = 30
KIND = 'creator-membership-recovery-preview-v1'
DEPENDENCIES = [
    'reviewed_external_evidence_binding_original_exact_receiving_cap_refusal',
    'verified_original_actors_consent_cycle_and_rollback_evidence',
    'reviewed_transactional_zero_charge_recovery_writer',
]


def _default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, UUID):
        return str(value)
    raise ValueError('unsupported manifest value')


def _canonical(value):
    return json.dumps(value, default=_default, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _ids(values):
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_JOBS:
        raise ValueError(f'select between 1 and {MAX_JOBS} job ids')
    if any(type(pk) is not int or not 0 < pk < 2**63 for pk in values):
        raise ValueError('job ids must be positive bigint integers')
    return sorted(set(values))


def load_manifest(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate manifest field')
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError('nonfinite manifest JSON')

    with Path(path).open('rb') as source:
        raw = source.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ValueError('manifest byte bound exceeded')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError('invalid manifest JSON') from None
    validate_manifest(value)
    return value


def validate_manifest(value):
    fields = {'kind', 'mode', 'observed_at', 'job_ids', 'cohort_id', 'decision_id',
              'rows', 'missing_dependencies', 'ordinary_period_seconds',
              'can_apply', 'receipt', 'revalidation', 'manifest_sha256'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('invalid manifest envelope')
    if (value['kind'] != KIND or value['mode'] != 'dry_run_only'
            or value['can_apply'] is not False
            or value['missing_dependencies'] != DEPENDENCIES):
        raise ValueError('manifest is not a blocked recovery preview')
    if _ids(value['job_ids']) != value['job_ids']:
        raise ValueError('manifest selectors are not canonical')
    rows = value['rows']
    if (not isinstance(rows, list) or len(rows) != len(value['job_ids'])
            or any(not isinstance(row, dict) for row in rows)
            or [row.get('job_id') for row in rows] != value['job_ids']):
        raise ValueError('invalid manifest row selectors')
    if any(row.get('original_refusal') != 'unverified' for row in rows):
        raise ValueError('a preview cannot contain a verified refusal claim')
    before = _digest(rows)
    cohort = _digest({'kind': KIND, 'job_ids': value['job_ids']})
    decision = _digest({'cohort_id': cohort, 'snapshot': before})
    if (value['cohort_id'] != cohort or value['decision_id'] != decision
            or value['receipt'] != {
                'transaction_read_only': True, 'mutations_performed': False,
                'before_snapshot': before, 'after_snapshot': before}):
        raise ValueError('invalid manifest snapshot identity or receipt')
    body = {key: item for key, item in value.items() if key != 'manifest_sha256'}
    if value['manifest_sha256'] != _digest(body):
        raise ValueError('manifest fingerprint mismatch')


def _snapshot(job_ids, as_of, deadline):
    from django.db.models.expressions import RawSQL
    from django.db.models import JSONField
    from procrastinate.contrib.django.models import ProcrastinateJob
    from dj.apps.events.models import Event
    from dj.apps.g12f.models import Subscription
    from dj.apps.g12f.tasks import renewal_queueing_lock
    from dj.apps.jobs.ops import ProcrastinateEvent
    from dj.apps.ledger.models import Account, Transfer

    rows = []
    for job_id in job_ids:
        if time.monotonic() > deadline:
            raise ValueError('preview time budget exceeded')
        row = {'job_id': job_id, 'conflicts': [], 'original_refusal': 'unverified'}
        conflicts = row['conflicts']
        # Bound the argument read and never echo arbitrary task payloads.
        job = ProcrastinateJob.objects.filter(pk=job_id).annotate(
            bounded_args=RawSQL(
                'CASE WHEN octet_length(args::text) <= 4096 THEN args ELSE NULL END',
                [], output_field=JSONField(),
            ),
        ).values('id', 'task_name', 'queue_name', 'status', 'attempts',
                 'scheduled_at', 'queueing_lock', 'bounded_args').first()
        row['job'] = job
        rows.append(row)
        if job is None:
            conflicts.append('job_missing')
            continue
        args = job.pop('bounded_args')
        if job['task_name'] != 'g12f.renew_subscription' or job['queue_name'] != 'billing':
            conflicts.append('not_billing_membership_renewal')
            continue
        if job['status'] != 'failed':
            conflicts.append('job_not_terminal_failed')
        if (not isinstance(args, dict) or set(args) != {'subscription_id'}
                or type(args['subscription_id']) is not int
                or not 0 < args['subscription_id'] < 2**63):
            conflicts.append('invalid_or_oversized_subscription_selector')
            continue
        job['subscription_id'] = args['subscription_id']
        failure = ProcrastinateEvent.objects.filter(job_id=job_id, type='failed').order_by(
            '-id').values('id', 'at').first()
        row['failure_event'] = failure
        history_start = ProcrastinateEvent.objects.filter(job_id=job_id).order_by(
            'id').values('id', 'type', 'at').first()
        row['history_start_event'] = history_start
        if failure is None or failure['at'] is None:
            conflicts.append('terminal_failure_time_unavailable')
        sub = Subscription.objects.select_related('fan', 'star').filter(
            pk=args['subscription_id']).first()
        row['membership'] = None
        if sub is None:
            conflicts.append('subscription_missing')
            continue
        row['membership'] = {
            'id': sub.pk, 'fan_id': sub.fan_id, 'star_id': sub.star_id,
            'expires': sub.expires, 'max_price': sub.max_price,
            'last_charged_at': sub.last_charged_at,
            'fan_active': sub.fan.is_active, 'star_active': sub.star.is_active,
            'fan_epoch': sub.fan.kt_account_epoch, 'star_epoch': sub.star.kt_account_epoch,
            'current_member_price': sub.star.member_price,
        }
        if not sub.fan.is_active:
            conflicts.append('inactive_fan')
        if not sub.star.is_active:
            conflicts.append('inactive_creator')
        if sub.max_price <= 0:
            conflicts.append('recurring_consent_cancelled')
        if sub.star.member_price > sub.max_price:
            conflicts.append('current_price_above_recurring_ceiling')
        if sub.expires >= as_of:
            conflicts.append('current_entitlement_active')
        if job['queueing_lock'] != renewal_queueing_lock(sub.pk, sub.expires):
            conflicts.append('original_cycle_unverified_or_current_expiry_changed')
        row['other_live_jobs'] = list(ProcrastinateJob.objects.filter(
            task_name='g12f.renew_subscription', args={'subscription_id': sub.pk},
            status__in=['todo', 'doing'],
        ).order_by('pk').values('id', 'status', 'scheduled_at', 'queueing_lock')[:3])
        if row['other_live_jobs']:
            conflicts.append('renewal_job_pending_or_running')
        if history_start and history_start['at']:
            # A purchase can precede the final failed attempt. Conservatively
            # check from the oldest retained event, never just the last failure.
            # This boundary still does not prove the original refusal time.
            since = history_start['at']
            if sub.last_charged_at and sub.last_charged_at >= since:
                conflicts.append('charge_in_retained_job_history')
            row['later_payment_event'] = Event.objects.filter(
                type__in=['SUBSCRIPTION_RECEIVED', 'SUBSCRIPTION_SENT'],
                contributor_id=sub.fan_id, payee_id=sub.star_id,
                amount__gt=0, created_at__gte=since,
            ).order_by('-created_at', '-pk').values('id', 'type', 'created_at').first()
            if row['later_payment_event']:
                conflicts.append('payment_in_retained_job_history')
            row['later_subscription_transfer'] = Transfer.objects.filter(
                debit_account_id__in=Account.objects.filter(owner_id=sub.fan_id).values('pk'),
                ref_kind='subscription', created_at__gte=since,
            ).order_by('-created_at', '-pk').values('id', 'created_at').first()
            if row['later_subscription_transfer']:
                conflicts.append('subscription_transfer_in_retained_job_history')
            row['later_continuation'] = sub.zero_charge_continuations.filter(
                recorded_at__gte=since,
            ).order_by('-pk').values('id', 'period_start', 'period_end').first()
            if row['later_continuation']:
                conflicts.append('continuation_in_retained_job_history')
    return json.loads(_canonical(rows))


def preview(job_ids=None, *, previous=None):
    from django.db import connection, transaction
    from dj.apps.g12f.models.creator import SUBSCRIPTION_PERIOD

    if previous is not None:
        validate_manifest(previous)
        if job_ids is not None:
            raise ValueError('revalidation uses the manifest selectors only')
        job_ids = previous['job_ids']
    selected = _ids(job_ids)
    if connection.vendor != 'postgresql' or connection.in_atomic_block:
        raise ValueError('preview requires an outermost PostgreSQL read-only transaction')
    deadline = time.monotonic() + MAX_SECONDS
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            cursor.execute("SET LOCAL statement_timeout = '5s'")
            cursor.execute('SELECT statement_timestamp(), current_setting(%s), current_setting(%s)',
                           ['transaction_read_only', 'transaction_isolation'])
            as_of, read_only, isolation = cursor.fetchone()
        if (read_only, isolation) != ('on', 'repeatable read'):
            raise ValueError('read-only snapshot isolation unavailable')
        rows = _snapshot(selected, as_of, deadline)
        before = _digest(rows)
        after = _digest(_snapshot(selected, as_of, deadline))
        if before != after:
            raise ValueError('read-only snapshot changed during preview')
    cohort_id = _digest({'kind': KIND, 'job_ids': selected})
    decision_id = _digest({'cohort_id': cohort_id, 'snapshot': before})
    result = {
        'kind': KIND, 'mode': 'dry_run_only', 'observed_at': as_of.isoformat(),
        'job_ids': selected, 'cohort_id': cohort_id, 'decision_id': decision_id,
        'rows': rows, 'missing_dependencies': list(DEPENDENCIES), 'can_apply': False,
        'ordinary_period_seconds': int(SUBSCRIPTION_PERIOD.total_seconds()),
        'receipt': {'transaction_read_only': True, 'mutations_performed': False,
                    'before_snapshot': before, 'after_snapshot': after},
        'revalidation': ({'previous_manifest': previous['manifest_sha256'],
                          'stale': previous['decision_id'] != decision_id,
                          'changed_job_ids': [row['job_id'] for row, prior in zip(
                              rows, previous['rows']) if row != prior]}
                         if previous is not None else None),
    }
    result['manifest_sha256'] = _digest(result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--job-id', action='append', type=int)
    source.add_argument('--revalidate', type=Path)
    options = parser.parse_args(argv)
    try:
        previous = load_manifest(options.revalidate) if options.revalidate else None
        if previous is None:
            _ids(options.job_id)
        if not os.environ.get('DJANGO_SETTINGS_MODULE'):
            raise ValueError('set DJANGO_SETTINGS_MODULE explicitly')
        # App startup inherits worker settings and can clear its heartbeat
        # markers. Give this standalone reader process-private paths first.
        markers = ('PROCRASTINATE_ALIVE_FILE', 'PROCRASTINATE_DRAINING_FILE')
        prior = {name: os.environ.get(name) for name in markers}
        with tempfile.TemporaryDirectory(prefix='membership-recovery-preview-') as state:
            try:
                for name in markers:
                    os.environ[name] = str(Path(state) / name)
                import django
                django.setup()
                result = preview(options.job_id, previous=previous)
            finally:
                for name, value in prior.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value
    except ValueError as error:
        parser.error(f'preview refused: {error}; no recovery applied')
    except OSError:
        parser.error('preview manifest could not be read; no recovery applied')
    print(_canonical(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
