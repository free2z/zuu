"""The oauthlib request validator: the platform's rules on top of the library's.

What this adds to ``oauth2_provider.oauth2_validators.OAuth2Validator``:

* PKCE S256 for every client and an explicit scope list (no defaults).
* Refresh-token families with reuse detection -- the library revokes the
  family; this bumps the grant generation (``agen``) too, so an access token
  minted from the stolen chain dies with it -- and the stale-epoch refusal
  of spec §6.2.
* The stamps: ``account_epoch`` and ``grant_generation`` on every token row,
  and the consenting session's ``auth_time``/``acr``/``amr`` carried from the
  authorization code into the tokens.
* A refresh token only where ``offline_access`` was granted (spec §8).
* The ID-token and userinfo claims (spec §4, §7).
* Revocation: a refresh token revokes its family; an access token is
  ``unsupported_token_type`` (spec §9.5).
"""
from __future__ import annotations

import hashlib
import logging
from datetime import timedelta

from django.utils import timezone
from oauth2_provider.oauth2_validators import OAuth2Validator
from oauth2_provider.settings import oauth2_settings
from oauthlib.oauth2.rfc6749 import errors

from dj.apps.ktauth.epoch import account_epoch_for
from dj.apps.ktauth.signing import AuthorityUnavailable

from . import consent
from .models import AccessToken, AppAuthorization, AuthorizationCode, RefreshToken
from .scopes import ALL_SCOPES, SCOPE_OFFLINE_ACCESS, scope_list
from .tokens import is_jwt

logger = logging.getLogger(__name__)


def _confirmed_email(user):
    """The account's confirmed recovery address, or ``None``.

    ``emails.Email`` is a OneToOne (``email_address``); the row exists before
    it is confirmed, so ``confirmed_at`` decides.
    """
    email = getattr(user, "email_address", None)
    if email is None:
        return None
    return email


def _claim_email(request):
    row = _confirmed_email(request.user)
    if row is not None:
        return row.email
    return request.user.email or None


def _claim_email_verified(request):
    row = _confirmed_email(request.user)
    if row is not None:
        return row.confirmed_at is not None
    return False if request.user.email else None


def _claim_name(request):
    return request.user.full_name or None


def _claim_picture(request):
    getter = getattr(request.user, "get_avatar_url_safe", None)
    if getter is None:
        return None
    return getter() or None


