"""The developer console API: a developer's own registrations only,
operator fields never writable, the secret shown once, delete refused once
users have authorized the app. Real Postgres, real endpoints."""
from __future__ import annotations

import pytest
from django.contrib.auth.hashers import check_password
from rest_framework.test import APIClient

from dj.apps.oidc.developer import MAX_APPS_PER_DEVELOPER
from dj.apps.oidc.models import AppAuthorization, F2ZApplication

from .conftest import WEB_REDIRECT, Flow

pytestmark = pytest.mark.django_db

APPS = "/api/oauth/apps/"


@pytest.fixture
def dev_client(api_client, developer):
    api_client.force_login(developer)
    return api_client


def _public(**overrides):
    body = {
        "client_type": "public",
        "name": "Tutor Desktop",
        "redirect_uris": ["http://127.0.0.1:0/callback", "com.example.tutor:/oauth/callback"],
        "allowed_scopes": ["openid", "ai:invoke"],
    }
    body.update(overrides)
    return body


def test_register_a_public_client_issues_no_secret(dev_client, developer):
    response = dev_client.post(APPS, _public(), format="json")
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["client_secret"] is None
    assert body["has_client_secret"] is False
    assert body["redirect_uris"] == ["http://127.0.0.1:0/callback", "com.example.tutor:/oauth/callback"]
    assert body["allowed_scopes"] == ["openid", "ai:invoke"]
    assert body["markup_approval"] == "none"
    app = F2ZApplication.objects.get(pk=body["id"])
    assert app.user == developer
    assert app.client_secret == ""
    assert app.first_party is False


def test_confidential_secret_is_shown_once_and_stored_hashed(dev_client):
    response = dev_client.post(APPS, _public(
        client_type="confidential", redirect_uris=["https://api.example.com/cb"],
    ), format="json")
    assert response.status_code == 201, response.content
    secret = response.json()["client_secret"]
    assert secret and len(secret) >= 32
    app = F2ZApplication.objects.get(pk=response.json()["id"])
    assert app.client_secret != secret
    assert check_password(secret, app.client_secret)
    # Never readable again.
    for listed in (dev_client.get(APPS).json()[0], dev_client.get(f"{APPS}{app.pk}/").json()):
        assert "client_secret" not in listed
        assert listed["has_client_secret"] is True


def test_rotate_replaces_the_secret(dev_client):
    created = dev_client.post(APPS, _public(
        client_type="confidential", redirect_uris=["https://api.example.com/cb"],
    ), format="json").json()
    rotated = dev_client.post(f"{APPS}{created['id']}/rotate-secret/")
    assert rotated.status_code == 200, rotated.content
    new_secret = rotated.json()["client_secret"]
    assert new_secret != created["client_secret"]
    app = F2ZApplication.objects.get(pk=created["id"])
    assert check_password(new_secret, app.client_secret)
    assert not check_password(created["client_secret"], app.client_secret)


def test_rotate_refuses_a_public_client(dev_client):
    created = dev_client.post(APPS, _public(), format="json").json()
    response = dev_client.post(f"{APPS}{created['id']}/rotate-secret/")
    assert response.status_code == 400
    assert F2ZApplication.objects.get(pk=created["id"]).client_secret == ""


@pytest.mark.parametrize("uri, fragment", [
    ("http://localhost:8080/cb", "localhost"),
    ("https://app.example.com/cb?x=1", "query"),
    ("https://app.example.com/cb#f", "fragment"),
    ("com.example.app://cb", "one slash"),
    ("myapp:/cb", "reverse-DNS"),
    ("http://example.com/cb", "loopback"),
])
def test_redirect_uri_refusals_name_the_reason(dev_client, uri, fragment):
    response = dev_client.post(APPS, _public(redirect_uris=[uri]), format="json")
    assert response.status_code == 400
    messages = response.json()["redirect_uris"]
    assert any(uri in m and fragment in m for m in messages), messages
    assert not F2ZApplication.objects.exists()


def test_a_uri_with_whitespace_is_refused_not_split(dev_client):
    response = dev_client.post(
        APPS, _public(redirect_uris=["https://a.example.com/cb https://b.example.com/cb"]),
        format="json",
    )
    assert response.status_code == 400
    assert "whitespace" in response.json()["redirect_uris"][0]


def test_confidential_client_may_register_https_only(dev_client):
    response = dev_client.post(APPS, _public(
        client_type="confidential", redirect_uris=["http://127.0.0.1:0/cb"],
    ), format="json")
    assert response.status_code == 400
    assert "confidential" in response.json()["redirect_uris"][0]


