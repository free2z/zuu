"""Payment diagnostics against synthetic SQLite notes and receipt evidence."""
import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from zcashrpc import verify_payment as verify

TXID = bytes(range(32)).hex()
MEMO = json.dumps({"act": "buy_2z", "id": "fixture-user"}).encode().hex()
NOTE = {"txid": TXID, "pool": "orchard", "output_index": 2,
        "amountZat": 123456789, "amount": Decimal("1.23456789"),
        "memo": MEMO, "mined_height": 7}


class EvidenceDatabase:
    """Explicit query boundary, recording SQL and its bound parameters."""
    def __init__(self, receipt=None, legacy=None, events=(), creator=True, has_receipts=True):
        self.receipt, self.legacy, self.events = receipt, legacy, events
        self.creator, self.has_receipts = creator, has_receipts
        self.queries = []

    def has_table(self, name):
        assert name == "tuzis_zeccreditreceipt"
        return self.has_receipts

    def one(self, sql, params=()):
        self.queries.append((sql, params))
        if "FROM g12f_creator" in sql:
            return (1, "fixture-user", 100) if self.creator else None
        if "FROM tuzis_zeccreditreceipt" in sql:
            assert params == (TXID, 2, "orchard")
            return self.receipt
        if "FROM g12f_transaction" in sql:
            return self.legacy
        raise AssertionError(sql)

    def all(self, sql, params=()):
        self.queries.append((sql, params))
        assert "FROM events_event" in sql
        return self.events


class MemoTests(unittest.TestCase):
    def test_memo_envelope_parity(self):
        for raw in (bytes.fromhex(MEMO), b"prefix " + bytes.fromhex(MEMO) + b"\x00 suffix"):
            self.assertEqual(verify.parse_memo(raw.hex()),
                             ({"act": "buy_2z", "id": "fixture-user"}, None))
        for raw in ("", "zz", "ff", b"no object".hex(), b"{invalid}".hex()):
            self.assertIsNotNone(verify.parse_memo(raw)[1])

    def test_exact_amount_selection_and_precedence(self):
        self.assertEqual(verify.select_notes([NOTE], amount="1.23456789"), [NOTE])
        self.assertEqual(verify.select_notes([NOTE], amount="1.23456788"), [])
        self.assertEqual(verify.select_notes([NOTE], txid=TXID.upper(), username="other"), [NOTE])
        self.assertEqual(verify.select_notes([NOTE], username="other"), [])
        for amount in ("NaN", "Infinity", "-1", "0.000000001", "184467440737.09551616"):
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                verify.select_notes([NOTE], amount=amount)


