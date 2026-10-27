"""The relay half of the Pub/Sub transactional outbox.

``models.OutboxMessage`` is the promise; this module is the only thing that
keeps it. Producers call:func:`enqueue` inside their own transaction and
never touch Pub/Sub;:func:`drain` publishes and stamps ``published_at``.

THE ONE INVARIANT
-----------------
**No database transaction is ever held across a Pub/Sub call.** That is the
whole point of, so the relay does not simply hold ``SELECT... FOR
UPDATE`` while it publishes (which is the textbook relay, and would move the
connection-holding problem from a web worker to a queue worker rather than
removing it). It runs three phases instead:

1. **claim** -- one short transaction: lock the due rows with
   ``FOR UPDATE SKIP LOCKED``, bump ``attempts``, and push
   ``next_attempt_at`` out by:data:`LEASE_SECONDS`. That timestamp IS the
   lease, and it must cover the WHOLE pass, not one publish: the last row of
   a batch can start publishing an instant before the pass's budget expires
   and then run for the full publish timeout.
2. **publish** -- no transaction at all. One ``publish()`` per row, waited on
   with a bounded timeout, and the pass stops starting new publishes once
   :data:`DRAIN_BUDGET_SECONDS` is spent (rows it never attempted are handed
   straight back, un-attempted, and the pass re-defers).
3. **settle** -- one short transaction per row: stamp ``published_at``, or
   record ``last_error`` and shorten the lease to the row's own backoff.

The lease timestamp doubles as an OWNERSHIP TOKEN. Every write that could
pull a row out from under another relay -- the release of an unattempted row,
the shortening of a lease after a failure -- is conditioned on
``next_attempt_at`` still being the value THIS pass wrote, so a pass that
stalled past its own lease and then resumed writes nothing. Stamping
``published_at`` is deliberately exempt: if a stale pass published anyway,
the message went out and recording that is what stops the new owner sending
it again.

A relay killed between 2 and 3 republishes after the lease expires. That is
at-least-once by construction; ``models.OutboxMessage`` says exactly which
consumers survive it and which do not.

ORDERING
--------
:func:`due_messages` excludes any row that has an earlier unpublished row
with the same non-empty ``ordering_key``. Two consequences fall out of that
single filter: at most one row per ordering key is ever in flight, and a row
that keeps failing blocks its own successors instead of letting a later
message overtake it. Rows with an empty ordering key are unordered and all
eligible.

BACKOFF is deterministic (no jitter): the relay is single-flight through a
Procrastinate ``queueing_lock``, so there is no herd to spread out, and a
deterministic schedule is one a test can assert on.

RETENTION is deliberately one-way. ``prune_published`` only considers rows
with a non-null ``published_at`` and a null ``dedup_key``. Unpublished rows --
including rows retrying or holding a lease in ``next_attempt_at`` -- remain
available to the relay. Keyed published rows remain permanently so a repeated
producer request cannot create a new promise after cleanup; unkeyed published
payloads are retained for ``PUBLISHED_RETENTION_DAYS`` and removed in one
bounded batch per periodic sweep.

UNITS: every duration here is **seconds**.
"""
from __future__ import annotations

import json
import logging
import time

from django.conf import settings
from django.db import DatabaseError, connection, transaction
from django.db.models import Exists, F, OuterRef, Q
from django.utils import timezone

from gcp.pubsub import client as pubsub_client
from gcp.pubsub.client import PubSubClient

from .models import OutboxMessage

logger = logging.getLogger(__name__)

#How many rows one relay pass claims. Bounded so a backlog cannot turn one
#job into an unbounded run holding a worker slot forever; the relay
#re-defers itself while more rows are due.
BATCH_SIZE = int(getattr(settings, 'PUBSUB_OUTBOX_BATCH_SIZE', 100))

#Per-message wait on the publish future. Generous compared with the 2s the
#webhook path used to allow, precisely because this no longer runs on a
#request: nothing is waiting on it and no web connection is held.
PUBLISH_TIMEOUT_SECONDS = float(
    getattr(settings, 'PUBSUB_OUTBOX_PUBLISH_TIMEOUT_SECONDS', 30.0))

