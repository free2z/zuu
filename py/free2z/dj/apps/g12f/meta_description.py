"""Derive a fallback page description consistently with the Svelte renderer.

The Python and TypeScript implementations share a golden fixture covering
markdown removal, whitespace, length, and word boundaries. This derivation is
used only when a page has no explicit description. It must not expose raw
markup or embed directives in HTML metadata.
"""

import re


#The shared bound, in code points, including the trailing ellipsis.
META_DESCRIPTION_CHARS = 200

#How much of the RAW value the derivation is allowed to read, in code
#points. This is not a nicety -- it is the parity fix codex found. The
#Django tier only ever holds a 4,000-character ``Substr`` of ``content``
#(``crawler.CARD_BODY_CHARS``, so the 100,000-character body is never loaded
#on the sync worker), while the SvelteKit caller has the WHOLE article from
#the API. Same article, different input, therefore different output -- the
#exact divergence this module exists to remove, reintroduced one layer up.
#An article opening with a 5,000-character fenced code block was the
#reproduction: Django saw an unterminated fence and fell back, SvelteKit saw
#the closing fence and used the prose after it. Clamping HERE, inside the
#shared derivation, means neither caller can feed it a different window.
DESCRIPTION_SOURCE_CHARS = 4000

#U+2026, one code point in both runtimes.
ELLIPSIS = "\u2026"

def _word_boundary_floor(max_length):
    """How much of the truncation window a word-boundary pull-back must keep.

    Without a floor, one very long token (a URL) would collapse the whole
    description to almost nothing. ``* 2 // 5`` is exact integer arithmetic on
    purpose: ``max_length * 0.4`` is 80.00000000000001 for 200 in IEEE 754 and
    the two runtimes have to agree on the integer.
    """
    return max_length * 2 // 5


# --- the pipeline ---------------------------------------------------------
#
# Every pattern here has a byte-for-byte twin in ts/svelte/free2z/src/lib/seo.ts
# and the ORDER is part of the contract: headings are consumed at line starts
# before `#` would otherwise be stripped, which is what lets `#hashtag` survive
# mid-sentence; thematic breaks are consumed before list bullets so `- - -`
# does not decay to `- -`.

_CARRIAGE_RETURN_RE = re.compile(r"\r\n?")
# Every whitespace-ish character EXCEPT `\n`, folded to a plain space up
# front. Two reasons, and the second is the load-bearing one:
#
#   * `\n` has to survive -- the block rules below are line-anchored.
#   * Python's `\s` and ECMAScript's `\s` are NOT the same set. Python
#     includes U+001C-U+001F and U+0085; JavaScript does not. JavaScript
#     includes U+FEFF; Python does not. Leaving a later `\s+` collapse to
#     resolve those would make `alpha\u0085beta` one word on the Django tier
#     and leave a raw control character in SSR's meta attribute -- the exact
#     cross-runtime divergence this module exists to remove. After this
#     substitution the only whitespace left anywhere is `\n` and U+0020, on
#     which the two runtimes cannot disagree.
#
# U+200B/U+200C/U+200D are deliberately NOT here. ZWNJ and ZWJ carry meaning:
# stripping them breaks `👩‍💻` into two emoji and changes the shaping of
# Persian and Indic text (codex adversarial review).
_EXOTIC_WHITESPACE_RE = re.compile(
    "[\t\v\f\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029"
    "\u202f\u205f\u3000\ufeff]"
)

# Fenced code. Terminated first, then whatever is left dangling to end-of-text:
# an unterminated fence in a truncated 4,000-character excerpt is the common
# case, not the exotic one.
# LINE-ANCHORED, like the tilde pair below and like every real markdown
# tokenizer. An unanchored rule reads the prose `Type ``` to open a block` as
# an unterminated fence and deletes the rest of the description (codex
# adversarial review); a stray inline run of backticks is handled by the
# generic backtick strip further down instead.
# The backreference is not decoration: CommonMark (and the app's own renderer,
# `markdown.ts`) requires the CLOSING fence to be at least as long as the
# opening one. A fixed ```` ``` ```` pattern reads the literal ```` ``` ````
# line inside a four-backtick block as the close, then reads the real close as
# a fresh unterminated opener -- publishing code from inside the block and
# deleting the prose after it (codex adversarial review).
_BACKTICK_FENCE_RE = re.compile(
    # The info string is `[^`\n]*`, not `[^\n]*`: CommonMark forbids a
    # backtick in a backtick fence's info string, and allowing one lets the
    # capture BACKTRACK -- a ```` opener would match as ``` with the fourth
    # backtick absorbed as info, so an inner ``` line closes it (codex).
    r"^[ \t]{0,3}(`{3,})[^`\n]*\n[\s\S]*?^[ \t]{0,3}\1`*[ \t]*$", re.M,
)
_BACKTICK_FENCE_OPEN_RE = re.compile(r"^[ \t]{0,3}`{3,}[\s\S]*", re.M)
_TILDE_FENCE_RE = re.compile(
    r"^[ \t]{0,3}(~{3,})[^~\n]*\n[\s\S]*?^[ \t]{0,3}\1~*[ \t]*$", re.M,
)
_TILDE_FENCE_OPEN_RE = re.compile(r"^[ \t]{0,3}~{3,}[\s\S]*", re.M)

