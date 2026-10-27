"""One broadcaster seat per creator.

Every path that used to produce a second host -- or move the room out from
under a live broadcast -- is pinned here against real Postgres:

* a second dashboard tab/window/device pressing Go live;
* a retry or double click from the SAME tab (must resume, not duplicate);
* the creator opening their own public stream page (must be a viewer);
* a refresh after the seat was given back, on a room over a day old
  (must not rotate a room viewers are in);
* two tabs deciding at the same instant (the advisory lock).
"""
import threading
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.dyte.models import (
    BROADCAST,
    PAY_PER_VIEW,
    SUBSCRIBERS_ONLY,
    CreatorMeeting,
)
from dj.apps.dyte.views import HOST_SESSION_TTL

pytestmark = pytest.mark.django_db


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.text = 'ok'

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


@pytest.fixture
def host(creator_factory):
    return creator_factory(username='seat-host', tuzis=Decimal('1000'))


def _start(client, creator, *, session=None, takeover=False,
           meeting_type=BROADCAST, **extra):
    client.force_authenticate(user=creator)
    body = {'role': 'host', 'takeover': takeover, **extra}
    if session is not None:
        body['host_session'] = str(session)
    return client.post(
        f'/api/dyte/{creator.username}/{meeting_type}', body, format='json')


def _seat(client, creator, session, action):
    client.force_authenticate(user=creator)
    return client.post(
        f'/api/dyte/{creator.username}/host-session',
        {'host_session': str(session), 'action': action},
        format='json',
    )


def _roles(provider):
    return [c.kwargs.get('role') for c in provider.add_participant.call_args_list]


# ---------------------------------------------------------------------------
# a second tab / device
# ---------------------------------------------------------------------------

def test_a_second_tab_cannot_start_a_second_broadcast(api_client, provider, host):
    tab_a, tab_b = uuid.uuid4(), uuid.uuid4()

    first = _start(api_client, host, session=tab_a)
    assert first.status_code == 200, first.data
    room = first.data['meeting_id']

    second = _start(api_client, host, session=tab_b)

    assert second.status_code == 409, second.data
    assert second.data['code'] == 'already_live_elsewhere'
    assert second.data['meeting_type'] == BROADCAST
    assert 'auth_token' not in second.data
    # Nothing was created, joined or rotated for the second tab.
    assert provider.create_meeting.call_count == 1
    assert provider.add_participant.call_count == 1
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.meeting_id == room
    assert cm.host_session_id == tab_a


def test_a_second_tab_on_another_meeting_type_is_refused_too(
    api_client, provider, host,
):
    _start(api_client, host, session=uuid.uuid4())

    ppv = _start(api_client, host, session=uuid.uuid4(),
                 meeting_type=PAY_PER_VIEW, price_per_minute='2')

    assert ppv.status_code == 409, ppv.data
    assert ppv.data['meeting_type'] == BROADCAST
    assert not CreatorMeeting.objects.filter(
        creator=host, meeting_type=PAY_PER_VIEW).exists()


def test_the_status_endpoint_tells_a_fresh_tab_it_is_live_elsewhere(
    api_client, provider, host,
):
    tab_a = uuid.uuid4()
    api_client.force_authenticate(user=host)
    url = f'/api/dyte/{host.username}/host-session'

    idle = api_client.get(url)
    assert idle.status_code == 200
    assert idle.data['active'] is False

    _start(api_client, host, session=tab_a)
    live = api_client.get(url)

    assert live.data['active'] is True
    assert live.data['host_session'] == tab_a
    assert live.data['meeting_type'] == BROADCAST
    assert live.data['ttl_seconds'] == int(HOST_SESSION_TTL.total_seconds())


# ---------------------------------------------------------------------------
# the same tab: retry / double click
# ---------------------------------------------------------------------------

