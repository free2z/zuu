"""Access-log credential redaction, driven by a REAL gunicorn access record.

`test_health.py` builds `logging.LogRecord`s by hand. That is fine for the
probe-suppression logic, which only reads `U` and `s` -- but it is not evidence
about credential redaction, because the hand-built record is written by the
same person who wrote the filter and therefore agrees with it by construction.
 found this the hard way while checking a gunicorn 21->26 bump: the
synthetic tests "would have passed either way", so they could not have caught a
silent regression in the three properties the redaction actually depends on
(the logger being `gunicorn.access`, `record.args` being dict-like, and
`record.msg` staying an unformatted template).

So this module never constructs a record. It parses real HTTP bytes with
`gunicorn.http.message.Request`, builds the WSGI environ with
`gunicorn.http.wsgi.create`, and hands both to `gunicorn.glogging.Logger.access`
-- the exact call the production WSGI worker makes after every response. The
assertions are made against the string a real `logging.Handler` formats and
would have written to stdout, which is the byte sequence the GKE logging agent
ships to Cloud Logging.

Building the record for real is what exposed 's remaining leak. Gunicorn's
DEFAULT access format renders `%(f)s` -- the Referer -- and a request for an
ordinary path such as `/profile` carries the *previous* page's query string
there. Path-based redaction structurally cannot see that, because the path in
the record is `/profile`.
"""

import datetime
import logging
import socket

import pytest

from dj.apps.health import log_filters


ACCESS_LOGGER = "gunicorn.access"

# Values that must never survive into a formatted log line. Distinct per
# credential so a failure names the one that leaked.
OAUTH1_TOKEN = "SENTINEL-oauth1-token"
OAUTH1_VERIFIER = "SENTINEL-oauth1-verifier"
OAUTH2_CODE = "SENTINEL-oauth2-code"
OAUTH2_STATE = "SENTINEL-oauth2-state"
BEARER = "SENTINEL-access-token"


def _real_gunicorn_access_line(
    target,
    method="GET",
    request_headers=(),
    status="302 Found",
    response_headers=(),
    body_bytes=0,
    log_filter=None,
):
    """Drive real gunicorn logging and return (formatted line, record).

    `log_filter` is attached to the real `gunicorn.access` logger, so the
    record travels the production path: atoms -> SafeAtoms -> logger.info(
    format_string, atoms) -> filter -> handler -> formatter -> text.
    """
    from gunicorn.config import Config
    from gunicorn.glogging import Logger
    from gunicorn.http import wsgi
    from gunicorn.http.message import Request
    from gunicorn.http.unreader import IterUnreader

    header_bytes = b"".join(
        f"{name}: {value}\r\n".encode() for name, value in request_headers
    )
    raw = (
        f"{method} {target} HTTP/1.1\r\n".encode()
        + b"Host: free2z.cash\r\n"
        + header_bytes
        + b"\r\n"
    )

    cfg = Config()
    cfg.set("accesslog", "-")
    request = Request(cfg, IterUnreader([raw]), ("10.0.0.1", 41234), 1)

    listener, peer = socket.socketpair()
    try:
        response, environ = wsgi.create(
            request, listener, ("10.0.0.1", 41234), ("0.0.0.0", 8001), cfg,
        )
        response.status = status
        response.sent = body_bytes
        response.headers = list(response_headers)

        access_logger = logging.getLogger(ACCESS_LOGGER)
        saved = (
            list(access_logger.handlers),
            list(access_logger.filters),
            access_logger.level,
            access_logger.propagate,
        )
        captured = []

        class _Capture(logging.Handler):
            def emit(self, record):
                captured.append((self.format(record), record))

        handler = _Capture()
        handler.setFormatter(logging.Formatter("%(message)s"))
        try:
            access_logger.handlers = [handler]
            access_logger.filters = []
            access_logger.propagate = False
            access_logger.setLevel(logging.INFO)
            if log_filter is not None:
                access_logger.addFilter(log_filter)
            gunicorn_logger = Logger(cfg)
            gunicorn_logger.access(
                response,
                request,
                environ,
                datetime.timedelta(seconds=0, microseconds=1500),
            )
        finally:
            (
                access_logger.handlers,
                access_logger.filters,
                access_logger.level,
                access_logger.propagate,
            ) = saved
    finally:
        listener.close()
        peer.close()

    return captured[0] if captured else (None, None)


def test_the_three_assumptions_the_redaction_rests_on_still_hold():
    """Pin what  checked by hand against the real WSGI server.

    Redaction is a `logging.Filter` on a named logger that mutates
    `record.args` before any handler formats it. That only works while all
    three of these hold; a gunicorn bump can break any of them without a
    single Django test noticing, because nothing in CI ever starts gunicorn.
    """
    _, record = _real_gunicorn_access_line("/api/creator/alice/", status="200 OK")

    assert record.name == ACCESS_LOGGER
    assert isinstance(record.args, dict)
    # Unformatted template: interpolation happens in the handler, AFTER the
    # filter has had its chance to rewrite the atoms.
    assert "%(" in record.msg
    assert OAUTH1_TOKEN not in record.msg


