"""Real PostgreSQL producer contracts; provider boundary alone is controlled."""

import threading
import uuid
from datetime import timedelta
from unittest.mock import Mock

import pytest
from django.db import close_old_connections
from django.utils import timezone
from rest_framework.test import APIClient
from . import producer
from .models import (
    CreatorMeeting,
    ProducerOperation,
    ProducerStream,
    ProviderRoomCleanup,
)
from .producer_provider import ProviderUnavailable

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def host(creator_factory):
    return creator_factory(username="producer", tuzis=1000)


@pytest.fixture
def provider(mocker):
    mocker.patch("dj.apps.dyte.producer.configured", return_value=True)
    client = Mock()
    client.check.return_value = True
    client.create.return_value = str(uuid.uuid4())
    client.token.return_value = (str(uuid.uuid4()), "fixture-host-token")
    client.live.return_value = (str(uuid.uuid4()), 1)
    client.find.side_effect = lambda title: [client.create.return_value]
    mocker.patch("dj.apps.dyte.producer.ProducerProvider", return_value=client)
    return client


def instruction(host, action="draft", stream=None):
    return dict(
        action=action,
        idempotency_key=str(uuid.uuid4()),
        expected_actor_id=host.pk,
        owner=str(stream.owner) if stream else str(uuid.uuid4()),
        version=stream.version if stream else 1,
        title=stream.title if stream else "A stream",
        description=stream.description if stream else "Description",
        audience="public",
        access="free",
    )


def call(host, data, stream=None):
    client = APIClient()
    client.force_authenticate(host)
    return client.post(
        "/api/dyte/producer/v1" + (f"/{stream.pk}" if stream else ""),
        data,
        format="json",
    )


def draft(host):
    result = call(host, instruction(host))
    assert result.status_code == 200, result.data
    return ProducerStream.objects.get(pk=result.data["stream"]["id"])


def act(host, stream, action):
    stream.refresh_from_db()
    result = call(host, instruction(host, action, stream), stream)
    stream.refresh_from_db()
    return result


def ready(host):
    stream = draft(host)
    assert act(host, stream, "provision").status_code == 200
    return stream


def test_full_flow_durable_discovery_and_history(host, provider):
    stream = ready(host)
    assert stream.state == "ready" and not stream.meeting.live_now
    assert act(host, stream, "refresh").data["auth_token"] == "fixture-host-token"
    assert "fixture-host-token" not in stream.token_ciphertext
    assert act(host, stream, "publish").data["stream"]["state"] == "live"
    stream.meeting.refresh_from_db()
    assert stream.meeting.live_now
    assert act(host, stream, "end").data["stream"]["state"] == "cleaned_up"
    stream.meeting.refresh_from_db()
    assert not stream.meeting.live_now
    assert stream.ended_at and stream.token_ciphertext == ""
    provider.disable.assert_called_once_with(str(stream.room_id))
    assert act(host, stream, "publish").status_code == 409
    client = APIClient()
    client.force_authenticate(host)
    assert client.get("/api/dyte/producer/v1/history").data[0]["ended_at"]
    assert client.get("/api/dyte/public/").data["count"] == 0


def test_legacy_rotation_retires_before_create_and_retains_receipt(host, provider):
    old_room = str(uuid.uuid4())
    cm = CreatorMeeting.objects.create(
        creator=host,
        meeting_id=old_room,
        meeting_type="broadcast",
        provider_session_id=uuid.uuid4(),
        provider_session_started_at=timezone.now(),
    )
    calls = []
    provider.disable.side_effect = lambda room: calls.append(("disable", room))
    provider.create.side_effect = lambda title: (
        calls.append(("create", title)) or provider.create.return_value
    )
    stream = draft(host)
    payload = instruction(host, "provision", stream)
    result = call(host, payload, stream)
    assert result.status_code == 200
    assert calls[0] == ("disable", old_room) and calls[1][0] == "create"
    assert "retired_room_id" not in result.data["operation"]
    assert call(host, payload, stream).status_code == 200
    assert len(calls) == 2
    receipt = ProviderRoomCleanup.objects.get(provider_meeting_id=old_room)
    assert receipt.status == "complete" and receipt.creator_id == host.pk
    cm.refresh_from_db()
    assert cm.meeting_id == provider.create.return_value
    assert cm.start_id == stream.pk
    assert cm.provider_session_id is None and cm.provider_session_started_at is None
    assert act(host, stream, "refresh").status_code == 200
    assert act(host, stream, "publish").status_code == 200
    cm.refresh_from_db()
    assert cm.provider_session_started_at is None  # unknown, never local now


