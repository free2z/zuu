"""
Tests for multi-provider social login ("ZUULI Social Login v1").

Modeled 1:1 on ``dj.apps.zauth.test_zauth``. The provider code-exchange (the
only network boundary) is mocked at ``dj.apps.social.views.exchange_identity``;
everything else -- state single-use/TTL, PKCE plumbing, dual-mode login/
associate, the 409, the 503 boot-safety, and the redirect_uri allowlist -- runs
for real against Postgres.

    cd py/free2z && python -m pytest dj/apps/social/ -x

pytest.ini sets ``python_files = test_*.py`` so this file is collected.
"""
import os
import runpy
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest
from urllib.parse import parse_qs, urlparse
from django.utils import timezone

from knox.models import AuthToken

from dj.apps.g12f.models import Creator
from dj.apps.ktauth import epoch
from dj.apps.social.models import SocialIdentity
from dj.apps.social.clients import get_provider, pkce_challenge
from dj.apps.social import state as state_store
from dj.apps.social.views import ZUULI_MOBILE_PKCE_PROVIDERS


REDIRECT_URI = "http://localhost:3000/auth/callback"       # in CORS whitelist
WEB_127_REDIRECT_URI = "http://127.0.0.1:1423/auth/callback"
BAD_REDIRECT_URI = "https://evil.example.com/steal"        # NOT allowed
DESKTOP_REDIRECT_URI = "http://127.0.0.1:54321/0123456789abcdef0123456789abcdef"
MOBILE_REDIRECT_URI = "cash.free2z.zuuli://oauth/callback"
MOBILE_VERIFIER = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
MOBILE_CHALLENGE = pkce_challenge(MOBILE_VERIFIER)
MOBILE_PROVIDER_REDIRECT_URI = (
    "https://free2z.cash/api/auth/social/mobile/callback"
)

GOOGLE_UID = "google-sub-1234567890"
GOOGLE_HANDLE = "alice@example.com"


@pytest.fixture
def google_configured(settings):
    """Make the Google provider appear configured (no real secrets needed)."""
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI = (
        MOBILE_PROVIDER_REDIRECT_URI
    )
    settings.ZUULI_SOCIAL_AUTH_ENABLED = True
    return settings


def _mock_exchange(mocker, uid=GOOGLE_UID, handle=GOOGLE_HANDLE,
                   avatar_url="https://cdn.example.com/a.png"):
    return mocker.patch(
        "dj.apps.social.views.exchange_identity",
        return_value={"uid": uid, "handle": handle, "avatar_url": avatar_url},
    )


def _start(api_client, provider="google", redirect_uri=REDIRECT_URI,
           code_challenge=None):
    params = {"redirect_uri": redirect_uri}
    if code_challenge is not None:
        params["code_challenge"] = code_challenge
    return api_client.get(
        f"/api/auth/social/{provider}/start",
        params,
    )


def _login(api_client, state, provider="google", code="auth-code",
           redirect_uri=REDIRECT_URI, code_verifier=None):
    body = {"code": code, "state": state, "redirect_uri": redirect_uri}
    if code_verifier is not None:
        body["code_verifier"] = code_verifier
    return api_client.post(
        f"/api/auth/social/{provider}/",
        body,
        format="json",
    )


def _relay(api_client, start, code="auth-code", error=None, **extra):
    params = {"state": start.data["authorization_state"], **extra}
    if error is not None:
        params["error"] = error
    else:
        params["code"] = code
    return api_client.get("/api/auth/social/mobile/callback", params)


# --------------------------------------------------------------------------- #
# (d) unconfigured provider -> 503 (boot-safe), never 500
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_unconfigured_provider_start_returns_503(api_client):
    # No GOOGLE_* set -> not configured.
    resp = _start(api_client)
    assert resp.status_code == 503, resp.content


@pytest.mark.django_db
def test_unconfigured_provider_login_returns_503(api_client):
    resp = _login(api_client, state="whatever")
    assert resp.status_code == 503, resp.content


def test_unknown_provider_start_returns_404(api_client):
    resp = _start(api_client, provider="myspace")
    assert resp.status_code == 404, resp.content


def test_every_mobile_provider_supports_pkce():
    assert all(
        get_provider(provider).supports_pkce
        for provider in ZUULI_MOBILE_PKCE_PROVIDERS
    )


def test_x_provider_network_calls_have_hard_timeouts(mocker):
    from twatter.v2.client import TwitterClient

    token = mocker.patch("twatter.v2.client.requests.post")
    token.return_value.status_code = 200
    token.return_value.text = '{"access_token":"token"}'
    profile = mocker.patch("twatter.v2.client.requests.get")
    profile.return_value.status_code = 200
    profile.return_value.json.return_value = {
        "data": {"id": "123", "username": "alice"},
    }

    client = TwitterClient("client", "secret", "https://free2z.cash/callback")
    client.exchange_code_for_token("code", "verifier")
    client.get_me()

    assert token.call_args.kwargs["timeout"] == 15
    assert profile.call_args.kwargs["timeout"] == 15


# --------------------------------------------------------------------------- #
# (f) redirect_uri allowlist enforced
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_start_rejects_disallowed_redirect_uri(api_client, google_configured):
    resp = _start(api_client, redirect_uri=BAD_REDIRECT_URI)
    assert resp.status_code == 400, resp.content


@pytest.mark.django_db
def test_start_allows_exact_desktop_loopback(api_client, google_configured):
    resp = _start(api_client, redirect_uri=DESKTOP_REDIRECT_URI)
    assert resp.status_code == 200, resp.content
    assert resp.data["state"]
    assert "code_challenge_method=S256" in resp.data["authorize_url"]


@pytest.mark.django_db
def test_start_preserves_explicit_127_web_origin(api_client, google_configured):
    resp = _start(api_client, redirect_uri=WEB_127_REDIRECT_URI)
    assert resp.status_code == 200, resp.content


@pytest.mark.django_db
@pytest.mark.parametrize("redirect_uri", [
    "http://localhost:54321/0123456789abcdef0123456789abcdef",
    "http://127.0.0.1/0123456789abcdef0123456789abcdef",
    "http://127.0.0.1:80/0123456789abcdef0123456789abcdef",
    "http://127.0.0.1:54321/cb",
    "http://127.0.0.1:54321/0123456789abcdef0123456789abcdef/extra",
    "http://127.0.0.1:54321/0123456789abcdef0123456789abcdef?next=evil",
    "http://user@127.0.0.1:54321/0123456789abcdef0123456789abcdef",
])
def test_start_rejects_noncanonical_loopback(
    api_client, google_configured, redirect_uri,
):
    assert _start(api_client, redirect_uri=redirect_uri).status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize("provider", ["x", "google"])
