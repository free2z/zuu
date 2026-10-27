"""Tests for the Series API (``/api/g12f/series/...``), against real Postgres.

Covers the auth boundary of ``MySeriesViewSet`` — regression coverage for
issue, where an anonymous ``GET /api/g12f/series/mine`` 500-ed because
``IsCreator`` only implements ``has_object_permission`` (so the list action
passed the permission gate and then ran
``Series.objects.filter(creator=AnonymousUser)`` → ``ValueError``).

Also covers ownership isolation (a creator only sees / can only mutate their
own series).
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from django.db import connection
from django.db.utils import IntegrityError
from django.test.utils import CaptureQueriesContext

from dj.apps.g12f.models import zPage, Series, PageOrder


def _page(creator, vanity="p"):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=f"{vanity}-{uuid.uuid4().hex[:8]}",
        title="A page",
        content="Some content.",
    )


def _series(creator, name="S", pages=()):
    series = Series.objects.create(creator=creator, name=name)
    for order, page in enumerate(pages):
        PageOrder.objects.create(series=series, page=page, order=order)
    return series


# --------------------------------------------------------------------------
#  anonymous access must not 500
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_series_mine_anonymous_is_rejected_not_500(api_client):
    response = api_client.get("/api/g12f/series/mine/")
    # Must be a clean auth rejection, never a 500.
    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_series_mine_create_anonymous_is_rejected_not_500(api_client):
    response = api_client.post("/api/g12f/series/mine/", {}, format="json")
    assert response.status_code in (401, 403), response.content


# --------------------------------------------------------------------------
# Ownership isolation
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_series_mine_lists_only_own_series(api_client, creator_factory):
    me = creator_factory()
    other = creator_factory()
    mine = _series(me, "mine")
    _series(other, "theirs")

    api_client.force_authenticate(user=me)
    response = api_client.get("/api/g12f/series/mine/")

    assert response.status_code == 200, response.content
    data = response.json()
    ids = {row["id"] for row in data}
    assert str(mine.id) in ids
    assert len(ids) == 1


@pytest.mark.django_db
def test_series_mine_paginates_all_owned_series_in_stable_order(
    api_client, creator_factory
):
    me = creator_factory()
    series = [_series(me, f"series-{index}") for index in range(13)]
    created_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for index, item in enumerate(series):
        Series.objects.filter(pk=item.pk).update(
            created_at=created_start + timedelta(minutes=index)
        )

    api_client.force_authenticate(user=me)
    first_page = api_client.get("/api/g12f/series/mine/?page=1")
    second_page = api_client.get("/api/g12f/series/mine/?page=2")

    assert first_page.status_code == second_page.status_code == 200
    assert len(first_page.json()) == 12
    assert len(second_page.json()) == 1
    assert [row["id"] for row in first_page.json() + second_page.json()] == [
        str(item.id) for item in series
    ]


@pytest.mark.django_db
def test_series_mine_create_assigns_current_user(api_client, creator_factory):
    me = creator_factory()
    page = _page(me)

    api_client.force_authenticate(user=me)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {
            "name": "New series",
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 201, response.content
    series = Series.objects.get(name="New series")
    assert series.creator == me


@pytest.mark.django_db
def test_series_create_cannot_spoof_creator(api_client, creator_factory):
    """`creator` is read-only; a client-supplied creator must be ignored."""
    me = creator_factory()
    victim = creator_factory()
    page = _page(me)

    api_client.force_authenticate(user=me)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {
            "name": "Spoofed",
            "creator": victim.id,
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 201, response.content
    series = Series.objects.get(name="Spoofed")
    assert series.creator == me


@pytest.mark.django_db
def test_cannot_update_another_creators_series(api_client, creator_factory):
    owner = creator_factory()
    attacker = creator_factory()
    victim_series = _series(owner, "victim")
    page = _page(attacker)

    api_client.force_authenticate(user=attacker)
    response = api_client.put(
        f"/api/g12f/series/mine/{victim_series.id}/",
        {
            "name": "hijacked",
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code in (403, 404), response.content
    victim_series.refresh_from_db()
    assert victim_series.name == "victim"


@pytest.mark.django_db
def test_cannot_delete_another_creators_series(api_client, creator_factory):
    owner = creator_factory()
    attacker = creator_factory()
    victim_series = _series(owner, "victim")

    api_client.force_authenticate(user=attacker)
    response = api_client.delete(
        f"/api/g12f/series/mine/{victim_series.id}/"
    )

    assert response.status_code in (403, 404), response.content
    assert Series.objects.filter(pk=victim_series.id).exists()


# --------------------------------------------------------------------------
#  IDOR: pageorder_set entries must resolve only to your OWN pages
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_update_cannot_delete_another_creators_pageorder_rows(
    api_client, creator_factory
):
    """The bug: `free2zaddr` is public and `update()` calls
    `page.pageorder_set.all().delete()` on whatever page it resolves. An
    attacker naming the victim's page wiped the victim's series membership."""
    attacker = creator_factory()
    victim = creator_factory()

    victim_page = _page(victim, "victim")
    victim_series = _series(victim, "victim series", pages=[victim_page])
    victim_rows = set(
        PageOrder.objects.filter(series=victim_series).values_list("id", flat=True)
    )
    assert victim_rows

    attacker_series = _series(attacker, "attacker series")

    api_client.force_authenticate(user=attacker)
    response = api_client.put(
        f"/api/g12f/series/mine/{attacker_series.id}/",
        {
            "name": "attacker series",
            "pageorder_set": [
                {"page": {"free2zaddr": victim_page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    # The victim's rows are untouched, and their page was not stolen.
    assert (
        set(
            PageOrder.objects.filter(series=victim_series).values_list(
                "id", flat=True
            )
        )
        == victim_rows
    )
    assert not PageOrder.objects.filter(
        series=attacker_series, page=victim_page
    ).exists()


@pytest.mark.django_db
def test_create_cannot_reference_another_creators_page(
    api_client, creator_factory
):
    attacker = creator_factory()
    victim = creator_factory()
    victim_page = _page(victim, "victim")
    victim_series = _series(victim, "victim series", pages=[victim_page])

    api_client.force_authenticate(user=attacker)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {
            "name": "stolen",
            "pageorder_set": [
                {"page": {"free2zaddr": victim_page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    assert not Series.objects.filter(name="stolen").exists()
    assert PageOrder.objects.filter(series=victim_series).count() == 1


@pytest.mark.django_db
def test_unknown_free2zaddr_is_400_not_500(api_client, creator_factory):
    """Previously an uncaught zPage.DoesNotExist → 500."""
    me = creator_factory()
    api_client.force_authenticate(user=me)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {
            "name": "nope",
            "pageorder_set": [
                {"page": {"free2zaddr": str(uuid.uuid4())}, "order": 0}
            ],
        },
        format="json",
    )
    assert response.status_code == 400, response.content


@pytest.mark.django_db
@pytest.mark.parametrize(
    "entry",
    [
        {"order": 0},                                   # no page at all
        {"page": "not-an-object", "order": 0},          # page is not a dict
        {"page": {}, "order": 0},                       # no free2zaddr
        {"page": {"free2zaddr": None}, "order": 0},     # null free2zaddr
    ],
)
def test_malformed_pageorder_entry_is_400_not_500(
    api_client, creator_factory, entry
):
    me = creator_factory()
    api_client.force_authenticate(user=me)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {"name": "junk", "pageorder_set": [entry]},
        format="json",
    )
    assert response.status_code == 400, response.content


@pytest.mark.django_db
@pytest.mark.parametrize("order", ["abc", -1, None])
def test_bad_order_value_is_400_not_500(api_client, creator_factory, order):
    me = creator_factory()
    page = _page(me)
    api_client.force_authenticate(user=me)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {
            "name": "bad order",
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": order}
            ],
        },
        format="json",
    )
    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_owner_can_still_reorder_their_own_pages(api_client, creator_factory):
    """Regression guard: the ownership scoping must not break the happy path."""
    me = creator_factory()
    a, b = _page(me, "a"), _page(me, "b")
    series = _series(me, "mine", pages=[a, b])

    api_client.force_authenticate(user=me)
    response = api_client.put(
        f"/api/g12f/series/mine/{series.id}/",
        {
            "name": "reordered",
            "pageorder_set": [
                {"page": {"free2zaddr": b.free2zaddr}, "order": 0},
                {"page": {"free2zaddr": a.free2zaddr}, "order": 1},
            ],
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    order = list(
        PageOrder.objects.filter(series=series)
        .order_by("order")
        .values_list("page__free2zaddr", flat=True)
    )
    assert order == [b.free2zaddr, a.free2zaddr]


@pytest.mark.django_db
def test_update_does_not_detach_page_from_another_creators_series(
    api_client, creator_factory
):
    """Owning the page does not imply owning every PageOrder row on it.

    There is no DB constraint tying Series.creator to zPage.creator, so a
    legacy cross-owner row can exist. Reordering your own series must not
    delete someone else's membership row for that page.
    """
    me = creator_factory()
    other = creator_factory()
    page = _page(me, "shared")

    # Legacy cross-owner association (created directly, as history would).
    other_series = _series(other, "theirs", pages=[page])
    other_row = PageOrder.objects.get(series=other_series, page=page)

    my_series = _series(me, "mine")

    api_client.force_authenticate(user=me)
    response = api_client.put(
        f"/api/g12f/series/mine/{my_series.id}/",
        {
            "name": "mine",
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    assert PageOrder.objects.filter(pk=other_row.pk).exists()
    assert PageOrder.objects.filter(series=my_series, page=page).exists()


# --------------------------------------------------------------------------
#  one series per creator per page, and no page twice in one series
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_detaches_the_page_from_my_other_series(
    api_client, creator_factory
):
    """ item 3: `create` must detach like `update` already does.

    Before this, POSTing a new series containing a page that was already in
    one of my series left BOTH memberships — the public API's own route to
    the duplicate state behind the  500.
    """
    me = creator_factory()
    page = _page(me)
    old = _series(me, "old", pages=[page])

    api_client.force_authenticate(user=me)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {
            "name": "new",
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 201, response.content
    new = Series.objects.get(name="new")
    assert PageOrder.objects.filter(page=page).count() == 1
    assert PageOrder.objects.filter(series=new, page=page).exists()
    assert not PageOrder.objects.filter(series=old, page=page).exists()
    # The old series itself survives — only the membership moved.
    assert Series.objects.filter(pk=old.pk).exists()


@pytest.mark.django_db
def test_create_does_not_detach_page_from_another_creators_series(
    api_client, creator_factory
):
    """The hard boundary: a creator can never modify another creator's series.

    Mirror of `test_update_does_not_detach_page_from_another_creators_series`
    for the `create` path. Owning the page is not authority over someone
    else's series composition, so the detach in `create` is scoped to my own
    series exactly as `update`'s is — an unscoped
    `page.pageorder_set.all().delete()` here would silently delete an entry
    out of a stranger's curated series (the reason PR  was rejected).
    """
    me = creator_factory()
    other = creator_factory()
    page = _page(me, "shared")

    # Legacy cross-owner association (created directly, as history would).
    other_series = _series(other, "theirs", pages=[page])
    other_row = PageOrder.objects.get(series=other_series, page=page)

    api_client.force_authenticate(user=me)
    response = api_client.post(
        "/api/g12f/series/mine/",
        {
            "name": "mine",
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 201, response.content
    assert PageOrder.objects.filter(pk=other_row.pk).exists()
    assert PageOrder.objects.filter(
        series__name="mine", page=page).exists()


@pytest.mark.django_db
def test_update_moves_the_page_out_of_my_other_series(
    api_client, creator_factory
):
    """The pre-existing `update` behaviour, pinned so the refactor keeps it."""
    me = creator_factory()
    page = _page(me)
    old = _series(me, "old", pages=[page])
    target = _series(me, "target")

    api_client.force_authenticate(user=me)
    response = api_client.put(
        f"/api/g12f/series/mine/{target.id}/",
        {
            "name": "target",
            "pageorder_set": [
                {"page": {"free2zaddr": page.free2zaddr}, "order": 0}
            ],
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    assert PageOrder.objects.filter(page=page).count() == 1
    assert PageOrder.objects.filter(series=target, page=page).exists()
    assert not PageOrder.objects.filter(series=old, page=page).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["post", "put"])
def test_same_page_twice_in_one_payload_is_400_not_500(
    api_client, creator_factory, method
):
    """ warned the constraint alone trades one crash for another.

    With `unique(series, page)` in place, two entries naming the same page
    would reach INSERT as an IntegrityError -> 500. It is the client's
    malformed list, so it is a 400 — and no half-written series is left
    behind.
    """
    me = creator_factory()
    page = _page(me)
    existing = _page(me, "existing")
    series = _series(me, "mine", pages=[existing])

    payload = {
        "name": "dupes",
        "pageorder_set": [
            {"page": {"free2zaddr": page.free2zaddr}, "order": 0},
            {"page": {"free2zaddr": page.free2zaddr}, "order": 1},
        ],
    }

    api_client.force_authenticate(user=me)
    if method == "post":
        response = api_client.post(
            "/api/g12f/series/mine/", payload, format="json")
    else:
        response = api_client.put(
            f"/api/g12f/series/mine/{series.id}/", payload, format="json")

    assert response.status_code == 400, response.content
    assert not Series.objects.filter(name="dupes").exists()
    # The PUT target was not wiped on the way to the error.
    assert PageOrder.objects.filter(series=series, page=existing).exists()


@pytest.mark.django_db
def test_reordering_the_same_pages_is_not_a_duplicate(
    api_client, creator_factory
):
    """Guard: the payload check must reject repeats, not re-submissions.

    `update` deletes the series' rows before reinserting, so resubmitting the
    pages already in the series must still succeed under the new constraint.
    """
    me = creator_factory()
    a, b = _page(me, "a"), _page(me, "b")
    series = _series(me, "mine", pages=[a, b])

    api_client.force_authenticate(user=me)
    response = api_client.put(
        f"/api/g12f/series/mine/{series.id}/",
        {
            "name": "mine",
            "pageorder_set": [
                {"page": {"free2zaddr": a.free2zaddr}, "order": 0},
                {"page": {"free2zaddr": b.free2zaddr}, "order": 1},
            ],
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    assert PageOrder.objects.filter(series=series).count() == 2


@pytest.mark.django_db
@pytest.mark.parametrize("method", ["post", "put"])
def test_membership_writes_lock_the_pages_before_touching_pageorder(
    api_client, creator_factory, method
):
    """Pin the lock order that keeps the invariant safe under concurrency.

    `unique(series, page)` cannot see the race it needs to: two simultaneous
    writes putting one page into two DIFFERENT series each delete nothing and
    then insert a different `(series, page)` pair, both legal. The row locks
    are what serialize them — and they must be taken BEFORE any PageOrder row
    is deleted, or a wipe-then-lock ordering deadlocks against a
    lock-then-delete one.

    Asserted at the SQL level because the alternative — real concurrent
    threads — is a hang risk in CI, and this is precisely the kind of thing a
    later refactor drops silently.
    """
    me = creator_factory()
    a, b = _page(me, "a"), _page(me, "b")
    series = _series(me, "mine", pages=[a])

    payload = {
        "name": "mine",
        "pageorder_set": [
            {"page": {"free2zaddr": b.free2zaddr}, "order": 0}
        ],
    }

    api_client.force_authenticate(user=me)
    with CaptureQueriesContext(connection) as captured:
        if method == "post":
            response = api_client.post(
                "/api/g12f/series/mine/", payload, format="json")
            assert response.status_code == 201, response.content
        else:
            response = api_client.put(
                f"/api/g12f/series/mine/{series.id}/", payload, format="json")
            assert response.status_code == 200, response.content

    sql = [q["sql"] for q in captured.captured_queries]
    locks = [
        i for i, q in enumerate(sql)
        if "FOR NO KEY UPDATE" in q and "g12f_zpage" in q
    ]
    assert locks, f"no zPage row lock was taken: {sql}"

    deletes = [
        i for i, q in enumerate(sql)
        if q.lstrip().upper().startswith("DELETE") and "g12f_pageorder" in q
    ]
    if deletes:
        assert min(locks) < min(deletes), (
            "PageOrder rows were deleted before the pages were locked — "
            f"that is the deadlock ordering: {sql}"
        )


@pytest.mark.django_db
def test_order_beyond_int32_is_400_not_500(api_client, creator_factory):
    """`order` is a Postgres int4; an over-large value must not reach INSERT."""
    me = creator_factory()
    a, b = _page(me, "a"), _page(me, "b")
    series = _series(me, "mine", pages=[a, b])

    api_client.force_authenticate(user=me)
    response = api_client.put(
        f"/api/g12f/series/mine/{series.id}/",
        {
            "name": "mine",
            "pageorder_set": [
                {"page": {"free2zaddr": a.free2zaddr}, "order": 2147483648}
            ],
        },
        format="json",
    )

    assert response.status_code == 400, response.content
    # And the pre-existing membership survived — no half-applied wipe.
    assert PageOrder.objects.filter(series=series).count() == 2


@pytest.mark.django_db
def test_failed_update_does_not_leave_the_series_empty(
    api_client, creator_factory, mocker
):
    """update() is delete-then-reinsert; a mid-flight failure must roll back."""
    me = creator_factory()
    a, b = _page(me, "a"), _page(me, "b")
    series = _series(me, "mine", pages=[a, b])

    mocker.patch(
        "dj.apps.g12f.serializers.series.PageOrder.objects.create",
        side_effect=RuntimeError("boom"),
    )

    api_client.force_authenticate(user=me)
    with pytest.raises(RuntimeError):
        api_client.put(
            f"/api/g12f/series/mine/{series.id}/",
            {
                "name": "mine",
                "pageorder_set": [
                    {"page": {"free2zaddr": a.free2zaddr}, "order": 0}
                ],
            },
            format="json",
        )

    assert PageOrder.objects.filter(series=series).count() == 2


# --------------------------------------------------------------------------
#  GET /api/g12f/zpage/<free2zaddr>/series/ must never 500
#
# `retrieve` filters across `pageorder`, a multi-valued reverse relation, so
# the JOIN emits one row per matching PageOrder and `get()` raised
# MultipleObjectsReturned. Nothing at the DB level prevents either duplicate:
# PageOrder has no unique constraint on `page` or on `(series, page)`.
# --------------------------------------------------------------------------


def _zpage_series_url(free2zaddr):
    return f"/api/g12f/zpage/{free2zaddr}/series/"


def _backdate(series, when):
    """`created_at` is auto_now_add, so it can only be set via UPDATE."""
    Series.objects.filter(pk=series.pk).update(created_at=when)
    series.refresh_from_db()
    return series


@pytest.mark.django_db
def test_zpage_in_two_series_returns_one_not_500(api_client, creator_factory):
    """The prod traceback: one zPage genuinely belonging to two Series.

    the public API no longer *mints* this state — `create` detaches
    like `update` does — but the state is still legal and must still resolve:
    there is deliberately no `unique(page)` constraint, because enforcing one
    would mean deleting rows out of other creators' series. So legacy rows,
    and any genuine cross-owner membership, still fan the JOIN out here.
    """
    me = creator_factory()
    page = _page(me)
    zPage.objects.filter(pk=page.pk).update(is_published=True)
    first = _series(me, "first", pages=[page])
    second = _series(me, "second", pages=[page])
    assert PageOrder.objects.filter(page=page).count() == 2

    response = api_client.get(_zpage_series_url(page.free2zaddr))

    assert response.status_code == 200, response.content
    assert response.json()["id"] in {str(first.id), str(second.id)}


@pytest.mark.django_db
def test_zpage_in_two_series_picks_the_oldest_deterministically(
    api_client, creator_factory
):
    """An unordered `LIMIT 1` could return a different series per request.

    The endpoint's contract is a single series, so the choice must be stable
    across requests and across replicas — the oldest series wins.
    """
    me = creator_factory()
    page = _page(me)
    zPage.objects.filter(pk=page.pk).update(is_published=True)
    older = _backdate(
        _series(me, "older", pages=[page]),
        datetime(2020, 1, 1, tzinfo=timezone.utc),
    )
    _backdate(
        _series(me, "newer", pages=[page]),
        datetime(2024, 1, 1, tzinfo=timezone.utc),
    )

    seen = {
        api_client.get(_zpage_series_url(page.free2zaddr)).json()["id"]
        for _ in range(3)
    }

    assert seen == {str(older.id)}


@pytest.mark.django_db(transaction=True)
def test_zpage_cannot_be_listed_twice_in_one_series(api_client, creator_factory):
    """The pure join fan-out is now unrepresentable.

    This used to be `test_zpage_listed_twice_in_one_series_returns_that_
    series`: it built ONE series with TWO PageOrder rows for the same page,
    which made the reverse-relation JOIN emit the same Series twice and
    `get()` raise MultipleObjectsReturned -> 500. `.distinct()` hid the
    symptom; `g12f_pageorder_unique_series_page` removes the state, so the
    old test's *setup* is what is asserted here instead. The `.distinct()` in
    the view stays as defence in depth -- a page legitimately in two
    *different* series still fans out.
    """
    me = creator_factory()
    page = _page(me)
    series = _series(me, "dupes", pages=[page])

    with pytest.raises(IntegrityError):
        PageOrder.objects.create(series=series, page=page, order=1)


@pytest.mark.django_db
def test_free2zaddr_beats_a_squatted_vanity(api_client, creator_factory):
    """A vanity that equals someone else's free2zaddr must not hijack them.

    `vanity` and `free2zaddr` are unique per column but not across them, and
    `validate_vanity` only checks vanity against other vanities — so anyone
    can point their vanity at a victim's public free2zaddr. With a single
    `Q(free2zaddr) | Q(vanity)` + "oldest wins", the squatter's older series
    would be served for the victim's own address. The free2zaddr is the page's
    identity; the vanity is a nickname. Identity wins.
    """
    victim = creator_factory()
    squatter = creator_factory()

    victim_page = _page(victim)
    zPage.objects.filter(pk=victim_page.pk).update(is_published=True)
    victim_series = _series(victim, "victim series", pages=[victim_page])
    # The squatter's series is older, so ordering alone would prefer it.
    _backdate(victim_series, datetime(2024, 1, 1, tzinfo=timezone.utc))

    squatter_page = _page(squatter)
    zPage.objects.filter(pk=squatter_page.pk).update(
        vanity=victim_page.free2zaddr, is_published=True)
    squatter_series = _series(squatter, "squatter series")
    PageOrder.objects.create(
        series=squatter_series, page=squatter_page, order=0)
    _backdate(squatter_series, datetime(2020, 1, 1, tzinfo=timezone.utc))

    response = api_client.get(_zpage_series_url(victim_page.free2zaddr))

    assert response.status_code == 200, response.content
    assert response.json()["id"] == str(victim_series.id)


@pytest.mark.django_db
def test_zpage_series_lookup_by_vanity_still_works(
    api_client, creator_factory
):
    """The `vanity` half of the OR must survive the rewrite."""
    me = creator_factory()
    page = _page(me)
    zPage.objects.filter(pk=page.pk).update(is_published=True)
    series = _series(me, "by vanity", pages=[page])

    response = api_client.get(_zpage_series_url(page.vanity))

    assert response.status_code == 200, response.content
    assert response.json()["id"] == str(series.id)


@pytest.mark.django_db
def test_zpage_with_no_series_is_404(api_client, creator_factory):
    """`get_object_or_404` became an explicit Http404 — same contract."""
    me = creator_factory()
    page = _page(me)

    response = api_client.get(_zpage_series_url(page.free2zaddr))

    assert response.status_code == 404, response.content


@pytest.mark.django_db
def test_zpage_series_hides_drafts_but_creator_can_manage_membership(
    api_client, creator_factory,
):
    creator = creator_factory()
    page = _page(creator)
    series = _series(creator, "draft series", pages=[page])

    anonymous_response = api_client.get(_zpage_series_url(page.free2zaddr))
    assert anonymous_response.status_code == 404

    # Drafts remain available through the authenticated creator editing API.
    api_client.force_authenticate(user=creator)
    creator_response = api_client.get("/api/g12f/series/mine/")
    assert creator_response.status_code == 200
    creator_series = next(
        row for row in creator_response.json()
        if row["id"] == str(series.id)
    )
    assert creator_series["pageorder_set"][0]["page"]["free2zaddr"] == (
        page.free2zaddr
    )

    zPage.objects.filter(pk=page.pk).update(is_published=True)
    api_client.force_authenticate(user=None)
    public_response = api_client.get(_zpage_series_url(page.free2zaddr))
    assert public_response.status_code == 200
    assert public_response.json()["id"] == str(series.id)


@pytest.mark.django_db
def test_unknown_zpage_is_404(api_client):
    response = api_client.get(_zpage_series_url(uuid.uuid4()))

    assert response.status_code == 404, response.content


# --------------------------------------------------------------------------
#  the clear-zpage deletion target lives in the path, not a query string
# --------------------------------------------------------------------------


def _clear_url(free2zaddr):
    return f"/api/g12f/series/clear-zpage/{free2zaddr}/"


#The deprecated alias kept for one release so cached classic bundles keep
#working. Delete this (and its tests) with the classic UI.
_LEGACY_CLEAR_URL = "/api/g12f/series/clear-zpage/"


@pytest.mark.django_db
def test_clear_anonymous_is_refused(api_client):
    """ made `permission_classes` actually enforced on this view (it was a
    plain `django.views.View`, where the attribute is inert). Moving the target
    into the path must not quietly undo that."""
    response = api_client.delete(_clear_url(uuid.uuid4()))

    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_clear_legacy_query_form_anonymous_is_refused(api_client):
    response = api_client.delete(f"{_LEGACY_CLEAR_URL}?free2zaddr={uuid.uuid4()}")

    assert response.status_code in (401, 403), response.content


@pytest.mark.django_db
def test_owner_can_clear_their_page_from_every_series(
    api_client, creator_factory
):
    me = creator_factory()
    page = _page(me)
    other_page = _page(me, "other")
    first = _series(me, "first", pages=[page, other_page])
    _series(me, "second", pages=[page])
    assert PageOrder.objects.filter(page=page).count() == 2

    api_client.force_authenticate(user=me)
    response = api_client.delete(_clear_url(page.free2zaddr))

    assert response.status_code == 200, response.content
    assert response.json() == {"status": "success"}
    assert not PageOrder.objects.filter(page=page).exists()
    # Only this page is detached: the rest of the series survives.
    assert PageOrder.objects.filter(series=first, page=other_page).exists()
    assert Series.objects.filter(pk=first.pk).exists()


@pytest.mark.django_db
def test_clear_is_idempotent(api_client, creator_factory):
    """A page that is in no series clears successfully rather than 404-ing."""
    me = creator_factory()
    page = _page(me)

    api_client.force_authenticate(user=me)
    response = api_client.delete(_clear_url(page.free2zaddr))

    assert response.status_code == 200, response.content


@pytest.mark.django_db
def test_cannot_clear_another_creators_page(api_client, creator_factory):
    owner = creator_factory()
    attacker = creator_factory()
    page = _page(owner)
    _series(owner, "victim", pages=[page])

    api_client.force_authenticate(user=attacker)
    response = api_client.delete(_clear_url(page.free2zaddr))

    # 404, not 403: indistinguishable from "no such page", so this cannot be
    # used to probe for other creators' free2zaddrs.
    assert response.status_code == 404, response.content
    assert PageOrder.objects.filter(page=page).count() == 1


@pytest.mark.django_db
def test_unknown_free2zaddr_clear_is_404(api_client, creator_factory):
    me = creator_factory()

    api_client.force_authenticate(user=me)
    response = api_client.delete(_clear_url(uuid.uuid4()))

    assert response.status_code == 404, response.content


@pytest.mark.django_db
def test_missing_target_is_400_not_404(api_client, creator_factory):
    """An absent identifier is a malformed request, not a missing resource.

    Before  this fell through to a lookup on `''` and 404-ed, which is
    indistinguishable from "your page is gone".
    """
    me = creator_factory()

    api_client.force_authenticate(user=me)
    response = api_client.delete(_LEGACY_CLEAR_URL)

    assert response.status_code == 400, response.content
    assert "free2zaddr" in response.json()


@pytest.mark.django_db
@pytest.mark.parametrize("value", ["", "%20", "+"])
def test_blank_target_is_400_not_404(api_client, creator_factory, value):
    me = creator_factory()

    api_client.force_authenticate(user=me)
    response = api_client.delete(f"{_LEGACY_CLEAR_URL}?free2zaddr={value}")

    assert response.status_code == 400, response.content


@pytest.mark.django_db
def test_legacy_query_form_still_works_for_the_owner(
    api_client, creator_factory
):
    """The cached classic bundle must keep working for one release."""
    me = creator_factory()
    page = _page(me)
    _series(me, "s", pages=[page])

    api_client.force_authenticate(user=me)
    response = api_client.delete(
        f"{_LEGACY_CLEAR_URL}?free2zaddr={page.free2zaddr}")

    assert response.status_code == 200, response.content
    assert not PageOrder.objects.filter(page=page).exists()


@pytest.mark.django_db
def test_legacy_query_form_cannot_clear_another_creators_page(
    api_client, creator_factory
):
    owner = creator_factory()
    attacker = creator_factory()
    page = _page(owner)
    _series(owner, "victim", pages=[page])

    api_client.force_authenticate(user=attacker)
    response = api_client.delete(
        f"{_LEGACY_CLEAR_URL}?free2zaddr={page.free2zaddr}")

    assert response.status_code == 404, response.content
    assert PageOrder.objects.filter(page=page).count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize("count", [12, 24])
def test_series_full_final_page_ends_with_404(api_client, creator_factory, count):
    me = creator_factory()
    for index in range(count):
        _series(me, f"full-{index}")
    api_client.force_authenticate(user=me)
    last = api_client.get(f"/api/g12f/series/mine/?page={count // 12}")
    exhausted = api_client.get(f"/api/g12f/series/mine/?page={count // 12 + 1}")
    assert last.status_code == 200
    assert len(last.json()) == 12
    assert exhausted.status_code == 404


def _guarded_payload(name, existing, incoming):
    def rows(pages):
        return [{"page": {"free2zaddr": page.free2zaddr}, "order": index}
                for index, page in enumerate(pages)]
    return {"name": name, "pageorder_set": rows(incoming),
            "expected_name": name, "expected_pageorder_set": rows(existing)}


@pytest.mark.django_db
@pytest.mark.parametrize("change", ["add", "remove", "reorder", "rename"])
def test_stale_series_snapshot_rejected_without_mutation(
    api_client, creator_factory, change
):
    me = creator_factory()
    a, b, c = [_page(me, name) for name in ["a", "b", "c"]]
    series = _series(me, "series", pages=[a, b])
    stale = _guarded_payload("series", [a, b], [a, b, c])
    api_client.force_authenticate(user=me)
    latest = {"add": [a, b, c], "remove": [a], "reorder": [b, a], "rename": [a, b]}[change]
    winning = _guarded_payload("series", [a, b], latest)
    if change == "rename":
        winning["name"] = "renamed"
    url = f"/api/g12f/series/mine/{series.id}/"
    assert api_client.put(url, winning, format="json").status_code == 200
    response = api_client.put(url, stale, format="json")
    assert response.status_code == 409, response.content
    assert list(series.pageorder_set.order_by("order").values_list("page_id", flat=True)) == [p.pk for p in latest]
    series.refresh_from_db()
    assert series.name == winning["name"]


@pytest.mark.django_db(transaction=True)
def test_competing_series_snapshots_compare_after_database_lock(creator_factory):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from django.db import close_old_connections
    from rest_framework.test import APIClient

    me = creator_factory()
    a, b, c = [_page(me, name) for name in ["a", "b", "c"]]
    series = _series(me, "series", pages=[a])
    barrier = Barrier(2, timeout=10)

    def assign(incoming):
        close_old_connections()
        try:
            client = APIClient()
            client.force_authenticate(user=me)
            barrier.wait()
            response = client.put(
                f"/api/g12f/series/mine/{series.id}/",
                _guarded_payload("series", [a], [a, incoming]), format="json")
            return incoming.pk, response.status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(assign, b)
        second = pool.submit(assign, c)
        outcomes = [first.result(timeout=20), second.result(timeout=20)]
    assert sorted(status for _, status in outcomes) == [200, 409]
    winner = next(pk for pk, status in outcomes if status == 200)
    assert set(series.pageorder_set.values_list("page_id", flat=True)) == {a.pk, winner}


@pytest.mark.django_db
def test_clear_locks_page_before_removing_membership(api_client, creator_factory):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    me = creator_factory()
    page = _page(me)
    _series(me, "series", pages=[page])
    api_client.force_authenticate(user=me)
    with CaptureQueriesContext(connection) as captured:
        response = api_client.delete(f"/api/g12f/series/clear-zpage/{page.free2zaddr}/")
    assert response.status_code == 200
    sql = [query["sql"] for query in captured.captured_queries]
    lock = next(index for index, query in enumerate(sql) if "FOR NO KEY UPDATE" in query)
    deletion = next(index for index, query in enumerate(sql) if query.startswith("DELETE"))
    assert lock < deletion


@pytest.mark.django_db
def test_expected_series_name_preserves_legacy_whitespace(api_client, creator_factory):
    me = creator_factory()
    page = _page(me)
    series = _series(me, " legacy series ", pages=[page])
    api_client.force_authenticate(user=me)
    payload = _guarded_payload(" legacy series ", [page], [page])
    payload["name"] = "Renamed"
    response = api_client.put(f"/api/g12f/series/mine/{series.id}/", payload, format="json")
    assert response.status_code == 200, response.content
    series.refresh_from_db()
    assert series.name == "Renamed"
