"""Short-lived original-file capabilities with live OAuth revocation checks."""

from datetime import timedelta
import hashlib
from urllib.parse import urlsplit

from django.core import signing
from django.http import FileResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_GET
from rest_framework.exceptions import APIException, PermissionDenied

from dj.apps.oidc.mcp import authorized_actor, mcp_resource, record_action
from dj.apps.oidc.models import AccessToken, MCPAccountGrant
from dj.apps.uploads.models import GenericFile

HEADER = "X-Free2Z-Download-Capability"
SALT = "free2z.mcp.original-download.v1"


def _file_digest(media):
    return hashlib.sha256(media.file.name.encode()).hexdigest()


def _open_stream(storage, name):
    """Use bounded ranged GCS reads, not django-storages' whole-file spool."""
    from storages.backends.gcloud import GoogleCloudFile

    handle = storage.open(name, "rb")
    if isinstance(handle, GoogleCloudFile):
        try:
            # GoogleCloudStorage._open uses get_blob (metadata only). Resolve
            # generation explicitly if a backend wrapper omitted it, so all
            # ranged reads/retries target one immutable object version.
            blob = handle.blob
            if blob.generation is None:
                blob.reload()
            if blob.generation is None:
                raise FileNotFoundError("Object generation is unavailable.")
            # Preserve stored bytes and Range semantics even when the object
            # carries Content-Encoding:gzip; transparent transcoding can
            # otherwise return a full decompressed object for a ranged read.
            return blob.open("rb", chunk_size=256 * 1024, raw_download=True)
        finally:
            handle.close()
    return handle


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


@require_GET
def download_binary(request, upload_id):
    handle = None
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
        # Opening cloud storage and streaming must not hold account locks.
        handle = _open_stream(field.storage, field.name)
        response = FileResponse(
            handle,
            as_attachment=True,
            filename=filename,
            content_type="application/octet-stream",
        )
        response["Cache-Control"] = "private, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response
    except (signing.BadSignature, KeyError, TypeError, ValueError, APIException):
        if handle:
            handle.close()
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
        response = FileResponse(
            _open_stream(get_export_storage(), storage_path),
            as_attachment=True,
            filename=filename or "publication-export.zip",
            content_type="application/zip",
        )
        response["Cache-Control"] = "private, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response
    except (signing.BadSignature, KeyError, TypeError, ValueError, APIException):
        response = JsonResponse(
            {"detail": "Export capability is invalid, expired or revoked."}, status=403
        )
        response["Cache-Control"] = "no-store"
        return response
