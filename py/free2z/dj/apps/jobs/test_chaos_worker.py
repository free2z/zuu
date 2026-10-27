"""
Chaos tests: kill a REAL procrastinate worker mid-job and watch the row
heal (part A of the epic's "chaos verification").

WHAT IS REAL HERE
-----------------
Everything. ``manage.py procrastinate worker --queues=chaos`` runs as a
subprocess of this test, against the test database pytest-django created
(``transaction=True`` so the rows are committed and visible to it). The
job is deferred through the real ``.defer()``; the worker fetches it with
the real ``fetch_job``; the ``started`` event, the ``worker_id``, the
heartbeat row are all what production writes. Then the worker is killed
-- by SIGKILL from outside, by ``os._exit(137)`` from inside, by SIGTERM
with a 1s grace, by SIGSTOP -- and the assertions are about what the
merged reclaimer (``dj.apps.jobs.reclaim``, the age-and-orphan path)
does to the row it left behind, and whether a SECOND real worker then
completes it.

``test_reclaim_stalled.py`` fabricates its ``doing`` rows with SQL and
backdates the events; that is fine for the sweep's arithmetic and useless
for the question "does a dead worker leave the row in a shape the sweep
recognises". Nothing in CI had ever observed that before this module.

THE CLOCK, AND WHY THE NUMBERS ARE WHAT THEY ARE
------------------------------------------------
The lease-aware sweep reclaims a stale-lease row after the configured
minimum age and worker heartbeat checks; the task budget does not gate
that path. This fixture uses a 2s lease/worker stale window and a 1s age
floor. After a kill the tests poll the sweep for up to
``RECLAIM_WAIT_SECONDS`` rather than sleeping a fixed time, and assert
that it DID reclaim. Each case is bounded by its own waits and marked
``chaos`` so it can be selected or deselected by name.

THE LEASE EXTENSION POINT
-------------------------
Lease-specific assertions require enabled worker leases, a lease-aware
reclaimer, and the ``jobs_joblease`` table; the table alone never enables
these assertions. The zombie case also pins the legacy no-lease residual
separately from the fenced outcome.

Search this file for ``LEASE EXTENSION POINT`` to find all of them.

UNITS: every duration here is **seconds**.
"""
from __future__ import annotations

import json
import signal
import time
from pathlib import Path

import pytest
from asgiref.sync import async_to_sync
from django.db import connection

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.jobs import chaos_tasks, reclaim
from dj.apps.jobs.chaos_tasks import (
    ARMING_ENV_VAR,
    CHAOS_HOLD_SAFETY_SECONDS,
    CHAOS_PROBE_MAX_SECONDS,
    CHAOS_QUEUE,
    CHAOS_TASK_NAME,
    OOM_KILL_EXIT_STATUS,
    chaos_probe,
)
from dj.apps.jobs.worker_harness import (
    Worker,
    WorkerExitWaitTimeout,
    process_state as _process_state,
    wait_for_worker_exit,
    wait_for_worker_shutdown_state,
    wait_until as _wait_until,
)

pytestmark = [pytest.mark.chaos, pytest.mark.django_db(transaction=True)]

#How long a fresh worker subprocess gets to boot Django, register, fetch
#the job and move it to `doing`. Measured at ~1s locally; CI runners are
#slower and `pip`-cold, so generous -- this bounds a HANG, not the case.
WORKER_START_SECONDS = 45

#A terminal-state ceiling for cooperative shutdown. Historical evidence and
#its limits are recorded in docs/testing/chaos-worker-timeouts-1837.md.
#This is deliberately a hang fence, not the success condition: assertions
#below still require the expected database/marker state and a zero exit
#status.
WORKER_EXIT_CEILING_SECONDS = 60

#How long the sweep is polled after a kill before the test gives up on
#the reclaimer. Must exceed the threshold (5s) plus the heartbeat window
#(2s) plus a sweep or two; it bounds a reclaimer that never fires.
RECLAIM_WAIT_SECONDS = 25

