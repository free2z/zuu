"""Exact pricing and money-storage invariants for the L2 hold lifecycle."""
import json
from pathlib import Path

import pytest
from django.db import DatabaseError, connection, transaction

pytestmark = pytest.mark.django_db
FIXTURES = Path(__file__).parents[2] / 'pricing/tests/fixtures/f2z_ai_proto/pricing'
CASES = [case for path in sorted(FIXTURES.glob('*.json'))
         for case in json.loads(path.read_text())['cases']]


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_sql_price_matches_every_shared_fixture(case):
    values, expected = case['input'], case['expected']
    with connection.cursor() as cursor:
        cursor.execute('SELECT * FROM ledger.price(%s, %s, %s, %s)', [
            values.get('cost_nusd', expected.get('cost_nusd')), values['platform_margin_bps'],
            values['dev_markup_bps'], values['min_charge_2z'],
        ])
        price, provider, dev_floor = cursor.fetchone()
    # The fixture's developer split is already capped by collection; exercise
    # the same cap without recomputing the pricing formula in Python.
    assert price == expected['total_milli']
    assert provider == expected['provider_milli']
    assert min(dev_floor, max(0, price - provider)) == expected['developer_milli']
    assert price - provider - min(dev_floor, max(0, price - provider)) == expected['platform_milli']


@pytest.mark.parametrize('args', [(-1, 2000, 0, 1), (1, -1, 0, 1), (1, 2000, 10001, 1),
                                (1, 2000, 0, -1), (None, 2000, 0, 1)])
def test_price_refuses_invalid_terms(args):
    with pytest.raises(DatabaseError), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SELECT * FROM ledger.price(%s, %s, %s, %s)', args)


@pytest.mark.parametrize('zone', ['UTC', 'Pacific/Auckland', 'America/New_York'])
def test_cap_windows_use_utc_even_on_pooled_sessions(zone):
    with connection.cursor() as cursor:
        cursor.execute("SELECT set_config('TimeZone', %s, true)", [zone])
        cursor.execute("SELECT extract(epoch from ledger.window_start('day', '2026-09-27 00:01:00+00')), "
                       "extract(epoch from ledger.window_start('total', '2026-09-27 00:01:00+00'))")
        day, total = cursor.fetchone()
    assert day == 1790467200
    assert total == 0


def test_l2_helpers_are_not_publicly_executable():
    with connection.cursor() as cursor:
        cursor.execute("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                       "WHERE n.nspname='ledger' AND EXISTS (SELECT 1 FROM "
                       "aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) acl "
                       "WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')")
        assert cursor.fetchall() == []

FIRST_PARTY = '00000000-0000-4000-8000-000000000001'


def call(name, *args):
    with connection.cursor() as cursor:
        cursor.execute(f'SELECT * FROM ledger.{name}(' + ','.join(['%s'] * len(args)) + ')', args)
        row = cursor.fetchone()
        return dict(zip([col[0] for col in cursor.description], row))


@pytest.fixture
def holder(creator_factory):
    return creator_factory(tuzis=100)


def reserve(holder, key='one', amount=10000):
    return call('hold_internal', holder.public_id, FIRST_PARTY, amount, key, key)


def test_hold_replay_extend_fixed_settle_and_release(holder):
    held = reserve(holder)
    assert (held['status'], held['available']) == ('held', 90000)
    replay = reserve(holder)
    assert replay['hold_id'] == held['hold_id'] and replay['status'] == 'replayed'
    grown = call('extend_internal', held['hold_id'], 15000)
    assert (grown['status'], grown['amount'], grown['available']) == ('held', 15000, 85000)
    assert call('extend_internal', held['hold_id'], 15000)['available'] == 85000
    assert call('extend_internal', held['hold_id'], 11000)['amount'] == 15000
    settled = call('settle_fixed', held['hold_id'], 7000)
    assert (settled['status'], settled['charged'], settled['available']) == ('settled', 7000, 93000)
    repeated = call('settle_fixed', held['hold_id'], 8000)
    assert repeated['charged'] == 7000 and repeated['transfer_id'] == settled['transfer_id']
    assert call('release', held['hold_id'])['status'] == 'settled'
    second = reserve(holder, 'two')
    assert call('release', second['hold_id'])['status'] == 'released'
    assert call('release', second['hold_id'])['status'] == 'released'


def test_expired_hold_is_not_revived_and_never_charged(holder):
    held = reserve(holder)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [held['hold_id']])
    expired = call('extend_internal', held['hold_id'], 15000)
    assert (expired['status'], expired['state']) == ('not_open', 'expired')
    settled = call('settle_fixed', held['hold_id'], 5000)
    assert (settled['status'], settled['charged']) == ('not_open', 0)
    assert reserve(holder)['state'] == 'expired'
    assert call('inquire', holder.public_id, FIRST_PARTY)['available'] == 100000


