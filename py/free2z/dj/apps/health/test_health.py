"""Guards for the kubelet probe endpoints.

The failure this file exists to prevent: a health endpoint that passes in CI
and 400s/500s in production. Three properties are asserted mechanically
because all three are easy to regress with an innocuous refactor:

1. `/api/healthz` answers 200 anonymously.
2. `/api/healthz` answers 200 with an *unknown Host header* -- kubelet sends
   the pod IP, which is not and cannot be in ALLOWED_HOSTS.
3. `/api/healthz` opens ZERO database connections. A readiness probe that
   touches Postgres de-registers the whole fleet during a database blip.
"""

import json
import threading
import time

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.apps.health import log_filters
from dj.apps.health.middleware import HEALTHZ_PATH

# `client`, `settings` and `db` come from pytest-django.


@pytest.fixture(autouse=True)
def _smoke_namespace(monkeypatch):
    monkeypatch.setenv("NAMESPACE", "test")
    from dj.apps.jobs import smoke
    smoke._reset_reader_for_tests()


@pytest.fixture(autouse=True)
def _clear_readyz_cache():
    """/api/readyz memoizes its DB verdict per process (see views.py).

    Without this the cache leaks across tests: whichever readyz test ran
    first would decide the answer for all the others, and the 503 test would
    pass or fail depending on collection order.
    """
    from dj.apps.health import views

    views._cache.update(checked_at=None, ok=None, error=None)
    yield
    views._cache.update(checked_at=None, ok=None, error=None)


def test_healthz_is_public_and_ok(client):
    response = client.get(HEALTHZ_PATH)

    assert response.status_code == 200, response.content
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == "no-store"

    payload = json.loads(response.content)
    assert payload["ok"] is True
    # Same contract as the SvelteKit /healthz, which CI and the Cloud
    # Monitoring uptime check both content-match on.
    assert "commit" in payload


def test_healthz_accepts_an_unknown_host_header(client, settings):
    """kubelet probes arrive as `Host: <pod-ip>:<port>`.

    ALLOWED_HOSTS cannot enumerate pod IPs, so if HealthCheckMiddleware ever
    stops being ahead of Django's host-validating middleware this returns 400
    and every probe in production fails. The only earlier middleware is the
    database-free exact callback-host boundary. Locking ALLOWED_HOSTS down to
    a single unrelated host makes the test fail the way production would.
    """
    settings.ALLOWED_HOSTS = ["free2z.cash"]

    response = client.get(HEALTHZ_PATH, HTTP_HOST="10.116.3.42:8001")

    assert response.status_code == 200, response.content
    assert json.loads(response.content)["ok"] is True


UPTIME_CHECK_MATCHER = b'"ok":true'


@pytest.mark.parametrize("path", ["/api/healthz", "/api/readyz"])
@pytest.mark.django_db
def test_body_contains_the_literal_uptime_check_matcher(client, path):
    """The Cloud Monitoring uptime checks are SUBSTRING matchers.

    monitoring/uptime-checks/*.json match on the raw bytes `"ok":true`.
    json.dumps' default separators emit `{"ok": true,...}` -- valid JSON,
    200 OK, and a permanently red CRITICAL alert against a perfectly healthy
    backend. Nothing else in CI compares the serialized bytes to the matcher,
    so it is asserted here. (Caught by codex adversarial review,.)
    """
    body = client.get(path).content

    assert UPTIME_CHECK_MATCHER in body, body


@pytest.mark.parametrize("path", ["/api/healthz", "/api/healthz/", "/api/healthz//"])
def test_healthz_tolerates_trailing_slashes(client, path, settings):
    """`/api/healthz/` must not 400.

    Without the rstrip in _short_circuit it falls through to CommonMiddleware,
    which calls get_host() and rejects the kubelet's pod-IP Host header. A
    probe path "tidied" with a trailing slash would then fail 100% of the time
    in prod while a local curl against the real hostname looked perfectly fine.
    """
    settings.ALLOWED_HOSTS = ["free2z.cash"]

    response = client.get(path, HTTP_HOST="10.116.3.42:8001")

    assert response.status_code == 200, (path, response.content)


def test_healthz_middleware_precedes_every_general_middleware():
    """Position is load-bearing, so assert it directly."""
    from django.conf import settings as django_settings

    assert django_settings.MIDDLEWARE[:2] == [
        "dj.apps.ztripe.middleware.NativeCheckoutReturnBoundaryMiddleware",
        "dj.apps.health.middleware.HealthCheckMiddleware"
    ]


