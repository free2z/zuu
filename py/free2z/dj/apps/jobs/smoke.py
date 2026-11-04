"""Verify one real job through every explicitly selected worker queue.

Each probe checks its worker BUILD_SHA against the requested application commit.
Unconsumed queues time out; workers running a different source commit fail the
probe. The queue list comes from deployment configuration, never from the task
registry, so an unserved application queue cannot silently disappear from the
coverage check. Deployed images require explicit --queues. A configured private
checkout may supply the legacy worker manifest for operational callers.

Results are namespaced diagnostic cache records with monotonic attempt IDs.
Acknowledged starts serialize through a short PostgreSQL advisory lock, so an
older attempt cannot overwrite a newer result. This is an observed smoke attempt,
not continuous worker health. All durations are seconds.
"""
from __future__ import annotations

import concurrent.futures
import dataclasses
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable

from django.core.cache import cache
from django.db import connection, transaction
from django.utils import timezone

from procrastinate.contrib.django import app
from zcashrpc.deployment_paths import deployment_root

#The task name, as it appears in ``procrastinate_jobs`` and the policy.
SMOKE_TASK_NAME = 'jobs.smoke_probe'

#Worst-case wall clock of one run; carried by ``reclaim_policy``.
SMOKE_PROBE_MAX_SECONDS = 30

#The cache key ``GET /api/jobs/smoke`` reads.
SMOKE_RESULT_CACHE_KEY = 'jobs:smoke:v2'
RECORD_LOCK_TIMEOUT = '2s'
RECORD_LOCK_CLASS = 17441698  # reserved for this diagnostic; no work/payment rows

#How long ``/api/jobs/smoke`` waits for the cache before answering
#``null``. django-redis sets no socket timeout, so a blackholed Redis
#HANGS a read rather than raising; this is the only bound on it. Well
#above a healthy Redis round trip (sub-millisecond), well below anything
#a caller retries on.
READ_TIMEOUT_SECONDS = 2.0

#How long the recorded result outlives the run. Longer than any gap
#between two promotions; shorter than forever, so a decommissioned
#environment does not report a smoke from last quarter.
SMOKE_RESULT_TTL_SECONDS = 7 * 24 * 3600

#The manifest the queue union is read from, relative to the repo root.
WORKER_BUILD_RELATIVE = Path('k8s') / 'free2z' / 'worker' / 'BUILD.bazel'

#What ``BUILD_SHA`` reports when nothing stamped it -- the same fallback
#``dj.apps.health.middleware`` uses, so a test that runs the probe in a
#plain process passes ``commit='dev'`` and a misconfigured deploy whose
#workers report ``dev`` fails a real smoke, which is the right outcome.
UNSTAMPED_COMMIT = 'dev'

_COMMIT_RE = re.compile(r'^[0-9a-f]{40}$')

# Same shape as test_queue_isolation.py's _RULE_RE / QUEUES parse, and for
# the same reason: bazel does literal string replacement of these values,
# so reading them as text is faithful for exactly this question.
_RULE_RE = re.compile(r'^k8s_deploy\(\s*$\n((?:.*\n)*?)^\)\s*$', re.MULTILINE)
_QUEUES_RE = re.compile(r'"%\{QUEUES\}"\s*:\s*"([^"]*)"')


class SmokeCommitMismatch(RuntimeError):
    """The worker that consumed the probe is not on the promoted commit."""


class SmokeRecordError(RuntimeError):
    """The cache did not acknowledge the result write (see record_result)."""


def split_queues(value: str) -> set[str]:
    """procrastinate's own ``cast_queues``: split, strip, drop empties."""
    return {q.strip() for q in value.split(',') if q.strip()}


def manifest_queue_union(build_file: Path) -> set[str]:
    """
    Every queue any worker target in ``build_file`` consumes.

    Raises ``FileNotFoundError`` if the manifest is not there (the deployed
    image) and ``ValueError`` if it parses to nothing -- an empty smoke
    that passes would be the vacuous test this module exists to replace.
    """
    text = Path(build_file).read_text(encoding='utf-8')
    queues: set[str] = set()
    targets = 0
    for match in _RULE_RE.finditer(text):
        body = match.group(1)
        for value in _QUEUES_RE.findall(body):
            lanes = split_queues(value)
            if not lanes or any(
                re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]*', lane) is None
                for lane in lanes
            ):
                raise ValueError(
                    f'{build_file} must name explicit positive queues; '
                    f'unsupported selector {value!r}')
            targets += 1
            queues |= lanes
    if not targets or not queues:
        raise ValueError(
            f'{build_file} yielded no %{{QUEUES}} substitution; refusing to '
            'run a smoke over an empty lane list')
    return queues


