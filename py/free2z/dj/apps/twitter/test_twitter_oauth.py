"""Security tests for the legacy Twitter OAuth callback boundaries.

``is_valid_twitter_request`` had a dead ``False`` expression (missing
``return``) so it *always* returned ``True`` — the OAuth ``state`` binding was
a no-op, enabling login-CSRF / session fixation on the Twitter callback.
"""
import json
import logging
import signal
import time
import uuid

import pytest
from django.contrib.auth.models import AnonymousUser
from django.contrib.sessions.backends.db import SessionStore
from django.test import RequestFactory
from rest_framework.exceptions import Throttled

from dj.apps.social.clients import pkce_challenge
from dj.apps.twitter import views
from dj.apps.twitter.models import TwitterProfile
from dj.apps.twitter.views import (
    TWITTER_OAUTH2_HANDSHAKE_COOKIE,
    TWITTER_OAUTH2_HANDSHAKE_MAX_AGE,
    TwitterCallbackView,
    is_valid_twitter_request,
    sign_oauth2_handshake,
)
from twatter.v1.client import (
    TWITTER_OAUTH1_PROVIDER_TIMEOUT,
    TwitterOAuthProviderDeadlineExceeded,
    TwitterOAuthClient,
    twitter_oauth1_provider_deadline,
)


APP_KEY = "sentinel-twitter-app-key"
APP_SECRET = "sentinel-twitter-app-secret"
CALLBACK_TOKEN = "sentinel-twitter-callback-token"
CALLBACK_VERIFIER = "sentinel-twitter-callback-verifier"
REQUEST_TOKEN_SECRET = "sentinel-twitter-request-token-secret"
ACCESS_TOKEN = "sentinel-twitter-access-token"
ACCESS_TOKEN_SECRET = "sentinel-twitter-access-token-secret"
PROVIDER_DETAIL = "sentinel-twitter-provider-response"
SENSITIVE_VALUES = (
    APP_KEY,
    APP_SECRET,
    CALLBACK_TOKEN,
    CALLBACK_VERIFIER,
    REQUEST_TOKEN_SECRET,
    ACCESS_TOKEN,
    ACCESS_TOKEN_SECRET,
    PROVIDER_DETAIL,
)


def _bind_handshake(client_or_cookies, state, code_verifier="verifier"):
    """What `/api/twitter/start` leaves in the browser: the signed handshake.

    Takes a test client or a bare cookie dict -- the cookie is the ONLY
    thing the callback consults for `state`, so binding it is the whole of
    "this browser started the flow".
    """
    cookies = getattr(client_or_cookies, "cookies", client_or_cookies)
    cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = sign_oauth2_handshake(
        state, code_verifier,
    )


def _request(state_in_query, state_in_cookie):
    request = RequestFactory().get("/api/twitter/callback", {"state": state_in_query})
    if state_in_cookie is not None:
        _bind_handshake(request.COOKIES, state_in_cookie)
    return request


def test_state_mismatch_is_rejected():
    request = _request(state_in_query="attacker", state_in_cookie="victim")
    assert is_valid_twitter_request(request) is False


def test_matching_state_is_accepted():
    request = _request(state_in_query="same-state", state_in_cookie="same-state")
    assert is_valid_twitter_request(request) is True


def test_a_state_with_no_handshake_cookie_is_rejected():
    """Login-CSRF on the callback: an attacker's own `/start` yields a real
    `state`, so a URL carrying it must still fail in a browser that did not
    begin the flow -- the one that holds no cookie. A legacy session value
    cannot stand in for the handshake cookie."""
    request = _request(state_in_query="attackers-own", state_in_cookie=None)
    request.session = {"state": "attackers-own", "code_verifier": "legacy"}
    assert is_valid_twitter_request(request) is False


