"""Exercise the SQLite wallet adapter against a structural database fixture.

The fixture contains schema definitions only. Tests insert synthetic accounts,
notes, and transaction identifiers, then exercise adapter queries and application
crediting. These tests do not prove note decryption or validate a live wallet's
current schema; schema compatibility must be checked when wallet software changes.
"""
import codecs
import importlib.util
import json
import sqlite3
from decimal import Decimal
from pathlib import Path

import pytest
from django.core.management import call_command

from dj.apps.events.models import Event
from dj.apps.tuzis.models import ZecCreditReceipt, ZecPendingNotice

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCHEMA = Path(__file__).with_name("testdata") / "wallet-schema.sql"
_ADAPTER = Path(__file__).with_name("wallet_sqlite_client.py")
_COMMAND = "dj.apps.g12f.management.commands.credit_creators"

RATE = Decimal("90000.0000")


# --------------------------------------------------------------------------
# Loading the adapter that production actually runs
# --------------------------------------------------------------------------

def _load_adapter():
    """Import ``py/zcashrpc/wallet_sqlite_client.py`` by path.

    Loading the implementation by path keeps this contract independent from
    the selector tests below while exercising the exact module production
    imports when ``ZCASHRPC_CLIENT=wallet_sqlite``.
    """
    spec = importlib.util.spec_from_file_location(
        "zcashrpc_wallet_sqlite_client_under_test", _ADAPTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# Building a wallet that is structurally identical to the production one
# --------------------------------------------------------------------------

def _memo_bytes(payload):
    """A memo exactly as the wallet stores it: raw content bytes."""
    return json.dumps(payload).encode("ascii")


class WalletFixture:
    """A `zcash_client_sqlite` wallet on disk, built from the real schema."""

    def __init__(self, path):
        self.path = str(path)
        self._next_tx = 1
        conn = sqlite3.connect(self.path)
        try:
            conn.executescript(_SCHEMA.read_text())
            # An account and an address, so the notes below hang off
            # something the schema's CHECK constraints accept. `account_kind`
            # 1 is an imported-key account, which is what account 2 on
            # the payment host is; it needs no seed fingerprint.
            conn.execute(
                "INSERT INTO accounts (id, uuid, account_kind, uivk,"
                " birthday_height, has_spend_key)"
                " VALUES (1, X'00112233445566778899aabbccddeeff', 1,"
                " 'uivk-test', 3415000, 0)")
            conn.execute(
                "INSERT INTO addresses (id, account_id, key_scope,"
                " diversifier_index_be, address, receiver_flags,"
                " exposed_at_height)"
                " VALUES (1, 1, 0, X'0000000000000000000001',"
                " 'u1testaddress', 13, 3416232)")
            # A scanned block range, so anything reading confirmation depth
            # (zcash/verify_test_payment.py) has a chain tip to measure
            # against instead of dividing by a NULL.
            conn.executemany(
                "INSERT INTO blocks (height, hash, time, sapling_tree)"
                " VALUES (?, X'00', 0, X'00')",
                [(h,) for h in range(3450000, 3450100)])
            conn.commit()
        finally:
            conn.close()

    def add_note(self, *, txid_display, pool, index, zats, memo,
                 account_id=1, spent=False, raw=b"enhanced full transaction"):
        """Store one received note the way a scan would.

        ``txid_display`` is the txid a human reads (and a block explorer
        shows). The wallet stores the CONSENSUS byte order, which is the
        reverse -- the adapter is responsible for flipping it back, and a
        regression there would credit receipts under a txid no explorer can
        find, which is unrecoverable-by-hand rather than merely wrong.
        """
        table = f"{pool}_received_notes"
        index_col = "output_index" if pool == "sapling" else "action_index"
        conn = sqlite3.connect(self.path)
        try:
            row = conn.execute(
                "SELECT id_tx FROM transactions WHERE txid = ?",
                (bytes.fromhex(txid_display)[::-1],)).fetchone()
            if row is None:
                id_tx = self._next_tx
                self._next_tx += 1
                conn.execute(
                    "INSERT INTO transactions (id_tx, txid, mined_height,"
                    " min_observed_height, raw) VALUES (?, ?, ?, ?, ?)",
                    (id_tx, bytes.fromhex(txid_display)[::-1],
                     3450000, 3450000, raw))
            else:
                id_tx = row[0]
            note_id = conn.execute(
                f"INSERT INTO {table} (transaction_id, {index_col},"
                f" account_id, diversifier, value, "
                + ("rcm" if pool == "sapling" else "rho, rseed")
                + ", is_change, memo, address_id"
                + (", note_version" if pool in ("orchard", "ironwood") else "")
                + ") VALUES (?, ?, 1, X'00', ?, "
                + ("X'00'" if pool == "sapling" else "X'00', X'00'")
                + ", 0, ?, 1"
                + (", 2" if pool in ("orchard", "ironwood") else "")
                + ")",
                (id_tx, index, zats, memo)).lastrowid
            if spent:
                conn.execute(
                    f"INSERT INTO {pool}_received_note_spends"
                    f" ({pool}_received_note_id, transaction_id)"
                    f" VALUES (?, ?)", (note_id, id_tx))
            conn.commit()
        finally:
            conn.close()

    def add_transparent_output(self, *, txid_display, zats):
        conn = sqlite3.connect(self.path)
        try:
            id_tx = self._next_tx
            self._next_tx += 1
            conn.execute(
                "INSERT INTO transactions (id_tx, txid, mined_height,"
                " min_observed_height) VALUES (?, ?, ?, ?)",
                (id_tx, bytes.fromhex(txid_display)[::-1], 3450000, 3450000))
            conn.execute(
                "INSERT INTO transparent_received_outputs (transaction_id,"
                " output_index, account_id, address, script, value_zat,"
                " max_observed_unspent_height, address_id)"
                " VALUES (?, 0, 1, 't1test', X'00', ?, NULL, 1)",
                (id_tx, zats))
            conn.commit()
        finally:
            conn.close()

    def execute(self, sql):
        conn = sqlite3.connect(self.path)
        try:
            conn.executescript(sql)
            conn.commit()
        finally:
            conn.close()


@pytest.fixture
def wallet_file(tmp_path):
    return WalletFixture(tmp_path / "data.sqlite")


@pytest.fixture
def adapter(monkeypatch, wallet_file):
    """The production adapter, pointed at the fixture wallet."""
    module = _load_adapter()
    monkeypatch.setenv("WALLET_DB", wallet_file.path)
    monkeypatch.setenv("WALLET_ACCOUNT", "1")
    return module


# --------------------------------------------------------------------------
# The adapter's SQL actually runs against the deployed schema
# --------------------------------------------------------------------------

def test_the_adapter_reads_a_sapling_note_from_the_real_schema(
        adapter, wallet_file):
    """The single fact nothing in CI has ever checked.

    Break it by renaming a column the adapter names -- which is what a
    librustzcash schema migration does on the payment host's own schedule, with no PR
    here -- and every cycle prints `Saw 0 notes for 0 ZEC` forever.
    """
    wallet_file.add_note(
        txid_display="ab" * 32, pool="sapling", index=3, zats=12_345_678,
        memo=_memo_bytes({"act": "buy_2z", "id": "alice"}))

    notes = adapter.Client().recieved_by("ignored")

    assert len(notes) == 1
    note = notes[0]
    assert note["txid"] == "ab" * 32, "txid byte order was not flipped back"
    assert note["amountZat"] == 12_345_678
    assert note["amount"] == pytest.approx(0.12345678)
    assert note["output_index"] == 3
    assert note["pool"] == "sapling"
    assert json.loads(codecs.decode(note["memo"], "hex").decode()) == {
        "act": "buy_2z", "id": "alice"}


def test_the_adapter_flips_txid_byte_order(adapter, wallet_file):
    """A txid nobody can look up is worse than no txid.

    The wallet stores consensus order; explorers, receipts and every human
    procedure use display order. Drop the `[::-1]` and this fails.
    """
    display = "00112233445566778899aabbccddeeff" \
              "00112233445566778899aabbccddee00"
    wallet_file.add_note(
        txid_display=display, pool="orchard", index=0, zats=1,
        memo=_memo_bytes({"act": "buy_2z", "id": "bob"}))

    stored, = sqlite3.connect(wallet_file.path).execute(
        "SELECT txid FROM transactions").fetchone()
    assert bytes(stored).hex() != display, "fixture is not exercising the flip"
    assert adapter.Client().recieved_by("x")[0]["txid"] == display


def test_sapling_and_orchard_index_zero_are_different_notes(
        adapter, wallet_file):
    """Pool-local indices. Two notes, one transaction, both index 0."""
    memo = _memo_bytes({"act": "buy_2z", "id": "carol"})
    wallet_file.add_note(txid_display="cd" * 32, pool="sapling", index=0,
                         zats=100, memo=memo)
    wallet_file.add_note(txid_display="cd" * 32, pool="orchard", index=0,
                         zats=200, memo=memo)

    notes = adapter.Client().recieved_by("x")
    assert {(n["pool"], n["output_index"]) for n in notes} == {
        ("sapling", 0), ("orchard", 0)}


def test_schema_without_note_index_marks_the_conservative_fallback(
        adapter, wallet_file, monkeypatch):
    """Synthetic zero is not allowed to become a durable note identity."""
    wallet_file.add_note(
        txid_display="ce" * 32, pool="sapling", index=0, zats=100,
        memo=_memo_bytes({"act": "buy_2z", "id": "fallback"}))
    client = adapter.Client()
    original_pool_query = client._pool_query

    def missing_index(table, index_col, pool, indexed=True):
        if indexed:
            return original_pool_query(table, "missing_index", pool, indexed=True)
        return original_pool_query(table, index_col, pool, indexed=False)

    monkeypatch.setattr(client, "_pool_query", missing_index)
    note = client.recieved_by("x")[0]
    assert note["output_index"] == 0
    assert note["output_index_reliable"] is False


def test_unknown_memo_preserves_note_identity_but_is_not_eligible(
        adapter, wallet_file):
    """Unknown is reported by the audit, not interpreted as an instruction."""
    wallet_file.add_note(txid_display="ef" * 32, pool="orchard", index=0,
                         zats=500, memo=None)
    assert adapter.Client().recieved_by("x")[0]["memo"] == ""


@pytest.mark.parametrize("pool", ["sapling", "orchard", "ironwood"])
def test_unknown_hydration_isolated_from_a_different_verified_payment(
        adapter, wallet_file, pool):
    from zcashrpc.wallet_hydration import incomplete_received_transactions

    purchase = _memo_bytes({"act": "buy_2z", "id": "buyer"})
    wallet_file.add_note(txid_display="a1" * 32, pool=pool, index=0,
                         zats=1, memo=purchase, raw=None)
    wallet_file.add_note(txid_display="a2" * 32, pool=pool, index=1,
                         zats=909007, memo=purchase)
    wallet_file.add_note(txid_display="a3" * 32, pool=pool, index=2,
                         zats=1, memo=b"\xf6")
    notes = adapter.Client().recieved_by("x")
    assert len(notes) == 3, "reconciliation must retain every note identity"
    assert [n["memo"] for n in notes] == ["", purchase.hex(), "f6"]
    assert incomplete_received_transactions(wallet_file.path) == 1


def test_account_rescan_null_memo_is_unknown_despite_existing_full_transaction(
        adapter, wallet_file):
    from zcashrpc.wallet_hydration import incomplete_received_transactions

    txid = "a4" * 32
    purchase = _memo_bytes({"act": "buy_2z", "id": "buyer"})
    wallet_file.add_note(txid_display=txid, pool="sapling", index=0,
                         zats=100, memo=purchase)
    wallet_file.add_note(txid_display=txid, pool="sapling", index=1,
                         zats=200, memo=None)
    notes = adapter.Client().recieved_by("x")
    assert [n["memo"] for n in notes] == [purchase.hex(), ""]
    assert notes[1]["output_index"] == 1
    assert incomplete_received_transactions(wallet_file.path) == 1


@pytest.mark.parametrize("raw", [b"", "invalid raw text"])
def test_invalid_raw_masks_instruction_but_keeps_pending_reconciliation_identity(
        adapter, wallet_file, raw):
    purchase = _memo_bytes({"act": "buy_2z", "id": "buyer"})
    txid = "a5" * 32
    wallet_file.add_note(txid_display=txid, pool="ironwood", index=3,
                         zats=909007, memo=purchase, raw=raw)
    wallet_file.execute("UPDATE transactions SET mined_height = 3450099")
    client = adapter.Client()
    assert client.recieved_by("x") == []
    assert len(client.pending_notes) == 1
    note = client.pending_notes[0]
    assert (note["txid"], note["pool"], note["output_index"]) == (txid, "ironwood", 3)
    assert note["amountZat"] == 909007
    assert note["memo"] == ""


def test_a_wallet_with_no_note_tables_raises_instead_of_reporting_nothing(
        adapter, wallet_file):
    """"Not a wallet" must never render as "nobody paid us"."""
    wallet_file.execute(
        "DROP TABLE sapling_received_notes;"
        "DROP TABLE orchard_received_notes;"
        "DROP TABLE ironwood_received_notes;")
    with pytest.raises(sqlite3.OperationalError):
        adapter.Client().recieved_by("x")


# --------------------------------------------------------------------------
# Pools the adapter does not read
# --------------------------------------------------------------------------

def test_ironwood_notes_are_read(adapter, wallet_file):
    """The live wallet already has this table; the old adapter ignored it.

    Delete `ironwood_received_notes` from `Client._POOLS` and this fails --
    which is precisely the state the deployed adapter is in today, and the
    state in which a memo'd payment into that pool is received, held, and
    never credited, while the log says `Saw 0`.
    """
    wallet_file.add_note(
        txid_display="1a" * 32, pool="ironwood", index=7, zats=777,
        memo=_memo_bytes({"act": "buy_2z", "id": "dave"}))

    notes = adapter.Client().recieved_by("x")
    assert [(n["pool"], n["output_index"], n["amountZat"]) for n in notes] == [
        ("ironwood", 7, 777)]
    assert adapter.Client().unreadable_pools() == []


def test_a_pool_invented_after_this_code_was_written_is_reported(
        adapter, wallet_file):
    """A shielded pool nobody here has heard of, holding real notes.

    This is the failure mode the whole file is about: money arrives, the
    wallet stores it, `recieved_by` has no SELECT for it, and the only symptom
    is the log line an unpaid wallet produces.
    """
    wallet_file.execute(
        "CREATE TABLE tachyon_received_notes ("
        "  id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL,"
        "  action_index INTEGER NOT NULL, account_id INTEGER NOT NULL,"
        "  value INTEGER NOT NULL, memo BLOB);"
        "INSERT INTO tachyon_received_notes"
        "  (transaction_id, action_index, account_id, value, memo)"
        "  VALUES (1, 0, 1, 500000, NULL);")

    blind = adapter.Client().unreadable_pools()
    assert [(t, n) for t, n, _ in blind] == [("tachyon_received_notes", 1)]


def test_an_empty_unknown_pool_is_not_reported(adapter, wallet_file):
    """Negative control: the guard reports MONEY, not table names.

    Without this, `unreadable_pools` would page on every wallet upgrade that
    merely creates a table, and a real one would be lost in the noise.
    """
    wallet_file.execute(
        "CREATE TABLE tachyon_received_notes ("
        "  id INTEGER PRIMARY KEY, value INTEGER NOT NULL);")
    assert adapter.Client().unreadable_pools() == []


def test_a_transparent_payment_to_the_published_address_is_reported(
        adapter, wallet_file):
    """The published unified address has a P2PKH receiver (flags 13).

    A transparent-only sender -- an exchange withdrawal is the obvious one --
    can pay it. Transparent outputs carry no memo, so no `buy_2z` payload can
    ever be read from one and the buyer cannot be credited. That is a decision
    for a human, and it can only be made if somebody is told.
    """
    wallet_file.add_transparent_output(txid_display="2b" * 32, zats=10_000_000)
    blind = adapter.Client().unreadable_pools()
    assert [(t, n) for t, n, _ in blind] == [
        ("transparent_received_outputs", 1)]


def test_sweeping_a_transparent_payment_clears_the_alert(
        adapter, wallet_file):
    """The alert must have an exit, and the exit must be doing the work.

    `unreadable_pools` feeds a line that pages on presence AND withholds the
    heartbeat. Counting every output that ever arrived would mean one
    transparent payment pages every 90 seconds forever, with no action that
    stops it -- and every later, real failure buried under acknowledged
    history. (codex adversarial review.)

    Spending the output is the acknowledgement, and it is not a flag: it means
    a human actually swept the funds with `zcash-devtool send`.
    """
    wallet_file.add_transparent_output(txid_display="8b" * 32, zats=10_000_000)
    assert adapter.Client().unreadable_pools(), "fixture is not raising it"

    wallet_file.execute(
        "INSERT INTO transparent_received_output_spends"
        " (transparent_received_output_id, transaction_id)"
        " SELECT id, transaction_id FROM transparent_received_outputs")

    assert adapter.Client().unreadable_pools() == []


def test_an_unknown_pool_stays_reported_until_its_notes_are_spent(
        adapter, wallet_file):
    """Same exit for a shielded pool, and no exit while the money sits there.

    Teaching the adapter the pool is the real fix; sweeping is the acceptance
    that we hold funds we chose not to credit. Neither is "the alert got old".
    """
    wallet_file.execute(
        "CREATE TABLE tachyon_received_notes ("
        "  id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL,"
        "  action_index INTEGER NOT NULL, account_id INTEGER NOT NULL,"
        "  value INTEGER NOT NULL, memo BLOB);"
        "CREATE TABLE tachyon_received_note_spends ("
        "  tachyon_received_note_id INTEGER NOT NULL,"
        "  transaction_id INTEGER NOT NULL);"
        "INSERT INTO tachyon_received_notes"
        "  (id, transaction_id, action_index, account_id, value, memo)"
        "  VALUES (1, 1, 0, 1, 500000, NULL);")
    assert adapter.Client().unreadable_pools()

    wallet_file.execute(
        "INSERT INTO tachyon_received_note_spends"
        " (tachyon_received_note_id, transaction_id) VALUES (1, 1);")
    assert adapter.Client().unreadable_pools() == []


# --------------------------------------------------------------------------
# Confirmation depth -- 2Z are irreversible, a Zcash transaction is not
# --------------------------------------------------------------------------
#
# `transactions` legitimately holds rows with no `mined_height` during normal
# wallet operation (mempool, rollback). Every one of those used to be credited
# on the next 90-second cycle, and a transaction that then expires, is
# replaced, or is orphaned turns ZEC that does not exist into platform credits
# the buyer has already spent. Audit finding 12 records that the effective
# policy was zero and that nobody chose it.


def test_an_unmined_note_is_not_reported_for_crediting(adapter, wallet_file):
    wallet_file.add_note(
        txid_display="0b" * 32, pool="orchard", index=0, zats=100_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "hasty"}))
    wallet_file.execute("UPDATE transactions SET mined_height = NULL")

    client = adapter.Client()
    assert client.recieved_by("x") == []
    assert [t for t, _p, _c in client.pending] == ["0b" * 32]


