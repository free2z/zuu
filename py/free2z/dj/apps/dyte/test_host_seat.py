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
from procrastinate.contrib.django.models import ProcrastinateJob
from rest_framework.test import APIClient

from dj.apps.dyte.models import (
    BROADCAST,
    PAY_PER_VIEW,
    SUBSCRIBERS_ONLY,
    CreatorMeeting,
    ProviderRoomCleanup,
)
from dj.apps.dyte.views import HOST_SESSION_TTL, HOST_START_CLAIM_TTL

pytestmark = pytest.mark.django_db

@pytest.fixture(autouse=True)
def eviction_producers_enabled(settings):
    # Exercise the active host-seat behavior; rollout tests override this.
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True



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
    mocker.patch('dj.apps.dyte.client.DyteClient', return_value=client)
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


def _run_evictions(host):
    from dj.apps.dyte.tasks import retire_host_evictions

    for cm in CreatorMeeting.objects.filter(creator=host).exclude(host_evictions=[]):
        retire_host_evictions(creator_id=host.pk, meeting_id=cm.pk)


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


def test_rotating_room_resets_provider_session_and_keeps_host_seat(
    api_client, provider, host,
):
    old_session = uuid.uuid4()
    CreatorMeeting.objects.create(
        creator=host, meeting_id='yesterday', meeting_type=BROADCAST,
        live_now=False, created_at=timezone.now() - timedelta(days=3),
        provider_session_id=old_session,
        provider_session_started_at=timezone.now() - timedelta(hours=1),
    )

    tab = uuid.uuid4()
    started = _start(api_client, host, session=tab)

    assert started.status_code == 200, started.data
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.meeting_id == started.data['meeting_id'] != 'yesterday'
    assert cm.provider_session_id is None
    assert cm.provider_session_started_at is None
    assert cm.host_session_id == tab


def test_missing_room_replacement_resets_provider_session_and_keeps_host_seat(
    api_client, provider, host,
):
    tab = uuid.uuid4()
    CreatorMeeting.objects.create(
        creator=host, meeting_id='gone', meeting_type=BROADCAST, live_now=True,
        host_session_id=tab, host_session_seen_at=timezone.now(),
        provider_session_id=uuid.uuid4(),
        provider_session_started_at=timezone.now() - timedelta(hours=1),
    )
    gone = _FakeResponse({'success': False, 'error': {'code': 404}})
    gone.status_code = 404
    provider.add_participant.side_effect = [
        gone, _FakeResponse({'data': {'token': 'auth-token', 'id': 'p-new'}}),
    ]

    started = _start(api_client, host, session=tab)

    assert started.status_code == 200, started.data
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.meeting_id == started.data['meeting_id'] != 'gone'
    assert cm.provider_session_id is None
    assert cm.provider_session_started_at is None
    assert cm.host_session_id == tab


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
    pending = CreatorMeeting.objects.get(creator=host).host_evictions
    assert [entry['participant_id'] for entry in pending] == ['participant-a']
    _run_evictions(host)

    provider.retire_participant.assert_called_once_with(room, 'participant-a')
    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_participant_id == 'participant-b'


def test_a_failed_kick_never_blocks_the_takeover(api_client, provider, host, mocker):
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
    _run_evictions(host)

    # Heartbeats preserve the retry deadline instead of defeating backoff.
    _seat(api_client, host, tab_b, 'heartbeat')
    _run_evictions(host)
    cm.refresh_from_db()
    assert cm.host_evictions[0]['attempts'] == 1
    mocker.patch('dj.apps.dyte.views.timezone.now', return_value=timezone.datetime.fromtimestamp(
        cm.host_evictions[0]['retry_after'] + 1, tz=timezone.get_current_timezone()))
    _run_evictions(host)
    cm.refresh_from_db()
    assert cm.host_evictions[0]['attempts'] == 2
    mocker.patch('dj.apps.dyte.views.timezone.now', return_value=timezone.datetime.fromtimestamp(
        cm.host_evictions[0]['retry_after'] + 1, tz=timezone.get_current_timezone()))
    provider.retire_participant.return_value = True
    _seat(api_client, host, tab_b, 'heartbeat')
    _run_evictions(host)
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
    post = mocker.patch('dj.apps.dyte.client._SESSION.post')
    post.return_value.status_code = status_code

    assert DyteClient('org').kick_participants('room', ['p1']) is confirmed
    assert post.call_args.args[0] == (
        'https://rtk.test/v2/meetings/room/active-session/kick')
    assert post.call_args.kwargs['json'] == {'participant_ids': ['p1']}


