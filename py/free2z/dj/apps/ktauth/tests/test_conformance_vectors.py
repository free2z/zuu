"""The conformance vector: Django's bytes, as accepted by the Rust verifier.

The hex below is **not a Python expectation**. It is the output of
``dj.apps.ktauth.signing.issue`` for the fixed inputs in this module, and it was
fed back through ``rs/crates/f2z-authority`` on the ``feature/kt-authority``
branch of ``free2z/zuu`` — the authoritative implementation of the wire format —
where three things were asserted:

1. ``HandleAssertionTBS::new(...).sign(...).encode_canonical()`` for the same
   inputs produced **exactly these bytes**. The two encoders agree, field for
   field, with no interpretation in between.
2. ``decode_canonical::<HandleAssertion>`` accepted them and re-encoded them
   identically (``WIRE.md`` §3.3's re-encode equality), and
   ``AuthorityConfig::admit`` — the crate's *only* verification path, which has
   no route that checks an authority signature without also checking the
   identity binding — returned ``Vouch::By(authority_id)`` with the handle,
   identity key, intent and account epoch this endpoint signed.
3. The validity window is inside ``DEFAULT_MAX_VALIDITY_MS``, the cap the log
   enforces independently of the issuer.

**Where that ran, and where it does not.** The Rust crate lives in a different
repository, and nothing in this repository's CI compiles Rust, so step 1–3 were
run **locally** against a checkout of ``origin/feature/kt-authority``
(``cargo test -p f2z-authority``), not in the ``gate`` job. The PR body records
the command and the output. What CI *does* enforce is this file: if the Python
encoder drifts by a single byte — a field reordered, a length prefix dropped, an
integer endianness flipped, a label edited — the vector below stops matching and
the gate goes red. That is the half of the guarantee this repository can hold on
its own, and it is the half that catches a regression here. Re-run the Rust side
whenever the crate changes, or when this vector is deliberately regenerated.

Regenerating it is a decision, not a fix. These bytes are a claim about
interoperability with another implementation; if a change here makes them
change, the other implementation has to agree before the constant does.

**And it is an activation gate, not just a test.** What CI cannot notice is the
*other* side moving: if the proposal changes before this endpoint is enabled in
a manifest, this repository stays green while Django emits assertions the
deployed log refuses, which is every enrollment and every reset failing at once.
So enabling the endpoint requires two things that are not checks in this
repository — zuu#594 ratified, and a fresh cross-repository conformance run
against the crate as merged — and whoever writes that manifest owns both.
"""

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from dj.apps.ktauth import signing

from .conftest import AUTHORITY_SEED, IDENTITY_SEED, LOG_ID, identity_public_bytes

#: Fixed so the vector is reproducible. 2023-11-14T22:13:20Z.
ISSUED_MS = 1_700_000_000_000
TTL_MS = 300_000
EXPIRES_MS = ISSUED_MS + TTL_MS
NONCE = bytes([0x55] * 16)
ACCOUNT_EPOCH = 7
HANDLE = b"alice"

#: ``tls_codec(HandleAssertion)``. Verified by ``f2z-authority`` — see above.
#: Split one field per line, in wire order, so a diff names the field that
#: moved instead of showing one 530-character string against another.
VECTOR_HEX = (
    # opaque label<0..255>  -- "free2z/kt/v1/handle-assertion"
    "1d66726565327a2f6b742f76312f68616e646c652d617373657274696f6e"
    # authority_id[32]
    "cce6793eba2365b6641231ad67a2d4e4faaaa6589329eadcf4de09016c377fd6"
    # log_id[32]
    "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a"
    # opaque handle<1..30>  -- "alice"
    "05616c696365"
    # handle_id[32]
    "194e81fdc9fbd8807a2c301e22c4bc3a3337dfa28918ffb7e135c594e82c748b"
    # identity_pk[32]
    "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12"
    # uint8 intent -- bind(1)
    "01"
    # uint32 account_epoch
    "00000007"
    # uint64 issued_ms
    "0000018bcfe56800"
    # uint64 expires_ms
    "0000018bcfe9fbe0"
    # nonce[16]
    "55555555555555555555555555555555"
    # signature[64] -- Ed25519 over everything above
    "d1aeaffac278b49ee74bc7801ee11edee99e780adba80d5e6ba68edb2a7f32a0"
    "0c2e37e1cc6b828e2913212b82c0825821d44065af32eda7019f5ce42c123c06"
)


