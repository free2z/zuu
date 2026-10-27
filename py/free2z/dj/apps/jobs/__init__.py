"""
Operational visibility for the Procrastinate job queue.

The queue is a money path (the `billing` queue renews subscriptions),
and before this app a job that exhausted its retries just sat in
`procrastinate_jobs` with `status='failed'` and told nobody.

Contents:

- ``health.py``  — pure, testable queries over ``procrastinate_jobs`` /
  ``procrastinate_events`` producing a:class:`~dj.apps.jobs.health.HealthReport`.
- ``tasks.py``   — a periodic Procrastinate task that runs that report and
  logs it as structured JSON (Cloud Logging alerting hooks onto those
  lines; see ``monitoring/``).
- ``management/commands/job_health.py`` — the same report on demand, for
  a human at a shell.

Django admin visibility already exists: ``procrastinate.contrib.django``
ships ``admin.py`` registering ``ProcrastinateJob`` (list/filter by
status, queue and task, with per-job event inlines and retry/cancel/abort
actions). It is picked up by admin autodiscovery because the app is in
INSTALLED_APPS — nothing to add here. See ``/admin/procrastinate/``.

CONVENTION — a new task ships one release before anything enqueues it
. ``bin/bazel-apply.sh`` rolls every worker lane before
the web tier, but one worker lane can still roll before ANOTHER worker
lane, and a job for a task only the just-rolled lane knows fails outright
on the lane that hasn't rolled yet (``Worker._process_job`` has no
``Task`` object to retry from). Register the task (with its
``reclaim_policy.TASK_POLICIES`` entry) in one PR; defer it for the first
time in a later one. See the root ``CLAUDE.md`` for the full reasoning
and why the fix is this convention plus
``task_not_found_alert.py`` rather than a runtime retry.
"""
