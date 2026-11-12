"""Self-service, private full-account exports (free2z/tuzi#2658)."""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import timedelta
from decimal import Decimal

import pytest
from django.core.files.base import ContentFile
from django.core.files.storage import storages
from django.db import connection
from django.http import FileResponse, Http404
from django.urls import path
from django.test import override_settings
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.test import APIClient
from rest_framework.views import APIView

from dj.apps.comments.models import Comment
from dj.apps.exports.models import ExportStatus, ExportType, PublicationExportJob
from dj.apps.g12f.models import Creator
from dj.apps.ledger.models import Account
from dj.apps.oidc.models import AppAuthorization, F2ZApplication, MCPAccountGrant, MCPConnection
from dj.apps.ztripe.models import StripeTransaction
from dj.apps.purchases.models import PurchaseIntent, PurchaseReceipt, Rail, Status

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def private_export_storage(tmp_path, settings):
    settings.STORAGES = {
        **settings.STORAGES,
        "exports": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
            "OPTIONS": {"location": str(tmp_path / "exports")},
        },
    }
    (tmp_path / "exports").mkdir()


def _ready_job(user, storage_path="accounts/archive.zip"):
    now = timezone.now()
    return PublicationExportJob.objects.create(
        creator=user,
        export_type=ExportType.ACCOUNT,
        status=ExportStatus.READY,
        file_name="free2z-account-data.zip",
        file_path=storage_path,
        file_size=5,
        completed_at=now,
        expires_at=now + timedelta(hours=24),
    )


class Pre2658PublicationDownloadHandler(APIView):
    """The old web handler: owner and id only, with no export_type predicate."""

    permission_classes = [IsAuthenticated]

    def get(self, request, id):
        try:
            job = PublicationExportJob.objects.get(id=id, creator=request.user)
        except PublicationExportJob.DoesNotExist:
            raise Http404("Export job not found.")
        if job.status != ExportStatus.READY or job.is_expired or not job.file_path:
            raise Http404("Export archive not found.")
        storage = storages["exports"]
        if not storage.exists(job.file_path):
            raise Http404("Export archive not found.")
        return FileResponse(
            storage.open(job.file_path, "rb"),
            as_attachment=True,
            filename=job.file_name,
            content_type="application/zip",
        )


urlpatterns = [
    path(
        "api/exports/publications/<uuid:id>/download/",
        Pre2658PublicationDownloadHandler.as_view(),
    ),
]


def test_export_request_needs_recent_sign_in_and_queues_existing_export_task(
    creator_factory, recent_login, mocker, settings, monkeypatch,
):
    user = creator_factory(username="burner", email="")
    stale = APIClient()
    stale.force_login(user)
    stale_response = stale.post("/api/exports/account/", format="json")
    assert stale_response.status_code == 401
    assert stale_response.json()["code"] == "insufficient_user_authentication"

    client = APIClient()
    recent_login(client, user)
    settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 0
    monkeypatch.setattr("dj.apps.exports.rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED", True)
    defer = mocker.patch("dj.apps.exports.views.export_account_data_task.defer")

    response = client.post("/api/exports/account/", format="json")
    assert response.status_code == 201, response.content
    job = PublicationExportJob.objects.get(pk=response.json()["id"])
    assert job.creator_id == user.pk
    assert job.export_type == ExportType.ACCOUNT
    assert job.status == ExportStatus.QUEUED
    assert response["Cache-Control"] == "private, no-store"
    defer.assert_called_once_with(job_id=str(job.pk))
    from procrastinate.contrib.django import app
    assert app.tasks["exports.export_account_data_v1"].queue == "account-exports-v1"

    repeated = client.post("/api/exports/account/", format="json")
    assert repeated.status_code == 200
    assert repeated.json()["id"] == str(job.pk)


def test_default_closed_admission_cannot_create_a_job_for_pre_fence_web_handler(
    creator_factory, recent_login, mocker,
):
    """Closed task admission preserves an old queued row and cannot make a ZIP."""
    from dj.apps.exports.rollout import ACCOUNT_EXPORT_ADMISSION_ENABLED
    from dj.apps.exports.tasks import (
        ACCOUNT_EXPORT_PAUSE_RETRY_SECONDS,
        AccountExportAdmissionClosed,
    )
    from procrastinate.jobs import Job
    from procrastinate.contrib.django import app

    assert ACCOUNT_EXPORT_ADMISSION_ENABLED is False
    owner = creator_factory(username="mixed-version-owner", email="")
    client = APIClient()
    recent_login(client, owner)

    denied = client.post("/api/exports/account/", format="json")
    assert denied.status_code == 503
    assert PublicationExportJob.objects.filter(
        creator=owner, export_type=ExportType.ACCOUNT,
    ).count() == 0

    # Simulate a row and deferred task that existed before this hold. The task
    # must fail into Procrastinate's scheduled retry path before it reads the
    # owner, changes the export row, or calls the archive producer.
    queued = PublicationExportJob.objects.create(
        creator=owner,
        export_type=ExportType.ACCOUNT,
        status=ExportStatus.QUEUED,
        file_name="free2z-account-data-pending.zip",
    )
    produce_archive = mocker.patch("dj.apps.exports.exporter.process_export_job")
    task = app.tasks["exports.export_account_data_v1"]
    with pytest.raises(AccountExportAdmissionClosed) as refusal:
        task.func(job_id=str(queued.pk))
    produce_archive.assert_not_called()
    queued.refresh_from_db()
    assert queued.status == ExportStatus.QUEUED
    assert queued.file_path == ""
    assert queued.file_size is None

    retry_job = Job(
        queue=task.queue,
        lock=None,
        queueing_lock=None,
        task_name=task.name,
        task_kwargs={"job_id": str(queued.pk)},
    )
    retry = task.get_retry_exception(exception=refusal.value, job=retry_job)
    assert retry is not None
    assert retry.retry_decision.retry_at >= timezone.now() + timedelta(
        seconds=ACCOUNT_EXPORT_PAUSE_RETRY_SECONDS - 5,
    )

    # Run through the normal Django session/auth middleware and the exact old
    # query shape (id + creator, with no export_type filter). The queued row
    # remains unarchived and the old handler has no ZIP to return.
    with override_settings(ROOT_URLCONF="dj.apps.exports.test_account_data_export"):
        missing = client.get(
            f"/api/exports/publications/{queued.pk}/download/",
        )
    assert missing.status_code == 404
    assert not storages["exports"].exists(f"accounts/{owner.pk}/{queued.pk}/free2z-account-data-pending.zip")


