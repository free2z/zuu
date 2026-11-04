"""Keep Procrastinate worker metadata pools bounded by job concurrency.

This module is also where the worker's LIVENESS BEACON is installed. Both procrastinate workers used to ship with no probes at all, so a
consumer that converged once and then wedged, deadlocked, or silently stopped
fetching read as healthy for the life of the Deployment.

The beacon is a file whose mtime the kubelet can read with an `exec` probe:

  * `configure()` runs only in worker containers (it is gated on
    `PROCRASTINATE_WORKER_POOL_SIZE`, which only the worker pod templates set),
    so nothing is installed in a web/API/CronJob process.
  * It wraps `app.job_manager.update_heartbeat` so a *successful* heartbeat
    UPDATE also touches the file. Procrastinate's own heartbeat task stops the
    worker when the UPDATE raises (`procrastinate/worker.py`), so "the file is
    fresh" means exactly "this process is still a live consumer of the queue".
  * NOTHING ELSE CREATES THE FILE. It was briefly touched at configure time so
    the probe had something to `stat` during startup, and that was wrong: with
    `maxUnavailable: 0` on the worker Deployments, a replacement that reports
    ready before it has reached the database is exactly what lets Kubernetes
    delete the pod that WAS consuming (codex adversarial review, finding 2).
    The startup window is funded by a `startupProbe` in the pod templates
    instead, which disables the other two probes until the first accepted
    heartbeat writes the file.
  * `/tmp` is an emptyDir, and an emptyDir OUTLIVES a container restart. A
    container that beat once, crashed, and came back would otherwise find its
    predecessor's fresh beacon and pass startup and readiness while the new
    process was still blocked reaching Postgres (codex adversarial review
    round 2, finding 3). `configure()` therefore unlinks the file before
    installing the wrapper, so the beacon can only ever describe THIS process.
    That unlink races the kubelet, though -- it happens inside the entrypoint,
    and no fixed `initialDelaySeconds` can ORDER two independent things -- so
    the pod templates also clear the beacon from a `lifecycle.postStart` hook,
    which Kubernetes runs before the container is marked Running and therefore
    before the container gets any probe workers. This function keeps the unlink
    anyway: the invariant belongs with the code that owns the file.

There is a SECOND file, ``/tmp/procrastinate-draining``, and it exists because
the beacon alone says the wrong thing during a shutdown. procrastinate cancels
its heartbeat side task BEFORE it waits ``--shutdown-graceful-timeout`` for the
job in flight, so the beacon freezes at the first instant of a drain the
manifests fund for 390s (2040s on exports). The kubelet hides that on a rollout
(it stops liveness and startup probes for a pod with a deletionTimestamp), but
procrastinate also stops ITSELF when a side task raises -- a Cloud SQL blip on
the heartbeat UPDATE -- and there liveness is still armed. ``Worker.stop()`` is
therefore wrapped to create the marker, and only the liveness probe honours it.
See ``DEFAULT_DRAINING_FILE`` below for the full reasoning.

A touch failure is deliberately swallowed with a log line rather than raised:
raising would propagate into procrastinate's heartbeat task and stop a worker
that is otherwise healthy, turning a beacon problem into a queue outage. A
beacon that stops being written stops the probe instead, which is the outcome
the probe exists for.
"""

from __future__ import annotations

import asyncio
import logging
import os

from django.core.exceptions import ImproperlyConfigured
from procrastinate.contrib.django.django_connector import DjangoConnector

from dj.apps.jobs import task_not_found_alert
from dj.free2z import db_pooler

logger = logging.getLogger(__name__)

# `/tmp` is the writable emptyDir on every worker pod; the root filesystem is
# read-only, so this path is not negotiable in the container.
DEFAULT_ALIVE_FILE = "/tmp/procrastinate-alive"

