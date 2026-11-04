"""Status bookkeeping for purchase intents.

Card bookkeeping in this module never moves 2Z; the explicit ZEC expiry
write releases only unused, unobserved funding capacity. On the card rail the
credit is posted by
``dj.apps.ztripe.fulfillment._credit_or_link_existing`` exactly as it always
has been (``ledger.credit(... ref_kind='stripe_transaction', idem='stripe:'
|| payment_intent)``); :func:`record_card_fulfillment` runs in the SAME
transaction, after it, and only records what happened: a
``PurchaseReceipt`` for the payment and the intent's walk to ``credited``.

Lock order (docs/tuzis/ledger-v2.md §6 puts creator and ledger rows first):
the webhook holds ``ztripe_checkoutintent`` then the creator/ledger rows, and
takes the ``purchases_purchaseintent`` row LAST. The read-side heal
(:func:`heal_card_intent`) takes only the purchase intent row, so the two
cannot deadlock, and the receipt insert happens under that row lock on both
paths.
"""
from __future__ import annotations

import json
import logging
from copy import copy

from django.db import DatabaseError, transaction
from django.utils import timezone

from .models import (
    CREDITED_STATUSES,
    EXPIRABLE_STATUSES,
    InvalidTransition,
    PurchaseIntent,
    PurchaseReceipt,
    Rail,
    Status,
)

logger = logging.getLogger(__name__)

M2Z_PER_2Z = 1000

#: The shortest legal path from each pre-credit status to ``credited``.
_PATH_TO_CREDITED = {
    Status.CREATED: (Status.PENDING, Status.PAID, Status.CREDITED),
    Status.PENDING: (Status.PAID, Status.CREDITED),
    Status.PAID: (Status.CREDITED,),
    Status.EXPIRED: (Status.PAID, Status.CREDITED),
    Status.FAILED: (Status.PAID, Status.CREDITED),
}


def _log(level, event, **fields):
    logger.log(level, json.dumps({"event": event, **fields}, separators=(",", ":"), sort_keys=True, default=str))


def _advance_to_credited(intent: PurchaseIntent, credited_m2z: int) -> bool:
    """Walk ``intent`` (row locked by the caller) to ``credited`` along legal
    edges. Returns False, changing nothing, if it has already credited."""
    if intent.status in CREDITED_STATUSES:
        return False
    if intent.status == Status.FAILED:
        _log(logging.ERROR, "purchase_intent_paid_after_failed", purchase_id=str(intent.pk))
    now = timezone.now()
    for step in _PATH_TO_CREDITED[Status(intent.status)]:
        if step == Status.CREDITED:
            intent.transition(step, credited_at=now, credited_milli_2z=credited_m2z)
        else:
            intent.transition(step)
    return True


def record_card_fulfillment(checkout_intent, stripe_transaction) -> None:
    """Link a fulfilled Stripe checkout to its purchase intent.

    Called by ``ztripe.fulfillment`` inside the fulfilment transaction, after
    the credit, for a ``CheckoutIntent`` that carries a ``purchase_intent``.
    Idempotent: a duplicate delivery finds the receipt and a credited intent
    and changes nothing. It never raises for a state it cannot reconcile --
    a failure here would roll the credit back and make Stripe redeliver an
    event we can never accept -- it logs and leaves the intent as it is.
    """
    purchase_id = checkout_intent.purchase_intent_id
    if purchase_id is None:
        return
    try:
        # ONE savepoint around the whole link: a refused transition, any
        # database error (IntegrityError, a lock timeout) or a vanished row
        # rolls back the link only,
        # never the credit the caller already posted in the enclosing
        # transaction (and so never a redelivery loop at Stripe).
        with transaction.atomic():
            _link_card_payment(purchase_id, checkout_intent, stripe_transaction)
    except (InvalidTransition, DatabaseError, PurchaseIntent.DoesNotExist) as exc:
        _log(
            logging.ERROR, "purchase_intent_link_failed",
            purchase_id=str(purchase_id), error_type=type(exc).__name__,
        )


def _link_card_payment(purchase_id, checkout_intent, stripe_transaction) -> None:
    intent = PurchaseIntent.objects.select_for_update().get(pk=purchase_id)
    payment_intent = checkout_intent.stripe_payment_intent_id
    credited_m2z = int(stripe_transaction.tuzis_credited) * M2Z_PER_2Z
    receipt, created = PurchaseReceipt.objects.get_or_create(
        rail=Rail.STRIPE,
        provider_event_id=payment_intent,
        defaults={
            "intent": intent,
            "amount_minor": stripe_transaction.amount,
            "currency": checkout_intent.currency.upper(),
            "credited_milli_2z": credited_m2z,
            "ledger_ref_kind": "stripe_transaction",
            "ledger_ref_id": str(stripe_transaction.pk),
        },
    )
    if receipt.intent_id != intent.pk:
        # The payment already belongs to a different intent. Unreachable
        # while one CheckoutIntent names one PurchaseIntent and a
        # PaymentIntent belongs to one Session, so it is loud, not handled.
        _log(
            logging.ERROR, "purchase_receipt_intent_conflict",
            purchase_id=str(intent.pk), receipt_purchase_id=str(receipt.intent_id),
        )
        return
    if _advance_to_credited(intent, credited_m2z):
        _log(
            logging.INFO, "purchase_intent_credited",
            purchase_id=str(intent.pk), rail=intent.rail, credited_milli_2z=credited_m2z,
            receipt_created=created,
        )


