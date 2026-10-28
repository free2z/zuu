"""
Job leases  against a REAL procrastinate worker on real Postgres.

Nothing here mocks the queue, the worker or the database. Each test
builds a throwaway ``DjangoApp`` carrying the production
``PROCRASTINATE_WORKER_DEFAULTS`` (so the middleware under test is the
one production would run, wired the way production wires it), registers
one task on it, defers through the real ``.defer()`` path, and drives
``run_worker(wait=False)`` in-process exactly as ``manage.py
procrastinate worker`` does: the Django connector is swapped for the
psycopg worker connector, so the worker sees only COMMITTED rows. That
is why every worker-driving test is ``transaction=True``.

The lease table is now MIGRATED (``jobs/0004``, ): the
``lease_table`` fixture no longer creates or drops it, and every test
here runs against the schema the migration produced. Which is why
``test_lease_migration.py`` exists -- the middleware's SQL is written
against ``lease.LEASE_TABLE_DDL``, and nothing in THIS module can see a
difference between that constant and the migrated table, because the
middleware names every column in every statement. The two tests that
need the table absent take the ``no_lease_table`` fixture, which puts it
back.

WHAT EACH TEST WOULD MISS IF THE OTHERS WERE DELETED
----------------------------------------------------
* insert / beat / delete, sync and async: the signal itself. Without
  a beat that advances,  has nothing to read.
* fenced sync task writes nothing: the whole point of the token. Remove
  the after-task check in ``lease_middleware`` and the requeued row
  reads ``succeeded`` -- a reclaimed job silently recorded as done.
* fenced async task is cancelled AND writes nothing: procrastinate
  turns a bare cancellation into ``aborted``; the middleware must turn
  it into ``LeaseLost`` or the fence is recorded as an operator abort.
* the replacement attempt is left alone: without the persist skip, a
  fenced run whose task retries would ``retry_job`` the LIVE attempt
  that replaced it back to ``todo`` for a third worker (codex P1).
* a lease released between the beat's snapshot and its UPDATE is not a
  fence (codex P2): fencing it cancels a job in its own cleanup.
* lease SQL is bounded by ``lock_timeout`` (codex P3): a locked lease
  row must fail the beat, not wedge the one beat thread for good.
* a fence that lands between the last beat and exit is still a fence
  (codex round 2, P1): the exit DELETE is the last ownership check.
* two attempts of one job in one process are two leases (round 2, P2):
  releasing the fenced one must not stop beating its replacement, and
  the persist skip is per attempt, not per job id.
* the table-missing path opens no connection while the negative probe
  is fresh, and every lease connection is opened on the beat thread and
  never more than one at a time (round 2, P3: the budget).
* ``NEVER`` -> ``deadline_at IS NULL``: a deadline on a task the
  registry says must never be requeued would make  fail it.
* the registry: a settings edit that drops the middleware or the two
  heartbeat numbers leaves every test above green (they build their own
  app) while production runs unleased.
* connection count: the beat thread opening a Django ORM connection
  would be invisible to every other test and cost a pooled connection
  per running job in production.
* table missing -> jobs still run: the state production was in between
   and jobs/0004, and the state any environment is in whose
  migrations have not caught up with its image.
* an exit DELETE that outlives its hand-off deadline is waited for, not
  abandoned (fresh-reviewer HIGH, round 1): the thread had started it,
  so it lands, and abandoning it means deciding "fence or not" without
  the one fact that decides it. Without the wait, attempt 1 removes our
  row after ``release`` gave up on it, attempt 2 finds nothing, and a
  job that already did its work (charged the customer) is fenced by
  ITSELF and stranded in ``doing`` for the reclaimer to run again.
* an unverified exit whose DELETE lands AFTER the decision leaves a
  lease behind to go silent (fresh-reviewer MEDIUM, round 2): without
  the re-INSERT the job is a ``doing`` row with no lease on a live
  worker, which no path reclaims -- a ``NEVER`` task is never recovered.
* an exit DELETE that committed and lost its response is ``unverified``,
  not an ``exit`` fence (codex, round 3 on the fix round): the retry's
  "nothing removed" behind a started-and-raised attempt is our own
  doing, and an ``exit`` fence there leaves nothing for anyone to find.
* the recovery after an uncertain DELETE is retried through the outage
  (codex, round 4): fire-and-forget, it died on the outage it exists
  for.
* the middleware is inert until the reclaimer reads leases (codex,
  round 4): a fence with nobody to find the job is risk without
  benefit, and the gate is code, so it lifts itself when  lands.
* an INSERT that fails is not permission to run (codex, round 8): the
  run is fenced before it starts and a lease is left to go silent;
  run unleased, a stale attempt whose INSERT errored would execute and
  persist over its replacement.
* acquisition waits for an uncommitted requeue (codex, round 8): a
  snapshot read leases a job the reclaimer is moving to ``todo``.
* a status write that raises after the lease was released leaves a
  lease behind (codex, round 9): otherwise a `doing` row with no lease
  on a live worker, which no reclaimer path reaches.
* a stale attempt cannot take over its replacement's lease, nor lease a
  job its replacement already finished (codex, rounds 6 and 7):
  acquisition is checked against the JOB ROW (``doing`` at this attempt
  number) and against a newer lease, and a refused attempt runs no body
  -- the fence that precedes the duplicate.
* the fence's check-and-set and a replacement's registration are one
  critical section (round 2 LOW): interleaved, the replacement inherits
  the fenced run's abort flag.
* a fenced run pops only the abort flag its own fence set (round 2
  LOW): an operator's abort is not erased by a fence.
* the silence threshold outlives a Cloud SQL failover: a threshold
  shorter than one would fence every in-flight job on every healthy
  worker from a maintenance event.
* a beat that could not run is not a fence, and it IS the event the
  ``procrastinate_lease_beat_failed`` metric counts; a fence IS the
  event the ``procrastinate_lease_fenced`` metric counts. Reword either
  side alone and the policy is green, enabled and un-fireable.
* concurrent queued acquisition timeouts do not restart a worker while
  an active batch is still progressing; an acquisition that remains
  unanswered past its batch deadline does trigger bounded recovery.
* a fence whose replacement runs on another pod does not leak its job id
  into ``flagged_job_ids`` for the life of the process.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace

import os
import psycopg
import pytest
from asgiref.sync import async_to_sync
from django.conf import settings as django_settings
from django.db import connection, connections, transaction
from django.utils import timezone
from procrastinate import worker as procrastinate_worker
from procrastinate.contrib.django import DjangoApp, app
from procrastinate.contrib.django.models import ProcrastinateJob
from procrastinate.middleware import is_async_middleware

from dj.apps.jobs import lease, reclaim, reclaim_policy

QUEUE = 'lease-test'
#Fast beats so a test runs in seconds; the production value is 15.
BEAT = 0.4
#How long a test is willing to WAIT for a fence to be observed --
#deliberately NOT scaled by BEAT. ``8 * BEAT`` (3.2s) used to
#be the budget for "the beat thread notices the reclaimer's DELETE and
#delivers the fence" (a beat, a DB round trip, and -- for the async task
#-- an event-loop callback all have to land inside it), and under a full
#or parallel test run the OS scheduler can starve the beat thread or the
#event loop for longer than that even though nothing is broken: the beat
#interval is what the thread is TOLD to wake up at, not a guarantee of
#when it actually runs. The three tests that wait for a fence this way
#(``test_fenced_sync_task_is_recorded_failed_not_succeeded``,
#``test_fenced_async_task_is_cancelled_and_recorded_failed``,
#``test_fenced_run_never_touches_the_attempt_that_replaced_it``) now wait
#up to this generous ceiling instead. It costs nothing in the common
#case -- the fence still lands within a beat or two and the sync tests
#poll out early, the async one's sleep is cancelled early -- and only
#matters when the host is contended, which is exactly when the old
#budget flaked. Proven deterministically (no real load needed) by
#monkeypatching ``lease.beat_seconds`` to a slow interval: at ``8 * BEAT``
#the fence reliably misses the window; at this ceiling it reliably lands.
FENCE_WAIT_SECONDS = 20.0
LOGGER = 'dj.apps.jobs.lease'




@pytest.fixture(autouse=True)
def _cleanup_unmanaged_lease_test_jobs(request):
    """Remove only queue rows this test created from the reused test DB.

    Procrastinate's queue tables are unmanaged by Django, so a normal test
    flush does not clear them. Snapshot IDs per test and remove only the new
    rows afterward; fixed lease-test IDs from an existing database remain
    outside this test's cleanup scope.
    """
    if request.node.get_closest_marker('django_db') is None:
        yield
        return
    request.getfixturevalue('db')
    before = set(ProcrastinateJob.objects.values_list('id', flat=True))
    yield
    owned = list(set(ProcrastinateJob.objects.values_list(
        'id', flat=True)) - before)
    if not owned:
        return
    errors = []
    for statement in (
            'DELETE FROM jobs_joblease WHERE job_id = ANY(%s)',
            'DELETE FROM jobs_quarantined_job WHERE job_id = ANY(%s)',
            'DELETE FROM procrastinate_jobs WHERE id = ANY(%s)'):
        try:
            with connection.cursor() as cursor:
                cursor.execute(statement, [owned])
        except Exception as exc:  # noqa: BLE001 -- try every owned table
            errors.append(exc)
    if errors:
        raise RuntimeError(
            f'failed to clean this test\'s lease job ids {owned}: '
            + '; '.join(repr(error) for error in errors)
        ) from errors[0]


# ---------------------------------------------------------------------------
# fixtures and helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def fast_beats(settings):
    settings.JOB_LEASE_BEAT_SECONDS = BEAT
    settings.JOB_LEASE_TABLE_RECHECK_SECONDS = 0
    settings.JOB_LEASE_ENABLED = True
    settings.JOB_LEASE_WITHOUT_RECLAIMER = True   #  is not here yet
    lease.reset_for_tests()
    yield
    lease.reset_for_tests()


@pytest.fixture
def lease_table(fast_beats):
    """The table is MIGRATED now (jobs/0004, ) -- do not build it.

    This fixture used to ``CREATE TABLE`` from ``lease.LEASE_TABLE_DDL``
    and ``DROP`` it again, because the table was not in the migration
    graph. Both halves have to go, and the DROP is the dangerous one: it
    would delete a MIGRATED table out from under every later test in the
    session (pytest-django truncates between tests, it does not
    re-migrate), so the module that happened to run next would fail with
    ``relation "jobs_joblease" does not exist`` and nothing would point
    at this fixture. Keeping only the CREATE would be quietly wrong too:
    ``IF NOT EXISTS`` makes it a no-op, so a migration that drifted from
    the DDL would still be what every test below runs against -- which
    is exactly the gap ``test_lease_migration.py`` closes.

    What remains is the state reset, which is what these tests actually
    needed from it.
    """
    yield
    lease.reset_for_tests()


@pytest.fixture
def no_lease_table(fast_beats):
    """The pre-migration state -- and PUT IT BACK.

    Since jobs/0004 the table is in every test database, so a test about
    the table being missing has to drop it, and dropping it without
    restoring it breaks every module that runs after this one in the
    same session. It is rebuilt from ``lease.LEASE_TABLE_DDL`` rather
    than by re-running the migration (which pytest-django will not do
    mid-session); ``test_lease_migration.py`` is what makes those two
    interchangeable.

    Which is why nothing may CHECK the migration by reading the live
    ``jobs_joblease``: after this fixture, that table is the DDL's, so
    such a check would be DDL vs. DDL and could not fail.
    ``test_migrated_table_is_indistinguishable_from_the_ddl`` therefore
    builds both of its tables itself.
    """
    with connection.cursor() as cursor:
        cursor.execute(f'DROP TABLE IF EXISTS {lease.LEASE_TABLE}')
    yield
    lease.reset_for_tests()
    with connection.cursor() as cursor:
        cursor.execute(lease.LEASE_TABLE_DDL)


def _worker_app() -> DjangoApp:
    """A throwaway app wired exactly like production's worker."""
    return DjangoApp(
        connector=app.connector,
        worker_defaults=dict(django_settings.PROCRASTINATE_WORKER_DEFAULTS),
    )


def _run_worker(test_app: DjangoApp) -> None:
    """What ``manage.py procrastinate worker`` does, minus the CLI."""
    with test_app.replace_connector(
            app.connector.get_worker_connector()) as worker_app:
        worker_app.run_worker(
            wait=False,
            install_signal_handlers=False,
            listen_notify=False,
            queues=[QUEUE],
            name='lease-test-worker',
        )


@contextmanager
def _raw():
    """A psycopg connection of our own -- usable from any thread or loop."""
    params = lease._connection_params()
    assert params is not None, 'these tests need real Postgres (DBHOST)'
    with lease._connect(params, 'lease-test') as conn:
        yield conn


