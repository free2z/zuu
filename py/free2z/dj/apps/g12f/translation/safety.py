"""AI output is untrusted input ( §6.3).

A translation is the one place on this platform where a **third party's**
generated text is written into a creator's article under the creator's name.
The creator does not read it before it is stored (they review a draft
afterwards), and the document being translated is itself attacker-controllable
-- anyone can publish a zPage, and a zPage body reaches a translation prompt.
So the threat is not "the model makes a bad translation", it is "the document
talks the model into writing something into the output that the creator never
wrote", and the interesting payload is not a script tag (the markdown pipeline
escapes raw HTML) but a **link**: an exfiltration or phishing destination
sitting in an article that a trusted creator published.

The defences here, in the order they matter:

**1. The URL invariant.** The set of link targets, image sources and embed
URLs in the output must be a SUBSET of those in the source. A translation
introduces no new destinations -- that is a property of what translation *is*,
not a heuristic, which is what makes it checkable. This is the check that
actually stops prompt-injected exfiltration, and it fails the job rather than
sanitizing silently, because a document that produced a URL nobody wrote is a
document we do not want to publish half of.

There is NO exception for a destination that appears only inside code. One
was tried during  (``url_in_code_not_in_source``, a warning) and removed
in the same PR: deciding "this is code, so it cannot be clicked" needs a parser
that agrees with the renderer (marked 16 + DOMPurify, ``processMarkdown`` in
``ts/svelte/free2z/src/lib/utils/markdown.ts``) on every construct that
consumes a backtick first -- link titles, the math extension, raw HTML, a
backtick inside a URL's userinfo, a fence closed by `` ```~ ``, a table cell.
A regex disagreed on each of those, and every disagreement delivered a
RENDERED, clickable phishing link as a mere warning. Security over
convenience: a new destination ANYWHERE in the output, code or not, fails the
job. A tutorial whose placeholder address gets translated (zPage 4966) is
refunded, not delivered.

**The same rule covers URL tokens our narrower patterns would split.** marked
autolinks a bare ``https://`` / ``www.`` run up to whitespace or ``<``, so
`` https://example.com`x`@evil.example/pay `` is ONE link whose host is
``evil.example`` (``example.com`x``` is userinfo), while ``_BARE_URL`` stops at
the backtick and sees only ``https://example.com``.:func:`extract_split_url_tokens`
reads the renderer-width token, and one that carries a backtick or a userinfo
``@`` the source did not contain verbatim is ``url_not_in_source`` too.
``bin/check-translation-url-oracle.py`` renders every known bypass through the
real ``processMarkdown`` and asserts this module calls each one fatal.

**2. The scheme allowlist.** Every destination in the output must also match
the scheme rule the reader-side sanitizer applies
(``ALLOWED_URI_REGEXP`` in ``ts/svelte/free2z/src/lib/utils/markdown-sanitize.ts``).
Redundant with the subset rule when the source is clean, and deliberately so:
a source that already carries a ``javascript:`` link (which the renderer
strips at read time) must not be able to launder one through a translation.

**Payment addresses follow the same subset rule.** Checksum-valid mainnet
Zcash addresses are extracted from rendered Markdown text, including Unified
(``u1``), Sapling (``zs1``), TEX (``tex1``), transparent (``t1``/``t3``), and
Sprout (``zc``) forms. A new or rewritten address is fatal just like a new
link destination.
Visible text is flattened before matching, so inline markup, entities, format
controls and compatibility characters cannot hide a changed destination.

**3. No new markup.** The set of raw HTML tag names in the output must be a
subset of the source's. ``markdown.ts``'s ``renderer.html`` escapes all
author-supplied raw HTML, so this cannot currently reach a reader's DOM -- it
is defence in depth against that renderer changing, and it is cheap.

**4. Amounts are preserved.** Every ``$``-denominated amount in the output must
appear in the source. A model that "helpfully" converts $5 into R$27 in a
translated fundraising page has changed a number a reader will act on.

**5. Identifiers are not prose**. Three kinds of token in a markdown
document are *names*, and translating a name breaks the thing it names:

* a **footnote id** (``[^note]``) and a **link reference label**
  (``[label]`` / ``[label]: url``) tie two places in the document together, and
  the two places are usually in DIFFERENT chunks -- so a model that renders
  ``[^note]`` as ``[^nota]`` in the definition and leaves the reference alone
  produces a document whose footnote silently stops resolving and renders as
  literal ``[^note]`` text. Nothing above sees it: no destination changed, no
  tag appeared, no amount moved.
* a **code identifier in backticks** (`` `get_balance()` ``). Prompt rule 2
  forbids translating it; nothing verified that it had not been. Which spans
  count is decided from the SOURCE alone -- see
  :func:`extract_code_identifiers`.
* a **product name** -- Free2Z, 2Z, zPage, Zcash, ZEC. ``2Z`` is what a creator
  is charged in, and a translation that transliterates it, or decides it is a
  currency and converts it, has changed what the page says about money.

The footnote/reference rule is a **subset** rule, the same shape as 1-4, and
that shape is chosen rather than "the output must still resolve" on purpose. A
label in the output that was not in the source is a renamed label, and renaming
is the defect; a definition that merely stopped being *recognised* -- a model
that prefixed it so it is no longer at the start of its line -- is a dropped
link, which this module has always allowed. A document that arrives already
broken therefore cannot be failed by its translation, and neither can one the
model made a worse translation of.

The other two run the opposite way, **from the source**: an identifier or a
product name the source contained must still be there. A subset rule cannot
express those, and trying cost a false positive that only appears in the
languages this work exists to add -- see:func:`extract_code_identifiers`.

Everything here is a pure function of two strings, so it is exercised
directly by tests without a provider, a database or a charge.

FAIL OR WARN -- NOT DECIDED HERE
----------------------------------------
Every invariant above used to fail the whole job and refund it. zPage 4966 is
why that stopped: a Markdown tutorial whose `` `**flexibility**` `` example
was (correctly) translated tripped ``code_identifier_not_preserved``, and
eleven provider calls of an otherwise finished translation were thrown away.
The output of a paid translation is an UNPUBLISHED DRAFT its creator reviews
before any reader sees it, so a preservation miss is a thing to point at, not
a reason to deliver nothing.

So this module reports (:func:`find_violations`) and the worker asks
``settlement.DELIVER_WITH_WARNING_CODES`` which violations are delivered as
``warnings`` on the charge record and which still fail the job. The rules
themselves -- and the reasons each one exists, below -- are unchanged; what
changed is what a violation costs. Where this docstring says a check "fails
the job", read "fails it if the settlement policy says so". The URL invariant
(1) still does: an ``https://`` destination survives the reader sanitizer, so
it stays fatal until the editor shows warnings before publish.

What still keeps a violation away from READERS is unchanged and does not
depend on this module: a delivered translation is never auto-published
(``translation.tasks``), and the reader-side sanitizer still strips unsafe
schemes and escapes raw HTML at render time.

WHAT THIS IS NOT
----------------
This is not a markdown sanitizer, and it must not become one. Translated
markdown is stored in the SAME column as creator markdown
(``ZPageTranslation.content``) and rendered by the SAME pipeline
(``MarkdownContent`` -> ``processMarkdown`` -> ``sanitizeMarkdownHtml``), which
is the actual answer to "does AI output go through the same sanitizer as
creator markdown": there is no second render path to sanitize. These checks
run *before* storage and reject the whole job; they add a rule the sanitizer
cannot express (subset-of-the-source) rather than duplicating one it can.
"""
from collections import Counter
import base64
from bisect import bisect_right
import html
from pathlib import Path
import re
import string
import unicodedata

from django.core.exceptions import ValidationError

from dj.apps.g12f.validators import (
    BECH32_CHARSET,
    BECH32_HRPS,
    _bech32_hrp_expand,
    _bech32_polymod_step,
    validate_zcash_address,
)


class UnsafeTranslation(Exception):
    """One invariant the output broke.

    Carries a short machine-readable ``code`` so the status endpoint can say
    which invariant broke, and ``items`` -- the offending strings, sorted -- so
    a delivered-with-warnings draft can name exactly what to look at.

    Whether a violation FAILS the job or is delivered as a warning is not
    decided here: see ``settlement.DELIVER_WITH_WARNING_CODES`` and
    :func:`find_violations`.:func:`check_translation` still raises the first
    one, for callers that want the strict yes/no.
    """

    def __init__(self, code, message, items=()):
        self.code = code
        self.items = tuple(items)
        super().__init__(message)


# --------------------------------------------------------------------------- #
# Destination extraction
# --------------------------------------------------------------------------- #
# Deliberately over-broad: extracting MORE strings tightens the invariant on
# the output side (more things must be present in the source) and the same
# function runs on both sides, so a construct we over-read is over-read
# symmetrically. The failure mode of over-extraction is a false positive --
# a refunded job -- never an accepted payload.

#`[text](destination "title")` and `![alt](destination)`. Stops at the first
#whitespace or `)`, which is exactly where a markdown destination ends.
_INLINE_TARGET = re.compile(r"\]\(\s*<?([^)\s>]+)")

#`[label]: destination "title"` reference definitions, at the start of a line.
#
#`(?!\^)` EXCLUDES FOOTNOTE DEFINITIONS, and that exclusion is a bug fix, not
#a tidy-up. `[^note]: The supporting detail.` matched this pattern
#with `[^note]` read as the label and **`The`** read as the destination -- so
#the Spanish translation `[^note]: El detalle.` "introduced" the destination
#`el`, failed `url_not_in_source`, and refunded a paid translation. Any zPage
#with a footnote was in that state: the first word of every footnote changes
#under translation, by definition. `marked-footnote` is in the render
#pipeline, so footnotes are a supported, documented feature of a zPage.
_REFERENCE_TARGET = re.compile(
    r"^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:[ \t]*<?([^\s>]+)", re.MULTILINE
)

#`<https://example.com>` autolinks.
_AUTOLINK = re.compile(r"<((?:[a-zA-Z][a-zA-Z0-9+.\-]*:|www\.)[^>\s]+)>")

#Bare URLs anywhere in the text, including inside prose the renderer may or
#may not linkify. Any `scheme://` counts -- a scheme we have never heard of
#is exactly the thing worth noticing -- plus the schemeless-authority forms
#that carry a destination without slashes.
#
#`scheme://` (or an explicit member of that second list) is REQUIRED rather
#than accepting any `word:`, because prose is full of colons: a bare
#`[a-z]+:\S+` rule reads `Ratio:1` as a URL, the translated `Verhaeltnis:1`
#as a DIFFERENT URL, and refunds a perfectly good translation.
_BARE_URL = re.compile(
    r"(?<![\w.+-])("
    r"[a-zA-Z][a-zA-Z0-9+.\-]{1,31}://[^\s<>\)\]\"'`]+"
    r"|(?:mailto|tel|sms|data|javascript|vbscript|file|blob):[^\s<>\)\]\"'`]+"
    r"|www\.[^\s<>\)\]\"'`]+"
    r")",
    re.IGNORECASE,
)

#A bare URL GLUED to whatever precedes it. ``_BARE_URL``'s look-behind
#refuses to start inside a word, but marked's GFM autolinker does not look
#behind at all: ``.https://evil.example``, ``1https://evil.example``,
#``xwww.evil.example`` and -- in exactly the languages this feature
#translates into -- ``こちらhttps://evil.example`` are all rendered links, and
#``_BARE_URL`` extracted NOTHING from any of them (codex review of the
#security round; pre-existing). Limited to the schemes marked autolinks
#(``http``, ``https``, ``ftp``, ``www.`` followed by a domain character), and
#started at the scheme, which is where the rendered href starts.
_GLUED_URL = re.compile(
    r"((?:https?|ftp)://[^\s<>\)\]\"'`]+|www\.[a-zA-Z0-9\-][^\s<>\)\]\"'`]*)",
    re.IGNORECASE,
)

#A bare e-mail address. marked's GFM extension autolinks it to
#``mailto:`` (``inline.gfm.url``'s ``email`` branch, copied here), so a
#translation that writes an address the article never contained has
#introduced a clickable destination exactly as a URL would ( security
#round, found by ``bin/check-translation-url-oracle.py``). Read as
#``mailto:<address>`` so the address and an explicit ``mailto:`` link to it
#compare equal.
_BARE_EMAIL = re.compile(
    r"(?<![A-Za-z0-9._+-])([A-Za-z0-9._+-]+@[a-zA-Z0-9\-_]+"
    r"(?:\.[a-zA-Z0-9\-_]*[a-zA-Z0-9])+)(?![-_])"
)

#Any HTML attribute that can become a URL sink, quoted or bare. `data-*`
#is included wholesale because `markdown-sanitize.ts` does NOT URL-filter
#`data-*` (see its header comment) -- those values reach real sinks.
#The `(?<![\w-])` guard stops `metadata="x"` reading as `data="x"`.
_HTML_URL_ATTR = re.compile(
    r"""(?<![\w-])
        (?:href|src|srcset|poster|action|formaction|cite|background|
           longdesc|data|data-[\w-]+)
        \s*=\s*
        (?:"([^"]*)"|'([^']*)'|([^\s>]+))""",
    re.IGNORECASE | re.VERBOSE,
)

#`::embed[url]`, `::iframe[url]`, `::qrcode[value]` block directives
#(``markdown.ts`` `blockDirective`). Their payload becomes `data-embed-url` /
#`data-qr-value`, so it is a destination even when it is not URL-shaped.
_BLOCK_DIRECTIVE = re.compile(
    r"^[ \t]{0,3}::(?:embed|iframe|qrcode)\[([^\]\n]+)\]", re.IGNORECASE | re.MULTILINE
)

#Raw HTML element names. Not a parser and does not need to be: an element
#name that appears in the output and not in the source is the signal. The
#tag must actually CLOSE with no `<` in between, so `a < b` in prose (and
#its translation `a < c`) is not read as an element.
_HTML_TAG = re.compile(r"</?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?/?>")
# Marked also treats a standalone complete custom-element tag as a raw HTML
# block. Keep this tag-shaped and line-anchored rather than relying on the
# CommonMark block-tag allowlist; custom tags such as <custom> are valid here.
_MARKED_BLOCK_HTML_START = re.compile(r" {0,3}" + _HTML_TAG.pattern, re.IGNORECASE)

#ZIP-321 plain-text payment URIs carry ZEC amounts that a translated prose
#amount check would otherwise miss. Preserve parentheses because they are
#legal query characters (for example, in labels); trailing prose punctuation
#is stripped after tokenization. Scope parsing to zcash: URIs so ordinary web
#URLs with an `amount=` parameter do not become payment fields.
_ZIP321_URI = re.compile(r"zcash:[^\s<>]+", re.IGNORECASE)

# JavaScript's RegExp ``\s`` set, used by Marked's reference-definition
# destination rule (``[^<\s][^\s]*``). Python's ``str.isspace`` differs at
# U+0085 and U+FEFF, so spell out the renderer's set instead of silently
# treating Python and the locked Markdown parser as the same grammar.
_MARKED_WHITESPACE = frozenset(
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009"
    "\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_ZIP321_QCHAR_VALUE = re.compile(
    r"(?:[A-Za-z0-9._~!$'()*+,;:@-]|%[0-9A-Fa-f]{2})*"
)

#Prefixes of mainnet Zcash destinations, searched without a left boundary:
#Markdown formatting and translated prose can glue the visible address to
#adjacent text. Candidates are then accepted only after checksum validation.
_ZCASH_PREFIX = re.compile(r"(?:zcash:)?(?:tex1|zs1|u1|t1|t3|zc)", re.IGNORECASE)
_ASCII_ALNUM = re.compile(r"[A-Za-z0-9]")
_BECH32_CHAR_VALUES = {char: index for index, char in enumerate(BECH32_CHARSET)}
_ASCII_CONFUSABLES = None

#A currency amount a reader would act on. The left boundary keeps a match
#from restarting within a grouped number, and keeps `$$5+3$$` out (KaTeX
#display math: the inner `$` is preceded by `$`) while still reading
#`US$50` as `$50`. Capture either common currency placement; the numeric
#token is normalized separately so locale punctuation can compare as value.
_AMOUNT = re.compile(
    # Do not restart a match after punctuation or inside a space-grouped
    # number. Without both guards, a long malformed token such as ``1," * N
    # or ``123 " * N lets the suffix branch retry the remaining input from
    # every group, making the scan quadratic. A currency marker followed by a
    # number is a new prefix amount, not the suffix marker for the prior one.
    #
    # The `.`/`,` guard applies to the SUFFIX branch only: a `$` prefix after
    # a comma (`$5,$500`) is a new amount, and guarding it made an added price
    # in a comma-separated list invisible to this check.
    r"(?:(?<![$\d])\$\s*(?P<prefix>"
    r"\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)*|\d+(?:[.,]\d+)*)"
    r"(?![.,]\d)|(?<![$\d.,])(?<!\d[ \u00a0\u202f])(?P<suffix>"
    r"\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)*|\d+(?:[.,]\d+)*)"
    r"(?![.,]\d)\s*\$(?![$\d]))"
)

