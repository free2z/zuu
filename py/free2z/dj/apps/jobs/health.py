"""
Health snapshot of the Procrastinate queue.

Everything here is a read-only query against the real
``procrastinate_jobs`` / ``procrastinate_events`` tables, returned as
plain dataclasses so it can be logged, printed, or asserted on in tests
without a Cloud Monitoring round trip.

UNITS — every duration in this module is **seconds** (float), and every
field holding one is named ``*_seconds``. Every count is a **count of
jobs**, never a rate. The alert thresholds in ``settings`` use the same
units; do not introduce a milliseconds or per-minute value here without
renaming the field.

WHAT COUNTS AS A FAILURE
------------------------
``procrastinate_jobs.status = 'failed'`` is **terminal**: when a task has
a retry strategy and the attempt is retryable, Procrastinate puts the job
back to ``'todo'`` and records a ``deferred_for_retry`` event. A row only
reaches ``'failed'`` once the retry strategy declines to retry — i.e.
retries are exhausted (or the task has none). So "failed" here already
means "gave up", which is exactly the thing worth paging about, and a
transient blip that succeeds on attempt 2 never shows up.

WHAT COUNTS AS "LATE"
---------------------
A ``'todo'`` job is not late just because it exists — ``renew_subscription``
jobs are deliberately scheduled up to 30 days into the future. A job is
late only once it is *runnable* and still hasn't run, so age is measured
from ``ready_at = COALESCE(scheduled_at, <its 'deferred' event>)`` and
only jobs with ``ready_at <= now`` are considered. Getting this wrong the
other way (counting future-scheduled billing jobs as backlog) would page
constantly and is the single most likely calibration mistake here.
"""
from __future__ import annotations

import dataclasses
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db import connections
from django.utils import timezone

from procrastinate.contrib.django import settings as procrastinate_settings

from dj.apps.jobs import reclaim_policy

#The queue ``g12f.translate_zpage`` runs on. Its refunds are reported on this
#queue's line, because that is the line a responder already reads for it.
TRANSLATION_QUEUE = 'translation'

_LEGACY_TASK_BUDGET_CASE = 'CASE j.task_name ' + ' '.join(
    f"WHEN '{task_name.replace(chr(39), chr(39) * 2)}' "
    f'THEN {policy.max_runtime_seconds}'
    for task_name, policy in reclaim_policy.TASK_POLICIES.items()
    if policy.max_runtime_seconds is not None
) + ' ELSE 0 END'
_BOUNDED_TASK_NAMES = [
    task_name for task_name, policy in reclaim_policy.TASK_POLICIES.items()
    if policy.max_runtime_seconds is not None
]
_NEVER_TASK_NAMES = [
    task_name for task_name, policy in reclaim_policy.TASK_POLICIES.items()
    if policy.max_runtime_seconds is None
]
_NEVER_TASK_ALERT_CASE = 'CASE j.task_name ' + ' '.join(
    f"WHEN '{task_name.replace(chr(39), chr(39) * 2)}' "
    f'THEN {policy.health_alert_after_seconds}'
    for task_name, policy in reclaim_policy.TASK_POLICIES.items()
    if policy.max_runtime_seconds is None
    and policy.health_alert_after_seconds is not None
) + ' ELSE %(stuck_doing_seconds)s END'

