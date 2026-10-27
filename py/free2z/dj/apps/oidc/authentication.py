"""``OAuth2JWTAuthentication``: tuzi's own API as a resource server.

``Authorization: Bearer <ES256 at+jwt>`` from ``dj.apps.oidc``. It is listed
in ``DEFAULT_AUTHENTICATION_CLASSES`` and is **default-deny**:

* a view that does not declare ``required_scopes`` refuses every OAuth token
  with ``401`` -- listing the class globally opens nothing by itself, and
  a third-party app reaches only what a view has explicitly opened;
* a view that declares ``required_scopes`` accepts a token whose ``scope``
  covers all of them, and answers ``403 insufficient_scope`` otherwise;
* a view may set ``oauth_audience`` (default ``f2z-api``); the token's
  ``aud`` must contain it.

What is checked, in order: the JWT itself as any resource server would
(``dj.apps.oidc.tokens.decode_access_token``: kid, ES256, typ, iss, aud,
exp); then the database, which the IdP has and a resource server does not --
the token row still exists (a revoked family or a bumped grant deletes it),
the account epoch and grant generation the token was minted under are the
CURRENT ones (spec §6.2/§6.3: ``401 token_revoked``), the user is active and
the app is not frozen. The epoch is read in the same query as the token row,
so the two cannot come from different instants (the  lesson).
"""
from __future__ import annotations

import hashlib
import logging

from django.utils.translation import gettext_lazy as _
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication, get_authorization_header

from .scopes import ALL_SCOPES, AUD_API, PUBLIC_ISSUER, scope_list
from .tokens import InvalidAccessToken, decode_access_token

logger = logging.getLogger(__name__)


class InsufficientScope(exceptions.PermissionDenied):
    """RFC 6750 §3.1: the token is valid but does not cover the resource."""

    default_code = "insufficient_scope"

    def __init__(self, required):
        super().__init__(
            detail={
                "detail": "The access token does not cover this resource.",
                "code": "insufficient_scope",
                "required_scopes": list(required),
            },
            code="insufficient_scope",
        )


class OAuthAccessToken:
    """``request.auth`` for an OAuth-authenticated request."""

    __slots__ = ("claims", "row", "application")

    def __init__(self, claims: dict, row, application):
        self.claims = claims
        self.row = row
        self.application = application

    @property
    def scope(self) -> str:
        return self.claims["scope"]

    @property
    def scopes(self) -> list[str]:
        return scope_list(self.claims["scope"])

    @property
    def account_epoch(self) -> int:
        return self.claims["aep"]

    @property
    def grant_generation(self) -> int:
        return self.claims["agen"]

    @property
    def client_id(self) -> str:
        return self.claims["client_id"]


def _bearer_token(request) -> str | None:
    auth = get_authorization_header(request).split()
    if len(auth) != 2 or auth[0].lower() != b"bearer":
        return None
    try:
        return auth[1].decode("ascii")
    except UnicodeDecodeError:
        raise exceptions.AuthenticationFailed(
            _("Invalid token."), code="invalid_token",
        ) from None


