"""
Procrastinate job-observability tests, against real Postgres.

No queue mocking and no DB mocking: jobs are deferred through the real
`.defer()` path so the rows, the JSONB `args`, and the status-event
triggers are the genuine ones, and a terminal failure is simulated the
only way it happens in production — by the job row reaching
`status='failed'` with a `failed` event.

The load-bearing assertions:

- a single terminal failure on the `billing` queue alerts (money path);
- a single terminal failure on `search` does NOT page (alert fatigue), but
  DOES get the low-urgency 'jobs_failed_any' signal  -- below the
  bursting threshold is not the same as invisible;
- a renewal job legitimately scheduled 30 days out is NOT backlog
  (the units trap: `todo` != `late`);
- the emitted log lines are one-line JSON with the alert name in them,
  which is the entire contract with monitoring/alert-policies/.
"""
import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.core.management import call_command
from django.db import connection
from django.utils import timezone

from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.exports.tasks import export_publication_task
from dj.apps.g12f.models import Subscription
from dj.apps.g12f.tasks import publish_zpage, renew_subscription
from dj.apps.g12f.translation.tasks import translate_zpage
from dj.apps.dyte.tasks import retry_recording_delivery
from dj.apps.jobs import health
from dj.apps.jobs.models import JobLease, QuarantinedJob
from dj.apps.jobs.tasks import report_job_health
from dj.apps.search.tasks import index_multilingual_zpage, index_zpage


def test_exports_queue_uses_its_serial_worker_capacity_window(settings):
    settings.JOB_HEALTH_OVERDUE_SECONDS = 900
    settings.JOB_HEALTH_EXPORTS_OVERDUE_SECONDS = 7200

    assert health.QueueHealth(queue="default").overdue_threshold_seconds == 900
    assert health.QueueHealth(queue="exports").overdue_threshold_seconds == 7200


# ---------------------------------------------------------------------------
# helpers -- raw SQL, because procrastinate's Django models are read-only
# by design (PROCRASTINATE_READONLY_MODELS defaults True). These write the
# same columns the worker writes.
# ---------------------------------------------------------------------------

def _mark_failed(job_id, failed_at=None, attempts=3):
    """
    Drive a job through the real production transition
    todo -> doing -> failed, and let procrastinate's own
    `procrastinate_trigger_status_events_update_v1` write the events. The
    health SQL keys off the event type names `deferred` / `started` /
    `failed`; hand-inserting them here would make the test agree with the
    query while both disagreed with production.
    """
    failed_at = failed_at or timezone.now()
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET status='doing' WHERE id=%s",
            [job_id])
        cur.execute(
            "UPDATE procrastinate_jobs SET status='failed', attempts=%s "
            "WHERE id=%s", [attempts, job_id])
        # The trigger really did emit a 'failed' event -- assert it, then
        # backdate it to place the failure inside/outside the window.
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='failed'", [failed_at, job_id])
        assert cur.rowcount == 1, (
            "procrastinate did not emit a 'failed' event on the "
            "doing->failed transition; the health SQL's event names are "
            "out of date")


def _mark_doing(job_id, started_at):
    # The status UPDATE fires procrastinate's own status trigger, which
    # inserts the 'started' event for us -- backdate that rather than
    # adding a second one, so the row shape matches production exactly.
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET status='doing' WHERE id=%s",
            [job_id])
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='started'", [started_at, job_id])


def _worker(last_heartbeat):
    with connection.cursor() as cur:
        cur.execute(
            "INSERT INTO procrastinate_workers (last_heartbeat) "
            "VALUES (%s) RETURNING id", [last_heartbeat])
        return cur.fetchone()[0]


def _backdate_deferred(job_id, at):
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='deferred'", [at, job_id])


def _q(report, name):
    for q in report.queues:
        if q.queue == name:
            return q
    raise AssertionError(f"queue {name!r} not in report: "
                         f"{[q.queue for q in report.queues]}")


# ---------------------------------------------------------------------------
# terminal failure detection
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_deferring_a_job_records_a_deferred_event():
    """Guards the assumption the age query rests on."""
    job_id = index_zpage.defer(zpage_id=1)
    with connection.cursor() as cur:
        cur.execute(
            "SELECT type FROM procrastinate_events WHERE job_id=%s", [job_id])
        assert ('deferred',) in cur.fetchall()