def test_kick_participants_swallows_a_network_error(mocker):
    import requests as requests_lib
    from dj.apps.dyte.client import DyteClient

    mocker.patch('dj.apps.dyte.client._SESSION.post',
                 side_effect=requests_lib.ConnectionError('down'))
    assert DyteClient('org').kick_participants('room', ['p1']) is False


def test_retire_participant_kicks_then_deletes(mocker, settings):
    from dj.apps.dyte.client import DyteClient

    settings.RTK_API_BASE_URL = 'https://rtk.test'
    calls = []
    delete = mocker.patch('dj.apps.dyte.client._SESSION.delete')
    delete.return_value.status_code = 200
    delete.side_effect = lambda *a, **k: calls.append('delete') or delete.return_value
    post = mocker.patch('dj.apps.dyte.client._SESSION.post')
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
    _run_evictions(host)

    provider.retire_participant.assert_called_once_with(room, 'first')
    assert CreatorMeeting.objects.get(creator=host).host_participant_id == 'second'


def test_release_retires_the_host_and_remembers_a_failure(
    api_client, provider, host, mocker,
):
    tab = uuid.uuid4()
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 't', 'id': 'released-host'}})
    room = _start(api_client, host, session=tab).data['meeting_id']
    provider.retire_participant.return_value = False

    _seat(api_client, host, tab, 'release')
    provider.retire_participant.assert_not_called()
    _run_evictions(host)
    provider.retire_participant.assert_called_once_with(room, 'released-host')
    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_session_id is None
    assert [e['participant_id'] for e in cm.host_evictions] == ['released-host']

    # The next seat, from any tab, inherits and retries it.
    provider.retire_participant.return_value = True
    provider.add_participant.return_value = _FakeResponse(
        {'data': {'token': 't', 'id': 'next-host'}})
    _start(api_client, host, session=uuid.uuid4())
    _run_evictions(host)
    cm.refresh_from_db()
    assert provider.retire_participant.call_count == 1
    mocker.patch('dj.apps.dyte.views.timezone.now', return_value=timezone.datetime.fromtimestamp(
        cm.host_evictions[0]['retry_after'] + 1, tz=timezone.get_current_timezone()))
    _run_evictions(host)
    cm.refresh_from_db()
    assert cm.host_evictions == []


def test_release_during_provider_start_invalidates_the_claim_and_keeps_cleanup(
    api_client, provider, host,
):
    tab = uuid.uuid4()

    def release_while_provider_is_minting(*args, **kwargs):
        released = _seat(api_client, host, tab, 'release')
        assert released.status_code == 200
        _run_evictions(host)
        provider.retire_participant.assert_not_called()
        participant = kwargs['custom_participant_id']
        return _FakeResponse({'data': {'token': 'late-token', 'id': participant}})

    provider.add_participant.side_effect = release_while_provider_is_minting
    provider.retire_participant.return_value = False

    response = _start(api_client, host, session=tab)

    assert response.status_code == 409
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.host_session_id is None
    assert cm.host_start_claim is None
    assert len(cm.host_evictions) == 1
    assert cm.host_evictions[0]['participant_id'].startswith('host_')
    assert cm.host_evictions[0]['state'] == 'pending'


