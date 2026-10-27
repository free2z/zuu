"""The creator directory's follower filter runs on subscribers.

``GET /api/creator/?min_followers=N`` used to be a client-side comparison
against the serialized ``total`` field. ``Creator.total`` is the output of
``cache_total()``::

    locked.total = Sum(zpage.total) + Decimal(tuzi_total) / Decimal(1000)

-- a cached, ZEC-denominated *page-support* score: ZEC funded to the creator's
zPages plus 2Z boosts at 1000 2Z = 1 ZEC, spent by anyone including the creator
themselves. "At least 5 followers" therefore meant "at least 5 ZEC of page
support", and a creator with a hundred subscribers and no funding was filtered
out of a list they obviously belong in.

The filter now runs in the database against ``fans_count``
(``active_fans_count()``, the number of unexpired ``Subscription`` rows).

The property most worth pinning here is **not** that the filter works on a bare
queryset -- it is that the count stays correct once composed with the zPage
aggregates the directory queryset already carries. ``_annotated_list_queryset``
LEFT JOINs zpage for ``published_pages``/``last_page_activity``; a
non-``distinct`` subscription ``Count`` on top of that join returns the
zPage x Subscription cross product (5 fans x 3 pages = 15), which is a wrong
number that still looks like a number -- exactly the failure mode  is
about, one layer down. Every boundary assertion below is written as an
in/out pair so an inflated count fails rather than passing by luck.
"""

import uuid
from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from dj.apps.g12f.models import Creator, Subscription, zPage
from dj.apps.uploads.models import GenericFile


ACTIVE = None  # bound per-test to "the future"; see _active


def _active():
    return timezone.now() + timedelta(days=30)


def _image(creator):
    return GenericFile.objects.create(
        owner=creator,
        file=f"uploads/test-{uuid.uuid4().hex}.png",  # one key, one row
        mime_type="image/png",
    )


def _make_creator(creator_factory, **kwargs):
    """A creator the directory list will actually return.

    The list excludes anyone without BOTH an avatar and a banner, so a helper
    that forgets them makes every assertion here vacuously true.
    """
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


def _give_fans(creator_factory, star, n, *, expires=None):
    for _ in range(n):
        Subscription.objects.create(
            star=star,
            fan=creator_factory(),
            expires=expires or _active(),
        )


def _usernames(response):
    return [row["username"] for row in response.json()["results"]]


def _list(api_client, **params):
    # `ordering` keeps the request on the non-discovery branch, which does not
    # apply the "must have a published page AND recent activity" exclusion --
    # so these tests measure the follower filter, not the watch qualification.
    params.setdefault("ordering", "username")
    response = api_client.get("/api/creator/", params)
    assert response.status_code == 200, response.content
    return response


# ---------------------------------------------------------------------------
# The bug itself
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_min_followers_filters_on_subscribers_not_the_zec_support_cache(
    api_client, creator_factory,
):
    """The exact inversion the issue describes.

    ``beloved`` has three real subscribers and has never been funded.
    ``bankrolled`` has no subscribers at all but a fat ``total``. The old
    client-side comparison returned precisely the wrong one of these two.
    """
    beloved = _make_creator(creator_factory, username="beloved", total=0)
    _give_fans(creator_factory, beloved, 3)

    # The row must exist for the filter to have something to exclude; the
    # handle is not needed. (Bare call, so the `lint-python` ruff gate's F841
    # stays green.)
    _make_creator(creator_factory, username="bankrolled", total=99)

    names = _usernames(_list(api_client, min_followers=2))
    assert "beloved" in names
    assert "bankrolled" not in names


@pytest.mark.django_db
def test_a_large_total_never_substitutes_for_followers(
    api_client, creator_factory,
):
    """A creator funded to 500 ZEC with one fan fails `min_followers=2`."""
    rich = _make_creator(creator_factory, username="rich", total=500)
    _give_fans(creator_factory, rich, 1)

    assert _usernames(_list(api_client, min_followers=2)) == []
    assert _usernames(_list(api_client, min_followers=1)) == ["rich"]


