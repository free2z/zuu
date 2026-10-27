"""``GET /api/auth/user/`` reports a fan COUNT, never a fan roster.

The profile endpoint used to serialize ``fans`` -- every active subscriber's
username -- on an endpoint the app hits every session, when the only consumer
was ``fans.length`` rendered into a dashboard tile. The response size was
therefore governed by how successful the creator was: the more popular you got,
the slower your own dashboard loaded, with no ceiling.

These tests pin the two properties that matter and that a well-meaning refactor
could quietly undo:

* the payload does not grow with the number of subscribers, and
* the number is computed in the database, not by measuring a materialised list.
"""

import re
import uuid
from datetime import timedelta

import pytest
from django.db import connection
from django.db.models import Count, Max, Q
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.g12f.models import (
    Creator,
    Subscription,
    active_fans_count,
    zPage,
)


def _subscribe(fan: Creator, star: Creator, *, expires) -> Subscription:
    return Subscription.objects.create(star=star, fan=fan, expires=expires)


@pytest.mark.django_db
def test_profile_reports_fan_count_and_never_the_roster(creator_factory):
    """The count is right, and no subscriber username is in the response."""
    star = creator_factory(username="popular-star")
    active = timezone.now() + timedelta(days=1)
    for i in range(7):
        _subscribe(creator_factory(username=f"fan-{i}"), star, expires=active)

    # An expired subscription is not a fan. Same boundary the removed
    # get_fans() list used, so the count is exactly that list's length.
    _subscribe(
        creator_factory(username="lapsed-fan"),
        star,
        expires=timezone.now() - timedelta(seconds=1),
    )
    # Nor is somebody the star is subscribed TO: the relation has a direction.
    _subscribe(star, creator_factory(username="someone-else"), expires=active)

    client = APIClient()
    client.force_authenticate(user=star)
    response = client.get("/api/auth/user/")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["fans_count"] == 7
    assert "fans" not in body

    # The roster must not survive under any key. Assert on the raw bytes so a
    # nested or renamed reintroduction is caught too.
    raw = response.content.decode()
    for i in range(7):
        assert f"fan-{i}" not in raw
    assert "lapsed-fan" not in raw


@pytest.mark.django_db
def test_profile_payload_does_not_grow_with_subscriber_count(creator_factory):
    """The point of the issue: response size must be independent of fans.

    One fan versus forty must produce the same payload apart from the digits
    of the count itself. A ``len()`` over a materialised list would satisfy the
    "renders a number" requirement and fail this.
    """
    active = timezone.now() + timedelta(days=1)

    small = creator_factory(username="small-star")
    _subscribe(creator_factory(username="only-fan"), small, expires=active)

    big = creator_factory(username="big-star")
    for i in range(40):
        _subscribe(creator_factory(username=f"crowd-{i}"), big, expires=active)

    client = APIClient()

    client.force_authenticate(user=small)
    small_body = client.get("/api/auth/user/").content.decode()
    client.force_authenticate(user=big)
    big_body = client.get("/api/auth/user/").content.decode()

    def normalise(body: str, username: str) -> str:
        body = body.replace(username, "STAR")
        body = re.sub(r'"id":\s*\d+', '"id":ID', body)
        body = re.sub(r'"balance_snapshot":"[^"]+"',
                      '"balance_snapshot":"OBSERVED"', body)
        return re.sub(r'"fans_count":\s*\d+', '"fans_count":N', body)

    assert normalise(small_body, "small-star") == normalise(big_body, "big-star")
    # 40 usernames would be hundreds of bytes; the guard is deliberately loose
    # so it fails on unboundedness, not on an unrelated field being added.
    assert len(big_body) - len(small_body) < 32


@pytest.mark.django_db
def test_fan_count_is_annotated_not_a_second_query(creator_factory):
    """The read must not add a query per request, nor scale with fans.

    ``CustomUserDetailsView.get_object`` re-selects the row with the
    ``fans_count`` annotation folded in, so the count rides along on a query
    the endpoint runs anyway. If the annotation is ever dropped the serializer
    falls back to ``COUNT(*)`` -- correct, but an extra round trip, and this
    test says so.
    """
    active = timezone.now() + timedelta(days=1)
    lonely = creator_factory(username="lonely-star")

    crowded = creator_factory(username="crowded-star")
    for i in range(25):
        _subscribe(
            creator_factory(username=f"follower-{i}"), crowded, expires=active
        )

    client = APIClient()

    client.force_authenticate(user=lonely)
    with CaptureQueriesContext(connection) as lonely_queries:
        lonely_response = client.get("/api/auth/user/")
    assert lonely_response.json()["fans_count"] == 0

    client.force_authenticate(user=crowded)
    with CaptureQueriesContext(connection) as crowded_queries:
        crowded_response = client.get("/api/auth/user/")
    assert crowded_response.json()["fans_count"] == 25

    # Constant, and constant at the SAME number: a per-fan query would show up
    # as growth, a separate COUNT round trip as a fixed +1 over the baseline.
    assert len(crowded_queries) == len(lonely_queries)
    # Exactly four today: the annotated Creator row (fans_count folded in), the
    # `zpages` COUNT, the `stars` list and the Twitter profile. A dropped
    # annotation makes it five.
    assert len(crowded_queries) <= 4, [q["sql"] for q in crowded_queries]
    assert not any(
        "follower-" in q["sql"] for q in crowded_queries
    ), "no query should be selecting subscriber usernames"


