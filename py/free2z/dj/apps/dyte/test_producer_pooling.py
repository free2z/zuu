"""Durable producer ownership across real transaction pooling and worker loss."""

import json
import os
from pathlib import Path
import subprocess
import threading
import uuid
from datetime import timedelta

import psycopg
import pytest
from django.db import connection, close_old_connections, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from . import producer
from .models import ProducerActorClaim, ProducerStream, ProducerOperation
from .test_producer import host as host, provider as provider
from .test_producer import act, call, draft, instruction, ready
from .test_producer import test_controlled_browser_real_django_flow as browser_flow

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def pooled_db():
    port = os.environ.get("LEDGER_TEST_POOLER_PORT")
    if not port:
        pytest.skip("requires the owned real PgBouncer transaction-pool fixture")
    config = connection.settings_dict
    original = config["PORT"]
    with psycopg.connect(
        host=config["HOST"],
        port=port,
        dbname="pgbouncer",
        user=config["USER"],
        password=config["PASSWORD"],
        autocommit=True,
        prepare_threshold=None,
    ) as admin:
        values = {row[0]: row[1] for row in admin.execute("SHOW CONFIG")}
        assert values["pool_mode"] == "transaction"
        assert values["default_pool_size"] == "1"
        assert values["max_db_connections"] == "1"
    connection.close()
    config["PORT"] = port
    try:
        yield
    finally:
        connection.close()
        config["PORT"] = original


def observe(sql, params):
    config = connection.settings_dict
    with psycopg.connect(
        host=config["HOST"],
        port=config["PORT"],
        dbname=config["NAME"],
        user=config["USER"],
        password=config["PASSWORD"],
        autocommit=True,
        connect_timeout=3,
        prepare_threshold=None,
    ) as other:
        return other.execute(sql, params).fetchone()


def test_real_single_backend_pool_commits_markers_and_refuses_overlap(
    host, provider, pooled_db, mocker
):
    stream = draft(host)
    entered, release = threading.Event(), threading.Event()
    original_create = provider.create.return_value
    payload = instruction(host, "provision", stream)
    responses = []

    def create(title):
        assert not connection.in_atomic_block
        entered.set()
        assert release.wait(15)
        return original_create

    provider.create.side_effect = create

    def worker():
        close_old_connections()
        try:
            responses.append(call(host, payload, stream))
        finally:
            connection.close()

    thread = threading.Thread(target=worker)
    thread.start()
    try:
        assert entered.wait(10)
        assert observe(
            "SELECT create_attempted,state FROM dyte_producerstream WHERE id=%s",
            [stream.pk],
        ) == (True, "provisioning")
        # A transaction-level lock is already released. The committed claim,
        # not affinity to a pinned backend, excludes the overlapping request.
        assert observe(
            "SELECT pg_try_advisory_xact_lock(hashtext(%s)::bigint)",
            [f"dyte-host-seat:{host.pk}"],
        ) == (True,)
        assert call(host, payload, stream).data["code"] == "operation_in_progress"
        producer.recover()
        provider.disable.assert_not_called()
        legacy = mocker.patch("dj.apps.dyte.views.DyteClient")
        client = APIClient()
        client.force_authenticate(host)
        assert (
            client.post(
                f"/api/dyte/{host.username}/broadcast", {}, format="json"
            ).status_code
            == 409
        )
        legacy.return_value.add_participant.assert_not_called()
    finally:
        release.set()
        thread.join(15)
    assert not thread.is_alive() and responses[0].status_code == 200
    assert call(host, payload, stream).status_code == 200
    provider.create.assert_called_once()

    token_result = provider.token.return_value

    def mint(room, custom_id, creator):
        assert not connection.in_atomic_block
        assert observe(
            "SELECT token_attempted,token_ciphertext FROM dyte_producerstream WHERE id=%s",
            [stream.pk],
        ) == (True, "")
        return token_result

    provider.token.side_effect = mint
    assert act(host, stream, "refresh").status_code == 200
    assert act(host, stream, "end").status_code == 200
    provider.disable.assert_called_once()


