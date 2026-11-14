"""DyteClient raises typed provider failures; host start must classify them
exactly as #1582 classifies raw provider responses. A REFUSED room create
(HTTP 4xx, e.g. the 2026-11 401 credential outage) or one never sent
(credentials unusable) created nothing: fail cleanly without a manual-review
reconciliation row for a room that does not exist. An ambiguous failure
(transport/5xx/408) keeps the "outcome unknown" record. A provider 404 on
add-participant rotates the room; an intermediary's non-JSON 404 does not."""
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
    ProviderAuthError(status=401, provider_code=401, provider_envelope=True),
    ProviderAuthError(status=403),
    ProviderRejectedError(status=422, provider_envelope=True),
    ProviderAuthError(status=0, request_sent=False),
])
def test_refused_room_create_leaves_no_reconciliation(api_client, provider, host, refusal):
    provider.create_meeting.side_effect = refusal

    response = _start(api_client, host, uuid.uuid4())

    assert response.status_code == 503, response.data
    assert response.data['code'] == 'provider_unavailable'
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
    assert ('outcome is unknown' in record.last_error
            or 'not safely verifiable' in record.last_error)


@pytest.mark.parametrize('failure', [
    ProviderAuthError(status=401), ProviderUnavailableError(status=0),
])
def test_failed_private_room_create_commits_no_empty_meeting_id(
    api_client, provider, host, creator_factory, failure,
):
    """meeting_id is globally unique: a committed '' row from one creator's
    failed private create would block every other creator's next create."""
    provider.create_meeting.side_effect = failure
    api_client.force_authenticate(user=host)

    response = api_client.post(f'/api/dyte/{host.username}/private', {}, format='json')

    assert response.status_code == 503, response.data
    assert response.data['code'] == 'provider_unavailable'
    assert not CreatorMeeting.objects.filter(creator=host).exists()

    # Another creator is unaffected once the provider answers again.
    provider.create_meeting.side_effect = lambda title: _FakeResponse(
        {'success': True, 'data': {'id': str(uuid.uuid4())}})
    other = creator_factory(username='refusal-other', tuzis=Decimal('1000'))
    api_client.force_authenticate(user=other)
    ok = api_client.post(f'/api/dyte/{other.username}/private', {}, format='json')
    assert ok.status_code == 200, ok.data


def _existing_room(host):
    return CreatorMeeting.objects.create(
        creator=host, meeting_id='old-room', meeting_type=BROADCAST, live_now=True)


def test_provider_404_on_add_participant_rotates_the_room(api_client, provider, host):
    from dj.apps.dyte.client import ProviderNotFoundError
    _existing_room(host)
    provider.add_participant.side_effect = [
        ProviderNotFoundError(status=404, provider_code=404, provider_envelope=True),
        _FakeResponse({'success': True, 'data': {'token': 'auth-token', 'id': str(uuid.uuid4())}}),
    ]

    response = _start(api_client, host, uuid.uuid4())

    assert response.status_code == 200, response.data
    assert provider.create_meeting.call_count == 1
    assert CreatorMeeting.objects.get(creator=host).meeting_id != 'old-room'


def test_intermediary_404_on_add_participant_does_not_rotate(api_client, provider, host):
    from dj.apps.dyte.client import ProviderNotFoundError
    _existing_room(host)
    provider.add_participant.side_effect = ProviderNotFoundError(
        status=404, provider_envelope=False)

    response = _start(api_client, host, uuid.uuid4())

    assert response.status_code == 503, response.data
    assert provider.create_meeting.call_count == 0
    assert CreatorMeeting.objects.get(creator=host).meeting_id == 'old-room'


def _client_error(status, body):
    """The typed error the REAL client raises for this provider answer."""
    from types import SimpleNamespace
    from unittest.mock import Mock
    from dj.apps.dyte.client import DyteClient, ProviderError
    transport = Mock()
    transport.request.return_value = SimpleNamespace(status_code=status, json=lambda: body)
    try:
        DyteClient(transport=transport, account_id='a' * 32, app_id='app',
                   api_token='t').create_meeting('x')
    except ProviderError as exc:
        return exc
    raise AssertionError('expected a provider error')


def test_refused_create_that_names_a_room_keeps_it_reconcilable(api_client, provider, host):
    named = str(uuid.uuid4())
    provider.create_meeting.side_effect = _client_error(
        422, {'success': False, 'error': {'code': 422}, 'data': {'id': named, 'token': 'secret'}})

    response = _start(api_client, host, uuid.uuid4())

    assert response.status_code == 503, response.data
    record = ProviderRoomCleanup.objects.get()
    assert record.provider_meeting_id == named


def test_refused_create_without_a_room_id_leaves_nothing(api_client, provider, host):
    provider.create_meeting.side_effect = _client_error(
        401, {'success': False, 'error': {'code': 401, 'message': 'Basic auth failed for org: x'}})

    response = _start(api_client, host, uuid.uuid4())

    assert response.status_code == 503, response.data
    assert response.data['failure'].get('provider_status') == 401
    assert ProviderRoomCleanup.objects.count() == 0