def test_missing_third_party_grant_fails_closed(holder):
    import uuid
    app = uuid.uuid4()
    with connection.cursor() as cursor:
        cursor.execute('INSERT INTO ledger_app(id) VALUES(%s)', [app])
    refused = call('hold_internal', holder.public_id, app, 1000, 'missing', 'missing')
    assert refused['status'] == 'revoked' and refused['hold_id'] is None

@pytest.fixture
def third_party(holder):
    import uuid
    from dj.apps.ledger import api
    from dj.apps.pricing.models import RateCard, RateCardModel
    from django.utils import timezone
    app = uuid.uuid4()
    account = api.ensure_account(holder.pk)
    card = RateCard.objects.create(version=99999)
    RateCardModel.objects.create(rate_card=card, model_id='review-model', **{field.name: 1 for field in RateCardModel._meta.fields if 'nusd' in field.name})
    RateCard.objects.filter(pk=card.pk).update(active=True, published_at=timezone.now())
    with connection.cursor() as cursor:
        cursor.execute('INSERT INTO ledger_app(id) VALUES(%s)', [app])
        cursor.execute("INSERT INTO ledger_spend_cap(app_id,account_id,cap_m2z,period,grant_generation) VALUES(%s,%s,20000,'total',4)", [app, account])
    return app, account, card


def gateway_hold(holder, third_party, key='first', amount=10000, generation=4):
    app, account, card = third_party
    return call('hold', holder.public_id, app, amount, key, 'call', 1, 300,
                holder.kt_account_epoch, generation, 'review-model', card.version)


def test_gateway_generation_cap_and_settlement(holder, third_party):
    assert gateway_hold(holder, third_party, generation=3)['status'] == 'revoked'
    held = gateway_hold(holder, third_party)
    assert held['status'] == 'held'
    assert gateway_hold(holder, third_party, 'over', 15000)['status'] == 'cap_exceeded'
    settled = call('settle', held['hold_id'], 150000000)
    assert (settled['charged'], settled['priced'], settled['shortfall']) == (18000, 18000, 0)
    assert settled['cap_remaining'] == 2000
    assert gateway_hold(holder, third_party, 'second')['state'] == 'settled'


def test_late_provider_expense_is_recorded_once(holder, third_party):
    held = gateway_hold(holder, third_party)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [held['hold_id']])
    first = call('settle', held['hold_id'], 19999)
    assert (first['status'], first['state'], first['charged']) == ('not_open', 'expired', 0)
    call('settle', held['hold_id'], 30000)
    with connection.cursor() as cursor:
        cursor.execute('SELECT provider_m2z,platform_m2z FROM ledger_ai_usage WHERE hold_id=%s', [held['hold_id']])
        assert cursor.fetchone() == (2, -2)
        cursor.execute('SELECT count(*) FROM ledger_ai_split_queue')
        assert cursor.fetchone()[0] == 1


def test_gateway_role_cannot_use_django_bypass(holder, third_party):
    with transaction.atomic():
        with connection.cursor() as cursor:
            from psycopg import sql
            cursor.execute('SELECT ledger.gateway_role_name()')
            cursor.execute(sql.SQL('SET LOCAL ROLE {}').format(sql.Identifier(cursor.fetchone()[0])))
        for name, args in [('hold_internal', (holder.public_id, FIRST_PARTY, 1000, 'x', 'x')),
                           ('hold', (holder.public_id, FIRST_PARTY, 1000, 'x', 'x')),
                           ('hold', (holder.public_id, third_party[0], 1000, 'x', 'x'))]:
            with pytest.raises(DatabaseError), transaction.atomic():
                call(name, *args)
        with pytest.raises(DatabaseError), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute('SELECT * FROM ledger_account')
        admitted = gateway_hold(holder, third_party)
        assert admitted['status'] == 'held'
        with pytest.raises(DatabaseError), transaction.atomic():
            call('expire_hold', admitted['hold_id'])


