"""Bounded-memory iteration that needs no server-side cursor.

``DISABLE_SERVER_SIDE_CURSORS = True`` (``settings.py``) makes Django run
``QuerySet.iterator(chunk_size=N)`` on an ordinary client-side cursor: the
driver receives the WHOLE result set on ``execute()`` and ``chunk_size`` only
bounds how many rows Django turns into objects at a time. That is harmless for
a stream of ``(pk, username)`` tuples and a real memory hazard for a stream of
full rows that carry article bodies -- which is what ``score_pages`` and the
publication exporter iterate (the exporter fetches ids first, then one row
at a time by pk, because its order has no index). (Server-side cursors had to go because under
PgBouncer transaction pooling a cursor opened in one transaction is fetched
from in the next, on whatever backend the pooler hands out, and fails with
``cursor "..." does not exist``.)

:func:`keyset_iterator` restores the bounded-memory property the other way:
one statement per page, ``WHERE (order key) > (last row's key) ORDER BY...
LIMIT chunk_size``, over an index. Nothing is held on the server between
pages, so it is correct in autocommit, inside a transaction, and behind a
transaction-mode pooler alike. ``prefetch_related`` still applies, per page.

Semantics differ from a single cursor in one way: pages are separate
statements, so in autocommit a row inserted or updated mid-run can be seen by
a later page (never twice -- the key only moves forward, provided the key
columns themselves are not rewritten mid-run). Every current caller is a
periodic sweep or an export that already tolerates that.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence

from django.db.models import Q, QuerySet


def _keyset_after(fields: Sequence[str], values: Sequence[object]) -> Q:
    """``(f1, f2,...) > (v1, v2,...)`` lexicographically, as a ``Q``."""
    clause = Q()
    for index, field in enumerate(fields):
        term = Q(**{f"{field}__gt": values[index]})
        for prior_field, prior_value in zip(fields[:index], values[:index]):
            term &= Q(**{prior_field: prior_value})
        clause |= term
    return clause


def keyset_iterator(
    queryset: QuerySet,
    *,
    chunk_size: int,
    order_by: Sequence[str] = ("pk",),
) -> Iterator:
    """Yield model instances of ``queryset`` in ``order_by`` order, page by page.

    ``order_by`` is ascending field names, none nullable, whose LAST entry is
    the primary key (``"pk"`` or ``"id"``) so the key is unique -- a non-unique
    key would skip the rows that tie with a page boundary. The queryset's own
    ordering is replaced.
    """
    if chunk_size < 1:
        raise ValueError("chunk_size must be a positive integer")
    fields = tuple(order_by)
    if not fields or fields[-1] not in ("pk", "id"):
        raise ValueError(
            "keyset order must end with the primary key ('pk' or 'id')"
        )
    if any(field.startswith("-") or "__" in field for field in fields):
        raise ValueError("keyset order fields must be ascending local fields")

    ordered = queryset.order_by(*fields)
    after = None
    while True:
        page_qs = ordered if after is None else ordered.filter(after)
        page = list(page_qs[:chunk_size])
        if not page:
            return
        yield from page
        if len(page) < chunk_size:
            return
        last = page[-1]
        after = _keyset_after(
            fields, [getattr(last, field) for field in fields]
        )
