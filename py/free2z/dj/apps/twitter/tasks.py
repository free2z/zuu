"""Procrastinate tasks for @F2ZP2P announcements.

Both run on the dedicated ``social`` queue, so an X outage, a slow image
model or a credit exhaustion can only ever delay other ``social`` work.

PRIORITY: both are deferred BELOW every other job (-10; the default is 0).
They share the catch-all worker's single slot with scheduled publishing,
publication notifications and the job-health/reclaim sweeps, and
Procrastinate always fetches the highest-priority runnable job first, so a
queued announcement never starts ahead of that work; at most ONE in-flight
announcement (every provider call under a TOTAL deadline, deadline.py; ~255s
worst case) can delay
it. A dedicated `social` Deployment is a manifest-only follow-up.

``retry=False`` on both, deliberately: the retry ladder lives in the
``Announcement`` ROW (``attempts`` / ``next_attempt_at``), which survives a
worker restart and knows which failures may be retried at all -- a
Procrastinate retry of an ambiguous X create would be exactly the blind
duplicate  forbids. Same reasoning as ``jobs.publish_outbox``.
"""
from django.conf import settings

from procrastinate.contrib.django import app

from dj.apps.twitter import announcements


@app.task(
    name=announcements.TASK_NAME, queue=announcements.QUEUE, retry=False,
    priority=announcements.PRIORITY,
)
def announce_task(announcement_id: int):
    return announcements.run_announcement(announcement_id)


@app.periodic(cron=settings.F2ZP2P_SWEEP_CRON)
@app.task(
    name=announcements.SWEEP_TASK_NAME, queue=announcements.QUEUE,
    retry=False, queueing_lock="twitter-sweep-announcements",
    priority=announcements.PRIORITY,
)
def sweep_announcements_task(timestamp: int):
    return announcements.sweep()
