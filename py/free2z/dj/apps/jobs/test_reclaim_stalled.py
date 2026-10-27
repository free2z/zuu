"""
`jobs.reclaim_stalled_jobs` against real Postgres.

Nothing here mocks the queue or the database. Jobs are deferred through
the real `.defer()` path and driven into `doing` by UPDATEing the status
column, which fires procrastinate's own
`procrastinate_trigger_status_events_update_v1` and writes the genuine
`started` event -- the event the age query reads. Hand-inserting events
would make the test agree with the query while both disagreed with
production.

The worker side is real too. `procrastinate_workers` rows are inserted and
`procrastinate_jobs.worker_id` is set exactly the way `fetch_job` sets it,
because the ONE thing that separates "this worker died" from "this task is
slow" is that heartbeat, and a test that skipped it would happily certify
a reclaimer that duplicates in-flight work.

WHY THE TESTS CALL `async_to_sync`
----------------------------------
`JobManager.get_stalled_jobs` and `finish_job` exist only as coroutines,
so the sweep is an async function and the periodic task is an async task.
`async_to_sync` here is a test harness detail. Most tests use Django's test
connector; the production-connector regressions keep the psycopg pool's full
open/sweep/close lifecycle on one event loop and commit each row transaction.

WHAT EACH TEST WOULD MISS IF THE OTHERS WERE DELETED
----------------------------------------------------
* requeue: the whole feature. Without it  is unfixed.
* exactly once per cycle: a second reclaim in the same sweep would double
  every side effect the job has.
* the bound: without it a job that kills its worker becomes an infinite
  loop of workers being killed by it.
* the give-up line, matched with the regex read OUT of the metric JSON:
  the alert is the only reason the bound is safe to have.
* live worker left alone: the reclaimer's own worst failure mode -- it
  runs on the same queue as long tasks and could requeue work that is
  still running.
* young job left alone: the threshold means nothing if it is not applied.
* one bad row: four orphans and one that cannot be moved must leave three
  reclaimed, not zero.
"""
import asyncio
import json
import uuid
from contextvars import ContextVar
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from asgiref.sync import async_to_sync, sync_to_async
from django.db import connection
from django.utils import timezone

from procrastinate.contrib.django import app
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.jobs import lease, ops, reclaim, reclaim_policy
from dj.apps.jobs.models import JobLease, QuarantinedJob
from dj.apps.jobs.tasks import reclaim_stalled_jobs_task
from dj.apps.dyte.tasks import retry_recording_delivery
from dj.apps.exports.tasks import export_publication_task
from dj.apps.g12f.translation.tasks import translate_zpage
from dj.apps.search.tasks import index_zpage
from dj.apps.uploads.tasks import delete_pending_blob, generate_video_poster

_REPO_ROOT = Path(__file__).resolve().parents[5]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _sweep():
    return async_to_sync(reclaim.reclaim_stalled_jobs)()


def _sweep_with_production_pool(*, configure=None):
    """Run a sweep and pool lifecycle on one event loop, as production does."""
    from procrastinate.contrib.django.utils import connector_params
    from procrastinate.psycopg_connector import PsycopgConnector

    async def run():
        connector = PsycopgConnector(
            kwargs=connector_params(), min_size=1, max_size=1)
        await connector.open_async()
        try:
            with app.replace_connector(connector):
                if configure is not None:
                    configure(connector)
                return await reclaim.reclaim_stalled_jobs()
        finally:
            await connector.close_async()

    return async_to_sync(run)()


@pytest.mark.django_db(transaction=True)
def test_production_pool_sweep_does_not_hold_a_django_transaction(monkeypatch):
    """A one-server PgBouncer pool cannot serve a second checked-out client."""
    monkeypatch.setattr(reclaim, '_uses_worker_pool', lambda: True)

    async def observe_pool_path(now=None):
        assert not connection.in_atomic_block
        return {'production_pool_path': True}

    monkeypatch.setattr(reclaim, '_reclaim_stalled_jobs', observe_pool_path)

    assert _sweep() == {'production_pool_path': True}


@pytest.mark.django_db(transaction=True)
def test_production_pool_skips_busy_sweep_lock_without_waiting(
        stalled_settings, settings):
    from django.db import transaction

    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = 0.2
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1695)
    worker_id = _make_worker(now - timedelta(seconds=181))
    started = now - timedelta(seconds=2400)
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=now - timedelta(seconds=181), started_at=started)

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock("
                "hashtext('jobs.reclaim_stalled_jobs'))")
        summary = _sweep_with_production_pool()

    assert summary['reclaimed'] == 0
    assert summary['errors'] == 0
    assert summary['skipped_stale'] == 1
    assert _status(job_id) == 'doing'


def _cleanup_production_pool_jobs(request, *job_ids):
    """Remove only queue rows committed outside Django's test transaction."""
    job_ids = list(job_ids)

    def cleanup():
        if not job_ids:
            return
        # Procrastinate's tables are unmanaged Django models. A production
        # PsycopgConnector commits independently of Django's test transaction,
        # so fixture rollback/flush cannot remove rows created by these tests.
        # Try each owned-table cleanup independently. A failure removing one
        # dependent row must not prevent attempts to remove the remaining
        # quarantine/job rows, and the exception still fails teardown instead
        # of silently leaving an unmanaged row for a reused database run.
        statements = (
            "DELETE FROM jobs_joblease WHERE job_id = ANY(%s)",
            "DELETE FROM jobs_quarantined_job WHERE job_id = ANY(%s)",
            "DELETE FROM procrastinate_jobs WHERE id = ANY(%s)",
        )
        errors = []
        for statement in statements:
            try:
                with connection.cursor() as cursor:
                    cursor.execute(statement, [job_ids])
            except Exception as exc:  # noqa: BLE001 -- continue owned cleanup
                errors.append(exc)
        if errors:
            raise RuntimeError(
                f'failed to clean owned production-pool job ids {job_ids}: '
                + '; '.join(repr(error) for error in errors)
            ) from errors[0]

    request.addfinalizer(cleanup)


