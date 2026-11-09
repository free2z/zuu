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


def test_cloud_download_offloads_without_opening_or_spooling_bytes():
    from storages.backends.gcloud import GoogleCloudStorage
    from .downloads import _media_response, _export_response

    calls = []

    class Blob:
        generation = 1234
        name = "private/owner/a file%25.pdf"

        def download_to_file(self, *args, **kwargs):
            pytest.fail("Cloud bytes must never spool in Django")

        def open(self, *args, **kwargs):
            pytest.fail("Cloud bytes must never stream through Django workers")

    class Bucket:
        def get_blob(self, name, *, timeout, retry):
            assert name == "owned/original" and timeout == 5 and retry is None
            calls.append("metadata")
            return Blob()

    class Storage(GoogleCloudStorage):
        @property
        def bucket(self):
            return Bucket()

        def open(self, *args, **kwargs):
            pytest.fail("django-storages byte path must never be opened")

    response = _media_response(Storage(), "owned/original", "original.pdf")
    assert calls == ["metadata"]
    assert not response.streaming and response.content == b""
    assert (
        response["X-Accel-Redirect"]
        == "/_internal_mcp_media/private/owner/a%20file%2525.pdf?generation=1234"
    )
    assert response["Cache-Control"] == "private, no-store"
    export = _export_response(Storage(), "owner/archive.zip", "archive.zip")
    assert export["X-Accel-Redirect"] == "/_internal_exports/owner/archive.zip"
    assert not export.streaming and export.content == b""


def test_selected_email_preferences_do_not_mutate_other_account_or_credentials(
    signed_in, user, creator_factory
):
    from dj.apps.emails.models import Email
    from django.utils import timezone

    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="emailsettings")
    linked, _ = link(raw, target, scopes=["mcp:account"])
    address = Email.objects.create(
        user=target,
        email="owner@example.test",
        confirmed_at=timezone.now(),
        expires_at=timezone.now(),
    )
    owner_address = Email.objects.create(
        user=user,
        email="different@example.test",
        confirmed_at=timezone.now(),
        expires_at=timezone.now(),
    )
    read = call(raw, target.username, "emails_status_retrieve", read=True)
    assert read["status"] == 200 and read["data"]["email"] == address.email, read
    assert set(read["data"]) == {
        "email",
        "confirmed",
        "pending",
        "is_public",
        "get_notifications",
    }
    assert (
        call(raw, target.username, "emails_notifications_create", body={"value": True})[
            "status"
        ]
        == 204
    )
    assert (
        call(raw, target.username, "emails_public_create", body={"value": True})[
            "status"
        ]
        == 403
    )
    MCPAccountGrant.objects.filter(pk=linked["id"]).update(
        scope="mcp:account mcp:publish"
    )
    assert (
        call(raw, target.username, "emails_public_create", body={"value": True})[
            "status"
        ]
        == 204
    )
    assert (
        call(
            raw, target.username, "emails_notifications_create", body={"value": "false"}
        )["status"]
        == 400
    )
    assert (
        call(
            raw,
            target.username,
            "emails_notifications_create",
            body={"value": False, "email": "other@example.test"},
        )["status"]
        == 400
    )
    address.refresh_from_db()
    owner_address.refresh_from_db()
    assert (
        address.get_notifications
        and address.is_public
        and address.email == "owner@example.test"
    )
    assert not owner_address.get_notifications and not owner_address.is_public


@pytest.mark.parametrize("by_vanity", [False, True])
def test_old_content_grant_cannot_delete_and_variant_delete_requires_exact_etag(
    signed_in, user, creator_factory, by_vanity
):
    from dj.apps.g12f.test_translation_purchase import make_page
    from dj.apps.g12f.models import zPage, ZPageVariant

    raw = issue(signed_in, user)[2]["access_token"]
    target = creator_factory(username="variantowner")
    linked, _ = link(raw, target, scopes=["mcp:read", "mcp:write", "mcp:publish"])
    page = make_page(target)
    page.vanity = "owned-translation-page"
    page.save(update_fields=["vanity"])
    page.tags.add("zcash")
    stale_tags = list(page.tags.names())
    page.tags.add("release")  # A newer parent edit after the agent's read.
    path = {"id": page.vanity if by_vanity else str(page.free2zaddr), "language": "es"}
    assert (
        call(
            raw,
            target.username,
            "zpage_variants_update",
            path=path,
            body={
                "title": "Título",
                "content": "Contenido traducido.",
                "tags": stale_tags,
            },
            if_none_match="*",
        )["status"]
        == 400
    )
    assert set(page.tags.names()) == {"zcash", "release"}

    created = call(
        raw,
        target.username,
        "zpage_variants_update",
        path=path,
        body={
            "title": "Título",
            "content": "Contenido traducido.",
            "is_published": False,
        },
        if_none_match="*",
    )
    assert created["status"] == 200, created
    assert set(page.tags.names()) == {"zcash", "release"}
    etag = created["headers"]["etag"]
    assert (
        call(raw, target.username, "zpage_variants_destroy", path=path, if_match=etag)[
            "status"
        ]
        == 403
    )
    MCPAccountGrant.objects.filter(pk=linked["id"]).update(
        scope="mcp:read mcp:write mcp:publish mcp:delete"
    )
    for args in [{"if_none_match": "*"}, {"if_match": "*"}, {"if_match": etag + ",*"}]:
        assert (
            call(raw, target.username, "zpage_variants_destroy", path=path, **args)[
                "status"
            ]
            == 400
        )
    assert (
        call(
            raw,
            target.username,
            "zpage_variants_destroy",
            path=path,
            if_match='"stale"',
        )["status"]
        == 412
    )
    assert ZPageVariant.objects.filter(zpage=page, language="es").exists()
    assert (
        call(raw, target.username, "zpage_variants_destroy", path=path, if_match=etag)[
            "status"
        ]
        == 204
    )
    _, article = tool(
        raw,
        "free2z_get_page",
        {"account": target.username, "page_id": str(page.free2zaddr)},
    )
    result = call(
        raw,
        target.username,
        "zpage_destroy",
        path={"id": str(page.free2zaddr)},
        if_match=article["headers"]["etag"],
    )
    assert result["status"] == 204, result
    assert not zPage.objects.filter(pk=page.pk).exists()


