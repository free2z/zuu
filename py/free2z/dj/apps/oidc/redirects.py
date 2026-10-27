"""Redirect URI shapes (spec §3, RFC 8252 §7).

Three shapes are accepted, and the shape decides two things later: whether
the port is ignored when matching (loopback only) and whether a silent grant
may ever carry a money scope (never for loopback or a private-use scheme,
spec §5). Classification is one function so those two decisions cannot drift
from each other or from registration-time validation.

Matching itself is django-oauth-toolkit's ``check_redirect_to_uri_allowed``:
exact string comparison of scheme, host, path and query, with the RFC 8252
§7.3 port exemption for ``http://127.0.0.1`` and ``http://[::1]``. It refuses
fragments, userinfo and wildcards. This module only decides what may be
REGISTERED, which is stricter than what the matcher would tolerate.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

KIND_LOOPBACK = "loopback"
KIND_PRIVATE_SCHEME = "private_scheme"
KIND_HTTPS = "https"

#: RFC 8252 §7.1: a private-use scheme is a reverse-domain name the developer
#: controls: at least two labels, each starting with a letter.
_REVERSE_DNS_SCHEME = re.compile(
    r"^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$"
)
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1"})


class RedirectURIError(ValueError):
    """The URI cannot be registered; ``str(exc)`` says why, for the console."""


def classify(uri: str) -> str:
    """The shape of ``uri``, or raise :class:`RedirectURIError`.

    Registration and authorization both call this, so a URI that could not
    have been registered can never be matched either.
    """
    if not isinstance(uri, str) or not uri.strip():
        raise RedirectURIError("a redirect URI is required")
    if uri != uri.strip():
        raise RedirectURIError("a redirect URI may not carry whitespace")
    if "#" in uri:
        raise RedirectURIError("a redirect URI may not carry a fragment")
    if "?" in uri:
        # Spec §3: never a query of its own, so `?code=…&state=…&iss=…` is
        # appended unambiguously.
        raise RedirectURIError("a redirect URI may not carry a query string")
    try:
        parts = urlsplit(uri)
    except ValueError as exc:
        raise RedirectURIError(f"unparseable redirect URI: {exc}") from None
    scheme = parts.scheme
    if not scheme:
        raise RedirectURIError("a redirect URI must be absolute")
    if "@" in parts.netloc:
        raise RedirectURIError("a redirect URI may not carry credentials")

    if scheme == "http":
        host = (parts.hostname or "").lower()
        if host == "localhost":
            raise RedirectURIError(
                "`localhost` is not accepted: it may resolve off-device. "
                "Use http://127.0.0.1 or http://[::1] (RFC 8252 §8.3)"
            )
        if host not in _LOOPBACK_HOSTS:
            raise RedirectURIError(
                "`http` is accepted only for the loopback interface "
                "(http://127.0.0.1:<port>/… or http://[::1]:<port>/…)"
            )
        try:
            parts.port  # noqa: B018 -- raises on a malformed port
        except ValueError:
            raise RedirectURIError("malformed loopback port") from None
        if not parts.path.startswith("/"):
            raise RedirectURIError("a loopback redirect needs a path")
        return KIND_LOOPBACK

    if scheme == "https":
        if not parts.hostname:
            raise RedirectURIError("an https redirect needs a host")
        if parts.hostname.lower() in _LOOPBACK_HOSTS | {"localhost"}:
            raise RedirectURIError(
                "loopback redirects use http, not https (RFC 8252 §7.3)"
            )
        return KIND_HTTPS

    if not _REVERSE_DNS_SCHEME.fullmatch(scheme):
        raise RedirectURIError(
            "the scheme must be `https`, loopback `http`, or a reverse-DNS "
            "private-use scheme such as com.example.app (RFC 8252 §7.1)"
        )
    # RFC 8252 §7.1 recommends a single slash after the colon:
    # `com.example.app:/oauth/callback`. urlsplit puts `//host` into netloc,
    # so a non-empty netloc is exactly the two-slash form.
    if parts.netloc:
        raise RedirectURIError(
            "a private-use scheme redirect takes one slash after the colon: "
            f"{scheme}:/path (RFC 8252 §7.1)"
        )
    if not parts.path.startswith("/"):
        raise RedirectURIError(
            "a private-use scheme redirect needs a path: "
            f"{scheme}:/oauth/callback"
        )
    return KIND_PRIVATE_SCHEME


def is_interactive_only(kind: str) -> bool:
    """Spec §5: this shape's redirect can be claimed by any process."""
    return kind in (KIND_LOOPBACK, KIND_PRIVATE_SCHEME)


def private_scheme_of(uri: str) -> str | None:
    """The private-use scheme a registered URI uses, if it is that shape."""
    try:
        if classify(uri) == KIND_PRIVATE_SCHEME:
            return urlsplit(uri).scheme
    except RedirectURIError:
        return None
    return None