@pytest.fixture(autouse=True)
def _cleanup_unmanaged_reclaim_test_jobs(request):
    """Keep this module repeatable despite Procrastinate's unmanaged tables.

    Django's normal flush omits the queue tables. This test-local snapshot
    removes only rows newly created by the current test, including rows a
    production PsycopgConnector committed outside Django's transaction.
    Existing queue rows are never included in the cleanup set.
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
            f'failed to clean this test\'s reclaim job ids {owned}: '
            + '; '.join(repr(error) for error in errors)
        ) from errors[0]


def test_production_pool_cleanup_attempts_every_owned_table_after_error(
    mocker,
):
    finalizers = []
    request = SimpleNamespace(addfinalizer=finalizers.append)
    cursor = mocker.MagicMock()
    cursor.__enter__.return_value = cursor
    cursor.execute.side_effect = [RuntimeError('injected lease cleanup error'),
                                  None, None]
    mocker.patch.object(connection, 'cursor', return_value=cursor)

    _cleanup_production_pool_jobs(request, 41001, 41002)

    with pytest.raises(RuntimeError, match='injected lease cleanup error'):
        finalizers[0]()

    assert [call.args[0] for call in cursor.execute.call_args_list] == [
        'DELETE FROM jobs_joblease WHERE job_id = ANY(%s)',
        'DELETE FROM jobs_quarantined_job WHERE job_id = ANY(%s)',
        'DELETE FROM procrastinate_jobs WHERE id = ANY(%s)',
    ]
    assert all(call.args[1] == [[41001, 41002]]
               for call in cursor.execute.call_args_list)


def _enable_test_hard_deadline(monkeypatch, task_name):
    """Give deadline mechanics a synthetic whole-attempt hard bound."""
    policy = reclaim_policy.policy_for(task_name)
    assert policy is not None and policy.max_runtime_seconds is not None
    monkeypatch.setitem(
        reclaim_policy.TASK_POLICIES, task_name,
        reclaim_policy.TaskPolicy(
            policy.max_runtime_seconds, policy.reason,
            hard_deadline_seconds=policy.max_runtime_seconds))


def test_worker_pool_row_timeout_closes_a_blocked_connection(monkeypatch, settings):
    """A row timeout cuts the socket before returning the connection to pool."""
    import socket
    from types import SimpleNamespace

    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = 0.01
    state = {'cut': False, 'returned': False}
    transaction_unblocked = asyncio.Event()
    client, peer = socket.socketpair()

    class Connection:
        def fileno(self):
            return client.fileno()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info):
            return None

        async def close(self):
            state['closed'] = True
            transaction_unblocked.set()

    class Pool:
        async def _getconn_unchecked(self, timeout=None):
            assert 0 < timeout <= 0.01
            return Connection()

        async def _check_connection(self, conn):
            return None

        async def putconn(self, conn):
            state['returned'] = True

    connector = SimpleNamespace(pool=Pool())
    monkeypatch.setattr(reclaim.app.job_manager, 'connector', connector)
    cut = reclaim._cut_worker_pool_socket

    def record_cut(socket_state):
        state['cut'] = True
        cut(socket_state)

    monkeypatch.setattr(reclaim, '_cut_worker_pool_socket', record_cut)

    async def block_transaction(*args, **kwargs):
        await transaction_unblocked.wait()
        raise OSError('connection closed by row watchdog')

    monkeypatch.setattr(
        reclaim, '_apply_action_worker_pool_transaction', block_transaction)

    async def invoke():
        try:
            with pytest.raises(TimeoutError, match='checkout/row operation exceeded'):
                await reclaim._apply_action_worker_pool(
                    'reclaimed', SimpleNamespace(id=1), lease=None,
                    now=timezone.now(), attempts=0,
                    stale_before=timezone.now())
        finally:
            client.close()
            peer.close()

    async_to_sync(invoke)()

    assert state == {'cut': True, 'returned': True, 'closed': True}


@pytest.mark.parametrize('cancel', [False, True], ids=['timeout', 'cancellation'])
def test_pool_return_revokes_socket_authority(monkeypatch, settings, cancel):
    """A later borrower keeps its socket while the prior return drains."""
    import socket

    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = 0.05
    client, peer = socket.socketpair()
    returned = asyncio.Event()
    completed = []

    class Connection:
        def fileno(self):
            return client.fileno()

        async def close(self):
            pytest.fail('prior borrower closed a returned connection')

    class Pool:
        async def _getconn_unchecked(self, timeout=None):
            return Connection()

        async def _check_connection(self, conn):
            pass

        async def putconn(self, conn):
            # The pool has already made the connection available to a waiter,
            # but this coroutine has asynchronous housekeeping left to do.
            returned.set()
            await asyncio.sleep(0.15)
            peer.sendall(b'new borrower')
            assert client.recv(32) == b'new borrower'
            completed.append(True)

    async def transaction(*args, **kwargs):
        return 'reclaimed'

    monkeypatch.setattr(reclaim.app.job_manager, 'connector',
                        SimpleNamespace(pool=Pool()))
    monkeypatch.setattr(reclaim, '_apply_action_worker_pool_transaction', transaction)

    async def invoke():
        task = asyncio.create_task(reclaim._apply_action_worker_pool(
            'reclaimed', SimpleNamespace(id=1), lease=None,
            now=timezone.now(), attempts=0, stale_before=timezone.now()))
        await returned.wait()
        if cancel:
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else TimeoutError):
            await task

    try:
        async_to_sync(invoke)()
        assert completed == [True]
    finally:
        client.close()
        peer.close()


def test_cancellation_after_pool_return_starts_does_not_cut_reborrowed_socket(
        monkeypatch, settings):
    """The watchdog must stop owning a socket before pool.putconn returns."""
    import socket
    from types import SimpleNamespace

    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = 1
    client, peer = socket.socketpair()
    state = {
        'cut': False, 'putconn_started': False, 'putconn_cancelled': False,
        'returned': False, 'closed': False,
    }
    putconn_started = asyncio.Event()

    class Connection:
        def fileno(self):
            return client.fileno()

        async def close(self):
            state['closed'] = True
            return None

    class Pool:
        async def _getconn_unchecked(self, timeout=None):
            return Connection()

        async def _check_connection(self, conn):
            return None

        async def putconn(self, conn):
            state['putconn_started'] = True
            putconn_started.set()
            try:
                await asyncio.sleep(0.2)
            except asyncio.CancelledError:
                state['putconn_cancelled'] = True
                raise
            finally:
                # Models pool handoff happening before cancellation during
                # the remainder of its async return path.
                state['returned'] = True

    async def finish_transaction(*args, **kwargs):
        return 'reclaimed'

    monkeypatch.setattr(reclaim.app.job_manager, 'connector',
                        SimpleNamespace(pool=Pool()))
    monkeypatch.setattr(
        reclaim, '_apply_action_worker_pool_transaction', finish_transaction)
    original_cut = reclaim._cut_worker_pool_socket

    def record_cut(socket_state):
        with socket_state['lock']:
            state['cut'] = socket_state['active']
        original_cut(socket_state)

    monkeypatch.setattr(reclaim, '_cut_worker_pool_socket', record_cut)

    async def invoke():
        try:
            operation = asyncio.create_task(reclaim._apply_action_worker_pool(
                'reclaimed', SimpleNamespace(id=2), lease=None,
                now=timezone.now(), attempts=0,
                stale_before=timezone.now()))
            await asyncio.wait_for(putconn_started.wait(), timeout=0.5)
            operation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await operation
        finally:
            client.close()
            peer.close()

    async_to_sync(invoke)()

    assert state == {
        'cut': False, 'putconn_started': True, 'putconn_cancelled': False,
        'returned': True, 'closed': False,
    }


def test_socket_dup_failure_still_returns_checked_out_pool_connection(
        monkeypatch, settings):
    from types import SimpleNamespace

    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = 0.1
    state = {'returned': False}

    class Connection:
        def fileno(self):
            return 1

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info):
            return None

    class Pool:
        async def _getconn_unchecked(self, timeout=None):
            return Connection()

        async def _check_connection(self, conn):
            raise AssertionError('socket duplication must fail before health I/O')

        async def putconn(self, conn):
            state['returned'] = True

    monkeypatch.setattr(
        reclaim.app.job_manager, 'connector',
        SimpleNamespace(pool=Pool()))

    def fail_dup(_fd):
        raise OSError('injected descriptor exhaustion')

    monkeypatch.setattr(reclaim.os, 'dup', fail_dup)

    async def invoke():
        with pytest.raises(OSError, match='descriptor exhaustion'):
            await reclaim._apply_action_worker_pool(
                'retry', SimpleNamespace(id=1), lease=None,
                now=timezone.now(), attempts=0,
                stale_before=timezone.now())

    async_to_sync(invoke)()
    assert state['returned'] is True


class _ResponseBlackhole:
    """Forward PostgreSQL TCP and selectively drop server responses."""

    def __init__(self, upstream_port):
        import socket
        import threading

        self.socket = socket
        self.threading = threading
        self.upstream_port = int(upstream_port)
        self.drop = threading.Event()
        self.hold_responses = threading.Event()
        self.response_held = threading.Event()
        self.release_response = threading.Event()
        self.client_eof = threading.Event()
        self.stop = threading.Event()
        self.dropped_bytes = 0
        self.accepted_connections = 0
        self.cancel_requests = 0
        self.stats_lock = threading.Lock()
        self.peers = []
        self.handlers = []
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.port = self.listener.getsockname()[1]
        self.listener.listen()
        self.listener.settimeout(0.1)
        self.thread = threading.Thread(target=self._accept, daemon=True)
        self.thread.start()

    def _accept(self):
        import socket

        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            upstream = socket.create_connection(
                ('127.0.0.1', self.upstream_port))
            with self.stats_lock:
                self.accepted_connections += 1
            self.peers.extend((client, upstream))
            handler = self.threading.Thread(
                target=self._forward, args=(client, upstream), daemon=True)
            self.handlers.append(handler)
            handler.start()

    def _forward(self, client, upstream):
        import select
        import struct

        try:
            while not self.stop.is_set():
                readable, _, _ = select.select(
                    (client, upstream), (), (), 0.1)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        if source is client:
                            self.client_eof.set()
                        return
                    if source is client and data[:8] == struct.pack(
                            '!II', 16, 80877102):
                        with self.stats_lock:
                            self.cancel_requests += 1
                    if source is upstream and self.hold_responses.is_set():
                        self.dropped_bytes += len(data)
                        self.response_held.set()
                        if not self.release_response.wait(2):
                            return
                        if self.stop.is_set():
                            return
                        client.sendall(data)
                    elif source is upstream and self.drop.is_set():
                        self.dropped_bytes += len(data)
                    else:
                        (upstream if source is client else client).sendall(data)
        except OSError:
            pass
        finally:
            client.close()
            upstream.close()

    def close(self):
        self.stop.set()
        self.listener.close()
        for peer in self.peers:
            try:
                peer.shutdown(self.socket.SHUT_RDWR)
            except OSError:
                pass
        self.thread.join(2)
        for handler in self.handlers:
            handler.join(2)
        assert not self.thread.is_alive()
        assert all(not handler.is_alive() for handler in self.handlers)


@pytest.mark.django_db(transaction=True)
def test_pool_checkout_health_blackhole_obeys_row_deadline_and_recovers(
        stalled_settings, settings):
    """A known-ready pooled socket is cut when its health response is lost."""
    import time

    from procrastinate.contrib.django.utils import connector_params
    from procrastinate.psycopg_connector import PsycopgConnector

    proxy = _ResponseBlackhole(connection.settings_dict['PORT'])
    params = connector_params() | {'port': proxy.port}
    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = 0.05

    async def run():
        connector = PsycopgConnector(kwargs=params, min_size=1, max_size=1)
        await connector.open_async()
        try:
            checked_out = []
            getconn = connector.pool._getconn_unchecked

            async def track_checkout(timeout=None):
                conn = await getconn(timeout=timeout)
                checked_out.append(conn)
                return conn

            connector.pool._getconn_unchecked = track_checkout
            putconn = connector.pool.putconn

            async def delayed_putconn(conn):
                # Model psycopg teardown that continues briefly after the
                # socket is cut. The timeout path must drain it before the
                # caller closes the app, and the closed socket must be
                # discarded before reuse.
                await asyncio.sleep(0.2)
                if conn.closed:
                    # Recovery starts once the timed-out socket is closed.
                    # Do not drop a replacement connection's startup response:
                    # pool.putconn can schedule refill before our caller resumes.
                    proxy.drop.clear()
                await putconn(conn)

            connector.pool.putconn = delayed_putconn
            with app.replace_connector(connector):
                # open_async waits for min_size, but explicitly check out and
                # return the socket before blackholing so a startup checkout
                # timeout cannot masquerade as the health-I/O regression.
                async with connector.pool.connection(timeout=3) as conn:
                    cursor = await conn.execute('SELECT 1')
                    assert await cursor.fetchone() == (1,)

                proxy.drop.set()
                started = time.monotonic()
                with pytest.raises(TimeoutError, match='checkout/row operation'):
                    await asyncio.wait_for(reclaim._apply_action_worker_pool(
                        'retry', SimpleNamespace(id=-2471), lease=None,
                        now=timezone.now(), attempts=0,
                        stale_before=timezone.now() - timedelta(seconds=180)),
                        timeout=2)
                elapsed = time.monotonic() - started
                assert 0.04 <= elapsed < 0.5, elapsed
                assert proxy.dropped_bytes > 0
                assert checked_out[-1].closed
                assert await asyncio.to_thread(proxy.client_eof.wait, 1)
                # Cutting the checked-out socket must not open psycopg's
                # separate query-cancel connection, the path that escaped the
                # row deadline in the hosted run.
                assert proxy.cancel_requests == 0
                assert not [
                    task for task in asyncio.all_tasks()
                    if task.get_name() == 'job-reclaim-row:-2471'
                ]
                proxy.drop.clear()
                async with connector.pool.connection(timeout=3) as conn:
                    cursor = await conn.execute('SELECT 1')
                    assert await cursor.fetchone() == (1,)
        finally:
            await connector.close_async()

    try:
        asyncio.run(run())
    finally:
        proxy.close()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('release_after_deadline', [False, True])
def test_pool_health_response_and_watchdog_race_have_deterministic_winner(
        stalled_settings, settings, release_after_deadline):
    """A real health response before the deadline wins; a late one is cut."""
    import time

    from procrastinate.contrib.django.utils import connector_params
    from procrastinate.psycopg_connector import PsycopgConnector

    proxy = _ResponseBlackhole(connection.settings_dict['PORT'])
    params = connector_params() | {'port': proxy.port}
    row_timeout = 0.2
    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = row_timeout

    async def run():
        connector = PsycopgConnector(kwargs=params, min_size=1, max_size=1)
        await connector.open_async()
        try:
            async with connector.pool.connection(timeout=3) as conn:
                cursor = await conn.execute('SELECT 1')
                assert await cursor.fetchone() == (1,)

            proxy.hold_responses.set()
            with app.replace_connector(connector):
                operation = asyncio.create_task(
                    reclaim._apply_action_worker_pool(
                        'retry', SimpleNamespace(id=-2472), lease=None,
                        now=timezone.now(), attempts=0,
                        stale_before=timezone.now() - timedelta(seconds=180)))
                assert await asyncio.to_thread(proxy.response_held.wait, 1)
                started = time.monotonic()

                async def event_loop_pressure():
                    # Exercise callback ordering while a real socket response
                    # is held, without blocking the watchdog's event loop.
                    for _ in range(100):
                        sum(range(10_000))
                        await asyncio.sleep(0)

                pressure = asyncio.create_task(event_loop_pressure())
                if release_after_deadline:
                    await asyncio.sleep(row_timeout + 0.03)
                    proxy.release_response.set()
                    with pytest.raises(
                            TimeoutError, match='checkout/row operation'):
                        await asyncio.wait_for(operation, timeout=1)
                    assert time.monotonic() - started < 0.5
                else:
                    await asyncio.sleep(row_timeout / 4)
                    proxy.release_response.set()
                    assert await asyncio.wait_for(operation, timeout=1) == (
                        'attempt_changed')
                await pressure

            assert proxy.dropped_bytes > 0
            assert not [
                task for task in asyncio.all_tasks()
                if task.get_name() == 'job-reclaim-row:-2472'
            ]
            # A new checkout proves the health connection was returned or
            # discarded and the pool can replace it after either race winner.
            async with connector.pool.connection(timeout=3) as conn:
                cursor = await conn.execute('SELECT 1')
                assert await cursor.fetchone() == (1,)
        finally:
            await connector.close_async()

    try:
        asyncio.run(run())
    finally:
        proxy.close()


@pytest.mark.django_db(transaction=True)
def test_pool_waiting_checkout_obeys_row_deadline_and_recovers(
        stalled_settings, settings):
    """A saturated real pool cannot hide checkout time beyond the row budget."""
    import time

    from procrastinate.contrib.django.utils import connector_params
    from procrastinate.psycopg_connector import PsycopgConnector

    settings.JOB_RECLAIM_ROW_TIMEOUT_SECONDS = 0.05

    async def run():
        connector = PsycopgConnector(
            kwargs=connector_params(), min_size=1, max_size=1)
        await connector.open_async()
        try:
            with app.replace_connector(connector):
                async with connector.pool.connection(timeout=3) as held:
                    cursor = await held.execute('SELECT 1')
                    assert await cursor.fetchone() == (1,)
                    started = time.monotonic()
                    with pytest.raises(
                            TimeoutError, match='checkout/row operation'):
                        await asyncio.wait_for(
                            reclaim._apply_action_worker_pool(
                                'retry', SimpleNamespace(id=-2472),
                                lease=None, now=timezone.now(), attempts=0,
                                stale_before=timezone.now() - timedelta(
                                    seconds=180)),
                            timeout=2)
                    elapsed = time.monotonic() - started
                    assert 0.04 <= elapsed < 0.5, elapsed

                async with connector.pool.connection(timeout=3) as conn:
                    cursor = await conn.execute('SELECT 1')
                    assert await cursor.fetchone() == (1,)
        finally:
            await connector.close_async()

    asyncio.run(run())


def test_pool_socket_cut_does_not_require_another_file_descriptor(monkeypatch):
    """The watchdog can shut down the socket under descriptor exhaustion."""
    import socket
    import threading

    left, right = socket.socketpair()
    right.settimeout(0.2)
    state = {'socket_fd': left.fileno(), 'lock': threading.Lock(),
             'active': True}

    def descriptor_exhaustion(_fd):
        raise OSError('injected descriptor exhaustion during watchdog cut')

    monkeypatch.setattr(reclaim.os, 'dup', descriptor_exhaustion)
    try:
        reclaim._cut_worker_pool_socket(state)
        assert right.recv(1) == b''
        assert left.fileno() >= 0
    finally:
        left.close()
        right.close()


def _mark_doing(job_id, started_at, worker_id=None, attempts=0):
    """
    Put a job in the state a worker leaves behind, using the same columns
    `fetch_job` writes: status, worker_id, and (via the trigger) a
    `started` event which is then backdated.
    """
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET status='doing', worker_id=%s, "
            "attempts=%s WHERE id=%s", [worker_id, attempts, job_id])
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='started'", [started_at, job_id])
        assert cur.rowcount == 1, (
            "procrastinate did not emit a 'started' event on the "
            "todo->doing transition; the age query's event names are out "
            "of date")


def _make_worker(last_heartbeat):
    with connection.cursor() as cur:
        cur.execute(
            "INSERT INTO procrastinate_workers (last_heartbeat) "
            "VALUES (%s) RETURNING id", [last_heartbeat])
        return cur.fetchone()[0]


def _status(job_id):
    return ProcrastinateJob.objects.get(pk=job_id).status


def _attempts(job_id):
    return ProcrastinateJob.objects.get(pk=job_id).attempts


def _lease(job_id, task_name, queue, *, last_beat_at, deadline_at=None,
           started_at=None):
    started_at = started_at or last_beat_at
    return JobLease.objects.create(
        job_id=job_id, token=uuid.uuid4(), task_name=task_name, queue=queue,
        started_at=started_at, last_beat_at=last_beat_at,
        deadline_at=deadline_at, attempt=0)


async def _requeue_and_restart(job_id):
    """
    What a CONCURRENT sweep plus a worker do to a row: requeue it (the
    procrastinate procedure that bumps `attempts`) and fetch it again, so
    its `started` event is now seconds old instead of 900.
    """
    await app.job_manager.retry_job_by_id_async(
        job_id=job_id, retry_at=timezone.now())

    def _fetch():
        with connection.cursor() as cur:
            cur.execute(
                "UPDATE procrastinate_jobs SET status='doing' WHERE id=%s",
                [job_id])

    await sync_to_async(_fetch)()


def _json_lines(caplog):
    out = []
    for rec in caplog.records:
        if rec.name != 'dj.apps.jobs.reclaim':
            continue
        try:
            out.append(json.loads(rec.getMessage()))
        except ValueError:
            continue
    return out




@pytest.fixture
def stalled_settings(settings):
    """The production defaults, restated so a settings change is visible."""
    settings.JOB_HEALTH_STUCK_DOING_SECONDS = 3600
    settings.JOB_HEALTH_STUCK_ORPHANED_SECONDS = 600
    settings.JOB_RECLAIM_MIN_AGE_SECONDS = 120
    settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS = 300
    settings.JOB_RECLAIM_MAX_RECLAIMS = 3
    settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS = 60
    settings.JOB_LEASE_STALE_SECONDS = 60
    settings.JOB_RECLAIM_EXCLUDED_QUEUES = ('exports',)
    settings.JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES = ()
    settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS = 240
    return settings


# ---------------------------------------------------------------------------
# the threshold ordering
# ---------------------------------------------------------------------------

def test_reclaim_minimum_age_is_independent_of_task_runtime(settings):
    settings.JOB_RECLAIM_MIN_AGE_SECONDS = 120
    settings.JOB_HEALTH_STUCK_ORPHANED_SECONDS = 600
    assert reclaim.reclaim_threshold_seconds() == 120


def test_reclaim_minimum_age_does_not_clamp_to_orphan_alert(settings):
    settings.JOB_HEALTH_STUCK_ORPHANED_SECONDS = 600
    settings.JOB_RECLAIM_MIN_AGE_SECONDS = 120
    assert reclaim.reclaim_threshold_seconds() == 120


# ---------------------------------------------------------------------------
# reclaiming
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_stalled_job_with_a_dead_worker_is_requeued(stalled_settings):
    """ itself: the OOMKilled poster job gets another chance."""
    job_id = generate_video_poster.defer(generic_file_id=1)
    dead = _make_worker(timezone.now() - timedelta(seconds=1800))
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400),
                worker_id=dead)

    summary = _sweep()

    assert summary['reclaimed_ids'] == [job_id]
    assert summary['gave_up'] == 0
    assert summary['errors'] == 0
    assert _status(job_id) == 'todo'
    # procrastinate's own counter moved -- that IS the bound's bookkeeping.
    assert _attempts(job_id) == 1


@pytest.mark.django_db
def test_stale_ordinary_lease_on_live_worker_waits_even_past_task_budget(
        stalled_settings):
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1689)
    started = now - timedelta(seconds=181)
    live_worker = _make_worker(now)
    _mark_doing(job_id, started, worker_id=live_worker)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=now - timedelta(seconds=181),
           started_at=started)

    started = now - timedelta(seconds=2200)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='started'", [started, job_id])
    JobLease.objects.filter(job_id=job_id).update(started_at=started)

    summary = _sweep()

    assert summary['reclaimed_ids'] == []
    assert _attempts(job_id) == 0
    assert _status(job_id) == 'doing'
    assert JobLease.objects.filter(job_id=job_id).exists()


@pytest.mark.parametrize('production_pool', [False, True],
                         ids=['django-connector', 'production-pool'])
@pytest.mark.django_db(transaction=True)
def test_unleased_worker_revival_before_transition_is_skipped(
        stalled_settings, monkeypatch, production_pool):
    """Both connectors recheck heartbeat under the transition lock."""
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1694)
    worker_id = _make_worker(now - timedelta(seconds=181))
    _mark_doing(job_id, now - timedelta(seconds=2400), worker_id=worker_id)
    real_apply = reclaim._apply_row_action

    async def revive_then_apply(action, job, **kwargs):
        def revive():
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE procrastinate_workers SET last_heartbeat=%s "
                    "WHERE id=%s", [timezone.now(), worker_id])
        await sync_to_async(revive)()
        return await real_apply(action, job, **kwargs)

    monkeypatch.setattr(reclaim, '_apply_row_action', revive_then_apply)

    summary = (_sweep_with_production_pool() if production_pool
               else asyncio.run(reclaim.reclaim_stalled_jobs()))

    assert summary['reclaimed'] == 0
    assert summary['skipped_stale'] == 1
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0


@pytest.mark.django_db
def test_fresh_lease_with_pruned_worker_is_not_reclaimed(stalled_settings):
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1690)
    _mark_doing(job_id, now - timedelta(seconds=2400), worker_id=None)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=now - timedelta(seconds=5),
           started_at=now - timedelta(seconds=2400))

    summary = _sweep()

    assert summary['reclaimed'] == 0
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0


@pytest.mark.django_db
def test_deadline_abort_is_persisted_then_failed_on_next_sweep(
    stalled_settings, mocker, caplog, monkeypatch,
):
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1691)
    worker = _make_worker(now - timedelta(seconds=5))
    started = now - timedelta(seconds=2400)
    _mark_doing(job_id, started, worker_id=worker)
    _enable_test_hard_deadline(monkeypatch, 'uploads.generate_video_poster')
    _lease(
        job_id, 'uploads.generate_video_poster', 'images',
        last_beat_at=now - timedelta(seconds=5),
        deadline_at=now - timedelta(seconds=1), started_at=started)
    cancel = mocker.patch.object(app.job_manager, 'cancel_job_by_id')

    first = _sweep()

    assert first['gave_up'] == 0
    assert _status(job_id) == 'doing'
    cancel.assert_called_once_with(job_id, abort=True)
    pending = QuarantinedJob.objects.get(job_id=job_id)
    assert pending.reason.startswith(reclaim.DEADLINE_ABORT_REQUESTED + ':')
    assert pending.attempts == 0

    second = _sweep()

    assert second['gave_up_ids'] == [job_id]
    assert _status(job_id) == 'failed'
    assert JobLease.objects.filter(job_id=job_id).count() == 0
    assert cancel.call_count == 1
    assert QuarantinedJob.objects.get(job_id=job_id).reason == (
        'deadline exceeded after abort request')
    lines = [line['message'] for line in _json_lines(caplog)]
    assert any(reclaim.RECLAIM_GIVE_UP_SIGNAL in line for line in lines)


@pytest.mark.parametrize('production_pool', [False, True],
                         ids=['django-connector', 'production-pool'])
@pytest.mark.django_db(transaction=True)
def test_lease_revival_after_listing_wins_the_compare_and_delete(
    stalled_settings, monkeypatch, caplog, production_pool,
):
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1692)
    started = now - timedelta(seconds=2400)
    _mark_doing(job_id, started)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=started, started_at=started)
    real_apply = reclaim._apply_row_action

    async def revive_then_apply(action, candidate, **kwargs):
        await sync_to_async(lambda: JobLease.objects.filter(
            job_id=candidate.id).update(last_beat_at=timezone.now()))()
        return await real_apply(action, candidate, **kwargs)

    monkeypatch.setattr(reclaim, '_apply_row_action', revive_then_apply)
    summary = (_sweep_with_production_pool() if production_pool else _sweep())

    assert summary['reclaimed'] == 0
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0
    skipped = [line for line in _json_lines(caplog)
               if line.get('reason') == 'lease_revived']
    assert len(skipped) == 1


@pytest.mark.django_db
def test_expired_deadline_with_live_worker_and_stale_lease_is_not_requeued(
    stalled_settings,
):
    """An estimated deadline cannot bypass the task runtime guard."""
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1693)
    started = now - timedelta(seconds=1200)
    worker_id = _make_worker(now)
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(
        job_id, 'uploads.generate_video_poster', 'images',
        last_beat_at=now - timedelta(seconds=181),
        deadline_at=now - timedelta(seconds=1), started_at=started)

    summary = _sweep()

    assert summary['reclaimed'] == 0
    assert summary['gave_up'] == 0
    assert summary['skipped_stale'] == 1
    assert _status(job_id) == 'doing'
    assert JobLease.objects.filter(job_id=job_id).exists()


@pytest.mark.django_db
def test_estimated_media_runtime_does_not_abort_a_live_worker(
    stalled_settings, mocker,
):
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=1694)
    started = now - timedelta(seconds=2400)
    worker_id = _make_worker(now - timedelta(seconds=5))
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(
        job_id, 'uploads.generate_video_poster', 'images',
        last_beat_at=now - timedelta(seconds=5),
        deadline_at=now - timedelta(seconds=1), started_at=started)
    cancel = mocker.patch.object(app.job_manager, 'cancel_job_by_id')

    summary = _sweep()

    assert summary['reclaimed'] == 0
    assert summary['gave_up'] == 0
    assert summary['skipped_fresh_lease'] == 1
    assert _status(job_id) == 'doing'
    assert JobLease.objects.filter(job_id=job_id).exists()
    assert not QuarantinedJob.objects.filter(job_id=job_id).exists()
    cancel.assert_not_called()


@pytest.mark.django_db(transaction=True)
def test_inspection_matches_sweep_and_respects_a_fresh_lease(stalled_settings):
    eligible_id = generate_video_poster.defer(generic_file_id=9001)
    _mark_doing(eligible_id, timezone.now() - timedelta(seconds=2400))
    inspected = ops.inspect_job(eligible_id)
    assert inspected['reclaimer']['reason'] == 'eligible'
    result = _sweep()
    assert eligible_id in result['reclaimed_ids']

    fenced_id = generate_video_poster.defer(generic_file_id=9002)
    started = timezone.now() - timedelta(seconds=2400)
    _mark_doing(fenced_id, started)
    JobLease.objects.create(
        job_id=fenced_id, token=uuid.uuid4(), task_name='uploads.generate_video_poster',
        queue='images', started_at=started, last_beat_at=timezone.now(),
        deadline_at=None, attempt=0)
    inspected = ops.inspect_job(fenced_id)
    assert inspected['reclaimer']['reason'] == 'fresh_lease'
    result = _sweep()
    assert _status(fenced_id) == 'doing'


@pytest.mark.django_db
def test_a_job_whose_worker_row_was_pruned_is_requeued(stalled_settings):
    """
    The commonest production shape. A worker prunes stalled peers at
    startup and the `worker_id` FK is ON DELETE SET NULL, so by the time
    anyone looks, an OOMKilled worker's jobs have `worker_id IS NULL`.
    """
    job_id = generate_video_poster.defer(generic_file_id=2)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400),
                worker_id=None)

    assert _sweep()['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'


@pytest.mark.django_db
@pytest.mark.parametrize('worker_shape', ['missing', 'stale'])
@pytest.mark.parametrize('lease_shape', ['missing', 'stale'])
def test_ordinary_orphan_waits_out_provider_budget(
    stalled_settings, worker_shape, lease_shape,
):
    """Missing or correlated stale signals do not prove a paid call ended."""
    job_id = translate_zpage.defer(job_id='legacy-provider-call')
    worker_id = (_make_worker(timezone.now() - timedelta(seconds=61))
                 if worker_shape == 'stale' else None)
    started = timezone.now() - timedelta(seconds=1000)
    _mark_doing(job_id, started, worker_id=worker_id)
    if lease_shape == 'stale':
        _lease(job_id, 'g12f.translate_zpage', 'translation',
               last_beat_at=timezone.now() - timedelta(seconds=181),
               started_at=started)

    first = _sweep()

    assert job_id not in first['reclaimed_ids']
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0

    # The declared runtime plus margin is the bounded fallback for precisely
    # this ambiguous legacy shape; with a lease, the lease heartbeat itself is
    # the signal and the same runtime guard still applies.
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='started'",
            [timezone.now() - timedelta(seconds=1300), job_id])
    second = _sweep()

    assert second['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'


@pytest.mark.django_db
def test_a_reclaimed_job_is_not_reclaimed_again_in_the_next_cycle(
    stalled_settings,
):
    """
    Exactly once per cycle. A second requeue of the same row is a second
    run of whatever side effects the task has.
    """
    job_id = generate_video_poster.defer(generic_file_id=3)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    assert _sweep()['reclaimed'] == 1
    second = _sweep()

    assert second['candidates'] == 0
    assert second['reclaimed'] == 0
    assert _attempts(job_id) == 1


@pytest.mark.django_db
def test_four_stranded_jobs_are_all_reclaimed_in_one_sweep(stalled_settings):
    """The literal  population: four rows, one sweep, four requeues."""
    job_ids = [
        generate_video_poster.defer(generic_file_id=i) for i in range(4)]
    for job_id in job_ids:
        _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    summary = _sweep()

    assert summary['reclaimed_ids'] == sorted(job_ids)
    assert all(_status(job_id) == 'todo' for job_id in job_ids)


# ---------------------------------------------------------------------------
# what must be LEFT ALONE
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_job_whose_worker_is_alive_is_left_alone(stalled_settings):
    """
    The reclaimer's worst failure mode. A long task on a live worker must
    never be requeued -- that duplicates a half-finished side effect, and
    the duplicate runs while the original is still going.

    Age alone would fail this test, which is the reason the heartbeat half
    of the condition exists.
    """
    job_id = generate_video_poster.defer(generic_file_id=5)
    alive = _make_worker(timezone.now() - timedelta(seconds=5))
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400),
                worker_id=alive)

    summary = _sweep()

    assert summary['candidates'] == 0
    assert summary['stalled_by_age'] == 1  # it IS old...
    assert summary['orphaned_by_heartbeat'] == 0  #...but its worker is up
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0


@pytest.mark.django_db
def test_a_recently_started_job_is_left_alone(stalled_settings):
    """
    The threshold has to be applied. Heartbeat alone would fail this:
    `worker_id IS NULL` counts as stalled at any age, so every job would
    be reclaimed the instant a worker restarted.
    """
    job_id = generate_video_poster.defer(generic_file_id=6)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=60))

    summary = _sweep()

    assert summary['candidates'] == 0
    assert summary['stalled_by_age'] == 0
    assert summary['orphaned_by_heartbeat'] == 1
    assert _status(job_id) == 'doing'


@pytest.mark.django_db
def test_a_todo_job_is_never_touched(stalled_settings):
    """Backlog is not stall. Only `doing` rows are in scope."""
    job_id = index_zpage.defer(zpage_id=1)
    summary = _sweep()
    assert summary['candidates'] == 0
    assert _status(job_id) == 'todo'


@pytest.mark.django_db
def test_the_sweep_never_reclaims_its_own_rows(stalled_settings, caplog):
    """
    Requeueing itself would be an unbounded self-restart, and its
    `queueing_lock` makes the move impossible the moment a later tick has
    queued a fresh copy. A stalled reclaimer is what `job_stuck` is for.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = reclaim_stalled_jobs_task.defer(timestamp=0)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    summary = _sweep()

    assert summary['candidates'] == 1
    assert summary['skipped_self'] == 1
    assert summary['reclaimed'] == 0
    assert summary['errors'] == 0
    assert _status(job_id) == 'doing'


