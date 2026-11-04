"""Keep probe noise and OAuth credentials out of application access logs.

Two sources, neither of them interesting: the Cloud Monitoring uptime checks
hit /api/healthz every 60s from four regions (plus /api/readyz every 300s),
forever; and each container's startupProbe polls every 5s while it boots. On
a five-replica deploy that is a steady drip of successful 200s that drowns
the lines that matter when you are tailing logs during an incident.

`install()` attaches a filter to the *logger objects* gunicorn and daphne
already use, rather than reconfiguring logging via dictConfig. That is the
low-blast-radius choice on purpose: dictConfig would replace the handlers
gunicorn set up from `--access-logfile=-` and could silently redirect (or
lose) every access log line in production. Adding a filter to a logger only
ever removes the records it matches.

Called from HealthCheckMiddleware.__init__, i.e. once per worker process,
after gunicorn/daphne have configured their own logging. A no-op under
`manage.py runserver` and pytest, where those loggers have no handlers.
"""

import logging
import re

# Paths whose access-log lines are suppressed. Exact matches only; a
# substring match would swallow real traffic to e.g. /api/healthzzz.
PROBE_PATHS = frozenset({"/api/healthz", "/api/readyz"})
OAUTH_RELAY_PATH = "/api/auth/social/mobile/callback"
TWITTER_OAUTH1_CALLBACK_PATH = "/api/twitter/v1/access-token"
TWITTER_OAUTH2_CALLBACK_PATH = "/api/twitter/callback"
OAUTH_CALLBACK_PATHS = frozenset({
    OAUTH_RELAY_PATH,
    TWITTER_OAUTH1_CALLBACK_PATH,
    TWITTER_OAUTH2_CALLBACK_PATH,
})
NATIVE_CHECKOUT_CALLBACK_PATHS = frozenset({
    "/api/stripe/native-return/success/",
    "/api/stripe/native-return/cancel/",
})
# CommonMiddleware redirects slashless callback URLs to these canonical routes
# while retaining their credential-bearing query string. Keep both spellings
# on the no-logging edge backend and redact both in application access logs.
NATIVE_CHECKOUT_PROTECTED_PATHS = (
    NATIVE_CHECKOUT_CALLBACK_PATHS
    | frozenset(path.rstrip("/") for path in NATIVE_CHECKOUT_CALLBACK_PATHS)
)
SENSITIVE_CALLBACK_PATHS = OAUTH_CALLBACK_PATHS | NATIVE_CHECKOUT_PROTECTED_PATHS
ZUULI_MOBILE_REDIRECT_URI = "cash.free2z.zuuli://oauth/callback"
ZUULI_CHECKOUT_RETURN_URI = "cash.free2z.zuuli://checkout/return"
SITEMAP_OUTCOME_RESPONSE_ATOM = "{x-sitemap-outcome}o"
SITEMAP_ACCESS_OUTCOMES = frozenset({"lane_busy", "revision_conflict"})

