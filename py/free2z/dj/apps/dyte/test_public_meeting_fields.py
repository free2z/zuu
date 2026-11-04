"""The public live-room representations expose reviewed fields.

The public list once used ``fields = '__all__'``, which
means the response shape of an ``AllowAny`` endpoint is decided by whoever
adds the next column to ``CreatorMeeting`` — as a side effect of a migration,
with no review of whether the value is public.

That is not hypothetical: ``secret``, the bearer credential for
``/api/dyte/<username>/private/<secret>``, was in the response schema. It is
``editable=False``, which DRF turns into ``read_only=True`` — read-only means
"not writable", **not** "not serialized" — so it was published (as ``null``
for public rooms) and shipped in the generated TypeScript client.

Two assertions, deliberately in this order:

1. The field set is exactly the enumerated list. This fails on the *next*
   column somebody adds, which is the whole point — the failure is the review.
2. ``secret`` is absent even from a row that has one. This is the concrete
   leak and would keep passing if (1) were ever loosened back to ``__all__``
   with the field explicitly excluded.
"""
from datetime import timedelta
import uuid

import pytest
from django.urls import reverse
from django.utils import timezone
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.apps.dyte.models import CreatorMeeting
from dj.apps.dyte.views import PUBLIC_DISCOVERY_LIMIT
from dj.apps.g12f.branding import default_logo_url
from dj.apps.uploads.models import GenericFile, ImageVariant, Webp

EXPECTED_FIELDS = {
    "id",
    "creator",
    "meeting_id",
    "meeting_type",
    "is_public",
    "live_now",
    "last_seen_at",
    "created_at",
    "price_per_minute",
    "e2ee",
}

DISCOVERY_FIELDS = {"username", "avatar", "meeting_type", "price_per_minute"}


def _live_room(creator, **kwargs):
    defaults = dict(
        creator=creator,
        meeting_id="mtg-public-fields",
        meeting_type="broadcast",
        is_public=True,
        live_now=True,
        last_seen_at=timezone.now() - timedelta(seconds=5),
    )
    defaults.update(kwargs)
    return CreatorMeeting.objects.create(**defaults)


def _rows(resp):
    """Return rows from the legacy paginated list."""
    data = resp.json()
    return data["results"]


@pytest.mark.django_db
def test_public_meeting_exposes_exactly_the_enumerated_fields(
    api_client, creator_factory
):
    creator = creator_factory()
    _live_room(creator)

    resp = api_client.get(reverse("public-meeting-list"))
    assert resp.status_code == 200

    rows = _rows(resp)
    assert len(rows) == 1
    assert set(rows[0]) == EXPECTED_FIELDS
    assert rows[0]["creator"]["username"] == creator.username
    assert rows[0]["meeting_type"] == "broadcast"


@pytest.mark.django_db
def test_public_meeting_never_serializes_the_join_secret(
    api_client, creator_factory
):
    """A row that actually holds a secret must not publish it.

    ``recycle_secret()`` is only called on private rooms today, so a public
    row's ``secret`` is ``None`` in practice. Setting one here removes that
    coincidence from the test: if the field comes back at all, it comes back
    with the real credential in it.
    """
    creator = creator_factory()
    room = _live_room(creator)
    CreatorMeeting.objects.filter(pk=room.pk).update(secret=uuid.uuid4())
    room.refresh_from_db()
    assert room.secret is not None

    list_resp = api_client.get(reverse("public-meeting-list"))
    assert list_resp.status_code == 200
    row = _rows(list_resp)[0]
    assert "secret" not in row
    assert set(row) == EXPECTED_FIELDS
    assert str(room.secret) not in list_resp.content.decode()

    detail_resp = api_client.get(
        reverse("public-meeting-detail", args=[room.meeting_id])
    )
    assert detail_resp.status_code == 200
    assert "secret" not in detail_resp.json()
    assert str(room.secret) not in detail_resp.content.decode()


def test_meeting_type_schema_keeps_the_stable_public_component_name():
    """Adding a ChoiceField must not rename the existing generated enum."""
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    creator_meeting = schema["components"]["schemas"]["CreatorMeeting"]
    meeting_type = creator_meeting["properties"]["meeting_type"]

    assert meeting_type["allOf"] == [
        {"$ref": "#/components/schemas/MeetingTypeEnum"}
    ]
    assert "MeetingTypeEnum" in schema["components"]["schemas"]
    assert "CreatorMeetingMeetingTypeEnum" not in schema["components"]["schemas"]


@pytest.mark.django_db
def test_public_list_includes_each_public_mode_but_never_private(
    api_client, creator_factory,
):
    creator = creator_factory()
    for meeting_type in ("broadcast", "ppv", "subscribers-only"):
        _live_room(
            creator,
            meeting_id=f"mtg-{meeting_type}",
            meeting_type=meeting_type,
            price_per_minute="1.25" if meeting_type == "ppv" else "0.00",
        )
    _live_room(
        creator,
        meeting_id="mtg-private",
        meeting_type="private",
        is_public=False,
    )
    # Belt-and-braces guard: malformed historical data must not make a
    # private room public merely because its is_public flag is wrong.
    _live_room(
        creator,
        meeting_id="mtg-private-public-flag",
        meeting_type="private",
        is_public=True,
    )

    resp = api_client.get(reverse("public-meeting-discovery"))

    assert resp.status_code == 200
    payload = resp.json()
    assert set(payload) == {"results", "selected_creators", "complete"}
    assert payload["complete"] is True
    assert payload["selected_creators"] == [creator.username]
    assert {row["meeting_type"] for row in payload["results"]} == {
        "broadcast",
        "ppv",
        "subscribers-only",
    }
    assert all(set(row) == DISCOVERY_FIELDS for row in payload["results"])


