"""A hostile ``Host`` header must not choose the origin of a link we email.

Issue. Before this, all three outbound-mail paths passed
``request.get_host()` into the mailer, and production's ``ALLOWED_HOSTS``
includes ``.googleusercontent.com`` — a wildcard over a domain that exists to
serve third-party content — while the GCE ingress has a host-agnostic
``defaultBackend``, so any matching ``Host`` reaches Django.

The concrete attack these tests close:

    POST /api/emails/reset-password
    Host: attacker-controlled.googleusercontent.com
    {"email": "victim@example.com"}

The *victim* then receives genuine mail from us containing
``https://attacker-controlled.googleusercontent.com/reset-password?token=<LIVE>``.
One click and the attacker holds a valid account-recovery token — full account
takeover, phished from our own mail server.

Each test drives the real HTTP endpoint with the hostile header rather than
calling the helper directly: the point is that no code path between the socket
and the message body can reintroduce the request as a source of truth.
"""
from datetime import timedelta

import pytest
from django.core import mail
from django.core.checks import Error
from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.emails.checks import check_email_link_origin
from dj.apps.emails.link_origin import get_email_link_origin
from dj.apps.emails.models import Email

#A host an attacker can really obtain: production ALLOWED_HOSTS wildcards
#``.googleusercontent.com``, so Django accepts this and ``get_host()``
#returns it verbatim.
HOSTILE_HOST = "attacker-controlled.googleusercontent.com"

CANONICAL = "https://free2z.cash"


@pytest.fixture(autouse=True)
def _prod_like_hosts(settings):
    """Reproduce production's wildcard ALLOWED_HOSTS and canonical origin.

    Without the wildcard, Django 400s the hostile request before any view runs
    and the test would pass for the wrong reason.
    """
    settings.ALLOWED_HOSTS = [
        ".free2z.com",
        ".free2z.cash",
        ".free2give.xyz",
        "localhost",
        "127.0.0.1",
        ".googleusercontent.com",
        "testserver",
    ]
    settings.CANONICAL_ORIGIN = CANONICAL


@pytest.fixture
def confirmed_email(creator_factory):
    return Email.objects.create(
        user=creator_factory(),
        email="victim@example.com",
        token="live-address-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )


def _all_link_text(message):
    """Every place a URL can reach the recipient: body, alternatives, headers."""
    parts = [message.body]
    parts += [content for content, _mimetype in message.alternatives or []]
    parts += [str(v) for v in (message.extra_headers or {}).values()]
    return "\n".join(parts)


def _assert_no_hostile_origin(message):
    text = _all_link_text(message)
    assert HOSTILE_HOST not in text, (
        "the Host header reached a link in outbound mail — this is the #1016 "
        "account-takeover vector:\n" + text
    )
    assert f"{CANONICAL}/" in text, (
        "expected every emailed link to be built from CANONICAL_ORIGIN:\n" + text
    )


# --- password reset: the account-takeover path -------------------------------


@pytest.mark.django_db
def test_reset_link_ignores_a_hostile_host_header(confirmed_email):
    client = APIClient()

    response = client.post(
        "/api/emails/reset-password",
        {"email": confirmed_email.email},
        format="json",
        HTTP_HOST=HOSTILE_HOST,
    )

    # The view is anti-enumeration: 200 regardless. What matters is the mail.
    assert response.status_code == 200, response.content
    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    _assert_no_hostile_origin(message)
    assert f"{CANONICAL}/reset-password?token=" in _all_link_text(message)


# --- address confirmation ----------------------------------------------------


@pytest.mark.django_db
def test_add_email_confirmation_link_ignores_a_hostile_host_header(
    creator_factory, recent_login):
    client = APIClient()
    recent_login(client, creator_factory())

    response = client.post(
        "/api/emails/add",
        {"email": "new@example.com"},
        format="json",
        HTTP_HOST=HOSTILE_HOST,
    )

    assert response.status_code == 201, response.content
    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    _assert_no_hostile_origin(message)
    assert f"{CANONICAL}/api/emails/confirm?token=" in _all_link_text(message)


@pytest.mark.django_db
def test_resend_confirmation_link_ignores_a_hostile_host_header(
    creator_factory,
):
    user = creator_factory()
    Email.objects.create(
        user=user,
        email="pending@example.com",
        token="old-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=None,
        # Older than the 5-minute resend threshold.
        updated_at=timezone.now() - timedelta(hours=1),
    )
    # auto_now on updated_at means the value above is overwritten on insert.
    Email.objects.filter(user=user).update(
        updated_at=timezone.now() - timedelta(hours=1)
    )
    client = APIClient()
    client.force_authenticate(user=user)

    response = client.post(
        "/api/emails/resend", {}, format="json", HTTP_HOST=HOSTILE_HOST
    )

    assert response.status_code == 204, response.content
    assert len(mail.outbox) == 1
    message = mail.outbox[0]
    _assert_no_hostile_origin(message)
    assert f"{CANONICAL}/api/emails/confirm?token=" in _all_link_text(message)
    # The List-Unsubscribe header is a link too, and it carries the address
    # token — the same header the attacker could otherwise point at themselves.
    assert message.extra_headers["List-Unsubscribe"].startswith(f"<{CANONICAL}/")


# --- failing loudly on a blank/malformed origin ------------------------------


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "   ",
        "free2z.cash",  # no scheme
        "https://",  # no host
        "https://free2z.cash/app",  # not a bare origin
        "htps://free2z.cash",  # typo'd scheme
        "https://free2z.cash:notaport",
    ],
)
def test_blank_or_malformed_canonical_origin_raises(settings, value):
    """No fallback, ever.

    Quietly reverting to ``request.get_host()`` when the setting is missing
    would reintroduce the whole bug at exactly the moment nobody is looking.
    """
    settings.CANONICAL_ORIGIN = value

    with pytest.raises(ImproperlyConfigured) as excinfo:
        get_email_link_origin()

    assert "CANONICAL_ORIGIN" in str(excinfo.value)


def test_valid_origin_is_normalised(settings):
    settings.CANONICAL_ORIGIN = "https://stage.free2z.cash/"

    assert get_email_link_origin() == "https://stage.free2z.cash"


def test_system_check_reports_a_missing_origin(settings):
    settings.CANONICAL_ORIGIN = ""

    problems = check_email_link_origin(None)

    assert len(problems) == 1
    assert isinstance(problems[0], Error)
    assert problems[0].id == "emails.E001"


def test_system_check_is_silent_when_configured(settings):
    settings.CANONICAL_ORIGIN = CANONICAL

    assert check_email_link_origin(None) == []


@pytest.mark.django_db
def test_reset_send_fails_loudly_and_retracts_the_token(
    settings, confirmed_email, caplog
):
    """A misconfigured origin must not mail a half-built link.

    ``RequestResetPasswordView`` swallows send failures to avoid an
    enumeration oracle, so the visible consequences are: no mail, no surviving
    token (the quota is refunded so the user is not locked out for 24h), and a
    logged exception.
    """
    settings.CANONICAL_ORIGIN = ""
    client = APIClient()

    response = client.post(
        "/api/emails/reset-password",
        {"email": confirmed_email.email},
        format="json",
        HTTP_HOST=HOSTILE_HOST,
    )

    assert response.status_code == 200, response.content
    assert mail.outbox == []
    assert not confirmed_email.passwordresettoken_set.filter(used=False).exists()
