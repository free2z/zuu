"""
Procrastinate tasks for the uploads app (autodiscovered via
procrastinate.contrib.django, PROCRASTINATE_AUTODISCOVER_MODULE_NAME
default "tasks").

Jobs are enqueued transactionally (transaction.on_commit + defer) from
the GenericFile post_save signal — see signals.py — and executed by the
image-variant-worker Deployment (k8s/free2z/worker/).
"""
import errno
import logging
import os
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from datetime import timedelta
from functools import wraps
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from django.apps import apps
from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import storages
from django.db import IntegrityError, OperationalError, connection, transaction
from django.db.models import Q
from django.db.models.fields.files import FileField
from django.utils import timezone

import requests
from google.api_core.exceptions import (
    BadGateway,
    GatewayTimeout,
    GoogleAPICallError,
    InternalServerError,
    RetryError,
    ServiceUnavailable,
    TooManyRequests,
)
from google.auth.exceptions import TransportError
from urllib3.exceptions import PoolError, ProtocolError, SSLError, TimeoutError
from procrastinate import RetryStrategy
from procrastinate.contrib.django import app
from procrastinate.exceptions import AlreadyEnqueued, ConnectorException

from dj.apps.jobs.admission import live_jobs_for
from dj.apps.jobs.admission import live_job_rows
from dj.apps.jobs.priorities import (
    INTERACTIVE,
    MAINTENANCE,
)
from dj.apps.jobs.retry import JitteredRetryStrategy, SplitRetryStrategy

from .video_utils import PosterRetryable

logger = logging.getLogger(__name__)

WEBP_QUALITY = 82
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Permanent media failures keep today's bounded retry policy. Infrastructure
# failures use full jitter and a longer horizon so a decoder/storage outage or
# node drain does not exhaust retries before the service recovers. Procrastinate
# counts max_attempts as retries after the first execution (attempts starts 0).
MEDIA_VARIANT_RETRY = RetryStrategy(max_attempts=3, exponential_wait=4)
INFRA_VARIANT_RETRY = JitteredRetryStrategy(
    max_attempts=8, base=15, cap=5 * 60,
)
VARIANT_RETRY = SplitRetryStrategy(
    infra=INFRA_VARIANT_RETRY,
    media=MEDIA_VARIANT_RETRY,
    # These are the transient exception classes used by the installed
    # google-cloud-storage retry policy, plus the task's decoder marker.
    infra_exceptions=(
        PosterRetryable,
        requests.exceptions.ConnectionError,
        requests.exceptions.Timeout,
        requests.exceptions.ChunkedEncodingError,
        TransportError,
        RetryError,
        GoogleAPICallError,
        PoolError,
        ProtocolError,
        SSLError,
        TimeoutError,
        TooManyRequests,
        InternalServerError,
        BadGateway,
        ServiceUnavailable,
        GatewayTimeout,
    ),
    # The installed storage retry predicate also retries bare HTTP 408
    # Google API errors, for which google-api-core has no dedicated subclass.
    infra_status_codes=(408, 429, 500, 502, 503, 504),
    # These are node-pressure errors raised directly by tempfile and
    # subprocess.Popen in video_utils: descriptor exhaustion, fork pressure,
    # and exhausted /tmp space or quota. Do not classify every OSError as
    # infrastructure; requests.HTTPError inherits OSError too.
    infra_oserror_errnos=(
        errno.EMFILE,
        errno.ENFILE,
        errno.EAGAIN,
        errno.ENOSPC,
        errno.EDQUOT,
        errno.ENOMEM,
    ),
)

# Storage deletion is deliberately one key per job.  A transient GCS failure
# therefore retries only the failed key; successful siblings are already
# durably removed from the outbox.  The periodic sweep below also re-enqueues
# rows if a web process dies after committing the deletion transaction but
# before its on_commit callback can write a job.
BLOB_DELETION_RETRY = RetryStrategy(max_attempts=5, exponential_wait=5)
BLOB_DELETION_SWEEP_CRON = getattr(
    settings, "UPLOAD_BLOB_DELETION_SWEEP_CRON", "*/5 * * * *")
BLOB_DELETION_PRIORITY = MAINTENANCE
BLOB_DELETION_ROLLOUT_DELAY = timedelta(seconds=int(getattr(
    settings, "UPLOAD_BLOB_DELETION_ROLLOUT_DELAY_SECONDS", 300)))
BLOB_DELETION_REENQUEUE_AFTER = timedelta(seconds=max(
    int(BLOB_DELETION_ROLLOUT_DELAY.total_seconds()) * 2,
    int(getattr(settings, "UPLOAD_BLOB_DELETION_REENQUEUE_AFTER_SECONDS", 900)),
))
# Same rollout hazard the blob-deletion delay above exists for, and the same
# remedy. `uploads.generate_video_poster` is a NEW task name: during a rollout
# a new web pod can accept a video while an OLD catch-all worker is still
# alive, and that worker will fetch a job whose name is not in its registry and
# fail it TERMINALLY. There is no periodic poster sweep, so the upload would
# then stay posterless until somebody reran the one-shot backfill. Holding the
# job for a few minutes lets the worker rollout finish first.
VIDEO_POSTER_ROLLOUT_DELAY = timedelta(seconds=int(getattr(
    settings, "UPLOAD_VIDEO_POSTER_ROLLOUT_DELAY_SECONDS", 300)))

# PER-OWNER ADMISSION CONTROL FOR POSTER JOBS.
#
# `post_save` used to enqueue a poster job for EVERY authenticated video
# upload, at default priority, onto the concurrency-1 catch-all worker that
# also carries notifications, translation, search indexing and blob cleanup.
#  bounded each decoder child (75 s wall, 768 MiB, 8 MiB per file),
# not whole-job storage or database time. It did not bound
# how many of them one account can put in front of everyone else's work. An
# account uploading steadily could keep that worker busy indefinitely, and the
# backlog alert needs the same worker to run.
#
# So at most this many poster jobs per OWNER may be queued or running at once
# (`todo`/`doing`/`aborting`). An upload past the cap gets NO job at enqueue
# time. It is not forgotten: every poster job that finishes tops its owner's
# lane back up from the owner's posterless videos (`top_up_video_posters`),
# and a periodic sweep does the same for everything inside
# VIDEO_POSTER_SWEEP_WINDOW -- so a bulk uploader drains at the worker's full
# speed while never holding more than this many slots, and one dead job
# cannot orphan the rest.
#
# 4 limits queued/running poster count per owner. It is not a bound on
# notification latency: storage I/O, DNS and sweep candidate queries have
# no whole-job deadline, and multiple owners share this worker.
VIDEO_POSTER_JOBS_PER_OWNER = int(getattr(
    settings, "UPLOAD_VIDEO_POSTER_JOBS_PER_OWNER", 4))