def test_a_forged_handshake_cookie_is_rejected():
    request = _request(state_in_query="forged", state_in_cookie=None)
    request.COOKIES[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = (
        views.signing.dumps({"state": "forged", "code_verifier": "v"}, salt="other")
    )
    assert is_valid_twitter_request(request) is False


def test_an_expired_handshake_cookie_is_rejected(mocker):
    request = _request(state_in_query="stale", state_in_cookie=None)
    mocker.patch(
        "django.core.signing.time.time",
        return_value=time.time() - TWITTER_OAUTH2_HANDSHAKE_MAX_AGE - 1,
    )
    _bind_handshake(request.COOKIES, "stale")
    mocker.stopall()
    assert is_valid_twitter_request(request) is False


# --------------------------------------------------------------- /start


@pytest.mark.django_db
def test_start_mints_no_session_row_for_an_anonymous_hit(api_client):
    """`GET /api/twitter/start` used to write `state` and `code_verifier` to
    `request.session`, minting one unexpired `django_session` row per
    cookie-less GET on a route with no throttle -- the growth that made every
    ownership event's session sweep O(attacker's choice). The
    handshake now rides in a signed cookie and the database is not touched.
    """
    from django.conf import settings
    from django.contrib.sessions.models import Session

    response = api_client.get("/api/twitter/start")

    assert response.status_code == 200
    body = response.json()
    assert len(body["state"]) == 32
    # S256: base64url(sha256(verifier)) with the padding stripped.
    assert len(body["code_challenge"]) == 43
    assert body["code_challenge_method"] == "S256"
    assert Session.objects.count() == 0
    assert settings.SESSION_COOKIE_NAME not in response.cookies
    handshake = response.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE]
    assert handshake["httponly"]
    assert handshake["samesite"] == "Lax"
    assert handshake["path"] == "/api/twitter/"
    assert int(handshake["max-age"]) == TWITTER_OAUTH2_HANDSHAKE_MAX_AGE
    assert response["Cache-Control"] == "no-store"


@pytest.mark.django_db
def test_a_legacy_session_handshake_without_a_cookie_is_rejected(
    api_client, mocker,
):
    """A persisted pre-cookie handshake cannot authorize a callback.

    This was the temporary cross-Deployment rollout path. Once the cookie
    release has outlived the session age, the callback must reject it without
    contacting X or changing account/session state.
    """
    from django.contrib.auth import get_user_model
    from django.contrib.sessions.models import Session

    session = api_client.session
    session["state"] = "legacy-state"
    session["code_verifier"] = "legacy-verifier"
    session.save()
    session_key = session.session_key
    before_session = Session.objects.get(session_key=session_key)
    before_session_count = Session.objects.count()

    provider = mocker.Mock()
    get_client = mocker.patch(
        "dj.apps.twitter.views.get_client", return_value=provider,
    )
    before_profile_count = TwitterProfile.objects.count()
    User = get_user_model()
    before_user_count = User.objects.count()

    provider.get_me.return_value = {
        "id": "legacy-callback-user",
        "username": "legacycallbackuser",
        "name": "L",
        "description": "",
        "profile_image_url": "",
    }

    response = api_client.get(
        "/api/twitter/callback",
        {"state": "legacy-state", "code": CALLBACK_TOKEN},
    )

    assert response.status_code == 400
    assert response.content == b"Invalid request from Twitter"
    assert TWITTER_OAUTH2_HANDSHAKE_COOKIE not in api_client.cookies
    assert TWITTER_OAUTH2_HANDSHAKE_COOKIE not in response.cookies
    get_client.assert_not_called()
    provider.exchange_code_for_token.assert_not_called()
    provider.get_me.assert_not_called()
    assert not TwitterProfile.objects.filter(
        twitter_id="legacy-callback-user",
    ).exists()
    assert TwitterProfile.objects.count() == before_profile_count
    assert User.objects.count() == before_user_count
    assert Session.objects.count() == before_session_count
    after_session = Session.objects.get(session_key=session_key)
    assert after_session.session_data == before_session.session_data
    assert after_session.expire_date == before_session.expire_date