@pytest.mark.django_db
def test_patch_response_still_carries_the_fan_count(creator_factory):
    """Writes keep ``request.user`` (see ) and fall back to COUNT(*)."""
    star = creator_factory(username="patching-star")
    active = timezone.now() + timedelta(days=1)
    for i in range(3):
        _subscribe(creator_factory(username=f"pfan-{i}"), star, expires=active)

    client = APIClient()
    client.force_authenticate(user=star)
    response = client.patch(
        "/api/auth/user/", {"first_name": "Patched"}, format="json"
    )

    assert response.status_code == 200, response.content
    assert response.json()["first_name"] == "Patched"
    assert response.json()["fans_count"] == 3
    assert "fans" not in response.json()

    # The annotated read and the COUNT(*) fallback must agree, or the tile
    # would flicker to a different number after every profile save.
    assert client.get("/api/auth/user/").json()["fans_count"] == 3


@pytest.mark.django_db
def test_annotation_is_usable_as_a_server_side_filter(creator_factory):
    """Unblocks, whose follower filter runs on the wrong column today.

    The Creators directory filters "at least N followers" on ``Creator.total``,
    a cached ZEC page-support value. ``active_fans_count()`` is the expression
    that filter actually wants, so it has to survive a ``.filter()``, not just
    a serializer read.
    """
    active = timezone.now() + timedelta(days=1)
    counts = {"zero-fans": 0, "two-fans": 2, "five-fans": 5}
    for username, n in counts.items():
        star = creator_factory(username=username)
        for i in range(n):
            _subscribe(
                creator_factory(username=f"{username}-f{i}"),
                star,
                expires=active,
            )

    qs = Creator.objects.annotate(fans_count=active_fans_count())
    assert set(
        qs.filter(fans_count__gte=2, username__in=list(counts)).values_list(
            "username", flat=True
        )
    ) == {"two-fans", "five-fans"}

    ordered = list(
        qs.filter(username__in=list(counts))
        .order_by("-fans_count")
        .values_list("username", "fans_count")
    )
    assert ordered == [("five-fans", 5), ("two-fans", 2), ("zero-fans", 0)]


@pytest.mark.django_db
def test_annotation_survives_a_second_one_to_many_join(creator_factory):
    """The count must not multiply when composed with the zPage joins.

    ``CreatorView``'s directory queryset -- the one  will hang the
    follower filter off -- already aggregates over zPage (``published_pages``,
    ``last_page_activity``). A ``Count`` without ``distinct=True`` counts the
    zPage x Subscription cross product there, so 5 fans and 3 pages report as
    15: a wrong number that still looks like a number, which is exactly how a
    follower filter admits the wrong creators without anyone noticing.
    """
    star = creator_factory(username="joined-star")
    active = timezone.now() + timedelta(days=1)
    for i in range(5):
        _subscribe(creator_factory(username=f"jfan-{i}"), star, expires=active)
    for i in range(3):
        zPage.objects.create(
            creator=star,
            free2zaddr=str(uuid.uuid4()),
            title=f"page-{i}",
            content="x",
            is_published=True,
        )

    row = (
        Creator.objects.filter(pk=star.pk)
        .annotate(
            fans_count=active_fans_count(),
            published_pages=Count(
                'zpage', filter=Q(zpage__is_published=True), distinct=True
            ),
            last_page_activity=Max('zpage__updated_at'),
        )
        .get()
    )

    assert row.fans_count == 5
    assert row.published_pages == 3


@pytest.mark.django_db
def test_profile_endpoint_is_self_only(creator_factory):
    """Nobody but the owner can reach this payload."""
    star = creator_factory(username="private-star")
    other = creator_factory(username="nosy-neighbour")
    _subscribe(
        creator_factory(username="secret-fan"),
        star,
        expires=timezone.now() + timedelta(days=1),
    )

    anon = APIClient()
    assert anon.get("/api/auth/user/").status_code in (401, 403)

    client = APIClient()
    client.force_authenticate(user=other)
    body = client.get("/api/auth/user/").json()
    # The endpoint has no addressing at all: it always serves request.user.
    assert body["username"] == "nosy-neighbour"
    assert body["fans_count"] == 0


@pytest.mark.django_db
def test_auth_profile_exposes_immutable_payer_id(creator_factory):
    payer = creator_factory(username="immutable-payer")
    other = creator_factory(username="different-payer")
    client = APIClient()
    client.force_authenticate(user=payer)
    assert client.get("/api/auth/user/").json()["id"] == payer.pk
    response = client.patch(
        "/api/auth/user/", {"id": other.pk, "first_name": "Updated"}, format="json"
    )
    assert response.status_code == 200
    assert response.json()["id"] == payer.pk
    payer.refresh_from_db()
    assert payer.first_name == "Updated"
    assert client.get("/api/auth/user/").json()["id"] == payer.pk
