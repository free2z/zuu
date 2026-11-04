"""Audited, JobManager-only operator actions for Procrastinate jobs."""
from __future__ import annotations

import copy
import json
import logging
import os
import socket
from datetime import timedelta
from typing import Any

from asgiref.sync import async_to_sync
from django.conf import settings
from django.db import models, transaction
from django.db.models import OuterRef, Subquery
from django.utils import timezone
from procrastinate.contrib.django import app
from procrastinate.contrib.django.models import ProcrastinateJob
from procrastinate.jobs import Status

from . import reclaim, reclaim_policy
from .logs import emit_json_line
from .models import (JobLease, OperatorAction, ParkedJob, QueueControl,
                     QuarantinedJob)

logger = logging.getLogger(__name__)

# These tasks use `context.job.id` as an external side-effect dedupe key. A
# drain/resume creates a new Procrastinate id, so an already-attempted task
# cannot safely be copied without risking a second broadcast.
DRAIN_UNSAFE_ATTEMPTED_TASKS = frozenset({
    'g12f.notify_published_zpage',
})


class ProcrastinateEvent(models.Model):
    """Read-only mapping of procrastinate's pinned event table."""

    id = models.BigAutoField(primary_key=True)
    job_id = models.BigIntegerField()
    type = models.CharField(max_length=32)
    at = models.DateTimeField(null=True)

    class Meta:
        managed = False
        db_table = 'procrastinate_events'


def actor_name() -> str:
    return (os.environ.get('JOBS_OPERATOR') or os.environ.get('USER')
            or os.environ.get('HOSTNAME') or socket.gethostname())


def _manager():
    return app.job_manager


def _job_payload(job) -> dict[str, Any]:
    return {
        'id': job.id,
        'task': job.task_name,
        'queue': job.queue,
        'status': job.status,
        'priority': job.priority,
        'lock': job.lock,
        'queueing_lock': job.queueing_lock,
        'scheduled_at': job.scheduled_at,
        'attempts': job.attempts,
        'args': _job_args(job),
    }


def _job_args(job) -> dict[str, Any]:
    """Normalize the pinned connector's JSONB value for `Task.defer`."""
    args = job.task_kwargs
    if isinstance(args, str):
        args = json.loads(args)
    if not isinstance(args, dict):
        raise ValueError(f'job {job.id} args are not a JSON object')
    return args


def _events(job_id: int) -> list[dict[str, Any]]:
    return list(ProcrastinateEvent.objects.filter(job_id=job_id)
                .order_by('at', 'id').values('type', 'at'))


def _billing_queues() -> frozenset[str]:
    # `billing` is a protected lane even in minimal/test settings which omit
    # JOB_HEALTH_BILLING_QUEUES. Parked aliases retain the same protection.
    return frozenset({'billing', *getattr(settings,
                                         'JOB_HEALTH_BILLING_QUEUES', ())})


def _base_queue(queue: str) -> str:
    while queue.startswith('paused.'):
        queue = queue[len('paused.'):]
    return queue


def _guard_money(jobs, money: bool) -> None:
    queues = sorted({_base_queue(job if isinstance(job, str) else job.queue)
                     for job in jobs} & _billing_queues())
    if queues and not money:
        raise ValueError(
            'billing queue mutation refused without --money: '
            + ', '.join(queues))


def _audit(verb: str, ids: list[int], reason: str) -> None:
    actor = actor_name()
    action = OperatorAction.objects.create(
        actor=actor, verb=verb, job_ids=ids, reason=reason,
        dry_run=False, at=timezone.now())
    payload = {'event': 'procrastinate_operator_action',
               'action_id': action.pk, 'actor': actor, 'verb': verb,
               'job_ids': ids, 'reason': reason, 'dry_run': False}
    transaction.on_commit(lambda: emit_json_line(
        logger, payload, 'INFO',
        f'procrastinate operator action={verb} ids={ids}'))


def _require_mutation(execute: bool, reason: str | None) -> None:
    if execute and (not reason or not reason.strip()):
        raise ValueError('--execute requires a non-empty --reason')