def _row(job_id: int) -> dict | None:
    with _raw() as conn:
        row = conn.execute(
            f'SELECT job_id, token, worker_name, pod, task_name, queue, '
            f'started_at, last_beat_at, deadline_at, attempt '
            f'FROM {lease.LEASE_TABLE} WHERE job_id = %s',
            (job_id,),
        ).fetchone()
    if row is None:
        return None
    keys = ['job_id', 'token', 'worker_name', 'pod', 'task_name', 'queue',
            'started_at', 'last_beat_at', 'deadline_at', 'attempt']
    return dict(zip(keys, row))


def _delete_row(job_id: int) -> int:
    """What the reclaimer  does when it decides this worker is dead."""
    with _raw() as conn:
        return conn.execute(
            f'DELETE FROM {lease.LEASE_TABLE} WHERE job_id = %s', (job_id,)
        ).rowcount


def _reclaim(job_id: int) -> None:
    """
    What the reclaimer  does, in its order: fence the lease, then
    requeue the job through JobManager (todo, attempts + 1).
    """
    assert _delete_row(job_id) == 1
    app.job_manager.retry_job_by_id(job_id, retry_at=timezone.now())


def _status(job_id: int) -> str:
    return ProcrastinateJob.objects.get(id=job_id).status


def _attempts(job_id: int) -> int:
    return ProcrastinateJob.objects.get(id=job_id).attempts


def _job_row(job_id: int, *, status: str = 'doing', attempts: int = 0,
             task_name: str = 'lease_test.fake') -> None:
    """
    The authoritative job row acquisition checks against: what
    ``fetch_job`` leaves behind (``doing``, this attempt number), or
    what a requeue / finish moved it to.
    """
    with _raw() as conn:
        conn.execute(
            'INSERT INTO procrastinate_jobs '
            '(id, queue_name, task_name, status, attempts) '
            'VALUES (%s, %s, %s, %s, %s) ON CONFLICT (id) DO UPDATE SET '
            'status = EXCLUDED.status, attempts = EXCLUDED.attempts',
            (job_id, QUEUE, task_name, status, attempts))


def _fake_context(job_id: int, task_name: str = 'lease_test.fake',
                  attempts: int = 0, job_row: bool = True):
    """A ``JobContext`` stand-in; by default also the job row the worker
    would have fetched (``doing`` at ``attempts``)."""
    if job_row:
        _job_row(job_id, attempts=attempts, task_name=task_name)
    return SimpleNamespace(
        job=SimpleNamespace(id=job_id, task_name=task_name, queue=QUEUE,
                            attempts=attempts),
        start_timestamp=time.time(),
        worker_name='fake-worker',
    )


def _fake_worker():
    return SimpleNamespace(_job_ids_to_abort={})


def _events(caplog, event: str) -> list[dict]:
    found = []
    for record in caplog.records:
        if record.name != LOGGER:
            continue
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if payload.get('event') == event:
            found.append(payload)
    return found


# ---------------------------------------------------------------------------
# the registry: production is wired, and procrastinate accepts the wiring
# ---------------------------------------------------------------------------

def test_worker_defaults_name_the_middleware_and_both_heartbeat_numbers():
    defaults = django_settings.PROCRASTINATE_WORKER_DEFAULTS
    assert defaults['update_heartbeat_interval'] == 10
    assert defaults['stalled_worker_timeout'] == 60
    assert defaults['task_middleware'] == [
        lease.queue_pause_middleware,
        lease.queue_pause_middleware_async,
        lease.lease_middleware,
        lease.lease_middleware_async,
    ]
    # One of each kind, so procrastinate's per-task kind filter
    # (worker.py:242-259) gives every task exactly one lease middleware.
    assert not is_async_middleware(lease.lease_middleware)
    assert is_async_middleware(lease.lease_middleware_async)
    assert not is_async_middleware(lease.queue_pause_middleware)
    assert is_async_middleware(lease.queue_pause_middleware_async)


def test_django_contrib_passes_the_defaults_to_the_live_app():
    """The contrib's create_app forwards WORKER_DEFAULTS (apps.py:44)."""
    live = app.worker_defaults
    assert live['update_heartbeat_interval'] == 10
    assert live['stalled_worker_timeout'] == 60
    assert lease.lease_middleware in live['task_middleware']
    assert lease.lease_middleware_async in live['task_middleware']


def test_worker_accepts_the_defaults_as_init_kwargs():
    """
    These are Worker.__init__ kwargs, not CLI flags: prove the exact keys
    in the setting are the ones the 3.9 Worker takes, so a rename
    upstream is a red test rather than a TypeError at pod start.
    """
    test_app = _worker_app()
    worker = procrastinate_worker.Worker(
        app=test_app, **test_app.worker_defaults)
    assert worker.update_heartbeat_interval == 10
    assert worker.stalled_worker_timeout == 60
    assert lease.lease_middleware in worker.task_middleware
    assert lease.lease_middleware_async in worker.task_middleware
    # The fence relies on this dict being what context.should_abort()
    # reads (worker.py:421, 535)...
    assert isinstance(worker._job_ids_to_abort, dict)
    #...and on this seam being where a run's status is written
    # (worker.py:165-190, called by keyword from _process_job).
    persist = worker._persist_job_status
    assert inspect.iscoroutinefunction(persist)
    assert set(inspect.signature(persist).parameters) == {
        'job', 'status', 'retry_decision', 'context', 'job_result'}


def test_stale_threshold_outlives_a_cloud_sql_failover():
    """
    Fresh-reviewer MEDIUM. The reclaimer's silence threshold is a
    number, declared in settings and read here, and it must exceed a
    Cloud SQL failover plus the one beat and one hand-off it takes to
    notice the database is back -- otherwise a maintenance event fences
    every in-flight job on every healthy worker at once. Negative
    control: set JOB_LEASE_STALE_SECONDS to 60 (the number 's text
    carries today) and the first inequality fails.
    """
    stale = lease.stale_seconds()
    outage = (lease.CLOUD_SQL_FAILOVER_BUDGET_SECONDS
              + lease.beat_seconds() + lease.handoff_timeout_seconds())
    assert stale >= outage, (
        f'a {lease.CLOUD_SQL_FAILOVER_BUDGET_SECONDS:.0f}s failover leaves '
        f'every lease un-beaten for up to {outage:.0f}s; a threshold of '
        f'{stale:.0f}s would fence them all')
    #...and it is several beats, and more than the exit path's own wait.
    assert stale >= 4 * lease.beat_seconds()
    assert stale > lease.RELEASE_ATTEMPTS * lease.handoff_timeout_seconds()
    #...even when every attempt is a started statement waited for to its
    # batch deadline (the exit path's true worst case).
    assert stale > lease.RELEASE_ATTEMPTS * (
        lease.batch_deadline_seconds(1) + lease.OUTCOME_MARGIN_SECONDS)
    # A cleanup retried once per tick outlives a failover too.
    assert lease.CLEANUP_ATTEMPTS * lease.beat_seconds() >= (
        lease.CLOUD_SQL_FAILOVER_BUDGET_SECONDS + lease.beat_seconds())
    # The number itself, so a quiet edit in settings.py is a visible one.
    assert stale == django_settings.JOB_LEASE_STALE_SECONDS == 180


def test_queued_acquire_timeouts_do_not_restart_while_active_batch_progresses(
    mocker,
):
    restart = mocker.patch.object(lease, '_request_worker_restart')
    lease._record_acquire_outcome(None)
    beater = lease._Beater()
    active = lease._Op(lambda _conn: 'finished')
    active.started = True
    active.batch_deadline = time.monotonic() + 0.5
    active_result = []

    def finish_active_batch():
        time.sleep(0.05)
        active.result = 'finished'
        active.done.set()

    def wait_for_active_batch():
        active_result.append(beater.wait(active, timeout=0.01))

    finisher = threading.Thread(target=finish_active_batch)
    waiter = threading.Thread(target=wait_for_active_batch)
    finisher.start()
    waiter.start()
    for _ in range(3):
        queued = lease._Op(lambda _conn: None)
        with pytest.raises(lease.LeaseHandoffTimeout) as error:
            beater.wait(queued, timeout=0.01)
        lease._record_acquire_outcome(error.value)

    finisher.join(timeout=1)
    waiter.join(timeout=1)
    assert not finisher.is_alive()
    assert not waiter.is_alive()
    assert active_result == ['finished']
    lease._record_acquire_outcome(None)
    restart.assert_not_called()


def test_acquire_that_outlives_batch_deadline_requests_bounded_restart(
    mocker,
):
    restart = mocker.patch.object(lease, '_request_worker_restart')
    mocker.patch.object(lease, 'OUTCOME_MARGIN_SECONDS', 0.01)
    lease._record_acquire_outcome(None)
    beater = lease._Beater()
    stalled = lease._Op(lambda _conn: None)
    stalled.started = True
    stalled.batch_deadline = time.monotonic() + 0.03

    with pytest.raises(lease.LeaseOutcomeUnknown):
        beater.wait(stalled, timeout=0.005)
    lease._record_acquire_outcome(
        lease.LeaseOutcomeUnknown('still blocked past the batch deadline'))
    lease._record_acquire_outcome(
        lease.LeaseOutcomeUnknown('same stalled batch'))
    restart.assert_called_once_with()

    # A later successful acquisition proves progress resumed and permits one
    # restart signal for a separate future stall.
    lease._record_acquire_outcome(None)
    lease._record_acquire_outcome(
        lease.LeaseOutcomeUnknown('a later stalled batch'))
    assert restart.call_count == 2


def test_queued_acquire_restarts_after_beat_or_release_batch_is_stuck(mocker):
    restart = mocker.patch.object(lease, '_request_worker_restart')
    mocker.patch.object(lease, 'OUTCOME_MARGIN_SECONDS', 0.01)
    lease._record_acquire_outcome(None)
    beater = lease._Beater()
    with beater._lock:
        beater._active_batch_deadline = time.monotonic() - 0.02

    with pytest.raises(lease.LeaseHandoffTimeout):
        beater.wait(lease._Op(lambda _conn: None), timeout=0)
    lease._record_acquire_outcome(
        lease.LeaseHandoffTimeout('queued behind a blocked release'),
        beater=beater)
    lease._record_acquire_outcome(
        lease.LeaseHandoffTimeout('same blocked batch'), beater=beater)

    restart.assert_called_once_with()


def test_parallel_fence_persist_wrapper_install_is_serialized():
    calls = []

    class Worker:
        def __init__(self):
            self.captures = 0
            self.original = self.persist
            self.installed = None
            self._job_ids_to_abort = {}

        @property
        def _persist_job_status(self):
            self.captures += 1
            return self.installed or self.original

        @_persist_job_status.setter
        def _persist_job_status(self, value):
            self.installed = value

        async def persist(self, **kwargs):
            calls.append(kwargs)

    worker = Worker()
    barrier = threading.Barrier(12)

    def install():
        barrier.wait(timeout=5)
        lease._install_fence_aware_persist(worker)

    installers = [threading.Thread(target=install) for _ in range(12)]
    for thread in installers:
        thread.start()
    for thread in installers:
        thread.join(timeout=5)

    assert all(not thread.is_alive() for thread in installers)
    assert worker.captures == 1
    assert getattr(worker, lease._PERSIST_INSTALLED) is True

    fenced = lease.Lease(
        job_id=812301, token=uuid.uuid4(), task_name='lease_test.parallel',
        queue=QUEUE, worker=worker)
    fenced.lost.set()
    live = lease.Lease(
        job_id=812302, token=uuid.uuid4(), task_name='lease_test.parallel',
        queue=QUEUE, worker=worker)
    wrapper = worker.installed
    async_to_sync(wrapper)(
        context=SimpleNamespace(additional_context={
            lease.LEASE_CONTEXT_KEY: fenced}), status='failed')
    async_to_sync(wrapper)(
        context=SimpleNamespace(additional_context={
            lease.LEASE_CONTEXT_KEY: live}), status='succeeded')
    assert len(calls) == 1
    assert calls[0]['context'].additional_context[
        lease.LEASE_CONTEXT_KEY] is live


# ---------------------------------------------------------------------------
# insert / beat / delete
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_sync_task_lease_is_inserted_beaten_and_deleted(lease_table):
    test_app = _worker_app()
    seen: dict = {}

    @test_app.task(name='lease_test.sync_sleeper', queue=QUEUE,
                   pass_context=True)
    def sync_sleeper(context):
        seen['early'] = _row(context.job.id)
        time.sleep(2.5 * BEAT)
        seen['late'] = _row(context.job.id)
        seen['registered'] = [
            item.job_id for item in lease._beater.snapshot()]

    job_id = sync_sleeper.defer()
    _run_worker(test_app)

    assert _status(job_id) == 'succeeded'
    early, late = seen['early'], seen['late']
    assert early is not None, 'no lease row while the task ran'
    assert early['task_name'] == 'lease_test.sync_sleeper'
    assert early['queue'] == QUEUE
    assert early['worker_name'] == 'lease-test-worker'
    assert early['pod']
    assert late['token'] == early['token']
    assert late['last_beat_at'] > early['last_beat_at'], (
        'last_beat_at did not advance across 2.5 beats')
    assert late['last_beat_at'] - early['last_beat_at'] >= (
        timedelta(seconds=BEAT))
    assert seen['registered'] == [job_id]
    # On exit: the row is gone and the beat thread has forgotten it.
    assert _row(job_id) is None
    assert lease._beater.snapshot() == []


