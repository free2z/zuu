"""
Image-variant pipeline tests, against real Postgres.

Enqueue assertions use the real procrastinate DjangoConnector: defer()
writes a row to the procrastinate_jobs table through the Django DB
connection, so we assert on ProcrastinateJob rows — no queue mocking.
Task execution is exercised by calling the task function directly
(procrastinate tasks are plain callables).

File storage is redirected to a tmp dir (default storage in settings is
GCS; only that external boundary is swapped, per repo test rules).
"""
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image

from django.core.files.base import ContentFile
from django.db import close_old_connections, transaction
from django.db.models.signals import pre_delete
from django.utils import timezone

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.uploads import tasks as upload_tasks
from dj.apps.jobs.priorities import MAINTENANCE
from dj.apps.uploads.image_utils import create_thumbnail
from dj.apps.uploads.signals import capture_generic_file_blobs
from dj.apps.uploads.models import (
    VARIANT_WIDTHS,
    GenericFile,
    ImageVariant,
    PendingUploadBlobDeletion,
    Webp,
)
from dj.apps.uploads.serializers import FeaturedImageSerializer
from dj.apps.uploads.tasks import (
    delete_pending_blob,
    enqueue_pending_blob_deletions,
    generate_image_variants,
)


@pytest.fixture(autouse=True)
def _local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
    }
    settings.MEDIA_ROOT = str(tmp_path)


def _png_bytes(width=1000, height=600, mode="RGB", color=(10, 120, 200)):
    image = Image.new(mode, (width, height), color)
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def _make_image(creator, width=1000, height=600, access="public",
                mode="RGB", color=(10, 120, 200), name="pic.png"):
    return GenericFile.objects.create(
        owner=creator,
        file=ContentFile(
            _png_bytes(width, height, mode, color), name=name),
        mime_type="image/png",
        access=access,
    )


def _run_pending_blob_cleanups():
    for pending_id in list(
        PendingUploadBlobDeletion.objects.values_list("pk", flat=True)
    ):
        delete_pending_blob(pending_blob_id=pending_id)


@pytest.mark.django_db(transaction=True)
def test_creating_image_enqueues_variant_job(creator_factory):
    creator = creator_factory()
    before = ProcrastinateJob.objects.count()

    gfile = _make_image(creator)

    jobs = ProcrastinateJob.objects.filter(
        task_name="uploads.generate_image_variants",
    ).order_by("-id")
    assert ProcrastinateJob.objects.count() == before + 1
    assert jobs.first().args == {"generic_file_id": gfile.pk}


@pytest.mark.django_db(transaction=True)
def test_non_raster_uploads_do_not_enqueue(creator_factory):
    """
    Nothing that Pillow cannot open enqueues the WebP ladder.

    A video used to enqueue nothing at all; it enqueues
    `uploads.generate_video_poster` instead, which is asserted in
    test_video_posters.py. This test stays scoped to the ladder so the two
    cannot start covering for each other.
    """
    creator = creator_factory()

    gif = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"GIF89a...", name="anim.gif"),
        mime_type="image/gif",
    )
    video = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"fake-mp4", name="clip.mp4"),
        mime_type="video/mp4",
    )

    # Scoped to these two rows, not a global count: `transaction=True` tests
    # do not roll back, so in a full-suite run a bare count sees every job
    # every earlier test enqueued.
    assert not ProcrastinateJob.objects.filter(
        task_name="uploads.generate_image_variants",
        args__generic_file_id__in=[gif.pk, video.pk],
    ).exists()


@pytest.mark.django_db
def test_task_generates_expected_ladder_for_1000px_png(creator_factory):
    gfile = _make_image(creator_factory(), width=1000, height=600)

    generate_image_variants(generic_file_id=gfile.pk)

    widths = sorted(gfile.variants.values_list("width", flat=True))
    # 1600 skipped: never upscale beyond the 1000px original
    assert widths == [64, 128, 400, 800]

    v400 = gfile.variants.get(width=400)
    with v400.file.open("rb") as f:
        img = Image.open(f)
        assert img.format == "WEBP"
        assert img.width == 400
        assert img.height == 240  # aspect preserved


@pytest.mark.django_db
def test_variant_payload_iterator_releases_raster_before_each_payload(
        creator_factory):
    """Only one encoded payload survives the closed Pillow contexts."""
    import inspect

    gfile = _make_image(creator_factory(), width=1000, height=600)
    payloads = upload_tasks._prepared_variant_payloads(gfile)

    width, payload = next(payloads)

    assert width == 64
    assert payload
    locals_at_yield = inspect.getgeneratorlocals(payloads)
    assert "raw_bytes" not in locals_at_yield
    assert "payloads" not in locals_at_yield
    assert "image" not in locals_at_yield
    assert "prepared" not in locals_at_yield

    payloads.close()


