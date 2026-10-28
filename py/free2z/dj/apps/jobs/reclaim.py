"""Lease-aware recovery of stalled Procrastinate jobs.

A normal orphan is a ``doing`` row at least
``JOB_RECLAIM_MIN_AGE_SECONDS`` old with both a lease older than
``JOB_LEASE_STALE_SECONDS`` and a stale (or pruned) worker heartbeat. The
independent signals avoid replaying a provider call when only the lease
beater stopped on a still-live worker. A lease's token- and attempt-scoped
phase, committed before body entry, identifies an abandoned acquisition;
legacy durable middleware markers in the quarantine table remain supported.
Only that evidence can bypass the worker heartbeat and estimated task runtime
gates. The pre-body phase permits a bounded retry of otherwise-``NEVER`` work;
an interrupted ``NEVER`` body stays excluded. If no lease exists, the worker
heartbeat must be stale (or its row pruned). A missing lease alone never proves
an attempt stopped.

A fresh lease past ``deadline_at`` is handled separately. The first sweep
persists an abort-request marker and asks Procrastinate to abort. A later sweep
fails the still-``doing`` row if the same lease remains past its deadline. The
lease compare-and-delete includes its token and last beat, so a beat or lease
replacement between observation and write wins. The persisted marker ensures
the abort request is a separate first sweep. Fencing cannot cancel a synchronous
external call already in progress, so task-level provider and money guards
remain load-bearing. The marker uses the existing quarantine table; it becomes
an ordinary quarantine record only when the job reaches FAILED.

The Django-connector path holds a transaction-scoped advisory lock for the
sweep. The production worker uses a separate bounded psycopg pool, so it must
not hold a Django transaction while querying that pool: behind a one-server
PgBouncer pool that self-deadlocks. Production instead uses a non-blocking
transaction-scoped advisory lock in each row transaction. The job-attempt
lock, lease compare-and-delete, quarantine update, and Procrastinate status
procedure share that pool connection and commit or roll back together. A
revived or replaced lease is left alone. Each row operation bounds pool wait,
checkout health I/O, transaction, and disposal under one client deadline. On
expiry its socket is shut down outside the psycopg mutex and the pool discards
the broken connection before the next candidate is processed.

Fencing stops a zombie's subsequent lease beat and prevents this worker
middleware from persisting this attempt's status. It cannot retract a provider
request already sent. Procrastinate's own ``finish_job`` from a zombie also
remains able to make a row terminal because its schema permits ``doing`` to
``todo``/terminal transitions without this lease token; the middleware logs
``event=procrastinate_lease_fenced`` and cannot re-run that row. External-effect
safety continues to depend on task-level provider and money guards. Reclaimable
tasks are idempotent **on state**, but ``g12f.translate_zpage``,
``search.index_zpage``, ``search.index_multilingual_zpage``, and
``g12f.detect_zpage_language`` can still repeat a billed provider request after
a real worker death. Current state and money checks protect only the specific
effects they implement; this branch cannot establish exactly-once provider
requests for those tasks, so a replay can still incur another provider charge.

Durations in this module are seconds. The per-task retry allowance and policy
registry are consumed unchanged.
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import socket
import threading
import warnings
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

from asgiref.sync import (
    AsyncToSync, ThreadSensitiveContext, async_to_sync, sync_to_async,
)
from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone
from procrastinate import sql

from procrastinate.contrib.django import app
from psycopg_pool import PoolTimeout
from procrastinate.jobs import Status

from dj.apps.jobs import lease_schema, reclaim_policy
from dj.apps.jobs.logs import emit_json_line
from dj.apps.jobs.models import JobLease, QuarantinedJob

logger = logging.getLogger(__name__)

_ACTIVE_SWEEP_CONNECTION = contextvars.ContextVar(
    'jobs_active_reclaim_sweep_connection', default=None)

# The lease middleware fails closed until the consumer/fence path is deployed.
READS_LEASES = True


def _tracked_sync_call(fn, *args, **kwargs):
    """Publish the Django socket before a synchronous query can block."""
    state = _ACTIVE_SWEEP_CONNECTION.get()
    if state is not None and state.get('active'):
        # The production pool path deliberately has no Django transaction,
        # but candidate discovery still reads leases, markers, and events via
        # Django's synchronous ORM. Register that connection with the sweep
        # watchdog before the query starts so a blackholed proxy is interruptible.
        connection.ensure_connection()
        raw_connection = connection.connection
        socket_fd = os.dup(raw_connection.fileno())
        with state['lock']:
            old_fd, state['socket_fd'] = state.get('socket_fd'), socket_fd
            state['connection'] = raw_connection
        if old_fd is not None:
            try:
                os.close(old_fd)
            except OSError:
                pass
    return fn(*args, **kwargs)


async def _tracked_sync_to_async(fn, *args, **kwargs):
    """Run one Django query with its raw socket enrolled in the watchdog."""
    return await sync_to_async(_tracked_sync_call)(fn, *args, **kwargs)


def _deadline_marker_reason(token) -> str:
    """Persist which lease generation received its deadline abort request."""
    return f'{DEADLINE_ABORT_REQUESTED}:{token}'


RECOVERY_MARKER_PREFIX = 'recovery abandoned attempt'


def _recovery_marker_reason(token, phase: str) -> str:
    """Name the abandoned lease generation and whether its body could run."""
    return f'{RECOVERY_MARKER_PREFIX} {phase}:{token}'


def _lease_token(lease):
    """Read the token from either an ORM values row or a pool tuple."""
    return lease['token'] if isinstance(lease, dict) else lease[0]


def _lease_field(lease, name: str, index: int):
    return lease.get(name) if isinstance(lease, dict) else lease[index]


def _locked_lease_sql(phase_columns: bool) -> str:
    """The locked lease read; NULL phase fields on the pre-0006 schema.

    Positions are fixed so ``_abandoned_phase`` reads either shape.
    """
    phase = ('phase, attempt, phase_token, phase_attempt' if phase_columns
             else 'NULL, attempt, NULL, NULL')
    return (f"SELECT token, last_beat_at, deadline_at, {phase} "
            "FROM jobs_joblease WHERE job_id=%s FOR UPDATE")


def _lease_value_fields(*fields: str) -> tuple[str, ...]:
    """ORM ``values()`` fields, plus the phase fields once they exist."""
    if lease_schema.available():
        return fields + lease_schema.PHASE_COLUMNS
    return fields


def _abandoned_phase(marker, lease, attempts: int) -> str | None:
    """Return durable, attempt-scoped evidence that this body's phase ended.

    The lease phase is written with acquisition and advanced before task code.
    Older deployments used a quarantine marker; retain its token/attempt
    validation while recognizing the new phase field directly.
    """
    if not lease:
        return None
    same_attempt = _lease_field(lease, 'attempt', 4) == attempts
    phase = _lease_field(lease, 'phase', 3)
    proof_matches = (
        _lease_field(lease, 'phase_token', 5) == _lease_token(lease)
        and _lease_field(lease, 'phase_attempt', 6) == attempts
    )
    if same_attempt and proof_matches and phase == 'before_body':
        return 'before_body'
    if not same_attempt or not marker or marker[1] != attempts:
        return None
    for phase in ('before_body', 'after_body'):
        if marker[0] == _recovery_marker_reason(_lease_token(lease), phase):
            # A new attempt can only move from before_body to body_started.
            # A late/ambiguous acquisition cleanup must not downgrade that
            # monotonic phase with an old-format before_body marker.
            if same_attempt and phase == 'before_body' \
                    and _lease_field(lease, 'phase', 3) == 'body_started':
                return None
            return phase
    return None


def _uses_worker_pool() -> bool:
    from procrastinate.psycopg_connector import PsycopgConnector

    return isinstance(app.job_manager.connector, PsycopgConnector)


def _locked_job_and_lease(cursor, job, *, expected_attempt):
    cursor.execute(
        "SELECT status, attempts, worker_id FROM procrastinate_jobs "
        "WHERE id=%s FOR UPDATE", [job.id])
    current = cursor.fetchone()
    if (current is None or current[0] != Status.DOING.value
            or current[1] != expected_attempt):
        return None, None
    cursor.execute(
        _locked_lease_sql(lease_schema.available_on_cursor(cursor)),
        [job.id])
    return current, cursor.fetchone()


def _put_quarantine(cursor, job, *, now, attempts, reason):
    cursor.execute(
        "INSERT INTO jobs_quarantined_job "
        "(job_id, task_name, queue, reason, attempts, quarantined_at, "
        "requeued_at) VALUES (%s, %s, %s, %s, %s, %s, NULL) "
        "ON CONFLICT (job_id) DO UPDATE SET task_name=EXCLUDED.task_name, "
        "queue=EXCLUDED.queue, reason=EXCLUDED.reason, "
        "attempts=EXCLUDED.attempts, quarantined_at=EXCLUDED.quarantined_at, "
        "requeued_at=NULL",
        [job.id, job.task_name, job.queue, reason, attempts, now])


def _fail_queued_export_after_prebody_exhaustion(
        cursor, job, *, attempts, abandoned_phase, now):
    """Release an export slot only for this proven, exhausted pre-body job.

    The marker was read while the procrastinate row and lease were locked. The
    extra predicates here keep the application row update in the same fenced
    transaction and make it a no-op for started exports, mismatched task args,
    and any non-queued export state.
    """
    if (job.task_name != 'exports.export_publication'
            or abandoned_phase != 'before_body'):
        return
    cursor.execute(
        "UPDATE exports_publicationexportjob AS export "
        "SET status='failed', "
        "error_message='Export could not start after repeated infrastructure failures.', "
        "updated_at=%s "
        "FROM procrastinate_jobs AS queue_job "
        "WHERE queue_job.id=%s AND queue_job.task_name=%s "
        "AND queue_job.status=%s AND queue_job.attempts=%s "
        "AND export.id::text = queue_job.args->>'job_id' "
        "AND export.status='queued'",
        [now, job.id, 'exports.export_publication',
         Status.DOING.value, attempts])


def _apply_action_sync(action, job, *, lease, now, attempts, stale_before,
                       reason=None, worker_stale_before=None,
                       recovery_phase=None):
    """Django-connector path; tests and non-worker commands use this seam."""
    worker_stale_before = worker_stale_before or now - timedelta(
        seconds=float(settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS))
    with transaction.atomic():
        with connection.cursor() as cursor:
            current, current_lease = _locked_job_and_lease(
                cursor, job, expected_attempt=attempts)
            if current is None:
                return 'attempt_changed'
            worker_heartbeat = None
            if current[2] is not None:
                cursor.execute(
                    "SELECT last_heartbeat FROM procrastinate_workers "
                    "WHERE id=%s FOR UPDATE", [current[2]])
                worker = cursor.fetchone()
                worker_heartbeat = worker[0] if worker else None
            cursor.execute(
                "SELECT reason, attempts FROM jobs_quarantined_job "
                "WHERE job_id=%s FOR UPDATE", [job.id])
            recovery_marker = cursor.fetchone()
            abandoned_phase = _abandoned_phase(
                recovery_marker, current_lease, attempts)
            if (recovery_phase == 'before_body'
                    and abandoned_phase != 'before_body'):
                return 'recovery_proof_changed'
            if (abandoned_phase is not None
                    and (current_lease is None
                         or current_lease[1] >= stale_before)):
                return 'lease_revived'
            if (action not in ('deadline_abort', 'deadline_failed')
                    and worker_heartbeat is not None
                    and worker_heartbeat >= worker_stale_before
                    and abandoned_phase is None):
                return 'worker_revived'
            if lease is None and current_lease is not None:
                return 'lease_revived'
            if action == 'deadline_abort':
                if (lease is None or current_lease is None
                        or current_lease[0] != lease['token']
                        or current_lease[1] != lease['last_beat_at']
                        or current_lease[2] is None
                        or current_lease[2] > now):
                    return 'lease_revived'
                cursor.execute(
                    "SELECT reason, attempts FROM jobs_quarantined_job "
                    "WHERE job_id=%s FOR UPDATE", [job.id])
                marker = cursor.fetchone()
                if marker == (_deadline_marker_reason(lease['token']), attempts):
                    return 'deadline_already_requested'
                requested = app.job_manager.cancel_job_by_id(
                    job.id, abort=True)
                if not requested:
                    return 'attempt_changed'
                _put_quarantine(
                    cursor, job, now=now, attempts=attempts,
                    reason=_deadline_marker_reason(lease['token']))
                return 'deadline_abort_requested'

            deadline_failure = action == 'deadline_failed'
            if lease is None:
                if current_lease is not None:
                    return 'lease_revived'
            elif current_lease is None or current_lease[0] != lease['token']:
                return 'lease_revived'
            elif deadline_failure:
                if (current_lease[1] != lease['last_beat_at']
                        or current_lease[2] is None or current_lease[2] > now):
                    return 'lease_revived'
                cursor.execute(
                    "SELECT reason, attempts FROM jobs_quarantined_job "
                    "WHERE job_id=%s FOR UPDATE", [job.id])
                if cursor.fetchone() != (
                        _deadline_marker_reason(lease['token']), attempts):
                    return 'attempt_changed'
                cursor.execute(
                    "DELETE FROM jobs_joblease WHERE job_id=%s AND token=%s "
                    "AND last_beat_at=%s AND deadline_at<=%s RETURNING job_id",
                    [job.id, lease['token'], lease['last_beat_at'], now])
                if cursor.fetchone() is None:
                    return 'lease_revived'
            else:
                if (current_lease[1] != lease['last_beat_at']
                        or current_lease[1] >= stale_before):
                    return 'lease_revived'
                cursor.execute(
                    "DELETE FROM jobs_joblease WHERE job_id=%s AND token=%s "
                    "AND last_beat_at=%s AND last_beat_at<%s RETURNING job_id",
                    [job.id, lease['token'], lease['last_beat_at'], stale_before])
                if cursor.fetchone() is None:
                    return 'lease_revived'

            if action in ('failed', 'deadline_failed'):
                _fail_queued_export_after_prebody_exhaustion(
                    cursor, job, attempts=attempts,
                    abandoned_phase=abandoned_phase, now=now)
                _put_quarantine(
                    cursor, job, now=now, attempts=attempts,
                    reason=(reason or 'reclaimer exceeded configured retry bound'))
                async_to_sync(app.job_manager.finish_job)(
                    job, status=Status.FAILED, delete_job=False)
                return 'gave_up'
            async_to_sync(app.job_manager.retry_job)(job, retry_at=now)
            cursor.execute(
                "DELETE FROM jobs_quarantined_job WHERE job_id=%s "
                "AND requeued_at IS NULL", [job.id])
            return 'reclaimed'


async def _apply_action_worker_pool(action, job, *, lease, now, attempts,
                                   stale_before, reason=None,
                                   worker_stale_before=None,
                                   recovery_phase=None):
    """Bound pool wait, checkout health I/O, row transaction, and disposal."""
    connector = app.job_manager.connector
    timeout_ms = max(1, int(
        float(settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS) * 1000))
    row_timeout = timeout_ms / 1000
    worker_stale_before = worker_stale_before or now - timedelta(
        seconds=float(settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS))
    loop = asyncio.get_running_loop()
    deadline = loop.time() + row_timeout
    state = {
        'connection': None,
        'socket_fd': None,
        'returning': False,
        'lock': threading.Lock(),
        'active': True,
    }

    async def run_row():
        # psycopg_pool's public connection() bounds only its queue wait; its
        # installed health check runs after checkout and has no deadline. Use
        # the pool's narrow unchecked-checkout primitive, then run that same
        # configured check under this row's absolute deadline. The underlying
        # pool still owns the connection lifecycle and discards bad sockets.
        try:
            conn = await connector.pool._getconn_unchecked(
                timeout=max(0.001, deadline - loop.time()))
        except (PoolTimeout, TimeoutError) as exc:
            # psycopg_pool and asyncio can win the same-deadline race and
            # raise their own timeout before the outer watchdog runs. Keep
            # the row-deadline contract stable for callers and diagnostics.
            raise TimeoutError(
                f'reclaimer checkout/row operation exceeded {row_timeout}s'
            ) from exc
        state['connection'] = conn
        try:
            state['socket_fd'] = os.dup(conn.fileno())
            await connector.pool._check_connection(conn)
            if loop.time() >= deadline:
                raise TimeoutError('pool health check exhausted row deadline')
            return await _apply_action_worker_pool_transaction(
                conn, connector, action, job, lease=lease, now=now,
                attempts=attempts, stale_before=stale_before, reason=reason,
                timeout_ms=timeout_ms,
                worker_stale_before=worker_stale_before,
                recovery_phase=recovery_phase)
        finally:
            # The socket is shut down first on timeout, so pool reset/discard
            # cannot wait behind a blocked libpq call while holding its mutex.
            # Socket authority ends before the pool can lend this connection
            # to another user. A cancellation arriving during/after putconn
            # must drain disposal without closing a newly borrowed socket.
            with state['lock']:
                state['connection'] = None
                fd, state['socket_fd'] = state['socket_fd'], None
                state['returning'] = True
                state['active'] = False
            if fd is not None:
                os.close(fd)
            putconn = asyncio.create_task(connector.pool.putconn(conn))
            try:
                await asyncio.shield(putconn)
            except asyncio.CancelledError:
                await asyncio.shield(putconn)
                raise

    operation = asyncio.create_task(run_row(), name=f'job-reclaim-row:{job.id}')

    async def stop_operation():
        """Interrupt I/O and drain the pool return before app shutdown."""
        _cut_worker_pool_socket(state)
        # Let socket shutdown interrupt an in-flight libpq wait first. Calling
        # Task.cancel() while its query is active makes psycopg open a separate
        # cancellation connection (libpq < 17 uses a blocking thread); that
        # connection is outside this row deadline and may itself be blackholed.
        # A pool-queue wait has no checked-out connection and is safe to cancel.
        grace = min(0.05, max(0.01, row_timeout))
        _, pending = await asyncio.wait({operation}, timeout=grace)
        if pending:
            conn = state.get('connection')
            if conn is not None and not state.get('returning'):
                # AsyncConnection.close() finishes the socket without waiting
                # on psycopg's command mutex. Do not cancel this task: psycopg
                # can start query-cancel I/O on a separate socket, and pool
                # return must finish so its closed-connection refill is queued.
                await conn.close()
            elif not state['returning']:
                # A queue waiter has no driver I/O. Pool return, however,
                # must finish even after socket ownership has been disarmed.
                operation.cancel()
            if conn is None and not state['returning']:
                _, pending = await asyncio.wait({operation}, timeout=grace)
        # A checked-out connection is closed above. If putconn has started,
        # its shielded ownership transfer must complete without cancellation.
        # Drain the task before app shutdown can close the pool underneath it.
        await asyncio.gather(operation, return_exceptions=True)

    try:
        done, _ = await asyncio.wait({operation}, timeout=row_timeout)
        if operation in done:
            try:
                return await operation
            except (PoolTimeout, TimeoutError) as exc:
                # A lower-level pool/driver timeout may complete on the same
                # loop turn as the watchdog. Preserve one row-deadline error
                # contract, with the original timeout available as its cause.
                raise TimeoutError(
                    f'reclaimer checkout/row operation exceeded {row_timeout}s'
                ) from exc
        await stop_operation()
        raise TimeoutError(
            f'reclaimer checkout/row operation exceeded {row_timeout}s')
    except asyncio.CancelledError:
        await stop_operation()
        raise
    finally:
        with state['lock']:
            state['active'] = False
            fd, state['socket_fd'] = state['socket_fd'], None
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def _cut_worker_pool_socket(state):
    """Interrupt a psycopg3 health/transaction query outside its mutex."""
    with state['lock']:
        fd = state.get('socket_fd')
        if not state['active'] or fd is None:
            return
        try:
            # Adopt the already duplicated descriptor and detach it again
            # after shutdown. Duplicating it here can fail precisely when
            # descriptor pressure makes the watchdog most necessary.
            sock = socket.socket(fileno=fd)
        except OSError:
            return
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        finally:
            sock.detach()


async def _apply_action_worker_pool_transaction(
        conn, connector, action, job, *, lease, now, attempts, stale_before,
        reason, timeout_ms, worker_stale_before, recovery_phase=None):
    """Run one fenced status transition on the caller's pooled connection."""
    async with conn.transaction():
        await conn.execute(
            "SELECT set_config('statement_timeout', %s, true)",
            (f'{timeout_ms}ms',))
        cursor = await conn.execute(
            "SELECT pg_try_advisory_xact_lock("
            "hashtext('jobs.reclaim_stalled_jobs'))")
        if not (await cursor.fetchone())[0]:
            return 'sweep_busy'
        cursor = await conn.execute(
            "SELECT status, attempts, worker_id FROM procrastinate_jobs "
            "WHERE id=%s FOR UPDATE", (job.id,))
        current = await cursor.fetchone()
        if (current is None or current[0] != Status.DOING.value
                or current[1] != attempts):
            return 'attempt_changed'
        worker_heartbeat = None
        if current[2] is not None:
            cursor = await conn.execute(
                "SELECT last_heartbeat FROM procrastinate_workers "
                "WHERE id=%s FOR UPDATE", (current[2],))
            worker = await cursor.fetchone()
            worker_heartbeat = worker[0] if worker else None
        # The decision that led here already probed through Django, and a
        # positive answer is permanent, so the cache is authoritative.
        cursor = await conn.execute(
            _locked_lease_sql(lease_schema.known_available()), (job.id,))
        current_lease = await cursor.fetchone()
        cursor = await conn.execute(
            "SELECT reason, attempts FROM jobs_quarantined_job "
            "WHERE job_id=%s FOR UPDATE", (job.id,))
        recovery_marker = await cursor.fetchone()
        abandoned_phase = _abandoned_phase(
            recovery_marker, current_lease, attempts)
        if (recovery_phase == 'before_body'
                and abandoned_phase != 'before_body'):
            return 'recovery_proof_changed'
        if (abandoned_phase is not None
                and (current_lease is None
                     or current_lease[1] >= stale_before)):
            return 'lease_revived'
        if (action not in ('deadline_abort', 'deadline_failed')
                and worker_heartbeat is not None
                and worker_heartbeat >= worker_stale_before
                and abandoned_phase is None):
            return 'worker_revived'
        if lease is None and current_lease is not None:
            return 'lease_revived'

        if action == 'deadline_abort':
            if (lease is None or current_lease is None
                    or current_lease[0] != lease['token']
                    or current_lease[1] != lease['last_beat_at']
                    or current_lease[2] is None
                    or current_lease[2] > now):
                return 'lease_revived'
            cursor = await conn.execute(
                "SELECT reason, attempts FROM jobs_quarantined_job "
                "WHERE job_id=%s FOR UPDATE", (job.id,))
            if await cursor.fetchone() == (
                    _deadline_marker_reason(lease['token']), attempts):
                return 'deadline_already_requested'
            rows = await connector.execute_query_all_async_with_connection(
                conn, query=sql.queries['cancel_job'], job_id=job.id,
                abort=True, delete_job=False)
            if not rows or rows[0]['id'] is None:
                return 'attempt_changed'
            await conn.execute(
                "INSERT INTO jobs_quarantined_job "
                "(job_id, task_name, queue, reason, attempts, "
                "quarantined_at, requeued_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, NULL) "
                "ON CONFLICT (job_id) DO UPDATE SET "
                "task_name=EXCLUDED.task_name, queue=EXCLUDED.queue, "
                "reason=EXCLUDED.reason, attempts=EXCLUDED.attempts, "
                "quarantined_at=EXCLUDED.quarantined_at, requeued_at=NULL",
                (job.id, job.task_name, job.queue,
                 _deadline_marker_reason(lease['token']), attempts, now))
            return 'deadline_abort_requested'

        deadline_failure = action == 'deadline_failed'
        if lease is None:
            if current_lease is not None:
                return 'lease_revived'
        elif current_lease is None or current_lease[0] != lease['token']:
            return 'lease_revived'
        elif deadline_failure:
            if (current_lease[1] != lease['last_beat_at']
                    or current_lease[2] is None or current_lease[2] > now):
                return 'lease_revived'
            cursor = await conn.execute(
                "SELECT reason, attempts FROM jobs_quarantined_job "
                "WHERE job_id=%s FOR UPDATE", (job.id,))
            if await cursor.fetchone() != (
                    _deadline_marker_reason(lease['token']), attempts):
                return 'attempt_changed'
            cursor = await conn.execute(
                "DELETE FROM jobs_joblease WHERE job_id=%s AND token=%s "
                "AND last_beat_at=%s AND deadline_at<=%s RETURNING job_id",
                (job.id, lease['token'], lease['last_beat_at'], now))
            if await cursor.fetchone() is None:
                return 'lease_revived'
        else:
            if (current_lease[1] != lease['last_beat_at']
                    or current_lease[1] >= stale_before):
                return 'lease_revived'
            cursor = await conn.execute(
                "DELETE FROM jobs_joblease WHERE job_id=%s AND token=%s "
                "AND last_beat_at=%s AND last_beat_at<%s RETURNING job_id",
                (job.id, lease['token'], lease['last_beat_at'], stale_before))
            if await cursor.fetchone() is None:
                return 'lease_revived'

        if action in ('failed', 'deadline_failed'):
            terminal_reason = (
                reason or 'reclaimer exceeded configured retry bound')
            if (job.task_name == 'exports.export_publication'
                    and abandoned_phase == 'before_body'):
                await conn.execute(
                    "UPDATE exports_publicationexportjob AS export "
                    "SET status='failed', "
                    "error_message='Export could not start after repeated infrastructure failures.', "
                    "updated_at=%s "
                    "FROM procrastinate_jobs AS queue_job "
                    "WHERE queue_job.id=%s AND queue_job.task_name=%s "
                    "AND queue_job.status=%s AND queue_job.attempts=%s "
                    "AND queue_job.args->>'job_id' = export.id::text "
                    "AND export.status='queued'",
                    (now, job.id, 'exports.export_publication',
                     Status.DOING.value, attempts))
            await conn.execute(
                "INSERT INTO jobs_quarantined_job "
                "(job_id, task_name, queue, reason, attempts, "
                "quarantined_at, requeued_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, NULL) "
                "ON CONFLICT (job_id) DO UPDATE SET "
                "task_name=EXCLUDED.task_name, queue=EXCLUDED.queue, "
                "reason=EXCLUDED.reason, attempts=EXCLUDED.attempts, "
                "quarantined_at=EXCLUDED.quarantined_at, requeued_at=NULL",
                (job.id, job.task_name, job.queue, terminal_reason,
                 attempts, now))
            await connector.execute_query_all_async_with_connection(
                conn, query=sql.queries['finish_job'], job_id=job.id,
                status=Status.FAILED.value, delete_job=False)
            return 'gave_up'
        await connector.execute_query_all_async_with_connection(
            conn, query=sql.queries['retry_job'], job_id=job.id,
            retry_at=now, new_priority=None, new_queue_name=None,
            new_lock=None)
        await conn.execute(
            "DELETE FROM jobs_quarantined_job WHERE job_id=%s "
            "AND requeued_at IS NULL", (job.id,))
        return 'reclaimed'