# Query-parameter NAMES whose VALUES are credentials. Redacted wherever they
# appear in an access-log record: any path, any atom, any format.
#
# The path list above is an allow-list, and an allow-list only ever protects
# the routes somebody remembered to add to it. This list is the half that
# protects the route nobody has written yet -- a second OAuth provider, a new
# signed callback -- and, today, the atoms the path list structurally cannot
# reach. `%(f)s` (Referer) is in gunicorn's DEFAULT access format and carries
# the *previous* page's query string, so it is attached to a request for some
# ordinary path like /profile; `{query_string}e` is the bare query with no
# path in it at all to match against. Both were unredacted before.
#
# Redaction by name needs no coordination with whoever adds the endpoint,
# which is the only property that survives a repo with many parallel authors.
SENSITIVE_QUERY_PARAMS = frozenset({
    # OAuth 1.0a (Twitter) -- 's temporary token/verifier and the static
    # application credentials.
    "oauth_token",
    "oauth_token_secret",
    "oauth_verifier",
    "oauth_consumer_key",
    "oauth_consumer_secret",
    "oauth_signature",
    # OAuth 2 / OIDC. `code` and `state` are the pair the mobile relay and the
    # Twitter OAuth2 callback carry; `code_verifier` is the PKCE secret (the
    # public `code_challenge` is deliberately NOT here -- it is meant to be
    # seen, and redacting it would cost debuggability for nothing).
    "code",
    "code_verifier",
    "state",
    "access_token",
    "refresh_token",
    "id_token",
    "id_token_hint",
    "client_secret",
    "client_assertion",
    "assertion",
    # Bearer/short-lived tokens the app itself puts in links: email
    # verification, password reset, Stripe native-return session ids.
    "token",
    "auth_token",
    "session_id",
    "api_key",
    "apikey",
    "otp",
    "totp",
    # Signed-URL material. GCS V4 presigned URLs  carry these; an
    # access log of a proxied signed URL is a working credential until expiry.
    "signature",
    "sig",
    "x-goog-signature",
    "x-goog-credential",
    "x-amz-signature",
    "x-amz-credential",
    # Catch-alls for anything hand-rolled.
    "password",
    "passwd",
    "secret",
    "credential",
    "private_key",
    "viewing_key",
    "spending_key",
})

# The access loggers gunicorn (WSGI) and daphne (ASGI) log requests to.
#
# HONEST LABEL: `gunicorn.access` is real and carries every record this filter
# rewrites. `daphne.access` is NOT daphne's access log. Verified against the
# pinned daphne 4.2.3: `cli.py` builds an `AccessLogGenerator(sys.stdout)` and
# `access.py` calls `self.stream.write(...)` directly, so daphne's access lines
# never enter the `logging` package and NO filter on any logger name can touch
# them. Worse, the field it writes as "path" is `self.uri` -- the full request
# target, query string included (`http_protocol.py`, the `log_action("http",
# "complete",...)` call), not the bare path.
#
# It is kept anyway, and it is not currently a leak: nginx routes only `/ws/`
# to daphne:8000, both websocket routes (`ws/profile`,
# `ws/conversations/<uuid>/`) are cookie-authenticated and take no query
# parameters, and the only other traffic daphne sees is its own /api/healthz
# probe. The name stays so that a future daphne which DOES log through
# `logging` is covered the day it lands -- see
# test_access_log_real_records.py, which pins the current behaviour so nobody
# reads this tuple as proof of coverage it does not provide.
# If a credential-bearing route is ever proxied to:8000, that is a real
# disclosure and the fix is at the route, not here.
ACCESS_LOGGERS = ("gunicorn.access", "daphne.access")

_INSTALLED = False

# `"<METHOD> <probe path>[?query] HTTP/x.y" 2xx` -- request line immediately
# followed by a 2xx status, which is what every common access-log format emits.
_PROBE_SUCCESS_LINE = re.compile(
    r'"[A-Z]+ (?:%s)(?:\?\S*)? HTTP/[\d.]+" 2\d\d'
    % "|".join(re.escape(p) for p in sorted(PROBE_PATHS))
)
_OAUTH_QUERY = re.compile(
    r"(%s)\?[^\s\"]*"
    % "|".join(re.escape(path) for path in sorted(SENSITIVE_CALLBACK_PATHS))
)
_ZUULI_LOCATION_QUERY = re.compile(
    r"(%s)\?[^\s\"]*"
    % "|".join(
        re.escape(uri)
        for uri in (ZUULI_MOBILE_REDIRECT_URI, ZUULI_CHECKOUT_RETURN_URI)
    )
)
_RAW_REQUEST_LINE_QUERY = re.compile(
    r"^(?P<prefix>[A-Z]+\s+[^\s?]+)\?[^\s\"]*(?P<suffix>\s+HTTP/[\d.]+)$"
)
# `<name>=<value>` for one credential-named parameter, anywhere in a string.
#
# The lookbehind is what keeps the short names honest: without it `token` also
# matches inside `oauth_token=`, `signature` inside `x-goog-signature=`, and
# the replacement would corrupt the surrounding name instead of the value.
# Longer alternatives are still reachable -- Python's alternation backtracks,
# so `code` is tried first at `code_verifier=`, fails on the `=`, and
# `code_verifier` then matches at the same position.
#
# The value runs to the next `&`, whitespace, or quote, which is where a query
# parameter ends in every access-log format we emit. Percent-encoding is
# preserved inside the match on purpose: `%2F` must not terminate a value.
_SENSITIVE_PARAM_VALUE = re.compile(
    r"(?i)(?<![\w.%-])("
    + "|".join(re.escape(name) for name in sorted(SENSITIVE_QUERY_PARAMS))
    + r")=[^&\s\"'<>]*"
)


