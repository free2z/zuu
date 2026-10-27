"""Signed deliveries for a meeting we cannot resolve.

Prod, 30 days: 7 of 54 `POST /api/dyte/webhook` were 404s, and the only trace
was Django's `Not Found: /api/dyte/webhook`. Reading the app logs around each
one shows the same shape every time: `Adding Host! <creator>` minted a NEW
provider room on the creator's existing `CreatorMeeting` row, and seconds
later the OLD room's events (its leaves, its `meeting.ended`) arrived for a
meeting id no row held any more. The row minted a new room on every host
start because `_create_meeting` never moves `created_at`, so the "rotate a
room over a day old" rule is true forever from the row's second day on. That
rotation is left alone on purpose (reusing the room is unsafe until billing
and lifecycle are session-scoped -- see `_create_meeting`, and ).

What is pinned here:

* the prod sequence end to end: a host restart replaces the room, and the old
  room's guest leave is acknowledged and counted, not 404'd;
* an unresolvable meeting is answered 2xx (it will never start resolving, so
  a retry is pointless) with ONE structured JSON line naming the event type,
  meeting id and delivery id -- a `..._dropped` line when money or a
  recording was lost, which the monitoring alert counts, and an `..._ignored`
  line when nothing was;
* every non-2xx carries the same structured line, and none of them ever
  contains the presigned recording URL.
"""
import base64
import json
import logging
import time
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from django.utils import timezone

from dj.apps.dyte.models import BROADCAST, CreatorMeeting, WebhookDelivery
from dj.apps.dyte.views import (
    DYTE_WEBHOOK_DROPPED_EVENT,
    DYTE_WEBHOOK_IGNORED_EVENT,
    DYTE_WEBHOOK_REJECTED_EVENT,
)
from dj.apps.events.models import Event

pytestmark = pytest.mark.django_db

WEBHOOK_URL = '/api/dyte/webhook'
LEGACY_URL = '/api/dyte/webhook-recording-status-update/'
PRESIGNED_SECRET = 'X-Amz-Signature=deadbeefsecret'


@pytest.fixture(scope='module')
def keypair():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


@pytest.fixture(autouse=True)
def webhook_boundaries(mocker, keypair):
    _, public_key = keypair
    mocker.patch(
        'dj.apps.dyte.views.get_or_load_dyte_public_key',
        return_value=public_key,
    )
    mocker.patch(
        'dj.apps.dyte.views._DYTE_PUBLIC_KEY_LOADED_AT', time.monotonic())
    return mocker.patch('dj.apps.jobs.outbox.PubSubClient')


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


@pytest.fixture
def provider(mocker):
    """The paid provider boundary. Each create_meeting mints a distinct room."""
    client = mocker.MagicMock()
    client.create_meeting.side_effect = lambda title: _FakeResponse(
        {'data': {'id': str(uuid.uuid4())}})
    client.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token'}})
    mocker.patch('dj.apps.dyte.views.DyteClient', return_value=client)
    return client


def _sign(private_key, body):
    return base64.b64encode(private_key.sign(
        body, padding.PKCS1v15(), hashes.SHA256(),
    )).decode()


def _meeting(meeting_id, title):
    return {
        'id': meeting_id,
        'sessionId': str(uuid.uuid4()),
        'title': title,
        'status': 'LIVE',
        'createdAt': '2026-09-07T17:53:25Z',
        'startedAt': '2026-09-07T17:53:52Z',
        'organizedBy': {'id': str(uuid.uuid4()), 'name': 'free2z'},
    }


def _left(meeting_id, title, participant_id):
    return json.dumps({
        'event': 'meeting.participantLeft',
        'meeting': _meeting(meeting_id, title),
        'participant': {
            'peerId': str(uuid.uuid4()),
            'userDisplayName': participant_id,
            'customParticipantId': participant_id,
            'joinedAt': '2026-09-07T17:54:00Z',
            'leftAt': '2026-09-07T17:56:01Z',
        },
    }).encode()


