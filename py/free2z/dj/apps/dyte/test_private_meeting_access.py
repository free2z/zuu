"""`/api/dyte/<username>/private` is the creator's own route — issue.

`PrivateMeetingManage` always acts on `creator=request.user`, so the username
in the path never selected the room. It only decided whether the `can_stream`
(150 2Z) gate ran: the guard was

    if request.user.username == stream_owner and not request.user.can_stream

so posting to *anyone else's* path — or to a case-variant of one's own —
skipped the balance requirement entirely and still ran the unconditional
`_create_meeting()`, i.e. a fresh paid provider meeting per request, with the
caller's own secret recycled each time.

`/live/{username}?type=private` in the SvelteKit app made that URL reachable
by accident from an ordinary page load.

What these tests pin, in the shape 's tests use (no row written, no
provider call made):

  * a non-owner is refused before any query, write or provider call, and the
    creator named in the path is left completely untouched;
  * the owner's own create/recycle flow is unchanged;
  * the 150 2Z gate now runs for the owner however they spell their username;
  * a genuine invitee holding the secret still joins through the separate
    `<uuid:secret>` route, which is deliberately NOT ownership-gated.
"""
import itertools
from decimal import Decimal

import pytest
from django.urls import resolve

from dj.apps.dyte.models import PRIVATE, CreatorMeeting

pytestmark = pytest.mark.django_db

MANAGE_URL = '/api/dyte/{username}/private'
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
    """Stub the whole provider boundary and count every call to it.

    `create_meeting` mints a room on the paid provider, so "no provider call"
    is an assertion about money, not tidiness. Ids are unique per call because
    `CreatorMeeting.meeting_id` is globally unique — a constant id would make
    the second call blow up on the constraint instead of on the assertion.
    """
    client = mocker.MagicMock()
    counter = itertools.count(1)
    client.create_meeting.side_effect = lambda *a, **kw: _FakeResponse(
        {'data': {'id': f'provider-meeting-{next(counter)}'}})
    client.add_participant.return_value = _FakeResponse(
        {'data': {'token': 'auth-token'}})
    mocker.patch('dj.apps.dyte.views.DyteClient', return_value=client)
    return client


@pytest.fixture
def streamer(creator_factory):
    # can_stream is tuzis >= 150.
    return creator_factory(tuzis=Decimal('1000'))


@pytest.fixture
def outsider(creator_factory):
    return creator_factory(tuzis=Decimal('1000'))


def _create_private_meeting(api_client, owner, e2ee=True):
    """Drive the real create flow the dashboard uses, and return the row."""
    api_client.force_authenticate(user=owner)
    response = api_client.post(
        MANAGE_URL.format(username=owner.username), {'e2ee': e2ee})
    assert response.status_code == 200, response.data
    api_client.force_authenticate(user=None)
    return CreatorMeeting.objects.get(creator=owner, meeting_type=PRIVATE)


# --- the hole: another creator's private route -------------------------------

def test_non_owner_post_is_refused_and_changes_nothing(
    api_client, dyte_client, streamer, outsider,
):
    cm = _create_private_meeting(api_client, streamer)
    secret_before, meeting_id_before, e2ee_before = (
        cm.secret, cm.meeting_id, cm.e2ee)
    provider_calls_before = dyte_client.create_meeting.call_count

    api_client.force_authenticate(user=outsider)
    response = api_client.post(
        MANAGE_URL.format(username=streamer.username), {})

    assert response.status_code == 403, response.data

    # The creator named in the path is untouched: same invite secret, same
    # provider room, same e2ee setting.
    cm.refresh_from_db()
    assert cm.secret == secret_before
    assert cm.meeting_id == meeting_id_before
    assert cm.e2ee == e2ee_before

    # And the caller minted nothing of their own, at no provider cost.
    assert not CreatorMeeting.objects.filter(creator=outsider).exists()
    assert dyte_client.create_meeting.call_count == provider_calls_before


def test_non_owner_get_is_refused(api_client, dyte_client, streamer, outsider):
    """GET ignored the path username too, and answered with the CALLER's own
    secret — a confusing, wrong answer rather than a leak. It is still not an
    answer this route should give."""
    _create_private_meeting(api_client, streamer)
    _create_private_meeting(api_client, outsider)

    api_client.force_authenticate(user=outsider)
    response = api_client.get(MANAGE_URL.format(username=streamer.username))

    assert response.status_code == 403, response.data


def test_repeated_non_owner_posts_never_reach_the_provider(
    api_client, dyte_client, streamer, outsider,
):
    """The abuse shape was a loop: every POST ran `_create_meeting`."""
    api_client.force_authenticate(user=outsider)

    for _ in range(5):
        response = api_client.post(
            MANAGE_URL.format(username=streamer.username), {})
        assert response.status_code == 403

    dyte_client.create_meeting.assert_not_called()
    assert CreatorMeeting.objects.count() == 0