def test_start_allows_exact_zuuli_mobile_uri(
    api_client, google_configured, settings, provider,
):
    settings.TWITTER_CLIENT_ID = "test-x-id"
    settings.TWITTER_CLIENT_SECRET = "test-x-secret"
    resp = _start(
        api_client, provider=provider, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert resp.status_code == 200, resp.content
    assert "code_challenge_method=S256" in resp.data["authorize_url"]
    authorize = urlparse(resp.data["authorize_url"])
    query = parse_qs(authorize.query)
    assert query["redirect_uri"] == [MOBILE_PROVIDER_REDIRECT_URI]
    assert query["state"] == [resp.data["authorization_state"]]
    assert query["code_challenge"] == [MOBILE_CHALLENGE]
    assert resp.data["state"] != resp.data["authorization_state"]
    assert resp.data["provider_redirect_uri"] == MOBILE_PROVIDER_REDIRECT_URI


@pytest.mark.django_db
def test_mobile_start_fails_closed_while_social_auth_is_disabled(
    api_client, google_configured, mocker,
):
    google_configured.ZUULI_SOCIAL_AUTH_ENABLED = False
    store = mocker.patch("dj.apps.social.views.store_state")

    response = _start(
        api_client,
        redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )

    assert response.status_code == 503, response.content
    assert response.data == {"detail": "mobile social OAuth is not enabled."}
    store.assert_not_called()


@pytest.mark.django_db
def test_disabled_mobile_gate_does_not_break_direct_desktop_start(
    api_client, google_configured,
):
    google_configured.ZUULI_SOCIAL_AUTH_ENABLED = False

    response = _start(api_client, redirect_uri=DESKTOP_REDIRECT_URI)

    assert response.status_code == 200, response.content


@pytest.mark.django_db
@pytest.mark.parametrize("unsafe", [
    "",
    "http://free2z.cash/api/auth/social/mobile/callback",
    "https://evil.example/api/auth/social/mobile/callback",
    "https://api.free2z.cash/api/auth/social/mobile/callback",
    "https://free2z.cash/api/auth/social/mobile/callback?next=evil",
    "https://free2z.cash/other",
])
def test_mobile_start_rejects_unsafe_relay_configuration(
    api_client, google_configured, settings, unsafe,
):
    settings.ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI = unsafe
    resp = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert resp.status_code == 503, resp.content


@pytest.mark.django_db
@pytest.mark.parametrize("redirect_uri", [
    "cash.free2z.zuuli://oauth/callback/extra",
    "cash.free2z.zuuli://oauth/callback?next=evil",
    "cash.free2z.zuuli://evil/callback",
    "CASH.FREE2Z.ZUULI://oauth/callback",
    "other://oauth/callback",
])
def test_start_rejects_mobile_uri_lookalikes(
    api_client, google_configured, redirect_uri,
):
    assert _start(api_client, redirect_uri=redirect_uri).status_code == 400


@pytest.mark.django_db
def test_start_rejects_non_pkce_github_mobile(
    api_client, settings,
):
    settings.GITHUB_CLIENT_ID = "test-github-id"
    settings.GITHUB_CLIENT_SECRET = "test-github-secret"
    resp = _start(
        api_client, provider="github", redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert resp.status_code == 400, resp.content


@pytest.mark.django_db
def test_mobile_start_requires_client_pkce_challenge(
    api_client, google_configured,
):
    missing = _start(api_client, redirect_uri=MOBILE_REDIRECT_URI)
    assert missing.status_code == 400, missing.content
    invalid = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge="not-a-valid-s256-challenge",
    )
    assert invalid.status_code == 400, invalid.content


@pytest.mark.django_db
def test_mobile_login_requires_original_verifier_and_is_one_shot(
    api_client, google_configured, mocker, caplog,
):
    exchange = _mock_exchange(mocker)
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert start.status_code == 200, start.content
    state = start.data["state"]
    relay = _relay(api_client, start)
    assert relay.status_code == 302, relay.content

    wrong = _login(
        api_client, state, redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier="Z" * 43,
    )
    assert wrong.status_code == 400, wrong.content
    exchange.assert_not_called()
    assert "reason=verifier_mismatch" in caplog.text
    assert "auth-code" not in caplog.text
    assert state not in caplog.text

    # A competing handler for the custom URI can see code/state, but cannot
    # burn the legitimate app's state without its verifier.
    replay = _login(
        api_client, state, redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=MOBILE_VERIFIER,
    )
    assert replay.status_code == 200, replay.content
    exchange.assert_called_once_with(
        "google", "auth-code", MOBILE_VERIFIER, MOBILE_PROVIDER_REDIRECT_URI,
    )

    consumed = _login(
        api_client, state, redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=MOBILE_VERIFIER,
    )
    assert consumed.status_code == 400, consumed.content


@pytest.mark.django_db
def test_mobile_login_state_cannot_be_burned_by_spoofed_direct_redirect(
    api_client, google_configured, mocker,
):
    exchange = _mock_exchange(mocker)
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert start.status_code == 200, start.content
    assert _relay(api_client, start).status_code == 302

    # A competing custom-scheme handler knows the completion state and code.
    # Lying about the redirect mode must not select the destructive direct-flow
    # lookup and consume the legitimate app's mobile completion state.
    spoofed = _login(
        api_client, start.data["state"], redirect_uri=REDIRECT_URI,
    )
    assert spoofed.status_code == 400, spoofed.content
    exchange.assert_not_called()

    legitimate = _login(
        api_client, start.data["state"], redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=MOBILE_VERIFIER,
    )
    assert legitimate.status_code == 200, legitimate.content
    exchange.assert_called_once()


@pytest.mark.django_db
def test_mobile_login_accepts_full_rfc7636_verifier_range(
    api_client, google_configured, mocker,
):
    verifier = "v" * 128
    exchange = _mock_exchange(mocker)
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=pkce_challenge(verifier),
    )
    assert start.status_code == 200, start.content
    assert _relay(api_client, start).status_code == 302

    response = _login(
        api_client, start.data["state"], redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=verifier,
    )
    assert response.status_code == 200, response.content
    exchange.assert_called_once_with(
        "google", "auth-code", verifier, MOBILE_PROVIDER_REDIRECT_URI,
    )