# Aggregate per-queue job counts and worst-case ages in ONE round trip.
#
# COST: the outer scan is restricted to the WORKING SET (todo/doing/failed)
# and is served by the partial index added in
# dj/apps/jobs/migrations/0001_procrastinate_status_index.py; succeeded jobs
# accumulate forever and are never touched here. The per-job event fold is a
# LATERAL (correlated) subquery rather than a grouped scan of
# procrastinate_events, so it drives off procrastinate_events_job_id_fkey_v1
# and stays proportional to the working set too, not to all history. That
# matters: this runs every 5 minutes forever, and nothing prunes those two
# tables today.
_QUEUE_SQL = f"""
SELECT
    j.queue_name,
    COUNT(*) FILTER (WHERE j.status = 'todo')   AS todo,
    COUNT(*) FILTER (WHERE j.status = 'doing')  AS doing,
    COUNT(*) FILTER (WHERE j.status = 'failed') AS failed_total,
    COUNT(*) FILTER (
        WHERE j.status = 'failed' AND e.failed_at >= %(cutoff)s
    ) AS failed_recent,
    COUNT(*) FILTER (
        WHERE j.status = 'todo'
          AND COALESCE(j.scheduled_at, e.deferred_at) <= %(now)s
    ) AS todo_overdue,
    COALESCE(MAX(
        EXTRACT(EPOCH FROM (
            %(now)s::timestamptz
            - COALESCE(j.scheduled_at, e.deferred_at)
        ))
    ) FILTER (
        WHERE j.status = 'todo'
          AND COALESCE(j.scheduled_at, e.deferred_at) <= %(now)s
    ), 0) AS oldest_overdue_seconds,
    COALESCE(MAX(
        EXTRACT(EPOCH FROM (%(now)s::timestamptz - e.started_at))
    ) FILTER (WHERE j.status = 'doing'), 0) AS oldest_doing_seconds,
    COALESCE(MAX(CASE WHEN j.task_name = ANY(%(never_tasks)s)
        THEN GREATEST(0,
            EXTRACT(EPOCH FROM (%(now)s::timestamptz - e.started_at))
            - ({_NEVER_TASK_ALERT_CASE})
        ) ELSE GREATEST(0,
            EXTRACT(EPOCH FROM (%(now)s::timestamptz - e.started_at))
            - CASE WHEN j.task_name = ANY(%(bounded_tasks)s)
                THEN COALESCE(({_LEGACY_TASK_BUDGET_CASE}), 0)
                    + %(budget_margin)s
                ELSE %(stuck_doing_seconds)s
              END
        ) END) FILTER (
            WHERE j.status = 'doing'
              AND orphan_state.eligible_since > %(now)s
        ), 0)
        AS oldest_over_budget_seconds,
    COUNT(*) FILTER (WHERE j.status = 'doing'
        AND orphan_state.eligible_since <= %(now)s) AS orphaned,
    COALESCE(MAX(EXTRACT(EPOCH FROM (
        %(now)s::timestamptz - orphan_state.eligible_since)))
        FILTER (WHERE j.status = 'doing'
        AND orphan_state.eligible_since <= %(now)s), 0)
        AS oldest_orphaned_seconds,
    COUNT(*) FILTER (WHERE j.status = 'doing' AND l.deadline_at <= %(now)s)
        AS past_deadline
FROM procrastinate_jobs j
LEFT JOIN LATERAL (
    SELECT
        MIN(ev.at) FILTER (WHERE ev.type = 'deferred') AS deferred_at,
        MAX(ev.at) FILTER (WHERE ev.type = 'started')  AS started_at,
        MAX(ev.at) FILTER (WHERE ev.type = 'failed')   AS failed_at
    FROM procrastinate_events ev
    WHERE ev.job_id = j.id
) e ON TRUE
LEFT JOIN LATERAL (
    SELECT lease.job_id, lease.token, lease.last_beat_at,
           lease.deadline_at, lease.attempt, lease.phase,
           lease.phase_token, lease.phase_attempt
    FROM jobs_joblease lease
    WHERE lease.job_id = j.id
) l ON TRUE
LEFT JOIN procrastinate_workers w ON w.id = j.worker_id
LEFT JOIN LATERAL (
    SELECT EXISTS (
        SELECT 1 FROM jobs_quarantined_job q
        WHERE q.job_id = j.id AND q.requeued_at IS NULL
          AND q.attempts = j.attempts AND l.job_id IS NOT NULL
          AND q.reason IN (
              'recovery abandoned attempt before_body:' || l.token::text,
              'recovery abandoned attempt after_body:' || l.token::text
          )
    ) OR (l.job_id IS NOT NULL AND l.phase = 'before_body'
          AND l.attempt = j.attempts
          AND l.phase_token = l.token
          AND l.phase_attempt = j.attempts) AS matches
) abandoned ON TRUE
LEFT JOIN LATERAL (
    SELECT GREATEST(
        e.started_at + %(orphan_min_age)s * INTERVAL '1 second',
        CASE WHEN l.job_id IS NOT NULL
             THEN GREATEST(
                 l.last_beat_at
                     + %(lease_stale_seconds)s * INTERVAL '1 second',
                 CASE WHEN abandoned.matches
                           OR j.worker_id IS NULL OR w.id IS NULL
                           OR w.last_heartbeat IS NULL
                      THEN e.started_at
                           + %(orphan_min_age)s * INTERVAL '1 second'
                      ELSE w.last_heartbeat
                           + %(worker_stale_seconds)s * INTERVAL '1 second'
                 END
             )
             WHEN j.worker_id IS NULL OR w.id IS NULL
                       OR w.last_heartbeat IS NULL
             THEN e.started_at + %(orphan_min_age)s * INTERVAL '1 second'
             ELSE w.last_heartbeat
                + %(worker_stale_seconds)s * INTERVAL '1 second'
        END,
        CASE WHEN abandoned.matches
             THEN e.started_at + %(orphan_min_age)s * INTERVAL '1 second'
             WHEN j.task_name = ANY(%(bounded_tasks)s)
             THEN e.started_at + GREATEST(
                    %(orphan_min_age)s,
                    COALESCE(({_LEGACY_TASK_BUDGET_CASE}), 0)
                        + %(budget_margin)s
                  ) * INTERVAL '1 second'
             ELSE e.started_at + %(orphan_min_age)s * INTERVAL '1 second'
        END
    ) AS eligible_since
) orphan_state ON TRUE
WHERE j.status IN ('todo', 'doing', 'failed')
GROUP BY j.queue_name
ORDER BY j.queue_name
"""

