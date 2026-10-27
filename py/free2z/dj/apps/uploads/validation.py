"""
Server-side upload type allowlist.

Why this module exists
----------------------
Uploaded objects are served from `https://free2z.cash` — the same cookie-bearing
origin as the app. `k8s/free2z/nginx.conf` permits image/video/audio extensions
registered in `dj.util.mimetypes_registry` to render inline. That registry
contains both the currently accepted media extensions below and passive
historical formats still in the bucket; documents, archives, and unknown
extensions receive `Content-Disposition: attachment`. The `Content-Type` the
browser sees is derived by django-storages purely from the *stored file name*:

    storages/backends/gcloud.py:45
        self.mime_type, self.mime_encoding = mimetypes.guess_type(name)

So the stored extension — not the DB `mime_type` column, not the byte content —
decides how a browser treats the response. `evil.svg` becomes
`Content-Type: image/svg+xml`, `evil.html` becomes `text/html`, and both are
*active documents*: they execute attacker JavaScript in the free2z.cash origin.
`X-Content-Type-Options: nosniff` does not help (it stops sniffing, not an
explicitly declared active type) and CSP does not help while `'unsafe-inline'`
is in `script-src`.

The invariant this module establishes
-------------------------------------
For every file arriving through the two **user-facing upload views**
(`uploads_handle`, `single_public_upload_handle`), all three of these agree and
are on an explicit allowlist of **passive** media types:

  1. the actual leading bytes of the file (sniffed here — the only one the
     attacker cannot lie about),
  2. the extension of the name we store (which is what nginx/GCS turn into the
     served `Content-Type`),
  3. the `Content-Type` the browser *claimed* on the multipart part
     (`UploadedFile.content_type`) — trusted for nothing, but a claim naming
     an off-allowlist type is treated as hostile and rejected.

Fail closed: anything whose bytes we cannot positively identify as an allowlisted
type is rejected, including every text-shaped format (SVG, HTML, XHTML, XML,
JS,...), which by construction has no reliable magic signature.

What this does NOT cover
------------------------
Three paths construct a `GenericFile` straight through the ORM and never reach
`validate_upload()`:

  * `GenericFile.create_from_prompt` and `dj.apps.storytime.views` — bytes
    fetched from the OpenAI image API, named `<slug>.png` by us.
  * `dj.apps.dyte.management.commands.dyte_download_upload` — recordings pulled
    from Dyte, whose `mime_type` comes from the remote `Content-Type` header
    and which writes through `storage.save()` directly, so it does not even go
    through `get_upload_path`/`sanitize_extension`.

All three are **vendor-controlled, not user-controlled**, so none is the
vector. They are nevertheless the remaining places where a stored name is not
proven to match its bytes, and tightening them is a follow-up.

No new dependency
-----------------
libmagic/python-magic is not in `py/requirements/main.txt` and pulling a system
shared library into the runtime image for this would be a bigger blast radius
than the ~60 lines of signature matching below. Pillow (already pinned) does a
header-deep second-stage confirmation for the raster types — see
`_PILLOW_FORMATS` for exactly how far that goes, and how far it does not.
"""
import mimetypes
import os
import re

from django.core.exceptions import ValidationError
from PIL import Image, UnidentifiedImageError

# Bytes of the file we look at to identify it. Every signature below lives
# well inside this window.
SNIFF_BYTES = 4096


class UploadTypeError(ValidationError):
    """
    A rejected upload. Carries a user-safe explanation in `.detail`; the
    views turn it into a clean 400 (never a 500).
    """

    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


