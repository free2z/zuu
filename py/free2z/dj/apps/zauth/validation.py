"""Validation shared by the Zcash login views and their address throttle."""

from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

from dj.apps.g12f.validators import validate_zcash_address


# A mainnet transparent P2PKH address is the base58check encoding of the
# two-byte 0x1CB8 version, a 20-byte key hash, and a four-byte checksum. That
# version range always encodes to exactly 35 characters beginning with ``t1``.
ZCASH_LOGIN_ADDRESS_LENGTH = 35


def validate_zcash_login_address(value: object) -> None:
    """Require the exact address type supported by signed-message login.

    ``validate_zcash_address`` deliberately accepts every supported payout
    format. Zcash signed-message recovery here is narrower: it can prove only
    a mainnet transparent P2PKH (``t1``) address, so accepting a shielded,
    unified, P2SH, or testnet address would mint an unusable challenge.

    This function never normalizes. In particular, leading/trailing or
    invisible whitespace is invalid rather than stripped into validity.
    """
    if not isinstance(value, str):
        raise ValidationError(
            _("Zcash login address must be a string."),
            code="invalid_type",
        )
    if len(value) != ZCASH_LOGIN_ADDRESS_LENGTH:
        raise ValidationError(
            _(
                "Zcash login requires a %(length)d-character mainnet "
                "transparent P2PKH (t1) address."
            ),
            code="invalid_length",
            params={"length": ZCASH_LOGIN_ADDRESS_LENGTH},
        )
    if not value.startswith("t1"):
        raise ValidationError(
            _(
                "Zcash signed-message login supports only mainnet transparent "
                "P2PKH (t1) addresses."
            ),
            code="unsupported_address_type",
        )

    # This proves both the 0x1CB8/20-byte payload and the base58 checksum; a
    # shape-only ``t1`` check would accept a mistyped authentication identity.
    validate_zcash_address(value)


def is_valid_zcash_login_address(value: object) -> bool:
    """Boolean form for admission controls which must skip invalid values."""
    try:
        validate_zcash_login_address(value)
    except (ValidationError, TypeError, ValueError):
        return False
    return True
