import io
import os
import urllib.request
from PIL import Image, ExifTags

from django.db import models
from django.conf import settings
from django.utils.text import slugify
from django.core.files.base import ContentFile
from django.core.exceptions import ObjectDoesNotExist
from django.core.validators import FileExtensionValidator

from .validation import ALLOWED_EXTENSIONS, ALLOWED_TYPE_EXTENSIONS, sanitize_extension


ACCESS_CHOICES = [
    ['private', 'private'],
    ['members', 'members'],
    ['public', 'public'],
]

# NOTE: `image/svg+xml` used to be here. An SVG is a scriptable
# document served inline from the cookie-bearing free2z.cash origin, i.e.
# stored XSS. It is no longer accepted on upload — see
# `validation.ALLOWED_TYPE_EXTENSIONS` for the full rationale. It stays in
# NON_RASTER_IMAGE_MIME_TYPES below so the rows uploaded before the allowlist
# still skip variant generation.
IMAGE_MIME_TYPES = [
    ['image/jpeg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/gif', 'image/gif'],
    ['image/webp', 'image/webp'],
    ['image/heic', 'image/heic'],
    ['image/avif', 'image/avif'],
    # only ones widely supported by browsers
    # ['image/tiff', 'image/tiff'],
    # ['image/bmp', 'image/bmp'],
    # ['image/x-icon', 'image/x-icon'],
]

EXIF_TYPES = ['image/jpeg', 'image/png']

# https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types#audio_and_video_types
VIDEO_MIME_TYPES = [
    ['video/mp4', 'video/mp4'],
    ['video/webm', 'video/webm'],
    ['video/quicktime', 'video/quicktime'],
]

# The set form, for membership tests. Until  `VIDEO_MIME_TYPES`'
# definition was its own only reference -- dead code that read as if
# something enforced it.
VIDEO_MIME_TYPE_VALUES = frozenset(pair[0] for pair in VIDEO_MIME_TYPES)

AUDIO_MIME_TYPES = [
    ['audio/mpeg', 'audio/mpeg'],
    ['audio/mp4', 'audio/mp4'],
    ['audio/ogg', 'audio/ogg'],
    ['audio/wav', 'audio/wav'],
]

DOCUMENT_MIME_TYPES = [
    ['application/pdf', 'application/pdf'],
]

# Every value the upload allowlist can produce, in a stable order so the
# migration state does not churn. Legacy rows may still hold values outside
# this set (choices are advisory, not a DB constraint) — that is what
# `manage.py audit_active_uploads` is for.
MIME_TYPE_CHOICES = [
    [mime, mime] for mime in ALLOWED_TYPE_EXTENSIONS
]


def print_exif_data(exif):
    for tag, value in exif.items():
        tag_name = ExifTags.TAGS.get(tag, tag)
        print(f"{tag_name}: {value}")


def apply_orientation(image):
    try:
        exif = image._getexif()
        if not exif:
            return None

        orientation_key = next((k for k, v in ExifTags.TAGS.items() if v == 'Orientation'), None)
        if orientation_key is None:
            return image

        orientation = exif.get(orientation_key)
        if orientation == 3:
            image = image.rotate(180, expand=True)
        elif orientation == 6:
            image = image.rotate(270, expand=True)
        elif orientation == 8:
            image = image.rotate(90, expand=True)
    except (AttributeError, KeyError, IndexError, TypeError):
        # Cases where the image doesn't have EXIF data or tag is not present
        pass

    return image


def remove_exif_data(image):
    # Open the image using an in-memory file
    in_mem_file = io.BytesIO(image.read())
    with Image.open(in_mem_file) as img:
        # Apply orientation based on EXIF data
        oriented_img = apply_orientation(img)
        if not oriented_img:
            return None
        # Create a new image without EXIF data
        image_without_exif = Image.new(oriented_img.mode, oriented_img.size)
        image_without_exif.putdata(list(oriented_img.getdata()))

        # Save the altered image to another in-memory file
        out_mem_file = io.BytesIO()
        image_without_exif.save(out_mem_file, format=img.format)
        out_mem_file.seek(0)
        return out_mem_file


def get_upload_path(instance, filename):
    """
    `<owner username>/<slugified stem, 64 chars><sanitized extension>`.

    The extension used to be carried over verbatim from the client-supplied
    name — the one component of the stored path that was never sanitized, and
    the component django-storages turns into the served `Content-Type`
    (`mimetypes.guess_type(name)`). It is now reduced to `[a-z0-9]{,10}`
    . An empty slug would previously produce a dotfile name like
    `user/.png`; it falls back to `file`.
    """
    filename = os.path.basename(filename or '')
    filename, ext = os.path.splitext(filename)
    stem = slugify(filename)[:64] or 'file'
    return os.path.join(instance.owner.username, stem + sanitize_extension(ext))


