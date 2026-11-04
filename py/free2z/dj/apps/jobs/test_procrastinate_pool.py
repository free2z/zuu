"""The worker liveness beacon that the k8s exec probes read.

`k8s/free2z/worker/*.yaml` restart a worker whose /tmp/procrastinate-alive is
more than 60s old and take it out of the rollout at 30s. That is only a real
signal if the file is refreshed by something that stops when the worker stops
consuming — so the ONE property worth pinning here is the pairing:

    a heartbeat the database ACCEPTED  ->  the file's mtime moves
    a heartbeat that RAISED            ->  the file's mtime does not move

The second half is the whole point. procrastinate's heartbeat task stops the
worker when `update_heartbeat` raises (`procrastinate/worker.py`), so a beacon
that was refreshed before the UPDATE — or regardless of it — would keep a
process that has lost its database green until the kubelet's own probe timeout,
which is exactly the "monitored and green" failure  describes.

bin/test-worker-liveness.sh covers the other side of the contract: that the
shell in the manifest actually fails on a stale or missing file.
"""

import asyncio
import os

import pytest
from django.core.exceptions import ImproperlyConfigured
from procrastinate import worker as procrastinate_worker
from procrastinate.contrib.django.django_connector import DjangoConnector

from dj.apps.jobs import procrastinate_pool


@pytest.fixture(autouse=True)
def restore_worker_stop():
    """`install_drain_marker` patches a CLASS, so undo it between tests.

    Nothing else in the suite calls `Worker.stop`, but a patch that outlives
    its test would hold a reference to a `tmp_path` that no longer exists and
    would make the next failure impossible to read.
    """
    original = procrastinate_worker.Worker.stop
    yield
    procrastinate_worker.Worker.stop = original


class FakeJobManager:
    """Just enough of procrastinate's JobManager for the wrapper to wrap."""

    def __init__(self, exc=None):
        self.calls = []
        self.exc = exc
        self.connector = None
        self.fetch_calls = []

    async def fetch_job(self, *, queues, worker_id):
        """Expose the public JobManager fetch contract wrapped for workers."""
        self.fetch_calls.append((queues, worker_id))
        return None

    async def update_heartbeat(self, worker_id):
        self.calls.append(worker_id)
        if self.exc is not None:
            raise self.exc
        return "updated"


class FakeApp:
    def __init__(self, exc=None):
        self.connector = DjangoConnector(alias="default")
        self.job_manager = FakeJobManager(exc=exc)


def _mtime(path):
    return os.stat(path).st_mtime


def test_a_successful_heartbeat_refreshes_the_beacon(tmp_path):
    beacon = tmp_path / "procrastinate-alive"
    app = FakeApp()

    procrastinate_pool.install_liveness_beacon(app, str(beacon))
    # Installing must NOT create it: until a heartbeat has been accepted this
    # process is not a consumer, and the startupProbe is what funds that gap.
    assert not beacon.exists()

    result = asyncio.run(app.job_manager.update_heartbeat(7))

    assert result == "updated", "the wrapper must not swallow the return value"
    assert app.job_manager.calls == [7], "the real heartbeat must still run"
    assert _mtime(beacon) > 0


def test_a_failing_heartbeat_does_not_refresh_the_beacon(tmp_path):
    beacon = tmp_path / "procrastinate-alive"
    app = FakeApp(exc=RuntimeError("connection reset"))

    procrastinate_pool.install_liveness_beacon(app, str(beacon))

    with pytest.raises(RuntimeError):
        asyncio.run(app.job_manager.update_heartbeat(7))

    assert not beacon.exists(), (
        "a heartbeat the database refused must leave the beacon stale; "
        "otherwise a worker that has lost its database still probes green"
    )


def test_installing_drops_a_previous_incarnation_s_beacon(tmp_path):
    """/tmp is an emptyDir and survives a container restart.

    A container that beat once, crashed and restarted would otherwise find its
    predecessor's fresh file and pass startup+readiness while the new process
    was still blocked reaching Postgres — and during a rollout that transient
    Ready is what authorises deleting the last pod that was really consuming.
    """
    beacon = tmp_path / "procrastinate-alive"
    beacon.write_bytes(b"")  # the dead process's beacon, arbitrarily fresh
    app = FakeApp()

    procrastinate_pool.install_liveness_beacon(app, str(beacon))

    assert not beacon.exists()


