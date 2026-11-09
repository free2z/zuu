"""Hosted wire, selected-account permissions and durable paid retries."""

from decimal import Decimal
from uuid import uuid4

import pytest
from django.core.files.base import ContentFile
from rest_framework.test import APIClient

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import Creator
from dj.apps.oidc.models import MCPAccountGrant, MCPActionAudit
from dj.apps.oidc.tests.test_mcp_connections import issue, link
from dj.apps.uploads.models import GenericFile
from .test_operations import _hosted_settings, tool  # noqa: F401

pytestmark = pytest.mark.django_db


def call(raw, account, operation, *, read=False, **kwargs):
    return tool(
        raw,
        "free2z_read" if read else "free2z_execute",
        {
            "account": account,
            "operation_id": operation,
            **kwargs,
        },
    )[1]


def test_catalog_explicit_denials_and_new_scopes(signed_in, user, monkeypatch):
    raw = issue(signed_in, user)[2]["access_token"]
    _, result = tool(
        raw, "free2z_search_operations", {"query": "translation", "supported": True}
    )
    assert any(
        x["operation_id"] == "zpage_translation_purchase"
        and "mcp:spend" in x["required_scopes"]
        for x in result["operations"]
    )
    from . import dispatch

    monkeypatch.setattr(
        dispatch,
        "_native",
        lambda *a, **kw: pytest.fail("Blocked operation reached a native view"),
    )
    for op in [
        "economy_payment_request",
        "economy_agreement_accept",
        "otp_setup_create",
        "auth_password_change_create",
    ]:
        denied = call(raw, user.username, op)
        assert (
            denied["status"] == 403
            and denied["data"]["code"] == "operation_not_supported"
        ), denied
    _, info = tool(
        raw, "free2z_describe_operation", {"operation_id": "economy_agreement_accept"}
    )
    assert "bearer" in info["reason"] and "authentication" in info["next_step"]


def test_selected_account_comment_receipt_replay_and_ceiling(
    signed_in, user, creator_factory
):
    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="targetauthor", tuzis=20)
    link(raw, target)
    before_owner = Creator.objects.get(pk=user.pk).tuzis
    args = {
        "body": {
            "headline": "A thread",
            "content": "Native hosted comment",
            "tuzis": 2,
        },
        "idempotency_key": str(uuid4()),
        "max_charge_tuzis": "1.999",
    }
    refused = call(raw, target.username, "comments_create", **args)
    assert refused["status"] == 400, refused
    assert not Comment.objects.filter(author=target).exists()
    args["max_charge_tuzis"] = "2"
    created = call(raw, target.username, "comments_create", **args)
    assert created["status"] == 201, created
    replay = call(raw, target.username, "comments_create", **args)
    assert (
        replay["status"] == 201 and replay["data"]["uuid"] == created["data"]["uuid"]
    ), replay
    assert Comment.objects.filter(author=target).count() == 1
    assert Creator.objects.get(pk=target.pk).tuzis == Decimal(18)
    assert Creator.objects.get(pk=user.pk).tuzis == before_owner
    audit = MCPActionAudit.objects.filter(
        operation="comments_create", status=201
    ).first()
    assert audit.primary_user_id == user.pk and audit.target_user_id == target.pk
    args["body"]["content"] = "Different intent"
    assert call(raw, target.username, "comments_create", **args)["status"] == 409
    assert Creator.objects.get(pk=target.pk).tuzis == Decimal(18)


def test_scope_narrowing_and_revocation_before_native(
    signed_in, user, creator_factory, monkeypatch
):
    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="narrowed")
    linked, _ = link(raw, target, scopes=["mcp:read", "mcp:write", "mcp:publish"])
    from . import dispatch

    monkeypatch.setattr(
        dispatch,
        "_native",
        lambda *a, **kw: pytest.fail("Missing grant reached native"),
    )
    assert call(raw, target.username, "events_list", read=True)["status"] == 403
    assert (
        call(
            raw,
            target.username,
            "comments_create",
            body={"content": "No", "tuzis": 1},
            idempotency_key=str(uuid4()),
            max_charge_tuzis="1",
        )["status"]
        == 403
    )
    from django.utils import timezone

    MCPAccountGrant.objects.filter(pk=linked["id"]).update(revoked_at=timezone.now())
    assert call(raw, target.username, "creator_list", read=True)["status"] == 403


def test_private_file_capability_selected_owner_and_revocation(
    signed_in, user, creator_factory
):
    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="fileowner")
    linked, _ = link(raw, target)
    media = GenericFile.objects.create(
        owner=target,
        file=ContentFile(b"private file bytes", name="example.pdf"),
        access="private",
    )
    assert (
        call(raw, user.username, "mcp_prepare_download", body={"upload_id": media.pk})[
            "status"
        ]
        == 403
    )
    result = call(
        raw, target.username, "mcp_prepare_download", body={"upload_id": media.pk}
    )
    assert result["status"] == 200, result
    cap = result["data"]["headers"]["X-Free2Z-Download-Capability"]
    assert raw not in cap
    client = APIClient()
    path = f"/api/mcp/downloads/{media.pk}"
    assert client.get(path).status_code == 403
    response = client.get(path, HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY=cap)
    assert (
        response.status_code == 200
        and b"".join(response.streaming_content) == b"private file bytes"
    )
    MCPAccountGrant.objects.filter(pk=linked["id"]).update(generation=2)
    assert client.get(path, HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY=cap).status_code == 403