@pytest.mark.django_db(transaction=True)
def test_async_task_lease_is_inserted_beaten_and_deleted(lease_table):
    test_app = _worker_app()
    seen: dict = {}

    @test_app.task(name='lease_test.async_sleeper', queue=QUEUE,
                   pass_context=True)
    async def async_sleeper(context):
        seen['early'] = await asyncio.to_thread(_row, context.job.id)
        await asyncio.sleep(2.5 * BEAT)
        seen['late'] = await asyncio.to_thread(_row, context.job.id)

    job_id = async_sleeper.defer()
    _run_worker(test_app)

    assert _status(job_id) == 'succeeded'
    early, late = seen['early'], seen['late']
    assert early is not None
    assert late['last_beat_at'] > early['last_beat_at']
    assert _row(job_id) is None
    assert lease._beater.snapshot() == []


@pytest.mark.django_db(transaction=True)
def test_lease_is_deleted_when_the_task_raises(lease_table):
    test_app = _worker_app()

    @test_app.task(name='lease_test.boom', queue=QUEUE)
    def boom():
        raise RuntimeError('task failed on its own')

    job_id = boom.defer()
    _run_worker(test_app)

    assert _status(job_id) == 'failed'
    assert _row(job_id) is None
    assert lease._beater.snapshot() == []


# ---------------------------------------------------------------------------
# the fence
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_fenced_sync_task_is_recorded_failed_not_succeeded(
        lease_table, caplog):
    """
    The reclaimer fences the lease and requeues the job mid-run (attempt
    A). The next beat finds 0 rows, ``context.should_abort()`` flips,
    and even though A's body RETURNS NORMALLY, A writes nothing. The
    same worker then fetches the reclaimer's requeue and runs attempt B,
    which succeeds: one success, one fence -- exactly the handover.
    ``attempts`` reads 2 and both are procrastinate's own: the
    reclaimer's ``retry_job`` (+1) and B's ``finish_job`` from ``doing``
    (+1, ``schema.sql:282``); A, which was fenced, added nothing.

    Negative control (one line, by hand): delete the
    ``if lease.lost.is_set(): raise`` after ``call_next()`` in
    ``lease_middleware`` and A's return is recorded ``succeeded`` over
    the requeued row.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    test_app = _worker_app()
    seen: dict = {}

    @test_app.task(name='lease_test.fenced_sync', queue=QUEUE,
                   pass_context=True)
    def fenced_sync(context):
        if context.job.attempts > 0:
            seen['b_ran'] = True
            return 'attempt B'
        _reclaim(context.job.id)
        deadline = time.monotonic() + FENCE_WAIT_SECONDS
        while not context.should_abort() and time.monotonic() < deadline:
            time.sleep(0.02)
        seen['should_abort'] = context.should_abort()
        return 'finished normally'

    job_id = fenced_sync.defer()
    _run_worker(test_app)

    assert seen['should_abort'] is True, (
        'the fence did not flip context.should_abort() for the sync task')
    # A wrote nothing (it would have written `failed`); B, the reclaimer's
    # requeue, is the one success and the only attempt counted.
    assert seen['b_ran'] is True
    assert _status(job_id) == 'succeeded'
    assert _attempts(job_id) == 2
    fenced = _events(caplog, 'procrastinate_lease_fenced')
    assert [event['job_id'] for event in fenced] == [job_id]
    assert fenced[0]['task'] == 'lease_test.fenced_sync'
    assert fenced[0]['detected'] == 'beat'
    skipped = _events(caplog, 'procrastinate_lease_persist_skipped')
    assert [(e['job_id'], e['would_have_written']) for e in skipped] == [
        (job_id, 'failed')]
    assert _row(job_id) is None
    assert lease._beater.snapshot() == []


@pytest.mark.django_db(transaction=True)
def test_fenced_async_task_is_cancelled_and_recorded_failed(
        lease_table, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    test_app = _worker_app()
    seen: dict = {}

    @test_app.task(name='lease_test.fenced_async', queue=QUEUE,
                   pass_context=True)
    async def fenced_async(context):
        if context.job.attempts > 0:
            seen['b_ran'] = True
            return 'attempt B'
        await asyncio.to_thread(_reclaim, context.job.id)
        try:
            await asyncio.sleep(FENCE_WAIT_SECONDS)
        except asyncio.CancelledError:
            seen['cancelled'] = True
            raise
        seen['ran_to_completion'] = True

    job_id = fenced_async.defer()
    _run_worker(test_app)

    assert seen.get('cancelled') is True, 'the fence did not cancel the task'
    assert 'ran_to_completion' not in seen
    # procrastinate would record a bare cancellation as `aborted`
    # (worker.py:356-359); the middleware turns it into LeaseLost, and
    # the fenced run then writes nothing over the requeued row, which
    # the same worker picks up as attempt B.
    assert seen['b_ran'] is True
    assert _status(job_id) == 'succeeded'
    assert _attempts(job_id) == 2
    assert [e['job_id'] for e in _events(caplog, 'procrastinate_lease_fenced')
            ] == [job_id]
    assert [e['would_have_written'] for e in
            _events(caplog, 'procrastinate_lease_persist_skipped')] == [
        'failed']
    assert lease._beater.snapshot() == []


@pytest.mark.django_db(transaction=True)
def test_fenced_sync_task_that_raises_is_still_failed_with_the_fence_as_cause(
        lease_table):
    test_app = _worker_app()

    @test_app.task(name='lease_test.fenced_then_raises', queue=QUEUE,
                   pass_context=True)
    def fenced_then_raises(context):
        if context.job.attempts > 0:
            return 'attempt B'
        _reclaim(context.job.id)
        time.sleep(3 * BEAT)
        raise ValueError('the task noticed on its own')

    job_id = fenced_then_raises.defer()
    _run_worker(test_app)
    # Neither the ValueError nor LeaseLost is written over the requeue;
    # attempt B is the outcome.
    assert _status(job_id) == 'succeeded'
    assert _attempts(job_id) == 2
    assert _row(job_id) is None


@pytest.mark.django_db(transaction=True)
def test_fenced_run_never_touches_the_attempt_that_replaced_it(
        lease_table, caplog):
    """
    codex P1. Attempt A is fenced; the reclaimer requeues; worker B
    fetches the job (``doing`` again, B's own lease token) while A is
    still finishing. A's task has a retry strategy, so without the
    persist skip procrastinate would ``retry_job`` B's LIVE row back to
    ``todo`` for a third worker -- a duplicate billed call in the real
    registry. With it, B's row and B's lease are untouched.

    Negative control: revert ``_install_fence_aware_persist`` and this
    reads ``todo`` with ``attempts == 2``.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    test_app = _worker_app()
    b_token = uuid.uuid4()

    @test_app.task(name='lease_test.replaced', queue=QUEUE,
                   pass_context=True, retry=2)
    def replaced(context):
        job_id = context.job.id
        if context.job.attempts > 0:
            # Only reachable when the fenced run wrote over B's row and
            # the worker refetched it: the negative control's outcome.
            return 'a third attempt ran'
        _reclaim(job_id)
        # Worker B fetches the requeued job and takes its own lease: the
        # same two writes fetch_job + this middleware would make.
        with _raw() as conn:
            conn.execute(
                "UPDATE procrastinate_jobs SET status = 'doing' "
                'WHERE id = %s', (job_id,))
            conn.execute(
                lease._INSERT_SQL,
                {
                    'job_id': job_id, 'token': b_token,
                    'worker_name': 'worker-b', 'pod': 'pod-b',
                    'task_name': 'lease_test.replaced', 'queue': QUEUE,
                    'started_at': timezone.now(), 'deadline_at': None,
                    'attempt': 1,       # the requeued attempt is newer
                },
            )
        deadline = time.monotonic() + FENCE_WAIT_SECONDS
        while not context.should_abort() and time.monotonic() < deadline:
            time.sleep(0.02)
        return 'A finished normally'

    job_id = replaced.defer()
    _run_worker(test_app)

    assert _status(job_id) == 'doing', 'A wrote over B\'s live attempt'
    assert _attempts(job_id) == 1
    b_row = _row(job_id)
    assert b_row is not None and b_row['token'] == b_token, (
        'B\'s lease was deleted or replaced by the fenced run')
    assert b_row['worker_name'] == 'worker-b'
    skipped = _events(caplog, 'procrastinate_lease_persist_skipped')
    assert len(skipped) == 1
    assert skipped[0]['would_have_retried'] is True
    # Leave the DB as a worker would not: nothing fetches a doing row.
    with _raw() as conn:
        conn.execute(
            "UPDATE procrastinate_jobs SET status = 'failed' WHERE id = %s",
            (job_id,))


@pytest.mark.django_db(transaction=True)
def test_a_lease_released_between_snapshot_and_beat_is_not_fenced(
        lease_table, caplog):
    """
    codex P2. The beat thread snapshots the registry, then the task
    finishes and releases its lease (unregister + DELETE) while the
    thread is still connecting. The UPDATE then returns no row for a
    lease that was released normally -- which must NOT be a fence.
    Alongside it, a lease that is still held and whose row is gone IS
    one (the positive control).
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    worker = _fake_worker()
    released = lease.acquire(_fake_context(910001), worker)
    still_held = lease.acquire(_fake_context(910002), worker)
    assert released is not None and still_held is not None
    stale_snapshot = [released, still_held]

    lease.release(released)                       # the task finished
    assert _delete_row(still_held.job_id) == 1    # the reclaimer fenced

    with _raw() as conn:
        fenced = lease._beater.beat(conn, stale_snapshot)

    assert fenced == {still_held.job_id}
    assert not released.lost.is_set()
    assert still_held.lost.is_set()
    assert worker._job_ids_to_abort == {
        still_held.job_id: procrastinate_worker.job_context.AbortReason
        .USER_REQUEST}
    assert [e['job_id'] for e in _events(caplog, 'procrastinate_lease_fenced')
            ] == [still_held.job_id]
    lease.release(still_held)


@pytest.mark.django_db(transaction=True)
def test_fence_between_last_beat_and_exit_is_still_a_fence(
        lease_table, caplog):
    """
    codex round 2, P1. The reclaimer fences and requeues, and attempt A
    finishes BEFORE its next beat, so no beat ever saw the loss. A's
    exit DELETE removes no row: that is the fence, the outcome becomes
    ``LeaseLost``, and A still writes nothing. The same worker then runs
    the requeue as attempt B.

    Negative control: ignore the DELETE's rowcount in ``release`` and A
    records ``succeeded`` over the requeued row, B never runs.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    test_app = _worker_app()
    seen: dict = {}

    @test_app.task(name='lease_test.fenced_at_exit', queue=QUEUE,
                   pass_context=True)
    def fenced_at_exit(context):
        if context.job.attempts > 0:
            seen['b_ran'] = True
            return 'attempt B'
        _reclaim(context.job.id)
        return 'A finished at once'

    job_id = fenced_at_exit.defer()
    _run_worker(test_app)

    fenced = _events(caplog, 'procrastinate_lease_fenced')
    assert [(e['job_id'], e['detected']) for e in fenced] == [
        (job_id, 'exit')]
    assert [e['would_have_written'] for e in
            _events(caplog, 'procrastinate_lease_persist_skipped')] == [
        'failed']
    assert seen.get('b_ran') is True
    assert _status(job_id) == 'succeeded'
    assert _attempts(job_id) == 2
    assert _row(job_id) is None


@pytest.mark.django_db(transaction=True)
def test_two_attempts_of_one_job_in_one_process_are_two_leases(
        lease_table, caplog):
    """Releasing fenced attempt A must not unregister its replacement B.

    Current manifests use one slot per worker, but the process-global lease
    registry must also remain correct when a worker uses multiple slots.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    persisted: list = []

    async def original_persist(**kwargs):
        persisted.append(kwargs['context'].additional_context['who'])

    worker = SimpleNamespace(
        _job_ids_to_abort={}, _persist_job_status=original_persist)
    context_a = _fake_context(910010)
    context_a.additional_context = {'who': 'A'}
    context_b = _fake_context(910010)
    context_b.additional_context = {'who': 'B'}

    lease_a = lease.acquire(context_a, worker)
    lease_b = lease.acquire(context_b, worker)   # upserts the row: B's token
    assert lease_a is not None and lease_b is not None
    assert lease_a.token != lease_b.token
    assert set(lease._beater.snapshot()) == {lease_a, lease_b}
    assert context_a.additional_context[lease.LEASE_CONTEXT_KEY] is lease_a
    assert context_b.additional_context[lease.LEASE_CONTEXT_KEY] is lease_b

    # A's next beat finds B's token on the row: A is fenced, B is not.
    with _raw() as conn:
        assert lease._beater.beat(conn, [lease_a, lease_b]) == {910010}
    assert lease_a.lost.is_set() and not lease_b.lost.is_set()
    assert lease_b.beats == 1
    # procrastinate's abort flag is job-scoped (round 4, P3): fencing A
    # must not make B's context.should_abort() true.
    assert worker._job_ids_to_abort == {}

    # Releasing the fenced A leaves B registered and B's row in place.
    assert lease.release(lease_a) is False
    assert lease._beater.snapshot() == [lease_b]
    assert _row(910010)['token'] == lease_b.token

    # The persist skip is A's alone.
    import asyncio as _asyncio
    _asyncio.run(worker._persist_job_status(
        job=context_a.job, status=SimpleNamespace(value='failed'),
        retry_decision=None, context=context_a, job_result=None))
    _asyncio.run(worker._persist_job_status(
        job=context_b.job, status=SimpleNamespace(value='succeeded'),
        retry_decision=None, context=context_b, job_result=None))
    assert persisted == ['B']
    assert [e['job_id'] for e in
            _events(caplog, 'procrastinate_lease_persist_skipped')] == [
        910010]

    assert lease.release(lease_b) is True
    assert _row(910010) is None


@pytest.mark.django_db(transaction=True)
def test_replacement_starting_after_the_fence_does_not_inherit_the_abort_flag(
        lease_table):
    """
    Round 4, P3, the other order: A is fenced first (its abort flag IS
    set, nobody else holds the job here), then the replacement B starts
    in the same process. B must not read A's flag.
    """
    worker = _fake_worker()
    lease_a = lease.acquire(_fake_context(910011), worker)
    assert lease_a is not None
    assert _delete_row(910011) == 1
    with _raw() as conn:
        assert lease._beater.beat(conn, [lease_a]) == {910011}
    assert worker._job_ids_to_abort == {
        910011: procrastinate_worker.job_context.AbortReason.USER_REQUEST}

    lease_b = lease.acquire(_fake_context(910011), worker)
    assert lease_b is not None
    assert worker._job_ids_to_abort == {}, 'B inherited the fenced A\'s flag'
    assert lease.release(lease_a) is False
    assert lease.release(lease_b) is True




class _ReleaseHook:
    """
    ``_beater._lock`` with a hook that fires ONCE, on the first release
    of the lock by the thread named ``thread``, after the lock is free.
    A probe for a check-then-set: whatever the hook does lands between
    the critical section that just ended and whatever the thread does
    next outside it.
    """

    def __init__(self, inner, thread: str, hook) -> None:
        self._inner = inner
        self._thread = thread
        self._hook = hook
        self.fired = 0

    def __enter__(self):
        self._inner.acquire()
        return self

    def __exit__(self, *exc_info):
        self._inner.release()
        if (threading.current_thread().name == self._thread
                and self.fired == 0):
            self.fired += 1
            self._hook()
        return False


@pytest.mark.django_db(transaction=True)
def test_fence_check_and_set_is_atomic_with_a_replacement_registering(
        lease_table, monkeypatch):
    """
    Fresh-reviewer LOW (round 2). ``_request_abort`` asks "is another
    attempt of this job leased here?", then writes the job-scoped abort
    flag, then records that it did. A replacement attempt registering
    BETWEEN the check and the write sees no record, clears nothing, and
    inherits ``should_abort() == True`` from the run that was fenced.
    Forced here: the replacement registers the instant the fence's first
    critical section ends. One critical section (the fix) means that
    instant is after the write and the record, so the replacement clears
    the flag; split (the negative control: check under one lock
    acquisition, write, record under another), the replacement lands in
    the gap and the last assertion fails.
    """
    worker = _fake_worker()
    lease_a = lease.acquire(_fake_context(910030), worker)
    assert lease_a is not None
    assert _delete_row(910030) == 1          # the reclaimer took it
    lease_b = lease.Lease(
        job_id=910030, token=uuid.uuid4(), task_name='lease_test.fake',
        queue=QUEUE, worker=worker)           # the replacement, about to start

    def replacement_registers():
        t = threading.Thread(
            target=lease._beater.register, args=(lease_b,), name='probe-b')
        t.start()
        t.join(5)
        assert not t.is_alive()

    hook = _ReleaseHook(lease._beater._lock, 'probe-fence', replacement_registers)
    monkeypatch.setattr(lease._beater, '_lock', hook)
    fencer = threading.Thread(
        target=lease._fence, args=(lease_a,), kwargs={'detected': 'beat'},
        name='probe-fence')
    fencer.start()
    fencer.join(5)
    assert not fencer.is_alive()
    assert hook.fired == 1
    assert lease_a.lost.is_set()
    assert lease._beater.still_held(lease_b)
    assert worker._job_ids_to_abort == {}, (
        'the replacement attempt inherited the fenced run\'s abort flag')
    assert lease._beater.flagged_job_ids == set()
    lease._beater.unregister(lease_b)
    assert lease.release(lease_a) is False


@pytest.mark.django_db(transaction=True)
def test_a_fenced_run_does_not_erase_an_operator_abort(lease_table):
    """
    Fresh-reviewer LOW (round 2). The fence sets the abort flag only if
    none is there, so a flag that predates the fence is an OPERATOR's
    abort. The fenced run's skipped status write must not pop it: a
    replacement of the same job in this process would then run on past
    an abort somebody asked for. Negative control: pop unconditionally
    in ``persist_unless_fenced`` and the flag is gone.
    """
    persisted: list = []

    async def original_persist(**kwargs):
        persisted.append(kwargs['status'])

    worker = SimpleNamespace(
        _job_ids_to_abort={}, _persist_job_status=original_persist)
    context = _fake_context(910031)
    context.additional_context = {}
    held = lease.acquire(context, worker)
    assert held is not None
    abort = procrastinate_worker.job_context.AbortReason.USER_REQUEST
    worker._job_ids_to_abort[910031] = abort   # an operator, before the fence

    assert _delete_row(910031) == 1
    with _raw() as conn:
        assert lease._beater.beat(conn, [held]) == {910031}
    assert lease._beater.flagged_job_ids == set(), 'not ours to clear'
    assert lease.release(held) is False
    asyncio.run(worker._persist_job_status(
        job=context.job, status=SimpleNamespace(value='failed'),
        retry_decision=None, context=context, job_result=None))
    assert persisted == []
    assert worker._job_ids_to_abort == {910031: abort}, (
        'the fenced run erased an operator abort it did not set')




def test_async_acquire_waits_through_cancellation_and_releases(monkeypatch):
    """
    Round 4, P2. A shutdown cancels the async middleware while the
    INSERT is in flight. The cancellation must be delivered only after
    the acquisition has finished AND its lease has been released, so
    nothing is left for a late cleanup to delete from under a
    replacement, and procrastinate persists nothing before that.
    """
    events: list = []
    held = lease.Lease(job_id=1, token=uuid.uuid4(), task_name='t',
                       queue=QUEUE, worker=None)

    def slow_acquire(context, worker, **kwargs):
        time.sleep(0.4)
        events.append('acquired')
        return held

    def fake_release(_lease):
        events.append('released')
        return True

    monkeypatch.setattr(lease, 'acquire', slow_acquire)
    monkeypatch.setattr(lease, 'release', fake_release)

    async def main():
        async def body():
            events.append('body ran')

        async def runner():
            try:
                await lease.lease_middleware_async(body, None, None)
            except asyncio.CancelledError:
                events.append('cancelled')
                raise

        task = asyncio.create_task(runner())
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert events == ['acquired', 'released', 'cancelled']


@pytest.mark.django_db(transaction=True)
def test_lease_sql_is_bounded_by_lock_timeout(lease_table, settings, caplog):
    """
    codex P3. ``connect_timeout`` bounds the handshake, not a query. With
    someone else's transaction holding the lease row, the beat, the
    INSERT and the DELETE must each fail within ``lock_timeout`` -- the
    beat raising (the thread logs and retries next tick), the INSERT
    logging and running the job unleased, and the DELETE, after its one
    retry, FAILING CLOSED (round 3: a DELETE that cannot run proves
    neither ownership nor loss, so the run writes nothing) -- instead of
    blocking the beat thread or the task slot for as long as that
    transaction lives.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 0.3
    worker = _fake_worker()
    held = lease.acquire(_fake_context(910003), worker)
    assert held is not None

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT 1 FROM {lease.LEASE_TABLE} WHERE job_id = %s '
                'FOR UPDATE', [held.job_id])

        started = time.monotonic()
        # Whichever of the two timeouts fires first (they are equal here,
        # and statement_timeout starts counting earlier): bounded is the
        # property, not which error names it.
        with pytest.raises((psycopg.errors.LockNotAvailable,
                            psycopg.errors.QueryCanceled)):
            with _raw() as conn:
                lease._beater.beat(conn, [held])
        assert time.monotonic() - started < 3
        assert not held.lost.is_set(), 'a timeout is not a fence'

        started = time.monotonic()
        again = lease.acquire(_fake_context(held.job_id), worker)
        assert again is not None and again.lost.is_set(), (
            'the blocked INSERT must give up -- fenced, not run')
        assert time.monotonic() - started < 3
        assert _events(caplog, 'procrastinate_lease_insert_failed')
        assert [(e['detected'], e.get('reason')) for e in
                _events(caplog, 'procrastinate_lease_fenced')] == [
            ('acquire', 'unverified')]

        started = time.monotonic()
        assert lease.release(held) is False, (
            'a DELETE that cannot run proves nothing: fail closed')
        assert time.monotonic() - started < 3
        assert held.lost.is_set()
        assert [e['attempt'] for e in
                _events(caplog, 'procrastinate_lease_delete_failed')] == [1, 2]
        assert [e['detected'] for e in
                _events(caplog, 'procrastinate_lease_fenced')] == [
            'acquire', 'unverified']

    # The lock is gone; the row the DELETE could not reach is still there
    # for the reclaimer to find silent.
    assert _row(held.job_id) is not None
    assert _delete_row(held.job_id) == 1


