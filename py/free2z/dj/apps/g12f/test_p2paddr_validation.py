"""The payout address is money routing — the API must not accept a poisoned one.

The bug this guards against is not obvious garbage. It is a paste out of a chat
client or webmail that carries a ZERO-WIDTH character: invisible in every UI, so
the stored address *looks* correct while routing earnings to an address the
creator does not control. There is no chargeback.

The new UI strips these before sending, but the API also serves the classic UI,
ZUULI, and anyone with a token, so the server-side validator is the real net.
"""

import pytest
from django.core.exceptions import ValidationError
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator, zPage
from dj.apps.g12f.validators import (
    BECH32M_CONST,
    BECH32_CONST,
    BECH32_CHARSET,
    _bech32_checksum,
    _bech32_hrp_expand,
    _bech32_payload,
    _bech32_polymod,
    validate_zcash_address,
)


def _bech32_encode(hrp, data_chars, constant):
    """Build a checksum-valid bech32/bech32m string under an arbitrary HRP."""
    data = [BECH32_CHARSET.index(char) for char in data_chars]
    values = _bech32_hrp_expand(hrp) + data + [0, 0, 0, 0, 0, 0]
    polymod = _bech32_polymod(values) ^ constant
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(BECH32_CHARSET[d] for d in data + checksum)

# CHECKSUM-VALID addresses, not merely real-shaped. A fixture that only looks
# like an address would let a broken checksum check pass unnoticed — which is
# exactly the hole a shape-only validator leaves.
#
# The Unified and Sapling addresses below are the ones documented in
# dj/apps/g12f/models/creator.py; the transparent ones are constructed with the
# real Zcash mainnet version bytes (t1 = 0x1CB8, t3 = 0x1CBD) and a correct
# double-SHA256 checksum.
UADDR = (
    "u1fugcwe8xceuyvp7t8m3rpk22e0u8m3dyzdh9hdv40zsqpyvac7lxkx5t49nmp4p4w793"
    "ngh7fdc0zg7ws7w6gfdcx2rjthss0vhfdwrh"
)
ZSADDR = (
    "zs12f4y80pjhy042rmxq339dr6885jqqvh9fc6j8pvxg3hyhc8hmsqurlkqtkzwp03quca27pt0f7k"
)
# Chosen so its base58 body contains a "1": base58 includes that character
# while bech32's data charset does not, so this is the fixture that proves a
# t-address is not mis-parsed as bech32 at the separator.
TADDR = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"
T3ADDR = "t3Wjj8bULpUe5WrW2no2oJm7NPd4eXREeJt"

# The five JavaScript's \s does not match — the reason a whitespace-only strip
# was not enough — plus U+FEFF and a non-breaking space for good measure.
ZERO_WIDTH = [
    "​",  # ZERO WIDTH SPACE
    "‌",  # ZERO WIDTH NON-JOINER
    "‍",  # ZERO WIDTH JOINER
    "⁠",  # WORD JOINER
    "᠎",  # MONGOLIAN VOWEL SEPARATOR
    "﻿",  # ZERO WIDTH NO-BREAK SPACE
    " ",  # NO-BREAK SPACE
]


@pytest.mark.parametrize("address", [UADDR, ZSADDR, TADDR, T3ADDR])
def test_real_addresses_are_accepted(address):
    """Every encoding in use must still validate — a false reject blocks payouts."""
    validate_zcash_address(address)


def test_blank_is_allowed():
    """Clearing the address is how a creator opts out of a payout destination."""
    validate_zcash_address("")
    validate_zcash_address(None)


@pytest.mark.parametrize("char", ZERO_WIDTH)
def test_invisible_character_is_rejected(char):
    poisoned = UADDR[:50] + char + UADDR[50:]

    # The premise: it is indistinguishable from the real thing on screen.
    assert len(poisoned) == len(UADDR) + 1
    assert poisoned != UADDR

    with pytest.raises(ValidationError) as excinfo:
        validate_zcash_address(poisoned)
    assert excinfo.value.code == "invisible_character"
    # The error names the codepoint, since the user cannot see the character.
    assert f"U+{ord(char):04X}" in str(excinfo.value)


