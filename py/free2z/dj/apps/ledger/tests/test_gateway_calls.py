"""Real PostgreSQL contract tests; no gateway account or live infrastructure."""
import json
import re
import uuid
from datetime import timedelta

import pytest
from django.db import DatabaseError, connection, transaction

from . import test_hold_foundation
from .test_hold_foundation import call

# Explicit local fixture exports; pytest resolves them by parameter name.
holder = test_hold_foundation.holder
ledger_third_party = test_hold_foundation.third_party

pytestmark = pytest.mark.django_db


@pytest.fixture
def third_party(ledger_third_party):
    return ledger_third_party[0]

REQUEST = {'model': 'review-model', 'requested_model': 'review-model', 'provider': 'review-provider',
           'catalog_version': 99999, 'metadata': {'lesson': 'quadratics'}}
COMPLETE = {'model': 'review-model', 'provider': 'review-provider', 'finish_reason': 'stop',
            'usage_source': 'provider', 'usage': {'input_tokens': 100, 'output_tokens': 20},
            'partial': False, 'error': None}


def value(result):
    return json.loads(result) if isinstance(result, str) else result


def rpc(name, *args):
    return {key: value(val) if key in ('record', 'context', 'gateway_context') and val is not None else val
            for key, val in call(name, *args).items()}


def new_id():
    with connection.cursor() as cursor:
        cursor.execute('SELECT ledger.uuid_v7()')
        return cursor.fetchone()[0]


def claim(holder, app, *, call_id=None, key='sdk-key', fingerprint='a'*64, epoch=None, generation=4, request=None):
    return rpc('call_claim', holder.public_id, app, holder.kt_account_epoch if epoch is None else epoch,
               generation, call_id or new_id(), key, fingerprint, json.dumps(REQUEST if request is None else request))


def read(holder, app, call_id, *, epoch=None, generation=4):
    return rpc('call_read', holder.public_id, app, holder.kt_account_epoch if epoch is None else epoch,
               generation, call_id)


def complete(holder, app, call_id, *, completion=None, no_hold=False, epoch=None, generation=4):
    return rpc('call_complete', holder.public_id, app, holder.kt_account_epoch if epoch is None else epoch,
               generation, call_id, json.dumps(COMPLETE if completion is None else completion), no_hold)


def hold(holder, app, call_id, *, attempt=0):
    return call('hold', holder.public_id, app, 10000, f'{call_id}:{attempt}', str(call_id), attempt,
                300, holder.kt_account_epoch, 4, 'review-model', 99999, '99999', 0,
                json.dumps({'provider': f'provider-{attempt}'}))


def test_claim_lost_response_recovers_same_call_and_changed_body_conflicts(holder, third_party):
    first = claim(holder, third_party)
    assert first['status'] == 'claimed' and first['context']['effective_markup_bps'] == 0
    replay = claim(holder, third_party)
    assert replay['status'] == 'pending' and replay['call_id'] == first['call_id']
    assert claim(holder, third_party, call_id=first['call_id'], key=None)['status'] == 'pending'
    assert claim(holder, third_party, fingerprint='b'*64)['status'] == 'conflict'
    refreshed_catalog = dict(REQUEST, catalog_version=100000, provider='new-provider', model='new-resolved-model')
    restored = claim(holder, third_party, request=refreshed_catalog)
    assert restored['status'] == 'pending' and restored['record']['request'] == REQUEST
    changed = dict(REQUEST, metadata={'lesson': 'different'})
    assert claim(holder, third_party, request=changed)['status'] == 'conflict'
    with connection.cursor() as cursor:
        cursor.execute('SELECT count(*) FROM ledger_gateway_call')
        assert cursor.fetchone() == (1,)
        cursor.execute('SELECT count(*) FROM ledger_hold')
        assert cursor.fetchone() == (0,)


def test_no_key_calls_are_distinct_but_same_uuid_is_recoverable(holder, third_party):
    a, b = claim(holder, third_party, key=None), claim(holder, third_party, key=None)
    assert a['call_id'] != b['call_id']
    assert claim(holder, third_party, call_id=a['call_id'], key=None)['call_id'] == a['call_id']


def bump_generation(app, to=5):
    """What revoke-and-re-consent, a scope reduction or refresh-token reuse
    each do to the projected grant (dj.apps.oidc.consent)."""
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_spend_cap SET grant_generation=%s WHERE app_id=%s', [to, app])


