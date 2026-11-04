"""Userinfo, revocation, introspection, discovery, JWKS, grants, CORS, and
the default-deny of `OAuth2JWTAuthentication` on tuzi's own API."""
from __future__ import annotations

import base64
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.emails.models import Email
from dj.apps.oidc.models import AccessToken, AppAuthorization, RefreshToken
from dj.apps.oidc.scopes import ALL_SCOPES

from .conftest import CONFIDENTIAL_REDIRECT, WEB_ORIGIN, WEB_REDIRECT, Flow, form_post

pytestmark = pytest.mark.django_db


def bearer(token):
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


def basic(client_id, secret):
    raw = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    return {"HTTP_AUTHORIZATION": f"Basic {raw}"}


# ------------------------------------------------------------- userinfo
def test_userinfo_returns_the_claims_the_scopes_allow(signed_in, user, web_app):
    Email.objects.create(user=user, email="alice@example.com", token="t",
                         expires_at=timezone.now() + timedelta(days=1),
                         confirmed_at=timezone.now())
    user.full_name = "Alice A."
    user.save(update_fields=["full_name"])
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT,
                  scope="openid profile email").run()
    response = APIClient().get("/api/oauth/userinfo", **bearer(tokens["access_token"]))
    assert response.status_code == 200
    claims = response.json()
    assert claims.pop("picture").endswith(".png")      # the default avatar
    assert claims == {
        "sub": str(user.public_id),
        "preferred_username": "alice",
        "name": "Alice A.",
        "email": "alice@example.com",
        "email_verified": True,
    }
    assert response["Cache-Control"] == "no-store"
    # POST works too (OIDC Core §5.3.1).
    assert APIClient().post("/api/oauth/userinfo", **bearer(tokens["access_token"])).status_code == 200
    only_openid = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid").run()
    assert APIClient().get("/api/oauth/userinfo", **bearer(only_openid["access_token"])).json() == {
        "sub": str(user.public_id),
    }


def test_userinfo_needs_openid_and_refuses_garbage(signed_in, user, web_app):
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="balance:read").run()
    refused = APIClient().get("/api/oauth/userinfo", **bearer(tokens["access_token"]))
    assert refused.status_code == 403
    assert refused.json()["code"] == "insufficient_scope"
    assert refused.json()["required_scopes"] == ["openid"]
    assert APIClient().get("/api/oauth/userinfo").status_code == 401
    garbage = APIClient().get("/api/oauth/userinfo", **bearer("not.a.jwt"))
    assert garbage.status_code == 401
    assert garbage["WWW-Authenticate"].startswith("Bearer")


# --------------------------------------------------------- default deny
def test_oauth_tokens_are_refused_by_views_that_declared_no_scopes(signed_in, user, web_app):
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope=" ".join(ALL_SCOPES)).run(
        spend_cap_2z=10, cap_period="day",
    )
    token = tokens["access_token"]
    # Every scope granted, and still: no `required_scopes`, no entry. (403
    # rather than 401 on these: DRF takes the challenge header from the
    # FIRST authenticator, SessionAuthentication, which has none.)
    for path in ("/api/auth/user/", "/api/oauth/grants/", "/api/creator/"):
        response = APIClient().get(path, **bearer(token))
        assert response.status_code in (401, 403), (path, response.content)
        assert "not accepted" in response.json()["detail"]
    # Control: the one view that opted in.
    assert APIClient().get("/api/oauth/userinfo", **bearer(token)).status_code == 200


def test_session_and_knox_are_untouched_by_the_third_authenticator(signed_in):
    assert signed_in.get("/api/auth/user/").status_code == 200
    assert signed_in.get("/api/oauth/grants/").status_code == 200


# ------------------------------------------------------------- revocation
def test_revoking_a_refresh_token_kills_its_family(signed_in, user, web_app):
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid offline_access")
    tokens = flow.run()
    rotated = flow.refresh(tokens["refresh_token"]).json()
    response = form_post(APIClient(), "/api/oauth/revoke", {
        "token": rotated["refresh_token"], "token_type_hint": "refresh_token",
        "client_id": web_app.client_id,
    })
    assert response.status_code == 200
    assert flow.refresh(rotated["refresh_token"]).status_code == 400
    assert not RefreshToken.objects.filter(user=user, revoked__isnull=True).exists()
    # Idempotent, and unknown tokens are 200 too (RFC 7009 §2.2).
    assert form_post(APIClient(), "/api/oauth/revoke", {
        "token": "nonsense", "client_id": web_app.client_id,
    }).status_code == 200
    # The grant itself is untouched: revoking a token is not revoking the app.
    assert AppAuthorization.objects.get(user=user, application=web_app).is_live


