"""Registered ledger tasks and the dedicated periodic consumer contract."""
import pytest
from procrastinate.contrib.django import app

from dj.apps.jobs.reclaim_policy import TASK_POLICIES
from dj.apps.ledger import tasks

pytestmark = pytest.mark.django_db


def test_all_ledger_names_are_registered_and_classified():
    for name in (tasks.EXPIRE_HOLDS_TASK_NAME, tasks.AI_ROLLUP_TASK_NAME, tasks.PARTITIONS_TASK_NAME):
        assert name in app.tasks, name
        assert app.tasks[name].queue == "ledger"
        assert name in TASK_POLICIES and not TASK_POLICIES[name].reclaimable


def test_periodics_schedule_only_the_dedicated_ledger_queue():
    """Register first, produce second: `@app.periodic` arrives with L2."""
    periodic = {name for name, _periodic_id in app.periodic_registry.periodic_tasks}
    assert tasks.EXPIRE_HOLDS_TASK_NAME in periodic
    assert tasks.AI_ROLLUP_TASK_NAME in periodic


def test_empty_worker_ticks_complete_without_moving_money():
    # Storage can land dark. The worker lane and scheduling are a separate
    # owner-gated activation; these registered bodies work when invoked.
    assert tasks.l2_tables_exist() is True
    from .test_rollup import seed_rollup
    seed_rollup()
    assert tasks.expire_holds.func(timestamp=0) == {"status": "completed", "expired": 0, "deferred": 0, "calls_cleaned": 0, "calls_deferred": 0}
    assert tasks.ai_rollup.func(timestamp=0) == {"status": "completed", "rows": 0, "credited": 0, "deferred": 0}
