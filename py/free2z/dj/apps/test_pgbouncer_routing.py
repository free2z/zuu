"""Database pooler routing resolves explicit environment settings.

Absent pooler configuration selects the direct database host. Management
commands that require session state always use that direct route. Application
processes can use a declared pooler namespace only with compatible worker
notification settings; invalid configuration fails closed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from django.conf import Settings
from django.core.exceptions import ImproperlyConfigured

from dj.free2z import db_pooler

REPO = Path(__file__).resolve().parents[4]
MANAGE = ['/workspace/py/free2z/dj/free2z/manage.py']
POOLED = {
    'DBHOST': 'sql-proxy-service',
    'NAMESPACE': 'prod',
    'DB_POOLER_NAMESPACES': 'stage,prod',
    'PROCRASTINATE_LISTEN_NOTIFY': 'false',
}






# --- dark by default ------------------------------------------------------


def test_no_pooler_keys_means_direct():
    route = db_pooler.resolve({'DBHOST': 'sql-proxy-service', 'NAMESPACE': 'prod'},
                              ['gunicorn'])
    assert route.host == 'sql-proxy-service'
    assert route.pooled is False


def test_no_dbhost_keeps_the_old_localhost_default():
    # prod_settings used os.environ.get("DBHOST", "localhost"); the migrate
    # step relies on it (its own proxy listens on 127.0.0.1).
    assert db_pooler.resolve({}, MANAGE + ['migrate']).host == 'localhost'
    assert db_pooler.resolve({}, ['gunicorn']).host == 'localhost'






# --- migrate is always direct ---------------------------------------------


# Written out, not read from db_pooler.DIRECT_COMMANDS: dropping `migrate`
# from the module must fail here, not shrink the parametrization.
@pytest.mark.parametrize('command', ['migrate', 'dbshell', 'dbbackup', 'dbrestore'])
@pytest.mark.parametrize('argv0', [
    'manage.py',
    '/workspace/py/free2z/dj/free2z/manage.py',
    'django-admin',
    '/usr/lib/python3/site-packages/django/__main__.py',
])
def test_direct_commands_ignore_a_pooled_environment(command, argv0):
    route = db_pooler.resolve(POOLED, [argv0, command, '--noinput'])
    assert route.host == 'sql-proxy-service'
    assert route.pooled is False


@pytest.mark.parametrize('argv', [
    ['gunicorn', 'dj.free2z.wsgi'],
    ['daphne', '-b', '0.0.0.0', 'dj.free2z.asgi:application'],
    MANAGE + ['procrastinate', 'worker'],
    MANAGE + ['renew_subs'],
])
def test_negative_control_everything_else_is_pooled(argv):
    route = db_pooler.resolve(POOLED, argv)
    assert route.host == 'pgbouncer'
    assert route.pooled is True






# --- a cutover cannot be half-done or mistyped quietly ---------------------


def test_pooled_without_disabling_listen_notify_is_refused():
    env = dict(POOLED)
    del env['PROCRASTINATE_LISTEN_NOTIFY']  # defaults to true
    with pytest.raises(db_pooler.PoolerConfigError, match='PROCRASTINATE_LISTEN_NOTIFY'):
        db_pooler.resolve(env, ['gunicorn'])
    env['PROCRASTINATE_LISTEN_NOTIFY'] = 'true'
    with pytest.raises(db_pooler.PoolerConfigError):
        db_pooler.resolve(env, ['gunicorn'])


@pytest.mark.parametrize('value', ['', ' ', 'flase', 'disabled', 'TRUE', '1'])
def test_a_pooled_namespace_refuses_anything_the_worker_would_read_as_listen(value):
    # "" used to pass the boot guard (read as false) while the worker read it
    # as LISTEN on -- a pooled billing lane silently LISTENing ( review).
    from dj.apps.jobs.procrastinate_pool import listen_notify_enabled
    env = dict(POOLED, PROCRASTINATE_LISTEN_NOTIFY=value)
    with pytest.raises(db_pooler.PoolerConfigError, match='not explicitly false'):
        db_pooler.resolve(env, ['gunicorn'])
    #...and the worker, reading the same env, would indeed LISTEN.
    import os
    old = os.environ.get('PROCRASTINATE_LISTEN_NOTIFY')
    os.environ['PROCRASTINATE_LISTEN_NOTIFY'] = value
    try:
        assert listen_notify_enabled() is True
    finally:
        if old is None:
            del os.environ['PROCRASTINATE_LISTEN_NOTIFY']
        else:
            os.environ['PROCRASTINATE_LISTEN_NOTIFY'] = old


@pytest.mark.parametrize('value', ['false', 'FALSE', ' off ', '0', 'no'])
def test_the_guard_and_the_worker_agree_on_every_off_spelling(value, monkeypatch):
    from dj.apps.jobs.procrastinate_pool import listen_notify_enabled
    monkeypatch.setenv('PROCRASTINATE_LISTEN_NOTIFY', value)
    assert listen_notify_enabled() is False
    assert db_pooler.resolve(dict(POOLED, PROCRASTINATE_LISTEN_NOTIFY=value),
                             ['gunicorn']).pooled is True


def test_listen_notify_is_only_required_where_pooled():
    env = dict(POOLED, NAMESPACE='test', PROCRASTINATE_LISTEN_NOTIFY='true')
    assert db_pooler.resolve(env, ['gunicorn']).pooled is False


@pytest.mark.parametrize('value', ['production', 'prod,staging', 'PROD'])
def test_an_unknown_namespace_is_refused_everywhere(value):
    env = dict(POOLED, DB_POOLER_NAMESPACES=value)
    with pytest.raises(db_pooler.PoolerConfigError, match='unknown namespace'):
        db_pooler.resolve(env, ['gunicorn'])
    # Even for migrate: the typo must not hide behind whichever process
    # happened to boot first.
    with pytest.raises(db_pooler.PoolerConfigError):
        db_pooler.resolve(env, MANAGE + ['migrate'])


def test_whitespace_and_empty_items_are_tolerated():
    env = dict(POOLED, DB_POOLER_NAMESPACES=' stage , prod ,')
    assert db_pooler.resolve(env, ['gunicorn']).pooled is True


def test_bypass_forces_direct_and_rejects_garbage():
    assert db_pooler.resolve(dict(POOLED, DB_POOLER_BYPASS='true'),
                             ['gunicorn']).pooled is False
    with pytest.raises(db_pooler.PoolerConfigError, match='DB_POOLER_BYPASS'):
        db_pooler.resolve(dict(POOLED, DB_POOLER_BYPASS='maybe'), ['gunicorn'])


def test_pooler_host_is_overridable_but_not_empty():
    assert db_pooler.resolve(dict(POOLED, DB_POOLER_HOST='pgb.example'),
                             ['gunicorn']).host == 'pgb.example'
    with pytest.raises(db_pooler.PoolerConfigError, match='DB_POOLER_HOST'):
        db_pooler.resolve(dict(POOLED, DB_POOLER_HOST=' '), ['gunicorn'])


# --- prod_settings wires the rule in ---------------------------------------


def _load_prod_settings(monkeypatch, env: dict[str, str], argv: list[str]):
    monkeypatch.setenv('DBPASS', 'unused')
    for key in ('DBHOST', 'NAMESPACE', 'DB_POOLER_NAMESPACES',
                'PROCRASTINATE_LISTEN_NOTIFY', 'DB_POOLER_HOST',
                'DB_POOLER_BYPASS'):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(sys, 'argv', argv)
    # A fresh import every time; monkeypatch restores the cached module after.
    monkeypatch.delitem(sys.modules, 'dj.free2z.prod_settings', raising=False)
    return Settings('dj.free2z.prod_settings')


def test_prod_settings_is_direct_by_default(monkeypatch):
    prod = _load_prod_settings(
        monkeypatch, {'DBHOST': 'sql-proxy-service', 'NAMESPACE': 'prod'},
        ['gunicorn'])
    assert prod.DATABASES['default']['HOST'] == 'sql-proxy-service'
    assert prod.DATABASES['default']['PORT'] == '5432'
    assert prod.DB_ROUTE.pooled is False


def test_prod_settings_pools_a_listed_namespace(monkeypatch):
    prod = _load_prod_settings(monkeypatch, POOLED, ['gunicorn'])
    assert prod.DATABASES['default']['HOST'] == 'pgbouncer'
    # The  transaction-pooling options survive the host switch.
    assert prod.DATABASES['default']['DISABLE_SERVER_SIDE_CURSORS'] is True
    assert prod.DATABASES['default']['OPTIONS']['prepare_threshold'] is None


def test_prod_settings_keeps_migrate_direct_in_a_pooled_pod(monkeypatch):
    prod = _load_prod_settings(monkeypatch, POOLED, MANAGE + ['migrate'])
    assert prod.DATABASES['default']['HOST'] == 'sql-proxy-service'


def test_prod_settings_refuses_a_half_cutover(monkeypatch):
    env = dict(POOLED, PROCRASTINATE_LISTEN_NOTIFY='true')
    with pytest.raises(ImproperlyConfigured, match='database pooler'):
        _load_prod_settings(monkeypatch, env, ['gunicorn'])
