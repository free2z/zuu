"""Actual PostgreSQL transport waits with server timeouts deliberately disabled."""
import time
import os
import threading

import pytest
from django.db import DatabaseError, connection, connections

from .recovery_db import recovery_database

pytestmark = pytest.mark.django_db(transaction=True)


def terminate_test_backend(pid, params):
    # Closing the client need not stop a query already executing on the server.
    wrapper = connections['default']
    if (wrapper.connection is not None and not wrapper.connection.closed
            and wrapper.connection.info.backend_pid == pid):
        wrapper.close()
    with connection.Database.connect(**params) as other:
        other.execute('SELECT pg_terminate_backend(%s)', [pid])


@pytest.mark.parametrize('phase', ['setup', 'body', 'commit', 'initialization'])
def test_client_deadline_covers_entire_operation_and_reconnects(phase, monkeypatch):
    from . import recovery_db
    monkeypatch.setattr(recovery_db, 'CLIENT_TIMEOUT_SECONDS', 2.1 if phase == 'initialization' else .25)
    wrapper = connections['default']
    wrapper.ensure_connection()
    params = wrapper.get_connection_params()
    original_hook = wrapper.get_new_connection
    pids = []
    closers = []

    def stall():
        pids.append(wrapper.connection.info.backend_pid)
        original_close = wrapper.connection.close
        def owner_close():
            closers.append(threading.get_ident())
            original_close()
        monkeypatch.setattr(wrapper.connection, 'close', owner_close)
        wrapper.connection.execute("SET statement_timeout='0'")
        wrapper.connection.execute('SELECT pg_sleep(4)' if phase == 'initialization' else 'SELECT pg_sleep(2)')

    def first_settings(execute, sql, params, many, context):
        if not pids:
            stall()
        return execute(sql, params, many, context)

    if phase == 'commit':
        original_commit = wrapper._commit
        def commit():
            stall()
            original_commit()
        monkeypatch.setattr(wrapper, '_commit', commit)
    if phase == 'initialization':
        wrapper.close()
        original_init = wrapper.init_connection_state
        def initialize():
            stall()
            original_init()
        monkeypatch.setattr(wrapper, 'init_connection_state', initialize)
    started = time.monotonic()
    try:
        with pytest.raises((DatabaseError, TimeoutError)):
            if phase == 'setup':
                with wrapper.execute_wrapper(first_settings), recovery_database():
                    pass
            else:
                with recovery_database():
                    if phase == 'body':
                        stall()
        assert time.monotonic() - started < (3.5 if phase == 'initialization' else 1.5)
        assert pids and wrapper.connection is None
        assert closers and set(closers) == {threading.get_ident()}
        assert wrapper.get_new_connection == original_hook
        assert not hasattr(wrapper, '_dyte_recovery_deadline')
    finally:
        if pids:
            terminate_test_backend(pids[0], params)
    monkeypatch.undo()
    with recovery_database():
        with wrapper.cursor() as cursor:
            cursor.execute('SELECT 42')
            assert cursor.fetchone() == (42,)
    replacement = wrapper.connection
    time.sleep(.3)
    assert wrapper.connection is replacement and not replacement.closed


def test_nested_work_shares_owner_and_restores_settings():
    wrapper = connections['default']
    with wrapper.cursor() as cursor:
        cursor.execute("SELECT current_setting('statement_timeout'),current_setting('lock_timeout')")
        previous = cursor.fetchone()
    with recovery_database():
        owner = wrapper._dyte_recovery_deadline
        hook = wrapper.get_new_connection
        with recovery_database(timeout_ms=100):
            assert wrapper._dyte_recovery_deadline == owner
            assert wrapper.get_new_connection is hook
        assert wrapper._dyte_recovery_deadline == owner
    with wrapper.cursor() as cursor:
        cursor.execute("SELECT current_setting('statement_timeout'),current_setting('lock_timeout')")
        assert cursor.fetchone() == previous


def test_successful_timer_is_joined_before_a_replacement_can_be_used(monkeypatch):
    from . import recovery_db
    monkeypatch.setattr(recovery_db, 'CLIENT_TIMEOUT_SECONDS', .25)
    wrapper = connections['default']
    wrapper.ensure_connection()
    with recovery_database():
        original = wrapper.connection
    wrapper.close()
    wrapper.ensure_connection()
    replacement = wrapper.connection
    assert replacement is not original
    time.sleep(.35)
    with wrapper.cursor() as cursor:
        cursor.execute('SELECT 42')
        assert cursor.fetchone() == (42,)


