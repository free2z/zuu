"""A provider that REFUSES a room create (HTTP 4xx, e.g. the 2026-11 401
credential outage) created nothing: the host start must fail cleanly without
leaving a manual-review reconciliation row for a room that does not exist.
An ambiguous failure (transport/5xx) keeps the "outcome unknown" record."""
import uuid
from decimal import Decimal

import pytest

from dj.apps.dyte.client import (
    ProviderAuthError, ProviderRejectedError, ProviderUnavailableError,
)
from dj.apps.dyte.models import BROADCAST, CreatorMeeting, ProviderRoomCleanup

pytestmark = pytest.mark.django_db


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


@pytest.fixture
def provider(mocker):
    client = mocker.MagicMock()
    client.create_meeting.side_effect = lambda title: _FakeResponse(
        {'success': True, 'data': {'id': str(uuid.uuid4())}})
    client.add_participant.return_value = _FakeResponse(
        {'success': True, 'data': {'token': 'auth-token', 'id': str(uuid.uuid4())}})
    mocker.patch('dj.apps.dyte.views.DyteClient', return_value=client)
    return client


@pytest.fixture
def host(creator_factory):
    return creator_factory(username='refusal-host', tuzis=Decimal('1000'))


def _start(api_client, creator, session):
    api_client.force_authenticate(user=creator)
    return api_client.post(
        f'/api/dyte/{creator.username}/{BROADCAST}',
        {'role': 'host', 'host_session': str(session)}, format='json')


@pytest.mark.parametrize('refusal', [
    ProviderAuthError(status=401, provider_code=401),
    ProviderAuthError(status=403),
    ProviderRejectedError(status=422),
])
def test_refused_room_create_leaves_no_reconciliation(api_client, provider, host, refusal):
    provider.create_meeting.side_effect = refusal

    response = _start(api_client, host, uuid.uuid4())

    assert response.status_code == 502, response.data
    assert ProviderRoomCleanup.objects.count() == 0
    assert provider.add_participant.call_count == 0
    cm = CreatorMeeting.objects.filter(creator=host).first()
    assert cm is None or (cm.host_session_id is None and cm.host_start_claim is None)

    # The seat is free: the next start (provider recovered) goes live.
    provider.create_meeting.side_effect = lambda title: _FakeResponse(
        {'success': True, 'data': {'id': str(uuid.uuid4())}})
    retry = _start(api_client, host, uuid.uuid4())
    assert retry.status_code == 200, retry.data


@pytest.mark.parametrize('ambiguous', [
    ProviderUnavailableError(status=0),
    ProviderUnavailableError(status=503),
    ProviderUnavailableError(status=408),
])
def test_ambiguous_room_create_keeps_outcome_unknown_record(api_client, provider, host, ambiguous):
    provider.create_meeting.side_effect = ambiguous

    response = _start(api_client, host, uuid.uuid4())

    assert response.status_code == 503, response.data
    record = ProviderRoomCleanup.objects.get()
    assert record.provider_meeting_id is None
    assert 'outcome is unknown' in record.last_error
