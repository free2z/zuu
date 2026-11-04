"""Guards for persistent database connections (CONN_MAX_AGE / CONN_HEALTH_CHECKS).

Django's default CONN_MAX_AGE is 0, which opens and tears down a brand-new
connection for every request — a full TCP + TLS + Postgres auth handshake
through the Cloud SQL proxy before any request does real work. These tests pin
the settings and prove, against real Postgres, that the connection actually
survives the end-of-request teardown Django performs via the `request_finished`
signal.
"""

import pytest
from django.conf import settings
from django.db import connection


def _is_postgres():
    return 'postgresql' in settings.DATABASES['default']['ENGINE']


def _backend_pid():
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_backend_pid()")
        return cursor.fetchone()[0]


def test_postgres_enables_persistent_connections():
    if not _is_postgres():
        pytest.skip("sqlite dev default deliberately keeps Django's defaults")

    db = settings.DATABASES['default']
    assert db['CONN_MAX_AGE'] > 0, "persistent connections must be enabled"
    # CONN_HEALTH_CHECKS is mandatory with CONN_MAX_AGE > 0: without it, a
    # pooled connection the proxy/server already dropped raises
    # InterfaceError/OperationalError the next time it is handed to a view.
    assert db['CONN_HEALTH_CHECKS'] is True


def test_conn_max_age_is_overridable_per_process(monkeypatch):
    """daphne pins CONN_MAX_AGE=0 in k8s; the env var is what makes that work."""
    import importlib
    import os

    monkeypatch.setitem(os.environ, "CONN_MAX_AGE", "0")
    module = importlib.import_module("dj.free2z.settings")
    reloaded = importlib.reload(module)
    try:
        assert reloaded.CONN_MAX_AGE == 0
        if 'postgresql' in reloaded.DATABASES['default']['ENGINE']:
            assert reloaded.DATABASES['default']['CONN_MAX_AGE'] == 0
    finally:
        monkeypatch.undo()
        importlib.reload(module)


@pytest.mark.django_db(transaction=True)
def test_connection_survives_end_of_request():
    if not _is_postgres():
        pytest.skip("sqlite dev default deliberately keeps Django's defaults")

    connection.ensure_connection()
    assert connection.settings_dict['CONN_MAX_AGE'] > 0

    pid = _backend_pid()

    # This is exactly what Django runs on the `request_finished` signal.
    connection.close_if_unusable_or_obsolete()

    assert connection.connection is not None, "connection was torn down"
    assert _backend_pid() == pid, "a new backend was opened — no reuse"