#First retry delay. Also the lease held by a claim, so it must be long
#enough that a slow publish is not republished underneath itself:
#comfortably longer than PUBLISH_TIMEOUT_SECONDS.
RETRY_BASE_SECONDS = float(
    getattr(settings, 'PUBSUB_OUTBOX_RETRY_BASE_SECONDS', 60.0))

#Backoff ceiling. There is deliberately NO attempt cap: a capped outbox
#silently drops a promised message, and the backlog alert below is the
#thing that should page instead.
#
#The one case that never resolves itself -- a permanent refusal
#(``NotFound``, ``PermissionDenied``, ``InvalidArgument``), which
#``bounded_retry`` correctly does not retry -- would otherwise retry here
#forever and re-page every 30 minutes with no sanctioned remedy. Its
#terminal state is the ``outbox_abandon`` management command, which
#refuses any row that still has a chance and logs the whole row before
#deleting it. See that module and the backlog alert's runbook.
RETRY_MAX_SECONDS = float(
    getattr(settings, 'PUBSUB_OUTBOX_RETRY_MAX_SECONDS', 3600.0))

#Wall clock one relay pass may spend PUBLISHING, before it stops starting
#new publishes, hands the rest back and returns. NOT the same bound as
#BATCH_SIZE: 100 rows x PUBLISH_TIMEOUT_SECONDS is 3000s of one worker slot,
#and the old image-variant-worker ran concurrency 1 across billing, default,
#detect, images, search, search-multilingual and translation -- so an
#unbounded pass turned a Pub/Sub slowdown into a 50-minute outage of every
#other background job, including the health sweep and the reclaimer. The
#relay now has the dedicated `pubsub` worker lane.
#A healthy publish is milliseconds, so this never fires in the good case.
DRAIN_BUDGET_SECONDS = float(
    getattr(settings, 'PUBSUB_OUTBOX_DRAIN_BUDGET_SECONDS', 45.0))

#Worst case for ONE row, and every term is bounded on purpose:
#``get_topic`` + ``create_topic`` (synchronous, before the future exists,
#so ``future.result(timeout=)`` bounds neither -- the SDK's own default is
#a 600s retry deadline each) plus the publish wait itself.
#
#The admin term uses ``ADMIN_CALL_WORST_CASE_SECONDS``, which is TWICE the
#configured timeout, because api-core checks a retry deadline only between
#attempts and resets the per-attempt timeout when little budget is left.
#Using the configured value here would understate the pass by 20s and put
#the lease back inside it. The publish term needs no such doubling: the
#relay's own ``future.result(timeout=PUBLISH_TIMEOUT_SECONDS)`` is what
#bounds the relay's wait, whatever the SDK does underneath.
ROW_WORST_CASE_SECONDS = (
    PUBLISH_TIMEOUT_SECONDS
    + 2 * pubsub_client.ADMIN_CALL_WORST_CASE_SECONDS)

#A small allowance after the pass's worst row for the settle UPDATE and
#transaction cleanup. It is intentionally separate from the publish budget
#and row worst case: a successful publish must be recorded before another
#relay can reasonably take the row's lease.
LEASE_SETTLE_MARGIN_SECONDS = float(
    getattr(settings, 'PUBSUB_OUTBOX_LEASE_SETTLE_MARGIN_SECONDS', 5.0))

#The lease a claim takes, and the reason the batch cannot be republished
#underneath itself. The budget is checked BEFORE a row starts, so the last
#row of a batch can begin an instant before the budget expires and then run
#for its whole worst case -- a lease shorter than BUDGET + ROW_WORST_CASE
#lets a concurrent relay (the periodic sweep is every 2 minutes) claim a row
#this pass is still publishing. That is the one duplicate this design is
#supposed to prevent rather than absorb, and RETRY_BASE_SECONDS alone did
#not: it covers one publish, and only the first row of a batch starts at
#the claim timestamp.
LEASE_SECONDS = (
    DRAIN_BUDGET_SECONDS
    + ROW_WORST_CASE_SECONDS
    + LEASE_SETTLE_MARGIN_SECONDS)

