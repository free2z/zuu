"""
Procrastinate tasks for the g12f app (autodiscovered via
procrastinate.contrib.django, PROCRASTINATE_AUTODISCOVER_MODULE_NAME
default "tasks").

publish_zpage replaces the publish_pages */5 CronJob sweep: the
zPage post_save signal (signals.py) defers a job with
schedule_at=publish_at, so pages publish at their exact scheduled time
instead of up to five minutes late.

renew_subscription replaces the renew_subs hourly CronJob sweep (
phase 3, money path): the Subscription post_save signal defers a job on
the 'billing' queue with schedule_at=expires - RENEWAL_LEAD, so each
sub renews at the exact moment the old sweep semantics say it becomes
renewable, with an idempotency guard against duplicate-job double
charges ( class).

Design choice — no job cancellation. The DB at execution time is the
source of truth, not the queue at enqueue time: the task re-checks
(is_published=False AND publish_at <= now) with a single
compare-and-set UPDATE. Stale jobs left behind by an edited or cleared
publish_at, duplicate jobs from repeated saves, and the transitional
hourly cron sweep are all harmless no-ops, so there is nothing to
cancel.
"""
import logging
from datetime import timedelta, timezone as dt_timezone

from django.db import connection, transaction
from django.db.models import Case, DateTimeField, F, Value, When
from django.utils import timezone

from procrastinate import RetryStrategy
from procrastinate.contrib.django import app

from dj.apps.jobs.priorities import INTERACTIVE
from procrastinate.exceptions import AlreadyEnqueued

logger = logging.getLogger(__name__)

#Queue for language detection ( M4). Its own queue, not ``default``:
#these jobs make a provider call and can sit for tens of seconds behind a
#timeout, while ``default`` carries publish/notify work that is
#latency-sensitive to the minute. The worker Deployment
#(``k8s/free2z/worker/worker_deployment.yaml``) passes no ``--queues``, so it
#consumes every queue and a new name needs no deploy change -- verified
#before choosing this, because a task on a queue nobody consumes is a job
#that never runs and never alerts.
DETECTION_QUEUE = "detect"

#Whole-job budget for the provider work, in seconds. It bounds how long ONE
#detection can occupy a worker at roughly this plus one request timeout (~30s),
#instead of the detector's structural worst case of 2 models x 2 attempts x 20s
#= 80s.
#
#STILL A REAL LIMIT, but no longer a money one. The catch-all worker
#(`k8s/free2z/worker:image_variant_worker`) is ONE replica at concurrency 1
#consuming every queue, so a single process drains `default`, `search`,
#`search-multilingual`, `images` and this queue one job at a time, and a slow
#detection still delays all of them. A queue name is not isolation.
#
#What changed in: `billing` is no longer on that list in any way that
#matters. `k8s/free2z/worker:billing_worker` consumes `billing` and nothing
#else, so `renew_subscription` -- whose renewal lapses permanently if it waits
#past `expires` (guard 4 below) -- can no longer queue behind a detection or a
#translation. The catch-all still serves `billing` as a fallback, so the
#isolation is additive, not a partition.
#
#Shrinking occupancy therefore protects the non-money queues. It stays because
#a detection that pins the shared lane for 80s is still 80s that `search` and
#`images` are not moving.
DETECTION_JOB_BUDGET_SECONDS = 10.0

# Retry policy .
#
# The publication and renewal state transitions are pure-DB and idempotent by
# construction (filtered
# compare-and-set UPDATE for publishing; SELECT... FOR UPDATE plus the
# expires-window guard for renewal), so a retry can never publish twice or
# charge twice. Their realistic failure mode is not a bug in the task but
# a lost/failed DB connection -- exactly the thing a retry fixes.
#
# Linear backoff rather than exponential: these are latency-sensitive
# (a renewal happening late is a lapsed subscription) and the failure they
# are absorbing is short-lived. Attempts land at +60s and +120s
# (RENEWAL_RETRY_ATTEMPTS) / +30s and +60s (PUBLISH_RETRY).
#
# The maximum matters more than the backoff: with max_attempts set, a
# genuinely broken job reaches status='failed' within ~3 minutes and the
# billing alert (threshold 1, see settings.JOB_HEALTH_*) pages. Without a
# maximum, a job could retry forever and NEVER be visible as failed --
# which is the silent-failure mode  exists to eliminate. Do not set
# max_attempts=None here.
PUBLISH_RETRY = RetryStrategy(max_attempts=3, linear_wait=30)
RENEWAL_RETRY_STRATEGY = RetryStrategy(max_attempts=3, linear_wait=60)

