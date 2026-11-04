"""
Periodic self-observation of the Procrastinate queue.

The queue watches itself — as  put it, eat our own dogfood. The
health sweep runs on the ``default`` queue, so if the catch-all worker
Deployment is down or its queue-consumption connection has wedged, the sweep stops
emitting and
the ``procrastinate | health sweep not running`` metric-absence policy in
``monitoring/`` fires. That absence IS the worker-liveness signal asked
for in  item 3 — a probe on the pod would only prove the process is
alive, not that it is still consuming jobs.

Output format: one line of **bare JSON per queue** plus one summary line.
GKE's logging agent parses a log line that is entirely JSON into
``jsonPayload`` and honours a top-level ``severity``, so these become
structured, filterable Cloud Logging entries with no formatter change to
settings.LOGGING (a plain StreamHandler with the default
``%(message)s``). Keep the JSON on ONE line and keep ``message`` present:
without it the Logs Explorer shows an empty summary row.

The alert *decisions* are made here, in Python, not in a Cloud Monitoring
threshold — so they are unit-testable against real Postgres, and the
alert policies only have to match ``jsonPayload.alert``. See
``health.QueueHealth.alerts()``.
"""
import logging

from django.conf import settings

from procrastinate.contrib.django import app

from dj.apps.jobs import reclaim
from dj.apps.jobs.logs import emit_json_line

logger = logging.getLogger(__name__)


def _log(payload: dict, severity: str, message: str) -> None:
    emit_json_line(logger, payload, severity, message)


def report_job_health() -> dict:
    """
    Collect the health report and emit it. Returns the summary payload so
    the management command and the tests can assert on it without
    scraping logs.
    """
    from dj.apps.jobs import health

    report = health.collect()

    for queue in report.queues:
        payload = queue.as_payload(report.window_seconds)
        alerts = payload['alerts']
        if alerts:
            # One line per (queue, alert) so a Cloud Logging filter can
            # match a single alert name without regex-ing a list.
            for alert in alerts:
                # A refund alert is about refunds, which `failed_recent` does
                # not count; say the number the alert fired on.
                refunds = (
                    f' refunded_recent={queue.refunded_recent} '
                    f'refunded_codes={queue.refunded_codes}'
                    if alert == 'translation_refunds' else ''
                )
                _log(
                    dict(payload, alert=alert),
                    'ERROR',
                    f'procrastinate {alert}: queue={queue.queue} '
                    f'failed_recent={queue.failed_recent} '
                    f'overdue={queue.todo_overdue} '
                    f'oldest_overdue_seconds='
                    f'{round(queue.oldest_overdue_seconds)}{refunds}',
                )
        else:
            _log(
                dict(payload, alert=None),
                'INFO',
                f'procrastinate ok: queue={queue.queue} '
                f'todo={queue.todo} doing={queue.doing} '
                f'failed_recent={queue.failed_recent}',
            )

    summary = report.summary_payload()
    _log(
        summary,
        'INFO',
        'procrastinate job health sweep: '
        f'queues={summary["queues"]} '
        f'failed_recent_total={summary["failed_recent_total"]} '
        f'alerts={summary["alerts"] or "none"}',
    )
    return summary


@app.periodic(cron=settings.JOB_HEALTH_SWEEP_CRON)
@app.task(name='jobs.report_job_health', queue='default')
def report_job_health_task(timestamp: int):
    """
    Periodic wrapper. Deliberately has NO retry strategy: the next tick
    is the retry, and a retried observability sweep would only duplicate
    log lines (and therefore duplicate alerts).
    """
    return report_job_health()


@app.periodic(cron=settings.JOB_RECLAIM_SWEEP_CRON)
@app.task(
    name=reclaim.RECLAIM_TASK_NAME, queue='default',
    queueing_lock='jobs-reclaim-stalled-jobs',
)
async def reclaim_stalled_jobs_task(timestamp: int):
    """
    Periodic self-HEALING, next to the periodic self-observation above
    .

    ``queueing_lock`` coalesces pending ticks. The Django connector holds a
    transaction-scoped PostgreSQL advisory lock across the sweep. The
    production worker's psycopg pool takes a non-blocking advisory lock in
    each row transaction, so it does not hold a Django transaction or pin a
    pooler server slot while waiting on the worker pool. Each row is revalidated and its lease
    compare-and-deleted before the status procedure runs; row transactions
    isolate failures. Fencing stops later lease beats and status persistence,
    but cannot cancel an external request already sent by a synchronous task.

    Async because Procrastinate invokes coroutine tasks natively on the
    worker's loop.

    No retry strategy, for the same reason as ``report_job_health_task``:
    the next tick IS the retry, and a retried sweep would double-count in
    the give-up metric.
    """
    return await reclaim.reclaim_stalled_jobs()


