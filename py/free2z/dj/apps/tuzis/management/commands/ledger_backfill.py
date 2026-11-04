"""Ledger rollout step 4: open an account for every creator and give every
historical purchase receipt its refund cursor (; docs/tuzis/ledger-v2.md
§10 step 4, §5.8, §11). DRY RUN UNLESS ``--apply``. No migration.

Run it as a detached Job (``k8s/free2z/ledger_backfill_job.yaml``), never
through ``kubectl exec``: a deploy drains the pod and kills the command with an
exit 137 that reads like an OOM (docs/agent-operations.md). The runbook is in
docs/tuzis/README.md, **Ledger backfill **.

WHAT IT DOES

Phase ``accounts``: every creator, in primary-key order, whose ``user``
account is missing **or** whose account disagrees with ``Creator.tuzis`` (R2)
is locked and passed through ``ledger.lock_account`` -- exactly what every
money path does on its first touch: ``ensure_account`` opens the account with
an ``opening`` transfer of ``tuzis * 1000`` from ``sys:opening_equity`` (read
under the creator lock), and the rollout self-heal (§10 step 3) journals any
R2 drift on an existing account as a ``legacy_adjustment``. Afterwards R2
holds for every account and ``reconcile_ledger``'s ``creators_without_account``
reads zero.

Phase ``refunds``: one ``ledger_purchase_refund`` row per historical receipt
that has none -- ``ref_kind``/``ref_id`` naming the receipt exactly as
``credit_purchase`` would (``stripe_transaction:<pk>``, ``zec_receipt:<pk>``),
``credited_m2z`` = what the receipt says was credited, ``refunded_m2z = 0``
(nothing before this release ever clawed a purchase back: there was no refund
handler). Units, exactly, never through a float:

* ``StripeTransaction.tuzis_credited`` is a ``PositiveIntegerField`` of whole
  2Z, so ``credited_m2z = tuzis_credited * 1000``;
* ``ZecCreditReceipt.tuzis_credited`` is ``NUMERIC(17,3)``, so
  ``credited_m2z = ledger.api.to_m2z(tuzis_credited)`` -- exact, and it
  refuses a fourth decimal rather than rounding.

WHAT IT SKIPS, AND WHY (reported by reason in every summary line)

* A receipt with no creator (``ZecCreditReceipt.creator`` is nullable): a
  cursor row must name the ``user`` account the purchase credited
  (``account_id NOT NULL``), and there is none. There is also nothing to claw
  back from. (``StripeTransaction.user`` is ``NOT NULL ON DELETE CASCADE``: a
  Stripe receipt whose creator is gone no longer exists to skip.)
* A ZEC receipt with ``tuzis_credited`` NULL or ``backfilled = true``: those
  rows were adopted from ``g12f.Transaction`` history and assert only "the old
  code saw this note", **not** that 2Z were issued (tuzis/models.py). A
  cursor would assert a credited amount nobody recorded. They stay in
  ``manage.py audit_zec_credits``'s queue, where a human decides.
* A receipt that credited 0 (the cursor's own CHECK is ``credited_m2z > 0``;
  there is nothing to refund).

**Inactive creators are NOT skipped.** A deactivated creator still has a
balance (R2 covers every account), can still receive a Stripe
``charge.refunded`` or a dispute for a purchase made while active, and the
refund path then needs the cursor. Opening an account for them moves nothing.

CONTENTION WITH LIVE TRAFFIC

Every batch is its own short transaction that takes **the same locks, in the
same order, as every money path** (§6): the batch's creator rows ``FOR NO KEY
UPDATE`` in primary-key order, then their ``ledger_account`` rows through
``ledger.lock_account``, then (refunds) the cursor rows. ``SET LOCAL
lock_timeout`` (default 2 s, the gateway's own budget) and ``statement_timeout``
bound every wait: a batch that hits one rolls back whole, backs off, halves its
size and retries (``--max-retries``); a batch of one that still cannot get its
lock stops the command with the checkpoint intact. It never holds a lock
across a sleep, and it never waits on anything a live request could be
waiting on it for, because it takes nothing a money path would take before a
creator row.

IDEMPOTENT, RESUMABLE, SAFE TO OVERLAP

* The work is selected by what is still missing (no account, R2 drift, no
  cursor row), so a re-run does nothing that has been done: re-running it is
  a no-op, and two overlapping runs cannot double anything --
  ``ensure_account`` is ``ON CONFLICT (key) DO NOTHING``, the heal is a
  compare-to-``tuzis`` under the creator lock, and the cursor insert is
  ``ON CONFLICT (ref_kind, ref_id) DO NOTHING``. A live ``credit_purchase``
  that writes the same cursor first wins; the backfill's insert then does
  nothing, and ``credited_m2z`` is the live path's.
* **Checkpoint by primary key.** Each committed batch records, in the same
  transaction, one ``ledger_reconcile_run`` row (``scope = 'backfill'``,
  ``invariant`` = the phase, ``detail.last_pk``). A later ``--apply`` resumes
  after the highest recorded ``last_pk`` (``--from-start`` ignores it), so a
  killed Job loses at most one uncommitted batch. After the keyset pass it
  sweeps once more from the start for stragglers -- a creator or receipt whose
  row committed after the pass went by its primary key (an identity value is
  allocated before its transaction commits) -- which, with nearly everything
  done, costs one index-backed anti-join.
"""
from __future__ import annotations