def _lifecycle(event, meeting_id, title):
    return json.dumps({
        'event': event,
        'meeting': _meeting(meeting_id, title),
    }).encode()


def _recording(meeting_id, title, recording_id):
    return json.dumps({
        'event': 'recording.statusUpdate',
        'meeting': _meeting(meeting_id, title),
        'recording': {
            'id': recording_id,
            'status': 'UPLOADED',
            'downloadUrl': (
                f'https://bucket.s3.amazonaws.com/rec.mp4?{PRESIGNED_SECRET}'),
        },
    }).encode()


def _post(client, private_key, body, *, url=WEBHOOK_URL, signed=True,
          delivery_id=None):
    headers = {'HTTP_DYTE_UUID': str(delivery_id or uuid.uuid4())}
    if signed:
        headers['HTTP_DYTE_SIGNATURE'] = _sign(private_key, body)
    return client.post(
        url, data=body, content_type='application/json', **headers)


def _outcomes(caplog):
    """Every structured webhook-outcome line, parsed. Asserts one line each."""
    found = []
    for record in caplog.records:
        if record.name != 'dj.apps.dyte.views':
            continue
        message = record.getMessage()
        if '"event":"dyte_webhook_' not in message:
            continue
        assert '\n' not in message
        found.append(json.loads(message))
    return found


@pytest.fixture
def broadcast(creator_factory):
    creator = creator_factory(username='Big_dre', tuzis=Decimal('1000'))
    cm = CreatorMeeting.objects.create(
        creator=creator, meeting_id=str(uuid.uuid4()),
        meeting_type=BROADCAST, is_public=True, live_now=True,
    )
    return cm


# --------------------------------------------------------------------------
# the prod sequence of 2026-09-07 17:53 -> 17:58
# --------------------------------------------------------------------------

def test_a_host_restart_orphans_the_old_room_and_its_leaves_are_counted(
    api_client, keypair, provider, broadcast, caplog,
):
    """A host restart on an aged row replaces room A; A's guest leave follows.

    This is the exact shape behind every  404. The restart still rotates
    (pinned, not endorsed -- see `_create_meeting`), so the leave cannot be
    applied; what changed is that it is answered 200 and counted, with the
    ids an operator needs, instead of a bare 404. The old room's
    `meeting.ended` must not take the NEW room off the live list.
    """
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')
    CreatorMeeting.objects.filter(pk=broadcast.pk).update(
        created_at=timezone.now() - timedelta(days=30), live_now=False)
    api_client.force_authenticate(user=broadcast.creator)
    url = f'/api/dyte/{broadcast.creator.username}/broadcast'
    room_a = api_client.post(url, {}).data['meeting_id']
    # a LIVE room is never rotated and a held broadcaster seat
    # refuses a second start, so the restart that still rotates is one after
    # the previous broadcast went offline and gave its seat back -- while
    # room A's late events are still in flight.
    CreatorMeeting.objects.filter(pk=broadcast.pk).update(
        live_now=False, host_session_id=None, host_session_seen_at=None)
    room_b = api_client.post(url, {}).data['meeting_id']  # the restart
    assert room_a != room_b
    api_client.force_authenticate(user=None)
    caplog.clear()

    guest = 'Guest 055e63bf-f739-4b7f-90f1-e96037d2afb0'
    left = _post(api_client, private_key, _left(room_a, 'Big_dre', guest))
    ended = _post(
        api_client, private_key,
        _lifecycle('meeting.ended', room_a, 'Big_dre'))

    assert left.status_code == 200
    assert ended.status_code == 200
    dropped, ignored = _outcomes(caplog)
    assert dropped['event'] == DYTE_WEBHOOK_DROPPED_EVENT
    assert dropped['meeting_id'] == room_a
    assert dropped['participant_id'] == guest
    assert ignored['event'] == DYTE_WEBHOOK_IGNORED_EVENT
    assert ignored['event_type'] == 'meeting.ended'
    broadcast.refresh_from_db()
    assert broadcast.meeting_id == room_b
    assert broadcast.live_now is True