@pytest.mark.parametrize(
    "address",
    [
        UADDR[:50] + " " + UADDR[50:],
        UADDR + "\n",
        "\t" + UADDR,
        UADDR[:50] + "\r\n" + UADDR[50:],
    ],
)
def test_whitespace_is_rejected(address):
    with pytest.raises(ValidationError):
        validate_zcash_address(address)


@pytest.mark.parametrize(
    "address",
    [
        UADDR[:50] + "-" + UADDR[50:],
        UADDR[:50] + "." + UADDR[50:],
        "zcash:" + UADDR,
        UADDR + "?amount=1",
        # A Cyrillic 'а' that renders identically to ASCII 'a'.
        UADDR[:50] + "а" + UADDR[50:],
    ],
)
def test_non_alphanumeric_is_rejected(address):
    with pytest.raises(ValidationError):
        validate_zcash_address(address)


def test_truncated_paste_is_rejected():
    with pytest.raises(ValidationError) as excinfo:
        validate_zcash_address("u1abc")
    assert excinfo.value.code == "too_short"


@pytest.mark.django_db
def test_model_full_clean_rejects_a_poisoned_creator_address():
    creator = Creator.objects.create(username="zw-creator", email="zw@example.com")
    creator.p2paddr = UADDR[:50] + "​" + UADDR[50:]

    with pytest.raises(ValidationError) as excinfo:
        creator.full_clean()
    assert "p2paddr" in excinfo.value.message_dict


@pytest.mark.django_db
def test_api_rejects_a_poisoned_payout_address():
    """The serializer picks the validator up off the model field.

    This is the path that actually matters: PATCH /api/auth/user/ is what any
    client hits to change where the money goes.
    """
    creator = Creator.objects.create(username="zw-api", email="zw-api@example.com")
    creator.set_password("not-a-real-password")
    creator.save()

    client = APIClient()
    client.force_authenticate(user=creator)

    poisoned = UADDR[:50] + "​" + UADDR[50:]
    response = client.patch(
        "/api/auth/user/",
        {"p2paddr": poisoned},
        format="json",
    )

    assert response.status_code == 400, response.content
    assert "p2paddr" in response.json()

    creator.refresh_from_db()
    assert creator.p2paddr == ""


@pytest.mark.django_db
def test_api_accepts_a_clean_payout_address():
    """The guard must not block the thing it exists to protect."""
    creator = Creator.objects.create(username="zw-ok", email="zw-ok@example.com")
    creator.set_password("not-a-real-password")
    creator.save()

    client = APIClient()
    client.force_authenticate(user=creator)

    response = client.patch(
        "/api/auth/user/",
        {"p2paddr": UADDR},
        format="json",
    )

    assert response.status_code == 200, response.content
    creator.refresh_from_db()
    assert creator.p2paddr == UADDR


@pytest.mark.django_db
def test_zpage_override_address_is_validated_too():
    """The per-page override routes money exactly the same way."""
    creator = Creator.objects.create(username="zw-zpage", email="zw-zp@example.com")
    page = zPage(creator=creator, title="t", content="c")
    page.p2paddr = UADDR[:50] + "‍" + UADDR[50:]

    with pytest.raises(ValidationError) as excinfo:
        page.full_clean(exclude=["free2zaddr", "vanity"])
    assert "p2paddr" in excinfo.value.message_dict


@pytest.mark.parametrize(
    "address",
    [
        # One character transposed in each encoding. Right shape, right length,
        # right prefix — and the funds would be gone. Only the checksum sees it.
        UADDR[:-1] + ("w" if UADDR[-1] != "w" else "x"),
        ZSADDR[:-1] + ("w" if ZSADDR[-1] != "w" else "x"),
        TADDR[:-1] + ("s" if TADDR[-1] != "s" else "t"),
        T3ADDR[:-1] + ("s" if T3ADDR[-1] != "s" else "t"),
        # A plausible-looking string that was never an address at all.
        "u18vffksp4zjra0c8aqzyxvvhmxqmr2rk8j7x9m2q0lhq3wgs6tqk9v4zn7l3xd8fpq5j",
    ],
)
def test_corrupt_checksum_is_rejected(address):
    with pytest.raises(ValidationError) as excinfo:
        validate_zcash_address(address)
    assert excinfo.value.code == "bad_checksum"


