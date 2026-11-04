"""One API framework, one spec -- and an inventory of what is still outside it.

`f2z.yaml` is the canonical, CI-enforced contract -- the `backend` job
regenerates it from the code and fails on drift, so a stale spec cannot merge.
That guarantee is **drf-spectacular-shaped**: it sees DRF views and nothing
else.  found the hole that follows from it. `dj.apps.efm` was mounted as
**django-ninja**, so five endpoints -- two of which persist WebAuthn
credentials -- had no contract at all: invisible to the generated TypeScript
client, invisible to anyone reading the spec to learn what the platform does,
and invisible to every review that starts from the spec. Nothing could detect a
breaking change to them.

## What was decided

Not "merge ninja's schema into `f2z.yaml`", and not "publish a second spec".
Both keep two generators, two schema dialects and two drift-detection stories
alive so that one experimental app can use a different router. The generated
client chain (`Django -> f2z.yaml -> orval -> src/lib/api/**`, ) would
have to grow a merge step whose failure mode is a silently under-generated
client -- exactly the invisibility the issue is about, one layer down.

**The routed project serves its JSON API through DRF. A second API framework
does not get mounted.** efm made that cheap to decide rather than expensive:
it has been offline (`dj/apps/efm/__init__.py`), so there is nothing
to keep compatible. If it ever comes back it comes back as DRF -- five view
functions -- and arrives in the spec on the same terms as everything else.

## What this file enforces

Two things.

**1. No django-ninja route is reachable**, in either project URLconf, at any
prefix. `test_offline.py` in `dj.apps.efm` already covers *efm*; this covers
the framework, so a new `api = NinjaAPI()` in a new app -- the way this recurs
-- is caught too.

**2. The set of non-DRF routes under `/api/`, `/uploads/` and `/feeds/` is
exactly `NON_DRF_ROUTES` below.** This is the audit 's third checkbox asks
for, turned into a ratchet: the list may shrink, never grow. drf-spectacular
cannot see any of these, so anything added to that set is a new endpoint with
no contract, no generated client and nothing to detect a breaking change to it.

The second one exists because the first is not enough, and the codex review of
this PR proved it by naming three endpoints the ninja guard is blind to.
`/api/twitter/start` is a plain Django `View` returning `JsonResponse`, the
sign-in modal calls it by hand-written `fetch`, and renaming `state` or
`code_challenge` in it would leave the spec, the generated client and this
whole file green while Twitter login broke in production. Same shape for
`/uploads/handle` and `/uploads/single-public`. Enumerating routes and demanding
a matching `f2z.yaml` path was the other option and is worse: normalising DRF
router regexes into OpenAPI paths is fiddly enough to be flaky, and it would
also flag the SSR and feed views, which do not belong in the spec at all. The
test below asks a sharper question -- "is drf-spectacular able to see this?" --
straight off the callback, with no path normalisation.

## What is deliberately NOT in the spec, and why

`NON_DRF_ROUTES` is annotated with which of these each entry is:

* **Not an API.** RSS feeds and the SSR crawler pages under `/` serve HTML/XML
  to browsers and bots. A generated TypeScript client has no use for them.
* **Not ours.** The Stripe webhook's request contract belongs to Stripe.
* **Not client-callable.** `/uploads/auth*` are nginx `auth_request`
  subrequests; `/api/readyz` is a monitoring probe; the `e404` shadows exist
  only to mask `dj_rest_auth` routes.
* **Should be in the spec, is not yet.** The genuine backlog:
  `/api/twitter/start`, `/api/twitter/callback`, `/uploads/handle`,
  `/uploads/single-public`, `/uploads/limit`, `/api/zpage-random`. Porting them
  to DRF is not in this PR's scope; recording them where CI keeps the list
  honest is. Tracked on.

The spec's own `info.description` says which of these it covers, so nobody
reads its coverage as "every URL the server answers" -- and, since this list is
not empty, it does not claim to be complete either.
"""

from django.urls import get_resolver
from django.urls.resolvers import URLResolver
from rest_framework.views import APIView

#Any module path under here means a request is being served by django-ninja.
#Checking the *callback's* module is what makes this framework-level and
#prefix-independent: ninja wraps every operation in
#`ninja.operation.PathView._sync_view`, so a mounted router is visible as a
#ninja-owned callback no matter which app declared it or where it is mounted.
NINJA_MODULE_PREFIX = "ninja"


