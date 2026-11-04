"""An ownership event hangs up on the WebSockets the evicted party still holds.

The gap these tests pin
-----------------------

 is about a revocation that does not revoke. Deleting the account's Knox
tokens and session rows ends every credential a NEW request could present, and
reaches nothing that is already connected: ``AuthMiddlewareStack`` resolves
``scope["user"]`` from the session once, at connect, and the consumers cache it
on ``self``. A socket opened a second before the password change keeps its
identity for as long as the connection lives.

's review recorded that as a residual gap and documented it. These tests
exist because "documented" and "closed" are different things, and the whole
issue is about controls that read as stronger than they are.

Structure, and why each one is here
-----------------------------------

* **the positive case, both consumers** — a live socket receives
  ``websocket.close`` with:data:`REVOCATION_CLOSE_CODE` after
  ``bump_account_epoch``. ``ConversationConsumer`` is included because it is
  the one that streams the owner's private AI output token by token, and
  it had no per-user group membership at all before this change.
* **the over-broad control** — bumping Alice must not close Bob's socket. Every
  positive assertion here would pass just as happily against a broadcast that
  disconnects the entire platform on every password change.
* **the cross-talk control** — an ordinary ``events_message`` push must NOT
  close a conversation socket. This is the specific hazard that made a
  dedicated revocation group necessary rather than reusing ``user_<id>``:
  channels turns an undispatchable message type into a ``ValueError`` that
  kills the consumer, so joining ``user_<id>`` would have made every
  notification tear down every open AI stream.
* **the failure mode** — a channel layer that raises must not fail the
  credential change that already committed.

Both channel layers, for the reason ``test_ws_consumer.py`` gives at length: an
``InMemoryChannelLayer`` cannot see a break inside ``channels_redis``, which is
what actually runs in production.
"""

import os
from unittest import mock

import pytest
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.test import override_settings

from dj.apps.events.consumers import EventConsumer
from dj.apps.events.revocation import (
    REVOCATION_CLOSE_CODE,
    REVOCATION_MESSAGE_TYPE,
    disconnect_live_sockets,
    revocation_group,
)
from dj.apps.ktauth import epoch
from dj.apps.openai.consumers import ConversationConsumer
from dj.free2z.channel_layer_config import redis_channel_layer_config

REDIS_HOST = os.environ.get("REDIS_HOST")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))

IN_MEMORY_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
}

REDIS_LAYERS = {
    "default": redis_channel_layer_config(
        host=REDIS_HOST or "127.0.0.1",
        port=REDIS_PORT,
        # A prefix of its own: this suite and test_ws_consumer.py may run
        # against the same Redis, and a shared prefix would let one file's
        # group membership answer the other file's broadcast.
        prefix="test-ws-revocation",
    ),
}

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

# Generous relative to the work (one group_send, one close frame), tight enough
# that a broadcast which never happens fails in seconds rather than hanging the
# suite. The redis path adds a round trip over loopback.
CLOSE_TIMEOUT_SECONDS = 5


async def _profile_socket(user):
    """An open ``EventConsumer`` connection authenticated as ``user``.

    The consumer is instantiated directly rather than behind
    ``AuthMiddlewareStack``, exactly as ``test_ws_consumer.py`` does it:
    ``scope["user"]`` is what the consumer reads, and the middleware's own
    session lookup is not what is under test here.
    """
    communicator = WebsocketCommunicator(EventConsumer.as_asgi(), "/ws/profile")
    communicator.scope["user"] = user
    return communicator


async def _conversation_socket(user, conversation_id):
    communicator = WebsocketCommunicator(
        ConversationConsumer.as_asgi(),
        f"/ws/conversations/{conversation_id}/",
    )
    communicator.scope["user"] = user
    communicator.scope["url_route"] = {
        "kwargs": {"conversation_id": str(conversation_id)}
    }
    return communicator


def _make_conversation(user):
    from dj.apps.openai.models import AIModel, Conversation

    ai_model = AIModel.objects.create(
        model="gpt-test",
        display_name="Test Model",
        system_message="be helpful",
        max_tokens=4096,
        is_ga=True,
    )
    return Conversation.objects.create(
        ai_model=ai_model,
        user=user,
        display_name=f"{user.username}'s private chat",
    )


async def _assert_closed_by_revocation(communicator):
    """The socket was closed, and closed with the revocation code.

    Asserting on the code and not merely on "it closed" is deliberate: a
    consumer that crashed for an unrelated reason also closes, and a test that
    accepts any close would go green on a bug.
    """
    message = await communicator.receive_output(timeout=CLOSE_TIMEOUT_SECONDS)
    assert message["type"] == "websocket.close", message
    assert message.get("code") == REVOCATION_CLOSE_CODE, message


