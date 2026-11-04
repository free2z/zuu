"""Regression coverage for every alternate credential issuer.

An enrolled account must present its current TOTP before an alternate login
front door creates a full session or Knox token.  These tests deliberately
exercise the public paths rather than only testing the shared helper: a future
issuer can otherwise bypass the helper while the unit test stays green.
"""

import re
import secrets
from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace

import pyotp
import pyotp.totp
import pytest
from django.test import Client
from django.utils import timezone
from knox.models import AuthToken

from dj.apps.emails.models import Email, PasswordResetToken
from dj.apps.emails.views import PASSWORD_RESET_MFA_ATTEMPT_LIMIT
from dj.apps.otp.models import OTPSecret
from dj.apps.otp.utils import TOTP_ATTEMPT_LIMIT
from dj.apps.social.models import SocialIdentity
from dj.apps.social.views import SOCIAL_MFA_ATTEMPT_LIMIT
from dj.apps.twitter.models import TwitterProfile
from dj.apps.twitter.views import (
    TWITTER_MFA_ATTEMPT_LIMIT,
    TWITTER_OAUTH2_HANDSHAKE_COOKIE,
    sign_oauth2_handshake,
)
from dj.apps.zauth.models import ZcashIdentity


TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
ZCASH_ADDRESS = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
SOCIAL_REDIRECT_URI = "http://localhost:3000/auth/callback"

# 2030-01-01T12:34:15Z -- 15 seconds into its own 30s step, so neither the
# mint nor the verify can land within half a step of a boundary.
#
#every token below used to come from ``pyotp.TOTP(...).now()``, i.e.
# the live wall clock, and was then verified by a real HTTP request some
# milliseconds later. ``dj.apps.otp.utils`` verifies with valid_window=0 on
# purpose, so a run that straddled the 30s step boundary got a genuine
# "Invalid OTP token." and a red gate on an unrelated PR. That is the
# / class;  closed it elsewhere by freezing the clock, and this
# file is where it came back. Do NOT "fix" a recurrence by widening
# valid_window -- the strictness is the security property.
_FROZEN_TS = 1893458055


@pytest.fixture(autouse=True)
def _frozen_totp_clock(monkeypatch):
    """Pin every clock a TOTP round trip touches to ``_FROZEN_TS``.

    BOTH clocks have to move together, mirroring
    ``dj/apps/otp/test_totp_single_use.py``:

    * ``pyotp.totp.datetime`` -- what mints the token and what
      ``TOTP.verify()`` compares against.
    * ``dj.apps.otp.utils.timezone`` -- ``consume_token()`` captures ONE
      instant from it and hands that to pyotp as ``for_time`` while also
      deriving the burned step from it. Freezing only pyotp would leave the
      verification instant on the live clock and reintroduce the straddle.

    Both fakes return instances of the SAME ``FrozenDateTime`` class on
    purpose: once ``pyotp.totp.datetime`` is patched, pyotp's
    ``isinstance(for_time, datetime.datetime)`` gate in ``at()``/``verify()``
    accepts only instances of exactly that class, and a plain ``datetime``
    would fall through to ``int(for_time)`` and raise TypeError.

    The instant is a fixed Unix epoch round-tripped through
    ``fromtimestamp(..., utc)`` rather than naive wall-clock fields, so a
    runner in a non-UTC timezone freezes to the same instant (and
    ``TOTP.timecode()`` takes its tz-aware ``calendar.timegm`` path instead
    of the local-time ``time.mktime`` one).
    """
    import dj.apps.otp.utils as otp_utils

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(_FROZEN_TS, tz)

    monkeypatch.setattr(
        pyotp.totp, "datetime", SimpleNamespace(datetime=FrozenDateTime)
    )

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(_FROZEN_TS, dt_timezone.utc)

    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)
    return _FROZEN_TS


def _enable_totp(user):
    OTPSecret.objects.create(user=user, secret=TOTP_SECRET, is_active=True)
    return _current_totp()


def _current_totp():
    """The token for the pinned step -- never the live clock.

    The instant is built from whatever class currently sits at
    ``pyotp.totp.datetime.datetime``, so it is by construction an instance
    pyotp's isinstance gate accepts, frozen or not.
    """
    return pyotp.TOTP(TOTP_SECRET).at(
        pyotp.totp.datetime.datetime.fromtimestamp(
            _FROZEN_TS, dt_timezone.utc
        )
    )


