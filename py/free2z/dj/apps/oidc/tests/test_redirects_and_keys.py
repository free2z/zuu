"""Redirect URI shapes (spec §3) and the signing key ring."""
import json
from io import StringIO

import pytest
from django.core.exceptions import ValidationError
from django.core.management import call_command
from jwcrypto import jwk

from dj.apps.oidc import checks, keys, redirects
from dj.apps.oidc.models import F2ZApplication


@pytest.mark.parametrize("uri,kind", [
    ("http://127.0.0.1:0/callback", redirects.KIND_LOOPBACK),
    ("http://127.0.0.1:49152/cb", redirects.KIND_LOOPBACK),
    ("http://[::1]:8080/cb", redirects.KIND_LOOPBACK),
    ("https://tutor.example.com/oauth/callback", redirects.KIND_HTTPS),
    ("com.example.tutor:/oauth/callback", redirects.KIND_PRIVATE_SCHEME),
])
def test_accepted_shapes(uri, kind):
    assert redirects.classify(uri) == kind


@pytest.mark.parametrize("uri", [
    "http://localhost:8080/cb",            # may resolve off-device (§3)
    "http://example.com/cb",               # http only for loopback
    "https://127.0.0.1/cb",                # loopback is http
    "https://app.example.com/cb?x=1",      # no query of its own
    "https://app.example.com/cb#frag",     # no fragment
    "https://user@app.example.com/cb",     # no credentials
    "com.example.tutor://oauth/callback",  # two slashes (RFC 8252 §7.1)
    "tutor:/oauth/callback",               # not reverse-DNS
    "myapp://cb",
    "",
    "not a uri",
])
def test_refused_shapes(uri):
    with pytest.raises(redirects.RedirectURIError):
        redirects.classify(uri)


@pytest.mark.django_db
def test_registration_enforces_the_shapes(developer):
    app = F2ZApplication(
        name="x", user=developer, client_type="public",
        redirect_uris="http://localhost:1234/cb", allowed_scopes="openid",
    )
    with pytest.raises(ValidationError) as excinfo:
        app.save()
    assert "localhost" in str(excinfo.value)


@pytest.mark.django_db
def test_a_confidential_client_registers_https_only(developer):
    app = F2ZApplication(
        name="x", user=developer, client_type="confidential",
        redirect_uris="http://127.0.0.1:0/cb", allowed_scopes="openid",
    )
    app.issue_client_secret()
    with pytest.raises(ValidationError) as excinfo:
        app.save()
    assert "confidential" in str(excinfo.value)


@pytest.mark.django_db
def test_unknown_scopes_are_refused_at_registration(developer):
    app = F2ZApplication(
        name="x", user=developer, client_type="public",
        redirect_uris="https://a.example.com/cb", allowed_scopes="openid admin",
    )
    with pytest.raises(ValidationError):
        app.save()


@pytest.mark.django_db
def test_allowed_schemes_include_only_the_registered_private_scheme(developer):
    app = F2ZApplication.objects.create(
        name="x", user=developer, client_type="public",
        redirect_uris="com.example.tutor:/cb https://a.example.com/cb",
        allowed_scopes="openid",
    )
    assert app.get_allowed_schemes() == ["com.example.tutor", "http", "https"]


# ------------------------------------------------------------------ keys
def _pem(alg):
    return keys.private_key_to_pem(keys.generate_private_key(alg))


def test_configured_keys_active_first_and_retired_published(settings):
    first, second = _pem(keys.ALG_ES256), _pem(keys.ALG_ES256)
    settings.OIDC_ES256_PRIVATE_KEYS = first + "\n" + second
    settings.OIDC_RS256_PRIVATE_KEYS = _pem(keys.ALG_RS256)
    settings.OIDC_ALLOW_GENERATED_KEYS = False
    ring = keys.load_keyring()
    assert ring.generated is False
    assert len(ring.es256) == 2 and len(ring.rs256) == 1
    assert ring.active_es256.private_pem.decode() == first
    jwks = ring.public_jwks()
    kids = [k["kid"] for k in jwks["keys"]]
    assert kids[0] == ring.active_es256.kid and len(set(kids)) == 3
    assert {k["alg"] for k in jwks["keys"]} == {"ES256", "RS256"}
    assert all(k["use"] == "sig" for k in jwks["keys"])
    assert all("d" not in k for k in jwks["keys"]), "a private component leaked into the JWKS"
    # kid is the RFC 7638 thumbprint, the library's convention for ID tokens.
    assert ring.active_es256.kid == jwk.JWK.from_pem(first.encode()).thumbprint()


