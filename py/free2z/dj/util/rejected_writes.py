"""One structured log line per rejected API write.

Before this, a 4xx on ``POST /api/zpage/`` left exactly two traces: Django's
``Bad Request: /api/zpage/`` (the ``django.request`` logger) and the load
balancer's status + byte count. The failed-write runbook
(``monitoring/alert-policies/prod-write-5xx-repeat-client.json``) told the
responder to "read the 400 body in the gunicorn log", which was never there;
's cause had to be reverse-engineered from a 93-byte response size.

This middleware emits ONE line of JSON (``event=write_rejected``, severity
WARNING -- a 4xx is the client's problem, not ours, and ERROR would put it in
Error Reporting) for every 4xx answered to a POST/PUT/PATCH/DELETE under
``/api/`` or ``/uploads/`` on a route that resolved. It carries:

* ``method``, ``status``;
* ``route`` -- the URL *pattern* (``api/zpage/(?P<pk>[^/.]+)/$``), never the raw
  path, because some paths carry secrets (the password-reset confirm route
  has the uid and token in it, ) -- and ``view`` (the URL name);
* ``errors`` -- ``{"<field path>": ["<code>",...]}`` built from DRF's
  ``ErrorDetail.code`` values in the response body. Keys and codes ONLY. A
  leaf that is not an ``ErrorDetail`` (a plain string, a number) is recorded
  as ``"?"``: we do not know it is safe, so its content is never read;
* ``user_id`` when the request was authenticated;
* ``logging.googleapis.com/trace`` from ``X-Cloud-Trace-Context`` (or W3C
  ``traceparent``). The GCLB request log carries the same trace, so the two
  entries join exactly, with no timestamp/IP guesswork.

PRIVACY is the design constraint, not an afterthought. Nothing here reads the
request body, a submitted value, an error MESSAGE (DRF messages can echo the
input: "'<value>' is not a valid choice"), query string, header other than
the trace id, or path kwargs. Only root-level keys (declared serializer field
names) are logged, and only when identifier-shaped (else ``?``); every key
below the root is ``*``, because a ``DictField``/``JSONField`` error is keyed
by user input and no spelling rule can tell that from a field name.

SIZE is bounded by construction: at most ``MAX_ENTRIES`` field paths, each at
most ``MAX_PATH_CHARS``, with at most ``MAX_CODES`` codes of at most
``MAX_CODE_CHARS``; ``errors_truncated`` says when anything was dropped.

It must never change the response. Any failure while building the line is
swallowed (the request already has its answer; a logging bug must not turn a
400 into a 500).
"""
from __future__ import annotations

import json
import logging
import re

from django.conf import settings
from django.utils.functional import SimpleLazyObject, empty
from rest_framework.exceptions import ErrorDetail

logger = logging.getLogger(__name__)

#Cloud Logging ``jsonPayload.event``. Contract with the runbook in
#monitoring/README.md and the repeat-client alert policy documentation.
EVENT = "write_rejected"

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
PATH_PREFIXES = ("/api/", "/uploads/")

MAX_ENTRIES = 16
MAX_DEPTH = 4
MAX_CODES = 4
MAX_PATH_CHARS = 96
MAX_CODE_CHARS = 48
MAX_ROUTE_CHARS = 200

#Printed for a leaf whose content we will not read (not an ErrorDetail).
UNKNOWN_CODE = "?"

_SAFE_KEY = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_SAFE_CODE = re.compile(r"^[A-Za-z0-9_\-.]+$")
_CLOUD_TRACE = re.compile(r"^([0-9a-fA-F]{32})(?:/|$)")
_TRACEPARENT = re.compile(r"^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$")

def _safe_key(key) -> str:
    text = str(key)
    return text if _SAFE_KEY.match(text) else "?"


def _code_of(leaf) -> str:
    if isinstance(leaf, ErrorDetail):
        code = leaf.code
        if isinstance(code, str) and _SAFE_CODE.match(code):
            return code[:MAX_CODE_CHARS]
    return UNKNOWN_CODE


