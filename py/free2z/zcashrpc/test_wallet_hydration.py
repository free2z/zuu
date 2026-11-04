"""Unknown full-transaction data must not be confused with a genuine no-memo note."""

import sqlite3
from contextlib import closing, contextmanager, redirect_stderr
from io import StringIO
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from zcashrpc.wallet_hydration import incomplete_received_transactions, main


class WalletHydrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "wallet.sqlite")
        with self.database() as conn:
            conn.execute("CREATE TABLE transactions (id_tx INTEGER PRIMARY KEY, raw BLOB)")
            for pool in ("sapling", "orchard", "ironwood"):
                conn.execute(f"CREATE TABLE {pool}_received_notes (transaction_id INTEGER, value INTEGER, memo BLOB)")

    @contextmanager
    def database(self):
        with closing(sqlite3.connect(self.path)) as conn:
            with conn:
                yield conn

    def add_note(self, pool, raw, value=909007, memo=None):
        with self.database() as conn:
            tx = conn.execute("INSERT INTO transactions(raw) VALUES (?)", (raw,)).lastrowid
            conn.execute(f"INSERT INTO {pool}_received_notes VALUES (?, ?, ?)", (tx, value, memo))

    def test_all_pools_missing_raw_fail_even_without_retrieval_queue(self):
        for pool in ("sapling", "orchard", "ironwood"):
            self.add_note(pool, None)
        self.assertEqual(incomplete_received_transactions(self.path), 3)

    def test_decrypted_no_memo_is_known_but_null_remains_unknown(self):
        self.add_note("ironwood", b"full transaction", memo=b"\xf6" + bytes(511))
        self.add_note("sapling", b"full transaction", memo=None)
        self.assertEqual(incomplete_received_transactions(self.path), 1)

    def test_partial_enhancement_reports_unresolved_notes(self):
        self.add_note("orchard", b"full transaction", memo=b'{"act":"buy_2z","id":"buyer"}')
        self.add_note("ironwood", None)
        self.assertEqual(incomplete_received_transactions(self.path), 1)

    def test_unknown_note_reports_degraded_without_stopping_verified_payments(self):
        self.add_note("ironwood", None)
        output = StringIO()
        with patch.dict("os.environ", {"WALLET_DB": self.path}), redirect_stderr(output):
            self.assertEqual(main(), 0)
        self.assertIn("credit_creators: CREDITING BLOCKED - 1", output.getvalue())
        self.assertRegex(output.getvalue().strip(),
                         r"^credit_(creators|pages_unified): CREDITING BLOCKED - .+$")
        self.assertIn("Verified payments continue", output.getvalue())
        self.assertNotIn("cycle ok", output.getvalue())

    def test_schema_failure_still_returns_nonzero(self):
        with self.database() as conn:
            conn.execute("ALTER TABLE ironwood_received_notes DROP COLUMN memo")
        with patch.dict("os.environ", {"WALLET_DB": self.path}), redirect_stderr(StringIO()):
            self.assertEqual(main(), 1)

    def test_zero_value_outputs_do_not_block(self):
        self.add_note("ironwood", None, value=0)
        self.assertEqual(incomplete_received_transactions(self.path), 0)

    def test_invalid_empty_raw_and_dangling_transaction_fail(self):
        self.add_note("orchard", b"")
        self.add_note("sapling", "not a transaction blob")
        with self.database() as conn:
            conn.execute("INSERT INTO ironwood_received_notes VALUES (999, 1, NULL)")
        self.assertEqual(incomplete_received_transactions(self.path), 3)

    def test_unknown_pool_and_missing_columns_fail_closed(self):
        with self.database() as conn:
            conn.execute("CREATE TABLE future_received_notes (transaction_id INTEGER, value INTEGER)")
        with self.assertRaises(ValueError):
            incomplete_received_transactions(self.path)
        with self.database() as conn:
            conn.execute("DROP TABLE future_received_notes")
            conn.execute("ALTER TABLE ironwood_received_notes RENAME COLUMN value TO amount")
        with self.assertRaises(sqlite3.Error):
            incomplete_received_transactions(self.path)

    def test_missing_database_not_created_and_existing_database_not_modified(self):
        missing = str(Path(self.temp.name) / "missing.sqlite")
        with self.assertRaises(sqlite3.Error):
            incomplete_received_transactions(missing)
        self.assertFalse(Path(missing).exists())
        before = Path(self.path).read_bytes()
        self.assertEqual(incomplete_received_transactions(self.path), 0)
        self.assertEqual(Path(self.path).read_bytes(), before)

    def test_corrupt_database_fails_closed(self):
        Path(self.path).write_bytes(b"not a sqlite database")
        with self.assertRaises(sqlite3.Error):
            incomplete_received_transactions(self.path)

    def test_exclusive_writer_lock_fails_closed_then_can_retry(self):
        with self.database() as writer:
            writer.execute("BEGIN EXCLUSIVE")
            with self.assertRaises(sqlite3.OperationalError):
                incomplete_received_transactions(self.path)
        self.assertEqual(incomplete_received_transactions(self.path), 0)


if __name__ == "__main__":
    unittest.main()
