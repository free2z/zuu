"""Echoed authorization parameters must stay byte-stable across consent.

The POST serializer trims surrounding whitespace and rejects NULs. The GET
must normalize or drop those values before it echoes and signs them, so
neither Allow nor Deny gets stranded by serializer behavior.
"""
from __future__ import annotations

import pytest
import jwt as pyjwt
from django.conf import settings

from .conftest import query_of


pytestmark = pytest.mark.django_db


@pytest.mark.parametrize(
    ("name", "value", "expected"),
    [
        ("login_hint", "  alice@example.com  ", "alice@example.com"),
        ("ui_locales", "  es-VE en  ", "es-VE en"),
        ("login_hint", "alice\x00@example.com", None),
        ("ui_locales", "es-VE\x00 en", None),
    ],
)
@pytest.mark.parametrize("allow", [False, True], ids=["deny", "allow"])
def test_echoed_params_are_normalized_before_signing(flow, name, value, expected, allow):
    evaluated = flow.evaluate(**{name: value}).json()
    assert evaluated["action"] == "consent"

    echoed = evaluated["authorization_request"]
    if expected is None:
        assert name not in echoed
    else:
        assert echoed[name] == expected

    decided = flow.decide(evaluated, allow=allow)
    assert decided.status_code == 200, decided.content
    assert decided.json()["action"] == "redirect"
    if allow:
        assert "code" in decided.json()["redirect_to"]
    else:
        assert "access_denied" in decided.json()["redirect_to"]


def test_request_id_still_binds_a_valid_echoed_param(flow):
    evaluated = flow.evaluate(login_hint="alice@example.com").json()
    tampered = {
        **evaluated,
        "authorization_request": {
            **evaluated["authorization_request"],
            "login_hint": "bob@example.com",
        },
    }

    refused = flow.decide(tampered)
    assert refused.status_code == 400
    assert refused.json()["error"] == "invalid_request"


@pytest.mark.parametrize("allow", [False, True], ids=["deny", "allow"])
def test_state_and_nonce_round_trip_as_opaque_values(flow, keyring, allow):
    state = f"  {flow.state}  "
    nonce = f"  {flow.nonce}  "
    evaluated = flow.evaluate(state=state, nonce=nonce).json()

    assert evaluated["action"] == "consent"
    assert evaluated["authorization_request"]["state"] == state
    assert evaluated["authorization_request"]["nonce"] == nonce

    decided = flow.decide(evaluated, allow=allow)
    assert decided.status_code == 200, decided.content
    redirect = query_of(decided.json()["redirect_to"])
    assert redirect["state"] == state
    if allow:
        tokens = flow.exchange(redirect["code"])
        assert tokens.status_code == 200, tokens.content
        id_claims = pyjwt.decode(
            tokens.json()["id_token"], keyring.active_rs256.public_pem,
            algorithms=["RS256"], audience=flow.app.client_id,
            issuer=settings.OIDC_ISSUER,
        )
        assert id_claims["nonce"] == nonce
    else:
        assert redirect["error"] == "access_denied"
