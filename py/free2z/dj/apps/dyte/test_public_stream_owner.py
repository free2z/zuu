"""Public stream paths identify exact accounts before accepting case aliases."""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.dyte.models import CreatorMeeting
from dj.apps.dyte.test_host_seat import provider as provider
from dj.apps.g12f.models import Subscription

pytestmark = pytest.mark.django_db


@pytest.fixture
def owners(creator_factory):
    # Migration 0110 retains these identities instead of renaming accounts.
    return {
        'Alice': creator_factory(username='Alice', tuzis=Decimal('1000')),
        'alice': creator_factory(username='alice', tuzis=Decimal('1000'), username_ci_legacy='alice'),
    }


def room(owner, meeting_type='broadcast'):
    return CreatorMeeting.objects.create(
        creator=owner, meeting_id=f'room-{owner.username}-{meeting_type}',
        meeting_type=meeting_type, is_public=True, live_now=True,
    )


def join(client, username, *, role='viewer', meeting_type='broadcast'):
    # A resolver exception must be visible as its HTTP 500 failure contract.
    client.raise_request_exception = False
    return client.post(f'/api/dyte/{username}/{meeting_type}', {'role': role}, format='json')


@pytest.mark.parametrize('username', ['Alice', 'alice'])
def test_each_exact_legacy_owner_can_start_its_own_stream(api_client, owners, provider, username):
    owner = owners[username]
    api_client.force_authenticate(owner)
    response = join(api_client, username, role='host')
    assert response.status_code == 200
    created = CreatorMeeting.objects.get()
    assert created.creator_id == owner.pk and created.meeting_id == response.data['meeting_id']
    assert provider.add_participant.call_args.args[0] == owner
    assert provider.add_participant.call_args.kwargs['role'] == 'host'
    assert provider.create_meeting.call_count == 1


@pytest.mark.parametrize('username', ['Alice', 'alice'])
@pytest.mark.parametrize('signed_in_as_other', [False, True])
def test_exact_stream_path_cannot_retarget_to_the_other_case_variant(
        api_client, owners, provider, username, signed_in_as_other):
    rooms = {name: room(owner) for name, owner in owners.items()}
    if signed_in_as_other:
        api_client.force_authenticate(owners['alice' if username == 'Alice' else 'Alice'])
    response = join(api_client, username, role='host' if signed_in_as_other else 'viewer')
    assert response.status_code == 200
    assert response.data['meeting_id'] == rooms[username].meeting_id
    assert provider.add_participant.call_args.args[1] == rooms[username].meeting_id
    assert provider.add_participant.call_args.kwargs['role'] == 'viewer'
    provider.create_meeting.assert_not_called()
    assert not CreatorMeeting.objects.exclude(host_session_id=None).exists()


@pytest.mark.parametrize('username', ['Alice', 'alice'])
def test_subscriber_access_belongs_to_the_exact_legacy_owner(
        api_client, creator_factory, owners, provider, username):
    for owner in owners.values():
        room(owner, 'subscribers-only')
    fan = creator_factory(username='case-subscriber')
    Subscription.objects.create(star=owners[username], fan=fan, expires=timezone.now() + timedelta(days=1))
    api_client.force_authenticate(fan)
    response = join(api_client, username, meeting_type='subscribers-only')
    assert response.status_code == 200
    assert response.data['meeting_id'] == f'room-{username}-subscribers-only'
    other = 'alice' if username == 'Alice' else 'Alice'
    refused = join(api_client, other, meeting_type='subscribers-only')
    assert refused.status_code == 402 and refused.data['code'] == 'subscription_required'
    assert provider.add_participant.call_count == 1


def test_single_owner_case_alias_preserves_host_identity(api_client, creator_factory, provider):
    owner = creator_factory(username='CaseHost', tuzis=Decimal('1000'))
    api_client.force_authenticate(owner)
    response = join(api_client, 'casehost', role='host')
    assert response.status_code == 200
    assert CreatorMeeting.objects.get().creator_id == owner.pk
    assert provider.add_participant.call_args.args[0] == owner
    assert provider.add_participant.call_args.kwargs['role'] == 'host'


@pytest.mark.parametrize('active_names', [('Alice', 'alice'), ('Alice',), ('alice',), ()])
def test_ambiguous_alias_refuses_even_when_only_one_collision_is_active(
        api_client, owners, provider, active_names):
    for name, owner in owners.items():
        room(owner)
        owner.is_active = name in active_names
        owner.save(update_fields=['is_active'])
    response = join(api_client, 'ALICE')
    assert response.status_code == 404
    provider.add_participant.assert_not_called()
    provider.create_meeting.assert_not_called()


@pytest.mark.parametrize('username', ['Alice', 'alice'])
def test_inactive_exact_identity_never_falls_through_to_active_variant(api_client, owners, provider, username):
    for owner in owners.values():
        room(owner)
    owners[username].is_active = False
    owners[username].save(update_fields=['is_active'])
    response = join(api_client, username)
    assert response.status_code == 404
    provider.add_participant.assert_not_called()
    provider.create_meeting.assert_not_called()


@pytest.mark.parametrize('username', ['casehost', 'missing'])
def test_inactive_unique_alias_and_missing_owner_refuse(api_client, creator_factory, provider, username):
    room(creator_factory(username='CaseHost', is_active=False))
    response = join(api_client, username)
    assert response.status_code == 404
    provider.add_participant.assert_not_called()
    provider.create_meeting.assert_not_called()
