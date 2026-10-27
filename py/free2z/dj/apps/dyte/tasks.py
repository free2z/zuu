"""
Procrastinate tasks for the dyte app (autodiscovered via
procrastinate.contrib.django, PROCRASTINATE_AUTODISCOVER_MODULE_NAME
default "tasks").

sweep_live_meetings is a background self-heal that keeps
CreatorMeeting.live_now truthful in the DB. Since the Dyte -> Cloudflare
RealtimeKit migration the meeting.ended provider webhook is delayed/lost
(dyte/views.py webhook), so live_now was only ever set True and never
cleared: stale rooms stuck on the public "live now" list forever
(PublicMeetingViewSet).

Design (product owner): a worker that continuously probes is fine as long
as the public list stays cached/queryable so "who is live now" is a single
cheap indexed query. So the truth lives in the DB (live_now +
last_seen_at), the public read path never touches the provider, and this
periodic task is the only thing that probes the provider on the list.

retry_recording_delivery and recover_recording_deliveries form the durable
backstop for a provider recording URL that returns transient 403/404 responses.
The Pub/Sub subscriber ACKs only after this DB-backed work exists; the retry
budget and age are bounded, and incomplete receipts are logged for alerting.
"""
import logging
import time
from collections import Counter
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db.models import F, Q
from django.utils import timezone

from procrastinate.contrib.django import app

from .models import RecordingDelivery

logger = logging.getLogger(__name__)


# Registered, deliberately NOT periodic ( review). Every worker lane
# runs procrastinate's periodic deferrer for every @app.periodic task it
# knows, and bin/bazel-apply.sh rolls ledger-worker, outbox-worker and five
# more lanes before image-variant-worker, the only consumer of `default`. A
# schedule shipped in this release would therefore be deferred by a new lane
# and fetched by an old default worker that has never heard of the name:
# TaskNotFound, a failed job, and the zero-threshold "Procrastinate worker
# fetched an unknown task" page on this release's own rollout -- the
# hazard. Register first, produce second: this release only teaches every
# lane the name; the lifecycle release adds
# @app.periodic(cron=settings.DYTE_CREATE_RECONCILIATION_CRON) together with
# the real body, and any tick it defers onto a not-yet-rolled default worker
# runs this inert body instead of failing.
@app.task(name="dyte.reconcile_create_unknowns", queue="default")
def reconcile_create_unknowns(timestamp: int):
    """Register the future recovery task before its lifecycle is released.

    This additive-schema release deliberately performs no work and schedules
    nothing. The ``timestamp`` argument matches the periodic signature the
    lifecycle release will defer with, so a tick that lands on a worker still
    running this release completes as a no-op.
    """
    return None


class _RecoveryMessage:
    """Small Message-shaped adapter for the durable recovery task."""

    def __init__(self, payload):
        import json

        self.data = json.dumps(payload).encode('utf-8')
        self.acked = False
        self.nacked = False
        self.lease_token = None

    def ack(self):
        self.acked = True

    def nack(self):
        self.nacked = True