def test_a_stale_room_rotation_cannot_replace_a_newer_released_generation(
    api_client, provider, host,
):
    original = _start(api_client, host, session=uuid.uuid4()).data['meeting_id']
    CreatorMeeting.objects.filter(creator=host).update(
        live_now=False, created_at=timezone.now() - timedelta(days=3),
        host_session_seen_at=timezone.now() - HOST_SESSION_TTL - timedelta(seconds=1))
    tab = uuid.uuid4()

    def release_before_rotation_returns(title):
        released = _seat(api_client, host, tab, 'release')
        assert released.status_code == 200
        return _FakeResponse({'data': {'id': 'late-room'}})

    provider.create_meeting.side_effect = release_before_rotation_returns

    response = _start(api_client, host, session=tab)

    assert response.status_code == 409
    cm = CreatorMeeting.objects.get(creator=host, meeting_type=BROADCAST)
    assert cm.meeting_id == original
    assert cm.host_session_id is None
    orphan = ProviderRoomCleanup.objects.get(provider_meeting_id='late-room')
    assert orphan.status == 'manual_review'
    assert orphan.provider_title == host.username
    assert orphan.start_id is not None
    assert 'deletion is unsupported' in orphan.last_error
    provider.add_participant.assert_called_once()


def test_late_participant_response_after_claim_expiry_cannot_restore_the_seat(
    api_client, provider, host,
):
    tab = uuid.uuid4()

    def expire_claim_during_mint(*args, **kwargs):
        cm = CreatorMeeting.objects.get(creator=host)
        CreatorMeeting.objects.filter(pk=cm.pk).update(
            host_start_claim_at=timezone.now() - HOST_START_CLAIM_TTL
            - timedelta(seconds=1),
        )
        return _FakeResponse({'data': {
            'token': 'late-token', 'id': '5f342f6e-c78b-4b2a-9ed0-58edb562c1df',
        }})

    provider.add_participant.side_effect = expire_claim_during_mint
    provider.retire_participant.return_value = False
    response = _start(api_client, host, session=tab)

    assert response.status_code == 409
    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_start_claim is None
    assert cm.host_session_id is None
    assert cm.live_now is False
    assert cm.host_evictions[0]['state'] == 'pending'
    provider.retire_participant.assert_called_once_with(
        cm.meeting_id, '5f342f6e-c78b-4b2a-9ed0-58edb562c1df',
    )


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


def test_worker_reclaims_abandoned_start_claim_and_retries_minted_host(
    provider, host,
):
    from dj.apps.dyte.tasks import retire_host_evictions

    claim = uuid.uuid4()
    custom_id = f'host_{claim.hex}'
    cm = CreatorMeeting.objects.create(
        creator=host, meeting_id='abandoned-room', meeting_type=BROADCAST,
        host_start_claim=claim,
        host_start_claim_at=timezone.now() - HOST_START_CLAIM_TTL
        - timedelta(seconds=1),
        host_session_id=uuid.uuid4(), host_session_seen_at=timezone.now(),
        host_evictions=[{
            'meeting_id': 'abandoned-room', 'participant_id': custom_id,
            'attempts': 0, 'state': 'start_pending',
            'claim_id': str(claim), 'retry_after': 0,
        }, {
            'meeting_id': 'abandoned-room', 'participant_id': 'manual-host',
            'attempts': 40, 'state': 'manual_review',
        }],
    )
    provider.retire_participant.return_value = False

    retire_host_evictions(creator_id=host.pk, meeting_id=cm.pk)

    cm.refresh_from_db()
    assert cm.host_start_claim is None
    assert cm.host_start_claim_at is None
    assert cm.host_session_id is None
    provider.retire_participant.assert_called_once_with(
        'abandoned-room', custom_id,
    )
    assert any(entry['participant_id'] == custom_id and entry['attempts'] == 1
               for entry in cm.host_evictions)
    assert any(entry['participant_id'] == 'manual-host' and entry['state'] == 'manual_review'
               for entry in cm.host_evictions)


