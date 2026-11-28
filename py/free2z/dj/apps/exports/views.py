import datetime
import hashlib
import logging
from urllib.parse import quote

from django.core import signing
from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.http import FileResponse, Http404, HttpResponse
from django.http.response import content_disposition_header
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from dj.apps.identity.auth_context import require_recent_auth

from .models import ExportStatus, ExportType, PublicationExportJob
from . import rollout
from .serializers import (
    PublicationExportErrorSerializer,
    PublicationExportJobSerializer,
)
from .storage import get_export_storage
from .tasks import export_account_data_task, export_publication_task

logger = logging.getLogger(__name__)

EXPORT_RATE_LIMIT_PER_HOUR = getattr(settings, 'EXPORT_RATE_LIMIT_PER_HOUR', 10)

# Documented 32-bit signed int key for PostgreSQL pg_advisory_xact_lock
# (zlib.crc32(b"publication_export_admission") & 0x7FFFFFFF = 1517035)
EXPORT_ADMISSION_LOCK_KEY = 1517035
ACCOUNT_EXPORT_SIGNING_SALT = "exports.account-data-download.v1"
ACCOUNT_EXPORT_LINK_MAX_AGE_SECONDS = 15 * 60
class AccountExportSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    status = serializers.ChoiceField(choices=ExportStatus.choices)
    error_message = serializers.CharField(allow_blank=True)
    complete = serializers.BooleanField()
    warnings = serializers.ListField(child=serializers.CharField())
    file_name = serializers.CharField(allow_blank=True)
    file_size = serializers.IntegerField(allow_null=True)
    created_at = serializers.DateTimeField()
    completed_at = serializers.DateTimeField(allow_null=True)
    expires_at = serializers.DateTimeField(allow_null=True)
    download_url = serializers.CharField(
        allow_null=True,
        help_text="Authenticated download endpoint; available for 15 minutes after status is read.",
    )
    download_token = serializers.CharField(
        allow_null=True,
        help_text=(
            "Timestamp-signed for this account, session and job, valid for 15 minutes. Send it in "
            "X-Account-Export-Signature rather than putting it in the URL."
        ),
    )


class AccountExportLatestSerializer(serializers.Serializer):
    export = AccountExportSerializer(allow_null=True)


def _account_export_payload(job, request):
    token = None
    download_url = None
    effective_status = job.status
    if effective_status == ExportStatus.READY and job.is_expired:
        effective_status = ExportStatus.EXPIRED
    if effective_status == ExportStatus.READY and request.session.session_key:
        token = signing.dumps(
            {"job": str(job.pk), "user": str(job.creator_id), "session": hashlib.sha256(request.session.session_key.encode()).hexdigest()},
            salt=ACCOUNT_EXPORT_SIGNING_SALT,
            compress=True,
        )
        # The signature is sent in a request header by the browser UI. Keeping
        # it out of the URL prevents access-log and referrer disclosure.
        download_url = f"/api/exports/account/{job.id}/download/"
    return AccountExportSerializer({
        "id": job.id,
        "status": effective_status,
        "error_message": job.error_message,
        "complete": job.complete,
        "warnings": job.warnings,
        "file_name": job.file_name,
        "file_size": job.file_size,
        "created_at": job.created_at,
        "completed_at": job.completed_at,
        "expires_at": job.expires_at,
        "download_url": download_url,
        "download_token": token,
    }).data


def _account_export_response(data, response_status, headers=None):
    response = Response(data, status=response_status)
    response["Cache-Control"] = "private, no-store"
    response["Referrer-Policy"] = "no-referrer"
    for name, value in (headers or {}).items():
        response[name] = value
    return response


def _take_export_admission_lock() -> None:
    """Acquire a transaction-scoped advisory lock for global export admission on PostgreSQL."""
    if connection.vendor != "postgresql":
        return
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [EXPORT_ADMISSION_LOCK_KEY])