def verify_bearer(raw: str, *, audience: str):
    """The full IdP-side verification of an access token.

    First what any resource server does from ``jwks_uri`` alone
    (:func:`decode_access_token`), then what only the IdP can: the row still
    exists, the stamps equal the account's and the grant's current values,
    the user is active, the app is not frozen. Returns
    ``(user, access_token_row, claims)``; raises:class:`InvalidAccessToken`
    with ``code`` ``invalid_token`` or ``token_revoked``.
    """
    claims = decode_access_token(raw, audience=audience)

    from .models import AccessToken, AppAuthorization

    checksum = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    row = (
        AccessToken.objects.select_related("user", "application")
        .filter(token_checksum=checksum)
        .first()
    )
    if row is None:
        # Deleted: the family was revoked, the grant bumped, or it never
        # existed here. Spec §6.3 calls that `token_revoked`.
        raise InvalidAccessToken("token_revoked", "no such token")
    if row.is_expired():
        raise InvalidAccessToken("invalid_token", "expired")
    user = row.user
    application = row.application
    if not user.is_active:
        raise InvalidAccessToken("invalid_token", "inactive user")
    if application.frozen:
        raise InvalidAccessToken("invalid_token", "frozen app")
    if str(user.public_id) != claims["sub"] or application.client_id != claims["client_id"]:
        raise InvalidAccessToken("invalid_token", "claims do not match the row")
    # Legacy tokens may omit the additive ledger binding until refresh. When
    # present it must agree with the actual application, never the opaque client_id.
    if "app_id" in claims and claims["app_id"] != str(application.pk):
        raise InvalidAccessToken("invalid_token", "ledger app binding does not match the row")
    # `user` was loaded by the same query as the token row: one snapshot.
    current_epoch = user.kt_account_epoch
    if claims["aep"] != current_epoch or row.account_epoch != current_epoch:
        raise InvalidAccessToken("token_revoked", "stale account epoch")
    grant = (
        AppAuthorization.objects.filter(user_id=user.pk, application_id=application.pk)
        .values_list("generation", "revoked_at")
        .first()
    )
    if grant is None or grant[1] is not None:
        raise InvalidAccessToken("token_revoked", "grant revoked")
    if grant[0] != claims["agen"] or row.grant_generation != claims["agen"]:
        raise InvalidAccessToken("token_revoked", "stale grant generation")
    return user, row, claims


class OAuth2JWTAuthentication(BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        raw = _bearer_token(request)
        if raw is None:
            return None
        view = (request.parser_context or {}).get("view")
        required = getattr(view, "required_scopes", None)
        if required is None:
            # DEFAULT DENY. The view never decided what an app may do here.
            raise exceptions.AuthenticationFailed(
                _("OAuth access tokens are not accepted by this endpoint."),
                code="oauth_not_accepted",
            )
        audience = getattr(view, "oauth_audience", AUD_API)
        try:
            user, row, claims = verify_bearer(raw, audience=audience)
        except InvalidAccessToken as exc:
            logger.info("oidc: bearer refused (%s): %s", exc.code, exc.reason)
            raise exceptions.AuthenticationFailed(
                _("Invalid token."), code=exc.code,
            ) from None
        token_scopes = set(scope_list(claims["scope"]))
        if not set(required) <= token_scopes:
            raise InsufficientScope(required)
        return (user, OAuthAccessToken(claims, row, row.application))

    def authenticate_header(self, request):
        return 'Bearer realm="f2z"'


class OAuth2JWTScheme(OpenApiAuthenticationExtension):
    """The published ``oauth2Jwt`` security scheme.

    Attached ONLY to operations whose view declares ``required_scopes`` --
    with exactly those scopes -- because the authenticator refuses OAuth
    tokens everywhere else. Advertising it on every operation would tell
    generated clients that a token opens doors it does not.

    The flow URLs name the published issuer rather than the local
    CANONICAL_ORIGIN so the committed ``f2z.yaml`` documents the real
    endpoints and stays byte-identical between local and CI generation.
    """

    target_class = "dj.apps.oidc.authentication.OAuth2JWTAuthentication"
    name = "oauth2Jwt"

    def get_security_definition(self, auto_schema):
        return {
            "type": "oauth2",
            "description": (
                "Free2Z OAuth 2.0 / OpenID Connect (authorization code + PKCE "
                "S256). The access token is an ES256 JWT (RFC 9068) valid for "
                "five minutes; see zuu docs/free2z/sdk/spec/oidc.md."
            ),
            "flows": {
                "authorizationCode": {
                    "authorizationUrl": f"{PUBLIC_ISSUER}/oauth/authorize",
                    "tokenUrl": f"{PUBLIC_ISSUER}/api/oauth/token",
                    "refreshUrl": f"{PUBLIC_ISSUER}/api/oauth/token",
                    "scopes": {
                        scope: description
                        for scope, description in _scope_descriptions().items()
                    },
                }
            },
        }

    def get_security_requirement(self, auto_schema):
        required = getattr(auto_schema.view, "required_scopes", None)
        if not required:
            return None
        return {self.name: list(required)}


def _scope_descriptions() -> dict:
    from django.conf import settings

    configured = settings.OAUTH2_PROVIDER.get("SCOPES", {})
    return {scope: configured.get(scope, scope) for scope in ALL_SCOPES}