def test_live_claim_worker_persists_expiry_recheck_after_request_dies(
    provider, host,
):
    """A worker that sees an in-flight claim must leave a durable wakeup."""
    from dj.apps.dyte.tasks import retire_host_evictions

    claim = uuid.uuid4()
    expires_at = timezone.now() + HOST_START_CLAIM_TTL
    participant_id = f'host_{claim.hex}'
    cm = CreatorMeeting.objects.create(
        creator=host, meeting_id='claim-expiry-room', meeting_type=BROADCAST,
        host_start_claim=claim, host_start_claim_at=timezone.now(),
        host_session_id=uuid.uuid4(), host_session_seen_at=timezone.now(),
        host_evictions=[{
            'meeting_id': 'claim-expiry-room', 'participant_id': participant_id,
            'attempts': 0, 'state': 'start_pending', 'claim_id': str(claim),
            'retry_after': expires_at.timestamp(),
        }],
    )

    retire_host_evictions(creator_id=host.pk, meeting_id=cm.pk)

    job = ProcrastinateJob.objects.get(
        task_name='dyte.retire_host_evictions',
        args={'creator_id': host.pk, 'meeting_id': cm.pk},
    )
    assert job.status == 'todo'
    assert abs(job.scheduled_at - expires_at) < timedelta(seconds=1)
    provider.retire_participant.assert_not_called()

    # The request process is gone: only its persisted claim and the scheduled
    # worker remain. At expiry, a worker reclaims and retires the participant.
    CreatorMeeting.objects.filter(pk=cm.pk).update(
        host_start_claim_at=timezone.now() - HOST_START_CLAIM_TTL - timedelta(seconds=1),
        host_evictions=[{**cm.host_evictions[0], 'retry_after': 0}],
    )
    provider.retire_participant.return_value = True
    retire_host_evictions(creator_id=host.pk, meeting_id=cm.pk)

    cm.refresh_from_db()
    assert cm.host_start_claim is None
    assert cm.host_evictions == []
    provider.retire_participant.assert_called_once_with(
        'claim-expiry-room', participant_id,
    )


def test_initial_room_rotation_cas_mismatch_returns_conflict(
    api_client, provider, host,
):
    """A losing room CAS must not use an uninitialized meeting_id."""
    def create_then_race(title):
        CreatorMeeting.objects.filter(
            creator=host, meeting_type=BROADCAST, is_public=True,
        ).update(meeting_id='concurrent-room')
        return _FakeResponse({'data': {'id': 'unadopted-room'}})

    provider.create_meeting.side_effect = create_then_race

    response = _start(api_client, host, session=uuid.uuid4())

    assert response.status_code == 409
    assert response.data['code'] == 'host_session_superseded'
    assert response.data.get('meeting_id') != 'unadopted-room'
    provider.add_participant.assert_not_called()
    assert ProviderRoomCleanup.objects.filter(
        provider_meeting_id='unadopted-room', status='manual_review',
    ).exists()


def test_worker_expires_a_killed_room_create_to_operator_reconciliation(
    provider, host,
):
    from dj.apps.dyte.tasks import retire_host_evictions

    claim = uuid.uuid4()
    cm = CreatorMeeting.objects.create(
        creator=host, meeting_id='', meeting_type=BROADCAST,
        host_start_claim=claim,
        host_start_claim_at=timezone.now() - HOST_START_CLAIM_TTL
        - timedelta(seconds=1),
        host_session_id=uuid.uuid4(), host_session_seen_at=timezone.now(),
        host_evictions=[{
            'meeting_id': '', 'participant_id': f'host_{claim.hex}',
            'attempts': 0, 'state': 'start_pending',
            'claim_id': str(claim), 'retry_after': 0,
        }],
    )
    intent = ProviderRoomCleanup.objects.create(
        provider_meeting_id=None, creator=host, creator_meeting=cm,
        meeting_type=BROADCAST, provider_title=host.username,
        start_id=claim, status='manual_review',
        last_error='Room create outcome is unknown; inspect provider title',
    )

    retire_host_evictions(creator_id=host.pk, meeting_id=cm.pk)

    cm.refresh_from_db()
    intent.refresh_from_db()
    assert cm.host_start_claim is None
    assert cm.host_session_id is None
    assert cm.host_evictions == []
    assert intent.status == 'manual_review'
    assert intent.provider_meeting_id is None
    provider.retire_participant.assert_not_called()


