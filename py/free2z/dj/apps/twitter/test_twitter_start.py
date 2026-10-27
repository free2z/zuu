"""`/api/twitter/start` hands the browser a COMPLETE authorize URL.

The regression these tests exist for: the endpoint used to return only
`{state, code_challenge}` and leave the browser to assemble the X consent URL
from `import.meta.env.VITE_TWITTER_CLIENT_ID` -- a build-time Vite variable set
in no Dockerfile, no Cloud Build substitution and no k8s manifest. It was
`undefined` in every image ever shipped, so 100% of new-UI users got
"Sign-in with X is not configured" while this endpoint answered 200 to every
click, for two months. 137 accounts have an unusable password and can sign in
no other way.

Nothing could have caught that from the server side, because the server was
not the one deciding. Now it is, and these tests are what hold it there.
"""
import json
from urllib.parse import parse_qs, urlsplit

import base64
import hashlib

import pytest
from django.test import RequestFactory

from dj.apps.twitter import views
from dj.apps.twitter.views import (
    TWITTER_OAUTH2_AUTHORIZE_ENDPOINT,
    TWITTER_OAUTH2_HANDSHAKE_COOKIE,
    TWITTER_OAUTH2_SCOPE,
    AuthorizeView,
    TwitterCallbackView,
    sign_oauth2_handshake,
    twitter_oauth2_callback_url,
)


#Not the real credential: a sentinel that could only reach the response by
#coming out of settings.
CLIENT_ID = "sentinel-x-oauth2-client-id"
PROD_ORIGIN = "https://free2z.cash"


def _start(settings, client_id=CLIENT_ID, canonical=PROD_ORIGIN, debug=False,
           host="free2z.cash"):
    settings.DEBUG = debug
    settings.TWITTER_CLIENT_ID = client_id
    settings.CANONICAL_ORIGIN = canonical
    request = RequestFactory().get("/api/twitter/start", HTTP_HOST=host)
    return AuthorizeView.as_view()(request)


def _authorize_params(response):
    body = json.loads(response.content)
    split = urlsplit(body["authorize_url"])
    return body, split, parse_qs(split.query)


def test_start_returns_a_complete_absolute_authorize_url(settings):
    response = _start(settings)

    assert response.status_code == 200
    body, split, params = _authorize_params(response)

    # Absolute, on X, and exactly the endpoint the flow has always used.
    assert body["authorize_url"].startswith(
        TWITTER_OAUTH2_AUTHORIZE_ENDPOINT + "?"
    )
    assert split.scheme == "https"
    assert split.netloc == "twitter.com"

    # Every parameter X needs, none of them left to the browser.
    assert params["response_type"] == ["code"]
    assert params["client_id"] == [CLIENT_ID]
    assert params["scope"] == [TWITTER_OAUTH2_SCOPE]
    assert params["intent"] == ["authenticate"]


def test_start_emits_only_a_low_cardinality_conversion_signal(settings, caplog):
    response = _start(settings)

    assert response.status_code == 200
    assert "twitter_oauth2_start_ready" in caplog.text
    assert CLIENT_ID not in caplog.text
    assert json.loads(response.content)["state"] not in caplog.text


def test_client_id_comes_from_settings_not_from_a_literal(settings):
    """The whole point: one source, the same one the callback spends."""
    response = _start(settings, client_id="a-completely-different-id")

    _, _, params = _authorize_params(response)
    assert params["client_id"] == ["a-completely-different-id"]


def test_redirect_uri_is_the_production_callback_registered_with_x(settings):
    """The URI X has on file. A mismatch fails at X with an opaque error.

    `https://free2z.cash/api/twitter/callback` is what the classic React
    client (`ts/react/free2z/src/components/TwitterLoginButton.tsx`) has always
    sent and therefore what is registered. Deriving it from `CANONICAL_ORIGIN`
    has to reproduce it byte for byte.
    """
    response = _start(settings)

    _, _, params = _authorize_params(response)
    assert params["redirect_uri"] == [
        "https://free2z.cash/api/twitter/callback"
    ]


def test_redirect_uri_follows_the_namespace_not_the_request_host(settings):
    """Stage builds stage's URI even when the request arrives elsewhere."""
    response = _start(
        settings,
        canonical="https://stage.free2z.cash",
        host="some-internal-host.cluster.local",
    )

    _, _, params = _authorize_params(response)
    assert params["redirect_uri"] == [
        "https://stage.free2z.cash/api/twitter/callback"
    ]