@pytest.mark.django_db
@pytest.mark.parametrize("provider", ["x", "google"])
def test_mobile_relay_is_fixed_no_store_and_provider_state_is_one_shot(
    api_client, google_configured, settings, provider,
):
    settings.TWITTER_CLIENT_ID = "test-x-id"
    settings.TWITTER_CLIENT_SECRET = "test-x-secret"
    start = _start(
        api_client, provider=provider, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    first = _relay(
        api_client, start, code="provider/code+value",
        redirect_uri="https://evil.example/steal",
    )
    assert first.status_code == 302, first.content
    location = urlparse(first["Location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == MOBILE_REDIRECT_URI
    assert parse_qs(location.query) == {
        "code": ["provider/code+value"],
        "state": [start.data["state"]],
    }
    assert first["Cache-Control"] == "no-store"
    assert first["Referrer-Policy"] == "no-referrer"
    assert "evil.example" not in first["Location"]

    replay = _relay(api_client, start, code="provider/code+value")
    assert replay.status_code == 400, replay.content
    assert replay["Cache-Control"] == "no-store"
    assert replay["Referrer-Policy"] == "no-referrer"


@pytest.mark.django_db
@pytest.mark.parametrize("provider", ["x", "google"])
def test_mobile_relay_forwards_cancellation_once(
    api_client, google_configured, settings, provider,
):
    settings.TWITTER_CLIENT_ID = "test-x-id"
    settings.TWITTER_CLIENT_SECRET = "test-x-secret"
    start = _start(
        api_client, provider=provider, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    cancelled = _relay(api_client, start, error="access_denied")
    assert cancelled.status_code == 302, cancelled.content
    assert parse_qs(urlparse(cancelled["Location"]).query) == {
        "error": ["access_denied"],
        "state": [start.data["state"]],
    }
    assert _relay(api_client, start, error="access_denied").status_code == 400


@pytest.mark.django_db
def test_mobile_relay_rejects_duplicate_parameters_without_redirect(
    api_client, google_configured, caplog,
):
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    state = start.data["authorization_state"]
    duplicate = api_client.get(
        f"/api/auth/social/mobile/callback?state={state}&state={state}&code=a",
    )
    assert duplicate.status_code == 400, duplicate.content
    assert "Location" not in duplicate
    assert "reason=malformed" in caplog.text
    assert state not in caplog.text


@pytest.mark.django_db
def test_mobile_relay_binds_exact_code_before_exchange(
    api_client, google_configured, mocker,
):
    exchange = _mock_exchange(mocker)
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert _relay(api_client, start, code="real-code").status_code == 302
    substituted = _login(
        api_client, start.data["state"], code="other-code",
        redirect_uri=MOBILE_REDIRECT_URI, code_verifier=MOBILE_VERIFIER,
    )
    assert substituted.status_code == 400, substituted.content
    exchange.assert_not_called()
    replay = _login(
        api_client, start.data["state"], code="real-code",
        redirect_uri=MOBILE_REDIRECT_URI, code_verifier=MOBILE_VERIFIER,
    )
    assert replay.status_code == 200, replay.content
    exchange.assert_called_once()


@pytest.mark.django_db
def test_mobile_completion_has_fresh_bounded_window(
    api_client, google_configured, mocker,
):
    exchange = _mock_exchange(mocker)
    clock = mocker.patch("dj.apps.social.views.time.time", return_value=1000)
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert _relay(api_client, start).status_code == 302

    clock.return_value = 1300
    expired = _login(
        api_client, start.data["state"], redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=MOBILE_VERIFIER,
    )
    assert expired.status_code == 400, expired.content
    exchange.assert_not_called()

    # Validation failure did not consume the one-shot state. Moving the test
    # clock back inside the server-minted window models a timely app resume.
    clock.return_value = 1299
    timely = _login(
        api_client, start.data["state"], redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=MOBILE_VERIFIER,
    )
    assert timely.status_code == 200, timely.content


@pytest.mark.django_db
def test_mobile_completion_allows_bounded_cross_pod_clock_skew(
    api_client, google_configured, mocker,
):
    exchange = _mock_exchange(mocker)
    clock = mocker.patch("dj.apps.social.views.time.time", return_value=1004)
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    clock.return_value = 1000
    assert _relay(api_client, start).status_code == 302
    response = _login(
        api_client, start.data["state"], redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=MOBILE_VERIFIER,
    )
    assert response.status_code == 200, response.content
    exchange.assert_called_once()


@pytest.mark.django_db
def test_login_rejects_non_string_json_without_500(
    api_client, google_configured,
):
    resp = api_client.post(
        "/api/auth/social/google/",
        {"code": [], "state": {}, "redirect_uri": 123},
        format="json",
    )
    assert resp.status_code == 400, resp.content


@pytest.mark.django_db
def test_web_flow_rejects_client_supplied_pkce(
    api_client, google_configured,
):
    resp = _start(api_client, code_challenge=MOBILE_CHALLENGE)
    assert resp.status_code == 400, resp.content


# --------------------------------------------------------------------------- #
# (a) unauthenticated login-or-create
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_login_creates_creator_and_identity(api_client, google_configured, mocker):
    _mock_exchange(mocker)

    start = _start(api_client)
    assert start.status_code == 200, start.content
    state = start.data["state"]
    assert "code_challenge=" in start.data["authorize_url"]

    resp = _login(api_client, state)
    assert resp.status_code == 200, resp.content
    body = resp.data
    assert body["token"]
    assert body["expiry"]
    assert body["provider"] == "google"
    assert body["created"] is True
    assert body["linked"] is True

    identity = SocialIdentity.objects.get(provider="google", provider_uid=GOOGLE_UID)
    creator = identity.creator
    assert creator.username == body["username"]
    assert not creator.has_usable_password()
    assert AuthToken.objects.filter(user=creator).count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize("handle", ["api", "TrEnDiNg@example.com"])
def test_login_suffixes_reserved_provider_handle(
    handle, api_client, google_configured, mocker,
):
    _mock_exchange(mocker, handle=handle)

    start = _start(api_client)
    resp = _login(api_client, start.data["state"])

    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is True
    assert resp.data["username"] == handle.split("@")[0] + "1"


@pytest.mark.django_db
def test_second_login_reuses_same_creator(api_client, google_configured, mocker):
    _mock_exchange(mocker)

    start1 = _start(api_client)
    resp1 = _login(api_client, start1.data["state"])
    assert resp1.status_code == 200, resp1.content
    assert resp1.data["created"] is True
    creator_id = SocialIdentity.objects.get(
        provider="google", provider_uid=GOOGLE_UID).creator_id

    start2 = _start(api_client)
    resp2 = _login(api_client, start2.data["state"])
    assert resp2.status_code == 200, resp2.content
    assert resp2.data["created"] is False
    assert resp2.data["linked"] is False

    assert SocialIdentity.objects.filter(
        provider="google", provider_uid=GOOGLE_UID).count() == 1
    assert SocialIdentity.objects.get(
        provider="google", provider_uid=GOOGLE_UID).creator_id == creator_id
    assert resp2.data["username"] == resp1.data["username"]


# --------------------------------------------------------------------------- #
# (b) authenticated associate
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_associate_links_identity_to_authenticated_creator(
    api_client, creator_factory, google_configured, mocker,
    recent_login,
):
    _mock_exchange(mocker)
    user = creator_factory()
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)
    before_epoch = Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk)

    start = _start(api_client)
    resp = _login(api_client, start.data["state"])
    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is False
    assert resp.data["linked"] is True
    assert resp.data["username"] == user.username

    identity = SocialIdentity.objects.get(
        provider="google", provider_uid=GOOGLE_UID)
    assert identity.creator_id == user.id

    #. Linking ADDS a principal, which invalidates nothing, so the
    # ownership counter deliberately does not move. The UNLINK below is the
    # revocation that does. See `dj.apps.ktauth.epoch` for the asymmetry.
    assert Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk) == before_epoch


# --------------------------------------------------------------------------- #
# (c) 409 when the identity is linked elsewhere
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_associate_conflict_when_identity_owned_by_other(
    api_client, creator_factory, google_configured, mocker,
):
    _mock_exchange(mocker)

    owner = creator_factory()
    SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid=GOOGLE_UID,
        handle=GOOGLE_HANDLE,
    )

    other = creator_factory()
    api_client.force_authenticate(user=other)

    start = _start(api_client)
    resp = _login(api_client, start.data["state"])
    assert resp.status_code == 409, resp.content
    assert SocialIdentity.objects.get(
        provider="google", provider_uid=GOOGLE_UID).creator_id == owner.id


