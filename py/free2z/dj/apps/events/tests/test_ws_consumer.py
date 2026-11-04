"""WebSocket regression tests for `EventConsumer`.

Why this file exists
--------------------
WebSockets were completely broken in production for an unknown period and
nothing caught it, because nothing in the suite ever opened a WebSocket.

The failure was a silent API break between two pinned packages:
`channels` 4.2.1 renamed `BaseChannelLayer.valid_channel_name` /
`valid_group_name` to `require_valid_*` "without deprecation" (they were
considered internal), while `channels_redis` 4.2.1 still called the old
names. Every `group_add` / `receive` on `RedisChannelLayer` therefore raised
`AttributeError: 'RedisChannelLayer' object has no attribute
'valid_group_name'`, and every WS connect to the daphne pods failed.

The break lives *inside the channel layer implementation*, so an
`InMemoryChannelLayer` test would have stayed green through the whole
outage. The redis-backed case below is the one that actually guards the
regression; it runs whenever `REDIS_HOST` is set (CI always sets it).
"""

import asyncio
import importlib
import os
import sys
import time
from collections.abc import Mapping
from unittest import mock

import pytest
import redis
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from channels_redis.core import RedisChannelLayer
from django.test import override_settings

from dj.apps.events.consumers import EventConsumer
from dj.apps.openai.models import _bounded_group_send
from dj.free2z.channel_layer_config import (
    CHANNEL_REDIS_SOCKET_TIMEOUT,
    redis_channel_layer_config,
)
from dj.apps.events import consumers as event_consumers
from dj.apps.events.consumers import HEARTBEAT_CHANNEL_TIMEOUT_SECONDS

REDIS_HOST = os.environ.get("REDIS_HOST")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))

IN_MEMORY_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}

REDIS_LAYERS = {
    "default": redis_channel_layer_config(
        host=REDIS_HOST or "127.0.0.1",
        port=REDIS_PORT,
        prefix="test-ws-regression",
    ),
}

IDLE_REDIS_SECONDS = 31

# How far the client read deadline must sit above the server-side block.
# "Above by any epsilon" is not a safe configuration: the client's timer starts
# before the command is even written, so the margin has to absorb a Redis
# round trip across the private network plus event-loop scheduling delay. Two
# seconds is the smallest number that is obviously not a coincidence.
SOCKET_TIMEOUT_HEADROOM_SECONDS = 2

#...and an upper bound, because `>=` alone accepts 8000 as happily as 8. The
# unit here is SECONDS (redis-py `socket_timeout`), and a seconds/milliseconds
# mixup parses fine, passes a healthy-Redis integration test, and only shows up
# when Redis accepts the connection and then stops answering -- at which point
# the read blocks for hours instead of seconds while WS tasks pile up. The
# whole point of the deadline is to bound that case, so cap it well below any
# plausible typo.
SOCKET_TIMEOUT_CEILING_SECONDS = 30

LAYER_PARAMS = [
    pytest.param(IN_MEMORY_LAYERS, id="inmemory"),
    pytest.param(
        REDIS_LAYERS,
        id="redis",
        marks=pytest.mark.skipif(
            not REDIS_HOST,
            reason="REDIS_HOST not set; skipping redis channel layer test",
        ),
    ),
]


def test_redis_socket_timeout_exceeds_blocking_poll():
    """Keep the client deadline safely above channels_redis's idle poll.

    2026-08-11, GCLB 5xx alert: `channels_redis` 4.3.0 blocks on BZPOPMIN for
    `brpop_timeout = 5` while redis-py 8.0.1 defaults `socket_timeout` to 5.
    Identical numbers, but the client's clock starts before the command is
    written, so the client always wins the race -- and `_brpop_with_clean` has
    no `except`, so `redis.exceptions.TimeoutError` propagated out of
    `receive()` through `await_many_dispatch` and killed the consumer. Every
    `/ws/profile` socket in production died 5.5-6.0s after connecting, for
    every logged-in user, continuously (482 read timeouts/hour on one daphne
    pod). See  /.

    A bare `>` would accept 5.1 -- 0.1s of headroom for a network round trip,
    which is the same bug with a different rounding. Require real margin.
    """
    assert (
        RedisChannelLayer.brpop_timeout + SOCKET_TIMEOUT_HEADROOM_SECONDS
        <= CHANNEL_REDIS_SOCKET_TIMEOUT
        <= SOCKET_TIMEOUT_CEILING_SECONDS
    )


