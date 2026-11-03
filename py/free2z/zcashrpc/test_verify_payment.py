"""Payment diagnostics against synthetic SQLite notes and receipt evidence."""
import contextlib
import io
import json
import os
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
    def test_memo_parser_matches_the_canonical_purchase_writer(self):
        for raw in (bytes.fromhex(MEMO), bytes.fromhex(MEMO).ljust(512, b"\0")):
            self.assertEqual(verify.parse_memo(raw.hex()),
                             ({"act": "buy_2z", "id": "fixture-user"}, None))
        for raw in ("", "zz", "ff", b"no object".hex(), b"{invalid}".hex()):
            self.assertIsNotNone(verify.parse_memo(raw)[1])

    def test_permissive_legacy_envelopes_and_ambiguous_fields_are_rejected(self):
        from dj.apps.g12f.paymentd_memo import parse_memo as canonical_parser

        rejected = (
            b'Payment: {"act":"buy_2z","id":"fixture-user"}',
            b'{"act":"buy_2z","id":"first","id":"fixture-user"}',
            b'{"act":"buy_2z","id":"fixture-\0user"}',
            b'{"act":"buy_2z","id":"fixture-user","unsupported":true}',
            b'{"act":"buy_2z","id":"fixture-user","promo":NaN}',
        )
        for raw in rejected:
            with self.subTest(raw=raw):
                self.assertFalse(canonical_parser(raw.ljust(512, b"\0")).buy)
                self.assertIsNotNone(verify.parse_memo(raw.hex())[1])
        for raw in (bytes.fromhex(MEMO) + b"\0", b"x" * 513):
            self.assertIsNotNone(verify.parse_memo(raw.hex())[1])
        accepted = b'{"act":"buy_2z","id":"fixture-user","promo":"fixture-promo"}'
        self.assertTrue(canonical_parser(accepted.ljust(512, b"\0")).buy)
        self.assertIsNone(verify.parse_memo(accepted.hex())[1])

    def test_exact_amount_selection_and_precedence(self):
        self.assertEqual(verify.select_notes([NOTE], amount="1.23456789"), [NOTE])
        self.assertEqual(verify.select_notes([NOTE], amount="1.23456788"), [])
        self.assertEqual(verify.select_notes([NOTE], txid=TXID.upper(), username="other"), [NOTE])
        self.assertEqual(verify.select_notes([NOTE], username="other"), [])
        for amount in ("NaN", "Infinity", "-1", "0.000000001", "1.234567890000000000000000000001",
                       "184467440737.09551616"):
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

    def test_wrong_credit_quantities_and_rates_do_not_pass(self):
        for quantity, rate in ((0, 81), (81000000, 81), (-1, 81), (100, 0),
                               ("NaN", 81), (100, "Infinity")):
            receipt = (quantity, rate, False, "fixture-time", "fixture-user", Decimal("1.23456789"))
            self.assertEqual(self.run_check(EvidenceDatabase(receipt=receipt))[0], 1)
        for quantity, rate in ((None, 81), (100, None)):
            receipt = (quantity, rate, False, "fixture-time", "fixture-user", Decimal("1.23456789"))
            self.assertEqual(self.run_check(EvidenceDatabase(receipt=receipt))[0], 2)
        # Half-even tie cases at the 0.001 credit column precision.
        self.assertTrue(verify.credit_quantity_matches(Decimal("0.000"), Decimal("0.0005"), 100000000))
        self.assertTrue(verify.credit_quantity_matches(Decimal("0.002"), Decimal("0.0015"), 100000000))
        self.assertFalse(verify.credit_quantity_matches(Decimal("0.001"), Decimal("0.0005"), 100000000))

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
            CREATE TABLE transactions(id_tx INTEGER, txid BLOB, mined_height INTEGER, raw BLOB);
            CREATE TABLE blocks(height INTEGER);
            CREATE TABLE addresses(account_id INTEGER, address TEXT, key_scope INTEGER);
            CREATE TABLE orchard_received_notes(transaction_id INTEGER, value INTEGER,
                memo BLOB, action_index INTEGER);
            INSERT INTO blocks VALUES (7), (8), (9);
            INSERT INTO addresses VALUES (5, 'fixture-address', 0);
        """)
        self.conn.execute("INSERT INTO transactions VALUES (1, ?, 7, x'01')", (bytes.fromhex(TXID)[::-1],))
        self.conn.execute("INSERT INTO orchard_received_notes VALUES (1, ?, ?, 2)",
                          (NOTE["amountZat"], bytes.fromhex(MEMO)))
        self.conn.commit()

    def diagnose(self, reported=(NOTE,), pending=(), *, client=None, txid=TXID, **kwargs):
        class Adapter:
            dummy = False
            def recieved_by(self, address):
                return list(reported)
        if client is None:
            client = Adapter()
            client.pending = pending
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = verify.diagnose(self.path, client, txid=txid, **kwargs)
        self.output = output.getvalue()
        return result

    def test_empty_wallet_reports_detection_failure_and_watched_address(self):
        self.conn.executescript("DELETE FROM orchard_received_notes; DELETE FROM transactions;")
        result = self.diagnose(reported=())
        self.assertEqual(result.exit_code(), 1)
        self.assertEqual([(s, status) for s, status, _ in result.stages],
                         [("1 WALLET", verify.FAIL)])
        self.assertIn("external addresses watched: fixture-address", self.output)
        self.assertIn("no matching decrypted note", self.output)

    def test_username_typo_names_detected_purchase_instead_of_lost_wallet_detection(self):
        result = self.diagnose(txid=None, username="other")
        self.assertEqual(result.exit_code(), 1)
        self.assertEqual([(s, status) for s, status, _ in result.stages],
                         [("1 WALLET", verify.FAIL)])
        self.assertIn("other detected purchase memos name 'fixture-user'", self.output)

    def test_unmined_and_shallow_notes_report_depth_without_claiming_credit(self):
        for height, description in ((None, "not mined"), (9, "1 confirmation(s)")):
            with self.subTest(height=height):
                self.conn.execute("UPDATE transactions SET mined_height = ?", (height,))
                self.conn.commit()
                client = verify.canonical_client(self.path, 5, 3)
                result = self.diagnose(client=client)
                self.assertEqual(result.exit_code(), 2)
                self.assertIn(description, self.output)
                self.assertEqual([(s, status) for s, status, _ in result.stages], [
                    ("1 WALLET", verify.PASS), ("2 ADAPTER", verify.SKIP),
                    ("3 MEMO", verify.PASS), ("4 RECIPIENT", verify.SKIP),
                    ("5 CREDIT", verify.SKIP),
                ])

    def test_dummy_adapter_is_refused_even_when_wallet_evidence_exists(self):
        client = verify.canonical_client(self.path, 5, 3)
        client.dummy = True
        result = self.diagnose(client=client)
        self.assertEqual(result.exit_code(), 1)
        self.assertEqual([(s, status) for s, status, _ in result.stages],
                         [("2 ADAPTER", verify.FAIL)])
        self.assertIn("dummy adapter", self.output)

    def test_missing_wallet_with_real_adapter_is_inconclusive(self):
        client = verify.canonical_client(self.path, 5, 3)
        self.assertFalse(client.dummy)
        missing = self.path.with_name("missing.sqlite")
        with contextlib.redirect_stdout(io.StringIO()):
            result = verify.diagnose(missing, client, txid=TXID)
        self.assertEqual(result.exit_code(), 2)
        self.assertEqual([(s, status) for s, status, _ in result.stages],
                         [("1 WALLET", verify.SKIP)])
        self.assertFalse(missing.exists())

    def test_good_wallet_without_credit_database_passes_only_wallet_adapter_and_memo(self):
        result = self.diagnose(client=verify.canonical_client(self.path, 5, 3))
        self.assertEqual(result.exit_code(), 2)
        self.assertEqual([(s, status) for s, status, _ in result.stages], [
            ("1 WALLET", verify.PASS), ("2 ADAPTER", verify.PASS),
            ("3 MEMO", verify.PASS), ("4 RECIPIENT", verify.SKIP),
            ("5 CREDIT", verify.SKIP),
        ])

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
        result = self.diagnose()
        self.assertEqual(result.exit_code(), 1)
        self.assertEqual([(s, status) for s, status, _ in result.stages[:2]],
                         [("1 WALLET", verify.PASS), ("2 ADAPTER", verify.FAIL)])

    def test_pending_is_inconclusive_but_missing_is_failure(self):
        self.assertEqual(self.diagnose(reported=(), pending=[(TXID, "orchard", 1)]).exit_code(), 2)
        self.assertEqual(self.diagnose(reported=()).exit_code(), 1)
        missing_index = dict(NOTE)
        del missing_index["output_index"]
        self.assertEqual(self.diagnose(reported=[missing_index]).exit_code(), 1)
        missing_pool = dict(NOTE)
        del missing_pool["pool"]
        self.assertEqual(self.diagnose(reported=[missing_pool]).exit_code(), 1)

    def test_pending_credit_is_inconclusive_with_database(self):
        result = self.diagnose(reported=(), pending=[(TXID, "orchard", 1)],
                               database=EvidenceDatabase())
        self.assertEqual(result.exit_code(), 2)
        self.assertIn(("5 CREDIT", verify.SKIP), [(stage, status) for stage, status, _ in result.stages])
        self.assertFalse(any(status == verify.FAIL for _, status, _ in result.stages))
        # A pending note in a different pool does not explain this missing note.
        self.assertEqual(self.diagnose(reported=(), pending=[(TXID, "sapling", 1)],
                                       database=EvidenceDatabase()).exit_code(), 1)

    def test_read_errors_are_inconclusive_and_do_not_leak_exceptions(self):
        self.conn.execute("DROP TABLE transactions")
        self.conn.commit()
        result = self.diagnose()
        self.assertEqual(result.exit_code(), 2)
        self.assertEqual(result.stages[0][0], "1 WALLET")

    def test_valid_credit_and_malformed_recipient(self):
        db = EvidenceDatabase(receipt=(100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456789")))
        self.assertEqual(self.diagnose(database=db).exit_code(), 0)
        for recipient in (None, [], 5, "", " "):
            memo = json.dumps({"act": "buy_2z", "id": recipient}).encode()
            self.conn.execute("UPDATE orchard_received_notes SET memo = ?", (memo,))
            self.conn.commit()
            self.assertEqual(self.diagnose().exit_code(), 1)

    def test_mixed_recipients_do_not_pass_an_explicit_username_check(self):
        other_memo = json.dumps({"act": "buy_2z", "id": "other-user"}).encode()
        self.conn.execute("INSERT INTO orchard_received_notes VALUES (1, ?, ?, 3)",
                          (NOTE["amountZat"], other_memo))
        self.conn.commit()
        other_note = dict(NOTE, output_index=3, memo=other_memo.hex())
        db = EvidenceDatabase()
        result = self.diagnose(reported=[NOTE, other_note], username="fixture-user",
                               amount="1.23456789", database=db)
        self.assertEqual(result.exit_code(), 1)
        self.assertIn(("3 MEMO", verify.FAIL), [(stage, status) for stage, status, _ in result.stages])
        self.assertEqual(db.queries, [])

    def test_malformed_second_memo_cannot_hide_behind_a_credited_note(self):
        self.conn.execute("INSERT INTO orchard_received_notes VALUES (1, ?, ?, 3)",
                          (NOTE["amountZat"], b"{malformed}"))
        self.conn.commit()
        second = dict(NOTE, output_index=3, memo=b"{malformed}".hex())
        db = EvidenceDatabase(receipt=(100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456789")))
        result = self.diagnose(reported=[NOTE, second], database=db)
        self.assertEqual(result.exit_code(), 1)
        self.assertIn(("3 MEMO", verify.FAIL), [(stage, status) for stage, status, _ in result.stages])

    def test_unavailable_or_conflicting_adapter_fields_cannot_pass(self):
        receipt = (100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456789"))
        for fields, expected in (({"memo": "", "memo_available": False}, 2),
                                 ({"memo": ""}, 1), ({"amountZat": 1}, 1),
                                 ({"output_index_reliable": False}, 1)):
            with self.subTest(fields=fields):
                result = self.diagnose(reported=[dict(NOTE, **fields)],
                                       database=EvidenceDatabase(receipt=receipt))
                self.assertEqual(result.exit_code(), expected)
                self.assertNotIn(("2 ADAPTER", verify.PASS),
                                 [(stage, status) for stage, status, _ in result.stages])

    def test_canonical_missing_memo_output_cannot_make_a_credited_purchase_fail(self):
        for memo in (None, b"\xf6"):
            with self.subTest(memo=memo):
                self.conn.execute("DELETE FROM orchard_received_notes WHERE action_index=3")
                self.conn.execute("INSERT INTO orchard_received_notes VALUES (1, ?, ?, 3)",
                                  (NOTE["amountZat"], memo))
                self.conn.commit()
                db = EvidenceDatabase(receipt=(100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456789")))
                with contextlib.redirect_stdout(io.StringIO()):
                    client = verify.canonical_client(self.path, 5, 3)
                    result = verify.diagnose(self.path, client, txid=TXID, database=db)
                self.assertEqual(result.exit_code(), 2)
                self.assertIn(("3 MEMO", verify.SKIP), [(stage, status) for stage, status, _ in result.stages])
                self.assertIn(("5 CREDIT", verify.PASS), [(stage, status) for stage, status, _ in result.stages])
                self.assertFalse(any(status == verify.FAIL for _, status, _ in result.stages))

    def test_canonical_sole_missing_memo_is_inconclusive_without_credit_queries(self):
        for memo in (None, b"\xf6"):
            with self.subTest(memo=memo):
                self.conn.execute("UPDATE orchard_received_notes SET memo=?", (memo,))
                self.conn.commit()
                db = EvidenceDatabase()
                with contextlib.redirect_stdout(io.StringIO()):
                    client = verify.canonical_client(self.path, 5, 3)
                    result = verify.diagnose(self.path, client, txid=TXID, database=db)
                self.assertEqual(result.exit_code(), 2)
                self.assertFalse(any(status == verify.FAIL for _, status, _ in result.stages))
                self.assertEqual(db.queries, [])

    def test_only_nonpurchase_notes_are_inconclusive_without_credit_queries(self):
        memo = json.dumps({"act": "other", "id": "fixture-user"}).encode()
        self.conn.execute("UPDATE orchard_received_notes SET memo=?", (memo,))
        self.conn.commit()
        db = EvidenceDatabase()
        result = self.diagnose(reported=[dict(NOTE, memo=memo.hex())], database=db)
        self.assertEqual(result.exit_code(), 2)
        self.assertIn(("3 MEMO", verify.SKIP), [(stage, status) for stage, status, _ in result.stages])
        self.assertFalse(any(status == verify.FAIL for _, status, _ in result.stages))
        self.assertEqual(db.queries, [])

    def test_nonpurchase_second_note_is_explicitly_inconclusive(self):
        memo = json.dumps({"act": "other", "id": "fixture-user"}).encode()
        self.conn.execute("INSERT INTO orchard_received_notes VALUES (1, ?, ?, 3)",
                          (NOTE["amountZat"], memo))
        self.conn.commit()
        second = dict(NOTE, output_index=3, memo=memo.hex())
        db = EvidenceDatabase(receipt=(100, 81, False, "fixture-time", "fixture-user", Decimal("1.23456789")))
        result = self.diagnose(reported=[NOTE, second], database=db)
        self.assertEqual(result.exit_code(), 2)
        self.assertIn(("3 MEMO", verify.SKIP), [(stage, status) for stage, status, _ in result.stages])

    def test_canonical_adapter_is_readonly_and_restores_environment(self):
        with patch.dict(os.environ, {"WALLET_DB": "prior-wallet", "WALLET_ACCOUNT": "9",
                                     "ZEC_MIN_CONFIRMATIONS": "8"}):
            with contextlib.redirect_stdout(io.StringIO()):
                client = verify.canonical_client(self.path, 5, 3)
                notes = client.recieved_by("")
            self.assertEqual(os.environ["WALLET_DB"], "prior-wallet")
            self.assertEqual(os.environ["WALLET_ACCOUNT"], "9")
            self.assertEqual(os.environ["ZEC_MIN_CONFIRMATIONS"], "8")
        self.assertEqual(client.account, 5)
        self.assertEqual(client.min_confirmations, 3)
        self.assertEqual([(n["txid"], n["amountZat"], n["output_index"]) for n in notes],
                         [(TXID, NOTE["amountZat"], 2)])
        conn = client._conn()
        self.assertIsNone(conn.row_factory)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("DELETE FROM transactions")
        conn.close()

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
