"""Exercise paid admission through the shipping host and signed webhook routes."""
import json
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from dj.apps.dyte.models import PpvCreditAdmission, CreatorMeeting, LIFECYCLE_LIVE, LIFECYCLE_OFFLINE, LIFECYCLE_STARTING
from dj.apps.dyte.test_host_seat import _seat, _start, provider as provider
from dj.apps.dyte.test_webhook_idempotency import (
    _meeting, _post, keypair as keypair, webhook_boundaries as webhook_boundaries,
)
from dj.apps.economy.models import CreatorPayable, PayableJournal, ServiceAdmission
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.economy.tests.test_products import publish, supplier_contract

pytestmark = pytest.mark.django_db


@pytest.fixture
def actors(creator_factory, settings):
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    host = creator_factory(username='paid-host', tuzis=1000)
    viewer = creator_factory(username='paid-viewer', tuzis=1000)
    activate_for_test()
    publish('livestream_ppv')
    return host, viewer


def go_live(api_client, host, provider, keypair, meeting_type='ppv'):
    response = _start(api_client, host, meeting_type=meeting_type, price_per_minute='3.00')
    assert response.status_code == 200, response.data
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=meeting_type)
    host_identity = provider.add_participant.call_args.kwargs['custom_participant_id']
    meeting = _meeting(cm.meeting_id)
    meeting['startedAt'] = timezone.now().isoformat()
    body = json.dumps({'event': 'meeting.started', 'meeting': meeting}).encode()
    assert _post(api_client, keypair[0], body, uuid.uuid4(), drain=False).status_code == 200
    cm.refresh_from_db()
    assert cm.lifecycle_state == LIFECYCLE_STARTING
    assert joined(api_client, keypair, meeting, host_identity).status_code == 200
    cm.refresh_from_db()
    return cm, meeting, host_identity, response.data['host_session']


def joined(api_client, keypair, meeting, identity):
    return _post(api_client, keypair[0], json.dumps({
        'event': 'meeting.participantJoined', 'meeting': meeting,
        'participant': {'peerId': str(uuid.uuid4()), 'userDisplayName': 'Synthetic host',
            'customParticipantId': identity, 'joinedAt': timezone.now().isoformat()},
    }).encode(), uuid.uuid4(), drain=False)


def viewer_join(api_client, viewer, host):
    api_client.force_authenticate(user=viewer)
    return api_client.post(f'/api/dyte/{host.username}/ppv', {
        'role': 'viewer', 'expected_actor_id': viewer.pk,
        'admission_idempotency_key': str(uuid.uuid4()),
    }, format='json')


def leave(api_client, keypair, meeting, identity):
    now = timezone.now()
    return _post(api_client, keypair[0], json.dumps({
        'event': 'meeting.participantLeft', 'meeting': meeting,
        'participant': {'peerId': str(uuid.uuid4()), 'userDisplayName': 'Synthetic host',
            'customParticipantId': identity, 'joinedAt': (now - timedelta(seconds=61)).isoformat(),
            'leftAt': now.isoformat()},
    }).encode(), uuid.uuid4(), drain=False)


def test_host_webhook_viewer_admission_uses_actual_lifecycle(api_client, actors, provider, keypair):
    host, viewer = actors
    supplier_contract(host)
    cm, meeting, _, session = go_live(api_client, host, provider, keypair)
    assert cm.lifecycle_state == LIFECYCLE_LIVE
    response = viewer_join(api_client, viewer, host)
    assert response.status_code == 200, response.data
    admission = PpvCreditAdmission.objects.get()
    assert str(admission.provider_session_id) == meeting['sessionId']
    assert provider.add_participant.call_args.kwargs['custom_participant_id'] == f'pc_{admission.pk.hex}'
    assert not PayableJournal.objects.exists()
    assert _seat(api_client, host, session, 'release').status_code == 200
    cm.refresh_from_db()
    assert cm.host_session_id is None and cm.lifecycle_state == LIFECYCLE_OFFLINE
    assert viewer_join(api_client, viewer, host).status_code == 409


