"""Synthetic policy tests; no wallet process, keys or network are used."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from zcashrpc import sweep_policy as policy

# A checksum-only bech32m fixture, not a valid payment receiver.
DESTINATION = "a1lqfn3a"
PROPOSAL = ("  Steps (1):\n      Payments (1):\n"
            "        [0] -> " + DESTINATION + "\n      Fee: 0.00010000 ZEC\n")
TXID = bytes(range(32)).hex()


class ParsingTests(unittest.TestCase):
    def test_integer_bounds_and_json_shape(self):
        for value in (0, 1, policy.U64_MAX):
            self.assertEqual(policy.json_u64(json.dumps({"value": value}), "value"), value)
        for text in ('{"value":true}', '{"value":-1}', '{"value":1.0}',
                     '{"value":1e2}', '{"value":"1"}', '{"value":null}',
                     '{"value":1junk}', '{"value":1}garbage',
                     '{"value":0,"value":1}', '{"value":1,"x":{"a":1,"a":2}}',
                     '{"nested":{"value":1}}', '[]', 'null',
                     '{"value":1,"other":NaN}', '{"value":1,"other":Infinity}',
                     json.dumps({"value": policy.U64_MAX + 1})):
            with self.subTest(text=text), self.assertRaises(policy.PolicyError):
                policy.json_u64(text, "value")

    def test_exact_zatoshis(self):
        for text, expected in (("  0.00010000 ZEC", 10000), ("1.00000001", 100000001),
                               ("0001.00000000 ZEC", 100000000),
                               ("184467440737.09551615 ZEC", policy.U64_MAX)):
            self.assertEqual(policy.zec_to_zats(text), expected)
        for text in ("0.1 ZEC", "1.000000001 ZEC", "-1.00000000 ZEC", "NaN", "1e2",
                     "1.00000000 ZEC garbage!", "1.00000000 ZEC2", "1.00000000.0",
                     "184467440737.09551616 ZEC", 1, None):
            with self.subTest(text=text), self.assertRaises(policy.PolicyError):
                policy.zec_to_zats(text)

    def test_checksum_and_prefix_are_both_required(self):
        self.assertTrue(policy.bech32m_ok(DESTINATION, "a"))
        for address, hrp in ((DESTINATION, "u"), (DESTINATION.upper(), "a"),
                             ("a1lqfn3q", "a"), ("a1lqfn3b", "a"), ("a1", "a"),
                             ("1lqfn3a", ""), (None, "a")):
            self.assertFalse(policy.bech32m_ok(address, hrp))

    def test_proposal_exact_shape_and_limits(self):
        validate = lambda text, reserve=10000: policy.validate_proposal(
            text, destination=DESTINATION, reserve_zats=reserve, expected_hrp="a")
        self.assertEqual(validate(PROPOSAL).fee_zats, 10000)
        bad = [PROPOSAL.replace("Steps (1)", "Steps (2)"),
               PROPOSAL + "  Steps (2):\n", PROPOSAL + "      Payments (2):\n",
               PROPOSAL.replace("Payments (1)", "Payments (0)"),
               PROPOSAL + "        [1] -> another\n", PROPOSAL + "      Fee: 0.00000000 ZEC\n",
               PROPOSAL.replace("[0]", "[1]"), PROPOSAL.replace(DESTINATION, "a1lqfn3q"),
               PROPOSAL.replace("0.00010000", "0.1"), PROPOSAL.replace("      Fee:", "Fee:")]
        for text in bad:
            with self.subTest(text=text), self.assertRaises(policy.PolicyError):
                validate(text)
        with self.assertRaises(policy.PolicyError):
            validate(PROPOSAL, 9999)

    def test_spendable_value_and_reserve_bounds(self):
        balance = '{"sapling_spendable":2,"orchard_spendable":3,"ironwood_spendable":5,"transparent_spendable":100}'
        self.assertEqual(policy.shielded_spendable(balance), 10)
        self.assertEqual(policy.sweep_value(spendable_zats=10, threshold_zats=10,
                                          reserve_zats=2, maximum_zats=8), 8)
        self.assertEqual(policy.sweep_value(spendable_zats=9, threshold_zats=10,
                                          reserve_zats=2, maximum_zats=8), 0)
        self.assertEqual(policy.sweep_value(spendable_zats=10, threshold_zats=10,
                                          reserve_zats=10, maximum_zats=8), 0)
        with self.assertRaises(policy.PolicyError):
            policy.sweep_value(spendable_zats=11, threshold_zats=10,
                               reserve_zats=2, maximum_zats=8)
        self.assertEqual(policy.next_reserve(reserve_zats=2, attempts_used=1,
                                            maximum_attempts=2, maximum_zats=4), 4)
        for attempts, cap in ((2, 4), (1, 3)):
            self.assertIsNone(policy.next_reserve(reserve_zats=2, attempts_used=attempts,
                                                 maximum_attempts=2, maximum_zats=cap))
        with self.assertRaises(policy.PolicyError):
            policy.shielded_spendable(balance.replace('"sapling_spendable":2',
                                                      f'"sapling_spendable":{policy.U64_MAX}'))


class WalletTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        # URI metacharacters must remain part of the filename.
        self.path = Path(self.directory.name) / "wallet?#.sqlite"
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.execute("CREATE TABLE transactions(txid BLOB, fee INTEGER)")
        for table in policy._SPEND_TABLES:
            self.conn.execute(f"CREATE TABLE {table}(note INTEGER)")
        self.conn.commit()

    def test_readonly_and_missing_wallet(self):
        conn = policy.readonly_wallet(self.path)
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("DELETE FROM transactions")
        conn.close()
        missing = self.path.with_name("absent.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            policy.spend_rows(missing)
        self.assertFalse(missing.exists())

    def test_spend_rows_require_every_pool(self):
        self.assertEqual(policy.spend_rows(self.path), 0)
        for table in policy._SPEND_TABLES:
            self.conn.execute(f"INSERT INTO {table} VALUES (1)")
        self.conn.commit()
        self.assertEqual(policy.spend_rows(self.path), 4)
        self.conn.execute("DROP TABLE ironwood_received_note_spends")
        self.conn.commit()
        with self.assertRaises(sqlite3.OperationalError):
            policy.spend_rows(self.path)

    def test_txid_fee_in_either_byte_order(self):
        for tx in (bytes.fromhex(TXID), bytes.fromhex(TXID)[::-1]):
            self.conn.execute("DELETE FROM transactions")
            self.conn.execute("INSERT INTO transactions VALUES (?, ?)", (tx, 10000))
            self.conn.commit()
            self.assertEqual(policy.tx_fee_zats(self.path, TXID), 10000)

    def test_fee_unknown_corrupt_or_ambiguous(self):
        self.assertIsNone(policy.tx_fee_zats(self.path, TXID))
        for fee in (None, -1, "bad", 1.5):
            self.conn.execute("DELETE FROM transactions")
            self.conn.execute("INSERT INTO transactions VALUES (?, ?)", (bytes.fromhex(TXID), fee))
            self.conn.commit()
            self.assertIsNone(policy.tx_fee_zats(self.path, TXID))
        self.conn.execute("INSERT INTO transactions VALUES (?, ?)", (bytes.fromhex(TXID)[::-1], 10))
        self.conn.commit()
        self.assertIsNone(policy.tx_fee_zats(self.path, TXID))
        for txid in (TXID.upper(), "00", "g" * 64, "' OR 1=1 --"):
            with self.assertRaises(policy.PolicyError):
                policy.tx_fee_zats(self.path, txid)


class OutcomeTests(unittest.TestCase):
    def test_replay_decision_matrix(self):
        for status, after, fee, expected in (
                (0, 3, 10, policy.SendOutcome.CONFIRMED),
                (0, 3, 11, policy.SendOutcome.FEE_BREACH),
                (0, 3, None, policy.SendOutcome.FEE_UNVERIFIED),
                (1, 2, None, policy.SendOutcome.FAILED_NO_SPEND),
                (124, 2, None, policy.SendOutcome.FAILED_NO_SPEND),
                (0, 2, 10, policy.SendOutcome.UNRESOLVED),
                (1, 3, 10, policy.SendOutcome.UNRESOLVED),
                (0, None, None, policy.SendOutcome.UNRESOLVED),
                (1, None, None, policy.SendOutcome.UNRESOLVED),
                (1, 1, None, policy.SendOutcome.UNRESOLVED)):
            with self.subTest(status=status, after=after, fee=fee):
                self.assertEqual(policy.classify_send(send_status=status, pre_spends=2,
                                                     post_spends=after, fee_zats=fee,
                                                     reserve_zats=10), expected)
        with self.assertRaises(policy.PolicyError):
            policy.classify_send(send_status=True, pre_spends=2, post_spends=2,
                                 fee_zats=None, reserve_zats=10)


if __name__ == "__main__":
    unittest.main()