class F2ZOAuth2Validator(OAuth2Validator):
    oidc_claim_scope = {
        "sub": "openid",
        "preferred_username": "profile",
        "name": "profile",
        "picture": "profile",
        "email": "email",
        "email_verified": "email",
    }

    # ------------------------------------------------------------ requests
    def _check_secret(self, provided_secret, stored_secret):
        # A public client has NO secret (an empty column). The library would
        # compare "" with "" and call that authenticated.
        if not stored_secret or not provided_secret:
            return False
        return super()._check_secret(provided_secret, stored_secret)

    def is_pkce_required(self, client_id, request):
        # Spec §1: for every client, public and confidential.
        return True

    def get_default_scopes(self, client_id, request, *args, **kwargs):
        # No implicit scope: a request without `scope` is `invalid_scope`.
        return []

    def validate_scopes(self, client_id, scopes, client, request, *args, **kwargs):
        wanted = set(scope_list(scopes))
        if not wanted:
            return False
        return wanted <= set(ALL_SCOPES) and wanted <= set(client.allowed_scope_list)

    def validate_silent_login(self, request):
        # `prompt=none` is decided in the authorize view, which knows the
        # Django session, the grant and the redirect shape. oauthlib only
        # needs these not to raise NotImplementedError.
        return True

    def validate_silent_authorization(self, request):
        return True

    def confirm_redirect_uri(self, client_id, code, redirect_uri, client, *args, **kwargs):
        # Spec §9.4: a redirect mismatch at the token endpoint is
        # `invalid_grant` ("sign in again"), not oauthlib's `invalid_request`.
        if not super().confirm_redirect_uri(client_id, code, redirect_uri, client, *args, **kwargs):
            request = args[0] if args else kwargs.get("request")
            raise errors.InvalidGrantError(
                description="redirect_uri does not match the authorization request",
                request=request,
            )
        return True

    # ---------------------------------------------------- authorization code
    def _create_authorization_code(self, request, code, expires=None):
        import json

        if not expires:
            expires = timezone.now() + timedelta(
                seconds=oauth2_settings.AUTHORIZATION_CODE_EXPIRE_SECONDS
            )
        if request.code_challenge_method != "S256":
            raise errors.InvalidRequestError(
                description="PKCE with code_challenge_method=S256 is required",
                request=request,
            )
        try:
            account_epoch = account_epoch_for(request.user.pk)
        except AuthorityUnavailable:
            raise errors.TemporarilyUnavailableError(
                description="account epoch unavailable", status_code=503, request=request,
            ) from None
        context = getattr(request, "f2z_auth_context", None) or {}
        return AuthorizationCode.objects.create(
            application=request.client,
            user=request.user,
            code=code["code"],
            expires=expires,
            redirect_uri=request.redirect_uri,
            scope=" ".join(request.scopes),
            code_challenge=request.code_challenge or "",
            code_challenge_method=request.code_challenge_method or "",
            nonce=request.nonce or "",
            claims=json.dumps(request.claims or {}),
            resource=getattr(request, "resource", []),
            account_epoch=account_epoch,
            auth_time=context.get("auth_time"),
            acr=context.get("acr") or "",
            amr=list(context.get("amr") or []),
        )

    def validate_code(self, client_id, code, client, request, *args, **kwargs):
        try:
            grant = AuthorizationCode.objects.select_related("user").get(
                code=code, application=client,
            )
        except AuthorizationCode.DoesNotExist:
            return False
        if grant.redeemed_at is not None:
            # RFC 6749 §4.1.2: a replayed code revokes what its first
            # redemption issued. Checked before expiry so a replay of an
            # expired-but-redeemed code still revokes.
            self._revoke_code_issue(grant)
            logger.warning(
                "oidc: authorization code replayed; tokens of its first "
                "redemption revoked user=%s client=%s", grant.user_id, client.client_id,
            )
            return False
        if grant.is_expired():
            return False
        if not grant.user.is_active:
            return False
        # A code minted before an ownership event is not redeemable after it
        # (codex adversarial review): compare the stamp with the row, now.
        try:
            current_epoch = account_epoch_for(grant.user_id)
        except AuthorityUnavailable:
            return False
        if grant.account_epoch != current_epoch:
            logger.info(
                "oidc: code refused, stale account epoch (%s != %s) user=%s",
                grant.account_epoch, current_epoch, grant.user_id,
            )
            return False
        request.scopes = grant.scope.split(" ")
        request.user = grant.user
        if grant.nonce:
            request.nonce = grant.nonce
        if grant.claims:
            import json

            request.claims = json.loads(grant.claims)
        # For the token generator: the consenting session's auth context.
        request.f2z_authorization_code = grant
        return True

    @staticmethod
    def _revoke_code_issue(grant) -> None:
        if grant.redeemed_family:
            RefreshToken.revoke_family(grant.redeemed_family)
        if grant.redeemed_access_token_id:
            AccessToken.objects.filter(pk=grant.redeemed_access_token_id).delete()

    def invalidate_authorization_code(self, client_id, code, request, *args, **kwargs):
        """Mark the code redeemed instead of deleting it (RFC 6749 §4.1.2).

        oauthlib calls this AFTER ``save_bearer_token``, so the tokens the
        redemption issued are known here and recorded on the code row. A
        row that is already redeemed, or gone, is ``invalid_grant`` exactly
        as the library's delete-based version answers.
        """
        access_token = getattr(request, "f2z_minted_access_token", None)
        refresh_token = getattr(request, "f2z_minted_refresh_token", None)
        updated = AuthorizationCode.objects.filter(
            code=code, application=request.client, redeemed_at__isnull=True,
        ).update(
            redeemed_at=timezone.now(),
            redeemed_family=getattr(refresh_token, "token_family", None),
            redeemed_access_token=access_token,
        )
        if not updated:
            # Two redemptions of one code raced past validate_code and both
            # saved tokens; this one lost the compare-and-set. RFC 6749
            # §4.1.2 applies to BOTH chains: the winner's (recorded on the
            # row) and the one this request just minted -- oauthlib turns
            # the error below into a response, it does not roll the saved
            # tokens back (codex adversarial review, round 2).
            grant = AuthorizationCode.objects.filter(code=code, application=request.client).first()
            if grant is not None:
                self._revoke_code_issue(grant)
            if refresh_token is not None and refresh_token.token_family:
                RefreshToken.revoke_family(refresh_token.token_family)
            if access_token is not None:
                AccessToken.objects.filter(pk=access_token.pk).delete()
            logger.warning(
                "oidc: concurrent redemption of one authorization code; both "
                "token chains revoked client=%s", request.client.client_id,
            )
            raise errors.InvalidGrantError(request=request)

    # -------------------------------------------------------- refresh tokens
    def get_original_scopes(self, refresh_token, request, *args, **kwargs):
        """The scopes a refresh may carry forward: the token's, narrowed to
        the grant's CURRENT scopes.

        A user who reduced the grant's scopes at /account/apps gets a
        refreshed token with what remains, automatically; an explicit
        ``scope`` wider than this is ``invalid_scope`` (oauthlib checks the
        request against what this returns). Spec §5 "reducing scopes takes
        effect immediately" and §9.4 "a refresh can never widen".
        """
        original = scope_list(super().get_original_scopes(refresh_token, request, *args, **kwargs))
        rt = request.refresh_token_instance
        authorization = AppAuthorization.objects.live().filter(
            user_id=rt.user_id, application_id=rt.application_id,
        ).first()
        if authorization is None:
            return []
        current = set(authorization.scope_list)
        return [s for s in original if s in current]

    def validate_refresh_token(self, refresh_token, client, request, *args, **kwargs):
        checksum = hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()
        presented = (
            RefreshToken.objects.filter(token_checksum=checksum)
            .select_related("access_token", "user", "application")
            .order_by("-revoked")
            .first()
        )
        # "Reuse" (spec §8) is presenting a revoked token whose FAMILY is
        # still alive: the only way a token is revoked while a descendant
        # lives is rotation, so the presenter holds a token that was consumed
        # to mint that descendant. A deliberate revocation (RFC 7009, a grant
        # revocation, an earlier reuse) revokes the whole family, so a client
        # retrying after its own logout is merely `invalid_grant` and never
        # signs every other device out. Read BEFORE the library's check, which
        # revokes the family. (Not "does the successor access token still
        # exist": after two rotations it does not -- codex adversarial review.)
        reuse = False
        if presented is not None and presented.revoked is not None and presented.token_family:
            reuse = RefreshToken.objects.filter(
                token_family=presented.token_family, revoked__isnull=True,
            ).exists()
        ok = super().validate_refresh_token(refresh_token, client, request, *args, **kwargs)
        if not ok:
            if reuse:
                # The library has just revoked the family
                # (REFRESH_TOKEN_REUSE_PROTECTION). Spec §8 +: the grant
                # generation moves too, so an access token already minted
                # from the stolen chain is refused by every resource server
                # within the publication delay rather than living out its
                # five minutes.
                consent.bump_generation_for_reuse(presented)
                logger.warning(
                    "oidc: refresh token reuse for user=%s client=%s family=%s; "
                    "family revoked and grant generation bumped",
                    presented.user_id, client.client_id, presented.token_family,
                )
            return False

        rt = request.refresh_token_instance
        if not rt.user.is_active:
            # A ban (`Creator.ban_and_soft_delete`) does not move the epoch;
            # the account must still stop minting (codex adversarial review).
            RefreshToken.revoke_family(rt.token_family)
            return False
        # Spec §6.2: a stale epoch invalidates every refresh token of the
        # account. The stamp is compared with the row, read now.
        try:
            current_epoch = account_epoch_for(rt.user_id)
        except AuthorityUnavailable:
            return False
        if rt.account_epoch != current_epoch:
            RefreshToken.revoke_family(rt.token_family)
            # The account id only: nothing derived from the presented token
            # reaches a log line (dj/apps/test_credential_logging_guard.py).
            logger.info(
                "oidc: refresh refused, stale account epoch; family revoked user=%s",
                request.user.pk,
            )
            return False
        if not AppAuthorization.objects.live().filter(
            user_id=rt.user_id, application_id=rt.application_id,
        ).exists():
            RefreshToken.revoke_family(rt.token_family)
            return False
        return True

    def _save_bearer_token(self, token, request, *args, **kwargs):
        if (
            request.grant_type == "authorization_code"
            and SCOPE_OFFLINE_ACCESS not in scope_list(request.scopes)
        ):
            # Spec §8: a refresh token only where offline_access was granted.
            # `token` is the dict the endpoint serializes, so removing it here
            # keeps it out of the response as well as the database.
            token.pop("refresh_token", None)
        return super()._save_bearer_token(token, request, *args, **kwargs)

    def _create_access_token(self, expires, request, token, source_refresh_token=None):
        context = request.f2z_token_context
        id_token = token.get("id_token", None)
        if id_token:
            id_token = self._load_id_token(id_token)
        access_token = AccessToken(
            user=request.user,
            scope=token["scope"],
            expires=expires,
            id_token=id_token,
            application=request.client,
            source_refresh_token=source_refresh_token,
            resource=getattr(request, "resource", []),
            account_epoch=context.account_epoch,
            grant_generation=context.grant_generation,
            auth_time=context.auth_time,
            acr=context.acr,
            amr=list(context.amr),
        )
        self._set_token_value(access_token, token["access_token"])
        access_token.save()
        request.f2z_minted_access_token = access_token
        return access_token

    def _create_refresh_token(self, request, refresh_token_code, access_token, previous_refresh_token):
        import uuid

        context = request.f2z_token_context
        if previous_refresh_token:
            token_family = previous_refresh_token.token_family
        else:
            token_family = uuid.uuid4()
        refresh_token = RefreshToken(
            user=request.user,
            application=request.client,
            access_token=access_token,
            token_family=token_family,
            resource=getattr(request, "resource", []),
            account_epoch=context.account_epoch,
        )
        self._set_token_value(refresh_token, refresh_token_code)
        refresh_token.save()
        request.f2z_minted_refresh_token = refresh_token
        return refresh_token

    # ----------------------------------------------------------- revocation
    def revoke_token(self, token, token_type_hint, request, *args, **kwargs):
        # Only refresh tokens reach here: `RevokeView` answers a JWT with
        # `unsupported_token_type` before oauthlib runs (spec §9.5), and
        # oauthlib does not catch an error raised from this hook.
        if is_jwt(token):
            return
        application_pk = getattr(request.client, "pk", None)
        if application_pk is None:
            return
        checksum = hashlib.sha256(token.encode("utf-8")).hexdigest()
        families = set(
            RefreshToken.objects.filter(
                token_checksum=checksum, application_id=application_pk,
            ).values_list("token_family", flat=True)
        )
        for family in families:
            RefreshToken.revoke_family(family)

    # --------------------------------------------------------------- claims
    def get_claim_dict(self, request):
        # `sub` is the public UUID (spec §6.1), never the sequential pk the
        # library would use.
        claims = {"sub": lambda r: str(r.user.public_id)}
        claims.update(self.get_additional_claims())
        return claims

    def get_additional_claims(self):
        # Request-agnostic (one-argument) form, so discovery can list the
        # claims without a request in hand.
        return {
            "preferred_username": lambda r: r.user.username,
            "name": _claim_name,
            "picture": _claim_picture,
            "email": _claim_email,
            "email_verified": _claim_email_verified,
        }

    def get_oidc_claims(self, token, token_handler, request):
        claims = super().get_oidc_claims(token, token_handler, request)
        # A claim with nothing to say is omitted, not sent as null.
        return {k: v for k, v in claims.items() if v is not None}

    def get_id_token_dictionary(self, token, token_handler, request):
        claims = self.get_oidc_claims(token, token_handler, request)
        expiration_time = timezone.now() + timedelta(
            seconds=oauth2_settings.ID_TOKEN_EXPIRE_SECONDS
        )
        import uuid

        claims.update({
            "iss": self.get_oidc_issuer_endpoint(request),
            "exp": int(expiration_time.timestamp()),
            "jti": str(uuid.uuid4()),
        })
        context = getattr(request, "f2z_token_context", None)
        if context is not None:
            # The consenting session's REAL last authentication (spec §12),
            # not the library's `user.last_login`; omitted when the session
            # recorded none rather than invented.
            if context.auth_time is not None:
                claims["auth_time"] = int(context.auth_time.timestamp())
            if context.acr:
                claims["acr"] = context.acr
            if context.amr:
                claims["amr"] = list(context.amr)
        return claims, expiration_time


def userinfo_claims(user, scopes) -> dict:
    """The claims ``userinfo_endpoint`` returns for these granted scopes."""

    class _Request:
        pass

    fake = _Request()
    fake.user = user
    fake.scopes = scope_list(scopes)
    validator = F2ZOAuth2Validator()
    claims = validator.get_oidc_claims(None, None, fake)
    claims["sub"] = str(user.public_id)
    return claims
