"""Classify exact shielded memos without authorizing or issuing any funding.

The receiving event retains all 512 bytes. This parser removes only ZIP-302
trailing zero padding; malformed or opaque instructions remain capture-only.
The act/id instruction names a credit recipient, never the shielded sender.
Historical reference fields have no pricing or authorization authority.
"""
import json
from dataclasses import dataclass, field

from .paymentd_protocol import PaymentEvidenceError, _json_no_duplicates


@dataclass(frozen=True)
class Instruction:
    # Do not let a debug repr expose the memo's private intent proof token.
    memo_plain: str | None = field(default=None, repr=False)
    username: str | None = field(default=None, repr=False)
    buy: bool = False
    reason: str = ''
    promo: object = field(default=None, repr=False)

    @property
    def storage_plaintext(self):
        """Optional PostgreSQL-safe text; the event's memo_hex is authoritative.

        Never delete embedded NULs to make a malformed memo look like a valid
        purchase. PostgreSQL cannot retain those NULs in text or JSONB.
        """
        return self.memo_plain if self.memo_plain is None or '\0' not in self.memo_plain else None


def _reject_nonstandard_constant(value):
    raise ValueError('nonstandard JSON constant')


def parse_memo(raw):
    """Return a routing hint, preserving original text for exact backend checks."""
    if not isinstance(raw, bytes) or len(raw) != 512:
        raise PaymentEvidenceError('payment memo must contain exactly 512 bytes')
    if not any(raw) or raw == b'\xf6' + bytes(511):
        return Instruction(reason='missing_memo')
    if raw[0] >= 0xf5:
        return Instruction(reason='non_text_memo')
    try:
        text = raw.rstrip(b'\0').decode('utf-8')
    except UnicodeError:
        return Instruction(reason='invalid_utf8_memo')
    try:
        payload = json.loads(text, object_pairs_hook=_json_no_duplicates, parse_constant=_reject_nonstandard_constant)
    except (ValueError, PaymentEvidenceError, RecursionError):
        return Instruction(text, reason='malformed_memo')
    if not isinstance(payload, dict) or payload.get('act') != 'buy_2z':
        return Instruction(text, reason='unsupported_payment_instruction')
    username = payload.get('id')
    if not {'act', 'id'}.issubset(payload) or not set(payload).issubset({'act', 'id', 'intent', 'proof', 'ref', 'promo'}) or not isinstance(username, str) or not 1 <= len(username) <= 150 \
            or any(ord(char) < 32 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff
                   for char in username):
        return Instruction(text, reason='invalid_purchase_instruction')
    return Instruction(text, username, buy=True, promo=payload.get('promo'))


@dataclass(frozen=True)
class Route:
    phase: str
    instruction: Instruction
    reason: str = ''


def route_event(event):
    """Choose a phase for an already validated event; this performs no effects.

    Every capture phase needs a real durable backend note before acknowledgement.
    Observations and zero-value notes can never select settlement. Revocation is
    receipt-based, independent of whether the memo still parses as a purchase.
    """
    instruction = parse_memo(bytes.fromhex(event['payment']['memo_hex']))
    if event['kind'] == 'payment.revoked':
        return Route('reconcile_revocation', instruction)
    if event['payment']['value_zatoshis'] == 0:
        return Route('capture_only', instruction, 'zero_value_note')
    if not instruction.buy:
        return Route('capture_only', instruction, instruction.reason)
    if event['kind'] == 'payment.observed':
        return Route('capture_only', instruction)
    if event['kind'] != 'payment.confirmed':
        raise PaymentEvidenceError('unsupported payment lifecycle')
    return Route('settle_purchase', instruction)