# The tasks whose failure is most worth naming explicitly in the alert
# payload, so the person woken up knows what broke without a psql session.
_FAILED_TASKS_SQL = """
SELECT j.queue_name, j.task_name, COUNT(*) AS n
FROM procrastinate_jobs j
JOIN LATERAL (
    SELECT MAX(ev.at) AS failed_at
    FROM procrastinate_events ev
    WHERE ev.job_id = j.id AND ev.type = 'failed'
) e ON TRUE
WHERE j.status = 'failed' AND e.failed_at >= %(cutoff)s
GROUP BY j.queue_name, j.task_name
ORDER BY n DESC
"""

# Translation purchases can legitimately wait behind a full healthy lane, so
# queue age no longer tells us whether that lane is making progress. Look for
# an actual Procrastinate `started` event in a short rolling window instead.
# This is queried only while translation has todo work, and the queue predicate
# keeps the lookup scoped to the dedicated, low-volume lane.
_TRANSLATION_STARTED_RECENTLY_SQL = """
SELECT EXISTS (
    SELECT 1
    FROM procrastinate_jobs j
    JOIN procrastinate_events ev ON ev.job_id = j.id
    WHERE j.queue_name = %(queue)s
      AND ev.type = 'started'
      AND ev.at >= %(cutoff)s
)
"""


