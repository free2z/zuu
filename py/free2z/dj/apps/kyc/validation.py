"""
KYC upload policy.

What was wrong
--------------
Both KYC upload views gated on `UploadedFile.content_type` — the `Content-Type`
the *client* wrote on the multipart part. That is attacker-chosen:

    curl -F "file=@evil.html;type=application/pdf".../api/kyc/upload-tax-form

passed the `content_type == 'application/pdf'` check, and
`get_profile_upload_path` / `get_upload_path` stored the client's filename
verbatim, so `evil.html` kept its `.html` extension. django-storages derives the
served `Content-Type` from the stored name
(`storages/backends/gcloud.py: mimetypes.guess_type(name)`) and nginx proxies
`/uploadz/private/...` inline from `https://free2z.cash`, so the file came back
as `text/html` and executed in the app's own cookie-bearing origin.

The victim here is not a random reader: KYC documents are opened by whoever
reviews applications, and `uploads_auth_private` authorizes **any superuser**.
So a hostile KYC application is a stored-XSS payload aimed at an admin session.

What this module does
---------------------
Nothing clever — it is a thin per-field policy on top of the one sniffer we
already have, `dj.apps.uploads.validation.validate_upload()` (/, written
model-free precisely so it could be reused here). That function is the single
source of truth for "what are these bytes": it sniffs the leading bytes,
confirms rasters with Pillow, rejects any extension or declared type naming an
off-allowlist format, and rewrites `uploaded_file.name` so the stored extension
always matches the sniffed content. It returns the canonical MIME type.

All this adds is: **which of those types each KYC field accepts**, because the
shared allowlist is deliberately broad (it also covers audio and video, which
have no business being an identity document).

Deliberately NOT re-implemented here: byte sniffing, Pillow confirmation,
extension rewriting. One allowlist, one sniffer.
"""
import os

from django.utils.text import slugify

from dj.apps.uploads.validation import (
    ALLOWED_TYPE_EXTENSIONS,
    EXTENSION_TO_TYPE,
    UploadTypeError,
    sanitize_extension,
    validate_upload,
)

__all__ = [
    'IDENTITY_FIELD_LABELS',
    'IDENTITY_FIELD_TYPES',
    'IDENTITY_PHOTO_TYPES',
    'KYC_DOCUMENT_EXTENSIONS',
    'KYC_IMAGE_EXTENSIONS',
    'KYC_TAX_FORM_EXTENSIONS',
    'SUPPORTING_DOCUMENT_TYPES',
    'TAX_FORM_TYPES',
    'UploadTypeError',
    'normalize_stored_name',
    'validate_kyc_upload',
]


# ---------------------------------------------------------------------------
# Per-field allowlists
#
# Tax forms (W-9 / W-8BEN / W-8BEN-E) are PDFs. That is the literal product
# need — the blank forms we hand out are IRS PDFs — so PDF stays allowed, and
# nothing else is. A PDF is not a stored-XSS primitive: script inside one runs
# in the viewer's isolated context, not in the free2z.cash DOM. (The residual
# phishing surface is a `Content-Disposition` question for nginx, not something
# an upload allowlist can fix.)
# ---------------------------------------------------------------------------
TAX_FORM_TYPES = frozenset({'application/pdf'})

# `id_front`, `id_back` and `live_photo` are photographs of a physical document
# or of a face, and the Django admin renders them in an `<img>` for the
# reviewer. Rasters only — a PDF in an ImageField is a type violation and would
# render as a broken image in the review queue.
#
# Two deliberate deltas from the old declared-type list:
#
#   * TIFF is DROPPED. It was only ever accepted on the client's word — the
#     shared allowlist has no TIFF signature, and adding one would mean either a
#     second sniffer here or widening the *public* uploads allowlist as a side
#     effect of a KYC security fix. `uploads/models.py` already made this call
#     ("only ones widely supported by browsers" — TIFF is commented out there),
#     and no browser but Safari renders TIFF, so a TIFF ID is unreviewable in
#     the admin anyway. The production audit on  found zero TIFF objects, so
#     nothing in flight breaks; a user with a TIFF scan now gets a clean 400
#     naming the accepted types instead of an unviewable document.
#   * HEIC/AVIF/GIF/WebP are GAINED. HEIC in particular is what an unmodified
#     iPhone uploads; it was rejected before, which is a much more common real
#     failure than TIFF ever was.
#
# `image/heic` covers the whole HEIF family here. A client that declares
# `image/heif` (what the standard Linux/Android `mime.types` says for a `.heif`
# file, where iOS/Safari says `image/heic`) used to be rejected by the shared
# module's declared-type tripwire, which blocked an applicant from submitting an
# identity document. Fixed in  by a `DECLARED_TYPE_ALIASES` entry in
# `dj/apps/uploads/validation.py`, so the family's alternate spellings all
# normalize to `image/heic` before this per-field check runs.
IDENTITY_PHOTO_TYPES = frozenset({
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    'image/avif',
})