# --------------------------------------------------------------------------
# The allowlist.
#
# Deliberately limited to formats browsers render *passively*. Each maps to
# the extensions we accept for it; the first entry is the canonical one we
# fall back to when the uploaded name carries no usable extension.
#
# NOT on this list, on purpose:
#   image/svg+xml  - an SVG is a scriptable document (<script>, on* handlers,
#                    <foreignObject>, external refs, CSS @import). Sanitizing
#                    it is a mutation-XSS arms race with no vetted Python
#                    sanitizer in our dependency set, and it would still be
#                    served as an active type from the cookie origin. Dropped.
#   text/html, application/xhtml+xml, application/xml, text/xml, image/svg+xml
#                  - active documents, the actual  payload.
#   text/plain, application/zip,...
#                  - no reliable magic signature, and no product need.
#
# application/pdf IS on the list: it is the one active-ish format with a real
# product need (tax documents — the live example in  is an `fw9.pdf`).
# Script inside a PDF runs in the viewer's isolated context, not in the
# free2z.cash DOM, so it is not a stored-XSS vector the way SVG/HTML are. It
# remains a phishing surface, so nginx serves it with
# `Content-Disposition: attachment`; the upload allowlist alone cannot impose
# that response policy.
# --------------------------------------------------------------------------
ALLOWED_TYPE_EXTENSIONS: dict[str, tuple[str, ...]] = {
    # raster images
    'image/jpeg': ('.jpg', '.jpeg', '.jpe'),
    'image/png': ('.png',),
    'image/gif': ('.gif',),
    'image/webp': ('.webp',),
    # Modern phone formats. Passive rasters and trivially sniffable (both are
    # ISO-BMFF with their own brands). Our pinned Pillow 10.3 cannot *decode*
    # either, so they get no second-stage confirmation and no WebP ladder —
    # see NON_RASTER_IMAGE_MIME_TYPES. Accepting them costs nothing and stops
    # an API client breaking the day iOS stops transcoding.
    # `image/heic` is our canonical label for the WHOLE HEIF family, not just
    # HEVC-coded stills: `image/heif`, `image/heic-sequence` and
    # `image/heif-sequence` all normalize here (DECLARED_TYPE_ALIASES) and
    # `.heif` is served as `image/heic` (dj.util.mimetypes_registry). Collapsing
    # them is deliberate — one label the DB, the API and the served header can
    # all agree on — and it is why an AV1-coded HEIF is worth telling apart (see
    # _GENERIC_MIAF_BRANDS) while a JPEG- or VVC-coded one is not: Pillow 10.3
    # decodes none of them, so the label only picks which passive extension we
    # store, never whether the bytes are safe.
    #
    # The image-*sequence* extensions are here too. `.heics`/`.heifs`
    # resolve on the Debian base image (python:3.10-bullseye at the time) — via
    # /etc/mime.types, to `image/heic-sequence` / `image/heif-sequence` — so
    # before  the "extension names a format we do not accept" branch in
    # `validate_upload()` turned an honest `burst.heics` into a hard 400, even
    # though its `ftyp` brand (`hevc`/`hevx`/`hevm`/`hevs`/`msf1`) sniffs fine
    # and its declared type is already aliased. `.avifs` is the AVIF sequence
    # equivalent; it resolves to None on that image, so it was silently
    # renamed rather than rejected, but it is the same omission and is listed
    # for the same reason. All four collapse onto the same two canonical
    # labels as the stills — a sequence is still a passive raster, Pillow 10.3
    # decodes neither, and `dj.util.mimetypes_registry` serves all of them as
    # `image/heic` / `image/avif` so the DB column, the API and the response
    # header keep agreeing. The canonical fallback extension is still
    # `.heic` / `.avif` (first entry), so nothing that lacks a usable
    # extension starts being stored as a sequence.
    'image/heic': ('.heic', '.heif', '.heics', '.heifs'),
    'image/avif': ('.avif', '.avifs'),
    # video
    'video/mp4': ('.mp4', '.m4v'),
    'video/webm': ('.webm',),
    'video/quicktime': ('.mov', '.qt'),
    # audio
    'audio/mpeg': ('.mp3',),
    'audio/mp4': ('.m4a', '.m4b'),
    'audio/ogg': ('.ogg', '.oga', '.opus'),
    'audio/wav': ('.wav',),
    # documents
    'application/pdf': ('.pdf',),
}

ALLOWED_MIME_TYPES: tuple[str, ...] = tuple(ALLOWED_TYPE_EXTENSIONS)

# Extension -> canonical type, derived from the table above so the two can
# never drift apart.
EXTENSION_TO_TYPE: dict[str, str] = {
    ext: mime
    for mime, exts in ALLOWED_TYPE_EXTENSIONS.items()
    for ext in exts
}

# Sorted, dot-less, for FileExtensionValidator on the model field.
ALLOWED_EXTENSIONS: tuple[str, ...] = tuple(
    sorted(ext.lstrip('.') for ext in EXTENSION_TO_TYPE)
)

