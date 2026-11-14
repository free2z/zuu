"""Transaction-detail recovery and hydration audit after compact wallet sync.

The pinned devtool's enhancement command can consume a retrieval request after
a provider NotFound and still exit zero. A missing queue entry is therefore not
proof of complete transaction data. Check positive shielded received notes
directly; a NULL memo is unknown while decrypted F6 NoMemo is legitimate.
Unknown notes are reported in aggregate by the read-only audit and their
instructions are masked by the adapter, without halting verified payments.
Opt-in recovery uses a separate native command and supported wallet APIs.
The audit never edits wallet data, and neither path repairs queue SQL.
"""

import os
import sqlite3
import sys
import subprocess
import time
from contextlib import closing
from pathlib import Path


RECEIVED_TABLES = frozenset((
    "sapling_received_notes",
    "orchard_received_notes",
    "ironwood_received_notes",
))


SQL_STEPS = 2_000_000


def bounded_sql(conn, deadline):
    """Bound SQLite value allocation, schema enumeration and VM work."""
    conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 4 * 1024 * 1024)
    conn.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 16384)
    conn.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 128)
    steps = 0

    def expired():
        nonlocal steps
        steps += 1000
        return int(steps > SQL_STEPS or time.monotonic() >= deadline)

    conn.set_progress_handler(expired, 1000)


def received_pools(conn):
    tables = set()
    for index, (name,) in enumerate(conn.execute("SELECT name FROM sqlite_schema WHERE type='table' LIMIT 257")):
        if index == 256 or len(name) > 128:
            raise ValueError('wallet schema budget exceeded')
        tables.add(name)
    pools = tables & RECEIVED_TABLES
    unknown = {name for name in tables if name.endswith('_received_notes')} - RECEIVED_TABLES
    if not pools or unknown:
        raise ValueError('unsupported shielded received-note schema')
    return pools


def verify_wallet(wallet_db):
    from zcashrpc.wallet_recovery import recover_configured
    recover_configured(wallet_db)
    return incomplete_received_transactions(wallet_db)


def incomplete_received_transactions(wallet_db: str) -> int:
    uri = Path(wallet_db).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=1)) as conn:
        conn.execute("PRAGMA query_only=ON")
        bounded_sql(conn, time.monotonic() + 2)
        pools = received_pools(conn)
        total = 0
        for table in sorted(pools):
            # Table names are selected exclusively from the fixed allowlist.
            # Include all wallet accounts and spent notes: without full data
            # their account-attribution memos remain unknown, not absent.
            total += conn.execute(
                f"SELECT COUNT(*) FROM {table} n "
                "LEFT JOIN transactions t ON t.id_tx = n.transaction_id "
                "WHERE n.value > 0 AND "
                "(t.raw IS NULL OR typeof(t.raw) != 'blob' OR length(t.raw) = 0 "
                "OR n.memo IS NULL OR typeof(n.memo) != 'blob')"
            ).fetchone()[0]
        return total


def main() -> int:
    wallet_db = os.environ.get("WALLET_DB")
    if not wallet_db:
        print("!! wallet hydration failed: WALLET_DB is required", file=sys.stderr)
        return 1
    try:
        incomplete = verify_wallet(wallet_db)
    except (OSError, sqlite3.Error, ValueError, subprocess.SubprocessError):
        print("!! wallet hydration failed: recovery or wallet audit unavailable", file=sys.stderr)
        return 1
    if incomplete:
        print(
            f"credit-loop: {incomplete} positive "
            "shielded note(s) have unknown full transaction or memo data; "
            "only those notes are ineligible. Verified payments continue. "
            "Provider NotFound may have consumed retrieval requests; "
            "operator recovery may be required. Per-note blocked presence and "
            "operator dispositions are reported by credit_creators.",
            file=sys.stderr,
        )
        return 0
    print("credit-loop: full transaction hydration verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
