"""Short-lived original-file capabilities with live OAuth revocation checks."""

from datetime import timedelta
import hashlib
from urllib.parse import quote, urlsplit

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.http import FileResponse, HttpResponse, JsonResponse
from django.utils import timezone
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_GET
from rest_framework.exceptions import APIException, PermissionDenied

from dj.apps.oidc.mcp import authorized_actor, mcp_resource, record_action
from dj.apps.oidc.models import AccessToken, MCPAccountGrant
from dj.apps.uploads.models import GenericFile

HEADER = "X-Free2Z-Download-Capability"
SALT = "free2z.mcp.original-download.v1"


def _file_digest(media):
    return hashlib.sha256(media.file.name.encode()).hexdigest()


def _attachment(response, filename):
    response["Content-Disposition"] = content_disposition_header(True, filename)
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


def _offload(prefix, key, filename, content_type, *, generation=None):
    response = HttpResponse(content_type=content_type)
    response["X-Accel-Redirect"] = prefix + quote(key, safe="/-_.~")
    if generation is not None:
        value = str(generation)
        if not value.isascii() or not value.isdigit():
            raise PermissionDenied("Invalid object generation.")
        response["X-Accel-Redirect"] += "?generation=" + value
    return _attachment(response, filename)


def _media_response(storage, name, filename):
    """Cloud bytes belong on the internal proxy, never a Django web worker."""
    from storages.backends.gcloud import GoogleCloudStorage

    if isinstance(storage, GoogleCloudStorage):
        from storages.utils import clean_name

        # Same storage-key normalization as GoogleCloudStorage._open, with
        # an explicit metadata deadline and no retry while occupying a web
        # worker. Neither object bytes nor django-storages' spool are opened.
        key = storage._normalize_name(clean_name(name))
        blob = storage.bucket.get_blob(key, timeout=5, retry=None)
        if blob is None or blob.generation is None:
            raise PermissionDenied("Object generation is unavailable.")
        # GCS can transcode encoded compressed formats even when the proxy
        # requests gzip. No exhaustive MIME taxonomy exists; require its
        # explicit raw-byte guarantee for every encoded object.
        encoding = (blob.content_encoding or "").strip()
        cache_control = blob.cache_control or ""
        cache_directives = {part.strip().lower() for part in cache_control.split(",")}
        # Quoted field lists can contain commas that imitate directives. Fail
        # closed rather than interpret a quoted value as a raw-byte guarantee.
        if encoding and (
            '"' in cache_control or "no-transform" not in cache_directives
        ):
            response = JsonResponse(
                {
                    "code": "original_encoding_unsupported",
                    "detail": "This file's storage encoding cannot be delivered unchanged. Encoded objects require unquoted stored Cache-Control directives including no-transform.",
                },
                status=409,
            )
            response["Cache-Control"] = "private, no-store"
            return response
        return _offload(
            "/_internal_mcp_media/",
            blob.name,
            filename,
            "application/octet-stream",
            generation=blob.generation,
        )
    return _attachment(
        FileResponse(storage.open(name, "rb"), content_type="application/octet-stream"),
        filename,
    )


def _export_response(storage, name, filename):
    from storages.backends.gcloud import GoogleCloudStorage

    if isinstance(storage, GoogleCloudStorage) or getattr(
        settings, "USE_X_ACCEL_REDIRECT", False
    ):
        # Same internal route and key contract as the native export endpoint.
        return _offload("/_internal_exports/", name, filename, "application/zip")
    return _attachment(
        FileResponse(storage.open(name, "rb"), content_type="application/zip"), filename
    )


def prepare(raw, account, original, upload_id):
    with authorized_actor(raw, account, ["mcp:media"]) as actor:
        media = GenericFile.objects.filter(pk=upload_id, owner=actor.user).first()
        if media is None:
            raise PermissionDenied("File is not owned by the selected account.")
        grant = MCPAccountGrant.objects.get(pk=actor.account_id)
        expires = min(timezone.now() + timedelta(seconds=120), actor.auth.row.expires)
        capability = signing.dumps(
            {
                "file": media.pk,
                "digest": _file_digest(media),
                "token": actor.auth.row.pk,
                "grant": str(actor.account_id),
                "generation": grant.generation,
                "expires": int(expires.timestamp()),
                "resource": mcp_resource(),
            },
            salt=SALT,
        )
        origin = urlsplit(mcp_resource())
        record_action(actor, "mcp_prepare_download", 200)
        return {
            "status": 200,
            "account": actor.user.username,
            "data": {
                "url": f"{origin.scheme}://{origin.netloc}/api/mcp/downloads/{media.pk}",
                "method": "GET",
                "headers": {HEADER: capability},
                "expires_at": expires.isoformat(),
                "instructions": "Stream the original file to a local file with your HTTP tool. Keep the capability header private; the URL alone is not authorized.",
            },
        }