def test_credit_host_start_needs_no_supplier_setup(api_client, actors, provider):
    host, _ = actors
    response = _start(api_client, host, meeting_type='ppv', price_per_minute='3.00')
    assert response.status_code == 200, response.data
    provider.add_participant.assert_called_once()
    assert not CreatorPayable.objects.exists()
    assert not ServiceAdmission.objects.exists()


@pytest.mark.parametrize('meeting_type', ['ppv', 'broadcast'])
def test_host_departure_after_takeover_is_free(api_client, actors, provider, keypair, meeting_type):
    host, _ = actors
    supplier_contract(host)
    cm, meeting, old_host, _ = go_live(api_client, host, provider, keypair, meeting_type)
    original_balance = host.tuzis
    replacement = _start(api_client, host, meeting_type=meeting_type, session=uuid.uuid4(), takeover=True)
    assert replacement.status_code == 200
    new_host = provider.add_participant.call_args.kwargs['custom_participant_id']
    assert old_host != new_host
    assert leave(api_client, keypair, meeting, old_host).status_code == 200
    assert leave(api_client, keypair, meeting, new_host).status_code == 200
    host.refresh_from_db()
    assert host.tuzis == original_balance
    assert not ServiceAdmission.objects.exists()
    assert not PayableJournal.objects.exists()


@pytest.mark.parametrize('identity_kind', ['unsigned', 'wrong_owner', 'tampered'])
def test_unproved_host_departure_never_bypasses_paid_admission(api_client, actors, provider, keypair, identity_kind):
    from dj.apps.dyte.host_identity import host_participant_identity
    host, viewer = actors
    supplier_contract(host)
    _, meeting, valid_identity, _ = go_live(api_client, host, provider, keypair)
    identity = {
        'unsigned': f'host_{uuid.uuid4().hex}',
        'wrong_owner': host_participant_identity(viewer.public_id, uuid.uuid4()),
        'tampered': valid_identity[:-1] + ('A' if valid_identity[-1] != 'A' else 'B'),
    }[identity_kind]
    assert leave(api_client, keypair, meeting, identity).status_code == 503
    assert not ServiceAdmission.objects.exists()
    assert not PayableJournal.objects.exists()


def test_host_identity_survives_configured_key_rotation(settings):
    from dj.apps.dyte.host_identity import host_participant_identity, is_host_participant
    owner = uuid.uuid4()
    settings.SECRET_KEY = 'synthetic-old-host-signing-key'
    identity = host_participant_identity(owner, uuid.uuid4())
    settings.SECRET_KEY = 'synthetic-new-host-signing-key'
    settings.SECRET_KEY_FALLBACKS = ['synthetic-old-host-signing-key']
    assert is_host_participant(identity, owner)
    settings.SECRET_KEY_FALLBACKS = []
    assert not is_host_participant(identity, owner)


def test_credit_host_start_does_not_depend_on_cash_schedule_consent(api_client, actors, provider):
    host, _ = actors
    supplier_contract(host, schedules=[])
    response = _start(api_client, host, meeting_type='ppv', price_per_minute='3.00')
    assert response.status_code == 200, response.data
    provider.add_participant.assert_called_once()
    assert not ServiceAdmission.objects.exists()


def test_same_provider_session_resume_requires_current_host_join(api_client, actors, provider, keypair):
    host, viewer = actors
    supplier_contract(host)
    cm, meeting, old_host, session = go_live(api_client, host, provider, keypair)
    assert _seat(api_client, host, session, 'release').status_code == 200
    resumed = _start(api_client, host, meeting_type='ppv', session=uuid.uuid4())
    assert resumed.status_code == 200
    current_host = provider.add_participant.call_args.kwargs['custom_participant_id']
    assert viewer_join(api_client, viewer, host).data['code'] == 'livestream_offer_unavailable'
    # A delayed callback from the previous token cannot activate its replacement.
    assert joined(api_client, keypair, meeting, old_host).status_code == 200
    cm.refresh_from_db()
    assert cm.lifecycle_state == LIFECYCLE_STARTING
    assert joined(api_client, keypair, meeting, current_host).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


