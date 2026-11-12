"""Apple's cryptographic boundary and the real shared account/session policies.

All signing keys are generated test fixtures. Only the Apple HTTP/JWKS boundary
is replaced; signature/claim checking, DB state, CSRF, sessions and linking run.
"""

import json
import time
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator
from dj.apps.social import clients
from dj.apps.social.models import SocialIdentity

REDIRECT = "https://test.free2z.cash/oauth/reauth-callback"
CSRF = "a" * 32


@pytest.fixture
def apple(settings, mocker):
    settings.APPLE_CLIENT_ID = "cash.free2z.web.test"
    settings.APPLE_TEAM_ID = "test-team"
    settings.APPLE_KEY_ID = "test-ec-key"
    key = ec.generate_private_key(ec.SECP256R1())
    settings.APPLE_PRIVATE_KEY = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    settings.APPLE_REDIRECT_URIS = (REDIRECT,)
    settings.SOCIAL_WEB_REAUTH_PROVIDERS = ("apple",)
    from django.core.cache import cache

    cache.clear()
    yield settings
    cache.clear()


@pytest.fixture
def browser():
    client = APIClient(enforce_csrf_checks=True)
    client.cookies["csrftoken"] = CSRF
    client.credentials(HTTP_X_CSRFTOKEN=CSRF, HTTP_ORIGIN="https://testserver")
    return client


@pytest.fixture
def provider_keys(mocker):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = dict(
        json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())),
        kid="fixture",
        use="sig",
        alg="RS256",
    )
    # Exercise PyJWT's actual set cache, kid selection and rotation refresh.
    client = jwt.PyJWKClient("https://appleid.apple.com/auth/keys")
    fetch = mocker.patch.object(client, "fetch_data", return_value={"keys": [jwk]})
    mocker.patch.object(clients, "_apple_jwks", return_value=client)
    return key, fetch


def start(browser):
    response = browser.get(
        "/api/auth/social/apple/start", {"redirect_uri": REDIRECT}, secure=True
    )
    assert response.status_code == 200, response.data
    return response.data


def complete(browser, attempt, **extra):
    return browser.post(
        "/api/auth/social/apple/",
        {
            "code": "single-use-apple-code",
            "state": attempt["state"],
            "redirect_uri": REDIRECT,
            **extra,
        },
        format="json",
        secure=True,
    )


def token_exchange(
    mocker,
    key,
    attempt,
    *,
    sub="stable.apple-user",
    claims=None,
    kid="fixture",
    algorithm="RS256",
):
    now = int(time.time())
    payload = dict(
        iss="https://appleid.apple.com",
        aud="cash.free2z.web.test",
        sub=sub,
        iat=now,
        exp=now + 300,
        nonce=parse_qs(urlparse(attempt["authorize_url"]).query)["nonce"][0],
    )
    payload.update(claims or {})
    token = jwt.encode(payload, key, algorithm=algorithm, headers={"kid": kid})
    return mocker.patch.object(
        clients.requests,
        "post",
        return_value=mocker.Mock(
            status_code=200,
            json=lambda: {"id_token": token, "refresh_token": "not-stored"},
        ),
    )


@pytest.mark.django_db
def test_apple_no_email_creates_first_class_web_session(
    browser, apple, provider_keys, mocker
):
    key, _ = provider_keys
    attempt = start(browser)
    query = parse_qs(urlparse(attempt["authorize_url"]).query)
    assert query["response_mode"] == ["fragment"]
    assert "scope" not in query and "code_challenge" not in query
    exchange = token_exchange(mocker, key, attempt)
    response = complete(browser, attempt)
    assert response.status_code == 200, response.data
    identity = SocialIdentity.objects.select_related("creator").get(provider="apple")
    assert identity.provider_uid == "stable.apple-user"
    assert not identity.creator.email and not identity.creator.has_usable_password()
    from dj.apps.emails.models import Email

    assert not Email.objects.filter(user=identity.creator).exists()
    assert (
        browser.get("/api/emails/recovery-status", secure=True).data["can_recover"]
        is False
    )
    assert not identity.handle
    assert browser.session["_auth_user_id"] == str(identity.creator_id)
    assert browser.get("/api/auth/recent/", secure=True).status_code == 200
    request = exchange.call_args.kwargs
    assert request["data"]["redirect_uri"] == REDIRECT
    assert "code_verifier" not in request["data"]
    secret = jwt.decode(
        request["data"]["client_secret"],
        serialization.load_pem_private_key(
            apple.APPLE_PRIVATE_KEY.encode(), None
        ).public_key(),
        algorithms=["ES256"],
        audience="https://appleid.apple.com",
    )
    assert (
        secret["iss"] == apple.APPLE_TEAM_ID and secret["sub"] == apple.APPLE_CLIENT_ID
    )
    assert secret["exp"] - secret["iat"] == 300
    assert complete(browser, attempt).status_code == 403  # CSRF rotated by web login
    assert exchange.call_count == 1


