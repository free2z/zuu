"""Language on the two crawler-facing tiers ( Part 8).

Two defects, one fix:

1. **No sitemap emitted a language entry at all.** We paid to store
   translations and then skipped the part that earns the traffic.
2. **The crawler prerender tier always served the source variant.** A creator
   who shared ``/{user}/{vanity}?lang=es`` got an English unfurl card under a
   canonical that contradicted what SvelteKit serves at that same URL.

The hard requirement in both cases is agreement: an ``hreflang`` cluster whose
members declare a different ``rel=canonical`` is discarded wholesale by a
search engine, so the Django tier, the SvelteKit article page and the sitemap
have to answer "what is this variant's URL?" identically. They are three
implementations in two runtimes, so the expected answer lives in one file --
``testdata/zpage_language_parity.json`` -- which
``ts/svelte/free2z/tests/sitemap-language.test.mjs`` asserts against too.
"""

import datetime
import json
import pathlib
import re
import uuid

import pytest
from langcodes.registry_parser import parse_registry
from django.db import connection
from django.http import QueryDict
from django.test.utils import CaptureQueriesContext

from dj.apps.g12f.localization import variant_reads_enabled
from dj.apps.g12f.models import ZPageTranslation, zPage
from dj.apps.g12f.views import crawler
from dj.apps.g12f.views.crawler import CARD_MAX_VARIANTS

from f2z import languages
from dj.apps.g12f.serializers.zpage import (
    MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
)
from dj.apps.g12f.views.sitemap import (
    SITEMAP_CHUNK_SIZE,
    SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK,
    SITEMAP_MAX_VARIANTS_PER_ZPAGE,
    _available_languages,
    _zpage_variant_index,
    build_sitemap_chunk,
)


HOST = "testserver"
PARITY = json.loads(
    (
        pathlib.Path(__file__).parent / "testdata" / "zpage_language_parity.json"
    ).read_text()
)
MACROLANGUAGE_PARITY = json.loads(
    (
        pathlib.Path(__file__).parent
        / "testdata"
        / "macrolanguage_normalization_parity.json"
    ).read_text()
)


def _page(creator, **kwargs):
    kwargs.setdefault("vanity", f"page-{uuid.uuid4().hex[:12]}")
    kwargs.setdefault("title", "Original title")
    kwargs.setdefault("description", "Original description")
    kwargs.setdefault("content", "Original body copy.")
    kwargs.setdefault("is_published", True)
    return zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), **kwargs,
    )


def _translation(page, language, **kwargs):
    kwargs.setdefault("title", f"{language} title")
    kwargs.setdefault("description", f"{language} description")
    kwargs.setdefault("content", f"{language} body copy.")
    kwargs.setdefault("is_published", True)
    return ZPageTranslation.objects.create(
        zpage=page, language=language, **kwargs,
    )


def _get(client, path):
    return client.get(path, HTTP_HOST=HOST)


def _html(response):
    return response.content.decode()


def _canonical(html):
    marker = '<link rel="canonical" href="'
    start = html.index(marker) + len(marker)
    return html[start:html.index('"', start)]


def _alternates(html):
    found = []
    cursor = 0
    marker = '<link rel="alternate" hreflang="'
    while True:
        start = html.find(marker, cursor)
        if start == -1:
            return found
        start += len(marker)
        end = html.index('"', start)
        href_start = html.index('href="', end) + len('href="')
        found.append(
            {
                "hreflang": html[start:end],
                "href": html[href_start:html.index('"', href_start)],
            }
        )
        cursor = href_start


# --- the golden table ------------------------------------------------------


def test_crawler_url_arithmetic_matches_the_golden_table():
    """The Python port and the JS original answer identically, case by case."""
    base = PARITY["base"]
    for case in PARITY["cases"]:
        available = case["available_languages"]
        source = case["source_language"]

        assert crawler._language_alternates(base, available, source) == (
            case["alternates"]
        ), case["name"]

        for actual, expected in case["canonical_by_actual"].items():
            assert crawler._canonical_path(
                base, actual, source, available
            ) == expected, f"{case['name']} serving {actual}"

        for alternate in case["alternates"]:
            if alternate["hreflang"] == "x-default":
                continue
            assert crawler._canonical_path(
                base, alternate["hreflang"], source, available
            ) == alternate["href"], (
                f"{case['name']} alternate {alternate['hreflang']} must be self-canonical"
            )


def test_a_language_range_resolves_identically_in_both_runtimes():
    """The golden table pins the RESOLVER, not only the URL arithmetic.

    `resolveContentLanguageRange` and `_resolve_content_language_range` are one
    algorithm written twice. A divergence means one URL serves two languages
    with contradicting canonicals -- and until this existed, nothing
    cross-runtime checked it at all (reviewer F2).
    """
    for case in PARITY["range"]:
        assert crawler._resolve_content_language_range(
            case["requested"], case["available"]
        ) == case["resolved"], f"range {case['requested']} in {case['available']}"


def test_the_content_language_normalizer_matches_the_js_port():
    for case in PARITY["normalize"]:
        assert crawler._normalize_content_language(case["input"]) == case["tag"], (
            f"normalize {case['input']!r}"
        )


def test_the_explicit_selector_matches_the_js_port():
    """``?lang=`` keeps a stored macrolanguage alias, and ONLY that.

    A whole-tag mapping (``sgn-BR`` -> ``bzs``, ``zh-hakka`` -> ``hak``) is not
    an alias spelling: re-attaching its raw primary names a different language.
    ``explicitArticleLanguage`` runs the same table.
    """
    for case in PARITY["explicit"]:
        assert crawler._explicit_content_language(case["input"]) == case["tag"], (
            f"explicit {case['input']!r}"
        )


def test_an_unnamed_single_source_owns_no_clean_url_like_the_js_port():
    # `cleanUrlLanguage(["und"], "und")` is null; the stored-spelling shortcut
    # must not hand ownership to a tag that names no language.
    assert crawler._clean_url_language(["und"], "und") is None
    assert crawler._clean_url_language(["cmn"], "cmn") == "cmn"


def test_crawler_selector_preserves_aliases_and_first_parameter_precedence():
    request = type("Request", (), {})()
    request.GET = QueryDict("lang=cmn&lang=zh")
    assert crawler._explicit_card_language(request) == "cmn"

    request.GET = QueryDict("lang=%3Cscript%3E&lang=cmn")
    assert crawler._explicit_card_language(request) is None


