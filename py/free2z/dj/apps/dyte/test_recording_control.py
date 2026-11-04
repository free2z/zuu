import uuid
from datetime import timedelta
from decimal import Decimal
import pytest
import requests
from django.core.cache import cache
from django.utils import timezone
from dj.apps.dyte import recording_control as rc
from dj.apps.dyte.models import CreatorMeeting

pytestmark = pytest.mark.django_db


@pytest.fixture
def room(api_client, creator_factory):
    cache.clear()
    host = creator_factory(tuzis=Decimal("1000"))
    cm = CreatorMeeting.objects.create(
        creator=host,
        meeting_id=str(uuid.uuid4()),
        meeting_type="broadcast",
        live_now=True,
        host_session_id=uuid.uuid4(),
        host_session_seen_at=timezone.now(),
    )
    api_client.force_authenticate(host)
    yield api_client, cm, f"/api/dyte/{host.username}/recording"
    cache.clear()


def rec(cm, state="RECORDING"):
    return {
        "id": str(uuid.uuid4()),
        "meeting_id": cm.meeting_id,
        "status": state,
        "download_url": "secret-url",
        "session_id": None,
    }


def call(room, method="get", **extra):
    client, cm, url = room
    data = {"host_session": str(cm.host_session_id), **extra}
    if method == "post":
        return client.post(url, data, format="json")
    if method == "delete":
        return client.post(url + "/stop", data, format="json")
    return getattr(client, method)(url + "?host_session=" + data["host_session"])


def test_owner_status_exposes_only_state(room, mocker):
    provider = mocker.patch.object(rc, "provider", return_value=rec(room[1]))
    assert call(room).data == {"recording_state": "RECORDING"}
    provider.assert_called_once()


def test_foreign_owner_and_stale_seat_never_call_provider(
    room, creator_factory, mocker
):
    provider = mocker.patch.object(rc, "provider")
    room[0].force_authenticate(creator_factory(tuzis=Decimal("1000")))
    assert call(room, "post").status_code == 403
    room[0].force_authenticate(room[1].creator)
    assert call(room, "post", host_session=str(uuid.uuid4())).status_code == 409
    room[1].host_session_seen_at = timezone.now() - timedelta(hours=1)
    room[1].save()
    assert call(room, "delete").status_code == 409
    provider.assert_not_called()


def test_wrong_provider_meeting_and_unknown_state_fail_closed(room, mocker):
    data = rec(room[1])
    data["meeting_id"] = str(uuid.uuid4())
    provider = mocker.patch.object(rc, "provider", return_value=data)
    assert call(room, "delete").status_code == 503
    assert provider.call_count == 1
    data["meeting_id"] = room[1].meeting_id
    data["status"] = "MYSTERY"
    assert call(room, "post").status_code == 503


def test_start_fixed_url_and_repeat_returns_existing(room, mocker, settings):
    settings.CANONICAL_ORIGIN = "https://stage.example"
    result = rec(room[1], "INVOKED")
    provider = mocker.patch.object(rc, "provider", side_effect=[None, result, result])
    mocker.patch.object(rc, "can_record", return_value=True)
    mocker.patch.object(rc, "recorder_ready", return_value=True)
    assert (
        call(
            room, "post", url="https://attacker.example", meeting_id="other"
        ).status_code
        == 200
    )
    assert call(room, "post").data == {"recording_state": "INVOKED"}
    creates = [c for c in provider.call_args_list if c.args[0] == "POST"]
    assert len(creates) == 1
    assert creates[0].kwargs["payload"] == {
        "meeting_id": room[1].meeting_id,
        "url": "https://stage.example/tools/recording/index.html",
        "max_seconds": rc.MAX_SECONDS,
    }


def test_ambiguous_start_blocks_retries(room, mocker):
    provider = mocker.patch.object(
        rc, "provider", side_effect=[None, requests.Timeout(), None]
    )
    mocker.patch.object(rc, "can_record", return_value=True)
    mocker.patch.object(rc, "recorder_ready", return_value=True)
    assert call(room, "post").status_code == 503
    assert call(room, "post").status_code == 503
    assert sum(c.args[0] == "POST" for c in provider.call_args_list) == 1


def test_disabled_preset_cannot_start(room, mocker):
    provider = mocker.patch.object(rc, "provider", return_value=None)
    mocker.patch.object(rc, "can_record", return_value=False)
    assert call(room, "post").status_code == 403
    assert provider.call_count == 1