def test_a_deployment_without_keys_refuses_and_the_check_is_red(settings):
    settings.OIDC_ES256_PRIVATE_KEYS = ""
    settings.OIDC_RS256_PRIVATE_KEYS = ""
    settings.OIDC_ALLOW_GENERATED_KEYS = False
    with pytest.raises(keys.SigningKeysUnavailable) as excinfo:
        keys.load_keyring()
    assert "OIDC_ES256_PRIVATE_KEYS" in str(excinfo.value)
    # A Warning on the check `migrate` runs (never wedge a deploy behind an
    # unprovisioned secret), an Error under `check --deploy`.
    assert [w.id for w in checks.check_signing_keys(None)] == ["oidc.W001"]
    assert [e.id for e in checks.check_signing_keys_deploy(None)] == ["oidc.E001"]
    # Negative control: both are silent where generation is allowed.
    settings.OIDC_ALLOW_GENERATED_KEYS = True
    assert checks.check_signing_keys(None) == []
    assert checks.check_signing_keys_deploy(None) == []


@pytest.mark.django_db
def test_without_keys_the_endpoints_answer_503_not_a_forged_token(settings, signed_in, user, web_app):
    """The runtime half of the deployment story: no key, no token, and the
    refusal is a 503 the SDK retries, never a 500 and never a token."""
    from rest_framework.test import APIClient

    from .conftest import WEB_REDIRECT, Flow

    old = keys.get_keyring()
    settings.OIDC_ES256_PRIVATE_KEYS = ""
    settings.OIDC_RS256_PRIVATE_KEYS = ""
    settings.OIDC_ALLOW_GENERATED_KEYS = False
    keys.reset()
    try:
        assert APIClient().get("/api/oauth/jwks").status_code == 503
        flow = Flow(signed_in, user, web_app, redirect_uri=WEB_REDIRECT, scope="openid")
        code = flow.authorize()
        response = flow.exchange(code)
        assert response.status_code == 503, response.content[:500]
        assert response.json() == {
            "error": "temporarily_unavailable",
            "error_description": "signing keys unavailable",
        }
    finally:
        keys.install(old)


def test_the_wrong_key_type_is_refused(settings):
    settings.OIDC_ES256_PRIVATE_KEYS = _pem(keys.ALG_RS256)   # RSA where EC is expected
    settings.OIDC_RS256_PRIVATE_KEYS = _pem(keys.ALG_RS256)
    settings.OIDC_ALLOW_GENERATED_KEYS = False
    with pytest.raises(keys.SigningKeysUnavailable, match="P-256"):
        keys.load_keyring()


def test_garbage_in_the_setting_is_refused_not_ignored(settings):
    settings.OIDC_ES256_PRIVATE_KEYS = "not a key"
    settings.OIDC_ALLOW_GENERATED_KEYS = True
    with pytest.raises(keys.SigningKeysUnavailable):
        keys.load_keyring()


def test_the_issuer_check_in_a_deployment(settings):
    settings.OIDC_ALLOW_GENERATED_KEYS = False
    settings.OIDC_ISSUER = "http://localhost:3000"
    assert [w.id for w in checks.check_issuer(None)] == ["oidc.W002"]
    assert [e.id for e in checks.check_issuer_deploy(None)] == ["oidc.E002"]
    settings.OIDC_ISSUER = "https://free2z.cash"
    assert checks.check_issuer(None) == []
    assert checks.check_issuer_deploy(None) == []


def test_rotate_keys_prints_a_usable_block_and_writes_nothing(settings, tmp_path):
    out, err = StringIO(), StringIO()
    call_command("oidc_rotate_keys", "--alg", "es256", stdout=out, stderr=err)
    pem = out.getvalue()
    assert "BEGIN PRIVATE KEY" in pem
    assert "OIDC_ES256_PRIVATE_KEYS" in err.getvalue()
    # The block it printed is exactly what the loader accepts as active.
    settings.OIDC_ES256_PRIVATE_KEYS = pem
    settings.OIDC_RS256_PRIVATE_KEYS = _pem(keys.ALG_RS256)
    settings.OIDC_ALLOW_GENERATED_KEYS = False
    ring = keys.load_keyring()
    assert ring.active_es256.private_pem.decode() == pem.strip() + "\n"
    assert not list(tmp_path.iterdir())


def test_show_jwks_prints_the_published_set():
    out = StringIO()
    call_command("oidc_rotate_keys", "--show-jwks", stdout=out, stderr=StringIO())
    doc = json.loads(out.getvalue())
    assert {k["alg"] for k in doc["keys"]} == {"ES256", "RS256"}
