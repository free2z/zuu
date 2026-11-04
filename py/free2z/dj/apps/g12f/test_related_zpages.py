"""Tests for GET /api/zpage/<free2zaddr-or-vanity>/related/ against real
Postgres with the pgvector extension (same as CI: pgvector/pgvector:pg16).

Vectors are hand-built 1536-dim unit-ish vectors so cosine distances are
deterministic: identical direction -> 0.0, orthogonal -> 1.0. The view
keeps candidates with distance <= VectorSearchFilter.max_score (0.8).
"""
import uuid

import pytest
from django.contrib.contenttypes.models import ContentType
from django.db import connection, transaction
from django.test.utils import CaptureQueriesContext

from dj.apps.g12f.models import zPage
from dj.apps.g12f.views.zpage import zPageView
from dj.apps.search.models import SearchIndex

DIMS = 1536


def _vector(*components):
    """Build a 1536-dim vector from (index, weight) pairs."""
    v = [0.0] * DIMS
    for index, weight in components:
        v[index] = weight
    return v


def _make_page(creator, vanity, title="A title", published=True, **kwargs):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity,
        title=title,
        content="Some content about a topic.",
        is_published=published,
        **kwargs,
    )


def _index(page, vector):
    return SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=page.pk,
        vector=vector,
    )


def _slugs(response):
    return [item["vanity"] for item in response.json()]


@pytest.mark.django_db
def test_related_returns_similar_pages_ordered_excludes_self_and_dissimilar(
    api_client, creator_factory,
):
    author = creator_factory()
    other = creator_factory()

    target = _make_page(author, "target-page")
    _index(target, _vector((0, 1.0)))

    closest = _make_page(other, "closest-page")
    _index(closest, _vector((0, 0.95), (1, 0.05)))

    close = _make_page(other, "close-page")
    _index(close, _vector((0, 0.6), (1, 0.4)))

    dissimilar = _make_page(other, "dissimilar-page")
    _index(dissimilar, _vector((1, 1.0)))  # orthogonal: distance 1.0 > 0.8

    # Anonymous request: endpoint requires no auth
    response = api_client.get("/api/zpage/target-page/related/")
    assert response.status_code == 200
    assert _slugs(response) == ["closest-page", "close-page"]

    # Lookup by free2zaddr works too
    response = api_client.get(f"/api/zpage/{target.free2zaddr}/related/")
    assert response.status_code == 200
    assert _slugs(response) == ["closest-page", "close-page"]

    # List-serializer shape Kevin's RelatedZpageCard consumes
    item = response.json()[0]
    for field in (
        "free2zaddr", "vanity", "title", "creator",
        "created_at", "f2z_score", "featured_image",
    ):
        assert field in item
    assert item["creator"]["username"] == other.username


@pytest.mark.django_db
def test_related_excludes_unpublished_and_unlisted_pages(
    api_client, creator_factory,
):
    author = creator_factory()
    other = creator_factory()

    target = _make_page(author, "target-page")
    _index(target, _vector((0, 1.0)))

    visible = _make_page(other, "visible-page")
    _index(visible, _vector((0, 0.9), (1, 0.1)))

    unpublished = _make_page(other, "unpublished-page", published=False)
    _index(unpublished, _vector((0, 1.0)))

    no_vanity = _make_page(other, "")  # model save nulls empty vanity
    _index(no_vanity, _vector((0, 1.0)))

    untitled = _make_page(other, "untitled-page", title="")
    _index(untitled, _vector((0, 1.0)))

    response = api_client.get("/api/zpage/target-page/related/")
    assert response.status_code == 200
    assert _slugs(response) == ["visible-page"]


@pytest.mark.django_db
def test_anonymous_mine_flag_cannot_reveal_paid_related_content(
    api_client, creator_factory,
):
    author = creator_factory()
    other = creator_factory()
    target = _make_page(author, "paid-target")
    _index(target, _vector((0, 1.0)))
    paid = _make_page(other, "paid-related", is_subscriber_only=True)
    zPage.objects.filter(pk=paid.pk).update(content="SECRET PAID BODY")
    _index(paid, _vector((0, 0.95), (1, 0.05)))

    response = api_client.get("/api/zpage/paid-target/related/?mine=true")
    assert response.status_code == 403