def _redact_sensitive_params(value: str) -> str:
    """Replace every credential-named parameter VALUE, keeping its name.

    Keeping the name is deliberate. `?[REDACTED]` on the whole query tells an
    incident responder nothing about which flow they are looking at, and the
    non-sensitive parameters next to the credential (`error=access_denied`,
    a page number) are exactly what makes an access log worth keeping.
    """
    return _SENSITIVE_PARAM_VALUE.sub(r"\1=[REDACTED]", value)


def _redact_sensitive_params_in_atoms(args) -> None:
    """Redact credential parameter values in every string atom, in place.

    `"=" in value` first because this runs on EVERY kept access-log record.
    Gunicorn's atoms dict holds one entry per request header, response header,
    and WSGI environ key -- about fifty strings -- and almost none of them
    contain an `=` at all, so the cheap C-level scan skips the regex for
    ordinary traffic while still covering atoms no allow-list enumerates.

    MEASURED, so nobody has to guess: a real 47-atom gunicorn record for an
    ordinary API request has 6 values containing `=`, and the whole pass costs
    ~29us on a dev laptop. That is ~0.06% of a 50ms request, and it is paid
    once per response, not per atom lookup. If a future profile disagrees,
    narrow the atom set -- do not narrow it to a path list, which is the
    failure mode this function exists to fix.
    """
    for key, value in list(args.items()):
        if isinstance(value, str) and "=" in value:
            args[key] = _redact_sensitive_params(value)


def _redact_oauth_query(value: str) -> str:
    value = _OAUTH_QUERY.sub(r"\1?[REDACTED]", value)
    return _ZUULI_LOCATION_QUERY.sub(r"\1?[REDACTED]", value)


def _redact_raw_request_line(value: str) -> str:
    """Redact a raw request target after decoded path admission."""
    return _RAW_REQUEST_LINE_QUERY.sub(
        r"\g<prefix>?[REDACTED]\g<suffix>", value
    )


def _is_success(status) -> bool:
    """True for a 2xx status, in whatever type the log format supplies it."""
    try:
        return 200 <= int(status) < 300
    except (TypeError, ValueError):
        # Unknown status: treat as NOT a success, so the line is kept. Failing
        # open on logging is the safe direction.
        return False


