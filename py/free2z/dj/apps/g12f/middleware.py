"""Trailing-slash normalisation for the crawler prerender tier.

nginx (``k8s/free2z/nginx.conf``, ``location /``) splits page traffic three
ways by User-Agent: SvelteKit SSR for humans and the ``$seobot`` allowlist, a
terminal 403 for commercial scrapers, and Django on ``localhost:8001`` for
social unfurlers (``$prerender``: WhatsApp, Slack, Discord, Telegram,
facebookexternalhit, Twitterbot, curl,...).

**Every pattern in that Django tier is slashless**, and no Django path
converter matches ``/``. So ``/{username}/`` and the canonical
``/{username}/{vanity}/`` -- the shape browsers, copy/paste and link
shorteners produce constantly -- resolved to nothing at all and 404'd, and a
shared link unfurled as "not found" on every platform. The other two personas
never saw it: SvelteKit's ``trailingSlash: 'never'`` default 308s the slashed
form to the slashless one, so the bug was invisible in a browser and invisible
in Search Console. Measured on production 2026-09-03::

    -A 'Mozilla/5.0... Chrome/126.0'            /free2z/  -> 308 /free2z
    -A 'Mozilla/5.0 (compatible; Googlebot/2.1)' /free2z/  -> 308 /free2z
    -A 'facebookexternalhit/1.1'                 /free2z/  -> 404

WHY A MIDDLEWARE AND NOT A URL PATTERN. The obvious fix is a catch-all
``re_path`` at the bottom of the URLconf. It works, and it also breaks the API
surface, which is the kind of thing that only shows up when you run it: a
registered pattern makes ``is_valid_path("/anything/")`` true, and that is
exactly the question ``CommonMiddleware.should_redirect_with_slash()`` asks
before applying ``APPEND_SLASH``. Every *slashless* URL that does not resolve
therefore starts redirecting instead of 404ing. Measured against a real
``runserver`` with the URL-pattern version installed::

    /api/definitely-not-a-route  -> 301 /api/definitely-not-a-route/  (was 404)
    /converse/not-a-uuid         -> 301 /converse/not-a-uuid/         (was 404)
    /feeds/nope                  -> 301 /feeds/nope/                  (was 404)

``location /api/`` proxies to Django through this same URLconf for EVERY user
agent, so that reaches real clients and monitoring, not crawlers -- the same
family of mistake as ``/api/zpage/skylar`` once answering an API client with an
HTML social card. Running after the 404 has already been produced avoids the
whole interaction: nothing is registered, ``is_valid_path`` is unchanged,
``APPEND_SLASH`` behaves exactly as it did, and the blast radius is provably
"requests that are 404ing right now".

WHY REDIRECT RATHER THAN SERVE BOTH SHAPES. Invariant 1 of
``dj.apps.g12f.views.crawler`` is URL parity with the SvelteKit app, and
SvelteKit redirects rather than serving. Serving a card at both shapes would
hand unfurlers two URLs for one page and put an ``og:url`` on a URL the sitemap
does not publish. 301 (not 308) matches the compatibility redirect this tier
already emits for the legacy ``/{username}/zpage/{slug}`` shape, which
the stage smoke proves every major unfurler follows.

A redirect whose target then 404s -- ``/alice/dashboard/``, a reserved vanity
-- is deliberate rather than an oversight: SvelteKit answers that exact URL
with a 308 onto the same 404, and parity is the point.
"""

from django.http import HttpResponsePermanentRedirect
from django.urls import Resolver404, resolve
from django.utils.encoding import escape_uri_path

from dj.apps.g12f.views.crawler import RESERVED_FIRST_SEGMENTS, STATIC_ROUTES


# The module every crawler-tier view lives in. ``resolve()`` returns the
# decorated function and ``functools.wraps`` keeps ``__module__`` pointing
# there through ``@require_safe``, so this is a reliable "would the slashless
# URL render a social card?" test that cannot go stale when a route is added.
CRAWLER_VIEW_MODULE = "dj.apps.g12f.views.crawler"

# An unfurler issues one of these. Bounding the redirect to them means a write
# can never be turned into a 301 -- clients rewrite a 301 to GET, and this tier
# must never be the thing that changes a request's method.
SAFE_METHODS = frozenset({"GET", "HEAD"})


