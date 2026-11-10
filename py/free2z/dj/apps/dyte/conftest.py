"""Only dummy v4 configuration is available to the RealtimeKit test suite."""
import pytest


@pytest.fixture(autouse=True)
def _dummy_realtimekit_config(settings):
    settings.RTK_ACCOUNT_ID = 'a' * 32
    settings.RTK_APP_ID = '182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e'
    settings.RTK_API_TOKEN = 'test-only-api-token'


@pytest.fixture(autouse=True)
def _block_live_provider_http(monkeypatch):
    import requests
    original = requests.Session.request

    def guarded(self, method, url, *args, **kwargs):
        if url.startswith(('https://api.cloudflare.com/',
                           'https://api.realtime.cloudflare.com/')):
            raise AssertionError('Provider HTTP must use an injected fake in tests')
        return original(self, method, url, *args, **kwargs)

    monkeypatch.setattr(requests.Session, 'request', guarded)