# Types the browser may legitimately declare for an allowlisted file but which
# are spelled differently from our canonical name. Normalizing these keeps the
# "declared must agree" check from rejecting honest uploads.
#
# This table is NOT a second allowlist and it cannot widen the first one. An
# alias only ever feeds `normalize_declared_type()`, whose result is used for
# exactly two things: the off-allowlist tripwire at the end of
# `validate_upload()`, and picking between the three ISO_BMFF_FAMILY labels.
# `resolved` still starts life as the *sniffed* type, so no entry here can make
# an unsniffable format (SVG, HTML, XML, JS — the  payloads) acceptable:
# those never get past `sniff_media_type()` in the first place. The values are
# asserted to be canonical allowlist members, and the keys asserted never to be
# an ACTIVE_MIME_TYPES spelling, in
# test_upload_type_allowlist.py::test_declared_type_aliases_cannot_widen_the_allowlist.
DECLARED_TYPE_ALIASES = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/x-png': 'image/png',
    # HEIF family. One ISO-BMFF container, four registered type strings:
    # `image/heic` + `image/heif` for a single image and the `-sequence`
    # spellings for a multi-image one. We canonicalize the whole family to
    # `image/heic` (ALLOWED_TYPE_EXTENSIONS maps both `.heic` and `.heif`
    # there), but a client declares whatever *its* MIME database says — and the
    # standard Linux/Android `mime.types` says `image/heif` for a `.heif` file.
    # iOS/Safari happens to say `image/heic`, which is the only reason this
    # false rejection was not loud. The bytes are unaffected either way: a
    # `.heif` sniffs as `image/heic` from its `ftyp` brand regardless of what
    # the client claims.
    'image/heif': 'image/heic',
    'image/x-heic': 'image/heic',
    'image/x-heif': 'image/heic',
    'image/heic-sequence': 'image/heic',
    'image/heif-sequence': 'image/heic',
    'image/avif-sequence': 'image/avif',
    'video/x-m4v': 'video/mp4',
    'video/x-quicktime': 'video/quicktime',
    'audio/mp3': 'audio/mpeg',
    'audio/x-mpeg': 'audio/mpeg',
    'audio/mpeg3': 'audio/mpeg',
    'audio/x-mpeg-3': 'audio/mpeg',
    'audio/x-m4a': 'audio/mp4',
    'audio/mp4a-latm': 'audio/mp4',
    'audio/m4a': 'audio/mp4',
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/vnd.wave': 'audio/wav',
    'audio/opus': 'audio/ogg',
    'application/x-pdf': 'application/pdf',
    'application/acrobat': 'application/pdf',
}

# A browser that does not recognize a file sends one of these. That is not a
# claim, so it cannot conflict with anything.
NEUTRAL_DECLARED_TYPES = frozenset({
    '',
    'application/octet-stream',
    'binary/octet-stream',
    'application/unknown',
    'application/force-download',
})

# Extensions whose *served* Content-Type makes the response an active document.
# Used by the remediation command (`audit_active_uploads`) to find rows that
# predate this allowlist; kept here so the definition of "active" lives in one
# place.
ACTIVE_EXTENSIONS = frozenset({
    '.svg', '.svgz', '.html', '.htm', '.xhtml', '.xht', '.shtml',
    '.xml', '.xsl', '.xslt', '.rdf', '.mhtml', '.mht',
    '.js', '.mjs', '.swf', '.htc', '.hta', '.vtt', '.jar',
})

ACTIVE_MIME_TYPES = frozenset({
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
    'text/xsl',
    'application/rdf+xml',
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'application/x-shockwave-flash',
    'multipart/related',
    'application/java-archive',
})


# --------------------------------------------------------------------------
# Byte sniffing
# --------------------------------------------------------------------------