@pytest.mark.django_db
def test_single_failed_billing_job_alerts():
    job_id = renew_subscription.defer(subscription_id=1)
    _mark_failed(job_id)

    report = health.collect()
    billing = _q(report, 'billing')

    assert billing.failed_recent == 1
    assert billing.failed_threshold == 1
    assert billing.failed_tasks == {'g12f.renew_subscription': 1}
    assert 'billing_jobs_failed' in billing.alerts()
    assert 'billing_jobs_failed' in report.alerts()
    #'jobs_failed_any' is the low-urgency signal for a queue whose
    # bursting threshold has NOT been crossed. billing already pages on the
    # first failure, so it must never also carry the ticket-tier name.
    assert 'jobs_failed_any' not in billing.alerts()


@pytest.mark.django_db
def test_single_failed_translation_job_does_not_get_the_ticket_tier_signal():
    """translation is a JOB_HEALTH_BILLING_QUEUES entry (threshold 1), so a
    terminal failure there already pages as 'billing_jobs_failed' -- same as
    any other billing queue. 's new 'jobs_failed_any' signal must not
    ALSO fire for it: translation's own refund-shaped failures are being
    made observable by a separate metric, and this queue must not
    get double coverage from two unrelated PRs.
    """
    job_id = index_zpage.configure(queue='translation').defer(zpage_id=1)
    _mark_failed(job_id)

    report = health.collect()
    translation = _q(report, 'translation')

    assert translation.is_billing is True
    assert translation.failed_threshold == 1
    assert translation.alerts() == ['billing_jobs_failed']


@pytest.mark.django_db
def test_single_failed_search_job_does_not_page():
    """One bad page must not PAGE anyone -- that is still alert fatigue.

    It DOES now get a low-urgency 'jobs_failed_any' signal: 4
    below-threshold terminal failures in 30 days went unreviewed, so a
    single ordinary-queue failure is surfaced at ticket tier instead of
    being invisible until a fifth one arrives in the same hour.
    """
    _mark_failed(index_zpage.defer(zpage_id=1))

    report = health.collect()
    search = _q(report, 'search')

    assert search.failed_recent == 1
    assert search.failed_threshold == 5
    assert search.alerts() == ['jobs_failed_any']


@pytest.mark.django_db
def test_single_failed_multilingual_index_alerts():
    _mark_failed(index_multilingual_zpage.defer(zpage_id=1))

    report = health.collect()
    search = _q(report, 'search-multilingual')

    assert search.is_critical is True
    assert search.failed_threshold == 1
    assert search.failed_tasks == {'search.index_multilingual_zpage': 1}
    assert search.alerts() == ['jobs_failed']
    assert 'jobs_failed_any' not in search.alerts()


@pytest.mark.django_db
def test_five_failed_search_jobs_alert():
    for i in range(5):
        _mark_failed(index_zpage.defer(zpage_id=i))

    report = health.collect()
    search = _q(report, 'search')

    assert search.failed_recent == 5
    assert 'jobs_failed' in search.alerts()
    # It is NOT reported as a billing failure -- the two alert names must
    # stay distinct or the stricter policy would fire on image churn.
    assert 'billing_jobs_failed' not in search.alerts()
    # Crossing the bursting threshold gets exactly ONE alert name -- not
    # 'jobs_failed' AND the below-threshold 'jobs_failed_any' racing to the
    # same channel for the same incident.
    assert search.alerts() == ['jobs_failed']


@pytest.mark.django_db
def test_two_to_four_failed_search_jobs_get_the_ticket_tier_signal_only():
    """The exact gap  named: below 5/hour, nothing surfaced a failure
    at all. 2, 3 or 4 failures on an ordinary queue must get
    'jobs_failed_any' and must NOT cross into the paging 'jobs_failed'
    threshold."""
    for i in range(3):
        _mark_failed(index_zpage.defer(zpage_id=i))

    report = health.collect()
    search = _q(report, 'search')

    assert search.failed_recent == 3
    assert search.alerts() == ['jobs_failed_any']


@pytest.mark.django_db
def test_failure_older_than_the_window_does_not_alert():
    """The window is what stops a fixed incident paging forever."""
    old = timezone.now() - timedelta(seconds=3600 + 600)
    _mark_failed(renew_subscription.defer(subscription_id=1), failed_at=old)

    report = health.collect()
    billing = _q(report, 'billing')

    assert billing.failed_total == 1   # still visible in admin / totals
    assert billing.failed_recent == 0  # but no longer paging
    assert billing.alerts() == []


