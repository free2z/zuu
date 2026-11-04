"""Sign in with X returns to the SDK-facing page that asked for it.

Before this, every X sign-in landed on `/profile`. On the pages an SDK app
opens (consent, the Manage page, account deletion) that meant an X-only
account -- 137 of them, with no password and often no email -- could not
finish signing in to approve an app, remove its access or delete the account,
and `/profile` (the dashboard) left a commerce-free flow for Credits. So those
pages hid X. Now `/api/twitter/start?next=` carries one of exactly those pages
through the signed handshake, and the callback lands there.

The return path rides an OAuth round trip through x.com, which makes it the
redirect most worth hijacking: everything that is not exactly one of those
pages on this origin is dropped, and the sign-in lands on `/profile` as before.
"""
import pytest
from django.core import signing

from dj.apps.twitter.views import (
    TWITTER_OAUTH2_HANDSHAKE_COOKIE,
    TWITTER_OAUTH2_HANDSHAKE_SALT,
    handshake_return_path,
    safe_x_return_path,
)

AUTHORIZE = "/oauth/authorize?client_id=aha&redirect_uri=x%3A%2F%2Fcb&state=s"

CLIENT_ID = "test-x-client-id"
PROD_ORIGIN = "https://free2z.cash"


@pytest.fixture
def x_configured(settings):
    settings.TWITTER_CLIENT_ID = CLIENT_ID
    settings.CANONICAL_ORIGIN = PROD_ORIGIN
    settings.DEBUG = False


@pytest.mark.parametrize(
    "value",
    [
        AUTHORIZE,
        "/oauth/authorize/",
        "/account/apps?client_id=aha",
        "/account/apps/?client_id=",
        "/account/delete",
    ],
)
def test_sdk_facing_pages_are_accepted(value):
    assert safe_x_return_path(value) == value


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "https://evil.example/oauth/authorize",
        "//evil.example/oauth/authorize",
        "/\\evil.example/oauth/authorize",
        "/oauth/authorize\\..",
        "/%2F%2Fevil.example/oauth/authorize",
        "/oauth%2Fauthorize",
        "/oauth/authorize/../../profile",
        "/account/appsx",
        "/account/apps/extra",
        "/fixtureowner/dashboard/billing",
        "/buy-2z",
        "/profile",
        "/oauth/authorize\n",
        "/oauth/authorize?x= y",
        "/account/apps#frag",
        "/" + "a" * 3000,
        "/oauth/authorize?state=" + "é" * 500,
        '/oauth/authorize?state="',
        "/oauth/authorize?state=<script>",
        "/oauth/authorize?state=a\\b",
        ["/oauth/authorize"],
    ],
)
def test_anything_else_is_refused(value):
    assert safe_x_return_path(value) is None


def test_a_handshake_without_next_returns_to_profile_as_before():
    assert handshake_return_path({"state": "s"}) == "/profile"
    assert handshake_return_path(None) == "/profile"
    # Re-validated on the way out: a signed payload never widens the list.
    assert handshake_return_path({"state": "s", "next": "/buy-2z"}) == "/profile"


def _cookie_payload(response):
    raw = response.cookies[TWITTER_OAUTH2_HANDSHAKE_COOKIE].value
    return signing.loads(raw, salt=TWITTER_OAUTH2_HANDSHAKE_SALT)


@pytest.mark.django_db
def test_start_signs_an_allowed_next_into_the_handshake(api_client, x_configured):
    response = api_client.get("/api/twitter/start", {"next": AUTHORIZE})
    assert response.status_code == 200
    assert _cookie_payload(response)["next"] == AUTHORIZE


def test_the_longest_accepted_next_still_fits_in_a_browser_cookie():
    from dj.apps.twitter.views import X_RETURN_MAX_LENGTH, sign_oauth2_handshake

    # Every allowed character, at the maximum length: the worst case for
    # JSON + base64 expansion now that nothing allowed is JSON-escaped.
    from dj.apps.twitter.views import _URL_CHARACTERS

    for ch in sorted(_URL_CHARACTERS):
        longest = "/oauth/authorize?" + ch * (X_RETURN_MAX_LENGTH - 17)
        assert len(longest) == X_RETURN_MAX_LENGTH
        if safe_x_return_path(longest) is None:
            continue  # e.g. a `#` that would make the path end early
        cookie = sign_oauth2_handshake("s" * 32, "v" * 64, longest)
        assert len(f"{TWITTER_OAUTH2_HANDSHAKE_COOKIE}={cookie}") < 4096, ch


