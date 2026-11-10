"""Regression tests for tagging autocomplete input handling.

``num_results`` is used as a queryset slice bound. It arrives from the query
string as a string, and ``queryset[:'5']`` raises TypeError -> 500. This public
endpoint must coerce and bound it instead.
"""
import uuid

import pytest

from dj.apps.g12f.models import zPage
from dj.apps.uploads.models import GenericFile


def _page(creator, tags, *, published=True, title="Tag autocomplete fixture",
          category="general", featured_image=None, subscriber_only=False):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"tag-autocomplete-{uuid.uuid4()}",
        title=title,
        content="Fixture content",
        is_published=published,
        category=category,
        featured_image=featured_image,
        is_subscriber_only=subscriber_only,
    )
    page.tags.add(*tags)
    return page


@pytest.mark.django_db
def test_num_results_string_does_not_500(api_client):
    response = api_client.get("/api/tagging/autocomplete?num_results=5")
    assert response.status_code == 200, response.content


@pytest.mark.django_db
def test_num_results_garbage_falls_back(api_client):
    response = api_client.get("/api/tagging/autocomplete?num_results=notanumber")
    assert response.status_code == 200, response.content


@pytest.mark.django_db
def test_num_results_huge_value_is_bounded(api_client):
    # A caller must not be able to request an unbounded public scan.
    response = api_client.get("/api/tagging/autocomplete?num_results=100000000")
    assert response.status_code == 200, response.content
    assert len(response.json()) <= 100


@pytest.mark.django_db
def test_zpage_facets_intersect_selected_tags_across_full_corpus(
    api_client, creator_factory
):
    creator = creator_factory()
    for index in range(27):
        _page(creator, ["facet-selected", f"facet-common-{index % 2}"])
    _page(creator, ["facet-unrelated"])

    response = api_client.get(
        "/api/tagging/autocomplete",
        {"type": "zpage", "article_facets": "true",
         "selected_tags": "facet-selected",
         "num_results": "100"},
    )

    assert response.status_code == 200, response.content
    rows = {row["name"]: row["count"] for row in response.json()}
    assert rows == {"facet-common-0": 14, "facet-common-1": 13}


@pytest.mark.django_db
def test_zpage_facets_apply_search_and_feed_scope(api_client, creator_factory):
    creator = creator_factory()
    matching = _page(creator, ["facet-search-match", "facet-selected"],
                     title="needle unique result", category="general")
    _page(creator, ["facet-search-other", "facet-selected"],
          title="other result", category="general")
    _page(creator, ["facet-category-hidden", "facet-selected"],
          title="needle other result", category="arts")

    listing = api_client.get(
        "/api/zpage/", {"search": "needle unique", "category": "general"},
    )
    response = api_client.get(
        "/api/tagging/autocomplete",
        {"type": "zpage", "article_facets": "true",
         "selected_tags": "facet-selected",
         "search": "needle unique", "category": "general"},
    )

    assert response.status_code == 200, response.content
    assert listing.status_code == 200, listing.content
    assert listing.data["count"] == 1
    listed_ids = {row["free2zaddr"] for row in listing.data["results"]}
    assert listed_ids == {matching.free2zaddr}
    assert response.json()[0]["name"] == "facet-search-match"
    assert response.json()[0]["count"] == 1


@pytest.mark.django_db
def test_article_facets_match_home_sort_listing_ids(api_client, creator_factory):
    creator = creator_factory()
    featured = GenericFile.objects.create(
        owner=creator, title="Facet image", file="facet-image.png",
        mime_type="image/png",
    )
    visible = _page(creator, ["facet-selected", "facet-visible"],
                    title="visible article")
    visible.featured_image = featured
    visible.save(update_fields=["featured_image"])
    _page(creator, ["facet-selected", "facet-without-image"],
          title="unfeatured article")

    params = {"homeSort": "popular", "tags": "facet-selected"}
    listing = api_client.get("/api/zpage/", params)
    facets = api_client.get(
        "/api/tagging/autocomplete",
        {"type": "zpage", "article_facets": "true",
         "homeSort": "popular", "selected_tags": "facet-selected",
         "num_results": 100},
    )

    assert listing.status_code == facets.status_code == 200
    listed_ids = {row["free2zaddr"] for row in listing.data["results"]}
    assert listed_ids == {visible.free2zaddr}
    rows = {row["name"]: row["count"] for row in facets.json()}
    assert rows["facet-visible"] == 1
    assert "facet-without-image" not in rows