# ---------------------------------------------------------------------------
# the bound, and the line that pages
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_job_past_the_bound_is_failed_not_requeued(stalled_settings,
                                                     caplog):
    """
    Three RECLAIMS, not three attempts. `generate_video_poster` carries
    VARIANT_RETRY has an 8-retry infrastructure branch, so its own retry
    strategy owns the first eight; the bound fires at 3 + 8 = 11.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = generate_video_poster.defer(generic_file_id=7)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400), attempts=11)

    summary = _sweep()

    assert summary['gave_up_ids'] == [job_id]
    assert summary['reclaimed'] == 0
    assert _status(job_id) == 'failed'

    payloads = _json_lines(caplog)
    gave_up = [p for p in payloads
               if p.get('event') == reclaim.GAVE_UP_EVENT]
    assert len(gave_up) == 1
    assert gave_up[0]['severity'] == 'ERROR'
    assert gave_up[0]['job_id'] == job_id
    assert gave_up[0]['task'] == 'uploads.generate_video_poster'
    assert gave_up[0]['attempts'] == 11
    assert gave_up[0]['reclaims'] == 3
    assert gave_up[0]['retry_allowance'] == 8
    quarantine = QuarantinedJob.objects.get(job_id=job_id)
    assert quarantine.task_name == 'uploads.generate_video_poster'
    assert quarantine.requeued_at is None


@pytest.mark.django_db(transaction=True)
def test_quarantine_record_and_terminal_transition_share_the_transaction(
        stalled_settings, monkeypatch):
    """The Django-connector path also keeps quarantine and status together."""
    job_id = generate_video_poster.defer(generic_file_id=11)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400), attempts=11)
    original = app.job_manager.finish_job
    seen = []

    async def spy(job, **kwargs):
        seen.append(await sync_to_async(lambda: (
            connection.in_atomic_block,
            QuarantinedJob.objects.filter(job_id=job.id).exists()))())
        return await original(job, **kwargs)

    monkeypatch.setattr(app.job_manager, 'finish_job', spy)
    summary = _sweep()
    assert summary['gave_up_ids'] == [job_id]
    assert seen == [(True, True)]






@pytest.mark.django_db
def test_raising_the_bound_keeps_requeueing_the_same_job(stalled_settings):
    """The bound is a bound, not a coincidence of the job's history."""
    stalled_settings.JOB_RECLAIM_MAX_RECLAIMS = 10
    job_id = generate_video_poster.defer(generic_file_id=10)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400), attempts=11)

    assert _sweep()['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'


# ---------------------------------------------------------------------------
# containment
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_one_unmovable_row_does_not_strand_the_others(stalled_settings,
                                                      caplog, mocker):
    """
    A `queueing_lock` shared with a copy a later tick already put in
    `todo` makes procrastinate's partial unique index refuse the
    doing->todo move. That row stays stuck (and keeps `job_stuck` lit,
    which is correct -- a human picks the winner). The other three
    orphans must still be rescued.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_ids = [
        generate_video_poster.defer(generic_file_id=100 + i)
        for i in range(4)
    ]
    for job_id in job_ids:
        _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))
    doomed = min(job_ids)

    real_retry = app.job_manager.retry_job

    async def flaky(job, **kwargs):
        if job.id == doomed:
            raise RuntimeError('duplicate key value violates unique '
                               'constraint "procrastinate_jobs_'
                               'queueing_lock_idx_v1"')
        return await real_retry(job, **kwargs)

    mocker.patch.object(app.job_manager, 'retry_job', side_effect=flaky)

    summary = _sweep()

    assert summary['errors'] == 1
    assert summary['reclaimed_ids'] == sorted(set(job_ids) - {doomed})
    assert _status(doomed) == 'doing'
    errors = [p for p in _json_lines(caplog)
              if p.get('event') == reclaim.ERROR_EVENT]
    assert len(errors) == 1
    assert errors[0]['job_id'] == doomed
    assert errors[0]['error'] == 'RuntimeError'


# ---------------------------------------------------------------------------
# registration and the monitoring contract
# ---------------------------------------------------------------------------

def test_the_task_is_registered_periodic_and_locked():
    task = app.tasks[reclaim.RECLAIM_TASK_NAME]
    assert task.queue == 'default'
    # One sweep at a time: a second copy queued behind a slow one would
    # look at the same orphans.
    assert task.queueing_lock == 'jobs-reclaim-stalled-jobs'
    periodic = [
        entry for entry in app.periodic_registry.periodic_tasks.values()
        if entry.task.name == reclaim.RECLAIM_TASK_NAME
    ]
    assert len(periodic) == 1, (
        'jobs.reclaim_stalled_jobs is not registered as a periodic task, so '
        'nothing would ever run it')
    # Every 5 minutes: a stall is found within 5 minutes of crossing the
    # 900s threshold and ~20 minutes before `job_stuck` could page.
    assert periodic[0].cron == '* * * * *'




@pytest.mark.django_db
def test_the_periodic_task_wrapper_runs_the_sweep(stalled_settings):
    """
    The wrapper is what production actually calls. A sweep function that
    works while nothing invokes it is the  defect wearing a hat.
    """
    job_id = generate_video_poster.defer(generic_file_id=11)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    summary = async_to_sync(reclaim_stalled_jobs_task.func)(timestamp=0)

    assert summary['reclaimed_ids'] == [job_id]






# ---------------------------------------------------------------------------
# the exclusion list -- found by the codex adversarial review on this PR
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_stalled_export_is_never_requeued(stalled_settings, caplog):
    """
    An ordinary stalled export without pre-body proof stays untouched.

    `exports.export_publication` is `retry=False` and takes its own claim
    (PublicationExportJob -> RUNNING) before it starts. The requeued copy
    sees "not QUEUED" and returns, so procrastinate records SUCCEEDED: the
    `doing` row disappears, `job_stuck` goes quiet, the give-up alert never
    fires, and the creator waits on the abandonment sweep with nobody
    watching. An export also legitimately runs for half an hour, well past
    the 900s threshold, so its age proves nothing in the first place.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = export_publication_task.defer(job_id='an-export')
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    summary = _sweep()

    assert summary['candidates'] == 1  # it IS seen...
    assert summary['skipped_excluded'] == 1  #...and deliberately not touched
    assert summary['reclaimed'] == 0
    assert summary['gave_up'] == 0
    assert _status(job_id) == 'doing'
    skipped = [p for p in _json_lines(caplog)
               if p.get('event') == reclaim.SKIPPED_EVENT]
    assert len(skipped) == 1
    assert skipped[0]['reason'] == 'excluded_queue'
    assert skipped[0]['queue'] == 'exports'


@pytest.mark.django_db
def test_an_excluded_export_is_not_failed_by_the_bound_either(
    stalled_settings,
):
    """Exclusion is total. Marking it `failed` would erase the row too."""
    job_id = export_publication_task.defer(job_id='another-export')
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400), attempts=9)

    assert _sweep()['gave_up'] == 0
    assert _status(job_id) == 'doing'