# ---------------------------------------------------------------------------
# Pub/Sub transactional outbox relay
# ---------------------------------------------------------------------------
#
# Both of these run one bounded `outbox.drain()` pass. They differ only in
# what wakes them:
#
#   publish_outbox  -- deferred from `transaction.on_commit` by a producer.
#                      Latency: a message goes out as soon as its row commits.
#   sweep_outbox    -- periodic. The DURABILITY half: it picks up rows whose
#                      on_commit defer never happened (process died between
#                      COMMIT and the callback -- the exact crash window
#                      exists to close), rows whose backoff has since expired,
#                      emits the backlog health line, and prunes one bounded
#                      batch of expired published payloads.
#
# On the dedicated `pubsub` queue: `test_queue_isolation.py` requires every
# registered queue to be named in a worker manifest, and the relay's latency
# matters independently of ordinary image/search work. It must NOT go on
# `billing` (that lane is money-only, and the test enforces it) and must not go
# on `recordings`/`exports` (multi-GB, serial).
#
# The dedicated worker removes waits behind unrelated ordinary jobs.
# The relay has a between-row drain budget, but its own backlog and database
# stalls can still delay it. Five-second idle polling is not a queue-wait bound.
# That matters for
# both outbox topics, including `dyte-video-ready-prod`, whose presigned
# `downloadUrl` EXPIRES: a message delayed past that point cannot be recovered
# by any retry. `comments-prod` is also an outbox publication and therefore
# uses this same dedicated relay lane.
#
# NO RetryStrategy on either: retry state lives in the outbox ROW
# (`attempts` / `next_attempt_at`), which survives a worker restart, whereas
# a Procrastinate retry does not survive the job being dropped. Two retry
# ladders over the same work would also compound into a schedule nobody can
# reason about.

@app.task(name='jobs.publish_outbox', queue='pubsub', retry=False)
def publish_outbox_task():
    """Relay one batch, and re-defer while rows are still due."""
    from dj.apps.jobs import outbox

    result = outbox.drain()
    if result['more']:
        # Bounded batches mean a backlog needs more than one pass. Re-defer
        # rather than looping: the queueing lock is free again by now, and a
        # job that returns keeps the worker slot fair.
        outbox.defer_relay()
    return result


@app.periodic(cron=settings.PUBSUB_OUTBOX_SWEEP_CRON)
@app.task(
    name='jobs.sweep_outbox', queue='pubsub', retry=False,
    # COALESCE. A pass may spend up to PUBSUB_OUTBOX_DRAIN_BUDGET_SECONDS
    # plus one row's worst case, and the budget is set so that total stays
    # under this cron's period -- but only under the default settings. The
    # lock is the guard that does not depend on that arithmetic: at most one
    # sweep is ever pending, so a sustained Pub/Sub slowdown cannot stack
    # sweeps on the single shared worker behind images and search.
    queueing_lock='jobs-outbox-sweep-pubsub',
)
def sweep_outbox_task(timestamp: int):
    """Periodic backstop, retention sweep, and backlog observability line.

    Health is emitted BEFORE the drain, deliberately. The alert policy
    matches this line, and a pass that is slow because Pub/Sub is slow is
    exactly when the backlog needs reporting -- logging afterwards let a
    drain delay its own alert by up to PUBSUB_OUTBOX_DRAIN_BUDGET_SECONDS.
    The reading is therefore pre-drain, which is the honest one: it is the
    backlog that existed when the sweep started.
    """
    from dj.apps.jobs import outbox

    # Run independently of Pub/Sub health: a client outage must not stop the
    # safe cleanup of rows that were already published, while the single
    # bounded batch keeps this shared worker fair. Retention is best effort;
    # even an unexpected maintenance failure must not suppress health or
    # delivery from this sweep.
    try:
        pruned = outbox.prune_published()
    except Exception:
        logger.exception('outbox: published retention prune failed; continuing')
        pruned = 0
    # Captured payment facts own notification retry intent independently of
    # Event/outbox inserts, so a notification outage cannot block new buyers.
    from dj.apps.economy.captured_notes import recover_payment_notices
    recover_payment_notices()
    health = outbox.log_health()
    result = outbox.drain()
    if result['more']:
        # Same continuation as publish_outbox_task, and it is NOT redundant
        # here. After an outage the producers have all finished and nothing
        # else defers a relay, so without this a 1000-row backlog drains one
        # bounded batch every PUBSUB_OUTBOX_SWEEP_CRON tick -- twenty
        # minutes for ten batches, with recording download URLs expiring
        # behind them -- even though publishing is fast again.
        outbox.defer_relay()
    return {'health': health, 'pruned': pruned, 'drained': result}


# ---------------------------------------------------------------------------
# Test-only and smoke tasks
# ---------------------------------------------------------------------------
#
# procrastinate's Django integration autodiscovers `tasks.py` modules only, so
# a task defined elsewhere is registered in a process exactly when that module
# is imported. These two are imported HERE, unconditionally, because every
# process has to agree on the registry: the worker subprocess the chaos tests
# spawn must know `jobs.chaos_probe` to run it, and the registry contract
# tests (`test_every_registered_task_has_a_reclaim_policy`,
# `test_every_registered_queue_is_served_by_some_worker`) must see the same
# `app.tasks` the workers see. Neither task is ever deferred by production
# code; read their modules for the guards that keep it that way.
from dj.apps.jobs import chaos_tasks  # noqa: E402,F401  (registration side effect)
from dj.apps.jobs import smoke  # noqa: E402,F401  (registration side effect)
