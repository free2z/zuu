"""Idempotency bookkeeping for the 2Z credit paths.

A 2Z-moving POST that the client gave up on is not a 2Z-moving POST that
the *server* gave up on. The subscribe flow's failure mode is exactly that: the
browser aborts at 15s, the request commits at 18s, the user re-clicks, and the
second POST charges again. Nothing in HTTP makes a retry safe — the server has
to remember.

Two independent guards are built on this:

1. ``Subscription.last_charged_at`` — an unconditional, no-cooperation-required
   debounce. Works for a client that has never heard of idempotency keys,
   which is every client we ship today.
2. ``IdempotencyKey`` (this module) — the exact version, for a client that
   sends an ``Idempotency-Key`` header. The same key replays the original
    response instead of doing the work twice, within the published 365-day
    replay horizon.
"""
import hashlib
import json
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, models, transaction
from django.utils import timezone

# A claim with no recorded response, older than this, is assumed abandoned (the
# worker was OOM-killed / the pod evicted between claiming and finishing) and
# may be taken over by a retry. Without it, one crash poisons that key forever
# and the user can never complete the action.
#
# THE INVARIANT THAT MAKES TAKEOVER SAFE -- do not break it:
#
#   `finish()` MUST be called inside the same database transaction as the work
#   it describes.
#
# Then "response_status IS NULL" means "the work did not commit", and taking
# over an abandoned claim can only ever re-run work that never happened. Call
# `finish()` in a separate transaction and a crash in between turns this
# takeover into a second charge -- the exact thing this module exists to
# prevent. (Found by the codex adversarial review of this PR.)
#
# Why 15 minutes, specifically: the takeover is only unsafe against a request
# that is still genuinely running, so this MUST exceed the longest a request
# can possibly live in production. That number is not a guess --
# k8s/free2z/deployment.yaml runs gunicorn with `--timeout 600` (10 minutes),
# so a worker is killed at 600s and a claim older than that provably belongs
# to a dead process. 15 minutes leaves 5 minutes of
# margin for the kill and its rollback.
#
# An earlier revision of this PR used 5 minutes, which is SHORTER than the
# gunicorn timeout: a request blocked on a lock for six minutes could still
# commit its charge after a retry had already "taken over" its claim and
# charged again. Caught by the codex adversarial review. If the gunicorn
# --timeout in the manifest ever grows, this must grow with it.
STALE_CLAIM = timedelta(minutes=15)

# Completed claims for the explicit HTTP money routes are durable retry
# receipts, not permanent profile history. The cleanup command removes only
# those published finite-horizon scopes in bounded batches; unrelated users of
# this shared table may intentionally retain exactly-once markers forever.
# Unfinished claims remain governed by STALE_CLAIM.
COMPLETED_CLAIM_RETENTION = timedelta(days=365)


class DuplicateRequest(Exception):
    """The key was already used.

    ``record.response_status`` is None when the original request is still in
    flight, in which case there is nothing to replay yet.
    """

    def __init__(self, record: "IdempotencyKey"):
        self.record = record
        self.in_flight = record.response_status is None
        super().__init__(f"duplicate request for key {record.key!r}")


class IdempotencyConflict(Exception):
    """The same key was reused for a different logical request."""

    def __init__(self, record: "IdempotencyKey"):
        self.record = record
        super().__init__(f"idempotency key {record.key!r} changed request")


