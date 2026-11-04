"""Tests for the per-publish-state totals on the zpage list endpoint.

The creator-profile Published/Drafts tab badges must show the TRUE totals
across every page, not just the rows that happen to land on the current
paginated page. The list response therefore carries ``published_count`` /
``draft_count`` aggregated over the whole filtered queryset. These tests use
real Postgres (never a mocked DB) and deliberately create more published and
more draft pages than a single page can hold, then assert the counts equal the
true totals rather than the page size.
"""
import uuid

import pytest
from django.test import override_settings

from dj.apps.g12f.models import zPage, ZPageTranslation


def _make_page(creator, vanity, *, published):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity,
        title=f"Title {vanity}",
        content="Some content about a topic.",
        is_published=published,
    )


@pytest.mark.django_db
def test_owner_counts_reflect_true_totals_not_page(api_client, creator_factory):
    author = creator_factory()
    # More of each than one small page holds.
    published_total = 15
    draft_total = 13
    for i in range(published_total):
        _make_page(author, f"pub-{i}", published=True)
    for i in range(draft_total):
        _make_page(author, f"draft-{i}", published=False)

    api_client.force_authenticate(user=author)
    # page_size=6 mirrors the profile loader — small enough that a single page
    # can never contain the true totals.
    response = api_client.get("/api/zpage/?mine=true&page=1&page_size=6")

    assert response.status_code == 200
    body = response.json()
    # Only one page worth of rows is returned...
    assert len(body["results"]) == 6
    #...but the counts are the full totals, independent of pagination.
    assert body["published_count"] == published_total
    assert body["draft_count"] == draft_total
    # count is the combined paginated total (published + drafts).
    assert body["count"] == published_total + draft_total


@pytest.mark.django_db
def test_owner_counts_stable_across_pages(api_client, creator_factory):
    author = creator_factory()
    for i in range(15):
        _make_page(author, f"pub-{i}", published=True)
    for i in range(13):
        _make_page(author, f"draft-{i}", published=False)

    api_client.force_authenticate(user=author)
    page1 = api_client.get("/api/zpage/?mine=true&page=1&page_size=6").json()
    # A later page whose rows differ entirely from page 1.
    page3 = api_client.get("/api/zpage/?mine=true&page=3&page_size=6").json()

    # The bug: badges read the page's row split, so they changed per page.
    # The fix: the totals are identical on every page.
    assert page1["published_count"] == page3["published_count"] == 15
    assert page1["draft_count"] == page3["draft_count"] == 13


@pytest.mark.django_db
def test_public_listing_has_no_counts_and_no_drafts(api_client, creator_factory):
    """The per-state counts are owner-only (?mine=true) to keep the extra
    aggregate off the high-traffic public/homepage/search paths. Public
    listings therefore omit the fields entirely — and never leak drafts."""
    author = creator_factory()
    for i in range(9):
        _make_page(author, f"pub-{i}", published=True)
    for i in range(4):
        _make_page(author, f"draft-{i}", published=False)

    response = api_client.get(
        f"/api/zpage/?username={author.username}&page_size=6"
    )

    assert response.status_code == 200
    body = response.json()
    # Owner-only fields are absent on the public path...
    assert "published_count" not in body
    assert "draft_count" not in body
    #...and drafts are neither counted nor leaked into results.
    assert body["count"] == 9


@pytest.mark.django_db
def test_owner_public_profile_uses_published_count_and_full_pages(
    api_client, creator_factory,
):
    author = creator_factory()
    for i in range(7):
        _make_page(author, f"public-{i}", published=True)
    for i in range(4):
        _make_page(author, f"private-{i}", published=False)

    api_client.force_authenticate(user=author)
    response = api_client.get(
        f"/api/zpage/?username={author.username}&page_size=6"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 7
    assert len(body["results"]) == 6
    assert all(row["is_published"] for row in body["results"])
    assert all(
        row["vanity"].startswith("public-") for row in body["results"]
    )

    profile = api_client.get(f"/api/creator/{author.username}/")
    assert profile.status_code == 200
    assert profile.json()["zpages"] == 7


@pytest.mark.django_db
def test_owner_public_paid_excerpt_stays_public_redacted(
    api_client, creator_factory
):
    author = creator_factory()
    page = _make_page(author, "paid-excerpt", published=True)
    page.is_subscriber_only = True
    page.description = "The private summary"
    page.content = "The private body"
    page.save(update_fields=["is_subscriber_only", "description", "content"])
    api_client.force_authenticate(user=author)

    public = api_client.get(
        f"/api/zpage/?username={author.username}&page_size=6"
    )
    private = api_client.get(
        f"/api/zpage/?username={author.username}&mine=true&page_size=6"
    )

    assert public.status_code == private.status_code == 200
    assert public.json()["results"][0]["content"] == (
        "Subscribe for exclusive content"
    )
    assert private.json()["results"][0]["content"] == "The private summary"


@pytest.mark.django_db
def test_false_mine_flag_cannot_opt_into_drafts(api_client, creator_factory):
    author = creator_factory()
    _make_page(author, "published", published=True)
    _make_page(author, "draft", published=False)
    api_client.force_authenticate(user=author)

    response = api_client.get(
        f"/api/zpage/?username={author.username}&mine=false"
    )

    assert response.status_code == 200
    assert response.json()["count"] == 1
    assert [row["vanity"] for row in response.json()["results"]] == [
        "published"
    ]


@pytest.mark.django_db
@pytest.mark.parametrize("variant_reads", [False, True])
def test_owner_public_list_does_not_render_draft_translation(
    api_client, creator_factory, variant_reads,
):
    author = creator_factory()
    page = _make_page(author, "translated", published=True)
    page.source_language = "en"
    page.save(update_fields=["source_language"])
    ZPageTranslation.objects.create(
        zpage=page,
        language="es",
        title="Draft Spanish title",
        description="Draft Spanish description",
        content="Draft Spanish content",
        is_published=False,
    )
    api_client.force_authenticate(user=author)

    with override_settings(ZPAGE_VARIANT_READS=variant_reads):
        public = api_client.get(
            f"/api/zpage/?username={author.username}&lang=es"
        )
        private = api_client.get(
            f"/api/zpage/?username={author.username}&lang=es&mine=true"
        )

    assert public.status_code == 200
    assert private.status_code == 200
    public_row = public.json()["results"][0]
    private_row = private.json()["results"][0]
    assert public_row["title"] == page.title
    assert public_row["actual_language"] == "en"
    assert public_row["variant_is_published"] is True
    assert private_row["title"] == "Draft Spanish title"
    assert private_row["actual_language"] == "es"
    assert private_row["variant_is_published"] is False


@pytest.mark.django_db
def test_counts_present_on_empty_listing(api_client, creator_factory):
    author = creator_factory()
    api_client.force_authenticate(user=author)
    body = api_client.get("/api/zpage/?mine=true").json()

    assert body["published_count"] == 0
    assert body["draft_count"] == 0