def test_controlled_browser_roundtrip_through_transaction_pool(
    host,
    provider,
    pooled_db,
    live_server,
    client,
    tmp_path,
):
    browser_flow(host, provider, live_server, client, tmp_path)


def test_claim_blocks_legacy_even_before_a_stream_exists(host, provider, mocker):
    legacy = mocker.patch("dj.apps.dyte.views.DyteClient")
    with producer.actor_lock(host.pk):
        assert not ProducerStream.objects.exists()
        client = APIClient()
        client.force_authenticate(host)
        response = client.post(
            f"/api/dyte/{host.username}/broadcast", {}, format="json"
        )
        assert response.status_code == 409
        legacy.return_value.add_participant.assert_not_called()


def test_outer_transaction_is_refused_before_provider_io(host, provider):
    stream = draft(host)
    with transaction.atomic():
        result = call(host, instruction(host, "provision", stream), stream)
    assert (
        result.status_code == 503
        and result.data["code"] == "producer_requires_autocommit"
    )
    provider.create.assert_not_called()


@pytest.mark.parametrize("pooled", [False, True], ids=["direct", "transaction-pool"])
def test_expired_worker_cannot_finalize_or_clear_successor_claim(
    host, provider, request, pooled
):
    if pooled:
        request.getfixturevalue("pooled_db")
    stream = draft(host)
    payload = instruction(host, "provision", stream)
    entered, release = threading.Event(), threading.Event()
    room = provider.create.return_value
    responses = []

    def create(title):
        entered.set()
        assert release.wait(15)
        return room

    provider.create.side_effect = create

    def worker():
        close_old_connections()
        try:
            responses.append(call(host, payload, stream))
        finally:
            connection.close()

    thread = threading.Thread(target=worker)
    thread.start()
    try:
        assert entered.wait(10)
        ProducerActorClaim.objects.filter(creator=host).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        # Expiry alone never admits a replacement create/token request.
        assert call(host, payload, stream).data["code"] == "operation_in_progress"
        with producer.actor_lock(host.pk, recovery=True) as successor:
            assert successor.reclaimed
            stream.refresh_from_db()
            producer.transition(stream, "ending")
            producer.cleanup(stream, provider)
            assert stream.state == "cleaned_up"
            release.set()
            thread.join(10)
            assert not thread.is_alive() and responses[0].status_code == 409
            assert ProducerActorClaim.objects.get(creator=host).token == successor.token
            with producer.fenced():
                stream.refresh_from_db()
                assert stream.state == "cleaned_up" and str(stream.room_id) == room
    finally:
        release.set()
        thread.join(15)
    replay = call(host, payload, stream)
    assert replay.status_code == 202 and replay.data["stream"]["state"] == "cleaned_up"
    provider.create.assert_called_once()
    provider.disable.assert_called_once()


def test_recovery_releases_expired_claim_without_a_stream(host, provider):
    ProducerActorClaim.objects.create(
        creator=host,
        token=uuid.uuid4(),
        expires_at=timezone.now() - timedelta(seconds=1),
    )
    assert call(host, instruction(host)).data["code"] == "operation_in_progress"
    producer.recover()
    assert ProducerActorClaim.objects.get(creator=host).token is None
    assert draft(host).state == "draft"
    provider.create.assert_not_called()