@pytest.mark.django_db(transaction=True)
def test_lease_connection_bounds_the_transport_not_just_the_statement(
        settings, monkeypatch):
    """
    codex round 2 (on the fix round), P2. ``statement_timeout`` is
    enforced by the server; a socket that has gone black never delivers
    it, and the one beat thread would wedge in ``execute()`` with every
    lease in the process un-beaten and the beat-failure line never
    emitted. So the lease connection carries libpq keepalives and a
    ``tcp_user_timeout`` sized to the statement timeout, and libpq
    accepts them (a rejected parameter would fail every connect).
    Negative control: drop ``transport_bounds`` from
    ``_connection_params`` and the first assertion fails.
    """
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 5
    params = lease._connection_params()
    assert params is not None
    bounds = {key: params.get(key) for key in lease.transport_bounds()}
    assert bounds == {
        'keepalives': 1, 'keepalives_idle': 5, 'keepalives_interval': 2,
        'keepalives_count': 3, 'tcp_user_timeout': 10000}
    # Dead-peer detection is inside one silence threshold by a wide
    # margin, and inside a beat interval at the production numbers.
    detect = (bounds['keepalives_idle']
              + bounds['keepalives_interval'] * bounds['keepalives_count'])
    assert detect < lease.stale_seconds() / 4
    assert bounds['tcp_user_timeout'] / 1000 < lease.stale_seconds() / 4
    with _raw() as conn:                      # libpq accepted them
        assert conn.execute('SELECT 1').fetchone() == (1,)

    # An operator's DATABASES OPTIONS win over the defaults.
    from procrastinate.contrib.django import settings as proc_settings
    wrapper = connections[proc_settings.settings.DATABASE_ALIAS]
    real_params = wrapper.get_connection_params
    monkeypatch.setattr(
        wrapper, 'get_connection_params',
        lambda: dict(real_params(), keepalives_idle=30))
    assert lease._connection_params()['keepalives_idle'] == 30


