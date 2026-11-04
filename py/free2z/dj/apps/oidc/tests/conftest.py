"""Fixtures and a small driver for the authorization-code + PKCE flow.

Everything runs against real Postgres through the real endpoints; the only
thing installed rather than fetched is the signing key ring, which the base
settings generate per process anyway.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from django.core.cache import caches
from rest_framework.test import APIClient

from dj.apps.oidc import keys
from dj.apps.oidc.models import F2ZApplication
from dj.free2z.throttling import FailClosedAuthThrottleMixin

ALL = "openid profile email offline_access balance:read purchase:create ai:invoke"
WEB_REDIRECT = "https://app.example.com/oauth/callback"
WEB_REDIRECT_2 = "https://app.example.com/oauth/other"
WEB_ORIGIN = "https://app.example.com"
LOOPBACK_REGISTERED = "http://127.0.0.1:0/callback"
LOOPBACK_REQUESTED = "http://127.0.0.1:49152/callback"
PRIVATE_SCHEME_REDIRECT = "com.example.tutor:/oauth/callback"
CONFIDENTIAL_REDIRECT = "https://api.example.com/oauth/callback"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)[:64]
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def new_state() -> str:
    return secrets.token_urlsafe(24)


def form_post(client, path, data, **extra):
    return client.post(
        path, urlencode(data), content_type="application/x-www-form-urlencoded", **extra,
    )


def query_of(url: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


@pytest.fixture(autouse=True)
def _fresh_caches():
    caches["default"].clear()
    FailClosedAuthThrottleMixin.cache.clear()
    yield
    caches["default"].clear()
    FailClosedAuthThrottleMixin.cache.clear()


@pytest.fixture
def keyring():
    ring = keys.get_keyring()
    yield ring


@pytest.fixture
def user(creator_factory):
    return creator_factory(username="alice")


@pytest.fixture
def developer(creator_factory):
    return creator_factory(username="corpora")


@pytest.fixture
def web_app(developer):
    return F2ZApplication.objects.create(
        name="Tutor Web",
        user=developer,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris=f"{WEB_REDIRECT} {WEB_REDIRECT_2}",
        allowed_origins=WEB_ORIGIN,
        allowed_scopes=ALL,
        default_spend_cap_2z=100,
    )


@pytest.fixture
def loopback_app(developer):
    return F2ZApplication.objects.create(
        name="Tutor Desktop",
        user=developer,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris=f"{LOOPBACK_REGISTERED} {PRIVATE_SCHEME_REDIRECT}",
        allowed_scopes=ALL,
        default_spend_cap_2z=100,
    )


@pytest.fixture
def confidential_app(developer):
    app = F2ZApplication(
        name="Tutor Server",
        user=developer,
        client_type=F2ZApplication.CLIENT_CONFIDENTIAL,
        redirect_uris=CONFIDENTIAL_REDIRECT,
        allowed_scopes=ALL,
    )
    secret = app.issue_client_secret()
    app.save()
    app.plaintext_secret = secret
    return app


class Flow:
    """Drives one authorization through the real endpoints."""

    def __init__(self, client: APIClient, user, app, *, redirect_uri, scope):
        self.client = client
        self.user = user
        self.app = app
        self.redirect_uri = redirect_uri
        self.scope = scope
        self.verifier, self.challenge = pkce_pair()
        self.state = new_state()
        self.nonce = secrets.token_urlsafe(16)

    def params(self, **overrides) -> dict:
        params = {
            "response_type": "code",
            "client_id": self.app.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": self.scope,
            "state": self.state,
            "nonce": self.nonce,
            "code_challenge": self.challenge,
            "code_challenge_method": "S256",
        }
        params.update(overrides)
        return {k: v for k, v in params.items() if v is not None}

    def evaluate(self, **overrides):
        return self.client.get("/api/oauth/authorize", self.params(**overrides))

    def decide(self, evaluated, *, allow=True, scope=None, spend_cap_2z="omit", cap_period=None):
        body = {
            "request_id": evaluated["request_id"],
            "authorization_request": evaluated["authorization_request"],
            "allow": allow,
        }
        if scope is not None:
            body["scope"] = scope
        if spend_cap_2z != "omit":
            body["spend_cap_2z"] = spend_cap_2z
        if cap_period is not None:
            body["cap_period"] = cap_period
        return self.client.post("/api/oauth/authorize", body, format="json")

    def exchange(self, code, *, redirect_uri=None, verifier="default", client_id=None, extra=None):
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri or self.redirect_uri,
            "client_id": client_id or self.app.client_id,
        }
        if verifier == "default":
            data["code_verifier"] = self.verifier
        elif verifier is not None:
            data["code_verifier"] = verifier
        if extra:
            data.update(extra)
        return form_post(APIClient(), "/api/oauth/token", data)

    def refresh(self, refresh_token, *, scope=None):
        data = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.app.client_id,
        }
        if scope:
            data["scope"] = scope
        return form_post(APIClient(), "/api/oauth/token", data)

    def authorize(self, *, spend_cap_2z="omit", cap_period=None, scope=None, **overrides) -> str:
        """GET + POST; returns the authorization code."""
        response = self.evaluate(**overrides)
        assert response.status_code == 200, response.content
        evaluated = response.json()
        assert evaluated["action"] in ("consent", "approve"), evaluated
        decided = self.decide(
            evaluated, scope=scope, spend_cap_2z=spend_cap_2z, cap_period=cap_period,
        )
        assert decided.status_code == 200, decided.content
        body = decided.json()
        assert body["action"] == "redirect", body
        query = query_of(body["redirect_to"])
        assert "code" in query, body
        assert query["state"] == self.state
        return query["code"]

    def run(self, **kwargs) -> dict:
        """The whole thing; returns the token response body."""
        code = self.authorize(**kwargs)
        response = self.exchange(code)
        assert response.status_code == 200, response.content
        return response.json()


@pytest.fixture
def signed_in(api_client, user):
    api_client.force_login(user)
    return api_client


@pytest.fixture
def flow(signed_in, user, web_app):
    return Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid profile offline_access")


@pytest.fixture
def loopback_flow(signed_in, user, loopback_app):
    return Flow(
        signed_in, user, loopback_app, redirect_uri=LOOPBACK_REQUESTED,
        scope="openid offline_access ai:invoke",
    )
