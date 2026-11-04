"""``GET /api/languages/`` and the catalog behind it .

Lives under ``dj/apps/g12f`` for the same reason ``test_language_registry.py``
does: ``py/pytest.ini`` collects ``testpaths = dj/apps gcp``, and g12f owns
zPage content language.

What these are trying to catch, in order of how much they would have cost:

* A catalog that **degrades a bad locale into a 4xx**. The whole reason a query
  parameter is allowed to shape this answer is that it selects a
  representation; the moment it can refuse the read it has stopped being one.
* An ``ETag`` that is **not a function of the bytes** — one shared across
  naming locales would serve a French client a 304 for the English catalog and
  then never correct itself for ``max-age`` plus the stale window.
* ``Vary: Cookie``, which is what appears the instant the view authenticates,
  and which quietly makes a ``public`` response uncacheable between visitors.
* A ``direction`` derived from the *language* rather than the script.
"""

import json

import pytest

from f2z import language_catalog, languages
from f2z.language_names import CLDR_DISPLAY_NAMES

from dj.apps.g12f.views.language_catalog import (
    CACHE_CONTROL,
    _accept_language_candidates,
)

URL = "/api/languages/"


# --------------------------------------------------------------------------- #
# Direction
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "tag,expected",
    [
        ("ar", "rtl"),
        ("he", "rtl"),
        ("fa", "rtl"),
        ("ur", "rtl"),
        # Sorani Kurdish is Arabic-script; Kurmanji Kurdish is Latin. Same
        # "Kurdish" to a picker that reasons about languages, opposite answers.
        ("ckb", "rtl"),
        ("kmr", "ltr"),
        ("dv", "rtl"),
        ("ps", "rtl"),
        ("yi", "rtl"),
        ("en", "ltr"),
        ("ja", "ltr"),
        ("zh-Hant", "ltr"),
        ("ta", "ltr"),
        # Script subtag, not language, decides: the same language both ways.
        ("sr-Cyrl", "ltr"),
        ("pa-Arab", "rtl"),
        ("pa-Guru", "ltr"),
    ],
)
def test_text_direction_follows_the_script(tag, expected):
    assert language_catalog.text_direction(tag) == expected


def test_text_direction_of_an_unanswerable_tag_is_ltr_not_a_crash():
    """"No constraint" has to render as something, and must not raise."""
    assert language_catalog.text_direction("not a language") == "ltr"
    assert language_catalog.text_direction(None) == "ltr"


def test_rtl_scripts_are_iso_15924_shaped():
    """A lowercase or four-plus-character entry silently never matches."""
    for script in language_catalog.RTL_SCRIPTS:
        assert len(script) == 4 and script[:1].isupper() and script.isalpha()


# --------------------------------------------------------------------------- #
# Naming-locale resolution
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "requested,expected",
    [
        ("en", "en"),
        ("es", "es"),
        ("fr", "fr"),
        ("pt-BR", "pt-BR"),
        # Regional variants collapse onto the table we hold...
        ("es-MX", "es"),
        ("fr-CA", "fr"),
        #...and everything else degrades to English rather than failing.
        ("de", "en"),
        ("zz", "en"),
        ("not a locale", "en"),
        ("", "en"),
        (None, "en"),
    ],
)
def test_naming_locale_resolves_or_degrades(requested, expected):
    assert language_catalog.naming_locale(requested) == expected


def test_naming_locale_reports_the_table_display_name_actually_used():
    """The mirror of ``languages._viewer_table`` cannot drift.

    ``locale`` in the response is a promise: "these names are in this". If this
    resolution and ``display_name``'s ever disagree, we would report one locale
    while naming in another, and a client caching per reported locale would
    hold the wrong names under the right key.
    """
    for requested in ["es-MX", "fr-CA", "pt", "de", "zz", "en-GB", "nonsense"]:
        resolved = language_catalog.naming_locale(requested)
        for tag in sorted(languages.TRANSLATABLE):
            assert languages.display_name(tag, requested) == languages.display_name(
                tag, resolved
            ), f"{tag} named differently for {requested!r} vs {resolved!r}"


