"""Issue 2Z platform credits for observed on-chain ZEC purchases atomically.

ZEC is the on-chain asset; 2Z are application credits. Management commands do not
receive request middleware transactions, so the receipt and corresponding credit
must share an explicit transaction here. Neither can commit without the other.
"""
from __future__ import annotations

import os
import re
import zlib
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.db import DataError, IntegrityError, connection, transaction
from django.utils import timezone

from zcashrpc.paymentd_mode import legacy_buy_producer

from dj.apps.events.models import AMOUNT_MAX as EVENT_AMOUNT_MAX

from . import ledger
from .models import ZecCreditReceipt, ZecMemoDisposition, ZecPendingNotice

ZATS_PER_ZEC = Decimal(10) ** 8

# Keys a wallet backend may use for a note's index within its transaction.
# zcashd's `z_listreceivedbyaddress` says `outindex`; the
# `zcash_client_sqlite` reader in `zcashrpc/wallet_sqlite_client.py` says
# `output_index` (Sapling `output_index` / Orchard `action_index`).
_OUTPUT_INDEX_KEYS = ("output_index", "outindex")

# Shielded pools. `output_index` (Sapling) and `action_index` (Orchard) are
# POOL-LOCAL: a transaction with Sapling output 0 and Orchard action 0 has two
# different notes that both report index 0. The wallet reader UNIONs the two
# tables, so without the pool the receipt key collides and the second buyer is
# written off as an indistinguishable duplicate. (Found by the codex
# adversarial review.) Unknown/absent -> "", which is what every note looked
# like before this field existed and is still globally unique as long as a
# backend reports one pool or none.
_POOL_KEYS = ("pool", "note_pool")
DISPOSITION_POOLS = frozenset(("sapling", "orchard", "ironwood"))
_TXID_RE = re.compile(r"^[0-9a-fA-F]{64}$")

# The phrase monitoring/log-metrics/zec-credit-blocked.json counts, shared by
# both credit commands so one metric covers both. The `*_SIGNAL` naming is
# load-bearing: py/gcp/tests/test_alert_policy_contract.py fails if a signal
# the code emits is watched by no policy.
CREDIT_BLOCKED_SIGNAL = "CREDITING BLOCKED"

# The other direction, and it is not the same incident. CREDITING BLOCKED
# means "ZEC arrived and we did not issue 2Z for it" -- we are holding the
# buyer's money. This one means "we issued 2Z and the ZEC is no longer
# there" -- we are holding nothing and somebody has spendable platform
# credits anyway. Only the instant-credit path can produce it.
#
# Same `*_SIGNAL` naming contract: py/gcp/tests/test_alert_policy_contract.py
# fails if a signal the code emits is watched by no policy. Watched by
# monitoring/log-metrics/zec-credit-unbacked.json and
# monitoring/alert-policies/zec-credit-unbacked.json.
CREDIT_UNBACKED_SIGNAL = "CREDIT UNBACKED"

# Event.amount used to be an IntegerField: it always truncated the 2Z decimal
#, and past roughly 2.1e9 2Z it overflowed int32 with DataError, which
# rolled back an otherwise correct credit and failed identically on every
# retry (found by the codex adversarial review). It is now a DecimalField with
# the ledger's own precision, so every amount the ledger can hold is recorded
# verbatim. The clamp stays, at the column's ceiling, because a ZEC_PENDING
# amount is a *projection* (rate x amount_zec) rather than a ledger value and
# a notification is still not the money: clamping beats losing the credit.
# Imported above as EVENT_AMOUNT_MAX = dj.apps.events.models.AMOUNT_MAX.


def note_output_index(tx: dict) -> int:
    """The index of this note within its transaction, or 0 if unreported.

    Falling back to 0 is deliberately the **conservative** direction: a
    backend that cannot tell two notes of one transaction apart collapses them
    onto a single receipt, so the second note goes uncredited (visible, and
    recoverable by hand) instead of being credited twice (invisible, and not
    recoverable at all). ``credit_creators`` logs the collapse.
    """
    for key in _OUTPUT_INDEX_KEYS:
        value = tx.get(key)
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return 0


def note_zatoshi(tx: dict, amount_zec: Decimal) -> int:
    """The note's value in ZATOSHI -- integers all the way down.

    Every cap on this path is expressed in zatoshi and compared with ``int``,
    never in ZEC and never against a float. ``tx['amount']`` is a float
    (``value / 1e8`` in the wallet adapter) and floats are exactly the wrong
    type for deciding whether something is under a money limit: the boundary
    case is the one that matters and it is the one that rounds.

    Prefers the backend's own integer if it reports one, and derives it from
    the already-quantized Decimal otherwise, so a wallet backend that does not
    report ``amountZat`` still gets a correct, exact answer.
    """
    raw = tx.get("amountZat")
    if raw is not None:
        try:
            return int(raw)
        except (TypeError, ValueError):
            pass
    return int((Decimal(amount_zec) * ZATS_PER_ZEC).to_integral_value())