@transaction.non_atomic_requests
@require_GET
def download_binary(request, upload_id):
    try:
        capability = request.headers.get(HEADER, "")
        if len(capability) > 2048:
            raise PermissionDenied("Invalid file capability.")
        payload = signing.loads(capability, salt=SALT, max_age=120)
        if payload.get("resource") != mcp_resource():
            raise PermissionDenied("Capability belongs to another resource.")
        if (
            payload["file"] != upload_id
            or payload["expires"] <= timezone.now().timestamp()
        ):
            raise PermissionDenied("Expired or mismatched file capability.")
        token = AccessToken.objects.filter(pk=payload["token"]).first()
        if token is None:
            raise PermissionDenied("The issuing credential is no longer available.")
        # The capability carries identifiers, never the OAuth token. Revalidate
        # the stored issuing credential and all connection/account lifecycles.
        with authorized_actor(token.token, payload["grant"], ["mcp:media"]) as actor:
            grant = MCPAccountGrant.objects.get(pk=actor.account_id)
            media = GenericFile.objects.filter(pk=upload_id, owner=actor.user).first()
            if (
                grant.generation != payload["generation"]
                or media is None
                or _file_digest(media) != payload["digest"]
            ):
                raise PermissionDenied("File or account authority changed.")
            filename = media.file.name.rsplit("/", 1)[-1]
            field = media.file
            record_action(actor, "download_file", 200)
        # Cloud metadata I/O and byte delivery happen outside account locks.
        return _media_response(field.storage, field.name, filename)
    except (signing.BadSignature, KeyError, TypeError, ValueError, APIException):
        response = JsonResponse(
            {"detail": "File capability is invalid, expired or revoked."}, status=403
        )
        response["Cache-Control"] = "no-store"
        return response


def prepare_export(raw, account, original, export_id):
    from dj.apps.exports.models import PublicationExportJob, ExportStatus

    with authorized_actor(raw, account, ["mcp:account", "mcp:media"]) as actor:
        job = PublicationExportJob.objects.filter(
            pk=export_id, creator=actor.user
        ).first()
        if (
            job is None
            or job.status != ExportStatus.READY
            or job.is_expired
            or not job.file_path
        ):
            raise PermissionDenied("Export is not owned, ready and unexpired.")
        grant = MCPAccountGrant.objects.get(pk=actor.account_id)
        expires = min(
            timezone.now() + timedelta(seconds=120),
            actor.auth.row.expires,
            job.expires_at,
        )
        capability = signing.dumps(
            {
                "export": str(job.pk),
                "digest": hashlib.sha256(job.file_path.encode()).hexdigest(),
                "token": actor.auth.row.pk,
                "grant": str(actor.account_id),
                "generation": grant.generation,
                "expires": int(expires.timestamp()),
                "resource": mcp_resource(),
            },
            salt=SALT + ".export",
        )
        origin = urlsplit(mcp_resource())
        record_action(actor, "publication_exports_download", 200)
        return {
            "status": 200,
            "account": actor.user.username,
            "data": {
                "url": f"{origin.scheme}://{origin.netloc}/api/mcp/exports/{job.pk}",
                "method": "GET",
                "headers": {HEADER: capability},
                "expires_at": expires.isoformat(),
            },
        }


@transaction.non_atomic_requests
@require_GET
def download_export(request, export_id):
    from dj.apps.exports.models import PublicationExportJob, ExportStatus
    from dj.apps.exports.storage import get_export_storage

    try:
        capability = request.headers.get(HEADER, "")
        if len(capability) > 2048:
            raise PermissionDenied("Invalid export capability.")
        payload = signing.loads(capability, salt=SALT + ".export", max_age=120)
        if payload.get("resource") != mcp_resource():
            raise PermissionDenied("Capability belongs to another resource.")
        if (
            payload["export"] != str(export_id)
            or payload["expires"] <= timezone.now().timestamp()
        ):
            raise PermissionDenied("Expired or mismatched export capability.")
        token = AccessToken.objects.filter(pk=payload["token"]).first()
        if token is None:
            raise PermissionDenied("The issuing credential is no longer available.")
        with authorized_actor(
            token.token, payload["grant"], ["mcp:account", "mcp:media"]
        ) as actor:
            grant = MCPAccountGrant.objects.get(pk=actor.account_id)
            job = PublicationExportJob.objects.filter(
                pk=export_id, creator=actor.user
            ).first()
            if (
                grant.generation != payload["generation"]
                or job is None
                or job.status != ExportStatus.READY
                or job.is_expired
                or not job.file_path
                or hashlib.sha256(job.file_path.encode()).hexdigest()
                != payload["digest"]
            ):
                raise PermissionDenied("Export or account authority changed.")
            storage_path, filename = job.file_path, job.file_name
            record_action(actor, "download_export", 200)
        return _export_response(
            get_export_storage(), storage_path, filename or "publication-export.zip"
        )
    except (signing.BadSignature, KeyError, TypeError, ValueError, APIException):
        response = JsonResponse(
            {"detail": "Export capability is invalid, expired or revoked."}, status=403
        )
        response["Cache-Control"] = "no-store"
        return response
