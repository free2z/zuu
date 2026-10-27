"""max_age, prompt=login and acr_values against REAL sign-ins.

Before  no login path recorded an AuthContext, so every one of these
failed closed forever, and ``max_age=0`` could not complete even in
principle: some time always passes between signing in and the consent page
asking again. Here the user signs in through ``/api/auth/login/`` (never
``force_login``, which records nothing), and the page's return trip carries
the ``login_ticket`` the ``login`` answer handed out.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace

import jwt as pyjwt
import pyotp
import pyotp.totp
import pytest
from django.conf import settings
from django.core import signing
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.identity.models import AuthContext
from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch
from dj.apps.oidc import views as oidc_views
from dj.apps.otp.models import OTPSecret

from .conftest import WEB_REDIRECT, Flow, query_of

pytestmark = pytest.mark.django_db

PASSWORD = "correct-horse-battery"
TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
_FROZEN_TS = 1893458055
MFA = "urn:f2z:acr:mfa"


@pytest.fixture(autouse=True)
def _captcha_passes(monkeypatch):
    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post",
        lambda _url, **_kw: SimpleNamespace(json=lambda: {"success": True}),
    )


@pytest.fixture
def frozen_totp(monkeypatch):
    import dj.apps.otp.utils as otp_utils

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(_FROZEN_TS, tz)

    monkeypatch.setattr(pyotp.totp, "datetime", SimpleNamespace(datetime=FrozenDateTime))

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(_FROZEN_TS, dt_timezone.utc)

    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)
    return lambda: pyotp.TOTP(TOTP_SECRET).at(
        FrozenDateTime.fromtimestamp(_FROZEN_TS, dt_timezone.utc))


@pytest.fixture
def member(creator_factory):
    return creator_factory(username="alice", password=PASSWORD)


@pytest.fixture
def browser():
    return APIClient()


@pytest.fixture
def flow(browser, member, web_app):
    return Flow(browser, member, web_app, redirect_uri=WEB_REDIRECT,
                scope="openid profile")


def sign_in(client, user, **extra):
    response = client.post("/api/auth/login/", {
        "username": user.username, "password": PASSWORD,
        "captcha_result": "ci-valid-captcha", **extra,
    }, format="json")
    assert response.status_code == 204, response.content
    return response


def reauthenticate(client, user, **extra):
    """What the consent page does: sign out, then sign in again."""
    assert client.post("/api/auth/logout/").status_code == 200
    return sign_in(client, user, **extra)


def id_claims(tokens, keyring, web_app):
    return pyjwt.decode(
        tokens["id_token"], keyring.active_rs256.public_pem, algorithms=["RS256"],
        audience=web_app.client_id, issuer=settings.OIDC_ISSUER,
    )


def age_session(user, by=timedelta(hours=1)):
    AuthContext.objects.filter(creator=user).update(
        auth_time=timezone.now() - by)


# --------------------------------------------------------------------------- #
# max_age
# --------------------------------------------------------------------------- #
def test_max_age_0_completes_after_a_fresh_sign_in(browser, member, flow, web_app, keyring):
    sign_in(browser, member)
    asked = flow.evaluate(max_age="0").json()
    assert (asked["action"], asked["reason"]) == ("login", "max_age")
    ticket = asked["login_ticket"]

    reauthenticate(browser, member)
    tokens = flow.run(max_age="0", f2z_login_ticket=ticket)

    claims = id_claims(tokens, keyring, web_app)
    context = AuthContext.objects.get(creator=member)
    assert claims["auth_time"] == int(context.auth_time.timestamp())
    assert claims["amr"] == ["pwd"]
    assert claims["acr"] == "urn:f2z:acr:1fa"


def test_max_age_0_without_the_ticket_still_asks_again(browser, member, flow):
    """Negative control: the ticket is what completes it, not the login."""
    sign_in(browser, member)
    flow.evaluate(max_age="0")
    reauthenticate(browser, member)

    again = flow.evaluate(max_age="0").json()

    assert (again["action"], again["reason"]) == ("login", "max_age")


def test_a_ticket_does_not_make_an_old_sign_in_fresh(browser, member, flow):
    """The ticket proves WHEN sign-in was asked for; a session that signed
    in before that is still too old, ticket or not."""
    sign_in(browser, member)
    ticket = flow.evaluate(max_age="0").json()["login_ticket"]

    # No re-authentication: the same session comes straight back.
    again = flow.evaluate(max_age="0", f2z_login_ticket=ticket).json()

    assert again["action"] == "login"


def test_a_ticket_for_another_request_is_ignored(browser, member, flow, web_app):
    sign_in(browser, member)
    other = Flow(browser, member, web_app, redirect_uri=WEB_REDIRECT, scope="openid profile")
    foreign_ticket = other.evaluate(max_age="0").json()["login_ticket"]
    reauthenticate(browser, member)

    answer = flow.evaluate(max_age="0", f2z_login_ticket=foreign_ticket).json()

    assert answer["action"] == "login"


@pytest.mark.parametrize("ticket", ["1", "garbage", "a:b:c"])
def test_a_forged_ticket_is_ignored_not_an_error(browser, member, flow, ticket):
    sign_in(browser, member)

    answer = flow.evaluate(max_age="0", f2z_login_ticket=ticket)

    assert answer.status_code == 200
    assert answer.json()["action"] == "login"


def test_an_expired_ticket_is_ignored(browser, member, flow, monkeypatch):
    sign_in(browser, member)
    ticket = flow.evaluate(max_age="0").json()["login_ticket"]
    reauthenticate(browser, member)
    later = signing.loads
    monkeypatch.setattr(
        oidc_views.signing, "loads",
        lambda value, **kw: later(value, **{**kw, "max_age": -1}),
    )

    assert flow.evaluate(max_age="0", f2z_login_ticket=ticket).json()["action"] == "login"


def test_a_generous_max_age_needs_no_ticket(browser, member, flow):
    sign_in(browser, member)

    assert flow.evaluate(max_age="300").json()["action"] == "consent"
    age_session(member)
    assert flow.evaluate(max_age="300").json()["reason"] == "max_age"


def test_the_ticket_is_carried_through_the_consent_post(browser, member, flow, monkeypatch):
    """The POST re-runs the gate; the echoed request carries the ticket, so
    the time spent reading the consent screen cannot fail max_age=0."""
    sign_in(browser, member)
    ticket = flow.evaluate(max_age="0").json()["login_ticket"]
    reauthenticate(browser, member)
    evaluated = flow.evaluate(max_age="0", f2z_login_ticket=ticket).json()
    assert evaluated["action"] == "consent"
    assert evaluated["authorization_request"]["f2z_login_ticket"] == ticket
    # Thirty seconds reading the screen.
    real_now = timezone.now
    monkeypatch.setattr(oidc_views.timezone, "now",
                        lambda: real_now() + timedelta(seconds=30))

    decided = flow.decide(evaluated)

    assert decided.status_code == 200
    assert "code" in query_of(decided.json()["redirect_to"])


# --------------------------------------------------------------------------- #
# prompt=login
# --------------------------------------------------------------------------- #
def test_prompt_login_completes_after_a_fresh_sign_in(browser, member, flow):
    sign_in(browser, member)
    asked = flow.evaluate(prompt="login").json()
    assert (asked["action"], asked["reason"]) == ("login", "prompt=login")

    reauthenticate(browser, member)

    # The page drops prompt=login on the way back; a relying party that
    # repeats it is satisfied by the same ticket.
    dropped = flow.evaluate(f2z_login_ticket=asked["login_ticket"]).json()
    kept = flow.evaluate(prompt="login", f2z_login_ticket=asked["login_ticket"]).json()
    assert dropped["action"] == "consent"
    assert kept["action"] == "consent"


def test_prompt_login_without_a_new_sign_in_keeps_asking(browser, member, flow):
    sign_in(browser, member)
    ticket = flow.evaluate(prompt="login").json()["login_ticket"]

    again = flow.evaluate(prompt="login", f2z_login_ticket=ticket).json()

    assert again["action"] == "login"


def test_an_anonymous_login_answer_carries_a_ticket_too(browser, member, flow):
    """Signed out, asked for max_age=0: one sign-in is enough, not two."""
    asked = flow.evaluate(max_age="0").json()
    assert (asked["action"], asked["reason"]) == ("login", "login_required")

    sign_in(browser, member)

    assert flow.evaluate(max_age="0", f2z_login_ticket=asked["login_ticket"]).json()["action"] == "consent"


# --------------------------------------------------------------------------- #
# acr_values and the ID token
# --------------------------------------------------------------------------- #
def test_acr_mfa_needs_a_totp_sign_in_ticket_or_not(browser, member, flow, frozen_totp,
                                                  keyring, web_app):
    sign_in(browser, member)
    asked = flow.evaluate(acr_values=MFA).json()
    assert asked["reason"] == "acr_values"
    # A ticket says when, not how: a password-only sign-in stays 1fa.
    reauthenticate(browser, member)
    assert flow.evaluate(acr_values=MFA, f2z_login_ticket=asked["login_ticket"]).json()["reason"] == "acr_values"

    OTPSecret.objects.create(user=member, secret=TOTP_SECRET, is_active=True)
    reauthenticate(browser, member, otp_token=frozen_totp())
    tokens = flow.run(acr_values=MFA)

    claims = id_claims(tokens, keyring, web_app)
    assert claims["acr"] == MFA
    assert claims["amr"] == ["mfa", "otp", "pwd"]


def test_a_force_login_session_still_fails_closed(api_client, member, web_app):
    """Negative control for the whole file: a session nobody recorded (one
    from before ) is still 'authentication time unknown'."""
    api_client.force_login(member)
    flow = Flow(api_client, member, web_app, redirect_uri=WEB_REDIRECT, scope="openid")

    answer = flow.evaluate(max_age="300").json()

    assert answer["reason"] == "the session's authentication time is unknown"


def test_an_ownership_event_makes_the_session_sign_in_again(browser, member, flow):
    sign_in(browser, member)
    key = browser.session.session_key
    assert flow.evaluate(max_age="300").json()["action"] == "consent"

    bump_account_epoch(member.pk, event=EVENT_PASSWORD_CHANGE)

    # The session itself no longer authenticates (its auth hash is behind),
    # and even a context row left behind is refused by its epoch.
    answer = flow.evaluate(max_age="300").json()
    assert answer["action"] == "login"
    assert AuthContext.objects.filter(creator=member).exists()
    assert AuthContext.objects.current(member, kind="session", key=key) is None


def test_a_logout_forgets_the_context_the_gate_reads(browser, member, flow):
    sign_in(browser, member)
    key = browser.session.session_key
    assert AuthContext.objects.current(member, kind="session", key=key) is not None

    browser.post("/api/auth/logout/")

    assert not AuthContext.objects.filter(creator=member).exists()