@pytest.mark.django_db
def test_healthz_makes_no_database_queries(client):
    with CaptureQueriesContext(connection) as captured:
        response = client.get(HEALTHZ_PATH)

    assert response.status_code == 200
    assert list(captured.captured_queries) == []


async def test_healthz_answers_on_the_asgi_path(async_client):
    """free2z-daphne's probe goes through ASGI, not WSGI.

    asgi.py routes "http" to get_asgi_application(), so the same middleware
    runs -- but via `__acall__`. Without markcoroutinefunction() Django would
    adapt the middleware in a thread and, worse, a refactor that drops the
    async branch would only ever fail on the daphne container in production.
    """
    response = await async_client.get(HEALTHZ_PATH, HTTP_HOST="10.116.3.42:8000")

    assert response.status_code == 200, response.content
    assert json.loads(response.content)["ok"] is True


def test_healthz_rejects_writes(client):
    response = client.post(HEALTHZ_PATH)

    assert response.status_code == 405
    assert response["Allow"] == "GET, HEAD"


def test_healthz_is_not_in_the_openapi_schema(client):
    """It is a probe, not API surface.

    Being served by middleware (not a DRF view) keeps it out of f2z.yaml by
    construction; this asserts the consequence so a future refactor into a
    DRF view does not silently start generating spec drift.
    """
    from django.urls import Resolver404, resolve

    with pytest.raises(Resolver404):
        resolve(HEALTHZ_PATH)


@pytest.mark.django_db
def test_readyz_reports_the_database(client):
    response = client.get("/api/readyz")

    assert response.status_code == 200, response.content
    payload = json.loads(response.content)
    assert payload["ok"] is True
    assert payload["db"] is True
    # @never_cache appends its own directives; no-store is the load-bearing one.
    assert "no-store" in response["Cache-Control"]


@pytest.mark.django_db
def test_readyz_does_query_the_database(client):
    """The counterpart of test_healthz_makes_no_database_queries.

    If this ever drops to zero queries, /api/readyz has quietly become a
    duplicate of /api/healthz and stops meaning anything to monitoring.
    """
    with CaptureQueriesContext(connection) as captured:
        client.get("/api/readyz")

    assert len(captured.captured_queries) >= 1


@pytest.mark.django_db
def test_readyz_returns_503_when_the_database_is_down(client, monkeypatch):
    class Boom:
        def __enter__(self):
            raise RuntimeError("connection refused")

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(
        "dj.apps.health.views.connection.cursor", lambda: Boom())

    response = client.get("/api/readyz")

    assert response.status_code == 503
    payload = json.loads(response.content)
    assert payload["ok"] is False
    assert payload["db"] is False
    # The endpoint is public: report the exception type, never its message.
    assert payload["error"] == "RuntimeError"
    assert "connection refused" not in response.content.decode()


@pytest.mark.django_db
@pytest.mark.django_db
def test_readyz_caches_its_verdict(client):
    """The DB check must run at most once per TTL, whatever the request rate.

    /api/readyz is public and gunicorn has ONE sync worker, so an
    uncached check lets anyone occupy that worker with a curl loop, and makes
    a Cloud SQL outage cost one blocking connection attempt per request.
    """
    with CaptureQueriesContext(connection) as first:
        assert client.get("/api/readyz").status_code == 200
    assert len(first.captured_queries) >= 1

    with CaptureQueriesContext(connection) as rest:
        for _ in range(10):
            assert client.get("/api/readyz").status_code == 200

    assert list(rest.captured_queries) == [], (
        "readyz hit the database again inside the TTL")


@pytest.mark.django_db
def test_readyz_rechecks_after_the_ttl_expires(client, monkeypatch):
    """The cache must not pin a stale verdict forever."""
    from dj.apps.health import views

    assert client.get("/api/readyz").status_code == 200

    # Capture the REAL clock before patching: `views.time` is the same module
    # object this test imported, so a lambda calling time.monotonic() would
    # call itself.
    real_monotonic = time.monotonic
    skew = views._DB_CHECK_TTL_SECONDS + 1
    monkeypatch.setattr(views.time, "monotonic", lambda: real_monotonic() + skew)

    with CaptureQueriesContext(connection) as after:
        assert client.get("/api/readyz").status_code == 200

    assert len(after.captured_queries) >= 1


@pytest.mark.django_db
def test_readyz_rejects_writes(client):
    assert client.post("/api/readyz").status_code == 405


# --- access-log filtering ------------------------------------------------

