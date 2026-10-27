"""Shared fixtures for the ledger tests. REAL Postgres only (repo rule).

``ledger_seed`` (autouse here) makes the tests order-independent: a
``transaction=True`` test anywhere in the suite flushes every managed table
afterwards -- including ``ledger_account``, which loses the ``sys:*`` rows the
migration seeded, and ``ledger_config`` -- while the unmanaged, partitioned
``ledger_transfer`` is NOT flushed and keeps its rows. So every ledger test
re-seeds what the migration seeded (idempotently) and, when it runs in
autocommit, clears the journal and the key table it is about to reason
over. Idempotency keys in tests are UUIDs for the same reason.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from django.db import connection

from dj.apps.ledger import invariants
from dj.apps.ledger.seed import seed_system_rows as seed_ledger  # noqa: F401  (re-exported for the tests)


def sql(query, params=None):
    """Run one statement on the test's connection; return all rows."""
    with connection.cursor() as cursor:
        # params=None means "no placeholders": a function body full of `%`
        # (RAISE formats) must reach the server untouched.
        cursor.execute(query, params if params else None)
        if cursor.description is None:
            return None
        return cursor.fetchall()


def one(query, params=None):
    rows = sql(query, params)
    assert len(rows) == 1, rows
    return rows[0]


def account(key):
    """``(id, balance, held, frozen)`` for an account key, or None."""
    rows = sql("SELECT id, balance, held, frozen FROM ledger_account WHERE key = %s", [key])
    return rows[0] if rows else None


def balance_of(key):
    return account(key)[1]


def tuzis_of(creator):
    return one("SELECT tuzis FROM g12f_creator WHERE id = %s", [creator.pk])[0]


def sys_id(key):
    return one("SELECT ledger.sys(%s)", [key])[0]


def post(debit, credit, amount, code, ref_kind="", ref_id="", idem=None, meta=None):
    """``ledger.post_transfer`` raw: ``(transfer_id, status)``."""
    return one(
        "SELECT * FROM ledger.post_transfer(%s, %s, %s, %s, %s, %s, %s, %s)",
        [debit, credit, amount, code, ref_kind, ref_id, idem, meta],
    )


def transfers(**where):
    clauses = " AND ".join(f"{k} = %s" for k in where) or "TRUE"
    return sql(
        "SELECT id, debit_account_id, credit_account_id, amount, code, ref_kind, ref_id "
        f"FROM ledger_transfer WHERE {clauses} ORDER BY id",
        list(where.values()),
    )


def key(prefix="k"):
    return f"{prefix}:{uuid.uuid4()}"


def function_def(name):
    return one("SELECT pg_get_functiondef(%s::regproc)", [f"ledger.{name}"])[0]


def m2z(tuzis) -> int:
    return int(Decimal(tuzis) * 1000)


@pytest.fixture(autouse=True)
def ledger_seed(request, db):
    marker = request.node.get_closest_marker("django_db")
    transactional = bool(marker and marker.kwargs.get("transaction"))
    if transactional:
        # Autocommit: nothing rolls back after us, and a previous autocommit
        # test's journal rows would otherwise be counted by R1/R3.
        sql("TRUNCATE ledger_transfer, ledger_transfer_key, ledger_purchase_refund, ledger_reconcile_run, ledger_ai_usage")
    seed_ledger()
    yield
    if transactional:
        # Django flushes managed tables, but partitioned usage is unmanaged.
        # Do not leak another test's receipts into historical migration tests.
        sql("TRUNCATE ledger_ai_usage, ledger_transfer, ledger_transfer_key")


@pytest.fixture
def assert_invariants():
    """R1, R2, R3 (§11) as one call; use after every write in a test."""
    return invariants.assert_all