class IdempotencyKey(models.Model):
    """One row per (scope, user, client-supplied key).

    The row is inserted *before* the work happens and committed immediately, so
    a concurrent duplicate collides on the unique constraint rather than racing
    us into a second charge. The response is written back afterwards.
    """

    scope = models.CharField(
        max_length=64,
        help_text="Which operation this key belongs to, e.g. 'subscribe'",
    )
    key = models.CharField(max_length=200)
    # Nullable for compatibility with the older idempotency migration/branch;
    # strict endpoints always provide a hash and fail closed against NULL.
    request_hash = models.CharField(
        max_length=64,
        blank=True,
        null=True,
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="idempotency_keys",
    )
    # For unfinished rows this is the current claim's start/takeover time. On
    # completion ``finish()`` advances it to the completion time, so the same
    # indexed column also anchors the published replay-retention horizon.
    created_at = models.DateTimeField(auto_now_add=True)
    # Whoever currently holds this claim. Rotated on every takeover so a
    # handler can only ever release the claim IT holds -- without this, an
    # original request that outlived its takeover could delete the row out
    # from under the handler that is actively using it, letting a third retry
    # claim the key and charge again. (codex adversarial review.)
    owner = models.UUIDField(default=uuid.uuid4)
    # Null until the operation finishes. Null + old => abandoned.
    response_status = models.PositiveSmallIntegerField(null=True, blank=True)
    response_body = models.JSONField(null=True, blank=True)
    # Explicit subscription recovery is a terminal decision, not an expired
    # claim. Retain it for the published 365-day retry horizon so a retry of
    # the old key cannot turn an authenticated abandonment into another debit
    # during that period; cleanup_idempotency prunes it after the horizon.
    abandoned_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "user", "key"],
                name="idempotency_scope_user_key_uniq",
            ),
        ]
        indexes = [models.Index(fields=["created_at"])]

    def __str__(self) -> str:
        return f"{self.scope}:{self.user_id}:{self.key}"

    def finish(self, status: int, body=None) -> None:
        """Record the result. Only the current owner may do so."""
        completed_at = timezone.now()
        self.response_status = status
        self.response_body = body
        self.created_at = completed_at
        owned = IdempotencyKey.objects.filter(pk=self.pk, owner=self.owner)
        if self.scope == "ai_image":
            from dj.apps.openai.image_receipts import update_image_receipt
            updated, self.response_body = update_image_receipt(
                owned, body, response_status=status, created_at=completed_at,
            )
        else:
            updated = owned.update(
                response_status=status, response_body=body, created_at=completed_at,
            )
        if not updated:
            raise DuplicateRequest(
                IdempotencyKey.objects.get(pk=self.pk))


class SubscriptionIntentAbandonment(models.Model):
    """A retained same-creator fence for an explicitly abandoned intent.

    Idempotency receipts are payer-scoped, while the browser's legacy slot was
    shared by accounts.  This immutable creator/key fence keeps an old bundle
    from presenting the abandoned key as a new payer's request.  It contains
    no purchase result and is never returned to a different payer.
    """

    creator_id = models.BigIntegerField()
    key = models.CharField(max_length=200)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="subscription_intent_abandonments",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["creator_id", "key"],
                name="subscription_intent_abandonment_uniq",
            ),
        ]


class SubscriptionIntentEvidence(models.Model):
    """Retained server evidence that a subscription claim released unpaid.

    A 402 is retryable, so it is not an abandonment and does not fence the
    key. Keeping this payer/creator binding lets the original payer later
    choose authenticated abandonment without trusting browser storage alone.
    Resolution and abandonment are retained state transitions, not deletions.
    """

    creator_id = models.BigIntegerField()
    key = models.CharField(max_length=200)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="subscription_intent_evidence",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    abandoned_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(
            fields=["creator_id", "user", "key"],
            name="subscription_intent_evidence_uniq",
        )]


class ProviderReservation(models.Model):
    """A short-lived authorization hold for an externally billed operation.

    The amount is removed from the user's spendable balance while provider I/O
    runs, but the Creator row lock is held only while this row is created. A
    successful operation settles the hold; a failed one releases it. Unfinished
    holds older than ``STALE_CLAIM`` are released by the next reservation for
    that user, which is safe because that bound exceeds the gunicorn timeout.
    """

    ACTIVE = "active"
    SETTLED = "settled"
    RELEASED = "released"
    STATUS_CHOICES = (
        (ACTIVE, "Active"),
        (SETTLED, "Settled"),
        (RELEASED, "Released"),
    )

    scope = models.CharField(max_length=64)
    operation_key = models.UUIDField()
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="provider_reservations",
    )
    amount = models.DecimalField(max_digits=17, decimal_places=3)
    status = models.CharField(
        max_length=8, choices=STATUS_CHOICES, default=ACTIVE
    )
    created_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "user", "operation_key"],
                condition=models.Q(status="active"),
                name="active_provider_reservation_uniq",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user", "status", "created_at"],
                name="tuzis_prov_user_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.scope}:{self.operation_key}:{self.status}"


def fingerprint(payload) -> str:
    """Stable SHA-256 for JSON-compatible 2Z-request identity fields."""
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("ascii")
    return hashlib.sha256(canonical).hexdigest()