def test_a_one_confirmation_note_is_held_and_a_deep_one_is_not(
        adapter, wallet_file):
    """The boundary, in both directions, so this is a floor and not a mute."""
    memo = _memo_bytes({"act": "buy_2z", "id": "deep"})
    wallet_file.add_note(txid_display="0c" * 32, pool="orchard", index=0,
                         zats=1, memo=memo)
    wallet_file.add_note(txid_display="0d" * 32, pool="orchard", index=0,
                         zats=2, memo=memo)
    # tip is 3450099: one confirmation vs three.
    wallet_file.execute(
        "UPDATE transactions SET mined_height = 3450099"
        " WHERE txid = X'" + ("0c" * 32) + "';"
        "UPDATE transactions SET mined_height = 3450097"
        " WHERE txid = X'" + ("0d" * 32) + "';")

    reported = adapter.Client().recieved_by("x")
    assert [n["txid"] for n in reported] == ["0d" * 32]
    assert reported[0]["confirmations"] == 3


def test_the_confirmation_floor_is_overridable_on_purpose(
        adapter, wallet_file, monkeypatch):
    """Zero is still reachable -- but only by someone choosing it."""
    wallet_file.add_note(
        txid_display="0e" * 32, pool="orchard", index=0, zats=1,
        memo=_memo_bytes({"act": "buy_2z", "id": "yolo"}))
    wallet_file.execute("UPDATE transactions SET mined_height = NULL")

    monkeypatch.setenv("ZEC_MIN_CONFIRMATIONS", "0")
    assert len(adapter.Client().recieved_by("x")) == 1


