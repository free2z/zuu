"""
Zallet-backed adapter with the same public interface as `zcashrpc.client.Client`.

Zallet (https://github.com/zcash/wallet) replaces zcashd's wallet component.
This adapter routes the g12f management commands to Zallet without needing
those commands to change.

Read path (recieved_by, get_total_balance, get_balance): SQLite direct reads
from wallet.db. This is because Zallet 0.1.0-beta.1 has a bug where all
account-based JSON-RPC methods (`z_listaccounts`, `z_getbalanceforaccount`,
`z_gettotalbalance`, `z_sendmany`) hang without ever returning a response
(observed 2026-07-16 against zallet-zaino binary from official releases).
Direct-DB reads sidestep the bug and are actually simpler for our purposes.

Write path (mergeto -> z_sendmany): still goes over JSON-RPC because only
Zallet can decrypt the age-encrypted spending keys. If z_sendmany is still
hanging in your Zallet build, sweep_balance will error and the caller will
retry later. That is acceptable — funds remain safe in the wallet.

Environment variables:
- ZCASH_USER, ZCASH_PASSWORD: HTTP Basic auth for Zallet's JSON-RPC.
- ZALLET_HOST (default 127.0.0.1), ZALLET_PORT (default 28232).
- ZALLET_DB_PATH (default /var/lib/zcash/zallet/wallet.db): direct SQLite reads.
- ZALLET_ACCOUNT_NAME (default 'Legacy'): the migrated zcashd account name.

The `addr` argument to `recieved_by`/`get_balance` is retained for interface
compatibility but ignored — Zallet works at account level and our wallet has
only one account.
"""
import codecs
import decimal
import json
import os
import sqlite3
from typing import List, Optional

import requests


DEFAULT_DB_PATH = "/var/lib/zcash/zallet/wallet.db"
DEFAULT_ACCOUNT_NAME = "Legacy"
# Empty ZIP-302 memo is 512 bytes = 1024 hex chars starting with 0xf6.
_EMPTY_MEMO_HEX = "f6" + "0" * 1022


def _pad_hex_512(hex_str: str) -> str:
    if len(hex_str) >= 1024:
        return hex_str[:1024]
    return hex_str + "0" * (1024 - len(hex_str))


def _memo_bytes_to_zcashd_hex(memo_bytes: Optional[bytes]) -> str:
    """Wallet-db stores memos as raw 512-byte BLOBs. The old zcashd RPC returned
    them as hex-encoded strings — hex-encode ours to match, so existing callers
    that do codecs.decode(memo,'hex').decode() continue to work."""
    if not memo_bytes:
        return _EMPTY_MEMO_HEX
    return _pad_hex_512(codecs.encode(memo_bytes, "hex").decode())