#The DRAIN MARKER, and why the beacon alone is not enough (codex
#round 5 finding 1).
#
#procrastinate's `_shutdown()` cancels its side tasks -- the heartbeat among
#them -- BEFORE it waits `--shutdown-graceful-timeout` for the job in flight.
#So the beacon freezes at the FIRST INSTANT of a drain, and a `livenessProbe`
#reading only the beacon would kill the container ~105s into a drain the
#manifests deliberately fund for 390s (2040s on the exports lane).
#
#On a ROLLOUT that is harmless: the kubelet stops liveness and startup probes
#on a pod with a deletionTimestamp. But procrastinate also stops the worker
#with no deletionTimestamp in sight -- `_monitor_side_tasks` calls `stop()`
#when a side task raises, which is what a 15s Cloud SQL blip does to the
#heartbeat UPDATE. There, liveness DOES apply, and killing the container
#aborts a job that was going to finish. That is 's own bug on a
#different trigger, and for the two lanes whose tasks are NEVER reclaimable
#(`exports.export_publication` and `dyte.retry_recording_delivery`, see
#dj.apps.jobs.reclaim_policy) nothing re-runs the lost work: the export's
#PublicationExportJob simply sits in RUNNING until the abandonment sweep
#fails it.
#
#So the worker announces its own drain. `Worker.stop()` -- the single entry
#point every stop path goes through (the SIGTERM handler installed by
#`signals.on_stop(self.stop)`, and `_monitor_side_tasks`) -- creates this
#file, and the liveness probe treats its presence as "alive, deliberately
#draining". The startupProbe honours it too: procrastinate fetches jobs
#BEFORE its first heartbeat (it sleeps `update_heartbeat_interval` first), so
#a worker can claim a job and then lose that first UPDATE -- no beacon ever
#written, a real drain under way -- and a startupProbe blind to the marker
#would kill the container on its 30s probe grace. READINESS goes the other
#way and FAILS on the marker: the beacon stays fresh for up to its own 30s
#window after `stop()`, and readiness is the gate `maxUnavailable: 0` uses,
#so inside that window a replacement already committed to a drain would read
#Ready and Kubernetes would retire the healthy old replica in its favour.
#
#THE PROBE BOUNDS THE EXEMPTION BY THIS FILE'S AGE, and it has to:
#`--shutdown-graceful-timeout` does NOT guarantee the process exits. Past it
#procrastinate calls `_abort_running_jobs()`, which for a SYNCHRONOUS task
#only sets `context.should_abort` -- upstream leaves the job "responsible for
#aborting by checking context.should_abort", and `exports.export_publication`
#/ `dyte.retry_recording_delivery` take no JobContext -- and then awaits an
#unbounded `asyncio.gather`. On the path where this marker matters there is
#no deletionTimestamp, so there is no kubelet grace to end it either. The
#manifests therefore exempt the drain only while the marker is younger than
#the lane's own drain budget plus 60s (`%{DRAIN_EXEMPT_SECONDS}`, 2100 on
#exports); past that the drain is wedged rather than slow and the container
#is restarted.
DEFAULT_DRAINING_FILE = "/tmp/procrastinate-draining"

#How long one heartbeat UPDATE may take before the worker gives up on it
#(codex round 8 finding 1).
#
#The drain marker above covers a heartbeat that RAISES. It does nothing for
#one that simply never returns -- a blackholed connection, a blocked UPDATE --
#because procrastinate then never calls `stop()`, no marker is written, and
#the beacon goes stale with a healthy job still running. Liveness fires ~105s
#after the last good beat (a 60s window plus 3 x 15s) and kills the container
#on the probe's own 30s grace, which is not enough for a job the manifests
#fund 390s or 2040s of drain for. Neither procrastinate's connector nor
#Django's DATABASES sets a statement or network deadline, so nothing else
#bounds it.
#
#Bounding it here converts the un-handled case into the handled one: the
#wrapper raises, `_monitor_side_tasks` calls `stop()`, the marker is written
#and the job gets its funded drain. 30s is also procrastinate's own
#`stalled_worker_timeout` default -- past it the worker is already considered
#stalled upstream and another worker may take its jobs, so continuing to wait
#buys nothing. `test_queue_isolation.py` asserts the arithmetic that makes
#this work: one beat interval plus this timeout must land inside the liveness
#window, so the marker exists before the first probe can fail.
HEARTBEAT_TIMEOUT_SECONDS = 30.0


