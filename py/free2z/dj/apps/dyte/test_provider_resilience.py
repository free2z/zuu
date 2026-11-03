from unittest.mock import Mock

import pytest
import requests
from django.core.cache import cache
from dj.apps.dyte.client import DyteClient, _count_cache_keys
from dj.apps.dyte.models import PRIVATE, CreatorMeeting


@pytest.mark.django_db
def test_participant_count_is_cached_and_survives_a_probe_failure(mocker):
    meeting_id = "cached-participant-count"
    recent_key, stale_key = _count_cache_keys(meeting_id)
    cache.delete_many([recent_key, stale_key])
    probe = mocker.patch.object(
        DyteClient, "get_participants_count", return_value=4,
    )
    client = DyteClient("org")

    assert client.get_cached_participants_count(meeting_id) == 4
    assert client.get_cached_participants_count(meeting_id) == 4
    probe.assert_called_once_with(meeting_id)

    cache.delete(recent_key)
    probe.side_effect = requests.Timeout("provider timeout")
    assert client.get_cached_participants_count(meeting_id) == 4


@pytest.mark.django_db
@pytest.mark.parametrize("failure", ["http", "transport", "missing-token"])
def test_public_viewer_provider_failures_are_retryable_503(
    api_client, creator_factory, mocker, failure,
):
    host = creator_factory(username=f"provider-host-{failure}")
    CreatorMeeting.objects.create(
        creator=host, meeting_id=f"provider-room-{failure}",
        meeting_type="broadcast", is_public=True, live_now=True,
    )
    if failure == "transport":
        mocker.patch(
            "dj.apps.dyte.views.DyteClient.add_participant",
            side_effect=requests.ConnectionError("unavailable"),
        )
    else:
        response = Mock()
        response.status_code = 503 if failure == "http" else 200
        response.json.return_value = (
            {"error": {"code": 503}} if failure == "http" else {"data": {}}
        )
        mocker.patch(
            "dj.apps.dyte.views.DyteClient.add_participant",
            return_value=response,
        )

    result = api_client.post(
        f"/api/dyte/{host.username}/broadcast", {}, format="json",
    )

    assert result.status_code == 503
    assert result["Retry-After"] == "5"


@pytest.mark.django_db
def test_private_viewer_provider_transport_error_is_retryable_503(
    api_client, creator_factory, mocker,
):
    host = creator_factory(username="private-provider-host")
    viewer = creator_factory(username="private-provider-viewer")
    meeting = CreatorMeeting.objects.create(
        creator=host, meeting_id="private-provider-room",
        meeting_type=PRIVATE, is_public=False,
    )
    api_client.force_authenticate(user=viewer)
    mocker.patch(
        "dj.apps.dyte.views.DyteClient.add_participant",
        side_effect=requests.Timeout("provider timeout"),
    )

    result = api_client.post(
        f"/api/dyte/{host.username}/private/{meeting.secret}", {},
        format="json",
    )

    assert result.status_code == 503
    assert result["Retry-After"] == "5"


@pytest.mark.django_db
def test_add_participant_uses_passed_meeting_without_owner_queries(
    mocker, creator_factory,
):
    owner = creator_factory(username="provider-query-owner")
    viewer = creator_factory(username="provider-query-viewer")
    cm = CreatorMeeting.objects.create(
        creator=owner, meeting_id="provider-query-room",
        meeting_type="broadcast", is_public=True, live_now=True,
    )
    response = Mock(status_code=200)
    response.json.return_value = {"data": {"token": "token"}}
    post = mocker.patch("dj.apps.dyte.client._SESSION.post", return_value=response)

    DyteClient("org").add_participant(viewer, cm.meeting_id, role="viewer", cm=cm)

    assert post.call_count == 1
    assert post.call_args.kwargs["json"]["preset_name"] == "webinar-participant"