def _reset_token(user):
    email = Email.objects.create(
        user=user,
        email=f"{user.username}@example.com",
        token=f"email-token-{user.pk}",
        expires_at=timezone.now() + timedelta(days=1),
        confirmed_at=timezone.now(),
    )
    return PasswordResetToken.objects.create(email=email)


@pytest.fixture
def isolated_zcash_admission(settings, request):
    """Keep challenge admission from masking the credential-issuer tests."""
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = (
        f"totp-credential-issuers-{request.node.nodeid}-{secrets.token_hex(8)}"
    )
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": 60,
        "client": 100,
        "address": 100,
    }
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {
        "window_seconds": 60,
        "client": 100,
    }


def _zcash_challenge(api_client):
    response = api_client.post(
        "/api/auth/zcash/challenge/",
        {"address": ZCASH_ADDRESS},
        format="json",
    )
    assert response.status_code == 200, response.content
    return response.data["challenge"]


@pytest.mark.django_db
def test_password_reset_requires_totp_before_session_issuance(
    api_client, creator_factory,
):
    user = creator_factory(password="old-password")
    _enable_totp(user)
    reset_token = _reset_token(user)

    rejected = api_client.post(
        "/api/emails/do-reset-password",
        {"token": str(reset_token.token), "password": "new-password"},
        format="json",
    )

    assert rejected.status_code == 400, rejected.content
    assert rejected.json() == {
        "message": "Invalid OTP token.",
        "code": "invalid_otp",
    }
    assert not api_client.session.get("_auth_user_id")
    reset_token.refresh_from_db()
    assert reset_token.used is False
    assert user.check_password("old-password")

    accepted = api_client.post(
        "/api/emails/do-reset-password",
        {
            "token": str(reset_token.token),
            "password": "new-password",
            "otp_token": _current_totp(),
        },
        format="json",
    )

    assert accepted.status_code == 200, accepted.content
    assert api_client.session.get("_auth_user_id") == str(user.pk)
    reset_token.refresh_from_db()
    assert reset_token.used is True
    user.refresh_from_db()
    assert user.check_password("new-password")


@pytest.mark.django_db
def test_password_reset_limits_totp_attempts_per_reset_token(
    api_client, creator_factory,
):
    user = creator_factory(password="old-password")
    _enable_totp(user)
    reset_token = _reset_token(user)
    body = {
        "token": str(reset_token.token),
        "password": "new-password",
        "otp_token": "000000",
    }

    for attempt in range(PASSWORD_RESET_MFA_ATTEMPT_LIMIT):
        rejected = api_client.post(
            "/api/emails/do-reset-password",
            body,
            format="json",
        )
        expected = (
            429
            if attempt == PASSWORD_RESET_MFA_ATTEMPT_LIMIT - 1
            else 400
        )
        assert rejected.status_code == expected, rejected.content
        # The last wrong code spends this link's MFA budget: the
        # client must be told to request a new link, not to retry the code.
        assert rejected.json()["code"] == (
            "otp_attempts_exhausted"
            if attempt == PASSWORD_RESET_MFA_ATTEMPT_LIMIT - 1
            else "invalid_otp"
        )

    blocked = api_client.post(
        "/api/emails/do-reset-password",
        {
            **body,
            "otp_token": _current_totp(),
        },
        format="json",
    )

    assert blocked.status_code == 429, blocked.content
    assert blocked.json()["code"] == "otp_attempts_exhausted"
    reset_token.refresh_from_db()
    assert reset_token.used is False
    user.refresh_from_db()
    assert user.check_password("old-password")