# `::embed[/uploadz/public/example/clip.mp4]`. Never useful description text --
# it is markup for a player, and on /example_creator/maps it WAS the entire meta
# description.
#
# Deliberately as NARROW as the renderer. This mirrors the one tokenizer that
# turns these into widgets, `ts/svelte/free2z/src/lib/utils/markdown.ts`:
#
#     /^ {0,3}::(embed|iframe|qrcode)\[([^\]\n]+)\][ \t]*(?:\n|$)/i
#
# line-anchored, a closed set of three names, brackets required. `re.A`
# alongside `re.I` here and on the autolink rule below: Python's Unicode-aware
# IGNORECASE folds U+0130 onto `i` and U+017F onto `s`, which JavaScript's
# non-unicode `/i` does not, so `::Iframe[x]` spelled with U+0130 would be
# markup to Django and text to SvelteKit (codex adversarial review).
#
# A broader
# "any `::name`" rule reads `Use std::vector here` as markup and publishes
# `Use std here` -- text the article visibly renders, silently deleted from
# every card. Anything the renderer shows as literal text stays literal here.
_DIRECTIVE_RE = re.compile(
    r"^[ \t]{0,3}::(?:embed|iframe|qrcode)\[[^\]\n]+\][ \t]*$",
    re.M | re.I | re.A,
)

_IMAGE_RE = re.compile(r"!\[[^\]\n]*\]\([^)\n]*\)")
_LINK_RE = re.compile(r"\[([^\]\n]*)\]\([^)\n]*\)")
# `<https://example.com>` is an autolink, not an HTML tag. Stripping it as a
# tag would delete the URL entirely, so unwrap it before the tag pass.
_AUTOLINK_RE = re.compile(r"<((?:https?|mailto|ftp):[^>\s]+)>", re.I | re.A)
_HTML_COMMENT_RE = re.compile(r"<!--[\s\S]*?-->")
# A tag may span newlines (`<img\n src=...>`), so `[^<>]` and not `[^>\n]`.
# Requiring a letter (or `/`, or `!` for a declaration) after `<` is what keeps
# `latency < 200 and rate > 5` from being eaten as if it were a tag -- which
# both the old TypeScript `<[^>]*>` and Django's `strip_tags` got wrong.
_HTML_TAG_RE = re.compile(r"</?[A-Za-z!][^<>]*>")

_HEADING_RE = re.compile(r"^[ \t]{0,3}#{1,6}(?:[ \t]+|$)", re.M)
# `---`, `***`, `___`, `- - -`. Also swallows a setext underline.
_THEMATIC_BREAK_RE = re.compile(
    r"^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$", re.M
)
# A GFM table delimiter row: only pipes, colons, dashes and spaces, with at
# least one dash. `50-60` is safe (digits are outside the class).
_TABLE_DELIMITER_RE = re.compile(r"^[ \t]*\|?[-:| \t]*-[-:| \t]*$", re.M)
_BLOCKQUOTE_RE = re.compile(r"^[ \t]{0,3}(?:>[ \t]?)+", re.M)
# `[0-9]`, never `\d`: Python's `\d` matches Unicode digits and JavaScript's
# does not, so an Arabic article opening `\u0661....` would lose its numbering
# on the Django tier and keep it on SvelteKit (codex adversarial review).
_LIST_BULLET_RE = re.compile(
    r"^[ \t]{0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t]+", re.M,
)
_TASK_MARKER_RE = re.compile(r"^\[[ xX]\][ \t]+", re.M)

_CODE_TICKS_RE = re.compile(r"`+")
# `~~strike~~` only -- a bare `~` is a real character in paths like /~user.
_TILDE_RE = re.compile(r"~~+")
_ASTERISK_RE = re.compile(r"\*+")
_PIPE_RE = re.compile(r"\|")

