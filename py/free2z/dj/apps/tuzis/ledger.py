"""Atomic, race-safe primitives for moving 2Z credits between Creators.

Why this module exists
-----------------------------------
Every 2Z money path used to be a read-modify-write against an in-memory
``Creator`` instance::

    if user.tuzis < amt:            # read  (transaction A and B both pass)
        return error
    user.tuzis -= amt               # modify in Python
    user.save(update_fields=['tuzis'])   # write: clobbers the other writer

Two concurrent requests both read the same balance, both pass the check, and
the last write wins -- so the user spends the same 2Z twice (double-spend) and
the balance can be driven negative. ``save(update_fields=...)`` also skips
model validators, so ``MinValueValidator(0)`` on ``Creator.tuzis`` never ran.

The fix, then and now
---------------------
All mutations go through a single conditional ``UPDATE``, evaluated by
Postgres after it takes the row lock (READ COMMITTED EvalPlanQual re-check),
so a concurrent debit that would overdraw matches zero rows. The affected-row
count is the authoritative answer to "did this debit happen?" -- we never
trust a value read in Python. A ``CHECK (tuzis >= 0)`` constraint (migration
g12f/0086) is the belt to this suspenders.

Since the dual-write release (docs/tuzis/ledger-v2.md §10 steps 2-3, )
that ``UPDATE`` lives inside the double-entry ledger's SQL functions
(``dj.apps.ledger``, L1). Every primitive here is a thin wrapper:

* ``debit``         -> ``ledger.spend``          (``user -> sys:platform_revenue``)
* ``debit_up_to``   -> ``ledger.spend_up_to``    (clamped to ``balance - held``)
* ``credit``        -> ``ledger.credit_purchase`` (a purchase rail) or
                       ``ledger.credit_user``     (promo / refund / PPV cut)
* ``transfer``      -> ``ledger.transfer_users``
* ``reserve`` / ``settle_reservation`` / ``release_reservation`` use L2
  holds. Existing ``ProviderReservation`` rows retain their legacy recovery
  path through ``sys:reservation_clearing`` until drained.

Each function locks the creator row first (§6, the lock-class root that
``lock_in_order`` also takes), opens the creator's ledger account lazily,
heals any drift an old pod left behind (§10 step 3), and posts a journal row.
``post_transfer``'s dual-write projection is what moves ``Creator.tuzis``:
**nothing in this module writes the column itself any more**, and
``tuzis/test_ledger_only_balance_writers.py`` now scans this file too.

Throughout the rollout ``Creator.tuzis`` remains the number users see and the
API returns; the ledger is the shadow being proven (R1-R3, ``reconcile_ledger``).
Callers pass a live ``Creator`` instance; its in-memory ``tuzis`` attribute is
refreshed to the post-mutation database value so existing code that returns
``user.tuzis`` in a response body keeps working.
"""
from __future__ import annotations

import uuid
from decimal import Decimal, InvalidOperation

from django.db import connection, transaction
from django.utils import timezone

from dj.apps.ledger import api as _ledger
from dj.apps.economy.epoch import pin_supported_policy, prepared_writer

# Creator.tuzis is DecimalField(max_digits=17, decimal_places=3).
TUZI_EXPONENT = Decimal("0.001")
RESERVATION_ACTIVE = "active"
RESERVATION_SETTLED = "settled"
RESERVATION_RELEASED = "released"

#``credit()``'s vocabulary: what a ``ref_kind`` IS decides which ledger
#function posts it and with which code (§10.1). A purchase (a receipt on a
#rail) goes through ``credit_purchase`` and writes the refund cursor; every
#other credit goes through ``credit_user``. A seventh caller has to add its
#kind here -- an unknown kind is refused, never guessed, because an
#unattributable credit is exactly what the journal exists to prevent (R11).
CREDIT_CODES: dict[str, str] = {
    "stripe_transaction": "purchase",   # ztripe/fulfillment.py
    "zec_receipt": "purchase",          # tuzis/zec.py
    "tuzi_grant": "grant",              # tuzis/grants.py (grant_tuzis, welcome)
    "comment_score": "grant",           # aiscore_comments
    "translation": "refund",            # g12f/translation/charges.py
    "ppv": "transfer",                  # dyte/views.py, the creator's cut
}