# --------------------------------------------------------------------------
# an unresolvable meeting: 2xx, and exactly what it was
# --------------------------------------------------------------------------

def test_a_guest_leave_for_an_unknown_room_is_acknowledged_and_counted(
    api_client, keypair, caplog,
):
    private_key, _ = keypair
    orphan = str(uuid.uuid4())
    delivery_id = uuid.uuid4()
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')

    response = _post(
        api_client, private_key, _left(orphan, 'Big_dre', 'Guest 1'),
        delivery_id=delivery_id,
    )

    # 2xx: the id will never start resolving, so a provider retry is useless.
    assert response.status_code == 200
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_DROPPED_EVENT
    assert line['severity'] == 'ERROR'
    assert line['reason'] == 'unknown_meeting'
    assert line['event_type'] == 'meeting.participantLeft'
    assert line['meeting_id'] == orphan
    assert line['delivery_id'] == str(delivery_id)
    assert line['participant_id'] == 'Guest 1'
    assert line['signed'] is True
    assert line['status'] == 200
    # Not claimed: a later replay, once the room can be resolved, must apply.
    assert not WebhookDelivery.objects.exists()
    assert not Event.objects.exists()


def test_a_retry_of_an_applied_leave_after_rotation_is_not_counted(
    api_client, keypair, caplog, broadcast,
):
    """Applied, response lost, room rotated, provider retries: not a loss."""
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')
    room_a = broadcast.meeting_id
    body = _left(room_a, 'Big_dre', 'Guest 3')
    delivery_id = uuid.uuid4()
    assert _post(
        api_client, private_key, body, delivery_id=delivery_id,
    ).status_code == 200
    assert Event.objects.filter(type='PLATFORM_FEE').count() == 1
    CreatorMeeting.objects.filter(pk=broadcast.pk).update(
        meeting_id=str(uuid.uuid4()))
    caplog.clear()

    retry = _post(api_client, private_key, body, delivery_id=delivery_id)

    assert retry.status_code == 200
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_IGNORED_EVENT
    assert line['reason'] == 'already_processed'
    assert Event.objects.filter(type='PLATFORM_FEE').count() == 1


def test_the_hosts_own_leave_for_an_unknown_room_is_benign(
    api_client, keypair, caplog,
):
    """The host is never billed for their own room, in any meeting type."""
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')

    response = _post(
        api_client, private_key, _left(str(uuid.uuid4()), 'Big_dre', 'Big_dre'))

    assert response.status_code == 200
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_IGNORED_EVENT
    assert line['reason'] == 'unknown_meeting'


@pytest.mark.parametrize('event', [
    'meeting.started', 'meeting.ended', 'meeting.participantJoined',
])
def test_an_old_rooms_lifecycle_event_never_touches_the_current_room(
    api_client, keypair, caplog, broadcast, event,
):
    """`meeting.ended` for a replaced room must not take a live stream down."""
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')

    response = _post(
        api_client, private_key,
        _lifecycle(event, str(uuid.uuid4()), broadcast.creator.username),
    )

    assert response.status_code == 200
    broadcast.refresh_from_db()
    assert broadcast.live_now is True
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_IGNORED_EVENT
    assert line['event_type'] == event


def test_an_uploaded_recording_for_an_unknown_room_is_counted_without_its_url(
    api_client, keypair, caplog, webhook_boundaries,
):
    private_key, _ = keypair
    recording_id = str(uuid.uuid4())
    caplog.set_level(logging.DEBUG, logger='dj.apps.dyte.views')

    response = _post(
        api_client, private_key,
        _recording(str(uuid.uuid4()), 'Big_dre', recording_id),
    )

    assert response.status_code == 200
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_DROPPED_EVENT
    assert line['event_type'] == 'recording.statusUpdate'
    # The provider can re-issue a download URL for this id; the URL we were
    # handed expires, and its query string is a credential.
    assert line['recording_id'] == recording_id
    assert line['recording_status'] == 'UPLOADED'
    assert PRESIGNED_SECRET not in caplog.text
    assert webhook_boundaries.return_value.publish.call_count == 0


