"""Which script a translation must be written in, and whether it was.

THE DEFECT
----------
``build_messages`` asked the provider for a language by NAME, and a name is
not always a script. "Chinese (Simplified)" carries it; **"Serbian" does not**.
Serbian is written in Cyrillic and Latin, both in genuine daily use, so a paid
``sr`` translation could come back in Latin, be stored under a tag whose CLDR
likely script is ``Cyrl``, and be served -- or not served -- accordingly. The
same hole is open for ``az``, ``uz``, ``pa``, ``mn`` and ``kk``, which
made sellable in bare form, and it was latent for ``zh-Hans``/``zh-Hant``
before that.

Worse than one wrong answer: fragments are translated independently, so one
article could come back half Cyrillic and half Latin.

TWO HALVES, AND THE SECOND IS THE ONE THAT MATTERS
---------------------------------------------------
1.:func:`script_clause` puts the script in the prompt -- "written in the
   Cyrillic script".
2.:func:`script_mismatch` checks the answer. Asking is not verifying, and the
   repo's dominant defect class is a test that passes without testing: a test
   asserting ``likely_script("sr") == "Cyrl"`` proves metadata, not what the
   provider was asked for, and a test asserting the prompt contains "Cyrillic"
   proves what we asked, not what we got.

HOW THE CHECK WORKS, AND WHAT IT DELIBERATELY WILL NOT DO
---------------------------------------------------------
``unicodedata.name`` names the script of nearly every letter in its own first
word -- ``CYRILLIC CAPITAL LETTER TSHE``, ``DEVANAGARI LETTER KA``,
``ETHIOPIC SYLLABLE YA`` -- so the classification needs no new dependency and
no hand-written codepoint ranges.:data:`SCRIPT_PREFIXES` maps each ISO 15924
code we sell into to those prefixes.

Only characters we can attribute to *some* script are counted, so digits,
punctuation and whitespace are invisible to the ratio, and the expected script
must be a MAJORITY of what remains. It is a majority rather than a purity test
because a correct translation legitimately carries Latin inside it: brand names
(``Free2Z``, ``ZEC``), identifiers, and untranslated proper nouns.

It will not:

* **Tell Hans from Hant.** Both are CJK ideographs and ``unicodedata`` does not
  distinguish them, so both map to the same prefix and a Chinese translation
  passes either way. Simplified-vs-traditional is unverified here and this
  module does not pretend otherwise.
* **Judge a short reply.** Below:data:`MIN_SCRIPT_CHARS` attributable
  characters the ratio is noise -- a three-word title can be all brand names --
  so the verdict is "no opinion".
* **Fire on a script we have no prefixes for.** An unknown script yields no
  opinion rather than a refund.
"""
import unicodedata

#ISO 15924 -> (English name for the prompt, ``unicodedata.name`` prefixes).
#
#Covers every script reachable from ``f2z.languages.TRANSLATABLE``. A script
#missing here costs a prompt clause and an unverified answer, never a false
#failure -- both halves degrade to "say nothing" rather than to "guess".
SCRIPTS = {
    "Arab": ("Arabic", ("ARABIC",)),
    "Armn": ("Armenian", ("ARMENIAN",)),
    "Beng": ("Bengali", ("BENGALI",)),
    "Cyrl": ("Cyrillic", ("CYRILLIC",)),
    "Deva": ("Devanagari", ("DEVANAGARI",)),
    "Ethi": ("Ethiopic", ("ETHIOPIC",)),
    "Geor": ("Georgian", ("GEORGIAN",)),
    "Grek": ("Greek", ("GREEK",)),
    "Gujr": ("Gujarati", ("GUJARATI",)),
    "Guru": ("Gurmukhi", ("GURMUKHI",)),
    # Han, either variant. `unicodedata` cannot tell them apart -- see the
    # module docstring. The NAME still differs, which is the half that reaches
    # the model and the half that can act on it.
    "Hans": ("Simplified Chinese (Han)", ("CJK",)),
    "Hant": ("Traditional Chinese (Han)", ("CJK",)),
    "Hebr": ("Hebrew", ("HEBREW",)),
    "Jpan": ("Japanese (kanji, hiragana and katakana)",
             ("CJK", "HIRAGANA", "KATAKANA")),
    "Khmr": ("Khmer", ("KHMER",)),
    "Knda": ("Kannada", ("KANNADA",)),
    "Kore": ("Korean (hangul)", ("HANGUL", "CJK")),
    "Laoo": ("Lao", ("LAO",)),
    "Latn": ("Latin", ("LATIN",)),
    "Mlym": ("Malayalam", ("MALAYALAM",)),
    "Mymr": ("Myanmar", ("MYANMAR",)),
    "Sinh": ("Sinhala", ("SINHALA",)),
    "Taml": ("Tamil", ("TAMIL",)),
    "Telu": ("Telugu", ("TELUGU",)),
    "Thai": ("Thai", ("THAI",)),
}