def test_a_malformed_confirmation_setting_does_not_disable_the_floor(
        adapter, wallet_file, monkeypatch, capsys):
    """A typo in an env var must not silently become "credit everything"."""
    monkeypatch.setenv("ZEC_MIN_CONFIRMATIONS", "three")
    client = adapter.Client()
    assert client.min_confirmations == adapter.Client.DEFAULT_MIN_CONFIRMATIONS
    assert "not an integer" in capsys.readouterr().out


@pytest.mark.parametrize("value", ["-1", "-100"])
def test_a_negative_confirmation_floor_is_refused(
        adapter, wallet_file, monkeypatch, capsys, value):
    """`0 < -1` is false, so a negative floor credits UNMINED notes.

    It is a valid integer, so the parse guard above does not catch it, and it
    silently reopens the exact hole the floor exists to close. (Found by the
    codex adversarial review.)
    """
    wallet_file.add_note(
        txid_display="2c" * 32, pool="orchard", index=0, zats=1,
        memo=_memo_bytes({"act": "buy_2z", "id": "reorg"}))
    wallet_file.execute("UPDATE transactions SET mined_height = NULL")

    monkeypatch.setenv("ZEC_MIN_CONFIRMATIONS", value)
    client = adapter.Client()
    assert client.min_confirmations == adapter.Client.DEFAULT_MIN_CONFIRMATIONS
    assert client.recieved_by("x") == [], "an unmined note was reported"
    assert "outside 0..100" in capsys.readouterr().out


