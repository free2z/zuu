"""Provider host presence must gate paid admission independently of HTTP leases."""
import json
import uuid
from datetime import datetime, timedelta
from itertools import permutations

import pytest
from django.utils import timezone

from dj.apps.dyte.models import CreatorMeeting, LIFECYCLE_LIVE, LIFECYCLE_STARTING
from dj.apps.dyte.test_host_seat import _seat, _start, provider as provider
from dj.apps.dyte.test_ppv_host_lifecycle import actors as actors, viewer_join
from dj.apps.dyte.test_webhook_idempotency import (
    _meeting, _post, keypair as keypair, webhook_boundaries as webhook_boundaries,
)
from dj.apps.economy.models import PayableJournal, ServiceAdmission
from dj.apps.economy.tests.test_products import supplier_contract

pytestmark = pytest.mark.django_db


def event(api_client, keypair, meeting, kind, participant=None):
    body = {'event': kind, 'meeting': meeting}
    if participant is not None:
        body['participant'] = participant
    return _post(api_client, keypair[0], json.dumps(body).encode(), uuid.uuid4(), drain=False)


def live_host(api_client, host, provider, keypair, *, announce=True):
    supplier_contract(host)
    started = _start(api_client, host, meeting_type='ppv', price_per_minute='3.00')
    assert started.status_code == 200
    cm = CreatorMeeting.objects.get(creator=host, meeting_type='ppv')
    meeting = _meeting(cm.meeting_id)
    meeting['startedAt'] = timezone.now().isoformat()
    participant = {'peerId': str(uuid.uuid4()), 'userDisplayName': 'Synthetic host',
        'customParticipantId': provider.add_participant.call_args.kwargs['custom_participant_id'],
        'joinedAt': timezone.now().isoformat()}
    if announce:
        assert event(api_client, keypair, meeting, 'meeting.started').status_code == 200
        assert event(api_client, keypair, meeting, 'meeting.participantJoined', participant).status_code == 200
    return cm, meeting, participant, started.data['host_session']


def rejoin(participant, seconds):
    return dict(participant, peerId=str(uuid.uuid4()), leftAt=None,
        joinedAt=(datetime.fromisoformat(participant['joinedAt']) + timedelta(seconds=seconds)).isoformat())


def departure(participant, seconds=1):
    return dict(participant,
        leftAt=(datetime.fromisoformat(participant['joinedAt']) + timedelta(seconds=seconds)).isoformat())


def assert_unavailable(api_client, viewer, host):
    refused = viewer_join(api_client, viewer, host)
    assert refused.status_code == 409
    assert refused.data['code'] == 'livestream_offer_unavailable'


def test_departed_host_heartbeats_cannot_keep_paid_admission_open(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, participant, session = live_host(api_client, host, provider, keypair)
    assert viewer_join(api_client, viewer, host).status_code == 200
    participant['leftAt'] = timezone.now().isoformat()
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', participant).status_code == 200
    # Existing viewers keep the provider session alive. The disconnected SDK's
    # dashboard continues successfully renewing the separate HTTP seat lease.
    for _ in range(3):
        assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    cm.refresh_from_db()
    assert cm.live_now and str(cm.provider_session_id) == meeting['sessionId']
    refused = viewer_join(api_client, viewer, host)
    assert refused.status_code == 409
    assert refused.data['code'] == 'livestream_offer_unavailable'
    assert ServiceAdmission.objects.count() == 1
    assert provider.add_participant.call_count == 2
    assert not PayableJournal.objects.exists()


@pytest.mark.parametrize('joined_first', [True, False])
def test_departure_tombstone_survives_late_join_and_started(api_client, actors, provider, keypair, joined_first):
    host, viewer = actors
    cm, meeting, participant, session = live_host(api_client, host, provider, keypair, announce=joined_first)
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(participant)).status_code == 200
    # Every retry has a different delivery UUID, so the provider-presence
    # tombstone, rather than receipt deduplication, must keep admission closed.
    for kind in ('meeting.participantJoined', 'meeting.started', 'meeting.participantJoined'):
        assert event(api_client, keypair, meeting, kind, participant).status_code == 200
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    cm.refresh_from_db()
    assert cm.host_peer_id == uuid.UUID(participant['peerId']) and cm.host_left_at is not None
    assert_unavailable(api_client, viewer, host)
    assert not ServiceAdmission.objects.exists()