# ISO base media file format brands. `ftyp` sits at offset 4; the major brand
# at offset 8 is the best hint we have about audio vs video vs QuickTime.
#
# "Best hint" is doing real work in that sentence: the generic brands (`isom`,
# `mp41`, `mp42`,...) say nothing about whether the tracks are audio-only.
# ffmpeg writes an audio-only AAC file with major brand `isom`, so a perfectly
# ordinary `.m4a` sniffs as `video/mp4`. That is why ISO_BMFF_FAMILY exists
# below — inside this family the extension gets to decide. Every member of the
# family is passive media, so nothing about  turns on which one we pick.
_FTYP_BRANDS = {
    b'isom': 'video/mp4', b'iso2': 'video/mp4', b'iso4': 'video/mp4',
    b'iso5': 'video/mp4', b'iso6': 'video/mp4', b'mp41': 'video/mp4',
    b'mp42': 'video/mp4', b'avc1': 'video/mp4', b'mmp4': 'video/mp4',
    b'dash': 'video/mp4', b'MSNV': 'video/mp4', b'M4V ': 'video/mp4',
    b'M4VH': 'video/mp4', b'M4VP': 'video/mp4', b'M4P ': 'video/mp4',
    b'M4A ': 'audio/mp4', b'M4B ': 'audio/mp4', b'F4A ': 'audio/mp4',
    b'qt  ': 'video/quicktime',
    # HEIF family (iPhone) and AVIF. Unambiguous brands, unlike the generic
    # mp4 ones, so they are not part of ISO_BMFF_FAMILY below.
    #
    # All ten HEIF brands are here on purpose, and the set is pinned by
    # test_every_heif_brand_is_identified. It is exactly the union of the
    # brands IANA registers for image/heic, image/heic-sequence, image/heif and
    # image/heif-sequence:
    #
    #   heic heix heim heis   HEVC still image (plain, 10-bit, and the
    #                         alpha/depth auxiliary variants)  [image/heic]
    #   hevc hevx hevm hevs   HEVC image sequence     [image/heic-sequence]
    #   mif1                  codec-agnostic MIAF still image        [image/heif]
    #   msf1                  codec-agnostic MIAF sequence  [image/heif-sequence]
    #
    # An iPhone writes `heic` or `heix` as the major brand with `mif1` in the
    # compatible list; Canon and Fujifilm write `mif1`. Missing any one of these
    # rejects an honest camera photo with "this file type is not allowed", which
    # is the  failure mode by another route, so the set is kept complete.
    # `hevm`/`hevs` came from the codex review on  — they were the only two
    # registered brands the original list omitted.
    #
    # All ten map to the single canonical label `image/heic`, the sequence
    # brands included: we serve every one of them from a `.heic`/`.heif` name,
    # and all are equally passive rasters. See _GENERIC_MIAF_BRANDS for the one
    # place that label gets refined.
    b'heic': 'image/heic', b'heix': 'image/heic', b'heim': 'image/heic',
    b'heis': 'image/heic', b'hevc': 'image/heic', b'hevx': 'image/heic',
    b'hevm': 'image/heic', b'hevs': 'image/heic',
    b'mif1': 'image/heic', b'msf1': 'image/heic',
    b'avif': 'image/avif', b'avis': 'image/avif',
}

# One container, three allowlisted labels that a `ftyp` box cannot reliably
# tell apart. Within this set the stored extension (and failing that, the
# client's declaration) picks the label, because the extension is what becomes
# the served Content-Type and all three are equally passive. Outside this set
# a mismatch is still a hard rejection.
ISO_BMFF_FAMILY = frozenset({'video/mp4', 'audio/mp4', 'video/quicktime'})

# `mif1`/`msf1` are MIAF brands, not codec brands: they say "this is a MIAF
# image (sequence)" and nothing about what coded it. An AV1-coded file — an AVIF
# by any other name — is a conforming HEIF, and encoders do ship one with major
# brand `mif1` and `avif` only in the *compatible* brand list. Reading the major
# brand alone labels that image/heic and stores it `.heic`.
#
# So when the major brand is one of these, scan the compatible list for a
# codec-specific brand. Two hard limits keep this from being a widening:
# it only runs when the major brand ALREADY resolved to an allowlisted type,
# and it can only ever produce one of _MIAF_CODEC_TYPES — never a video or
# audio label, which a stray `isom` in a compatible list would otherwise
# manufacture out of a still image.
_GENERIC_MIAF_BRANDS = frozenset({b'mif1', b'msf1'})
_MIAF_CODEC_TYPES = frozenset({'image/heic', 'image/avif'})