def test_macrolanguage_normalization_matches_icu_across_the_iana_registry():
    """Sweep every bundled IANA Macrolanguage subtag against the shared ICU table."""
    registry_subtags = {
        item["Subtag"]
        for item in parse_registry()
        if item.get("Type") == "language" and item.get("Macrolanguage")
    }
    cases = MACROLANGUAGE_PARITY["cases"]
    covered_primaries = {case["input"].split("-", 1)[0] for case in cases}
    assert len(cases) == 453, "refresh the IANA and suffixed ICU parity cases"
    assert covered_primaries == registry_subtags, (
        "parity table must cover bundled IANA data"
    )

    for case in MACROLANGUAGE_PARITY["cases"]:
        assert crawler._normalize_content_language(case["input"]) == case["tag"], (
            f"macrolanguage normalize {case['input']!r}"
        )


def test_the_documented_runtime_divergences_are_exactly_these():
    """Well-formed BCP-47 that the IANA registry rejects.

    The JS tier forwards such a tag, the API answers 400, and the reader route
    renders DEFAULT_LOCALE -- which is exactly what this tier serves for the
    same input. The tag differs; the CONTENT does not. A divergence where BOTH
    runtimes name a language would be a live defect, so that shape is asserted
    impossible rather than merely absent.
    """
    for case in PARITY["normalize_runtime_divergence"]:
        assert crawler._normalize_content_language(case["input"]) == (
            case["python"]
        ), f"divergence {case['input']!r}"
        assert case["python"] is None, case
        assert case["js"] is not None, case


def test_text_direction_resolves_identically_in_both_runtimes():
    """Which WAY the text runs is the third duplicated algorithm.

    ``ts/svelte/free2z/tests/text-direction.test.mjs`` asserts this same table
    against ``contentDirectionAttribute``. This tier renders the same URL as
    SvelteKit -- nginx routes the ``prerender`` cookie outcome here -- so a
    divergence lays one article out two ways depending on which upstream
    answered, which is the  failure shape one attribute over.

    The table pins the ANSWER and not the intermediate script on purpose: ICU and
    langcodes are free to disagree about ``ur`` being ``Arab`` or ``Aran``, both
    being right-to-left, and pinning the script would go red over a difference
    that changes no layout.
    """
    assert len(PARITY["direction"]) >= 40, "the table must be worth having"
    for case in PARITY["direction"]:
        assert languages.direction_attribute(case["tag"]) == case["dir"], (
            f"direction {case['tag']!r}"
        )
    # The four this issue was filed about are all in there.
    tags = {case["tag"] for case in PARITY["direction"]}
    assert {"ar", "fa", "he", "ur"} <= tags


def test_direction_comes_from_the_script_not_the_primary_subtag():
    """A four-language allow-list gets this wrong in both directions.

    Nothing in the implementation names ``ar``/``fa``/``he``/``ur``: the rule is
    about the script CLDR says a tag is written in, which is why romanized
    Arabic is left-to-right and Shahmukhi Punjabi is not.
    """
    assert languages.text_direction("ar-Latn") == "ltr"
    assert languages.text_direction("pa") == "ltr"
    assert languages.text_direction("pa-Arab") == "rtl"
    # A language we do not sell yet, which works anyway.
    assert languages.text_direction("dv") == "rtl"
    # `None`, not `"ltr"`: "unknown" and "left-to-right" are different
    # declarations, and `und` is a value this codebase stores.
    assert languages.text_direction("und") is None
    assert languages.direction_attribute("und") == "auto"
    assert languages.likely_script("ar") in languages.RTL_SCRIPTS


def test_the_rtl_script_set_is_exactly_cldr_plus_justified_variants():
    """The oracle is CLDR ``scriptMetadata.json``, not an API that proxies it.

    An earlier round of  used ``Intl.Locale#getTextInfo()`` on the JS side.
    That answers about a LOCALE's layout: ``sq-Todr-AL`` reports ``ltr`` because
    CLDR says *Albanian* is left-to-right, which says nothing about Todhri. It
    reached the right verdict on ``Todr`` for the wrong reason, and because it can
    only inspect entries that are PRESENT it could not see ``Sidt`` missing.

    Pinning a parity table to a proxy is worse than pinning nothing: both tiers
    would then be consistently wrong and the table would PROVE them equal.
    """
    oracle = json.loads(
        (
            pathlib.Path(__file__).parent / "testdata" / "cldr_rtl_scripts.json"
        ).read_text()
    )
    rtl = set(oracle["rtl_scripts"])
    assert len(rtl) >= 37, f"oracle looks truncated: {len(rtl)}"

    # ISO 15924 variant codes for RTL parents; CLDR has no row for them at all.
    variants = {"Aran": "Arab", "Syre": "Syrc", "Syrj": "Syrc", "Syrn": "Syrc"}

    extra = sorted(languages.RTL_SCRIPTS - rtl - set(variants))
    assert extra == [], f"in RTL_SCRIPTS but not rtl=YES in CLDR: {extra}"
    missing = sorted(rtl - languages.RTL_SCRIPTS)
    assert missing == [], f"CLDR says rtl=YES but we omit: {missing}"

    for script, parent in variants.items():
        assert script in languages.RTL_SCRIPTS
        assert script not in rtl, f"{script} IS in the oracle; do not exempt it"
        assert parent in rtl, f"{script} is exempt only because {parent} is rtl=YES"

    # The two discrepancies the real oracle found, pinned by name.
    assert "Todr" not in languages.RTL_SCRIPTS, "Todhri is rtl=NO in CLDR"
    assert "Sidt" in languages.RTL_SCRIPTS, "Sidetic is rtl=YES in CLDR"


def test_the_non_language_subtags_get_auto_in_both_runtimes():
    """The behavioural half of the JS ``NON_LANGUAGE_PRIMARY_SUBTAGS`` mirror.

    The JS side keeps a literal set; Python rejects these by their IANA *scope*,
    so there is no list to compare. What has to agree is the ANSWER: a value that
    names no language must never resolve to a direction, and must reach the
    attribute as ``auto`` rather than a confident ``ltr``.
    """
    for subtag in ("und", "mul", "zxx", "mis"):
        with pytest.raises(languages.LanguageError):
            languages.normalize(subtag, allow_missing=False)
        assert languages.text_direction(subtag) is None, subtag
        assert languages.direction_attribute(subtag) == "auto", subtag


def test_the_golden_table_never_names_the_undetermined_sentinel():
    """`und` is a stored legacy value, never something a crawler may be told."""
    for case in PARITY["cases"]:
        groups = [case["alternates"]] + [
            entry["alternates"] for entry in case["sitemap"]
        ]
        for group in groups:
            assert not [
                alternate
                for alternate in group
                if alternate["hreflang"] == "und"
            ], case["name"]