def _record(message, args=None):
    import logging

    return logging.LogRecord(
        name="gunicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        # logging.LogRecord unwraps a single-Mapping args tuple; passing the
        # dict bare raises KeyError(0) inside LogRecord.__init__.
        args=(args,) if isinstance(args, dict) else args,
        exc_info=None,
    )


@pytest.mark.parametrize("path", sorted(log_filters.PROBE_PATHS))
def test_successful_probe_access_log_lines_are_dropped(path):
    log_filter = log_filters.SuppressProbePaths()

    assert log_filter.filter(_record("%(U)s", {"U": path, "s": "200"})) is False
    assert log_filter.filter(
        _record(f'10.0.0.1 - - "GET {path} HTTP/1.1" 200 24')) is False


@pytest.mark.parametrize("path", sorted(log_filters.PROBE_PATHS))
@pytest.mark.parametrize("status", ["400", "404", "500", "503"])
def test_FAILING_probes_are_always_logged(path, status):
    """The filter must never hide its own failure.

    If someone reorders MIDDLEWARE, every probe starts returning 400 and the
    access log is the first place anyone looks. A filter that dropped probe
    lines regardless of status would make that silent -- the log would show
    a healthy stream of nothing while kubelet restarted containers.
    """
    log_filter = log_filters.SuppressProbePaths()

    assert log_filter.filter(_record("%(U)s", {"U": path, "s": status})) is True
    assert log_filter.filter(
        _record(f'10.0.0.1 - - "GET {path} HTTP/1.1" {status} 9')) is True


def test_unknown_status_is_logged():
    """Fail open: if the status can't be read, keep the line."""
    log_filter = log_filters.SuppressProbePaths()

    assert log_filter.filter(_record("%(U)s", {"U": "/api/healthz"})) is True
    assert log_filter.filter(
        _record("%(U)s", {"U": "/api/healthz", "s": "-"})) is True


def test_real_traffic_is_never_dropped():
    log_filter = log_filters.SuppressProbePaths()

    assert log_filter.filter(
        _record("%(U)s", {"U": "/api/creator/alice/", "s": "200"}))
    # A path that merely starts with a probe path must survive.
    assert log_filter.filter(
        _record("%(U)s", {"U": "/api/healthzzz", "s": "200"}))
    assert log_filter.filter(
        _record('10.0.0.1 - - "GET /api/healthzzz HTTP/1.1" 404 9'))


@pytest.mark.parametrize("outcome", sorted(log_filters.SITEMAP_ACCESS_OUTCOMES))
def test_sitemap_backstop_reuses_the_existing_gunicorn_access_record(outcome):
    log_filter = log_filters.SuppressProbePaths()
    record = _record(
        '%(r)s %(s)s',
        {
            "U": "/api/sitemap/creators/0/revision/",
            "r": "GET /api/sitemap/creators/0/revision/ HTTP/1.1",
            "s": "503" if outcome == "lane_busy" else "409",
            log_filters.SITEMAP_OUTCOME_RESPONSE_ATOM: outcome,
        },
    )

    assert log_filter.filter(record) is True
    assert record.getMessage().endswith(f" sitemap_outcome={outcome}")


def test_unrecognized_response_header_cannot_inject_access_log_fields():
    log_filter = log_filters.SuppressProbePaths()
    record = _record(
        '%(r)s %(s)s',
        {
            "U": "/api/sitemap/creators/0/revision/",
            "r": "GET /api/sitemap/creators/0/revision/ HTTP/1.1",
            "s": "503",
            log_filters.SITEMAP_OUTCOME_RESPONSE_ATOM: "attacker\nERROR injected",
        },
    )

    assert log_filter.filter(record) is True
    assert "sitemap_outcome=" not in record.getMessage()


def test_unhashable_response_header_cannot_break_access_logging():
    log_filter = log_filters.SuppressProbePaths()
    record = _record(
        '%(r)s %(s)s',
        {
            "U": "/api/sitemap/creators/0/revision/",
            "r": "GET /api/sitemap/creators/0/revision/ HTTP/1.1",
            "s": "503",
            log_filters.SITEMAP_OUTCOME_RESPONSE_ATOM: ["lane_busy"],
        },
    )

    assert log_filter.filter(record) is True
    assert "sitemap_outcome=" not in record.getMessage()