def test_settlement_heals_legacy_spend_before_collection(holder):
    held = reserve(holder, amount=8000)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE g12f_creator SET tuzis=4 WHERE id=%s', [holder.pk])
    result = call('settle_fixed', held['hold_id'], 7000)
    assert (result['status'], result['charged'], result['shortfall']) == ('settled', 4000, 3000)
    holder.refresh_from_db()
    assert holder.tuzis == 0


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('first', ['settle_fixed', 'release', 'expire_hold'])
@pytest.mark.parametrize('second', ['settle_fixed', 'release', 'expire_hold'])
@pytest.mark.parametrize('overdue', [False, True], ids=['live', 'expired'])
def test_terminal_races_serialize_and_preserve_one_receipt(holder, first, second, overdue):
    """Force each ordering while the first terminal result is still uncommitted.

    A simultaneous-start barrier cannot prove that the loser actually waited
    on the winner; observe PostgreSQL's blocker graph before releasing it.
    """
    from concurrent.futures import ThreadPoolExecutor
    from queue import Queue
    from time import monotonic, sleep
    from django.db import connections

    with connection.cursor() as cursor:
        cursor.execute('INSERT INTO ledger_app(id) VALUES(%s) ON CONFLICT DO NOTHING', [FIRST_PARTY])
    held = reserve(holder)
    hold_id = held['hold_id']
    if overdue:
        with connection.cursor() as cursor:
            cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [hold_id])
    backend = Queue()

    def invoke(operation, charge):
        return call(operation, hold_id, *([charge] if operation == 'settle_fixed' else []))

    def contender():
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout='10s'")
                cursor.execute('SELECT pg_backend_pid()')
                backend.put(cursor.fetchone()[0])
            return invoke(second, 8000)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            first_result = invoke(first, 7000)
            pending = pool.submit(contender)
            second_pid = backend.get(timeout=10)
            deadline = monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute('SELECT pg_backend_pid()=ANY(pg_blocking_pids(%s))', [second_pid])
                    blocked = cursor.fetchone()[0]
                if blocked:
                    break
                assert not pending.done(), 'contender completed before the first transaction committed'
                assert monotonic() < deadline, 'contender never waited for the first transaction'
                sleep(0.005)
        second_result = pending.result(timeout=10)

    # Expiry is a no-op for a live hold. Otherwise the first operation wins;
    # every operation on an overdue hold must expire it without collection.
    winner = second if first == 'expire_hold' and not overdue else first
    outcome = 'expired' if overdue else {'settle_fixed': 'settled', 'release': 'released',
                                        'expire_hold': 'open'}[winner]
    charged = (8000 if first == 'expire_hold' else 7000) if outcome == 'settled' else 0
    with connection.cursor() as cursor:
        cursor.execute('SELECT outcome,charged,transfer_id FROM ledger_ai_usage WHERE hold_id=%s', [hold_id])
        rows = cursor.fetchall()
        assert len(rows) == (0 if outcome == 'open' else 1)
        if rows:
            assert rows[0][:2] == (outcome, charged)
        cursor.execute("SELECT balance,held FROM ledger_account WHERE owner_id=%s AND kind='user'", [holder.pk])
        assert cursor.fetchone() == (100000-charged, 10000 if outcome == 'open' else 0)
        cursor.execute("SELECT count(*),coalesce(sum(amount),0) FROM ledger_transfer "
                       "WHERE code='ai_settle' AND ref_id=%s", [str(hold_id)])
        assert cursor.fetchone() == (int(charged > 0), charged)
    if outcome == 'settled':
        for operation, result in [(first, first_result), (second, second_result)]:
            if operation == 'settle_fixed':
                assert (result['status'], result['state'], result['charged'], result['transfer_id']) == (
                    'settled', 'settled', charged, rows[0][2])
    if outcome != 'open':
        replay = invoke('settle_fixed', 9000)
        assert replay['state'] == outcome and replay['charged'] == charged
        assert call('release', hold_id)['state'] == outcome
        assert call('expire_hold', hold_id)['released_m2z'] == 0


