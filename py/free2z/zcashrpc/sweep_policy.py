"""Portable sweep validation. This module never proposes, signs, or sends funds.

All amounts are integer zatoshis (100,000,000 per ZEC). Callers own destination
pins, synchronization, locks, deadlines, confirmation ordering and durable state.
"""

import json
import re
import sqlite3
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

U64_MAX = (1 << 64) - 1
ZATS_PER_ZEC = 100_000_000
_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_SPEND_TABLES = (
    "sapling_received_note_spends", "orchard_received_note_spends",
    "ironwood_received_note_spends", "transparent_received_output_spends",
)


class PolicyError(ValueError):
    """An input cannot establish a valid sweep fact."""


def u64(value):
    """Accept a JSON integer in 0..2**64-1; reject booleans and coercions."""
    if type(value) is not int or not 0 <= value <= U64_MAX:
        raise PolicyError("expected an unsigned 64-bit integer")
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PolicyError("duplicate JSON key")
        result[key] = value
    return result


def json_u64(text, key):
    """Read a top-level integer from complete JSON, rejecting duplicate keys."""
    try:
        value = json.loads(text, object_pairs_hook=_unique_object)
    except (TypeError, ValueError) as exc:
        raise PolicyError("invalid JSON object") from exc
    if not isinstance(value, dict) or key not in value:
        raise PolicyError("missing integer field")
    return u64(value[key])


def zec_to_zats(text):
    """Parse the devtool's decimal display, with exactly eight fractional digits.

    Whitespace and an optional alphabetic ticker are accepted, as in its
    ``0.00010000 ZEC`` output. No sign, exponent, rounding or overflow is allowed.
    """
    if not isinstance(text, str):
        raise PolicyError("expected decimal text")
    compact = "".join(text.split())
    match = re.fullmatch(r"([0-9]+)\.([0-9]{8})(?:[A-Za-z]+)?", compact)
    if not match:
        raise PolicyError("expected eight decimal places")
    try:
        return u64(int(match[1]) * ZATS_PER_ZEC + int(match[2]))
    except ValueError as exc:
        raise PolicyError("amount exceeds unsigned 64-bit range") from exc


def bech32m_ok(address, expected_hrp):
    """Check lowercase bech32m checksum and HRP, not receiver semantics."""
    if not isinstance(address, str) or not re.fullmatch(r"[a-z0-9]+", address):
        return False
    hrp, sep, data = address.rpartition("1")
    if not sep or not hrp or hrp != expected_hrp or len(data) < 6:
        return False
    try:
        values = [ord(c) >> 5 for c in hrp] + [0]
        values += [ord(c) & 31 for c in hrp] + [_CHARSET.index(c) for c in data]
    except ValueError:
        return False
    check = 1
    generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    for value in values:
        high = check >> 25
        check = ((check & 0x1FFFFFF) << 5) ^ value
        for bit, generator in enumerate(generators):
            if (high >> bit) & 1:
                check ^= generator
    return check == 0x2BC830A3


@dataclass(frozen=True)
class Proposal:
    recipient: str
    fee_zats: int


def validate_proposal(text, *, destination, reserve_zats, expected_hrp):
    """Validate one step/payment/recipient/fee against caller-supplied limits.

    The textual proposal does not prove the amount or inputs that a later send
    will choose. The caller must confirm again immediately before sending with
    the same explicit destination/value, then independently check its outcome.
    """
    reserve_zats = u64(reserve_zats)
    if not isinstance(text, str):
        raise PolicyError("expected proposal text")
    lines = text.splitlines()
    steps = [s for s in lines if re.match(r"^  Steps \(", s)]
    payments = [s for s in lines if re.match(r"^      Payments \(", s)]
    recipients = [s for s in lines if re.match(r"^        \[[0-9]*\] -> ", s)]
    fees = [s for s in lines if s.startswith("      Fee: ")]
    if (steps != ["  Steps (1):"] or payments != ["      Payments (1):"]
            or len(recipients) != 1 or len(fees) != 1):
        raise PolicyError("expected one step, payment, recipient and fee")
    if recipients[0] != "        [0] -> " + destination:
        raise PolicyError("recipient differs from destination")
    if not bech32m_ok(destination, expected_hrp):
        raise PolicyError("invalid recipient checksum or network prefix")
    fee = zec_to_zats(fees[0][len("      Fee: "):])
    if fee > reserve_zats:
        raise PolicyError("fee exceeds reserve")
    return Proposal(destination, fee)


