"""``PurchaseIntent`` and ``PurchaseReceipt`` (PU1; spec purchase.md §1.2).

The status state machine
------------------------
The spec's transitions (purchase.md §1.2), as the one table every status
write goes through (:meth:`PurchaseIntent.transition`)::

    created  -> pending -> paid -> credited
    created | pending | paid       -> expired | failed   (pre-credit only)
    expired  -> paid                (a late card confirmation, a Zcash payment
                                     after the quote, an IAP receipt after 24h)
    failed   -> paid                (see below)
    credited -> refunded | partially_refunded | disputed | clawed_back
    partially_refunded -> refunded | disputed
    disputed -> credited            (dispute won, re-credited)
    disputed -> refunded            (dispute lost)
    disputed -> partially_refunded  (dispute won after an earlier partial refund)

Two readings of the spec are made explicit here rather than left to a caller:

* "from any non-terminal state to ``expired`` or ``failed``" is taken to mean
  the PRE-credit non-terminal states. ``partially_refunded`` and ``disputed``
  are non-terminal too, but a purchase that already credited cannot then
  "expire" or "fail"; nothing in the spec asks for that and it would hide a
  credit.
* ``failed -> paid`` is allowed although the spec lists ``failed`` as
  terminal. The only way a payment can arrive on a failed intent is a
  provider that took money after we gave up on it (a Session we could not
  validate and failed to expire, say). The money is the truth: the credit is
  posted by the rail regardless, and an intent that says ``failed`` over a
  credited payment would be a lie to the client. It is logged loudly by the
  caller when it happens.

Every transition is a compare-and-swap ``UPDATE... WHERE status = <from>``,
so two writers racing on a stale in-memory status cannot both win; the loser
gets:class:`InvalidTransition`. The DB also refuses an unknown status and a
credited-looking row without its credit fields (the ``CheckConstraint``\\s).
"""
from __future__ import annotations

import uuid

from django.db import models
from django.utils import timezone


class Rail(models.TextChoices):
    """The ledger's rail names (``ledger.credit_purchase(p_rail)``).

    The wire says ``card`` / ``zcash`` (spec §2);:data:`WIRE_RAIL` maps. The
    in-app purchase rails (``iap_apple`` / ``iap_google``) are first-party
    only and arrive with their own app; they are not accepted here yet.
    """

    STRIPE = "stripe", "Card (Stripe)"
    ZEC = "zec", "Zcash"


#The spec's wire names for each stored rail.
WIRE_RAIL = {Rail.STRIPE: "card", Rail.ZEC: "zcash"}


class Status(models.TextChoices):
    CREATED = "created", "Created"
    PENDING = "pending", "Waiting for payment"
    PAID = "paid", "Paid, not yet credited"
    CREDITED = "credited", "Credited"
    EXPIRED = "expired", "Expired"
    FAILED = "failed", "Failed"
    REFUNDED = "refunded", "Refunded"
    PARTIALLY_REFUNDED = "partially_refunded", "Partially refunded"
    DISPUTED = "disputed", "Disputed"
    CLAWED_BACK = "clawed_back", "Clawed back"


class Platform(models.TextChoices):
    DESKTOP = "desktop", "Desktop"
    IOS = "ios", "iOS"
    ANDROID = "android", "Android"
    WEB = "web", "Web"


#The legal edges. Keys absent from a value set are refused.
TRANSITIONS: dict[str, frozenset[str]] = {
    Status.CREATED: frozenset({Status.PENDING, Status.EXPIRED, Status.FAILED}),
    Status.PENDING: frozenset({Status.PAID, Status.EXPIRED, Status.FAILED}),
    Status.PAID: frozenset({Status.CREDITED, Status.EXPIRED, Status.FAILED}),
    Status.EXPIRED: frozenset({Status.PAID}),
    Status.FAILED: frozenset({Status.PAID}),
    Status.CREDITED: frozenset({
        Status.REFUNDED, Status.PARTIALLY_REFUNDED, Status.DISPUTED, Status.CLAWED_BACK,
    }),
    Status.PARTIALLY_REFUNDED: frozenset({Status.REFUNDED, Status.DISPUTED}),
    Status.DISPUTED: frozenset({Status.CREDITED, Status.REFUNDED, Status.PARTIALLY_REFUNDED}),
    Status.REFUNDED: frozenset(),
    Status.CLAWED_BACK: frozenset(),
}