@pytest.mark.django_db
def test_variant_worker_rejects_oversized_raster_before_decoding(
        creator_factory, monkeypatch):
    gfile = _make_image(
        creator_factory(), width=4000, height=4000, name="huge.png")
    monkeypatch.setattr(
        "dj.apps.uploads.image_utils.MAX_DECODE_PIXELS", 1_000_000)

    def fail_if_decoded(self):
        raise AssertionError("oversized raster was decoded")

    monkeypatch.setattr(Image.Image, "load", fail_if_decoded)

    generate_image_variants(generic_file_id=gfile.pk)

    assert not ImageVariant.objects.filter(parent_id=gfile.pk).exists()


@pytest.mark.django_db
def test_task_is_idempotent(creator_factory):
    gfile = _make_image(creator_factory())

    generate_image_variants(generic_file_id=gfile.pk)
    generate_image_variants(generic_file_id=gfile.pk)

    assert gfile.variants.count() == 4


@pytest.mark.django_db(transaction=True)
def test_myuploads_delete_removes_original_and_all_derived_blobs(
        client, creator_factory):
    creator = creator_factory()
    client.force_login(creator)
    gfile = _make_image(creator, width=2000, height=1200)
    generate_image_variants(generic_file_id=gfile.pk)
    create_thumbnail(gfile)

    gfile = GenericFile.objects.prefetch_related(
        "variants", "webp",
    ).get(pk=gfile.pk)
    variants = list(gfile.variants.all())
    legacy_webp = gfile.webp
    stored_files = [gfile.file, legacy_webp.file] + [
        variant.file for variant in variants
    ]
    parent_id = gfile.pk

    assert sorted(variant.width for variant in variants) == VARIANT_WIDTHS
    assert all(stored_file.storage.exists(stored_file.name)
               for stored_file in stored_files)

    response = client.delete(f"/api/myuploads/{parent_id}/")

    assert response.status_code == 204, response.content
    assert not GenericFile.objects.filter(pk=parent_id).exists()
    assert not ImageVariant.objects.filter(parent_id=parent_id).exists()
    assert not Webp.objects.filter(parent_id=parent_id).exists()

    # DELETE only commits the database transition.  Blob removal is
    # asynchronous and durable, so a request never holds a sync web worker on
    # seven GCS DELETE calls.
    assert set(
        PendingUploadBlobDeletion.objects.values_list("name", flat=True)
    ) == {stored_file.name for stored_file in stored_files}
    pending_ids = set(
        PendingUploadBlobDeletion.objects.values_list("pk", flat=True)
    )
    cleanup_jobs = ProcrastinateJob.objects.filter(
        task_name="uploads.delete_pending_blob",
        args__pending_blob_id__in=pending_ids,
    )
    assert cleanup_jobs.count() == len(stored_files)
    assert {job.args["pending_blob_id"] for job in cleanup_jobs} == set(
        PendingUploadBlobDeletion.objects.values_list("pk", flat=True)
    )
    assert all(job.priority == MAINTENANCE for job in cleanup_jobs)
    assert all(job.queueing_lock for job in cleanup_jobs)
    assert all(
        job.scheduled_at > timezone.now() + timedelta(minutes=4)
        for job in cleanup_jobs
    )
    assert not PendingUploadBlobDeletion.objects.filter(
        last_enqueued_at__isnull=True,
    ).exists()
    assert all(stored_file.storage.exists(stored_file.name)
               for stored_file in stored_files)

    _run_pending_blob_cleanups()

    assert all(not stored_file.storage.exists(stored_file.name)
               for stored_file in stored_files)
    assert not PendingUploadBlobDeletion.objects.exists()


@pytest.mark.django_db
def test_delete_ignores_stale_prefetched_derived_relations(creator_factory):
    creator = creator_factory()
    original = _make_image(creator, width=2000, height=1200)
    prefetched = GenericFile.objects.prefetch_related(
        "variants", "webp",
    ).get(pk=original.pk)

    # The worker can populate variants after a media-manager queryset has
    # prefetched the empty relations. Leave the optional legacy Webp absent.
    generate_image_variants(generic_file_id=original.pk)
    variant_keys = list(
        ImageVariant.objects.filter(parent_id=original.pk)
        .values_list("file", flat=True)
    )
    stored_keys = [original.file.name, *variant_keys]
    storage = original.file.storage

    assert prefetched.variants.count() == 0
    assert not Webp.objects.filter(parent_id=original.pk).exists()

    prefetched.delete()

    assert not GenericFile.objects.filter(pk=original.pk).exists()
    assert all(storage.exists(key) for key in stored_keys)
    assert set(
        PendingUploadBlobDeletion.objects.values_list("name", flat=True)
    ) == set(stored_keys)

    _run_pending_blob_cleanups()

    assert all(not storage.exists(key) for key in stored_keys)