@pytest.mark.django_db
def test_article_facets_match_semantic_search_listing(api_client, creator_factory,
                                                     mocker, monkeypatch):
    from django.contrib.contenttypes.models import ContentType
    from dj.apps.search.models import SearchIndex

    creator = creator_factory()
    matching = _page(creator, ["semantic-selected", "semantic-match"],
                     title="Matching indexed page")
    nonmatching = _page(creator, ["semantic-selected", "semantic-other"],
                        title="Distant indexed page")
    content_type = ContentType.objects.get_for_model(zPage)
    SearchIndex.objects.create(
        content_type=content_type, object_id=matching.pk,
        vector=[1.0] + [0.0] * 1535,
    )
    SearchIndex.objects.create(
        content_type=content_type, object_id=nonmatching.pk,
        vector=[-1.0] + [0.0] * 1535,
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    mocker.patch(
        "dj.apps.search.drf_filters.cached_query_embedding",
        return_value=[1.0] + [0.0] * 1535,
    )

    listing = api_client.get(
        "/api/zpage/", {"search": "same semantic query",
                        "tags": "semantic-selected"},
    )
    facets = api_client.get(
        "/api/tagging/autocomplete",
        {"type": "zpage", "article_facets": "true",
         "search": "same semantic query",
         "selected_tags": "semantic-selected", "num_results": 100},
    )

    assert listing.status_code == facets.status_code == 200
    assert {row["free2zaddr"] for row in listing.data["results"]} == {
        matching.free2zaddr,
    }
    assert {row["name"]: row["count"] for row in facets.json()} == {
        "semantic-match": 1,
    }


@pytest.mark.django_db
def test_public_facets_exclude_member_only_pages(api_client, creator_factory):
    creator = creator_factory()
    passworded = _page(creator, ["facet-public-tag"])
    passworded.password = "pbkdf2_sha256$test$not-a-reader-gate"
    passworded.save(update_fields=["password"])
    _page(creator, ["facet-private-member-tag"], subscriber_only=True)

    response = api_client.get(
        "/api/tagging/autocomplete?type=zpage&article_facets=true&num_results=100"
    )

    assert response.status_code == 200, response.content
    names = {row["name"] for row in response.json()}
    assert "facet-public-tag" in names
    assert "facet-private-member-tag" not in names
    listed = api_client.get("/api/zpage/?tags=facet-public-tag")
    assert listed.status_code == 200
    assert [row["free2zaddr"] for row in listed.data["results"]] == [
        passworded.free2zaddr,
    ]

    # Existing editor autocomplete keeps its documented vocabulary.
    legacy = api_client.get(
        "/api/tagging/autocomplete?type=zpage&query=facet-private-member-tag"
    )
    assert [row["name"] for row in legacy.json()] == [
        "facet-private-member-tag"
    ]


@pytest.mark.django_db
def test_default_still_works(api_client):
    response = api_client.get("/api/tagging/autocomplete")
    assert response.status_code == 200, response.content


@pytest.mark.django_db
def test_mine_returns_the_authenticated_owners_draft_tags(
    api_client, creator_factory
):
    owner = creator_factory()
    _page(owner, ["draft-only-owner-tag"], published=False)

    api_client.force_authenticate(user=owner)
    response = api_client.get(
        "/api/tagging/autocomplete"
        f"?type=zpage&username={owner.username}&mine=true"
        "&query=draft-only-owner-tag"
    )

    assert response.status_code == 200, response.content
    assert response.json() == [
        {"name": "draft-only-owner-tag", "count": 1, "level": "narrow"}
    ]


@pytest.mark.django_db
def test_anonymous_mine_is_refused(api_client, creator_factory):
    owner = creator_factory()
    _page(owner, ["private-draft-tag"], published=False)

    response = api_client.get(
        f"/api/tagging/autocomplete?type=zpage&username={owner.username}&mine=true"
    )

    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_mine_requires_zpage_type(api_client, creator_factory):
    owner = creator_factory()
    _page(owner, ["unscoped-draft-tag"], published=False)

    api_client.force_authenticate(user=owner)
    response = api_client.get("/api/tagging/autocomplete?mine=true")

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_public_scope_does_not_expose_a_draft_only_tag(
    api_client, creator_factory
):
    owner = creator_factory()
    _page(owner, ["draft-only-public-hidden"], published=False)

    response = api_client.get(
        f"/api/tagging/autocomplete?type=zpage&username={owner.username}"
        "&query=draft-only-public-hidden"
    )

    assert response.status_code == 200, response.content
    assert response.json() == []


@pytest.mark.django_db
def test_mine_username_mismatch_returns_no_owner_tags(
    api_client, creator_factory
):
    owner = creator_factory()
    other = creator_factory()
    _page(owner, ["owner-private-tag"], published=False)
    _page(other, ["other-private-tag"], published=False)

    api_client.force_authenticate(user=owner)
    unscoped_response = api_client.get(
        "/api/tagging/autocomplete"
        "?type=zpage&mine=true&query=other-private-tag"
    )

    assert unscoped_response.status_code == 200, unscoped_response.content
    assert unscoped_response.json() == []

    response = api_client.get(
        f"/api/tagging/autocomplete?type=zpage&username={other.username}&mine=true"
    )

    assert response.status_code == 200, response.content
    assert response.json() == []


@pytest.mark.django_db
def test_selected_tags_use_the_same_owner_and_public_visibility_scope(
    api_client, creator_factory
):
    owner = creator_factory()
    _page(
        owner,
        ["owner-draft-companion", "owner-selected"],
        published=False,
    )
    _page(owner, ["owner-public-companion", "owner-selected"], published=True)

    owner_query = (
        "/api/tagging/autocomplete"
        f"?type=zpage&username={owner.username}&mine=true"
        "&selected_tags=owner-selected&query=owner-draft-companion"
    )
    api_client.force_authenticate(user=owner)
    owner_response = api_client.get(owner_query)

    assert owner_response.status_code == 200, owner_response.content
    assert [row["name"] for row in owner_response.json()] == [
        "owner-draft-companion"
    ]
    assert owner_response.json()[0]["count"] == 1

    api_client.force_authenticate(user=None)
    public_response = api_client.get(
        "/api/tagging/autocomplete"
        f"?type=zpage&username={owner.username}"
        "&selected_tags=owner-selected&query=owner-draft-companion"
    )

    assert public_response.status_code == 200, public_response.content
    assert public_response.json() == []


# --------------------------------------------------------------------------
# The UNTYPED corpus . The SvelteKit callers all pass
# `type=zpage`; the classic editor's category control does NOT, which is why
# the narrowing behaviour below is preserved exactly. This branch counted
# `taggit_taggeditem_items` with no visibility filter at all, so a tag used
# solely on a DRAFT or on a DEACTIVATED creator's page still appeared here,
# on an AllowAny endpoint, with a non-zero count. Tag names are author-written
# free text, so that is a real disclosure. 's property is that
# deactivation takes a creator's zPages off EVERY read path; this was one.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_untyped_counts_omit_a_deactivated_creators_page(
    api_client, creator_factory
):
    creator = creator_factory()
    _page(creator, ["untyped-deactivation-tag"])

    listed = api_client.get(
        "/api/tagging/autocomplete?query=untyped-deactivation-tag"
    ).json()
    assert [row["name"] for row in listed] == ["untyped-deactivation-tag"]

    creator.is_active = False
    creator.save(update_fields=["is_active"])

    after = api_client.get(
        "/api/tagging/autocomplete?query=untyped-deactivation-tag"
    )
    assert after.status_code == 200, after.content
    assert after.json() == []


