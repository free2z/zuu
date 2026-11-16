"""Finite database work on the recovery caller's existing Django connection."""
import math
import threading
import time
from contextlib import contextmanager

from django.db import DatabaseError, connections, transaction

CLIENT_TIMEOUT_SECONDS = 10


@contextmanager
def _atomic_settings(wrapper, deadline, timeout_ms):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('recovery database budget exhausted')
    timeout = str(max(1, min(timeout_ms, int(remaining * 1000)))) + 'ms'
    with transaction.atomic(using=wrapper.alias):
        with wrapper.cursor() as cursor:
            cursor.execute("SELECT current_setting('statement_timeout'),current_setting('lock_timeout')")
            previous = cursor.fetchone()
            cursor.execute("SELECT set_config('statement_timeout',%s,true),set_config('lock_timeout',%s,true)", [timeout, timeout])
        yield
        # A failed savepoint rolls LOCAL settings back. Restore successful
        # operations too, including callers already inside a transaction.
        with wrapper.cursor() as cursor:
            cursor.execute("SELECT set_config('statement_timeout',%s,true),set_config('lock_timeout',%s,true)", previous)


@contextmanager
def recovery_database(*, deadline=None, timeout_ms=5000):
    """Bound setup, SQL and commit; never replay an uncertain transaction.

    Like the worker lease watchdog, the supported psycopg 3 driver closes its
    exact raw connection from the timer thread (PQfinish, no cancel handshake).
    Server timeouts alone cannot interrupt a proxy that stops returning data.
    Nested operations share the outer watchdog and deadline. A cut invalidates
    this connection; later work reconnects and reads the durable outcome.
    """
    wrapper = connections['default']
    outer = getattr(wrapper, '_dyte_recovery_deadline', None)
    if outer is not None:
        with _atomic_settings(wrapper, outer, timeout_ms):
            yield
        return
    deadline = min(deadline if deadline is not None else float('inf'),
        time.monotonic() + CLIENT_TIMEOUT_SECONDS)
    if deadline <= time.monotonic():
        raise TimeoutError('recovery database budget exhausted')
    expired = threading.Event()
    raw = None
    watchdog = None
    original = wrapper.get_new_connection
    prior_hook = wrapper.__dict__.get('get_new_connection')

    def arm(connection):
        nonlocal raw, watchdog
        if raw is not None:
            connection.close()
            raise DatabaseError('recovery connection changed during operation')
        raw = connection
        def cut():
            expired.set()
            # Capture the raw object, never a mutable Django wrapper or FD.
            connection.close()
        watchdog = threading.Timer(max(0, deadline - time.monotonic()), cut)
        watchdog.daemon = True
        watchdog.start()
        return connection

    def connect(params):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('recovery database budget exhausted')
        params = dict(params)
        # libpq enforces a two-second minimum for a new TCP connection. Once
        # acquired, arm before Django's initialization SQL or atomic entry.
        params['connect_timeout'] = max(1, min(
            int(params.get('connect_timeout') or CLIENT_TIMEOUT_SECONDS), math.ceil(remaining)))
        return arm(original(params))

    wrapper._dyte_recovery_deadline = deadline
    wrapper.get_new_connection = connect
    try:
        if wrapper.connection is not None:
            arm(wrapper.connection)
        with _atomic_settings(wrapper, deadline, timeout_ms):
            yield
        if expired.is_set():
            raise TimeoutError('recovery database client deadline exceeded')
    finally:
        if prior_hook is None:
            del wrapper.get_new_connection
        else:
            wrapper.get_new_connection = prior_hook
        del wrapper._dyte_recovery_deadline
        if watchdog is not None:
            watchdog.cancel()
            # Supported PQfinish is nonblocking. Do not make cleanup itself an
            # unlimited wait if a different driver violates that assumption.
            watchdog.join(timeout=1)
        if raw is not None and (expired.is_set() or raw.closed) and wrapper.connection is raw:
            wrapper.run_on_commit = []
            if wrapper.in_atomic_block:
                wrapper.closed_in_transaction = True
                wrapper.needs_rollback = True
            else:
                wrapper.connection = None
        if watchdog is not None and watchdog.is_alive():
            raise TimeoutError('recovery database connection cleanup incomplete')
