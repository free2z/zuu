"""Tests for the zpage list endpoint's date filtering  and the
recency-decayed `homeSort=popular` ranking, against real Postgres.

`created_at` is auto_now_add, so we set it after creation with `.update()`
(which bypasses auto_now_add).
"""
import base64
import json
import uuid
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from django.db import connection, transaction
from django.db.models import F, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from dj.apps.g12f.models import zPage
from dj.apps.uploads.models import GenericFile
from dj.free2z.pagination import ZPageFeedCursorPagination


def _make_page(
    creator, vanity, *, score=0, image=None, days_old=0, is_published=True,
):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity,
        title=f"Title {vanity}",
        content="Some content about a topic.",
        is_published=is_published,
        f2z_score=score,
        featured_image=image,
    )
    if days_old:
        when = timezone.now() - timedelta(days=days_old)
        zPage.objects.filter(pk=page.pk).update(created_at=when)
    return page


def _image(creator):
    return GenericFile.objects.create(
        owner=creator,
        file=f"uploads/test-{uuid.uuid4().hex}.png",  # one key, one row
        mime_type="image/png",
    )


def _vanities(response):
    return [item["vanity"] for item in response.json()["results"]]


def _local_url(absolute_url):
    parsed = urlsplit(absolute_url)
    return f"{parsed.path}?{parsed.query}"


# --------------------------------------------------------------------------
#  created_at date filtering
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_created_at_gte_filters_out_older_pages(api_client, creator_factory):
    author = creator_factory()
    _make_page(author, "old", days_old=400)
    _make_page(author, "recent", days_old=5)

    cutoff = (timezone.now() - timedelta(days=30)).date().isoformat()
    response = api_client.get(f"/api/zpage/?created_at__gte={cutoff}")

    assert response.status_code == 200
    vanities = _vanities(response)
    assert "recent" in vanities
    assert "old" not in vanities


@pytest.mark.django_db
def test_created_at_lte_filters_out_newer_pages(api_client, creator_factory):
    author = creator_factory()
    _make_page(author, "old", days_old=400)
    _make_page(author, "recent", days_old=5)

    cutoff = (timezone.now() - timedelta(days=30)).date().isoformat()
    response = api_client.get(f"/api/zpage/?created_at__lte={cutoff}")

    assert response.status_code == 200
    vanities = _vanities(response)
    assert "old" in vanities
    assert "recent" not in vanities


@pytest.mark.django_db
def test_created_at_range_combines_both_bounds(api_client, creator_factory):
    author = creator_factory()
    _make_page(author, "ancient", days_old=400)
    _make_page(author, "target", days_old=50)
    _make_page(author, "fresh", days_old=1)

    gte = (timezone.now() - timedelta(days=90)).date().isoformat()
    lte = (timezone.now() - timedelta(days=10)).date().isoformat()
    response = api_client.get(
        f"/api/zpage/?created_at__gte={gte}&created_at__lte={lte}"
    )

    assert response.status_code == 200
    assert _vanities(response) == ["target"]


@pytest.mark.django_db
def test_invalid_created_at_returns_400(api_client, creator_factory):
    _make_page(creator_factory(), "any")
    response = api_client.get("/api/zpage/?created_at__gte=not-a-date")
    assert response.status_code == 400
    assert "created_at__gte" in response.json()


@pytest.mark.django_db
def test_latest_order_uses_id_to_break_created_at_ties(
    api_client, creator_factory,
):
    author = creator_factory()
    first = _make_page(author, "same-time-first")
    second = _make_page(author, "same-time-second")
    shared_time = timezone.now() - timedelta(hours=1)
    zPage.objects.filter(pk__in=[first.pk, second.pk]).update(
        created_at=shared_time,
    )

    response = api_client.get(
        "/api/zpage/?ordering=-created_at,-id&page_size=2"
    )

    assert response.status_code == 200
    assert _vanities(response)[:2] == ["same-time-second", "same-time-first"]