# The sweep is the backstop for the top-up. It only ever considers videos
# that have NO poster and have NEVER had a poster job -- a job in any state,
# including `succeeded` with no poster (undecodable) or `failed` (retries
# exhausted), counts as attempted, so a pathological file cannot be
# re-demuxed every ten minutes forever. Procrastinate retains finished jobs
# (nothing here schedules `remove_old_jobs`), which is what makes "has a
# job" a durable marker without a migration.
#
# The window bounds the other direction: a video older than this that never
# got a job is the manual backfill's business (as it was before ), not
# something the sweep re-discovers every run for the life of the corpus.
VIDEO_POSTER_SWEEP_CRON = getattr(
    settings, "UPLOAD_VIDEO_POSTER_SWEEP_CRON", "*/10 * * * *")
VIDEO_POSTER_SWEEP_WINDOW = timedelta(seconds=int(getattr(
    settings, "UPLOAD_VIDEO_POSTER_SWEEP_WINDOW_SECONDS", 7 * 24 * 3600)))
# Jobs one sweep run may enqueue in total, across owners. The per-owner cap
# bounds fairness; this bounds how much a single sweep can put on the lane.
VIDEO_POSTER_SWEEP_BUDGET = int(getattr(
    settings, "UPLOAD_VIDEO_POSTER_SWEEP_BUDGET", 100))
VIDEO_POSTER_TASK_NAME = "uploads.generate_video_poster"
# Failed posters may be readmitted after cooldown while their cumulative
# execution budget has room for another complete retry cycle. One cycle can
# execute once initially, eight more times under the
# infrastructure retry strategy, and up to JOB_RECLAIM_MAX_RECLAIMS times
# after worker crashes. Reserve for the reclaimer too, keeping two cycles under
# a hard total-start ceiling when every failure path takes its full allowance.
VIDEO_POSTER_READMISSION_COOLDOWN = timedelta(minutes=30)
VIDEO_POSTER_READMISSION_MAX_RUNS = (
    INFRA_VARIANT_RETRY.max_attempts
    + settings.JOB_RECLAIM_MAX_RECLAIMS
    + 1
)
VIDEO_POSTER_READMISSION_ATTEMPT_CEILING = 2 * VIDEO_POSTER_READMISSION_MAX_RUNS
#Procrastinate statuses that occupy a slot in the owner's lane.
#Key-class for the per-owner admission lock (`pg_advisory_xact_lock`), so
#it cannot collide with any other advisory lock in the schema.
VIDEO_POSTER_ADMISSION_LOCK_CLASS = 157_500

BLOB_DELETE_REQUEST_TIMEOUT_SECONDS = float(getattr(
    settings, "UPLOAD_BLOB_DELETE_REQUEST_TIMEOUT_SECONDS", 10))
BLOB_DELETE_RETRY_TIMEOUT_SECONDS = float(getattr(
    settings, "UPLOAD_BLOB_DELETE_RETRY_TIMEOUT_SECONDS", 30))


def _prepare_for_webp(image):
    """
    Normalize a Pillow image to a mode WebP can encode, preserving alpha.
    """
    if image.mode == 'P':
        # Palette images: keep transparency if the palette has it
        if 'transparency' in image.info:
            return image.convert('RGBA')
        return image.convert('RGB')
    if image.mode in ('RGBA', 'LA'):
        return image.convert('RGBA')
    if image.mode != 'RGB':
        return image.convert('RGB')
    return image


def _png_has_animation(source):
    """Find an APNG animation chunk without buffering the source object."""
    try:
        source.seek(0)
        if source.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
            return False
        while True:
            header = source.read(8)
            if len(header) != 8:
                return False
            length = int.from_bytes(header[:4], "big")
            chunk_type = header[4:]
            if chunk_type == b"acTL":
                return True
            if chunk_type == b"IDAT":
                return False
            source.seek(length + 4, os.SEEK_CUR)
    except (OSError, ValueError):
        return False
    finally:
        try:
            source.seek(0)
        except (OSError, ValueError):
            pass


def _is_animated(image, source=None):
    if getattr(image, 'is_animated', False):
        return True
    if image.format == 'PNG' and source is not None:
        # Pillow reports APNGs as animated on supported versions. The chunk
        # probe preserves the legacy fallback without retaining the complete
        # compressed upload in Python memory.
        return _png_has_animation(source)
    return False


def _has_live_file_reference(
        name: str, storage_alias: str, *, exclude_instance=None) -> bool:
    """Return whether any committed Django ``FileField`` still owns *name*.

    Upload paths are normally unique, but the database does not enforce that
    uniqueness and old/manual rows can share a storage key.  Looking across
    every concrete FileField is intentionally conservative: a same-named KYC
    document in another storage alias is a harmless false positive, while
    deleting it by mistake would be data loss.

    ``exclude_instance`` is for synchronous cleanup of a row that was just
    written in the current transaction. Its own uncommitted reference must
    not hide a second live row that protects the object from deletion.
    """
    target_storage = storages[storage_alias]
    excluded_model = None
    excluded_pk = None
    if exclude_instance is not None and exclude_instance.pk is not None:
        excluded_model = exclude_instance._meta.concrete_model
        excluded_pk = exclude_instance.pk

    for model in apps.get_models():
        references = Q()
        has_relevant_field = False
        for field in model._meta.get_fields():
            if not isinstance(field, FileField) or not field.concrete:
                continue
            if field.storage != target_storage:
                continue
            field_reference = Q(**{field.name: name})
            if (
                    excluded_model is not None
                    and model._meta.concrete_model is excluded_model
            ):
                field_reference &= ~Q(pk=excluded_pk)
            references |= field_reference
            has_relevant_field = True
        if has_relevant_field and model._base_manager.filter(
            references,
        ).exists():
            return True
    return False


