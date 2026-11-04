"""Fail-closed public boundary for the dedicated native-return hostname."""

from django.http import HttpResponse

from .native_return import read_bridge_token
from .return_origin import (
    NATIVE_RETURN_PATHS,
    native_return_origin_is_local,
    native_return_request_is_allowed,
    request_uses_native_return_host,
)


# Django's APPEND_SLASH would redirect these to the canonical routes *with the
# credential-bearing query string intact*. On the canonical host that redirect
# is served by the normal backend, whose nginx access log is not the callback
# host's no-logging edge -- so the signed state would be written to a log for
# its full lifetime. The server only ever mints trailing-slash return URLs, so
# no legitimate link is slashless and refusing them costs nothing.
SLASHLESS_RETURN_PATHS = frozenset(
    path.rstrip("/") for path in NATIVE_RETURN_PATHS
)


def _private_not_found():
    response = HttpResponse("Not found.", status=404, content_type="text/plain")
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Robots-Tag"] = "noindex, nofollow"
    return response


class NativeCheckoutReturnBoundaryMiddleware:
    """Expose only the two HTTPS landing routes on the callback hostname."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        on_return_host = request_uses_native_return_host(request)
        if not native_return_origin_is_local():
            if on_return_host and request.path not in NATIVE_RETURN_PATHS:
                return _private_not_found()
            if request.path in SLASHLESS_RETURN_PATHS:
                # Refuse before CommonMiddleware can turn this into a
                # query-preserving redirect on a logged backend.
                return _private_not_found()
            if request.path in NATIVE_RETURN_PATHS:
                purpose = "success" if request.path.endswith("success/") else "cancel"
                payload = read_bridge_token(request.GET.get("state"), purpose)
                if (
                    (payload is None and not on_return_host)
                    or (
                        payload is not None
                        and not native_return_request_is_allowed(request, payload)
                    )
                ):
                    # Reject before DRF admission can reserve provider capacity
                    # on the main deployment. Only bounded v1 drain links may
                    # reach their original canonical host.
                    return _private_not_found()
        response = self.get_response(request)
        if on_return_host:
            response["Cache-Control"] = "no-store"
            response["Referrer-Policy"] = "no-referrer"
            response["X-Robots-Tag"] = "noindex, nofollow"
        return response
