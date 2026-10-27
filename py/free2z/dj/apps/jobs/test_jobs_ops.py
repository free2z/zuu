"""Operator operations against the real Procrastinate/PostgreSQL schema."""
import json
import io
import asyncio
import threading
from types import SimpleNamespace
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from asgiref.sync import async_to_sync, sync_to_async
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connections
from django.utils import timezone
from procrastinate import exceptions, job_context
from procrastinate import jobs as procrastinate_jobs
from procrastinate.contrib.django import app
from procrastinate.contrib.django.models import ProcrastinateJob
from procrastinate.retry import RetryStrategy

from dj.apps.jobs import ops
from dj.apps.jobs.priorities import BACKGROUND, DEFAULT
from dj.apps.jobs.models import (
    OperatorAction,
    ParkedJob,
    QueueControl,
    QuarantinedJob,
)
from dj.apps.jobs.lease import (
    install_queue_fetch_gate,
    queue_pause_middleware,
    queue_pause_middleware_async,
)


@pytest.fixture(autouse=True)
def restore_procrastinate_registry_and_connections():
    """Keep temporary worker tasks and their aliases local to each test."""
    registered_tasks = app.tasks.copy()
    try:
        yield
    finally:
        # Procrastinate stores both task names and aliases in this shared dict.
        # Restoring the snapshot avoids contaminating later modules in a
        # combined pytest process (notably reclaim-policy completeness checks).
        app.tasks.clear()
        app.tasks.update(registered_tasks)
        connections.close_all()


def _defer(*, queue='default', queueing_lock=None):
    job = procrastinate_jobs.Job(
        queue=queue, priority=DEFAULT, lock=None,
        queueing_lock=queueing_lock,
        task_name='jobs.reclaim_stalled_jobs',
        task_kwargs={'timestamp': 0})
    return app.job_manager.defer_job(job).id


def _mark_failed(job_id, queue='default'):
    async_to_sync(app.job_manager.finish_job_by_id_async)(
        job_id, procrastinate_jobs.Status.FAILED, False)


@pytest.mark.django_db(transaction=True)
def test_dry_run_changes_no_job_or_audit_row():
    job_id = _defer()
    before = ProcrastinateJob.objects.count()
    result = ops.cancel(ids=[job_id])
    assert result == [{'id': job_id, 'status': 'todo', 'result': 'would_cancel'}]
    assert ProcrastinateJob.objects.count() == before
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'todo'
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_mutating_verbs_dry_run_without_writes():
    queue = 'ops-dry-run-test'
    failed_id = _defer(queue=queue)
    _mark_failed(failed_id, queue=queue)
    todo_id = _defer(queue=queue)
    before = ProcrastinateJob.objects.count()

    assert ops.requeue(ids=[failed_id])[0]['result'] == 'would_requeue'
    assert ops.fail(ids=[todo_id])[0]['result'] == 'would_fail'
    assert ops.cancel(ids=[todo_id])[0]['result'] == 'would_cancel'
    assert ops.set_queue_paused(queue, paused=True,
                                reason='preview').get('result') == 'would_pause'
    assert ops.drain_queue(queue, limit=100)['todo'][0]['result'] == 'would_park'
    assert ops.resume_queue(queue, limit=100)['jobs'] == []
    assert ops.prune(older_than_days=7, limit=100)['result'] == 'would_prune'

    assert ProcrastinateJob.objects.count() == before
    assert ProcrastinateJob.objects.get(pk=failed_id).status == 'failed'
    assert ProcrastinateJob.objects.get(pk=todo_id).status == 'todo'
    assert not QueueControl.objects.filter(queue=queue).exists()
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_execute_without_reason_is_rejected_by_command():
    job_id = _defer()
    commands = [
        ('requeue', str(job_id)), ('fail', str(job_id)),
        ('cancel', str(job_id)), ('pause', 'ops-reason-test'),
        ('drain', 'ops-reason-test', '--limit', '1'),
        ('resume', 'ops-reason-test', '--limit', '1'),
        ('prune', '--older-than', '7', '--limit', '1'),
    ]
    for command in commands:
        with pytest.raises(CommandError, match='--reason') as error:
            call_command('jobs', *command, execute=True)
        assert error.value.returncode == 2
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'todo'
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_execute_cancel_writes_audit_and_structured_log(caplog, monkeypatch):
    job_id = _defer()
    monkeypatch.setenv('JOBS_OPERATOR', 'skyler@example.test')
    result = ops.cancel(ids=[job_id], execute=True, reason='test action')
    assert result[0]['result'] == 'cancelled'
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'cancelled'
    action = OperatorAction.objects.get()
    assert action.verb == 'cancel'
    assert action.job_ids == [job_id]
    assert action.actor == 'skyler@example.test'
    assert action.reason == 'test action'
    lines = [record.message for record in caplog.records
             if 'procrastinate_operator_action' in record.message]
    assert len(lines) == 1
    assert json.loads(lines[0])['job_ids'] == [job_id]