def test_a_string_with_no_valid_checksum_is_rejected():
    """The hole a shape-only check leaves: plausible, alphanumeric, and junk."""
    for junk in [
        "znewformat9999abcdefghijklmnopqrstuvwxyz",
        "thequickbrownfoxjumpedoverthelazydog",
        "0" * 40,
    ]:
        with pytest.raises(ValidationError) as excinfo:
            validate_zcash_address(junk)
        assert excinfo.value.code == "unrecognized_format"


def test_a_mistyped_prefix_is_rejected():
    """"za1…" for "zs1…" is as invisible to a proof-reading creator as a
    transposed character in the body — and the bech32 checksum covers the HRP,
    so it is caught even though "za" is not a prefix we know."""
    mistyped = "za" + ZSADDR[2:]
    with pytest.raises(ValidationError):
        validate_zcash_address(mistyped)


def test_an_unknown_prefix_is_rejected_even_with_a_valid_checksum():
    """A valid checksum is not enough — this is an allowlist, on purpose.

    An earlier revision accepted an unknown prefix so long as the checksum was
    valid, for forward compatibility with address types newer than this code.
    That does not survive the cross-chain case below: the two failure modes are
    not symmetric. Failing closed on a new Zcash format costs a creator some
    annoyance; failing open on another chain's address destroys donors' funds.
    """
    future = _bech32_encode("znew", ZSADDR[3:-6], BECH32M_CONST)

    # It really is a well-formed bech32m string — the rejection is about the
    # unknown prefix, not a malformed checksum.
    assert _bech32_checksum(future)[1] == BECH32M_CONST

    with pytest.raises(ValidationError) as excinfo:
        validate_zcash_address(future)
    assert excinfo.value.code == "unrecognized_format"


@pytest.mark.parametrize(
    "address",
    [
        # Real, checksum-valid addresses for OTHER chains. Every one of these
        # would be an unspendable destination shown to donors as a Zcash
        # address, and the ZEC sent to it would be unrecoverable.
        "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",  # Bitcoin P2PKH (genesis)
        "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",  # Bitcoin P2SH
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",  # Bitcoin bech32
        "LQ3LGCPHwd4vMdMkkkPMWzcSLmMHPeVeyN",  # Litecoin
    ],
)
def test_an_address_from_another_chain_is_rejected(address):
    with pytest.raises(ValidationError):
        validate_zcash_address(address)


def test_a_foreign_base58_address_wearing_a_zcash_prefix_is_rejected():
    """Grafting "t1" onto a Bitcoin body breaks the checksum, which is the
    other half of the defence: the prefix allowlist and the checksum each
    catch what the other misses."""
    with pytest.raises(ValidationError) as excinfo:
        validate_zcash_address("t1" + "A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"[2:])
    assert excinfo.value.code in {"bad_checksum", "wrong_address_type"}


def test_a_transparent_address_containing_1_is_not_parsed_as_bech32():
    """base58 includes "1", so a t-address must not go down the bech32 path."""
    assert "1" in TADDR[2:]
    validate_zcash_address(TADDR)


def test_real_sapling_and_unified_payloads_decode_to_the_documented_sizes():
    """Pins the payload rule to reality, not to my reading of the spec.

    Sapling is an 11-byte diversifier plus a 32-byte pk_d. If this ever fails,
    the length table is wrong and valid addresses are being rejected — which is
    the failure this module works hardest to avoid.
    """
    assert len(_bech32_payload(ZSADDR)) == 43
    assert len(_bech32_payload(UADDR)) >= 48


def test_a_checksum_valid_address_with_the_wrong_payload_size_is_rejected():
    """The checksum cannot see this: it proves the characters are intact, not
    that there are the right number of them to be an address of this type."""
    # Re-checksum a truncated Sapling body, so the result is a perfectly valid
    # bech32 string under a known HRP that is simply not a usable address.
    truncated = _bech32_encode("zs", ZSADDR[3:-16], BECH32_CONST)
    assert _bech32_checksum(truncated)[1] == BECH32_CONST

    with pytest.raises(ValidationError) as excinfo:
        validate_zcash_address(truncated)
    assert excinfo.value.code == "bad_payload"
