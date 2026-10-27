"""
The per-commit queue smoke, end to end against a REAL worker ( B).

The interesting cases are the ones where the smoke must FAIL and name the
lane: a queue nobody consumes (the row stays in `todo` and the command
times out on it), and a queue consumed by a worker on the wrong commit
(the probe raises inside that worker and the row lands in `failed`). A
smoke that only ever passed would be the vacuous test it exists to
replace.

The worker here is the same subprocess harness the chaos tests use
(`dj.apps.jobs.worker_harness`), started with `BUILD_SHA` in its
environment exactly as `k8s/free2z/worker/worker_deployment.yaml` stamps
it, on two throwaway queue names that no manifest serves -- the smoke's
queue list is an INPUT, and this proves the plumbing with a list of two
rather than pretending a CI runner can stand up every production lane.

UNITS: every duration here is **seconds**.
"""
from __future__ import annotations

import io
import json

import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection

from procrastinate.contrib.django import app
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.jobs import smoke
from dj.apps.jobs.worker_harness import Worker

SHA_A = 'a' * 40
SHA_B = 'b' * 40
QUEUES = ('smoke-a', 'smoke-b')

#How long a fresh worker gets to boot and consume two probes.
CONSUME_SECONDS = 45


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    monkeypatch.setenv("NAMESPACE", "test")
    smoke._reset_reader_for_tests()
    key = smoke.result_cache_key()
    cache.delete(key)
    yield
    cache.delete(key)


@pytest.fixture
def spawn(tmp_path):
    workers: list[Worker] = []

    def _spawn(name: str, build_sha: str, queues=QUEUES) -> Worker:
        worker = Worker(name, tmp_path, queues=queues,
                        extra_env={'BUILD_SHA': build_sha})
        workers.append(worker)
        return worker

    yield _spawn
    for worker in workers:
        worker.close()


def _status(job_id: int) -> str:
    return ProcrastinateJob.objects.get(pk=job_id).status


# ---------------------------------------------------------------------------
# the queue list
# ---------------------------------------------------------------------------



def test_an_empty_manifest_is_refused(tmp_path):
    empty = tmp_path / 'BUILD.bazel'
    empty.write_text('# nothing here\n')
    with pytest.raises(ValueError):
        smoke.manifest_queue_union(empty)
    with pytest.raises(FileNotFoundError):
        smoke.manifest_queue_union(tmp_path / 'missing')


def test_the_probe_is_registered_retryless_on_a_served_queue():
    task = app.tasks[smoke.SMOKE_TASK_NAME]
    assert task.queue == 'default'
    assert task.retry_strategy is None, (
        'a retry could land on a different worker and hide the finding')


# ---------------------------------------------------------------------------
# the probe body
# ---------------------------------------------------------------------------

def test_the_probe_compares_against_the_build_sha_it_was_started_with(
    monkeypatch,
):
    monkeypatch.setenv('BUILD_SHA', SHA_A)
    assert smoke.smoke_probe.func(commit=SHA_A, queue='q')['commit'] == SHA_A
    with pytest.raises(smoke.SmokeCommitMismatch) as exc:
        smoke.smoke_probe.func(commit=SHA_B, queue='billing')
    assert "'billing'" in str(exc.value)
    assert SHA_A in str(exc.value)


def test_an_unstamped_worker_reports_dev_and_fails_a_real_commit(monkeypatch):
    """A misconfigured deploy whose workers lost BUILD_SHA must not pass."""
    monkeypatch.delenv('BUILD_SHA', raising=False)
    with pytest.raises(smoke.SmokeCommitMismatch):
        smoke.smoke_probe.func(commit=SHA_A, queue='q')
    assert smoke.smoke_probe.func(commit='dev', queue='q')['commit'] == 'dev'


# ---------------------------------------------------------------------------
# the result
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_result_round_trips_through_the_cache():
    assert smoke.read_result() is None
    result = smoke.record_result(SHA_A, ['b', 'a'])
    assert result.queues == ('a', 'b')
    assert smoke.read_result() == {
        'commit': SHA_A, 'at': result.at, 'queues': ['a', 'b'],
        'ok': True, 'missing': [], 'namespace': 'test',
        'attempt_id': result.attempt_id, 'status': 'passed'}
    assert smoke.read_result_bounded() == (smoke.read_result(), None)