# `additional_document` is a FileField, not an ImageField: it is the
# "anything else the reviewer asked for" slot (proof of address, a utility
# bill, a bank statement), and those arrive as PDFs at least as often as
# photos. PDF is allowed here for the same reason it is allowed for tax forms.
SUPPORTING_DOCUMENT_TYPES = IDENTITY_PHOTO_TYPES | {'application/pdf'}

IDENTITY_FIELD_TYPES: dict[str, frozenset[str]] = {
    'id_front': IDENTITY_PHOTO_TYPES,
    'id_back': IDENTITY_PHOTO_TYPES,
    'live_photo': IDENTITY_PHOTO_TYPES,
    'additional_document': SUPPORTING_DOCUMENT_TYPES,
}

# Human-facing labels, so a 400 says "ID front" rather than "id_front".
IDENTITY_FIELD_LABELS: dict[str, str] = {
    'id_front': 'ID front',
    'id_back': 'ID back',
    'additional_document': 'Additional document',
    'live_photo': 'Live photo',
}


def _extensions_for(types) -> tuple[str, ...]:
    """Dot-less, sorted extensions for a set of MIME types (model validators)."""
    return tuple(sorted(
        ext.lstrip('.')
        for mime in types
        for ext in ALLOWED_TYPE_EXTENSIONS[mime]
    ))


KYC_IMAGE_EXTENSIONS = _extensions_for(IDENTITY_PHOTO_TYPES)
KYC_DOCUMENT_EXTENSIONS = _extensions_for(SUPPORTING_DOCUMENT_TYPES)
KYC_TAX_FORM_EXTENSIONS = _extensions_for(TAX_FORM_TYPES)


# ---------------------------------------------------------------------------
# Stored-name normalization
# ---------------------------------------------------------------------------

def normalize_stored_name(filename: str) -> str:
    """
    Reduce a client-supplied filename to `<slugified stem><allowlisted ext>`.

    This is the KYC equivalent of `uploads.models.get_upload_path`'s stem
    handling, which the KYC `upload_to` callables never had: they were plain
    `os.path.join(str(instance.id), filename)`, storing the attacker's name
    byte for byte. The stored extension is what becomes the served
    `Content-Type`, so it is the one part that must not be attacker-controlled.

    By the time a view-uploaded file reaches here, `validate_upload()` has
    already rewritten the name to an extension matching the sniffed bytes, so
    this is normally a no-op on the extension. It is still enforced here
    because `upload_to` is the *last* choke point before storage and other
    paths reach it — the Django admin, a management command, a future view that
    forgets to validate. An extension we do not recognize is dropped entirely
    rather than stored: no extension means `mimetypes.guess_type` returns None
    and the object is served `application/octet-stream`, which is inert.
    """
    base = os.path.basename(filename or '')
    stem, ext = os.path.splitext(base)
    stem = slugify(stem)[:64] or 'file'
    ext = sanitize_extension(ext)
    if EXTENSION_TO_TYPE.get(ext) is None:
        ext = ''
    return stem + ext


# ---------------------------------------------------------------------------
# The entry point the views call
# ---------------------------------------------------------------------------

def validate_kyc_upload(uploaded_file, allowed_types, label: str = 'file') -> str:
    """
    Validate one `UploadedFile` for a KYC field and normalize its name in place.

    Returns the canonical (sniffed) MIME type. Raises `UploadTypeError` — and
    nothing else — for anything that must be rejected, so callers turn it into a
    clean 400 rather than a 500.

    Two stages: `validate_upload()` decides *what the bytes are* (and rejects
    everything that is not identifiably an allowlisted passive media type),
    then this narrows to what this particular field accepts.
    """
    mime_type = validate_upload(uploaded_file)
    if mime_type not in allowed_types:
        raise UploadTypeError(
            f'{label} must be one of: {", ".join(sorted(allowed_types))}. '
            f'The file you uploaded is {mime_type}.'
        )
    return mime_type
