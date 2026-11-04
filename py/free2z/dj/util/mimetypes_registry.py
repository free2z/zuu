"""
The single source of truth for extension -> served Content-Type.

Why this module exists
----------------------
Every uploaded object is stored in GCS by django-storages, which derives the
blob's ``content_type`` from **nothing but the stored file name**::

    storages/backends/gcloud.py:45     (pinned django-storages 1.14.6)
        self.mime_type, self.mime_encoding = mimetypes.guess_type(name)
    storages/backends/gcloud.py:209
        upload_params["content_type"] = self.mime_type

We set no ``GS_OBJECT_PARAMETERS``, so that value is the ``Content-Type`` nginx
hands the browser for `/uploadz/`. Until this module existed, the app never
called:func:`mimetypes.add_type` even once, which meant the header depended on
two things we neither control nor test:

1. the **interpreter's** built-in ``mimetypes.types_map``, and
2. the **base image's** ``/etc/mime.types`` (an apt data file, ~70KB), which
   :func:`mimetypes.init` layers on top of the built-in table and which wins.

Measured inside real images (see ``test_mime_registry.py`` for the assertions
that now pin this):

======================  =========  =========  ===========  ==========
image                   ``.webp``  ``.avif``  ``.m4a``     ``.jfif``
======================  =========  =========  ===========  ==========
3.10-bullseye (pre-) ``None``  ``None``   audio/mpeg   image/jpeg
3.10-slim / -alpine     ``None``   ``None``   ``None``     ``None``
3.11 / 3.12 -slim       ``None``   image/avif ``None``     ``None``
3.13-slim               image/webp image/avif ``None``     ``None``
3.12-bookworm (pinned)  image/webp image/avif audio/mp4    image/jpeg
======================  =========  =========  ===========  ==========

Read that table twice. Three separate lessons hide in it:

* On the base image pinned when  was found (``3.10-bullseye``) ``.webp``
  was ``None``, so all 288 stored WebP objects — plus every server-generated
  ``Webp`` thumbnail and ``ImageVariant`` rendition, which are *all*
  ``.webp`` — were served as ``application/octet-stream``.
* ``.m4a`` resolved to ``audio/mpeg`` there, which is simply **wrong**: an
  ``.m4a`` is MPEG-4 audio, ``audio/mp4``.
* ``.m4a``/``.m4v``/``.jfif`` are **not in CPython's table at any version**,
  not even 3.13. They work today *only* because Debian ships
  ``/etc/mime.types``. A perfectly reasonable "shrink the image" PR moving to
  ``python:3.x-slim`` would silently turn 50 ``.jfif``, 8 ``.m4a`` and 4
  ``.m4v`` objects into downloads, with every test still green.

So "upgrade Python" is not a fix, it is a different roll of the same dice.
Registering the types explicitly makes the answer deterministic, identical in
the test runner and in production, and independent of both variables.

Placement
---------
:func:`register_mime_types` is called from the top of ``dj/free2z/settings.py``,
i.e. during ``django.setup()`` **before** the app registry is populated and
therefore before any model, storage backend, view, management command or
worker can possibly touch:func:`mimetypes.guess_type`. It is called a second
time from ``UploadsConfig.ready()`` purely as insurance::func:`mimetypes.init`
*rebuilds* the module-level database from scratch, so any third-party import
that calls it would silently drop our registrations. Re-applying after all app
imports costs microseconds and is idempotent.

This module deliberately imports nothing from Django, so importing it from
settings can never raise ``AppRegistryNotReady``.

Relationship to the  upload allowlist
-----------------------------------------
``dj.apps.uploads.validation`` (merged) carries its own
``ALLOWED_TYPE_EXTENSIONS`` map for a *different* question: which uploads are
**accepted**. This module answers which Content-Type an accepted object is
**served** with, for the whole historical corpus — including formats that are
no longer accepted but are still in the bucket. So this registry is a strict
**superset** of the allowlist's extension map, and
``test_mime_registry.py::test_registry_is_a_superset_of_the_962_allowlist``
fails the build if a single extension resolves differently in the two.

The registry cannot import ``validation`` (that module imports Pillow and
Django's exceptions, and this one is imported from ``settings``), which is why
the reconciliation is a test rather than a derivation. The follow-up is to
invert it: delete ``ALLOWED_TYPE_EXTENSIONS``'s type strings and build them
from ``MIME_TYPE_REGISTRY``, leaving ``validation`` to own only the *set* of
accepted extensions. That is a one-file change in ``validation.py``; it is
deliberately not in this PR, which touches no  code.

What is deliberately *not* here
-------------------------------
No **active** type — nothing a browser would execute in the free2z.cash origin
(``text/html``, ``image/svg+xml``, ``application/xhtml+xml``, ``text/xml``,
``application/javascript``,...).:data:`ACTIVE_CONTENT_TYPES` is the denylist
and:func:`check_registry_is_passive` enforces it at import time, so neither a
careless edit here nor the backfill command can manufacture the  stored-XSS
vulnerability.

Formats browsers cannot render (``.vob``, ``.xcf``, ``.dng``, ``.emf``,
``.pages``, ``.ai``, ``.apk``, ``.php``, ``.py``, ``.ini``) are also absent on
purpose: ``application/octet-stream`` -> "download it" is the correct outcome
for those, and leaving them unregistered keeps the registry honest about what
it promises.
"""
import mimetypes
import os