_BLOB_MISSING = object()
_PENDING_GONE = object()


def _gcs_backend(storage):
    """Return the optional GCS pieces needed by cleanup, if applicable."""
    try:
        from google.api_core.exceptions import NotFound
        from google.api_core.exceptions import PreconditionFailed
        from google.cloud.storage.retry import DEFAULT_RETRY
        from storages.backends.gcloud import GoogleCloudStorage
        from storages.utils import clean_name
    except ImportError:  # pragma: no cover - non-GCS optional dependency
        return None

    if not isinstance(storage, GoogleCloudStorage):
        return None
    return NotFound, PreconditionFailed, DEFAULT_RETRY, clean_name


def _get_gcs_target_generation(storage, name: str):
    """Return ``(generation, is_production_gcs)`` for a cleanup target.

    ``_BLOB_MISSING`` means the object was already gone. A missing generation
    on a fetched production blob is an error: deleting that object by name
    would make a retry vulnerable to a same-name replacement.
    """
    gcs = _gcs_backend(storage)
    if gcs is None or settings.NAMESPACE != "prod":
        return None, False

    NotFound, _PreconditionFailed, retry, clean_name = gcs
    normalized_name = storage._normalize_name(clean_name(name))
    try:
        blob = storage.bucket.get_blob(
            normalized_name,
            timeout=BLOB_DELETE_REQUEST_TIMEOUT_SECONDS,
            retry=retry.with_timeout(BLOB_DELETE_RETRY_TIMEOUT_SECONDS),
        )
    except NotFound:
        return _BLOB_MISSING, True

    if blob is None:
        return _BLOB_MISSING, True
    generation = getattr(blob, "generation", None)
    if generation is None:
        raise RuntimeError(
            f"GCS object {normalized_name} has no generation")
    return int(generation), True


def _persist_pending_blob_generation(pending_blob_id, generation):
    """Commit a captured GCS generation without doing storage I/O.

    A worker may capture metadata concurrently with another worker. The first
    generation committed wins; a later worker must use that durable value,
    even if its own metadata call observed a newer same-name object.
    """
    from .models import PendingUploadBlobDeletion

    with transaction.atomic():
        pending = PendingUploadBlobDeletion.objects.select_for_update().filter(
            pk=pending_blob_id,
        ).first()
        if pending is None:
            return _PENDING_GONE
        if pending.generation is not None:
            return pending.generation
        if generation is _BLOB_MISSING:
            # GCS is strongly consistent for object existence. There is no
            # object left for this intent to protect or delete, so finalize
            # the intent rather than leave an ambiguous name-only retry.
            pending.delete()
            return _BLOB_MISSING
        pending.generation = int(generation)
        pending.save(update_fields=["generation"])
        return pending.generation


def _ensure_pending_blob_generation(pending):
    """Capture and commit a production GCS generation when one is needed.

    The metadata request is deliberately outside the short transaction that
    persists the generation. Once a generation is present in the outbox, this
    function never looks up the name again; retries therefore cannot resolve a
    same-name replacement.
    """
    if pending.generation is not None:
        return pending.generation

    storage = storages[pending.storage_alias]
    if settings.NAMESPACE != "prod" or _gcs_backend(storage) is None:
        return None

    captured_generation, _is_production_gcs = _get_gcs_target_generation(
        storage,
        pending.name,
    )
    return _persist_pending_blob_generation(
        pending.pk,
        captured_generation,
    )


def _delete_from_storage(storage, name: str, *, generation=None):
    """Delete with a bounded timeout and a generation precondition on GCS.

    The boolean result says whether cleanup is complete for this environment.
    A production GCS row with no durable generation is deliberately retained;
    all other backends, including lower-environment GCS, preserve their prior
    behavior and report completion after their normal/no-op handling.
    """
    gcs = _gcs_backend(storage)

    if gcs is not None:
        NotFound, PreconditionFailed, retry, clean_name = gcs
        # Production, stage, and test intentionally share one GCS bucket, and
        # lower environments are refreshed from production database copies.
        # A lower-environment database therefore cannot prove that a key is
        # globally unreferenced: deleting it here could break a live prod row.
        # Local/test filesystem backends remain deletable, while shared GCS
        # garbage collection is owned exclusively by the production database.
        if settings.NAMESPACE != "prod":
            logger.warning(
                "uploads: retaining shared GCS key %s in namespace %s",
                name,
                settings.NAMESPACE,
            )
            return True
        if generation is None:
            logger.error(
                "uploads: refusing generation-unsafe GCS delete for %s",
                name,
            )
            return False
        normalized_name = storage._normalize_name(clean_name(name))
        try:
            storage.bucket.delete_blob(
                normalized_name,
                timeout=BLOB_DELETE_REQUEST_TIMEOUT_SECONDS,
                retry=retry.with_timeout(
                    BLOB_DELETE_RETRY_TIMEOUT_SECONDS),
                if_generation_match=generation,
            )
        except (NotFound, PreconditionFailed):
            # The original generation is already gone, or a replacement now
            # owns this name. Both outcomes are safe terminal states for this
            # cleanup intent; never retry by name.
            return True
        return True

    storage.delete(name)
    return True