def test_the_same_tab_retrying_resumes_instead_of_duplicating(
    api_client, provider, host,
):
    tab = uuid.uuid4()
    first = _start(api_client, host, session=tab)
    # A day later the row is "aged" -- the pre- rule would rotate here.
    CreatorMeeting.objects.filter(creator=host).update(
        created_at=timezone.now() - timedelta(days=3))

    again = _start(api_client, host, session=tab)

    assert again.status_code == 200, again.data
    assert again.data['resumed'] is True
    assert again.data['meeting_id'] == first.data['meeting_id']
    assert provider.create_meeting.call_count == 1
    assert _roles(provider) == ['host', 'host']


def test_resuming_never_reprices_a_live_ppv_stream(api_client, provider, host):
    tab = uuid.uuid4()
    _start(api_client, host, session=tab, meeting_type=PAY_PER_VIEW,
           price_per_minute='2')

    _start(api_client, host, session=tab, meeting_type=PAY_PER_VIEW,
           price_per_minute='50')

    cm = CreatorMeeting.objects.get(creator=host, meeting_type=PAY_PER_VIEW)
    assert cm.price_per_minute == Decimal('2')


# ---------------------------------------------------------------------------
# take over
# ---------------------------------------------------------------------------

def test_take_over_moves_the_seat_and_keeps_the_live_room(
    api_client, provider, host,
):
    tab_a, tab_b = uuid.uuid4(), uuid.uuid4()
    room = _start(api_client, host, session=tab_a).data['meeting_id']
    CreatorMeeting.objects.filter(creator=host).update(
        created_at=timezone.now() - timedelta(days=3))

    taken = _start(api_client, host, session=tab_b, takeover=True)

    assert taken.status_code == 200, taken.data
    assert taken.data['meeting_id'] == room  # viewers stay connected
    assert taken.data['resumed'] is True
    assert provider.create_meeting.call_count == 1
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.host_session_id == tab_b

    # The tab that lost the seat learns so on its next heartbeat...
    lost = _seat(api_client, host, tab_a, 'heartbeat')
    assert lost.status_code == 409
    assert lost.data['code'] == 'host_session_superseded'
    #...and its release on the way out cannot free the new holder's seat.
    _seat(api_client, host, tab_a, 'release')
    cm.refresh_from_db()
    assert cm.host_session_id == tab_b


def test_take_over_across_meeting_types_leaves_exactly_one_seat(
    api_client, provider, host,
):
    _start(api_client, host, session=uuid.uuid4())
    tab_b = uuid.uuid4()

    taken = _start(api_client, host, session=tab_b, takeover=True,
                   meeting_type=SUBSCRIBERS_ONLY)

    assert taken.status_code == 200, taken.data
    holders = CreatorMeeting.objects.filter(
        creator=host, host_session_id__isnull=False)
    assert [(h.meeting_type, h.host_session_id) for h in holders] == [
        (SUBSCRIBERS_ONLY, tab_b)]


def test_the_database_allows_one_seat_per_creator(host):
    now = timezone.now()
    CreatorMeeting.objects.create(
        creator=host, meeting_id='a', meeting_type=BROADCAST,
        host_session_id=uuid.uuid4(), host_session_seen_at=now)
    with pytest.raises(IntegrityError), transaction.atomic():
        CreatorMeeting.objects.create(
            creator=host, meeting_id='b', meeting_type=PAY_PER_VIEW,
            host_session_id=uuid.uuid4(), host_session_seen_at=now)


# ---------------------------------------------------------------------------
# lapsed seats, release, refresh
# ---------------------------------------------------------------------------

def test_a_seat_nobody_renews_lapses(api_client, provider, host):
    _start(api_client, host, session=uuid.uuid4())
    CreatorMeeting.objects.filter(creator=host).update(
        host_session_seen_at=timezone.now() - HOST_SESSION_TTL
        - timedelta(seconds=1))
    tab_b = uuid.uuid4()

    fresh = _start(api_client, host, session=tab_b)

    assert fresh.status_code == 200, fresh.data
    assert CreatorMeeting.objects.get(
        creator=host, meeting_type=BROADCAST).host_session_id == tab_b