def _select_jobs(*, ids: list[int] | None = None, queue: str | None = None,
                 task: str | None = None, status: str | None = None,
                 older_than: int | None = None, limit: int | None = None):
    if limit is not None and limit < 1:
        raise ValueError('--limit must be positive')
    if ids is not None:
        jobs = [job for job_id in dict.fromkeys(ids)
                for job in _manager().list_jobs(id=job_id)]
        if status is not None:
            jobs = [job for job in jobs if job.status == status]
        if queue is not None:
            jobs = [job for job in jobs if job.queue == queue]
        if task is not None:
            jobs = [job for job in jobs if job.task_name == task]
    else:
        # Bound the read in SQL. JobManager.list_jobs has no LIMIT, so
        # listing first and slicing afterwards materialises the whole history
        # (every succeeded row) into a 512Mi operator pod for `--limit 50`.
        # Only ids are selected here; rows are still read via JobManager.
        rows = ProcrastinateJob.objects.all()
        if queue is not None:
            rows = rows.filter(queue_name=queue)
        if task is not None:
            rows = rows.filter(task_name=task)
        if status is not None:
            rows = rows.filter(status=status)
        if older_than is not None:
            latest_event = ProcrastinateEvent.objects.filter(
                job_id=OuterRef('pk')).order_by('-at', '-id').values('at')[:1]
            rows = rows.annotate(latest_event_at=Subquery(latest_event)).filter(
                latest_event_at__lt=timezone.now() - timedelta(seconds=older_than))
        rows = rows.order_by('id').values_list('id', flat=True)
        selected = list(rows[:limit] if limit is not None else rows)
        return [job for job_id in selected
                for job in _manager().list_jobs(id=job_id)]
    if older_than is not None:
        cutoff = timezone.now() - timedelta(seconds=older_than)
        jobs = [job for job in jobs
                if (event := ProcrastinateEvent.objects.filter(
                    job_id=job.id).order_by('-at', '-id').first())
                and event.at and event.at < cutoff]
    jobs.sort(key=lambda job: job.id)
    return jobs[:limit] if limit is not None else jobs


def _locked_job(job_id: int):
    """Lock the current row, then read its state through JobManager."""
    if ProcrastinateJob.objects.select_for_update().filter(pk=job_id).first() is None:
        return None
    matches = _manager().list_jobs(id=job_id)
    return matches[0] if matches else None


def list_jobs(*, queue=None, task=None, status=None, older_than=None, limit=None):
    return [_job_payload(job) for job in _select_jobs(
        queue=queue, task=task, status=status,
        older_than=older_than, limit=limit)]


def inspect_job(job_id: int) -> dict[str, Any] | None:
    matches = _manager().list_jobs(id=job_id)
    if not matches:
        return None
    job = matches[0]
    lease = JobLease.objects.filter(job_id=job_id).first()
    policy = reclaim_policy.policy_for(job.task_name)
    floor = reclaim.reclaim_threshold_seconds()
    margin = int(settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS)
    heartbeat = float(settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS)
    age_candidates = async_to_sync(_manager().get_stalled_jobs)(nb_seconds=floor)
    orphan_candidates = async_to_sync(_manager().get_stalled_jobs)(
        seconds_since_heartbeat=heartbeat)
    aged_ids = {candidate.id for candidate in age_candidates}
    orphaned_ids = {candidate.id for candidate in orphan_candidates}
    decision_data = async_to_sync(reclaim.reclaim_decision)(
        job, floor=floor, margin=margin, heartbeat_seconds=heartbeat,
        max_reclaims=int(settings.JOB_RECLAIM_MAX_RECLAIMS))
    decision = decision_data['reason']
    if decision == 'never_reclaimed':
        decision = 'never_reclaimed: ' + policy.reason
    return {
        'job': _job_payload(job),
        'events': _events(job_id),
        'lease': ({'pod': lease.pod, 'worker': lease.worker_name,
                   'last_beat_at': lease.last_beat_at,
                   'deadline_at': lease.deadline_at} if lease else None),
        'policy': ({'effect': 'never' if policy.max_runtime_seconds is None
                    else 'requeue_if_stalled',
                    'budget_seconds': policy.max_runtime_seconds,
                    'evidence': policy.reason} if policy else None),
        'reclaimer': {'would_reclaim': decision_data['reason'] in ('eligible', 'would_mark_failed'),
                      'reason': decision, 'threshold_seconds': decision_data.get('required'),
                      'floor_seconds': floor, 'margin_seconds': margin,
                      'orphaned': job_id in orphaned_ids,
                      'aged': job_id in aged_ids},
    }


def _defer_copy(job, *, queue: str, schedule_at=None) -> int:
    return _defer_configured(
        job.task_name, queue=queue, priority=job.priority,
        lock=job.lock, queueing_lock=job.queueing_lock,
        schedule_at=(schedule_at if schedule_at is not None else job.scheduled_at),
        args=_job_args(job))