@pytest.mark.django_db
@pytest.mark.parametrize(
    "value",
    ["//evil.example/oauth/authorize", "/buy-2z", "/oauth/authorize?s=" + "x" * 3000],
)
def test_start_refuses_a_next_it_will_not_return_to(api_client, x_configured, value):
    """Visibly: a silently dropped `next` would sign the visitor in and land
    them on /profile, out of the app's flow."""
    response = api_client.get("/api/twitter/start", {"next": value})
    assert response.status_code == 400
    assert TWITTER_OAUTH2_HANDSHAKE_COOKIE not in response.cookies


@pytest.mark.django_db
def test_a_cancelled_x_sign_in_offers_the_way_back_to_the_sdk_page(
    api_client, x_configured
):
    started = api_client.get("/api/twitter/start", {"next": AUTHORIZE})
    assert started.status_code == 200
    response = api_client.get(
        "/api/twitter/callback",
        {"error": "access_denied", "state": started.json()["state"]},
    )
    assert response.status_code == 400
    assert b"/profile" not in response.content
    assert b"/oauth/authorize?client_id=aha" in response.content


def _x_user(mocker, twitter_id):
    client = mocker.Mock()
    client.get_me.return_value = {
        "id": twitter_id,
        "username": twitter_id.replace("-", ""),
        "name": "X",
        "description": "",
        "profile_image_url": "",
    }
    mocker.patch("dj.apps.twitter.views.get_client", return_value=client)


@pytest.mark.django_db
def test_an_x_sign_in_started_from_an_sdk_page_lands_back_on_it(
    api_client, mocker, x_configured
):
    _x_user(mocker, "sdk-return-user")
    started = api_client.get("/api/twitter/start", {"next": AUTHORIZE}).json()
    response = api_client.get(
        "/api/twitter/callback", {"state": started["state"], "code": "c"}
    )
    assert response.status_code == 302, response.content
    assert response["Location"] == AUTHORIZE


@pytest.mark.django_db
def test_an_x_sign_in_without_next_still_lands_on_profile(
    api_client, mocker, x_configured
):
    _x_user(mocker, "plain-return-user")
    started = api_client.get("/api/twitter/start").json()
    response = api_client.get(
        "/api/twitter/callback", {"state": started["state"], "code": "c"}
    )
    assert response.status_code == 302, response.content
    assert response["Location"] == "/profile"


@pytest.mark.django_db
def test_an_x_only_account_can_reach_deletion_with_a_fresh_sign_in(
    api_client, mocker, x_configured
):
    """The deletion contract (sign-out first): the deletion page signs
    the visitor out and sends them to `/login?next=/account/delete`; an X-only
    account signs in with X from there. The callback must land on the
    deletion page AND leave a fresh authentication behind, because deleting
    requires a sign-in within the last five minutes (`require_recent_auth`).
    `/api/auth/recent/` answers 200 only when that holds."""
    _x_user(mocker, "x-only-deleter")
    started = api_client.get(
        "/api/twitter/start", {"next": "/account/delete"}
    ).json()
    response = api_client.get(
        "/api/twitter/callback", {"state": started["state"], "code": "c"}
    )
    assert response.status_code == 302, response.content
    assert response["Location"] == "/account/delete"
    recent = api_client.get("/api/auth/recent/")
    assert recent.status_code == 200, recent.content
    assert recent.json()["username"] == "xonlydeleter"


@pytest.mark.django_db
def test_an_existing_x_only_account_reaches_deletion_with_a_fresh_sign_in(
    api_client, mocker, x_configured, creator_factory
):
    """The 137-account case: an EXISTING account whose only sign-in is X
    (no usable password) signs in from the deletion page's /login and lands
    back on it, freshly authenticated."""
    user = creator_factory(username="xonlyexisting")
    user.set_unusable_password()
    user.save(update_fields=["password"])
    from dj.apps.twitter.models import TwitterProfile

    TwitterProfile.objects.create(
        creator=user, twitter_id="x-only-existing", username="xonlyexisting",
        allow_login=True,
    )
    _x_user(mocker, "x-only-existing")
    started = api_client.get(
        "/api/twitter/start", {"next": "/account/delete"}
    ).json()
    response = api_client.get(
        "/api/twitter/callback", {"state": started["state"], "code": "c"}
    )
    assert response.status_code == 302, response.content
    assert response["Location"] == "/account/delete"
    recent = api_client.get("/api/auth/recent/")
    assert recent.status_code == 200, recent.content
    assert recent.json()["username"] == "xonlyexisting"