def test_heartbeat_renews_the_seat(api_client, provider, host):
    tab = uuid.uuid4()
    _start(api_client, host, session=tab)
    stale = timezone.now() - timedelta(seconds=50)
    CreatorMeeting.objects.filter(creator=host).update(
        host_session_seen_at=stale)

    beat = _seat(api_client, host, tab, 'heartbeat')

    assert beat.status_code == 200, beat.data
    assert beat.data['active'] is True
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.host_session_seen_at > stale


def test_a_refresh_after_release_does_not_rotate_a_room_viewers_are_in(
    api_client, provider, host,
):
    tab_a = uuid.uuid4()
    room = _start(api_client, host, session=tab_a).data['meeting_id']
    CreatorMeeting.objects.filter(creator=host).update(
        created_at=timezone.now() - timedelta(days=3))

    released = _seat(api_client, host, tab_a, 'release')
    assert released.status_code == 200
    assert released.data['active'] is False
    # The reloaded page is a new tab id, and the seat is free: no prompt.
    back = _start(api_client, host, session=uuid.uuid4())

    assert back.status_code == 200, back.data
    assert back.data['meeting_id'] == room
    assert provider.create_meeting.call_count == 1


def test_an_aged_room_that_is_not_live_still_rotates(api_client, provider, host):
    """The  rule is unchanged for a room nobody is in."""
    CreatorMeeting.objects.create(
        creator=host, meeting_id='yesterday', meeting_type=BROADCAST,
        live_now=False, created_at=timezone.now() - timedelta(days=3))

    started = _start(api_client, host, session=uuid.uuid4())

    assert started.status_code == 200
    assert started.data['meeting_id'] != 'yesterday'


def test_only_the_owner_can_touch_the_seat(api_client, provider, host,
                                           creator_factory):
    tab = uuid.uuid4()
    _start(api_client, host, session=tab)
    stranger = creator_factory(username='seat-stranger')
    api_client.force_authenticate(user=stranger)
    url = f'/api/dyte/{host.username}/host-session'

    assert api_client.get(url).status_code == 403
    assert api_client.post(
        url, {'host_session': str(tab), 'action': 'release'},
        format='json').status_code == 403
    assert CreatorMeeting.objects.get(creator=host).host_session_id == tab


def test_a_legacy_client_without_a_session_still_cannot_take_a_held_seat(
    api_client, provider, host,
):
    tab = uuid.uuid4()
    _start(api_client, host, session=tab)
    api_client.force_authenticate(user=host)

    legacy = api_client.post(
        f'/api/dyte/{host.username}/broadcast', {}, format='json')

    assert legacy.status_code == 409, legacy.data
    assert provider.add_participant.call_count == 1


# ---------------------------------------------------------------------------
# the creator on their own public stream page
# ---------------------------------------------------------------------------

def test_the_owner_on_their_public_page_joins_as_a_viewer(
    api_client, provider, host,
):
    tab = uuid.uuid4()
    room = _start(api_client, host, session=tab).data['meeting_id']
    CreatorMeeting.objects.filter(creator=host).update(
        created_at=timezone.now() - timedelta(days=3))
    api_client.force_authenticate(user=host)

    watch = api_client.post(
        f'/api/dyte/{host.username}/broadcast', {'role': 'viewer'},
        format='json')

    assert watch.status_code == 200, watch.data
    assert watch.data == {'meeting_id': room, 'auth_token': 'auth-token'}
    assert _roles(provider) == ['host', 'viewer']
    assert provider.create_meeting.call_count == 1
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.meeting_id == room
    assert cm.host_session_id == tab


def test_the_owner_viewing_an_offline_stream_creates_nothing(
    api_client, provider, host,
):
    api_client.force_authenticate(user=host)

    watch = api_client.post(
        f'/api/dyte/{host.username}/broadcast', {'role': 'viewer'},
        format='json')

    assert watch.status_code == 404
    assert provider.create_meeting.call_count == 0
    assert provider.add_participant.call_count == 0
    assert not CreatorMeeting.objects.filter(creator=host).exists()


def test_the_owner_can_watch_their_own_subscribers_only_stream(
    api_client, provider, host,
):
    _start(api_client, host, session=uuid.uuid4(),
           meeting_type=SUBSCRIBERS_ONLY)
    api_client.force_authenticate(user=host)

    watch = api_client.post(
        f'/api/dyte/{host.username}/{SUBSCRIBERS_ONLY}', {'role': 'viewer'},
        format='json')

    assert watch.status_code == 200, watch.data
    assert _roles(provider)[-1] == 'viewer'