def test_language_normalization_matches_the_sveltekit_port():
    """`?lang=` names a CONTENT language on this tier too.

    The UI-locale normalizer used to be what this tier ran a shared `?lang=`
    link through, and it is four locales wide: `zh-Hans` came back `None`, so a
    shared link to a published Chinese translation unfurled in English under a
    canonical that contradicted the SvelteKit page at the same URL.
    """
    normalize = crawler._normalize_content_language

    assert normalize("PT") == "pt-BR"
    assert normalize("pt_br") == "pt-BR"
    # A regional tag we do not ship is not silently relabelled as the one we do.
    assert normalize("pt-PT") == "pt-PT"
    # Script subtags survive, and the two Chinese scripts stay two languages.
    assert normalize("zh-hans") == "zh-Hans"
    assert normalize("ZH-HANT") == "zh-Hant"
    # Any real language is a content language, UI locale or not.
    assert normalize("de") == "de"
    assert normalize("ja") == "ja"
    # And nothing that names no language ever gets through.
    assert normalize("und") is None
    assert normalize("mul") is None
    assert normalize("qaa") is None
    assert normalize("zz-ZZ") is None
    assert normalize("") is None
    assert normalize(None) is None
    # The UI-locale port is gone from this module: nothing here has a UI-locale
    # question, and a normalizer that deletes a script subtag must not sit
    # within reach of one that must not.
    assert not hasattr(crawler, "_normalize_ui_locale")


def test_a_language_range_resolves_the_way_the_reader_route_resolves_it():
    """Port parity for `resolveContentLanguageRange`.

    `resolve_zpage_variant` matches `?lang=` exactly, so both tiers have to
    resolve a range the same way or the same URL serves two languages.
    """
    resolve = crawler._resolve_content_language_range

    assert resolve("zh", ["en", "zh-Hans"]) == "zh-Hans"
    assert resolve("pt", ["en", "pt-PT"]) == "pt-PT"
    assert resolve("zh-Hans", ["en", "zh-Hans"]) == "zh-Hans"
    assert resolve("zh-Hans-CN", ["en", "zh-Hans"]) == "zh-Hans"
    # Ambiguous between two scripts: never guessed.
    assert resolve("zh", ["en", "zh-Hans", "zh-Hant"]) is None
    # And never answered across a script boundary.
    assert resolve("zh-Hans-CN", ["zh-Hant"]) is None
    assert resolve("zh-Hant", ["zh-Hans"]) is None
    # Nothing to match, or nothing that is a language: None, never a raise.
    assert resolve("zh", ["en", "es"]) is None
    assert resolve("und", ["en", "und"]) is None
    assert resolve("not a tag!", ["en"]) is None
    assert resolve("en", []) is None


# --- the crawler tier ------------------------------------------------------


@pytest.mark.django_db
def test_a_shared_translated_link_unfurls_in_that_language(
    client, creator_factory
):
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "es", title="Título en español", content="Cuerpo.")

    html = _html(_get(client, f"/{creator.username}/{page.vanity}?lang=es"))

    assert "<title>Título en español</title>" in html
    assert "Cuerpo." in html
    assert "Original body copy." not in html
    # Self-canonical, exactly as the SvelteKit page at this URL declares.
    assert _canonical(html) == (
        f"https://{HOST}/{creator.username}/{page.vanity}?lang=es"
    )
    assert _alternates(html) == [
        {
            "hreflang": "en",
            "href": f"https://{HOST}/{creator.username}/{page.vanity}?lang=en",
        },
        {
            "hreflang": "es",
            "href": f"https://{HOST}/{creator.username}/{page.vanity}?lang=es",
        },
        {
            "hreflang": "x-default",
            "href": f"https://{HOST}/{creator.username}/{page.vanity}",
        },
    ]
    assert 'lang="es"' in html


@pytest.mark.django_db
def test_an_arabic_card_declares_right_to_left_on_its_content(
    client, creator_factory
):
    """ on this tier: the card was labelled Arabic and laid out LTR.

    ``dir`` on every element that holds the ARTICLE's text, and deliberately not
    on ``<html>``: the SvelteKit tier leaves the document element to the reader's
    UI direction for the same reason ``<html lang>`` was the wrong single knob
    for language, and the two tiers answer the same URL.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(
        page,
        "ar",
        title="تمويل Zcash",
        description="عنوان فرعي",
        content="أول Zcash آخر",
    )

    url = f"/{creator.username}/{page.vanity}"
    html = _html(_get(client, f"{url}?lang=ar"))

    assert 'lang="ar"' in html
    assert '<h1 dir="rtl">' in html
    assert '<h2 dir="rtl">' in html
    assert '<pre dir="rtl">' in html
    # The document element keeps the chrome's direction, which is the UA default
    # here. An Arabic article does not flip an English-reading visitor's UI.
    assert re.search(r"<html[^>]*\bdir=", html) is None

    #...and the English source at the same base URL is left-to-right, so this
    # is a decision about the variant rather than a constant.
    english = _html(_get(client, url))
    assert '<h1 dir="ltr">' in english
    assert '<pre dir="ltr">' in english


@pytest.mark.django_db
def test_an_unlabelled_article_gets_auto_rather_than_a_guessed_direction(
    client, creator_factory
):
    """`und`/no source language is "we do not know", not "left-to-right".

    `dir="auto"` hands the question to the parser, which reads the first strong
    character of the text actually there. A silent `ltr` would lay out a legacy
    Hebrew article backwards with nothing to show it had happened.
    """
    creator = creator_factory()
    page = _page(creator, source_language="und")

    html = _html(_get(client, f"/{creator.username}/{page.vanity}"))

    assert '<h1 dir="auto">' in html
    # And no `lang`, because there is no language to name.
    assert re.search(r"<html[^>]*\blang=", html) is None


@pytest.mark.django_db
def test_a_shared_link_to_a_non_ui_locale_variant_unfurls_in_it(
    client, creator_factory
):
    """ on this tier: the card for the language that was actually bought.

    Simplified Chinese is not one of the four locales the product UI is
    translated into, which is why this tier served the English card for it, with
    an `hreflang` cluster that never mentioned Chinese.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "zh-Hans", title="\u4e2d\u6587\u6807\u9898", content="\u4e2d\u6587\u6b63\u6587\u3002")

    url = f"/{creator.username}/{page.vanity}"
    html = _html(_get(client, f"{url}?lang=zh-Hans"))

    assert "<title>\u4e2d\u6587\u6807\u9898</title>" in html
    assert "Original body copy." not in html
    assert _canonical(html) == f"https://{HOST}{url}?lang=zh-Hans"
    assert _alternates(html) == [
        {"hreflang": "en", "href": f"https://{HOST}{url}?lang=en"},
        {"hreflang": "zh-Hans", "href": f"https://{HOST}{url}?lang=zh-Hans"},
        {"hreflang": "x-default", "href": f"https://{HOST}{url}"},
    ]
    assert 'lang="zh-Hans"' in html

    # Case is canonicalized, so a hand-typed link still lands on the variant.
    assert "<title>\u4e2d\u6587\u6807\u9898</title>" in _html(
        _get(client, f"{url}?lang=zh-hans")
    )

    # And a RANGE resolves to the one Chinese variant that exists, because the
    # SvelteKit tier resolves it too and the two must not disagree at one URL.
    range_html = _html(_get(client, f"{url}?lang=zh"))
    assert "<title>\u4e2d\u6587\u6807\u9898</title>" in range_html
    assert _canonical(range_html) == f"https://{HOST}{url}?lang=zh-Hans"


