import datetime
import hashlib
import io
import json
import stat
import tempfile
import time
import zipfile
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from django.core.files.base import ContentFile
from django.db import IntegrityError
from django.test import Client, override_settings
from django.utils import timezone
from rest_framework.test import APIClient
from storages.backends.gcloud import GoogleCloudStorage

from dj.apps.exports.exporter import (
    CHUNK_SIZE,
    GCS_DOWNLOAD_CHUNK_SIZE,
    MAX_REFERENCED_UPLOAD_KEYS,
    MAX_UNBUNDLED_REFERENCES,
    BoundedZipStreamWriter,
    ExportSizeLimitExceeded,
    HostilePathError,
    PublicationExporter,
    cleanup_expired_jobs,
    normalize_upload_candidate,
    process_export_job,
    sanitize_archive_path,
)
from dj.apps.exports.models import ExportStatus, PublicationExportJob
from dj.apps.exports.storage import get_export_storage
from dj.apps.jobs.priorities import RECOVERY
from dj.apps.g12f.localization import get_owner_visible_variants
from dj.apps.g12f.models import Creator, PageOrder, Poll, Series, ZPageTranslation, ZPageVariant, zPage
from dj.apps.uploads.models import GenericFile


@pytest.fixture
def tmp_storage_dir():
    with tempfile.TemporaryDirectory(prefix="test_export_storage_") as d:
        yield Path(d)


@pytest.fixture(autouse=True)
def isolated_storage_settings(tmp_storage_dir, settings):
    """Override both default and exports storages to isolated temp storage."""
    default_dir = tmp_storage_dir / "default"
    exports_dir = tmp_storage_dir / "exports"
    default_dir.mkdir(parents=True, exist_ok=True)
    exports_dir.mkdir(parents=True, exist_ok=True)

    settings.STORAGES = {
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
            "OPTIONS": {"location": str(default_dir)},
        },
        "exports": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
            "OPTIONS": {"location": str(exports_dir)},
        },
        "staticfiles": {
            "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
        },
        "dbbackup": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
            "OPTIONS": {"location": "./"},
        },
    }


@pytest.fixture
def creator(db):
    user = Creator.objects.create_user(
        username="alice",
        email="alice@example.com",
        password="secretpassword123",
        full_name="Alice Wonderland",
        description="Public bio of Alice",
        p2paddr="zs1z7rejlpsa98hg2u9ng07egqq008um3rqsq208javezqlzpc50un637whap0v2f5n7svacg3qxxz",
    )
    return user


@pytest.fixture
def other_creator(db):
    user = Creator.objects.create_user(
        username="bob",
        email="bob@example.com",
        password="secretpassword456",
        full_name="Bob Builder",
    )
    return user


@pytest.fixture
def api_client(creator):
    client = APIClient()
    client.force_authenticate(user=creator)
    return client


@pytest.fixture
def other_client(other_creator):
    client = APIClient()
    client.force_authenticate(user=other_creator)
    return client


@pytest.fixture
def anon_client():
    return APIClient()


def test_url_normalization_and_external_host_rejection():
    """normalize_upload_candidate only recognizes allowed Free2Z hosts and valid paths."""
    # Free2Z relative paths
    assert normalize_upload_candidate("/uploadz/public/123/img.png") == "123/img.png"
    assert normalize_upload_candidate("/uploadz/123/img.png") == "123/img.png"
    assert normalize_upload_candidate("/uploads/public/123/img.png") == "123/img.png"
    assert normalize_upload_candidate("uploadz/public/123/img.png") == "123/img.png"

    # Allowed hosts with query / fragment
    assert normalize_upload_candidate("https://free2z.cash/uploadz/public/123/img.png?w=500#thumb") == "123/img.png"
    assert normalize_upload_candidate("https://www.free2z.cash/uploadz/123/img.png") == "123/img.png"
    assert normalize_upload_candidate("https://storage.googleapis.com/free2z-uploads/123/img.png") == "123/img.png"
    assert normalize_upload_candidate("https://storage.googleapis.com/free2z-uploads/public/123/img.png") == "123/img.png"

    # External hostile hosts with /uploadz/ paths -> MUST be rejected (None)
    assert normalize_upload_candidate("https://evil.example.com/uploadz/public/123/img.png") is None
    assert normalize_upload_candidate("https://attacker.org/uploads/123/img.png") is None

    # Traversal and control characters -> MUST be rejected (None)
    assert normalize_upload_candidate("/uploadz/public/../secret.png") is None
    assert normalize_upload_candidate("/uploadz/public/\x00secret.png") is None


def test_sanitize_archive_path_security():
    """sanitize_archive_path strictly rejects traversal, absolute paths, and control characters."""
    assert sanitize_archive_path("articles/123/index.md") == "articles/123/index.md"
    assert sanitize_archive_path("assets/abc.png") == "assets/abc.png"

    with pytest.raises(HostilePathError):
        sanitize_archive_path("/etc/passwd")

    with pytest.raises(HostilePathError):
        sanitize_archive_path("../articles/123.md")

    with pytest.raises(HostilePathError):
        sanitize_archive_path("articles/../../root")

    with pytest.raises(HostilePathError):
        sanitize_archive_path("articles/\x00malicious.md")


def test_bounded_zip_stream_writer_regular_file_metadata_and_duplicates():
    """BoundedZipStreamWriter sets regular non-symlink metadata and rejects duplicate entries."""
    buffer = io.BytesIO()
    zip_path = Path("/tmp/fake_test.zip")
    with zipfile.ZipFile(buffer, "w") as zf:
        writer = BoundedZipStreamWriter(zf, zip_path, max_bytes=10000, max_duration=100, start_time=time.monotonic())
        writer.writestr("test.txt", "hello regular file")

        # Duplicate entry rejected
        with pytest.raises(ValueError):
            writer.writestr("test.txt", "duplicate entry")

    buffer.seek(0)
    with zipfile.ZipFile(buffer, "r") as zf:
        zinfo = zf.getinfo("test.txt")
        assert zinfo.create_system == 3  # Unix
        # Check regular file (not symlink)
        mode = zinfo.external_attr >> 16
        assert stat.S_ISREG(mode)
        assert not stat.S_ISLNK(mode)


def test_write_stream_uses_force_zip64_and_chunks():
    """write_stream passes force_zip64=True to ZipFile.open and reads in chunks."""
    buffer = io.BytesIO()
    zip_path = Path("/tmp/fake_test.zip")
    with zipfile.ZipFile(buffer, "w") as zf:
        writer = BoundedZipStreamWriter(zf, zip_path, max_bytes=1000000, max_duration=100, start_time=time.monotonic())

        stream_mock = MagicMock()
        # Return 2 chunks then EOF
        chunk1 = b"A" * CHUNK_SIZE
        chunk2 = b"B" * 100
        stream_mock.read.side_effect = [chunk1, chunk2, b""]

        with patch.object(zf, "open", wraps=zf.open) as mock_open:
            writer.write_stream("chunked.bin", stream_mock)
            # Verify ZipFile.open called with force_zip64=True
            assert mock_open.called
            _, kwargs = mock_open.call_args
            assert kwargs.get("force_zip64") is True

        assert stream_mock.read.call_count == 3
        expected_digest = hashlib.sha256(chunk1 + chunk2).hexdigest()
        assert writer.entry_checksums["chunked.bin"] == expected_digest


