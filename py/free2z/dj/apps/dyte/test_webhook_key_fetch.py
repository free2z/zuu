"""Guards on `get_or_load_dyte_public_key` (review follow-up on ).

This helper runs at the top of the UNAUTHENTICATED `webhook` view, before the
signature check — it is what makes the signature check possible — so every
failure mode in it is reachable by an anonymous caller. It must:

* never raise (the view fails closed with a 503 instead of 500-ing),
* always pass an explicit timeout (`requests` has no default; a hung provider
  would otherwise pin a sync gunicorn worker forever),
* negative-cache failures, so a flood of webhook POSTs cannot be turned into a
  flood of outbound requests from inside the cluster.
"""
import json
import uuid

import pytest
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from dj.apps.dyte import views as dyte_views
from dj.apps.dyte.models import BROADCAST, CreatorMeeting

WEBHOOK_URL = "/api/dyte/webhook"


@pytest.fixture(autouse=True)
def _clear_key_cache():
    """The key cache is module-global; never let it leak between tests."""
    dyte_views.reset_dyte_public_key_cache()
    yield
    dyte_views.reset_dyte_public_key_cache()


def _pem():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()


class _Resp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return json.loads(json.dumps(self._payload))


def _ok_response():
    return _Resp({"data": {"publicKey": _pem()}})


# --------------------------------------------------------------------------
# Timeout
# --------------------------------------------------------------------------


def test_key_fetch_always_passes_an_explicit_timeout(mocker, settings):
    settings.DYTE_KEY_FETCH_TIMEOUT_SECONDS = 3.5
    get = mocker.patch(
        "dj.apps.dyte.views.requests.get", return_value=_ok_response())

    assert dyte_views.get_or_load_dyte_public_key() is not None

    assert get.call_count == 1
    assert get.call_args.kwargs["timeout"] == 3.5


# --------------------------------------------------------------------------
# Never raises — every provider failure mode returns None
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "side_effect,return_value",
    [
        (requests.Timeout("timed out"), None),
        (requests.ConnectionError("dns"), None),
        (None, _Resp({"data": {"publicKey": _pem()}}, status_code=500)),
        (None, _Resp(ValueError("not json"))),
        (None, _Resp({"data": {}})),                       # key absent
        (None, _Resp({})),                                  # no data at all
        (None, _Resp({"data": {"publicKey": "not-a-pem"}})),
    ],
)
def test_key_fetch_returns_none_instead_of_raising(
    mocker, side_effect, return_value
):
    mocker.patch(
        "dj.apps.dyte.views.requests.get",
        side_effect=side_effect,
        return_value=return_value,
    )
    assert dyte_views.get_or_load_dyte_public_key() is None


# --------------------------------------------------------------------------
# Caching — positive and negative
# --------------------------------------------------------------------------


def test_successful_fetch_is_cached(mocker):
    get = mocker.patch(
        "dj.apps.dyte.views.requests.get", return_value=_ok_response())

    first = dyte_views.get_or_load_dyte_public_key()
    second = dyte_views.get_or_load_dyte_public_key()

    assert first is second
    assert get.call_count == 1


def test_failure_is_negative_cached_so_it_is_not_an_outbound_amplifier(
    mocker, settings
):
    settings.DYTE_KEY_FETCH_RETRY_SECONDS = 300
    get = mocker.patch(
        "dj.apps.dyte.views.requests.get",
        side_effect=requests.Timeout("timed out"),
    )

    for _ in range(25):
        assert dyte_views.get_or_load_dyte_public_key() is None

    # 25 deliveries, ONE outbound request.
    assert get.call_count == 1


def test_negative_cache_expires_and_the_key_is_retried(mocker, settings):
    settings.DYTE_KEY_FETCH_RETRY_SECONDS = 30
    clock = {"t": 1000.0}
    mocker.patch("dj.apps.dyte.views.time.monotonic",
                 side_effect=lambda: clock["t"])
    get = mocker.patch(
        "dj.apps.dyte.views.requests.get",
        side_effect=requests.Timeout("timed out"),
    )

    assert dyte_views.get_or_load_dyte_public_key() is None
    clock["t"] += 29
    assert dyte_views.get_or_load_dyte_public_key() is None
    assert get.call_count == 1, "still inside the retry window"

    # Window expires, and the provider has recovered.
    clock["t"] += 2
    get.side_effect = None
    get.return_value = _ok_response()
    assert dyte_views.get_or_load_dyte_public_key() is not None
    assert get.call_count == 2


# --------------------------------------------------------------------------
# View-level: fail closed, and no outbound work for unsigned junk
# --------------------------------------------------------------------------


def _payload(meeting_id):
    return json.dumps({
        "event": "meeting.started",
        "meeting": {
            "id": meeting_id,
            "sessionId": str(uuid.uuid4()),
            "title": "A stream",
            "status": "LIVE",
            "createdAt": "2026-07-19T00:00:00Z",
            "startedAt": "2026-07-19T00:00:00Z",
            "organizedBy": {"id": str(uuid.uuid4()), "name": "free2z"},
        },
    }).encode()