import json
import random
import time
import uuid
from dataclasses import dataclass, field
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import OperationalError, connection, transaction

from dj.apps.ledger import api, invariants

BACKFILL_EVENT = "ledger_backfill"
CHECKPOINT_SCOPE = "backfill"

#SQLSTATEs a batch backs off and retries on: lock_not_available (our own
#lock_timeout), deadlock_detected, serialization_failure, query_canceled
#(our own statement_timeout).
RETRYABLE_SQLSTATES = frozenset({"55P03", "40P01", "40001", "57014"})


def _json_line(payload) -> str:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True, default=str)


def _sqlstate(exc) -> str | None:
    cause = exc.__cause__
    return getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)


def _rows(sql, params=None):
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def _one(sql, params=None):
    return _rows(sql, params)[0]


# ----------------------------------------------------------------- receipts


@dataclass(frozen=True)
class ReceiptSource:
    """One purchase rail's receipt table, and what makes a receipt of it
    eligible for a refund cursor. ``eligible`` is SQL over alias ``r``; the
    skip reasons partition the ineligible rows for the report."""

    ref_kind: str
    rail: str
    owner_column: str
    skip_reasons: dict = field(default_factory=dict)
    eligible: str = ""

    @property
    def table(self) -> str:
        if self.ref_kind == "stripe_transaction":
            from dj.apps.ztripe.models import StripeTransaction
            return StripeTransaction._meta.db_table
        from dj.apps.tuzis.models import ZecCreditReceipt
        return ZecCreditReceipt._meta.db_table

    def credited_m2z(self, tuzis_credited) -> int:
        if self.ref_kind == "stripe_transaction":
            # PositiveIntegerField of whole 2Z.
            if not isinstance(tuzis_credited, int):
                raise TypeError(f"StripeTransaction.tuzis_credited is whole 2Z, got {tuzis_credited!r}")
            return tuzis_credited * api.M2Z_PER_2Z
        # NUMERIC(17,3): exact, refuses a fourth decimal, never a float.
        return api.to_m2z(Decimal(tuzis_credited))


SOURCES = (
    ReceiptSource(
        ref_kind="stripe_transaction", rail="stripe", owner_column="user_id",
        eligible="r.tuzis_credited > 0",
        skip_reasons={"zero_credit": "r.tuzis_credited <= 0"},
    ),
    ReceiptSource(
        ref_kind="zec_receipt", rail="zec", owner_column="creator_id",
        eligible=("r.creator_id IS NOT NULL AND NOT r.backfilled "
                  "AND r.tuzis_credited IS NOT NULL AND r.tuzis_credited > 0"),
        # Ordered and mutually exclusive: each ineligible row counts once.
        skip_reasons={
            "no_creator": "r.creator_id IS NULL",
            "backfilled_unverified": "r.creator_id IS NOT NULL AND r.backfilled",
            "no_credited_amount": ("r.creator_id IS NOT NULL AND NOT r.backfilled "
                                   "AND r.tuzis_credited IS NULL"),
            "zero_credit": ("r.creator_id IS NOT NULL AND NOT r.backfilled "
                            "AND r.tuzis_credited IS NOT NULL AND r.tuzis_credited <= 0"),
        },
    ),
)