async def _apply_row_action(action, job, **kwargs):
    if _uses_worker_pool():
        return await _apply_action_worker_pool(action, job, **kwargs)
    return await sync_to_async(_apply_action_sync)(action, job, **kwargs)

#The name of the periodic task, defined here so the sweep can recognise
#(and skip) its own rows without importing ``tasks`` back.
RECLAIM_TASK_NAME = 'jobs.reclaim_stalled_jobs'

#THE PAGE PHRASE. ``monitoring/log-metrics/procrastinate-reclaim-gave-up
#.json`` matches ``jsonPayload.message`` against a regex anchored on this
#string, and ``py/gcp/tests/test_alert_policy_contract.py`` fails if the
#two ever drift apart. Rewording it here without reworking the filter is
#how a policy goes green-and-un-fireable.
RECLAIM_GIVE_UP_SIGNAL = 'reclaim_stalled_jobs: giving up'

#``jsonPayload.event`` values. One per outcome, so a Logs Explorer query
#(or a future metric) can select an outcome without regexing a message.
SWEEP_EVENT = 'procrastinate_reclaim_sweep'
RECLAIMED_EVENT = 'procrastinate_job_reclaimed'
GAVE_UP_EVENT = 'procrastinate_reclaim_gave_up'
ERROR_EVENT = 'procrastinate_reclaim_error'
SKIPPED_EVENT = 'procrastinate_reclaim_skipped'
TIMED_OUT_EVENT = 'procrastinate_reclaim_timed_out'
DEADLINE_ABORT_REQUESTED = 'deadline abort requested by reclaimer'


