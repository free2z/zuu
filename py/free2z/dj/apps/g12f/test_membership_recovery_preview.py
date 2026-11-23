"""Synthetic, real-PostgreSQL preparation; no historical grant is authorized."""
from datetime import timedelta
import importlib.util
import json
import os
from pathlib import Path
import threading

import pytest
from django.db import DatabaseError, connection
from django.utils import timezone
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator, Subscription, SubscriptionContinuation
from dj.apps.g12f.models.creator import SUBSCRIPTION_PERIOD
from dj.apps.g12f.tasks import defer_renewal, renewal_queueing_lock
from dj.apps.ledger.models import Account, Transfer, TransferKey


spec = importlib.util.spec_from_file_location(
    'membership_recovery_preview', Path(__file__).resolve().parents[5]
    / 'scripts/free2z/membership_recovery_preview.py',
)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


@pytest.fixture
def terminal_job(creator_factory):
    fan, star = creator_factory(), creator_factory()
    sub = Subscription.objects.create(
        fan=fan, star=star, max_price=10,
        expires=timezone.now() - timedelta(days=1),
    )
    ProcrastinateJob.objects.all().delete()
    defer_renewal(sub.pk, sub.expires)
    job = ProcrastinateJob.objects.get(
        queueing_lock=renewal_queueing_lock(sub.pk, sub.expires))
    # Native status transitions produce real event-table records. They do
    # not manufacture a SQL refusal reason: that cause remains unverified.
    with connection.cursor() as cursor:
        cursor.execute("UPDATE procrastinate_jobs SET status='doing' WHERE id=%s", [job.pk])
        cursor.execute("UPDATE procrastinate_jobs SET status='failed' WHERE id=%s", [job.pk])
    return job, sub


def state():
    return {
        'memberships': list(Subscription.objects.order_by('pk').values()),
        'creators': list(Creator.objects.order_by('pk').values('id', 'tuzis', 'is_active')),
        'accounts': list(Account.objects.order_by('pk').values()),
        'transfers': list(Transfer.objects.order_by('pk').values()),
        'transfer_keys': list(TransferKey.objects.order_by('pk').values()),
        'continuations': list(SubscriptionContinuation.objects.order_by('pk').values()),
        'jobs': list(ProcrastinateJob.objects.order_by('pk').values()),
        'events': list(Event.objects.order_by('pk').values()),
    }


@pytest.mark.django_db(transaction=True)
def test_repeatable_preview_is_blocked_and_preserves_complete_state(terminal_job):
    job, sub = terminal_job
    before = state()

    first = tool.preview([job.pk, job.pk])
    second = tool.preview(previous=first)

    assert state() == before
    assert first['cohort_id'] == second['cohort_id']
    assert first['decision_id'] == second['decision_id']
    assert second['revalidation']['stale'] is False
    assert second['revalidation']['changed_job_ids'] == []
    assert first['ordinary_period_seconds'] == int(SUBSCRIPTION_PERIOD.total_seconds())
    assert first['receipt']['before_snapshot'] == first['receipt']['after_snapshot']
    assert first['can_apply'] is False
    assert first['rows'][0]['original_refusal'] == 'unverified'
    assert first['rows'][0]['conflicts'] == []
    assert first['rows'][0]['membership']['last_charged_at'] is None
    assert first['rows'][0]['membership']['max_price'] == '10'
    assert first['missing_dependencies'] == tool.DEPENDENCIES
    tool.validate_manifest(first)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('change, expected', [
    ('cancel', 'recurring_consent_cancelled'),
    ('fan_inactive', 'inactive_fan'),
    ('star_inactive', 'inactive_creator'),
    ('actor_epoch', None),
    ('purchase', 'charge_in_retained_job_history'),
    ('pending_job', 'renewal_job_pending_or_running'),
    ('continuation', 'continuation_in_retained_job_history'),
])
def test_revalidation_reports_changed_state_without_overwriting(
        terminal_job, change, expected):
    job, sub = terminal_job
    manifest = tool.preview([job.pk])
    if change == 'cancel':
        Subscription.objects.filter(pk=sub.pk).update(max_price=0)
    elif change == 'fan_inactive':
        Creator.objects.filter(pk=sub.fan_id).update(is_active=False)
    elif change == 'star_inactive':
        Creator.objects.filter(pk=sub.star_id).update(is_active=False)
    elif change == 'actor_epoch':
        Creator.objects.filter(pk=sub.fan_id).update(kt_account_epoch=sub.fan.kt_account_epoch + 1)
    elif change == 'purchase':
        sub.extend()
    elif change == 'pending_job':
        defer_renewal(sub.pk, sub.expires)
    else:
        SubscriptionContinuation.objects.create(
            subscription=sub, period_start=sub.expires,
            period_end=sub.expires + SUBSCRIPTION_PERIOD,
            refused_price=10, recurring_ceiling=10,
        )
    before = state()

    current = tool.preview(previous=manifest)

    assert state() == before
    assert current['can_apply'] is False
    assert current['cohort_id'] == manifest['cohort_id']
    assert current['decision_id'] != manifest['decision_id']
    assert current['revalidation']['stale'] is True
    assert current['revalidation']['changed_job_ids'] == [job.pk]
    if expected:
        assert expected in current['rows'][0]['conflicts']
    if change == 'purchase':
        assert {'current_entitlement_active', 'payment_in_retained_job_history',
                'subscription_transfer_in_retained_job_history'}.issubset(current['rows'][0]['conflicts'])


