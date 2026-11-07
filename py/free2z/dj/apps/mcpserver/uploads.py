"""Prepared binary uploads without client files in model context or cookies."""
from __future__ import annotations

from datetime import timedelta
import hashlib
import re
import secrets
from tempfile import TemporaryFile
from urllib.parse import urlsplit
from uuid import UUID

from django.core.files.uploadedfile import UploadedFile
from django.db import transaction
from django.http import HttpResponse, JsonResponse, QueryDict
from django.utils import timezone
from django.utils.datastructures import MultiValueDict
from django.views.decorators.csrf import csrf_exempt
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

from .operations import PUBLISH, UPLOAD, _request, _result

CAPABILITY_HEADER = "X-Free2Z-Upload-Capability"
UPLOAD_PREFIX = "/api/mcp/uploads/"
CHUNK_BYTES = 64 * 1024


def prepare_upload(raw, account, original, *, filename, mime_type, size, sha256, access, title="", description=""):
    from dj.apps.oidc.mcp import authorized_actor, mcp_resource, record_action
    from dj.apps.oidc.models import MCPAccountGrant, MCPUploadIntent
    from dj.apps.uploads.limits import max_upload_bytes_for
    if not filename or filename in {".", ".."} or re.search(r"[\x00-\x1f\x7f/\\]", filename):
        raise ValidationError("Use a plain filename without path components.")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValidationError("Provide the file's lowercase SHA-256 digest.")
    if access not in {"public", "private", "members"}:
        raise ValidationError("Unsupported media access.")
    required = [UPLOAD, *([PUBLISH] if access == "public" else [])]
    with authorized_actor(raw, account, required) as actor:
        if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= max_upload_bytes_for(actor.user):
            raise ValidationError("The file exceeds this account's upload limit.")
        # Bound outstanding capabilities even for an already authorized client.
        if MCPUploadIntent.objects.filter(connection=actor.connection, consumed_at=None, expires_at__gt=timezone.now()).count() >= 20:
            raise ValidationError("Finish an existing upload or wait for its capability to expire.")
        expires = min(timezone.now() + timedelta(minutes=2), actor.auth.row.expires)
        capability = secrets.token_urlsafe(32)
        grant = MCPAccountGrant.objects.get(pk=actor.account_id)
        intent = MCPUploadIntent.objects.create(
            capability_hash=hashlib.sha256(capability.encode()).hexdigest(),
            connection=actor.connection, account_grant_id=actor.account_id,
            access_token=actor.auth.row, grant_generation=grant.generation,
            filename=filename, mime_type=mime_type, access=access,
            title=title, description=description, expected_bytes=size,
            expected_sha256=sha256, expires_at=expires,
        )
        origin = urlsplit(mcp_resource())
        record_action(actor, "prepare_upload", 201)
        return {
            "status": 201, "account": actor.user.username,
            "upload_id": str(intent.pk), "expires_at": expires.isoformat(),
            "url": f"{origin.scheme}://{origin.netloc}{UPLOAD_PREFIX}{intent.pk}",
            "method": "PUT", "headers": {CAPABILITY_HEADER: capability, "Content-Type": mime_type},
            "bytes": size, "sha256": sha256,
            "instructions": "Stream exactly these file bytes with your HTTP/file tool. Do not put the file in chat. The response contains the media ID; use get_upload_status if the response is lost.",
        }


def get_upload_status(raw, account, original, upload_id):
    from dj.apps.oidc.mcp import authorized_actor
    from dj.apps.oidc.models import MCPUploadIntent
    from dj.apps.uploads.serializers import GenericFileSerializer
    with authorized_actor(raw, account, [UPLOAD]) as actor:
        intent = MCPUploadIntent.objects.filter(pk=upload_id, connection=actor.connection, account_grant_id=actor.account_id).select_related("media").first()
        if intent is None:
            raise PermissionDenied("Upload is not available for this account and connection.")
        return {
            "status": 200, "account": actor.user.username, "upload_id": str(intent.pk),
            "state": "complete" if intent.consumed_at else "expired" if intent.expires_at <= timezone.now() else "pending",
            "media": GenericFileSerializer(intent.media).data if intent.media else None,
        }


def _expected_length(request, *, preflight=False):
    value = request.headers.get("X-Original-Content-Length", "") if preflight else request.META.get("CONTENT_LENGTH", "")
    if not value or not str(value).isdigit():
        raise ValidationError("A Content-Length matching the prepared upload is required.")
    return int(value)


