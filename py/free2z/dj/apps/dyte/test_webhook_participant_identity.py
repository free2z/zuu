"""Provider participant roles and settlement use the admitted identity."""
import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from django.db import IntegrityError, connection, transaction
import requests

from dj.apps.dyte.client import DyteClient
from dj.apps.dyte.models import CreatorMeeting, ProviderParticipantBinding, WebhookDelivery
from dj.apps.dyte.participant_binding import bind_participant
from dj.apps.dyte.test_host_seat import _FakeResponse, _start, provider as provider
from dj.apps.dyte.test_ppv_host_lifecycle import go_live
from dj.apps.dyte.test_webhook_idempotency import (
    _post, keypair as keypair, webhook_boundaries as webhook_boundaries,
)
from dj.apps.events.models import Event
from dj.apps.g12f.serializers.creator import RegistrationSerializer

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize('meeting_type', ['broadcast', 'ppv'])
@pytest.mark.parametrize('rename_and_reuse', [False, True])
def test_viewer_admission_keeps_its_billing_identity_despite_host_shaped_username(
    api_client, creator_factory, provider, keypair, mocker, settings, meeting_type, rename_and_reuse,
):
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host = creator_factory(username='identity-host', tuzis=Decimal('1000'))
    _, meeting, old_identity, _ = go_live(api_client, host, provider, keypair, meeting_type)
    registration = RegistrationSerializer(data={
        'username': old_identity, 'password': 'Synthetic-independent-password-1608!',
    })
    assert registration.is_valid(), registration.errors
    viewer = creator_factory(username=registration.validated_data['username'], tuzis=Decimal('1000'))
    assert _start(api_client, host, meeting_type=meeting_type, session=uuid.uuid4(), takeover=True).status_code == 200

    # Exercise the shipping provider payload construction, stubbing only HTTP.
    minted = {'id': str(uuid.uuid4()), 'token': 'synthetic-viewer-token'}
    http = mocker.patch.object(DyteClient, 'request', return_value=_FakeResponse({'data': minted}))
    real_client = DyteClient()
    provider.add_participant.side_effect = real_client.add_participant
    api_client.force_authenticate(user=viewer)
    joined = api_client.post(f'/api/dyte/{host.username}/{meeting_type}', {'role': 'viewer'}, format='json')
    assert joined.status_code == 200, joined.data
    payload = http.call_args.kwargs['payload']
    assert payload['preset_name'] == 'webinar-participant'
    identity = payload['custom_participant_id']
    replacement = None
    if rename_and_reuse:
        viewer.username = 'renamed-viewer'
        viewer.save(update_fields=['username'])
        replacement = creator_factory(username=old_identity, tuzis=Decimal('1000'))
    now = timezone.now()
    body = json.dumps({'event': 'meeting.participantLeft', 'meeting': meeting,
        'participant': {'peerId': str(uuid.uuid4()), 'userDisplayName': viewer.username,
            'customParticipantId': identity, 'joinedAt': (now - timedelta(seconds=61)).isoformat(),
            'leftAt': now.isoformat()}}).encode()
    event_id = uuid.uuid4()
    assert _post(api_client, keypair[0], body, event_id, drain=False).status_code == 200
    assert _post(api_client, keypair[0], body, event_id, drain=False).status_code == 200
    host.refresh_from_db()
    viewer.refresh_from_db()
    if meeting_type == 'broadcast':
        assert host.tuzis == Decimal('999')
        assert viewer.tuzis == Decimal('1000')
        assert Event.objects.filter(type='PLATFORM_FEE', receiving_user=host, amount=1).count() == 1
    else:
        assert host.tuzis == Decimal('1006')
        assert viewer.tuzis == Decimal('993')
        assert Event.objects.filter(type='PLATFORM_FEE', receiving_user=viewer, amount=1).count() == 1
        assert Event.objects.filter(type='PAY_PER_VIEW_REVENUE').count() == 1
        assert Event.objects.filter(type='PAY_PER_VIEW_SPEND').count() == 1
    assert WebhookDelivery.objects.filter(pk=event_id).count() == 1
    if replacement is not None:
        replacement.refresh_from_db()
        assert replacement.tuzis == Decimal('1000')


