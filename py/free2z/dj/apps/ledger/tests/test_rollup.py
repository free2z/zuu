"""Real PostgreSQL tests of queue handoff, rollback and collection splits."""
import pytest
from django.db import connection, transaction

from dj.apps.ledger import api, rollup
from .test_hold_foundation import FIRST_PARTY, call

pytestmark = pytest.mark.django_db


def seed_rollup():
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_rollup_state(name) VALUES('ai_rollup') ON CONFLICT DO NOTHING")
        cursor.execute('INSERT INTO ledger_app(id) VALUES(%s) ON CONFLICT DO NOTHING', [FIRST_PARTY])


def fixed_settlement(creator, key='fixed', amount=7000):
    seed_rollup()
    held = call('hold_internal', creator.public_id, FIRST_PARTY, 10000, key, key)
    call('settle_fixed', held['hold_id'], amount)


def clearing():
    with connection.cursor() as cursor:
        cursor.execute("SELECT coalesce(sum(CASE WHEN credit_account_id=ledger.sys('sys:ai_clearing') THEN amount ELSE -amount END),0) "
                       "FROM ledger_transfer WHERE credit_account_id=ledger.sys('sys:ai_clearing') OR debit_account_id=ledger.sys('sys:ai_clearing')")
        return cursor.fetchone()[0]


def test_fixed_settlement_rollup_skips_zero_provider_and_drains_once(creator_factory):
    creator = creator_factory(tuzis=100)
    fixed_settlement(creator)
    assert clearing() == 7000
    assert rollup.consume_split_batch() == 1
    assert clearing() == 0
    assert rollup.consume_split_batch() == 0


def test_batch_failure_restores_queue_and_transfers(creator_factory, monkeypatch):
    creator = creator_factory(tuzis=100)
    fixed_settlement(creator)
    real_post = api.post_transfer

    def fail_after_post(*args, **kwargs):
        real_post(*args, **kwargs)
        raise RuntimeError('crash after posting')

    with monkeypatch.context() as patch:
        patch.setattr(api, 'post_transfer', fail_after_post)
        with pytest.raises(RuntimeError, match='crash after posting'):
            rollup.consume_split_batch()
    assert clearing() == 7000
    assert rollup.consume_split_batch() == 1
    assert clearing() == 0


def test_developer_handoff_survives_crash_and_credits_exactly_once(creator_factory):
    creator, developer = creator_factory(tuzis=100), creator_factory(tuzis=0)
    fixed_settlement(creator)
    # A real collected receipt supplies clearing. Exercise phase-1 handoff
    # with an explicit split so phase-2 can be inspected before it is drained.
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_ai_split_queue SET developer_creator_id=%s,developer_m2z=2000,platform_m2z=5000', [developer.pk])
    assert rollup.consume_split_batch() == 1
    assert clearing() == 2000
    with pytest.raises(RuntimeError, match='crash before commit'), transaction.atomic():
        assert rollup.credit_developer(developer.pk) == 2000
        raise RuntimeError('crash before commit')
    developer.refresh_from_db()
    assert developer.tuzis == 0
    assert rollup.credit_developer(developer.pk) == 2000
    assert rollup.credit_developer(developer.pk) == 0
    developer.refresh_from_db()
    assert developer.tuzis == 2
    assert clearing() == 0


def test_negative_platform_split_posts_loss_in_reverse_direction(creator_factory):
    creator = creator_factory(tuzis=100)
    fixed_settlement(creator)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_ai_split_queue SET provider_m2z=10000,platform_m2z=-3000')
    assert rollup.consume_split_batch() == 1
    assert clearing() == 0
    with connection.cursor() as cursor:
        cursor.execute("SELECT amount FROM ledger_transfer WHERE debit_account_id=ledger.sys('sys:platform_revenue') AND credit_account_id=ledger.sys('sys:ai_clearing')")
        assert cursor.fetchone() == (3000,)


def test_worker_sweeps_expired_holds_and_drains_multiple_batches(creator_factory, monkeypatch):
    from dj.apps.ledger import tasks
    creator = creator_factory(tuzis=100)
    fixed_settlement(creator, 'first')
    fixed_settlement(creator, 'second')
    held = call('hold_internal', creator.public_id, FIRST_PARTY, 1000, 'expire', 'expire')
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [held['hold_id']])
    assert tasks.expire_holds.func()['expired'] == 1
    assert tasks.expire_holds.func()['expired'] == 0
    real_batch = rollup.consume_split_batch
    monkeypatch.setattr(rollup, 'consume_split_batch', lambda: real_batch(limit=1))
    assert tasks.ai_rollup.func() == {'status': 'completed', 'rows': 2, 'credited': 0, 'deferred': 0}
    assert clearing() == 0