@pytest.mark.parametrize("pending_status", [ExportStatus.QUEUED, ExportStatus.RUNNING])
def test_closed_account_queue_retries_and_cleanup_preserves_pending_evidence(
    creator_factory, mocker, pending_status,
):
    """Held account tasks retry in Procrastinate and survive stale sweeps."""
    import time

    from asgiref.sync import async_to_sync
    from django.db import connection
    from procrastinate.jobs import Job
    from procrastinate.contrib.django import app
    from procrastinate.contrib.django.models import ProcrastinateJob
    from procrastinate.job_context import JobContext
    from procrastinate.worker import Worker

    from dj.apps.exports.exporter import cleanup_expired_jobs
    from dj.apps.exports.rollout import ACCOUNT_EXPORT_ADMISSION_ENABLED
    from dj.apps.exports.tasks import ACCOUNT_EXPORT_QUEUE

    assert ACCOUNT_EXPORT_ADMISSION_ENABLED is False
    owner = creator_factory(username=f"held-{pending_status}", email="")
    storage = storages["exports"]
    evidence_path = f"accounts/{owner.pk}/{uuid.uuid4()}/pending.zip"
    evidence_bytes = b"recoverable account export evidence"
    evidence_path = storage.save(evidence_path, ContentFile(evidence_bytes))
    pending = PublicationExportJob.objects.create(
        creator=owner,
        export_type=ExportType.ACCOUNT,
        status=pending_status,
        file_name="pending-account-export.zip",
        file_path=evidence_path,
        file_size=len(evidence_bytes),
    )
    stale_at = timezone.now() - timedelta(hours=3)
    PublicationExportJob.objects.filter(pk=pending.pk).update(updated_at=stale_at)

    task = app.tasks["exports.export_account_data_v1"]
    queued_task_id = task.defer(job_id=str(pending.pk))
    task_row = ProcrastinateJob.objects.get(pk=queued_task_id)
    produce_archive = mocker.patch("dj.apps.exports.exporter.process_export_job")
    worker = Worker(
        app=app,
        queues=[ACCOUNT_EXPORT_QUEUE],
        task_middleware=[],
        worker_middleware=[],
        listen_notify=False,
        install_signal_handlers=False,
    )

    # Execute Procrastinate's real per-job processing path twice. It catches
    # the closed-admission exception, applies the task's unlimited retry
    # policy, and persists TODO + scheduled_at + attempts itself.
    for expected_attempts in (0, 1):
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE procrastinate_jobs SET status='doing', attempts=%s WHERE id=%s",
                [expected_attempts, queued_task_id],
            )
        worker_job = Job(
            id=queued_task_id,
            status="doing",
            queue=task.queue,
            lock=None,
            queueing_lock=None,
            task_name=task.name,
            task_kwargs={"job_id": str(pending.pk)},
            attempts=expected_attempts,
        )
        context = JobContext(
            app=app,
            worker_name="account-export-hold-test",
            worker_queues=[ACCOUNT_EXPORT_QUEUE],
            job=worker_job,
            start_timestamp=time.time(),
            abort_reason=lambda: None,
        )
        async_to_sync(worker._process_job)(context)
        task_row.refresh_from_db()
        assert task_row.status == "todo"
        assert task_row.attempts == expected_attempts + 1
        assert task_row.scheduled_at >= timezone.now() + timedelta(hours=5, minutes=59)

        # Every retry cycle is followed by the real age-based storage sweep.
        # The held row stays queued/running with its evidence intact.
        cleanup_expired_jobs(limit=30)
        pending.refresh_from_db()
        assert pending.status == pending_status
        assert pending.file_path == evidence_path
        assert pending.file_size == len(evidence_bytes)
        with storage.open(evidence_path, "rb") as artifact:
            assert artifact.read() == evidence_bytes

    produce_archive.assert_not_called()

    # Publications continue through normal abandoned cleanup, and an account
    # archive that has completed its authorized retention still expires.
    publication = PublicationExportJob.objects.create(
        creator=None,
        export_type=ExportType.PUBLICATIONS,
        status=ExportStatus.QUEUED,
    )
    PublicationExportJob.objects.filter(pk=publication.pk).update(updated_at=stale_at)
    completed_bytes = b"completed private archive"
    completed_path = storage.save(
        f"accounts/{owner.pk}/{uuid.uuid4()}/completed.zip",
        ContentFile(completed_bytes),
    )
    completed = PublicationExportJob.objects.create(
        creator=owner,
        export_type=ExportType.ACCOUNT,
        status=ExportStatus.READY,
        file_name="completed-account-export.zip",
        file_path=completed_path,
        file_size=len(completed_bytes),
        completed_at=stale_at - timedelta(hours=25),
        expires_at=stale_at - timedelta(hours=1),
    )

    cleaned, remaining = cleanup_expired_jobs(limit=30)
    assert cleaned == 2
    # The stale account row is deliberately outside this sweep's work queue;
    # its recovery evidence remains available to the account task queue.
    assert remaining == 0
    publication.refresh_from_db()
    assert publication.status == ExportStatus.FAILED
    completed.refresh_from_db()
    assert completed.status == ExportStatus.EXPIRED
    assert completed.file_path == ""
    assert not storage.exists(completed_path)
    pending.refresh_from_db()
    assert pending.status == pending_status
    assert storage.exists(evidence_path)


