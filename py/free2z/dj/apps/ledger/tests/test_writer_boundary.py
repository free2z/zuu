"""Real database protection against old writers across the activation epoch."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import threading

import psycopg
import pytest
from django.db import DatabaseError, connection, transaction

from dj.apps.ledger import api
from .conftest import account, key, one, sql, tuzis_of

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def clear_committed_probe_history(request, db):
    yield
    marker = request.node.get_closest_marker('django_db')
    if marker and marker.kwargs.get('transaction'):
        # Django flushes managed accounts, but not the partitioned journal.
        # These concurrency probes commit actual transfers; do not leave their
        # history behind for another module or a reused local test database.
        sql('TRUNCATE ledger_transfer, ledger_transfer_key')


def backfill():
    sql('SELECT ledger.ensure_account(id) FROM g12f_creator ORDER BY id')


def activate():
    sql('SELECT ledger.activate_writer_boundary()')


def test_activation_refuses_missing_accounts_drift_and_uncovered_holds(creator_factory):
    creator = creator_factory(tuzis=10)
    with pytest.raises(DatabaseError, match='incomplete'), transaction.atomic():
        activate()
    backfill()
    sql('UPDATE g12f_creator SET tuzis=9 WHERE id=%s', [creator.pk])
    with pytest.raises(DatabaseError, match='incomplete'), transaction.atomic():
        activate()
    sql('UPDATE g12f_creator SET tuzis=10 WHERE id=%s', [creator.pk])
    sql('UPDATE ledger_account SET held=11000 WHERE owner_id=%s', [creator.pk])
    with pytest.raises(DatabaseError, match='incomplete'), transaction.atomic():
        activate()
    assert one('SELECT writer_boundary,heal_enabled FROM ledger_config') == (False, True)


def test_activation_preserves_money_paths_but_rejects_legacy_writes(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=10)
    backfill()
    activate()
    assert one('SELECT writer_boundary,heal_enabled FROM ledger_config') == (True, False)
    sql('UPDATE ledger_account SET held=8000 WHERE owner_id=%s', [creator.pk])
    with pytest.raises(DatabaseError, match='unjournaled'), transaction.atomic():
        sql('UPDATE g12f_creator SET tuzis=1 WHERE id=%s', [creator.pk])
    with pytest.raises(DatabaseError, match='below holds'), transaction.atomic():
        sql('UPDATE ledger_account SET balance=1 WHERE owner_id=%s', [creator.pk])
    result = api.clawback(creator.pk, 5000, 'sys:clearing_stripe', 'clawback', 'dispute', 'stripe', 'fixture', key())
    assert (result.clawed, result.debt_added) == (2000, 3000)
    assert tuzis_of(creator) == Decimal('8')
    api.credit_user(creator.pk, 4000, 'sys:promo', 'grant', 'fixture', 'credit', key())
    assert tuzis_of(creator) == Decimal('9')
    sql('UPDATE ledger_account SET held=0 WHERE owner_id=%s', [creator.pk])
    assert api.spend(creator.pk, 1000, 'test').status == 'posted'
    assert tuzis_of(creator) == Decimal('8')
    assert_invariants()
    newcomer = creator_factory(tuzis=0)
    with pytest.raises(DatabaseError, match='unjournaled'), transaction.atomic():
        sql('UPDATE g12f_creator SET tuzis=1 WHERE id=%s', [newcomer.pk])
    api.credit_user(newcomer.pk, 1000, 'sys:promo', 'grant', 'fixture', 'new-credit', key())
    assert tuzis_of(newcomer) == Decimal('1')
    with pytest.raises(DatabaseError, match='start at zero'), transaction.atomic():
        creator_factory(tuzis=1)


@pytest.mark.parametrize('query', [
    'UPDATE ledger_config SET heal_enabled=true',
    'UPDATE ledger_config SET writer_boundary=false',
    'UPDATE ledger_config SET dual_write=false',
    'DELETE FROM ledger_config',
    'TRUNCATE ledger_config',
])
def test_active_boundary_cannot_be_removed_by_ordinary_writes(query):
    backfill()
    activate()
    with pytest.raises(DatabaseError, match='ledger boundary'), transaction.atomic():
        sql(query)


def test_activation_api_and_helpers_are_not_public():
    assert one("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
               "CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl "
               "WHERE n.nspname='ledger' AND p.proname LIKE '%boundary%' AND acl.grantee=0")[0] == 0


@pytest.mark.django_db(transaction=True)
def test_old_repeatable_read_snapshot_cannot_bypass_committed_activation(creator_factory):
    creator = creator_factory(tuzis=10)
    backfill()
    config = connection.settings_dict
    observed = threading.Event()
    activated = threading.Event()

    def stale_writer():
        with psycopg.connect(host=config['HOST'], port=config['PORT'], dbname=config['NAME'],
                             user=config['USER'], password=config['PASSWORD']) as conn:
            conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            assert conn.execute('SELECT writer_boundary FROM ledger_config').fetchone() == (False,)
            observed.set()
            assert activated.wait(10)
            try:
                conn.execute('UPDATE g12f_creator SET tuzis=1 WHERE id=%s', [creator.pk])
            except psycopg.errors.SerializationFailure:
                conn.rollback()
                return 'serialized'
            return 'bypassed'

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(stale_writer)
            assert observed.wait(10)
            activate()
            activated.set()
            assert future.result(timeout=10) == 'serialized'
        assert tuzis_of(creator) == Decimal('10')
        assert account(f'user:{creator.pk}')[1] == 10000
    finally:
        activated.set()
        # Trusted test DBA cleanup; never a production rollback recipe.
        sql('ALTER TABLE ledger_config DISABLE TRIGGER ledger_boundary_config_guard')
        try:
            sql('UPDATE ledger_config SET writer_boundary=false,heal_enabled=true')
        finally:
            sql('ALTER TABLE ledger_config ENABLE TRIGGER ledger_boundary_config_guard')


@pytest.mark.django_db(transaction=True)
def test_activation_waits_for_old_writer_then_refuses_its_drift(creator_factory):
    creator = creator_factory(tuzis=10)
    backfill()
    config = connection.settings_dict
    params = dict(host=config['HOST'], port=config['PORT'], dbname=config['NAME'],
                  user=config['USER'], password=config['PASSWORD'])
    waiting = threading.Event()
    activation_pid = []

    def cutover():
        with psycopg.connect(**params) as conn:
            activation_pid.append(conn.info.backend_pid)
            waiting.set()
            try:
                conn.execute('SET LOCAL lock_timeout = \'5s\'')
                conn.execute('SELECT ledger.activate_writer_boundary()')
            except psycopg.errors.RaiseException as exc:
                conn.rollback()
                return str(exc)
            return 'activated'

    with psycopg.connect(**params) as legacy:
        legacy.execute('UPDATE g12f_creator SET tuzis=9 WHERE id=%s', [creator.pk])
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(cutover)
            assert waiting.wait(5)
            # Actual lock observation proves the old writer is still in flight.
            import time
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                blocked = one('SELECT %s = ANY(pg_blocking_pids(%s))',
                              [legacy.info.backend_pid, activation_pid[0]])[0]
                if blocked:
                    break
                time.sleep(0.01)
            assert blocked
            legacy.commit()
            assert 'incomplete' in future.result(timeout=5)
    assert one('SELECT writer_boundary,heal_enabled FROM ledger_config') == (False, True)
    # Restore via the normal rollout heal, not an invented ledger adjustment.
    api.spend(creator.pk, 1000, 'heal-fixture')


@pytest.mark.django_db(transaction=True)
def test_cutover_does_not_invert_normal_creator_account_projection_locks(creator_factory):
    creator = creator_factory(tuzis=10)
    backfill()
    config = connection.settings_dict
    params = dict(host=config['HOST'], port=config['PORT'], dbname=config['NAME'],
                  user=config['USER'], password=config['PASSWORD'])
    ready = threading.Event()
    activation_pid = []

    def cutover():
        with psycopg.connect(**params) as conn:
            activation_pid.append(conn.info.backend_pid)
            ready.set()
            conn.execute("SET LOCAL lock_timeout='5s'")
            conn.execute('SELECT ledger.activate_writer_boundary()')
        return 'activated'

    try:
        with psycopg.connect(**params) as writer:
            writer.execute("SET LOCAL statement_timeout='8s'")
            writer.execute('SELECT ledger.lock_creator(%s)', [creator.pk])
            writer.execute('SELECT ledger.lock_account(%s,10)', [creator.pk])
            # Reproduce the table-lock state just before a normal transfer's
            # creator projection, without changing financial facts artificially.
            writer.execute('UPDATE ledger_account SET updated_at=updated_at WHERE owner_id=%s', [creator.pk])
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(cutover)
                assert ready.wait(5)
                import time
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    blocked = one('SELECT %s=ANY(pg_blocking_pids(%s))',
                                  [writer.info.backend_pid, activation_pid[0]])[0]
                    if blocked:
                        break
                    time.sleep(0.01)
                assert blocked
                row = writer.execute("SELECT * FROM ledger.spend(%s,1000,'fixture','',NULL)", [creator.pk]).fetchone()
                assert row[0] == 'posted'
                writer.commit()
                assert future.result(timeout=5) == 'activated'
        assert tuzis_of(creator) == Decimal('9')
        assert account(f'user:{creator.pk}')[1] == 9000
    finally:
        sql('ALTER TABLE ledger_config DISABLE TRIGGER ledger_boundary_config_guard')
        try:
            sql('UPDATE ledger_config SET writer_boundary=false,heal_enabled=true')
        finally:
            sql('ALTER TABLE ledger_config ENABLE TRIGGER ledger_boundary_config_guard')
