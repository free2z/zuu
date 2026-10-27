"""Tests for the canonical language registry (:mod:`f2z.languages`,  P3).

Lives under ``dj/apps/g12f`` because that is what ``py/pytest.ini`` collects
(``testpaths = dj/apps gcp``) and because g12f owns zPage content language, the
first consumer. The module under test itself imports no Django, and none of
these tests touch the database.
"""

import re
from pathlib import Path

import pytest

from f2z.languages import (
    DETECTABLE,
    MAX_TAG_LENGTH,
    TRANSLATABLE,
    UI_LOCALES,
    LanguageError,
    autonym,
    display_name,
    is_detectable,
    is_translatable,
    is_ui_locale,
    normalize,
    translatable_choices,
)

REPO_ROOT = Path(__file__).resolve().parents[5]


# --------------------------------------------------------------------------- #
# Normalization
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("en", "en"),
        ("EN", "en"),
        ("  en  ", "en"),
        ("pt-BR", "pt-BR"),
        ("PT-br", "pt-BR"),
        ("pt-br", "pt-BR"),
        ("ZH-hant", "zh-Hant"),
        ("zh-hans", "zh-Hans"),
    ],
)
def test_normalize_is_case_and_whitespace_insensitive(raw, expected):
    assert normalize(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Deprecated ISO codes canonicalize to their modern equivalents, so a
        # legacy client cannot create a second, parallel "Hebrew".
        ("iw", "he"),
        ("in", "id"),
        ("ji", "yi"),
        # CLDR aliases Tagalog to Filipino.
        ("tl", "fil"),
    ],
)
def test_normalize_applies_cldr_canonicalization(raw, expected):
    assert normalize(raw) == expected


def test_bare_pt_normalizes_to_brazilian_portuguese():
    """Behavior preserved from localization.py:41-42 -- see _REGIONAL_DEFAULTS."""
    assert normalize("pt") == "pt-BR"
    assert normalize("PT") == "pt-BR"


def test_pt_pt_is_a_distinct_valid_content_language():
    """The whole point of  §3.3: pt-PT is not pt-BR and is not rejected."""
    assert normalize("pt-PT") == "pt-PT"
    assert normalize("pt-pt") == "pt-PT"
    assert normalize("pt-PT") != normalize("pt")
    assert is_detectable("pt-PT")


@pytest.mark.parametrize("tag", ["de", "ja", "tl", "yo", "sw", "haw", "qu", "cy"])
def test_the_rest_of_the_world_is_a_valid_content_language(tag):
    """The four-item enum rejected all of these. A creator may write in any of them."""
    assert is_detectable(tag)
    assert tag in DETECTABLE


@pytest.mark.parametrize(
    "garbage",
    [
        "zz",                      # well-formed, not a real language
        "xx-YY",                   # well-formed, invalid subtags
        "english",                 # a name, not a tag
        "en_US",                   # underscore is not BCP-47
        "en--US",                  # empty subtag
        "-en",                     # leading hyphen
        "en-",                     # trailing hyphen
        "e" * (MAX_TAG_LENGTH + 1),
        "'; DROP TABLE g12f_zpage; --",
        "<script>alert(1)</script>",
        "../../etc/passwd",
        "en\nes",
    ],
)
def test_garbage_is_rejected(garbage):
    with pytest.raises(LanguageError):
        normalize(garbage)
    assert not is_detectable(garbage)


@pytest.mark.parametrize("value", [1, 1.0, True, ["fr"], {"lang": "fr"}, object()])
def test_non_strings_are_rejected_rather_than_stringified(value):
    """`["fr"]` must not become the tag "['fr']"."""
    with pytest.raises(LanguageError):
        normalize(value)


def test_missing_is_allowed_or_required_per_the_flag():
    assert normalize(None) is None
    assert normalize("") is None
    assert normalize("   ") is None
    for empty in (None, "", "   "):
        with pytest.raises(LanguageError):
            normalize(empty, allow_missing=False)


@pytest.mark.parametrize(
    "tag",
    [
        "und",  # the sentinel  exists to delete -- never comes back
        "UND",
        "mul",  # multiple languages
        "zxx",  # no linguistic content
        "mis",  # uncoded languages
    ],
)
def test_non_language_codes_are_rejected(tag):
    """A detector returning "I don't know" must fail validation, not persist.

    These are all valid BCP-47 and langcodes' tag_is_valid() accepts them.
    Accepting them here would reintroduce `und` through the front door.
    """
    with pytest.raises(LanguageError):
        normalize(tag)
    assert not is_detectable(tag)
    assert tag not in DETECTABLE


