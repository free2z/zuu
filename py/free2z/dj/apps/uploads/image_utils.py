"""
Legacy single-WebP thumbnail generation.

Superseded for new uploads by the ImageVariant pipeline (dj.apps.uploads.tasks.generate_image_variants), but still used by the
upload view and the create_thumbnails backfill command, so it has to be
memory-safe: a batch loop calls this once per image inside a container
with a hard memory limit.

Memory discipline (2026-07-19 prod OOM incident):
  * read the original exactly once (the old code read PNGs twice, once
    for Pillow and again for the APNG animation probe),
  * refuse to decode absurdly large rasters before allocating the
    bitmap — decoded size is width*height*4 bytes, wholly unrelated to
    the on-disk size of a compressed file,
  * drop every large buffer (raw bytes, decoded image, encoded output)
    before returning, so a caller looping over images has flat RSS
    instead of a ratchet.
"""
import logging
import os
import uuid
from io import BytesIO

from PIL import Image
from apng import APNG

from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import GenericFile, Webp

logger = logging.getLogger(__name__)

# Hard ceiling on the decoded raster we are willing to hold in RAM.
# Pillow decodes to width*height*4 bytes for RGBA, so 40 MP ~= 160 MB —
# already a large fraction of a 512Mi container, and a compressed PNG
# that big is under a megabyte on disk. Anything larger is marked
# skip_thumbnail (the same terminal state as an undecodable file) so the
# backfill loop keeps making forward progress instead of re-picking it
# up and OOMing every ten minutes forever.
MAX_DECODE_PIXELS = 40_000_000


def _mark_skipped(generic_file: GenericFile, reason: str):
    # The parent may have been deleted while storage/Pillow work was in
    # progress. A filtered update is a harmless no-op in that case.
    GenericFile.objects.filter(pk=generic_file.pk).update(
        skip_thumbnail=True,
        updated_at=timezone.now(),
    )
    logger.info(
        "create_thumbnail: skipping %s (%s): %s",
        generic_file.pk, generic_file.file.name, reason,
    )


def _is_animated(image, raw_bytes) -> bool:
    if image.format == 'GIF' and getattr(image, 'is_animated', False):
        return True
    if image.format == 'PNG':
        # Animated PNG (APNG). Probe the bytes we already have in hand
        # rather than re-reading the file.
        try:
            return len(APNG.from_bytes(raw_bytes).frames) > 1
        except Exception:
            return False
    return False


def create_thumbnail(generic_file: GenericFile):
    """
    Create the single public WebP thumbnail for `generic_file`.

    Always terminal: on success a Webp row exists, and on any failure
    the file is marked skip_thumbnail so it leaves the pending set.
    """
    raw_bytes = None
    image = None
    output = None
    uploaded_name = None
    try:
        with generic_file.file.open(mode='rb') as img_file:
            raw_bytes = img_file.read()

        image = Image.open(BytesIO(raw_bytes))

        if _is_animated(image, raw_bytes):
            _mark_skipped(generic_file, f"animated {image.format}")
            return

        pixels = image.width * image.height
        if pixels > MAX_DECODE_PIXELS:
            _mark_skipped(
                generic_file,
                f"{image.width}x{image.height} = {pixels} px exceeds "
                f"MAX_DECODE_PIXELS ({MAX_DECODE_PIXELS})",
            )
            return

        output = BytesIO()
        image.save(output, format='WEBP', quality=50)

        # Release the decoded raster and the original bytes before we
        # hand the encoded payload to storage — the upload path can
        # buffer, and we do not want three copies alive at once.
        webp_bytes = output.getvalue()
        output.close()
        output = None
        image.close()
        image = None
        raw_bytes = None

        base_name = os.path.splitext(
            os.path.basename(generic_file.file.name))[0]
        # Give upload_to the already-loaded parent; assigning only parent_id
        # makes the descriptor issue an unnecessary SELECT to resolve the path.
        webp_file = Webp(parent=generic_file)
        # A fresh attempt name keeps a concurrent backfill from sharing the
        # key that another attempt may successfully persist. It also gives
        # the cleanup outbox a key even when storage writes the object and
        # raises before returning from the request.
        try:
            from .tasks import _save_generated_file
            _save_generated_file(
                webp_file.file,
                f"{base_name}_{uuid.uuid4().hex}.webp",
                ContentFile(webp_bytes),
            )
        except Exception:
            uploaded_name = webp_file.file.name
            raise
        uploaded_name = webp_file.file.name
        del webp_bytes

        # The expensive storage work is complete before taking the parent
        # lock. Deletion takes the same lock, so either this row commits first
        # and its pre_delete signal captures the key, or the parent is gone
        # and the outbox owns cleanup of the just-written blob.
        with transaction.atomic():
            parent = GenericFile.objects.select_for_update().filter(
                pk=generic_file.pk,
            ).first()
            if parent is None:
                from .tasks import _record_generated_blob_for_cleanup
                _record_generated_blob_for_cleanup(uploaded_name)
                uploaded_name = None
                return
            webp_file.parent = parent
            try:
                with transaction.atomic():
                    webp_file.save()
            except IntegrityError:
                from .tasks import _record_generated_blob_for_cleanup
                _record_generated_blob_for_cleanup(uploaded_name)
                uploaded_name = None
                return

        uploaded_name = None
        logger.info(
            "create_thumbnail: created %s for %s",
            webp_file.file.name, generic_file.pk,
        )
    except Exception as exc:
        if uploaded_name:
            from .tasks import _record_generated_blob_for_cleanup
            _record_generated_blob_for_cleanup(uploaded_name)
        # Broad on purpose: a single unreadable/corrupt upload must not
        # abort a whole backfill batch, and skip_thumbnail guarantees we
        # never retry it forever.
        _mark_skipped(generic_file, f"{type(exc).__name__}: {exc}")
    finally:
        if output is not None:
            output.close()
        if image is not None:
            image.close()
        raw_bytes = None