#How long the second worker gets to pick up the requeued row and finish
#it (the body sleeps `JOB_SLEEP_SECONDS`).
COMPLETE_WAIT_SECONDS = 30

#How long a job body sleeps: long enough to be killed mid-way, shorter
#than the budget so a healthy run never overruns it.
JOB_SLEEP_SECONDS = 3

#The one-second grace the SIGTERM case gives the worker -- the `deploy`
#shape of, scaled down. The manifests fund 390s; the mechanism is
#the same, and it is the mechanism this pins.
SHUTDOWN_GRACEFUL_SECONDS = 1

#PR 's table. Detected, never assumed -- see the module docstring.
LEASE_TABLE = 'jobs_joblease'


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------

@pytest.fixture
def chaos_settings(settings):
    """
    The reclaimer's knobs, turned down so a chaos case fits its budget.
    Every one of these is a real setting the sweep reads; none is a test
    seam. Production values are in settings.py next to their reasons.
    """
    settings.JOB_HEALTH_STUCK_DOING_SECONDS = 3600
    settings.JOB_RECLAIM_STALLED_AFTER_SECONDS = 1     # floor
    settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS = 0     # threshold == budget
    settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS = 2  # the "2s stale window"
    settings.JOB_RECLAIM_MAX_RECLAIMS = 3
    settings.JOB_RECLAIM_EXCLUDED_QUEUES = ('exports',)
    settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS = 20
    # LEASE EXTENSION POINT: the issue's names for the lease-based sweep.
    # Today's reclaimer does not read them; setting them is harmless and
    # means the day  lands this fixture already says what it must.
    settings.JOB_LEASE_STALE_SECONDS = 2
    settings.JOB_RECLAIM_MIN_AGE_SECONDS = 1
    assert reclaim.task_threshold_seconds(CHAOS_TASK_NAME) == (
        CHAOS_PROBE_MAX_SECONDS), 'the threshold arithmetic moved'
    return settings


@pytest.fixture
def leases_enabled():
    """Require actual worker/reclaimer capability as well as its table."""
    from dj.apps.jobs import lease

    # A table-only migration does not arm worker fencing or teach the
    # reclaimer to consume leases. Even the development override that enables
    # beats without a lease-aware reclaimer cannot justify these assertions.
    if not lease.enabled() or not lease.reclaimer_reads_leases():
        return False
    with connection.cursor() as cur:
        cur.execute('SELECT to_regclass(%s)', [LEASE_TABLE])
        return cur.fetchone()[0] is not None


# ---------------------------------------------------------------------------
# the worker subprocess
# ---------------------------------------------------------------------------

@pytest.fixture
def spawn(tmp_path):
    """Start workers; guarantee none outlives the test."""
    workers: list[Worker] = []

    def _spawn(name: str, **kwargs) -> Worker:
        worker = Worker(name, tmp_path, queues=[CHAOS_QUEUE], **kwargs)
        workers.append(worker)
        return worker

    yield _spawn
    for worker in workers:
        worker.close()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _row(job_id: int):
    return ProcrastinateJob.objects.get(pk=job_id)


def _status(job_id: int) -> str:
    return _row(job_id).status


def _attempts(job_id: int) -> int:
    return _row(job_id).attempts


def _events(job_id: int) -> list[str]:
    with connection.cursor() as cur:
        cur.execute(
            'SELECT type::text FROM procrastinate_events '
            'WHERE job_id=%s ORDER BY at, id', [job_id])
        return [r[0] for r in cur.fetchall()]


def _worker_heartbeat(job_id: int):
    """(worker_id, last_heartbeat) of the row's worker, or (None, None)."""
    with connection.cursor() as cur:
        cur.execute(
            'SELECT j.worker_id, w.last_heartbeat FROM procrastinate_jobs j '
            'LEFT JOIN procrastinate_workers w ON w.id = j.worker_id '
            'WHERE j.id=%s', [job_id])
        return cur.fetchone()


