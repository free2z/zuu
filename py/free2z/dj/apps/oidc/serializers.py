"""Request and response shapes for the JSON endpoints, for ``f2z.yaml``.

The token, revocation and introspection endpoints are form-encoded (RFC 6749,
7009, 7662) and answer RFC-shaped JSON; their serializers here document that
shape and validate nothing -- oauthlib does.
"""
from __future__ import annotations

from rest_framework import serializers

from .models import CapPeriod
from .scopes import ALL_SCOPES


class AuthorizationRequestSerializer(serializers.Serializer):
    """The authorization request parameters (spec §9.2), echoed back by the
    consent GET and re-submitted by the consent POST."""

    response_type = serializers.CharField()
    client_id = serializers.CharField()
    redirect_uri = serializers.CharField()
    scope = serializers.CharField()
    # OAuth state and OIDC nonce are opaque client values. Preserve even
    # surrounding whitespace exactly for request_id verification and the
    # eventual callback / ID token.
    state = serializers.CharField(trim_whitespace=False)
    code_challenge = serializers.CharField()
    code_challenge_method = serializers.CharField()
    nonce = serializers.CharField(required=False, allow_blank=True, trim_whitespace=False)
    prompt = serializers.CharField(required=False, allow_blank=True)
    max_age = serializers.CharField(required=False, allow_blank=True)
    acr_values = serializers.CharField(required=False, allow_blank=True)
    login_hint = serializers.CharField(required=False, allow_blank=True)
    ui_locales = serializers.CharField(required=False, allow_blank=True)
    response_mode = serializers.CharField(required=False, allow_blank=True)
    f2z_login_ticket = serializers.CharField(
        required=False, allow_blank=True,
        help_text="Not an OAuth parameter: the `login_ticket` of an earlier "
                  "`login` answer, carried back after the sign-in it asked "
                  "for. A sign-in at or after the ticket's time satisfies "
                  "`prompt=login` and `max_age` (including `max_age=0`). "
                  "An invalid or expired ticket is ignored.",
    )
    # Untrimmed: the POST's request_id is a digest of exactly what the GET
    # saw, and a trimmed echo of " 500" would no longer match it -- an
    # ignored hint must never fail the authorization (codex review, ).
    f2z_spend_cap = serializers.CharField(
        required=False, allow_blank=True, trim_whitespace=False,
        help_text="Not an OAuth parameter: the app's suggested spend "
                  "cap, echoed so the POST's `request_id` still matches. The "
                  "POST never records it; only its own `spend_cap_2z` counts.",
    )
    f2z_spend_period = serializers.CharField(
        required=False, allow_blank=True, trim_whitespace=False,
        help_text="Not an OAuth parameter: the period of "
                  "`f2z_spend_cap`, echoed like it.",
    )


class ConsentApplicationSerializer(serializers.Serializer):
    client_id = serializers.CharField()
    name = serializers.CharField()
    developer = serializers.CharField(allow_null=True, help_text="Developer username.")
    logo_url = serializers.CharField(allow_blank=True)
    privacy_url = serializers.CharField(allow_blank=True)
    terms_url = serializers.CharField(allow_blank=True)
    first_party = serializers.BooleanField()
    child_directed = serializers.BooleanField(
        help_text="The developer registered the app as directed to children or "
                  "to all ages: the screen addresses the adult account holder.",
    )
    markup_bps = serializers.IntegerField(
        help_text="The app's EFFECTIVE markup right now (min of requested and approved).",
    )
    markup_approval = serializers.ChoiceField(choices=["none", "pending", "approved"])


class SpendCapSerializer(serializers.Serializer):
    spend_cap_2z = serializers.IntegerField(allow_null=True, min_value=0)
    cap_period = serializers.ChoiceField(choices=CapPeriod.choices)