@app.task(
    name="uploads.delete_pending_blob", queue="images",
    retry=BLOB_DELETION_RETRY,
)
def delete_pending_blob(pending_blob_id: int):
    """Delete one outbox blob after checking that no row still references it.

    The outbox row and the model deletion are committed before this task runs.
    Storage deletion is outside database transactions. If storage raises, the
    outbox row remains intact and Procrastinate retries it. If the process dies
    after storage succeeds but before finalization, the same idempotent delete
    is retried and the row is still available to the periodic backstop.

    Generation capture and persistence are separate from the reference check:
    metadata is read without a database row lock, the generation is committed,
    then references are checked, and only then is storage deletion attempted.
    The reference query is deliberately conservative but not a lock that can
    cover arbitrary raw/manual FileField writers through an external storage
    call. Derived writers use per-attempt UUID names, so normal in-process
    retries cannot create a new same-key reference after this check.
    """
    from .models import PendingUploadBlobDeletion

    pending = PendingUploadBlobDeletion.objects.filter(
        pk=pending_blob_id,
    ).first()
    if pending is None:
        return

    storage = storages[pending.storage_alias]
    generation = _ensure_pending_blob_generation(pending)
    if generation in (_BLOB_MISSING, _PENDING_GONE):
        return
    if (
        settings.NAMESPACE == "prod"
        and _gcs_backend(storage) is not None
        and generation is None
    ):
        # The row disappeared while another worker was persisting its
        # generation. Do not perform a name-only production delete.
        return

    # This is intentionally after generation persistence has committed and
    # outside any pending-row lock. A replacement written after this check is
    # still protected by if_generation_match on production GCS.
    if _has_live_file_reference(pending.name, pending.storage_alias):
        logger.info(
            "delete_pending_blob: keeping referenced key %s",
            pending.name,
        )
        return

    if not _delete_from_storage(
        storage, pending.name, generation=generation,
    ):
        return

    # Storage succeeded (or safely reported the target already absent). Keep
    # the database transaction limited to finalizing the durable intent.
    with transaction.atomic():
        PendingUploadBlobDeletion.objects.filter(pk=pending_blob_id).delete()


def enqueue_blob_cleanup(pending_blob_id: int) -> bool:
    """Enqueue one outbox row without duplicating pending work.

    The queueing lock collapses cascade callbacks and a recovery sweep onto
    one ``todo`` job. ``last_enqueued_at`` prevents a terminal storage outage
    from recreating the same failed jobs every five minutes; a retained row
    gets one bounded fresh attempt per recovery interval until it succeeds.
    """
    from .models import PendingUploadBlobDeletion

    try:
        delete_pending_blob.configure(
            queueing_lock=f"upload-blob-delete-{pending_blob_id}",
            priority=BLOB_DELETION_PRIORITY,
            schedule_at=timezone.now() + BLOB_DELETION_ROLLOUT_DELAY,
        ).defer(pending_blob_id=pending_blob_id)
    except AlreadyEnqueued:
        pass
    except Exception:
        logger.exception(
            "uploads: failed to enqueue blob cleanup %s", pending_blob_id)
        return False

    PendingUploadBlobDeletion.objects.filter(pk=pending_blob_id).update(
        last_enqueued_at=timezone.now(),
    )
    return True


@app.periodic(cron=BLOB_DELETION_SWEEP_CRON)
@app.task(
    name="uploads.enqueue_pending_blob_deletions", queue="images",
)
def enqueue_pending_blob_deletions(timestamp: int):
    """Backstop missed dispatches without flooding the shared worker."""
    from .models import PendingUploadBlobDeletion

    # Always repair never-dispatched rows first. Retained rows (storage
    # outage, or a deliberately shared key) get at most one fresh job per
    # recovery interval; the 100-row cap and negative priority keep recovery
    # from flooding the shared worker or starving newer cleanup.
    pending_ids = list(
        PendingUploadBlobDeletion.objects.filter(
            last_enqueued_at__isnull=True,
        ).order_by("created_at").values_list("pk", flat=True)[:100]
    )
    remaining = 100 - len(pending_ids)
    if remaining:
        stale_before = timezone.now() - BLOB_DELETION_REENQUEUE_AFTER
        pending_ids.extend(
            PendingUploadBlobDeletion.objects.filter(
                last_enqueued_at__lt=stale_before,
            ).order_by("last_enqueued_at", "created_at").values_list(
                "pk", flat=True,
            )[:remaining]
        )
    for pending_blob_id in pending_ids:
        enqueue_blob_cleanup(pending_blob_id)
    return len(pending_ids)


def _prepared_variant_payloads(generic_file):
    """Yield one encoded width at a time outside any database lock.

    The source is copied in chunks to a temporary file rather than a Python
    ``bytes`` object. Each width reopens and decodes the source independently,
    closes every Pillow image before yielding, and lets the caller release the
    one encoded payload before the next width is decoded. This costs a few
    extra local reads, but keeps a compressed multi-GB upload, decoded raster,
    prepared raster, and all encoded variants from sharing the worker's
    memory budget .
    """
    from .image_utils import MAX_DECODE_PIXELS
    from .models import VARIANT_WIDTHS

    try:
        with generic_file.file.open(mode='rb') as source:
            with tempfile.TemporaryFile() as source_copy:
                shutil.copyfileobj(source, source_copy, length=1024 * 1024)
                source_copy.seek(0)
                with Image.open(source_copy) as image:
                    if _is_animated(image, source_copy):
                        logger.info(
                            "generate_image_variants: skipping animated "
                            "image %s (%s)",
                            generic_file.pk, generic_file.file.name,
                        )
                        return

                    original_width = image.width
                    pixels = image.width * image.height
                    if pixels > MAX_DECODE_PIXELS:
                        logger.info(
                            "generate_image_variants: skipping %s (%s): "
                            "%s = %s px exceeds MAX_DECODE_PIXELS (%s)",
                            generic_file.pk,
                            generic_file.file.name,
                            f"{image.width}x{image.height}",
                            pixels,
                            MAX_DECODE_PIXELS,
                        )
                        return

                del image

                for width in VARIANT_WIDTHS:
                    if width >= original_width:
                        continue

                    source_copy.seek(0)
                    with Image.open(source_copy) as image:
                        image.load()
                        prepared = None
                        prepared = _prepare_for_webp(image)
                        try:
                            height = max(
                                1,
                                round(
                                    prepared.height * width / prepared.width
                                ),
                            )
                            with prepared.resize(
                                (width, height), Image.LANCZOS,
                            ) as resized:
                                with BytesIO() as output:
                                    resized.save(
                                        output,
                                        format='WEBP',
                                        quality=WEBP_QUALITY,
                                    )
                                    encoded = output.getvalue()
                        finally:
                            if prepared is not None and prepared is not image:
                                prepared.close()
                        del prepared

                    del image

                    yield width, encoded
                    del encoded
    except UnidentifiedImageError:
        logger.warning(
            "generate_image_variants: unidentifiable image for %s (%s)",
            generic_file.pk, generic_file.file.name,
        )
        return
    except FileNotFoundError:
        logger.warning(
            "generate_image_variants: missing file for %s (%s)",
            generic_file.pk, generic_file.file.name,
        )
        return


