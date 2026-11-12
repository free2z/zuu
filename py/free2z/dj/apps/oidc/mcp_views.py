"""OAuth discovery, client registration, and browser management for MCP."""
from __future__ import annotations

import json
from urllib.parse import urlsplit
from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.utils import extend_schema, extend_schema_serializer, OpenApiTypes
from drf_spectacular.authentication import SessionScheme
from rest_framework import serializers
from rest_framework.authentication import SessionAuthentication
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.free2z.throttling import AuthenticatedUserRateThrottle, FailClosedAuthThrottleMixin, PublicAnonRateThrottle, POLLING_THROTTLES
from .models import F2ZApplication, MCPAccountGrant, MCPConnection
from .mcp_serializers import (
    MCPConnectionsSerializer, MCPIntentSerializer, MCPLinkDecisionSerializer,
    MCPLinkEvaluationSerializer, MCPLinkResultSerializer, MCPRegistrationResultSerializer,
    MCPBrowserLinkSerializer, MCPLinkIntentResultSerializer,
)
from .scopes import MCP_SCOPES, SCOPE_OFFLINE_ACCESS, mcp_resource, scope_list, scope_string


class MCPRegistrationThrottle(FailClosedAuthThrottleMixin, PublicAnonRateThrottle):
    scope = "mcp-registration"


class PrivateResponseMixin:
    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        response["Referrer-Policy"] = "no-referrer"
        return response


class ProtectedResourceMetadataView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = POLLING_THROTTLES

    @extend_schema(responses=OpenApiTypes.OBJECT, operation_id="mcp_resource_metadata")
    def get(self, request):
        return Response({
            "resource": mcp_resource(), "resource_name": "Free2Z MCP",
            "authorization_servers": [settings.OIDC_ISSUER],
            "scopes_supported": [*MCP_SCOPES, SCOPE_OFFLINE_ACCESS],
            "bearer_methods_supported": ["header"],
        })


class AuthorizationServerMetadataView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = POLLING_THROTTLES

    @extend_schema(responses=OpenApiTypes.OBJECT, operation_id="mcp_authorization_metadata")
    def get(self, request):
        from .views import discovery_document
        return Response(discovery_document(settings.OIDC_ISSUER))


@extend_schema_serializer(component_name="MCPClientRegistration")
class RegistrationSerializer(serializers.Serializer):
    client_name = serializers.CharField(max_length=100, required=False, default="MCP client", trim_whitespace=False)
    redirect_uris = serializers.ListField(child=serializers.CharField(max_length=2048, trim_whitespace=False), min_length=1, max_length=10)
    token_endpoint_auth_method = serializers.ChoiceField(choices=["none", "client_secret_basic", "client_secret_post"], default="client_secret_basic")
    grant_types = serializers.ListField(child=serializers.ChoiceField(choices=["authorization_code", "refresh_token"]), required=False, default=["authorization_code", "refresh_token"])
    response_types = serializers.ListField(child=serializers.ChoiceField(choices=["code"]), required=False, default=["code"])
    scope = serializers.CharField(required=False, default=" ".join((*MCP_SCOPES, SCOPE_OFFLINE_ACCESS)))

    def validate(self, data):
        if set(data["grant_types"]) not in ({"authorization_code"}, {"authorization_code", "refresh_token"}) or data["response_types"] != ["code"]:
            raise serializers.ValidationError("Only authorization-code clients are supported.")
        if any("*" in uri or any(c.isspace() or ord(c) < 32 for c in uri) for uri in data["redirect_uris"]):
            raise serializers.ValidationError("Redirect URIs must be exact and contain no whitespace.")
        scopes = scope_list(data["scope"])
        if "offline_access" in scopes and "refresh_token" not in data["grant_types"]:
            raise serializers.ValidationError("offline_access requires the refresh_token grant.")
        if not scopes or not set(scopes) <= {*MCP_SCOPES, SCOPE_OFFLINE_ACCESS} or not set(scopes).intersection(MCP_SCOPES):
            raise serializers.ValidationError("Only MCP permissions and offline_access can be registered here.")
        return data