def excluded_queues() -> frozenset:
    """
    Queues the sweep must never touch -- the operator escape hatch, on top
    of the per-task registry. See the module docstring.
    """
    return frozenset(settings.JOB_RECLAIM_EXCLUDED_QUEUES)


def _is_queue_excluded(queue: str, abandoned_phase: str | None) -> bool:
    """Honor pauses and explicit operator exclusions before task policy.

    `exports` is excluded by default because an ordinary duplicate export
    can return from its application claim and be recorded as SUCCEEDED. A
    matching `before_body` lease phase proves that the claim/body was never
    authorized, so that one queue-level default does not strand a lost
    acquisition. An operator-supplied exclusion remains authoritative.
    """
    if queue.startswith('paused.'):
        return True
    if queue not in excluded_queues():
        return False
    if (abandoned_phase == 'before_body'
            and queue not in settings.JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES):
        return False
    return True


def reclaim_threshold_seconds() -> int:
    """Minimum doing age before an unleased orphan can be reclaimed."""
    return int(settings.JOB_RECLAIM_MIN_AGE_SECONDS)


def task_threshold_seconds(task_name: str) -> int | None:
    """
    The reclaim threshold for one task, or ``None`` if it is never
    reclaimed (or is not classified at all).
    """
    policy = reclaim_policy.policy_for(task_name)
    if policy is None:
        return None
    return reclaim_policy.reclaim_after_seconds(
        policy,
        floor=reclaim_threshold_seconds(),
        margin=int(settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS),
    )