@pytest.mark.django_db(transaction=True)
def test_delete_signal_records_outbox_without_storage_metadata(
        creator_factory, settings, mocker):
    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage.bucket = mocker.Mock()
    settings.NAMESPACE = "prod"
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )
    mocker.patch.object(upload_tasks, "storages", {"default": storage})
    enqueue = mocker.patch.object(upload_tasks, "enqueue_blob_cleanup")

    gfile = _make_image(creator_factory(), name="signal-only.png")
    name = gfile.file.name

    with transaction.atomic():
        gfile.delete()

        pending = PendingUploadBlobDeletion.objects.get(name=name)
        assert pending.generation is None
        storage.bucket.get_blob.assert_not_called()

    enqueue.assert_called_once_with(pending.pk)


@pytest.mark.django_db
def test_queryset_delete_uses_the_blob_outbox(creator_factory):
    creator = creator_factory()
    gfile = _make_image(creator, width=2000, height=1200)
    generate_image_variants(generic_file_id=gfile.pk)
    create_thumbnail(gfile)

    gfile = GenericFile.objects.get(pk=gfile.pk)
    stored_files = [gfile.file, gfile.webp.file, *[
        variant.file for variant in gfile.variants.all()
    ]]
    parent_id = gfile.pk

    GenericFile.objects.filter(pk=parent_id).delete()

    assert not GenericFile.objects.filter(pk=parent_id).exists()
    assert not ImageVariant.objects.filter(parent_id=parent_id).exists()
    assert not Webp.objects.filter(parent_id=parent_id).exists()
    assert set(
        PendingUploadBlobDeletion.objects.values_list("name", flat=True)
    ) == {stored_file.name for stored_file in stored_files}
    assert all(stored_file.storage.exists(stored_file.name)
               for stored_file in stored_files)

    _run_pending_blob_cleanups()

    assert all(not stored_file.storage.exists(stored_file.name)
               for stored_file in stored_files)


@pytest.mark.django_db
def test_creator_cascade_uses_the_blob_outbox(creator_factory):
    creator = creator_factory()
    gfile = _make_image(creator, width=2000, height=1200)
    generate_image_variants(generic_file_id=gfile.pk)
    create_thumbnail(gfile)

    gfile = GenericFile.objects.get(pk=gfile.pk)
    stored_files = [gfile.file, gfile.webp.file, *[
        variant.file for variant in gfile.variants.all()
    ]]
    parent_id = gfile.pk

    # The owner FK is CASCADE; this path never calls GenericFile.delete().
    creator.delete()

    assert not GenericFile.objects.filter(pk=parent_id).exists()
    assert set(
        PendingUploadBlobDeletion.objects.values_list("name", flat=True)
    ) == {stored_file.name for stored_file in stored_files}
    assert all(stored_file.storage.exists(stored_file.name)
               for stored_file in stored_files)

    _run_pending_blob_cleanups()

    assert all(not stored_file.storage.exists(stored_file.name)
               for stored_file in stored_files)


@pytest.mark.django_db(transaction=True)
def test_variant_worker_and_parent_delete_are_serialized(
        creator_factory, monkeypatch):
    creator = creator_factory()
    gfile = _make_image(creator, width=100, height=60)
    parent_id = gfile.pk
    original_name = gfile.file.name
    storage = gfile.file.storage
    real_save = storage.save
    entered = threading.Event()
    release = threading.Event()

    def save_then_wait(name, content, max_length=None):
        saved_name = real_save(name, content, max_length=max_length)
        if "_w64" in name:
            entered.set()
            if not release.wait(timeout=10):
                raise AssertionError("worker test was not released")
        return saved_name

    monkeypatch.setattr(
        storage._wrapped, "save", save_then_wait,
    )

    def run_generation():
        close_old_connections()
        try:
            generate_image_variants(generic_file_id=parent_id)
        finally:
            close_old_connections()

    def run_delete():
        close_old_connections()
        try:
            GenericFile.objects.get(pk=parent_id).delete()
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        generation = pool.submit(run_generation)
        assert entered.wait(timeout=10)
        deletion = pool.submit(run_delete)
        try:
            # No object-storage operation holds the parent row lock: deletion
            # commits while the variant upload is deliberately stalled.
            deletion.result(timeout=10)
            release.set()
            generation.result(timeout=30)
        finally:
            release.set()

    # The worker observes the deleted parent after its upload and gives the
    # just-written key to the durable cleanup outbox.
    assert not GenericFile.objects.filter(pk=parent_id).exists()
    assert not ImageVariant.objects.filter(parent_id=parent_id).exists()
    pending_names = set(
        PendingUploadBlobDeletion.objects.values_list("name", flat=True)
    )
    generated_names = pending_names - {original_name}
    assert len(generated_names) == 1
    generated_name = generated_names.pop()
    assert storage.exists(generated_name)

    _run_pending_blob_cleanups()

    assert not storage.exists(generated_name)


