"""Handshake-time authentication for the FROST signaling WebSocket.

Why this file exists
--------------------
`SignalingConsumer.connect` used to accept *every* socket and join it to the
group's room, deferring the JWT check to the first `join` message. An
unauthenticated peer could therefore connect, sit in the room, and observe the
`update_participants` broadcasts of a threshold-signing group without ever
presenting a credential.

Authentication now happens during the handshake: the participant's JWT is
offered as a WebSocket subprotocol and verified in `connect()`, so a socket
that cannot prove membership of *this* group is refused before `group_add` is
ever called.

Note the deliberate split of close codes: 4401 means "no usable token",
4403 means "the token is real but it is not for this room". Over the wire a
browser only ever sees a failed upgrade (a handshake rejection cannot carry a
close code) -- these codes are the ASGI-level contract.
"""

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from channels.db import database_sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.conf import settings

from dj.apps.efm.consumers import (
    CLOSE_FORBIDDEN,
    CLOSE_UNAUTHENTICATED,
    SIGNALING_SUBPROTOCOL,
)
from dj.apps.efm.models import FrostGroup, Participant
from dj.apps.efm.routing import websocket_urlpatterns

JWT_ALGORITHM = "HS256"


def make_token(participant_uuid, *, lifetime=timedelta(hours=2), secret=None):
    """Mint a participant JWT exactly the way `views.py` does."""
    return jwt.encode(
        {
            "participant_uuid": str(participant_uuid),
            "exp": datetime.now(timezone.utc) + lifetime,
        },
        secret or settings.SECRET_KEY,
        algorithm=JWT_ALGORITHM,
    )


def create_group_with_participant(credential_id="cred-1"):
    group = FrostGroup.objects.create(max_participants=3)
    participant = Participant.objects.create(
        group=group,
        webauthn_public_key="pk",
        webauthn_credential_id=credential_id,
    )
    return group, participant


def communicator(group_id, subprotocols=None):
    return WebsocketCommunicator(
        URLRouter(websocket_urlpatterns),
        f"/ws/signaling/{group_id}/",
        subprotocols=subprotocols,
    )


async def assert_refused(comm, expected_code):
    connected, code = await comm.connect()
    assert not connected, "handshake should have been rejected"
    assert code == expected_code
    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_connect_without_any_subprotocol_is_refused():
    """The pre-fix behaviour: connect first, authenticate later. Now refused."""
    group, _ = await database_sync_to_async(create_group_with_participant)()
    await assert_refused(communicator(group.uuid), CLOSE_UNAUTHENTICATED)


@pytest.mark.django_db(transaction=True)
async def test_connect_with_marker_but_no_token_is_refused():
    group, _ = await database_sync_to_async(create_group_with_participant)()
    await assert_refused(
        communicator(group.uuid, [SIGNALING_SUBPROTOCOL]),
        CLOSE_UNAUTHENTICATED,
    )


@pytest.mark.django_db(transaction=True)
async def test_connect_with_garbage_token_is_refused():
    group, _ = await database_sync_to_async(create_group_with_participant)()
    await assert_refused(
        communicator(group.uuid, [SIGNALING_SUBPROTOCOL, "not-a-jwt"]),
        CLOSE_UNAUTHENTICATED,
    )


@pytest.mark.django_db(transaction=True)
async def test_connect_with_token_signed_by_the_wrong_key_is_refused():
    """A forged token must not be accepted just because it parses."""
    group, participant = await database_sync_to_async(create_group_with_participant)()
    forged = make_token(participant.uuid, secret="not-the-server-secret-" + "x" * 32)
    await assert_refused(
        communicator(group.uuid, [SIGNALING_SUBPROTOCOL, forged]),
        CLOSE_UNAUTHENTICATED,
    )


@pytest.mark.django_db(transaction=True)
async def test_connect_with_expired_token_is_refused():
    group, participant = await database_sync_to_async(create_group_with_participant)()
    expired = make_token(participant.uuid, lifetime=timedelta(seconds=-60))
    await assert_refused(
        communicator(group.uuid, [SIGNALING_SUBPROTOCOL, expired]),
        CLOSE_UNAUTHENTICATED,
    )