@pytest.mark.django_db
def test_a_failed_run_supersedes_an_earlier_pass():
    """
    Codex round 2: the key holds the LATEST run. Pass on commit A, then a
    re-run of A loses a lane -- the recorded result must now say so, or
    `verify --commit A` keeps passing for seven days on the stale pass.
    """
    smoke.record_result(SHA_A, ['a', 'b'])
    failed = smoke.record_failure(SHA_A, ['a', 'b'], missing=['b'])
    got = smoke.read_result()
    assert got['ok'] is False
    assert got['missing'] == ['b']
    assert got['at'] == failed.at


@pytest.mark.django_db
def test_recording_is_acknowledged_or_it_raises(monkeypatch):
    """
    Production's cache swallows a refused write (IGNORE_EXCEPTIONS=True), so
    `cache.set` returning is not evidence. The write is read back; a cache
    that dropped it raises, and the command exits 3 rather than 0.
    """
    class _Dropping:
        def set(self, *a, **k):
            return None

        def get(self, *a, **k):
            return None

    monkeypatch.setattr(smoke, 'cache', _Dropping())
    with pytest.raises(smoke.SmokeRecordError):
        smoke.record_result(SHA_A, ['a'])

    class _Raising(_Dropping):
        def set(self, *a, **k):
            raise ConnectionError('redis refused')

    monkeypatch.setattr(smoke, 'cache', _Raising())
    with pytest.raises(smoke.SmokeRecordError):
        smoke.record_result(SHA_A, ['a'])


def test_reading_the_result_fails_open(monkeypatch):
    """/api/healthz calls this; a cache blip must be a null, not a 500."""
    class _Broken:
        def get(self, *a, **k):
            raise ConnectionError('redis is away')

    monkeypatch.setattr(smoke, 'cache', _Broken())
    assert smoke.read_result() is None


def test_garbage_in_the_cache_is_not_a_result():
    cache.set(smoke.result_cache_key(), 'not a dict', 60)
    assert smoke.read_result() is None
    cache.set(smoke.result_cache_key(), {'commit': 1, 'at': 2}, 60)
    assert smoke.read_result() is None
    cache.set(smoke.result_cache_key(),
              {'commit': SHA_A, 'at': 'now', 'queues': 'default', 'ok': True},
              60)
    assert smoke.read_result() is None  # queues must be a list of names
    cache.set(smoke.result_cache_key(),
              {'commit': SHA_A, 'at': 'now', 'queues': ['default']}, 60)
    assert smoke.read_result() is None  # ok is not optional


# ---------------------------------------------------------------------------
# end to end, against a real worker
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_every_lane_consumed_on_the_commit_passes_and_is_recorded(
    spawn, client,
):
    spawn('smoke-1', SHA_A)

    outcome = smoke.run_smoke(SHA_A, QUEUES, timeout_seconds=CONSUME_SECONDS)

    assert outcome.ok, outcome
    assert outcome.succeeded == set(QUEUES)
    for queue, job_id in outcome.job_ids.items():
        row = ProcrastinateJob.objects.get(pk=job_id)
        assert row.queue_name == queue          # routed by.configure(queue=)
        assert row.args == {'commit': SHA_A, 'queue': queue}

    # The command records it, and the health selector exposes it.
    out = io.StringIO()
    call_command('jobs_smoke', commit=SHA_A, queues=','.join(QUEUES),
                 timeout=CONSUME_SECONDS, stdout=out)
    assert 'jobs_smoke: OK' in out.getvalue()
    response = client.get('/api/jobs/smoke')
    payload = json.loads(response.content)
    assert payload['ok'] is True
    assert payload['jobs_smoke']['commit'] == SHA_A
    # The queue set is part of the credential: verify compares it to the
    # manifest union, so a narrowed run cannot pass for a full one.
    assert payload['jobs_smoke']['queues'] == sorted(QUEUES)