@pytest.mark.django_db
def test_webhook_fails_closed_with_503_when_the_key_is_unavailable(
    api_client, creator_factory, mocker
):
    mocker.patch(
        "dj.apps.dyte.views.requests.get",
        side_effect=requests.Timeout("timed out"),
    )
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()),
        meeting_type=BROADCAST, is_public=True, live_now=False,
    )

    response = api_client.post(
        WEBHOOK_URL,
        data=_payload(cm.meeting_id),
        content_type="application/json",
        HTTP_DYTE_SIGNATURE="AAAA",
    )

    # 503, not 500 and not 200: the provider retries 5xx, so a transient
    # key-fetch outage does not silently drop real events.
    assert response.status_code == 503, response.content
    cm.refresh_from_db()
    assert cm.live_now is False


@pytest.mark.django_db
def test_unsigned_request_never_triggers_an_outbound_key_fetch(
    api_client, creator_factory, mocker
):
    """The cheap anti-amplification guard: no signature header => no egress."""
    get = mocker.patch(
        "dj.apps.dyte.views.requests.get", return_value=_ok_response())
    cm = CreatorMeeting.objects.create(
        creator=creator_factory(), meeting_id=str(uuid.uuid4()),
        meeting_type=BROADCAST, is_public=True, live_now=False,
    )

    for _ in range(10):
        response = api_client.post(
            WEBHOOK_URL,
            data=_payload(cm.meeting_id),
            content_type="application/json",
        )
        assert response.status_code == 400, response.content

    assert get.call_count == 0


# --------------------------------------------------------------------------
# Key rotation — the positive cache must not be held for the worker's life
# --------------------------------------------------------------------------


def test_cached_key_is_refreshed_after_the_ttl_so_rotation_is_survivable(
    mocker, settings
):
    settings.DYTE_KEY_CACHE_SECONDS = 3600
    clock = {"t": 1000.0}
    mocker.patch("dj.apps.dyte.views.time.monotonic",
                 side_effect=lambda: clock["t"])
    first, second = _ok_response(), _ok_response()
    get = mocker.patch("dj.apps.dyte.views.requests.get", return_value=first)

    original = dyte_views.get_or_load_dyte_public_key()

    # Inside the TTL: cached, no refetch.
    clock["t"] += 3599
    assert dyte_views.get_or_load_dyte_public_key() is original
    assert get.call_count == 1

    # Past the TTL: the provider has rotated its key and we pick up the new one.
    clock["t"] += 2
    get.return_value = second
    rotated = dyte_views.get_or_load_dyte_public_key()
    assert get.call_count == 2
    assert rotated is not original


def test_forced_refresh_is_rate_limited_like_every_other_fetch(
    mocker, settings
):
    """A flood of bad signatures must not become a flood of egress."""
    settings.DYTE_KEY_CACHE_SECONDS = 3600
    settings.DYTE_KEY_FETCH_RETRY_SECONDS = 300
    get = mocker.patch(
        "dj.apps.dyte.views.requests.get", return_value=_ok_response())

    assert dyte_views.get_or_load_dyte_public_key() is not None
    for _ in range(25):
        dyte_views.get_or_load_dyte_public_key(force_refresh=True)

    # One initial load; every forced refresh inside the window is suppressed.
    assert get.call_count == 1


def test_failed_refresh_keeps_serving_the_stale_key(mocker, settings):
    """A provider outage must not take the webhook down with it."""
    settings.DYTE_KEY_CACHE_SECONDS = 60
    settings.DYTE_KEY_FETCH_RETRY_SECONDS = 30
    clock = {"t": 1000.0}
    mocker.patch("dj.apps.dyte.views.time.monotonic",
                 side_effect=lambda: clock["t"])
    get = mocker.patch(
        "dj.apps.dyte.views.requests.get", return_value=_ok_response())

    original = dyte_views.get_or_load_dyte_public_key()
    assert original is not None

    # TTL expires, and now the provider is down.
    clock["t"] += 61
    get.side_effect = requests.Timeout("timed out")
    assert dyte_views.get_or_load_dyte_public_key() is original

    # And the back-off applies to the refresh too — no hammering.
    for _ in range(10):
        assert dyte_views.get_or_load_dyte_public_key() is original
    assert get.call_count == 2


# --------------------------------------------------------------------------
# Settings knobs must never brick startup or silently void themselves
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw", ["", "not-a-number", "nan", "NaN", "inf", "-inf", "0", "-5"])
def test_bad_env_value_falls_back_to_the_default(raw, capsys):
    from dj.free2z.settings import _positive_float_env

    import os as _os
    _os.environ["_F2Z_TEST_KNOB"] = raw
    try:
        assert _positive_float_env("_F2Z_TEST_KNOB", 7.5) == 7.5
    finally:
        del _os.environ["_F2Z_TEST_KNOB"]


def test_good_env_value_is_used():
    from dj.free2z.settings import _positive_float_env

    import os as _os
    _os.environ["_F2Z_TEST_KNOB"] = "2.5"
    try:
        assert _positive_float_env("_F2Z_TEST_KNOB", 7.5) == 2.5
    finally:
        del _os.environ["_F2Z_TEST_KNOB"]


def test_unset_env_value_uses_the_default():
    from dj.free2z.settings import _positive_float_env

    assert _positive_float_env("_F2Z_DEFINITELY_UNSET_KNOB", 1.25) == 1.25
