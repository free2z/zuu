"""The canonical language registry for Free2Z. Language is data, not an enum.

Three *distinct* sets, because they answer three unrelated questions
( Part 3 §3.3, principle 8 "content language != product-UI locale"):

``DETECTABLE``
    **Open.** Any *individual language or macrolanguage* in the IANA registry —
    what a language detector may legitimately return. A creator may write in
    any human language, so the content-language field must accept any human
    language. Membership only: it has ~8000 members and is deliberately not
    iterable. It does **not** include the non-language codes (``und``, ``mul``,
    ``zxx``, ``mis``), language collections (``art``, ``nic``) or private-use
    subtags, even though all of those are technically valid BCP-47 — see
    :func:`normalize`.

``TRANSLATABLE``
    **Curated.** The languages we will *sell* an AI translation into. Bounded
    by what we are willing to charge 2Z for and stand behind, not by what
    exists. Ordered access via:func:`translatable_choices`.

``UI_LOCALES``
    **Owned by **, mirrored here for reference only. These are the locales
    the *product chrome* is translated into. Do NOT grow this set in this
    module — grow it in  and mirror it (a test asserts the two agree).

A sellable language is named from the curated table, never composed
-----------------------------------------------------------------------------
:func:`display_name` resolves through the curated CLDR table in
:mod:`f2z.language_names` and only then falls back to:func:`_english_name`,
which *composes* a name out of raw IANA subtag descriptions. That composer is a
safety net for the open ``DETECTABLE`` set, and IANA's prose is not fit for a
reader: it renders ``yue-Hant`` as "Yue Chinese (Han (Traditional variant))",
``zh-TW`` as "Chinese (Taiwan, Province of China)" and ``pa`` as "Panjabi". It
is also English-only, so every viewer of the product in Spanish, French or
Brazilian Portuguese sees an English name the moment it fires.

So the rule is: **the composer must be unreachable for anything we sell.**
``test_language_registry.py`` asserts it by making:func:`_english_name` raise
and then naming every ``TRANSLATABLE`` tag in every UI locale — the generated
table has to answer all of them.:data:`ALSO_NAMED` extends the same curated
treatment to the commonest tags we *accept but do not sell*, so the composer is
rare in practice as well as forbidden in principle.

Bare macrolanguages and script-ambiguous tags
------------------------------------------------------------
``normalize("zh")`` returns ``zh``: a real IANA language, storable as a content
language, not sellable, and carrying no script subtag. The same question was
asked of bare ``sr``, ``pa``, ``az`` and ``uz``. Both options the issue offered
were rejected, and the reasoning is worth writing down because it will be asked
again:

*Rejecting them on the write path is wrong.*:func:`normalize` runs on values
coming **out** of the database as well as going in — the variant lookup, the
sitemap and the crawler prerender all normalize a stored tag. A validator that
refuses what is already stored converts a mislabel into a 404 or a 500, and
``zh``/``sr``/``az``/``uz`` have been storable ever since this registry landed.
They are also deliberately accepted: see ``_REJECTED_SCOPES``, which keeps
macrolanguages because ``zh``, ``ar`` and ``ms`` are perfectly good content
languages.

*Defaulting bare ``zh`` to a script is wrong too*, and the asymmetry with
``pt`` -> ``pt-BR`` is the point. ``pt`` is safe because no stored row is bare
``pt``. A default applied to ``zh`` silently **repoints an existing row**: the
variant route normalizes the requested tag and filters the language column by
it, so the day ``zh`` starts normalizing to ``zh-Hans`` every stored bare-``zh``
variant becomes a 404. Changing the identity of data that is already written is
a backfill, not a normalization rule. And the guess is a coin flip — Simplified
and Traditional are equally real written standards, so half the relabels would
be wrong in a way the reader can see.

What *is* fixed here is the thing that made the bare tag a dead end: ``sr``,
``pa``, ``az`` and ``uz`` are now sellable in their bare form, whose script CLDR
likely-subtags already answer (``Cyrl``, ``Guru``, ``Latn``, ``Latn`` — see
:func:`likely_script`, which is what the rendering path in  consumes). The
script-qualified forms stay valid content languages and are named by
:data:`ALSO_NAMED`. Bare ``zh`` remains the one genuine ambiguity: detectable,
nameable, not sellable, and a test pins that so it is a decision rather than an
oversight.

``yue`` is the single exception to "do not default", and it is the owner's call
in: written Cantonese is overwhelmingly traditional-script, so the guess
is right nearly always rather than half the time. ``yue-Hans`` stays a valid,
named, non-sellable tag.

**It carries the same repointing risk, and the risk is not zero.** ``yue`` was
never sellable, but it has always been *writable* — a creator could label a
source article or a human translation ``yue``, and the codex review of
was right to reject "not sellable, therefore no rows" as an argument. Any such
row is now addressed as ``yue-Hant`` while the column still says ``yue``, so
``/variants/yue/`` 404s and ``/variants/yue-Hant/`` misses. The exposure is a
handful of rows at most and the remedy is a one-line backfill, which belongs in
the  migration wave rather than in a migration-free workstream. Tracked
separately; do not assume it has happened.

Why ``f2z/`` and not ``dj/apps/g12f/``
-------------------------------------
This module imports nothing from Django, exactly like:mod:`f2z.ai.providers`,
so it is usable from the detector service, management commands, the MCP server
 and plain unit tests without a configured Django project. It is also
consumed by more than one Django app (g12f content language, openai/translation
pricing, search indexing, and eventually 's UI locales), so it does not
belong inside any one of them. ``py/BUILD.bazel`` already globs ``f2z/**/*.py``
into the deployed image, so no build change is needed.

Errors are:class:`LanguageError`, a plain ``ValueError`` — never a DRF
``ValidationError``. Django-facing callers catch it and re-raise in their own
vocabulary. That keeps this module importable without Django installed.

Call sites that migrate to this module in the follow-up wave
------------------------------------------------------------
Nothing imports this module yet, by design — this wave is migration-free so it
can land in parallel with the schema work. The map for the next agent:

===============================================================  ==========================================
Call site                                                        Replace with
===============================================================  ==========================================
``dj/apps/g12f/models/zpage.py:71-76`` ``SUPPORTED_ZPAGE_LANGUAGES``   ``TRANSLATABLE`` / no ``choices=`` at all
``dj/apps/g12f/models/zpage.py:78-85`` ``LEGACY_UNDETERMINED_LANGUAGE`` / ``ZPAGE_LANGUAGE_CHOICES``  deleted ( M7 — ``und`` goes away)
``dj/apps/g12f/localization.py:14`` ``SUPPORTED_LANGUAGE_CODES``       ``TRANSLATABLE`` (membership) / ``UI_LOCALES``
``dj/apps/g12f/localization.py:32-50`` ``normalize_zpage_language``:func:`normalize`
``dj/apps/g12f/localization.py:110-136`` ordering + ``und`` insert:func:`translatable_choices` order, no sentinel
``dj/apps/g12f/serializers/zpage.py:175-217`` language validation:func:`normalize`, catching:class:`LanguageError`
``dj/apps/g12f/views/zpage.py`` ``?lang=`` parsing:func:`normalize` with ``allow_missing=True``
``f2z/ai/language.py`` (new,  P5) detector output validation:func:`is_detectable` — the constrained-output guard
``ts/svelte/free2z/src/lib/locale.js`` ``LANGUAGE_OPTIONS``            served from:func:`translatable_choices`
===============================================================  ==========================================

**Blocking constraint for the migration wave:** ``zPage.source_language`` and
``ZPageTranslation.language`` are ``CharField(max_length=10)`` today, while this
registry normalizes to:data:`MAX_TAG_LENGTH` = 35 (the width  §3.1
specifies). Every tag in:data:`TRANSLATABLE` fits in 10 (a test enforces that),
but the open ``DETECTABLE`` set does not — ``zh-Hant-HK`` is 10, ``ca-ES-valencia``
is 14. Widen the columns in the P4 migration *before* wiring detection to the
write path, or a perfectly valid detected tag raises ``DataError`` on save.
"""