def counts():
    """``(calls, open holds, settled receipts)`` -- the double-charge check."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT (SELECT count(*) FROM ledger_gateway_call), (SELECT count(*) FROM ledger_hold), "
                       "(SELECT count(*) FROM ledger_ai_usage WHERE outcome='settled')")
        return cursor.fetchone()


def test_generation_bump_keeps_the_owners_call_recoverable_and_admits_nothing_new(holder, third_party):
    """. The pending call, its same-key replay and its receipt stay
    reachable by the owner through the same app -- whichever generation the
    token carries -- and the hold taken under the old generation settles
    exactly once. Nothing NEW is admitted under the superseded generation."""
    first = claim(holder, third_party)
    held = hold(holder, third_party, first['call_id'])
    bump_generation(third_party)
    assert claim(holder, third_party, key='another-key', fingerprint='b'*64)['status'] == 'revoked'
    assert hold(holder, third_party, first['call_id'], attempt=1)['status'] == 'revoked'
    for generation in (4, 5):
        assert read(holder, third_party, first['call_id'], generation=generation)['status'] == 'found'
        replay = claim(holder, third_party, generation=generation)
        assert (replay['status'], replay['call_id']) == ('pending', first['call_id'])
        by_id = claim(holder, third_party, call_id=first['call_id'], key=None, generation=generation)
        assert (by_id['status'], by_id['call_id']) == ('pending', first['call_id'])
    # The gateway settles with the identity it CAPTURED at admission (rs/crates/f2z-ai/src/meter.rs finalize).
    assert complete(holder, third_party, first['call_id'])['status'] == 'recorded'
    settled = call('settle', held['hold_id'], 10_000_000, json.dumps(COMPLETE))
    assert settled['status'] == 'settled' and settled['charged'] > 0
    for generation in (4, 5):
        receipt = read(holder, third_party, first['call_id'], generation=generation)['record']
        assert receipt['status'] == 'settled'
        assert receipt['settlement']['transfer_id'] == settled['transfer_id']
        replay = claim(holder, third_party, generation=generation)
        assert replay['status'] == 'replayed' and replay['record']['status'] == 'settled'
        # The context is the caller's standing under the generation it presented.
        assert replay['context']['status'] == ('revoked' if generation == 4 else 'ok')
    assert counts() == (1, 0, 1)


def test_superseded_credential_never_sees_work_admitted_under_a_later_generation(holder, third_party):
    """Refresh-token reuse bumps ``agen`` and the legitimate device carries
    on under the new generation (dj.apps.oidc.consent.bump_generation_for_reuse).
    The stolen chain's token may recover only what it was admitted for: the
    newer call is ``revoked`` to it by id and by key, and it cannot complete it."""
    old = claim(holder, third_party)
    bump_generation(third_party)
    later = claim(holder, third_party, key='later-key', fingerprint='b'*64, generation=5)
    assert later['status'] == 'claimed'
    assert read(holder, third_party, later['call_id'])['status'] == 'revoked'
    assert claim(holder, third_party, key='later-key', fingerprint='b'*64)['status'] == 'revoked'
    assert claim(holder, third_party, call_id=later['call_id'], key=None, fingerprint='b'*64)['status'] == 'revoked'
    assert complete(holder, third_party, later['call_id'], no_hold=True)['status'] == 'not_found'
    #... while the newer credential sees both, and the old one still sees its own.
    assert read(holder, third_party, later['call_id'], generation=5)['status'] == 'found'
    assert read(holder, third_party, old['call_id'], generation=5)['status'] == 'found'
    assert read(holder, third_party, old['call_id'])['status'] == 'found'
    assert counts() == (2, 0, 0)


def test_completion_accepts_only_the_captured_admission_identity(holder, third_party):
    """Least privilege: the settler is the only completer and it holds the
    captured identity. A current-epoch token of the same owner and app --
    the one that CAN read and replay the call -- cannot complete it."""
    first = claim(holder, third_party)
    bump_generation(third_party)
    assert read(holder, third_party, first['call_id'], generation=5)['status'] == 'found'
    assert complete(holder, third_party, first['call_id'], generation=5, no_hold=True)['status'] == 'not_found'
    assert read(holder, third_party, first['call_id'], generation=5)['record']['status'] == 'streaming'
    assert complete(holder, third_party, first['call_id'], no_hold=True)['status'] == 'recorded'
    assert complete(holder, third_party, first['call_id'], no_hold=True)['status'] == 'replayed'
    assert complete(holder, third_party, first['call_id'], generation=5, no_hold=True)['status'] == 'not_found'
    replay = claim(holder, third_party, generation=5)
    assert replay['status'] == 'replayed' and replay['record']['status'] == 'released'


def test_account_epoch_bump_refuses_old_tokens_but_never_strands_the_hold(holder, third_party):
    """Credential compromise / account reset: every lookup with the old
    epoch is refused, receipts included; a current-epoch token reads and
    replays the call; the hold taken before the bump still settles through
    the identity the gateway captured at admission."""
    first = claim(holder, third_party)
    held = hold(holder, third_party, first['call_id'])
    epoch = holder.kt_account_epoch
    with connection.cursor() as cursor:
        cursor.execute('UPDATE g12f_creator SET kt_account_epoch=kt_account_epoch+1 WHERE id=%s', [holder.pk])
    assert read(holder, third_party, first['call_id'])['status'] == 'revoked'
    assert claim(holder, third_party)['status'] == 'revoked'
    assert claim(holder, third_party, call_id=first['call_id'], key=None)['status'] == 'revoked'
    assert read(holder, third_party, first['call_id'], epoch=epoch+1)['status'] == 'found'
    replay = claim(holder, third_party, epoch=epoch+1)
    assert (replay['status'], replay['call_id']) == ('pending', first['call_id'])
    assert complete(holder, third_party, first['call_id'])['status'] == 'recorded'
    settled = call('settle', held['hold_id'], 10_000_000, json.dumps(COMPLETE))
    assert settled['status'] == 'settled'
    receipt = read(holder, third_party, first['call_id'], epoch=epoch+1)['record']
    assert receipt['status'] == 'settled' and receipt['settlement']['transfer_id'] == settled['transfer_id']
    assert read(holder, third_party, first['call_id'])['status'] == 'revoked'
    assert counts() == (1, 0, 1)


def test_null_identity_claims_fail_closed_for_recovery(holder, third_party):
    """Codex round 2: recovery no longer routes through
    ``gateway_identity``'s equality predicates, so a NULL app or generation
    must be refused here rather than compare to NULL and fall through to
    another app's record or a later-generation call."""
    old = claim(holder, third_party)
    bump_generation(third_party)
    later = claim(holder, third_party, key='later-key', fingerprint='b'*64, generation=5)
    for app, generation, call_id in [(third_party, None, later['call_id']), (None, 4, old['call_id']),
                                     (None, None, old['call_id'])]:
        assert read(holder, app, call_id, generation=generation) == {'status': 'revoked', 'record': None}
        with pytest.raises(DatabaseError, match='invalid gateway call claim'), transaction.atomic():
            claim(holder, app, call_id=call_id, key=None, fingerprint='b'*64, generation=generation)
        with pytest.raises(DatabaseError, match='invalid gateway call claim'), transaction.atomic():
            claim(holder, app, key='later-key', fingerprint='b'*64, generation=generation)
        with pytest.raises(DatabaseError, match='invalid gateway call completion'), transaction.atomic():
            complete(holder, app, call_id, generation=generation, no_hold=True)
    null_epoch = rpc('call_read', holder.public_id, third_party, None, 4, old['call_id'])
    assert null_epoch == {'status': 'revoked', 'record': None}
    assert counts() == (2, 0, 0)