def test_l2_invariants_detect_counter_receipt_and_backlog_corruption(creator_factory):
    from dj.apps.ledger import invariants
    creator = creator_factory(tuzis=100)
    fixed_settlement(creator)
    invariants.assert_l2()
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_account SET held=1 WHERE owner_id=%s AND kind='user'", [creator.pk])
    assert invariants.r4_held_equals_open_holds()
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_account SET held=0 WHERE owner_id=%s AND kind='user'", [creator.pk])
        cursor.execute("UPDATE ledger_ai_usage SET window_start=now()")
    assert invariants.r5_spend_windows_equal_holds_and_usage()
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_ai_usage SET window_start=NULL,transfer_id=NULL')
    assert invariants.r6_usage_receipts_and_splits()
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_ai_split_queue SET created_at=now()-interval '6 minutes'")
    assert invariants.r7_clearing_equals_queued_and_pending() == (7000, 7000, True)
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM ledger_ai_split_queue')
    assert invariants.r7_clearing_equals_queued_and_pending() == (7000, 0, False)


@pytest.mark.django_db(transaction=True)
def test_rollup_batch_uses_nowait_single_flight(creator_factory):
    from concurrent.futures import ThreadPoolExecutor
    from django.db import OperationalError, connections
    creator = creator_factory(tuzis=100)
    fixed_settlement(creator)

    def competing_batch():
        try:
            with pytest.raises(OperationalError):
                rollup.consume_split_batch()
        finally:
            connections.close_all()

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT name FROM ledger_rollup_state WHERE name='ai_rollup' FOR UPDATE")
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(competing_batch).result(timeout=10)
    assert rollup.consume_split_batch() == 1
    assert clearing() == 0


def test_developer_credit_repays_debt_before_spendable_balance(creator_factory):
    from dj.apps.ledger import invariants
    creator, developer = creator_factory(tuzis=100), creator_factory(tuzis=0)
    fixed_settlement(creator)
    api.clawback(developer.pk, 1500, 'sys:clearing_stripe', 'clawback', 'dispute', 'test', 'dev', 'dev-debt')
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_ai_split_queue SET developer_creator_id=%s,developer_m2z=2000,platform_m2z=5000', [developer.pk])
    assert rollup.consume_split_batch() == 1
    invariants.assert_l2()
    assert rollup.credit_developer(developer.pk) == 2000
    assert api.debt_m2z(developer.pk) == 0
    developer.refresh_from_db()
    assert developer.tuzis == pytest.approx(0.5)
    invariants.assert_l2()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('job', ['expire', 'rollup'])
