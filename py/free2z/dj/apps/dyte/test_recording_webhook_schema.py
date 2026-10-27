"""Custom recording callbacks omit session metadata; billing events must not."""
import copy

import pytest
from pydantic import ValidationError

from dj.apps.dyte.types import WebhookEvent


def recording_payload():
    # Shape observed from the signed custom-recorder callbacks in.
    return {
        'event': 'recording.statusUpdate',
        'meeting': {
            'id': 'bbb62c58-cf38-4e74-a460-f8f930bb8b84',
            'title': 'synthetic recording test',
            'status': 'ACTIVE',
            'createdAt': '2026-10-21T18:02:45.603Z',
            'organizedBy': {
                'id': '7dba0970-3d0b-45e4-97dc-17029162fcc5',
                'name': 'test',
            },
        },
        'recording': {
            'id': 'fff04780-afcb-4cdf-a7b7-7e72857f151e',
            'status': 'UPLOADED',
            'downloadUrl': 'https://example.com/recording.mp4',
        },
    }


@pytest.mark.parametrize('explicit_null', [False, True])
@pytest.mark.parametrize('status', ['RECORDING', 'UPLOADING', 'UPLOADED'])
def test_recording_without_session_metadata_is_valid(explicit_null, status):
    payload = recording_payload()
    payload['recording']['status'] = status
    if explicit_null:
        payload['meeting'].update(sessionId=None, startedAt=None)
    event = WebhookEvent.model_validate(payload)
    assert event.meeting.sessionId is None
    assert event.meeting.startedAt is None
    assert str(event.recording.id) == payload['recording']['id']
    assert str(event.recording.downloadUrl) == payload['recording']['downloadUrl']


@pytest.mark.parametrize('event', [
    'meeting.started', 'meeting.ended', 'meeting.participantJoined',
    'meeting.participantLeft', 'unknown.event',
])
@pytest.mark.parametrize('missing', ['sessionId', 'startedAt'])
@pytest.mark.parametrize('explicit_null', [False, True])
def test_non_recording_events_require_session_metadata(event, missing, explicit_null):
    payload = recording_payload()
    payload['event'] = event
    payload['meeting'].update(
        sessionId='4986839b-7d3b-416a-adf8-4bffd9ceab68',
        startedAt='2026-10-21T18:03:40.920Z',
    )
    payload['participant'] = {
        'peerId': '38880386-b924-4fb5-92a5-f8b5c05f4d0e',
        'userDisplayName': 'test',
        'customParticipantId': 'test',
        'joinedAt': '2026-10-21T18:03:40.920Z',
        'leftAt': '2026-10-21T18:04:00.000Z',
    }
    # Positive control: this payload otherwise passes, including billing fields.
    WebhookEvent.model_validate(copy.deepcopy(payload))
    if explicit_null:
        payload['meeting'][missing] = None
    else:
        del payload['meeting'][missing]
    with pytest.raises(ValidationError, match='require meeting sessionId and startedAt'):
        WebhookEvent.model_validate(payload)


@pytest.mark.parametrize('field,value', [
    ('sessionId', 'not-a-uuid'), ('startedAt', 'not-a-timestamp'),
])
def test_recording_rejects_malformed_optional_session_metadata(field, value):
    payload = recording_payload()
    payload['meeting'][field] = value
    with pytest.raises(ValidationError):
        WebhookEvent.model_validate(payload)


def test_sessionless_recording_still_requires_recording_identity():
    payload = recording_payload()
    del payload['recording']
    with pytest.raises(ValidationError, match='requires recording details'):
        WebhookEvent.model_validate(payload)
