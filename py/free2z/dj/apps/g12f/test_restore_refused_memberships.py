"""Historical zero-charge membership restoration. Synthetic rows only."""
from datetime import datetime, timedelta
from decimal import Decimal
from io import StringIO
import json

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, transaction
from django.utils import timezone
from procrastinate.contrib.django.models import ProcrastinateJob

from dj.apps.events.models import Event
from dj.apps.g12f.models import Subscription, SubscriptionContinuation
from dj.apps.g12f.models.creator import SUBSCRIPTION_PERIOD, Creator
from dj.apps.g12f.tasks import RENEWAL_LEAD
from dj.apps.ledger.models import Transfer


def _jobs(sub):
    return ProcrastinateJob.objects.filter(
        task_name='g12f.renew_subscription',
        args={'subscription_id': sub.pk},
    )


def _membership(fan, star, *, expires=None, last_charged_at=None,
                max_price=None, keep_jobs=False):
    expires = expires if expires is not None else timezone.now() - timedelta(hours=1)
    if last_charged_at is None:
        last_charged_at = expires - timedelta(days=30)
    sub = Subscription.objects.create(
        fan=fan, star=star, expires=expires, last_charged_at=last_charged_at,
        max_price=star.member_price if max_price is None else max_price,
    )
    if not keep_jobs:
        _jobs(sub).delete()
    sub.refresh_from_db()
    return sub


def _row(sub):
    sub.refresh_from_db()
    return {
        'subscription_id': sub.pk,
        'fan_id': sub.fan_id,
        'star_id': sub.star_id,
        'expires': sub.expires.isoformat(),
        'last_charged_at': (
            None if sub.last_charged_at is None else sub.last_charged_at.isoformat()
        ),
        'max_price': format(sub.max_price, 'f'),
    }


def _file(tmp_path, subs, decision_id='synthetic-decision'):
    payload = {
        'decision_id': decision_id,
        'evidence_sha256': 'a' * 64,
        'memberships': [_row(sub) for sub in subs],
    }
    path = tmp_path / 'decision.json'
    path.write_text(json.dumps(payload), encoding='utf-8')
    return path


def _facts(sub):
    sub.refresh_from_db()
    sub.fan.refresh_from_db(fields=['tuzis'])
    sub.star.refresh_from_db(fields=['tuzis'])
    return {
        'expires': sub.expires,
        'last_charged_at': sub.last_charged_at,
        'max_price': sub.max_price,
        'continuations': sub.zero_charge_continuations.count(),
        'transfers': Transfer.objects.count(),
        'events': Event.objects.filter(
            type__in=['SUBSCRIPTION_RECEIVED', 'SUBSCRIPTION_SENT'],
        ).count(),
        'fan_tuzis': sub.fan.tuzis,
        'star_tuzis': sub.star.tuzis,
    }


def _invoke(path, *args):
    stdout = StringIO()
    call_command(
        'restore_refused_memberships', str(path), *args, stdout=stdout,
    )
    return json.loads(stdout.getvalue())


def _apply(path, decision_id='synthetic-decision'):
    return _invoke(path, '--apply', '--decision-id', decision_id)


def _pair(creator_factory, *, member_price=Decimal('10')):
    fan = creator_factory(tuzis=Decimal('1000'))
    star = creator_factory(tuzis=Decimal('1000'), member_price=member_price)
    return fan, star


@pytest.mark.django_db(transaction=True)
def test_dry_run_changes_nothing_and_reports_the_plan(
        creator_factory, tmp_path, monkeypatch):
    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    fan, star = _pair(creator_factory)
    sub = _membership(fan, star)
    before = _facts(sub)
    path = _file(tmp_path, [sub])

    receipt = _invoke(path)

    assert receipt['can_apply'] is True
    assert receipt['applied'] is False
    assert receipt['mode'] == 'dry_run'
    assert receipt['ledger_rows_created'] == 0
    assert receipt['evidence_sha256'] == 'a' * 64
    row = receipt['rows'][0]
    assert row['continuation_id'] is None
    assert row['conflicts'] == []
    assert datetime.fromisoformat(row['after']['expires']) == (
        before['expires'] + SUBSCRIPTION_PERIOD)
    assert datetime.fromisoformat(row['scheduled_renewal_at']) == (
        before['expires'] + SUBSCRIPTION_PERIOD - RENEWAL_LEAD)
    assert _facts(sub) == before
    assert not _jobs(sub).exists()