@dataclasses.dataclass
class QueueHealth:
    """One row of the report: the state of a single Procrastinate queue."""

    queue: str
    #Jobs that exhausted retries within the failure window.
    failed_recent: int = 0
    #Jobs sitting in `failed` regardless of when they failed. Grows
    #without bound until someone retries or prunes them, which is why
    #alerting uses failed_recent instead.
    failed_total: int = 0
    todo: int = 0
    #Of `todo`, the ones that are runnable NOW and still haven't run.
    todo_overdue: int = 0
    doing: int = 0
    oldest_overdue_seconds: float = 0.0
    oldest_doing_seconds: float = 0.0
    #How long the oldest doing job has exceeded its health alert budget.
    #This is independent from whether reclaim_policy allows retrying it.
    oldest_over_budget_seconds: float = 0.0
    orphaned: int = 0
    oldest_orphaned_seconds: float = 0.0
    past_deadline: int = 0
    #Whether a translation job actually started in the throughput window.
    #None means the check was not needed (no translation backlog).
    translation_started_recently: bool | None = None
    failed_tasks: dict[str, int] = dataclasses.field(default_factory=dict)
    #TRANSLATION QUEUE ONLY. Translations sold and then refunded
    #within the failure window, by failure code, excluding the ones the
    #buyer caused. These jobs end `succeeded` -- the task refunds and returns
    #-- so `failed_recent` can never see them. Empty on every other queue.
    refunded_codes: dict[str, int] = dataclasses.field(default_factory=dict)

    @property
    def refunded_recent(self) -> int:
        return sum(self.refunded_codes.values())

    @property
    def is_billing(self) -> bool:
        return self.queue in set(settings.JOB_HEALTH_BILLING_QUEUES)

    @property
    def is_critical(self) -> bool:
        return self.queue in set(settings.JOB_HEALTH_CRITICAL_QUEUES)

    # -- thresholds ---------------------------------------------------
    # Billing gets its own, stricter number for every dimension: it is
    # the money path, its volume is tiny, and its steady state is zero.

    @property
    def failed_threshold(self) -> int:
        if self.is_billing:
            return settings.JOB_HEALTH_BILLING_FAILED_THRESHOLD
        if self.is_critical:
            return 1
        return settings.JOB_HEALTH_FAILED_THRESHOLD

    @property
    def overdue_threshold_seconds(self) -> int:
        if self.queue == "translation":
            # Billing-class for failures, not for lateness: a bulk purchase
            #  legitimately queues several documents behind the lane.
            # Derived from the queue model; see
            # JOB_HEALTH_TRANSLATION_OVERDUE_SECONDS.
            if settings.JOB_HEALTH_TRANSLATION_OVERDUE_SECONDS is not None:
                return settings.JOB_HEALTH_TRANSLATION_OVERDUE_SECONDS
            from dj.apps.g12f.translation import charges
            return charges.translation_overdue_threshold_seconds()
        if self.is_billing:
            return settings.JOB_HEALTH_BILLING_OVERDUE_SECONDS
        if self.queue == "exports":
            # One serial worker may legitimately leave the fourth admitted
            # 30-minute export runnable for roughly 90 minutes.
            return settings.JOB_HEALTH_EXPORTS_OVERDUE_SECONDS
        return settings.JOB_HEALTH_OVERDUE_SECONDS

    @property
    def translation_no_start_threshold_seconds(self) -> int:
        """Grace period for runnable translation work before lane-stall alert."""
        return settings.JOB_HEALTH_TRANSLATION_NO_START_SECONDS

    def alerts(self) -> list[str]:
        """
        Names of the alert conditions this queue currently trips.

        These strings are the contract with ``monitoring/alert-policies/``:
        the Cloud Logging filters match on them. Renaming one silently
        disarms a policy.
        """
        out: list[str] = []
        # `and self.failed_recent` so a misconfigured threshold of 0 does
        # not turn "no failures at all" into a permanent page.
        if self.failed_recent and self.failed_recent >= self.failed_threshold:
            out.append(
                'billing_jobs_failed' if self.is_billing else 'jobs_failed')
        elif self.failed_recent and not self.is_billing and not self.is_critical:
            #below the bursting threshold, an ordinary queue's
            # terminal failure was invisible forever -- 4 in 30 days, none
            # reviewed. `elif`, not `if`: this is deliberately mutually
            # exclusive with 'jobs_failed'/'billing_jobs_failed' above, so a
            # queue that already crossed its bursting threshold gets exactly
            # one alert name, not two racing to the same channel.
            #
            # `not self.is_billing and not self.is_critical` is belt and
            # braces -- both have `failed_threshold == 1`, so the branch
            # above already claims every failed_recent >= 1 for them and
            # this `elif` can never actually run for a billing/critical
            # queue. That includes `translation`: it is one of
            # JOB_HEALTH_BILLING_QUEUES, so a terminal failure there keeps
            # paging as 'billing_jobs_failed' same as today, and this
            # low-urgency signal never doubles up on it. Translation's own
            # REFUND-shaped failures (`give_up`, which never reaches
            # status='failed' at all) get their OWN metric below
            # (`refunds_alert` / 'translation_refunds', /); this
            # branch only ever sees translation if a job there fails for a
            # reason `give_up` could not observe, and that is already the
            # money-path alert's job, not this one's.
            out.append('jobs_failed_any')
        if self.refunds_alert():
            out.append('translation_refunds')
        if self.oldest_overdue_seconds >= self.overdue_threshold_seconds:
            out.append('queue_backlog')
        if (self.oldest_orphaned_seconds >=
                settings.JOB_HEALTH_STUCK_ORPHANED_SECONDS
                or self.oldest_over_budget_seconds > 0):
            out.append('job_stuck')
        if (self.queue == TRANSLATION_QUEUE and self.todo_overdue > 0
                and self.oldest_overdue_seconds >= (
                    self.translation_no_start_threshold_seconds)
                and self.translation_started_recently is False):
            out.append('translation_lane_stalled')
        return out

    def refunds_alert(self) -> bool:
        """Whether this queue's refunds trip ``translation_refunds``."""
        # `and self.refunded_recent` for the same reason as `failed_recent`
        # above: a threshold misconfigured to 0 must not page on nothing.
        if not self.refunded_recent:
            return False
        if self.refunded_recent >= (
            settings.JOB_HEALTH_TRANSLATION_REFUND_THRESHOLD
        ):
            return True
        at_one = set(settings.JOB_HEALTH_TRANSLATION_REFUND_ALERT_AT_ONE)
        return any(self.refunded_codes.get(code) for code in at_one)

    def as_payload(self, window_seconds: int) -> dict[str, Any]:
        return {
            'event': 'procrastinate_job_health',
            'queue': self.queue,
            'is_critical': self.is_critical,
            'is_billing': self.is_billing,
            'failed_recent': self.failed_recent,
            'failed_total': self.failed_total,
            'failed_tasks': self.failed_tasks,
            'refunded_recent': self.refunded_recent,
            'refunded_codes': self.refunded_codes,
            'todo': self.todo,
            'todo_overdue': self.todo_overdue,
            'doing': self.doing,
            # Rounded to whole seconds: sub-second precision is noise at
            # thresholds measured in minutes, and it keeps the log line
            # diffable between sweeps.
            'oldest_overdue_seconds': round(self.oldest_overdue_seconds),
            'oldest_doing_seconds': round(self.oldest_doing_seconds),
            'oldest_over_budget_seconds': round(
                self.oldest_over_budget_seconds),
            'orphaned': self.orphaned,
            'oldest_orphaned_seconds': round(self.oldest_orphaned_seconds),
            'past_deadline': self.past_deadline,
            'failure_window_seconds': window_seconds,
            'failed_threshold': self.failed_threshold,
            'overdue_threshold_seconds': self.overdue_threshold_seconds,
            'stuck_threshold_seconds': settings.JOB_HEALTH_STUCK_ORPHANED_SECONDS,
            'translation_started_recently': (
                self.translation_started_recently
                if self.queue == TRANSLATION_QUEUE else None),
            'translation_no_start_threshold_seconds': (
                self.translation_no_start_threshold_seconds
                if self.queue == TRANSLATION_QUEUE else None),
            'alerts': self.alerts(),
        }