@pytest.mark.parametrize("tag", ["art", "nic", "afa", "cai"])
def test_language_collections_are_rejected(tag):
    """`art` is "Artificial languages", a family. Nobody writes in a family."""
    with pytest.raises(LanguageError):
        normalize(tag)


@pytest.mark.parametrize("tag", ["qaa", "qtz", "qab-Latn"])
def test_private_use_language_subtags_are_rejected(tag):
    with pytest.raises(LanguageError):
        normalize(tag)


@pytest.mark.parametrize(
    "tag", ["x-private", "en-x-draft", "en-u-ca-buddhist", "en-t-de"]
)
def test_private_use_and_extension_singletons_are_rejected(tag):
    """`en` and `en-x-draft` must not look like two different languages."""
    with pytest.raises(LanguageError):
        normalize(tag)


@pytest.mark.parametrize("tag", ["zh", "ar", "ms", "sw"])
def test_macrolanguages_are_accepted(tag):
    """The scope filter must not overreach: zh and ar are real content languages."""
    assert normalize(tag) == tag
    assert is_detectable(tag)


def test_canonicalization_cannot_grow_a_tag_past_the_column_width():
    """CLDR expands `sh-x-...` to `sr-Latn-x-...`, +7 characters.

    Checking only the input length would let a request pass validation and then
    fail on INSERT with DataError.
    """
    grows = "sh-x-12345678-12345678-12345678"
    assert len(grows) <= MAX_TAG_LENGTH
    with pytest.raises(LanguageError):
        normalize(grows)


def test_everything_detectable_can_be_named():
    """normalize() and display_name() must agree on what exists.

    display_name() promises never to emit a bare subtag. That promise only
    holds if normalization refuses every tag the name tables cannot describe.
    """
    for tag in ["qaa", "x-private", "und", "art", "zxx"]:
        assert not is_detectable(tag)
        with pytest.raises(LanguageError):
            display_name(tag, "en")
    for tag in ["yo", "haw", "zh", "ca-ES-valencia", "sr-Latn", "es-419"]:
        assert is_detectable(tag)
        assert display_name(normalize(tag), "en")


def test_a_long_tag_is_rejected_before_it_can_be_stored():
    """Nothing longer than the column may escape normalization."""
    with pytest.raises(LanguageError):
        normalize("en-" + "a" * MAX_TAG_LENGTH)
    # A 100 KB "tag" from a request body is rejected on length, not parsed.
    with pytest.raises(LanguageError):
        normalize("x" * 100_000)


def test_normalize_is_idempotent_for_every_curated_language():
    for tag in TRANSLATABLE:
        assert normalize(tag) == tag, f"{tag} is not in canonical form"
        assert normalize(normalize(tag)) == tag


def test_normalized_output_never_exceeds_the_declared_width():
    for tag in list(TRANSLATABLE) + list(UI_LOCALES):
        assert len(tag) <= MAX_TAG_LENGTH


def test_curated_languages_still_fit_todays_columns():
    """zPage.source_language / ZPageTranslation.language are CharField(max_length=10).

    The registry normalizes up to MAX_TAG_LENGTH (35), which the  P4
    migration will widen the columns to. Until then, every language we
    actively offer must fit in 10 or a save raises DataError in production.
    """
    legacy_column_width = 10
    too_long = [t for t in TRANSLATABLE if len(t) > legacy_column_width]
    assert not too_long, (
        f"{too_long} exceed the current max_length=10 columns; widen them in the "
        "#980 P4 migration before adding these to TRANSLATABLE"
    )


# --------------------------------------------------------------------------- #
# The three sets are genuinely distinct
# --------------------------------------------------------------------------- #
def test_the_three_sets_are_distinct():
    # UI locales are a strict subset of what we translate into...
    assert set(UI_LOCALES) < set(TRANSLATABLE)
    #...and TRANSLATABLE is strictly smaller than DETECTABLE.
    # `yo` used to sit in this list; it became sellable in, and `is`
    # became sellable in  — exactly the churn this test is here to
    # notice.
    for tag in ["haw", "cy", "mt", "gd"]:
        assert tag in DETECTABLE
        assert not is_translatable(tag)
        assert not is_ui_locale(tag)
    # pt-PT is the canonical example of all three levels differing.
    assert is_detectable("pt-PT")
    assert is_translatable("pt-PT")
    assert not is_ui_locale("pt-PT")