def _wait_for_doing(job_id: int, worker: Worker) -> None:
    def _doing():
        if not worker.alive():
            raise AssertionError(
                f'worker {worker.name} died before fetching the job; '
                f'log:\n{worker.log()}')
        return _status(job_id) == 'doing'

    _wait_until(_doing, WORKER_START_SECONDS, f'job {job_id} to be doing')
    worker_id, _ = _worker_heartbeat(job_id)
    assert worker_id is not None, (
        'a real fetch_job sets worker_id; the reclaimer relies on that')


def _wait_for_marker(marker: Path, needle: str, timeout: float) -> str:
    def _seen():
        text = marker.read_text() if marker.exists() else ''
        return text if needle in text else None

    return _wait_until(_seen, timeout, f'marker line {needle!r}')


def _sweep():
    return async_to_sync(reclaim.reclaim_stalled_jobs)()


def _wait_for_reclaim(job_id: int, caplog) -> dict:
    """
    Poll the sweep until it requeues `job_id`, returning that sweep's
    summary. Every sweep is real; the loop exists only because the row's
    age has to cross the threshold on the database's clock.
    """
    def _reclaimed():
        summary = _sweep()
        if job_id in summary['reclaimed_ids']:
            return summary
        assert summary['gave_up'] == 0, summary
        assert summary['errors'] == 0, summary
        return None

    return _wait_until(_reclaimed, RECLAIM_WAIT_SECONDS,
                       f'the reclaimer to requeue job {job_id}', every=0.5)


def _reclaim_events(caplog) -> list[dict]:
    out = []
    for rec in caplog.records:
        if rec.name != 'dj.apps.jobs.reclaim':
            continue
        try:
            out.append(json.loads(rec.getMessage()))
        except ValueError:
            continue
    return out


def _lease(job_id: int):
    """LEASE EXTENSION POINT: the lease row, or None (no table / no row)."""
    with connection.cursor() as cur:
        cur.execute('SELECT to_regclass(%s)', [LEASE_TABLE])
        if cur.fetchone()[0] is None:
            return None
        cur.execute(
            f'SELECT last_beat_at FROM {LEASE_TABLE} WHERE job_id=%s',
            [job_id])
        row = cur.fetchone()
        return None if row is None else {'last_beat_at': row[0]}


def _set_mode(job_id: int, mode: str) -> None:
    """Change only this test's probe arguments after its worker has exited."""
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET args = args || %s::jsonb "
            "WHERE id=%s", [json.dumps({'mode': mode}), job_id])


def _assert_healed_by_the_reclaimer(job_id: int, summary: dict, caplog,
                                    leases_enabled: bool) -> None:
    """The shared post-reclaim contract of the SIGKILL and exit-137 cases."""
    assert summary['reclaimed_ids'] == [job_id]
    assert summary['gave_up'] == 0 and summary['errors'] == 0
    assert _status(job_id) == 'todo'
    # procrastinate's own counter, bumped by `retry_job` -- this IS the
    # bound's bookkeeping, and it is what says "one reclaim, no more".
    assert _attempts(job_id) == 1
    # JobManager.retry_job_by_id uses this same stored procedure. Its status
    # trigger records deferred_for_retry, and because the reclaimer supplies
    # retry_at=now the scheduled-at trigger also records scheduled. Require
    # the full database event contract instead of depending on timestamp/id
    # ordering between the two trigger inserts.
    events = _events(job_id)
    assert 'deferred_for_retry' in events
    assert 'scheduled' in events
    reclaimed = [e for e in _reclaim_events(caplog)
                 if e.get('event') == reclaim.RECLAIMED_EVENT
                 and e.get('job_id') == job_id]
    assert len(reclaimed) == 1, _reclaim_events(caplog)
    assert reclaimed[0]['task'] == CHAOS_TASK_NAME
    assert reclaimed[0]['queue'] == CHAOS_QUEUE
    if leases_enabled:
        # LEASE EXTENSION POINT: the reclaimer's last act before retry_job
        # is the compare-and-swap DELETE of the lease.
        assert _lease(job_id) is None, 'the lease must be gone after a reclaim'