#Age at which an unpublished row is a *problem* rather than in-flight work.
STALE_SECONDS = int(getattr(settings, 'PUBSUB_OUTBOX_STALE_SECONDS', 600))

#`last_error` is operator-facing; a provider traceback can be enormous.
MAX_ERROR_CHARS = 2000

#Unkeyed published payloads contain comment bodies and may contain an
#expired recording URL. Thirty days leaves useful incident history without
#making those copies permanent. Rows with a dedup key are retained forever
#by `prune_published` because deleting their unique promise would reopen an
#idempotency window.
PUBLISHED_RETENTION_DAYS = int(getattr(
    settings, 'PUBSUB_OUTBOX_PUBLISHED_RETENTION_DAYS', 30))

#One cleanup call deletes at most this many rows. The periodic sweep calls
#it once per tick, so a historical backlog is drained over several short
#transactions rather than one large DELETE. This does not bound the number
#of retained rows PostgreSQL may scan; the statement timeout below bounds
#that database work instead.
PRUNE_BATCH_SIZE = int(getattr(
    settings, 'PUBSUB_OUTBOX_PRUNE_BATCH_SIZE', 1000))

#There is intentionally no published_at index yet. A timeout makes this
#best-effort maintenance rather than another source of queue-worker stalls.
PRUNE_STATEMENT_TIMEOUT_SECONDS = float(getattr(
    settings, 'PUBSUB_OUTBOX_PRUNE_STATEMENT_TIMEOUT_SECONDS', 1.0))
PRUNE_LOCK_TIMEOUT_SECONDS = float(getattr(
    settings, 'PUBSUB_OUTBOX_PRUNE_LOCK_TIMEOUT_SECONDS', 0.1))

#Marks a `last_error` written for a failure in the pass's PROLOGUE -- the
#claim has committed and the attempt is burned, but no row of the batch
#ever reached `publish()`. Without it an operator reading the row cannot
#tell "Pub/Sub refused this message" from "the relay could not even build a
#client", which are opposite diagnoses: the second one means look at the
#worker/ADC, and it is identical for every row in the batch.
PROLOGUE_ERROR_PREFIX = 'relay prologue, no row was attempted: '

OUTBOX_HEALTH_EVENT = 'pubsub_outbox_health'
OUTBOX_BACKLOG_ALERT = 'outbox_backlog'

#Queue-specific admission keys keep pending jobs from blocking the older
#default-queue relay during rollback (Procrastinate locks are global across
#queues). The old version retains its legacy keys. This bounds *queued* duplicates; the FOR UPDATE SKIP
#LOCKED claim is what makes two concurrently RUNNING relays safe.
RELAY_QUEUEING_LOCK = 'jobs-outbox-publish-pubsub'

#The periodic sweep's own lock, deliberately NOT the relay's. Sharing one
#would let a pending relay pass suppress the sweep -- and the sweep also
#emits the backlog health line the alert policy matches on, so suppressing
#it during a backlog silences the alert for the backlog.
SWEEP_QUEUEING_LOCK = 'jobs-outbox-sweep-pubsub'