def test_extension_heals_legacy_spend_before_authorizing_more(holder):
    held = reserve(holder, amount=8000)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE g12f_creator SET tuzis=9 WHERE id=%s', [holder.pk])
    result = call('extend_internal', held['hold_id'], 12000)
    assert (result['status'], result['amount'], result['available']) == ('insufficient_balance', 8000, 1000)


@pytest.mark.parametrize('original,replacement', [('day', 'total'), ('total', 'day'), (None, 'total')])
def test_changed_cap_frame_refuses_extra_exposure_but_collects_reservation(holder, third_party, original, replacement):
    app, account, _ = third_party
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET period=%s,cap_m2z=%s WHERE app_id=%s', [original or 'day', 20000 if original else None, app])
    held = gateway_hold(holder, third_party, amount=8000)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET period=%s,cap_m2z=20000,cap_window_revision=1 WHERE app_id=%s', [replacement, app])
        cursor.execute('INSERT INTO ledger_spend_window(app_id,account_id,window_start,spent_m2z) VALUES(%s,%s,ledger.window_start(%s,now()),20000)', [app, account, replacement])
    extended = call('extend_internal', held['hold_id'], 10000)
    assert (extended['status'], extended['amount']) == ('cap_exceeded', 8000)
    settled = call('settle', held['hold_id'], 150000000)
    assert (settled['charged'], settled['shortfall']) == (8000, 10000)
    with connection.cursor() as cursor:
        cursor.execute('SELECT spent_m2z,held_m2z FROM ledger_spend_window WHERE app_id=%s AND window_start=ledger.window_start(%s,now())', [app, replacement])
        assert cursor.fetchone() == (28000, 0)
        cursor.execute('SELECT sum(held_m2z) FROM ledger_spend_window WHERE app_id=%s', [app])
        assert cursor.fetchone() == (0,)


def test_changed_frame_moves_entire_reservation_when_extension_fits(holder, third_party):
    app, account, _ = third_party
    held = gateway_hold(holder, third_party, amount=8000)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_spend_cap SET period='day',cap_window_revision=1 WHERE app_id=%s", [app])
    assert call('extend_internal', held['hold_id'], 12000)['status'] == 'held'
    with connection.cursor() as cursor:
        cursor.execute("SELECT held_m2z FROM ledger_spend_window WHERE app_id=%s AND window_start=ledger.window_start('total',now())", [app])
        assert cursor.fetchone() == (0,)
        cursor.execute("SELECT held_m2z FROM ledger_spend_window WHERE app_id=%s AND window_start=ledger.window_start('day',now())", [app])
        assert cursor.fetchone() == (12000,)
    assert call('release', held['hold_id'])['status'] == 'released'


def test_calendar_rollover_keeps_existing_reservation_frame(holder, third_party):
    app, account, _ = third_party
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_spend_cap SET period='day' WHERE app_id=%s", [app])
    held = gateway_hold(holder, third_party, amount=8000)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_spend_window SET window_start=window_start-interval '1 day' WHERE app_id=%s", [app])
        cursor.execute("UPDATE ledger_hold SET window_start=window_start-interval '1 day' WHERE id=%s", [held['hold_id']])
        cursor.execute("INSERT INTO ledger_spend_window(app_id,account_id,window_start,spent_m2z) VALUES(%s,%s,ledger.window_start('day',now()),20000)", [app, account])
    assert call('extend_internal', held['hold_id'], 12000)['status'] == 'held'
    result = call('settle', held['hold_id'], 150000000)
    assert result['charged'] == 18000
    with connection.cursor() as cursor:
        cursor.execute('SELECT spent_m2z,held_m2z FROM ledger_spend_window WHERE app_id=%s ORDER BY window_start', [app])
        assert cursor.fetchall() == [(18000, 0), (20000, 0)]


def test_schema_rollback_refuses_to_erase_economic_history(holder):
    from importlib import import_module
    reverse = import_module('dj.apps.ledger.migrations.0003_holds').REVERSE_SQL
    held = reserve(holder)
    call('settle_fixed', held['hold_id'], 7000)
    with pytest.raises(DatabaseError, match='rollback refused'), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(reverse)
    with connection.cursor() as cursor:
        cursor.execute('SELECT charged FROM ledger_ai_usage WHERE hold_id=%s', [held['hold_id']])
        assert cursor.fetchone() == (7000,)