@pytest.mark.django_db
def test_public_order_stays_at_original_publication_after_edit(
    api_client, creator_factory,
):
    author = creator_factory()
    old = _make_page(author, "published-old")
    new = _make_page(author, "published-new")
    old_publication = timezone.now() - timedelta(days=2)
    new_publication = timezone.now() - timedelta(days=1)
    zPage.objects.filter(pk=old.pk).update(
        created_at=old_publication,
        published_at=old_publication,
    )
    zPage.objects.filter(pk=new.pk).update(
        created_at=new_publication,
        published_at=new_publication,
    )

    old.title = "Edited after publication"
    old.save()

    response = api_client.get("/api/zpage/?page_size=2")

    assert response.status_code == 200
    assert _vanities(response)[:2] == ["published-new", "published-old"]


@pytest.mark.django_db
def test_public_order_falls_back_to_created_at_for_legacy_rows(
    api_client, creator_factory,
):
    author = creator_factory()
    legacy = _make_page(author, "legacy")
    current = _make_page(author, "current")
    legacy_created = timezone.now() - timedelta(days=2)
    current_created = timezone.now() - timedelta(days=1)
    zPage.objects.filter(pk=legacy.pk).update(
        created_at=legacy_created,
        published_at=None,
    )
    zPage.objects.filter(pk=current.pk).update(
        created_at=current_created,
        published_at=current_created,
    )

    response = api_client.get("/api/zpage/?ordering=-published_at,-id")

    assert response.status_code == 200
    assert _vanities(response)[:2] == ["current", "legacy"]


@pytest.mark.django_db
def test_mine_published_at_ordering_does_not_float_drafts_to_the_top(
    api_client, creator_factory,
):
    """`?mine=1&ordering=-published_at` must not sort every draft first.

    Drafts have ``published_at IS NULL`` and PostgreSQL DESC is NULLS FIRST,
    so ordering by the raw column puts every draft ahead of every published
    page. The dashboard keeps its `-updated_at` default, but an explicit
    publication-order request gets the same COALESCE fallback as public feeds.
    """
    owner = creator_factory()
    api_client.force_authenticate(owner)
    draft = _make_page(owner, "mine-draft", is_published=False)
    published = _make_page(owner, "mine-published")
    old = timezone.now() - timedelta(days=5)
    new = timezone.now() - timedelta(days=1)
    # The draft is the OLDER row, so a correct COALESCE ordering ranks the
    # newer published page first; a raw `-published_at` sort would invert it.
    zPage.objects.filter(pk=draft.pk).update(created_at=old, published_at=None)
    zPage.objects.filter(pk=published.pk).update(
        created_at=new, published_at=new,
    )

    response = api_client.get("/api/zpage/?mine=1&ordering=-published_at,-id")

    assert response.status_code == 200
    assert _vanities(response)[:2] == ["mine-published", "mine-draft"]


@pytest.mark.django_db
def test_mine_default_ordering_is_still_recently_updated(
    api_client, creator_factory,
):
    """Dropping the `mine` exemption must not disturb its default ordering."""
    owner = creator_factory()
    api_client.force_authenticate(owner)
    stale = _make_page(owner, "mine-stale")
    fresh = _make_page(owner, "mine-fresh")
    zPage.objects.filter(pk=stale.pk).update(
        updated_at=timezone.now() - timedelta(days=3),
    )
    zPage.objects.filter(pk=fresh.pk).update(updated_at=timezone.now())

    response = api_client.get("/api/zpage/?mine=1")

    assert response.status_code == 200
    assert _vanities(response)[:2] == ["mine-fresh", "mine-stale"]