def test_negative_control_0004_bodies_pin_recovery_to_the_admitted_generation(holder, third_party):
    """The 0005 rewind restores the generation-pinned lookups exactly, and
    under them the same steps strand the owner: the pre-bump token can
    neither reconcile nor replay its own pending call. The same steps flip
    with the 0005 bodies; completion is captured-identity-only under both."""
    from dj.apps.ledger.migrations._call_recovery import REVERSE_SQL
    first = claim(holder, third_party)
    bump_generation(third_party)

    def steps():
        return (read(holder, third_party, first['call_id'])['status'],
                claim(holder, third_party)['status'],
                complete(holder, third_party, first['call_id'], generation=5, no_hold=True)['status'])

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(REVERSE_SQL)
        assert steps() == ('revoked', 'revoked', 'not_found')
        transaction.set_rollback(True)
    assert steps() == ('found', 'pending', 'not_found')


def test_receipt_scope_and_claim_id_collision_never_expose_other_user_or_app(holder, third_party, creator_factory):
    from dj.apps.ledger import api
    first = claim(holder, third_party)
    other = creator_factory(tuzis=100)
    account = api.ensure_account(other.pk)
    app = uuid.uuid4()
    with connection.cursor() as cursor:
        cursor.execute('INSERT INTO ledger_app(id) VALUES(%s)', [app])
        cursor.execute('INSERT INTO ledger_spend_cap(app_id,account_id,cap_m2z,period,grant_generation) '
                       "VALUES(%s,%s,NULL,'total',4),(%s,%s,NULL,'total',4)",
                       [third_party, account, app, api.ensure_account(holder.pk)])
    for user, scoped_app in [(other, third_party), (holder, app)]:
        missing = read(user, scoped_app, first['call_id'])
        assert missing == {'status': 'not_found', 'record': None}
        collision = claim(user, scoped_app, call_id=first['call_id'])
        assert collision['status'] == 'conflict' and collision['record'] is None and collision['call_id'] is None
        assert complete(user, scoped_app, first['call_id'], no_hold=True)['status'] == 'not_found'
        assert claim(user, scoped_app)['status'] == 'claimed'


