"""
Enumerate the uploads a zPage body embeds.

Nothing in this repository has ever known what media a zPage contains --
`stripMarkdown()` and `meta_description.strip_markdown()` both *delete*
`::embed[...]` -- so the SSR tier had no way to emit `VideoObject`
structured data or a `poster=` attribute for a video in the body.

Design notes
------------
**The markdown SOURCE is the input, not the rendered HTML.** The frontend's
`sanitizeMarkdownHtmlForMarkup` returns `""` above its cost ceilings
(`SSR_MARKUP_MAX_CHARS` and friends) and defers the body to the client;
deriving the media list from rendered markup would silently inherit that
failure mode and drop the structured data for exactly the longest pages.

**Only what the renderer actually renders.** The frontend tokenizer is
`/^ {0,3}::(embed|iframe|qrcode)\\[([^\\]\\n]+)\\][ \\t]*(?:\\n|$)/i` at
*block* level, so this mirrors the same anchor, the same indent budget and
the same "rest of the line must be blank" rule, and strips fenced code
blocks first -- an `::embed[...]` inside a ``` fence is displayed as code
by marked and must not be advertised as an indexed video.

**Access is reported, never assumed.** `is_public` is the exact predicate
`uploads.views._public_access_ok` enforces on the anonymous
`/uploadz/public/...` tier (`access == "public"` AND the owner is still
active), because that is the only route a crawler can fetch. A caller must
not advertise a `contentUrl` for anything else.
"""
import re
from urllib.parse import unquote, urlsplit

from django.db.models import Q

from rest_framework import serializers

from dj.apps.uploads.models import GenericFile

# The frontend block tokenizer is `^ {0,3}::embed[...]` -- but `marked` runs
# it RECURSIVELY, on the contents of list items and blockquotes with their
# markers already stripped. So `-::embed[...]` and `>::embed[...]` render
# real, visible `<video>` elements (verified against `processMarkdown`), and a
# raw-source pattern anchored at the line start alone finds neither: the video
# is on the page, and the media list says the page has none. Markdown is not
# re-implemented here; the container markers a directive can legitimately sit
# behind are matched explicitly, and everything else keeps the tokenizer's own
# rules -- at most three spaces of indent, and the directive owning the rest of
# the line.
_LIST_MARKER = r"(?:[-*+]|\d{1,9}[.)])[ \t]+"
_BLOCKQUOTE = r"(?:>[ \t]{0,3})+"
#One optional container prefix: blockquotes (any depth), optionally followed
#by a list marker, OR a bare list marker. The extra indent budget lives
#INSIDE this group on purpose -- allowing it unconditionally would make a
#4-space-indented directive (an indented code block, which the tokenizer
#refuses) match after all.
_CONTAINER_PREFIX = (
    r"(?:(?:" + _BLOCKQUOTE + r"(?:" + _LIST_MARKER + r")?"
    r"|" + _LIST_MARKER + r")[ \t]{0,3})?"
)
#`embed` AND `iframe`, but never `qrcode` (codex adversarial review).
#`renderDirective` in markdown.ts dispatches `qrcode` to a QR div and sends
#EVERYTHING ELSE with a `/uploadz/` value through `renderUploadEmbed`, which
#renders a real `<video>` for a video extension. So `::iframe[...clip.mp4]`
#puts a video on the page exactly like `::embed` does, and matching only
#`embed` here meant those videos silently got no poster and no VideoObject
#-- a quiet under-report rather than a fabrication, but a real one.
_DIRECTIVE_NAMES = "embed|iframe"

