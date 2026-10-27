"""Validation for Zcash payout addresses.

A payout address is money routing. If a wrong one is stored the creator's
earnings go to somewhere they do not control, and there is no chargeback.

The new UI strips anything that cannot be part of an address before it sends,
but client-side stripping is not a guarantee: this API also serves the classic
UI, ZUULI, and anyone holding a token, and until now there was no validator on
``p2paddr`` at all. This is the actual safety net.

Two classes of bad input, and they need different defences:

1. **Invisible characters.** A paste out of a chat client, webmail or a PDF
   carries a ZERO-WIDTH character (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ,
   U+2060 word joiner, U+180E). These render as nothing, so a poisoned address
   *looks* exactly right while being wrong. A shape check catches these:
   every Zcash address encoding in use is plain alphanumeric ASCII.

2. **A corrupt or mistyped address that is still the right shape.** A shape
   check cannot see this, so the encoding's own checksum is verified —
   bech32/bech32m for ``zs1…``/``u1…``/``tex1…`` and base58check for
   ``t1…``/``t3…``/``zc…``. A single transposed character fails the checksum,
   which is exactly the failure mode a creator cannot catch by eye.

**This is an allowlist: a known Zcash prefix AND a valid checksum.** Both
halves are load-bearing, and the second without the first is not enough.

An earlier revision accepted any string with a valid checksum under an
unrecognized prefix, on a forward-compatibility argument — Zcash gains address
types over time, and blocking a creator from setting a brand-new one is a real
cost. That argument does not survive the cross-chain case: a Bitcoin address is
a perfectly valid base58check string, and ``bc1…`` is perfectly valid bech32.
Accepting one would put an unspendable destination in front of donors, and the
ZEC they send to it is gone. The two failure modes are not symmetric —

* fail closed on a new Zcash format: the creator keeps using their existing
  address until we add a two-line entry below. Annoying, reversible.
* fail open on a foreign chain's address: donors' funds are destroyed.
  Silent, unrecoverable.

so this fails closed. When Zcash ships a new address type, add its HRP or its
version bytes to the tables below.

**Not checked, deliberately: Unified Address receiver structure.** A UA is
F4Jumble(receivers + padding), and fully validating one means un-jumbling and
walking the receiver TLV list. That is a large, easy-to-get-subtly-wrong piece
of the spec, and getting it wrong rejects valid addresses — the failure mode
this module is most careful to avoid. What is enforced instead is everything
cheap and certain: the HRP, the bech32m checksum, a clean 5-to-8-bit regrouping,
and ZIP-316's 48-byte minimum on the jumbled data. Full receiver parsing belongs
behind a real Zcash library, not a hand-rolled one.
"""

import hashlib
import re
from urllib.parse import urlsplit

from django.core.exceptions import ValidationError
from django.core.validators import URLValidator
from django.utils.translation import gettext_lazy as _


CANONICAL_URL_VALIDATOR = URLValidator(schemes=["http", "https"])


def validate_canonical_url(value):
    """Validate an optional externally hosted article URL without fetching it.

    Canonical URLs become public metadata and are consumed by crawlers. Keep
    them absolute and limited to HTTP(S), and reject credentials (which can
    leak secrets) and fragments (which identify a section, not the document).
    Deliberately do not make a network request here: saves must not depend on a
    third-party blog being available, and server-side fetching would introduce
    SSRF and latency risks.
    """
    if not value:
        return

    CANONICAL_URL_VALIDATOR(value)
    parsed = urlsplit(value)

    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValidationError(
            _("Enter an absolute URL beginning with http:// or https://."),
            code="invalid_canonical_url",
        )

    if parsed.username is not None or parsed.password is not None:
        raise ValidationError(
            _("Canonical URLs cannot contain a username or password."),
            code="canonical_url_credentials",
        )

    if "#" in value:
        raise ValidationError(
            _("Canonical URLs cannot contain a fragment."),
            code="canonical_url_fragment",
        )

#: Every character a Zcash address may contain.
ZCASH_ADDRESS_RE = re.compile(r"\A[A-Za-z0-9]+\Z")

#: Shortest real address is a transparent one at 34-35 characters. Anything
#: shorter is a truncated paste, never a usable destination.
ZCASH_ADDRESS_MIN_LENGTH = 20

BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
BECH32_CONST = 1
BECH32M_CONST = 0x2BC830A3

#: Human-readable part -> (checksum constant, exact payload length, minimum
#: payload length). Sapling is bech32 (ZIP-173); Unified and TEX are bech32m
#: (ZIP-316 / ZIP-320). Lengths are in bytes after the 5-to-8-bit conversion:
#:
#: * Sapling: 11-byte diversifier + 32-byte pk_d = 43, exactly.
#: * TEX: a 20-byte P2PKH validating key hash, exactly (ZIP-320).
#: * Unified: variable — it is F4Jumble(receivers + padding) — but ZIP-316
#:   requires the jumbled data to be at least 48 bytes.
BECH32_HRPS = {
    "zs": (BECH32_CONST, 43, None),
    "ztestsapling": (BECH32_CONST, 43, None),
    "u": (BECH32M_CONST, None, 48),
    "utest": (BECH32M_CONST, None, 48),
    "uregtest": (BECH32M_CONST, None, 48),
    "tex": (BECH32M_CONST, 20, None),
    "textest": (BECH32M_CONST, 20, None),
}

#: Prefixes encoded with base58check, mapped to (version bytes, payload length).
#: The checksum proves the string is intact; the version and length prove it is
#: a Zcash address rather than some other chain's base58check string that
#: happens to start with the same two characters.
BASE58_PREFIXES = {
    "t1": (b"\x1c\xb8", 20),   # mainnet P2PKH
    "t3": (b"\x1c\xbd", 20),   # mainnet P2SH
    "tm": (b"\x1d\x25", 20),   # testnet P2PKH
    "t2": (b"\x1c\xba", 20),   # testnet P2SH
    "zc": (b"\x16\x9a", 64),   # mainnet Sprout
    "zt": (b"\x16\xb6", 64),   # testnet Sprout
}

BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _bech32_polymod_step(chk, value):
    """Advance the Bech32 polymod state by one 5-bit value."""
    generator = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    top = chk >> 25
    chk = (chk & 0x1FFFFFF) << 5 ^ value
    for i in range(5):
        chk ^= generator[i] if ((top >> i) & 1) else 0
    return chk


def _bech32_polymod(values):
    chk = 1
    for value in values:
        chk = _bech32_polymod_step(chk, value)
    return chk