@pytest.mark.parametrize('meeting_type', ['broadcast', 'ppv'])
def test_retired_real_host_is_not_charged_to_account_with_same_custom_name(
    api_client, creator_factory, provider, keypair, settings, meeting_type,
):
    from dj.apps.dyte.test_ppv_host_lifecycle import leave
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host = creator_factory(username='retired-host', tuzis=1000)
    _, meeting, old_identity, _ = go_live(api_client, host, provider, keypair, meeting_type)
    other = creator_factory(username=old_identity, tuzis=1000)
    assert _start(api_client, host, meeting_type=meeting_type, session=uuid.uuid4(), takeover=True).status_code == 200
    assert leave(api_client, keypair, meeting, old_identity).status_code == 200
    host.refresh_from_db()
    other.refresh_from_db()
    assert host.tuzis == other.tuzis == Decimal('1000')
    assert not Event.objects.filter(type__in=['PLATFORM_FEE', 'PAY_PER_VIEW_SPEND']).exists()
    assert not WebhookDelivery.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_known_host_departure_commits_before_provider_timeout(
    api_client, creator_factory, provider, keypair, mocker, request,
):
    host = creator_factory(username='timeout-host', tuzis=1000)
    # Procrastinate's unmanaged jobs are not included in Django's test flush.
    def cleanup_jobs():
        with connection.cursor() as cursor:
            cursor.execute("DELETE FROM procrastinate_jobs WHERE task_name = %s AND args->>'creator_id' = %s",
                ['dyte.retire_host_evictions', str(host.pk)])
    request.addfinalizer(cleanup_jobs)
    cm, meeting, identity, _ = go_live(api_client, host, provider, keypair, 'broadcast')
    cm.refresh_from_db()
    before = cm.host_joined_at
    body = json.dumps({'event': 'meeting.participantLeft', 'meeting': meeting,
        'participant': {'peerId': str(cm.host_peer_id), 'userDisplayName': host.username,
            'customParticipantId': identity, 'joinedAt': before.isoformat(),
            'leftAt': (before + timedelta(seconds=61)).isoformat()}}).encode()

    def timeout(*args, **kwargs):
        assert not connection.in_atomic_block
        observed = CreatorMeeting.objects.get(pk=cm.pk)
        assert observed.host_left_at is not None
        assert observed.lifecycle_state == 'starting'
        raise requests.Timeout('synthetic timeout')

    mocker.patch.object(DyteClient, 'get_session_participant', side_effect=timeout)
    response = _post(api_client, keypair[0], body, uuid.uuid4(), drain=False, participant_evidence=None)
    assert response.status_code == 503
    cm.refresh_from_db()
    assert cm.host_left_at == before + timedelta(seconds=61)
    assert cm.lifecycle_state == 'starting'
    assert not WebhookDelivery.objects.exists()
    assert not Event.objects.filter(type='PLATFORM_FEE').exists()


def test_binding_is_immutable_and_conflicting_mint_never_reassigns_actor(creator_factory):
    from dj.apps.dyte.participant_binding import ParticipantIdentityUnproven
    host, first, second = (creator_factory() for _ in range(3))
    values = dict(meeting_id=uuid.uuid4(), participant_id=uuid.uuid4(), creator_id=host.pk,
        actor_id=first.pk, role='viewer', custom_id='original-name')
    binding = bind_participant(**values)
    assert bind_participant(**values).pk == binding.pk
    with pytest.raises(ParticipantIdentityUnproven):
        bind_participant(**{**values, 'actor_id': second.pk})
    for operation in ('update', 'delete'):
        with pytest.raises(IntegrityError), transaction.atomic():
            rows = ProviderParticipantBinding.objects.filter(pk=binding.pk)
            rows.update(actor_id=second.pk) if operation == 'update' else rows.delete()
    binding.refresh_from_db()
    assert binding.actor_id == first.pk


@pytest.mark.parametrize('role,preset', [('host', 'webinar1'), ('viewer', 'webinar-participant')])
def test_peer_report_uses_peer_url_and_canonical_user_not_session_row_id(mocker, role, preset):
    session, peer, canonical, row = (uuid.uuid4() for _ in range(4))
    payload = {'data': {'participant': {'id': str(row), 'session_id': str(session),
        'user_id': str(canonical), 'role': preset, 'custom_participant_id': 'fixture'}}}
    request = mocker.patch.object(DyteClient, 'request', return_value=_FakeResponse(payload))
    evidence = DyteClient().get_session_participant(session, peer)
    assert evidence == {'user_id': canonical, 'role': role, 'custom_participant_id': 'fixture'}
    request.assert_called_once_with('GET', f'sessions/peer-report/{peer}',
        params={'include_peer_events': 'true', 'filters': 'events'})