def test_qrcode_directive_does_not_create_unbundled_reference():
    """Non-URL directive payloads (e.g.::qrcode[plain text]) do not create unbundled references."""
    job_mock = MagicMock(spec=PublicationExportJob)
    job_mock.creator_id = 1
    exporter = PublicationExporter(job_mock)

    raw = "Here is a QR code:\n\n::qrcode[zs1testplainaddress]"
    portable = exporter._rewrite_markdown_to_portable(raw, "art123", "en", is_source=True)

    assert "**QR Code:** `zs1testplainaddress`" in portable
    assert len(exporter.unbundled_references) == 0


def test_portable_rewrite_only_transforms_rendered_directives():
    """Prose and fenced examples are not mistaken for live block directives."""
    job_mock = MagicMock(spec=PublicationExportJob)
    job_mock.creator_id = 1
    exporter = PublicationExporter(job_mock)
    raw = (
        "std::vector stays ordinary prose\n"
        "```md\n"
        "::embed[https://example.com/in-code.mp4]\n"
        "![code](/uploadz/alice/in-code.png)\n"
        "```\n"
        "> ::embed[https://example.com/live.mp4]\n"
    )

    portable = exporter._rewrite_markdown_to_portable(
        raw,
        "article-1",
        "en",
        is_source=True,
    )

    assert "std::vector stays ordinary prose" in portable
    assert "::embed[https://example.com/in-code.mp4]" in portable
    assert "![code](/uploadz/alice/in-code.png)" in portable
    assert "> <video controls src=\"https://example.com/live.mp4\"></video>" in portable
    assert exporter.warnings == []


def test_portable_rewrite_preserves_leading_frontmatter():
    """Renderer-hidden frontmatter is preserved byte-for-byte."""
    exporter = PublicationExporter(MagicMock(creator_id=1))
    raw = (
        '---\npreview: "![image](/uploadz/alice/frontmatter.png)"\n---\n'
        "![live](/uploadz/alice/live.png)"
    )
    exporter.upload_to_asset = {
        "alice/frontmatter.png": "assets/frontmatter.png",
        "alice/live.png": "assets/live.png",
    }

    portable = exporter._rewrite_markdown_to_portable(raw, "article-1", "en", is_source=True)

    assert 'preview: "![image](/uploadz/alice/frontmatter.png)"' in portable
    assert "![live](../../assets/live.png)" in portable


def test_reference_metadata_cardinality_is_bounded():
    exporter = PublicationExporter(MagicMock(creator_id=1))
    snapshot_meta = {"referenced_upload_keys": set()}
    for i in range(MAX_REFERENCED_UPLOAD_KEYS + 2):
        exporter._record_referenced_upload(snapshot_meta, f"alice/{i}.png")
    for i in range(MAX_UNBUNDLED_REFERENCES + 2):
        exporter._record_unbundled(f"https://example.com/{i}", "external", "a", "en")

    assert len(snapshot_meta["referenced_upload_keys"]) == MAX_REFERENCED_UPLOAD_KEYS
    assert len(exporter.unbundled_references) == MAX_UNBUNDLED_REFERENCES
    assert any("safety limit" in warning for warning in exporter.warnings)


def test_gcs_asset_stream_uses_bounded_blob_reader():
    exporter = PublicationExporter(MagicMock(creator_id=1))
    storage = MagicMock(spec=GoogleCloudStorage)
    field_file = MagicMock()
    field_file.storage = storage
    field_file.name = "alice/video.mp4"
    stream = MagicMock()
    storage.bucket.blob.return_value.open.return_value = stream

    assert exporter._open_asset_stream(field_file) is stream
    storage.bucket.blob.assert_called_once_with(
        "alice/video.mp4", chunk_size=GCS_DOWNLOAD_CHUNK_SIZE
    )
    storage.bucket.blob.return_value.open.assert_called_once()
    field_file.open.assert_not_called()


def test_asset_dedup_different_extensions_and_accounting():
    """Same asset bytes under different extensions deduplicate strictly by SHA and decrement temp accounting."""
    job_mock = MagicMock(spec=PublicationExportJob)
    job_mock.creator_id = 1
    exporter = PublicationExporter(job_mock)

    with tempfile.TemporaryDirectory() as temp_dir:
        spool_path = Path(temp_dir)
        raw_bytes = b"identical-image-content-bytes"
        sha256 = hashlib.sha256(raw_bytes).hexdigest()

        # Create two GenericFile mocks with same bytes but different filenames (.png and.jpg)
        gf1 = MagicMock()
        gf1.id = 101
        gf1.file.name = "uploads/alice/photo.png"
        gf1.file.storage.exists.return_value = True
        gf1.file.open.side_effect = lambda mode: io.BytesIO(raw_bytes)
        gf1.mime_type = "image/png"
        gf1.access = "public"
        gf1.get_url.return_value = "/uploadz/uploads/alice/photo.png"

        gf2 = MagicMock()
        gf2.id = 102
        gf2.file.name = "uploads/alice/photo.jpg"
        gf2.file.storage.exists.return_value = True
        gf2.file.open.side_effect = lambda mode: io.BytesIO(raw_bytes)
        gf2.mime_type = "image/jpeg"
        gf2.access = "public"
        gf2.get_url.return_value = "/uploadz/uploads/alice/photo.jpg"

        snapshot_meta = {
            "owned_generic_files": [gf1, gf2],
        }

        exporter._resolve_creator_assets(snapshot_meta, spool_path)

        # Assert exactly one asset in registry
        assert len(exporter.asset_registry) == 1
        assert sha256 in exporter.asset_registry
        entry = exporter.asset_registry[sha256]

        # Both upload records retained
        assert len(entry["uploads"]) == 2
        assert {u["id"] for u in entry["uploads"]} == {101, 102}

        # Temp spool bytes accounted only once
        assert exporter.spooled_bytes == len(raw_bytes)

        # Both GenericFile IDs and URLs map to the single existing path
        assert exporter.genericfile_to_asset[101] == entry["path"]
        assert exporter.genericfile_to_asset[102] == entry["path"]
        assert exporter.upload_to_asset[gf1.file.name] == entry["path"]
        assert exporter.upload_to_asset[gf2.file.name] == entry["path"]


def test_missing_generic_file_blob_generic_warning_and_no_leak():
    """Missing GenericFile blob yields generic warning, complete=false, and no leaked internal paths."""
    job_mock = MagicMock(spec=PublicationExportJob)
    job_mock.creator_id = 1
    job_mock.id = "job-uuid"
    exporter = PublicationExporter(job_mock)

    with tempfile.TemporaryDirectory() as temp_dir:
        spool_path = Path(temp_dir)

        gf_missing = MagicMock()
        gf_missing.id = 999
        gf_missing.file.name = "private/secret_path/internal_blob_key.png"
        gf_missing.file.storage.exists.return_value = False
        gf_missing.mime_type = "image/png"
        gf_missing.access = "public"
        gf_missing.get_url.return_value = "/uploadz/private/secret_path/internal_blob_key.png"

        snapshot_meta = {
            "owned_generic_files": [gf_missing],
        }

        exporter._resolve_creator_assets(snapshot_meta, spool_path)

        assert exporter.complete is False
        assert len(exporter.warnings) == 1
        warn = exporter.warnings[0]
        assert warn == "A referenced media asset could not be read from storage."
        # No leak of internal storage path or filename
        assert "internal_blob_key" not in warn
        assert "secret_path" not in warn
        assert len(exporter.asset_registry) == 0
        assert len(exporter.unbundled_references) == 1
        assert exporter.unbundled_references[0]["reason"] == "missing_blob"