@pytest.mark.django_db
def test_emptying_the_queue_exclusion_does_not_re_enable_the_export(
    stalled_settings, caplog,
):
    """
    DEFENCE IN DEPTH, and the difference between the two mechanisms.

    `JOB_RECLAIM_EXCLUDED_QUEUES` is the operator escape hatch -- an env
    var, no deploy. It is NOT what keeps `export_publication` safe: the
    per-task registry is, and emptying the queue list must not make an
    ordinary/ambiguous NEVER attempt reclaimable. Only a matching durable
    `before_body` marker proves an export never reached its own claim.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    stalled_settings.JOB_RECLAIM_EXCLUDED_QUEUES = ()
    job_id = export_publication_task.defer(job_id='a-third-export')
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    summary = _sweep()

    assert summary['reclaimed'] == 0
    assert summary['skipped_excluded'] == 0  # the queue list is empty...
    assert summary['skipped_never_ids'] == [job_id]  #...the registry is not
    assert _status(job_id) == 'doing'
    skipped = [p for p in _json_lines(caplog)
               if p.get('event') == reclaim.SKIPPED_EVENT]
    assert skipped[0]['reason'] == 'never_reclaimed'


@pytest.mark.django_db
def test_only_a_matching_prebody_export_marker_bypasses_default_exclusion(
    stalled_settings,
):
    """A proved-unstarted export is safe to retry through the default lane guard."""
    job_id = export_publication_task.defer(job_id='prebody-export')
    started = timezone.now() - timedelta(seconds=2400)
    _mark_doing(job_id, started)
    held = _lease(
        job_id, 'exports.export_publication', 'exports',
        last_beat_at=started, started_at=started)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name='exports.export_publication', queue='exports',
        reason=f'recovery abandoned attempt before_body:{held.token}',
        attempts=0)

    result = _sweep()

    assert result['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'
    assert _attempts(job_id) == 1


@pytest.mark.django_db
def test_explicit_export_exclusion_and_manual_pause_override_prebody_marker(
    stalled_settings,
):
    """An operator exclusion and a paused queue stay stronger than the marker."""
    stalled_settings.JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES = ('exports',)
    explicit_id = export_publication_task.defer(job_id='operator-paused-export')
    started = timezone.now() - timedelta(seconds=2400)
    _mark_doing(explicit_id, started)
    held = _lease(
        explicit_id, 'exports.export_publication', 'exports',
        last_beat_at=started, started_at=started)
    QuarantinedJob.objects.create(
        job_id=explicit_id, task_name='exports.export_publication',
        queue='exports',
        reason=f'recovery abandoned attempt before_body:{held.token}',
        attempts=0)

    result = _sweep()

    assert result['reclaimed_ids'] == []
    assert result['skipped_excluded'] == 1
    assert _status(explicit_id) == 'doing'
    assert _attempts(explicit_id) == 0
    assert reclaim._is_queue_excluded('paused.exports', 'before_body')


@pytest.mark.django_db
def test_started_export_body_is_never_replayed_even_with_matching_marker(
    stalled_settings,
):
    job_id = export_publication_task.defer(job_id='started-export')
    started = timezone.now() - timedelta(seconds=2400)
    _mark_doing(job_id, started)
    held = _lease(
        job_id, 'exports.export_publication', 'exports',
        last_beat_at=started, started_at=started)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name='exports.export_publication', queue='exports',
        reason=f'recovery abandoned attempt after_body:{held.token}',
        attempts=0)

    result = _sweep()

    assert result['reclaimed_ids'] == []
    assert result['skipped_excluded'] == 1
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0


def test_the_excluded_queue_is_the_one_the_export_task_runs_on():
    """
    Pin the exclusion to the task registry, not to a string. Moving
    `export_publication` to another queue would otherwise leave the
    exclusion guarding an empty lane while the export became reclaimable
    again, with nothing red anywhere.
    """
    from django.conf import settings as dj_settings
    task = app.tasks['exports.export_publication']
    assert task.queue in reclaim.excluded_queues(), (
        f'exports.export_publication runs on queue {task.queue!r}, which '
        f'JOB_RECLAIM_EXCLUDED_QUEUES ({dj_settings.JOB_RECLAIM_EXCLUDED_QUEUES}) '
        'does not cover -- a reclaimed export is silently recorded as '
        'SUCCEEDED and stops alerting.')
    #...and the task really is the one that declines automatic re-running.
    assert task.retry_strategy is None


# ---------------------------------------------------------------------------
# the sweep's own runtime bound -- the serialisation the queueing_lock is not
# ---------------------------------------------------------------------------

def test_the_sweep_timeout_is_shorter_than_the_tick_period():
    """
    The timeout bounds how STALE one sweep's view can get. It is not a
    proof that two sweeps never overlap -- a periodic job deferred at tick
    T need not START at T, it waits in `todo` behind whatever the worker
    is draining, so two sweeps can be in flight at once even with
    240s < 300s. That is why every candidate is re-listed before it is
    written to. Keep the inequality anyway: it makes a backlog the only
    way to overlap, rather than a slow sweep being enough on its own.
    """
    from django.conf import settings as dj_settings
    cron = dj_settings.JOB_RECLAIM_SWEEP_CRON
    assert cron == '* * * * *'
    assert dj_settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS < 60 * 5


@pytest.mark.django_db
def test_a_sweep_that_overruns_its_budget_stops_and_says_so(
    stalled_settings, caplog, mocker,
):
    """
    A sweep that runs past its budget must NOT go on to act: its view of
    the queue is stale, and acting on it is how a live job gets requeued
    underneath a running worker. It raises, so the job lands in `failed`
    where report_job_health can see it -- silence would be the same defect
    this module exists to remove.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    stalled_settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS = 0.05
    job_id = generate_video_poster.defer(generic_file_id=200)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    async def slow(*args, **kwargs):
        import asyncio
        await asyncio.sleep(5)

    mocker.patch.object(reclaim, '_stalled_candidates', side_effect=slow)

    import asyncio as _asyncio
    with pytest.raises(_asyncio.TimeoutError):
        _sweep()

    assert _status(job_id) == 'doing'  # nothing was acted on
    timed_out = [p for p in _json_lines(caplog)
                 if p.get('event') == reclaim.TIMED_OUT_EVENT]
    assert len(timed_out) == 1
    assert timed_out[0]['severity'] == 'ERROR'


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('production_pool', [False, True],
                         ids=['django-connector', 'production-pool'])
def test_native_sweep_watchdog_closes_a_blocked_django_query(
    stalled_settings, caplog, mocker, production_pool,
):
    """Both worker connectors interrupt a blocked synchronous Django query."""
    import time

    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    stalled_settings.JOB_RECLAIM_SWEEP_TIMEOUT_SECONDS = 0.5
    backend_pids = []

    begin_transaction = reclaim._begin_sweep_transaction

    def disable_server_statement_timeout():
        atomic = begin_transaction()
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout = 0")
        return atomic

    mocker.patch.object(
        reclaim, '_begin_sweep_transaction', disable_server_statement_timeout)

    async def blocked_query(*args, **kwargs):
        def execute():
            with connection.cursor() as cursor:
                cursor.execute('SELECT pg_backend_pid()')
                backend_pids.append(cursor.fetchone()[0])
                cursor.execute('SELECT pg_sleep(30)')
        await reclaim._tracked_sync_to_async(execute)

    mocker.patch.object(reclaim, '_reclaim_stalled_jobs', side_effect=blocked_query)
    started = time.monotonic()
    with pytest.raises(asyncio.TimeoutError):
        if production_pool:
            from procrastinate.contrib.django.utils import connector_params
            from procrastinate.psycopg_connector import PsycopgConnector

            connector = PsycopgConnector(
                kwargs=connector_params(), min_size=1, max_size=1)
            with app.replace_connector(connector):
                asyncio.run(reclaim.reclaim_stalled_jobs())
        else:
            asyncio.run(reclaim.reclaim_stalled_jobs())
    elapsed = time.monotonic() - started

    assert 0.2 <= elapsed < 2
    timed_out = [p for p in _json_lines(caplog)
                 if p.get('event') == reclaim.TIMED_OUT_EVENT]
    assert timed_out
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_terminate_backend(%s)', [backend_pids[0]])