@pytest.mark.django_db
@pytest.mark.parametrize(
    "claims",
    [
        {"iss": "https://evil.test"},
        {"aud": "another-client"},
        {"aud": ["cash.free2z.web.test"]},
        {"exp": 1},
        {"iat": int(time.time()) + 3600},
        {"nonce": "wrong"},
        {"nonce": None},
        {"sub": ""},
        {"sub": "x" * 192},
    ],
)
def test_invalid_claims_never_provision(
    browser, apple, provider_keys, mocker, claims, caplog
):
    key, _ = provider_keys
    attempt = start(browser)
    token_exchange(mocker, key, attempt, claims=claims)
    response = complete(browser, attempt)
    assert response.status_code == 400
    assert response.data == {"detail": "Provider authorization failed."}
    assert not SocialIdentity.objects.exists()
    assert "single-use-apple-code" not in caplog.text and "eyJ" not in caplog.text


@pytest.mark.django_db
@pytest.mark.parametrize("kind", ["signature", "kid", "algorithm", "missing_claim"])
def test_wrong_key_algorithm_and_missing_claim_fail_closed(
    browser, apple, provider_keys, mocker, kind
):
    key, _ = provider_keys
    attempt = start(browser)
    if kind == "signature":
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token_exchange(
        mocker,
        key if kind != "algorithm" else "fixture-secret-with-enough-entropy",
        attempt,
        kid="unknown" if kind == "kid" else "fixture",
        algorithm="HS256" if kind == "algorithm" else "RS256",
        claims={"nonce": None} if kind == "missing_claim" else None,
    )
    assert complete(browser, attempt).status_code == 400
    assert not SocialIdentity.objects.exists()


@pytest.mark.django_db
@pytest.mark.parametrize(
    "email", [None, "", "relay@privaterelay.appleid.com", "changed@example.org"]
)
def test_email_cannot_select_or_link_an_existing_account(
    browser, apple, provider_keys, mocker, creator_factory, email
):
    victim = creator_factory(username="relay", email=email or "victim@example.org")
    attempt = start(browser)
    token_exchange(
        mocker,
        provider_keys[0],
        attempt,
        claims={} if email is None else {"email": email},
    )
    response = complete(browser, attempt)
    assert response.status_code == 200
    row = SocialIdentity.objects.get(provider="apple")
    assert row.creator_id != victim.pk and not row.creator.email


@pytest.mark.django_db
def test_stable_sub_reuses_account_across_email_changes(
    browser, apple, provider_keys, mocker
):
    first = None
    for email in ["private@privaterelay.appleid.com", "", "different@example.net"]:
        browser.logout()
        browser.cookies["csrftoken"] = CSRF
        browser.credentials(HTTP_X_CSRFTOKEN=CSRF, HTTP_ORIGIN="https://testserver")
        attempt = start(browser)
        token_exchange(mocker, provider_keys[0], attempt, claims={"email": email})
        response = complete(browser, attempt)
        assert response.status_code == 200
        first = first or response.data["username"]
        assert response.data["username"] == first
    assert SocialIdentity.objects.count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize(
    "corruption",
    ["state", "redirect", "cookie", "missing_cookie", "actor", "csrf", "expired"],
)
def test_browser_state_and_actor_binding_before_exchange(
    browser, apple, mocker, creator_factory, corruption
):
    from dj.apps.social import state

    attempt = start(browser)
    exchange = mocker.patch.object(clients.requests, "post")
    extra = {}
    if corruption == "state":
        extra["state"] = "unknown-state-abcdefghijklmnop"
    if corruption == "redirect":
        extra["redirect_uri"] = REDIRECT + "/wrong"
    if corruption == "cookie":
        browser.cookies["__Host-apple-oauth"] = "attacker"
    if corruption == "missing_cookie":
        del browser.cookies["__Host-apple-oauth"]
    if corruption == "actor":
        browser.force_login(creator_factory())
    if corruption == "csrf":
        browser.credentials()
    if corruption == "expired":
        stored = state.get_state(attempt["state"])
        state.store_state(attempt["state"], stored, ttl_seconds=1)
        from dj.apps.social.models import SocialState
        from django.utils import timezone
        from datetime import timedelta

        SocialState.objects.filter(state=attempt["state"]).update(
            expires=timezone.now() - timedelta(seconds=1)
        )
    assert complete(browser, attempt, **extra).status_code == (
        403 if corruption == "csrf" else 400
    )
    exchange.assert_not_called()
    assert not SocialIdentity.objects.exists()