def test_same_token_same_session_rejoin_recovers_after_departure(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, participant, session = live_host(api_client, host, provider, keypair)
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(participant)).status_code == 200
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    assert_unavailable(api_client, viewer, host)
    current = rejoin(participant, 2)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', current).status_code == 200
    cm.refresh_from_db()
    assert cm.host_peer_id == uuid.UUID(current['peerId']) and cm.host_left_at is None
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('missing_heartbeat', [False, True])
@pytest.mark.parametrize('new_provider_session', [False, True])
def test_host_rejoin_during_stale_lease_recovers_on_later_heartbeat(
        api_client, actors, provider, keypair, missing_heartbeat, new_provider_session):
    host, viewer = actors
    cm, meeting, original, session = live_host(api_client, host, provider, keypair)
    # A viewer keeps the provider session open while the host loses both its
    # dashboard heartbeat and SDK connection.
    assert viewer_join(api_client, viewer, host).status_code == 200
    CreatorMeeting.objects.filter(pk=cm.pk).update(host_session_seen_at=(
        None if missing_heartbeat else timezone.now() - timedelta(seconds=61)))
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(original)).status_code == 200
    if new_provider_session:
        meeting = dict(meeting, sessionId=str(uuid.uuid4()),
            startedAt=(datetime.fromisoformat(meeting['startedAt']) + timedelta(seconds=10)).isoformat())
    current = rejoin(original, 11 if new_provider_session else 2)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', current).status_code == 200
    assert_unavailable(api_client, viewer, host)
    assert ServiceAdmission.objects.count() == 1
    assert provider.add_participant.call_count == 2
    assert not PayableJournal.objects.exists()
    # No second provider event or token mint is needed after HTTP recovers.
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    admitted = viewer_join(api_client, viewer, host)
    assert admitted.status_code == 200, admitted.data
    cm.refresh_from_db()
    assert cm.host_peer_id == uuid.UUID(current['peerId']) and cm.host_left_at is None
    assert cm.lifecycle_state == LIFECYCLE_LIVE
    assert ServiceAdmission.objects.count() == 2
    assert provider.add_participant.call_count == 3
    assert not PayableJournal.objects.exists()


@pytest.mark.parametrize('fence', [
    'departed_peer', 'older_peer', 'ended_session', 'older_session', 'tied_session',
    'old_claim', 'canonical_replaced', 'released_seat', 'missing_owner', 'pending_claim',
])
def test_stale_lease_rejoin_preserves_host_and_provider_fences(
        api_client, actors, provider, keypair, fence):
    from dj.apps.dyte.host_identity import host_participant_identity
    from dj.apps.dyte.host_presence import HOST_PRESENCE_FIELDS
    host, viewer = actors
    cm, meeting, original, session = live_host(api_client, host, provider, keypair)
    CreatorMeeting.objects.filter(pk=cm.pk).update(host_session_seen_at=timezone.now() - timedelta(seconds=61))
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(original)).status_code == 200
    current = rejoin(original, 2)
    if fence == 'departed_peer':
        current = original
    elif fence == 'older_peer':
        assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(rejoin(original, 10))).status_code == 200
    elif fence == 'ended_session':
        assert event(api_client, keypair, meeting, 'meeting.ended').status_code == 200
    elif fence in ('older_session', 'tied_session'):
        observed = dict(meeting, sessionId=str(uuid.uuid4()))
        if fence == 'older_session':
            observed['startedAt'] = (datetime.fromisoformat(meeting['startedAt']) + timedelta(seconds=10)).isoformat()
        assert event(api_client, keypair, observed, 'meeting.started').status_code == 200
    elif fence == 'old_claim':
        current['customParticipantId'] = host_participant_identity(host.public_id, uuid.uuid4())
    elif fence == 'canonical_replaced':
        CreatorMeeting.objects.filter(pk=cm.pk).update(host_participant_id=str(uuid.uuid4()))
    elif fence == 'released_seat':
        assert _seat(api_client, host, session, 'release').status_code == 200
    elif fence == 'missing_owner':
        # Retained signed proof cannot replace missing HTTP seat ownership.
        CreatorMeeting.objects.filter(pk=cm.pk).update(host_session_id=None)
    elif fence == 'pending_claim':
        CreatorMeeting.objects.filter(pk=cm.pk).update(host_start_claim=uuid.uuid4())
    cm.refresh_from_db()
    before = tuple(getattr(cm, field) for field in HOST_PRESENCE_FIELDS)
    # A fabricated, never-minted claim has no canonical participant binding.
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', current).status_code == (503 if fence == 'old_claim' else 200)
    cm.refresh_from_db()
    assert tuple(getattr(cm, field) for field in HOST_PRESENCE_FIELDS) == before
    heartbeat = _seat(api_client, host, session, 'heartbeat')
    assert heartbeat.status_code == (409 if fence in ('released_seat', 'missing_owner') else 200)
    refused = viewer_join(api_client, viewer, host)
    assert refused.status_code == (404 if fence in ('ended_session', 'tied_session') else 409)
    if refused.status_code == 409:
        assert refused.data['code'] == 'livestream_offer_unavailable'
    assert provider.add_participant.call_count == 1
    assert not ServiceAdmission.objects.exists()
    assert not PayableJournal.objects.exists()