# ---------------------------------------------------------------------------
# Composition — where a non-distinct Count silently inflates the number
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_count_is_exact_for_a_creator_who_also_has_zpages(
    api_client, creator_factory,
):
    """5 fans and 3 published pages is 5 fans, not 15.

    This is the assertion the whole file exists for. The directory queryset
    already LEFT JOINs zpage, so a subscription Count without ``distinct``
    multiplies out to ``fans x pages``. Both halves matter: without the
    ``min_followers=6`` exclusion a 15 would pass, and without the
    ``min_followers=5`` inclusion a 0 would pass.
    """
    star = _make_creator(creator_factory, username="prolific")
    for _ in range(3):
        _publish_page(star)
    _give_fans(creator_factory, star, 5)

    # Bracket the true value from both sides.
    assert _usernames(_list(api_client, min_followers=5)) == ["prolific"]
    assert _usernames(_list(api_client, min_followers=6)) == []
    # 15 is the cross product a non-distinct Count would report. Naming it
    # explicitly means a regression fails with an obvious message.
    assert _usernames(_list(api_client, min_followers=15)) == []


@pytest.mark.django_db
def test_page_count_is_not_inflated_by_the_subscription_join_either(
    api_client, creator_factory,
):
    """The new join must not corrupt the aggregate that was already there.

    ``published_pages`` feeds the watch_score ranking and ``zpages`` is
    serialized straight onto the card. Fan-out runs in both directions, so a
    creator with 3 pages and 5 fans could just as easily have started
    reporting 15 pages.
    """
    star = _make_creator(creator_factory, username="prolific")
    for _ in range(3):
        _publish_page(star)
    _give_fans(creator_factory, star, 5)

    row = _list(api_client).json()["results"][0]
    assert row["username"] == "prolific"
    assert row["zpages"] == 3

    from dj.apps.g12f.views.creator import CreatorView

    view = CreatorView()
    annotated = view._annotated_list_queryset().get(username="prolific")
    assert annotated.published_pages == 3
    assert annotated.fans_count == 5


# ---------------------------------------------------------------------------
# What counts as a follower
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_expired_subscriptions_are_not_followers(api_client, creator_factory):
    star = _make_creator(creator_factory, username="lapsing")
    _give_fans(creator_factory, star, 2)
    _give_fans(
        creator_factory, star, 4,
        expires=timezone.now() - timedelta(seconds=1),
    )

    assert _usernames(_list(api_client, min_followers=2)) == ["lapsing"]
    assert _usernames(_list(api_client, min_followers=3)) == []


@pytest.mark.django_db
def test_the_relation_has_a_direction(api_client, creator_factory):
    """Who you follow is not who follows you."""
    fanboy = _make_creator(creator_factory, username="fanboy")
    for _ in range(5):
        Subscription.objects.create(
            star=creator_factory(), fan=fanboy, expires=_active(),
        )

    assert _usernames(_list(api_client, min_followers=1)) == []


@pytest.mark.django_db
def test_zero_and_absent_are_both_no_op(api_client, creator_factory):
    _make_creator(creator_factory, username="quiet")

    assert _usernames(_list(api_client)) == ["quiet"]
    assert _usernames(_list(api_client, min_followers=0)) == ["quiet"]


@pytest.mark.django_db
def test_a_non_numeric_min_followers_is_rejected_not_ignored(
    api_client, creator_factory,
):
    """A filter that silently drops itself is how  stayed invisible."""
    _make_creator(creator_factory, username="somebody")

    response = api_client.get("/api/creator/", {"min_followers": "many"})
    assert response.status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize("value", ["-1", "2.5"])
