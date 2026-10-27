""": a hung reCAPTCHA siteverify must not hang sign-up or sign-in.

Each prod pod runs ONE sync gunicorn worker. ``/api/start/`` and
``/api/auth/login/`` both POST the user's token to Google's siteverify inline,
and until  neither passed a timeout -- ``requests`` has none by default --
so a slow or black-holed Google held the pod's only worker for as long as the
far end chose, and every other request that pod would have served waited
behind it.

These tests use REAL sockets, not a mocked ``requests.post``: a mock cannot
hang, so it cannot prove a timeout exists. ``_Blackhole`` accepts the TCP
connection and then says nothing for ``HOLD_SECONDS``, which is the shape of the
failure (a SYN that completes, a response that never comes). ``_Google``
answers over real HTTP, so the happy path goes through the same plumbing.

Negative control, run while writing this: with only the ``timeout=`` removed
from ``dj.apps.g12f.captcha.siteverify``, both blackhole tests wait out the
full ``HOLD_SECONDS`` (10.7s and 10.1s observed) until the stub closes the
connection, and fail on the elapsed-time assertion. In production nothing
closes it.
"""

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone

from dj.apps.g12f.captcha import CAPTCHA_UNAVAILABLE_MESSAGE
from dj.apps.g12f.models import Creator

#How long the blackhole holds a connection before giving up on it. Long
#enough that "answered within the budget" and "waited it out" cannot be
#confused; short enough that the negative control fails in seconds rather
#than hanging CI.
HOLD_SECONDS = 10.0
#The tightened budget the tests run with, (connect, read).
TEST_TIMEOUT = (1.0, 0.5)
#What "answered promptly" means: the read budget plus generous slack, and
#well under HOLD_SECONDS.
PROMPT_SECONDS = 4.0


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


class _Blackhole:
    """Accept TCP connections, read nothing, write nothing, for HOLD_SECONDS."""

    def __init__(self):
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.server.settimeout(0.1)
        self.accepted = 0
        self._held = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    @property
    def url(self):
        host, port = self.server.getsockname()
        return f"http://{host}:{port}/recaptcha/api/siteverify"

    def _run(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.server.accept()
            except (socket.timeout, OSError):
                pass
            else:
                self.accepted += 1
                self._held.append((time.monotonic(), conn))
            now = time.monotonic()
            for opened, conn in list(self._held):
                if now - opened >= HOLD_SECONDS:
                    conn.close()
                    self._held.remove((opened, conn))

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)
        for _, conn in self._held:
            conn.close()
        self.server.close()
        return False


class _Google:
    """A real HTTP server answering siteverify with a fixed status and body."""

    def __init__(self, status, body, content_type="application/json"):
        calls = self.calls = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                calls.append(self.rfile.read(length))
                payload = body.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self):
        host, port = self.httpd.server_address
        return f"http://{host}:{port}/recaptcha/api/siteverify"

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        return False


def _signup(api_client, username="newcomer", token="tok-signup"):
    return api_client.post(
        "/api/start/",
        {
            "username": username,
            "password": "a-perfectly-fine-password-2080",
            "captcha_result": token,
        },
        format="json",
    )


def _login(api_client, user, token="tok-login"):
    return api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": token,
        },
        format="json",
    )


def _timed(fn):
    started = time.monotonic()
    result = fn()
    return result, time.monotonic() - started


@pytest.mark.django_db
def test_signup_answers_503_promptly_when_siteverify_hangs(api_client):
    with _Blackhole() as google, override_settings(
        RECAPTCHA_SITEVERIFY_URL=google.url,
        RECAPTCHA_SITEVERIFY_TIMEOUT=TEST_TIMEOUT,
    ):
        response, elapsed = _timed(lambda: _signup(api_client))

    assert google.accepted == 1, "the request never reached the stub"
    assert response.status_code == 503, response.content
    assert response.json() == {"error": CAPTCHA_UNAVAILABLE_MESSAGE}
    assert elapsed < PROMPT_SECONDS, elapsed
    # Fail CLOSED: an unverifiable captcha creates nothing.
    assert not Creator.objects.filter(username__iexact="newcomer").exists()


@pytest.mark.django_db
def test_login_answers_503_promptly_when_siteverify_hangs(
    api_client, creator_factory,
):
    user = creator_factory(password="correct-password")

    with _Blackhole() as google, override_settings(
        RECAPTCHA_SITEVERIFY_URL=google.url,
        RECAPTCHA_SITEVERIFY_TIMEOUT=TEST_TIMEOUT,
    ):
        response, elapsed = _timed(lambda: _login(api_client, user))

    assert google.accepted == 1, "the request never reached the stub"
    assert response.status_code == 503, response.content
    body = response.json()
    assert body["detail"] == CAPTCHA_UNAVAILABLE_MESSAGE
    # Both front ends route an auth failure to "reCAPTCHA failed, try again"
    # by regex on the message (`isCaptchaError`, lib/stores/auth.ts).
    assert "recaptcha" in body["detail"].lower()
    assert elapsed < PROMPT_SECONDS, elapsed
    # Fail CLOSED: no session was established.
    assert "_auth_user_id" not in api_client.session


@pytest.mark.django_db
def test_login_answers_503_when_siteverify_returns_an_html_error(
    api_client, creator_factory,
):
    """Google's own 5xx pages are HTML; ``r.json()`` on one used to 500."""
    user = creator_factory(password="correct-password")

    with _Google(502, "<html>Bad Gateway</html>", "text/html") as google, \
            override_settings(
                RECAPTCHA_SITEVERIFY_URL=google.url,
                RECAPTCHA_SITEVERIFY_TIMEOUT=TEST_TIMEOUT,
            ):
        response = _login(api_client, user)

    assert len(google.calls) == 1
    assert response.status_code == 503, response.content
    assert response.json()["detail"] == CAPTCHA_UNAVAILABLE_MESSAGE


@pytest.mark.django_db
def test_signup_still_succeeds_against_a_prompt_siteverify(api_client):
    """Positive control: the same real-socket plumbing, answering yes.

    Without this, the 503s above would also pass if the URL setting were
    ignored and every call failed for some unrelated reason.
    """
    payload = json.dumps({
        "success": True,
        "challenge_ts": timezone.now().isoformat().replace("+00:00", "Z"),
        "hostname": "free2z.cash",
    })
    with _Google(200, payload) as google, override_settings(
        RECAPTCHA_SITEVERIFY_URL=google.url,
        RECAPTCHA_SITEVERIFY_TIMEOUT=TEST_TIMEOUT,
    ):
        response = _signup(api_client, username="prompt-newcomer")

    assert len(google.calls) == 1
    assert b"response=tok-signup" in google.calls[0]
    assert response.status_code in (200, 201), response.content
    assert Creator.objects.filter(username__iexact="prompt-newcomer").exists()