@pytest.mark.django_db(transaction=True)
def test_database_read_only_mode_rejects_an_accidental_writer(terminal_job, monkeypatch):
    job, sub = terminal_job
    before = state()

    def accidental_write(*args):
        Subscription.objects.filter(pk=sub.pk).update(max_price=0)

    monkeypatch.setattr(tool, '_snapshot', accidental_write)
    with pytest.raises(DatabaseError, match='read-only transaction'):
        tool.preview([job.pk])
    assert state() == before


@pytest.mark.django_db(transaction=True)
def test_missing_job_and_subscription_are_conflicts_not_grants(terminal_job):
    job, sub = terminal_job
    sub.delete()
    report = tool.preview([job.pk, job.pk + 10000])
    assert 'subscription_missing' in report['rows'][0]['conflicts']
    assert 'job_missing' in report['rows'][1]['conflicts']
    assert report['can_apply'] is False


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('field, value, expected', [
    ('task_name', 'synthetic.other_task', 'not_billing_membership_renewal'),
    ('queue_name', 'default', 'not_billing_membership_renewal'),
    ('status', 'succeeded', 'job_not_terminal_failed'),
    ('args', {'subscription_id': 1, 'sqlstate': '23514',
              'diagnostic': 'usage_daily_funding_limit'},
     'invalid_or_oversized_subscription_selector'),
    ('args', {'padding': 'x' * 5000}, 'invalid_or_oversized_subscription_selector'),
])
def test_job_status_or_untrusted_payload_never_proves_original_cause(
        terminal_job, field, value, expected):
    job, sub = terminal_job
    with connection.cursor() as cursor:
        # The field is selected only from the fixed parametrize inventory.
        cursor.execute(f'UPDATE procrastinate_jobs SET {field}=%s WHERE id=%s',
                       [json.dumps(value) if field == 'args' else value, job.pk])
    before = state()

    report = tool.preview([job.pk])

    assert report['can_apply'] is False
    assert report['rows'][0]['original_refusal'] == 'unverified'
    assert expected in report['rows'][0]['conflicts']
    assert 'padding' not in json.dumps(report)
    assert state() == before


@pytest.mark.django_db(transaction=True)
def test_concurrent_cancellation_is_not_mixed_into_a_repeatable_snapshot(
        terminal_job, monkeypatch):
    job, sub = terminal_job
    snapshot = tool._snapshot
    ran = False
    outcomes = []

    def cancel():
        try:
            Subscription.objects.filter(pk=sub.pk).update(max_price=0)
            outcomes.append('cancelled')
        finally:
            connection.close()

    def snapshot_then_cancel(*args):
        nonlocal ran
        rows = snapshot(*args)
        if not ran:
            ran = True
            thread = threading.Thread(target=cancel)
            thread.start()
            thread.join(timeout=10)
            assert not thread.is_alive(), 'read-only preview blocked cancellation'
        return rows

    with monkeypatch.context() as during:
        during.setattr(tool, '_snapshot', snapshot_then_cancel)
        manifest = tool.preview([job.pk])
    assert outcomes == ['cancelled']
    assert manifest['rows'][0]['membership']['max_price'] == '10'
    assert manifest['receipt']['before_snapshot'] == manifest['receipt']['after_snapshot']
    current = tool.preview(previous=manifest)
    assert current['revalidation']['stale'] is True
    assert 'recurring_consent_cancelled' in current['rows'][0]['conflicts']


