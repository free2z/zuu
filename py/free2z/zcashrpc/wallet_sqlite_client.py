"""
free2z zcash client — reads a mainstream `zcash_client_sqlite` wallet DB
(the format devtool/zallet/librustzcash use). Selected by
`py/zcashrpc/client.py` when `ZCASHRPC_CLIENT=wallet_sqlite`.

Same public interface the Django credit commands use:
  recieved_by(addr) -> [{txid, amount, amountZat, memo(hex), output_index, pool}]
                                                                (feeds credit_creators / credit_pages_unified)
  get_total_balance(), get_balance(addr), list_sapling(), new_addr(), mergeto()

Live mode when WALLET_DB points at an existing zcash_client_sqlite data.sqlite.
Env:
  WALLET_DB       path to zcash_client_sqlite data.sqlite (devtool ~/f2z-forward/data.sqlite)
  WALLET_ACCOUNT  integer accounts.id to read (default 1)
"""
import os
import codecs
import random
import decimal
import sqlite3
from typing import List

ZATS = decimal.Decimal(10) ** 8


def ascii2hex(x: str) -> str:
    return codecs.encode(bytes(x, "ascii"), "hex").decode()


def hex2ascii(x: str) -> str:
    return codecs.decode(x, "hex").decode()


class Client(object):
    # Blocks a note must be buried under before its 2Z are issued.
    #
    # Three, not zero and not ten. Zero is what the absence of a filter used to
    # produce and it credits notes that are not in a block at all. Ten is
    # zcashd's own spendability default, but it adds ~12 minutes to every
    # purchase, which is a real product cost paid against a risk that is
    # already gone by three: a Zcash reorg deeper than two blocks is rare
    # enough that it would be an incident, and an incident is a thing a human
    # can respond to, whereas an unmined credit is not.
    #
    # Override with ZEC_MIN_CONFIRMATIONS. Setting it to 0 restores the old
    # behaviour and is a choice somebody has to make on purpose.
    DEFAULT_MIN_CONFIRMATIONS = 3

    # The ONLY values this setting may take. Both ends are money bugs, and
    # both leave every signal green (found by the codex adversarial review):
    #
    #   negative -- an unmined note has `confirmations = 0`, and `0 < -1` is
    #     false, so it is credited. Irreversible 2Z for ZEC that is not on
    #     chain, which is the exact hole the floor was added to close.
    #   too large -- `300` is a plausible seconds-versus-blocks slip (the loop
    #     interval is in seconds and lives two lines away in credit-loop.sh).
    #     At ~75s/block that holds every payment for six hours while the cycle
    #     keeps heartbeating, because a held note is deliberately NOT an error.
    #     A silent six-hour crediting outage with a green absence alert is the
    #     11-month gap in miniature.
    #
    # 100 blocks is ~2 hours: far beyond any reorg anyone should tolerate, and
    # still recognisably a confirmation count rather than a duration.
    MAX_MIN_CONFIRMATIONS = 100

    def __init__(self) -> None:
        self.dummy = True
        self.db_path = os.environ.get("WALLET_DB")
        self.account = int(os.environ.get("WALLET_ACCOUNT", "1"))
        raw = os.environ.get(
            "ZEC_MIN_CONFIRMATIONS", self.DEFAULT_MIN_CONFIRMATIONS)
        try:
            self.min_confirmations = int(raw)
        except (TypeError, ValueError):
            # A typo in an env var must not silently disable the only thing
            # standing between a reorg and irreversible platform credits.
            print(f"!! ZEC_MIN_CONFIRMATIONS={raw!r} is not an integer; using "
                  f"{self.DEFAULT_MIN_CONFIRMATIONS}")
            self.min_confirmations = self.DEFAULT_MIN_CONFIRMATIONS
        if not 0 <= self.min_confirmations <= self.MAX_MIN_CONFIRMATIONS:
            # Refuse, loudly, and fall back to the default -- never to the
            # out-of-range value and never to 0. Both directions are money
            # bugs that keep every signal green; see MAX_MIN_CONFIRMATIONS.
            print(f"!! ZEC_MIN_CONFIRMATIONS={raw!r} is outside "
                  f"0..{self.MAX_MIN_CONFIRMATIONS}; using "
                  f"{self.DEFAULT_MIN_CONFIRMATIONS}. A negative value would "
                  f"credit UNMINED notes; a very large one would hold every "
                  f"payment while the cycle kept heartbeating.")
            self.min_confirmations = self.DEFAULT_MIN_CONFIRMATIONS
        # Notes seen but held for depth; filled in by `recieved_by`.
        #
        # `pending` is the (txid, pool, confirmations) triple the log line is
        # built from and is kept for compatibility. `pending_notes` carries
        # the SAME notes in the full dict shape `recieved_by` returns, because
        # a held note is not only a log line: the buyer has to be told we saw
        # it, and a small one may be credited immediately. The two are always
        # appended together and always have the same length.
        self.pending = []
        self.pending_notes = []
        if self.db_path and os.path.exists(self.db_path):
            print("Using mainstream zcash_client_sqlite wallet")
            self.dummy = False

    def _conn(self):
        # `mode=ro` means this connection CANNOT roll back a hot journal: if the
        # syncing process was SIGKILLed mid-write, sqlite needs write access to
        # recover, and a read-only opener gets SQLITE_READONLY (or reads a
        # stale/short database) instead. Since credit-loop.sh started bounding
        # the sync with `timeout -k`, a killed sync is a routine event -- so
        # run_once returning early on ANY sync failure is a CORRECTNESS
        # requirement, not a stylistic one. Do not reorder the credit commands
        # ahead of the sync check, and do not "recover" by making this rw.
        return sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)

    def new_addr(self) -> str:
        # addresses are issued by devtool `generate-address`; kept for interface compat
        if self.dummy:
            z = "zs1lm4vumxdpuz08w237n0lpxz490uq5nxasz6mql555f96hql4h7kc3ucf2a42j7mp0slck2uvjjk"
            return "".join(random.sample(z, len(z)))
        return ""

    def is_valid(self, addr: str) -> bool:
        return True

    def list_sapling(self) -> List[str]:
        return []

    def list_deprecated(self) -> List[str]:
        return []

    # Per-note index within its transaction. A Zcash transaction can pay
    # SEVERAL outputs to us, and this table emits one row per note, so without
    # an index two notes of one transaction are indistinguishable -- which is
    # exactly how (b) either lost the second payment to an IntegrityError
    # or overwrote the first payer's record. `credit_creators` keys its
    # idempotency receipt on (txid, output_index).
    #
    # zcash_client_sqlite names it `output_index` for Sapling and
    # `action_index` for Orchard.
    # The pool is part of the identity, not decoration: `output_index` and
    # `action_index` are POOL-LOCAL namespaces, so a transaction paying one
    # Sapling output and one Orchard action produces two DIFFERENT notes that
    # both report index 0. UNIONing them without the pool collides the receipt
    # key and the second buyer never gets credited.
    #
    # EVERY shielded pool must be listed here, and the list is checked against
    # the wallet at runtime (see `unreadable_pools`). The live wallet already
    # carries an `ironwood_received_notes` table -- librustzcash's fourth
    # shielded pool, which `v_received_outputs` numbers 4 alongside
    # sapling=2/orchard=3 -- and a hardcoded two-pool UNION is blind to it.
    # A memo'd payment landing in a pool nobody queries produces `Saw 0`,
    # which is the exact log line an idle wallet produces. That is the
    # ambiguity turning into lost money rather than merely lost confidence.
    #
    # (table, per-note index column, pool name reported to credit_creators)
    _POOLS = (
        ("sapling_received_notes", "output_index", "sapling"),
        ("orchard_received_notes", "action_index", "orchard"),
        ("ironwood_received_notes", "action_index", "ironwood"),
    )

    # Received-output tables that exist but can never carry a `buy_2z` memo,
    # so a payment arriving in one is money we hold and cannot credit. Not an
    # error in the adapter -- but it must be reported, because the published
    # unified address really does have a P2PKH receiver (`receiver_flags` 13
    # on the address the UI hands buyers), so a transparent-only sender such
    # as an exchange can pay it.
    _UNCREDITABLE = (
        ("transparent_received_outputs",
         "transparent outputs carry no memo, so no buy_2z payload can be read"),
    )

    def _tables(self):
        c = self._conn()
        try:
            return {r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            c.close()

    def _pool_query(self, table: str, index_col: str, pool: str,
                    indexed: bool = True) -> str:
        # NULL is intentional in degraded mode. The public adapter still
        # exposes note_output_index's conservative zero for receipt
        # idempotency, but the missing value must remain distinguishable from
        # a real index 0 for durable malformed-memo dispositions.
        index_expr = f"n.{index_col}" if indexed else "NULL"
        # Compact scanning is not memo hydration. Mask instructions unless
        # both full transaction and per-note memo are known; retain every
        # note's identity/value for instant-credit backing reconciliation.
        # The separate read-only audit reports NULL/invalid data durably.
        return (
            f"SELECT t.txid, n.value, "
            "CASE WHEN typeof(t.raw) = 'blob' AND length(t.raw) > 0 "
            "AND n.memo IS NOT NULL AND typeof(n.memo) = 'blob' "
            "THEN n.memo ELSE NULL END, "
            f"{index_expr}, '{pool}', t.mined_height "
            f"  FROM {table} n "
            f"  JOIN transactions t ON n.transaction_id=t.id_tx"
        )

    def _tip(self) -> int:
        c = self._conn()
        try:
            row = c.execute("SELECT max(height) FROM blocks").fetchone()
            return int(row[0]) if row and row[0] is not None else 0
        finally:
            c.close()

    def _rows(self):
        # Read received notes across ALL accounts in the wallet (new Unified
        # account AND the imported legacy Sapling FVK) and across every
        # shielded pool the wallet actually has -- we scan both addresses
        # indefinitely.
        present = self._tables()
        pools = [p for p in self._POOLS if p[0] in present]
        if not pools:
            # Not a quiet wallet: a wallet with no note table at all is not a
            # zcash_client_sqlite wallet, and returning [] would be reported
            # as "nothing to credit".
            raise sqlite3.OperationalError(
                "no received-note table in the wallet at "
                f"{self.db_path}; this is not a zcash_client_sqlite wallet")
        c = self._conn()
        try:
            try:
                return c.execute(" UNION ALL ".join(
                    self._pool_query(*p) for p in pools)).fetchall()
            except sqlite3.OperationalError as exc:
                # An older/newer wallet schema that spells the index columns
                # differently. Degrade to index 0 for every note: that makes
                # two notes of one transaction collapse onto one receipt, so
                # the second goes UNCREDITED (visible, recoverable by hand)
                # rather than being credited twice (invisible, unrecoverable).
                # credit_creators prints CREDITING BLOCKED when it notices.
                print(f"!! no per-note index column ({exc}); "
                      f"multi-output transactions cannot be credited")
                return c.execute(" UNION ALL ".join(
                    self._pool_query(*p, indexed=False)
                    for p in pools)).fetchall()
        finally:
            c.close()

    def unreadable_pools(self) -> List[tuple]:
        """Pools holding notes this adapter cannot turn into 2Z.

        Returns ``[(pool_name, note_count, reason),...]``, empty when every
        received output in the wallet is one `recieved_by` reports.

        This exists because the failure it catches is invisible. `recieved_by`
        UNIONs a fixed list of tables; librustzcash adds a pool by adding a
        table. A wallet upgrade -- which happens on the payment host's own schedule,
        with no PR here -- can therefore route real, memo'd payments into
        storage the credit path never SELECTs from, and every symptom is
        `Saw 0 notes for 0 ZEC`: the same line a wallet nobody has paid emits.
        `credit_creators` turns a non-empty result into a CREDITING BLOCKED
        line, so the money is loud instead of silent.
        """
        if self.dummy:
            return []
        present = self._tables()
        known = {t for t, _, _ in self._POOLS}
        out = []
        c = self._conn()
        try:
            for table, reason in self._UNCREDITABLE:
                if table not in present:
                    continue
                n = self._unhandled(c, table, present)
                if n:
                    out.append((table, n, reason))
            # Anything shaped like a received-note table that `_POOLS` does
            # not name. Matching on the suffix rather than on a list of known
            # future names is deliberate: the point is to notice a pool that
            # did not exist when this file was written.
            for table in sorted(present):
                if not table.endswith("_received_notes") or table in known:
                    continue
                n = self._unhandled(c, table, present)
                if n:
                    out.append((table, n, (
                        "this shielded pool did not exist when the credit "
                        "adapter was written, so its notes are never read")))
        finally:
            c.close()
        return out

    @staticmethod
    def _unhandled(conn, table: str, present) -> int:
        """Count only outputs in `table` that are still UNSPENT.

        The alert this feeds pages on presence AND withholds the heartbeat, so
        without a way to clear it, one transparent payment arriving in 2027
        would page every 90 seconds forever and there would be no safe action
        that stopped it -- which makes every later, real failure
        indistinguishable from acknowledged history. (Found by the codex
        adversarial review.)

        Spending the output is the acknowledgement. It is not a flag somebody
        can set to make an inconvenient alert go away: it means the funds were
        actually swept or forwarded, which is the only thing that resolves
        "we are holding money we cannot credit". Sweeping is a deliberate
        `zcash-devtool send` by a human, and the spend row it writes is
        durable wallet state.

        A pool whose spend table this build does not know about counts
        everything, because over-reporting money we hold is the safe
        direction.
        """
        # `<x>_received_notes` -> `<x>_received_note_spends`
        # `<x>_received_outputs` -> `<x>_received_output_spends`
        spends = (table[:-1] + "_spends") if table.endswith("s") else None
        if spends in present:
            column = spends[:-len("_spends")] + "_id"
            row = conn.execute(
                f"SELECT count(*) FROM {table} n WHERE NOT EXISTS ("
                f"  SELECT 1 FROM {spends} s WHERE s.{column} = n.id)"
            ).fetchone()
        else:
            row = conn.execute(f"SELECT count(*) FROM {table}").fetchone()
        return int(row[0]) if row else 0

    def recieved_by(self, addr: str) -> List[dict]:
        if self.dummy:
            return [{
                "txid": "04b11c78906d6cf94792cabe03c542c47626dae7521c007f2d7eecd10944ab40",
                "amount": 0.01, "amountZat": 1000000, "memo": "f6" + "00" * 511,
            }]
        out = []
        tip = self._tip()
        self.pending = []
        self.pending_notes = []
        for (txid_blob, value, memo_blob, output_index, pool,
                mined_height) in self._rows():
            # zcash_client_sqlite stores txid in internal (consensus) byte order
            display_txid = bytes(txid_blob)[::-1].hex()

            # CONFIRMATION DEPTH. Crediting is irreversible -- 2Z are spendable
            # the instant they land -- while a Zcash transaction is not, until
            # it is mined and buried. `transactions` legitimately holds rows
            # with no `mined_height` during normal operation (mempool,
            # rollback), and every one of those used to be credited on the next
            # 90-second cycle. A transaction that then expires, is replaced, or
            # is orphaned turns ZEC that does not exist into platform credits
            # the buyer has already spent, and nothing unwinds it.
            #
            # The effective policy was zero, and audit finding 12 records that
            # nobody chose it -- it is what the absence of a filter produced.
            # This chooses one. (Found by the codex adversarial review.)
            confirmations = 0 if mined_height is None else (
                tip - int(mined_height) + 1)

            # memo stored as trimmed content bytes; credit_creators expects hex it can decode
            memo_hex = bytes(memo_blob).hex() if memo_blob else ""
            note = {
                "txid": display_txid,
                "amount": float(value) / 1e8,
                "amountZat": int(value),
                "memo": memo_hex,
                "memo_available": memo_blob is not None,
                "memo_format": "zcash_client_sqlite_content",
                # Read by dj.apps.tuzis.zec.note_output_index. zcashd's RPC
                # calls the same thing `outindex`; both spellings are accepted.
                "output_index": int(output_index or 0),
                # A synthetic zero is safe only for the existing receipt
                # collapse guard. Dispositions must reject it rather than
                # letting two same-amount notes share one audit row.
                "output_index_reliable": output_index is not None,
                # Read by dj.apps.tuzis.zec.note_pool. Pool-local indices are
                # only unique WITHIN a pool.
                "pool": pool,
                "confirmations": confirmations,
            }

            if confirmations < self.min_confirmations:
                # Deliberately NOT an error and NOT `CREDITING BLOCKED`:
                # nothing is wrong, the note is simply young. It is credited
                # by a later cycle, minutes from now, with no action needed.
                #
                # The note is still HANDED to the caller, via `pending_notes`.
                # A held note that nobody outside this method can see is the
                # ~4 minutes of silence the buyer experiences as "did my money
                # vanish?", and it is the reason a zero-confirmation policy
                # cannot even be expressed. Returning it here does NOT credit
                # it -- `recieved_by` remains the confirmed-only list, and
                # every caller that ignores `pending_notes` behaves exactly as
                # it did before.
                self.pending.append((display_txid, pool, confirmations))
                self.pending_notes.append(note)
                continue

            out.append(note)
        if self.pending:
            print(f"holding {len(self.pending)} note(s) for confirmations "
                  f"(need {self.min_confirmations}): "
                  + ", ".join(f"{t[:12]}…:{p}={c}" for t, p, c in self.pending))
        return out

    def read_messages(self, addr: str) -> None:
        for tx in self.recieved_by(addr):
            try:
                print(hex2ascii(tx["memo"]))
            except UnicodeDecodeError:
                pass

    def _unspent_zat(self) -> int:
        """Unspent value held for `self.account`, in zatoshis.

        Adequate for a threshold check; the authoritative spendable balance
        comes from devtool `balance` at sweep time.

        There is NO `spent_in` column on the note tables in the deployed
        schema -- verified against the production wallet, 55 schemer
        migrations -- and there has not been for some time: a spend is a row
        in `<pool>_received_note_spends`. The previous query named
        `spent_in`, so it raised `OperationalError` on every call and fell
        through to a handler that summed EVERY note ever received, spent
        included. It therefore reported a balance that only ever grows, and
        it did so silently. Sweeping on that number over-states the funds.
        """
        present = self._tables()
        parts, params = [], {"acct": self.account}
        for table, _index_col, pool in self._POOLS:
            spends = f"{pool}_received_note_spends"
            if table not in present:
                continue
            if spends in present:
                parts.append(
                    f"SELECT n.value FROM {table} n "
                    f" WHERE n.account_id=:acct AND NOT EXISTS ("
                    f"   SELECT 1 FROM {spends} s "
                    f"    WHERE s.{pool}_received_note_id = n.id)")
            else:
                # A pool whose spend table this build does not know about.
                # Count the notes as unspent (over-states the balance) but
                # say so, rather than dropping the pool (under-states it and
                # would hide funds entirely).
                print(f"!! {spends} is missing; {pool} notes are all counted "
                      f"as unspent and this balance is an upper bound")
                parts.append(
                    f"SELECT n.value FROM {table} n WHERE n.account_id=:acct")
        if not parts:
            return 0
        c = self._conn()
        try:
            s = c.execute(
                "SELECT COALESCE(SUM(value),0) FROM ("
                + " UNION ALL ".join(parts) + ")", params).fetchone()
            return int(s[0]) if s and s[0] else 0
        finally:
            c.close()

    def get_balance(self, addr: str) -> float:
        return 0.0 if self.dummy else float(self._unspent_zat()) / 1e8

    def get_total_balance(self) -> decimal.Decimal:
        return decimal.Decimal(0) if self.dummy else decimal.Decimal(self._unspent_zat()) / ZATS

    def mergeto(self, addrs: List[str], to: str) -> dict:
        # sweep is a deliberate one-time devtool `send`/`pay`, driven outside this client
        return {"opid": "use-devtool-send"}
