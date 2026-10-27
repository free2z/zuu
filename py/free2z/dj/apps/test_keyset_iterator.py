"""``dj.util.keyset.keyset_iterator`` -- the no-cursor replacement.

``DISABLE_SERVER_SIDE_CURSORS`` turns ``.iterator()`` into "receive every row
on the first fetch", so the loops over article bodies (``score_pages``, the
publication exporter) page by key instead. What has to hold: every row exactly
once, in order, including rows that tie on a non-unique leading key across a
page boundary; each page a separate bounded statement; nothing declared on the
server.
"""

import datetime

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.util.keyset import keyset_iterator


def _creators(creator_factory, count, prefix):
    return [
        creator_factory(username=f"{prefix}-{index}") for index in range(count)
    ]


@pytest.mark.django_db
def test_every_row_once_in_pk_order_one_statement_per_page(creator_factory):
    made = _creators(creator_factory, 7, "keyset")
    qs = get_user_model().objects.filter(username__startswith="keyset-")

    with CaptureQueriesContext(connection) as queries:
        seen = [row.pk for row in keyset_iterator(qs, chunk_size=3)]

    assert seen == sorted(creator.pk for creator in made)
    # 3 + 3 + 1: the short last page ends the walk without a fourth query.
    assert len(queries) == 3
    assert all("LIMIT 3" in query["sql"] for query in queries)
    assert not any("DECLARE" in query["sql"] for query in queries)


@pytest.mark.django_db
def test_ties_on_the_leading_key_straddling_a_page_are_not_lost(
    creator_factory,
):
    made = _creators(creator_factory, 5, "keyset-tie")
    User = get_user_model()
    same = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    User.objects.filter(pk__in=[c.pk for c in made]).update(date_joined=same)
    qs = User.objects.filter(username__startswith="keyset-tie-")

    seen = [
        row.pk
        for row in keyset_iterator(
            qs, chunk_size=2, order_by=("date_joined", "pk")
        )
    ]

    assert seen == sorted(creator.pk for creator in made)


@pytest.mark.django_db
def test_an_exact_multiple_of_the_page_size_ends_cleanly(creator_factory):
    _creators(creator_factory, 4, "keyset-even")
    qs = get_user_model().objects.filter(username__startswith="keyset-even-")
    assert len(list(keyset_iterator(qs, chunk_size=2))) == 4
    assert list(keyset_iterator(qs.none(), chunk_size=2)) == []


@pytest.mark.parametrize(
    "kwargs",
    [
        {"chunk_size": 0},
        {"chunk_size": 1, "order_by": ("date_joined",)},
        {"chunk_size": 1, "order_by": ("-pk",)},
        {"chunk_size": 1, "order_by": ("creator__created_at", "pk")},
        {"chunk_size": 1, "order_by": ()},
    ],
)
def test_orders_that_cannot_be_keyset_paged_are_refused(kwargs):
    qs = get_user_model().objects.all()
    with pytest.raises(ValueError):
        next(keyset_iterator(qs, **kwargs))