def test_heartbeat_commits_before_queued_retirement_runs(
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
    provider.retire_participant.assert_not_called()

    cm = CreatorMeeting.objects.get(creator=host)
    assert cm.host_session_seen_at == start
    _run_evictions(host)


@pytest.mark.parametrize("takeover", [False, True])
def test_registration_only_keeps_first_host_and_refuses_another_mint(
    settings, provider, host, takeover,
):
    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = False
    client = APIClient()
    first = _start(client, host)
    assert first.status_code == 200
    session = first.data['host_session']
    assert _seat(client, host, session, 'heartbeat').status_code == 200
    before = list(CreatorMeeting.objects.filter(creator=host).values())
    second = _start(client, host, session=None if takeover else session,
                    takeover=takeover)
    assert second.status_code == 503
    assert second.data['code'] == 'host_retirement_temporarily_unavailable'
    assert second['Retry-After'] == '60'
    assert provider.add_participant.call_count == 1
    assert list(CreatorMeeting.objects.filter(creator=host).values()) == before
    assert not ProcrastinateJob.objects.filter(task_name='dyte.retire_host_evictions').exists()


def test_registration_only_preserves_obligations_and_stops_task_retries(
    settings, provider, host,
):
    from .tasks import retire_host_evictions, sweep_live_meetings
    from .views import _defer_host_evictions

    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = False
    pending = [{'meeting_id': 'old-room', 'participant_id': 'old-host', 'attempts': 0}]
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='old-room',
                                      host_evictions=pending, live_now=False)
    _defer_host_evictions(cm)
    retire_host_evictions(host.pk, cm.pk)
    sweep_live_meetings(0)
    cm.refresh_from_db()
    assert cm.host_evictions == pending
    assert not ProcrastinateJob.objects.filter(task_name='dyte.retire_host_evictions').exists()
    provider.retire_participant.assert_not_called()

    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    sweep_live_meetings(60)
    sweep_live_meetings(120)
    jobs = ProcrastinateJob.objects.filter(task_name='dyte.retire_host_evictions')
    assert jobs.count() == 1  # Queueing lock coalesces repeated recovery sweeps.
    assert jobs.get().args == {'creator_id': host.pk, 'meeting_id': cm.pk}
    provider.retire_participant.return_value = True
    retire_host_evictions(host.pk, cm.pk)
    cm.refresh_from_db()
    assert cm.host_evictions == []
    provider.retire_participant.assert_called_once_with('old-room', 'old-host')


def test_eviction_catchup_rotates_past_manual_rows_and_bounds_each_tick(
    settings, mocker, creator_factory,
):
    from django.core.cache import cache
    from .tasks import _cursor_key, sweep_live_meetings

    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    cache.delete(_cursor_key() + ':host_evictions')
    mocker.patch('dj.apps.dyte.tasks.HOST_EVICTION_CATCHUP_BATCH', 2)
    enqueue = mocker.patch('dj.apps.dyte.views._defer_host_evictions')
    rows = [CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=f'catchup-{i}', live_now=False,
        host_evictions=[{'state': 'manual_review' if i < 2 else 'pending'}],
    ) for i in range(5)]
    reached = set()
    for tick in [0, 300, 600, 900]:
        enqueue.reset_mock()
        sweep_live_meetings(tick)
        assert enqueue.call_count <= 1
        reached.update(call.args[0].pk for call in enqueue.call_args_list)
    assert reached == {row.pk for row in rows[2:]}


def test_actionable_retirement_is_runnable_before_queued_claim_expiry(
    api_client, provider, host,
):
    first = _start(api_client, host)
    assert first.status_code == 200
    delayed = ProcrastinateJob.objects.get(task_name='dyte.retire_host_evictions')
    assert delayed.scheduled_at > timezone.now() + timedelta(seconds=240)
    assert ':claim:' in delayed.queueing_lock
    assert _start(api_client, host, takeover=True).status_code == 200
    cm = CreatorMeeting.objects.get(creator=host)
    jobs = ProcrastinateJob.objects.filter(task_name='dyte.retire_host_evictions')
    immediate = jobs.exclude(pk=delayed.pk).get()
    assert immediate.queueing_lock == f'dyte-host-evictions-{cm.pk}:fresh'
    assert immediate.scheduled_at is None or immediate.scheduled_at <= timezone.now()
    delayed.refresh_from_db()
    assert delayed.scheduled_at > timezone.now() + timedelta(seconds=240)