def test_a_seconds_for_blocks_confirmation_floor_is_refused(
        adapter, wallet_file, monkeypatch, capsys):
    """`300` is the loop's INTERVAL, two lines away in credit-loop.sh.

    At ~75s/block it would hold every payment for six hours while the cycle
    kept heartbeating, because a held note is deliberately not an error -- a
    silent crediting outage with a green absence alert.
    """
    wallet_file.add_note(
        txid_display="2d" * 32, pool="orchard", index=0, zats=1,
        memo=_memo_bytes({"act": "buy_2z", "id": "slow"}))

    monkeypatch.setenv("ZEC_MIN_CONFIRMATIONS", "300")
    client = adapter.Client()
    assert client.min_confirmations == adapter.Client.DEFAULT_MIN_CONFIRMATIONS
    assert len(client.recieved_by("x")) == 1, (
        "a healthy, deeply-confirmed payment was held")
    assert "outside 0..100" in capsys.readouterr().out




@pytest.mark.django_db
def test_credit_creators_does_not_credit_an_unmined_note(
        adapter, wallet_file, creator_factory, mocker, capsys):
    """The whole point, at the boundary that spends money.

    Delete the confirmation check in `recieved_by` and this credits a
    transaction that is not in any block.
    """
    buyer = creator_factory(username="mempool", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="0f" * 32, pool="orchard", index=0, zats=50_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "mempool"}))
    wallet_file.execute("UPDATE transactions SET mined_height = NULL")

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0"), (
        "2Z were issued for a transaction that is not in a block; if it "
        "expires or is replaced, nothing unwinds them")
    assert ZecCreditReceipt.objects.count() == 0
    # Held, not blocked: nothing is wrong and no alert should fire.
    out = capsys.readouterr().out
    assert "holding 1 note(s) for confirmations" in out
    assert "CREDITING BLOCKED" not in out


@pytest.mark.django_db
def test_a_held_note_is_credited_once_it_matures(
        adapter, wallet_file, creator_factory, mocker):
    """A floor that never lets go is an outage, not a safety measure."""
    buyer = creator_factory(username="patient", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="1b" * 32, pool="orchard", index=0, zats=50_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "patient"}))
    wallet_file.execute("UPDATE transactions SET mined_height = 3450099")

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0")

    # Two more blocks are scanned; the note is now three deep.
    wallet_file.execute(
        "INSERT INTO blocks (height, hash, time, sapling_tree)"
        " VALUES (3450100, X'00', 0, X'00'), (3450101, X'00', 0, X'00');")
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("45000.000")


# --------------------------------------------------------------------------
# Balance (the sweep threshold)
# --------------------------------------------------------------------------