@pytest.mark.parametrize('leave_delivered_first', [True, False])
def test_older_overlapping_peer_departure_cannot_close_newer_join(api_client, actors, provider, keypair, leave_delivered_first):
    host, viewer = actors
    cm, meeting, original, _ = live_host(api_client, host, provider, keypair)
    current = rejoin(original, 10)
    # The old peer finishes leaving after its replacement joined. Ordering on
    # leftAt would incorrectly reject the still-present replacement.
    callbacks = [('meeting.participantLeft', departure(original, 12)),
        ('meeting.participantJoined', current)]
    if not leave_delivered_first:
        callbacks.reverse()
    for kind, participant in callbacks:
        assert event(api_client, keypair, meeting, kind, participant).status_code == 200
    cm.refresh_from_db()
    assert cm.host_peer_id == uuid.UUID(current['peerId']) and cm.host_left_at is None
    assert viewer_join(api_client, viewer, host).status_code == 200


def test_unseen_newer_peer_departure_blocks_its_delayed_join(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, original, _ = live_host(api_client, host, provider, keypair)
    newer = rejoin(original, 10)
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(newer)).status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', newer).status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', original).status_code == 200
    cm.refresh_from_db()
    assert cm.host_peer_id == uuid.UUID(newer['peerId']) and cm.host_left_at is not None
    assert_unavailable(api_client, viewer, host)


def test_equal_time_different_peer_cannot_clear_departure(api_client, actors, provider, keypair):
    host, viewer = actors
    _, meeting, original, _ = live_host(api_client, host, provider, keypair)
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(original)).status_code == 200
    ambiguous = rejoin(original, 0)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', ambiguous).status_code == 200
    assert_unavailable(api_client, viewer, host)


@pytest.mark.parametrize('conflicting_event', ['meeting.participantJoined', 'meeting.participantLeft'])
def test_equal_time_peer_conflict_closes_live_until_strictly_newer_join(api_client, actors, provider, keypair, conflicting_event):
    host, viewer = actors
    cm, meeting, original, session = live_host(api_client, host, provider, keypair)
    assert viewer_join(api_client, viewer, host).status_code == 200
    conflicting = rejoin(original, 0)
    observed = departure(conflicting) if conflicting_event.endswith('Left') else conflicting
    assert event(api_client, keypair, meeting, conflicting_event, observed).status_code == 200
    for peer in (original, conflicting, original):
        assert event(api_client, keypair, meeting, 'meeting.participantJoined', peer).status_code == 200
        assert _seat(api_client, host, session, 'heartbeat').status_code == 200
        assert_unavailable(api_client, viewer, host)
    cm.refresh_from_db()
    assert cm.host_peer_id is None and cm.host_left_at is None
    assert cm.host_joined_at == datetime.fromisoformat(original['joinedAt'])
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(original, 2)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('kind', ['meeting.started', 'meeting.participantJoined', 'meeting.participantLeft', 'meeting.ended'])
def test_same_session_changed_start_time_cannot_move_presence_fence(api_client, actors, provider, keypair, kind):
    host, viewer = actors
    cm, meeting, original, _ = live_host(api_client, host, provider, keypair)
    inconsistent = dict(meeting,
        startedAt=(datetime.fromisoformat(meeting['startedAt']) + timedelta(seconds=1)).isoformat())
    participant = departure(rejoin(original, 2)) if kind.endswith('Left') else rejoin(original, 2)
    assert event(api_client, keypair, inconsistent, kind, participant).status_code == 200
    cm.refresh_from_db()
    assert cm.provider_session_started_at == datetime.fromisoformat(meeting['startedAt'])
    assert cm.host_peer_id == uuid.UUID(original['peerId']) and cm.host_left_at is None
    assert viewer_join(api_client, viewer, host).status_code == 200