@pytest.mark.django_db(transaction=True)
def test_fail_executes_only_eligible_statuses():
    queue = 'ops-fail-test'
    failed_id = _defer(queue=queue)
    _mark_failed(failed_id, queue=queue)
    todo_id = _defer(queue=queue)

    result = ops.fail(ids=[todo_id, failed_id], execute=True,
                      reason='test fail')
    assert [row['result'] for row in result] == ['failed', 'ineligible']
    assert ProcrastinateJob.objects.get(pk=todo_id).status == 'failed'
    assert ProcrastinateJob.objects.get(pk=failed_id).status == 'failed'
    assert OperatorAction.objects.filter(verb='fail').count() == 1


@pytest.mark.django_db(transaction=True)
def test_requeue_reports_queueing_lock_collision_and_continues():
    queue = 'ops-requeue-test'
    colliding = _defer(queue=queue, queueing_lock='same-key')
    _mark_failed(colliding, queue=queue)
    healthy = _defer(queue=queue)
    pending = _defer(queue=queue, queueing_lock='same-key')
    # Move the independent job to failed through Procrastinate's status API.
    worker_id = async_to_sync(app.job_manager.register_worker)()
    fetched = async_to_sync(app.job_manager.fetch_job)(
        queues=[queue], worker_id=worker_id)
    assert fetched and fetched.id == healthy
    async_to_sync(app.job_manager.finish_job_by_id_async)(
        healthy, procrastinate_jobs.Status.FAILED, False)

    output = io.StringIO()
    with pytest.raises(CommandError, match='one or more job operations failed') as error:
        call_command('jobs', 'requeue', str(colliding), str(healthy),
                     '--execute', '--reason', 'test collision', stdout=output)
    assert error.value.returncode == 1
    result = json.loads(output.getvalue())
    assert result[0]['result'] == 'error'
    assert 'queueing_lock collision' in result[0]['error']
    assert result[1]['result'] == 'requeued'
    assert ProcrastinateJob.objects.get(pk=pending).status == 'todo'
    assert ProcrastinateJob.objects.get(pk=healthy).status == 'todo'
    assert OperatorAction.objects.filter(verb='requeue').count() == 1


@pytest.mark.django_db(transaction=True)
def test_billing_queue_mutation_requires_money(settings):
    settings.JOB_HEALTH_BILLING_QUEUES = []
    queue = 'billing'
    job_id = _defer(queue=queue)
    failed_id = _defer(queue=queue)
    _mark_failed(failed_id, queue=queue)
    with pytest.raises(ValueError, match='--money'):
        ops.cancel(ids=[job_id], execute=True, reason='test action')
    with pytest.raises(ValueError, match='--money'):
        ops.fail(ids=[job_id], execute=True, reason='test action')
    with pytest.raises(ValueError, match='--money'):
        ops.requeue(ids=[failed_id], execute=True, reason='test action')
    with pytest.raises(ValueError, match='--money'):
        ops.set_queue_paused(queue, paused=True, reason='test action', execute=True)
    with pytest.raises(ValueError, match='--money'):
        ops.drain_queue(queue, limit=10, execute=True, reason='test action')
    with pytest.raises(ValueError, match='--money'):
        ops.resume_queue(queue, limit=10, execute=True, reason='test action')
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'todo'
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_configured_billing_queue_and_parked_alias_need_money(settings):
    settings.JOB_HEALTH_BILLING_QUEUES = ['translation']
    job_id = _defer(queue='paused.translation')
    with pytest.raises(ValueError, match='--money'):
        ops.cancel(ids=[job_id], execute=True, reason='test alias guard')
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'todo'
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_fail_revalidates_status_after_selection(monkeypatch):
    queue = 'ops-stale-selector-test'
    job_id = _defer(queue=queue)
    locked_job = ops._locked_job
    changed = False

    def transition_before_lock(target):
        nonlocal changed
        if not changed:
            changed = True
            _mark_failed(target, queue=queue)
        return locked_job(target)

    monkeypatch.setattr(ops, '_locked_job', transition_before_lock)
    result = ops.fail(ids=[job_id], execute=True, reason='stale state check')
    assert result[0]['result'] == 'ineligible'
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'failed'
    assert not OperatorAction.objects.filter(verb='fail').exists()


