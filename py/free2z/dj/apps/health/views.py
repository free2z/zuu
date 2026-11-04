"""`GET /api/readyz` -- dependency check, for MONITORING ONLY.

READ THIS BEFORE POINTING A KUBELET PROBE AT IT. (There is currently no
kubelet probe on this endpoint, and adding one would be a mistake.)

This does one `SELECT 1`. That makes it useful to a human and to Cloud
Monitoring ("is the database reachable from the web tier?") and actively
dangerous to a readinessProbe: every replica shares one Cloud SQL instance,
so a database blip fails this check on *all* pods within one period, empties
the EndpointSlice, and turns a recoverable database hiccup into a total
outage of the site -- including the pages that do not need the database at
all. Kubelet probes use /api/healthz (see middleware.py). This one is for
alerting, where the correct response to "database is down" is to page a
human, not to delete the fleet.

Plain Django view, not DRF: no authentication classes to be exempt from, no
throttle classes to be exempt from, and nothing for drf-spectacular to put in
f2z.yaml.
"""

import json
import threading
import time

from django.db import connection
from django.http import HttpResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe

from dj.apps.health.middleware import BUILD_SHA


def _json(payload: dict, status: int) -> HttpResponse:
    response = HttpResponse(
        # Compact separators: the uptime check content-matches the literal
        # `"ok":true`. See the long note in middleware.py.
        json.dumps(payload, separators=(",", ":")),
        content_type="application/json",
        status=status,
    )
    response["Cache-Control"] = "no-store"
    return response


# How long a DB verdict is reused before another SELECT 1 is run.
#
# THIS IS A SAFETY MECHANISM, NOT A PERFORMANCE OPTIMISATION. /api/readyz is
# public and unauthenticated, and free2z-gunicorn serves it from a SINGLE sync
# worker. Without the cache, every request runs a fresh connection
# attempt on the only worker the pod has, so:
#
#   * anyone can occupy that worker at will just by curl-looping this path --
#     a free DoS amplifier on the API tier, from an endpoint that exists only
#     to help us; and
#   * during a Cloud SQL outage each attempt blocks for however long the
#     driver takes to give up, which is exactly when the pod most needs to
#     keep answering the requests that DON'T need the database.
#
# Caching the verdict bounds the damage to at most one connection attempt per
# process per TTL, regardless of request volume. 15s is well under the
# uptime check's 300s period, so monitoring never sees a stale answer that
# matters, and the alert's own 300s duration dwarfs it.
#
# RESIDUAL, stated honestly: this bounds the FREQUENCY of a blocking attempt,
# not its DURATION. `DATABASES["default"]` sets no `connect_timeout`, so a
# single attempt can still hang for the driver/OS default. Fixing that means
# adding OPTIONS={"connect_timeout": N} to the DATABASES config, which changes
# behaviour for every query in the app -- a deliberate change that does not
# belong in a health-endpoint PR. Tracked with.
_DB_CHECK_TTL_SECONDS = 15

_cache_lock = threading.Lock()
_cache = {"checked_at": None, "ok": None, "error": None}


def _db_ok():
    """(ok, error_type_name). Cached for _DB_CHECK_TTL_SECONDS per process."""
    now = time.monotonic()
    with _cache_lock:
        checked_at = _cache["checked_at"]
        if checked_at is not None and now - checked_at < _DB_CHECK_TTL_SECONDS:
            return _cache["ok"], _cache["error"]

    ok, error = True, None
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception as exc:
        ok, error = False, type(exc).__name__

    with _cache_lock:
        _cache.update(checked_at=time.monotonic(), ok=ok, error=error)
    return ok, error


@never_cache
@require_safe
def readyz(request):
    ok, error = _db_ok()
    if not ok:
        # 503, not 500: this is "dependency unavailable", and the exception
        # text is deliberately not echoed -- the endpoint is public. Only the
        # exception TYPE, which cannot carry a connection string.
        return _json(
            {"ok": False, "commit": BUILD_SHA, "db": False, "error": error},
            503,
        )
    return _json({"ok": True, "commit": BUILD_SHA, "db": True}, 200)


# ---------------------------------------------------------------------------
# /api/jobs/smoke -- the last per-commit queue smoke
# ---------------------------------------------------------------------------
#
# `{"ok":true,"commit":<web BUILD_SHA>,"jobs_smoke":{"commit","at","queues"}}`
# or `"jobs_smoke":null`. It is what `bin/jobs-smoke.sh verify` reads before
# main-integration cuts a promotion tag: the only signal that the WORKER tier
# consumed the commit on every lane (the web tiers prove themselves through
# /healthz and /api/healthz).
#
# A VIEW, NOT A HEALTHZ FIELD, and the reason is the same one that keeps
# /api/readyz off the kubelet path. The result lives in the shared Redis
# cache (prod_settings.CACHES), whose client sets no socket timeouts, so a
# read against a blackholed Redis does not raise -- it hangs. HealthCheck-
# Middleware answers every probe on every pod and is structurally forbidden
# from touching a dependency; an earlier cut of this feature added the read
# there behind a query selector, and the adversarial review pointed out that
# a selector only changes WHO can hang the pod's single sync worker, not
# whether it can be hung. So: its own path, GET-only, and the cache read is
# BOUNDED -- it runs on a one-thread executor and the request waits at most
# JOBS_SMOKE_READ_TIMEOUT_SECONDS for it (smoke.read_result_bounded). A hung
# read costs one background thread that is already stuck, and every later
# request returns `null` immediately instead of joining the queue at Redis.
# Completed verdicts are reused for at most one second; expired passes are
# never served during a refresh. Under ASGI a sync view runs off the event loop.
#
# Public and unauthenticated like /api/readyz, and equally not worth
# throttling: a timed-out read holds nothing but a thread that was going to
# hang anyway, and the executor is one thread wide.


@never_cache
@require_safe
def jobs_smoke(request):
    from dj.apps.jobs import smoke

    try:
        namespace = smoke.stamped_namespace()
    except smoke.SmokeRecordError as exc:
        return _json({"ok": True, "commit": BUILD_SHA, "namespace": None,
                      "jobs_smoke": None, "degraded": str(exc)}, 200)
    result, degraded = smoke.read_result_bounded()
    payload = {"ok": True, "commit": BUILD_SHA, "namespace": namespace,
               "jobs_smoke": result}
    if degraded:
        # Say WHY it is null: "no smoke has run" and "the cache is away" are
        # the same null with different remedies, and verify reports both as
        # inconclusive rather than as a failed lane.
        payload["degraded"] = degraded
    return _json(payload, 200)
