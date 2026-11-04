"""The SDK contract root, ``/api/sdk/v1/*`` ( Pillar 4, ).

Every non-2xx under this prefix answers with the envelope of zuu
``docs/free2z/sdk/spec/errors.md`` §1::

    {"error": {"code": "...", "message": "...", "details": {...}}}

-- including the answers DRF produces itself (401/403 from authentication and
``insufficient_scope``, 404, 405, 429 from a throttle, a 500 from an
unexpected exception). It is scoped to this prefix: every view under it
subclasses:class:`SdkAPIView`, the URLconf ends in:class:`SdkNotFoundView`
so an unknown path is an envelope 404 too, and
``dj/apps/test_sdk_envelope.py`` walks the URLconf to keep it that way. The
rest of the API keeps ``REST_FRAMEWORK['EXCEPTION_HANDLER']``.

Authentication order differs from the project default on purpose:
``OAuth2JWTAuthentication`` first, so an unauthenticated request is a
``401`` with ``WWW-Authenticate: Bearer`` (DRF takes the challenge from the
FIRST authenticator; session has none and would make it a 403). Knox keeps
its own ``Token`` keyword, so the order changes nothing about which
credential a request carries.
"""
from __future__ import annotations

import logging

from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import exceptions, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView, exception_handler as drf_exception_handler, set_rollback

from dj.apps.ktauth.authentication import AccountEpochTokenAuthentication
from dj.apps.oidc.authentication import InsufficientScope, OAuth2JWTAuthentication

logger = logging.getLogger(__name__)

SDK_PREFIX = "/api/sdk/v1/"

#errors.md §2: the only two 401 codes a client switches on.
_TOKEN_CODES = frozenset({"invalid_token", "token_revoked"})


def envelope(status_code: int, code: str, message: str, details: dict | None = None, headers=None) -> Response:
    body = {"code": code, "message": message}
    if details:
        body["details"] = details
    response = Response({"error": body}, status=status_code, headers=headers)
    response["Cache-Control"] = "no-store"
    return response


def _message(detail, fallback: str) -> str:
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict) and isinstance(detail.get("detail"), str):
        return detail["detail"]
    return fallback


def _code_and_details(exc, status_code):
    if isinstance(exc, InsufficientScope):
        required = exc.detail.get("required_scopes", []) if isinstance(exc.detail, dict) else []
        return "insufficient_scope", {"scope": " ".join(str(s) for s in required)}
    if isinstance(exc, exceptions.NotAuthenticated):
        return "invalid_token", {"reason": "missing"}
    if isinstance(exc, exceptions.AuthenticationFailed):
        code = exc.get_codes()
        return (code if code in _TOKEN_CODES else "invalid_token"), None
    if isinstance(exc, exceptions.Throttled):
        return "rate_limited", None
    if isinstance(exc, (exceptions.NotFound, Http404)):
        return "not_found", None
    if isinstance(exc, exceptions.MethodNotAllowed):
        return "method_not_allowed", None
    if isinstance(exc, (exceptions.ParseError, exceptions.ValidationError, exceptions.UnsupportedMediaType)):
        return "invalid_request", None
    if isinstance(exc, exceptions.PermissionDenied):
        return "forbidden", None
    code = exc.get_codes() if isinstance(exc, exceptions.APIException) else None
    if isinstance(code, str) and code:
        return code, None
    return ("internal_error" if status_code >= 500 else "invalid_request"), None


def sdk_exception_handler(exc, context):
    """DRF's handler for the headers and status, then the envelope."""
    response = drf_exception_handler(exc, context)
    if response is None:
        # Not an APIException: an unexpected error. Logged with its traceback
        # (it would otherwise have been Django's 500), answered in the
        # envelope, and anything the request wrote is rolled back.
        logger.error("sdk: unhandled exception", exc_info=exc)
        set_rollback()
        return envelope(status.HTTP_500_INTERNAL_SERVER_ERROR, "internal_error",
                        "The server could not complete the request.")
    code, details = _code_and_details(exc, response.status_code)
    headers = {
        name: response[name]
        for name in ("WWW-Authenticate", "Retry-After", "Allow")
        if response.has_header(name)
    }
    return envelope(
        response.status_code, code,
        _message(response.data, response.status_text or "Error"),
        details, headers=headers,
    )


class SdkAPIView(APIView):
    """Base for every view under ``/api/sdk/v1/``."""

    authentication_classes = [
        OAuth2JWTAuthentication,
        SessionAuthentication,
        AccountEpochTokenAuthentication,
    ]

    def get_exception_handler(self):
        return sdk_exception_handler


@extend_schema(exclude=True)
class SdkNotFoundView(SdkAPIView):
    """The last pattern under the prefix: an unknown SDK path is an envelope
    404, whatever the method, and authenticates nothing. Not in f2z.yaml:
    it is the absence of an endpoint."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def _not_found(self, request, *args, **kwargs):
        raise exceptions.NotFound("No such SDK endpoint.")

    get = post = put = patch = delete = head = options = _not_found
