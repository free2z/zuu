"""Server-side prerender tier for SOCIAL UNFURLERS.

nginx (``k8s/free2z/nginx.conf``, ``location /``) proxies any request whose
User-Agent matches its ``$prerender`` heuristic (twitterbot, facebookexternalhit,
slackbot, discordbot, telegrambot, ``whatsapp/``, embedly, iframely, ``curl/``,
...) to Django on ``localhost:8001``. For those requests Django's only job is
to emit a small HTML document carrying the right ``<title>``,
``<link rel=canonical>`` and Open Graph / Twitter card meta so the link
preview renders.

**Humans do not come here either, and that is the point of the BOT names in
that list.** Until  the heuristic matched bare brand and English-word
substrings — ``twitter``, ``telegram``, ``pinterest``, ``seo`` — so every
social app's in-app WebView (``TwitterAndroid``, ``Telegram-Android/11.9.0``,
``Pinterest for Android/6.58.4``) and any device whose model contains "seo"
(``SEOUL-X1``) landed on this tier and rendered the card's ``<pre>`` body,
i.e. the article as un-wrapped monospace markdown, to a person.

**Search engines do not come here.** the ``$seobot`` allowlist
(googlebot, bingbot, gptbot, claudebot, applebot,...) routes to the SvelteKit
SSR app instead, which is the only tier that renders the real document, robots
meta and JSON-LD. That is why the bounds below (``CARD_BODY_CHARS`` and
friends) are safe: this is a link-preview card, never the indexable document.

Three invariants this module exists to hold:

1. **URL parity with the SvelteKit app.** Whatever ``ts/svelte/free2z/src/
   routes/`` serves, this tier must resolve the same way, with the same
   precedence (a literal route segment beats the ``[username]`` parameter).
   Before  this tier still described the pre- URL scheme
   (``/{username}/zpage/{slug}``), so every *canonical* zPage URL
   (``/{username}/{vanity}``) — which is every URL in the sitemap and every
   link creators actually share — 404'd here and rendered no preview card at
   all on Twitter/X, Facebook, Slack, Discord, WhatsApp or Telegram.
   ``/creators`` and ``/trending`` 404'd for the same family of reason: the
   greedy ``<str:username>`` pattern swallowed them and the creator lookup
   missed.

2. **Trailing slashes are normalised, not served.** Every pattern here is
   slashless and no path converter matches ``/``, so ``/{username}/`` and the
   canonical ``/{username}/{vanity}/`` used to 404 -- invisibly, because the
   other two personas go to SvelteKit, which 308s the slash away itself
   . ``dj.apps.g12f.middleware.CrawlerTrailingSlashMiddleware`` turns
   those 404s into a 301 onto the slashless URL. It is a middleware rather
   than a URL pattern for a reason spelled out in its own docstring; do not
   "simplify" it into a catch-all ``re_path`` here.

3. **Never more public than the page itself.** These responses are anonymous
   by construction — a crawler carries no session — so the visibility check
   has to happen here and cannot lean on ``request.user``. Unpublished
   (draft) pages 404. Subscriber-only pages get a card (title + author) but
   never their body copy, mirroring what the gated API response does
   (``RedirectWithModalException`` redacts ``content``). Deactivated
   creators 404.
"""

import re
from urllib.parse import quote

from django import http
from django.db.models import Case, IntegerField, Q, TextField, Value, When
from django.db.models.functions import Substr
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_safe

from dj.apps.comments.models import Comment
from dj.apps.comments.visibility import comment_visible
# The closed enum `/live/{username}?type=` and `/{username}/{type}` accept, and
# the ONLY values the API's own path converter resolves. Imported rather than
# spelled out so this tier cannot drift from `dyte/urls.py`.
from dj.apps.dyte.models import BROADCAST, PUBLIC_MEETING_TYPES
from dj.apps.g12f.branding import DEFAULT_SOCIAL_IMAGE_PATH
from dj.apps.g12f.identifiers import resolve_zpage_pk
from dj.apps.g12f.localization import (
    RESOLUTION_VARIANTS_ATTR,
    resolve_zpage_variant,
    variant_reads_enabled,
)
from dj.apps.g12f.meta_description import (
    META_DESCRIPTION_CHARS, compact_text,
)
from dj.apps.g12f.models import (
    Creator, ZPageTranslation, ZPageVariant, zPage,
)
from dj.apps.g12f.serializers.zpage import RESERVED_VANITIES
from dj.apps.g12f.usernames import FORBIDDEN_USERNAMES
from dj.apps.openai.models import Conversation

from langcodes import standardize_tag

from f2z import languages

from .sitemap import SITEMAP_MAX_VARIANTS_PER_ZPAGE


SITE_TITLE = "Free2Z: Support Creators. Raise Money. Build Community."
SITE_DESCRIPTION = (
    "Free2Z is committed to helping creators raise money while prioritizing "
    "privacy. Join our community today and try it out!"
)
# Was "/2Z-alpha-crop.png", which only the classic CRA build could serve
# ( Phase 4). See dj.apps.g12f.branding.
SITE_IMAGE = DEFAULT_SOCIAL_IMAGE_PATH

# Matches ts/svelte/free2z/src/routes/+layout.svelte, which stamps this on
# every dashboard / private / login / checkout surface.
NOINDEX = "noindex, nofollow, noarchive"
# Real, linkable, but deliberately not-indexed list views (search results,
# non-canonical trending slices) — crawlable, not indexable.
NOINDEX_FOLLOW = "noindex, follow"

# A subscriber-only page is publicly *linkable* but its body is paywalled, so
# the card can never fall back to the content for its description.
SUBSCRIBER_ONLY_DESCRIPTION = (
    "This page is available to subscribers on Free2Z."
)
# What to say when the body reduces to nothing at all -- a page whose entire
# content is an `::embed[...]` directive, which is exactly what
# /example_creator/video-example is. Byte-identical to the ENGLISH source string
# of `meta.articleDescriptionFallback` in ts/svelte/free2z/src/lib/meta.ts, the
# same way SUBSCRIBER_ONLY_DESCRIPTION above mirrors
# `meta.subscriberOnlyDescription`. This tier cannot translate -- an unfurler
# caches one card per URL and carries no usable locale -- so it states the
# source string, which is strictly better than the empty attribute the old code
# would have emitted once the directive stopped leaking through verbatim.
ARTICLE_DESCRIPTION_FALLBACK = (
    "Read this article and discover more independent creators on Free2Z."
)

# Bounds on how much of a 100,000-character `zPage.content` a crawler card
# renders. This is a link-preview card, not the indexable document -- search
# crawlers get the SvelteKit SSR response, which serves the full article.
# The description bound is NOT defined here: it is
# `meta_description.META_DESCRIPTION_CHARS`, shared with the SvelteKit tier so
# the two halves of the crawler population cannot be handed different lengths
#. Re-exported under the old name because that is what this module's
# tests and readers look for.
CARD_DESCRIPTION_CHARS = META_DESCRIPTION_CHARS
CARD_BODY_CHARS = 4000
# How many published variants of one article this tier will load. Shared with
# the sitemap on purpose: the two must derive the same `available_languages`
# for the same article, or the card's canonical and the sitemap's <loc> stop
# agreeing -- which is the one thing that costs the whole hreflang cluster.
CARD_MAX_VARIANTS = SITEMAP_MAX_VARIANTS_PER_ZPAGE

# --- language --------------------------------------------------------------
#
# This block is a deliberate PORT of
# ts/svelte/free2z/src/lib/zpage-language.js (`normalizeContentLanguage`,
# `resolveContentLanguageRange`, `resolveArticleLanguage`, `cleanUrlLanguage`,
# `articleTranslationHref`, `articleCanonicalHref`,
# `articleLanguageAlternates`). It is duplicated because the two tiers run in
# two runtimes, not because the rules differ -- they must not differ, and
# py/dj/apps/g12f/testdata/zpage_language_parity.json is the golden table both
# test suites assert against so a change to either side that drifts fails in
# both.
#
# Every function here answers a question about a *content* language, so every
# one of them normalizes with `f2z.languages.normalize`. They used to use
# `_normalize_ui_locale` -- the port of the PRODUCT-UI normalizer, four locales
# wide -- which is: a creator published a `zh-Hans` translation and this
# tier served the English card for `?lang=zh-Hans` under a canonical that
# contradicted it, while the cluster it emitted never mentioned Chinese at all.
# The port of the UI-locale normalizer is GONE from this module rather than
# left sitting next to them: nothing here has a UI-locale question to ask, and
# a normalizer that silently deletes a script subtag is not something to leave
# within reach of the next person editing this block.
#
# Why the crawler tier needs any of this at all: an `hreflang` cluster is
# discarded wholesale by a search engine when one member's page declares a
# different `rel=canonical`. Before  Part 8 this tier ignored `?lang=`
# entirely, so `/{user}/{vanity}?lang=es` unfurled the ENGLISH card under a
# canonical of the query-free URL -- a shared Spanish link previewed as
# English, and a canonical that contradicted the SvelteKit page at the same
# URL.
UI_LOCALES = languages.UI_LOCALES
DEFAULT_UI_LOCALE = "en"