def _record_blob_for_cleanup(
        name: str, *, using="default", enqueue=True):
    """Create a database-only cleanup intent and optionally enqueue it.

    In particular, this helper is safe to call from a ``pre_delete`` signal:
    it never resolves a storage backend or performs metadata I/O. Production
    GCS generation capture belongs to the worker's committed preparation
    phase, after the deleting transaction has finished.
    """
    from .models import PendingUploadBlobDeletion, UPLOAD_STORAGE_ALIAS

    if not name:
        return None

    manager = PendingUploadBlobDeletion.objects.using(using)
    pending, created = manager.get_or_create(
        storage_alias=UPLOAD_STORAGE_ALIAS,
        name=name,
        defaults={"generation": None},
    )

    # A row that already exists is either already queued or is covered by the
    # periodic sweep. Avoid registering a second callback that could enqueue a
    # job for a row removed later in the same transaction.
    if enqueue and created:
        transaction.on_commit(
            lambda pending_blob_id=pending.pk: enqueue_blob_cleanup(
                pending_blob_id),
            using=using,
            robust=True,
        )
    return pending


def _record_generated_blob_for_cleanup(name: str, *, enqueue=True):
    """Persist cleanup for a blob that lost its parent/uniqueness race."""
    return _record_blob_for_cleanup(name, enqueue=enqueue)


def _save_generated_file(field_file, requested_name, content):
    """Save a generated file with a known name before crossing storage.

    ``FieldFile.save`` assigns ``field_file.name`` only after
    ``storage.save`` returns. A storage backend can commit the object and
    then raise on the response, leaving the caller with no key to put in the
    deletion outbox. Resolve the upload path and an available name first,
    assign it before the external write, and still retain the backend's
    returned name on success.

    Callers must inspect ``field_file.name`` when this raises: it is the
    storage key this call may have written (even when the backend raised
    after writing it), or empty when it provably wrote nothing -- and it is
    never a key another writer created, so it is always safe to outbox.

    The create-only backend  can move off ``attempted_name``: a 412
    there means another writer owns it, and the save retries under a new
    name. Its exceptions therefore say which key, if any, the failed call may
    have left behind (``POSSIBLY_WRITTEN_NAME_ATTR``); leaving
    ``attempted_name`` on the field after, say, five 412s would hand the
    other writer's live key to the deletion outbox.
    """
    from .storage import POSSIBLY_WRITTEN_NAME_ATTR

    attempted_name = field_file.field.generate_filename(
        field_file.instance, requested_name)
    attempted_name = field_file.storage.get_available_name(
        attempted_name, max_length=field_file.field.max_length)
    field_file.name = attempted_name

    try:
        saved_name = field_file.storage.save(
            attempted_name, content, max_length=field_file.field.max_length)
    except Exception as exc:
        if hasattr(exc, POSSIBLY_WRITTEN_NAME_ATTR):
            field_file.name = getattr(exc, POSSIBLY_WRITTEN_NAME_ATTR) or None
        raise
    field_file.name = saved_name
    field_file._committed = True
    return saved_name


@app.task(
    name="uploads.generate_image_variants", queue="images",
    retry=VARIANT_RETRY, priority=INTERACTIVE,
)
def generate_image_variants(generic_file_id: int):
    """
    Generate the WebP size ladder (VARIANT_WIDTHS) for one GenericFile.

    Idempotent: widths that already have an ImageVariant are skipped, so
    re-running (retries, backfill sweeps) never duplicates work. Widths
    >= the original width are skipped — we never upscale.
    """
    from .models import NON_RASTER_IMAGE_MIME_TYPES, GenericFile, ImageVariant

    generic_file = GenericFile.objects.filter(pk=generic_file_id).first()
    if generic_file is None:
        logger.warning(
            "generate_image_variants: GenericFile %s no longer exists",
            generic_file_id,
        )
        return
    if not generic_file.mime_type.startswith("image"):
        return
    if generic_file.mime_type in NON_RASTER_IMAGE_MIME_TYPES:
        return

    payloads = _prepared_variant_payloads(generic_file)
    base_name = os.path.splitext(
        os.path.basename(generic_file.file.name))[0]
    created = 0

    # Storage I/O happens before the short parent-lock transaction. Once a
    # blob has a known key, either its row commits while holding the same lock
    # deletion takes, or a durable outbox row owns its cleanup.
    for width, payload in payloads:
        try:
            if ImageVariant.objects.filter(
                parent_id=generic_file_id, width=width, format='webp',
            ).exists():
                continue

            # Give upload_to the already-loaded parent; assigning only
            # parent_id makes the descriptor issue an unnecessary SELECT to
            # resolve the path.
            variant = ImageVariant(
                parent=generic_file, width=width, format='webp')
            # The UUID makes concurrent attempts distinct before either one
            # asks storage whether the name is available. That prevents a
            # losing uniqueness race from outboxing a key the winning row
            # references.
            try:
                _save_generated_file(
                    variant.file,
                    f"{base_name}_w{width}_{uuid.uuid4().hex}.webp",
                    ContentFile(payload),
                )
            except Exception:
                # _save_generated_file assigns the attempted name before
                # storage I/O, so this also covers a write-then-raise timeout.
                _record_generated_blob_for_cleanup(variant.file.name)
                raise
            try:
                with transaction.atomic():
                    parent = GenericFile.objects.select_for_update().filter(
                        pk=generic_file_id,
                    ).first()
                    if parent is None:
                        _record_generated_blob_for_cleanup(variant.file.name)
                        return
                    variant.parent = parent
                    try:
                        with transaction.atomic():
                            variant.save()
                    except IntegrityError:
                        _record_generated_blob_for_cleanup(variant.file.name)
                        continue
            except Exception:
                # The storage write already succeeded. Preserve its key before
                # a database outage or unexpected row-write failure is retried.
                _record_generated_blob_for_cleanup(variant.file.name)
                raise
            created += 1
        finally:
            # The generator has already closed Pillow objects before yielding;
            # this drops the one encoded payload before the next width starts.
            del payload

    logger.info(
        "generate_image_variants: %s variants created for %s (%s)",
        created, generic_file.pk, generic_file.file.name,
    )