def test_models_context_distinguishes_consented_effective_markup_and_debt(holder, third_party):
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_app SET markup_bps=3000,approved_markup_bps=2000 WHERE id=%s', [third_party])
        cursor.execute('UPDATE ledger_spend_cap SET markup_bps=2500 WHERE app_id=%s', [third_party])
    ctx = rpc('gateway_context', holder.public_id, third_party, holder.kt_account_epoch, 4)['gateway_context']
    assert (ctx['consented_markup_bps'], ctx['effective_markup_bps'], ctx['available_milli_2z']) == (2500, 2000, 100000)
    with connection.cursor() as cursor:
        cursor.execute('UPDATE ledger_app SET approved_markup_bps=1000,frozen=true WHERE id=%s', [third_party])
    ctx = rpc('gateway_context', holder.public_id, third_party, holder.kt_account_epoch, 4)['gateway_context']
    assert ctx['effective_markup_bps'] == 1000 and ctx['frozen']
    from dj.apps.ledger import api
    api.clawback(holder.pk, 101500, 'sys:clearing_stripe', 'clawback', 'dispute', 'test', 'context', 'context-debt')
    ctx = rpc('gateway_context', holder.public_id, third_party, holder.kt_account_epoch, 4)['gateway_context']
    assert ctx['debt_milli_2z'] == 1500 and ctx['available_milli_2z'] == 0
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM ledger_spend_cap WHERE app_id=%s', [third_party])
    assert claim(holder, third_party)['status'] == 'revoked'


def test_settlement_receipt_is_ledger_derived_and_keeps_metadata(holder, third_party):
    first = claim(holder, third_party)
    held = hold(holder, third_party, first['call_id'])
    assert complete(holder, third_party, first['call_id'])['record']['status'] == 'settling'
    settled = call('settle', held['hold_id'], 10_000_000, json.dumps(COMPLETE))
    receipt = read(holder, third_party, first['call_id'])['record']
    assert receipt['status'] == 'settled'
    assert receipt['request']['metadata'] == REQUEST['metadata']
    assert receipt['attempts'][0]['provider'] == 'provider-0'
    assert receipt['settlement']['transfer_id'] == settled['transfer_id']
    assert receipt['settlement']['collected_milli_2z'] == settled['charged']
    assert receipt['settlement']['priced_milli_2z'] == settled['priced']
    assert claim(holder, third_party)['status'] == 'replayed'
    with pytest.raises(DatabaseError), transaction.atomic():
        complete(holder, third_party, first['call_id'], completion=dict(COMPLETE, charged_2z=999999))