@pytest.mark.django_db
def test_billing_queue_is_reported_even_with_no_jobs():
    """Silence must be distinguishable from a dead sweep."""
    report = health.collect()
    billing = _q(report, 'billing')
    assert billing.failed_recent == 0
    assert billing.alerts() == []


# ---------------------------------------------------------------------------
# backlog / age -- the units trap
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_future_scheduled_renewal_is_not_backlog():
    """
    THE regression this suite exists for. renew_subscription is deferred
    with schedule_at = expires - 24h, routinely ~30 days out. Counting a
    correctly-scheduled job as "overdue" would page permanently and train
    everyone to ignore the billing alert.
    """
    renew_subscription.configure(
        schedule_at=timezone.now() + timedelta(days=30),
    ).defer(subscription_id=1)

    report = health.collect()
    billing = _q(report, 'billing')

    assert billing.todo == 1
    assert billing.todo_overdue == 0
    assert billing.oldest_overdue_seconds == 0
    assert billing.alerts() == []


@pytest.mark.django_db
def test_past_scheduled_renewal_over_threshold_is_backlog():
    late_by = health.settings.JOB_HEALTH_BILLING_OVERDUE_SECONDS + 60
    renew_subscription.configure(
        schedule_at=timezone.now() - timedelta(seconds=late_by),
    ).defer(subscription_id=1)

    report = health.collect()
    billing = _q(report, 'billing')

    assert billing.todo_overdue == 1
    assert billing.oldest_overdue_seconds == pytest.approx(late_by, abs=30)
    assert 'queue_backlog' in billing.alerts()


@pytest.mark.django_db
def test_billing_backlog_threshold_is_stricter_than_the_default():
    """
    A job 6 minutes late alerts on billing (300s) and does not on the
    default queue (900s). Same lateness, different verdict -- that is the
    whole point of a per-queue threshold.
    """
    late = timezone.now() - timedelta(seconds=360)
    renew_subscription.configure(schedule_at=late).defer(subscription_id=1)
    publish_zpage.configure(schedule_at=late).defer(zpage_id=1)

    report = health.collect()

    assert 'queue_backlog' in _q(report, 'billing').alerts()
    assert _q(report, 'default').todo_overdue == 1
    assert 'queue_backlog' not in _q(report, 'default').alerts()


@pytest.mark.django_db
def test_unscheduled_job_ages_from_its_deferred_event():
    """A job deferred for immediate execution has scheduled_at NULL."""
    job_id = index_zpage.defer(zpage_id=1)
    assert ProcrastinateJob.objects.get(pk=job_id).scheduled_at is None
    _backdate_deferred(job_id, timezone.now() - timedelta(seconds=1200))

    search = _q(health.collect(), 'search')
    assert search.todo_overdue == 1
    assert search.oldest_overdue_seconds == pytest.approx(1200, abs=30)
    assert 'queue_backlog' in search.alerts()


@pytest.mark.django_db
def test_job_stuck_in_doing_alerts():
    now = timezone.now()
    job_id = index_zpage.defer(zpage_id=1)
    worker_id = _worker(now - timedelta(seconds=800))
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    started = now - timedelta(seconds=4500)
    _mark_doing(job_id, started)
    JobLease.objects.create(
        job_id=job_id, token=uuid.uuid4(), task_name='search.index_zpage',
        queue='search', started_at=started,
        last_beat_at=now - timedelta(seconds=800),
        deadline_at=None, attempt=0)

    search = _q(health.collect(), 'search')
    assert search.doing == 1
    assert 'job_stuck' in search.alerts()