@pytest.mark.django_db(transaction=True)
async def test_token_for_another_group_cannot_open_this_room():
    """The JWT binds a token to a participant, not to a room.

    Without an explicit membership check a participant of group A could open a
    socket into group B's signaling room and watch its membership traffic.
    """
    _, other_participant = await database_sync_to_async(create_group_with_participant)(
        credential_id="cred-other"
    )
    target_group, _ = await database_sync_to_async(create_group_with_participant)(
        credential_id="cred-target"
    )
    token = make_token(other_participant.uuid)
    await assert_refused(
        communicator(target_group.uuid, [SIGNALING_SUBPROTOCOL, token]),
        CLOSE_FORBIDDEN,
    )


@pytest.mark.django_db(transaction=True)
async def test_participant_without_webauthn_credential_is_refused():
    """A half-registered participant has no credential, so it is not a member."""
    def _setup():
        group = FrostGroup.objects.create(max_participants=3)
        participant = Participant.objects.create(group=group, webauthn_public_key="")
        return group, participant

    group, participant = await database_sync_to_async(_setup)()
    token = make_token(participant.uuid)
    await assert_refused(
        communicator(group.uuid, [SIGNALING_SUBPROTOCOL, token]),
        CLOSE_FORBIDDEN,
    )


@pytest.mark.django_db(transaction=True)
async def test_nonexistent_group_id_is_refused_without_error():
    """A group id that is not even a UUID must be rejected, not blow up."""
    _, participant = await database_sync_to_async(create_group_with_participant)()
    token = make_token(participant.uuid)
    await assert_refused(
        communicator("not-a-uuid", [SIGNALING_SUBPROTOCOL, token]),
        CLOSE_FORBIDDEN,
    )


@pytest.mark.django_db(transaction=True)
async def test_authenticated_participant_connects_and_joins_end_to_end():
    """The happy path still works, all the way to a participant broadcast."""
    group, participant = await database_sync_to_async(create_group_with_participant)()
    token = make_token(participant.uuid)

    comm = communicator(group.uuid, [SIGNALING_SUBPROTOCOL, token])
    connected, subprotocol = await comm.connect()
    assert connected
    # The server must echo a subprotocol it was offered, or browsers fail the
    # connection. It must never echo the token itself.
    assert subprotocol == SIGNALING_SUBPROTOCOL

    await comm.send_json_to({"type": "join", "name": "Alice"})
    payload = await comm.receive_json_from(timeout=5)

    assert payload["type"] == "update_participants"
    me = payload["participants"][str(participant.uuid)]
    assert me["name"] == "Alice"
    assert me["websocketState"] is True

    await comm.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_join_cannot_impersonate_another_participant():
    """`join` carries a uuid; the authenticated identity must win.

    Authentication moved into the handshake, so the uuid on the wire is no
    longer what identifies the sender. If it were still trusted, an
    authenticated participant could register presence under someone else's
    uuid.
    """
    group, participant = await database_sync_to_async(create_group_with_participant)()

    def _second():
        return Participant.objects.create(
            group=group, webauthn_public_key="pk2", webauthn_credential_id="cred-2"
        )

    victim = await database_sync_to_async(_second)()
    token = make_token(participant.uuid)

    comm = communicator(group.uuid, [SIGNALING_SUBPROTOCOL, token])
    connected, _ = await comm.connect()
    assert connected

    await comm.send_json_to(
        {"type": "join", "name": "Impostor", "uuid": str(victim.uuid)}
    )
    payload = await comm.receive_json_from(timeout=5)

    participants = payload["participants"]
    assert participants[str(participant.uuid)]["name"] == "Impostor"
    # The victim is listed (it is a real group member) but is not marked as
    # connected and did not get renamed.
    assert participants[str(victim.uuid)]["websocketState"] is False
    assert participants[str(victim.uuid)]["name"] != "Impostor"

    await comm.disconnect()
