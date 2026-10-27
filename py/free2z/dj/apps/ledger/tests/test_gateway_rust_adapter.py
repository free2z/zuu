"""Opt-in cross-repository acceptance; private fixture never ships with the SDK.

Build fixtures/gateway_adapter_probe.rs against the reviewed public f2z-ai crate,
then set F2Z_GATEWAY_RUST_PROBE to that executable. Normal CI avoids duplicating
Rust compilation; the existing SQL contract tests remain unconditional.
"""
import json
import os
import secrets
import selectors
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from django.db import connection, transaction
from psycopg import sql

from dj.apps.ledger import api
from . import test_hold_foundation

from dj.apps.economy.tests.test_integration import reset_isolated_policy as reset_isolated_policy

@pytest.fixture
def holder(creator_factory):
    actor=creator_factory(tuzis=0)
    api.credit_user(actor.pk,100000,'sys:promo','grant','rust-fixture',str(actor.pk),f'rust-fixture:{actor.pk}')
    return actor
third_party = test_hold_foundation.third_party
pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.skipif(
    not os.environ.get('F2Z_GATEWAY_RUST_PROBE'), reason='requires compiled public Rust adapter consumer')]


@pytest.mark.parametrize("policy_version",[0,1])
def test_actual_rust_adapter_against_restricted_postgres(holder, third_party, creator_factory, policy_version):
    executable = Path(os.environ['F2Z_GATEWAY_RUST_PROBE']).resolve(strict=True)
    app, account, _card = third_party
    other = creator_factory(tuzis=0)
    api.credit_user(other.pk,100000,"sys:promo","grant","rust-foreign",str(other.pk),f"rust-foreign:{other.pk}")
    other_account = api.ensure_account(other.pk)
    role = 'gateway_probe_' + uuid.uuid4().hex
    password = secrets.token_urlsafe(24)
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_spend_cap(app_id,account_id,cap_m2z,period,grant_generation) "
                       "VALUES(%s,%s,20000,'total',4)", [app, other_account])
        cursor.execute('SELECT ledger.uuid_v7(),ledger.uuid_v7()')
        call, other_call = cursor.fetchone()
        cursor.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(sql.Identifier(role), sql.Literal(password)))
        cursor.execute('SELECT ledger.gateway_role_name()')
        cursor.execute(sql.SQL('GRANT {} TO {}').format(sql.Identifier(cursor.fetchone()[0]), sql.Identifier(role)))
    if policy_version==1:
        from dj.apps.economy.tests.test_foundation import activate_for_test
        with transaction.atomic(): activate_for_test()
    settings = connection.settings_dict
    dsn = psycopg.conninfo.make_conninfo(host=settings['HOST'], port=settings['PORT'],
                                       dbname=settings['NAME'], user=role, password=password)
    # PostgreSQL URI is accepted by the public Rust adapter. All credentials here
    # are disposable local test values, never inherited production credentials.
    from urllib.parse import quote
    uri = f"postgresql://{role}:{quote(password)}@{settings['HOST']}:{settings['PORT']}/{settings['NAME']}"
    try:
        with psycopg.connect(dsn, autocommit=True) as restricted:
            assert restricted.execute("SELECT rolsuper FROM pg_roles WHERE rolname=current_user").fetchone() == (False,)
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                restricted.execute('SELECT 1 FROM ledger_account LIMIT 1')
        identity = dict(subject=str(holder.public_id), app=str(app),
                        account_epoch=holder.kt_account_epoch, grant_generation=4)
        foreign = dict(identity, subject=str(other.public_id), account_epoch=other.kt_account_epoch)
        env = dict(os.environ, F2Z_PG_PROBE_DSN=uri, F2Z_PG_PROBE_CASE=json.dumps(
            dict(identity=identity, foreign=foreign, call=str(call), other_call=str(other_call))))
        process = subprocess.Popen([str(executable)], env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                assert ready.select(timeout=30), 'adapter did not reach committed-hold barrier'
                assert process.stdout.readline().strip() == 'REVOKE_NOW'
            with connection.cursor() as cursor:
                cursor.execute('UPDATE ledger_spend_cap SET grant_generation=5 WHERE app_id=%s', [app])
            process.stdin.write('revoked\n')
            process.stdin.flush()
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                assert ready.select(timeout=30), 'adapter did not reach second-hold barrier'
                message = process.stdout.readline().strip().split()
                assert len(message) == 2 and message[0] == 'EXPIRE_NOW'
                expired_hold = uuid.UUID(message[1])
            with transaction.atomic(), connection.cursor() as cursor:
                from dj.apps.economy.epoch import pin_supported_policy
                pin_supported_policy()
                cursor.execute("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s", [expired_hold])
                cursor.execute('SELECT * FROM ledger.expire_hold(%s)', [expired_hold])
            stdout, stderr = process.communicate(input='expired\n', timeout=30)
            assert process.returncode == 0, stdout + stderr
            assert 'PASS actual restricted adapter' in stdout
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        with connection.cursor() as cursor:
            cursor.execute('SELECT balance,held FROM ledger_account WHERE id=%s', [account])
            assert cursor.fetchone() == (98000, 0)
            cursor.execute('SELECT outcome,count(*) FROM ledger_ai_usage WHERE account_id=%s GROUP BY outcome', [account])
            assert dict(cursor.fetchall()) == {'settled': 1, 'expired': 1}
            cursor.execute('SELECT provider_m2z,platform_m2z,charged FROM ledger_ai_usage WHERE hold_id=%s', [expired_hold])
            assert cursor.fetchone() == (1000, -1000, 0)
    finally:
        # Child process has exited and SQLx pools are closed before removing role.
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(role)))