# Renewal economics ( phase 3) — these mirror the legacy hourly
# renew_subs sweep EXACTLY; do not change them without changing the
# billing contract:
#
# - The sweep ran hourly and renewed subs with
#   now <= expires <= now + 24h. So a renewal happens up to 24 hours
#   before expiry, and never after expiry (an expired sub lapses
#   permanently). RENEWAL_LEAD preserves that 24h lead: the scheduled
#   job fires at expires - RENEWAL_LEAD, the same moment the first
#   hourly sweep tick would have caught the sub.
# - A sub that was in the window but ineligible (payer short on tuzis,
#   or max_price below the star's current member_price) was retried by
#   the sweep every hour until expiry, then lapsed. RENEWAL_RETRY
#   preserves that hourly retry cadence.
#
# TWO LIMITS OF A FLAT HOURLY CADENCE, measured on `main` before  rather
# than reasoned about, and shared by every branch that retries:
#
#   * It overshot the window. A sub 30 minutes from expiry scheduled its retry
#     30 minutes AFTER `expires`, so that attempt was a guaranteed no-op via
#     the lapsed guard. A fan who fixed the problem -- topped up, or was
#     reinstated -- inside that final interval was never looked at again and
#     the sub lapsed with every job recorded successful.
#   * It amplified duplicates. Three executions of the same ineligible
#     subscription left three pending retries, each of which spawned its own
#     successor, so the ~24-attempts-per-cycle bound was per queued job and
#     not per subscription. Every Subscription save enqueues a job and the
#     daily backstop adds more, so N duplicates became ~24N executions on the
#     two-slot billing worker; a mass moderation event correlates them.
#
# Both are closed here , one mechanism each:
#
#   * No overshoot. `renewal_retry_at` clamps the retry to
#     `min(now + RENEWAL_RETRY, expires - RENEWAL_LAST_LOOK)`, and inside the
#     last look it schedules NOTHING. The last look is the floor  asked
#     for: without it a sub already inside the final interval would schedule
#     itself in the past and procrastinate would run it again immediately, a
#     tight loop against `expires` on the billing worker. So the last retry of
#     a cycle lands five minutes before expiry, and if the fan is still short
#     there the chain simply ends -- the lapsed guard is the terminal state,
#     reached at most once (by a straggler such as a backstop job), never as
#     a loop.
#   * No amplification. `defer_renewal` is the ONE way this task is enqueued
#     -- the Subscription post_save hook, the daily backstop and both retry
#     branches all go through it -- and it sets
#     `queueing_lock="renew-sub-<pk>-<expires>"`. procrastinate's partial
#     unique index (`procrastinate_jobs_queueing_lock_idx_v1... WHERE
#     status = 'todo'`) then makes a second PENDING job for the same
#     subscription AND the same billing cycle impossible: the enqueue raises
#     `AlreadyEnqueued`, which is caught and logged. This is a constraint on
#     the REGISTRATION, not a read of queue state inside the money
#     transaction, which is the objection  raised against
#     de-duplicating in the task: "the DB at execution time is the source of
#     truth" is untouched, and the guards below still decide every charge.
#
# WHY THE KEY CARRIES THE CYCLE. The lock holder is whichever pending job was
# inserted FIRST, and a refusal is only correct when the holder is going to
# do the refused job's work. Within one cycle that is always true: the chain
# job, the hourly retries and every duplicate of them all re-read the same
# row and decide the same charge, so one pending job is enough. Across
# cycles it is false. Keyed per subscription alone (the first cut of this
# change), a chain job for an `expires` that a manual early renewal, a
# cancel-then-resubscribe or an admin edit has since moved would hold the
# lock against the job for the NEW moment; the stale holder then runs at its
# old moment and cannot stand in -- not-due if `expires` moved later (the
# codex review's round-1 finding: the chain fell to the daily backstop, whose
# 24h window equals the lead, so a CronJob starting minutes late misses a sub
# expiring just after its tick), lapsed if it moved earlier (round 2: the
# subscription lapses before the holder ever runs). Cancelling the holder and
# replacing it (rounds 3 and 4) is a cancel that is not atomic with its
# replacement under the worker's pooled connector and races a concurrent
# replacement. Keying the lock by `expires` removes the problem instead of
# managing it: a job for a different cycle is never a duplicate, so it is
# never refused, and the two pending jobs are exactly the two the
# subscription needs. The old one runs at its moment, finds `expires` moved,
# and does nothing (not-due) or nothing (lapsed) -- and the not-due guard
# additionally re-arms from the committed row, which the lock turns into a
# no-op whenever the right chain job is already pending and into a repair
# whenever it was lost. The lock also means the
# reclaimer can find a stranded `doing` renewal whose successor is already in
# `todo`: the requeue is refused by the same index, the row stays in `doing`
# and `job_stuck` pages -- the successor is carrying the work, and a human
# decides. The same index also refuses procrastinate's OWN exception retry
# (`procrastinate_retry_job_v1` moves the row `doing -> todo`) when a `todo`
# job with the same key exists by the time this job raises. The COMMON way
# that happens is not a race: it is the job's own successor. A retry branch
# inserts the next look with the SAME key (same subscription, same cycle)
# while this job is still `doing`, so from that insert until the worker
# writes this row's final status, an exception here -- the money
# transaction's commit failing, say -- cannot put this row back in `todo`,
# and neither can the reclaimer. The rare producer is a duplicate landing
# inside the milliseconds a renewal takes (the backstop, or a save). Either
# way the worker logs the failed persist and moves on; the row stays in
# `doing` with a live heartbeat until the next worker restart prunes it and
# the reclaimer requeues it (bounded), and the `todo` job that refused it
# -- successor or duplicate -- carries the subscription meanwhile. That is
# a property of `queueing_lock` every locked task here shares, accepted for
# the same reason the reclaimer accepts it: a stranded row is visible
# (`job_stuck`); a lost renewal was not. Reclaim policy for the billing
# lane, in prose until the registry
# field lands in  and  consumes it: at most ONE reclaim per job
# (`max_reclaims=1`), and the give-up line carries `is_billing=true` so it
# pages at billing severity.
RENEWAL_LEAD = timedelta(hours=24)
RENEWAL_RETRY = timedelta(hours=1)

#The floor under the clamp. A retry is never scheduled later than this far
#before `expires`, and never scheduled at all once `now` is inside it. Five
#minutes is the value  specifies, and it EQUALS the billing lane's
#backlog alert threshold (`JOB_HEALTH_BILLING_OVERDUE_SECONDS`, 300s) -- it
#is not wider than it. Read that as a bound, not a guarantee: a backlog
#under 300s is invisible to the lane's own alert yet still dispatches the
#last look late (a 290s backlog runs it at `expires - 10s`, which still
#charges); a backlog of 300s or more pushes the last look past `expires`,
#where it degrades to the lapsed guard -- but that backlog is, by the same
#number, one the lane is already paging on (`procrastinate-billing-jobs-
#overdue`). What the floor buys unconditionally is the loop bound
#asked for: no retry is ever scheduled in the past, so a sub inside its
#last look reaches the lapsed guard at most once.
RENEWAL_LAST_LOOK = timedelta(minutes=5)