def error_codes(data):
    """Flatten a DRF error body into ``({path: [codes]}, truncated)``.

    Reads dict keys and ``ErrorDetail.code`` only -- never a string's content.
    """
    out: dict[str, list[str]] = {}
    truncated = False

    def add(path, code):
        nonlocal truncated
        path = path or "_body"
        if len(path) > MAX_PATH_CHARS:
            path = path[:MAX_PATH_CHARS]
            truncated = True
        codes = out.get(path)
        if codes is None:
            if len(out) >= MAX_ENTRIES:
                truncated = True
                return
            codes = out[path] = []
        if len(codes) >= MAX_CODES:
            truncated = True
            return
        codes.append(code)

    def walk(node, path, depth, top):
        nonlocal truncated
        if depth > MAX_DEPTH:
            truncated = True
            return
        if isinstance(node, dict):
            for key, value in node.items():
                # Only the ROOT level's keys are known to be declared field
                # names. Below that a key may be user data (a DictField keyed
                # by input, a JSONField), and no spelling rule can tell a
                # nested serializer's field name from a secret that happens
                # to look like one -- so nested keys are always "*".
                child = _safe_key(key) if top else "*"
                walk(value, f"{path}.{child}" if path else child, depth + 1,
                     False)
        elif isinstance(node, (list, tuple)):
            for index, value in enumerate(node):
                if isinstance(value, (dict, list, tuple)):
                    # A list index keeps ``top``: ``many=True`` errors are a
                    # list of per-item dicts keyed by declared field names.
                    walk(value, f"{path}.{index}" if path else str(index),
                         depth + 1, top)
                else:
                    add(path, _code_of(value))
        else:
            add(path, _code_of(node))

    walk(data, "", 0, True)
    return out, truncated


def _resolved_user(request):
    """``request.user`` only if something ALREADY resolved it, else None.

    ``AuthenticationMiddleware`` installs a lazy object; touching it loads the
    session. A write refused BEFORE authentication (the zauth admission
    throttle's 429) must stay a request that never looked a session up
    (``test_real_redis_forged_session_lookup_happens_only_after_admission``),
    so a logging line must not be the thing that forces it. DRF replaces the
    lazy object with the real user once it authenticates.
    """
    user = request.__dict__.get("user")
    if isinstance(user, SimpleLazyObject) and user._wrapped is empty:
        return None
    return user


def trace_id(request) -> str | None:
    header = request.META.get("HTTP_X_CLOUD_TRACE_CONTEXT", "")
    match = _CLOUD_TRACE.match(header)
    if match:
        return match.group(1).lower()
    match = _TRACEPARENT.match(request.META.get("HTTP_TRACEPARENT", ""))
    if match and match.group(1) != "0" * 32:
        return match.group(1)
    return None


def rejected_write_payload(request, response):
    """The log payload for this request/response, or None when not in scope."""
    if request.method not in WRITE_METHODS:
        return None
    if not 400 <= response.status_code < 500:
        return None
    if not request.path.startswith(PATH_PREFIXES):
        return None
    match = getattr(request, "resolver_match", None)
    if match is None:
        # URL-level 404: a scanner probing a route that does not exist. The
        # raw path is the only thing we could log, and a raw path is exactly
        # what this line must never carry.
        return None

    route = (match.route or "")[:MAX_ROUTE_CHARS]
    payload = {
        "severity": "WARNING",
        "message": f"write rejected: {request.method} {route} {response.status_code}",
        "event": EVENT,
        "method": request.method,
        "route": route,
        "view": match.view_name or None,
        "status": response.status_code,
    }
    data = getattr(response, "data", None)
    if data is not None:
        errors, truncated = error_codes(data)
        payload["errors"] = errors
        if truncated:
            payload["errors_truncated"] = True

    user = _resolved_user(request)
    if user is not None and getattr(user, "is_authenticated", False):
        payload["user_id"] = user.pk

    trace = trace_id(request)
    if trace:
        payload["trace_id"] = trace
        # Same format as the GCLB request log's ``trace`` field, so the two
        # entries join on it (and Logs Explorer links them).
        project = getattr(settings, "PROJECT_ID", "free2z")
        payload["logging.googleapis.com/trace"] = (
            f"projects/{project}/traces/{trace}")
    return payload


class RejectedWriteLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        try:
            payload = rejected_write_payload(request, response)
            if payload is not None:
                logger.warning(json.dumps(
                    payload, default=str, separators=(",", ":")))
        except Exception:  # noqa: BLE001 -- see module docstring
            pass
        return response