import re
import threading

from langcodes import Language, standardize_tag, tag_is_valid
from langcodes.registry_parser import parse_registry
from langcodes.tag_parser import LanguageTagError

from f2z.language_names import AUTONYMS, CLDR_DISPLAY_NAMES

__all__ = [
    "ALSO_NAMED",
    "DETECTABLE",
    "TRANSLATABLE",
    "UI_LOCALES",
    "MAX_TAG_LENGTH",
    "LanguageError",
    "normalize",
    "is_detectable",
    "is_translatable",
    "is_ui_locale",
    "likely_script",
    "RTL_SCRIPTS",
    "text_direction",
    "direction_attribute",
    "display_name",
    "autonym",
    "translatable_choices",
]


class LanguageError(ValueError):
    """A language tag is missing, malformed, or not a real language.

    Deliberately a plain ``ValueError``: this module must stay importable
    without Django, so it cannot raise ``rest_framework.serializers``
    exceptions. API layers catch this and re-raise as a 400.
    """


#Widest tag we will store. Matches the ``CharField(max_length=35)`` in the
#§3.1 target schema, which in turn matches the longest tags CLDR emits
#in practice. Anything longer is rejected rather than silently truncated by
#Postgres -- see the migration note in the module docstring.
MAX_TAG_LENGTH = 35

#Cheap pre-filter so obvious garbage never reaches the (relatively expensive)
#BCP-47 parser. Subtags are alphanumeric, 1-8 chars, hyphen-separated.
_SHAPE = re.compile(r"^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*$")


# --------------------------------------------------------------------------- #
# The three sets
# --------------------------------------------------------------------------- #
class _OpenLanguageSet:
    """Membership-only set: "any real language", which cannot be enumerated.

    Modelled as an object rather than a ``frozenset`` on purpose. Writing
    ``tag in DETECTABLE`` reads the same as ``tag in TRANSLATABLE``, but
    iterating it is a bug — it means the caller is about to render "every
    language in the world" into a dropdown, which is what the four-item enum
    was overcorrecting for.
    """

    __slots__ = ()

    def __contains__(self, value):
        return is_detectable(value)

    def __iter__(self):
        raise TypeError(
            "DETECTABLE is an open set and cannot be enumerated. Use "
            "`tag in DETECTABLE` to validate, or TRANSLATABLE / UI_LOCALES "
            "when you need a list to render."
        )

    def __repr__(self):  # pragma: no cover - debugging affordance
        return "<DETECTABLE: any valid BCP-47 language tag>"


