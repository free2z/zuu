"""MCP connection identity and independently consented account grants.

A connection is named in its signed OAuth access token. Linking an account
never changes the browser's account or any other OAuth grant. Every action
resolves an explicit account inside that connection and checks both identities.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
import hashlib
import secrets
from uuid import UUID

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied, ValidationError

from .authentication import OAuthAccessToken, verify_bearer
from .models import AccessToken, AppAuthorization, F2ZApplication, MCPAccountGrant, MCPConnection, MCPLinkIntent
from .scopes import MCP_SCOPES, SCOPE_OFFLINE_ACCESS, mcp_resource, scope_list, scope_string
from .tokens import InvalidAccessToken

MCP_ALLOWED_SCOPES = (*MCP_SCOPES, SCOPE_OFFLINE_ACCESS)
LINK_TTL = timedelta(minutes=10)
MAX_ACCOUNTS = 20


@dataclass(frozen=True)
class MCPPrincipal:
    user_id: int
    client_id: str
    connection_id: UUID
    scopes: frozenset[str]


@dataclass(frozen=True)
class MCPActor:
    user: object
    auth: OAuthAccessToken
    connection: MCPConnection
    scopes: frozenset[str]
    account_id: UUID


def _invalid():
    return AuthenticationFailed("This MCP connection is no longer authorized.", code="invalid_token")


def authenticate_mcp(raw_token: str) -> MCPPrincipal:
    try:
        user, row, claims = verify_bearer(raw_token, audience=mcp_resource())
        connection_id = UUID(str(claims.get("mcp_connection", "")))
        connection = MCPConnection.objects.get(pk=connection_id)
    except (InvalidAccessToken, ValueError, TypeError, MCPConnection.DoesNotExist):
        raise _invalid() from None
    if (
        row.mcp_connection_id != connection_id
        or connection.primary_user_id != user.pk
        or connection.application_id != row.application_id
        or connection.primary_epoch != claims["aep"]
        or connection.primary_grant_generation != claims["agen"]
        or connection.revoked_at is not None
    ):
        raise _invalid()
    scopes = frozenset(scope_list(claims["scope"])) & frozenset(scope_list(connection.scope)) & frozenset(MCP_SCOPES)
    if not scopes:
        raise _invalid()
    return MCPPrincipal(user.pk, row.application.client_id, connection_id, scopes)


@contextmanager
def _locked_connection(raw_token: str, *, target_user_id=None):
    """Lifecycle lock order: users, app, OAuth grant, connection, token.

    Hold the locks through the caller's mutation. Recheck after acquiring them:
    a revoke that won a lock must deny the request, not become a stale snapshot.
    """
    principal = authenticate_mcp(raw_token)
    with transaction.atomic():
        user_ids = sorted({principal.user_id, *([target_user_id] if target_user_id else [])})
        users = {u.pk: u for u in get_user_model().objects.select_for_update().filter(pk__in=user_ids).order_by("pk")}
        if len(users) != len(user_ids) or any(not u.is_active for u in users.values()):
            raise _invalid()
        connection = MCPConnection.objects.get(pk=principal.connection_id)
        F2ZApplication.objects.select_for_update().get(pk=connection.application_id)
        grant = AppAuthorization.objects.select_for_update().filter(
            user_id=principal.user_id, application_id=connection.application_id,
        ).first()
        if grant is None:
            raise _invalid()
        connection = MCPConnection.objects.select_for_update().get(pk=principal.connection_id)
        checksum = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
        if not AccessToken.objects.select_for_update().filter(token_checksum=checksum).exists():
            raise _invalid()
        principal = authenticate_mcp(raw_token)
        yield principal, connection, users


def _account_data(grant, *, effective_scopes=None):
    available = (
        grant.revoked_at is None and grant.user.is_active
        and grant.account_epoch == grant.user.kt_account_epoch
        and grant.connection.revoked_at is None
        and grant.connection.primary_user.is_active
        and grant.connection.primary_epoch == grant.connection.primary_user.kt_account_epoch
        and connection_available(grant.connection)
    )
    scopes = set(scope_list(grant.scope))
    if effective_scopes is not None:
        scopes &= set(effective_scopes)
    return {
        "id": str(grant.pk), "username": grant.user.username,
        "scopes": [s for s in MCP_SCOPES if s in scopes],
        "revoked": grant.revoked_at is not None, "available": available,
    }


def list_accounts(raw_token: str) -> list[dict]:
    principal = authenticate_mcp(raw_token)
    grants = MCPAccountGrant.objects.filter(connection_id=principal.connection_id).select_related("user", "connection__primary_user").order_by("consented_at", "pk")
    return [_account_data(grant, effective_scopes=principal.scopes) for grant in grants]


def _selected_grant(connection_id, account):
    if not isinstance(account, str) or not account:
        raise ValidationError("Choose an account from list_accounts.")
    grants = MCPAccountGrant.objects.filter(connection_id=connection_id)
    try:
        account_id = UUID(account)
    except (ValueError, TypeError):
        grant = grants.filter(user__username=account).first()
    else:
        grant = grants.filter(pk=account_id).first()
    if grant is None:
        raise PermissionDenied("That account is not linked to this connection.")
    return grant


@contextmanager
def authorized_actor(raw_token: str, account: str, required_scopes):
    principal = authenticate_mcp(raw_token)
    selected = _selected_grant(principal.connection_id, account)
    with _locked_connection(raw_token, target_user_id=selected.user_id) as (principal, connection, users):
        grant = MCPAccountGrant.objects.select_for_update().get(pk=selected.pk, connection=connection)
        user = users[grant.user_id]
        if grant.revoked_at is not None or grant.account_epoch != user.kt_account_epoch:
            raise PermissionDenied("This account grant has expired or been revoked.")
        # A username is a selector, not a stable identity. Refuse a rename that
        # raced selection rather than act under a name the caller did not choose.
        if account != str(grant.pk) and account != user.username:
            raise PermissionDenied("The selected account name changed; list accounts again.")
        scopes = principal.scopes & frozenset(scope_list(grant.scope))
        if not set(required_scopes) <= scopes:
            raise PermissionDenied({"code": "insufficient_scope", "required_scopes": sorted(required_scopes)})
        _, token_row, claims = verify_bearer(raw_token, audience=mcp_resource())
        yield MCPActor(user, OAuthAccessToken(claims, token_row, token_row.application), connection, scopes, grant.pk)


def create_connection(user, application, scopes, epoch):
    """Called when an MCP authorization code is issued, within its transaction."""
    grant = AppAuthorization.objects.live().get(user=user, application=application)
    connection = MCPConnection.objects.create(
        primary_user=user, application=application, primary_epoch=epoch,
        primary_grant_generation=grant.generation, scope=scope_string(scopes),
    )
    MCPAccountGrant.objects.create(connection=connection, user=user, account_epoch=epoch, scope=scope_string(set(scopes) & set(MCP_SCOPES)))
    return connection


def create_link_intent(raw_token: str, expected_username: str, scopes=None) -> dict:
    if not isinstance(expected_username, str) or not expected_username or len(expected_username) > 150 or expected_username != expected_username.strip():
        raise ValidationError("Supply the exact Free2Z username to link, without a display prefix.")
    with _locked_connection(raw_token) as (principal, connection, _):
        wanted = list(MCP_SCOPES) if scopes is None else scope_list(scopes)
        wanted = [s for s in wanted if s in principal.scopes] if scopes is None else wanted
        if not wanted or not set(wanted) <= principal.scopes:
            raise PermissionDenied("Requested permissions exceed this connection's consent.")
        if connection.account_grants.filter(revoked_at__isnull=True).count() >= MAX_ACCOUNTS:
            raise ValidationError("Disconnect an account before linking another.")
        now = timezone.now()
        if connection.link_intents.filter(used_at__isnull=True, expires_at__gt=now).count() >= 5:
            raise ValidationError("Complete or wait for an existing account-link request.")
        opaque = secrets.token_urlsafe(32)
        intent = MCPLinkIntent.objects.create(
            token_hash=hashlib.sha256(opaque.encode()).hexdigest(), connection=connection,
            expected_username=expected_username, scope=scope_string(wanted), expires_at=now + LINK_TTL,
        )
    return {"url": settings.OIDC_ISSUER.rstrip("/") + "/account/agent-link#intent=" + opaque,
            "expires_at": intent.expires_at.isoformat(), "expected_username": expected_username}


def connection_available(connection):
    try:
        validate_connection_record(connection)
        return True
    except AuthenticationFailed:
        return False


def find_intent(opaque):
    if not isinstance(opaque, str) or len(opaque) != 43 or not all(c.isalnum() or c in "-_" for c in opaque):
        raise ValidationError("This account-link request is invalid or expired.")
    intent = MCPLinkIntent.objects.select_related("connection__primary_user", "connection__application").filter(token_hash=hashlib.sha256(opaque.encode()).hexdigest()).first()
    if intent is None or intent.used_at is not None or intent.expires_at <= timezone.now():
        raise ValidationError("This account-link request is invalid or expired.")
    validate_connection_record(intent.connection)
    return intent


def validate_connection_record(connection):
    user = connection.primary_user
    if connection.revoked_at or not user.is_active or user.kt_account_epoch != connection.primary_epoch or connection.application.frozen:
        raise _invalid()
    if not AppAuthorization.objects.live().filter(
        user=user, application=connection.application, generation=connection.primary_grant_generation,
    ).exists():
        raise _invalid()
    # A connection whose credential family has been revoked cannot accept new
    # links. Expired access tokens with a live refresh family remain connected.
    from .models import RefreshToken
    refresh_lifetime = settings.OAUTH2_PROVIDER["REFRESH_TOKEN_EXPIRE_SECONDS"]
    live_access = connection.access_tokens.filter(expires__gt=timezone.now()).exists()
    live_refresh = RefreshToken.objects.filter(
        access_token__mcp_connection=connection, revoked__isnull=True,
        access_token__expires__gt=timezone.now() - timedelta(seconds=refresh_lifetime),
    ).exists()
    if not live_access and not live_refresh:
        raise _invalid()


def approve_link(opaque, session_user, *, allow, scopes=None):
    initial = find_intent(opaque)
    if session_user.username != initial.expected_username:
        raise PermissionDenied("Sign in as the exact account named in this request.")
    session_epoch = session_user.kt_account_epoch
    with transaction.atomic():
        user_ids = sorted({initial.connection.primary_user_id, session_user.pk})
        users = {u.pk: u for u in get_user_model().objects.select_for_update().filter(pk__in=user_ids).order_by("pk")}
        target = users.get(session_user.pk)
        if target is None or not target.is_active or target.kt_account_epoch != session_epoch or target.username != initial.expected_username:
            raise _invalid()
        F2ZApplication.objects.select_for_update().get(pk=initial.connection.application_id)
        AppAuthorization.objects.select_for_update().filter(user_id=initial.connection.primary_user_id, application_id=initial.connection.application_id).first()
        connection = MCPConnection.objects.select_for_update().select_related("primary_user", "application").get(pk=initial.connection_id)
        validate_connection_record(connection)
        intent = MCPLinkIntent.objects.select_for_update().get(pk=initial.pk)
        if intent.used_at is not None or intent.expires_at <= timezone.now():
            raise ValidationError("This account-link request is invalid or expired.")
        wanted = scope_list(intent.scope) if scopes is None else scope_list(scopes)
        if allow and (not wanted or not set(wanted) <= set(scope_list(intent.scope)) or not set(wanted) <= set(scope_list(connection.scope))):
            raise PermissionDenied("The granted permissions exceed this account-link request.")
        if allow:
            if connection.account_grants.filter(revoked_at__isnull=True).exclude(user=target).count() >= MAX_ACCOUNTS:
                raise ValidationError("This connection has reached its account limit.")
            grant = MCPAccountGrant.objects.select_for_update().filter(connection=connection, user=target).first()
            if grant is None:
                grant = MCPAccountGrant(connection=connection, user=target)
            else:
                grant.generation += 1
            grant.account_epoch = target.kt_account_epoch
            grant.scope = scope_string(wanted)
            grant.revoked_at = None
            grant.consented_at = timezone.now()
            grant.save()
        intent.used_at = timezone.now()
        intent.save(update_fields=["used_at"])
        return {"linked": True, "account": _account_data(grant)} if allow else {"linked": False}


# Kept here as import aliases so transport and deployment use one module.
from .mcp_views import AuthorizationServerMetadataView, ProtectedResourceMetadataView  # noqa: E402,F401


def record_action(actor: MCPActor, operation: str, status: int):
    """Call inside the action transaction; it commits or rolls back together."""
    from .models import MCPActionAudit
    if not isinstance(operation, str) or not operation or len(operation) > 100 or not isinstance(status, int) or not 100 <= status <= 599:
        raise ValueError("Invalid audit operation or status")
    return MCPActionAudit.objects.create(
        connection=actor.connection, application_id=actor.connection.application_id,
        primary_user_id=actor.connection.primary_user_id, target_user=actor.user,
        account_grant_id=actor.account_id, operation=operation, status=status,
    )


@contextmanager
def authorized_upload(intent_id, capability):
    from .models import MCPUploadIntent
    if not isinstance(capability, str) or len(capability) != 43:
        raise PermissionDenied("Invalid upload capability.")
    try:
        initial = MCPUploadIntent.objects.select_related("access_token").get(pk=intent_id)
    except (MCPUploadIntent.DoesNotExist, ValueError, DjangoValidationError):
        raise PermissionDenied("Invalid upload capability.") from None
    if initial.access_token is None:
        raise PermissionDenied("This upload capability has expired or been revoked.")
    digest = hashlib.sha256(capability.encode()).hexdigest()
    if not secrets.compare_digest(digest, initial.capability_hash):
        raise PermissionDenied("Invalid upload capability.")
    with authorized_actor(initial.access_token.token, str(initial.account_grant_id), ["mcp:uploads"]) as actor:
        intent = MCPUploadIntent.objects.select_for_update().get(pk=initial.pk)
        grant = MCPAccountGrant.objects.get(pk=actor.account_id)
        if (
            intent.expires_at <= timezone.now()
            or intent.connection_id != actor.connection.pk
            or intent.access_token_id != actor.auth.row.pk
            or intent.grant_generation != grant.generation
            or not secrets.compare_digest(digest, intent.capability_hash)
        ):
            raise PermissionDenied("This upload capability has expired or been revoked.")
        yield actor, intent


@contextmanager
def serialize_mcp_token_request(data):
    """Order OAuth refresh/revoke against actions before token rows change.

    Looking up a credential here grants nothing. The OAuth validator still
    checks the code, PKCE, client, expiry and resource inside these locks.
    """
    from .models import AuthorizationCode, RefreshToken
    connection_id = None
    if data.get("code"):
        connection_id = AuthorizationCode.objects.filter(code=data["code"]).values_list("mcp_connection_id", flat=True).first()
    raw = data.get("refresh_token") or data.get("token")
    if raw:
        digest = hashlib.sha256(raw.encode()).hexdigest()
        connection_id = RefreshToken.objects.filter(token_checksum=digest).values_list("access_token__mcp_connection_id", flat=True).first()
    candidate = MCPConnection.objects.filter(pk=connection_id).first() if connection_id else None
    if candidate is None:
        yield
        return
    with transaction.atomic():
        get_user_model().objects.select_for_update().filter(pk=candidate.primary_user_id).first()
        F2ZApplication.objects.select_for_update().filter(pk=candidate.application_id).first()
        AppAuthorization.objects.select_for_update().filter(user_id=candidate.primary_user_id, application_id=candidate.application_id).first()
        MCPConnection.objects.select_for_update().filter(pk=candidate.pk).first()
        yield