# --------------------------------------------------------------------------- #
#  refuse-not-link: a colliding handle must never duplicate an account
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_anonymous_login_with_colliding_handle_is_refused(
    api_client, creator_factory, google_configured, mocker,
):
    """Existing "Alice", anonymous caller presenting handle "alice".

    A matching handle proves nothing about ownership -- anyone can register
    @alice on the provider -- so this must refuse rather than attach or
    mint an "alice1" lookalike duplicate.
    """
    creator_factory(username="Alice")
    _mock_exchange(mocker, handle="alice@example.com")

    start = _start(api_client)
    resp = _login(api_client, start.data["state"])

    assert resp.status_code == 409, resp.content
    assert resp.data["detail"].startswith("A free2z account with this name")
    assert "settings" in resp.data["detail"]
    # Nothing was created and nobody was logged in: no token in the body.
    assert "token" not in resp.data
    assert Creator.objects.count() == 1
    assert not SocialIdentity.objects.exists()


@pytest.mark.django_db
def test_anonymous_login_with_unique_handle_still_provisions(
    api_client, creator_factory, google_configured, mocker,
):
    """Positive control for the refusal above: free handle provisions.

    An unrelated account exists (proving the refusal is per-handle, not
    per-existing-account), but the presented handle matches nobody.
    """
    creator_factory(username="somebodyelse")
    _mock_exchange(mocker)

    start = _start(api_client)
    resp = _login(api_client, start.data["state"])

    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is True
    assert resp.data["token"]
    assert Creator.objects.count() == 2
    assert SocialIdentity.objects.filter(
        provider="google", provider_uid=GOOGLE_UID,
    ).count() == 1


@pytest.mark.django_db
def test_associate_branch_wins_over_handle_collision(
    api_client, creator_factory, google_configured, mocker,
    recent_login,
):
    """Authenticated association links even when the handle collides.

    Ownership here is proven by the authenticated session, so the
    association branch runs before any collision consideration.
    """
    creator_factory(username="Alice")
    user = creator_factory()
    api_client.force_authenticate(user=user)
    recent_login(api_client, user)
    _mock_exchange(mocker, handle="alice@example.com")

    start = _start(api_client)
    resp = _login(api_client, start.data["state"])

    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is False
    assert resp.data["linked"] is True
    identity = SocialIdentity.objects.get(
        provider="google", provider_uid=GOOGLE_UID,
    )
    assert identity.creator_id == user.id
    # Association, not duplication.
    assert Creator.objects.count() == 2


@pytest.mark.django_db
def test_junk_handle_falls_back_to_provider_uid_and_still_provisions(
    api_client, creator_factory, google_configured, mocker,
):
    """An empty/junk handle yields no human claim to refuse on.

    ``{provider}{uid}`` is machine-derived, so an unrelated account that
    happens to hold that exact name does NOT trigger the refusal --
    provisioning with suffixing stays allowed there.
    """
    creator_factory(username="googlegoogle-sub-1234567890")
    _mock_exchange(mocker, handle="@")

    start = _start(api_client)
    resp = _login(api_client, start.data["state"])

    assert resp.status_code == 200, resp.content
    assert resp.data["created"] is True
    assert resp.data["username"] == "googlegoogle-sub-12345678901"
    assert Creator.objects.count() == 2


# --------------------------------------------------------------------------- #
# (e) unknown / expired / mismatched state rejected
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_login_rejects_unknown_state(api_client, google_configured, mocker):
    _mock_exchange(mocker)
    resp = _login(api_client, state="never-issued-this")
    assert resp.status_code == 400, resp.content
    assert not SocialIdentity.objects.exists()


@pytest.mark.django_db
def test_state_is_single_use(api_client, google_configured, mocker):
    _mock_exchange(mocker)
    start = _start(api_client)
    state = start.data["state"]

    ok = _login(api_client, state)
    assert ok.status_code == 200, ok.content

    replay = _login(api_client, state)
    assert replay.status_code == 400, replay.content


def test_shared_state_pop_is_atomic_and_a_miss_allocates_nothing(mocker):
    """Random attacker state values must remain read-only Redis misses."""
    fake_cache = mocker.Mock()
    redis_client = fake_cache.client.get_client.return_value
    redis_client.eval.return_value = None
    fake_cache.make_key.return_value = "test:socialstate:random-state"
    mocker.patch.object(state_store, "cache", fake_cache)
    mocker.patch.object(state_store, "_cache_is_shared", return_value=True)

    assert state_store.pop_state("random-state") is None
    redis_client.eval.assert_called_once_with(
        state_store._POP_SCRIPT, 1, "test:socialstate:random-state",
    )
    fake_cache.set.assert_not_called()
    fake_cache.add.assert_not_called()