@pytest.mark.django_db(transaction=True)
def test_unconsumed_lane_is_named_without_claiming_consumer_failure(spawn):
    """
    The case the smoke exists for: a queue in the manifest that no running
    worker consumes. Its probe never leaves `todo`, the smoke times out,
    and the queue is NAMED -- and the pending row is left where it is, as
    evidence.
    """
    spawn('smoke-1', SHA_A)
    unserved = 'smoke-unserved'

    outcome = smoke.run_smoke(SHA_A, (*QUEUES, unserved), timeout_seconds=8)

    assert not outcome.ok
    assert outcome.pending == {unserved}
    assert outcome.succeeded == set(QUEUES)
    assert _status(outcome.job_ids[unserved]) == 'todo'
    assert smoke.read_result() is None

    # A pass for this commit is on record from before the lane died...
    smoke.record_result(SHA_A, (*QUEUES, unserved))
    err = io.StringIO()
    with pytest.raises(SystemExit) as exc:
        call_command('jobs_smoke', commit=SHA_A,
                     queues=','.join((*QUEUES, unserved)), timeout=8,
                     stdout=io.StringIO(), stderr=err)
    assert exc.value.code == 3
    assert unserved in err.getvalue()
    assert 'INCONCLUSIVE' in err.getvalue()
    # Unconsumed alone is not a failure, but invalidates the earlier pass.
    recorded = smoke.read_result()
    assert recorded['ok'] is None
    assert recorded['missing'] == [unserved]
    assert recorded['status'] == 'inconclusive'
    assert recorded['commit'] == SHA_A


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("shared_consumer", [False, True])
def test_a_lane_busy_with_real_work_is_inconclusive_not_dead(
    spawn, tmp_path, shared_consumer,
):
    """
    Codex round 3. The exports lane legitimately holds a job for up to
    1800s; a probe queued behind it is not evidence of a dead lane. Here a
    real worker on `smoke-busy` is mid-way through a 5s chaos sleep when
    the smoke's 3s wait runs out: the lane is BUSY, the command exits 3,
    and the latest record becomes explicitly inconclusive.
    """
    from dj.apps.jobs.chaos_tasks import chaos_probe

    busy_queue = 'smoke-busy'
    probe_queue = 'smoke-sibling' if shared_consumer else busy_queue
    worker = spawn('smoke-busy-1', SHA_A, queues=tuple({busy_queue, probe_queue}))
    marker = tmp_path / 'marker'
    long_job = chaos_probe.configure(queue=busy_queue).defer(
        mode='sleep', seconds=5, marker=str(marker))
    deadline = __import__('time').monotonic() + CONSUME_SECONDS
    while _status(long_job) != 'doing':
        assert __import__('time').monotonic() < deadline, worker.log()
        __import__('time').sleep(0.1)

    earlier = smoke.record_result(SHA_A, [probe_queue])
    outcome = smoke.run_smoke(SHA_A, [probe_queue], timeout_seconds=3)

    assert not outcome.ok
    assert outcome.pending == {probe_queue}
    if shared_consumer:
        assert outcome.busy == {}
    else:
        assert outcome.busy[busy_queue] == {
            'job_id': long_job, 'task': chaos_probe.name}
    assert outcome.failed == set()

    err = io.StringIO()
    with pytest.raises(SystemExit) as exc:
        call_command('jobs_smoke', commit=SHA_A, queues=probe_queue, timeout=1,
                     stdout=io.StringIO(), stderr=err)
    assert exc.value.code == 3
    assert 'INCONCLUSIVE' in err.getvalue()
    if not shared_consumer:
        assert f'task={chaos_probe.name}' in err.getvalue()
    # Not a failed lane: the newer attempt explicitly remains inconclusive.
    assert smoke.read_result()['attempt_id'] > earlier.attempt_id
    assert smoke.read_result()['ok'] is None
    assert smoke.read_result()['status'] == 'inconclusive'


@pytest.mark.django_db(transaction=True)
def test_a_pass_the_cache_drops_exits_3_not_0(spawn, monkeypatch):
    """The Job must not go green over a result the gate will never see."""
    spawn('smoke-1', SHA_A)

    class _Dropping:
        value = None
        writes = 0

        def set(self, key, value, *a, **k):
            self.writes += 1
            if self.writes == 1:
                self.value = value  # start acknowledged; final verdict dropped

        def get(self, *a, **k):
            return self.value

        def delete(self, *a, **k):
            return None

    monkeypatch.setattr(smoke, 'cache', _Dropping())
    err = io.StringIO()
    with pytest.raises(SystemExit) as exc:
        call_command('jobs_smoke', commit=SHA_A, queues=','.join(QUEUES),
                     timeout=CONSUME_SECONDS, stdout=io.StringIO(),
                     stderr=err)
    assert exc.value.code == 3
    assert 'could NOT be recorded' in err.getvalue()


