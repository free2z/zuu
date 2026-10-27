"""Absolute URL paths for the brand images Django emits into HTML/JSON.

WHY THIS MODULE EXISTS ( Phase 4)
=====================================
Django hardcoded two root-level image URLs in four modules and a template.
Both were served by ONE thing: the classic Create React App build, mounted at
`/base/build/` in the free2z image and reached through `root /base/build/` in
`k8s/free2z/nginx.conf`. Nothing else in the cluster could answer them, and
`ts/svelte/free2z/static/` never contained either file.

So the day `ts/react/free2z` is deleted, every default avatar and every default
social card emitted by Django 404s — silently, because a 404 on an `og:image`
shows up as a blank unfurl weeks later, not as a failed deploy.

THE TWO REPLACEMENTS ARE DELIBERATELY DIFFERENT
===============================================
`default_logo_url()` resolves through Django's OWN static pipeline
(`/djstatic/...` in production, `k8s/free2z/nginx.conf: location /djstatic`).
That is not a stylistic choice — it is the only home with no cross-deployment
race. The alternative, `ts/svelte/free2z/static/`, is served by a DIFFERENT
Deployment: Cloud Build applies free2z and new-ui together with no ordering, so
during every rollout a new free2z pod would emit a URL that the old new-ui
replicas still in the Service cannot serve. The blast radius of that 404 is not
bounded by the rollout, because social unfurlers cache what they fetch.
`/djstatic/` ships in the same image as the code that emits it, so the URL and
the bytes can never disagree.

`DEFAULT_SOCIAL_IMAGE_PATH` is the exception, on purpose: `/brand/free2z-og.png`
is already deployed and already the SvelteKit SSR default, so pointing the card
tier at it introduces no new file and converges the two tiers — which is what
 Phase 3 does anyway.

`test_branding.py` asserts both assets exist on disk and that no module or
template reintroduces a classic-build-only path.
"""

from django.templatetags.static import static

# Collected from `py/dj/apps/g12f/static/` by `manage.py collectstatic`
# (cloudbuild.yaml), tarred by `//py:statictar` into `/base/dj/free2z/static/`,
# and served by `location /djstatic` in `k8s/free2z/nginx.conf`.
DEFAULT_LOGO_STATIC_PATH = "g12f/logo512.png"

# The site-level social card. Deliberately NOT a relocated copy of
# `/2Z-alpha-crop.png` (406x398): this is the same constant the SvelteKit SSR
# app already uses as its default og:image
# (`ts/svelte/free2z/src/lib/seo.ts:DEFAULT_SOCIAL_IMAGE`), it is 1200x630 —
# the shape Twitter/X and Facebook actually want for a large card — and it is
# already live on every deployed new-ui replica, so switching to it adds no new
# file to any image.
DEFAULT_SOCIAL_IMAGE_PATH = "/brand/free2z-og.png"


def default_logo_url() -> str:
    """The Free2Z logo, for creators with no avatar and zPages with no image.

    A function, not a constant: `static()` reads `settings.STATIC_URL` at call
    time, so this cannot freeze one settings module's answer at import. Both
    modules now say `/djstatic/` — `dj.free2z.settings` used to say `/static/`,
    which the edge config routes into the classic CRA build, so a URL built
    under those settings pointed at a tree Django has never written to.

    Returns a root-relative path. Callers that need an absolute URL (the social
    card templates, the RTK/Dyte participant picture) prepend the origin
    themselves, exactly as they did before.
    """
    return static(DEFAULT_LOGO_STATIC_PATH)
