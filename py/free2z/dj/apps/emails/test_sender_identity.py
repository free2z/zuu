"""One configured sender, and it may not leave the domain SendGrid signs for.

Issue. The From address used to be a literal copied into three call
sites (``emails/views.py`` twice, ``e2ee/tasks.py`` once), one of them still
carrying a ``# Replace with your actual sender email`` placeholder comment.

Two distinct properties are under test here, and they fail in different ways:

1. **Every path actually reads the setting.** Each test overrides
   ``DEFAULT_FROM_EMAIL`` to an address that is aligned but *different* from
   the shipped default, then drives the real send path. Reinstating any of the
   three literals makes exactly that test fail -- the assertion cannot pass
   against a hardcoded value.

2. **The configured value stays DMARC-aligned.** ``free2z.cash`` is the
   product domain, it is where ``CANONICAL_ORIGIN`` points, it is what every
   link in these messages points at, and it has no SendGrid domain
   authentication whatsoever. It is the single most likely thing for a future
   contributor to "harmonise" the sender to, and the resulting mail is
   accepted by the provider, reported as sent, and delivered nowhere.
"""
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.core import mail
from django.core.checks import Error
from django.core.checks.registry import registry as check_registry
from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.e2ee.tasks import build_chat_request_message
from dj.apps.emails.checks import check_email_sender
from dj.apps.emails.models import Email
from dj.apps.emails.sender import (
    AUTHENTICATED_SENDER_DOMAIN,
    _describe_problem,
    get_email_sender,
)

#Aligned (still on the mail domain), and deliberately NOT the shipped
#default: a call site that ignored the setting would send as the default and
#every assertion below would fail. This is the negative control.
CONFIGURED_SENDER = "postmaster-test@free2z.com"

#The mistake the domain guard exists to catch: the product/web domain, which
#has no SendGrid domain authentication and no sendgrid.net in its SPF.
WEB_DOMAIN_SENDER = "noreply@free2z.cash"


@pytest.fixture(autouse=True)
def _configured(settings):
    settings.CANONICAL_ORIGIN = "https://free2z.cash"
    settings.DEFAULT_FROM_EMAIL = CONFIGURED_SENDER


@pytest.fixture
def confirmed_email(creator_factory):
    return Email.objects.create(
        user=creator_factory(),
        email="recipient@example.com",
        token="live-address-token",
        expires_at=timezone.now() + timedelta(hours=1),
        confirmed_at=timezone.now(),
    )


# --- every send path reads the setting ---------------------------------------


@pytest.mark.django_db
def test_address_confirmation_is_sent_from_the_configured_sender(
    creator_factory, recent_login):
    client = APIClient()
    recent_login(client, creator_factory())

    response = client.post(
        "/api/emails/add", {"email": "new@example.com"}, format="json"
    )

    assert response.status_code == 201, response.content
    assert len(mail.outbox) == 1
    assert mail.outbox[0].from_email == CONFIGURED_SENDER


@pytest.mark.django_db
def test_password_reset_is_sent_from_the_configured_sender(confirmed_email):
    client = APIClient()

    response = client.post(
        "/api/emails/reset-password",
        {"email": confirmed_email.email},
        format="json",
    )

    # Anti-enumeration: 200 regardless. What matters is the message.
    assert response.status_code == 200, response.content
    assert len(mail.outbox) == 1
    assert mail.outbox[0].from_email == CONFIGURED_SENDER


@pytest.mark.django_db
def test_chat_request_mail_is_sent_from_the_configured_sender(
    creator_factory, confirmed_email
):
    """The third copy of the literal lived in ``e2ee/tasks.py``.

    The message builder is exercised directly -- it exists separately from the
    send precisely so it can be read in tests (``e2ee/tests``).
    """
    chat = SimpleNamespace(
        sender=SimpleNamespace(username="alice_s"),
        recipient=SimpleNamespace(username="Bob_R"),
        get_url=lambda: "https://free2z.com/bridge/e2e2z/chat/#peer=alice_s",
    )

    message = build_chat_request_message(chat, confirmed_email)

    assert message.from_email == CONFIGURED_SENDER


# --- the property the reset mail must keep  ----------------------------


@pytest.mark.django_db
def test_password_reset_still_carries_no_list_unsubscribe(confirmed_email):
    """Unsubscribing deletes the address row, which cascades the reset token.

    A client-rendered one-click Unsubscribe button next to a password-reset
    mail is therefore a warning-free account-lockout control, offered to
    exactly the person who has already lost their password. Confirmation mail
    is subscription-shaped and keeps the header; recovery mail must not gain
    it by someone editing the neighbouring argument list.
    """
    client = APIClient()
    client.post(
        "/api/emails/reset-password",
        {"email": confirmed_email.email},
        format="json",
    )

    assert len(mail.outbox) == 1
    headers = mail.outbox[0].extra_headers or {}
    assert "List-Unsubscribe" not in headers
    assert "List-Unsubscribe-Post" not in headers