def test_a_viewer_can_never_ask_for_the_host_preset(
    api_client, provider, host, creator_factory,
):
    _start(api_client, host, session=uuid.uuid4())
    fan = creator_factory(username='seat-fan')
    api_client.force_authenticate(user=fan)

    joined = api_client.post(
        f'/api/dyte/{host.username}/broadcast',
        {'role': 'host', 'takeover': True}, format='json')

    assert joined.status_code == 200
    assert _roles(provider)[-1] == 'viewer'
    assert CreatorMeeting.objects.get(
        creator=host).host_session_id is not None


# ---------------------------------------------------------------------------
# two tabs at the same instant
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_two_tabs_racing_get_exactly_one_seat_and_a_clean_409(
    creator_factory, mocker,
):
    """Both requests see a free seat unless the decision is serialized.

    The slow provider call keeps the first request's transaction open while
    the second one decides; without the per-creator lock the second one
    also decides the seat is free, goes to the provider, and dies on the
    partial unique constraint with a 500.
    """
    host = creator_factory(username='seat-racer', tuzis=Decimal('1000'))
    CreatorMeeting.objects.create(
        creator=host, meeting_id='race-room', meeting_type=BROADCAST)
    barrier = threading.Barrier(2)
    client = mocker.MagicMock()

    def slow_add(*args, **kwargs):
        threading.Event().wait(0.5)
        return _FakeResponse({'data': {'token': 'auth-token'}})

    client.add_participant.side_effect = slow_add
    mocker.patch('dj.apps.dyte.views.DyteClient', return_value=client)
    results = []

    def tab():
        try:
            barrier.wait()
            api = APIClient()
            api.force_authenticate(user=host)
            results.append(api.post(
                f'/api/dyte/{host.username}/broadcast',
                {'role': 'host', 'host_session': str(uuid.uuid4())},
                format='json',
            ).status_code)
        except Exception as exc:  # an unhandled IntegrityError is a finding
            results.append(repr(exc))
        finally:
            connection.close()

    threads = [threading.Thread(target=tab) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)

    assert sorted(results, key=str) == [200, 409]
    assert CreatorMeeting.objects.filter(
        creator=host, host_session_id__isnull=False).count() == 1


# ---------------------------------------------------------------------------
# codex adversarial review findings
# ---------------------------------------------------------------------------

def test_a_reload_never_reprices_a_live_ppv_room(api_client, provider, host):
    tab_a = uuid.uuid4()
    _start(api_client, host, session=tab_a, meeting_type=PAY_PER_VIEW,
           price_per_minute='2')
    # The seat is given back (a reload) but viewers are still in the room.
    _seat(api_client, host, tab_a, 'release')

    back = _start(api_client, host, session=uuid.uuid4(),
                  meeting_type=PAY_PER_VIEW, price_per_minute='50')

    assert back.status_code == 200, back.data
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=PAY_PER_VIEW)
    assert cm.price_per_minute == Decimal('2')


def test_a_new_price_applies_once_the_room_is_offline(api_client, provider, host):
    tab_a = uuid.uuid4()
    _start(api_client, host, session=tab_a, meeting_type=PAY_PER_VIEW,
           price_per_minute='2')
    _seat(api_client, host, tab_a, 'release')
    CreatorMeeting.objects.filter(creator=host).update(live_now=False)

    _start(api_client, host, session=uuid.uuid4(),
           meeting_type=PAY_PER_VIEW, price_per_minute='5')

    cm = CreatorMeeting.objects.get(creator=host, meeting_type=PAY_PER_VIEW)
    assert cm.price_per_minute == Decimal('5')