@pytest.mark.django_db
def test_explicit_link_conflict_recent_auth_and_last_unlink(
    browser, apple, provider_keys, mocker, creator_factory, recent_login
):
    owner = creator_factory()
    browser.force_login(owner)
    attempt = start(browser)
    token_exchange(mocker, provider_keys[0], attempt)
    assert complete(browser, attempt).status_code == 401  # no recent login context
    assert not SocialIdentity.objects.exists()
    recent_login(browser, owner)
    attempt = start(browser)
    token_exchange(mocker, provider_keys[0], attempt)
    assert complete(browser, attempt).status_code == 200
    row = SocialIdentity.objects.get(provider="apple")
    assert row.creator_id == owner.pk
    other = creator_factory()
    recent_login(browser, other)
    attempt = start(browser)
    token_exchange(mocker, provider_keys[0], attempt)
    assert complete(browser, attempt).status_code == 409
    assert SocialIdentity.objects.get(pk=row.pk).creator_id == owner.pk
    recent_login(browser, owner)
    owner.set_unusable_password()
    owner.save()
    # force_login updates the session auth hash after the fixture changes it.
    recent_login(browser, owner)
    assert (
        browser.post(
            "/api/auth/social/apple/unlink/",
            {"provider_uid": row.provider_uid},
            format="json",
            secure=True,
        ).status_code
        == 409
    )
    owner.set_password("fixture")
    owner.save()
    recent_login(browser, owner)
    assert (
        browser.post(
            "/api/auth/social/apple/unlink/",
            {"provider_uid": row.provider_uid},
            format="json",
            secure=True,
        ).status_code
        == 204
    )


@pytest.mark.django_db
def test_failed_exchange_is_generic_and_single_use(browser, apple, mocker, caplog):
    attempt = start(browser)
    exchange = mocker.patch.object(
        clients.requests,
        "post",
        return_value=mocker.Mock(
            status_code=400,
            text="code=secret email=person@example.com",
        ),
    )
    assert complete(browser, attempt).data == {
        "detail": "Provider authorization failed."
    }
    assert complete(browser, attempt).status_code == 400
    assert exchange.call_count == 1
    assert "secret" not in caplog.text and "person@" not in caplog.text


@pytest.mark.django_db
def test_discovery_and_redirect_policy(browser, apple):
    from dj.apps.social.views import is_allowed_redirect_uri

    rows = browser.get("/api/auth/social/providers/").data["providers"]
    row = next(row for row in rows if row["provider"] == "apple")
    assert row == dict(
        provider="apple", configured=True, web_only=True, web_reauthentication=True
    )
    assert not clients.configured_mobile_providers()["apple"]
    for uri in [
        "cash.free2z.zuuli://oauth/callback",
        "http://127.0.0.1:1423/auth/callback",
        REDIRECT + "?code=x",
        REDIRECT + "/extra",
        "https://evil.test/oauth/reauth-callback",
    ]:
        assert not is_allowed_redirect_uri(uri, "apple")
    apple.APPLE_PRIVATE_KEY = ""
    assert (
        browser.get(
            "/api/auth/social/apple/start", {"redirect_uri": REDIRECT}
        ).status_code
        == 503
    )


@pytest.mark.django_db
@pytest.mark.parametrize("failure", ["stale", "inactive", "mfa"])
def test_apple_shared_account_admission_before_web_session(
    browser, apple, provider_keys, mocker, creator_factory, failure
):
    user = creator_factory()
    row = SocialIdentity.objects.create(
        creator=user, provider="apple", provider_uid="stable.apple-user"
    )
    if failure == "stale":
        Creator.objects.filter(pk=user.pk).update(kt_account_epoch=2)
    elif failure == "inactive":
        Creator.objects.filter(pk=user.pk).update(is_active=False)
    else:
        from dj.apps.otp.models import OTPSecret

        OTPSecret.objects.create(
            user=user, secret="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", is_active=True
        )
    attempt = start(browser)
    token_exchange(mocker, provider_keys[0], attempt)
    response = complete(browser, attempt)
    assert response.status_code == (400 if failure == "mfa" else 403)
    assert "_auth_user_id" not in browser.session
    row.refresh_from_db()
    assert row.creator_id == user.pk