_CLEARING_PREFIX = "sys:clearing_"
_RESERVATION_CLEARING = "sys:reservation_clearing"
_PLATFORM_REVENUE = "sys:platform_revenue"
_OPENING_EQUITY = "sys:opening_equity"


class InsufficientFunds(Exception):
    """Raised when a debit would take a Creator's balance below zero.

    Raised *after* the ledger function reported a refusal, so it is a
    statement of fact about the database, not about a stale in-memory read.
    ``balance`` is what the function said was spendable (``available``).
    """

    def __init__(self, creator, amount: Decimal, *, balance=None, action=None):
        self.creator = creator
        self.amount = amount
        self.balance = balance if balance is not None else creator.tuzis
        self.action = action
        super().__init__(
            f"{creator} has insufficient 2Z for a debit of {amount}"
        )


class ExpectedPriceMismatch(Exception):
    """The locked current price differs from the amount the payer approved."""

    def __init__(self, expected: Decimal, current: Decimal | None):
        self.expected = expected
        self.current = current
        super().__init__(
            f"expected subscription price {expected}, current price is {current}"
        )


class InactiveCreator(Exception):
    """Raised when a public money transfer targets a deactivated creator."""


def to_tuzis(amount) -> Decimal:
    """Coerce an amount to the Decimal precision the column actually stores.

    Floats, ints and strings all arrive here from request bodies. Quantizing
    up front means the value we validate is the value we persist -- no silent
    rounding between the ``>=`` check and the write.
    """
    if isinstance(amount, float):
        # str() first: Decimal(0.1) is 0.1000000000000000055511151231257827
        amount = str(amount)
    try:
        value = Decimal(amount)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"Not a valid 2Z amount: {amount!r}") from exc
    if not value.is_finite():
        raise ValueError(f"Not a valid 2Z amount: {amount!r}")
    try:
        return value.quantize(TUZI_EXPONENT)
    except (InvalidOperation, ValueError, OverflowError) as exc:
        raise ValueError(f"Not a valid 2Z amount: {amount!r}") from exc


def _sync(creator) -> Decimal:
    creator.refresh_from_db(fields=["tuzis"])
    return creator.tuzis


def _spendable(available_m2z) -> Decimal:
    """``available`` as a 2Z balance for the wire. Never negative: a downward
    heal under a hold (§10 step 3) can leave ``balance < held``, and a
    negative "balance" in a 402 body would only confuse."""
    return _ledger.from_m2z(max(int(available_m2z or 0), 0))


def _posted() -> None:
    _ledger.stamp_dual_write_since()


def debit(creator, amount, *, action=None, idem=None) -> Decimal:
    """Atomically subtract ``amount`` from ``creator``'s balance.

    Returns the new balance. Raises ``InsufficientFunds`` (and mutates
    nothing) if the balance is smaller than ``amount``. ``idem`` is optional:
    a keyed debit replays (returns the balance, moves nothing) on a repeat.
    """
    amount = to_tuzis(amount)
    if amount < 0:
        raise ValueError("debit amount must not be negative")
    if amount == 0:
        return _sync(creator)

    result = _ledger.spend(creator.pk, _ledger.to_m2z(amount), action or "", "", idem)
    if result.status == "posted":
        _posted()
    elif result.status != "replayed":
        # insufficient | in_debt | frozen: the account cannot spend, and the
        # wire contract has one word for that. Debt and freezes do not
        # exist until clawbacks do (§5.8), so today this is `insufficient`.
        _sync(creator)
        raise InsufficientFunds(
            creator, amount, balance=_spendable(result.available), action=action
        )
    return _sync(creator)


def debit_up_to(creator, amount, *, action=None) -> Decimal:
    """Debit at most ``amount``, clamped to the available balance.

    For fire-and-forget metering (livestream platform fees charged from a
    webhook) where refusing the charge outright is worse than collecting what
    is there: the session already happened. Returns the amount actually
    debited, which may be ``0``.

    ``ledger.spend_up_to`` reads "how much is available" under the creator
    lock, so the answer cannot go stale between the read and the write.
    """
    amount = to_tuzis(amount)
    if amount <= 0:
        return Decimal("0")

    result = _ledger.spend_up_to(creator.pk, _ledger.to_m2z(amount), action or "", "")
    if result.charged > 0:
        _posted()
    _sync(creator)
    return _ledger.from_m2z(result.charged)