def test_free_follow_and_private_notifications(signed_in, user, creator_factory):
    raw = issue(signed_in, user)[2]["access_token"]
    other = creator_factory(username="followed")
    before = Creator.objects.get(pk=user.pk).tuzis
    result = call(
        raw,
        user.username,
        "creator_follow_update",
        path={"username__iexact": other.username},
    )
    assert result["status"] < 300, result
    read = call(
        raw,
        user.username,
        "creator_follow_retrieve",
        read=True,
        path={"username__iexact": other.username},
    )
    assert read["status"] == 200, read
    assert Creator.objects.get(pk=user.pk).tuzis == before
    assert (
        call(raw, user.username, "events_unread_count_retrieve", read=True)["status"]
        == 200
    )
    assert (
        call(
            raw,
            user.username,
            "events_mention_preference_partial_update",
            body={"enabled": False},
        )["status"]
        == 200
    )


def test_translation_quote_purchase_replay_and_batch_ceiling(
    signed_in, user, creator_factory, monkeypatch, settings
):
    from dj.apps.g12f.test_translation_purchase import make_page, flush_on_commit
    from dj.apps.g12f.translation import service, charges
    from dj.apps.g12f.translation.tasks import translate_zpage
    from dj.apps.openai.models import AIModel
    from dj.apps.tuzis.models import IdempotencyKey

    model = AIModel.objects.create(
        provider="openai",
        model="mcp-translation-test",
        display_name="Test",
        system_message="Test",
        max_tokens=16384,
        is_enabled=True,
    )
    settings.ZPAGE_TRANSLATION_MODELS = [f"{model.provider}:{model.model}"]
    monkeypatch.setattr(service, "get_client", lambda provider: object())
    queued = []
    monkeypatch.setattr(
        translate_zpage, "defer", lambda **kwargs: queued.append(kwargs)
    )
    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="translator", tuzis=100)
    link(raw, target)
    page = make_page(target)
    path = {"free2zaddr": str(page.free2zaddr), "language": "es"}
    quote = call(raw, target.username, "zpage_translation_quote", read=True, path=path)
    assert quote["status"] == 200, quote
    q = quote["data"]
    body = {"expected_price": q["price"], "source_digest": q["source_digest"]}
    args = {
        "path": path,
        "body": body,
        "idempotency_key": str(uuid4()),
        "max_charge_tuzis": str(q["price"]),
    }
    assert (
        call(raw, user.username, "zpage_translation_purchase", **args)["status"] == 404
    )
    bought = call(raw, target.username, "zpage_translation_purchase", **args)
    assert bought["status"] == 202, bought
    flush_on_commit()
    retry = call(raw, target.username, "zpage_translation_purchase", **args)
    flush_on_commit()
    assert retry["data"]["job_id"] == bought["data"]["job_id"], retry
    assert queued == [{"job_id": bought["data"]["job_id"]}]
    assert Creator.objects.get(pk=target.pk).tuzis == Decimal(100) - Decimal(q["price"])
    assert IdempotencyKey.objects.filter(user=target, scope=charges.SCOPE).count() == 1
    denied = call(
        raw,
        target.username,
        "zpage_translation_batch_purchase",
        path={"free2zaddr": str(page.free2zaddr)},
        body={
            "items": [
                {"language": "fr", "expected_price": 2},
                {"language": "de", "expected_price": 2},
            ],
            "source_digest": q["source_digest"],
        },
        idempotency_key=str(uuid4()),
        max_charge_tuzis="3",
    )
    assert (
        denied["status"] == 400 and denied["data"]["code"] == "charge_limit_exceeded"
    ), denied


def test_conversation_and_personality_private_ownership(
    signed_in, user, creator_factory
):
    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="conversationowner")
    link(raw, target)
    made = call(
        raw,
        target.username,
        "ai_personalities_create",
        body={
            "display_name": "Private editor",
            "system_message": "Keep it concise.",
            "is_public": False,
        },
    )
    assert made["status"] == 201, made
    identity = made["data"]["id"]
    assert (
        call(
            raw,
            user.username,
            "ai_personalities_retrieve",
            read=True,
            path={"id": identity},
        )["status"]
        == 404
    )
    updated = call(
        raw,
        target.username,
        "ai_personalities_partial_update",
        path={"id": identity},
        body={"display_name": "Clear editor"},
    )
    assert updated["status"] == 200, updated
    assert call(raw, target.username, "languages_catalog", read=True)["status"] == 200


