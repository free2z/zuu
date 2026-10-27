"""Smoke tests for the events API against real Postgres.

Event types are chosen so their message templates don't need a
content_object (PAGE_VOTE etc. would 500 without one).
"""
import uuid
from datetime import timedelta

import pytest

from dj.apps.events.models import Event
from dj.apps.g12f.models import zPage
from dj.apps.g12f.models import Subscription
from django.utils import timezone


def _types(response):
    data = response.json()
    items = data["results"] if isinstance(data, dict) else data
    return sorted(item["type"] for item in items)


@pytest.mark.django_db
def test_events_list_requires_auth(api_client):
    response = api_client.get("/api/events/")
    assert response.status_code in (401, 403)


@pytest.mark.django_db
def test_social_filter_includes_purchase_updates_but_excludes_fees(
        api_client, creator_factory):
    user = creator_factory()
    other = creator_factory()
    Event.objects.create(
        type="DONATION_RECEIVED", amount=5,
        receiving_user=user, contributor=other,
    )
    Event.objects.create(type="BOUGHT_TUZI", amount=10, receiving_user=user)
    Event.objects.create(type="ZEC_PENDING", amount=10, receiving_user=user)
    Event.objects.create(type="PLATFORM_FEE", amount=1, receiving_user=user)
    Event.objects.create(type="CHAT2Z", amount=2, receiving_user=user)

    api_client.force_authenticate(user=user)

    response = api_client.get("/api/events/")
    assert response.status_code == 200
    assert _types(response) == [
        "BOUGHT_TUZI", "CHAT2Z", "DONATION_RECEIVED", "PLATFORM_FEE",
        "ZEC_PENDING",
    ]

    response = api_client.get("/api/events/", {"type": "social"})
    assert response.status_code == 200
    assert _types(response) == [
        "BOUGHT_TUZI", "DONATION_RECEIVED", "ZEC_PENDING",
    ]

    page = zPage.objects.create(
        creator=other,
        free2zaddr=str(uuid.uuid4()),
        title="mentioned page",
        content="body",
        is_published=True,
    )
    Event.objects.create(
        type="PAGE_MENTION", receiving_user=user,
        contributor=other, content_object=page,
    )
    response = api_client.get("/api/events/", {"type": "social"})
    assert response.status_code == 200
    assert "PAGE_MENTION" in _types(response)


@pytest.mark.django_db
def test_social_filter_excludes_subscription_renewals(
    api_client, creator_factory,
):
    user = creator_factory()
    fan = creator_factory()
    Event.objects.create(
        type="SUBSCRIPTION_RECEIVED", amount=10,
        receiving_user=user, contributor=fan,
    )

    api_client.force_authenticate(user=user)
    response = api_client.get("/api/events/", {"type": "social"})
    assert response.status_code == 200
    assert "SUBSCRIPTION_RECEIVED" not in _types(response)


@pytest.mark.django_db
def test_inactive_content_is_not_serialized_in_event_listing(
    api_client, creator_factory,
):
    creator = creator_factory()
    recipient = creator_factory()
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity="event-page",
        title="inactive event title",
        content="inactive event body",
        is_published=True,
    )
    Event.objects.create(
        type="PAGE_UPDATE",
        receiving_user=recipient,
        contributor=creator,
        content_object=page,
    )
    creator.is_active = False
    creator.save(update_fields=["is_active"])

    api_client.force_authenticate(user=recipient)
    response = api_client.get("/api/events/")

    assert response.status_code == 200
    event = response.json()["results"][0]
    assert event["content_title"] is None
    assert event["content_url"] is None
    assert "inactive event title" not in event["message"]


@pytest.mark.django_db
@pytest.mark.parametrize("event_type", ["PAGE_UPDATE", "PAGE_VOTE"])
def test_unpublished_page_event_details_are_hidden_but_creator_can_preview(
    api_client, creator_factory, event_type,
):
    creator = creator_factory()
    recipient = creator_factory()
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity="draft-event-page",
        title="draft-only event title",
        content="draft-only event body",
        is_published=False,
    )
    Event.objects.create(
        type=event_type,
        amount=1,
        receiving_user=recipient,
        contributor=creator,
        content_object=page,
    )

    api_client.force_authenticate(user=recipient)
    hidden = api_client.get("/api/events/").json()["results"][0]
    assert hidden["content_title"] is None
    assert hidden["content_url"] is None
    assert hidden["content_available"] is False
    assert "draft-only event title" not in hidden["message"]

    # The event remains scoped to its recipient; the creator's authorized
    # draft flow continues through the explicit owner-read API.
    api_client.force_authenticate(user=creator)
    own_page = api_client.get(
        f"/api/zpage/{page.free2zaddr}/?mine=true")
    assert own_page.status_code == 200
    assert own_page.json()["title"] == "draft-only event title"


