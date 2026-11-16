"""Reader probes never authenticate, query storage or reach mint routes."""
import pytest
from django.test import Client, override_settings
from django.urls import Resolver404, resolve

from dj.apps.dyte.webhook_reader import READER_ROLE, READER_URLCONF, validate_reader_contract


@pytest.mark.parametrize('path', ['/api/dyte/webhook', '/api/dyte/webhook-recording-status-update/'])
def test_isolated_reader_probe_has_no_database_or_provider_work(path, monkeypatch, mocker):
    monkeypatch.setenv('FREE2Z_PROCESS_ROLE', READER_ROLE)
    monkeypatch.setenv('BUILD_SHA', 'a' * 40)
    monkeypatch.setenv('DEPLOYMENT_SHA', 'b' * 40)
    monkeypatch.setenv('APP_RELEASE_ID', 'sha256:' + 'c' * 64)
    provider = mocker.patch('dj.apps.dyte.views.DyteClient', side_effect=AssertionError('provider must not run'))
    auth = mocker.patch('dj.apps.dyte.views.authenticate_dyte_webhook', side_effect=AssertionError('signature must not run'))
    with override_settings(ROOT_URLCONF=READER_URLCONF, RTK_WEBHOOK_READER=True):
        response = Client().get(path, HTTP_AUTHORIZATION='Basic invalid', HTTP_COOKIE='sessionid=invalid')
    assert response.status_code == 200
    assert response.json() == {'ok': True, 'commit': 'a' * 40, 'deployment_commit': 'b' * 40,
        'release_id': 'sha256:' + 'c' * 64, 'reader_protocol': 1, 'role': READER_ROLE}
    assert response['Cache-Control'] == 'no-store'
    provider.assert_not_called()
    auth.assert_not_called()


@pytest.mark.parametrize('missing', ['role', 'settings', 'urlconf'])
def test_ordinary_api_process_cannot_claim_reader_role(missing, monkeypatch):
    monkeypatch.setenv('FREE2Z_PROCESS_ROLE', READER_ROLE if missing != 'role' else 'api')
    with override_settings(ROOT_URLCONF=READER_URLCONF if missing != 'urlconf' else 'dj.free2z.urls',
            RTK_WEBHOOK_READER=missing != 'settings'):
        assert Client().get('/api/dyte/webhook').status_code == 405


@pytest.mark.parametrize('path', ['/api/dyte/someone/broadcast', '/api/dyte/someone/host-session',
    '/api/dyte/someone/private', '/api/creators/', '/api/auth/login/'])
def test_reader_urlconf_cannot_resolve_api_writers(path):
    with pytest.raises(Resolver404):
        resolve(path, urlconf=READER_URLCONF)


def test_reader_capability_check_is_independent_of_active_process_settings(monkeypatch):
    monkeypatch.delenv('FREE2Z_PROCESS_ROLE', raising=False)
    assert validate_reader_contract() == {'reader_protocol': 1, 'role': READER_ROLE,
        'wsgi_module': 'dj.apps.dyte.webhook_wsgi:application'}


def test_actual_reader_wsgi_boot_cannot_start_workers_or_reach_external_services():
    import os
    from pathlib import Path
    import subprocess
    import sys
    script = '''
import os
from unittest.mock import patch

def forbidden(*args, **kwargs):
    raise AssertionError('reader bootstrap/probe must not access external services')

with patch('socket.socket.connect', side_effect=forbidden), patch('django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection', side_effect=forbidden):
    from dj.apps.dyte.webhook_wsgi import application
    from django.conf import settings
    from django.test import Client
    assert settings.ROOT_URLCONF == 'dj.apps.dyte.webhook_urls'
    assert settings.RTK_WEBHOOK_READER is True
    assert 'PROCRASTINATE_WORKER_POOL_SIZE' not in os.environ
    client = Client(HTTP_HOST='localhost')
    for path in ['/api/healthz', '/api/dyte/webhook', '/api/dyte/webhook-recording-status-update/']:
        response = client.get(path)
        assert response.status_code == 200, (path, response.status_code)
    for path in ['/api/dyte/creator/broadcast', '/api/dyte/creator/host-session']:
        assert client.post(path).status_code == 404
    for path in ['/api/dyte/webhook', '/api/dyte/webhook-recording-status-update/']:
        assert client.post(path, '{}', content_type='application/json').status_code == 400
'''
    env = {**os.environ, 'FREE2Z_PROCESS_ROLE': READER_ROLE,
        'DJANGO_SETTINGS_MODULE': 'dj.free2z.settings', 'DBPASS': 'synthetic-only',
        'PROCRASTINATE_WORKER_POOL_SIZE': '2'}
    result = subprocess.run([sys.executable, '-c', script], env=env,
        cwd=Path(__file__).resolve().parents[3], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr[-6000:]