def note_pool(tx: dict) -> str:
    """The shielded pool this note was received in ("sapling"/"orchard")."""
    for key in _POOL_KEYS:
        value = tx.get(key)
        if value:
            return str(value)[:16]
    return ""


class ZecMemoDispositionConflict(Exception):
    """A note already has a different immutable operator disposition."""

    def __init__(self, existing: ZecMemoDisposition):
        self.existing = existing
        super().__init__(
            f"note {existing} already has decision {existing.decision!r}")


class ZecMemoDispositionIdentityError(ValueError):
    """The wallet did not provide an unambiguous disposition identity."""


class ZecMemoDispositionNotObserved(ValueError):
    """An operator tried to resolve a note that was never observed."""


def _strict_alias(tx, keys, label):
    values = [tx[key] for key in keys if key in tx and tx[key] is not None]
    if not values:
        raise ZecMemoDispositionIdentityError(
            f"{label} was not reported by the wallet adapter")
    if any(value != values[0] for value in values[1:]):
        raise ZecMemoDispositionIdentityError(
            f"wallet adapter reported conflicting {label} aliases")
    return values[0]


def canonical_disposition_note(tx: dict):
    """Return a validated ``(txid, pool, output_index)`` disposition key.

    This stricter identity is intentionally local to malformed-memo
    dispositions. Receipt compatibility still uses:func:`note_key`, whose
    conservative index-zero fallback protects the existing money path. A
    disposition must never use that fallback: suppressing a different note
    would hide money that has no receipt.
    """
    txid = tx.get("txid")
    if not isinstance(txid, str) or not _TXID_RE.fullmatch(txid):
        raise ZecMemoDispositionIdentityError(
            "wallet adapter did not report a 64-hex transaction id")
    txid = txid.lower()

    # The SQLite adapter deliberately returns a conservative index of zero
    # when an older wallet schema has no per-note index column. That fallback
    # is safe for receipt processing because the credit loop's repeat guard
    # blocks the second note, but it is not an identity: two same-amount
    # malformed notes would otherwise share one disposition row. Adapters
    # that know they used this fallback mark it explicitly; refuse to create
    # an audit key that could retire another note.
    if tx.get("output_index_reliable") is False:
        raise ZecMemoDispositionIdentityError(
            "wallet adapter could not reliably report a pool-local output index")

    pool = _strict_alias(tx, _POOL_KEYS, "pool")
    if not isinstance(pool, str) or pool != pool.strip():
        raise ZecMemoDispositionIdentityError(
            "wallet adapter reported an invalid pool")
    pool = pool.lower()
    if pool not in DISPOSITION_POOLS:
        raise ZecMemoDispositionIdentityError(
            "wallet adapter reported an unknown or ambiguous pool")

    index_values = [
        tx[key] for key in _OUTPUT_INDEX_KEYS
        if key in tx and tx[key] is not None
    ]
    if not index_values:
        raise ZecMemoDispositionIdentityError(
            "wallet adapter did not report a pool-local output index")
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in index_values
    ):
        raise ZecMemoDispositionIdentityError(
            "wallet adapter reported a non-integer output index")
    if any(value != index_values[0] for value in index_values[1:]):
        raise ZecMemoDispositionIdentityError(
            "wallet adapter reported conflicting output-index aliases")
    return txid, pool, index_values[0]


def disposition_amount_from_tx(tx: dict):
    """Return an exact positive ZEC amount for a durable observation.

    ``amountZat`` is authoritative when present. Float-only adapter output is
    rejected here rather than rounded into an audit row. This does not alter
    the existing receipt parser or instant-credit policy.
    """
    if "amountZat" in tx and tx["amountZat"] is not None:
        amount_zat = tx["amountZat"]
        if isinstance(amount_zat, bool) or not isinstance(amount_zat, int):
            raise ValueError("wallet adapter reported a non-integer amountZat")
        if amount_zat <= 0:
            raise ValueError("wallet adapter reported a non-positive amount")
        return Decimal(amount_zat) / ZATS_PER_ZEC

    raw_amount = tx.get("amount")
    if isinstance(raw_amount, bool) or not isinstance(raw_amount, (str, Decimal)):
        raise ValueError("wallet adapter did not report an exact amount")
    try:
        amount = Decimal(raw_amount)
        quantized = amount.quantize(Decimal("0.00000001"))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("wallet adapter reported an invalid amount")
    if not amount.is_finite() or amount <= 0 or amount != quantized:
        raise ValueError("wallet adapter reported an invalid amount")
    return quantized


def _validated_disposition_amount(amount_zec):
    try:
        amount_zec = Decimal(str(amount_zec))
        quantized_amount = amount_zec.quantize(Decimal("0.00000001"))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("amount_zec must be a finite positive ZEC amount")
    if not amount_zec.is_finite() or amount_zec <= 0:
        raise ValueError("amount_zec must be a finite positive ZEC amount")
    if amount_zec != quantized_amount:
        raise ValueError("amount_zec must use at most 8 decimal places")
    return quantized_amount