def test_fresh_revocation_does_not_wait_for_an_older_retry(host):
    from .tasks import retire_host_evictions
    from .views import _defer_host_evictions

    entries = [{'meeting_id': 'room', 'participant_id': 'old',
                'state': 'pending', 'attempts': 10}]
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='room',
                                      host_evictions=entries)
    retry_at = timezone.now() + timedelta(seconds=900)
    retire_host_evictions.configure(
        queueing_lock=f'dyte-host-evictions-{cm.pk}', schedule_at=retry_at,
    ).defer(creator_id=host.pk, meeting_id=cm.pk)
    cm.host_evictions.append({'meeting_id': 'room', 'participant_id': 'fresh',
                              'state': 'pending', 'attempts': 0})
    cm.save(update_fields=['host_evictions'])
    _defer_host_evictions(cm)
    _defer_host_evictions(cm)
    jobs = ProcrastinateJob.objects.filter(task_name='dyte.retire_host_evictions')
    assert jobs.count() == 2
    assert jobs.get(queueing_lock=f'dyte-host-evictions-{cm.pk}').scheduled_at == retry_at
    fresh = jobs.get(queueing_lock=f'dyte-host-evictions-{cm.pk}:fresh')
    assert fresh.scheduled_at is None or fresh.scheduled_at <= timezone.now()


def test_retirement_bounds_provider_work_without_losing_unprocessed_entries(
    provider, host,
):
    from .tasks import retire_host_evictions

    entries = [{'meeting_id': 'room', 'participant_id': str(i),
                'state': 'pending', 'attempts': i} for i in range(4)]
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='room',
                                      host_evictions=entries)
    provider.retire_participant.return_value = True
    retire_host_evictions(host.pk, cm.pk)
    cm.refresh_from_db()
    assert cm.host_evictions == entries[1:]
    provider.retire_participant.assert_called_once_with('room', '0')
    assert ProcrastinateJob.objects.filter(
        task_name='dyte.retire_host_evictions', args__meeting_id=cm.pk,
    ).exists()


@pytest.mark.parametrize('old_state,old_attempts', [('pending', 39), ('manual_review', 40)])
def test_retirement_prioritizes_fresh_entries_and_preserves_old_failure_budget(
    provider, host, old_state, old_attempts,
):
    from .tasks import retire_host_evictions

    old = {'meeting_id': 'room', 'participant_id': 'old',
           'state': old_state, 'attempts': old_attempts,
           'retry_after': (timezone.now() + timedelta(seconds=900)).timestamp()}
    fresh = [{'meeting_id': 'room', 'participant_id': str(i),
              'state': 'pending', 'attempts': 0} for i in range(2)]
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='room',
                                      host_evictions=[old, *fresh])
    provider.retire_participant.return_value = True
    before = timezone.now()
    retire_host_evictions(host.pk, cm.pk)
    cm.refresh_from_db()
    assert cm.host_evictions == [old, fresh[1]]
    provider.retire_participant.assert_called_once_with('room', '0')
    job = ProcrastinateJob.objects.get(task_name='dyte.retire_host_evictions',
                                      queueing_lock=f'dyte-host-evictions-{cm.pk}:fresh')
    assert before <= job.scheduled_at <= timezone.now()


def test_disabled_eviction_catchup_never_reads_obligation_table(settings, mocker):
    from .tasks import _enqueue_deferred_host_evictions

    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = False
    query = mocker.patch('dj.apps.dyte.models.CreatorMeeting.objects.exclude')
    _enqueue_deferred_host_evictions()
    query.assert_not_called()


def test_due_retries_drain_without_another_backoff(provider, host):
    from .tasks import retire_host_evictions

    past = (timezone.now() - timedelta(seconds=1)).timestamp()
    entries = [{'meeting_id': 'room', 'participant_id': str(i), 'state': 'pending',
                'attempts': 6, 'retry_after': past} for i in range(3)]
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='room', host_evictions=entries)
    provider.retire_participant.return_value = True
    for index in range(3):
        retire_host_evictions(host.pk, cm.pk)
        cm.refresh_from_db()
        assert cm.host_evictions == entries[index + 1:]
        assert provider.retire_participant.call_count == index + 1
        assert not ProcrastinateJob.objects.filter(
            task_name='dyte.retire_host_evictions', scheduled_at__gt=timezone.now(),
        ).exists()