#A footnote reference or definition: `[^id]`. `marked-footnote` is in the
#render pipeline (`markdown.ts`), so these resolve for real.
_FOOTNOTE_REF = re.compile(r"\[\^([^\]\s]+)\]")
_FOOTNOTE_DEF = re.compile(r"^[ \t]{0,3}\[\^([^\]\s]+)\]:", re.MULTILINE)

#A link reference USE -- `[text][label]`, or `[label][]` / `[label]` for the
#collapsed and shortcut forms. Only the explicit `[text][label]` form is read
#here: the shortcut form `[label]` is indistinguishable from prose in square
#brackets, and reading prose as a label would fail translations for writing
#`[sic]`.
_REFERENCE_USE = re.compile(r"\[(?!\^)[^\]\n]*\]\[([^\]\n]*)\]")

#A link reference DEFINITION -- `[label]: destination`.
_REFERENCE_DEF = re.compile(
    r"^[ \t]{0,3}\[(?!\^)([^\]\n]+)\]:[ \t]*\S", re.MULTILINE
)

#A backticked span. Both the single- and double-backtick forms, because a
#span containing a backtick uses the double form.
_CODE_SPAN = re.compile(r"``([^`\n]+)``|`([^`\n]+)`")

#Mirror of `ALLOWED_URI_REGEXP` in
#`ts/svelte/free2z/src/lib/utils/markdown-sanitize.ts`. Kept character for
#character (only the JS `/.../i` wrapper differs) so the two cannot drift
#into disagreeing about what a safe destination is. If that file changes,
#change this.
SAFE_URI_RE = re.compile(
    r"^(?:(?:https?|mailto|tel):|/(?!/)|[#?]|[^:/?#]+(?:[/?#]|$)|$)",
    re.IGNORECASE,
)

#Trailing characters that belong to the surrounding prose rather than to the
#URL. Stripped from both sides identically.
_TRAILING_NOISE = ".,;:!?'\"`)]}>*_"
_ZIP321_SOURCE_TRAILING_NOISE = _TRAILING_NOISE.replace("*", "").replace("_", "")
_ZIP321_OUTPUT_TRAILING_NOISE = _TRAILING_NOISE.replace("_", "")


def normalize_destination(raw):
    """Canonical comparison form for one destination string.

    Case-folded: a model that lowercases a host has not introduced a new
    destination, and the host is the part that decides where a reader lands.
    The leniency this buys an attacker is nil -- to exploit it the SOURCE
    would already have to contain the destination they want.
    """
    value = (raw or "").strip()
    if value.startswith("<") and value.endswith(">"):
        value = value[1:-1].strip()
    value = value.strip(_TRAILING_NOISE)
    return value.casefold()


def extract_destinations(text):
    """Every link target, image source, embed URL and bare URL in ``text``."""
    found = set()
    if not text:
        return found

    for pattern in (
        _INLINE_TARGET,
        _REFERENCE_TARGET,
        _AUTOLINK,
        _BARE_URL,
        _GLUED_URL,
        _BLOCK_DIRECTIVE,
    ):
        for match in pattern.finditer(text):
            value = normalize_destination(match.group(1))
            if value:
                found.add(value)

    for match in _BARE_EMAIL.finditer(text):
        value = normalize_destination("mailto:" + match.group(1))
        if value:
            found.add(value)

    for match in _HTML_URL_ATTR.finditer(text):
        raw = match.group(1) or match.group(2) or match.group(3) or ""
        value = normalize_destination(raw)
        if value:
            found.add(value)

    return found


#A bare URL as WIDE as the renderer reads it. marked's GFM autolinker
#(``inline.gfm.url``) takes ``https?://`` / ``www.`` and then everything up
#to whitespace or ``<`` -- backticks, quotes, ``)`` and ``]`` included -- so
#where ``_BARE_URL`` stops at one of those, the link a reader clicks keeps
#going. No look-behind, for the reason given at ``_GLUED_URL``, and the
#same three schemes: they are the only ones marked autolinks.
_RENDERER_WIDTH_URL = re.compile(
    r"((?:https?|ftp)://[^\s<]+|www\.[a-zA-Z0-9\-][^\s<]*)",
    re.IGNORECASE,
)

#Where a URL's authority ends, per the WHATWG URL parser for the special
#schemes (``\\`` counts as ``/`` there).
_AUTHORITY_END = re.compile(r"[/?#\\]")


def _authority(token):
    """The authority of a scheme-or-``www.`` token: userinfo, host and port."""
    rest = token.split("://", 1)[1] if "://" in token else token
    return _AUTHORITY_END.split(rest, 1)[0]


def extract_split_url_tokens(text):
    """Renderer-width URL tokens that our narrower patterns would SPLIT.

    A token is returned (normalized like every destination) when it carries a
    backtick anywhere, or an ``@`` in its authority. Those are the two ways a
    character ``_BARE_URL`` stops at can sit INSIDE the link marked renders:
    `` https://example.com`x`@evil.example/pay `` is one autolink to
    ``evil.example`` (everything before the ``@`` is userinfo), while
    ``_BARE_URL`` reads ``https://example.com`` and finds it in the source.

    Compared output-minus-source like:func:`extract_destinations`, so an
    article that already contains such a token verbatim may keep it. A path
    ``@`` (``https://medium.com/@user``) is not in the authority and is not
    read; the narrow patterns already compare that URL whole.
    """
    found = set()
    for match in _RENDERER_WIDTH_URL.finditer(text or ""):
        value = normalize_destination(match.group(1))
        if value and ("`" in value or "@" in _authority(value)):
            found.add(value)
    return found


def extract_tags(text):
    """Raw HTML element names appearing in ``text``, lowercased."""
    return {match.group(1).lower() for match in _HTML_TAG.finditer(text or "")}


def extract_footnote_ids(text):
    """``(referenced, defined)`` footnote ids, case-folded."""
    text = text or ""
    defined = {m.group(1).casefold() for m in _FOOTNOTE_DEF.finditer(text)}
    referenced = {
        m.group(1).casefold() for m in _FOOTNOTE_REF.finditer(text)
    } - defined
    # A definition line `[^a]: text` also matches the reference pattern, so
    # subtracting the definitions is what keeps `referenced` to real uses.
    return referenced, defined


def extract_reference_labels(text):
    """``(used, defined)`` link reference labels, case-folded.

    Markdown reference labels are matched case-insensitively by the renderer,
    so ``[Foo]: url`` defines ``[foo]``. Comparing them any other way would
    report a difference the reader never sees.
    """
    text = text or ""
    defined = {m.group(1).casefold() for m in _REFERENCE_DEF.finditer(text)}
    used = set()
    for match in _REFERENCE_USE.finditer(text):
        label = match.group(1).strip().casefold()
        if label:
            used.add(label)
    return used, defined


def extract_code_spans(text):
    """Every backticked span in ``text``, single- or double-backtick form."""
    found = set()
    for match in _CODE_SPAN.finditer(text or ""):
        value = (match.group(1) or match.group(2) or "").strip()
        if value:
            found.add(value)
    return found


def extract_code_identifiers(text):
    """Backticked spans that are IDENTIFIERS rather than backticked prose.

    "Identifier" is defined here as *contains no whitespace*: `` `max_tokens` ``
    and `` `--sandbox` `` are names, while `` `press Enter` `` and
    `` `npm ci` `` are phrases a translator may legitimately have something to
    do with. Narrowing the rule costs coverage and buys the thing that matters
    more in a money path -- a false positive here is a REFUNDED paid
    translation, so the rule has to be one a correct translation cannot trip.

    **ASCII-only, and only ever applied to the SOURCE.** Both narrowings came
    from the same defect, found in two rounds of codex adversarial review, and
    both are about the same language family.

    Round 1: the rule ran the whitespace test over the OUTPUT and failed any
    whitespace-free span the source did not contain -- which fires on a
    correct translation as soon as the TARGET puts no spaces between words.
    `` `press Enter` `` is exempt in English because it contains a space; its
    Japanese translation ``続行するには`Enterを押す`。`` is not.

    Round 2: moving the question to the source fixed one direction only. Run
    the same article the other way -- a Japanese SOURCE containing
    ``続行するには`Enterを押す`。``, translated to
    ``Then `press Enter` to continue.`` -- and the space-free Japanese phrase
    is now classified as an identifier that the English translation "lost".
    Whitespace cannot answer "is this code" for a language that does not use
    it, in either direction.

    So an identifier is whitespace-free **and ASCII**. Code identifiers are
    overwhelmingly ASCII (``get_balance()``, ``--sandbox``, ``max_tokens``),
    and a span carrying non-ASCII letters is prose we decline to police.
    Japanese, Chinese, Thai, Khmer, Lao and Burmese have no inter-word spaces
    and four of those six are on 's list, so this is not a hypothetical
    language family -- it is the one the work exists to add.

    The question the check asks is "did an identifier the SOURCE named
    survive", never "is this output span an identifier". See
    :func:`_check_identifiers`.

    **An emphasis EXAMPLE is not an identifier either.** A Markdown
    tutorial writes `` `**flexibility**` `` and `` `*really*` `` to SHOW the
    syntax, and the word inside is English the translator is right to
    translate. zPage 4966 was refunded for exactly that -- eleven provider
    calls and ~28k tokens thrown away over ``['**bold**', '**flexibility**',
    '*really*']``. See:func:`is_emphasis_example` for where the line is, and
    why ``**kwargs`` and ``__init__`` stay on the identifier side of it.
    """
    return {
        value for value in extract_code_spans(text)
        if value.isascii()
        and not any(ch.isspace() for ch in value)
        and not is_emphasis_example(value)
    }


#A natural-language word wrapped in Markdown emphasis: one to three
#asterisks, or ONE underscore, the SAME run on both sides, and only letters
#(plus an inner hyphen or apostrophe) inside.
#
#What it deliberately does not match, and why:
#
#* ``**kwargs`` / ``*args`` -- not wrapped on both sides. Python's
#unpacking syntax, a real identifier.
#* ``__init__`` / ``__dunder__`` -- a DOUBLE underscore is Markdown strong
#emphasis too (``__bold__``), but a span shaped like that is far more often
#a Python dunder, and the two cannot be told apart by looking. Identifier
#wins; the cost of being wrong is a warning on a delivered draft.
#* ``*foo_bar*``, ``**x2**``, ``*get()*`` -- anything but letters inside is
#code-shaped, so it stays protected.
_EMPHASIS_EXAMPLE = re.compile(
    r"^(?:(?P<stars>\*{1,3})(?P<starred>[A-Za-z](?:[A-Za-z'\-]*[A-Za-z])?)"
    r"(?P=stars)"
    r"|_(?P<underscored>[A-Za-z](?:[A-Za-z'\-]*[A-Za-z])?)_)$"
)


def is_emphasis_example(span):
    """Whether a backticked ``span`` is a word wrapped in emphasis markers.

    ``**flexibility**``, ``*really*``, ``***x***`` and ``_word_`` are; ``**kwargs``,
    ``*args``, ``__init__`` and ``__dunder__`` are not.
    """
    return bool(_EMPHASIS_EXAMPLE.match(span or ""))


_COMMA_DECIMAL_LANGUAGES = frozenset(
    "af be bg ca cs da de el es et eu fi fr hr hu id is it lt lv nb nn no pl "
    "pt ro ru sk sl sq sr sv tr uk vi".split()
)
_DOT_DECIMAL_LANGUAGES = frozenset(
    "en ja ko zh ar he hi bn fa th".split()
)


#Regions whose decimal mark differs from their language's default above.
#zPage tags are any valid BCP-47 tag (``source_language`` is not limited to
#TRANSLATABLE), and dropping the region read ``es-MX``/``es-419`` ``$1,500``
#as 1.5 -- authorizing a translation that says ``$1.50``. Generated from
#CLDR via ICU (``Intl.NumberFormat(tag).formatToParts(1234.5)``) for every
#ISO region of every language in the two sets above; every other region of
#those languages agrees with its language's default.
_REGIONAL_DECIMAL_SEPARATORS = {
    **dict.fromkeys(
        "de-ch de-li it-ch es-419 es-br es-bz es-cu es-do es-gt es-hn es-mx "
        "es-ni es-pa es-pe es-pr es-sv es-us".split(),
        ".",
    ),
    **dict.fromkeys(
        "en-at en-be en-cz en-de en-dk en-es en-fi en-fr en-hu en-id en-it "
        "en-nl en-no en-pl en-pt en-ro en-se en-si en-sk en-za ar-dz ar-lb "
        "ar-ly ar-ma ar-mr ar-tn".split(),
        ",",
    ),
}


def _locale_decimal_separator(language):
    """Return a conservative decimal mark for a known language tag.

    Language tags in zPage data are BCP-47. A region that CLDR gives a
    different decimal mark from its language's default (``es-MX``, ``de-CH``,
    ``en-ZA``) is honoured; a script subtag never changes the convention.
    Unknown tags deliberately return ``None``; an ambiguous token must stay
    literal when neither the document nor its language establishes an
    interpretation.
    """
    subtags = (language or "").replace("_", "-").casefold().split("-")
    primary = subtags[0]
    region = next(
        (
            subtag for subtag in subtags[1:]
            if (len(subtag) == 2 and subtag.isalpha())
            or (len(subtag) == 3 and subtag.isdigit())
        ),
        None,
    )
    if region and f"{primary}-{region}" in _REGIONAL_DECIMAL_SEPARATORS:
        return _REGIONAL_DECIMAL_SEPARATORS[f"{primary}-{region}"]
    if primary in _COMMA_DECIMAL_LANGUAGES:
        return ","
    if primary in _DOT_DECIMAL_LANGUAGES:
        return "."
    return None


def _amount_tokens(text, *, language=None, exempt_code_spans=None):
    """Return ``(canonical, raw, display)`` for each prose currency amount.

    Inline code is excluded. A language locale supplies the decimal mark only
    when the document contains no unambiguous amount to establish one.

    ``exempt_code_spans=None`` (the SOURCE side) drops every regex code span,
    which can only remove authorization. On the TRANSLATED side pass the set
    of source spans: only a span copied verbatim from the source is skipped.
    ``_CODE_SPAN`` is a regex, not the renderer -- marked consumes a link
    title's backtick before any code span, so `` [a](#x "`") $500 `b` `` shows
    ``$500`` as prose while the regex pairs the two backticks around it. The
    module docstring  records what exempting regex "code" from a check
    cost for URLs; the same mis-pairing must not hide a changed price.
    """
    # Code spans name examples or syntax; their dollar signs are not prices
    # a reader acts on and cannot authorize an amount in prose.
    if exempt_code_spans is None:
        prose = _CODE_SPAN.sub(" ", text or "")
    else:
        prose = _CODE_SPAN.sub(
            lambda match: " " if match.group(0) in exempt_code_spans
            else match.group(0),
            text or "",
        )
    matches = list(_AMOUNT.finditer(prose))
    raw_amounts = [match.group("prefix") or match.group("suffix") for match in matches]
    decimal_separators = {
        separator
        for raw in raw_amounts
        if (separator := _amount_decimal_separator(raw)) is not None
    }
    if len(decimal_separators) == 1:
        decimal_separator = next(iter(decimal_separators))
    elif not decimal_separators:
        decimal_separator = _locale_decimal_separator(language)
    else:
        # Conflicting decimal evidence makes the document convention
        # unreliable. Only identical raw spellings can authorize an
        # otherwise ambiguous amount below.
        decimal_separator = None

    result = []
    for match, raw in zip(matches, raw_amounts):
        result.append((
            _canonical_amount(raw, decimal_separator=decimal_separator),
            re.sub(r"[\s\u00a0\u202f]", "", raw),
            match.group(0).strip(),
        ))
    return result


def extract_amounts(text, *, language=None):
    """Return comparable `$` amounts, normalizing only unambiguous values.

    A value such as ``$1.432,60`` and ``$1,432.60`` has an unambiguous
    grouping/decimal interpretation and gets the same canonical key. An
    amount with just one separator and three trailing digits is ambiguous on
    its own, so infer its separator convention from another unambiguous
    amount in the document, then from its language locale. When a spelling
    remains ambiguous or malformed, retain its literal numeric spelling
    (apart from harmless whitespace) so it cannot authorize a changed value.
    Inline code spans are omitted because their examples cannot authorize
    changing a prose price.
    """
    return {
        canonical for canonical, _raw, _display
        in _amount_tokens(text, language=language)
    }