def renewal_queueing_lock(subscription_id: int, expires) -> str:
    """The `queueing_lock` every `g12f.renew_subscription` defer carries.

    One string per subscription AND billing cycle (``expires`` as committed
    when the job was enqueued): procrastinate's partial unique index on
    ``queueing_lock WHERE status = 'todo'`` is what makes "at most one
    pending renewal job per subscription per cycle" a database fact rather
    than a convention. A job for a different ``expires`` is not a duplicate
    -- see the block comment above ``RENEWAL_LEAD`` for why that matters.
    """
    stamp = expires.astimezone(dt_timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    return f"renew-sub-{subscription_id}-{stamp}"


def renewal_retry_at(now, expires):
    """When a non-chargeable renewal looks again, or ``None`` for never.

    ``min(now + RENEWAL_RETRY, expires - RENEWAL_LAST_LOOK)``, and ``None``
    once ``now`` is inside the last look. The result is always strictly in the
    future: the clamp target is ``> now`` exactly when we do not return
    ``None``, so a retry can never be scheduled in the past (which
    procrastinate would run immediately -- the tight loop  warned about).
    """
    last_look = expires - RENEWAL_LAST_LOOK
    if now >= last_look:
        return None
    return min(now + RENEWAL_RETRY, last_look)


def defer_renewal(
    subscription_id: int, expires, *, schedule_at=None, pull_forward=False,
) -> bool:
    """Enqueue ``g12f.renew_subscription`` for one subscription -- THE enqueue
    point, used by the Subscription post_save hook, the daily backstop and the
    task's own retry branches. ``expires`` is the subscription's committed
    expiry, which keys the lock. Returns ``False`` when a job for this
    subscription and cycle is already pending (``queueing_lock`` refused a
    duplicate), which every caller treats as success: the pending job
    re-checks the database when it runs, so there is nothing the refused one
    would have added.

    ``pull_forward`` (the post_save hook only) is the one exception to "the
    pending job is enough": when the pending job for this cycle is scheduled
    LATER than ``schedule_at``, it is moved to ``schedule_at`` -- the earliest
    moment anyone asked for wins. The hook asks for ``expires - RENEWAL_LEAD``,
    so for a sub already inside its window that is in the past and the job
    runs at once. This is what keeps a Subscription save an IMMEDIATE look
    while a retry is pending, as every save was before: the "raise your
    cap" PATCH (``CreatorSubscribeView.patch``) only succeeds when the save
    makes the sub chargeable right now, and on `main` its job ran on the spot;
    with the lock alone the fan would wait for the hourly retry. It is ONE
    UPDATE of ``scheduled_at`` on a ``todo`` row, filtered on the lock and on
    ``scheduled_at > schedule_at``: there is no read-then-cancel to race, two
    concurrent saves commute (the earlier moment wins whichever lands last),
    a job the worker has already taken (``doing``) matches nothing and is
    running anyway, and an immediate job (``scheduled_at IS NULL``) is never
    touched. No NOTIFY fires for an UPDATE; the billing worker's poll
    (``FETCH_JOB_POLLING_INTERVAL``, 5s) picks it up. The backstop and the
    task's retry branches do not pull forward: a pending job at any moment
    inside the window is exactly what the backstop is checking for, and a
    retry never has a reason to run earlier than the retry already pending.

    The insert runs in its own ``atomic()`` block. A refused duplicate is a
    unique-index violation, and Postgres aborts the enclosing transaction on
    it whether or not Python catches the exception. Where the defer shares
    the Django connection with its caller -- web processes and management
    commands, and the test suite -- that would poison the transaction the
    caller is in (the retry branches defer from inside the money
    transaction), so the refusal is confined to a savepoint. In the worker
    it is moot in both directions: ``jobs.procrastinate_pool`` gives the
    JobManager its own pooled psycopg connection there, so the INSERT is
    neither inside the money transaction nor able to abort it (that has
    been so since; the row-lock guards, not the queue, decide the
    charge). The pull-forward UPDATE goes through the Django connection --
    its only caller is a ``transaction.on_commit`` callback, which runs in
    autocommit in the web process and the worker alike, so it is never
    inside the money transaction either.

    ``configure`` is called with keyword arguments only, so a test can replace
    ``renew_subscription.configure`` with a ``**kwargs`` stand-in.
    """
    lock = renewal_queueing_lock(subscription_id, expires)
    try:
        with transaction.atomic():
            renew_subscription.configure(
                schedule_at=schedule_at,
                queueing_lock=lock,
            ).defer(subscription_id=subscription_id)
    except AlreadyEnqueued:
        if pull_forward and schedule_at is not None:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE procrastinate_jobs SET scheduled_at = %s "
                    "WHERE queueing_lock = %s AND status = 'todo' "
                    "AND scheduled_at > %s",
                    [schedule_at, lock, schedule_at],
                )
                moved = cursor.rowcount
            if moved:
                logger.info(
                    "renew_subscription: sub %s already has a pending job "
                    "(queueing_lock=%s) scheduled later than %s — pulled "
                    "it forward to that moment",
                    subscription_id, lock, schedule_at,
                )
                return False
        logger.info(
            "renew_subscription: sub %s already has a pending job "
            "(queueing_lock=%s) — not enqueuing another",
            subscription_id, lock,
        )
        return False
    return True