@pytest.mark.django_db
def test_password_reset_weak_password_spends_no_mfa_attempt_or_code(
    api_client, creator_factory,
):
    """: a refused password must leave the link exactly as usable.

    The client answers a weak password with "choose a different password —
    your reset link still works". When the password was validated AFTER the
    TOTP, a weak password consumed the authenticator code and claimed one of
    this link's MFA attempts: on the last attempt the link was burned while
    the reader was told it still worked, and an immediate retry with the same
    (now spent) code failed. Validate first, and neither is spent.
    """
    user = creator_factory(password="old-password")
    _enable_totp(user)
    reset_token = _reset_token(user)

    # Leave exactly one MFA attempt on this link.
    for _ in range(PASSWORD_RESET_MFA_ATTEMPT_LIMIT - 1):
        rejected = api_client.post(
            "/api/emails/do-reset-password",
            {
                "token": str(reset_token.token),
                "password": "new-password",
                "otp_token": "000000",
            },
            format="json",
        )
        assert rejected.status_code == 400, rejected.content

    weak = api_client.post(
        "/api/emails/do-reset-password",
        {
            "token": str(reset_token.token),
            "password": "password123",
            "otp_token": _current_totp(),
        },
        format="json",
    )
    assert weak.status_code == 400, weak.content
    assert weak.json()["code"] == "password_invalid"

    # The same code, the last attempt, a good password: it still works.
    accepted = api_client.post(
        "/api/emails/do-reset-password",
        {
            "token": str(reset_token.token),
            "password": "new-password",
            "otp_token": _current_totp(),
        },
        format="json",
    )
    assert accepted.status_code == 200, accepted.content
    user.refresh_from_db()
    assert user.check_password("new-password")


@pytest.mark.django_db
def test_change_password_requires_totp_before_refreshing_session(
    api_client, creator_factory,
):
    user = creator_factory(password="old-password")
    _enable_totp(user)
    api_client.force_authenticate(user=user)

    rejected = api_client.post(
        "/api/emails/change-password",
        {"old_password": "old-password", "new_password": "new-password"},
        format="json",
    )

    assert rejected.status_code == 400, rejected.content
    assert rejected.json() == {"otp_token": ["Invalid OTP token."]}
    user.refresh_from_db()
    assert user.check_password("old-password")

    accepted = api_client.post(
        "/api/emails/change-password",
        {
            "old_password": "old-password",
            "new_password": "new-password",
            "otp_token": _current_totp(),
        },
        format="json",
    )

    assert accepted.status_code == 200, accepted.content
    user.refresh_from_db()
    assert user.check_password("new-password")


@pytest.mark.django_db
def test_dj_rest_auth_password_change_requires_totp(
    api_client, creator_factory,
):
    user = creator_factory(password="old-password")
    _enable_totp(user)
    api_client.force_authenticate(user=user)

    # The current password is now required on this route too; pass it
    # so what this test measures stays "TOTP is enforced" and not "some other
    # field was missing".
    rejected = api_client.post(
        "/api/auth/password/change/",
        {
            "old_password": "old-password",
            "new_password1": "new-password",
            "new_password2": "new-password",
        },
        format="json",
    )

    assert rejected.status_code == 400, rejected.content
    assert rejected.json() == {"otp_token": ["Invalid OTP token."]}
    user.refresh_from_db()
    assert user.check_password("old-password")

    accepted = api_client.post(
        "/api/auth/password/change/",
        {
            "old_password": "old-password",
            "new_password1": "new-password",
            "new_password2": "new-password",
            "otp_token": _current_totp(),
        },
        format="json",
    )

    assert accepted.status_code == 200, accepted.content
    user.refresh_from_db()
    assert user.check_password("new-password")


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("path", "payload"),
    [
        (
            "/api/emails/change-password",
            {
                "old_password": "old-password",
                "new_password": "new-password",
            },
        ),
        (
            "/api/auth/password/change/",
            {
                "old_password": "old-password",
                "new_password1": "new-password",
                "new_password2": "new-password",
            },
        ),
    ],
)
def test_password_change_limits_totp_attempts(
    api_client, creator_factory, path, payload,
):
    user = creator_factory(password="old-password")
    _enable_totp(user)
    api_client.force_authenticate(user=user)

    for attempt in range(TOTP_ATTEMPT_LIMIT):
        rejected = api_client.post(
            path,
            {**payload, "otp_token": "000000"},
            format="json",
        )
        expected = 429 if attempt == TOTP_ATTEMPT_LIMIT - 1 else 400
        assert rejected.status_code == expected, rejected.content

    blocked = api_client.post(
        path,
        {**payload, "otp_token": _current_totp()},
        format="json",
    )

    assert blocked.status_code == 429, blocked.content
    user.refresh_from_db()
    assert user.check_password("old-password")