def uuid4_key(raw):
    """Return a canonical UUIDv4 string, or ``None`` for invalid input."""
    if raw is None:
        return None
    try:
        parsed = uuid.UUID(str(raw).strip())
    except (AttributeError, TypeError, ValueError):
        return None
    if parsed.version != 4:
        return None
    return str(parsed)


def request_key(request):
    """Read the HTTP idempotency key without accepting silent degradation."""
    return uuid4_key(request.headers.get("Idempotency-Key"))


def claim(
    scope: str,
    user,
    key: str,
    request_hash: str | None = None,
    *,
    initial_body=None,
    allow_stale_takeover=True,
    stale_takeover_requires_matching_hash=False,
) -> IdempotencyKey:
    """Reserve ``key`` for ``user``/``scope`` before doing chargeable work.

    Returns the fresh claim row. Raises ``DuplicateRequest`` if the key was
    already used, carrying the original response so the caller can replay it.

    Must be called *outside* the transaction that moves the 2Z: an
    uncommitted claim is invisible to the concurrent duplicate it exists to
    block.
    """
    try:
        with transaction.atomic():
            return IdempotencyKey.objects.create(
                scope=scope,
                user=user,
                key=key,
                request_hash=request_hash,
                response_body=initial_body,
            )
    except IntegrityError:
        pass

    with transaction.atomic():
        record = (
            IdempotencyKey.objects.select_for_update()
            .filter(scope=scope, user=user, key=key)
            .first()
        )
        if record is None:
            # Lost to a delete (a failed sibling releasing its claim) between
            # the insert and this read. Treat as a fresh request.
            return IdempotencyKey.objects.create(
                scope=scope,
                user=user,
                key=key,
                request_hash=request_hash,
                response_body=initial_body,
            )
        # An UNFINISHED claim older than STALE_CLAIM provably belongs to a dead
        # process (see the constant), and by invariant no 2Z committed under
        # it: every caller finishes the claim inside the same transaction that
        # moves the money. So it is takeable over REGARDLESS of what request it
        # was reserved for -- and that ordering matters, because the hash
        # comparison below is permanent while this row never resolves on its
        # own.
        #
        # Checking the hash FIRST made a changed-fingerprint retry a dead end
        # for good: a worker killed between `claim()`'s own commit and the
        # money transaction leaves a row bound to the OLD fingerprint, and
        # `cleanup_idempotency` only deletes rows that finished, so every later
        # retry at a new price answered 409 `idempotency_mismatch` forever and
        # the fan could never buy that membership from that browser again.
        # Nothing was ever charged under the row being taken over.
        # (Codex/adversarial review of  +.)
        stale_unfinished = (
            allow_stale_takeover
            and
            record.response_status is None
            and timezone.now() - record.created_at > STALE_CLAIM
            and not (
                stale_takeover_requires_matching_hash
                and request_hash is not None
                and record.request_hash != request_hash
            )
        )
        if request_hash is not None and not stale_unfinished:
            if record.request_hash is None:
                # Rows created before request fingerprints were introduced are
                # still valid receipts. Adopt the first compatible retry's
                # hash instead of turning every outstanding key into a 409.
                record.request_hash = request_hash
                record.save(update_fields=["request_hash"])
            elif record.request_hash != request_hash:
                raise IdempotencyConflict(record)
        if stale_unfinished:
            # Take it over AND take ownership, so the previous holder can no
            # longer release it.
            record.created_at = timezone.now()
            record.owner = uuid.uuid4()
            update_fields = ["created_at", "owner"]
            if request_hash is not None:
                record.request_hash = request_hash
                update_fields.append("request_hash")
            record.save(update_fields=update_fields)
            # Expose this request-local fact to provider callers. The claim is
            # now owned by this process, but an earlier holder may already
            # have reached an external provider, so takeover must not itself
            # authorize repeating a billed call.
            record.stale_takeover = True
            return record
        raise DuplicateRequest(record)