@app.task(
    name="dyte.retry_recording_delivery",
    queue="recordings",
)
def retry_recording_delivery(delivery_id: str):
    """Retry one incomplete recording from its durable receipt.

    Pub/Sub is ACKed only after the receipt and this scheduled job exist. The
    task is idempotent: a fresh provider callback, a duplicate scheduled job,
    or a retry racing the recovery sweep all converge through the same
    recording lease and completed receipt.
    """
    delivery = (
        RecordingDelivery.objects.select_related('creator')
        .filter(idempotency_key=delivery_id, completed_at__isnull=True)
        .first()
    )
    if delivery is None or delivery.retry_exhausted_at is not None:
        return
    now = timezone.now()
    # A fresh provider callback clears next_retry_at and owns the next
    # attempt. Any already-queued recovery job is then stale and must not
    # download the refreshed URL a second time.
    if delivery.next_retry_at is None or delivery.next_retry_at > now:
        return
    # The queue marker prevents the sweep from creating duplicate jobs. Clear
    # it at the start of execution so a killed worker leaves the due row
    # eligible for the next sweep.
    RecordingDelivery.objects.filter(
        idempotency_key=delivery.idempotency_key,
        recovery_queued_at__isnull=False,
    ).update(recovery_queued_at=None)
    if not delivery.download_url or delivery.creator is None:
        from dj.apps.dyte.management.commands.dyte_download_upload import (
            RECORDING_DOWNLOAD_RETRY_EXHAUSTED_SIGNAL,
            terminalize_recording_delivery,
        )
        terminalize_recording_delivery(delivery.idempotency_key)
        logger.error(
            "%s: recording=%s has no durable recovery inputs",
            RECORDING_DOWNLOAD_RETRY_EXHAUSTED_SIGNAL, delivery_id,
        )
        return

    from dj.apps.dyte.management.commands.dyte_download_upload import callback

    message = _RecoveryMessage({
        'creator_id': int(delivery.creator_id),
        'username': delivery.creator.username,
        'url': delivery.download_url,
        'recording_idempotency_key': str(delivery.idempotency_key),
        'meeting_pk': delivery.meeting_pk,
        '_recording_recovery': True,
        '_legacy_fallback': delivery.legacy_fallback,
    })
    callback(message)
    if not message.nacked:
        return

    # catch_errors deliberately converts callback failures into Pub/Sub NACKs.
    # For this DB-backed path, convert that NACK into the same bounded durable
    # state transition so a provider/network outage cannot strand the row with
    # no next attempt after the original Pub/Sub message was ACKed.
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        enqueue_recording_recovery, record_recording_failure,
    )

    outcome, next_retry_at = record_recording_failure(
        delivery.idempotency_key, message.lease_token)
    if outcome == 'scheduled':
        enqueue_recording_recovery(delivery.idempotency_key, next_retry_at)
    elif outcome == 'exhausted':
        from dj.apps.dyte.management.commands.dyte_download_upload import (
            RECORDING_DOWNLOAD_RETRY_EXHAUSTED_SIGNAL,
        )
        logger.error(
            "%s: recording=%s creator=%s durable recovery exhausted; "
            "awaiting a fresh provider callback",
            RECORDING_DOWNLOAD_RETRY_EXHAUSTED_SIGNAL,
            delivery.idempotency_key,
            delivery.creator.username,
        )


@app.periodic(cron=settings.DYTE_RECORDING_RECOVERY_CRON)
@app.task(name="dyte.recover_recording_deliveries", queue="default")
def recover_recording_deliveries(timestamp: int):
    """Re-enqueue missed recovery jobs and report incomplete receipts."""
    from dj.apps.dyte.management.commands.dyte_download_upload import (
        enqueue_recording_recovery,
    )

    now = timezone.now()
    due = list(
        RecordingDelivery.objects.filter(
            completed_at__isnull=True,
            retry_exhausted_at__isnull=True,
            download_url__gt='',
            next_retry_at__lte=now,
            recovery_queued_at__isnull=True,
        ).filter(
            Q(lease_token__isnull=True) | Q(lease_expires_at__lte=now),
        ).order_by('next_retry_at')[
            :settings.DYTE_RECORDING_RECOVERY_BATCH_SIZE]
    )
    queued = 0
    for delivery in due:
        try:
            queued += int(
                enqueue_recording_recovery(
                    delivery.idempotency_key, delivery.next_retry_at)
            )
        except Exception:
            # The row remains due, so the next sweep can enqueue it. Do not
            # turn one queue outage into a failed periodic task that obscures
            # the actual recording receipt needing recovery.
            logger.exception(
                "Could not enqueue recording recovery for %s",
                delivery.idempotency_key,
            )

    stale_cutoff = now - timedelta(
        seconds=settings.DYTE_RECORDING_STUCK_AFTER_SECONDS)
    # `RECORDING DOWNLOAD RETRY EXHAUSTED` is the immediate terminal-failure
    # signal. This CRITICAL signal is specifically for staleness, so a fresh
    # terminal 400 must still age past the threshold before it is called
    # "stuck"; retry_exhausted_at is not an age substitute.
    stuck_candidates = RecordingDelivery.objects.filter(
        completed_at__isnull=True,
        stuck_alerted_at__isnull=True,
        recovery_started_at__lte=stale_cutoff,
    ).filter(
        Q(lease_expires_at__isnull=True) | Q(lease_expires_at__lte=now),
    )
    stuck_ids = list(stuck_candidates.values_list('pk', flat=True))
    oldest = stuck_candidates.order_by('recovery_started_at').values_list(
        'recovery_started_at', flat=True).first()
    stuck_count = RecordingDelivery.objects.filter(
        pk__in=stuck_ids,
        stuck_alerted_at__isnull=True,
    ).update(stuck_alerted_at=now)
    if stuck_count:
        from dj.apps.dyte.management.commands.dyte_download_upload import (
            RECORDING_INGESTION_STUCK_SIGNAL,
        )
        logger.error(
            "%s: incomplete=%d oldest_age_seconds=%d",
            RECORDING_INGESTION_STUCK_SIGNAL,
            stuck_count,
            max(0, round((now - oldest).total_seconds())) if oldest else 0,
        )
    logger.info(
        "dyte recording recovery sweep: due=%d queued=%d stuck=%d",
        len(due), queued, stuck_count,
    )