class PublicationExportListCreateView(APIView):
    """Manage publication export jobs for the authenticated creator."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='publication_exports_list',
        tags=['Exports'],
        responses={
            200: PublicationExportJobSerializer,
            404: PublicationExportErrorSerializer,
        },
        summary="Retrieve the creator's current or latest publication export job.",
        description="Returns the active unexpired or most recent publication export job for the authenticated creator.",
    )
    def get(self, request):
        job = (
            PublicationExportJob.objects.filter(creator=request.user, export_type=ExportType.PUBLICATIONS)
            .order_by('-created_at')
            .first()
        )
        if not job:
            raise Http404("No publication export job found.")

        # Update expired state if needed
        if job.status == ExportStatus.READY and job.is_expired:
            job.status = ExportStatus.EXPIRED
            job.save(update_fields=['status', 'updated_at'])

        serializer = PublicationExportJobSerializer(job)
        return Response(serializer.data)

    @extend_schema(
        operation_id='publication_exports_create',
        tags=['Exports'],
        request=None,
        responses={
            201: OpenApiResponse(
                response=PublicationExportJobSerializer,
                description="Export job created and queued.",
            ),
            200: OpenApiResponse(
                response=PublicationExportJobSerializer,
                description="Active export job already exists and is reused.",
            ),
            429: OpenApiResponse(
                response=PublicationExportErrorSerializer,
                description="Export request rate limit exceeded.",
            ),
            503: OpenApiResponse(
                response=PublicationExportErrorSerializer,
                description="Publication export queue is currently at capacity.",
            ),
            500: OpenApiResponse(
                response=PublicationExportErrorSerializer,
                description="Failed to enqueue background export task.",
            ),
        },
        summary="Request a new publication export archive.",
        description="Creates a publication export job for the authenticated creator, or returns the existing active in-flight job if already queued or running.",
    )
    def post(self, request):
        user = request.user
        now = timezone.now()

        # 1. Quick pre-check for existing active job (queued or running)
        active_job = (
            PublicationExportJob.objects.filter(
                creator=user,
                export_type=ExportType.PUBLICATIONS,
                status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
            )
            .order_by('-created_at')
            .first()
        )
        if active_job:
            serializer = PublicationExportJobSerializer(active_job)
            return Response(serializer.data, status=status.HTTP_200_OK)

        if rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED and PublicationExportJob.objects.filter(
            creator=user,
            export_type=ExportType.ACCOUNT,
            status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
        ).exists():
            return Response({"detail": "Another export for this account is already in progress."}, status=status.HTTP_409_CONFLICT)

        # 2. Rate limiting: maximum exports requested in the last hour
        one_hour_ago = now - datetime.timedelta(hours=1)
        recent_count = PublicationExportJob.objects.filter(
            creator=user,
            export_type=ExportType.PUBLICATIONS,
            created_at__gte=one_hour_ago,
        ).count()
        if recent_count >= EXPORT_RATE_LIMIT_PER_HOUR:
            return Response(
                {
                    "detail": "Export rate limit exceeded. Please wait before requesting another export archive."
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
                headers={"Retry-After": "3600"},
            )

        max_active_jobs = getattr(settings, "EXPORT_MAX_ACTIVE_JOBS", 4)
        delay_seconds = getattr(settings, "EXPORT_TASK_ROLLOUT_DELAY_SECONDS", 300)
        schedule_time = now + datetime.timedelta(seconds=delay_seconds) if delay_seconds > 0 else None

        timestamp_str = now.strftime('%Y%m%dT%H%M%SZ')
        stable_filename = f"free2z-{user.username}-articles-{timestamp_str}.zip"

        try:
            with transaction.atomic():
                _take_export_admission_lock()

                # Re-check requesting creator's active job under the lock
                active_job = (
                    PublicationExportJob.objects.filter(
                        creator=user,
                        export_type=ExportType.PUBLICATIONS,
                        status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
                    )
                    .order_by('-created_at')
                    .first()
                )
                if active_job:
                    serializer = PublicationExportJobSerializer(active_job)
                    return Response(serializer.data, status=status.HTTP_200_OK)

                if rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED and PublicationExportJob.objects.filter(
                    creator=user,
                    export_type=ExportType.ACCOUNT,
                    status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
                ).exists():
                    return Response({"detail": "Another export for this account is already in progress."}, status=status.HTTP_409_CONFLICT)

                # Check global active count
                globally_active_jobs = PublicationExportJob.objects.filter(
                    status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING]
                )
                # While account admission is fenced off, held account jobs are
                # intentionally not consumed or expired. Keep them from using
                # publication queue capacity during that recovery hold.
                if not rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED:
                    globally_active_jobs = globally_active_jobs.filter(
                        export_type=ExportType.PUBLICATIONS
                    )
                global_active_count = globally_active_jobs.count()
                if global_active_count >= max_active_jobs:
                    return Response(
                        {
                            "detail": "Publication export queue is currently at capacity. Please try again later."
                        },
                        status=status.HTTP_503_SERVICE_UNAVAILABLE,
                        headers={"Retry-After": "900"},
                    )

                job = PublicationExportJob.objects.create(
                    creator=user,
                    export_type=ExportType.PUBLICATIONS,
                    status=ExportStatus.QUEUED,
                    file_name=stable_filename,
                    expires_at=now + datetime.timedelta(hours=24),
                )
                if schedule_time:
                    export_publication_task.configure(schedule_at=schedule_time).defer(job_id=str(job.id))
                else:
                    export_publication_task.defer(job_id=str(job.id))
        except IntegrityError:
            # Concurrent creation race - retrieve the active job
            active_job = (
                PublicationExportJob.objects.filter(
                    creator=user,
                    export_type=ExportType.PUBLICATIONS,
                    status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
                )
                .order_by('-created_at')
                .first()
            )
            if active_job:
                serializer = PublicationExportJobSerializer(active_job)
                return Response(serializer.data, status=status.HTTP_200_OK)
            logger.warning("IntegrityError on export job creation but no concurrent active job found for %s", user.username)
            return Response(
                {"detail": "Failed to enqueue background export task. Please try again later."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        except Exception as e:
            logger.exception("Failed to create and defer publication export job: %s", e)
            return Response(
                {"detail": "Failed to enqueue background export task. Please try again later."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        serializer = PublicationExportJobSerializer(job)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class PublicationExportDetailView(APIView):
    """Retrieve status and details of a specific publication export job."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='publication_exports_retrieve',
        tags=['Exports'],
        responses={
            200: PublicationExportJobSerializer,
            404: PublicationExportErrorSerializer,
        },
        summary="Retrieve publication export job status.",
        description="Returns the current status, warnings, and metadata for the specified export job. Reveals nothing to cross-users.",
    )
    def get(self, request, id):
        try:
            job = PublicationExportJob.objects.get(id=id, creator=request.user, export_type=ExportType.PUBLICATIONS)
        except PublicationExportJob.DoesNotExist:
            raise Http404("Publication export job not found.")

        # Update expired status if past expiry
        if job.status == ExportStatus.READY and job.is_expired:
            job.status = ExportStatus.EXPIRED
            job.save(update_fields=['status', 'updated_at'])

        serializer = PublicationExportJobSerializer(job)
        return Response(serializer.data)