#ICU's three macro rewrites that langcodes declines, and langcodes' three
#rewrites that ICU declines. Derived by sweeping every macrolanguage-bearing
#IANA subtag through both runtimes; the exhaustive shared table
#`macrolanguage_normalization_parity.json` pins the complete result.
_MACRO_ALIASES_ICU_DECLINES = frozenset({"tw", "knn", "mnk"})
_MACRO_ALIASES_ICU_DECLINES_WITH_SUFFIX = frozenset({"knn", "mnk"})
_MACRO_ALIASES_LANGCODES_DECLINES = {
    "ajp": "apc",
    "ajt": "aeb",
    "gom": "kok",
}


def _content_language_macrolanguage(tag):
    """Apply ICU's primary-language macro rewrite, preserving subtags.

    ICU leaves all three aliases in ``_MACRO_ALIASES_ICU_DECLINES`` alone when
    bare. With a suffix, it rewrites ``tw`` but still leaves ``knn`` and
    ``mnk`` untouched.
    """
    primary, separator, suffix = tag.partition("-")
    if (
        (not separator and tag in _MACRO_ALIASES_ICU_DECLINES)
        or primary in _MACRO_ALIASES_ICU_DECLINES_WITH_SUFFIX
    ):
        return tag
    if primary in _MACRO_ALIASES_LANGCODES_DECLINES:
        return _MACRO_ALIASES_LANGCODES_DECLINES[primary] + separator + suffix
    return standardize_tag(tag, macro=True)


def _explicit_content_language(value):
    """Validate an explicit selector, retaining its pre-macro stored spelling."""
    normalized = _normalize_content_language(value)
    if not normalized or not isinstance(value, str):
        return None
    try:
        stored_tag = languages.normalize(value.strip().replace("_", "-"))
        rewritten = languages.normalize(_content_language_macrolanguage(stored_tag))
    except languages.LanguageError:
        return normalized
    return stored_tag if rewritten != stored_tag else normalized


def _normalize_content_language(value):
    """Port of ``normalizeContentLanguage``: canonicalize a CONTENT language.

    Script and region survive (``zh-Hans`` stays Simplified, ``pt-PT`` stays
    European), and anything that is not a language a creator can write in --
    ``und``, ``mul``, a private-use tag, garbage from a shared URL -- is
    ``None``. Never raises: a stranger's ``?lang=`` must degrade a link
    preview, not break it.

    Three adjustments live here and nowhere else, each one closing a gap between
    this tier and `normalizeContentLanguage` in
    ``ts/svelte/free2z/src/lib/zpage-language.js``. A `?lang=` that resolves to
    one language on one tier and another on the other is the exact disagreement
    this whole block exists to prevent, and the ``normalize`` cases in
    ``zpage_language_parity.json`` pin every one of them:

    1. The underscore form (``pt_br``, ``zh_Hans``) is accepted.
       ``languages.normalize`` rejects it -- correctly, it is not well-formed
       BCP-47 -- but the SvelteKit normalizer has always tolerated it on the way
       in.
    2. A tag carrying a SINGLETON subtag is rejected outright: ``i-klingon``,
       ``en-u-ca-buddhist``, ``x-private``. ICU canonicalizes the grandfathered
       forms (``i-klingon`` -> ``tlh``) while the JS side rejects them on shape,
       so without this the two tiers asked the API for different languages.
    3. Macrolanguages are canonicalized (``cmn`` -> ``zh``), because ICU does it
       and the JS tier therefore does too. Left alone, ``?lang=cmn`` served
       Chinese with a ``?lang=zh-Hans`` canonical from SvelteKit and English
       with an English canonical from here -- one URL, two languages, two
       contradicting canonicals (reviewer F2). ``macro=True`` is not quite
       ICU's answer, though: probed across all 447 macrolanguage-bearing
       subtags in the IANA registry, ICU rewrites 70 and langcodes' macro
       substitution agrees on 67 -- it OVER-converts ``tw``, ``knn`` and
       ``mnk``, which ICU leaves alone. Those three are excepted by name, and
       the golden table pins them: without that, an article with a published
       ``tw`` translation served Twi from SvelteKit and English from here,
       while this tier advertised a ``?lang=ak`` URL that resolves to nothing
       (codex adversarial review).

    A variant STORED as a macrolanguage alias must keep its raw spelling in
    exact lookup URLs; URL construction does that separately from this
    normalizer. The write path still validates its own policy. Both tiers
    agreeing is what this function owes; the registry's own answer is not its
    business.
    """
    if not isinstance(value, str):
        return None
    candidate = value.strip().replace("_", "-")
    # A singleton subtag opens an extension or private-use section, and the
    # grandfathered `i-` / `x-` forms are the same shape. Mirrors the JS regex.
    if re.search(r"(^|-)[0-9A-Za-z](-|$)", candidate):
        return None
    try:
        tag = languages.normalize(candidate)
    except languages.LanguageError:
        return None
    if tag is None:
        return None
    # `macro=True` is what turns `cmn` into `zh`. ICU and langcodes each have
    # three exceptions to the other's mapping; apply both directions so the
    # result matches Intl.getCanonicalLocales across the complete IANA set.
    macro = _content_language_macrolanguage(tag)
    try:
        return languages.normalize(macro)
    except languages.LanguageError:
        # A macrolanguage substitution the registry will not have: keep the tag
        # the registry already validated rather than inventing one.
        return tag


def _resolve_content_language_range(requested, available):
    """Port of ``resolveContentLanguageRange`` -- RFC 4647 "lookup", plus one
    deliberate extension, over the variants this article actually has.

    ``resolve_zpage_variant`` matches ``?lang=`` EXACTLY, so ``?lang=zh`` on an
    article whose only Chinese variant is ``zh-Hans`` silently serves the
    source language. That is what this resolves, identically to the SvelteKit
    tier, so the two never disagree about what the same URL serves:

    1. exact tag wins;
    2. otherwise truncate the REQUESTED range (``zh-Hans-CN`` -> ``zh-Hans``),
       never sideways to another script -- and a truncated match is subject to
       rule 3's script constraint too, or plain RFC 4647 lookup matches the
       range ``sr-Latn`` to a variant tagged ``sr``, which CLDR says is
       Cyrillic;
    3. otherwise the ONE variant sharing the primary subtag, and never across a
       script -- where "script" is the LIKELY script, not only a spelled-out
       one: ``zh`` finds ``zh-Hans``, ``pt`` finds ``pt-PT``, but ``zh-Hant``
       AND ``zh-TW`` both find nothing on a Simplified-only article, because
       `TW` implies `Hant`. A differing region within one script is
       tolerated; a differing writing system is not;
    4. and if several match (``zh-Hans`` *and* ``zh-Hant``), ``None`` --
       guessing between scripts is the  defect. The API's own fallback
       stands and the reader is offered the choice.
    """
    tag = _normalize_content_language(requested)
    if not tag:
        return None
    variants = _linkable_languages(available)
    if not variants:
        return None

    script = _requested_script(tag)

    def agrees(code):
        # Only a CONFLICT excludes: a bare `zh` request constrains nothing and
        # still matches `zh-Hans` or `zh-Hant`, whichever the article has.
        code_script = languages.likely_script(_canonical_of(code))
        return not (script and code_script and script != code_script)

    # Comparison is on the CANONICAL form; the answer is the stored spelling,
    # because the stored spelling is the only tag the API can serve.
    subtags = tag.split("-")
    while subtags:
        candidate = "-".join(subtags)
        for code in variants:
            if _canonical_of(code) == candidate and agrees(code):
                return code
        subtags.pop()

    primary = tag.split("-")[0]
    matches = [
        code
        for code in variants
        if _canonical_of(code).split("-")[0] == primary and agrees(code)
    ]
    return matches[0] if len(matches) == 1 else None