#Where the last budgeted sweep stopped, as a CreatorMeeting pk. A
#scheduling hint only: losing it (cache restart, eviction, a LocMemCache
#in a second process) costs one cycle of fairness and nothing else, which
#is why this is the cache and not a column. In every non-LOCALDEV
#environment CACHES points at the shared Redis, so the hint is shared by
#whichever worker runs the tick.
SWEEP_CURSOR_KEY = 'dyte:sweep_live_meetings:cursor'
#Comfortably longer than any sane sweep interval, short enough that a
#cursor pointing at a long-deleted room does not live forever.
SWEEP_CURSOR_TTL_SECONDS = 24 * 60 * 60


def _cursor_key():
    """The cursor key, namespaced by database.

    Stage, test and prod point at the SAME Redis (Memorystore) and the same
    logical database 1. prod_settings sets ``OPTIONS["PREFIX"]``, which
    reads like a namespace and is not one: django_redis 5.4 has no
    ``PREFIX`` option at all (Django namespaces with the top-level
    ``KEY_PREFIX``, which is unset here), so an un-namespaced key is
    literally shared between environments. A stage worker writing a cursor
    above prod's live-room pks would reset prod to the lowest pk on every
    tick -- silently reintroducing exactly the monopolisation this cursor
    exists to prevent. The database name is the discriminator the config
    already intended to use (codex round 5).
    """
    name = settings.DATABASES.get('default', {}).get('NAME') or 'unknown'
    return f"{name}:{SWEEP_CURSOR_KEY}"


def _read_cursor():
    """Last pk reached, or None. A cache outage must not fail the sweep."""
    try:
        return cache.get(_cursor_key())
    except Exception:
        logger.warning("sweep_live_meetings: could not read the probe cursor",
                       exc_info=True)
        return None


def _write_cursor(pk):
    try:
        cache.set(_cursor_key(), pk, SWEEP_CURSOR_TTL_SECONDS)
    except Exception:
        logger.warning("sweep_live_meetings: could not store the probe cursor",
                       exc_info=True)