def _load_production_settings():
    """Import `dj.free2z.prod_settings` the way a production container does.

    Importing the *real* module is the entire point. `prod_settings.py` and
    the tests above each call `redis_channel_layer_config()` independently, so
    a hand-edit of prod_settings back to the pre- bare tuple
    (`"hosts": [('redis.example.invalid', 6379)]`) would restore the outage with the
    whole suite still green. Anything that re-derives the config here instead
    of reading the deployed file re-opens exactly that hole.

    Two things have to be arranged for the import to reach the production
    branch:

      * `LOCALDEV` must be unset -- the `CHANNEL_LAYERS` block is gated behind
        `if not os.environ.get("LOCALDEV")`, so a dev shell exporting it would
        skip the code under test and vacuously pass.
      * `DBPASS` must exist -- prod_settings reads it via `os.environ[...]`
        with no default, for `DATABASES` and `DBBACKUP_CONNECTORS`.

    `mock.patch.dict` snapshots and restores the whole environment, so the
    `pop` below is undone on exit. The module is dropped from `sys.modules`
    before the import so it genuinely re-executes under this environment, and
    after it so no half-configured settings module is left for other tests.
    Importing it does not activate it: `from.settings import *` resolves to
    the already-cached settings module, and Django's configured settings are
    untouched.
    """
    with mock.patch.dict(os.environ, {"DBPASS": os.environ.get("DBPASS", "test")}):
        os.environ.pop("LOCALDEV", None)
        sys.modules.pop("dj.free2z.prod_settings", None)
        try:
            return importlib.import_module("dj.free2z.prod_settings")
        finally:
            sys.modules.pop("dj.free2z.prod_settings", None)


def test_prod_settings_channel_layer_carries_safe_socket_timeout():
    """The deployed settings module -- not a copy of it -- must be safe.

    This asserts on `prod_settings.CHANNEL_LAYERS`, the object daphne actually
    loads in production, so reverting that file to a bare `(host, port)` tuple
    (redis-py then applies its own 5s `DEFAULT_SOCKET_TIMEOUT`) fails here
    instead of in the GCLB 5xx graph.
    """
    prod_settings = _load_production_settings()

    layer = prod_settings.CHANNEL_LAYERS["default"]
    assert layer["BACKEND"] == "channels_redis.core.RedisChannelLayer"

    # Every host, not just hosts[0]: channels_redis shards channels across the
    # configured hosts, so a second entry added for failover would carry the
    # unsafe redis-py default for whatever share of consumers lands on it.
    hosts = layer["CONFIG"]["hosts"]
    assert hosts, "production channel layer must configure at least one Redis host"
    for host in hosts:
        assert isinstance(host, Mapping), (
            "production host entry must be a dict carrying explicit timeouts; a "
            f"bare tuple/URL inherits redis-py's 5s default and re-opens #757 "
            f"(got {host!r})"
        )
        assert (
            RedisChannelLayer.brpop_timeout + SOCKET_TIMEOUT_HEADROOM_SECONDS
            <= host["socket_timeout"]
            <= SOCKET_TIMEOUT_CEILING_SECONDS
        )


def test_prod_settings_database_connection_attempt_is_bounded():
    """The settings module used by WSGI/Daphne keeps failed connects bounded."""
    prod_settings = _load_production_settings()

    database = prod_settings.DATABASES["default"]
    assert database["OPTIONS"]["connect_timeout"] == 5


