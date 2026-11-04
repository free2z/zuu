"""Real independent transactions: admission caps and stale-writer fence race."""
import threading

import psycopg
import pytest
from django.db import connection, transaction

from dj.apps.economy import services as money
from dj.apps.economy.models import EconomicPolicy, FundingReservation
from .test_foundation import activate_for_test, sql

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.ledger_drift_expected]


@pytest.fixture(autouse=True)
def isolated_epoch():
    EconomicPolicy.objects.get_or_create(id=True)
    yield
    # Isolated test-owner reset before Django flush. Production has no reset.
    sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
    try:
        sql('UPDATE economy_economicpolicy SET version=0,fenced=false')
    finally:
        sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
    sql('ALTER TABLE ledger_config DISABLE TRIGGER ledger_boundary_config_guard')
    try:
        sql('UPDATE ledger_config SET writer_boundary=false,heal_enabled=true')
    finally:
        sql('ALTER TABLE ledger_config ENABLE TRIGGER ledger_boundary_config_guard')
    sql('TRUNCATE ledger_transfer,ledger_ai_usage')


def race(*functions):
    barrier = threading.Barrier(len(functions))
    results = [None]*len(functions)
    def run(index):
        try:
            barrier.wait(timeout=10)
            results[index] = functions[index]()
        except Exception as exc:
            results[index] = exc
        finally:
            connection.close()
    threads = [threading.Thread(target=run, args=(i,)) for i in range(len(functions))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)
        assert not thread.is_alive(), 'economic writer deadlocked'
    return results


def test_concurrent_funding_cannot_overbook(creator_factory):
    creator = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    def reserve(key):
        return money.reserve_funding(recipient_id=creator.pk, purchaser_id=creator.pk,
            amount_m2z=120_000_000, sale_nusd=1_200_000_000_000, idempotency_key=key)
    results = race(lambda: reserve('race:1'), lambda: reserve('race:2'))
    assert sum(isinstance(item, FundingReservation) for item in results) == 1, results
    assert sum(isinstance(item, money.EconomicRefusal) for item in results) == 1, results
    assert FundingReservation.objects.count() == 1


def test_concurrent_same_reservation_is_replayed(creator_factory):
    creator = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    def reserve():
        return money.reserve_funding(recipient_id=creator.pk, purchaser_id=creator.pk,
            amount_m2z=1000, sale_nusd=10_000_000, idempotency_key='race:one-key')
    results = race(reserve, reserve)
    assert all(isinstance(item, FundingReservation) for item in results), results
    assert results[0].pk == results[1].pk
    assert FundingReservation.objects.count() == 1


def test_stale_writer_with_account_lock_refuses_policy_lock_instead_of_deadlocking(creator_factory):
    creator = creator_factory(tuzis=0)
    with transaction.atomic():
        activate_for_test()
    params = connection.get_connection_params()
    with psycopg.connect(**params) as fencer, psycopg.connect(**params) as writer:
        fencer.execute('BEGIN')
        fencer.execute('SELECT id FROM economy_economicpolicy WHERE id FOR UPDATE')
        writer.execute('BEGIN')
        writer.execute("SELECT set_config('free2z.economic_policy_version','1',true)")
        writer.execute('SELECT * FROM ledger.lock_creator(%s)', [creator.pk])
        # A stale path is already holding creator/account locks. Its central
        # guard cannot wait on an activation that needs those same locks.
        writer.execute("SET LOCAL statement_timeout='1s'")
        with pytest.raises(psycopg.errors.LockNotAvailable, match='could not obtain lock'):
            writer.execute("SELECT * FROM ledger.credit_user(%s,1000,'sys:promo','grant','fixture','stale','stale:fence')", [creator.pk])
        writer.rollback()
        fencer.rollback()