@pytest.mark.parametrize('field,value', [('session_id', str(uuid.uuid4())), ('user_id', None),
    ('id', 'invalid'), ('role', 'unknown'), ('custom_participant_id', None)])
def test_peer_report_rejects_unproven_identity_before_settlement(mocker, field, value):
    from dj.apps.dyte.client import ProviderInvalidResponse
    session = uuid.uuid4()
    participant = {'id': str(uuid.uuid4()), 'session_id': str(session),
        'user_id': str(uuid.uuid4()), 'role': 'webinar1', 'custom_participant_id': 'fixture'}
    participant[field] = value
    mocker.patch.object(DyteClient, 'request', return_value=_FakeResponse({'data': {'participant': participant}}))
    with pytest.raises(ProviderInvalidResponse):
        DyteClient().get_session_participant(session, uuid.uuid4())


@pytest.mark.parametrize('event', ['meeting.participantJoined', 'meeting.participantLeft'])
def test_current_host_name_does_not_give_a_viewer_host_presence_authority(
    api_client, creator_factory, provider, keypair, event,
):
    host = creator_factory(tuzis=1000)
    cm, meeting, custom_id, _ = go_live(api_client, host, provider, keypair, 'broadcast')
    cm.refresh_from_db()
    original_presence = (cm.host_peer_id, cm.host_joined_at, cm.host_left_at, cm.lifecycle_state)
    viewer = creator_factory(username=custom_id, tuzis=1000)
    api_client.force_authenticate(viewer)
    assert api_client.post(f'/api/dyte/{host.username}/broadcast', {'role': 'viewer'}, format='json').status_code == 200
    viewer_binding = ProviderParticipantBinding.objects.get(actor=viewer, role='viewer')
    joined_at = cm.host_joined_at + timedelta(seconds=1)
    body = json.dumps({'event': event, 'meeting': meeting, 'participant': {
        'peerId': str(uuid.uuid4()), 'userDisplayName': custom_id,
        'customParticipantId': custom_id, 'joinedAt': joined_at.isoformat(),
        'leftAt': (joined_at + timedelta(seconds=61)).isoformat(),
    }}).encode()
    evidence = {'user_id': viewer_binding.participant_id, 'role': 'viewer',
        'custom_participant_id': custom_id}
    assert _post(api_client, keypair[0], body, uuid.uuid4(), drain=False,
        participant_evidence=evidence).status_code == 200
    cm.refresh_from_db()
    assert (cm.host_peer_id, cm.host_joined_at, cm.host_left_at, cm.lifecycle_state) == original_presence
    host.refresh_from_db()
    assert host.tuzis == (Decimal('999') if event.endswith('Left') else Decimal('1000'))


@pytest.mark.parametrize('mismatch', ['unbound', 'role', 'custom_id'])
def test_unproven_participant_identity_is_retryable_without_financial_claim(
    api_client, creator_factory, provider, keypair, mismatch,
):
    host = creator_factory(tuzis=1000)
    cm, meeting, identity, _ = go_live(api_client, host, provider, keypair, 'broadcast')
    viewer = creator_factory(username=identity, tuzis=1000)
    api_client.force_authenticate(viewer)
    assert api_client.post(f'/api/dyte/{host.username}/broadcast', {'role': 'viewer'}, format='json').status_code == 200
    binding = ProviderParticipantBinding.objects.get(actor=viewer, role='viewer')
    evidence = {'user_id': binding.participant_id, 'role': 'viewer', 'custom_participant_id': identity}
    if mismatch == 'unbound':
        evidence['user_id'] = uuid.uuid4()
    elif mismatch == 'role':
        evidence['role'] = 'host'
    else:
        evidence['custom_participant_id'] = 'another-identity'
    now = timezone.now()
    body = json.dumps({'event': 'meeting.participantLeft', 'meeting': meeting, 'participant': {
        'peerId': str(uuid.uuid4()), 'userDisplayName': identity, 'customParticipantId': identity,
        'joinedAt': now.isoformat(), 'leftAt': (now + timedelta(seconds=61)).isoformat(),
    }}).encode()
    assert _post(api_client, keypair[0], body, uuid.uuid4(), drain=False,
        participant_evidence=evidence).status_code == 503
    assert not WebhookDelivery.objects.exists()
    assert not Event.objects.filter(type='PLATFORM_FEE').exists()
    host.refresh_from_db()
    viewer.refresh_from_db()
    assert host.tuzis == viewer.tuzis == Decimal('1000')


