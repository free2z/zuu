import pytest


@pytest.fixture(autouse=True)
def _fresh_abandoned_provider_calls():
    """deadline.py tracks abandoned calls per PROCESS; a test that left a
    sleeping stub behind must not make the next test's provider 'busy'."""
    from dj.apps.twitter import deadline

    with deadline._lock:
        deadline._abandoned.clear()
    yield
    with deadline._lock:
        deadline._abandoned.clear()


@pytest.fixture(autouse=True)
def _twitter_oauth2_configured(settings):
    """`/api/twitter/start` now REFUSES when `TWITTER_CLIENT_ID` is blank.

    It builds the X authorize URL server-side, so a blank client id is
    "not configured" and answers 503 instead of handing the browser a URL that
    would fail at X. Production and stage both set it from the ConfigMap;
    the test settings set nothing, so every test that exercises the flow would
    otherwise be asserting against the outage rather than against the flow.

    A test that wants the unconfigured branch overrides this explicitly --
    see `test_twitter_start.py`.
    """
    settings.TWITTER_CLIENT_ID = "test-twitter-oauth2-client-id"