# ---------------------------------------------------------------------------
# revalidation -- round 2 of the codex adversarial review
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_candidate_another_sweep_already_requeued_is_not_touched(
    stalled_settings, caplog,
):
    """
    THE overlapping-sweeps interleaving, reproduced exactly.

    Sweep A lists the orphans and is slow. Sweep B requeues job J and a
    worker restarts it. A then writes -- and without the re-list it would
    requeue a job that is RUNNING, duplicating whatever the task does.
    Here the second sweep is simulated inside A's own loop, which is the
    only way to place a concurrent write between A's snapshot and A's
    write deterministically.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = generate_video_poster.defer(generic_file_id=300)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    real = reclaim._stalled_candidates
    calls = {'n': 0}

    async def snapshot_then_let_another_sweep_win(*args, **kwargs):
        result = await real(*args, **kwargs)
        calls['n'] += 1
        if calls['n'] == 1:
            #...between A's listing and A's re-list, sweep B requeues it
            # and a worker picks it straight back up.
            await _requeue_and_restart(job_id)
        return result

    mocker_patch = pytest.MonkeyPatch()
    mocker_patch.setattr(
        reclaim, '_stalled_candidates',
        snapshot_then_let_another_sweep_win)
    try:
        summary = _sweep()
    finally:
        mocker_patch.undo()

    assert summary['skipped_stale'] == 1
    assert summary['reclaimed'] == 0
    # The live attempt was left running, and its attempt count is the one
    # the other sweep set -- not incremented a second time.
    assert _attempts(job_id) == 1
    assert _status(job_id) == 'doing'
    skipped = [p for p in _json_lines(caplog)
               if p.get('event') == reclaim.SKIPPED_EVENT]
    assert len(skipped) == 1
    assert skipped[0]['reason'] == 'stale_snapshot'


@pytest.mark.django_db
def test_a_candidate_still_stalled_at_write_time_is_still_reclaimed(
    stalled_settings,
):
    """
    Negative control for the control: the re-list must not refuse
    everything. A candidate nobody else touched is reclaimed exactly as
    before.
    """
    job_id = generate_video_poster.defer(generic_file_id=301)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    summary = _sweep()

    assert summary['skipped_stale'] == 0
    assert summary['reclaimed_ids'] == [job_id]


# ---------------------------------------------------------------------------
# the per-task reclaim registry -- round 3 of the adversarial review
#
# The finding: `recordings` met, verbatim, the exclusion criterion written
# for `exports` (an application lease of 1800s AND a claim that makes a
# duplicate get recorded SUCCEEDED) and was not excluded, because the
# exclusion was expressed as one queue name in one setting. One number and
# one string cannot describe eighteen tasks, so every task is now
# classified in dj/apps/jobs/reclaim_policy.py and the tests below are what
# make that classification mandatory rather than aspirational.
# ---------------------------------------------------------------------------

def test_every_registered_task_has_a_reclaim_policy():
    """
    THE ENFORCEMENT. A task that is not in the registry is not reclaimed,
    so an unclassified task is not a live hazard -- but it IS a silent
    hole in the feature, and the person adding a task is the only one who
    knows whether it holds a lease or runs for half an hour.

    Adding a task therefore fails this test until it is classified, with
    the number and where the number came from.
    """
    registered = set(app.tasks)
    classified = set(reclaim_policy.TASK_POLICIES)
    missing = sorted(registered - classified)
    assert not missing, (
        'these procrastinate tasks have no entry in '
        'dj/apps/jobs/reclaim_policy.TASK_POLICIES: '
        f'{missing}. Read each one, find its worst-case wall clock (an '
        'explicit timeout, a lease it renews, a size cap on a download, a '
        "provider SDK's per-request timeout times its retry count) and add "
        'it. If the task takes an application-level claim, or you cannot '
        'bound it, use NEVER and say why.')
    stale = sorted(classified - registered)
    assert not stale, (
        f'TASK_POLICIES classifies tasks that no longer exist: {stale}. A '
        'stale entry is how an exclusion ends up guarding an empty lane '
        'while the real task became reclaimable again.')


def test_every_policy_says_where_its_number_came_from():
    """A budget with no provenance cannot be re-checked, only trusted."""
    for name, policy in reclaim_policy.TASK_POLICIES.items():
        assert len(policy.reason) > 40, name
        if policy.reclaimable:
            assert policy.max_runtime_seconds > 0, name


def test_every_reclaimable_task_has_a_bounded_retry_strategy():
    """
    The reclaim count is `attempts` minus the task's retry allowance. A
    task with `retry=True` (max_attempts=None) has no allowance to
    subtract, so reclaims could never be told from retries and the bound
    could never fire. The sweep refuses such a task at runtime; this test
    is so nobody has to discover that from a log line.
    """
    unbounded = [
        name for name, policy in reclaim_policy.TASK_POLICIES.items()
        if policy.reclaimable
        and reclaim_policy.retry_allowance(name) is None
    ]
    assert not unbounded, (
        f'{unbounded} are reclaimable but retry forever; either give the '
        'RetryStrategy a max_attempts or mark the task NEVER.')


def test_the_recording_task_is_never_reclaimed():
    """
    THE FINDING, pinned to the registry rather than to a queue name.
    `dyte.retry_recording_delivery` renews an application lease of
    DYTE_RECORDING_LEASE_SECONDS (1800 by default -- twice the 900s
    floor), and a duplicate returns early through renew_recording_claim
    and is recorded SUCCEEDED: the doing row vanishes, job_stuck goes
    quiet and the give-up alert never fires.
    """
    from django.conf import settings as dj_settings
    policy = reclaim_policy.policy_for('dyte.retry_recording_delivery')
    assert policy is not None and not policy.reclaimable
    assert dj_settings.DYTE_RECORDING_LEASE_SECONDS > (
        dj_settings.JOB_RECLAIM_MIN_AGE_SECONDS)
    assert reclaim.task_threshold_seconds(
        'dyte.retry_recording_delivery') is None


def test_the_translation_task_gets_a_threshold_above_its_own_deadline():
    """
    `g12f.translate_zpage` is reclaimable -- a duplicate is ledger-safe --
    but its DOCUMENT_TIMEOUT_SECONDS is EXACTLY the old 900s floor, so a
    translation that used its budget was aged out at the moment it was
    about to deliver, and the duplicate is a second set of billed
    provider calls on a translation the creator paid for once.
    """
    from dj.apps.g12f.translation import service
    policy = reclaim_policy.policy_for('g12f.translate_zpage')
    assert policy.max_runtime_seconds == int(
        service.DOCUMENT_TIMEOUT_SECONDS), (
        'the translation budget moved; reclaim_policy has to move with it')
    assert reclaim.task_threshold_seconds('g12f.translate_zpage') == 1200


def test_the_observability_sweep_is_never_reclaimed():
    """
    Round-2 review. `jobs.report_job_health` is `@app.periodic` and
    carries NO retry strategy on purpose -- its own docstring says a
    retried observability sweep "would only duplicate log lines (and
    therefore duplicate alerts)". A reclaim IS that retry, so the
    registry has to apply the task author's own rule: requeueing it
    re-emits every per-(queue, alert) ERROR line the alert policies match
    on `jsonPayload.alert`, minutes after the next tick already produced
    the reading. Exactly the call already made for
    `dyte.sweep_live_meetings`.
    """
    from dj.apps.jobs.tasks import report_job_health_task
    policy = reclaim_policy.policy_for('jobs.report_job_health')
    assert policy is not None and not policy.reclaimable
    assert reclaim.task_threshold_seconds('jobs.report_job_health') is None
    # The premise, read off the live task rather than restated: no retry
    # strategy, and periodic. If either changes, re-read the reason.
    assert getattr(report_job_health_task, 'retry_strategy', None) is None
    assert reclaim_policy.retry_allowance('jobs.report_job_health') == 0


def test_the_publish_broadcast_is_reclaimable_now_that_it_is_database_only():
    """
     flipped this one. It was NEVER because it was an EXTERNAL Pub/Sub
    broadcast whose only gate was a read both copies pass. It no longer
    publishes at all: it writes ONE outbox row under a UNIQUE dedup key and
    the relay publishes, so a duplicated run is collapsed in PostgreSQL and
    the task is database-only work with the same shape (and budget) as
    `g12f.publish_zpage`.

    The behaviour that makes the flip safe is pinned in
    `dj/apps/g12f/test_page_update_outbox.py`, not here; this asserts the
    registry agrees with it.
    """
    policy = reclaim_policy.policy_for('g12f.notify_published_zpage')
    assert policy is not None and policy.reclaimable
    assert policy.max_runtime_seconds == 120
    # 120 + the 300s margin is under the 900s floor, so the floor wins --
    # the same threshold every other database-only task gets.
    assert reclaim.task_threshold_seconds(
        'g12f.notify_published_zpage') == 420
    # A reclaim is only ever attempted when the retry allowance is
    # separable from it; PUBLISH_RETRY declares max_attempts, so it is.
    assert reclaim_policy.retry_allowance(
        'g12f.notify_published_zpage') == 3


def test_the_registry_names_the_tasks_that_duplicate_a_paid_call():
    """
    The claim in reclaim.__doc__ used to be a blanket "every reclaimable
    task is idempotent". It is idempotent ON STATE; four of them also
    duplicate a BILLED provider call, and that cost has to be visible in
    the entry rather than in a reviewer's head. This test is what keeps
    the docstring's list and the registry from drifting apart.
    """
    flagged = {
        name for name, policy in reclaim_policy.TASK_POLICIES.items()
        if 'DUPLICATES A PAID CALL' in policy.reason
    }
    assert flagged == {
        'g12f.translate_zpage',
        'search.index_zpage',
        'search.index_multilingual_zpage',
        'g12f.detect_zpage_language',
    }
    #...and every one of them is reclaimable: a NEVER task's cost is
    # moot, so flagging one there would mean the list had drifted.
    assert all(reclaim_policy.TASK_POLICIES[n].reclaimable for n in flagged)
    doc = reclaim.__doc__
    assert 'idempotent **on state**' in doc
    for name in flagged:
        assert f'``{name}``' in doc


def test_the_thresholds_the_registry_actually_produces():
    """
    Pin the registry metadata arithmetic, though it no longer gates orphans.
    """
    t = reclaim.task_threshold_seconds
    assert t('g12f.publish_zpage') == 420               # 120 + 300
    assert t('g12f.translate_zpage') == 1200            # 900 + 300
    assert t('uploads.generate_image_variants') == 1500  # 1200 + 300
    assert t('uploads.generate_video_poster') == 2100   # 1800 + 300
    from django.conf import settings as dj_settings
    search_runtime = (
        2 * dj_settings.SEARCH_OPENAI_TIMEOUT_SECONDS
        * (1 + dj_settings.SEARCH_OPENAI_MAX_RETRIES) + 240
    )
    assert t('search.index_zpage') == search_runtime + 300
    assert t('search.index_multilingual_zpage') == search_runtime + 300
    assert t('exports.export_publication') is None      # NEVER
    assert t('a.task.that.does.not.exist') is None      # unclassified


def test_search_runtime_metadata_is_not_the_orphan_threshold():
    """Keep registry metadata intact; lease and heartbeat decide orphanage."""
    from django.conf import settings as dj_settings
    expected_runtime = (
        2 * dj_settings.SEARCH_OPENAI_TIMEOUT_SECONDS
        * (1 + dj_settings.SEARCH_OPENAI_MAX_RETRIES) + 240
    )
    for name in (
        'search.index_zpage', 'search.index_multilingual_zpage',
    ):
        policy = reclaim_policy.policy_for(name)
        assert policy.max_runtime_seconds == expected_runtime
        assert '240s' in policy.reason
    assert reclaim.reclaim_threshold_seconds() == (
        dj_settings.JOB_RECLAIM_MIN_AGE_SECONDS)


@pytest.mark.django_db
def test_a_live_recordings_job_at_1000s_is_not_reclaimed(stalled_settings,
                                                         caplog):
    """
    THE REVIEWER'S OWN SCENARIO, as a negative control: a `recordings` job
    aged 1000s with worker_id NULL -- which is what a peer worker's
    startup prune leaves behind, at any age -- must NOT be requeued. On
    the branch as reviewed, it was.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = retry_recording_delivery.defer(delivery_id='a-recording')
    _mark_doing(job_id, timezone.now() - timedelta(seconds=1000))

    summary = _sweep()

    assert summary['candidates'] == 1      # it IS aged and orphaned...
    assert summary['reclaimed'] == 0       #...and deliberately left alone
    assert summary['gave_up'] == 0
    assert summary['skipped_never_ids'] == [job_id]
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0
    skipped = [p for p in _json_lines(caplog)
               if p.get('event') == reclaim.SKIPPED_EVENT]
    assert len(skipped) == 1
    assert skipped[0]['reason'] == 'never_reclaimed'
    assert skipped[0]['queue'] == 'recordings'


@pytest.mark.django_db
def test_a_stalled_health_sweep_is_not_reclaimed(stalled_settings, caplog):
    """
    Round-2 review, as behaviour rather than a table lookup, and it is
    this PR's own incident: `default` runs on image-variant-worker, which
    OOMKilled four times in. A poster kills the pod mid-health-
    sweep, the row is orphaned -- and the sweep must be LEFT in `doing`,
    where job_stuck reports it, rather than requeued to re-emit every
    alert line the next tick already emitted.

    NEGATIVE CONTROL: give `jobs.report_job_health` a budget again and
    this goes red -- `reclaimed` becomes 1 and the row leaves `doing`.
    """
    from dj.apps.jobs.tasks import report_job_health_task
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = report_job_health_task.defer(timestamp=0)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=3000))

    summary = _sweep()

    assert summary['candidates'] == 1      # aged and orphaned...
    assert summary['reclaimed'] == 0       #...and deliberately left alone
    assert summary['skipped_never_ids'] == [job_id]
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0
    skipped = [p for p in _json_lines(caplog)
               if p.get('event') == reclaim.SKIPPED_EVENT]
    assert [p['reason'] for p in skipped] == ['never_reclaimed']


@pytest.mark.django_db
def test_a_stalled_publish_broadcast_is_reclaimed(stalled_settings, caplog):
    """
    The round-2 registry finding, closed. A stranded
    `g12f.notify_published_zpage` used to sit in `doing` forever because a
    requeue would re-broadcast; it now writes one outbox row under a UNIQUE
    dedup key, so the requeue is state-safe and the sweep heals it.

    NEGATIVE CONTROL: put it back to NEVER and this goes red
    (`skipped_never_ids == [job_id]`, status stays `doing`).
    """
    from dj.apps.g12f.tasks import notify_published_zpage
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = notify_published_zpage.defer(zpage_id=1)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=3000))

    summary = _sweep()

    assert summary['candidates'] == 1
    assert summary['skipped_never_ids'] == []
    assert summary['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'


@pytest.mark.django_db
def test_a_translation_is_reclaimed_after_its_task_budget(
    stalled_settings, caplog,
):
    """Stale signals do not replay the paid call before its budget passes."""
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = translate_zpage.defer(job_id='a-translation')
    now = timezone.now()
    started = now - timedelta(seconds=1300)
    worker_id = _make_worker(now - timedelta(seconds=181))
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(job_id, 'g12f.translate_zpage', 'translation',
           last_beat_at=now - timedelta(seconds=181), started_at=started)

    summary = _sweep()

    assert summary['candidates'] == 1
    assert summary['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'


@pytest.mark.django_db
def test_a_translation_past_its_own_budget_is_reclaimed(stalled_settings):
    """
    Negative control for the control: the per-task threshold must not
    turn into a permanent exemption. Past 1200s the same job IS rescued.
    """
    job_id = translate_zpage.defer(job_id='an-older-translation')
    now = timezone.now()
    worker_id = _make_worker(now - timedelta(seconds=61))
    _mark_doing(job_id, now - timedelta(seconds=1300), worker_id=worker_id)

    summary = _sweep()

    assert summary['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'


@pytest.mark.django_db
def test_an_unclassified_task_is_left_alone(stalled_settings, caplog,
                                            monkeypatch):
    """
    Fail closed. The registry test above is meant to catch this in CI;
    this is what happens if a task somehow reaches production without an
    entry -- it is left visible to job_stuck, not guessed at.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    policies = dict(reclaim_policy.TASK_POLICIES)
    policies.pop('uploads.generate_video_poster')
    monkeypatch.setattr(reclaim_policy, 'TASK_POLICIES', policies)

    job_id = generate_video_poster.defer(generic_file_id=400)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))

    summary = _sweep()

    assert summary['reclaimed'] == 0
    assert summary['skipped_unclassified'] == 1
    assert _status(job_id) == 'doing'
    skipped = [p for p in _json_lines(caplog)
               if p.get('event') == reclaim.SKIPPED_EVENT]
    assert skipped[0]['reason'] == 'unclassified_task'
    assert skipped[0]['severity'] == 'ERROR'


# ---------------------------------------------------------------------------
# the bound counts RECLAIMS, not attempts -- round 3 of the review
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_job_whose_own_retry_policy_had_attempts_left_is_not_terminalized(
    stalled_settings,
):
    """
    THE REVIEWER'S SECOND SCENARIO, as a negative control.

    `uploads.delete_pending_blob` carries BLOB_DELETION_RETRY(max_attempts
    =5). A job that hit three transient GCS failures and THEN lost its
    worker has attempts=3 and zero reclaims. On the branch as reviewed it
    was marked `failed` on its first stall, cutting short a retry policy
    that still had two attempts left -- and the give-up page then told the
    operator to go looking for three requeues that never happened.
    """
    job_id = delete_pending_blob.defer(pending_blob_id=1)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400), attempts=3)

    summary = _sweep()

    assert summary['gave_up'] == 0
    assert summary['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'
    assert _attempts(job_id) == 4


@pytest.mark.django_db
def test_the_same_job_is_given_up_on_once_it_really_has_been_reclaimed(
    stalled_settings, caplog,
):
    """
    Positive control for the same mechanism: the allowance is subtracted,
    not ignored. 5 (BLOB_DELETION_RETRY) + 3 (JOB_RECLAIM_MAX_RECLAIMS)
    = 8, and the line says which number is which.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = delete_pending_blob.defer(pending_blob_id=2)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400), attempts=8)

    summary = _sweep()

    assert summary['gave_up_ids'] == [job_id]
    assert _status(job_id) == 'failed'
    gave_up = [p for p in _json_lines(caplog)
               if p.get('event') == reclaim.GAVE_UP_EVENT][0]
    assert gave_up['attempts'] == 8
    assert gave_up['reclaims'] == 3
    assert gave_up['retry_allowance'] == 5
    assert gave_up['message'].endswith('attempts=8 reclaims=3')


def test_the_retry_allowance_is_read_from_the_live_task_registry():
    """
    Derived, not duplicated. If someone changes BLOB_DELETION_RETRY the
    bound moves with it -- a second copy of the number in reclaim_policy
    would drift silently and terminalize jobs early again.
    """
    from dj.apps.uploads.tasks import BLOB_DELETION_RETRY
    assert reclaim_policy.retry_allowance(
        'uploads.delete_pending_blob') == BLOB_DELETION_RETRY.max_attempts
    # retry=False -> nothing to subtract.
    assert reclaim_policy.retry_allowance('exports.export_publication') == 0






def test_the_settings_comments_state_lease_reclaim_defaults():
    """
    Same finding, in the file the number actually lives in. A comment
    that contradicts the code is worse than no comment: this one was the
    stated justification for the threshold.
    """
    settings_src = (_REPO_ROOT / 'py' / "free2z" / 'dj' / 'free2z' / 'settings.py'
                    ).read_text()
    assert 'well above the slowest legitimate task' not in settings_src
    assert 'image variants and OpenAI indexing are both well under a ' \
        'minute' not in settings_src
    assert 'the reason two sweeps can never overlap' not in settings_src
    assert 'JOB_RECLAIM_MIN_AGE_SECONDS' in settings_src
    assert 'JOB_LEASE_STALE_SECONDS' in settings_src


def test_the_module_docstring_does_not_claim_the_deleted_attempts_check():
    """
    The MEDIUM doc finding: the top-of-file argument still described a
    revalidation check that a later commit deleted, contradicting
    `_revalidate`'s own docstring three hundred lines below.
    """
    doc = reclaim.__doc__
    assert 'its ``attempts`` is unchanged' not in doc
    assert 'The ``attempts`` comparison catches the same thing' not in doc
    assert 'transaction-scoped advisory lock' in doc
    assert 'one-server' in doc


def test_the_task_docstring_does_not_claim_the_lock_prevents_overlap():
    """
    Round-2 review: the SAME two false claims that settings.py and
    reclaim.__doc__ were corrected for survived in dj/apps/jobs/tasks.py,
    which is the file a maintainer opens FIRST -- it is where the task is
    defined. Someone reading "the lock keeps it from happening at all"
    and "retry_job/finish_job refuse to act on a row that has left doing"
    concludes the re-listing in reclaim.py is redundant belt-and-braces
    and deletes it, which restores the race.

    procrastinate 3.9's own schema: `procrastinate_finish_job_v1` is
    `WHERE id = job_id AND status IN ('todo', 'doing')`; only `retry_job`
    requires `doing`. So finish_job accepting `todo` means the stored
    procedures are not a defence at all.

    Pinned in the source, not the docstring object, so the surrounding
    comments are covered too.
    """
    src = (_REPO_ROOT / 'py' / "free2z" / 'dj' / 'apps' / 'jobs' / 'tasks.py').read_text()
    assert 'the lock keeps it from happening at all' not in src
    assert 'refuse to act on a row that has left' not in src
    assert 'non-blocking advisory lock' in src
    assert 'each row transaction' in src


@pytest.mark.django_db
def test_the_poster_job_is_reclaimed_after_its_task_budget(
    stalled_settings,
):
    job_id = generate_video_poster.defer(generic_file_id=500)
    now = timezone.now()
    started = now - timedelta(seconds=2200)
    worker_id = _make_worker(now - timedelta(seconds=181))
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=now - timedelta(seconds=181), started_at=started)

    summary = _sweep()

    assert summary['reclaimed_ids'] == [job_id]
    assert _status(job_id) == 'todo'