def test_probe_path_appearing_elsewhere_in_a_line_is_not_dropped():
    """The message fallback is anchored on the request line, not a substring.

    A real request whose referrer or query string merely contains
    `/api/healthz` must still be logged.
    """
    log_filter = log_filters.SuppressProbePaths()

    assert log_filter.filter(_record(
        '10.0.0.1 - - "GET /api/creator/bob HTTP/1.1" 200 512 '
        '"https://free2z.cash/api/healthz" "Mozilla/5.0"'))


@pytest.mark.parametrize(
    ("path", "query", "location"),
    [
        (
            log_filters.OAUTH_RELAY_PATH,
            "code=secret-code&state=secret-state",
            "cash.free2z.zuuli://oauth/callback?code=secret-code&state=secret-state",
        ),
        (
            log_filters.TWITTER_OAUTH1_CALLBACK_PATH,
            "oauth_token=secret-token&oauth_verifier=secret-verifier",
            "cash.free2z.zuuli://oauth/callback?code=secret-code&state=secret-state",
        ),
        (
            log_filters.TWITTER_OAUTH2_CALLBACK_PATH,
            "code=secret-code&state=secret-state",
            "cash.free2z.zuuli://oauth/callback?code=secret-code&state=secret-state",
        ),
        (
            "/api/stripe/native-return/success/",
            "state=secret-state&session_id=secret-session",
            "cash.free2z.zuuli://checkout/return?code=secret-code",
        ),
        (
            "/api/stripe/native-return/success",
            "state=secret-state&session_id=secret-session",
            "cash.free2z.zuuli://checkout/return?code=secret-code",
        ),
        (
            "/api/stripe/native-return/cancel/",
            "state=secret-state",
            "cash.free2z.zuuli://checkout/return?code=secret-code",
        ),
        (
            "/api/stripe/native-return/cancel",
            "state=secret-state",
            "cash.free2z.zuuli://checkout/return?code=secret-code",
        ),
    ],
)
def test_callback_credentials_are_redacted_from_access_logs(path, query, location):
    log_filter = log_filters.SuppressProbePaths()

    gunicorn = _record("%(r)s %(s)s", {
        "U": path,
        "q": f"?{query}",
        "r": f"GET {path}?{query} HTTP/1.1",
        "{location}o": location,
        "s": "302",
    })
    assert log_filter.filter(gunicorn) is True
    assert "secret" not in str(gunicorn.args)
    assert gunicorn.args["q"] == "?[REDACTED]"
    assert gunicorn.args["{location}o"].endswith("?[REDACTED]")

    daphne = _record(
        f'10.0.0.1 - - "GET {path}?error=access_denied&state=secret HTTP/1.1" 302 0',
    )
    assert log_filter.filter(daphne) is True
    rendered = daphne.getMessage()
    assert "state=secret" not in rendered
    assert f"{path}?[REDACTED]" in rendered


def test_decoded_callback_path_redacts_percent_encoded_raw_gunicorn_atoms():
    log_filter = log_filters.SuppressProbePaths()
    encoded_path = "/api/stripe/native-return/%73uccess/"
    gunicorn = _record("%(r)s %(s)s", {
        "U": "/api/stripe/native-return/success/",
        "q": "?state=secret-state&session_id=secret-session",
        "r": (
            f"GET {encoded_path}?state=secret-state&session_id=secret-session "
            "HTTP/1.1"
        ),
        "{raw_uri}e": (
            f"{encoded_path}?state=secret-state&session_id=secret-session"
        ),
        "s": "200",
    })

    assert log_filter.filter(gunicorn) is True
    assert "secret" not in str(gunicorn.args)
    assert gunicorn.args["q"] == "?[REDACTED]"
    assert gunicorn.args["r"] == (
        f"GET {encoded_path}?[REDACTED] HTTP/1.1"
    )
    assert gunicorn.args["{raw_uri}e"] == f"{encoded_path}?[REDACTED]"












def test_install_is_idempotent():
    import logging

    log_filters._INSTALLED = False
    logger = logging.getLogger("gunicorn.access")
    before = len(logger.filters)
    log_filters.install()
    log_filters.install()

    assert len(logger.filters) == before + 1



def test_healthz_is_fast(client):
    """Not a benchmark, and deliberately not a tight one.

    The real cheapness guarantees are asserted structurally elsewhere: zero
    DB queries, no URL resolution, a constant module-level byte string. What
    this adds on top is an order-of-magnitude tripwire for the one thing
    those cannot see -- a blocking network call or a sleep sneaking into the
    probe path.

    The bound is 1s per request against a true cost in the microseconds, i.e.
    ~5 orders of magnitude of headroom. That is on purpose: a tight bound
    (the first draft used 250ms) is a flaky-CI generator that fails on a
    loaded runner for reasons having nothing to do with this code, and a
    test that cries wolf gets deleted. Anything that makes a probe take a
    second is a real bug and will still be caught.
    """
    start = time.perf_counter()
    for _ in range(20):
        assert client.get(HEALTHZ_PATH).status_code == 200
    elapsed = (time.perf_counter() - start) / 20

    assert elapsed < 1.0, f"healthz averaged {elapsed:.4f}s per request"