def _heartbeat_timeout() -> float:
    raw = os.environ.get("PROCRASTINATE_HEARTBEAT_TIMEOUT_SECONDS")
    if not raw:
        return HEARTBEAT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError as exc:
        raise ImproperlyConfigured(
            "PROCRASTINATE_HEARTBEAT_TIMEOUT_SECONDS must be a positive number"
        ) from exc
    if value <= 0:
        raise ImproperlyConfigured(
            "PROCRASTINATE_HEARTBEAT_TIMEOUT_SECONDS must be a positive number"
        )
    return value


def _alive_file() -> str:
    return os.environ.get("PROCRASTINATE_ALIVE_FILE") or DEFAULT_ALIVE_FILE


def _draining_file() -> str:
    return os.environ.get("PROCRASTINATE_DRAINING_FILE") or DEFAULT_DRAINING_FILE


def touch_alive_file(path: str) -> bool:
    """Create/refresh the beacon's mtime. Returns whether it succeeded."""
    try:
        os.close(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600))
        os.utime(path, None)
    except OSError:
        logger.warning(
            "procrastinate liveness beacon could not be written",
            extra={"event": "procrastinate_alive_file_error", "path": path},
            exc_info=True,
        )
        return False
    return True


def _pool_size() -> int | None:
    raw = os.environ.get("PROCRASTINATE_WORKER_POOL_SIZE")
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError as exc:
        raise ImproperlyConfigured(
            "PROCRASTINATE_WORKER_POOL_SIZE must be a positive integer"
        ) from exc
    if value < 1:
        raise ImproperlyConfigured(
            "PROCRASTINATE_WORKER_POOL_SIZE must be a positive integer"
        )
    return value


def listen_notify_enabled() -> bool:
    """Whether a worker started with ``--listen-notify`` may really LISTEN.

    ``PROCRASTINATE_LISTEN_NOTIFY``, default ``true`` -- today's
    behaviour, where the flag in the manifest decides. ``false`` turns the
    billing lane (the only one started with ``--listen-notify``) into a
    polling worker without a manifest change: LISTEN is SESSION state, and
    behind PgBouncer in transaction mode the backend that registered it is
    handed to another client straight away, so notifications would be lost.
    The lane already polls every 5 s (``--fetch-job-polling-interval=5``,
    ``--abort-job-polling-interval=5``), and the catch-all worker polls
    ``billing`` too, so the cost is at most one interval of pickup latency on
    an idle lane. A lane started with ``--no-listen-notify`` is unaffected.
    """
    # The one parser: prod_settings' pooler boot guard reads the same
    # function, so the two can never disagree about what a value means.
    return db_pooler.listen_notify_enabled(os.environ)


def _polling_only_connector_class():
    from procrastinate import psycopg_connector

    class PollingOnlyPsycopgConnector(psycopg_connector.PsycopgConnector):
        """A worker connector whose LISTEN side task never opens a connection.

        It PARKS rather than returning. procrastinate runs the listener as one
        of the worker's side tasks and ``_monitor_side_tasks`` waits for the
        FIRST of them to complete: a listener that returned at once would end
        that wait, and a later heartbeat failure would then go unnoticed
        instead of stopping the worker. Parked, it is cancelled at shutdown
        with the other side tasks, and the worker's fetch loop falls back to
        its polling interval exactly as it does for ``--no-listen-notify``.
        """

        async def listen_notify(self, on_notification, channels) -> None:
            logger.info(
                "procrastinate LISTEN disabled by PROCRASTINATE_LISTEN_NOTIFY; "
                "this worker polls",
                extra={"event": "procrastinate_listen_notify_disabled"},
            )
            await asyncio.Event().wait()

    return PollingOnlyPsycopgConnector