def _refine_miaf_brand(head: bytes) -> str | None:
    """
    A codec-specific image type from the `ftyp` compatible-brands list, or None
    to fall back to the major brand. See _GENERIC_MIAF_BRANDS.
    """
    size = int.from_bytes(head[:4], 'big')
    # 16 = 4 size + 4 'ftyp' + 4 major brand + 4 minor version; a compatible
    # list needs at least one more 4-byte brand after that. A 0 or 1 size means
    # "to end of file" / 64-bit extended, neither of which belongs on an ftyp
    # box, and a size past the sniff window is not something we can trust.
    if size < 20 or size > len(head):
        return None
    for start in range(16, size - 3, 4):
        brand = head[start:start + 4]
        if brand in _GENERIC_MIAF_BRANDS:
            continue
        candidate = _FTYP_BRANDS.get(brand)
        if candidate in _MIAF_CODEC_TYPES:
            return candidate
    return None


def _sniff_mpeg_audio(head: bytes) -> bool:
    """
    True for a bare MPEG audio stream (no ID3 tag): an 11-bit frame sync
    followed by a version/layer/bitrate combination that is not one of the
    reserved encodings. The reserved-value checks matter — without them any
    file whose first two bytes happen to be `FF Ex` sniffs as audio.
    """
    if len(head) < 4 or head[0] != 0xFF or (head[1] & 0xE0) != 0xE0:
        return False
    version = (head[1] >> 3) & 0x03
    layer = (head[1] >> 1) & 0x03
    bitrate = (head[2] >> 4) & 0x0F
    sample_rate = (head[2] >> 2) & 0x03
    if version == 0x01 or layer == 0x00:      # reserved MPEG version / layer
        return False
    if bitrate in (0x00, 0x0F):               # "free" and "bad" bitrates
        return False
    if sample_rate == 0x03:                   # reserved sample rate
        return False
    return True


def sniff_media_type(head: bytes) -> str | None:
    """
    Identify `head` (the first SNIFF_BYTES of a file) as one of
    ALLOWED_MIME_TYPES, or return None.

    None means "not an allowlisted media file" — including every text format,
    which is exactly the property  needs: SVG/HTML/XML have no binary
    signature and can never pass.
    """
    if len(head) < 4:
        return None

    if head.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if head.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if head.startswith(b'RIFF') and len(head) >= 12:
        if head[8:12] == b'WEBP':
            return 'image/webp'
        if head[8:12] == b'WAVE':
            return 'audio/wav'
        return None
    if head.startswith(b'%PDF-'):
        return 'application/pdf'
    if head.startswith(b'\x1a\x45\xdf\xa3'):
        # EBML. Matroska and WebM share the container; only WebM is on the
        # allowlist, and the DocType lives in the first few dozen bytes.
        if b'webm' in head[:64]:
            return 'video/webm'
        return None
    if head.startswith(b'OggS'):
        # Ogg carries several codecs. Audio codecs only; Theora (video/ogg)
        # is not on the allowlist.
        window = head[:128]
        if b'vorbis' in window or b'OpusHead' in window or b'FLAC' in window:
            return 'audio/ogg'
        return None
    if len(head) >= 12 and head[4:8] == b'ftyp':
        major = head[8:12]
        sniffed = _FTYP_BRANDS.get(major)
        if sniffed is not None and major in _GENERIC_MIAF_BRANDS:
            return _refine_miaf_brand(head) or sniffed
        return sniffed
    if head.startswith(b'ID3'):
        return 'audio/mpeg'
    if _sniff_mpeg_audio(head):
        return 'audio/mpeg'
    return None