def _job_payload(job, event: str, **extra: Any) -> dict[str, Any]:
    return {
        'event': event,
        'job_id': job.id,
        'task': job.task_name,
        'queue': job.queue,
        'attempts': job.attempts or 0,
        **extra,
    }


def is_reclaim_candidate(job_id: int, aged_ids: set[int],
                         orphaned_ids: set[int]) -> bool:
    """The shared minimum-age AND worker-heartbeat predicate."""
    return job_id in aged_ids and job_id in orphaned_ids


async def reclaim_decision(job, *, floor: int, margin: int,
                           heartbeat_seconds: float,
                           max_reclaims: int, now=None) -> dict[str, Any]:
    """The full, live eligibility decision shared by inspection and sweep."""
    now = now or timezone.now()
    if (job.queue.startswith('paused.')
            or job.queue in settings.JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES):
        return {'reason': 'excluded_queue'}
    if job.task_name == RECLAIM_TASK_NAME:
        return {'reason': 'reclaimer_task'}
    policy = reclaim_policy.policy_for(job.task_name)
    if policy is None:
        if job.queue in excluded_queues():
            return {'reason': 'excluded_queue'}
        return {'reason': 'unclassified_task'}
    lease = await _tracked_sync_to_async(lambda: JobLease.objects.filter(
        job_id=job.id).values(*_lease_value_fields(
            'token', 'last_beat_at', 'deadline_at', 'attempt')).first())
    marker = await _tracked_sync_to_async(QuarantinedJob.objects.filter(
        job_id=job.id, requeued_at__isnull=True).values(
            'reason', 'attempts').first)
    abandoned_phase = _abandoned_phase(
        (marker['reason'], marker['attempts']) if marker else None,
        lease, job.attempts or 0)
    if _is_queue_excluded(job.queue, abandoned_phase):
        return {'reason': 'excluded_queue',
                'abandoned_phase': abandoned_phase}
    if policy.max_runtime_seconds is None:
        # A pre-body lease phase is the one safe exception to NEVER: it proves
        # this attempt's body was not authorized to run. Bound these infrastructure
        # retries with the existing reclaim cap after subtracting ordinary
        # task retries; interrupted task bodies keep the task's NEVER policy.
        if abandoned_phase == 'before_body':
            allowance = reclaim_policy.retry_allowance(job.task_name)
            if allowance is None:
                return {'reason': 'unbounded_retry_strategy', 'policy': policy,
                        'required': floor, 'allowance': None}
            return {
                'reason': 'eligible', 'job': job, 'policy': policy,
                'required': floor, 'allowance': allowance,
                'reclaims': max(0, (job.attempts or 0) - allowance),
                'lease': lease,
                'abandoned_phase': abandoned_phase,
            }
        return {'reason': 'never_reclaimed', 'policy': policy,
                'required': None}
    required = floor
    allowance = reclaim_policy.retry_allowance(job.task_name)
    if allowance is None:
        return {'reason': 'unbounded_retry_strategy', 'policy': policy,
                'required': required, 'allowance': None}
    has_hard_deadline = policy.hard_deadline_seconds is not None
    pending_deadline = bool(
        has_hard_deadline and marker and lease
        and marker['attempts'] == (job.attempts or 0)
        and marker['reason'] == _deadline_marker_reason(lease['token']))
    expired = bool(
        has_hard_deadline and lease and lease['deadline_at']
        and lease['deadline_at'] <= now)
    fresh_lease = bool(lease and lease['last_beat_at'] >= now - timedelta(
        seconds=float(settings.JOB_LEASE_STALE_SECONDS)))

    fresh = await _still_stalled(job, required, heartbeat_seconds, now=now)
    if pending_deadline:
        if expired:
            return {'reason': 'deadline_give_up', 'job': job,
                    'policy': policy, 'required': required,
                    'allowance': allowance, 'lease': lease,
                    'reclaims': max(0, (job.attempts or 0) - allowance)}
    if expired and fresh_lease:
        return {'reason': 'deadline_abort', 'job': job, 'policy': policy,
                'required': required, 'allowance': allowance, 'lease': lease}
    if fresh_lease:
        return {'reason': 'fresh_lease', 'policy': policy,
                'required': required, 'allowance': allowance,
                'lease': lease}
    if fresh is None:
        return {'reason': 'stale_snapshot',
                'policy': policy, 'required': required,
                'allowance': allowance, 'lease': lease}
    reclaims = max(0, (fresh.attempts or 0) - allowance)
    return {'reason': 'would_mark_failed' if reclaims >= max_reclaims
            else 'eligible', 'job': fresh, 'policy': policy,
            'required': required, 'allowance': allowance,
            'reclaims': reclaims, 'lease': lease,
            'abandoned_phase': abandoned_phase}


