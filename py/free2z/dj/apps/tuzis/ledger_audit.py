"""The reservation-side ledger audits  shared by ``reconcile_ledger``
(which reports them) and ``heal_ledger_drift`` (which, on request, closes
them). They live in ``tuzis`` because they name ``ProviderReservation``'s
table, which the self-contained ``ledger`` app may not.

R13 (design §11): ``journal(sys:reservation_clearing) == Σ amount × 1000``
over ``active`` reservations that have a ``spend / reservation / <pk>``
transfer. Pre-rollout reservations (made by a pod on the previous image)
have no such transfer and are not counted.

**Legacy-finalized reservations** are the reverse mixed-fleet case (codex
adversarial review of ): a reservation the NEW code journaled into
``sys:reservation_clearing`` that a pod on the OLD image then settled or
released -- its stale sweep, or the old ``cleanup_idempotency`` -- without
the closing journal leg. Only a prolonged rollout or a rollback can do it
(the old sweep needs a hold older than ``STALE_CLAIM`` while old pods still
run), but when it does the clearing account keeps that amount forever: the
user side is healed by the next touch (``legacy_adjustment``), the clearing
side is nothing's to heal, and R13 reports it for as long as it stands. The
rows are exactly identifiable -- terminal status, a ``spend`` leg, no
closing leg -- and ``heal_ledger_drift --apply`` posts the leg the old code
could not. A closing leg is a ``refund`` (the new release), a
``reservation_settle`` spend, a ``legacy_adjustment`` (this healer), **or
a ``debt_repay``**: ``credit_with_repay`` posts only the repay leg when
the returned credits met the owner's debt in full, and that release is
still a release (Fable review of ).
"""
from __future__ import annotations

from django.db import connection

from dj.apps.tuzis.models import ProviderReservation

#How far back the legacy-finalized scan looks (by ``created_at``, the
#column the table is indexed on). A journaled reservation can only be
#finalized by old code inside a rollback window, and the healer closes
#them; anything older than this has been standing, and paging, for months.
LEGACY_FINALIZED_LOOKBACK = "90 days"

_TABLE = ProviderReservation._meta.db_table

_SPEND_LEG = (
    "EXISTS (SELECT 1 FROM ledger_transfer t"
    "         WHERE t.ref_kind = 'reservation' AND t.ref_id = r.id::text AND t.code = 'spend'"
    "           AND t.created_at >= r.created_at - interval '1 day'"
    "           AND t.created_at <  r.created_at + interval '1 day')"
)
_CLOSING_LEG = (
    "EXISTS (SELECT 1 FROM ledger_transfer t"
    "         WHERE t.ref_id = r.id::text"
    "           AND ((t.ref_kind = 'reservation' AND t.code IN ('refund', 'legacy_adjustment', 'debt_repay'))"
    "             OR (t.ref_kind = 'reservation_settle' AND t.code = 'spend'))"
    "           AND t.created_at >= r.created_at - interval '1 day')"
)


def _rows(sql, params=None):
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def r13_reservation_clearing_equals_active_journaled_holds() -> tuple[int, int]:
    """``(journal of sys:reservation_clearing, Σ over active journaled
    reservations)`` in m2Z. Equal when R13 holds."""
    [(journal, held)] = _rows(
        "SELECT"
        "  (SELECT coalesce((SELECT sum(t.amount) FROM ledger_transfer t WHERE t.credit_account_id = a.id), 0)"
        "        - coalesce((SELECT sum(t.amount) FROM ledger_transfer t WHERE t.debit_account_id = a.id), 0)"
        "     FROM ledger_account a WHERE a.key = 'sys:reservation_clearing'),"
        f" (SELECT coalesce(sum((r.amount * 1000)::bigint), 0) FROM {_TABLE} r"
        f"   WHERE r.status = 'active' AND {_SPEND_LEG})"
    )
    return (int(journal) if journal is not None else 0), int(held)


def legacy_finalized_reservations(limit: int | None = None, pk: int | None = None) -> list[tuple[int, str, int]]:
    """``[(pk, status, amount_m2z)]`` for terminal reservations that have a
    journaled ``spend`` leg and no closing leg, oldest first. ``pk`` narrows
    the scan to one row (the healer's re-check under the row lock)."""
    rows = _rows(
        f"SELECT r.id, r.status, (r.amount * 1000)::bigint FROM {_TABLE} r"
        f" WHERE r.status IN ('settled', 'released')"
        + (" AND r.id = %s" if pk is not None else "")
        + f"   AND r.created_at >= now() - interval '{LEGACY_FINALIZED_LOOKBACK}'"
        f"   AND {_SPEND_LEG} AND NOT {_CLOSING_LEG}"
        f" ORDER BY r.id" + (f" LIMIT {int(limit)}" if limit else ""),
        [int(pk)] if pk is not None else None,
    )
    return [(int(pk), status, int(m2z)) for pk, status, m2z in rows]


def legacy_finalized_totals() -> tuple[int, int]:
    """``(count, Σ m2Z)`` of the rows above -- the gauge that explains an R13
    drift as a rollback artefact rather than a new integrity failure."""
    [(count, total)] = _rows(
        f"SELECT count(*), coalesce(sum((r.amount * 1000)::bigint), 0) FROM {_TABLE} r"
        f" WHERE r.status IN ('settled', 'released')"
        f"   AND r.created_at >= now() - interval '{LEGACY_FINALIZED_LOOKBACK}'"
        f"   AND {_SPEND_LEG} AND NOT {_CLOSING_LEG}"
    )
    return int(count), int(total)