@pytest.mark.django_db(transaction=True)
def test_a_server_that_never_answers_is_cut_by_the_batch_deadline(
        lease_table, settings, caplog):
    """
    codex round 4 (on the fix round), P2. Production reaches Cloud SQL
    through the sql-proxy sidecar: when its upstream stalls, the TCP
    session to the proxy stays healthy, keepalives are answered,
    ``tcp_user_timeout`` never fires, and ``statement_timeout`` is a
    server-side thing the stalled server never delivers. The one beat
    thread would sit in ``execute()`` for good: every lease silent, every
    exit unverified, the beat-failure line never emitted. Modelled here
    with a statement the server will not answer for 12s on a connection
    carrying NO server-side timeouts: the batch deadline (one hand-off +
    statement timeout x (ops + 1) + 2s -- always longer than a hand-off,
    so a merely slow statement still lands) closes the connection from
    outside, the thread lives, and the next hand-off works. Negative
    control: do not start the watchdog; the cut never comes and
    ``release`` times out twice on the stuck thread.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 0.3   # deadline = 4.9s
    assert lease.batch_deadline_seconds(1) == pytest.approx(4.9)
    assert lease.batch_deadline_seconds(0) > lease.handoff_timeout_seconds()
    held = lease.acquire(_fake_context(910024), _fake_worker())
    assert held is not None
    good = lease._connection_params()
    no_server_timeouts = dict(good)
    no_server_timeouts.pop('options', None)

    started = time.monotonic()
    lease._beater.run_later(
        lambda conn: psycopg.Connection.execute(conn, 'SELECT pg_sleep(12)'), no_server_timeouts)
    deadline = time.monotonic() + 9
    while (not _events(caplog, 'procrastinate_lease_batch_deadline')
           and time.monotonic() < deadline):
        time.sleep(0.05)
    cut = _events(caplog, 'procrastinate_lease_batch_deadline')
    assert cut, 'the stuck batch was never cut'
    elapsed = time.monotonic() - started
    assert 4.5 < elapsed < 8, elapsed
    assert cut[0]['ops'] == 1 and cut[0]['pod']
    assert not held.lost.is_set(), 'a batch that was cut is not a fence'

    # The thread is alive: the next hand-off runs on a fresh connection,
    # well before the server would have answered.
    lease._beater.run_later(lambda conn: None, good)
    assert lease.release(held) is True
    assert time.monotonic() - started < 11
    assert _events(caplog, 'procrastinate_lease_fenced') == []

    # Leave no backend sleeping on the table the next test will
    # truncate (a pg_sleep holding a row lock outlives this test).
    with _raw() as conn:
        conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE application_name = %s AND query LIKE 'SELECT pg_sleep%%'",
            (lease.APPLICATION_NAME,))


@pytest.mark.django_db(transaction=True)
def test_insert_executing_past_the_handoff_is_waited_for_and_leased(
        lease_table, settings, caplog, monkeypatch):
    """
    codex round 3, P2, as it stands after the round-2 fixes. The
    hand-off deadline passes while the thread is already executing the
    INSERT. A started statement is waited for (until its batch deadline)
    rather than abandoned: the INSERT lands, ``acquire`` returns the
    lease, the job runs LEASED, and the slow statement is logged. There
    is no row nobody beats to clean up, because nobody gave up on it.
    Negative control: cancel at the hand-off regardless of ``started``
    (the pre-fix ``wait``) and ``acquire`` returns ``None``.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 0.1   # hand-off = 2.1s
    assert lease.batch_deadline_seconds(1) == pytest.approx(4.3)
    real_check = lease._table.check
    delayed = {'done': False}

    def slow_check(conn):
        if not delayed['done']:
            delayed['done'] = True
            time.sleep(2.6)          # past the hand-off, inside the batch
        return real_check(conn)

    monkeypatch.setattr(lease._table, 'check', slow_check)

    started = time.monotonic()
    held = lease.acquire(_fake_context(910020), _fake_worker())
    elapsed = time.monotonic() - started
    assert held is not None, 'a started INSERT was abandoned'
    assert 2.5 < elapsed < 4.3, elapsed
    assert _events(caplog, 'procrastinate_lease_insert_failed') == []
    slow = _events(caplog, 'procrastinate_lease_statement_slow')
    assert [(e['statement'], e['job_id']) for e in slow] == [
        ('insert', 910020)]
    assert slow[0]['waited_seconds'] > slow[0]['handoff_seconds'] == 2.1
    assert lease._beater.snapshot() == [held]
    assert _row(910020)['token'] == held.token
    assert lease.release(held) is True
    assert _row(910020) is None


@pytest.mark.django_db(transaction=True)
def test_insert_that_outlives_even_the_batch_deadline_is_fenced_not_run(
        lease_table, settings, caplog, monkeypatch, mocker):
    """
    The original codex round 3, P2 scenario, in the only shape left
    after the wait above: the INSERT is started, the batch deadline
    passes, and the watchdog's cut does NOT unblock the thread (modelled
    by a ``_cut_batch`` that closes nothing). ``acquire`` gives up with
    ``LeaseOutcomeUnknown``. Ownership is unverified, so (codex round 8)
    the run is fenced before it starts rather than run unleased -- and
    the INSERT that still commits later leaves exactly the row the
    reclaimer needs: silent from its first second, nobody beating it,
    for a job whose body never ran. Negative control: return ``None``
    on the error (the pre-round-8 ``acquire``) and the run is not fenced.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    restart = mocker.patch.object(lease, '_request_worker_restart')
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 0.1
    # hand-off 2.1s; batch deadline 4.3s; outcome given up at 6.3s
    give_up_at = (lease.batch_deadline_seconds(1)
                  + lease.OUTCOME_MARGIN_SECONDS)
    assert give_up_at == pytest.approx(6.3)
    cuts: list = []
    monkeypatch.setattr(
        lease, '_cut_batch', lambda conn, ops, leases: cuts.append(len(ops)))
    real_check = lease._table.check
    delayed = {'done': False}

    def slow_check(conn):
        if not delayed['done']:
            delayed['done'] = True
            time.sleep(7.0)          # lands AFTER the waiter gave up
        return real_check(conn)

    monkeypatch.setattr(lease._table, 'check', slow_check)
    ran: list = []                     # (was cancelled when it ran, error)
    real_run_op = lease._Beater._run_op

    def recording_run_op(self, conn, op, batch_deadline=None):
        real_run_op(self, conn, op, batch_deadline)
        ran.append((op.cancelled, op.exc))

    monkeypatch.setattr(lease._Beater, '_run_op', recording_run_op)

    started = time.monotonic()
    held = lease.acquire(_fake_context(910020), _fake_worker())
    elapsed = time.monotonic() - started
    assert 6.0 < elapsed < 7.0, elapsed
    assert held is not None and held.lost.is_set(), (
        'an unverified acquisition is not permission to run')
    failed = _events(caplog, 'procrastinate_lease_insert_failed')
    assert failed and 'LeaseOutcomeUnknown' in failed[0]['error']
    assert [(e['detected'], e['reason']) for e in
            _events(caplog, 'procrastinate_lease_fenced')] == [
        ('acquire', 'unverified')]
    assert lease._beater.snapshot() == [], 'never registered, never beaten'
    assert cuts == [1], 'the watchdog fired (and, here, unblocked nothing)'
    restart.assert_called_once_with()

    # Let the late INSERT (t ~ 7s) and the re-INSERT behind it land.
    time.sleep(max(0.0, 9.0 - (time.monotonic() - started)))
    # The INSERT really did execute after its caller had given up -- it
    # was started, so it was never cancelled...
    assert ran and ran[0] == (False, None), ran
    #...the DO-NOTHING re-INSERT ran behind it and touched nothing...
    assert len(ran) == 2 and ran[1] == (False, None), ran
    #...and the row is there for the reclaimer, with our token.
    row = _row(910020)
    assert row is not None and row['token'] == held.token
    assert _events(caplog, 'procrastinate_lease_cleanup_failed') == []


class _LostResponse:
    """
    A psycopg connection whose FIRST INSERT commits (autocommit) and then
    'loses' its response -- the socket dropping between the server's
    commit and the client's read -- and, optionally, on which every
    later statement fails ('still down').
    """

    state: dict = {}     # shared across the connections a test opens

    def __init__(self, conn, *, fail_cleanup: bool) -> None:
        self._conn = conn
        self._fail_cleanup = fail_cleanup

    def __enter__(self):
        self._conn.__enter__()
        return self

    def __exit__(self, *exc_info):
        return self._conn.__exit__(*exc_info)

    def transaction(self, *args, **kwargs):
        return self._conn.transaction(*args, **kwargs)

    def close(self):
        return self._conn.close()

    def execute(self, sql, *args, **kwargs):
        state = _LostResponse.state
        if state.get('lost') and self._fail_cleanup:
            raise psycopg.OperationalError('still down')
        result = self._conn.execute(sql, *args, **kwargs)
        if 'INSERT' in sql and not state.get('lost'):
            state['lost'] = True
            raise psycopg.OperationalError('connection lost after commit')
        return result


@pytest.mark.django_db(transaction=True)
def test_insert_that_committed_but_lost_its_response_is_fenced_not_run(
        lease_table, caplog, monkeypatch):
    """
    codex round 3 (on the fix round), P1, as it stands after round 8.
    The INSERT commits under autocommit and the connection drops before
    the response is read: ``acquire`` sees an exception. Ownership is
    unverified, so the run is fenced before it starts and writes nothing
    -- and the committed row, which nobody beats, is exactly the silent
    lease the reclaimer needs to requeue a job whose body never ran. The
    DO-NOTHING re-INSERT behind it finds the row and leaves it. Negative
    control: return ``None`` on the error and the run is not fenced (it
    would run unleased next to a row nobody beats).
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    _LostResponse.state = {}
    real_connect = lease._connect
    monkeypatch.setattr(
        lease, '_connect',
        lambda params, name: (
            _LostResponse(real_connect(params, name), fail_cleanup=False)
            if name == lease.APPLICATION_NAME else real_connect(params, name)))

    held = lease.acquire(_fake_context(910022), _fake_worker())
    assert held is not None and held.lost.is_set()
    failed = _events(caplog, 'procrastinate_lease_insert_failed')
    assert failed and 'connection lost after commit' in failed[0]['error']
    assert [(e['detected'], e['reason']) for e in
            _events(caplog, 'procrastinate_lease_fenced')] == [
        ('acquire', 'unverified')]
    assert lease._beater.snapshot() == []
    row = _row(910022)
    assert row is not None and row['token'] == held.token, (
        'the committed row is the silent lease')

    # The re-INSERT behind it runs, touches nothing, and is not retried.
    time.sleep(3 * BEAT)
    assert _row(910022)['token'] == held.token
    from dj.apps.jobs.models import QuarantinedJob
    marker = QuarantinedJob.objects.get(job_id=910022)
    assert marker.reason == (
        f'recovery abandoned attempt before_body:{held.token}')
    assert _events(caplog, 'procrastinate_lease_cleanup_retry') == []
    assert _events(caplog, 'procrastinate_lease_cleanup_failed') == []


@pytest.mark.django_db(transaction=True)
def test_a_cleanup_that_cannot_run_is_logged_not_lost(
        lease_table, caplog, monkeypatch):
    """
    The other half of the same finding: a fire-and-forget cleanup that
    fails (the database is still away when it runs) must say so, with
    what it was for, or a row nobody beats exists with no trace of why.
    Negative control: drop the ``cleanup`` label from ``run_later`` in
    ``acquire`` and no line is emitted.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(lease, 'CLEANUP_ATTEMPTS', 3)
    _LostResponse.state = {}
    real_connect = lease._connect
    monkeypatch.setattr(
        lease, '_connect',
        lambda params, name: (
            _LostResponse(real_connect(params, name), fail_cleanup=True)
            if name == lease.APPLICATION_NAME else real_connect(params, name)))

    held = lease.acquire(_fake_context(910023), _fake_worker())
    assert held is not None and held.lost.is_set()
    deadline = time.monotonic() + 15 * BEAT
    while (not _events(caplog, 'procrastinate_lease_cleanup_failed')
           and time.monotonic() < deadline):
        time.sleep(0.05)
    # Retried once per tick until the cap...
    retries = _events(caplog, 'procrastinate_lease_cleanup_retry')
    assert [e['attempt'] for e in retries] == [1, 2]
    #...then logged as failed, with what it was for.
    failed = _events(caplog, 'procrastinate_lease_cleanup_failed')
    assert [(e['reason'], e['job_id'], e['task'], e['attempts'])
            for e in failed] == [
        ('acquire_unverified', 910023, 'lease_test.fake', 3)]
    assert 'still down' in failed[0]['error']
    assert 'connection lost after commit' in failed[0]['insert_error']
    assert _row(910023) is not None, 'the row is still there -- and known'


class _SlowFirstDelete:
    """
    A psycopg connection whose FIRST DELETE takes longer than the
    hand-off deadline. The sleep is inside ``execute`` -- after the
    thread's ``op.cancelled`` check, exactly where a slow Cloud SQL
    would spend the time -- so the statement is in flight when the
    waiter gives up, and it still lands.
    """

    pending = True

    def __init__(self, conn, delay: float) -> None:
        self._conn = conn
        self._delay = delay

    def __enter__(self):
        self._conn.__enter__()
        return self

    def __exit__(self, *exc_info):
        return self._conn.__exit__(*exc_info)

    def transaction(self, *args, **kwargs):
        return self._conn.transaction(*args, **kwargs)

    def close(self):
        return self._conn.close()

    def execute(self, sql, *args, **kwargs):
        if 'DELETE' in sql and _SlowFirstDelete.pending:
            _SlowFirstDelete.pending = False
            time.sleep(self._delay)
        return self._conn.execute(sql, *args, **kwargs)


@pytest.mark.django_db(transaction=True)
def test_exit_delete_that_outlives_the_handoff_is_waited_for_not_a_fence(
        lease_table, settings, caplog, monkeypatch):
    """
    Fresh-reviewer HIGH (round 1), the exit-side twin of the INSERT test
    above. The hand-off deadline passes while the thread is already
    executing the exit DELETE. Abandoning it and retrying would have
    attempt 1 land anyway and remove OUR row, and attempt 2 find nothing
    -- which reads exactly like a fence and strands a run that already
    did its work (a ``subscriptions.renew`` that charged the customer)
    in ``doing`` on a healthy worker, for the reclaimer to run again. So
    a started DELETE is waited for: it answers ``1``, ownership is
    proven, no attempt is recorded as failed. Negative control: cancel
    at the hand-off regardless of ``started`` and attempt 1 is logged
    ``delete_failed`` (the late-outcome check then still rescues the
    verdict, which is the round-2 fix this one supersedes in the common
    case).
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 0.1   # hand-off = 2.1s
    held = lease.acquire(_fake_context(910021), _fake_worker())
    assert held is not None and _row(910021) is not None

    real_connect = lease._connect
    _SlowFirstDelete.pending = True
    monkeypatch.setattr(
        lease, '_connect',
        lambda params, name: _SlowFirstDelete(
            real_connect(params, name), delay=2.6))

    started = time.monotonic()
    assert lease.release(held) is True, (
        'our own DELETE removed the row: ownership proven, not a fence')
    elapsed = time.monotonic() - started
    assert 2.5 < elapsed < 4.5, elapsed     # past the hand-off, waited for
    assert _events(caplog, 'procrastinate_lease_delete_failed') == []
    slow = _events(caplog, 'procrastinate_lease_statement_slow')
    assert [(e['statement'], e['job_id'], e['attempt']) for e in slow] == [
        ('delete', 910021, 1)]
    assert not held.lost.is_set(), 'nobody fenced this run'
    assert _events(caplog, 'procrastinate_lease_fenced') == []
    assert _row(910021) is None


