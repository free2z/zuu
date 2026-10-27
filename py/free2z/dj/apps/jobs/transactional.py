"""Enqueue a procrastinate job INSIDE the caller's database transaction.

Why not ``transaction.on_commit(lambda: task.defer(...))``
---------------------------------------------------------
Because it is not transactional, whatever the docstrings around it used to
say. The callback runs AFTER ``COMMIT``, as a separate statement. If the
process dies in between (a deploy drain, an OOM kill) or that INSERT fails (a
database blip), the row is saved and the job never exists. Nothing can see a
job that was never queued -- not the health sweep, not the reclaimer -- and
``index_zpage``, ``generate_image_variants`` and ``detect_zpage_language``
have no periodic repair job. The derived state is simply never produced.

Why not a plain ``task.defer()`` inside the atomic block
--------------------------------------------------------
In a web, cron or management-command process the app's connector is
procrastinate's ``DjangoConnector``, which runs on Django's own connection,
so a plain ``.defer()`` inside ``atomic()`` already is transactional. In a
**worker** process it is not: ``manage.py procrastinate worker`` replaces the
app connector with a psycopg POOL (``replace_connector(get_worker_connector())``
in procrastinate 3.9), so a task that saves a zPage -- ``publish_zpage``,
``detect_zpage_language``, a translation -- would enqueue on a different,
autocommit connection. That job would be committed before the write it
describes, visible to a worker before the row is, and would survive the write
rolling back. Worse than ``on_commit``, not better.

So this module always inserts through a ``DjangoConnector`` of its own, i.e.
through ``django.db.connections[alias]`` of the calling thread: the same
connection, and therefore the same transaction, as the ORM write that caused
it. procrastinate runs sync tasks in an executor thread
(``sync_to_async(thread_sensitive=False)``), and the task's ORM calls and this
INSERT both resolve Django's connection for that thread.

The contract
------------
* The INSERT runs in a SAVEPOINT, so ``AlreadyEnqueued`` (a pending job with
  the same ``queueing_lock``) is confined and cannot poison the caller's
  transaction. This is the ``e2ee.tasks.enqueue_chat_request_email`` shape.
  Inside a transaction it also registers a post-commit re-check: the pending
  job could be claimed by a worker before our write commits and so read the
  pre-write state. After COMMIT, ``AlreadyEnqueued`` again means a job that
  has not started and will read our write; otherwise a new job is enqueued.
  That re-check is the one residual on-commit window, and it only matters
  when a pending job was claimed during the write's own transaction.
* Any OTHER failure propagates AND marks the enclosing atomic block for
  rollback, so the caller's write is rolled back even by a caller that
  catches the exception and returns (``AtomicMiddleware`` commits a returned
  response by design, ). That is the point: a committed row without its
  job is exactly what  is.
  The INSERT goes to the same Postgres as the write, so an enqueue that fails
  is, in practice, a write that was going to fail anyway.
* Outside any atomic block (autocommit) the INSERT commits on its own, which
  is the same outcome ``on_commit`` would have had.

Queueing-lock contention, and why it has a timeout
--------------------------------------------------
procrastinate enforces ``queueing_lock`` with a partial UNIQUE index. Inside a
transaction a second writer that inserts the same lock does not fail -- it
WAITS for the first transaction to finish. That wait now happens while the
waiter holds its own row locks, and two write paths take the page row and the
lock in opposite orders (a translation save enqueues the multilingual reindex
and then UPDATEs the parent zPage; a zPage save does the reverse), which is a
textbook ABBA deadlock that Postgres would break by aborting a user's write.

So a locked enqueue inside a transaction runs under a short ``lock_timeout``
(:data:`QUEUEING_LOCK_WAIT_MS`, well under Postgres's 1s ``deadlock_timeout``).
If it times out, another open transaction is inserting the same lock right
now. When that transaction commits, its job covers ours (the job reads
current state when it runs); if it rolls back, it does not. So we register
the old ``on_commit`` enqueue as a fallback for that case only, with
``robust=True`` so a failure there is logged rather than turned into a 500 on
a write that already committed. That fallback, and the AlreadyEnqueued
re-check above, are the only remaining on-commit windows. Each needs a race
first (a concurrent writer that rolls back, or a pending job claimed during
our transaction) AND then the post-commit INSERT itself to be lost.
"""
from __future__ import annotations

import logging

from django.db import connections, transaction
from procrastinate import manager as procrastinate_manager
from procrastinate.contrib.django.django_connector import DjangoConnector
from procrastinate.exceptions import AlreadyEnqueued
from procrastinate.jobs import JobDeferrer

logger = logging.getLogger(__name__)

