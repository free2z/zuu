

def test_create_reconciler_is_registered_one_release_before_implementation():
    """Schema release registers the Procrastinate task name; it stays inert."""
    from procrastinate.contrib.django import app

    from dj.apps.jobs.reclaim_policy import TASK_POLICIES
    from dj.apps.dyte.tasks import reconcile_create_unknowns

    task = app.tasks["dyte.reconcile_create_unknowns"]
    assert task.queue == "default"
    policy = TASK_POLICIES["dyte.reconcile_create_unknowns"]
    assert policy.reclaimable
    assert policy.max_runtime_seconds == 5
    # The periodic signature: a tick deferred by the lifecycle release onto a
    # worker still on this release must run, not raise on its kwargs.
    assert reconcile_create_unknowns(timestamp=0) is None


