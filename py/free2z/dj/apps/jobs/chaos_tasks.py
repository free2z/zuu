"""
The chaos probe: a procrastinate task that exists to be killed.

WHY A TASK THAT DOES NOTHING IS WORTH A MODULE
----------------------------------------------
Every reclaimer test before this one (``test_reclaim_stalled.py``) drives
the sweep against rows it *fabricates* in ``doing`` -- ``_mark_doing``
UPDATEs the status column and backdates the ``started`` event. That
proves the sweep's arithmetic. It proves nothing about what a real worker
leaves behind when it dies: whether ``worker_id`` is set the way the
sweep expects, whether procrastinate's own SIGTERM path really puts the
row back, whether a stopped-but-not-dead worker can write over a
replacement. The dominant defect class in this repository is tests that
pass without testing, and "the row heals after a real OOMKill" had never
once been observed by CI.

So ``test_chaos_worker.py`` spawns a REAL ``manage.py procrastinate
worker`` subprocess against the test database, defers this task onto it,
and then kills the worker four different ways. This module is the task
those tests need: one whose body can sleep long enough to be interrupted,
can abort cooperatively (the only way a synchronous task can honour
procrastinate's shutdown), and can kill its own process from the inside
(``os._exit(137)`` -- from the database's point of view identical to the
kernel's OOMKill: no ``finish_job``, no exception path, nothing).

WHY IT CANNOT RUN IN PRODUCTION
-------------------------------
``mode="exit137"`` kills the worker that runs it, and a worker is a shared
lane. The task is therefore refused unless the process was started with
``JOBS_CHAOS_PROBE_ALLOWED=1`` in its environment, which only the chaos
tests set on the subprocesses they own. A row somebody defers into a
production queue by mistake fails (three times, then terminally) and
pages through ``jobs_failed``; it never takes a lane down.

It also lives on its own queue, ``chaos``, which NO worker manifest
serves -- ``test_queue_isolation.py`` allows exactly this one queue to be
unserved, by name. A stray production row would therefore sit in ``todo``
forever rather than reach a worker at all, and ``todo_overdue`` on the
``chaos`` queue would say so.

THE LEASE EXTENSION POINT
-------------------------
The chaos tests exercise the merged age-and-orphan reclaimer. Lease-specific
assertions require enabled worker leases, a lease-aware reclaimer, and the
``jobs_joblease`` table. A table-only migration is insufficient. See
``leases_enabled`` in the test module. The lease-specific branch still needs
its first real runtime verification when the lease-aware reclaimer lands.

UNITS: every duration here is **seconds**.
"""
from __future__ import annotations

import logging
import os
import time

from procrastinate import RetryStrategy, exceptions
from procrastinate.contrib.django import app

logger = logging.getLogger(__name__)

#The test-only queue. Served by no manifest, on purpose.
CHAOS_QUEUE = 'chaos'

#The task name, as it appears in ``procrastinate_jobs.task_name`` and in
#``reclaim_policy.TASK_POLICIES``.
CHAOS_TASK_NAME = 'jobs.chaos_probe'

#The environment variable that ARMS the task. Absent, the body raises
#before doing anything at all -- see the module docstring.
ARMING_ENV_VAR = 'JOBS_CHAOS_PROBE_ALLOWED'

#Worst-case wall clock of ONE healthy run: the ``sleep`` mode clamps its
#argument to this, so no argument can make a run longer. This is the
#number ``reclaim_policy`` carries as the task's budget, and therefore
#-- with ``JOB_RECLAIM_BUDGET_MARGIN_SECONDS`` at 0 and the floor at 1 --
#the age a stranded chaos row must reach before the sweep will touch it.
#Small, so a chaos case fits its own budget (< 15s) while still being a
#run long enough to be killed mid-way.
CHAOS_PROBE_MAX_SECONDS = 5

#How often the ``sleep`` mode checks ``context.should_abort()``. This is
#the latency of a cooperative abort, and so of the SIGTERM case.
ABORT_POLL_SECONDS = 0.05

#Safety ceiling for the explicit SIGTERM synchronization contract. The
#``wait_for_release`` mode never reaches its normal completion until the
#release file exists, but a broken test or worker must still be bounded.
CHAOS_HOLD_SAFETY_SECONDS = 30