@app.task(
    name="uploads.generate_video_poster", queue="images",
    retry=VARIANT_RETRY, priority=INTERACTIVE,
)
def generate_video_poster(generic_file_id: int):
    """
    Extract and store one poster frame for a video GenericFile.

    The poster is an `ImageVariant` row whose parent is the video, so its
    URL follows the video's own `_get_prefix()` -- a members-only video's
    poster is served only through the authenticated `/uploadz/` route, and
    a private video's poster is never public. Nothing is copied to a second
    location (media access model, tuzi#1463).

    Idempotent: a video that already has a variant is left alone, so a
    retry, a re-upload signal and the backfill command can all run over the
    same corpus without duplicating work or blobs.

    Terminal on bad input: `extract_poster_bytes` raises only for a
    transient failure (so procrastinate retries it); an undecodable or
    oversized video, or a source object that is gone from storage
    (tuzi#2096), simply ends with no poster and no retries. That is the
    intended outcome -- a `thumbnailUrl` that 404s is worse than none at
    all.
    """
    from .models import GenericFile, ImageVariant
    from .video_utils import extract_poster_bytes, poster_file_name

    generic_file = GenericFile.objects.filter(pk=generic_file_id).first()
    if generic_file is None:
        logger.warning(
            "generate_video_poster: GenericFile %s no longer exists",
            generic_file_id,
        )
        return
    if not generic_file.mime_type.startswith("video"):
        return
    if ImageVariant.objects.filter(parent_id=generic_file_id).exists():
        _top_up_after_poster_job(generic_file)
        return

    extracted = extract_poster_bytes(generic_file)
    if extracted is None:
        # Terminal for THIS video; the owner's lane still has a slot to give
        # back. A transient failure raised out of `extract_poster_bytes`
        # skips this on purpose -- the job is retried, and its slot stays
        # occupied until the retry settles.
        _top_up_after_poster_job(generic_file)
        return
    payload, width, height = extracted

    # Same ordering as generate_image_variants: storage I/O first, then a
    # short transaction under the parent lock. Either the row commits while
    # holding the lock deletion takes, or the outbox owns the blob.
    variant = ImageVariant(parent=generic_file, width=width, format='webp')
    try:
        _save_generated_file(
            variant.file,
            poster_file_name(generic_file, uuid.uuid4().hex),
            ContentFile(payload),
        )
    except Exception:
        _record_generated_blob_for_cleanup(variant.file.name)
        raise
    finally:
        del payload

    try:
        with transaction.atomic():
            parent = GenericFile.objects.select_for_update().filter(
                pk=generic_file_id,
            ).first()
            if parent is None:
                _record_generated_blob_for_cleanup(variant.file.name)
                return
            variant.parent = parent
            try:
                with transaction.atomic():
                    variant.save()
            except IntegrityError:
                # Another attempt won the (parent, width, format) race.
                _record_generated_blob_for_cleanup(variant.file.name)
                return
    except Exception:
        _record_generated_blob_for_cleanup(variant.file.name)
        raise

    logger.info(
        "generate_video_poster: %s (%sx%s) created for %s (%s)",
        variant.file.name, width, height, generic_file.pk,
        generic_file.file.name,
    )
    _top_up_after_poster_job(generic_file)


# ---------------------------------------------------------------------------
# Per-owner poster admission. See VIDEO_POSTER_JOBS_PER_OWNER.
# ---------------------------------------------------------------------------

def _poster_jobs():
    """Poster jobs, annotated with the video id their args name.

    Compared AS TEXT (`args->>'generic_file_id'` against `id::text`) rather
    than cast to an integer: a cast can raise mid-scan on any row whose key
    is not numeric, and Postgres is free to evaluate it before the
    `task_name` predicate that would have excluded that row.
    """
    from django.db.models.fields.json import KeyTextTransform

    from procrastinate.contrib.django.models import ProcrastinateJob

    return ProcrastinateJob.objects.filter(
        task_name=VIDEO_POSTER_TASK_NAME,
    ).annotate(
        video_id_text=KeyTextTransform("generic_file_id", "args"),
    )


def _live_poster_jobs_for_owner(owner_id, *, exclude_generic_file_id=None):
    """How many of this owner's poster jobs are queued or running."""
    return live_jobs_for(
        VIDEO_POSTER_TASK_NAME,
        owner_id,
        exclude_key=exclude_generic_file_id,
    )