def test_spent_notes_do_not_count_towards_the_balance(adapter, wallet_file):
    """`spent_in` does not exist in the deployed schema.

    The old query named it, raised `OperationalError` on EVERY call, and fell
    through to a handler that summed every note ever received. The reported
    balance could therefore only ever grow. Restore the `spent_in` query and
    this fails.
    """
    memo = _memo_bytes({"act": "buy_2z", "id": "eve"})
    wallet_file.add_note(txid_display="3c" * 32, pool="orchard", index=0,
                         zats=1_000, memo=memo)
    wallet_file.add_note(txid_display="4d" * 32, pool="orchard", index=0,
                         zats=9_000, memo=memo, spent=True)

    assert adapter.Client()._unspent_zat() == 1_000


# --------------------------------------------------------------------------
# End to end: a note in a real wallet file becomes 2Z in real Postgres
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_note_in_a_real_wallet_file_becomes_2z(
        adapter, wallet_file, creator_factory, mocker, capsys):
    """The whole repo-side path, with no fake wallet anywhere.

    Real schema -> real adapter SQL -> real `credit_creators` -> real Postgres
    ledger. This is as close as anything offline gets to the live test payment
     asks for; the only step it does not cover is librustzcash decrypting
    the output in the first place.
    """
    buyer = creator_factory(username="realbuyer", tuzis=Decimal("0"))
    # Deliberately NOT a byte-palindrome. "5e" * 32 reads the same in either
    # byte order, so a receipt keyed on the reversed txid would still match it
    # and the assertion below would prove nothing.
    txid = "01" + "5e" * 31
    wallet_file.add_note(
        txid_display=txid, pool="orchard", index=2, zats=50_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "realbuyer"}))

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)

    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("45000.000")

    receipt = ZecCreditReceipt.objects.get()
    assert receipt.txid == txid, (
        "the receipt is keyed on a txid no block explorer can resolve, so a "
        "human reconciling this payment by hand has nothing to search for")
    assert receipt.output_index == 2
    assert receipt.pool == "orchard"
    assert "cycle ok" in capsys.readouterr().out


@pytest.mark.django_db
def test_the_same_wallet_scanned_twice_credits_once(
        adapter, wallet_file, creator_factory, mocker):
    """The loop rescans the same file every 90 seconds, forever."""
    buyer = creator_factory(username="twicebuyer", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="6f" * 32, pool="sapling", index=0, zats=10_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "twicebuyer"}))

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)

    call_command("credit_creators", no_color=True)
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("9000.000")
    assert ZecCreditReceipt.objects.count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize("pool", ["sapling", "orchard", "ironwood"])
def test_unknown_note_isolated_while_verified_purchase_credits_once(
        adapter, wallet_file, creator_factory, mocker, capsys, pool):
    from zcashrpc.wallet_hydration import main

    buyer = creator_factory(username="hydratedbuyer", tuzis=Decimal("0"))
    purchase = _memo_bytes({"act": "buy_2z", "id": "hydratedbuyer"})
    wallet_file.add_note(txid_display="b1" * 32, pool=pool, index=0,
                         zats=1, memo=purchase, raw=None)
    wallet_file.add_note(txid_display="b2" * 32, pool=pool, index=1,
                         zats=50_000_000, memo=purchase)
    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    for _ in range(2):
        assert main() == 0
        call_command("credit_creators", no_color=True)
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("45000.000")
    receipt = ZecCreditReceipt.objects.get()
    assert receipt.txid == "b2" * 32
    output = capsys.readouterr()
    assert "credit_creators: CREDITING BLOCKED - 1" in output.err
    assert "cycle ok" in output.out, "progress and degraded presence are separate"


@pytest.mark.django_db
def test_money_in_an_unreadable_pool_blocks_the_heartbeat(
        adapter, wallet_file, creator_factory, mocker, capsys):
    """Held-but-uncreditable money must not look like a healthy quiet cycle.

    Without the heartbeat suppression, `zec_credit_cycle_success` keeps
    ticking and the absence alert stays quiet while ZEC accumulates in a pool
    nothing reads -- green dashboards over lost money, which is the exact
    shape of the 11-month gap.
    """
    creator_factory(username="blindbuyer", tuzis=Decimal("0"))
    wallet_file.add_transparent_output(txid_display="7a" * 32, zats=5_000_000)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)

    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    assert "CREDITING BLOCKED" in out
    assert "transparent_received_outputs" in out
    assert "cycle ok" not in out, (
        "a cycle holding uncreditable money emitted the healthy heartbeat")


# --------------------------------------------------------------------------
# The harness against a REAL database -- stages 4 and 5
# --------------------------------------------------------------------------
#
# Everything above runs the harness with --no-db, which leaves its two most
# consequential branches untested: the one that tells an operator a payment
# landed, and the one that tells them to credit it by hand. Getting either
# wrong is a money decision, so they get a real Postgres. `transaction=True`
# is required -- the harness connects over psycopg2 on its own connection and
# cannot see an uncommitted test transaction.
























# --------------------------------------------------------------------------
# The address the product publishes is the address the wallet watches
# --------------------------------------------------------------------------





# --------------------------------------------------------------------------
# The verification harness (zcash/verify_test_payment.py)
# --------------------------------------------------------------------------
#
# The harness is what a human runs after sending the  test payment, and
# its whole value is that it names the stage that failed rather than printing
# another line that means nothing. A harness that reports PASS on a broken
# pipeline -- or that traceback-crashes on a legitimate state such as an
# unmined transaction -- is worse than no harness, so it gets the same
# treatment as the code it checks.























# --------------------------------------------------------------------------
# Zero-confirmation handling: the four minutes between "we can see it" and
# "the 2Z are on your balance"
# --------------------------------------------------------------------------
#
# The confirmation floor above is correct and stays. What it does not do is
# say anything to the buyer, and at ~75s per block three confirmations is
# about four minutes of total silence after somebody has sent real ZEC into a
# shielded address. These tests drive the REAL adapter over the REAL wallet
# schema into REAL Postgres, because the interesting failures are all at the
# seam: a held note the adapter never hands back, a notification the loop
# repeats every 90 seconds, and a note credited early and then credited again
# when it matures.


@pytest.fixture
def instant_on(monkeypatch):
    """Turn instant credit on with a 0.05 ZEC / 0.5 ZEC-per-day budget."""
    monkeypatch.setenv("ZEC_INSTANT_CREDIT_MAX_ZATOSHI", "5000000")
    monkeypatch.setenv("ZEC_INSTANT_CREDIT_DAILY_MAX_ZATOSHI", "50000000")