def test_the_legacy_endpoint_counts_an_unknown_rooms_recording_too(
    api_client, keypair, caplog,
):
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')
    body = json.dumps({
        'meeting': {'id': str(uuid.uuid4())},
        'recording': {
            'id': str(uuid.uuid4()),
            'status': 'UPLOADED',
            'downloadUrl': (
                f'https://bucket.s3.amazonaws.com/l.mp4?{PRESIGNED_SECRET}'),
        },
    }).encode()

    response = _post(api_client, private_key, body, url=LEGACY_URL)

    assert response.status_code == 200
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_DROPPED_EVENT
    assert line['endpoint'] == 'recording-legacy'
    assert line['reason'] == 'unknown_meeting'
    assert PRESIGNED_SECRET not in caplog.text


def test_a_known_room_writes_no_outcome_line(
    api_client, keypair, caplog, broadcast,
):
    """The positive control for every `[line] = _outcomes(...)` above."""
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')

    response = _post(
        api_client, private_key,
        _lifecycle('meeting.ended', broadcast.meeting_id, 'Big_dre'),
    )

    assert response.status_code == 200
    assert _outcomes(caplog) == []
    broadcast.refresh_from_db()
    assert broadcast.live_now is False


# --------------------------------------------------------------------------
# every non-2xx names itself
# --------------------------------------------------------------------------

def test_an_unsigned_delivery_is_rejected_with_a_structured_line(
    api_client, keypair, caplog,
):
    private_key, _ = keypair
    orphan = str(uuid.uuid4())
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')

    response = _post(
        api_client, private_key, _lifecycle('meeting.ended', orphan, 'x'),
        signed=False,
    )

    assert response.status_code == 400
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_REJECTED_EVENT
    assert line['reason'] == 'missing_signature'
    assert line['signed'] is False
    assert line['status'] == 400
    assert line['event_type'] == 'meeting.ended'
    assert line['meeting_id'] == orphan


def test_a_signed_delivery_without_a_delivery_id_is_counted_as_dropped(
    api_client, keypair, caplog, broadcast,
):
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')
    body = _left(broadcast.meeting_id, 'Big_dre', 'Guest 2')

    response = api_client.post(
        WEBHOOK_URL, data=body, content_type='application/json',
        HTTP_DYTE_SIGNATURE=_sign(private_key, body),
    )

    assert response.status_code == 400
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_DROPPED_EVENT
    assert line['reason'] == 'missing_or_invalid_delivery_id'
    assert line['meeting_id'] == broadcast.meeting_id
    assert line['delivery_id'] is None


def test_a_signed_effect_bearing_schema_failure_is_counted_as_dropped(
    api_client, keypair, caplog,
):
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')
    body = json.dumps({
        'event': 'recording.statusUpdate',
        'meeting': {'id': str(uuid.uuid4())},
        'recording': {
            'downloadUrl': (
                f'https://bucket.s3.amazonaws.com/r.mp4?{PRESIGNED_SECRET}'),
        },
    }).encode()

    response = _post(api_client, private_key, body)

    assert response.status_code == 400
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_DROPPED_EVENT
    assert line['reason'] == 'invalid_schema'
    assert line['event_type'] == 'recording.statusUpdate'
    assert PRESIGNED_SECRET not in caplog.text


def test_a_hostile_body_cannot_forge_a_second_log_line(
    api_client, keypair, caplog,
):
    private_key, _ = keypair
    caplog.set_level(logging.INFO, logger='dj.apps.dyte.views')
    forged = 'x\n{"event":"dyte_webhook_ignored"}' + 'y' * 500
    body = json.dumps({'event': forged, 'meeting': {'id': forged}}).encode()

    response = _post(api_client, private_key, body, signed=False)

    assert response.status_code == 400
    [line] = _outcomes(caplog)
    assert line['event'] == DYTE_WEBHOOK_REJECTED_EVENT
    assert len(line['event_type']) < 100
