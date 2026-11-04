"""The periodic surge sweep is coalesced without stopping periodic deferral."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

from procrastinate.exceptions import AlreadyEnqueued
from procrastinate.periodic import PeriodicDeferrer, PeriodicRegistry


SURGE_QUEUEING_LOCK = "oidc.reevaluate_ai_report_surges"


def test_surge_schedule_uses_a_queueing_lock():
    from dj.apps.oidc.tasks import reevaluate_ai_report_surges
    from procrastinate.contrib.django import app

    [schedule] = [
        schedule
        for schedule in app.periodic_registry.periodic_tasks.values()
        if schedule.task is reevaluate_ai_report_surges
    ]

    assert schedule.configure_kwargs["queueing_lock"] == SURGE_QUEUEING_LOCK


def test_already_enqueued_surge_ticks_are_skipped_until_pending_job_finishes():
    class JobManager:
        def __init__(self):
            self.timestamps = []
            self.pending = True
            self.enqueued = []

        async def defer_periodic_job(self, *, defer_timestamp, **kwargs):
            self.timestamps.append(defer_timestamp)
            if self.pending:
                raise AlreadyEnqueued()
            self.enqueued.append(defer_timestamp)
            self.pending = True
            return len(self.timestamps)

    class Job:
        id = None
        call_string = "oidc.reevaluate_ai_report_surges()"

        def log_context(self):
            return {}

        def evolve(self, **kwargs):
            self.id = kwargs["id"]
            return self

    class Task:
        name = "oidc.reevaluate_ai_report_surges"
        queueing_lock = SURGE_QUEUEING_LOCK

        def __init__(self, job_manager):
            self.job_manager = job_manager
            self.configured_locks = []

        def configure(self, **kwargs):
            self.configured_locks.append(kwargs["queueing_lock"])
            return SimpleNamespace(
                job=Job(),
                job_manager=self.job_manager,
            )

    manager = JobManager()
    task = Task(manager)
    registry = PeriodicRegistry()
    registry.register_task(
        task=task,
        cron="*/5 * * * *",
        periodic_id="surge-test",
        configure_kwargs={"queueing_lock": SURGE_QUEUEING_LOCK},
    )
    deferrer = PeriodicDeferrer(registry)
    first_tick = int(datetime(2024, 1, 1, 0, 5, tzinfo=timezone.utc).timestamp())
    second_tick = first_tick + 5 * 60
    third_tick = second_tick + 5 * 60

    # The pending locked job rejects successive periodic ticks; once it
    # finishes, a later tick is still deferred successfully.
    asyncio.run(deferrer.defer_jobs(deferrer.get_previous_tasks(at=first_tick + 1)))
    asyncio.run(deferrer.defer_jobs(deferrer.get_previous_tasks(at=second_tick + 1)))
    manager.pending = False
    asyncio.run(deferrer.defer_jobs(deferrer.get_previous_tasks(at=third_tick + 1)))

    assert manager.timestamps == [first_tick, second_tick, third_tick]
    assert manager.enqueued == [third_tick]
    assert task.configured_locks == [SURGE_QUEUEING_LOCK] * 3
