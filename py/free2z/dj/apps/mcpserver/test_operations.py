"""Real OAuth, MCP wire, native page writes and prepared media transfers."""
import hashlib
from io import BytesIO
import json
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from PIL import Image
from rest_framework.test import APIClient

from dj.apps.g12f.models import zPage
from dj.apps.oidc.models import MCPAccountGrant, MCPActionAudit, MCPUploadIntent
from dj.apps.oidc.tests.test_mcp_connections import issue, link
from dj.apps.uploads.models import GenericFile

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _hosted_settings(settings, tmp_path):
    settings.OIDC_ISSUER = "https://testserver"
    settings.STORAGES = {**settings.STORAGES, "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"}}
    settings.MEDIA_ROOT = str(tmp_path)


def tool(token, name, args, *, browser_user=None):
    client = APIClient()
    if browser_user:
        client.force_login(browser_user)
    response = client.post("/api/mcp", {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args},
    }, format="json", HTTP_AUTHORIZATION=f"Bearer {token}", HTTP_MCP_PROTOCOL_VERSION="2025-11-25", HTTP_ACCEPT="application/json, text/event-stream", secure=True)
    assert response.status_code == 200, response.content
    result = response.json()["result"]
    return result, json.loads(result["content"][0]["text"])


def draft(token, account, *, key=None, browser_user=None):
    return tool(token, "free2z_create_draft", {
        "account": account, "fields": {"title": "MCP integration draft", "content": "A complete paragraph."},
        "idempotency_key": str(key or uuid4()),
    }, browser_user=browser_user)


def test_selected_account_draft_idempotency_etag_and_unknown_fields(signed_in, user, creator_factory):
    _, _, tokens = issue(signed_in, user)
    raw = tokens["access_token"]
    target = creator_factory(username="baz")
    browser = creator_factory(username="foobar")
    linked, _ = link(raw, target)
    key = uuid4()
    result, created = draft(raw, "baz", key=key, browser_user=browser)
    assert not result["isError"] and created["status"] == 201, created
    page_id = created["data"]["free2zaddr"]
    page = zPage.objects.get(free2zaddr=page_id)
    assert page.creator_id == target.pk and not page.is_published
    assert not zPage.objects.filter(creator=browser).exists()
    _, replay = draft(raw, linked["id"], key=key)
    assert replay["data"]["free2zaddr"] == page_id
    assert zPage.objects.filter(creator=target).count() == 1
    _, updated = tool(raw, "free2z_update_page", {
        "account": "baz", "page_id": page_id, "changes": {"content": "A replacement paragraph."}, "if_match": created["headers"]["etag"],
    })
    assert updated["status"] == 200, updated
    _, stale = tool(raw, "free2z_update_page", {
        "account": "baz", "page_id": page_id, "changes": {"content": "Stale edit."}, "if_match": created["headers"]["etag"],
    })
    assert stale["status"] == 412, stale
    page.refresh_from_db()
    assert page.content == "A replacement paragraph."
    # The SDK schema must reject fields that could publish, schedule or change ownership.
    client = APIClient()
    response = client.post("/api/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
        "name": "free2z_update_page", "arguments": {"account": "baz", "page_id": page_id, "changes": {"is_published": True}, "if_match": updated["headers"]["etag"]},
    }}, format="json", HTTP_AUTHORIZATION=f"Bearer {raw}", HTTP_ACCEPT="application/json, text/event-stream", secure=True)
    assert response.json()["result"]["isError"]
    page.refresh_from_db()
    assert not page.is_published
    audit = MCPActionAudit.objects.filter(operation="create_draft", status=201).first()
    assert audit.primary_user_id == user.pk and audit.target_user_id == target.pk
    assert APIClient().post("/api/mcp", {}, format="json", secure=True).status_code == 401


def test_public_edits_and_account_revocation_are_checked_by_native_tools(signed_in, user, creator_factory):
    _, _, tokens = issue(signed_in, user)
    raw = tokens["access_token"]
    target = creator_factory(username="restricted")
    linked, _ = link(raw, target, scopes=["mcp:read", "mcp:write"])
    _, created = draft(raw, "restricted")
    page_id = created["data"]["free2zaddr"]
    # A web owner can publish independently of the MCP app's limited grant.
    zPage.objects.filter(free2zaddr=page_id).update(is_published=True)
    _, read = tool(raw, "free2z_get_page", {"account": "restricted", "page_id": page_id})
    _, refused = tool(raw, "free2z_update_page", {
        "account": "restricted", "page_id": page_id, "changes": {"content": "Unauthorized public edit."}, "if_match": read["headers"]["etag"],
    })
    assert refused["status"] == 403
    _, refused = tool(raw, "free2z_set_page_published", {"account": "restricted", "page_id": page_id, "published": False, "if_match": read["headers"]["etag"]})
    assert refused["status"] == 403
    from django.utils import timezone
    MCPAccountGrant.objects.filter(pk=linked["id"]).update(revoked_at=timezone.now())
    _, refused = draft(raw, "restricted")
    assert refused["status"] == 403
    assert zPage.objects.filter(creator=target).count() == 1