def credit(creator, amount, *, source, ref_kind, ref_id, idem) -> Decimal:
    """Atomically add ``amount`` to ``creator``'s balance. Returns the new balance.

    All four keywords are required (§10 step 2): a credit with no source
    account, no receipt reference and no idempotency key cannot be attributed
    (R11) or replayed. ``source`` is the ``sys:*`` account the credits come
    from (``sys:clearing_<rail>`` for a purchase, ``sys:promo`` for a grant,
    ``sys:platform_revenue`` for a refund or a PPV cut); ``ref_kind`` names
    the receipt's kind (see ``CREDIT_CODES``) and ``ref_id`` its id; ``idem``
    is the operation's key -- a repeat with the same key returns the balance
    and moves nothing. The owner's debt, if any, is repaid first (§5.7).
    """
    amount = to_tuzis(amount)
    if amount < 0:
        raise ValueError("credit amount must not be negative")
    if amount == 0:
        return _sync(creator)
    if not idem:
        raise ValueError("credit requires an idempotency key")
    try:
        code = CREDIT_CODES[ref_kind]
    except KeyError:
        raise ValueError(
            f"unknown credit ref_kind {ref_kind!r}; register it in "
            "dj.apps.tuzis.ledger.CREDIT_CODES with the ledger code it posts under"
        ) from None
    m2z = _ledger.to_m2z(amount)
    if code == "purchase":
        if not source.startswith(_CLEARING_PREFIX):
            raise ValueError(f"a {ref_kind} credit comes from a purchase rail, not {source!r}")
        result = _ledger.credit_purchase(
            creator.pk, m2z, source[len(_CLEARING_PREFIX):], ref_kind, str(ref_id), idem,
        )
    else:
        if source.startswith(_CLEARING_PREFIX):
            raise ValueError(f"a {ref_kind} credit is not a purchase; {source!r} is a rail")
        result = _ledger.credit_user(creator.pk, m2z, source, code, ref_kind, str(ref_id), idem)
    if result.status == "posted":
        _posted()
    return _sync(creator)


def transfer(sender, recipient, amount, *, action=None, idem=None) -> Decimal:
    """Move ``amount`` from ``sender`` to ``recipient`` as one transaction.

    Either both sides move or neither does. Raises ``InsufficientFunds`` if the
    sender cannot cover it -- nothing is credited in that case -- and
    ``InactiveCreator`` if the recipient is deactivated (checked with both
    rows locked, so deactivation cannot commit between the check and the
    credit).

    ``ledger.transfer_users`` locks both creator rows in primary-key order,
    which is what stops A-pays-B racing B-pays-A from deadlocking, and admits
    the whole operation before posting a leg. ``idem`` is optional: without
    one every call is its own operation, exactly as before.
    """
    amount = to_tuzis(amount)
    if amount <= 0:
        raise ValueError("transfer amount must be positive")
    if sender.pk == recipient.pk:
        raise ValueError("cannot transfer 2Z to yourself")

    key = idem or f"transfer:{uuid.uuid4()}"
    result = _ledger.transfer_users(
        sender.pk, recipient.pk, _ledger.to_m2z(amount), action or "", "", key,
    )
    if result.status == "inactive":
        raise InactiveCreator(recipient)
    if result.status == "posted":
        _posted()
    elif result.status != "replayed":
        # `transfer_users` returns the sender's balance, not what is
        # spendable; read `available` off the (opened, healed) account so
        # the 402 body says the same thing `debit`'s does once holds exist.
        _sync(sender)
        available = _ledger.account_row(_ledger.user_account_id(sender.pk)).available
        raise InsufficientFunds(
            sender, amount, balance=_spendable(available), action=action
        )
    _sync(recipient)
    return _sync(sender)