async def _stalled_candidates(threshold: int, heartbeat_seconds: float,
                              now=None, *, include_deadlines=True):
    """
    Aged jobs with a stale lease, or without a lease and stale worker,
    oldest id first.

    Never cached: every call is a fresh pair of queries, because this is
    both the sweep's opening snapshot (at the global FLOOR, so nothing is
    missed) and the re-listing that immediately precedes each write (at
    that task's own threshold).

    Returns ``(candidates, aged_count, worker_orphaned_count)`` so the summary
    line keeps the worker-heartbeat population separate from age and candidate
    counts. Ordinary candidates need stale worker and lease signals; a matching
    durable abandonment marker is the only bypass for a live worker.
    """
    manager = app.job_manager
    now = now or timezone.now()

    with warnings.catch_warnings():
        # See the module docstring: the age form is deprecated upstream but
        # is the only one that answers the question this sweep asks.
        warnings.simplefilter('ignore', DeprecationWarning)
        aged = list(await manager.get_stalled_jobs(nb_seconds=threshold))

    orphaned = {
        job.id
        for job in await manager.get_stalled_jobs(
            seconds_since_heartbeat=heartbeat_seconds)
    }

    aged_ids = {job.id for job in aged}
    lease_rows = await _tracked_sync_to_async(lambda: list(
        JobLease.objects.filter(job_id__in=aged_ids).values(
            *_lease_value_fields(
                'job_id', 'last_beat_at', 'deadline_at', 'token',
                'attempt'))))
    leases = {row['job_id']: row for row in lease_rows}
    marker_rows = await _tracked_sync_to_async(lambda: list(
        QuarantinedJob.objects.filter(
            job_id__in=aged_ids, requeued_at__isnull=True).values(
                'job_id', 'reason', 'attempts')))
    markers = {row['job_id']: row for row in marker_rows}
    aged_by_id = {job.id: job for job in aged}
    stale_before = now - timedelta(seconds=settings.JOB_LEASE_STALE_SECONDS)

    # Ordinary leases require BOTH a stale lease and stale worker heartbeat.
    # Only matching token/attempt evidence proves that this exact attempt
    # returned before status persistence or never entered its body.
    recovery_signal_ids = {
        job_id for job_id in aged_ids
        if (
            _abandoned_phase(
                ((markers[job_id]['reason'], markers[job_id]['attempts'])
                 if job_id in markers else None),
                leases.get(job_id), aged_by_id[job_id].attempts or 0,
            ) is not None
            and job_id in leases
            and leases[job_id]['last_beat_at'] < stale_before
            or (
                job_id in orphaned
                and (job_id not in leases
                     or leases[job_id]['last_beat_at'] < stale_before)
            )
        )
    }

    # Stale worker/lease signals remain ambiguous during drain. Require the
    # task budget unless durable middleware evidence says the body already
    # ended or never began.
    budget_ids = list(recovery_signal_ids)
    started_at_by_id = {}
    if budget_ids:
        def load_started_at():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT job_id, MAX(at) FROM procrastinate_events "
                    "WHERE type='started' AND job_id = ANY(%s) "
                    "GROUP BY job_id", [budget_ids])
                return dict(cursor.fetchall())
        started_at_by_id = await _tracked_sync_to_async(load_started_at)

    candidates_by_id = {
        job.id: job for job in aged
        if job.id in recovery_signal_ids
        and (
            job.id not in budget_ids
            or _abandoned_phase(
                ((markers[job.id]['reason'], markers[job.id]['attempts'])
                 if job.id in markers else None),
                leases.get(job.id), job.attempts or 0,
            ) is not None
            or task_threshold_seconds(job.task_name) is None
            or (started_at_by_id.get(job.id) is not None
                and started_at_by_id[job.id] <= now - timedelta(
                    seconds=task_threshold_seconds(job.task_name)))
        )
    }

    # Deadlines are an independent candidate path: the worker and lease are
    # expected to be fresh on the first overrun sweep.
    if include_deadlines:
        deadline_ids = await _tracked_sync_to_async(lambda: list(
            JobLease.objects.filter(deadline_at__lte=now).values_list(
                'job_id', flat=True)))
        for job_id in deadline_ids:
            if job_id in candidates_by_id:
                continue
            rows = await _tracked_sync_to_async(
                manager.list_jobs, id=job_id)
            if (rows and getattr(rows[0].status, 'value', rows[0].status)
                    == Status.DOING.value):
                candidates_by_id[job_id] = rows[0]

    candidates = sorted(candidates_by_id.values(), key=lambda job: job.id)
    return candidates, len(aged), len(orphaned)