def heal_card_intent(intent: PurchaseIntent) -> PurchaseIntent:
    """Catch up an intent whose card payment was fulfilled by a pod that did
    not know about purchase intents (the rollout window: an old pod runs the
    webhook for a Session a new pod opened, credits it, and leaves the
    intent ``pending``). Reads the fulfilled ``CheckoutIntent`` and applies
    the same :func:`record_card_fulfillment`. A no-op for everything else."""
    if intent.rail != Rail.STRIPE or intent.status in CREDITED_STATUSES:
        return intent
    from dj.apps.ztripe.models import CheckoutIntent, StripeTransaction

    checkout = (
        CheckoutIntent.objects.filter(
            purchase_intent_id=intent.pk, state=CheckoutIntent.State.FULFILLED,
        )
        .order_by("fulfilled_at")
        .first()
    )
    if checkout is None:
        return intent
    stripe_transaction = StripeTransaction.objects.filter(
        stripe_charge_id=checkout.stripe_payment_intent_id,
    ).first()
    if stripe_transaction is None:
        return intent
    with transaction.atomic():
        record_card_fulfillment(checkout, stripe_transaction)
    intent.refresh_from_db()
    return intent


def expire_if_due(intent: PurchaseIntent) -> PurchaseIntent:
    """``created``/``pending`` past ``expires_at`` becomes ``expired`` (§1.2).

    WRITE path only: scheduled cleanup and a later purchase authorization.
    A late payment remains an observable claim after expiry; no GET releases
    capacity. A lost race returns the fresh row without expiring it.
    """
    # Timely observed ZEC keeps its quote while the chain confirms.
    if intent.rail == Rail.ZEC:
        with transaction.atomic():
            from dj.apps.economy.epoch import pin_supported_policy
            from dj.apps.economy import services as money
            from dj.apps.economy.models import FundingReservation
            version = pin_supported_policy()
            reservation = FundingReservation.objects.filter(idempotency_key=f'zec-intent:{intent.pk}').first()
            if version == 1 and reservation is not None:
                # Policy, actors/account, then intent/reservation. A timely
                # observed payment remains reserved through confirmation.
                actors = {actor_id: money._receipt_creator(actor_id)
                    for actor_id in sorted({reservation.recipient_id, reservation.purchaser_id})}
                from dj.apps.ledger import api as usage
                usage.lock_account(reservation.recipient_id, actors[reservation.recipient_id].tuzis)
            current = PurchaseIntent.objects.select_for_update().get(pk=intent.pk)
            from dj.apps.economy.captured_notes import original_intent_has_captured_payment
            if (current.rail_data.get('payment_observed') or original_intent_has_captured_payment(current)) or current.status not in EXPIRABLE_STATUSES or not current.is_past_expiry():
                return current
            if version == 1 and reservation is not None:
                money.release_funding(reservation_id=reservation.pk,
                    reason=f'zec-intent:{intent.pk}:expired_without_observed_payment')
            current.transition(Status.EXPIRED)
            return current
    if intent.status not in EXPIRABLE_STATUSES or not intent.is_past_expiry():
        return intent
    try:
        intent.transition(Status.EXPIRED)
    except InvalidTransition:
        intent.refresh_from_db()
    return intent


def project_expiry(intent: PurchaseIntent) -> PurchaseIntent:
    """Report elapsed unused instructions without persisting or freeing funds.

    Actual release belongs to ``expire_if_due`` on a write/job path. The
    serializer requires its committed release proof before offering replacement.
    """
    if intent.rail == Rail.ZEC:
        from dj.apps.economy.captured_notes import original_intent_has_captured_payment
        if original_intent_has_captured_payment(intent):
            intent = copy(intent)
            intent.rail_data = dict(intent.rail_data, payment_observed=True)
    if (intent.status in EXPIRABLE_STATUSES and intent.is_past_expiry()
            and not (intent.rail == Rail.ZEC and intent.rail_data.get('payment_observed'))):
        intent = copy(intent)
        intent.status = Status.EXPIRED
    return intent