@pytest.mark.django_db(transaction=True)
def test_prune_billing_guard_and_jobmanager_deletes_only_succeeded(settings):
    settings.JOB_HEALTH_BILLING_QUEUES = []
    succeeded = _defer(queue='billing')
    failed = _defer(queue='prune-negative-control')
    async_to_sync(app.job_manager.finish_job_by_id_async)(
        succeeded, procrastinate_jobs.Status.SUCCEEDED, False)
    ops.ProcrastinateEvent.objects.filter(job_id=succeeded).update(
        at=timezone.now() - timedelta(days=40))
    _mark_failed(failed, queue='prune-negative-control')

    with pytest.raises(ValueError, match='--money'):
        ops.prune(older_than_days=7, limit=10, execute=True,
                  reason='prune old rows')
    assert ProcrastinateJob.objects.get(pk=succeeded).status == 'succeeded'
    assert ProcrastinateJob.objects.get(pk=failed).status == 'failed'
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_prune_audit_failure_rolls_back_jobmanager_deletion(mocker):
    job_id = _defer(queue='ops-prune-rollback')
    async_to_sync(app.job_manager.finish_job_by_id_async)(
        job_id, procrastinate_jobs.Status.SUCCEEDED, False)
    ops.ProcrastinateEvent.objects.filter(job_id=job_id).update(
        at=timezone.now() - timedelta(days=30))
    preview = ops.prune(older_than_days=7, limit=1000, money=True)
    assert job_id in preview['job_ids']
    assert not OperatorAction.objects.exists()

    mocker.patch.object(OperatorAction.objects, 'create',
                        side_effect=RuntimeError('audit storage unavailable'))
    with pytest.raises(RuntimeError, match='audit storage unavailable'):
        ops.prune(older_than_days=7, limit=1000, execute=True,
                  reason='test rollback', money=True)
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'succeeded'
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_pause_records_actor_and_resume_clears_pause():
    ops.set_queue_paused('maintenance-test', paused=True,
                         reason='planned work', execute=True)
    row = QueueControl.objects.get(pk='maintenance-test')
    assert row.paused_at is not None
    assert row.reason == 'planned work'
    ops.resume_queue('maintenance-test', execute=True, reason='complete', limit=10)
    row.refresh_from_db()
    assert row.paused_at is None
    assert OperatorAction.objects.filter(verb='resume').count() == 1


@pytest.mark.django_db(transaction=True)
def test_pause_middleware_waits_without_retrying_before_calling_task_body(mocker):
    mocker.patch('dj.apps.jobs.lease.queue_is_paused', side_effect=[True, False])
    mocker.patch('time.sleep')
    context = SimpleNamespace(job=SimpleNamespace(queue='paused-test'))
    called = False

    def task_body():
        nonlocal called
        called = True

    queue_pause_middleware(task_body, context, None)
    assert called


@pytest.mark.django_db(transaction=True)
def test_pause_middleware_ignores_worker_shutdown_for_retryless_job(mocker):
    from dj.apps.jobs import lease

    mocker.patch.object(lease, 'queue_is_paused', side_effect=[True, False])
    mocker.patch('time.sleep')
    context = SimpleNamespace(
        job=SimpleNamespace(queue='paused-test'),
        abort_reason=lambda: job_context.AbortReason.SHUTDOWN,
    )
    called = False

    def task_body():
        nonlocal called
        called = True

    queue_pause_middleware(task_body, context, None)
    assert called