def _begin_sweep_transaction():
    """Open the Django transaction which owns the cross-process sweep lock."""
    atomic = transaction.atomic()
    atomic.__enter__()
    try:
        # Publish the raw connection as soon as Django opens it. The async
        # sweep's watchdog can then close it from another thread if a query
        # blocks behind a stalled proxy; cancellation alone cannot interrupt
        # a synchronous psycopg2 call already running in sync_to_async.
        timeout_ms = max(1, int(float(
            settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS) * 1000))
        with connection.cursor() as cursor:
            state = _ACTIVE_SWEEP_CONNECTION.get()
            if state is not None:
                state['connection'] = connection.connection
                # Keep the socket alive at the OS level until this sweep
                # finishes, so its descriptor cannot be reused before the
                # watchdog gets a chance to interrupt it.
                state['socket_fd'] = os.dup(connection.connection.fileno())
            cursor.execute(
                "SELECT set_config('statement_timeout', %s, true)",
                [f'{timeout_ms}ms'])
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtext('jobs.reclaim_stalled_jobs'))")
    except BaseException as exc:
        atomic.__exit__(type(exc), exc, exc.__traceback__)
        raise
    return atomic


def _end_transaction(atomic, exc=None):
    if exc is None:
        atomic.__exit__(None, None, None)
    else:
        atomic.__exit__(type(exc), exc, exc.__traceback__)