@app.task(
    name="g12f.notify_published_zpage", queue="default", retry=PUBLISH_RETRY,
    priority=INTERACTIVE,
    # For `context.job.id`, which IS the broadcast's identity -- see the
    # dedup key below. `pass_context` changes only how the WORKER calls this
    # function; `defer()` and the job's stored args are untouched, so a job
    # queued by the previous release runs unchanged on a new worker and vice
    # versa. Passing the identity as a task ARGUMENT instead would not have
    # that property: an old worker handed a job carrying a new kwarg fails it.
    pass_context=True,
)
def notify_published_zpage(context, zpage_id: int):
    """Promise page-update notifications for a currently public page.

    . This does NOT publish. It writes the broadcast into the
    transactional outbox  under a dedup key that identifies THIS
    deferred job, and the relay publishes it. Two executions -- a
    procrastinate retry, or a reclaim by `jobs.reclaim_stalled_jobs`, both
    of which UPDATE the same `procrastinate_jobs` row and so keep the same
    id -- therefore leave ONE outbox row and send ONE message, because the
    collapse happens under a UNIQUE index in PostgreSQL rather than in an
    `exists()` check both copies pass.

    That is what makes the task reclaimable: it used to be NEVER in
    `jobs.reclaim_policy` precisely because nothing recorded that a
    broadcast had happened, so a stranded `doing` row was never healed.
    """
    from dj.apps.g12f.models import zPage
    from dj.apps.g12f.publication import enqueue_page_update

    # `published_and_active()`. This is not a read route, it is a
    # BROADCAST: the payload is the serialized page -- up to 100,000
    # characters of body -- destined for Pub/Sub, where consumers create fan
    # notification events and hand it to the AI describe/tag services. A job
    # queued before a ban, or retried after one, would redistribute a taken-down
    # page to every follower. The queue is the one read path a 404 cannot
    # cover, because nobody is asking.
    #
    # The gate still runs at ENQUEUE time, not at publish time: the outbox
    # row is a promise to send THIS payload, so a ban that lands after the
    # row is written is not caught here. It never was -- the old code had
    # already published by that point -- and the downstream consumers
    # re-read the page through `published_and_active()` themselves.
    page = zPage.objects.published_and_active().filter(pk=zpage_id).first()
    if page is None:
        logger.info(
            "notify_published_zpage: no-op for zPage %s", zpage_id
        )
        return

    enqueue_page_update(page, broadcast_id=f"job:{context.job.id}")


@app.task(
    name="g12f.publish_zpage", queue="default", retry=PUBLISH_RETRY,
    priority=INTERACTIVE,
)
def publish_zpage(zpage_id: int):
    """
    Publish one zPage if — and only if — it is due right now.

    The filtered UPDATE is an atomic compare-and-set: only a row that is
    still unpublished with a due publish_at transitions, so concurrent
    duplicate jobs and the legacy cron sweep can never double-publish.
    updated_at is set explicitly because.update() bypasses auto_now
    (the old cron's save() bumped it; we keep that behavior).
    """
    from dj.apps.g12f.models import zPage, ZPageTranslation
    from dj.apps.jobs.transactional import defer_in_transaction
    from dj.apps.search.tasks import index_zpage

    from dj.apps.g12f.variants import publish_source_variant
    from dj.apps.g12f.mentions import process_page_mentions
    from dj.apps.g12f.publication import send_first_publication

    now = timezone.now()
    # The compare-and-set is a queryset.update(), which fires no post_save —
    # so the  M3 dual-write signal never sees it and the source variant
    # has to be mirrored explicitly. Both statements are in ONE transaction:
    # the task runs in autocommit, so without this the process could die
    # between them, leaving the page permanently published in the legacy shape
    # and permanently a draft in the variant shape — and the retry would see
    # `updated == 0`, take the no-op branch, and never repair it. That is a
    # silent, unrecoverable divergence that only surfaces when M5 flips reads.
    # Wrapping does not weaken the double-publish guard: the filtered UPDATE is
    # still a single statement, so a concurrent duplicate job still blocks on
    # the row lock, re-evaluates the filter after this commits, and matches
    # zero rows.
    with transaction.atomic():
        # Preserve the existing first-publication fan notification contract;
        # mention delivery is an additional idempotent side effect.
        prior = zPage._base_manager.select_for_update().filter(
            pk=zpage_id,
        ).values_list("published_at", flat=True).first()
        updated = zPage.objects.filter(
            pk=zpage_id,
            is_published=False,
            publish_at__isnull=False,
            publish_at__lte=now,
            #a scheduled page whose creator was deactivated between
            # scheduling and its publish time must NOT publish itself. Part of
            # the same compare-and-set, so the check is atomic with the
            # transition rather than a separate read that could go stale.
            creator__is_active=True,
        ).update(
            is_published=True,
            publish_at=None,
            updated_at=now,
            # QuerySet.update() bypasses zPage.save(), so fill the durable
            # publication timestamp here as the scheduled publication commits.
            # Keep an earlier timestamp if a page was previously published and
            # then scheduled again.
            published_at=Case(
                When(published_at__isnull=True, then=Value(now)),
                default=F("published_at"),
                output_field=DateTimeField(),
            ),
        )

        if updated:
            publish_source_variant(zpage_id, now)
            if prior is None:
                send_first_publication(zpage_id)
            process_page_mentions(zpage_id)
            # Publishing is the moment a page must become searchable, and the
            # reindex is enqueued IN this transaction. After it, a
            # worker killed between COMMIT and the defer left a published page
            # unindexed forever: the retry of this job sees `updated == 0`
            # and no-ops. Pages with published variants must use the
            # rollout-safe task contract: an old worker must never claim
            # this work and leave a canonical-only index.
            if ZPageTranslation.objects.filter(
                zpage_id=zpage_id, is_published=True
            ).exists():
                from dj.apps.g12f.signals import _defer_multilingual_index

                _defer_multilingual_index(zpage_id)
            else:
                defer_in_transaction(
                    index_zpage.configure(), zpage_id=zpage_id,
                )

    if not updated:
        # Not due yet, already published, publish_at cleared, or the
        # page is gone: stale/duplicate job — no-op by design.
        logger.info("publish_zpage: no-op for zPage %s", zpage_id)
        return False

    logger.info("publish_zpage: published zPage %s", zpage_id)

    # Immediate publishing emits PAGE_UPDATE from the request path. Scheduled
    # publishing has no request, so enqueue the same side effect as an
    # independently retryable job after the page has become public.
    notify_published_zpage.defer(zpage_id=zpage_id)
    return True


