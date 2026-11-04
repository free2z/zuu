"""An X-only account can use the exits an SDK app offers ( follow-up).

The 137 accounts whose only sign-in is X have no password and often no
email. From an app they reach Free2Z through "Manage Free2Z account"
(`/account/apps?client_id=`) and the deletion link (`/account/delete`); both
send a signed-out visitor to `/login?next=<that page>`, where "Sign in with X"
carries the page through the X round trip (`safe_x_return_path`). These
tests drive that round trip end to end for an EXISTING X-only account and
then do the thing the exit is for: revoke the app's access, or reach
deletion freshly authenticated (deletion requires a sign-in within five
minutes; `/api/auth/recent/` answers 200 only when that holds).
"""
from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from dj.apps.oidc.models import AppAuthorization
from dj.apps.twitter.models import TwitterProfile

from .conftest import WEB_REDIRECT, Flow

X_ID = "x-only-exits"
USERNAME = "xonlyexits"


@pytest.fixture
def x_configured(settings):
    settings.TWITTER_CLIENT_ID = "test-x-client-id"
    settings.CANONICAL_ORIGIN = "https://free2z.cash"
    settings.DEBUG = False


@pytest.fixture
def x_only(creator_factory):
    user = creator_factory(username=USERNAME)
    user.set_unusable_password()
    user.save(update_fields=["password"])
    TwitterProfile.objects.create(
        creator=user, twitter_id=X_ID, username=USERNAME, allow_login=True,
    )
    return user


@pytest.fixture
def x_provider(mocker):
    client = mocker.Mock()
    client.get_me.return_value = {
        "id": X_ID, "username": USERNAME, "name": "X only",
        "description": "", "profile_image_url": "",
    }
    mocker.patch("dj.apps.twitter.views.get_client", return_value=client)


def sign_in_with_x(client: APIClient, next_path: str):
    started = client.get("/api/twitter/start", {"next": next_path})
    assert started.status_code == 200, started.content
    landed = client.get(
        "/api/twitter/callback", {"state": started.json()["state"], "code": "c"}
    )
    assert landed.status_code == 302, landed.content
    return landed["Location"]


@pytest.mark.django_db
def test_an_x_only_account_revokes_an_app_from_the_manage_exit(
    x_only, x_provider, x_configured, web_app
):
    # The app was connected earlier, in another session.
    seed = APIClient()
    seed.force_login(x_only)
    Flow(seed, x_only, web_app, redirect_uri=WEB_REDIRECT, scope="openid").run()
    assert AppAuthorization.objects.get(user=x_only, application=web_app).is_live

    # Now, signed out, from the app's "Manage Free2Z account" exit.
    browser = APIClient()
    manage = f"/account/apps?client_id={web_app.client_id}"
    assert sign_in_with_x(browser, manage) == manage

    listed = browser.get("/api/oauth/grants/")
    assert listed.status_code == 200
    assert [g["client_id"] for g in listed.json()] == [web_app.client_id]
    assert browser.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204
    assert browser.get("/api/oauth/grants/").json() == []
    assert not AppAuthorization.objects.get(user=x_only, application=web_app).is_live


@pytest.mark.django_db
def test_an_x_only_account_reaches_deletion_freshly_signed_in(
    x_only, x_provider, x_configured
):
    browser = APIClient()
    assert sign_in_with_x(browser, "/account/delete") == "/account/delete"
    recent = browser.get("/api/auth/recent/")
    assert recent.status_code == 200, recent.content
    assert recent.json()["username"] == USERNAME
