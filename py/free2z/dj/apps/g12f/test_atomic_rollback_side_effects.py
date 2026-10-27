"""Side effects that must survive, or be undone with, a rolled-back write.

 made AtomicMiddleware roll the request back when the view RAISES. A
fresh review of that change found five places where the old "commit
whatever happened before the raise" behaviour was holding up something that
now needs to be explicit. Each test below goes through the real URLconf, the
real middleware stack and real Postgres, with ``django_db(transaction=True)``,
because only a real COMMIT can tell "persisted" apart from "rolled back".

Only the external provider boundaries are stubbed: Dyte, Pub/Sub, and GCS
(swapped for a FileSystemStorage in a tmp dir).
"""
import json
import uuid
from datetime import timedelta
from decimal import Decimal
from io import BytesIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from django.utils import timezone
from knox.models import AuthToken
from PIL import Image
from rest_framework.test import APIClient

from dj.apps.dyte.models import BROADCAST, CreatorMeeting
from dj.apps.g12f.models import zPage
from dj.apps.uploads.models import GenericFile

pytestmark = pytest.mark.django_db(transaction=True)


# --- (1) knox's expired-token sweep ------------------------------------------

def test_an_expired_bearer_token_is_swept_even_though_the_post_is_refused(
    creator_factory,
):
    """knox deletes an expired presented token and then raises
    AuthenticationFailed. On a write, that delete was inside the request
    transaction the raise now rolls back."""
    owner = creator_factory(username=f"t2101exp{uuid.uuid4().hex[:6]}")
    instance, raw = AuthToken.objects.create(owner)
    AuthToken.objects.filter(pk=instance.pk).update(
        expiry=timezone.now() - timedelta(minutes=1))

    client = APIClient(raise_request_exception=False)
    client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
    response = client.post("/api/token/login/")

    assert response.status_code in (401, 403), response.content
    assert not AuthToken.objects.filter(pk=instance.pk).exists(), (
        "the expired token survived: knox's delete was rolled back with the "
        "refused POST"
    )


# --- (3) Dyte go-live retry --------------------------------------------------

class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    @property
    def text(self):
        return str(self._payload)


def test_a_failed_go_live_retry_keeps_the_fresh_meeting_id(
    creator_factory, mocker,
):
    """The owner's add_participant fails, the view recreates the provider
    meeting and retries, and the retry fails too. The recreated meeting id
    must persist; otherwise the next attempt reuses the dead id and pays for
    another provider meeting."""
    streamer = creator_factory(tuzis=Decimal("1000"))
    CreatorMeeting.objects.create(
        creator=streamer, meeting_type=BROADCAST, is_public=True,
        meeting_id="stale-meeting",
    )
    client_stub = mocker.MagicMock()
    client_stub.create_meeting.return_value = _FakeResponse(
        {"data": {"id": "fresh-meeting"}})
    client_stub.add_participant.return_value = _FakeResponse(
        {"success": False, "error": {"code": 404, "message": "No meeting"}})
    mocker.patch("dj.apps.dyte.views.DyteClient", return_value=client_stub)

    api = APIClient(raise_request_exception=False)
    api.force_authenticate(user=streamer)
    response = api.post(
        f"/api/dyte/{streamer.username}/{BROADCAST}", {}, format="json")

    assert response.status_code == 502, response.content
    assert client_stub.create_meeting.call_count == 1
    stored = CreatorMeeting.objects.get(
        creator=streamer, meeting_type=BROADCAST)
    assert stored.meeting_id == "fresh-meeting", (
        "the recreated provider meeting id was rolled back"
    )
    assert stored.live_now is False


def test_a_successful_go_live_is_unchanged(creator_factory, mocker):
    streamer = creator_factory(tuzis=Decimal("1000"))
    client_stub = mocker.MagicMock()
    client_stub.create_meeting.return_value = _FakeResponse(
        {"data": {"id": "fresh-meeting"}})
    client_stub.add_participant.return_value = _FakeResponse(
        {"data": {"token": "auth-token"}})
    mocker.patch("dj.apps.dyte.views.DyteClient", return_value=client_stub)

    api = APIClient()
    api.force_authenticate(user=streamer)
    response = api.post(
        f"/api/dyte/{streamer.username}/{BROADCAST}", {}, format="json")

    assert response.status_code == 200, response.content
    stored = CreatorMeeting.objects.get(
        creator=streamer, meeting_type=BROADCAST)
    assert stored.live_now is True


# --- (5a) the PAGE_UPDATE broadcast ------------------------------------------

class _BrokenPubSub:
    calls = 0

    def publish(self, *args, **kwargs):
        type(self).calls += 1
        raise RuntimeError("Pub/Sub topic check timed out")