def _module_of(callback):
    return getattr(callback, "__module__", "") or ""


def _ninja_routes(patterns, prefix=""):
    """Every reachable route whose view is served by django-ninja."""
    found = []
    for entry in patterns:
        if isinstance(entry, URLResolver):
            found.extend(_ninja_routes(entry.url_patterns,
                                       prefix + str(entry.pattern)))
            continue
        module = _module_of(entry.callback)
        if module == NINJA_MODULE_PREFIX or module.startswith(
                NINJA_MODULE_PREFIX + "."):
            found.append(prefix + str(entry.pattern))
    return found


def test_no_django_ninja_route_is_reachable():
    """The product API is DRF, so drf-spectacular sees all of it.

    A red here does not mean "django-ninja is bad". It means a JSON endpoint
    just became reachable that `f2z.yaml` cannot describe and
    `npm run generate:api` cannot generate a client for -- so it is invisible
    to the spec, to the client, and to every review that starts from either.
    Port it to DRF, or reopen the decision in  with the merge step and its
    CI enforcement designed, not assumed.
    """
    offenders = _ninja_routes(get_resolver().url_patterns)

    assert offenders == [], (
        "django-ninja routes are mounted and therefore absent from f2z.yaml: "
        f"{offenders}"
    )


def test_the_zuu_project_urlconf_is_clean_too():
    """`dj/proj/free2z` is a second URLconf and mounted efm the same way."""
    from dj.proj.free2z import urls as zuu_urls

    assert _ninja_routes(zuu_urls.urlpatterns) == []


def test_the_detector_actually_detects_a_mounted_ninja_router():
    """Positive control, or the two tests above prove only that they are quiet.

    Uses efm's own router because it is the one that exists; the assertion is
    about the *detector*, not about efm.
    """
    from django.urls import include, path

    remounted = [path("api/anything/", include("dj.apps.efm.urls"))]

    assert _ninja_routes(remounted), (
        "the guard is blind to a mounted NinjaAPI -- it would not have caught "
        "the very situation #1004 was filed about"
    )


#Prefixes that carry the platform's machine-readable surfaces. The SSR
#crawler routes live at the site root and are excluded by construction: they
#render HTML for browsers and bots and are not, and will never be, API.
API_PREFIXES = ("api/", "uploads/", "feeds/")

#Every routed view under those prefixes that drf-spectacular cannot see, and
#which is therefore absent from `f2z.yaml`. THIS LIST MAY SHRINK; IT MAY NOT
#GROW for client APIs. Dependency-monitoring probes belong in the explicit
#non-client-callable category below. Each entry says why it is here -- see the
#four categories. Adding a line means shipping an endpoint with no contract.
NON_DRF_ROUTES = {
    # -- should be in the spec; not yet. Tracked on. -------------------
    'api/twitter/start',            # JsonResponse; called by the auth modal
    'api/twitter/callback',         # OAuth return; sets the session
    'uploads/handle',               # JsonResponse; the media uploader posts it
    'uploads/single-public',        # JsonResponse; avatar/cover upload
    'uploads/limit',                # JsonResponse; quota read
    'api/zpage-random',             # JsonResponse; random-page redirect target

    # -- not client-callable ------------------------------------------------
    'api/readyz',                   # monitoring probe, runs SELECT 1
    'api/jobs/smoke',               # monitoring probe, reads bounded queue result
    'uploads/auth',                 # nginx auth_request subrequest
    'uploads/auth-private',         # nginx auth_request subrequest
    'uploads/auth-public',          # nginx auth_request subrequest
    'uploads/auth-public-hls',      # nginx auth_request subrequest
    '^api/auth/password/reset/?$',          # e404 shadow over dj_rest_auth
    '^api/auth/password/reset/confirm/?$',  # e404 shadow over dj_rest_auth

    # -- not ours -----------------------------------------------------------
    'api/stripe/webhook/',          # Stripe defines this request contract

    # -- not an API ---------------------------------------------------------
    'feeds/ai/recent.xml',
    'feeds/converse/recent.xml',
    'feeds/podcasts/recent.xml',
    'feeds/zpages/recent.xml',
    'feeds/<str:username>/ai/recent.xml',
    'feeds/<str:username>/converse/recent.xml',
    'feeds/<str:username>/podcasts/recent.xml',
    'feeds/<str:username>/zpages/recent.xml',
}