# --------------------------------------------------------------- the positive


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_an_ownership_event_closes_a_live_profile_socket(
    creator_factory, layers,
):
    """The  attack's last surface: the socket that was already open.

    Driven through the real entry point — ``bump_account_epoch``, which is what
    all ~10 credential routes call — rather than by hand-sending the group
    message, so the wiring between the epoch module and the consumer is under
    test and not just the consumer's handler.

    ``transaction=True`` matters here: the disconnect is fired from
    ``transaction.on_commit``, which in a plain ``django_db`` test never runs
    because the enclosing atomic is rolled back rather than committed.
    """
    user = await database_sync_to_async(creator_factory)()

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _profile_socket(user)
        connected, _ = await communicator.connect()
        assert connected, "WebSocket connect failed"

        await database_sync_to_async(epoch.bump_account_epoch)(
            user.pk, event=epoch.EVENT_PASSWORD_RESET,
        )

        await _assert_closed_by_revocation(communicator)
        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_an_ownership_event_closes_a_live_conversation_socket(
    creator_factory, layers,
):
    """The AI stream goes too.

    ``ConversationConsumer`` joins only ``conversation_<uuid>``, so before this
    change nothing addressed to the *account* could reach it — an evicted party
    kept watching the owner's generation stream token by token, which is the
    disclosure  closed from the other direction.
    """
    user = await database_sync_to_async(creator_factory)()
    conversation = await database_sync_to_async(_make_conversation)(user)

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _conversation_socket(user, conversation.id)
        connected, _ = await communicator.connect()
        assert connected, "WebSocket connect failed"

        await database_sync_to_async(epoch.bump_account_epoch)(
            user.pk, event=epoch.EVENT_SOCIAL_IDENTITY_UNLINKED,
        )

        await _assert_closed_by_revocation(communicator)
        await communicator.disconnect()


# ---------------------------------------------------------------- the controls


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_revocation_does_not_close_another_accounts_socket(
    creator_factory, layers,
):
    """Bumping Alice must leave Bob connected.

    Without this, a broadcast to a global group — or a group name built from
    the wrong id — passes every other test in this file while signing the whole
    platform out on every password change.
    """
    alice = await database_sync_to_async(creator_factory)(username="ws-alice")
    bob = await database_sync_to_async(creator_factory)(username="ws-bob")

    with override_settings(CHANNEL_LAYERS=layers):
        alice_socket = await _profile_socket(alice)
        bob_socket = await _profile_socket(bob)
        assert (await alice_socket.connect())[0]
        assert (await bob_socket.connect())[0]

        await database_sync_to_async(epoch.bump_account_epoch)(
            alice.pk, event=epoch.EVENT_PASSWORD_CHANGE,
        )

        await _assert_closed_by_revocation(alice_socket)

        # Bob's socket is still live: it takes an ordinary push and delivers
        # it. "Nothing arrived" would be a weaker assertion — a closed socket
        # also delivers nothing.
        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"user_{bob.id}",
            {"type": "events.message", "message": "still here", "kind": "test"},
        )
        payload = await bob_socket.receive_json_from(
            timeout=CLOSE_TIMEOUT_SECONDS,
        )
        assert payload["message"] == "still here"

        await alice_socket.disconnect()
        await bob_socket.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_an_ordinary_notification_does_not_close_a_conversation_socket(
    creator_factory, layers,
):
    """The reason revocation got a group of its own.

    ``push_events`` sends ``{"type": "events_message"}`` to ``user_<id>``, and
    ``ConversationConsumer`` has no such handler — channels raises
    ``ValueError: No handler for message type`` and the consumer dies. Putting
    that consumer into ``user_<id>`` to make it reachable would therefore have
    turned every notification into a torn-down AI stream. This test fails if
    anyone ever "simplifies" the two groups back into one.
    """
    user = await database_sync_to_async(creator_factory)()
    conversation = await database_sync_to_async(_make_conversation)(user)

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _conversation_socket(user, conversation.id)
        assert (await communicator.connect())[0]

        channel_layer = get_channel_layer()
        await channel_layer.group_send(
            f"user_{user.id}",
            {"type": "events.message", "message": "hello", "kind": "test"},
        )

        assert await communicator.receive_nothing(timeout=1)

        #...and it is still revocable afterwards, which is what proves the
        # socket is genuinely healthy rather than merely quiet.
        await channel_layer.group_send(
            revocation_group(user.id), {"type": REVOCATION_MESSAGE_TYPE},
        )
        await _assert_closed_by_revocation(communicator)
        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_a_disconnected_socket_leaves_no_group_membership(
    creator_factory, layers,
):
    """Closing the tab gives the revocation group membership back.

    A leaked membership is not a security hole — the channel is gone — but it
    is unbounded growth in the layer, and on Redis a group whose members never
    expire is a slow leak per reconnect.
    """
    user = await database_sync_to_async(creator_factory)()

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _profile_socket(user)
        assert (await communicator.connect())[0]
        await communicator.disconnect()

        channel_layer = get_channel_layer()
        if not hasattr(channel_layer, "groups"):
            pytest.skip("channel layer does not expose group membership")
        assert not channel_layer.groups.get(revocation_group(user.id))