def test_stop_and_poll_upload(room, mocker):
    current = rec(room[1])
    uploaded = {**current, "status": "UPLOADED"}
    provider = mocker.patch.object(
        rc, "provider", side_effect=[current, {"id": current["id"]}, None, uploaded]
    )
    assert call(room, "delete").data == {"recording_state": "STOPPING"}
    assert provider.call_args_list[1].args == ("PUT", f"recordings/{current['id']}")
    assert call(room).data == {"recording_state": "UPLOADED"}


def test_provider_only_accepts_explicit_empty_404(mocker):
    response = mocker.Mock(ok=False, status_code=404)
    response.json.return_value = {
        "success": False,
        "error": {"code": 404, "message": "No active recording for meeting x found"},
    }
    request = mocker.patch.object(rc.requests, "request", return_value=response)
    assert rc.provider("GET", "recordings/active-recording/x", allow_empty=True) is None
    assert request.call_args.kwargs["timeout"] == rc.PROVIDER_TIMEOUT
    response.json.return_value = {"error": []}
    with pytest.raises(rc.ProviderUnavailable):
        rc.provider("GET", "recordings/active-recording/x", allow_empty=True)
    response.json.return_value = {"error": {"code": 404, "message": "Not found"}}
    with pytest.raises(rc.ProviderUnavailable):
        rc.provider("GET", "recordings/active-recording/x", allow_empty=True)


def test_can_record_resolves_preset_permission(mocker):
    preset = str(uuid.uuid4())
    provider = mocker.patch.object(
        rc,
        "provider",
        side_effect=[
            [{"name": "webinar1", "id": preset}],
            {"permissions": {"can_record": False}},
        ],
    )
    assert rc.can_record() is False
    assert provider.call_args_list[1].args == ("GET", f"presets/{preset}")


def test_low_balance_can_check_and_stop_but_cannot_start(room, mocker):
    type(room[1].creator).objects.filter(pk=room[1].creator.pk).update(tuzis=0)
    room[1].creator.refresh_from_db()
    room[0].force_authenticate(room[1].creator)
    current = rec(room[1])
    provider = mocker.patch.object(
        rc, "provider", side_effect=[current, current, {"id": current["id"]}]
    )
    assert call(room).status_code == 200
    assert call(room, "delete").status_code == 200
    assert call(room, "post").status_code == 403
    assert provider.call_count == 3


@pytest.mark.parametrize(
    "body",
    [None, {}, [{"name": "webinar1"}], [{"name": "other", "id": str(uuid.uuid4())}]],
)
def test_malformed_or_missing_preset_fails_closed(body, mocker):
    mocker.patch.object(rc, "provider", return_value=body)
    with pytest.raises((rc.ProviderUnavailable, KeyError, ValueError, TypeError)):
        rc.can_record()


def test_readiness_gate_sends_no_token_and_requires_dedicated_marker(mocker, settings):
    settings.CANONICAL_ORIGIN = "https://canonical.example"
    response = mocker.Mock(status_code=200, headers={})
    request = mocker.patch.object(rc.requests, "get", return_value=response)
    assert rc.recorder_ready() is False
    response.headers = {"X-Free2Z-Recorder-Ready": "1"}
    assert rc.recorder_ready() is True
    assert request.call_args.args == (
        "https://canonical.example/tools/recording/index.html",
    )
    assert request.call_args.kwargs["allow_redirects"] is False
    assert "auth" not in request.call_args.kwargs
    assert "cookies" not in request.call_args.kwargs


def test_missing_recorder_marker_prevents_provider_start(room, mocker):
    provider = mocker.patch.object(rc, "provider", return_value=None)
    mocker.patch.object(rc, "can_record", return_value=True)
    mocker.patch.object(rc, "recorder_ready", return_value=False)
    assert call(room, "post").status_code == 503
    assert provider.call_count == 1


def test_definite_rejection_allows_explicit_retry(room, mocker):
    result = rec(room[1], "INVOKED")
    provider = mocker.patch.object(
        rc, "provider", side_effect=[None, rc.ProviderRejected(), None, result]
    )
    mocker.patch.object(rc, "can_record", return_value=True)
    mocker.patch.object(rc, "recorder_ready", return_value=True)
    assert call(room, "post").status_code == 503
    assert call(room, "post").status_code == 200
    assert sum(c.args[0] == "POST" for c in provider.call_args_list) == 2