def test_shared_state_pop_decodes_the_single_atomic_result(mocker):
    fake_cache = mocker.Mock()
    redis_client = fake_cache.client.get_client.return_value
    redis_client.eval.return_value = b'{"provider":"google"}'
    fake_cache.client.decode.side_effect = lambda raw: raw
    fake_cache.make_key.return_value = "test:socialstate:issued-state"
    mocker.patch.object(state_store, "cache", fake_cache)
    mocker.patch.object(state_store, "_cache_is_shared", return_value=True)

    assert state_store.pop_state("issued-state") == {"provider": "google"}


def test_shared_state_pop_logs_backend_failure_and_fails_closed(mocker):
    fake_cache = mocker.Mock()
    fake_cache.client.get_client.side_effect = ConnectionError("redis down")
    mocker.patch.object(state_store, "cache", fake_cache)
    mocker.patch.object(state_store, "_cache_is_shared", return_value=True)
    logged = mocker.patch.object(state_store.logger, "exception")

    assert state_store.pop_state("issued-state") is None
    logged.assert_called_once_with("social OAuth state atomic pop failed")


def test_shared_state_store_honors_bounded_completion_ttl(mocker):
    fake_cache = mocker.Mock()
    mocker.patch.object(state_store, "cache", fake_cache)
    mocker.patch.object(state_store, "_cache_is_shared", return_value=True)

    state_store.store_state("completion-state", {"flow": "mobile_received"}, 300)

    fake_cache.set.assert_called_once_with(
        "socialstate:completion-state",
        '{"flow": "mobile_received"}',
        300,
    )


def test_default_test_cache_uses_cross_worker_database_fallback():
    assert state_store._cache_is_shared() is False


@pytest.mark.skipif(
    not os.environ.get("REDIS_HOST"),
    reason="CI supplies the real Redis service used by production",
)
def test_real_redis_pop_is_atomic_single_use_and_miss_is_read_only(settings):
    host = os.environ["REDIS_HOST"]
    port = os.environ.get("REDIS_PORT", "6379")
    settings.CACHES = {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": f"redis://{host}:{port}/1",
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                "PREFIX": "zuuli-oauth-test",
            },
        },
    }
    key = "real-redis-state-0123456789"
    miss = "real-redis-miss-0123456789"
    backend = state_store.caches["default"]
    raw_client = backend.client.get_client(write=True)
    raw_key = backend.make_key(state_store._key(key))
    raw_miss = backend.make_key(state_store._key(miss))
    raw_client.delete(raw_key, raw_miss)

    state_store.store_state(key, {"provider": "google"})
    assert state_store._cache_is_shared() is True
    assert state_store.pop_state(key) == {"provider": "google"}
    assert state_store.pop_state(key) is None
    assert raw_client.exists(raw_key) == 0

    assert raw_client.exists(raw_miss) == 0
    assert state_store.pop_state(miss) is None
    assert raw_client.exists(raw_miss) == 0

    race = "real-redis-race-0123456789"
    state_store.store_state(race, {"provider": "google"})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(state_store.pop_state, [race, race]))
    assert results.count({"provider": "google"}) == 1
    assert results.count(None) == 1


@pytest.mark.django_db
@pytest.mark.skipif(
    not os.environ.get("REDIS_HOST"),
    reason="CI supplies the real Redis service used by production",
)
def test_real_redis_mobile_round_trip_uses_short_completion_ttl(
    api_client, google_configured, settings, mocker,
):
    host = os.environ["REDIS_HOST"]
    port = os.environ.get("REDIS_PORT", "6379")
    settings.CACHES = {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": f"redis://{host}:{port}/1",
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                "PREFIX": "zuuli-oauth-round-trip",
            },
        },
    }
    exchange = _mock_exchange(mocker)
    start = _start(
        api_client, redirect_uri=MOBILE_REDIRECT_URI,
        code_challenge=MOBILE_CHALLENGE,
    )
    assert start.status_code == 200, start.content
    assert _relay(api_client, start).status_code == 302

    backend = state_store.caches["default"]
    raw_client = backend.client.get_client(write=True)
    completion_key = backend.make_key(
        state_store._key(start.data["state"]),
    )
    assert 0 < raw_client.ttl(completion_key) <= 300

    login = _login(
        api_client, start.data["state"], redirect_uri=MOBILE_REDIRECT_URI,
        code_verifier=MOBILE_VERIFIER,
    )
    assert login.status_code == 200, login.content
    exchange.assert_called_once()
    assert raw_client.exists(completion_key) == 0


@pytest.mark.django_db
def test_login_rejects_mismatched_redirect_uri(api_client, google_configured, mocker):
    _mock_exchange(mocker)
    start = _start(api_client)
    state = start.data["state"]
    # State was bound to REDIRECT_URI; posting a different (even if allowed) one
    # must be rejected before any code exchange.
    resp = _login(
        api_client, state, redirect_uri="http://localhost:3000/other")
    assert resp.status_code == 400, resp.content


# --------------------------------------------------------------------------- #
# providers endpoint (public; no secret leak)
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_providers_endpoint_reflects_configuration(api_client, google_configured):
    resp = api_client.get("/api/auth/social/providers/")
    assert resp.status_code == 200, resp.content
    by_key = {p["provider"]: p["configured"] for p in resp.data["providers"]}
    assert by_key["google"] is True
    assert by_key["x"] is False
    assert by_key["github"] is False
    # No secret value anywhere in the payload.
    assert "test-google-secret" not in str(resp.data)


@pytest.mark.django_db
def test_generic_providers_remain_truthful_when_mobile_rollout_is_disabled(
    api_client, google_configured,
):
    google_configured.ZUULI_SOCIAL_AUTH_ENABLED = False
    google_configured.GITHUB_CLIENT_ID = "github-client"
    google_configured.GITHUB_CLIENT_SECRET = "github-secret"

    response = api_client.get("/api/auth/social/providers/")

    assert response.status_code == 200, response.content
    assert response["Cache-Control"] == "no-store"
    by_key = {
        entry["provider"]: entry["configured"]
        for entry in response.data["providers"]
    }
    assert by_key["google"] is True
    assert by_key["github"] is True