@asynccontextmanager
async def _sweep_transaction():
    """Hold one transaction-scoped advisory lock across the whole sweep."""
    atomic = await sync_to_async(_begin_sweep_transaction)()
    try:
        yield
    except BaseException as exc:
        await sync_to_async(_end_transaction)(atomic, exc)
        raise
    else:
        await sync_to_async(_end_transaction)(atomic)


def _row_error(errors, job, exc):
    errors.append(job.id)
    emit_json_line(
        logger,
        _job_payload(job, ERROR_EVENT, error=type(exc).__name__,
                     detail=str(exc)[:200]),
        'ERROR',
        f'reclaim_stalled_jobs: could not reclaim job={job.id} '
        f'task={job.task_name} error={type(exc).__name__}',
    )


async def reclaim_stalled_jobs(now=None) -> dict[str, Any]:
    """
    One sweep, bounded by ``JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS``. Returns the
    summary payload so the tests can assert on it without scraping logs.

    The timeout bounds how stale one sweep's view can get -- see the
    module docstring. On expiry the ERROR line is emitted and the exception
    is re-raised, so the sweep job lands in ``failed`` where
    ``jobs.report_job_health`` can see it: a reclaimer that quietly returns
    a partial result every cycle is the same silent-failure class this
    whole module exists to remove.

    ``asyncio.wait_for``/``asyncio.TimeoutError`` rather than
    ``asyncio.timeout``/``TimeoutError``: the former pair works on every
    Python from 3.8, and the two exceptions are only the same object from
    3.11 onwards.
    """
    timeout = float(settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS)
    try:
        return await asyncio.wait_for(_locked_reclaim_stalled_jobs(now), timeout)
    except asyncio.TimeoutError:
        emit_json_line(
            logger,
            {'event': TIMED_OUT_EVENT, 'timeout_seconds': timeout},
            'ERROR',
            f'reclaim_stalled_jobs: sweep timed out after {timeout}s; '
            'its view of the queue is stale and it stopped rather than act '
            'on it',
        )
        raise


async def _locked_reclaim_stalled_jobs(now=None):
    worker_pool = _uses_worker_pool()

    async def run_with_connection():
        if worker_pool:
            # Do not hold a Django transaction while the production psycopg
            # pool performs candidate and row queries. With PgBouncer
            # max_db_connections=1, waiting for that second connection would
            # block every worker client pinned to the same pooler. The pool
            # path takes its non-blocking sweep lock inside each row transaction.
            return await _reclaim_stalled_jobs(now)
        async with _sweep_transaction():
            return await _reclaim_stalled_jobs(now)

    # A synchronous caller already owns the thread-sensitive executor and may
    # be sharing its Django connection with its caller. Keep that established
    # contract for management/tests; the production worker invokes this native
    # async task without a parent executor.
    if getattr(AsyncToSync.executors, 'current', None) is not None:
        return await run_with_connection()

    # Django's sync_to_async calls otherwise share one thread-sensitive
    # executor (and connection) among concurrent native async sweeps. Give
    # each sweep its own thread so its advisory-lock transaction is exclusive
    # to this coroutine for the entire async/ORM interleave.
    async with ThreadSensitiveContext():
        state = {
            'connection': None,
            'socket_fd': None,
            'lock': threading.Lock(),
            'active': True,
        }
        token = _ACTIVE_SWEEP_CONNECTION.set(state)
        timeout = float(settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS)
        watchdog = threading.Timer(
            max(0.01, timeout * 0.8), _cut_sweep_connection, args=(state,))
        watchdog.daemon = True
        watchdog.start()
        try:
            return await run_with_connection()
        except Exception:
            if state.get('timed_out'):
                raise asyncio.TimeoutError from None
            raise
        finally:
            watchdog.cancel()
            with state['lock']:
                state['active'] = False
                fd, state['socket_fd'] = state['socket_fd'], None
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            _ACTIVE_SWEEP_CONNECTION.reset(token)
            await sync_to_async(lambda: connection.close())()


def _cut_sweep_connection(state):
    """Interrupt a blocked psycopg2 read without acquiring its connection lock.

    ``connection.close()`` takes the same mutex as a running ``PQexec`` and
    therefore waits behind the query it needs to stop. Shutting down a dup of
    the socket fd is an OS-level interruption and does not enter psycopg2.
    """
    with state['lock']:
        fd = state.get('socket_fd')
        if not state['active'] or fd is None:
            return
        state['timed_out'] = True
        try:
            sock = socket.socket(fileno=os.dup(fd))
        except OSError:  # connection already closed
            return
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:  # already disconnected or closing
            pass
        finally:
            sock.close()


async def _still_stalled(candidate, threshold: int,
                         heartbeat_seconds: float, now=None):
    """
    The candidate as it is RIGHT NOW at ``threshold``, or ``None``.

    Always a fresh pair of queries -- that is the whole point, so it must
    not be cached across calls.

    The AGE half is what does the work: a job a concurrent sweep requeued
    and a worker restarted has a ``started`` event seconds old, not 900
    seconds old, so it is simply not in the fresh list and this returns
    ``None``.

    An earlier draft also refused a row whose ``attempts`` had moved the snapshot. That check was removed rather than shipped: every path
    that increments ``attempts`` (``retry_job``, ``finish_job`` on a
    ``doing`` row) also moves the job out of the aged-and-orphaned set, so
    no test could reach the branch -- and a branch no test can reach is a
    branch nobody can trust. Returning the FRESH row instead means the
    bound below is evaluated against the current attempt count either way.
    """
    fresh, _, _ = await _stalled_candidates(
        threshold, heartbeat_seconds, now=now, include_deadlines=False)
    for job in fresh:
        if job.id == candidate.id:
            return job
    return None


