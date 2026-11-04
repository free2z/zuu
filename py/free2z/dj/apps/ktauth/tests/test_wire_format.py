"""The encoding rules, attacked one at a time.

``test_conformance_vectors.py`` proves the bytes agree with the Rust verifier
for *one* assertion. This file covers the rules that vector cannot exercise: the
domain-separation property the whole hash construction rests on, the boundaries
of every field, and the two decoders on the request path.
"""

import pytest

from dj.apps.ktauth import signing


# ----------------------------------------------------------- domain separation


def test_no_label_is_a_prefix_of_another_anywhere_in_the_namespace():
    """``H(label, x) = BLAKE2b-256(label || x)`` has no separator.

    ``KT.md`` §1.3 fixes the construction with no separator and no terminator,
    which is unambiguous only while no label is a prefix of another — a property
    of the *set*, so it has to be asserted rather than assumed. The range covers
    the labels ``KT.md`` v1 already spends as well as ours, because a label here
    that shadows one there is the same bug in a different file.
    """
    every = list(signing.LABELS) + list(signing.KT_LABELS)
    for i, first in enumerate(every):
        for j, second in enumerate(every):
            if i == j:
                continue
            assert not second.startswith(first), (
                f"{first!r} is a prefix of {second!r}"
            )


def test_every_label_is_in_the_kt_v1_namespace():
    for label in signing.LABELS:
        assert label.startswith(b"free2z/kt/v1/")


def test_the_signing_prefix_is_the_length_prefixed_label_field():
    """The label is the first *field*, so it is the first bytes signed."""
    tbs = signing.encode_assertion_tbs(
        authority_pk=bytes(32),
        log_id=bytes(32),
        handle=b"a",
        identity_pk=bytes(32),
        intent=signing.INTENT_BIND,
        account_epoch=0,
        issued_ms=0,
        expires_ms=1,
        nonce=bytes(16),
    )
    expected = (
        bytes((len(signing.LABEL_ASSERTION_TBS),)) + signing.LABEL_ASSERTION_TBS
    )
    assert tbs.startswith(expected)


def test_the_hash_is_blake2b_256_over_label_then_data():
    import hashlib

    expected = hashlib.blake2b(b"labelpayload", digest_size=32).digest()
    assert signing.kt_hash(b"label", b"payload") == expected
    assert len(signing.kt_hash(b"x", b"y")) == 32


def test_the_ids_are_derived_from_what_they_name():
    """A key id that is derived cannot disagree with the key it names."""
    assert signing.handle_id(b"alice") == signing.kt_hash(
        signing.LABEL_HANDLE_ID, b"alice"
    )
    assert signing.authority_id(bytes(32)) == signing.kt_hash(
        signing.LABEL_AUTHORITY_ID, bytes(32)
    )
    assert signing.handle_id(b"alice") != signing.handle_id(b"alicf")


# ------------------------------------------------------------------ the handle


@pytest.mark.parametrize(
    "handle",
    [b"a", b"alice", b"a_1", b"0", b"_", b"a" * 30, b"0123456789_abcdefghij"],
)
def test_handles_inside_the_charset_are_accepted(handle):
    assert signing.HANDLE_RE.match(handle)


@pytest.mark.parametrize(
    "handle",
    [
        b"",  # empty
        b"a" * 31,  # too long
        b"Alice",  # uppercase is refused, never folded
        b"al.ice",
        b"al-ice",
        b"al ice",
        b"al\nice",
        "alicé".encode("utf-8"),
        b"alice\n",  # a trailing newline: `$` would allow it, `\Z` does not
    ],
)
def test_handles_outside_the_charset_are_refused(handle):
    assert not signing.HANDLE_RE.match(handle)


def test_the_charset_is_exactly_a_to_z_zero_to_nine_and_underscore():
    for byte in range(256):
        expected = (
            97 <= byte <= 122 or 48 <= byte <= 57 or byte == 95
        )
        assert bool(signing.HANDLE_RE.match(bytes((byte,)))) is expected, (
            f"byte {byte:#04x} disagreed with the charset"
        )


# ---------------------------------------------------------------- base64url io


def test_unpadded_base64url_round_trips():
    raw = bytes(range(32))
    encoded = signing.b64u_encode(raw)
    assert "=" not in encoded
    assert signing.b64u_decode_fixed(encoded, 32) == raw


def test_padding_is_optional_but_the_alphabet_is_not():
    raw = bytes(range(32))
    unpadded = signing.b64u_encode(raw)
    assert signing.b64u_decode_fixed(unpadded + "=", 32) == raw

    import base64

    standard = base64.b64encode(bytes([0xFB] * 32)).decode()
    assert "+" in standard or "/" in standard
    with pytest.raises(ValueError):
        signing.b64u_decode_fixed(standard, 32)


@pytest.mark.parametrize(
    "text",
    ["", "   ", "AAAA\n", "AAAA AAAA", "!!!!", "A" * 43 + "==="],
)
def test_malformed_base64url_is_refused(text):
    with pytest.raises(ValueError):
        signing.b64u_decode_fixed(text, 32)