def _canonical_zip321_amount(value):
    """Normalize valid ZIP-321 amounts without float rounding."""
    match = re.fullmatch(r"([0-9]+)(?:\.([0-9]+))?", value)
    if not match:
        return None
    integer = match.group(1).lstrip("0") or "0"
    fraction = match.group(2) or ""
    if len(fraction) > 8:
        return None
    if len(integer) > 8 or (
        len(integer) == 8 and integer > "21000000"
    ):
        return None
    if integer == "21000000" and any(digit != "0" for digit in fraction):
        return None
    fraction = fraction.rstrip("0")
    return integer + ("." + fraction if fraction else "")


def _decode_zip321_base64url(value):
    """Decode unpadded ZIP-321 base64url, or return ``None`` if malformed."""
    if not re.fullmatch(r"[A-Za-z0-9_-]*", value) or len(value) % 4 == 1:
        return None
    padded = value + "=" * ((-len(value)) % 4)
    try:
        return base64.b64decode(padded, altchars=b"-_", validate=True)
    except (ValueError, base64.binascii.Error):
        return None


def _zip321_uri_tokens(text):
    """Exact raw ZIP-321 URI token spellings for unchanged-text comparison."""
    return Counter(
        match.group(0)
        for match in _ZIP321_URI.finditer(text or "")
    )


def _math_visible_text(body):
    """Project a bounded subset of KaTeX to displayed payment characters.

    Math whitespace is ignored; text-mode whitespace is preserved. Commands
    outside this grammar, invalid arguments and nesting over 64 levels return
    None. A caller must not treat that as proof of safe rendered text.
    """
    class UnsupportedMath(Exception):
        pass

    position = 0
    command_pattern = re.compile(r"[A-Za-z]+")
    color_pattern = re.compile(r"(?:#[a-f0-9]{3,4}|#[a-f0-9]{6}|#[a-f0-9]{8}|[a-f0-9]{6}|[a-z]+)\Z", re.I)
    dimension_pattern = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|mm|cm|in|ex|em|mu|bp|pc|dd|cc|nd|nc|sp)")
    fonts = {
        "text": "text", "textrm": "text", "textsf": "text", "texttt": "text",
        "textbf": "text", "textit": "text", "textnormal": "text",
        "mathrm": "math", "mathbf": "math", "mathit": "math",
        "mathsf": "math", "mathtt": "math", "mathnormal": "math",
        "operatorname": "math",
    }
    spaces = {"quad", "qquad", "enspace", "thinspace", "medspace", "thickspace",
              "negthinspace", "negmedspace", "negthickspace"}

    named_colors = set((
        "black silver gray grey white maroon red purple fuchsia green lime olive "
        "yellow navy blue teal aqua cyan magenta orange pink brown rebeccapurple"
    ).split())

    def color_visibility(color):
        color = color.lower()
        if color in {"inherit", "currentcolor", "unset"}:
            # KaTeX can flatten color groups into sibling spans, so CSS
            # inheritance need not match the TeX group nesting.
            raise UnsupportedMath
        if color == "transparent":
            return False
        if color in named_colors:
            return True
        if re.fullmatch(r"#[a-f0-9]{3,4}|#[a-f0-9]{6}|#[a-f0-9]{8}|[a-f0-9]{6}", color):
            return not (
                (len(color) == 5 and color[-1] == "0")
                or (len(color) == 9 and color[-2:] == "00")
            )
        # KaTeX accepts arbitrary alphabetic color names; browsers ignore
        # invalid CSS colors and inherit the parent. Do not guess that state.
        raise UnsupportedMath

    def skip_spaces():
        nonlocal position
        while position < len(body) and body[position].isspace():
            position += 1

    def raw_group():
        nonlocal position
        skip_spaces()
        if position >= len(body) or body[position] != "{":
            raise UnsupportedMath
        position += 1
        start = position
        while position < len(body) and body[position] not in "{}\\":
            position += 1
        if position >= len(body) or body[position] != "}":
            raise UnsupportedMath
        value = body[start:position]
        position += 1
        return value

    def dimension():
        nonlocal position
        skip_spaces()
        if position < len(body) and body[position] == "{":
            if not dimension_pattern.fullmatch(raw_group().strip()):
                raise UnsupportedMath
        else:
            match = dimension_pattern.match(body, position)
            if not match:
                raise UnsupportedMath
            position = match.end()

    def group(mode, depth, visible):
        nonlocal position
        skip_spaces()
        if position >= len(body) or body[position] != "{":
            raise UnsupportedMath
        position += 1
        return parse(mode, depth + 1, grouped=True, visible=visible)

    def parse(mode, depth, *, grouped=False, visible=True):
        nonlocal position
        if depth > 64:
            raise UnsupportedMath
        out = []
        while position < len(body):
            projected_child = False
            char = body[position]
            position += 1
            if char == "}":
                if not grouped:
                    raise UnsupportedMath
                return "".join(out)
            if char == "{":
                value = parse(mode, depth + 1, grouped=True, visible=visible)
                projected_child = True
            elif char == "%":
                while position < len(body) and body[position] != "\n":
                    position += 1
                continue
            elif char == "\\":
                if position >= len(body):
                    raise UnsupportedMath
                match = command_pattern.match(body, position)
                if not match:
                    escaped = body[position]
                    position += 1
                    if escaped in ",;!:>":
                        value = ""
                    elif escaped in " {}%_#$&":
                        value = escaped
                    else:
                        raise UnsupportedMath
                else:
                    command = match.group(0)
                    position += len(command)
                    # Text-mode command legality and control-word whitespace
                    # differ from math mode. Preserve only literal text and
                    # escaped punctuation instead of guessing a nested lexer.
                    if mode == "text":
                        raise UnsupportedMath
                    if command in fonts:
                        value = group(fonts[command], depth, visible)
                        projected_child = True
                    elif command in {"color", "textcolor", "colorbox", "fcolorbox"}:
                        colors = [raw_group() for _ in range(2 if command == "fcolorbox" else 1)]
                        if not all(color_pattern.fullmatch(color) for color in colors):
                            raise UnsupportedMath
                        color_states = [color_visibility(color) for color in colors]
                        if command == "color":
                            visible = color_states[0]
                            continue
                        child_visible = (
                            color_states[0] if command == "textcolor" else visible
                        )
                        value = group("text" if command.endswith("box") else mode, depth, child_visible)
                        projected_child = True
                    elif command in {"phantom", "hphantom", "vphantom"}:
                        group(mode, depth, False)
                        value = ""
                    elif command in {"hspace", "kern", "mkern", "mskip", "hskip", "mspace"}:
                        dimension()
                        value = ""
                    elif command == "rule":
                        dimension()
                        dimension()
                        value = ""
                    elif command == "raisebox":
                        dimension()
                        value = group("text", depth, visible)
                        projected_child = True
                    elif command in spaces:
                        value = ""
                    else:
                        raise UnsupportedMath
            elif char in "#$&" or (mode == "text" and char in "^_"):
                raise UnsupportedMath
            elif char in "^_":
                # Script attachment and duplicate-script errors depend on the
                # preceding TeX atom. Do not authorize a flattened guess.
                raise UnsupportedMath
            elif char.isspace():
                value = char if mode == "text" else ""
            elif char == "~":
                value = " "
            else:
                value = char
            if visible or projected_child:
                out.append(value)
        if grouped:
            raise UnsupportedMath
        return "".join(out)

    try:
        return parse("math", 0)
    except UnsupportedMath:
        return None


def _math_body(segment):
    if segment.startswith((r"\(", r"\[")):
        return segment[2:].rstrip()[0:-2]
    if segment.startswith("$$"):
        return segment[2:].rstrip()[0:-2]
    return segment


def _markdown_quote_content(line):
    """Strip explicit blockquote prefixes and return their nesting depth."""
    cursor = 0
    depth = 0
    pattern = re.compile(r" {0,3}>[ \t]?")
    while cursor < len(line):
        match = pattern.match(line, cursor)
        if not match:
            break
        cursor = match.end()
        depth += 1
    return line[cursor:], depth


def _markdown_container_content(line):
    """Strip explicit quote/list prefixes for conservative block recognition."""
    content, _depth = _markdown_quote_content(line)
    cursor = 0
    pattern = re.compile(
        r" {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?P<padding>[ \t]+)"
    )
    while cursor < len(content):
        match = pattern.match(content, cursor)
        if not match:
            break
        padding = match.group("padding")
        if ("\t" in padding and padding != "\t") or (
            "\t" not in padding and len(padding) > 4
        ):
            # Marked consumes one column of padding and leaves the rest as
            # item content. Four residual columns start an indented code block;
            # keep those columns so reference parsing cannot hide its URI.
            residual = 4 if "\t" in padding else len(padding) - 1
            return content[:match.start()] + " " * residual + content[match.end():]
        cursor = match.end()
    return content[cursor:]


def _markdown_lines(value, *, keepends=True):
    """Split only on Markdown line endings, not Unicode line separators."""
    if not value:
        return []
    lines = re.findall(r"[^\r\n]*(?:\r\n|\r|\n|$)", value)
    if lines and lines[-1] == "":
        lines.pop()
    if keepends:
        return lines
    return [line.rstrip("\r\n") for line in lines]


def _fenced_markdown_ranges(value):
    """Conservative top-level fenced block ranges, including unclosed blocks."""
    ranges = []
    offset = 0
    opener = None
    for line in _markdown_lines(value):
        content = line.rstrip("\r\n")
        if opener is None:
            match = re.match(
                r" {0,3}(`{3,}|~{3,})(.*)$", _markdown_container_content(content),
            )
            if match and not (match.group(1).startswith("`") and "`" in match.group(2)):
                opener = (match.group(1)[0], len(match.group(1)), offset)
        else:
            marker = re.match(r" {0,3}(`+|~+)[ \t]*$", content)
            if (
                marker
                and marker.group(1)[0] == opener[0]
                and len(marker.group(1)) >= opener[1]
            ):
                ranges.append((opener[2], offset + len(line)))
                opener = None
        offset += len(line)
    if opener is not None:
        ranges.append((opener[2], len(value)))
    return ranges


def _indented_markdown_ranges(value):
    """Conservative indented blocks starting after a paragraph boundary."""
    ranges = []
    start = None
    offset = 0
    paragraph_open = False
    for line in _markdown_lines(value):
        blank = not line.strip(" \t\r\n")
        indented = line.startswith(("    ", "\t"))
        if start is not None:
            if blank or indented:
                offset += len(line)
                continue
            ranges.append((start, offset))
            start = None
        if indented and not paragraph_open:
            start = offset
        paragraph_open = not blank and start is None
        offset += len(line)
    if start is not None:
        ranges.append((start, len(value)))
    return ranges


def _literal_block_ranges(value):
    merged = []
    for start, end in sorted(_fenced_markdown_ranges(value) + _indented_markdown_ranges(value)):
        if merged and merged[-1][1] >= start:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _mask_unchanged_math_contexts(source, translated):
    """Allow unsupported math only in an identical, isolated plain paragraph.

    An inline expression copied into translated prose has changed context and
    must use the supported projector. Code, HTML, links, tables and nested
    block syntax cannot provide this exception. No math evaluation occurs.
    """
    if "<" in source or "<" in translated:
        return translated

    def paragraphs(value):
        cursor = 0
        for match in re.finditer(r"\r?\n[ \t]*\r?\n", value):
            yield cursor, match.start()
            cursor = match.end()
        yield cursor, len(value)

    def candidates(value):
        blocks = _literal_block_ranges(value)
        block_index = 0
        for start, end in paragraphs(value):
            while block_index < len(blocks) and blocks[block_index][1] <= start:
                block_index += 1
            if block_index < len(blocks) and blocks[block_index][0] < end:
                continue
            fragment = value[start:end]
            math = _markdown_math_ranges(fragment)
            if not math:
                continue
            outside = list(fragment)
            for a, b in math:
                outside[a:b] = " " * (b - a)
            outside = "".join(outside)
            if any(char in outside for char in "[]|`<>"):
                continue
            if re.search(r"(?m)^(?:[ \t]+\S|[-+*] |[0-9]+[.)] )", outside):
                continue
            yield fragment, start, end

    available = Counter(fragment for fragment, _a, _b in candidates(source))
    chars = list(translated)
    for fragment, start, end in candidates(translated):
        if available[fragment]:
            available[fragment] -= 1
            chars[start:end] = " " * (end - start)
    return "".join(chars)


def _strip_math_command_names(text):
    """Project supported math; preserve unsupported syntax without authorizing it."""
    value = text or ""
    math_ranges = _markdown_math_ranges(value)
    if not math_ranges:
        return value
    parts = []
    cursor = 0
    for start, end in math_ranges:
        parts.append(value[cursor:start])
        segment = value[start:end]
        projected = _math_visible_text(_math_body(segment))
        parts.append(segment if projected is None else projected)
        cursor = end
    parts.append(value[cursor:])
    return "".join(parts)


def _source_math_authorization_views(text, *, protected_ranges=()):
    """Exclude raw math metadata; admit only supported visible math characters.

    Projected characters are not Markdown source: a literal math asterisk
    must not become an emphasis delimiter. Outside chunks may be normalized
    independently; uncertain markup crossing math boundaries under-authorizes.
    """
    value = text or ""
    protected_ranges = sorted(protected_ranges)
    protected_index = 0
    ranges = []
    for start, end in sorted(_markdown_math_ranges(value)):
        while protected_index < len(protected_ranges) and protected_ranges[protected_index][1] <= start:
            protected_index += 1
        if (
            protected_index < len(protected_ranges)
            and protected_ranges[protected_index][0] <= start
            and end <= protected_ranges[protected_index][1]
        ):
            continue
        if ranges and ranges[-1][1] > start:
            previous_start, previous_end, _ambiguous = ranges[-1]
            ranges[-1] = (previous_start, max(previous_end, end), True)
        else:
            ranges.append((start, end, False))
    if not ranges:
        return value, ()
    masked = list(value)
    raw_parts = []
    visible_parts = []
    cursor = 0
    for start, end, ambiguous in ranges:
        outside = value[cursor:start]
        raw_parts.append(outside)
        visible_parts.append(_visible_markdown_text(
            outside,
            matched_delimiters=_matched_markdown_delimiters(outside, strict_emphasis=True),
        ))
        projected = None if ambiguous else _math_visible_text(_math_body(value[start:end]))
        # A whitespace mask would turn amount=1\(00\) into an authorized
        # amount=1 prefix. Keep intersecting raw tokens explicitly invalid.
        projected = "\ufffd" if projected is None else projected
        raw_parts.append(projected)
        visible_parts.append(projected)
        masked[start:end] = "\ufffd" * (end - start)
        cursor = end
    outside = value[cursor:]
    raw_parts.append(outside)
    visible_parts.append(_visible_markdown_text(
        outside,
        matched_delimiters=_matched_markdown_delimiters(outside, strict_emphasis=True),
    ))
    return "".join(masked), ("".join(raw_parts), "".join(visible_parts))