class CreditTests(unittest.TestCase):
    def run_check(self, db):
        result = verify.Result()
        with contextlib.redirect_stdout(io.StringIO()):
            code = verify.check_credits(result, db, [(NOTE, {"act": "buy_2z", "id": "fixture-user"})])
        self.assertTrue(all(sql.startswith("SELECT ") for sql, _ in db.queries))
        return code, result

    def test_exact_receipt_and_query_identity(self):
        db = EvidenceDatabase(receipt=(100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456789")))
        code, _ = self.run_check(db)
        self.assertEqual(code, 0)
        self.assertEqual(len(db.queries), 2)

    def test_receipt_collisions_never_pass(self):
        for receipt, expected in (
                ((100, 81, True, "fixture-time", "fixture-user", Decimal("1.23456789")), 1),
                ((100, 81, False, "fixture-time", "other", Decimal("1.23456789")), 1),
                ((100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456788")), 1),
                ((100, 81, False, "fixture-time", "fixture-user", None), 2)):
            with self.subTest(receipt=receipt):
                self.assertEqual(self.run_check(EvidenceDatabase(receipt=receipt))[0], expected)

    def test_legacy_or_absent_evidence(self):
        self.assertEqual(self.run_check(EvidenceDatabase())[0], 1)
        marker = (Decimal("1.23456789"), "fixture-action", 1, "fixture-time")
        for receipts in (True, False):
            self.assertEqual(self.run_check(EvidenceDatabase(legacy=marker, has_receipts=receipts))[0], 1)
            self.assertEqual(self.run_check(EvidenceDatabase(legacy=marker, events=[(100, "time")],
                                                             has_receipts=receipts))[0], 2)
        self.assertEqual(self.run_check(EvidenceDatabase(creator=False))[0], 1)

    def test_failed_stage_outweighs_inconclusive(self):
        result = verify.Result()
        with contextlib.redirect_stdout(io.StringIO()):
            result.record("one", verify.SKIP, "missing")
            self.assertEqual(result.exit_code(), 2)
            result.record("two", verify.FAIL, "mismatch")
            self.assertEqual(result.exit_code(), 1)


class WalletDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "wallet?#.sqlite"
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.executescript("""
            CREATE TABLE transactions(id_tx INTEGER, txid BLOB, mined_height INTEGER);
            CREATE TABLE blocks(height INTEGER);
            CREATE TABLE addresses(account_id INTEGER, address TEXT, key_scope INTEGER);
            CREATE TABLE orchard_received_notes(transaction_id INTEGER, value INTEGER,
                memo BLOB, action_index INTEGER);
            INSERT INTO blocks VALUES (7), (8), (9);
            INSERT INTO addresses VALUES (5, 'fixture-address', 0);
        """)
        self.conn.execute("INSERT INTO transactions VALUES (1, ?, 7)", (bytes.fromhex(TXID)[::-1],))
        self.conn.execute("INSERT INTO orchard_received_notes VALUES (1, ?, ?, 2)",
                          (NOTE["amountZat"], bytes.fromhex(MEMO)))
        self.conn.commit()

    def diagnose(self, reported=(NOTE,), pending=(), **kwargs):
        class Adapter:
            dummy = False
            def recieved_by(self, address):
                return list(reported)
        adapter = Adapter()
        adapter.pending = pending
        with contextlib.redirect_stdout(io.StringIO()):
            return verify.diagnose(self.path, adapter, txid=TXID, **kwargs)

    def test_wallet_queries_and_txid_order(self):
        self.assertEqual(verify.wallet_notes(self.path), [NOTE])
        self.assertEqual(verify.note_height(self.path, TXID), 7)
        self.assertIsNone(verify.note_height(self.path, "01" * 32))
        facts = verify.wallet_facts(self.path)
        self.assertEqual((facts["tip"], facts["low"], facts["blocks"]), (9, 7, 3))
        self.assertEqual(facts["external_addresses"], [(5, "fixture-address")])
        self.assertEqual(self.diagnose().exit_code(), 2)

    def test_unknown_pool_is_read_directly_and_identifiers_are_quoted(self):
        self.conn.execute('CREATE TABLE "odd""_received_notes" '
                          '(transaction_id INTEGER, value_zat INTEGER, output_index INTEGER)')
        self.conn.execute('INSERT INTO "odd""_received_notes" VALUES (1, 1, 0)')
        self.conn.commit()
        notes = verify.wallet_notes(self.path)
        self.assertEqual({n["pool"] for n in notes}, {"orchard", 'odd"'})
        self.assertEqual(self.diagnose().exit_code(), 1)

    def test_pending_is_inconclusive_but_missing_is_failure(self):
        self.assertEqual(self.diagnose(reported=(), pending=[(TXID, "orchard", 1)]).exit_code(), 2)
        self.assertEqual(self.diagnose(reported=()).exit_code(), 1)
        missing_index = dict(NOTE)
        del missing_index["output_index"]
        self.assertEqual(self.diagnose(reported=[missing_index]).exit_code(), 1)
        missing_pool = dict(NOTE)
        del missing_pool["pool"]
        self.assertEqual(self.diagnose(reported=[missing_pool]).exit_code(), 1)

    def test_read_errors_are_inconclusive_and_do_not_leak_exceptions(self):
        self.conn.execute("DROP TABLE transactions")
        self.conn.commit()
        result = self.diagnose()
        self.assertEqual(result.exit_code(), 2)
        self.assertEqual(result.stages[0][0], "1 WALLET")

    def test_valid_credit_and_malformed_recipient(self):
        db = EvidenceDatabase(receipt=(100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456789")))
        self.assertEqual(self.diagnose(database=db).exit_code(), 0)
        for recipient in (None, [], 5, ""):
            memo = json.dumps({"act": "buy_2z", "id": recipient}).encode()
            self.conn.execute("UPDATE orchard_received_notes SET memo = ?", (memo,))
            self.conn.commit()
            self.assertEqual(self.diagnose().exit_code(), 1)

    def test_cli_requires_explicit_private_connection_settings(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            verify.main(["--txid", TXID])
        self.assertEqual(raised.exception.code, 2)

    def test_cli_uses_canonical_adapter_boundary_and_no_database(self):
        class Adapter:
            dummy = False
            def recieved_by(self, address):
                return [NOTE]
        with patch.object(verify, "canonical_client", return_value=Adapter()) as factory:
            with contextlib.redirect_stdout(io.StringIO()):
                code = verify.main(["--txid", TXID, "--wallet-db", str(self.path),
                                    "--wallet-account", "5", "--min-confirmations", "3", "--no-db"])
        self.assertEqual(code, 2)
        factory.assert_called_once_with(str(self.path), 5, 3)


if __name__ == "__main__":
    unittest.main()