@pytest.mark.django_db
def test_healthy_long_running_job_is_not_stuck_with_a_fresh_lease():
    now = timezone.now()
    job_id = index_zpage.defer(zpage_id=919)
    policy = health.reclaim_policy.policy_for('search.index_zpage')
    assert policy is not None and policy.max_runtime_seconds is not None
    alert_budget = (
        policy.max_runtime_seconds
        + health.settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS
    )
    started = now - timedelta(seconds=alert_budget - 1)
    worker_id = _worker(now)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    _mark_doing(job_id, started)
    JobLease.objects.create(
        job_id=job_id, token=uuid.uuid4(), task_name='search.index_zpage',
        queue='search', started_at=started,
        last_beat_at=now, deadline_at=now + timedelta(seconds=60), attempt=0)

    search = _q(health.collect(now=now), 'search')
    payload = search.as_payload(
        health.settings.JOB_HEALTH_FAILURE_WINDOW_SECONDS)

    # This is a real fresh worker + lease, still inside the configured
    # search runtime budget and its margin. A fresh lease alone does not
    # suppress the independent over-budget alert (covered below).
    assert search.oldest_doing_seconds >= alert_budget - 1
    assert search.oldest_over_budget_seconds == 0
    assert search.orphaned == 0
    assert search.oldest_orphaned_seconds == 0
    assert search.past_deadline == 0
    assert 'job_stuck' not in search.alerts()
    assert payload['oldest_doing_seconds'] >= alert_budget - 1


@pytest.mark.django_db
def test_live_job_past_its_task_budget_remains_visible_to_health():
    now = timezone.now()
    job_id = index_zpage.defer(zpage_id=921)
    worker_id = _worker(now)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    started = now - timedelta(seconds=4200)
    _mark_doing(job_id, started)
    JobLease.objects.create(
        job_id=job_id, token=uuid.uuid4(), task_name='search.index_zpage',
        queue='search', started_at=started, last_beat_at=now,
        deadline_at=None, attempt=0)

    search = _q(health.collect(now=now), 'search')

    assert search.oldest_orphaned_seconds == 0
    assert search.oldest_over_budget_seconds >= 300
    assert 'job_stuck' in search.alerts()


@pytest.mark.django_db
def test_bounded_orphan_gets_recovery_window_before_over_budget_email():
    """An orphan is paged by the 600s recovery clock, not its reclaim cutoff."""
    now = timezone.now()
    job_id = index_zpage.defer(zpage_id=9221)
    policy = health.reclaim_policy.policy_for('search.index_zpage')
    assert policy is not None and policy.max_runtime_seconds is not None
    budget = (policy.max_runtime_seconds
              + health.settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS)
    started = now - timedelta(seconds=budget + 30)
    worker_id = _worker(now - timedelta(seconds=181))
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    _mark_doing(job_id, started)
    JobLease.objects.create(
        job_id=job_id, token=uuid.uuid4(), task_name='search.index_zpage',
        queue='search', started_at=started,
        last_beat_at=now - timedelta(seconds=181),
        deadline_at=None, attempt=0)

    search = _q(health.collect(now=now), 'search')

    assert search.orphaned == 1
    assert 0 < search.oldest_orphaned_seconds < (
        health.settings.JOB_HEALTH_STUCK_ORPHANED_SECONDS)
    assert search.oldest_over_budget_seconds == 0
    assert 'job_stuck' not in search.alerts()


@pytest.mark.django_db
def test_ordinary_stale_lease_on_healthy_worker_is_not_orphaned():
    """A stale beater alone is not a recovery opportunity for a live worker."""
    now = timezone.now()
    job_id = index_zpage.defer(zpage_id=922)
    worker_id = _worker(now)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    started = now - timedelta(seconds=4500)
    _mark_doing(job_id, started)
    JobLease.objects.create(
        job_id=job_id, token=uuid.uuid4(), task_name='search.index_zpage',
        queue='search', started_at=started,
        last_beat_at=now - timedelta(seconds=4000),
        deadline_at=None, attempt=0)

    search = _q(health.collect(now=now), 'search')

    assert search.orphaned == 0
    assert search.oldest_orphaned_seconds == 0
    assert 'job_stuck' in search.alerts()


@pytest.mark.django_db
def test_matching_abandonment_marker_makes_live_worker_orphan_actionable():
    now = timezone.now()
    job_id = index_zpage.defer(zpage_id=923)
    worker_id = _worker(now)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    started = now - timedelta(seconds=4500)
    _mark_doing(job_id, started)
    token = uuid.uuid4()
    JobLease.objects.create(
        job_id=job_id, token=token, task_name='search.index_zpage',
        queue='search', started_at=started,
        last_beat_at=now - timedelta(seconds=4000),
        deadline_at=None, attempt=0)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name='search.index_zpage', queue='search',
        reason=f'recovery abandoned attempt after_body:{token}',
        attempts=0, requeued_at=None)

    search = _q(health.collect(now=now), 'search')

    assert search.orphaned == 1
    assert search.oldest_orphaned_seconds >= 600