def test_match_naming_locale_skips_candidates_we_have_no_table_for():
    """``de`` then ``fr`` must answer French, not English.

    Stopping at the first *valid* tag would discard a preference we can
    actually honour — ``de`` is a perfectly good language tag that simply has
    no name table here.
    """
    assert language_catalog.match_naming_locale(["de", "fr"]) == "fr"
    assert language_catalog.match_naming_locale(["de", "zz"]) == "en"
    assert language_catalog.match_naming_locale([]) == "en"
    assert language_catalog.match_naming_locale(["es-419", "fr"]) == "es"


# --------------------------------------------------------------------------- #
# The catalog itself
# --------------------------------------------------------------------------- #
def test_catalog_covers_exactly_the_sellable_set():
    _locale, rows = language_catalog.catalog("en")
    assert {row["tag"] for row in rows} == set(languages.TRANSLATABLE)
    assert all(row["translatable"] for row in rows)


def test_catalog_is_ordered_by_the_localized_name():
    for locale in ["en", "es"]:
        _resolved, rows = language_catalog.catalog(locale)
        expected = [tag for tag, _n, _a in languages.translatable_choices(locale)]
        assert [row["tag"] for row in rows] == expected


def test_catalog_never_names_a_language_with_a_raw_subtag():
    """: a tag must never reach a reader. Also catches an empty name."""
    for locale in ["en", "es", "fr", "pt-BR"]:
        _resolved, rows = language_catalog.catalog(locale)
        for row in rows:
            assert row["name"] and row["name"] != row["tag"]
            assert row["autonym"]


def test_catalog_rows_are_not_the_shared_memoized_copy():
    """The memo is process-wide; handing out a reference makes one careless
    mutation serve a corrupted catalog to every subsequent request."""
    _locale, first = language_catalog.catalog("en")
    first[0]["name"] = "MUTATED"
    _locale, second = language_catalog.catalog("en")
    assert second[0]["name"] != "MUTATED"


def test_catalog_memoization_is_keyed_on_the_resolved_locale():
    """``?locale=<random>`` must not be able to grow the cache without bound.

    Fifty distinct requested locales collapse onto the handful of name tables
    we ship. Keyed on the raw request instead, this would be fifty entries and
    a 16-slot cache that thrashes on every call.
    """
    language_catalog._catalog_cached.cache_clear()
    for i in range(50):
        language_catalog.catalog(f"es-{i:03d}")
    assert (
        language_catalog._catalog_cached.cache_info().currsize
        <= len(CLDR_DISPLAY_NAMES)
    )


def test_language_entry_reads_translatable_from_the_registry():
    """The flag is computed, not hardcoded ``True``.

    Every row the endpoint currently serves is sellable, so nothing in the HTTP
    response can distinguish a computed flag from a constant. This is the
    assertion that can: a detectable-but-not-sellable language answers
    ``False``. Min Nan is one today —  explicitly keeps ``nan``/``wuu``/
    ``hak`` out of the sell list while adding Cantonese to it — and if it is
    ever promoted, this test wants a new example, not deleting.
    """
    assert "nan" not in languages.TRANSLATABLE
    entry = language_catalog.language_entry("nan")
    assert entry["translatable"] is False
    assert entry["tag"] == "nan"
    assert language_catalog.language_entry("ja")["translatable"] is True


def test_language_entry_refuses_a_tag_that_is_not_a_language():
    with pytest.raises(languages.LanguageError):
        language_catalog.language_entry("und")


# --------------------------------------------------------------------------- #
# Accept-Language parsing
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "header,expected",
    [
        ("fr", ["fr"]),
        ("fr-CA,fr;q=0.9,en;q=0.8", ["fr-CA", "fr", "en"]),
        # q ordering wins over source order...
        ("en;q=0.2,fr;q=0.9", ["fr", "en"]),
        #...and equal q keeps the client's order.
        ("en;q=0.5,fr;q=0.5", ["en", "fr"]),
        # q=0 is "not this one", not "last resort".
        ("fr;q=0,es", ["es"]),
        # `*` expresses no preference, so it must fall through.
        ("*", []),
        ("de,*;q=0.5", ["de"]),
        # Malformed must degrade, never raise.
        ("", []),
        (",,;q=", []),
        ("fr;q=banana,es", ["es"]),
    ],
)
def test_accept_language_candidates(header, expected):
    assert _accept_language_candidates(header) == expected