def test_previous_provider_session_departure_cannot_close_reconnect(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, old_meeting, original, _ = live_host(api_client, host, provider, keypair)
    current = rejoin(original, 20)
    meeting = dict(old_meeting, sessionId=str(uuid.uuid4()),
        startedAt=(datetime.fromisoformat(original['joinedAt']) + timedelta(seconds=10)).isoformat())
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', current).status_code == 200
    assert event(api_client, keypair, old_meeting, 'meeting.participantLeft', departure(original, 30)).status_code == 200
    cm.refresh_from_db()
    assert str(cm.provider_session_id) == meeting['sessionId'] and cm.lifecycle_state == LIFECYCLE_LIVE
    assert viewer_join(api_client, viewer, host).status_code == 200


def test_replacement_resets_presence_and_old_claim_departure_is_free(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, original, _ = live_host(api_client, host, provider, keypair)
    balance = host.tuzis
    replacement = _start(api_client, host, meeting_type='ppv', session=uuid.uuid4(), takeover=True)
    assert replacement.status_code == 200
    current = rejoin(original, 10)
    current['customParticipantId'] = provider.add_participant.call_args.kwargs['custom_participant_id']
    cm.refresh_from_db()
    assert cm.lifecycle_state == LIFECYCLE_STARTING
    assert cm.host_peer_id is None and cm.host_joined_at is None and cm.host_left_at is None
    assert_unavailable(api_client, viewer, host)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', current).status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(original, 20)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200
    host.refresh_from_db()
    assert host.tuzis == balance and not PayableJournal.objects.exists()


def test_inflight_host_refresh_refuses_viewers_until_new_provider_join(api_client, actors, provider, keypair):
    host, viewer = actors
    _, _, _, session = live_host(api_client, host, provider, keypair)
    token_response = provider.add_participant.return_value

    def during_provider_request(*args, **kwargs):
        assert_unavailable(api_client, viewer, host)
        return token_response

    provider.add_participant.side_effect = during_provider_request
    refreshed = _start(api_client, host, meeting_type='ppv', session=session)
    assert refreshed.status_code == 200
    assert not ServiceAdmission.objects.exists()


def test_old_pod_participant_replacement_invalidates_presence_and_old_callbacks(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, participant, session = live_host(api_client, host, provider, keypair)
    assert viewer_join(api_client, viewer, host).status_code == 200
    # A prior application version knows only the canonical participant field;
    # it cannot clear the new presence projection or update the signed claim.
    CreatorMeeting.objects.filter(pk=cm.pk).update(host_participant_id=str(uuid.uuid4()))
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    assert_unavailable(api_client, viewer, host)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(participant, 2)).status_code == 200
    assert_unavailable(api_client, viewer, host)
    assert ServiceAdmission.objects.count() == 1


def test_old_pod_session_advance_cannot_reuse_an_absent_host_projection(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, original_meeting, participant, session = live_host(api_client, host, provider, keypair)
    assert viewer_join(api_client, viewer, host).status_code == 200
    # Exact legacy callback writes: ended clears only public room presence;
    # a viewer's new session then advances only the provider session fields.
    CreatorMeeting.objects.filter(pk=cm.pk).update(live_now=False)
    meeting = dict(original_meeting, sessionId=str(uuid.uuid4()),
        startedAt=(datetime.fromisoformat(original_meeting['startedAt']) + timedelta(seconds=10)).isoformat())
    CreatorMeeting.objects.filter(pk=cm.pk).update(live_now=True,
        provider_session_id=meeting['sessionId'],
        provider_session_started_at=datetime.fromisoformat(meeting['startedAt']))
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    assert_unavailable(api_client, viewer, host)
    assert event(api_client, keypair, original_meeting, 'meeting.participantLeft', departure(participant, 20)).status_code == 200
    assert_unavailable(api_client, viewer, host)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(participant, 30)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('late_leave', [False, True])
def test_old_pod_end_remains_terminal_for_same_session_callbacks(api_client, actors, provider, keypair, late_leave):
    host, viewer = actors
    cm, meeting, participant, session = live_host(api_client, host, provider, keypair)
    CreatorMeeting.objects.filter(pk=cm.pk).update(live_now=False)
    if late_leave:
        assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(participant)).status_code == 200
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(participant, 2)).status_code == 200
    cm.refresh_from_db()
    assert not cm.live_now
    assert viewer_join(api_client, viewer, host).status_code == 404


def test_old_pod_end_after_departure_blocks_delayed_replacement_join(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, participant, _ = live_host(api_client, host, provider, keypair)
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(participant)).status_code == 200
    cm.refresh_from_db()
    assert cm.lifecycle_state == LIFECYCLE_STARTING
    CreatorMeeting.objects.filter(pk=cm.pk).update(live_now=False)
    replacement = rejoin(participant, 2)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', replacement).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 404


def test_new_session_departure_before_started_preserves_tombstone_and_can_rejoin(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, old_meeting, participant, _ = live_host(api_client, host, provider, keypair)
    CreatorMeeting.objects.filter(pk=cm.pk).update(live_now=False)
    meeting = dict(old_meeting, sessionId=str(uuid.uuid4()),
        startedAt=(datetime.fromisoformat(old_meeting['startedAt']) + timedelta(seconds=10)).isoformat())
    first = rejoin(participant, 11)
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(first)).status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.started').status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', first).status_code == 200
    assert_unavailable(api_client, viewer, host)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(participant, 13)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