# ------------------------------------------------------- the handshake race


def _live_session_for(user):
    """A session row shaped like a real login, hash included.

    The hash is not decoration. `django.contrib.auth.get_user` refuses a
    session that carries no `_auth_user_hash`, so a row with only
    `_auth_user_id` does not authenticate anybody on an ordinary request
    either -- and the connect-time recheck compares that hash against a
    freshly read account, because the sweep that would otherwise have
    emptied this row is best effort.
    """
    from django.contrib.sessions.backends.db import SessionStore

    store = SessionStore()
    store["_auth_user_id"] = str(user.pk)
    store["_auth_user_hash"] = user.get_session_auth_hash()
    store.create()
    return store.session_key


def _session_payload(session_key):
    from django.contrib.sessions.backends.db import SessionStore

    return SessionStore(session_key=session_key).load()


async def _socket_with_session(user, session_key):
    """A handshake whose scope carries a session, the way the middleware leaves it.

    The `LazyObject` wrapper is the load-bearing detail, not ceremony.
    Channels' `SessionMiddleware` puts a bare `LazyObject` in the scope and
    assigns the real store to its `_wrapped` (channels 4.3.2,
    `channels/sessions.py`), so anything the recheck does with
    `type(scope["session"])` sees `LazyObject` and not the session backend.
    Injecting a plain `SessionStore` here made these tests blind to exactly
    that, and a recheck that instantiated `type(session)` would have raised
    `TypeError` on every authenticated handshake in production while every
    test stayed green.
    """
    from django.contrib.sessions.backends.db import SessionStore
    from django.utils.functional import LazyObject

    communicator = WebsocketCommunicator(EventConsumer.as_asgi(), "/ws/profile")
    communicator.scope["user"] = user
    scope_session = LazyObject()
    scope_session._wrapped = SessionStore(session_key=session_key)
    communicator.scope["session"] = scope_session
    return communicator


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_a_handshake_that_missed_the_broadcast_is_still_refused(
    creator_factory, layers,
):
    """The one-shot broadcast has a handshake-sized hole; the recheck closes it.

    ``AuthMiddlewareStack`` resolves ``scope["user"]`` and caches it, and there
    is a window between that and ``group_add`` in which a revocation reaches
    nobody. An attacker can widen it at will by opening sockets in a loop while
    the owner resets the account. This models the losing interleaving directly:
    the scope carries the identity and the session key the middleware resolved,
    and the session row is already gone by the time the consumer runs.

    Raised by the codex adversarial review of this branch.
    """
    user = await database_sync_to_async(creator_factory)()
    session_key = await database_sync_to_async(_live_session_for)(user)
    await database_sync_to_async(epoch.bump_account_epoch)(
        user.pk, event=epoch.EVENT_PASSWORD_RESET,
    )

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _socket_with_session(user, session_key)
        connected, code = await communicator.connect()
        assert not connected
        assert code == REVOCATION_CLOSE_CODE
        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_a_handshake_is_refused_even_when_the_session_sweep_failed(
    creator_factory, layers,
):
    """The recheck must not depend on the asynchronous sweep having worked.

    Raised by the codex adversarial review, at P1. The sweep is a durable
    worker job and can fail without changing the already-committed request.
    So the row can survive an ownership event with its payload intact,
    `_auth_user_id` and all. A recheck that asked "is there a row"
    or even "does this row name this user" then accepts a handshake that
    lost the broadcast race, and no later broadcast is coming: the evicted
    party keeps receiving the owner's private notifications and AI output
    for the life of the connection.

    What holds regardless is the stored auth hash against a freshly read
    account, which is where the epoch lives -- the same check every ordinary
    request makes. So: sweep raises, row untouched, socket still refused.
    """
    user = await database_sync_to_async(creator_factory)()
    session_key = await database_sync_to_async(_live_session_for)(user)

    with mock.patch.object(
        epoch, "_sweep_sessions_page", side_effect=RuntimeError("db went away"),
    ):
        await database_sync_to_async(epoch.bump_account_epoch)(
            user.pk, event=epoch.EVENT_PASSWORD_RESET,
        )
        def run_failed_job():
            from procrastinate.contrib.django.models import ProcrastinateJob
            from dj.apps.ktauth.tasks import sweep_sessions

            job = ProcrastinateJob.objects.get(
                task_name="ktauth.sweep_sessions", args__user_id=user.pk, status="todo",
            )
            sweep_sessions(**job.args)

        with pytest.raises(RuntimeError, match="db went away"):
            await database_sync_to_async(run_failed_job)()

    # The precondition the test would be worthless without: the row really
    # did survive with its identity intact.
    payload = await database_sync_to_async(_session_payload)(session_key)
    assert payload.get("_auth_user_id") == str(user.pk), payload

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _socket_with_session(user, session_key)
        connected, code = await communicator.connect()
        assert not connected
        assert code == REVOCATION_CLOSE_CODE
        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("layers", LAYER_PARAMS)