@pytest.mark.django_db(transaction=True)
def test_lost_status_write_is_recovered_after_live_body_ends(
        stalled_settings, settings, request, monkeypatch):
    """A live provider-shaped body is never replayed; its lost outcome is.

    Run the actual lease middleware around a blocked body, with a fresh
    Procrastinate worker heartbeat and a stale lease. The production pool
    sweep must leave it alone. After the body returns, make status persistence
    fail; the middleware's durable abandoned-attempt marker then lets a later
    production-pool sweep recover the stranded row. No worker is run for the
    replacement attempt, so the body-call count proves the live attempt was
    not replayed under its feet.
    """
    import threading
    import time

    import psycopg
    from types import SimpleNamespace

    from dj.apps.jobs.models import JobLease

    settings.JOB_LEASE_ENABLED = True
    settings.JOB_LEASE_WITHOUT_RECLAIMER = False
    settings.JOB_LEASE_BEAT_SECONDS = 60
    settings.JOB_LEASE_STALE_SECONDS = 180
    lease.reset_for_tests()

    job_id = translate_zpage.defer(job_id='live-provider-outcome')
    _cleanup_production_pool_jobs(request, job_id)
    started = timezone.now() - timedelta(seconds=1500)
    worker_id = _make_worker(timezone.now())
    _mark_doing(job_id, started, worker_id=worker_id)
    job = app.job_manager.list_jobs(id=job_id)[0]
    context = SimpleNamespace(
        job=job, start_timestamp=started.timestamp(),
        worker_name='live-provider-worker', additional_context={},
    )

    body_entered = threading.Event()
    release_body = threading.Event()
    body_calls = []
    body_errors = []

    def live_body():
        body_calls.append('started')
        body_entered.set()
        if not release_body.wait(10):
            raise TimeoutError('test did not release the live body')
        body_calls.append('finished')
        return 'provider response received'

    async def fail_status_persistence(**kwargs):
        raise psycopg.OperationalError('injected lost status write')

    worker = SimpleNamespace(
        _job_ids_to_abort={}, _persist_job_status=fail_status_persistence)

    # This backend can be reused after Procrastinate pool commits, which do
    # not participate in Django's flush. Keep the production candidate query
    # and row transition real, while excluding only stale rows from prior
    # tests so they cannot affect this test's summary.
    original_candidates = reclaim._stalled_candidates

    async def candidates_for_owned_job(*args, **kwargs):
        candidates, aged_count, orphaned_count = await original_candidates(
            *args, **kwargs)
        return ([candidate for candidate in candidates
                 if candidate.id == job_id], aged_count, orphaned_count)

    monkeypatch.setattr(
        reclaim, '_stalled_candidates', candidates_for_owned_job)

    def run_live_attempt():
        try:
            lease.lease_middleware(live_body, context, worker)
        except BaseException as exc:  # propagated to the owning test thread
            body_errors.append(exc)

    attempt = threading.Thread(target=run_live_attempt)
    attempt.start()
    try:
        assert body_entered.wait(5), 'the middleware did not enter the body'
        lease_row = JobLease.objects.get(job_id=job_id)
        JobLease.objects.filter(job_id=job_id).update(
            last_beat_at=timezone.now() - timedelta(seconds=181))

        first_sweep = _sweep_with_production_pool()
        assert job_id not in first_sweep['reclaimed_ids']
        assert first_sweep['reclaimed'] == 0
        assert _status(job_id) == 'doing'
        assert _attempts(job_id) == 0
        assert body_calls == ['started']
        assert not release_body.is_set()

        release_body.set()
        attempt.join(timeout=5)
        assert not attempt.is_alive(), 'the live attempt did not finish'
        assert body_errors == []
        assert body_calls == ['started', 'finished']

        with pytest.raises(psycopg.OperationalError, match='lost status write'):
            asyncio.run(worker._persist_job_status(
                job=context.job, status=SimpleNamespace(value='succeeded'),
                retry_decision=None, context=context, job_result=None))

        deadline = time.monotonic() + 5
        marker = None
        while time.monotonic() < deadline:
            marker = QuarantinedJob.objects.filter(
                job_id=job_id, requeued_at__isnull=True).first()
            if marker and JobLease.objects.filter(job_id=job_id).exists():
                break
            time.sleep(0.01)
        assert marker is not None
        assert marker.reason == (
            f'recovery abandoned attempt after_body:{lease_row.token}')
        JobLease.objects.filter(job_id=job_id).update(
            last_beat_at=started)

        recovery_sweep = _sweep_with_production_pool()
        assert recovery_sweep['reclaimed_ids'] == [job_id]
        assert _status(job_id) == 'todo'
        assert _attempts(job_id) == 1
        assert not JobLease.objects.filter(job_id=job_id).exists()
        assert not QuarantinedJob.objects.filter(
            job_id=job_id, requeued_at__isnull=True).exists()
        assert body_calls == ['started', 'finished']
    finally:
        release_body.set()
        attempt.join(timeout=5)
        lease.reset_for_tests()


@pytest.mark.django_db(transaction=True)
def test_abandoned_never_attempts_recover_only_before_the_body(
        stalled_settings, settings, monkeypatch, creator_factory, request):
    """A pre-body lease failure is safe; an interrupted NEVER body is not."""
    import asyncio
    import time
    from contextlib import contextmanager
    from decimal import Decimal

    import psycopg

    from dj.apps.e2ee.models import ChatRequest
    from dj.apps.e2ee.tasks import send_chat_request_email

    settings.JOB_LEASE_ENABLED = True
    settings.JOB_LEASE_BEAT_SECONDS = 0.05
    settings.JOB_LEASE_STALE_SECONDS = 60
    lease.reset_for_tests()
    sender, recipient = creator_factory(), creator_factory()
    chats = [
        ChatRequest.objects.create(
            sender=sender, recipient=recipient,
            sender_handle=sender.username, charged=Decimal('1'))
        for _ in range(2)
    ]
    job_ids = [send_chat_request_email.defer(chat_request_id=str(chat.id))
               for chat in chats]
    for job_id in job_ids:
        _cleanup_production_pool_jobs(request, job_id)

    now = timezone.now()
    started = now - timedelta(days=1)
    worker_id = _make_worker(now)
    for job_id in job_ids:
        _mark_doing(job_id, started, worker_id=worker_id)

    def context_for(job_id, name):
        job = app.job_manager.list_jobs(id=job_id)[0]
        return SimpleNamespace(
            job=job, start_timestamp=started.timestamp(),
            worker_name=name, additional_context={})

    no_body_calls = []
    prebody_context = context_for(job_ids[0], 'prebody-never')
    prebody_worker = SimpleNamespace(
        _job_ids_to_abort={}, _persist_job_status=lambda **kwargs: None)
    real_connect = lease._connect

    @contextmanager
    def fail_only_the_lease_insert(params, label):
        with real_connect(params, label) as conn:
            class Wrapped:
                def __getattr__(self, name):
                    return getattr(conn, name)

                def execute(self, query, *args, **kwargs):
                    if query == lease._INSERT_SQL:
                        raise psycopg.OperationalError(
                            'injected pre-body lease insert failure')
                    return conn.execute(query, *args, **kwargs)
            yield Wrapped()

    monkeypatch.setattr(lease, '_connect', fail_only_the_lease_insert)
    try:
        with pytest.raises(lease.LeaseLost):
            lease.lease_middleware(
                lambda: no_body_calls.append(True),
                prebody_context, prebody_worker)
        asyncio.run(prebody_worker._persist_job_status(
            job=prebody_context.job, status=SimpleNamespace(value='failed'),
            retry_decision=None, context=prebody_context, job_result=None))
        monkeypatch.setattr(lease, '_connect', real_connect)

        # This second attempt enters its body, then loses status persistence.
        # Its durable marker must not turn a NEVER task into an automatic retry.
        async def fail_status(**kwargs):
            raise psycopg.OperationalError('injected status write failure')

        body_calls = []
        body_context = context_for(job_ids[1], 'started-never')
        body_worker = SimpleNamespace(
            _job_ids_to_abort={}, _persist_job_status=fail_status)
        lease.lease_middleware(
            lambda: body_calls.append(True), body_context, body_worker)
        with pytest.raises(psycopg.OperationalError):
            asyncio.run(body_worker._persist_job_status(
                job=body_context.job, status=SimpleNamespace(value='failed'),
                retry_decision=None, context=body_context, job_result=None))

        deadline = time.monotonic() + 5
        while (not all(JobLease.objects.filter(job_id=job_id).exists()
                       for job_id in job_ids)
               or not all(QuarantinedJob.objects.filter(
                   job_id=job_id, requeued_at__isnull=True).exists()
                   for job_id in job_ids)) and time.monotonic() < deadline:
            time.sleep(0.01)
        markers = {
            row.job_id: row
            for row in QuarantinedJob.objects.filter(job_id__in=job_ids)
        }
        assert markers[job_ids[0]].reason.startswith(
            'recovery abandoned attempt before_body:')
        assert markers[job_ids[1]].reason.startswith(
            'recovery abandoned attempt after_body:')
        for job_id in job_ids:
            JobLease.objects.filter(job_id=job_id).update(
                last_beat_at=started)

        summary = _sweep_with_production_pool()

        assert summary['reclaimed_ids'] == [job_ids[0]]
        assert job_ids[1] in summary['skipped_never_ids']
        assert _status(job_ids[0]) == 'todo'
        assert _attempts(job_ids[0]) == 1
        assert _status(job_ids[1]) == 'doing'
        assert _attempts(job_ids[1]) == 0
        assert chats[0].email_status == ChatRequest.EMAIL_PENDING
        chats[1].refresh_from_db()
        assert chats[1].email_status == ChatRequest.EMAIL_PENDING
        assert no_body_calls == []
        assert body_calls == [True]
    finally:
        lease.reset_for_tests()


