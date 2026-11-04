"""A password in a header is not a login, and never was one.

Scope first, because the honest boundary matters: this file proves that the
BASIC-AUTH door is shut. It does not prove that MFA is unavoidable in general
-- password reset, the email magic link, the Twitter and social OAuth
callbacks and Zcash wallet login all mint a session or Knox token without
consulting the user's ``OTPSecret``, which is a real and separate gap tracked
on its own. Read every assertion below as being about Basic auth.

``BasicAuthentication`` used to sit in
``REST_FRAMEWORK['DEFAULT_AUTHENTICATION_CLASSES']``, so every DRF view in the
project accepted ``Authorization: Basic base64(username:password)``. Nothing in
this repository ever sent that header -- the SPA uses the session cookie and
machine clients use Knox tokens -- but an attacker with a leaked password
could, and on that path:

* ``CreatorLoginSerializer.validate()`` never runs, so reCAPTCHA is skipped and
  the account's active TOTP token is never asked for. MFA, enrolled and paid
  for in user friction, does not apply.
* ``POST /api/otp/setup/`` used to return the account's live seed (see
  ``test_otp_setup_secret_disclosure.py``), so the same header disclosed the
  material needed to mint valid codes indefinitely.
* ``DELETE /api/otp/disable/`` accepts the account password as proof, which on
  the Basic path is the very credential the attacker already holds -- so MFA
  could be stripped outright.

The tests below use the ONE credential that matters for this: a correct
username and password for an account with MFA active. Before the fix that
combination is a fully authenticated API session. After it, it is anonymous.

The login-path counterpart (an enrolled user cannot log in without
``otp_token``) lives in ``dj/apps/g12f/test_creator_login_mfa.py``; the
structural guard against the setting coming back lives in
``dj/apps/test_authentication_inventory.py``.

Real Postgres per project rule.
"""
import base64
import inspect

import pytest
from django.core.cache import cache
from rest_framework.authentication import BasicAuthentication
from rest_framework.settings import api_settings

from dj.apps.g12f.models import Creator
from dj.apps.otp.models import OTPSecret


PASSWORD = "correct-horse-battery-staple"
ACTIVE_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

# Endpoints that exist to serve an authenticated caller. Each one is a thing a
# password-only attacker would have reached.
AUTHENTICATED_ENDPOINTS = [
    ("get", "/api/otp/status/"),
    ("post", "/api/otp/setup/"),
    ("delete", "/api/otp/disable/"),
    ("get", "/api/auth/user/"),
    ("get", "/api/myuploads/"),
]


@pytest.fixture(autouse=True)
def _clear_throttle_history():
    # /api/otp/disable/ carries a 1/second brute throttle whose counters live
    # in the process-local cache and would otherwise leak between tests.
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def mfa_user(creator_factory):
    user = creator_factory(password=PASSWORD)
    OTPSecret.objects.create(user=user, secret=ACTIVE_SECRET, is_active=True)
    return user


def _basic(username, password=PASSWORD):
    encoded = base64.b64encode(
        f"{username}:{password}".encode("utf-8")
    ).decode("ascii")
    return f"Basic {encoded}"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("method", "url"),
    AUTHENTICATED_ENDPOINTS,
    ids=[f"{m}:{u}" for m, u in AUTHENTICATED_ENDPOINTS],
)
def test_basic_credentials_do_not_authenticate(
    api_client, mfa_user, method, url
):
    """The correct password for an MFA-enrolled account buys nothing."""
    api_client.credentials(HTTP_AUTHORIZATION=_basic(mfa_user.username))

    response = getattr(api_client, method)(url)

    assert response.status_code in (401, 403), (
        f"{method.upper()} {url} answered {response.status_code} to Basic "
        "credentials -- password-only authentication is back and it does not "
        "check TOTP (#1048)."
    )


@pytest.mark.django_db
def test_basic_credentials_never_disclose_the_active_seed(
    api_client, mfa_user
):
    """The full original exploit chain, end to end, as one assertion."""
    api_client.credentials(HTTP_AUTHORIZATION=_basic(mfa_user.username))

    response = api_client.post("/api/otp/setup/")

    assert response.status_code in (401, 403), response.content
    assert ACTIVE_SECRET.encode("utf-8") not in response.content


@pytest.mark.django_db
def test_basic_credentials_cannot_strip_mfa(api_client, mfa_user):
    """`DisableOTPView` accepts the password; the password must not get in."""
    api_client.credentials(HTTP_AUTHORIZATION=_basic(mfa_user.username))

    response = api_client.delete(
        "/api/otp/disable/", {"password": PASSWORD}, format="json"
    )

    assert response.status_code in (401, 403), response.content
    assert OTPSecret.objects.filter(user=mfa_user, is_active=True).exists()


@pytest.mark.django_db
def test_basic_credentials_are_ignored_for_users_without_mfa(
    api_client, creator_factory
):
    """Basic auth is gone entirely, not merely gated on MFA enrolment.

    A policy that only refused Basic for enrolled accounts would leave the
    header live for everyone else and re-open the moment someone enrolled.
    """
    user = creator_factory(password=PASSWORD)
    assert not OTPSecret.objects.filter(user=user).exists()
    api_client.credentials(HTTP_AUTHORIZATION=_basic(user.username))

    response = api_client.get("/api/otp/status/")

    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_no_password_hashing_happens_on_the_basic_path(
    api_client, mfa_user, mocker
):
    """Not just refused -- never even considered.

    A rejection could come from a permission check that ran *after* the
    password was verified, which would still leak an account-exists oracle and
    still spend a bcrypt round per request. Assert the password is never
    touched at all.
    """
    check_password = mocker.patch.object(
        Creator, "check_password", autospec=True, return_value=True
    )
    api_client.credentials(HTTP_AUTHORIZATION=_basic(mfa_user.username))

    response = api_client.get("/api/otp/status/")

    assert response.status_code in (401, 403), response.content
    check_password.assert_not_called()


def test_no_authenticator_in_use_reads_a_password_field():
    """Names the property, so a *different* password authenticator also fails.

    Swapping ``BasicAuthentication`` for a look-alike (``RemoteUserAuth``, a
    home-grown ``X-Password`` header class) would sail past a test that only
    names the old class.
    """
    authenticators = api_settings.DEFAULT_AUTHENTICATION_CLASSES
    assert BasicAuthentication not in authenticators

    for authenticator in authenticators:
        credential_check = getattr(
            authenticator, "authenticate_credentials", None
        )
        if credential_check is None:
            continue
        parameters = set(inspect.signature(credential_check).parameters)
        assert "password" not in parameters, (
            f"{authenticator.__name__}.authenticate_credentials takes a raw "
            "password. Logins belong at /api/auth/login/, which is the only "
            "place reCAPTCHA and TOTP are checked (#1048)."
        )
