"""Participant pictures must fetch directly from the deployment's origin."""
from types import SimpleNamespace

import pytest
from django.contrib.auth.models import AnonymousUser

from dj.apps.dyte.client import DyteClient
from dj.apps.g12f.models import Creator
from dj.apps.uploads.models import GenericFile


@pytest.mark.parametrize("origin", ["https://free2z.cash", "https://stage.free2z.cash/"])
@pytest.mark.parametrize("kind", ["guest", "default-avatar", "uploaded-avatar", "no-thumbnail"])
def test_participant_picture_uses_canonical_origin(mocker, settings, origin, kind):
    settings.CANONICAL_ORIGIN = origin
    settings.STATIC_URL = "/djstatic/"
    owner = Creator(username="host")
    participant = AnonymousUser() if kind == "guest" else Creator(username="viewer")
    path = "/djstatic/g12f/logo512.png"
    if kind in ("uploaded-avatar", "no-thumbnail"):
        participant.avatar_image = GenericFile()
        thumbnail = (
            "/uploadz/public/corpora/chatgpt-image-jun-6-2025-05_14_46-pm.webp"
            if kind == "uploaded-avatar" else None
        )
        mocker.patch.object(GenericFile, "get_thumbnail", return_value=thumbnail)
        path = thumbnail or path
    mocker.patch(
        "dj.apps.dyte.client.CreatorMeeting.objects.get",
        return_value=SimpleNamespace(creator=owner, meeting_type="broadcast"),
    )
    post = mocker.patch("dj.apps.dyte.client.requests.post")
    post.return_value.status_code = 200
    post.return_value.json.return_value = {"success": True}

    DyteClient("org").add_participant(participant, "meeting-id", role="viewer")

    payload = post.call_args.kwargs["json"]
    assert payload["picture"] == origin.rstrip("/") + path
    assert payload["preset_name"] == "webinar-participant"