def _assert_completed_by(job_id: int, worker: Worker, marker: Path) -> None:
    """A fresh worker picks up the requeued row, args untouched, and
    finishes it. `attempts` moves once more: finish_job on a `doing` row
    increments it too."""
    _wait_until(lambda: _status(job_id) == 'succeeded', COMPLETE_WAIT_SECONDS,
                f'worker {worker.name} to complete job {job_id}')
    assert f'{worker.name} finished' in marker.read_text()
    assert _attempts(job_id) == 2
    assert _events(job_id)[-1] == 'succeeded'


# ---------------------------------------------------------------------------
# guards on the probe itself
# ---------------------------------------------------------------------------

def test_the_probe_refuses_to_run_unarmed(monkeypatch):
    """
    The `exit137` mode kills the worker that runs it. A production defer
    by mistake must fail loudly in the worker, never take a lane down.
    """
    monkeypatch.delenv(ARMING_ENV_VAR, raising=False)

    class _Ctx:
        worker_name = 'test'

        @staticmethod
        def should_abort():
            return False

    with pytest.raises(chaos_tasks.ChaosProbeNotArmed):
        chaos_probe.func(_Ctx(), mode='exit137')


def test_the_probe_is_on_the_unserved_queue_with_a_bounded_retry():
    """
    What the SIGTERM case relies on: procrastinate only requeues an
    aborted job whose task has a retry strategy that agrees, so a
    retry-less probe would be recorded `aborted` and the deploy-shape
    case would be pinning nothing.
    """
    task = chaos_probe
    assert task.queue == CHAOS_QUEUE
    assert task.retry_strategy is not None
    assert task.retry_strategy.max_attempts == 3
    assert task.pass_context is True
    assert JOB_SLEEP_SECONDS < CHAOS_PROBE_MAX_SECONDS


# ---------------------------------------------------------------------------
# 1. SIGKILL from outside -- the kubelet, or a node going away
# ---------------------------------------------------------------------------

def test_sigkill_mid_job_is_reclaimed_and_completed_by_the_next_worker(
    chaos_settings, spawn, tmp_path, caplog, leases_enabled,
):
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    marker = tmp_path / 'marker'
    release = tmp_path / 'release'
    worker = spawn('chaos-1')
    job_id = chaos_probe.defer(
        mode='wait_for_release', seconds=CHAOS_HOLD_SAFETY_SECONDS,
        marker=str(marker), release=str(release),
    )

    _wait_for_doing(job_id, worker)
    _wait_for_marker(marker, 'chaos-1 ready', WORKER_START_SECONDS)
    if leases_enabled:
        # The ready marker is emitted only after the task entered its
        # explicit hold. Its persisted lease therefore belongs to this
        # still-running attempt; do not wait for a later beat that can occur
        # after a short task has naturally completed.
        assert _lease(job_id) is not None

    worker.signal(signal.SIGKILL)
    exit_code = worker.wait(10)
    # The process has exited regardless of its signal status. If the test
    # detects an unexpected exit, do not leave a runnable held task behind.
    _set_mode(job_id, 'noop')
    assert exit_code == -signal.SIGKILL
    # Nothing ran on the way out: no exception path, no finish_job.
    assert _status(job_id) == 'doing'
    assert 'chaos-1 ready' in marker.read_text()
    assert 'chaos-1 finished' not in marker.read_text()

    summary = _wait_for_reclaim(job_id, caplog)
    # The replacement proves recovery, not the hold primitive. Make this
    # queued test retry a normal completion instead of waiting for its
    # safety timeout. Do this before later assertions so a failed assertion
    # cannot leave a held chaos row for the next worker test.
    _set_mode(job_id, 'noop')
    _assert_healed_by_the_reclaimer(job_id, summary, caplog, leases_enabled)
    second = spawn('chaos-2')
    _assert_completed_by(job_id, second, marker)