def _posterless_videos_admissible(since, now=None, *, owner_id=None):
    """Never-attempted and bounded failed videos from the candidate set."""
    from django.db.models import Count, Exists, Max, OuterRef, Q, Sum, TextField, Subquery
    from django.db.models.functions import Cast
    from procrastinate.contrib.django.models import ProcrastinateEvent

    from dj.apps.jobs.models import QuarantinedJob
    from .models import VIDEO_MIME_TYPE_VALUES, GenericFile, ImageVariant

    now = now or timezone.now()
    videos = GenericFile.objects.filter(
        mime_type__in=sorted(VIDEO_MIME_TYPE_VALUES),
        created_at__gte=since,
    ).annotate(
        video_id_text=Cast("pk", TextField()),
        has_variants=Exists(
            ImageVariant.objects.filter(parent=OuterRef("pk")),
        ),
    ).filter(
        has_variants=False,
    )
    if owner_id is not None:
        videos = videos.filter(owner_id=owner_id)
    candidate_video_ids = Subquery(
        videos.order_by().values("video_id_text"),
    )
    # Restrict retained job history before aggregating it. The sweep uses the
    # recent posterless candidate set; an owner top-up narrows that set to one
    # owner instead of aggregating every failed poster job each time.
    poster_history = _poster_jobs().filter(
        video_id_text__in=candidate_video_ids,
        video_id_text__isnull=False,
    )
    failed = poster_history.filter(status="failed").annotate(
        failed_at=Subquery(
            ProcrastinateEvent.objects.filter(
                job_id=OuterRef("pk"), type="failed",
            ).order_by("-at").values("at")[:1],
        ),
        has_active_quarantine=Exists(QuarantinedJob.objects.filter(
            job_id=OuterRef("pk"),
            task_name=VIDEO_POSTER_TASK_NAME,
            requeued_at__isnull=True,
        )),
    )
    failed_video_ids = failed.order_by().values("video_id_text").annotate(
        latest_failure=Max("failed_at"),
        # Terminal rows' attempts already include their final execution.
        total_attempts=Sum("attempts"),
        quarantined_jobs=Count("pk", filter=Q(has_active_quarantine=True)),
    ).filter(
        latest_failure__lte=now - VIDEO_POSTER_READMISSION_COOLDOWN,
        total_attempts__lte=(
            VIDEO_POSTER_READMISSION_ATTEMPT_CEILING
            - VIDEO_POSTER_READMISSION_MAX_RUNS
        ),
        quarantined_jobs=0,
    ).values("video_id_text")
    all_history_video_ids = poster_history.order_by().values("video_id_text")
    nonfailed_video_ids = poster_history.exclude(
        status="failed",
    ).order_by().values("video_id_text")

    return videos.filter(
        ~Q(video_id_text__in=Subquery(all_history_video_ids))
        | (
            Q(video_id_text__in=Subquery(failed_video_ids))
            & ~Q(video_id_text__in=Subquery(nonfailed_video_ids))
        )
    ).order_by("created_at", "pk")


def _owners_with_full_lanes():
    """Owners with VIDEO_POSTER_JOBS_PER_OWNER or more live poster jobs.

    The sweep's candidate list is drawn WITHOUT these, so an owner whose
    lane is full cannot occupy a candidate slot that enqueues nothing
    (codex adversarial review: a hundred full lanes used to fill the whole
    selection every run, and an owner behind them whose last job had
    exhausted its retries -- which runs no completion top-up -- waited until
    its videos aged out of the window). One grouped query over the live
    jobs, which are few by construction: the cap is what bounds them.
    """
    from django.db.models import Count, TextField
    from django.db.models.fields.json import KeyTextTransform
    from django.db.models.functions import Cast

    from .models import VIDEO_MIME_TYPE_VALUES, GenericFile

    live_video_ids = live_job_rows(VIDEO_POSTER_TASK_NAME).annotate(
        video_id_text=KeyTextTransform("generic_file_id", "args"),
    ).values("video_id_text")
    return GenericFile.objects.filter(
        mime_type__in=sorted(VIDEO_MIME_TYPE_VALUES),
    ).annotate(
        pk_text=Cast("pk", TextField()),
    ).filter(
        pk_text__in=live_video_ids,
    ).values("owner_id").annotate(
        live=Count("pk"),
    ).filter(
        live__gte=VIDEO_POSTER_JOBS_PER_OWNER,
    ).values("owner_id")


