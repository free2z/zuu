"""Host-level boundary for Stripe's credential-bearing native returns."""

from __future__ import annotations

import hmac
from urllib.parse import urlsplit

from django.conf import settings

NATIVE_RETURN_PATHS = frozenset({
    "/api/stripe/native-return/success/",
    "/api/stripe/native-return/cancel/",
})
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "testserver"})


class NativeReturnOriginInvalid(ValueError):
    pass


def _bare_origin(value, setting_name):
    if not isinstance(value, str) or not value or value != value.strip():
        raise NativeReturnOriginInvalid(f"{setting_name} is not a non-empty origin")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as exc:
        raise NativeReturnOriginInvalid(f"{setting_name} is malformed") from exc
    if (
        not parts.scheme
        or not parts.hostname
        or parts.path
        or parts.query
        or parts.fragment
        or parts.username
        or parts.password
    ):
        raise NativeReturnOriginInvalid(f"{setting_name} is not a bare origin")
    return parts, port


def _expected_native_return_parts():
    """Derive the deployed callback boundary without trusting its setting."""
    canonical, port = _bare_origin(settings.CANONICAL_ORIGIN, "CANONICAL_ORIGIN")
    hostname = canonical.hostname.lower()
    if hostname in _LOCAL_HOSTS:
        _origin, parts = validated_native_return_origin()
        return parts
    if canonical.scheme != "https" or port is not None:
        raise NativeReturnOriginInvalid(
            "deployed canonical origin must use HTTPS without a port"
        )
    return urlsplit(f"https://checkout-return.{hostname}")


def validated_native_return_origin():
    """Return the configured origin, rejecting a shared production host."""
    value = getattr(settings, "ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN", None)
    parts, port = _bare_origin(value, "ZUULI_NATIVE_CHECKOUT_RETURN_ORIGIN")
    hostname = parts.hostname.lower()
    if hostname in _LOCAL_HOSTS:
        if parts.scheme not in {"http", "https"}:
            raise NativeReturnOriginInvalid("local return origin must use HTTP(S)")
        return value, parts

    if parts.scheme != "https" or port is not None:
        raise NativeReturnOriginInvalid(
            "deployed native return origin must use HTTPS without a port"
        )
    canonical, canonical_port = _bare_origin(
        settings.CANONICAL_ORIGIN, "CANONICAL_ORIGIN"
    )
    if canonical.scheme != "https" or canonical_port is not None:
        raise NativeReturnOriginInvalid(
            "deployed canonical origin must use HTTPS without a port"
        )
    expected = f"checkout-return.{canonical.hostname.lower()}"
    if hostname != expected:
        raise NativeReturnOriginInvalid(
            f"native return hostname must be {expected!r}"
        )
    return value, parts


def _request_origin(request):
    """Read the routed Host, never caller-controlled X-Forwarded-Host."""
    # GCLB preserves the routed Host and the main nginx proxy overwrites Host
    # with $http_host. Neither boundary establishes X-Forwarded-Host, while
    # nginx would pass a caller-supplied value through by default. Django's
    # request.get_host() prefers that header when USE_X_FORWARDED_HOST is true,
    # so using it here would let a canonical-host request impersonate the
    # callback host and move Stripe work back onto the main worker pool.
    host = request.META.get("HTTP_HOST")
    if not isinstance(host, str) or not host:
        return None
    return request.scheme.lower(), host.lower()


def request_matches_origin(request, origin_parts):
    actual = _request_origin(request)
    if actual is None:
        return False
    expected = (origin_parts.scheme.lower(), origin_parts.netloc.lower())
    return hmac.compare_digest(actual[0], expected[0]) and hmac.compare_digest(
        actual[1], expected[1]
    )


def request_uses_native_return_host(request):
    try:
        parts = _expected_native_return_parts()
    except NativeReturnOriginInvalid:
        return False
    return request_matches_origin(request, parts)


def native_return_origin_is_local():
    try:
        parts, _port = _bare_origin(settings.CANONICAL_ORIGIN, "CANONICAL_ORIGIN")
    except NativeReturnOriginInvalid:
        return False
    return parts.hostname.lower() in _LOCAL_HOSTS


def legacy_request_is_exact_canonical(request):
    """Allow draining v1 links only on their original, byte-exact route."""
    try:
        canonical, _port = _bare_origin(settings.CANONICAL_ORIGIN, "CANONICAL_ORIGIN")
    except NativeReturnOriginInvalid:
        return False
    if not request_matches_origin(request, canonical):
        return False
    raw_uri = request.META.get("RAW_URI") or request.META.get("REQUEST_URI")
    if raw_uri is None:
        # Django's in-process test client and local runserver do not expose the
        # raw target. Gunicorn does; fail closed on deployed hosts if it ever
        # disappears, because an encoded route could otherwise reach a v1 view.
        return canonical.hostname.lower() in _LOCAL_HOSTS
    return urlsplit(raw_uri).path == request.path


def native_return_request_is_allowed(request, state_payload):
    if state_payload.get("v") == 1:
        return legacy_request_is_exact_canonical(request)
    if state_payload.get("v") != 2:
        return False
    try:
        _origin, parts = validated_native_return_origin()
    except NativeReturnOriginInvalid:
        return False
    return request_matches_origin(request, parts)
