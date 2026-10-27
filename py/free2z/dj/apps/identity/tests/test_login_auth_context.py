"""Every sign-in path records an AuthContext; every logout forgets it.

Each path is driven through its public endpoint against real Postgres, and
each has a negative control: the same request failing authentication must
leave NO context behind, so a test that passes because "something" wrote a
row cannot pass here. The amr each path records:

* ``/api/auth/login/``          pwd                (+ otp mfa with TOTP)
* ``/api/otp/login/``           pwd otp mfa
* ``/api/token/login/``         inherited from the presenting credential
* ``/api/auth/social/<p>/``     fed:<p>            (+ otp mfa with TOTP)
* ``/api/auth/zcash/login/``    zec                (+ otp mfa with TOTP)
* ``/api/twitter/callback``     fed:twitter        (+ otp mfa with TOTP)
* ``/api/emails/do-reset-password``  pwd           (+ otp mfa with TOTP)
* ``/api/emails/change-password``    pwd           (+ otp mfa with TOTP)

The TOTP clock is frozen exactly as ``dj/apps/test_totp_credential_issuers.py``
freezes it: a live-clock code can straddle a step boundary.
"""
import secrets
from datetime import datetime, timedelta, timezone as dt_timezone
from types import SimpleNamespace

import pyotp
import pyotp.totp
import pytest
from django.test import Client
from django.utils import timezone
from knox.crypto import hash_token
from knox.models import AuthToken
from rest_framework.test import APIClient

from dj.apps.emails.models import Email, PasswordResetToken
from dj.apps.g12f.models import Creator
from dj.apps.identity.auth_context import ACR_1FA, ACR_MFA
from dj.apps.identity.models import AuthContext
from dj.apps.ktauth.epoch import EVENT_PASSWORD_CHANGE, bump_account_epoch
from dj.apps.otp.models import OTPSecret
from dj.apps.social.models import SocialIdentity
from dj.apps.twitter.models import TwitterProfile
from dj.apps.twitter.views import (
    TWITTER_OAUTH2_HANDSHAKE_COOKIE,
    sign_oauth2_handshake,
)
from dj.apps.zauth.models import ZcashIdentity

pytestmark = pytest.mark.django_db

TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
_FROZEN_TS = 1893458055
PASSWORD = "correct-horse-battery"
ZCASH_ADDRESS = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
SOCIAL_REDIRECT_URI = "http://localhost:3000/auth/callback"


# --------------------------------------------------------------------------- #
# Fixtures and helpers
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _frozen_totp_clock(monkeypatch):
    """Both TOTP clocks pinned together; see test_totp_credential_issuers."""
    import dj.apps.otp.utils as otp_utils

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(_FROZEN_TS, tz)

    monkeypatch.setattr(
        pyotp.totp, "datetime", SimpleNamespace(datetime=FrozenDateTime))

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(_FROZEN_TS, dt_timezone.utc)

    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)


@pytest.fixture(autouse=True)
def _captcha_passes(monkeypatch):
    # pytest runs with DEBUG=False, so the serializer's 'test' bypass is off;
    # stub siteverify like the other creator-login tests do.
    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post",
        lambda _url, **_kw: SimpleNamespace(json=lambda: {"success": True}),
    )


@pytest.fixture(autouse=True)
def _clean_caches():
    from django.core.cache import cache

    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def isolated_zcash_admission(settings, request):
    settings.ZCASH_AUTH_ADMISSION_NAMESPACE = (
        f"authctx-{request.node.nodeid}-{secrets.token_hex(8)}")
    settings.ZCASH_CHALLENGE_ADMISSION_LIMITS = {
        "window_seconds": 60, "client": 100, "address": 100}
    settings.ZCASH_LOGIN_ADMISSION_LIMITS = {"window_seconds": 60, "client": 100}


@pytest.fixture
def google(settings):
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.SOCIAL_REDIRECT_URI_ALLOWLIST = [SOCIAL_REDIRECT_URI]
    return settings


def _totp():
    return pyotp.TOTP(TOTP_SECRET).at(
        pyotp.totp.datetime.datetime.fromtimestamp(_FROZEN_TS, dt_timezone.utc))


def _enable_totp(user):
    OTPSecret.objects.create(user=user, secret=TOTP_SECRET, is_active=True)


def _fresh(user):
    return Creator.objects.get(pk=user.pk)


def _session_context(client, user):
    key = client.session.session_key
    assert key, "no session"
    return AuthContext.objects.current(_fresh(user), kind="session", key=key)