def test_a_wrong_length_key_is_refused_even_though_it_decodes():
    short = signing.b64u_encode(bytes(31))
    with pytest.raises(ValueError):
        signing.b64u_decode_fixed(short, 32)


def test_an_identity_key_must_decode_as_ed25519():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
    )
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        PublicFormat,
    )

    good = (
        Ed25519PrivateKey.generate()
        .public_key()
        .public_bytes(Encoding.Raw, PublicFormat.Raw)
    )
    signing.check_identity_key(good)

    with pytest.raises(ValueError):
        signing.check_identity_key(bytes(31))


# ------------------------------------------------------------ field boundaries


def _tbs(**overrides):
    kwargs = dict(
        authority_pk=bytes(32),
        log_id=bytes(32),
        handle=b"alice",
        identity_pk=bytes(32),
        intent=signing.INTENT_BIND,
        account_epoch=0,
        issued_ms=0,
        expires_ms=1,
        nonce=bytes(16),
    )
    kwargs.update(overrides)
    return signing.encode_assertion_tbs(**kwargs)


@pytest.mark.parametrize(
    "overrides",
    [
        {"log_id": bytes(31)},
        {"identity_pk": bytes(33)},
        {"authority_pk": b""},
        {"nonce": bytes(15)},
        {"handle": b"Alice"},
        {"handle": b""},
        {"intent": 0},
        {"intent": 3},
        {"account_epoch": -1},
        {"account_epoch": 2 ** 32},
        # KT.md 4.5.4 A18a bounds this far below the uint32 the field is
        #the ceiling, and a Unix-seconds value, are both refused
        # where the bytes are built rather than only at the log.
        {"account_epoch": signing.ACCOUNT_EPOCH_CEILING},
        {"account_epoch": 1_787_529_600},
        {"issued_ms": 2 ** 64},
        {"expires_ms": -1},
    ],
)
def test_an_out_of_range_field_never_reaches_the_wire(overrides):
    """Refused at encode time, so a malformed assertion is never signed."""
    with pytest.raises(ValueError):
        _tbs(**overrides)


def test_the_encoding_is_fixed_width_apart_from_the_two_opaque_vectors():
    """29-byte label + 5-byte handle + the fixed fields = 201 bytes."""
    assert len(_tbs()) == 1 + 29 + 32 + 32 + 1 + 5 + 32 + 32 + 1 + 4 + 8 + 8 + 16
    assert len(_tbs(handle=b"a" * 30)) == len(_tbs()) + 25


def test_integers_are_unsigned_and_big_endian():
    tbs = _tbs(account_epoch=1, issued_ms=1, expires_ms=2)
    tail = tbs[-(16 + 8 + 8 + 4):]
    assert tail[:4] == b"\x00\x00\x00\x01"
    assert tail[4:12] == b"\x00" * 7 + b"\x01"
    assert tail[12:20] == b"\x00" * 7 + b"\x02"


def test_changing_any_field_changes_the_bytes():
    """No two distinct assertions encode the same, which is what makes the
    signature a statement about *this* claim rather than a shape."""
    baseline = _tbs()
    for overrides in (
        {"log_id": bytes([1]) + bytes(31)},
        {"identity_pk": bytes([1]) + bytes(31)},
        {"authority_pk": bytes([1]) + bytes(31)},
        {"handle": b"alicf"},
        {"intent": signing.INTENT_RESET},
        {"account_epoch": 1},
        {"issued_ms": 1},
        {"expires_ms": 2},
        {"nonce": bytes([1]) + bytes(15)},
    ):
        assert _tbs(**overrides) != baseline, overrides


# ---------------------------------------------------------------- policy knobs


def test_the_ttl_is_clamped_to_the_verifiers_own_cap(settings):
    settings.KT_ASSERTION_TTL_MS = signing.MAX_VALIDITY_MS * 10
    assert signing.ttl_ms() == signing.MAX_VALIDITY_MS


@pytest.mark.parametrize("value", [0, -1, "nonsense", None])
def test_a_nonsense_ttl_falls_back_to_the_default(settings, value):
    settings.KT_ASSERTION_TTL_MS = value
    assert signing.ttl_ms() == signing.DEFAULT_TTL_MS


def test_a_reasonable_ttl_is_used_as_configured(settings):
    settings.KT_ASSERTION_TTL_MS = 60_000
    assert signing.ttl_ms() == 60_000


@pytest.mark.parametrize("value", ["", "not hex", "ab", "00" * 31, "00" * 33])
def test_a_missing_or_malformed_log_id_refuses_to_issue(settings, value):
    settings.KT_LOG_ID_HEX = value
    with pytest.raises(signing.AuthorityUnavailable) as excinfo:
        signing.log_id()
    assert excinfo.value.reason == signing.REASON_LOG_UNCONFIGURED


def test_a_configured_log_id_is_the_32_bytes_it_spells(settings):
    settings.KT_LOG_ID_HEX = "aa" * 32
    assert signing.log_id() == bytes([0xAA] * 32)


def test_the_default_ttl_is_inside_the_cap_the_log_enforces():
    assert signing.DEFAULT_TTL_MS <= signing.MAX_VALIDITY_MS