def test_ambiguous_legacy_retirement_never_creates_and_recovery_cleans_it(
    host, provider
):
    old_room = str(uuid.uuid4())
    CreatorMeeting.objects.create(
        creator=host, meeting_id=old_room, meeting_type="broadcast"
    )
    provider.disable.side_effect = ProviderUnavailable()
    stream = draft(host)
    payload = instruction(host, "provision", stream)
    assert call(host, payload, stream).status_code == 503
    stream.refresh_from_db()
    assert stream.state == "failed" and not stream.create_attempted
    assert call(host, payload, stream).status_code == 503
    provider.create.assert_not_called()
    provider.find.assert_not_called()
    provider.disable.side_effect = None
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "cleaned_up"
    assert (
        ProviderRoomCleanup.objects.get(provider_meeting_id=old_room).status
        == "complete"
    )
    provider.create.assert_not_called()
    provider.find.assert_not_called()


def test_idempotency_fingerprint_before_stale_version(host, provider):
    stream = draft(host)
    data = instruction(host, "provision", stream)
    first = call(host, data, stream)
    replay = call(host, data, stream)
    assert first.data == replay.data
    provider.create.assert_called_once()
    data["title"] = "Conflicting metadata"
    assert call(host, data, stream).data["code"] == "idempotency_mismatch"
    assert ProducerOperation.objects.count() == 2


def test_unknown_create_never_retries_cleanup_reconciles(host, provider):
    provider.create.side_effect = ProviderUnavailable()
    stream = draft(host)
    data = instruction(host, "provision", stream)
    assert call(host, data, stream).status_code == 503
    assert call(host, data, stream).status_code == 503
    provider.create.assert_called_once()
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "cleaned_up"
    provider.find.assert_called_once_with(f"f2z-producer-{stream.pk}")
    provider.disable.assert_called_once()


def test_empty_search_does_not_permit_recreate(host, provider):
    provider.create.side_effect = ProviderUnavailable()
    provider.find.side_effect = None
    provider.find.return_value = []
    stream = draft(host)
    act(host, stream, "provision")
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "failed" and stream.error_code == "cleanup_pending"
    assert call(host, instruction(host)).status_code == 409
    assert act(host, stream, "provision").status_code == 409
    provider.create.assert_called_once()


def test_paid_private_and_client_asserted_truth_refused(host, provider):
    for field, value in [
        ("access", "paid"),
        ("audience", "private"),
        ("audience", "subscribers"),
    ]:
        data = instruction(host)
        data[field] = value
        assert call(host, data).status_code == 422
    data = instruction(host)
    data["participants"] = 5
    assert call(host, data).status_code == 400
    assert not ProducerStream.objects.exists()
    provider.create.assert_not_called()


def test_unconfigured_and_auth_readiness(host, mocker):
    mocker.patch("dj.apps.dyte.producer.configured", return_value=False)
    stream = draft(host)
    assert act(host, stream, "provision").status_code == 503
    assert not stream.create_attempted
    client = APIClient()
    assert client.get("/api/dyte/producer/v1").status_code == 403
    client.force_authenticate(host)
    assert client.get("/api/dyte/producer/v1").data["ready"] is False


def test_takeover_revokes_old_token_replay_does_not_restore(host, provider):
    stream = ready(host)
    data = instruction(host, "refresh", stream)
    assert call(host, data, stream).data["auth_token"]
    stream.refresh_from_db()
    old_owner = stream.owner
    take = instruction(host, "takeover", stream)
    take["owner"] = str(uuid.uuid4())
    assert call(host, take, stream).status_code == 200
    stream.refresh_from_db()
    assert stream.owner != old_owner
    provider.retire.assert_called_once()
    assert call(host, data, stream).data["auth_token"] is None
    stale = instruction(host, "end", stream)
    stale["owner"] = str(old_owner)
    assert call(host, stale, stream).data["code"] == "owner_changed"


def test_grace_not_clean_end_cleanup_failure_recovery(host, provider):
    stream = ready(host)
    act(host, stream, "refresh")
    act(host, stream, "publish")
    assert act(host, stream, "interrupt").data["stream"]["state"] == "interrupted"
    assert stream.ended_at is None
    provider.disable.side_effect = ProviderUnavailable()
    ProducerStream.objects.filter(pk=stream.pk).update(
        interrupted_at=timezone.now() - timedelta(seconds=121)
    )
    producer.recover()
    stream.refresh_from_db()
    assert (
        stream.state == "ending"
        and stream.ended_at is None
        and stream.error_code == "cleanup_pending"
    )
    provider.disable.side_effect = None
    ProducerStream.objects.filter(pk=stream.pk).update(next_cleanup_at=timezone.now())
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "cleaned_up" and stream.ended_at


