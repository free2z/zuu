"""Shapes for ``/api/e2ee/handle/``, ``/api/e2ee/handle/claim/`` and
``/api/e2ee/authority/``."""

from rest_framework import serializers

from . import claims, policy

HANDLE_STATUSES = ("bound", "unclaimed")


class HandleStatusSerializer(serializers.Serializer):
    """The caller's messaging handle, and what they can do about it."""

    handle = serializers.CharField(
        allow_null=True,
        help_text="The handle this account owns, or null.",
    )
    status = serializers.ChoiceField(
        choices=HANDLE_STATUSES,
        help_text=(
            "'bound': the account owns `handle`, permanently. 'unclaimed': it "
            "owns none and may claim one."
        ),
    )
    source = serializers.ChoiceField(
        choices=["username", "claimed"],
        allow_null=True,
        help_text=(
            "'username': reserved from the account's own username. 'claimed': "
            "chosen through the claim flow. Null when unclaimed."
        ),
    )
    candidate = serializers.CharField(
        allow_null=True,
        help_text=(
            "lowercase(username) when that is a well-formed handle, else null. "
            "Says nothing about who owns it."
        ),
    )
    eligible = serializers.BooleanField(
        help_text=(
            "Whether `candidate` is this account's to have: well-formed, not "
            "reserved, and not held by another account."
        ),
    )
    reason = serializers.ChoiceField(
        choices=list(policy.REASONS),
        allow_null=True,
        help_text=(
            "Why `eligible` is false. 'punctuation', 'non-ascii' and 'too-long' "
            "match the ZUULI client's IneligibilityReason; 'reserved' and "
            "'taken' depend on server state."
        ),
    )
    can_claim = serializers.BooleanField(
        help_text="Whether POST /api/e2ee/handle/claim/ can succeed for this account.",
    )


class StrictCharField(serializers.CharField):
    """A ``CharField`` that refuses numbers instead of stringifying them.

    ``{"handle": 12}`` is a client bug, not a request for the handle ``12``.
    """

    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class HandleClaimRequestSerializer(serializers.Serializer):
    handle = StrictCharField(
        max_length=64,
        trim_whitespace=False,
        help_text=(
            "The handle to own, exactly ^[a-z0-9_]{1,30}$. Not lowercased or "
            "trimmed for you. Permanent once bound."
        ),
    )


class HandleClaimErrorSerializer(serializers.Serializer):
    detail = serializers.CharField()
    code = serializers.ChoiceField(choices=list(claims.CLAIM_ERRORS))


class AuthorityInfoSerializer(serializers.Serializer):
    """The public half of the handle authority, for configuring a log."""

    public_key = serializers.CharField(
        help_text="Ed25519 authority public key, 64 lowercase hex characters.",
    )
    authority_id = serializers.CharField(
        help_text=(
            "BLAKE2b-256('free2z/kt/v1/authority-id' || public_key), 64 hex. "
            "The same value `f2z-assert authority` prints."
        ),
    )
    log_id = serializers.CharField(
        help_text="The log_id this authority signs for, 64 hex.",
    )
    validity_ms = serializers.IntegerField(
        help_text=(
            "expires_ms - issued_ms of the assertions this deployment signs. "
            "Logs apply their own cap independently."
        ),
    )