def mark_abandoned(record: IdempotencyKey, creator_pk: int) -> bool:
    """Turn the current unfinished claim into a retained terminal receipt.

    The owner token changes in the same row update.  A request that already
    holds the old token can therefore only fail its later ``finish()``; when
    that happens its surrounding money transaction rolls back.
    """
    if record is None:
        return False
    now = timezone.now()
    body = {
        "code": "subscription_intent_abandoned",
        "error": "This subscription attempt was abandoned. Start a new attempt.",
        "key_resolved": True,
        "_creator_pk": creator_pk,
        "_subscription_intent": "abandoned",
    }
    updated = IdempotencyKey.objects.filter(
        pk=record.pk,
        owner=record.owner,
        response_status__isnull=True,
    ).update(
        owner=uuid.uuid4(),
        response_status=409,
        response_body=body,
        abandoned_at=now,
        created_at=now,
    )
    return bool(updated)


def record_subscription_intent_release(
    record: IdempotencyKey, creator_pk: int,
) -> bool:
    """Retain unpaid release evidence while removing the charge claim."""
    if record is None:
        return False
    with transaction.atomic():
        deleted, _ = IdempotencyKey.objects.filter(
            pk=record.pk,
            owner=record.owner,
            response_status__isnull=True,
        ).delete()
        if not deleted:
            return False
        SubscriptionIntentEvidence.objects.get_or_create(
            creator_id=creator_pk,
            user_id=record.user_id,
            key=record.key,
        )
        return True


def mark_subscription_intent_resolved(user, creator_pk: int, key: str) -> None:
    """Retain, but resolve, evidence after the debit commits."""
    SubscriptionIntentEvidence.objects.filter(
        creator_id=creator_pk,
        user=user,
        key=key,
        resolved_at__isnull=True,
        abandoned_at__isnull=True,
    ).update(resolved_at=timezone.now())


def release(record: IdempotencyKey) -> None:
    """Drop an unfinished claim so a genuine retry can proceed.

    Called when the operation failed without moving money: a 400 for
    insufficient funds should not burn the key.
    """
    if record is None:
        return
    # `owner` is the guard: if another handler took this claim over while we
    # were running, it now holds a different token and we must not delete it.
    IdempotencyKey.objects.filter(
        pk=record.pk, owner=record.owner, response_status__isnull=True
    ).delete()


def replay_record_or_release_abandoned(scope: str, user, key: str):
    """Return a stable receipt, or free an abandoned unresolved-target claim.

    A retry whose path username no longer resolves cannot recompute the
    original target-id fingerprint. Completed receipts carry the separate
    unresolved fingerprint needed for replay validation. An unfinished claim
    older than ``STALE_CLAIM`` is nevertheless safe to remove: by invariant,
    no associated 2Z work committed, and any late original ``finish()`` then
    fails and rolls its transaction back.
    """
    with transaction.atomic():
        record = (
            IdempotencyKey.objects.select_for_update()
            .filter(scope=scope, user=user, key=key)
            .first()
        )
        if record is None:
            return None
        if (
            record.response_status is None
            and timezone.now() - record.created_at > STALE_CLAIM
        ):
            record.delete()
            return None
        return record