@pytest.mark.django_db
def test_health_reports_orphan_age_and_expired_deadline():
    now = timezone.now()
    # A NEVER task keeps orphan eligibility age independent of its
    # alert-only runtime. Using a bounded task that had already run for
    # 3900s also asserts a positive over-budget alert, regardless of its
    # one-second orphan age, so it cannot test the orphan-age threshold.
    job_id = retry_recording_delivery.defer(delivery_id='expired-lease-age')
    started = now - timedelta(
        seconds=health.settings.JOB_RECLAIM_MIN_AGE_SECONDS + 1)
    worker_id = _worker(now - timedelta(seconds=61))
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    _mark_doing(job_id, started)
    JobLease.objects.create(
        job_id=job_id, token=uuid.uuid4(),
        task_name='dyte.retry_recording_delivery',
        queue='recordings', started_at=started,
        last_beat_at=now - timedelta(seconds=181),
        deadline_at=now - timedelta(seconds=1), attempt=0)

    recordings = _q(health.collect(now=now), 'recordings')
    payload = recordings.as_payload(
        health.settings.JOB_HEALTH_FAILURE_WINDOW_SECONDS)

    assert recordings.orphaned == 1
    assert 0 <= recordings.oldest_orphaned_seconds < 10
    assert recordings.past_deadline == 1
    assert payload['orphaned'] == 1
    assert recordings.oldest_over_budget_seconds == 0
    assert 'job_stuck' not in recordings.alerts()

    stale = now - timedelta(seconds=800)
    JobLease.objects.filter(job_id=job_id).update(last_beat_at=stale)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_workers SET last_heartbeat=%s WHERE id=%s",
            [stale, worker_id])
    recordings = _q(
        health.collect(now=now + timedelta(seconds=602)), 'recordings')
    assert recordings.oldest_orphaned_seconds >= 600
    assert 'job_stuck' in recordings.alerts()


@pytest.mark.django_db
def test_orphaned_never_reclaim_task_remains_visible_to_health():
    """Recovery policy must not hide work that needs manual intervention."""
    now = timezone.now()
    job_id = retry_recording_delivery.defer(delivery_id='stuck-recording')
    worker_id = _worker(now - timedelta(seconds=800))
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    _mark_doing(job_id, now - timedelta(seconds=1200))

    recordings = _q(health.collect(now=now), 'recordings')

    assert recordings.orphaned == 1
    assert recordings.oldest_orphaned_seconds >= 600
    assert 'job_stuck' in recordings.alerts()


@pytest.mark.django_db
def test_healthy_never_task_without_lease_is_not_orphaned():
    """Alert-only age does not make a healthy NEVER task reclaimable."""
    now = timezone.now()
    job_id = retry_recording_delivery.defer(delivery_id='live-recording')
    worker_id = _worker(now)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    _mark_doing(job_id, now - timedelta(seconds=4200))

    recordings = _q(health.collect(now=now), 'recordings')

    assert recordings.orphaned == 0
    assert recordings.oldest_orphaned_seconds == 0
    assert recordings.oldest_over_budget_seconds >= 300
    assert 'job_stuck' in recordings.alerts()


@pytest.mark.django_db
def test_never_task_can_use_a_longer_alert_only_budget():
    """Publication alert budget stays independent from reclaim policy."""
    now = timezone.now()
    job_id = export_publication_task.defer(job_id='health-export-threshold')
    worker_id = _worker(now)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET worker_id=%s WHERE id=%s",
            [worker_id, job_id])
    _mark_doing(job_id, now - timedelta(seconds=3600))

    exports = _q(health.collect(now=now), 'exports')
    assert exports.orphaned == 0
    assert exports.oldest_over_budget_seconds == 0
    assert 'job_stuck' not in exports.alerts()

    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='started'",
            [now - timedelta(seconds=7500), job_id])
    exports = _q(health.collect(now=now), 'exports')
    assert exports.orphaned == 0
    assert exports.oldest_over_budget_seconds >= 300
    assert 'job_stuck' in exports.alerts()


@pytest.mark.django_db
def test_job_recently_started_does_not_alert():
    _mark_doing(index_zpage.defer(zpage_id=1),
                timezone.now() - timedelta(seconds=30))
    assert _q(health.collect(), 'search').alerts() == []