def insufficient_funds_payload(creator, amount=None, *, action=None) -> dict:
    """Return the stable wire contract for a refused 2Z debit.

    ``creator`` may be an ``InsufficientFunds`` instance. In that case its
    balance is what the ledger function reported as spendable when it
    refused, so the payload reports the authoritative balance even when
    another request won a race with this one. The values are strings so direct
    DRF ``Response`` inspection and JSON rendering expose the same
    three-decimal wire contract.
    """
    if isinstance(creator, InsufficientFunds):
        failure = creator
        creator = failure.creator
        amount = failure.amount
        action = action or failure.action
        balance = failure.balance
    else:
        amount = to_tuzis(amount)
        # Callers use this helper for admission checks as well as caught
        # debits. Refresh those checks from the database so their displayed
        # balance is not an old in-memory value.
        balance = _sync(creator)

    balance = to_tuzis(balance)

    amount = to_tuzis(amount)
    return {
        "code": "insufficient_funds",
        "cost": str(amount),
        "balance": str(balance),
        "shortfall": str(max(Decimal("0"), amount - balance)),
        "action": action or "unknown",
    }


def lock_in_order(*creators) -> None:
    """Take row locks on ``creators`` in primary-key order, up front.

    For a multi-step settlement that touches more than one balance and cannot
    express itself as a single ``transfer`` -- the dyte pay-per-view flow debits
    a platform fee, then moves the creator's cut, then writes Events.

    Ordering matters because a deadlock is decided by the order locks are
    ACQUIRED across the whole transaction, not per statement. The PPV block
    touched the participant first and the creator second no matter what their
    ids were; a fan leaving a PPV stream while donating to that same creator
    (``transfer`` locks in pk order) grabbed the two rows in opposite orders
    and one of them died with a Postgres deadlock. Every writer that touches
    two balances in one transaction must acquire in the same order, so grab
    them all here first and the rest of the transaction can proceed freely.

    The order is **Creator rows (by pk) first, then whatever else the
    transaction locks** -- a zPage, a Comment, an Event. That is why a SINGLE
    creator is locked here too, rather than skipped as "nothing to order":
    the ordering hazard is not only Creator-vs-Creator. zPage vote took the
    page row and then the voter's balance; zPage fund took the balance and
    then the page row; the same user voting while funding deadlocked on a
    money path. The translation purchase had the same inversion
    (page, then the buyer's balance) and deadlocked against the reordered
    vote. A writer that locks its one Creator row up front and only
    then touches the target follows the same order as ``transfer`` and every
    other caller here, and cannot form that cycle. The price for the
    single-row case is one ``SELECT... FOR NO KEY UPDATE`` the debit would
    have taken a statement later anyway.

    Every 2Z spend on a zPage (vote, fund, translation), every comment vote,
    every AI comment score, and every balance transfer takes this order. It is
    the order a new writer should take for these paths, not a universal proof
    about every money writer. Other paths have separate lock classes: a
    subscription extension locks its Subscription before the balance rows,
    and a translation refund locks its IdempotencyKey before crediting.

    The lock is ``FOR NO KEY UPDATE`` (``no_key=True``), not ``FOR UPDATE``,
    and the difference is a deadlock of its own. A balance ``UPDATE`` only
    takes NO KEY UPDATE, which is what serializes balance writers against
    each other -- and it is *compatible* with the ``FOR KEY SHARE`` that a
    foreign key referencing the row takes when the referencing row is
    inserted (at commit, since Django's FKs are deferred). ``FOR UPDATE``
    is not. A voter's first vote inserts the page owner's ``PAGE_VOTE``
    Event; had the owner funding their own page held plain ``FOR UPDATE``
    on their row while waiting for the page row the voter holds, the
    voter's commit would have waited on the owner and Postgres would have
    killed one of them -- a cycle the plain UPDATE could never form (codex
    review of ). Taking exactly the strength the ledger's writes take
    orders them without adding a conflict they did not have. The ledger's
    own ``lock_creator`` (§4.1) takes the same strength, so a caller that
    locks here and then calls a ledger function re-acquires a lock it holds.

    ``ORDER BY pk... FOR NO KEY UPDATE`` is what makes the acquisition
    order deterministic; the rows must actually be consumed for the locks to
    be taken, hence the ``list()``.

    Must be called inside ``transaction.atomic()`` -- locks are released at
    commit, so outside one it locks and unlocks immediately and protects
    nothing.
    """
    from dj.apps.g12f.models import Creator

    pin_supported_policy()
    pks = {c.pk for c in creators if c is not None and c.pk is not None}
    if not pks:
        return
    list(
        Creator.objects.filter(pk__in=pks)
        .order_by("pk")
        .select_for_update(no_key=True)
        .values_list("pk", flat=True)
    )