def test_review_publish_return_to_draft_and_owner_visibility(signed_in, user, creator_factory):
    _, _, tokens = issue(signed_in, user)
    raw = tokens["access_token"]
    target = creator_factory(username="publisher")
    link(raw, target)
    _, created = draft(raw, target.username)
    page_id = created["data"]["free2zaddr"]
    _, hidden = tool(raw, "free2z_get_page", {"account": user.username, "page_id": page_id})
    assert hidden["status"] == 404
    _, published = tool(raw, "free2z_set_page_published", {
        "account": target.username, "page_id": page_id, "published": True, "if_match": created["headers"]["etag"],
    })
    assert published["status"] == 200, published
    assert zPage.objects.get(free2zaddr=page_id).is_published
    _, visible = tool(raw, "free2z_get_page", {"account": user.username, "page_id": page_id})
    assert visible["status"] == 200
    _, returned = tool(raw, "free2z_set_page_published", {
        "account": target.username, "page_id": page_id, "published": False, "if_match": published["headers"]["etag"],
    })
    assert returned["status"] == 200
    assert not zPage.objects.get(free2zaddr=page_id).is_published
    _, profile = tool(raw, "free2z_update_profile", {"account": target.username, "changes": {"full_name": "Chosen publisher"}})
    assert profile["status"] == 200, profile
    target.refresh_from_db()
    user.refresh_from_db()
    assert target.full_name == "Chosen publisher" and user.full_name != target.full_name


def test_internal_failure_rolls_back_and_never_serializes_exception(signed_in, user, monkeypatch):
    _, _, tokens = issue(signed_in, user)
    from dj.apps.mcpserver import operations

    def fail_after_write(actor, *args, **kwargs):
        actor.user.full_name = "Must roll back"
        actor.user.save(update_fields=["full_name"])
        raise RuntimeError("private-provider-token-not-for-clients")

    monkeypatch.setattr(operations, "_native", fail_after_write)
    result, failed = tool(tokens["access_token"], "free2z_update_profile", {"account": user.username, "changes": {"full_name": "Ignored"}})
    assert result["isError"] and failed["status"] == 500
    assert "private-provider-token" not in json.dumps(result)
    user.refresh_from_db()
    assert user.full_name != "Must roll back"


def _png():
    stream = BytesIO()
    Image.new("RGB", (16, 16), (30, 200, 120)).save(stream, "PNG")
    return stream.getvalue()


def prepare(raw, account, payload):
    return tool(raw, "free2z_prepare_upload", {
        "account": account, "filename": "feature.png", "mime_type": "image/png", "size": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(), "access": "private", "title": "Feature image",
    })[1]


def put_upload(prepared, body, *, capability=None):
    return APIClient().put(urlsplit(prepared["url"]).path, body, content_type="image/png", secure=True,
        HTTP_X_FREE2Z_UPLOAD_CAPABILITY=capability or prepared["headers"]["X-Free2Z-Upload-Capability"])


def test_prepared_upload_hash_identity_admission_replay_and_readback(signed_in, user, creator_factory):
    _, _, tokens = issue(signed_in, user)
    raw = tokens["access_token"]
    target = creator_factory(username="mediaowner")
    linked, _ = link(raw, target)
    payload = _png()
    prepared = prepare(raw, "mediaowner", payload)
    assert prepared["status"] == 201, prepared
    assert put_upload(prepared, payload, capability="x" * 43).status_code == 403
    assert put_upload(prepared, b"x" * len(payload)).status_code == 400
    assert not GenericFile.objects.filter(owner=target).exists()
    admission = APIClient().get("/api/mcp/uploads/authorize", secure=True,
        HTTP_X_ORIGINAL_URI=urlsplit(prepared["url"]).path,
        HTTP_X_ORIGINAL_CONTENT_LENGTH=str(len(payload)),
        HTTP_X_FREE2Z_UPLOAD_CAPABILITY=prepared["headers"]["X-Free2Z-Upload-Capability"])
    assert admission.status_code == 204
    response = put_upload(prepared, payload)
    assert response.status_code == 201, response.content
    media_id = response.json()["media"]["id"]
    media = GenericFile.objects.get(pk=media_id)
    assert media.owner_id == target.pk and media.access == "private"
    duplicate = put_upload(prepared, payload)
    assert duplicate.status_code == 200 and duplicate.json()["replayed"]
    assert duplicate.json()["media"]["id"] == media_id
    assert GenericFile.objects.filter(owner=target).count() == 1
    _, status = tool(raw, "free2z_get_upload_status", {"account": linked["id"], "upload_id": prepared["upload_id"]})
    assert status["state"] == "complete" and status["media"]["id"] == media_id
    _, hidden = tool(raw, "free2z_get_upload_status", {"account": user.username, "upload_id": prepared["upload_id"]})
    assert hidden["status"] == 403
    from django.utils import timezone
    pending = prepare(raw, "mediaowner", payload)
    MCPAccountGrant.objects.filter(pk=linked["id"]).update(revoked_at=timezone.now())
    assert put_upload(pending, payload).status_code == 403
    assert MCPUploadIntent.objects.get(pk=pending["upload_id"]).consumed_at is None