@dataclasses.dataclass
class BackstopEvidence:
    """
    The numbers  asks for before the transition CronJobs can be
    retired: how much work the event-based scheduling is *leaving* for
    the ``publish-pages`` and ``renew-subs`` backstop sweeps.

    A backstop is redundant when these are durably zero. They are
    reported unconditionally (not alerted on) — a non-zero value here is
    evidence for a decision, not a page.
    """

    #Pages whose publish_at has passed but which are still unpublished:
    #work the hourly publish-pages sweep would do right now. Steady
    #state is 0 — the scheduled job publishes at the exact minute.
    pages_overdue_unpublished: int = 0
    #Future-dated pages with no pending publish_zpage job — i.e. pages
    #that ONLY the sweep will ever publish.
    pages_scheduled_without_job: int = 0
    #Non-cancelled, unexpired subscriptions.
    subscriptions_active: int = 0
    #...of which, the ones with no pending renew_subscription job.
    #criterion 2 is this reaching 0.
    subscriptions_without_job: int = 0

    def as_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class HealthReport:
    queues: list[QueueHealth]
    backstops: BackstopEvidence
    window_seconds: int

    def alerts(self) -> list[str]:
        seen: list[str] = []
        for q in self.queues:
            for a in q.alerts():
                if a not in seen:
                    seen.append(a)
        return seen

    def summary_payload(self) -> dict[str, Any]:
        return {
            'event': 'procrastinate_job_health_sweep',
            'queues': len(self.queues),
            'failed_recent_total': sum(q.failed_recent for q in self.queues),
            'refunded_recent_total': sum(
                q.refunded_recent for q in self.queues),
            'todo_total': sum(q.todo for q in self.queues),
            'todo_overdue_total': sum(q.todo_overdue for q in self.queues),
            'doing_total': sum(q.doing for q in self.queues),
            'failure_window_seconds': self.window_seconds,
            'alerts': self.alerts(),
            'backstops': self.backstops.as_dict(),
        }


