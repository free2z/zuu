"""Arbitrary tags survive the editor's read/write round trip.

The new UI turned `tags` into a closed twenty-item picker. The backend never
stopped being an open `django-taggit` vocabulary, so the load-bearing question
is whether a tag the picker cannot render survives an edit that never touched
tags. These tests pin the API half of that answer: whatever the retrieve
serializer hands a client is exactly what the client can hand back, with no
vocabulary check in between.
"""

import uuid

import pytest

from dj.apps.g12f.models import zPage


def _page(creator, tags=()):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"article-{uuid.uuid4()}",
        title="Tagged article",
        content="Article body",
        is_published=True,
    )
    if tags:
        page.tags.add(*tags)
    return page


@pytest.mark.django_db
def test_detail_response_exposes_tags_outside_any_curated_list(
    api_client, creator_factory
):
    """The editor can only preserve what the read it hydrates from returns."""
    creator = creator_factory()
    page = _page(creator, ["ART", "zebra husbandry", "café-culture"])
    api_client.force_authenticate(user=creator)

    response = api_client.get(f"/api/zpage/{page.free2zaddr}/")

    assert response.status_code == 200
    assert set(response.data["tags"]) == {
        "ART",
        "zebra husbandry",
        "café-culture",
    }


@pytest.mark.django_db
def test_editor_style_put_preserves_unrecognized_tags(api_client, creator_factory):
    """Echoing the tags back verbatim is accepted — no closed vocabulary.

    This is the exact shape the editor sends: a full PUT whose `tags` came
    straight from the retrieve response. An unrelated field changes; the tags
    the UI could not name must come back unharmed.
    """
    creator = creator_factory()
    page = _page(creator, ["zebra husbandry", "ART"])
    api_client.force_authenticate(user=creator)

    detail = api_client.get(f"/api/zpage/{page.free2zaddr}/")
    assert detail.status_code == 200

    response = api_client.put(
        f"/api/zpage/{page.free2zaddr}/",
        {
            "title": "Tagged article, revised",
            "content": "Article body, revised",
            "description": "",
            "canonical_url": "",
            "tags": list(detail.data["tags"]),
            "vanity": page.vanity,
            "is_published": True,
            "is_subscriber_only": False,
        },
        format="json",
    )

    assert response.status_code == 200, response.data
    page.refresh_from_db()
    assert set(page.tags.names()) == {"zebra husbandry", "ART"}


@pytest.mark.django_db
def test_put_that_drops_a_tag_from_the_payload_deletes_it(
    api_client, creator_factory
):
    """The failure mode this issue is really about, stated as a fact.

    `tags` is authoritative on write: whatever the client sends replaces the
    set. A UI that can only round-trip its own twenty categories therefore
    deletes everything else the moment it saves — which is why the editor must
    carry unknown tags through untouched rather than rebuild the list from a
    picker's options.
    """
    creator = creator_factory()
    page = _page(creator, ["zebra husbandry", "ART"])
    api_client.force_authenticate(user=creator)

    response = api_client.put(
        f"/api/zpage/{page.free2zaddr}/",
        {
            "title": "Tagged article",
            "content": "Article body",
            "description": "",
            "canonical_url": "",
            # Only the tag the closed picker knows about.
            "tags": ["ART"],
            "vanity": page.vanity,
            "is_published": True,
            "is_subscriber_only": False,
        },
        format="json",
    )

    assert response.status_code == 200, response.data
    page.refresh_from_db()
    assert set(page.tags.names()) == {"ART"}


@pytest.mark.django_db
def test_arbitrary_tag_can_be_created_through_the_api(api_client, creator_factory):
    """Nothing server-side validates a tag against a vocabulary."""
    creator = creator_factory()
    page = _page(creator)
    api_client.force_authenticate(user=creator)

    response = api_client.put(
        f"/api/zpage/{page.free2zaddr}/",
        {
            "title": "Tagged article",
            "content": "Article body",
            "description": "",
            "canonical_url": "",
            "tags": ["quantum knitting", "ART"],
            "vanity": page.vanity,
            "is_published": True,
            "is_subscriber_only": False,
        },
        format="json",
    )

    assert response.status_code == 200, response.data
    page.refresh_from_db()
    assert set(page.tags.names()) == {"quantum knitting", "ART"}


@pytest.mark.django_db
def test_tags_filter_finds_a_page_by_an_arbitrary_tag(api_client, creator_factory):
    """`?tags=` already backs the "tags lead somewhere useful" requirement."""
    creator = creator_factory()
    page = _page(creator, ["zebra husbandry"])
    _page(creator, ["ART"])

    response = api_client.get("/api/zpage/?tags=zebra husbandry")

    assert response.status_code == 200
    returned = {item["free2zaddr"] for item in response.data["results"]}
    assert returned == {page.free2zaddr}


@pytest.mark.django_db
def test_autocomplete_orders_ties_deterministically(api_client, creator_factory):
    """`-count` alone is not a total order, and the slice makes that matter.

    Every long-tail tag has count 1. Ordering by count and then taking
    `[:num_results]` lets PostgreSQL return any of the tied rows, so two
    identical requests could disagree about which tags a creator is allowed to
    filter by. `name` is the tiebreak that makes the answer stable.
    """
    creator = creator_factory()
    _page(creator, ["delta", "alpha", "charlie", "bravo"])

    first = api_client.get(
        "/api/tagging/autocomplete?type=zpage&num_results=2"
    )
    second = api_client.get(
        "/api/tagging/autocomplete?type=zpage&num_results=2"
    )

    assert first.status_code == 200
    names = [row["name"] for row in first.json()]
    assert names == ["alpha", "bravo"]
    assert [row["name"] for row in second.json()] == names