def _is_reserved_namespace_root(target_path):
    """Is the slashless target a bare namespace root rather than a page?

    THE ONE ROUTE WITH NO LOOKAHEAD, found by the codex adversarial review.
    Every greedy pattern in the crawler URLconf carries a negative lookahead
    for ``RESERVED_FIRST_SEGMENTS`` -- except ``path('<str:username>')``,
    which needs none, because a bare ``/feeds`` is not a URL anybody requests.

    Stripping a trailing slash MANUFACTURES that request. ``/feeds/`` and
    ``/uploads/`` 404 today, and once the slash comes off they resolve to a
    creator-profile lookup, so without this guard the middleware turns a
    namespace root's 404 into a 301 -- for every user agent, on paths nginx
    proxies to Django unconditionally, which is exactly the API-contract
    change the rest of this module exists to avoid. Measured on a real server
    before the guard existed::

        /feeds/ /uploads/ /uploadz/ /ws/ /_app/ /static/  ->  301

    Only the ONE-segment case is at risk. ``/api/x/`` and ``/api/zpage/x/``
    are already refused, because the two- and three-segment patterns carry the
    lookahead themselves.

    ``STATIC_ROUTES`` is the exemption, and it is what makes this a statement
    about namespace roots rather than a blocklist: a reserved segment that is
    ALSO a real one-segment page is a page. ``converse`` is the only member of
    both sets today, and ``/converse/`` should reach ``/converse`` like any
    other page.

    Case-insensitive, matching the runtime backstops in the views: the URL
    regexes are case-sensitive, so ``/API/`` really does reach the greedy
    pattern where ``/api/`` does not.
    """
    segments = target_path.strip("/").split("/")
    if len(segments) != 1:
        return False
    segment = segments[0].lower()
    return segment in RESERVED_FIRST_SEGMENTS and segment not in STATIC_ROUTES


class CrawlerTrailingSlashMiddleware:
    """301 ``/<crawler-route>/`` onto the slashless URL this tier serves.

    Deliberately narrow, in five independent ways. Each one is what keeps a
    fix for social unfurlers from becoming a change to the API contract:

    1. Only a response that is **already a 404**. Nothing that resolves today
       can be affected at all.
    2. Only ``GET``/``HEAD``.
    3. Only a path that ends in exactly one ``/`` and has something before it,
       so ``/`` itself and a doubled ``/x//`` are both left alone -- the
       latter is what would otherwise let a redirect chain start.
    4. Never a bare reserved namespace root -- see
       ``_is_reserved_namespace_root``.
    5. Only when the slashless path resolves to a view **in the crawler
       module**. ``/api/<unmatched>/`` resolves to nothing, ``/adminzzz/x/``
       resolves into ``django.contrib.admin``; both keep their 404 byte for
       byte.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if response.status_code != 404:
            return response
        if request.method not in SAFE_METHODS:
            return response

        path = request.path_info
        # `len(path) > 1` rejects "/" itself; `path[-2] != "/"` rejects "//"
        # and "/x//", whose slashless target would still end in a slash.
        if not path.endswith("/") or len(path) < 2 or path[-2] == "/":
            return response

        target_path = path[:-1]
        if _is_reserved_namespace_root(target_path):
            return response

        # Honour a per-request URLconf the way django.urls.is_valid_path does;
        # nothing sets one today, and resolving against the wrong one would be
        # a silent wrong answer rather than an error.
        try:
            match = resolve(target_path, getattr(request, "urlconf", None))
        except Resolver404:
            return response
        if getattr(match.func, "__module__", None) != CRAWLER_VIEW_MODULE:
            return response

        # `request.path` (re-escaped) rather than `path_info`, and the RAW
        # query string, so the caller's bytes survive the hop. Relative on
        # purpose: Host is caller-controlled behind the GCLB, which is why
        # `location /` sets `absolute_redirect off` -- a redirect synthesised
        # here must never echo the request authority back.
        target = escape_uri_path(request.path[:-1])
        # SAFE BY CONSTRUCTION, not by accident. `//evil.com/x/` and
        # `/\evil.com/` are the standard shapes for turning a relative
        # redirect into an off-site one -- a browser reads `//host` as
        # protocol-relative, and several normalise a leading backslash into a
        # slash first. Neither resolves through this URLconf today (the
        # greedy patterns are anchored on `[^/]+`, and escape_uri_path()
        # percent-encodes a backslash to %5C), but both of those are
        # incidental properties of code that is free to change. A redirect
        # this middleware synthesises is only ever a same-origin path.
        if not target.startswith("/") or target[1:2] in ("/", "\\"):
            return response
        query = request.META.get("QUERY_STRING", "")
        if query:
            target = f"{target}?{query}"
        return HttpResponsePermanentRedirect(target)