@pytest.mark.django_db
def test_untyped_counts_omit_a_draft_only_tag(api_client, creator_factory):
    creator = creator_factory()
    _page(creator, ["untyped-draft-only-tag"], published=False)

    response = api_client.get(
        "/api/tagging/autocomplete?query=untyped-draft-only-tag"
    )
    assert response.status_code == 200, response.content
    assert response.json() == []


@pytest.mark.django_db
def test_untyped_counts_span_both_visible_corpora(
    api_client, creator_factory
):
    """Positive control: omitting `type` still means "everything visible"."""
    from dj.apps.comments.models import Comment

    creator = creator_factory()
    _page(creator, ["untyped-union-tag"])
    post = Comment.objects.create(
        author=creator, headline="Union", content="Union post",
    )
    post.tags.add("untyped-union-tag")

    rows = api_client.get(
        "/api/tagging/autocomplete?query=untyped-union-tag"
    ).json()
    assert rows and rows[0]["name"] == "untyped-union-tag"
    assert rows[0]["count"] == 2, rows


@pytest.mark.django_db
def test_unknown_type_is_a_400_not_a_500(api_client):
    """`?type=bogus` annotated no `count`, and `count__gt=0` then raised
    FieldError -- a 500 from an unauthenticated query parameter."""
    response = api_client.get("/api/tagging/autocomplete?type=bogus")
    assert response.status_code == 400, response.content
    assert "type" in response.json()["detail"]


