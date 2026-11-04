"""New lease code against the 0005 schema, before the phase columns exist.

An image can start workers before ``migrate`` adds ``jobs/0006`` and
``jobs/0007``. Every lease writer and reader must keep working on the old
table in that window: jobs still lease and run, and the reclaimer and health
query still answer. The fixture migrates ``jobs`` back to 0005 for real and
forward again afterwards, so these tests run against the schema the migration
graph produces, not a hand-written copy of it.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from asgiref.sync import async_to_sync
from django.core.management import call_command
from django.db import connection
from django.utils import timezone
from procrastinate.contrib.django import app
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.jobs import health, lease, lease_schema, reclaim
from dj.apps.search.tasks import index_zpage
from dj.apps.uploads.tasks import generate_video_poster

QUEUE = 'lease-pre-phase-test'


def _columns() -> set[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            'SELECT attname FROM pg_attribute WHERE attrelid = '
            "to_regclass('jobs_joblease') AND attnum > 0 "
            'AND NOT attisdropped')
        return {row[0] for row in cursor.fetchall()}


def _migrate_forward() -> None:
    call_command('migrate', 'jobs', verbosity=0)
    lease.reset_for_tests()


@pytest.fixture
def schema_0005(transactional_db, settings):
    settings.JOB_LEASE_BEAT_SECONDS = 0.4
    settings.JOB_LEASE_TABLE_RECHECK_SECONDS = 0
    settings.JOB_LEASE_ENABLED = True
    settings.JOB_LEASE_WITHOUT_RECLAIMER = True
    lease.reset_for_tests()
    call_command('migrate', 'jobs', '0005', verbosity=0)
    assert not set(lease_schema.PHASE_COLUMNS) & _columns()
    before = set(ProcrastinateJob.objects.values_list('id', flat=True))
    try:
        yield
    finally:
        owned = list(set(ProcrastinateJob.objects.values_list(
            'id', flat=True)) - before)
        with connection.cursor() as cursor:
            for statement in (
                    'DELETE FROM jobs_joblease WHERE job_id = ANY(%s)',
                    'DELETE FROM jobs_quarantined_job WHERE job_id = ANY(%s)',
                    'DELETE FROM procrastinate_jobs WHERE id = ANY(%s)'):
                cursor.execute(statement, [owned])
        _migrate_forward()
        assert set(lease_schema.PHASE_COLUMNS) <= _columns()


def _doing_job(job_id: int) -> SimpleNamespace:
    with connection.cursor() as cursor:
        cursor.execute(
            'INSERT INTO procrastinate_jobs '
            '(id, queue_name, task_name, status, attempts) '
            "VALUES (%s, %s, 'lease_test.fake', 'doing', 0)",
            [job_id, QUEUE])
    return SimpleNamespace(
        job=SimpleNamespace(id=job_id, task_name='lease_test.fake',
                            queue=QUEUE, attempts=0),
        start_timestamp=time.time(),
        worker_name='pre-phase-worker',
    )


def _lease_row(job_id: int):
    with connection.cursor() as cursor:
        cursor.execute(
            'SELECT token, attempt FROM jobs_joblease WHERE job_id = %s',
            [job_id])
        return cursor.fetchone()


def _worker():
    return SimpleNamespace(_job_ids_to_abort={})


@pytest.mark.django_db(transaction=True)
def test_sync_middleware_leases_and_runs_the_body_on_0005(schema_0005):
    context = _doing_job(920001)
    seen = []

    result = lease.lease_middleware(
        lambda: seen.append(_lease_row(920001)) or 'ran',
        context, _worker())

    assert result == 'ran'
    assert len(seen) == 1 and seen[0] is not None, (
        'the body must run, under a lease row, on the pre-0006 schema')
    assert _lease_row(920001) is None


@pytest.mark.django_db(transaction=True)
def test_async_middleware_leases_and_runs_the_body_on_0005(schema_0005):
    context = _doing_job(920002)
    seen = []

    async def body():
        seen.append(await asyncio.to_thread(_lease_row, 920002))
        return 'ran'

    async def run():
        return await lease.lease_middleware_async(body, context, _worker())

    assert async_to_sync(run)() == 'ran'
    assert len(seen) == 1 and seen[0] is not None
    assert _lease_row(920002) is None


@pytest.mark.django_db(transaction=True)
def test_a_lease_acquired_on_0005_stays_legacy_after_migrate(schema_0005):
    """Columns appearing mid-attempt must not fence the attempt's body."""
    context = _doing_job(920003)
    acquired = lease.acquire(context, _worker())
    assert acquired is not None and not acquired.lost.is_set()
    assert acquired.values['phase'] is None

    _migrate_forward()

    assert lease._begin_body(acquired) is True
    assert not acquired.lost.is_set()
    with connection.cursor() as cursor:
        cursor.execute(
            'SELECT phase, phase_token FROM jobs_joblease WHERE job_id = %s',
            [920003])
        row = cursor.fetchone()
    # The 0006 default backfills the legacy row; it never claims pre-body
    # proof, so the reclaimer cannot treat this attempt as unstarted.
    assert row == ('unknown', None)
    assert lease.release(acquired) is True
    assert _lease_row(920003) is None