class ZecCreditReceipt(models.Model):
    """One row per received ZEC note that has had 2Z platform credits issued
    for it. The authoritative "already credited" marker for the on-chain
    purchase path.

    Why this table exists at all
    ---------------------------
    ``g12f.Transaction`` used to serve as both the record of a received note
    *and* the idempotency marker for the credit, and it was wrong for the job
    in two ways:

    1. Its ``txid`` is the primary key, but a single Zcash transaction can pay
       **several** outputs to us. The wallet emits one row per note, so the
       second note of a two-output transaction either raised ``IntegrityError``
       (uncredited, silently) or matched the first row and overwrote the first
       payer's ``creator``/``memo`` (one payer uncredited *and* their record
       destroyed).
    2. It was written in its own autocommit statement, separately from the
       ledger credit. ``AtomicMiddleware`` wraps HTTP writes; a management
       command gets none of that. A crash between the two left the note
       permanently marked processed with nothing credited, and no later cycle
       would ever retry it.

    The identity here is ``(txid, output_index)`` — the identity of a *note*,
    not of a transaction — and the row is created in the **same** database
    transaction as ``ledger.credit`` and the ``BOUGHT_TUZI`` event. Either all
    three exist or none of them do.

    ``g12f.Transaction`` is still written as a human-readable record of the
    note, but it is no longer load-bearing for correctness: a failure to store
    it can no longer prevent, duplicate, or corrupt a credit.
    """

    created_at = models.DateTimeField(auto_now_add=True)

    # Display (RPC) byte order, the same form g12f.Transaction.txid stores.
    txid = models.CharField(max_length=64)
    # Output/action index of the note *within* that transaction. Wallet
    # backends that cannot report one supply 0, which degrades to the old
    # one-note-per-transaction behaviour (under-credit, loudly logged) rather
    # than to a double credit.
    output_index = models.IntegerField(default=0)
    # Shielded pool ("sapling"/"orchard"), or "" when the backend does not
    # report one. `output_index` and `action_index` are POOL-LOCAL, so a
    # transaction with Sapling output 0 and Orchard action 0 holds two
    # different notes that both report index 0. Without the pool in the key
    # the second buyer is written off as an indistinguishable duplicate.
    pool = models.CharField(max_length=16, blank=True, default="")

    creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.PROTECT,
        null=True, blank=True, related_name='zec_credit_receipts',
    )

    # The ZEC that arrived on chain.
    amount_zec = models.DecimalField(max_digits=18, decimal_places=8)
    # The 2Z platform credits issued for it, and the rate used. Null on rows
    # backfilled from history, where the original rate was never recorded.
    tuzis_credited = models.DecimalField(
        max_digits=17, decimal_places=3, null=True, blank=True)
    tuzis_per_zec = models.DecimalField(
        max_digits=20, decimal_places=4, null=True, blank=True)

    # True for rows created by migration tuzis/0003 from pre-existing
    # g12f.Transaction rows. A backfilled receipt asserts only "the old code
    # already saw this note"; it is NOT evidence that 2Z were issued. Use
    # `manage.py audit_zec_credits` to find backfilled notes with no
    # BOUGHT_TUZI event -- those are the ones defect (a) may have eaten.
    backfilled = models.BooleanField(default=False)

    # How deep the note was buried when the 2Z were issued. NULL means "not
    # recorded" -- every row written before this field existed, and every
    # backfilled row. It is forensics, not policy: after the fact it is the
    # only thing that distinguishes a note credited from the mempool from one
    # credited two blocks deep, and those are different amounts of risk.
    confirmations_at_credit = models.IntegerField(null=True, blank=True)

    # True when the 2Z were issued BELOW the confirmation floor in force at
    # the time -- the instant-credit path. Deliberately a stored flag and not
    # `confirmations_at_credit < DEFAULT_MIN_CONFIRMATIONS`: the floor is an
    # env var somebody may change, and a policy change must not silently
    # rewrite history about which credits were taken on trust.
    #
    # This is the column the daily aggregate cap sums over and the column the
    # reorg watch selects on. Both are money decisions, so it must never be
    # derived.
    instant = models.BooleanField(default=False)

    # Set once the note has been re-seen at or above the confirmation floor.
    # An instant credit is at risk only until then, so this is what takes a
    # receipt OFF the reorg watch list. Left NULL forever on notes that were
    # never instant -- they were already deep when they were credited.
    settled_at = models.DateTimeField(null=True, blank=True)

    # Set when an instant-credited note is no longer in the wallet at all --
    # not confirmed, not pending, gone. That is 2Z issued against ZEC we do
    # not have.
    #
    # NOTHING IS AUTO-REVERSED. See `dj.apps.tuzis.zec.watch_instant_credits`
    # for the argument; in short, this signal is derived from a local SQLite
    # file that has already been wrong twice in ways CI could not see, and
    # debiting a creator's balance from it would turn a wallet-restore into
    # money taken from people who did nothing.
    vanished_at = models.DateTimeField(null=True, blank=True)

    # A human looked at the vanish and decided. Until this is set, instant
    # crediting is refused platform-wide: whatever produced one unbacked
    # credit is still true, and the alternative is granting the same attacker
    # (or the same bug) the full per-note cap again every 90 seconds.
    vanish_resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['txid', 'pool', 'output_index'],
                name='unique_zec_credit_per_note',
            ),
        ]
        indexes = [
            # The reorg watch runs every cycle and selects exactly this.
            models.Index(
                fields=['instant', 'settled_at', 'vanished_at'],
                name='zec_instant_watch_idx',
            ),
        ]

    def __str__(self) -> str:
        return f"{self.txid}:{self.output_index}"