@pytest.fixture
def issued(authority, kt_settings):
    kt_settings.KT_ASSERTION_TTL_MS = TTL_MS
    return signing.issue(
        handle=HANDLE,
        identity_pk=identity_public_bytes(),
        intent=signing.INTENT_BIND,
        now_ms=ISSUED_MS,
        nonce=NONCE,
        account_epoch=ACCOUNT_EPOCH,
    )


def test_the_bytes_are_exactly_the_vector_the_rust_verifier_accepted(issued):
    """One assertion, and it is the whole point of this module."""
    assert issued["assertion"].hex() == VECTOR_HEX
    assert issued["issued_ms"] == ISSUED_MS
    assert issued["expires_ms"] == EXPIRES_MS


def test_the_vector_decomposes_into_the_fields_kt_md_specifies(issued):
    """Read the vector back by hand, so a drift says *which* field moved.

    Deliberately parsed here with slicing and ``int.from_bytes`` rather than by
    calling the encoder: a test that re-uses the code under test to describe
    what the code under test produced proves only that it is deterministic.
    """
    raw = issued["assertion"]
    cursor = 0

    label_len = raw[cursor]
    cursor += 1
    assert raw[cursor:cursor + label_len] == signing.LABEL_ASSERTION_TBS
    cursor += label_len

    authority_pk = (
        Ed25519PrivateKey.from_private_bytes(AUTHORITY_SEED)
        .public_key()
        .public_bytes(Encoding.Raw, PublicFormat.Raw)
    )
    assert raw[cursor:cursor + 32] == signing.kt_hash(
        signing.LABEL_AUTHORITY_ID, authority_pk
    )
    cursor += 32

    assert raw[cursor:cursor + 32] == LOG_ID
    cursor += 32

    handle_len = raw[cursor]
    cursor += 1
    assert raw[cursor:cursor + handle_len] == HANDLE
    cursor += handle_len

    assert raw[cursor:cursor + 32] == signing.kt_hash(
        signing.LABEL_HANDLE_ID, HANDLE
    )
    cursor += 32

    identity_pk = raw[cursor:cursor + 32]
    cursor += 32
    assert identity_pk == identity_public_bytes()

    assert raw[cursor] == signing.INTENT_BIND
    cursor += 1

    assert int.from_bytes(raw[cursor:cursor + 4], "big") == ACCOUNT_EPOCH
    cursor += 4
    assert int.from_bytes(raw[cursor:cursor + 8], "big") == ISSUED_MS
    cursor += 8
    assert int.from_bytes(raw[cursor:cursor + 8], "big") == EXPIRES_MS
    cursor += 8

    assert raw[cursor:cursor + 16] == NONCE
    cursor += 16

    signature = raw[cursor:]
    assert len(signature) == 64
    assert cursor + 64 == len(raw), "no slack after the signature"


def test_the_signature_verifies_under_the_authority_key(issued, authority):
    """Ed25519 over ``tls_codec(HandleAssertionTBS)``, and over nothing else."""
    raw = issued["assertion"]
    tbs, signature = raw[:-64], raw[-64:]

    public_key = Ed25519PublicKey.from_public_bytes(authority.public_key)
    public_key.verify(signature, tbs)

    with pytest.raises(Exception):
        public_key.verify(signature, tbs + b"\x00")


def test_the_identity_key_seed_is_the_one_the_rust_harness_used():
    """Guards the vector against a fixture edit that silently invalidates it."""
    assert IDENTITY_SEED == bytes([0x42] * 32)
    assert AUTHORITY_SEED == bytes(range(32))
    assert LOG_ID == bytes([0x9A] * 32)