def _admission_lock(owner_id):
    """Serialise admission per owner, for the life of the transaction.

    Admission is "count, then enqueue", and the count is not atomic with
    the enqueue: two uploads from one owner arriving on two web workers both
    see three live jobs, both admit, and the owner holds five (codex
    adversarial review measured eight against a cap of four). Their
    queueing locks name different videos, so they do not collide there. A
    transaction-scoped advisory lock keyed on the owner makes every
    count+enqueue for that owner a critical section across processes,
    without a row to lock or a migration to add one. Released at commit or
    rollback, so it cannot leak past a failed enqueue.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(%s, %s)",
            [VIDEO_POSTER_ADMISSION_LOCK_CLASS, int(owner_id)],
        )


def _defer_video_poster(
        generic_file_id, *, priority=INTERACTIVE, schedule_at=None):
    """Enqueue one poster job, deduplicated on the video.

    The queueing lock collapses a signal, a top-up and a sweep racing for
    the same video onto one `todo` job. `AlreadyEnqueued` is therefore the
    normal outcome of a race, not an error.
    """
    options = {
        "queueing_lock": f"video-poster-{generic_file_id}",
        # Initial web admission retains its rollout delay. Worker-side
        # replenishment supplies the original upload's eligibility deadline.
        "schedule_at": (
            schedule_at if schedule_at is not None
            else timezone.now() + VIDEO_POSTER_ROLLOUT_DELAY
        ),
    }
    options["priority"] = priority
    try:
        # Procrastinate translates a unique violation without rolling back
        # a Django savepoint. Keep the surrounding admission usable.
        with transaction.atomic():
            generate_video_poster.configure(**options).defer(
                generic_file_id=generic_file_id,
            )
    except AlreadyEnqueued:
        return False
    return True


# Bound synchronous upload admission and each top-up statement. These are
# not whole-sweep deadlines: the pass executes several bounded statements.
# Candidate selection uses the same limits but still needs a history index.
POSTER_ADMISSION_LOCK_TIMEOUT_MS = 1000
POSTER_ADMISSION_STATEMENT_TIMEOUT_MS = 5000


@contextmanager
def _poster_admission_transaction():
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_setting('lock_timeout'), "
                           "current_setting('statement_timeout')")
            previous = cursor.fetchone()
            cursor.execute("SELECT name, setting::int FROM pg_settings "
                           "WHERE name IN ('lock_timeout', 'statement_timeout')")
            existing = dict(cursor.fetchall())
            lock_ms = min(POSTER_ADMISSION_LOCK_TIMEOUT_MS,
                          existing['lock_timeout'] or POSTER_ADMISSION_LOCK_TIMEOUT_MS)
            statement_ms = min(
                POSTER_ADMISSION_STATEMENT_TIMEOUT_MS,
                existing['statement_timeout'] or POSTER_ADMISSION_STATEMENT_TIMEOUT_MS,
            )
            cursor.execute("SELECT set_config('lock_timeout', %s, true), "
                           "set_config('statement_timeout', %s, true)", [
                               f"{lock_ms}ms",
                               f"{statement_ms}ms",
                           ])
        yield
        # Restore on success when nested in a caller transaction. On timeout,
        # atomic rolls the admission savepoint back, including SET LOCAL.
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('lock_timeout', %s, true), "
                           "set_config('statement_timeout', %s, true)", previous)


def _admission_timeout_fallback(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (OperationalError, ConnectorException) as exc:
            cause = exc.__cause__
            code = getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)
            if code not in {"55P03", "57014"}:
                raise
            # The upload already committed before its on_commit callback.
            # Only admission rolls back; the sweep can discover this video.
            logger.warning("%s timed out; poster admission deferred to sweep",
                           function.__name__)
            return 0
    return wrapped


@_admission_timeout_fallback
def enqueue_video_poster(generic_file_id, owner_id):
    """The upload path: one job now if the owner's lane has room, else none.

    Returns whether a job was enqueued. A `False` is not a loss -- the video
    is inside VIDEO_POSTER_SWEEP_WINDOW with no job, which is exactly what
    `top_up_video_posters` and `sweep_video_posters` look for.
    """
    with _poster_admission_transaction():
        _admission_lock(owner_id)
        live = _live_poster_jobs_for_owner(owner_id)
        if live >= VIDEO_POSTER_JOBS_PER_OWNER:
            logger.info(
                "enqueue_video_poster: owner %s already has %s poster jobs "
                "live (cap %s); video %s waits for the top-up",
                owner_id, live, VIDEO_POSTER_JOBS_PER_OWNER, generic_file_id,
            )
            return False
        return _defer_video_poster(generic_file_id)


@_admission_timeout_fallback
def top_up_video_posters(owner_id, *, exclude_generic_file_id=None,
                         budget=None, priority=INTERACTIVE):
    """Fill this owner's lane up to the cap from their waiting videos.

    Called by every finishing poster job (with its own video excluded from
    the live count, since its slot is the one being vacated) and by the
    sweep. Returns how many jobs were enqueued.
    """
    with _poster_admission_transaction():
        _admission_lock(owner_id)
        live = _live_poster_jobs_for_owner(
            owner_id, exclude_generic_file_id=exclude_generic_file_id,
        )
        room = VIDEO_POSTER_JOBS_PER_OWNER - live
        if budget is not None:
            room = min(room, budget)
        if room <= 0:
            return 0
        waiting = _posterless_videos_admissible(
            timezone.now() - VIDEO_POSTER_SWEEP_WINDOW,
            owner_id=owner_id,
        )
        if exclude_generic_file_id is not None:
            waiting = waiting.exclude(pk=exclude_generic_file_id)
        enqueued = 0
        for video_id, created_at in waiting.values_list("pk", "created_at")[:room]:
            # Keep fresh deferred uploads behind their original grace, while
            # mature backlog becomes runnable without a new five-minute pause.
            eligible_at = max(timezone.now(), created_at + VIDEO_POSTER_ROLLOUT_DELAY)
            if _defer_video_poster(
                video_id, priority=priority, schedule_at=eligible_at,
            ):
                enqueued += 1
    if enqueued:
        logger.info(
            "top_up_video_posters: enqueued %s waiting poster job(s) for "
            "owner %s", enqueued, owner_id,
        )
    return enqueued


def _top_up_after_poster_job(generic_file):
    """Best effort, and never the reason a finished job fails."""
    try:
        top_up_video_posters(
            generic_file.owner_id, exclude_generic_file_id=generic_file.pk,
        )
    except Exception:  # noqa: BLE001 - the poster itself is already stored
        logger.exception(
            "generate_video_poster: top-up for owner %s failed; the sweep "
            "will retry it", generic_file.owner_id,
        )


@app.periodic(cron=VIDEO_POSTER_SWEEP_CRON, priority=INTERACTIVE)
@app.task(
    name="uploads.sweep_video_posters", queue="images",
    priority=INTERACTIVE,
)
@_admission_timeout_fallback
def sweep_video_posters(timestamp: int):
    """Backstop for the top-up: re-admit waiting videos, owner by owner.

    Each owner is topped up under their own cap, so the sweep restores
    fairness rather than bypassing it; VIDEO_POSTER_SWEEP_BUDGET bounds the
    whole run. Returns the number of jobs enqueued.

    CANDIDATES ARE OWNERS WITH ROOM, OLDEST WAITING VIDEO FIRST. Selecting
    "any owner with a waiting video" and then asking each for room lets
    owners whose lanes are full occupy every candidate slot while enqueuing
    nothing, run after run. So full lanes are excluded in the query, and the
    candidates are ordered by how long their oldest waiting video has
    waited, so a starved owner is always reached before a newer one. Every
    candidate then has room at selection time; a race with an upload or a
    top-up in the gap is what the per-owner lock resolves, at the cost of
    one budget slot not being spent this run.
    """
    from django.db.models import Min

    since = timezone.now() - VIDEO_POSTER_SWEEP_WINDOW
    candidates = (
        _posterless_videos_admissible(since)
        .order_by()
        .exclude(owner_id__in=_owners_with_full_lanes())
        .values("owner_id")
        .annotate(oldest_waiting=Min("created_at"))
        .order_by("oldest_waiting", "owner_id")
    )
    # Evaluate under the same statement bound, then release this transaction
    # before taking any per-owner admission lock. On timeout the next tick
    # retries selection; no upload or previously queued job is lost.
    with _poster_admission_transaction():
        owner_ids = [
            row["owner_id"] for row in candidates[:VIDEO_POSTER_SWEEP_BUDGET]
        ]
    enqueued = 0
    for owner_id in owner_ids:
        remaining = VIDEO_POSTER_SWEEP_BUDGET - enqueued
        if remaining <= 0:
            break
        enqueued += top_up_video_posters(
            owner_id, budget=remaining, priority=INTERACTIVE,
        )
    if owner_ids:
        logger.info(
            "sweep_video_posters: %s owner(s) waiting, %s job(s) enqueued",
            len(owner_ids), enqueued,
        )
    return enqueued