@pytest.mark.django_db
def test_related_fallback_without_embedding_uses_same_author_recent(
    api_client, creator_factory,
):
    author = creator_factory()
    other = creator_factory()

    _make_page(author, "no-embedding-target")  # no SearchIndex row

    older = _make_page(author, "older-page")
    newer = _make_page(author, "newer-page")
    _make_page(author, "author-unpublished", published=False)
    _make_page(other, "other-author-page")

    response = api_client.get("/api/zpage/no-embedding-target/related/")
    assert response.status_code == 200
    assert _slugs(response) == [newer.vanity, older.vanity]


@pytest.mark.django_db
def test_related_404_for_missing_or_unpublished_target(
    api_client, creator_factory,
):
    author = creator_factory()
    _make_page(author, "hidden-target", published=False)

    assert api_client.get(
        "/api/zpage/hidden-target/related/").status_code == 404
    assert api_client.get(
        "/api/zpage/does-not-exist/related/").status_code == 404


# --------------------------------------------------------------------------
#`/related/` sequentially scanned every published zPage, computing a
# 1536-dimension cosine per row, on every article view. Measured plan before
# the fix, on a 3,901-row fixture at production cardinality:
#
#   Limit  (actual time=27.008..27.010 rows=6)
#     ->  Sort  (Sort Key: (COALESCE((SubPlan 1), '1'::double precision)))
#         ->  Nested Loop
#             ->  Seq Scan on g12f_zpage  (rows=99, Rows Removed by Filter: 3901)
#                   Filter:... AND (COALESCE((SubPlan 2), '1') <= '0.8')
#                   Buffers: shared hit=23339 read=1191
#                   SubPlan 2 -> Index Scan... (loops=3999)
#   Execution Time: 27.061 ms
#
# Two independent defects made that unavoidable, and fixing either one alone
# buys nothing, so each gets its own test below:
#
#   1. the HNSW index was built `vector_l2_ops` while every query sorts by
#      `CosineDistance` (`<=>`), so no cosine query could ever use it;
#   2. the distance was a correlated `Subquery` annotated onto the zPage
#      queryset and then filtered and sorted, which is not a shape pgvector's
#      ANN path can serve even with the right operator class.
#
# The plans themselves are not asserted here: a plan test is only honest at
# production cardinality, and seeding ~4,000 1536-dimension vectors costs the
# better part of a minute. What IS asserted is the two conditions that were
# wrong, each of which fails independently, plus the session settings the
# query depends on.
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_search_index_hnsw_opclass_is_cosine():
    """Defect 1. Negative control: put `vector_l2_ops` back in
    `SearchIndex.Meta.indexes` and in `search/0002_hnsw_cosine_opclass` and
    this goes red.

    Matched on the table rather than the index name, so a future rename does
    not quietly turn this into a test of nothing -- and so that an L2 index
    left behind alongside the cosine one is caught too, since the planner
    would then have a second 31MB structure to maintain for a query nobody
    makes.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT indexname, indexdef FROM pg_indexes "
            "WHERE tablename = 'search_searchindex' "
            "AND indexdef LIKE '%USING hnsw%'"
        )
        rows = cursor.fetchall()

    assert len(rows) == 1, f"expected exactly one HNSW index, got {rows}"
    indexdef = rows[0][1]
    assert "vector_cosine_ops" in indexdef, indexdef
    assert "vector_l2_ops" not in indexdef, indexdef


@pytest.mark.django_db
def test_related_neighbor_query_is_a_direct_ann_order_by(creator_factory):
    """Defect 2.

    pgvector's ANN path needs `ORDER BY <indexed column> <=> $1 LIMIT n`
    against the indexed table itself. Negative control: restore the old
    `Coalesce(Subquery(...CosineDistance...))` annotation on the zPage
    queryset and this goes red on every assertion -- the distance moves into a
    correlated subquery over `g12f_zpage`, and neither the ordering nor the
    ceiling is expressible against the index.
    """
    author = creator_factory()
    target = _make_page(author, "shape-target")
    _index(target, _vector((0, 1.0)))

    view = zPageView()
    content_type = ContentType.objects.get_for_model(zPage)
    sql, _params = view._related_neighbor_queryset(
        content_type, _vector((0, 1.0)), target.pk,
    ).query.sql_with_params()

    # One table, the indexed one. No correlated subquery over zPages.
    assert "search_searchindex" in sql
    assert "g12f_zpage" not in sql
    assert sql.count("SELECT") == 1, sql

    # Cosine distance (`<=>`), ordered, bounded.
    assert "<=>" in sql, sql
    assert f"LIMIT {view.related_ann_fetch}" in sql, sql

    # The ORDER BY must be the distance. Django renders it as an ordinal
    # reference to the select-list expression (`ORDER BY 2 ASC`) rather than
    # repeating the 1536-element literal; Postgres resolves the ordinal before
    # planning, and the plan is an HNSW `Order By:` scan either way. Accept
    # both spellings so a Django version bump that stops using the ordinal
    # does not read as a regression.
    select_list = sql[:sql.index(" FROM ")]
    distance_position = select_list.count(",") + 1
    order_by = sql[sql.index("ORDER BY"):]
    assert (
        "<=>" in order_by
        or order_by.startswith(f"ORDER BY {distance_position} ")
    ), sql


@pytest.mark.django_db
def test_related_ann_session_settings_are_applied_and_restored():
    """`hnsw.ef_search` is set high enough, and neither GUC outlives the query.

    pgvector does not raise `hnsw.ef_search` to meet `LIMIT`: at the default
    40, a `LIMIT 90` returns exactly 40 rows and says nothing about it. And
    `CONN_MAX_AGE` keeps connections alive across requests, so an
    `enable_seqscan = off` that outlived its statement would reprice every
    later query on that connection.

    Negative control: drop the `_restore_ann_session_settings` call from
    `_related_neighbors` and the last two assertions go red (this test body,
    like a `TestCase`, runs inside a transaction -- which is exactly the
    nesting in which `SET LOCAL` survives the inner block).
    """
    view = zPageView()
    assert view.related_ef_search >= view.related_ann_fetch_max

    # The primary defence against a full scan is the fetch size, not the
    # `enable_seqscan` pin: measured at production cardinality (3,901 rows),
    # PostgreSQL chooses the HNSW index unassisted up to `LIMIT 40` and a
    # sequential scan at 60, because its cost model prices this table at its
    # main heap and cannot see the TOASTed vectors. Raising `related_ann_fetch`
    # past the measured flip point would put the fix back on a cost estimate
    # that is wrong by two orders of magnitude.
    assert view.related_ann_fetch <= 40

    with connection.cursor() as cursor:
        cursor.execute("SHOW enable_seqscan")
        before = cursor.fetchone()[0]

    with transaction.atomic():
        previous = view._apply_ann_session_settings()
        with connection.cursor() as cursor:
            cursor.execute("SHOW hnsw.ef_search")
            assert int(cursor.fetchone()[0]) == view.related_ef_search
            cursor.execute("SHOW enable_seqscan")
            assert cursor.fetchone()[0] == "off"
        view._restore_ann_session_settings(previous)

    with connection.cursor() as cursor:
        cursor.execute("SHOW enable_seqscan")
        assert cursor.fetchone()[0] == before


@pytest.mark.django_db
def test_related_orders_by_distance_and_caps_at_the_limit(
    api_client, creator_factory,
):
    """More qualifying neighbours than `related_limit`: the six nearest win,
    in distance order.

    The ANN path takes the top-N off the index and applies the visibility
    filters to that short list, instead of ranking every visible page. This
    pins that the ordering and the cap both survive that inversion.
    """
    author = creator_factory()
    other = creator_factory()

    target = _make_page(author, "cap-target")
    _index(target, _vector((0, 1.0)))

    # Monotonically further away, all comfortably inside the 0.8 ceiling.
    for rank in range(10):
        page = _make_page(other, f"cap-neighbor-{rank}")
        _index(page, _vector((0, 1.0), (1, 0.05 * (rank + 1))))

    response = api_client.get("/api/zpage/cap-target/related/")
    assert response.status_code == 200
    assert _slugs(response) == [f"cap-neighbor-{rank}" for rank in range(6)]


@pytest.mark.django_db
def test_related_widens_the_ann_fetch_past_ineligible_neighbours(
    api_client, creator_factory,
):
    """A wall of ineligible neighbours must not hide the visible ones.

    The ANN pass ranks the index *before* the visibility filters, so index
    rows for pages a reader may not see still consume slots. Here the nearest
    `related_ann_fetch` neighbours are all unpublished -- exactly the shape a
    lagging unpublish sweep leaves behind -- and the only visible neighbour
    sits just past that cut-off.

    Negative control: delete the `related_ann_fetch_max` widening block from
    `related()` and this returns the author's own `decoy-source` page (the
    no-neighbours fallback) instead of `visible-page`.
    """
    author = creator_factory()
    other = creator_factory()

    target = _make_page(author, "widen-target")
    _index(target, _vector((0, 1.0)))

    # The author needs a second page so the fallback has something to return;
    # otherwise "widening worked" and "the fallback was empty" look alike.
    _make_page(author, "decoy-source")

    view = zPageView()
    # Nearest, and all invisible: published_and_active() rejects them, but
    # their SearchIndex rows are still the closest vectors.
    for i in range(view.related_ann_fetch):
        hidden = _make_page(other, f"hidden-{i}", published=False)
        _index(hidden, _vector((0, 1.0), (1, 0.001 * (i + 1))))

    # Just past the first cut-off, and the only eligible neighbour there is.
    visible = _make_page(other, "visible-page")
    _index(visible, _vector((0, 1.0), (1, 0.5)))

    response = api_client.get("/api/zpage/widen-target/related/")
    assert response.status_code == 200
    assert _slugs(response) == ["visible-page"]


@pytest.mark.django_db
def test_related_does_not_widen_when_the_ceiling_already_truncated(
    api_client, creator_factory,
):
    """The widening pass must not fire when it cannot possibly help.

    A first pass that came back with fewer than `related_ann_fetch` rows was
    cut short by the 0.8 distance ceiling, not by the LIMIT -- everything
    further out is further away still. Re-running the ANN query there would be
    a wasted round trip on the hottest read path on the site.
    """
    author = creator_factory()
    other = creator_factory()

    target = _make_page(author, "ceiling-target")
    _index(target, _vector((0, 1.0)))

    # One neighbour inside the ceiling, one orthogonal (distance 1.0) outside.
    near = _make_page(other, "near-page")
    _index(near, _vector((0, 0.9), (1, 0.1)))
    far = _make_page(other, "far-page")
    _index(far, _vector((1, 1.0)))

    view = zPageView()
    response = api_client.get("/api/zpage/ceiling-target/related/")
    assert response.status_code == 200
    assert _slugs(response) == ["near-page"]

    # One ANN query, not two: count the statements that carry the operator.
    with CaptureQueriesContext(connection) as captured:
        api_client.get("/api/zpage/ceiling-target/related/")
    ann_queries = [
        q for q in captured.captured_queries
        if "<=>" in q["sql"] and "LIMIT" in q["sql"]
    ]
    assert len(ann_queries) == 1, [q["sql"][:200] for q in ann_queries]
    assert f"LIMIT {view.related_ann_fetch}" in ann_queries[0]["sql"]


@pytest.mark.django_db
def test_related_falls_back_when_the_widened_fetch_is_also_all_ineligible(
    api_client, creator_factory,
):
    """The stated limit of the ANN approach, pinned rather than left implicit.

    Ranking the index before the visibility filters means the search is
    bounded: past `related_ann_fetch_max` neighbours of ineligible index rows,
    a genuinely related page is no longer found and the endpoint answers with
    the author's recent pages. The old exact query ranked every visible page
    and would have found it.

    It is a deliberate trade, and worth being exact about its cost. Only
    creator deactivation deletes the `SearchIndex` row synchronously
    (`g12f.signals.creator_deactivation_search_cleanup`). **Unpublishing does
    not**: it enqueues `search.index_zpage`, and that task deletes the row when
    it runs -- on the `search` queue, the slow one, shared with OpenAI calls.
    So a stalled worker plus a mass unpublish of mutually similar pages can
    leave a stale prefix, and unlike the exact query this replaces, a stale
    prefix here can crowd a good neighbour out.

    What bounds it: the same stalled worker is already serving those pages in
    `?search=` results, so this is a symptom of an indexing backlog rather than
    a new failure mode, and the degraded answer is one the endpoint already
    gives whenever nothing is close enough -- not an error, not a full scan.
    Sixty ineligible rows in an unbroken run at the top of one page's neighbour
    list is the threshold. The durable fix is to delete on unpublish
    synchronously, the way deactivation already does; that belongs in the
    indexing path, not here.
    """
    author = creator_factory()
    other = creator_factory()

    target = _make_page(author, "exhaust-target")
    _index(target, _vector((0, 1.0)))
    author_recent = _make_page(author, "author-recent")

    view = zPageView()
    for i in range(view.related_ann_fetch_max):
        hidden = _make_page(other, f"exhausted-{i}", published=False)
        _index(hidden, _vector((0, 1.0), (1, 0.001 * (i + 1))))

    beyond = _make_page(other, "beyond-the-fetch")
    _index(beyond, _vector((0, 1.0), (1, 0.5)))

    response = api_client.get("/api/zpage/exhaust-target/related/")
    assert response.status_code == 200
    # Not ["beyond-the-fetch"]: the author fallback, as documented above.
    assert _slugs(response) == [author_recent.vanity]
