"""More conformance vectors, produced by ``rs/crates/f2z-authority`` itself.

``test_conformance_vectors.py`` pins one assertion that was cross-checked
against the crate on its feature branch. This file pins vectors the crate
**emitted** on ``free2z/zuu`` ``main`` (crate last changed in ``ee38b5bf``),
chosen to reach what that one does not: ``intent = reset``, the largest
``account_epoch`` the log admits, a 30-byte handle with digits and ``_``, a
1-byte handle, the full 15-minute validity window, and ``issued_ms = 0``.

How the hex below was produced (Ed25519 is deterministic, so the signatures
are reproducible too)::

    cd zuu/rs && cargo build -p f2z-authority --bins
    printf %s a7a7...a7 > authority.key            # 32 x 0xa7
    f2z-assert authority --key authority.key
    f2z-assert issue --key authority.key --log-id 4041...5f \
        --handle 0123456789_abcdefghijklmnopqrs --identity-pk <pk of 32 x 0x17> \
        --intent reset --account-epoch 1048575 --issued-ms 1789000000123 \
        --validity-ms 900000 --nonce f0f1...ff
    f2z-assert issue --key authority.key --log-id 4041...5f --handle z \
        --identity-pk <same> --intent bind --account-epoch 0 \
        --issued-ms 0 --expires-ms 1 --nonce 00...00

and ``f2z-assert`` refused ``--account-epoch 1048576`` ("a clock, not a
counter"), which the last test here pins on the Python side.

Also here: the crate's two independently derived hash vectors
(``types.rs::authority_id_matches_the_independent_nonuniform_digest_vector`` and
``assertion.rs::assertion_digest_matches_the_independent_nonuniform_canonical_vector``),
which pin ``H(label, x) = BLAKE2b-256(label || x)`` without going through
either implementation's encoder.
"""

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from dj.apps.ktauth import signing

AUTHORITY_SEED = bytes([0xA7] * 32)
AUTHORITY_PK_HEX = (
    "c9571eeb4aa9de1159858bc6a3d4a626c4f4845e8eebd5f554b2ec0f50c68860"
)
AUTHORITY_ID_HEX = (
    "c15a86c5aa5f0bec271d5672a1793982b83e23ac7825817580c750f17457e53e"
)
LOG_ID = bytes(range(0x40, 0x60))
IDENTITY_PK = (
    Ed25519PrivateKey.from_private_bytes(bytes([0x17] * 32))
    .public_key()
    .public_bytes(Encoding.Raw, PublicFormat.Raw)
)

VECTORS = {
    "reset-max-epoch-30-byte-handle": dict(
        handle=b"0123456789_abcdefghijklmnopqrs",
        intent=signing.INTENT_RESET,
        account_epoch=1_048_575,
        issued_ms=1_789_000_000_123,
        ttl_ms=900_000,
        nonce=bytes(range(0xF0, 0x100)),
        hex=(
            "1d66726565327a2f6b742f76312f68616e646c652d617373657274696f6e"
            "c15a86c5aa5f0bec271d5672a1793982b83e23ac7825817580c750f17457e53e"
            "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
            "1e303132333435363738395f6162636465666768696a6b6c6d6e6f70717273"
            "4db908f7c82666ab5c2ffa4987d154b01aff447c3cf3cd938755397e17de8ec2"
            "31debe55d37c722768b137131caa6087080b2e0b60b94bd785d14575cfa498bc"
            "02"
            "000fffff"
            "000001a088b5a27b"
            "000001a088c35e1b"
            "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"
            "d739ed1d45d64bee12cd46dd01abb041ff9c91d48ec14fd579c60ffbe8dc3f47"
            "34ab03773f216067d0a264143ca7c037d33bb706df2ba5e0e4d4641fa87e3905"
        ),
    ),
    "bind-one-byte-handle-epoch-zero": dict(
        handle=b"z",
        intent=signing.INTENT_BIND,
        account_epoch=0,
        issued_ms=0,
        ttl_ms=1,
        nonce=bytes(16),
        hex=(
            "1d66726565327a2f6b742f76312f68616e646c652d617373657274696f6e"
            "c15a86c5aa5f0bec271d5672a1793982b83e23ac7825817580c750f17457e53e"
            "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
            "017a"
            "7c21c8c2d01da76de0ed11d0baad3c154c3019924235c00861a7fa91448a53d6"
            "31debe55d37c722768b137131caa6087080b2e0b60b94bd785d14575cfa498bc"
            "01"
            "00000000"
            "0000000000000000"
            "0000000000000001"
            "00000000000000000000000000000000"
            "0c7b587ce49de7c29563e7bc9e147f4bf727230ba9dcb09bb0e87d00aa602b21"
            "93e37de87a908721922da44c5a3f178a53f80d8727dea7c83fac1756738f8204"
        ),
    ),
}