class PublicationExportDownloadView(APIView):
    """Authorized streaming download endpoint for publication export archives."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id='publication_exports_download',
        tags=['Exports'],
        responses={
            200: OpenApiResponse(
                description="Binary ZIP archive download via attachment or X-Accel-Redirect offload.",
                response=bytes,
            ),
            404: PublicationExportErrorSerializer,
            410: PublicationExportErrorSerializer,
        },
        summary="Download publication export archive ZIP.",
        description="Streams or offloads the private publication ZIP archive with Content-Disposition attachment. Only available to the owning creator before expiry.",
    )
    def get(self, request, id):
        try:
            job = PublicationExportJob.objects.get(id=id, creator=request.user, export_type=ExportType.PUBLICATIONS)
        except PublicationExportJob.DoesNotExist:
            raise Http404("Publication export job not found.")

        if job.status != ExportStatus.READY or job.is_expired:
            return Response(
                {
                    "detail": "Export archive has expired or is not ready for download."
                },
                status=status.HTTP_410_GONE,
            )

        if not job.file_path:
            job.status = ExportStatus.EXPIRED
            job.save(update_fields=['status', 'updated_at'])
            return Response(
                {"detail": "Export archive is no longer available in storage."},
                status=status.HTTP_410_GONE,
            )

        storage = get_export_storage()
        storage_backend_path = getattr(settings, "STORAGES", {}).get("exports", {}).get("BACKEND", "")
        is_gcs = "GoogleCloudStorage" in storage_backend_path or "gcloud" in storage_backend_path
        use_x_accel = is_gcs or getattr(settings, "USE_X_ACCEL_REDIRECT", False)

        # In production with GCS storage (or when USE_X_ACCEL_REDIRECT is set), offload delivery to nginx + gcsproxy
        if use_x_accel:
            response = HttpResponse(status=status.HTTP_200_OK, content_type="application/zip")
            quoted_path = quote(job.file_path, safe="/-_.~")
            response["X-Accel-Redirect"] = f"/_internal_exports/{quoted_path}"
            cd_header = content_disposition_header(as_attachment=True, filename=job.file_name or "publication-export.zip")
            if cd_header:
                response["Content-Disposition"] = cd_header
            if job.file_size:
                response["Content-Length"] = str(job.file_size)
            response["Cache-Control"] = "private, no-store"
            return response

        # Local / test FileSystemStorage fallback
        if not storage.exists(job.file_path):
            job.status = ExportStatus.EXPIRED
            job.file_path = ""
            job.save(update_fields=['status', 'file_path', 'updated_at'])
            return Response(
                {"detail": "Export archive is no longer available in storage."},
                status=status.HTTP_410_GONE,
            )

        file_obj = storage.open(job.file_path, 'rb')
        response = FileResponse(
            file_obj,
            as_attachment=True,
            filename=job.file_name,
            content_type='application/zip',
        )
        response['Cache-Control'] = 'private, no-store'
        return response


class AccountExportCreateView(APIView):
    """Queue a full account archive for the signed-in account."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "account-export-create"

    @extend_schema(
        operation_id="account_data_export_create",
        tags=["Exports"],
        request=None,
        responses={
            201: AccountExportSerializer,
            200: AccountExportSerializer,
            429: OpenApiResponse(description="Export request limit exceeded."),
            401: OpenApiResponse(description="A recent sign-in is required."),
            503: OpenApiResponse(description="Account export admission is not enabled."),
        },
        summary="Request an account data archive",
        description="Queues a private ZIP archive containing the account owner's profile, publication export, comments, ledger history, purchases, and connected app grants. A timestamp-signed in-session download token expires after 15 minutes; the archive expires after 24 hours.",
    )
    def post(self, request):
        require_recent_auth(request, detail="Sign in again before exporting your account data.")
        if not rollout.ACCOUNT_EXPORT_ADMISSION_ENABLED:
            return _account_export_response(
                {"detail": "Account exports are not available yet."},
                status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        user = request.user
        now = timezone.now()
        active = PublicationExportJob.objects.filter(
            creator=user,
            export_type=ExportType.ACCOUNT,
            status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
        ).order_by("-created_at").first()
        if active:
            return _account_export_response(_account_export_payload(active, request), status.HTTP_200_OK)
        if PublicationExportJob.objects.filter(
            creator=user, status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING]
        ).exists():
            return _account_export_response({"detail": "Another export for this account is already in progress."}, status.HTTP_409_CONFLICT)

        hour_ago = now - datetime.timedelta(hours=1)
        if PublicationExportJob.objects.filter(
            creator=user,
            export_type=ExportType.ACCOUNT,
            created_at__gte=hour_ago,
        ).count() >= getattr(settings, "ACCOUNT_EXPORT_RATE_LIMIT_PER_HOUR", 2):
            return _account_export_response(
                {"detail": "Account export request limit reached. Please try again later."},
                status.HTTP_429_TOO_MANY_REQUESTS,
                {"Retry-After": "3600"},
            )

        delay_seconds = getattr(settings, "EXPORT_TASK_ROLLOUT_DELAY_SECONDS", 300)
        schedule_time = now + datetime.timedelta(seconds=delay_seconds) if delay_seconds > 0 else None
        timestamp = now.strftime("%Y%m%dT%H%M%SZ")
        try:
            with transaction.atomic():
                _take_export_admission_lock()
                active = PublicationExportJob.objects.filter(
                    creator=user,
                    export_type=ExportType.ACCOUNT,
                    status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
                ).order_by("-created_at").first()
                if active:
                    return _account_export_response(_account_export_payload(active, request), status.HTTP_200_OK)
                if PublicationExportJob.objects.filter(
                    creator=user, status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING]
                ).exists():
                    return _account_export_response({"detail": "Another export for this account is already in progress."}, status.HTTP_409_CONFLICT)
                if PublicationExportJob.objects.filter(
                    creator=user,
                    export_type=ExportType.ACCOUNT,
                    created_at__gte=hour_ago,
                ).count() >= getattr(settings, "ACCOUNT_EXPORT_RATE_LIMIT_PER_HOUR", 2):
                    return _account_export_response(
                        {"detail": "Account export request limit reached. Please try again later."},
                        status.HTTP_429_TOO_MANY_REQUESTS,
                        {"Retry-After": "3600"},
                    )
                max_active = getattr(settings, "EXPORT_MAX_ACTIVE_JOBS", 4)
                if PublicationExportJob.objects.filter(status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING]).count() >= max_active:
                    return _account_export_response(
                        {"detail": "The export queue is busy. Please try again later."},
                        status.HTTP_503_SERVICE_UNAVAILABLE,
                        {"Retry-After": "900"},
                    )
                job = PublicationExportJob.objects.create(
                    creator=user,
                    export_type=ExportType.ACCOUNT,
                    status=ExportStatus.QUEUED,
                    file_name=f"free2z-account-data-{timestamp}.zip",
                    expires_at=now + datetime.timedelta(hours=24),
                )
                if schedule_time:
                    export_account_data_task.configure(schedule_at=schedule_time).defer(job_id=str(job.id))
                else:
                    export_account_data_task.defer(job_id=str(job.id))
        except IntegrityError:
            active = PublicationExportJob.objects.filter(
                creator=user,
                export_type=ExportType.ACCOUNT,
                status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
            ).order_by("-created_at").first()
            if active:
                return _account_export_response(_account_export_payload(active, request), status.HTTP_200_OK)
            raise
        except Exception:
            logger.exception("Failed to queue account export for user %s", user.pk)
            return _account_export_response({"detail": "Could not request an account export. Please try again."}, status.HTTP_500_INTERNAL_SERVER_ERROR)
        return _account_export_response(_account_export_payload(job, request), status.HTTP_201_CREATED)


