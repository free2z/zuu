"""Django authentication boundary for hosted MCP."""
from urllib.parse import urlsplit

from django.conf import settings
from django.http import HttpResponseNotAllowed, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework.exceptions import APIException

from .server import create_server
from .transport import TransportPolicy, serve_mcp


def _challenge():
    from dj.apps.oidc.mcp import mcp_resource
    resource = urlsplit(mcp_resource())
    metadata = f"{resource.scheme}://{resource.netloc}/.well-known/oauth-protected-resource/api/mcp"
    response = JsonResponse({"error": "invalid_token", "detail": "Connect Free2Z to authorize this MCP client."}, status=401)
    response["WWW-Authenticate"] = f'Bearer resource_metadata="{metadata}"'
    response["Cache-Control"] = "no-store"
    return response


def _bearer(request):
    value = request.headers.get("Authorization", "")
    if len(value) > 16384 or not value.isascii():
        return None
    parts = value.split()
    return parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else None


@csrf_exempt
def mcp_endpoint(request):
    # This endpoint has no ambient/session-cookie authentication. A saved
    # browser session therefore cannot change its connection or action account.
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    from dj.apps.g12f.models import Creator
    from dj.apps.oidc.mcp import authenticate_mcp, mcp_resource
    from dj.apps.oidc.tokens import InvalidAccessToken
    from dj.free2z.throttling import AuthenticatedUserRateThrottle

    raw = _bearer(request)
    if raw is None:
        return _challenge()
    try:
        principal = authenticate_mcp(raw)
        owner = Creator.objects.get(pk=principal.user_id)
    except (APIException, InvalidAccessToken, Creator.DoesNotExist):
        return _challenge()
    # The HTTP request's audit identity is the connection owner. Individual
    # tools resolve and audit their separate explicitly selected action actor.
    request.user = owner
    throttle = AuthenticatedUserRateThrottle()
    if not throttle.allow_request(request, None):
        response = JsonResponse({"error": "rate_limited"}, status=429)
        response["Retry-After"] = str(max(1, int(throttle.wait() or 1)))
        return response
    resource = urlsplit(mcp_resource())
    origin = f"{resource.scheme}://{resource.netloc}"
    origins = {origin, *getattr(settings, "MCP_ALLOWED_ORIGINS", ())}
    supplied_origin = request.headers.get("Origin", "")
    if supplied_origin and supplied_origin not in origins:
        from dj.apps.oidc.cors import origin_is_registered
        if origin_is_registered(supplied_origin):
            origins.add(supplied_origin)
    return serve_mcp(
        request,
        lambda: create_server(raw, request),
        TransportPolicy(allowed_hosts=(resource.netloc,), allowed_origins=tuple(origins)),
    )


def protected_resource_metadata(request):
    from dj.apps.oidc.mcp import ProtectedResourceMetadataView
    return ProtectedResourceMetadataView.as_view()(request)


def authorization_server_metadata(request):
    from dj.apps.oidc.mcp import AuthorizationServerMetadataView
    return AuthorizationServerMetadataView.as_view()(request)