@pytest.mark.django_db
def test_the_callback_honours_the_handshake_start_issued(api_client, mocker, caplog):
    """End to end through the real routes: the state and verifier `/start`
    handed the browser are what `/callback` checks and exchanges."""
    # `views.get_client` reads TWITTER_CLIENT_ID/SECRET out of os.environ,
    # which CI does not set; patch the factory rather than the methods so the
    # constructor is never reached.
    client = mocker.Mock()
    client.get_me.return_value = {
        "id": "handshake-user",
        "username": "handshakeuser",
        "name": "H",
        "description": "",
        "profile_image_url": "",
    }
    mocker.patch("dj.apps.twitter.views.get_client", return_value=client)
    exchange = client.exchange_code_for_token
    started = api_client.get("/api/twitter/start").json()

    response = api_client.get(
        "/api/twitter/callback",
        {"state": started["state"], "code": CALLBACK_TOKEN},
    )

    assert response.status_code == 302, response.content
    exchange.assert_called_once()
    code, verifier = exchange.call_args.args
    assert code == CALLBACK_TOKEN
    # S256: the exchange replays the VERIFIER, which the browser was
    # never shown -- only its hash is in `/start`'s body and authorize URL.
    assert verifier != started["code_challenge"]
    assert pkce_challenge(verifier) == started["code_challenge"]
    # Spent: the cookie is cleared, so the same handshake cannot bind a
    # second callback.
    assert response.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE].value == ""
    assert TwitterProfile.objects.filter(twitter_id="handshake-user").exists()


@pytest.mark.django_db
def test_a_rejected_callback_does_not_cancel_a_live_handshake(
    api_client, mocker,
):
    """A refusal must not spend someone else's in-flight sign-in.

    Codex adversarial review. `/api/twitter/callback` is a top-level GET
    navigation, so anything can drive the browser to it: another tab, a stale
    bookmark, a link. If a rejected callback cleared the handshake cookie,
    that request would cancel a sign-in still out at X and the real return
    would come back to a 400, with a restart as the only recovery. The
    pre- code popped the session `state` only AFTER the provider
    identity was verified, and this keeps that.

    So: the handshake survives a wrong-state callback, and the genuine
    return still completes with the same handshake.
    """
    client = mocker.Mock()
    client.get_me.return_value = {
        "id": "unspent-user",
        "username": "unspentuser",
        "name": "U",
        "description": "",
        "profile_image_url": "",
    }
    mocker.patch("dj.apps.twitter.views.get_client", return_value=client)
    started = api_client.get("/api/twitter/start").json()

    rejected = api_client.get(
        "/api/twitter/callback",
        {"state": "not-the-state-this-browser-holds", "code": CALLBACK_TOKEN},
    )
    assert rejected.status_code == 400
    assert TWITTER_OAUTH2_HANDSHAKE_COOKIE not in rejected.cookies, (
        "a refused callback cancelled a live sign-in"
    )

    # The real return from X, with the handshake `/start` issued.
    completed = api_client.get(
        "/api/twitter/callback",
        {"state": started["state"], "code": CALLBACK_TOKEN},
    )

    assert completed.status_code == 302, completed.content
    assert completed.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE].value == ""
    assert TwitterProfile.objects.filter(twitter_id="unspent-user").exists()


@pytest.mark.django_db
def test_the_callback_refuses_a_state_this_browser_did_not_start(
    api_client, mocker,
):
    get_twitter_user = mocker.patch("dj.apps.twitter.views.get_twitter_user")
    other_browser = api_client.__class__()
    started = other_browser.get("/api/twitter/start").json()

    response = api_client.get(
        "/api/twitter/callback",
        {"state": started["state"], "code": CALLBACK_TOKEN},
    )

    assert response.status_code == 400
    get_twitter_user.assert_not_called()