@pytest.mark.django_db
def test_authenticated_non_mine_list_excludes_drafts_even_for_the_owner(
    api_client, creator_factory,
):
    """Public profile reads never widen just because the viewer owns it."""
    owner = creator_factory()
    other = creator_factory()
    own_draft = _make_page(owner, "owner-draft", is_published=False)
    own_public = _make_page(owner, "owner-public")
    other_draft = _make_page(other, "other-draft", is_published=False)
    other_public = _make_page(other, "other-public")
    api_client.force_authenticate(owner)

    homepage = api_client.get("/api/zpage/?page_size=12")
    assert homepage.status_code == 200
    homepage_vanities = _vanities(homepage)
    assert own_draft.vanity not in homepage_vanities
    assert own_public.vanity in homepage_vanities
    assert other_public.vanity in homepage_vanities
    assert other_draft.vanity not in homepage_vanities

    other_profile = api_client.get(
        f"/api/zpage/?username={other.username}&page_size=12",
    )
    assert other_profile.status_code == 200
    assert _vanities(other_profile) == [other_public.vanity]

    own_profile = api_client.get(
        f"/api/zpage/?username={owner.username}&page_size=12",
    )
    assert own_profile.status_code == 200
    assert _vanities(own_profile) == [own_public.vanity]

    private_profile = api_client.get(
        f"/api/zpage/?username={owner.username}&page_size=12&mine=true",
    )
    assert private_profile.status_code == 200
    assert set(_vanities(private_profile)) == {
        own_draft.vanity,
        own_public.vanity,
    }


@pytest.mark.django_db
def test_anonymous_mine_list_requires_authentication(api_client):
    response = api_client.get("/api/zpage/?mine=true")
    assert response.status_code == 403


@pytest.mark.django_db
def test_authenticated_chronological_queries_use_ordering_indexes(
    creator_factory,
):
    """The auth homepage and own-profile feeds need no full sort.

    PostgreSQL may reasonably pick a sequential plan for a tiny test table.
    Disable sequential/bitmap/sort alternatives only for this EXPLAIN so the
    assertion checks that the two production predicates have an index path
    which supplies their requested ordering.

    The ``ANALYZE`` is not decoration. An EXPLAIN-shape assertion is a
    function of the planner's statistics for ``g12f_zpage``, and those are
    left behind by whatever ran earlier IN THE SAME DATABASE. That was a fixed
    input while the backend suite was one job in one database; it stopped
    being one when the suite moved to four independently collected shards, and
    this test then chose ``g12f_zpage_chrono_idx`` + ``Filter: (creator_id =
    N)`` on three hosted runs out of five -- a valid plan, but not the one
    under test. Two things make the answer deterministic: the ``ANALYZE``
    below removes the shard's history from the planner's inputs, and the bulk
    fixture makes the two strategies cost visibly different amounts instead of
    tying. Neither weakens anything: both index assertions and both no-Sort
    assertions are unchanged, and dropping
    ``g12f_zpage_creator_chrono_idx`` still fails this test.
    """
    if connection.vendor != "postgresql":
        pytest.skip("chronological expression indexes are PostgreSQL-only")

    owner = creator_factory()
    other = creator_factory()
    _make_page(owner, "auth-index-draft", is_published=False)
    _make_page(owner, "auth-index-own-public")
    _make_page(other, "auth-index-other-public")
    #...plus enough foreign rows for the question to have an answer.
    # On a three-row table the two strategies cost the same -- there is
    # nothing to walk past, so "index cond on creator_id" and "walk the global
    # chronological index and filter" are a tie, and the planner is free to
    # pick either. It did: three hosted shard runs out of five chose
    # `g12f_zpage_chrono_idx` + `Filter: (creator_id = N)`, which satisfies
    # every ordering claim this test makes while being exactly the plan
    # `g12f_zpage_creator_chrono_idx` exists to prevent ("keeps that profile
    # path from walking the global chronological index until it happens to
    # find their rows" -- zPage.Meta.indexes). Deleting the index has to be
    # what fails this test, not which way a coin landed on this shard.
    zPage.objects.bulk_create([
        zPage(
            creator=other,
            free2zaddr=str(uuid.uuid4()),
            vanity=f"auth-index-bulk-{index}",
            title=f"Bulk {index}",
            content="Some content about a topic.",
            is_published=True,
            published_at=timezone.now() - timedelta(minutes=index),
        )
        for index in range(400)
    ])
    chronological = Coalesce(F("published_at"), F("created_at"))
    homepage = zPage.objects.filter(
        Q(is_published=True) | Q(creator=owner),
    ).annotate(
        publication_order=chronological,
    ).order_by("-publication_order", "-id")[:12]
    own_profile = zPage.objects.filter(
        creator=owner,
    ).annotate(
        publication_order=chronological,
    ).order_by("-publication_order", "-id")[:12]

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL enable_seqscan = off")
            cursor.execute("SET LOCAL enable_bitmapscan = off")
            cursor.execute("SET LOCAL enable_sort = off")
            # Plan the rows above, not the shard's accumulated history.
            # Transactional, so it rolls back with the test and cannot leak
            # into whatever runs next.
            cursor.execute("ANALYZE g12f_zpage")
        homepage_plan = homepage.explain(costs=False)
        profile_plan = own_profile.explain(costs=False)

    assert "g12f_zpage_chrono_idx" in homepage_plan
    assert "Sort" not in homepage_plan
    assert "g12f_zpage_creator_chrono_idx" in profile_plan
    assert "Sort" not in profile_plan