def test_real_oauth1_callback_line_carries_no_credential():
    """'s exact request, end to end, through the real access logger."""
    target = (
        f"{log_filters.TWITTER_OAUTH1_CALLBACK_PATH}"
        f"?oauth_token={OAUTH1_TOKEN}&oauth_verifier={OAUTH1_VERIFIER}"
    )
    line, record = _real_gunicorn_access_line(
        target,
        request_headers=[
            # OAuth 1.0a sends the user back from the provider's authorize
            # page, whose own URL contains the request token.
            ("Referer", f"https://api.twitter.com/oauth/authenticate"
                        f"?oauth_token={OAUTH1_TOKEN}"),
        ],
        response_headers=[("Location", "/profile")],
        log_filter=log_filters.SuppressProbePaths(),
    )

    assert line is not None
    assert "SENTINEL" not in line
    assert log_filters.TWITTER_OAUTH1_CALLBACK_PATH in line
    # No atom retains it either: a format change must not resurrect it.
    assert "SENTINEL" not in str(dict(record.args))


def test_real_referer_credential_on_an_ordinary_path_is_redacted():
    """The leak path-based redaction cannot see.

    The browser lands on the callback, the callback 302s to /profile, and the
    request for /profile carries the callback URL -- credentials and all -- in
    its `Referer`. `%(f)s` is in gunicorn's default access format, so that line
    reaches Cloud Logging. The record's path is `/profile`, so no allow-list of
    callback paths will ever match it.
    """
    line, record = _real_gunicorn_access_line(
        "/profile",
        status="200 OK",
        request_headers=[
            ("Referer", f"https://free2z.cash"
                        f"{log_filters.TWITTER_OAUTH1_CALLBACK_PATH}"
                        f"?oauth_token={OAUTH1_TOKEN}"
                        f"&oauth_verifier={OAUTH1_VERIFIER}"),
        ],
        log_filter=log_filters.SuppressProbePaths(),
    )

    assert "SENTINEL" not in line
    assert "oauth_token=[REDACTED]" in line
    assert "oauth_verifier=[REDACTED]" in line
    assert "SENTINEL" not in str(dict(record.args))


def test_real_record_for_a_route_no_allow_list_knows_about_is_redacted():
    """A callback nobody has added to the path list yet must still be safe."""
    line, record = _real_gunicorn_access_line(
        f"/api/some-future-provider/callback"
        f"?code={OAUTH2_CODE}&state={OAUTH2_STATE}&access_token={BEARER}",
        status="200 OK",
        log_filter=log_filters.SuppressProbePaths(),
    )

    assert "SENTINEL" not in line
    assert "code=[REDACTED]" in line
    assert "state=[REDACTED]" in line
    assert "SENTINEL" not in str(dict(record.args))


def test_real_https_location_credential_is_redacted():
    """`{location}o` is only redacted for the two `zuuli://` URIs by path.

    An https redirect that carries a code is the same disclosure, and the
    response header is renderable with `%({location}o)s`.
    """
    _, record = _real_gunicorn_access_line(
        "/api/auth/social/mobile/callback"
        f"?code={OAUTH2_CODE}&state={OAUTH2_STATE}",
        response_headers=[
            ("Location", f"https://free2z.cash/profile?code={OAUTH2_CODE}"),
        ],
        log_filter=log_filters.SuppressProbePaths(),
    )

    assert "SENTINEL" not in str(dict(record.args))
    assert record.args["{location}o"].endswith("code=[REDACTED]")


def test_real_bare_query_string_atom_is_redacted():
    """`{query_string}e` has no path in it for a path regex to anchor on."""
    _, record = _real_gunicorn_access_line(
        f"{log_filters.TWITTER_OAUTH1_CALLBACK_PATH}"
        f"?oauth_token={OAUTH1_TOKEN}&oauth_verifier={OAUTH1_VERIFIER}",
        log_filter=log_filters.SuppressProbePaths(),
    )

    assert "SENTINEL" not in record.args["{query_string}e"]
    assert "SENTINEL" not in str(dict(record.args))


def test_percent_encoded_credential_values_are_redacted():
    """A provider may percent-encode the value; `%2F` must not end it."""
    _, record = _real_gunicorn_access_line(
        "/api/twitter/callback"
        f"?code={OAUTH2_CODE}%2F%2Bslash&state={OAUTH2_STATE}",
        log_filter=log_filters.SuppressProbePaths(),
    )

    assert "SENTINEL" not in str(dict(record.args))