@pytest.mark.django_db(transaction=True)
def test_variant_winning_lock_after_collector_snapshot_is_deleted(
        creator_factory, monkeypatch):
    gfile = _make_image(creator_factory(), width=100, height=60)
    parent_id = gfile.pk
    storage = gfile.file.storage
    worker_has_lock = threading.Event()
    deletion_reached_signal = threading.Event()
    release_worker = threading.Event()
    original_save = ImageVariant.save

    def save_while_holding_parent_lock(instance, *args, **kwargs):
        if instance.parent_id == parent_id and instance.width == 64:
            worker_has_lock.set()
            if not release_worker.wait(timeout=10):
                raise AssertionError("worker test was not released")
        return original_save(instance, *args, **kwargs)

    monkeypatch.setattr(ImageVariant, "save", save_while_holding_parent_lock)

    dispatch_uid = "uploads.capture_generic_file_blobs"
    pre_delete.disconnect(sender=GenericFile, dispatch_uid=dispatch_uid)

    def capture_after_snapshot(*args, **kwargs):
        deletion_reached_signal.set()
        return capture_generic_file_blobs(*args, **kwargs)

    pre_delete.connect(
        capture_after_snapshot,
        sender=GenericFile,
        dispatch_uid=dispatch_uid,
        weak=False,
    )

    def run_generation():
        close_old_connections()
        try:
            generate_image_variants(generic_file_id=parent_id)
        finally:
            close_old_connections()

    def run_delete():
        close_old_connections()
        try:
            GenericFile.objects.get(pk=parent_id).delete()
        finally:
            close_old_connections()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            generation = pool.submit(run_generation)
            assert worker_has_lock.wait(timeout=10)
            deletion = pool.submit(run_delete)
            assert deletion_reached_signal.wait(timeout=10)
            release_worker.set()
            generation.result(timeout=30)
            deletion.result(timeout=30)
    finally:
        release_worker.set()
        pre_delete.disconnect(sender=GenericFile, dispatch_uid=dispatch_uid)
        pre_delete.connect(
            capture_generic_file_blobs,
            sender=GenericFile,
            dispatch_uid=dispatch_uid,
            weak=False,
        )

    assert not GenericFile.objects.filter(pk=parent_id).exists()
    assert not ImageVariant.objects.filter(parent_id=parent_id).exists()
    pending_names = set(
        PendingUploadBlobDeletion.objects.values_list("name", flat=True)
    )
    generated_names = {name for name in pending_names if "_w64" in name}
    assert len(generated_names) == 1
    generated_name = generated_names.pop()
    assert storage.exists(generated_name)

    _run_pending_blob_cleanups()

    assert not storage.exists(generated_name)


@pytest.mark.django_db(transaction=True)
def test_legacy_thumbnail_upload_racing_delete_is_cleaned(
        creator_factory, monkeypatch):
    gfile = _make_image(creator_factory(), width=100, height=60)
    parent_id = gfile.pk
    original_name = gfile.file.name
    storage = gfile.file.storage
    real_save = storage.save
    entered = threading.Event()
    release = threading.Event()

    def save_then_wait(name, content, max_length=None):
        saved_name = real_save(name, content, max_length=max_length)
        if name.endswith(".webp") and "_w" not in name:
            entered.set()
            if not release.wait(timeout=10):
                raise AssertionError("thumbnail test was not released")
        return saved_name

    monkeypatch.setattr(storage._wrapped, "save", save_then_wait)

    def run_thumbnail():
        close_old_connections()
        try:
            create_thumbnail(gfile)
        finally:
            close_old_connections()

    def run_delete():
        close_old_connections()
        try:
            GenericFile.objects.get(pk=parent_id).delete()
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        thumbnail = pool.submit(run_thumbnail)
        assert entered.wait(timeout=10)
        deletion = pool.submit(run_delete)
        try:
            deletion.result(timeout=10)
            release.set()
            thumbnail.result(timeout=30)
        finally:
            release.set()

    assert not GenericFile.objects.filter(pk=parent_id).exists()
    assert not Webp.objects.filter(parent_id=parent_id).exists()
    pending_names = set(
        PendingUploadBlobDeletion.objects.values_list("name", flat=True)
    )
    thumbnail_names = pending_names - {original_name}
    assert len(thumbnail_names) == 1
    thumbnail_name = thumbnail_names.pop()
    assert storage.exists(thumbnail_name)

    _run_pending_blob_cleanups()

    assert not storage.exists(thumbnail_name)