class BoundedDjangoConnector(DjangoConnector):
    """Create worker connectors with a pool sized for this worker's concurrency."""

    def __init__(self, *, alias: str, pool_size: int) -> None:
        super().__init__(alias=alias)
        self.pool_size = pool_size

    def get_worker_connector(self):
        from procrastinate.contrib.django import utils

        if utils.package_is_installed("psycopg") and utils.package_is_version(
            "psycopg", 3
        ):
            from procrastinate import psycopg_connector

            connector_class = (
                psycopg_connector.PsycopgConnector
                if listen_notify_enabled()
                else _polling_only_connector_class()
            )
            # connector_params() is Django's own get_connection_params(), so
            # every pool connection inherits DATABASES OPTIONS -- including
            # prepare_threshold=None (pinned by
            # test_pgbouncer_settings.py).
            return connector_class(
                kwargs=utils.connector_params(self.alias),
                min_size=self.pool_size,
                max_size=self.pool_size,
            )
        raise ImproperlyConfigured(
            "bounded Procrastinate workers require psycopg 3"
        )


def clear_alive_file(path: str) -> None:
    """Drop a beacon left behind by a previous container incarnation."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning(
            "procrastinate liveness beacon could not be cleared",
            extra={"event": "procrastinate_alive_file_error", "path": path},
            exc_info=True,
        )


def _discard_result(task) -> None:
    """Retrieve an abandoned task's outcome so nothing logs it at GC time."""
    try:
        if not task.cancelled():
            task.exception()
    except asyncio.CancelledError:
        pass
    except Exception:  # pragma: no cover - defensive
        pass


def install_liveness_beacon(app, path: str | None = None) -> str:
    """Touch `path` after every heartbeat this worker successfully records."""
    alive_file = path or _alive_file()
    manager = app.job_manager
    if getattr(manager.update_heartbeat, "_f2z_liveness_beacon", False):
        return alive_file
    clear_alive_file(alive_file)
    wrapped = manager.update_heartbeat

    timeout = _heartbeat_timeout()

    async def update_heartbeat(worker_id):
        # Order matters: only a heartbeat the database actually accepted may
        # refresh the beacon. `wrapped` raising propagates untouched so
        # procrastinate keeps its own "stop the worker" behaviour.
        #
        # The timeout turns a heartbeat that HANGS into one that raises, which
        # is the case procrastinate already handles (stop the worker) and the
        # only one the drain marker can protect. See HEARTBEAT_TIMEOUT_SECONDS.
        #
        # NOT `asyncio.wait_for` (codex round 9). `wait_for` cancels the
        # inner coroutine and then AWAITS that cancellation, and psycopg's
        # `AsyncConnection.wait()` catches CancelledError, issues a server-side
        # cancel and waits on the same socket again -- with no deadline. On a
        # blackholed connection, the one thing this timeout exists to bound is
        # the thing that would keep it suspended. So the deadline is taken on a
        # separate task and the cancellation is fire-and-forget: we raise on
        # time whatever the driver does afterwards.
        task = asyncio.ensure_future(wrapped(worker_id))
        try:
            done, _pending = await asyncio.wait({task}, timeout=timeout)
        except BaseException:
            # The WRAPPER was cancelled -- which is exactly what `_shutdown()`
            # does to the heartbeat side task (codex round 10). Without this,
            # the separately scheduled database task outlives its deadline
            # entirely and keeps holding a metadata connection that, on a
            # POOL_SIZE=1 lane, is the only one a finishing job has to record
            # its completion with.
            task.cancel()
            task.add_done_callback(_discard_result)
            raise
        if not done:
            task.cancel()
            # Nobody will await it, so consume whatever it ends up with; an
            # un-retrieved exception is an unactionable ERROR log at GC time.
            # The abandoned task keeps its pool connection until the process
            # exits, which it is now on its way to doing: this raise reaches
            # procrastinate's `_monitor_side_tasks`, which calls `stop()`.
            task.add_done_callback(_discard_result)
            raise TimeoutError(
                f"procrastinate heartbeat did not complete in {timeout}s"
            )
        result = task.result()
        touch_alive_file(alive_file)
        return result

    update_heartbeat._f2z_liveness_beacon = True
    manager.update_heartbeat = update_heartbeat
    return alive_file