class ZecPendingNotice(models.Model):
    """One row per received note the buyer has been told we can see.

    THE PROBLEM THIS SOLVES IS SILENCE, NOT MONEY. A note below the
    confirmation floor is held for roughly three blocks -- about four minutes
    at Zcash's 75-second target -- and until 's follow-up the buyer was
    told nothing at all during it. They had sent real ZEC into a shielded
    address and had no signal of any kind that it had been seen. "Wait, did
    that work?" is the single most expensive four minutes on this platform.

    WHY A TABLE AND NOT JUST AN EVENT. `events.Event` has no uniqueness
    constraint of any kind (checked: no `unique_together`, no
    `UniqueConstraint`, no index beyond the UUID primary key), and the credit
    loop re-reads the same held note every ~90 seconds until it matures. An
    `Event`-only implementation therefore sends the buyer two or three
    identical notifications per purchase, and a slow chain sends dozens. The
    unique constraint here is the thing that makes the notification
    idempotent; the `Event` is written in the same transaction, so a row here
    without the notification it claims to have sent cannot exist.

    It is deliberately NOT `ZecCreditReceipt`. A receipt means 2Z were
    issued; conflating the two would let a notification take the receipt key
    and block the real credit forever.
    """

    created_at = models.DateTimeField(auto_now_add=True)

    # Same identity triple as ZecCreditReceipt: display byte order txid, the
    # shielded pool, and the pool-local output/action index.
    txid = models.CharField(max_length=64)
    pool = models.CharField(max_length=16, blank=True, default="")
    output_index = models.IntegerField(default=0)

    creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE,
        related_name='zec_pending_notices',
    )
    amount_zec = models.DecimalField(max_digits=18, decimal_places=8)
    # How deep the note was when we told them. Purely for reading the log
    # back afterwards.
    confirmations = models.IntegerField(default=0)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['txid', 'pool', 'output_index'],
                name='unique_zec_pending_notice_per_note',
            ),
        ]

    def __str__(self) -> str:
        return f"{self.txid}:{self.output_index}"