def test_worker_skips_locked_creator_and_progresses_other_accounts(creator_factory, job):
    from concurrent.futures import ThreadPoolExecutor
    from django.db import connections
    from dj.apps.ledger import tasks
    blocked, available = creator_factory(tuzis=10), creator_factory(tuzis=10)
    seed_rollup()
    if job == 'expire':
        for creator in (blocked, available):
            held = call('hold_internal', creator.public_id, FIRST_PARTY, 1000, 'expiry', 'expiry')
            with connection.cursor() as cursor:
                cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [held['hold_id']])
        run = tasks.expire_holds.func
        measure, expected = 'expired', 1
    else:
        consumer = creator_factory(tuzis=100)
        for index, developer in enumerate((blocked, available)):
            fixed_settlement(consumer, str(index))
            with connection.cursor() as cursor:
                cursor.execute('UPDATE ledger_ai_split_queue SET developer_creator_id=%s,developer_m2z=2000,platform_m2z=5000 WHERE developer_creator_id IS NULL', [developer.pk])
            rollup.consume_split_batch()
        run = tasks.ai_rollup.func
        measure, expected = 'credited', 2000

    def worker():
        try:
            return run()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            api.lock_creator(blocked.pk)
            result = pool.submit(worker).result(timeout=8)
            assert result[measure] == expected
            assert result['deferred'] == 1
    assert run()[measure] == expected


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("fault", ["server_cancel", "pooler_drain"])
def test_pooler_cancelled_batch_retries_without_lost_or_duplicate_money(creator_factory, monkeypatch, fault):
    """Opt-in real transaction-pool transport, including a server cancellation."""
    import os
    import threading
    import time
    import subprocess
    import psycopg
    from django.db import OperationalError

    port = os.environ.get('LEDGER_TEST_POOLER_PORT')
    if not port:
        pytest.skip('requires the owned pinned PgBouncer transaction-pool fixture')
    container = os.environ.get('LEDGER_TEST_POOLER_CONTAINER')
    if fault == 'pooler_drain' and not container:
        pytest.skip('requires owned test pooler container for SIGINT drain')
    creator, developer = creator_factory(tuzis=100), creator_factory(tuzis=0)
    fixed_settlement(creator)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_ai_split_queue SET developer_creator_id=%s,provider_m2z=1000,'
                       'developer_m2z=2000,platform_m2z=4000', [developer.pk])
    config = connection.settings_dict
    direct = dict(host=config['HOST'], port=config['PORT'], dbname=config['NAME'],
                  user=config['USER'], password=config['PASSWORD'])
    connection.close()
    original_port = config['PORT']
    config['PORT'] = port
    cancelled = []
    drain_started = []
    threads = []
    real_post = api.post_transfer

    def cancel_after_actual_post(*args, **kwargs):
        result = real_post(*args, **kwargs)
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_backend_pid()')
            backend = cursor.fetchone()[0]
            def cancel_waiting_statement():
                with psycopg.connect(**direct, autocommit=True) as observer:
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        row = observer.execute('SELECT state,query FROM pg_stat_activity WHERE pid=%s', [backend]).fetchone()
                        if row and row[0] == 'active' and 'pg_sleep' in row[1]:
                            if fault == 'server_cancel':
                                cancelled.append(observer.execute('SELECT pg_cancel_backend(%s)', [backend]).fetchone()[0])
                            else:
                                drain_started.append(time.monotonic())
                                subprocess.run(['docker', 'kill', '--signal', 'INT', container], check=True, capture_output=True, timeout=5)
                                cancelled.append(True)
                            return
                        time.sleep(.01)
            worker = threading.Thread(target=cancel_waiting_statement)
            threads.append(worker)
            worker.start()
            cursor.execute('SELECT pg_sleep(20)')
        return result

    try:
        with monkeypatch.context() as patch:
            patch.setattr(api, 'post_transfer', cancel_after_actual_post)
            with pytest.raises(OperationalError) as failure:
                rollup.consume_split_batch()
        for worker in threads:
            worker.join(timeout=6)
            assert not worker.is_alive()
        assert cancelled == [True]
        if fault == 'pooler_drain':
            # No CancelRequest is sent. Server statement_timeout must abort
            # the in-flight transaction so SIGINT can finish its drain.
            assert isinstance(failure.value.__cause__, psycopg.errors.QueryCanceled)
            assert 'statement timeout' in str(failure.value)
            subprocess.run(['docker', 'wait', container], check=True, capture_output=True, timeout=6)
            assert time.monotonic() - drain_started[0] < 6
            subprocess.run(['docker', 'start', container], check=True, capture_output=True, timeout=6)
            connection.close()
            deadline = time.monotonic() + 5
            while True:
                try:
                    with psycopg.connect(**dict(direct, port=port), connect_timeout=1):
                        break
                except psycopg.OperationalError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(.05)
        assert clearing() == 7000
        assert rollup.consume_split_batch() == 1
        assert rollup.consume_split_batch() == 0
        assert clearing() == 2000
        assert rollup.credit_developer(developer.pk) == 2000
        assert rollup.credit_developer(developer.pk) == 0
        assert clearing() == 0
        developer.refresh_from_db()
        assert developer.tuzis == 2
        with connection.cursor() as cursor:
            cursor.execute("SELECT amount,count(*) FROM ledger_transfer WHERE code='ai_rollup' GROUP BY amount ORDER BY amount")
            assert cursor.fetchall() == [(1000, 1), (2000, 1), (4000, 1)]
    finally:
        for worker in threads:
            worker.join(timeout=6)
        connection.close()
        config['PORT'] = original_port
        if fault == 'pooler_drain' and cancelled:
            subprocess.run(['docker', 'start', container], check=True, capture_output=True, timeout=6)


def test_batch_aggregates_multiple_developers_and_existing_pending(creator_factory):
    creator = creator_factory(tuzis=100)
    first, second = creator_factory(tuzis=0), creator_factory(tuzis=0)
    for key in ('multi-a', 'multi-b', 'multi-c'):
        fixed_settlement(creator, key)
    with connection.cursor() as cursor:
        cursor.execute('SELECT usage_id FROM ledger_ai_split_queue ORDER BY usage_id')
        ids = [row[0] for row in cursor.fetchall()]
        for usage_id, developer in zip(ids, (second.pk, first.pk, second.pk)):
            cursor.execute('UPDATE ledger_ai_split_queue SET developer_creator_id=%s,developer_m2z=2000,platform_m2z=5000 WHERE usage_id=%s', [developer, usage_id])
    assert rollup.consume_split_batch(limit=1) == 1
    assert rollup.consume_split_batch() == 2
    with connection.cursor() as cursor:
        cursor.execute('SELECT developer_creator_id,amount_m2z FROM ledger_dev_markup_pending ORDER BY developer_creator_id')
        assert cursor.fetchall() == [(first.pk, 2000), (second.pk, 4000)]
    assert rollup.credit_developer(first.pk) == 2000
    assert rollup.credit_developer(second.pk) == 4000
    assert clearing() == 0
