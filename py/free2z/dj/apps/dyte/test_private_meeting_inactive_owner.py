"""A deactivated room owner's private meeting must not be joinable --.

`/api/dyte/<username>/private/<secret>` joins a private room on the strength
of the secret alone (that is the point of the route; see
`test_private_meeting_access.py`). But the room lookup never checked the
OWNER's account state, so a room whose owner has been deactivated kept
minting provider auth tokens forever: every invitee (and the deactivated
owner themself) still reached `DyteClient.add_participant` -- a paid,
out-of-process call to Dyte on behalf of an account the platform no longer
serves.

The fix is `creator__is_active=True` in the room lookup, so the refusal
happens BEFORE any provider call and reads as a 404 -- the same answer every
other deactivated-creator surface gives (: 404, never 403/410).

Tests are shaped like 's (`test_private_meeting_access.py`): the whole
provider boundary is stubbed and counted, because "no provider call" is an
assertion about money as much as about privacy. Every refusal test FAILS
against unfixed main (the join succeeds and calls the provider).
"""
import itertools
from decimal import Decimal

import pytest

from dj.apps.dyte.models import PRIVATE, CreatorMeeting

pytestmark = pytest.mark.django_db

JOIN_URL = '/api/dyte/{username}/private/{secret}'


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
    client = mocker.MagicMock()
    counter = itertools.count(1)
    client.create_meeting.side_effect = lambda *a, **kw: _FakeResponse(
        {'data': {'id': f'provider-meeting-{next(counter)}'}})
    client.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token'}})
    mocker.patch('dj.apps.dyte.views.DyteClient', return_value=client)
    return client


@pytest.fixture
def owner(creator_factory):
    return creator_factory(tuzis=Decimal('1000'))


@pytest.fixture
def invitee(creator_factory):
    return creator_factory(tuzis=Decimal('1000'))


def _create_private_meeting(api_client, owner, e2ee=True):
    """Drive the real create flow the dashboard uses, while the owner is
    still active, and return the row."""
    api_client.force_authenticate(user=owner)
    response = api_client.post(
        f'/api/dyte/{owner.username}/private', {'e2ee': e2ee})
    assert response.status_code == 200, response.data
    api_client.force_authenticate(user=None)
    return CreatorMeeting.objects.get(creator=owner, meeting_type=PRIVATE)


def _deactivate(creator):
    creator.is_active = False
    creator.save(update_fields=['is_active'])


def test_invitee_cannot_join_a_deactivated_owners_room(
    api_client, dyte_client, owner, invitee,
):
    cm = _create_private_meeting(api_client, owner)

    # Control: with the owner active, the secret-holder joins normally.
    api_client.force_authenticate(user=invitee)
    ok = api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})
    assert ok.status_code == 200, ok.data
    assert ok.data['auth_token'] == 'auth-token'
    calls_before = dyte_client.add_participant.call_count

    _deactivate(owner)

    refused = api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})

    assert refused.status_code == 404, refused.data
    assert 'auth_token' not in refused.data
    # The refusal happened BEFORE the paid provider boundary.
    assert dyte_client.add_participant.call_count == calls_before


def test_deactivated_owner_cannot_rejoin_their_own_room(
    api_client, dyte_client, owner,
):
    """force_authenticate aside, a deactivated account must not be able to
    reach its own room either — the lookup gate covers every caller."""
    cm = _create_private_meeting(api_client, owner)
    _deactivate(owner)

    api_client.force_authenticate(user=owner)
    response = api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})

    assert response.status_code == 404, response.data
    dyte_client.add_participant.assert_not_called()


def test_refusal_leaves_the_room_row_untouched(
    api_client, dyte_client, owner, invitee,
):
    cm = _create_private_meeting(api_client, owner)
    secret_before, meeting_id_before, e2ee_before = (
        cm.secret, cm.meeting_id, cm.e2ee)
    _deactivate(owner)

    api_client.force_authenticate(user=invitee)
    api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})
    api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})

    cm.refresh_from_db()
    assert cm.secret == secret_before
    assert cm.meeting_id == meeting_id_before
    assert cm.e2ee == e2ee_before
    dyte_client.add_participant.assert_not_called()
    dyte_client.create_meeting.assert_called_once()  # only the original create


def test_active_owner_and_invitee_behavior_is_preserved(
    api_client, dyte_client, owner, invitee,
):
    """The flip side: none of this may close rooms whose owner is active."""
    cm = _create_private_meeting(api_client, owner, e2ee=False)

    api_client.force_authenticate(user=invitee)
    response = api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})

    assert response.status_code == 200, response.data
    assert response.data['e2ee'] is False
    added_user = dyte_client.add_participant.call_args[0][0]
    assert added_user == invitee

    api_client.force_authenticate(user=owner)
    host = api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})
    assert host.status_code == 200, host.data
    assert dyte_client.add_participant.call_count == 2


def test_wrong_secret_still_404s_without_a_provider_call(
    api_client, dyte_client, owner, invitee,
):
    """The deactivation gate must not change the wrong-secret answer."""
    _create_private_meeting(api_client, owner)

    api_client.force_authenticate(user=invitee)
    response = api_client.post(
        JOIN_URL.format(
            username=owner.username,
            secret='00000000-0000-4000-8000-000000000000',
        ),
        {},
    )

    assert response.status_code == 404
    dyte_client.add_participant.assert_not_called()