def get_unreferenced_upload_path(instance, filename):
    """`GenericFile.file`'s `upload_to`: `get_upload_path`, made unshared.

    `get_upload_path` stays the pure name computation (and stays importable:
    migration 0012 references it).
    """
    return _unreferenced_storage_key(
        instance, get_upload_path(instance, filename))


def _unreferenced_storage_key(instance, name):
    """Return *name*, or an alternative, that no live row references.

    `Storage.get_available_name` only asks the bucket whether a key exists.
    A key can be absent from the bucket while a row still points at it -- the
    object was deleted out from under the row (pre-outbox `file.delete()`,
    `rm_exif`'s delete-then-save), or never finished writing -- and the next
    upload with the same name then reuses the key: two rows, one object.
    That is exactly how both duplicate groups in prod were made
    (`XOZOKDIP/IMG_1628.JPG`, `XOZOKDIP/IMG_9127.JPG`: in each case the
    object's GCS generation is the second row's `created_at`, to the second).

    So the database is asked as well, across every FileField on this storage
    (the same conservative scan the deletion outbox uses before it deletes).
    The `uploads_genericfile_file_uniq` constraint is the race-free backstop;
    this makes the ordinary sequential case pick a fresh name instead of
    failing the insert.
    """
    from django.core.exceptions import SuspiciousFileOperation

    from .tasks import _has_live_file_reference

    storage = instance._meta.get_field('file').storage
    root, ext = os.path.splitext(name)
    candidate = name
    for _ in range(100):
        if not _has_live_file_reference(
                candidate, UPLOAD_STORAGE_ALIAS, exclude_instance=instance):
            return candidate
        candidate = storage.get_alternative_name(root, ext)
    raise SuspiciousFileOperation(
        f'No unreferenced storage key available for {name!r}.')


def get_thumbnail_upload_path(instance, filename):
    return os.path.join(instance.parent.owner.username, filename)


def get_variant_upload_path(instance, filename):
    """
    Variants live beside the parent file (same <username>/ directory in
    the bucket). Access control is enforced at serve time: URLs are
    prefixed with the parent's public/private prefix (see
    ImageVariant.get_url + the nginx auth views), so a private parent's
    variants are only reachable through the authenticated /uploadz/ path.
    """
    return os.path.join(instance.parent.owner.username, filename)


# Widths (px) of the WebP ladder generated for every raster upload.
VARIANT_WIDTHS = [64, 128, 400, 800, 1600]

# All upload, legacy-thumbnail and ImageVariant FileFields use Django's
# default storage.  The deletion outbox stores the alias rather than a
# process-local storage object so a retry can run in another worker.
UPLOAD_STORAGE_ALIAS = "default"

# Image types the WebP ladder skips, served as-is: animated (gif), vector
# (legacy svg rows — no longer accepted on upload), and formats our pinned
# Pillow 10.3 cannot decode at all (heic needs pillow-heif, avif landed in
# Pillow 11.3). Listing the undecodable ones here keeps the upload signal from
# enqueuing a variant job per file that can only fail to open.
NON_RASTER_IMAGE_MIME_TYPES = [
    'image/gif', 'image/svg+xml', 'image/heic', 'image/avif',
]