def test_detectable_is_open_and_refuses_to_be_enumerated():
    """Rendering "every language in the world" into a dropdown is a bug."""
    with pytest.raises(TypeError):
        list(DETECTABLE)


def test_predicates_normalize_their_input():
    assert is_translatable("PT-br")
    assert is_ui_locale("EN")
    assert is_detectable("  ja  ")
    assert not is_translatable(None)
    assert not is_ui_locale("nonsense")


def test_ui_locales_match_the_frontend_source_of_truth():
    """UI_LOCALES is owned by  and mirrored here; catch the mirror drifting."""
    locale_js = (
        REPO_ROOT / "ts" / "svelte" / "free2z" / "src" / "lib" / "locale.js"
    )
    if not locale_js.exists():  # pragma: no cover - frontend not checked out
        pytest.skip("frontend locale.js not present")
    match = re.search(
        r"SUPPORTED_LOCALES\s*=\s*\[(.*?)\]", locale_js.read_text(), re.S
    )
    assert match, "SUPPORTED_LOCALES not found in locale.js"
    frontend = tuple(re.findall(r'"([^"]+)"', match.group(1)))
    assert frontend == UI_LOCALES, (
        "UI_LOCALES has drifted from ts/svelte/free2z/src/lib/locale.js. "
        "#851 owns that list; mirror it here rather than redefining it."
    )


# --------------------------------------------------------------------------- #
# Display names -- a raw subtag must never reach a reader ( finding 3)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "tag,viewer,expected",
    [
        ("en", "en", "English"),
        ("en", "es", "inglés"),
        ("en", "fr", "anglais"),
        ("en", "pt-BR", "inglês"),
        ("pt-BR", "es", "portugués (Brasil)"),
        ("pt-PT", "es", "portugués (Portugal)"),
        ("pt-BR", "fr", "portugais (Brésil)"),
        ("ja", "pt-BR", "japonês"),
        ("zh-Hans", "fr", "chinois (simplifié)"),
    ],
)
def test_display_name_is_localized_for_the_viewer(tag, viewer, expected):
    assert display_name(tag, viewer) == expected


def test_display_name_distinguishes_the_two_portugueses_in_every_ui_locale():
    for viewer in UI_LOCALES:
        assert display_name("pt-BR", viewer) != display_name("pt-PT", viewer)


def test_display_name_falls_back_to_english_outside_the_curated_set():
    """Open DETECTABLE set: a name in the wrong locale still beats a raw subtag."""
    assert display_name("haw", "es") == "Hawaiian"
    assert display_name("pt-PT", "en") == "Portuguese (Portugal)"
    # Composed from IANA language + region descriptions.
    assert display_name("es-AR", "en") == "Spanish (Argentina)"


def test_display_name_keeps_variant_subtags_distinguishable():
    """Two stored variants must never render as the same label.

    `ca-ES` and `ca-ES-valencia` are different content; if both read "Catalan
    (Spain)" a reader picking between them picks wrong.
    """
    assert display_name("ca-ES", "en") == "Catalan (Spain)"
    assert display_name("ca-ES-valencia", "en") == "Catalan (Spain, Valencian)"
    assert display_name("en-GB", "en") != display_name("en-GB-oxendict", "en")


def test_display_name_never_returns_a_bare_subtag():
    for tag in ["en", "pt-PT", "yo", "haw", "cy", "qu", "es-AR", "zh-Hant-HK"]:
        name = display_name(tag, "es")
        assert name
        assert name != tag
        assert not re.fullmatch(r"[a-z]{2,3}(-[A-Za-z0-9]+)*", name)


def test_display_name_degrades_the_viewer_locale_instead_of_failing():
    # A regional variant of a known UI locale uses that locale's table.
    assert display_name("en", "es-MX") == display_name("en", "es")
    # An unknown or malformed viewer locale falls back to English, not an error.
    assert display_name("en", "ja") == "English"
    assert display_name("en", "not-a-locale") == "English"
    assert display_name("en", None) == "English"


def test_display_name_rejects_a_bad_tag_unless_given_a_default():
    with pytest.raises(LanguageError):
        display_name("zz", "en")
    assert display_name("zz", "en", default="Unknown") == "Unknown"
    assert display_name(None, "en", default="Unknown") == "Unknown"