def test_a_transient_provider_error_on_takeover_does_not_rotate(
    api_client, provider, host,
):
    room = _start(api_client, host, session=uuid.uuid4()).data['meeting_id']
    busy = _FakeResponse({'success': False, 'error': {'code': 429}})
    busy.status_code = 429
    provider.add_participant.return_value = busy

    taken = _start(api_client, host, session=uuid.uuid4(), takeover=True)

    assert taken.status_code == 502
    assert provider.create_meeting.call_count == 1
    assert CreatorMeeting.objects.get(creator=host).meeting_id == room


def test_a_missing_room_is_still_replaced(api_client, provider, host):
    CreatorMeeting.objects.create(
        creator=host, meeting_id='gone', meeting_type=BROADCAST, live_now=True)
    gone = _FakeResponse({'success': False, 'error': {'code': 404}})
    gone.status_code = 404
    ok = _FakeResponse({'data': {'token': 'auth-token', 'id': 'p-new'}})
    provider.add_participant.side_effect = [gone, ok]

    started = _start(api_client, host, session=uuid.uuid4())

    assert started.status_code == 200, started.data
    assert started.data['meeting_id'] != 'gone'


def test_a_takeover_kicks_the_previous_host_at_the_provider(
    api_client, provider, host,
):
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token', 'id': 'participant-a'}})
    tab_a = uuid.uuid4()
    room = _start(api_client, host, session=tab_a).data['meeting_id']
    # A retry from the same tab is not a handoff: nobody is kicked.
    _start(api_client, host, session=tab_a)
    provider.retire_participant.assert_not_called()

    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token', 'id': 'participant-b'}})
    _start(api_client, host, session=uuid.uuid4(), takeover=True)

    provider.retire_participant.assert_called_once_with(room, 'participant-a')
    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_participant_id == 'participant-b'


def test_a_failed_kick_never_blocks_the_takeover(api_client, provider, host):
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token', 'id': 'participant-a'}})
    _start(api_client, host, session=uuid.uuid4())
    provider.retire_participant.return_value = False
    tab_b = uuid.uuid4()

    taken = _start(api_client, host, session=tab_b, takeover=True)

    assert taken.status_code == 200
    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_session_id == tab_b
    #...but the unconfirmed eviction is remembered, not forgotten.
    assert [e['participant_id'] for e in cm.host_evictions] == ['participant-a']

    # The new holder's heartbeats keep retrying it until the provider confirms.
    _seat(api_client, host, tab_b, 'heartbeat')
    cm.refresh_from_db()
    assert cm.host_evictions[0]['attempts'] == 2
    provider.retire_participant.return_value = True
    _seat(api_client, host, tab_b, 'heartbeat')
    cm.refresh_from_db()
    assert cm.host_evictions == []


def test_an_unconfirmed_eviction_survives_a_second_handoff(
    api_client, provider, host,
):
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token', 'id': 'participant-a'}})
    _start(api_client, host, session=uuid.uuid4())
    provider.retire_participant.return_value = False
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token', 'id': 'participant-b'}})
    _start(api_client, host, session=uuid.uuid4(), takeover=True)
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token', 'id': 'participant-c'}})

    _start(api_client, host, session=uuid.uuid4(), takeover=True,
           meeting_type=SUBSCRIBERS_ONLY)

    holder = CreatorMeeting.objects.get(
        creator=host, host_session_id__isnull=False)
    assert sorted(e['participant_id'] for e in holder.host_evictions) == [
        'participant-a', 'participant-b']
    assert not CreatorMeeting.objects.filter(creator=host).exclude(
        pk=holder.pk).exclude(host_evictions=[]).exists()


@pytest.mark.parametrize('status_code, confirmed', [
    (200, True), (404, True), (429, False), (500, False),
])
def test_kick_participants_is_best_effort(mocker, settings, status_code,
                                          confirmed):
    from dj.apps.dyte.client import DyteClient

    settings.RTK_API_BASE_URL = 'https://rtk.test'
    post = mocker.patch('dj.apps.dyte.client.requests.post')
    post.return_value.status_code = status_code

    assert DyteClient('org').kick_participants('room', ['p1']) is confirmed
    assert post.call_args.args[0] == (
        'https://rtk.test/v2/meetings/room/active-session/kick')
    assert post.call_args.kwargs['json'] == {'participant_ids': ['p1']}