def _young(wallet_file, txid_display):
    """Mine this transaction one block below the tip: one confirmation."""
    wallet_file.execute(
        "UPDATE transactions SET mined_height = 3450099"
        " WHERE txid = X'" + txid_display + "';")


def test_the_adapter_hands_back_the_notes_it_is_holding(adapter, wallet_file):
    """A held note that nobody outside `recieved_by` can see IS the silence.

    Without `pending_notes` the caller has a count and a log line and no way
    to say anything to anybody, so a zero-confirmation policy of any kind --
    even "tell them" -- cannot be expressed at all.
    """
    wallet_file.add_note(
        txid_display="31" * 32, pool="orchard", index=0, zats=1_234_567,
        memo=_memo_bytes({"act": "buy_2z", "id": "seen"}))
    _young(wallet_file, "31" * 32)

    client = adapter.Client()
    assert client.recieved_by("x") == [], "a young note was offered for credit"
    assert len(client.pending_notes) == 1
    held = client.pending_notes[0]
    assert held["txid"] == "31" * 32
    assert held["amountZat"] == 1_234_567
    assert held["pool"] == "orchard"
    assert held["confirmations"] == 1
    assert held["memo"], "the memo is what names the buyer"
    # The two views stay in step.
    assert len(client.pending) == len(client.pending_notes)


@pytest.mark.django_db
def test_a_held_note_announces_itself_and_credits_nothing(
        adapter, wallet_file, creator_factory, mocker, capsys):
    """Part 1, with instant credit OFF -- which is the default.

    Delete the `notify_pending_note` call and this goes red: the buyer is
    told nothing for four minutes, which is the defect.
    """
    buyer = creator_factory(username="waiting", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="32" * 32, pool="orchard", index=0, zats=50_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "waiting"}))
    _young(wallet_file, "32" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0"), "a young note was credited"
    assert ZecCreditReceipt.objects.count() == 0
    assert ZecPendingNotice.objects.count() == 1
    assert Event.objects.filter(
        type="ZEC_PENDING", receiving_user=buyer).count() == 1
    out = capsys.readouterr().out
    assert "told waiting we can see" in out
    assert "CREDITING BLOCKED" not in out
    assert "CREDIT UNBACKED" not in out
    assert "credit_creators: cycle ok" in out, (
        "announcing a held note is not an error and must still heartbeat")


@pytest.mark.django_db
def test_the_buyer_is_not_told_once_per_cycle(
        adapter, wallet_file, creator_factory, mocker):
    """The loop runs every ~90 seconds and re-reads the same held note.

    Drop the `ZecPendingNotice` unique constraint (or the row entirely) and
    this buyer gets one notification per cycle for the whole wait.
    """
    creator_factory(username="spammed", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="33" * 32, pool="orchard", index=0, zats=50_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "spammed"}))
    _young(wallet_file, "33" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    for _ in range(5):
        call_command("credit_creators", no_color=True)

    assert Event.objects.filter(type="ZEC_PENDING").count() == 1
    assert ZecPendingNotice.objects.count() == 1


@pytest.mark.django_db
def test_announcing_a_note_does_not_stop_it_being_credited_later(
        adapter, wallet_file, creator_factory, mocker):
    """A notice must not be mistaken for a receipt.

    They are separate tables for exactly this reason: if the notice took the
    receipt's key, the buyer would be told about their payment and then never
    credited for it.
    """
    buyer = creator_factory(username="eventually", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="34" * 32, pool="orchard", index=0, zats=50_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "eventually"}))
    _young(wallet_file, "34" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    wallet_file.execute(
        "INSERT INTO blocks (height, hash, time, sapling_tree)"
        " VALUES (3450100, X'00', 0, X'00'), (3450101, X'00', 0, X'00');")
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("45000.000")
    assert Event.objects.filter(type="BOUGHT_TUZI").count() == 1
    assert Event.objects.filter(type="ZEC_PENDING").count() == 1


@pytest.mark.django_db
def test_a_small_note_is_credited_instantly_and_not_announced(
        adapter, wallet_file, creator_factory, mocker, instant_on, capsys):
    """Part 3. 0.01 ZEC is under the 0.05 ZEC per-note cap.

    Telling somebody we are "waiting for confirmation" in the same breath as
    crediting them would be a lie, so an instantly-credited note gets the
    BOUGHT_TUZI event and no pending notice.
    """
    buyer = creator_factory(username="instant", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="35" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "instant"}))
    _young(wallet_file, "35" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("900.000")
    receipt = ZecCreditReceipt.objects.get()
    assert receipt.instant is True
    assert receipt.confirmations_at_credit == 1
    assert ZecPendingNotice.objects.count() == 0
    assert Event.objects.filter(type="BOUGHT_TUZI").count() == 1
    assert "credited INSTANTLY at 1 confirmation(s)" in capsys.readouterr().out


@pytest.mark.django_db
def test_a_note_credited_at_zero_conf_is_never_credited_again(
        adapter, wallet_file, creator_factory, mocker, instant_on):
    """THE proof that instant credit cannot double-credit.

    The note is credited while young and then re-seen, cycle after cycle,
    once it matures past the floor. It must be worth exactly its 2Z once. The
    machinery that makes this true is the `(txid, pool, output_index)` unique
    constraint from  -- this pins that instant crediting rides on it
    rather than going round it.
    """
    buyer = creator_factory(username="once", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="36" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "once"}))
    _young(wallet_file, "36" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("900.000")

    # Two more blocks: the note is now three deep and comes back through the
    # ORDINARY confirmed path, on this cycle and every cycle after it.
    wallet_file.execute(
        "INSERT INTO blocks (height, hash, time, sapling_tree)"
        " VALUES (3450100, X'00', 0, X'00'), (3450101, X'00', 0, X'00');")
    for _ in range(4):
        call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("900.000"), "the note was credited twice"
    assert ZecCreditReceipt.objects.count() == 1
    assert Event.objects.filter(type="BOUGHT_TUZI").count() == 1


@pytest.mark.django_db
def test_a_note_over_the_cap_is_held_and_announced_not_credited(
        adapter, wallet_file, creator_factory, mocker, instant_on):
    """0.06 ZEC is over the 0.05 ZEC cap, so it waits like everything else."""
    buyer = creator_factory(username="biggie", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="37" * 32, pool="orchard", index=0, zats=6_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "biggie"}))
    _young(wallet_file, "37" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0")
    assert ZecCreditReceipt.objects.count() == 0
    assert ZecPendingNotice.objects.count() == 1


@pytest.mark.django_db
def test_the_daily_cap_stops_the_repeat_across_cycles(
        adapter, wallet_file, creator_factory, mocker, monkeypatch):
    """Ten 0.01 ZEC notes against a 0.05 ZEC daily budget: five get through.

    This is the per-note cap's blind spot made concrete. Without the daily
    cap the answer is ten, and tomorrow it is nine hundred and sixty.
    """
    monkeypatch.setenv("ZEC_INSTANT_CREDIT_MAX_ZATOSHI", "5000000")
    monkeypatch.setenv("ZEC_INSTANT_CREDIT_DAILY_MAX_ZATOSHI", "5000000")
    creator_factory(username="grinder", tuzis=Decimal("0"))
    for n in range(10):
        wallet_file.add_note(
            txid_display=f"{40 + n:02x}" * 32, pool="orchard", index=0,
            zats=1_000_000,
            memo=_memo_bytes({"act": "buy_2z", "id": "grinder"}))
    wallet_file.execute("UPDATE transactions SET mined_height = 3450099")

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    assert ZecCreditReceipt.objects.filter(instant=True).count() == 5
    # The other five were not swallowed -- they were announced and will be
    # credited normally when they mature.
    assert ZecPendingNotice.objects.count() == 5


@pytest.mark.django_db
def test_a_vanished_instant_credit_pages_halts_and_reverses_nothing(
        adapter, wallet_file, creator_factory, mocker, instant_on, capsys):
    """The incident, end to end.

    A note is credited early; the transaction then disappears from the wallet
    entirely -- a double-spend that won, or a wallet that lost it. The cycle
    must notice, say so on the paging phrase, withhold the heartbeat, refuse
    any further instant credit, and leave the balance alone.
    """
    attacker = creator_factory(username="racer", tuzis=Decimal("0"))
    creator_factory(username="bystander", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="51" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "racer"}))
    _young(wallet_file, "51" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)
    attacker.refresh_from_db(fields=["tuzis"])
    assert attacker.tuzis == Decimal("900.000")
    capsys.readouterr()

    # The conflicting transaction won: our note is gone from the wallet. A
    # second, unrelated note keeps the wallet non-empty, so this is a real
    # vanish and not the "wallet reported nothing" case.
    wallet_file.execute("DELETE FROM orchard_received_notes WHERE id = 1;")
    wallet_file.add_note(
        txid_display="52" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "bystander"}))
    _young(wallet_file, "52" * 32)
    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    assert "credit_creators: CREDIT UNBACKED - " in out
    assert "NOTHING HAS BEEN REVERSED" in out
    assert "credit_creators: cycle ok" not in out, (
        "a cycle holding an unbacked credit must not look healthy")

    receipt = ZecCreditReceipt.objects.get(txid="51" * 32)
    assert receipt.vanished_at is not None
    # The balance is untouched. Debiting it automatically off a local SQLite
    # read is the thing this design refuses to do.
    attacker.refresh_from_db(fields=["tuzis"])
    assert attacker.tuzis == Decimal("900.000")

    # And the brake is on: the bystander's note was NOT credited instantly.
    assert not ZecCreditReceipt.objects.filter(
        txid="52" * 32, instant=True).exists()