# --------------------------------------------------------------------------- #
# The endpoint
# --------------------------------------------------------------------------- #
def test_catalog_endpoint_is_reachable_anonymously_and_well_shaped(api_client):
    response = api_client.get(URL)
    assert response.status_code == 200
    body = response.json()
    assert body["locale"] == "en"
    assert {row["tag"] for row in body["languages"]} == set(languages.TRANSLATABLE)
    arabic = next(r for r in body["languages"] if r["tag"] == "ar")
    assert arabic["direction"] == "rtl"
    assert arabic["script"] == "Arab"
    assert arabic["name"] == "Arabic"
    assert arabic["autonym"] == "العربية"


def test_locale_query_parameter_selects_the_naming_locale(api_client):
    body = api_client.get(URL, {"locale": "es"}).json()
    assert body["locale"] == "es"
    spanish = {row["tag"]: row["name"] for row in body["languages"]}
    assert spanish["ja"] == languages.display_name("ja", "es")
    assert spanish["ja"] != languages.display_name("ja", "en")


def test_a_regional_locale_reports_the_table_it_resolved_to(api_client):
    body = api_client.get(URL, {"locale": "es-MX"}).json()
    assert body["locale"] == "es"


@pytest.mark.parametrize("bad", ["zz", "de", "not a locale", "und", "x", "!!"])
def test_an_unusable_locale_degrades_to_english_and_never_4xxs(api_client, bad):
    """A representation selector must not be able to fail a read."""
    response = api_client.get(URL, {"locale": bad})
    assert response.status_code == 200
    assert response.json()["locale"] == "en"


def test_an_empty_locale_parameter_is_treated_as_absent(api_client):
    """A client building `?locale=${maybeUndefined}` means "no preference"."""
    response = api_client.get(
        f"{URL}?locale=", HTTP_ACCEPT_LANGUAGE="fr,en;q=0.5"
    )
    assert response.json()["locale"] == "fr"


@pytest.mark.parametrize(
    "header,expected",
    [
        ("fr", "fr"),
        ("fr-CA,fr;q=0.9,en;q=0.8", "fr"),
        ("de,fr;q=0.9", "fr"),
        ("de", "en"),
        ("*", "en"),
        ("pt-BR,pt;q=0.9", "pt-BR"),
    ],
)
def test_accept_language_selects_the_naming_locale(api_client, header, expected):
    response = api_client.get(URL, HTTP_ACCEPT_LANGUAGE=header)
    assert response.json()["locale"] == expected


def test_the_locale_parameter_beats_accept_language(api_client):
    response = api_client.get(URL, {"locale": "es"}, HTTP_ACCEPT_LANGUAGE="fr")
    assert response.json()["locale"] == "es"


# --------------------------------------------------------------------------- #
# Caching
# --------------------------------------------------------------------------- #
def test_response_is_publicly_cacheable_and_varies_on_what_selects_it(api_client):
    response = api_client.get(URL)
    assert response["Cache-Control"] == CACHE_CONTROL
    vary = {v.strip().lower() for v in response["Vary"].split(",")}
    assert "accept-language" in vary
    assert "accept" in vary
    # The one that silently destroys shared caching: `Vary: Cookie` appears the
    # moment the view authenticates, because SessionAuthentication reads the
    # session and SessionMiddleware then stamps it.
    assert "cookie" not in vary


def test_etag_is_stable_for_the_same_representation(api_client):
    first = api_client.get(URL)
    second = api_client.get(URL)
    assert first["ETag"]
    assert first["ETag"] == second["ETag"]


def test_etag_differs_between_naming_locales(api_client):
    """Two different byte streams under one URL must not share a validator, or
    a French client gets a 304 for the English catalog."""
    english = api_client.get(URL, {"locale": "en"})["ETag"]
    spanish = api_client.get(URL, {"locale": "es"})["ETag"]
    assert english != spanish