class GenericFile(models.Model):
    """
    Abstract class for a File Upload
    """
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    title = models.CharField(max_length=128, blank=True)
    description = models.TextField(max_length=255, blank=True)

    # Unique per row: see `legacy_shared_file`, the
    # `uploads_genericfile_file_uniq` constraint and
    # `get_unreferenced_upload_path` (asks the database, not just the bucket)
    # and `storage.CreateOnlyGoogleCloudStorage` (no racing overwrite).
    # The validator only fires on full_clean() (ModelForms, the admin) — the
    # real gate is `validation.validate_upload()` in the upload views, which
    # checks the *bytes*. This is here so the admin cannot re-introduce an
    # active-document extension by hand.
    file = models.FileField(
        upload_to=get_unreferenced_upload_path,
        validators=[FileExtensionValidator(
            allowed_extensions=list(ALLOWED_EXTENSIONS))],
    )
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
    )
    access = models.CharField(
        choices=ACCESS_CHOICES, max_length=64, default='public')

    mime_type = models.CharField(
        choices=MIME_TYPE_CHOICES,
        max_length=64)

    skip_thumbnail = models.BooleanField(default=False)

    #one storage key, one row. Before the constraint below existed,
    # two prod rows could (and in two cases did) point at the same object.
    # Migration 0014 marks every row of such a pre-existing group EXCEPT the
    # oldest (lowest pk) with this flag, and the unique constraint covers only
    # unflagged rows -- so the legacy pairs survive untouched (no row merged,
    # repointed or deleted) while the name each of them uses stays claimed
    # by its oldest row, and no new row can ever share it.
    #
    # Nothing sets this True except that migration. `db_default` so a pod
    # still running the previous release can insert during the rollout.
    # Deleting one row of a legacy pair is safe: the deletion outbox checks
    # every FileField for a live reference before it deletes an object.
    legacy_shared_file = models.BooleanField(
        default=False, db_default=False, editable=False)

    class Meta:
        ordering = ['-updated_at']
        indexes = [
            models.Index(fields=['created_at']),
            models.Index(fields=['updated_at']),
            models.Index(fields=['owner_id']),
            models.Index(fields=['mime_type']),
            models.Index(fields=['file']),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['file'],
                condition=models.Q(legacy_shared_file=False),
                name='uploads_genericfile_file_uniq',
            ),
        ]

    def __str__(self):
        return f"{self.file.name}"

    def _get_prefix(self):
        if self.access == "public":
            return "/uploadz/public/"
        return "/uploadz/"

    def get_url(self):
        from urllib.parse import quote
        return f"{self._get_prefix()}{quote(self.file.name)}"

    def is_video(self):
        return self.mime_type.startswith("video")

    def get_poster(self):
        """
        URL of this video's extracted poster frame, or None.

        Videos store exactly one derived still, as an `ImageVariant` whose
        `parent` is the video (see `uploads.tasks.generate_video_poster`).
        Reusing `ImageVariant` rather than adding a model keeps the poster on
        the parent's own `_get_prefix()` -- so a `members` video's poster is
        only reachable through the authenticated `/uploadz/` route -- and
        means the deletion outbox, the nginx auth resolution
        (`views._get_generic_file`) and the access matrix already cover it.

        Returns None for a non-video and for a video whose poster has not
        been generated (or could not be). Callers must treat None as "this
        video has no thumbnail":  exists because declaring a
        `thumbnailUrl` that does not resolve is worse than declaring none.
        """
        if not self.is_video():
            return None
        ladder = self._variant_ladder()
        return ladder[0].get_url() if ladder else None

    def get_thumbnail(self):
        # A video's thumbnail is its poster frame. Image behaviour below is
        # unchanged.
        if self.is_video():
            return self.get_poster()
        if not self.mime_type.startswith("image"):
            return None
        try:
            return self.webp.get_url()
        except ObjectDoesNotExist:
            return self.get_url()

    def _variant_ladder(self):
        """
        Sorted (ascending width) list of webp variants, cached per
        instance so serializers exposing several sizes don't re-query.
        Uses prefetched `variants` when available.
        """
        if not hasattr(self, '_variant_ladder_cache'):
            self._variant_ladder_cache = sorted(
                (v for v in self.variants.all() if v.format == 'webp'),
                key=lambda v: v.width,
            )
        return self._variant_ladder_cache

    def variant_url(self, min_width):
        """
        URL of the smallest generated variant at least `min_width` px
        wide. Fallbacks, in order: the largest available variant, the
        legacy single Webp thumbnail, then None. Never the original —
        serving multi-MB originals into small slots is what this ladder
        exists to end (see /).
        """
        # Videos joined this in: their single poster variant is a real
        # raster rendition of the upload and belongs in the same ladder. The
        # legacy-Webp fallback below is a no-op for them (a video never has a
        # `Webp` row), so image behaviour is untouched.
        if not (
            self.mime_type.startswith("image")
            or self.mime_type.startswith("video")
        ):
            return None
        ladder = self._variant_ladder()
        for variant in ladder:
            if variant.width >= min_width:
                return variant.get_url()
        if ladder:
            return ladder[-1].get_url()
        # The legacy Webp now follows the parent's prefix, so this
        # fallback would be safe at any access level. Keeping it to
        # public parents preserves the invariant  tests for; loosening
        # it is a deliberate behaviour change for its own PR.
        if self.access == "public":
            try:
                return self.webp.get_url()
            except ObjectDoesNotExist:
                return None
        return None

    # TODO: Dalle-3 and thumbnail
    @classmethod
    def create_from_prompt(cls, prompt, owner, size="512x512"):
        # No production caller since the tweet_comments listener was retired.
        from f2z.openai.util import get_openai_client
        oai_client = get_openai_client()

        response = oai_client.images.generate(
            prompt=prompt,
            n=1,
            size=size,
            response_format="url",
        )

        # download the image from the url
        image_url = response.data[0].url
        # Bounded: urlopen's default is the global socket timeout,
        # which is None -- block forever.
        with urllib.request.urlopen(
            image_url, timeout=settings.OPENAI_IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
        ) as response:
            image_data = response.read()

        # create a ContentFile object
        file_name = f"{slugify(prompt)[-64:]}.png"
        file_data = ContentFile(image_data, name=file_name)
        file_obj = cls.objects.create(
            owner=owner,
            file=file_data,
            title=prompt[-64:],
            mime_type='image/png'
        )
        file_obj.save()
        return file_obj