# ---------------------------------------------------------------------------
# 2. exit 137 from inside -- the OOMKill shape
# ---------------------------------------------------------------------------

def test_exit_137_mid_job_is_reclaimed_and_completed_by_the_next_worker(
    chaos_settings, spawn, tmp_path, caplog, leases_enabled,
):
    """
    From the database's point of view this is identical to SIGKILL -- and
    that identity is the point: the four poster rows of  were left by
    exactly this, and nothing in the worker gets a chance to say anything.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    marker = tmp_path / 'marker'
    worker = spawn('chaos-1')
    job_id = chaos_probe.defer(mode='exit137', marker=str(marker))

    # The body kills the process almost immediately; `doing` may already be
    # what we see, or the process may already be gone. Both are the same
    # shape: wait for the exit, then read the row.
    exit_code = worker.wait(WORKER_START_SECONDS)
    # The child is confirmed dead. Make its queued retry safe before any
    # subsequent assertion can fail and leave a poison row for another test.
    _set_mode(job_id, 'noop')
    assert exit_code == OOM_KILL_EXIT_STATUS, worker.log()
    assert 'chaos-1 exiting 137' in marker.read_text()
    assert _status(job_id) == 'doing'
    worker_id, _ = _worker_heartbeat(job_id)
    assert worker_id is not None
    assert 'succeeded' not in _events(job_id)
    assert 'failed' not in _events(job_id)

    summary = _wait_for_reclaim(job_id, caplog)
    _assert_healed_by_the_reclaimer(job_id, summary, caplog, leases_enabled)

    # The first attempt was the actual exit-137 crash; its test-only retry
    # is now a safe completion so later tests cannot consume a poison row.
    second = spawn('chaos-2')
    _assert_completed_by(job_id, second, marker)


# ---------------------------------------------------------------------------
# 3. SIGTERM with a short grace -- the deploy shape
# ---------------------------------------------------------------------------

def test_sigterm_past_the_graceful_timeout_requeues_without_the_reclaimer(
    chaos_settings, spawn, tmp_path,
):
    """
    procrastinate's own path: past `--shutdown-graceful-timeout` the worker
    flags the job SHUTDOWN, the sync task sees `should_abort()`, raises
    JobAborted, and `_process_job` turns that into `retry_job` -- the row
    is back in `todo` before the process exits, with NO help from the
    sweep. This is the mechanism the manifests' terminationGracePeriod
    comments  rely on; the test pins it against the pinned
    procrastinate rather than trusting the comment.
    """
    marker = tmp_path / 'marker'
    release = tmp_path / 'release'
    worker = spawn('chaos-1', shutdown_graceful=SHUTDOWN_GRACEFUL_SECONDS)
    job_id = chaos_probe.defer(
        mode='wait_for_release', seconds=CHAOS_HOLD_SAFETY_SECONDS,
        marker=str(marker), release=str(release),
    )
    _wait_for_doing(job_id, worker)
    _wait_for_marker(marker, 'chaos-1 ready', WORKER_START_SECONDS)

    # The task's explicit hold/release contract makes this a deterministic
    # mid-job barrier: it cannot naturally finish while the release file is
    # absent, regardless of when the parent is scheduled after seeing `ready`.
    # SIGTERM remains the real worker shutdown path being tested.
    worker.signal(signal.SIGTERM)
    wait_for_worker_shutdown_state(
        worker,
        lambda: _status(job_id) == 'todo'
        and 'chaos-1 aborted' in marker.read_text(),
        WORKER_EXIT_CEILING_SECONDS,
        'worker to requeue the job and record its abort',
    )
    rc = wait_for_worker_exit(worker, WORKER_EXIT_CEILING_SECONDS)

    # Requeued by the worker itself: no sweep ran.
    # The aborting process is gone. Keep the retry harmless if any event or
    # marker assertion below fails before the replacement worker starts.
    _set_mode(job_id, 'noop')
    assert rc == 0, worker.log()
    assert _status(job_id) == 'todo'
    assert _attempts(job_id) == 1
    assert _events(job_id)[-1] == 'deferred_for_retry'
    text = marker.read_text()
    assert 'chaos-1 aborted' in text, text
    assert 'chaos-1 finished' not in text, text
    # The worker unregistered itself on the way out, so the row is not even
    # orphaned-looking: `worker_id` stays (it is only nulled by a prune) but
    # the worker row is gone.
    _, heartbeat = _worker_heartbeat(job_id)
    assert heartbeat is None

    # Release the same explicit contract for the replacement worker; this
    # keeps the second half of the test a normal successful retry.
    release.touch()
    second = spawn('chaos-2')
    _assert_completed_by(job_id, second, marker)


# ---------------------------------------------------------------------------
# 4. SIGSTOP -- the zombie: not dead, not beating
# ---------------------------------------------------------------------------

def test_a_stopped_worker_is_reclaimed_and_a_resumed_zombie_cannot_win(
    chaos_settings, spawn, tmp_path, caplog, leases_enabled,
):
    """
    Worker A is frozen mid-job. It is not dead: its connections are open,
    its worker row exists, and the moment it is continued it will finish
    the body and try to persist a status. The sweep must treat it as gone
    (its heartbeat has stopped), worker B must complete the job, and A's
    late write must NOT change the outcome.

    LEASE EXTENSION POINT -- what "must not change the outcome" means:

    * TODAY (age/orphan reclaimer, no leases): A resumes, finishes its
      body (a DUPLICATE run -- the residual the epic documents and
      closes), and its `finish_job` hits a row that is already terminal:
      `procrastinate_finish_job_v1` acts only on todo/doing, so it
      raises, A logs an error, and the row stays `succeeded` with
      `attempts == 2`. Asserted below.
    * WITH WORKER LEASES AND A LEASE-AWARE RECLAIMER: A's next beat finds its lease fenced,
      the middleware aborts the body, the run writes no status at all and
      `event=procrastinate_lease_fenced` is emitted; the marker must NOT
      show `chaos-1 finished`. Asserted below when `leases_enabled`.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    marker = tmp_path / 'marker'
    release = tmp_path / 'release'
    # A short beat makes the zombie's first post-resume persistence attempt
    # deterministic while its task remains behind the explicit body barrier.
    zombie = spawn(
        'chaos-1', extra_env={'JOB_LEASE_BEAT_SECONDS': '0.2'})
    job_id = chaos_probe.defer(
        mode='wait_for_release', seconds=CHAOS_HOLD_SAFETY_SECONDS,
        marker=str(marker), release=str(release),
    )
    _wait_for_doing(job_id, zombie)
    _wait_for_marker(marker, 'chaos-1 ready', WORKER_START_SECONDS)

    zombie.signal(signal.SIGSTOP)
    _wait_until(lambda: _process_state(zombie.pid) == 'stopped', 5,
                'the zombie to be stopped')
    assert zombie.alive()  # stopped, not dead -- that is the whole case

    summary = _wait_for_reclaim(job_id, caplog)
    _assert_healed_by_the_reclaimer(job_id, summary, caplog, leases_enabled)
    # Still frozen, still holding its row in the workers table.
    assert zombie.alive() and _process_state(zombie.pid) == 'stopped'

    # The old attempt already has its task kwargs. The new queue attempt
    # should complete normally, even if an assertion later fails and another
    # owned worker sees it.
    _set_mode(job_id, 'noop')
    second = spawn('chaos-2')
    _assert_completed_by(job_id, second, marker)

    # Now let the zombie back in. Its body resumes exactly where SIGSTOP
    # left it and it tries to persist.
    zombie.signal(signal.SIGCONT)
    if leases_enabled:
        # LEASE EXTENSION POINT
        _wait_until(lambda: 'procrastinate_lease_fenced' in zombie.log(), 30,
                    'the zombie to be fenced')
        assert 'chaos-1 finished' not in marker.read_text(), (
            'a fenced zombie must not complete its body')
    else:
        # Without leases the old body is deliberately still live. Release it
        # to prove the documented duplicate-body residual and finish_job
        # rejection without waiting for the safety timeout.
        release.touch()
        _wait_for_marker(marker, 'chaos-1 finished', 30)
        # The residual, stated: the body ran twice on today's reclaimer.
        assert marker.read_text().count('finished') == 2
        _wait_until(
            lambda: 'not in "doing" or "todo" status' in zombie.log(), 30,
            "procrastinate to refuse the zombie's finish_job")
    if zombie.alive():
        try:
            zombie.signal(signal.SIGTERM)
        except ProcessLookupError:
            pass
    zombie_rc = wait_for_worker_exit(zombie, WORKER_EXIT_CEILING_SECONDS)
    assert zombie_rc == 0, zombie.log()

    # Whatever the zombie did, the row's outcome is B's.
    assert _status(job_id) == 'succeeded'
    assert _attempts(job_id) == 2
    assert _events(job_id).count('succeeded') == 1