@pytest.mark.django_db
@pytest.mark.parametrize("provider_handle", ["api", "TrEnDiNg"])
def test_new_twitter_account_does_not_claim_reserved_handle(
    provider_handle, mocker,
):
    profile = TwitterProfile.objects.create(
        twitter_id="reserved-handle-user",
        username=provider_handle,
    )
    login = mocker.patch("dj.apps.twitter.views.login")
    record_login = mocker.patch("dj.apps.twitter.views.record_login")
    request = mocker.Mock()

    TwitterCallbackView().handle_new_twitter_user({
        "id": profile.twitter_id,
        "username": provider_handle,
        "name": "Reserved Handle",
        "description": "",
        "profile_image_url": "",
    }, request)

    profile.refresh_from_db()
    assert profile.creator.username == provider_handle + "1"
    login.assert_called_once_with(request, profile.creator)
    record_login.assert_called_once_with(
        request, profile.creator, methods=["fed:twitter"],
    )


@pytest.mark.django_db
def test_colliding_twitter_handle_refuses_to_provision(mocker, creator_factory):
    """: an X handle matching an existing Creator must not duplicate.

    A matching handle proves nothing about ownership, so this must neither
    create a user (not even a suffixed lookalike), nor link the profile,
    nor log anyone in -- just explain the dead end.
    """
    from django.contrib.auth import get_user_model

    User = get_user_model()
    existing = creator_factory(username="Spartack73")
    profile = TwitterProfile.objects.create(
        twitter_id="collision-handle-user",
        username="spartack73",
    )
    login = mocker.patch("dj.apps.twitter.views.login")
    record_login = mocker.patch("dj.apps.twitter.views.record_login")
    request = RequestFactory().get("/api/twitter/callback")

    response = TwitterCallbackView().handle_new_twitter_user({
        "id": profile.twitter_id,
        "username": "spartack73",
        "name": "Lookalike",
        "description": "",
        "profile_image_url": "",
    }, request)

    assert response.status_code == 409
    assert b"already exists" in response.content
    assert User.objects.count() == 1
    assert User.objects.get(pk=existing.pk).username == "Spartack73"
    profile.refresh_from_db()
    assert profile.creator is None
    login.assert_not_called()
    record_login.assert_not_called()


@pytest.mark.django_db
def test_unique_twitter_handle_provisions_and_logs_in_as_before(mocker):
    """Positive control for the refusal above: same flow, free handle."""
    from django.contrib.auth import get_user_model

    User = get_user_model()
    profile = TwitterProfile.objects.create(
        twitter_id="fresh-handle-user",
        username="brandnewhandle",
    )
    login = mocker.patch("dj.apps.twitter.views.login")
    record_login = mocker.patch("dj.apps.twitter.views.record_login")
    request = mocker.Mock()

    TwitterCallbackView().handle_new_twitter_user({
        "id": profile.twitter_id,
        "username": "brandnewhandle",
        "name": "Brand New",
        "description": "",
        "profile_image_url": "",
    }, request)

    profile.refresh_from_db()
    assert profile.creator.username == "brandnewhandle"
    assert User.objects.filter(username__iexact="brandnewhandle").count() == 1
    login.assert_called_once_with(request, profile.creator)
    record_login.assert_called_once_with(
        request, profile.creator, methods=["fed:twitter"],
    )


@pytest.mark.django_db
def test_oauth2_callback_rejection_has_privacy_headers(api_client):
    _bind_handshake(api_client, "expected-state")

    response = api_client.get(
        "/api/twitter/callback",
        {"state": "wrong-state", "code": CALLBACK_TOKEN},
    )

    assert response.status_code == 400
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    assert uuid.UUID(hex=response["X-Correlation-ID"]).hex == response[
        "X-Correlation-ID"
    ]


@pytest.mark.django_db
def test_oauth2_callback_exception_never_logs_credentials(
    api_client, mocker, caplog, capsys,
):
    _bind_handshake(api_client, "expected-state")
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        side_effect=RuntimeError(" | ".join(SENSITIVE_VALUES)),
    )

    with caplog.at_level(logging.INFO, logger=views.__name__):
        response = api_client.get(
            "/api/twitter/callback",
            {"state": "expected-state", "code": CALLBACK_TOKEN},
        )

    assert response.status_code == 502
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    _assert_no_sensitive_output(caplog, capsys, response)
    correlation_id = _assert_events(
        caplog,
        (views.TWITTER_OAUTH2_CALLBACK_FAILED, "application"),
    )
    assert caplog.records[-1].levelno == logging.ERROR
    assert response["X-Correlation-ID"] == correlation_id