@pytest.mark.django_db(transaction=True)
def test_four_export_acquisition_failures_recover_capacity_without_body_replay(
        stalled_settings, settings, monkeypatch, creator_factory, request):
    """Recover only failed pre-body acquisitions, then admit the fifth export."""
    import asyncio
    import time
    from contextlib import contextmanager

    import psycopg
    from rest_framework.test import APIClient

    from dj.apps.exports.exporter import PublicationExporter, process_export_job
    from dj.apps.exports.models import ExportStatus, PublicationExportJob

    settings.JOB_LEASE_ENABLED = True
    settings.JOB_LEASE_WITHOUT_RECLAIMER = False
    settings.JOB_LEASE_BEAT_SECONDS = 60
    settings.JOB_LEASE_STALE_SECONDS = 180
    settings.JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES = ()
    settings.EXPORT_MAX_ACTIVE_JOBS = 4
    settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 0
    lease.reset_for_tests()

    now = timezone.now()
    started = now - timedelta(minutes=20)
    owners = [creator_factory() for _ in range(5)]
    export_rows = [PublicationExportJob.objects.create(creator=owner)
                   for owner in owners[:4]]
    job_ids = [export_publication_task.defer(job_id=str(row.pk))
               for row in export_rows]
    for job_id in job_ids:
        _cleanup_production_pool_jobs(request, job_id)
        _mark_doing(job_id, started, worker_id=_make_worker(now))

    no_body_calls = []
    persistence_calls = []

    async def record_status_attempt(**kwargs):
        persistence_calls.append(kwargs)

    worker = SimpleNamespace(
        _job_ids_to_abort={}, _persist_job_status=record_status_attempt)
    connect = lease._connect

    @contextmanager
    def fail_lease_insert(params, label):
        with connect(params, label) as conn:
            class Wrapped:
                def __getattr__(self, name):
                    return getattr(conn, name)

                def execute(self, query, *args, **kwargs):
                    if query == lease._INSERT_SQL:
                        raise psycopg.OperationalError(
                            'injected transient export lease acquisition failure')
                    return conn.execute(query, *args, **kwargs)
            yield Wrapped()

    monkeypatch.setattr(lease, '_connect', fail_lease_insert)
    try:
        for job_id in job_ids:
            job = app.job_manager.list_jobs(id=job_id)[0]
            context = SimpleNamespace(
                job=job, start_timestamp=started.timestamp(),
                worker_name='exports-worker', additional_context={})
            with pytest.raises(lease.LeaseLost):
                lease.lease_middleware(
                    lambda: no_body_calls.append(job_id), context, worker)
            asyncio.run(worker._persist_job_status(
                job=job, status=SimpleNamespace(value='failed'),
                retry_decision=None, context=context, job_result=None))
            marker = None
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                marker = QuarantinedJob.objects.filter(
                    job_id=job_id, requeued_at__isnull=True).first()
                if marker and JobLease.objects.filter(job_id=job_id).exists():
                    break
                time.sleep(0.01)
            assert marker is not None, 'pre-body failure marker was not durable'
            assert marker.reason.startswith(
                'recovery abandoned attempt before_body:')
            JobLease.objects.filter(job_id=job_id).update(last_beat_at=started)

        assert no_body_calls == []
        assert persistence_calls == []
        assert list(ProcrastinateJob.objects.filter(pk__in=job_ids).values_list(
            'status', flat=True)) == ['doing'] * 4
        monkeypatch.setattr(lease, '_connect', connect)

        client = APIClient()
        client.force_authenticate(user=owners[4])
        response = client.post('/api/exports/publications/')
        assert response.status_code == 503

        original_candidates = reclaim._stalled_candidates

        async def owned_candidates(*args, **kwargs):
            candidates, aged_count, orphaned_count = await original_candidates(
                *args, **kwargs)
            return ([job for job in candidates if job.id in job_ids],
                    aged_count, orphaned_count)

        monkeypatch.setattr(reclaim, '_stalled_candidates', owned_candidates)
        summary = _sweep_with_production_pool()
        assert summary['reclaimed_ids'] == sorted(job_ids)
        assert [_attempts(job_id) for job_id in job_ids] == [1] * 4
        assert all(_status(job_id) == 'todo' for job_id in job_ids)
        assert all(not QuarantinedJob.objects.filter(
            job_id=job_id, requeued_at__isnull=True).exists()
            for job_id in job_ids)
        assert set(PublicationExportJob.objects.filter(pk__in=[
            row.pk for row in export_rows], status=ExportStatus.QUEUED
        ).values_list('pk', flat=True)) == {row.pk for row in export_rows}

        body_calls = []

        def finish_export(self):
            body_calls.append(self.job.pk)
            PublicationExportJob.objects.filter(
                pk=self.job.pk, status=ExportStatus.RUNNING
            ).update(status=ExportStatus.READY)

        with monkeypatch.context() as export_patch:
            export_patch.setattr(PublicationExporter, 'export', finish_export)
            for job_id, export_row in zip(job_ids, export_rows):
                attempt_started = timezone.now()
                worker_id = _make_worker(attempt_started)
                with connection.cursor() as cursor:
                    cursor.execute(
                        "UPDATE procrastinate_jobs SET status='doing', "
                        "worker_id=%s WHERE id=%s",
                        [worker_id, job_id])
                job = app.job_manager.list_jobs(id=job_id)[0]
                context = SimpleNamespace(
                    job=job, start_timestamp=attempt_started.timestamp(),
                    worker_name='retry-exports-worker', additional_context={})
                lease.lease_middleware(
                    lambda export_id=export_row.pk:
                        process_export_job(str(export_id)), context, worker)

        assert body_calls == [row.pk for row in export_rows]
        assert list(PublicationExportJob.objects.filter(
            pk__in=[row.pk for row in export_rows]
        ).values_list('status', flat=True)) == [ExportStatus.READY] * 4
        response = client.post('/api/exports/publications/')
        assert response.status_code == 201, response.data
        assert no_body_calls == []
    finally:
        monkeypatch.setattr(lease, '_connect', connect)
        lease.reset_for_tests()


@pytest.mark.django_db(transaction=True)
def test_real_restart_without_prebody_evidence_waits_for_export_cleanup(
        stalled_settings, settings, creator_factory, request, tmp_path):
    """SIGTERM loses queued evidence; NEVER fences replay until cleanup frees slots."""
    import os
    import signal
    import subprocess
    import sys
    import textwrap

    from rest_framework.test import APIClient

    from dj.apps.exports.exporter import cleanup_expired_jobs
    from dj.apps.exports.models import ExportStatus, PublicationExportJob

    settings.JOB_RECLAIM_EXCLUDED_QUEUES = ()
    settings.EXPORT_MAX_ACTIVE_JOBS = 4
    settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 0
    owners = [creator_factory() for _ in range(5)]
    exports = [PublicationExportJob.objects.create(creator=owner)
               for owner in owners[:4]]
    job_id = export_publication_task.defer(job_id=str(exports[0].pk))
    _cleanup_production_pool_jobs(request, job_id)
    started = timezone.now() - timedelta(hours=1)
    _mark_doing(job_id, started, worker_id=_make_worker(started))
    body_marker = tmp_path / 'body-ran'
    inserted_marker = tmp_path / 'lease-insert-committed'
    script = textwrap.dedent(r"""
        import os, sys, threading, time
        from contextlib import contextmanager
        from pathlib import Path
        from types import SimpleNamespace
        import django
        django.setup()
        from django.conf import settings
        from procrastinate.contrib.django import app
        from dj.apps.jobs import lease
        settings.JOB_LEASE_ENABLED = True
        settings.JOB_LEASE_WITHOUT_RECLAIMER = False
        settings.JOB_LEASE_BEAT_SECONDS = 60
        lease.batch_deadline_seconds = lambda n: 0.15
        lease.OUTCOME_MARGIN_SECONDS = 0.1
        # Fault injection: the database committed the insert but its response
        # never reaches the lease thread, and its connection cut cannot free it.
        # The restart function and process SIGTERM handling are NOT mocked.
        lease._cut_batch = lambda *args: None
        connect = lease._connect
        @contextmanager
        def stalled_response(params, label):
            with connect(params, label) as conn:
                class Wrapped:
                    def __getattr__(self, name):
                        return getattr(conn, name)
                    def execute(self, query, *args, **kwargs):
                        result = conn.execute(query, *args, **kwargs)
                        if query == lease._INSERT_SQL:
                            Path(sys.argv[3]).write_text('committed')
                            threading.Event().wait(60)
                        return result
                yield Wrapped()
        lease._connect = stalled_response
        job = app.job_manager.list_jobs(id=int(sys.argv[1]))[0]
        context = SimpleNamespace(job=job, start_timestamp=time.time(),
                                  worker_name='restart-export', additional_context={})
        async def persist(**kwargs):
            raise AssertionError('fenced attempt persisted an outcome')
        worker = SimpleNamespace(_job_ids_to_abort={}, _persist_job_status=persist)
        lease.lease_middleware(lambda: Path(sys.argv[2]).write_text('ran'),
                               context, worker)
        raise AssertionError('unverified middleware returned')
    """)
    env = dict(os.environ, DBNAME=connection.settings_dict['NAME'],
               DJANGO_SETTINGS_MODULE='pytest_settings')
    py_root = Path(__file__).resolve().parents[3]
    env['PYTHONPATH'] = str(py_root)
    child = subprocess.Popen(
        [sys.executable, '-c', script, str(job_id), str(body_marker),
         str(inserted_marker)], cwd=py_root, env=env, start_new_session=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        output, _ = child.communicate(timeout=20)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
    assert child.returncode == -signal.SIGTERM, output
    assert inserted_marker.exists(), output
    assert 'procrastinate_lease_batch_stall_restart' in output
    assert not body_marker.exists()
    assert JobLease.objects.filter(job_id=job_id).exists()
    assert not QuarantinedJob.objects.filter(job_id=job_id).exists()
    JobLease.objects.filter(job_id=job_id).update(last_beat_at=started)

    # A real sweep cannot treat absent evidence as permission to rerun NEVER.
    _sweep_with_production_pool()
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 0
    assert not body_marker.exists()
    exports[0].refresh_from_db()
    assert exports[0].status == ExportStatus.QUEUED
    client = APIClient()
    client.force_authenticate(user=owners[4])
    assert client.post('/api/exports/publications/').status_code == 503

    # The cutoff is two hours, not an immediate failure on restart. The actual
    # cleanup query owns that boundary; backdating avoids a two-hour test sleep.
    PublicationExportJob.objects.filter(pk=exports[0].pk).update(
        updated_at=timezone.now() - timedelta(hours=1, minutes=59))
    cleanup_expired_jobs()
    exports[0].refresh_from_db()
    assert exports[0].status == ExportStatus.QUEUED
    PublicationExportJob.objects.filter(pk=exports[0].pk).update(
        updated_at=timezone.now() - timedelta(hours=2, seconds=1))
    cleanup_expired_jobs()
    exports[0].refresh_from_db()
    assert exports[0].status == ExportStatus.FAILED
    assert not body_marker.exists()
    assert _status(job_id) == 'doing'
    response = client.post('/api/exports/publications/')
    assert response.status_code == 201
    new_job = ProcrastinateJob.objects.filter(
        task_name='exports.export_publication',
        args__job_id=str(response.data['id'])).get()
    _cleanup_production_pool_jobs(request, new_job.pk)


@pytest.mark.django_db(transaction=True)
def test_exhausted_prebody_export_failure_releases_queued_admission_slot(
        stalled_settings, settings, creator_factory, monkeypatch):
    """Retry exhaustion terminalizes the paired queued export atomically."""
    from rest_framework.test import APIClient

    from dj.apps.exports.models import ExportStatus, PublicationExportJob

    settings.EXPORT_MAX_ACTIVE_JOBS = 1
    settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 0
    owner = creator_factory()
    export = PublicationExportJob.objects.create(creator=owner)
    job_id = export_publication_task.defer(job_id=str(export.pk))
    now = timezone.now()
    started = now - timedelta(hours=3)
    attempts = settings.JOB_RECLAIM_MAX_RECLAIMS
    _mark_doing(job_id, started, attempts=attempts)
    held = _lease(
        job_id, 'exports.export_publication', 'exports',
        last_beat_at=started, started_at=started)
    JobLease.objects.filter(job_id=job_id).update(attempt=attempts)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name='exports.export_publication', queue='exports',
        reason=f'recovery abandoned attempt before_body:{held.token}',
        attempts=attempts)

    candidates = reclaim._stalled_candidates

    async def only_owned_export(*args, **kwargs):
        jobs, aged_count, orphaned_count = await candidates(*args, **kwargs)
        return ([job for job in jobs if job.id == job_id],
                aged_count, orphaned_count)

    monkeypatch.setattr(reclaim, '_stalled_candidates', only_owned_export)
    summary = _sweep()

    assert summary['gave_up_ids'] == [job_id]
    assert _status(job_id) == 'failed'
    assert not JobLease.objects.filter(job_id=job_id).exists()
    export.refresh_from_db()
    assert export.status == ExportStatus.FAILED
    assert export.error_message == (
        'Export could not start after repeated infrastructure failures.')
    assert QuarantinedJob.objects.filter(
        job_id=job_id, requeued_at__isnull=True).exists()

    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.post('/api/exports/publications/')
    assert response.status_code == 201, response.data


@pytest.mark.django_db(transaction=True)
def test_production_pool_exhaustion_releases_only_matching_queued_export(
        stalled_settings, settings, creator_factory, monkeypatch, request):
    """The production transaction does not release started export rows."""
    from procrastinate import sql

    from dj.apps.exports.models import ExportStatus, PublicationExportJob

    settings.JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES = ()
    queued_export = PublicationExportJob.objects.create(
        creator=creator_factory())
    running_export = PublicationExportJob.objects.create(
        creator=creator_factory(), status=ExportStatus.RUNNING)
    rollback_export = PublicationExportJob.objects.create(
        creator=creator_factory())
    mismatched_export = PublicationExportJob.objects.create(
        creator=creator_factory())
    queued_job_id = export_publication_task.defer(
        job_id=str(queued_export.pk))
    running_job_id = export_publication_task.defer(
        job_id=str(running_export.pk))
    rollback_job_id = export_publication_task.defer(
        job_id=str(rollback_export.pk))
    mismatched_job_id = export_publication_task.defer(
        job_id='not-the-export-row-id')
    now = timezone.now()
    started = now - timedelta(hours=3)
    attempts = settings.JOB_RECLAIM_MAX_RECLAIMS
    for job_id in (
            queued_job_id, running_job_id, rollback_job_id, mismatched_job_id):
        _cleanup_production_pool_jobs(request, job_id)
        _mark_doing(job_id, started, attempts=attempts)
        held = _lease(
            job_id, 'exports.export_publication', 'exports',
            last_beat_at=started, started_at=started)
        JobLease.objects.filter(job_id=job_id).update(attempt=attempts)
        QuarantinedJob.objects.create(
            job_id=job_id, task_name='exports.export_publication',
            queue='exports',
            reason=f'recovery abandoned attempt before_body:{held.token}',
            attempts=attempts)

    candidates = reclaim._stalled_candidates

    async def only_owned_exports(*args, **kwargs):
        jobs, aged_count, orphaned_count = await candidates(*args, **kwargs)
        return ([job for job in jobs
                 if job.id in (
                     queued_job_id, running_job_id, rollback_job_id,
                     mismatched_job_id)],
                aged_count, orphaned_count)

    monkeypatch.setattr(reclaim, '_stalled_candidates', only_owned_exports)
    def fail_rollback_transition(connector):
        execute = connector.execute_query_all_async_with_connection

        async def fail_after_export_update(conn, **kwargs):
            if (kwargs.get('query') == sql.queries['finish_job']
                    and kwargs.get('job_id') == rollback_job_id):
                raise RuntimeError('injected terminal status transition failure')
            return await execute(conn, **kwargs)

        monkeypatch.setattr(
            connector, 'execute_query_all_async_with_connection',
            fail_after_export_update)

    summary = _sweep_with_production_pool(configure=fail_rollback_transition)

    assert set(summary['gave_up_ids']) == {queued_job_id, running_job_id,
                                           mismatched_job_id}
    assert summary['errors'] == 1
    queued_export.refresh_from_db()
    running_export.refresh_from_db()
    rollback_export.refresh_from_db()
    mismatched_export.refresh_from_db()
    assert queued_export.status == ExportStatus.FAILED
    assert running_export.status == ExportStatus.RUNNING
    assert rollback_export.status == ExportStatus.QUEUED
    assert mismatched_export.status == ExportStatus.QUEUED
    assert _status(rollback_job_id) == 'doing'
    assert JobLease.objects.filter(job_id=rollback_job_id).exists()


@pytest.mark.django_db(transaction=True)
def test_export_recovery_refuses_marker_for_a_different_attempt(
        stalled_settings):
    """A stale before-body marker cannot authorize a newer export attempt."""
    job_id = export_publication_task.defer(job_id='changed-export-attempt')
    started = timezone.now() - timedelta(seconds=2400)
    _mark_doing(job_id, started, attempts=1)
    old_lease = _lease(
        job_id, 'exports.export_publication', 'exports',
        last_beat_at=started, started_at=started)
    JobLease.objects.filter(job_id=job_id).update(attempt=0)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name='exports.export_publication', queue='exports',
        reason=f'recovery abandoned attempt before_body:{old_lease.token}',
        attempts=0)

    result = _sweep()

    assert result['reclaimed_ids'] == []
    assert result['skipped_excluded'] == 1
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 1


