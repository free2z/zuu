"""Tests for the `is_live` boolean on the creator API.

`is_live` mirrors the dyte live-status predicate EXACTLY (public + live_now +
fresh within DYTE_LIVE_LAST_SEEN_TTL_SECONDS) so clients can gate a "Watch live"
affordance synchronously. It is implemented as an indexed `Exists()` annotation
on the queryset (no N+1, no provider call) and surfaced on BOTH the detail and
list serializers.

These tests prove accuracy (incl. the TTL cutoff) and that the new annotation
does NOT disturb `count`, `watch_score` ordering, the / filter scoping,
or the private `tuzis` field.
"""
import uuid
from datetime import timedelta

import pytest
from django.conf import settings
from django.utils import timezone

from dj.apps.dyte.models import PUBLIC_MEETING_TYPES, CreatorMeeting
from dj.apps.g12f.models import zPage
from dj.apps.uploads.models import GenericFile


def _image(creator):
    return GenericFile.objects.create(
        owner=creator,
        file=f"uploads/test-{uuid.uuid4().hex}.png",  # one key, one row
        mime_type="image/png",
    )


def _make_creator(creator_factory, **kwargs):
    """A creator with the avatar + banner the discovery list requires."""
    creator = creator_factory(**kwargs)
    creator.avatar_image = _image(creator)
    creator.banner_image = _image(creator)
    creator.save()
    return creator


def _publish_page(creator, *, days_old=0):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=str(uuid.uuid4())[:12],
        title="A page",
        content="Some content about a topic.",
        is_published=True,
    )
    if days_old:
        when = timezone.now() - timedelta(days=days_old)
        zPage.objects.filter(pk=page.pk).update(
            created_at=when, updated_at=when, publish_at=when,
        )
    return page


def _make_meeting(creator, **kwargs):
    defaults = dict(
        creator=creator,
        meeting_id=str(uuid.uuid4()),
        meeting_type="broadcast",
        is_public=True,
        live_now=True,
        last_seen_at=timezone.now(),
    )
    defaults.update(kwargs)
    return CreatorMeeting.objects.create(**defaults)


def _qualified_creator(creator_factory, username):
    """A creator that qualifies for the default discovery list."""
    creator = _make_creator(creator_factory, username=username)
    _publish_page(creator, days_old=1)
    return creator


def _detail(api_client, username):
    return api_client.get(f"/api/creator/{username}/")


def _list_item(response, username):
    for item in response.json()["results"]:
        if item["username"] == username:
            return item
    return None


# ---------------------------------------------------------------------------
# Accuracy: a fresh public live room => is_live True in BOTH detail and list.
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_live_creator_is_live_in_detail_and_list(api_client, creator_factory):
    creator = _qualified_creator(creator_factory, "livecreator")
    _make_meeting(creator, live_now=True, last_seen_at=timezone.now())

    detail = _detail(api_client, "livecreator")
    assert detail.status_code == 200
    assert detail.json()["is_live"] is True

    listing = api_client.get("/api/creator/")
    assert listing.status_code == 200
    item = _list_item(listing, "livecreator")
    assert item is not None
    assert item["is_live"] is True


# ---------------------------------------------------------------------------
# TTL accuracy guard: a live room whose last_seen_at is stale => is_live False.
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_stale_last_seen_is_not_live(api_client, creator_factory):
    creator = _qualified_creator(creator_factory, "stalecreator")
    stale = timezone.now() - timedelta(
        seconds=settings.DYTE_LIVE_LAST_SEEN_TTL_SECONDS + 60)
    _make_meeting(creator, live_now=True, last_seen_at=stale)

    detail = _detail(api_client, "stalecreator")
    assert detail.status_code == 200
    assert detail.json()["is_live"] is False

    item = _list_item(api_client.get("/api/creator/"), "stalecreator")
    assert item is not None
    assert item["is_live"] is False


# ---------------------------------------------------------------------------
# A private room, or live_now=False, must not count as live.
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_private_room_is_not_live(api_client, creator_factory):
    creator = _qualified_creator(creator_factory, "privatecreator")
    _make_meeting(
        creator, is_public=False, live_now=True, last_seen_at=timezone.now())

    detail = _detail(api_client, "privatecreator")
    assert detail.status_code == 200
    assert detail.json()["is_live"] is False

    item = _list_item(api_client.get("/api/creator/"), "privatecreator")
    assert item is not None
    assert item["is_live"] is False


@pytest.mark.django_db
def test_offline_room_is_not_live(api_client, creator_factory):
    creator = _qualified_creator(creator_factory, "offlinecreator")
    _make_meeting(
        creator, is_public=True, live_now=False, last_seen_at=timezone.now())

    detail = _detail(api_client, "offlinecreator")
    assert detail.status_code == 200
    assert detail.json()["is_live"] is False

    item = _list_item(api_client.get("/api/creator/"), "offlinecreator")
    assert item is not None
    assert item["is_live"] is False