@pytest.mark.django_db(transaction=True)
def test_purchase_before_final_failed_attempt_is_reported(terminal_job):
    from dj.apps.jobs.ops import ProcrastinateEvent

    job, sub = terminal_job
    with connection.cursor() as cursor:
        cursor.execute("UPDATE procrastinate_jobs SET status='doing' WHERE id=%s", [job.pk])
    sub.extend()
    with connection.cursor() as cursor:
        cursor.execute("UPDATE procrastinate_jobs SET status='failed' WHERE id=%s", [job.pk])
    last_failure = ProcrastinateEvent.objects.filter(job_id=job.pk, type='failed').order_by('-pk').first()
    assert sub.last_charged_at < last_failure.at
    before = state()

    report = tool.preview([job.pk])

    assert state() == before
    assert {'charge_in_retained_job_history', 'payment_in_retained_job_history',
            'subscription_transfer_in_retained_job_history'}.issubset(report['rows'][0]['conflicts'])
    assert report['can_apply'] is False


@pytest.mark.parametrize('ids', [[], [True], [-1], [2**63], list(range(1, 52))])
def test_selector_bounds_fail_before_database_access(ids):
    with pytest.raises(ValueError):
        tool._ids(ids)


@pytest.mark.parametrize('flag', ['--execute', '--apply', '--evidence'])
def test_cli_has_no_apply_or_unverified_evidence_ingestion(flag):
    with pytest.raises(SystemExit) as error:
        tool.main(['--job-id', '1', flag])
    assert error.value.code == 2


def test_cli_bootstrap_preserves_existing_worker_markers(monkeypatch, tmp_path, capsys):
    import django

    markers = ('PROCRASTINATE_ALIVE_FILE', 'PROCRASTINATE_DRAINING_FILE')
    paths = {}
    for name in markers:
        paths[name] = tmp_path / name
        paths[name].write_text('existing worker marker')
        monkeypatch.setenv(name, str(paths[name]))
    monkeypatch.setenv('DJANGO_SETTINGS_MODULE', 'pytest_settings')

    def startup():
        for name in markers:
            path = Path(os.environ[name])
            assert path.parent != tmp_path
            # Simulate the real app-ready worker-marker housekeeping.
            path.write_text('private marker')
            path.unlink()

    monkeypatch.setattr(django, 'setup', startup)
    monkeypatch.setattr(tool, 'preview', lambda *args, **kwargs: {'can_apply': False})
    assert tool.main(['--job-id', '1']) == 0
    assert json.loads(capsys.readouterr().out)['can_apply'] is False
    for name in markers:
        assert paths[name].read_text() == 'existing worker marker'
        assert os.environ[name] == str(paths[name])


@pytest.mark.django_db(transaction=True)
def test_manifest_corruption_or_fabricated_cause_is_rejected(terminal_job, tmp_path):
    job, sub = terminal_job
    manifest = tool.preview([job.pk])
    path = tmp_path / 'preview.json'
    path.write_text(json.dumps(manifest))
    assert tool.load_manifest(path) == manifest
    manifest['rows'][0]['original_refusal'] = 'usage_daily_funding_limit'
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='verified refusal claim'):
        tool.load_manifest(path)
    path.write_text('{"kind":1,"kind":2}')
    with pytest.raises(ValueError, match='duplicate'):
        tool.load_manifest(path)
    path.write_bytes(b' ' * (tool.MAX_MANIFEST_BYTES + 1))
    with pytest.raises(ValueError, match='byte bound'):
        tool.load_manifest(path)
