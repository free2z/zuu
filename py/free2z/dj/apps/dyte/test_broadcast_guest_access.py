from unittest.mock import Mock

import pytest
from django.core.cache import cache
from rest_framework.throttling import SimpleRateThrottle

from dj.apps.dyte.models import CreatorMeeting


@pytest.fixture
def isolated_throttle_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.mark.django_db
def test_anonymous_viewer_can_join_a_live_broadcast(
    api_client, creator_factory, mocker
):
    creator = creator_factory(username="guest-broadcast-host")
    meeting = CreatorMeeting.objects.create(
        creator=creator,
        meeting_id="guest-broadcast-room",
        meeting_type="broadcast",
        is_public=True,
        live_now=True,
    )
    provider_response = Mock()
    provider_response.json.return_value = {"data": {"token": "guest-token"}}
    provider_response.text = "participant created"
    add_participant = mocker.patch(
        "dj.apps.dyte.views.DyteClient.add_participant",
        return_value=provider_response,
    )

    response = api_client.post(
        f"/api/dyte/{creator.username}/broadcast", {}, format="json"
    )

    assert response.status_code == 200
    assert response.json() == {
        "meeting_id": meeting.meeting_id,
        "auth_token": "guest-token",
    }
    guest = add_participant.call_args.args[0]
    assert not guest.is_authenticated


@pytest.mark.django_db
def test_guest_broadcast_join_has_a_tight_budget_isolated_from_polling(
    api_client, creator_factory, mocker, isolated_throttle_cache
):
    creator = creator_factory(username="rate-limited-broadcast-host")
    CreatorMeeting.objects.create(
        creator=creator,
        meeting_id="rate-limited-broadcast-room",
        meeting_type="broadcast",
        is_public=True,
        live_now=True,
    )
    provider_response = Mock()
    provider_response.json.return_value = {"data": {"token": "guest-token"}}
    provider_response.text = "participant created"
    add_participant = mocker.patch(
        "dj.apps.dyte.views.DyteClient.add_participant",
        return_value=provider_response,
    )
    mocker.patch(
        "dj.apps.dyte.views.DyteClient.get_participants_count",
        return_value=1,
    )
    rates = {
        **SimpleRateThrottle.THROTTLE_RATES,
        "anon-poll": "2/minute",
        "anon-broadcast-join": "2/minute",
    }
    path = f"/api/dyte/{creator.username}/broadcast"

    mocker.patch.object(SimpleRateThrottle, "THROTTLE_RATES", rates)
    poll_ip = {"HTTP_X_FORWARDED_FOR": "198.51.100.10"}
    poll_statuses = [
        api_client.get(path, **poll_ip).status_code for _ in range(3)
    ]
    assert poll_statuses == [200, 200, 429]
    response = api_client.post(path, {}, format="json", **poll_ip)
    assert response.status_code == 200

    join_ip = {"HTTP_X_FORWARDED_FOR": "198.51.100.11"}
    join_statuses = [
        api_client.post(path, {}, format="json", **join_ip).status_code
        for _ in range(3)
    ]
    assert join_statuses == [200, 200, 429]
    assert api_client.get(path, **join_ip).status_code == 200

    assert add_participant.call_count == 3


@pytest.mark.django_db
def test_anonymous_head_is_charged_to_the_polling_budget(
    api_client, creator_factory, mocker, isolated_throttle_cache
):
    creator = creator_factory(username="head-throttled-broadcast-host")
    CreatorMeeting.objects.create(
        creator=creator,
        meeting_id="head-throttled-broadcast-room",
        meeting_type="broadcast",
        is_public=True,
        live_now=True,
    )
    get_participants_count = mocker.patch(
        "dj.apps.dyte.views.DyteClient.get_participants_count",
        return_value=1,
    )
    rates = {
        **SimpleRateThrottle.THROTTLE_RATES,
        "anon-poll": "2/minute",
    }
    mocker.patch.object(SimpleRateThrottle, "THROTTLE_RATES", rates)
    path = f"/api/dyte/{creator.username}/broadcast"

    statuses = [
        api_client.head(
            path, HTTP_X_FORWARDED_FOR="198.51.100.20"
        ).status_code
        for _ in range(3)
    ]

    assert statuses == [200, 200, 429]
    assert get_participants_count.call_count == 2


@pytest.mark.django_db
@pytest.mark.parametrize("meeting_type", ["ppv", "subscribers-only"])
def test_anonymous_viewer_cannot_reach_protected_stream_token_issuance(
    api_client, creator_factory, mocker, meeting_type
):
    creator = creator_factory(username=f"protected-{meeting_type}")
    add_participant = mocker.patch(
        "dj.apps.dyte.views.DyteClient.add_participant"
    )

    response = api_client.post(
        f"/api/dyte/{creator.username}/{meeting_type}", {}, format="json"
    )

    assert response.status_code == 403
    add_participant.assert_not_called()


@pytest.mark.django_db
def test_authenticated_host_cannot_create_an_unknown_public_meeting_type(
    api_client, creator_factory, mocker
):
    creator = creator_factory(username="invalid-meeting-type-host")
    api_client.force_authenticate(user=creator)
    add_participant = mocker.patch(
        "dj.apps.dyte.views.DyteClient.add_participant"
    )

    response = api_client.post(
        f"/api/dyte/{creator.username}/not-a-stream", {}, format="json"
    )

    assert response.status_code == 404
    assert not CreatorMeeting.objects.filter(creator=creator).exists()
    add_participant.assert_not_called()