def test_export_bounds_and_rollout_delay_settings(settings):
    """Export archive default is 1 GiB, rollout delay is 300s, max duration is 30m, max active jobs is 4."""
    from procrastinate.contrib.django import app
    from dj.apps.exports.exporter import DEFAULT_MAX_ARCHIVE_BYTES, DEFAULT_MAX_DURATION_SECONDS
    from dj.apps.exports.views import EXPORT_ADMISSION_LOCK_KEY, _take_export_admission_lock

    assert DEFAULT_MAX_ARCHIVE_BYTES == 1 * 1024 * 1024 * 1024  # 1 GiB
    assert DEFAULT_MAX_DURATION_SECONDS == 30 * 60  # 30 minutes
    assert getattr(settings, "EXPORT_MAX_ARCHIVE_BYTES", 0) == 1 * 1024 * 1024 * 1024
    assert getattr(settings, "EXPORT_TASK_ROLLOUT_DELAY_SECONDS", 0) == 300
    assert getattr(settings, "EXPORT_MAX_DURATION_SECONDS", 0) == 1800
    assert getattr(settings, "EXPORT_MAX_ACTIVE_JOBS", 0) == 4
    assert getattr(settings, "JOB_HEALTH_EXPORTS_OVERDUE_SECONDS", 0) == 7200

    # Cleanup stays below interactive work on its shared queue.
    cleanup_task = app.tasks["exports.cleanup_expired_exports"]
    assert cleanup_task.queue == "default"
    assert cleanup_task.priority == RECOVERY

    # Export generation task is on exports queue
    export_task = app.tasks["exports.export_publication"]
    assert export_task.queue == "exports"

    # PostgreSQL advisory lock key is stable documented 32-bit signed int
    import zlib
    assert (zlib.crc32(b"publication_export_admission") & 0x7FFFFFFF) == 1517035
    assert EXPORT_ADMISSION_LOCK_KEY == 1517035

    # Non-postgres backends skip advisory lock cleanly
    with patch("dj.apps.exports.views.connection") as mock_conn:
        mock_conn.vendor = "sqlite"
        _take_export_admission_lock()
        mock_conn.cursor.assert_not_called()

        mock_conn.vendor = "postgresql"
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        _take_export_admission_lock()
        mock_cursor.execute.assert_called_once_with(
            "SELECT pg_advisory_xact_lock(%s)", [EXPORT_ADMISSION_LOCK_KEY]
        )




def test_download_view_x_accel_redirect_offload(settings):
    """Download view offloads multi-GB delivery to nginx + gcsproxy via URL-quoted X-Accel-Redirect and safe Content-Disposition."""
    from dj.apps.exports.views import PublicationExportDownloadView

    view = PublicationExportDownloadView()
    request = MagicMock()
    request.user.id = 42

    job_mock = MagicMock()
    job_mock.id = "job-abc-123"
    job_mock.creator = request.user
    job_mock.status = ExportStatus.READY
    job_mock.is_expired = False
    job_mock.file_path = "publications/42/job-abc-123/free2z space & test.zip"
    job_mock.file_name = "free2z space & test.zip"
    job_mock.file_size = 500 * 1024 * 1024  # 500 MB

    with patch("dj.apps.exports.views.PublicationExportJob.objects.get", return_value=job_mock):
        settings.USE_X_ACCEL_REDIRECT = True
        response = view.get(request, id=job_mock.id)

        assert response.status_code == 200
        # URL-quoted internal path
        assert response["X-Accel-Redirect"] == "/_internal_exports/publications/42/job-abc-123/free2z%20space%20%26%20test.zip"
        assert response["Content-Disposition"] == 'attachment; filename="free2z space & test.zip"'
        assert response["Cache-Control"] == "private, no-store"
        assert response["Content-Length"] == str(job_mock.file_size)

        # Empty file_path returns 410 GONE
        job_mock.file_path = ""
        response_empty = view.get(request, id=job_mock.id)
        assert response_empty.status_code == 410


@pytest.mark.django_db
def test_export_job_access_is_scoped_to_the_owning_creator(api_client, other_client, anon_client, creator):
    """Status and download are readable only by the owning creator: a second creator gets
    404 (not 403, not the row), and an anonymous download never reaches the view."""
    stored_path = get_export_storage().save("publications/alice/owned/export.zip", ContentFile(b"PK\x05\x06alice"))
    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.READY,
        file_path=stored_path,
        file_name="alice-export.zip",
        file_size=11,
        expires_at=timezone.now() + datetime.timedelta(days=1),
    )
    detail_url = f'/api/exports/publications/{job.id}/'
    download_url = f'/api/exports/publications/{job.id}/download/'

    # Positive control: the owner really can reach both, so the 404s below are
    # about ownership and not about a missing row or an unusable fixture.
    assert api_client.get(detail_url).status_code == 200
    assert api_client.get(download_url).status_code == 200

    assert other_client.get(detail_url).status_code == 404
    assert other_client.get(download_url).status_code == 404
    assert anon_client.get(download_url).status_code in (401, 403)


@pytest.mark.django_db
def test_ready_export_past_expiry_is_gone_on_download(api_client, creator):
    """A READY row whose expires_at has passed is 410, even though the archive is still in storage."""
    stored_path = get_export_storage().save("publications/alice/stale/export.zip", ContentFile(b"PK\x05\x06stale"))
    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.READY,
        file_path=stored_path,
        file_name="alice-export.zip",
        file_size=11,
        expires_at=timezone.now() - datetime.timedelta(seconds=1),
    )
    assert api_client.get(f'/api/exports/publications/{job.id}/download/').status_code == 410


def test_post_export_task_rollout_delay_scheduling(settings):
    """POST /api/exports/publications/ schedules background task with configured rollout delay."""
    from dj.apps.exports.views import PublicationExportListCreateView

    view = PublicationExportListCreateView()
    request = MagicMock()
    request.user.id = 42
    request.user.username = "alice"

    # Mock no existing jobs
    with patch("dj.apps.exports.views.PublicationExportJob.objects.filter") as mock_filter, \
         patch("dj.apps.exports.views.PublicationExportJob.objects.create") as mock_create, \
         patch("dj.apps.exports.views.export_publication_task") as mock_task, \
         patch("dj.apps.exports.views._take_export_admission_lock"), \
         patch("dj.apps.exports.views.transaction.atomic"):

        mock_qs = MagicMock()
        mock_qs.order_by.return_value.first.return_value = None
        mock_qs.count.return_value = 0
        mock_filter.return_value = mock_qs

        mock_job = MagicMock()
        mock_job.id = "job-new-123"
        mock_create.return_value = mock_job

        # 1. With default 300s rollout delay
        settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 300
        before = timezone.now()
        res = view.post(request)
        after = timezone.now()

        assert res.status_code == 201
        assert mock_task.configure.called
        call_kwargs = mock_task.configure.call_args.kwargs
        assert "schedule_at" in call_kwargs
        scheduled = call_kwargs["schedule_at"]
        assert scheduled >= before + datetime.timedelta(seconds=299)
        assert scheduled <= after + datetime.timedelta(seconds=301)
        mock_task.configure.return_value.defer.assert_called_once_with(job_id=str(mock_job.id))

        # 2. With 0s rollout delay (immediate defer)
        mock_task.reset_mock()
        settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 0
        res0 = view.post(request)

        assert res0.status_code == 201
        assert not mock_task.configure.called
        mock_task.defer.assert_called_once_with(job_id=str(mock_job.id))

        # 3. Exception during atomic create + defer returns 500 without leaving an orphan
        mock_task.reset_mock()
        mock_task.configure.return_value.defer.side_effect = RuntimeError("Broker down")
        settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 300
        res_err = view.post(request)
        assert res_err.status_code == 500
        assert "Failed to enqueue" in res_err.data["detail"]