def test_ordinary_query_parameters_are_never_touched():
    """Redaction that eats real traffic is a broken access log.

    `error=access_denied` in particular is the thing an incident responder
    needs off a failed callback, and it sits next to the credential.
    """
    line, _ = _real_gunicorn_access_line(
        "/api/creator/alice/zpages?page=2&ordering=-created&homeSort=hot",
        status="200 OK",
        log_filter=log_filters.SuppressProbePaths(),
    )

    assert "page=2" in line
    assert "ordering=-created" in line
    assert "homeSort=hot" in line

    line, _ = _real_gunicorn_access_line(
        f"{log_filters.OAUTH_RELAY_PATH}"
        f"?error=access_denied&state={OAUTH2_STATE}",
        status="400 Bad Request",
        log_filter=log_filters.SuppressProbePaths(),
    )
    assert "SENTINEL" not in line


def test_probe_suppression_still_works_on_a_real_record():
    """The redaction pass must not change what gets dropped."""
    log_filter = log_filters.SuppressProbePaths()

    line, _ = _real_gunicorn_access_line(
        "/api/healthz", status="200 OK", body_bytes=24, log_filter=log_filter,
    )
    assert line is None

    line, _ = _real_gunicorn_access_line(
        "/api/healthz", status="503 Service Unavailable", log_filter=log_filter,
    )
    assert line is not None


@pytest.mark.parametrize(
    "name",
    ["oauth_token", "oauth_verifier", "code", "state", "access_token",
     "refresh_token", "id_token", "client_secret", "session_id", "token",
     "code_verifier", "password", "api_key", "signature"],
)
def test_every_documented_parameter_name_is_actually_redacted(name):
    """The issue names a list; assert the list is not aspirational."""
    assert name in log_filters.SENSITIVE_QUERY_PARAMS
    assert log_filters._redact_sensitive_params(
        f"/whatever?{name}=SENTINEL-value"
    ) == f"/whatever?{name}=[REDACTED]"


def test_a_longer_credential_name_is_not_corrupted_by_a_shorter_one():
    """`token` is in the list and is a substring of `oauth_token`.

    A naive alternation redacts `oauth_` + `token=[REDACTED]`, which still
    hides the value but silently renames the parameter -- and would do the
    same to `x-goog-signature` via `signature`.
    """
    assert log_filters._redact_sensitive_params(
        "?oauth_token=SENTINEL&x-goog-signature=SENTINEL&code_verifier=SENTINEL"
    ) == (
        "?oauth_token=[REDACTED]&x-goog-signature=[REDACTED]"
        "&code_verifier=[REDACTED]"
    )


def test_a_word_that_merely_ends_in_a_credential_name_is_left_alone():
    """`?promocode=SUMMER` is not a credential; `?code=` is."""
    assert log_filters._redact_sensitive_params(
        "?promocode=SUMMER&mycode=X"
    ) == "?promocode=SUMMER&mycode=X"


# --- daphne: the half of ACCESS_LOGGERS that a filter cannot reach ---------


def test_daphne_access_lines_bypass_logging_and_keep_the_query_string():
    """Pin the reason `daphne.access` in ACCESS_LOGGERS proves nothing.

    Raised by the codex adversarial review of  and confirmed against the
    pinned daphne: its access log is not a `logging` logger at all, and the
    field it labels "path" is the full request target with the query string
    on it. Two consequences, both worth failing a build over if they change:

    * No `logging.Filter` -- ours or anyone's -- can redact a daphne access
      line, so nobody should read that tuple entry as coverage.
    * The day a credential-bearing route is proxied to daphne:8000, the
      credential is in container stdout. Today nginx sends only `/ws/` there
      and both websocket routes are cookie-authenticated with no query
      parameters, which is the invariant that makes this safe rather than
      any redaction.

    If a future daphne routes access lines through `logging`, this test fails
    and `install()` starts covering them for free -- update the comment then.
    """
    import io

    from daphne.access import AccessLogGenerator

    stream = io.StringIO()
    generator = AccessLogGenerator(stream)

    records = []

    class _Trap(logging.Handler):
        def emit(self, record):
            records.append(record)

    root = logging.getLogger()
    trap = _Trap()
    root.addHandler(trap)
    try:
        generator(
            "http",
            "complete",
            {
                # daphne passes `self.uri` here, not the bare path.
                "path": f"/api/twitter/v1/access-token?oauth_token={OAUTH1_TOKEN}",
                "status": 302,
                "method": "GET",
                "client": "10.0.0.1:41234",
                "time_taken": 0.01,
                "size": 0,
            },
        )
    finally:
        root.removeHandler(trap)

    written = stream.getvalue()
    # It really did write, and it really did keep the query string.
    assert f"oauth_token={OAUTH1_TOKEN}" in written
    #...and it never became a LogRecord, so no filter could have seen it.
    assert records == []
    assert "daphne.access" in log_filters.ACCESS_LOGGERS