def _disposition_key(txid, pool, output_index):
    return canonical_disposition_note({
        "txid": txid,
        "pool": pool,
        "output_index": output_index,
    })


def record_zec_memo_observation(*, txid: str, pool: str, output_index: int,
                                amount_zec,
                                classification=ZecMemoDisposition.UNPARSEABLE_BUY_2Z,
                                memo_action: str = "", memo_target: str = ""):
    """Persist one unresolved unroutable-note observation before log capping.

    ``classification`` defaults to the  malformed ``buy_2z`` case;
    ``credit_pages_unified`` passes a page classification  together
    with the action and page id the memo named, which are stored truncated as
    audit data only. The first observation's amount and classification are
    authoritative: a repeat that disagrees raises a conflict and can never
    overwrite or retire the row.
    """
    if classification not in dict(ZecMemoDisposition.CLASSIFICATION_CHOICES):
        raise ValueError(f"unknown memo classification {classification!r}")
    txid, pool, output_index = _disposition_key(txid, pool, output_index)
    quantized_amount = _validated_disposition_amount(amount_zec)
    action_field = ZecMemoDisposition._meta.get_field("memo_action")
    target_field = ZecMemoDisposition._meta.get_field("memo_target")
    with transaction.atomic():
        disposition, _created = ZecMemoDisposition.objects.get_or_create(
            txid=txid,
            pool=pool,
            output_index=output_index,
            defaults={
                "amount_zec": quantized_amount,
                "classification": classification,
                "memo_action": str(memo_action)[:action_field.max_length],
                "memo_target": str(memo_target)[:target_field.max_length],
            },
        )
        disposition = ZecMemoDisposition.objects.select_for_update().get(
            pk=disposition.pk)
        if (
            disposition.amount_zec != quantized_amount
            or disposition.classification != classification
        ):
            raise ZecMemoDispositionConflict(disposition)
    return disposition


def record_zec_memo_disposition(
        *, txid: str, pool: str, output_index: int, amount_zec,
        decision: str, operator: str, reason: str):
    """Record one immutable, non-financial disposition atomically.

    The unique note key is the concurrency boundary. Repeating the exact same
    command is an idempotent no-op; a different decision is refused rather
    than overwriting the audit trail. This function never creates a receipt,
    ledger entry, event, or wallet operation.
    """
    txid, pool, output_index = _disposition_key(
        txid, pool, output_index)
    quantized_amount = _validated_disposition_amount(amount_zec)

    operator = str(operator).strip()
    reason = str(reason).strip()
    if not operator:
        raise ValueError("operator must not be empty")
    if not reason:
        raise ValueError("reason must not be empty")
    if decision not in dict(ZecMemoDisposition.DECISION_CHOICES):
        raise ValueError(f"unknown memo disposition {decision!r}")

    if decision == ZecMemoDisposition.CREDITED_MANUALLY:
        # Only reachable for a buy_2z observation in practice: the receipt it
        # demands is a 2Z credit receipt, which no page observation has. The
        # classification itself is checked under the row lock below.
        #
        # This audit decision is only defensible when the receipt for this
        # exact note proves that a non-backfilled creator was already paid.
        # Keep the invariant here as well as in the command: callers must not
        # be able to bypass the supported command and create a disposition
        # that a later parser repair could credit a second time.
        receipt_exists = ZecCreditReceipt.objects.filter(
            txid=txid,
            pool=pool,
            output_index=output_index,
            amount_zec=quantized_amount,
            creator__isnull=False,
            backfilled=False,
            tuzis_credited__isnull=False,
        ).exists()
        if not receipt_exists:
            raise ValueError(
                "credited_manually requires a canonical same-note "
                "ZecCreditReceipt with a non-backfilled creator and "
                "recorded 2Z amount")

    with transaction.atomic():
        disposition = ZecMemoDisposition.objects.select_for_update().filter(
            txid=txid, pool=pool, output_index=output_index).first()
        if disposition is None:
            raise ZecMemoDispositionNotObserved(
                "note has not been observed as an unroutable ZEC memo")
        if disposition.amount_zec != quantized_amount:
            raise ZecMemoDispositionConflict(disposition)
        if (
            decision == ZecMemoDisposition.CREDITED_MANUALLY
            and disposition.classification
            != ZecMemoDisposition.UNPARSEABLE_BUY_2Z
        ):
            raise ValueError(
                "credited_manually applies only to an unparseable buy_2z "
                "observation; record page funding by hand and use ignore or "
                "refunded with the reference in the reason")
        if (
            decision == ZecMemoDisposition.REFUNDED
            and disposition.classification
            not in ZecMemoDisposition.PAGE_CLASSIFICATIONS
        ):
            # credit_pages_unified refuses to record a refunded note on a
            # page that later appears; credit_creators has no such guard, so
            # a refunded buy_2z memo that a parser repair made readable would
            # ALSO be credited in 2Z. Until that path honours it, a refund of
            # a purchase is `ignore` plus escalation, as the runbook says.
            # (Found by the codex adversarial review.)
            raise ValueError(
                "refunded applies only to a page observation; for a buy_2z "
                "observation use ignore with the refund reference and "
                "escalate (see docs/zcash/malformed-memo-dispositions.md)")
        if disposition.decision is None:
            disposition.decision = decision
            disposition.operator = operator
            disposition.reason = reason
            disposition.disposed_at = timezone.now()
            disposition.save(update_fields=[
                "decision", "operator", "reason", "disposed_at"])
            return disposition, True

    same = (
        disposition.decision == decision
        and disposition.operator == operator
        and disposition.reason == reason
    )
    if not same:
        raise ZecMemoDispositionConflict(disposition)
    return disposition, False