class ConsentPromptSerializer(serializers.Serializer):
    """``action: consent`` -- what the consent screen shows."""

    application = ConsentApplicationSerializer()
    scopes = serializers.ListField(
        child=serializers.CharField(),
        help_text="The requested scopes, in request order.",
    )
    scope_descriptions = serializers.DictField(child=serializers.CharField())
    already_granted = serializers.ListField(
        child=serializers.CharField(),
        help_text="Scopes the existing grant (if any) already covers.",
    )
    cap_required = serializers.BooleanField(
        help_text="True when ai:invoke is requested: the cap control is shown.",
    )
    spend_cap = SpendCapSerializer(
        help_text="What the screen pre-selects: the existing grant's budget on "
                  "re-consent; on first consent, the app's optional per-user "
                  "suggestion without a platform clamp. A request's "
                  "`f2z_spend_cap` hint replaces it only when it fits the "
                  "registration's default and the existing grant by a lower "
                  "amount at their period, so it is never higher. Null means "
                  "prepaid balance without an extra app budget.",
    )
    spend_cap_source = serializers.ChoiceField(
        choices=["grant", "app", "platform", "request"],
        help_text="Where `spend_cap` came from: the existing `grant`, the "
                  "`app` registration's default, the `platform` default, or "
                  "the authorization `request`'s clamped hint.",
    )
    current_spend_cap = SpendCapSerializer(
        allow_null=True,
        help_text="The budget a change is judged against: the user's last grant "
                  "for the app (live or revoked), or null when there is none or "
                  "it never made an AI spending decision. A raise over it -- a "
                  "higher amount, no cap, or any other period -- needs a recent "
                  "sign-in.",
    )
    is_raise_step_up_required = serializers.BooleanField(
        help_text="On a re-consent, choosing a higher cap than the existing "
                  "one needs a recent authentication (RFC 9470).",
    )


class AuthorizeResponseSerializer(serializers.Serializer):
    """The consent step's answer.

    ``action`` decides what the page does: ``login`` (sign the user in, then
    repeat the GET; ``reason`` says why), ``consent`` (show the screen and
    POST the decision), ``approve`` (nothing to ask: POST ``allow: true``
    right away), ``redirect`` (navigate to ``redirect_to``; the response,
    success or error, is already encoded in it).
    """

    action = serializers.ChoiceField(choices=["login", "consent", "approve", "redirect"])
    reason = serializers.CharField(required=False, allow_blank=True)
    login_ticket = serializers.CharField(
        required=False,
        help_text="With `action: login`: opaque and signed. Send it back as "
                  "`f2z_login_ticket` on the repeated request after the "
                  "sign-in; valid for 10 minutes.",
    )
    redirect_to = serializers.CharField(required=False)
    request_id = serializers.CharField(
        required=False,
        help_text="Opaque, signed; must be sent back on the POST.",
    )
    authorization_request = AuthorizationRequestSerializer(required=False)
    consent = ConsentPromptSerializer(required=False)


class ConsentDecisionSerializer(serializers.Serializer):
    """The consent POST."""

    request_id = serializers.CharField()
    authorization_request = AuthorizationRequestSerializer()
    allow = serializers.BooleanField()
    scope = serializers.ListField(
        child=serializers.ChoiceField(choices=list(ALL_SCOPES)),
        required=False,
        help_text="The scopes the user grants; a subset of the request. "
                  "Defaults to every requested scope.",
    )
    spend_cap_2z = serializers.IntegerField(
        required=False, allow_null=True, min_value=0,
        help_text="REQUIRED on a first consent that grants ai:invoke: the "
                  "user's choice, null meaning no cap (400 when absent). On a "
                  "re-consent, absent keeps the existing cap.",
    )
    cap_period = serializers.ChoiceField(choices=CapPeriod.choices, required=False)


class OAuthErrorSerializer(serializers.Serializer):
    error = serializers.CharField()
    error_description = serializers.CharField(required=False)
    state = serializers.CharField(required=False)