def _mark_doing(job_id, started_at, worker_id):
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE procrastinate_jobs SET status='doing', worker_id=%s, "
            'attempts=0 WHERE id=%s', [worker_id, job_id])
        cursor.execute(
            'UPDATE procrastinate_events SET at=%s '
            "WHERE job_id=%s AND type='started'", [started_at, job_id])


def _dead_worker(now):
    with connection.cursor() as cursor:
        cursor.execute(
            'INSERT INTO procrastinate_workers (last_heartbeat) '
            'VALUES (%s) RETURNING id', [now - timedelta(seconds=1800)])
        return cursor.fetchone()[0]


def _legacy_lease(job_id, task_name, queue, *, last_beat_at):
    with connection.cursor() as cursor:
        cursor.execute(
            'INSERT INTO jobs_joblease (job_id, token, worker_name, pod, '
            'task_name, queue, started_at, last_beat_at, deadline_at, '
            "attempt) VALUES (%s, %s, '', '', %s, %s, %s, %s, NULL, 0)",
            [job_id, uuid.uuid4(), task_name, queue, last_beat_at,
             last_beat_at])


def _sweep_with_production_pool():
    from procrastinate.contrib.django.utils import connector_params
    from procrastinate.psycopg_connector import PsycopgConnector

    async def run():
        connector = PsycopgConnector(
            kwargs=connector_params(), min_size=1, max_size=1)
        await connector.open_async()
        try:
            with app.replace_connector(connector):
                return await reclaim.reclaim_stalled_jobs()
        finally:
            await connector.close_async()

    return async_to_sync(run)()


@pytest.mark.parametrize('production_pool', [False, True],
                         ids=['django-connector', 'production-pool'])
@pytest.mark.django_db(transaction=True)
def test_reclaim_requeues_a_stale_legacy_lease_on_0005(
        schema_0005, settings, production_pool):
    settings.JOB_RECLAIM_MIN_AGE_SECONDS = 120
    settings.JOB_RECLAIM_BUDGET_MARGIN_SECONDS = 300
    settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS = 60
    settings.JOB_LEASE_STALE_SECONDS = 60
    settings.JOB_RECLAIM_EXCLUDED_QUEUES = ('exports',)
    settings.JOB_RECLAIM_OPERATOR_EXCLUDED_QUEUES = ()
    now = timezone.now()
    job_id = generate_video_poster.defer(generic_file_id=920004)
    _mark_doing(job_id, now - timedelta(seconds=2400), _dead_worker(now))
    _legacy_lease(job_id, 'uploads.generate_video_poster', 'images',
                  last_beat_at=now - timedelta(seconds=2400))

    summary = (_sweep_with_production_pool() if production_pool
               else asyncio.run(reclaim.reclaim_stalled_jobs()))

    assert summary['errors'] == 0
    assert summary['reclaimed_ids'] == [job_id]
    assert ProcrastinateJob.objects.get(pk=job_id).status == 'todo'


@pytest.mark.django_db(transaction=True)
def test_health_reports_a_legacy_orphan_on_0005(schema_0005, settings):
    settings.JOB_RECLAIM_MIN_AGE_SECONDS = 120
    settings.JOB_LEASE_STALE_SECONDS = 60
    settings.JOB_RECLAIM_WORKER_HEARTBEAT_SECONDS = 60
    now = timezone.now()
    job_id = index_zpage.defer(zpage_id=920005)
    _mark_doing(job_id, now - timedelta(seconds=4500), _dead_worker(now))
    _legacy_lease(job_id, 'search.index_zpage', 'search',
                  last_beat_at=now - timedelta(seconds=4000))

    search = next(q for q in health.collect(now=now).queues
                  if q.queue == 'search')

    assert search.doing == 1
    assert search.orphaned == 1