# `_` is emphasis ONLY at a word boundary. CommonMark says the same thing, and
# the reason it is spelled out here rather than folded into a `[#*_>`~|]` class
# is a live defect: the old rule turned
# `https://youtu.be/abc_DEFgh12?si=sample_under_score` into
# `…si=AAMiA b4jz8To4ik` and published the broken URL in Google's snippet for
# /example_creator/video-example. Two alternatives rather than a lookbehind so
# the JavaScript twin needs no lookbehind either (Safari only gained it in
# 16.4, which is the app's exact browser floor — too close to bet a
# module-level SyntaxError on).
_EMPHASIS_UNDERSCORE_RE = re.compile(r"(^|[^0-9A-Za-z_])_+|_+([^0-9A-Za-z_]|$)")

_ESCAPE_RE = re.compile(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])")
_WHITESPACE_RE = re.compile(r"\s+")


def _strip_emphasis_underscores(text):
    return _EMPHASIS_UNDERSCORE_RE.sub(
        lambda m: (m.group(1) or "") + " " + (m.group(2) or ""), text,
    )


def strip_markdown(value):
    """Reduce markdown (or plain text, or HTML) to one line of prose.

    Not a markdown renderer and deliberately not trying to be one: it removes
    the constructs that make a meta description look broken, and leaves
    everything else — including hashtags, ``a > b``, and ``snake_case`` — alone.
    """
    text = value or ""
    # See DESCRIPTION_SOURCE_CHARS: both tiers read the same window, whatever
    # their caller happens to hold. Code points, so the two runtimes clamp at
    # the same character.
    if len(text) > DESCRIPTION_SOURCE_CHARS:
        text = text[:DESCRIPTION_SOURCE_CHARS]
    text = _CARRIAGE_RETURN_RE.sub("\n", text)
    text = _EXOTIC_WHITESPACE_RE.sub(" ", text)

    text = _BACKTICK_FENCE_RE.sub(" ", text)
    text = _BACKTICK_FENCE_OPEN_RE.sub(" ", text)
    text = _TILDE_FENCE_RE.sub(" ", text)
    text = _TILDE_FENCE_OPEN_RE.sub(" ", text)

    # Escapes are unwrapped HERE, before any marker is stripped. The other
    # order leaves a stray `\` in the attribute once the `*` it protected has
    # been removed, which is worse than losing the literal.
    text = _ESCAPE_RE.sub(r"\1", text)

    text = _DIRECTIVE_RE.sub(" ", text)
    text = _IMAGE_RE.sub(" ", text)
    text = _LINK_RE.sub(r"\1", text)
    text = _AUTOLINK_RE.sub(r"\1", text)
    text = _HTML_COMMENT_RE.sub(" ", text)
    text = _HTML_TAG_RE.sub(" ", text)

    text = _HEADING_RE.sub("", text)
    text = _THEMATIC_BREAK_RE.sub(" ", text)
    text = _TABLE_DELIMITER_RE.sub(" ", text)
    text = _BLOCKQUOTE_RE.sub("", text)
    text = _LIST_BULLET_RE.sub("", text)
    text = _TASK_MARKER_RE.sub("", text)

    text = _CODE_TICKS_RE.sub("", text)
    text = _TILDE_RE.sub("", text)
    text = _ASTERISK_RE.sub("", text)
    text = _PIPE_RE.sub(" ", text)
    text = _strip_emphasis_underscores(text)

    return _WHITESPACE_RE.sub(" ", text).strip()


def truncate(text, max_length=META_DESCRIPTION_CHARS):
    """Bound ``text`` to ``max_length`` CODE POINTS, ellipsis included.

    ``text`` is expected to be whitespace-collapsed already (so the only
    whitespace is a single U+0020), which is what makes the word-boundary
    search a plain search for the last space.
    """
    chars = list(text)
    if len(chars) <= max_length:
        return text

    window = chars[:max_length - 1]
    while window and window[-1] == " ":
        window.pop()
    last_space = -1
    for index in range(len(window) - 1, -1, -1):
        if window[index] == " ":
            last_space = index
            break
    if last_space > _word_boundary_floor(max_length):
        window = window[:last_space]
    while window and window[-1] == " ":
        window.pop()
    return "".join(window) + ELLIPSIS


def compact_text(value, fallback="", max_length=META_DESCRIPTION_CHARS):
    """The public entry point: markdown in, one bounded line of prose out."""
    text = strip_markdown(value)
    if not text:
        text = strip_markdown(fallback)
    return truncate(text, max_length)
