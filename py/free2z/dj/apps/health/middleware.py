"""`GET /api/healthz` -- the cheapest possible "this process can serve".

Why a middleware and not a view (this is the whole point of the file):

* **It runs before `ALLOWED_HOSTS`.** kubelet sends `Host: <pod-ip>:<port>`
  and there is no way to add pod IPs to `ALLOWED_HOSTS`. Every middleware
  below `SecurityMiddleware`/`CommonMiddleware` is reached only *after*
  `request.get_host()` has validated the Host header, so a health *view*
  answers `400 Bad Request` to every probe in production while passing every
  test that uses `testserver` (verified empirically against Django 5.2.7 in
  the review of ). The conventional fix is to override the probe's Host
  via `httpGet.httpHeaders`, so this is a footgun rather than an
  impossibility -- but the footgun is silent, remote, and 100% fatal, and
  the manifest is far from the code. Sitting first in `MIDDLEWARE` and never
  calling `get_host()` makes it structurally impossible instead of
  correctly-configured, and buys a second property for free: the endpoint
  still answers when the URLconf or the app registry is broken, which is
  exactly the failure it exists to report.
* **It runs before auth, sessions, CSRF, CORS and URL resolution.** There is
  no authentication to be exempt from, no throttle to be exempt from, and no
  DRF view to be documented in the OpenAPI spec. The guarantees are
  structural rather than a list of decorators someone can regress.
* **It cannot touch the database.** A kubelet probe that queries Postgres
  fails on every pod at once during a Cloud SQL blip and converts a
  recoverable database hiccup into a guaranteed total outage. If you want a
  dependency check, that is `/api/readyz` (see views.py) and it belongs to
  monitoring, not to kubelet.

Contract matches the SvelteKit `/healthz` (ts/svelte/free2z/src/routes/
healthz/+server.ts) so CI and monitoring have exactly one shape to assert:
`{"ok":true,"commit":"<sha>"}`.
"""

import json
import os
from asgiref.sync import iscoroutinefunction, markcoroutinefunction

from django.http import HttpResponse

from dj.apps.health import log_filters

HEALTHZ_PATH = "/api/healthz"

# Same contract as the SvelteKit /healthz.
#
# BUILD_SHA IS NOW WIRED. k8s/free2z/deployment.yaml stamps it into
# both Django containers as `%{FREE2Z_TAG}`, which bazel substitutes with
# bin/bazel-apply.sh's `--define=FREE2Z_TAG=$COMMIT_SHA`. The old comment here
# said this could not be honoured because the image is deployed by digest
# from a `:latest` tag -- true of the IMAGE, irrelevant to the ENV VAR, and
# the confusion cost the deploy gate a whole tier: /api/healthz reported
# "dev", so main-integration could only ever prove the SvelteKit tier was
# serving the commit under test and the smoke could silently run against the
# previous backend revision.
#
# "dev" remains the fallback and it is load-bearing in two places: local
# development and the test suite, where no substitution has happened. It is
# also what a MISCONFIGURED deploy reports -- and the promotion gate treats
# that as "not the commit I asked for" and times out rather than promoting,
# because bin/wait-for-healthz-commit.sh accepts only 40 lowercase hex chars.
BUILD_SHA = os.environ.get("BUILD_SHA") or "dev"

# Serialized once at import: the response is a constant, so there is no
# reason to pay for json.dumps on every probe.
#
# separators=(",", ":") is LOAD-BEARING, not cosmetic. The Cloud Monitoring
# uptime checks content-match on the literal substring `"ok":true`
# (monitoring/uptime-checks/*.json) -- json.dumps' default separator is
# ", " / ": ", which emits `{"ok": true,...}` and never matches. The check
# would then fail from all four regions against a perfectly healthy backend
# and page forever. Asserted in test_health.py against the literal string.
_BODY = json.dumps(
    {"ok": True, "commit": BUILD_SHA,
     "deployment_commit": os.environ.get("DEPLOYMENT_SHA") or "dev",
     "release_id": os.environ.get("APP_RELEASE_ID") or "dev"}, separators=(",", ":")).encode()


def _healthz_response(include_body: bool = True) -> HttpResponse:
    response = HttpResponse(
        _BODY if include_body else b"",
        content_type="application/json",
        # 204 would be cheaper still, but the body is what lets the GCLB /
        # Cloud Monitoring uptime checks content-match on `"ok":true`, the
        # same assertion they already make against the SvelteKit /healthz.
        status=200,
    )
    response["Cache-Control"] = "no-store"
    return response


class HealthCheckMiddleware:
    """Answer /api/healthz before anything else in the stack can fail."""

    sync_capable = True
    async_capable = True

    def __init__(self, get_response):
        self.get_response = get_response
        self._async = iscoroutinefunction(get_response)
        if self._async:
            markcoroutinefunction(self)
        # Once per worker process, after gunicorn/daphne configured logging.
        log_filters.install()

    def _short_circuit(self, request):
        # request.path is derived from PATH_INFO; it never reads the Host
        # header, so nothing here can trip ALLOWED_HOSTS.
        #
        # Trailing slashes are stripped so `/api/healthz/` is answered too.
        # Not cosmetic: without it that spelling falls through to
        # CommonMiddleware, which calls get_host() and returns 400 for a
        # kubelet probe (Host is the pod IP). A probe path "tidied" with a
        # trailing slash would then fail 100% of the time while every local
        # curl against the real hostname looked fine. Cheap to make
        # impossible; expensive to debug at 3am.
        if request.path.rstrip("/") != HEALTHZ_PATH:
            return None
        if request.method not in ("GET", "HEAD"):
            response = HttpResponse(status=405)
            response["Allow"] = "GET, HEAD"
            return response
        return _healthz_response(include_body=request.method == "GET")

    def __call__(self, request):
        if self._async:
            return self.__acall__(request)
        response = self._short_circuit(request)
        if response is not None:
            return response
        return self.get_response(request)

    async def __acall__(self, request):
        response = self._short_circuit(request)
        if response is not None:
            return response
        return await self.get_response(request)