@pytest.mark.django_db(transaction=True)
def test_prebody_never_recovery_subtracts_ordinary_task_retries(
        stalled_settings):
    """A safe lease-acquisition retry must not consume reclaim attempts."""
    from dj.apps.ktauth.tasks import sweep_sessions

    job_id = sweep_sessions.defer(user_id=987654, generation=4)
    now = timezone.now()
    started = now - timedelta(seconds=2400)
    _mark_doing(job_id, started, attempts=3)
    held = _lease(
        job_id, 'ktauth.sweep_sessions', 'default',
        last_beat_at=started, started_at=started)
    JobLease.objects.filter(job_id=job_id).update(attempt=3)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name='ktauth.sweep_sessions', queue='default',
        reason=f'recovery abandoned attempt before_body:{held.token}',
        attempts=3)

    result = _sweep()

    assert job_id in result['reclaimed_ids']
    assert job_id not in result['gave_up_ids']
    assert _status(job_id) == 'todo'
    assert _attempts(job_id) == 4


@pytest.mark.django_db(transaction=True)
def test_two_concurrent_sweeps_only_requeue_once(stalled_settings):
    """Native async sweeps own separate connections and serialize on lock."""
    job_id = generate_video_poster.defer(generic_file_id=600)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400))
    first_listed = asyncio.Event()
    second_listed = asyncio.Event()
    release_first = asyncio.Event()
    sweep_identity = ContextVar('sweep_identity', default=None)
    seen = set()
    original = reclaim._stalled_candidates

    async def gate_listing(*args, **kwargs):
        result = await original(*args, **kwargs)
        identity = sweep_identity.get()
        first_listing = identity not in seen
        seen.add(identity)
        if first_listing:
            if identity == 'first':
                first_listed.set()
                await asyncio.wait_for(release_first.wait(), timeout=10)
            elif identity == 'second':
                second_listed.set()
        return result

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(reclaim, '_stalled_candidates', gate_listing)
    async def run_sweep(identity):
        token = sweep_identity.set(identity)
        try:
            return await reclaim.reclaim_stalled_jobs()
        finally:
            sweep_identity.reset(token)

    async def run_both():
        first = asyncio.create_task(run_sweep('first'))
        await asyncio.wait_for(first_listed.wait(), timeout=10)
        second = asyncio.create_task(run_sweep('second'))
        await asyncio.sleep(0.25)
        assert not second_listed.is_set(), (
            'the second native async sweep passed the lock')
        release_first.set()
        return await asyncio.gather(first, second)

    try:
        # `asyncio.run` exercises the native-async worker path. `async_to_sync`
        # installs a parent-thread executor that intentionally overrides the
        # per-sweep ThreadSensitiveContext under test.
        results = asyncio.run(run_both())
    finally:
        monkeypatch.undo()
    assert len(results) == 2
    assert sum(result['reclaimed'] for result in results) == 1
    assert _attempts(job_id) == 1
    assert _status(job_id) == 'todo'


@pytest.mark.django_db(transaction=True)
def test_production_pool_fence_and_transition_are_atomic_per_row(
    stalled_settings, monkeypatch, request,
):
    """A later status-proc failure rolls back only its own lease fence.

    Procrastinate's committed worker-pool transactions can leave unrelated
    ``doing`` rows in a reused backend test database. Keep this regression
    scoped to its two rows while still obtaining candidates through the real
    production connector and requiring both rows to be present in that query.
    """
    from procrastinate import sql

    now = timezone.now()
    first = export_publication_task.defer(job_id='atomic-export-first')
    _cleanup_production_pool_jobs(request, first)
    second = export_publication_task.defer(job_id='atomic-export-second')
    _cleanup_production_pool_jobs(request, second)
    for job_id in (first, second):
        started = now - timedelta(seconds=2400)
        _mark_doing(job_id, started)
        held = _lease(
            job_id, 'exports.export_publication', 'exports',
            last_beat_at=started, started_at=started)
        QuarantinedJob.objects.create(
            job_id=job_id, task_name='exports.export_publication',
            queue='exports',
            reason=f'recovery abandoned attempt before_body:{held.token}',
            attempts=0)

    original_candidates = reclaim._stalled_candidates
    target_ids = {first, second}
    checked_initial_candidates = False

    async def candidates_for_these_rows_only(*args, **kwargs):
        nonlocal checked_initial_candidates
        candidates, aged_count, orphaned_count = await original_candidates(
            *args, **kwargs)
        matching = [candidate for candidate in candidates
                    if candidate.id in target_ids]
        if not checked_initial_candidates:
            assert {candidate.id for candidate in matching} == target_ids
            checked_initial_candidates = True
        return matching, aged_count, orphaned_count

    monkeypatch.setattr(
        reclaim, '_stalled_candidates', candidates_for_these_rows_only)

    def fail_second(connector):
        execute = connector.execute_query_all_async_with_connection

        async def fail_second_after_fence(conn, **kwargs):
            if (kwargs.get('query') == sql.queries['retry_job']
                    and kwargs.get('job_id') == second):
                raise RuntimeError('injected status transition failure')
            return await execute(conn, **kwargs)

        monkeypatch.setattr(
            connector, 'execute_query_all_async_with_connection',
            fail_second_after_fence)

    summary = _sweep_with_production_pool(configure=fail_second)

    assert summary['reclaimed_ids'] == [first]
    assert summary['errors'] == 1
    assert summary['reclaimed'] == 1
    assert _status(first) == 'todo'
    assert _attempts(first) == 1
    assert not JobLease.objects.filter(job_id=first).exists()
    assert _status(second) == 'doing'
    assert _attempts(second) == 0
    assert JobLease.objects.filter(job_id=second).exists(), (
        'the failed status call committed its earlier lease DELETE')
    marker = QuarantinedJob.objects.get(job_id=second)
    assert marker.reason.startswith(
        'recovery abandoned attempt before_body:')


@pytest.mark.django_db(transaction=True)
def test_deadline_marker_tracks_replacement_lease_generation(
    stalled_settings, monkeypatch, request,
):
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=16892)
    _cleanup_production_pool_jobs(request, job_id)
    _enable_test_hard_deadline(monkeypatch, 'uploads.generate_video_poster')
    started = now - timedelta(seconds=2400)
    _mark_doing(job_id, started)
    first_token = uuid.uuid4()
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=now - timedelta(seconds=5),
           deadline_at=now - timedelta(seconds=1), started_at=started)
    JobLease.objects.filter(job_id=job_id).update(token=first_token)

    assert _sweep_with_production_pool()['skipped_fresh_lease'] == 0
    first_marker = QuarantinedJob.objects.get(job_id=job_id)
    assert first_marker.reason == reclaim._deadline_marker_reason(first_token)
    assert first_marker.attempts == 0

    replacement_token = uuid.uuid4()
    JobLease.objects.filter(job_id=job_id).update(token=replacement_token)
    summary = _sweep_with_production_pool()

    assert summary['gave_up'] == 0
    assert _status(job_id) == 'doing'
    assert QuarantinedJob.objects.get(job_id=job_id).reason == (
        reclaim._deadline_marker_reason(replacement_token))
    assert JobLease.objects.get(job_id=job_id).token == replacement_token

    assert _sweep_with_production_pool()['gave_up_ids'] == [job_id]
    assert _status(job_id) == 'failed'


@pytest.mark.django_db(transaction=True)
def test_deadline_failure_does_not_fence_a_lease_that_beat_after_observation(
        stalled_settings, monkeypatch, request):
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=16895)
    _cleanup_production_pool_jobs(request, job_id)
    _enable_test_hard_deadline(monkeypatch, 'uploads.generate_video_poster')
    started = now - timedelta(seconds=2400)
    worker_id = _make_worker(now - timedelta(seconds=61))
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=now - timedelta(seconds=5),
           deadline_at=now - timedelta(seconds=1), started_at=started)

    assert _sweep_with_production_pool()['skipped_fresh_lease'] == 0
    assert QuarantinedJob.objects.get(job_id=job_id).reason == (
        reclaim._deadline_marker_reason(
            JobLease.objects.get(job_id=job_id).token))

    original_apply = reclaim._apply_action_worker_pool
    beat = timezone.now()

    async def beat_then_apply(action, job, **kwargs):
        if action == 'deadline_failed':
            await sync_to_async(lambda: JobLease.objects.filter(
                job_id=job_id).update(last_beat_at=beat))()
        return await original_apply(action, job, **kwargs)

    monkeypatch.setattr(reclaim, '_apply_action_worker_pool', beat_then_apply)
    raced = _sweep_with_production_pool()

    assert raced['gave_up'] == 0
    assert _status(job_id) == 'doing'
    assert JobLease.objects.get(job_id=job_id).last_beat_at == beat

    monkeypatch.setattr(reclaim, '_apply_action_worker_pool', original_apply)
    assert _sweep_with_production_pool()['gave_up_ids'] == [job_id]
    assert _status(job_id) == 'failed'


@pytest.mark.django_db(transaction=True)
def test_deadline_cancel_failure_rolls_back_marker_and_other_rows_continue(
    stalled_settings, monkeypatch, request,
):
    from procrastinate import sql

    now = timezone.now()
    deadline_id = generate_video_poster.defer(generic_file_id=16893)
    _cleanup_production_pool_jobs(request, deadline_id)
    _enable_test_hard_deadline(monkeypatch, 'uploads.generate_video_poster')
    orphan_id = generate_video_poster.defer(generic_file_id=16894)
    _cleanup_production_pool_jobs(request, orphan_id)
    started = now - timedelta(seconds=2400)
    worker_id = _make_worker(now - timedelta(seconds=61))
    _mark_doing(deadline_id, started, worker_id=worker_id)
    _lease(deadline_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=now - timedelta(seconds=5),
           deadline_at=now - timedelta(seconds=1), started_at=started)
    _mark_doing(orphan_id, started)
    _lease(orphan_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=started, started_at=started)

    def fail_cancel(connector):
        execute = connector.execute_query_all_async_with_connection

        async def fail_cancel_query(conn, **kwargs):
            if kwargs.get('query') == sql.queries['cancel_job']:
                raise RuntimeError('injected abort notification failure')
            return await execute(conn, **kwargs)

        monkeypatch.setattr(
            connector, 'execute_query_all_async_with_connection',
            fail_cancel_query)

    summary = _sweep_with_production_pool(configure=fail_cancel)

    assert summary['errors'] == 1
    assert summary['reclaimed_ids'] == [orphan_id]
    assert _status(deadline_id) == 'doing'
    assert not ProcrastinateJob.objects.get(pk=deadline_id).abort_requested
    assert not QuarantinedJob.objects.filter(job_id=deadline_id).exists()
    assert JobLease.objects.filter(job_id=deadline_id).exists()
    assert _status(orphan_id) == 'todo'


@pytest.mark.django_db(transaction=True)
def test_deadline_attempt_change_after_observation_skips_abort(
    stalled_settings, monkeypatch, request,
):
    _enable_test_hard_deadline(monkeypatch, 'uploads.generate_video_poster')
    job_id = generate_video_poster.defer(generic_file_id=16895)
    _cleanup_production_pool_jobs(request, job_id)
    started = timezone.now() - timedelta(seconds=2400)
    worker_id = _make_worker(timezone.now() - timedelta(seconds=5))
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=timezone.now() - timedelta(seconds=5),
           deadline_at=timezone.now() - timedelta(seconds=1),
           started_at=started)
    def change_generation(connector):
        apply = reclaim._apply_row_action

        async def change_then_apply(action, job, **kwargs):
            async with connector.pool.connection() as conn:
                async with conn.transaction():
                    await conn.execute(
                        "UPDATE procrastinate_jobs SET attempts=attempts+1 "
                        "WHERE id=%s", (job.id,))
            return await apply(action, job, **kwargs)

        monkeypatch.setattr(
            reclaim, '_apply_row_action', change_then_apply)

    summary = _sweep_with_production_pool(configure=change_generation)

    assert summary['gave_up'] == 0
    assert _status(job_id) == 'doing'
    assert _attempts(job_id) == 1
    assert not ProcrastinateJob.objects.get(pk=job_id).abort_requested
    assert not QuarantinedJob.objects.filter(job_id=job_id).exists()
    assert JobLease.objects.filter(job_id=job_id).exists()


@pytest.mark.django_db(transaction=True)
def test_deadline_status_change_after_observation_skips_abort(
    stalled_settings, monkeypatch, request,
):
    _enable_test_hard_deadline(monkeypatch, 'uploads.generate_video_poster')
    job_id = generate_video_poster.defer(generic_file_id=16896)
    _cleanup_production_pool_jobs(request, job_id)
    started = timezone.now() - timedelta(seconds=2400)
    worker_id = _make_worker(timezone.now() - timedelta(seconds=5))
    _mark_doing(job_id, started, worker_id=worker_id)
    _lease(job_id, 'uploads.generate_video_poster', 'images',
           last_beat_at=timezone.now() - timedelta(seconds=5),
           deadline_at=timezone.now() - timedelta(seconds=1),
           started_at=started)

    def succeed_before_abort(_connector):
        apply = reclaim._apply_row_action

        async def change_then_apply(action, job, **kwargs):
            await sync_to_async(lambda: ProcrastinateJob.objects.filter(
                pk=job.id).update(status='succeeded'))()
            return await apply(action, job, **kwargs)

        monkeypatch.setattr(reclaim, '_apply_row_action', change_then_apply)

    _sweep_with_production_pool(configure=succeed_before_abort)

    assert _status(job_id) == 'succeeded'
    assert not ProcrastinateJob.objects.get(pk=job_id).abort_requested
    assert not QuarantinedJob.objects.filter(job_id=job_id).exists()
    assert JobLease.objects.filter(job_id=job_id).exists()


@pytest.mark.django_db
def test_the_give_up_line_is_emitted_before_the_row_is_terminalized(
    stalled_settings, caplog, mocker,
):
    """
    Codex round 6. `finish_job(FAILED)` is irreversible and takes the row
    out of `doing`, so after it `job_stuck` no longer reports the job and
    the give-up line is the ONLY signal left -- and one to four
    terminalized posters sit under `job_health`'s failed-recent threshold
    of 5, so nothing else covers them. A pod killed between the commit and
    the log would abandon the job in silence.

    So the line goes out first. Proved by making the write fail: the page
    must already have been emitted, and the row must still be visible.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.reclaim')
    job_id = generate_video_poster.defer(generic_file_id=700)
    _mark_doing(job_id, timezone.now() - timedelta(seconds=2400), attempts=11)

    async def boom(*args, **kwargs):
        raise RuntimeError('pod died mid-write')

    mocker.patch.object(app.job_manager, 'finish_job', side_effect=boom)

    summary = _sweep()

    assert summary['gave_up'] == 0     # the write did not land...
    assert summary['errors'] == 1      #...and that is reported too
    assert _status(job_id) == 'doing'  # still visible to job_stuck
    events = [p['event'] for p in _json_lines(caplog)]
    assert reclaim.GAVE_UP_EVENT in events, (
        'the give-up line was emitted after the terminalizing write, so a '
        'crash in that window loses the only page there is')
    assert events.index(reclaim.GAVE_UP_EVENT) < events.index(
        reclaim.ERROR_EVENT)
