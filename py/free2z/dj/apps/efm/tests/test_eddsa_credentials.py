"""The WebAuthn ceremonies, run against an **Ed25519** credential.

Why this file exists, in one paragraph. `webauthn` 3.0.0  reordered
`pubKeyCredParams` to put **EdDSA first**, and `generate_registration_options`
in `dj/apps/efm/views.py` takes that default. `pubKeyCredParams` is an ordered
list of the relying party's preferences, so an authenticator that supports
Ed25519 will now mint an Ed25519 credential rather than the ES256 one it used
to. Until this file, `softauthn.py` could only produce ES256 — so the entire
efm suite was green while proving nothing whatsoever about the algorithm
production would see *first*. That is the sharpest version of the failure mode
this repo keeps writing down: a test that passes without testing.

What it pins:

1. **The whole registration ceremony works for an OKP/Ed25519 credential** —
   the COSE key shape, the attestation object, and what `views.py` persists.
2. **Assertions verify**, which is the half that would break silently: an
   Ed25519 signature is over the raw payload (RFC 8032 hashes internally),
   not over a SHA-256 digest, and `cryptography` refuses a hash argument for
   it at all.
3. **`sign_count` behaves identically** — persisted, advancing, and a
   non-advancing counter rejected and logged. The counter lives in
   `authenticatorData`, so it is algorithm-independent by construction; that
   is exactly the kind of claim worth a test rather than a comment, because
   the code path that reads it runs *after* signature verification and never
   runs at all if verification fails for algorithm reasons.
4. **The relying-party binding still holds** — a credential minted for another
   registrable domain is refused whatever it is signed with. 's guarantee
   must not be algorithm-shaped.

The app is OFFLINE (`dj/apps/efm/__init__.py`) and nothing here re-routes it.
These tests run against the test-only URLconf, exactly as `test_webauthn_rp.py`
and `test_sign_count.py` do.
"""

import base64
import json
import logging

import cbor2
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from django.test import Client

from dj.apps.efm.models import Participant
from dj.apps.efm.tests.softauthn import (
    ALGORITHMS,
    COSE_ALG,
    COSE_ALG_EDDSA,
    COSE_ALG_ES256,
    EDDSA,
    ES256,
    SoftAuthenticator,
)
from dj.apps.efm.tests.test_sign_count import (
    VIEWS_LOGGER,
    authenticate_at,
    regression_events,
    stored_sign_count,
)
from dj.apps.efm.tests.test_webauthn_rp import (
    OTHER_ORIGIN,
    RP_ID,
    RP_ORIGIN,
    authenticate,
    configured_rp,  # noqa: F401 -- imported so the autouse fixture applies here
    register,
)

pytestmark = pytest.mark.django_db

#The COSE `alg` each arm must actually end up storing.
EXPECTED_COSE_ALG = {EDDSA: COSE_ALG_EDDSA, ES256: COSE_ALG_ES256}


def stored_cose_algorithm(participant_uuid) -> int:
    """The `alg` of the public key `views.py` actually persisted.

    Asserted in every arm, not only in the positive control, because a
    `SoftAuthenticator(algorithm=EDDSA)` that quietly fell back to ES256 makes
    every parametrized test below pass while testing the same algorithm twice —
    which is the exact "test that passes without testing" this file exists to
    stop. Reverting the EdDSA arm of `softauthn.py` must turn these red.
    """
    participant = Participant.objects.get(uuid=participant_uuid)
    raw = base64.urlsafe_b64decode(participant.webauthn_public_key + "==")
    return cbor2.loads(raw)[COSE_ALG]