@pytest.mark.django_db
def test_variant_failure_keeps_already_committed_rungs(
        creator_factory, monkeypatch):
    gfile = _make_image(creator_factory(), width=1000, height=600)
    storage = gfile.file.storage
    real_save = storage.save

    def fail_second_rung(name, content, max_length=None):
        if "_w128" in name:
            raise RuntimeError("storage unavailable")
        return real_save(name, content, max_length=max_length)

    monkeypatch.setattr(storage._wrapped, "save", fail_second_rung)

    with pytest.raises(RuntimeError, match="storage unavailable"):
        generate_image_variants(generic_file_id=gfile.pk)

    assert list(gfile.variants.values_list("width", flat=True)) == [64]
    first = gfile.variants.get(width=64)
    assert storage.exists(first.file.name)
    assert not PendingUploadBlobDeletion.objects.filter(
        name=first.file.name,
    ).exists()


@pytest.mark.django_db
def test_variant_write_then_raise_is_outboxed_without_touching_old_key(
        creator_factory, monkeypatch):
    gfile = _make_image(creator_factory(), width=100, height=60)
    storage = gfile.file.storage
    old_name = f"{gfile.file.name.rsplit('.', 1)[0]}_w64.webp"
    storage.save(old_name, ContentFile(b"protected legacy object"))
    real_save = storage.save
    attempted = {}

    def write_then_raise(name, content, max_length=None):
        saved_name = real_save(name, content, max_length=max_length)
        if "_w64_" in name:
            attempted["name"] = name
            raise RuntimeError("response timed out after the write")
        return saved_name

    monkeypatch.setattr(storage._wrapped, "save", write_then_raise)

    with pytest.raises(RuntimeError, match="after the write"):
        generate_image_variants(generic_file_id=gfile.pk)

    pending = PendingUploadBlobDeletion.objects.get(
        name=attempted["name"],
    )
    assert pending.name != old_name
    assert storage.exists(pending.name)
    assert storage.exists(old_name)

    delete_pending_blob(pending_blob_id=pending.pk)

    assert not storage.exists(pending.name)
    assert storage.exists(old_name)


@pytest.mark.django_db
def test_generated_variant_preserves_storage_returned_name(
        creator_factory, monkeypatch):
    gfile = _make_image(creator_factory(), width=100, height=60)
    storage = gfile.file.storage
    real_save = storage.save
    returned = {}

    def save_under_returned_name(name, content, max_length=None):
        if "_w64_" in name:
            actual_name = name.replace("_w64_", "_stored_w64_", 1)
            real_save(actual_name, content, max_length=max_length)
            returned["name"] = actual_name
            return actual_name
        return real_save(name, content, max_length=max_length)

    monkeypatch.setattr(storage._wrapped, "save", save_under_returned_name)
    generate_image_variants(generic_file_id=gfile.pk)

    variant = gfile.variants.get(width=64)
    assert variant.file.name == returned["name"]
    assert storage.exists(returned["name"])


@pytest.mark.django_db
def test_legacy_thumbnail_write_then_raise_is_outboxed_without_touching_old_key(
        creator_factory, monkeypatch):
    gfile = _make_image(creator_factory(), width=100, height=60)
    storage = gfile.file.storage
    old_name = f"{gfile.file.name.rsplit('.', 1)[0]}.webp"
    storage.save(old_name, ContentFile(b"protected legacy object"))
    real_save = storage.save
    attempted = {}

    def write_then_raise(name, content, max_length=None):
        saved_name = real_save(name, content, max_length=max_length)
        if name.endswith(".webp"):
            attempted["name"] = name
            raise RuntimeError("response timed out after the write")
        return saved_name

    monkeypatch.setattr(storage._wrapped, "save", write_then_raise)
    create_thumbnail(gfile)

    gfile.refresh_from_db()
    assert gfile.skip_thumbnail is True
    pending = PendingUploadBlobDeletion.objects.get(
        name=attempted["name"],
    )
    assert pending.name != old_name
    assert storage.exists(pending.name)
    assert storage.exists(old_name)

    delete_pending_blob(pending_blob_id=pending.pk)

    assert not storage.exists(pending.name)
    assert storage.exists(old_name)