@pytest.mark.django_db
def test_a_preserved_alias_is_an_exact_hit_and_otherwise_folds(
    client, creator_factory
):
    """``?lang=cmn``: the stored ``cmn`` row when there is one, else ``zh``.

    An exact alias hit must not be range-resolved away to a ``zh-Hans``
    sibling (SvelteKit serves the ``cmn`` row with no second request), and an
    alias with no row of its own still reaches the ``zh`` row it folds to, as
    it did before aliases were preserved and as ``variantLanguageRetry`` does.
    """
    creator = creator_factory()
    url_of = lambda page: f"/{creator.username}/{page.vanity}"  # noqa: E731

    both = _page(creator, source_language="en")
    _translation(both, "cmn", title="cmn title")
    _translation(both, "zh-Hans", title="zh-Hans title")
    html = _html(_get(client, f"{url_of(both)}?lang=cmn"))
    assert "<title>cmn title</title>" in html
    assert _canonical(html) == f"https://{HOST}{url_of(both)}?lang=cmn"

    folded = _page(creator, source_language="en")
    _translation(folded, "zh", title="zh title")
    html = _html(_get(client, f"{url_of(folded)}?lang=cmn"))
    assert "<title>zh title</title>" in html
    assert _canonical(html) == f"https://{HOST}{url_of(folded)}?lang=zh"


@pytest.mark.django_db
def test_two_scripts_of_one_language_are_never_guessed_between(
    client, creator_factory
):
    """`?lang=zh` with both scripts published resolves to neither."""
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "zh-Hans", title="\u7b80\u4f53\u6807\u9898")
    _translation(page, "zh-Hant", title="\u7e41\u9ad4\u6a19\u984c")

    url = f"/{creator.username}/{page.vanity}"
    html = _html(_get(client, f"{url}?lang=zh"))

    assert "<title>Original title</title>" in html
    assert "\u7b80\u4f53\u6807\u9898" not in html
    assert "\u7e41\u9ad4\u6a19\u984c" not in html
    # Both are still advertised, so a crawler -- and a reader -- can choose.
    assert [alternate["hreflang"] for alternate in _alternates(html)] == [
        "en",
        "zh-Hans",
        "zh-Hant",
        "x-default",
    ]


@pytest.mark.django_db
def test_ambiguity_is_judged_on_the_whole_inventory_not_the_loaded_rows(
    client, creator_factory
):
    """The truncation boundary must not make an ambiguous range look unique.

    This tier loads at most ``CARD_MAX_VARIANTS`` rows, so an article with
    more published translations than that can hand the resolver a set holding ``zh-Hans`` from which ``zh-Hant`` was truncated. A
    resolver reading only those rows concludes ``?lang=zh`` uniquely means
    Simplified, while the reader route -- which sees the API's complete
    ``available_languages`` -- correctly refuses to guess. One URL, two tiers,
    two languages and two contradicting canonicals (codex adversarial review).
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    # Enough languages to fill the card's row budget, all sorting before `zh`.
    # Generated rather than hand-listed because the budget is now
    # `SITEMAP_MAX_VARIANTS_PER_ZPAGE` = the write path's own 64 + 1,
    # and a hand-list silently stops overflowing the budget the moment that
    # constant moves -- which turns this into a test of nothing.
    filler = [
        code
        for code in (
            f"{first}{second}"
            for first in "abcdefghijklmnopqrstuvwxy"
            for second in "abcdefghijklmnopqrstuvwxyz"
        )
        if code < "zh" and languages.is_detectable(code)
    ][: CARD_MAX_VARIANTS - 1]
    assert len(filler) >= CARD_MAX_VARIANTS - 1
    for language in filler:
        _translation(page, language)
    _translation(page, "zh-Hans", title="\u7b80\u4f53\u6807\u9898")
    _translation(page, "zh-Hant", title="\u7e41\u9ad4\u6a19\u984c")

    url = f"/{creator.username}/{page.vanity}"
    html = _html(_get(client, f"{url}?lang=zh"))

    assert "<title>Original title</title>" in html
    assert "\u7b80\u4f53\u6807\u9898" not in html
    assert "\u7e41\u9ad4\u6a19\u984c" not in html
    # Named exactly, each script still resolves to its own text.
    assert "<title>\u7e41\u9ad4\u6a19\u984c</title>" in _html(
        _get(client, f"{url}?lang=zh-Hant")
    )


@pytest.mark.django_db
def test_the_query_free_url_resolves_a_range_exactly_like_sveltekit(
    client, creator_factory
):
    """No `?lang=` is still a request, and `en` is still a range (reviewer F3).

    A cookieless reader of the query-free URL asks both tiers for the default
    locale. On a Spanish-source article carrying an `en-US` translation, the
    SvelteKit loader resolves `en` -> `en-US` from `available_languages` with no
    query string in sight, so a tier that only probed for an explicit `?lang=`
    served `es` under a contradicting canonical at the same URL.
    """
    creator = creator_factory()
    page = _page(creator, source_language="es", title="T\u00edtulo original")
    _translation(page, "en-US", title="American English title")

    url = f"/{creator.username}/{page.vanity}"
    html = _html(_get(client, url))

    assert "<title>American English title</title>" in html
    assert _canonical(html) == f"https://{HOST}{url}?lang=en-US"
    assert 'lang="en-US"' in html


@pytest.mark.django_db
def test_a_tightened_range_ceiling_cannot_manufacture_a_unique_match(
    client, creator_factory
):
    """The control `RANGE_CANDIDATE_CEILING`'s comment did not have.

    Setting the ceiling back to 4 -- the value codex named as broken -- left the
    suite green, so nothing enforced the comment (reviewer F4). With five
    same-primary variants, a ceiling that bites returns the alphabetically first
    four, the script filter leaves exactly one Traditional candidate, and
    `?lang=zh-Hant-TW` resolves to it while the reader route sees both and
    refuses. This fails if the ceiling is tightened below the real inventory.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    for language in ("zh-Hans-CN", "zh-Hans-HK", "zh-Hans-SG"):
        _translation(page, language)
    _translation(page, "zh-Hant-HK", title="\u9999\u6e2f\u7e41\u9ad4")
    _translation(page, "zh-Hant-MO", title="\u6fb3\u9580\u7e41\u9ad4")

    url = f"/{creator.username}/{page.vanity}"
    html = _html(_get(client, f"{url}?lang=zh-Hant-TW"))

    # Two Traditional candidates and no exact match: nothing is guessed.
    assert "<title>Original title</title>" in html
    assert "\u9999\u6e2f\u7e41\u9ad4" not in html
    assert "\u6fb3\u9580\u7e41\u9ad4" not in html
    #...and the resolver agrees when asked directly, with the full inventory.
    assert (
        crawler._resolve_content_language_range(
            "zh-Hant-TW",
            ["zh-Hans-CN", "zh-Hans-HK", "zh-Hans-SG", "zh-Hant-HK", "zh-Hant-MO"],
        )
        is None
    )