def test_kick_participants_swallows_a_network_error(mocker):
    import requests as requests_lib
    from dj.apps.dyte.client import DyteClient

    mocker.patch('dj.apps.dyte.client.requests.post',
                 side_effect=requests_lib.ConnectionError('down'))
    assert DyteClient('org').kick_participants('room', ['p1']) is False


def test_retire_participant_kicks_then_deletes(mocker, settings):
    from dj.apps.dyte.client import DyteClient

    settings.RTK_API_BASE_URL = 'https://rtk.test'
    calls = []
    delete = mocker.patch('dj.apps.dyte.client.requests.delete')
    delete.return_value.status_code = 200
    delete.side_effect = lambda *a, **k: calls.append('delete') or delete.return_value
    post = mocker.patch('dj.apps.dyte.client.requests.post')
    post.return_value.status_code = 200
    post.side_effect = lambda *a, **k: calls.append('kick') or post.return_value

    assert DyteClient('org').retire_participant('room', 'p1') is True
    # Cloudflare's documented order: disconnect first, then revoke.
    assert calls == ['kick', 'delete']
    assert delete.call_args.args[0] == (
        'https://rtk.test/v2/meetings/room/participants/p1')

    delete.return_value.status_code = 500
    assert DyteClient('org').retire_participant('room', 'p1') is False


def test_a_same_tab_retry_retires_the_participant_it_replaces(
    api_client, provider, host,
):
    tab = uuid.uuid4()
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 't', 'id': 'first'}})
    room = _start(api_client, host, session=tab).data['meeting_id']
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 't', 'id': 'second'}})

    _start(api_client, host, session=tab)

    provider.retire_participant.assert_called_once_with(room, 'first')
    assert CreatorMeeting.objects.get(creator=host).host_participant_id == 'second'


def test_release_retires_the_host_and_remembers_a_failure(
    api_client, provider, host,
):
    tab = uuid.uuid4()
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 't', 'id': 'released-host'}})
    room = _start(api_client, host, session=tab).data['meeting_id']
    provider.retire_participant.return_value = False

    _seat(api_client, host, tab, 'release')

    provider.retire_participant.assert_called_once_with(room, 'released-host')
    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_session_id is None
    assert [e['participant_id'] for e in cm.host_evictions] == ['released-host']

    # The next seat, from any tab, inherits and retries it.
    provider.retire_participant.return_value = True
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 't', 'id': 'next-host'}})
    _start(api_client, host, session=uuid.uuid4())
    cm.refresh_from_db()
    assert cm.host_evictions == []


# ---------------------------------------------------------------------------
# independent review of PR
# ---------------------------------------------------------------------------

def test_a_row_inserted_by_the_previous_release_still_saves(host):
    """Old pods INSERT without the new columns during a rollout or rollback."""
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO dyte_creatormeeting (creator_id, meeting_id, "
            "meeting_type, is_public, live_now, created_at, "
            "price_per_minute, e2ee) VALUES (%s, 'old-pod', 'broadcast', "
            "true, false, now(), 0, false)",
            [host.pk],
        )
    cm = CreatorMeeting.objects.get(meeting_id='old-pod')
    assert cm.host_evictions == []
    assert cm.host_participant_id == ''


def test_slow_retirements_never_commit_a_lapsed_looking_heartbeat(
    api_client, provider, host, mocker,
):
    tab = uuid.uuid4()
    _start(api_client, host, session=tab)
    CreatorMeeting.objects.filter(creator=host).update(host_evictions=[
        {'meeting_id': 'r', 'participant_id': 'old', 'attempts': 0}])
    start = timezone.now()
    clock = {'now': start}

    def slow_retire(*args, **kwargs):
        clock['now'] = start + HOST_SESSION_TTL + timedelta(seconds=30)
        return False

    provider.retire_participant.side_effect = slow_retire
    mocker.patch('dj.apps.dyte.views.timezone.now',
                 side_effect=lambda: clock['now'])

    assert _seat(api_client, host, tab, 'heartbeat').status_code == 200

    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_session_seen_at == clock['now']