def test_conditional_get_answers_304_with_no_body(api_client):
    etag = api_client.get(URL)["ETag"]
    response = api_client.get(URL, HTTP_IF_NONE_MATCH=etag)
    assert response.status_code == 304
    assert response.content == b""
    # RFC 9110 §15.4.5: a 304 carries the validator and the caching metadata,
    # or the client cannot refresh its freshness lifetime and re-asks forever.
    assert response["ETag"] == etag
    assert response["Cache-Control"] == CACHE_CONTROL


def test_conditional_get_accepts_a_weak_validator(api_client):
    """`If-None-Match` uses the weak comparison function; a proxy that
    weakened our ETag must still get a 304."""
    etag = api_client.get(URL)["ETag"]
    response = api_client.get(URL, HTTP_IF_NONE_MATCH=f"W/{etag}")
    assert response.status_code == 304


def test_conditional_get_accepts_a_star_and_a_list(api_client):
    etag = api_client.get(URL)["ETag"]
    assert api_client.get(URL, HTTP_IF_NONE_MATCH="*").status_code == 304
    listed = f'"0000", {etag}'
    assert api_client.get(URL, HTTP_IF_NONE_MATCH=listed).status_code == 304


def test_a_stale_validator_gets_the_body(api_client):
    response = api_client.get(URL, HTTP_IF_NONE_MATCH='"stale"')
    assert response.status_code == 200
    assert response.json()["languages"]


def test_a_validator_from_another_locale_does_not_short_circuit(api_client):
    """The bug this is for: one ETag for every locale would answer 304 and the
    client would cache the wrong language's names for the whole max-age."""
    english = api_client.get(URL, {"locale": "en"})["ETag"]
    response = api_client.get(URL, {"locale": "es"}, HTTP_IF_NONE_MATCH=english)
    assert response.status_code == 200
    assert response.json()["locale"] == "es"


# --------------------------------------------------------------------------- #
# The seed the frontend falls back to
# --------------------------------------------------------------------------- #
def test_every_tag_in_the_frontend_seed_is_a_canonical_language_tag():
    """``TRANSLATABLE_LANGUAGES`` in ``zpage-language.js`` is the offline
    fallback, and this asserts the one property that has to hold of it
    *independently of the sell list*: every entry is a real language tag,
    already in canonical form.

    Deliberately **not** ``set(seed) <= TRANSLATABLE``. Serving the catalog
    exists so the two sets may diverge —  item 9 wants demoting a
    language to be a cheap backend-only change — and a subset assertion here
    would make a demotion red until someone also edited a JavaScript file.
    ``zh-hans`` or ``pt-br`` in the seed, on the other hand, is a picker entry
    every write path then rejects, and no divergence excuses it.

    Frontend/backend parity is deliberately not pinned. The
    ``tests/editor-translation-manager.test.mjs`` test asserts the same
    non-parity property from the frontend side.
    """
    import re
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[5]
        / "ts/svelte/free2z/src/lib/zpage-language.js"
    ).read_text()
    block = re.search(
        r"export const TRANSLATABLE_LANGUAGES = Object\.freeze\(\[(.*?)\]\)",
        source,
        re.S,
    )
    assert block, "TRANSLATABLE_LANGUAGES is gone from zpage-language.js"
    seed = re.findall(r'"([^"]+)"', block.group(1))
    assert len(seed) >= 39
    for tag in seed:
        assert languages.normalize(tag, allow_missing=False) == tag, (
            f"{tag!r} in the frontend seed is not canonical; the picker would "
            f"offer it and every write path would reject it"
        )


def test_english_catalog_is_json_serializable_as_served():
    """The view hashes ``json.dumps`` of the payload to build the ETag; a
    non-serializable value would 500 there rather than in the renderer."""
    locale, rows = language_catalog.catalog("en")
    json.dumps({"locale": locale, "languages": rows})


def test_cldr_tables_we_claim_to_resolve_against_exist():
    assert language_catalog.DEFAULT_NAMING_LOCALE in CLDR_DISPLAY_NAMES