@pytest.mark.django_db(transaction=True)
def test_blob_sweep_rate_limits_retained_rows():
    assert upload_tasks.BLOB_DELETION_REENQUEUE_AFTER == timedelta(minutes=15)
    pending = PendingUploadBlobDeletion.objects.create(
        name="retained.webp",
        last_enqueued_at=timezone.now(),
    )
    before = ProcrastinateJob.objects.filter(
        task_name="uploads.delete_pending_blob",
    ).count()

    assert enqueue_pending_blob_deletions(timestamp=0) == 0
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.delete_pending_blob",
    ).count() == before

    PendingUploadBlobDeletion.objects.filter(pk=pending.pk).update(
        last_enqueued_at=(
            timezone.now() - upload_tasks.BLOB_DELETION_REENQUEUE_AFTER
            + timedelta(seconds=1)
        ),
    )
    assert enqueue_pending_blob_deletions(timestamp=0) == 0
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.delete_pending_blob",
    ).count() == before

    PendingUploadBlobDeletion.objects.filter(pk=pending.pk).update(
        last_enqueued_at=(
            timezone.now() - upload_tasks.BLOB_DELETION_REENQUEUE_AFTER
            - timedelta(seconds=1)
        ),
    )
    assert enqueue_pending_blob_deletions(timestamp=0) == 1
    assert ProcrastinateJob.objects.filter(
        task_name="uploads.delete_pending_blob",
    ).count() == before + 1

    pending.refresh_from_db()
    assert pending.last_enqueued_at > timezone.now() - timedelta(minutes=1)
    assert enqueue_pending_blob_deletions(timestamp=0) == 0


@pytest.mark.django_db
def test_blob_cleanup_keeps_a_shared_storage_key(creator_factory):
    creator = creator_factory()
    original = _make_image(creator, name="shared.png")
    original_name = original.file.name
    storage = original.file.storage

    duplicate = _make_image(creator, name="other.png")
    # Only a pre- row flagged by migration 0014 can share a key now.
    GenericFile.objects.filter(pk=duplicate.pk).update(
        file=original_name, legacy_shared_file=True)

    original.delete()
    pending = PendingUploadBlobDeletion.objects.get(name=original_name)

    delete_pending_blob(pending_blob_id=pending.pk)

    assert GenericFile.objects.filter(pk=duplicate.pk).exists()
    assert storage.exists(original_name)
    assert PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()

    duplicate.delete()
    delete_pending_blob(pending_blob_id=pending.pk)

    assert not storage.exists(original_name)
    assert not PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()


@pytest.mark.django_db
def test_blob_cleanup_retains_outbox_after_storage_failure(
        creator_factory, mocker):
    gfile = _make_image(creator_factory(), name="retry.png")
    name = gfile.file.name
    storage = gfile.file.storage
    gfile.delete()
    pending = PendingUploadBlobDeletion.objects.get(name=name)

    # Resolve DefaultStorage before patching so pytest-mock restores the real
    # backend method rather than trying to delete an attribute on the lazy
    # proxy during teardown.
    assert storage.exists(name)
    storage_delete = mocker.patch.object(
        storage._wrapped, "delete",
        side_effect=RuntimeError("storage unavailable"),
    )
    with pytest.raises(RuntimeError, match="storage unavailable"):
        delete_pending_blob(pending_blob_id=pending.pk)

    assert PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()
    assert storage.exists(name)

    mocker.stop(storage_delete)
    delete_pending_blob(pending_blob_id=pending.pk)

    assert not storage.exists(name)
    assert not PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()


@pytest.mark.parametrize("namespace", ("stage", "test"))
def test_lower_environment_never_deletes_from_shared_gcs(
        settings, mocker, namespace):
    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage.bucket = mocker.Mock()
    storage._normalize_name = mocker.Mock(return_value="uploads/shared.png")
    settings.NAMESPACE = namespace
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )

    upload_tasks._delete_from_storage(storage, "uploads/shared.png")

    storage.bucket.delete_blob.assert_not_called()
    storage._normalize_name.assert_not_called()


def test_production_deletes_from_shared_gcs(settings, mocker):
    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage.bucket = mocker.Mock()
    storage._normalize_name = mocker.Mock(return_value="uploads/shared.png")
    settings.NAMESPACE = "prod"
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )

    upload_tasks._delete_from_storage(
        storage, "uploads/shared.png", generation=123)

    storage._normalize_name.assert_called_once_with("uploads/shared.png")
    storage.bucket.delete_blob.assert_called_once()
    assert storage.bucket.delete_blob.call_args.kwargs[
        "if_generation_match"] == 123


