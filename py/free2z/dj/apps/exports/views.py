import datetime
import logging
from urllib.parse import quote

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.http import FileResponse, Http404, HttpResponse
from django.http.response import content_disposition_header
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ExportStatus, PublicationExportJob
from .serializers import (
    PublicationExportErrorSerializer,
    PublicationExportJobSerializer,
)
from .storage import get_export_storage
from .tasks import export_publication_task

logger = logging.getLogger(__name__)

EXPORT_RATE_LIMIT_PER_HOUR = getattr(settings, 'EXPORT_RATE_LIMIT_PER_HOUR', 10)

# Documented 32-bit signed int key for PostgreSQL pg_advisory_xact_lock
# (zlib.crc32(b"publication_export_admission") & 0x7FFFFFFF = 1517035)
EXPORT_ADMISSION_LOCK_KEY = 1517035


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
            PublicationExportJob.objects.filter(creator=request.user)
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
                status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
            )
            .order_by('-created_at')
            .first()
        )
        if active_job:
            serializer = PublicationExportJobSerializer(active_job)
            return Response(serializer.data, status=status.HTTP_200_OK)

        # 2. Rate limiting: maximum exports requested in the last hour
        one_hour_ago = now - datetime.timedelta(hours=1)
        recent_count = PublicationExportJob.objects.filter(
            creator=user,
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
                        status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING],
                    )
                    .order_by('-created_at')
                    .first()
                )
                if active_job:
                    serializer = PublicationExportJobSerializer(active_job)
                    return Response(serializer.data, status=status.HTTP_200_OK)

                # Check global active count
                global_active_count = PublicationExportJob.objects.filter(
                    status__in=[ExportStatus.QUEUED, ExportStatus.RUNNING]
                ).count()
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
            job = PublicationExportJob.objects.get(id=id, creator=request.user)
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
            job = PublicationExportJob.objects.get(id=id, creator=request.user)
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
