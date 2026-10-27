"""Python wrappers over the ``ledger.*`` SQL functions (docs/tuzis/ledger-v2.md §4, §5.7, §5.8).

This is the surface other apps call. Every function here is one SQL
statement (one transaction in autocommit; part of the caller's transaction
inside ``transaction.atomic()``), and every outcome a caller is expected to
handle is a **returned status**, never an exception: ``insufficient``,
``in_debt``, ``frozen``, ``inactive``, ``replayed``, ``posted``. A
``DatabaseError`` from here is a programming error (a negative amount, an
unknown creator, an unknown system account), which is the right outcome for
a bug and the wrong one for "not enough credits".

Units convert at this boundary and nowhere else: every ``*_m2z`` argument
and every number in a result is an ``int`` of milli-2Z, exactly as the
database holds it. ``to_m2z`` turns a ``Decimal`` 2Z amount (3 decimal
places, the column's precision) into m2Z, and ``from_m2z`` turns a result's
m2Z back into ``Decimal`` 2Z for display or for ``Creator.tuzis``
comparisons. Never through a float (§1).

``tuzis/ledger.py`` (the product's money primitives) is implemented over
this module since the dual-write release (§10 steps 2-3, ): every
``Creator.tuzis`` movement is a ledger function call, and ``post_transfer``'s
projection is what moves the column.
"""
from __future__ import annotations

import datetime
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from django.db import connection, transaction

from dj.apps.economy.epoch import prepared_writer

from .system_accounts import PURCHASE_RAILS, clearing_account_key

M2Z_PER_2Z = 1000
_TUZI_EXPONENT = Decimal("0.001")

#How many ``ledger.*`` statements this process has issued. A test hook:
#``py/conftest.py`` reads it to decide whether a test touched the ledger
#and therefore whether R1/R3 must hold at its end.
statements_issued = 0


def to_m2z(amount) -> int:
    """``Decimal`` 2Z (3 decimal places, the column's precision) -> int m2Z.

    Exact: ``Creator.tuzis`` is ``NUMERIC(17,3)``, so ``tuzis * 1000`` is an
    integer. A value with more than three decimals is refused rather than
    rounded -- rounding here would make the ledger and the column disagree
    by design.
    """
    if isinstance(amount, float):
        raise TypeError("2Z amounts are Decimal, never float")
    try:
        value = Decimal(amount)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"Not a valid 2Z amount: {amount!r}") from exc
    if not value.is_finite():
        raise ValueError(f"Not a valid 2Z amount: {amount!r}")
    if value != value.quantize(_TUZI_EXPONENT):
        raise ValueError(f"2Z amounts have at most 3 decimal places: {amount!r}")
    return int(value * M2Z_PER_2Z)


def from_m2z(m2z: int | None) -> Decimal | None:
    if m2z is None:
        return None
    return (Decimal(int(m2z)) / M2Z_PER_2Z).quantize(_TUZI_EXPONENT)


def _count():
    global statements_issued
    statements_issued += 1


@prepared_writer
def _call(function: str, *args):
    """``SELECT * FROM ledger.<function>(...)`` and return the single row."""
    _count()
    placeholders = ", ".join(["%s"] * len(args))
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT * FROM ledger.{function}({placeholders})", list(args))
        return cursor.fetchone()


def _scalar(function: str, *args):
    _count()
    placeholders = ", ".join(["%s"] * len(args))
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT ledger.{function}({placeholders})", list(args))
        return cursor.fetchone()[0]


# ------------------------------------------------------------------ results


@dataclass(frozen=True)
class SpendResult:
    status: str            # posted | replayed | insufficient | in_debt | frozen
    balance: int           # m2Z
    available: int         # m2Z, balance - held
    transfer_id: int | None

    @property
    def posted(self) -> bool:
        return self.status == "posted"


@dataclass(frozen=True)
class SpendUpToResult:
    charged: int           # m2Z; 0 while in debt or frozen
    balance: int
    available: int
    transfer_id: int | None


@dataclass(frozen=True)
class CreditResult:
    status: str            # posted | replayed
    credited: int          # m2Z that reached the spendable balance
    debt_repaid: int       # m2Z that met the owner's debt first
    balance: int
    transfer_id: int | None
    repay_transfer_id: int | None


