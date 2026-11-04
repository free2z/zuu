"""A URL must never dictate what goes in the database — issue, finding 3.

`/api/dyte/<username>/<type>` used to route through `<str:type>`, which matches
any non-slash string, and dropped that string straight into
`CreatorMeeting.meeting_type` via `get_or_create`. `choices` is only enforced
by `full_clean()` — never called here — so:

  * any string was persisted, outside the enum;
  * `unique_together` is per type, so every novel string minted a NEW row and
    each new row made a paid provider `create_meeting` call;
  * >20 characters hit the raw Postgres `varchar(20)` bound and 500'd.

These tests pin the contract: valid types still work end to end, and anything
else is a clean 404 with zero rows written and zero provider calls made.
"""
from decimal import Decimal

import pytest
from django.urls import Resolver404, resolve
from django.utils import timezone

from dj.apps.dyte.models import (
    BROADCAST,
    PAY_PER_VIEW,
    PRIVATE,
    PUBLIC_MEETING_TYPES,
    SUBSCRIBERS_ONLY,
    CreatorMeeting,
)

pytestmark = pytest.mark.django_db


def _url(username, meeting_type):
    return f'/api/dyte/{username}/{meeting_type}'


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    @property
    def text(self):
        return str(self._payload)


@pytest.fixture
def dyte_client(mocker):
    """Stub the whole provider boundary and count every call to it.

    `create_meeting` is billed per meeting, so "no provider call" is a real
    assertion about money, not just about tidiness.
    """
    client = mocker.MagicMock()
    client.create_meeting.return_value = _FakeResponse(
        {'data': {'id': 'meeting-from-provider'}})
    client.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token'}})
    client.get_participants_count.return_value = 3
    mocker.patch('dj.apps.dyte.views.DyteClient', return_value=client)
    return client


@pytest.fixture
def streamer(creator_factory):
    # can_stream is tuzis >= 150.
    return creator_factory(tuzis=Decimal('1000'))


# --- the enum still works end to end -----------------------------------------

@pytest.mark.parametrize('meeting_type', list(PUBLIC_MEETING_TYPES))
def test_owner_can_start_each_public_meeting_type(
    api_client, dyte_client, streamer, meeting_type,
):
    api_client.force_authenticate(user=streamer)
    body = {'price_per_minute': '1.00'} if meeting_type == PAY_PER_VIEW else {}

    response = api_client.post(_url(streamer.username, meeting_type), body)

    assert response.status_code == 200, response.data
    assert response.data['meeting_id'] == 'meeting-from-provider'
    assert response.data['auth_token'] == 'auth-token'

    cm = CreatorMeeting.objects.get(creator=streamer, is_public=True)
    assert cm.meeting_type == meeting_type
    assert cm.live_now is True
    assert dyte_client.create_meeting.call_count == 1


def test_uppercase_type_is_still_accepted_and_normalized(
    api_client, dyte_client, streamer,
):
    """The views always did `.lower()`; the route stayed case-insensitive."""
    api_client.force_authenticate(user=streamer)

    response = api_client.post(_url(streamer.username, 'BroadCast'), {})

    assert response.status_code == 200, response.data
    assert CreatorMeeting.objects.get(creator=streamer).meeting_type == BROADCAST


# --- anything outside the enum is not a resource ------------------------------

INVALID_TYPES = [
    'bogus',
    'ppv2',
    'broadcasting',
    'BROADCASTX',
    'subscribers_only',
    'pay-per-view',       # the never-implemented spelling from views.py
    '../../etc/passwd'.replace('/', ''),
    'x' * 21,             # longer than varchar(20): used to be a raw 500
    'x' * 500,
]


@pytest.mark.parametrize('meeting_type', INVALID_TYPES)
def test_post_with_invalid_type_writes_nothing_and_calls_no_provider(
    api_client, dyte_client, streamer, meeting_type,
):
    api_client.force_authenticate(user=streamer)

    response = api_client.post(_url(streamer.username, meeting_type), {})

    assert response.status_code == 404, response.status_code
    assert CreatorMeeting.objects.count() == 0
    dyte_client.create_meeting.assert_not_called()
    dyte_client.add_participant.assert_not_called()


@pytest.mark.parametrize('meeting_type', INVALID_TYPES)
def test_get_with_invalid_type_is_a_clean_404(
    api_client, dyte_client, streamer, meeting_type,
):
    response = api_client.get(_url(streamer.username, meeting_type))

    assert response.status_code == 404, response.status_code
    dyte_client.get_participants_count.assert_not_called()