class SuppressProbePaths(logging.Filter):
    """Drop access-log records for SUCCESSFUL requests to the probe paths.

    gunicorn's access logger formats with `record.args` populated from its
    atoms dict: "U" is the path (no query string) and "s" is the status.
    That branch is exact. Anything else falls back to a strict regex over
    the formatted message.

    ONLY 2xx IS SUPPRESSED, and that is the important part. A filter that
    dropped probe lines regardless of status would hide its own worst
    failure: if someone reorders MIDDLEWARE, every probe starts returning
    400, and the access log -- the first place anyone looks -- would be
    silent about it. A failing probe is exactly the line you want to see,
    so 4xx/5xx on these paths is always logged. The noise this exists to
    remove is the steady drip of 200s.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, dict):
            sitemap_outcome = args.get(SITEMAP_OUTCOME_RESPONSE_ATOM)
            if (
                isinstance(sitemap_outcome, str)
                and sitemap_outcome in SITEMAP_ACCESS_OUTCOMES
                and isinstance(record.msg, str)
                and " sitemap_outcome=" not in record.msg
            ):
                # Gunicorn supplies every response header in record.args even
                # when its default access format does not render that atom.
                # Append only for these two expected sitemap outcomes, reusing
                # the access record that already exists instead of emitting a
                # second application record per replayable public request.
                record.msg += (
                    f" sitemap_outcome=%({SITEMAP_OUTCOME_RESPONSE_ATOM})s"
                )
            path = args.get("U") or args.get("{raw_uri}e")
            if not isinstance(path, str):
                # No usable path atom: this cannot be a probe line, but it can
                # still carry a credential. Redact before keeping it.
                _redact_sensitive_params_in_atoms(args)
                return True
            if path.split("?", 1)[0] in SENSITIVE_CALLBACK_PATHS:
                # Gunicorn exposes both the full request line/raw URI and the
                # standalone query atom depending on its configured format.
                # Rewrite every representation before any handler formats it.
                for key, value in list(args.items()):
                    if key == "q" and isinstance(value, str) and value:
                        args[key] = "?[REDACTED]"
                    elif key == "r" and isinstance(value, str):
                        # Gunicorn builds this atom from the raw URI. It can
                        # retain percent-encoding even though U above is the
                        # decoded sensitive path, so path-specific regexes are
                        # insufficient once U has established the boundary.
                        args[key] = _redact_raw_request_line(value)
                    elif key == "{raw_uri}e" and isinstance(value, str):
                        args[key] = value.split("?", 1)[0] + "?[REDACTED]"
                    elif isinstance(value, str):
                        args[key] = _redact_oauth_query(value)
                # The whole-query blanking above is keyed on the REQUEST path,
                # so it cannot reach a credential that arrived attached to some
                # OTHER URL in the same record: the Referer of the page the
                # provider redirected from, an https Location this response is
                # sending the browser to, or the bare `{query_string}e` atom
                # that has no path in it to match. Name-based redaction runs
                # afterwards and closes all three.
                _redact_sensitive_params_in_atoms(args)
                return True
            if (
                path.split("?", 1)[0] in PROBE_PATHS
                and _is_success(args.get("s"))
            ):
                # Dropped entirely, so there is nothing to redact. Deciding
                # this BEFORE the redaction pass is what keeps the pass off
                # the hot probe path: every replica answers /api/healthz every
                # 5s while booting and every 60s from four regions forever.
                return False
            # Everything else is kept. A dict-args record is gunicorn's access
            # format, so do not fall through to the (slower, fuzzier) message
            # scan below -- but do redact first, on EVERY path, including a
            # failing probe whose query somebody appended a token to.
            _redact_sensitive_params_in_atoms(args)
            return True

        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - never break logging
            return True

        redacted = _redact_sensitive_params(_redact_oauth_query(message))
        if redacted != message:
            # Daphne and custom handlers often preformat into msg/tuple args.
            # Replacing with the final string prevents a second interpolation
            # from resurrecting the provider code or state.
            record.msg = redacted
            record.args = ()
            message = redacted

        # Anchored on the request line + status, e.g.
        #... "GET /api/healthz HTTP/1.1" 200 24...
        # rather than a bare `" <path> "` substring, which would also drop a
        # real access-log line whose referrer or query value merely contained
        # the probe path.
        return not _PROBE_SUCCESS_LINE.search(message)


def install() -> None:
    """Attach suppression/redaction to the access loggers. Idempotent."""
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    log_filter = SuppressProbePaths()
    for name in ACCESS_LOGGERS:
        logging.getLogger(name).addFilter(log_filter)