@pytest.mark.django_db
def test_social_login_requires_totp_for_an_existing_creator(
    api_client, creator_factory, mocker, settings,
):
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.SOCIAL_REDIRECT_URI_ALLOWLIST = [SOCIAL_REDIRECT_URI]
    user = creator_factory()
    _enable_totp(user)
    SocialIdentity.objects.create(
        creator=user,
        provider="google",
        provider_uid="existing-google-user",
        handle="existing@example.com",
    )
    mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={
            "uid": "existing-google-user",
            "handle": "existing@example.com",
            "avatar_url": "",
        },
    )

    start = api_client.get(
        "/api/auth/social/google/start",
        {"redirect_uri": SOCIAL_REDIRECT_URI},
    )
    assert start.status_code == 200, start.content
    body = {
        "code": "provider-code",
        "state": start.data["state"],
        "redirect_uri": SOCIAL_REDIRECT_URI,
    }
    rejected = api_client.post(
        "/api/auth/social/google/", body, format="json"
    )

    assert rejected.status_code == 400, rejected.content
    assert rejected.json() == {"detail": "Invalid OTP token."}
    assert AuthToken.objects.filter(user=user).count() == 0

    start = api_client.get(
        "/api/auth/social/google/start",
        {"redirect_uri": SOCIAL_REDIRECT_URI},
    )
    body.update({"state": start.data["state"], "otp_token": _current_totp()})
    accepted = api_client.post(
        "/api/auth/social/google/", body, format="json"
    )

    assert accepted.status_code == 200, accepted.content
    assert accepted.data["token"]
    assert AuthToken.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_social_association_requires_totp_before_issuing_token(
    api_client, creator_factory, mocker, settings,
    recent_login,
):
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.SOCIAL_REDIRECT_URI_ALLOWLIST = [SOCIAL_REDIRECT_URI]
    user = creator_factory()
    _enable_totp(user)
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)
    mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={
            "uid": "association-google-user",
            "handle": "association@example.com",
            "avatar_url": "",
        },
    )

    start = api_client.get(
        "/api/auth/social/google/start",
        {"redirect_uri": SOCIAL_REDIRECT_URI},
    )
    body = {
        "code": "provider-code",
        "state": start.data["state"],
        "redirect_uri": SOCIAL_REDIRECT_URI,
    }
    rejected = api_client.post(
        "/api/auth/social/google/", body, format="json"
    )

    assert rejected.status_code == 400, rejected.content
    assert rejected.json() == {"detail": "Invalid OTP token."}
    assert not SocialIdentity.objects.filter(
        provider_uid="association-google-user"
    ).exists()
    assert AuthToken.objects.filter(user=user).count() == 0

    start = api_client.get(
        "/api/auth/social/google/start",
        {"redirect_uri": SOCIAL_REDIRECT_URI},
    )
    body.update({"state": start.data["state"], "otp_token": _current_totp()})
    accepted = api_client.post(
        "/api/auth/social/google/", body, format="json"
    )

    assert accepted.status_code == 200, accepted.content
    assert accepted.data["token"]
    assert SocialIdentity.objects.filter(
        provider_uid="association-google-user", creator=user
    ).exists()


@pytest.mark.django_db
def test_social_login_limits_totp_attempts(
    api_client, creator_factory, mocker, settings,
):
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.SOCIAL_REDIRECT_URI_ALLOWLIST = [SOCIAL_REDIRECT_URI]
    user = creator_factory()
    _enable_totp(user)
    SocialIdentity.objects.create(
        creator=user,
        provider="google",
        provider_uid="rate-limited-google-user",
        handle="rate-limited@example.com",
    )
    mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={
            "uid": "rate-limited-google-user",
            "handle": "rate-limited@example.com",
            "avatar_url": "",
        },
    )

    for attempt in range(SOCIAL_MFA_ATTEMPT_LIMIT):
        start = api_client.get(
            "/api/auth/social/google/start",
            {"redirect_uri": SOCIAL_REDIRECT_URI},
        )
        rejected = api_client.post(
            "/api/auth/social/google/",
            {
                "code": "provider-code",
                "state": start.data["state"],
                "redirect_uri": SOCIAL_REDIRECT_URI,
                "otp_token": "000000",
            },
            format="json",
        )
        expected = 429 if attempt == SOCIAL_MFA_ATTEMPT_LIMIT - 1 else 400
        assert rejected.status_code == expected, rejected.content

    start = api_client.get(
        "/api/auth/social/google/start",
        {"redirect_uri": SOCIAL_REDIRECT_URI},
    )
    blocked = api_client.post(
        "/api/auth/social/google/",
        {
            "code": "provider-code",
            "state": start.data["state"],
            "redirect_uri": SOCIAL_REDIRECT_URI,
            "otp_token": _current_totp(),
        },
        format="json",
    )
    assert blocked.status_code == 429, blocked.content
    assert AuthToken.objects.filter(user=user).count() == 0