def test_jwks_cache_rotation_and_outage_fail_closed(apple, mocker):
    import io

    # Run the actual factory, network response parser, cache, selection and
    # refresh cooldown. The only fake is the fixed-host HTTP response.
    clients._apple_jwks.cache_clear()
    key1 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key2 = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def jwk(key, kid):
        return dict(
            json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())),
            kid=kid,
            alg="RS256",
        )

    from jwt import jwks_client

    opener = mocker.Mock()
    opener.open.side_effect = [
        io.BytesIO(json.dumps({"keys": [jwk(key1, "old")]}).encode()),
        io.BytesIO(json.dumps({"keys": [jwk(key2, "new")]}).encode()),
    ]
    mocker.patch.object(jwks_client.urllib.request, "build_opener", return_value=opener)
    client = clients._apple_jwks()
    assert (
        client.get_signing_key("old").key.public_numbers()
        == key1.public_key().public_numbers()
    )
    assert client.get_signing_key("old")
    assert opener.open.call_count == 1
    # Rotate after the anti-fetch-flood cooldown. New kid forces fresh set.
    client._last_successful_fetch = 0
    assert (
        client.get_signing_key("new").key.public_numbers()
        == key2.public_key().public_numbers()
    )
    assert opener.open.call_count == 2
    for call in opener.open.call_args_list:
        assert call.args[0].full_url == "https://appleid.apple.com/auth/keys"
        assert call.kwargs["timeout"] == 15
    client.jwk_set_cache.put(None)
    from urllib.error import URLError

    opener.open.side_effect = URLError("offline")
    with pytest.raises(jwt.PyJWKClientError):
        client.get_signing_key("new")
    clients._apple_jwks.cache_clear()


@pytest.mark.django_db
def test_apple_unlink_requires_account_and_never_discloses_another_identity(
    browser, apple, creator_factory, recent_login
):
    path = "/api/auth/social/apple/unlink/"
    assert (
        browser.post(
            path, {"provider_uid": "private-subject"}, format="json", secure=True
        ).status_code
        == 403
    )
    recent_login(browser, creator_factory())
    response = browser.post(
        path, {"provider_uid": "private-subject"}, format="json", secure=True
    )
    assert response.status_code == 404
    assert "private-subject" not in str(response.data)
    assert browser.post(path, {}, format="json", secure=True).status_code == 400


@pytest.mark.django_db
def test_same_account_new_epoch_cannot_redeem_an_old_link(
    browser, apple, mocker, creator_factory
):
    user = creator_factory()
    browser.force_login(user)
    attempt = start(browser)
    Creator.objects.filter(pk=user.pk).update(kt_account_epoch=2)
    user.refresh_from_db()
    browser.force_login(user)
    exchange = mocker.patch.object(clients.requests, "post")
    assert complete(browser, attempt).status_code == 400
    exchange.assert_not_called()
    assert not SocialIdentity.objects.exists()


@pytest.mark.django_db
def test_apple_mfa_proof_is_required_and_recorded_on_the_web_session(
    browser, apple, provider_keys, mocker, creator_factory
):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    import pyotp
    from dj.apps.otp import utils
    from dj.apps.otp.models import OTPSecret
    from dj.apps.identity.models import AuthContext
    from dj.apps.identity.auth_context import ACR_MFA

    fixed = 1893458055

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(fixed, tz)

    mocker.patch.object(
        pyotp.totp, "datetime", SimpleNamespace(datetime=FrozenDateTime)
    )
    mocker.patch.object(
        utils,
        "timezone",
        SimpleNamespace(now=lambda: FrozenDateTime.fromtimestamp(fixed, timezone.utc)),
    )
    user = creator_factory()
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    OTPSecret.objects.create(user=user, secret=secret, is_active=True)
    SocialIdentity.objects.create(
        creator=user, provider="apple", provider_uid="stable.apple-user"
    )
    attempt = start(browser)
    token_exchange(mocker, provider_keys[0], attempt)
    response = complete(browser, attempt, otp_token=pyotp.TOTP(secret).at(fixed))
    assert response.status_code == 200
    context = AuthContext.objects.current(
        user, kind=AuthContext.Kind.SESSION, key=browser.session.session_key
    )
    assert context is not None
    assert context.acr == ACR_MFA
    assert context.amr == sorted(["fed:apple", "otp", "mfa"])


def test_browser_binding_is_a_conditional_cookie_contract():
    from pathlib import Path
    import yaml

    spec = yaml.safe_load(
        (Path(__file__).resolve().parents[3] / "dj/free2z/openapi/f2z.yaml").read_text()
    )
    operation = spec["paths"]["/api/auth/social/{provider}/"]["post"]
    binding = [p for p in operation["parameters"] if p["name"] == "__Host-apple-oauth"]
    assert len(binding) == 1
    assert binding[0]["in"] == "cookie"
    assert binding[0].get("required", False) is False  # Other providers require no Apple cookie.
    assert binding[0]["schema"]["type"] == "string"
    assert "provider is apple" in binding[0]["description"]
    assert "HTTP 400" in binding[0]["description"]
    body = spec["components"]["schemas"]["SocialOAuthLoginRequest"]
    assert "__Host-apple-oauth" not in body["properties"]