@pytest.mark.django_db
def test_cursor_feed_does_not_skip_when_new_pages_are_published(
    api_client, creator_factory,
):
    """A publish ahead of the cursor must not shift an unseen row away."""
    author = creator_factory()
    expected = []
    for index in range(6):
        page = _make_page(author, f"cursor-{index}")
        zPage.objects.filter(pk=page.pk).update(
            created_at=timezone.now() - timedelta(days=index + 1),
        )
        expected.append(page.vanity)

    first = api_client.get(
        "/api/zpage/?pagination=cursor"
        "&ordering=-created_at,-id&page_size=2"
    )
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["count"] == len(expected)
    assert [row["vanity"] for row in first_body["results"]] == expected[:2]
    assert first_body["next"]

    # Offset page 2 would now start one row later and silently skip cursor-2.
    _make_page(author, "published-mid-session")

    seen = [row["vanity"] for row in first_body["results"]]
    next_url = first_body["next"]
    while next_url:
        response = api_client.get(_local_url(next_url))
        assert response.status_code == 200
        body = response.json()
        seen.extend(row["vanity"] for row in body["results"])
        next_url = body["next"]

    assert seen == expected
    assert len(seen) == len(set(seen))


@pytest.mark.django_db
def test_cursor_feed_does_not_shift_when_a_seen_page_is_deleted(
    api_client, creator_factory,
):
    author = creator_factory()
    pages = []
    for index in range(5):
        page = _make_page(author, f"delete-cursor-{index}")
        zPage.objects.filter(pk=page.pk).update(
            created_at=timezone.now() - timedelta(days=index + 1),
        )
        pages.append(page)

    first_response = api_client.get(
        "/api/zpage/?pagination=cursor"
        "&ordering=-created_at,-id&page_size=2"
    )
    assert first_response.status_code == 200
    first = first_response.json()
    assert first["results"][0]["vanity"] == pages[0].vanity

    # Removing a row before an offset would pull a duplicate into page 2.
    # The cursor boundary remains anchored to the last row the reader saw.
    pages[0].delete()
    second = api_client.get(_local_url(first["next"]))

    assert second.status_code == 200
    assert _vanities(second) == [pages[2].vanity, pages[3].vanity]