# ---------------------------------------------------------------------------
# Types a browser executes as a document in the serving origin. Registering any
# of these for an upload extension would recreate. Kept here (rather than
# only in dj.apps.uploads.validation) so this module has zero Django-app
# imports and can be imported from settings.
#
# This set is a strict SUPERSET of validation.ACTIVE_MIME_TYPES -- two
# denylists is one too many, so the test suite fails if the security-side list
# ever grows an entry this one lacks
# (test_mime_registry.py::test_active_set_covers_the_962_active_types). The
# extra entries here are spellings validation does not need (it matches
# canonical sniffed types) but a legacy stored blob may well carry.
# ---------------------------------------------------------------------------
ACTIVE_CONTENT_TYPES: frozenset[str] = frozenset({
    # -- everything in validation.ACTIVE_MIME_TYPES  -----------------
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
    # -- additional spellings a legacy stored blob may carry ---------------
    'application/ecmascript',
    'text/ecmascript',
    'application/x-xhtml+xml',
    'application/mathml+xml',
    'application/xslt+xml',
    'text/vtt',
    'application/x-httpd-php',
})

# ---------------------------------------------------------------------------
# The registry: stored extension -> Content-Type we serve it as.
#
# Every entry is a passive media/document type. Extensions are lowercase and
# dot-prefixed, matching what os.path.splitext() yields.
#
# Values were chosen to (a) fix what is broken, (b) otherwise preserve what the
# pinned image already serves, so the blast radius is the broken set plus two
# deliberate normalizations noted inline.
# ---------------------------------------------------------------------------
MIME_TYPE_REGISTRY: dict[str, str] = {
    # -- raster images ------------------------------------------------------
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jpe': 'image/jpeg',
    # 50 objects in production. JPEG File Interchange Format — a plain JPEG.
    # Absent from CPython's table at every version; only /etc/mime.types has it.
    '.jfif': 'image/jpeg',
    '.gif': 'image/gif',
    # THE  BUG: None on the pinned image, so 288 objects download instead
    # of rendering. Also the format of every Webp thumbnail and ImageVariant.
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
    # image/heic, NOT image/heif: the  allowlist canonicalizes both
    # extensions to image/heic (validation.ALLOWED_TYPE_EXTENSIONS), and the
    # served type must equal the type the API and the DB report for the same
    # object. Python's own table says image/heif here, which is where the
    # divergence would have come from.
    '.heif': 'image/heic',
    # HEIF/AVIF image *sequences*. Same canonicalization, same reason:
    # /etc/mime.types on the pinned base image says `image/heic-sequence` /
    # `image/heif-sequence` for these, but the allowlist labels the bytes
    # `image/heic`, so without these three entries a stored `.heics` would be
    # served under a Content-Type the DB `mime_type` column and the API do not
    # report. `.avifs` resolves to None on that image, i.e.
    # application/octet-stream. All three are passive rasters.
    '.heics': 'image/heic',
    '.heifs': 'image/heic',
    '.avifs': 'image/avif',
    # Normalization: 3.10's built-in table said image/x-ms-bmp, 3.11+ says
    # image/bmp (the IANA registration). Pin the modern one.
    '.bmp': 'image/bmp',
    '.ico': 'image/vnd.microsoft.icon',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',

    # -- video --------------------------------------------------------------
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.qt': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',

    # -- audio --------------------------------------------------------------
    '.mp3': 'audio/mpeg',
    # WRONG on the pinned image (audio/mpeg, from /etc/mime.types) and absent
    # from CPython at every version..m4a is MPEG-4 audio.
    '.m4a': 'audio/mp4',
    '.m4b': 'audio/mp4',
    # Normalization: audio/x-wav is what both the interpreter and Debian say
    # today; audio/wav is the spelling the  allowlist canonicalizes to and
    # the one browsers overwhelmingly see. Pick one so they cannot drift.
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aiff': 'audio/x-aiff',
    '.aif': 'audio/x-aiff',
    '.wma': 'audio/x-ms-wma',

    # -- documents / archives ----------------------------------------------
    '.pdf': 'application/pdf',
    '.epub': 'application/epub+zip',
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
}