@pytest.mark.django_db
def test_legacy_public_list_remains_paginated_and_full_contract(
    api_client, creator_factory,
):
    creator = creator_factory()
    _live_room(creator)

    response = api_client.get(reverse("public-meeting-list"))

    assert response.status_code == 200
    assert set(response.json()) == {"count", "next", "previous", "results"}
    assert set(response.json()["results"][0]) == EXPECTED_FIELDS


@pytest.mark.django_db
def test_discovery_is_bounded_and_deterministically_fresh(
    api_client, creator_factory,
):
    creators = [
        creator_factory() for _ in range(PUBLIC_DISCOVERY_LIMIT + 1)
    ]
    now = timezone.now()
    for index, creator in enumerate(creators):
        _live_room(
            creator,
            meeting_id=f"discovery-{index}",
            last_seen_at=now - timedelta(seconds=index),
        )

    response = api_client.get(reverse("public-meeting-discovery"))

    assert response.status_code == 200
    assert response["Cache-Control"] == "no-store"
    payload = response.json()
    assert payload["complete"] is False
    assert payload["selected_creators"] == [
        creator.username for creator in creators[:PUBLIC_DISCOVERY_LIMIT]
    ]
    assert len(payload["results"]) == PUBLIC_DISCOVERY_LIMIT
    assert {row["username"] for row in payload["results"]} == set(
        payload["selected_creators"]
    )
    assert creators[PUBLIC_DISCOVERY_LIMIT].username not in payload[
        "selected_creators"
    ]


@pytest.mark.django_db
def test_discovery_at_exact_creator_limit_is_complete(api_client, creator_factory):
    creators = [creator_factory() for _ in range(PUBLIC_DISCOVERY_LIMIT)]
    now = timezone.now()
    for index, creator in enumerate(creators):
        _live_room(
            creator,
            meeting_id=f"discovery-exact-{index}",
            last_seen_at=now - timedelta(seconds=index),
        )

    payload = api_client.get(reverse("public-meeting-discovery")).json()

    assert payload["complete"] is True
    assert payload["selected_creators"] == [
        creator.username for creator in creators
    ]
    assert len(payload["results"]) == PUBLIC_DISCOVERY_LIMIT


@pytest.mark.django_db
def test_discovery_cutoff_keeps_all_live_modes_for_selected_creators(
    api_client, creator_factory,
):
    creators = [
        creator_factory() for _ in range(PUBLIC_DISCOVERY_LIMIT + 1)
    ]
    now = timezone.now()
    for index, creator in enumerate(creators):
        _live_room(
            creator,
            meeting_id=f"cutoff-broadcast-{index}",
            meeting_type="broadcast",
            last_seen_at=now - timedelta(seconds=index),
        )
    for meeting_type in ("ppv", "subscribers-only"):
        _live_room(
            creators[0],
            meeting_id=f"cutoff-{meeting_type}",
            meeting_type=meeting_type,
            last_seen_at=now - timedelta(seconds=30),
        )

    payload = api_client.get(reverse("public-meeting-discovery")).json()

    assert payload["complete"] is False
    assert payload["selected_creators"] == [
        creator.username for creator in creators[:PUBLIC_DISCOVERY_LIMIT]
    ]
    selected_rows = [
        row for row in payload["results"] if row["username"] == creators[0].username
    ]
    assert {row["meeting_type"] for row in selected_rows} == {
        "broadcast", "ppv", "subscribers-only",
    }
    assert len(payload["results"]) == 14


@pytest.mark.django_db
def test_discovery_uses_optimized_avatar_and_static_fallback(
    api_client, creator_factory,
):
    with_avatar = creator_factory()
    avatar = GenericFile.objects.create(
        owner=with_avatar,
        file="avatar.png",
        mime_type="image/png",
        access="public",
    )
    variant = ImageVariant.objects.create(
        parent=avatar,
        width=128,
        format="webp",
        file="avatar.webp",
    )
    with_avatar.avatar_image = avatar
    with_avatar.save(update_fields=["avatar_image"])
    legacy_only = creator_factory()
    legacy_avatar = GenericFile.objects.create(
        owner=legacy_only,
        file="legacy.png",
        mime_type="image/png",
        access="public",
    )
    Webp.objects.create(
        parent=legacy_avatar,
        file="legacy.webp",
    )
    legacy_only.avatar_image = legacy_avatar
    legacy_only.save(update_fields=["avatar_image"])
    without_avatar = creator_factory()
    missing_rendition = creator_factory()
    missing_avatar = GenericFile.objects.create(
        owner=missing_rendition,
        file="original-only.png",
        mime_type="image/png",
        access="public",
    )
    missing_rendition.avatar_image = missing_avatar
    missing_rendition.save(update_fields=["avatar_image"])
    _live_room(with_avatar, meeting_id="optimized-avatar")
    _live_room(legacy_only, meeting_id="legacy-avatar")
    _live_room(without_avatar, meeting_id="static-avatar-fallback")
    _live_room(missing_rendition, meeting_id="missing-rendition")

    with CaptureQueriesContext(connection) as queries:
        response = api_client.get(reverse("public-meeting-discovery"))

    assert response.status_code == 200
    rows = {row["username"]: row for row in response.json()["results"]}
    assert rows[with_avatar.username]["avatar"] == variant.get_url()
    assert rows[legacy_only.username]["avatar"] == legacy_avatar.webp.get_url()
    assert rows[without_avatar.username]["avatar"] == default_logo_url()
    assert rows[missing_rendition.username]["avatar"] == default_logo_url()
    assert len(queries) == 2, [query["sql"] for query in queries]