def _defer_renewal_retry(sub, now, *, reason: str) -> None:
    """Look at a non-chargeable subscription again, inside its window.

    Both retry branches (ineligible, inactive fan) end here. The moment is
    ``renewal_retry_at``: hourly, clamped to ``expires - RENEWAL_LAST_LOOK``,
    and nothing at all inside the last look -- the chain ends and the lapsed
    guard is where any straggler terminates. The defer goes through
    ``defer_renewal`` so a duplicate job cannot start a second chain.
    """
    retry_at = renewal_retry_at(now, sub.expires)
    if retry_at is None:
        logger.info(
            "renew_subscription: sub %s %s — no charge, inside the last "
            "look before expiry (%s), chain ends",
            sub.pk, reason, sub.expires,
        )
        return
    logger.info(
        "renew_subscription: sub %s %s — no charge, retry at %s",
        sub.pk, reason, retry_at,
    )
    defer_renewal(sub.pk, sub.expires, schedule_at=retry_at)


def _defer_inactive_fan_retry(sub, now, *, locked: bool):
    """Skip this cycle's charge for a deactivated fan; look again later.

     established the freeze: ``is_active=False`` is the moderation lever
     and it is also what Django's auth backend checks, so a deactivated
    fan cannot log in, cannot reach ``/api/tuzis/my-subscriptions`` and cannot
    ``DELETE /api/tuzis/subscribe/{username}`` to set ``max_price = 0``. There
    is no cancellation path that does not require authentication, so charging
    on drains a balance its holder has been locked out of protecting.

     is the RETRY, and the difference from a plain ``return`` is not
    cosmetic. Deactivation is reversible, ``is_active`` changes without any
    Subscription save (so no post_save signal re-arms the chain), and the
    ``renew_subs`` backstop runs ONCE A DAY over a 24h window -- equal to the
    window, not wider than it, so it enqueues a given subscription exactly
    once between ticks. Returning therefore consumes the last job this cycle
    will ever get: a sub expiring at 03:00 is looked at at 03:00 the previous
    day and again at the 03:41 sweep, both no-ops, and a fan reinstated at
    04:00 -- still 23 hours from expiry -- is never looked at again. The
    subscription lapses silently, the creator is not paid, and both jobs are
    recorded successful, so nothing fails and nothing pages.

    The cadence is the one the "ineligible" branch already uses, for exactly
    the same reason (a condition that changes with no Subscription save), and
    it is clamped to the window (`renewal_retry_at`). This guard
    sits AFTER the lapsed and not-due guards, which is what bounds the chain
    at ~24 attempts and terminates it at expiry.
    """
    _defer_renewal_retry(
        sub, now,
        reason=(
            "inactive fan (deactivated while waiting for the balance lock)"
            if locked else "inactive fan"
        ),
    )