# ---------------------------------------------------------------------------
# the in-suite negative control: without the sweep, nothing heals
# ---------------------------------------------------------------------------

def test_wait_until_exited_rejects_a_stopped_worker(spawn):
    """A stopped-but-live worker must not satisfy the exit wait."""
    worker = spawn('chaos-negative')
    _wait_until(worker.alive, WORKER_START_SECONDS,
                'the negative-control worker to start')
    worker.signal(signal.SIGSTOP)
    _wait_until(lambda: _process_state(worker.pid) == 'stopped', 5,
                'the negative-control worker to be stopped')

    with pytest.raises(WorkerExitWaitTimeout, match='to exit'):
        worker.wait_until_exited(0.5)


def test_without_the_sweep_a_killed_workers_row_stays_stranded(
    chaos_settings, spawn, tmp_path,
):
    """
    The pre- state, reproduced on purpose so the four cases above
    cannot pass vacuously: after a SIGKILL the row sits in `doing` for
    longer than the whole reclaim threshold and nothing else moves it.
    If this test ever fails, something OTHER than the reclaimer is
    requeueing rows and the four cases above no longer prove what they
    say they prove.
    """
    marker = tmp_path / 'marker'
    worker = spawn('chaos-1')
    job_id = chaos_probe.defer(mode='sleep', seconds=JOB_SLEEP_SECONDS,
                               marker=str(marker))
    _wait_for_doing(job_id, worker)
    worker.signal(signal.SIGKILL)
    assert worker.wait(10) == -signal.SIGKILL

    time.sleep(CHAOS_PROBE_MAX_SECONDS + 2)

    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0
    worker_id, heartbeat = _worker_heartbeat(job_id)
    assert worker_id is not None and heartbeat is not None


@pytest.mark.parametrize("worker_enabled", [False, True])
def test_table_only_migration_does_not_enable_lease_assertions(
    settings, request, monkeypatch, worker_enabled,
):
    settings.JOB_LEASE_ENABLED = worker_enabled
    settings.JOB_LEASE_WITHOUT_RECLAIMER = True
    monkeypatch.setattr(reclaim, "READS_LEASES", False, raising=False)
    with connection.cursor() as cur:
        cur.execute("CREATE TEMP TABLE jobs_joblease (job_id bigint)")
    try:
        assert request.getfixturevalue("leases_enabled") is False
    finally:
        with connection.cursor() as cur:
            cur.execute("DROP TABLE pg_temp.jobs_joblease")