#Any individual language or macrolanguage, in any well-formed regional or
#script variant. Membership-only; see:class:`_OpenLanguageSet`.
DETECTABLE = _OpenLanguageSet()

#Product-UI locales. **Owned by ** — mirrored from
#``ts/svelte/free2z/src/lib/locale.js`` ``SUPPORTED_LOCALES``, which is the
#source of truth. Do not add a language here to make it a valid *content*
#language; content languages are ``DETECTABLE`` and need no entry anywhere.
UI_LOCALES = ("en", "es", "fr", "pt-BR")

#Languages we will sell an AI translation into ( Part 6, grown in ).
#Curated: every entry is a language we are willing to charge 2Z for, and
#every entry fits the legacy ``max_length=10`` columns (a test enforces it).
#
#**Admission criteria**, applied to every tag added in:
#
#1. A curated CLDR display name in *all four* UI locales and an autonym in
#the language's own script. Mechanical, and enforced by
#``test_language_registry.py`` — no entry may reach the IANA composer.
#2. One dominant written standard and orthography, so "translate into X" has
#an unambiguous answer. This is what excludes ``nan``/``wuu``/``hak``
#: no CLDR autonym and no converged written standard.
#3. Official/national status or an established publishing register at scale,
#so there is a real body of written text behind the model's output.
#
#**Known gap for the script-ambiguous entries** (``sr``, ``az``, ``uz``,
#``pa``, ``mn``, ``kk``). The translation prompt in
#``dj/apps/g12f/translation/service.py`` names the target with
#``display_name(tag, "en")``, which for a bare tag is "Serbian" -- it does not
#say "in the Cyrillic script". ``zh-Hans``/``zh-Hant``/``yue-Hant`` are safe
#because their name carries the script. So a creator can buy Serbian and be
#handed Latin Serbian, stored under ``sr``, which:func:`likely_script` then
#reports as Cyrillic. The registry already exposes the answer
#(:func:`likely_script`); the prompt has to ask for it, and that file belongs
#to. Raised by the codex adversarial review of  and reported
#rather than fixed here.
#
#**What these criteria are NOT.** None of them is a translation-*quality*
#evaluation on a sample; that is  /  item 9 and it has not been
#done for any entry in this set, old or new. This tranche is admitted on
#written-standard and resource grounds, which is why demoting a language back
#to detect-only has to stay a cheap, routine operation — the whole point of
#serving the catalog from the API  rather than compiling it into a
#frontend release. Entries carrying only a name predate  and were
#admitted under 's "highest-traffic world languages" rationale.
#
#A frozenset because the only correct operation on it is membership. Anything
#that needs an *order* must use:func:`translatable_choices`: iterating a
#frozenset of strings yields a different order in every process (PYTHONHASHSEED
#is randomized), which would shuffle a user-facing dropdown between requests.
TRANSLATABLE = frozenset(
    {
        "af",       # Afrikaans
        "am",       # Amharic - official language of Ethiopia; Ethiopic script, full CLDR coverage
        "ar",       # Arabic
        "az",       # Azerbaijani - official in Azerbaijan; Latin is the written standard since 1991 (az-Cyrl/az-Arab stay detect-only)
        "bg",       # Bulgarian - official EU language; one Cyrillic standard
        "bn",       # Bengali
        "ca",       # Catalan - official in Catalonia and Andorra; large publishing corpus
        "cs",       # Czech
        "da",       # Danish
        "de",       # German
        "el",       # Greek
        "en",       # English
        "es",       # Spanish
        "et",       # Estonian - official EU language
        "eu",       # Basque - official in the Basque Country; standardized as Euskara Batua since 1968
        "fa",       # Persian
        "fi",       # Finnish
        "fil",      # Filipino (CLDR canonicalizes "tl" to this)
        "fr",       # French
        "gl",       # Galician - official in Galicia; RAG-standardized orthography
        "gu",       # Gujarati - scheduled language of India, ~55M; Gujarati script
        "ha",       # Hausa - West African lingua franca, ~80M; Boko (Latin) is the standard orthography
        "he",       # Hebrew
        "hi",       # Hindi
        "hr",       # Croatian - official EU language; one Latin standard (hr/bs/sr is a named detection pair, )
        "ht",       # Haitian Creole - official language of Haiti; orthography standardized in 1979
        "hu",       # Hungarian
        "hy",       # Armenian - official in Armenia; own script, full CLDR coverage
        "id",       # Indonesian
        "ig",       # Igbo - national language of Nigeria, ~30M; standard Onwu orthography
        "is",       # Icelandic - official language of Iceland; one Latin standard, Arnastofnun-regulated orthography, full CLDR coverage
        "it",       # Italian
        "ja",       # Japanese
        "ka",       # Georgian - official in Georgia; own script
        "kk",       # Kazakh - official in Kazakhstan; Cyrillic is the current standard (the Latin transition is not complete)
        "km",       # Khmer - official in Cambodia; no inter-word spaces, needs the line-breaking in
        "kn",       # Kannada - scheduled language of India, ~45M
        "ko",       # Korean
        "lo",       # Lao - official in Laos; no inter-word spaces, needs the line-breaking in
        "lt",       # Lithuanian - official EU language
        "lv",       # Latvian - official EU language
        "mk",       # Macedonian - official in North Macedonia; one Cyrillic standard
        "ml",       # Malayalam - scheduled language of India, ~35M
        "mn",       # Mongolian - official in Mongolia; Cyrillic is the written standard there (mn-Mong stays detect-only)
        "mr",       # Marathi - scheduled language of India, ~83M; Devanagari
        "ms",       # Malay
        "my",       # Burmese - official in Myanmar; needs the line-breaking and font coverage in
        "nb",       # Norwegian Bokmal
        "ne",       # Nepali - official in Nepal; Devanagari
        "nl",       # Dutch
        "nn",       # Norwegian Nynorsk - one of Norway's two official written standards; nb already sells, nb/nn is a named detection pair
        "pa",       # Punjabi - scheduled language of India, ~113M; Gurmukhi is the CLDR default (pa-Arab/Shahmukhi stays detect-only)
        "pl",       # Polish
        "ps",       # Pashto - official in Afghanistan; RTL Arabic script, so it leans on the container work in
        "pt-BR",    # Portuguese (Brazil)
        "pt-PT",    # Portuguese (Portugal)
        "ro",       # Romanian
        "ru",       # Russian
        "si",       # Sinhala - official in Sri Lanka; own script
        "sk",       # Slovak - official EU language
        "sl",       # Slovenian - official EU language
        "so",       # Somali - official in Somalia; Latin orthography standardized in 1972
        "sq",       # Albanian - official in Albania and Kosovo; unified 1972 standard
        "sr",       # Serbian - official in Serbia; Cyrillic is the CLDR default (sr-Latn stays detect-only)
        "sv",       # Swedish
        "sw",       # Swahili
        "ta",       # Tamil
        "te",       # Telugu
        "th",       # Thai
        "tr",       # Turkish
        "uk",       # Ukrainian
        "ur",       # Urdu
        "uz",       # Uzbek - official in Uzbekistan; Latin is the current standard (uz-Cyrl stays detect-only)
        "vi",       # Vietnamese
        "yo",       # Yoruba - national language of Nigeria, ~45M; standard orthography since 1966
        "yue-Hant", # Cantonese (Traditional) - a distinct language from zh, not a script variant of it; ~85M speakers and a real written vernacular in HK/Macau
        "zh-Hans",  # Chinese (Simplified)
        "zh-Hant",  # Chinese (Traditional)
        "zu",       # Zulu - official in South Africa, ~12M; standardized Latin orthography
    }
)