def test_the_beacon_is_installed_once(tmp_path):
    """A second `configure()` must not stack a second wrapper on the manager."""
    beacon = tmp_path / "procrastinate-alive"
    app = FakeApp()

    procrastinate_pool.install_liveness_beacon(app, str(beacon))
    first = app.job_manager.update_heartbeat
    procrastinate_pool.install_liveness_beacon(app, str(beacon))

    assert app.job_manager.update_heartbeat is first


def test_an_unwritable_beacon_does_not_break_the_heartbeat(tmp_path):
    """A beacon problem must never stop a worker that is otherwise healthy."""
    app = FakeApp()
    unwritable = tmp_path / "no-such-directory" / "procrastinate-alive"

    procrastinate_pool.install_liveness_beacon(app, str(unwritable))
    result = asyncio.run(app.job_manager.update_heartbeat(1))

    assert result == "updated"
    assert not unwritable.exists()


def test_configure_installs_nothing_outside_a_worker(tmp_path, monkeypatch):
    """Web/API/CronJob processes set no pool size and must get no beacon."""
    beacon = tmp_path / "procrastinate-alive"
    monkeypatch.delenv("PROCRASTINATE_WORKER_POOL_SIZE", raising=False)
    monkeypatch.setenv("PROCRASTINATE_ALIVE_FILE", str(beacon))
    monkeypatch.setenv("PROCRASTINATE_DRAINING_FILE", str(tmp_path / "draining"))
    app = FakeApp()

    procrastinate_pool.configure(app)

    # The wrapper is stored on the INSTANCE; the class's own coroutine being
    # the only thing there means nothing was installed. (`is` against a bound
    # method would always fail: attribute access builds a new one each time.)
    assert "update_heartbeat" not in vars(app.job_manager)
    assert not beacon.exists()


def test_configure_installs_the_beacon_in_a_worker(tmp_path, monkeypatch):
    beacon = tmp_path / "procrastinate-alive"
    monkeypatch.setenv("PROCRASTINATE_WORKER_POOL_SIZE", "2")
    monkeypatch.setenv("PROCRASTINATE_ALIVE_FILE", str(beacon))
    monkeypatch.setenv("PROCRASTINATE_DRAINING_FILE", str(tmp_path / "draining"))
    app = FakeApp()

    procrastinate_pool.configure(app)

    assert isinstance(app.connector, procrastinate_pool.BoundedDjangoConnector)
    assert app.connector.pool_size == 2
    assert app.job_manager.connector is app.connector
    assert getattr(app.job_manager.fetch_job, "_f2z_queue_fetch_gate", False), (
        "worker configuration must install the paused/parked queue fetch gate"
    )
    assert not beacon.exists(), (
        "configure must not pre-create the beacon; only an accepted heartbeat may"
    )

    asyncio.run(app.job_manager.update_heartbeat(1))
    assert beacon.exists()


def test_configure_still_rejects_a_bad_pool_size(monkeypatch):
    monkeypatch.setenv("PROCRASTINATE_WORKER_POOL_SIZE", "0")
    with pytest.raises(ImproperlyConfigured):
        procrastinate_pool.configure(FakeApp())


# --- the drain marker (codex round 5) --------------------------------
#
# procrastinate cancels its heartbeat side task BEFORE it waits
# `--shutdown-graceful-timeout` for the job in flight, so the beacon freezes at
# the first instant of a drain. The kubelet masks that on a rollout by stopping
# liveness for a terminating pod, but procrastinate also stops ITSELF when a
# side task raises -- no deletionTimestamp, liveness still armed -- and killing
# the container there aborts a job that was going to finish. On the exports and
# recordings lanes that job is NEVER reclaimed (dj.apps.jobs.reclaim_policy).
# So `Worker.stop()` announces the drain and only the liveness probe honours it.