@dataclass(frozen=True)
class TransferResult:
    status: str            # posted | replayed | insufficient | in_debt | inactive | frozen
    from_balance: int
    transfer_id: int | None
    repay_transfer_id: int | None

    @property
    def posted(self) -> bool:
        return self.status == "posted"


@dataclass(frozen=True)
class ClawbackResult:
    status: str            # posted | replayed
    clawed: int            # m2Z taken from what was available
    debt_added: int        # m2Z put on user_debt
    balance: int


@dataclass(frozen=True)
class RefundResult:
    status: str            # posted | replayed
    clawed: int
    debt_added: int
    balance: int
    refunded_m2z: int      # the purchase's cursor after this event


@dataclass(frozen=True)
class RestoreResult:
    status: str            # posted | replayed | nothing_to_restore (key NOT consumed: retry after the clawback lands)
    restored: int
    debt_repaid: int
    balance: int
    transfer_id: int | None
    repay_transfer_id: int | None
    refunded_m2z: int


@dataclass(frozen=True)
class LockedCreator:
    """``ledger.lock_creator``: the creator row, locked ``FOR NO KEY UPDATE``.
    ``balance`` is its ``tuzis`` (2Z, Decimal) as read under that lock."""
    id: int
    balance: Decimal
    is_active: bool


@dataclass(frozen=True)
class AccountRow:
    """A maintained ``user`` account after ``ledger.lock_account`` (opened,
    locked, healed). ``available`` is what a spend may take."""
    id: int
    balance: int
    held: int
    frozen: bool

    @property
    def available(self) -> int:
        return self.balance - self.held


@dataclass(frozen=True)
class PostResult:
    transfer_id: int | None
    status: str            # posted | replayed | insufficient | frozen

    @property
    def posted(self) -> bool:
        return self.status == "posted"


@dataclass(frozen=True)
class CreditLegs:
    """``ledger.credit_with_repay``: the split of one credit into the leg that
    met the owner's debt and the leg that reached the spendable balance."""
    credited: int
    debt_repaid: int
    transfer_id: int | None
    repay_transfer_id: int | None


# ------------------------------------------------------------------ accounts


def lock_creator(creator_id: int) -> LockedCreator | None:
    """LOCK 1 (§6): the creator row, ``FOR NO KEY UPDATE``, and its current
    ``tuzis`` read under that lock. ``None`` when there is no such creator.
    Must run inside ``transaction.atomic()`` -- the lock is what the rest of
    the caller's transaction relies on."""
    row = _call("lock_creator", int(creator_id))
    if row is None or row[0] is None:
        return None
    return LockedCreator(id=int(row[0]), balance=Decimal(row[1]), is_active=bool(row[3]))


@prepared_writer
def lock_account(creator_id: int, tuzis) -> AccountRow:
    """LOCK 2: open the creator's ``user`` account if needed, lock it, and
    run the rollout self-heal against ``tuzis`` (§10 step 3). Precondition:
    the caller holds the creator lock (:func:`lock_creator`) and ``tuzis`` is
    the value read under it."""
    _count()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, balance, held, frozen FROM ledger.lock_account(%s, %s)",
            [int(creator_id), Decimal(tuzis)],
        )
        row = cursor.fetchone()
    return AccountRow(id=int(row[0]), balance=int(row[1]), held=int(row[2]), frozen=bool(row[3]))


def account_row(account_id: int) -> AccountRow:
    """Re-read a maintained account this transaction already locked."""
    _count()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, balance, held, frozen FROM ledger_account WHERE id = %s", [int(account_id)],
        )
        row = cursor.fetchone()
    if row is None:
        raise LookupError(f"no ledger account {account_id}")
    return AccountRow(id=int(row[0]), balance=int(row[1]), held=int(row[2]), frozen=bool(row[3]))


def system_account_id(key: str) -> int:
    """``ledger.sys``: a ``sys:*`` account's id; raises on an unknown key."""
    return int(_scalar("sys", key))


@prepared_writer
def ensure_account(creator_id: int) -> int:
    """Open the creator's ``user`` account if it does not exist; return its id.

    Takes the creator lock first (§4.2: ``ensure_account`` must run under
    it, so the opening balance is consistent with every other writer), so
    this is two statements and runs in its own ``atomic`` block when the
    caller has none.
    """
    with transaction.atomic():
        row = _call("lock_creator", int(creator_id))
        if row is None or row[0] is None:
            raise LookupError(f"no creator {creator_id}")
        return _scalar("ensure_account", int(creator_id))