def test_old_pod_same_session_start_time_change_invalidates_projection(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, participant, _ = live_host(api_client, host, provider, keypair)
    changed = datetime.fromisoformat(meeting['startedAt']) + timedelta(milliseconds=1)
    CreatorMeeting.objects.filter(pk=cm.pk).update(provider_session_started_at=changed)
    assert_unavailable(api_client, viewer, host)
    # A callback can rebuild the session proof only when it agrees with the
    # current room's full provider session tuple.
    corrected = dict(meeting, startedAt=changed.isoformat())
    assert event(api_client, keypair, corrected, 'meeting.participantJoined', rejoin(participant, 2)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('missing', ['host_peer_id', 'host_joined_at', 'host_presence_participant_id',
    'host_presence_session_id', 'host_presence_session_started_at'])
def test_null_provider_projection_never_inherits_live_readiness(api_client, actors, provider, keypair, missing):
    host, viewer = actors
    cm, _, _, _ = live_host(api_client, host, provider, keypair)
    setattr(cm, missing, None)
    cm.save(update_fields=[missing])
    assert_unavailable(api_client, viewer, host)


def test_ended_session_departure_cannot_enable_a_delayed_join(api_client, actors, provider, keypair):
    host, viewer = actors
    cm, meeting, original, session = live_host(api_client, host, provider, keypair)
    assert event(api_client, keypair, meeting, 'meeting.ended').status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(original)).status_code == 200
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(original, 2)).status_code == 200
    cm.refresh_from_db()
    assert cm.lifecycle_state == 'offline' and not cm.live_now
    assert viewer_join(api_client, viewer, host).status_code == 404


