"""Re-seed what ``0001_initial`` seeded, idempotently (the ``sys:*`` rows and
the one ``ledger_config`` row).

Production never needs this: the migration ran once. The test suite does --
a ``transaction=True`` test flushes every managed table afterwards, taking
the seeded rows with it, and since the dual-write release every money path
in the product calls ``ledger.sys('sys:platform_revenue')`` and reads
``ledger_config``. ``py/conftest.py`` calls this before every database test
(one cheap probe when the rows are there), and the ledger's own tests call
it from their conftest.
"""
from __future__ import annotations

from django.db import connection

from .system_accounts import SYSTEM_ACCOUNTS


def system_rows_present() -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT (SELECT count(*) FROM ledger_account WHERE journal_only) = %s "
            "   AND EXISTS (SELECT 1 FROM ledger_config)",
            [len(SYSTEM_ACCOUNTS)],
        )
        present = bool(cursor.fetchone()[0])
        cursor.execute("SELECT to_regclass('public.ledger_app') IS NOT NULL")
        if cursor.fetchone()[0]:
            cursor.execute("SELECT EXISTS(SELECT 1 FROM ledger_app WHERE id='00000000-0000-4000-8000-000000000001') AND EXISTS(SELECT 1 FROM ledger_rollup_state WHERE name='ai_rollup')")
            present = present and bool(cursor.fetchone()[0])
        return present


def seed_system_rows() -> None:
    """Insert whatever is missing; a no-op when everything is there."""
    from .models import Account, Config

    # Balance triggers fail closed if the configuration epoch is missing.
    Config.objects.get_or_create(id=True)
    for key, kind in SYSTEM_ACCOUNTS:
        Account.objects.get_or_create(key=key, defaults={"kind": kind, "journal_only": True})
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('public.ledger_app') IS NOT NULL")
        if cursor.fetchone()[0]:
            cursor.execute("INSERT INTO ledger_app(id,rails) VALUES('00000000-0000-4000-8000-000000000001','{stripe,zec,iap_apple,iap_google}') ON CONFLICT DO NOTHING")
            cursor.execute("INSERT INTO ledger_rollup_state(name) VALUES('ai_rollup') ON CONFLICT DO NOTHING")


def ensure_system_rows() -> None:
    if not system_rows_present():
        seed_system_rows()