def test_a_meaningless_min_followers_is_rejected(
    api_client, creator_factory, value,
):
    """Neither a negative nor a fractional follower count means anything.

    `-1` matters most: `fans_count >= -1` matches every creator, so a mangled
    or hand-built link would turn the filter off while the UI still displays
    an active filter tag -- the same "silently answers a different question"
    shape as the bug this file is about. The `min="0"` on the number input
    guards the app, not the API.
    """
    _make_creator(creator_factory, username="somebody")

    response = api_client.get("/api/creator/", {"min_followers": value})
    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_follower_ordering_is_stable_across_pages(api_client, creator_factory):
    """A tied ordering must still be a total order.

    `/creators` is page-number paginated and infinite-scrolled. Postgres may
    return tied rows in a different order for each page, so a creator can
    move from page 2 to page 1 between the two requests and be shown twice --
    or from page 1 to page 2 and never be shown at all. The page
    de-duplicates by username, which converts the duplicate into a silent
    omission: a directory quietly missing people.

    Follower sorts make this acute because every creator with no subscribers
    ties at 0, and most creators have no subscribers.
    """
    # 12 creators, all tied at zero fans -- the realistic worst case.
    expected = {f"tied-{i:02d}" for i in range(12)}
    for name in sorted(expected):
        _make_creator(creator_factory, username=name)

    seen = []
    for page in (1, 2, 3):
        response = api_client.get(
            "/api/creator/",
            {"ordering": "-fans_count", "page": page, "page_size": 5},
        )
        if response.status_code == 404:  # past the last page
            break
        assert response.status_code == 200, response.content
        seen.extend(_usernames(response))

    assert len(seen) == len(set(seen)), f"a creator was paginated twice: {seen}"
    assert set(seen) == expected, "a creator fell between two pages"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "params",
    [
        {"ordering": "-fans_count"},
        {"ordering": "fans_count"},
        # Not new in, but tied just as heavily and paginated the same
        # way: `-total` is what the default "Most Popular" sort sends, and it
        # is 0 for the same long tail of creators.
        {"ordering": "-total"},
        {"ordering": "-date_joined"},
        {"homeSort": "updated"},
        {"search": "someone"},
        {},  # the default discovery ranking
        # A rejected `ordering=` is the nastiest case: DRF drops the invalid
        # field and returns no ordering at all, while `get_queryset` has
        # already taken its "explicit ordering, don't force a default" branch
        # and handed back an UNORDERED queryset. A stale client asking for a
        # renamed field then page-number-paginates arbitrary rows.
        {"ordering": "not_a_field"},
        {"ordering": "-total,also_not_a_field"},
    ],
)
def test_every_paginated_ordering_ends_in_a_unique_tie_breaker(
    api_client, creator_factory, rf, params,
):
    """The structural half of the test above.

    A tie-ordering bug only *sometimes* reproduces -- with a small table
    Postgres will happily return the same arbitrary order twice and the
    behavioural test passes on a broken build. This asserts the property
    itself: whatever ordering the directory ends up applying, its last term
    is the primary key, so no two rows can compare equal.
    """
    from dj.apps.g12f.views.creator import CreatorView

    _make_creator(creator_factory, username="someone")

    view = CreatorView()
    view.action_map = {'get': 'list'}
    view.request = view.initialize_request(rf.get("/api/creator/", params))
    view.kwargs = {}
    assert view.action == 'list'
    qs = view.filter_queryset(view.get_queryset())

    order = qs.query.order_by or qs.query.get_meta().ordering
    assert order, f"{params} produced an unordered paginated queryset"
    assert order[-1].lstrip('-') in ('pk', 'id'), (
        f"{params} ordered by {order}, whose last term is not unique -- tied "
        "rows can swap between pages"
    )


# ---------------------------------------------------------------------------
# Server-side: the count and the pagination are the real ones
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_paginated_count_reflects_the_filter(api_client, creator_factory):
    """The client-side version could only reject rows already fetched, so the
    "Showing N creators" number and every pagination decision were computed
    from whatever survived on the current page."""
    for i in range(4):
        star = _make_creator(creator_factory, username=f"popular-{i}")
        _give_fans(creator_factory, star, 3)
    for i in range(6):
        _make_creator(creator_factory, username=f"unknown-{i}")

    body = _list(api_client, min_followers=1).json()
    assert body["count"] == 4
    assert len(body["results"]) == 4


@pytest.mark.django_db
def test_filter_composes_with_search_and_verification(
    api_client, creator_factory,
):
    hit = _make_creator(
        creator_factory, username="zed-verified", is_verified=True)
    _give_fans(creator_factory, hit, 3)
    unverified = _make_creator(
        creator_factory, username="zed-plain", is_verified=False)
    _give_fans(creator_factory, unverified, 3)
    thin = _make_creator(
        creator_factory, username="zed-thin", is_verified=True)
    _give_fans(creator_factory, thin, 1)

    names = _usernames(
        _list(api_client, min_followers=2, is_verified="true", search="zed"))
    assert names == ["zed-verified"]


# ---------------------------------------------------------------------------
# Ordering — "Most Followers" was the same bug wearing a different hat
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_ordering_by_fans_count_ranks_by_subscribers_not_funding(
    api_client, creator_factory,
):
    """`ordering=-fans_count` is what the directory's "Most Followers" sort
    now sends. It used to send `-total`, so the most-followed creator ranked
    below anyone who had simply been funded more."""
    loved = _make_creator(creator_factory, username="loved", total=0)
    _give_fans(creator_factory, loved, 5)

    funded = _make_creator(creator_factory, username="funded", total=1000)
    _give_fans(creator_factory, funded, 1)

    response = api_client.get("/api/creator/", {"ordering": "-fans_count"})
    assert response.status_code == 200
    assert _usernames(response) == ["loved", "funded"]

    response = api_client.get("/api/creator/", {"ordering": "fans_count"})
    assert _usernames(response) == ["funded", "loved"]