@pytest.mark.django_db(transaction=True)
def test_concurrent_translation_same_key_commits_one_charge_and_job(
    signed_in, user, creator_factory, monkeypatch, settings
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from django.db import close_old_connections, connection
    from dj.apps.g12f.test_translation_purchase import make_page
    from dj.apps.g12f.translation import service
    from dj.apps.g12f.translation.tasks import translate_zpage
    from dj.apps.openai.models import AIModel

    model = AIModel.objects.create(
        provider="openai",
        model="mcp-concurrent-translation",
        display_name="Test",
        system_message="Test",
        max_tokens=16384,
        is_enabled=True,
    )
    settings.ZPAGE_TRANSLATION_MODELS = [f"{model.provider}:{model.model}"]
    monkeypatch.setattr(service, "get_client", lambda provider: object())
    queued = []
    monkeypatch.setattr(
        translate_zpage, "defer", lambda **kwargs: queued.append(kwargs)
    )
    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="paralleltranslator", tuzis=100)
    link(raw, target)
    page = make_page(target)
    path = {"free2zaddr": str(page.free2zaddr), "language": "fr"}
    quoted = call(
        raw, target.username, "zpage_translation_quote", read=True, path=path
    )["data"]
    args = {
        "path": path,
        "body": {
            "expected_price": quoted["price"],
            "source_digest": quoted["source_digest"],
        },
        "idempotency_key": str(uuid4()),
        "max_charge_tuzis": str(quoted["price"]),
    }
    barrier = Barrier(2)

    def purchase():
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '10s'")
                cursor.execute("SET lock_timeout = '5s'")
            barrier.wait(timeout=5)
            return call(raw, target.username, "zpage_translation_purchase", **args)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        jobs = [executor.submit(purchase) for _ in range(2)]
        responses = [future.result(timeout=20) for future in jobs]
    assert all(r["status"] == 202 for r in responses), responses
    assert responses[0]["data"]["job_id"] == responses[1]["data"]["job_id"]
    assert queued == [{"job_id": responses[0]["data"]["job_id"]}]
    assert Creator.objects.get(pk=target.pk).tuzis == Decimal(100) - quoted["price"]


def test_download_resource_binding_and_export_capability(
    signed_in, user, settings, tmp_path
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.exports.models import PublicationExportJob, ExportStatus
    from dj.apps.exports.storage import get_export_storage
    from django.core import signing
    from .downloads import SALT

    settings.STORAGES = {
        **settings.STORAGES,
        "exports": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
            "OPTIONS": {"location": str(tmp_path / "exports")},
        },
    }
    raw = issue(signed_in, user)[2]["access_token"]
    media = GenericFile.objects.create(
        owner=user, file=ContentFile(b"data", name="private.pdf"), access="private"
    )
    capability = call(
        raw, user.username, "mcp_prepare_download", body={"upload_id": media.pk}
    )["data"]["headers"]["X-Free2Z-Download-Capability"]
    payload = signing.loads(capability, salt=SALT)
    payload["resource"] = "https://other.example/api/mcp"
    wrong = signing.dumps(payload, salt=SALT)
    assert (
        APIClient()
        .get(f"/api/mcp/downloads/{media.pk}", HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY=wrong)
        .status_code
        == 403
    )
    key = get_export_storage().save("test/archive.zip", ContentFile(b"archive"))
    job = PublicationExportJob.objects.create(
        creator=user,
        status=ExportStatus.READY,
        file_path=key,
        file_name="archive.zip",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    prepared = call(
        raw,
        user.username,
        "publication_exports_download",
        read=True,
        path={"id": str(job.pk)},
    )
    assert prepared["status"] == 200, prepared
    header = prepared["data"]["headers"]["X-Free2Z-Download-Capability"]
    response = APIClient().get(
        f"/api/mcp/exports/{job.pk}", HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY=header
    )
    assert (
        response.status_code == 200
        and b"".join(response.streaming_content) == b"archive"
    )
    job.expires_at = timezone.now() - timedelta(seconds=1)
    job.save(update_fields=["expires_at"])
    assert (
        APIClient()
        .get(f"/api/mcp/exports/{job.pk}", HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY=header)
        .status_code
        == 403
    )


def test_paid_vote_and_unbounded_get_refusal(
    signed_in, user, creator_factory, monkeypatch
):
    from dj.apps.g12f.test_translation_purchase import make_page

    raw = issue(signed_in, user)[2]["access_token"]
    other = creator_factory(username="pagewriter")
    page = make_page(other)
    before = Creator.objects.get(pk=user.pk).tuzis
    args = {
        "path": {"free2zaddr": str(page.free2zaddr)},
        "body": {"vote": "up"},
        "idempotency_key": str(uuid4()),
        "max_charge_tuzis": "1",
    }
    result = call(raw, user.username, "zpage_vote_create", **args)
    assert result["status"] < 300, result
    retry = call(raw, user.username, "zpage_vote_create", **args)
    assert retry["status"] == result["status"]
    assert Creator.objects.get(pk=user.pk).tuzis == before - 1
    from . import dispatch

    monkeypatch.setattr(
        dispatch,
        "_native",
        lambda *a, **kw: pytest.fail("Unreviewed live operation reached provider flow"),
    )
    assert (
        call(
            raw,
            user.username,
            "dyte_private_retrieve",
            read=True,
            path={"username": user.username},
        )["status"]
        == 403
    )