@pytest.mark.django_db(transaction=True)
def test_pause_middleware_honors_operator_abort(mocker):
    from dj.apps.jobs import lease

    mocker.patch.object(lease, 'queue_is_paused', return_value=True)
    context = SimpleNamespace(
        job=SimpleNamespace(queue='paused-test'),
        abort_reason=lambda: job_context.AbortReason.USER_REQUEST,
    )
    with pytest.raises(exceptions.JobAborted, match='operator abort'):
        queue_pause_middleware(lambda: pytest.fail('task body ran'), context, None)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('reason, aborts', [
    (job_context.AbortReason.USER_REQUEST, True),
    (job_context.AbortReason.SHUTDOWN, False),
])
def test_pause_middleware_reads_reason_from_real_job_context(mocker, reason, aborts):
    """A real JobContext: should_abort() is a bool, so the reason must come
    from abort_reason(). A test double that returns the enum from
    should_abort() hides that and the operator abort never fires."""
    from dj.apps.jobs import lease

    mocker.patch.object(lease, 'queue_is_paused', side_effect=[True, True, False])
    mocker.patch('time.sleep')
    context = job_context.JobContext(
        app=app, job=SimpleNamespace(queue='paused-test'),
        start_timestamp=0.0, abort_reason=lambda: reason,
    )
    assert context.should_abort() is True  # bool, not the enum
    ran = []
    if aborts:
        with pytest.raises(exceptions.JobAborted, match='operator abort'):
            queue_pause_middleware(lambda: ran.append(1), context, None)
        assert not ran
    else:
        queue_pause_middleware(lambda: ran.append(1), context, None)
        assert ran == [1]


@pytest.mark.django_db(transaction=True)
async def test_async_pause_middleware_ignores_worker_shutdown(mocker):
    from dj.apps.jobs import lease

    mocker.patch.object(lease, 'queue_is_paused', side_effect=[True, False])
    mocker.patch('asyncio.sleep', new=AsyncMock())
    context = SimpleNamespace(
        job=SimpleNamespace(queue='paused-test'),
        abort_reason=lambda: job_context.AbortReason.SHUTDOWN,
    )
    called = False

    async def task_body():
        nonlocal called
        called = True

    await queue_pause_middleware_async(task_body, context, None)
    assert called


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('retry', [False, RetryStrategy(max_attempts=3)])
async def test_real_worker_leaves_paused_job_todo_then_runs_after_resume(retry):
    """The fetch gate avoids retry/attempt accounting for both retry policies."""
    from procrastinate.worker import Worker

    queue = f'ops-paused-worker-{int(bool(retry))}'
    ran = threading.Event()
    task_name = f'jobs.ops_paused_worker_{int(bool(retry))}'

    @app.task(name=task_name, queue=queue, retry=retry)
    def side_effect():
        ran.set()

    job_id = await sync_to_async(side_effect.defer)()
    await sync_to_async(QueueControl.objects.create)(
        queue=queue, paused_at=timezone.now(), reason='maintenance', actor='test')
    install_queue_fetch_gate(app.job_manager)
    worker = Worker(app=app, queues=[queue], listen_notify=False,
                    fetch_job_polling_interval=0.01,
                    install_signal_handlers=False,
                    task_middleware=app.worker_defaults['task_middleware'])
    runner = asyncio.create_task(worker.run())
    try:
        await asyncio.sleep(0.15)
        paused = await sync_to_async(ProcrastinateJob.objects.get)(pk=job_id)
        assert paused.status == 'todo'
        assert paused.attempts == 0
        assert not ran.is_set()

        await sync_to_async(ops.resume_queue)(
            queue, execute=True, reason='maintenance complete', limit=10)
        for _ in range(100):
            if ran.is_set():
                break
            await asyncio.sleep(0.02)
        assert ran.is_set()
        worker.stop()
        await asyncio.wait_for(runner, timeout=3)
        finished = await sync_to_async(ProcrastinateJob.objects.get)(pk=job_id)
        assert finished.status == 'succeeded'
        assert finished.attempts == 1
    finally:
        if not runner.done():
            worker.stop()
            await asyncio.wait_for(runner, timeout=3)
        await sync_to_async(connections.close_all)()