def _zip321_amounts(
    text, *, include_rendered_views=True, source_authorization=False,
):
    """Return payment tuples; source authorization requires valid unique fields."""
    payments = Counter()
    # Markdown can make a URI parameter visible after rendering even when the
    # raw spelling does not match (for example ``amou**nt**`` or ``amou&;``).
    # Compare the raw URI and conservative rendered-text views. The Markdown
    # flattener removes only delimiters it can pair, so a literal unmatched
    # character such as ``amount=1*00`` cannot authorize ``amount=100``.
    # Max-union keeps one payment from being counted more than once per view.
    views = [text or ""]
    source_code_spans = (
        _matched_markdown_delimiters(text or "")[1]
        if source_authorization else ()
    )
    source_hidden_reference_ranges = (
        _reference_definition_target_ranges(text or "", titles_only=True)
        if source_authorization else ()
    )
    if source_authorization and source_code_spans:
        raw_chars = list(views[0])
        for opening, closing, delimiter_length in source_code_spans:
            for offset in range(delimiter_length):
                raw_chars[opening + offset] = " "
                raw_chars[closing + offset] = " "
        views[0] = "".join(raw_chars)
    if source_authorization and source_hidden_reference_ranges:
        raw_chars = list(views[0])
        for start, end in source_hidden_reference_ranges:
            raw_chars[start:end] = "\ufffd" * (end - start)
        views[0] = "".join(raw_chars)
    rendered_source = text or ""
    if source_authorization:
        literal_ranges = _literal_block_ranges(rendered_source)
        literal_ranges.extend(source_hidden_reference_ranges)
        literal_ranges.extend(
            (opening, closing + length)
            for opening, closing, length in source_code_spans
        )
        rendered_chars = list(rendered_source)
        cursor = 0
        for start, end in sorted(literal_ranges):
            start = max(start, cursor)
            if end > start:
                rendered_chars[start:end] = " " * (end - start)
                cursor = end
        rendered_source = "".join(rendered_chars)
        views[0], _raw_math_views = _source_math_authorization_views(
            views[0], protected_ranges=literal_ranges,
        )
        rendered_source, source_math_views = _source_math_authorization_views(rendered_source)
        views.extend(source_math_views)
    if include_rendered_views:
        matched_delimiters = _matched_markdown_delimiters(rendered_source)
        views.extend((
            _visible_markdown_text(
                rendered_source, matched_delimiters=matched_delimiters,
            ),
            _visible_markdown_text(
                rendered_source, skip_link_targets=False,
                matched_delimiters=matched_delimiters,
            ),
            _strip_math_command_names(rendered_source),
        ))
    for view_index, view in enumerate(views):
        found_in_view = Counter()
        code_span_index = 0
        for uri_match in _ZIP321_URI.finditer(view):
            if view_index == 0:
                while (
                    code_span_index < len(source_code_spans)
                    and source_code_spans[code_span_index][1] <= uri_match.start()
                ):
                    code_span_index += 1
            inside_literal_code = (
                view_index == 0
                and code_span_index < len(source_code_spans)
                and source_code_spans[code_span_index][0]
                + source_code_spans[code_span_index][2] <= uri_match.start()
                < source_code_spans[code_span_index][1]
            )
            trailing_noise = "" if inside_literal_code else (
                _ZIP321_SOURCE_TRAILING_NOISE
                    if source_authorization else _ZIP321_OUTPUT_TRAILING_NOISE
            )
            uri = uri_match.group(0).rstrip(trailing_noise)
            if source_authorization and "\ufffd" in uri:
                continue
            if "?" not in uri:
                continue
            recipient = uri.split("?", 1)[0][len("zcash:"):]
            addresses = {"": recipient} if recipient else {}
            seen_parameters = {"address"} if recipient else set()
            duplicate_parameters = False
            valid_uri = True
            non_address_indexes = set()
            indexed_amounts = []
            indexed_assets = []
            req_asset_indexes = set()
            memo_indexes = set()
            for parameter in uri.split("?", 1)[1].split("&"):
                key, separator, value = parameter.partition("=")
                if not separator:
                    if not parameter:
                        continue
                    key_match = re.fullmatch(
                        r"([A-Za-z][A-Za-z0-9+-]*)(?:\.([0-9]+))?", key
                    )
                    if key_match is None:
                        valid_uri = False
                        continue
                    parameter_name = key_match.group(1).casefold()
                    index = key_match.group(2) or ""
                    if index and (index.startswith("0") or len(index) > 4):
                        valid_uri = False
                    normalized_key = key.casefold()
                    if normalized_key in seen_parameters:
                        duplicate_parameters = True
                    seen_parameters.add(normalized_key)
                    non_address_indexes.add(index)
                    if parameter_name in {"address", "amount", "req-asset", "memo"}:
                        valid_uri = False
                    if parameter_name.startswith("req-"):
                        valid_uri = False
                    continue
                key_match = re.fullmatch(
                    r"([A-Za-z][A-Za-z0-9+-]*)(?:\.([0-9]+))?", key
                )
                if key_match is None:
                    valid_uri = False
                    continue
                parameter_name = key_match.group(1).casefold()
                index = key_match.group(2) or ""
                if index and (index.startswith("0") or len(index) > 4):
                    valid_uri = False
                normalized_key = key.casefold()
                if normalized_key in seen_parameters:
                    duplicate_parameters = True
                seen_parameters.add(normalized_key)
                address_match = re.fullmatch(
                    r"address(?:\.([1-9][0-9]{0,3}))?", key, re.IGNORECASE
                )
                if address_match:
                    index = address_match.group(1) or ""
                    if index in addresses:
                        duplicate_parameters = True
                    addresses[index] = value
                    if not re.fullmatch(r"[A-Za-z0-9]+", value):
                        valid_uri = False
                    continue
                non_address_indexes.add(index)
                asset_match = re.fullmatch(
                    r"req-asset(?:\.([1-9][0-9]{0,3}))?", key, re.IGNORECASE
                )
                if asset_match:
                    asset_index = asset_match.group(1) or ""
                    req_asset_indexes.add(asset_index)
                    asset_payload = _decode_zip321_base64url(value)
                    if (
                        asset_payload is None
                        or len(asset_payload) != 75
                        or asset_payload[0] != 0
                    ):
                        valid_uri = False
                    else:
                        indexed_assets.append((asset_index, asset_payload))
                    continue
                if parameter_name.startswith("req-"):
                    valid_uri = False
                    continue
                memo_match = re.fullmatch(
                    r"memo(?:\.([1-9][0-9]{0,3}))?", key, re.IGNORECASE
                )
                if memo_match:
                    memo_index = memo_match.group(1) or ""
                    memo_indexes.add(memo_index)
                    memo_payload = _decode_zip321_base64url(value)
                    if memo_payload is None or len(memo_payload) > 512:
                        valid_uri = False
                    continue
                amount_match = re.fullmatch(
                    r"amount(?:\.([1-9][0-9]{0,3}))?", key, re.IGNORECASE
                )
                if amount_match:
                    index = amount_match.group(1) or ""
                    canonical_amount = _canonical_zip321_amount(value)
                    if canonical_amount is None:
                        valid_uri = False
                    indexed_amounts.append((index, value, canonical_amount))
                elif parameter_name not in {"address", "amount"}:
                    if not _ZIP321_QCHAR_VALUE.fullmatch(value):
                        valid_uri = False

            if any(
                index not in addresses or not addresses[index]
                for index in non_address_indexes
            ):
                valid_uri = False
            if any(
                not _valid_zcash_candidate(address)
                or address.casefold().startswith("zc")
                for address in addresses.values()
            ):
                valid_uri = False
            if any(
                index in addresses
                and addresses[index].casefold().startswith(("t1", "t3"))
                for index in memo_indexes
            ):
                valid_uri = False
            if req_asset_indexes.intersection(
                index for index, _value, _amount in indexed_amounts
            ):
                valid_uri = False

            for index, raw_amount, amount in indexed_amounts:
                address = addresses.get(index, "")
                valid_payment = (
                    valid_uri
                    and not duplicate_parameters
                    and index in addresses
                    and bool(address)
                    and index not in req_asset_indexes
                    and amount is not None
                )
                if source_authorization and not valid_payment:
                    continue
                if amount is None:
                    amount = "invalid:" + raw_amount
                elif duplicate_parameters or index not in addresses or index in req_asset_indexes:
                    amount = "invalid:" + amount
                # Bech32 accepts one case throughout an address; Base58 is
                # case-sensitive, so preserve its spelling when pairing payments.
                if address.casefold().startswith(("u1", "zs1", "tex1")):
                    address = address.lower()
                found_in_view[(index, address, amount)] += 1
            for index, asset_payload in indexed_assets:
                address = addresses.get(index, "")
                valid_payment = (
                    valid_uri
                    and not duplicate_parameters
                    and index in addresses
                    and bool(address)
                    and index in req_asset_indexes
                    and not any(amount_index == index for amount_index, _, _ in indexed_amounts)
                )
                if source_authorization and not valid_payment:
                    continue
                if address.casefold().startswith(("u1", "zs1", "tex1")):
                    address = address.lower()
                # ZIP-321 v0 carries an unsigned 64-bit little-endian amount
                # followed by the 66-byte asset identifier.
                custom_amount = (
                    f"asset:{asset_payload[9:].hex()}:"
                    f"{int.from_bytes(asset_payload[1:9], 'little')}"
                )
                found_in_view[(index, address, custom_amount)] += 1
        payments |= found_in_view
    valid_payments = {
        (index, address)
        for index, address, amount in payments
        if not amount.startswith("invalid:")
    }
    payments = Counter({
        (index, address, amount): count
        for (index, address, amount), count in payments.items()
        if not amount.startswith("invalid:") or (index, address) not in valid_payments
    })
    return payments


def _reference_link_suffixes(markdown):
    """Offsets after resolved full, collapsed, and shortcut reference links."""
    source = markdown or ""

    def normalize(value):
        return re.sub(r"\s+", " ", value).strip().casefold()

    definition_matches = list(re.finditer(
        r"(?m)^[ \t]{0,3}\[([^\[\]\n]+)\]:[ \t]*(?:<[^>\n]*>|[^ \t\n]+)",
        source,
    ))
    definitions = {normalize(match.group(1)) for match in definition_matches}
    definition_closers = {match.end(1) for match in definition_matches}
    suffixes = {}
    for match in re.finditer(
        r"\[([^\[\]\n]+)\][ \t]{0,3}\[([^\[\]\n]*)\]", source
    ):
        reference = normalize(match.group(2)) or normalize(match.group(1))
        if reference in definitions:
            closing = match.start() + len(match.group(1)) + 1
            suffixes[closing] = match.end()
    # Shortcut references use only ``[label]`` when a matching definition
    # exists. Keep their label visible while dropping the Markdown brackets.
    for match in re.finditer(r"\[([^\[\]\n]+)\]", source):
        closing = match.end() - 1
        if normalize(match.group(1)) not in definitions or closing in suffixes:
            continue
        if closing in definition_closers:
            continue
        suffixes[closing] = match.end()
    return suffixes


def _inline_link_target_ranges(source):
    """Ranges of balanced inline link destinations and optional titles."""
    ranges = []
    bracket_stack = []
    i = 0
    while i < len(source):
        char = source[i]
        if (
            char == "\\"
            and i + 1 < len(source)
            and source[i + 1] in string.punctuation
        ):
            i += 2
            continue
        if char == "[":
            bracket_stack.append(i)
            i += 1
            continue
        if char != "]" or not bracket_stack:
            i += 1
            continue
        bracket_stack.pop()
        if i + 1 >= len(source) or source[i + 1] != "(":
            i += 1
            continue
        target_start = i + 1
        cursor = i + 2
        depth = 1
        quote = None
        escaped = False
        while cursor < len(source) and depth:
            current = source[cursor]
            if escaped:
                escaped = False
            elif current == "\\":
                escaped = True
            elif quote:
                if current == quote:
                    quote = None
            elif current in {'"', "'"}:
                quote = current
            elif current == "(":
                depth += 1
            elif current == ")":
                depth -= 1
            cursor += 1
        if depth == 0:
            ranges.append((target_start, cursor))
            i = cursor
        else:
            break
    return ranges


def _reference_definition_end(line):
    """Return the definition-prefix end for a valid, single-line label."""
    opener = re.match(r" {0,3}\[(?!\^)", line)
    if opener is None:
        return None
    start = opener.end()
    cursor = start
    escaped = False
    while cursor < len(line):
        char = line[cursor]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "[":
            return None
        elif char == "]":
            label = line[start:cursor]
            if cursor == start or not any(
                char not in _MARKED_WHITESPACE for char in label
            ):
                return None
            if line[cursor + 1:cursor + 2] == ":":
                return cursor + 2
            return None
        cursor += 1
    return None


def _markdown_heading_or_thematic_break(line):
    """Whether a line is a Marked block that can end a preceding paragraph."""
    atx = re.match(r" {0,3}#{1,6}(.*)$", line)
    if atx is not None and (
        not atx.group(1) or atx.group(1)[0] in _MARKED_WHITESPACE
    ):
        return True
    return re.fullmatch(
        r" {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*",
        line,
    ) is not None


def _markdown_setext_underline(line):
    """Whether a line can close a Setext heading in the current block."""
    return re.fullmatch(r" {0,3}(?:=+|-+) *", line) is not None