def test_connection_failure_restores_scoped_hook_and_deadline(monkeypatch):
    wrapper = connections['default']
    wrapper.close()
    params_seen = []
    def refused(params):
        params_seen.append(params)
        raise DatabaseError('synthetic connection refusal')
    with monkeypatch.context() as scoped:
        scoped.setattr(wrapper, 'get_new_connection', refused)
        with pytest.raises(DatabaseError, match='synthetic connection refusal'), recovery_database():
            pass
        assert 0 < params_seen[0]['connect_timeout'] <= 10
        assert wrapper.get_new_connection is refused
        assert not hasattr(wrapper, '_dyte_recovery_deadline')


def test_cold_dns_timeout_kills_and_reaps_only_resolver_child(monkeypatch, tmp_path):
    from . import recovery_db
    marker = tmp_path/'resolver.pid'
    code = f'import os,time;open({str(marker)!r},"w").write(str(os.getpid()));time.sleep(20)'
    monkeypatch.setattr(recovery_db, 'DNS_RESOLVER_CODE', code)
    started = time.monotonic()
    with pytest.raises(DatabaseError, match='resolution unavailable'):
        recovery_db._connection_attempts({'host':'synthetic.invalid'}, started+.3)
    assert time.monotonic()-started < 1.5
    pid = int(marker.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    monkeypatch.undo()
    attempts = recovery_db._connection_attempts({'host':'localhost'}, time.monotonic()+3)
    assert attempts and all(row['host']=='localhost' and row['hostaddr'] for row in attempts)


def test_acquisition_preserves_hostname_and_refuses_insufficient_budget(monkeypatch):
    from . import recovery_db
    wrapper = connections['default']
    wrapper.close()
    calls = []
    def acquire(params):
        calls.append(dict(params))
        raise wrapper.Database.OperationalError('synthetic refused address')
    monkeypatch.setattr(wrapper, 'get_new_connection', acquire)
    monkeypatch.setattr(recovery_db, '_connection_attempts', lambda params, deadline:
        [dict(params, host='synthetic.invalid', hostaddr=ip) for ip in ('127.0.0.1','127.0.0.2')])
    try:
        with pytest.raises(TimeoutError, match='acquisition budget'), recovery_database(deadline=time.monotonic()+.5):
            pass
        assert calls == []
        with pytest.raises(DatabaseError, match='connection unavailable'), recovery_database():
            pass
        assert [row['hostaddr'] for row in calls] == ['127.0.0.1','127.0.0.2']
        assert all(row['host']=='synthetic.invalid' and 2<=row['connect_timeout']<=9 for row in calls)
    finally:
        monkeypatch.undo()
    for params in ({'host':'a,b'},{'host':'localhost','hostaddr':'127.0.0.1,127.0.0.2'}):
        with pytest.raises(DatabaseError, match='single database host'):
            recovery_db._connection_attempts(params,time.monotonic()+3)
    for params in ({}, {'host':'localhost','service':'implicit-config'}):
        with pytest.raises(DatabaseError, match='explicit database host'):
            recovery_db._connection_attempts(params,time.monotonic()+3)


def test_stale_connection_health_check_transfers_watchdog_before_transaction(monkeypatch):
    wrapper = connections['default']
    wrapper.ensure_connection()
    stale = wrapper.connection
    monkeypatch.setattr(wrapper, 'health_check_enabled', True)
    monkeypatch.setattr(wrapper, 'health_check_done', False)
    original_usable = wrapper.is_usable
    monkeypatch.setattr(wrapper, 'is_usable', lambda: False if wrapper.connection is stale else original_usable())
    with recovery_database():
        assert wrapper.connection is not stale and stale.closed
        with wrapper.cursor() as cursor:
            cursor.execute('SELECT 42')
            assert cursor.fetchone() == (42,)
    assert not wrapper.connection.closed


def test_expired_health_check_cannot_acquire_replacement(monkeypatch):
    from . import recovery_db
    wrapper = connections['default']
    wrapper.ensure_connection()
    acquisitions = []
    def too_late():
        time.sleep(.3)
        return False
    def forbidden_acquisition(params):
        acquisitions.append(params)
        raise AssertionError('replacement acquired after deadline')
    try:
        monkeypatch.setattr(recovery_db, 'CLIENT_TIMEOUT_SECONDS', .25)
        monkeypatch.setattr(wrapper,'health_check_enabled',True)
        monkeypatch.setattr(wrapper,'health_check_done',False)
        monkeypatch.setattr(wrapper,'is_usable',too_late)
        monkeypatch.setattr(wrapper,'get_new_connection',forbidden_acquisition)
        with pytest.raises(TimeoutError,match='budget'), recovery_database():
            pass
        assert acquisitions == [] and wrapper.connection is None
    finally:
        monkeypatch.undo()