def test_an_access_token_cannot_be_revoked_individually(signed_in, user, web_app):
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid").run()
    response = form_post(APIClient(), "/api/oauth/revoke", {
        "token": tokens["access_token"], "client_id": web_app.client_id,
    })
    assert response.status_code == 400
    assert response.json()["error"] == "unsupported_token_type"
    assert AccessToken.objects.filter(token=tokens["access_token"]).exists()


def test_revocation_is_scoped_to_the_requesting_client(signed_in, user, web_app, loopback_app):
    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid offline_access")
    tokens = flow.run()
    response = form_post(APIClient(), "/api/oauth/revoke", {
        "token": tokens["refresh_token"], "client_id": loopback_app.client_id,
    })
    assert response.status_code == 200          # never discloses
    assert flow.refresh(tokens["refresh_token"]).status_code == 200


# ---------------------------------------------------------- introspection
def test_introspection_for_confidential_clients_only(signed_in, user, web_app, confidential_app):
    tokens = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid ai:invoke").run(
        spend_cap_2z=5, cap_period="day",
    )
    ok = form_post(APIClient(), "/api/oauth/introspect", {"token": tokens["access_token"]},
                   **basic(confidential_app.client_id, confidential_app.plaintext_secret))
    assert ok.status_code == 200, ok.content
    body = ok.json()
    assert body["active"] is True
    assert body["client_id"] == web_app.client_id
    assert body["sub"] == str(user.public_id)
    assert body["scope"] == "openid ai:invoke"
    assert body["aud"] == ["f2z-id", "f2z-ai", "f2z-api"]
    assert (body["aep"], body["agen"]) == (1, 1)
    assert body["exp"] - body["iat"] == 300

    wrong_secret = form_post(APIClient(), "/api/oauth/introspect", {"token": tokens["access_token"]},
                             **basic(confidential_app.client_id, "nope"))
    assert wrong_secret.status_code == 401 and wrong_secret["WWW-Authenticate"].startswith("Basic")
    public = form_post(APIClient(), "/api/oauth/introspect", {"token": tokens["access_token"]},
                       **basic(web_app.client_id, ""))
    assert public.status_code == 401
    unauthenticated = form_post(APIClient(), "/api/oauth/introspect", {"token": tokens["access_token"]})
    assert unauthenticated.status_code == 401

    # Revoking the grant makes it inactive, as does an expired row.
    assert signed_in.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204
    inactive = form_post(APIClient(), "/api/oauth/introspect", {"token": tokens["access_token"]},
                         **basic(confidential_app.client_id, confidential_app.plaintext_secret))
    assert inactive.json() == {"active": False}
    junk = form_post(APIClient(), "/api/oauth/introspect", {"token": "junk"},
                     **basic(confidential_app.client_id, confidential_app.plaintext_secret))
    assert junk.json() == {"active": False}


def test_a_confidential_client_authenticates_at_the_token_endpoint(signed_in, user, confidential_app):
    flow = Flow(signed_in, user, confidential_app, redirect_uri=CONFIDENTIAL_REDIRECT, scope="openid offline_access")
    code = flow.authorize()
    without_secret = flow.exchange(code)
    assert without_secret.status_code in (400, 401)
    code = flow.authorize()
    with_secret = form_post(APIClient(), "/api/oauth/token", {
        "grant_type": "authorization_code", "code": code, "redirect_uri": CONFIDENTIAL_REDIRECT,
        "code_verifier": flow.verifier,
    }, **basic(confidential_app.client_id, confidential_app.plaintext_secret))
    assert with_secret.status_code == 200, with_secret.content
    assert "refresh_token" in with_secret.json()