@pytest.mark.django_db
def test_v1_created_at_cursor_continues_without_explicit_ordering(
    api_client, creator_factory,
):
    """A default cursor issued before publication ordering keeps its feed."""
    author = creator_factory()
    newest = _make_page(author, "legacy-cursor-newest")
    middle = _make_page(author, "legacy-cursor-middle")
    oldest = _make_page(author, "legacy-cursor-oldest")
    now = timezone.now()
    zPage.objects.filter(pk=newest.pk).update(
        created_at=now - timedelta(days=1),
        published_at=now - timedelta(days=3),
    )
    zPage.objects.filter(pk=middle.pk).update(
        created_at=now - timedelta(days=2),
        published_at=now,
    )
    zPage.objects.filter(pk=oldest.pk).update(
        created_at=now - timedelta(days=3),
        published_at=now - timedelta(days=2),
    )

    first = api_client.get(
        "/api/zpage/?pagination=cursor"
        "&ordering=-created_at,-id&page_size=1"
    )
    assert first.status_code == 200
    assert _vanities(first) == [newest.vanity]

    # v1's default cursor omitted `ordering` from its continuation URL even
    # though its payload said `created_at`. Recreate that URL shape and make
    # sure the second page remains creation-time ordered after the deploy.
    params = {
        key: values[-1]
        for key, values in parse_qs(urlsplit(first.json()["next"]).query).items()
    }
    params.pop("ordering", None)

    # Compatibility applies only to the old implicit default. Explicitly
    # asking for the new publication feed with an old creation cursor still
    # fails closed instead of changing the keyset boundary underneath it.
    switched = api_client.get(
        "/api/zpage/", data={**params, "ordering": "-published_at,-id"},
    )
    assert switched.status_code == 404
    assert switched.json()["detail"] == "Invalid cursor."

    continued = api_client.get("/api/zpage/", data=params)

    assert continued.status_code == 200
    assert _vanities(continued) == [middle.vanity]
    next_cursor = parse_qs(urlsplit(continued.json()["next"]).query)[
        "cursor"
    ][-1]
    padded = next_cursor + "=" * (-len(next_cursor) % 4)
    next_payload = json.loads(base64.urlsafe_b64decode(padded))
    assert next_payload["ordering"] == "created_at"


@pytest.mark.django_db
def test_cursor_paginator_supplies_publication_order_annotation(
    creator_factory,
):
    """A new cursor call site cannot forget the required Coalesce annotation."""
    author = creator_factory()
    older = _make_page(author, "paginator-annotation-older")
    newer = _make_page(author, "paginator-annotation-newer")
    now = timezone.now()
    zPage.objects.filter(pk=older.pk).update(
        published_at=now - timedelta(days=2),
    )
    zPage.objects.filter(pk=newer.pk).update(
        published_at=now - timedelta(days=1),
    )

    request = Request(APIRequestFactory().get(
        "/api/zpage/?pagination=cursor&page_size=2"
    ))
    rows = ZPageFeedCursorPagination().paginate_queryset(
        zPage.objects.filter(pk__in=[older.pk, newer.pk]), request,
    )

    assert [row.vanity for row in rows] == [newer.vanity, older.vanity]
    assert all(hasattr(row, "publication_order") for row in rows)


@pytest.mark.django_db
def test_page_number_pagination_contract_remains_the_default(
    api_client, creator_factory,
):
    _make_page(creator_factory(), "page-number-compatible")
    body = api_client.get("/api/zpage/?page=1&page_size=1").json()

    assert body["count"] == 1
    assert "next" in body
    assert "previous" in body
    assert len(body["results"]) == 1


@pytest.mark.django_db
def test_cursor_feed_rejects_malformed_cursor_without_server_error(
    api_client, creator_factory,
):
    author = creator_factory()
    _make_page(author, "cursor-validation-1")
    _make_page(author, "cursor-validation-2")
    response = api_client.get(
        "/api/zpage/?pagination=cursor&cursor=%FFnot-json"
    )
    assert response.status_code == 404

    first = api_client.get(
        "/api/zpage/?pagination=cursor&page_size=1"
    ).json()
    cursor = parse_qs(urlsplit(first["next"]).query)["cursor"][-1]
    tampered = api_client.get(
        "/api/zpage/",
        data={"pagination": "cursor", "cursor": f"{cursor}*"},
    )
    assert tampered.status_code == 404