def test_account_purge_fences_a_late_provider_result_without_restoring_content(
    host, provider
):
    from dj.apps.g12f import account_deletion

    stream = draft(host)
    room = provider.create.return_value

    def delete_during_provider_io(title):
        account_deletion.schedule_deletion(
            host, confirm_username=host.username, auth_epoch=host.kt_account_epoch
        )
        account_deletion.purge_due_deletions(
            now=timezone.now() + account_deletion.GRACE_PERIOD + timedelta(seconds=1)
        )
        return room

    provider.create.side_effect = delete_during_provider_io
    assert act(host, stream, "provision").status_code == 401
    stream.refresh_from_db()
    assert stream.create_attempted and stream.room_id is None
    assert (stream.title, stream.description, stream.token_ciphertext) == ("", "", "")
    assert stream.state == "ending"
    producer.recover()
    stream.refresh_from_db()
    assert stream.state == "cleaned_up" and str(stream.room_id) == room
    assert stream.title == "" and stream.token_ciphertext == ""
    provider.disable.assert_called_once_with(room)


@pytest.mark.parametrize("action", ["provision", "refresh"])
def test_process_death_preserves_committed_ambiguity_through_real_pool(
    host,
    provider,
    pooled_db,
    tmp_path,
    action,
):
    stream = draft(host) if action == "provision" else ready(host)
    payload = instruction(host, action, stream)
    room = str(uuid.uuid4()) if action == "provision" else str(stream.room_id)
    proof = tmp_path / "provider.json"
    # A process really exits after the controlled provider accepted the POST;
    # no Python finally/context-manager release can clean up for it.
    script = """
import django, json, os, sys
from pathlib import Path
from unittest.mock import patch
django.setup()
from django.conf import settings
settings.ALLOWED_HOSTS = ["testserver"]
from dj.apps.g12f.models import Creator
from rest_framework.test import APIClient
from django.db import connection
actor_id, target, payload, proof, room, action = sys.argv[1:]
def accepted(*args):
    assert not connection.in_atomic_block
    Path(proof).write_text(json.dumps({"room":room,"action":action}))
    os._exit(71)
with patch("dj.apps.dyte.producer.configured", return_value=True), patch("dj.apps.dyte.producer.ProducerProvider") as p:
    getattr(p.return_value, "create" if action == "provision" else "token").side_effect=accepted
    client=APIClient(); client.force_authenticate(Creator.objects.get(pk=int(actor_id)))
    client.post(target,json.loads(payload),format="json")
raise AssertionError("provider crash was not reached")
"""
    config = connection.settings_dict
    root = Path(__file__).resolve().parents[5]
    env = {
        **os.environ,
        "PYTHONPATH": str(root / "py/free2z"),
        "DJANGO_SETTINGS_MODULE": "pytest_settings",
        "DBHOST": config["HOST"],
        "DBPORT": str(config["PORT"]),
        "DBNAME": config["NAME"],
        "DBUSER": config["USER"],
        "DBPASS": config["PASSWORD"],
    }
    result = subprocess.run(
        [
            os.sys.executable,
            "-c",
            script,
            str(host.pk),
            f"/api/dyte/producer/v1/{stream.pk}",
            json.dumps(payload),
            str(proof),
            room,
            action,
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 71, result.stdout + result.stderr
    assert json.loads(proof.read_text()) == {"room": room, "action": action}
    stream.refresh_from_db()
    assert stream.create_attempted if action == "provision" else stream.token_attempted
    assert ProducerActorClaim.objects.get(creator=host).token is not None
    assert (
        ProducerOperation.objects.get(
            creator=host, key=payload["idempotency_key"]
        ).status
        == 202
    )
    assert call(host, payload, stream).data["code"] == "operation_in_progress"
    ProducerActorClaim.objects.filter(creator=host).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    provider.find.return_value = []
    provider.find.side_effect = None
    producer.recover()
    stream.refresh_from_db()
    if action == "provision":
        assert stream.state == "ending" and stream.error_code == "cleanup_pending"
        assert act(host, stream, "provision").status_code == 409
        provider.find.return_value = [room]
        ProducerStream.objects.filter(pk=stream.pk).update(
            next_cleanup_at=timezone.now()
        )
        producer.recover()
    stream.refresh_from_db()
    assert stream.state == "cleaned_up" and stream.token_ciphertext == ""
    assert call(host, payload, stream).data["auth_token"] is None
    provider.disable.assert_called_once_with(room)