def test_inquiry_projects_healing_without_writing(holder):
    from dj.apps.ledger import api
    account = api.ensure_account(holder.pk)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE g12f_creator SET tuzis=150 WHERE id=%s', [holder.pk])
    assert call('inquire', holder.public_id, FIRST_PARTY)['available'] == 150000
    with connection.cursor() as cursor:
        cursor.execute('SELECT balance FROM ledger_account WHERE id=%s', [account])
        assert cursor.fetchone() == (100000,)
        cursor.execute('UPDATE ledger_config SET heal_enabled=false')
    assert call('inquire', holder.public_id, FIRST_PARTY)['available'] == 100000


def test_gateway_reserved_shortfall_is_loud_after_heal_retirement(holder, third_party):
    held = gateway_hold(holder, third_party, amount=8000)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_config SET heal_enabled=false')
        cursor.execute('UPDATE ledger_account SET balance=4000 WHERE id=%s', [third_party[1]])
    with pytest.raises(DatabaseError, match='ledger_hold_shortfall'), transaction.atomic():
        call('settle', held['hold_id'], 150000000)
    with connection.cursor() as cursor:
        cursor.execute('SELECT amount FROM ledger_hold WHERE id=%s', [held['hold_id']])
        assert cursor.fetchone() == (8000,)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('first,second', [('settle', 'settle'), ('settle', 'expire_hold'), ('expire_hold', 'settle')])
def test_gateway_late_expense_races_record_one_cost_without_customer_charge(holder, third_party, first, second):
    """A paid provider can finish after expiry while the expiry worker races it."""
    from concurrent.futures import ThreadPoolExecutor
    from queue import Queue
    from time import monotonic, sleep
    from django.db import connections

    held = gateway_hold(holder, third_party)
    hold_id = held['hold_id']
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [hold_id])
    backend = Queue()

    def invoke(operation, cost):
        return call(operation, hold_id, *([cost] if operation == 'settle' else []))

    def contender():
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout='10s'")
                cursor.execute('SELECT pg_backend_pid()')
                backend.put(cursor.fetchone()[0])
            return invoke(second, 30000)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            first_result = invoke(first, 19999)
            pending = pool.submit(contender)
            pid = backend.get(timeout=10)
            deadline = monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute('SELECT pg_backend_pid()=ANY(pg_blocking_pids(%s))', [pid])
                    if cursor.fetchone()[0]:
                        break
                assert not pending.done(), 'second terminal action did not wait'
                assert monotonic() < deadline, 'second terminal action never blocked'
                sleep(0.005)
        second_result = pending.result(timeout=10)
    for operation, result in [(first, first_result), (second, second_result)]:
        if operation == 'settle':
            assert (result['status'], result['state'], result['charged']) == ('not_open', 'expired', 0)
    cost = 19999 if first == 'settle' else 30000
    provider = 2 if first == 'settle' else 3
    assert call('settle', hold_id, 50000)['charged'] == 0
    with connection.cursor() as cursor:
        cursor.execute('SELECT outcome,charged,cost_nusd,provider_m2z,platform_m2z,late_settle_attempted FROM ledger_ai_usage WHERE hold_id=%s', [hold_id])
        assert cursor.fetchall() == [('expired', 0, cost, provider, -provider, True)]
        cursor.execute('SELECT count(*),sum(q.provider_m2z),sum(q.platform_m2z) FROM ledger_ai_split_queue q JOIN ledger_ai_usage u ON u.id=q.usage_id WHERE u.hold_id=%s', [hold_id])
        assert cursor.fetchone() == (1, provider, -provider)
        cursor.execute("SELECT balance,held FROM ledger_account WHERE owner_id=%s AND kind='user'", [holder.pk])
        assert cursor.fetchone() == (100000, 0)
        cursor.execute("SELECT count(*) FROM ledger_transfer WHERE code='ai_settle' AND ref_id=%s", [str(hold_id)])
        assert cursor.fetchone() == (0,)