#Below this many attributable characters the ratio is noise. A title is
#allowed to be "Free2Z v2".
MIN_SCRIPT_CHARS = 64

#How much of the attributable text must be in the expected script.
#
#A majority, not a purity test: a correct Serbian translation carries
#``Free2Z``, ``ZEC`` and any untranslated proper noun in Latin, and a
#technical article carries identifiers. The failure this exists to catch is
#not "a few Latin words" -- it is a whole document in the wrong alphabet,
#which scores near zero. Nothing real sits at 0.5, which is why the exact
#value is not load-bearing.
MIN_SCRIPT_SHARE = 0.5

_UNKNOWN = object()


def script_name(script):
    """English name of an ISO 15924 code, or ``None`` if we do not name it."""
    entry = SCRIPTS.get(script or "")
    return entry[0] if entry else None


def script_clause(script):
    """The sentence fragment naming ``script``, or ``""``.

    Empty for a script we cannot name, so the prompt simply loses a clause
    rather than gaining a broken one.
    """
    name = script_name(script)
    return f", written in the {name} script" if name else ""


def _prefix_of(char):
    """The ``unicodedata.name`` first word for ``char``, or ``None``.

    ``None`` means "not attributable to a script" -- a digit, punctuation,
    whitespace, an emoji, an unnamed codepoint. Those are excluded from both
    sides of the ratio rather than counted against anyone.
    """
    try:
        name = unicodedata.name(char)
    except ValueError:
        return None
    return name.split(" ", 1)[0]


def script_share(text, script):
    """``(matching, attributable)`` character counts for ``script`` in ``text``.

    Both numbers are returned rather than the ratio, because the caller needs
    ``attributable`` to decide whether it has enough text to have an opinion at
    all -- and a function that returns 0.0 for "all Latin" and for "three
    digits" would hide that difference.
    """
    entry = SCRIPTS.get(script or "")
    if entry is None:
        return 0, 0
    wanted = entry[1]
    matching = 0
    attributable = 0
    for char in text or "":
        if not char.isalpha():
            continue
        prefix = _prefix_of(char)
        if prefix is None:
            continue
        # Only prefixes that name a script we know are attributable. An
        # unfamiliar one (TIFINAGH, say) counts for nobody rather than against
        # the expected script, so an article quoting a script we do not sell
        # cannot push a correct translation under the threshold.
        if prefix not in _KNOWN_PREFIXES:
            continue
        attributable += 1
        if prefix in wanted:
            matching += 1
    return matching, attributable


_KNOWN_PREFIXES = frozenset(
    prefix for _, prefixes in SCRIPTS.values() for prefix in prefixes
)


def script_mismatch(text, script):
    """``(matching, attributable)`` when ``text`` is NOT in ``script``, else ``None``.

    ``None`` is "no complaint", and it covers three different situations on
    purpose -- the script is one we do not classify, there is too little text
    to judge, or the text is fine. All three mean "do not fail a paid
    translation over this".
    """
    matching, attributable = script_share(text, script)
    if attributable < MIN_SCRIPT_CHARS:
        return None
    if matching >= MIN_SCRIPT_SHARE * attributable:
        return None
    return matching, attributable