# ------------------------------------------------------------ reservations
#
# A reservation moves the reserved amount OUT of `Creator.tuzis` (unlike the
# L2 hold, which will not), journaled as `user -> sys:reservation_clearing`
# (`spend / reservation / <pk>`). Settling posts `sys:reservation_clearing ->
# sys:platform_revenue` for the same amount; releasing posts
# `sys:reservation_clearing -> user` (`refund`). So every reservation ends
# with the clearing account back at zero for that row, and
# `journal(sys:reservation_clearing) == sum(active journaled reservations)`
# at all times (R13).
#
# A reservation that PREDATES the journal -- made by a pod running the old
# code, whose reserve() subtracted `tuzis` with no ledger entry -- has nothing
# in reservation_clearing to release from, and its amount is already absent
# from the account's opening balance. `_journaled()` tells the two apart by
# looking for its `spend / reservation / <pk>` transfer: for an un-journaled
# row, release posts `sys:opening_equity -> user` with code
# `reservation_import` (the credits re-enter the ledger the same way the
# opening balance did) and settle posts nothing (the charge is already inside
# opening equity). Without that branch every stale pre-rollout reservation
# would leave reservation_clearing permanently negative by its amount.


def _journaled(row) -> bool:
    return _ledger.has_transfer("spend", "reservation", str(row.pk), around=row.created_at)


def _post_release(creator_id: int, row) -> None:
    """Return a reservation's credits to the user, repaying debt first.
    Precondition: the creator and its user account are locked."""
    m2z = _ledger.to_m2z(row.amount)
    if _journaled(row):
        source, code = _RESERVATION_CLEARING, "refund"
    else:
        source, code = _OPENING_EQUITY, "reservation_import"
    _ledger.credit_with_repay(
        _ledger.system_account_id(source), creator_id, m2z, code, "reservation", str(row.pk),
    )
    _posted()


@prepared_writer
def reserve(creator, amount, *, scope, operation_key):
    """Authorize a fixed provider charge without holding a DB lock on I/O.

    L2 raises held credits without reducing the total balance. Another
    request cannot spend them. Existing legacy rows are recovered in place;
    no old reservation is copied into a second hold.
    """
    from dj.apps.tuzis.models import ProviderReservation, STALE_CLAIM

    amount = to_tuzis(amount)
    if amount <= 0:
        raise ValueError("reservation amount must be positive")
    m2z = _ledger.to_m2z(amount)
    now = timezone.now()
    cutoff = now - STALE_CLAIM
    with transaction.atomic():
        locked = _ledger.lock_creator(creator.pk)                      # LOCK 1
        if locked is None:
            raise InsufficientFunds(creator, amount, balance=Decimal("0"))
        account = _ledger.lock_account(locked.id, locked.balance)        # LOCK 2 (+ heal)

        # A killed request cannot leave an authorization hold indefinitely.
        stale = list(
            ProviderReservation.objects.select_for_update().filter(
                user_id=locked.id,
                status=RESERVATION_ACTIVE,
                created_at__lt=cutoff,
            )
        )
        if stale:
            for row in stale:
                _post_release(locked.id, row)
            ProviderReservation.objects.filter(
                pk__in=[row.pk for row in stale],
                status=RESERVATION_ACTIVE,
            ).update(status=RESERVATION_RELEASED, finished_at=now)
            account = _ledger.account_row(account.id)

        existing = (
            ProviderReservation.objects.select_for_update()
            .filter(
                scope=scope,
                user_id=locked.id,
                operation_key=operation_key,
                status=RESERVATION_ACTIVE,
            )
            .first()
        )
        if existing is not None:
            return existing

        from dj.apps.ledger import holds

        logical_key = f'{scope}:{operation_key}'
        with connection.cursor() as cursor:
            cursor.execute('SELECT public_id FROM g12f_creator WHERE id=%s', [locked.id])
            subject = cursor.fetchone()[0]
            cursor.execute('SELECT idem FROM ledger_hold WHERE app_id=%s AND account_id=%s '
                           'AND logical_key=%s AND expires_at>now()',
                           [holds.FIRST_PARTY_APP_ID, account.id, logical_key])
            active = cursor.fetchone()
        # A released/expired attempt may be retried, but an active attempt
        # replays its hold and a settled logical call can never charge again.
        key = active[0] if active else str(uuid.uuid4())
        held = holds.call('hold_internal', subject, holds.FIRST_PARTY_APP_ID,
                          m2z, key, logical_key, 0, int(STALE_CLAIM.total_seconds()))
        if held['status'] not in {'held', 'replayed'} or held['state'] != 'open':
            raise InsufficientFunds(creator, amount,
                                    balance=_spendable(held['available'] or 0), action=scope)
        _posted()
        return holds.HoldReservation(held['hold_id'], locked.id,
                                     _spendable(held['amount']), scope)