@pytest.mark.django_db(transaction=True)
def test_concurrent_starts_are_serialized(room, mocker):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from django.db import close_old_connections, connections
    from rest_framework.test import APIClient

    entered, release = Event(), Event()
    result = rec(room[1], "INVOKED")
    active = None
    starts = []

    def provider(method, path, **kwargs):
        nonlocal active
        if method == "GET":
            return active
        starts.append(path)
        entered.set()
        assert release.wait(10)
        active = result
        return result

    mocker.patch.object(rc, "provider", side_effect=provider)
    mocker.patch.object(rc, "can_record", return_value=True)
    mocker.patch.object(rc, "recorder_ready", return_value=True)

    def invoke():
        close_old_connections()
        try:
            client = APIClient()
            client.force_authenticate(room[1].creator)
            return client.post(
                room[2], {"host_session": str(room[1].host_session_id)}, format="json"
            ).status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(invoke)
        assert entered.wait(10)
        second = pool.submit(invoke)
        release.set()
        assert first.result(10) == second.result(10) == 200
    assert starts == ["recordings"]


def test_status_cache_has_no_row_lock_and_mutation_bypasses_and_invalidates_it(
    room, mocker
):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    result = rec(room[1], "INVOKED")
    provider = mocker.patch.object(
        rc, "provider", side_effect=[None, None, result, result]
    )
    mocker.patch.object(rc, "can_record", return_value=True)
    mocker.patch.object(rc, "recorder_ready", return_value=True)
    with CaptureQueriesContext(connection) as queries:
        assert call(room).data == {"recording_state": "IDLE"}
    assert not any("FOR UPDATE" in q["sql"] for q in queries)
    assert call(room).data == {"recording_state": "IDLE"}
    assert provider.call_count == 1
    assert call(room, "post").data == {"recording_state": "INVOKED"}
    assert call(room).data == {"recording_state": "INVOKED"}
    assert provider.call_count == 4


def test_provider_outage_opens_short_shared_circuit(mocker):
    cache.clear()
    request = mocker.patch.object(
        rc.requests, "request", side_effect=requests.Timeout()
    )
    with pytest.raises(requests.Timeout):
        rc.provider("GET", "recordings/active-recording/x")
    with pytest.raises(rc.ProviderUnavailable):
        rc.provider("GET", "recordings/active-recording/y")
    assert request.call_count == 1
    cache.clear()


def test_late_terminal_poll_cannot_clear_new_ambiguous_start(room, mocker):
    cm = room[1]
    previous = rec(cm, "UPLOADED")
    key = f"rtk-recording:{cm.meeting_id}"
    cache.set(key, previous["id"])
    newer = str(uuid.uuid4())

    def late_detail(method, path, **kwargs):
        if "active-recording" in path:
            return None
        # A newer POST acquired the row, set admission, and timed out while
        # this earlier status read was waiting on the old recording detail.
        cache.set(f"{key}:pending", newer)
        return previous

    mocker.patch.object(rc, "provider", side_effect=late_detail)
    assert call(room).data == {"recording_state": "UPLOADED"}
    assert cache.get(f"{key}:pending") == newer
    assert call(room, "post").status_code == 503
    assert cache.get(f"{key}:pending") == newer


def test_late_active_poll_never_changes_authoritative_recording_or_pending(
    room, mocker
):
    cm = room[1]
    key = f"rtk-recording:{cm.meeting_id}:pending"
    older, newer = str(uuid.uuid4()), str(uuid.uuid4())
    cache.set(key, older)
    last_key = f"rtk-recording:{cm.meeting_id}"
    old_recording, new_recording = rec(cm), rec(cm)
    cache.set(last_key, old_recording["id"])

    def late_active(*args, **kwargs):
        cache.set(key, newer)
        cache.set(last_key, new_recording["id"])
        return old_recording

    mocker.patch.object(rc, "provider", side_effect=late_active)
    assert call(room).status_code == 200
    assert cache.get(key) == newer
    cache.delete(f"rtk-recording-status:{cm.meeting_id}")
    assert cache.get(last_key) == new_recording["id"]
    mocker.patch.object(rc, "provider", return_value=new_recording)
    assert call(room).status_code == 200
    assert cache.get(key) == newer
    assert cache.get(last_key) == new_recording["id"]
    assert call(room, "post").status_code == 200
    assert cache.get(key) is None