def test_over_length_type_does_not_reach_the_database(
    api_client, dyte_client, streamer, django_assert_num_queries,
):
    """The 500 was a raw `value too long for character varying(20)`.

    Asserting 404 is the contract; asserting the row count stays zero is the
    part that would have caught the original bug even if it had 400'd.
    """
    api_client.force_authenticate(user=streamer)

    response = api_client.post(_url(streamer.username, 'z' * 64), {})

    assert response.status_code == 404
    assert not CreatorMeeting.objects.exists()


def test_invalid_type_never_resolves_to_a_view():
    """Route-level guarantee: the request does not reach DyteMeeting at all."""
    for meeting_type in INVALID_TYPES:
        with pytest.raises(Resolver404):
            resolve(_url('someone', meeting_type))

    for meeting_type in PUBLIC_MEETING_TYPES:
        assert resolve(_url('someone', meeting_type)).url_name == 'dyte_meeting'


def test_private_still_routes_to_the_private_manage_view():
    """`private` is is_public=False and owns its own route, ahead of <type>.

    It is deliberately not a public meeting type; this pins that the
    narrowed converter did not steal or break that route.
    """
    assert PRIVATE not in PUBLIC_MEETING_TYPES
    assert resolve(_url('someone', PRIVATE)).url_name == 'private_meeting'


# --- legacy off-enum rows must not leak out of the public reads --------------

def test_public_reads_skip_legacy_off_enum_rows(
    api_client, dyte_client, streamer, creator_factory,
):
    """Rows the old route already wrote are still in the database.

    Both public reads key or type their payload on the enum, so a single
    surviving `bogus` row would poison a strict client's parse of the whole
    response and hide that creator's real streams. Filtering them out avoids
    needing a data migration to clean up.
    """
    now = timezone.now()
    CreatorMeeting.objects.create(
        creator=streamer,
        meeting_id='legacy-junk-room',
        meeting_type='bogus',
        is_public=True,
        live_now=True,
        last_seen_at=now,
    )
    CreatorMeeting.objects.create(
        creator=streamer,
        meeting_id='real-room',
        meeting_type=BROADCAST,
        is_public=True,
        live_now=True,
        last_seen_at=now,
    )

    status_response = api_client.get(f'/api/dyte/{streamer.username}/live-status')
    assert status_response.status_code == 200
    assert set(status_response.data) == {BROADCAST}

    list_response = api_client.get('/api/dyte/public/')
    assert list_response.status_code == 200
    results = list_response.data
    if isinstance(results, dict):
        results = results['results']
    assert [row['meeting_type'] for row in results] == [BROADCAST]


# --- the participant path uses the real constants ----------------------------

def test_subscribers_only_requires_a_subscription(
    api_client, dyte_client, streamer, creator_factory,
):
    cm = CreatorMeeting.objects.create(
        creator=streamer,
        meeting_id='live-subs-room',
        meeting_type=SUBSCRIBERS_ONLY,
        is_public=True,
        live_now=True,
    )
    fan = creator_factory(tuzis=Decimal('1000'))
    api_client.force_authenticate(user=fan)

    response = api_client.post(_url(streamer.username, cm.meeting_type), {})

    assert response.status_code == 402
    assert response.data == {
        "code": "subscription_required",
        "error": "You must be subscribed to join this meeting",
        "action": "stream_join",
    }
    dyte_client.add_participant.assert_not_called()


def test_ppv_participant_is_gated_on_balance(
    api_client, dyte_client, streamer, creator_factory,
):
    """Exercises the `meeting_type == PAY_PER_VIEW` branch (was `"ppv"`)."""
    cm = CreatorMeeting.objects.create(
        creator=streamer,
        meeting_id='live-ppv-room',
        meeting_type=PAY_PER_VIEW,
        is_public=True,
        live_now=True,
        price_per_minute=Decimal('100'),
    )
    broke_fan = creator_factory(tuzis=Decimal('1'))
    api_client.force_authenticate(user=broke_fan)

    response = api_client.post(_url(streamer.username, cm.meeting_type), {})

    assert response.status_code == 402
    assert response.data == {
        'code': 'insufficient_funds',
        'cost': '3015.000',
        'balance': '1.000',
        'shortfall': '3014.000',
        'action': 'stream_join',
    }
    dyte_client.add_participant.assert_not_called()
