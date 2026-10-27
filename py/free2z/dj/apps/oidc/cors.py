"""CORS for browser public clients (spec §3.1).

A browser page is a public client with no server to proxy through, so the
token, revocation, userinfo, JWKS and discovery endpoints answer preflights
for every origin registered on a public web client. django-cors-headers
asks ``check_request_enabled`` per request; this answers it from the
registry for exactly those paths and no other.
"""
from __future__ import annotations

from corsheaders.signals import check_request_enabled

def is_same_site_origin(origin: str) -> bool:
    """True when ``origin``'s host is one of our sites or under one
    (``registration_policy.FIRST_PARTY_SITES``). Unparseable is not ours."""
    from urllib.parse import urlsplit

    from .registration_policy import host_is_first_party_site

    try:
        host = urlsplit(origin).hostname
    except ValueError:
        return False
    return host_is_first_party_site(host)


OAUTH_CORS_PATHS = frozenset({
    "/api/oauth/token",
    "/api/oauth/revoke",
    "/api/oauth/userinfo",
    "/api/oauth/jwks",
    "/api/oauth/.well-known/openid-configuration",
    "/.well-known/openid-configuration",
})


def origin_is_registered(origin: str) -> bool:
    from .models import F2ZApplication

    if not origin or not origin.startswith("https://"):
        return False
    if is_same_site_origin(origin):
        #a same-site origin receives the user's Lax cookies, so it
        # never gets CORS here -- whatever a row that predates the
        # registration check says.
        return False
    for allowed in F2ZApplication.objects.filter(
        client_type=F2ZApplication.CLIENT_PUBLIC, frozen=False,
        allowed_origins__contains=origin,
    ).values_list("allowed_origins", flat=True):
        if origin in allowed.split():
            return True
    return False


#The SDK contract root: a registered browser app calls it with its
#bearer token (``POST /api/sdk/v1/purchases`` + polling), so its origin is
#allowed here -- but NEVER with credentials. ``CORS_ALLOW_CREDENTIALS`` is
#on project-wide, and ``SameSite=Lax`` is not a boundary against an app
#that registers a SAME-SITE origin (``https://stage.free2z.cash``: same
#site, different origin): its credentialed fetch would carry the user's
#session cookie and read their purchase intents. SDK apps authenticate with
#``Authorization: Bearer`` only, which needs no credentials mode, so
#:class:`SdkCorsWithoutCredentialsMiddleware` strips
#``Access-Control-Allow-Credentials`` from every response under this prefix
#(preflight and actual); the browser then refuses any credentialed read.
#then refused same-site app origins at registration
#(``registration_policy.origin_problem``) and per request
#(:func:`origin_is_registered`); stripping credentials stays as the
#second fence.
#``test_sdk_envelope.py`` pins it.
SDK_CORS_PREFIX = "/api/sdk/v1/"


def _cors_allowed(sender, request, **kwargs) -> bool:
    if request.path not in OAUTH_CORS_PATHS and not request.path.startswith(SDK_CORS_PREFIX):
        return False
    return origin_is_registered(request.headers.get("Origin", ""))


def connect() -> None:
    check_request_enabled.connect(_cors_allowed, dispatch_uid="oidc.cors")


class SdkCorsWithoutCredentialsMiddleware:
    """Listed immediately BEFORE ``corsheaders.middleware.CorsMiddleware`` so
    it wraps it and sees the preflight answer CorsMiddleware short-circuits
    with, as well as every view response. See ``SDK_CORS_PREFIX``."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith(SDK_CORS_PREFIX) and response.has_header(
            "Access-Control-Allow-Credentials"
        ):
            del response["Access-Control-Allow-Credentials"]
        return response