def _defer_configured(task_name, *, queue, priority, lock, queueing_lock,
                      schedule_at, args):
    # Task.configure(None) means “inherit the task default”, not “clear it”.
    # A private shallow copy gives the pinned public Task.configure/defer API
    # the exact persisted defaults, including explicit NULL locks, without
    # changing the live task registry or bypassing Task.defer.
    task = copy.copy(app.tasks[task_name])
    task.queue = queue
    task.priority = priority
    task.lock = lock
    task.queueing_lock = queueing_lock
    return task.configure(
        queue=queue, priority=priority, lock=lock, queueing_lock=queueing_lock,
        schedule_at=schedule_at,
    ).defer(**args)


def _record_row_action(verb: str, job_ids: int | list[int], reason: str) -> None:
    _audit(verb, job_ids if isinstance(job_ids, list) else [job_ids], reason)


def _error_text(exc: Exception) -> str:
    constraint = (getattr(exc, 'constraint_name', None)
                  or getattr(getattr(exc, 'diag', None), 'constraint_name', None))
    if constraint == 'procrastinate_jobs_queueing_lock_idx_v1':
        return f'queueing_lock collision ({constraint})'
    return f'{type(exc).__name__}: {exc}'


def requeue(*, ids=None, task=None, status='failed', older_than=None,
            limit=None, execute=False, reason=None, money=False,
            from_quarantine=False):
    _require_mutation(execute, reason)
    if not ids and limit is None:
        raise ValueError('--limit is required for selector-based requeue')
    requested_ids = list(dict.fromkeys(ids)) if ids is not None else None
    if from_quarantine:
        quarantined_ids = set(QuarantinedJob.objects.filter(
            requeued_at__isnull=True).values_list('job_id', flat=True))
        if ids is not None:
            ids = [job_id for job_id in dict.fromkeys(ids)
                   if job_id in quarantined_ids]
        else:
            ids = sorted(quarantined_ids)
        status = 'failed'
    jobs = _select_jobs(ids=ids, task=task, status=status,
                        older_than=older_than, limit=limit)
    _guard_money(jobs, money)
    output = []
    if requested_ids is not None:
        allowed_ids = set(ids or [])
        by_id = {job.id: job for job in jobs}
        iterations = [(job_id, by_id.get(job_id) if job_id in allowed_ids else None)
                      for job_id in requested_ids]
    else:
        iterations = [(job.id, job) for job in jobs]
    for job_id, job in iterations:
        if job is None:
            exists = bool(_manager().list_jobs(id=job_id))
            output.append({'id': job_id,
                           'result': 'ineligible' if exists else 'not_found'})
            continue
        row = {'id': job.id, 'status': job.status, 'queue': job.queue}
        if execute:
            try:
                with transaction.atomic():
                    fresh = _locked_job(job.id)
                    if (fresh is None or fresh.status != Status.FAILED.value
                            or (task and fresh.task_name != task)
                            or (status and fresh.status != status)
                            or (from_quarantine and not QuarantinedJob.objects.filter(
                                job_id=fresh.id, requeued_at__isnull=True).exists())):
                        raise RuntimeError('job no longer matches the requeue selector')
                    if older_than is not None:
                        event = ProcrastinateEvent.objects.filter(
                            job_id=fresh.id).order_by('-at', '-id').first()
                        if not event or not event.at or event.at > timezone.now() - timedelta(seconds=older_than):
                            raise RuntimeError('job no longer matches --older-than')
                    _guard_money([fresh], money)
                    _manager().retry_job_by_id(fresh.id, retry_at=timezone.now())
                    if from_quarantine:
                        changed = QuarantinedJob.objects.filter(
                            job_id=fresh.id, requeued_at__isnull=True).update(
                                requeued_at=timezone.now())
                        if not changed:
                            raise RuntimeError('quarantine record is no longer active')
                    _record_row_action('requeue', fresh.id, reason)
                row['result'] = 'requeued'
            except Exception as exc:  # one bad row must not stop the batch
                row['result'] = 'error'
                row['error'] = _error_text(exc)
        else:
            row['result'] = 'would_requeue'
        output.append(row)
    return output