def enqueue(
    topic: str,
    payload: dict,
    *,
    ordering_key: str = '',
    attributes: dict | None = None,
    ensure_topic: bool = False,
    dedup_key: str | None = None,
    using: str | None = None,
    wake_up: bool = True,
) -> OutboxMessage:
    """Promise to publish ``payload`` to ``topic``, transactionally.

    MUST be called from inside the transaction that makes the domain change
    the message describes. The row and the change then commit or roll back
    together, which is the entire guarantee.

    ``dedup_key`` collapses duplicate promises **in the database**. A second
    ``enqueue`` with a key that already exists is a NO-OP insert: it returns
    the row that is already there and creates nothing, so exactly one message
    ever goes out for that key. The collapse has to happen here, under a
    UNIQUE index, because the producers that need it are concurrent -- an
    application-level ``exists()`` check is a read both copies pass (that is
    literally the ``g12f.notify_published_zpage`` defect  is about).

    The RETURNED ROW MAY THEREFORE BE OLDER THAN THIS CALL, and may already
    be published: with a dedup key, "I enqueued it" means "the message for
    this key is promised", not "this payload is what will be sent". A caller
    whose payload changes between duplicates must put the varying part into
    the key. ``dedup_key=None`` (the default) opts out entirely; an empty
    string is refused, because ``''`` is a single value in a UNIQUE index
    and would collapse the whole table, whereas every NULL is distinct.

    The relay job is deferred from ``transaction.on_commit`` so a rolled-back
    producer never wakes a worker, and so the worker cannot look for a row
    its own snapshot cannot see yet. If that defer fails or its process dies,
    the periodic sweep picks the row up -- ``on_commit`` is the latency
    optimisation, never the delivery guarantee. ``wake_up=False`` lets a
    producer arrange its own bounded wake-up; the periodic sweep still
    guarantees recovery.
    """
    if dedup_key is not None and not dedup_key:
        raise ValueError(
            "dedup_key must be a non-empty string or None: '' is one value "
            'in a UNIQUE index and would collapse every keyed row into one, '
            'while NULL means "no deduplication" and is always distinct.')

    fields = {
        'topic': topic,
        'payload': payload,
        'attributes': attributes or {},
        'ordering_key': ordering_key,
        'ensure_topic': ensure_topic,
    }
    if dedup_key is None:
        message = OutboxMessage.objects.using(using).create(
            dedup_key=None, **fields)
    else:
        # get_or_create wraps its INSERT in a savepoint and re-reads on
        # IntegrityError, so a racing producer that commits first is
        # resolved by the index rather than by a check-then-act -- and the
        # caller's own transaction stays usable, which a bare
        # `except IntegrityError` around a plain create() would not.
        message, _created = OutboxMessage.objects.using(using).get_or_create(
            dedup_key=dedup_key, defaults=fields)

    # When enabled, defer even on a collapsed duplicate: the
    # first producer's defer may itself have failed (see `defer_relay`), and
    # a redundant relay pass is free -- it claims nothing and returns.
    if wake_up:
        transaction.on_commit(defer_relay, using=using)
    return message


def defer_relay() -> None:
    """Wake a relay pass. MUST NOT raise -- it runs from ``on_commit``.

    The imports are GUARDED, in their own try, for the same reason the defer
    is. They are deferred (a module-level ``from. import tasks`` is a
    circular import at app-load time), so they run here -- *after* COMMIT,
    from a callback whose caller has already made its promise durable. If a
    procrastinate bump moved ``AlreadyEnqueued``, an ImportError out of this
    function would 500 the Dyte webhook on a delivery claim that is already
    committed, which is precisely the "never let queue trouble fail a
    committed producer" guarantee this function exists to make. Verified
    present in the pinned 3.9.0, so this is a fence, not a live bug.

    They need their OWN try: ``except AlreadyEnqueued`` names a symbol the
    import binds, so an import failure inside the same try would raise
    NameError while evaluating the handler and escape anyway.
    """
    try:
        from procrastinate.exceptions import AlreadyEnqueued

        from . import tasks
    except Exception:
        logger.exception('outbox: could not import the relay job to defer it')
        return

    try:
        tasks.publish_outbox_task.configure(
            queueing_lock=RELAY_QUEUEING_LOCK,
        ).defer()
    except AlreadyEnqueued:
        # A relay pass is already waiting to run; it will see this row too.
        pass
    except Exception:
        # Never let queue trouble fail a committed producer -- the row is
        # already durable and the periodic sweep is the backstop.
        logger.exception('outbox: could not defer the relay job')


def backoff_seconds(attempts: int) -> float:
    """Delay before attempt number ``attempts + 1``.

    ``attempts`` is the post-increment count, so the first failure waits
    ``RETRY_BASE_SECONDS``.
    """
    exponent = max(int(attempts) - 1, 0)
    # Cap the exponent before shifting: 2 ** 10_000 is a real number in
    # Python and computing it to then throw it away is not free.
    exponent = min(exponent, 32)
    return min(RETRY_BASE_SECONDS * (2 ** exponent), RETRY_MAX_SECONDS)