def _mark_translation_started_then_retry(job_id, started_at):
    """Keep the job in `todo` while preserving a real `started` event."""
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET status='doing' WHERE id=%s",
            [job_id])
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='started'", [started_at, job_id])
        assert cur.rowcount == 1
        cur.execute(
            "UPDATE procrastinate_jobs SET status='todo' WHERE id=%s",
            [job_id])


def _mark_translation_succeeded(job_id, started_at):
    """Create a recent started event on a terminal successful translation."""
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET status='doing' WHERE id=%s",
            [job_id])
        cur.execute(
            "UPDATE procrastinate_events SET at=%s "
            "WHERE job_id=%s AND type='started'", [started_at, job_id])
        assert cur.rowcount == 1
        cur.execute(
            "UPDATE procrastinate_jobs SET status='succeeded' WHERE id=%s",
            [job_id])


@pytest.mark.django_db
def test_translation_backlog_alerts_after_twenty_minutes_without_a_start(caplog):
    caplog.set_level('INFO', logger='dj.apps.jobs.tasks')
    job_id = translate_zpage.defer(job_id='unprocessed-charge')
    _backdate_deferred(
        job_id, timezone.now() - timedelta(seconds=1200))

    summary = report_job_health()

    translation = _q(health.collect(), 'translation')
    assert translation.todo == 1
    assert translation.todo_overdue == 1
    assert translation.oldest_overdue_seconds >= 1200
    assert translation.translation_started_recently is False
    payload = translation.as_payload(3600)
    assert payload['translation_started_recently'] is False
    assert payload['translation_no_start_threshold_seconds'] == 1200
    assert 'translation_lane_stalled' in translation.alerts()
    assert 'translation_lane_stalled' in summary['alerts']
    assert any(
        payload.get('alert') == 'translation_lane_stalled'
        and payload.get('queue') == 'translation'
        for payload in _json_lines(caplog))


@pytest.mark.django_db
def test_fresh_translation_job_after_long_idle_does_not_alert():
    # The old successful job establishes that the lane has been quiet longer
    # than the alert window; fresh demand must still receive its grace period.
    old_job = translate_zpage.defer(job_id='old-success-before-fresh-demand')
    _mark_translation_succeeded(
        old_job, timezone.now() - timedelta(minutes=30))
    translate_zpage.defer(job_id='fresh-after-idle')

    translation = _q(health.collect(), 'translation')

    assert translation.todo == 1
    assert translation.todo_overdue == 1
    assert translation.oldest_overdue_seconds < 1200
    assert translation.translation_started_recently is False
    assert 'translation_lane_stalled' not in translation.alerts()


@pytest.mark.django_db
def test_future_scheduled_translation_retry_does_not_alert():
    retry_id = translate_zpage.configure(
        schedule_at=timezone.now() + timedelta(minutes=10),
    ).defer(job_id='future-translation-retry')
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE procrastinate_jobs SET attempts=1 WHERE id=%s",
            [retry_id])

    translation = _q(health.collect(), 'translation')

    assert translation.todo == 1
    assert translation.todo_overdue == 0
    assert translation.translation_started_recently is None
    assert 'translation_lane_stalled' not in translation.alerts()


@pytest.mark.django_db
def test_recent_translation_start_suppresses_lane_stalled_alert():
    job_id = translate_zpage.defer(job_id='recently-started-charge')
    _mark_translation_started_then_retry(
        job_id, timezone.now() - timedelta(minutes=19))

    translation = _q(health.collect(), 'translation')

    assert translation.todo == 1
    assert translation.translation_started_recently is True
    assert 'translation_lane_stalled' not in translation.alerts()


@pytest.mark.django_db
def test_recent_start_from_succeeded_translation_suppresses_stall_alert():
    succeeded = translate_zpage.defer(job_id='recently-succeeded-charge')
    _mark_translation_succeeded(
        succeeded, timezone.now() - timedelta(minutes=19))
    assert ProcrastinateJob.objects.get(pk=succeeded).status == 'succeeded'
    overdue = translate_zpage.defer(job_id='still-overdue-charge')
    _backdate_deferred(overdue, timezone.now() - timedelta(minutes=21))

    translation = _q(health.collect(), 'translation')

    assert translation.todo == 1
    assert translation.todo_overdue == 1
    assert translation.oldest_overdue_seconds >= 1200
    assert translation.translation_started_recently is True
    assert 'translation_lane_stalled' not in translation.alerts()


# ---------------------------------------------------------------------------
# the log contract with monitoring/alert-policies/
# ---------------------------------------------------------------------------