@pytest.mark.django_db
def test_mobile_providers_fail_closed_until_rollout_is_enabled(
    api_client, google_configured,
):
    google_configured.ZUULI_SOCIAL_AUTH_ENABLED = False

    response = api_client.get("/api/auth/social/mobile/providers/")

    assert response.status_code == 200, response.content
    assert response["Cache-Control"] == "no-store"
    assert all(not entry["configured"] for entry in response.data["providers"])


@pytest.mark.django_db
def test_mobile_providers_fail_closed_without_safe_relay(
    api_client, google_configured,
):
    google_configured.ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI = "unset"

    response = api_client.get("/api/auth/social/mobile/providers/")

    assert response.status_code == 200, response.content
    assert all(not entry["configured"] for entry in response.data["providers"])


@pytest.mark.django_db
def test_mobile_providers_advertise_only_supported_ready_providers(
    api_client, settings,
):
    settings.ZUULI_SOCIAL_AUTH_ENABLED = True
    settings.ZUULI_MOBILE_OAUTH_PROVIDER_REDIRECT_URI = (
        "https://free2z.cash/api/auth/social/mobile/callback"
    )
    settings.GOOGLE_CLIENT_ID = "google-client"
    settings.GOOGLE_CLIENT_SECRET = "google-secret"
    settings.TWITTER_CLIENT_ID = "x-client"
    settings.TWITTER_CLIENT_SECRET = "x-secret"
    settings.GITHUB_CLIENT_ID = "github-client"
    settings.GITHUB_CLIENT_SECRET = "github-secret"

    response = api_client.get("/api/auth/social/mobile/providers/")

    assert response.status_code == 200, response.content
    by_key = {
        entry["provider"]: entry["configured"]
        for entry in response.data["providers"]
    }
    assert by_key == {"x": True, "google": True, "github": False}


@pytest.mark.django_db
def test_mobile_providers_answer_a_stale_token_instead_of_401(
    api_client, google_configured,
):
    """A revoked/expired token must not hide the launch-time contract.

    AllowAny does not switch authentication off. Without
    `authentication_classes = []` knox rejects a stale Authorization header
    with 401 before the view runs, and the native app loses the social login
    button precisely when its stored token has gone bad.
    """
    google_configured.ZUULI_SOCIAL_AUTH_ENABLED = True

    api_client.credentials(HTTP_AUTHORIZATION="Token deadbeefdeadbeefdeadbeef")
    response = api_client.get("/api/auth/social/mobile/providers/")

    assert response.status_code == 200, response.content
    by_key = {
        entry["provider"]: entry["configured"]
        for entry in response.data["providers"]
    }
    assert by_key["google"] is True


# --------------------------------------------------------------------------- #
# list + unlink (auth)
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_list_and_unlink_own_identities(api_client, creator_factory):
    user = creator_factory()
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        handle=GOOGLE_HANDLE,
    )
    api_client.force_authenticate(user=user)

    listing = api_client.get("/api/auth/social/")
    assert listing.status_code == 200, listing.content
    assert len(listing.data) == 1
    assert listing.data[0]["provider"] == "google"
    assert listing.data[0]["provider_uid"] == GOOGLE_UID

    before_epoch = Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk)

    unlink = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")
    assert unlink.status_code == 204, unlink.content
    assert not SocialIdentity.objects.filter(creator=user).exists()
    #. Unlinking is an account-ownership event too: the owner just
    # evicted a credential that could sign in as them.
    assert Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk) == before_epoch + 1

    missing = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")
    assert missing.status_code == 404, missing.content
    #...and a 404 removed nothing, so it counts nothing.
    assert Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk) == before_epoch + 1


@pytest.mark.django_db
def test_social_list_marks_the_selected_passwordless_fallback(
    api_client, creator_factory, google_configured,
):
    user = creator_factory()
    user.set_unusable_password()
    user.save(update_fields=["password", "password_set", "updated_at"])
    fallback = SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="selected-fallback",
        linked_at_epoch=1,
    )
    rejected = SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid="rejected-fallback",
        linked_at_epoch=1,
    )
    SocialIdentity.objects.filter(pk=fallback.pk).update(
        verified_at=timezone.now() - timezone.timedelta(days=2),
    )
    SocialIdentity.objects.filter(pk=rejected.pk).update(
        verified_at=timezone.now() - timezone.timedelta(days=1),
    )
    epoch.bump_account_epoch(
        user.pk, event=epoch.EVENT_CREDENTIAL_ADMIN_EDIT,
    )
    user.refresh_from_db()
    api_client.force_authenticate(user=user)

    listing = api_client.get("/api/auth/social/")

    assert listing.status_code == 200, listing.content
    needs_reconnect = {
        row["provider_uid"]: row["needs_reconnect"] for row in listing.data
    }
    assert needs_reconnect == {
        "selected-fallback": False,
        "rejected-fallback": True,
    }


# --------------------------------------------------------------------------- #
# the last-sign-in-method guard on unlink
# --------------------------------------------------------------------------- #
UNLINK_ZADDR = "t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs"


@pytest.fixture
def unlink_providers(settings):
    """Google, GitHub and the legacy Twitter flow are configured, so their
    identities can sign in.
    """
    settings.TWITTER_CLIENT_ID = "test-x-id"
    settings.TWITTER_CLIENT_SECRET = "test-x-secret"
    settings.GOOGLE_CLIENT_ID = "test-google-id"
    settings.GOOGLE_CLIENT_SECRET = "test-google-secret"
    settings.GITHUB_CLIENT_ID = "test-github-id"
    settings.GITHUB_CLIENT_SECRET = "test-github-secret"
    return settings


def _passwordless_user(creator_factory):
    user = creator_factory()
    user.set_unusable_password()
    user.save()
    return Creator.objects.get(pk=user.pk)


def _epoch(user):
    return Creator.objects.values_list(
        "kt_account_epoch", flat=True,
    ).get(pk=user.pk)


@pytest.mark.django_db
def test_unlink_refuses_the_last_sign_in_method(
    api_client, creator_factory, unlink_providers,
):
    user = _passwordless_user(creator_factory)
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=user.kt_account_epoch,
    )
    before = _epoch(user)
    api_client.force_authenticate(user=user)

    resp = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")

    assert resp.status_code == 409, resp.content
    assert resp.data["detail"] == (
        "Set a password or reconnect another login method before removing this one."
    )
    assert SocialIdentity.objects.filter(creator=user).count() == 1
    # A refusal changed nothing, so it is not an ownership event.
    assert _epoch(user) == before


