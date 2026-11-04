"""Read-only crediting gate for full transactions after compact wallet sync.

The pinned devtool's enhancement command can consume a retrieval request after
a provider NotFound and still exit zero. A missing queue entry is therefore not
proof of complete transaction data. Check positive shielded received notes
directly; a NULL memo is unknown while decrypted F6 NoMemo is legitimate.
Unknown notes are reported in aggregate by this read-only audit and their
instructions are masked by the adapter, without halting verified payments.
This module never changes or requeues wallet data.
"""

import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path


RECEIVED_TABLES = frozenset((
    "sapling_received_notes",
    "orchard_received_notes",
    "ironwood_received_notes",
))


def incomplete_received_transactions(wallet_db: str) -> int:
    uri = Path(wallet_db).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=1)) as conn:
        conn.execute("PRAGMA query_only=ON")
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        pools = tables & RECEIVED_TABLES
        unknown = {name for name in tables
                   if name.endswith("_received_notes")} - RECEIVED_TABLES
        if not pools or unknown:
            raise ValueError("unsupported shielded received-note schema")
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
        incomplete = incomplete_received_transactions(wallet_db)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"!! wallet hydration failed: {exc}", file=sys.stderr)
        return 1
    if incomplete:
        print(
            f"credit_creators: CREDITING BLOCKED - {incomplete} positive "
            "shielded note(s) have unknown full transaction or memo data; "
            "only those notes are ineligible. Verified payments continue. "
            "Provider NotFound may have consumed retrieval requests; "
            "operator recovery may be required.",
            file=sys.stderr,
        )
        return 0
    print("credit-loop: full transaction hydration verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