def prune_published(*, limit: int | None = None, now=None) -> int:
    """Delete one bounded batch of expired, unkeyed published rows.

    The candidate query limits the rows returned and deleted, but not the
    number of retained rows PostgreSQL may scan because published_at has no
    index. On PostgreSQL, short local statement and lock timeouts make the
    scan best effort. A timeout or other database failure is logged and
    ignored so health emission and delivery continue in the same sweep.

    The second predicate set is a compare-and-check: a row is only deleted if
    it is still published and unkeyed when the delete runs. In particular, a
    retrying or leased row has ``published_at IS NULL`` and cannot match.

    ``published_at`` is the retention clock, not ``created_at``. A slow row
    remains available until it has actually been accepted by Pub/Sub, then
    receives the full retention horizon.
    """
    limit = PRUNE_BATCH_SIZE if limit is None else limit
    if limit < 1:
        raise ValueError('prune limit must be at least one row')
    now = now or timezone.now()
    cutoff = now - timezone.timedelta(days=PUBLISHED_RETENTION_DAYS)
    try:
        with transaction.atomic():
            if connection.vendor == 'postgresql':
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT set_config('statement_timeout', %s, true)",
                        [f'{max(PRUNE_STATEMENT_TIMEOUT_SECONDS, 0.001)}s'],
                    )
                    cursor.execute(
                        "SELECT set_config('lock_timeout', %s, true)",
                        [f'{max(PRUNE_LOCK_TIMEOUT_SECONDS, 0.001)}s'],
                    )
            ids = list(
                OutboxMessage.objects.filter(
                    published_at__isnull=False,
                    published_at__lt=cutoff,
                    dedup_key__isnull=True,
                )
                .order_by('pk')
                .values_list('pk', flat=True)[:limit]
            )
            if not ids:
                return 0
            deleted, _details = OutboxMessage.objects.filter(
                pk__in=ids,
                published_at__isnull=False,
                published_at__lt=cutoff,
                dedup_key__isnull=True,
            ).delete()
            if deleted:
                logger.info(
                    'outbox: pruned %s published rows older than %s days',
                    deleted, PUBLISHED_RETENTION_DAYS,
                )
            return deleted
    except DatabaseError:
        logger.exception(
            'outbox: published retention prune skipped after database failure'
        )
        return 0


def due_messages(now=None):
    """Queryset of rows eligible to publish right now, oldest first.

    Excludes any row whose non-empty ordering key already has an earlier
    unpublished row: that earlier row is the head of the line, and until it
    is published (or is itself claimable) nothing behind it may go out.
    """
    now = now or timezone.now()
    earlier_sibling = OutboxMessage.objects.filter(
        published_at__isnull=True,
        ordering_key=OuterRef('ordering_key'),
        id__lt=OuterRef('id'),
    )
    return (
        OutboxMessage.objects
        .filter(published_at__isnull=True, next_attempt_at__lte=now)
        .annotate(_has_earlier=Exists(earlier_sibling))
        .filter(Q(ordering_key='') | Q(_has_earlier=False))
        .order_by('id')
    )


def _claim(limit: int, now):
    """Phase 1. Short transaction, no network.

    Returns ``(rows, lease_until)``. ``lease_until`` is the exact
    ``next_attempt_at`` this pass wrote on every row it claimed, and it is
    the pass's OWNERSHIP TOKEN: no column and no migration, because the lease
    timestamp already distinguishes one claim from another (two passes claim
    at different ``now``, and ``FOR UPDATE SKIP LOCKED`` stops them claiming
    the same row at the same instant). Every later write this pass makes to a
    row it does not otherwise know it still owns is conditioned on it.
    """
    with transaction.atomic():
        rows = list(
            due_messages(now)
            .select_for_update(skip_locked=True)
            [:limit]
        )
        lease_until = now + timezone.timedelta(seconds=LEASE_SECONDS)
        for row in rows:
            row.attempts += 1
            # The LEASE, not the backoff. The backoff is applied by
            # `_settle_failure`, which runs once the row is definitively no
            # longer in flight and can therefore shorten the lease safely.
            row.next_attempt_at = lease_until
        if rows:
            OutboxMessage.objects.bulk_update(
                rows, ['attempts', 'next_attempt_at'])
    return rows, lease_until