def _bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _convertbits(data, from_bits, to_bits):
    """Regroup 5-bit bech32 symbols into bytes, rejecting invalid padding.

    The strict padding rule is a real structural check, not bookkeeping: a
    checksum-valid string whose data part does not regroup cleanly into bytes
    is not a usable address.
    """
    acc = 0
    bits = 0
    out = bytearray()
    maxv = (1 << to_bits) - 1

    for value in data:
        if value < 0 or (value >> from_bits):
            return None
        acc = (acc << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            out.append((acc >> bits) & maxv)

    if bits >= from_bits or ((acc << (to_bits - bits)) & maxv):
        return None
    return bytes(out)


def _bech32_payload(address):
    """Decoded payload bytes of a bech32 address, or None if it won't regroup."""
    separator = address.rfind("1")
    data = [BECH32_CHARSET.index(char) for char in address[separator + 1:].lower()]
    return _convertbits(data[:-6], 5, 8)


def _bech32_checksum(address):
    """Return the polymod constant for ``address``, or None if it won't parse.

    Note there is intentionally no 90-character length cap here: the BIP-173
    limit does not apply to Unified Addresses (ZIP-316), which are far longer.
    """
    separator = address.rfind("1")
    if separator < 1 or separator + 7 > len(address):
        return None

    hrp = address[:separator].lower()
    try:
        data = [BECH32_CHARSET.index(char) for char in address[separator + 1:].lower()]
    except ValueError:
        return None

    return hrp, _bech32_polymod(_bech32_hrp_expand(hrp) + data)


def _base58check_decode(address):
    """Return the checksum-verified payload of ``address``, or None."""
    number = 0
    for char in address:
        if char not in BASE58_ALPHABET:
            return None
        number = number * 58 + BASE58_ALPHABET.index(char)

    raw = number.to_bytes((number.bit_length() + 7) // 8, "big")
    raw = b"\x00" * (len(address) - len(address.lstrip("1"))) + raw
    if len(raw) < 5:
        return None

    payload, checksum = raw[:-4], raw[-4:]
    if hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] != checksum:
        return None
    return payload


def _describe(char: str) -> str:
    """Render a character so an invisible one is actually visible in the error."""
    return f"U+{ord(char):04X}"


def _checksum_error():
    return ValidationError(
        _(
            "This Zcash address fails its own checksum, which means at least one "
            "character is wrong. Copy the address again from your wallet rather "
            "than retyping it — a single transposed character is impossible to "
            "spot by eye and would send your earnings somewhere unrecoverable."
        ),
        code="bad_checksum",
    )


def validate_zcash_address(value):
    """Reject anything that cannot be a Zcash address.

    An empty value is allowed: ``p2paddr`` is ``blank=True`` and clearing it is
    how a creator opts out of a payout address.
    """
    if not value:
        return

    invisible = sorted(
        {char for char in value if not char.isprintable() or char.isspace()}
    )
    if invisible:
        raise ValidationError(
            _(
                "This Zcash address contains %(count)d invisible or whitespace "
                "character(s) (%(chars)s). These are usually picked up by "
                "copying from a chat message or email and cannot be seen on "
                "screen. Retype or re-copy the address."
            ),
            code="invisible_character",
            params={
                "count": len(invisible),
                "chars": ", ".join(_describe(char) for char in invisible),
            },
        )

    if not ZCASH_ADDRESS_RE.match(value):
        bad = sorted({char for char in value if not char.isalnum() or ord(char) > 127})
        raise ValidationError(
            _(
                "A Zcash address contains only letters and digits, but this one "
                "contains %(chars)s."
            ),
            code="invalid_character",
            params={"chars": ", ".join(repr(char) for char in bad)},
        )

    if len(value) < ZCASH_ADDRESS_MIN_LENGTH:
        raise ValidationError(
            _(
                "This Zcash address is only %(length)d characters long, which is "
                "too short to be a real address — it looks like a truncated "
                "paste. Check that you copied the whole address."
            ),
            code="too_short",
            params={"length": len(value)},
        )

    # Every path below that ACCEPTS requires a valid checksum. A shape check
    # alone would let a mistyped prefix or a transposed character through, and
    # neither is visible to the creator proof-reading their own address.

    # Base58check first: a t-address's body may legitimately contain "1", which
    # the bech32 separator search would mis-parse as the separator.
    expected_base58 = BASE58_PREFIXES.get(value[:2].lower())
    if expected_base58 is not None:
        version, payload_length = expected_base58
        payload = _base58check_decode(value)
        if payload is None:
            raise _checksum_error()
        # The checksum proves integrity, not identity: a base58check string from
        # another chain can be intact and still not be a Zcash address.
        if payload[:2] != version or len(payload) != len(version) + payload_length:
            raise ValidationError(
                _(
                    "This does not decode to a Zcash transparent address. Check "
                    "that you copied it from a Zcash wallet and not from another "
                    "cryptocurrency."
                ),
                code="wrong_address_type",
            )
        return

    parsed = _bech32_checksum(value)
    if parsed is not None:
        hrp, constant = parsed
        known = BECH32_HRPS.get(hrp)
        if known is not None:
            expected_constant, exact_length, min_length = known
            if constant != expected_constant:
                raise _checksum_error()

            # The checksum proves the characters are intact; it says nothing
            # about whether the payload is the right size to BE an address of
            # this type. A deliberately-constructed string can satisfy one and
            # not the other.
            payload = _bech32_payload(value)
            if (
                payload is None
                or (exact_length is not None and len(payload) != exact_length)
                or (min_length is not None and len(payload) < min_length)
            ):
                raise ValidationError(
                    _(
                        "This looks like a Zcash address but does not decode to "
                        "a usable one — the address data is the wrong size. Copy "
                        "it again straight from your wallet."
                    ),
                    code="bad_payload",
                )
            return
        # An HRP we do not know. A valid checksum is NOT enough to accept it:
        # "bc1..." is valid bech32 and is a Bitcoin address. See the module
        # docstring — this fails closed on purpose.

    raise ValidationError(
        _(
            "This is not a Zcash address in any format Free2Z recognizes. Check "
            "that you copied it from a Zcash wallet — an address for another "
            "cryptocurrency looks similar and any ZEC sent to it is lost."
        ),
        code="unrecognized_format",
    )