class ZalletClient(object):
    """Interface-compatible replacement for the zcashd-backed Client.

    Reads go through wallet.db directly; the write path (mergeto) attempts
    z_sendmany over RPC and will surface the current Zallet bug if hit."""

    def __init__(self) -> None:
        self.dummy = True
        self._session = None
        self._url = None
        self._auth = None
        self._req_id = 0
        self._db_path = os.environ.get("ZALLET_DB_PATH", DEFAULT_DB_PATH)
        self._account_name = os.environ.get(
            "ZALLET_ACCOUNT_NAME", DEFAULT_ACCOUNT_NAME)
        # Cached values loaded on first live use
        self._account_id: Optional[int] = None
        self._account_uuid: Optional[str] = None
        if os.environ.get("ZCASH_USER"):
            self._open()

    def _open(self):
        print("Using live Zallet (wallet.db + RPC)!")
        host = os.environ.get("ZALLET_HOST", "127.0.0.1")
        port = os.environ.get("ZALLET_PORT", "28232")
        user = os.environ["ZCASH_USER"]
        password = os.environ["ZCASH_PASSWORD"]
        self._url = f"http://{host}:{port}/"
        self._auth = (user, password)
        self._session = requests.Session()
        self.dummy = False

    # ---- SQLite helpers ------------------------------------------------------

    def _db(self) -> sqlite3.Connection:
        # Open read-only, uri mode. Timeout in case Zallet is briefly holding a
        # write lock (delete-journal mode blocks readers during writes).
        con = sqlite3.connect(
            f"file:{self._db_path}?mode=ro", uri=True, timeout=15.0)
        con.row_factory = sqlite3.Row
        return con

    def _load_account(self, con: sqlite3.Connection) -> None:
        if self._account_id is not None:
            return
        row = con.execute(
            "SELECT id, uuid FROM accounts WHERE name = ?",
            (self._account_name,),
        ).fetchone()
        if row is None:
            raise RuntimeError(
                f"No Zallet account named '{self._account_name}' — "
                "set ZALLET_ACCOUNT_NAME to match.")
        self._account_id = row["id"]
        # uuid stored as 16 raw bytes; format as canonical string.
        raw = bytes(row["uuid"])
        self._account_uuid = (
            f"{raw[0:4].hex()}-{raw[4:6].hex()}-{raw[6:8].hex()}-"
            f"{raw[8:10].hex()}-{raw[10:16].hex()}")

    def _rpc(self, method: str, params=None, timeout: float = 90.0):
        self._req_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._req_id,
            "method": method,
            "params": params or [],
        }
        r = self._session.post(
            self._url, data=json.dumps(payload), auth=self._auth,
            headers={"Content-Type": "application/json"}, timeout=timeout,
        )
        r.raise_for_status()
        body = r.json()
        if body.get("error"):
            raise RuntimeError(f"Zallet RPC {method} error: {body['error']}")
        return body["result"]

    # ---- interface methods ---------------------------------------------------

    def new_addr(self) -> str:
        if self.dummy:
            return "u" + "x" * 100
        # z_getaddressforaccount is one of the currently-hanging RPCs; caller
        # currently doesn't use new_addr in production. Attempt anyway.
        with self._db() as con:
            self._load_account(con)
        result = self._rpc(
            "z_getaddressforaccount", [self._account_uuid])
        return result["address"]

    def is_valid(self, addr: str) -> bool:
        if self.dummy:
            return True
        # Cheap RPC — validateaddress works; only account methods hang.
        try:
            r = self._rpc("validateaddress", [addr])
            return bool(r.get("isvalid", False))
        except Exception:
            return False

    def get_balance(self, addr: str) -> float:
        """`addr` is ignored — Zallet's balance is per-account. Returns the
        account's unspent shielded (sapling + orchard) balance in ZEC."""
        if self.dummy:
            return 0.0
        return float(self.get_total_balance())

    def list_deprecated(self) -> List[str]:
        return []

    def list_sapling(self) -> List[str]:
        """Sentinel result — sweep_balance.py iterates this then calls
        get_balance() and mergeto(); the sentinel lets that logic stay
        unchanged while we work at the account level under the hood."""
        return ["__account__"]

    def import_viewing_key(self, vkey: str, rescan: str = "no",
                           block_height: int = 1730000):
        raise NotImplementedError("viewing-key import not wired up for Zallet")

    def recieved_by(self, addr: str) -> List[dict]:
        """Return all wallet-received tx outputs in the shape callers expect.
        `addr` is ignored — we return every non-change shielded receipt on
        the migrated account. Downstream code keys on txid so extra rows
        don't cause duplicate credits."""
        if self.dummy:
            return []

        results = []
        with self._db() as con:
            self._load_account(con)
            aid = self._account_id
            # sapling receipts (only ones NOT spent within this same tx)
            for pool, notes_table, spends_table, idx_col in [
                ("sapling", "sapling_received_notes",
                 "sapling_received_note_spends", "output_index"),
                ("orchard", "orchard_received_notes",
                 "orchard_received_note_spends", "action_index"),
            ]:
                sql = (
                    f"SELECT n.id AS note_id, hex(t.txid) AS txid, "
                    f"       t.mined_height, t.tx_index, b.time AS blocktime, "
                    f"       n.value, n.memo, n.is_change, n.{idx_col} AS outindex "
                    f"FROM {notes_table} n "
                    f"JOIN transactions t ON n.transaction_id = t.id_tx "
                    f"LEFT JOIN blocks b ON t.mined_height = b.height "
                    f"WHERE n.account_id = ? AND n.is_change = 0"
                )
                for row in con.execute(sql, (aid,)):
                    memo_hex = _memo_bytes_to_zcashd_hex(
                        bytes(row["memo"]) if row["memo"] else None)
                    value_zat = int(row["value"])
                    blockheight = row["mined_height"] or 0
                    # confirmations = current tip height - blockheight + 1,
                    # but we don't have tip here — approximate with 1 (mined).
                    # Callers only check for KeyError on memo, not confirmations.
                    results.append({
                        "txid": row["txid"].lower(),
                        "amount": (decimal.Decimal(value_zat)
                                   / decimal.Decimal(10**8)),
                        "amountZat": value_zat,
                        "memo": memo_hex,
                        "outindex": row["outindex"],
                        "confirmations": 1 if blockheight else 0,
                        "blockheight": blockheight,
                        "blockindex": row["tx_index"] or 0,
                        "blocktime": row["blocktime"] or 0,
                        "change": False,
                    })
        return results

    def read_messages(self, addr: str) -> None:
        for tx in self.recieved_by(addr):
            try:
                print(codecs.decode(tx["memo"], "hex").decode())
            except UnicodeDecodeError:
                pass

    def get_total_balance(self) -> decimal.Decimal:
        """Unspent shielded balance for our account, in ZEC as Decimal."""
        if self.dummy:
            return decimal.Decimal(0)

        total_zat = 0
        with self._db() as con:
            self._load_account(con)
            for notes_table, spends_table in [
                ("sapling_received_notes", "sapling_received_note_spends"),
                ("orchard_received_notes", "orchard_received_note_spends"),
            ]:
                sql = (
                    f"SELECT COALESCE(SUM(n.value), 0) FROM {notes_table} n "
                    f"WHERE n.account_id = ? AND n.is_change = 0 "
                    f"AND NOT EXISTS ("
                    f"  SELECT 1 FROM {spends_table} s "
                    f"  WHERE s.{notes_table.rstrip('s')[:-5]}"  # awkward: derive
                    f"note_id = n.id"
                    f")"
                )
                # Simpler / clearer form below (see note); do the query with
                # explicit column names instead of the string-splicing above.
                if notes_table == "sapling_received_notes":
                    sql = (
                        "SELECT COALESCE(SUM(n.value), 0) "
                        "FROM sapling_received_notes n "
                        "WHERE n.account_id = ? AND n.is_change = 0 "
                        "AND NOT EXISTS ("
                        "  SELECT 1 FROM sapling_received_note_spends s "
                        "  WHERE s.sapling_received_note_id = n.id"
                        ")"
                    )
                else:
                    sql = (
                        "SELECT COALESCE(SUM(n.value), 0) "
                        "FROM orchard_received_notes n "
                        "WHERE n.account_id = ? AND n.is_change = 0 "
                        "AND NOT EXISTS ("
                        "  SELECT 1 FROM orchard_received_note_spends s "
                        "  WHERE s.orchard_received_note_id = n.id"
                        ")"
                    )
                total_zat += int(con.execute(sql, (self._account_id,)).fetchone()[0])
        return decimal.Decimal(total_zat) / decimal.Decimal(10**8)

    def mergeto(self, addrs: List[str], to: str) -> dict:
        """Sweep our account's shielded balance to `to`. Attempts z_sendmany
        via RPC; the Zallet beta.1 RPC bug will make this hang until fixed."""
        if self.dummy:
            return {"opid": "opid-dummy"}
        with self._db() as con:
            self._load_account(con)
        FEE_ZAT = 10_000
        total_zat = int(self.get_total_balance() * decimal.Decimal(10**8))
        send_zat = total_zat - FEE_ZAT
        if send_zat <= 0:
            return {"opid": None, "note": "balance below fee threshold"}
        amount = decimal.Decimal(send_zat) / decimal.Decimal(10**8)
        opid = self._rpc(
            "z_sendmany",
            [self._account_uuid,
             [{"address": to, "amount": str(amount)}]],
        )
        return {"opid": opid, "mergingShieldedValue": float(amount)}