@pytest.mark.django_db
def test_zcash_login_requires_totp_for_an_existing_creator(
    api_client, creator_factory, mocker, isolated_zcash_admission,
):
    user = creator_factory()
    _enable_totp(user)
    ZcashIdentity.objects.create(creator=user, zcash_address=ZCASH_ADDRESS)
    mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )

    challenge = _zcash_challenge(api_client)
    body = {
        "address": ZCASH_ADDRESS,
        "challenge": challenge,
        "signature": "valid-signature",
    }
    rejected = api_client.post(
        "/api/auth/zcash/login/", body, format="json"
    )

    assert rejected.status_code == 400, rejected.content
    assert rejected.json() == {"detail": "Invalid OTP token."}
    assert AuthToken.objects.filter(user=user).count() == 0

    challenge = _zcash_challenge(api_client)
    body.update({"challenge": challenge, "otp_token": _current_totp()})
    accepted = api_client.post(
        "/api/auth/zcash/login/", body, format="json"
    )

    assert accepted.status_code == 200, accepted.content
    assert accepted.data["token"]
    assert AuthToken.objects.filter(user=user).count() == 1


@pytest.mark.django_db
def test_zcash_login_limits_totp_attempts_across_fresh_challenges(
    api_client, creator_factory, mocker, isolated_zcash_admission,
):
    user = creator_factory()
    _enable_totp(user)
    ZcashIdentity.objects.create(creator=user, zcash_address=ZCASH_ADDRESS)
    mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )

    for attempt in range(TOTP_ATTEMPT_LIMIT):
        challenge = _zcash_challenge(api_client)
        rejected = api_client.post(
            "/api/auth/zcash/login/",
            {
                "address": ZCASH_ADDRESS,
                "challenge": challenge,
                "signature": "valid-signature",
                "otp_token": "000000",
            },
            format="json",
        )
        expected = 429 if attempt == TOTP_ATTEMPT_LIMIT - 1 else 400
        assert rejected.status_code == expected, rejected.content

    challenge = _zcash_challenge(api_client)
    blocked = api_client.post(
        "/api/auth/zcash/login/",
        {
            "address": ZCASH_ADDRESS,
            "challenge": challenge,
            "signature": "valid-signature",
            "otp_token": _current_totp(),
        },
        format="json",
    )

    assert blocked.status_code == 429, blocked.content
    assert AuthToken.objects.filter(user=user).count() == 0


@pytest.mark.django_db
def test_zcash_association_requires_totp_before_issuing_token(
    api_client, creator_factory, mocker, isolated_zcash_admission,
    recent_login,
):
    user = creator_factory()
    _enable_totp(user)
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)
    mocker.patch(
        "dj.apps.zauth.views.verify_zcash_signature", return_value=True
    )

    challenge = _zcash_challenge(api_client)
    body = {
        "address": ZCASH_ADDRESS,
        "challenge": challenge,
        "signature": "valid-signature",
    }
    rejected = api_client.post(
        "/api/auth/zcash/login/", body, format="json"
    )

    assert rejected.status_code == 400, rejected.content
    assert rejected.json() == {"detail": "Invalid OTP token."}
    assert not ZcashIdentity.objects.filter(
        zcash_address=ZCASH_ADDRESS
    ).exists()
    assert AuthToken.objects.filter(user=user).count() == 0

    challenge = _zcash_challenge(api_client)
    body.update({"challenge": challenge, "otp_token": _current_totp()})
    accepted = api_client.post(
        "/api/auth/zcash/login/", body, format="json"
    )

    assert accepted.status_code == 200, accepted.content
    assert accepted.data["token"]
    assert ZcashIdentity.objects.filter(
        zcash_address=ZCASH_ADDRESS, creator=user
    ).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("send_origin", [True, False])
