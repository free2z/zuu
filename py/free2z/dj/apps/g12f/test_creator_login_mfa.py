"""Regression coverage for resolved auth serializers and login MFA."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pyotp
import pyotp.totp
import pytest
from django.conf import settings
from django.urls import resolve
from dj_rest_auth.app_settings import api_settings as rest_auth_settings
from dj_rest_auth.views import LoginView, PasswordChangeView

from dj.apps.otp.models import OTPSecret
from dj.apps.g12f.serializers.creator import (
    CreatorLoginSerializer,
    CreatorPasswordChangeSerializer,
)
from dj.apps.g12f.views.creator import CreatorLoginView


def test_dj_rest_auth_resolves_creator_auth_serializers():
    """Mounted dj-rest-auth endpoints must retain their custom serializers.

    Asserting the settings dictionary alone would still pass in the exact
    failure this guards against: dj-rest-auth >= 3.0 silently ignores the old
    ``REST_AUTH_SERIALIZERS`` name, so a settings-only assertion can be green
    while the framework serves its stock serializers. Resolve the URLConf and
    assert the class the request actually reaches.
    """
    # The pre-3.x name is inert on dj-rest-auth >= 3.0 and must never come
    # back: re-adding it looks like configuration but disables nothing loudly.
    assert not hasattr(settings, "REST_AUTH_SERIALIZERS")

    login_view = resolve("/api/auth/login/").func.cls
    password_change_view = resolve("/api/auth/password/change/").func.cls
    #  mounted the project's own throttled subclass ahead of
    # dj_rest_auth.urls. It must still BE a LoginView -- the whole point is
    # that only throttle_classes changes -- and it must still resolve the
    # custom serializer, which is what this test has always been about.
    assert login_view is CreatorLoginView
    assert issubclass(login_view, LoginView)
    assert password_change_view is PasswordChangeView

    # /api/auth/login/ is the only enforcement point for reCAPTCHA. The
    # password-change serializer also owns the shared TOTP gate, while this
    # route remains the only wiring for the account lock and
    # outstanding-reset-token invalidation in CreatorSetPasswordForm.
    assert login_view.serializer_class is CreatorLoginSerializer
    assert (
        password_change_view.serializer_class is CreatorPasswordChangeSerializer
    )

    assert rest_auth_settings.LOGIN_SERIALIZER is CreatorLoginSerializer
    assert (
        rest_auth_settings.PASSWORD_CHANGE_SERIALIZER
        is CreatorPasswordChangeSerializer
    )
    assert rest_auth_settings.LOGOUT_ON_PASSWORD_CHANGE is False

    login_serializer = login_view.serializer_class()
    assert login_serializer.fields["captcha_result"].required is True
    assert login_serializer.fields["otp_token"].write_only is True


@pytest.mark.parametrize("suffix", ["", "/"])
def test_project_auth_overrides_survive_optional_trailing_slash(suffix):
    """dj-rest-auth's optional trailing slash must not bypass our overrides.

    dj_rest_auth.urls uses ``re_path(r'user/?$')`` since 3.0, so ``/api/auth/user``
    and ``/api/auth/user/`` are two distinct resolvable paths. A ``path()``
    override in the project URLConf shadows only the second, and APPEND_SLASH
    will not redirect the first because it now resolves. Both forms must reach
    the project's own view.
    """
    from dj.apps.g12f.views.creator import CustomUserDetailsView

    assert (
        resolve(f"/api/auth/user{suffix}").func.cls is CustomUserDetailsView
    )
    # Deliberately disabled upstream endpoints: the project runs its own
    # throttled, token-invalidating reset flow under /api/emails/.
    for path in ("/api/auth/password/reset", "/api/auth/password/reset/confirm"):
        match = resolve(f"{path}{suffix}")
        assert match.func.__name__ == "e404", (path, suffix, match.func)


@pytest.mark.django_db
def test_login_rejects_missing_captcha_without_calling_siteverify(
    api_client, creator_factory, monkeypatch
):
    """Correct credentials with no captcha must fail before any network call."""

    def explode(*_args, **_kwargs):
        raise AssertionError("siteverify must not be called")

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", explode
    )
    user = creator_factory(password="correct-password")

    response = api_client.post(
        "/api/auth/login/",
        {"username": user.username, "password": "correct-password"},
        format="json",
    )

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_login_rejects_enrolled_totp_user_without_otp_token(
    api_client, creator_factory, monkeypatch
):
    """A TOTP-enrolled account must not log in on password + captcha alone."""

    def verify_captcha(_url, **_kwargs):
        return SimpleNamespace(json=lambda: {"success": True})

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", verify_captcha
    )
    user = creator_factory(password="correct-password")
    OTPSecret.objects.create(
        user=user, secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", is_active=True
    )

    response = api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": "ci-valid-captcha",
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert response.json()["non_field_errors"] == ["Invalid OTP token"]


@pytest.mark.django_db
def test_login_rejects_failed_siteverify_captcha(
    api_client, creator_factory, monkeypatch
):
    """A negative siteverify result must reject the real login request path."""

    def verify_captcha(url, data, **_kwargs):
        assert url == "https://www.google.com/recaptcha/api/siteverify"
        assert data == {
            "secret": settings.RECAPTCHA_SECRET_KEY,
            "response": "ci-rejected-captcha",
        }
        return SimpleNamespace(json=lambda: {"success": False})

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", verify_captcha
    )
    user = creator_factory(password="correct-password")

    response = api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": "ci-rejected-captcha",
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert response.json()["non_field_errors"] == ["Invalid captcha"]


@pytest.mark.django_db
def test_login_accepts_valid_totp_with_otp_token_and_captcha(
    api_client, creator_factory, monkeypatch
):
    frozen_now = datetime(2030, 1, 1, 12, 34, 15, tzinfo=timezone.utc)
    frozen_timestamp = int(frozen_now.timestamp())
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    totp = pyotp.TOTP(secret)
    adjacent_window_otp_token = totp.at(frozen_timestamp + totp.interval)

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return cls.fromtimestamp(frozen_now.timestamp())
            return cls.fromtimestamp(frozen_now.timestamp(), tz)

    # Keep PyOTP's generation and verification in one 30-second window for
    # the whole request without changing the production verifier's policy.
    #
    # the verifier pins verification to dj.apps.otp.utils'
    # ``timezone.now()`` (single captured instant handed to pyotp via
    # ``for_time``), so that clock must be frozen to the SAME timestamp --
    # and it must hand back FrozenDateTime instances, because pyotp's
    # isinstance gate in at()/verify() checks against exactly the class
    # patched into pyotp.totp.datetime.
    monkeypatch.setattr(
        pyotp.totp,
        "datetime",
        SimpleNamespace(datetime=FrozenDateTime),
    )

    import dj.apps.otp.utils as otp_utils

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(
                frozen_timestamp, tz=timezone.utc
            )

    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)

    def verify_captcha(_url, data, **_kwargs):
        assert data["response"] == "ci-valid-captcha"
        return SimpleNamespace(json=lambda: {"success": True})

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", verify_captcha
    )

    user = creator_factory(password="correct-password")
    OTPSecret.objects.create(user=user, secret=secret, is_active=True)
    valid_otp_token = totp.now()
    assert adjacent_window_otp_token != valid_otp_token

    response = api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": "ci-valid-captcha",
            "otp_token": valid_otp_token,
        },
        format="json",
    )

    assert response.status_code == 204, response.content

    response = api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": "ci-valid-captcha",
            "otp_token": adjacent_window_otp_token,
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert response.json()["non_field_errors"] == ["Invalid OTP token"]

    invalid_otp_token = str((int(valid_otp_token) + 1) % 1_000_000).zfill(6)
    response = api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": "ci-valid-captcha",
            "otp_token": invalid_otp_token,
        },
        format="json",
    )

    assert response.status_code == 400, response.content


def _freeze_totp_clock(monkeypatch, frozen_now):
    """Pin both PyOTP's clock and otp.utils' verification instant."""
    frozen_timestamp = int(frozen_now.timestamp())

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return cls.fromtimestamp(frozen_now.timestamp())
            return cls.fromtimestamp(frozen_now.timestamp(), tz)

    # pyotp's isinstance gate in at()/verify() checks against exactly the
    # class patched into pyotp.totp.datetime -- see the longer comment on
    # test_login_accepts_valid_totp_with_otp_token_and_captcha.
    monkeypatch.setattr(
        pyotp.totp,
        "datetime",
        SimpleNamespace(datetime=FrozenDateTime),
    )

    import dj.apps.otp.utils as otp_utils

    class FrozenTimezone:
        @staticmethod
        def now():
            return FrozenDateTime.fromtimestamp(
                frozen_timestamp, tz=timezone.utc
            )

    monkeypatch.setattr(otp_utils, "timezone", FrozenTimezone)
    return pyotp.TOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")


@pytest.mark.django_db
def test_totp_is_consumed_only_after_login_validation_fully_passes(
    api_client, creator_factory, monkeypatch
):
    """A failing post-TOTP validation step must never have burned the code.

    Pre-fix ordering ( review finding): CreatorLoginSerializer verified
    credentials itself, burned the TOTP code, and only then called
    ``LoginSerializer.validate``, which runs its own authentication pass plus
    account-state checks. A concurrent password change, account-state flip,
    or transient backend failure during that second pass denied the login
    with the code already irreversibly consumed -- the user is locked out
    until the next time step for no fault of theirs.

    The fix makes upstream ``validate`` the single authentication pass and
    consumes the code only after it fully succeeds, so there is no second
    pass left to fail after the burn. Simulate the failure mode by making
    any authenticate() call beyond the first return None, as a flaky auth
    backend or a mid-login password change would.
    """
    import dj_rest_auth.serializers as rest_auth_serializers

    real_authenticate = rest_auth_serializers.authenticate
    auth_calls = []

    def flaky_second_pass(request=None, **credentials):
        auth_calls.append(credentials.get("username"))
        if len(auth_calls) > 1:
            return None
        return real_authenticate(request, **credentials)

    monkeypatch.setattr(
        rest_auth_serializers, "authenticate", flaky_second_pass
    )

    def verify_captcha(_url, data, **_kwargs):
        assert data["response"] == "ci-valid-captcha"
        return SimpleNamespace(json=lambda: {"success": True})

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", verify_captcha
    )

    totp = _freeze_totp_clock(monkeypatch, datetime(2030, 1, 1, 12, 34, 15))
    user = creator_factory(password="correct-password")
    otp_secret = OTPSecret.objects.create(
        user=user,
        secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        is_active=True,
    )
    valid_otp_token = totp.now()

    response = api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": "ci-valid-captcha",
            "otp_token": valid_otp_token,
        },
        format="json",
    )

    assert response.status_code == 204, response.content
    # The duplicate pre-super authentication pass is gone entirely: one
    # password check per login, and nothing left to fail after the burn.
    assert auth_calls == [user.username]
    # The code was still consumed exactly once for its step.
    otp_secret.refresh_from_db()
    assert otp_secret.last_used_at is not None


SMOKE_USERNAME = "f2z-smoke"


@pytest.fixture
def siteverify_calls(monkeypatch):
    """Record every recaptcha siteverify call instead of hitting the network."""

    calls = []

    def verify_captcha(_url, **_kwargs):
        calls.append(_url)
        return SimpleNamespace(json=lambda: {"success": True})

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", verify_captcha
    )
    return calls


@pytest.mark.django_db
def test_smoke_account_login_skips_siteverify_in_stage_namespace(
    api_client, creator_factory, monkeypatch, settings, siteverify_calls
):
    """: the named smoke account logs in without touching siteverify.

    Both gates must hold for the bypass: the username matches
    settings.SMOKE_TEST_ACCOUNT_USERNAME (case-insensitively, mirroring the
    iexact login lookup) AND os.environ NAMESPACE is 'stage'. The stage smoke
    workflow depends on this to mint a session without a real captcha token.
    """
    creator_factory(username=SMOKE_USERNAME, password="correct-password")
    settings.SMOKE_TEST_ACCOUNT_USERNAME = SMOKE_USERNAME.upper()  # iexact path
    monkeypatch.setenv("NAMESPACE", "stage")

    response = api_client.post(
        "/api/auth/login/",
        {
            "username": SMOKE_USERNAME,
            "password": "correct-password",
            "captcha_result": "smoke",
        },
        format="json",
    )

    # 204 + session (REST_AUTH TOKEN_MODEL None): no key body.
    assert response.status_code == 204, response.content
    assert response.cookies.get("sessionid"), "no session was established"
    assert siteverify_calls == [], (
        "the stage smoke bypass must not call recaptcha siteverify"
    )


@pytest.mark.django_db
def test_smoke_bypass_does_not_apply_to_other_usernames(
    api_client, creator_factory, monkeypatch, settings, siteverify_calls
):
    """A different username in the same namespace still goes through siteverify."""

    user = creator_factory(password="correct-password")
    settings.SMOKE_TEST_ACCOUNT_USERNAME = SMOKE_USERNAME
    monkeypatch.setenv("NAMESPACE", "stage")

    response = api_client.post(
        "/api/auth/login/",
        {
            "username": user.username,
            "password": "correct-password",
            "captcha_result": "smoke",
        },
        format="json",
    )

    assert response.status_code == 204, response.content
    assert siteverify_calls, "siteverify must still run for non-smoke users"


@pytest.mark.django_db
def test_smoke_bypass_is_inert_outside_stage_namespace(
    api_client, creator_factory, monkeypatch, settings, siteverify_calls
):
    """The shared ConfigMap reaches prod too; there the bypass must fail closed.

    Same account name, same captcha_result, but NAMESPACE is not 'stage'
    (prod pods get NAMESPACE=prod): siteverify must be consulted and its
    verdict enforced.
    """
    creator_factory(username=SMOKE_USERNAME, password="correct-password")
    settings.SMOKE_TEST_ACCOUNT_USERNAME = SMOKE_USERNAME

    def reject(_url, **_kwargs):
        return SimpleNamespace(json=lambda: {"success": False})

    monkeypatch.setattr(
        "dj.apps.g12f.captcha.requests.post", reject
    )
    monkeypatch.setenv("NAMESPACE", "prod")
    response = api_client.post(
        "/api/auth/login/",
        {
            "username": SMOKE_USERNAME,
            "password": "correct-password",
            "captcha_result": "smoke",
        },
        format="json",
    )
    assert response.status_code == 400, response.content
    assert response.json()["non_field_errors"] == ["Invalid captcha"]

    # And with NAMESPACE unset entirely (local dev against prod-like settings).
    monkeypatch.delenv("NAMESPACE", raising=False)
    response = api_client.post(
        "/api/auth/login/",
        {
            "username": SMOKE_USERNAME,
            "password": "correct-password",
            "captcha_result": "smoke",
        },
        format="json",
    )
    assert response.status_code == 400, response.content


def test_login_schema_documents_the_session_only_response():
    """A throttle subclass must not silently rewrite the API contract.

    drf-spectacular fixes dj-rest-auth's login response through an
    ``OpenApiViewExtension`` keyed on the exact string
    ``'dj_rest_auth.views.LoginView'`` (``drf_spectacular/contrib/rest_auth.py``).
    Extension matching is by target class, not by inheritance, so mounting a
    subclass to attach ``throttle_classes`` drops the fix and the generated
    ``f2z.yaml`` documents the *request* serializer as the response.

    CI cannot catch it. The ``backend`` job's spec guard asserts the committed
    ``f2z.yaml`` MATCHES the code -- and it does match, because the code is
    what changed. So this asserts the contract itself.

    that contract is 204 with no body: ``REST_AUTH['TOKEN_MODEL']``
    is None, so the view sets a session and returns nothing, and the spec must
    not keep advertising the inert ``Token`` it used to mint.
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    operation = schema["paths"]["/api/auth/login/"]["post"]

    assert set(operation["responses"]) == {"204", "503"}, operation["responses"]
    assert "content" not in operation["responses"]["204"], (
        "a 204 has no body; the spec must not document one"
    )
    assert "Token" not in schema["components"]["schemas"], (
        "the inert rest_framework.authtoken Token is still documented"
    )

    # The public description must stay the endpoint's, not our throttle essay.
    assert operation["description"].startswith("Check the credentials"), (
        "CreatorLoginView's internal docstring leaked into the public API "
        f"description: {operation['description'][:120]!r}"
    )