def _missing_cursor(source: ReceiptSource) -> str:
    return ("NOT EXISTS (SELECT 1 FROM ledger_purchase_refund p "
            f"WHERE p.ref_kind = '{source.ref_kind}' AND p.ref_id = r.id::text)")


# LOCK 1 (§6): the batch's creator rows, primary-key order, FOR NO KEY UPDATE
# -- the strength ``ledger.lock_creator`` and ``lock_in_order`` take, so it
# is compatible with the FOR KEY SHARE a concurrent Event insert takes.
LOCK_CREATORS_SQL = (
    "SELECT c.id, c.tuzis FROM g12f_creator c WHERE c.id = ANY(%s)"
    " ORDER BY c.id FOR NO KEY UPDATE"
)

# The creators phase 1 still has work for: no user account, or R2 drift.
_CREATORS_NEEDING_WORK = """
      FROM g12f_creator c
      LEFT JOIN ledger_account a ON a.kind = 'user' AND a.owner_id = c.id
     WHERE (a.id IS NULL OR a.balance <> (c.tuzis * 1000)::bigint)
"""


def survey() -> dict:
    """Everything the dry run reports, and what a finished run re-reports as
    ``remaining``. SELECTs only."""
    creators, without, drifted = _one(
        "SELECT count(*), count(*) FILTER (WHERE a.id IS NULL),"
        "       count(*) FILTER (WHERE a.id IS NOT NULL AND a.balance <> (c.tuzis * 1000)::bigint)"
        "  FROM g12f_creator c LEFT JOIN ledger_account a ON a.kind = 'user' AND a.owner_id = c.id"
    )
    out = {
        "creators": int(creators),
        "creators_without_account": int(without),
        "accounts_r2_drifted": int(drifted),
        "inactive_creators_without_account": int(_one(
            "SELECT count(*) FROM g12f_creator c WHERE NOT c.is_active AND NOT EXISTS "
            "(SELECT 1 FROM ledger_account a WHERE a.kind = 'user' AND a.owner_id = c.id)")[0]),
    }
    for source in SOURCES:
        skips = ", ".join(
            f"count(*) FILTER (WHERE {predicate})" for predicate in source.skip_reasons.values()
        )
        row = _one(
            f"SELECT count(*),"
            f"       count(*) FILTER (WHERE {source.eligible} AND {_missing_cursor(source)}),"
            f"       coalesce(sum(r.tuzis_credited) FILTER (WHERE {source.eligible} AND {_missing_cursor(source)}), 0),"
            f"       count(*) FILTER (WHERE NOT {_missing_cursor(source)}), {skips}"
            f"  FROM {source.table} r"
        )
        prefix = source.ref_kind
        out[f"{prefix}_receipts"] = int(row[0])
        out[f"{prefix}_without_cursor"] = int(row[1])
        out[f"{prefix}_without_cursor_m2z"] = source.credited_m2z(
            int(row[2]) if source.ref_kind == "stripe_transaction" else Decimal(row[2]))
        out[f"{prefix}_with_cursor"] = int(row[3])
        for i, reason in enumerate(source.skip_reasons):
            out[f"{prefix}_skipped_{reason}"] = int(row[4 + i])
    return out


def remaining(found: dict) -> int:
    """How much work a survey says is left (skipped receipts are not work)."""
    return (found["creators_without_account"] + found["accounts_r2_drifted"]
            + sum(found[f"{s.ref_kind}_without_cursor"] for s in SOURCES))


def stored_checkpoint(phase: str) -> int:
    """The highest ``last_pk`` any committed batch of ``phase`` recorded."""
    row = _one(
        "SELECT max((detail->>'last_pk')::bigint) FROM ledger_reconcile_run"
        " WHERE scope = %s AND invariant = %s",
        [CHECKPOINT_SCOPE, phase],
    )
    return int(row[0] or 0)


# ----------------------------------------------------------------- the runner


class LockContention(CommandError):
    """A batch of one could not get its locks within the retry budget."""