def test_token_timeout_no_mint_retry_end_disables(host, provider):
    stream = ready(host)
    provider.token.side_effect = ProviderUnavailable()
    assert act(host, stream, "refresh").status_code == 503
    assert act(host, stream, "refresh").status_code == 409
    assert provider.token.call_count == 1
    assert act(host, stream, "end").status_code == 200


def test_revoked_actor_after_provider_success(host, provider):
    from dj.apps.g12f.models import Creator

    stream = draft(host)
    original = host.kt_account_epoch

    def revoke(title):
        Creator.objects.filter(pk=host.pk).update(kt_account_epoch=original + 1)
        return str(uuid.uuid4())

    provider.create.side_effect = revoke
    assert act(host, stream, "provision").status_code == 401
    assert stream.state == "failed" and stream.room_id and not stream.meeting_id
    assert act(host, stream, "end").status_code == 401
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "cleaned_up"


def test_transition_table_exhaustive(host):
    stream = draft(host)
    for source, targets in producer.TRANSITIONS.items():
        for destination in producer.TRANSITIONS:
            stream.state = source
            if destination in targets:
                with producer.actor_lock(host.pk):
                    producer.transition(stream, destination)
                assert stream.state == destination
            else:
                with pytest.raises(producer.Refusal):
                    producer.transition(stream, destination)


@pytest.mark.django_db(transaction=True)
def test_concurrent_duplicate_and_end_vs_provision(host, provider):
    stream = draft(host)
    entered, release = threading.Event(), threading.Event()

    def wait_create(title):
        entered.set()
        assert release.wait(10)
        return str(uuid.uuid4())

    provider.create.side_effect = wait_create
    data = instruction(host, "provision", stream)
    result = []

    def run():
        close_old_connections()
        try:
            result.append(call(host, data, stream))
        finally:
            close_old_connections()

    worker = threading.Thread(target=run)
    worker.start()
    try:
        assert entered.wait(10)
        assert call(host, data, stream).data["code"] == "operation_in_progress"
        assert call(host, instruction(host, "end", stream), stream).status_code == 409
    finally:
        release.set()
        worker.join(15)
    assert not worker.is_alive() and result[0].status_code == 200
    assert act(host, stream, "end").status_code == 200
    provider.create.assert_called_once()


