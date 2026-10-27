"""The access token: an ES256 ``at+jwt`` (spec §6), minted and verified here.

Minting runs inside oauthlib's ``BearerToken.create_token`` as the configured
``ACCESS_TOKEN_GENERATOR``, which is BEFORE the validator's
``save_bearer_token``. So this is where the token's context -- the account
epoch, the grant generation, the authentication context of the consenting
session -- is resolved from the database, and it is left on the oauthlib
request (``request.f2z_token_context``) for the validator to stamp onto the
token rows and to copy into the ID token. One resolution, one set of numbers,
in every artefact of a token response.

Verification is what a resource server does with ``jwks_uri`` alone
(spec §12);:func:`decode_access_token` is that check, and
``OAuth2JWTAuthentication`` adds the database comparisons a resource server
gets from the epoch publication instead.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime

import jwt as pyjwt
from django.conf import settings
from django.utils import timezone
from oauthlib.oauth2.rfc6749 import errors

from dj.apps.ktauth.epoch import account_epoch_for
from dj.apps.ktauth.signing import AuthorityUnavailable

from .keys import ALG_ES256, SigningKeysUnavailable, get_keyring
from .scopes import audiences_for, scope_list

logger = logging.getLogger(__name__)

#Spec §6.1: five minutes, not configurable per app.
ACCESS_TOKEN_TTL_SECONDS = 300
#Spec §6.1: a resource server allows at most 30 s of clock skew.
CLOCK_SKEW_LEEWAY_SECONDS = 30
TOKEN_TYP = "at+jwt"


@dataclass(frozen=True)
class TokenContext:
    user: object
    application: object
    scopes: tuple[str, ...]
    account_epoch: int
    grant_generation: int
    auth_time: datetime | None
    acr: str
    amr: tuple[str, ...]


class InvalidAccessToken(Exception):
    """A token a resource server must refuse; ``code`` is the RFC 6750 /
    spec error code (``invalid_token`` or ``token_revoked``)."""

    def __init__(self, code: str, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def _auth_context_from(request) -> tuple[datetime | None, str, tuple[str, ...]]:
    """The consenting session's authentication context, carried forward.

    Authorization-code grant: from the code row (the validator sets
    ``request.f2z_authorization_code``). Refresh grant: from the access token
    the presented refresh token is bound to, so a refreshed token says when
    the user REALLY last authenticated (spec §12), not when it was refreshed.
    """
    code = getattr(request, "f2z_authorization_code", None)
    if code is not None:
        return code.auth_time, code.acr or "", tuple(code.amr or ())
    refresh = getattr(request, "refresh_token_instance", None)
    previous = getattr(refresh, "access_token", None) if refresh is not None else None
    if previous is not None:
        return previous.auth_time, previous.acr or "", tuple(previous.amr or ())
    return None, "", ()


def _credential_epoch(request) -> int | None:
    """The epoch stamped on the credential being redeemed, if any."""
    code = getattr(request, "f2z_authorization_code", None)
    if code is not None:
        return code.account_epoch
    refresh = getattr(request, "refresh_token_instance", None)
    if refresh is not None:
        return refresh.account_epoch
    return None


def build_token_context(request) -> TokenContext:
    """Resolve everything a token asserts, from the rows, right now.

    Raises an oauthlib error so the token endpoint answers with the spec's
    code: ``invalid_grant`` for a revoked grant or a scope outside it,
    ``server_error`` when the account's epoch is unusable (the same refusal
    ``ktauth`` makes: never substitute a counter).
    """
    from .models import AppAuthorization

    user = request.user
    application = request.client
    scopes = tuple(scope_list(request.scopes))
    if not user.is_active:
        raise errors.InvalidGrantError(
            description="the account is not active", request=request,
        )
    try:
        account_epoch = account_epoch_for(user.pk)
    except AuthorityUnavailable as exc:
        logger.error("oidc: refusing to mint a token: %s for user %s", exc.reason, user.pk)
        # Spec §6.2: a value that cannot be determined is a 503 the client
        # retries, never a substituted counter  and never a 4xx that
        # would sign the user out.
        raise errors.TemporarilyUnavailableError(
            description="account epoch unavailable", status_code=503, request=request,
        ) from None
    # The credential being redeemed (the code, or the refresh token) was
    # validated against ITS stamped epoch a moment ago. An ownership event
    # committing between that validation and this read would otherwise be
    # adopted here, stamping post-reset tokens onto a pre-reset credential
    # (codex adversarial review, round 2). The mint must carry the epoch
    # the credential was issued under, and that must still be the row's.
    credential_epoch = _credential_epoch(request)
    if credential_epoch is not None and credential_epoch != account_epoch:
        raise errors.InvalidGrantError(
            description="the account changed while the request was in flight",
            request=request,
        )

    authorization = (
        AppAuthorization.objects.live()
        .filter(user_id=user.pk, application_id=application.pk)
        .first()
    )
    if authorization is None:
        raise errors.InvalidGrantError(
            description="the grant is revoked", request=request,
        )
    outside = set(scopes) - set(authorization.scope_list)
    if outside:
        # Spec §12: a token's scope never exceeds the grant's at issue time.
        # (A refresh that names no scope was already narrowed to the grant
        # by the validator's get_original_scopes; only an explicit request
        # for more reaches here.)
        raise errors.InvalidScopeError(
            description="requested scope exceeds the grant", request=request,
        )
    if not scopes:
        raise errors.InvalidGrantError(
            description="the grant no longer covers any requested scope", request=request,
        )
    auth_time, acr, amr = _auth_context_from(request)
    context = TokenContext(
        user=user,
        application=application,
        scopes=scopes,
        account_epoch=account_epoch,
        grant_generation=authorization.generation,
        auth_time=auth_time,
        acr=acr,
        amr=amr,
    )
    request.f2z_token_context = context
    return context


def access_token_claims(context: TokenContext, *, now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    claims = {
        "iss": settings.OIDC_ISSUER,
        "sub": str(context.user.public_id),
        "aud": audiences_for(context.scopes),
        "client_id": context.application.client_id,
        # Signed ledger binding; OAuth client_id is opaque and is NOT the app UUID.
        "app_id": str(context.application.pk),
        "scope": " ".join(context.scopes),
        "iat": now,
        "exp": now + ACCESS_TOKEN_TTL_SECONDS,
        "jti": str(uuid.uuid4()),
        "aep": context.account_epoch,
        "agen": context.grant_generation,
    }
    if context.auth_time is not None:
        claims["auth_time"] = int(context.auth_time.timestamp())
    if context.acr:
        claims["acr"] = context.acr
    if context.amr:
        claims["amr"] = list(context.amr)
    # Only when true: an ordinary app's token is byte-for-byte unchanged, and
    # the gateway reads an absent claim as false (zuu spec/oidc.md §6.1).
    if context.application.child_directed:
        claims["child_directed"] = True
    return claims


def sign_access_token(claims: dict) -> str:
    key = get_keyring().active_es256
    return pyjwt.encode(
        claims,
        key.private_pem,
        algorithm=ALG_ES256,
        headers={"kid": key.kid, "typ": TOKEN_TYP},
    )


def generate_access_token(request) -> str:
    """``OAUTH2_PROVIDER['ACCESS_TOKEN_GENERATOR']``.

    Also publishes the ``aep`` and ``agen`` the token carries to Redis, on
    commit (monotonic, one-token-lifetime TTL): the gateway's map is then
    warm for every live token's lifetime and the internal epoch endpoint is
    a true fallback rather than the path every first request takes.
    """
    from . import epoch_publish

    context = build_token_context(request)
    epoch_publish.schedule_publish_account_epoch(
        context.user.public_id, context.account_epoch,
    )
    epoch_publish.schedule_publish_grant_generation(
        context.user.public_id, context.application.client_id, context.grant_generation,
    )
    try:
        return sign_access_token(access_token_claims(context))
    except SigningKeysUnavailable as exc:
        logger.error("oidc: no signing key: %s", exc)
        # The deployment story of dj.apps.oidc.checks: an unprovisioned key
        # is a loud 503 on every token request, not a generated key.
        raise errors.TemporarilyUnavailableError(
            description="signing keys unavailable", status_code=503, request=request,
        ) from None


def decode_access_token(token: str, *, audience: str, now: int | None = None) -> dict:
    """Verify an access token the way spec §6.1 tells a resource server to.

    Signature by ``kid`` (ES256 keys only -- an RS256 ID token presented as an
    access token has no matching key), ``typ: at+jwt``, ``iss`` exact,
    ``aud`` contains ``audience``, ``exp`` with 30 s leeway. Returns the
    claims. Raises:class:`InvalidAccessToken`.
    """
    try:
        header = pyjwt.get_unverified_header(token)
    except pyjwt.PyJWTError as exc:
        raise InvalidAccessToken("invalid_token", f"malformed token: {exc}") from None
    if header.get("typ") != TOKEN_TYP:
        raise InvalidAccessToken("invalid_token", "not an access token (typ)")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise InvalidAccessToken("invalid_token", "no kid")
    key = get_keyring().find(kid, ALG_ES256)
    if key is None:
        raise InvalidAccessToken("invalid_token", "unknown kid")
    try:
        claims = pyjwt.decode(
            token,
            key.public_pem,
            algorithms=[ALG_ES256],
            audience=audience,
            issuer=settings.OIDC_ISSUER,
            leeway=CLOCK_SKEW_LEEWAY_SECONDS,
            options={
                "require": ["iss", "sub", "aud", "exp", "iat", "jti", "client_id",
                            "scope", "aep", "agen"],
            },
        )
    except pyjwt.ExpiredSignatureError:
        raise InvalidAccessToken("invalid_token", "expired") from None
    except pyjwt.InvalidAudienceError:
        raise InvalidAccessToken("invalid_token", "audience mismatch") from None
    except pyjwt.InvalidIssuerError:
        raise InvalidAccessToken("invalid_token", "issuer mismatch") from None
    except pyjwt.PyJWTError as exc:
        raise InvalidAccessToken("invalid_token", f"verification failed: {exc}") from None
    if not isinstance(claims.get("aud"), list):
        raise InvalidAccessToken("invalid_token", "aud is not a list")
    for claim in ("aep", "agen"):
        if not isinstance(claims.get(claim), int) or isinstance(claims.get(claim), bool):
            raise InvalidAccessToken("invalid_token", f"{claim} is not an integer")
    if now is not None and claims["exp"] + CLOCK_SKEW_LEEWAY_SECONDS < now:
        raise InvalidAccessToken("invalid_token", "expired")
    return claims


def unverified_claims(token: str) -> dict | None:
    """The payload without verification, for introspection's lookups only."""
    try:
        return pyjwt.decode(token, options={"verify_signature": False})
    except pyjwt.PyJWTError:
        return None


def is_jwt(token: str) -> bool:
    """Whether a presented string is shaped like a JWS (three segments)."""
    if not isinstance(token, str) or token.count(".") != 2:
        return False
    try:
        pyjwt.get_unverified_header(token)
    except pyjwt.PyJWTError:
        return False
    return True


def now_aware() -> datetime:
    return timezone.now()