def user_account_id(creator_id: int) -> int | None:
    """The creator's ``user`` account id, or ``None`` if not opened yet."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id FROM ledger_account WHERE key = %s", [f"user:{int(creator_id)}"],
        )
        row = cursor.fetchone()
    return row[0] if row else None


def debt_m2z(creator_id: int) -> int:
    """The creator's outstanding debt in m2Z (``>= 0``)."""
    return int(_scalar("debt", int(creator_id)))


@dataclass(frozen=True)
class BalanceView:
    """What the next spend would see, read without writing (zuu
    ``docs/free2z/sdk/spec/purchase.md`` §1.1). Every number is m2Z, ``>= 0``."""
    balance: int           # holds included
    held: int
    debt: int
    as_of: datetime.datetime

    @property
    def available(self) -> int:
        """§1.1: ``balance - held``, and ``0`` while there is any debt."""
        if self.debt > 0:
            return 0
        return max(self.balance - self.held, 0)


def read_balance(creator_id: int) -> BalanceView | None:
    """The creator's balance, held and debt, as ONE read-only statement.

    ``None`` when there is no such creator. Unlike:func:`lock_account` this
    opens nothing, locks nothing and heals nothing: it is what ``GET
    /api/sdk/v1/balance`` answers, and a GET must not write (the
    URL-write guard's Rule B; ``ensure_account`` is a ``SELECT`` of a
    function that INSERTs, which that guard cannot see, so the rule is kept
    here by construction and pinned by a test that runs this inside a
    ``READ ONLY`` transaction).

    It reports exactly what the next spend's ``lock_account`` would act on:

    * **No account yet** -- ``ensure_account`` would open it at
      ``tuzis * 1000`` with nothing held, so that is the balance. Debt is
      still read (``ledger.debt`` is 0 without a ``user_debt`` account).
    * **Account, heal active** (``dual_write AND heal_enabled``, the
      rollout window) -- ``heal_balance`` would first set the balance to
      ``tuzis * 1000`` and, if that raised it, repay debt from the raise up
      to what is not held. The same arithmetic is applied here to the
      numbers, never to the rows. Under dual-write the two agree and this is
      the identity; it matters only for a balance a legacy writer moved.
    * **Account, heal off** -- the ledger's own ``balance`` and ``held``.

    One statement, so the creator row, the account, the debt account and
    the config are one snapshot (a STABLE function sees its caller's).
    """
    _count()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT (c.tuzis * 1000)::bigint, a.balance, a.held, ledger.debt(c.id),"
            "       coalesce(cfg.dual_write AND cfg.heal_enabled, false), statement_timestamp()"
            "  FROM g12f_creator c"
            "  LEFT JOIN ledger_account a ON a.key = 'user:' || c.id"
            "  LEFT JOIN ledger_config cfg ON cfg.id"
            " WHERE c.id = %s",
            [int(creator_id)],
        )
        row = cursor.fetchone()
    if row is None:
        return None
    tuzis_m2z, balance, held, debt, heal, as_of = row
    tuzis_m2z, debt = int(tuzis_m2z), int(debt)
    if balance is None:
        balance, held = tuzis_m2z, 0
    else:
        balance, held = int(balance), int(held)
        if heal and tuzis_m2z != balance:
            delta = tuzis_m2z - balance
            balance = tuzis_m2z
            if delta > 0 and debt > 0:
                repay = max(min(debt, delta, balance - held), 0)
                balance -= repay
                debt -= repay
    return BalanceView(balance=max(balance, 0), held=max(held, 0), debt=max(debt, 0), as_of=as_of)


# ------------------------------------------------------------------ posting
#
# The two internal primitives a Django caller composes with when no public
# function has the shape it needs -- the reservation legs of §10 step 2
# (`user -> sys:reservation_clearing` and back), which are neither a spend
# (the credits are not revenue yet) nor a credit from a system account.
# Preconditions are the SQL functions' own (§4.3): the caller has taken the
# creator lock and `lock_account` on every maintained account involved.