@pytest.mark.django_db(transaction=True)
def test_unverified_exit_whose_delete_lands_after_the_decision_leaves_a_lease(
        lease_table, settings, caplog, monkeypatch, mocker):
    """
    Fresh-reviewer MEDIUM (round 2), reproduced as they did: the DELETE
    is started, the batch deadline passes and the watchdog's cut does
    NOT unblock the thread, so attempt 1 is ``LeaseOutcomeUnknown``;
    attempt 2 queues behind it on the stuck thread and is cancelled at
    its hand-off; ``release`` must decide with attempt 1 still in
    flight and fails closed (``unverified``). THEN attempt 1 lands and
    removes our row. Without the re-INSERT the job is now a ``doing``
    row with NO lease on a worker that is alive and beating: the leased
    path sees nothing, the heartbeat fallback never fires for a live
    worker, and a ``NEVER`` task is not recovered even by a restart.
    With it, a row with our token is back -- and nobody beats it, so the
    reclaimer finds it silent. Negative control: drop
    ``_leave_a_lease_to_go_silent`` and the last assertion reads
    ``_row(...) is None`` -- the stranded shape.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 0.1
    # hand-off 2.1s; attempt 1 given up at 6.3s (batch deadline 4.3 + 2);
    # attempt 2 cancelled at 8.4s; the DELETE lands at 9.5s.
    give_up_at = (lease.batch_deadline_seconds(1)
                  + lease.OUTCOME_MARGIN_SECONDS)
    decision_at = give_up_at + lease.handoff_timeout_seconds()
    assert decision_at == pytest.approx(8.4)
    monkeypatch.setattr(lease, '_cut_batch', lambda conn, ops, leases: None)
    # A failed release cut now requests a process restart independently of
    # acquisition. Intercept the signal while proving the late-write cleanup.
    restart = mocker.patch.object(lease, '_request_worker_restart')
    held = lease.acquire(_fake_context(910025), _fake_worker())
    assert held is not None
    original = _row(910025)
    assert original is not None

    real_connect = lease._connect
    _SlowFirstDelete.pending = True
    monkeypatch.setattr(
        lease, '_connect',
        lambda params, name: _SlowFirstDelete(
            real_connect(params, name), delay=9.5))

    started = time.monotonic()
    assert lease.release(held) is False
    elapsed = time.monotonic() - started
    assert decision_at - 0.4 < elapsed < 9.5, elapsed
    restart.assert_called_once_with()
    assert held.lost.is_set()
    fenced = _events(caplog, 'procrastinate_lease_fenced')
    assert [e['detected'] for e in fenced] == ['unverified']
    failed = _events(caplog, 'procrastinate_lease_delete_failed')
    assert [e['attempt'] for e in failed] == [1, 2]
    assert 'LeaseOutcomeUnknown' in failed[0]['error']
    assert 'LeaseHandoffTimeout' in failed[1]['error']
    assert lease._beater.snapshot() == [], 'nobody beats it any more'
    # The decision was taken with the DELETE still in flight: the row is
    # still ours right now, and it is about to be removed by us.
    assert _row(910025)['token'] == held.token

    # Let the late DELETE (t ~ 9.5s) land, then the re-INSERT behind it.
    deadline = started + 13
    while time.monotonic() < deadline:
        row = _row(910025)
        if row is not None and row['last_beat_at'] > original['last_beat_at']:
            break
        time.sleep(0.05)
    row = _row(910025)
    assert row is not None, (
        'the late DELETE removed the row and nothing put one back: a doing '
        'row with no lease on a live worker, which no path reclaims')
    assert row['token'] == held.token
    assert row['last_beat_at'] > original['last_beat_at'], 're-created, not the original'
    assert row['deadline_at'] == original['deadline_at']
    assert _events(caplog, 'procrastinate_lease_cleanup_failed') == []
    assert lease._beater.snapshot() == []


class _OutageAfterFirstDelete:
    """
    The first DELETE commits and loses its response; the database is
    then 'down' -- every statement raises -- until ``state['down_until']``
    (a ``time.monotonic()`` deadline set by that first DELETE), and
    healthy after that. The shape of an uncertain DELETE during an
    outage that is still going on when the recovery runs. Elapsed time,
    not a statement count: the retry budget must be measured in time.
    """

    def __init__(self, conn, state: dict) -> None:
        self._conn = conn
        self._state = state

    def __enter__(self):
        self._conn.__enter__()
        return self

    def __exit__(self, *exc_info):
        return self._conn.__exit__(*exc_info)

    def transaction(self, *args, **kwargs):
        return self._conn.transaction(*args, **kwargs)

    def close(self):
        return self._conn.close()

    def execute(self, sql, *args, **kwargs):
        state = self._state
        if 'DELETE' in sql and not state['delete_done']:
            state['delete_done'] = True
            state['down_until'] = time.monotonic() + state['down_for']
            self._conn.execute(sql, *args, **kwargs)
            raise psycopg.OperationalError('connection lost after commit')
        if state['delete_done'] and time.monotonic() < state['down_until']:
            state['failures'] += 1
            raise psycopg.OperationalError('still down')
        return self._conn.execute(sql, *args, **kwargs)


@pytest.mark.django_db(transaction=True)
def test_recovery_after_an_uncertain_delete_is_retried_through_the_outage(
        lease_table, caplog, monkeypatch):
    """
    codex round 4 (on the fix round), P1. The re-INSERT that is the only
    recovery after an uncertain committed DELETE used to be fire-and-
    forget: one more connection failure -- and the outage that made the
    DELETE uncertain is usually still going on -- and it was logged and
    discarded, leaving a ``doing`` row with no lease on a healthy worker
    for good. A cleanup is idempotent, so it is retried, one beat later
    each time, up to ``CLEANUP_ATTEMPTS`` -- a budget of ELAPSED time.
    Codex round 5: re-queued on the ordinary op queue, a retry ran on
    every wake-up, and every unrelated INSERT/DELETE is a wake-up, so a
    busy worker burned all twelve in a fraction of a second; modelled
    here by 40 unrelated ops submitted during a 1s (2.5-beat) outage.
    Negative controls: drop the retry (log and discard on the first
    failure), or drop ``not_before`` (retry on the next wake-up), and
    the row never comes back.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    held = lease.acquire(_fake_context(910027), _fake_worker())
    assert held is not None
    original = _row(910027)
    state = {'delete_done': False, 'down_for': 2.5 * BEAT, 'failures': 0}
    real_connect = lease._connect
    # Only the lease thread's connection sees the outage; the test's own
    # ``_row`` reads must keep working.
    monkeypatch.setattr(
        lease, '_connect',
        lambda params, name: (
            _OutageAfterFirstDelete(real_connect(params, name), state)
            if name == lease.APPLICATION_NAME else real_connect(params, name)))

    assert lease.release(held) is False
    assert [e['detected'] for e in _events(caplog, 'procrastinate_lease_fenced')
            ] == ['unverified']
    assert _row(910027) is None, 'our committed DELETE removed the row'

    # Unrelated traffic while the database is down: each of these wakes
    # the thread. A retry budget counted in wake-ups is gone in the loop.
    params = lease._connection_params()
    unrelated: list = []
    while time.monotonic() < state['down_until'] - 0.2 * BEAT:
        lease._beater.run_later(lambda conn: unrelated.append(1), params)
        time.sleep(0.02)
    assert len(unrelated) > lease.CLEANUP_ATTEMPTS, len(unrelated)

    deadline = time.monotonic() + 20 * BEAT
    while time.monotonic() < deadline:
        row = _row(910027)
        if row is not None:
            break
        time.sleep(0.05)
    assert row is not None, (
        'the recovery died on the outage it exists for: a doing row with no '
        'lease on a live worker')
    assert row['token'] == held.token
    assert row['last_beat_at'] > original['last_beat_at']
    retries = _events(caplog, 'procrastinate_lease_cleanup_retry')
    assert 1 <= len(retries) <= 4, [e['attempt'] for e in retries]
    assert [e['reason'] for e in retries] == ['unverified_exit'] * len(retries)
    assert [e['attempt'] for e in retries] == list(range(1, len(retries) + 1))
    assert 'still down' in retries[0]['error']
    # One failure per retry: the retry did not run on every wake-up.
    assert state['failures'] == len(retries) + 1   # + the DELETE's retry
    assert _events(caplog, 'procrastinate_lease_cleanup_failed') == []
    assert lease._beater.snapshot() == []


@pytest.mark.django_db(transaction=True)
def test_reclaimer_activation_enables_lease_middleware(lease_table, settings):
    """Fences become active only alongside the deployed lease reader."""
    settings.JOB_LEASE_WITHOUT_RECLAIMER = False
    assert reclaim.READS_LEASES is True
    assert lease.reclaimer_reads_leases() is True
    assert lease.enabled() is True

    settings.JOB_LEASE_ENABLED = False
    assert lease.enabled() is False
    settings.JOB_LEASE_ENABLED = True

    # The emergency override remains available for an explicit owner choice.
    settings.JOB_LEASE_WITHOUT_RECLAIMER = True
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(reclaim, 'READS_LEASES', False)
    assert lease.enabled() is True
    monkeypatch.undo()