@pytest.fixture
def crate_authority(settings):
    installed = signing.install(Ed25519PrivateKey.from_private_bytes(AUTHORITY_SEED))
    settings.KT_LOG_ID_HEX = LOG_ID.hex()
    yield installed
    signing.reset()


def test_the_authority_key_derives_what_f2z_assert_printed(crate_authority):
    assert crate_authority.public_key.hex() == AUTHORITY_PK_HEX
    assert crate_authority.authority_id.hex() == AUTHORITY_ID_HEX


@pytest.mark.parametrize("name", sorted(VECTORS))
def test_django_emits_the_bytes_the_crate_emitted(name, crate_authority, settings):
    vector = VECTORS[name]
    settings.KT_ASSERTION_TTL_MS = vector["ttl_ms"]
    issued = signing.issue(
        handle=vector["handle"],
        identity_pk=IDENTITY_PK,
        intent=vector["intent"],
        account_epoch=vector["account_epoch"],
        now_ms=vector["issued_ms"],
        nonce=vector["nonce"],
    )
    assert issued["assertion"].hex() == vector["hex"]


def test_the_epoch_the_crate_refuses_is_refused_here_too(crate_authority):
    with pytest.raises(ValueError, match="not a counter"):
        signing.issue(
            handle=b"z",
            identity_pk=IDENTITY_PK,
            intent=signing.INTENT_RESET,
            account_epoch=1_048_576,
            now_ms=0,
            nonce=bytes(16),
        )


def test_authority_id_matches_the_crates_independent_digest_vector():
    assert signing.authority_id(bytes(range(32))).hex() == (
        "6a83fd51bb57de5cef247177dfb56336fcc72a1e7c822ad8c92ff476f133adb2"
    )


def test_the_hash_construction_matches_the_crates_assertion_digest_vector():
    """``H("free2z/kt/v1/assertion-digest", tls_codec(HandleAssertion))``.

    The 265 bytes are the crate's literal; the struct they encode carries an
    epoch above the ceiling, so it is fed to the hash directly rather than
    rebuilt through ``encode_assertion_tbs`` (which rightly refuses it).
    """
    canonical = b"".join(
        (
            b"\x1dfree2z/kt/v1/handle-assertion",
            bytes(range(0x00, 0x20)),
            bytes(range(0x20, 0x40)),
            b"\x05a1_b2",
            bytes(range(0x40, 0x60)),
            bytes(range(0x60, 0x80)),
            bytes.fromhex("02" "01234567" "0102030405060708" "1112131415161718"),
            bytes(range(0x80, 0x90)),
            bytes(range(0x90, 0xD0)),
        )
    )
    assert len(canonical) == 265
    assert b"free2z/kt/v1/assertion-digest" in signing.KT_LABELS
    assert signing.kt_hash(b"free2z/kt/v1/assertion-digest", canonical).hex() == (
        "1e3f8c549c816abd450ae79abbac86cca7da04d93e47891ec86a5c1e1ec10067"
    )