def check_registry_is_passive(registry: dict[str, str] | None = None) -> None:
    """
    Fail loudly if the registry would make an upload extension render as an
    executable document. Runs at import time; also asserted in tests.
    """
    registry = MIME_TYPE_REGISTRY if registry is None else registry
    offenders = sorted(
        f'{ext} -> {mime}'
        for ext, mime in registry.items()
        if mime.split(';')[0].strip().lower() in ACTIVE_CONTENT_TYPES
    )
    if offenders:
        raise AssertionError(
            'MIME_TYPE_REGISTRY maps an upload extension to an ACTIVE '
            'document type. Serving uploaded bytes as one of these executes '
            'attacker JavaScript on free2z.cash (#962). Offending entries: '
            + ', '.join(offenders)
        )
    malformed = sorted(
        ext for ext in registry
        if not ext.startswith('.') or ext != ext.lower() or len(ext) < 2
    )
    if malformed:
        raise AssertionError(
            'MIME_TYPE_REGISTRY keys must be lowercase, dot-prefixed '
            f'extensions; got: {malformed}'
        )


check_registry_is_passive()


def content_type_for(name: str) -> str | None:
    """
    The Content-Type this registry promises for a stored object name, or None
    if the extension is not registered (in which case GCS keeps whatever it
    has — usually ``application/octet-stream``, i.e. "download me", which is
    the correct answer for a format browsers cannot render).

    Name-only and side-effect free, so callers (notably the
    ``backfill_upload_content_types`` command) can plan without touching
    storage.
    """
    # os.path.splitext is exactly what mimetypes.guess_type uses, so this
    # function and the real header can never disagree (asserted in the tests).
    ext = os.path.splitext(name or '')[1].lower()
    return MIME_TYPE_REGISTRY.get(ext) if ext else None


def register_mime_types() -> None:
    """
    Apply:data:`MIME_TYPE_REGISTRY` to the process-wide ``mimetypes`` table.

    Idempotent, and safe to call again after anything has called
    :func:`mimetypes.init` (which rebuilds the table and would otherwise drop
    these registrations).
    """
    for ext, content_type in MIME_TYPE_REGISTRY.items():
        mimetypes.add_type(content_type, ext, strict=True)
