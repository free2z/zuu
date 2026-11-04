"""The language catalog::mod:`f2z.languages` shaped for a picker.

``GET /api/languages/`` exists so that **growing the sellable set does not need
a frontend release**. Today ``TRANSLATABLE`` is mirrored by hand into
``ts/svelte/free2z/src/lib/zpage-language.js``; at 50+ languages, and with the
set becoming something we tune (add one, demote one whose quality is bad), a
compiled-in mirror means every such decision waits for a UI deploy. Serving the
catalog turns that into a data change. See  item 2.

Why a module of its own, rather than three more functions in
:mod:`f2z.languages`
---------------------------------------------------------------------------
``languages.py`` is the *registry*: what a tag means, which sets it belongs to,
what to call it. This is a *view* of that registry — an ordered list with the
fields a picker needs, memoized per naming locale. Keeping them apart means the
registry never grows presentation concerns, and it keeps this file out of the
way of the registry work in.

Like ``languages.py``, this module imports nothing from Django, so it is usable
from a management command, a test, or the MCP server without a configured
project.
"""

from functools import lru_cache

from f2z import languages
from f2z.language_names import CLDR_DISPLAY_NAMES

__all__ = [
    "RTL_SCRIPTS",
    "DEFAULT_NAMING_LOCALE",
    "naming_locale",
    "match_naming_locale",
    "text_direction",
    "language_entry",
    "catalog",
]

#The naming locale we degrade to. English is the one table
#:data:`f2z.language_names.CLDR_DISPLAY_NAMES` is guaranteed to have, and
#:func:`f2z.languages.display_name` already falls back to it.
DEFAULT_NAMING_LOCALE = "en"

#ISO 15924 scripts written right-to-left, by Unicode bidi class (R or AL for
#the script's letters). Deliberately the full list rather than "the scripts
#our current 39 languages use": the whole point of this endpoint is that the
#set grows without a code change here, and a language added to
#``TRANSLATABLE`` in  that rendered LTR because its script was not in a
#short list is exactly the bug  exists to fix.
#
#Sourced from the Unicode script metadata (``Scripts.txt`` + ``DerivedBidi
#Class.txt``); historical scripts are included because they cost nothing and
#omitting one is a silent wrong answer.
RTL_SCRIPTS = frozenset({
    "Adlm", "Arab", "Aran", "Armi", "Avst", "Cprt", "Egyd", "Egyh", "Elym",
    "Hatr", "Hebr", "Hung", "Khar", "Lydi", "Mand", "Mani", "Marc", "Medf",
    "Mend", "Merc", "Mero", "Narb", "Nbat", "Nkoo", "Orkh", "Ougr", "Palm",
    "Phli", "Phlp", "Phnx", "Prti", "Rohg", "Samr", "Sarb", "Sogd", "Sogo",
    "Syrc", "Syre", "Syrj", "Syrn", "Thaa", "Yezi",
})


def _table_locale(viewer_locale):
    """The name table that would serve ``viewer_locale``, or ``None``.

    **Mirrors** ``f2z.languages._viewer_table``'s resolution — exact tag, then
    base language — and returns ``None`` where that function would fall through
    to English, so a caller negotiating a list of candidates can tell "we have
    a table for this" from "we do not".
    """
    try:
        viewer = languages.normalize(viewer_locale, allow_missing=False)
    except languages.LanguageError:
        return None
    if viewer in CLDR_DISPLAY_NAMES:
        return viewer
    base = viewer.split("-", 1)[0]
    if base in CLDR_DISPLAY_NAMES:
        return base
    return None


def naming_locale(viewer_locale):
    """Which locale the names actually come out in, for ``viewer_locale``.

    Exists for two reasons. It collapses the unbounded space of requested
    locales onto the handful of tables we ship, so:func:`catalog`'s
    memoization cannot be blown out by ``?locale=<random>``; and the answer is
    reported to the client, which is what lets a caller cache the catalog under
    the locale it is really in rather than the one it asked for.

    A locale we cannot use degrades to:data:`DEFAULT_NAMING_LOCALE`. It never
    raises: an unusable naming hint must not fail a read.

    ``dj/apps/g12f/test_language_catalog.py`` asserts this agrees with
    ``display_name`` for every catalog tag, so the mirror cannot drift into
    reporting one locale while naming in another.
    """
    return _table_locale(viewer_locale) or DEFAULT_NAMING_LOCALE


def match_naming_locale(candidates):
    """The first candidate we hold a name table for, else English.

    This is the ``Accept-Language`` half. ``["de", "fr"]`` must answer ``fr``,
    not ``en``: stopping at the first *valid* tag would silently discard a
    preference we can actually honour, because ``de`` is a perfectly good
    language tag for which we simply have no name table.
    """
    for candidate in candidates:
        resolved = _table_locale(candidate)
        if resolved is not None:
            return resolved
    return DEFAULT_NAMING_LOCALE


def text_direction(value):
    """``"rtl"`` or ``"ltr"`` for a language tag — the direction it is written.

    Derived from the script CLDR says the tag is written in, not from the
    language: ``ku`` is Latin and LTR, ``ckb`` is Arabic and RTL, and ``sr``
    depends on whether the tag spells ``Latn`` or ``Cyrl``. A tag whose script
    is unanswerable is ``"ltr"``, because "no constraint" and "right to left"
    are not the same claim and the former has to render as something.
    """
    return "rtl" if languages.likely_script(value) in RTL_SCRIPTS else "ltr"


def language_entry(tag, viewer_locale=DEFAULT_NAMING_LOCALE):
    """One catalog row: what a picker needs to render a language honestly.

    ``translatable`` is read from the registry rather than assumed ``True``.
    The catalog *is* the sellable set today, so every served row says ``True``;
    the field is computed so that the day a language is listed but demoted to
    detect-only  the answer changes with the registry and not
    with a release of this file.

    Raises:class:`f2z.languages.LanguageError` for a tag that is not a
    language — a bad tag in the catalog is a bug worth surfacing, not a row to
    quietly drop.
    """
    normalized = languages.normalize(tag, allow_missing=False)
    return {
        "tag": normalized,
        "name": languages.display_name(normalized, viewer_locale),
        "autonym": languages.autonym(normalized),
        "script": languages.likely_script(normalized),
        "direction": text_direction(normalized),
        "translatable": languages.is_translatable(normalized),
    }


@lru_cache(maxsize=16)
def _catalog_cached(locale):
    """Memoized by *resolved* naming locale — at most one entry per CLDR table.

    Every call here walks ~40 tags through langcodes' likely-subtags tables,
    and this endpoint is hit on every editor load. The key is the output of
    :func:`naming_locale`, so the cache is bounded by the number of naming
    tables we ship (4), not by what callers send.
    """
    return tuple(
        language_entry(tag, locale)
        for tag, _name, _autonym in languages.translatable_choices(locale)
    )


def catalog(viewer_locale=DEFAULT_NAMING_LOCALE):
    """``(resolved_locale, rows)`` — the catalog named for this viewer.

    Ordered by the localized name, exactly as
    :func:`f2z.languages.translatable_choices` orders it, so the list reads
    correctly to the viewer rather than in tag order.

    The rows are fresh ``dict``s on every call: the memoized copy is shared
    process-wide, and handing a caller a reference to it is one careless
    ``row["name"] =...`` away from serving a mutated catalog to everyone.
    """
    locale = naming_locale(viewer_locale)
    return locale, [dict(row) for row in _catalog_cached(locale)]