def test_stop_requires_post_body_and_never_accepts_query_authority(room, mocker):
    client, cm, url = room
    provider = mocker.patch.object(rc, "provider")
    query = "?host_session=" + str(cm.host_session_id)
    assert client.get(url + "/stop" + query).status_code == 405
    assert client.delete(url + query).status_code == 405
    assert client.post(url + "/stop" + query, {}, format="json").status_code == 400
    provider.assert_not_called()


@pytest.mark.parametrize('meeting_type', ['broadcast', 'subscribers-only', 'ppv'])
def test_every_public_mode_records_existing_host_room(room, mocker, meeting_type):
    client, cm, url = room
    cm.meeting_type = meeting_type
    cm.save(update_fields=['meeting_type'])
    result = rec(cm, 'INVOKED')
    provider = mocker.patch.object(rc, 'provider', side_effect=[None, result])
    mocker.patch.object(rc, 'can_record', return_value=True)
    mocker.patch.object(rc, 'recorder_ready', return_value=True)
    assert call(room, 'post').data == {'recording_state': 'INVOKED'}
    assert provider.call_args.kwargs['payload']['meeting_id'] == cm.meeting_id
    cm.refresh_from_db()
    assert cm.meeting_type == meeting_type
    assert CreatorMeeting.objects.filter(creator=cm.creator).count() == 1


@pytest.fixture
def private_room(room):
    client, cm, _ = room
    cm.meeting_type = 'private'
    cm.secret = uuid.uuid4()
    cm.is_public = False
    cm.host_session_id = None
    cm.host_session_seen_at = None
    cm.save()
    return client, cm, f'/api/dyte/{cm.creator.username}/private/{cm.secret}/recording'


def test_private_recording_targets_same_room_and_never_creates_public_room(private_room, mocker):
    client, cm, url = private_room
    current = rec(cm, 'INVOKED')
    provider = mocker.patch.object(rc, 'provider', side_effect=[None, current, current, current, current, {'id': current['id']}])
    mocker.patch.object(rc, 'can_record', return_value=True)
    mocker.patch.object(rc, 'recorder_ready', return_value=True)
    create_room = mocker.patch('dj.apps.dyte.client.DyteClient.create_meeting')
    assert client.post(url, {}, format='json').data == {'recording_state': 'INVOKED'}
    assert client.post(url, {}, format='json').data == {'recording_state': 'INVOKED'}
    assert client.get(url).data == {'recording_state': 'INVOKED'}
    assert client.post(url + '/stop', {}, format='json').data == {'recording_state': 'STOPPING'}
    starts = [c for c in provider.call_args_list if c.args[0] == 'POST']
    assert len(starts) == 1
    assert starts[0].kwargs['payload']['meeting_id'] == cm.meeting_id
    assert starts[0].kwargs['payload']['url'].endswith('/tools/recording/index.html')
    create_room.assert_not_called()
    cm.refresh_from_db()
    assert cm.is_public is False
    assert cm.meeting_type == 'private'
    assert CreatorMeeting.objects.filter(creator=cm.creator).count() == 1


@pytest.mark.parametrize('action', ['status', 'start', 'stop'])
def test_private_recording_requires_owner_and_current_secret(private_room, creator_factory, mocker, action):
    client, cm, url = private_room
    provider = mocker.patch.object(rc, 'provider')
    def request(path):
        if action == 'status':
            return client.get(path)
        return client.post(path + ('/stop' if action == 'stop' else ''), {}, format='json')
    client.force_authenticate(creator_factory())
    assert request(url).status_code == 403
    client.force_authenticate(cm.creator)
    assert request(url.replace(str(cm.secret), str(uuid.uuid4()))).status_code == 404
    cm.secret = uuid.uuid4()
    cm.save(update_fields=['secret'])
    assert request(url).status_code == 404
    provider.assert_not_called()


