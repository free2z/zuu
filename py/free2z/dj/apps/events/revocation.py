"""Hanging up the WebSockets an evicted party is already holding.

Why this module exists
----------------------

``dj.apps.ktauth.epoch`` deletes the account's Knox tokens and ends its Django session
rows when an ownership event lands. That ends every credential a *new*
request could present — and reaches none of the connections that are already
open.

The reason is structural rather than an oversight. ``dj/free2z/asgi.py`` wraps
the WebSocket router in ``channels.auth.AuthMiddlewareStack``, which resolves
``scope["user"]`` from the session cookie **once, at CONNECT time**, and both
consumers then cache the resolved user on ``self``. Nothing re-reads the
session afterwards, so deleting the row behind the cookie is invisible to a
socket that is already up: the evicted party keeps that connection, and its
authenticated identity, until they disconnect or the pod recycles. On a
long-lived tab that is indefinite.

What that leaks is bounded but real. Neither consumer has a ``receive``
handler, so a socket is a one-way push channel and cannot be used to write
anything or to mint a key-transparency assertion (that path is HTTP). What it
*can* still do is deliver the account's private notification stream
(``EventConsumer``) and the token-by-token output of the owner's AI
conversations (``ConversationConsumer``, the disclosure  was about) to
somebody the account has just evicted.

So an ownership event now also tells those sockets to hang up.

The shape of it
---------------

Every authenticated consumer joins a group dedicated to this one purpose,
:func:`revocation_group`, and implements a handler for
:data:`REVOCATION_MESSAGE_TYPE` that closes the connection. Revocation is a
single ``group_send`` to that group.

A **dedicated** group, not the existing ``user_<id>`` one that ``EventConsumer``
already joins, and the reason is a live hazard rather than tidiness:
``push_events`` group_sends ``{"type": "events_message"}`` to ``user_<id>``, and
channels turns an unhandled message type into a ``ValueError`` that kills the
consumer. Putting ``ConversationConsumer`` into ``user_<id>`` so it could be
reached would therefore have made every ordinary notification tear down every
open AI stream. One group per contract; no cross-talk.

Reconnecting is not a way around it: ``AuthMiddlewareStack`` needs the session
cookie, and the session row is gone by the time this fires.

Failure is loud, not fatal
--------------------------

:func:`disconnect_live_sockets` never raises. It is called from
``transaction.on_commit`` — after the credential change and the token
revocations have been committed — where an exception would surface as a 500 for an
operation that fully succeeded, and would abandon the remaining callbacks. The
channel layer is Redis in production (``channels_redis``) and Redis is a
dependency this platform survives losing; a password change must not start
failing because a cache is down.

That is the deliberate split, and it is worth being precise about which half is
which:

* the **durable** credentials — Knox tokens inside the transaction, and
  Django sessions refused by the committed account epoch/hash — are
  all-or-nothing with the credential change. Physical session-row cleanup is
  a durable worker job and may be delayed, but that half still fails closed.
* the **already-open socket** is best effort. If the broadcast cannot be
  delivered, the evicted party keeps receiving pushes on that one connection
  until it drops, and the failure is logged at ERROR with the account id rather
  than swallowed. It cannot be made transactional — the socket lives in another
  process, and there is no state to roll back.

Returning ``False`` rather than raising is what lets the caller record the
difference in its log line, so "we could not hang up on them" is visible in
production instead of inferred.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#The channel-layer message that means "your credentials were revoked; close".
#
#Channels dispatches a message to the consumer method named by its ``type``
#with dots replaced by underscores, so this string and
#``Consumer.credentials_revoked`` are one contract. They are pinned together
#by ``dj/apps/events/tests/test_ws_revocation.py``; changing one alone makes
#the send land on a consumer with no handler, which channels turns into a
#``ValueError`` — loud, but it would tear down the socket for the wrong
#reason and only under a real channel layer.
REVOCATION_MESSAGE_TYPE = "credentials.revoked"

#WebSocket close code sent to a revoked connection.
#
#4401 is in the 4000-4999 private range (RFC 6455 §7.4.2, which reserves it
#for application use and guarantees no registry will ever claim it), chosen
#to echo HTTP 401 so a client CAN tell "your credentials died" apart from an
#ordinary transport drop.
#
#**No client does yet, and saying otherwise would be the exact kind of
#aspirational claim this module exists to stop making.**
#`ts/svelte/free2z/src/lib/ws/profileSocket.ts` reads no close code: it treats
#4401 as any other drop, spends its ten-attempt bounded backoff, trips the
#breaker and then retries on a slow timer with a session that no longer
#exists. That is bounded and harmless (each attempt is refused at connect by
#`session_still_authenticates`, and the failed handshakes are minutes apart),
#but it is not "the client stops". Consuming this code to land the user on a
#sign-in page with a reason belongs with the sign-out UX in. Raised by
#the codex adversarial review.
REVOCATION_CLOSE_CODE = 4401


async def session_still_authenticates(scope) -> bool:
    """Re-read the session a connecting socket was authenticated from.

    The broadcast alone leaves a handshake-sized hole, and it is reachable by
    an attacker who simply opens sockets in a loop while the owner resets the
    account (found by the codex adversarial review). The losing interleaving:

    1. ``AuthMiddlewareStack`` resolves ``scope["user"]`` from the attacker's
       session and caches it on the scope;
    2. the owner's ownership event ends that session and fires
       :func:`disconnect_live_sockets`, which reaches nobody — this channel has
       not joined the group yet;
    3. ``group_add`` completes and the consumer accepts, holding a cached
       identity whose session is dead, and no later broadcast is coming.

    Every consumer therefore calls this **after** ``group_add`` and before
    ``accept``. Ordered that way, the two mechanisms cover each other with no
    gap: a revocation that lands before the recheck is seen by the recheck, and
    one that lands after it is seen by the group. There is no third ordering.

    Returns ``True`` when there is nothing to re-check — a scope with no
    session at all (a consumer instantiated directly, as the tests do) is not
    evidence of a revocation and must not be refused on that basis. WebSocket
    auth here is cookie-only, so a scope that HAS a session is the real path.

    **The question is "does this session still authenticate this account",
    and every weaker version of it has been wrong here.**

    ``SessionStore.exists()`` asked "is there a row", and the two came apart
    in: the ownership-event sweep now retires a session by emptying its
    payload and leaving the row for ``clearsessions``, because deleting it
    out from under a request whose response middleware is about to
    ``force_update`` it raises ``SessionInterrupted``. An ``exists()`` check
    reads a retired row as live and lets the evicted socket connect. That
    one was found by a red `backend` shard, not by review.

    Loading the row and matching ``_auth_user_id`` was the next version, and
    it is still too weak, because **the sweep is best effort**: the durable
    ``ktauth.sweep_sessions`` job can be delayed, stalled, or fail after the
    ownership event commits. A failed job leaves the payload untouched, so
    ``_auth_user_id`` still matches, and a handshake that lost the broadcast
    race would be accepted on a session the account no longer honours — with
    no later broadcast coming. Raised by the codex adversarial review.

    So this does what ``django.contrib.auth.get_user`` does on every ordinary
    request: it compares the stored ``_auth_user_hash`` against one computed
    from a **freshly read** account, which is where the epoch lives. That is
    the revocation itself rather than a proxy for it, and it holds whether or
    not the sweep ran, whether or not the row is still there, and whichever
    order the two mechanisms land in. Fallback hashes count, or a
    ``SECRET_KEY`` rotation would hang up on every socket on the platform.
    Comparing against the scope's cached user would defeat the point: that
    object is the one the handshake resolved before the event.
    """
    session = scope.get("session")
    if session is None:
        return True
    session_key = getattr(session, "session_key", None)
    if not session_key:
        return True
    user = scope.get("user")
    user_pk = getattr(user, "pk", None)
    if user_pk is None:
        return True

    from channels.db import database_sync_to_async

    def _still_authenticates() -> bool:
        from importlib import import_module

        from django.conf import settings
        from django.contrib.auth import get_user_model
        from django.utils.crypto import constant_time_compare

        # A fresh store rather than `session.load()`: loading through the
        # scope's own object rewrites its cache and, on a miss, clears its
        # `session_key`, and this must not mutate the state the rest of the
        # connection is reading.
        #
        # Built from `settings.SESSION_ENGINE`, the way Django builds one,
        # and NOT from `type(session)`. Channels' `SessionMiddleware` puts a
        # `LazyObject` in the scope and assigns the real store to its
        # `_wrapped` (channels 4.3.2, `channels/sessions.py`), so
        # `type(session)` is `LazyObject` and calling it with `session_key`
        # raises `TypeError` -- on EVERY authenticated handshake, needing no
        # ownership event at all, i.e. an outage of profile notifications and
        # AI streams for everyone. The tests never saw it because they inject
        # a bare `SessionStore` into the scope; `_socket_with_session` now
        # wraps it the way the middleware does. Caught by the codex
        # adversarial review.
        engine = import_module(settings.SESSION_ENGINE)
        payload = engine.SessionStore(session_key).load()
        if payload.get("_auth_user_id") != str(user_pk):
            return False
        stored_hash = payload.get("_auth_user_hash") or ""
        # Freshly read, NOT `scope["user"]`: that instance was loaded by the
        # handshake, before the event this is looking for.
        account = get_user_model()._default_manager.filter(pk=user_pk).first()
        if account is None:
            return False
        if constant_time_compare(stored_hash, account.get_session_auth_hash()):
            return True
        return any(
            constant_time_compare(stored_hash, fallback)
            for fallback in account.get_session_auth_fallback_hash()
        )

    return await database_sync_to_async(_still_authenticates)()


def revocation_group(user_id) -> str:
    """The group every authenticated consumer joins to be reachable for this.

    Deliberately NOT ``user_<id>``: see the module docstring. ``user_<id>``
    carries ``events_message`` traffic, and a consumer in that group with no
    handler for it is a consumer that dies on the next notification.
    """
    return f"credrevoke_{user_id}"


def disconnect_live_sockets(user_id) -> bool:
    """Ask every open WebSocket authenticated as ``user_id`` to close.

    Returns ``True`` when the broadcast was handed to the channel layer,
    ``False`` when it could not be — never raises. See the module docstring for
    why this half is best-effort while token revocation and session use-time
    checks are not.

    ``True`` means the message was published, not that a socket received it:
    there may be no sockets open at all (the ordinary case), and the channel
    layer gives no delivery receipt. It is the honest upper bound on what this
    function can know.
    """
    # Imported here rather than at module scope. `channels.layers` reads
    # `settings.CHANNEL_LAYERS` on first use, and this module is imported from
    # `dj.apps.ktauth.epoch`, which is itself reachable from a URLconf.
    try:
        from asgiref.sync import async_to_sync
        from channels.layers import get_channel_layer

        channel_layer = get_channel_layer()
        if channel_layer is None:  # pragma: no cover - no CHANNEL_LAYERS config
            logger.warning(
                "credential revocation cannot close sockets for user=%s: "
                "no channel layer is configured",
                user_id,
            )
            return False
        async_to_sync(channel_layer.group_send)(
            revocation_group(user_id),
            {"type": REVOCATION_MESSAGE_TYPE},
        )
    except Exception:
        # Broad on purpose. The channel layer can raise anything its backend
        # raises -- redis.ConnectionError, socket timeouts, a serialization
        # error -- and this runs AFTER the credential change committed. Turning
        # any of that into a 500 would report failure for an operation that
        # succeeded, and would skip the on_commit callbacks queued behind it.
        logger.exception(
            "credential revocation could not close live sockets for user=%s; "
            "already-open connections keep their identity until they drop",
            user_id,
        )
        return False
    return True
