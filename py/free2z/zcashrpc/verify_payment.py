"""Read-only ZEC payment diagnostics: wallet, adapter, memo, recipient, credit.

Run ``python -m zcashrpc.verify_payment --help`` with this package on PYTHONPATH.
A PASS establishes only the recorded stage; it never authorizes a credit/replay.
"""

import argparse
import codecs
import json
import os
import sqlite3
import sys
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, localcontext

from .sweep_policy import readonly_wallet, txid_bytes, u64, ZATS_PER_ZEC

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"


class Result:
    def __init__(self):
        self.stages = []

    def record(self, stage, status, detail):
        if status not in (PASS, FAIL, SKIP):
            raise ValueError("unknown stage status")
        self.stages.append((stage, status, detail))
        print(f"[{status}] {stage}: {detail}")
        return status

    def exit_code(self):
        if any(status == FAIL for _, status, _ in self.stages):
            return 1
        if any(status == SKIP for _, status, _ in self.stages):
            return 2
        return 0


def wallet_notes(db_path):
    """Read decrypted notes independently of the credit adapter's pool support."""
    conn = readonly_wallet(db_path)
    try:
        tables = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
            " AND (name LIKE '%_received_notes' OR name LIKE '%_received_outputs')")]
        notes = []
        for table in sorted(tables):
            # Table names originate in the file, not in a trusted SQL constant.
            quoted = '"' + table.replace('"', '""') + '"'
            columns = {row[1] for row in conn.execute(f"PRAGMA table_info({quoted})")}
            index = next((c for c in ("output_index", "action_index") if c in columns), None)
            value = next((c for c in ("value", "value_zat") if c in columns), None)
            if index is None or value is None:
                continue
            memo = "n.memo" if "memo" in columns else "NULL"
            rows = conn.execute(
                f"SELECT t.txid, n.{value}, {memo}, n.{index}, t.mined_height"
                f" FROM {quoted} n JOIN transactions t ON n.transaction_id = t.id_tx")
            for txid, amount, memo_bytes, output_index, height in rows:
                amount = u64(amount)
                notes.append({
                    "txid": bytes(txid)[::-1].hex(), "amountZat": amount,
                    "amount": Decimal(amount) / ZATS_PER_ZEC,
                    "memo": bytes(memo_bytes).hex() if memo_bytes else "",
                    "output_index": u64(output_index),
                    "pool": table.rsplit("_received_", 1)[0], "mined_height": height,
                })
        return notes
    finally:
        conn.close()


def wallet_facts(db_path):
    """Report observed blocks, transactions and external receiving addresses."""
    conn = readonly_wallet(db_path)
    try:
        tip, low, blocks = conn.execute(
            "SELECT max(height), min(height), count(*) FROM blocks").fetchone()
        txs = conn.execute("SELECT count(*) FROM transactions").fetchone()[0]
        addresses = conn.execute(
            "SELECT account_id, address FROM addresses WHERE key_scope = 0").fetchall()
        return {"tip": tip, "low": low, "blocks": blocks, "transactions": txs,
                "external_addresses": addresses}
    finally:
        conn.close()