@pytest.mark.django_db
def test_unlink_refuses_when_the_only_other_login_is_disabled_twitter(
    api_client, creator_factory, unlink_providers,
):
    from dj.apps.twitter.models import TwitterProfile

    user = _passwordless_user(creator_factory)
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=user.kt_account_epoch,
    )
    TwitterProfile.objects.create(
        creator=user, twitter_id="99", username="tw99", allow_login=False,
        linked_at_epoch=user.kt_account_epoch,
    )
    api_client.force_authenticate(user=user)

    resp = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")

    assert resp.status_code == 409, resp.content
    assert SocialIdentity.objects.filter(creator=user).exists()


@pytest.mark.django_db
def test_unlink_allows_removal_when_another_method_survives_the_bump(
    api_client, creator_factory, unlink_providers,
):
    """Positive control for the refusals above. It also checks the property
    the guard relies on: after the unlink's epoch bump makes the survivor
    stale, the survivor can still sign in.
    """
    from dj.apps.identity.methods import usable_signin_methods
    from dj.apps.zauth.models import ZcashIdentity

    user = _passwordless_user(creator_factory)
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=user.kt_account_epoch,
    )
    zcash = ZcashIdentity.objects.create(
        creator=user, zcash_address=UNLINK_ZADDR,
        linked_at_epoch=user.kt_account_epoch,
    )
    before = _epoch(user)
    api_client.force_authenticate(user=user)

    resp = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")

    assert resp.status_code == 204, resp.content
    assert not SocialIdentity.objects.filter(creator=user).exists()
    assert _epoch(user) == before + 1
    after = Creator.objects.get(pk=user.pk)
    assert [(m.kind, m.pk) for m in usable_signin_methods(after)] == [
        ("zcash", zcash.pk),
    ]


@pytest.mark.django_db
def test_unlink_of_someone_elses_identity_is_still_a_404(
    api_client, creator_factory,
):
    owner = _passwordless_user(creator_factory)
    SocialIdentity.objects.create(
        creator=owner, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=owner.kt_account_epoch,
    )
    api_client.force_authenticate(user=creator_factory())

    resp = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")

    assert resp.status_code == 404, resp.content
    assert SocialIdentity.objects.filter(creator=owner).exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_unlinks_cannot_remove_both_of_the_last_two_methods(
    creator_factory, monkeypatch, unlink_providers,
):
    """Two tabs unlink the account's two identities at the same moment.

    Each request, checked alone, sees the other identity as the survivor. The
    guard must serialize them, so exactly one succeeds. The sleep widens the
    window between the check and the delete. Without the row lock in
    ``can_remove``, both checks pass inside that window and both deletes
    commit, which leaves the account with no way in.
    """
    import threading
    import time

    from django.db import connection
    from rest_framework.test import APIClient

    from dj.apps.social import views as social_views

    real_can_remove = social_views.can_remove

    def slow_can_remove(creator, method):
        answer = real_can_remove(creator, method)
        time.sleep(0.5)
        return answer

    monkeypatch.setattr(social_views, "can_remove", slow_can_remove)

    user = _passwordless_user(creator_factory)
    for provider, uid in (("google", GOOGLE_UID), ("github", "gh-1")):
        SocialIdentity.objects.create(
            creator=user, provider=provider, provider_uid=uid,
            linked_at_epoch=user.kt_account_epoch,
        )

    barrier = threading.Barrier(2)
    statuses = [None, None]

    def unlink(i, provider, uid):
        try:
            client = APIClient()
            client.force_authenticate(user=Creator.objects.get(pk=user.pk))
            barrier.wait(timeout=10)
            statuses[i] = client.delete(
                f"/api/auth/social/{provider}/{uid}/"
            ).status_code
        except Exception as exc:  # asserted on below
            statuses[i] = exc
        finally:
            connection.close()

    threads = [
        threading.Thread(target=unlink, args=(0, "google", GOOGLE_UID)),
        threading.Thread(target=unlink, args=(1, "github", "gh-1")),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads), "unlink deadlocked"

    assert sorted(statuses) == [204, 409], statuses
    assert SocialIdentity.objects.filter(creator=user).count() == 1


@pytest.mark.django_db(transaction=True)
def test_a_survivor_removed_without_the_account_lock_is_not_counted(
    creator_factory, unlink_providers,
):
    """The legacy Twitter delete removes its row first and takes the Creator
    lock only later, for the epoch bump. The guard must not count that
    half-deleted row as a survivor. It locks the rows it counts. So the
    interleaving below either blocks until the Twitter delete commits (and
    then sees it gone) or deadlocks, and Postgres aborts one side. Either
    way at least one method survives. Without the row lock both commit, and
    the account is left with nothing.
    """
    import threading
    import time

    from django.db import connection, transaction
    from django.db.models import F
    from rest_framework.test import APIClient

    from dj.apps.twitter.models import TwitterProfile

    user = _passwordless_user(creator_factory)
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=user.kt_account_epoch,
    )
    twitter = TwitterProfile.objects.create(
        creator=user, twitter_id="77", username="tw77", allow_login=True,
        linked_at_epoch=user.kt_account_epoch,
    )
    row_deleted = threading.Event()
    outcome = {}

    def legacy_twitter_delete():
        # The shape of `TwitterDeleteView.delete` on main: DELETE the row,
        # then bump the epoch, in one transaction with no Creator lock first.
        try:
            with transaction.atomic():
                TwitterProfile.objects.filter(pk=twitter.pk).delete()
                row_deleted.set()
                # Long enough that the unlink reaches its guard while this
                # row is deleted but uncommitted. Too short, and the bump
                # below takes the Creator lock first, which serializes the
                # two requests and hides the bug from the negative control.
                time.sleep(2)
                Creator.objects.filter(pk=user.pk).update(
                    kt_account_epoch=F("kt_account_epoch") + 1,
                )
            outcome["twitter"] = "committed"
        except Exception as exc:  # asserted on below
            outcome["twitter"] = exc
        finally:
            row_deleted.set()
            connection.close()

    def social_unlink():
        try:
            assert row_deleted.wait(timeout=10)
            client = APIClient()
            client.force_authenticate(user=Creator.objects.get(pk=user.pk))
            outcome["social"] = client.delete(
                f"/api/auth/social/google/{GOOGLE_UID}/"
            ).status_code
        except Exception as exc:  # asserted on below
            outcome["social"] = exc
        finally:
            connection.close()

    threads = [
        threading.Thread(target=legacy_twitter_delete),
        threading.Thread(target=social_unlink),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads), outcome

    remaining = (
        SocialIdentity.objects.filter(creator=user).count()
        + TwitterProfile.objects.filter(creator=user).count()
    )
    assert remaining >= 1, outcome