def test_owner_viewer_room_start_does_not_activate_paid_offer(api_client, actors, provider, keypair):
    host, viewer = actors
    supplier_contract(host)
    started = _start(api_client, host, meeting_type='ppv', price_per_minute='3.00')
    assert started.status_code == 200
    cm = CreatorMeeting.objects.get(creator=host, meeting_type='ppv')
    meeting = _meeting(cm.meeting_id)
    meeting['startedAt'] = timezone.now().isoformat()
    body = json.dumps({'event': 'meeting.started', 'meeting': meeting}).encode()
    assert _post(api_client, keypair[0], body, uuid.uuid4(), drain=False).status_code == 200
    assert joined(api_client, keypair, meeting, f'ph_{host.public_id.hex}').status_code == 200
    response = viewer_join(api_client, viewer, host)
    assert response.status_code == 409 and response.data['code'] == 'livestream_offer_unavailable'
    assert not ServiceAdmission.objects.exists()


def test_late_host_join_cannot_revive_ended_session(api_client, actors, provider, keypair):
    host, viewer = actors
    supplier_contract(host)
    cm, meeting, host_identity, _ = go_live(api_client, host, provider, keypair)
    body = json.dumps({'event': 'meeting.ended', 'meeting': meeting}).encode()
    assert _post(api_client, keypair[0], body, uuid.uuid4(), drain=False).status_code == 200
    assert joined(api_client, keypair, meeting, host_identity).status_code == 200
    cm.refresh_from_db()
    assert cm.lifecycle_state == LIFECYCLE_OFFLINE and not cm.live_now
    assert viewer_join(api_client, viewer, host).status_code == 404


def test_reconnected_host_join_before_started_activates_new_session(api_client, actors, provider, keypair):
    host, viewer = actors
    supplier_contract(host)
    cm, meeting, host_identity, _ = go_live(api_client, host, provider, keypair)
    ended = json.dumps({'event': 'meeting.ended', 'meeting': meeting}).encode()
    assert _post(api_client, keypair[0], ended, uuid.uuid4(), drain=False).status_code == 200
    # SDK auto-reconnect keeps its current token and fresh host lease.
    reconnected = dict(meeting, sessionId=str(uuid.uuid4()), startedAt=timezone.now().isoformat())
    assert joined(api_client, keypair, reconnected, host_identity).status_code == 200
    cm.refresh_from_db()
    assert cm.lifecycle_state == LIFECYCLE_LIVE
    late_start = json.dumps({'event': 'meeting.started', 'meeting': reconnected}).encode()
    assert _post(api_client, keypair[0], late_start, uuid.uuid4(), drain=False).status_code == 200
    cm.refresh_from_db()
    assert cm.lifecycle_state == LIFECYCLE_LIVE
    assert str(cm.provider_session_id) == reconnected['sessionId']
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('missing_heartbeat', [True, False])
def test_paid_admission_requires_fresh_host_lease(api_client, actors, provider, keypair, missing_heartbeat):
    host, viewer = actors
    supplier_contract(host)
    cm, _, _, session = go_live(api_client, host, provider, keypair)
    cm.host_session_seen_at = None if missing_heartbeat else timezone.now() - timedelta(seconds=61)
    cm.save(update_fields=['host_session_seen_at'])
    response = viewer_join(api_client, viewer, host)
    assert response.status_code == 409 and response.data['code'] == 'livestream_offer_unavailable'
    assert provider.add_participant.call_count == 1
    assert not ServiceAdmission.objects.exists()
    # Renewing the same held lease permits admission without fabricating a new
    # provider session; a different tab cannot renew this seat.
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200