async def _connect(user):
    """Open a WS connection to `EventConsumer` as `user`.

    The consumer is instantiated directly rather than through
    `AuthMiddlewareStack` so the test targets the consumer + channel layer
    instead of session middleware; `scope["user"]` is what the consumer
    actually reads.
    """
    communicator = WebsocketCommunicator(EventConsumer.as_asgi(), "/ws/profile")
    communicator.scope["user"] = user
    return communicator


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_ws_connect_and_group_message_round_trip(creator_factory, layers):
    """Connect over a real WebSocket and receive a real group message.

    This is the end-to-end guard: `connect()` must succeed (it calls
    `channel_layer.group_add`, the exact call that raised in prod), and a
    `group_send` to the user's group must arrive on the socket (which
    exercises `channel_layer.receive`, the other prod traceback).
    """
    from channels.db import database_sync_to_async

    user = await database_sync_to_async(creator_factory)()

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _connect(user)
        connected, _ = await communicator.connect()
        assert connected, "WebSocket connect failed"

        # The browser heartbeat must be answered by the same consumer/channel
        # layer path as real events, so Redis stalls are visible without
        # waiting for this consumer's serialized server-side timeout.
        await communicator.send_json_to({"type": "ping", "id": 17})
        assert await communicator.receive_json_from(timeout=5) == {
            "type": "pong",
            "id": 17,
        }

        if layers["default"]["BACKEND"] == "channels_redis.core.RedisChannelLayer":
            # channels_redis polls an idle channel with a five-second Redis
            # command. Keep the connection idle across several polls so the
            # regression cannot hide behind a single lucky cycle.
            await asyncio.sleep(IDLE_REDIS_SECONDS)

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"user_{user.id}",
            {"type": "events.message", "message": "hello", "kind": "test"},
        )

        payload = await communicator.receive_json_from(timeout=5)
        assert payload["message"] == "hello"
        assert payload["kind"] == "test"

        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_ws_rejects_anonymous(layers):
    """Anonymous users must be closed out, not accepted."""
    from django.contrib.auth.models import AnonymousUser

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _connect(AnonymousUser())
        connected, _ = await communicator.connect()
        assert not connected
        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.skipif(
    not REDIS_HOST,
    reason="REDIS_HOST not set; skipping real redis stall recovery test",
)
async def test_ws_recovers_by_reconnecting_after_real_redis_stall(creator_factory):
    """A >8s Redis stall drops an ambiguous socket; reconnect restores delivery.

    Retrying ``BZPOPMIN`` after a read timeout is unsafe: Redis may have removed
    a message before the response was lost but before channels_redis copied it
    into the backup queue.  The deliberate policy is therefore to terminate the
    affected consumer and let the browser's bounded backoff establish a fresh
    socket and group membership after Redis recovers.
    """
    from channels.db import database_sync_to_async

    user = await database_sync_to_async(creator_factory)()
    stalled_communicator = None
    recovered_communicator = None
    redis_client = None

    try:
        with override_settings(CHANNEL_LAYERS=REDIS_LAYERS):
            channel_layer = get_channel_layer()
            stalled_communicator = await _connect(user)
            connected, _ = await stalled_communicator.connect()
            assert connected, "WebSocket connect failed"

            redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT)
            # Pause Redis for 30s so Redis will not unpause prematurely on its own
            redis_client.execute_command("CLIENT", "PAUSE", "30000")

            # The current BZPOPMIN poll may need its five-second server timeout
            # before the next Redis command reaches the paused service.  Allow
            # that poll plus the eight-second client deadline and a small margin.
            deadline = time.monotonic() + 18.0
            while not stalled_communicator.future.done():
                if time.monotonic() > deadline:
                    raise TimeoutError(
                        "WebSocket consumer did not surface the Redis read timeout "
                        "within the expected window"
                    )
                await asyncio.sleep(0.1)

            assert isinstance(
                stalled_communicator.future.exception(),
                redis.exceptions.TimeoutError,
            )

            # Recovery uses a new WebSocket, matching the production browser
            # controller's tested reconnect policy.
            redis_client.execute_command("CLIENT", "UNPAUSE")
            recovered_communicator = await _connect(user)
            connected, _ = await recovered_communicator.connect()
            assert connected, "WebSocket reconnect failed after Redis recovery"

            # Send group message after Redis resumes
            await channel_layer.group_send(
                f"user_{user.id}",
                {
                    "type": "events.message",
                    "message": "stall_recovery_verified",
                    "kind": "stall_test",
                },
            )

            payload = await recovered_communicator.receive_json_from(timeout=10)
            assert payload["message"] == "stall_recovery_verified"
            assert payload["kind"] == "stall_test"
    finally:
        if redis_client is not None:
            try:
                redis_client.execute_command("CLIENT", "UNPAUSE")
            except Exception:
                pass
            redis_client.close()
        if recovered_communicator is not None:
            try:
                await recovered_communicator.disconnect()
            except Exception:
                pass
        if stalled_communicator is not None:
            try:
                await stalled_communicator.disconnect()
            except Exception:
                pass


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_ws_heartbeat_rate_is_bounded_server_side(
    creator_factory, layers, monkeypatch,
):
    """A client cannot turn the heartbeat into an unbounded Redis loop.

    The 20s interval lives only in the browser. Each accepted ping costs a
    channel-layer send + receive on the Redis shared with auth and payment
    admission, so the consumer must refuse to answer a ping that arrives
    inside HEARTBEAT_MIN_INTERVAL_SECONDS of the last accepted one -- even
    after that one's pong has been delivered.
    """
    from channels.db import database_sync_to_async

    clock = [1000.0]
    monkeypatch.setattr(event_consumers, "_heartbeat_clock", lambda: clock[0])
    user = await database_sync_to_async(creator_factory)()

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _connect(user)
        connected, _ = await communicator.connect()
        assert connected, "WebSocket connect failed"

        await communicator.send_json_to({"type": "ping", "id": 1})
        assert await communicator.receive_json_from(timeout=5) == {
            "type": "pong",
            "id": 1,
        }

        # Immediately again, after the pong landed: ignored, no Redis work.
        clock[0] += event_consumers.HEARTBEAT_MIN_INTERVAL_SECONDS - 0.5
        await communicator.send_json_to({"type": "ping", "id": 2})
        assert await communicator.receive_nothing(timeout=1)

        # Positive control: once the floor has elapsed the next one is served.
        clock[0] += 1
        await communicator.send_json_to({"type": "ping", "id": 3})
        assert await communicator.receive_json_from(timeout=5) == {
            "type": "pong",
            "id": 3,
        }

        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.skipif(
    not REDIS_HOST,
    reason="REDIS_HOST not set; skipping private-channel heartbeat Redis test",
)
async def test_ws_heartbeat_requires_private_channel_delivery_through_redis(
    creator_factory, monkeypatch,
):
    """A paused Redis cannot be bypassed by a direct WebSocket pong.

    Five live consumers first prove that a healthy heartbeat response is routed
    only to its own channel. After Redis is paused, each challenge must be
    rejected before the existing serialized receive timeout (8s), with no pong
    delivered. This is a local fault-injection test against the test Redis, not
    a production latency or load observation.
    """
    from channels.db import database_sync_to_async

    # This test deliberately sends a second challenge right after the first
    # round trip; the per-socket rate floor is pinned separately below.
    monkeypatch.setattr(event_consumers, "HEARTBEAT_MIN_INTERVAL_SECONDS", 0)
    user = await database_sync_to_async(creator_factory)()
    communicators = []
    redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT)
    try:
        with override_settings(CHANNEL_LAYERS=REDIS_LAYERS):
            for _ in range(5):
                communicator = await _connect(user)
                connected, _ = await communicator.connect()
                assert connected, "WebSocket connect failed"
                communicators.append(communicator)

            # Healthy round-trip and socket privacy controls: every consumer
            # gets only the challenge delivered to its unique channel_name.
            for index, communicator in enumerate(communicators):
                await communicator.send_json_to({"type": "ping", "id": index})
                assert await communicator.receive_json_from(timeout=3) == {
                    "type": "pong",
                    "id": index,
                }
                for other_index, other in enumerate(communicators):
                    if other_index == index:
                        continue
                    with pytest.raises(asyncio.TimeoutError):
                        await asyncio.wait_for(other.receive_output(), timeout=0.05)

            redis_client.execute_command("CLIENT", "PAUSE", "30000")
            started = time.monotonic()
            await asyncio.gather(
                *(
                    communicator.send_json_to({"type": "ping", "id": 100 + index})
                    for index, communicator in enumerate(communicators)
                )
            )
            outputs = await asyncio.gather(
                *(communicator.receive_output(timeout=6) for communicator in communicators)
            )
            elapsed = time.monotonic() - started

            assert elapsed < (2 * HEARTBEAT_CHANNEL_TIMEOUT_SECONDS + 1), (
                "heartbeat timeout waited on the serialized server-side Redis "
                f"read deadline: {elapsed:.3f}s"
            )
            assert [output.get("code") for output in outputs] == [1013] * 5
            assert all(output["type"] == "websocket.close" for output in outputs)
            assert elapsed < CHANNEL_REDIS_SOCKET_TIMEOUT
    finally:
        try:
            redis_client.execute_command("CLIENT", "UNPAUSE")
        except Exception:
            pass
        redis_client.close()
        for communicator in communicators:
            try:
                await communicator.disconnect()
            except Exception:
                pass
        # A stalled Redis receive can take up to its configured read deadline
        # to observe the WebSocket disconnect after Redis resumes. Let every
        # consumer task finish before pytest tears down the private test DB.
        await asyncio.gather(
            *(
                communicator.wait(timeout=CHANNEL_REDIS_SOCKET_TIMEOUT + 2)
                for communicator in communicators
            ),
            return_exceptions=True,
        )
        assert all(communicator.future.done() for communicator in communicators)