@pytest.mark.django_db(transaction=True)
async def test_wildcard_worker_never_fetches_a_parked_queue_copy():
    from procrastinate.worker import Worker

    queue = 'ops-wildcard-parked'
    alias = f'paused.{queue}'
    ran = threading.Event()
    task_name = 'jobs.ops_wildcard_parked_worker'

    @app.task(name=task_name, queue=queue, retry=False)
    def side_effect():
        ran.set()

    job_id = await sync_to_async(side_effect.configure(queue=alias).defer)()
    install_queue_fetch_gate(app.job_manager)
    worker = Worker(app=app, queues=None, listen_notify=False,
                    fetch_job_polling_interval=0.01,
                    install_signal_handlers=False,
                    task_middleware=app.worker_defaults['task_middleware'])
    runner = asyncio.create_task(worker.run())
    try:
        await asyncio.sleep(0.2)
        row = await sync_to_async(
            ProcrastinateJob.objects.get, thread_sensitive=False)(pk=job_id)
        assert row.status == 'todo'
        assert not ran.is_set()
    finally:
        worker.stop()
        await asyncio.wait_for(runner, timeout=3)
        await sync_to_async(connections.close_all)()


@pytest.mark.django_db(transaction=True)
async def test_pause_after_fetch_survives_worker_shutdown_until_resumed():
    """Shutdown must not abort a retryless fetched-but-paused job."""
    from procrastinate.worker import Worker

    queue = 'ops-pause-fetch-race'
    ran = threading.Event()
    at_boundary = asyncio.Event()

    @app.task(name='jobs.ops_pause_fetch_race', queue=queue, retry=False)
    def side_effect():
        ran.set()

    job_id = await sync_to_async(side_effect.defer)()
    install_queue_fetch_gate(app.job_manager)
    worker = Worker(app=app, queues=[queue], listen_notify=False,
                    fetch_job_polling_interval=0.01,
                    install_signal_handlers=False,
                    task_middleware=app.worker_defaults['task_middleware'])
    original_process = worker._process_job

    async def pause_after_fetch(context):
        await sync_to_async(ops.set_queue_paused)(
            queue, paused=True, execute=True, reason='fetch boundary race')
        at_boundary.set()
        return await original_process(context)

    worker._process_job = pause_after_fetch
    runner = asyncio.create_task(worker.run())
    try:
        await asyncio.wait_for(at_boundary.wait(), timeout=3)
        row = await sync_to_async(
            ProcrastinateJob.objects.get, thread_sensitive=False)(pk=job_id)
        assert row.status == 'doing'
        assert row.attempts == 0  # middleware has not entered task execution
        assert not ran.is_set()
        worker.stop()
        await asyncio.sleep(0.05)
        still_waiting = await sync_to_async(
            ProcrastinateJob.objects.get, thread_sensitive=False)(pk=job_id)
        assert still_waiting.status == 'doing'
        assert still_waiting.attempts == 0
        assert not ran.is_set()
        await sync_to_async(ops.resume_queue, thread_sensitive=False)(
            queue, execute=True, reason='race cleared', limit=1)
        for _ in range(100):
            if ran.is_set():
                break
            await asyncio.sleep(0.02)
        assert ran.is_set()
        await asyncio.wait_for(runner, timeout=3)
        completed = await sync_to_async(
            ProcrastinateJob.objects.get, thread_sensitive=False)(pk=job_id)
        assert completed.status == 'succeeded'
        assert completed.attempts == 1
    finally:
        await sync_to_async(ops.resume_queue, thread_sensitive=False)(
            queue, execute=True, reason='test cleanup', limit=1)
        worker.stop()
        await asyncio.wait_for(runner, timeout=3)
        await sync_to_async(connections.close_all)()


@pytest.mark.django_db(transaction=True)
def test_from_quarantine_only_requeues_reclaimer_give_ups():
    queue = 'ops-quarantine-test'
    quarantined_id = _defer(queue=queue)
    _mark_failed(quarantined_id, queue=queue)
    ordinary_id = _defer(queue=queue)
    _mark_failed(ordinary_id, queue=queue)
    QuarantinedJob.objects.create(
        job_id=quarantined_id, task_name='jobs.reclaim_stalled_jobs',
        queue=queue, reason='bounded reclaim policy', attempts=4)

    preview = ops.requeue(ids=[quarantined_id, ordinary_id],
                          from_quarantine=True)
    assert [row['result'] for row in preview] == ['would_requeue', 'ineligible']
    assert ProcrastinateJob.objects.get(pk=quarantined_id).status == 'failed'
    assert not OperatorAction.objects.exists()

    executed = ops.requeue(ids=[quarantined_id, ordinary_id],
                           from_quarantine=True, execute=True,
                           reason='reviewed recovery')
    assert executed[0]['result'] == 'requeued'
    assert executed[1]['result'] == 'ineligible'
    assert ProcrastinateJob.objects.get(pk=quarantined_id).status == 'todo'
    assert QuarantinedJob.objects.get(pk=quarantined_id).requeued_at is not None
    assert ProcrastinateJob.objects.get(pk=ordinary_id).status == 'failed'