@pytest.mark.django_db
def test_session_csrf_enforcement_and_anonymous_access(creator):
    """Session authenticated POST enforces CSRF; anonymous access is rejected."""
    csrf_client = Client(enforce_csrf_checks=True)

    # 1. Anonymous POST rejected
    res_anon = csrf_client.post('/api/exports/publications/')
    assert res_anon.status_code in (401, 403)

    # 2. Session logged-in POST without CSRF token is rejected with 403
    csrf_client.login(username="alice", password="secretpassword123")
    res_no_csrf = csrf_client.post('/api/exports/publications/')
    assert res_no_csrf.status_code == 403


@pytest.mark.django_db
def test_on_commit_defer_failure_returns_failed_job_and_leaves_no_orphan(api_client, creator):
    """If task deferral fails inside transaction, the transaction rolls back leaving no orphan job row."""
    with patch("dj.apps.exports.views.export_publication_task.configure", side_effect=RuntimeError("Procrastinate broker unreachable")):
        res = api_client.post('/api/exports/publications/')
        assert res.status_code == 500
        assert "Failed to enqueue" in res.json()['detail']
        # Assert atomic rollback left no orphan job row
        assert PublicationExportJob.objects.filter(creator=creator).count() == 0


@pytest.mark.django_db
def test_successful_creation_atomic_job_and_defer(api_client, creator):
    """POST /api/exports/publications/ atomically creates job and defers task."""
    with patch("dj.apps.exports.views.export_publication_task.configure") as mock_configure:
        mock_configure.return_value.defer.return_value = None
        res = api_client.post('/api/exports/publications/')
        assert res.status_code == 201
        assert res.json()['status'] == 'queued'
        job_id = res.json()['id']
        assert PublicationExportJob.objects.filter(id=job_id, creator=creator).exists()
        mock_configure.return_value.defer.assert_called_once_with(job_id=str(job_id))


@pytest.mark.django_db
def test_export_job_reuse_and_rate_limiting(api_client, creator):
    """POST /api/exports/publications/ reuses active in-flight jobs, creates fresh on ready, and enforces rate limit."""
    res1 = api_client.post('/api/exports/publications/')
    assert res1.status_code == 201
    job_id = res1.json()['id']
    assert res1.json()['status'] == 'queued'
    assert res1.json()['complete'] is False

    # Second POST reuses active queued job
    res2 = api_client.post('/api/exports/publications/')
    assert res2.status_code == 200
    assert res2.json()['id'] == job_id

    # Simulate ready
    job = PublicationExportJob.objects.get(id=job_id)
    job.status = ExportStatus.READY
    job.complete = True
    job.file_path = "publications/test.zip"
    job.expires_at = timezone.now() + datetime.timedelta(hours=24)
    job.save()

    # Third POST after ready does NOT reuse the stale completed job; creates fresh job
    res3 = api_client.post('/api/exports/publications/')
    assert res3.status_code == 201
    assert res3.json()['id'] != job_id
    assert res3.json()['status'] == 'queued'

    # Rate limiting
    PublicationExportJob.objects.filter(creator=creator).update(status=ExportStatus.EXPIRED)
    for _ in range(15):
        PublicationExportJob.objects.create(
            creator=creator,
            status=ExportStatus.EXPIRED,
            created_at=timezone.now(),
        )

    res_limit = api_client.post('/api/exports/publications/')
    assert res_limit.status_code == 429
    assert "Retry-After" in res_limit.headers


@pytest.mark.django_db
def test_global_active_jobs_capacity_limit(api_client, creator, settings):
    """POST /api/exports/publications/ returns 503 with Retry-After: 900 when global queue is at capacity."""
    settings.EXPORT_MAX_ACTIVE_JOBS = 4

    # Create 4 active jobs for other users
    for i in range(4):
        other_user = Creator.objects.create_user(
            username=f"other_{i}",
            email=f"other_{i}@example.com",
            password="pwd",
        )
        PublicationExportJob.objects.create(
            creator=other_user,
            status=ExportStatus.QUEUED if i % 2 == 0 else ExportStatus.RUNNING,
        )

    # Creator's request is rejected at capacity without creating or enqueuing
    res = api_client.post('/api/exports/publications/')
    assert res.status_code == 503
    assert res.json()['detail'] == "Publication export queue is currently at capacity. Please try again later."
    assert res.headers.get("Retry-After") == "900"
    assert not PublicationExportJob.objects.filter(creator=creator).exists()


@pytest.mark.django_db
def test_concurrent_same_user_active_job_reuses_before_capacity(api_client, creator, settings):
    """If creator already has an active in-flight job, POST returns 200 even if global capacity is full."""
    settings.EXPORT_MAX_ACTIVE_JOBS = 4

    # Creator already has an active queued job
    my_job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.QUEUED,
    )

    # Plus 3 other active jobs = 4 total
    for i in range(3):
        other_user = Creator.objects.create_user(
            username=f"other_user_{i}",
            email=f"other_user_{i}@example.com",
            password="pwd",
        )
        PublicationExportJob.objects.create(
            creator=other_user,
            status=ExportStatus.RUNNING,
        )

    # Same creator calling POST reuses their active job with 200 OK (not 503)
    res = api_client.post('/api/exports/publications/')
    assert res.status_code == 200
    assert res.json()['id'] == str(my_job.id)


@pytest.mark.django_db
def test_unique_active_job_constraint(creator):
    """DB constraint unique_active_publication_export_job prevents two active jobs."""
    PublicationExportJob.objects.create(creator=creator, status=ExportStatus.QUEUED)
    with pytest.raises(IntegrityError):
        PublicationExportJob.objects.create(creator=creator, status=ExportStatus.RUNNING)


@pytest.mark.django_db
def test_localization_parity_under_rollout_states_and_drift(creator, settings):
    """get_owner_visible_variants produces canonical identical results with and without prefetch and across flag states."""
    page = zPage.objects.create(
        creator=creator,
        free2zaddr="article-drift-test",
        title="Source Canonical Title",
        description="Source Canonical Desc",
        source_language="es",  # Spanish source
        content="# Source Spanish Content",
        is_published=True,
    )
    # Legacy translation
    ZPageTranslation.objects.create(
        zpage=page,
        language="fr",
        title="Titre Français",
        description="Desc Français",
        content="Contenu Français",
        is_published=False,
    )
    # The translation post-save signal creates the mirror; mutate it directly
    # to model rollout drift without violating the variant uniqueness invariant.
    ZPageVariant.objects.filter(zpage=page, language="fr").update(
        title="Titre Français Varié",
        description="Desc Varié",
        content="Contenu Français Varié",
        origin=ZPageVariant.AI,
    )
    # Variant-only row (e.g. German translation only in variant table)
    ZPageVariant.objects.create(
        zpage=page,
        language="de",
        title="Deutscher Titel",
        description="Deutsche Beschreibung",
        content="Deutscher Inhalt",
        origin=ZPageVariant.HUMAN,
        is_published=True,
    )

    # The export is an owner-visible backup, but its bytes must follow the
    # production variant read authority even while the public rollout flag is
    # still off. Check both flag states so a future refactor cannot silently
    # route this path back through the legacy text.
    page_prefetched = zPage.objects.filter(id=page.id).prefetch_related("translations", "variants").first()
    results = []
    for variant_reads in (False, True):
        settings.ZPAGE_VARIANT_READS = variant_reads
        results.append((get_owner_visible_variants(page), get_owner_visible_variants(page_prefetched)))

    assert results[0] == results[1]
    variants_unprefetched, variants_prefetched = results[1]

    assert len(variants_unprefetched) == len(variants_prefetched) == 3

    # Source variant first
    assert variants_unprefetched[0].is_source is True
    assert variants_unprefetched[0].language == "es"
    assert variants_unprefetched[0].title == "Source Canonical Title"
    assert variants_prefetched[0] == variants_unprefetched[0]

    # French translation: the production-authoritative variant wins for content
    # and provenance, even though the legacy row is intentionally divergent.
    fr_var = next(v for v in variants_unprefetched if v.language == "fr")
    assert fr_var.title == "Titre Français Varié"
    assert fr_var.description == "Desc Varié"
    assert fr_var.content == "Contenu Français Varié"
    assert fr_var.origin == ZPageVariant.AI
    assert fr_var.is_published is False

    # German variant-only row
    de_var = next(v for v in variants_unprefetched if v.language == "de")
    assert de_var.title == "Deutscher Titel"
    assert de_var.origin == ZPageVariant.HUMAN