def test_pre_fence_handler_still_downloads_publication_archives(
    creator_factory, recent_login,
):
    """The compatibility release keeps existing publication downloads working."""
    owner = creator_factory(username="publication-compat", email="")
    job = PublicationExportJob.objects.create(
        creator=owner,
        export_type=ExportType.PUBLICATIONS,
        status=ExportStatus.READY,
        file_name="publication.zip",
        file_path="publications/archive.zip",
        file_size=11,
        completed_at=timezone.now(),
        expires_at=timezone.now() + timedelta(hours=24),
    )
    storages["exports"].save(job.file_path, ContentFile(b"publication"))
    client = APIClient()
    recent_login(client, owner)

    with override_settings(ROOT_URLCONF="dj.apps.exports.test_account_data_export"):
        response = client.get(
            f"/api/exports/publications/{job.pk}/download/",
        )
    assert response.status_code == 200
    assert b"".join(response.streaming_content) == b"publication"


def test_type_filtered_publication_handler_rejects_an_account_archive(
    creator_factory, recent_login,
):
    owner = creator_factory(username="typed-publication-download", email="")
    job = _ready_job(owner)
    storages["exports"].save(job.file_path, ContentFile(b"private account data"))
    client = APIClient()
    recent_login(client, owner)

    response = client.get(f"/api/exports/publications/{job.pk}/download/")

    assert response.status_code == 404