def _callback(api_client):
    session = api_client.session
    session["oauth_token_secret"] = REQUEST_TOKEN_SECRET
    session.save()
    return api_client.get(
        "/api/twitter/v1/access-token",
        {"oauth_token": CALLBACK_TOKEN, "oauth_verifier": CALLBACK_VERIFIER},
    )


def _assert_no_sensitive_output(caplog, capsys, response=None):
    captured = capsys.readouterr()
    output = caplog.text + captured.out + captured.err
    if response is not None:
        output += response.content.decode()
    for value in SENSITIVE_VALUES:
        assert value not in output


def _assert_events(caplog, *expected):
    payloads = [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == views.__name__ and record.getMessage().startswith("{")
    ]
    actual = []
    correlation_ids = []
    for payload in payloads:
        expected_keys = {"event", "correlation_id"}
        if "failure_stage" in payload:
            expected_keys.add("failure_stage")
        assert set(payload) == expected_keys
        correlation_id = payload["correlation_id"]
        assert uuid.UUID(hex=correlation_id).hex == correlation_id
        correlation_ids.append(correlation_id)
        actual.append((payload["event"], payload.get("failure_stage")))
    normalized_expected = [
        item if isinstance(item, tuple) else (item, None)
        for item in expected
    ]
    assert actual == normalized_expected
    assert len(set(correlation_ids)) == 1
    return correlation_ids[0]


@pytest.mark.django_db
def test_oauth1_callback_success_never_logs_or_prints_credentials(
    api_client, mocker, monkeypatch, caplog, capsys,
):
    monkeypatch.setenv("TWITTER_API_KEY", APP_KEY)
    monkeypatch.setenv("TWITTER_API_KEY_SECRET", APP_SECRET)
    exchange = mocker.Mock()
    exchange.fetch_access_token.return_value = {
        "oauth_token": ACCESS_TOKEN,
        "oauth_token_secret": ACCESS_TOKEN_SECRET,
    }
    account = mocker.Mock()
    account.get.return_value.status_code = 200
    oauth_session = mocker.patch(
        "dj.apps.twitter.views.OAuth1Session",
        side_effect=[exchange, account],
    )

    with caplog.at_level(logging.INFO, logger=views.__name__):
        response = _callback(api_client)

    assert response.status_code == 302
    assert response["Location"] == "/profile"
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    _assert_no_sensitive_output(caplog, capsys, response)
    correlation_id = _assert_events(
        caplog, views.TWITTER_OAUTH1_CALLBACK_RECEIVED,
    )
    assert response["X-Correlation-ID"] == correlation_id
    assert oauth_session.call_args_list[0].args == (APP_KEY,)
    assert oauth_session.call_args_list[0].kwargs == {
        "client_secret": APP_SECRET,
        "resource_owner_key": CALLBACK_TOKEN,
        "resource_owner_secret": REQUEST_TOKEN_SECRET,
        "verifier": CALLBACK_VERIFIER,
    }
    exchange.fetch_access_token.assert_called_once_with(
        "https://api.twitter.com/oauth/access_token",
        timeout=TWITTER_OAUTH1_PROVIDER_TIMEOUT,
    )
    account.get.assert_called_once_with(
        "https://api.twitter.com/1.1/account/verify_credentials.json",
        timeout=TWITTER_OAUTH1_PROVIDER_TIMEOUT,
    )


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("failure_at", "failure_stage"),
    [
        ("exchange", "token_exchange"),
        ("account", "account_lookup"),
        ("status", "account_status"),
    ],
)
def test_oauth1_callback_failures_are_bounded_and_never_log_credentials(
    api_client, mocker, monkeypatch, caplog, capsys, failure_at, failure_stage,
):
    monkeypatch.setenv("TWITTER_API_KEY", APP_KEY)
    monkeypatch.setenv("TWITTER_API_KEY_SECRET", APP_SECRET)
    secret_exception = RuntimeError(" | ".join(SENSITIVE_VALUES))
    exchange = mocker.Mock()
    exchange.fetch_access_token.return_value = {
        "oauth_token": ACCESS_TOKEN,
        "oauth_token_secret": ACCESS_TOKEN_SECRET,
    }
    account = mocker.Mock()
    account.get.return_value.status_code = 401 if failure_at == "status" else 200
    if failure_at == "exchange":
        exchange.fetch_access_token.side_effect = secret_exception
    if failure_at == "account":
        account.get.side_effect = secret_exception
    mocker.patch(
        "dj.apps.twitter.views.OAuth1Session",
        side_effect=[exchange, account],
    )

    with caplog.at_level(logging.INFO, logger=views.__name__):
        response = _callback(api_client)

    assert response.status_code == 502
    assert response.json() == {"detail": views.TWITTER_OAUTH1_FAILURE_DETAIL}
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    _assert_no_sensitive_output(caplog, capsys, response)
    correlation_id = _assert_events(
        caplog,
        views.TWITTER_OAUTH1_CALLBACK_RECEIVED,
        (views.TWITTER_OAUTH1_CALLBACK_FAILED, failure_stage),
    )
    assert caplog.records[-1].levelno == logging.ERROR
    assert response["X-Correlation-ID"] == correlation_id