@pytest.mark.django_db
def test_creator_deletion_retains_archive_for_cleanup(creator):
    """Account deletion keeps the archive row so its private object is cleanable."""
    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.READY,
        file_path=f"publications/{creator.id}/archive.zip",
        expires_at=timezone.now() - datetime.timedelta(minutes=1),
    )

    creator.delete()

    job.refresh_from_db()
    assert job.creator_id is None
    assert job.file_path.endswith("/archive.zip")


@pytest.mark.django_db
def test_deleted_creator_archive_is_removed_by_cleanup(creator):
    """A deleted account's expired archive remains discoverable by the sweep."""
    storage = get_export_storage()
    storage_key = f"publications/{creator.id}/deleted/archive.zip"
    storage.save(storage_key, ContentFile(b"private archive"))
    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.READY,
        file_path=storage_key,
        expires_at=timezone.now() - datetime.timedelta(minutes=1),
    )

    creator.delete()
    assert cleanup_expired_jobs() == (1, 0)

    job.refresh_from_db()
    assert job.creator_id is None
    assert job.status == ExportStatus.EXPIRED
    assert job.file_path == ""
    assert not storage.exists(storage_key)


@pytest.mark.django_db(transaction=True)
def test_full_publication_export_archive(creator, other_creator):
    """Full end-to-end export generation testing metadata, directives, media references, checksums, and secret exclusions."""
    # 1. Creator Avatar (public) and Banner (private - should be excluded with warning)
    avatar_file = GenericFile.objects.create(
        owner=creator,
        title="Avatar Image",
        access="public",
        mime_type="image/png",
        file=ContentFile(b"avatar-binary-png", name="avatar.png"),
    )
    banner_file = GenericFile.objects.create(
        owner=creator,
        title="Private Banner Image",
        access="private",
        mime_type="image/jpeg",
        file=ContentFile(b"banner-binary-jpg", name="banner.jpg"),
    )
    creator.avatar_image = avatar_file
    creator.banner_image = banner_file
    creator.save(update_fields=['avatar_image', 'banner_image'])

    # 2. Other creator's GenericFile (must NOT be copied into archive)
    other_file = GenericFile.objects.create(
        owner=other_creator,
        title="Bob Private File",
        access="public",
        mime_type="image/png",
        file=ContentFile(b"bob-secret-data", name="bob_img.png"),
    )

    # 3. Media Assets
    featured_img = GenericFile.objects.create(
        owner=creator,
        title="Featured Image",
        access="public",
        mime_type="image/webp",
        file=ContentFile(b"featured-binary-webp", name="featured.webp"),
    )
    enclosure_audio = GenericFile.objects.create(
        owner=creator,
        title="Podcast Enclosure",
        access="public",
        mime_type="audio/mpeg",
        file=ContentFile(b"audio-binary-mp3", name="episode.mp3"),
    )
    inline_diagram = GenericFile.objects.create(
        owner=creator,
        title="Architecture Diagram",
        access="public",
        mime_type="image/png",
        file=ContentFile(b"diagram-binary-png", name="diagram.png"),
    )

    # 4. Poll
    poll = Poll.objects.create(
        question="Is privacy a fundamental human right?",
        option1="Yes",
        option1_votes=100,
        option1_total=Decimal("25.00000000"),
        option2="No",
        option2_votes=2,
        option2_total=Decimal("0.50000000"),
        viewing_key="secret-poll-viewing-key-exclude",
    )

    # 5. Article 1: Published, first published timestamp, front-matter delimiters, directives, media
    first_pub_time = timezone.now() - datetime.timedelta(days=10)
    raw_art1_content = (
        "# Section 1\n\n"
        "---\n"
        "Body text containing front matter delimiter `---` inside content.\n\n"
        f"Here is an inline diagram: ![]({inline_diagram.get_url()})\n\n"
        "::embed[https://www.youtube.com/watch?v=dQw4w9WgXcQ]\n\n"
        "::qrcode[zs1testaddress]\n\n"
        f"::embed[{inline_diagram.get_url()}]\n\n"
        "::customunknown[some-arg]\n\n"
        f"Cross owner link: ![]({other_file.get_url()})\n\n"
        '<img src="https://external.example.com/logo.png" />\n'
        '<a href="/uploadz/unowned_file.png">Unowned</a>\n'
    )
    page1 = zPage.objects.create(
        creator=creator,
        free2zaddr="article-1-uuid",
        vanity="quantum-privacy-guide",
        title='Quantum Privacy: "The Next Era" & [Guide] 🚀\nLine2',
        description="A comprehensive guide to post-quantum cryptography.",
        canonical_url="https://example.org/original-quantum-guide",
        source_language="en",
        category="SCIENCE",
        content=raw_art1_content,
        is_published=True,
        is_subscriber_only=False,
        published_at=first_pub_time,
        featured_image=featured_img,
        enclosure=enclosure_audio,
        goal=Decimal("500.00000000"),
        total=Decimal("75.25000000"),
        tuzi_total=1500,
        poll=poll,
        password="secret-page-hashed-password-exclude",
        viewing_key="secret-page-viewing-key-exclude",
        f2z_score=Decimal("88.888"),
    )
    page1.tags.add("cryptography", "privacy")

    # Translation for article 1
    ZPageTranslation.objects.create(
        zpage=page1,
        language="es",
        title="Guía de Privacidad Cuántica",
        description="Una guía completa.",
        content=f"Contenido en español con diagrama: ![]({inline_diagram.get_url()})",
        is_published=True,
    )

    # 6. Article 2: Non-English source language (French source test for relative path depth)
    page2 = zPage.objects.create(
        creator=creator,
        free2zaddr="article-2-fr-source",
        vanity=None,
        title="Article Source Français",
        description="Description en Français",
        source_language="fr",
        content=f"Diagramme en français: ![]({inline_diagram.get_url()})",
        is_published=False,
        is_subscriber_only=True,
    )

    # 7. Article 3: Scheduled article (is_published=False with future publish_at)
    future_pub_time = timezone.now() + datetime.timedelta(days=2)
    page3 = zPage.objects.create(
        creator=creator,
        free2zaddr="article-3-scheduled",
        vanity="scheduled-future-post",
        title="Scheduled Post",
        description="Scheduled Description",
        source_language="und",
        content="Future content.",
        is_published=False,
        publish_at=future_pub_time,
    )

    # 8. Series
    series = Series.objects.create(
        name="Privacy Series",
        creator=creator,
    )
    PageOrder.objects.create(series=series, page=page1, order=1)
    PageOrder.objects.create(series=series, page=page2, order=2)
    PageOrder.objects.create(series=series, page=page3, order=3)

    # Export execution
    job = PublicationExportJob.objects.create(creator=creator)
    exporter = PublicationExporter(job)
    exporter.export()

    job.refresh_from_db()
    assert job.status == ExportStatus.READY
    assert job.article_count == 3
    assert job.asset_count >= 3
    assert job.checksum_sha256 != ""
    assert job.file_size > 0
    # complete is False because of unsupported directive::customunknown
    assert job.complete is False
    assert any("::customunknown" in w for w in job.warnings)
    # Informational warning for private banner
    assert any("banner" in w for w in job.warnings)

    storage = get_export_storage()
    assert storage.exists(job.file_path)

    # Inspect archive structure
    with storage.open(job.file_path, "rb") as archive_stream:
        with zipfile.ZipFile(archive_stream) as zf:
            namelist = set(zf.namelist())

            assert "manifest.json" in namelist
            assert "README.md" in namelist
            assert "creator.json" in namelist
            assert "series.json" in namelist
            assert "checksums.sha256" in namelist
            assert "articles/article-1-uuid/index.md" in namelist
            assert "articles/article-1-uuid/source.free2z.md" in namelist
            assert "articles/article-1-uuid/translations/es.md" in namelist
            assert "articles/article-1-uuid/translations/es.free2z.md" in namelist
            assert "articles/article-2-fr-source/index.md" in namelist
            assert "articles/article-2-fr-source/source.free2z.md" in namelist
            assert "articles/article-3-scheduled/index.md" in namelist

            # Assert exact raw Markdown bytes
            with zf.open("articles/article-1-uuid/source.free2z.md") as f:
                assert f.read() == raw_art1_content.encode("utf-8")

            # Assert private banner blob is NOT copied to assets
            banner_sha = hashlib.sha256(b"banner-binary-jpg").hexdigest()
            assert not any(banner_sha in name for name in namelist)

            # Assert other creator's data is NOT copied
            bob_sha = hashlib.sha256(b"bob-secret-data").hexdigest()
            assert not any(bob_sha in name for name in namelist)

            # Parse checksums.sha256 and verify every single other entry in the archive
            with zf.open("checksums.sha256") as f:
                checksums_text = f.read().decode("utf-8")
                checksums_map = {}
                for line in checksums_text.strip().split("\n"):
                    if line.strip():
                        digest, filename = line.split("  ", 1)
                        checksums_map[filename] = digest

                for entry_name in namelist:
                    if entry_name == "checksums.sha256":
                        continue
                    assert entry_name in checksums_map
                    with zf.open(entry_name) as ef:
                        expected_hash = hashlib.sha256(ef.read()).hexdigest()
                        assert checksums_map[entry_name] == expected_hash

            # Validate manifest.json
            with zf.open("manifest.json") as mf:
                manifest = json.load(mf)
                assert manifest["format"] == "free2z-publication-export"
                assert manifest["version"] == 1
                assert manifest["complete"] is False
                assert manifest["creator"]["username"] == "alice"
                assert manifest["creator"]["canonical_url"] == "https://free2z.cash/alice"
                assert manifest["creator"]["banner_asset"] is None  # Private banner excluded
                assert len(manifest["articles"]) == 3
                assert len(manifest["series"]) == 1

                # Check publication_status and published_at on article 1
                art1_manifest = next(a for a in manifest["articles"] if a["free2zaddr"] == "article-1-uuid")
                assert art1_manifest["publication_status"] == "published"
                assert art1_manifest["published_at"] is not None

                # Check scheduled publication_status on article 3
                art3_manifest = next(a for a in manifest["articles"] if a["free2zaddr"] == "article-3-scheduled")
                assert art3_manifest["publication_status"] == "scheduled"
                assert art3_manifest["is_published"] is False
                assert art3_manifest["source_language"] == "und"

                # Check unbundled references (qrcode must NOT be in unbundled)
                unbundled = manifest["unbundled_references"]
                assert not any("zs1testaddress" in u["url"] for u in unbundled)
                assert any("external.example.com" in u["url"] and u["reason"] == "external" for u in unbundled)
                assert any("unowned_file.png" in u["url"] and u["reason"] == "unowned_or_missing" for u in unbundled)
                assert any("bob_img.png" in u["url"] and u["reason"] == "unowned_or_missing" for u in unbundled)

            # Secret exclusions
            for doc_name in ["manifest.json", "creator.json", "series.json"]:
                with zf.open(doc_name) as f:
                    text = f.read().decode("utf-8")
                    assert "secretpassword123" not in text
                    assert "secret-page-viewing-key" not in text
                    assert "secret-poll-viewing-key" not in text
                    assert "secret-page-hashed-password" not in text
                    assert "f2z_score" not in text

            # Validate relative path depth in portable Markdown
            # Source English article: depth 2 ->../../assets/
            with zf.open("articles/article-1-uuid/index.md") as f:
                index_text = f.read().decode("utf-8")
                assert "../../assets/" in index_text
                assert ":::embed" not in index_text
                assert "**QR Code:** `zs1testaddress`" in index_text

            # Translation Spanish article: depth 3 ->../../../assets/
            with zf.open("articles/article-1-uuid/translations/es.md") as f:
                trans_text = f.read().decode("utf-8")
                assert "../../../assets/" in trans_text

            # Source French article (non-English source): depth 2 ->../../assets/
            with zf.open("articles/article-2-fr-source/index.md") as f:
                fr_source_text = f.read().decode("utf-8")
                assert "../../assets/" in fr_source_text