def _reference_definition_target_ranges(source, *, titles_only=False):
    """Return consumed reference ranges, or only hidden title ranges."""
    value = source or ""
    ranges = []
    title_ranges = []
    # Marked parses raw HTML blocks before reference definitions. Its HTML
    # renderer escapes their contents as visible text, so definition-like
    # lines inside a block cannot provide a hidden-title exemption. Keep the
    # code masker from re-entering this parser while deriving these ranges.
    html_ranges = (
        _raw_multiline_html_ranges(
            value, include_reference_definitions=False, include_block_tags=True,
        )
        if "<" in value else ()
    )
    html_starts = [start for start, _end in html_ranges]
    literal_code_ranges = _literal_block_ranges(value)
    literal_code_starts = [start for start, _end in literal_code_ranges]
    offset = 0
    previous_line = ""
    previous_is_definition = False
    previous_line_is_html_block = False
    previous_line_ended_block = False
    list_content_indent = None
    while offset < len(value):
        code_index = bisect_right(literal_code_starts, offset) - 1
        if (
            code_index >= 0
            and offset < literal_code_ranges[code_index][1]
        ):
            # Fenced and indented blocks render their contents literally.
            # Definition-like lines inside them cannot supply a hidden-title
            # exemption; after the block, Marked starts a new block context.
            previous_line = ""
            previous_is_definition = False
            previous_line_is_html_block = False
            previous_line_ended_block = False
            list_content_indent = None
            offset = literal_code_ranges[code_index][1]
            continue
        line_end = offset
        while line_end < len(value) and value[line_end] not in "\r\n":
            line_end += 1
        raw_content = value[offset:line_end]
        quote_content, quote_depth = _markdown_quote_content(raw_content)
        list_marker = re.match(
            r" {0,3}(?:(?P<bullet>[-+*])|(?P<number>[0-9]{1,9})[.)])[ \t]+",
            quote_content,
        )
        list_item_line = list_marker is not None
        list_interrupts_paragraph = bool(
            list_marker
            and (
                list_marker.group("bullet") in {"-", "+", "*"}
                or list_marker.group("number") == "1"
            )
        )
        list_continuation = False
        if list_marker:
            content = _markdown_container_content(raw_content)
            content_base = line_end - len(content)
            list_content_indent = len(quote_content) - len(
                _markdown_container_content(quote_content)
            )
        elif list_content_indent is not None and (
            not quote_content.strip(" \t")
            or quote_content.startswith(" " * list_content_indent)
            or quote_content.startswith("\t")
        ):
            list_continuation = bool(quote_content.strip(" \t"))
            continued_content = quote_content[list_content_indent:]
            nested_marker = re.match(
                r" {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+",
                continued_content,
            )
            list_prefix = list_content_indent
            if nested_marker:
                list_content_indent += nested_marker.end()
            content = _markdown_container_content(continued_content)
            content_base = (
                offset + len(raw_content) - len(quote_content)
                + list_prefix + len(continued_content) - len(content)
            )
        else:
            list_content_indent = None
            content = _markdown_container_content(raw_content)
            content_base = line_end - len(content)
        title_quote_depth = quote_depth
        title_list_indent = (
            list_content_indent if list_item_line or list_continuation else None
        )
        html_index = bisect_right(html_starts, line_end) - 1
        if (
            html_index >= 0
            and html_ranges[html_index][0] < line_end
            and html_ranges[html_index][1] > offset
        ):
            previous_line = content
            previous_is_definition = False
            previous_line_is_html_block = (
                html_ranges[html_index][0] >= offset
                and html_ranges[html_index][1] <= line_end
            )
            previous_line_ended_block = False
            offset = line_end
            if offset < len(value):
                offset += 2 if value.startswith("\r\n", offset) else 1
            continue
        definition_end = _reference_definition_end(content)
        setext_heading_end = bool(
            previous_line.strip(" \t")
            and _markdown_setext_underline(content)
        )
        current_is_definition = False
        consumed_line_end = line_end
        if definition_end is not None and (
            offset == 0
            or not previous_line.strip(" \t")
            or previous_is_definition
            or previous_line_ended_block
            or list_interrupts_paragraph
            or (list_continuation and previous_line_is_html_block)
        ):
            cursor = definition_end
            while cursor < len(content) and content[cursor] == " ":
                cursor += 1

            definition_content = content
            definition_content_base = content_base
            definition_line_end = line_end
            if cursor == len(content) and line_end < len(value):
                destination_line_start = line_end + (
                    2 if value.startswith("\r\n", line_end) else 1
                )
                destination_line_end = destination_line_start
                while (
                    destination_line_end < len(value)
                    and value[destination_line_end] not in "\r\n"
                ):
                    destination_line_end += 1
                destination_raw = value[
                    destination_line_start:destination_line_end
                ]
                destination_quote, destination_quote_depth = (
                    _markdown_quote_content(destination_raw)
                )
                destination_list_marker = re.match(
                    r" {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+",
                    destination_quote,
                )
                destination_content = _markdown_container_content(
                    destination_raw
                )
                destination_content_indent = len(destination_content) - len(
                    destination_content.lstrip(" \t")
                )
                destination_indent = len(destination_quote) - len(
                    destination_quote.lstrip(" \t")
                )
                if (
                    destination_content_indent < len(destination_content)
                    and destination_quote_depth == title_quote_depth
                    and destination_list_marker is None
                    and (
                        title_list_indent is None
                        or destination_indent >= title_list_indent
                    )
                ):
                    definition_content = destination_content[
                        destination_content_indent:
                    ]
                    definition_content_base = (
                        destination_line_end - len(destination_content)
                        + destination_content_indent
                    )
                    definition_line_end = destination_line_end
                    cursor = 0
                    consumed_line_end = destination_line_end

            if cursor < len(definition_content) and definition_content[cursor] == "<":
                cursor += 1
                while cursor < len(definition_content):
                    if (
                        value[definition_content_base + cursor] == "\\"
                        and definition_content_base + cursor + 1 < definition_line_end
                        and value[definition_content_base + cursor + 1] in string.punctuation
                    ):
                        cursor += 2
                    elif value[definition_content_base + cursor] == ">":
                        cursor += 1
                        break
                    else:
                        cursor += 1
                else:
                    previous_line = content
                    previous_is_definition = False
                    offset = line_end
                    if offset < len(value):
                        offset += 2 if value.startswith("\r\n", offset) else 1
                    continue
            else:
                destination_start = cursor
                while (
                    cursor < len(definition_content)
                    and definition_content[cursor] not in _MARKED_WHITESPACE
                ):
                    cursor += 1
                # Marked's destination token ends at ECMAScript ``\s``, but
                # its optional-title separator accepts literal spaces only.
                # A Unicode whitespace boundary therefore makes the entire
                # definition ordinary text; do not mask a title that follows
                # it. Tabs are also not valid separators for a title.
                if (
                    cursor == destination_start
                    or (
                        cursor < len(definition_content)
                        and definition_content[cursor] not in " \t"
                    )
                ):
                    previous_line = content
                    previous_is_definition = False
                    offset = line_end
                    if offset < len(value):
                        offset += 2 if value.startswith("\r\n", offset) else 1
                    continue

            destination_end = cursor
            separator_end = cursor
            while (
                separator_end < len(definition_content)
                and definition_content[separator_end] == " "
            ):
                separator_end += 1
            title_start = definition_content_base + separator_end
            title_line_end = definition_line_end
            if separator_end == len(definition_content) and definition_line_end < len(value):
                newline_end = definition_line_end + (
                    2 if value.startswith("\r\n", definition_line_end) else 1
                )
                next_line_end = newline_end
                while next_line_end < len(value) and value[next_line_end] not in "\r\n":
                    next_line_end += 1
                next_raw_content = value[newline_end:next_line_end]
                next_quote_content, next_quote_depth = _markdown_quote_content(
                    next_raw_content
                )
                next_list_marker = re.match(
                    r" {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+",
                    next_quote_content,
                )
                next_content = _markdown_container_content(next_raw_content)
                title_indent = len(next_content) - len(next_content.lstrip(" \t"))
                next_title_start = next_line_end - len(next_content) + title_indent
                if (
                    # Marked consumes a following title at any indentation,
                    # including indentation that would start code elsewhere.
                    next_title_start < next_line_end
                    and value[next_title_start] in {'"', "'", "("}
                    and next_quote_depth == title_quote_depth
                    and next_list_marker is None
                    and (
                        title_list_indent is None
                        or len(next_quote_content)
                        - len(next_quote_content.lstrip(" \t"))
                        >= title_list_indent
                    )
                ):
                    title_start = next_title_start
                    title_line_end = next_line_end

            target_end = definition_content_base + destination_end
            if (
                title_start < title_line_end
                and title_start > definition_content_base + destination_end
            ):
                opener = value[title_start]
                if opener in {'"', "'", "("}:
                    closer = ")" if opener == "(" else opener
                    cursor_abs = title_start + 1
                    title_end = None
                    malformed = False
                    while cursor_abs < len(value):
                        char = value[cursor_abs]
                        if char in "\r\n":
                            cursor_abs += 2 if value.startswith("\r\n", cursor_abs) else 1
                            next_line_end = cursor_abs
                            while next_line_end < len(value) and value[next_line_end] not in "\r\n":
                                next_line_end += 1
                            next_raw_content = value[cursor_abs:next_line_end]
                            next_quote_content, next_quote_depth = (
                                _markdown_quote_content(next_raw_content)
                            )
                            next_content = _markdown_container_content(
                                next_raw_content
                            )
                            next_indent = len(next_quote_content) - len(
                                next_quote_content.lstrip(" \t")
                            )
                            if (
                                not next_content.strip(" \t")
                                or next_quote_depth != title_quote_depth
                                or (
                                    title_list_indent is not None
                                    and next_indent < title_list_indent
                                )
                            ):
                                malformed = True
                                break
                            continue
                        if char == "\\" and cursor_abs + 1 < len(value):
                            if (
                                opener == '"'
                                and value[cursor_abs + 1] in string.punctuation
                            ):
                                cursor_abs += 2
                                continue
                        if opener == "(" and char == "(":
                            malformed = True
                            break
                        if char == closer:
                            title_end = cursor_abs + 1
                            break
                        cursor_abs += 1
                    if title_end is not None and not malformed:
                        tail_end = title_end
                        # Marked's reference-definition rule permits only
                        # literal spaces after a title. A trailing tab makes
                        # the whole definition ordinary paragraph text, so it
                        # must not be treated as a hidden title here.
                        while tail_end < len(value) and value[tail_end] == " ":
                            tail_end += 1
                        title_tail_line_end = tail_end
                        while title_tail_line_end < len(value) and value[title_tail_line_end] not in "\r\n":
                            title_tail_line_end += 1
                        if tail_end == title_tail_line_end:
                            target_end = title_end
                            title_ranges.append((title_start, title_end))
                            # A multiline title can contain text that looks
                            # like another definition. Skip its consumed lines
                            # so their contents cannot create overlapping,
                            # false hidden-title ranges.
                            consumed_line_end = max(
                                consumed_line_end, title_tail_line_end,
                            )
                        else:
                            target_end = None
                    else:
                        target_end = None
                else:
                    target_end = None
            elif separator_end != len(definition_content):
                target_end = None

            if target_end is not None:
                ranges.append((content_base + definition_end, target_end))
                current_is_definition = True

        previous_line = content
        previous_is_definition = current_is_definition
        previous_line_is_html_block = False
        previous_line_ended_block = (
            not current_is_definition
            and (
                setext_heading_end
                or _markdown_heading_or_thematic_break(content)
            )
        )
        offset = consumed_line_end
        if offset < len(value):
            offset += 2 if value.startswith("\r\n", offset) else 1
    return title_ranges if titles_only else ranges


def _markdown_inline_code_spans(source):
    """Pair code spans in renderer order, consuming inner ticks as literals."""
    value = source or ""
    ignored_ranges = sorted(
        _inline_link_target_ranges(value)
        + _reference_definition_target_ranges(value)
        + _markdown_math_ranges(value)
    )
    merged_ignored = []
    for start, end in ignored_ranges:
        if merged_ignored and merged_ignored[-1][1] >= start:
            merged_ignored[-1] = (
                merged_ignored[-1][0], max(merged_ignored[-1][1], end),
            )
        else:
            merged_ignored.append((start, end))

    runs = []
    cursor = 0
    ignored_index = 0
    while cursor < len(value):
        while (
            ignored_index < len(merged_ignored)
            and merged_ignored[ignored_index][1] <= cursor
        ):
            ignored_index += 1
        if (
            ignored_index < len(merged_ignored)
            and merged_ignored[ignored_index][0] <= cursor
            < merged_ignored[ignored_index][1]
        ):
            cursor = merged_ignored[ignored_index][1]
            continue
        if value[cursor] != "`":
            cursor += 1
            continue
        end = cursor + 1
        while end < len(value) and value[end] == "`":
            end += 1
        backslash_start = cursor
        while backslash_start > 0 and value[backslash_start - 1] == "\\":
            backslash_start -= 1
        escaped = (cursor - backslash_start) % 2
        runs.append((cursor, end, end - cursor, escaped))
        cursor = end

    next_equal = [None] * len(runs)
    next_by_length = {}
    for index in range(len(runs) - 1, -1, -1):
        length = runs[index][2]
        next_equal[index] = next_by_length.get(length)
        next_by_length[length] = index

    spans = []
    index = 0
    while index < len(runs):
        if runs[index][3]:
            index += 1
            continue
        closing_index = next_equal[index]
        if closing_index is None:
            index += 1
            continue
        spans.append((runs[index][0], runs[closing_index][0], runs[index][2]))
        index = closing_index + 1
    return spans


def _matched_markdown_delimiters(source, *, strict_emphasis=False):
    """Paired marker offsets and literal code-span bounds in inline Markdown."""
    pairs = set()
    code_spans = []
    code_openings = {}
    target_ranges = sorted(
        _inline_link_target_ranges(source)
        + _reference_definition_target_ranges(source)
    )
    target_range_index = 0
    math_ranges = _markdown_math_ranges(source)
    math_range_index = 0
    i = 0
    while i < len(source):
        while (
            target_range_index < len(target_ranges)
            and target_ranges[target_range_index][1] <= i
        ):
            target_range_index += 1
        if (
            target_range_index < len(target_ranges)
            and target_ranges[target_range_index][0] <= i
            < target_ranges[target_range_index][1]
        ):
            i = target_ranges[target_range_index][1]
            target_range_index += 1
            continue
        while math_range_index < len(math_ranges) and math_ranges[math_range_index][1] <= i:
            math_range_index += 1
        if (
            math_range_index < len(math_ranges)
            and math_ranges[math_range_index][0] <= i
            < math_ranges[math_range_index][1]
        ):
            i = math_ranges[math_range_index][1]
            math_range_index += 1
            continue
        char = source[i]
        if (
            char == "\\"
            and i + 1 < len(source)
            and source[i + 1] in string.punctuation
        ):
            i += 2
            continue
        if char != "`":
            i += 1
            continue
        end = i + 1
        while end < len(source) and source[end] == "`":
            end += 1
        delimiter = source[i:end]
        stack = code_openings.setdefault(delimiter, [])
        if stack:
            opening = stack.pop()
            pairs.update(range(opening, opening + len(delimiter)))
            pairs.update(range(i, end))
            code_spans.append((opening, i, len(delimiter)))
        else:
            stack.append(i)
        i = end

    code_spans.sort()
    openings = {}
    paragraph_breaks = [
        match.end() for match in re.finditer(r"\r?\n[ \t]*\r?\n", source)
    ]
    paragraph_break_index = 0
    i = 0
    code_span_index = 0
    while i < len(source):
        while (
            paragraph_break_index < len(paragraph_breaks)
            and paragraph_breaks[paragraph_break_index] <= i
        ):
            # Inline emphasis cannot start in one paragraph and close in the
            # next. Keeping these openings lets malformed source authorize a
            # complete destination that the Markdown renderer does not show.
            openings.clear()
            paragraph_break_index += 1
        while (
            code_span_index < len(code_spans)
            and code_spans[code_span_index][1] + code_spans[code_span_index][2] <= i
        ):
            code_span_index += 1
        if (
            code_span_index < len(code_spans)
            and code_spans[code_span_index][0] <= i
            < code_spans[code_span_index][1] + code_spans[code_span_index][2]
        ):
            i = code_spans[code_span_index][1] + code_spans[code_span_index][2]
            code_span_index += 1
            continue
        char = source[i]
        if (
            char == "\\"
            and i + 1 < len(source)
            and source[i + 1] in string.punctuation
        ):
            i += 2
            continue
        if char not in "*_~`":
            i += 1
            continue
        end = i + 1
        while end < len(source) and source[end] == char:
            end += 1
        delimiter_length = end - i
        if char == "~" and delimiter_length not in {1, 2}:
            i = end
            continue
        previous = source[i - 1] if i else None
        following = source[end] if end < len(source) else None
        previous_whitespace = previous is None or previous.isspace()
        following_whitespace = following is None or following.isspace()
        previous_punctuation = _is_markdown_punctuation(previous)
        following_punctuation = _is_markdown_punctuation(following)
        left_flanking = not following_whitespace and (
            not following_punctuation
            or previous_whitespace
            or previous_punctuation
        )
        right_flanking = not previous_whitespace and (
            not previous_punctuation
            or following_whitespace
            or following_punctuation
        )
        can_open = left_flanking and (
            char != "_" or not right_flanking or previous_punctuation
        )
        can_close = right_flanking and (
            char != "_" or not left_flanking or following_punctuation
        )
        stack = openings.setdefault(char, [])
        remaining = delimiter_length
        consumed = 0
        while can_close and remaining and stack:
            opening, opening_length = stack[-1]
            if strict_emphasis and opening_length != remaining:
                break
            stack.pop()
            matched = min(remaining, opening_length)
            pairs.update(range(opening + opening_length - matched, opening + opening_length))
            pairs.update(range(i + consumed, i + consumed + matched))
            remaining -= matched
            consumed += matched
            if opening_length > matched:
                stack.append((opening, opening_length - matched))
        if can_open and remaining:
            stack.append((i + consumed, remaining))
        i = end
    return pairs, code_spans


def _markdown_math_ranges(source):
    """Ranges consumed by the inline and block math render tokenizers."""
    ranges = []
    offset = 0
    block_opener = None
    block_delimiter = None
    for line in _markdown_lines(source):
        line_end = offset + len(line)
        content = line.rstrip("\r\n")
        indent = len(content) - len(content.lstrip(" "))
        marker = content[indent:]
        if block_opener is not None:
            if indent <= 3 and marker.startswith(block_delimiter):
                suffix = marker[len(block_delimiter):]
                if not suffix.strip(" \t"):
                    ranges.append((block_opener, line_end))
                    block_opener = None
                    block_delimiter = None
            offset = line_end
            continue

        if indent <= 3 and marker.startswith("$$"):
            if not marker[2:].strip(" \t") and line.endswith("\n"):
                block_opener = offset + indent
                block_delimiter = "$$"
                offset = line_end
                continue
        if indent <= 3 and marker.startswith(r"\["):
            if not marker[2:].strip(" \t") and line.endswith("\n"):
                block_opener = offset + indent
                block_delimiter = r"\]"
                offset = line_end
                continue
            closing = marker.find(r"\]", 2)
            if closing > 2 and not marker[closing + 2:].strip(" \t"):
                ranges.append((offset + indent, line_end))
                offset = line_end
                continue

        paren_open = None
        dollar_open = None
        i = 0
        while i < len(content):
            if content.startswith(r"\(", i):
                if paren_open is None:
                    paren_open = i
                i += 2
                continue
            if content.startswith(r"\)", i):
                if paren_open is not None and i > paren_open + 2:
                    ranges.append((offset + paren_open, offset + i + 2))
                paren_open = None
                i += 2
                continue
            if content.startswith("$$", i):
                run_end = i + 2
                while run_end < len(content) and content[run_end] == "$":
                    run_end += 1
                if run_end == i + 2:
                    if dollar_open is None:
                        dollar_open = i
                    else:
                        value = content[dollar_open + 2:i]
                        if value and value.strip() == value:
                            ranges.append((offset + dollar_open, offset + i + 2))
                        dollar_open = None
                i = run_end
                continue
            i += 1
        offset = line_end
    return ranges