@pytest.mark.django_db
def test_cursor_feed_crosses_equal_timestamp_boundary_without_loss(
    api_client, creator_factory,
):
    """The primary-key tie-breaker must work across, not just within, pages."""
    author = creator_factory()
    pages = [
        _make_page(author, f"cursor-tie-{index}")
        for index in range(7)
    ]
    shared_time = timezone.now() - timedelta(hours=1)
    zPage.objects.filter(pk__in=[page.pk for page in pages]).update(
        created_at=shared_time,
    )

    seen = []
    next_url = (
        "/api/zpage/?pagination=cursor"
        "&ordering=-created_at,-id&page_size=2"
    )
    while next_url:
        response = api_client.get(_local_url(next_url))
        assert response.status_code == 200
        body = response.json()
        seen.extend(row["vanity"] for row in body["results"])
        next_url = body["next"]

    expected = [
        page.vanity
        for page in sorted(pages, key=lambda page: page.pk, reverse=True)
    ]
    assert seen == expected
    assert len(seen) == len(set(seen))


@pytest.mark.django_db
@pytest.mark.parametrize(
    "query,field",
    [
        ("pagination=offset", "pagination"),
        ("cursor=abc", "cursor"),
        ("pagination=cursor&page=2", "page"),
        ("pagination=cursor&ordering=-f2z_score", "ordering"),
        ("pagination=cursor&homeSort=popular", "homeSort"),
    ],
)
def test_cursor_feed_rejects_incompatible_protocol_parameters(
    api_client, creator_factory, query, field,
):
    _make_page(creator_factory(), f"cursor-protocol-{field}")
    response = api_client.get(f"/api/zpage/?{query}")

    assert response.status_code == 400
    assert field in response.json()


@pytest.mark.django_db
def test_cursor_cannot_be_reused_with_a_different_feed_order(
    api_client, creator_factory,
):
    author = creator_factory()
    image = _image(author)
    for index in range(3):
        _make_page(author, f"cursor-order-{index}", image=image)

    first = api_client.get(
        "/api/zpage/?pagination=cursor"
        "&ordering=-created_at,-id&page_size=1"
    )
    assert first.status_code == 200
    parsed = urlsplit(first.json()["next"])
    params = {
        key: values[-1]
        for key, values in parse_qs(parsed.query).items()
    }
    params.pop("ordering", None)
    params["homeSort"] = "updated"
    switched = api_client.get(
        "/api/zpage/",
        data=params,
    )

    assert switched.status_code == 404
    assert switched.json()["detail"] == "Invalid cursor."


# --------------------------------------------------------------------------
#  recency-decayed popularity
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_home_sort_popular_ranks_recent_over_stale_high_scorer(
    api_client, creator_factory,
):
    author = creator_factory()
    img = _image(author)
    # Old page with a much higher all-time score vs a fresh moderate one.
    _make_page(author, "stale-champion", score=100, image=img, days_old=400)
    _make_page(author, "fresh-riser", score=20, image=img, days_old=2)

    popular = _vanities(api_client.get("/api/zpage/?homeSort=popular"))
    # Recency decay (45-day half-life) flips the stale champion below the
    # fresh riser even though its raw f2z_score is 5x higher.
    assert popular.index("fresh-riser") < popular.index("stale-champion")

    # Control: pure score ordering keeps the stale champion on top.
    by_score = _vanities(api_client.get("/api/zpage/?homeSort=score"))
    assert by_score.index("stale-champion") < by_score.index("fresh-riser")


@pytest.mark.django_db
def test_home_sort_popular_excludes_imageless_pages(
    api_client, creator_factory,
):
    author = creator_factory()
    img = _image(author)
    _make_page(author, "with-image", score=5, image=img, days_old=1)
    _make_page(author, "no-image", score=99, image=None, days_old=1)

    popular = _vanities(api_client.get("/api/zpage/?homeSort=popular"))
    assert "with-image" in popular
    assert "no-image" not in popular