def test_release_of_fallback_attempt_does_not_finish_call(holder, third_party):
    first = claim(holder, third_party)
    a = hold(holder, third_party, first['call_id'])
    call('release', a['hold_id'])
    assert read(holder, third_party, first['call_id'])['record']['status'] == 'streaming'
    b = hold(holder, third_party, first['call_id'], attempt=1)
    assert b['status'] == 'held'
    complete(holder, third_party, first['call_id'])
    call('settle', b['hold_id'], 10_000_000)
    receipt = read(holder, third_party, first['call_id'])['record']
    assert receipt['status'] == 'settled' and len(receipt['attempts']) == 2
    assert receipt['settlement']['hold_id'] == str(b['hold_id'])


def test_expiry_projects_released_receipt_and_retains_original_metadata(holder, third_party):
    first = claim(holder, third_party)
    held = hold(holder, third_party, first['call_id'])
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [held['hold_id']])
    assert call('expire_hold', held['hold_id'])['status'] == 'expired'
    receipt = read(holder, third_party, first['call_id'])['record']
    assert receipt['status'] == 'released'
    assert receipt['error'] == {'code': 'unavailable', 'message': 'hold expired unsettled'}
    assert receipt['request']['metadata'] == REQUEST['metadata']
    assert receipt['attempts'][0]['catalog_version'] == '99999'
    assert receipt['settlement']['collected_milli_2z'] == 0
    assert claim(holder, third_party)['status'] == 'replayed'


def test_expired_old_attempt_does_not_finalize_another_live_attempt(holder, third_party):
    first = claim(holder, third_party)
    a = hold(holder, third_party, first['call_id'])
    b = hold(holder, third_party, first['call_id'], attempt=1)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [a['hold_id']])
    call('expire_hold', a['hold_id'])
    assert read(holder, third_party, first['call_id'])['record']['status'] == 'streaming'
    complete(holder, third_party, first['call_id'])
    call('settle', b['hold_id'], 10_000_000)
    assert read(holder, third_party, first['call_id'])['record']['status'] == 'settled'


def test_key_reuse_after_24_hours_preserves_old_90_day_receipt(holder, third_party):
    first = claim(holder, third_party)
    complete(holder, third_party, first['call_id'], no_hold=True)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_gateway_idempotency SET expires_at=now()-interval '1 second'")
    second = claim(holder, third_party, fingerprint='b'*64)
    assert second['status'] == 'claimed' and second['call_id'] != first['call_id']
    assert read(holder, third_party, first['call_id'])['record']['status'] == 'released'
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_gateway_call SET created_at=now()-interval '91 days' WHERE id=%s", [first['call_id']])
    assert read(holder, third_party, first['call_id'])['status'] == 'not_found'
    assert call('cleanup_gateway_calls')['cleanup_gateway_calls'] == 1
    assert read(holder, third_party, second['call_id'])['status'] == 'found'


# The gateway restates this lifetime as `ledger::IDEMPOTENCY_KEY_LIFETIME`
# (free2z/zuu rs/crates/f2z-ai/src/ledger.rs) and derives its form-record TTL
# (`idempotency::RECORD_TTL`, 24 h 10 m) from it, so a record outlives the key
# row. Lengthening the lifetime here without zuu would silently reopen
# the window in which a same-key retry straddling a `child_directed` flip or a
# key rotation is charged twice; the gateway cannot see the change.
KEY_LIFETIME = timedelta(hours=24)
KEY_LIFETIME_PIN = (
    "call_claim's idempotency-key lifetime must stay 24 hours: free2z/zuu "
    "restates it as `ledger::IDEMPOTENCY_KEY_LIFETIME` (rs/crates/f2z-ai/src/ledger.rs) "
    "and its form-record TTL (`idempotency::RECORD_TTL`) must outlive it (#2670). "
    "Change both together, gateway first.")
KEY_EXPIRY = re.compile(
    r"INSERT INTO public\.ledger_gateway_idempotency\([^)]*\)\s*VALUES\((.*?)\)\s*ON CONFLICT", re.S)


def test_every_call_claim_body_keeps_idempotency_keys_24_hours():
    from dj.apps.ledger.migrations import _call_recovery, _gateway_calls
    bodies = {'0005 forward': _call_recovery.SQL, '0005 rewind': _call_recovery.REVERSE_SQL,
              '0004 forward': _gateway_calls.SQL}
    for name, body in bodies.items():
        values = KEY_EXPIRY.findall(body)
        assert len(values) == 1, f'{name}: {len(values)} idempotency-key inserts. {KEY_LIFETIME_PIN}'
        assert values[0].endswith("now()+interval '24 hours'"), f'{name}: {values[0]!r}. {KEY_LIFETIME_PIN}'