# ------------------------------------------------------- discovery & JWKS
def test_discovery_at_the_root_and_under_the_api_prefix(settings):
    root = APIClient().get("/.well-known/openid-configuration")
    assert root.status_code == 200
    doc = root.json()
    assert doc == APIClient().get("/api/oauth/.well-known/openid-configuration").json()
    issuer = settings.OIDC_ISSUER
    assert doc["issuer"] == issuer
    assert doc["authorization_endpoint"] == f"{issuer}/oauth/authorize"
    assert doc["token_endpoint"] == f"{issuer}/api/oauth/token"
    assert doc["userinfo_endpoint"] == f"{issuer}/api/oauth/userinfo"
    assert doc["jwks_uri"] == f"{issuer}/api/oauth/jwks"
    assert doc["revocation_endpoint"] == f"{issuer}/api/oauth/revoke"
    assert doc["introspection_endpoint"] == f"{issuer}/api/oauth/introspect"
    assert doc["response_types_supported"] == ["code"]
    assert doc["grant_types_supported"] == ["authorization_code", "refresh_token"]
    assert doc["code_challenge_methods_supported"] == ["S256"]
    assert doc["id_token_signing_alg_values_supported"] == ["RS256"]
    assert doc["token_endpoint_auth_methods_supported"] == ["none", "client_secret_basic", "client_secret_post"]
    assert doc["scopes_supported"] == list(ALL_SCOPES)
    assert doc["acr_values_supported"] == ["urn:f2z:acr:1fa", "urn:f2z:acr:mfa"]
    assert root["Access-Control-Allow-Origin"] == "*"


def test_jwks_publishes_both_algorithms_with_kids(keyring):
    response = APIClient().get("/api/oauth/jwks")
    assert response.status_code == 200
    doc = response.json()
    assert [k["kid"] for k in doc["keys"]] == [keyring.active_es256.kid, keyring.active_rs256.kid]
    assert doc["keys"][0]["kty"] == "EC" and doc["keys"][0]["crv"] == "P-256"
    assert doc["keys"][1]["kty"] == "RSA"
    assert response["Cache-Control"].startswith("public")


# ------------------------------------------------------------------ grants
def test_grants_list_and_revoke(signed_in, user, web_app, django_capture_on_commit_callbacks):
    from dj.apps.oidc.epoch_publish import read_grant_generation

    flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid offline_access ai:invoke")
    with django_capture_on_commit_callbacks(execute=True):
        tokens = flow.run(spend_cap_2z=100, cap_period="week")
    assert read_grant_generation(user.public_id, web_app.client_id) == 1
    listed = signed_in.get("/api/oauth/grants/")
    assert listed.status_code == 200
    [grant] = listed.json()
    assert grant["client_id"] == web_app.client_id
    assert grant["scope"] == ["openid", "offline_access", "ai:invoke"]
    assert (grant["spend_cap_2z"], grant["cap_period"], grant["generation"]) == (100, "week", 1)

    with django_capture_on_commit_callbacks(execute=True):
        assert signed_in.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204
    assert signed_in.get("/api/oauth/grants/").json() == []
    row = AppAuthorization.objects.get(user=user, application=web_app)
    assert row.generation == 2 and row.revoked_at is not None
    assert read_grant_generation(user.public_id, web_app.client_id) == 2
    assert APIClient().get("/api/oauth/userinfo", **bearer(tokens["access_token"])).status_code == 401
    assert flow.refresh(tokens["refresh_token"]).status_code == 400
    assert not AccessToken.objects.filter(user=user).exists()
    # Unknown app: 404. Already revoked: idempotent.
    assert signed_in.delete("/api/oauth/grants/00000000-0000-4000-8000-000000000000/").status_code == 404
    assert signed_in.delete(f"/api/oauth/grants/{web_app.pk}/").status_code == 204
    # A new consent revives the grant at the bumped generation.
    fresh = flow.run(spend_cap_2z=100, cap_period="week")
    row.refresh_from_db()
    assert row.is_live and row.generation == 2
    assert APIClient().get("/api/oauth/userinfo", **bearer(fresh["access_token"])).status_code == 200


def test_grants_are_not_reachable_anonymously(api_client, web_app):
    assert api_client.get("/api/oauth/grants/").status_code in (401, 403)
    assert api_client.delete(f"/api/oauth/grants/{web_app.pk}/").status_code in (401, 403)


# -------------------------------------------------------------------- CORS
def test_registered_web_origins_get_cors_on_the_oauth_endpoints(web_app):
    preflight = APIClient().options(
        "/api/oauth/token", HTTP_ORIGIN=WEB_ORIGIN,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert preflight["Access-Control-Allow-Origin"] == WEB_ORIGIN
    stranger = APIClient().options(
        "/api/oauth/token", HTTP_ORIGIN="https://stranger.example",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert "Access-Control-Allow-Origin" not in stranger
    # The registry opens ONLY the OAuth endpoints, never the rest of the API.
    elsewhere = APIClient().options(
        "/api/zpage/", HTTP_ORIGIN=WEB_ORIGIN, HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET",
    )
    assert "Access-Control-Allow-Origin" not in elsewhere
