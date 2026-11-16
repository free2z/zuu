"""Actual PostgreSQL transport waits with server timeouts deliberately disabled."""
import time

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
    monkeypatch.setattr(recovery_db, 'CLIENT_TIMEOUT_SECONDS', .25)
    wrapper = connections['default']
    wrapper.ensure_connection()
    params = wrapper.get_connection_params()
    original_hook = wrapper.get_new_connection
    pids = []

    def stall():
        pids.append(wrapper.connection.info.backend_pid)
        wrapper.connection.execute("SET statement_timeout='0'")
        wrapper.connection.execute('SELECT pg_sleep(2)')

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
        assert time.monotonic() - started < 1.5
        assert pids and wrapper.connection is None
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