EMBED_DIRECTIVE_RE = re.compile(
    r"^ {0,3}" + _CONTAINER_PREFIX
    + r"::(?:" + _DIRECTIVE_NAMES + r")\[([^\]\n]+)\][ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

#The SAME prefix, on its own, so the fence scanner can look through exactly
#what the directive regex looks through. Two different answers to "is this
#line inside a blockquote or a list item?" is how a fenced embed gets
#advertised as a real video.
_CONTAINER_PREFIX_RE = re.compile(r"^ {0,3}" + _CONTAINER_PREFIX)

# CommonMark fenced code blocks, which `marked` implements: an opener of 3+
# backticks or tildes indented by at most 3 spaces, closed by at least as many
# of the SAME character (also indented at most 3), or by end of document.
# A regex with a `(?P=fence)` backreference gets both of those wrong -- it
# cannot express "at least as long", and a first draft also missed indented
# openers -- so this is a line scanner.
#A PORT of `stripLeadingFrontmatter` in ts/svelte/free2z/src/lib/utils/
#markdown.ts. The renderer removes a leading `---` block before `marked`
#ever sees it, so a directive inside frontmatter puts NO video on the page
#-- and a backend that scanned the raw body reported one anyway, emitting a
#`VideoObject` for media that is not there (codex adversarial review). Same
#class as the fenced-block case, same rule: whatever the renderer removes
#before rendering, this must remove before scanning.
FRONTMATTER_RE = re.compile(
    r"^\ufeff?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)"
)

FENCE_OPEN_RE = re.compile(r"^(`{3,}|~{3,})")
FENCE_CLOSE_RE = re.compile(r"^(`{3,}|~{3,})[ \t]*$")

# Mirrors VIDEO_EXTENSION_PATTERN in ts/svelte/free2z/src/lib/utils/markdown.ts.
# Only these three reach `renderVideoEmbed`; anything else is an image, an
# audio placeholder or an external-embed placeholder.
VIDEO_EXTENSION_RE = re.compile(r"\.(mp4|webm|mov)(?:[?#].*)?$", re.IGNORECASE)

FREE2Z_UPLOAD_HOST_RE = re.compile(r"(^|\.)free2z\.(?:cash|com|net)$", re.I)

PUBLIC_PREFIX = "/uploadz/public/"
PRIVATE_PREFIX = "/uploadz/"

# Ceiling on how many distinct video embeds one page reports. A zPage body has
# no length limit a directive count is bounded by, and this runs on an
# ANONYMOUS detail request: without a cap, one published page referencing
# thousands of uploads turns every request for it into a thousand-element `IN`
# query, a thousand serializer objects and a thousand JSON-LD nodes. Ten videos
# is already far beyond anything in the affected corpus, and a page that
# genuinely has more gets structured data for its first `MAX_EMBEDDED_MEDIA`
# rather than a slow response.
MAX_EMBEDDED_MEDIA = 10


class EmbeddedMediaSerializer(serializers.Serializer):
    """One upload embedded in a zPage body. Read-only, derived from `content`."""

    embed_url = serializers.CharField(
        help_text=(
            "The URL exactly as written in `content`. This is the join key: "
            "match it against the embed a renderer is about to draw. It is "
            "NOT necessarily the served URL -- an author may write an "
            "absolute `https://free2z.cash/uploadz/...` form."
        ),
    )
    url = serializers.CharField(
        help_text="Canonical served URL, derived from the upload's access level.",
    )
    kind = serializers.CharField(help_text="Currently always `video`.")
    mime_type = serializers.CharField()
    access = serializers.CharField(help_text="`public`, `members` or `private`.")
    is_public = serializers.BooleanField(
        help_text=(
            "True only when an ANONYMOUS request can fetch the bytes: "
            "`access == \"public\"` and the owner is still active. Do not "
            "advertise a `contentUrl` (or any crawler-visible URL) for a "
            "false value."
        ),
    )
    poster = serializers.CharField(
        allow_null=True,
        help_text=(
            "Extracted poster-frame URL, or null when none has been "
            "generated. Null means this video has no thumbnail: emit no "
            "`thumbnailUrl` rather than inventing one."
        ),
    )
    title = serializers.CharField(
        allow_blank=True, help_text="The upload's own title. Often blank."
    )
    description = serializers.CharField(allow_blank=True)
    uploaded_at = serializers.DateTimeField(
        help_text="`GenericFile.created_at` -- when the file was uploaded."
    )


def _info_string_rejects_fence(match, line: str) -> bool:
    """
    CommonMark: a BACKTICK fence's info string may not contain a backtick.

    ```` ```js `x` ```` is an inline-code paragraph, not a code block, so
    `marked` renders any `::embed[...]` after it normally. Treating it as a
    fence here would hide a real video from the media list -- and from the
    structured data -- until some later line happened to close it. (Tilde
    fences have no such restriction.)
    """
    fence = match.group(1)
    if fence[0] != "`":
        return False
    return "`" in line[len(fence):]


def _strip_fenced_blocks(content: str) -> str:
    """
    Blank out fenced code blocks, preserving line structure.

    An `::embed[...]` inside a fence renders as CODE, so advertising it would
    declare a video the page does not contain. An UNCLOSED fence runs to the
    end of the document in CommonMark, and this follows that -- so a page can
    hide its own later embeds from the media list, which is the safe
    direction to be wrong in.

    THE CONTAINER PREFIX IS STRIPPED FIRST, and it has to be, because
    `EMBED_DIRECTIVE_RE` accepts one (codex adversarial review). Without it
    the two disagree in the worst possible direction:

        > ```md
        >::embed[/uploadz/public/u/video.mp4]
        > ```

    `marked` renders that as code -- the fence opens inside the blockquote --
    while a fence scanner that only strips spaces sees no fence at all and
    reports a real video. The page would then carry a `VideoObject` for media
    it does not contain, which is precisely the fabricated structured data
    this whole change exists to avoid emitting. Whatever prefix the directive
    regex will look through, this must look through too.

    Being loose about WHICH container a fence closes in is deliberate: over-
    stripping drops a `VideoObject`, under-stripping invents one.
    """
    lines = []
    fence = None  # (character, length) of the open fence
    for line in (content or "").split("\n"):
        prefix = _CONTAINER_PREFIX_RE.match(line)
        body = line[prefix.end():] if prefix else line
        stripped = body.lstrip(" ")
        indent = len(body) - len(stripped)
        if indent > 3:
            # 4+ spaces is an indented code block, which the embed tokenizer
            # already refuses via its own ` {0,3}` budget.
            lines.append("" if fence else line)
            continue
        if fence is None:
            match = FENCE_OPEN_RE.match(stripped)
            if match and not _info_string_rejects_fence(match, stripped):
                fence = (match.group(1)[0], len(match.group(1)))
                lines.append("")
                continue
            lines.append(line)
            continue
        match = FENCE_CLOSE_RE.match(stripped)
        if (
            match
            and match.group(1)[0] == fence[0]
            and len(match.group(1)) >= fence[1]
        ):
            fence = None
        lines.append("")
    return "\n".join(lines)


def embed_values(content: str):
    """Ordered, de-duplicated `::embed[...]` values from a markdown body.

    CRLF is normalized first. `marked` normalizes line endings before it
    tokenizes; Python's `$` under `re.MULTILINE` matches BEFORE the `\n` but
    AFTER a `\r`, so without this a body saved from a Windows editor would
    match nothing at all and every video on it would silently vanish from the
    structured data -- with no error anywhere.
    """
    normalized = (content or "").replace("\r\n", "\n").replace("\r", "\n")
    # ORDER MATTERS: frontmatter is removed before the fence scan and before
    # the directive scan, because that is the order `processMarkdown` does it
    # in -- `stripLeadingFrontmatter` runs first, then `marked` tokenizes what
    # is left. Scanning the raw body instead reports directives the reader
    # never sees.
    normalized = FRONTMATTER_RE.sub("", normalized, count=1)
    seen = set()
    values = []
    for match in EMBED_DIRECTIVE_RE.finditer(_strip_fenced_blocks(normalized)):
        value = match.group(1).strip()
        if value and value not in seen:
            seen.add(value)
            values.append(value)
    return values


def upload_name_for_embed(value: str):
    """
    Storage name (`<username>/<file>`) an embed value refers to, or None.

    Accepts the two forms the frontend resolves to an upload: a
    root-relative `/uploadz/...` path, and an absolute URL on a free2z host
    whose path is `/uploadz/...` (`rewriteFree2zUploadUrl`).
    """
    path = None
    if value.startswith("/") and not re.match(r"^/[/\\]", value):
        path = value.split("?", 1)[0].split("#", 1)[0]
    else:
        try:
            parts = urlsplit(value)
        except ValueError:
            return None
        if parts.scheme in ("http", "https") and parts.hostname:
            if FREE2Z_UPLOAD_HOST_RE.search(parts.hostname):
                path = parts.path

    if not path or not path.startswith(PRIVATE_PREFIX):
        return None

    if path.startswith(PUBLIC_PREFIX):
        name = path[len(PUBLIC_PREFIX):]
    else:
        name = path[len(PRIVATE_PREFIX):]

    name = unquote(name)
    # Defence in depth: a name is `<username>/<file>` and nothing else. A
    # traversal segment cannot reach another row through an exact `file`
    # match anyway, but refusing it keeps the shape stated rather than
    # inferred.
    if not name or ".." in name.split("/"):
        return None
    return name


def embedded_media(content: str, creator=None):
    """
    Serialized list of the VIDEO uploads embedded in `content`.

    Videos only, for now: they are what  is about and the only media
    type with a `VideoObject`-shaped structured-data contract. Embeds that
    do not resolve to a row we own are omitted entirely -- a third-party
    URL, a deleted upload and a typo are all "we know nothing about this",
    and structured data must never be produced from a guess.

    **Resolution is scoped, and that is a security boundary, not a tidiness
    rule.** `content` is author-controlled and this runs on an ANONYMOUS
    request, so an unscoped lookup would answer "does `/uploadz/<someone
    else>/<guess>.mp4` exist, and what is its title, description, upload time
    and access level" for any name an author cares to write -- an existence
    and metadata oracle over other people's PRIVATE uploads, reachable by
    publishing a page. A row therefore only resolves when it is either the
    page creator's own (they can already see it) or genuinely public
    (`access == "public"` and the owner is active -- the same predicate the
    anonymous `/uploadz/public/` tier enforces, so nothing is disclosed that
    is not already served to anyone who asks).

    `creator=None` resolves ONLY public rows. Callers that know the page's
    owner should pass it.
    """
    values = embed_values(content)
    if not values:
        return []

    order = {}
    for value in values:
        if not VIDEO_EXTENSION_RE.search(value.split("#", 1)[0]):
            continue
        name = upload_name_for_embed(value)
        if not name or name in order:
            continue
        order[name] = (len(order), value)
        if len(order) >= MAX_EMBEDDED_MEDIA:
            break
    if not order:
        return []

    visible = Q(access="public", owner__is_active=True)
    if creator is not None:
        visible = visible | Q(owner=creator)

    rows = GenericFile.objects.filter(
        visible,
        file__in=list(order.keys()),
        mime_type__startswith="video",
    ).select_related("owner").prefetch_related("variants")

    payload = []
    for row in rows:
        position, embed_url = order[row.file.name]
        is_public = row.access == "public" and row.owner.is_active
        is_own_public = is_public and creator is not None and (
            row.owner_id == creator.pk
        )
        payload.append((position, {
            "embed_url": embed_url,
            "url": row.get_url(),
            "kind": "video",
            "mime_type": row.mime_type,
            "access": row.access,
            # Exactly uploads.views._public_access_ok. Kept as an explicit
            # expression rather than an import so the two can be diffed:
            # this one answers "may a crawler be told about it", which must
            # never become more permissive than what nginx will serve.
            "is_public": is_public,
            "poster": row.get_poster(),
            # DESCRIPTIVE METADATA NEEDS TWO THINGS TO BE TRUE, not one.
            #
            # Gated rows report none: the URL is already in a page body an
            # anonymous reader can see, and the poster is behind the same auth
            # as the video, but the upload's title and description were never
            # anonymously readable and a page embedding its creator's own
            # members-only video must not become the place they are.
            #
            # Nor is "the bytes are public" sufficient on its own (codex
            # adversarial review). `title` and `description` are owner-managed
            # fields that `MyUploadsViewSet` exposes to the OWNER alone, and
            # upload access defaults to public -- so anyone who can guess a
            # public upload path could publish a page embedding it and read
            # back metadata that serving the bytes never disclosed. Public
            # bytes do not imply public management metadata.
            #
            # So: only the page creator's OWN uploads contribute their title
            # and description. Somebody else's public video still gets a
            # perfectly good `VideoObject` -- `buildVideoObjects` already
            # falls back to the page's own title and description, which is
            # what a reader meets it as anyway.
            "title": (row.title or "") if is_own_public else "",
            "description": (
                (row.description or "") if is_own_public else ""
            ),
            "uploaded_at": row.created_at,
        }))

    # Document order -- the order a reader meets them in. Sorted on a
    # precomputed index rather than `list.index()`, which would make this
    # quadratic in the number of embeds on an anonymous request path.
    payload.sort(key=lambda item: item[0])
    return EmbeddedMediaSerializer(
        [item[1] for item in payload], many=True,
    ).data