#A status the 2Z have reached the balance in at least once: the credit
#fields are set, forever (a reversal never un-credits the intent record).
CREDITED_STATUSES = frozenset({
    Status.CREDITED, Status.REFUNDED, Status.PARTIALLY_REFUNDED,
    Status.DISPUTED, Status.CLAWED_BACK,
})

#Sorted, so the migration's CheckConstraint is stable across processes
#(frozenset iteration order follows string hash randomisation).
_CREDITED_VALUES = sorted(s.value for s in CREDITED_STATUSES)

#Terminal for the server (no outgoing edge).
TERMINAL_STATUSES = frozenset(s for s, targets in TRANSITIONS.items() if not targets)

#Still waiting for a payment: these expire when ``expires_at`` passes.
EXPIRABLE_STATUSES = frozenset({Status.CREATED, Status.PENDING})


class InvalidTransition(Exception):
    """The requested status change is not an edge of:data:`TRANSITIONS`, or
    the row was no longer in the status the caller read (a lost race)."""

    def __init__(self, intent_id, current, requested):
        self.intent_id = intent_id
        self.current = current
        self.requested = requested
        super().__init__(
            f"purchase intent {intent_id}: {current!s} -> {requested!s} is not allowed"
        )


def can_transition(current: str, new: str) -> bool:
    return new in TRANSITIONS.get(current, frozenset())