@pytest.mark.django_db(transaction=True)
def test_apply_once_advances_expiry_and_schedules_the_next_renewal(
        creator_factory, tmp_path, monkeypatch):
    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    fan_a, star = _pair(creator_factory)
    fan_b = creator_factory(tuzis=Decimal('1000'))
    subs = [_membership(fan_a, star), _membership(fan_b, star)]
    before = [_facts(sub) for sub in subs]
    path = _file(tmp_path, subs)

    receipt = _apply(path)

    assert receipt['applied'] is True
    assert receipt['can_apply'] is True
    assert receipt['ledger_rows_created'] == 0
    assert Transfer.objects.count() == before[0]['transfers']
    for sub, prior, row in zip(subs, before, receipt['rows']):
        sub.refresh_from_db()
        assert sub.expires == prior['expires'] + SUBSCRIPTION_PERIOD
        assert sub.last_charged_at == prior['last_charged_at']
        assert sub.max_price == prior['max_price']
        assert (sub.fan.tuzis, sub.star.tuzis) == (prior['fan_tuzis'], prior['star_tuzis'])
        audit = sub.zero_charge_continuations.get()
        assert audit.pk == row['continuation_id']
        assert (audit.period_start, audit.period_end) == (prior['expires'], sub.expires)
        assert audit.reason == 'usage_daily_funding_limit'
        scheduled = sub.expires - RENEWAL_LEAD
        assert datetime.fromisoformat(row['scheduled_renewal_at']) == scheduled
        job = _jobs(sub).get(status='todo')
        assert job.scheduled_at == scheduled
        assert job.scheduled_at > timezone.now() + timedelta(days=20)


@pytest.mark.django_db(transaction=True)
def test_second_apply_does_not_write(creator_factory, tmp_path, monkeypatch):
    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    fan, star = _pair(creator_factory)
    sub = _membership(fan, star)
    path = _file(tmp_path, [sub])
    first = _apply(path)
    sub.refresh_from_db()
    granted = _facts(sub)
    continuation_id = first['rows'][0]['continuation_id']

    with pytest.raises(CommandError, match='not eligible'):
        _apply(path)

    sub.refresh_from_db()
    assert _facts(sub) == granted
    assert list(sub.zero_charge_continuations.values_list('pk', flat=True)) == [
        continuation_id]
    assert _jobs(sub).filter(status='todo').count() == 1


@pytest.mark.django_db(transaction=True)
def test_one_conflict_blocks_both_rows(creator_factory, tmp_path, monkeypatch):
    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    fan_a, star = _pair(creator_factory)
    fan_b = creator_factory(tuzis=Decimal('1000'))
    eligible = _membership(fan_a, star)
    cancelled = _membership(fan_b, star, max_price=Decimal('0'))
    before = [_facts(eligible), _facts(cancelled)]
    path = _file(tmp_path, [eligible, cancelled])

    receipt = _invoke(path)

    assert receipt['can_apply'] is False
    assert receipt['applied'] is False
    assert receipt['rows'][0]['conflicts'] == []
    assert 'recurring_consent_cancelled' in receipt['rows'][1]['conflicts']
    with pytest.raises(CommandError, match='not eligible'):
        _apply(path)
    assert [_facts(eligible), _facts(cancelled)] == before
    assert SubscriptionContinuation.objects.count() == 0


@pytest.mark.django_db(transaction=True)
def test_new_expiry_still_in_the_past_blocks_the_batch(
        creator_factory, tmp_path, monkeypatch):
    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    fan_a, star = _pair(creator_factory)
    fan_b = creator_factory(tuzis=Decimal('1000'))
    eligible = _membership(fan_a, star)
    stale = _membership(fan_b, star, expires=timezone.now() - timedelta(days=31))
    before = [_facts(eligible), _facts(stale)]
    path = _file(tmp_path, [eligible, stale])

    receipt = _invoke(path)

    assert receipt['can_apply'] is False
    assert receipt['rows'][0]['eligible'] is True
    assert receipt['rows'][1]['conflicts'] == ['new_expiry_still_past']
    with pytest.raises(CommandError, match='not eligible'):
        _apply(path)
    assert [_facts(eligible), _facts(stale)] == before


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('blocker, expected', [
    ('cancelled', [
        'recurring_consent_cancelled', 'current_price_above_recurring_ceiling',
    ]),
    ('inactive_fan', ['inactive_fan']),
    ('inactive_creator', ['inactive_creator']),
    ('price_above_ceiling', ['current_price_above_recurring_ceiling']),
    ('member_price_nonpositive', ['member_price_missing_or_nonpositive']),
    ('already_active', ['current_entitlement_active']),
    ('pending_todo', ['renewal_job_pending_or_running']),
    ('pending_doing', ['renewal_job_pending_or_running']),
    ('continuation_exists', ['continuation_exists']),
    ('charge_at_boundary', ['charge_at_or_after_cycle_boundary']),
    ('payment_event', ['payment_event_at_or_after_cycle_boundary']),
])
def test_ineligible_state_blocks_without_writing(
        creator_factory, tmp_path, monkeypatch, blocker, expected):
    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    fan, star = _pair(creator_factory)
    kwargs = {}
    if blocker == 'already_active':
        kwargs['expires'] = timezone.now() + timedelta(days=10)
    elif blocker == 'charge_at_boundary':
        expires = timezone.now() - timedelta(hours=1)
        kwargs['expires'] = expires
        kwargs['last_charged_at'] = expires
    elif blocker in {'pending_todo', 'pending_doing'}:
        kwargs['keep_jobs'] = True
    sub = _membership(fan, star, **kwargs)
    if blocker == 'cancelled':
        Subscription.objects.filter(pk=sub.pk).update(max_price=0)
    elif blocker == 'inactive_fan':
        Creator.objects.filter(pk=fan.pk).update(is_active=False)
    elif blocker == 'inactive_creator':
        Creator.objects.filter(pk=star.pk).update(is_active=False)
    elif blocker == 'price_above_ceiling':
        Creator.objects.filter(pk=star.pk).update(member_price=Decimal('11'))
    elif blocker == 'member_price_nonpositive':
        Creator.objects.filter(pk=star.pk).update(member_price=0)
    elif blocker == 'pending_doing':
        assert _jobs(sub).filter(status='todo').update(status='doing') == 1
    elif blocker == 'continuation_exists':
        SubscriptionContinuation.objects.create(
            subscription=sub, period_start=sub.expires,
            period_end=sub.expires + SUBSCRIPTION_PERIOD,
            refused_price=star.member_price, recurring_ceiling=sub.max_price,
        )
    elif blocker == 'payment_event':
        event = Event.objects.create(
            type='SUBSCRIPTION_SENT', receiving_user=fan, contributor=fan,
            payee=star, amount=Decimal('10'),
        )
        Event.objects.filter(pk=event.pk).update(created_at=sub.expires)
    before = _facts(sub)
    path = _file(tmp_path, [sub])

    receipt = _invoke(path)

    assert receipt['can_apply'] is False
    assert receipt['rows'][0]['conflicts'] == expected
    with pytest.raises(CommandError, match='not eligible'):
        _apply(path)
    assert _facts(sub) == before


