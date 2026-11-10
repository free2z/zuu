"""Exercise the actual HTTP adapter and Redis scripts at their boundaries."""
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import requests
from django_redis.cache import RedisCache
from urllib3.util.retry import Retry

from dj.apps.dyte import client as provider


@pytest.mark.parametrize('status', [429, 502, 503, 504])
def test_provider_failure_is_single_attempt_despite_retry_after(
    monkeypatch, settings, status,
):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            self.send_response(status)
            self.send_header('Retry-After', '3600')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def log_message(self, *args):
            pass

    def forbidden_retry_sleep(*args, **kwargs):
        pytest.fail('provider response entered the transport retry sleep path')

    # Fail immediately if retries return, rather than sleeping for an hour.
    monkeypatch.setattr(Retry, 'sleep', forbidden_retry_sleep)
    monkeypatch.setattr(provider, '_SESSION_LOCAL', threading.local())
    session = provider._session()
    session.trust_env = False
    # Exercise the exact production HTTPS adapter over a loopback HTTP socket;
    # TLS certificate setup is unrelated to its response/retry policy.
    session.mount('http://', session.get_adapter('https://provider.invalid'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings.RTK_API_BASE_URL = f'http://127.0.0.1:{server.server_port}'
    settings.DYTE_KEY = 'test-only'
    try:
        with pytest.raises(requests.HTTPError) as error:
            provider.DyteClient('test-org').get_participants_count('test-room')
        assert error.value.response.status_code == status
        assert calls == ['/v2/meetings/test-room/active-session']
    finally:
        session.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


@pytest.fixture
def real_count_cache(monkeypatch):
    host = os.environ.get('REDIS_HOST')
    if not host:
        pytest.skip('REDIS_HOST required for real participant-count Lua tests')
    port = os.environ.get('REDIS_PORT', '6379')
    backend = RedisCache(f'redis://{host}:{port}/0', {
        'KEY_PREFIX': f'provider-count-test-{uuid.uuid4().hex}',
        'OPTIONS': {'SOCKET_CONNECT_TIMEOUT': 2, 'SOCKET_TIMEOUT': 2},
    })
    monkeypatch.setattr(provider, 'cache', backend)
    keys = [*provider._count_cache_keys('test-room'),
            provider._count_snapshot_key('test-room'),
            provider._count_generation_key('test-room'),
            provider._count_sequence_key()]
    try:
        yield backend
    finally:
        backend.delete_many(keys)
        backend.close()


def test_real_redis_count_ttls_fallback_and_generation_fence(real_count_cache, monkeypatch):
    backend = real_count_cache
    raw = backend.client.get_client(write=True)
    recent, stale = provider._count_cache_keys('test-room')
    old = provider._count_generation('test-room')
    current = provider._count_generation('test-room')
    observed = provider.timezone.now().isoformat()
    snapshot = {"version": 1, "count": 7, "observed_at": observed,
                "room_id": "test-room", "provider_session_id": "session-a"}
    provider._write_count_if_current('test-room', current, 7, snapshot)
    assert backend.get(recent) == backend.get(stale) == 7
    assert backend.get(provider._count_snapshot_key('test-room')) == snapshot
    assert 0 < raw.ttl(backend.make_key(recent)) <= 12
    assert 290 <= raw.ttl(backend.make_key(stale)) <= 300
    provider._write_count_if_current('test-room', old, 0)
    assert backend.get(recent) == backend.get(stale) == 7
    assert backend.get(provider._count_snapshot_key('test-room')) == snapshot

    # Evict only the short snapshot: failed refresh must retain the real
    # Redis-backed fallback, never invent a confirmed empty room.
    backend.delete(recent)
    client = provider.DyteClient('test-org')

    def unavailable(_meeting):
        raise requests.Timeout('provider unavailable')

    monkeypatch.setattr(client, 'get_participants_count', unavailable)
    assert client.get_cached_participants_count('test-room') == 7
    assert backend.get(stale) == 7