def test_unknown_username_is_refused(api_client, dyte_client, streamer):
    api_client.force_authenticate(user=streamer)

    response = api_client.post(MANAGE_URL.format(username='nobody-here'), {})

    assert response.status_code == 403, response.data
    dyte_client.create_meeting.assert_not_called()
    assert CreatorMeeting.objects.count() == 0


# --- the legitimate creator flow is unchanged --------------------------------

def test_owner_creates_their_private_meeting(
    api_client, dyte_client, streamer,
):
    api_client.force_authenticate(user=streamer)

    response = api_client.post(
        MANAGE_URL.format(username=streamer.username), {'e2ee': True})

    assert response.status_code == 200, response.data
    cm = CreatorMeeting.objects.get(creator=streamer, meeting_type=PRIVATE)
    assert cm.is_public is False
    assert str(response.data['secret']) == str(cm.secret)
    assert cm.meeting_id == 'provider-meeting-1'
    assert dyte_client.create_meeting.call_count == 1


def test_owner_recycles_their_own_secret(api_client, dyte_client, streamer):
    cm = _create_private_meeting(api_client, streamer)
    first_secret = cm.secret
    first_meeting_id = cm.meeting_id

    api_client.force_authenticate(user=streamer)
    response = api_client.post(
        MANAGE_URL.format(username=streamer.username), {})

    assert response.status_code == 200, response.data
    cm.refresh_from_db()
    assert cm.secret != first_secret
    assert str(response.data['secret']) == str(cm.secret)

    # Pinned, not endorsed: `_create_meeting` runs unconditionally, so every
    # POST mints a NEW provider room and abandons the previous one. That is
    # the pre-existing amplification the codex review flagged on this PR; it
    # is out of scope here (the fix above narrows who can reach it from "any
    # authenticated user, any username" to "the owner, over 150 2Z, on their
    # own route"). This assertion exists so bounding or de-duplicating that
    # call is a deliberate, visible test edit rather than a silent one.
    assert dyte_client.create_meeting.call_count == 2
    assert cm.meeting_id != first_meeting_id


def test_owner_get_returns_their_secret(api_client, dyte_client, streamer):
    cm = _create_private_meeting(api_client, streamer)

    api_client.force_authenticate(user=streamer)
    response = api_client.get(MANAGE_URL.format(username=streamer.username))

    assert response.status_code == 200, response.data
    assert str(response.data['secret']) == str(cm.secret)


def test_owner_below_the_streaming_threshold_is_refused(
    api_client, dyte_client, creator_factory,
):
    broke = creator_factory(tuzis=Decimal('149'))
    api_client.force_authenticate(user=broke)

    response = api_client.post(MANAGE_URL.format(username=broke.username), {})

    assert response.status_code == 400, response.data
    dyte_client.create_meeting.assert_not_called()
    assert CreatorMeeting.objects.count() == 0


@pytest.mark.parametrize('path_spelling', ['mixedcase', 'MIXEDCASE'])
def test_case_variant_of_own_username_still_hits_the_tuzi_gate(
    api_client, dyte_client, creator_factory, path_spelling,
):
    """The bypass did not even need somebody else's name.

    `request.user.username == stream_owner` is case-sensitive, so a creator
    called `MixedCase` skipped the 150 2Z gate simply by lower-casing their
    own name in the URL — and got a provider meeting out of it.
    """
    broke = creator_factory(username='MixedCase', tuzis=Decimal('0'))
    api_client.force_authenticate(user=broke)

    response = api_client.post(
        MANAGE_URL.format(username=path_spelling), {})

    assert response.status_code == 400, response.data
    dyte_client.create_meeting.assert_not_called()
    assert CreatorMeeting.objects.count() == 0


def test_case_variant_of_own_username_still_works_for_a_streamer(
    api_client, dyte_client, creator_factory,
):
    """The flip side: case-folding must not lock a creator out of their own
    route."""
    owner = creator_factory(username='MixedCase', tuzis=Decimal('1000'))
    api_client.force_authenticate(user=owner)

    response = api_client.post(MANAGE_URL.format(username='mixedcase'), {})

    assert response.status_code == 200, response.data
    assert CreatorMeeting.objects.filter(
        creator=owner, meeting_type=PRIVATE).exists()


# --- the invitee path must keep working --------------------------------------

def test_invitee_holding_the_secret_still_joins(
    api_client, dyte_client, streamer, outsider,
):
    """This is the whole point of a private meeting: the secret is the
    credential. The join route must stay open to people who are not the
    creator."""
    cm = _create_private_meeting(api_client, streamer, e2ee=True)

    api_client.force_authenticate(user=outsider)
    response = api_client.post(
        JOIN_URL.format(username=streamer.username, secret=cm.secret), {})

    assert response.status_code == 200, response.data
    assert response.data['auth_token'] == 'auth-token'
    assert response.data['e2ee'] is True
    added_user = dyte_client.add_participant.call_args[0][0]
    assert added_user == outsider