class TokenRequestSerializer(serializers.Serializer):
    """``application/x-www-form-urlencoded`` (spec §9.4)."""

    grant_type = serializers.ChoiceField(choices=["authorization_code", "refresh_token"])
    client_id = serializers.CharField(required=False)
    client_secret = serializers.CharField(required=False)
    code = serializers.CharField(required=False)
    redirect_uri = serializers.CharField(required=False)
    code_verifier = serializers.CharField(required=False)
    refresh_token = serializers.CharField(required=False)
    scope = serializers.CharField(required=False)


class TokenResponseSerializer(serializers.Serializer):
    token_type = serializers.CharField()
    access_token = serializers.CharField()
    expires_in = serializers.IntegerField()
    scope = serializers.CharField()
    refresh_token = serializers.CharField(required=False)
    id_token = serializers.CharField(required=False)


class RevokeRequestSerializer(serializers.Serializer):
    token = serializers.CharField()
    token_type_hint = serializers.ChoiceField(
        choices=["refresh_token", "access_token"], required=False,
    )
    client_id = serializers.CharField(required=False)
    client_secret = serializers.CharField(required=False)


class IntrospectRequestSerializer(serializers.Serializer):
    token = serializers.CharField()
    token_type_hint = serializers.CharField(required=False)


class IntrospectResponseSerializer(serializers.Serializer):
    active = serializers.BooleanField()
    scope = serializers.CharField(required=False)
    client_id = serializers.CharField(required=False)
    sub = serializers.CharField(required=False)
    exp = serializers.IntegerField(required=False)
    iat = serializers.IntegerField(required=False)
    aud = serializers.ListField(child=serializers.CharField(), required=False)
    aep = serializers.IntegerField(required=False)
    agen = serializers.IntegerField(required=False)
    token_type = serializers.CharField(required=False)


class UserInfoSerializer(serializers.Serializer):
    sub = serializers.CharField()
    preferred_username = serializers.CharField(required=False)
    name = serializers.CharField(required=False)
    picture = serializers.CharField(required=False)
    email = serializers.CharField(required=False)
    email_verified = serializers.BooleanField(required=False)


class GrantSerializer(serializers.Serializer):
    client_id = serializers.CharField()
    application_id = serializers.UUIDField()
    name = serializers.CharField()
    developer = serializers.CharField(allow_null=True)
    scope = serializers.ListField(child=serializers.CharField())
    spend_cap_2z = serializers.IntegerField(allow_null=True)
    cap_period = serializers.ChoiceField(choices=CapPeriod.choices)
    markup_bps = serializers.IntegerField()
    generation = serializers.IntegerField()
    consented_at = serializers.DateTimeField()


class GrantCapUpdateSerializer(serializers.Serializer):
    """``PUT /api/oauth/grants/<application_id>/cap/``. Both fields are
    REQUIRED: the cap never fails open, so "no cap" is an explicit null and
    an absent key is a 400, not "keep whatever was there"."""

    spend_cap_2z = serializers.IntegerField(
        required=True, allow_null=True, min_value=0, max_value=2_147_483_647,
        help_text="Whole 2Z; null means no cap. Raising the cap (a higher "
                  "amount, a different period, or no cap) needs a sign-in within "
                  "the last 5 minutes (401 insufficient_user_authentication). A "
                  "period change is a raise whichever way the periods rank: it "
                  "starts a fresh spend window.",
    )
    cap_period = serializers.ChoiceField(choices=CapPeriod.choices, required=True)


class InternalEpochSerializer(serializers.Serializer):
    sub = serializers.UUIDField()
    aep = serializers.IntegerField()
    agen = serializers.DictField(
        child=serializers.IntegerField(),
        help_text="client_id -> the grant's current generation, LIVE grants only. "
                  "A client_id absent from this map means the grant is revoked "
                  "(or never existed): refuse the token, do not treat absence "
                  "as unknown.",
    )