@pytest.mark.parametrize('role', ['host', 'viewer'])
@pytest.mark.parametrize('failure', ['conflict', 'database'])
def test_token_is_not_returned_when_immutable_identity_cannot_be_saved(
    api_client, creator_factory, provider, mocker, role, failure,
):
    from django.db import DatabaseError
    from dj.apps.dyte.participant_binding import ParticipantIdentityUnproven
    host = creator_factory(tuzis=1000)
    if role == 'viewer':
        CreatorMeeting.objects.create(creator=host, meeting_id=str(uuid.uuid4()),
            meeting_type='broadcast', is_public=True, live_now=True)
        api_client.force_authenticate(creator_factory())
    else:
        api_client.force_authenticate(host)
    if failure == 'database':
        mocker.patch.object(ProviderParticipantBinding.objects, 'get_or_create',
            side_effect=DatabaseError('synthetic insert failure'))
    else:
        mocker.patch('dj.apps.dyte.views.bind_participant', side_effect=ParticipantIdentityUnproven('fixture'))
    result = api_client.post(f'/api/dyte/{host.username}/broadcast',
        {'role': role, 'host_session': str(uuid.uuid4())}, format='json')
    assert result.status_code == 503
    assert 'auth_token' not in result.data
    assert not ProviderParticipantBinding.objects.exists()
    if role == 'host':
        cm = CreatorMeeting.objects.get(creator=host)
        assert cm.host_start_claim is None
        assert cm.host_session_id is None
        assert len(cm.host_evictions) == 1
        assert cm.host_evictions[0]['participant_id']


@pytest.mark.parametrize('legacy_binding', ['current', 'retired', 'unknown'])
def test_legacy_provider_host_requires_retained_canonical_evidence_and_cannot_open_presence(
    api_client, creator_factory, keypair, legacy_binding,
):
    from dj.apps.dyte.test_webhook_idempotency import _meeting
    host = creator_factory(tuzis=1000)
    other = creator_factory(username='legacy-host-name', tuzis=1000)
    canonical = uuid.uuid4()
    cm = CreatorMeeting.objects.create(creator=host, meeting_type='broadcast',
        meeting_id=str(uuid.uuid4()), live_now=True,
        host_participant_id=str(canonical) if legacy_binding == 'current' else str(uuid.uuid4()),
        host_evictions=[{'meeting_id': 'unused', 'participant_id': str(canonical)}]
            if legacy_binding == 'retired' else [])
    if legacy_binding == 'retired':
        cm.host_evictions[0]['meeting_id'] = cm.meeting_id
        cm.save(update_fields=['host_evictions'])
    room = _meeting(cm.meeting_id)
    now = timezone.now()
    body = json.dumps({'event': 'meeting.participantLeft', 'meeting': room, 'participant': {
        'peerId': str(uuid.uuid4()), 'userDisplayName': other.username,
        'customParticipantId': other.username, 'joinedAt': now.isoformat(),
        'leftAt': (now + timedelta(seconds=61)).isoformat(),
    }}).encode()
    response = _post(api_client, keypair[0], body, uuid.uuid4(), drain=False,
        participant_evidence={'user_id': canonical, 'role': 'host', 'custom_participant_id': other.username})
    assert response.status_code == (503 if legacy_binding == 'unknown' else 200)
    assert not WebhookDelivery.objects.exists()
    assert not Event.objects.filter(type='PLATFORM_FEE').exists()
    assert not ProviderParticipantBinding.objects.exists()
    cm.refresh_from_db()
    assert cm.host_peer_id is None
    host.refresh_from_db()
    other.refresh_from_db()
    assert host.tuzis == other.tuzis == Decimal('1000')