@app.task(
    name="g12f.renew_subscription", queue="billing",
    retry=RENEWAL_RETRY_STRATEGY,
)
def renew_subscription(subscription_id: int):
    """
    Renew one Subscription if — and only if — it is due right now.

    MONEY PATH. Same no-cancellation design as publish_zpage: the DB at
    execution time is the source of truth, so duplicate jobs, stale
    jobs, and overlap with the daily backstop sweep are all harmless.
    Guards, in order, under SELECT... FOR UPDATE of the subscription
    row. The fan and star rows are then locked separately in global primary-key
    order before any eligibility decision:

    1. Sub gone            -> no-op, no next job.
    2. Cancelled           -> max_price == 0 (how CreatorSubscribeView
                              .delete models cancellation). No charge,
                              no next job. If the fan reactivates by
                              raising max_price, that PATCH save
                              re-arms the chain via the post_save
                              signal, so no retry is needed here.
    3. Fan deactivated     -> is_active=False on sub.fan. No charge,
                              no next job: deactivation freezes
                              outgoing recurring spend because a banned
                              account cannot authenticate to cancel —
                              charging it would drain an account locked
                              out of its own money controls. Symmetric
                              with the inactive-creator freeze.
                              Moderation reversal (reactivation) re-arms
                              via any subscription save / sweep; it does
                              NOT resurrect a lapsed sub.
    4. expires < now       -> lapsed. The sweep never renewed expired
                              subs; neither do we. No next job.
    5. expires > now+LEAD -> not due: either a stale/duplicate job or
                              something else already renewed the sub.
                              This is the idempotency guard that makes
                              double-charging from duplicate jobs
                              impossible ( defense in depth): a
                              successful extend() pushes expires ~30d
                              out, so any second job for the same cycle
                              lands here. FOR UPDATE serializes
                              concurrent duplicates so the loser sees
                              the winner's committed expires. No charge;
                              the chain is RE-ARMED at expires - LEAD
                              through defer_renewal, which the
                              queueing_lock turns into a no-op whenever
                              the chain job is already pending -- and
                              into the repair whenever this stale job
                              was the one holding the lock against it.
    6. Ineligible (star has no member_price, fan's max_price cap below
       price, or fan short on tuzis) -> no charge; retry in one hour,
       replicating the legacy sweep's hourly retry until the window
       closes at expiry. the retry is clamped to
       ``expires - RENEWAL_LAST_LOOK`` and not scheduled at all inside
       that last look, so the chain ends INSIDE the window instead of
       overshooting it (guard 4 catches only stragglers). Retry is needed
       for exactly these conditions because they can change without any
       Subscription save (fan tops up tuzis, star changes price), so no
       signal would re-arm the chain. Every defer carries a
       ``queueing_lock`` keyed by subscription and cycle
       (``defer_renewal``), so N duplicate jobs leave one pending retry,
       not N chains. A Subscription save while that retry is pending (the
       fan raises their cap) does not wait for it: the post_save hook
       pulls the pending retry forward to ``expires - RENEWAL_LEAD``, in
       the past for a sub in its window, so the save is looked at now.
    7. Eligible -> sub.extend(enforce_max_price=True): debit fan, credit star,
       expires += 30d, events created — all inside this transaction. The
       Subscription
       post_save signal then schedules the NEXT renew_subscription at
       new_expires - RENEWAL_LEAD via transaction.on_commit
       (self-perpetuating chain; single enqueue point in signals.py).

    Policy decision recorded for: deactivated fan — recurring
    charges STOP. A banned account cannot log in to cancel, so
    continuing to charge it drains an account locked out of its own
    money controls; this is symmetric with the inactive-creator freeze.
    Reactivation restores eligibility but does NOT resurrect lapsed
    subscriptions.

    That freeze is a SKIP-AND-RETRY, not a ``return`` (guard 5b,
    ``_defer_inactive_fan_retry``). Returning would drop the only durable
    renewal chain the cycle has, because the daily backstop covers the 24h
    window once a day and so cannot re-reach a fan reinstated between ticks.
    It sits AFTER the lapsed and not-due guards, which is what terminates the
    retry chain at expiry.
    """
    from dj.apps.g12f.models import Subscription

    now = timezone.now()
    with transaction.atomic():
        from dj.apps.economy.epoch import pin_supported_policy
        pin_supported_policy()
        sub = (
            Subscription.objects
            # PostgreSQL otherwise locks every select_related row in database
            # join order. That can oppose ledger.transfer's primary-key order
            # and deadlock a renewal racing a donation between the same users.
            .select_for_update(of=("self",))
            .select_related("fan", "star")
            .filter(pk=subscription_id)
            .first()
        )
        if sub is None:
            logger.info(
                "renew_subscription: sub %s gone — no-op", subscription_id)
            return

        if not sub.star.is_active:
            logger.info(
                "renew_subscription: sub %s inactive creator — no-op",
                subscription_id,
            )
            return

        if not sub.max_price or sub.max_price <= 0:
            logger.info(
                "renew_subscription: sub %s cancelled (max_price=%s) "
                "— no-op", subscription_id, sub.max_price)
            return

        if sub.expires < now:
            logger.info(
                "renew_subscription: sub %s lapsed (expired %s) — no-op",
                subscription_id, sub.expires)
            return

        if sub.expires > now + RENEWAL_LEAD:
            # Already renewed (or stale/duplicate job): idempotent no-op
            # for the MONEY -- but not for the chain. Re-arm at the moment
            # the committed `expires` says. When the chain job for
            # this cycle is already pending (the common case: this is a
            # duplicate of a healthy chain, or the job for the cycle
            # `expires` was moved out of), the per-cycle queueing_lock
            # refuses this and nothing changes; when that job was lost --
            # a queue outage swallowed the post_save callback, say -- this
            # is the repair, at the exact lead moment rather than the
            # daily backstop's tick. The running job is `doing`, so it
            # never holds the lock against itself.
            logger.info(
                "renew_subscription: sub %s not due (expires %s) — no "
                "charge, re-arming the chain at %s",
                subscription_id, sub.expires, sub.expires - RENEWAL_LEAD)
            # Best effort, never fatal. This branch was a bare `return` on
            # main and charges nothing, so a transient queue/DB error in the
            # re-arm must not turn a no-op into three RENEWAL_RETRY_STRATEGY
            # attempts and a `failed` row that pages
            # procrastinate-billing-jobs-failed ("a creator did not get
            # paid") -- that runbook's threshold rests on every non-charging
            # outcome being an explicit return, never an exception. The
            # daily renew_subs backstop repairs a chain this could not
            # re-arm, exactly as it repairs a swallowed post_save callback.
            try:
                defer_renewal(
                    subscription_id, sub.expires,
                    schedule_at=sub.expires - RENEWAL_LEAD)
            except Exception:
                logger.exception(
                    "renew_subscription: sub %s not due — re-arming the "
                    "chain at %s failed; no charge was due and the daily "
                    "renew_subs backstop repairs the chain",
                    subscription_id, sub.expires - RENEWAL_LEAD)
            return

        #  freezes the fan's outgoing spend;  is why it sits HERE,
        # after the lapsed and not-due guards, and retries instead of
        # returning. See `_defer_inactive_fan_retry`.
        if not sub.fan.is_active:
            _defer_inactive_fan_retry(sub, now, locked=False)
            return

        # All multi-balance writers acquire Creator rows in this order. Refresh
        # after locking because either row may have changed while we waited.
        from dj.apps.tuzis import ledger
        ledger.lock_in_order(sub.fan, sub.star)
        # is_active rides along: the post-lock fan gate below
        # must judge the committed row, not the pre-lock snapshot.
        sub.fan.refresh_from_db(fields=["tuzis", "is_active"])
        sub.star.refresh_from_db(
            fields=["tuzis", "member_price", "is_active"]
        )

        if not sub.star.is_active:
            logger.info(
                "renew_subscription: sub %s creator deactivated while "
                "waiting for the balance lock — no-op", subscription_id
            )
            return

        #the fan may be deactivated while we waited on the lock,
        # for the same reason as the pre-lock gate: a banned account
        # cannot cancel, so its outgoing recurring spend is frozen. Same
        # skip-and-retry as the pre-lock gate, or a ban that lands in this
        # window silently costs the sub its whole chain.
        if not sub.fan.is_active:
            _defer_inactive_fan_retry(sub, now, locked=True)
            return

        price = sub.star.member_price
        eligible = (
            price is not None
            and sub.max_price >= price
            and sub.fan.tuzis >= price
        )
        if not eligible:
            # Same economics as the hourly sweep: skip without charging,
            # try again in an hour -- clamped to the window, so the last
            # look lands RENEWAL_LAST_LOOK before expiry and nothing is
            # scheduled past it. Bounded at ~24 retries per cycle,
            # per SUBSCRIPTION: `defer_renewal`'s queueing_lock refuses a
            # second pending retry, so duplicate jobs cannot each chain.
            _defer_renewal_retry(
                sub, now,
                reason=(
                    f"ineligible (price={price} max_price={sub.max_price} "
                    f"fan_tuzis={sub.fan.tuzis})"
                ),
            )
            return

        logger.info(
            "renew_subscription: extending sub %s (%s -> %s, price %s)",
            subscription_id, sub.fan, sub.star, price)
        # extend() saves the sub, which fires the post_save signal that
        # schedules the next renewal job on commit.
        from dj.apps.economy.services import EconomicRefusal
        try:
            sub.extend(enforce_max_price=True)
        except EconomicRefusal as exc:
            _defer_renewal_retry(sub, now, reason=f'utility sharing unavailable: {exc}')