@pytest.mark.django_db(transaction=True)
def test_production_gcs_generation_is_committed_before_delete(
        settings, mocker):
    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage.bucket = mocker.Mock()
    storage._normalize_name = mocker.Mock(return_value="uploads/target.png")
    events = []

    def get_blob(name, **kwargs):
        events.append("capture")
        assert transaction.get_autocommit()
        assert PendingUploadBlobDeletion.objects.get(
            name="uploads/target.png",
        ).generation is None
        return SimpleNamespace(generation=456)

    def delete_blob(name, **kwargs):
        events.append("delete")
        assert transaction.get_autocommit()
        assert PendingUploadBlobDeletion.objects.get(
            name="uploads/target.png",
        ).generation == 456

    storage.bucket.get_blob.side_effect = get_blob
    storage.bucket.delete_blob.side_effect = delete_blob
    settings.NAMESPACE = "prod"
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )
    mocker.patch.object(upload_tasks, "storages", {"default": storage})

    pending = PendingUploadBlobDeletion.objects.create(
        name="uploads/target.png",
    )

    delete_pending_blob(pending_blob_id=pending.pk)

    assert events == ["capture", "delete"]
    assert not PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_production_gcs_timeout_then_replacement_is_safe_on_retry(
        settings, mocker):
    from google.api_core.exceptions import PreconditionFailed

    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage._normalize_name = mocker.Mock(return_value="uploads/reused.png")
    storage.bucket = mocker.Mock()
    current_generation = {"value": 1}
    first_attempt = {"value": True}

    storage.bucket.get_blob.return_value = SimpleNamespace(generation=1)

    def delete_blob(name, **kwargs):
        assert name == "uploads/reused.png"
        assert kwargs["if_generation_match"] == 1
        if first_attempt["value"]:
            first_attempt["value"] = False
            current_generation["value"] = None
            raise TimeoutError("response timed out after GCS deleted it")
        if current_generation["value"] != kwargs["if_generation_match"]:
            raise PreconditionFailed("generation changed")

    storage.bucket.delete_blob.side_effect = delete_blob
    settings.NAMESPACE = "prod"
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )
    mocker.patch.object(upload_tasks, "storages", {"default": storage})

    pending = PendingUploadBlobDeletion.objects.create(
        name="uploads/reused.png",
    )

    with pytest.raises(TimeoutError, match="timed out"):
        delete_pending_blob(pending_blob_id=pending.pk)

    # A new object reuses the key before the worker's retry.
    current_generation["value"] = 2
    delete_pending_blob(pending_blob_id=pending.pk)

    assert not PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()
    assert current_generation["value"] == 2
    assert storage.bucket.delete_blob.call_count == 2
    assert storage.bucket.get_blob.call_count == 1


@pytest.mark.django_db(transaction=True)
def test_production_gcs_missing_target_finalizes_outbox(settings, mocker):
    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage._normalize_name = mocker.Mock(return_value="uploads/gone.png")
    storage.bucket = mocker.Mock()
    storage.bucket.get_blob.return_value = None
    settings.NAMESPACE = "prod"
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )
    mocker.patch.object(upload_tasks, "storages", {"default": storage})

    pending = PendingUploadBlobDeletion.objects.create(
        name="uploads/gone.png",
    )

    delete_pending_blob(pending_blob_id=pending.pk)

    assert not PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()
    storage.bucket.delete_blob.assert_not_called()