def test_autonym_is_the_language_naming_itself():
    assert autonym("ja") == "日本語"
    assert autonym("es") == "español"
    assert autonym("pt-BR") == "português (Brasil)"
    assert autonym("de") == "Deutsch"
    # Inside the curated set, the language names itself.
    assert autonym("yo") == "Èdè Yorùbá"
    # Outside it, an English name rather than a subtag.
    assert autonym("haw") == "Hawaiian"
    assert autonym("zz", default="Unknown") == "Unknown"


# --------------------------------------------------------------------------- #
# Ordered access
# --------------------------------------------------------------------------- #
def test_translatable_choices_is_complete_and_deterministic():
    rows = translatable_choices("es")
    assert {tag for tag, _, _ in rows} == set(TRANSLATABLE)
    assert rows == translatable_choices("es")
    # Sorted by the localized name, so the order differs between viewers.
    assert [r[1] for r in rows] == sorted(
        (r[1] for r in rows), key=str.casefold
    )
    assert translatable_choices("en") != rows


def test_every_curated_language_has_a_name_in_every_ui_locale():
    """Fails if TRANSLATABLE or UI_LOCALES grew without re-running the generator."""
    from f2z.language_names import AUTONYMS, CLDR_DISPLAY_NAMES

    for viewer in UI_LOCALES:
        assert viewer in CLDR_DISPLAY_NAMES, (
            f"no name table for UI locale {viewer}; run scripts/free2z/gen-language-names.py"
        )
        missing = sorted(set(TRANSLATABLE) - set(CLDR_DISPLAY_NAMES[viewer]))
        assert not missing, (
            f"{missing} have no {viewer} name; run scripts/free2z/gen-language-names.py"
        )
    assert not sorted(set(TRANSLATABLE) - set(AUTONYMS))


# --------------------------------------------------------------------------- #
#  -- the IANA composer must be unreachable for anything we sell
# --------------------------------------------------------------------------- #
def test_the_iana_composer_is_unreachable_for_every_sellable_language(monkeypatch):
    """The naming leak, pinned.

    ``display_name()`` resolves the curated CLDR table first and only then
    composes a name out of raw IANA subtag descriptions. The composer is a
    safety net for the open DETECTABLE set; it is English-only and it speaks
    IANA's prose, so for a language we charge 2Z to translate into it is a bug.

    Asserting "the table has a key for every tag" is weaker than this, because
    it does not prove ``display_name`` actually reaches the table (a viewer
    fallback bug would still route through the composer with every key
    present). Making the composer *explode* is what proves the path.
    """
    from f2z import languages

    def exploding(tag):  # pragma: no cover - the assertion is that it never runs
        raise AssertionError(
            f"display_name({tag!r}) fell through to the IANA composer. Run "
            "scripts/free2z/gen-language-names.py and commit py/free2z/f2z/language_names.py."
        )

    monkeypatch.setattr(languages, "_english_name", exploding)

    for viewer in UI_LOCALES:
        for tag in sorted(TRANSLATABLE) + list(languages.ALSO_NAMED):
            name = display_name(tag, viewer)
            assert name and name != tag


def test_every_sellable_language_has_an_autonym_of_its_own():
    """A picker showing endonyms must not show an English name in the column.

    ``autonym()`` degrades to the English display name rather than failing, so
    a missing entry is invisible at runtime. This is the only thing that
    notices.
    """
    from f2z.language_names import AUTONYMS

    missing = sorted(set(TRANSLATABLE) - set(AUTONYMS))
    assert not missing, (
        f"{missing} have no autonym; run scripts/free2z/gen-language-names.py"
    )
    for tag in TRANSLATABLE:
        assert autonym(tag) == AUTONYMS[tag]


@pytest.mark.parametrize(
    "tag,composed,curated",
    [
        # The three rows of the table in  that motivated this workstream.
        ("yue-Hant", "Yue Chinese (Han (Traditional variant))", "Cantonese (Traditional)"),
        ("zh-TW", "Chinese (Taiwan, Province of China)", "Chinese (Taiwan)"),
        ("pa", "Panjabi", "Punjabi"),
    ],
)
def test_the_curated_name_beats_the_composed_one(tag, composed, curated):
    """Both halves asserted: what the composer WOULD say, and what we say.

    Pinning only the curated name would keep passing if the composer quietly
    started producing the same string, which would make the first test above
    vacuous without anyone noticing.
    """
    from f2z.languages import _english_name

    assert _english_name(tag) == composed
    assert display_name(tag, "en") == curated