def fail(*, ids, execute=False, reason=None, money=False):
    _require_mutation(execute, reason)
    jobs = _select_jobs(ids=ids)
    _guard_money(jobs, money)
    output = []
    by_id = {job.id: job for job in jobs}
    for job_id in dict.fromkeys(ids):
        job = by_id.get(job_id)
        if job is None:
            output.append({'id': job_id,
                           'result': 'not_found' if not _manager().list_jobs(id=job_id)
                           else 'ineligible'})
            continue
        row = {'id': job.id, 'status': job.status}
        if execute:
            try:
                with transaction.atomic():
                    fresh = _locked_job(job.id)
                    if fresh is None or fresh.status not in (
                            Status.TODO.value, Status.DOING.value):
                        row['result'] = 'ineligible'
                    else:
                        _guard_money([fresh], money)
                        async_to_sync(_manager().finish_job_by_id_async)(
                            fresh.id, Status.FAILED, False)
                        _record_row_action('fail', fresh.id, reason)
                        row['result'] = 'failed'
            except Exception as exc:
                row['result'] = 'error'
                row['error'] = f'{type(exc).__name__}: {exc}'
        else:
            row['result'] = 'would_fail' if job.status in ('todo', 'doing') else 'ineligible'
        output.append(row)
    return output


def cancel(*, ids, abort=False, execute=False, reason=None, money=False):
    _require_mutation(execute, reason)
    jobs = _select_jobs(ids=ids)
    _guard_money(jobs, money)
    output = []
    by_id = {job.id: job for job in jobs}
    for job_id in dict.fromkeys(ids):
        job = by_id.get(job_id)
        if job is None:
            output.append({'id': job_id,
                           'result': 'not_found' if not _manager().list_jobs(id=job_id)
                           else 'ineligible'})
            continue
        row = {'id': job.id, 'status': job.status}
        if execute:
            try:
                with transaction.atomic():
                    fresh = _locked_job(job.id)
                    if fresh is None:
                        changed = False
                    else:
                        _guard_money([fresh], money)
                        changed = _manager().cancel_job_by_id(fresh.id, abort=abort)
                    if changed:
                        _record_row_action('cancel', fresh.id, reason)
                row['result'] = 'cancelled' if changed else 'ineligible'
            except Exception as exc:
                row['result'] = 'error'
                row['error'] = f'{type(exc).__name__}: {exc}'
        else:
            row['result'] = 'would_abort' if abort and job.status == 'doing' else (
                'would_cancel' if job.status == 'todo' else 'ineligible')
        output.append(row)
    return output


def set_queue_paused(queue: str, *, paused: bool, reason: str | None = None,
                     execute=False, money=False, draining=False):
    _require_mutation(execute, reason if paused else reason or f'resume {queue}')
    _guard_money([queue], money)
    if not execute:
        return {'queue': queue, 'paused': paused, 'result': 'would_pause' if paused else 'would_resume'}
    actor = actor_name()
    with transaction.atomic():
        control, _ = QueueControl.objects.select_for_update().get_or_create(queue=queue)
        control.paused_at = timezone.now() if paused else None
        control.reason = reason or '' if paused else ''
        control.actor = actor if paused else ''
        control.draining = (control.draining or draining) if paused else False
        control.save(update_fields=['paused_at', 'reason', 'actor', 'draining'])
        _audit('pause' if paused else 'resume', [], reason or f'resume {queue}')
    return {'queue': queue, 'paused': paused, 'result': 'paused' if paused else 'resumed'}