@pytest.mark.django_db
def test_the_range_probe_never_runs_a_scanning_query(client, creator_factory):
    """`UPPER(language) LIKE` cannot use an index; this tier has a guard.

    `test_vanity_lookup_is_case_insensitive_but_exact_first` caught the first
    version of the probe, but it requests a URL with no `?lang=`, so it stopped
    covering the probe the moment the probe learned to fire on a range
    (reviewer F4). This asserts the shape on a request that definitely probes.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "zh-Hans", title="\u7b80\u4f53\u6807\u9898")

    url = f"/{creator.username}/{page.vanity}"
    with CaptureQueriesContext(connection) as captured:
        response = _get(client, f"{url}?lang=zh")

    assert response.status_code == 200
    assert "<title>\u7b80\u4f53\u6807\u9898</title>" in _html(response)
    assert not [
        query for query in captured.captured_queries if "UPPER(" in query["sql"]
    ]


@pytest.mark.django_db
def test_the_clean_url_of_a_translated_article_canonicalizes_to_english(
    client, creator_factory
):
    """The clean URL negotiates, so it is nobody's canonical once it can."""
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "es")

    html = _html(_get(client, f"/{creator.username}/{page.vanity}"))

    assert _canonical(html) == (
        f"https://{HOST}/{creator.username}/{page.vanity}?lang=en"
    )
    assert "<title>Original title</title>" in html


@pytest.mark.django_db
def test_an_untranslated_article_is_untouched(client, creator_factory):
    creator = creator_factory()
    page = _page(creator, source_language="en")

    html = _html(_get(client, f"/{creator.username}/{page.vanity}"))

    assert _canonical(html) == (
        f"https://{HOST}/{creator.username}/{page.vanity}"
    )
    # One variant, so the clean URL is that language's URL AND the x-default,
    # which is the cluster the SvelteKit page has emitted since. Parity
    # with the page is the requirement here; the SITEMAP deliberately omits a
    # single-member cluster instead (see the golden table's `sitemap` key), and
    # the two are consistent because both point only at this one URL.
    assert _alternates(html) == [
        {
            "hreflang": "en",
            "href": f"https://{HOST}/{creator.username}/{page.vanity}",
        },
        {
            "hreflang": "x-default",
            "href": f"https://{HOST}/{creator.username}/{page.vanity}",
        },
    ]
    assert "<title>Original title</title>" in html


@pytest.mark.django_db
def test_a_draft_translation_never_reaches_a_crawler(client, creator_factory):
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(
        page, "es", is_published=False, content="Unpublished draft copy.",
        title="Borrador",
    )

    html = _html(_get(client, f"/{creator.username}/{page.vanity}?lang=es"))

    assert "Borrador" not in html
    assert "Unpublished draft copy." not in html
    assert "<title>Original title</title>" in html
    # And it is invisible in the language cluster: one PUBLISHED variant means
    # the clean URL still owns the article and no `?lang=es` URL is advertised.
    assert not [
        alternate
        for alternate in _alternates(html)
        if alternate["hreflang"] == "es" or "lang=es" in alternate["href"]
    ]
    assert _canonical(html) == (
        f"https://{HOST}/{creator.username}/{page.vanity}"
    )

    # The resolver is the security boundary; the loader's filter is the cost
    # one. Pin the cost property too, or it silently becomes dead code and a
    # creator with fifty drafts pays for all of them on every unfurl.
    resolved = crawler._published_zpage_or_404(page.vanity)
    assert crawler._load_card_translations(resolved, "es") == []


@pytest.mark.django_db
def test_a_translated_subscriber_only_page_still_leaks_nothing(
    client, creator_factory
):
    creator = creator_factory()
    page = _page(
        creator,
        source_language="en",
        is_subscriber_only=True,
        description="",
        content="Paywalled English body.",
    )
    _translation(
        page,
        "es",
        description="",
        title="Miembros",
        content="Cuerpo de pago en español.",
    )

    html = _html(_get(client, f"/{creator.username}/{page.vanity}?lang=es"))

    assert "<title>Miembros</title>" in html
    assert "Cuerpo de pago en español." not in html
    assert "Paywalled English body." not in html
    assert crawler.SUBSCRIBER_ONLY_DESCRIPTION in html

    # And the redaction is done by the DATABASE for the translation too, not by
    # a Python branch in the template path: the paywalled copy never entered
    # this process to begin with. Without the `zpage__is_subscriber_only` arm
    # of `_card_excerpt`, this list holds the Spanish body.
    resolved = crawler._published_zpage_or_404(page.vanity)
    assert [
        translation.truncated_content
        for translation in crawler._load_card_translations(resolved, "es")
    ] == [""]


@pytest.mark.django_db
def test_a_hostile_lang_parameter_cannot_break_a_preview(
    client, creator_factory
):
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "es")

    for value in ("", "de", "zz-ZZ", "..%2F..%2Fetc", "en+", "x" * 500):
        response = _get(
            client, f"/{creator.username}/{page.vanity}?lang={value}"
        )
        assert response.status_code == 200, value
        # Anything we cannot name degrades to the default negotiation.
        assert _canonical(_html(response)) == (
            f"https://{HOST}/{creator.username}/{page.vanity}?lang=en"
        )