class Backfill:
    """One ``--apply`` run. The batch methods are the unit a test drives."""

    #Test seam: called inside each batch's transaction right after its
    #creator rows are locked, before the ledger is touched. The negative
    #control uses it to race a live write into exactly that window.
    after_creators_locked = None

    def __init__(self, *, batch_size=500, lock_timeout_ms=2000, statement_timeout_ms=30000,
                 max_retries=8, pause=0.05, max_batches=None, log=None):
        self.batch_size = batch_size
        self.lock_timeout_ms = lock_timeout_ms
        self.statement_timeout_ms = statement_timeout_ms
        self.max_retries = max_retries
        self.pause = pause
        self.max_batches = max_batches
        self.batches = 0
        self.retries = 0
        self.run_id = str(uuid.uuid4())
        self.log = log or (lambda payload: None)
        self.totals = {"accounts_opened": 0, "accounts_healed": 0, "accounts_touched": 0,
                       **{f"{s.ref_kind}_cursors_written": 0 for s in SOURCES},
                       **{f"{s.ref_kind}_cursors_written_m2z": 0 for s in SOURCES}}

    # -- plumbing

    @property
    def exhausted(self) -> bool:
        return self.max_batches is not None and self.batches >= self.max_batches

    def _set_timeouts(self):
        with connection.cursor() as cursor:
            # Integers we own, not user input; SET does not take parameters.
            cursor.execute(f"SET LOCAL lock_timeout = '{int(self.lock_timeout_ms)}ms'")
            cursor.execute(f"SET LOCAL statement_timeout = '{int(self.statement_timeout_ms)}ms'")

    def _checkpoint(self, phase, last_pk, processed, detail):
        with connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO ledger_reconcile_run"
                " (started_at, finished_at, scope, invariant, accounts_checked, drift_count, drift_m2z, detail)"
                " VALUES (now(), now(), %s, %s, %s, 0, 0, %s::jsonb)",
                [CHECKPOINT_SCOPE, phase, processed,
                 json.dumps({"last_pk": last_pk, "run_id": self.run_id, **detail})],
            )

    def _retrying(self, phase, batch):
        """Run ``batch(size)`` in its own transaction, backing off and halving
        on lock contention. Returns what the batch returned."""
        size = self.batch_size
        for attempt in range(self.max_retries + 1):
            try:
                with transaction.atomic():
                    self._set_timeouts()
                    return batch(size)
            except OperationalError as exc:
                state = _sqlstate(exc)
                if state not in RETRYABLE_SQLSTATES:
                    raise
                self.retries += 1
                self.log({"event": BACKFILL_EVENT, "status": "retry", "phase": phase,
                          "sqlstate": state, "attempt": attempt + 1, "batch_size": size})
                if attempt == self.max_retries:
                    raise LockContention(
                        f"{phase}: a batch of {size} could not get its locks after "
                        f"{self.max_retries} retries ({state}); the checkpoint is intact, re-run to resume"
                    ) from exc
                size = max(1, size // 2)
                time.sleep(min(5.0, 0.1 * 2 ** attempt) * (0.5 + random.random()))
        raise AssertionError("unreachable")

    def _lock_creators(self, ids):
        """LOCK 1 (§6) for a batch: creator rows, primary-key order, the
        strength every money path takes. Returns ``[(id, tuzis)]``."""
        return _rows(LOCK_CREATORS_SQL, [list(ids)])

    def _lock_accounts(self, locked):
        """LOCK 2: ``ledger.lock_account`` per creator (open, lock, heal), in
        the same order. Returns ``{creator_id: (account_id, balance_before, balance_after)}``."""
        if not locked:
            return {}
        before = dict(_rows(
            "SELECT owner_id, balance FROM ledger_account WHERE kind = 'user' AND owner_id = ANY(%s)",
            [[cid for cid, _ in locked]],
        ))
        after = _rows(
            "SELECT u.id, a.id, a.balance"
            "  FROM unnest(%s::bigint[], %s::numeric[]) WITH ORDINALITY AS u(id, tuzis, ord)"
            "  CROSS JOIN LATERAL ledger.lock_account(u.id, u.tuzis) a"
            " ORDER BY u.ord",
            [[cid for cid, _ in locked], [tuzis for _, tuzis in locked]],
        )
        api.statements_issued += 1   # the conftest R1/R3 hook counts ledger statements
        return {cid: (aid, before.get(cid), bal) for cid, aid, bal in after}

    # -- phase 1

    def accounts_batch(self, after_pk: int, size: int):
        """Lock and open/heal the next ``size`` creators needing it after
        ``after_pk``. Returns the last pk locked, or None when there are none."""
        picked = _rows(
            f"SELECT c.id {_CREATORS_NEEDING_WORK} AND c.id > %s ORDER BY c.id LIMIT %s",
            [after_pk, size],
        )
        if not picked:
            return None
        locked = self._lock_creators([cid for (cid,) in picked])
        if self.after_creators_locked is not None:
            self.after_creators_locked([cid for cid, _ in locked])
        accounts = self._lock_accounts(locked)
        opened = sum(1 for _, before, _ in accounts.values() if before is None)
        healed = sum(1 for _, before, after in accounts.values() if before is not None and before != after)
        last_pk = picked[-1][0]
        self._checkpoint("accounts", last_pk, len(accounts), {"opened": opened, "healed": healed})
        self.totals["accounts_opened"] += opened
        self.totals["accounts_healed"] += healed
        self.totals["accounts_touched"] += len(accounts)
        return last_pk

    # -- phase 2

    def refunds_batch(self, source: ReceiptSource, after_pk: int, size: int):
        picked = _rows(
            f"SELECT r.id, r.{source.owner_column}, r.tuzis_credited FROM {source.table} r"
            f" WHERE r.id > %s AND {source.eligible} AND {_missing_cursor(source)}"
            f" ORDER BY r.id LIMIT %s",
            [after_pk, size],
        )
        if not picked:
            return None
        owners = sorted({owner for _, owner, _ in picked})
        locked = self._lock_creators(owners)
        if self.after_creators_locked is not None:
            self.after_creators_locked([cid for cid, _ in locked])
        accounts = self._lock_accounts(locked)
        refs, account_ids, amounts = [], [], []
        for receipt_id, owner, tuzis_credited in picked:
            if owner not in accounts:
                continue   # the creator vanished between the pick and the lock; next pass reports it
            refs.append(str(receipt_id))
            account_ids.append(accounts[owner][0])
            amounts.append(source.credited_m2z(tuzis_credited))
        written = _rows(
            "INSERT INTO ledger_purchase_refund (ref_kind, ref_id, rail, account_id, credited_m2z, refunded_m2z)"
            " SELECT %s, u.ref_id, %s, u.account_id, u.credited_m2z, 0"
            "   FROM unnest(%s::text[], %s::bigint[], %s::bigint[]) AS u(ref_id, account_id, credited_m2z)"
            " ON CONFLICT (ref_kind, ref_id) DO NOTHING"
            " RETURNING credited_m2z",
            [source.ref_kind, source.rail, refs, account_ids, amounts],
        ) if refs else []
        last_pk = picked[-1][0]
        written_m2z = sum(int(m2z) for (m2z,) in written)
        self._checkpoint(f"refunds:{source.ref_kind}", last_pk, len(picked),
                         {"cursors_written": len(written), "cursors_written_m2z": written_m2z})
        self.totals[f"{source.ref_kind}_cursors_written"] += len(written)
        self.totals[f"{source.ref_kind}_cursors_written_m2z"] += written_m2z
        return last_pk

    # -- driving

    def _pass(self, phase, start, batch):
        after = start
        while not self.exhausted:
            last = self._retrying(phase, lambda size, after=after: batch(after, size))
            if last is None:
                return True
            self.batches += 1
            self.log({"event": BACKFILL_EVENT, "status": "batch", "phase": phase,
                      "checkpoint_pk": last, "batches": self.batches})
            after = last
            if self.pause:
                time.sleep(self.pause)
        return False

    def run_phase(self, phase, batch, *, from_start):
        """Keyset pass from the checkpoint, then one straggler sweep from the
        start (it only visits rows that still need work). Returns False if
        ``--max-batches`` stopped it first."""
        start = 0 if from_start else stored_checkpoint(phase)
        if not self._pass(phase, start, batch):
            return False
        return self._pass(phase, 0, batch)

    def run(self, *, phases, from_start):
        if "accounts" in phases:
            if not self.run_phase("accounts", self.accounts_batch, from_start=from_start):
                return False
        if "refunds" in phases:
            for source in SOURCES:
                batch = lambda after, size, source=source: self.refunds_batch(source, after, size)  # noqa: E731
                if not self.run_phase(f"refunds:{source.ref_kind}", batch, from_start=from_start):
                    return False
        return True


class Command(BaseCommand):
    help = (
        "Ledger rollout step 4 (#2236): open a ledger account for every creator and write a "
        "refund cursor for every historical purchase receipt. Dry run unless --apply."
    )

    def add_arguments(self, parser):
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument("--apply", action="store_true", help="Write. The default only reports.")
        mode.add_argument("--dry-run", action="store_true",
                          help="Report only (the default; accepted so a Job can say so explicitly).")
        parser.add_argument("--phase", choices=("all", "accounts", "refunds"), default="all")
        parser.add_argument("--batch-size", type=int, default=500,
                            help="Rows per transaction (default 500); halved on lock contention.")
        parser.add_argument("--lock-timeout-ms", type=int, default=2000)
        parser.add_argument("--statement-timeout-ms", type=int, default=30000)
        parser.add_argument("--max-retries", type=int, default=8,
                            help="Retries per batch on lock contention before stopping (default 8).")
        parser.add_argument("--pause", type=float, default=0.05,
                            help="Seconds to sleep between batches, holding no lock (default 0.05).")
        parser.add_argument("--max-batches", type=int, default=None,
                            help="Stop after this many committed batches (a partial run; resume later).")
        parser.add_argument("--from-start", action="store_true",
                            help="Ignore the stored checkpoint and scan from the first primary key.")

    def emit(self, payload):
        self.stdout.write(_json_line(payload))
        # A Job's stdout is a pipe: flush so a deadline kill keeps the log.
        self.stdout.flush()

    def handle(self, *args, **options):
        for name in ("batch_size", "lock_timeout_ms", "statement_timeout_ms"):
            if options[name] < 1:
                raise CommandError(f"--{name.replace('_', '-')} must be at least 1")
        if options["max_retries"] < 0 or (options["max_batches"] is not None and options["max_batches"] < 1):
            raise CommandError("--max-retries must be >= 0 and --max-batches >= 1")
        phases = ("accounts", "refunds") if options["phase"] == "all" else (options["phase"],)
        config = _one("SELECT dual_write, heal_enabled FROM ledger_config")
        before = survey()
        checkpoints = {"accounts": stored_checkpoint("accounts"),
                       **{f"refunds:{s.ref_kind}": stored_checkpoint(f"refunds:{s.ref_kind}") for s in SOURCES}}
        self.emit({"event": BACKFILL_EVENT, "status": "dry_run" if not options["apply"] else "starting",
                   "phases": list(phases), "dual_write": config[0], "heal_enabled": config[1],
                   "checkpoints": checkpoints, **before})
        if not options["apply"]:
            return

        runner = Backfill(
            batch_size=options["batch_size"], lock_timeout_ms=options["lock_timeout_ms"],
            statement_timeout_ms=options["statement_timeout_ms"], max_retries=options["max_retries"],
            pause=options["pause"], max_batches=options["max_batches"], log=self.emit,
        )
        started = time.monotonic()
        try:
            finished = runner.run(phases=phases, from_start=options["from_start"])
        except LockContention:
            self.emit({"event": BACKFILL_EVENT, "status": "stopped", "reason": "lock_contention",
                       "run_id": runner.run_id, "batches": runner.batches, "retries": runner.retries,
                       **runner.totals})
            raise
        after = survey()
        self.emit({
            "event": BACKFILL_EVENT,
            "status": "completed" if finished else "partial",
            "run_id": runner.run_id,
            "batches": runner.batches,
            "retries": runner.retries,
            "duration_ms": int((time.monotonic() - started) * 1000),
            **runner.totals,
            "remaining": remaining(after),
            **{f"after_{k}": v for k, v in after.items()},
            "r2_drift_after": len(invariants.r2_tuzis_projection_equals_balance()),
        })