# Pillow format names accepted for each raster type. After the signature match
# we ask Pillow to agree, which rejects a file that merely *starts* like an
# image.
#
# Two honest limitations, so nobody later reads "accepted" as "decodable":
#
#   * This is HEADER-deep, not pixel-deep. `Image.open()` parses the header and
#     stops; it does not decode the raster. Truncated or corrupt image *data*
#     with an intact header passes here (the variant worker handles that
#     separately, and a broken image is not a security problem).
#   * Types absent from this table — heic, avif, and every non-raster (mp4,
#     mp3, ogg, wav, pdf) — get NO second stage at all. `b'ID3' + <html>`
#     sniffs as audio/mpeg and `b'%PDF-' + <html>` as application/pdf, and
#     both are accepted. That is harmless for: they are stored with a
#     passive extension, so they are served `audio/mpeg` / `application/pdf`,
#     and with `nosniff` a browser will not reinterpret them as a document.
#
# `MPO` is in the JPEG tuple deliberately. Pillow reports MPO — not JPEG — for
# any JPEG carrying a valid APP2 MPF segment, which is what dual-camera /
# portrait / HDR phones emit (iPhone, Samsung, WhatsApp re-encodes). On a
# 512-file corpus of real JPEGs, 6.4% were Pillow-format MPO. Requiring an
# exact 'JPEG' 400s those with "your photo is corrupt", on the main upload
# path. MPO *is* JPEG — a JPEG container with extra frames.
_PILLOW_FORMATS = {
    'image/jpeg': ('JPEG', 'MPO'),
    'image/png': ('PNG',),
    'image/gif': ('GIF',),
    'image/webp': ('WEBP',),
}


def _confirm_raster(fileobj, sniffed: str) -> bool:
    expected = _PILLOW_FORMATS.get(sniffed)
    if expected is None:
        return True
    try:
        fileobj.seek(0)
        # Deliberately not a context manager: Pillow's __exit__ can close a
        # file object it was handed (GIF/TIFF keep a second handle), and the
        # caller still needs to read these bytes to store them.
        image = Image.open(fileobj)
        return image.format in expected
    except (
        UnidentifiedImageError, OSError, ValueError,
        Image.DecompressionBombError,
    ):
        return False
    finally:
        try:
            fileobj.seek(0)
        except (OSError, ValueError):
            pass


# --------------------------------------------------------------------------
# Name normalization
# --------------------------------------------------------------------------

_EXT_SAFE = re.compile(r'[^a-z0-9]')


def sanitize_extension(ext: str) -> str:
    """
    Reduce a file extension to a lowercase alphanumeric token.

    `get_upload_path` used to concatenate the raw `os.path.splitext` tail onto
    a slugified stem — the one part of the stored name that was never
    sanitized. Nothing exploitable is reachable through it today (Django's
    `validate_file_name` rejects `..`, and `splitext` cannot return a tail
    containing `/`), but the name is used to build URLs and, via
    `mimetypes.guess_type`, the served Content-Type. Keeping it to
    `[a-z0-9]{1,10}` removes the whole question.
    """
    if not ext:
        return ''
    cleaned = _EXT_SAFE.sub('', ext.lower())[:10]
    return f'.{cleaned}' if cleaned else ''


def _split_name(filename: str) -> tuple[str, str]:
    base = os.path.basename(filename or '')
    stem, ext = os.path.splitext(base)
    return stem, sanitize_extension(ext)


def normalize_declared_type(declared: str | None) -> str | None:
    """
    Canonical form of a client-declared Content-Type, or None when the client
    made no meaningful claim.
    """
    if not declared:
        return None
    value = declared.split(';')[0].strip().lower()
    if value in NEUTRAL_DECLARED_TYPES:
        return None
    return DECLARED_TYPE_ALIASES.get(value, value)


# --------------------------------------------------------------------------
# The entry point the views call
# --------------------------------------------------------------------------