def install_drain_marker(path: str | None = None) -> str:
    """Have `Worker.stop()` announce that this process is draining on purpose.

    Patches the class, not an instance: the worker object is built later, by
    procrastinate's own management command, and every stop path in
    `procrastinate/worker.py` funnels through this one public method (the
    SIGTERM handler is installed as `signals.on_stop(self.stop)`, and
    `_monitor_side_tasks` calls `self.stop()` when a side task raises).

    Degrades rather than crashloops. If a procrastinate upgrade renames or
    removes `stop`, this logs and returns: the worker keeps consuming and we
    are back to today's behaviour, rather than every worker Deployment failing
    to start over a probe detail. `test_procrastinate_pool.py` pins the
    method's existence so a bump cannot make that degrade silently.
    """
    draining_file = path or _draining_file()
    from procrastinate import worker as worker_module

    original = getattr(worker_module.Worker, "stop", None)
    if original is None or not callable(original):
        logger.warning(
            "procrastinate Worker.stop is missing; the drain marker is not "
            "installed and a graceful drain may be cut short by the liveness "
            "probe",
            extra={"event": "procrastinate_drain_marker_unavailable"},
        )
        return draining_file
    if getattr(original, "_f2z_drain_marker", False):
        return draining_file

    def stop(self):
        # Before delegating: `stop()` returns early once the stop event is
        # already set, and the marker has to be on disk before the first probe
        # that lands after the heartbeat stopped.
        touch_alive_file(draining_file)
        return original(self)

    stop._f2z_drain_marker = True
    worker_module.Worker.stop = stop
    return draining_file


def configure(app) -> None:
    """Install the bounded connector and liveness beacon in worker containers."""
    # Unconditional, unlike everything below: TaskNotFound
    # is a worker-only failure mode, but this must not silently vanish for a
    # worker started without PROCRASTINATE_WORKER_POOL_SIZE (deliberately
    # unset by dj.apps.jobs.worker_harness's real-subprocess test workers).
    # It only attaches a logging handler -- inert on a non-worker process.
    task_not_found_alert.install()

    pool_size = _pool_size()
    if pool_size is None:
        return
    from dj.apps.jobs.lease import install_queue_fetch_gate

    install_queue_fetch_gate(app.job_manager)
    if not isinstance(app.connector, DjangoConnector):
        raise ImproperlyConfigured(
            "PROCRASTINATE_WORKER_POOL_SIZE requires the Django connector"
        )
    app.connector = BoundedDjangoConnector(
        alias=app.connector.alias,
        pool_size=pool_size,
    )
    app.job_manager.connector = app.connector
    install_liveness_beacon(app)
    # A drain marker left by a previous incarnation would suppress liveness for
    # a process that never started draining -- same emptyDir-outlives-the-
    # container reasoning as the beacon.
    #
    # THIS, not a postStart hook, is where the marker is cleared. postStart
    # runs CONCURRENTLY with the container's own process (Kubernetes only
    # guarantees it completes before the container is marked Running), so under
    # contention it can fire after the worker has claimed a job, lost a
    # heartbeat and written a LEGITIMATE marker -- and deleting that truncates
    # the funded drain and loses a job the exports and recordings lanes never
    # reclaim. Here the ordering is guaranteed instead: app-ready is strictly
    # before any Worker exists, and therefore strictly before any `stop()`.
    clear_alive_file(_draining_file())
    install_drain_marker()
