"""API invariants for scheduled zPage publishing."""

import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from dj.apps.g12f.models import zPage
from dj.apps.g12f.serializers.zpage import zPageUpdateSerializer
from dj.apps.g12f.tasks import publish_zpage


def _make_page(creator, **overrides):
    values = {
        "creator": creator,
        "free2zaddr": str(uuid.uuid4()),
        "vanity": "scheduled-article",
        "title": "Scheduled article",
        "content": "Article content.",
        "is_published": False,
    }
    values.update(overrides)
    return zPage.objects.create(**values)


@pytest.mark.django_db
def test_schedule_requires_a_future_time(creator_factory):
    page = _make_page(creator_factory())
    serializer = zPageUpdateSerializer(
        instance=page,
        data={
            "is_published": False,
            "publish_at": timezone.now() - timedelta(minutes=1),
        },
        partial=True,
    )

    assert not serializer.is_valid()
    assert "publish_at" in serializer.errors


@pytest.mark.django_db
def test_immediate_publish_clears_a_pending_schedule(creator_factory):
    scheduled_for = timezone.now() + timedelta(hours=2)
    page = _make_page(creator_factory(), publish_at=scheduled_for)
    serializer = zPageUpdateSerializer(
        instance=page,
        data={
            "is_published": True,
            # A stale client can send the old schedule with its publish-now
            # action; the publication state must still win.
            "publish_at": scheduled_for,
        },
        partial=True,
    )

    assert serializer.is_valid(), serializer.errors
    serializer.save()

    page.refresh_from_db()
    assert page.is_published is True
    assert page.publish_at is None


@pytest.mark.django_db
def test_scheduled_pages_are_owner_visible_but_not_public(
    api_client, creator_factory,
):
    creator = creator_factory()
    page = _make_page(
        creator,
        vanity="future-publication",
        publish_at=timezone.now() + timedelta(hours=2),
    )

    api_client.force_authenticate(user=creator)
    owner_response = api_client.get("/api/zpage/?mine=true")

    assert owner_response.status_code == 200
    owner_page = next(
        item for item in owner_response.json()["results"]
        if item["free2zaddr"] == page.free2zaddr
    )
    assert owner_page["is_published"] is False
    assert owner_page["publish_at"] is not None

    api_client.force_authenticate(user=None)
    public_response = api_client.get(
        f"/api/zpage/?username={creator.username}"
    )

    assert public_response.status_code == 200
    assert all(
        item["free2zaddr"] != page.free2zaddr
        for item in public_response.json()["results"]
    )


@pytest.mark.django_db
def test_scheduling_a_vanityless_non_latin_draft_assigns_its_public_vanity(
    api_client, creator_factory,
):
    creator = creator_factory()
    page = _make_page(
        creator,
        vanity="",
        title="Untitled",
    )
    api_client.force_authenticate(user=creator)
    scheduled_for = timezone.now() + timedelta(hours=2)

    response = api_client.put(
        f"/api/zpage/{page.free2zaddr}/",
        {
            "title": "한국어 요약",
            "content": "Article content.",
            "is_published": False,
            "publish_at": scheduled_for.isoformat(),
            "tags": [],
            "vanity": "",
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    vanity = response.data["vanity"]
    assert vanity.startswith("p-")
    assert vanity[2:] in page.free2zaddr.replace("-", "")
    assert response.data["is_published"] is False

    # Exercise the same scheduled task after its due time. It publishes the
    # row with the vanity already persisted by the scheduling save.
    zPage.objects.filter(pk=page.pk).update(
        publish_at=timezone.now() - timedelta(seconds=1),
    )
    assert publish_zpage(zpage_id=page.pk) is True

    page.refresh_from_db()
    assert page.is_published is True
    assert page.vanity == vanity