def test_a_trailing_slash_on_canonical_origin_does_not_double(settings):
    response = _start(settings, canonical="https://free2z.cash/")

    _, _, params = _authorize_params(response)
    assert params["redirect_uri"] == [
        "https://free2z.cash/api/twitter/callback"
    ]


def test_debug_pins_the_callback_to_the_local_backend(settings):
    """Mirrors `get_twitter_user`'s DEBUG branch exactly, or local dev dies."""
    response = _start(settings, debug=True, host="localhost:5173")

    _, _, params = _authorize_params(response)
    assert params["redirect_uri"] == [
        "http://127.0.0.1:8000/api/twitter/callback"
    ]


class _RecordingClient:
    """Stands in for `twatter.v2.client.TwitterClient`; records the replay."""

    def __init__(self, seen):
        self.seen = seen

    def exchange_code_for_token(self, code, verifier):
        self.seen["code"] = code
        self.seen["verifier"] = verifier

    def get_me(self):
        # Falsy: the view stops with "Unable to retrieve Twitter user"
        # before it touches the database, which is all these tests need.
        return None


def _handshake_of(started):
    """`(state, cookie value)` exactly as `/start` handed them to the browser."""
    return (
        json.loads(started.content)["state"],
        started.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE].value,
    )


def _callback(settings, mocker, handshake, host, **extra):
    """Return from X to `/api/twitter/callback` carrying `handshake`."""
    state, cookie_value = handshake
    seen = {}

    def _fake_get_client(callback_url):
        seen["callback_url"] = callback_url
        return _RecordingClient(seen)

    mocker.patch.object(views, "get_client", _fake_get_client)
    settings.ALLOWED_HOSTS = ["*"]
    request = RequestFactory().get(
        "/api/twitter/callback",
        {"state": state, "code": "irrelevant"},
        HTTP_HOST=host,
        secure=True,
        **extra,
    )
    request.COOKIES[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = cookie_value
    request.session = {}
    return TwitterCallbackView.as_view()(request), seen


def test_authorize_redirect_uri_matches_what_the_token_exchange_replays(
    settings, mocker,
):
    """The drift guard.

    X compares the `redirect_uri` on the authorize request with the one
    replayed at the token exchange byte for byte. Both halves now come from
    `twitter_oauth2_callback_url()`  -- this test is what fails if
    either half is changed alone.
    """
    started = _start(settings)
    _, _, params = _authorize_params(started)

    _, seen = _callback(
        settings, mocker, _handshake_of(started), host="free2z.cash",
    )

    assert seen["callback_url"] == params["redirect_uri"][0]


def test_the_token_exchange_ignores_a_forged_forwarded_host(settings, mocker):
    """: the exchange used to replay `request.build_absolute_uri(...)`.

    `/api/twitter/callback` is routed by the GCLB straight to Django, past
    the nginx that rewrites `Host`, and prod sets `USE_X_FORWARDED_HOST`, so
    a client-supplied `X-Forwarded-Host` chose the `redirect_uri` replayed to
    X. It is configuration now, like the authorize half.
    """
    settings.USE_X_FORWARDED_HOST = True
    started = _start(settings)
    _, _, params = _authorize_params(started)

    _, seen = _callback(
        settings, mocker, _handshake_of(started), host="free2z.cash",
        HTTP_X_FORWARDED_HOST="evil.example",
    )

    assert seen["callback_url"] == params["redirect_uri"][0]
    assert "evil.example" not in seen["callback_url"]


def _s256(verifier):
    """RFC 7636 S256, written out here rather than imported from the view."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def test_state_and_code_challenge_are_still_returned_for_old_clients(settings):
    """The classic React client reads these and builds its own URL."""
    response = _start(settings)

    body, _, params = _authorize_params(response)
    assert isinstance(body["state"], str) and body["state"]
    assert isinstance(body["code_challenge"], str) and body["code_challenge"]
    # And the URL carries the same pair, with the method named in both.
    assert params["state"] == [body["state"]]
    assert params["code_challenge"] == [body["code_challenge"]]
    assert params["code_challenge_method"] == ["S256"]
    assert body["code_challenge_method"] == "S256"


def test_pkce_is_s256_and_the_verifier_never_reaches_the_browser(settings):
    """: under `plain` the challenge WAS the verifier.

    So the verifier sat in the authorize URL and leaked through `Referer` to
    x.com, history and history sync. Under S256 only its hash is public; the
    verifier lives in the signed HttpOnly cookie and the token exchange.
    """
    response = _start(settings)

    body, _, params = _authorize_params(response)
    verifier = views.read_oauth2_handshake(
        _request_carrying(
            response.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE].value
        )
    )["code_verifier"]

    assert 43 <= len(verifier) <= 128  # RFC 7636 section 4.1
    assert params["code_challenge"] == [_s256(verifier)]
    assert verifier not in body["authorize_url"]
    assert verifier not in response.content.decode()


def test_a_plain_handshake_minted_before_the_deploy_still_completes(
    settings, mocker,
):
    """In flight across the  deploy: no lockout, no lockstep.

    A browser that hit the OLD `/start` holds a cookie whose verifier X
    recorded under `plain`; the cookie format did not change, so the callback
    must replay that verifier unchanged and let X check it against the method
    X recorded. (The same holds in the other direction -- an S256 handshake
    reaching a not-yet-rolled callback pod -- because the old callback did
    the identical replay.)
    """
    settings.DEBUG = False
    settings.CANONICAL_ORIGIN = PROD_ORIGIN
    settings.TWITTER_CLIENT_ID = CLIENT_ID
    old_verifier = "x" * 64

    # Byte-for-byte what the pre- `/start` set: same salt, same shape.
    pre_deploy = ("old-state", sign_oauth2_handshake("old-state", old_verifier))

    _, seen = _callback(settings, mocker, pre_deploy, host="free2z.cash")

    assert seen["verifier"] == old_verifier
    assert seen["callback_url"] == PROD_ORIGIN + "/api/twitter/callback"


def test_the_handshake_cookie_is_still_set_and_binds_the_same_values(settings):
    """/ posture unchanged: the cookie is the browser binding."""
    response = _start(settings)

    body = json.loads(response.content)
    cookie = response.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE]
    assert cookie.value
    assert cookie["httponly"]
    assert cookie["samesite"] == "Lax"
    assert cookie["path"] == "/api/twitter/"

    unsigned = views.read_oauth2_handshake(
        _request_carrying(cookie.value)
    )
    assert unsigned["state"] == body["state"]
    assert _s256(unsigned["code_verifier"]) == body["code_challenge"]
    assert response["Cache-Control"] == "no-store"


def _request_carrying(cookie_value):
    request = RequestFactory().get("/api/twitter/callback")
    request.COOKIES[TWITTER_OAUTH2_HANDSHAKE_COOKIE] = cookie_value
    return request


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_unconfigured_is_a_503_never_a_500_and_never_an_authorize_url(
    settings, blank,
):
    """The "not configured" posture of `dj/apps/social/clients.py`.

    A blank client id must not produce a URL with `client_id=` empty -- that
    reaches X and fails there, which is how you get a two-month outage nobody
    can attribute.
    """
    response = _start(settings, client_id=blank)

    assert response.status_code == 503
    body = json.loads(response.content)
    assert "authorize_url" not in body
    assert "not configured" in body["detail"].lower()
    assert response["Cache-Control"] == "no-store"
    # No handshake is minted for a flow that cannot start.
    assert TWITTER_OAUTH2_HANDSHAKE_COOKIE not in response.cookies


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_no_canonical_origin_is_not_configured_never_the_request_host(
    settings, blank,
):
    """: the request-derived fallback is gone, on purpose.

    It returned `request.build_absolute_uri(...)` -- Host-derived and
    scheme-downgraded to http -- which is the  shape
    `dj.apps.emails.link_origin` refuses by doctrine. It was unreachable in
    prod only because a different app's system check (`emails.E001`) fails
    deploys on a blank value. Now it is the 503 the other missing-config case
    already gives, and no handshake is minted.
    """
    settings.ALLOWED_HOSTS = ["example.org"]
    response = _start(settings, canonical=blank, host="example.org")

    assert twitter_oauth2_callback_url() is None
    assert response.status_code == 503
    body = json.loads(response.content)
    assert "authorize_url" not in body
    assert "example.org" not in response.content.decode()
    assert TWITTER_OAUTH2_HANDSHAKE_COOKIE not in response.cookies


def test_a_callback_without_canonical_origin_is_a_503_and_spends_nothing(
    settings, mocker,
):
    """The exchange half refuses too, rather than replaying the Host."""
    started = _start(settings)
    settings.CANONICAL_ORIGIN = ""

    response, seen = _callback(
        settings, mocker, _handshake_of(started), host="example.org",
    )

    assert response.status_code == 503
    assert "callback_url" not in seen  # never reached the provider
    # The handshake is left alone: config restored, a retry still works.
    assert TWITTER_OAUTH2_HANDSHAKE_COOKIE not in response.cookies