@pytest.mark.django_db
def test_oauth1_pre_handler_failure_still_gets_privacy_headers(
    api_client, mocker,
):
    mocker.patch.object(
        views.TwitterCallback1View,
        "check_throttles",
        side_effect=Throttled(wait=60),
    )

    response = api_client.get(
        "/api/twitter/v1/access-token",
        {"oauth_token": CALLBACK_TOKEN, "oauth_verifier": CALLBACK_VERIFIER},
    )

    assert response.status_code == 429
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    assert uuid.UUID(hex=response["X-Correlation-ID"]).hex == response[
        "X-Correlation-ID"
    ]


def test_request_token_client_never_prints_credentials_and_uses_timeout(
    mocker, caplog, capsys,
):
    oauth_session = mocker.Mock()
    oauth_session.fetch_request_token.return_value = {
        "oauth_token": CALLBACK_TOKEN,
        "oauth_token_secret": REQUEST_TOKEN_SECRET,
    }
    mocker.patch("twatter.v1.client.OAuth1Session", return_value=oauth_session)

    response = TwitterOAuthClient(APP_KEY, APP_SECRET).get_request_token(
        "https://free2z.cash/api/twitter/v1/access-token",
    )

    assert response["oauth_token"] == CALLBACK_TOKEN
    oauth_session.fetch_request_token.assert_called_once_with(
        "https://api.twitter.com/oauth/request_token",
        timeout=TWITTER_OAUTH1_PROVIDER_TIMEOUT,
    )
    _assert_no_sensitive_output(caplog, capsys)


def test_provider_deadline_bounds_wall_clock_and_restores_signal_handler():
    previous_handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()

    with pytest.raises(TwitterOAuthProviderDeadlineExceeded):
        with twitter_oauth1_provider_deadline(seconds=0.02):
            time.sleep(0.5)

    assert time.monotonic() - started < 0.25
    assert signal.getsignal(signal.SIGALRM) == previous_handler
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0