def test_installed_call_claim_keeps_idempotency_keys_24_hours(holder, third_party):
    first = claim(holder, third_party)
    with connection.cursor() as cursor:
        cursor.execute('SELECT expires_at-now() FROM ledger_gateway_idempotency WHERE call_id=%s',
                       [first['call_id']])
        (lifetime,) = cursor.fetchone()
    assert KEY_LIFETIME - timedelta(minutes=1) < lifetime <= KEY_LIFETIME, f'{lifetime}. {KEY_LIFETIME_PIN}'


def test_abandoned_pre_hold_claim_recovers_as_released(holder, third_party):
    first = claim(holder, third_party)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_gateway_call SET expires_at=now()-interval '1 second'")
    assert call('cleanup_gateway_calls')['cleanup_gateway_calls'] == 1
    receipt = read(holder, third_party, first['call_id'])['record']
    assert receipt['status'] == 'released' and receipt['settlement'] is None
    assert receipt['error']['code'] == 'unavailable'


def test_completion_is_immutable_and_cannot_claim_no_hold_after_an_attempt(holder, third_party):
    first = claim(holder, third_party)
    hold(holder, third_party, first['call_id'])
    assert complete(holder, third_party, first['call_id'], no_hold=True)['status'] == 'conflict'
    assert complete(holder, third_party, first['call_id'])['status'] == 'recorded'
    assert complete(holder, third_party, first['call_id'])['status'] == 'replayed'
    assert complete(holder, third_party, first['call_id'], completion=dict(COMPLETE, partial=True))['status'] == 'conflict'
    assert complete(holder, third_party, first['call_id'], no_hold=True)['status'] == 'conflict'
    with pytest.raises(DatabaseError), transaction.atomic():
        hold(holder, third_party, first['call_id'], attempt=1)


@pytest.mark.parametrize('request_meta', [dict(REQUEST, messages=[]), dict(REQUEST, metadata={'bad': {'nested': 1}}),
                                   dict(REQUEST, catalog_version=-1), dict(REQUEST, provider='x'*257)])
def test_content_and_invalid_metadata_refused(holder, third_party, request_meta):
    with pytest.raises(DatabaseError, match='invalid gateway call claim'), transaction.atomic():
        claim(holder, third_party, request=request_meta)