class ImageVariant(models.Model):
    """
    One resized rendition of a raster GenericFile. A parent image gets a
    ladder of these (VARIANT_WIDTHS, skipping widths >= the original),
    generated by the procrastinate task `uploads.generate_image_variants`.

    Unlike the legacy Webp thumbnail (always served public), variants are
    served under the parent's own public/private prefix.
    """
    parent = models.ForeignKey(
        'uploads.GenericFile',
        on_delete=models.CASCADE,
        related_name='variants',
    )
    width = models.PositiveIntegerField()
    format = models.CharField(max_length=16, default='webp')
    file = models.FileField(upload_to=get_variant_upload_path)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['parent', 'width', 'format'],
                name='uploads_imagevariant_uniq_parent_width_format',
            ),
        ]
        indexes = [
            models.Index(fields=['parent_id']),
            # The nginx auth subrequest resolves served paths back to
            # the parent via file=<name> (views._get_generic_file) —
            # same reason GenericFile indexes 'file'.
            models.Index(fields=['file']),
        ]

    def __str__(self):
        return f"{self.format}@{self.width} for {self.parent.file.name}"

    def get_url(self):
        from urllib.parse import quote
        return f"{self.parent._get_prefix()}{quote(self.file.name)}"


class Webp(models.Model):
    """
    Legacy single thumbnail for a GenericFile, superseded by the
    ImageVariant ladder. Served under the parent's own public/private
    prefix; access is enforced at serve time by the nginx auth views,
    which resolve the served name back to this row's parent.
    """
    parent = models.OneToOneField(
        'uploads.GenericFile', on_delete=models.CASCADE, related_name='webp')
    file = models.FileField(upload_to=get_thumbnail_upload_path)

    class Meta:
        indexes = [
            models.Index(fields=['parent_id']),
            # Every upload asks `tasks._has_live_file_reference` whether its
            # key is referenced by ANY FileField on the upload storage, and
            # the nginx auth subrequest resolves served names back through
            # file=<name> -- same reason GenericFile and ImageVariant index
            # 'file'. Built CONCURRENTLY in migration 0015.
            models.Index(fields=['file'], name='uploads_webp_file_idx'),
        ]

    def __str__(self):
        return f"Webp for {self.parent.file.name}"

    def get_url(self):
        # Follow the parent's public/private prefix, and percent-encode,
        # exactly like ImageVariant.get_url does. Hard-coding the public
        # prefix advertised a private upload's thumbnail at a path whose
        # auth view can only answer 401, and leaving the name raw emitted
        # a *different* string than every other URL for the same object
        # (a raw `#`/`?` truncates the URL outright).
        from urllib.parse import quote
        return f"{self.parent._get_prefix()}{quote(self.file.name)}"


class PendingUploadBlobDeletion(models.Model):
    """Durable intent to remove an upload blob after its DB row is gone.

    Object storage cannot participate in the PostgreSQL transaction that
    deletes a ``GenericFile``.  Keeping one row per storage key gives the
    worker an idempotent, retryable hand-off: a database rollback leaves the
    live row and blob alone, while a storage outage leaves this row for a
    later attempt instead of making a live row point at a missing object.
    Production GCS rows also persist the observed object generation so a
    timed-out delete can never retry against a same-name replacement.
    """

    storage_alias = models.CharField(
        max_length=64, default=UPLOAD_STORAGE_ALIAS)
    name = models.CharField(max_length=1024)
    # GCS generations identify the exact object observed before deletion.
    # Nullable for local/non-GCS backends and lower environments, where the
    # existing backend-specific behavior remains name-based/no-op.
    generation = models.PositiveBigIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_enqueued_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['storage_alias', 'name'],
                name='uploads_pending_blob_alias_name_uniq',
            ),
        ]
        indexes = [
            models.Index(
                fields=['created_at'],
                name='uploads_pblob_created_idx',
            ),
            models.Index(
                fields=['last_enqueued_at'],
                name='uploads_pblob_enqueue_idx',
            ),
        ]

    def __str__(self):
        return f"{self.storage_alias}:{self.name}"