async def _reclaim_stalled_jobs(now=None) -> dict[str, Any]:
    floor = reclaim_threshold_seconds()
    margin = int(settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS)
    heartbeat_seconds = float(settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS)
    max_reclaims = int(settings.JOB_RECLAIM_MAX_RECLAIMS)
    now = now or timezone.now()
    candidates, aged_count, orphaned_count = await _stalled_candidates(
        floor, heartbeat_seconds, now=now)

    reclaimed, gave_up, errors, stale = [], [], [], []
    skipped_self, skipped_excluded = [], []
    skipped_never, skipped_unclassified, skipped_fresh_lease = [], [], []

    def _skip(job, reason, severity='INFO', **extra):
        emit_json_line(
            logger, _job_payload(job, SKIPPED_EVENT, reason=reason, **extra),
            severity,
            f'reclaim_stalled_jobs: not reclaiming job={job.id} '
            f'task={job.task_name} queue={job.queue} reason={reason}',
        )

    for candidate in candidates:
        decision = await reclaim_decision(
            candidate, floor=floor, margin=margin,
            heartbeat_seconds=heartbeat_seconds,
            max_reclaims=max_reclaims, now=now)
        reason = decision['reason']
        policy = decision.get('policy')
        job = decision.get('job', candidate)
        if reason == 'excluded_queue':
            skipped_excluded.append(job.id)
            _skip(job, reason)
            continue
        if reason == 'reclaimer_task':
            skipped_self.append(job.id)
            continue
        if reason == 'unclassified_task':
            skipped_unclassified.append(job.id)
            _skip(job, reason, severity='ERROR')
            continue
        if reason in ('never_reclaimed', 'unbounded_retry_strategy'):
            skipped_never.append(job.id)
            _skip(job, reason, detail=getattr(policy, 'reason', '')[:200])
            continue
        if reason in ('fresh_lease', 'deadline_abort'):
            if reason == 'fresh_lease':
                skipped_fresh_lease.append(job.id)
                _skip(job, reason)
                continue
            try:
                outcome = await _apply_row_action(
                    'deadline_abort', job, lease=decision.get('lease'),
                    now=now, attempts=job.attempts or 0,
                    stale_before=now - timedelta(
                        seconds=float(settings.JOB_LEASE_STALE_SECONDS)),
                    recovery_phase=decision.get('abandoned_phase'))
            except Exception as exc:  # noqa: BLE001
                outcome = 'error'
                _row_error(errors, job, exc)
            if outcome == 'deadline_abort_requested':
                _skip(job, 'deadline_abort_requested')
            elif outcome not in ('error', 'deadline_already_requested'):
                stale.append(job.id)
                _skip(job, outcome)
            continue
        if reason == 'stale_snapshot':
            stale.append(job.id)
            _skip(job, reason)
            continue

        job = decision['job']
        allowance = decision['allowance']
        reclaims = decision['reclaims']
        attempts = job.attempts or 0
        lease = decision.get('lease')
        deadline_failure = reason == 'deadline_give_up'
        try:
            give_up = reclaims >= max_reclaims or deadline_failure
            if give_up:
                emit_json_line(
                    logger,
                    _job_payload(job, GAVE_UP_EVENT, reclaims=reclaims,
                                 retry_allowance=allowance,
                                 max_reclaims=max_reclaims,
                                 reason=('deadline' if deadline_failure
                                         else 'reclaim_limit')),
                    'ERROR',
                    f'{RECLAIM_GIVE_UP_SIGNAL} job={job.id} '
                    f'task={job.task_name} attempts={attempts} '
                    f'reclaims={reclaims}',
                )
            outcome = await _apply_row_action(
                'deadline_failed' if deadline_failure else
                'failed' if give_up else 'retry',
                job, lease=lease, now=now, attempts=attempts,
                stale_before=now - timedelta(
                    seconds=float(settings.JOB_LEASE_STALE_SECONDS)),
                worker_stale_before=now - timedelta(
                    seconds=heartbeat_seconds),
                recovery_phase=decision.get('abandoned_phase'),
                reason=('deadline exceeded after abort request'
                        if deadline_failure else
                        'reclaimer exceeded configured retry bound'))
            if outcome == 'lease_revived':
                skipped_fresh_lease.append(job.id)
                _skip(job, 'lease_revived')
                continue
            if outcome != ('gave_up' if give_up else 'reclaimed'):
                stale.append(job.id)
                _skip(job, outcome)
                continue
            if give_up:
                gave_up.append(job.id)
            else:
                reclaimed.append(job.id)
                emit_json_line(
                    logger,
                    _job_payload(job, RECLAIMED_EVENT, reclaims=reclaims,
                                 retry_allowance=allowance,
                                 max_reclaims=max_reclaims),
                    'INFO',
                    f'reclaim_stalled_jobs: requeued job={job.id} '
                    f'task={job.task_name} attempts={attempts} '
                    f'reclaims={reclaims}',
                )
        except Exception as exc:  # noqa: BLE001
            _row_error(errors, job, exc)

    summary = {
        'event': SWEEP_EVENT,
        'stalled_by_age': aged_count,
        'orphaned_by_heartbeat': orphaned_count,
        'candidates': len(candidates),
        'reclaimed': len(reclaimed), 'reclaimed_ids': reclaimed,
        'gave_up': len(gave_up), 'gave_up_ids': gave_up,
        'errors': len(errors), 'skipped_self': len(skipped_self),
        'skipped_excluded': len(skipped_excluded),
        'skipped_never': len(skipped_never),
        'skipped_never_ids': skipped_never,
        'skipped_unclassified': len(skipped_unclassified),
        'skipped_fresh_lease': len(skipped_fresh_lease),
        'skipped_fresh_lease_ids': skipped_fresh_lease,
        'skipped_stale': len(stale),
        'reclaim_after_seconds': floor,
        'budget_margin_seconds': margin,
        'worker_heartbeat_seconds': heartbeat_seconds,
        'max_reclaims': max_reclaims,
    }
    emit_json_line(logger, summary, 'INFO',
                   'reclaim_stalled_jobs: sweep '
                   f'candidates={len(candidates)} reclaimed={len(reclaimed)} '
                   f'gave_up={len(gave_up)} errors={len(errors)}')
    return summary