def test_healthz_head_has_no_body(client):
    response = client.head(HEALTHZ_PATH)

    assert response.status_code == 200
    assert response.content == b""



# ---------------------------------------------------------------------------
# /api/jobs/smoke -- the last per-commit queue smoke
# ---------------------------------------------------------------------------

JOBS_SMOKE_PATH = "/api/jobs/smoke"


def test_healthz_body_does_not_carry_the_smoke_result(client):
    """
    The kubelet-probe body must stay byte-identical and dependency-free:
    the smoke result lives in the shared Redis cache, and a cache read on
    the probe path would let a hung Redis wedge every pod's sync worker.
    The read lives on its own path instead.
    """
    from dj.apps.health import middleware

    body = client.get(HEALTHZ_PATH).content
    assert body == middleware._BODY
    assert b"jobs_smoke" not in body
    assert b"jobs_smoke" not in client.get(HEALTHZ_PATH + "?jobs_smoke=1").content


@pytest.mark.django_db
def test_jobs_smoke_reports_null_when_nothing_was_recorded(client):
    from django.core.cache import cache
    from dj.apps.jobs import smoke

    cache.delete(smoke.result_cache_key())
    response = client.get(JOBS_SMOKE_PATH)
    assert response.status_code == 200
    assert "max-age=0" in response["Cache-Control"]  # never_cache
    assert "no-store" in response["Cache-Control"]
    payload = json.loads(response.content)
    assert payload["ok"] is True
    assert "commit" in payload
    assert payload["jobs_smoke"] is None
    assert "degraded" not in payload  # a completed read that found nothing


@pytest.mark.django_db
def test_jobs_smoke_reports_the_recorded_commit_and_queues(client):
    from django.core.cache import cache
    from dj.apps.jobs import smoke

    result = smoke.record_result("c" * 40, ["default", "billing"])
    try:
        payload = json.loads(client.get(JOBS_SMOKE_PATH).content)
    finally:
        cache.delete(smoke.result_cache_key())
    assert payload["jobs_smoke"] == {
        "commit": "c" * 40, "at": result.at, "queues": ["billing", "default"],
        "ok": True, "missing": [], "namespace": "test",
        "attempt_id": result.attempt_id, "status": "passed"}
    assert UPTIME_CHECK_MATCHER in client.get(JOBS_SMOKE_PATH).content


@pytest.mark.django_db
def test_jobs_smoke_makes_no_database_queries(client):
    with CaptureQueriesContext(connection) as captured:
        response = client.get(JOBS_SMOKE_PATH)
    assert response.status_code == 200
    assert list(captured.captured_queries) == []


@pytest.mark.django_db
def test_jobs_smoke_fails_open_when_the_cache_raises(client, monkeypatch):
    from dj.apps.jobs import smoke

    class _Broken:
        def get(self, *args, **kwargs):
            raise ConnectionError("redis is away")

    monkeypatch.setattr(smoke, "cache", _Broken())
    response = client.get(JOBS_SMOKE_PATH)
    assert response.status_code == 200
    payload = json.loads(response.content)
    assert payload["jobs_smoke"] is None
    assert "degraded" not in payload  # it answered, with an error -> null