@pytest.mark.skipif(
    not REDIS_HOST,
    reason="REDIS_HOST not set; skipping real redis group_send timeout test",
)
async def test_bounded_group_send_cancels_promptly_against_stalled_real_redis():
    """The pinned Redis stack must honor cancellation inside the 0.5s bound.

    ``asyncio.wait_for`` waits for a cancelled coroutine to finish cleaning up,
    so a synthetic ``asyncio.sleep`` is insufficient evidence for the caller's
    wall-clock bound.  Exercise the production channel layer against a paused
    Redis service and fail if cancellation latency grows after a dependency
    upgrade.
    """
    redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT)

    try:
        with override_settings(CHANNEL_LAYERS=REDIS_LAYERS):
            channel_layer = get_channel_layer()
            redis_client.execute_command("CLIENT", "PAUSE", "30000")

            started = time.monotonic()
            with pytest.raises(TimeoutError):
                await _bounded_group_send(
                    channel_layer,
                    "issue-1028-stalled-group",
                    {"type": "events.message", "message": "best-effort"},
                    timeout=0.5,
                )
            elapsed = time.monotonic() - started
            assert elapsed < 2.0, (
                "canceling stalled channels_redis group_send exceeded the "
                f"caller bound: {elapsed:.3f}s"
            )

            redis_client.execute_command("CLIENT", "UNPAUSE")
            # Cancellation must not poison the layer for subsequent sends.
            await asyncio.wait_for(
                channel_layer.group_send(
                    "issue-1028-recovered-group",
                    {"type": "events.message", "message": "recovered"},
                ),
                timeout=2.0,
            )
    finally:
        try:
            redis_client.execute_command("CLIENT", "UNPAUSE")
        except Exception:
            pass
        redis_client.close()