def test_private_recording_cannot_target_public_room_or_e2ee(private_room, mocker):
    client, cm, url = private_room
    provider = mocker.patch.object(rc, 'provider')
    cm.e2ee = True
    cm.save(update_fields=['e2ee'])
    assert client.post(url, {}, format='json').status_code == 403
    cm.e2ee = False
    cm.is_public = True
    cm.meeting_type = 'ppv'
    cm.save()
    assert client.post(url, {}, format='json').status_code == 404
    provider.assert_not_called()


@pytest.mark.parametrize('action', ['status', 'start', 'stop'])
def test_private_recording_requires_authentication(private_room, mocker, action):
    client, _, url = private_room
    client.force_authenticate(None)
    provider = mocker.patch.object(rc, 'provider')
    response = client.get(url) if action == 'status' else client.post(
        url + ('/stop' if action == 'stop' else ''), {}, format='json'
    )
    assert response.status_code in (401, 403)
    provider.assert_not_called()


def test_private_recording_preserves_host_eligibility_and_preset(private_room, mocker):
    client, cm, url = private_room
    provider = mocker.patch.object(rc, 'provider', return_value=None)
    mocker.patch.object(rc, 'can_record', return_value=False)
    assert client.post(url, {}, format='json').status_code == 403
    assert provider.call_count == 1
    provider.reset_mock()
    cm.creator.tuzis = Decimal('0')
    cm.creator.save(update_fields=['tuzis'])
    assert client.post(url, {}, format='json').status_code == 403
    provider.assert_not_called()


@pytest.mark.parametrize('state', ['INVOKED', 'RECORDING', 'PAUSED', 'STOPPING', 'UPLOADING', 'UPLOADED'])
def test_private_link_rotation_waits_for_recording_delivery(private_room, mocker, state):
    client, cm, url = private_room
    current = rec(cm, state)
    mocker.patch.object(rc, 'provider', return_value=current)
    create = mocker.patch('dj.apps.dyte.views._create_meeting')
    response = client.post(f'/api/dyte/{cm.creator.username}/private', {}, format='json')
    assert response.status_code == 409
    create.assert_not_called()
    old = (cm.meeting_id, cm.secret)
    cm.refresh_from_db()
    assert (cm.meeting_id, cm.secret) == old
    assert client.get(url).status_code == 200


@pytest.mark.parametrize("uncertain", ["timeout", "pending"])
def test_private_link_rotation_fails_closed_on_uncertain_recording(private_room, mocker, uncertain):
    client, cm, _ = private_room
    if uncertain == 'timeout':
        mocker.patch.object(rc, 'provider', side_effect=requests.Timeout())
    else:
        mocker.patch.object(rc, 'provider', return_value=None)
        cache.set(f'rtk-recording:{cm.meeting_id}:pending', True, 60)
    create = mocker.patch('dj.apps.dyte.views._create_meeting')
    response = client.post(f'/api/dyte/{cm.creator.username}/private', {}, format='json')
    assert response.status_code == 503
    create.assert_not_called()
    old = (cm.meeting_id, cm.secret)
    cm.refresh_from_db()
    assert (cm.meeting_id, cm.secret) == old


def test_private_link_rotation_allows_ingested_recording(private_room, mocker):
    from dj.apps.dyte.models import RecordingDelivery
    client, cm, _ = private_room
    current = rec(cm, 'UPLOADED')
    RecordingDelivery.objects.create(idempotency_key=current['id'], completed_at=timezone.now())
    mocker.patch.object(rc, 'provider', return_value=current)
    create = mocker.patch('dj.apps.dyte.views._create_meeting', side_effect=lambda room: room)
    response = client.post(f'/api/dyte/{cm.creator.username}/private', {}, format='json')
    assert response.status_code == 200
    create.assert_called_once()
    old_secret = cm.secret
    cm.refresh_from_db()
    assert cm.secret != old_secret


def test_private_link_reports_terminal_recording_delivery_failure(private_room, mocker):
    from dj.apps.dyte.models import RecordingDelivery
    client, cm, _ = private_room
    current = rec(cm, 'UPLOADED')
    RecordingDelivery.objects.create(idempotency_key=current['id'], retry_exhausted_at=timezone.now())
    mocker.patch.object(rc, 'provider', return_value=current)
    create = mocker.patch('dj.apps.dyte.views._create_meeting')
    response = client.post(f'/api/dyte/{cm.creator.username}/private', {}, format='json')
    assert response.status_code == 409
    assert response.data['code'] == 'recording_delivery_failed'
    create.assert_not_called()