@pytest.mark.django_db
def test_unlink_rolls_back_when_the_bump_leaves_no_way_in(
    api_client, creator_factory, unlink_providers, monkeypatch,
):
    """The pre-check predicted a survivor; the epoch bump then invalidated
    it.  does exactly this when its fallback selection picks an older
    identity on an unconfigured provider and refuses the rest. Here the
    bump is hooked to disable the survivor, so the test does not depend on
    . The post-bump check must refuse, and the whole unlink must roll
    back: the identity, the epoch, the survivor and the token revocation.
    """
    from dj.apps.social import views as social_views
    from dj.apps.twitter.models import TwitterProfile

    user = _passwordless_user(creator_factory)
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=user.kt_account_epoch,
    )
    survivor = TwitterProfile.objects.create(
        creator=user, twitter_id="55", username="tw55", allow_login=True,
        linked_at_epoch=user.kt_account_epoch,
    )
    AuthToken.objects.create(user=user)
    tokens_before = AuthToken.objects.filter(user=user).count()
    before = _epoch(user)
    real_bump = social_views.bump_account_epoch

    def bump_that_invalidates_the_survivor(user_id, **kwargs):
        real_bump(user_id, **kwargs)
        TwitterProfile.objects.filter(pk=survivor.pk).update(allow_login=False)

    monkeypatch.setattr(
        social_views, "bump_account_epoch", bump_that_invalidates_the_survivor,
    )
    api_client.force_authenticate(user=user)

    resp = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")

    assert resp.status_code == 409, resp.content
    assert resp.data["detail"] == (
        "Set a password or reconnect another login method before removing this one."
    )
    assert SocialIdentity.objects.filter(creator=user).count() == 1
    assert _epoch(user) == before
    assert TwitterProfile.objects.get(pk=survivor.pk).allow_login is True
    assert AuthToken.objects.filter(user=user).count() == tokens_before


def _raise_operational_error(cause):
    from django.db import OperationalError

    def boom(*args, **kwargs):
        try:
            raise cause
        except Exception as exc:
            raise OperationalError(str(exc)) from exc

    return boom


@pytest.mark.django_db
def test_unlink_deadlock_is_a_retryable_503_not_a_500(
    api_client, creator_factory, unlink_providers, monkeypatch, caplog,
):
    import logging

    import psycopg

    caplog.set_level(logging.INFO)

    from dj.apps.social import views as social_views

    user = creator_factory()
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=user.kt_account_epoch,
    )
    monkeypatch.setattr(
        social_views, "can_remove",
        _raise_operational_error(
            psycopg.errors.DeadlockDetected("deadlock detected"),
        ),
    )
    api_client.force_authenticate(user=user)

    resp = api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")

    assert resp.status_code == 503, resp.content
    assert resp["Retry-After"] == "1"
    assert SocialIdentity.objects.filter(creator=user).count() == 1
    # Designed and retryable: one WARNING from the view, and no
    # django.request ERROR for the 5xx.
    assert not [r for r in caplog.records if r.name == "django.request"]
    assert [
        r.levelname for r in caplog.records
        if r.name == "dj.apps.social.views" and "deadlock" in r.getMessage()
    ] == ["WARNING"]


@pytest.mark.django_db
def test_unlink_other_operational_errors_still_raise(
    api_client, creator_factory, unlink_providers, monkeypatch,
):
    """Negative control for the deadlock handler: it is not a catch-all."""
    import psycopg
    from django.db import OperationalError

    from dj.apps.social import views as social_views

    user = creator_factory()
    SocialIdentity.objects.create(
        creator=user, provider="google", provider_uid=GOOGLE_UID,
        linked_at_epoch=user.kt_account_epoch,
    )
    monkeypatch.setattr(
        social_views, "can_remove",
        _raise_operational_error(psycopg.errors.QueryCanceled("timeout")),
    )
    api_client.force_authenticate(user=user)

    with pytest.raises(OperationalError):
        api_client.delete(f"/api/auth/social/google/{GOOGLE_UID}/")


@pytest.mark.django_db
def test_list_requires_auth(api_client):
    resp = api_client.get("/api/auth/social/")
    assert resp.status_code in (401, 403), resp.content


def test_web_reauthentication_requires_explicit_callback_readiness(api_client, google_configured):
    google_configured.SOCIAL_WEB_REAUTH_PROVIDERS = ()
    response = api_client.get("/api/auth/social/providers/")
    assert all(not entry["web_reauthentication"] for entry in response.data["providers"])
    google_configured.SOCIAL_WEB_REAUTH_PROVIDERS = ("google",)
    response = api_client.get("/api/auth/social/providers/")
    by_key = {entry["provider"]: entry["web_reauthentication"] for entry in response.data["providers"]}
    assert by_key["google"] is True
    assert by_key["github"] is False


@pytest.mark.parametrize("configured", [False, True])
@pytest.mark.parametrize("raw, expected", [
    (None, frozenset()),
    ("", frozenset()),
    ("x", frozenset({"x"})),
    ("twitter", frozenset({"x"})),
    (" x, twitter, google, github, unknown ", frozenset({"x", "google", "github"})),
    ("legacy-x, X, unknown", frozenset()),
])
def test_modern_x_web_readiness_uses_canonical_settings(
    api_client, settings, monkeypatch, raw, expected, configured,
):
    # Execute the actual settings module in a fresh namespace: Django's imported
    # settings module is cached, so merely changing os.environ would test nothing.
    if raw is None:
        monkeypatch.delenv("SOCIAL_WEB_REAUTH_PROVIDERS", raising=False)
    else:
        monkeypatch.setenv("SOCIAL_WEB_REAUTH_PROVIDERS", raw)
    module_path = Path(__file__).resolve().parents[2] / "free2z" / "settings.py"
    parsed = runpy.run_path(
        str(module_path), run_name="dj.free2z._readiness_settings",
    )["SOCIAL_WEB_REAUTH_PROVIDERS"]
    assert parsed == expected
    settings.SOCIAL_WEB_REAUTH_PROVIDERS = parsed
    settings.TWITTER_CLIENT_ID = "test-x-client" if configured else ""
    settings.TWITTER_CLIENT_SECRET = "test-x-secret" if configured else ""
    response = api_client.get("/api/auth/social/providers/")
    assert response.status_code == 200
    by_key = {entry["provider"]: entry for entry in response.data["providers"]}
    assert "twitter" not in by_key
    assert by_key["x"]["configured"] is configured
    assert by_key["x"]["web_reauthentication"] is (configured and "x" in expected)