@pytest.mark.django_db
def test_an_instant_credit_that_matures_comes_off_the_watch_list(
        adapter, wallet_file, creator_factory, mocker, instant_on, capsys):
    """A watch list that never releases anything eventually pages on history."""
    creator_factory(username="settles", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="53" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "settles"}))
    _young(wallet_file, "53" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)
    wallet_file.execute(
        "INSERT INTO blocks (height, hash, time, sapling_tree)"
        " VALUES (3450100, X'00', 0, X'00'), (3450101, X'00', 0, X'00');")
    capsys.readouterr()
    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    assert "off the watch list" in out
    assert "CREDIT UNBACKED" not in out
    assert ZecCreditReceipt.objects.get().settled_at is not None


@pytest.mark.django_db
def test_a_wallet_that_reports_nothing_accuses_nobody(
        adapter, wallet_file, creator_factory, mocker, instant_on, capsys):
    """A resync or a restore is not a wave of double-spends.

    This is the branch that would otherwise mark every outstanding instant
    credit vanished during an ordinary ops event, halt crediting, and point a
    responder at innocent balances.
    """
    creator_factory(username="restored", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="54" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "restored"}))
    _young(wallet_file, "54" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)
    capsys.readouterr()

    wallet_file.execute("DELETE FROM orchard_received_notes;")
    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    assert "cannot be verified" in out
    assert "credit_creators: CREDIT UNBACKED - " in out
    assert ZecCreditReceipt.objects.get().vanished_at is None


@pytest.mark.django_db
def test_with_instant_credit_off_no_2z_move_for_a_held_note(
        adapter, wallet_file, creator_factory, mocker, capsys):
    """The default. Crediting behaviour is exactly what it was before.

    The announcement is deliberately NOT gated on the caps -- it moves no
    money and the silence is the defect -- so this asserts the money half:
    with the caps unset, nothing below the floor is credited and no instant
    receipt exists, whatever the amount.
    """
    buyer = creator_factory(username="default", tuzis=Decimal("0"))
    for n, zats in enumerate((1, 1_000, 1_000_000, 5_000_000_000)):
        wallet_file.add_note(
            txid_display=f"{0x60 + n:02x}" * 32, pool="orchard", index=0,
            zats=zats, memo=_memo_bytes({"act": "buy_2z", "id": "default"}))
    wallet_file.execute("UPDATE transactions SET mined_height = 3450099")

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0")
    assert ZecCreditReceipt.objects.count() == 0
    out = capsys.readouterr().out
    assert "credited INSTANTLY" not in out
    assert "credit_creators: cycle ok" in out


@pytest.mark.django_db
def test_a_stale_adapter_with_no_pending_notes_still_credits(
        adapter, wallet_file, creator_factory, mocker, instant_on):
    """`the deployment checkout` on the payment host is a hand-unpacked tarball and drifts.

    The command must not require the adapter to know about `pending_notes`:
    a host running the older file has to keep crediting confirmed payments,
    not crash on every cycle.
    """
    buyer = creator_factory(username="stale", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="61" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "stale"}))

    class LegacyClient(adapter.Client):
        def recieved_by(self, addr):
            notes = super().recieved_by(addr)
            del self.pending_notes
            return notes

    mocker.patch(f"{_COMMAND}.Client", LegacyClient)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("900.000")


