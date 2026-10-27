"""Real LOGIN authority, including copied function ACLs in another database."""
from datetime import datetime, timedelta, timezone
import os
import subprocess
import secrets
import uuid

import psycopg
from psycopg import sql
import pytest
from django.db import connection


@pytest.mark.django_db(transaction=True)
def test_gateway_login_cannot_use_another_database_even_with_copied_acls():
    config = connection.settings_dict
    admin_params = dict(host=config['HOST'], port=config['PORT'], dbname='postgres',
                        user=config['USER'], password=config['PASSWORD'])
    current_database = config['NAME']
    peer = 'ledger_peer_' + uuid.uuid4().hex
    login = 'ledger_login_' + uuid.uuid4().hex
    password = secrets.token_urlsafe(24)
    with connection.cursor() as cursor:
        cursor.execute('SELECT ledger.gateway_role_name(),current_user')
        group, owner = cursor.fetchone()
    # pg_dump preserves the source ACLs without requiring other test sessions
    # to disconnect. This exercises the same schema/ACL restore as dbcopy.
    pg_dump = [os.environ.get('LEDGER_TEST_PG_DUMP', 'pg_dump')]
    if os.environ.get('LEDGER_TEST_POSTGRES_CONTAINER'):
        pg_dump = ['docker', 'exec', '-e', 'PGPASSWORD', '-e', 'PGUSER',
                   '-e', 'PGHOST=127.0.0.1', '-e', 'PGPORT=5432',
                   os.environ['LEDGER_TEST_POSTGRES_CONTAINER'], 'pg_dump']
    dump = subprocess.run(pg_dump + ['--schema-only', '--no-owner', '--dbname', current_database],
        env=dict(os.environ, PGHOST=str(config['HOST']), PGPORT=str(config['PORT']),
                 PGUSER=config['USER'], PGPASSWORD=config['PASSWORD']),
        check=True, capture_output=True, text=True, timeout=60).stdout
    # New pg_dump clients wrap output for psql with these meta commands;
    # psycopg executes the SQL directly and has no psql command language.
    dump = '\n'.join(line for line in dump.splitlines()
                     if not line.startswith(('\\restrict ', '\\unrestrict ')))
    connection.close()
    destination_login = login + '_dst'
    created_database = created_login = created_destination_login = False
    with psycopg.connect(**admin_params, autocommit=True) as admin:
        try:
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(peer)))
            created_database = True
            with psycopg.connect(**dict(admin_params, dbname=peer), autocommit=True) as restored:
                restored.execute(dump, prepare=False)
                # The fixture copies schema only; a real dbcopy includes the
                # singleton's data. Missing policy deliberately fails closed.
                from dj.apps.economy.models import EconomicPolicy
                restored.execute(sql.SQL('INSERT INTO {}(id) VALUES(true)').format(
                    sql.Identifier('public', EconomicPolicy._meta.db_table)))
            admin.execute(sql.SQL('CREATE ROLE {} LOGIN INHERIT PASSWORD {} VALID UNTIL {}').format(
                sql.Identifier(login), sql.Literal(password), sql.Literal((datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat())))
            created_login = True
            admin.execute(sql.SQL('GRANT {} TO {}').format(sql.Identifier(group), sql.Identifier(login)))
            params = dict(admin_params, user=login, password=password)
            with psycopg.connect(**dict(params, dbname=current_database), autocommit=True) as own:
                assert set(own.execute("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                    "WHERE n.nspname='ledger' AND has_function_privilege(current_user,p.oid,'EXECUTE')").fetchall()) == {
                        ('inquire',), ('hold',), ('extend',), ('settle',), ('release',),
                        ('gateway_context',), ('call_claim',), ('call_complete',), ('call_read',),('prepare_economic_policy',)}
                with own.transaction():
                    assert own.execute('SELECT ledger.prepare_economic_policy(0,1)').fetchone()==(0,)
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    own.execute('SELECT ledger.gateway_context_economic_v0(%s,%s,0,0)',[uuid.uuid4(),uuid.uuid4()])
                assert own.execute('SELECT * FROM ledger.inquire(%s,%s)', [uuid.uuid4(), uuid.uuid4()]).fetchall() == []
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    own.execute(sql.SQL('SET ROLE {}').format(sql.Identifier(owner)))
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    own.execute('SELECT * FROM ledger_account')
            with psycopg.connect(**dict(params, dbname=peer), autocommit=True) as foreign:
                assert foreign.execute('SELECT current_database()').fetchone()[0] == peer
                # Deliberately retain copied ACLs. CONNECT/schema/function
                # privileges alone would incorrectly authorize this LOGIN.
                assert foreign.execute("SELECT has_schema_privilege(current_user,'ledger','USAGE'),"
                    "has_function_privilege(current_user,'ledger.inquire(uuid,uuid)','EXECUTE')").fetchone() == (True, True)
                with pytest.raises(psycopg.errors.InsufficientPrivilege, match='different database'):
                    foreign.execute('SELECT * FROM ledger.inquire(%s,%s)', [uuid.uuid4(), uuid.uuid4()])
                for statement, arguments in [
                    ('SELECT ledger.gateway_context(%s,%s,0,0)', [uuid.uuid4(), uuid.uuid4()]),
                    ('SELECT * FROM ledger.call_read(%s,%s,0,0,%s)', [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]),
                    ("SELECT * FROM ledger.call_claim(%s,%s,0,0,%s,NULL,NULL,'{}'::jsonb)", [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]),
                    ("SELECT ledger.call_complete(%s,%s,0,0,%s,'{}'::jsonb,false)", [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]),
                ]:
                    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='different database'):
                        foreign.execute(statement, arguments)
            # Match dbcopy: owner configures the FINAL identity while the copy
            # is private, then renames it before destination traffic connects.
            final_name = peer + '_final'
            with psycopg.connect(**dict(admin_params, dbname=peer), autocommit=True) as copied:
                copied.execute('SELECT ledger.configure_gateway_role(%s)', [final_name])
            admin.execute(sql.SQL('ALTER DATABASE {} RENAME TO {}').format(sql.Identifier(peer), sql.Identifier(final_name)))
            peer = final_name
            with psycopg.connect(**dict(admin_params, dbname=peer), autocommit=True) as copied:
                destination_group = copied.execute('SELECT ledger.gateway_role_name()').fetchone()[0]
            admin.execute(sql.SQL('CREATE ROLE {} LOGIN INHERIT PASSWORD {}').format(
                sql.Identifier(destination_login), sql.Literal(password)))
            created_destination_login = True
            admin.execute(sql.SQL('GRANT {} TO {}').format(sql.Identifier(destination_group), sql.Identifier(destination_login)))
            with psycopg.connect(**dict(params, user=destination_login, dbname=peer), autocommit=True) as destination:
                assert destination.execute('SELECT * FROM ledger.inquire(%s,%s)', [uuid.uuid4(), uuid.uuid4()]).fetchall() == []
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    destination.execute('SELECT ledger.configure_gateway_role(%s)', [current_database])
            with psycopg.connect(**dict(params, dbname=peer), autocommit=True) as foreign:
                with pytest.raises(psycopg.errors.InsufficientPrivilege, match='different database'):
                    foreign.execute('SELECT * FROM ledger.inquire(%s,%s)', [uuid.uuid4(), uuid.uuid4()])
                for statement, arguments in [
                    ('SELECT ledger.gateway_context(%s,%s,0,0)', [uuid.uuid4(), uuid.uuid4()]),
                    ('SELECT * FROM ledger.call_read(%s,%s,0,0,%s)', [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]),
                    ("SELECT * FROM ledger.call_claim(%s,%s,0,0,%s,NULL,NULL,'{}'::jsonb)", [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]),
                    ("SELECT ledger.call_complete(%s,%s,0,0,%s,'{}'::jsonb,false)", [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]),
                ]:
                    with pytest.raises(psycopg.errors.InsufficientPrivilege, match='different database'):
                        foreign.execute(statement, arguments)
        finally:
            if created_database:
                admin.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(peer)))
            if created_destination_login:
                admin.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(destination_login)))
            if created_login:
                admin.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(login)))