@prepared_writer
def settle_reservation(reservation, *, amount=None) -> None:
    """Consume an L2 hold at a fixed charge, or finalize a legacy row.

    A partial collection raises within the transaction so a caller never
    returns a successful paid result after collecting less than its price.
    """
    if reservation is None:
        return
    from dj.apps.ledger import holds
    if isinstance(reservation, holds.HoldReservation):
        charge = reservation.amount if amount is None else to_tuzis(amount)
        with transaction.atomic():
            result = holds.call('settle_fixed', reservation.pk, _ledger.to_m2z(charge))
            if result['status'] != 'settled' or result['charged'] != _ledger.to_m2z(charge):
                from dj.apps.g12f.models import Creator
                creator = Creator.objects.get(pk=reservation.user_id)
                raise InsufficientFunds(creator, charge,
                                        balance=_spendable(result['available'] or 0), action=reservation.scope)
            _posted()
        return
    if amount is not None:
        # A mixed-fleet retry may find an old active reservation. Keep its
        # original release/debit semantics; never convert it into an L2 hold.
        with transaction.atomic():
            release_reservation(reservation)
            debit(reservation.user, amount, action=reservation.scope)
        return
    from dj.apps.tuzis.models import ProviderReservation

    now = timezone.now()
    with transaction.atomic():
        row = ProviderReservation.objects.filter(pk=reservation.pk).first()
        if row is None:
            return
        affected = ProviderReservation.objects.filter(
            pk=row.pk, status=RESERVATION_ACTIVE
        ).update(status=RESERVATION_SETTLED, finished_at=now)
        if not affected or not _journaled(row):
            # Already terminal, or a pre-rollout reservation whose charge is
            # already inside opening equity: nothing to move.
            return
        _ledger.post_transfer(
            _ledger.system_account_id(_RESERVATION_CLEARING),
            _ledger.system_account_id(_PLATFORM_REVENUE),
            _ledger.to_m2z(row.amount), "spend", "reservation_settle", str(row.pk),
        )
        _posted()


@prepared_writer
def release_reservation(reservation) -> bool:
    """Return an authorization hold to the user's spendable balance."""
    if reservation is None:
        return False
    from dj.apps.ledger import holds
    if isinstance(reservation, holds.HoldReservation):
        with transaction.atomic():
            _ledger.lock_creator(reservation.user_id)
            with connection.cursor() as cursor:
                cursor.execute('SELECT 1 FROM ledger_hold WHERE id=%s', [reservation.pk])
                if cursor.fetchone() is None:
                    return False
            return holds.call('release', reservation.pk)['status'] == 'released'
    from dj.apps.tuzis.models import ProviderReservation

    with transaction.atomic():
        untrusted = ProviderReservation.objects.filter(pk=reservation.pk).first()
        if untrusted is None:
            return False
        # Match reserve() and stale cleanup: Creator first, reservation second.
        # This avoids a release-vs-recovery deadlock on the two rows.
        locked = _ledger.lock_creator(untrusted.user_id)
        row = ProviderReservation.objects.select_for_update().filter(
            pk=reservation.pk, status=RESERVATION_ACTIVE
        ).first()
        if row is None:
            return False
        if locked is not None:
            _ledger.lock_account(locked.id, locked.balance)
            _post_release(locked.id, row)
        row.status = RESERVATION_RELEASED
        row.finished_at = timezone.now()
        row.save(update_fields=["status", "finished_at"])
        return True