def _canonical_of(value):
    """The canonical form of a stored tag, or the tag itself if it has none."""
    return _normalize_content_language(value) or value


def _requested_script(tag):
    """The script the REQUEST constrains the answer to, or ``None``.

    Mirrors ``requestedScript`` in ``src/lib/zpage-language.js``. A bare primary
    subtag is the one case that constrains nothing -- ``?lang=zh`` means
    "Chinese" and must still reach the single Chinese variant an article has,
    whichever script it is in. Anything more specific constrains: ``zh-Hant``
    says so outright, ``zh-TW`` says so through its region.
    """
    return languages.likely_script(tag) if "-" in tag else None


def _requested_card_language(request):
    """Which variant this request asks for. Port of ``resolveArticleLanguage``.

    Only ``?lang=``, never ``Accept-Language``. Two reasons, both about this
    tier specifically: a card served from this tier is cached by the unfurler
    keyed on the URL alone, so varying on a request header would hand one
    consumer another's language; and a shared link is the only signal that
    actually carries a creator's intent -- an unfurler's `Accept-Language`
    reflects the crawler's data centre, not the reader.

    An unsupported or malformed value falls back to the default locale rather
    than 400ing: this response is a link preview, and no query string a stranger
    can put in a shared URL should be able to break it.
    """
    return _explicit_card_language(request) or DEFAULT_UI_LOCALE


def _explicit_card_language(request):
    """The content language this request ASKED for, or ``None``.

    Separate from:func:`_requested_card_language` so "the reader asked for a
    language" and "we defaulted to English" stay distinguishable facts. It is
    NOT what gates the range probe -- see `_card_variant`, where gating on it
    cost the default path a capability the SvelteKit tier has.

    ``getlist(...)[0]``, not ``get(...)``: Django's ``QueryDict.get`` returns
    the LAST value of a repeated parameter while the ``URLSearchParams.get``
    that SvelteKit uses returns the FIRST. On ``?lang=es&lang=en`` the two tiers
    would otherwise serve different languages from the same URL, each declaring
    the other's as canonical (codex adversarial review).
    """
    values = request.GET.getlist("lang")
    return _explicit_content_language(values[0] if values else None)


def _clean_url_language(available_languages, source_language):
    """Port of ``cleanUrlLanguage``. Which language the query-free URL *is*.

    ``None`` means "no single language" -- the URL negotiates, so it is the
    cluster's ``x-default`` and never a named ``hreflang``.
    """
    variants = {code for code in available_languages if isinstance(code, str)}
    if len(variants) > 1:
        return None
    if DEFAULT_UI_LOCALE in variants:
        return DEFAULT_UI_LOCALE
    normalized = _normalize_content_language(source_language)
    # Same order as `cleanUrlLanguage`: a source that names no language (`und`)
    # owns nothing, even when it is the one stored variant.
    if not normalized:
        return None
    if isinstance(source_language, str) and source_language in variants:
        return source_language
    return normalized


def _linkable_languages(available_languages):
    """Port of ``linkableLanguages``: the variants that can become a URL.

    Every real language, not the four the UI is translated into -- an
    ``hreflang`` needs a valid BCP-47 tag, not a tag we happen to ship a navbar
    in, and filtering this list to ``UI_LOCALES`` is why a published ``zh-Hans``
    translation was advertised nowhere.

    Normalization VALIDATES; exact stored spellings are de-duplicated, but
    aliases remain separate when they identify separate API rows. The tag that
    comes back is the one the API stored, because that is the only tag the API
    can serve: ICU rewrites some perfectly valid stored tags (``cmn`` -> ``zh``)
    and advertising ``?lang=zh`` for a variant stored as ``cmn`` publishes an
    ``hreflang`` URL that resolves to the source language. Script and region are
    never collapsed either, so ``pt-PT`` stays European and ``zh-Hans`` stays
    distinct from ``zh-Hant``. Values that name no language at all (``und``,
    ``mul``, private use) are dropped, exactly as before.
    """
    named = []
    seen = set()
    for code in available_languages:
        tag = _normalize_content_language(code)
        if not tag or code in seen:
            continue
        seen.add(code)
        named.append(code if isinstance(code, str) else tag)
    return named


def _variant_path(base, language):
    """Port of ``articleTranslationHref``."""
    return f"{base}?lang={quote(language, safe='')}"


def _canonical_path(base, actual_language, source_language, available):
    """Port of ``articleCanonicalHref``, minus the external-canonical override."""
    actual = _normalize_content_language(actual_language)
    if not actual:
        return base
    actual_stored = (
        actual_language
        if isinstance(actual_language, str) and actual_language in available
        else actual
    )
    if actual_stored == _clean_url_language(available, source_language):
        return base
    # The API serves exact stored tags. ICU may normalize an alias such as
    # `cmn` to `zh`, but `?lang=zh` does not identify a row stored as `cmn`.
    language = (
        actual_language
        if isinstance(actual_language, str) and actual_language in available
        else actual
    )
    return _variant_path(base, language)


def _language_alternates(base, available, source_language):
    """Port of ``articleLanguageAlternates`` -- named languages then x-default."""
    named = _linkable_languages(available)
    if not named:
        return []
    owner = _clean_url_language(available, source_language)
    alternates = [
        {
            "hreflang": language,
            "href": base if language == owner else _variant_path(base, language),
        }
        for language in named
    ]
    alternates.append({"hreflang": "x-default", "href": base})
    return alternates

# Bare top-level SvelteKit routes that render a real page. Keep in sync with
# ts/svelte/free2z/src/routes/ (including the (auth)/ and (public)/ groups)
# and with FORBIDDEN_USERNAMES in dj/apps/g12f/usernames.py, which
# stops a creator from registering a username that shadows one of these.
# Values: (title, description, robots).
#
# Only names with a `+page.*` of their own belong here: /live, /article and
# /projects are directories of parameterised children and 404 in SvelteKit
# too, so they must keep 404ing here.
STATIC_ROUTES = {
    "creators": (
        "Creator directory – Free2Z",
        "Discover amazing creators sharing their stories and content on "
        "Free2Z, an independent platform for creative expression.",
        None,
    ),
    "trending": (
        "Trending on Free2Z",
        "The stories, articles, and updates capturing the attention of the "
        "Free2Z community right now.",
        None,
    ),
    "converse": (
        "Converse • Free2Z",
        "Join the conversation with the Free2Z community.",
        None,
    ),
    "search": (
        "Search | Free2Z",
        "Search creators, pages, and series on Free2Z.",
        NOINDEX_FOLLOW,
    ),
    "buy-2z": ("Buy 2Z | Free2Z", SITE_DESCRIPTION, NOINDEX),
    "edit": ("Edit | Free2Z", SITE_DESCRIPTION, NOINDEX),
    "login": ("Log in | Free2Z", SITE_DESCRIPTION, NOINDEX),
    "reset-password": (
        "Reset password | Free2Z", SITE_DESCRIPTION, NOINDEX,
    ),
}

# First path segments that belong to a non-HTML surface served by this same
# Django process (nginx proxies /api, /feeds, /uploads and /adminzzz to
# localhost:8001 with this very URLconf). Django's resolver falls through to
# the next pattern when an include() matches its prefix but nothing inside
# resolves, so without this guard `/api/<anything>` WOULD reach the greedy
# two-segment zPage pattern and could answer an unresolved API URL with an
# HTML social card instead of an honest 404.
NON_CRAWLER_PREFIXES = frozenset({
    "api", "adminzzz", "djstatic", "static", "uploads", "uploadz", "feeds",
    "_app", "ws",
})