class AccountExportLatestView(APIView):
    """Restore the signed-in account's latest export after leaving the page."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="account_data_export_latest",
        tags=["Exports"],
        responses={200: AccountExportLatestSerializer},
        summary="Retrieve the latest account data archive status",
    )
    def get(self, request):
        job = PublicationExportJob.objects.filter(
            creator=request.user,
            export_type=ExportType.ACCOUNT,
        ).order_by("-created_at").first()
        response = Response({"export": _account_export_payload(job, request) if job else None})
        response["Cache-Control"] = "private, no-store"
        response["Referrer-Policy"] = "no-referrer"
        return response


class AccountExportDetailView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(operation_id="account_data_export_retrieve", tags=["Exports"], responses={200: AccountExportSerializer, 404: PublicationExportErrorSerializer}, summary="Check account export status")
    def get(self, request, id):
        try:
            job = PublicationExportJob.objects.get(id=id, creator=request.user, export_type=ExportType.ACCOUNT)
        except PublicationExportJob.DoesNotExist:
            raise Http404("Account export not found.")
        response = Response(_account_export_payload(job, request))
        response["Cache-Control"] = "private, no-store"
        response["Referrer-Policy"] = "no-referrer"
        return response


class AccountExportDownloadView(APIView):
    """Authenticated, account-bound download of a signed, short-lived link."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "account-export-download"

    @extend_schema(
        operation_id="account_data_export_download",
        tags=["Exports"],
        parameters=[OpenApiParameter(
            name="X-Account-Export-Signature",
            type=str,
            location=OpenApiParameter.HEADER,
            required=True,
            description="The account-bound, timestamp-signed download token returned by the status endpoint.",
        )],
        responses={(200, "application/zip"): OpenApiResponse(response=OpenApiTypes.BINARY, description="Private ZIP archive."), 404: PublicationExportErrorSerializer, 410: PublicationExportErrorSerializer},
        summary="Download the account data archive",
        description="Streams the private ZIP only to its owning, active account after recent authentication. The signed token expires after 15 minutes.",
    )
    def get(self, request, id):
        from dj.apps.g12f.models import Creator

        try:
            job = PublicationExportJob.objects.get(id=id, creator=request.user, export_type=ExportType.ACCOUNT)
        except PublicationExportJob.DoesNotExist:
            raise Http404("Account export not found.")
        require_recent_auth(request, detail="Sign in again before downloading your account data.")
        if not Creator.objects.filter(pk=request.user.pk, is_active=True, deleted_at__isnull=True, deletion_requested_at__isnull=True).exists():
            raise Http404("Account export not found.")
        token = request.headers.get("X-Account-Export-Signature", "")
        try:
            payload = signing.loads(token, salt=ACCOUNT_EXPORT_SIGNING_SALT, max_age=ACCOUNT_EXPORT_LINK_MAX_AGE_SECONDS)
        except signing.BadSignature:
            raise Http404("Account export link is invalid or expired.") from None
        if not request.session.session_key or payload != {"job": str(job.pk), "user": str(request.user.pk), "session": hashlib.sha256(request.session.session_key.encode()).hexdigest()}:
            raise Http404("Account export link is invalid or expired.")
        if job.status != ExportStatus.READY or job.is_expired or not job.file_path:
            return Response({"detail": "Account export has expired or is not ready."}, status=status.HTTP_410_GONE)

        storage = get_export_storage()
        if not storage.exists(job.file_path):
            return Response({"detail": "Account export is no longer available."}, status=status.HTTP_410_GONE)
        storage_backend_path = getattr(settings, "STORAGES", {}).get("exports", {}).get("BACKEND", "")
        if "GoogleCloudStorage" in storage_backend_path or getattr(settings, "USE_X_ACCEL_REDIRECT", False):
            response = HttpResponse(status=status.HTTP_200_OK, content_type="application/zip")
            response["X-Accel-Redirect"] = f"/_internal_exports/{quote(job.file_path)}"
            response["Content-Disposition"] = content_disposition_header(
                as_attachment=True,
                filename=job.file_name or "free2z-account-data.zip",
            )
            response["Content-Length"] = str(job.file_size)
            response["Cache-Control"] = "private, no-store"
            response["Referrer-Policy"] = "no-referrer"
            response["X-Content-Type-Options"] = "nosniff"
            return response
        file_obj = storage.open(job.file_path, "rb")
        response = FileResponse(file_obj, as_attachment=True, filename=job.file_name or "free2z-account-data.zip", content_type="application/zip")
        response["Cache-Control"] = "private, no-store"
        response["Referrer-Policy"] = "no-referrer"
        response["X-Content-Type-Options"] = "nosniff"
        return response