def repo_root_from(here: Path | None = None) -> Path:
    """Locate optional deployment configuration independently of install depth."""
    return deployment_root(here or Path(__file__))


def is_commit(value: str) -> bool:
    return value == UNSTAMPED_COMMIT or bool(_COMMIT_RE.match(value))


@app.task(name=SMOKE_TASK_NAME, queue='default', retry=False)
def smoke_probe(commit: str, queue: str) -> dict[str, Any]:
    """
    Prove that THIS worker process, on THIS queue, is on ``commit``.

    ``queue`` is carried in the args only so the row is self-describing
    in ``procrastinate_jobs`` and in the failure message; the row's own
    ``queue_name`` is what actually routed it. ``retry=False``: a probe
    that fails is the finding, and a retry could only land on a different
    worker and hide it.
    """
    running = os.environ.get('BUILD_SHA') or UNSTAMPED_COMMIT
    if running != commit:
        raise SmokeCommitMismatch(
            f'queue {queue!r} was consumed by a worker on BUILD_SHA='
            f'{running!r}, not the promoted commit {commit!r}')
    return {'commit': commit, 'queue': queue, 'pid': os.getpid()}


def stamped_namespace() -> str:
    namespace = os.environ.get('NAMESPACE', '')
    if re.fullmatch(r'[a-z][a-z0-9-]{0,62}', namespace) is None:
        raise SmokeRecordError('NAMESPACE must be explicitly stamped for queue smoke')
    return namespace


def result_cache_key() -> str:
    return f'{SMOKE_RESULT_CACHE_KEY}:{stamped_namespace()}'


@dataclasses.dataclass(frozen=True)
class JobsSmokeResult:
    commit: str
    queues: tuple[str, ...]
    at: str
    namespace: str
    attempt_id: int
    ok: bool | None = True
    missing: tuple[str, ...] = ()

    def as_payload(self) -> dict[str, Any]:
        state = 'inconclusive' if self.ok is None else ('passed' if self.ok else 'failed')
        return {'commit': self.commit, 'queues': list(self.queues), 'at': self.at,
                'namespace': self.namespace, 'attempt_id': self.attempt_id,
                'status': state, 'ok': self.ok, 'missing': list(self.missing)}


def _read_record_strict(key):
    # django-redis's cache.get masks connection errors when production enables
    # IGNORE_EXCEPTIONS (even with a sentinel default). Its public client keeps
    # key/version/serialization handling but propagates those failures. Other
    # supported cache backends do not have that swallowing wrapper.
    client = getattr(cache, 'client', None)
    return client.get(key) if client is not None else cache.get(key)


def record_result(commit: str, queues: Iterable[str], *, ok: bool | None = True,
                  missing: Iterable[str] = (), attempt_id: int | None = None) -> JobsSmokeResult:
    """Record only this diagnostic's newest attempt under its stamped namespace.

    The existing job sequence orders starts without a new row or migration.
    A transaction advisory lock serializes cooperating recorders across processes,
    before cache read/compare/write. lock_timeout bounds lock acquisition only;
    Redis I/O can still stall until the detached Job's outer deadline kills it.
    The lock is released on every transaction exit or connection death.
    """
    namespace = stamped_namespace()
    key = result_cache_key()
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                if attempt_id is None:
                    cursor.execute("SELECT nextval(pg_get_serial_sequence('procrastinate_jobs', 'id'))")
                    attempt_id = cursor.fetchone()[0]
                cursor.execute("SELECT set_config('lock_timeout', %s, true)", [RECORD_LOCK_TIMEOUT])
                cursor.execute('SELECT pg_advisory_xact_lock(%s, hashtext(%s))',
                               [RECORD_LOCK_CLASS, namespace])
            current = _read_record_strict(key)
            if current is not None:
                current_id = current.get('attempt_id') if isinstance(current, dict) else None
                if type(current_id) is not int or current_id < 1:
                    raise SmokeRecordError('the stored smoke attempt identity is invalid')
                if current_id > attempt_id:
                    raise SmokeRecordError('this smoke attempt was superseded by a newer attempt')
            result = JobsSmokeResult(
                commit=commit, queues=tuple(sorted(set(queues))),
                at=timezone.now().isoformat(), namespace=namespace,
                attempt_id=attempt_id, ok=ok, missing=tuple(sorted(set(missing))))
            payload = result.as_payload()
            cache.set(key, payload, SMOKE_RESULT_TTL_SECONDS)
            if _read_record_strict(key) != payload:
                raise SmokeRecordError('the cache did not acknowledge the smoke result write')
            return result
    except SmokeRecordError:
        raise
    except Exception as exc:
        raise SmokeRecordError(f'could not record smoke result: {type(exc).__name__}: {exc}') from exc


