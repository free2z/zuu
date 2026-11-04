"""
Enqueue variant generation and durable blob cleanup for upload rows.

All upload paths (multi-file uploads_handle, single_public_upload_handle,
GenericFile.create_from_prompt) go through GenericFile.save(), so a
post_save signal covers them all. The variant job is inserted INSIDE the
upload's transaction (``dj.apps.jobs.transactional.defer_in_transaction``,
), on Django's own connection in a savepoint, so it commits or rolls back
with the row. It used to be ``transaction.on_commit``, which is a separate
statement after COMMIT: a pod killed in between, or a failed INSERT, left an
image that is served without variants forever and no trace of why.

Deletion follows the same boundary in the opposite direction: pre_delete
records storage keys in a database outbox, and a worker removes them after
the row deletion commits.  This covers instance, bulk and cascade deletes.
"""
from django.db import transaction
from django.db.models.signals import post_save, pre_delete
from django.dispatch import receiver

from dj.apps.jobs.transactional import defer_in_transaction

from .models import (
    NON_RASTER_IMAGE_MIME_TYPES,
    VIDEO_MIME_TYPE_VALUES,
    GenericFile,
    ImageVariant,
    Webp,
)
from .tasks import (
    _record_blob_for_cleanup as record_blob_for_cleanup,
    enqueue_video_poster,
    generate_image_variants,
)


@receiver(post_save, sender=GenericFile, dispatch_uid="uploads.enqueue_image_variants")
def enqueue_image_variants(sender, instance, created, **kwargs):
    """Enqueue the derived-asset job this upload needs, if any."""
    if not created:
        return
    if kwargs.get("raw"):
        # fixtures/loaddata: don't enqueue side effects
        return
    if instance.mime_type in VIDEO_MIME_TYPE_VALUES:
        # Videos get exactly one derived still -- the poster frame the
        # `VideoObject` structured data needs. Same worker, different
        # extractor -- and, since, admitted per owner: past
        # VIDEO_POSTER_JOBS_PER_OWNER live jobs the upload gets no job now and
        # is picked up by the top-up/sweep. That sweep is also why this one
        # may stay on `on_commit`: its admission takes its own
        # transaction and lock, and a lost enqueue is exactly the posterless
        # video `sweep_video_posters` already repairs.
        video_id, owner_id = instance.pk, instance.owner_id
        transaction.on_commit(
            lambda: enqueue_video_poster(video_id, owner_id)
        )
        return
    if not instance.mime_type.startswith("image"):
        return
    if instance.mime_type in NON_RASTER_IMAGE_MIME_TYPES:
        return
    defer_in_transaction(
        generate_image_variants.configure(), generic_file_id=instance.pk,
    )


def _record_blob_for_cleanup(name, using):
    if not name:
        return

    record_blob_for_cleanup(
        name,
        using=using,
    )


@receiver(
    pre_delete,
    sender=GenericFile,
    dispatch_uid="uploads.capture_generic_file_blobs",
)
def capture_generic_file_blobs(sender, instance, using, **kwargs):
    """Capture original and currently-known derived keys before parent delete.

    ``Collector`` snapshots cascades before it sends ``pre_delete``.  The
    parent lock and fresh child query close the race where the image worker
    creates a variant after that snapshot but before the parent SQL DELETE.
    """
    GenericFile.objects.using(using).select_for_update().filter(
        pk=instance.pk,
    ).exists()

    names = {getattr(instance.file, "name", "")}
    names.update(
        ImageVariant.objects.using(using).filter(
            parent_id=instance.pk,
        ).values_list("file", flat=True)
    )
    names.update(
        Webp.objects.using(using).filter(
            parent_id=instance.pk,
        ).values_list("file", flat=True)
    )
    for name in names:
        _record_blob_for_cleanup(name, using)

    # Django's outer Collector discovered cascade children before this signal
    # ran. A generator that held the parent lock could therefore have inserted
    # a child after that snapshot. Delete the freshly queried set now, while
    # holding the parent lock; the outer Collector's later zero-row deletes are
    # harmless, and no unseen FK can make the parent DELETE fail.
    ImageVariant.objects.using(using).filter(parent_id=instance.pk).delete()
    Webp.objects.using(using).filter(parent_id=instance.pk).delete()


@receiver(
    pre_delete,
    sender=ImageVariant,
    dispatch_uid="uploads.capture_image_variant_blob",
)
def capture_image_variant_blob(sender, instance, using, **kwargs):
    _record_blob_for_cleanup(getattr(instance.file, "name", ""), using)


@receiver(
    pre_delete,
    sender=Webp,
    dispatch_uid="uploads.capture_webp_blob",
)
def capture_webp_blob(sender, instance, using, **kwargs):
    _record_blob_for_cleanup(getattr(instance.file, "name", ""), using)