#Product overrides applied to bare language subtags, and the ONLY place a
#normalized tag differs from what CLDR alone would produce.
#
#``pt`` -> ``pt-BR`` preserves behavior that predates this module
#(``localization.py:41-42``): our Portuguese audience is Brazilian and every
#stored Portuguese row is ``pt-BR``, so a bare ``pt`` from a client means
#Brazilian Portuguese in practice. It also agrees with CLDR likely-subtags
#(``pt`` maximizes to ``pt-Latn-BR``). It is NOT applied generally — that
#same maximization would turn ``en`` into ``en-US`` and ``es`` into ``es-ES``,
#inventing a region nobody asked for.
#
#Note the tension this creates now that ``pt-PT`` is a valid content
#language: a Portuguese creator who sends bare ``pt`` gets labelled Brazilian
#and must correct it. makes the label mutable and detection sends
#an explicit regional tag, that is a recoverable mislabel rather than the
#permanent one it is today. Revisit if it shows up in support.
#
#``yue`` -> ``yue-Hant`` (the owner's call in ) is the same
#mechanism applied to a *script* rather than a region, and it is the only
#place we do that. The module docstring explains why bare ``zh`` does NOT get
#the same treatment: the Cantonese guess is right nearly always, the Chinese
#one is a coin flip, and ``yue`` was not sellable before today so there is no
#population of stored rows a default could repoint.
#
#**Every value here must fit**:data:`MAX_TAG_LENGTH`. This map is applied
#*after*:func:`normalize` re-checks the canonicalized length, so a long
#default would sail past validation and fail on INSERT. The map is curated,
#not user input, so a test is the right guard rather than a runtime check.
_REGIONAL_DEFAULTS = {
    "pt": "pt-BR",
    "yue": "yue-Hant",
}