@pytest.mark.django_db(transaction=True)
def test_empty_quarantine_and_explicit_selector_filters_never_broaden():
    queue = 'ops-empty-quarantine-test'
    unrelated = _defer(queue=queue)
    _mark_failed(unrelated, queue=queue)

    assert ops.requeue(from_quarantine=True, limit=20) == []
    assert ops.requeue(ids=[unrelated], from_quarantine=True) == [
        {'id': unrelated, 'result': 'ineligible'}]
    assert ops._select_jobs(ids=[unrelated], task='some.other.task') == []
    # The failed event is recent, so an explicit-id selector cannot bypass age.
    assert ops._select_jobs(ids=[unrelated], older_than=3600) == []
    assert ProcrastinateJob.objects.get(pk=unrelated).status == 'failed'
    assert not OperatorAction.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_command_reports_missing_explicit_ids_with_nonzero_status():
    output = io.StringIO()
    with pytest.raises(CommandError) as error:
        call_command('jobs', 'cancel', '9223372036854770000', stdout=output)
    assert error.value.returncode == 1
    assert json.loads(output.getvalue())[0]['result'] == 'not_found'


@pytest.mark.django_db(transaction=True)
def test_drain_resume_round_trip_preserves_job_configuration():
    queue = 'ops-drain-test'
    scheduled_at = timezone.now() + timedelta(minutes=30)
    task = app.tasks['jobs.reclaim_stalled_jobs']
    source_id = task.configure(
        queue=queue, priority=BACKGROUND, lock='ops-lock',
        queueing_lock='ops-queueing-lock', schedule_at=scheduled_at,
    ).defer(timestamp=123)

    drained = ops.drain_queue(queue, limit=10, execute=True, reason='test drain')
    assert drained['todo'][0]['result'] == 'parked'
    source = app.job_manager.list_jobs(id=source_id)[0]
    assert source.status == 'cancelled'
    parked_id = drained['todo'][0]['new_id']
    parked = ProcrastinateJob.objects.get(pk=parked_id)
    assert parked.status == 'todo'
    assert parked.queue_name == f'paused.{queue}'
    assert parked.priority == BACKGROUND
    assert parked.lock == 'ops-lock'
    assert parked.queueing_lock == 'ops-queueing-lock'
    assert parked.args == {'timestamp': 123}
    assert parked.scheduled_at == scheduled_at

    resumed = ops.resume_queue(queue, execute=True, reason='test resume', limit=10)
    restored_id = resumed['jobs'][0]['new_id']
    restored = ProcrastinateJob.objects.get(pk=restored_id)
    assert restored.queue_name == queue
    assert restored.priority == BACKGROUND
    assert restored.lock == 'ops-lock'
    assert restored.queueing_lock == 'ops-queueing-lock'
    assert restored.args == {'timestamp': 123}
    assert restored.scheduled_at == scheduled_at
    assert ProcrastinateJob.objects.get(pk=source_id).status == 'cancelled'
    assert ProcrastinateJob.objects.get(pk=parked_id).status == 'cancelled'
    park_audit = OperatorAction.objects.get(verb='drain_park')
    restore_audit = OperatorAction.objects.get(verb='resume_job')
    assert park_audit.job_ids == [source_id, parked_id]
    assert restore_audit.job_ids == [source_id, parked_id, restored_id]