def note_height(db_path, txid_display):
    conn = readonly_wallet(db_path)
    try:
        row = conn.execute("SELECT mined_height FROM transactions WHERE txid = ?",
                           (txid_bytes(txid_display)[::-1],)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def parse_memo(memo_hex):
    """Decode the JSON-object envelope accepted by the credit command."""
    if not memo_hex:
        return None, "no memo on this note"
    try:
        text = codecs.decode(memo_hex, "hex").decode().replace("\x00", "")
    except (ValueError, TypeError, UnicodeError):
        return None, "memo is not decodable text"
    start, end = text.find("{"), text.rfind("}") + 1
    if start < 0 or end <= start:
        return None, "memo carries no JSON object"
    try:
        payload = json.loads(text[start:end])
    except ValueError:
        return None, "memo JSON did not parse"
    if not isinstance(payload, dict):
        return None, "memo JSON is not an object"
    return payload, None


def amount_zats(amount):
    """Convert an exact nonnegative ZEC selector without rounding fractions."""
    try:
        value = Decimal(str(amount))
        if not value.is_finite() or not 0 <= value <= Decimal("184467440737.09551615"):
            raise ValueError("amount is outside unsigned 64-bit zatoshi range")
        numerator, denominator = value.as_integer_ratio()
        zats, fraction = divmod(numerator * ZATS_PER_ZEC, denominator)
        if fraction:
            raise ValueError("amount must be a whole number of zatoshis")
        return u64(zats)
    except (InvalidOperation, OverflowError) as exc:
        raise ValueError("invalid ZEC amount") from exc


def select_notes(notes, txid=None, amount=None, username=None):
    """A username filters only when neither transaction nor amount is supplied."""
    picked = list(notes)
    if txid:
        picked = [n for n in picked if n["txid"].lower() == txid.lower()]
    if amount is not None:
        want = amount_zats(amount)
        picked = [n for n in picked if n["amountZat"] == want]
    if username and not txid and amount is None:
        picked = [n for n in picked
                  if (parse_memo(n.get("memo", ""))[0] or {}).get("id") == username]
    return picked


class Database:
    """Read-only diagnostic queries on a caller-owned DB-API connection.

    The caller must configure a read-only PostgreSQL session. This object does
    not open, reconfigure, close or commit the supplied connection.
    """
    def __init__(self, conn):
        self.conn = conn

    def has_table(self, name):
        return self.one("SELECT to_regclass(%s)", (f"public.{name}",))[0] is not None

    def one(self, sql, params=()):
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def all(self, sql, params=()):
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def credit_quantity_matches(credited, rate, amount_zats):
    """Verify the receipt's conversion at the credit column's 0.001 precision.

    This checks arithmetic, not ledger balance conservation. Half-even rounding
    matches the credit command's Decimal quantization; no float conversion occurs.
    """
    try:
        with localcontext() as context:
            context.prec = 80
            quantity, rate = Decimal(credited), Decimal(rate)
            if not quantity.is_finite() or not rate.is_finite() or quantity < 0 or rate <= 0:
                return False
            expected = (Decimal(u64(amount_zats)) / ZATS_PER_ZEC * rate).quantize(
                Decimal("0.001"), rounding=ROUND_HALF_EVEN)
            return quantity == expected
    except (InvalidOperation, ValueError, TypeError, OverflowError):
        return False


def check_credits(result, db, buys, *, pending_keys=()):
    """Check receipt identity, amount and provenance; never infer a safe replay."""
    creators = {}
    for username in sorted({payload["id"] for _, payload in buys}):
        row = db.one("SELECT id, username, tuzis FROM g12f_creator WHERE username = %s",
                     (username,))
        if row is None:
            result.record("4 RECIPIENT", FAIL, f"{username!r} has no Creator record")
        else:
            creators[username] = row
            result.record("4 RECIPIENT", PASS, f"{username!r} exists; balance {row[2]} 2Z")
    if not creators:
        return result.exit_code()
    has_receipts = db.has_table("tuzis_zeccreditreceipt")
    for note, payload in buys:
        txid, pool, index = note["txid"], note.get("pool", ""), note.get("output_index", 0)
        label = f"{txid}:{pool}:{index}"
        receipt = db.one(
            "SELECT r.tuzis_credited, r.tuzis_per_zec, r.backfilled, r.created_at,"
            " c.username, r.amount_zec FROM tuzis_zeccreditreceipt r"
            " LEFT JOIN g12f_creator c ON c.id = r.creator_id"
            " WHERE r.txid = %s AND r.output_index = %s AND r.pool = %s",
            (txid, index, pool)) if has_receipts else None
        if receipt is not None:
            credited, rate, backfilled, when, paid_to, paid_for = receipt
            if backfilled:
                result.record("5 CREDIT", FAIL, f"{label}: backfilled marker does not prove credit")
            elif paid_to != payload["id"]:
                result.record("5 CREDIT", FAIL, f"{label}: receipt credited a different recipient")
            elif paid_for is None:
                result.record("5 CREDIT", SKIP, f"{label}: receipt has no amount to verify")
            elif Decimal(paid_for) != Decimal(note["amountZat"]) / ZATS_PER_ZEC:
                result.record("5 CREDIT", FAIL, f"{label}: receipt amount differs from this note")
            elif credited is None or rate is None:
                result.record("5 CREDIT", SKIP, f"{label}: recorded credit quantity or rate is absent")
            elif not credit_quantity_matches(credited, rate, note["amountZat"]):
                result.record("5 CREDIT", FAIL, f"{label}: credit quantity does not match amount and rate")
            else:
                result.record("5 CREDIT", PASS,
                              f"{label}: {credited} 2Z to {paid_to!r} at {rate} 2Z/ZEC on {when}")
            continue
        legacy = db.one("SELECT amount, action, creator_id, created_at"
                        " FROM g12f_transaction WHERE txid = %s", (txid,))
        if legacy is None:
            if (txid, pool, index) in pending_keys:
                result.record("5 CREDIT", SKIP, f"{label}: credit awaits confirmation depth")
            else:
                result.record("5 CREDIT", FAIL, f"{label}: no receipt or processing marker")
            continue
        events = db.all("SELECT e.amount, e.created_at FROM events_event e"
                        " JOIN g12f_creator c ON c.id = e.receiving_user_id"
                        " WHERE c.username = %s AND e.type = 'BOUGHT_TUZI'"
                        " ORDER BY e.created_at DESC LIMIT 5", (payload["id"],))
        if not events:
            result.record("5 CREDIT", FAIL,
                          f"{label}: processed marker exists but recipient has no purchase event")
        else:
            result.record("5 CREDIT", SKIP,
                          f"{label}: legacy events cannot be linked to this transaction;"
                          " inspect independent balance evidence before any manual credit")
    return result.exit_code()


def diagnose(db_path, client, *, txid=None, amount=None, username=None, database=None):
    """Run stages with an explicit wallet adapter and optional query boundary."""
    result = Result()
    if getattr(client, "dummy", False):
        result.record("2 ADAPTER", FAIL, "dummy adapter cannot establish wallet evidence")
        return result
    try:
        facts, notes = wallet_facts(db_path), wallet_notes(db_path)
        picked = select_notes(notes, txid, amount, username)
    except (OSError, ValueError, sqlite3.Error):
        result.record("1 WALLET", SKIP, "wallet or selector could not be read")
        return result
    print(f"wallet: {facts['blocks']} scanned blocks; range {facts['low']}..{facts['tip']}")
    print("external addresses watched: " + ", ".join(
        sorted(address for _, address in facts["external_addresses"])))
    if facts["blocks"] and facts["tip"] - facts["low"] + 1 != facts["blocks"]:
        print("wallet scan range has gaps; a missing note may be in an unscanned block")
    if not picked:
        names = sorted({str(payload.get("id")) for payload, _ in
                        (parse_memo(n.get("memo", "")) for n in notes)
                        if payload and payload.get("act") == "buy_2z"})
        detail = "no matching decrypted note"
        if names:
            detail += "; other detected purchase memos name " + ", ".join(map(repr, names))
        result.record("1 WALLET", FAIL, detail)
        return result
    result.record("1 WALLET", PASS, f"{len(picked)} matching decrypted note(s)")
    for note in picked:
        height = note["mined_height"]
        if height is None:
            depth = "not mined"
        elif facts["tip"] is None:
            depth = "confirmation depth unknown"
        else:
            depth = f"{facts['tip'] - height + 1} confirmation(s)"
        print(f"{note['txid']} {note['pool']}:{note['output_index']} "
              f"{note['amount']} ZEC; {depth}")
    try:
        reported = client.recieved_by("")
    except Exception:
        result.record("2 ADAPTER", SKIP, "adapter query failed")
        return result
    missing_identity = any("pool" not in n or "output_index" not in n for n in reported)
    if missing_identity:
        result.record("2 ADAPTER", FAIL, "adapter omitted pool or per-note index")
    seen = {(n["txid"], n.get("pool"), n.get("output_index")) for n in reported}
    pending = {(tx, pool) for tx, pool, _depth in getattr(client, "pending", [])}
    unseen = [n for n in picked if (n["txid"], n["pool"], n["output_index"]) not in seen]
    held = [n for n in unseen if (n["txid"], n["pool"]) in pending]
    held_keys = {(n["txid"], n["pool"], n["output_index"]) for n in held}
    if held:
        result.record("2 ADAPTER", SKIP, "matching notes await confirmation depth")
    absent = [n for n in unseen if n not in held]
    if absent:
        result.record("2 ADAPTER", FAIL, "decrypted notes are absent from adapter output")
        picked = [n for n in picked if n not in absent]
    elif not unseen and not missing_identity:
        result.record("2 ADAPTER", PASS, "every selected note has a pool and per-note index")
    buys = []
    for note in picked:
        payload, error = parse_memo(note.get("memo", ""))
        if error or payload.get("act") != "buy_2z":
            continue
        if not isinstance(payload.get("id"), str) or not payload["id"].strip():
            result.record("3 MEMO", FAIL, "purchase memo has no nonempty recipient name")
            continue
        buys.append((note, payload))
    if not buys:
        result.record("3 MEMO", FAIL, "no selected note has a purchase memo with a recipient")
        return result
    names = sorted({payload["id"] for _, payload in buys})
    result.record("3 MEMO", PASS, "purchase memos name " + ", ".join(map(repr, names)))
    if username and username not in names:
        result.record("3 MEMO", FAIL, "memo recipient differs from requested username")
        return result
    if database is None:
        result.record("4 RECIPIENT", SKIP, "no credit database supplied")
        result.record("5 CREDIT", SKIP, "no credit database supplied")
    else:
        try:
            check_credits(result, database, buys, pending_keys=held_keys)
        except Exception:
            result.record("5 CREDIT", SKIP, "credit database query could not be evaluated")
    return result


def canonical_client(db_path, account, min_confirmations):
    """Construct the package's wallet adapter with explicit invocation settings.

    The adapter reads its configuration from the environment during construction.
    Restoration is guaranteed; this CLI helper is not safe for concurrent threads
    that construct adapters. Applications should supply their own adapter instance.
    """
    from .wallet_sqlite_client import Client
    class ReadonlyClient(Client):
        def _conn(self):
            return readonly_wallet(self.db_path)

    u64(account)
    if type(min_confirmations) is not int or not 0 <= min_confirmations <= Client.MAX_MIN_CONFIRMATIONS:
        raise ValueError("invalid confirmation depth")
    settings = {"WALLET_DB": os.fspath(db_path), "WALLET_ACCOUNT": str(account),
                "ZEC_MIN_CONFIRMATIONS": str(min_confirmations)}
    old = {key: os.environ.get(key) for key in settings}
    try:
        os.environ.update(settings)
        return ReadonlyClient()
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--txid")
    parser.add_argument("--amount", help="exact amount in ZEC")
    parser.add_argument("--username")
    parser.add_argument("--wallet-db", required=True)
    parser.add_argument("--wallet-account", type=int, required=True)
    parser.add_argument("--min-confirmations", type=int, required=True)
    connection = parser.add_mutually_exclusive_group(required=True)
    connection.add_argument("--no-db", action="store_true")
    connection.add_argument("--database-service", help="explicit libpq service name; session is read-only")
    args = parser.parse_args(argv)
    if not (args.txid or args.amount is not None or args.username):
        parser.error("supply --txid, --amount or --username")
    try:
        if args.txid:
            txid_bytes(args.txid)
        if args.amount is not None:
            amount_zats(args.amount)
        client = canonical_client(args.wallet_db, args.wallet_account, args.min_confirmations)
    except (ValueError, OSError):
        parser.error("invalid wallet, account, confirmation depth, transaction ID or amount")
    conn = None
    try:
        if args.database_service:
            import psycopg2
            conn = psycopg2.connect(service=args.database_service, connect_timeout=10)
            conn.set_session(readonly=True, autocommit=True)
        return diagnose(args.wallet_db, client, txid=args.txid, amount=args.amount,
                        username=args.username, database=Database(conn) if conn else None).exit_code()
    except Exception:
        # Database exceptions may embed credentials; do not render them.
        result = Result()
        result.record("4 RECIPIENT", SKIP, "diagnostic database connection unavailable")
        return result.exit_code()
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