#Tags we accept but do not sell, that are nonetheless common enough to be
#worth naming from CLDR rather than composing from IANA .
#
#:func:`display_name` falls back to:func:`_english_name` for anything outside
#the curated table. That composer is correct but it is *English-only* and it
#speaks IANA's prose, so a Spanish-speaking reader who lands on a ``zh-TW``
#article sees "Chinese (Taiwan, Province of China)" rather than
#"chino (Taiwán)". These are the tags where that actually happens:
#
#* the regional Chinese tags a client or a detector really sends,
#* the Cantonese forms we accept but do not sell,
#* the script pairs behind the bare-tag question in  item 3.
#
#Display names only — deliberately **not** autonyms. CLDR has no usable
#endonym for several of these (``zh-TW`` comes back as "Chinese（Taiwan）",
#half in English), and:data:`AUTONYMS` means "one entry per language we
#actually offer".:func:`autonym` already degrades to the localized name.
#
#Every entry must be its own normalized form, or the key is unreachable —
#:func:`display_name` normalizes before it looks anything up, and CLDR folds
#``pa-Guru`` to ``pa``. A test enforces it.
ALSO_NAMED = (
    "az-Cyrl",
    "az-Latn",
    "mn-Cyrl",
    "pa-Arab",
    "sr-Cyrl",
    "sr-Latn",
    "uz-Cyrl",
    "uz-Latn",
    "yue-Hans",
    "zh",
    "zh-CN",
    "zh-HK",
    "zh-MO",
    "zh-SG",
    "zh-TW",
)

#IANA ``Scope`` values that mark a subtag as something other than a language
#someone can write an article in.
#
#``special`` is ``und``/``mul``/``zxx``/``mis`` — the "I don't know", "several
#languages" and "no linguistic content" codes.  exists to delete ``und``;
#accepting it back through the front door of a registry that replaced the
#enum would be the same sentinel with a nicer provenance. ``collection`` is a
#language *family* (``art`` "Artificial languages", ``nic`` "Niger-Kordofanian
#languages") — not a language. ``private-use`` (``qaa``..``qtz``) means
#whatever the sender decided, which is not something we can name or translate.
#
#``macrolanguage`` is deliberately absent: ``zh``, ``ar`` and ``ms`` are
#macrolanguages and are perfectly good content languages.
_REJECTED_SCOPES = frozenset({"special", "collection", "private-use"})

_normalize_cache = {}
_normalize_lock = threading.Lock()

_registry_tables = None
_registry_lock = threading.Lock()


def _registry():
    """Lazily parse the IANA subtag registry that ``langcodes`` bundles.

    Returns ``(descriptions, language_scopes)``. ~700 KB of text, ~50 ms, parsed
    once per process on the first language validation and cached forever.

    Reading the registry — rather than hardcoding a denylist — is what keeps
    :func:`normalize` and:func:`display_name` in agreement: a tag is accepted
    only if this table can also *name* it, so ``display_name`` cannot be handed
    a tag it has nothing to say about.
    """
    global _registry_tables
    if _registry_tables is not None:
        return _registry_tables

    descriptions = {}
    scopes = {}
    for item in parse_registry():
        subtag = item.get("Subtag") or item.get("Tag")
        kind = item.get("Type")
        described = item.get("Description")
        if not subtag or kind not in ("language", "region", "script", "variant"):
            continue
        if ".." in subtag:
            # A range like "qaa..qtz" (private use) describes no single subtag.
            # Leaving these out is what makes `qaa` fail validation below.
            continue
        if described:
            descriptions.setdefault((kind, subtag), described[0])
        if kind == "language":
            scopes.setdefault(subtag, item.get("Scope"))

    tables = (descriptions, scopes)
    with _registry_lock:
        _registry_tables = tables
    return tables