@pytest.mark.django_db
@pytest.mark.parametrize("event_type", ["PAGE_UPDATE", "PAGE_VOTE"])
def test_deleted_page_event_details_are_unavailable_and_objectless_events_survive(
    api_client, creator_factory, event_type,
):
    author = creator_factory()
    recipient = creator_factory()
    page = zPage.objects.create(
        creator=author,
        free2zaddr=str(uuid.uuid4()),
        title="deleted page title",
        content="deleted page body",
        is_published=True,
    )
    event = Event.objects.create(
        type=event_type,
        amount=1,
        receiving_user=recipient,
        contributor=author,
        content_object=page,
    )
    api_client.force_authenticate(user=recipient)

    visible = api_client.get("/api/events/").json()["results"][0]
    assert visible["content_available"] is True
    assert visible["content_title"] == "deleted page title"
    assert "deleted page title" in visible["message"]

    page.delete()
    event.refresh_from_db()
    deleted = api_client.get("/api/events/").json()["results"][0]
    assert deleted["content_available"] is False
    assert deleted["content_title"] is None
    assert deleted["content_url"] is None
    assert deleted["message"] == "This content is no longer available."
    assert event.to_dict()["message"] == deleted["message"]

    # A missing GenericForeignKey is normal for unrelated events. Their
    # existing availability and message semantics must remain intact.
    donation = Event.objects.create(
        type="DONATION_RECEIVED",
        amount=1,
        receiving_user=recipient,
    )
    donation_data = donation.to_dict()
    assert donation_data["content_available"] is True
    assert donation_data["content_title"] is None
    assert donation_data["content_url"] is None
    assert donation_data["message"] == "You received 1 tuzi from Anonymous"


@pytest.mark.django_db
def test_page_owner_still_sees_own_unpublished_page_in_vote_notification(
    api_client, creator_factory,
):
    """PAGE_VOTE goes to the page OWNER. Unpublishing their own page must not
    redact it from them -- the reader already owns the draft."""
    owner = creator_factory()
    voter = creator_factory()
    page = zPage.objects.create(
        creator=owner,
        free2zaddr=str(uuid.uuid4()),
        vanity="owner-unpublished-vote",
        title="owner's own unpublished title",
        content="body",
        is_published=False,
    )
    Event.objects.create(
        type="PAGE_VOTE",
        amount=1,
        receiving_user=owner,
        contributor=voter,
        content_object=page,
    )
    api_client.force_authenticate(user=owner)
    event = api_client.get("/api/events/").json()["results"][0]
    assert event["content_available"] is True
    assert event["content_title"] == "owner's own unpublished title"
    assert event["content_url"] is not None
    assert "no longer available" not in event["message"]


@pytest.mark.django_db
def test_page_notification_respects_current_subscriber_access(
    api_client, creator_factory,
):
    creator = creator_factory()
    fan = creator_factory()
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="subscriber event title",
        content="subscriber event body",
        is_published=True,
        is_subscriber_only=True,
    )
    Event.objects.create(
        type="PAGE_UPDATE",
        receiving_user=fan,
        contributor=creator,
        content_object=page,
    )

    api_client.force_authenticate(user=fan)
    hidden = api_client.get("/api/events/").json()["results"][0]
    assert hidden["content_title"] is None
    assert hidden["content_url"] is None
    assert hidden["content_available"] is False

    Subscription.objects.create(
        star=creator,
        fan=fan,
        expires=timezone.now() + timedelta(days=1),
    )
    visible = api_client.get("/api/events/").json()["results"][0]
    assert visible["content_title"] == "subscriber event title"
    assert visible["content_url"] is not None
    assert visible["content_available"] is True


@pytest.mark.django_db
def test_event_zpage_url_escapes_a_reserved_creator_namespace(
    api_client, creator_factory,
):
    creator = creator_factory(username="api")
    recipient = creator_factory()
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity="event-page",
        title="collision-safe event title",
        content="collision-safe event body",
        is_published=True,
    )
    Event.objects.create(
        type="PAGE_UPDATE",
        receiving_user=recipient,
        contributor=creator,
        content_object=page,
    )

    api_client.force_authenticate(user=recipient)
    legacy_response = api_client.get("/api/events/")
    response = api_client.get(
        "/api/events/",
        HTTP_X_FREE2Z_CANONICAL_CONTENT_URL="1",
    )

    assert legacy_response.status_code == 200
    assert response.status_code == 200
    assert "X-Free2Z-Canonical-Content-URL" in legacy_response["Vary"]
    assert "X-Free2Z-Canonical-Content-URL" in response["Vary"]
    legacy_event = legacy_response.json()["results"][0]
    event = response.json()["results"][0]
    assert legacy_event["content_url"] == page.get_url()
    assert event["content_url"] == f"/article/{page.free2zaddr}"
    assert event["content_url"] == page.get_public_url()
    assert event["content_url"] != page.get_url()


@pytest.mark.django_db
def test_mark_event_as_read(api_client, creator_factory):
    user = creator_factory()
    event = Event.objects.create(
        type="BOUGHT_TUZI", amount=5, receiving_user=user,
    )
    assert event.read is False

    api_client.force_authenticate(user=user)
    response = api_client.post(f"/api/events/read/{event.id}/")
    assert response.status_code == 200

    event.refresh_from_db()
    assert event.read is True


@pytest.mark.django_db
def test_cannot_mark_other_users_event_as_read(api_client, creator_factory):
    owner = creator_factory()
    stranger = creator_factory()
    event = Event.objects.create(
        type="BOUGHT_TUZI", amount=5, receiving_user=owner,
    )

    api_client.force_authenticate(user=stranger)
    response = api_client.post(f"/api/events/read/{event.id}/")
    assert response.status_code == 404

    event.refresh_from_db()
    assert event.read is False