def test_twitter_callback_holds_existing_mfa_login_until_totp(
    creator_factory, mocker, send_origin,
):
    # Production is HTTPS and this is a browser form, not a DRF request.
    # APIClient's default bypasses the CSRF middleware that rejected real users.
    api_client = Client(enforce_csrf_checks=True)
    user = creator_factory()
    _enable_totp(user)
    TwitterProfile.objects.create(
        creator=user,
        twitter_id="twitter-existing-user",
        username="twitter-existing-user",
        allow_login=True,
    )
    # The OAuth2 handshake rides in a signed cookie, not the session.
    api_client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = (
        sign_oauth2_handshake("twitter-state", "verifier")
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": "twitter-existing-user",
            "username": "twitter-existing-user",
            "name": "Existing User",
            "description": "",
            "profile_image_url": "",
        },
    )

    pending = api_client.get(
        "/api/twitter/callback",
        {"state": "twitter-state", "code": "provider-code"},
        secure=True,
    )

    assert pending.status_code == 200, pending.content
    assert b"Two-factor authentication" in pending.content
    assert not api_client.session.get("_auth_user_id")

    # Both policy sources must allow the same-origin form submission while
    # stripping the callback's OAuth code/state from outgoing Referer values.
    assert pending["Referrer-Policy"] == "strict-origin"
    assert b'<meta name="referrer" content="strict-origin">' in pending.content
    csrf_token = re.search(
        rb'name="csrfmiddlewaretoken" value="([^\"]+)"', pending.content
    ).group(1).decode()
    headers = {"HTTP_REFERER": "https://testserver/"}
    if send_origin:
        headers["HTTP_ORIGIN"] = "https://testserver"

    # Changing policy must not exempt this credential issuer from CSRF.
    missing_csrf = api_client.post(
        "/api/twitter/callback", {"otp_token": _current_totp()},
        secure=True, **headers,
    )
    assert missing_csrf.status_code == 403
    foreign_origin = api_client.post(
        "/api/twitter/callback",
        {"otp_token": _current_totp(), "csrfmiddlewaretoken": csrf_token},
        secure=True, HTTP_ORIGIN="https://attacker.example",
    )
    assert foreign_origin.status_code == 403
    assert not api_client.session.get("_auth_user_id")

    invalid_code = api_client.post(
        "/api/twitter/callback",
        {"otp_token": "000000", "csrfmiddlewaretoken": csrf_token},
        secure=True, **headers,
    )
    assert invalid_code.status_code == 400
    assert invalid_code["Referrer-Policy"] == "strict-origin"
    assert b'<meta name="referrer" content="strict-origin">' in invalid_code.content
    assert not api_client.session.get("_auth_user_id")

    accepted = api_client.post(
        "/api/twitter/callback",
        {"otp_token": _current_totp(), "csrfmiddlewaretoken": csrf_token},
        secure=True, **headers,
    )

    assert accepted.status_code == 302, accepted.content
    assert accepted["Location"] == "/profile"
    assert api_client.session.get("_auth_user_id") == str(user.pk)


@pytest.mark.django_db
def test_twitter_mfa_sign_in_returns_to_the_sdk_page_it_started_from(
    creator_factory, mocker,
):
    """: the return path an SDK-facing page asked for survives the TOTP
    step -- kept in the session's pending dict, never a form field -- and
    the POST lands there instead of /profile."""
    api_client = Client(enforce_csrf_checks=True)
    user = creator_factory()
    _enable_totp(user)
    TwitterProfile.objects.create(
        creator=user, twitter_id="twitter-mfa-sdk", username="twitter-mfa-sdk",
        allow_login=True,
    )
    api_client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = (
        sign_oauth2_handshake("mfa-sdk-state", "verifier", "/account/delete")
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": "twitter-mfa-sdk", "username": "twitter-mfa-sdk",
            "name": "MFA", "description": "", "profile_image_url": "",
        },
    )
    pending = api_client.get(
        "/api/twitter/callback",
        {"state": "mfa-sdk-state", "code": "provider-code"}, secure=True,
    )
    assert pending.status_code == 200, pending.content
    csrf_token = re.search(
        rb'name="csrfmiddlewaretoken" value="([^\"]+)"', pending.content
    ).group(1).decode()
    accepted = api_client.post(
        "/api/twitter/callback",
        # A `next` in the form is ignored: the destination is the session's.
        {"otp_token": _current_totp(), "csrfmiddlewaretoken": csrf_token,
         "next": "/buy-2z"},
        secure=True, HTTP_REFERER="https://testserver/",
        HTTP_ORIGIN="https://testserver",
    )
    assert accepted.status_code == 302, accepted.content
    assert accepted["Location"] == "/account/delete"
    assert api_client.session.get("_auth_user_id") == str(user.pk)