# --------------------------------------------------------------------------- #
# Normalization + validation
# --------------------------------------------------------------------------- #
def normalize(value, *, allow_missing=True):
    """Return the canonical BCP-47 form of ``value``, or raise.

    Case-insensitive and whitespace-tolerant: ``"  PT-br "`` -> ``"pt-BR"``.
    Applies CLDR canonicalization, so deprecated tags become their modern
    equivalents (``iw`` -> ``he``, ``in`` -> ``id``, ``tl`` -> ``fil``).

    Unlike the four-item enum this replaces, ``de``, ``ja``, ``pt-PT`` and
    ``tl`` are all accepted: any real human language is a valid *content*
    language.

    Rejected despite being well-formed BCP-47, because none of them is a
    language a creator writes in and every one of them would become a sentinel
    the moment it reached the database:

    * ``und``, ``mul``, ``zxx``, ``mis`` — the non-language codes. ``und`` in
      particular is the thing  exists to delete.
    * ``art``, ``nic``,... — language *collections* (families).
    * ``qaa``..``qtz`` and ``x-…`` — private use, meaningless to anyone else.
    * anything carrying an extension singleton (``en-u-ca-buddhist``): those
      encode locale preferences, not language identity, and would fragment the
      variant table into rows that are the same language.

    ``allow_missing`` controls the empty case only: ``None``/``""`` returns
    ``None`` when true, raises:class:`LanguageError` when false.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        if allow_missing:
            return None
        raise LanguageError("Language is required.")

    if not isinstance(value, str):
        # int, list, dict from a hostile or careless JSON body. Do not
        # str() it -- that would turn `["fr"]` into the tag "['fr']".
        raise LanguageError("Language must be a string.")

    raw = value.strip()
    try:
        return _normalize_cache[raw]
    except KeyError:
        pass

    if len(raw) > MAX_TAG_LENGTH:
        # Checked before parsing: the tag parser is happy to chew through a
        # 100 KB "tag" from a request body, and nothing that long is a
        # language.
        raise LanguageError(
            f"Language tag is too long (limit {MAX_TAG_LENGTH} characters)."
        )
    if not _SHAPE.match(raw):
        raise LanguageError(f"{value!r} is not a well-formed language tag.")

    try:
        normalized = standardize_tag(raw)
    except LanguageTagError as exc:
        raise LanguageError(f"{value!r} is not a well-formed language tag.") from exc

    if not tag_is_valid(normalized):
        raise LanguageError(f"{value!r} is not a known language.")

    # Canonicalization can make a tag LONGER than the input -- CLDR expands
    # `sh-x-...` to `sr-Latn-x-...`, adding 7 characters. Checking only the
    # input would let a 35-char request produce a 42-char value that passes
    # validation and then blows up on INSERT. Re-check what we will return.
    if len(normalized) > MAX_TAG_LENGTH:
        raise LanguageError(
            f"Language tag is too long (limit {MAX_TAG_LENGTH} characters)."
        )

    if any(len(part) == 1 for part in normalized.split("-")):
        # A singleton subtag introduces a private-use (`x-`) or extension
        # (`u-`, `t-`) section. Both describe preferences rather than a
        # language, and both would make `en` and `en-x-draft` look like
        # different languages to every unique constraint downstream.
        raise LanguageError(
            f"{value!r} carries a private-use or extension subtag, which is not "
            "a language."
        )
    parsed = Language.get(normalized)

    # Every subtag must be one the parser actually recognized. `langcodes`
    # is lenient about a three-letter subtag it cannot place -- `tag_is_valid`
    # says yes to `en-USA` and `fr-XYZ`, and `standardize_tag` echoes them back
    # lowercased -- so without this check `en-usa` becomes a storable "content
    # language" that is not BCP-47, renders as plain "English" (indistinguish-
    # able from `en`), and occupies its own row in every unique index keyed on
    # language. Rebuilding the tag from the components the parser could name
    # and demanding it match is what catches that: a dropped subtag shortens
    # the rebuild.
    rebuilt = "-".join(
        part
        for part in (
            parsed.language,
            parsed.script,
            parsed.territory,
            *(parsed.variants or ()),
        )
        if part
    )
    if rebuilt.casefold() != normalized.casefold():
        raise LanguageError(
            f"{value!r} contains a subtag that is not a known script, region "
            "or variant."
        )

    language_subtag = parsed.language
    scopes = _registry()[1]
    if language_subtag not in scopes:
        # Includes private-use subtags (qaa..qtz), which the registry lists
        # only as a range and which nothing outside the sender can interpret.
        raise LanguageError(f"{value!r} is not a known language.")
    if scopes[language_subtag] in _REJECTED_SCOPES:
        raise LanguageError(
            f"{value!r} is not a language someone writes in "
            f"({scopes[language_subtag]} subtag)."
        )

    normalized = _REGIONAL_DEFAULTS.get(normalized, normalized)

    with _normalize_lock:
        # Bounded so a flood of junk tags cannot grow the process heap. The
        # working set is tiny (a few dozen tags); the cap only matters under
        # abuse, where dropping the cache entirely is the right behavior.
        if len(_normalize_cache) >= 4096:
            _normalize_cache.clear()
        _normalize_cache[raw] = normalized
    return normalized


def is_detectable(value):
    """True if ``value`` is a language we would accept as content language."""
    try:
        return normalize(value, allow_missing=False) is not None
    except LanguageError:
        return False


def is_translatable(value):
    """True if we sell an AI translation into ``value``."""
    try:
        return normalize(value, allow_missing=False) in TRANSLATABLE
    except LanguageError:
        return False


def is_ui_locale(value):
    """True if ``value`` is a locale the product chrome is translated into."""
    try:
        return normalize(value, allow_missing=False) in UI_LOCALES
    except LanguageError:
        return False


def likely_script(value):
    """The script ``value`` is written in per CLDR likely-subtags, or ``None``.

    ``zh-TW`` -> ``"Hant"``, ``zh-CN`` -> ``"Hans"``, ``pt-BR`` -> ``"Latn"``,
    ``sr`` -> ``"Cyrl"``. The point is the tags that do **not** spell a script
    out: `zh-TW` and `zh-CN` are the commonest hand-written Chinese tags, and
    treating them as script-less is how a Taiwanese reader was served Simplified
    text. Reading an explicit subtag is not enough; this answers what
    the tag *means*.

    Mirrors ``new Intl.Locale(tag).maximize().script`` in
    ``ts/svelte/free2z/src/lib/zpage-language.js``. ICU and the CLDR tables
    langcodes bundles agree tag for tag on everything reachable here, and
    ``zpage_language_parity.json`` pins that agreement across the two runtimes —
    a divergence would let one URL serve two languages.

    ``langcodes.Language.maximize()`` needs no ``language_data``: the
    likely-subtags table ships in langcodes itself, so this works on the
    deployed image, which deliberately omits that extra (see
    ``py/requirements/main.txt``). Verified against a bare
    ``langcodes==3.5.1`` install.

    ``None`` for anything unanswerable, which callers must read as "no
    constraint" rather than as a conflict.
    """
    try:
        tag = normalize(value, allow_missing=False)
    except LanguageError:
        return None
    try:
        return Language.get(tag).maximize().script or None
    except Exception:  # pragma: no cover - langcodes raises several types
        # A language tag must never take down a page, least of all a link
        # preview. Unanswerable is not a conflict.
        return None


# --------------------------------------------------------------------------- #
# Text direction -- which way the script runs
# --------------------------------------------------------------------------- #

#Scripts CLDR marks right-to-left (``scriptMetadata.txt``, ``rtl = YES``).
#
#A **script** set, not a language set, and that is the point. ``ar``, ``fa``,
#``he`` and ``ur`` -- the four RTL languages in:data:`TRANSLATABLE` -- are
#right-to-left because of the script they are written in, not because of their
#primary subtag: ``ar-Latn`` is romanized Arabic and runs left-to-right, while
#``pa-Arab`` (Shahmukhi Punjabi) runs right-to-left although ``pa`` does not.
#A four-entry allow-list of primary subtags gets both of those backwards, and
#it is wrong again the first time anyone writes in Pashto, Sindhi, Dhivehi,
#Yiddish or Sorani Kurdish -- all of which:data:`DETECTABLE` already accepts.
#
#``langcodes`` has no direction API and this image deliberately omits
#``langcodes[data]``, so the set has to be a literal here. It mirrors
#``RTL_SCRIPTS`` in ``ts/svelte/free2z/src/lib/content-direction.js``, and
#``zpage_language_parity.json``'s ``direction`` table pins the two runtimes'
#ANSWERS rather than their intermediate script -- so ICU saying ``Aran`` for
#``ur`` where langcodes says ``Arab`` is harmless by construction, both being
#in here.
#
#**The invariant is not "this list is right" -- it is "both tiers agree with
#one oracle."** A hand-added entry that CLDR contradicts is how two
#implementations drift apart, and that drift IS. So the JS mirror's test
#checks EVERY entry against ICU's own
#``Intl.Locale.prototype.getTextInfo()``, and this set is asserted equal to
#the JS one, which is how ``Todr`` (Todhri) was caught in BOTH: it is an
#Albanian historic script that reads left-to-right. A wrong entry mis-renders
#content just as surely as a missing one, so do not add a script here on the
#assumption that historic means right-to-left.
#
#``Aran`` and ``Syre``/``Syrj``/``Syrn`` are the four ICU will not speak for:
#``und-<script>`` maximizes to ``en-<script>-US`` for each, meaning CLDR has no
#likely language for the subtag and ICU is answering about ENGLISH. They are
#Nastaliq and the three Syriac variants, all right-to-left, and the JS test
#asserts that ``^en-`` maximization so the exemption cannot be used to silence
#the oracle. ``Todr`` maximizes to ``sq-Todr-AL`` -- a real answer -- and so
#could never have been exempted that way.
#
#If someone later has real evidence Todhri is right-to-left, add it back WITH
#that evidence and an upstream CLDR note, in both runtimes. Do not leave it
#silently disagreeing with ICU in one of two.
RTL_SCRIPTS = frozenset(
    {
        "Adlm",
        "Arab",
        "Aran",
        "Armi",
        "Avst",
        "Chrs",
        "Cprt",
        "Elym",
        "Gara",
        "Hatr",
        "Hebr",
        "Hung",
        "Khar",
        "Lydi",
        "Mand",
        "Mani",
        "Mend",
        "Merc",
        "Mero",
        "Narb",
        "Nbat",
        "Nkoo",
        "Orkh",
        "Ougr",
        "Palm",
        "Phli",
        "Phlp",
        "Phnx",
        "Prti",
        "Rohg",
        "Samr",
        "Sarb",
        "Sidt",
        "Sogd",
        "Sogo",
        "Syrc",
        "Syre",
        "Syrj",
        "Syrn",
        "Thaa",
        "Yezi",
    }
)


def text_direction(value):
    """``"rtl"``/``"ltr"`` for ``value``, or ``None`` when it says nothing.

    ``None`` is load-bearing and callers must not quietly read it as ``"ltr"``:
    "we do not know" and "we know it runs left-to-right" produce different
    ``dir`` attributes. See:func:`direction_attribute`.

    Derived from:func:`likely_script`, so it answers the tags people actually
    write. ``ar`` carries no ``Arab`` subtag, and a check that reads only an
    explicit script does not fire for any of the four languages this exists for.
    """
    script = likely_script(value)
    if not script:
        return None
    return "rtl" if script in RTL_SCRIPTS else "ltr"


def direction_attribute(value):
    """The ``dir`` attribute for text in ``value`` -- never ``None``.

    ``"auto"`` when the language is unknown, which is the honest answer and also
    a useful one: the browser then reads the first strong character of the
    element's own text, which beats silently inheriting the chrome's direction.

    A KNOWN language always gets an explicit ``ltr``/``rtl`` instead, because
    ``auto`` gets the common case here wrong: "Zcash" and ``2Z`` open Arabic
    paragraphs constantly, and first-strong-character detection reads such a
    paragraph as left-to-right. The language tag is metadata; the heuristic is a
    guess, and metadata wins whenever it exists.
    """
    return text_direction(value) or "auto"


# --------------------------------------------------------------------------- #
# Display names -- the reason a raw subtag never reaches a reader
# --------------------------------------------------------------------------- #
_MISSING = object()


def _english_name(tag):
    """Compose an English name for any *normalized* tag from the IANA registry.

    ``pt-PT`` -> ``"Portuguese (Portugal)"``; ``yo`` -> ``"Yoruba"``. This is
    the safety net that makes it impossible for:func:`display_name` to fall
    all the way through to the raw subtag, which  finding 3 forbids from
    ever reaching user-facing prose.

    It cannot come up empty for a tag:func:`normalize` accepted: normalization
    rejects every language subtag this table has no description for.
    """
    parsed = Language.get(tag)
    table = _registry()[0]
    base = table.get(("language", parsed.language or tag))
    if base is None:  # pragma: no cover - normalize rejects these first
        return None
    qualifiers = [
        table.get(("script", parsed.script)) if parsed.script else None,
        table.get(("region", parsed.territory)) if parsed.territory else None,
    ]
    # Variant subtags carry real identity: `ca-ES` and `ca-ES-valencia` are
    # different content, and dropping the variant would label both "Catalan
    # (Spain)" -- a reader picking between two identically-named entries picks
    # wrong. Registered variants are lowercase in the registry.
    for variant in parsed.variants or ():
        qualifiers.append(table.get(("variant", variant.lower())) or variant)
    qualifiers = [q for q in qualifiers if q]
    return f"{base} ({', '.join(qualifiers)})" if qualifiers else base


def _viewer_table(viewer_locale):
    """Pick the name table for a viewer, degrading to English rather than failing.

    ``es-MX`` falls back to ``es``; an unknown viewer locale falls back to
    English. Naming a language in *slightly* the wrong locale beats naming it
    in no locale.
    """
    try:
        viewer = normalize(viewer_locale, allow_missing=False)
    except LanguageError:
        viewer = "en"
    table = CLDR_DISPLAY_NAMES.get(viewer)
    if table is None:
        base = Language.get(viewer).language
        table = CLDR_DISPLAY_NAMES.get(base)
    return table or CLDR_DISPLAY_NAMES["en"]


def display_name(value, viewer_locale="en", *, default=_MISSING):
    """Name ``value`` in the viewer's language. Never returns a raw subtag.

    ``display_name("pt-BR", "es")`` -> ``"portugués (Brasil)"``.

    Resolution: the curated CLDR table for the viewer's locale, then an English
    name composed from the IANA registry. The second tier is complete for every
    tag:func:`normalize` accepts — that is enforced by normalization rejecting
    any language subtag the registry cannot describe — so the only way to get
    nothing back is to pass a tag that was never valid.

    The second tier is also **unreachable for anything in**:data:`TRANSLATABLE`
     and for:data:`ALSO_NAMED`, and a test proves it by making
    :func:`_english_name` raise. It composes IANA prose in English only; see the
    module docstring for what that looks like and why it must not reach a reader
    of a language we charge for.

    Invalid input raises:class:`LanguageError` unless ``default`` is given.
    Pass ``default`` where a bad tag in the database must not blow up a page
    render; leave it off where a bad tag is a bug worth surfacing.
    """
    try:
        tag = normalize(value, allow_missing=False)
    except LanguageError:
        if default is _MISSING:
            raise
        return default

    name = _viewer_table(viewer_locale).get(tag)
    if name is None:
        name = _english_name(tag)
    if name is None:  # pragma: no cover - unreachable for a valid tag
        if default is _MISSING:
            raise LanguageError(f"No display name available for {value!r}.")
        return default
    return name


def autonym(value, *, default=_MISSING):
    """The language's name written in itself: ``autonym("ja")`` -> ``"日本語"``.

    Curated languages only — an endonym is what a language picker should show,
    and the picker only ever lists:data:`TRANSLATABLE`. Falls back to the
    English name for anything else, which is still a name and not a subtag.
    """
    try:
        tag = normalize(value, allow_missing=False)
    except LanguageError:
        if default is _MISSING:
            raise
        return default
    return AUTONYMS.get(tag) or display_name(tag, "en", default=default)


def translatable_choices(viewer_locale="en"):
    """:data:`TRANSLATABLE` as ordered ``(tag, name, autonym)`` triples.

    The ordering exists because ``TRANSLATABLE`` is a frozenset: iterating it
    directly gives a different order in every process, which would reshuffle a
    dropdown between requests. Sorted by the localized name so the list reads
    correctly to the viewer.
    """
    rows = [
        (tag, display_name(tag, viewer_locale), autonym(tag))
        for tag in TRANSLATABLE
    ]
    # Secondary key on the tag keeps the order total when two languages share
    # a localized name.
    return sorted(rows, key=lambda row: (row[1].casefold(), row[0]))