def test_a_broke_invitee_still_joins_somebody_elses_room(
    api_client, dyte_client, streamer, creator_factory,
):
    """The 150 2Z requirement is about going live, not about being invited.

    It applies to the room's own creator, and the room is what says who that
    is — deciding it by comparing the path spelling to the caller's username
    would refuse a real invitee whose name merely case-folds onto the host's.
    """
    cm = _create_private_meeting(api_client, streamer)
    guest = creator_factory(tuzis=Decimal('0'))
    assert guest.can_stream is False

    api_client.force_authenticate(user=guest)
    response = api_client.post(
        JOIN_URL.format(username=streamer.username, secret=cm.secret), {})

    assert response.status_code == 200, response.data
    assert response.data['auth_token'] == 'auth-token'


def test_owner_below_the_threshold_cannot_host_their_own_room(
    api_client, dyte_client, creator_factory,
):
    """The other half of the same guard: it must still fire for the host."""
    owner = creator_factory(tuzis=Decimal('1000'))
    cm = _create_private_meeting(api_client, owner)
    owner.tuzis = Decimal('0')
    owner.save(update_fields=['tuzis'])

    api_client.force_authenticate(user=owner)
    response = api_client.post(
        JOIN_URL.format(username=owner.username, secret=cm.secret), {})

    assert response.status_code == 400, response.data
    dyte_client.add_participant.assert_not_called()


def test_owner_still_joins_their_own_private_meeting(
    api_client, dyte_client, streamer,
):
    cm = _create_private_meeting(api_client, streamer)

    api_client.force_authenticate(user=streamer)
    response = api_client.post(
        JOIN_URL.format(username=streamer.username, secret=cm.secret), {})

    assert response.status_code == 200, response.data
    assert response.data['auth_token'] == 'auth-token'


def test_invitee_with_a_wrong_secret_is_a_404(
    api_client, dyte_client, streamer, outsider,
):
    _create_private_meeting(api_client, streamer)

    api_client.force_authenticate(user=outsider)
    response = api_client.post(
        JOIN_URL.format(
            username=streamer.username,
            secret='00000000-0000-4000-8000-000000000000',
        ),
        {},
    )

    assert response.status_code == 404
    dyte_client.add_participant.assert_not_called()


def test_ownership_matching_is_not_wider_than_the_database(
    api_client, dyte_client, creator_factory,
):
    """`straße`.casefold() == `strasse`.casefold(), but Postgres' `iexact`
    keeps those two accounts apart — so the ownership gate must too.

    A gate that is wider than the identity model underneath it answers "is
    this me?" with yes for somebody else's name.
    """
    other = creator_factory(username='strasse', tuzis=Decimal('1000'))
    api_client.force_authenticate(user=other)

    response = api_client.post(MANAGE_URL.format(username='straße'), {})

    assert response.status_code == 403, response.data
    dyte_client.create_meeting.assert_not_called()
    assert CreatorMeeting.objects.count() == 0


def test_a_case_variant_duplicate_account_still_only_touches_its_own_room(
    api_client, dyte_client, creator_factory,
):
    """Production holds legacy case-variant duplicates (`Alice` and `alice`),
    exempt from the case-insensitive username index that now refuses new ones
    (free2z/zuu#1022, `username_ci_legacy`). The case-insensitive gate then lets `alice` past
    on `/api/dyte/Alice/private` — raised by the codex review of this PR.

    It is not an escalation, and this pins why: the view keys everything on
    `creator=request.user`, so the caller reaches their OWN room and nothing
    else, exactly as if they had spelled their own name. If that ever stops
    being true, this test is the one that has to be edited.
    """
    upper = creator_factory(username='Alice', tuzis=Decimal('1000'))
    lower = creator_factory(
        username='alice', tuzis=Decimal('1000'), username_ci_legacy='alice',
    )
    upper_cm = _create_private_meeting(api_client, upper)
    upper_secret = upper_cm.secret

    api_client.force_authenticate(user=lower)
    response = api_client.post(MANAGE_URL.format(username='Alice'), {})

    assert response.status_code == 200, response.data
    lower_cm = CreatorMeeting.objects.get(creator=lower, meeting_type=PRIVATE)
    assert str(response.data['secret']) == str(lower_cm.secret)

    upper_cm.refresh_from_db()
    assert upper_cm.secret == upper_secret
    assert str(response.data['secret']) != str(upper_secret)


def test_the_two_private_routes_stay_distinct():
    """Route-level guarantee: the manage route and the join route are
    different views, and the join route is the one that takes a secret."""
    manage = resolve('/api/dyte/someone/private')
    join = resolve(
        '/api/dyte/someone/private/00000000-0000-4000-8000-000000000000')

    assert manage.func.view_class.__name__ == 'PrivateMeetingManage'
    assert join.func.view_class.__name__ == 'PrivateMeeting'
    assert 'secret' in join.kwargs


def test_owner_joins_private_room_through_case_variant_url(
    api_client, dyte_client, streamer,
):
    cm = _create_private_meeting(api_client, streamer)
    api_client.force_authenticate(user=streamer)
    response = api_client.post(
        JOIN_URL.format(username=streamer.username.upper(), secret=cm.secret), {})
    assert response.status_code == 200, response.data
    assert dyte_client.add_participant.call_args.args == (streamer, cm.meeting_id)