@pytest.mark.django_db(transaction=True)
def test_a_lane_consumed_by_a_stale_worker_fails_the_smoke(spawn):
    """
    The quiet failure of a half-rolled worker tier: the lane IS consumed,
    promptly, by a worker on the previous commit. Every queue-depth
    signal is green. Only the probe's own BUILD_SHA check sees it.
    """
    spawn('smoke-old', SHA_A)

    outcome = smoke.run_smoke(SHA_B, QUEUES, timeout_seconds=CONSUME_SECONDS)

    assert not outcome.ok
    assert outcome.failed == set(QUEUES)
    assert outcome.pending == set()
    for job_id in outcome.job_ids.values():
        assert _status(job_id) == 'failed'
    assert smoke.read_result() is None
    # A real failed probe has a dedicated process verdict; generic Python
    # startup exit1 must never be interpreted as this observed worker failure.
    with pytest.raises(SystemExit) as exc:
        call_command('jobs_smoke', commit=SHA_B, queues=','.join(QUEUES),
                     timeout=CONSUME_SECONDS, stdout=io.StringIO(),
                     stderr=io.StringIO())
    assert exc.value.code == 10
    assert smoke.read_result()['ok'] is False


# ---------------------------------------------------------------------------
# the command's own guards
# ---------------------------------------------------------------------------

def test_the_command_refuses_a_malformed_commit():
    with pytest.raises(CommandError):
        call_command('jobs_smoke', commit='HEAD', queues='a')
    with pytest.raises(CommandError):
        call_command('jobs_smoke', commit=SHA_A, queues='a', timeout=0)
    with pytest.raises(CommandError):
        call_command('jobs_smoke', commit=SHA_A, queues=' , ')




@pytest.mark.django_db
def test_run_smoke_is_polling_the_real_rows(monkeypatch):
    """No worker: every probe stays `todo`, and the clock is what ends it."""
    now = [0.0]
    polls = []

    def _clock():
        now[0] += 0.7   # each read advances the fake clock
        return now[0]

    outcome = smoke.run_smoke(
        SHA_A, ['x', 'y'], timeout_seconds=2,
        sleep=polls.append, clock=_clock)
    assert outcome.pending == {'x', 'y'}
    assert outcome.busy == {}            # nobody is working those lanes...
    assert outcome.failed == set()  # pending is not independent failure proof
    assert not outcome.ok
    assert polls, 'it never waited between polls'
    assert outcome.elapsed_seconds >= 2
    with connection.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM procrastinate_jobs WHERE task_name=%s "
            "AND status='todo'", [smoke.SMOKE_TASK_NAME])
        assert cur.fetchone()[0] == 2


@pytest.mark.parametrize("selector", ["", "*", "default,-billing", "default,!billing"])
def test_manifest_requires_explicit_positive_queues(tmp_path, selector):
    build = tmp_path / "BUILD.bazel"
    build.write_text('k8s_deploy(\n    substitutions = {"%{QUEUES}": "' + selector + '"},\n)\n')
    with pytest.raises(ValueError, match="explicit positive"):
        smoke.manifest_queue_union(build)


@pytest.mark.django_db
def test_same_commit_smoke_results_are_isolated_by_stamped_namespace(monkeypatch):
    monkeypatch.setenv("NAMESPACE", "stage")
    smoke.record_failure(SHA_A, ["billing"], ["billing"])
    monkeypatch.setenv("NAMESPACE", "prod")
    smoke.record_result(SHA_A, ["billing"])
    monkeypatch.setenv("NAMESPACE", "stage")
    assert smoke.read_result()["ok"] is False


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("newer_ok", [None, False, True])
def test_older_finish_cannot_replace_newer_attempt_on_another_connection(newer_ok):
    from concurrent.futures import ThreadPoolExecutor
    from django.db import connections

    older = smoke.record_result(SHA_A, ["default"], ok=None)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        older_pid = cursor.fetchone()[0]

    def newer_attempt():
        try:
            with connections['default'].cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid = cursor.fetchone()[0]
            return smoke.record_result(SHA_A, ["default"], ok=newer_ok), pid
        finally:
            connections['default'].close()

    with ThreadPoolExecutor(max_workers=1) as pool:
        newer, newer_pid = pool.submit(newer_attempt).result(timeout=10)
    assert newer_pid != older_pid
    assert newer.attempt_id > older.attempt_id
    with pytest.raises(smoke.SmokeRecordError, match="superseded"):
        smoke.record_result(SHA_A, ["default"], attempt_id=older.attempt_id)
    assert smoke.read_result() == newer.as_payload()




def test_missing_namespace_fails_closed(monkeypatch, client):
    monkeypatch.delenv("NAMESPACE", raising=False)
    with pytest.raises(smoke.SmokeRecordError, match="NAMESPACE"):
        smoke.record_result(SHA_A, ["default"])
    payload = client.get("/api/jobs/smoke").json()
    assert payload["jobs_smoke"] is None
    assert payload["namespace"] is None
    assert "NAMESPACE" in payload["degraded"]