@prepared_writer
def post_transfer(debit_account_id: int, credit_account_id: int, amount_m2z: int,
                  code: str, ref_kind: str, ref_id: str, idem: str | None = None,
                  meta: dict | None = None) -> PostResult:
    """``ledger.post_transfer`` (§4.3). Statuses returned, never raised."""
    _count()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT transfer_id, status FROM ledger.post_transfer(%s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
            [int(debit_account_id), int(credit_account_id), int(amount_m2z), code,
             ref_kind or "", str(ref_id or ""), idem, json.dumps(meta) if meta is not None else None],
        )
        row = cursor.fetchone()
    return PostResult(transfer_id=row[0], status=row[1])


def credit_with_repay(source_account_id: int, creator_id: int, amount_m2z: int,
                      code: str, ref_kind: str, ref_id: str) -> CreditLegs:
    """``ledger.credit_with_repay`` (§5.7): ``source -> user_debt`` for
    ``least(debt, amount)`` and ``source -> user`` for the rest, unkeyed.
    The caller holds the creator and account locks."""
    row = _call("credit_with_repay", int(source_account_id), int(creator_id), int(amount_m2z),
                code, ref_kind or "", str(ref_id or ""))
    return CreditLegs(*row)


def has_transfer(code: str, ref_kind: str, ref_id: str, around: datetime.datetime,
                 window: datetime.timedelta = datetime.timedelta(days=1)) -> bool:
    """Whether a ``(code, ref_kind, ref_id)`` transfer exists within ``window``
    of ``around`` -- bounded on ``created_at`` so the lookup is pruned to one
    or two partitions (§10 step 2: telling a journaled reservation from one
    a pre-rollout pod made)."""
    _count()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM ledger_transfer WHERE ref_kind = %s AND ref_id = %s AND code = %s "
            "  AND created_at >= %s AND created_at < %s LIMIT 1",
            [ref_kind, str(ref_id), code, around - window, around + window],
        )
        return cursor.fetchone() is not None


# ------------------------------------------------------------------ rollout config

_dual_write_since_stamped = False


@prepared_writer
def stamp_dual_write_since() -> None:
    """Stamp ``ledger_config.dual_write_since`` on this release's first
    ledger write (§10 step 2: the baseline for the per-rail checks, R11).

    One ``UPDATE... WHERE dual_write_since IS NULL`` per process, issued
    **after the money transaction commits** (``transaction.on_commit``; at
    once in autocommit), as its own statement holding no other lock. Inside
    the money transaction it would take the singleton row's lock while the
    caller still holds creator rows -- and a second process doing the same
    in the first-write window, with the FK ``KEY SHARE`` an Event insert
    takes at commit, closes a cycle Postgres resolves by killing a money
    transaction. Issued after commit it
    can block only on another process's stamp, for the length of one
    single-row UPDATE. A rolled-back first write never reaches it, so the
    stamp is left to the next one. Call after a ``posted`` status.

    ``robust=True``: the stamp runs after the money has committed, so a
    failure in it (a dropped connection, a statement timeout) must never
    surface as the caller's error -- a 500 on a donation whose transfer
    already committed invites a retry that charges twice (codex round 6).
    Django logs the exception; the next successful write stamps.
    """
    if _dual_write_since_stamped:
        return

    def _stamp():
        global _dual_write_since_stamped
        if _dual_write_since_stamped:
            return
        _count()
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE ledger_config SET dual_write_since = now() WHERE id AND dual_write_since IS NULL",
            )
        _dual_write_since_stamped = True

    transaction.on_commit(_stamp, robust=True)


def forget_dual_write_since_stamp() -> None:
    """Test hook: the per-process memo above survives a test's rollback."""
    global _dual_write_since_stamped
    _dual_write_since_stamped = False


# ------------------------------------------------------------------ spending


def spend(creator_id: int, amount_m2z: int, action: str, ref_id: str = "",
          idem: str | None = None) -> SpendResult:
    """``user -> sys:platform_revenue`` (§5.7). Refuses with a status while
    the owner is in debt, frozen, or short of ``balance - held``. ``idem`` is
    optional; an empty string is refused (it would be one key shared by
    every caller)."""
    if idem == "":
        raise ValueError("an idempotency key must not be empty; pass None for an unkeyed spend")
    row = _call("spend", int(creator_id), int(amount_m2z), action, ref_id or "", idem)
    return SpendResult(*row)


def spend_up_to(creator_id: int, amount_m2z: int, action: str, ref_id: str = "") -> SpendUpToResult:
    """Charge ``min(amount, balance - held)``; ``charged == 0`` in debt or frozen."""
    row = _call("spend_up_to", int(creator_id), int(amount_m2z), action, ref_id or "")
    return SpendUpToResult(*row)