def test_a_pubsub_failure_does_not_discard_the_authors_edit(
    creator_factory, mocker,
):
    mocker.patch("dj.apps.g12f.publication.PubSubClient", _BrokenPubSub)
    _BrokenPubSub.calls = 0
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), title="Before",
        description="d", content="Before body", source_language="en",
        is_published=True, vanity=f"t2101-{uuid.uuid4().hex[:8]}",
    )
    api = APIClient(raise_request_exception=False)
    api.force_authenticate(creator)

    response = api.patch(
        f"/api/zpage/{page.free2zaddr}/", {"title": "After"}, format="json")

    assert response.status_code == 200, response.content
    assert _BrokenPubSub.calls == 1, "the broadcast was never attempted"
    assert zPage.objects.get(pk=page.pk).title == "After", (
        "a Pub/Sub failure rolled back the author's edit"
    )


def test_a_rolled_back_save_is_never_broadcast(creator_factory, mocker):
    """The broadcast runs on commit, so an edit that does not land is not
    announced -- here, a raise from a later side effect of the same save."""
    published = []

    class _RecordingPubSub:
        def publish(self, topic, payload, **kwargs):
            published.append(payload)

    mocker.patch("dj.apps.g12f.publication.PubSubClient", _RecordingPubSub)
    from dj.apps.g12f.views import zpage as zpage_views

    def emit_then_raise(self, instance):
        # The broadcast is requested, then a later step of the same save
        # fails and the request rolls back.
        zpage_views.emit_page_update(instance)
        raise RuntimeError("after the broadcast was requested")

    mocker.patch.object(zpage_views.zPageView, "publish_page", emit_then_raise)
    creator = creator_factory()
    page = zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), title="Before",
        description="d", content="Before body", source_language="en",
        is_published=True, vanity=f"t2101-{uuid.uuid4().hex[:8]}",
    )
    api = APIClient(raise_request_exception=False)
    api.force_authenticate(creator)

    response = api.patch(
        f"/api/zpage/{page.free2zaddr}/", {"title": "After"}, format="json")

    assert response.status_code == 500
    assert zPage.objects.get(pk=page.pk).title == "Before"
    assert published == [], "a rolled-back edit was broadcast"


# --- (5b) a multi-file upload that fails partway -----------------------------

@pytest.fixture
def local_media(settings, tmp_path):
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    }
    settings.MEDIA_ROOT = str(tmp_path)
    return tmp_path


def _png(name):
    buf = BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, "PNG")
    return SimpleUploadedFile(name, buf.getvalue(), content_type="image/png")


def _stored_files(root):
    return sorted(p for p in root.rglob("*") if p.is_file())


def test_a_batch_that_fails_partway_leaves_no_orphaned_objects(
    client, creator_factory, local_media, mocker,
):
    creator = creator_factory()
    client.force_login(creator)
    client.raise_request_exception = False

    from django.core.files.storage import FileSystemStorage

    real_save = FileSystemStorage._save
    stores = {"n": 0}

    def fail_the_third_store(self, name, content):
        stores["n"] += 1
        if stores["n"] == 3:
            raise OSError("storage backend returned 503")
        return real_save(self, name, content)

    mocker.patch.object(FileSystemStorage, "_save", fail_the_third_store)
    metadata = [
        {"title": "one", "name": "one.png", "access": "private"},
        {"title": "two", "name": "two.png", "access": "private"},
        {"title": "three", "name": "three.png", "access": "private"},
    ]
    response = client.post(
        reverse("uploads_handle"),
        {
            "body": json.dumps(metadata),
            "files": [_png("one.png"), _png("two.png"), _png("three.png")],
        },
    )

    assert response.status_code == 500
    assert stores["n"] == 3, "the batch never reached its third file"
    assert not GenericFile.objects.filter(owner=creator).exists()
    assert _stored_files(local_media) == [], (
        "objects stored for a rolled-back batch were left in the bucket"
    )


def test_a_successful_batch_keeps_its_objects(
    client, creator_factory, local_media,
):
    creator = creator_factory()
    client.force_login(creator)
    metadata = [
        {"title": "one", "name": "one.png", "access": "private"},
        {"title": "two", "name": "two.png", "access": "private"},
    ]
    response = client.post(
        reverse("uploads_handle"),
        {"body": json.dumps(metadata),
         "files": [_png("one.png"), _png("two.png")]},
    )

    assert response.status_code == 201, response.content
    rows = GenericFile.objects.filter(owner=creator)
    assert rows.count() == 2
    for row in rows:
        assert row.file.storage.exists(row.file.name)