def record_failure(commit: str, queues: Iterable[str], missing: Iterable[str],
                   *, attempt_id: int | None = None) -> JobsSmokeResult:
    return record_result(commit, queues, ok=False, missing=missing, attempt_id=attempt_id)


def read_result() -> dict[str, Any] | None:
    """Read only this environment's valid evidence; request callers bound Redis I/O."""
    try:
        namespace = stamped_namespace()
        payload = cache.get(result_cache_key())
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get('namespace') != namespace:
        return None
    if type(payload.get('attempt_id')) is not int or payload['attempt_id'] < 1:
        return None
    if not isinstance(payload.get('commit'), str) or not isinstance(payload.get('at'), str):
        return None
    ok = payload.get('ok')
    if ok is not None and not isinstance(ok, bool):
        return None
    state = 'inconclusive' if ok is None else ('passed' if ok else 'failed')
    if 'ok' not in payload or payload.get('status') != state:
        return None
    for field in ('queues', 'missing'):
        if not isinstance(payload.get(field), list) or not all(isinstance(q, str) for q in payload[field]):
            return None
    return {**payload, 'queues': sorted(payload['queues']), 'missing': sorted(payload['missing'])}


# ONE thread and AT MOST ONE OUTSTANDING READ per process (codex round 2).
# A hung read holds the thread; while it is outstanding, every later request
# is answered immediately with a "still outstanding" reason instead of being
# queued behind it -- so a blackholed cache costs this process one stuck
# thread and ONE request's worth of waiting, not two seconds of the pod's
# only sync worker per request for the life of the outage, and the executor
# never accumulates a backlog. What is NOT bounded here is the Redis socket
# itself: django-redis is configured with no socket timeout in
# prod_settings.CACHES, and changing that is a cache-wide decision (every
# throttle read shares it), not this feature's.
_reader_lock = threading.Lock()
_reader: concurrent.futures.ThreadPoolExecutor | None = None
_inflight: concurrent.futures.Future | None = None
_inflight_namespace: str | None = None
_completed = None
COMPLETED_TTL_SECONDS = 1.0

# Completed verdicts, including absence, are reused for at most one second.
# This bounds sequential slow-cache amplification; expired verdicts are never
# served while refresh is outstanding. Shared attempt ordering remains exact,
# but an HTTP reader may observe its previous verdict for this explicit TTL.


def _executor() -> concurrent.futures.ThreadPoolExecutor:
    global _reader
    if _reader is None:
        _reader = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix='jobs-smoke-read')
    return _reader


def _reset_reader_for_tests() -> None:
    global _reader, _inflight, _inflight_namespace, _completed
    with _reader_lock:
        _reader = None
        _inflight = None
        _inflight_namespace = None
        _completed = None


def _read_result_timed():
    result = read_result()
    return time.monotonic(), result