#How long an in-transaction enqueue may wait for ANOTHER open transaction
#that is inserting the same ``queueing_lock``. Milliseconds. Must stay below
#Postgres's ``deadlock_timeout`` (1000ms default) so our timeout, not the
#deadlock detector, resolves the ABBA case described in the module docstring.
QUEUEING_LOCK_WAIT_MS = 250

_managers: dict[str, procrastinate_manager.JobManager] = {}


def _job_manager(alias: str) -> procrastinate_manager.JobManager:
    manager = _managers.get(alias)
    if manager is None:
        manager = procrastinate_manager.JobManager(DjangoConnector(alias=alias))
        _managers[alias] = manager
    return manager


def _is_lock_timeout(exc: BaseException) -> bool:
    from psycopg import errors as pg_errors

    seen = set()
    while exc is not None and id(exc) not in seen:
        if isinstance(exc, pg_errors.LockNotAvailable):
            return True
        seen.add(id(exc))
        exc = exc.__cause__ or exc.__context__
    return False


def defer_in_transaction(deferrer: JobDeferrer, *, using: str = "default",
                         **task_kwargs):
    """Insert ``deferrer``'s job on Django's connection, in a savepoint.

    ``deferrer`` is what ``task.configure(...)`` returns, so every option
    (``schedule_at``, ``queueing_lock``, ``priority``,...) is the task's own.
    Returns the job id, or ``None`` when an equivalent job is already pending
    (``AlreadyEnqueued``) or when the enqueue was handed to the on-commit
    fallback (see the module docstring).
    """
    conn = connections[using]
    bound = JobDeferrer(job_manager=_job_manager(using), job=deferrer.job)
    locked = bool(deferrer.job.queueing_lock) and conn.in_atomic_block
    try:
        with transaction.atomic(using=using):
            previous = None
            if locked:
                with conn.cursor() as cursor:
                    cursor.execute(
                        "SELECT current_setting('lock_timeout'), "
                        "set_config('lock_timeout', %s, true)",
                        [f"{QUEUEING_LOCK_WAIT_MS}ms"],
                    )
                    previous = cursor.fetchone()[0]
            job_id = bound.defer(**task_kwargs)
            # Only on success: after an error the savepoint is aborted (no
            # statement may run in it), and rolling it back reverts the
            # set_config anyway -- a GUC change is undone with its
            # subtransaction.
            if previous is not None:
                _restore_lock_timeout(conn, previous)
            return job_id
    except AlreadyEnqueued:
        if conn.in_atomic_block:
            # The pending job was `todo` when we looked, but our write has not
            # committed yet: a worker may claim that job in between and read
            # the PRE-write state, leaving this edit covered by nothing. So
            # look again once we have committed -- AlreadyEnqueued then means
            # a job that has not started yet, which will read our write.
            _on_commit_fallback(deferrer, using, task_kwargs)
        return None
    except Exception as exc:
        if not (locked and _is_lock_timeout(exc)):
            if conn.in_atomic_block:
                # Mark the ENCLOSING block for rollback, not just our
                # savepoint. `AtomicMiddleware` rolls back when a view raises
                #, but a caller that catches this and RETURNS -- an
                # error response, or a task/command that logs and carries on
                # -- commits by design, and would commit the row without its
                # job. This makes "no committed row without its job" hold
                # whatever the caller does with the exception.
                transaction.set_rollback(True, using=using)
            raise
    # Another open transaction is inserting the same queueing lock. The
    # savepoint rolled back (which also reverted our lock_timeout).
    logger.warning(
        "enqueue for %s waited on another transaction's queueing lock %s; "
        "falling back to an on-commit enqueue",
        deferrer.job.task_name, deferrer.job.queueing_lock,
        extra={
            "event": "procrastinate_enqueue_lock_contended",
            "task": deferrer.job.task_name,
            "queueing_lock": deferrer.job.queueing_lock,
        },
    )
    _on_commit_fallback(deferrer, using, task_kwargs)
    return None


def _on_commit_fallback(deferrer, using, task_kwargs) -> None:
    """Re-try the enqueue after COMMIT; a still-pending job satisfies it.

    ``robust=True``: the write has committed by then, and a failure here must
    be logged, not turned into a 500 that invites the client to redo it.
    """
    def fallback():
        try:
            # A savepoint even here: after a real COMMIT this runs in
            # autocommit and the atomic is a plain transaction, but a caller
            # that runs on-commit hooks inside an open block (pytest's
            # `django_capture_on_commit_callbacks`, or a future nested use)
            # must not have its transaction aborted by an AlreadyEnqueued.
            with transaction.atomic(using=using):
                JobDeferrer(
                    job_manager=_job_manager(using), job=deferrer.job,
                ).defer(**task_kwargs)
        except AlreadyEnqueued:
            pass

    transaction.on_commit(fallback, using=using, robust=True)


def _restore_lock_timeout(conn, previous: str) -> None:
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT set_config('lock_timeout', %s, true)", [previous],
        )