@pytest.mark.django_db
def test_incremental_checksums_and_cleanup_sweep_retry(creator):
    """Cleanup sweep retries when deletion fails and does not drop file_path on failure."""
    storage = get_export_storage()
    filename = "test-export-archive.zip"
    storage_key = f"publications/{creator.id}/job-cleanup/{filename}"
    storage.save(storage_key, ContentFile(b"PK\x03\x04test-archive-bytes"))

    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.READY,
        file_path=storage_key,
        file_name=filename,
        expires_at=timezone.now() - datetime.timedelta(hours=1),
    )

    # 1. Simulate storage.delete failure on first sweep
    with patch.object(storage, "delete", side_effect=IOError("GCS temporary network error")):
        cleaned, remaining = cleanup_expired_jobs()
        assert cleaned == 0
        # The row is still dirty (EXPIRED with a file_path), so the
        # backlog counter must SEE it -- that is the whole point of
        # reporting `remaining` rather than only what was cleaned.
        assert remaining == 1
        job.refresh_from_db()
        assert job.status == ExportStatus.EXPIRED
        # file_path MUST NOT be cleared on failure!
        assert job.file_path == storage_key

    # 2. Second sweep succeeds
    cleaned, remaining = cleanup_expired_jobs()
    assert cleaned >= 1
    assert remaining == 0
    job.refresh_from_db()
    assert job.file_path == ""
    assert not storage.exists(storage_key)


@pytest.mark.django_db
def test_process_export_job_claims_once_and_skips_redelivery(creator):
    """Only the QUEUED -> RUNNING compare-and-set may start an export."""
    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.QUEUED,
    )

    with patch.object(PublicationExporter, "export") as export:
        process_export_job(str(job.id))
        process_export_job(str(job.id))

    assert export.call_count == 1
    job.refresh_from_db()
    assert job.status == ExportStatus.RUNNING
    assert job.started_at is not None


@pytest.mark.django_db
def test_storage_key_is_durable_before_private_upload(creator, tmp_path):
    """A death immediately after upload still leaves cleanup a usable key."""
    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.RUNNING,
        file_name="publication.zip",
    )
    archive = tmp_path / "publication.zip"
    archive.write_bytes(b"PK\x03\x04archive")
    exporter = PublicationExporter(job)
    exporter.creator = creator
    exporter.temp_zip_path = archive
    expected_key = f"publications/{creator.id}/{job.id}/publication.zip"
    storage = MagicMock()

    def save_after_check(key, _content):
        job.refresh_from_db()
        assert job.file_path == expected_key
        return key

    storage.save.side_effect = save_after_check
    with patch("dj.apps.exports.exporter.get_export_storage", return_value=storage):
        exporter._persist_archive_to_storage()

    storage.save.assert_called_once()
    job.refresh_from_db()
    assert job.file_path == expected_key