def _mask_markdown_code_contexts(source, *, include_reference_definitions=True):
    """Hide code blocks and spans before deriving source authorization views.

    Math and emphasis normalization is useful in prose, where the renderer
    removes presentation syntax. Inside Markdown code it removes literal
    punctuation instead, which must never make a source address appear
    authorized. This scanner handles fenced blocks, standalone indented code,
    and matched inline backtick spans without interpreting math first.
    """
    value = source or ""
    protected = []
    offset = 0
    fence = None
    indented_until = 0
    lines = _markdown_lines(value)

    content_after_containers = _markdown_container_content

    def indent_columns(line):
        columns = 0
        for char in line:
            if char == " ":
                columns += 1
            elif char == "\t":
                columns += 4 - columns % 4
            else:
                break
        return columns

    for index, line in enumerate(lines):
        content = line.rstrip("\r\n")
        markdown_content = content_after_containers(content)
        if fence is not None:
            protected.append((offset, offset + len(line)))
            # Inside a fence, a list/quote prefix is literal code, not a
            # closing marker. Unsupported container closes stay masked.
            marker = re.match(r" {0,3}(`+|~+)[ \t]*$", content)
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= fence[1]:
                fence = None
        else:
            opening = re.match(r" {0,3}(`{3,}|~{3,})(.*)$", markdown_content)
            if opening and not (
                opening.group(1).startswith("`") and "`" in opening.group(2)
            ):
                fence = (opening.group(1)[0], len(opening.group(1)))
                protected.append((offset, offset + len(line)))
            elif (
                index >= indented_until
                and indent_columns(markdown_content) >= 4
                and (
                    index == 0
                    or not content_after_containers(
                        lines[index - 1].rstrip("\r\n")
                    ).strip(" \t")
                )
            ):
                # A blank line or document start permits an indented code
                # block. Continue through indented lines and blank lines.
                end = offset + len(line)
                cursor = index + 1
                while cursor < len(lines):
                    next_line = lines[cursor]
                    next_content = next_line.rstrip("\r\n")
                    next_content = content_after_containers(next_content)
                    if next_content and indent_columns(next_content) < 4:
                        break
                    end += len(next_line)
                    cursor += 1
                protected.append((offset, end))
                indented_until = cursor
        offset += len(line)

    protected.sort()
    block_ranges = []
    for start, end in protected:
        if block_ranges and block_ranges[-1][1] >= start:
            block_ranges[-1] = (block_ranges[-1][0], max(block_ranges[-1][1], end))
        else:
            block_ranges.append((start, end))

    # A standalone single-line paragraph has a bounded inline context only
    # when the document contains no syntax that can reinterpret its tokens.
    # Everything else retains conservative overlapping masks. This is an
    # explicit subset, not a replacement for the renderer's block parser.
    ordinary_ranges = []
    if not any(token in value for token in (
        "<", ">", "[", "]", "|", "\\", "$", "@", "://", "www.",
    )) and not any(char.isspace() and char not in " \t\n" for char in value):
        line_offset = 0
        for index, line in enumerate(lines):
            content = line.rstrip("\r\n")
            if (
                content.strip(" \t\n")
                and (index == 0 or not lines[index - 1].strip(" \t\n"))
                and (index + 1 == len(lines) or not lines[index + 1].strip(" \t\n"))
                and not re.match(r"(?: {4}|\t| {0,3}(?:[#>*+~=-]|[0-9]+[.)]\s))", content)
            ):
                ordinary_ranges.append((line_offset, line_offset + len(line)))
            line_offset += len(line)

    def mask_inline_runs(runs, ordinary):
        next_equal = {}
        closing = {}
        for index in range(len(runs) - 1, -1, -1):
            start, end, escaped = runs[index]
            # Outside code an escaped first backtick is literal. Inside
            # code, backslashes are literal and never escape a closer.
            opening_length = end - start - escaped
            if opening_length and opening_length in next_equal:
                last = next_equal[opening_length]
                if ordinary:
                    closing[index] = last
                else:
                    protected.append((start + escaped, runs[last][1]))
            next_equal[end - start] = index
        # Consume spans only within one verified ordinary paragraph. A pair
        # from another paragraph cannot discard a real opener inside this one.
        index = 0
        while ordinary and index < len(runs):
            if index in closing:
                last = closing[index]
                protected.append((runs[index][0], runs[last][1]))
                index = last + 1
            else:
                index += 1

    cursor = 0
    block_index = 0
    ordinary_index = 0
    target_ranges = _inline_link_target_ranges(value)
    if include_reference_definitions:
        target_ranges += _reference_definition_target_ranges(value)
    target_ranges.sort()
    target_index = 0
    run_context = None
    runs = []
    while cursor < len(value):
        while block_index < len(block_ranges) and block_ranges[block_index][1] <= cursor:
            block_index += 1
        if (
            block_index < len(block_ranges)
            and block_ranges[block_index][0] <= cursor < block_ranges[block_index][1]
        ):
            mask_inline_runs(runs, run_context is not None)
            runs = []
            run_context = None
            cursor = block_ranges[block_index][1]
            continue
        while (
            target_index < len(target_ranges)
            and target_ranges[target_index][1] <= cursor
        ):
            target_index += 1
        if (
            target_index < len(target_ranges)
            and target_ranges[target_index][0] <= cursor < target_ranges[target_index][1]
        ):
            mask_inline_runs(runs, run_context is not None)
            runs = []
            run_context = None
            cursor = target_ranges[target_index][1]
            target_index += 1
            continue
        if value[cursor] != "`":
            cursor += 1
            continue
        end = cursor + 1
        while end < len(value) and value[end] == "`":
            end += 1
        backslash_start = cursor
        while backslash_start > 0 and value[backslash_start - 1] == "\\":
            backslash_start -= 1
        escaped = (cursor - backslash_start) % 2
        while ordinary_index < len(ordinary_ranges) and ordinary_ranges[ordinary_index][1] <= cursor:
            ordinary_index += 1
        context = (
            ordinary_index
            if ordinary_index < len(ordinary_ranges)
            and ordinary_ranges[ordinary_index][0] <= cursor
            else None
        )
        if context != run_context:
            mask_inline_runs(runs, run_context is not None)
            runs = []
            run_context = context
        runs.append((cursor, end, escaped))
        cursor = end
    mask_inline_runs(runs, run_context is not None)

    if not protected:
        return value
    protected.sort()
    chars = list(value)
    masked_until = 0
    for start, end in protected:
        for index in range(max(start, masked_until), end):
            if chars[index] not in "\r\n":
                chars[index] = " "
        masked_until = max(masked_until, end)
    return "".join(chars)


def _raw_multiline_html_ranges(
    source, *, include_reference_definitions=True, include_block_tags=False,
):
    """Ranges for raw HTML blocks that can continue through blank lines."""
    value = _mask_markdown_code_contexts(
        source or "",
        include_reference_definitions=include_reference_definitions,
    )
    openers = (
        (re.compile(r" {0,3}<!--"), re.compile(r"-->")),
        (re.compile(r" {0,3}<\?"), re.compile(r"\?>")),
        (re.compile(r" {0,3}<!\[CDATA\["), re.compile(r"\]\]>")),
        (re.compile(r" {0,3}<![A-Z]"), re.compile(r">")),
    )
    ranges = []
    active = None
    offset = 0
    for line in _markdown_lines(value):
        raw_content = line.rstrip("\r\n")
        content = _markdown_container_content(raw_content)
        content_base = offset + len(raw_content) - len(content)
        if active:
            if active[1] is None:
                if not content.strip(" \t"):
                    ranges.append((active[0], offset))
                    active = None
                else:
                    offset += len(line)
                    continue
            else:
                closing = active[1].search(content)
                if closing:
                    ranges.append((active[0], content_base + closing.end()))
                    active = None
            offset += len(line)
            continue

        candidates = [
            (opening.search(content), closing)
            for opening, closing in openers
        ]
        candidates = [item for item in candidates if item[0]]
        tag_opening = re.match(
            r" {0,3}<(script|pre|style|textarea)(?=[\s>])", content, re.I,
        )
        if tag_opening:
            tag = tag_opening.group(1)
            candidates.append((tag_opening, re.compile(rf"</{tag}>", re.I)))
        elif include_block_tags:
            block_tag_opening = _MARKED_BLOCK_HTML_START.match(content)
            if block_tag_opening:
                candidates.append((block_tag_opening, None))
        if candidates:
            opening, closing_pattern = min(
                candidates, key=lambda item: item[0].start(),
            )
            if closing_pattern is None:
                active = (content_base + opening.start(), None)
            else:
                closing = closing_pattern.search(content, opening.end())
                if closing:
                    ranges.append((
                        content_base + opening.start(), content_base + closing.end(),
                    ))
                else:
                    active = (content_base + opening.start(), closing_pattern)
        offset += len(line)

    if active:
        ranges.append((active[0], len(value)))
    return ranges


def _stable_literal_code_ranges(source):
    """Return top-level literal blocks without container-boundary ambiguity."""
    value = source or ""
    math_ranges = _markdown_math_ranges(value)
    math_starts = [start for start, _end in math_ranges]
    html_ranges = _raw_multiline_html_ranges(value)
    html_starts = [start for start, _end in html_ranges]
    document_lines = _markdown_lines(value, keepends=False)
    line_starts = []
    line_offset = 0
    previous_nonblank_line = []
    last_nonblank = -1
    for index, line in enumerate(_markdown_lines(value)):
        line_starts.append(line_offset)
        previous_nonblank_line.append(last_nonblank)
        if document_lines[index].strip(" \t"):
            last_nonblank = index
        line_offset += len(line)
    list_markers = [
        line_starts[index]
        for index, line in enumerate(document_lines)
        if re.match(r" {0,3}(?:[-+*]|[0-9]+[.)])[ \t]+", line)
    ]

    def preceding_context(start):
        line_index = bisect_right(line_starts, start) - 1
        previous_index = line_index - 1
        previous_line = (
            document_lines[previous_index] if previous_index >= 0 else ""
        )
        nonblank_index = (
            previous_nonblank_line[line_index] if line_index >= 0 else -1
        )
        previous_content = (
            document_lines[nonblank_index] if nonblank_index >= 0 else ""
        )
        return previous_line, previous_content

    def overlaps_math(start, end):
        index = bisect_right(math_starts, start) - 1
        return (
            index >= 0 and math_ranges[index][1] > start
        ) or (
            index + 1 < len(math_ranges) and math_ranges[index + 1][0] < end
        )

    def overlaps_html_block(start):
        index = bisect_right(html_starts, start) - 1
        return index >= 0 and html_ranges[index][1] > start

    ranges = []
    for start, end in _fenced_markdown_ranges(value):
        fragment = value[start:end]
        lines = _markdown_lines(fragment, keepends=False)
        if len(lines) < 2:
            continue
        opening = re.fullmatch(r"(`{3,}|~{3,})(.*)", lines[0])
        closing = re.fullmatch(r" {0,3}(`+|~+)[ \t]*", lines[-1])
        if not opening or not closing:
            continue
        marker = opening.group(1)
        if (
            closing.group(1)[0] != marker[0]
            or len(closing.group(1)) < len(marker)
            or (marker.startswith("`") and "`" in opening.group(2))
            or overlaps_math(start, end)
            or overlaps_html_block(start)
        ):
            continue
        previous_line, _previous_content = preceding_context(start)
        if previous_line and previous_line.strip(" \t"):
            continue
        ranges.append((start, end))

    for start, end in _indented_markdown_ranges(value):
        fragment = value[start:end]
        fragment_lines = _markdown_lines(fragment, keepends=False)
        first_line = fragment_lines[0] if fragment_lines else ""
        if (
            not first_line.startswith(("    ", "\t"))
            or overlaps_math(start, end)
            or overlaps_html_block(start)
        ):
            continue
        if bisect_right(list_markers, start):
            continue
        previous_line, previous_content = preceding_context(start)
        if previous_line and previous_line.strip(" \t"):
            continue
        if (
            previous_content[:1].isspace()
            or re.match(r" {0,3}(?:[-+*]|[0-9]+[.)])[ \t]+", previous_content)
        ):
            continue
        ranges.append((start, end))

    merged = []
    for start, end in sorted(ranges):
        if merged and merged[-1][1] >= start:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _stable_zip321_code_ranges(source):
    """Return code ranges whose Markdown context is safe to exempt."""
    value = source or ""
    if not _ZIP321_URI.search(value):
        return []
    block_ranges = _stable_literal_code_ranges(value)
    ranges = list(block_ranges)
    block_index = 0
    paragraph_ranges = []
    cursor = 0
    for match in re.finditer(r"\r?\n[ \t]*\r?\n", value):
        paragraph_ranges.append((cursor, match.start()))
        cursor = match.end()
    paragraph_ranges.append((cursor, len(value)))
    unsafe_paragraphs = []
    inline_index = 0
    code_spans = _markdown_inline_code_spans(value)
    hazards = ("<", ">", "[", "]", "|", "\\", "$", "@", "://", "www.")

    for start, end in paragraph_ranges:
        fragment = value[start:end]
        unsafe_paragraphs.append(any(hazard in fragment for hazard in hazards))

    for opening, closing, delimiter_length in code_spans:
        end = closing + delimiter_length
        while (
            block_index < len(block_ranges)
            and block_ranges[block_index][1] <= opening
        ):
            block_index += 1
        if (
            block_index < len(block_ranges)
            and block_ranges[block_index][0] <= opening
            and end <= block_ranges[block_index][1]
        ):
            continue
        if "\n" in value[opening:end] or "\r" in value[opening:end]:
            continue
        while (
            inline_index + 1 < len(paragraph_ranges)
            and paragraph_ranges[inline_index][1] <= opening
        ):
            inline_index += 1
        paragraph_start, paragraph_end = paragraph_ranges[inline_index]
        if (
            paragraph_start <= opening
            and end <= paragraph_end
            and not unsafe_paragraphs[inline_index]
        ):
            ranges.append((opening, end))

    merged = []
    for start, end in sorted(ranges):
        if merged and merged[-1][1] >= start:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _mask_unchanged_code_zip321_uris(source, translated):
    """Ignore exact ZIP-321 tokens still in stable code on both sides."""
    source_value = source or ""
    translated_value = translated or ""
    if not _ZIP321_URI.search(source_value) or not _ZIP321_URI.search(translated_value):
        return translated_value
    source_code_ranges = _stable_zip321_code_ranges(source_value)
    source_code_starts = [start for start, _end in source_code_ranges]

    def in_code_range(match, ranges, starts):
        index = bisect_right(starts, match.start()) - 1
        return (
            index >= 0
            and ranges[index][0] <= match.start()
            and match.end() <= ranges[index][1]
        )

    source_code_uris = Counter(
        match.group(0)
        for match in _ZIP321_URI.finditer(source_value)
        if in_code_range(match, source_code_ranges, source_code_starts)
    )

    translated_code_ranges = _stable_zip321_code_ranges(translated_value)
    translated_code_starts = [start for start, _end in translated_code_ranges]
    chars = list(translated_value)
    for match in _ZIP321_URI.finditer(translated_value):
        uri = match.group(0)
        if source_code_uris[uri] and in_code_range(
            match, translated_code_ranges, translated_code_starts,
        ):
            chars[match.start():match.end()] = " " * (match.end() - match.start())
            source_code_uris[uri] -= 1
    return "".join(chars)


def _mask_unchanged_reference_title_zip321_uris(source, translated):
    """Ignore exact ZIP-321 tokens that remain hidden in a reference title."""
    source_value = source or ""
    translated_value = translated or ""
    if not _ZIP321_URI.search(source_value) or not _ZIP321_URI.search(translated_value):
        return translated_value

    def title_uris(value):
        ranges = _reference_definition_target_ranges(value, titles_only=True)
        starts = [start for start, _end in ranges]
        return Counter(
            match.group(0)
            for match in _ZIP321_URI.finditer(value)
            if (index := bisect_right(starts, match.start()) - 1) >= 0
            and ranges[index][0] <= match.start()
            and match.end() <= ranges[index][1]
        )

    source_title_uris = title_uris(source_value)
    if not source_title_uris:
        return translated_value

    translated_ranges = _reference_definition_target_ranges(
        translated_value, titles_only=True,
    )
    translated_starts = [start for start, _end in translated_ranges]
    chars = list(translated_value)
    for match in _ZIP321_URI.finditer(translated_value):
        uri = match.group(0)
        index = bisect_right(translated_starts, match.start()) - 1
        if (
            source_title_uris[uri]
            and index >= 0
            and translated_ranges[index][0] <= match.start()
            and match.end() <= translated_ranges[index][1]
        ):
            chars[match.start():match.end()] = " " * (match.end() - match.start())
            source_title_uris[uri] -= 1
    return "".join(chars)

def _is_markdown_punctuation(char):
    if char is None:
        return False
    if char.isascii():
        return char in string.punctuation
    return unicodedata.category(char)[0] in {"P", "S"}