class PurchaseIntent(models.Model):
    """One purchase of 2Z by one user, on one rail, at one locked price."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    creator = models.ForeignKey(
        "g12f.Creator",
        on_delete=models.PROTECT,
        related_name="purchase_intents",
    )
    # The OAuth app that created it (``request.auth.application``), or NULL
    # for a first-party session/Knox request. An app reads only its own
    # intents (spec §1: "reading the intents this app created").
    application = models.ForeignKey(
        "oidc.F2ZApplication",
        on_delete=models.PROTECT,
        related_name="purchase_intents",
        null=True,
        blank=True,
    )
    rail = models.CharField(max_length=16, choices=Rail.choices)
    platform = models.CharField(max_length=16, choices=Platform.choices)
    status = models.CharField(max_length=32, choices=Status.choices, default=Status.CREATED)
    quantity_2z = models.PositiveIntegerField()
    # The rail's quote exactly as priced (``pricing.card_quote`` for card).
    quote = models.JSONField()
    pricing_version = models.CharField(max_length=32)
    price_minor = models.PositiveIntegerField()
    # ISO 4217, upper case, as on the wire (``USD``).
    currency = models.CharField(max_length=3)
    # Card only: where the hosted checkout sends the browser afterwards.
    return_url = models.TextField(blank=True, default="")
    # What the app needs to open the rail's surface (``checkout_url`` for
    # card), returned verbatim in the response's ``rail_data``.
    rail_data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField()
    credited_at = models.DateTimeField(null=True, blank=True)
    credited_milli_2z = models.BigIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["creator", "created_at"], name="purchases_int_creator_idx"),
            models.Index(fields=["status", "expires_at"], name="purchases_int_status_exp_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=[s.value for s in Status]),
                name="purchases_intent_status_known",
            ),
            models.CheckConstraint(
                condition=models.Q(rail__in=[r.value for r in Rail]),
                name="purchases_intent_rail_known",
            ),
            models.CheckConstraint(
                condition=models.Q(platform__in=[p.value for p in Platform]),
                name="purchases_intent_platform_known",
            ),
            models.CheckConstraint(
                condition=models.Q(quantity_2z__gte=1),
                name="purchases_intent_quantity_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(price_minor__gte=1),
                name="purchases_intent_price_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("created_at")),
                name="purchases_intent_expires_after_created",
            ),
            # Credited at least once <=> the credit fields are set.
            models.CheckConstraint(
                condition=(
                    models.Q(
                        status__in=_CREDITED_VALUES,
                        credited_at__isnull=False,
                        credited_milli_2z__gte=1,
                        # Explicit: `NULL >= 1` is UNKNOWN, and a CHECK
                        # passes on UNKNOWN.
                        credited_milli_2z__isnull=False,
                    )
                    | (
                        ~models.Q(status__in=_CREDITED_VALUES)
                        & models.Q(credited_at__isnull=True, credited_milli_2z__isnull=True)
                    )
                ),
                name="purchases_intent_credit_consistent",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.id} {self.rail} {self.quantity_2z} {self.status}"

    @property
    def wire_rail(self) -> str:
        return WIRE_RAIL[Rail(self.rail)]

    def transition(self, new: str, **fields) -> None:
        """Move to ``new`` along a legal edge, atomically, compare-and-swap.

        ``fields`` are written in the same ``UPDATE`` (``credited_at``,...).
        Raises:class:`InvalidTransition` when the edge is not legal from the
        in-memory status, or when the row is no longer in that status.
        """
        current = self.status
        if not can_transition(current, new):
            raise InvalidTransition(self.pk, current, new)
        now = timezone.now()
        updated = PurchaseIntent.objects.filter(pk=self.pk, status=current).update(
            status=new, updated_at=now, **fields,
        )
        if updated != 1:
            actual = (
                PurchaseIntent.objects.filter(pk=self.pk)
                .values_list("status", flat=True)
                .first()
            )
            raise InvalidTransition(self.pk, actual, new)
        self.status = new
        self.updated_at = now
        for name, value in fields.items():
            setattr(self, name, value)

    def is_past_expiry(self, now=None) -> bool:
        return (now or timezone.now()) >= self.expires_at


class PurchaseReceipt(models.Model):
    """One payment that credited (or will credit) an intent: one *line*
    (spec §1.2 "one line per payment that credited it").

    ``provider_event_id`` is the payment's identity on its rail, unique per
    rail so no payment can attach to two intents: the Stripe PaymentIntent id
    (``pi_...``, the same identity ``StripeTransaction.stripe_charge_id`` is
    unique on and the ledger credit is keyed on), later ``txid:pool:index``
    for a Zcash output or the store's transaction id for IAP.

    ``ledger_ref_kind`` / ``ledger_ref_id`` name the receipt row the LEDGER
    journal attributes the credit to (``stripe_transaction:<pk>`` for card,
    the reference ``ztripe.fulfillment`` has always posted). A card
    ``PurchaseReceipt`` therefore credits nothing itself; it links the
    intent to the credit that already exists, so R11's receipt-to-journal
    attribution must follow these two fields, never ``purchase_receipt:<pk>``.
    """

    intent = models.ForeignKey(
        PurchaseIntent,
        on_delete=models.PROTECT,
        related_name="receipts",
    )
    rail = models.CharField(max_length=16, choices=Rail.choices)
    provider_event_id = models.CharField(max_length=255)
    amount_minor = models.PositiveIntegerField()
    currency = models.CharField(max_length=3)
    credited_milli_2z = models.BigIntegerField()
    ledger_ref_kind = models.CharField(max_length=32)
    ledger_ref_id = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["rail", "provider_event_id"],
                name="purchases_receipt_rail_event_uniq",
            ),
            models.CheckConstraint(
                condition=models.Q(rail__in=[r.value for r in Rail]),
                name="purchases_receipt_rail_known",
            ),
            models.CheckConstraint(
                condition=models.Q(credited_milli_2z__gte=0),
                name="purchases_receipt_credit_nonnegative",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.rail}:{self.provider_event_id} -> {self.intent_id}"
