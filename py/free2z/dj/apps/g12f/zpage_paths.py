"""Collision-safe public zPage URL selection shared by Django emitters.

This is the Python port of ``ts/svelte/free2z/src/lib/zpage-path.ts``. Both
runtime tiers emit public URLs, so both must account for SvelteKit literals and
nginx-owned namespaces before choosing the pretty ``/{owner}/{identifier}``
shape.
"""

from urllib.parse import quote


CANONICAL_CONTENT_URL_HEADER = "X-Free2Z-Canonical-Content-URL"


ROUTE_COLLISIONS = frozenset(
    {
        "broadcast",
        "dashboard",
        "null",
        "ppv",
        "private",
        "subscribers-only",
        "undefined",
        "zpage",
    }
)
TWO_SEGMENT_PREFIX_COLLISIONS = frozenset(
    {
        "_app",
        "adminzzz",
        "ai",
        "api",
        "article",
        "checkout",
        "classic-ui",
        "converse",
        "djstatic",
        "docs",
        "edit",
        "feeds",
        "gcsproxy",
        "live",
        "projects",
        "static",
        "tag",
        "try-new-ui",
        "uploads",
        "uploadz",
        "ws",
    }
)
EXACT_TWO_SEGMENT_COLLISIONS = frozenset(
    {
        "begin/alt",
        "profile/kyc",
        "profile/uploads",
        "sitemap/static.xml",
        "tools/p2pe2e",
    }
)


def canonical_zpage_path(username, vanity, free2zaddr):
    """Return the public path that cannot be captured by a product route."""
    identifier = next(
        (
            str(candidate)
            for candidate in (vanity, free2zaddr)
            if candidate and str(candidate).lower() not in ROUTE_COLLISIONS
        ),
        None,
    )
    immutable_path = (
        f"/article/{quote(str(free2zaddr), safe='')}" if free2zaddr else None
    )
    if not identifier:
        return immutable_path
    if not username:
        return None

    owner = str(username).lower()
    child = identifier.lower()
    if (
        owner in TWO_SEGMENT_PREFIX_COLLISIONS
        or f"{owner}/{child}" in EXACT_TWO_SEGMENT_COLLISIONS
    ):
        return immutable_path
    return f"/{quote(str(username), safe='')}/{quote(identifier, safe='')}"


def negotiated_content_url(content_object, request=None):
    """Return a URL compatible with the requesting UI revision.

    Classic bundles can stay loaded across a backend rollout. They only
    understand ``get_url()``'s historic ``/{owner}/zpage/{id}`` shape, while
    the Svelte client explicitly opts into collision-safe canonical paths.
    Defaulting to legacy keeps old browsers and websocket payloads safe until
    classic retirement; unknown header values never widen the response shape.
    """
    headers = getattr(request, "headers", {}) if request is not None else {}
    prefer_public = headers.get(CANONICAL_CONTENT_URL_HEADER) == "1"
    method_names = (
        ("get_public_url", "get_url") if prefer_public else ("get_url",)
    )
    for method_name in method_names:
        method = getattr(content_object, method_name, None)
        if callable(method):
            return method()
    return None