def test_the_soft_authenticator_can_actually_produce_ed25519():
    """The positive control for this whole file.

    If `SoftAuthenticator(algorithm=EDDSA)` quietly fell back to ES256, every
    test below would still pass and none of them would mean anything.
    """
    authenticator = SoftAuthenticator(algorithm=EDDSA)
    assert isinstance(authenticator.private_key, ed25519.Ed25519PrivateKey)

    # RFC 8152 §13.2: kty=OKP(1), alg=EdDSA(-8), crv=Ed25519(6), and a raw
    # 32-byte public key in `x` with no `y` at all.
    cose = cbor2.loads(authenticator._cose_public_key())
    assert cose[1] == 1
    assert cose[3] == -8
    assert cose[-1] == 6
    assert len(cose[-2]) == 32
    assert -3 not in cose


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_registration_persists_the_credential(algorithm):
    client = Client()
    authenticator = SoftAuthenticator(algorithm=algorithm)

    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)

    assert response.status_code == 200, response.content
    participant = Participant.objects.get(uuid=body["participant_uuid"])
    assert participant.webauthn_credential_id
    assert participant.webauthn_public_key
    assert (
        stored_cose_algorithm(body["participant_uuid"])
        == EXPECTED_COSE_ALG[algorithm]
    )


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_authentication_verifies_and_mints_a_token(algorithm):
    """The half that would break silently.

    An Ed25519 signature is computed over the raw
    `authenticatorData || SHA-256(clientDataJSON)` payload — Ed25519 hashes
    internally (RFC 8032), and `cryptography` refuses a hash argument for it.
    Getting that wrong produces a credential that registers fine and can never
    authenticate again.
    """
    client = Client()
    authenticator = SoftAuthenticator(algorithm=algorithm)
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assert (
        stored_cose_algorithm(body["participant_uuid"])
        == EXPECTED_COSE_ALG[algorithm]
    )

    _, auth_response = authenticate(
        client, authenticator, body, rp_id=RP_ID, origin=RP_ORIGIN)

    assert auth_response.status_code == 200, auth_response.content
    assert auth_response.json()["token"]


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_sign_count_is_persisted_and_advances(algorithm):
    """The counter lives in `authenticatorData`, so it is algorithm-independent
    by construction — and the code that reads it runs only *after* signature
    verification, which is precisely why that claim is worth a test.
    """
    client = Client()
    authenticator = SoftAuthenticator(algorithm=algorithm)
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content
    assert (
        stored_cose_algorithm(body["participant_uuid"])
        == EXPECTED_COSE_ALG[algorithm]
    )

    for counter in (1, 2, 17):
        assert authenticate_at(
            client, authenticator, body, counter
        ).status_code == 200
        assert stored_sign_count(body) == counter


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_a_counter_that_does_not_advance_is_still_rejected(algorithm, caplog):
    client = Client()
    authenticator = SoftAuthenticator(algorithm=algorithm)
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    assert authenticate_at(client, authenticator, body, 9).status_code == 200

    with caplog.at_level(logging.WARNING, logger=VIEWS_LOGGER):
        replayed = authenticate_at(client, authenticator, body, 9)

    assert replayed.status_code == 400
    assert replayed.json()["error"] == "Authentication failed"
    assert stored_sign_count(body) == 9
    regressions = regression_events(caplog)
    assert len(regressions) == 1, caplog.text
    _, payload = regressions[0]
    assert payload["stored_sign_count"] == 9
    assert payload["presented_sign_count"] == 9


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_registration_for_another_rp_id_is_refused(algorithm):
    """'s relying-party binding must not be algorithm-shaped.

    **Only `rp_id` varies.** `verify_registration_response` checks the origin
    BEFORE it parses the attestation object or compares the RP-ID hash, so a
    test that changes both gets its 400 from the origin and never exercises
    the RP-ID guarantee at all — it would stay green through a dependency
    change that removed RP-ID validation entirely, and the app would later be
    re-enabled believing this was covered. (codex adversarial review.)
    """
    client = Client()
    authenticator = SoftAuthenticator(algorithm=algorithm)

    body, response = register(
        client,
        authenticator,
        rp_id="www.free2z.com",
        origin=RP_ORIGIN,
    )

    assert response.status_code == 400, response.content
    participant = Participant.objects.get(uuid=body["participant_uuid"])
    assert not participant.webauthn_credential_id
    assert not participant.webauthn_public_key


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_registration_for_another_origin_is_refused(algorithm):
    """The other half of the same binding, varied on its own for the same
    reason: two guarantees checked by one assertion is one guarantee.
    """
    client = Client()
    authenticator = SoftAuthenticator(algorithm=algorithm)

    body, response = register(
        client,
        authenticator,
        rp_id=RP_ID,
        origin=OTHER_ORIGIN,
    )

    assert response.status_code == 400, response.content
    participant = Participant.objects.get(uuid=body["participant_uuid"])
    assert not participant.webauthn_credential_id


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_an_assertion_signed_for_another_rp_id_is_refused(algorithm):
    """The authentication half of the binding.

    A credential registered correctly, then used from a page whose RP ID is a
    different registrable domain. The signature is valid; the rpIdHash in
    `authenticatorData` is not what this relying party configured. Covered per
    algorithm because the verifier does the RP-ID comparison and the signature
    check in the same call.
    """
    client = Client()
    authenticator = SoftAuthenticator(algorithm=algorithm)
    body, response = register(
        client, authenticator, rp_id=RP_ID, origin=RP_ORIGIN)
    assert response.status_code == 200, response.content

    _, auth_response = authenticate(
        client, authenticator, body, rp_id="www.free2z.com", origin=RP_ORIGIN)

    assert auth_response.status_code == 400, auth_response.content
    assert auth_response.json()["error"] == "Authentication failed"
    # A refused assertion moves nothing.
    assert stored_sign_count(body) == 0


def test_registration_options_still_offer_eddsa_first():
    """The premise of this file, asserted rather than assumed.

    If a future `webauthn` bump reorders `pubKeyCredParams` again, the EdDSA
    arm stops describing what production sees first — and nothing else would
    say so.
    """
    client = Client()
    response = client.post(
        "/api/efm/start-group",
        data=json.dumps({"max_participants": 3}),
        content_type="application/json",
        HTTP_HOST=RP_ID,
    )
    assert response.status_code == 200, response.content
    options = json.loads(response.json()["registration_challenge"])
    algorithms = [param["alg"] for param in options["pubKeyCredParams"]]
    assert algorithms[0] == -8, algorithms
    assert -7 in algorithms, algorithms