# First segments that own a LITERAL two-segment route -- here or in SvelteKit.
# When such a route *declines* (an unknown `/live/x`, a non-UUID
# `/converse/x`, a non-numeric `/article/x`) SvelteKit does not fall back to
# `[username]/[vanity]`: a matched literal route wins outright. Neither may we,
# or `/live/nobody` answers with whatever unrelated page owns the vanity
# "nobody".
#
# ONLY those. Every other first segment falls through on purpose, because
# SvelteKit's `[username]/[vanity]` resolves on the globally unique vanity
# ALONE and 301s a mismatched username to the owner. `/trending/<vanity>` and
# `/creators/<vanity>` are therefore real, served URLs over there — SvelteKit's
# `trending` and `creators` routes are one-segment only and do not reserve
# their descendants. Rejecting them here would silently kill previews for
# every page of any creator whose username was not reserved when they
# registered. The username list now reserves these namespaces for new
# accounts, but existing rows still need this URL compatibility. That
# regression was caught by the codex adversarial review.
#
# `sitemap` is deliberately NOT here: SvelteKit's only two-segment sitemap
# route is the literal `sitemap/static.xml`, and `.xml` never reaches this
# tier (nginx has its own `location` for it and the extension guard clears
# $prerender anyway). `/sitemap/<vanity>` is an ordinary page URL; reserving
# the username only prevents new creators from colliding with that namespace.
LITERAL_TWO_SEGMENT_PREFIXES = frozenset({
    "article", "checkout", "converse", "creator", "live", "projects",
    # The OIDC pages: `/oauth/authorize`, `/account/apps`,
    # `/developers/apps`. Reserved in `usernames.py`; no account holds them.
    "oauth", "account", "developers",
    # `/tag/<slug>`  is a literal two-segment route in SvelteKit, and
    # nginx sends the whole `/tag/` subtree there for EVERY user agent -- so
    # nothing should reach this tier with that prefix at all. It is listed
    # anyway, and the distinction from `trending`/`creators` directly above is
    # the reason: those are deliberately absent because `/trending/<vanity>`
    # really is a zPage URL for a creator named `trending`, and reserving them
    # would have killed real preview cards. `tag` has no such rows -- it is
    # reserved in `usernames.py` and no account holds it -- so the safe answer
    # here is an honest 404 rather than whatever unrelated page happens to own
    # the vanity in the second segment. If the nginx location is ever removed,
    # this is what stops `/tag/zcash` unfurling as somebody's article.
    "tag",
    "zpage",
})

# The two-segment catch-all excludes both sets; the three-segment
# `/{username}/zpage/{slug}` one excludes only the non-HTML surfaces. The
# literal two-segment routes above cannot match a three-segment path, so
# `/live/zpage/<slug>` really is `{username}/zpage/{slug}` to SvelteKit too.
RESERVED_FIRST_SEGMENTS = NON_CRAWLER_PREFIXES | LITERAL_TWO_SEGMENT_PREFIXES

_NON_CRAWLER_PREFIX_RE = "|".join(
    re.escape(prefix) for prefix in sorted(NON_CRAWLER_PREFIXES)
)
_RESERVED_FIRST_SEGMENT_RE = "|".join(
    re.escape(prefix) for prefix in sorted(RESERVED_FIRST_SEGMENTS)
)

# The guard lives in the URL pattern itself, not only in the view, so
# `resolve('/api/healthz')` still raises Resolver404 -- code (and tests) that
# ask "is this path API surface?" must not be told yes by a crawler card. It
# also lets CommonMiddleware's APPEND_SLASH do its job: a client that requests
# the router's detail route without its trailing slash (`/api/zpage/skylar`)
# gets redirected to the real JSON endpoint, which it cannot if the URL
# "resolves" to a crawler view that then raises Http404.
#
# The views re-check case-insensitively, which the regexes deliberately do not:
# `path('api/...')` above is case-sensitive too, so `/API/x` genuinely reaches
# the greedy patterns and needs the runtime check to 404 it.
ZPAGE_VANITY_ROUTE = r"^(?!(?:{})/)(?P<username>[^/]+)/(?P<vanity>[^/]+)$".format(
    _RESERVED_FIRST_SEGMENT_RE
)

# Canonical live-stream links have the same greedy two-segment shape, so they
# need the same URL-level guard. Without it, an API include that declines an
# unknown child lets Django continue until `/api/broadcast` resolves here as
# crawler HTML instead of remaining outside the crawler tier.
#
# The type alternation is DERIVED from `PUBLIC_MEETING_TYPES` rather than
# spelled out, so adding a public stream type cannot leave this tier resolving
# a different set of URLs than the API and SvelteKit do.
PRETTY_LIVE_ROUTE = (
    r"^(?!(?:{})/)(?P<username>[^/]+)/"
    r"(?P<stream_type>{})$"
).format(
    _RESERVED_FIRST_SEGMENT_RE,
    "|".join(re.escape(value) for value in PUBLIC_MEETING_TYPES),
)

# Same guard for the LEGACY three-segment shape. It needs its own: the middle
# `zpage/` literal does not make the first segment a username, and without the
# lookahead `/api/zpage/<slug>` and `/feeds/zpage/<slug>` resolved here and
# answered ordinary API clients with 200 text/html and an OG card. `location
# /api` proxies to Django for EVERY user agent, so that reached real clients
# and monitoring, not just crawlers. (Verified on production 2026-08-08; it
# predates, but the module claimed otherwise, which is the actual defect.)
ZPAGE_LEGACY_ROUTE = (
    r"^(?!(?:{})/)(?P<username>[^/]+)/zpage/(?P<slug>[^/]+)$".format(
        _NON_CRAWLER_PREFIX_RE
    )
)


def _site_context(request, path, title, description, robots=None, image=None):
    return {
        "request": request,
        "path": path,
        "title": title,
        "description": description,
        "robots": robots,
        "image": image or SITE_IMAGE,
    }


def _render_site(request, path, title, description, robots=None, image=None):
    return render(
        request,
        "crawler/site.html",
        _site_context(request, path, title, description, robots, image),
    )


def _reject_reserved_vanity(value):
    """404 the sub-route *namespaces* that are never a zPage.

    dashboard / private / zpage and the live-stream types (broadcast / ppv /
    subscribers-only) are namespaces under ``/{username}/``. SvelteKit
    matches those literal routes ahead of ``[vanity]``; the first three have
    no bare ``+page`` and 404, while the stream types have dedicated viewer
    pages. None may resolve to an unrelated zPage card.

    ``validate_vanity`` short-circuits on create (tracked separately), so a
    page really can hold one of these -- which is the other half: without this
    guard, ``/alice/dashboard`` answers with whatever unrelated page owns the
    vanity "dashboard".

    Lives in one place because it has to hold for EVERY route that reaches a
    vanity, not just the canonical one. It was originally inline on
    ``zpage_vanity_social`` alone, and adding ``legacy_creator_social`` in a
    later commit silently reintroduced the bug on the new path.
    """
    if value.lower() in RESERVED_VANITIES:
        raise http.Http404


def _card_excerpt():
    """A bounded excerpt of the SOURCE body, redacted in SQL when paywalled.

    The redaction is an expression, not a Python branch, so paywalled body copy
    never enters this process at all -- the property
    ``test_subscriber_only_detail_never_loads_a_body_excerpt`` pins.
    ``_load_card_translations`` builds the equivalent expression for a
    translation, where the gate has to be reached across the FK.
    """
    return Case(
        When(is_subscriber_only=True, then=Value("")),
        default=Substr("content", 1, CARD_BODY_CHARS),
        output_field=TextField(),
    )