# ---------------------------------------------------------------------------
# REGRESSION: a legacy row whose meeting_type is outside the enum must
# not make a creator "live".
#
# Before the create/join route was constrained  the URL segment was
# written straight into CreatorMeeting.meeting_type, so production still holds
# rows with arbitrary values.  filtered them out of
# PublicMeetingViewSet._live_queryset and live_meeting_status but NOT out of
# CreatorView._is_live_subquery, so such a creator was advertised as live while
# every endpoint that could name or join the stream returned nothing.
#
# The rows are planted directly (objects.create bypasses full_clean, which is
# exactly how they got into production) because the API can no longer create
# them.
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_legacy_off_enum_meeting_type_is_not_live(api_client, creator_factory):
    creator = _qualified_creator(creator_factory, "zzlegacytype")
    _make_meeting(
        creator,
        meeting_type="totally-bogus",
        is_public=True,
        live_now=True,
        last_seen_at=timezone.now(),
    )

    detail = _detail(api_client, "zzlegacytype")
    assert detail.status_code == 200
    assert detail.json()["is_live"] is False

    item = _list_item(api_client.get("/api/creator/"), "zzlegacytype")
    assert item is not None
    assert item["is_live"] is False

    # And the endpoint that would name the stream agrees: nothing to join.
    status_resp = api_client.get("/api/dyte/zzlegacytype/live-status")
    assert status_resp.status_code == 200
    assert status_resp.json() == {}


@pytest.mark.django_db
@pytest.mark.parametrize("meeting_type", list(PUBLIC_MEETING_TYPES))
def test_every_public_meeting_type_still_counts_as_live(
    api_client, creator_factory, meeting_type,
):
    """The  filter must not narrow the enum it is protecting."""
    username = f"zzlive{meeting_type.replace('-', '')}"
    creator = _qualified_creator(creator_factory, username)
    _make_meeting(
        creator,
        meeting_type=meeting_type,
        is_public=True,
        live_now=True,
        last_seen_at=timezone.now(),
    )

    detail = _detail(api_client, username)
    assert detail.status_code == 200
    assert detail.json()["is_live"] is True

    item = _list_item(api_client.get("/api/creator/"), username)
    assert item is not None
    assert item["is_live"] is True


@pytest.mark.django_db
def test_legacy_row_does_not_mask_a_real_live_room(api_client, creator_factory):
    """A creator holding BOTH a legacy row and a valid live room is still live.

    Guards against "fix it by excluding the creator" — the filter must drop the
    offending ROW, not the creator.
    """
    creator = _qualified_creator(creator_factory, "zzmixedlive")
    _make_meeting(
        creator, meeting_type="junk-type", live_now=True,
        last_seen_at=timezone.now(),
    )
    _make_meeting(
        creator, meeting_type="broadcast", live_now=True,
        last_seen_at=timezone.now(),
    )

    detail = _detail(api_client, "zzmixedlive")
    assert detail.status_code == 200
    assert detail.json()["is_live"] is True


# ---------------------------------------------------------------------------
# No meeting at all => is_live False.
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_no_meeting_is_not_live(api_client, creator_factory):
    _qualified_creator(creator_factory, "nomeeting")

    detail = _detail(api_client, "nomeeting")
    assert detail.status_code == 200
    assert detail.json()["is_live"] is False

    item = _list_item(api_client.get("/api/creator/"), "nomeeting")
    assert item is not None
    assert item["is_live"] is False


# ---------------------------------------------------------------------------
# is_live must NOT disturb count, watch_score ordering, / scoping, or
# leak the private `tuzis` balance.
# ---------------------------------------------------------------------------
@pytest.mark.django_db
def test_is_live_does_not_change_count_or_ordering(api_client, creator_factory):
    """A live room on the more-recently-active creator must not fan out rows
    (Exists is a correlated subquery, not a JOIN) nor change ranking."""
    recent = _qualified_creator(creator_factory, "zzliverecent")
    zPage.objects.filter(creator=recent).update(
        updated_at=timezone.now() - timedelta(days=2),
        created_at=timezone.now() - timedelta(days=2),
        publish_at=timezone.now() - timedelta(days=2),
    )
    # Give the recent creator a live room (would multiply rows under a JOIN).
    _make_meeting(recent, live_now=True, last_seen_at=timezone.now())

    stale = _make_creator(creator_factory, username="zzlivestale")
    _publish_page(stale, days_old=200)

    resp = api_client.get("/api/creator/")
    assert resp.status_code == 200
    data = resp.json()
    names = [i["username"] for i in data["results"]]

    # Each creator appears exactly once — no row fan-out from the subquery.
    assert names.count("zzliverecent") == 1
    assert names.count("zzlivestale") == 1
    # count reflects distinct creators, not multiplied rows.
    assert data["count"] == len(names)
    # watch_score ordering preserved: recent activity ranks above stale.
    assert names.index("zzliverecent") < names.index("zzlivestale")


@pytest.mark.django_db
def test_is_live_never_leaks_tuzis(api_client, creator_factory):
    creator = _qualified_creator(creator_factory, "zzlivetuzis")
    creator.tuzis = 424242
    # See: only an explicit update_fields writes the balance.
    creator.save(update_fields=["tuzis"])
    _make_meeting(creator, live_now=True, last_seen_at=timezone.now())

    detail = _detail(api_client, "zzlivetuzis")
    assert "tuzis" not in detail.json()
    assert detail.json()["is_live"] is True

    item = _list_item(api_client.get("/api/creator/"), "zzlivetuzis")
    assert item is not None
    assert "tuzis" not in item
    assert "total" in item


@pytest.mark.django_db
def test_is_live_on_search_scope_creator_with_no_page(api_client, creator_factory):
    """REGRESSION: search still finds a page-less creator, and it
    carries is_live (False here, no live room)."""
    _make_creator(creator_factory, username="zzlivesearchnopage")

    resp = api_client.get("/api/creator/?search=zzlivesearchnopage")
    assert resp.status_code == 200
    item = _list_item(resp, "zzlivesearchnopage")
    assert item is not None
    assert item["is_live"] is False
