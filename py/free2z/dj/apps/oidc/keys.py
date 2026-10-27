"""The signing key ring: ES256 for access tokens, RS256 for ID tokens.

Keys come from the environment as concatenated PEM blocks
(``OIDC_ES256_PRIVATE_KEYS``, ``OIDC_RS256_PRIVATE_KEYS``, owner-provisioned
through Secret Manager). The FIRST block is the active key; the rest are
retired keys that stay in the published JWKS so a resource server can still
verify a token minted just before a rotation (spec §6.1: at least 24 hours).
``manage.py oidc_rotate_keys`` produces a new block; nothing here ever writes
a key anywhere.

When neither variable is set, a per-process key pair is generated -- but
ONLY where ``settings.OIDC_ALLOW_GENERATED_KEYS`` says so (the base settings:
local dev and pytest). ``prod_settings`` sets it False, and
:func:`get_keyring` then raises :class:`SigningKeysUnavailable`, which
``dj.apps.oidc.checks`` turns into a red ``manage.py check``. A generated key
in production would mint tokens that no other pod, and no resource server,
could verify -- a silent 401 storm rather than an error, which is the class
of failure this refuses to be.

``kid`` is the RFC 7638 JWK thumbprint, the same convention
django-oauth-toolkit uses for the ID-token ``kid``, so the two headers are
computed by one rule.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import threading
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from jwcrypto import jwk

logger = logging.getLogger(__name__)

ALG_ES256 = "ES256"
ALG_RS256 = "RS256"

#: Env variable per algorithm, named here once so the check, the command and
#: the error messages agree.
ENV_VARS = {
    ALG_ES256: "OIDC_ES256_PRIVATE_KEYS",
    ALG_RS256: "OIDC_RS256_PRIVATE_KEYS",
}
_SETTING_NAMES = {
    ALG_ES256: "OIDC_ES256_PRIVATE_KEYS",
    ALG_RS256: "OIDC_RS256_PRIVATE_KEYS",
}

_PEM_BLOCK = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
    re.DOTALL,
)

RSA_MIN_BITS = 2048


class SigningKeysUnavailable(ImproperlyConfigured):
    """No usable signing key for an algorithm, and generation is not allowed."""


@dataclass(frozen=True)
class SigningKey:
    alg: str
    kid: str
    #: PKCS#8 PEM, bytes. Private material; never logged or serialized.
    private_pem: bytes
    public_pem: bytes
    #: The public JWK as published (``kty``, ``crv``/``n``..., ``kid``,
    #: ``alg``, ``use``).
    public_jwk: dict
    #: The jwcrypto key django-oauth-toolkit signs ID tokens with.
    jwk: jwk.JWK

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<SigningKey {self.alg} kid={self.kid}>"


@dataclass(frozen=True)
class KeyRing:
    es256: tuple[SigningKey, ...]
    rs256: tuple[SigningKey, ...]
    generated: bool

    @property
    def active_es256(self) -> SigningKey:
        return self.es256[0]

    @property
    def active_rs256(self) -> SigningKey:
        return self.rs256[0]

    def find(self, kid: str, alg: str) -> SigningKey | None:
        """The key with this ``kid`` for this ``alg``, active or retired.

        Selecting by ``kid`` and then insisting the ``alg`` matches the key
        type (spec §7) is what stops an RS256 ID token from being accepted
        where an ES256 access token is expected, whatever the header says.
        """
        for key in self.es256 if alg == ALG_ES256 else self.rs256:
            if key.kid == kid:
                return key
        return None

    def public_jwks(self) -> dict:
        """The JWKS document: active keys first, then retired ones."""
        return {"keys": [k.public_jwk for k in (*self.es256, *self.rs256)]}


def _pem_blocks(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    if "-----BEGIN" not in text:
        # A base64 wrapping of the PEM text is accepted for environments
        # whose secret store dislikes newlines. Anything else is a
        # misconfiguration, not a key.
        try:
            text = base64.b64decode(text, validate=True).decode("ascii")
        except (binascii.Error, UnicodeDecodeError):
            raise SigningKeysUnavailable(
                "the OIDC signing key setting holds neither PEM text nor "
                "base64-encoded PEM text"
            ) from None
    blocks = _PEM_BLOCK.findall(text)
    if not blocks:
        raise SigningKeysUnavailable(
            "the OIDC signing key setting is set but contains no PEM "
            "PRIVATE KEY block"
        )
    return blocks


def _load_private_key(pem: str, alg: str):
    try:
        key = serialization.load_pem_private_key(pem.encode(), password=None)
    except (ValueError, TypeError) as exc:
        raise SigningKeysUnavailable(f"unreadable {alg} PEM: {exc}") from None
    if alg == ALG_ES256:
        if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(
            key.curve, ec.SECP256R1
        ):
            raise SigningKeysUnavailable(
                "an ES256 key must be an EC private key on P-256 (secp256r1)"
            )
    elif alg == ALG_RS256:
        if not isinstance(key, rsa.RSAPrivateKey):
            raise SigningKeysUnavailable("an RS256 key must be an RSA private key")
        if key.key_size < RSA_MIN_BITS:
            raise SigningKeysUnavailable(
                f"an RS256 key must be at least {RSA_MIN_BITS} bits, "
                f"got {key.key_size}"
            )
    else:  # pragma: no cover - programming error
        raise ValueError(alg)
    return key


def signing_key_from_private(alg: str, private_key) -> SigningKey:
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    key = jwk.JWK.from_pem(private_pem)
    kid = key.thumbprint()
    public = {**json.loads(key.export_public()), "kid": kid, "alg": alg, "use": "sig"}
    return SigningKey(
        alg=alg,
        kid=kid,
        private_pem=private_pem,
        public_pem=public_pem,
        public_jwk=public,
        jwk=key,
    )


def generate_private_key(alg: str):
    """A fresh private key for ``alg``. Used by the rotation command and by
    the dev/test fallback; never called on a production request path."""
    if alg == ALG_ES256:
        return ec.generate_private_key(ec.SECP256R1())
    if alg == ALG_RS256:
        return rsa.generate_private_key(public_exponent=65537, key_size=RSA_MIN_BITS)
    raise ValueError(alg)


def private_key_to_pem(private_key) -> str:
    return private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _configured_keys(alg: str) -> tuple[SigningKey, ...]:
    text = getattr(settings, _SETTING_NAMES[alg], "") or ""
    return tuple(
        signing_key_from_private(alg, _load_private_key(block, alg))
        for block in _pem_blocks(text)
    )


_lock = threading.Lock()
_ring: KeyRing | None = None


def load_keyring() -> KeyRing:
    """Build the ring from settings, uncached. Raises SigningKeysUnavailable."""
    es256 = _configured_keys(ALG_ES256)
    rs256 = _configured_keys(ALG_RS256)
    generated = False
    missing = [alg for alg, keys in ((ALG_ES256, es256), (ALG_RS256, rs256)) if not keys]
    if missing:
        if not getattr(settings, "OIDC_ALLOW_GENERATED_KEYS", False):
            raise SigningKeysUnavailable(
                "no OIDC signing key configured for "
                + ", ".join(missing)
                + " and this deployment does not allow generated keys. Set "
                + " and ".join(ENV_VARS[alg] for alg in missing)
                + " (PEM; `manage.py oidc_rotate_keys` prints a new block)."
            )
        generated = True
        # Only algorithm NAMES reach the log line; nothing derived from key
        # material does (dj/apps/test_credential_logging_guard.py).
        generated_algs = []
        if not es256:
            es256 = (signing_key_from_private(ALG_ES256, generate_private_key(ALG_ES256)),)
            generated_algs.append(ALG_ES256)
        if not rs256:
            rs256 = (signing_key_from_private(ALG_RS256, generate_private_key(ALG_RS256)),)
            generated_algs.append(ALG_RS256)
        logger.warning(
            "oidc: generating per-process %s signing key(s); tokens minted "
            "here verify only in this process. Fine for dev and tests, never "
            "for a deployment.",
            ", ".join(generated_algs),
        )
    return KeyRing(es256=es256, rs256=rs256, generated=generated)


def get_keyring() -> KeyRing:
    """The process-wide ring, loaded on first use.

    A failure is NOT remembered: the next call retries, so a settings
    override in a test (or a corrected env in a restarted pod) takes effect
    without a reset. Loading is cheap (a PEM parse); generation is not, and
    generation happens once because a success is cached.
    """
    global _ring
    ring = _ring
    if ring is not None:
        return ring
    with _lock:
        if _ring is None:
            _ring = load_keyring()
        return _ring


def install(ring: KeyRing) -> None:
    """Install a ring directly. For tests."""
    global _ring
    with _lock:
        _ring = ring


def reset() -> None:
    """Forget the cached ring. For tests and for ``setting_changed``."""
    global _ring
    with _lock:
        _ring = None