@pytest.mark.django_db(transaction=True)
def test_record_lock_timeout_releases_the_failed_transaction(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from django.db import connections, transaction

    monkeypatch.setattr(smoke, "RECORD_LOCK_TIMEOUT", "100ms")

    def blocked_record():
        try:
            with pytest.raises(smoke.SmokeRecordError, match="lock timeout"):
                smoke.record_result(SHA_A, ["default"], ok=None)
        finally:
            connections['default'].close()

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s, hashtext(%s))',
                           [smoke.RECORD_LOCK_CLASS, "test"])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(blocked_record).result(timeout=5)
        assert smoke.read_result() is None
    assert smoke.record_result(SHA_A, ["default"]).ok is True


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('failure_at', ['defer', 'poll'])
def test_command_database_failure_is_inconclusive(monkeypatch, failure_at):
    from django.db import OperationalError
    from procrastinate.exceptions import ConnectorException

    def broken_defer(*args, **kwargs):
        raise ConnectorException('database connection lost during defer')
    if failure_at == 'defer':
        monkeypatch.setattr(smoke, '_defer_probe', broken_defer)

    def broken_poll(execute, sql, params, many, context):
        if (failure_at == 'poll' and sql.lstrip().upper().startswith('SELECT')
                and 'procrastinate_jobs' in sql and '"status"' in sql):
            raise OperationalError('database connection lost during poll')
        return execute(sql, params, many, context)

    err = io.StringIO()
    with connection.execute_wrapper(broken_poll), pytest.raises(SystemExit) as exc:
        call_command('jobs_smoke', commit=SHA_A, queues='test-db-failure',
                     timeout=1, stdout=io.StringIO(), stderr=err)
    assert exc.value.code == 3
    assert 'INCONCLUSIVE' in err.getvalue()
    assert 'FAILED' not in err.getvalue()
    assert smoke.read_result()['ok'] is None
    assert smoke.read_result()['missing'] == ['test-db-failure']


@pytest.mark.django_db(transaction=True)
def test_ignored_redis_read_error_cannot_overwrite_newer_failure(monkeypatch):
    import os
    import uuid
    from django_redis.cache import RedisCache
    from redis.exceptions import ConnectionError

    host = os.environ.get('REDIS_HOST')
    if not host:
        pytest.skip('REDIS_HOST required for real ignored-exception behavior')
    port = os.environ.get('REDIS_PORT', '6379')
    backend = RedisCache(f'redis://{host}:{port}/0', {
        'KEY_PREFIX': f'jobs-smoke-review-{uuid.uuid4().hex}',
        'OPTIONS': {'IGNORE_EXCEPTIONS': True},
    })
    monkeypatch.setattr(smoke, 'cache', backend)
    key = smoke.result_cache_key()
    try:
        smoke.record_result(SHA_A, ['default'], ok=False, attempt_id=20)
        raw = backend.client.get_client(write=True)
        original_get = raw.get
        interrupted = [False]
        def flapping_get(*args, **kwargs):
            if not interrupted[0]:
                interrupted[0] = True
                raise ConnectionError('transient Redis read failure')
            return original_get(*args, **kwargs)
        monkeypatch.setattr(raw, 'get', flapping_get)
        # The configured public API really masks this error as absence.
        assert backend.get(key) is None
        interrupted[0] = False
        with pytest.raises(smoke.SmokeRecordError):
            smoke.record_result(SHA_A, ['default'], ok=True, attempt_id=10)
        assert backend.get(key)['attempt_id'] == 20
        assert backend.get(key)['ok'] is False
        malformed = {'attempt_id': '20'}
        backend.set(key, malformed)
        with pytest.raises(smoke.SmokeRecordError, match='identity is invalid'):
            smoke.record_result(SHA_A, ['default'], attempt_id=10)
        assert backend.get(key) == malformed
    finally:
        backend.delete(key)
        backend.close()


def test_optional_deployment_root_handles_checkout_and_installed_layout(monkeypatch):
    from pathlib import Path

    monkeypatch.delenv("FREE2Z_DEPLOYMENT_ROOT", raising=False)
    assert smoke.repo_root_from(Path("/checkout/py/free2z/dj/apps/jobs/smoke.py")) == Path("/checkout")
    assert smoke.repo_root_from(Path("/py/dj/apps/jobs/smoke.py")) == Path("/")
    monkeypatch.setenv("FREE2Z_DEPLOYMENT_ROOT", "/deployment")
    assert smoke.repo_root_from(Path("/py/dj/apps/jobs/smoke.py")) == Path("/deployment")