def drain_queue(queue: str, *, limit: int, execute=False, reason=None, money=False):
    _require_mutation(execute, reason)
    if limit < 1:
        raise ValueError('--limit must be positive')
    selected_ids = list(ProcrastinateJob.objects.filter(
        queue_name=queue, status__in=[Status.TODO.value, Status.DOING.value]
    ).order_by('id').values_list('id', flat=True)[:limit])
    selected = [job for job_id in selected_ids
                for job in _manager().list_jobs(id=job_id)]
    jobs = [job for job in selected if job.status == Status.TODO.value]
    doing = [job for job in selected if job.status == Status.DOING.value]
    _guard_money([queue] + jobs + doing, money)
    result = {'queue': queue, 'todo': [], 'doing': []}
    for job in jobs:
        unsafe_attempted = (job.task_name in DRAIN_UNSAFE_ATTEMPTED_TASKS
                            and job.attempts > 0)
        row = {'id': job.id, 'task': job.task_name,
               'attempts': job.attempts,
               'result': 'would_refuse' if unsafe_attempted else 'would_park'}
        if unsafe_attempted:
            row['reason'] = (
                'drain/resume would change this task\'s job-id dedupe key')
        result['todo'].append(row)
    result['doing'] = [{'id': j.id, 'result': 'would_abort'} for j in doing]
    if not execute:
        return result
    # The queue-control lock serializes concurrent drains and resumes. The
    # pause commits before we inspect rows, so subsequent fetch gates omit it.
    set_queue_paused(queue, paused=True, reason=reason, execute=True,
                     money=money, draining=True)
    result['todo'], result['doing'] = [], []
    for job in doing:
        try:
            with transaction.atomic():
                fresh = _locked_job(job.id)
                if (fresh is None or fresh.status != Status.DOING.value
                        or fresh.queue != queue):
                    raise RuntimeError('job is no longer doing')
                _guard_money([fresh], money)
                changed = _manager().cancel_job_by_id(fresh.id, abort=True)
                if changed:
                    _record_row_action('drain_abort', fresh.id, reason)
            result['doing'].append({'id': job.id, 'result': 'abort_requested' if changed else 'ineligible'})
        except Exception as exc:
            result['doing'].append({'id': job.id, 'result': 'error', 'error': str(exc)})
    for job in jobs:
        if (job.task_name in DRAIN_UNSAFE_ATTEMPTED_TASKS
                and job.attempts > 0):
            result['todo'].append({
                'id': job.id, 'result': 'error',
                'error': (f'{job.task_name} has already been attempted; '
                          'drain/resume would change its job-id dedupe key'),
            })
            continue
        try:
            with transaction.atomic():
                fresh = _locked_job(job.id)
                if (fresh is None or fresh.status != Status.TODO.value
                        or fresh.queue != queue):
                    raise RuntimeError('job is no longer todo')
                if (fresh.task_name in DRAIN_UNSAFE_ATTEMPTED_TASKS
                        and fresh.attempts > 0):
                    raise RuntimeError(
                        f'{fresh.task_name} has already been attempted; '
                        'drain/resume would change its job-id dedupe key')
                _guard_money([fresh], money)
                if not _manager().cancel_job_by_id(fresh.id):
                    raise RuntimeError('job is no longer todo')
                new_id = _defer_copy(fresh, queue=f'paused.{queue}')
                ParkedJob.objects.create(
                    source_job_id=fresh.id, parked_job_id=new_id,
                    task_name=fresh.task_name, queue=fresh.queue,
                    priority=fresh.priority, lock=fresh.lock,
                    queueing_lock=fresh.queueing_lock,
                    scheduled_at=fresh.scheduled_at, args=_job_args(fresh))
                _record_row_action('drain_park', [fresh.id, new_id], reason)
            result['todo'].append({'old_id': job.id, 'new_id': new_id, 'result': 'parked'})
        except Exception as exc:
            result['todo'].append({'id': job.id, 'result': 'error', 'error': str(exc)})
    with transaction.atomic():
        control, _ = QueueControl.objects.select_for_update().get_or_create(queue=queue)
        remaining = _manager().list_jobs(queue=queue, status='todo') or []
        active = _manager().list_jobs(queue=queue, status='doing') or []
        control.draining = bool(remaining or active or any(
            item.get('result') in ('error', 'not_found')
            for item in result['todo'] + result['doing']))
        control.save(update_fields=['draining'])
        result['remaining'] = len(remaining) + len(active)
        result['result'] = 'draining' if control.draining else 'drained'
    return result


