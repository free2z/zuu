"""Request and response shapes for the assertion endpoint.

Plain ``Serializer``s, not ``ModelSerializer``s: this app has no models, and
drf-spectacular reads these to put the endpoint in ``f2z.yaml`` alongside
everything else (``dj/apps/test_spec_coverage.py`` fails the gate if a reachable
route is invisible to it).

**The request body carries no handle.** It cannot: the handle is whatever
``request.user`` already owns, and a body field for it would be a field an
attacker could set. The only two things a caller gets to say are *which key* to
vouch for and *what for*.
"""

from rest_framework import serializers

from . import signing


class HandleAssertionRequestSerializer(serializers.Serializer):
    """What a device asks for when it enrolls."""

    identity_key = serializers.CharField(
        max_length=64,
        help_text=(
            "The Ed25519 identity signing key (ISK.public) to vouch for: 32 "
            "bytes, base64url (RFC 4648 section 5), padding optional."
        ),
    )
    intent = serializers.ChoiceField(
        choices=sorted(signing.INTENTS),
        help_text=(
            "'bind' for a handle's first directory entry, 'reset' for the "
            "ADR 0014 platform-reset path on an established one. The log ties "
            "each to a position in the handle's entry sequence, so the wrong "
            "one is refused rather than reinterpreted."
        ),
    )

    def validate_identity_key(self, value):
        try:
            raw = signing.b64u_decode_fixed(value, 32)
            signing.check_identity_key(raw)
        except ValueError as exc:
            raise serializers.ValidationError(str(exc)) from exc
        return raw


class HandleAssertionResponseSerializer(serializers.Serializer):
    """The signed assertion, and when it stops being usable."""

    assertion = serializers.CharField(
        help_text=(
            "tls_codec(HandleAssertion) -- the signed body followed by its "
            "64-byte Ed25519 signature -- as unpadded base64url. Present it "
            "to the log with a submission signed by the identity key it "
            "names; on its own it authorizes nothing."
        ),
    )
    handle = serializers.CharField(
        help_text=(
            "The handle vouched for, derived from the authenticated account. "
            "Echoed so a client need not parse the assertion to see it."
        ),
    )
    issued_ms = serializers.IntegerField(
        help_text="issued_ms as signed: milliseconds since the Unix epoch.",
    )
    expires_ms = serializers.IntegerField(
        help_text=(
            "expires_ms as signed. The log applies its own cap on "
            "expires_ms - issued_ms independently of this value."
        ),
    )


class AuthorityUnavailableSerializer(serializers.Serializer):
    """The 503 body: a bounded reason code, and nothing about the deployment."""

    detail = serializers.CharField()
    reason = serializers.ChoiceField(
        choices=sorted(signing.REASON_CODES),
        help_text=(
            "Why no assertion was issued. Every value is enumerated here: the "
            "field never carries an error string from the key store."
        ),
    )


class HandleIneligibleSerializer(serializers.Serializer):
    """The 409 body: this account owns no messaging handle to vouch for.

    ``handle_unclaimed`` covers every cause -- an ineligible username
    (``WIRE.md`` §14.3), a reserved word, or a handle an earlier account holds
    -- because the remedy is the same: ``GET /api/e2ee/handle/`` names the
    cause and ``POST /api/e2ee/handle/claim/`` binds one.
    """

    detail = serializers.CharField()
    reason = serializers.ChoiceField(choices=["handle_unclaimed"])