def test_fresh_failure_keeps_its_deadline_beside_older_retry(provider, host, mocker):
    from .tasks import retire_host_evictions
    from .views import _defer_host_evictions

    now = timezone.now()
    clock = mocker.patch('dj.apps.dyte.views.timezone.now', return_value=now)
    old = {'meeting_id': 'room', 'participant_id': 'old', 'state': 'pending',
           'attempts': 10, 'retry_after': (now + timedelta(seconds=900)).timestamp()}
    fresh = {'meeting_id': 'room', 'participant_id': 'fresh', 'state': 'pending', 'attempts': 0}
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='room', host_evictions=[old, fresh])
    _defer_host_evictions(cm, entries=[old])
    provider.retire_participant.return_value = False
    retire_host_evictions(host.pk, cm.pk)
    cm.refresh_from_db()
    assert cm.host_evictions[0] == old
    assert cm.host_evictions[1]['attempts'] == 1
    assert cm.host_evictions[1]['retry_after'] == (now + timedelta(seconds=30)).timestamp()
    _defer_host_evictions(cm)
    jobs = ProcrastinateJob.objects.filter(task_name='dyte.retire_host_evictions')
    assert set(jobs.values_list('scheduled_at', flat=True)) == {
        now + timedelta(seconds=30), now + timedelta(seconds=900)}
    assert jobs.count() == 2
    retire_host_evictions(host.pk, cm.pk)
    assert provider.retire_participant.call_count == 1
    clock.return_value = now + timedelta(seconds=31)
    provider.retire_participant.return_value = True
    retire_host_evictions(host.pk, cm.pk)
    cm.refresh_from_db()
    assert cm.host_evictions == [old]


@pytest.mark.parametrize('deadline', [None, 'tomorrow', True, -1, float('inf'), float('nan'), 10 ** 1000, 10 ** 12])
def test_malformed_retry_deadline_is_due(deadline):
    from .views import _host_eviction_retry_deadline

    assert _host_eviction_retry_deadline({'retry_after': deadline}, timezone.now().timestamp()) == 0


def test_provider_completion_preserves_concurrently_added_obligation(provider, host):
    from .tasks import retire_host_evictions

    old = {'meeting_id': 'room', 'participant_id': 'old', 'state': 'pending', 'attempts': 0}
    fresh = {'meeting_id': 'room', 'participant_id': 'fresh', 'state': 'pending', 'attempts': 0}
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='room', host_evictions=[old])
    def new_obligation_during_provider_call(*args):
        CreatorMeeting.objects.filter(pk=cm.pk).update(host_evictions=[old, fresh])
        return False
    provider.retire_participant.side_effect = new_obligation_during_provider_call
    retire_host_evictions(host.pk, cm.pk)
    cm.refresh_from_db()
    assert cm.host_evictions[0] == fresh
    assert cm.host_evictions[1]['participant_id'] == 'old'
    assert cm.host_evictions[1]['attempts'] == 1
    job = ProcrastinateJob.objects.get(task_name='dyte.retire_host_evictions')
    assert job.scheduled_at <= timezone.now()



def test_eviction_catchup_cache_failure_preserves_obligation(settings, mocker, host, caplog, provider):
    from .tasks import sweep_live_meetings

    settings.DYTE_HOST_EVICTION_JOBS_ENABLED = True
    pending = [{'meeting_id': 'room', 'participant_id': 'host'}]
    old_seen = timezone.now() - timedelta(minutes=5)
    cm = CreatorMeeting.objects.create(creator=host, meeting_id='room',
        host_evictions=pending, live_now=True, last_seen_at=old_seen)
    provider.get_participants_count.return_value = 1
    mocker.patch('dj.apps.dyte.tasks.cache.get', side_effect=ConnectionError('fixture unavailable'))
    sweep_live_meetings(0)
    cm.refresh_from_db()
    assert cm.host_evictions == pending
    assert cm.last_seen_at > old_seen
    provider.get_participants_count.assert_called_once_with('room')
    assert not ProcrastinateJob.objects.filter(task_name='dyte.retire_host_evictions').exists()
    assert 'host eviction catch-up: could not read cursor' in caplog.text