def test_markup_above_approval_is_pending_and_operator_fields_are_ignored(dev_client):
    response = dev_client.post(APPS, _public(
        markup_bps=2000, approved_markup_bps=5000, first_party=True, frozen=True,
        allow_zcash_assertion=True,
    ), format="json")
    assert response.status_code == 201, response.content
    body = response.json()
    assert body["markup_bps"] == 2000
    assert body["approved_markup_bps"] is None
    assert body["effective_markup_bps"] == 0
    assert body["markup_approval"] == "pending"
    app = F2ZApplication.objects.get(pk=body["id"])
    assert (app.first_party, app.frozen, app.allow_zcash_assertion) == (False, False, False)

    # An operator approves 1000; the developer then asks for more.
    F2ZApplication.objects.filter(pk=app.pk).update(approved_markup_bps=1000)
    patched = dev_client.patch(f"{APPS}{app.pk}/", {"markup_bps": 1000}, format="json").json()
    assert (patched["effective_markup_bps"], patched["markup_approval"]) == (1000, "approved")
    patched = dev_client.patch(
        f"{APPS}{app.pk}/", {"markup_bps": 3000, "approved_markup_bps": 5000}, format="json",
    ).json()
    assert patched["approved_markup_bps"] == 1000
    assert (patched["effective_markup_bps"], patched["markup_approval"]) == (1000, "pending")


def test_markup_above_the_platform_cap_is_refused(dev_client):
    response = dev_client.post(APPS, _public(markup_bps=5001), format="json")
    assert response.status_code == 400
    assert "markup_bps" in response.json()


def test_client_type_is_fixed(dev_client):
    created = dev_client.post(APPS, _public(), format="json").json()
    response = dev_client.patch(f"{APPS}{created['id']}/", {"client_type": "confidential"}, format="json")
    assert response.status_code == 400
    assert F2ZApplication.objects.get(pk=created["id"]).client_type == "public"


def test_patch_edits_and_validates(dev_client):
    created = dev_client.post(APPS, _public(), format="json").json()
    url = f"{APPS}{created['id']}/"
    ok = dev_client.patch(url, {
        "name": "Tutor", "redirect_uris": ["https://tutor.example.com/cb"],
        "default_spend_cap_2z": 250, "default_cap_period": "week",
        "privacy_url": "https://tutor.example.com/privacy",
    }, format="json")
    assert ok.status_code == 200, ok.content
    assert ok.json()["redirect_uris"] == ["https://tutor.example.com/cb"]
    assert ok.json()["default_cap_period"] == "week"
    bad = dev_client.patch(url, {"redirect_uris": ["http://localhost/cb"]}, format="json")
    assert bad.status_code == 400
    assert F2ZApplication.objects.get(pk=created["id"]).redirect_uris == "https://tutor.example.com/cb"


def test_another_developers_app_is_a_404_everywhere(dev_client, creator_factory):
    other = creator_factory(username="mallory")
    theirs = F2ZApplication.objects.create(
        name="Theirs", user=other, client_type="confidential",
        redirect_uris="https://m.example.com/cb", client_secret="x" * 40,
    )
    url = f"{APPS}{theirs.pk}/"
    assert dev_client.get(url).status_code == 404
    assert dev_client.patch(url, {"name": "Mine"}, format="json").status_code == 404
    assert dev_client.delete(url).status_code == 404
    assert dev_client.post(f"{url}rotate-secret/").status_code == 404
    assert dev_client.get(APPS).json() == []
    theirs.refresh_from_db()
    assert theirs.name == "Theirs"


def test_anonymous_is_refused(api_client):
    assert api_client.get(APPS).status_code in (401, 403)
    assert api_client.post(APPS, _public(), format="json").status_code in (401, 403)


def test_delete_an_unused_app(dev_client):
    created = dev_client.post(APPS, _public(), format="json").json()
    assert dev_client.delete(f"{APPS}{created['id']}/").status_code == 204
    assert not F2ZApplication.objects.filter(pk=created["id"]).exists()


def test_delete_is_refused_once_a_user_authorized_the_app(dev_client, developer, user, web_app):
    # A live grant, then revoked: both must keep the app.
    user_client = APIClient()
    user_client.force_login(user)
    Flow(user_client, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid").run()
    assert AppAuthorization.objects.filter(application=web_app).exists()
    response = dev_client.delete(f"{APPS}{web_app.pk}/")
    assert response.status_code == 409
    assert response.json()["code"] == "app_has_authorizations"
    assert user_client.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204
    assert dev_client.delete(f"{APPS}{web_app.pk}/").status_code == 409
    assert F2ZApplication.objects.filter(pk=web_app.pk).exists()


def test_registration_count_is_bounded(dev_client, developer):
    for i in range(MAX_APPS_PER_DEVELOPER):
        F2ZApplication.objects.create(
            name=f"app {i}", user=developer, client_type="public",
            redirect_uris="https://x.example.com/cb",
        )
    response = dev_client.post(APPS, _public(), format="json")
    assert response.status_code == 400
    assert F2ZApplication.objects.filter(user=developer).count() == MAX_APPS_PER_DEVELOPER


def test_a_default_cap_beyond_the_column_is_a_400_not_a_500(dev_client):
    response = dev_client.post(
        APPS, _public(default_spend_cap_2z=2_147_483_648), format="json",
    )
    assert response.status_code == 400
    assert "default_spend_cap_2z" in response.json()
    ok = dev_client.post(APPS, _public(default_spend_cap_2z=2_147_483_647), format="json")
    assert ok.status_code == 201, ok.content