@pytest.mark.django_db
def test_jobs_smoke_is_bounded_when_the_cache_hangs(client, monkeypatch):
    """
    THE finding of the adversarial review. django-redis sets no socket
    timeout, so a blackholed Redis does not raise -- it hangs. The view
    must answer inside its bound with null and say it was cut short, or
    one curl loop could hold the pod's only sync worker for as long as
    Redis stays dark.
    """
    import time as _time
    from dj.apps.jobs import smoke

    released = threading.Event()

    class _Hung:
        def get(self, *args, **kwargs):
            # Long enough to prove the bound, released at teardown so the
            # executor thread does not outlive the test.
            released.wait(5)
            return None

    monkeypatch.setattr(smoke, "cache", _Hung())
    monkeypatch.setattr(smoke, "READ_TIMEOUT_SECONDS", 0.3)
    # A fresh executor: another test's stuck thread must not be ours.
    smoke._reset_reader_for_tests()
    try:
        started = _time.monotonic()
        response = client.get(JOBS_SMOKE_PATH)
        elapsed = _time.monotonic() - started
        # Codex round 2: while that read is still outstanding, later
        # requests must NOT queue another read behind it, and must not
        # each pay the full timeout -- one hung Redis would otherwise cost
        # the pod's only sync worker two seconds per request for the life
        # of the outage.
        started2 = _time.monotonic()
        second = client.get(JOBS_SMOKE_PATH)
        elapsed2 = _time.monotonic() - started2
        assert smoke._reader._work_queue.qsize() == 0, (
            "a second read was queued behind the hung one")
    finally:
        released.set()
    assert response.status_code == 200
    assert elapsed < 2.0, f"the cache read was not bounded ({elapsed:.1f}s)"
    payload = json.loads(response.content)
    assert payload["jobs_smoke"] is None
    assert "did not complete" in payload["degraded"]
    assert second.status_code == 200
    assert elapsed2 < 0.25, f"a follower waited the full timeout ({elapsed2:.2f}s)"
    assert "still outstanding" in json.loads(second.content)["degraded"]
    # Harvest the completed absence, then recover after its short TTL.
    smoke._inflight.result(timeout=5)
    assert client.get(JOBS_SMOKE_PATH).json()["jobs_smoke"] is None
    _time.sleep(smoke.COMPLETED_TTL_SECONDS + 0.05)
    monkeypatch.setattr(smoke, "cache", _RecordingCache())
    payload = json.loads(client.get(JOBS_SMOKE_PATH).content)
    assert "degraded" not in payload
    assert payload["jobs_smoke"]["commit"] == "d" * 40
    smoke._reset_reader_for_tests()


class _RecordingCache:
    """A cache that holds one recorded pass, for the tail of the hang test."""

    def get(self, *args, **kwargs):
        return {"commit": "d" * 40, "at": "later", "queues": ["default"],
                "ok": True, "namespace": "test", "attempt_id": 1, "status": "passed", "missing": []}


@pytest.mark.django_db
def test_jobs_smoke_rejects_writes(client):
    response = client.post(JOBS_SMOKE_PATH)
    assert response.status_code == 405


def test_jobs_smoke_is_a_plain_view_outside_the_openapi_schema():
    """
    Like /api/readyz: a plain Django view, not DRF, so drf-spectacular never
    sees it and f2z.yaml cannot drift because of it. `APIView.as_view()`
    stamps `.cls` on the callable; a plain function has none. (The `backend`
    CI job regenerates f2z.yaml and diffs it, which is the second guard.)
    """
    from django.urls import resolve, reverse

    assert reverse("jobs-smoke") == JOBS_SMOKE_PATH
    match = resolve(JOBS_SMOKE_PATH)
    assert not hasattr(match.func, "cls"), "a DRF view would enter the schema"
    assert not hasattr(match.func, "view_class")


def test_jobs_smoke_reuses_completed_read_until_short_ttl(monkeypatch):
    from dj.apps.jobs import smoke

    calls = []
    now = [10.0]
    monkeypatch.setattr(smoke.time, 'monotonic', lambda: now[0])
    def slow_read():
        time.sleep(0.03)
        calls.append(1)
        return {'attempt_id': len(calls)}
    monkeypatch.setattr(smoke, 'read_result', slow_read)
    smoke._reset_reader_for_tests()
    try:
        for _ in range(5):
            assert smoke.read_result_bounded()[0] == {'attempt_id': 1}
        assert len(calls) == 1
        now[0] += 2
        assert smoke.read_result_bounded()[0] == {'attempt_id': 2}
        monkeypatch.setenv('NAMESPACE', 'other')
        assert smoke.read_result_bounded()[0] == {'attempt_id': 3}
        release = threading.Event()
        def pending_read():
            release.wait(5)
            return {'attempt_id': 4, 'ok': None}
        monkeypatch.setattr(smoke, 'read_result', pending_read)
        now[0] += 2
        try:
            assert smoke.read_result_bounded(timeout_seconds=0)[0] is None
            # No expired pass is served while refresh is outstanding.
            assert smoke.read_result_bounded()[0] is None
        finally:
            release.set()
            smoke._inflight.result(timeout=5)
        assert smoke.read_result_bounded()[0] == {'attempt_id': 4, 'ok': None}
    finally:
        smoke._reset_reader_for_tests()