@pytest.mark.django_db(transaction=True)
def test_a_stale_attempt_cannot_take_over_its_replacements_lease(
        lease_table, caplog):
    """
    codex round 6 (on the fix round), P2. Worker A fetches the job and
    freezes BEFORE its INSERT; the fallback requeues the job (attempts +
    1); worker B leases the replacement. A resumes and INSERTs. An
    unconditional ``ON CONFLICT DO UPDATE`` would hand A the row, fence
    the live B on its next beat, and run A's body a second time. The
    take-over is conditional on the attempt number: A is refused, fenced
    at acquire, and the middleware runs NO body for it -- the one fence
    that lands before the duplicate. B is untouched. Codex round 7: the
    lease row is temporary, so when B has already FINISHED there is no
    conflict to refuse A -- the job row is the authority (``doing`` at
    this attempt number), and A is refused by it. Negative controls:
    drop the ``WHERE EXCLUDED.attempt >=...`` and A's token replaces
    the running B's; drop the job-row ``WHERE`` and A leases and runs
    the finished job again.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    worker = _fake_worker()
    context_b = _fake_context(910040, attempts=1)    # the replacement
    context_b.additional_context = {}
    lease_b = lease.acquire(context_b, worker)
    assert lease_b is not None and not lease_b.lost.is_set()
    assert _row(910040)['attempt'] == 1

    ran: list = []
    context_a = _fake_context(910040, attempts=0, job_row=False)  # stale
    context_a.additional_context = {}
    with pytest.raises(lease.LeaseLost):
        lease.lease_middleware(lambda: ran.append('A ran'), context_a, worker)
    assert ran == [], 'the stale attempt ran its body'
    lease_a = context_a.additional_context[lease.LEASE_CONTEXT_KEY]
    assert lease_a.lost.is_set()
    fenced = _events(caplog, 'procrastinate_lease_fenced')
    assert [(e['job_id'], e['detected'], e['reason']) for e in fenced] == [
        (910040, 'acquire', 'stale')]
    assert lease._beater.snapshot() == [lease_b], 'A was never registered'
    assert worker._job_ids_to_abort == {}, 'B must not be asked to abort'

    # B is untouched: its row, its token, its beats.
    row = _row(910040)
    assert row['token'] == lease_b.token and row['attempt'] == 1
    with _raw() as conn:
        assert lease._beater.beat(conn, [lease_b]) == set()
    assert lease_b.beats == 1
    # A same-or-newer attempt still takes over (a requeue after a real
    # fence): the rule is freshness, not first-come.
    context_c = _fake_context(910040, attempts=2)
    lease_c = lease.acquire(context_c, worker)
    assert lease_c is not None and not lease_c.lost.is_set()
    assert _row(910040)['token'] == lease_c.token
    assert lease.release(lease_c) is True
    assert lease.release(lease_b) is False          # fenced at exit, by C

    # C finishes: finish_job increments attempts and the lease is gone.
    # A resumes NOW -- no lease row to conflict with. The job row says
    # this attempt is over, and A is still refused and runs nothing.
    _job_row(910040, status='succeeded', attempts=3)
    assert _row(910040) is None
    context_a2 = _fake_context(910040, attempts=0, job_row=False)
    context_a2.additional_context = {}
    with pytest.raises(lease.LeaseLost):
        lease.lease_middleware(lambda: ran.append('A ran'), context_a2, worker)
    assert ran == [], 'the stale attempt re-ran a finished job'
    assert _row(910040) is None, 'the stale attempt left a lease'
    assert [e['detected'] for e in _events(caplog, 'procrastinate_lease_fenced')
            ] == ['acquire', 'exit', 'acquire']


@pytest.mark.django_db(transaction=True)
def test_acquisition_waits_for_an_uncommitted_requeue_and_is_refused(
        lease_table, settings, caplog):
    """
    codex round 8, MEDIUM. The fallback reclaimer has UPDATEd the job to
    ``todo`` with ``attempts + 1`` but not committed when the stalled
    attempt's INSERT runs. A plain SELECT reads its snapshot -- still
    ``doing`` at the old attempt -- and leases a job that is already
    requeued. ``FOR SHARE`` on the job row waits for the writer (inside
    ``lock_timeout``) and READ COMMITTED re-evaluates the WHERE against
    the committed row: refused, ``reason=stale``, nothing run. Negative
    control: drop ``FOR SHARE`` and the INSERT returns 1 before the
    commit lands.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = 3     # lock_timeout 3s
    context = _fake_context(910041, attempts=0)
    context.additional_context = {}
    worker = _fake_worker()

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE procrastinate_jobs SET status = 'todo', "
                'attempts = attempts + 1 WHERE id = %s', [910041])
        # The reclaimer's transaction is open. The stalled attempt's
        # INSERT runs on the beat thread and blocks on the row lock...
        holder = {'lease': None}
        thread = threading.Thread(
            target=lambda: holder.__setitem__(
                'lease', lease.acquire(context, worker)))
        started = time.monotonic()
        thread.start()
        time.sleep(0.6)
        assert thread.is_alive(), 'the INSERT did not wait for the writer'
        assert holder['lease'] is None
    #...the requeue commits; the INSERT proceeds against the committed row.
    thread.join(10)
    assert not thread.is_alive()
    elapsed = time.monotonic() - started
    assert 0.6 <= elapsed < 3, elapsed
    held = holder['lease']
    assert held is not None and held.lost.is_set(), (
        'leased a job that was requeued under it')
    assert [(e['detected'], e['reason']) for e in
            _events(caplog, 'procrastinate_lease_fenced')] == [
        ('acquire', 'stale')]
    assert _row(910041) is None, 'the stale attempt left a lease'
    assert lease._beater.snapshot() == []