def test_pre_account_export_insert_shape_uses_the_database_column_default(creator_factory):
    user = creator_factory(username="old-web-pod")
    job_id = uuid.uuid4()
    now = timezone.now()
    # This is the INSERT shape emitted by a pre-#2658 Django model: every
    # existing column is written, but the newly added export_type is unknown.
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO exports_publicationexportjob (
                id, status, complete, warnings, error_message, file_path,
                file_name, file_size, checksum_sha256, article_count,
                asset_count, created_at, updated_at, started_at,
                completed_at, expires_at, creator_id
            ) VALUES (
                %s, 'queued', FALSE, '[]'::jsonb, '', '', '', NULL, '',
                0, 0, %s, %s, NULL, NULL, NULL, %s
            )
            """,
            [str(job_id), now, now, user.pk],
        )

    job = PublicationExportJob.objects.get(pk=job_id)
    assert job.export_type == ExportType.PUBLICATIONS


def test_account_export_creation_has_a_persistent_per_account_rate_limit(
    creator_factory, recent_login, mocker, settings, monkeypatch,
):
    user = creator_factory(username="rate-limited")
    client = APIClient()
    recent_login(client, user)
    settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 0
    settings.ACCOUNT_EXPORT_RATE_LIMIT_PER_HOUR = 1
    monkeypatch.setattr("dj.apps.exports.rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED", True)
    mocker.patch("dj.apps.exports.views.export_account_data_task.defer")

    first = client.post("/api/exports/account/", format="json")
    assert first.status_code == 201
    PublicationExportJob.objects.filter(pk=first.json()["id"]).update(status=ExportStatus.FAILED)
    second = client.post("/api/exports/account/", format="json")
    assert second.status_code == 429
    assert second["Retry-After"] == "3600"


def test_latest_export_status_is_owner_scoped_and_recovers_a_ready_download(
    creator_factory, recent_login,
):
    owner = creator_factory(username="burner", email="")
    other = creator_factory(username="other")
    job = _ready_job(owner)
    storages["exports"].save(job.file_path, ContentFile(b"zip!"))

    owner_client = APIClient()
    recent_login(owner_client, owner)
    response = owner_client.get("/api/exports/account/latest/")
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    assert response["Referrer-Policy"] == "no-referrer"
    assert response.json()["export"]["id"] == str(job.pk)
    assert response.json()["export"]["download_token"]

    other_client = APIClient()
    recent_login(other_client, other)
    assert other_client.get("/api/exports/account/latest/").json() == {"export": None}


@pytest.mark.parametrize("status_path", ["latest", "detail"])
def test_expired_account_export_status_reads_are_pure_and_revoke_download_tokens(
    creator_factory, recent_login, status_path,
):
    owner = creator_factory(username=f"expired-{status_path}")
    job = _ready_job(owner)
    PublicationExportJob.objects.filter(pk=job.pk).update(
        expires_at=timezone.now() - timedelta(seconds=1),
    )
    job.refresh_from_db()
    original_updated_at = job.updated_at

    client = APIClient()
    recent_login(client, owner)
    if status_path == "latest":
        response = client.get("/api/exports/account/latest/")
        payload = response.json()["export"]
    else:
        response = client.get(f"/api/exports/account/{job.pk}/")
        payload = response.json()

    assert response.status_code == 200
    assert payload["status"] == ExportStatus.EXPIRED
    assert payload["download_url"] is None
    assert payload["download_token"] is None

    job.refresh_from_db()
    assert job.status == ExportStatus.READY
    assert job.updated_at == original_updated_at


def test_account_download_signature_is_expiring_and_account_bound(creator_factory, recent_login, monkeypatch):
    owner = creator_factory(username="owner", email="")
    other = creator_factory(username="other")
    job = _ready_job(owner)
    storage = storages["exports"]
    storage.save(job.file_path, ContentFile(b"zip!"))

    owner_client = APIClient()
    recent_login(owner_client, owner)
    status_response = owner_client.get(f"/api/exports/account/{job.pk}/")
    assert status_response.status_code == 200
    assert status_response["Cache-Control"] == "private, no-store"
    assert status_response["Referrer-Policy"] == "no-referrer"
    body = status_response.json()
    assert body["download_url"] == f"/api/exports/account/{job.pk}/download/"
    signature = body["download_token"]

    downloaded = owner_client.get(body["download_url"], HTTP_X_ACCOUNT_EXPORT_SIGNATURE=signature)
    assert downloaded.status_code == 200
    assert b"".join(downloaded.streaming_content) == b"zip!"
    assert downloaded["Cache-Control"] == "private, no-store"
    assert downloaded["Referrer-Policy"] == "no-referrer"

    wrong_account = APIClient()
    recent_login(wrong_account, other)
    assert wrong_account.get(body["download_url"], HTTP_X_ACCOUNT_EXPORT_SIGNATURE=signature).status_code == 404
    tampered = signature[:-1] + ("x" if signature[-1] != "x" else "y")
    assert owner_client.get(body["download_url"], HTTP_X_ACCOUNT_EXPORT_SIGNATURE=tampered).status_code == 404

    monkeypatch.setattr("dj.apps.exports.views.ACCOUNT_EXPORT_LINK_MAX_AGE_SECONDS", -1)
    assert owner_client.get(body["download_url"], HTTP_X_ACCOUNT_EXPORT_SIGNATURE=signature).status_code == 404


def test_deactivated_account_cannot_download_even_with_a_valid_signature(creator_factory, recent_login):
    owner = creator_factory(username="owner")
    job = _ready_job(owner)
    storages["exports"].save(job.file_path, ContentFile(b"zip!"))
    client = APIClient()
    recent_login(client, owner)
    signature = client.get(f"/api/exports/account/{job.pk}/").json()["download_token"]
    Creator.objects.filter(pk=owner.pk).update(is_active=False)

    response = client.get(f"/api/exports/account/{job.pk}/download/", HTTP_X_ACCOUNT_EXPORT_SIGNATURE=signature)
    assert response.status_code in (401, 403, 404)


def test_deletion_scheduled_account_cannot_download_even_with_a_valid_signature(
    creator_factory, recent_login,
):
    owner = creator_factory(username="deleting-owner")
    job = _ready_job(owner)
    storages["exports"].save(job.file_path, ContentFile(b"zip!"))
    client = APIClient()
    recent_login(client, owner)
    signature = client.get(f"/api/exports/account/{job.pk}/").json()["download_token"]
    Creator.objects.filter(pk=owner.pk).update(
        is_active=False,
        deletion_requested_at=timezone.now(),
    )

    response = client.get(
        f"/api/exports/account/{job.pk}/download/",
        HTTP_X_ACCOUNT_EXPORT_SIGNATURE=signature,
    )
    assert response.status_code in (401, 403, 404)


def test_archive_expiry_revokes_a_previously_issued_download_signature(
    creator_factory, recent_login,
):
    owner = creator_factory(username="expired-owner")
    job = _ready_job(owner)
    storages["exports"].save(job.file_path, ContentFile(b"zip!"))
    client = APIClient()
    recent_login(client, owner)
    signature = client.get(f"/api/exports/account/{job.pk}/").json()["download_token"]
    PublicationExportJob.objects.filter(pk=job.pk).update(expires_at=timezone.now() - timedelta(seconds=1))

    response = client.get(
        f"/api/exports/account/{job.pk}/download/",
        HTTP_X_ACCOUNT_EXPORT_SIGNATURE=signature,
    )
    assert response.status_code == 410


def test_worker_persists_ready_account_archive_in_private_storage(creator_factory, mocker):
    from dj.apps.exports.account_data import process_account_export_job

    user = creator_factory(username="archive-owner")
    job = PublicationExportJob.objects.create(
        creator=user,
        export_type=ExportType.ACCOUNT,
        status=ExportStatus.RUNNING,
        file_name="free2z-account-data.zip",
        expires_at=timezone.now() + timedelta(hours=24),
    )

    def write_archive(_user_id, archive_path):
        archive_path.write_bytes(b"private-archive")
        return {"counts": {}, "publication": {"complete": True, "warnings": []}}

    mocker.patch("dj.apps.exports.account_data.build_account_archive", write_archive)
    process_account_export_job(job)

    job.refresh_from_db()
    assert job.status == ExportStatus.READY
    assert job.complete is False
    assert any("incomplete" in warning for warning in job.warnings)
    assert job.creator_id == user.pk
    assert job.expires_at > timezone.now()
    assert job.file_path.startswith(f"accounts/{user.pk}/{job.pk}/")
    assert job.file_size == len(b"private-archive")
    with storages["exports"].open(job.file_path, "rb") as stored:
        assert stored.read() == b"private-archive"


def test_archive_includes_owned_records_and_omits_credentials_and_other_people(
    creator_factory, mocker, tmp_path,
):
    from dj.apps.exports.account_data import build_account_archive
    from dj.apps.exports.exporter import PublicationExporter

    owner = creator_factory(username="burner", email="", full_name="Burner")
    owner.set_password("never-export-this-password")
    owner.save()
    other = creator_factory(username="neighbor")
    from dj.apps.tuzis import ledger
    ledger.credit(
        owner, Decimal("1.200"), source="sys:promo", ref_kind="tuzi_grant",
        ref_id="grant-export", idem=f"grant-export-{uuid.uuid4()}",
    )
    owner_account = Account.objects.get(owner=owner, kind="user")
    debt_account = Account.objects.create(
        key=f"user_debt:{owner.pk}", kind="user_debt", owner=owner,
        journal_only=False,
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT * FROM ledger.post_transfer(%s, ledger.sys('sys:clearing_stripe'), "
            "300, 'clawback_debt', 'account_export_test', 'debt', NULL, NULL)",
            [debt_account.pk],
        )
        assert cursor.fetchone()[1] == "posted"
        cursor.execute(
            "SELECT * FROM ledger.post_transfer(%s, %s, 300, 'debt_repay', "
            "'account_export_test', 'repayment', NULL, NULL)",
            [owner_account.pk, debt_account.pk],
        )
        assert cursor.fetchone()[1] == "posted"
    ledger.credit(
        other, Decimal("9.999"), source="sys:promo", ref_kind="tuzi_grant",
        ref_id="neighbor-export", idem=f"neighbor-export-{uuid.uuid4()}",
    )
    Comment.objects.create(author=owner, headline="My note", content="my comment body")
    hidden_comment = Comment.objects.create(author=owner, headline="Hidden note", content="my moderated comment")
    hidden_comment.is_banned = True
    hidden_comment.save(update_fields=["is_banned"])
    Comment.objects.create(author=other, headline="Other note", content="other private comment")

    now = timezone.now()
    intent = PurchaseIntent.objects.create(
        creator=owner, rail=Rail.STRIPE, platform="desktop", status=Status.CREATED,
        quantity_2z=12, quote={"provider_secret": "must-not-export"},
        pricing_version="test", price_minor=100, currency="USD",
        return_url="https://private.example/return?session=private",
        rail_data={"checkout_url": "https://private.example/session"},
        expires_at=now + timedelta(minutes=30),
    )
    PurchaseIntent.objects.create(
        creator=other, rail=Rail.STRIPE, platform="desktop", status=Status.CREATED,
        quantity_2z=99, quote={}, pricing_version="test", price_minor=200,
        currency="USD", expires_at=now + timedelta(minutes=30),
    )
    PurchaseReceipt.objects.create(
        intent=intent, rail=Rail.STRIPE, provider_event_id="private-provider-event",
        amount_minor=100, currency="USD", credited_milli_2z=12000,
        ledger_ref_kind="purchase", ledger_ref_id="private-ledger-ref",
    )
    developer = creator_factory(username="developer")
    app = F2ZApplication.objects.create(
        name="Connected reader", user=developer,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://app.example/callback", allowed_scopes="openid profile",
    )
    AppAuthorization.objects.create(user=owner, application=app, scope="openid profile")
    owned_app = F2ZApplication.objects.create(
        name="Owner application", user=owner, client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://owner.example/callback", allowed_scopes="openid profile",
    )
    connection_row = MCPConnection.objects.create(primary_user=owner, application=app, primary_epoch=1, primary_grant_generation=1, scope="openid")
    MCPAccountGrant.objects.create(connection=connection_row, user=owner, account_epoch=1, scope="openid")
    StripeTransaction.objects.create(user=owner, amount=100, tuzis_credited=12, stripe_charge_id="charge-secret-owner")
    StripeTransaction.objects.create(user=other, amount=200, tuzis_credited=99, stripe_charge_id="charge-secret-other")

    other_app = F2ZApplication.objects.create(
        name="Neighbor app", user=other,
        client_type=F2ZApplication.CLIENT_PUBLIC,
        redirect_uris="https://neighbor.example/callback", allowed_scopes="openid profile",
    )
    AppAuthorization.objects.create(user=other, application=other_app, scope="openid profile")

    publication_zip = io.BytesIO()
    with zipfile.ZipFile(publication_zip, "w") as zf:
        zf.writestr("manifest.json", '{"format":"free2z-publication-export"}')
        zf.writestr("articles/page/index.md", "my page")
    publication_zip.seek(0)

    def fake_publication_build(_exporter, output_path):
        output_path.write_bytes(publication_zip.getvalue())
        return {"article_count": 1, "asset_count": 0, "complete": True, "warnings": []}

    mocker.patch.object(PublicationExporter, "build_archive_file", fake_publication_build)
    archive_path = tmp_path / "account.zip"
    build_account_archive(owner.pk, archive_path)

    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        assert "manifest.json" in names
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["complete"] is False
        assert "repeatable-read" in manifest["snapshot"]
        assert "financial_and_operational_records" in manifest["omissions"]
        assert "shared across owners" in manifest["omissions"]["sensitive_records"]
        assert "profile.json" in names
        assert "publications.zip" in names
        with zipfile.ZipFile(io.BytesIO(archive.read("publications.zip"))) as publications:
            assert "articles/page/index.md" in publications.namelist()
        assert {"comments.jsonl", "ledger.jsonl", "purchases.jsonl", "purchase_receipts.jsonl", "connected_apps.jsonl"} <= names
        assert "checksums.sha256" in names
        profile = json.loads(archive.read("profile.json"))
        assert profile["username"] == "burner" and profile["email"] is None
        assert profile["first_name"] == owner.first_name
        assert "mention_notifications_enabled" in profile
        comments = archive.read("comments.jsonl").decode()
        purchases = [json.loads(line) for line in archive.read("purchases.jsonl").decode().splitlines()]
        ledger_rows = [json.loads(line) for line in archive.read("ledger.jsonl").decode().splitlines()]
        receipts = archive.read("purchase_receipts.jsonl").decode()
        apps = archive.read("connected_apps.jsonl").decode()
        owned_apps = archive.read("owned_apps.jsonl").decode()
        mcp = archive.read("mcp_grants.jsonl").decode()
        legacy = archive.read("legacy_purchases.jsonl").decode()
        assert "Owner application" in owned_apps and "Neighbor app" not in owned_apps
        assert "Connected reader" in mcp
        assert "charge-secret" not in legacy and '"tuzis_credited": 12' in legacy
        assert '"tuzis_credited": 99' not in legacy
        assert owned_app.client_secret not in owned_apps if owned_app.client_secret else True
        all_content = b"".join(archive.read(name) for name in names if not name.endswith("checksums.sha256"))
        assert "my comment body" in comments
        assert "my moderated comment" in comments
        assert "other private comment" not in comments
        assert [row["quantity_2z"] for row in purchases] == [12]
        assert any(row["amount_milli_2z"] == 1200 and row["direction"] == "in" for row in ledger_rows)
        assert any(
            row["direction"] == "internal"
            and row["amount_milli_2z"] == 300
            and row["from_account_kind"] == "user"
            and row["to_account_kind"] == "user_debt"
            for row in ledger_rows
        )
        assert not any(abs(row["amount_milli_2z"]) == 9999 for row in ledger_rows)
        assert "private-provider-event" not in receipts
        assert "private-ledger-ref" not in receipts
        assert "Connected reader" in apps
        assert "Neighbor app" not in apps
        assert "must-not-export" not in all_content.decode(errors="replace")
        assert "private.example" not in all_content.decode(errors="replace")
        assert "never-export-this-password" not in all_content.decode(errors="replace")
        assert owner.password not in all_content.decode(errors="replace")


def test_archive_rejects_publication_bundle_over_the_account_size_limit(
    creator_factory, mocker, settings, tmp_path,
):
    from dj.apps.exports.account_data import build_account_archive
    from dj.apps.exports.exporter import ExportSizeLimitExceeded, PublicationExporter

    owner = creator_factory(username="large-export")
    settings.ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES = 1

    def oversized_publication_build(_exporter, output_path):
        output_path.write_bytes(b"publication data")
        return {"article_count": 0, "asset_count": 0, "complete": True, "warnings": []}

    mocker.patch.object(PublicationExporter, "build_archive_file", oversized_publication_build)
    with pytest.raises(ExportSizeLimitExceeded):
        build_account_archive(owner.pk, tmp_path / "account.zip")


def test_account_deadline_is_passed_into_the_publication_subbuild(
    creator_factory, mocker, settings, tmp_path,
):
    from dj.apps.exports.account_data import _ExportBounds, build_account_archive
    from dj.apps.exports.exporter import PublicationExporter

    owner = creator_factory(username="deadline-export")
    settings.ACCOUNT_EXPORT_MAX_DURATION_SECONDS = 50
    settings.EXPORT_MAX_DURATION_SECONDS = 1800
    mocker.patch.object(_ExportBounds, "remaining_seconds", return_value=2)

    def deadline_aware_build(exporter, output_path):
        assert exporter.max_duration == 2
        output_path.write_bytes(b"publication data")
        return {"article_count": 0, "asset_count": 0, "complete": True, "warnings": []}

    mocker.patch.object(PublicationExporter, "build_archive_file", deadline_aware_build)
    build_account_archive(owner.pk, tmp_path / "account.zip")


def test_account_deadline_remaining_time_subtracts_elapsed_generation_time(mocker):
    from dj.apps.exports.account_data import _ExportBounds

    bounds = _ExportBounds()
    bounds.started = 10
    bounds.max_duration = 50
    mocker.patch("dj.apps.exports.account_data.time.monotonic", return_value=17)
    assert bounds.remaining_seconds() == 43


def test_download_signature_cannot_cross_sessions(creator_factory, recent_login):
    owner = creator_factory()
    job = _ready_job(owner)
    storages["exports"].save(job.file_path, ContentFile(b"hello"))
    first, second = APIClient(), APIClient()
    recent_login(first, owner)
    recent_login(second, owner)
    token = first.get(f"/api/exports/account/{job.pk}/").json()["download_token"]
    url = f"/api/exports/account/{job.pk}/download/"
    assert second.get(url, HTTP_X_ACCOUNT_EXPORT_SIGNATURE=token).status_code == 404
    assert first.get(url, HTTP_X_ACCOUNT_EXPORT_SIGNATURE=token).status_code == 200


def test_expired_signature_can_be_refreshed_for_same_job(creator_factory, recent_login, monkeypatch):
    from dj.apps.exports import views

    owner = creator_factory()
    job = _ready_job(owner)
    storages["exports"].save(job.file_path, ContentFile(b"hello"))
    client = APIClient()
    recent_login(client, owner)
    detail = f"/api/exports/account/{job.pk}/"
    first = client.get(detail).json()
    monkeypatch.setattr(views, "ACCOUNT_EXPORT_LINK_MAX_AGE_SECONDS", -1)
    assert client.get(first["download_url"], HTTP_X_ACCOUNT_EXPORT_SIGNATURE=first["download_token"]).status_code == 404
    monkeypatch.setattr(views, "ACCOUNT_EXPORT_LINK_MAX_AGE_SECONDS", 900)
    refreshed = client.get(detail).json()
    assert refreshed["id"] == first["id"]
    assert client.get(refreshed["download_url"], HTTP_X_ACCOUNT_EXPORT_SIGNATURE=refreshed["download_token"]).status_code == 200


@pytest.mark.django_db(transaction=True)
def test_account_archive_uses_real_publication_exporter(creator_factory, tmp_path):
    from dj.apps.exports.account_data import build_account_archive
    from dj.apps.g12f.models import zPage

    owner = creator_factory(username="real-owner")
    other = creator_factory(username="real-other")
    zPage.objects.create(creator=owner, free2zaddr="owned-real", title="Owned publication", content="owned content")
    zPage.objects.create(creator=other, free2zaddr="other-real", title="Other publication", content="other secret content")
    path = tmp_path / "account.zip"
    build_account_archive(owner.pk, path)
    with zipfile.ZipFile(path) as outer:
        with zipfile.ZipFile(io.BytesIO(outer.read("publications.zip"))) as publications:
            contents = b"\n".join(publications.read(name) for name in publications.namelist())
            assert b"Owned publication" in contents
            assert b"Other publication" not in contents


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("case", ["same", "capacity", "mixed"])
def test_concurrent_admission_uses_postgres_lock(case, creator_factory, recent_login, mocker, settings, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from django.db import close_old_connections, connections

    assert connection.vendor == "postgresql"
    monkeypatch.setattr("dj.apps.exports.rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED", True)
    settings.EXPORT_TASK_ROLLOUT_DELAY_SECONDS = 0
    settings.EXPORT_MAX_ACTIVE_JOBS = 1
    user = creator_factory(username=f"concurrent-{case}")
    other = creator_factory(username=f"other-{case}") if case == "capacity" else user
    clients = [APIClient(), APIClient()]
    recent_login(clients[0], user)
    recent_login(clients[1], other)
    account_defer = mocker.patch("dj.apps.exports.views.export_account_data_task.defer")
    publication_defer = mocker.patch("dj.apps.exports.views.export_publication_task.defer")
    barrier = Barrier(2)

    def request(index):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            path = "/api/exports/publications/" if case == "mixed" and index == 1 else "/api/exports/account/"
            response = clients[index].post(path, format="json")
            return response.status_code, response.json()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(request, range(2)))
    assert PublicationExportJob.objects.filter(status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING]).count() == 1
    assert account_defer.call_count + publication_defer.call_count == 1
    if case == "same":
        assert sorted(status for status, _ in results) == [200, 201]
        assert results[0][1]["id"] == results[1][1]["id"]
    elif case == "capacity":
        assert sorted(status for status, _ in results) == [201, 503]
    else:
        assert sorted(status for status, _ in results) == [201, 409]


def test_direct_creator_relation_census_stays_current():
    """New direct account relations must be reviewed in the export inventory."""
    from pathlib import Path
    from django.apps import apps

    expected = json.loads((Path(__file__).parent / "account_relation_census.json").read_text())
    found = {}
    for model in apps.get_models():
        fields = sorted(
            field.name for field in model._meta.get_fields()
            if field.concrete and field.is_relation and field.related_model is Creator
        )
        if fields:
            found[model._meta.label] = fields
    assert found == {name: sorted(fields) for name, fields in expected.items()}


def test_account_worker_does_not_overwrite_terminal_state(creator_factory, mocker):
    from dj.apps.exports.account_data import process_account_export_job

    owner = creator_factory()
    job = PublicationExportJob.objects.create(creator=owner, export_type=ExportType.ACCOUNT, status=ExportStatus.RUNNING)

    def cancelled(_user_id, archive_path):
        archive_path.write_bytes(b"archive")
        PublicationExportJob.objects.filter(pk=job.pk).update(status=ExportStatus.EXPIRED)
        return {"publication": {"complete": True, "warnings": []}}

    mocker.patch("dj.apps.exports.account_data.build_account_archive", cancelled)
    process_account_export_job(job)
    job.refresh_from_db()
    assert job.status == ExportStatus.EXPIRED
    assert not job.file_path


def test_creator_fields_have_explicit_export_or_exclusion(creator_factory):
    from dj.apps.exports.account_data import PROFILE_FIELDS, PROFILE_RELATIONS, PROFILE_EXCLUSIONS, _profile

    model_fields = {field.name for field in Creator._meta.get_fields() if field.concrete and (not field.auto_created or field.primary_key)}
    assert PROFILE_FIELDS.isdisjoint(PROFILE_EXCLUSIONS)
    assert model_fields == PROFILE_FIELDS | PROFILE_RELATIONS | set(PROFILE_EXCLUSIONS)
    assert all(PROFILE_EXCLUSIONS.values())
    output = _profile(creator_factory())
    renamed = {"member_price": "member_price_2z", "tuzis": "balance_2z", "total": "total_zec_equivalent"}
    assert set(output) == {renamed.get(name, name) for name in PROFILE_FIELDS}


def test_project_model_field_and_relation_census_stays_current():
    """Model, field, and relationship changes require an export inventory update."""
    from pathlib import Path
    from django.apps import apps

    expected = json.loads((Path(__file__).parent / "project_model_census.json").read_text())
    found = {}
    for model in apps.get_models():
        if not model.__module__.startswith("dj.apps."):
            continue
        found[model._meta.label] = {
            field.name: field.related_model._meta.label if field.related_model else None
            for field in model._meta.get_fields()
            if field.concrete and (not field.auto_created or field.primary_key)
        }
    assert found == {name: item["fields"] for name, item in expected.items()}
    assert all(item["ownership"] and item["treatment"] and "UNRESOLVED" not in item["ownership"] + item["treatment"] for item in expected.values())


def test_email_preferences_are_owner_scoped_without_confirmation_tokens(creator_factory):
    from dj.apps.emails.models import Email
    from dj.apps.exports.account_data import _email_rows

    owner, other = creator_factory(), creator_factory()
    for user, address, token in [(owner, "owner@example.test", "owner-secret"), (other, "other@example.test", "other-secret")]:
        Email.objects.create(user=user, email=address, token=token, expires_at=timezone.now() + timedelta(days=1), get_notifications=True)
    rows = list(_email_rows(owner.pk))
    assert len(rows) == 1
    assert rows[0]["email"] == "owner@example.test"
    assert rows[0]["get_notifications"] is True
    assert "secret" not in json.dumps(rows)
    assert "other@example.test" not in json.dumps(rows)


def test_zec_legacy_purchase_summary_is_owner_scoped_and_preserves_unknown_credit(creator_factory):
    from dj.apps.exports.account_data import _legacy_purchase_rows
    from dj.apps.tuzis.models import ZecCreditReceipt, ZecPendingNotice

    owner, other = creator_factory(), creator_factory()
    ZecCreditReceipt.objects.create(creator=owner, txid="private-owner", amount_zec=Decimal("1"), backfilled=True)
    ZecCreditReceipt.objects.create(creator=other, txid="private-other", amount_zec=Decimal("9"))
    ZecPendingNotice.objects.create(creator=owner, txid="private-pending", amount_zec=Decimal("2"), confirmations=1)
    rows = list(_legacy_purchase_rows(owner.pk))
    receipt = next(row for row in rows if row["kind"] == "zec_credit_receipt")
    assert receipt["backfilled"] is True and receipt["tuzis_credited"] is None
    assert len(rows) == 2
    assert "private-" not in json.dumps(rows)


@pytest.mark.django_db(transaction=True)
def test_real_archive_covers_owned_content_media_relationships_and_finance(creator_factory, tmp_path, settings):
    from dj.apps.economy.models import CreatorPayable, LegacyClaim
    from dj.apps.events.models import Event
    from dj.apps.exports.account_data import build_account_archive
    from dj.apps.g12f.models import CreatorFollow, CreatorBlock
    from dj.apps.openai.models import Personality
    from dj.apps.kyc.models import UserProfile, W9
    from dj.apps.social.models import SocialIdentity
    from dj.apps.storytime.models import Story, Page
    from dj.apps.uploads.models import GenericFile, ImageVariant

    settings.STORAGES = {**settings.STORAGES, "default": {"BACKEND": "django.core.files.storage.FileSystemStorage", "OPTIONS": {"location": str(tmp_path / "media")}}}
    owner = creator_factory(username="archive-owner")
    other = creator_factory(username="archive-other")
    upload = GenericFile.objects.create(owner=owner, title="mine", access="private", mime_type="image/png", file=ContentFile(b"owner-image", name="mine.png"))
    ImageVariant.objects.create(parent=upload, width=100, file=ContentFile(b"owner-variant", name="variant.webp"))
    GenericFile.objects.create(owner=other, title="foreign-upload", access="private", mime_type="image/png", file=ContentFile(b"foreign-image-secret", name="other.png"))
    missing = GenericFile.objects.create(owner=owner, title="missing", access="private", mime_type="image/png", file="missing.png")
    shared = GenericFile.objects.create(owner=owner, title="shared", access="private", mime_type="image/png", file=ContentFile(b"shared-private-secret", name="shared.png"))
    GenericFile.objects.create(owner=other, title="shared-other", access="private", mime_type="image/png", file=shared.file.name, legacy_shared_file=True)
    profile = UserProfile.objects.create(user=owner, is_us=True, is_individual=True, id_front=ContentFile(b"my-id-document", name="id.png"))
    UserProfile.objects.create(user=other, id_front=ContentFile(b"other-id-document-secret", name="other-id.png"))
    W9.objects.create(profile=profile, full_name="My legal name", tax_classification="individual", address="my address", city_state_zip="my city", ssn="123456789", file=ContentFile(b"my-tax-form", name="tax.pdf"))
    owner.avatar_image = upload
    owner.save(update_fields=["avatar_image"])
    story = Story.objects.create(creator=owner, title="My story")
    Page.objects.create(story=story, prompt="my prompt", content="my story content", order=0, image=upload)
    Story.objects.create(creator=other, title="other-story-secret")
    Personality.objects.create(creator=owner, display_name="My persona", system_message="my instructions")
    Personality.objects.create(creator=other, display_name="Other persona", system_message="other-persona-secret")
    CreatorFollow.objects.create(follower=owner, creator=other)
    CreatorBlock.objects.create(blocker=other, blocked=owner)
    Event.objects.create(receiving_user=owner, type="PAGE_UPDATE")
    Event.objects.create(receiving_user=other, type="PAGE_UPDATE")
    SocialIdentity.objects.create(creator=owner, provider="github", provider_uid="my-provider-id", handle="my-handle")
    SocialIdentity.objects.create(creator=other, provider="github", provider_uid="other-provider-secret")
    CreatorPayable.objects.create(creator=owner)
    CreatorPayable.objects.create(creator=other)
    LegacyClaim.objects.create(creator=owner, snapshot_key="owner-finance-secret", snapshot_at=timezone.now(), usage_snapshot_m2z=100, liability_nusd=50, evidence={"secret":"basis-secret"})
    LegacyClaim.objects.create(creator=other, snapshot_key="other-finance-secret", snapshot_at=timezone.now(), usage_snapshot_m2z=900, liability_nusd=999, evidence={"secret":"other-finance-secret"})
    path = tmp_path / "account.zip"
    metadata = build_account_archive(owner.pk, path)
    with zipfile.ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist() if name != "publications.zip"}
        serialized = b"\n".join(files.values())
        assert b"my story content" in serialized and b"my instructions" in serialized
        assert b"owner-image" in serialized and b"owner-variant" in serialized
        assert b"my-id-document" in serialized and b"my-tax-form" in serialized and b"123456789" in serialized
        assert b"my-provider-id" in serialized and b'"liability_nusd": 50' in serialized
        for secret in (b"foreign-image-secret", b"shared-private-secret", b"other-id-document-secret", b"other-story-secret", b"other-persona-secret", b"other-provider-secret", b"basis-secret", b"bank-secret", b"authorization-secret", b"verification-secret"):
            assert secret not in serialized
        entries = [json.loads(line) for line in files["uploads.jsonl"].splitlines()]
        assert any(entry["id"] == missing.pk and entry.get("warning") for entry in entries)
        assert any(entry["id"] == shared.pk and entry.get("warning") for entry in entries)
        assert any(entry["id"] == upload.pk and entry["archive_path"] for entry in entries)
        assert any("owned media files" in warning for warning in metadata["media_warnings"])
        assert json.loads(files["profile.json"])["avatar_upload_id"] == upload.pk
        assert b'"kind": "blocked"' not in files["relationships.jsonl"]


def test_email_fields_are_classified_against_model():
    from dj.apps.emails.models import Email
    from dj.apps.exports.account_data import EMAIL_FIELDS, EMAIL_EXCLUSIONS
    model_fields = {field.name for field in Email._meta.get_fields() if field.concrete and (not field.auto_created or field.primary_key)}
    assert EMAIL_FIELDS.isdisjoint(EMAIL_EXCLUSIONS)
    assert model_fields == EMAIL_FIELDS | set(EMAIL_EXCLUSIONS)


def test_media_shared_storage_check_covers_project_file_fields():
    from django.apps import apps
    from django.db.models import FileField

    actual = {(model._meta.label, field.name) for model in apps.get_models()
              if model.__module__.startswith("dj.apps.")
              for field in model._meta.local_fields if isinstance(field, FileField)}
    assert actual == {
        ("uploads.GenericFile", "file"), ("uploads.ImageVariant", "file"), ("uploads.Webp", "file"),
        ("kyc.UserProfile", "id_front"), ("kyc.UserProfile", "id_back"),
        ("kyc.UserProfile", "additional_document"), ("kyc.UserProfile", "live_photo"),
        ("kyc.W9", "file"), ("kyc.W8BEN", "file"), ("kyc.W8BENE", "file"),
    }


def test_composite_financial_rows_page_without_losing_records(creator_factory):
    from dj.apps.exports.account_owned import finance_rows
    from dj.apps.ledger.models import Account, LedgerSpendCap

    owner, other = creator_factory(), creator_factory()
    mine = Account.objects.create(owner=owner, key=f"user:{owner.pk}", kind="user", journal_only=False)
    theirs = Account.objects.create(owner=other, key=f"user:{other.pk}", kind="user", journal_only=False)
    LedgerSpendCap.objects.bulk_create([
        LedgerSpendCap(account=mine, app_id=uuid.UUID(int=i + 1), cap_m2z=i, period="month", markup_bps=0, grant_generation=1, updated_at=timezone.now())
        for i in range(251)
    ] + [LedgerSpendCap(account=theirs, app_id=uuid.uuid4(), cap_m2z=9999, period="month", markup_bps=0, grant_generation=1, updated_at=timezone.now())])
    caps = [row for row in finance_rows(owner.pk) if row["kind"] == "spend_cap"]
    assert len(caps) == 251
    assert {row["cap_m2z"] for row in caps} == set(range(251))
