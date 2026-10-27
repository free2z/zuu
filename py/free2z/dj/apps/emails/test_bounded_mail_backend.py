""": the SendGrid mail backend's HTTP call is bounded.

``sendgrid_backend.SendgridBackend`` builds a ``python_http_client.Client``
whose ``timeout`` defaults to ``None`` -- ``urllib`` then blocks forever -- and
password-reset / verification mail is sent inline in a web request on a pod
with one sync worker. ``BoundedSendgridBackend`` sets the timeout, and
these tests pin that it reaches the object that actually makes the request.

Negative control, run while writing this: with the timeout line removed from
``BoundedSendgridBackend.__init__``, the first two tests fail and the socket
test waits out the stub's HOLD_SECONDS and fails its elapsed assertion.
"""

import socket
import threading
import time

import pytest
from django.conf import settings
from django.core.mail import EmailMessage
from django.test import override_settings

from dj.apps.emails.backends import BoundedSendgridBackend

HOLD_SECONDS = 10.0


def test_the_deployed_backend_is_the_bounded_one():
    # pytest-django swaps in locmem for the suite, so read the module value.
    from dj.free2z import settings as project_settings

    assert project_settings.EMAIL_BACKEND == (
        "dj.apps.emails.backends.BoundedSendgridBackend"
    )
    assert 0 < settings.EMAIL_SEND_TIMEOUT_SECONDS <= 30


def test_the_timeout_reaches_the_per_request_client():
    backend = BoundedSendgridBackend(api_key="SG.test-not-used")
    assert backend.sg.client.timeout == settings.EMAIL_SEND_TIMEOUT_SECONDS
    # `client.mail.send.post(...)` is what SendgridBackend.send_messages calls;
    # each attribute hop builds a NEW Client, which must inherit the timeout.
    assert backend.sg.client.mail.send.timeout == (
        settings.EMAIL_SEND_TIMEOUT_SECONDS
    )


def test_a_hung_sendgrid_fails_promptly_instead_of_blocking():
    """Real socket: accept, never answer. The send must give up on its own."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    host, port = server.getsockname()
    held = []
    stop = threading.Event()

    def _accept():
        # Hold each connection HOLD_SECONDS, then close it, so an UNBOUNDED
        # send (the negative control) fails on the elapsed assertion in
        # seconds instead of hanging the suite.
        server.settimeout(0.1)
        opened = {}
        while not stop.is_set():
            try:
                conn = server.accept()[0]
                held.append(conn)
                opened[conn] = time.monotonic()
            except (socket.timeout, OSError):
                pass
            for conn, at in list(opened.items()):
                if time.monotonic() - at >= HOLD_SECONDS:
                    conn.close()
                    del opened[conn]

    thread = threading.Thread(target=_accept, daemon=True)
    thread.start()
    try:
        with override_settings(
            EMAIL_SEND_TIMEOUT_SECONDS=0.5,
            SENDGRID_SANDBOX_MODE_IN_DEBUG=False,
        ):
            backend = BoundedSendgridBackend(
                api_key="SG.test-not-used", host=f"http://{host}:{port}",
                fail_silently=False,
            )
            message = EmailMessage(
                "subject", "body", "from@example.invalid",
                ["to@example.invalid"], connection=backend,
            )
            started = time.monotonic()
            with pytest.raises(Exception) as caught:
                message.send()
            elapsed = time.monotonic() - started
    finally:
        stop.set()
        thread.join(timeout=5)
        for conn in held:
            conn.close()
        server.close()

    assert held, "the send never reached the stub"
    assert elapsed < 5, elapsed
    assert "timed out" in str(caught.value).lower() or isinstance(
        caught.value, (TimeoutError, OSError)
    ), repr(caught.value)


# ---------------------------------------------------------------------------
# A bounded send can time out AFTER SendGrid accepted the message (codex
# review of ). The reset path must not retract a link that may arrive.
# ---------------------------------------------------------------------------

import http.client  # noqa: E402
from datetime import timedelta  # noqa: E402
from urllib.error import HTTPError, URLError  # noqa: E402

from django.core.cache import cache  # noqa: E402
from django.utils import timezone  # noqa: E402

from dj.apps.emails.backends import delivery_outcome_unknown  # noqa: E402
from dj.apps.emails.models import Email, PasswordResetToken  # noqa: E402
from dj.apps.emails.views import send_password_reset_email  # noqa: E402


@pytest.mark.parametrize("exc, unknown", [
    # getresponse() read timeout / reset: the request was fully sent.
    (TimeoutError("timed out"), True),
    (socket.timeout("timed out"), True),
    (ConnectionResetError(), True),
    # Truncated / garbled response after the request was sent (codex r2).
    (http.client.IncompleteRead(b"partial"), True),
    (http.client.BadStatusLine("garbage"), True),
    (http.client.RemoteDisconnected("gone"), True),
    # urllib wraps connect/send failures in URLError: never reached SendGrid.
    (URLError(TimeoutError("timed out")), False),
    (URLError(ConnectionRefusedError()), False),
    # An HTTP error status is a definite refusal.
    (HTTPError("http://x", 400, "Bad Request", {}, None), False),
    (RuntimeError("anything else"), False),
])
def test_delivery_outcome_classification(exc, unknown):
    assert delivery_outcome_unknown(exc) is unknown


def _reset_email(creator_factory, address):
    user = creator_factory(password="old-password")
    email = Email.objects.create(
        user=user, email=address, token="email-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )
    cache.delete(f"reset_email_count_v2_{email.email}")
    return email


@pytest.mark.django_db
def test_a_response_timeout_keeps_the_reset_token(creator_factory, mocker):
    email = _reset_email(creator_factory, "maybe-delivered@example.com")
    release = mocker.patch("dj.apps.emails.views._release_reset_email_quota")
    mocker.patch(
        "dj.apps.emails.views.EmailMultiAlternatives.send",
        side_effect=TimeoutError("timed out"),
    )

    with pytest.raises(TimeoutError):
        send_password_reset_email(email)

    assert PasswordResetToken.objects.filter(email=email, used=False).exists()
    release.assert_not_called()


@pytest.mark.django_db
def test_a_connect_failure_still_retracts_the_reset_token(
    creator_factory, mocker,
):
    email = _reset_email(creator_factory, "not-delivered@example.com")
    mocker.patch(
        "dj.apps.emails.views.EmailMultiAlternatives.send",
        side_effect=URLError(TimeoutError("timed out")),
    )

    with pytest.raises(URLError):
        send_password_reset_email(email)

    assert not PasswordResetToken.objects.filter(email=email).exists()