def test_generic_page_filters_search_and_cached_vector_path(
    signed_in, user, creator_factory, monkeypatch
):
    from datetime import timedelta
    from types import SimpleNamespace
    from django.utils import timezone
    from dj.apps.g12f.test_translation_purchase import make_page
    from dj.apps.g12f.models import zPage
    from dj.apps.search import drf_filters

    raw = issue(signed_in, user)[2]["access_token"]
    author = creator_factory(username="searchauthor")
    older = make_page(
        author,
        title="Orchid older",
        vanity="orchid-older",
        content="Orchid botanical notes.",
    )
    newer = make_page(
        author,
        title="Orchid newest",
        vanity="orchid-newest",
        content="Orchid botanical findings.",
    )
    zPage.objects.filter(pk=older.pk).update(
        published_at=timezone.now() - timedelta(days=1)
    )
    zPage.objects.filter(pk=newer.pk).update(published_at=timezone.now())
    monkeypatch.setenv("OPENAI_API_KEY", "test-only")
    monkeypatch.setattr(
        dr_filters := drf_filters, "cached_query_embedding", lambda query: None
    )
    monkeypatch.setattr(
        dr_filters,
        "query_embedding_client",
        lambda: pytest.fail("MCP search performed provider I/O under account locks"),
    )
    listed = call(
        raw,
        user.username,
        "zpage_list",
        read=True,
        query={
            "username": author.username,
            "ordering": "-published_at",
            "created_at__gte": "2020-01-01",
        },
    )
    assert listed["status"] == 200, listed
    assert [p["free2zaddr"] for p in listed["data"]["results"]][:2] == [
        str(newer.free2zaddr),
        str(older.free2zaddr),
    ]
    searched = call(
        raw,
        user.username,
        "zpage_list",
        read=True,
        query={
            "username": author.username,
            "search": "Orchid",
            "ordering": "-published_at",
        },
    )
    assert searched["status"] == 200 and len(searched["data"]["results"]) == 2, searched
    native_filter = drf_filters.VectorSearchFilter()
    monkeypatch.setattr(dr_filters, "cached_query_embedding", lambda query: [0.25])
    monkeypatch.setattr(
        native_filter, "_semantic", lambda queryset, vector: (queryset, vector)
    )
    result = native_filter.filter_queryset(
        SimpleNamespace(query_params={"search": "Orchid"}, mcp_actor=object()),
        "rows",
        None,
    )
    assert result == ("rows", [0.25])


@pytest.mark.django_db(transaction=True)
def test_download_offload_runs_after_commit_and_rejects_invalid_authority(
    signed_in, user, monkeypatch
):
    from datetime import timedelta
    from django.db import connection
    from django.http import HttpResponse
    from django.utils import timezone
    from dj.apps.exports.models import PublicationExportJob, ExportStatus
    from . import downloads

    raw = issue(signed_in, user)[2]["access_token"]
    media = GenericFile.objects.create(
        owner=user, file=ContentFile(b"private", name="private.pdf"), access="private"
    )
    job = PublicationExportJob.objects.create(
        creator=user,
        status=ExportStatus.READY,
        file_path="owner/archive.zip",
        file_name="archive.zip",
        expires_at=timezone.now() + timedelta(hours=1),
    )
    prepared = [
        call(raw, user.username, "mcp_prepare_download", body={"upload_id": media.pk}),
        call(
            raw,
            user.username,
            "publication_exports_download",
            read=True,
            path={"id": str(job.pk)},
        ),
    ]
    calls = []

    def offload(*args):
        assert not connection.in_atomic_block
        # Audit writes are committed before metadata or transfer I/O starts.
        assert MCPActionAudit.objects.filter(
            operation__in=["download_file", "download_export"]
        ).exists()
        calls.append(args)
        return HttpResponse()

    monkeypatch.setattr(downloads, "_media_response", offload)
    monkeypatch.setattr(downloads, "_export_response", offload)
    client = APIClient()
    paths = [f"/api/mcp/downloads/{media.pk}", f"/api/mcp/exports/{job.pk}"]
    for path, result in zip(paths, prepared):
        assert result["status"] == 200, result
        cap = result["data"]["headers"][downloads.HEADER]
        assert client.get(path).status_code == 403
        assert (
            client.get(path, HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY="invalid").status_code
            == 403
        )
        assert (
            client.get(path, HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY=cap).status_code == 200
        )
    assert len(calls) == 2
    MCPAccountGrant.objects.filter(user=user).update(generation=2)
    for path, result in zip(paths, prepared):
        assert (
            client.get(
                path,
                HTTP_X_FREE2Z_DOWNLOAD_CAPABILITY=result["data"]["headers"][
                    downloads.HEADER
                ],
            ).status_code
            == 403
        )
    assert len(calls) == 2