class MCPRegisterView(PrivateResponseMixin, APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [MCPRegistrationThrottle, AuthenticatedUserRateThrottle]
    parser_classes = [JSONParser]

    @extend_schema(request=RegistrationSerializer, responses={201: MCPRegistrationResultSerializer}, operation_id="mcp_register")
    def post(self, request):
        # Bound actual bytes, including chunked requests, before parsing JSON.
        body = request._request.read(16385)
        if len(body) > 16384:
            return Response({"error": "invalid_client_metadata", "error_description": "Registration exceeds 16 KiB."}, status=413)
        try:
            data = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return Response({"error": "invalid_client_metadata"}, status=400)
        if not isinstance(data, dict):
            return Response({"error": "invalid_client_metadata"}, status=400)
        # OAuth registration extension metadata is ignored, never converted into
        # privileged model fields. In particular user/first_party/markup are not
        # writable, and URL metadata is never fetched by this endpoint.
        serializer = RegistrationSerializer(data=data)
        if not serializer.is_valid():
            return Response({"error": "invalid_client_metadata", "error_description": "Invalid client name, redirect, scopes or grant configuration."}, status=400)
        values = serializer.validated_data
        from .registration_policy import name_problem
        name = values["client_name"]
        if name_problem(name, first_party=True):
            return Response({"error": "invalid_client_metadata"}, status=400)
        # Native clients often include the user-chosen server alias in their
        # name. A reserved brand alias receives a neutral, untrusted label;
        # it never becomes a first-party application or a verified identity.
        if name_problem(name, first_party=False):
            name = "MCP client"
        public = values["token_endpoint_auth_method"] == "none"
        origins = []
        if public:
            try:
                for uri in values["redirect_uris"]:
                    parsed = urlsplit(uri)
                    if parsed.scheme == "https":
                        origins.append(parsed.scheme + "://" + parsed.netloc)
            except ValueError:
                return Response({"error": "invalid_redirect_uri"}, status=400)
        app = F2ZApplication(
            name=name, user=None,
            client_type=F2ZApplication.CLIENT_PUBLIC if public else F2ZApplication.CLIENT_CONFIDENTIAL,
            redirect_uris=" ".join(values["redirect_uris"]), allowed_scopes=scope_string(values["scope"]),
            allowed_origins=" ".join(dict.fromkeys(origins)),
            first_party=False, markup_bps=0, approved_markup_bps=0,
            registration_source="dcr", mcp_token_auth_method=values["token_endpoint_auth_method"],
        )
        secret = None if public else app.issue_client_secret()
        try:
            with transaction.atomic():
                app.save()
        except DjangoValidationError:
            return Response({"error": "invalid_redirect_uri", "error_description": "Client metadata does not meet the registration policy."}, status=400)
        answer = {
            "client_id": app.client_id, "client_id_issued_at": int(timezone.now().timestamp()),
            "client_name": app.name, "redirect_uris": app.redirect_uri_list,
            "token_endpoint_auth_method": values["token_endpoint_auth_method"],
            "grant_types": values["grant_types"], "response_types": ["code"], "scope": app.allowed_scopes,
        }
        if secret:
            answer.update(client_secret=secret, client_secret_expires_at=0)
        return Response(answer, status=201)


class MCPSessionAuthentication(SessionAuthentication):
    def authenticate_header(self, request):
        return "Session"


class MCPSessionScheme(SessionScheme):
    target_class = "dj.apps.oidc.mcp_views.MCPSessionAuthentication"


class MCPSessionView(PrivateResponseMixin, APIView):
    authentication_classes = [MCPSessionAuthentication]
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]


class MCPLinkEvaluateView(MCPSessionView):
    @extend_schema(request=MCPIntentSerializer, responses=MCPLinkEvaluationSerializer, operation_id="mcp_link_evaluate")
    def post(self, request):
        from .mcp import find_intent
        intent = find_intent(request.data.get("intent"))
        connection = intent.connection
        descriptions = settings.OAUTH2_PROVIDER["SCOPES"]
        return Response({
            "expected_username": intent.expected_username, "signed_in_username": request.user.username,
            "account_matches": request.user.username == intent.expected_username,
            "application": {"name": connection.application.name, "client_id": connection.application.client_id},
            "connection": {"id": str(connection.pk), "primary_username": connection.primary_user.username},
            "scopes": scope_list(intent.scope),
            "scope_descriptions": {s: descriptions.get(s, s) for s in scope_list(intent.scope)},
            "expires_at": intent.expires_at.isoformat(),
        })