def _load_card_translations(zpage, requested_language):
    """Load the published variants this card needs -- BOUNDED, three ways.

    This tier is anonymous, reachable by anyone who sends a crawler
    User-Agent, and shares a pod's single sync gunicorn worker with the API and
    checkout. A zPage's variant count is not bounded by anything: a
    variant's language is any tag in the IANA registry, so a creator can
    accumulate thousands. An unbounded "load every published translation"
    read on this path is a remote memory-and-latency amplifier -- the finding
    the codex adversarial review rated HIGHEST on this change, and it was
    right. So:

    1. **Row count** -- at most ``CARD_MAX_VARIANTS``, the constant shared
       with the sitemap so the two tiers derive the same
       ``available_languages`` for the same article. that constant
       IS the write path's own ceiling ('s 64 published translations plus
       the source), so nothing a creator can legitimately publish is truncated
       on either tier and the two cannot disagree. The ordering below still
       pins the requested language, because the truncation remains reachable
       for legacy or directly-mutated drift rows, and dropping the one row the
       request exists to render would be worse than dropping any other.
    2. **Body bytes** -- the excerpt is computed only for the ONE variant that
       can be rendered. ``resolve_zpage_variant`` reads content from the
       selected variant and from nowhere else, so every other row carries an
       empty string and the whole response is bounded by ``CARD_BODY_CHARS``
       rather than by ``CARD_BODY_CHARS x variants``.
    3. **Paywall** -- redacted in SQL, across the FK, so a translated
       subscriber-only body never enters this process at all.

    ``is_published=True`` is a COST filter, not the security boundary: the
    boundary is ``resolve_zpage_variant(..., include_drafts=False)``, which
    both refuses to select a draft and keeps it out of ``available_languages``.
    Deleting this filter leaks nothing -- verified by mutation -- it just
    reads rows no card can ever use. Do not "simplify" it away on the theory
    that the resolver covers it; do not rely on it as the thing that stops a
    draft leaking either.

    What is NOT bounded, stated plainly because a bound that is claimed and
    absent is worse than one that is absent and known: the number of rows
    PostgreSQL must inspect. There is no index that answers "the
    ``CARD_MAX_VARIANTS`` lowest-sorting published variants of this zPage"
    without reading them all,
    so the scan is O(variants). Measured (EXPLAIN ANALYZE, one zPage):

        100 variants     Index Scan + top-N heapsort (27 kB)   0.10 ms
        1,000 variants   Index Scan + top-N heapsort (27 kB)   0.61 ms
        20,000 variants  Seq Scan   + top-N heapsort (27 kB)  10.05 ms

    Sort memory and response size are flat; only the scan grows.  caps
    published translations at 64 on the write path, which also protects the
    detail API's full-body resolution. The result-side bounds remain useful
    protection against legacy or directly-mutated drift data.

    The result is written into ``_prefetched_objects_cache`` -- the same place
    ``prefetch_related`` puts it, and the place ``localization`` reads it from.
    Done here rather than as a ``Prefetch`` on the lookup queryset because the
    bound needs the resolved language (point 2) and because a sliced
    ``Prefetch`` queryset cannot be filtered.
    """
    rows = list(
        ZPageTranslation.objects.filter(zpage=zpage, is_published=True)
        .annotate(
            named_first=Case(
                # The requested language FIRST, or the bound can drop the one
                # row this request exists to render: the slice used to be safe
                # only because a requested language was always one of the four
                # UI locales, which the next branch pins anyway (codex
                # adversarial review).
                When(language=requested_language, then=Value(-1)),
                When(language__in=UI_LOCALES, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            ),
            truncated_content=Case(
                When(zpage__is_subscriber_only=True, then=Value("")),
                When(
                    language=requested_language,
                    then=Substr("content", 1, CARD_BODY_CHARS),
                ),
                default=Value(""),
                output_field=TextField(),
            ),
        )
        .order_by("named_first", "language")
        .only("zpage_id", "language", "title", "description", "is_published")
        [:CARD_MAX_VARIANTS]
    )
    cache = getattr(zpage, "_prefetched_objects_cache", None)
    if cache is None:
        cache = zpage._prefetched_objects_cache = {}
    cache["translations"] = rows
    return rows


def _load_card_variants(zpage, requested_language):
    """:func:`_load_card_translations`, one table over ( M5).

    Every bound above is reproduced, because every reason for them is
    unchanged: this tier is anonymous, unbounded in variant count, and shares
    the pod's single sync gunicorn worker with checkout.

    Three differences, all forced by the shape:

    * The SOURCE variant is one of these rows now, so it is pinned first in the
      truncation order and the slice is one wider. The surviving language set
      is then exactly today's -- source plus the same ``CARD_MAX_VARIANTS``
      translations, chosen by the same ``(named, language)`` key -- which
      matters because that set becomes the card's ``hreflang`` cluster and it
      must not disagree with the sitemap's for the same article.
    * The source row must carry an excerpt as well: with reads flipped the
      card's body copy comes from it, where today it comes from the
      ``card_content`` annotation on the zPage row.
    * The source is loaded even if its ``is_published`` says otherwise, which
      can only happen under drift. ``_published_zpage_or_404`` has already
      established that the ARTICLE is public; refusing to load its own text on
      the strength of a mirror row would blank a live card.

    The paywall gate is still an SQL ``Case`` across the FK, not a Python
    branch, so a paywalled body never enters this process -- ``origin`` does
    not change that and must not be allowed to look like it does.
    """
    rows = list(
        ZPageVariant.objects.filter(zpage=zpage)
        .filter(Q(is_published=True) | Q(origin=ZPageVariant.SOURCE))
        .annotate(
            named_first=Case(
                When(origin=ZPageVariant.SOURCE, then=Value(0)),
                #...then the requested language, for the same reason as in
                # `_load_card_translations`: a bound that can discard the row
                # being asked for serves the wrong language.
                When(language=requested_language, then=Value(1)),
                When(language__in=UI_LOCALES, then=Value(2)),
                default=Value(3),
                output_field=IntegerField(),
            ),
            truncated_content=Case(
                When(zpage__is_subscriber_only=True, then=Value("")),
                When(
                    language=requested_language,
                    then=Substr("content", 1, CARD_BODY_CHARS),
                ),
                When(
                    origin=ZPageVariant.SOURCE,
                    then=Substr("content", 1, CARD_BODY_CHARS),
                ),
                default=Value(""),
                output_field=TextField(),
            ),
        )
        .order_by("named_first", "language")
        .only(
            "zpage_id", "language", "title", "description", "is_published",
            "origin", "source_digest",
        )
        [:CARD_MAX_VARIANTS + 1]
    )
    if rows and rows[0].origin != ZPageVariant.SOURCE:
        # The extra slot exists to hold the SOURCE row. A published page whose
        # `source_language` is NULL has no source variant by design, so without
        # this the slice would admit one more TRANSLATION than the legacy path
        # -- and that extra language would enter the card's hreflang cluster
        # while the sitemap, bounded at the same number, never emits it. A cluster whose
        # members disagree is discarded wholesale. `rows[0]` is enough of a
        # test because the source is pinned first by `named_first`.
        rows = rows[:CARD_MAX_VARIANTS]
    setattr(zpage, RESOLUTION_VARIANTS_ATTR, rows)
    return rows


def _published_zpage_or_404(slug, *, allow_reserved_identifier=False):
    """Resolve a publicly visible zPage by its shared identity precedence.

    ``zPage.get_public_url()`` falls back to ``free2zaddr`` when a page has no
    vanity, so both forms are real, shareable URLs.

    ``resolve_zpage_pk`` is deliberately identity-first and visibility-blind,
    with the shared precedence of exact ``free2zaddr``, exact ``vanity``,
    canonical ``slugify(slug)``, then case-insensitive ``vanity``. The resolved
    pk is applied to the visible queryset below, so a hidden page fails closed
    instead of falling through to a public page whose vanity squats its
    identifier.

    ``is_published=True`` is the whole point: before  this lookup was a
    bare ``get_object_or_404(zPage, vanity=slug)``, so any crawler that
    guessed a draft's vanity got its title, description and *full body copy*
    rendered into an anonymous HTML response.

    ``creator__is_active`` matters just as much: deactivating a creator (the
    moderation lever) does not unpublish their pages, so without it a banned
    account's profile 404s while every one of its zPages keeps serving a card.
    The rest of the platform caught up in: the shared
    ``zPage.objects.published_and_active()`` helper now expresses the same rule
    for the API, the feeds, the sitemap and the comment threads, and this tier
    keeps its explicit ``filter()`` only because it also needs the deferred
    ``content`` + card-excerpt annotations below.

    Identity resolution happens before the visibility filter because
    ``vanity`` and ``free2zaddr`` are each unique but not unique *against each
    other*. The immutable identity must win, and the existing visible queryset
    retains the deferred ``content`` and card-excerpt annotations.
    """
    if not allow_reserved_identifier:
        _reject_reserved_vanity(slug)

    visible = zPage.objects.published_and_active().select_related(
        "creator"
    ).defer("content").annotate(
        card_content=_card_excerpt(),
        # Same expression under the name `localization._content_value` looks
        # for. `resolve_zpage_variant` reads `truncated_content` when it is
        # present and falls back to `.content` when it is not -- and `.content`
        # is deferred here, so without this alias reusing the shared resolver
        # would silently issue a second query for the full 100,000-character
        # body on the single sync gunicorn worker. Two SUBSTRINGs over one
        # already-read row, no extra rows.
        truncated_content=_card_excerpt(),
    )

    pk = resolve_zpage_pk(slug)
    if pk is None:
        raise http.Http404
    zpage = visible.filter(pk=pk).first()
    if zpage is None:
        raise http.Http404
    return zpage


def _card_content(zpage, text=None):
    """Return annotated public card copy without ever loading the full body.

    ``text`` is the resolved variant's already-bounded excerpt when the card is
    rendering a translation; omitting it reads the source page's annotation.
    Either way the gate is identical and it fails CLOSED -- unless
    ``is_subscriber_only`` is loaded and explicitly ``False``, nothing is
    returned, so a partially-loaded instance cannot render paywalled copy.
    """
    loaded = zpage.__dict__
    if loaded.get("is_subscriber_only") is not False:
        return ""
    if text is not None:
        return text or ""
    return loaded.get("card_content") or ""


def _card_description(zpage, description=None, body=None):
    """A bounded plain-text description; never markdown-render the body.

    This tier runs on the same single sync gunicorn worker that serves the
    API and checkout (`k8s/free2z/deployment.yaml`), and `content` is a
    100,000-character field. The old fallback ran `markdown2` over the whole
    body and then interpolated the result into four separate meta attributes,
    so one crawler sweep over the ~4,200 sitemap URLs was ~4x a full-document
    markdown render per request, queued behind money traffic. No consumer
    reads more than ~200 characters of a meta description anyway.

    The *derivation* is `meta_description.compact_text` and NOT local to this
    module on purpose. nginx routes `$seobot` to SvelteKit SSR and
    `$prerender` here, so this string and SSR's `compactText()` describe the
    same article to different halves of the crawler population; until they
    were reconciled Google got 194 word-boundary characters and Twitterbot got
    310 mid-word ones with a literal newline inside the attribute, and
    /example_creator/maps served a meta description that was a raw `# Maps` heading and
    an unrendered `::embed[…]`. `testdata/meta_description_parity.json` is the
    golden table both runtimes assert against.

    The creator's own `description` goes through the same call rather than
    being returned verbatim. It is a 255-character free-text field: it can
    hold newlines and markdown, a newline inside an HTML attribute is a defect
    whoever typed it, and SSR has always compacted it — returning it raw here
    was itself a source of the drift.
    """
    if description is None:
        description = zpage.description
    if description:
        return compact_text(description, ARTICLE_DESCRIPTION_FALLBACK)
    if zpage.is_subscriber_only:
        # Never derive the meta description from paywalled body copy.
        return SUBSCRIBER_ONLY_DESCRIPTION
    return compact_text(
        _card_content(zpage) if body is None else body,
        ARTICLE_DESCRIPTION_FALLBACK,
    )


def _card_variant(request, zpage):
    """Resolve which language variant of ``zpage`` this request asked for.

    Delegates SELECTION to ``localization.resolve_zpage_variant`` -- the same
    function the zPage API and therefore the SvelteKit page resolve through --
    so the fallback rule ("the requested language when a published variant
    exists, otherwise the source") has exactly one implementation. Only the URL
    arithmetic above is ported.
    """
    requested = _requested_card_language(request)
    rows = _load_card_rows(zpage, requested)

    # A language RANGE needs resolving against the variants this article HAS,
    # and only when the requested tag is not already one of them -- an exact hit
    # is what `resolve_zpage_variant` selects anyway, which is the overwhelming
    # majority of requests.
    #
    # Deliberately NOT gated on an explicit `?lang=`. `DEFAULT_UI_LOCALE` is a
    # request too: on a Spanish-source article carrying an `en-US` translation, a
    # cookieless reader of the QUERY-FREE URL gets `en-US` from the SvelteKit
    # loader -- which resolves the same range from `available_languages` with no
    # `?lang=` in sight -- so a tier that skipped the probe served `es` under a
    # contradicting canonical at the same URL. Gating it was a cost saving that
    # bought a tier divergence (codex, twice; reviewer F3).
    #
    # Reloading through the same bounded helper is what keeps the row-count and
    # body-byte bounds documented on `_load_card_translations` intact: the
    # excerpt is still computed for exactly one variant, and that variant is now
    # the one that will actually be rendered.
    tag = _normalize_content_language(requested)
    loaded = _linkable_languages(_card_row_languages(zpage, rows))
    # An exact stored hit -- including a preserved alias such as `cmn` -- is
    # what `resolve_zpage_variant` selects and what the SvelteKit tier serves
    # without a second request, so it must never be range-resolved away to a
    # `zh-Hans` sibling. An alias with no row of its own falls back to the
    # spelling it folds to (`cmn` -> `zh`), as `variantLanguageRetry` does.
    if tag and requested not in loaded:
        if tag in loaded:
            resolved = tag
        else:
            resolved = _resolve_content_language_range(
                tag, _published_languages_sharing_primary(zpage, tag),
            )
        if resolved and resolved != requested:
            requested = resolved
            _load_card_rows(zpage, requested)

    return resolve_zpage_variant(zpage, requested)


#Belt-and-braces ceiling on the range probe below. It is not the real bound
#-- that is 's cap of 64 published translations per zPage, and the probe
#additionally filters to ONE primary subtag and selects ONE column. It exists
#so a corpus that somehow violates that cap degrades into "cannot resolve"
#rather than into an unbounded read, and it is deliberately far above the cap
#so no reachable article is silently truncated by it.
#
#It must NOT be tightened to "just enough to detect ambiguity". A limit
#applied before the script filter returns the alphabetically first rows, so
#`zh-Hans-CN`, `zh-Hans-HK`, `zh-Hans-SG`, `zh-Hant-HK`, `zh-Hant-MO` + a
#limit of 4 leaves exactly one Traditional candidate and resolves
#`?lang=zh-Hant-TW` to it, while the reader route sees both and refuses to
#guess (codex adversarial review).
RANGE_CANDIDATE_CEILING = 128


def _published_languages_sharing_primary(zpage, tag):
    """Every published variant of ``zpage`` whose language shares TAG's primary
    subtag, asked of the WHOLE table rather than of the rows the card loaded.

    This distinction is the whole point. The card load is bounded at
    ``CARD_MAX_VARIANTS``, so an article with more published translations than
    that can hand this tier a set containing
    ``zh-Hans`` from which ``zh-Hant`` has been truncated -- and a resolver
    looking only at that set concludes ``?lang=zh`` uniquely means Simplified,
    while the reader route, which sees the API's complete
    ``available_languages``, correctly refuses to guess. One URL, two tiers, two
    different languages and two different canonicals: the exact class of
    disagreement that costs an hreflang cluster (codex adversarial review).

    Bounded without being truncating: one zPage's rows, narrowed in SQL to a
    single primary subtag, selecting the ``language`` column and nothing else --
    no bodies -- under a ceiling far above 's cap of 64 published
    translations. The completeness matters as much as the bound: a limit small
    enough to bite would return the alphabetically first tags and make an
    ambiguous request look unique.
    """
    primary = tag.split("-")[0]
    # Case-SENSITIVE on purpose. `iexact`/`istartswith` compile to
    # `UPPER(language) LIKE UPPER(...)`, which cannot use an index and seq
    # scans -- `test_vanity_lookup_is_case_insensitive_but_exact_first` guards
    # exactly that on this tier, and it caught this. Both sides are canonical
    # tags anyway: `_normalize_content_language` lowercases the primary subtag,
    # and so does everything that writes a variant row.
    match = Q(language=primary) | Q(language__startswith=f"{primary}-")
    if variant_reads_enabled():
        rows = ZPageVariant.objects.filter(zpage=zpage).filter(
            Q(is_published=True) | Q(origin=ZPageVariant.SOURCE)
        )
    else:
        rows = ZPageTranslation.objects.filter(zpage=zpage, is_published=True)
    found = list(
        rows.filter(match)
        .order_by("language")
        .values_list("language", flat=True)[:RANGE_CANDIDATE_CEILING]
    )
    # The rows are matched by tag prefix, but the ANSWER is decided by the
    # canonical form, exactly as the reader route decides it.
    if not variant_reads_enabled():
        # The legacy shape keeps the source language on the zPage row, so it is
        # not in the query above -- and it is a variant like any other here.
        source = zpage.source_language
        if (
            isinstance(source, str)
            and source
            and source.split("-")[0].casefold() == primary.casefold()
        ):
            found.append(source)
    return found


def _load_card_rows(zpage, requested_language):
    """The bounded variant load, whichever table this deployment reads."""
    if variant_reads_enabled():
        return _load_card_variants(zpage, requested_language)
    return _load_card_translations(zpage, requested_language)


def _card_row_languages(zpage, rows):
    """Every language the loaded rows can serve, source included.

    The legacy table holds translations only, so the source language has to be
    added explicitly; with variant reads it is already one of the rows. Either
    way duplicates are harmless -- `_linkable_languages` dedupes.
    """
    codes = [getattr(row, "language", None) for row in rows or ()]
    codes.append(zpage.source_language)
    return [code for code in codes if isinstance(code, str) and code]


def _zpage_card_context(request, zpage):
    """Everything ``zpage/social.html`` needs, resolved for ONE variant.

    Split out of the render so the template's canonical/og:url contract can be
    exercised against the real context rather than a hand-built one -- the
    template no longer computes the canonical itself, because the language
    arithmetic that decides it does not belong in a template.
    """
    variant = _card_variant(request, zpage)
    body = _card_content(zpage, variant.content)
    base = zpage.get_public_url()
    canonical_path = _canonical_path(
        base,
        variant.actual_language,
        zpage.source_language,
        variant.available_languages,
    )
    return {
        "zpage": zpage,
        "request": request,
        "title": variant.title,
        # The variant's own subtitle, exactly as stored. Distinct from
        # `description`, which falls back to an excerpt for the meta tags: the
        # <h2> must stay empty when the creator wrote no description rather
        # than repeating the body that follows it.
        "subtitle": variant.description,
        "description": _card_description(
            zpage, variant.description, body,
        ),
        "gated": zpage.is_subscriber_only,
        "body": "" if zpage.is_subscriber_only else body,
        "canonical_path": canonical_path,
        # `hreflang` is only meaningful on a page that is its own canonical.
        # When the creator has republished elsewhere, advertising Free2Z
        # `?lang=` URLs as alternates of a foreign canonical says nothing true
        # -- the same rule `lib/meta.ts` applies on the SvelteKit side.
        "alternates": [] if zpage.canonical_url else _language_alternates(
            base, variant.available_languages, zpage.source_language,
        ),
        # The language of the CARD's text. The UI-locale normalizer here meant a
        # Chinese card declared no language at all.
        "content_language": _normalize_content_language(
            variant.actual_language,
        ),
        #...and which WAY that text runs. `lang` and `dir` are
        # independent attributes, so  made this tier declare Arabic
        # correctly and still render it left-to-right.
        #
        # This tier is a full second implementation of the reader -- nginx sends
        # the `prerender` cookie outcome here and `seobot` to SvelteKit -- so a
        # direction only fixed in SvelteKit would make one URL lay out two
        # different ways depending on which upstream answered. Same helper
        # semantics, same golden table.
        "content_direction": languages.direction_attribute(
            variant.actual_language,
        ),
    }


def _render_zpage(request, zpage):
    return render(
        request, "zpage/social.html", _zpage_card_context(request, zpage),
    )


def _active_creator_or_404(username):
    return get_object_or_404(
        Creator, username__iexact=username, is_active=True,
    )


# --- views ---------------------------------------------------------------
#
# `@require_safe` (GET + HEAD) on every one of them. This tier renders link
# previews; there is no method other than GET and HEAD that means anything
# here, and a bare Django function view answers every verb by default. Two
# things follow that are worth more than the 405 itself:
#
#   * `?lang=` is now read by these views. 's rule is that a URL never
#     dictates what goes in the database, and `dj/apps/test_url_write_guard.py`
#     enforces it statically by treating an unpinned function view as a write
#     context -- correctly, since Django would dispatch a POST to it. Pinning
#     the verbs is what makes "this parameter selects a representation" a fact
#     the analyzer can see, rather than a claim in a comment.
#   * nginx routes ANY method whose User-Agent matches $prerender here, so
#     without this a POST to a page URL rendered a 200 card.


@require_safe
def find_social(request):
    """`/` and `/find` — the site card plus a crawlable list of top pages."""
    zpages = zPage.objects.published_and_active().filter(
        f2z_score__gte=0,
    ).exclude(
        vanity=""
    ).select_related("creator").only(
        "title", "vanity", "free2zaddr", "creator__username",
    ).order_by('-f2z_score')[:100]
    return render(request, 'zpage/find_social.html', {
        'zpages': zpages,
        'request': request,
        # Passed rather than hardcoded in the template so this tier has exactly
        # one definition of the site card image ( Phase 4).
        'site_image': SITE_IMAGE,
    })


@require_safe
def zpage_social(request, slug):
    """Legacy `/zpage/{slug}`."""
    return _render_zpage(request, _published_zpage_or_404(slug))


@require_safe
def article_social(request, identifier):
    """`/article/{identifier}`, the collision-safe immutable article route.

    SvelteKit now passes the complete segment to ``/api/zpage/{id}/``. The
    canonical URL helper selects this route specifically when a creator's
    pretty URL collides with a product or ingress namespace, normally using
    ``free2zaddr``. Resolve through the shared identity precedence so crawler
    previews and browser visits cannot disagree or let a vanity squatter beat
    the immutable address.
    """
    return _render_zpage(
        request,
        _published_zpage_or_404(
            identifier,
            # /article is outside the creator namespace. Reserved child-route
            # names are therefore legitimate immutable identities here and
            # still resolve address-first through resolve_zpage_pk().
            allow_reserved_identifier=True,
        ),
    )


@require_safe
def zpage_social_new(request, username, slug):
    """Legacy `/{username}/zpage/{slug}`.

    SvelteKit 301s this shape to `/{username}/{slug}`; old shared links must
    keep rendering a card, and the canonical tag in the template points at
    the current URL either way.
    """
    if username.lower() in NON_CRAWLER_PREFIXES:
        # Case-insensitive backstop for ZPAGE_LEGACY_ROUTE's (case-sensitive)
        # negative lookahead -- `/API/zpage/x` reaches here, `/api/zpage/x`
        # does not. Its absence is what let `/api/zpage/skylar` answer an API
        # client with an HTML card. Only the non-HTML surfaces: SvelteKit
        # resolves `/live/zpage/<slug>` as `{username}/zpage/{slug}` too.
        raise http.Http404
    return _render_zpage(request, _published_zpage_or_404(slug))


@require_safe
def zpage_vanity_social(request, username, vanity):
    """Canonical `/{username}/{vanity}` — the shape the sitemap publishes.

    The username segment is not part of the lookup: the vanity is globally
    unique, and SvelteKit 301s a mismatched username to the owner's URL. The
    template emits the owner's canonical URL, so a mismatch collapses to one
    indexable URL rather than 404ing a real, shared link.
    """
    if username.lower() in RESERVED_FIRST_SEGMENTS:
        # Case-insensitive backstop for ZPAGE_VANITY_ROUTE's (case-sensitive)
        # negative lookahead -- `/API/x` reaches here where `/api/x` does not.
        raise http.Http404
    # The RESERVED_VANITIES guard lives in _published_zpage_or_404 so every
    # route that reaches a vanity gets it, not just this one.
    return _render_zpage(request, _published_zpage_or_404(vanity))


@require_safe
def creator_social(request, username):
    """A creator profile card."""
    creator = _active_creator_or_404(username)
    return render(request, 'creator/social.html', {
        'creator': creator,
        'request': request,
    })


@require_safe
def legacy_creator_social(request, username):
    """`/creator/{username}` — a Django-only legacy route, vanity FIRST.

    SvelteKit has no `creator/` route at all, so over there `/creator/alice`
    is `[username]="creator"` / `[vanity]="alice"` and resolves to the zPage
    with vanity "alice". Existing rows can hold that name, so
    `get_public_url()` can mint `/creator/{vanity}` as their pages' canonical
    URL even though new registrations reject it.

    Resolving the profile first would then let an attacker named `creator`
    publish a page whose vanity is a trusted creator's username: the unfurled
    card would show that trusted creator while the click opened the
    attacker's page. Matching SvelteKit — vanity first — is what keeps the
    preview and the clicked page the same object (codex adversarial review).
    Old `/creator/{username}` profile links still work whenever no zPage owns
    that vanity, which is the overwhelmingly common case.
    """
    # Explicitly, not just via _published_zpage_or_404: this route's fallback
    # would otherwise serve a PROFILE card for `/creator/dashboard`, which
    # SvelteKit resolves to its literal `[username]/dashboard` route and 404s.
    _reject_reserved_vanity(username)

    # Narrow on purpose: only the lookup may fall back. Wrapping the render
    # too would let a found page silently degrade into a profile card if
    # _render_zpage ever raised Http404.
    try:
        zpage = _published_zpage_or_404(username)
    except http.Http404:
        return creator_social(request, username)
    return _render_zpage(request, zpage)


@require_safe
def creator_social_root(request, username):
    """`/{username}` — a creator profile, or a real static top-level route.

    Literal SvelteKit routes win over the `[username]` parameter, so
    `/creators` and `/trending` are resolved here *before* the creator
    lookup. Before  they fell straight through to the lookup and 404'd.
    """
    static = STATIC_ROUTES.get(username.lower())
    if static is not None:
        title, description, robots = static
        return _render_site(
            request,
            path=f"/{username.lower()}",
            title=title,
            description=description,
            robots=robots,
        )
    return creator_social(request, username)


def _render_live_card(request, creator, stream_type):
    """The one live-stream viewer card, under its one canonical URL.

    `/live/{username}` and `/{username}/{type}` describe the SAME viewer, so
    they get the same document -- and, since, the same
    ``<link rel=canonical>``: ``/{username}/{type}``, which is the shape
    ``ts/svelte/free2z/src/lib/utils/stream-path.ts`` (``streamWatchPath``)
    already emits on the SvelteKit tier. Before this, `live_social` declared
    ITSELF canonical while SSR declared `/{username}/broadcast` for the very
    same URL -- the two-tier canonical disagreement  is about.

    ``robots`` is ``noindex, follow`` on purpose, and the reasoning matters
    because a canonical alone would not have fixed this:

      * There are four viewer URLs per creator and 336 creators in the
        sitemap. Consolidating them still leaves 336 pages whose entire
        indexable content is "{name} is live on Free2Z" -- a title, a generic
        sentence and an avatar, identical in structure for every creator.
      * The page is *ephemeral*. It says someone is live; most of the time
        nobody is. An indexed snapshot of it is wrong more often than right.
      * The durable, indexable surface for a creator is `/{username}`, which
        IS in the sitemap. ``follow`` (not ``nofollow``) is what lets the
        crawl equity these URLs collect flow there.

    ``noindex`` and a SELF-referential canonical would be the textbook-safe
    pair; a cross-referential canonical on a ``noindex`` page can propagate
    the noindex to its target. That is deliberately harmless here: the target
    (`/{username}/{type}`) is itself ``noindex, follow``, so there is nothing
    to lose and the two tiers get to state one identical canonical instead of
    two contradictory ones.

    This is the meta tag, NOT a ``robots.txt`` ``Disallow``. A disallowed URL
    is never fetched, so Google would never see the ``noindex`` and the URLs
    would linger in the index URL-only. None of these paths is in the sitemap
    either, so no sitemap advertises a noindexed URL.
    """
    return _render_site(
        request,
        path=f"/{creator.username}/{stream_type}",
        title=f"{creator.best_name()} is live on Free2Z",
        description=(
            f"Watch {creator.best_name()}'s live stream on Free2Z."
        ),
        image=creator.get_avatar_url_safe(),
        robots=NOINDEX_FOLLOW,
    )


@require_safe
def live_social(request, username):
    """`/live/{username}` — the LEGACY alias of `/{username}/{type}`.

    ``?type=`` selects which of the creator's three public streams the alias
    means, exactly as ``loadLivePage`` does on the SvelteKit tier: absent or
    empty falls back to ``broadcast``; the value is lower-cased; anything
    outside the public enum 404s rather than rendering a card for a URL that
    404s the moment a human clicks it. ``private`` is outside the enum by
    construction -- a private
    room's URL is `/{username}/private/{secret}` and the secret is the
    credential.

    Reading it is what makes the canonical correct: `/live/x?type=ppv` used
    to unfurl under a canonical of `/live/x`, which is a DIFFERENT stream.
    It selects a representation and touches nothing (``@require_safe``).
    """
    # `getlist(...)[0]`, not `get(...)`, for the same reason
    # `_requested_card_language` does it: QueryDict.get returns the LAST value
    # of a repeated parameter while the URLSearchParams.get SvelteKit uses
    # returns the FIRST. On `?type=broadcast&type=private` the card tier would
    # otherwise 404 a URL SvelteKit renders, and on
    # `?type=ppv&type=broadcast` it would hand out a broadcast canonical for a
    # URL SvelteKit treats as PPV (codex adversarial review).
    values = request.GET.getlist("type")
    stream_type = ((values[0] if values else None) or BROADCAST).lower()
    if stream_type not in PUBLIC_MEETING_TYPES:
        raise http.Http404
    creator = _active_creator_or_404(username)
    return _render_live_card(request, creator, stream_type)


@require_safe
def pretty_live_social(request, username, stream_type):
    """`/{username}/{type}` — canonical public live-stream viewer URL."""
    if stream_type not in PUBLIC_MEETING_TYPES:
        raise http.Http404
    creator = _active_creator_or_404(username)
    return _render_live_card(request, creator, stream_type)


@require_safe
def checkout_social(request, ref):
    """`/checkout/{ref}` — a private surface; card exists, never indexed."""
    return _render_site(
        request,
        path=f"/checkout/{ref}",
        title="Checkout | Free2Z",
        description=SITE_DESCRIPTION,
        robots=NOINDEX,
    )


@require_safe
def converse_social(request, uuid):
    comment = get_object_or_404(Comment, uuid=uuid)
    # A comment's OG/social card is only as public as the thread it belongs to.
    # Previously this served the card for a comment on any unpublished/
    # subscriber-only page or private conversation; contrast ai_social
    # below, which has always filtered is_public=True. Standalone converse
    # posts (no content_object) stay public while their author's account is
    # active.
    if not comment_visible(comment, request.user):
        raise http.Http404
    return render(request, 'comments/social.html', {
        'comment': comment,
        'request': request,
    })


@require_safe
def ai_social(request, uuid):
    # Security: this OG/social-card route is anonymous and public by
    # nature (link-preview crawlers). A subscriber-only conversation must not
    # get a public share card -- rendering it leaks the paywalled
    # conversation's existence, title and creator to anyone with the UUID.
    # Same exclusion the RSS feeds use.
    conversation = get_object_or_404(
        Conversation,
        id=uuid,
        is_public=True,
        user__is_active=True,
        is_subscriber_only=False,
    )
    return render(request, 'openai/social.html', {
        'conversation': conversation,
        'request': request,
    })


# Same drift guard, for the two-segment set. A prefix in
# LITERAL_TWO_SEGMENT_PREFIXES that is NOT in FORBIDDEN_USERNAMES silently
# 404s every page of any creator holding that name -- exactly the regression
# the codex review caught on the first cut of this set. These two are now
# reserved for new accounts, but their dedicated views above still fall back
# to a vanity lookup so existing accounts using those names keep working.
VANITY_FALLBACK_PREFIXES = frozenset({"creator", "zpage"})
UNRESERVED_TWO_SEGMENT_PREFIXES = LITERAL_TWO_SEGMENT_PREFIXES - frozenset(
    FORBIDDEN_USERNAMES
)

# The crawler's non-HTML prefixes are also real namespaces. Keep this check
# separate from the two-segment check so adding a new API/static prefix cannot
# silently create a username collision.
UNRESERVED_NON_CRAWLER_PREFIXES = NON_CRAWLER_PREFIXES - frozenset(
    FORBIDDEN_USERNAMES
)

# Guard against this module and the username reservation list drifting apart:
# every static route we answer must also be un-registrable as a username, or a
# creator could take it and shadow a real page.
UNRESERVED_STATIC_ROUTES = frozenset(STATIC_ROUTES) - frozenset(
    FORBIDDEN_USERNAMES
)