def read_result_bounded(
    timeout_seconds: float | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """
    ``read_result()`` with a deadline and a single-flight gate. Returns
    ``(result, degraded)``: ``degraded`` is ``None`` on a completed read
    (whatever it found) and a short reason when this request could not get
    an answer -- so the caller can tell "nothing recorded" from "could not
    ask".
    """
    global _inflight, _inflight_namespace, _completed
    try:
        namespace = stamped_namespace()
    except SmokeRecordError:
        return None, 'queue smoke namespace is not configured'
    timeout = READ_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
    with _reader_lock:
        if (_completed is not None and _completed[0] == namespace
                and time.monotonic() - _completed[1] < COMPLETED_TTL_SECONDS):
            return _completed[2], None
        future = _inflight
        if future is not None and not future.done():
            return None, 'a cache read is still outstanding; the cache is not answering'
        if future is not None and _inflight_namespace == namespace:
            completed_at, result = future.result()
            _inflight = None
            if time.monotonic() - completed_at < COMPLETED_TTL_SECONDS:
                _completed = (namespace, completed_at, result)
                return result, None
        future = _executor().submit(_read_result_timed)
        _inflight = future
        _inflight_namespace = namespace
    try:
        completed_at, result = future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        return None, f'cache read did not complete within {timeout:g}s'
    with _reader_lock:
        if _inflight is future:
            _completed = (namespace, completed_at, result)
            _inflight = None
    return result, None


@dataclasses.dataclass
class SmokeOutcome:
    commit: str
    queues: tuple[str, ...]
    job_ids: dict[str, int]
    succeeded: set[str]
    failed: set[str]
    pending: set[str]
    #Pending lanes on which some OTHER job was in `doing` when the wait
    #ran out -- a consumer exists and is busy (an export can legitimately
    #hold its lane for 1800s), so "not consumed in time" is NOT evidence
    #of a dead lane there (codex round 3). queue -> {job_id, task}.
    busy: dict[str, dict[str, Any]]
    elapsed_seconds: float

    @property
    def ok(self) -> bool:
        return not self.failed and not self.pending



def _defer_probe(commit: str, queue: str) -> int:
    # `.configure(queue=...)` is procrastinate's supported way to route one
    # task onto a queue other than its declared one; the declared queue is
    # `default` only so the registry contract (every declared queue is
    # served) holds.
    return smoke_probe.configure(queue=queue).defer(commit=commit, queue=queue)


def run_smoke(
    commit: str,
    queues: Iterable[str],
    *,
    timeout_seconds: float,
    poll_seconds: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> SmokeOutcome:
    """
    Defer one probe per queue, then poll until every row is terminal or
    ``timeout_seconds`` pass. Never cancels a pending row on the way out:
    a probe stuck in ``todo`` on an unserved lane is the evidence, and the
    ordinary ``todo_overdue`` health alert on that queue is the second
    signal that the lane is dead.
    """
    from procrastinate.contrib.django.models import ProcrastinateJob

    queues = tuple(sorted(set(queues)))
    if not queues:
        raise ValueError('refusing to smoke an empty queue list')
    job_ids = {queue: _defer_probe(commit, queue) for queue in queues}
    by_id = {job_id: queue for queue, job_id in job_ids.items()}

    started = clock()
    deadline = started + float(timeout_seconds)
    succeeded: set[str] = set()
    failed: set[str] = set()
    while True:
        rows = ProcrastinateJob.objects.filter(
            id__in=list(by_id)).values_list('id', 'status')
        for job_id, status in rows:
            queue = by_id[job_id]
            if status == 'succeeded':
                succeeded.add(queue)
            elif status in ('failed', 'cancelled', 'aborted'):
                failed.add(queue)
        pending = set(queues) - succeeded - failed
        if not pending or clock() >= deadline:
            break
        sleep(poll_seconds)

    busy: dict[str, dict[str, Any]] = {}
    if pending:
        # Is anyone working that lane? A `doing` row of another job on a
        # pending queue means a consumer exists and is mid-job; our probe is
        # queued behind it, and the honest verdict is "ask again later".
        rows = ProcrastinateJob.objects.filter(
            queue_name__in=sorted(pending), status='doing',
        ).exclude(id__in=list(by_id)).order_by('id').values_list(
            'queue_name', 'id', 'task_name')
        for queue, job_id, task in rows:
            busy.setdefault(queue, {'job_id': job_id, 'task': task})

    return SmokeOutcome(
        commit=commit,
        queues=queues,
        job_ids=job_ids,
        succeeded=succeeded,
        failed=failed,
        pending=pending,
        busy=busy,
        elapsed_seconds=clock() - started,
    )