@pytest.mark.django_db
def test_export_finalization_cannot_resurrect_swept_job(creator):
    """A stale live worker cannot change a cleanup-failed row back to READY."""
    job = PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.QUEUED,
    )
    exporter = PublicationExporter(job)

    def persist_after_sweep():
        exporter.job.file_path = f"publications/{creator.id}/{job.id}/publication.zip"
        exporter.job.save(update_fields=["file_path", "updated_at"])
        PublicationExportJob.objects.filter(id=job.id).update(
            status=ExportStatus.FAILED,
            error_message="Export job was abandoned or timed out.",
        )

    with (
        patch.object(exporter, "_spool_snapshot_to_disk", return_value={}),
        patch.object(exporter, "_resolve_creator_assets"),
        patch.object(exporter, "_build_archive_zip"),
        patch.object(exporter, "_persist_archive_to_storage", side_effect=persist_after_sweep),
        pytest.raises(RuntimeError, match="no longer active"),
    ):
        exporter.export()

    job.refresh_from_db()
    assert job.status == ExportStatus.FAILED


@pytest.mark.django_db(transaction=True)
def test_export_size_and_timeout_bounds(creator):
    """Exporter enforces size and duration bounds safely."""
    zPage.objects.create(
        creator=creator,
        free2zaddr="bound-test-page",
        title="Bound Test Page",
        source_language="en",
        content="Testing bounds.",
    )
    job = PublicationExportJob.objects.create(creator=creator)
    exporter = PublicationExporter(job)
    exporter.max_bytes = 10  # 10 bytes limit

    with pytest.raises(ExportSizeLimitExceeded):
        exporter.export()

    job.refresh_from_db()
    assert job.status == ExportStatus.FAILED
    assert "size limit" in job.error_message


@pytest.mark.django_db(transaction=True)
def test_snapshot_creator_consistency_with_stale_cache(creator):
    """PublicationExporter._spool_snapshot_to_disk reloads fresh creator state inside transaction."""
    job = PublicationExportJob.objects.create(creator=creator)

    # Instantiate exporter with current creator state
    exporter = PublicationExporter(job)

    # Mutate creator metadata directly in the database to simulate out-of-band edit
    Creator.objects.filter(id=creator.id).update(
        full_name="Alice Updated Name",
        description="Updated Bio Inside DB",
    )

    with tempfile.TemporaryDirectory() as temp_dir:
        spool_path = Path(temp_dir)
        snapshot_meta = exporter._spool_snapshot_to_disk(spool_path)

        # Assert exporter.creator and snapshot_meta contain the fresh DB values, not the stale cached ones
        assert exporter.creator is not None
        assert exporter.creator.full_name == "Alice Updated Name"
        assert exporter.creator.description == "Updated Bio Inside DB"
        assert snapshot_meta["creator"]["full_name"] == "Alice Updated Name"
        assert snapshot_meta["creator"]["description"] == "Updated Bio Inside DB"


# ---------------------------------------------------------------------------
# Cleanup sweep batch cap
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_cleanup_sweep_is_capped_and_reports_the_backlog(creator):
    """500 expired archives: one tick cleans 200 and says 300 are left.

    Every row here is one REMOTE storage delete, issued sequentially, on
    the catch-all `default` procrastinate queue. Uncapped, a 500-archive
    backlog is 500 round trips holding that lane -- and because the task
    is periodic and retry=False, a sweep that never finishes looks exactly
    like a sweep with nothing to do. The cap bounds the tick; `remaining`
    is what makes the backlog visible.
    """
    now = timezone.now()
    PublicationExportJob.objects.bulk_create([
        PublicationExportJob(
            creator=creator,
            status=ExportStatus.READY,
            # Distinct keys, none of which exist in storage: storage.exists()
            # is False so no delete is issued, which keeps the test about the
            # CAP rather than about local filesystem throughput.
            file_path=f"publications/{creator.id}/backlog/{i:04d}.zip",
            file_name=f"{i:04d}.zip",
            expires_at=now - datetime.timedelta(hours=500 - i),
        )
        for i in range(500)
    ])

    cleaned, remaining = cleanup_expired_jobs(limit=200)

    assert cleaned == 200
    assert remaining == 300
    assert PublicationExportJob.objects.filter(
        status=ExportStatus.EXPIRED).count() == 200
    assert PublicationExportJob.objects.filter(
        status=ExportStatus.READY).count() == 300

    # And the next tick takes the next 200 -- the cap defers work, it never
    # drops it.
    cleaned, remaining = cleanup_expired_jobs(limit=200)
    assert (cleaned, remaining) == (200, 100)


@pytest.mark.django_db
def test_cleanup_sweep_takes_the_longest_expired_archives_first(creator):
    """Oldest-first, so a capped tick cannot starve the oldest archive.

    With an arbitrary (pk) ordering, a backlog larger than the cap would
    sweep the same prefix every 30 minutes and leave the tail -- the rows
    that have been costing storage longest -- there forever.
    """
    now = timezone.now()
    jobs = [
        PublicationExportJob.objects.create(
            creator=creator,
            status=ExportStatus.READY,
            file_path=f"publications/{creator.id}/order/{i}.zip",
            expires_at=now - datetime.timedelta(hours=i),
        )
        # Created newest-expiry first, so pk order is the wrong order.
        for i in (1, 5, 9)
    ]

    cleaned, remaining = cleanup_expired_jobs(limit=1)

    assert (cleaned, remaining) == (1, 2)
    jobs[2].refresh_from_db()   # expired 9 hours ago -- the oldest
    assert jobs[2].status == ExportStatus.EXPIRED
    jobs[0].refresh_from_db()
    assert jobs[0].status == ExportStatus.READY


@pytest.mark.django_db
def test_cleanup_sweep_default_limit_comes_from_settings(creator, mocker):
    """The task's bound is a setting, not a constant buried in a loop."""
    from django.conf import settings as dj_settings
    assert dj_settings.EXPORT_CLEANUP_BATCH == 200

    now = timezone.now()
    PublicationExportJob.objects.bulk_create([
        PublicationExportJob(
            creator=creator,
            status=ExportStatus.READY,
            file_path=f"publications/{creator.id}/dflt/{i}.zip",
            expires_at=now - datetime.timedelta(hours=1),
        )
        for i in range(5)
    ])

    with override_settings(EXPORT_CLEANUP_BATCH=2):
        assert cleanup_expired_jobs() == (2, 3)


@pytest.mark.django_db
def test_cleanup_task_logs_the_backlog_at_warning(creator, caplog):
    """A backlog the cap did not clear must be visible in the logs.

    exports.cleanup_expired_exports is periodic and retry=False: it is
    always "successful". Without this line there is no signal at all that
    the sweep has stopped keeping up.
    """
    from dj.apps.exports.tasks import cleanup_expired_exports_task

    caplog.set_level('INFO', logger='dj.apps.exports.tasks')
    now = timezone.now()
    PublicationExportJob.objects.bulk_create([
        PublicationExportJob(
            creator=creator,
            status=ExportStatus.READY,
            file_path=f"publications/{creator.id}/warn/{i}.zip",
            expires_at=now - datetime.timedelta(hours=1),
        )
        for i in range(4)
    ])

    with override_settings(EXPORT_CLEANUP_BATCH=1):
        cleanup_expired_exports_task(timestamp=0)

    warnings = [r.getMessage() for r in caplog.records
                if r.levelname == 'WARNING']
    assert any('remaining=3' in m and 'cleaned=1' in m for m in warnings), \
        warnings