def test_gateway_grants_are_only_scoped_entry_points(holder, third_party):
    first = claim(holder, third_party)
    with connection.cursor() as cursor:
        cursor.execute("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                       "WHERE n.nspname='ledger' AND has_function_privilege(ledger.gateway_role_name(),p.oid,'EXECUTE')")
        assert {row[0] for row in cursor.fetchall()} == {
            'inquire', 'hold', 'extend', 'settle', 'release',
            'gateway_context', 'call_claim', 'call_complete', 'call_read','prepare_economic_policy'}
        from psycopg import sql
        cursor.execute('SELECT ledger.gateway_role_name()')
        cursor.execute(sql.SQL('SET LOCAL ROLE {}').format(sql.Identifier(cursor.fetchone()[0])))
    assert read(holder, third_party, first['call_id'])['status'] == 'found'
    for forbidden in ['SELECT * FROM ledger_gateway_call', 'SELECT * FROM ledger_gateway_attempt',
                      'SELECT * FROM ledger_gateway_idempotency', 'SELECT ledger.cleanup_gateway_calls()',
                      "SELECT ledger.call_envelope('00000000-0000-7000-8000-000000000000')"]:
        with pytest.raises(DatabaseError), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(forbidden)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('fingerprint, expected', [('a'*64, 'pending'), ('b'*64, 'conflict')])
def test_concurrent_key_claim_waits_and_never_creates_a_second_call(holder, third_party, fingerprint, expected):
    from concurrent.futures import ThreadPoolExecutor
    from queue import Queue
    from time import monotonic, sleep
    from django.db import connections
    backend = Queue()
    contender_id = new_id()

    def contender():
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout='10s'")
                cursor.execute('SELECT pg_backend_pid()')
                backend.put(cursor.fetchone()[0])
            return claim(holder, third_party, call_id=contender_id, fingerprint=fingerprint)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            first = claim(holder, third_party)
            future = pool.submit(contender)
            pid = backend.get(timeout=10)
            deadline = monotonic()+5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute('SELECT pg_backend_pid()=ANY(pg_blocking_pids(%s))', [pid])
                    blocked = cursor.fetchone()[0]
                if blocked:
                    break
                assert not future.done() and monotonic() < deadline
                sleep(.005)
        second = future.result(timeout=10)
    assert second['status'] == expected and second['call_id'] == first['call_id']
    with connection.cursor() as cursor:
        cursor.execute('SELECT id FROM ledger_gateway_call')
        assert cursor.fetchall() == [(first['call_id'],)]


def test_existing_expiry_worker_closes_abandoned_claim_without_new_lane(holder, third_party):
    from dj.apps.ledger import tasks
    first = claim(holder, third_party)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_gateway_call SET expires_at=now()-interval '1 second'")
    assert tasks.expire_holds.func()['calls_cleaned'] == 1
    assert read(holder, third_party, first['call_id'])['record']['status'] == 'released'


def test_metadata_retention_never_deletes_money_history(holder, third_party):
    first = claim(holder, third_party)
    held = hold(holder, third_party, first['call_id'])
    complete(holder, third_party, first['call_id'])
    receipt = call('settle', held['hold_id'], 10_000_000)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_gateway_call SET created_at=now()-interval '91 days'")
    assert call('cleanup_gateway_calls')['cleanup_gateway_calls'] == 1
    assert read(holder, third_party, first['call_id'])['status'] == 'not_found'
    with connection.cursor() as cursor:
        cursor.execute('SELECT charged,transfer_id FROM ledger_ai_usage WHERE hold_id=%s', [held['hold_id']])
        assert cursor.fetchone() == (receipt['charged'], receipt['transfer_id'])
        cursor.execute('SELECT amount FROM ledger_transfer WHERE id=%s', [receipt['transfer_id']])
        assert cursor.fetchone() == (receipt['charged'],)


def test_populated_metadata_migration_refuses_destructive_reverse(holder, third_party):
    from dj.apps.ledger.migrations._gateway_calls import REVERSE_SQL
    first = claim(holder, third_party)
    with pytest.raises(DatabaseError, match='retained call history exists'), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(REVERSE_SQL)
    assert read(holder, third_party, first['call_id'])['status'] == 'found'


def test_empty_metadata_schema_functions_can_rewind_without_touching_l2():
    from dj.apps.ledger.migrations._gateway_calls import REVERSE_SQL
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(REVERSE_SQL)
            cursor.execute("SELECT to_regprocedure('ledger.call_read(uuid,uuid,integer,integer,uuid)'), "
                           "to_regprocedure('ledger.settle(uuid,bigint,jsonb)') IS NOT NULL")
            assert cursor.fetchone() == (None, True)
        transaction.set_rollback(True)
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regprocedure('ledger.call_read(uuid,uuid,integer,integer,uuid)') IS NOT NULL")
        assert cursor.fetchone() == (True,)


def test_attempt_snapshot_cannot_store_nested_provider_content(holder, third_party):
    first = claim(holder, third_party)
    with pytest.raises(DatabaseError, match='invalid gateway attempt provider'), transaction.atomic():
        call('hold', holder.public_id, third_party, 10000, 'bad-provider', str(first['call_id']), 0,
             300, holder.kt_account_epoch, 4, 'review-model', 99999, '99999', 0,
             json.dumps({'provider': {'messages': ['must never be persisted here']}}))
    assert read(holder, third_party, first['call_id'])['record']['attempts'] == []
    with connection.cursor() as cursor:
        cursor.execute('SELECT held FROM ledger_account WHERE owner_id=%s AND kind=%s', [holder.pk, 'user'])
        assert cursor.fetchone() == (0,)


def test_maximum_metadata_characters_survive_multibyte_and_json_escaping(holder, third_party):
    metadata = {str(i)+'😀'*62: '\x01'*256 for i in range(16)}
    assert len(json.dumps(metadata).encode()) > 16384
    request_meta = dict(REQUEST, metadata=metadata)
    first = claim(holder, third_party, request=request_meta)
    assert first['status'] == 'claimed'
    assert read(holder, third_party, first['call_id'])['record']['request']['metadata'] == metadata