class MCPLinkView(MCPSessionView):
    @extend_schema(request=MCPLinkDecisionSerializer, responses=MCPLinkResultSerializer, operation_id="mcp_link_decide")
    def post(self, request):
        from .mcp import approve_link
        if not isinstance(request.data.get("allow"), bool):
            raise ValidationError("Choose Allow or Deny.")
        scopes = request.data.get("scopes")
        if scopes is not None and (not isinstance(scopes, list) or not all(isinstance(s, str) for s in scopes)):
            raise ValidationError("Permissions must be a list.")
        return Response(approve_link(request.data.get("intent"), request.user, allow=request.data["allow"], scopes=scopes))


def _connection_data(connection):
    from .mcp import _account_data, connection_available
    return {
        "id": str(connection.pk), "application": {"name": connection.application.name, "client_id": connection.application.client_id},
        "primary_username": connection.primary_user.username, "scopes": scope_list(connection.scope),
        "accounts": [_account_data(g) for g in connection.account_grants.select_related("user", "connection__primary_user")],
        "revoked": connection.revoked_at is not None, "available": connection_available(connection),
    }


class MCPConnectionsView(MCPSessionView):
    @extend_schema(responses=MCPConnectionsSerializer, operation_id="mcp_connections")
    def get(self, request):
        from .mcp import _account_data
        connections = MCPConnection.objects.filter(primary_user=request.user).select_related("primary_user", "application").order_by("-created_at")
        grants = MCPAccountGrant.objects.filter(user=request.user).exclude(connection__primary_user=request.user).select_related("user", "connection__primary_user", "connection__application").order_by("-consented_at")
        from .models import MCPActionAudit
        actions = MCPActionAudit.objects.filter(Q(primary_user=request.user) | Q(target_user=request.user)).select_related("primary_user", "target_user", "application").order_by("-created_at")[:50]
        return Response({
            "recent_actions": [{"id": a.pk, "operation": a.operation, "status": a.status, "created_at": a.created_at.isoformat(), "primary_username": a.primary_user.username if a.primary_user else None, "target_username": a.target_user.username if a.target_user else None, "application": a.application.name if a.application else None} for a in actions],
            "connections": [_connection_data(c) for c in connections],
            "account_grants": [{**_account_data(g), "connection_id": str(g.connection_id), "primary_username": g.connection.primary_user.username, "application": {"name": g.connection.application.name, "client_id": g.connection.application.client_id}} for g in grants],
        })


class MCPBrowserLinkView(MCPSessionView):
    """Request independent account consent for a connection owned by this session."""
    @extend_schema(request=MCPBrowserLinkSerializer, responses={201: MCPLinkIntentResultSerializer}, operation_id="mcp_connection_link")
    def post(self, request, connection_id):
        from .mcp import create_browser_link_intent
        serializer = MCPBrowserLinkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = create_browser_link_intent(request.user, connection_id, **serializer.validated_data)
        return Response(result, status=201)


class MCPConnectionRevokeView(MCPSessionView):
    @extend_schema(responses={204: None}, operation_id="mcp_connection_revoke")
    def delete(self, request, connection_id):
        with transaction.atomic():
            connection = MCPConnection.objects.select_for_update().filter(pk=connection_id, primary_user=request.user).first()
            if connection is None:
                raise PermissionDenied("This connection does not belong to your account.")
            if connection.revoked_at is None:
                connection.revoked_at = timezone.now()
                connection.save(update_fields=["revoked_at"])
        return Response(status=204)


class MCPAccountRevokeView(MCPSessionView):
    @extend_schema(responses={204: None}, operation_id="mcp_account_revoke")
    def delete(self, request, grant_id):
        with transaction.atomic():
            initial = MCPAccountGrant.objects.select_related("connection").filter(pk=grant_id).first()
            if initial is None or request.user.pk not in {initial.user_id, initial.connection.primary_user_id}:
                raise PermissionDenied("This account grant does not belong to your account.")
            # Match the actor's connection -> grant order, never lock joined
            # rows in the database planner's unspecified order.
            MCPConnection.objects.select_for_update().get(pk=initial.connection_id)
            grant = MCPAccountGrant.objects.select_for_update().get(pk=initial.pk)
            if grant.revoked_at is None:
                grant.revoked_at = timezone.now()
                grant.generation += 1
                grant.save(update_fields=["revoked_at", "generation"])
        return Response(status=204)