def _non_drf_api_routes():
    """Routed views under the API prefixes that drf-spectacular cannot see.

    The signal is `callback.cls`, which `APIView.as_view()` sets and plain
    Django's `View.as_view()` does not -- so it covers `APIView` subclasses,
    `@api_view` functions and every router-generated ViewSet route in one
    check, without parsing a single URL pattern. Path normalisation is
    deliberately avoided: turning a DRF router's `re_path` into an OpenAPI
    path is exactly the fiddly, quietly-wrong step this test exists to not
    depend on.

    Known limit (codex review): "is a DRF view" is not identical to "appears
    in the spec". A view carrying `schema = None` or
    `@extend_schema(exclude=True)` passes this and is still absent from
    `f2z.yaml`. Nothing in the repo does that today, and doing it is an
    explicit, visible act in the view itself rather than the silent
    invisibility this guard is aimed at -- but it is the seam, and closing it
    means the URL-to-spec membership check rejected above.
    """
    found = set()
    for pattern, callback in _routes(get_resolver().url_patterns):
        if not pattern.lstrip('^').startswith(API_PREFIXES):
            continue
        cls = getattr(callback, 'cls', None)
        if isinstance(cls, type) and issubclass(cls, APIView):
            continue
        found.add(pattern)
    return found


def _routes(patterns, prefix=""):
    for entry in patterns:
        if isinstance(entry, URLResolver):
            yield from _routes(entry.url_patterns, prefix + str(entry.pattern))
        else:
            yield prefix + str(entry.pattern), entry.callback


def test_no_new_endpoint_is_invisible_to_the_spec():
    """The ratchet. A new non-DRF route under /api/ is a contract-less endpoint.

    If this fails with something ADDED: the endpoint you just routed cannot
    appear in `f2z.yaml`, so `npm run generate:api` will not generate a client
    for it and nothing will detect a breaking change to it. Make it a DRF view
    -- `@api_view` on a function is usually the whole diff -- rather than
    adding a line here.

    If it fails with something REMOVED: good. Delete the line.
    """
    actual = _non_drf_api_routes()

    added = sorted(actual - NON_DRF_ROUTES)
    removed = sorted(NON_DRF_ROUTES - actual)

    assert not added, (
        "these routes are invisible to drf-spectacular and therefore absent "
        f"from f2z.yaml: {added}"
    )
    assert not removed, (
        f"NON_DRF_ROUTES is stale -- these no longer exist: {removed}"
    )


def test_the_invisibility_detector_sees_a_plain_django_view():
    """Positive control for the check above, on a real offender.

    `/api/twitter/start` returns `JsonResponse` from a plain Django `View`,
    the sign-in modal fetches it by hand, and it is not in the spec. If this
    stops being true because it was ported to DRF, delete it from
    `NON_DRF_ROUTES` and pick another -- do not delete this test.
    """
    assert 'api/twitter/start' in _non_drf_api_routes()


def test_the_invisibility_detector_does_not_flag_a_drf_view():
    """Negative control: a `@api_view`/`APIView`/ViewSet route is not listed."""
    listed = _non_drf_api_routes()

    assert 'api/emails/status' not in listed        # APIView
    assert 'api/stripe/create-checkout-session/' not in listed  # @api_view
    assert not [p for p in listed if p.startswith('api/pricing/')]


def test_the_detector_does_not_flag_ordinary_django_views():
    """Negative control: the non-DRF views that are out of scope stay quiet.

    SSR HTML, RSS and nginx auth subrequests are absent from `f2z.yaml` on
    purpose, not by accident. A guard that flagged them would be an argument
    for "everything routed must be in the spec" -- and a spec that documents
    an XML feed as an API operation is worse than one that says what it covers.
    """
    from django.urls import path
    from django.views.static import serve

    from dj.apps.g12f.views import crawler
    from dj.apps.uploads import views as uploads_views

    ordinary = [
        path("zpage/<slug:slug>", crawler.zpage_social),
        path("uploads/auth", uploads_views.uploads_auth),
        path("uploadz/<path:path>", serve),
    ]

    assert _ninja_routes(ordinary) == []
