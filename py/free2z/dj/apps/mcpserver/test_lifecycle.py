"""Real MCP requests contending for one app and cross-account foreign keys."""

from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Event
from uuid import uuid4

import pytest
from django.db import close_old_connections, connection
from rest_framework.test import APIClient

from dj.apps.comments.models import Comment
from dj.apps.g12f.models import Creator, CreatorBlock, CreatorFollow, CreatorMute
from dj.apps.oidc.models import F2ZApplication, MCPActionAudit
from dj.apps.oidc.tests.test_mcp_connections import issue, link
from .test_catalog import call
from .test_operations import _hosted_settings, tool  # noqa: F401


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("linked", [False, True], ids=["primary", "linked"])
@pytest.mark.parametrize(
    "operation",
    [
        "creator_follow_update",
        "creator_block_update",
        "creator_mute_update",
        "comments_replies_create",
        "comments_vote_create",
        "zpage_vote_create",
        "zpage_translation_purchase",
    ],
)
def test_shared_app_reciprocal_operations_preserve_native_charges(
    signed_in,
    user,
    creator_factory,
    monkeypatch,
    settings,
    linked,
    operation,
):
    """A holds the app; B holds its actors while waiting for that app.

    A must commit references to B without waiting for B's lifecycle lock.
    Both requests use real OAuth connections belonging to the same app.
    """
    from . import dispatch
    from dj.apps.g12f.test_translation_purchase import make_page

    owners = [user, creator_factory(username="secondowner", tuzis=100)]
    actors = (
        [creator_factory(username=f"selected{i}", tuzis=100) for i in range(2)]
        if linked
        else owners
    )
    Creator.objects.filter(pk__in=[x.pk for x in actors]).update(tuzis=100)
    app, _, tokens = issue(signed_in, owners[0])
    browser = APIClient()
    browser.force_login(owners[1])
    raw = [tokens["access_token"], issue(browser, owners[1], app)[2]["access_token"]]
    if linked:
        for token, actor in zip(raw, actors):
            link(token, actor)
    args, costs, queued = [], [Decimal(0), Decimal(0)], []
    if operation == "zpage_translation_purchase":
        from dj.apps.g12f.translation import service
        from dj.apps.g12f.translation.tasks import translate_zpage
        from dj.apps.openai.models import AIModel

        model = AIModel.objects.create(
            provider="openai",
            model="lock-regression",
            display_name="Test",
            system_message="Test",
            max_tokens=16384,
            is_enabled=True,
        )
        settings.ZPAGE_TRANSLATION_MODELS = [f"{model.provider}:{model.model}"]
        monkeypatch.setattr(service, "get_client", lambda provider: object())
        monkeypatch.setattr(translate_zpage, "defer", lambda **kw: queued.append(kw))
    for i, actor in enumerate(actors):
        other = actors[1 - i]
        if operation.startswith("creator_"):
            args.append({"path": {"username__iexact": other.username}})
            continue
        item = {"idempotency_key": str(uuid4()), "max_charge_tuzis": "1"}
        costs[i] = Decimal(1)
        if operation.startswith("comments_"):
            parent = Comment.objects.create(author=other, content="Public parent")
            item.update(
                path={"uuid": str(parent.uuid)},
                body=(
                    {"content": "Reply", "tuzis": 1}
                    if operation == "comments_replies_create"
                    else {"vote": "up"}
                ),
            )
        elif operation == "zpage_vote_create":
            page = make_page(other)
            item.update(path={"free2zaddr": str(page.free2zaddr)}, body={"vote": "up"})
        else:
            page = make_page(actor)
            path = {"free2zaddr": str(page.free2zaddr), "language": "fr"}
            quote = call(
                raw[i], actor.username, "zpage_translation_quote", read=True, path=path
            )
            assert quote["status"] == 200, quote
            q = quote["data"]
            costs[i] = Decimal(q["price"])
            item.update(
                path=path,
                body={
                    "source_digest": q["source_digest"],
                    "expected_price": q["price"],
                },
                max_charge_tuzis=str(q["price"]),
            )
        args.append(item)

    first_native, second_actors_locked = Event(), Event()
    native = dispatch._native

    def gated_native(actor, *a, **kw):
        if actor.user.pk == actors[0].pk:
            first_native.set()
            assert second_actors_locked.wait(10), (
                "second request never acquired actor locks"
            )
        return native(actor, *a, **kw)

    monkeypatch.setattr(dispatch, "_native", gated_native)

    def observe_app_lock(execute, sql, params, many, context):
        if F2ZApplication._meta.db_table in sql and "FOR UPDATE" in sql:
            second_actors_locked.set()
        return execute(sql, params, many, context)

    def request(i):
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '12s'")
                cursor.execute("SET lock_timeout = '6s'")
            with connection.execute_wrapper(
                observe_app_lock if i else lambda f, *a: f(*a)
            ):
                return call(raw[i], actors[i].username, operation, **args[i])
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(request, 0)
        assert first_native.wait(10), "first request never reached native view"
        second = pool.submit(request, 1)
        results = [first.result(timeout=20), second.result(timeout=20)]
    assert all(200 <= r["status"] < 300 for r in results), results
    monkeypatch.setattr(dispatch, "_native", native)
    for i, actor in enumerate(actors):
        assert Creator.objects.get(pk=actor.pk).tuzis == Decimal(100) - costs[i]
        audit = MCPActionAudit.objects.filter(
            operation=operation, target_user_id=actor.pk
        ).latest("created_at")
        assert audit.primary_user_id == owners[i].pk
        if costs[i]:
            replay = call(raw[i], actor.username, operation, **args[i])
            assert replay["data"]["replayed"] is True
            assert {k: v for k, v in replay["data"].items() if k != "replayed"} == {
                k: v for k, v in results[i]["data"].items() if k != "replayed"
            }, replay
            assert Creator.objects.get(pk=actor.pk).tuzis == Decimal(100) - costs[i]
    if operation.startswith("creator_"):
        model = {
            "creator_follow_update": CreatorFollow,
            "creator_block_update": CreatorBlock,
            "creator_mute_update": CreatorMute,
        }[operation]
        assert model.objects.count() == 2
    if operation == "zpage_translation_purchase":
        assert len(queued) == 2