class ZecMemoDisposition(models.Model):
    """One durable observation and optional human disposition.

    This is deliberately separate from:class:`ZecCreditReceipt`. A row says
    that a received note could not be routed -- an unreadable purchase memo,
    or  a page memo naming a zPage that does not exist -- and an
    optional decision says that an operator has dealt with that observation;
    neither ever says
    that 2Z were issued or acts as an idempotency marker for a credit. The
    receipt remains the only authority for money.

    Every observation is stored before the capped log trace is emitted, so a
    note suppressed by the cap remains queryable. The first operator decision
    is retained with its reason, identity, and timestamp; the command refuses
    to replace it. Admin is read-only.
    """

    UNPARSEABLE_BUY_2Z = 'unparseable_buy_2z'
    #`credit_pages_unified` received ZEC whose memo is a page-funding
    # instruction (`page_fund` / `page_comment` /...) naming a zPage that
    # does not exist -- a mistyped or deleted page. Nothing can record it on
    # a page, so without this row the payment existed only in a log line.
    PAGE_TARGET_NOT_FOUND = 'page_target_not_found'
    #a memo that visibly names a page action but does not decode or
    # parse. The page-memo counterpart of UNPARSEABLE_BUY_2Z.
    UNPARSEABLE_PAGE_MEMO = 'unparseable_page_memo'
    CLASSIFICATION_CHOICES = [
        (UNPARSEABLE_BUY_2Z, 'Unparseable buy_2z memo'),
        (PAGE_TARGET_NOT_FOUND, 'Page memo names a zPage that does not exist'),
        (UNPARSEABLE_PAGE_MEMO, 'Unparseable page memo'),
    ]
    PAGE_CLASSIFICATIONS = frozenset(
        (PAGE_TARGET_NOT_FOUND, UNPARSEABLE_PAGE_MEMO))

    CREDITED_MANUALLY = 'credited_manually'
    NOT_PURCHASE = 'not_purchase'
    IGNORE = 'ignore'
    # The ZEC was sent back to the payer. Like every decision it is an audit
    # statement, not proof: nothing here moves funds or verifies a refund.
    REFUNDED = 'refunded'
    DECISION_CHOICES = [
        (CREDITED_MANUALLY, 'Credited manually'),
        (NOT_PURCHASE, 'Not a purchase'),
        (IGNORE, 'Ignore'),
        (REFUNDED, 'Refunded'),
    ]

    created_at = models.DateTimeField(auto_now_add=True)

    # Display byte-order transaction id, pool, and pool-local output/action
    # index. The pool is part of the key because Sapling and Orchard both
    # legitimately report index 0 for different notes in one transaction.
    txid = models.CharField(max_length=64)
    pool = models.CharField(max_length=16, blank=True, default='')
    output_index = models.PositiveIntegerField(default=0)

    # Audit data only. This is not read by any ledger or credit path.
    amount_zec = models.DecimalField(max_digits=18, decimal_places=8)
    classification = models.CharField(
        max_length=32,
        choices=CLASSIFICATION_CHOICES,
        default=UNPARSEABLE_BUY_2Z,
        editable=False,
    )
    # What the memo asked for, when it could be read: the page action
    # and the page id it named. This is what an operator needs to refund the
    # payer or record the funding on the page they meant. Audit data only --
    # untrusted, sender-chosen text, truncated, and never read by a money
    # path. Empty for buy_2z observations.
    #
    # `db_default` as well as `default` is DEPLOY SAFETY: the migration lands
    # in prod before the hand-deployed credit loop on the payment host is updated
    #, and an older credit_creators that INSERTs a row without these
    # columns must not hit a NOT NULL violation in that window.
    memo_action = models.CharField(
        max_length=32, blank=True, default='', db_default='')
    memo_target = models.CharField(
        max_length=128, blank=True, default='', db_default='')
    # NULL means the observation is still unresolved and must continue to
    # page. Once set, this is immutable through the supported command.
    decision = models.CharField(
        max_length=24, choices=DECISION_CHOICES, null=True, blank=True)
    operator = models.CharField(max_length=128, blank=True, default='')
    reason = models.TextField(blank=True, default='')
    disposed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['txid', 'pool', 'output_index'],
                name='unique_zec_memo_disposition_per_note',
            ),
            models.CheckConstraint(
                condition=models.Q(amount_zec__gt=0),
                name='zec_memo_disposition_positive_amount',
            ),
        ]
        indexes = [
            models.Index(
                fields=['decision', 'created_at'],
                name='zec_memo_disp_decision_idx',
            ),
        ]

    def __str__(self) -> str:
        pool = self.pool or 'unknown'
        return f"{self.txid}:{pool}:{self.output_index}"


class TuziGrant(models.Model):
    """One operator-issued 2Z platform-credit grant.

    2Z are platform credits, never money: a grant mints spendable platform
    balance, it moves no ZEC and no card funds. It is still a balance
    mutation with no counterparty and no payment behind it, which is exactly
    why it gets a receipt. Before this table the only way to hand an account
    2Z was calling ``ledger.credit`` from a shell -- no reason, no operator,
    no record that it ever happened.

    The only supported write path is ``manage.py grant_tuzis``, which creates
    this row in the SAME transaction as the ``ledger.credit``: either the
    balance moved and the receipt exists, or neither. Admin is read-only.

    ``username`` is a snapshot: a later rename must not rewrite who a
    historical grant was issued to. ``environment`` is what the command
    believed it was running against (namespace + database name), recorded so a
    grant on the wrong database is visible after the fact.
    """

    created_at = models.DateTimeField(auto_now_add=True)
    creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.PROTECT, related_name='tuzi_grants',
    )
    username = models.CharField(max_length=150)
    amount = models.DecimalField(max_digits=17, decimal_places=3)
    balance_after = models.DecimalField(max_digits=17, decimal_places=3)
    reason = models.TextField()
    operator = models.CharField(max_length=128)
    environment = models.CharField(max_length=128)
    # Empty when the operator did not pass --idempotency-key. The exactly-once
    # marker itself is the shared ``IdempotencyKey`` row (scope ``tuzi-grant``);
    # this copy is for reading the audit trail without a join.
    idempotency_key = models.CharField(max_length=200, blank=True, default='')

    class Meta:
        ordering = ['-created_at']
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0),
                name='tuzi_grant_positive_amount',
            ),
        ]

    def __str__(self) -> str:
        return f"{self.username} +{self.amount} by {self.operator}"