@pytest.mark.django_db
def test_address_confirmation_still_carries_list_unsubscribe(creator_factory, recent_login):
    """The positive control for the test above.

    Without it, deleting ``unsubscribe_headers`` everywhere would leave the
    reset assertion passing while silently dropping a header we do want.
    """
    client = APIClient()
    recent_login(client, creator_factory())
    client.post("/api/emails/add", {"email": "new@example.com"}, format="json")

    assert len(mail.outbox) == 1
    assert "List-Unsubscribe" in (mail.outbox[0].extra_headers or {})


# --- the domain guard --------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        "skylar@free2z.com",
        "Free2Z <skylar@free2z.com>",
        "noreply@free2z.com",
        # A SendGrid-style sending subdomain: relaxed DMARC alignment (our
        # record publishes no adkim) accepts it against d=free2z.com.
        "bounces@em1234.free2z.com",
        "  skylar@free2z.com  ",
        "skylar@FREE2Z.COM",
    ],
)
def test_aligned_senders_are_accepted(settings, value):
    settings.DEFAULT_FROM_EMAIL = value

    assert _describe_problem(value) is None
    assert get_email_sender() == value.strip()


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "   ",
        # The whole point of the guard: the web domain has no SendGrid domain
        # authentication and no sendgrid.net in its SPF record.
        WEB_DOMAIN_SENDER,
        "skylar@free2z.cash",
        "Free2Z <hello@free2z.cash>",
        # Neighbouring domains we own but have not authenticated.
        "skylar@free2give.xyz",
        "skylar@gmail.com",
        # Not a lookalike: a suffix match is not a subdomain match.
        "skylar@notfree2z.com",
        "skylar@free2z.com.evil.example",
        # Not an address at all.
        "skylar",
        "skylar@",
        "@free2z.com",
        # Aligned-LOOKING but invalid: a suffix test on its own accepts both,
        # and SendGrid then rejects the send with a 400 that the reset path
        # swallows to avoid an enumeration oracle -- so an operator's typo
        # would surface only as mail that never arrives. (Codex review.)
        "skylar@.free2z.com",
        "skylar@foo..free2z.com",
        "skylar@free2z.com.",
        # Two addresses: judging only the first would let the second ride
        # along unchecked.
        "skylar@free2z.com, attacker@free2z.cash",
        # Header injection.
        "skylar@free2z.com\nBcc: attacker@free2z.cash",
    ],
)
def test_misaligned_or_malformed_senders_are_refused(settings, value):
    """No fallback, ever -- not even to the address that used to be inlined.

    Quietly substituting a known-good sender would mean the next person's
    wrong value is accepted in silence, which is the failure mode this whole
    module exists to remove.
    """
    settings.DEFAULT_FROM_EMAIL = value

    assert _describe_problem(value) is not None
    with pytest.raises(ImproperlyConfigured) as excinfo:
        get_email_sender()
    assert "DEFAULT_FROM_EMAIL" in str(excinfo.value)


def test_system_check_reports_the_web_domain(settings):
    settings.DEFAULT_FROM_EMAIL = WEB_DOMAIN_SENDER

    problems = check_email_sender(None)

    assert len(problems) == 1
    assert isinstance(problems[0], Error)
    assert problems[0].id == "emails.E002"
    assert AUTHENTICATED_SENDER_DOMAIN in problems[0].hint


def test_system_check_is_silent_when_configured(settings):
    settings.DEFAULT_FROM_EMAIL = CONFIGURED_SENDER

    assert check_email_sender(None) == []


def test_the_shipped_default_is_aligned():
    """What actually ships must satisfy the rule, not just the test values.

    Read off ``dj.free2z.settings`` itself rather than ``django.conf.settings``
    so the autouse override above cannot make this pass: editing the default in
    ``settings.py`` to the web domain fails here.
    """
    from dj.free2z import settings as shipped_settings

    assert _describe_problem(shipped_settings.DEFAULT_FROM_EMAIL) is None


def test_the_check_is_actually_registered():
    """A check nobody registered is a check nobody runs.

    ``manage.py check`` is the enforcement point -- CI runs it, and so does
    every management command the deploy waits on.
    """
    registered = check_registry.get_checks(include_deployment_checks=False)

    assert check_email_sender in registered