@pytest.mark.django_db(transaction=True)
def test_controlled_browser_real_django_flow(
    host, provider, live_server, client, tmp_path
):
    """Full public HTTP/CSRF/session/DB path, with controlled media and provider."""
    import os
    from pathlib import Path
    import subprocess

    root = Path(__file__).resolve().parents[5]
    esbuild = root / "ts/svelte/free2z/node_modules/.bin/esbuild"
    assert esbuild.is_file(), (
        "Install the locked web frontend dependencies for the controlled browser contract"
    )
    bundle = tmp_path / "producer.js"
    subprocess.run(
        [
            str(esbuild),
            str(root / "ts/free2z/producer/src/index.ts"),
            "--bundle",
            "--format=iife",
            "--global-name=Free2zProducer",
            f"--outfile={bundle}",
        ],
        check=True,
    )
    client.force_login(host)
    result = subprocess.run(
        [
            "node",
            str(root / "ts/svelte/free2z/tests/producer-browser-fixture.mjs"),
            live_server.url,
            client.cookies["sessionid"].value,
            "a" * 32,
            str(bundle),
            str(root / "ts/svelte/free2z/src/lib/locales/en.json"),
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=90,
        env=os.environ.copy(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    stream = ProducerStream.objects.get(creator=host)
    assert stream.state == "cleaned_up" and stream.ended_at
    provider.create.assert_called_once()
    provider.disable.assert_called_once()
    assert provider.token.call_count == 2
    provider.retire.assert_called_once()


def test_update_locks_metadata_and_other_actor_cannot_manage(
    host, provider, creator_factory
):
    stream = draft(host)
    data = instruction(host, "update", stream)
    data["title"] = "Updated title"
    assert call(host, data, stream).status_code == 200
    stream.refresh_from_db()
    assert stream.title == "Updated title"
    data = instruction(host, "provision", stream)
    data["description"] = "Conflicting description"
    assert call(host, data, stream).data["code"] == "metadata_mismatch"
    assert act(host, stream, "provision").status_code == 200
    assert act(host, stream, "update").status_code == 409
    other = creator_factory(username="other-producer", tuzis=1000)
    data = instruction(other, "end", stream)
    assert call(other, data, stream).status_code == 404
    provider.disable.assert_not_called()


def test_expired_heartbeat_termination_cleanup_bound_and_cancel_draft(host, provider):
    stream = ready(host)
    ProducerStream.objects.filter(pk=stream.pk).update(
        heartbeat_at=timezone.now() - timedelta(seconds=61)
    )
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "interrupted" and stream.ended_at is None
    ProducerStream.objects.filter(pk=stream.pk).update(
        interrupted_at=timezone.now() - timedelta(seconds=121),
        next_cleanup_at=timezone.now(),
    )
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "cleaned_up"
    new = draft(host)
    assert act(host, new, "end").status_code == 200
    assert new.ended_at and new.state == "cleaned_up"
    provider.disable.assert_called_once()


def test_provider_failure_not_live_and_idempotent_end(host, provider):
    stream = ready(host)
    act(host, stream, "refresh")
    provider.live.side_effect = ProviderUnavailable()
    assert act(host, stream, "publish").status_code == 503
    assert stream.state == "ready"
    assert not stream.meeting.live_now
    data = instruction(host, "end", stream)
    assert call(host, data, stream).status_code == 200
    assert call(host, data, stream).status_code == 200
    provider.disable.assert_called_once()


def test_adapter_official_transport_is_bounded_and_disable_requires_confirmation(
    settings, mocker
):
    from .producer_provider import ProducerProvider

    settings.RTK_PRODUCER_ACCOUNT_ID = "a" * 32
    settings.RTK_PRODUCER_APP_ID = settings.DYTE_ORG = "fixture-app"
    settings.RTK_PRODUCER_API_TOKEN = "fixture-not-a-live-token"
    settings.RTK_PRODUCER_HOST_PRESET = "fixture-preset"
    settings.DYTE_KEY = "fixture-compatibility-key"
    request = mocker.patch("dj.apps.dyte.producer_provider.requests.request")
    request.return_value.status_code = 200
    request.return_value.json.return_value = {
        "success": True,
        "data": {"status": "ACTIVE"},
    }
    adapter = ProducerProvider()
    with pytest.raises(ProviderUnavailable):
        adapter.disable(str(uuid.uuid4()))
    request.return_value.json.return_value = {
        "success": True,
        "data": {"status": "INACTIVE"},
    }
    room = str(uuid.uuid4())
    adapter.disable(room)
    assert request.call_args.args[0] == "PATCH"
    assert request.call_args.args[1].endswith(f"/meetings/{room}")
    assert request.call_args.kwargs["json"] == {"status": "INACTIVE"}
    assert request.call_args.kwargs["timeout"] == (
        settings.DYTE_CONNECT_TIMEOUT_SECONDS,
        settings.DYTE_READ_TIMEOUT_SECONDS,
    )


def test_host_token_replay_after_reauthentication_is_refused(host, provider):
    from dj.apps.g12f.models import Creator

    stream = ready(host)
    data = instruction(host, "refresh", stream)
    assert call(host, data, stream).data["auth_token"]
    Creator.objects.filter(pk=host.pk).update(
        kt_account_epoch=host.kt_account_epoch + 1
    )
    host.refresh_from_db()
    assert call(host, data, stream).status_code == 401
    assert act(host, stream, "end").status_code == 200


def test_producer_catalog_is_explicitly_unsupported_for_hosted_mcp():
    from dj.apps.mcpserver.catalog import operations, summary

    rows = [summary(op) for op in operations() if op.startswith("dyte_producer_v1_")]
    assert len(rows) == 5
    assert all(row["supported"] is False for row in rows)


@pytest.mark.django_db(transaction=True)
def test_duplicate_end_race_commits_one_provider_deactivation(host, provider):
    stream = ready(host)
    data = instruction(host, "end", stream)
    entered, release = threading.Event(), threading.Event()
    result = []

    def disable(room):
        entered.set()
        assert release.wait(10)

    provider.disable.side_effect = disable

    def run():
        close_old_connections()
        try:
            result.append(call(host, data, stream))
        finally:
            close_old_connections()

    worker = threading.Thread(target=run)
    worker.start()
    try:
        assert entered.wait(10)
        assert call(host, data, stream).data["code"] == "operation_in_progress"
    finally:
        release.set()
        worker.join(15)
    assert result[0].status_code == 200
    assert call(host, data, stream).status_code == 200
    provider.disable.assert_called_once()


def test_provider_live_requires_current_host_not_only_viewer_count(settings, mocker):
    from .producer_provider import ProducerProvider

    mocker.patch("dj.apps.dyte.producer_provider.configured", return_value=True)
    provider = ProducerProvider()
    room, session, participant = [str(uuid.uuid4()) for _ in range(3)]
    request = mocker.patch.object(provider, "request")
    for host in [
        {},
        {
            "user_id": participant,
            "joined_at": "2026-11-12T00:00:00Z",
            "left_at": "2026-11-12T01:00:00Z",
        },
        {"user_id": str(uuid.uuid4()), "joined_at": "2026-11-12T00:00:00Z"},
    ]:
        request.side_effect = [
            {"id": session, "status": "LIVE", "live_participants": 10},
            {"participant": host},
        ]
        with pytest.raises(ProviderUnavailable):
            provider.live(room, participant)
    request.side_effect = [
        {"id": session, "status": "LIVE", "live_participants": 10},
        {
            "participant": {
                "user_id": participant,
                "joined_at": "2026-11-12T00:00:00Z",
                "left_at": None,
            }
        },
    ]
    assert provider.live(room, participant) == (session, 10)
    assert request.call_args.args == (
        "GET",
        f"/sessions/{session}/participants/{participant}",
    )


def test_live_heartbeat_without_fresh_provider_truth_enters_grace(host, provider):
    stream = ready(host)
    act(host, stream, "refresh")
    act(host, stream, "publish")
    ProducerStream.objects.filter(pk=stream.pk).update(
        confirmed_at=timezone.now() - timedelta(seconds=61), heartbeat_at=timezone.now()
    )
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "interrupted" and stream.ended_at is None


def test_same_owner_live_reload_can_refresh_without_provisioning_again(host, provider):
    stream = ready(host)
    act(host, stream, "refresh")
    act(host, stream, "publish")
    result = act(host, stream, "refresh")
    assert result.status_code == 200 and result.data["auth_token"]
    assert stream.state == "interrupted"
    stream.meeting.refresh_from_db()
    assert stream.meeting.live_now is False
    provider.create.assert_called_once()
    provider.retire.assert_called_once()


def test_legacy_sweep_cannot_override_versioned_presence(host, provider, mocker):
    from .tasks import sweep_live_meetings

    stream = ready(host)
    assert act(host, stream, "refresh").status_code == 200
    assert act(host, stream, "publish").status_code == 200
    legacy_probe = mocker.patch(
        "dj.apps.dyte.client.DyteClient.get_participants_count", return_value=0
    )
    sweep_live_meetings(0)
    legacy_probe.assert_not_called()
    stream.refresh_from_db()
    stream.meeting.refresh_from_db()
    assert stream.state == "live" and stream.meeting.live_now


def test_reserved_host_identity_cannot_be_selected_by_a_viewer(
    host, provider, creator_factory, mocker
):
    stream = ready(host)
    act(host, stream, "refresh")
    act(host, stream, "publish")
    viewer = creator_factory(username=f"producer:{uuid.uuid4()}", tuzis=1000)
    legacy = mocker.patch("dj.apps.dyte.views.DyteClient")
    client = APIClient()
    client.force_authenticate(viewer)
    response = client.post(
        f"/api/dyte/{host.username}/broadcast", {"role": "viewer"}, format="json"
    )
    assert response.status_code == 409
    legacy.return_value.add_participant.assert_not_called()


def test_backend_policy_refusal_happens_before_provider_or_operation(
    host, provider, mocker
):
    stream = draft(host)
    mocker.patch(
        "dj.apps.economy.epoch.pin_supported_policy",
        side_effect=RuntimeError("fixture fenced policy"),
    )
    response = act(host, stream, "provision")
    assert (
        response.status_code == 503
        and response.data["code"] == "billing_policy_unavailable"
    )
    assert stream.state == "draft" and stream.create_attempted is False
    provider.create.assert_not_called()
    assert ProducerOperation.objects.filter(stream=stream).count() == 1


def test_terminal_end_with_new_key_needs_no_provider_configuration(
    host, provider, mocker
):
    stream = ready(host)
    assert act(host, stream, "end").status_code == 200
    constructor = mocker.patch(
        "dj.apps.dyte.producer.ProducerProvider", side_effect=ProviderUnavailable()
    )
    assert act(host, stream, "end").status_code == 200
    constructor.assert_not_called()


def test_openapi_instruction_is_closed_and_versioned():
    from pathlib import Path
    import yaml

    schema = yaml.safe_load(
        (Path(__file__).parents[2] / "free2z/openapi/f2z.yaml").read_text()
    )
    instruction = schema["components"]["schemas"]["ProducerInstruction"]
    assert instruction["additionalProperties"] is False
    assert {"expected_actor_id", "owner", "version", "idempotency_key"} <= set(
        instruction["required"]
    )
    assert "/api/dyte/producer/v1/{stream_id}" in schema["paths"]