# --------------------------------------------------------------------------- #
# Language detection ( M4 / Part 5)
# --------------------------------------------------------------------------- #
# Retry policy. The realistic failures here are a provider being unhappy for a
# minute (429, 5xx, a socket that stalls) -- transient by definition and exactly
# what a retry fixes. Exponential from 30s puts attempts at +30s, +90s and
# +270s, so a job survives ~6.5 minutes of provider trouble before it reaches
# the terminal `failed` status the job-health alert can see.
#
# max_attempts is set, deliberately and per: a job that retried forever
# would never be visible as failed, which is the silent-failure mode that
# policy exists to eliminate. When a job does exhaust its attempts the page is
# simply left unlabelled -- which is a *correct* state, not a broken one -- and
# the corpus backfill command picks it up on its next run.
DETECTION_RETRY = RetryStrategy(max_attempts=4, exponential_wait=30)


def _may_apply_detection(page, detection, is_content_language,
                         confidence_threshold, creator, translation_model):
    """Whether this detection may take ownership of the source label.

    Three refusals, each of which is a bug that reached a review:

    1. **A creator override is absolute.** ``language_source='creator'`` means a
       human decided, and no confidence beats that.
    2. **Never relabel into a language a translation already holds.** Setting
       the source to ``es`` on a page that has an ``es`` translation makes the
       source shadow that translation in ``resolve_zpage_variant`` -- the real
       Spanish text becomes unreachable -- and the M3 mirror cannot represent it
       at all (``uniq_zpage_variant_language``), so it logs an error and the two
       shapes diverge permanently. The reconciler reports that as
       ``source-collision`` and explicitly refuses to repair it, which means one
       automatic relabel could block the M5 cutover until a human intervenes.
       Detection records what it saw and leaves the label alone.
    3. **A low-confidence answer does not replace an existing language.**
       Ambiguous, mixed-language or very short text is not enough evidence to
       overturn either a client-supplied label or an earlier detection. An
       unlabelled page (``und``/NULL) takes any answer, because any real
       language beats the sentinel.
    Whether an accepted detection changes the label is decided separately.
    Region-only changes (``es`` and ``es-VE``) are suppressed, but matching
    results still record detector provenance so future edits are rechecked.
    Script differences are meaningful, so ``zh``, ``zh-Hans`` and ``zh-Hant``
    are not treated as regional churn.
    """
    if page.language_source == creator:
        return False
    if translation_model.objects.filter(
        zpage_id=page.pk, language=detection.tag
    ).exists():
        logger.warning(
            "detect_zpage_language: zPage %s detected as %s but a %s "
            "translation already exists; leaving source_language=%r alone "
            "(relabelling would shadow the translation and diverge the "
            "variant shape)",
            page.pk, detection.tag, detection.tag, page.source_language,
        )
        return False
    if (
        is_content_language(page.source_language)
        and detection.confidence < confidence_threshold
    ):
        logger.info(
            "detect_zpage_language: zPage %s detected as %s at confidence "
            "%.2f, below %.2f; keeping existing source_language=%r",
            page.pk, detection.tag, detection.confidence,
            confidence_threshold, page.source_language,
        )
        return False
    return True


def _same_language_except_region(current, detected):
    """Whether canonical tags differ only in a region subtag.

    Script and variant subtags remain part of the comparison, so the detector
    can refine or correct ``zh``/``zh-Hans``/``zh-Hant``.

    A region can *imply* a script, so the spelled-out subtags are not enough:
    ``zh-CN`` and ``zh-TW`` differ only in region yet mean Simplified and
    Traditional ( served a Taiwanese reader Simplified text by treating
    ``zh-TW`` as script-less), and bare ``zh`` -> ``zh-TW`` is the same
    refinement as ``zh`` -> ``zh-Hant``. So the CLDR likely script of both
    tags must agree as well (``likely_script`` -- ``None`` on both sides for an
    unanswerable tag compares equal, which keeps the region-only rule).
    """
    from f2z.languages import likely_script

    if likely_script(current) != likely_script(detected):
        return False

    def without_region(tag):
        subtags = tag.split("-")
        for index, subtag in enumerate(subtags[1:], start=1):
            is_region = (
                (len(subtag) == 2 and subtag.isalpha())
                or (len(subtag) == 3 and subtag.isdigit())
            )
            if is_region:
                del subtags[index]
                break
        return tuple(part.casefold() for part in subtags)

    return without_region(current) == without_region(detected)


class DetectionUnavailable(Exception):
    """The detector produced no usable answer for a page that has text.

    Raised so procrastinate retries. It is NOT raised for a page with nothing
    to classify (an empty or whitespace-only body): that page is not failing,
    it simply has no language, and a later edit re-triggers detection.
    """