def _visible_markdown_text(
    markdown, *, skip_link_targets=True, matched_delimiters=None,
):
    """Flatten inline Markdown to visible text in one bounded linear pass.

    Link labels stay visible while destinations and titles do not. Paired
    inline delimiters disappear, so emphasis or a link inside an address
    cannot split the text a reader copies; unmatched literal delimiters stay
    visible. Entity decoding, format-control removal and NFKC happen after
    syntax handling, matching the renderer's order closely enough for this
    text-only payment check.
    """
    source = markdown or ""
    out = []
    preserve_literal = []

    def emit(value, *, preserve=False):
        out.append(value)
        preserve_literal.append(preserve)

    i = 0
    n = len(source)
    can_skip_link_targets = True
    open_brackets = []
    if matched_delimiters is None:
        matched_delimiters = _matched_markdown_delimiters(source)
    matched_delimiter_offsets, code_spans = matched_delimiters
    code_openers = {
        opening: (closing, length)
        for opening, closing, length in code_spans
    }
    code_closers = {
        closing: length for _opening, closing, length in code_spans
    }
    in_code_span = False
    reference_suffixes = _reference_link_suffixes(source)
    blank_line_ends = iter(
        match.end() for match in re.finditer(r"\r?\n[ \t]*\r?\n", source)
    )
    next_blank_line_end = next(blank_line_ends, None)
    while i < n:
        if i == next_blank_line_end:
            open_brackets.clear()
            next_blank_line_end = next(blank_line_ends, None)
        if i in code_openers:
            in_code_span = True
            i += code_openers[i][1]
            continue
        if i in code_closers:
            in_code_span = False
            i += code_closers[i]
            continue
        if in_code_span:
            emit(source[i], preserve=True)
            i += 1
            continue
        char = source[i]
        if char == "]" and open_brackets and i in reference_suffixes:
            _opening_offset, opening_output_offset = open_brackets.pop()
            out[opening_output_offset] = ""
            i = reference_suffixes[i]
            continue
        if (
            skip_link_targets
            and can_skip_link_targets
            and char == "]"
            and i + 1 < n
            and source[i + 1] == "("
            and open_brackets
        ):
            _opening_offset, opening_output_offset = open_brackets.pop()
            link_start = i
            i += 2
            depth = 1
            quote = None
            escaped = False
            while i < n and depth:
                current = source[i]
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif quote:
                    if current == quote:
                        quote = None
                elif current in {'"', "'"}:
                    quote = current
                elif current == "(":
                    depth += 1
                elif current == ")":
                    depth -= 1
                i += 1
            if depth == 0:
                out[opening_output_offset] = ""
                continue
            # An unmatched opener is literal Markdown. Do not let it hide the
            # rest of the visible text from safety checks: marked still renders
            # later autolinks and prose after malformed link syntax. No later
            # opener can close this one, so stop looking ahead at `](` and
            # process the remaining text once in the ordinary pass.
            can_skip_link_targets = False
            open_brackets.append((_opening_offset, opening_output_offset))
            i = link_start + 1
            continue
        if (
            char == "\\"
            and i + 1 < n
            and source[i + 1] in string.punctuation
        ):
            emit(source[i + 1])
            i += 2
            continue
        if char == "[":
            open_brackets.append((i, len(out)))
            emit(char)
            i += 1
            continue
        elif char == "]" and open_brackets:
            open_brackets.pop()
            emit(char)
            i += 1
            continue
        if (
            char == "_"
            and i > 0
            and i + 1 < n
            and source[i - 1].isalnum()
            and source[i + 1].isalnum()
        ):
            emit(char)
            i += 1
            continue
        if char in "*_~`" and i in matched_delimiter_offsets:
            i += 1
            continue
        emit(char)
        i += 1

    visible_parts = []
    current = []
    current_is_literal = None
    for value, is_literal in zip(out, preserve_literal):
        if current_is_literal is not None and is_literal != current_is_literal:
            visible_parts.append(("".join(current), current_is_literal))
            current = []
        current.append(value)
        current_is_literal = is_literal
    if current:
        visible_parts.append(("".join(current), current_is_literal))

    normalized = []
    for value, is_literal in visible_parts:
        if not is_literal:
            value = html.unescape(value)
            value = "".join(
                char for char in value if unicodedata.category(char) != "Cf"
            )
            value = unicodedata.normalize("NFKC", value)
        normalized.append(value)
    return "".join(normalized)


def _valid_zcash_candidate(value):
    value = value.removeprefix("zcash:")
    try:
        validate_zcash_address(value)
    except ValidationError:
        return False
    return True


def _ascii_confusables():
    """UTS  confusable mappings whose skeleton is ASCII alphanumeric."""
    global _ASCII_CONFUSABLES
    if _ASCII_CONFUSABLES is None:
        table = {}
        data = Path(__file__).parents[2] / "oidc/unicode_data/confusables.txt"
        for line in data.read_text(encoding="utf-8").splitlines():
            fields = line.split("#", 1)[0].split(";")
            if len(fields) < 2:
                continue
            source = int(fields[0].strip(), 16)
            # UTS  can map ASCII lookalikes as well (for example `1` to
            # lowercase `l`). Preserve every literal address alphabet byte;
            # only fold non-ASCII confusables into it.
            if source < 0x80:
                continue
            target = "".join(chr(int(value, 16)) for value in fields[1].split())
            if target and target.isascii() and target.isalnum():
                table[source] = target
        _ASCII_CONFUSABLES = table
    return _ASCII_CONFUSABLES


def _unescape_markdown_text(text):
    """Decode HTML entities outside inline code spans only.

    CommonMark code spans show entity spellings literally. Decoding an entity
    inside a source code example would make an unchanged translation appear
    to contain an address that the source does not contain.
    """
    value = text or ""
    code_spans = _matched_markdown_delimiters(value)[1]
    if not code_spans:
        return html.unescape(html.unescape(value))
    pieces = []
    cursor = 0
    for opening, closing, delimiter_length in code_spans:
        pieces.append(html.unescape(html.unescape(value[cursor:opening])))
        # Retain the literal code content and delimiters; later skeleton
        # normalization drops punctuation without interpreting entities.
        end = closing + delimiter_length
        pieces.append(value[opening:end])
        cursor = end
    pieces.append(html.unescape(html.unescape(value[cursor:])))
    return "".join(pieces)


def _zcash_text_skeleton(text):
    """Collapse formatting and Unicode lookalikes while retaining boundaries.

    This deliberately does not attempt to reproduce Markdown rendering. It
    creates an additional conservative view: HTML entities and compatibility
    forms are normalized, UTS  confusables fold to ASCII where possible,
    and every remaining non-ASCII-alphanumeric character is removed. A valid
    checksum is still required before a candidate counts as an address.
    """
    value = _unescape_markdown_text(text)
    # KaTeX removes command names and renders braced arguments.
    value = _strip_math_command_names(value)
    if not value.isascii():
        value = unicodedata.normalize("NFKC", value)
        # Preserve case: Bech32 addresses are case-insensitive, but Base58Check
        # transparent and Sprout addresses are not. Their checksum is validated
        # with the original bytes below.
        if not value.isascii():
            value = value.translate(_ascii_confusables())
    return "".join(
        char if (char.isascii() and char.isalnum()) or char.isspace() else ""
        for char in value
    )


def _zcash_markdown_skeleton(text):
    """A second skeleton that removes link syntax but keeps visible labels."""
    value = _unescape_markdown_text(text)
    # Remove only syntax ranges found by the bounded scanners used elsewhere
    # in this module. Regexes that search from every unmatched `[` can become
    # quadratic on adversarial documents. Preserve visible labels. The raw
    # view remains in the union, so malformed or literal `](` syntax cannot
    # hide text if a link scanner declines it.
    ranges = _inline_link_target_ranges(value)
    ranges.extend(
        (closing, end) for closing, end in _reference_link_suffixes(value).items()
    )
    ranges.sort()
    merged = []
    for start, end in ranges:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    if merged:
        parts = []
        cursor = 0
        for start, end in merged:
            parts.append(value[cursor:start])
            cursor = end
        parts.append(value[cursor:])
        value = "".join(parts)
    return _zcash_text_skeleton(value)


def extract_zcash_addresses(
    text, *, include_skeletons=True, strict_emphasis=False, _verification_budget=None,
):
    """Checksum-valid mainnet payment destinations in rendered Markdown text.

    Prefixes are found anywhere. For Bech32, a rolling polymod checks each
    possible ending once and the full validator inspects only checksum hits.
    Unified Addresses have no fixed maximum length in the validator, so scans
    are bounded by the input document rather than an arbitrary token cap.
    Prefix matches are exact; no partial-address tolerance is used.
    """
    found = set()
    # Shared by source and output when validating a translation, and by all
    # alternative projections. Standalone extraction gets its own budget.
    budget = _verification_budget if _verification_budget is not None else [0, 0]

    def verify(candidate):
        budget[0] += len(candidate)
        budget[1] += 1
        if budget[0] > 200_000 or budget[1] > 256:
            raise UnsafeTranslation(
                "payment_scan_limit",
                "Payment destination validation exceeded its bounded work budget.",
            )
        return _valid_zcash_candidate(candidate)

    # A second, conservative pass retains link destinations and titles. A
    # renderer can show their syntax literally in code spans or malformed
    # Markdown, so omitting them in every parser interpretation can miss a
    # visible payment address. The same union is applied to source and output.
    source_text = text or ""
    source_math_views = ()
    if strict_emphasis:
        source_text = _mask_markdown_code_contexts(source_text)
        source_text, source_math_views = _source_math_authorization_views(source_text)
    render_text = source_text
    if not include_skeletons:
        chars = list(source_text)
        cursor = 0
        for start, end in _literal_block_ranges(source_text):
            start = max(start, cursor)
            if end > start:
                chars[start:end] = " " * (end - start)
                cursor = end
        render_text = "".join(chars)
    matched_delimiters = _matched_markdown_delimiters(
        render_text, strict_emphasis=strict_emphasis,
    )
    views = [
        source_text,
        _visible_markdown_text(render_text, matched_delimiters=matched_delimiters),
        _visible_markdown_text(
            render_text, skip_link_targets=False,
            matched_delimiters=matched_delimiters,
        ),
    ]
    math_source = source_text
    if not include_skeletons:
        # Literal code cannot authorize the text KaTeX would display if the
        # same bytes moved into prose. Mask it only for the extra math view;
        # the raw/literal views still authorize complete addresses in code.
        literal_ranges = _literal_block_ranges(source_text)
        literal_ranges.extend(
            (opening, closing + length)
            for opening, closing, length in matched_delimiters[1]
        )
        chars = list(source_text)
        cursor = 0
        for start, end in sorted(literal_ranges):
            start = max(start, cursor)
            if end > start:
                chars[start:end] = " " * (end - start)
                cursor = end
        math_source = "".join(chars)
    math_text = _strip_math_command_names(math_source)
    if math_text != source_text:
        views.append(math_text)
    views.extend(source_math_views)
    if include_skeletons:
        views.extend((
            _zcash_text_skeleton(source_text),
            _zcash_markdown_skeleton(source_text),
        ))
    for visible in dict.fromkeys(views):
        for prefix in _ZCASH_PREFIX.finditer(visible):
            start = prefix.start()
            address_start = (
                start + 6
                if visible[start:start + 6].casefold() == "zcash:"
                else start
            )
            prefix_text = visible[address_start:address_start + 4].casefold()
            is_bech32 = prefix_text.startswith(("u1", "zs1", "tex1"))
            if is_bech32:
                hrp = "tex" if prefix_text.startswith("tex1") else (
                    "zs" if prefix_text.startswith("zs1") else "u"
                )
                expected_constant, exact_length, minimum_length = BECH32_HRPS[hrp]
                payload_length = exact_length or minimum_length
                minimum_words = (payload_length * 8 + 4) // 5 + 6
                data_start = address_start + len(hrp) + 1
                polymod = 1
                for value in _bech32_hrp_expand(hrp):
                    polymod = _bech32_polymod_step(polymod, value)
                data_words = 0
                for end in range(data_start, len(visible)):
                    value = _BECH32_CHAR_VALUES.get(visible[end].casefold())
                    if value is None:
                        break
                    polymod = _bech32_polymod_step(polymod, value)
                    data_words += 1
                    if data_words >= minimum_words and polymod == expected_constant:
                        candidate = visible[address_start:end + 1]
                        if verify(candidate):
                            found.add(candidate.lower())
                continue
            else:
                # Mainnet transparent addresses encode 26 bytes; legacy
                # Sprout addresses encode 70 bytes. Both have fixed Base58Check
                # lengths, so there is no reason to try arbitrary suffixes.
                address_length = 95 if prefix_text.startswith("zc") else 35
                end = min(len(visible), address_start + address_length)
                if end - address_start != address_length:
                    continue
                if not all(
                    _ASCII_ALNUM.fullmatch(ch)
                    for ch in visible[address_start:end]
                ):
                    continue
            candidate = visible[address_start:end]
            if verify(candidate):
                found.add(candidate)
    return found


def _mask_unchanged_code_spans(source, translated):
    """Mask only code occurrences copied verbatim from the source."""
    source_text = source or ""
    translated_text = translated or ""
    if source_text == translated_text:
        # Identical documents have identical render context. This does not
        # authorize that example's reconstructed destination elsewhere.
        return " " * len(translated_text)
    source_fences = _literal_block_ranges(source_text)
    translated_fences = _literal_block_ranges(translated_text)

    def outside_blocks(bounds, ranges):
        result = []
        block_index = 0
        for opening, closing, length in sorted(bounds):
            while block_index < len(ranges) and ranges[block_index][1] <= opening:
                block_index += 1
            if block_index < len(ranges) and ranges[block_index][0] < closing + length:
                continue
            result.append((opening, closing, length))
        return result

    # Backticks inside a literal block are its content. They cannot create
    # overlapping inline spans that invalidate the block's own exemption.
    source_bounds = outside_blocks(_matched_markdown_delimiters(source_text)[1], source_fences)
    translated_bounds = outside_blocks(_matched_markdown_delimiters(translated_text)[1], translated_fences)

    def has_overlaps(bounds):
        ordered = sorted(
            (opening, closing + length) for opening, closing, length in bounds
        )
        return any(
            ordered[index - 1][1] > ordered[index][0]
            for index in range(1, len(ordered))
        )

    if has_overlaps(source_bounds) or has_overlaps(translated_bounds):
        return translated_text

    source_fence_starts = [value[0] for value in source_fences]
    translated_fence_starts = [value[0] for value in translated_fences]

    def inside_fence(start, end, ranges, starts):
        fence_index = bisect_right(starts, start) - 1
        return (
            fence_index >= 0
            and ranges[fence_index][0] < end
            and start < ranges[fence_index][1]
        )

    def spans(value, bounds):
        return [
            (
                value[opening + delimiter_length:closing],
                opening,
                closing + delimiter_length,
                delimiter_length,
            )
            for opening, closing, delimiter_length in bounds
        ]

    def safe_inline_context(value):
        # A table splits cells before inline tokenization, including at pipes
        # inside backticks. HTML, links and math can also consume syntax first.
        # Cache line decisions so a long line with many code spans stays linear.
        newline_offsets = [-1] + [m.start() for m in re.finditer("\n", value)]
        first_html = value.find("<")
        line_contexts = {}

        def safe(span):
            start, end = span[1:3]
            # An unchanged fragment is not an unchanged instruction. Keep
            # scanning code joined to adjacent prose (for example `u1`abc).
            if start and not (value[start - 1].isspace() or value[start - 1] == "("):
                return False
            if end < len(value) and not (
                value[end].isspace() or value[end] in ".,;:!?)"
            ):
                return False
            line_index = bisect_right(newline_offsets, start - 1) - 1
            line_start = newline_offsets[line_index] + 1
            line_end = (
                newline_offsets[line_index + 1]
                if line_index + 1 < len(newline_offsets) else len(value)
            )
            if end > line_end:
                return False
            if line_start not in line_contexts:
                line_contexts[line_start] = (
                    not any(char in value[line_start:line_end] for char in "|<>[]\\$")
                    and not (0 <= first_html < line_start)
                )
            return line_contexts[line_start]

        return safe

    source_inline_safe = safe_inline_context(source_text)
    translated_inline_safe = safe_inline_context(translated_text)
    source_spans = [
        span for span in spans(source_text, source_bounds)
        if span[3] <= 2
        and source_inline_safe(span)
        and "\n\n" not in span[0]
        and not inside_fence(span[1], span[2], source_fences, source_fence_starts)
    ]
    translated_spans = [
        span for span in spans(translated_text, translated_bounds)
        if span[3] <= 2
        and translated_inline_safe(span)
        and "\n\n" not in span[0]
        and not inside_fence(
            span[1], span[2], translated_fences, translated_fence_starts,
        )
    ]
    source_counts = Counter(fragment for fragment, _start, _end, _length in source_spans)
    chars = list(translated_text)
    for fragment, start, end, _length in translated_spans:
        if source_counts[fragment] <= 0:
            continue
        source_counts[fragment] -= 1
        chars[start:end] = " " * (end - start)
    def safe_fences(value, ranges):
        # A raw HTML block can consume a fence as literal text and change how
        # subsequent Markdown is parsed. Refuse exemptions in that context.
        cursor = 0
        for start, end in ranges:
            if "<" in value[cursor:start]:
                return []
            cursor = end
        result = []
        math_ranges = _markdown_math_ranges(value)
        math_starts = [start for start, _end in math_ranges]
        list_marker = re.search(r"(?m)^ {0,3}(?:[-+*]|[0-9]+[.)]) ", value)
        for start, end in ranges:
            math_index = bisect_right(math_starts, start) - 1
            if math_index >= 0 and math_ranges[math_index][0] < start < math_ranges[math_index][1]:
                continue
            if list_marker and list_marker.start() < start:
                continue
            if start and not value[max(0, start - 4):start].endswith(("\n\n", "\r\n\r\n")):
                continue
            fragment = value[start:end]
            # Only complete fenced blocks qualify; an unclosed fence's later
            # context can alter whether the renderer treats it as code.
            lines = _markdown_lines(fragment, keepends=False)
            if not fragment.startswith(("    ", "\t")):
                if len(lines) < 2 or not re.fullmatch(r" {0,3}(`{3,}|~{3,})[ \t]*", lines[-1]):
                    continue
            result.append((fragment, start, end))
        return result

    source_fence_counts = Counter(
        fragment for fragment, _start, _end
        in safe_fences(source_text, source_fences)
    )
    for fragment, start, end in safe_fences(translated_text, translated_fences):
        if source_fence_counts[fragment] <= 0:
            continue
        source_fence_counts[fragment] -= 1
        chars[start:end] = " " * (end - start)
    return "".join(chars)