@pytest.mark.parametrize('known_session', [False, True])
@pytest.mark.parametrize('delivery_order', list(permutations(('started', 'participantJoined', 'participantLeft', 'ended'))))
def test_completed_session_delivery_order_cannot_reopen_paid_admission(
        api_client, actors, provider, keypair, known_session, delivery_order):
    host, viewer = actors
    cm, initial, participant, session = live_host(api_client, host, provider, keypair, announce=known_session)
    meeting = dict(initial, sessionId=str(uuid.uuid4()),
        startedAt=(datetime.fromisoformat(initial['startedAt']) + timedelta(seconds=10)).isoformat()) if known_session else initial
    current = rejoin(participant, 11) if known_session else participant
    for kind in delivery_order:
        observed = departure(current) if kind == 'participantLeft' else current
        assert event(api_client, keypair, meeting, f'meeting.{kind}', observed).status_code == 200
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    cm.refresh_from_db()
    assert not cm.live_now and cm.lifecycle_state == 'offline'
    assert str(cm.provider_session_id) == meeting['sessionId']
    assert viewer_join(api_client, viewer, host).status_code == 404
    assert not ServiceAdmission.objects.exists()
    later = dict(meeting, sessionId=str(uuid.uuid4()),
        startedAt=(datetime.fromisoformat(meeting['startedAt']) + timedelta(seconds=20)).isoformat())
    assert event(api_client, keypair, later, 'meeting.participantJoined', rejoin(current, 21)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('kind', ['meeting.participantJoined', 'meeting.participantLeft'])
def test_nonhost_new_session_observation_closes_old_paid_presence(api_client, actors, provider, keypair, kind):
    from dj.apps.economy.services import EconomicRefusal
    host, viewer = actors
    _, initial, host_participant, session = live_host(api_client, host, provider, keypair)
    meeting = dict(initial, sessionId=str(uuid.uuid4()),
        startedAt=(datetime.fromisoformat(initial['startedAt']) + timedelta(seconds=10)).isoformat())
    participant = dict(rejoin(host_participant, 11), customParticipantId=viewer.username)
    if kind.endswith('Left'):
        # The unknown viewer's financial refusal cannot roll back the signed
        # room observation and resurrect readiness from the previous session.
        with pytest.raises(EconomicRefusal, match='livestream_delivery_integration_unavailable'):
            event(api_client, keypair, meeting, kind, departure(participant))
    else:
        assert event(api_client, keypair, meeting, kind, participant).status_code == 200
    assert _seat(api_client, host, session, 'heartbeat').status_code == 200
    assert_unavailable(api_client, viewer, host)
    assert not ServiceAdmission.objects.exists()
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(host_participant, 12)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('kind', ['meeting.started', 'meeting.ended', 'meeting.participantJoined', 'meeting.participantLeft'])
def test_equal_start_distinct_sessions_close_until_strictly_later_session(api_client, actors, provider, keypair, kind):
    host, viewer = actors
    cm, original, participant, session = live_host(api_client, host, provider, keypair)
    ambiguous = dict(original, sessionId=str(uuid.uuid4()))
    observed = departure(participant) if kind.endswith('Left') else participant
    assert event(api_client, keypair, ambiguous, kind, observed).status_code == 200
    for meeting in (original, ambiguous, original):
        assert event(api_client, keypair, meeting, 'meeting.started').status_code == 200
        assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(participant, 2)).status_code == 200
        assert _seat(api_client, host, session, 'heartbeat').status_code == 200
        assert viewer_join(api_client, viewer, host).status_code == 404
    cm.refresh_from_db()
    assert cm.provider_session_id is None
    assert cm.provider_session_started_at == datetime.fromisoformat(original['startedAt'])
    later = dict(original, sessionId=str(uuid.uuid4()),
        startedAt=(datetime.fromisoformat(original['startedAt']) + timedelta(seconds=10)).isoformat())
    assert event(api_client, keypair, later, 'meeting.participantJoined', rejoin(participant, 11)).status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('intervening', ['ended', 'newer'])
def test_room_observation_between_dispatch_and_host_handler_cannot_be_overwritten(
        api_client, actors, provider, keypair, mocker, intervening):
    from dj.apps.dyte import views
    from dj.apps.dyte.types import WebhookEvent
    host, viewer = actors
    cm, meeting, participant, _ = live_host(api_client, host, provider, keypair)
    observe = views._observe_provider_session

    def interleave(**kwargs):
        observe(**kwargs)
        advanced = meeting if intervening == 'ended' else dict(meeting, sessionId=str(uuid.uuid4()),
            startedAt=(datetime.fromisoformat(meeting['startedAt']) + timedelta(seconds=10)).isoformat())
        observe(cm=cm, event_data=WebhookEvent.model_validate({
            'event': 'meeting.ended' if intervening == 'ended' else 'meeting.started', 'meeting': advanced}))

    mocker.patch.object(views, '_observe_provider_session', side_effect=interleave)
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', rejoin(participant, 2)).status_code == 200
    if intervening == 'ended':
        assert viewer_join(api_client, viewer, host).status_code == 404
    else:
        assert_unavailable(api_client, viewer, host)