@pytest.mark.django_db
def test_untyped_counts_do_not_join_both_corpora_in_one_query(
    api_client, creator_factory
):
    """Query SHAPE, because the arithmetic tests cannot see the cost.

    Annotating two `Count(..., distinct=True)` over two different reverse
    relations of `Tag` in one queryset makes PostgreSQL build the cross
    product of each tag's zPages and its comments before DISTINCT collapses
    it -- a tag on 3,000 pages and 20,000 comments is ~60M intermediate rows.
    This endpoint is public and deliberately un-throttled, so that is a
    handful of anonymous requests away from saturating the database, and a
    fixture with one page and one comment produces identical output either
    way. Correlated subqueries hang off the SELECT list, never off
    `taggit_tag`, so the outer query joins nothing. Raised by the codex
    adversarial review.
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    from dj.apps.comments.models import Comment

    creator = creator_factory()
    _page(creator, ["untyped-shape-tag"])
    post = Comment.objects.create(
        author=creator, headline="Shape", content="Shape post",
    )
    post.tags.add("untyped-shape-tag")

    with CaptureQueriesContext(connection) as captured:
        response = api_client.get(
            "/api/tagging/autocomplete?query=untyped-shape-tag"
        )
    assert response.status_code == 200, response.content

    tag_queries = [
        q["sql"] for q in captured.captured_queries
        if 'FROM "taggit_tag"' in q["sql"]
    ]
    assert tag_queries, [q["sql"] for q in captured.captured_queries]
    for sql in tag_queries:
        assert 'FROM "taggit_tag" LEFT OUTER JOIN' not in sql, sql
        assert 'FROM "taggit_tag" INNER JOIN' not in sql, sql


@pytest.mark.django_db
def test_untyped_selected_tags_still_suggest_while_editing_a_draft(
    api_client, creator_factory
):
    """The classic editor's category control, pinned.

    `ts/react/free2z/src/components/TagFilterMultiSelect.tsx` sends
    `type=` EMPTY together with the page's current tags, and
    `EditPage.tsx` uses it with no `type` prop -- classic is still the
    default UI for signed-in users. Narrowing the untyped corpus by
    `selected_tags` under public visibility returns nothing at all while a
    creator edits a DRAFT, and that MUI Autocomplete is not `freeSolo`, so
    they could no longer add a category. The untyped branch has never
    narrowed; only the visibility scoping is new. Caught by the codex
    adversarial review.
    """
    owner = creator_factory()
    _page(owner, ["untyped-draft-tag", "untyped-shared-tag"], published=False)
    # Something publicly visible, so there is a real vocabulary to suggest.
    other = creator_factory()
    _page(other, ["untyped-suggestable-tag"])
    api_client.force_authenticate(user=owner)

    response = api_client.get(
        "/api/tagging/autocomplete",
        {"type": "", "selected_tags": "untyped-draft-tag,untyped-shared-tag",
         "query": "untyped-"},
    )

    assert response.status_code == 200, response.content
    names = [row["name"] for row in response.json()]
    assert "untyped-suggestable-tag" in names, names
    # The already-chosen names are still excluded, exactly as before.
    assert "untyped-draft-tag" not in names
    assert "untyped-shared-tag" not in names


@pytest.mark.django_db
def test_selected_tags_are_bounded(api_client, creator_factory):
    """`selected_tags` is attacker-controlled on an un-throttled AllowAny
    endpoint, and each entry costs two alias lookups plus (when typed) another
    M2M join. An 8KB query string of one-character tags was thousands of
    preliminary SELECTs per request. Clamped, not rejected: the parameter is a
    hint about what the caller already chose, so a nonsense value should widen
    the suggestions rather than break the editor's category control.
    """
    from dj.apps.tagging.views import MAX_SELECTED_TAGS

    creator = creator_factory()
    _page(creator, ["bounded-selected-tag"])
    flood = ",".join(f"t{n}" for n in range(MAX_SELECTED_TAGS * 20))
    # Blanks and duplicates are dropped BEFORE the cap, or the cap bounds slots
    # rather than work: `selected_tags=,,,,...` used to fill all 50 with empty
    # strings, each still costing two alias lookups and an M2M join.
    padding = "," * (MAX_SELECTED_TAGS * 20) + ",".join(
        ["dupe"] * (MAX_SELECTED_TAGS * 20)
    )
    flood = f"{padding},{flood}"

    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as captured:
        response = api_client.get(
            "/api/tagging/autocomplete",
            {"type": "zpage", "selected_tags": flood},
        )

    assert response.status_code == 200, response.content
    # The ceiling is generous on purpose -- this asserts "bounded by the cap,
    # not by what the caller sent", not an exact query budget. Without the
    # clamp this request issues thousands.
    ceiling = MAX_SELECTED_TAGS * 3 + 20
    assert len(captured.captured_queries) <= ceiling, (
        len(captured.captured_queries), ceiling
    )

    # Blanks and duplicates alone must not consume the budget either.
    with CaptureQueriesContext(connection) as blanks:
        blank_response = api_client.get(
            "/api/tagging/autocomplete",
            {"type": "zpage", "selected_tags": "," * 5000},
        )
    assert blank_response.status_code == 200, blank_response.content
    assert len(blanks.captured_queries) <= 20, len(blanks.captured_queries)