@pytest.mark.django_db(transaction=True)
def test_subscription_transfer_at_the_boundary_blocks(
        creator_factory, tmp_path, monkeypatch):
    from dj.apps.tuzis import ledger

    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    fan, star = _pair(creator_factory)
    sub = _membership(fan, star)
    ledger.transfer(fan, star, Decimal('1'), action='subscription')
    before = _facts(sub)
    assert before['transfers'] >= 1
    path = _file(tmp_path, [sub])

    receipt = _invoke(path)

    assert receipt['rows'][0]['conflicts'] == [
        'subscription_transfer_at_or_after_cycle_boundary']
    with pytest.raises(CommandError, match='not eligible'):
        _apply(path)
    assert _facts(sub) == before
    assert sub.zero_charge_continuations.count() == 0


@pytest.mark.django_db(transaction=True)
def test_apply_without_the_env_var_or_matching_id_writes_nothing(
        creator_factory, tmp_path, monkeypatch):
    fan, star = _pair(creator_factory)
    sub = _membership(fan, star)
    before = _facts(sub)
    path = _file(tmp_path, [sub])
    monkeypatch.delenv('MEMBERSHIP_RECOVERY_APPLY', raising=False)

    with pytest.raises(CommandError, match='MEMBERSHIP_RECOVERY_APPLY'):
        _apply(path)
    assert _facts(sub) == before

    for value in ('', '0', 'true', '1 '):
        monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', value)
        with pytest.raises(CommandError, match='MEMBERSHIP_RECOVERY_APPLY'):
            _apply(path)
        assert _facts(sub) == before

    monkeypatch.setenv('MEMBERSHIP_RECOVERY_APPLY', '1')
    with pytest.raises(CommandError, match='decision-id'):
        _invoke(path, '--apply', '--decision-id', 'other-decision')
    assert _facts(sub) == before
    assert SubscriptionContinuation.objects.count() == 0


@pytest.mark.django_db(transaction=True)
def test_refuses_to_run_inside_an_existing_transaction(
        creator_factory, tmp_path):
    fan, star = _pair(creator_factory)
    sub = _membership(fan, star)
    before = _facts(sub)
    path = _file(tmp_path, [sub])
    with transaction.atomic():
        with pytest.raises(CommandError, match='existing transaction'):
            _invoke(path)
    assert _facts(sub) == before
    assert connection.in_atomic_block is False


@pytest.mark.parametrize('payload, message', [
    ('[]', 'decision file fields are invalid'),
    ('{"decision_id":"a","decision_id":"b"}', 'duplicate JSON field'),
    ('{"decision_id":"bad id!","evidence_sha256":"' + ('a' * 64)
     + '","memberships":[{}]}', 'decision_id'),
])
def test_malformed_decision_exits_nonzero(tmp_path, payload, message):
    path = tmp_path / 'decision.json'
    path.write_text(payload, encoding='utf-8')
    with pytest.raises(CommandError, match=message):
        call_command('restore_refused_memberships', str(path))


def test_oversized_decision_is_refused(tmp_path):
    path = tmp_path / 'decision.json'
    path.write_bytes(b'{' + (b' ' * (1024 * 1024)))
    with pytest.raises(CommandError, match='1 MiB'):
        call_command('restore_refused_memberships', str(path))