def _json_lines(caplog):
    out = []
    for rec in caplog.records:
        try:
            out.append(json.loads(rec.getMessage()))
        except ValueError:
            continue
    return out


@pytest.mark.django_db
def test_sweep_emits_one_line_json_with_the_alert_name(caplog):
    caplog.set_level('INFO', logger='dj.apps.jobs.tasks')
    _mark_failed(renew_subscription.defer(subscription_id=1))

    summary = report_job_health()

    payloads = _json_lines(caplog)
    alerting = [p for p in payloads
                if p.get('alert') == 'billing_jobs_failed']
    assert len(alerting) == 1
    p = alerting[0]
    # Exactly the fields monitoring/alert-policies/ filters on.
    assert p['severity'] == 'ERROR'
    assert p['event'] == 'procrastinate_job_health'
    assert p['queue'] == 'billing'
    assert p['failed_recent'] == 1
    assert p['message']

    #...and the heartbeat line the metric-absence policy counts.
    sweeps = [x for x in payloads
              if x.get('event') == 'procrastinate_job_health_sweep']
    assert len(sweeps) == 1
    assert sweeps[0]['failed_recent_total'] == 1
    assert summary['alerts'] == ['billing_jobs_failed']

    # Every emitted line must be a single line of JSON, or GKE's logging
    # agent will not turn it into a jsonPayload.
    for rec in caplog.records:
        if rec.name == 'dj.apps.jobs.tasks':
            assert '\n' not in rec.getMessage()


@pytest.mark.django_db
def test_healthy_sweep_emits_no_error_lines(caplog):
    caplog.set_level('INFO', logger='dj.apps.jobs.tasks')
    index_zpage.defer(zpage_id=1)

    summary = report_job_health()

    assert summary['alerts'] == []
    assert not [r for r in caplog.records
                if r.name == 'dj.apps.jobs.tasks' and r.levelname == 'ERROR']
    # The heartbeat still fires -- that is what proves the worker is alive.
    assert any(p.get('event') == 'procrastinate_job_health_sweep'
               for p in _json_lines(caplog))


@pytest.mark.django_db
def test_management_command_json_output(capsys):
    _mark_failed(renew_subscription.defer(subscription_id=1))
    # --json still exits non-zero when alerting; the payload is written
    # before the exit.
    with pytest.raises(SystemExit):
        call_command('job_health', '--json')
    data = json.loads(capsys.readouterr().out)
    billing = [q for q in data['queues'] if q['queue'] == 'billing'][0]
    assert billing['alerts'] == ['billing_jobs_failed']
    assert billing['failure_window_seconds'] == 3600


@pytest.mark.django_db
def test_management_command_exits_nonzero_when_alerting():
    _mark_failed(renew_subscription.defer(subscription_id=1))
    with pytest.raises(SystemExit) as exc:
        call_command('job_health')
    assert exc.value.code == 1


@pytest.mark.django_db
def test_management_command_exits_zero_when_healthy():
    call_command('job_health')  # no SystemExit


# ---------------------------------------------------------------------------
# retry policy: exhaustion must be reachable
# ---------------------------------------------------------------------------

def test_retry_strategies_are_bounded():
    """
    An unbounded retry strategy would mean a broken job never reaches
    status='failed' and therefore NEVER alerts -- the silent failure this
    whole issue is about. Every task's strategy must have a maximum.
    """
    from dj.apps.g12f.tasks import PUBLISH_RETRY, RENEWAL_RETRY_STRATEGY
    from dj.apps.search.tasks import INDEX_RETRY
    from dj.apps.uploads.tasks import VARIANT_RETRY

    for strategy in (PUBLISH_RETRY, RENEWAL_RETRY_STRATEGY,
                     INDEX_RETRY, VARIANT_RETRY):
        assert strategy.max_attempts
        assert strategy.max_attempts <= 8


def test_retry_strategy_stops_retrying_at_max_attempts():
    from procrastinate.jobs import Job

    from dj.apps.g12f.tasks import RENEWAL_RETRY_STRATEGY

    def decision(attempts):
        job = Job(
            id=1, queue='billing', task_name='g12f.renew_subscription',
            task_kwargs={}, lock=None, queueing_lock=None,
            attempts=attempts,
        )
        return RENEWAL_RETRY_STRATEGY.get_retry_decision(
            exception=RuntimeError('boom'), job=job)

    assert decision(1) is not None    # first failure -> retry
    assert decision(2) is not None
    assert decision(3) is None        # exhausted -> status becomes 'failed'


