import asyncio
import time

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .revocation import (
    REVOCATION_CLOSE_CODE,
    revocation_group,
    session_still_authenticates,
)

HEARTBEAT_CHANNEL_TIMEOUT_SECONDS = 2

# Server-side floor between two ACCEPTED heartbeats on one socket, in SECONDS.
# The browser sends one every 20s (profileSocket.ts HEARTBEAT_INTERVAL_MS), but
# that interval exists only in the client: without this floor an authenticated
# client could ping again the instant each pong lands and turn every round trip
# into a Redis send + receive on the instance shared with auth and payment
# admission. A ping inside the floor is ignored, not answered, so a client that
# breaks the contract simply misses its pong and reconnects.
HEARTBEAT_MIN_INTERVAL_SECONDS = 5


def _heartbeat_clock() -> float:
    """Monotonic seconds; a seam so tests never patch the event loop's clock."""
    return time.monotonic()


class EventConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        # print("CONNECT", self.scope)
        self.user = self.scope["user"]
        if self.user.is_anonymous:
            # Reject the connection if the user is not authenticated.
            # print("CLOSE!")
            await self.close()
        else:
            # print("ACCEPT!!!!!!!!!!!!!!!!!!!!!!!!", self.user.id)
            # Add the user to their own group.
            await self.channel_layer.group_add(
                f"user_{self.user.id}",
                self.channel_name
            )
            #...and to the revocation group, which is what lets an account
            # ownership event hang up on this socket. `scope["user"]`
            # was resolved from the session at CONNECT time and is never
            # re-read, so without this the connection outlives the credential
            # that authorised it. See dj/apps/events/revocation.py for why this
            # is a SEPARATE group from `user_<id>` above.
            await self.channel_layer.group_add(
                revocation_group(self.user.id),
                self.channel_name
            )
            # AFTER group_add, before accept: a revocation that landed while
            # this handshake was in flight reached nobody, because this channel
            # was not in the group yet. See `revocation.session_still_
            # authenticates` -- in this order the two checks leave no gap.
            if not await session_still_authenticates(self.scope):
                await self.close(code=REVOCATION_CLOSE_CODE)
                return
            # print("FINAL!!!!!!!!!!!!!!!!!!!!!!!!")
            await self.accept()
            # print("DONE")

    async def disconnect(self, close_code):
        # The Redis layer can be paused or unreachable while a socket is being
        # retired. Bound each cleanup write; stale group membership expires
        # according to CHANNEL_REDIS_GROUP_EXPIRY if Redis cannot remove it.
        self.pending_heartbeat_id = None
        if not self.user.is_anonymous:
            for group in (
                f"user_{self.user.id}",
                revocation_group(self.user.id),
            ):
                try:
                    await asyncio.wait_for(
                        self.channel_layer.group_discard(group, self.channel_name),
                        timeout=HEARTBEAT_CHANNEL_TIMEOUT_SECONDS,
                    )
                except Exception:
                    # Redis channel membership has a bounded expiry; cleanup
                    # must not keep a dead WebSocket task alive indefinitely.
                    continue

    async def receive_json(self, content):
        """Route a heartbeat response through this consumer's Redis channel."""
        if (
            isinstance(content, dict)
            and content.get("type") == "ping"
            and isinstance(content.get("id"), int)
            and not isinstance(content.get("id"), bool)
        ):
            challenge_id = content["id"]
            if getattr(self, "pending_heartbeat_id", None) is not None:
                return
            now = _heartbeat_clock()
            last = getattr(self, "last_heartbeat_accepted_at", None)
            if last is not None and now - last < HEARTBEAT_MIN_INTERVAL_SECONDS:
                return
            self.last_heartbeat_accepted_at = now
            self.pending_heartbeat_id = challenge_id
            try:
                # A direct send_json bypasses the stalled await_many_dispatch
                # channel-layer receive. Enqueue to this exact channel instead:
                # only heartbeat_pong may acknowledge a delivered challenge.
                await asyncio.wait_for(
                    self.channel_layer.send(
                        self.channel_name,
                        {"type": "heartbeat.pong", "id": challenge_id},
                    ),
                    timeout=HEARTBEAT_CHANNEL_TIMEOUT_SECONDS,
                )
            except Exception:
                if self.pending_heartbeat_id == challenge_id:
                    self.pending_heartbeat_id = None
                await self._close_for_heartbeat_failure()

    async def heartbeat_pong(self, event):
        """Send only a challenge that was delivered back to this socket."""
        challenge_id = event.get("id")
        if (
            not isinstance(challenge_id, int)
            or isinstance(challenge_id, bool)
            or challenge_id != getattr(self, "pending_heartbeat_id", None)
        ):
            return
        self.pending_heartbeat_id = None
        try:
            await asyncio.wait_for(
                self.send_json({"type": "pong", "id": challenge_id}),
                timeout=HEARTBEAT_CHANNEL_TIMEOUT_SECONDS,
            )
        except Exception:
            await self._close_for_heartbeat_failure()

    async def _close_for_heartbeat_failure(self):
        """Bound the close write after a heartbeat could not traverse Redis."""
        try:
            await asyncio.wait_for(
                self.close(code=1013),
                timeout=HEARTBEAT_CHANNEL_TIMEOUT_SECONDS,
            )
        except Exception:
            return

    async def events_message(self, event):
        # Handles the message, this method is used to send messages down to the client
        await self.send_json(event)

    async def credentials_revoked(self, event):
        """The account's credentials were revoked: stop being this user.

        Named for `revocation.REVOCATION_MESSAGE_TYPE` ("credentials.revoked"),
        which channels maps onto this method. Closing is the whole handler --
        the identity on this connection was resolved once, at connect, and
        cannot be re-checked, so the only honest response to "that identity is
        gone" is to hang up. Reconnecting needs the session cookie, whose row
        has already been deleted, so `connect()`'s own recheck refuses it.

        Reachable only while this channel's group membership is live: see
        `CHANNEL_REDIS_GROUP_EXPIRY` for the age at which a socket stops being
        addressable and what that bounds.
        """
        await self.close(code=REVOCATION_CLOSE_CODE)