@pytest.mark.django_db
def test_undeletable_strays_cannot_starve_abandoned_job_recovery(creator):
    """The batch cap must not be able to wedge the whole export feature.

    Codex adversarial review, and it is the sharp edge of adding a cap:
    every row in the stray sweep has ALREADY had a storage delete fail
    once, and a delete that fails because the object is unreachable keeps
    failing. A single shared pool drained in order therefore lets a
    stray backlog eat the entire batch on every tick, forever -- so the
    abandoned-job sweep never runs, its rows keep occupying the GLOBAL
    EXPORT_MAX_ACTIVE_JOBS admission slots, and every user's export
    request 503s until somebody intervenes by hand.
    """
    now = timezone.now()
    storage = get_export_storage()

    # A backlog of strays far larger than the batch, none of which can be
    # deleted.
    PublicationExportJob.objects.bulk_create([
        PublicationExportJob(
            creator=creator,
            status=ExportStatus.FAILED,
            file_path=f"publications/{creator.id}/undeletable/{i}.zip",
            updated_at=now - datetime.timedelta(days=30),
        )
        for i in range(50)
    ])
    #...and four abandoned RUNNING jobs holding every admission slot.
    # One active job per creator (unique_active_publication_export_job), so
    # four stranded slots means four creators -- which is exactly the shape
    # of the outage: nobody at all can start an export.
    owners = Creator.objects.bulk_create(
        [Creator(username=f"stranded-{i}") for i in range(4)])
    abandoned = [
        PublicationExportJob.objects.create(
            creator=owner, status=ExportStatus.RUNNING)
        for owner in owners
    ]
    PublicationExportJob.objects.filter(
        pk__in=[j.pk for j in abandoned]
    ).update(updated_at=now - datetime.timedelta(hours=3))

    with patch.object(storage, "delete", side_effect=IOError("GCS is down")), \
            patch.object(storage, "exists", return_value=True):
        cleanup_expired_jobs(limit=10)

    for job in abandoned:
        job.refresh_from_db()
        assert job.status == ExportStatus.FAILED, (
            "an abandoned RUNNING row survived the sweep: a stray backlog "
            "consumed the whole batch and the export admission slots stay "
            "occupied forever"
        )


@pytest.mark.django_db
def test_the_batch_cap_is_a_total_across_all_three_sweeps(creator):
    """Guaranteed shares must not turn `limit` into 3 x limit.

    The cap exists because every row is a remote storage delete on the
    catch-all `default` queue. Reserving a share per sweep is only safe if
    the TOTAL is still the number in the setting.
    """
    now = timezone.now()
    PublicationExportJob.objects.bulk_create(
        [
            PublicationExportJob(
                creator=creator, status=ExportStatus.READY,
                file_path=f"publications/{creator.id}/tot-e/{i}.zip",
                expires_at=now - datetime.timedelta(hours=1),
            )
            for i in range(20)
        ] + [
            PublicationExportJob(
                creator=creator, status=ExportStatus.FAILED,
                file_path=f"publications/{creator.id}/tot-s/{i}.zip",
            )
            for i in range(20)
        ] + [
            PublicationExportJob(
                creator=owner, status=ExportStatus.RUNNING,
                updated_at=now - datetime.timedelta(hours=3),
            )
            # One active job per creator, so 20 abandoned rows need 20 owners.
            for owner in Creator.objects.bulk_create(
                [Creator(username=f"total-{i}") for i in range(20)])
        ]
    )
    # bulk_create bypasses auto_now, but be explicit about the abandoned
    # cutoff rather than relying on it.
    PublicationExportJob.objects.filter(
        status=ExportStatus.RUNNING
    ).update(updated_at=now - datetime.timedelta(hours=3))

    before = PublicationExportJob.objects.filter(
        status__in=[ExportStatus.READY, ExportStatus.RUNNING]
    ).count() + PublicationExportJob.objects.filter(
        status=ExportStatus.FAILED).exclude(file_path="").count()

    cleaned, remaining = cleanup_expired_jobs(limit=9)

    # Every sweep had work, so all 9 rows are spent and each sweep got its
    # guaranteed 3 -- not 9 each.
    assert cleaned == 9
    assert remaining == before - 9
    assert PublicationExportJob.objects.filter(
        status=ExportStatus.EXPIRED, file_path="").count() == 3
    assert PublicationExportJob.objects.filter(
        status=ExportStatus.FAILED, file_path="",
    ).count() == 3 + 3   # 3 strays cleared + 3 abandoned rows failed


@pytest.mark.django_db
def test_a_batch_of_one_still_recovers_abandoned_jobs(creator):
    """EXPORT_CLEANUP_BATCH=1 is a permitted setting (codex round 2).

    With three sweeps and a flat share, the reservation for the two later
    sweeps consumed the whole budget and the FIRST sweep -- the one that
    releases the global admission slots -- got zero, on every tick,
    forever. A reservation is a promise to a later sweep, not a licence to
    starve an earlier one.
    """
    now = timezone.now()
    storage = get_export_storage()
    PublicationExportJob.objects.create(
        creator=creator,
        status=ExportStatus.FAILED,
        file_path=f"publications/{creator.id}/undeletable.zip",
    )
    stranded_owner = Creator.objects.create(username="stranded-solo")
    stranded = PublicationExportJob.objects.create(
        creator=stranded_owner, status=ExportStatus.RUNNING)
    PublicationExportJob.objects.filter(pk=stranded.pk).update(
        updated_at=now - datetime.timedelta(hours=3))

    with patch.object(storage, "delete", side_effect=IOError("GCS is down")), \
            patch.object(storage, "exists", return_value=True):
        cleanup_expired_jobs(limit=1)

    stranded.refresh_from_db()
    assert stranded.status == ExportStatus.FAILED


@pytest.mark.django_db
def test_an_undeletable_stray_rotates_to_the_back_of_the_queue(creator):
    """A failing prefix must not monopolise the capped stray sweep.

    The sweep is ordered oldest-`updated_at` first and now capped, and a
    failed delete used to change nothing on the row -- so the same
    permanently undeletable objects were re-selected on every tick and a
    newer stray was never attempted at all. The uncapped loop used to
    reach them (codex round 2).
    """
    storage = get_export_storage()
    old_key = f"publications/{creator.id}/rot-old.zip"
    new_key = f"publications/{creator.id}/rot-new.zip"
    stuck = PublicationExportJob.objects.create(
        creator=creator, status=ExportStatus.FAILED, file_path=old_key)
    later = PublicationExportJob.objects.create(
        creator=creator, status=ExportStatus.FAILED, file_path=new_key)
    PublicationExportJob.objects.filter(pk=stuck.pk).update(
        updated_at=timezone.now() - datetime.timedelta(days=30))
    PublicationExportJob.objects.filter(pk=later.pk).update(
        updated_at=timezone.now() - datetime.timedelta(days=1))

    attempted = []

    def _delete(path):
        attempted.append(path)
        if path == old_key:
            raise IOError("this object can never be deleted")

    with patch.object(storage, "delete", side_effect=_delete), \
            patch.object(storage, "exists", return_value=True):
        cleanup_expired_jobs(limit=1)   # takes only the stuck one
        cleanup_expired_jobs(limit=1)   #...and must move on

    assert attempted == [old_key, new_key], attempted
    later.refresh_from_db()
    assert later.file_path == ""
    stuck.refresh_from_db()
    assert stuck.file_path == old_key   # still a visible backlog row