@pytest.mark.django_db
def test_a_repeated_lang_parameter_resolves_the_way_sveltekit_does(
    client, creator_factory
):
    """`?lang=es&lang=en` must not mean two different things on two tiers.

    Django's QueryDict.get returns the LAST value; the URLSearchParams.get
    SvelteKit uses returns the FIRST. Left alone, the same URL served an
    English card from this tier and a Spanish page from SSR, each declaring
    the other's URL canonical (codex adversarial review).
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "es")

    html = _html(
        _get(client, f"/{creator.username}/{page.vanity}?lang=es&lang=en")
    )

    assert _canonical(html) == (
        f"https://{HOST}/{creator.username}/{page.vanity}?lang=es"
    )
    assert "<title>es title</title>" in html


@pytest.mark.django_db
def test_an_external_canonical_suppresses_the_language_cluster(
    client, creator_factory
):
    """Free2Z `?lang=` URLs are not alternates of somebody else's page."""
    creator = creator_factory()
    page = _page(
        creator,
        source_language="en",
        canonical_url="https://publisher.example/original",
    )
    _translation(page, "es")

    html = _html(_get(client, f"/{creator.username}/{page.vanity}?lang=es"))

    assert _canonical(html) == "https://publisher.example/original"
    assert _alternates(html) == []


@pytest.mark.django_db
def test_a_translated_card_never_loads_a_full_body(client, creator_factory):
    """The excerpt discipline has to survive the extra variant query."""
    creator = creator_factory()
    page = _page(creator, source_language="en", content="x" * 100_000)
    _translation(page, "es", content="y" * 100_000)

    with CaptureQueriesContext(connection) as captured:
        response = _get(client, f"/{creator.username}/{page.vanity}?lang=es")

    assert response.status_code == 200
    assert "y" * 5_000 not in _html(response)
    for query in captured.captured_queries:
        # Drop the bounded SUBSTRING() projections; what must never appear is a
        # bare `content` column in the SELECT list, which is a 100,000-char
        # field crossing the wire on the single sync gunicorn worker.
        sql = re.sub(r"SUBSTRING\([^)]*\)", "SUBSTRING()", query["sql"])
        assert '"g12f_zpage"."content"' not in sql, sql
        assert '"g12f_zpagetranslation"."content"' not in sql, sql


@pytest.mark.django_db
def test_the_card_tier_answers_only_safe_methods(client, creator_factory):
    """`?lang=` selects a representation, so the verb set has to say so.

    nginx routes ANY method with a $prerender User-Agent to this tier, and a
    bare Django function view answers all of them. Pinning GET/HEAD is what
    lets `dj/apps/test_url_write_guard.py` see that reading `?lang=` here
    cannot be a write.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    path = f"/{creator.username}/{page.vanity}"

    assert _get(client, path).status_code == 200
    assert client.head(path, HTTP_HOST=HOST).status_code == 200
    for method in (client.post, client.put, client.patch, client.delete):
        assert method(path, HTTP_HOST=HOST).status_code == 405, method


@pytest.mark.django_db
def test_the_card_loader_is_bounded_in_rows_and_in_bytes(
    client, creator_factory
):
    """An anonymous, UA-gated path may not scale with stored variant count.

    Raised by the codex adversarial review at HIGH severity, and correctly: a
    creator can accumulate arbitrarily many published variants, and this tier
    shares a pod's single sync gunicorn worker with the API and checkout. Two
    independent bounds, both asserted here: how many rows are read, and how
    many of them carry body text.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    for locale in ("es", "fr", "pt-BR"):
        _translation(page, locale, content=locale * 40_000)
    for index in range(CARD_MAX_VARIANTS + 20):
        _translation(page, f"x{index}", content="z" * 40_000)

    resolved = crawler._published_zpage_or_404(page.vanity)
    rows = crawler._load_card_translations(resolved, "es")

    assert len(rows) == CARD_MAX_VARIANTS
    # The nameable languages are never the ones dropped, so the card's cluster
    # is what the sitemap's is for the same article.
    assert {"es", "fr", "pt-BR"}.issubset({row.language for row in rows})
    # Exactly one row carries text, and it is the one that will be rendered.
    with_text = [row.language for row in rows if row.truncated_content]
    assert with_text == ["es"]
    assert len(rows[0].truncated_content or "") <= crawler.CARD_BODY_CHARS

    response = _get(client, f"/{creator.username}/{page.vanity}?lang=es")
    assert response.status_code == 200
    assert len(response.content) < 100_000


# --- the sitemap chunk -----------------------------------------------------