def _probe_order(queryset, tick: int):
    """One priority slot, then a round robin the provider cannot influence.

    A budgeted sweep cannot probe every room, so the order decides who gets
    starved. The naive orderings both fail, and both failures are real:

    - Ordering purely by ``last_seen_at`` looks like self-correcting round
      robin (a room that is not probed ages, so it rises) -- but ONLY while
      probes succeed. A probe that TIMES OUT writes nothing, so a room
      whose provider endpoint is broken keeps its old last_seen_at and
      leads EVERY subsequent sweep. Three such rooms at 15s apiece consume
      the whole 45s budget forever; healthy broadcasts behind them are
      never confirmed and disappear from PublicMeetingViewSet at
      DYTE_LIVE_LAST_SEEN_TTL_SECONDS (300s), while the stale-clear valve
      does not remove the offenders until 900s.
    - Rotating a cursor through that same ordering does not fix it either:
      a successful probe CHANGES the sort key, so the list is reshuffled
      under the cursor and advancing it guarantees no coverage at all.

    So the round robin runs over ``pk`` -- immutable, and in particular
    unaffected by whether a probe succeeded, failed or was skipped. The
    cursor is the last pk the previous tick reached, and each tick resumes
    after it and wraps. Coverage is then arithmetic: with k probes per tick
    and N live rooms, every room is probed within ceil(N / (k-1)) ticks
    NO MATTER WHAT THE PROVIDER DOES.

    The one reserved slot goes to the least-recently-confirmed room, so the
    sweep still resolves dead rooms promptly rather than waiting for its
    turn in the cycle. A permanently failing room does hold that slot (its
    last_seen_at never moves), which is why it is exactly one slot: the
    worst case a broken provider can impose is one wasted probe per tick,
    and the stale-clear valve retires the room at 900s.
    """
    rooms = list(queryset)
    if len(rooms) < 2:
        return rooms

    # rooms arrives least-recently-confirmed first, so rooms[0] is the
    # priority slot.
    priority = rooms[0]
    cycle = sorted(rooms, key=lambda cm: cm.pk)
    cursor = _read_cursor()
    if cursor is not None:
        # First room after the cursor; wraps to 0 when the cursor is at or
        # past the highest pk, or names a room that is no longer live.
        start = next(
            (i for i, cm in enumerate(cycle) if cm.pk > cursor), 0)
    else:
        # No cursor: a cold cache, an eviction, or Redis being down. Do NOT
        # restart at the lowest pk every tick -- that is the monopolisation
        # bug again, just with a cache outage as the trigger, and the two
        # failures correlate (a bad afternoon is bad for both) (codex round
        # 6). Rotate by the periodic tick instead. This works HERE, where
        # it did not for the last_seen_at ordering, precisely because the
        # cycle is keyed on pk: the list does not reshuffle under the
        # offset, so advancing it covers everything. Coverage degrades from
        # ceil(N / (k-1)) ticks to O(N) ticks, which is the honest cost of
        # having no memory -- but it is finite, and it is not "the same
        # three rooms forever". ``tick // 60`` because the periodic
        # timestamp advances by the cron period (default 60s).
        start = (int(tick) // 60) % len(cycle)
    cycle = cycle[start:] + cycle[:start]

    return [priority] + [cm for cm in cycle if cm.pk != priority.pk]


@app.periodic(cron=settings.DYTE_LIVE_SWEEP_CRON)
@app.task(name="dyte.sweep_live_meetings", queue="default")
def sweep_live_meetings(timestamp: int):
    """
    Probe every room currently flagged live and reconcile live_now.

    For each CreatorMeeting with live_now=True we ask the provider's
    active-session endpoint for the live participant count and:

    - count > 0: presence confirmed -> refresh last_seen_at (stays live).
    - count == 0: confirmed empty -> clear live_now, UNLESS last_seen_at is
      within DYTE_LIVE_SWEEP_GRACE_SECONDS, which protects a room that just
      went live (creator's client still connecting, provider still reporting
      0). The grace only delays a real clear by at most that window.
    - provider error: get_participants_count raises (network/5xx/auth/JSON).
      A transient error NEVER flips a live room off on its own — but it must
      not be able to pin live_now on forever either. If presence has not been
      confirmed for DYTE_LIVE_STALE_CLEAR_SECONDS we clear live_now anyway:
      a room nobody has been seen in for that long is not live, whatever the
      provider is or isn't telling us. (Note a 404 from the provider is a
      *confirmed zero*, not an error — see DyteClient.get_participants_count.)

    Failures are isolated per room so one bad probe can't abort the sweep.
    Updates use a filtered.update() so we never clobber a concurrent
    go-live and never touch unrelated fields.

    BOUNDED, two ways. Every provider call now carries
    (DYTE_CONNECT_TIMEOUT_SECONDS, DYTE_READ_TIMEOUT_SECONDS), so no single
    probe can hang forever on a black-holed socket. That alone is not
    enough: the per-room bound multiplies by the number of live rooms, and
    this task is periodic every DYTE_LIVE_SWEEP_CRON on the catch-all
    `default` queue, so a slow provider plus a busy night would let one tick
    outlive its own cron and queue behind its successor while every other
    default/images/billing-fallback job waits. So the sweep also has a wall
    clock: DYTE_LIVE_SWEEP_BUDGET_SECONDS, checked BEFORE each probe. Rooms
    not reached are skipped, counted and logged -- never failed, never
    cleared on no evidence.

    Read what that budget is, exactly: it bounds when the sweep stops
    STARTING work, so a tick lasts at most the budget plus ONE probe. And
    `requests` applies its read timeout per socket read, not to the whole
    response, so that one probe is only bounded for a provider that goes
    SILENT -- a provider trickling bytes just inside the read timeout can
    outlive the budget (codex round 5). That is a property of synchronous
    `requests`, not of this budget; a true total deadline means streaming
    the body against a manual clock (or a different HTTP client) on all
    three call sites, including the interactive join path, which is a
    change with its own blast radius and is not 's. What IS closed
    here is the unbounded case: before this, a socket that accepted the
    connection and said nothing pinned the whole `default` lane forever.

    ORDERING -- see _probe_order. One priority slot for the room the sweep
    most needs a verdict on, then a round robin over a key probe outcomes
    cannot move, so a handful of rooms whose probes time out can waste at
    most ONE slot per tick instead of the whole budget.

    Ordering decides WHO waits; it cannot create capacity. If
    rooms x probe_latency / budget exceeds
    DYTE_LIVE_LAST_SEEN_TTL_SECONDS, then no schedule keeps every room on
    the public list -- the sweep is simply too small for the fleet, and the
    answer is a bigger DYTE_LIVE_SWEEP_BUDGET_SECONDS (with a cron to
    match) or a longer TTL. That is why `skipped` is on the summary line
    and why a tick that skips anything logs at WARNING: it is the signal
    that the budget needs raising, and it arrives before anyone notices a
    missing broadcast.

    Logging is aggregated: this runs on a tight cron over every live room, so
    per-room lines at ERROR/WARNING drown real errors in Cloud Logging. One
    summary line per sweep, WARNING only when something actually failed or
    was skipped.
    """
    # Imported lazily so autodiscovery of this module never drags in the
    # Django ORM / app models before the app registry is ready.
    from dj.apps.dyte.client import DyteClient
    from dj.apps.dyte.models import CreatorMeeting

    dc = DyteClient(settings.DYTE_ORG)
    now = timezone.now()
    grace_cutoff = now - timedelta(seconds=settings.DYTE_LIVE_SWEEP_GRACE_SECONDS)
    stale_cutoff = now - timedelta(
        seconds=settings.DYTE_LIVE_STALE_CLEAR_SECONDS)

    def _is_stale(cm):
        # No confirmed presence ever, or none for a long time.
        return cm.last_seen_at is None or cm.last_seen_at < stale_cutoff

    checked = refreshed = cleared = stale_cleared = errors = 0
    # Distinct failure messages, so one summary line still says *what* broke
    # without emitting a line per room per sweep.
    error_kinds = Counter()

    budget = settings.DYTE_LIVE_SWEEP_BUDGET_SECONDS
    # Materialised so "how many did we not get to" is answerable without a
    # second query racing a concurrent go-live.
    rooms = _probe_order(
        CreatorMeeting.objects.filter(live_now=True).order_by(
            F('last_seen_at').asc(nulls_first=True), 'pk'),
        tick=timestamp,
    )
    # monotonic, not time.time(): an NTP step must not be able to hand this
    # loop an unbounded budget (or end it instantly). Started AFTER the
    # query, because the budget is a bound on PROBING -- charging the
    # round trip to it would mean a slow database could stop a sweep from
    # probing anything at all, silently.
    deadline = time.monotonic() + budget
    skipped = 0
    last_reached = None

    for index, cm in enumerate(rooms):
        # Checked BEFORE the probe: the budget bounds when the sweep stops
        # STARTING work, so the true wall clock is budget + one probe.
        if time.monotonic() >= deadline:
            skipped = len(rooms) - index
            break
        last_reached = cm.pk
        checked += 1
        try:
            count = dc.get_participants_count(cm.meeting_id)
        except Exception as exc:
            # Provider/network error: unknown state, not a confirmed zero.
            errors += 1
            error_kinds[f"{type(exc).__name__}: {exc}"] += 1
            # Safety valve: an unreachable provider must not pin a room
            # "live" indefinitely. Presence that has gone stale is cleared
            # even without a confirmed zero.
            if _is_stale(cm):
                CreatorMeeting.objects.filter(pk=cm.pk).update(live_now=False)
                stale_cleared += 1
            continue

        if count > 0:
            CreatorMeeting.objects.filter(pk=cm.pk).update(last_seen_at=now)
            refreshed += 1
            continue

        # Confirmed zero. Protect a room that just went live from being
        # flipped off before its participants can register.
        if cm.last_seen_at is not None and cm.last_seen_at > grace_cutoff:
            continue

        CreatorMeeting.objects.filter(pk=cm.pk).update(live_now=False)
        cleared += 1

    # Advance the round robin. Written even when the sweep reached every
    # room, so the next tick starts after the last one it touched.
    if last_reached is not None:
        _write_cursor(last_reached)

    summary = (
        "sweep_live_meetings: checked=%s refreshed=%s cleared=%s "
        "stale_cleared=%s errors=%s skipped=%s budget_seconds=%s"
    )
    args = [checked, refreshed, cleared, stale_cleared, errors, skipped,
            budget]
    if errors:
        # Still one line, not one per room. Cap the sample so a total
        # provider outage can't blow up the log entry either.
        logger.warning(
            summary + " | failures: %s",
            *args, "; ".join(
                f"{msg} (x{n})" for msg, n in error_kinds.most_common(3)),
        )
    elif skipped:
        # Not an error -- the next tick picks these up, oldest first -- but
        # it means the sweep is no longer keeping up with the room count, so
        # it must be visible rather than absorbed silently.
        logger.warning(summary, *args)
    else:
        logger.info(summary, *args)