@pytest.mark.django_db(transaction=True)
def test_production_gcs_already_gone_is_a_safe_terminal_retry(
        settings, mocker):
    from google.api_core.exceptions import NotFound

    class FakeGoogleCloudStorage:
        pass

    storage = FakeGoogleCloudStorage()
    storage._normalize_name = mocker.Mock(return_value="uploads/gone.png")
    storage.bucket = mocker.Mock()
    storage.bucket.delete_blob.side_effect = NotFound("already gone")
    settings.NAMESPACE = "prod"
    mocker.patch(
        "storages.backends.gcloud.GoogleCloudStorage",
        FakeGoogleCloudStorage,
    )
    mocker.patch.object(upload_tasks, "storages", {"default": storage})

    pending = PendingUploadBlobDeletion.objects.create(
        name="uploads/gone.png",
        generation=789,
    )

    delete_pending_blob(pending_blob_id=pending.pk)

    assert not PendingUploadBlobDeletion.objects.filter(pk=pending.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_database_rollback_keeps_upload_blob_and_outbox_absent(creator_factory):
    gfile = _make_image(creator_factory(), name="rollback.png")
    parent_id = gfile.pk
    name = gfile.file.name
    storage = gfile.file.storage

    with pytest.raises(RuntimeError, match="roll back"):
        with transaction.atomic():
            gfile.delete()
            raise RuntimeError("roll back")

    # Model.delete() clears the in-memory pk even when the surrounding SQL
    # transaction rolls back, so assert against the captured database key.
    assert GenericFile.objects.filter(pk=parent_id).exists()
    assert not PendingUploadBlobDeletion.objects.filter(name=name).exists()
    assert storage.exists(name)


@pytest.mark.django_db
def test_rgba_alpha_preserved(creator_factory):
    gfile = _make_image(
        creator_factory(), width=500, height=500,
        mode="RGBA", color=(10, 120, 200, 128), name="alpha.png")

    generate_image_variants(generic_file_id=gfile.pk)

    variant = gfile.variants.get(width=128)
    with variant.file.open("rb") as f:
        img = Image.open(f)
        img.load()
        assert img.mode == "RGBA"
        assert img.getpixel((5, 5))[3] < 255


@pytest.mark.django_db
def test_task_skips_missing_and_non_raster(creator_factory):
    creator = creator_factory()
    gif = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"GIF89a...", name="anim.gif"),
        mime_type="image/gif",
    )
    corrupt = GenericFile.objects.create(
        owner=creator,
        file=ContentFile(b"not-an-image", name="broken.png"),
        mime_type="image/png",
    )

    # None of these raise
    generate_image_variants(generic_file_id=gif.pk)
    generate_image_variants(generic_file_id=corrupt.pk)
    generate_image_variants(generic_file_id=987654321)

    assert ImageVariant.objects.count() == 0


@pytest.mark.django_db
def test_variant_url_selection_and_fallbacks(creator_factory):
    gfile = _make_image(creator_factory(), width=1000, height=600)
    generate_image_variants(generic_file_id=gfile.pk)
    gfile = GenericFile.objects.get(pk=gfile.pk)

    v128 = gfile.variants.get(width=128)
    v800 = gfile.variants.get(width=800)
    assert gfile.variant_url(128) == v128.get_url()
    assert gfile.variant_url(129) == gfile.variants.get(width=400).get_url()
    # Nothing >= 1600 exists: largest available wins
    assert gfile.variant_url(1600) == v800.get_url()


@pytest.mark.django_db
def test_variant_url_never_falls_back_to_original(creator_factory):
    gfile = _make_image(creator_factory())

    # No variants, no legacy webp: None — NOT the original
    assert gfile.variant_url(128) is None
    # get_thumbnail keeps its legacy original-fallback (for now)
    assert gfile.get_thumbnail() == gfile.get_url()

    # Legacy webp present: used as fallback for public parents
    webp = Webp(parent=gfile)
    webp.file.save("pic.webp", ContentFile(b"x"), save=True)
    gfile = GenericFile.objects.get(pk=gfile.pk)
    assert gfile.variant_url(128) == webp.get_url()

    #...but never for private parents: legacy Webp URLs are always
    # public, so that fallback would leak a private image's thumbnail
    gfile.access = "private"
    gfile.save()
    gfile = GenericFile.objects.get(pk=gfile.pk)
    assert gfile.variant_url(128) is None


@pytest.mark.django_db
def test_private_parent_gets_private_variant_urls(creator_factory):
    gfile = _make_image(
        creator_factory(), width=500, height=500, access="private")

    generate_image_variants(generic_file_id=gfile.pk)

    url = gfile.variant_url(128)
    assert url.startswith("/uploadz/")
    assert not url.startswith("/uploadz/public/")
    # public parent for contrast
    public = _make_image(
        creator_factory(), width=500, height=500, access="public")
    generate_image_variants(generic_file_id=public.pk)
    assert public.variant_url(128).startswith("/uploadz/public/")


@pytest.mark.django_db
def test_serializer_exposes_ladder_fields(creator_factory):
    gfile = _make_image(creator_factory(), width=1000, height=600)
    generate_image_variants(generic_file_id=gfile.pk)
    gfile = GenericFile.objects.get(pk=gfile.pk)

    data = FeaturedImageSerializer(gfile).data
    assert data["thumb"] == gfile.variants.get(width=128).get_url()
    assert data["card"] == gfile.variants.get(width=400).get_url()
    # banner falls back to the largest rung on a 1000px original
    assert data["banner"] == gfile.variants.get(width=800).get_url()
    assert [v["width"] for v in data["variants"]] == [64, 128, 400, 800]
    assert all(v["url"] for v in data["variants"])
    # legacy field untouched
    assert data["thumbnail"] == gfile.get_thumbnail()
