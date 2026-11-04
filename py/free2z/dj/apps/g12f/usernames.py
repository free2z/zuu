"""Shared username namespace policy for every account-creation path."""


# Reserved top-level names: a username equal to one of these would shadow a real
# page at /{username}. The site is mid-transition with BOTH UIs live, so this is
# the UNION of the real top-level route segments of the new SvelteKit UI
# (ts/svelte/free2z/src/routes/, incl. its (public)/ and (auth)/ route groups)
# and the classic React UI (ts/react/free2z/src/App.tsx), plus genuinely
# system-reserved names and nginx-owned routes. Be conservative: when unsure
# whether a name is a live route, keep it reserved.
# TODO: once the classic React UI is retired, prune the classic-only entries
# (ai, begin, events, find, micvizz, profile, secretbackdrop, storytime, tools).
# See  and.
FORBIDDEN_USERNAMES = [
    # System / backend-reserved names
    "api",
    "adminzzz",
    "feeds",
    "uploads",
    "uploadz",
    "djstatic",
    "static",
    "_app",
    "ws",
    "og",
    "sitemap",
    "docs",
    # Internal nginx locations also win route matching before creator URLs.
    "gcsproxy",
    "uploadsauth",
    "uploadsauth-uploadlimit",
    "uploadsauth-private",
    "uploadsauth-public",
    "uploadsauth-public-hls",
    # Operational endpoints owned by nginx/SvelteKit.
    "healthz",
    # CSP violation sink. nginx has an exact-match `location =
    # /csp-report` that always proxies to SvelteKit, so this name can never
    # resolve to a creator page again.
    "csp-report",
    "robots.txt",
    "sitemap.xml",
    "sitemap-v2.xml",
    "terms",
    "privacy-policy",
    # nginx UI-switch routes (only exist where both UIs are served)
    "try-new-ui",
    "classic-ui",
    # New SvelteKit UI top-level routes (routes/, (public)/, (auth)/)
    "article",
    "buy-2z",
    "checkout",
    "converse",
    "creators",
    "edit",
    "live",
    "login",
    "projects",
    "reset-password",
    "search",
    # `/tag/<slug>` topic hubs. nginx routes the whole `/tag/`
    # subtree to SvelteKit, so a creator holding this name could never be
    # reached at `/tag` again.
    "tag",
    "trending",
    # The OIDC provider's pages: the consent screen at
    # `/oauth/authorize`, the account's connected apps at `/account/apps`,
    # and the developer console at `/developers/apps`. Probed 2026-09-27:
    # GET /api/creator/{oauth,account,developers}/ -> 404.
    "oauth",
    "account",
    "developers",
    # Legacy/canonical zPage route prefixes. Existing rows using these names
    # remain grandfathered; new registrations and renames into these
    # namespaces do not.
    "creator",
    "zpage",
    # Classic React UI top-level routes (App.tsx) — prune when classic retires
    "ai",
    "begin",
    "events",
    "find",
    "micvizz",
    "profile",
    "secretbackdrop",
    "storytime",
    "tools",
]


def is_forbidden_username(value: str) -> bool:
    """Return whether ``value`` belongs to a route-owned namespace."""
    return value.lower() in FORBIDDEN_USERNAMES