def _release(rows, now, lease_until) -> int:
    """Hand back rows this pass claimed but never attempted.

    Only ever called for rows the budget cut off BEFORE their publish
    started, so nothing is in flight for them: give the burned attempt back
    (it drives the backoff, and a row nobody tried must not back off) and
    make them due immediately for the pass this one re-defers.

    FENCED on ``next_attempt_at=lease_until``. Without that, a pass that
    stalled past its own lease -- a paused container, a long GC, a rolling
    deployment -- could resume, hit its deadline and hand back rows a LATER
    relay had since claimed and was actively publishing: it would decrement
    that relay's attempt count and make its in-flight rows immediately
    claimable, producing exactly the concurrent publish the lease exists to
    prevent. A stale owner now matches zero rows and writes nothing.
    """
    pks = [row.pk for row in rows]
    if not pks:
        return 0
    return OutboxMessage.objects.filter(
        pk__in=pks, published_at__isnull=True, attempts__gt=0,
        next_attempt_at=lease_until,
    ).update(attempts=F('attempts') - 1, next_attempt_at=now)


def _settle_success(row, now) -> None:
    """Phase 3, success. Compare-and-set on ``published_at``.

    The ``published_at__isnull=True`` predicate means a row another relay
    already settled is not re-stamped with a later time, so the timestamp
    stays the moment Pub/Sub first accepted the message.

    Deliberately NOT fenced on the lease, unlike `_release` and
    `_settle_failure`. If this pass lost its lease and published anyway, the
    message DID go out; recording that is what stops the new owner sending it
    a second time. Refusing the write because the lease moved would throw
    away the one fact worth keeping.
    """
    OutboxMessage.objects.filter(
        pk=row.pk, published_at__isnull=True,
    ).update(published_at=now, last_error='')


def _settle_failure(row, exc, lease_until, *, prefix: str = '') -> None:
    """Phase 3, failure. Also SHORTENS the lease to the row's own backoff.

    The claim leased the row for LEASE_SECONDS because it might have been in
    flight for that long. It is not any more -- we have the exception -- so
    the retry can honour RETRY_BASE_SECONDS instead of waiting out a lease
    that exists to cover a batch this row is no longer part of.

    FENCED, for the same reason as `_release`: shortening a lease this pass
    no longer holds would pull a row out from under the relay that does hold
    it. A stale owner's failure is not news about the current attempt.

    ``prefix`` is prepended to ``last_error`` so a failure that never
    reached the wire (see:data:`PROLOGUE_ERROR_PREFIX`) does not read like
    a refusal from Pub/Sub.
    """
    OutboxMessage.objects.filter(
        pk=row.pk, published_at__isnull=True, next_attempt_at=lease_until,
    ).update(
        last_error=f'{prefix}{type(exc).__name__}: {exc}'[:MAX_ERROR_CHARS],
        next_attempt_at=timezone.now() + timezone.timedelta(
            seconds=backoff_seconds(row.attempts)),
    )