#A bounded strategy, for two reasons. Procrastinate's SHUTDOWN -> retry
#path (``worker.py``, ``_process_job``) only requeues an aborted job if
#its task HAS a retry strategy that says yes -- a task with none is
#recorded ``aborted`` and lost. And ``reclaim_policy.retry_allowance``
#needs a ``max_attempts`` to tell reclaims from retries.
CHAOS_RETRY = RetryStrategy(max_attempts=3)

MODES = ('noop', 'sleep', 'wait_for_release', 'exit137')

#The exit status of a process the kernel OOM-killed: 128 + SIGKILL(9).
OOM_KILL_EXIT_STATUS = 137


class ChaosProbeNotArmed(RuntimeError):
    """Raised when the task runs in a process that did not opt in."""


def _mark(marker: str | None, worker_name: str | None, what: str) -> None:
    """Append one line to the marker file, if the test asked for one.

    The marker is how a test learns that a BODY ran (and in which worker),
    as opposed to what the database says happened. On today's reclaimer
    those two can disagree -- a stopped worker resumes and finishes a body
    the sweep already requeued -- and that disagreement is exactly what the
    zombie case has to be honest about.
    """
    if not marker:
        return
    with open(marker, 'a', encoding='utf-8') as fh:
        fh.write(f'{worker_name or "worker"} {what} pid={os.getpid()}\n')
        fh.flush()
        os.fsync(fh.fileno())


@app.task(
    name=CHAOS_TASK_NAME,
    queue=CHAOS_QUEUE,
    pass_context=True,
    retry=CHAOS_RETRY,
)
def chaos_probe(context, mode: str, seconds: float = 0,
                marker: str | None = None,
                release: str | None = None) -> dict:
    """
    ``mode``:

    * ``noop``    -- return immediately.
    * ``sleep``   -- sleep ``min(seconds, CHAOS_PROBE_MAX_SECONDS)`` in
                     ``ABORT_POLL_SECONDS`` slices, raising ``JobAborted``
                     the moment procrastinate asks (the cooperative abort a
                     sync task has to implement itself: ``_abort_job`` only
                     sets the flag for us).
    * ``wait_for_release`` -- append ``ready`` and remain abortable until
                         ``release`` exists. The safety ceiling prevents a
                         malformed test from waiting forever.
    * ``exit137`` -- terminate the whole process with the OOMKill status,
                     mid-run, from inside the task. No ``finish_job``, no
                     exception, no event.

    ``marker`` is a file path; each phase appends a line naming the worker.
    ``release`` is required by ``wait_for_release`` and is a file path the
    test creates only when it wants the task to finish normally.
    """
    if os.environ.get(ARMING_ENV_VAR) != '1':
        raise ChaosProbeNotArmed(
            f'{CHAOS_TASK_NAME} refuses to run: {ARMING_ENV_VAR}=1 is not '
            'set in this process. This task exists for the CI chaos tests '
            'and kills the worker that runs it.')
    if mode not in MODES:
        raise ValueError(f'unknown chaos mode {mode!r}; one of {MODES}')

    worker_name = getattr(context, 'worker_name', None)
    _mark(marker, worker_name, f'started mode={mode}')

    if mode == 'exit137':
        _mark(marker, worker_name, 'exiting 137')
        # NOT sys.exit, NOT raise: those run finally blocks and reach
        # procrastinate's status persistence. os._exit is what the kernel's
        # SIGKILL looks like from inside the process -- nothing after this
        # line runs, on any thread.
        os._exit(OOM_KILL_EXIT_STATUS)

    if mode == 'sleep':
        budget = min(float(seconds), float(CHAOS_PROBE_MAX_SECONDS))
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            if context.should_abort():
                _mark(marker, worker_name, 'aborted')
                raise exceptions.JobAborted
            time.sleep(ABORT_POLL_SECONDS)

    if mode == 'wait_for_release':
        if not release:
            raise ValueError('wait_for_release requires a release path')
        _mark(marker, worker_name, 'ready')
        deadline = time.monotonic() + CHAOS_HOLD_SAFETY_SECONDS
        while not os.path.exists(release):
            if context.should_abort():
                _mark(marker, worker_name, 'aborted')
                raise exceptions.JobAborted
            if time.monotonic() >= deadline:
                _mark(marker, worker_name, 'safety timeout')
                raise TimeoutError(
                    'chaos probe release was not signalled before its '
                    f'{CHAOS_HOLD_SAFETY_SECONDS}s safety ceiling')
            time.sleep(ABORT_POLL_SECONDS)

    _mark(marker, worker_name, 'finished')
    return {'mode': mode, 'worker': worker_name, 'pid': os.getpid()}
