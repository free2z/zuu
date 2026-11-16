"""Finite database work on the recovery caller's existing Django connection."""
import ipaddress
import json
import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager

from django.db import DatabaseError, connections, transaction

CLIENT_TIMEOUT_SECONDS = 10
DNS_RESOLVER_CODE = """import json,socket,sys
print(json.dumps(list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(
    sys.argv[1], None, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)))))
"""


def _connection_attempts(params, deadline):
    """Resolve one configured host without leaving an unbounded DNS thread."""
    host = str(params.get('host') or '')
    address = str(params.get('hostaddr') or '')
    if not host or params.get('service'):
        raise DatabaseError('recovery requires an explicit database host')
    if any(',' in str(params.get(key) or '') for key in ('host', 'hostaddr', 'port')):
        raise DatabaseError('recovery requires a single database host')
    if address:
        ipaddress.ip_address(address)
        return [params]
    if host.startswith('/'):
        return [params]
    try:
        ipaddress.ip_address(host)
        addresses = [host]
    except ValueError:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('recovery database acquisition budget exhausted')
        # This child performs only stdlib DNS resolution, never a database
        # connection or transaction. subprocess.run kills and reaps it on
        # timeout. -I excludes application startup and user site imports.
        try:
            result = subprocess.run([sys.executable, '-I', '-c', DNS_RESOLVER_CODE, host],
                capture_output=True, text=True, check=True, timeout=remaining)
            addresses = json.loads(result.stdout)
            if not isinstance(addresses, list) or not addresses:
                raise ValueError('empty resolution')
            addresses = list(dict.fromkeys(str(ipaddress.ip_address(value)) for value in addresses))
        except (subprocess.SubprocessError, ValueError, TypeError):
            raise DatabaseError('recovery database resolution unavailable') from None
    # Preserve host for TLS/identity; numeric hostaddr bypasses driver DNS.
    return [dict(params, hostaddr=address) for address in addresses]


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

    The timer shuts down a retained socket duplicate, never libpq's connection
    state. Only the owning caller closes the raw connection after SQL unwinds.
    Server timeouts cannot interrupt a proxy that stops returning data.
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
    retained_socket = None
    operation_started = False
    original = wrapper.get_new_connection
    prior_hook = wrapper.__dict__.get('get_new_connection')

    def disarm():
        nonlocal watchdog, retained_socket
        if watchdog is not None:
            watchdog.cancel()
            watchdog.join(timeout=1)
            if watchdog.is_alive():
                raise TimeoutError('recovery socket watchdog cleanup incomplete')
            watchdog = None
        if retained_socket is not None:
            retained_socket.close()
            retained_socket = None

    def arm(connection):
        nonlocal raw, watchdog, retained_socket
        if raw is not None:
            # Django may replace a stale persistent connection during its
            # health check before atomic entry. Never transfer ownership once
            # transaction work starts, or after the old deadline fires.
            disarm()
            if operation_started or wrapper.in_atomic_block or expired.is_set():
                connection.close()
                raise DatabaseError('recovery connection changed during operation')
        raw = connection
        retained_socket = socket.socket(fileno=os.dup(connection.fileno()))
        owned_socket = retained_socket
        def cut():
            expired.set()
            # The duplicate keeps this exact socket alive even if the driver
            # closes/reuses its own descriptor. No concurrent PQfinish.
            try:
                owned_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        watchdog = threading.Timer(max(0, deadline - time.monotonic()), cut)
        watchdog.daemon = True
        watchdog.start()
        return connection

    def connect(params):
        if wrapper.pool is not None:
            raise DatabaseError('recovery requires a directly owned Django connection')
        failure = None
        for attempt in _connection_attempts(dict(params), deadline):
            remaining = deadline - time.monotonic()
            # libpq enforces a two-second minimum. Do not start an attempt
            # which cannot fit; each DNS answer shares this one deadline.
            if expired.is_set() or remaining < 2:
                raise TimeoutError('recovery database acquisition budget exhausted')
            attempt['connect_timeout'] = max(2, min(
                int(attempt.get('connect_timeout') or CLIENT_TIMEOUT_SECONDS), int(remaining)))
            try:
                acquired = original(attempt)
            except wrapper.Database.OperationalError as exc:
                failure = exc
                continue
            if expired.is_set() or time.monotonic() >= deadline:
                acquired.close()
                raise TimeoutError('recovery database acquisition budget exhausted')
            return arm(acquired)
        raise DatabaseError('recovery database connection unavailable') from failure

    wrapper._dyte_recovery_deadline = deadline
    wrapper.get_new_connection = connect
    try:
        if wrapper.connection is not None and wrapper.connection.closed and not wrapper.in_atomic_block:
            wrapper.close()
        if wrapper.connection is not None:
            arm(wrapper.connection)
        with _atomic_settings(wrapper, deadline, timeout_ms):
            operation_started = True
            yield
        if expired.is_set():
            raise TimeoutError('recovery database client deadline exceeded')
    finally:
        if prior_hook is None:
            del wrapper.get_new_connection
        else:
            wrapper.get_new_connection = prior_hook
        del wrapper._dyte_recovery_deadline
        disarm()
        if raw is not None and expired.is_set():
            # The caller owns libpq again after the interrupted operation and
            # atomic exit. Closing here cannot race another thread's query.
            raw.close()
        if raw is not None and raw.closed and wrapper.connection is raw:
            wrapper.run_on_commit = []
            if wrapper.in_atomic_block:
                wrapper.closed_in_transaction = True
                wrapper.needs_rollback = True
            else:
                wrapper.connection = None