def _amount_decimal_separator(raw):
    """Return a convention established by an amount with 1–2 decimals."""
    compact = re.sub(r"[\s\u00a0\u202f]", "", raw)
    separators = [(index, char) for index, char in enumerate(compact) if char in ".,"]
    if not separators:
        return None
    last_index, last_char = separators[-1]
    trailing = len(compact) - last_index - 1
    if trailing not in (1, 2):
        return None
    integer_candidate = compact[:last_index]
    if last_char in integer_candidate:
        return None
    groups = re.split(r"[.,]", integer_candidate)
    if integer_candidate.isdigit() or _valid_grouping(groups):
        return last_char
    return None


def _canonical_amount(raw, *, decimal_separator=None):
    """Canonicalize a numeric token, or preserve it when parsing is unsure."""
    literal = "literal:" + re.sub(r"[\s\u00a0\u202f]", "", raw)
    space_groups = re.split(r"[\s\u00a0\u202f]+", raw.strip())
    if len(space_groups) > 1:
        # Spaces are accepted only as thousands separators. The last group
        # may carry a decimal fraction, but its integer part is still a full
        # 3-digit group (`1 432,60`), never an arbitrary join (`1 2`). Remove
        # a validated space separator directly; turning it into punctuation
        # would let the document's decimal convention reinterpret its value.
        integer_parts = [re.split(r"[.,]", group, maxsplit=1)[0] for group in space_groups]
        if (
            any(not part.isdigit() for part in integer_parts)
            or not 1 <= len(integer_parts[0]) <= 3
            or any(len(part) != 3 for part in integer_parts[1:])
        ):
            return literal
        raw = "".join(space_groups)
    compact = re.sub(r"[\s\u00a0\u202f]", "", raw)
    if not compact or not re.fullmatch(r"\d+(?:[.,]\d+)*", compact):
        return literal

    separators = [(index, char) for index, char in enumerate(compact) if char in ".,"]
    if not separators:
        integer, fraction = compact, ""
    else:
        last_char = separators[-1][1]
        last_index = separators[-1][0]
        trailing = len(compact) - last_index - 1
        same_separator_count = sum(char == last_char for _, char in separators)

        # The final punctuation is decimal when it has one or two digits after
        # it. Any preceding punctuation must then form valid 3-digit groups.
        if trailing in (1, 2):
            integer_candidate = compact[:last_index]
            integer_separators = [char for char in integer_candidate if char in ".,"]
            integer_groups = re.split(r"[.,]", integer_candidate)
            if last_char in integer_separators:
                return literal
            if integer_separators and len(set(integer_separators)) > 1:
                return literal
            if integer_separators and not _valid_grouping(integer_groups):
                return literal
            if not integer_candidate.isdigit() and not (
                integer_separators and _valid_grouping(integer_groups)
            ):
                return literal
            integer = re.sub(r"[.,]", "", integer_candidate)
            fraction = compact[last_index + 1:]
        # Three trailing digits are ambiguous without document-level evidence.
        # With evidence, the known decimal mark is a decimal (and the other
        # mark is grouping); without evidence, preserve the literal spelling.
        elif trailing == 3:
            groups = re.split(r"[.,]", compact)
            if (
                same_separator_count > 1
                and decimal_separator != last_char
                and _valid_grouping(groups)
            ):
                integer, fraction = "".join(groups), ""
            elif last_char == decimal_separator:
                if same_separator_count > 1:
                    return literal
                integer_candidate = compact[:last_index]
                integer_groups = re.split(r"[.,]", integer_candidate)
                if integer_candidate.isdigit():
                    integer = integer_candidate
                elif _valid_grouping(integer_groups):
                    integer = "".join(integer_groups)
                else:
                    return literal
                fraction = compact[last_index + 1:]
            elif decimal_separator is not None and _valid_grouping(groups):
                integer, fraction = "".join(groups), ""
            else:
                return literal
        else:
            return literal

    integer = integer.lstrip("0") or "0"
    fraction = fraction.rstrip("0")
    return "value:" + integer + ("." + fraction if fraction else "")


def _valid_grouping(groups):
    """Whether digit groups follow the conventional 1–3 / then 3 pattern."""
    return (
        len(groups) > 1
        and all(group.isdigit() for group in groups)
        and 1 <= len(groups[0]) <= 3
        and all(len(group) == 3 for group in groups[1:])
    )


# --------------------------------------------------------------------------- #
# The invariants
# --------------------------------------------------------------------------- #
def check_translation(
    source, translated, *, untrimmed=None,
    source_language=None, target_language=None,
):
    """Raise:class:`UnsafeTranslation` unless ``translated`` is safe to store.

    ``source`` is the concatenation of everything that was sent to the model
    for this document (title + description + body), and ``translated`` the
    concatenation of everything that came back. Checking the document as a
    whole rather than chunk by chunk is deliberate: a model may legitimately
    move a footnote reference or a link between sentences, and only the
    document-level set is invariant under that.

    ``untrimmed`` is the same text BEFORE ``service._fit`` cut the title to 128
    characters and the description to 255, and the PRESERVATION rules (invariant
    5) are asked of it rather than of ``translated``. Everything else is still
    asked of ``translated``, which is what gets stored.

    Why the split exists, from the codex adversarial review, round 2: a
    116-character English title ending in "Free2Z" has a valid Spanish
    translation that is longer, `_fit` cuts the last word off it, and
    ``brand_term_not_preserved`` then refunded a finished document over OUR
    OWN truncation. A rule that fires on a transformation we performed after
    the model was done is not a statement about the model. The introduction
    rules keep using the stored text because trimming can only remove, and
    what must not reach a reader is what is stored.

    Raises the FIRST of:func:`find_violations`, in the order the invariants
    are listed in the module docstring. The worker no longer calls this: it
    asks:func:`find_violations` for all of them and lets the settlement policy
    decide which ones fail the job.
    """
    violations = find_violations(
        source,
        translated,
        untrimmed=untrimmed,
        source_language=source_language,
        target_language=target_language,
    )
    if violations:
        raise violations[0]


def find_violations(
    source, translated, *, untrimmed=None,
    source_language=None, target_language=None,
):
    """Collect safety failures, including explicit bounded-work refusals."""
    try:
        return _find_violations(
            source, translated, untrimmed=untrimmed,
            source_language=source_language, target_language=target_language,
        )
    except UnsafeTranslation as violation:
        return [violation]


def _find_violations(
    source, translated, *, untrimmed=None,
    source_language=None, target_language=None,
):
    """EVERY invariant ``translated`` breaks, as:class:`UnsafeTranslation`\\ s.

    Same rules and order as:func:`check_translation` -- which is this, raising
    the first. Collecting all of them is what lets a
    draft that broke three preservation rules be delivered with three warnings
    instead of being thrown away over the first one.
    """
    untrimmed = translated if untrimmed is None else untrimmed
    source_destinations = extract_destinations(source)
    found = []

    unsafe_scheme = sorted(
        value
        for value in extract_destinations(translated)
        if not SAFE_URI_RE.match(value)
    )
    if unsafe_scheme:
        found.append(UnsafeTranslation(
            "unsafe_url_scheme",
            "The translation contains a destination with a scheme the reader "
            f"sanitizer rejects: {unsafe_scheme[:3]}",
            unsafe_scheme,
        ))

    # NO code exception (see the module docstring, invariant 1): a destination
    # inside a code span or fence is fatal exactly like one in prose, because
    # nothing here can prove the renderer agrees that it is code.
    introduced = set(extract_destinations(translated) - source_destinations)
    introduced |= extract_split_url_tokens(translated) - extract_split_url_tokens(
        source
    )
    # A loose skeleton is an output-side superset. Applying it to the source
    # would let malformed markup (for example an unmatched emphasis marker)
    # authorize an address the source renderer does not show as a complete
    # destination. Source authorization uses the raw and parsed views only.
    translated_zcash_scan = _mask_unchanged_code_spans(source, translated)
    verified_math_context = _mask_unchanged_math_contexts(source or "", translated_zcash_scan)
    unsupported_math = [
        (start, end)
        for start, end in _markdown_math_ranges(verified_math_context)
        if _math_visible_text(_math_body(verified_math_context[start:end])) is None
    ]
    if unsupported_math:
        found.append(UnsafeTranslation(
            "payment_math_not_verified",
            "The translation contains math whose displayed payment text cannot "
            "be verified. Unsupported commands require unchanged safe context.",
        ))
    verification_budget = [0, 0]
    introduced |= (
        extract_zcash_addresses(
            translated_zcash_scan, _verification_budget=verification_budget,
        )
        - extract_zcash_addresses(
            source, include_skeletons=False, strict_emphasis=True,
            _verification_budget=verification_budget,
        )
    )
    introduced = sorted(introduced)
    if introduced:
        found.append(UnsafeTranslation(
            "url_not_in_source",
            "The translation introduced destinations that are not in the "
            f"article: {introduced[:3]}",
            introduced,
        ))

    new_tags = sorted(extract_tags(translated) - extract_tags(source))
    if new_tags:
        found.append(UnsafeTranslation(
            "markup_not_in_source",
            f"The translation introduced HTML not in the article: {new_tags[:3]}",
            new_tags,
        ))

    source_amounts = _amount_tokens(source, language=source_language)
    translated_amounts = _amount_tokens(
        translated,
        language=target_language,
        exempt_code_spans={
            match.group(0) for match in _CODE_SPAN.finditer(source or "")
        },
    )
    source_values = {canonical for canonical, _raw, _display in source_amounts}
    source_spellings = {raw for _canonical, raw, _display in source_amounts}
    new_amounts = sorted({
        display
        for canonical, raw, display in translated_amounts
        if canonical not in source_values and raw not in source_spellings
    })
    new_amounts.sort()
    if new_amounts:
        found.append(UnsafeTranslation(
            "amount_not_in_source",
            "The translation changed a currency amount: "
            f"{new_amounts[:3]}",
            new_amounts,
        ))

    source_zip321_amounts = _zip321_amounts(
        source, include_rendered_views=True, source_authorization=True,
    )
    # Raw URI identity cannot authorize a rendered amount: markup may be
    # literal inside source code and active in the translation. Exempt a code
    # example only when that exact URI remains in a recognized code context on
    # both sides; source authorization still comes from visible source views.
    translated_zip321_amounts = _zip321_amounts(
        _mask_unchanged_code_zip321_uris(
            source,
            _mask_unchanged_reference_title_zip321_uris(source, translated),
        )
    )
    new_zip321_amounts = sorted(
        payment
        for payment, count in (
            translated_zip321_amounts - source_zip321_amounts
        ).items()
        for _ in range(count)
    )
    # Exact document identity cannot introduce an amount. This exception
    # never authorizes a copied hidden expression in otherwise changed output.
    if new_zip321_amounts and source != translated:
        items = [
            f"{recipient}?amount{'.' + index if index else ''}={amount}"
            for index, recipient, amount in new_zip321_amounts
        ]
        found.append(UnsafeTranslation(
            "zip321_amount_not_in_source",
            "The translation changed a Zcash ZIP-321 payment amount: "
            f"{items[:3]}",
            items,
        ))

    found.extend(_identifier_violations(source, translated, untrimmed))
    return found


#Names the translation must not respell. Mirrors
#``service.DO_NOT_TRANSLATE``; kept as its own tuple so this module stays a
#pure function of two strings with no import of the provider layer.
DO_NOT_TRANSLATE = ("Free2Z", "2Z", "zPage", "Zcash", "ZEC")

#Word-boundary matcher per term, with the boundary defined over ALPHANUMERICS
#rather than `\b`. `\b2Z\b` is wrong in both directions here: it finds the
#`2Z` inside `Free2Z` (`e`/`2` is a word-internal position, but the preceding
#character is alphanumeric, which is the thing that matters) and it would fire
#on a hash or an id that happens to contain the digraph.
_TERM_PATTERN = {
    term: re.compile(
        r"(?<![0-9A-Za-z])" + re.escape(term) + r"(?![0-9A-Za-z])",
        re.IGNORECASE,
    )
    for term in DO_NOT_TRANSLATE
}

#Patterns whose matches are blanked before the product-name scan. A name
#inside a URL, an email address or a code span is not prose and is not the
#model's to keep: `https://free2z.cash/docs` carries "Free2Z", and requiring
#the output to still contain it would turn "the translation dropped a link"
#-- explicitly allowed above, because the creator reviews the draft -- into a
#refunded job. The destination rules already own destinations.
# Start only at a local-token boundary. Otherwise an absent/invalid domain
# retries the same long token at every character, making prose checks quadratic.
_EMAILISH = re.compile(
    r"(?<![^\s<>()\[\]])[^\s<>()\[\]]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
)


def _identifiers(text):
    """Every footnote id and link reference label mentioned in ``text``."""
    foot_used, foot_defined = extract_footnote_ids(text)
    ref_used, ref_defined = extract_reference_labels(text)
    return (
        {f"[^{name}]" for name in foot_used | foot_defined}
        | {f"[{name}]" for name in ref_used | ref_defined}
    )


def prose_only(text, *, code_spans=True):
    """``text`` with destinations and emails blanked out.

    ``code_spans`` also blanks backticked spans. True for the side that decides
    what is REQUIRED, false for the side that only has to contain it -- see
    :func:`_check_identifiers`.

    Public because ``service._require_target_script`` needs the same
    subtraction for a different reason: a URL is preserved byte for byte by
    instruction, so it is Latin in every translation and must not count against
    the target script (codex round 3).

    Blanked rather than deleted, so two adjacent words cannot be run together
    into a token that was in neither.
    """
    text = text or ""
    patterns = [
        _INLINE_TARGET,
        _REFERENCE_TARGET,
        _AUTOLINK,
        _BARE_URL,
        _BLOCK_DIRECTIVE,
        _HTML_URL_ATTR,
        _EMAILISH,
    ]
    if code_spans:
        patterns.append(_CODE_SPAN)
    for pattern in patterns:
        text = pattern.sub(" ", text)
    return text


def _check_identifiers(source, translated, untrimmed=None):
    """Invariant 5, raising the first violation. See the module docstring."""
    violations = _identifier_violations(source, translated, untrimmed)
    if violations:
        raise violations[0]


def _identifier_violations(source, translated, untrimmed=None):
    """Invariant 5. See the module docstring.

    Every check here is ``output minus source``, so a document that arrives
    already broken -- a creator who wrote ``[^a]`` and never defined it, or who
    never mentioned Free2Z at all -- cannot be failed by its translation. That
    matters more than it looks: a failure costs us the whole provider bill and
    gives the creator nothing, so a rule that fires on a source defect would be
    a way for a badly-written article to cost us money.
    """
    found = []
    renamed = sorted(_identifiers(translated) - _identifiers(source))
    if renamed:
        found.append(UnsafeTranslation(
            "reference_not_in_source",
            "The translation renamed a footnote or link reference, so it no "
            f"longer matches its other half: {renamed[:3]}",
            renamed,
        ))

    # Asked of the SOURCE's identifiers, not of the output's spans. `press
    # Enter` is not an identifier, so nothing is required of whatever the
    # Japanese translation of that phrase puts between backticks.
    untrimmed = translated if untrimmed is None else untrimmed
    lost = sorted(
        extract_code_identifiers(source) - extract_code_spans(untrimmed)
    )
    if lost:
        found.append(UnsafeTranslation(
            "code_identifier_not_preserved",
            "The translation rewrote or dropped a code identifier: "
            f"{lost[:3]}",
            lost,
        ))

    # ASYMMETRIC ON PURPOSE. The SOURCE decides what is REQUIRED, and a name
    # that appears there only inside a URL or a code span is not prose the
    # translator was asked to keep -- so those are blanked out of it. The
    # OUTPUT only has to CONTAIN the name, in any form, so its code spans are
    # left in: a model that wrote ``Use `Free2Z`.`` preserved the name exactly,
    # and blanking the span out of the output turned that into a refunded job.
    # (codex adversarial review, round 2.) Destinations stay blanked on both
    # sides, because "the name survives in a URL we told it to copy verbatim"
    # is not evidence that the prose kept it.
    prose_source = prose_only(source, code_spans=True)
    prose_translated = prose_only(untrimmed, code_spans=False)
    dropped = sorted(
        term for term in DO_NOT_TRANSLATE
        if _TERM_PATTERN[term].search(prose_source)
        and not _TERM_PATTERN[term].search(prose_translated)
    )
    if dropped:
        found.append(UnsafeTranslation(
            "brand_term_not_preserved",
            "The translation transliterated or dropped a name that must "
            f"survive in every script: {dropped[:3]}",
            dropped,
        ))
    return found
