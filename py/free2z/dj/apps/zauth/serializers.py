"""Explicit, bounded wire schemas for Zcash challenge authentication."""

from rest_framework import serializers

from .validation import (
    ZCASH_LOGIN_ADDRESS_LENGTH,
    validate_zcash_login_address,
)


CHALLENGE_MAX_LENGTH = 128
SIGNATURE_MAX_LENGTH = 128
PUBKEY_MAX_LENGTH = 130


class StrictCharField(serializers.CharField):
    """A CharField which does not coerce JSON numbers into strings."""

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class ZcashAddressField(StrictCharField):
    def __init__(self, **kwargs):
        kwargs.setdefault("min_length", ZCASH_LOGIN_ADDRESS_LENGTH)
        kwargs.setdefault("max_length", ZCASH_LOGIN_ADDRESS_LENGTH)
        kwargs.setdefault("trim_whitespace", False)
        kwargs.setdefault("validators", [validate_zcash_login_address])
        super().__init__(**kwargs)


class ZcashChallengeRequestSerializer(serializers.Serializer):
    address = ZcashAddressField()


class ZcashChallengeResponseSerializer(serializers.Serializer):
    challenge = serializers.CharField(max_length=CHALLENGE_MAX_LENGTH)


class ZcashLoginRequestSerializer(serializers.Serializer):
    address = ZcashAddressField()
    challenge = StrictCharField(
        max_length=CHALLENGE_MAX_LENGTH,
        trim_whitespace=False,
    )
    signature = StrictCharField(
        max_length=SIGNATURE_MAX_LENGTH,
        trim_whitespace=False,
    )
    # Kept for the existing wallet contract. Verification recovers the public
    # key from the compact signature and therefore does not trust this value.
    pubkey = StrictCharField(
        max_length=PUBKEY_MAX_LENGTH,
        trim_whitespace=False,
        required=False,
    )
    otp_token = StrictCharField(
        max_length=10,
        trim_whitespace=False,
        required=False,
        write_only=True,
        help_text=(
            "Current authenticator code for an existing Creator; "
            "required for association flows too; not required for new "
            "accounts."
        ),
    )


class ZcashLoginResponseSerializer(serializers.Serializer):
    token = serializers.CharField()
    expiry = serializers.DateTimeField(allow_null=True)
    username = serializers.CharField()
    did = serializers.CharField()
    created = serializers.BooleanField()


class ZcashAuthErrorSerializer(serializers.Serializer):
    detail = serializers.CharField()