def test_also_named_entries_are_reachable_at_all():
    """Every ALSO_NAMED key must be its own normalized form.

    ``display_name()`` normalizes before it looks anything up, and CLDR folds
    ``pa-Guru`` to ``pa`` -- so a key that is not already canonical is a table
    entry nothing can ever hit, and the composer keeps answering for it.
    """
    from f2z.languages import ALSO_NAMED

    for tag in ALSO_NAMED:
        assert normalize(tag) == tag, f"{tag} is not in canonical form"
        assert tag not in TRANSLATABLE, (
            f"{tag} is sellable; it belongs in TRANSLATABLE, not ALSO_NAMED"
        )


# --------------------------------------------------------------------------- #
#  -- Cantonese is a language, not a script variant of Chinese
# --------------------------------------------------------------------------- #
def test_cantonese_is_sellable_and_defaults_to_traditional_script():
    assert normalize("yue") == "yue-Hant"
    assert normalize("YUE") == "yue-Hant"
    assert is_translatable("yue")
    assert is_translatable("yue-Hant")
    # Simplified Cantonese stays a valid content language we do not sell.
    assert normalize("yue-Hans") == "yue-Hans"
    assert is_detectable("yue-Hans")
    assert not is_translatable("yue-Hans")


def test_cantonese_is_not_a_chinese_script_variant():
    """`yue` vs `zh` is a LANGUAGE choice; `Hans` vs `Hant` is a script choice.

    Collapsing them is the mistake  exists to correct, so the two must
    never normalize, name or compare as the same thing.
    """
    assert normalize("yue-Hant") != normalize("zh-Hant")
    assert display_name("yue-Hant", "en") != display_name("zh-Hant", "en")
    for viewer in UI_LOCALES:
        assert display_name("yue-Hant", viewer) != display_name("zh-Hant", viewer)
    assert autonym("yue-Hant") != autonym("zh-Hant")


def test_a_default_can_never_grow_a_tag_past_the_column_width():
    """The one length check normalize() does NOT re-run.

    `_REGIONAL_DEFAULTS` is applied after the canonicalized length is checked,
    so a long default value would pass validation and then fail on INSERT. The
    map is curated rather than user input, which is why a test is the guard.
    """
    from f2z.languages import _REGIONAL_DEFAULTS

    for bare, default in _REGIONAL_DEFAULTS.items():
        assert len(default) <= MAX_TAG_LENGTH
        assert normalize(bare) == default
        # A default must itself be canonical, or normalize() is not idempotent.
        assert normalize(default) == default


# --------------------------------------------------------------------------- #
#  item 3 -- the bare macrolanguage / script-ambiguous policy
# --------------------------------------------------------------------------- #
def test_bare_zh_stays_detectable_nameable_and_unsellable():
    """A decision, not an oversight -- see the module docstring.

    Rejecting bare `zh` would 404 rows that are already stored (normalize()
    runs on the way OUT of the database too), and defaulting it to a script
    would repoint them to a variant that is wrong half the time.
    """
    assert normalize("zh") == "zh"
    assert is_detectable("zh")
    assert not is_translatable("zh")
    assert display_name("zh", "fr") == "chinois"


@pytest.mark.parametrize(
    "bare,script",
    [("sr", "Cyrl"), ("pa", "Guru"), ("az", "Latn"), ("uz", "Latn")],
)
def test_the_other_bare_tags_are_sellable_with_a_cldr_script(bare, script):
    """The bare form is no longer a dead end: we sell it, and it has a script.

    Unlike `zh`, nothing about these is a coin flip -- CLDR likely-subtags give
    one answer, which is what the rendering path in  consumes.
    """
    from f2z.languages import likely_script

    assert normalize(bare) == bare
    assert is_translatable(bare)
    assert likely_script(bare) == script


@pytest.mark.parametrize("tag", ["sr-Latn", "sr-Cyrl", "pa-Arab", "uz-Cyrl", "az-Cyrl"])
def test_the_script_qualified_forms_stay_valid_content_languages(tag):
    assert is_detectable(tag)
    assert not is_translatable(tag)
    assert display_name(tag, "en")


@pytest.mark.parametrize("tag", ["nan", "wuu", "hak"])
def test_the_unconverged_chinese_languages_are_not_sellable(tag):
    """ item 5: no CLDR autonym, no converged written standard.

    They remain perfectly good content languages -- this is the sell-list line,
    not an accept-list line.
    """
    assert is_detectable(tag)
    assert not is_translatable(tag)


def test_the_sell_list_is_large_enough_to_need_a_real_picker():
    """ item 4. Also the tripwire for an accidental truncation of the set."""
    assert len(TRANSLATABLE) >= 50