def validate_upload(uploaded_file) -> str:
    """
    Validate one `UploadedFile` against the allowlist and normalize its name
    in place. Returns the canonical (sniffed) MIME type, which the caller must
    store on `GenericFile.mime_type` instead of `uploaded_file.content_type`.

    Raises `UploadTypeError` — never anything else — for a file that must be
    rejected. The file's read position is left at 0.

    Three checks, in order of trustworthiness:

      1. **Bytes.** Sniffed type must be on the allowlist. This alone rejects
         the  payloads: SVG and HTML have no binary signature.
      2. **Extension.** The stored extension always ends up denoting the
         sniffed type. An extension naming a format we do not accept
         (`evil.svg`, `evil.html`) is a **rejection** — that name is the
         payload and renaming it would hide the attempt. An extension naming a
         different *allowlisted, passive* type (`cat.png` holding JPEG bytes —
         a saved screenshot, and 3 of 512 files in a real corpus) is simply
         **replaced**; 400ing an honest user buys nothing when we rewrite the
         extension regardless.
      3. **Declared type.** A `Content-Type` on the multipart part naming
         something off-allowlist is rejected as a tripwire. A declaration that
         merely disagrees with the bytes is ignored — browsers derive it from
         the extension, so the screenshot case above would otherwise 400 on
         this check instead. Nothing here is ever *trusted*.

    One documented softening: inside ISO_BMFF_FAMILY the `ftyp` brand cannot
    distinguish an audio-only `.m4a` from a video `.mp4`, so the extension (or
    failing that the declaration) picks between those labels. All three members
    are passive media, so this cannot produce an active document.
    """
    if uploaded_file is None:
        raise UploadTypeError('No file was uploaded.')

    try:
        uploaded_file.seek(0)
        head = uploaded_file.read(SNIFF_BYTES)
    except (OSError, ValueError) as exc:
        raise UploadTypeError(f'Could not read the uploaded file: {exc}')
    finally:
        try:
            uploaded_file.seek(0)
        except (OSError, ValueError):
            pass

    if not head:
        raise UploadTypeError('The uploaded file is empty.')

    sniffed = sniff_media_type(head)
    if sniffed is None or sniffed not in ALLOWED_TYPE_EXTENSIONS:
        raise UploadTypeError(
            'This file type is not allowed. Accepted types: '
            f'{", ".join(sorted(ALLOWED_MIME_TYPES))}.'
        )

    if not _confirm_raster(uploaded_file, sniffed):
        raise UploadTypeError(
            f'The file claims to be {sniffed} but its contents could not be '
            'decoded as that format.'
        )

    stem, ext = _split_name(uploaded_file.name)
    declared = normalize_declared_type(
        getattr(uploaded_file, 'content_type', None))

    # Resolve the ISO-BMFF ambiguity before any of the agreement checks:
    # an audio-only.m4a and a video.mp4 can carry the identical major brand.
    resolved = sniffed
    if sniffed in ISO_BMFF_FAMILY:
        ext_hint = EXTENSION_TO_TYPE.get(ext)
        if ext_hint in ISO_BMFF_FAMILY:
            resolved = ext_hint
        elif declared in ISO_BMFF_FAMILY:
            resolved = declared

    if ext:
        ext_type = EXTENSION_TO_TYPE.get(ext)
        if ext_type is None:
            # Not one of ours. If the platform recognizes the extension at all
            # it names some *other* format — ".svg", ".html", ".zip" — so the
            # name is an assertion we are unwilling to store. Refuse rather
            # than quietly rewrite it: a name asserting an active type is the
            #  payload, and silently renaming it would hide the attempt.
            if mimetypes.guess_type(f'x{ext}')[0] is not None:
                raise UploadTypeError(
                    f'The file contents are {resolved} but the name ends in '
                    f'"{ext}". The extension must match the contents.'
                )
            ext = ''
        elif ext_type != resolved:
            # Both are allowlisted passive types — a screenshot saved as
            # `cat.png` that is really JPEG bytes, say. We rewrite the
            # extension anyway, so there is nothing to gain by 400ing an
            # honest user: drop their extension and use ours. The stored name
            # still ends up agreeing with the bytes, which is the whole
            # invariant.
            ext = ''

    if not ext:
        ext = ALLOWED_TYPE_EXTENSIONS[resolved][0]

    if declared is not None and declared not in ALLOWED_TYPE_EXTENSIONS:
        # The client is asserting a type we do not serve — `image/svg+xml`,
        # `text/html`. The bytes say otherwise, so nothing would actually be
        # stored as an active type, but a browser never produces this and it
        # is a cheap tripwire, so it is a rejection rather than a shrug.
        raise UploadTypeError(
            f'The declared content type "{declared}" is not an accepted type.'
        )

    # Rewrite the name so the extension we validated is the extension that is
    # stored — `get_upload_path` slugifies the stem, and django-storages turns
    # the result into the served Content-Type.
    uploaded_file.name = f'{stem}{ext}'
    # Cosmetic for GCS (which ignores it), load-bearing for FileSystemStorage
    # and for `try_strip_metadata`: keep the declared type honest downstream.
    try:
        uploaded_file.content_type = resolved
    except AttributeError:
        pass

    return resolved
