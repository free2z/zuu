"""Shared Redis channel-layer configuration for production and integration tests."""

import os

CHANNEL_REDIS_HOST = os.environ.get("CHANNEL_REDIS_HOST", "localhost")
CHANNEL_REDIS_PORT = int(os.environ.get("CHANNEL_REDIS_PORT", "6379"))

# channels_redis polls an idle channel with a five-second BZPOPMIN. Keep the
# client read deadline above that poll so redis-py cannot win the race, while
# still bounding a Redis server that accepts a connection but stops answering.
# Three seconds of headroom is enough for the private-network Redis round trip
# without making best-effort group_send calls wait eight seconds before failing.
CHANNEL_REDIS_SOCKET_TIMEOUT = 8
CHANNEL_REDIS_SOCKET_CONNECT_TIMEOUT = 5

# How long a `group_add` membership survives without being renewed.
#
# `channels_redis` stores group membership as a sorted set scored by the time
# of `group_add`, and every `group_send` first drops members older than
# `group_expiry`. Nothing here ever re-adds, so this value IS the maximum age
# of a socket that a group broadcast can still reach. Left unset it is the
# library's **86400** -- a number nobody here chose, and one that silently
# bounds two things: the `user_<id>` notification stream (a tab open longer
# than a day stops receiving events), and, since, the revocation
# broadcast that hangs up on an evicted party's socket.
#
# 7 days, chosen against what actually ends a socket. Daphne pods are replaced
# by every release -- multiple times a week -- so a connection surviving even
# 24h is unusual and one surviving a week is close to impossible. Raising it
# further is not free: expired entries are only reaped by a `group_send`, so a
# longer window means broadcasts fan out to more dead channel names.
#
# This BOUNDS the hole rather than closing it. A socket older than this keeps
# its cached identity after a revocation, because the ASGI stack resolves
# `scope["user"]` once at connect and nothing re-reads it. Closing it properly
# means either renewing membership on a timer or capping socket lifetime; both
# are their own change. Raised by the codex adversarial review of.
CHANNEL_REDIS_GROUP_EXPIRY = 7 * 24 * 60 * 60


def redis_channel_layer_config(
    *, prefix, host=CHANNEL_REDIS_HOST, port=CHANNEL_REDIS_PORT
):
    """Build a RedisChannelLayer config with safe blocking-command timeouts.

    Receive timeouts deliberately propagate.  ``channels_redis`` removes a
    message with ``BZPOPMIN`` before copying it to its backup queue, so a client
    timeout after the pop has an indeterminate outcome.  Retrying inside the
    same apparently healthy WebSocket could therefore hide a permanent event
    gap.  Terminating the consumer makes the outage visible and lets the
    browser's bounded backoff/reconnect policy establish fresh group membership
    once Redis recovers.
    """
    return {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [
                {
                    "host": host,
                    "port": port,
                    "socket_timeout": CHANNEL_REDIS_SOCKET_TIMEOUT,
                    "socket_connect_timeout": CHANNEL_REDIS_SOCKET_CONNECT_TIMEOUT,
                }
            ],
            "prefix": prefix,
            # Explicit, not inherited. See CHANNEL_REDIS_GROUP_EXPIRY.
            "group_expiry": CHANNEL_REDIS_GROUP_EXPIRY,
        },
    }