def transfer_users(from_creator_id: int, to_creator_id: int, amount_m2z: int,
                   action: str, ref_id: str, idem: str) -> TransferResult:
    """``user -> user`` with the recipient's debt repaid first (§5.7).
    Locks both creators in pk order; ``inactive`` when the recipient is
    deactivated."""
    row = _call("transfer_users", int(from_creator_id), int(to_creator_id), int(amount_m2z),
                action, ref_id or "", idem)
    return TransferResult(*row)


# ------------------------------------------------------------------ credits


def credit_user(creator_id: int, amount_m2z: int, source_key: str, code: str,
                ref_kind: str, ref_id: str, idem: str) -> CreditResult:
    """A promo / refund / PPV-cut credit from a system account (never a
    purchase); ``code`` is ``grant``, ``refund`` or ``transfer``. Repays
    the owner's debt first. ``idem`` is required and replays return what the
    original did."""
    row = _call("credit_user", int(creator_id), int(amount_m2z), source_key, code,
                ref_kind, str(ref_id), idem)
    return CreditResult(*row)


def credit_purchase(creator_id: int, amount_m2z: int, rail: str, ref_kind: str,
                    ref_id: str, idem: str) -> CreditResult:
    """``sys:clearing_<rail> -> user`` for a purchase receipt, debt repaid
    first, and the purchase's refund cursor written (§5.8)."""
    if rail not in PURCHASE_RAILS:
        raise ValueError(f"unknown purchase rail {rail!r}")
    row = _call("credit_purchase", int(creator_id), int(amount_m2z), rail, ref_kind, str(ref_id), idem)
    return CreditResult(*row)


# ------------------------------------------------------------------ clawbacks


def clawback(creator_id: int, amount_m2z: int, counter_key: str, code: str, reason: str,
             ref_kind: str, ref_id: str, idem: str, freeze: bool = False) -> ClawbackResult:
    """Take what is available and put the rest on ``user_debt`` (§5.8).
    ``code`` is ``clawback`` (counter ``sys:clearing_<rail>``) or
    ``markup_reversal`` (counter ``sys:markup_reversal``, §5.9)."""
    if not idem:
        raise ValueError("clawback requires an idempotency key")
    row = _call("clawback", int(creator_id), int(amount_m2z), counter_key, code, reason,
                ref_kind, str(ref_id), idem, bool(freeze))
    return ClawbackResult(*row)


def refund_purchase(creator_id: int, ref_kind: str, ref_id: str, target_m2z: int,
                    reason: str, idem: str, freeze: bool = False) -> RefundResult:
    """Claw back the delta to a per-purchase cumulative ``target_m2z``
    (§5.8). A pro-rata refund passes ``floor(credited x amount_refunded /
    amount_captured)``; a dispute passes the full credited amount with
    ``freeze=True``. Reordered or repeated events cannot over-claw."""
    row = _call("refund_purchase", int(creator_id), ref_kind, str(ref_id), int(target_m2z),
                reason, idem, bool(freeze))
    return RefundResult(*row)


def restore_purchase(creator_id: int, ref_kind: str, ref_id: str, target_m2z: int,
                     idem: str) -> RestoreResult:
    """A dispute won: re-credit down to ``target_m2z`` on the cursor (code
    ``restore``, debt repaid first). Does not unfreeze."""
    row = _call("restore_purchase", int(creator_id), ref_kind, str(ref_id), int(target_m2z), idem)
    return RestoreResult(*row)


__all__ = [
    "M2Z_PER_2Z", "to_m2z", "from_m2z", "clearing_account_key",
    "SpendResult", "SpendUpToResult", "CreditResult", "TransferResult",
    "ClawbackResult", "RefundResult", "RestoreResult",
    "LockedCreator", "AccountRow", "PostResult", "CreditLegs",
    "ensure_account", "user_account_id", "debt_m2z",
    "lock_creator", "lock_account", "account_row", "system_account_id",
    "post_transfer", "credit_with_repay", "has_transfer",
    "stamp_dual_write_since", "forget_dual_write_since_stamp",
    "spend", "spend_up_to", "transfer_users",
    "credit_user", "credit_purchase",
    "clawback", "refund_purchase", "restore_purchase",
]