@pytest.mark.django_db(transaction=True)
def test_drain_refuses_attempted_job_id_deduped_broadcast():
    from dj.apps.g12f.tasks import notify_published_zpage

    queue = 'ops-drain-broadcast-test'
    job_id = notify_published_zpage.configure(queue=queue).defer(zpage_id=123)
    ProcrastinateJob.objects.filter(pk=job_id).update(attempts=1)

    preview = ops.drain_queue(queue, limit=10)
    assert preview['todo'] == [
        {'id': job_id, 'task': 'g12f.notify_published_zpage', 'attempts': 1,
         'result': 'would_refuse',
         'reason': 'drain/resume would change this task\'s job-id dedupe key'}]

    output = io.StringIO()
    with pytest.raises(CommandError, match='one or more job operations failed'):
        call_command('jobs', 'drain', queue, '--limit', '10', '--execute',
                     '--reason', 'protect broadcast identity', stdout=output)
    result = json.loads(output.getvalue())
    assert result['todo'][0]['result'] == 'error'
    assert 'job-id dedupe key' in result['todo'][0]['error']
    row = ProcrastinateJob.objects.get(pk=job_id)
    assert row.status == 'todo'
    assert row.queue_name == queue
    assert row.attempts == 1
    control = QueueControl.objects.get(queue=queue)
    assert control.paused and control.draining
    assert not ParkedJob.objects.filter(queue=queue).exists()


@pytest.mark.django_db(transaction=True)
def test_partial_drain_and_failed_resume_keep_queue_paused():
    queue = 'ops-drain-partial-test'
    first = _defer(queue=queue)
    _defer(queue=queue)
    partial = ops.drain_queue(queue, limit=1, execute=True,
                              reason='bounded drain')
    assert partial['result'] == 'draining'
    control = QueueControl.objects.get(queue=queue)
    assert control.paused and control.draining
    assert partial['remaining'] == 1

    ops.drain_queue(queue, limit=10, execute=True, reason='finish drain')
    control.refresh_from_db()
    assert control.paused and not control.draining
    mapping = ParkedJob.objects.get(source_job_id=first)
    assert app.job_manager.cancel_job_by_id(mapping.parked_job_id)
    output = io.StringIO()
    with pytest.raises(CommandError, match='one or more job operations failed'):
        call_command('jobs', 'resume', queue, '--limit', '10', '--execute',
                     '--reason', 'restore after failure', stdout=output)
    control.refresh_from_db()
    assert control.paused
    assert ParkedJob.objects.filter(queue=queue).exists()
    assert json.loads(output.getvalue())['jobs'][0]['result'] == 'error'


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('selector', [
    ['--task', 'ops.cli_selector_probe', '--status', 'failed'],
    ['--from-quarantine'],
])
def test_command_selector_requeue_without_ids_requeues(selector):
    """argparse gives `ids=[]` when no positionals are passed; the command
    must not hand that to ops.requeue as an explicit empty id list, or every
    documented selector requeue prints `[]`, exits 0 and recovers nothing."""
    queue = 'ops-cli-selector-test'
    # A task name no other test defers: Procrastinate rows survive between
    # tests here, so a shared task would select their failed (billing) rows.
    job_id = app.job_manager.defer_job(procrastinate_jobs.Job(
        queue=queue, priority=DEFAULT, lock=None, queueing_lock=None,
        task_name='ops.cli_selector_probe', task_kwargs={})).id
    _mark_failed(job_id, queue=queue)
    QuarantinedJob.objects.create(
        job_id=job_id, task_name='ops.cli_selector_probe',
        queue=queue, reason='bounded reclaim policy', attempts=4)
    output = io.StringIO()
    call_command('jobs', 'requeue', *selector, '--limit', '5', '--execute',
                 '--reason', 'selector recovery', stdout=output)
    rows = json.loads(output.getvalue())
    assert [(row['id'], row['result']) for row in rows] == [(job_id, 'requeued')]
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'todo'


@pytest.mark.django_db(transaction=True)
def test_selector_listing_is_bounded_before_reading_jobs(monkeypatch):
    """`--limit` must bound the read, not slice a fully materialised history:
    JobManager.list_jobs has no LIMIT, so only per-id reads are allowed."""
    queue = 'ops-bounded-select-test'
    ids = [_defer(queue=queue) for _ in range(3)]
    original = app.job_manager.list_jobs
    calls = []

    def guarded(**kwargs):
        assert set(kwargs) == {'id'}, f'unbounded list_jobs({kwargs})'
        calls.append(kwargs['id'])
        return original(**kwargs)

    monkeypatch.setattr(app.job_manager, 'list_jobs', guarded)
    rows = ops.list_jobs(queue=queue, status='todo', limit=2)
    assert [row['id'] for row in rows] == ids[:2]
    assert calls == ids[:2]
    assert ops.list_jobs(queue=queue, older_than=3600, limit=5) == []