def drain(*, limit: int | None = None, now=None, client=None) -> dict:
    """Publish one bounded batch. Returns a summary dict.

    ``client`` exists for the caller that already built a ``PubSubClient``;
    tests patch:data:`PubSubClient` in this module instead, which is the
    real external boundary.
    """
    limit = BATCH_SIZE if limit is None else limit
    now = now or timezone.now()
    # THE BUDGET CLOCK STARTS WITH THE LEASE, not at the top of the publish
    # loop, and the two are anchored to the same instant on purpose.
    # ``LEASE_SECONDS`` = ``DRAIN_BUDGET_SECONDS + ROW_WORST_CASE_SECONDS``
    # is measured from ``now``, so every second between taking the lease and
    # starting a publish is a second of the lease already spent. Two things
    # sit in that gap and neither is bounded by anything in this module: the
    # claim transaction, and above all ``PubSubClient()``, which builds a
    # PublisherClient *and* a SubscriberClient -- two ADC/metadata-server
    # credential fetches and two gRPC channels, seconds to tens of seconds
    # on a degraded metadata server.
    #
    # Anchoring the deadline after that prologue would make the pass's real
    # worst case ``t_prologue + BUDGET + ROW_WORST_CASE``, overrunning the
    # lease by exactly ``t_prologue``: a sweep two minutes later finds the
    # last row of the batch due, claims it and publishes it a SECOND time
    # while this pass is still publishing it. Without consumer claims, that
    # would be a second tweet from ``tweet_comments`` and a second billed
    # tagging call from ``tag_comments``. The independent durable claims in
    #  protect those consumer side effects even though this relay remains
    # at-least-once.
    #
    # Monotonic, because a wall-clock deadline is not a deadline if NTP
    # steps the clock backwards mid-batch.
    deadline = time.monotonic() + DRAIN_BUDGET_SECONDS

    rows, lease_until = _claim(limit, now)
    if not rows:
        return {
            'claimed': 0, 'attempted': 0, 'published': 0, 'failed': 0,
            'released': 0, 'more': False,
        }

    if client is None:
        try:
            client = PubSubClient()
        except Exception as exc:
            # THE CLAIM HAS ALREADY COMMITTED, so dying here is not free:
            # every row of the batch carries a burned attempt and this
            # pass's lease. Letting the exception out unsettled produced
            # three wrong behaviours at once, all of them during exactly the
            # incident that causes it (broken ADC / a wedged metadata
            # server / a revoked workload-identity binding, which is the
            # same class `bounded_retry`'s PermissionDenied case exists
            # for):
            #
            # 1. `last_error` stayed EMPTY forever while `attempts` climbed.
            #    The backlog runbook's triage table reads exactly those two
            #    columns, and that combination is in neither of its rows --
            #    it is the one case where "look at the worker, not at
            #    Pub/Sub" is the correct answer and nothing said so.
            # 2. `outbox_abandon` refuses any row with an empty
            #    `last_error`, with no override, so the terminal state was
            #    unreachable for the one failure mode that produces it.
            # 3. The retry ladder was bypassed entirely: RETRY_BASE ->
            #    RETRY_MAX is only reachable through `_settle_failure`, so
            #    the batch came back on the flat lease every LEASE_SECONDS
            #    and rewrote 100 rows for the whole outage instead of
            #    backing off to the RETRY_MAX_SECONDS ceiling.
            #
            # Settle rather than `_release`: the attempt is real (it failed
            # before the wire, but it failed), and burning it is what makes
            # the backoff climb. A batch of identical prologue errors is
            # also the clearest possible signal that the fault is shared and
            # not per-message.
            for row in rows:
                _settle_failure(
                    row, exc, lease_until, prefix=PROLOGUE_ERROR_PREFIX)
            logger.exception(
                'outbox: could not build a Pub/Sub client; released the '
                'lease on %s claimed rows with the error recorded',
                len(rows),
            )
            # Re-raised on purpose: the pass really did fail, and a failed
            # Procrastinate job is what `procrastinate-jobs-failed` pages
            # on. Swallowing it would leave the outage visible only in the
            # rows.
            raise

    published = failed = 0
    for index, row in enumerate(rows):
        if time.monotonic() >= deadline:
            # Out of budget. Give back everything not yet attempted rather
            # than holding the worker slot, and say `more` so the caller
            # re-defers. Nothing is lost: the rows are due immediately again.
            #
            # `index == 0` is the degenerate case where the prologue alone
            # spent the budget: the whole batch is handed back un-attempted.
            # That is the correct outcome and not a livelock -- publishing
            # past the lease is what produces the duplicate tweet, and a
            # prologue that long is itself the incident the backlog alert
            # exists to page on.
            released = _release(rows[index:], now, lease_until)
            logger.warning(
                'outbox: pass hit its %ss budget with %s of %s rows '
                'unattempted; released them and re-deferring',
                DRAIN_BUDGET_SECONDS, len(rows) - index, len(rows),
            )
            return {
                # `claimed` is how many rows this pass took the lease on, in
                # EVERY return path; `attempted` is how many it got to. They
                # differ only here, and conflating them made the one summary
                # an operator reads during a backlog mean two things.
                'claimed': len(rows),
                'attempted': index,
                'published': published,
                'failed': failed,
                'released': released,
                'more': True,
            }
        try:
            future = client.publish(
                row.topic,
                row.payload,
                ensure_topic=row.ensure_topic,
                attributes=row.attributes,
                # Bounds the publish RPC itself, not just our wait on it.
                # A publisher future cannot be cancelled, so without this a
                # message could still be accepted long after we recorded the
                # attempt as failed and re-scheduled the row.
                timeout=PUBLISH_TIMEOUT_SECONDS,
            )
            # `publish()` returns before the message is durably accepted;
            # only the future's result proves Pub/Sub took it. Waiting here
            # is safe -- this is a queue worker with no open transaction and
            # nothing blocked behind it.
            if future is not None and hasattr(future, 'result'):
                future.result(timeout=PUBLISH_TIMEOUT_SECONDS)
        except Exception as exc:
            failed += 1
            _settle_failure(row, exc, lease_until)
            logger.warning(
                'outbox: publish failed id=%s topic=%s attempts=%s: %s',
                row.pk, row.topic, row.attempts, exc,
            )
            continue
        published += 1
        _settle_success(row, timezone.now())

    return {
        'claimed': len(rows),
        'attempted': len(rows),
        'published': published,
        'failed': failed,
        'released': 0,
        'more': due_messages().exists(),
    }


