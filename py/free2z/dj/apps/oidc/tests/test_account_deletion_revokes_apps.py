"""Requesting deletion of a Free2Z account signs every SDK app out at once.

Store policy makes ``/account/delete`` the deletion path for every SDK app, so
the one property that matters to an app is: after deletion, nothing it holds
works. Driven through the real authorization-code flow, then the real
deletion endpoint, then the real token and userinfo endpoints.
"""
import pytest
from rest_framework.test import APIClient

from dj.apps.oidc.models import AccessToken, AppAuthorization, RefreshToken

from .conftest import WEB_REDIRECT, Flow

pytestmark = pytest.mark.django_db


def test_deletion_revokes_every_grant_and_token(user, web_app, recent_login):
    browser = APIClient()
    recent_login(browser, user)
    flow = Flow(browser, user, web_app, redirect_uri=WEB_REDIRECT,
                scope="openid profile offline_access")
    tokens = flow.run()
    bearer = APIClient()
    bearer.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access_token']}")
    assert bearer.get("/api/oauth/userinfo").status_code == 200

    response = browser.post("/api/auth/account-deletion/schedule/",
                            {"confirm_username": "alice"}, format="json")
    # Revoked when the deletion is REQUESTED, not 30 days later at the purge.
    assert response.status_code == 202, response.content

    grant = AppAuthorization.objects.get(user=user, application=web_app)
    assert not grant.is_live
    assert not AccessToken.objects.filter(user=user).exists()
    assert not RefreshToken.objects.filter(user=user, revoked__isnull=True).exists()
    assert flow.refresh(tokens["refresh_token"]).status_code == 400
    assert bearer.get("/api/oauth/userinfo").status_code == 401