@pytest.mark.django_db
def test_twitter_callback_limits_totp_attempts(
    api_client, creator_factory, mocker,
):
    user = creator_factory()
    _enable_totp(user)
    TwitterProfile.objects.create(
        creator=user,
        twitter_id="twitter-rate-limited-user",
        username="twitter-rate-limited-user",
        allow_login=True,
    )
    # The OAuth2 handshake rides in a signed cookie, not the session.
    api_client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = (
        sign_oauth2_handshake("twitter-rate-limited-state", "verifier")
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": "twitter-rate-limited-user",
            "username": "twitter-rate-limited-user",
            "name": "Rate Limited User",
            "description": "",
            "profile_image_url": "",
        },
    )

    pending = api_client.get(
        "/api/twitter/callback",
        {
            "state": "twitter-rate-limited-state",
            "code": "provider-code",
        },
    )
    assert pending.status_code == 200, pending.content

    for attempt in range(TWITTER_MFA_ATTEMPT_LIMIT):
        rejected = api_client.post(
            "/api/twitter/callback",
            {"otp_token": "000000"},
            format="multipart",
        )
        expected = 429 if attempt == TWITTER_MFA_ATTEMPT_LIMIT - 1 else 400
        assert rejected.status_code == expected, rejected.content
        assert not api_client.session.get("_auth_user_id")

    blocked = api_client.post(
        "/api/twitter/callback",
        {"otp_token": _current_totp()},
        format="multipart",
    )
    assert blocked.status_code == 400, blocked.content
    assert b"Invalid or expired Twitter login" in blocked.content


@pytest.mark.django_db
def test_twitter_mfa_success_resets_attempt_counter(
    api_client, creator_factory, mocker,
):
    user = creator_factory()
    _enable_totp(user)
    TwitterProfile.objects.create(
        creator=user,
        twitter_id="twitter-counter-reset-user",
        username="twitter-counter-reset-user",
        allow_login=True,
    )
    # The OAuth2 handshake rides in a signed cookie, not the session.
    api_client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = (
        sign_oauth2_handshake("twitter-counter-reset-state", "verifier")
    )
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": "twitter-counter-reset-user",
            "username": "twitter-counter-reset-user",
            "name": "Counter Reset User",
            "description": "",
            "profile_image_url": "",
        },
    )

    pending = api_client.get(
        "/api/twitter/callback",
        {
            "state": "twitter-counter-reset-state",
            "code": "provider-code",
        },
    )
    assert pending.status_code == 200, pending.content

    for _ in range(TWITTER_MFA_ATTEMPT_LIMIT - 1):
        rejected = api_client.post(
            "/api/twitter/callback",
            {"otp_token": "000000"},
            format="multipart",
        )
        assert rejected.status_code == 400, rejected.content

    accepted = api_client.post(
        "/api/twitter/callback",
        {"otp_token": _current_totp()},
        format="multipart",
    )
    assert accepted.status_code == 302, accepted.content

    api_client.logout()
    # The OAuth2 handshake rides in a signed cookie, not the session.
    api_client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = (
        sign_oauth2_handshake("twitter-counter-reset-state-2", "verifier")
    )
    pending = api_client.get(
        "/api/twitter/callback",
        {
            "state": "twitter-counter-reset-state-2",
            "code": "provider-code",
        },
    )
    assert pending.status_code == 200, pending.content

    first_retry = api_client.post(
        "/api/twitter/callback",
        {"otp_token": "000000"},
        format="multipart",
    )
    assert first_retry.status_code == 400, first_retry.content
