"""A minimal software WebAuthn authenticator, for tests only.

Enough of CTAP2/WebAuthn to produce attestation objects and assertions that
the real ``py_webauthn`` verifier accepts. This exists so the EFM tests can
exercise the *actual* ``verify_registration_response`` /
``verify_authentication_response`` calls rather than mocking them out -- the
whole point of  is which ``rp_id`` and origin those functions are handed,
and a mock would prove nothing about whether a mismatched RP is really
rejected.

Two algorithms, and the second one is not decoration. ``webauthn`` 3.0.0
 reordered ``pubKeyCredParams`` to put **EdDSA first**, so a real
authenticator that supports Ed25519 will now mint an Ed25519 credential in
preference to ES256 -- which means the algorithm this file used to be able to
produce is no longer the one production would see first. A green ``backend``
job proved nothing about the EdDSA path. ``fmt: "none"`` attestation
(what the views request via ``AttestationConveyancePreference.NONE``), no
extensions.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct

import cbor2
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

# authenticatorData flag bits (WebAuthn L2 6.1).
FLAG_USER_PRESENT = 0x01
FLAG_USER_VERIFIED = 0x04
FLAG_ATTESTED_CREDENTIAL_DATA = 0x40

COSE_KTY = 1
COSE_ALG = 3
COSE_CRV = -1
COSE_X = -2
COSE_Y = -3
COSE_KTY_EC2 = 2
COSE_KTY_OKP = 1
COSE_ALG_ES256 = -7
COSE_ALG_EDDSA = -8
COSE_CRV_P256 = 1
COSE_CRV_ED25519 = 6

#The two algorithms a real authenticator will pick from, in the order
#``generate_registration_options`` now offers them (webauthn 3.0.0, ).
#EdDSA is first there, so it is first here.
EDDSA = "eddsa"
ES256 = "es256"
ALGORITHMS = (EDDSA, ES256)


def b64url(data: bytes) -> str:
    """base64url, unpadded -- the encoding WebAuthn uses on the wire."""
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "==")


class SoftAuthenticator:
    """One credential on one virtual authenticator.

    ``algorithm`` picks the key type. It defaults to ES256 so that every
    existing test keeps exercising the algorithm it was written for; the
    EdDSA arm is opted into per test (or parametrized over ``ALGORITHMS``),
    which is what makes a failure name the algorithm that broke.
    """

    def __init__(
        self,
        credential_id: bytes | None = None,
        *,
        algorithm: str = ES256,
    ):
        if algorithm not in ALGORITHMS:
            raise ValueError(f"unsupported algorithm: {algorithm!r}")
        self.algorithm = algorithm
        self.private_key = (
            ed25519.Ed25519PrivateKey.generate()
            if algorithm == EDDSA
            else ec.generate_private_key(ec.SECP256R1())
        )
        self.credential_id = credential_id or os.urandom(32)
        self.aaguid = b"\x00" * 16
        self.sign_count = 0

    # -- key material ----------------------------------------------------

    def _cose_public_key(self) -> bytes:
        if self.algorithm == EDDSA:
            # RFC 8152 §13.2: an Octet Key Pair. The public key is the raw
            # 32-byte Ed25519 point in `x`, and there is no `y` -- an OKP key
            # that carries one is malformed, not merely redundant.
            raw = self.private_key.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
            return cbor2.dumps(
                {
                    COSE_KTY: COSE_KTY_OKP,
                    COSE_ALG: COSE_ALG_EDDSA,
                    COSE_CRV: COSE_CRV_ED25519,
                    COSE_X: raw,
                },
                canonical=True,
            )
        numbers = self.private_key.public_key().public_numbers()
        return cbor2.dumps(
            {
                COSE_KTY: COSE_KTY_EC2,
                COSE_ALG: COSE_ALG_ES256,
                COSE_CRV: COSE_CRV_P256,
                COSE_X: numbers.x.to_bytes(32, "big"),
                COSE_Y: numbers.y.to_bytes(32, "big"),
            },
            canonical=True,
        )

    def _sign(self, payload: bytes) -> bytes:
        """Ed25519 takes no hash argument; ECDSA takes SHA-256.

        Ed25519 hashes internally (RFC 8032), so passing a digest algorithm is
        not merely unnecessary -- ``cryptography`` refuses it.
        """
        if self.algorithm == EDDSA:
            return self.private_key.sign(payload)
        return self.private_key.sign(payload, ec.ECDSA(hashes.SHA256()))

    # -- authenticator data ----------------------------------------------

    def _authenticator_data(self, rp_id: str, *, attested: bool) -> bytes:
        flags = FLAG_USER_PRESENT | FLAG_USER_VERIFIED
        if attested:
            flags |= FLAG_ATTESTED_CREDENTIAL_DATA
        data = (
            hashlib.sha256(rp_id.encode("utf-8")).digest()
            + struct.pack("!B", flags)
            + struct.pack("!I", self.sign_count)
        )
        if attested:
            cose_key = self._cose_public_key()
            data += (
                self.aaguid
                + struct.pack("!H", len(self.credential_id))
                + self.credential_id
                + cose_key
            )
        return data

    @staticmethod
    def _client_data(kind: str, challenge_b64url: str, origin: str) -> bytes:
        return json.dumps(
            {
                "type": kind,
                "challenge": challenge_b64url,
                "origin": origin,
                "crossOrigin": False,
            },
            separators=(",", ":"),
        ).encode("utf-8")

    # -- ceremonies ------------------------------------------------------

    def register(self, *, rp_id: str, origin: str, challenge_b64url: str) -> dict:
        """Produce what ``navigator.credentials.create()`` would return.

        ``rp_id`` is what the *authenticator* hashes into authenticatorData.
        Passing an rp_id different from the server's configured one is exactly
        how the tests simulate a browser on a different domain.
        """
        client_data = self._client_data(
            "webauthn.create", challenge_b64url, origin)
        auth_data = self._authenticator_data(rp_id, attested=True)
        attestation_object = cbor2.dumps(
            {"fmt": "none", "attStmt": {}, "authData": auth_data},
            canonical=True,
        )
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": b64url(client_data),
                "attestationObject": b64url(attestation_object),
                "transports": ["internal"],
            },
        }

    def authenticate(self, *, rp_id: str, origin: str, challenge_b64url: str) -> dict:
        """Produce what ``navigator.credentials.get()`` would return."""
        client_data = self._client_data(
            "webauthn.get", challenge_b64url, origin)
        auth_data = self._authenticator_data(rp_id, attested=False)
        signature = self._sign(
            auth_data + hashlib.sha256(client_data).digest()
        )
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "authenticatorAttachment": "platform",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": b64url(client_data),
                "authenticatorData": b64url(auth_data),
                "signature": b64url(signature),
                "userHandle": None,
            },
        }