def apply_detection(page, detection, *, reindex=True, now=None):
    """Persist one detection onto ``page``. Returns the fields written.

    The rule this encodes:

    * ``detected_language`` / ``detection_confidence`` / ``detected_at`` are
      always written. They are observation, not decision.
    * ``source_language`` is written unless ``language_source='creator'``. A
      creator override is the one thing the detector may never touch, and it is
      re-checked here rather than only at the caller because this is the last
      line before the write.

    **INVARIANT -- the policy lives in the trigger, not here.** This function is
    the mechanism; ``signals.zpage_language_provenance`` and the backfill's
    ``unlabelled_zpages()`` decide *which* pages ever reach it. Between them,
    the only pages that get here are ones with no real language, ones the
    detector already owns, and brand-new creates. An existing page carrying a
    human-chosen legacy label is never selected, which is what stops this from
    silently relabelling tens of thousands of correctly-labelled articles.
    **Do not call this on an arbitrary page** and expect the legacy corpus to
    be safe -- the trigger is the guard.

    ``update_fields`` is narrow on purpose:

    * ``updated_at`` is excluded, so detecting a language does not look like an
      edit to sitemaps, feeds or the "recently updated" surfaces. Detection is
      metadata about the page, not a revision of it. It is also what keeps a
      relabel out of the *state* half of the zPage validator
      (``preconditions._validator_parts``, ): the creator's next
      autosave, carrying the ETag it had before this ran, must still pass.
      Adding a column here that the validator's state covers would bring
      back the false 412  fixed.
    * the  M3 dual-write receiver only mirrors when ``update_fields``
      intersects ``SOURCE_VARIANT_FIELDS``, so a detection that changes
      ``source_language`` renames the source variant and one that does not
      costs no extra write at all.

    ``reindex=False`` suppresses the search re-index. The interactive path
    leaves it on (one extra job per editing session, and the embedding text
    carries the language tag). The corpus backfill turns it **off**: a re-index
    is an OpenAI summary *plus* an embedding per page, which at corpus scale
    would cost one to two orders of magnitude more than the detection it is
    reacting to -- the exact cost blowup  Part 12 names.
    """
    from f2z.ai.language import CONFIDENCE_DISPLAY_THRESHOLD

    from dj.apps.g12f.localization import is_content_language
    from dj.apps.g12f.models.zpage import (
        LANGUAGE_SOURCE_CREATOR,
        LANGUAGE_SOURCE_DETECTED,
        ZPageTranslation,
    )

    fields = ["detected_language", "detection_confidence", "detected_at"]
    page.detected_language = detection.tag
    page.detection_confidence = detection.confidence
    page.detected_at = now or timezone.now()

    if _may_apply_detection(
        page, detection, is_content_language, CONFIDENCE_DISPLAY_THRESHOLD,
        LANGUAGE_SOURCE_CREATOR, ZPageTranslation,
    ):
        if not (
            is_content_language(page.source_language)
            and _same_language_except_region(
                page.source_language, detection.tag
            )
        ):
            page.source_language = detection.tag
            fields.append("source_language")
        if page.language_source != LANGUAGE_SOURCE_DETECTED:
            page.language_source = LANGUAGE_SOURCE_DETECTED
            fields.append("language_source")

    previously_skipped = getattr(page, "_skip_zpage_async_side_effects", False)
    page._language_write_is_detection = True
    if not reindex:
        page._skip_zpage_async_side_effects = True
    try:
        page.save(update_fields=fields)
    finally:
        page._language_write_is_detection = False
        page._skip_zpage_async_side_effects = previously_skipped
    return fields


@app.task(
    name="g12f.detect_zpage_language",
    queue=DETECTION_QUEUE,
    retry=DETECTION_RETRY,
)
def detect_zpage_language(zpage_id: int):
    """Detect and store the language of one zPage.

    Deferred from the zPage ``post_save`` signal inside ``transaction.on_commit``
    with a queueing lock, because ``AtomicMiddleware`` wraps every POST/PUT/PATCH
    in ``transaction.atomic`` and a provider call inside a view would hold a
    database transaction open across a network round trip. See ``signals.py``.

    The provider call happens OUTSIDE any transaction. Only the write is
    wrapped, and it re-reads the row under ``SELECT... FOR UPDATE`` so a
    creator who set the label while the provider was thinking wins the race.
    """
    import time

    from f2z.ai.language import (
        content_digest,
        detect_language,
        truncate_for_detection,
    )

    from dj.apps.g12f.models.zpage import LANGUAGE_SOURCE_CREATOR, zPage

    page = zPage.objects.filter(pk=zpage_id).first()
    if page is None:
        logger.info("detect_zpage_language: zPage %s gone — no-op", zpage_id)
        return False
    if page.language_source == LANGUAGE_SOURCE_CREATOR:
        logger.info(
            "detect_zpage_language: zPage %s is creator-labelled (%s) — no-op",
            zpage_id, page.source_language,
        )
        return False
    if not truncate_for_detection(page.title, page.content):
        # Nothing to classify. Not a failure: an empty draft has no language,
        # and the next save with real text re-triggers this.
        logger.info(
            "detect_zpage_language: zPage %s has no text — no-op", zpage_id)
        return False

    detection = detect_language(
        page.title, page.content,
        deadline=time.monotonic() + DETECTION_JOB_BUDGET_SECONDS,
    )
    if not detection.is_known:
        # Provider down, timeout, or two replies that were not a language tag.
        # Publishing already happened and is unaffected; retry.
        raise DetectionUnavailable(
            f"no usable language for zPage {zpage_id}"
        )

    with transaction.atomic():
        fresh = zPage.objects.select_for_update().filter(pk=zpage_id).first()
        if fresh is None:
            return False
        if fresh.language_source == LANGUAGE_SOURCE_CREATOR:
            logger.info(
                "detect_zpage_language: zPage %s was creator-labelled while "
                "the provider was thinking — leaving it alone", zpage_id,
            )
            return False
        if content_digest(fresh.title, fresh.content) != content_digest(
            page.title, page.content
        ):
            logger.info(
                "detect_zpage_language: zPage %s changed while the provider "
                "was thinking — no-op", zpage_id,
            )
            return False
        apply_detection(fresh, detection)

    logger.info(
        "detect_zpage_language: zPage %s -> %s (confidence %.2f)",
        zpage_id, detection.tag, detection.confidence,
    )
    return True


# Register first, produce second (CLAUDE.md, /): the task shipped
# alone in  (prod 9145deec); this is the schedule. Hourly: each run frees
# at most 500 names, idempotently, so a missed or doubled tick costs nothing,
# and a deleted account's name comes free within the hour its 30 days end.
@app.periodic(cron="37 * * * *")
@app.task(name="g12f.release_deleted_usernames", queue="default")
def release_deleted_usernames_task(timestamp: int = 0):
    """Free usernames held by accounts deleted over 30 days ago.

    ``timestamp`` is the periodic signature. The body is idempotent and
    bounded (``limit`` rows per run).
    """
    from .account_deletion import release_deleted_usernames

    return release_deleted_usernames()