@pytest.mark.django_db
def test_public_conversation_alias_redirects_to_paginated_operation(
    signed_in, user, monkeypatch
):
    from . import dispatch

    raw = issue(signed_in, user)[2]["access_token"]
    _, description = tool(
        raw,
        "free2z_describe_operation",
        {"operation_id": "ai_conversations_public_retrieve"},
    )
    assert not description["supported"]
    assert description["available_via_operations"] == ["ai_public_conversations_list"]
    with monkeypatch.context() as patch:
        patch.setattr(
            dispatch,
            "_native",
            lambda *a, **kw: pytest.fail("unbounded native alias reached"),
        )
        blocked = call(
            raw, user.username, "ai_conversations_public_retrieve", read=True
        )
        assert blocked["status"] == 403, blocked
    listed = call(
        raw, user.username, "ai_public_conversations_list", read=True, query={"page": 1}
    )
    assert listed["status"] == 200 and "results" in listed["data"], listed


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize(
    "operation",
    [
        "emails_status_retrieve",
        "emails_public_create",
        "emails_notifications_create",
        "reports_create",
    ],
)
def test_native_account_locks_allow_concurrent_consent(
    signed_in,
    user,
    monkeypatch,
    operation,
):
    """Native account locks must allow consent's KEY SHARE while it waits for the app."""
    import time
    from dj.apps.oidc.consent import record_consent
    from dj.apps.oidc.tests.test_mcp_connections import SCOPES
    from dj.apps.comments.models import ContentReport
    from . import dispatch

    app, _, tokens = issue(signed_in, user)
    raw = tokens["access_token"]
    from dj.apps.emails.models import Email
    from django.utils import timezone

    email = Email.objects.create(
        user=user, email="fixture@example.test", is_public=True, get_notifications=True
    )
    native_started, consent_started = Event(), Event()
    consent_pid = []
    native = dispatch._native

    def gated_native(*a, **kw):
        native_started.set()
        assert consent_started.wait(10)
        deadline = time.monotonic() + 8
        while True:
            # Both the old and corrected consent paths eventually wait for this
            # request. Observe the real wait, not a timing-dependent sleep.
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_backend_pid() = ANY(pg_blocking_pids(%s))",
                    [consent_pid[0]],
                )
                waiting = cursor.fetchone()[0]
            if waiting:
                break
            assert time.monotonic() < deadline, (
                "consent never waited for the MCP transaction"
            )
            Event().wait(0.01)
        return native(*a, **kw)

    monkeypatch.setattr(dispatch, "_native", gated_native)

    def invoke():
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '12s'")
                cursor.execute("SET lock_timeout = '6s'")
            if operation == "emails_status_retrieve":
                kwargs = {}
            elif operation.startswith("emails_"):
                kwargs = {"body": {"value": False}}
            else:
                kwargs = {
                    "body": {
                        "target_kind": "creator",
                        "target_id": user.username,
                        "reason": "spam",
                    }
                }
            return call(
                raw,
                user.username,
                operation,
                read=operation == "emails_status_retrieve",
                **kwargs,
            )
        finally:
            close_old_connections()

    def consent():
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '12s'")
                cursor.execute("SET lock_timeout = '6s'")
                cursor.execute("SELECT pg_backend_pid()")
                consent_pid.append(cursor.fetchone()[0])
            consent_started.set()
            return record_consent(
                user, app, SCOPES.split(), spend_cap_2z=None, cap_period="month"
            )
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        action = pool.submit(invoke)
        assert native_started.wait(10)
        authorization = pool.submit(consent)
        result, grant = action.result(timeout=20), authorization.result(timeout=20)
    assert (
        result["status"]
        == {
            "emails_status_retrieve": 200,
            "emails_public_create": 204,
            "emails_notifications_create": 204,
            "reports_create": 201,
        }[operation]
    ), result
    assert grant.user_id == user.pk and grant.application_id == app.pk
    if operation == "reports_create":
        assert ContentReport.objects.filter(reporter=user).count() == 1

    if operation in {"emails_public_create", "emails_notifications_create"}:
        email.refresh_from_db()
        assert not getattr(
            email,
            "is_public" if operation == "emails_public_create" else "get_notifications",
        )