def _connection():
    # Procrastinate may be configured against a non-default alias; read
    # its tables through the same one so this never reports on the wrong
    # database.
    alias = procrastinate_settings.settings.DATABASE_ALIAS
    return connections[alias]


# Backstop evidence, as COUNTs computed entirely in Postgres.
#
# The obvious implementation -- pull every active subscription id and every
# pending job id into Python and diff the sets -- is what the first draft
# did, and it is a live grenade: this runs every 5 minutes inside the SAME
# worker process that executes the billing queue, so an unbounded result
# set would eventually OOM the worker and stop renewals. (Caught by the
# codex adversarial review; see the PR body.) Counting in SQL keeps the
# worker's memory constant regardless of how many subscriptions or pages
# exist.
#
# The `args ->> 'x'` cast is how the task's kwargs are stored -- see
# renew_subscription.defer(subscription_id=...) -- and matches only 'todo'
# jobs, i.e. work that is still pending.
_SUBS_WITHOUT_JOB_SQL = """
SELECT
    COUNT(*) AS active,
    COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM procrastinate_jobs j
        WHERE j.task_name = 'g12f.renew_subscription'
          AND j.status = 'todo'
          AND (j.args ->> 'subscription_id') = s.id::text
    )) AS without_job
FROM {subscription} s
WHERE s.max_price > 0 AND s.expires > %(now)s
"""

_PAGES_SQL = """
SELECT
    COUNT(*) FILTER (WHERE p.publish_at <= %(now)s) AS overdue,
    COUNT(*) FILTER (
        WHERE p.publish_at > %(now)s AND NOT EXISTS (
            SELECT 1 FROM procrastinate_jobs j
            WHERE j.task_name = 'g12f.publish_zpage'
              AND j.status = 'todo'
              AND (j.args ->> 'zpage_id') = p.id::text
        )
    ) AS scheduled_without_job
FROM {zpage} p
WHERE p.is_published = FALSE AND p.publish_at IS NOT NULL
"""


def collect_backstop_evidence(now=None) -> BackstopEvidence:
    from dj.apps.g12f.models import Subscription, zPage

    now = now or timezone.now()

    # These queries JOIN application tables to procrastinate's tables, so
    # they are only meaningful when both live in the same database. That
    # is true here (free2z runs a single Postgres and
    # PROCRASTINATE_DATABASE_ALIAS is unset), but state the assumption
    # rather than silently producing a report that mixes two databases:
    # `subscriptions_without_job` would read as "the whole fleet is
    # unconverted" and send someone chasing a migration that already
    # happened.
    alias = procrastinate_settings.settings.DATABASE_ALIAS
    if alias != 'default':
        raise RuntimeError(
            'backstop evidence needs procrastinate and the app tables in '
            f'one database; PROCRASTINATE_DATABASE_ALIAS is {alias!r}')

    # Table names come from _meta, never hardcoded, so a db_table change
    # is a test failure rather than a silent zero.
    params = {'now': now}
    with connections[alias].cursor() as cur:
        cur.execute(
            _SUBS_WITHOUT_JOB_SQL.format(
                subscription=Subscription._meta.db_table),
            params)
        subs_active, subs_without_job = cur.fetchone()

        cur.execute(
            _PAGES_SQL.format(zpage=zPage._meta.db_table), params)
        pages_overdue, pages_without_job = cur.fetchone()

    return BackstopEvidence(
        pages_overdue_unpublished=pages_overdue,
        pages_scheduled_without_job=pages_without_job,
        subscriptions_active=subs_active,
        subscriptions_without_job=subs_without_job,
    )