@pytest.mark.django_db
def test_request_token_failure_is_bounded_and_never_logs_credentials(
    api_client, mocker, monkeypatch, caplog, capsys,
):
    monkeypatch.setenv("TWITTER_API_KEY", APP_KEY)
    monkeypatch.setenv("TWITTER_API_KEY_SECRET", APP_SECRET)
    client = mocker.patch("dj.apps.twitter.views.TwitterOAuthClient")
    client.return_value.get_request_token.side_effect = RuntimeError(
        " | ".join(SENSITIVE_VALUES),
    )

    with caplog.at_level(logging.INFO, logger=views.__name__):
        response = api_client.post(
            "/api/twitter/v1/request-token", {}, format="json",
        )

    assert response.status_code == 502
    assert response.json() == {"detail": views.TWITTER_OAUTH1_FAILURE_DETAIL}
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    _assert_no_sensitive_output(caplog, capsys, response)
    correlation_id = _assert_events(
        caplog,
        (views.TWITTER_OAUTH1_REQUEST_TOKEN_FAILED, "provider_request"),
    )
    assert caplog.records[-1].levelno == logging.ERROR
    assert response["X-Correlation-ID"] == correlation_id


@pytest.mark.django_db
def test_request_token_configuration_failure_has_safe_diagnostic_stage(
    api_client, monkeypatch, caplog, capsys,
):
    monkeypatch.delenv("TWITTER_API_KEY", raising=False)
    monkeypatch.delenv("TWITTER_API_KEY_SECRET", raising=False)

    with caplog.at_level(logging.INFO, logger=views.__name__):
        response = api_client.post(
            "/api/twitter/v1/request-token", {}, format="json",
        )

    assert response.status_code == 502
    _assert_no_sensitive_output(caplog, capsys, response)
    correlation_id = _assert_events(
        caplog,
        (views.TWITTER_OAUTH1_REQUEST_TOKEN_FAILED, "configuration"),
    )
    assert caplog.records[-1].levelno == logging.ERROR
    assert response["X-Correlation-ID"] == correlation_id


def test_oauth2_provider_calls_have_wall_clock_deadlines(mocker, monkeypatch):
    monkeypatch.setenv("TWITTER_CLIENT_ID", APP_KEY)
    monkeypatch.setenv("TWITTER_CLIENT_SECRET", APP_SECRET)
    deadline = mocker.patch("twatter.v2.client.twitter_provider_deadline")
    post = mocker.patch("twatter.v2.client.requests.post")
    get = mocker.patch("twatter.v2.client.requests.get")
    post.return_value.status_code = 200
    post.return_value.text = json.dumps({"access_token": ACCESS_TOKEN})
    get.return_value.status_code = 200
    get.return_value.json.return_value = {"data": {"id": "1"}}

    client = views.get_client("https://free2z.cash/api/twitter/callback")
    client.exchange_code_for_token(CALLBACK_TOKEN, CALLBACK_VERIFIER)
    assert client.get_me() == {"id": "1"}

    assert deadline.call_count == 2


@pytest.mark.django_db
def test_refusal_leaves_no_orphan_row_so_replays_stay_explained(
    mocker, creator_factory,
):
    """The refusal must fire before the profile row exists ( review).

    A refusal that persisted the TwitterProfile would be explained exactly
    once: every later anonymous attempt would take the `not created` branch
    and silently redirect, and the identity could never be linked by its
    real owner either. So after a refusal there must be NO row -- the next
    attempt is refused again, with the same explanation.
    """
    creator_factory(username="Spartack73")
    request = RequestFactory().get("/api/twitter/callback")
    view = TwitterCallbackView()

    first = view.handle_new_twitter_user({
        "id": "replay-user",
        "username": "spartack73",
        "name": "Lookalike",
        "description": "",
        "profile_image_url": "",
    }, request)
    assert first.status_code == 409

    # The callback-level pre-check refuses before get_or_create runs.
    mocker.patch(
        "dj.apps.twitter.views.get_twitter_user",
        return_value={
            "id": "replay-user",
            "username": "spartack73",
            "name": "Lookalike",
            "description": "",
            "profile_image_url": "",
        },
    )
    request = RequestFactory().get("/api/twitter/callback?state=same")
    _bind_handshake(request.COOKIES, "same")
    request.session = SessionStore()
    request.user = AnonymousUser()

    second = view.get(request)
    assert second.status_code == 409
    assert b"already exists" in second.content
    assert not TwitterProfile.objects.filter(twitter_id="replay-user").exists()