# ---------------------------------------------------------------------------
# Blast radius: the detail route runs the same filter backend
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_detail_route_tolerates_a_stray_min_followers_param(
    api_client, creator_factory,
):
    """`get_object()` runs `filter_queryset()`, so `CreatorFilter` is live on
    `/api/creator/<username>/` too. Without the annotation on the retrieve
    queryset, any client that carried the directory's query string across to a
    profile link would 500 a public page."""
    star = _make_creator(creator_factory, username="detailed")
    _give_fans(creator_factory, star, 3)

    response = api_client.get("/api/creator/detailed/", {"min_followers": 1})
    assert response.status_code == 200
    assert response.json()["username"] == "detailed"

    # And the filter is honoured, not swallowed: asking for more followers
    # than the creator has means the row does not match.
    response = api_client.get("/api/creator/detailed/", {"min_followers": 99})
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Cost
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_follower_count_does_not_join_the_directory_query(creator_factory):
    """`fans_count` must not add a second one-to-many JOIN, and must not land
    in the GROUP BY.

    Correctness and cost are separate failures here and this pins the cost
    one, because it is invisible in every behavioural test above.
    ``_annotated_list_queryset`` already LEFT JOINs zpage, so a
    ``Count('subscriptions_to_creator_set', distinct=True)`` -- which returns
    the *right number* and passes every other test in this file -- makes each
    creator contribute ``pages x fans`` rows. Measured on this exact query at
    300 creators / 1.8k pages / 2.2k subscriptions: 5.3 ms without the
    annotation, 277 ms with the joined Count (155k intermediate rows, 19 MB
    spilled to disk), 9.9 ms with the correlated subquery. It scales as the
    product, so it degrades fastest for prolific, popular creators -- the ones
    the directory exists to show -- on a page the SSR pod renders anonymously
    on every visit.

    The GROUP BY half matters just as much: Django puts selected
    non-aggregates in the group key by default, and a correlated subquery in
    GROUP BY is re-evaluated once per pre-aggregation row instead of once per
    creator. That alone was 45 ms vs 9.9 ms here.
    """
    from dj.apps.g12f.views.creator import CreatorView

    qs = CreatorView()._annotated_list_queryset()
    sql = str(qs.query)

    # The subscription table may only appear inside the correlated subquery
    # (`FROM "g12f_subscription"`), never as a join against the outer row.
    assert 'JOIN "g12f_subscription"' not in sql, (
        "fans_count fanned the directory query out into a "
        "zPage x Subscription cross product"
    )
    assert 'FROM "g12f_subscription"' in sql, "the count went missing entirely"

    group_by = sql.split("GROUP BY", 1)
    assert len(group_by) == 2, "expected the directory query to aggregate"
    assert "g12f_subscription" not in group_by[1], (
        "the fan-count subquery is in the GROUP BY, so Postgres re-runs it "
        "once per (creator, zPage) row"
    )
    # `_ActiveFansCount.get_group_by_cols()` returns [] on the grounds that
    # the subquery is functionally dependent on the Creator pk. That is only
    # sound while the pk is actually in the group key, so pin it: if this
    # queryset is ever regrouped by something else, the omission stops being
    # a free optimisation and starts being wrong SQL.
    assert '"g12f_creator"."id"' in group_by[1], (
        "the directory query no longer groups by the Creator pk, which is the "
        "precondition _ActiveFansCount relies on to skip the GROUP BY"
    )


@pytest.mark.django_db
def test_the_count_rides_on_the_list_query(api_client, creator_factory):
    """No per-creator and no per-subscriber query.

    A `fans_count` that degraded into a Python-side count would show up as
    query growth proportional to the number of rows on the page.
    """
    def measure(n_creators, n_fans):
        Subscription.objects.all().delete()
        Creator.objects.exclude(pk__in=[]).delete()
        for i in range(n_creators):
            star = _make_creator(creator_factory, username=f"c{i}")
            _give_fans(creator_factory, star, n_fans)
        with CaptureQueriesContext(connection) as ctx:
            _list(api_client, min_followers=1)
        return len(ctx.captured_queries)

    small = measure(1, 2)
    large = measure(10, 5)
    assert small == large, (
        f"query count grew with the page: {small} -> {large}"
    )
