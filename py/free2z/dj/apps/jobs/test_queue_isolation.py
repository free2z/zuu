"""Application task registry, queue ownership, and worker lifecycle contracts."""


from __future__ import annotations


from procrastinate.contrib.django import app


from procrastinate.worker import Worker


def test_polling_keeps_heartbeat_scheduler_and_abort_tasks(monkeypatch):
    """Exercise the pinned upstream worker lifecycle without a DB connection."""
    import asyncio
    from unittest.mock import AsyncMock

    async def exercise():
        for listen in (False, True):
            worker = Worker(app=app, listen_notify=listen, install_signal_handlers=False)
            idle = asyncio.Event()
            for method in ("_update_heartbeat", "_periodic_deferrer", "_poll_jobs_to_abort"):
                monkeypatch.setattr(worker, method, idle.wait)
            listener = AsyncMock(side_effect=idle.wait)
            monkeypatch.setattr(app.job_manager, "listen_for_jobs", listener)
            tasks = worker._start_side_tasks()
            try:
                names = {task.get_name() for task in tasks}
                assert names == {"update_heartbeats", "deferrer", "poll_jobs_to_abort"} | (
                    {"listener"} if listen else set()
                )
                assert listener.call_count == int(listen)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(exercise())


def test_polling_fetches_immediately_then_without_notifications(monkeypatch):
    """An idle polling worker discovers later work without a NOTIFY event."""
    import asyncio
    from unittest.mock import AsyncMock

    async def exercise():
        worker = Worker(app=app, listen_notify=False, fetch_job_polling_interval=0.01,
                        install_signal_handlers=False)
        idle = asyncio.Event()
        monkeypatch.setattr(worker, "_start_side_tasks", lambda: [])
        monkeypatch.setattr(worker, "_monitor_side_tasks", lambda tasks: idle.wait())
        monkeypatch.setattr(worker, "_shutdown", AsyncMock())
        visits = []
        async def fetch():
            visits.append(asyncio.get_running_loop().time())
            if len(visits) == 2:
                worker._stop_event.set()
        monkeypatch.setattr(worker, "_fetch_and_process_jobs", fetch)
        await asyncio.wait_for(worker._run_loop(), timeout=1)
        assert len(visits) == 2
        assert visits[1] - visits[0] >= 0.01
        assert not worker._new_job_event.is_set()
    asyncio.run(exercise())