def _check(actor, intent, length):
    from dj.apps.uploads.limits import max_upload_bytes_for
    if length != intent.expected_bytes or not 0 < length <= max_upload_bytes_for(actor.user):
        raise ValidationError("Upload length does not match the prepared file or account limit.")
    if intent.access == "public" and PUBLISH not in actor.scopes:
        raise PermissionDenied("Public uploads require mcp:publish.")


def _refused(exc):
    response = JsonResponse({"detail": exc.detail}, status=exc.status_code)
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@transaction.non_atomic_requests
def authorize_upload(request):
    """nginx auth_request check before buffering the binary body; consumes nothing."""
    from dj.apps.oidc.mcp import authorized_upload
    if request.method != "GET":
        return HttpResponse(status=405)
    try:
        original = request.headers.get("X-Original-URI", "")
        match = re.fullmatch(re.escape(UPLOAD_PREFIX) + r"([0-9a-f-]{36})", original)
        if match is None:
            raise PermissionDenied("Invalid prepared upload path.")
        upload_id = UUID(match.group(1))
        with authorized_upload(upload_id, request.headers.get(CAPABILITY_HEADER, "")) as (actor, intent):
            _check(actor, intent, _expected_length(request, preflight=True))
        return HttpResponse(status=204)
    except ValueError:
        return HttpResponse(status=403)
    except APIException as exc:
        # nginx auth_request only understands 2xx,401,403. Malformed length is
        # an admission refusal, never a 400 that nginx converts into a 500.
        response = _refused(exc)
        response.status_code = 401 if exc.status_code == 401 else 403
        return response


@csrf_exempt
@transaction.non_atomic_requests
def upload_binary(request, upload_id):
    from dj.apps.oidc.mcp import authorized_upload, record_action
    from dj.apps.uploads.serializers import GenericFileSerializer
    from dj.apps.uploads.views import single_public_upload_handle
    if request.method != "PUT":
        return HttpResponse(status=405)
    capability = request.headers.get(CAPABILITY_HEADER, "")
    try:
        length = _expected_length(request)
        with authorized_upload(upload_id, capability) as (actor, intent):
            _check(actor, intent, length)
            if intent.consumed_at:
                return JsonResponse({"upload_id": str(intent.pk), "replayed": True, "media": GenericFileSerializer(intent.media).data if intent.media else None})
            digest_expected = intent.expected_sha256
            mime_type = intent.mime_type
        if request.content_type != mime_type:
            raise ValidationError("Content-Type must match the prepared upload.")
        # No account/transaction lock while consuming bytes. nginx performs
        # admission and bounded spooling before this handler; this bound also
        # protects direct application requests and dishonest Content-Length.
        with TemporaryFile() as spool:
            digest = hashlib.sha256()
            received = 0
            while chunk := request.read(min(CHUNK_BYTES, length - received + 1)):
                received += len(chunk)
                if received > length:
                    raise ValidationError("Upload exceeds the prepared size.")
                digest.update(chunk)
                spool.write(chunk)
            if received != length or not secrets.compare_digest(digest.hexdigest(), digest_expected):
                raise ValidationError("Uploaded bytes do not match the prepared size and SHA-256.")
            spool.seek(0)
            # Token, grants, epochs, capability, and intent are checked again
            # after transfer; revocation during transfer prevents file creation.
            with authorized_upload(upload_id, capability) as (actor, intent):
                _check(actor, intent, length)
                if intent.consumed_at:
                    return JsonResponse({"upload_id": str(intent.pk), "replayed": True, "media": GenericFileSerializer(intent.media).data if intent.media else None})
                native = _request(actor, request, "POST", "/uploads/single-public")
                native._post = QueryDict(mutable=True)
                native._post.update({"title": intent.title, "description": intent.description, "access": intent.access})
                native._files = MultiValueDict({"file": [UploadedFile(spool, intent.filename, intent.mime_type, size=length)]})
                response = single_public_upload_handle(native)
                result = _result(response)
                record_action(actor, "upload_file", response.status_code)
                if response.status_code != 201:
                    return response
                intent.media_id = result["data"]["id"]
                intent.consumed_at = timezone.now()
                intent.save(update_fields=["media", "consumed_at"])
                return JsonResponse({"upload_id": str(intent.pk), "replayed": False, "media": result["data"]}, status=201)
    except APIException as exc:
        return _refused(exc)