def health_snapshot(now=None) -> dict:
    """Backlog shape, as a payload the sweep logs and tests assert on."""
    now = now or timezone.now()
    pending = OutboxMessage.objects.filter(published_at__isnull=True)
    unpublished = pending.count()
    oldest = pending.order_by('created_at').values_list(
        'created_at', flat=True).first()
    stale_cutoff = now - timezone.timedelta(seconds=STALE_SECONDS)
    stale = pending.filter(created_at__lte=stale_cutoff).count()
    return {
        'event': OUTBOX_HEALTH_EVENT,
        'unpublished': unpublished,
        'stale': stale,
        'stale_threshold_seconds': STALE_SECONDS,
        'oldest_unpublished_seconds': (
            round((now - oldest).total_seconds()) if oldest else 0),
        'alert': OUTBOX_BACKLOG_ALERT if stale else None,
    }


def log_health(extra: dict | None = None, now=None) -> dict:
    """Emit the one-line JSON health record and return its payload.

    Same shape and reasoning as ``jobs.tasks._log``: GKE parses a log line
    that is entirely JSON into ``jsonPayload`` and honours a top-level
    ``severity``, so the alert decision is made here in Python (unit-testable
    against real Postgres) and the Cloud Monitoring policy only has to match
    ``jsonPayload.alert``.
    """
    payload = health_snapshot(now)
    if extra:
        payload.update(extra)
    severity = 'ERROR' if payload['alert'] else 'INFO'
    body = {
        'severity': severity,
        'message': (
            f'pubsub outbox: unpublished={payload["unpublished"]} '
            f'stale={payload["stale"]} '
            f'oldest_unpublished_seconds='
            f'{payload["oldest_unpublished_seconds"]} '
            f'alert={payload["alert"] or "none"}'
        ),
    }
    body.update(payload)
    logger.log(
        logging.ERROR if severity == 'ERROR' else logging.INFO,
        json.dumps(body, default=str, sort_keys=False),
    )
    return payload


__all__ = [
    'BATCH_SIZE',
    'SWEEP_QUEUEING_LOCK',
    'DRAIN_BUDGET_SECONDS',
    'LEASE_SECONDS',
    'ROW_WORST_CASE_SECONDS',
    'OUTBOX_BACKLOG_ALERT',
    'OUTBOX_HEALTH_EVENT',
    'RELAY_QUEUEING_LOCK',
    'backoff_seconds',
    'defer_relay',
    'drain',
    'due_messages',
    'enqueue',
    'health_snapshot',
    'log_health',
]