@pytest.mark.django_db
def test_a_held_note_for_an_unknown_username_is_not_announced_or_paged(
        adapter, wallet_file, mocker, capsys, instant_on):
    """Page once, when it matures -- not every 90 seconds while it is young.

    The confirmed pass already pages for an unresolvable recipient. Paging
    again for the same payment before it is even due trains the responder to
    ignore the line, which is how a real one gets missed.
    """
    wallet_file.add_note(
        txid_display="62" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "nobody-by-that-name"}))
    _young(wallet_file, "62" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    assert "CREDITING BLOCKED" not in out
    assert ZecPendingNotice.objects.count() == 0
    assert ZecCreditReceipt.objects.count() == 0


# --------------------------------------------------------------------------
# Three failure modes the codex adversarial review found in the first cut of
# this feature. Each one keeps every dashboard green while something real is
# wrong, which is the class of defect this repository keeps being bitten by.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_an_unresolved_unbacked_credit_keeps_paging_every_cycle(
        adapter, wallet_file, creator_factory, mocker, instant_on, capsys):
    """The incident must not announce itself once and then go quiet.

    `watch_instant_credits` returns a receipt exactly once -- the next cycle
    excludes it because `vanished_at` is set. Without the standing re-report,
    cycle 2 emits a healthy heartbeat, the log metric stops incrementing, the
    policy auto-closes an hour later, and every dashboard is green while
    somebody holds unbacked 2Z and no human has looked at it.
    """
    creator_factory(username="ghost", tuzis=Decimal("0"))
    creator_factory(username="later", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="81" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "ghost"}))
    _young(wallet_file, "81" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)

    wallet_file.execute("DELETE FROM orchard_received_notes WHERE id = 1;")
    wallet_file.add_note(
        txid_display="82" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "later"}))
    _young(wallet_file, "82" * 32)
    call_command("credit_creators", no_color=True)   # detection cycle
    capsys.readouterr()

    # Cycle 3, 4, 5... nothing has changed and nothing has been resolved.
    for _ in range(3):
        call_command("credit_creators", no_color=True)
        out = capsys.readouterr().out
        assert "credit_creators: CREDIT UNBACKED - " in out
        assert "STILL UNRESOLVED" in out
        assert "credit_creators: cycle ok" not in out

    # And it stops the moment a human decides, not before.
    call_command("resolve_unbacked_zec_credit", "81" * 32)
    capsys.readouterr()
    call_command("credit_creators", no_color=True)
    out = capsys.readouterr().out
    assert "CREDIT UNBACKED" not in out
    assert "credit_creators: cycle ok" in out


@pytest.mark.django_db
def test_an_adapter_that_cannot_see_young_notes_accuses_nobody(
        adapter, wallet_file, creator_factory, mocker, instant_on, capsys):
    """A partial VM rollback is not a wave of double-spends.

    `the deployment checkout` on the payment host is a hand-unpacked tarball. Roll the adapter
    back and `pending_keys` is empty because we CANNOT SEE young notes, not
    because there are none -- so every young instant credit would be marked
    vanished, page, halt crediting platform-wide and send a responder after
    innocent buyers.
    """
    creator_factory(username="rolledback", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="83" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "rolledback"}))
    _young(wallet_file, "83" * 32)

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    call_command("credit_creators", no_color=True)
    assert ZecCreditReceipt.objects.get().instant is True

    # A second, confirmed note keeps the wallet non-empty, so this is the
    # "old adapter" branch and not the "wallet reported nothing" one.
    wallet_file.add_note(
        txid_display="84" * 32, pool="orchard", index=0, zats=9,
        memo=b"not a purchase")
    wallet_file.execute(
        "UPDATE transactions SET mined_height = 3450090"
        " WHERE txid = X'" + ("84" * 32) + "';")

    class LegacyClient(adapter.Client):
        def recieved_by(self, addr):
            notes = super().recieved_by(addr)
            del self.pending_notes
            return notes

    mocker.patch(f"{_COMMAND}.Client", LegacyClient)
    capsys.readouterr()
    call_command("credit_creators", no_color=True)

    out = capsys.readouterr().out
    assert "cannot be verified" in out
    assert ZecCreditReceipt.objects.get().vanished_at is None, (
        "an ordinary adapter rollback accused a buyer of double-spending")


@pytest.mark.django_db
def test_a_broken_notifier_does_not_take_out_the_credit_cycle(
        adapter, wallet_file, creator_factory, mocker, capsys):
    """A notification is not the money and must never be able to stop it.

    The concrete route: a partial hand-copy that brings the credit command
    but leaves an `events/models.py` with no `ZEC_PENDING` template. The
    post_save Pub/Sub signal calls `to_dict()` synchronously, `message()` is
    an unguarded dict lookup, and the resulting KeyError would abort the
    cycle -- every cycle, forever, over a cosmetic drift.
    """
    buyer = creator_factory(username="notifyfail", tuzis=Decimal("0"))
    payer = creator_factory(username="confirmedok", tuzis=Decimal("0"))
    wallet_file.add_note(
        txid_display="85" * 32, pool="orchard", index=0, zats=1_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "notifyfail"}))
    _young(wallet_file, "85" * 32)
    wallet_file.add_note(
        txid_display="86" * 32, pool="orchard", index=0, zats=2_000_000,
        memo=_memo_bytes({"act": "buy_2z", "id": "confirmedok"}))
    wallet_file.execute(
        "UPDATE transactions SET mined_height = 3450090"
        " WHERE txid = X'" + ("86" * 32) + "';")

    mocker.patch(f"{_COMMAND}.Client", adapter.Client)
    mocker.patch(f"{_COMMAND}.current_tuzis_per_zec", return_value=RATE)
    mocker.patch(f"{_COMMAND}.notify_pending_note",
                 side_effect=KeyError("ZEC_PENDING"))
    call_command("credit_creators", no_color=True)

    # The money moved.
    payer.refresh_from_db(fields=["tuzis"])
    assert payer.tuzis == Decimal("1800.000")
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0")
    # And it was neither silent nor fatal.
    out = capsys.readouterr().out
    assert "could not tell notifyfail" in out
    assert "credit_creators: cycle ok" not in out, (
        "a persistently broken notifier must trip the absence policy")