# --------------------------------------------------------------------------
# Instant credit -- issuing 2Z for a note that is BELOW the confirmation floor
# --------------------------------------------------------------------------
#
# WHAT THE RISK ACTUALLY IS, because the obvious answer is the wrong one.
#
# It is not a 51% attack. Nobody rewrites the Zcash chain to steal platform
# credits. The two real mechanisms are:
#
#   1. A natural orphan. Zcash's measured stale-block rate is ~0.34%, and a
#      valid transaction orphaned out of a block goes straight back into the
#      mempool and is re-mined in the next one. The natural case is a DELAY,
#      not a loss, which is why holding for three blocks buys so little
#      safety and costs four minutes of the buyer's confidence.
#   2. A deliberate race by the sender -- a Finney/race double-spend. They do
#      not need a majority; they need one block, mined by them, containing a
#      conflicting spend of the same nullifier, landing before ours. Zcash has
#      no replace-by-fee and nodes reject a conflicting nullifier from the
#      mempool on a first-seen basis, so this needs real hashpower or a
#      network partition, not a fee bump. It is bounded, purchasable, and
#      repeatable -- which is why the cap below is per-note AND per-day.
#
# The exposure is therefore an ATTACKER'S BUDGET question, not a probability
# question, and the answer is to make the maximum haul smaller than the cost
# of the attempt. Everything below exists to bound the haul.

# Zatoshi. Refuse to enable instant credit above this, whatever the operator
# typed. 1 ZEC is ~$860 at the rates this platform has been seeing, which is
# already far past any sane "the buyer should not have to wait" threshold, so
# a value above it is a fat-finger (a factor-1000 slip is the shape to fear:
# `50000000` for 0.5 ZEC vs `50000000000` for 500) rather than a policy. The
# fallback is DISABLED, not "clamp to the maximum" -- silently crediting at a
# cap nobody chose is how the confirmation floor got to be zero.
MAX_INSTANT_CREDIT_ZATOSHI = 100_000_000

INSTANT_CREDIT_ZATOSHI_ENV = "ZEC_INSTANT_CREDIT_MAX_ZATOSHI"
INSTANT_CREDIT_DAILY_ZATOSHI_ENV = "ZEC_INSTANT_CREDIT_DAILY_MAX_ZATOSHI"

# Rolling, not calendar. A midnight reset hands an attacker two full daily
# budgets a few minutes apart, which is exactly the repeat the daily cap
# exists to stop.
INSTANT_CREDIT_WINDOW = timedelta(hours=24)

# Postgres transaction-level advisory lock. The daily aggregate cap is a
# read-then-write across rows, so two processes running the credit loop at
# once could both read "under the cap" and both credit. There is only meant
# to be one systemd unit, but "meant to be" is not a guarantee, a hand-run
# `manage.py credit_creators` during an incident is exactly when this would
# happen, and the failure is silent and monetary. Derived rather than a magic
# number so it is obvious where it came from.
_INSTANT_CREDIT_LOCK_KEY = zlib.crc32(b"zec_instant_credit")


@dataclass(frozen=True)
class InstantCreditPolicy:
    """The instant-credit caps in force, in zatoshi. Both zero = OFF."""

    per_note_zat: int
    daily_zat: int

    @property
    def enabled(self) -> bool:
        # BOTH must be set. A per-note cap with no daily cap is not a smaller
        # blast radius, it is the same trick run 960 times a day, so refusing
        # to enable without one is a forcing function rather than a nicety.
        return self.per_note_zat > 0 and self.daily_zat > 0