def _knox_context(user, raw_token):
    return AuthContext.objects.current(
        _fresh(user), kind="knox", key=hash_token(raw_token))


def _assert_fresh(context, amr, acr):
    assert context is not None, "no AuthContext was recorded"
    assert context.amr == sorted(amr)
    assert context.acr == acr
    assert timezone.now() - context.auth_time < timedelta(seconds=30)


def _password_login(client, user, **extra):
    return client.post("/api/auth/login/", {
        "username": user.username, "password": PASSWORD,
        "captcha_result": "ci-valid-captcha", **extra,
    }, format="json")


# --------------------------------------------------------------------------- #
# Password: /api/auth/login/
# --------------------------------------------------------------------------- #
def test_password_login_records_pwd_on_the_rotated_session(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    # A session exists before the login; `login()` must cycle it and the
    # context must follow the NEW key, not the one the browser had before.
    before = api_client.session
    before["probe"] = 1
    before.save()
    old_key = before.session_key

    response = _password_login(api_client, user)

    assert response.status_code == 204, response.content
    new_key = api_client.session.session_key
    assert new_key and new_key != old_key
    _assert_fresh(_session_context(api_client, user), ["pwd"], ACR_1FA)
    assert AuthContext.objects.current(_fresh(user), kind="session", key=old_key) is None
    assert AuthContext.objects.filter(creator=user).count() == 1


def test_password_login_with_totp_records_mfa(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    _enable_totp(user)

    response = _password_login(api_client, user, otp_token=_totp())

    assert response.status_code == 204, response.content
    _assert_fresh(_session_context(api_client, user), ["pwd", "otp", "mfa"], ACR_MFA)


def test_a_failed_password_login_records_nothing(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    _enable_totp(user)

    wrong_password = api_client.post("/api/auth/login/", {
        "username": user.username, "password": "nope",
        "captcha_result": "ci-valid-captcha", "otp_token": _totp(),
    }, format="json")
    wrong_code = _password_login(api_client, user, otp_token="000000")

    assert wrong_password.status_code == 400
    assert wrong_code.status_code == 400
    assert not AuthContext.objects.exists()


def test_inactive_password_login_is_clear_and_creates_no_credential(
    api_client, creator_factory,
):
    user = creator_factory(password=PASSWORD)
    Creator.objects.filter(pk=user.pk).update(is_active=False)

    response = _password_login(api_client, user)

    assert response.status_code == 400
    assert response.json()["non_field_errors"] == [
        "This account is inactive and cannot sign in."
    ]
    assert "_auth_user_id" not in api_client.session
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.filter(creator=user).exists()


# --------------------------------------------------------------------------- #
# Password + OTP: /api/otp/login/
# --------------------------------------------------------------------------- #
def test_otp_login_records_pwd_otp_mfa(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    _enable_totp(user)

    response = api_client.post("/api/otp/login/", {
        "username": user.username, "password": PASSWORD, "token": _totp(),
    }, format="json")

    assert response.status_code == 200, response.content
    _assert_fresh(_session_context(api_client, user), ["pwd", "otp", "mfa"], ACR_MFA)


def test_a_failed_otp_login_records_nothing(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    _enable_totp(user)

    response = api_client.post("/api/otp/login/", {
        "username": user.username, "password": PASSWORD, "token": "000000",
    }, format="json")

    assert response.status_code == 400
    assert not AuthContext.objects.exists()


def test_inactive_totp_login_is_clear_and_creates_no_credential(
    api_client, creator_factory,
):
    user = creator_factory(password=PASSWORD)
    _enable_totp(user)
    Creator.objects.filter(pk=user.pk).update(is_active=False)

    response = api_client.post("/api/otp/login/", {
        "username": user.username, "password": PASSWORD, "token": _totp(),
    }, format="json")

    assert response.status_code == 403
    assert response.json()["message"] == (
        "This account is inactive and cannot sign in."
    )
    assert "_auth_user_id" not in api_client.session
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.filter(creator=user).exists()


# --------------------------------------------------------------------------- #
# Knox exchange: /api/token/login/
# --------------------------------------------------------------------------- #
def test_a_token_minted_from_a_session_inherits_its_context(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    _enable_totp(user)
    assert _password_login(api_client, user, otp_token=_totp()).status_code == 204
    session_context = _session_context(api_client, user)

    minted = api_client.post("/api/token/login/")

    assert minted.status_code == 200, minted.content
    token_context = _knox_context(user, minted.json()["token"])
    assert token_context is not None
    assert token_context.pk != session_context.pk
    assert token_context.auth_time == session_context.auth_time
    assert token_context.amr == session_context.amr == ["mfa", "otp", "pwd"]
    assert token_context.acr == ACR_MFA


def test_a_token_minted_from_a_token_inherits_its_context(creator_factory, mocker,
                                                          isolated_zcash_admission):
    """A Knox token exchanged for another Knox token passes its context on."""
    user = creator_factory()
    ZcashIdentity.objects.create(
        creator=user, zcash_address=ZCASH_ADDRESS,
        linked_at_epoch=user.kt_account_epoch)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    client = APIClient()
    first = _zcash_login(client)["token"]
    client.credentials(HTTP_AUTHORIZATION=f"Token {first}")

    minted = client.post("/api/token/login/")

    assert minted.status_code == 200, minted.content
    second = _knox_context(user, minted.json()["token"])
    assert second is not None
    assert second.auth_time == _knox_context(user, first).auth_time
    assert second.amr == ["zec"]


def test_an_exchange_never_mints_a_fresh_auth_time(api_client, creator_factory):
    """Negative control: a session with NO context (signed in before this
    shipped) must not launder itself into a token with auth_time = now."""
    user = creator_factory(password=PASSWORD)
    api_client.force_login(user)

    minted = api_client.post("/api/token/login/")

    assert minted.status_code == 200, minted.content
    assert _knox_context(user, minted.json()["token"]) is None
    assert not AuthContext.objects.exists()


def test_an_old_context_stays_old_through_an_exchange(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    old = timezone.now() - timedelta(seconds=30)
    AuthContext.objects.filter(creator=user).update(auth_time=old)

    minted = api_client.post("/api/token/login/")

    assert _knox_context(user, minted.json()["token"]).auth_time == old


# --------------------------------------------------------------------------- #
# Social: /api/auth/social/<provider>/
# --------------------------------------------------------------------------- #
def _social_login(client, mocker, *, uid="google-user", otp_token=None):
    mocker.patch("dj.apps.social.views.exchange_identity", return_value={
        "uid": uid, "handle": f"{uid}@example.com", "avatar_url": ""})
    start = client.get("/api/auth/social/google/start",
                       {"redirect_uri": SOCIAL_REDIRECT_URI})
    assert start.status_code == 200, start.content
    body = {"code": "provider-code", "state": start.data["state"],
            "redirect_uri": SOCIAL_REDIRECT_URI}
    if otp_token is not None:
        body["otp_token"] = otp_token
    return client.post("/api/auth/social/google/", body, format="json")


def test_social_login_records_fed_provider_on_the_token(api_client, google, mocker):
    response = _social_login(api_client, mocker)

    assert response.status_code == 200, response.content
    creator = SocialIdentity.objects.get(provider_uid="google-user").creator
    _assert_fresh(_knox_context(creator, response.data["token"]),
                  ["fed:google"], ACR_1FA)


def test_inactive_social_login_is_clear_and_creates_no_credential(
    api_client, google, mocker, creator_factory,
):
    user = creator_factory()
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="inactive-social",
        handle="inactive@example.com", linked_at_epoch=user.kt_account_epoch,
    )
    Creator.objects.filter(pk=user.pk).update(is_active=False)

    response = _social_login(api_client, mocker, uid="inactive-social")

    assert response.status_code == 403
    assert response.data["detail"] == (
        "This account is inactive and cannot sign in."
    )
    assert "_auth_user_id" not in api_client.session
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.filter(creator=user).exists()


def test_social_login_with_totp_records_mfa(api_client, google, mocker, creator_factory):
    user = creator_factory()
    _enable_totp(user)
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="existing",
        handle="existing@example.com", linked_at_epoch=user.kt_account_epoch)

    rejected = _social_login(api_client, mocker, uid="existing")
    assert rejected.status_code == 400
    assert not AuthContext.objects.exists()

    accepted = _social_login(api_client, mocker, uid="existing", otp_token=_totp())
    assert accepted.status_code == 200, accepted.content
    _assert_fresh(_knox_context(user, accepted.data["token"]),
                  ["fed:google", "otp", "mfa"], ACR_MFA)


def test_a_social_association_inherits_the_callers_context(api_client, google, mocker,
                                                          creator_factory):
    """A permitted recent association inherits rather than refreshes auth_time."""
    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    old = timezone.now() - timedelta(seconds=30)
    AuthContext.objects.filter(creator=user).update(auth_time=old)

    linked = _social_login(api_client, mocker, uid="attacker-google")

    assert linked.status_code == 200, linked.content
    assert linked.data["linked"] is True
    context = _knox_context(user, linked.data["token"])
    assert context is not None and context.auth_time == old
    assert context.amr == ["pwd"]


def test_a_social_association_from_an_unrecorded_session_gets_nothing(
        api_client, google, mocker, creator_factory):
    user = creator_factory(password=PASSWORD)
    api_client.force_login(user)

    linked = _social_login(api_client, mocker, uid="attacker-google")

    assert linked.status_code == 401, linked.content
    assert not SocialIdentity.objects.filter(creator=user).exists()
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.exists()


# --------------------------------------------------------------------------- #
# Zcash: /api/auth/zcash/login/
# --------------------------------------------------------------------------- #
def _zcash_login(client, *, otp_token=None, signature="valid-signature"):
    challenge = client.post("/api/auth/zcash/challenge/",
                            {"address": ZCASH_ADDRESS}, format="json")
    assert challenge.status_code == 200, challenge.content
    body = {"address": ZCASH_ADDRESS, "challenge": challenge.data["challenge"],
            "signature": signature}
    if otp_token is not None:
        body["otp_token"] = otp_token
    response = client.post("/api/auth/zcash/login/", body, format="json")
    return response.data if response.status_code == 200 else response


def test_zcash_login_records_zec_on_the_token(api_client, mocker, isolated_zcash_admission):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    body = _zcash_login(api_client)

    creator = ZcashIdentity.objects.get(zcash_address=ZCASH_ADDRESS).creator
    _assert_fresh(_knox_context(creator, body["token"]), ["zec"], ACR_1FA)


def test_zcash_login_with_totp_records_mfa(api_client, mocker, creator_factory,
                                           isolated_zcash_admission):
    user = creator_factory()
    _enable_totp(user)
    ZcashIdentity.objects.create(
        creator=user, zcash_address=ZCASH_ADDRESS,
        linked_at_epoch=user.kt_account_epoch)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    body = _zcash_login(api_client, otp_token=_totp())

    _assert_fresh(_knox_context(user, body["token"]), ["zec", "otp", "mfa"], ACR_MFA)


def test_a_zcash_association_inherits_the_callers_context(api_client, mocker, creator_factory,
                                                         isolated_zcash_admission):
    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    old = timezone.now() - timedelta(seconds=30)
    AuthContext.objects.filter(creator=user).update(auth_time=old)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    body = _zcash_login(api_client)

    assert ZcashIdentity.objects.get(zcash_address=ZCASH_ADDRESS).creator_id == user.pk
    context = _knox_context(user, body["token"])
    assert context is not None and context.auth_time == old and context.amr == ["pwd"]


def test_a_zcash_association_from_an_unrecorded_session_gets_nothing(
        api_client, mocker, creator_factory, isolated_zcash_admission):
    user = creator_factory(password=PASSWORD)
    api_client.force_login(user)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    body = _zcash_login(api_client)

    assert body.status_code == 401, body.content
    assert not ZcashIdentity.objects.filter(creator=user).exists()
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.exists()


def test_a_failed_zcash_login_records_nothing(api_client, mocker, isolated_zcash_admission):
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=False)

    response = _zcash_login(api_client, signature="bad")

    assert response.status_code == 401
    assert not AuthToken.objects.exists()
    assert not AuthContext.objects.exists()


def test_inactive_zcash_login_is_clear_and_creates_no_credential(
    api_client, mocker, creator_factory, isolated_zcash_admission,
):
    user = creator_factory()
    ZcashIdentity.objects.create(
        creator=user, zcash_address=ZCASH_ADDRESS,
        linked_at_epoch=user.kt_account_epoch,
    )
    Creator.objects.filter(pk=user.pk).update(is_active=False)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)

    response = _zcash_login(api_client)

    assert response.status_code == 403
    assert response.data["detail"] == (
        "This account is inactive and cannot sign in."
    )
    assert "_auth_user_id" not in api_client.session
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.filter(creator=user).exists()


# --------------------------------------------------------------------------- #
# Legacy X: /api/twitter/callback
# --------------------------------------------------------------------------- #
def _twitter_callback(client, mocker, twitter_id):
    client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = sign_oauth2_handshake(
        "twitter-state", "verifier")
    mocker.patch("dj.apps.twitter.views.get_twitter_user", return_value={
        "id": twitter_id, "username": twitter_id, "name": "X user",
        "description": "", "profile_image_url": ""})
    return client.get("/api/twitter/callback",
                      {"state": "twitter-state", "code": "provider-code"},
                      secure=True)


def test_twitter_callback_login_records_fed_twitter(creator_factory, mocker):
    client = Client()
    user = creator_factory()
    TwitterProfile.objects.create(
        creator=user, twitter_id="tw-user", username="tw-user",
        allow_login=True, linked_at_epoch=user.kt_account_epoch)

    response = _twitter_callback(client, mocker, "tw-user")

    assert response.status_code == 302, response.content
    assert client.session.get("_auth_user_id") == str(user.pk)
    _assert_fresh(_session_context(client, user), ["fed:twitter"], ACR_1FA)


def test_twitter_callback_new_account_records_fed_twitter(mocker):
    client = Client()

    response = _twitter_callback(client, mocker, "brand-new-tw")

    assert response.status_code == 302, response.content
    user = TwitterProfile.objects.get(twitter_id="brand-new-tw").creator
    _assert_fresh(_session_context(client, user), ["fed:twitter"], ACR_1FA)


def test_twitter_totp_form_records_mfa_and_a_wrong_code_records_nothing(
        creator_factory, mocker):
    client = Client()
    user = creator_factory()
    _enable_totp(user)
    TwitterProfile.objects.create(
        creator=user, twitter_id="tw-mfa", username="tw-mfa",
        allow_login=True, linked_at_epoch=user.kt_account_epoch)

    pending = _twitter_callback(client, mocker, "tw-mfa")
    assert pending.status_code == 200
    assert not AuthContext.objects.exists()
    wrong = client.post("/api/twitter/callback", {"otp_token": "000000"}, secure=True)
    assert wrong.status_code == 400
    assert not AuthContext.objects.exists()

    accepted = client.post("/api/twitter/callback", {"otp_token": _totp()}, secure=True)

    assert accepted.status_code == 302, accepted.content
    _assert_fresh(_session_context(client, user),
                  ["fed:twitter", "otp", "mfa"], ACR_MFA)


def test_inactive_twitter_login_is_clear_and_creates_no_credential(
    creator_factory, mocker,
):
    client = Client()
    user = creator_factory()
    TwitterProfile.objects.create(
        creator=user, twitter_id="tw-inactive", username="tw-inactive",
        allow_login=True, linked_at_epoch=user.kt_account_epoch,
    )
    Creator.objects.filter(pk=user.pk).update(is_active=False)

    response = _twitter_callback(client, mocker, "tw-inactive")

    assert response.status_code == 403
    assert response.content.decode() == (
        "This account is inactive and cannot sign in."
    )
    assert "_auth_user_id" not in client.session
    assert not AuthToken.objects.filter(user=user).exists()
    assert not AuthContext.objects.filter(creator=user).exists()


# --------------------------------------------------------------------------- #
# Password reset and change (both sign the user in again)
# --------------------------------------------------------------------------- #
def _reset_token(user):
    email = Email.objects.create(
        user=user, email=f"{user.username}@example.com",
        token=f"email-token-{user.pk}",
        expires_at=timezone.now() + timedelta(days=1),
        confirmed_at=timezone.now())
    return PasswordResetToken.objects.create(email=email)


@pytest.mark.parametrize("with_totp", [False, True])
def test_password_reset_records_pwd(api_client, creator_factory, with_totp):
    user = creator_factory(password=PASSWORD)
    body = {"token": str(_reset_token(user).token), "password": "a-new-Passw0rd!"}
    if with_totp:
        _enable_totp(user)
        refused = api_client.post("/api/emails/do-reset-password", body, format="json")
        assert refused.status_code == 400
        assert not AuthContext.objects.exists()
        body["otp_token"] = _totp()

    response = api_client.post("/api/emails/do-reset-password", body, format="json")

    assert response.status_code == 200, response.content
    expected = ["pwd", "otp", "mfa"] if with_totp else ["pwd"]
    _assert_fresh(_session_context(api_client, user), expected,
                  ACR_MFA if with_totp else ACR_1FA)
    # Under the post-reset epoch: the reset is an ownership event.
    assert _session_context(api_client, user).account_epoch == _fresh(user).kt_account_epoch


def test_password_change_records_pwd(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204

    response = api_client.post("/api/emails/change-password", {
        "old_password": PASSWORD, "new_password": "a-new-Passw0rd!"}, format="json")

    assert response.status_code == 200, response.content
    _assert_fresh(_session_context(api_client, user), ["pwd"], ACR_1FA)
    assert AuthContext.objects.filter(creator=user).count() == 2  # old row is inert
    assert AuthContext.objects.filter(
        creator=user, account_epoch=_fresh(user).kt_account_epoch).count() == 1


def test_a_passwordless_first_password_requires_recent_auth(api_client, creator_factory):
    """A stale session cannot install a password then sign in afresh."""
    user = creator_factory()
    user.set_unusable_password()
    user.save()
    api_client.force_login(user)

    response = api_client.post("/api/emails/change-password", {
        "new_password": "a-new-Passw0rd!"}, format="json")

    assert response.status_code == 401, response.content
    user.refresh_from_db()
    assert not user.has_usable_password()
    assert not AuthContext.objects.exists()


# --------------------------------------------------------------------------- #
# Logout forgets; an ownership event invalidates
# --------------------------------------------------------------------------- #
def test_session_logout_forgets_the_context(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    other = APIClient()
    other_user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    assert _password_login(other, other_user).status_code == 204
    assert AuthContext.objects.count() == 2

    response = api_client.post("/api/auth/logout/")

    assert response.status_code == 200
    assert not AuthContext.objects.filter(creator=user).exists()
    # Only the credential that logged out: another session is untouched.
    assert _session_context(other, other_user) is not None


def test_knox_logout_forgets_only_that_token(creator_factory, mocker, isolated_zcash_admission):
    user = creator_factory()
    ZcashIdentity.objects.create(
        creator=user, zcash_address=ZCASH_ADDRESS,
        linked_at_epoch=user.kt_account_epoch)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    client = APIClient()
    first = _zcash_login(client)["token"]
    second = _zcash_login(client)["token"]
    client.credentials(HTTP_AUTHORIZATION=f"Token {first}")

    response = client.post("/api/token/logout/")

    assert response.status_code == 204
    assert _knox_context(user, first) is None
    assert not AuthContext.objects.filter(
        credential_hash__in=[_hash("knox", first)]).exists()
    assert _knox_context(user, second) is not None


def test_knox_logoutall_forgets_every_token(creator_factory, mocker, isolated_zcash_admission):
    user = creator_factory()
    ZcashIdentity.objects.create(
        creator=user, zcash_address=ZCASH_ADDRESS,
        linked_at_epoch=user.kt_account_epoch)
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    client = APIClient()
    tokens = [_zcash_login(client)["token"] for _ in range(3)]
    other = creator_factory(password=PASSWORD)
    other_client = APIClient()
    assert _password_login(other_client, other).status_code == 204
    client.credentials(HTTP_AUTHORIZATION=f"Token {tokens[0]}")

    response = client.post("/api/token/logoutall/")

    assert response.status_code == 204
    assert not AuthContext.objects.filter(creator=user).exists()
    assert _session_context(other_client, other) is not None


def test_an_ownership_event_invalidates_the_context(api_client, creator_factory):
    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    key = api_client.session.session_key
    assert _session_context(api_client, user) is not None

    bump_account_epoch(user.pk, event=EVENT_PASSWORD_CHANGE)

    # The row is still there; it is refused because its epoch is behind.
    assert AuthContext.objects.filter(creator=user).exists()
    assert AuthContext.objects.current(_fresh(user), kind="session", key=key) is None


def _hash(kind, raw):
    from dj.apps.identity.models import credential_hash

    return credential_hash(kind, hash_token(raw) if kind == "knox" else raw)


# --------------------------------------------------------------------------- #
# The helper's own contract
# --------------------------------------------------------------------------- #
def test_the_acr_values_are_the_oidc_contracts():
    from dj.apps.identity import auth_context
    from dj.apps.oidc import scopes

    assert (auth_context.ACR_1FA, auth_context.ACR_MFA) == (scopes.ACR_1FA, scopes.ACR_MFA)


def test_record_login_refuses_nonsense(rf, creator_factory):
    from dj.apps.identity.auth_context import INHERIT, record_login

    user = creator_factory()
    request = rf.get("/")
    request.session = SimpleNamespace(
        session_key="k" * 32,
        get_expiry_date=lambda: timezone.now() + timedelta(hours=1))
    with pytest.raises(TypeError):
        record_login(request, user, methods="pwd")
    with pytest.raises(ValueError):
        record_login(request, user, methods=[], second_factor="otp")
    with pytest.raises(ValueError):
        record_login(request, user, methods=["pwd"], second_factor="sms")
    with pytest.raises(ValueError):
        record_login(request, user, methods=INHERIT, second_factor="otp")
    assert record_login(request, user, methods=[]) is None
    assert not AuthContext.objects.exists()


def test_an_exchange_across_an_ownership_event_passes_nothing_on(api_client, creator_factory):
    """The presenting context is from epoch N; a token stamped N+1 must not
    inherit it."""
    from dj.apps.identity.auth_context import INHERIT, record_login

    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    request = SimpleNamespace(user=_fresh(user), session=api_client.session, auth=None)
    token, _ = AuthToken.objects.create(user)

    assert record_login(request, user, methods=INHERIT, token=token,
                        account_epoch=user.kt_account_epoch + 1) is None
    inherited = record_login(request, user, methods=INHERIT, token=token,
                             account_epoch=user.kt_account_epoch)
    assert inherited is not None and inherited.amr == ["pwd"]


@pytest.mark.parametrize("kind", ["social", "zcash", "twitter"])
@pytest.mark.parametrize("reactivate", [False, True])
def test_stale_session_cannot_install_a_fresh_signin_method(
        api_client, creator_factory, mocker, google, isolated_zcash_admission,
        kind, reactivate):
    """Block the association -> anonymous login -> fresh cap-raise bypass."""
    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    AuthContext.objects.filter(creator=user).update(
        auth_time=timezone.now() - timedelta(seconds=301))
    uid = "planted-identity"
    if reactivate:
        if kind == "social":
            row = SocialIdentity.objects.create(creator=user, provider="google",
                provider_uid=uid, linked_at_epoch=user.kt_account_epoch - 1)
        elif kind == "zcash":
            row = ZcashIdentity.objects.create(creator=user, zcash_address=ZCASH_ADDRESS,
                linked_at_epoch=user.kt_account_epoch - 1)
        else:
            row = TwitterProfile.objects.create(creator=user, twitter_id=uid,
                username=uid, linked_at_epoch=user.kt_account_epoch - 1, allow_login=True)
    if kind == "social":
        response = _social_login(api_client, mocker, uid=uid)
        model = SocialIdentity
    elif kind == "zcash":
        mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
        response = _zcash_login(api_client)
        model = ZcashIdentity
    else:
        # Use the same signed browser handshake as the production callback.
        from dj.apps.twitter.views import sign_oauth2_handshake
        api_client.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = sign_oauth2_handshake(
            "twitter-state", "verifier")
        mocker.patch("dj.apps.twitter.views.get_twitter_user", return_value={
            "id": uid, "username": uid, "name": "X user",
            "description": "", "profile_image_url": ""})
        response = api_client.get("/api/twitter/callback",
            {"state": "twitter-state", "code": "provider-code"}, secure=True)
        model = TwitterProfile
    assert response.status_code == 401, getattr(response, "content", response)
    assert response.json()["code"] == "insufficient_user_authentication"
    assert 'max_age="300"' in response["WWW-Authenticate"]
    if reactivate:
        row.refresh_from_db()
        assert row.linked_at_epoch == user.kt_account_epoch - 1
    else:
        assert not model.objects.filter(creator=user).exists()
    assert not AuthToken.objects.filter(user=user).exists()


@pytest.mark.parametrize("operation", ["password", "rest-password", "email", "twitter-enable"])
@pytest.mark.parametrize("recent", [False, True])
def test_establishing_a_recovery_or_login_method_requires_recent_auth(
        api_client, creator_factory, mocker, recent_login, operation, recent):
    user = creator_factory(password=PASSWORD)
    if operation in {"password", "rest-password"}:
        user.set_unusable_password()
        user.save()
    recent_login(api_client, user)
    if not recent:
        AuthContext.objects.filter(creator=user).update(
            auth_time=timezone.now() - timedelta(seconds=301))
    if operation in {"password", "rest-password"}:
        path, payload = ("/api/emails/change-password", {"new_password": "a-new-Passw0rd!"})
        if operation == "rest-password":
            path, payload = ("/api/auth/password/change/", {
                "new_password1": "a-new-Passw0rd!", "new_password2": "a-new-Passw0rd!"})
        response = api_client.post(path, payload, format="json")
        user.refresh_from_db()
        assert user.has_usable_password() is recent
    elif operation == "email":
        send = mocker.patch("dj.apps.emails.views.send_confirmation_email")
        response = api_client.post("/api/emails/add", {
            "email": "new-recovery@example.org"}, format="json")
        assert Email.objects.filter(user=user).exists() is recent
        assert send.called is recent
    else:
        row = TwitterProfile.objects.create(creator=user, twitter_id="enable-x",
            username="enable-x", allow_login=False, linked_at_epoch=user.kt_account_epoch)
        response = api_client.put("/api/twitter/public-status/", {
            "is_public": False, "allow_login": True}, format="json")
        row.refresh_from_db()
        assert row.allow_login is recent
    if recent:
        assert 200 <= response.status_code < 300, response.content
    else:
        assert response.status_code == 401, response.content


@pytest.mark.parametrize("existing_kind", ["social", "zcash"])
def test_passwordless_browser_can_reauthenticate_then_link_another_method(
        api_client, creator_factory, mocker, google, isolated_zcash_admission,
        recent_login, existing_kind):
    user = creator_factory()
    user.set_unusable_password()
    user.save()
    recent_login(api_client, user)
    AuthContext.objects.filter(creator=user).update(
        auth_time=timezone.now() - timedelta(hours=3))
    old_key = api_client.session.session_key
    attacker = APIClient()
    attacker.cookies = api_client.cookies.copy()
    mocker.patch("dj.apps.zauth.views.verify_zcash_signature", return_value=True)
    if existing_kind == "social":
        SocialIdentity.objects.create(creator=user, provider="google",
            provider_uid="owned-google", linked_at_epoch=user.kt_account_epoch)
        proof = _social_login(api_client, mocker, uid="owned-google")
        assert proof.status_code == 200, proof.content
        expected_method = "fed:google"
    else:
        ZcashIdentity.objects.create(creator=user, zcash_address=ZCASH_ADDRESS,
            linked_at_epoch=user.kt_account_epoch)
        proof = _zcash_login(api_client)
        assert isinstance(proof, dict), getattr(proof, "content", proof)
        expected_method = "zec"
    assert api_client.session.session_key != old_key
    assert AuthContext.objects.current(user, kind="session", key=old_key) is None
    assert attacker.post("/api/emails/add", {"email": "attacker@example.com"}).status_code in (401, 403)
    _assert_fresh(_session_context(api_client, user), [expected_method], ACR_1FA)
    if existing_kind == "social":
        linked = _zcash_login(api_client)
        assert isinstance(linked, dict), getattr(linked, "content", linked)
    else:
        linked = _social_login(api_client, mocker, uid="new-google")
        assert linked.status_code == 200, linked.content
    assert ZcashIdentity.objects.filter(creator=user).exists()
    assert SocialIdentity.objects.filter(creator=user).exists()


def test_legacy_orphan_adoption_requires_recent_auth(api_client, creator_factory, mocker):
    user = creator_factory(password=PASSWORD)
    assert _password_login(api_client, user).status_code == 204
    AuthContext.objects.filter(creator=user).update(
        auth_time=timezone.now() - timedelta(hours=3))
    orphan = TwitterProfile.objects.create(twitter_id="orphan", username="orphan")
    refused = _twitter_callback(api_client, mocker, "orphan")
    assert refused.status_code == 401, refused.content
    orphan.refresh_from_db()
    assert orphan.creator_id is None


def test_same_user_password_reauthentication_retires_copied_cookie(
        api_client, creator_factory, recent_login):
    user = creator_factory(password=PASSWORD)
    recent_login(api_client, user)
    old_key = api_client.session.session_key
    attacker = APIClient()
    attacker.cookies = api_client.cookies.copy()
    AuthContext.objects.filter(creator=user).update(
        auth_time=timezone.now() - timedelta(hours=3))
    assert attacker.post("/api/emails/add", {"email": "attacker@example.com"}).status_code == 401
    assert _password_login(api_client, user).status_code == 204
    assert api_client.session.session_key != old_key
    assert AuthContext.objects.current(user, kind="session", key=old_key) is None
    assert attacker.post("/api/emails/add", {"email": "attacker@example.com"}).status_code in (401, 403)
    _assert_fresh(_session_context(api_client, user), ["pwd"], ACR_1FA)
    assert api_client.post("/api/emails/add", {"email": "owner@example.com"}).status_code == 201


def test_browser_reauth_completion_is_bound_to_current_session(api_client, creator_factory, recent_login):
    user = creator_factory()
    assert api_client.get("/api/auth/recent/").status_code in (401, 403)
    recent_login(api_client, user)
    response = api_client.get("/api/auth/recent/")
    assert response.status_code == 200
    assert response.data == {"username": user.username}
    assert response["Cache-Control"] == "no-store"
    AuthContext.objects.filter(creator=user).update(auth_time=timezone.now() - timedelta(seconds=301))
    assert api_client.get("/api/auth/recent/").status_code == 401