@pytest.mark.parametrize('invalid', ['naive', 'before_join'])
def test_invalid_departure_time_does_not_replace_current_evidence(api_client, actors, provider, keypair, invalid):
    host, viewer = actors
    cm, meeting, original, _ = live_host(api_client, host, provider, keypair)
    malformed = departure(original, -1 if invalid == 'before_join' else 1)
    if invalid == 'naive':
        malformed['leftAt'] = datetime.fromisoformat(malformed['leftAt']).replace(tzinfo=None).isoformat()
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', malformed).status_code == 200
    cm.refresh_from_db()
    assert cm.host_left_at is None and cm.host_peer_id == uuid.UUID(original['peerId'])
    assert viewer_join(api_client, viewer, host).status_code == 200


@pytest.mark.parametrize('invalid', ['missing_joined', 'naive_joined', 'naive_session'])
def test_invalid_provider_join_time_cannot_open_admission(api_client, actors, provider, keypair, invalid):
    host, viewer = actors
    _, meeting, participant, _ = live_host(api_client, host, provider, keypair, announce=False)
    if invalid == 'missing_joined':
        participant.pop('joinedAt')
    elif invalid == 'naive_joined':
        participant['joinedAt'] = datetime.fromisoformat(participant['joinedAt']).replace(tzinfo=None).isoformat()
    elif invalid == 'naive_session':
        meeting['startedAt'] = datetime.fromisoformat(meeting['startedAt']).replace(tzinfo=None).isoformat()
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', participant).status_code == 200
    assert_unavailable(api_client, viewer, host)


def test_provider_join_and_session_timestamps_need_no_cross_field_order(api_client, actors, provider, keypair):
    host, viewer = actors
    _, meeting, participant, _ = live_host(api_client, host, provider, keypair, announce=False)
    # The provider does not promise cross-field clock/precision ordering.
    # Signed session identity and each peer's own joinedAt define our fences.
    participant['joinedAt'] = (datetime.fromisoformat(meeting['startedAt']) - timedelta(milliseconds=1)).isoformat()
    assert event(api_client, keypair, meeting, 'meeting.participantJoined', participant).status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.started').status_code == 200
    assert viewer_join(api_client, viewer, host).status_code == 200
    assert event(api_client, keypair, meeting, 'meeting.participantLeft', departure(participant)).status_code == 200
    assert_unavailable(api_client, viewer, host)


@pytest.mark.django_db(transaction=True)
def test_nullable_presence_migration_preserves_old_pod_inserts_without_fabricating_presence(creator_factory):
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor
    from django.db.migrations.loader import MigrationLoader
    from dj.apps.dyte.host_presence import host_is_present

    creator = creator_factory()
    old = ('dyte', '0018_nullable_creator_meeting_id')
    new = ('dyte', '0019_creator_meeting_host_presence')
    MigrationExecutor(connection).migrate([old])
    old_apps = MigrationExecutor(connection).loader.project_state([old]).apps
    OldMeeting = old_apps.get_model('dyte', 'CreatorMeeting')
    before = OldMeeting.objects.create(creator_id=creator.pk, meeting_type='ppv',
        meeting_id=str(uuid.uuid4()), live_now=True, lifecycle_state='live',
        host_session_id=uuid.uuid4(), host_session_seen_at=timezone.now())
    try:
        MigrationExecutor(connection).migrate([new])
        # An older application omits the new columns during rolling deploys.
        after = OldMeeting.objects.create(creator_id=creator.pk, meeting_type='broadcast',
            meeting_id=str(uuid.uuid4()))
        for pk in (before.pk, after.pk):
            meeting = CreatorMeeting.objects.get(pk=pk)
            assert meeting.host_peer_id is None and meeting.host_joined_at is None and meeting.host_left_at is None
            assert meeting.host_presence_participant_id is None
            assert meeting.host_presence_session_id is None and meeting.host_presence_session_started_at is None
            assert not host_is_present(meeting)
        retained = CreatorMeeting.objects.get(pk=before.pk)
        assert retained.live_now and retained.lifecycle_state == 'live'
    finally:
        MigrationExecutor(connection).migrate(MigrationLoader(connection).graph.leaf_nodes())