class InstantCreditRefused(Exception):
    """This note is not eligible for instant credit; hold it for the floor."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def _env_zatoshi(name: str, log) -> int:
    """Parse a zatoshi cap from the environment. Anything odd -> 0 (off).

    The direction of the fallback is the opposite of ``ZEC_MIN_CONFIRMATIONS``
    and deliberately so. There, falling back to the default was safe and
    falling back to 0 was a money bug. Here, 0 means "do not take any risk at
    all", so an unparseable value must land there and say why.
    """
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return 0
    try:
        value = int(raw)
    except (TypeError, ValueError):
        log(f"!! {name}={raw!r} is not an integer; instant credit is OFF")
        return 0
    if value < 0:
        log(f"!! {name}={raw!r} is negative; instant credit is OFF")
        return 0
    if value > MAX_INSTANT_CREDIT_ZATOSHI:
        log(f"!! {name}={raw!r} is above {MAX_INSTANT_CREDIT_ZATOSHI} zatoshi "
            f"(1 ZEC); instant credit is OFF. Caps are in ZATOSHI, not ZEC.")
        return 0
    return value


def instant_credit_policy(log=print) -> InstantCreditPolicy:
    """Read the caps out of the environment. Default: disabled.

    Read per call, not at import: the loop is a long-lived systemd unit and
    the operator changing a cap should not need a code deploy to see it, and
    a module-level read is untestable without reloading the module.
    """
    return InstantCreditPolicy(
        per_note_zat=_env_zatoshi(INSTANT_CREDIT_ZATOSHI_ENV, log),
        daily_zat=_env_zatoshi(INSTANT_CREDIT_DAILY_ZATOSHI_ENV, log),
    )


def unresolved_unbacked_credits():
    """Instant credits whose ZEC vanished and which no human has closed out.

    While any of these exist, instant crediting is refused platform-wide.
    That is the automatic half of the response, and it is the half that
    matters: whatever produced one unbacked credit -- a double-spender, a
    wallet that lost its notes, an adapter that stopped seeing a pool -- is
    still true 90 seconds later, and without this the same cause simply
    collects the per-note cap again on every cycle until somebody wakes up.
    Detection without a brake is not a control.
    """
    return ZecCreditReceipt.objects.filter(
        vanished_at__isnull=False, vanish_resolved_at__isnull=True)


def daily_instant_zatoshi(now=None) -> int:
    """Zatoshi credited instantly in the trailing 24 hours."""
    from django.db.models import Sum

    now = now or timezone.now()
    total = ZecCreditReceipt.objects.filter(
        instant=True, created_at__gte=now - INSTANT_CREDIT_WINDOW,
    ).aggregate(total=Sum("amount_zec"))["total"] or Decimal("0")
    # amount_zec is DecimalField(decimal_places=8), so this is exact.
    return int((Decimal(total) * ZATS_PER_ZEC).to_integral_value())


def _take_instant_credit_lock() -> None:
    if connection.vendor != "postgresql":
        return
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(%s)", [_INSTANT_CREDIT_LOCK_KEY])


@legacy_buy_producer
def credit_zec_purchase_instantly(*, amount_zat: int, policy=None, now=None,
                                  **kwargs) -> ZecCreditReceipt:
    """Issue 2Z for a note that has NOT reached the confirmation floor.

    Raises:class:`InstantCreditRefused` -- and writes nothing -- unless every
    one of these holds:

    * instant credit is switched on (both caps set),
    * no unbacked credit is outstanding (the circuit breaker),
    * ``amount_zat`` is **strictly below** the per-note cap,
    * the trailing-24h instant total **including this note** is at most the
      daily cap.

    The two boundary conventions differ on purpose and both are pinned by
    tests: the per-note cap is the first amount that is *too big to trust*,
    while the daily cap is the most value that may leave on trust in a day.

    Everything after the lock happens in ONE transaction, so the daily total
    cannot be read by two cycles racing each other into the same budget.
    """
    # paymentd-producer-guard-v1: entry guard precedes every database effect.
    from zcashrpc.paymentd_mode import require_legacy_producer
    require_legacy_producer()
    policy = policy or instant_credit_policy()
    now = now or timezone.now()

    if not policy.enabled:
        raise InstantCreditRefused("instant credit is not enabled")
    if amount_zat >= policy.per_note_zat:
        raise InstantCreditRefused(
            f"{amount_zat} zatoshi is at or above the per-note instant cap "
            f"of {policy.per_note_zat}")

    with transaction.atomic():
        from dj.apps.economy.epoch import pin_supported_policy
        if pin_supported_policy() != 0:
            raise InstantCreditRefused('policy 1 instant credit is unavailable')
        # Serialize the read-then-write. Released at commit/rollback.
        _take_instant_credit_lock()

        outstanding = unresolved_unbacked_credits().first()
        if outstanding is not None:
            raise InstantCreditRefused(
                f"instant credit is halted: receipt {outstanding} was "
                f"credited instantly and its note is no longer in the wallet, "
                f"and no human has resolved it")

        already = daily_instant_zatoshi(now=now)
        if already + amount_zat > policy.daily_zat:
            raise InstantCreditRefused(
                f"{amount_zat} zatoshi would take the trailing-24h instant "
                f"total to {already + amount_zat}, over the daily cap of "
                f"{policy.daily_zat}")

        return credit_zec_purchase(instant=True, **kwargs)


def notify_pending_note(*, creator, txid: str, output_index: int,
                        amount_zec: Decimal, pool: str = "",
                        confirmations: int = 0,
                        tuzis_per_zec: Decimal | None = None,
                        purchase_intent=None, captured_note=None, wake_up=True) -> ZecPendingNotice | None:
    """Tell the buyer we can see their payment. Exactly once per note.

    Returns the notice, or ``None`` if this note was already announced.

    THE IDEMPOTENCY IS THE FEATURE. The credit loop re-reads every held note
    on every ~90-second cycle, so the naive version tells the buyer three
    times per purchase and tells them thirty times if the chain is slow.
    ``events.Event`` has no uniqueness constraint of any kind, so the
    de-duplication has to come from ``ZecPendingNotice`` -- and the notice and
    the event are written in one transaction, so "we recorded that we told
    them" and "we told them" cannot come apart.

    Costs nothing and risks nothing: no 2Z move, no on-chain assumption is
    made. It is purely the difference between four minutes of silence and
    four minutes of "we've got it".
    """
    from dj.apps.events.dispatch import create_durable_event

    amount_zec = Decimal(amount_zec)
    expected = (ledger.to_tuzis(Decimal(tuzis_per_zec) * amount_zec)
                if tuzis_per_zec is not None else None)
    try:
        with transaction.atomic():
            notice = ZecPendingNotice.objects.create(
                txid=txid,
                pool=pool,
                output_index=output_index,
                creator=creator,
                amount_zec=amount_zec,
                confirmations=confirmations,
            )
            create_durable_event(
                read=False,
                type="ZEC_PENDING",
                wake_up=wake_up,
                content_object=captured_note if captured_note is not None else purchase_intent,
                # Same column-ceiling clamp as BOUGHT_TUZI: a notification
                # is never worth failing over. `expected` is already
                # quantized to the column's 3 places by ledger.to_tuzis.
                amount=min(expected, EVENT_AMOUNT_MAX) if expected is not None else None,
                receiving_user=creator,
                payee=creator,
            )
    except IntegrityError:
        # Only a duplicate marker means "already announced". An outbox or
        # Event insert failure must surface, after rolling the marker back,
        # rather than falsely reporting that the buyer was notified.
        if ZecPendingNotice.objects.filter(
                txid=txid, pool=pool, output_index=output_index).exists():
            return None
        raise
    return notice


def watch_instant_credits(*, confirmed_keys, pending_keys, now=None,
                          pending_visible: bool = True):
    """Reconcile instant credits against what the wallet still holds.

    ``confirmed_keys`` / ``pending_keys`` are sets of ``(txid, pool,
    output_index)`` for the notes the wallet reports at or below the
    confirmation floor respectively. Returns
    ``(settled, vanished, unverifiable)``.

    * **settled** -- the note has since been seen at or above the floor. It is
      no longer at risk and comes off the watch list permanently.
    * **vanished** -- the note is in neither set. We issued 2Z against ZEC
      that is not in the wallet any more.
    * **unverifiable** -- we cannot answer the question this cycle. Two ways
      in, and neither is an accusation:

      - the wallet reported no notes AT ALL while we are watching some.
        Almost certainly a resync, a restore, or an adapter that stopped
        reading a pool -- not N simultaneous double-spends.
      - ``pending_visible=False``: the adapter in front of us does not report
        held notes, so ``pending_keys`` is empty because we CANNOT SEE young
        notes, not because there are none. `the deployment checkout` on the payment host is a
        hand-unpacked tarball  and a partial rollback puts exactly
        that adapter back. Without this, an ordinary rollback marks every
        young instant credit vanished, pages, halts crediting platform-wide
        and points a responder at innocent buyers. (Found by the codex
        adversarial review.)

      Both still page, because "we cannot tell whether our credits are
      backed" is not a quiet state either.

    NOTHING IS AUTO-REVERSED, and that is a decision rather than an omission.
    Three reasons, in order of weight:

    1. **The signal is not trustworthy enough to move money on its own.** It
       is derived from a local SQLite file that this repository has already
       been wrong about twice in ways every check stayed green for: an entire
       shielded pool the adapter never SELECTed from, and a spend query naming
       a column that had not existed for releases. A wallet restored from an
       older snapshot makes every recent note "vanish" at once. An automatic
       debit driven by that takes money from people who did nothing.
    2. **The debit frequently cannot succeed anyway.** 2Z are spendable the
       instant they land, so by the time a vanish is noticed the balance may
       be gone and ``ledger.debit`` raises ``InsufficientFunds``. A reversal
       that works only when it does not matter is not a control; it is a
       false sense of one.
    3. **The brake is the part that has to be automatic, and it is.** While an
       unbacked credit is unresolved, instant crediting is refused for
       everybody -- so the maximum an attacker collects from a working attack
       is ONE per-note cap, not one per cycle. That bound does not depend on
       anyone being awake, which is exactly the property an auto-reversal
       would be pretending to provide.

    So: detect, mark, brake, page. A human decides what to do about the
    balance, with the receipt in front of them.
    """
    now = now or timezone.now()
    # The SAME advisory lock the issuing path takes, and for the same reason.
    # Without it the brake and the issuer are not serialized against each
    # other: process B can reconcile a wallet snapshot in which note X still
    # exists, process A can then observe X missing, and B can issue another
    # instant credit before A has persisted `X.vanished_at`. The lock makes
    # "one working attack collects one per-note cap" true rather than
    # approximately true. (Found by the codex adversarial review.)
    with transaction.atomic():
        _take_instant_credit_lock()

        watched = list(ZecCreditReceipt.objects.filter(
            instant=True, settled_at__isnull=True, vanished_at__isnull=True))
        if not watched:
            return [], [], []

        settled, unverifiable = [], []
        if not confirmed_keys and not pending_keys:
            return [], [], watched

        if not pending_visible:
            # We can see confirmed notes but not young ones. Settling is
            # still sound -- a note at or above the floor is genuinely
            # settled -- but "not in either set" carries no information, so
            # nothing may be accused.
            for receipt in watched:
                key = (receipt.txid, receipt.pool, receipt.output_index)
                if key in confirmed_keys:
                    receipt.settled_at = now
                    receipt.save(update_fields=["settled_at"])
                    settled.append(receipt)
                else:
                    unverifiable.append(receipt)
            return settled, [], unverifiable

        vanished = []
        for receipt in watched:
            key = (receipt.txid, receipt.pool, receipt.output_index)
            if key in confirmed_keys:
                receipt.settled_at = now
                receipt.save(update_fields=["settled_at"])
                settled.append(receipt)
            elif key in pending_keys:
                continue
            else:
                receipt.vanished_at = now
                receipt.save(update_fields=["vanished_at"])
                vanished.append(receipt)
        return settled, vanished, []


class AlreadyCredited(Exception):
    """This note already has a receipt, so no 2Z were issued by this call."""

    def __init__(self, receipt: ZecCreditReceipt):
        self.receipt = receipt
        super().__init__(f"note {receipt} was already credited")


def legacy_claim(txid: str):
    """A receipt proving the OLD code already processed ``txid``, or ``None``.

    THE ROLLOUT GAP THIS CLOSES (found by the codex adversarial review).
    Migration ``tuzis/0003`` backfills a receipt for every ``buy_2z``
    transaction that exists **when Cloud Build runs it**. But the crediting
    loop does not ship with the backend: ``the deployment checkout`` on the payment host is an unpacked
    tarball updated by hand (see ``docs/zcash/wallet-pipeline.md``). Every
    payment the OLD loop credits between the migration and that hand-update
    gets a ``g12f.Transaction`` row and no receipt, and the new code would
    then credit it a SECOND time at the then-current rate. The window has no
    upper bound because merging does not deploy the VM.

    So the rule is evaluated **live**, not snapshotted: a ``buy_2z``
    ``g12f.Transaction`` row with no receipt anywhere for that txid means the
    old loop got there first. The claim is adopted as a ``backfilled=True``
    receipt so it is durable, visible in the admin, and picked up by
    ``manage.py audit_zec_credits`` exactly like the migration's own rows.

    The "no receipt anywhere for that txid" qualifier is load-bearing: the new
    code writes a ``g12f.Transaction`` row too, and without it the row written
    for output 0 would block output 1 of the same transaction and quietly
    reinstate the multi-output bug.

    Committed in its own transaction so the caller can raise afterwards
    without rolling the adoption back.
    """
    from dj.apps.g12f.models.transaction import Transaction

    with transaction.atomic():
        existing = ZecCreditReceipt.objects.filter(txid=txid)
        backfilled = existing.filter(backfilled=True).first()
        if backfilled is not None:
            # A backfilled receipt claims the WHOLE transaction, not just its
            # own index: the pre- schema discarded the real index, so
            # `(txid, 0)` is a guess. Without this, the first cycle after the
            # adapter starts reporting real indices re-credits all of history
            # at today's rate, in bulk. (codex adversarial review.)
            return backfilled
        if existing.exists():
            # This transaction is already being handled by the new code.
            return None

        legacy = Transaction.objects.filter(
            txid=txid, action="buy_2z").first()
        if legacy is None:
            return None
        return ZecCreditReceipt.objects.create(
            txid=txid,
            output_index=0,
            pool="",
            creator=legacy.creator,
            amount_zec=legacy.amount,
            # Same assertion as a migration-backfilled row, and deliberately
            # the same flag: "the old code saw this note", NOT "2Z were
            # issued for it".
            backfilled=True,
        )


@legacy_buy_producer
def credit_zec_purchase(
    *,
    creator,
    txid: str,
    output_index: int,
    amount_zec: Decimal,
    pool: str = "",
    tuzis_per_zec: Decimal,
    memo: str = "",
    memo_plain: str = "",
    action: str = "buy_2z",
    confirmations: int | None = None,
    instant: bool = False,
) -> ZecCreditReceipt:
    """Issue 2Z for one received ZEC note, exactly once, atomically.

    Raises:class:`AlreadyCredited` if a receipt for ``(txid, output_index)``
    already exists — nothing is written in that case.

    Everything else happens inside a single ``transaction.atomic()``:

    * the ``ZecCreditReceipt`` (the idempotency marker),
    * ``ledger.credit`` (the 2Z),
    * the ``BOUGHT_TUZI`` event the recipient sees and its durable outbox
      promise (GKE retries publication even if the node dies after commit),
    * a best-effort ``g12f.Transaction`` record of the note.

    The ``g12f.Transaction`` write is wrapped in its own savepoint and is
    explicitly allowed to fail: its primary key is the bare ``txid``, so the
    second note of a multi-output transaction cannot be stored there. That is
    a record-keeping loss, not a crediting loss, and it must never roll back a
    credit that is otherwise correct.
    """
    # paymentd-producer-guard-v1: includes the policy-1 capture boundary.
    from zcashrpc.paymentd_mode import require_legacy_producer
    require_legacy_producer()
    # Import here: dj.apps.g12f imports from dj.apps.tuzis.
    from dj.apps.events.dispatch import create_durable_event
    from dj.apps.g12f.models.transaction import Transaction

    from dj.apps.economy.models import EconomicPolicy
    policy = EconomicPolicy.objects.get(pk=True)
    if policy.version == 1 or policy.fenced:
        from dj.apps.economy.captured_notes import capture_wallet_note
        result = capture_wallet_note({'txid':txid,'pool':pool,'output_index':output_index,
            'amount':str(amount_zec),'amountZat':int(Decimal(amount_zec)*ZATS_PER_ZEC),
            'memo':memo,'confirmations':confirmations or 0}, instant=instant)
        return result.receipt if result.credited else result

    amount_zec = Decimal(amount_zec)
    tuzis_per_zec = Decimal(tuzis_per_zec)
    tuzis = ledger.to_tuzis(tuzis_per_zec * amount_zec)

    claimed = legacy_claim(txid)
    if claimed is not None:
        raise AlreadyCredited(claimed)

    with transaction.atomic():
        from dj.apps.economy.epoch import pin_supported_policy
        version = pin_supported_policy()
        if version != 0:
            # Retry through the durable ingestion boundary outside this TX.
            from dj.apps.economy.services import EconomicRefusal
            raise EconomicRefusal('captured_note_boundary_retry')
        try:
            # Savepoint: a losing race here must not poison the outer
            # transaction, it must just mean "somebody else credited it".
            with transaction.atomic():
                receipt = ZecCreditReceipt.objects.create(
                    txid=txid,
                    output_index=output_index,
                    pool=pool,
                    creator=creator,
                    amount_zec=amount_zec,
                    tuzis_credited=tuzis,
                    tuzis_per_zec=tuzis_per_zec,
                    confirmations_at_credit=confirmations,
                    instant=instant,
                )
        except IntegrityError:
            # Only a genuine duplicate receipt means "already credited". A
            # violated foreign key (the Creator was deleted mid-cycle) is a
            # real failure, and reporting it as an idempotent no-op would be
            # the same silent under-credit this module exists to remove.
            existing = ZecCreditReceipt.objects.filter(
                txid=txid, output_index=output_index, pool=pool).first()
            if existing is None:
                raise
            raise AlreadyCredited(existing) from None

        # A purchase on the zec rail: `sys:clearing_zec -> user`, keyed on the
        # output the receipt is unique on, with the receipt named so the
        # refund cursor exists (§5.8).
        ledger.credit(
            creator, tuzis,
            source="sys:clearing_zec",
            ref_kind="zec_receipt",
            ref_id=str(receipt.pk),
            idem=f"zec:{txid}:{pool}:{output_index}",
        )
        from dj.apps.economy.funding import mark_original_zec_note_issued
        mark_original_zec_note_issued(receipt)

        create_durable_event(
            read=False,
            type="BOUGHT_TUZI",
            amount=min(tuzis, EVENT_AMOUNT_MAX),
            receiving_user=creator,
            payee=creator,
        )

        record_conflict = False
        try:
            with transaction.atomic():
                _, record_created = Transaction.objects.get_or_create(
                    txid=txid,
                    defaults={
                        "creator": creator,
                        "amount": amount_zec,
                        "memo": memo,
                        "memo_plain": memo_plain,
                        "action": action,
                    },
                )
            # An existing row belongs to the FIRST note of this transaction.
            # Never overwrite it: doing so is what destroyed the first payer's
            # record in (b).
            record_conflict = not record_created
        except (IntegrityError, DataError):
            # DataError matters as much as IntegrityError here.
            # `g12f.Transaction.amount` is DecimalField(max_digits=10,
            # decimal_places=8), so it cannot hold 100 ZEC or more, while the
            # receipt can. A large purchase used to raise a numeric overflow
            # that escaped this handler and rolled back the WHOLE credit --
            # the buyer sent real ZEC and every later cycle failed the same
            # way. (Found by the codex adversarial review.)
            record_conflict = True

    receipt.record_conflict = record_conflict
    return receipt