def collect_translation_refunds(now=None, window_seconds: int | None = None
                                ) -> dict[str, int]:
    """``{code: count}`` of translations refunded in the window.

    See ``charges.recent_refunds`` for what counts. Reads application tables,
    so it is subject to the same one-database assumption as the backstop
    evidence -- asserted the same way rather than reporting "no refunds"
    from the wrong database.
    """
    from dj.apps.g12f.translation import charges

    alias = procrastinate_settings.settings.DATABASE_ALIAS
    if alias != 'default':
        raise RuntimeError(
            'translation refund counts need procrastinate and the app tables '
            f'in one database; PROCRASTINATE_DATABASE_ALIAS is {alias!r}')
    if window_seconds is None:
        window_seconds = settings.JOB_HEALTH_FAILURE_WINDOW_SECONDS
    return charges.recent_refunds(
        now=now, window=timedelta(seconds=window_seconds))


def collect_queue_health(now=None, window_seconds: int | None = None
                         ) -> list[QueueHealth]:
    now = now or timezone.now()
    if window_seconds is None:
        window_seconds = settings.JOB_HEALTH_FAILURE_WINDOW_SECONDS
    cutoff = now - timedelta(seconds=window_seconds)

    params = {
        'now': now,
        'cutoff': cutoff,
        'orphan_min_age': settings.JOB_RECLAIM_MIN_AGE_SECONDS,
        'budget_margin': settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS,
        'bounded_tasks': _BOUNDED_TASK_NAMES,
        'never_tasks': _NEVER_TASK_NAMES,
        'stuck_doing_seconds': settings.JOB_HEALTH_STUCK_DOING_SECONDS,
        'lease_stale_seconds': settings.JOB_LEASE_STALE_SECONDS,
        'worker_stale_seconds': settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS,
    }
    queues: dict[str, QueueHealth] = {}
    with _connection().cursor() as cur:
        cur.execute(_QUEUE_SQL, params)
        for row in cur.fetchall():
            (queue, todo, doing, failed_total, failed_recent, todo_overdue,
             oldest_overdue, oldest_doing, oldest_over_budget, orphaned, oldest_orphaned,
             past_deadline) = row
            queues[queue] = QueueHealth(
                queue=queue,
                todo=todo,
                doing=doing,
                failed_total=failed_total,
                failed_recent=failed_recent,
                todo_overdue=todo_overdue,
                oldest_overdue_seconds=float(oldest_overdue or 0),
                oldest_doing_seconds=float(oldest_doing or 0),
                oldest_over_budget_seconds=float(oldest_over_budget or 0),
                orphaned=orphaned,
                oldest_orphaned_seconds=float(oldest_orphaned or 0),
                past_deadline=past_deadline,
            )

        cur.execute(_FAILED_TASKS_SQL, params)
        for queue, task_name, n in cur.fetchall():
            if queue in queues:
                queues[queue].failed_tasks[task_name] = n

        translation = queues.get(TRANSLATION_QUEUE)
        if translation is not None and translation.todo_overdue > 0:
            cur.execute(_TRANSLATION_STARTED_RECENTLY_SQL, {
                'queue': TRANSLATION_QUEUE,
                'cutoff': now - timedelta(
                    seconds=settings.JOB_HEALTH_TRANSLATION_NO_START_SECONDS),
            })
            translation.translation_started_recently = bool(cur.fetchone()[0])

    # A queue with zero rows in procrastinate_jobs does not appear in the
    # GROUP BY, but its thresholds still need to be reported so a
    # dashboard/alert filter can see "billing: 0 failures" rather than
    # nothing at all. (Silence is indistinguishable from a dead sweep.)
    for queue in (
        *settings.JOB_HEALTH_BILLING_QUEUES,
        *settings.JOB_HEALTH_CRITICAL_QUEUES,
        TRANSLATION_QUEUE,
    ):
        queues.setdefault(queue, QueueHealth(queue=queue))

    # Refunds are not jobs, so the SQL above cannot see them.
    queues[TRANSLATION_QUEUE].refunded_codes = collect_translation_refunds(
        now=now, window_seconds=window_seconds)

    return [queues[k] for k in sorted(queues)]


def collect(now=None, window_seconds: int | None = None) -> HealthReport:
    now = now or timezone.now()
    if window_seconds is None:
        window_seconds = settings.JOB_HEALTH_FAILURE_WINDOW_SECONDS
    return HealthReport(
        queues=collect_queue_health(now=now, window_seconds=window_seconds),
        backstops=collect_backstop_evidence(now=now),
        window_seconds=window_seconds,
    )