@pytest.mark.django_db
def test_the_chunk_reports_published_variants_only(creator_factory):
    creator = creator_factory()
    page = _page(creator, source_language="en")
    _translation(page, "es")
    _translation(page, "fr", is_published=False)

    chunk = build_sitemap_chunk("zpages", (page.pk - 1) // SITEMAP_CHUNK_SIZE)
    row = next(item for item in chunk["zpages"] if item["vanity"] == page.vanity)

    assert row["languages"] == ["en", "es"]
    assert row["source_language"] == "en"
    assert "id" not in row


@pytest.mark.django_db
def test_the_chunk_orders_variants_exactly_like_the_api(creator_factory):
    """`und` first, then real languages sorted -- what `available_languages` is."""
    creator = creator_factory()
    page = _page(creator, source_language="und")
    _translation(page, "pt-BR")
    _translation(page, "es")

    chunk = build_sitemap_chunk("zpages", (page.pk - 1) // SITEMAP_CHUNK_SIZE)
    row = next(item for item in chunk["zpages"] if item["vanity"] == page.vanity)

    assert row["languages"] == ["und", "es", "pt-BR"]


@pytest.mark.django_db
def test_an_undetected_language_is_absent_not_null(creator_factory):
    """NULL source_language is "not detected yet", not a language ( §3.2).

    The column has been nullable and M7 makes NULL the replacement
    for `und`. Emitting a null INTO the language list would put a non-string in
    an array the SvelteKit parser requires to hold strings, and 503 the whole
    chunk the first day a row goes unlabelled.
    """
    creator = creator_factory()
    # NULL from birth, for the reason spelled out below in
    # `test_an_undetected_language_still_serves_a_crawler_card`.
    page = _page(creator, source_language=None)

    chunk = build_sitemap_chunk("zpages", (page.pk - 1) // SITEMAP_CHUNK_SIZE)
    row = next(item for item in chunk["zpages"] if item["vanity"] == page.vanity)

    assert row["languages"] == []
    assert row["source_language"] is None


@pytest.mark.django_db
def test_an_undetected_language_still_serves_a_crawler_card(
    client, creator_factory
):
    # Created unlabelled rather than relabelled with a queryset `.update()`.
    # An `.update()` fires no signal, so it would leave an `en` ZPageVariant
    # behind a NULL `source_language` -- drift, not an undetected page, and
    # under  M5 the card would then resolve the stale `en` mirror. Creating
    # it NULL is what an undetected page actually looks like in both shapes:
    # `variants.sync_source_variant` skips it, so it owns no variant at all.
    creator = creator_factory()
    page = _page(creator, source_language=None)

    response = _get(client, f"/{creator.username}/{page.vanity}")

    assert response.status_code == 200
    html = _html(response)
    assert _canonical(html) == (
        f"https://{HOST}/{creator.username}/{page.vanity}"
    )
    assert _alternates(html) == []
    assert 'lang="' not in html


@pytest.mark.django_db
def test_a_translation_edit_moves_lastmod(creator_factory):
    """Otherwise a rewritten translation is simply never recrawled."""
    creator = creator_factory()
    page = _page(creator, source_language="en")
    translation = _translation(page, "es")
    ZPageTranslation.objects.filter(pk=translation.pk).update(
        updated_at=page.updated_at + datetime.timedelta(days=3)
    )

    chunk = build_sitemap_chunk("zpages", (page.pk - 1) // SITEMAP_CHUNK_SIZE)
    row = next(item for item in chunk["zpages"] if item["vanity"] == page.vanity)

    assert row["updated_at"] > page.updated_at


@pytest.mark.django_db
def test_the_chunk_wide_read_bound_fails_loudly(creator_factory):
    """The bound the chunk statement-timeout derivation depends on.

    Expressed over a one-zPage range so the assertion is about the RULE
    (chunk_size x SITEMAP_MAX_VARIANTS_PER_ZPAGE) rather than about seeding
    16,001 rows. Overrunning it raises, and `SitemapChunkView` already turns a
    RuntimeError into the retryable 503 the primary-key bound produces -- a
    loud, self-healing failure rather than an unbounded read on a pod's only
    worker.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    for index in range(SITEMAP_MAX_VARIANTS_PER_ZPAGE + 1):
        _translation(page, f"x{index}" if index else "es")

    with pytest.raises(RuntimeError):
        _zpage_variant_index(
            page.pk, page.pk + 1, cap=SITEMAP_MAX_VARIANTS_PER_ZPAGE
        )

    # One fewer variant is fine, so the failure above is the bound and not the
    # fixture.
    ZPageTranslation.objects.filter(zpage=page, language="x1").delete()
    assert len(
        _zpage_variant_index(
            page.pk, page.pk + 1, cap=SITEMAP_MAX_VARIANTS_PER_ZPAGE
        )[page.pk][0]
    ) == SITEMAP_MAX_VARIANTS_PER_ZPAGE


def test_a_fully_translated_corpus_does_not_reach_the_chunk_read_bound():
    """A capacity guard that fires on product success is a bug.

    The first cut bounded the chunk read at
    `SITEMAP_CHUNK_SIZE x SITEMAP_MAX_VARIANTS_PER_ZPAGE` = 16,000, which is
    BELOW a corpus where every page carries every translation we sell --
    `f2z.languages.TRANSLATABLE` was already 39 languages. Selling enough
    translations would have started 503ing sitemap children (codex adversarial
    review).

     re-anchored the headroom, keeping 's 100,000. TRANSLATABLE went
    39 -> 78 in  alone, so a bound derived from the sell list has to be
    re-derived every time a language ships, and the failure mode of forgetting
    is a 503 that takes up to 499 unrelated articles out of the sitemap.

    The per-zPage PUBLISH cap does not move when a language ships and is the
    real bound: / refuse a 65th published translation with a 409
    whatever the sell list grows to, so one chunk cannot exceed
    `SITEMAP_CHUNK_SIZE x` that cap however many languages we sell.

    Both are asserted. The sell-list multiple is computed from the LIVE set so
    a future expansion still fails loudly here rather than in production; the
    publish-cap multiple is the one that holds even when TRANSLATABLE passes
    it, which it already has -- at 78 sellable against a 64 publish cap, a
    creator cannot buy every sellable language for one article. That gap is a
    product question for, not a sitemap bound.
    """
    fully_translated = SITEMAP_CHUNK_SIZE * len(languages.TRANSLATABLE)
    fully_published = (
        SITEMAP_CHUNK_SIZE * MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    )

    assert SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK > fully_published
    # And with real headroom, not by a rounding accident.
    assert SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK >= 2 * fully_published
    assert SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK > fully_translated
    assert SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK >= 2 * fully_translated


def test_the_per_row_bound_is_the_write_paths_bound():
    """Nothing a creator may legitimately publish is truncated away.

    The old bound was 32, justified as "far above the four UI locales that can
    appear in a sitemap URL, and everything beyond is dropped losslessly".
     made every *content* language linkable, so a dropped variant is now
    a URL no crawler is told about and an `hreflang` never emitted -- the
    truncation stopped being lossless and the number stopped being derived
    from anything real.

    / cap a zPage at MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    published translations and exclude the source from that count, so that
    cap + 1 is the largest list the API can produce. The relationship, and the
    matching SvelteKit literal, are pinned in test_language_derived_bounds.py.
    """
    assert SITEMAP_MAX_VARIANTS_PER_ZPAGE == (
        MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE + 1
    )

    # EVERY language we sell, plus a source we do not sell into, survives
    # intact. That combination is the whole point of: the cap used to sit
    # BELOW the sell list, so a creator buying all of it was refused at the
    # 65th. Written as the sell list rather than as a slice of it, so this goes
    # red if the cap ever falls back below what we advertise.
    sellable = sorted(languages.TRANSLATABLE - {"nan"})
    assert len(sellable) == len(languages.TRANSLATABLE), (
        "this fixture needs a source language we do NOT sell translations into"
    )
    emitted = _available_languages("nan", sellable)
    assert set(emitted) == {"nan", *sellable}
    assert len(emitted) == len(sellable) + 1

    # And the full write-path maximum survives too, which is a larger number
    # than the sell list now: the cap is above TRANSLATABLE by design, so the
    # fixture is topped up with other real content languages. Filler must pass
    # `is_detectable` or `_available_languages` drops it before any cap is
    # reached and the branch under test never runs ('s own fixture bug).
    extra = [
        code
        for code in (
            f"{first}{second}"
            for first in "abcdefghijklmnopqrstuvwxyz"
            for second in "abcdefghijklmnopqrstuvwxyz"
        )
        if code not in languages.TRANSLATABLE
        and code != "en"
        and languages.is_detectable(code)
    ]
    translations = sorted(languages.TRANSLATABLE - {"en"})
    translations += extra[
        : MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE - len(translations)
    ]
    assert len(translations) == MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE, (
        "this fixture must be able to fill the publish cap"
    )
    emitted = _available_languages("en", translations)
    assert set(emitted) == {"en", *translations}
    assert len(emitted) == len(translations) + 1
    assert len(emitted) == SITEMAP_MAX_VARIANTS_PER_ZPAGE, (
        "the largest list the write path can produce must not be truncated"
    )


def test_truncation_can_never_drop_the_source_language():
    """The one variant the cluster cannot survive losing.

    The source owns the clean URL when nothing is negotiated, it is the
    `x-default` target, and BOTH tiers compute `cleanUrlLanguage` from this
    very list. The pre- truncation partitioned on
    `SITEMAP_NAMED_LANGUAGES` -- the four UI locales -- which happened to keep
    `en` at the front. With every content language nameable that partition is
    meaningless, and the obvious replacement (a plain `ordered[:N]` over a
    tag-sorted list) silently drops a `zh-Hant` source behind 65
    alphabetically-earlier translations. The article would then advertise a
    cluster that does not contain the language its own canonical resolves to.

    Only legacy or directly-mutated rows can reach the truncation at all now,
    which is exactly why nothing else would catch this.
    """
    source = "zh-Hant"
    # Real languages, every one sorting before `zh-Hant`, and more of them than
    # the bound allows -- so a naive head-slice keeps none of the source. Drawn
    # from the open DETECTABLE set rather than TRANSLATABLE, which is only 39
    # entries today and so cannot overflow a 65 bound at all.
    earlier = [
        code
        for code in (
            f"{first}{second}"
            for first in "abcdefghijklmnopqrstuvwxy"
            for second in "abcdefghijklmnopqrstuvwxyz"
        )
        if code < source and languages.is_detectable(code)
    ][: SITEMAP_MAX_VARIANTS_PER_ZPAGE + 12]
    assert len(earlier) > SITEMAP_MAX_VARIANTS_PER_ZPAGE, (
        "fixture must overflow the bound with languages sorting before the source"
    )

    emitted = _available_languages(source, earlier)

    assert len(emitted) == SITEMAP_MAX_VARIANTS_PER_ZPAGE
    assert source in emitted, "the source must survive truncation"
    # Still the ordering `resolve_zpage_variant` produces, not a reshuffle.
    assert emitted == sorted(emitted)


@pytest.mark.django_db
def test_one_over_translated_article_cannot_503_a_whole_sitemap_child(
    creator_factory,
):
    """Found by the codex adversarial review, and it was real.

    The first cut counted only TRANSLATIONS against the per-row bound while the
    SvelteKit parser counts the emitted list, source included. 32 published
    translations therefore produced a 33-entry list that the renderer refused,
    503ing the whole sitemap child -- up to 499 unrelated articles -- until a
    creator deleted a translation they had every right to publish.

    The bound truncates instead of raising.

    The filler languages have to be REAL ones. This test used to seed
    `x0`, `x1`,... -- `is_detectable` is False for every one of them, so
    `_available_languages` dropped them before it ever reached the bound and
    the emitted list was four entries long. The `len(...) <= bound` assertion
    passed without the truncation branch executing once.
    """
    creator = creator_factory()
    page = _page(creator, source_language="en")
    for locale in ("es", "fr", "pt-BR"):
        _translation(page, locale)
    filler = [
        code
        for code in (
            f"{first}{second}"
            for first in "abcdefghijklmnopqrstuvwxyz"
            for second in "abcdefghijklmnopqrstuvwxyz"
        )
        if code not in {"en", "es", "fr"} and languages.is_detectable(code)
    ][: SITEMAP_MAX_VARIANTS_PER_ZPAGE + 5]
    assert len(filler) == SITEMAP_MAX_VARIANTS_PER_ZPAGE + 5
    for code in filler:
        _translation(page, code)

    chunk = build_sitemap_chunk("zpages", (page.pk - 1) // SITEMAP_CHUNK_SIZE)
    row = next(item for item in chunk["zpages"] if item["vanity"] == page.vanity)

    # It really did truncate -- more variants exist than the bound allows.
    assert len(row["languages"]) == SITEMAP_MAX_VARIANTS_PER_ZPAGE
    # The source survives, because the whole cluster is computed from it.
    assert "en" in row["languages"]
    # And the article is still, unambiguously, multi-variant.
    assert len(set(row["languages"])) > 1


@pytest.mark.django_db
def test_a_neighbouring_pages_variants_do_not_leak_into_a_row(creator_factory):
    """The range read covers ids the visibility filter drops; nothing is mixed."""
    creator = creator_factory()
    first = _page(creator, source_language="en")
    second = _page(creator, source_language="en", is_published=False)
    _translation(second, "fr")

    chunk = build_sitemap_chunk("zpages", (first.pk - 1) // SITEMAP_CHUNK_SIZE)
    row = next(
        item for item in chunk["zpages"] if item["vanity"] == first.vanity
    )

    assert row["languages"] == ["en"]
    assert not [
        item for item in chunk["zpages"] if item["vanity"] == second.vanity
    ]


@pytest.mark.django_db
def test_the_variant_query_is_one_bounded_extra_read(creator_factory):
    """One chunk stays two queries, whatever the corpus does."""
    creator = creator_factory()
    pages = [_page(creator, source_language="en") for _ in range(20)]
    for page in pages:
        _translation(page, "es")
        _translation(page, "fr")

    page_number = (pages[0].pk - 1) // SITEMAP_CHUNK_SIZE
    with CaptureQueriesContext(connection) as captured:
        chunk = build_sitemap_chunk("zpages", page_number)

    assert chunk["zpages"]
    # Two reads today; three once  M5 flips, because the chunk then takes
    # its LANGUAGE SET from ZPageVariant while its `lastmod` stays on
    # ZPageTranslation -- deliberately, since dual write does not mirror
    # timestamps and `ZPageVariant.updated_at` is the mirror-write time (see
    # `_apply_variant_languages`). Both extra reads are the same bounded,
    # index-ordered, body-free primary-key range.
    expected = 3 if variant_reads_enabled() else 2
    assert len(captured.captured_queries) == expected

    table = (
        "g12f_zpagevariant" if variant_reads_enabled()
        else "g12f_zpagetranslation"
    )
    variant_sql = next(
        query["sql"]
        for query in captured.captured_queries
        if table in query["sql"]
    )
    # Bounded, index-ordered, and it never reads a body.
    assert '"content"' not in variant_sql
    assert "ORDER BY" in variant_sql
    assert "LIMIT" in variant_sql