# ---------------------------------------------------------------------------
#  evidence: what the cron backstops would still find to do
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_backstop_evidence_counts_subscriptions_without_a_pending_job(
        creator_factory):
    fan, star = creator_factory(), creator_factory()
    Subscription.objects.create(
        fan=fan, star=star,
        expires=timezone.now() + timedelta(days=30),
        max_price=star.member_price or Decimal('10'),
    )
    # The post_save signal schedules the chain job on commit, so an
    # actively-managed sub is already converted.
    evidence = health.collect_backstop_evidence()
    assert evidence.subscriptions_active == 1
    assert evidence.subscriptions_without_job == 0

    # A sub whose chain job is gone (pre- sub, or a lost job) is
    # exactly what the renew-subs backstop still exists for.
    with connection.cursor() as cur:
        # Raw SQL: procrastinate's Django models are read-only.
        cur.execute("DELETE FROM procrastinate_events WHERE job_id IN "
                    "(SELECT id FROM procrastinate_jobs WHERE "
                    "task_name='g12f.renew_subscription')")
        cur.execute("DELETE FROM procrastinate_jobs WHERE "
                    "task_name='g12f.renew_subscription'")
    evidence = health.collect_backstop_evidence()
    assert evidence.subscriptions_active == 1
    assert evidence.subscriptions_without_job == 1


@pytest.mark.django_db
def test_backstop_evidence_counts_overdue_unpublished_pages(creator_factory):
    from dj.apps.g12f.models import zPage

    creator = creator_factory()
    zPage.objects.create(
        creator=creator, title='late', content='body',
        is_published=False, publish_at=timezone.now() - timedelta(hours=2),
    )
    evidence = health.collect_backstop_evidence()
    assert evidence.pages_overdue_unpublished == 1


@pytest.mark.django_db
def test_backstop_evidence_is_reported_but_never_alerts(caplog):
    """
     evidence is a decision input, not a page: a backstop finding
    work to do is expected during the migration window.
    """
    caplog.set_level('INFO', logger='dj.apps.jobs.tasks')
    summary = report_job_health()
    assert 'backstops' in summary
    assert summary['alerts'] == []


# ---------------------------------------------------------------------------
# adversarial-review regressions (see the PR body's codex section)
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_retrying_job_is_aged_from_its_retry_time_not_its_first_defer():
    """
    A job waiting out its retry backoff is NOT backlog. Procrastinate's
    retry_job sets `scheduled_at = retry_at`, and the age query prefers
    `scheduled_at` over the original `deferred` event -- so a job first
    enqueued hours ago but retrying in 60s reads as not-yet-due.
    """
    job_id = index_zpage.defer(zpage_id=1)
    _backdate_deferred(job_id, timezone.now() - timedelta(hours=6))
    with connection.cursor() as cur:
        # What procrastinate_retry_job_v2 does: back to todo, with
        # scheduled_at pushed out to the retry moment.
        cur.execute(
            "UPDATE procrastinate_jobs SET status='todo', attempts=1, "
            "scheduled_at=%s WHERE id=%s",
            [timezone.now() + timedelta(seconds=60), job_id])

    search = _q(health.collect(), 'search')
    assert search.todo == 1
    assert search.todo_overdue == 0
    assert search.alerts() == []


@pytest.mark.django_db
def test_backstop_evidence_uses_the_real_table_names(creator_factory):
    """
    The backstop counts are raw SQL with table names interpolated from
    Model._meta.db_table. A renamed table must fail loudly here rather
    than silently reporting zero unconverted subscriptions forever.
    """
    from dj.apps.g12f.models import Subscription as Sub
    from dj.apps.g12f.models import zPage

    assert Sub._meta.db_table in health._SUBS_WITHOUT_JOB_SQL.format(
        subscription=Sub._meta.db_table)
    assert zPage._meta.db_table in health._PAGES_SQL.format(
        zpage=zPage._meta.db_table)

    fan, star = creator_factory(), creator_factory()
    Sub.objects.create(
        fan=fan, star=star, expires=timezone.now() + timedelta(days=30),
        max_price=Decimal('10'),
    )
    # Runs the real SQL against the real tables.
    assert health.collect_backstop_evidence().subscriptions_active == 1