def readonly_wallet(db_path):
    """Open an explicit existing wallet path without SQLite URI interpolation."""
    return sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)


def spend_rows(db_path):
    """Count committed spend rows across all four supported wallet pools.

    Missing tables or read errors propagate; missing evidence is never zero.
    """
    conn = readonly_wallet(db_path)
    try:
        count = conn.execute("SELECT " + " + ".join(
            f"(SELECT count(*) FROM {table})" for table in _SPEND_TABLES
        )).fetchone()[0]
        return u64(count)
    finally:
        conn.close()


def txid_bytes(txid):
    """Return the 32 display-order bytes of a canonical lowercase txid."""
    if not isinstance(txid, str) or not re.fullmatch(r"[0-9a-f]{64}", txid):
        raise PolicyError("expected a lowercase 32-byte hexadecimal transaction ID")
    return bytes.fromhex(txid)


def tx_fee_zats(db_path, txid):
    """Read a unique fee in display or internal txid order; None is unverified.

    Two distinct matching rows are ambiguous, including when their fees agree.
    SQLite failures propagate so a caller can distinguish unavailable evidence.
    """
    wire = txid_bytes(txid)
    conn = readonly_wallet(db_path)
    try:
        rows = conn.execute("SELECT fee FROM transactions WHERE txid IN (?, ?)",
                            (wire, wire[::-1])).fetchall()
    finally:
        conn.close()
    if len(rows) != 1:
        return None
    try:
        return u64(rows[0][0])
    except PolicyError:
        return None


class SendOutcome(str, Enum):
    CONFIRMED = "confirmed"
    FEE_UNVERIFIED = "fee-unverified"
    FEE_BREACH = "fee-breach"
    FAILED_NO_SPEND = "failed-no-spend"
    UNRESOLVED = "unresolved"


def classify_send(*, send_status, pre_spends, post_spends, fee_zats, reserve_zats):
    """Classify evidence without clearing a marker or granting retry authority.

    ``FAILED_NO_SPEND`` assumes the wallet commits spend rows before broadcast
    and the controller serialized all writers. A changed wallet or concurrent
    spender invalidates that inference. Unknown/decreasing counts fail closed.
    A successful spend with unreadable fee is explicitly fee-unverified, not a
    fee breach. A breach requires a durable private latch before marker removal.
    """
    reserve_zats, pre_spends = u64(reserve_zats), u64(pre_spends)
    if type(send_status) is not int:
        raise PolicyError("expected integer process exit status")
    if post_spends is None:
        return SendOutcome.UNRESOLVED
    post_spends = u64(post_spends)
    if post_spends < pre_spends:
        return SendOutcome.UNRESOLVED
    recorded = post_spends > pre_spends
    if send_status == 0 and recorded:
        if fee_zats is None:
            return SendOutcome.FEE_UNVERIFIED
        return (SendOutcome.FEE_BREACH if u64(fee_zats) > reserve_zats
                else SendOutcome.CONFIRMED)
    if send_status != 0 and not recorded:
        return SendOutcome.FAILED_NO_SPEND
    return SendOutcome.UNRESOLVED


def shielded_spendable(balance_json):
    """Sum spendable shielded pools; transparent outputs require shielding."""
    return u64(sum(json_u64(balance_json, pool + "_spendable")
                   for pool in ("sapling", "orchard", "ironwood")))


def sweep_value(*, spendable_zats, threshold_zats, reserve_zats, maximum_zats):
    """Return zero below threshold/after reserve, or a value within the cap."""
    spendable_zats, threshold_zats = u64(spendable_zats), u64(threshold_zats)
    reserve_zats, maximum_zats = u64(reserve_zats), u64(maximum_zats)
    if spendable_zats < threshold_zats or spendable_zats <= reserve_zats:
        return 0
    value = spendable_zats - reserve_zats
    if value > maximum_zats:
        raise PolicyError("sweep value exceeds cap")
    return value


def next_reserve(*, reserve_zats, attempts_used, maximum_attempts, maximum_zats):
    """Double the reserve after a failed proposal, or return None at a limit."""
    reserve_zats, maximum_zats = u64(reserve_zats), u64(maximum_zats)
    attempts_used, maximum_attempts = u64(attempts_used), u64(maximum_attempts)
    proposed = reserve_zats * 2
    if attempts_used >= maximum_attempts or proposed > maximum_zats:
        return None
    return proposed