async def test_a_handshake_with_a_live_session_still_connects(
    creator_factory, layers,
):
    """The positive control for the recheck.

    A liveness check that refused everything would pass the test above and take
    every WebSocket on the platform down with it.
    """
    user = await database_sync_to_async(creator_factory)()
    session_key = await database_sync_to_async(_live_session_for)(user)

    with override_settings(CHANNEL_LAYERS=layers):
        communicator = await _socket_with_session(user, session_key)
        connected, _ = await communicator.connect()
        assert connected
        await communicator.disconnect()


# --------------------------------------------------------------- failure modes


@pytest.mark.django_db
def test_a_broken_channel_layer_does_not_fail_the_credential_change(
    creator_factory, caplog,
):
    """Redis being down must not make password changes start failing.

    The durable half of the revocation (Knox tokens, session rows) has already
    committed by the time this runs; raising here would report failure for an
    operation that fully succeeded. It must be loud, though — an ERROR record
    naming the account — because "we could not hang up on them" is a fact an
    operator needs and a return value nobody reads is not.
    """
    import logging

    user = creator_factory()

    with mock.patch(
        "channels.layers.get_channel_layer",
        side_effect=RuntimeError("redis is down"),
    ):
        with caplog.at_level(logging.ERROR, logger="dj.apps.events.revocation"):
            assert disconnect_live_sockets(user.pk) is False

    assert any(
        record.levelno >= logging.ERROR and str(user.pk) in record.getMessage()
        for record in caplog.records
    ), caplog.records


@pytest.mark.django_db
def test_the_bump_still_revokes_tokens_when_the_socket_broadcast_fails(
    creator_factory,
):
    """The split that matters: durable credentials die even if the socket does not.

    A channel layer that raises leaves the evicted party holding one push-only
    connection until it drops. It must not leave them holding a Knox token.
    """
    from knox.models import AuthToken

    user = creator_factory()
    AuthToken.objects.create(user)

    with mock.patch(
        "channels.layers.get_channel_layer",
        side_effect=RuntimeError("redis is down"),
    ):
        epoch.bump_account_epoch(user.pk, event=epoch.EVENT_PASSWORD_CHANGE)

    assert not AuthToken.objects.filter(user_id=user.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_a_rolled_back_ownership_event_does_not_close_any_socket(
    creator_factory,
):
    """The disconnect is fired ``on_commit``, so a rolled-back change fires none.

    Disconnecting inline would be an irreversible side effect ordered BEFORE
    the commit that justifies it: a transaction that later rolls back (a
    validation error, a deadlock, the admin's bulk delete failing on the next
    row) would have signed a user out of a live socket for a credential change
    that never happened.
    """
    from django.db import transaction

    user = creator_factory()

    with mock.patch(
        "dj.apps.events.revocation.disconnect_live_sockets"
    ) as disconnect:
        with pytest.raises(RuntimeError):
            with transaction.atomic():
                epoch.bump_account_epoch(
                    user.pk, event=epoch.EVENT_PASSWORD_CHANGE,
                )
                raise RuntimeError("something later in the request failed")

    disconnect.assert_not_called()