def test_the_real_worker_still_has_the_stop_method_we_wrap():
    """The whole mechanism hangs off one upstream method. Pin its existence.

    `install_drain_marker` degrades quietly when it is gone, which is right at
    runtime (a worker must not crashloop over a probe detail) and wrong in CI:
    a procrastinate bump that renamed it would silently give every worker back
    the truncated drain.
    """
    assert callable(getattr(procrastinate_worker.Worker, "stop", None))


def test_stop_creates_the_drain_marker(tmp_path):
    draining = tmp_path / "procrastinate-draining"
    calls = []

    class FakeWorker:
        def stop(self):
            calls.append(draining.exists())

    original_stop = procrastinate_worker.Worker.stop
    procrastinate_worker.Worker.stop = FakeWorker.stop
    try:
        procrastinate_pool.install_drain_marker(str(draining))
        assert not draining.exists(), "installing must not pre-announce a drain"
        procrastinate_worker.Worker.stop(FakeWorker())
    finally:
        procrastinate_worker.Worker.stop = original_stop

    assert draining.exists()
    assert calls == [True], (
        "the marker must be on disk BEFORE the underlying stop() runs; a probe "
        "landing between the two would still kill the container"
    )


def test_the_drain_marker_is_installed_once(tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"

    procrastinate_pool.install_drain_marker(str(first))
    wrapped = procrastinate_worker.Worker.stop
    procrastinate_pool.install_drain_marker(str(second))

    assert procrastinate_worker.Worker.stop is wrapped, (
        "a second install would stack wrappers and, worse, point the marker at "
        "a path the probe does not read"
    )


def test_configure_clears_an_inherited_drain_marker(tmp_path, monkeypatch):
    """/tmp is an emptyDir that OUTLIVES a container restart.

    An inherited marker would suppress liveness for a process that never
    started draining -- the same trap as an inherited beacon, and worse,
    because it disarms the probe rather than passing it once.
    """
    draining = tmp_path / "procrastinate-draining"
    draining.write_text("")
    monkeypatch.setenv("PROCRASTINATE_WORKER_POOL_SIZE", "1")
    monkeypatch.setenv("PROCRASTINATE_ALIVE_FILE", str(tmp_path / "alive"))
    monkeypatch.setenv("PROCRASTINATE_DRAINING_FILE", str(draining))

    procrastinate_pool.configure(FakeApp())

    assert not draining.exists()


def test_a_missing_stop_method_degrades_instead_of_crashing(tmp_path, monkeypatch):
    """A worker must keep consuming even if we cannot install the marker."""
    monkeypatch.delattr(procrastinate_worker.Worker, "stop", raising=True)
    draining = tmp_path / "procrastinate-draining"

    assert procrastinate_pool.install_drain_marker(str(draining)) == str(draining)
    assert not draining.exists()


# --- a heartbeat that HANGS (codex round 8) --------------------------
#
# The drain marker only helps when procrastinate learns the heartbeat failed.
# A heartbeat that never returns -- blackholed connection, blocked UPDATE --
# leaves `stop()` uncalled, no marker on disk, and the beacon going stale under
# a job that is still making progress. Liveness then kills the container on the
# probe's 30s grace, well inside a drain funded for 390s or 2040s.


def test_a_hanging_heartbeat_raises_instead_of_hanging(tmp_path, monkeypatch):
    beacon = tmp_path / "procrastinate-alive"
    monkeypatch.setenv("PROCRASTINATE_HEARTBEAT_TIMEOUT_SECONDS", "0.05")

    class HangingJobManager(FakeJobManager):
        async def update_heartbeat(self, worker_id):
            await asyncio.sleep(3600)

    app = FakeApp()
    app.job_manager = HangingJobManager()
    procrastinate_pool.install_liveness_beacon(app, str(beacon))

    with pytest.raises(TimeoutError):
        asyncio.run(app.job_manager.update_heartbeat(1))

    assert not beacon.exists(), (
        "a heartbeat that never completed must not refresh the beacon"
    )


def test_the_heartbeat_timeout_must_be_positive(monkeypatch):
    monkeypatch.setenv("PROCRASTINATE_HEARTBEAT_TIMEOUT_SECONDS", "0")
    with pytest.raises(ImproperlyConfigured):
        procrastinate_pool.install_liveness_beacon(FakeApp(), "/dev/null")


def test_a_heartbeat_whose_CANCELLATION_stalls_still_times_out(tmp_path, monkeypatch):
    """The deadline must not depend on the driver letting go ( round 9).

    psycopg's `AsyncConnection.wait()` catches CancelledError, issues a
    server-side cancel and waits on the same socket again with no deadline, so
    `asyncio.wait_for` -- which awaits the cancellation it requested -- can be
    held past its own timeout by exactly the blackholed connection it is there
    to bound. This fake reproduces that shape: the cancellation itself takes
    ten times the timeout.
    """
    beacon = tmp_path / "procrastinate-alive"
    monkeypatch.setenv("PROCRASTINATE_HEARTBEAT_TIMEOUT_SECONDS", "0.05")
    cancellation_finished = []

    class StubbornJobManager(FakeJobManager):
        async def update_heartbeat(self, worker_id):
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                await asyncio.sleep(0.5)
                cancellation_finished.append(True)
                raise

    app = FakeApp()
    app.job_manager = StubbornJobManager()
    procrastinate_pool.install_liveness_beacon(app, str(beacon))

    async def main():
        loop = asyncio.get_running_loop()
        started = loop.time()
        with pytest.raises(TimeoutError):
            await app.job_manager.update_heartbeat(1)
        elapsed = loop.time() - started
        # Keep the loop alive long enough for the abandoned task's stalled
        # cancellation to land, so the assertion below can prove it really did
        # outlive the deadline rather than never having been requested.
        await asyncio.sleep(0.8)
        return elapsed

    elapsed = asyncio.run(main())

    assert elapsed < 0.4, (
        f"the heartbeat wrapper took {elapsed:.3f}s to give up on a 0.05s "
        "timeout; it is waiting for the driver's cancellation, which on a "
        "blackholed connection never comes"
    )
    assert not beacon.exists()
    assert cancellation_finished == [True], (
        "expected the abandoned task to have been cancelled (late) -- if it "
        "never was, this test is not exercising the overrun it names"
    )


def test_cancelling_the_wrapper_cancels_the_heartbeat_it_scheduled(tmp_path, monkeypatch):
    """`_shutdown()` cancels the heartbeat side task ( round 10).

    The deadline lives on a task the wrapper schedules, so a cancellation that
    unwinds the wrapper must take that task with it -- otherwise the database
    call outlives its deadline entirely and keeps holding a metadata
    connection which, on a POOL_SIZE=1 lane, is the only one a finishing job
    has to record its completion with.
    """
    beacon = tmp_path / "procrastinate-alive"
    monkeypatch.setenv("PROCRASTINATE_HEARTBEAT_TIMEOUT_SECONDS", "600")
    started = asyncio.Event()

    class SlowJobManager(FakeJobManager):
        async def update_heartbeat(self, worker_id):
            started.set()
            await asyncio.sleep(3600)

    app = FakeApp()
    app.job_manager = SlowJobManager()
    procrastinate_pool.install_liveness_beacon(app, str(beacon))

    async def main():
        outer = asyncio.ensure_future(app.job_manager.update_heartbeat(1))
        await started.wait()
        inner = [
            task for task in asyncio.all_tasks()
            if task is not outer and task is not asyncio.current_task()
        ]
        assert len(inner) == 1, f"expected one scheduled heartbeat, got {inner}"
        outer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await outer
        # Give the loop one turn to deliver the cancellation downwards.
        await asyncio.sleep(0)
        return inner[0].cancelled() or inner[0].cancelling() > 0

    assert asyncio.run(main()), (
        "the scheduled heartbeat survived the wrapper's cancellation; its "
        "deadline is gone and it still holds a pool connection"
    )
    assert not beacon.exists()