@pytest.mark.django_db(transaction=True)
def test_a_status_write_that_raises_leaves_a_lease_for_the_reclaimer(
        lease_table, caplog):
    """
    codex round 9. The lease is released (ownership proven) and then
    procrastinate's status write raises on ITS connection. The job is
    `doing` with no lease on a worker that keeps heartbeating: the
    leased path sees nothing and the heartbeat fallback never fires for
    a live worker. The persist wrapper must put a lease back -- unbeaten,
    job-row-checked -- so the reclaimer finds the job silent. Negative
    control: drop the ``except`` and the row never reappears.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)

    async def failing_persist(**kwargs):
        raise psycopg.OperationalError('metadata connection dropped')

    worker = SimpleNamespace(
        _job_ids_to_abort={}, _persist_job_status=failing_persist)
    context = _fake_context(910042)
    context.additional_context = {}
    held = lease.acquire(context, worker)
    assert held is not None
    original = _row(910042)
    assert lease.release(held) is True
    assert _row(910042) is None, 'ownership proven, row gone'

    with pytest.raises(psycopg.OperationalError):
        asyncio.run(worker._persist_job_status(
            job=context.job, status=SimpleNamespace(value='succeeded'),
            retry_decision=None, context=context, job_result=None))
    failed = _events(caplog, 'procrastinate_lease_persist_failed')
    assert [(e['job_id'], e['would_have_written']) for e in failed] == [
        (910042, 'succeeded')]
    assert 'metadata connection dropped' in failed[0]['error']

    deadline = time.monotonic() + 10 * BEAT
    while _row(910042) is None and time.monotonic() < deadline:
        time.sleep(0.05)
    row = _row(910042)
    assert row is not None, (
        'a doing row with no lease on a live worker: nothing will find it')
    assert row['token'] == held.token
    assert row['last_beat_at'] > original['last_beat_at']
    from dj.apps.jobs.models import QuarantinedJob
    marker = QuarantinedJob.objects.get(job_id=910042)
    assert marker.reason == (
        f'recovery abandoned attempt after_body:{held.token}')
    assert marker.attempts == 0
    assert lease._beater.snapshot() == [], 'nobody beats it'
    assert _events(caplog, 'procrastinate_lease_fenced') == [], (
        'a failed write is not a fence: ownership was proven')
    assert _events(caplog, 'procrastinate_lease_cleanup_failed') == []


class _DeleteCommitsThenDrops:
    """
    A psycopg connection whose FIRST DELETE commits (autocommit) and then
    'loses' its response -- the socket dropping between the server's
    commit and the client's read. Every later statement is normal.
    """

    pending = True

    def __init__(self, conn) -> None:
        self._conn = conn

    def __enter__(self):
        self._conn.__enter__()
        return self

    def __exit__(self, *exc_info):
        return self._conn.__exit__(*exc_info)

    def transaction(self, *args, **kwargs):
        return self._conn.transaction(*args, **kwargs)

    def close(self):
        return self._conn.close()

    def execute(self, sql, *args, **kwargs):
        result = self._conn.execute(sql, *args, **kwargs)
        if 'DELETE' in sql and _DeleteCommitsThenDrops.pending:
            _DeleteCommitsThenDrops.pending = False
            raise psycopg.OperationalError('connection lost after commit')
        return result


@pytest.mark.django_db(transaction=True)
def test_exit_delete_that_committed_but_lost_its_response_is_unverified_not_exit(
        lease_table, caplog, monkeypatch):
    """
    codex round 3 (on the fix round), HIGH. Attempt 1 commits and loses
    its response, so it is recorded as raised; attempt 2 then removes
    nothing -- because attempt 1 removed it. Reading that as an ``exit``
    fence would suppress the status write AND leave no lease: nobody took
    ownership, and a ``doing`` row with no lease on a live worker is
    reclaimed by no path. It is ``unverified`` instead, and a lease is
    left behind to go silent. Negative control: classify ``deleted == 0``
    as ``exit`` regardless of an earlier started-and-raised attempt and
    the fence reads ``exit`` with ``_row(...) is None`` at the end.
    """
    caplog.set_level(logging.INFO, logger=LOGGER)
    held = lease.acquire(_fake_context(910026), _fake_worker())
    assert held is not None
    original = _row(910026)

    real_connect = lease._connect
    _DeleteCommitsThenDrops.pending = True
    monkeypatch.setattr(
        lease, '_connect',
        lambda params, name: _DeleteCommitsThenDrops(real_connect(params, name)))

    assert lease.release(held) is False
    assert held.lost.is_set()
    failed = _events(caplog, 'procrastinate_lease_delete_failed')
    assert [e['attempt'] for e in failed] == [1]
    assert 'connection lost after commit' in failed[0]['error']
    uncertain = _events(caplog, 'procrastinate_lease_delete_outcome_uncertain')
    assert [e['attempts'] for e in uncertain] == [[1]]
    assert [e['detected'] for e in _events(caplog, 'procrastinate_lease_fenced')
            ] == ['unverified'], 'our own committed DELETE is not a fence'

    deadline = time.monotonic() + 10 * BEAT
    while time.monotonic() < deadline:
        row = _row(910026)
        if row is not None and row['last_beat_at'] > original['last_beat_at']:
            break
        time.sleep(0.05)
    row = _row(910026)
    assert row is not None, 'nothing left for the reclaimer to find'
    assert row['token'] == held.token
    assert row['last_beat_at'] > original['last_beat_at']
    assert lease._beater.snapshot() == [], 'nobody beats it'
    assert _events(caplog, 'procrastinate_lease_cleanup_failed') == []


def test_async_release_waits_through_cancellation(monkeypatch):
    """
    codex round 3, P3. A shutdown cancels the async middleware while the
    exit ownership check is running. The cancellation must be delivered
    only AFTER ``release`` has finished, or procrastinate persists
    ``aborted`` (or retries the replacement) before ``lease.lost`` can be
    set. Negative control: a bare ``shield`` -- cancelled arrives with
    ``released == False``.
    """
    released = {'done': False}

    def slow_release(_lease):
        time.sleep(0.4)
        released['done'] = True
        return True

    monkeypatch.setattr(lease, 'release', slow_release)
    held = lease.Lease(job_id=1, token=uuid.uuid4(), task_name='t',
                       queue=QUEUE, worker=None)
    seen: list = []

    async def main():
        async def runner():
            try:
                await lease._release_uncancellable(held)
            except asyncio.CancelledError:
                seen.append(('cancelled', released['done']))
                raise
            seen.append(('finished', released['done']))

        task = asyncio.create_task(runner())
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert seen == [('cancelled', True)]


# ---------------------------------------------------------------------------
# deadlines come from reclaim_policy
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_deadline_is_null_for_a_never_task_and_budget_for_a_bounded_one(
        lease_table, monkeypatch):
    monkeypatch.setitem(
        reclaim_policy.TASK_POLICIES, 'lease_test.never',
        reclaim_policy.TaskPolicy(reclaim_policy.NEVER, 'test'))
    monkeypatch.setitem(
        reclaim_policy.TASK_POLICIES, 'lease_test.budgeted',
        reclaim_policy.TaskPolicy(
            600, 'test', hard_deadline_seconds=600))
    monkeypatch.setitem(
        reclaim_policy.TASK_POLICIES, 'lease_test.estimated',
        reclaim_policy.TaskPolicy(600, 'estimated, not enforced'))
    test_app = _worker_app()
    seen: dict = {}

    @test_app.task(name='lease_test.never', queue=QUEUE, pass_context=True)
    def never(context):
        seen['never'] = _row(context.job.id)

    @test_app.task(name='lease_test.budgeted', queue=QUEUE, pass_context=True)
    def budgeted(context):
        seen['budgeted'] = _row(context.job.id)

    @test_app.task(name='lease_test.estimated', queue=QUEUE, pass_context=True)
    def estimated(context):
        seen['estimated'] = _row(context.job.id)

    @test_app.task(name='lease_test.unclassified', queue=QUEUE,
                   pass_context=True)
    def unclassified(context):
        seen['unclassified'] = _row(context.job.id)

    never.defer()
    budgeted.defer()
    estimated.defer()
    unclassified.defer()
    _run_worker(test_app)

    assert seen['never']['deadline_at'] is None
    assert seen['unclassified']['deadline_at'] is None, (
        'a task the registry does not know must not get a deadline either')
    assert seen['estimated']['deadline_at'] is None, (
        'an estimated runtime must not abort a live task')
    bounded = seen['budgeted']
    assert bounded['deadline_at'] - bounded['started_at'] == (
        timedelta(seconds=600))


def test_deadline_uses_the_real_registry_entries():
    from datetime import datetime, timezone

    started = datetime(2026, 9, 7, tzinfo=timezone.utc)
    assert lease._deadline('jobs.report_job_health', started) is None
    assert lease._deadline('uploads.generate_video_poster', started) is None
    assert lease._deadline('g12f.translate_zpage', started) is None
    assert lease._deadline('no.such.task', started) is None


# ---------------------------------------------------------------------------
# connections
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_one_lease_connection_per_process_opened_only_on_the_beat_thread(
        lease_table, monkeypatch):
    """
    The budget rule, measured two ways because either alone can pass
    vacuously:

    * ``_connect`` is instrumented, so the count of SIMULTANEOUSLY open
      lease connections is exact, every one is proven to be opened on
      the beat thread, and the INSERT, at least two beats and the DELETE
      are proven to have happened;
    * ``pg_stat_activity`` is sampled from a sidecar thread while the job
      runs, by application_name, as the issue asks.

    And the beat thread is checked, from inside itself, to hold no Django
    ORM connection before or after a beat (``connections`` is
    thread-local, so this is the only place that check is meaningful).
    """
    real_connect = lease._connect
    lock = threading.Lock()
    open_now = {'n': 0}
    peak = {'n': 0}
    opened_on: list[str] = []
    django_conn_seen_in_beat_thread: list = []

    class _Counted:
        def __init__(self, conn):
            self._conn = conn

        def __enter__(self):
            with lock:
                open_now['n'] += 1
                peak['n'] = max(peak['n'], open_now['n'])
                opened_on.append(threading.current_thread().name)
            return self._conn.__enter__()

        def __exit__(self, *exc):
            try:
                return self._conn.__exit__(*exc)
            finally:
                with lock:
                    open_now['n'] -= 1

    def counted_connect(params, application_name):
        if application_name != lease.APPLICATION_NAME:
            return real_connect(params, application_name)  # the sampler
        return _Counted(real_connect(params, application_name))

    monkeypatch.setattr(lease, '_connect', counted_connect)

    real_beat = lease._Beater.beat
    beats = {'n': 0}

    def checked_beat(self, conn, leases):
        assert threading.current_thread().name == lease.THREAD_NAME
        django_conn_seen_in_beat_thread.append(
            connections['default'].connection is not None)
        try:
            return real_beat(self, conn, leases)
        finally:
            beats['n'] += 1
            django_conn_seen_in_beat_thread.append(
                connections['default'].connection is not None)

    monkeypatch.setattr(lease._Beater, 'beat', checked_beat)

    samples: list[int] = []
    stop = threading.Event()

    def sample():
        with _raw() as conn:
            while not stop.is_set():
                row = conn.execute(
                    'SELECT count(*) FROM pg_stat_activity '
                    'WHERE application_name = %s',
                    (lease.APPLICATION_NAME,),
                ).fetchone()
                samples.append(row[0])
                time.sleep(0.003)

    test_app = _worker_app()

    @test_app.task(name='lease_test.counted', queue=QUEUE)
    def counted():
        time.sleep(3 * BEAT)

    job_id = counted.defer()
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    try:
        _run_worker(test_app)
    finally:
        stop.set()
        sampler.join(5)

    assert _status(job_id) == 'succeeded'
    # INSERT, >= 2 beats, DELETE: each its own short-lived connection...
    assert beats['n'] >= 2, beats
    assert len(opened_on) >= 4, opened_on
    #...every one of them opened on the beat thread...
    assert set(opened_on) == {lease.THREAD_NAME}, opened_on
    #...never more than one at a time, and none left open.
    assert peak['n'] == 1, peak
    assert open_now['n'] == 0
    # pg_stat_activity agrees on the bound.
    assert samples, 'the sampler never ran'
    assert max(samples) <= 1, samples
    # The beat thread held no Django ORM connection, before or after.
    assert django_conn_seen_in_beat_thread, 'checked_beat never ran'
    assert not any(django_conn_seen_in_beat_thread)


# ---------------------------------------------------------------------------
# before the migration lands, and the escape hatch
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_jobs_run_unleased_while_the_table_does_not_exist(
        no_lease_table, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    test_app = _worker_app()
    ran: list = []

    @test_app.task(name='lease_test.unleased', queue=QUEUE)
    def unleased():
        ran.append(True)

    job_id = unleased.defer()
    _run_worker(test_app)

    assert ran == [True]
    assert _status(job_id) == 'succeeded'
    disabled = _events(caplog, 'procrastinate_lease_disabled')
    assert len(disabled) == 1, 'must warn exactly once, not per job'
    assert disabled[0]['reason'] == 'table_missing'
    assert lease._beater.snapshot() == []


@pytest.mark.django_db(transaction=True)
def test_missing_table_costs_one_probe_connection_not_one_per_job(
        no_lease_table, settings, monkeypatch):
    settings.JOB_LEASE_TABLE_RECHECK_SECONDS = 60
    real_connect = lease._connect
    opened = {'n': 0}

    def counted_connect(params, application_name):
        opened['n'] += 1
        return real_connect(params, application_name)

    monkeypatch.setattr(lease, '_connect', counted_connect)
    test_app = _worker_app()

    @test_app.task(name='lease_test.unleased_many', queue=QUEUE)
    def unleased_many():
        pass

    job_ids = [unleased_many.defer() for _ in range(3)]
    _run_worker(test_app)
    assert [_status(j) for j in job_ids] == ['succeeded'] * 3
    assert opened['n'] == 1, 'the negative probe must be cached'


@pytest.mark.django_db(transaction=True)
def test_job_lease_enabled_false_is_a_pass_through(lease_table, settings):
    settings.JOB_LEASE_ENABLED = False
    test_app = _worker_app()
    seen: dict = {}

    @test_app.task(name='lease_test.disabled', queue=QUEUE, pass_context=True)
    def disabled(context):
        seen['row'] = _row(context.job.id)

    job_id = disabled.defer()
    _run_worker(test_app)
    assert _status(job_id) == 'succeeded'
    assert seen['row'] is None


@pytest.mark.django_db(transaction=True)
def test_transaction_pool_lease_timeouts_are_local_and_enforced(settings):
    """Real pinned PgBouncer fixture: deadlines work without session leakage."""
    port = os.environ.get('LEDGER_TEST_POOLER_PORT')
    if not port:
        pytest.skip('requires the owned pinned PgBouncer transaction-pool fixture')
    settings.JOB_LEASE_STATEMENT_TIMEOUT_SECONDS = .15
    direct = lease._connection_params()
    pooled = dict(direct, port=port)
    assert 'statement_timeout' not in pooled.get('options', '')
    with lease._connect(pooled, 'lease-pool-test') as conn:
        raw = lambda query, params=None: psycopg.Connection.execute(conn, query, params)
        raw("SET statement_timeout='17s'")
        raw("SET lock_timeout='19s'")
        before = raw("SELECT pg_backend_pid(),current_setting('statement_timeout'),current_setting('lock_timeout')").fetchone()
        try:
            assert conn.execute("SELECT current_setting('statement_timeout'),current_setting('lock_timeout')").fetchone() == ('150ms', '150ms')
            after = raw("SELECT pg_backend_pid(),current_setting('statement_timeout'),current_setting('lock_timeout')").fetchone()
            assert after == before
            with psycopg.connect(**direct) as blocker:
                key = int.from_bytes(os.urandom(7), 'big')
                blocker.execute('SELECT pg_advisory_xact_lock(%s)', [key])
                with pytest.raises((psycopg.errors.LockNotAvailable, psycopg.errors.QueryCanceled)):
                    conn.execute('SELECT pg_advisory_xact_lock(%s)', [key])
            with pytest.raises(psycopg.errors.QueryCanceled):
                conn.execute('SELECT pg_sleep(1)')
            assert conn.execute('SELECT 1').fetchone() == (1,)
            assert raw("SELECT pg_backend_pid(),current_setting('statement_timeout'),current_setting('lock_timeout')").fetchone() == before
        finally:
            raw('RESET statement_timeout')
            raw('RESET lock_timeout')


@pytest.mark.django_db(transaction=True)
def test_worker_metadata_orm_and_lease_share_transaction_pool(lease_table):
    """Run a real sync worker through the one-server transaction pool."""
    port = os.environ.get('LEDGER_TEST_POOLER_PORT')
    if not port:
        pytest.skip('requires the owned pinned PgBouncer transaction-pool fixture')
    connection.close()
    config = connection.settings_dict
    original_port = config['PORT']
    original_options = config.get('OPTIONS', {})
    config['PORT'] = port
    config['OPTIONS'] = dict(original_options, prepare_threshold=None)
    try:
        # Real Procrastinate claim/status SQL, task ORM and independent lease
        # heartbeat all share the same bounded server pool without LISTEN.
        test_sync_task_lease_is_inserted_beaten_and_deleted(lease_table)
    finally:
        lease.reset_for_tests()
        connection.close()
        config['PORT'] = original_port
        config['OPTIONS'] = original_options


@pytest.mark.parametrize('operation', ['beat', 'release'])
@pytest.mark.parametrize('stalls', [False, True])
def test_batch_watchdog_covers_beats_and_releases(operation, stalls, monkeypatch):
    """A live lease thread proves progress; a failed cut must restart it."""
    entered, unblock, restarted = (threading.Event() for _ in range(3))
    requests = []
    cuts = []
    beater = lease._Beater()
    lease._record_acquire_outcome(None)

    @contextmanager
    def connect(*_args):
        yield SimpleNamespace()

    def request_restart():
        requests.append(True)
        restarted.set()

    def block(*_args):
        entered.set()
        assert unblock.wait(2)

    monkeypatch.setattr(lease, '_connect', connect)
    monkeypatch.setattr(lease, '_cut_batch', lambda *_args: cuts.append(True))
    monkeypatch.setattr(lease, '_request_worker_restart', request_restart)
    monkeypatch.setattr(lease, 'batch_deadline_seconds', lambda _count: 0.15)
    monkeypatch.setattr(lease, 'OUTCOME_MARGIN_SECONDS', 0.05)
    monkeypatch.setattr(lease, 'beat_seconds', lambda: 0.01)
    try:
        if operation == 'beat':
            monkeypatch.setattr(beater, 'beat', block)
            beater.register(lease.Lease(
                job_id=1, token=uuid.uuid4(), task_name='fixture',
                queue='fixture', worker=_fake_worker()))
            beater.wait(beater.submit(lambda _conn: None, {}), 0.5)
        else:
            beater.submit(block, {})
        assert entered.wait(1)
        queued = beater.submit(lambda _conn: 'next acquisition', {})
        with pytest.raises(lease.LeaseHandoffTimeout) as error:
            beater.wait(queued, 0.01)
        lease._record_acquire_outcome(error.value)
        assert not requests
        if stalls:
            assert restarted.wait(1), 'a wedged non-acquisition batch was missed'
            assert cuts
            time.sleep(0.05)
            assert requests == [True]
        else:
            unblock.set()
            time.sleep(0.3)
            assert not requests
    finally:
        unblock.set()
        beater.stop(timeout=2)
        lease._record_acquire_outcome(None)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('current_quarantine', [False, True])
def test_retried_attempt_replaces_only_older_quarantine_marker(
    lease_table, monkeypatch, current_quarantine,
):
    """Ordinary operator retry must not suppress the new recovery evidence."""
    from dj.apps.jobs import ops
    from dj.apps.jobs.models import QuarantinedJob
    from procrastinate.jobs import Status

    job_id = 910099
    context = _fake_context(job_id)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name=context.job.task_name, queue=QUEUE,
        reason='reclaimer exceeded configured retry bound', attempts=0)
    job = app.job_manager.list_jobs(id=job_id)[0]
    async_to_sync(app.job_manager.finish_job)(
        job, status=Status.FAILED, delete_job=False)
    result = ops.requeue(ids=[job_id], execute=True, reason='repair')
    assert result[0]['result'] == 'requeued'
    marker = QuarantinedJob.objects.get(job_id=job_id)
    assert marker.requeued_at is None
    attempts = ProcrastinateJob.objects.get(id=job_id).attempts
    assert attempts > marker.attempts
    context = _fake_context(job_id, attempts=attempts)
    if current_quarantine:
        marker.attempts = attempts
        marker.reason = 'operator hold for current attempt'
        marker.save()
    _LostResponse.state = {}
    real_connect = lease._connect
    monkeypatch.setattr(
        lease, '_connect',
        lambda params, name: (
            _LostResponse(real_connect(params, name), fail_cleanup=False)
            if name == lease.APPLICATION_NAME else real_connect(params, name)))
    held = lease.acquire(context, _fake_worker())
    assert held is not None and held.lost.is_set()
    time.sleep(3 * BEAT)
    marker.refresh_from_db()
    assert marker.reason == (
        'operator hold for current attempt' if current_quarantine else
        f'recovery abandoned attempt before_body:{held.token}')
    assert marker.attempts == attempts