def resume_queue(queue: str, *, limit: int, execute=False, reason=None, money=False):
    _require_mutation(execute, reason)
    if limit < 1:
        raise ValueError('--limit must be positive')
    parked = list(ParkedJob.objects.filter(queue=queue)
                  .order_by('source_job_id')[:limit])
    _guard_money([queue] + [item.queue for item in parked], money)
    if not execute:
        return {'queue': queue, 'jobs': [
            {'old_id': p.source_job_id, 'new_id': p.parked_job_id,
             'result': 'would_restore'} for p in parked]}
    result = {'queue': queue, 'jobs': []}
    for item in parked:
        try:
            with transaction.atomic():
                control, _ = QueueControl.objects.select_for_update().get_or_create(queue=queue)
                if control.draining:
                    raise RuntimeError('queue drain is incomplete')
                item = ParkedJob.objects.select_for_update().get(pk=item.pk)
                fresh = _locked_job(item.parked_job_id)
                if fresh is None or fresh.status != Status.TODO.value:
                    raise RuntimeError('parked job is no longer todo')
                _guard_money([queue, fresh.queue], money)
                if not _manager().cancel_job_by_id(fresh.id):
                    raise RuntimeError('parked job is no longer todo')
                new_id = _defer_configured(
                    item.task_name, queue=item.queue, priority=item.priority,
                    lock=item.lock, queueing_lock=item.queueing_lock,
                    schedule_at=item.scheduled_at, args=item.args)
                _record_row_action(
                    'resume_job',
                    [item.source_job_id, item.parked_job_id, new_id], reason)
                item.delete()
            result['jobs'].append({'old_id': item.source_job_id,
                                   'parked_id': item.parked_job_id,
                                   'new_id': new_id, 'result': 'restored'})
        except Exception as exc:
            result['jobs'].append({'old_id': item.source_job_id,
                                   'parked_id': item.parked_job_id,
                                   'result': 'error', 'error': str(exc)})
    with transaction.atomic():
        control, _ = QueueControl.objects.select_for_update().get_or_create(queue=queue)
        remaining = ParkedJob.objects.filter(queue=queue).exists()
        if control.draining:
            result['result'] = 'error'
            result['error'] = 'queue drain is incomplete; rerun drain first'
            result['remaining'] = ParkedJob.objects.filter(queue=queue).count()
        elif remaining or any(item['result'] == 'error'
                              for item in result['jobs']):
            result['remaining'] = ParkedJob.objects.filter(queue=queue).count()
            result['result'] = 'partial'
        else:
            control.paused_at = None
            control.reason = ''
            control.actor = ''
            control.save(update_fields=['paused_at', 'reason', 'actor'])
            _audit('resume', [], reason)
    return result


def prune(*, older_than_days: int, limit: int, execute=False, reason=None,
          money=False):
    _require_mutation(execute, reason)
    if older_than_days < 7:
        raise ValueError('--older-than must be at least 7 days')
    if limit < 1:
        raise ValueError('--limit must be positive')

    def eligible_ids(cutoff):
        latest_event = ProcrastinateEvent.objects.filter(
            job_id=OuterRef('pk')).order_by('-at', '-id').values('at')[:1]
        return list(ProcrastinateJob.objects.filter(
            status=Status.SUCCEEDED.value
        ).annotate(latest_event_at=Subquery(latest_event)).filter(
            latest_event_at__lt=cutoff
        ).order_by('id').values_list('id', flat=True)[:limit + 1])

    if not execute:
        cutoff = timezone.now() - timedelta(days=older_than_days)
        job_ids = eligible_ids(cutoff)
        if len(job_ids) > limit:
            raise ValueError(f'{len(job_ids)} succeeded jobs qualify, exceeding --limit {limit}')
        jobs = _select_jobs(ids=job_ids)
        _guard_money(jobs, money)
        return {'older_than_days': older_than_days, 'job_ids': job_ids,
                'result': 'would_prune'}

    with transaction.atomic():
        # Postgres transaction_timestamp is also NOW() inside the pinned
        # delete_old_jobs query. Locks bind the approved set against a new
        # completion while the JobManager procedure runs.
        from django.db import connection
        with connection.cursor() as cursor:
            cursor.execute('SELECT transaction_timestamp()')
            transaction_now = cursor.fetchone()[0]
        cutoff = transaction_now - timedelta(days=older_than_days)
        job_ids = eligible_ids(cutoff)
        if len(job_ids) > limit:
            raise ValueError(f'{len(job_ids)} succeeded jobs qualify, exceeding --limit {limit}')
        list(ProcrastinateJob.objects.select_for_update()
             .filter(pk__in=job_ids).order_by('id').values_list('id', flat=True))
        # Re-read status/events after acquiring row locks. This is still a
        # JobManager read and the only deletion remains delete_old_jobs.
        locked_ids = eligible_ids(cutoff)
        if locked_ids != job_ids:
            raise RuntimeError('prune eligible set changed while locking')
        jobs = _select_jobs(ids=job_ids)
        _guard_money(jobs, money)
        _audit('prune', job_ids, reason)
        async_to_sync(_manager().delete_old_jobs)(nb_hours=older_than_days * 24)
    return {'older_than_days': older_than_days, 'job_ids': job_ids,
            'result': 'pruned'}


def operator_list(*args, **kwargs):
    return json.dumps(list_jobs(*args, **kwargs), default=str, indent=2)
