import logging

import json
from typing import List, Optional
import jwt
from channels.generic.websocket import AsyncWebsocketConsumer
from django.core.cache import cache
from django.conf import settings
from pydantic import ValidationError
from channels.db import database_sync_to_async

from .types import (
    JoinMessage, ChangeNameMessage, SignalingMessage,
    UpdateParticipantsMessage, NameChangedMessage, ErrorResponse
)

logger = logging.getLogger(__name__)

# The WebSocket subprotocol used to carry the participant's JWT through the
# handshake. Browsers cannot set arbitrary headers on a WebSocket, and a query
# string would put the bearer token into every proxy/access log, so the token
# rides in `Sec-WebSocket-Protocol` instead:
#
#     new WebSocket(url, [SIGNALING_SUBPROTOCOL, token])
#
# A JWT is base64url + '.', every character of which is a legal HTTP token
# character, so it is a valid subprotocol value.
SIGNALING_SUBPROTOCOL = "frost-signaling-v1"

# Application close codes (4000-4999 is the private-use range). Note that when
# the handshake itself is rejected the browser only ever sees a failed upgrade
# (1006); these codes are the ASGI-level contract and what tests assert on.
CLOSE_UNAUTHENTICATED = 4401  # missing / malformed / expired / forged token
CLOSE_FORBIDDEN = 4403        # valid token, but not a participant of this group


class SignalingConsumer(AsyncWebsocketConsumer):
    JWT_SECRET = settings.SECRET_KEY
    JWT_ALGORITHM = "HS256"

    async def connect(self):
        """Authenticate during the handshake, before joining the room group.

        Nothing about this socket is trusted until a valid JWT for a
        participant *of this group* has been presented. An unauthenticated
        socket is refused outright rather than being accepted and left to sit
        in the room observing membership traffic.
        """
        self.group_id = self.scope['url_route']['kwargs']['group_id']
        self.room_group_name = f'signaling_{self.group_id}'
        # Set before any close() so disconnect() can run safely on a rejected
        # handshake.
        self.participant_uuid = None

        token = self._token_from_handshake()
        if token is None:
            logger.warning(
                "Signaling connect refused: no token offered in handshake "
                "for group room"
            )
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return

        participant_uuid = self._participant_uuid_from_token(token)
        if participant_uuid is None:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return

        is_member = await database_sync_to_async(self.is_group_participant)(
            participant_uuid, self.group_id
        )
        if not is_member:
            logger.warning(
                "Signaling connect refused: participant %s is not a member of "
                "the requested group", participant_uuid,
            )
            await self.close(code=CLOSE_FORBIDDEN)
            return

        self.participant_uuid = participant_uuid

        # Join the room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept(subprotocol=SIGNALING_SUBPROTOCOL)
        logger.info(
            "Signaling connected: participant %s joined a group room",
            self.participant_uuid,
        )

    def _token_from_handshake(self) -> Optional[str]:
        """Pull the JWT out of the offered WebSocket subprotocols.

        The client offers ``[SIGNALING_SUBPROTOCOL, <jwt>]``; anything that
        does not follow that shape is treated as no token at all.
        """
        subprotocols = self.scope.get('subprotocols') or []
        if SIGNALING_SUBPROTOCOL not in subprotocols:
            return None
        for candidate in subprotocols:
            if candidate and candidate != SIGNALING_SUBPROTOCOL:
                return candidate
        return None

    def _participant_uuid_from_token(self, token: str) -> Optional[str]:
        """Verify the JWT and return its participant UUID, or None."""
        try:
            decoded = jwt.decode(
                token,
                self.JWT_SECRET,
                algorithms=[self.JWT_ALGORITHM],
                options={"require": ["exp", "participant_uuid"]},
            )
        except jwt.ExpiredSignatureError:
            logger.warning("Signaling connect refused: expired token")
            return None
        except jwt.InvalidTokenError as e:
            logger.warning("Signaling connect refused: invalid token (%s)", e)
            return None

        participant_uuid = decoded.get('participant_uuid')
        if not participant_uuid:
            logger.warning("Signaling connect refused: token has no participant_uuid")
            return None
        return str(participant_uuid)

    @staticmethod
    def is_group_participant(participant_uuid: str, group_id: str) -> bool:
        """True iff `participant_uuid` is a registered participant of `group_id`.

        The JWT only binds a token to a participant, not to a room, so without
        this check a token minted for one group would open a socket into any
        other group's signaling room. `group_id` comes straight off the URL and
        may not be a UUID at all, hence the ValueError guard.
        """
        from django.core.exceptions import ValidationError as DjangoValidationError
        from .models import Participant

        try:
            return Participant.objects.filter(
                uuid=participant_uuid,
                group__uuid=group_id,
                webauthn_credential_id__isnull=False,
            ).exclude(webauthn_credential_id='').exists()
        except (ValueError, TypeError, DjangoValidationError):
            # Malformed UUID in the URL or the token.
            return False

    async def disconnect(self, close_code):
        logger.info("Signaling disconnecting: %s", self.channel_name)
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

        if hasattr(self, 'participant_uuid') and self.participant_uuid is not None:
            group_data = cache.get(self.group_id, {'participants': {}})
            if self.participant_uuid in group_data['participants']:
                group_data['participants'][self.participant_uuid]['websocketState'] = False
                cache.set(self.group_id, group_data)

                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'update_participants',
                        'participants': group_data['participants'],
                    }
                )

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            message_type = data.get('type')
            logger.debug("Received signaling message of type %s", message_type)

            if message_type == 'join':
                await self.handle_join(JoinMessage(**data))

            elif message_type == 'change_name':
                await self.handle_change_name(ChangeNameMessage(**data))

            elif message_type in ['offer', 'answer', 'ice_candidate']:
                await self.handle_signaling_message(SignalingMessage(**data))

        except ValidationError as e:
            logger.warning("Signaling message failed validation: %s", e)
            await self.send(text_data=ErrorResponse(
                type='error',
                error='Invalid message format',
                details=str(e)
            ).model_dump_json())

    async def handle_join(self, message: JoinMessage):
        """Announce presence for the *already authenticated* participant.

        Authentication happens in `connect()`; by the time a `join` arrives the
        identity is settled, so `message.uuid` is ignored in favour of the UUID
        the JWT was issued for. Any `token` field is likewise ignored — it is
        vestigial and kept only so an in-flight older client's message still
        parses.
        """
        logger.debug("Handling join for participant %s", self.participant_uuid)

        group_data = cache.get(self.group_id, {'participants': {}})
        group_data['participants'][self.participant_uuid] = {
            'uuid': self.participant_uuid,
            'name': message.name,
            'channel_name': self.channel_name,
            'websocketState': True,
        }
        cache.set(self.group_id, group_data)

        await self.broadcast_full_participant_list()

    async def broadcast_full_participant_list(self):
        # Query the database asynchronously using `database_sync_to_async`
        uuids: List[str] = await database_sync_to_async(
            self.get_full_participant_list
        )(self.group_id)

        # Get current presence data from cache
        group_data = cache.get(self.group_id, {'participants': {}})
        logger.info(f"Group data: {group_data}")

        # Merge the data: Add connection info from the cache to the participants list from the database
        participants_with_presence = {}
        for uuid in uuids:
            gd_participant = group_data['participants'].get(uuid, {})
            participants_with_presence[uuid] = {
                'uuid': uuid,
                'name': gd_participant.get('name', f"{uuid}"),
                'websocketState': gd_participant.get('websocketState', False),
                'channel_name': gd_participant.get('channel_name', None)
            }

        logger.info(f"Participants with presence: {participants_with_presence}")
        # Send the full participant list to all group members
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'update_participants',
                'participants': participants_with_presence,
            }
        )

    @staticmethod
    def get_full_participant_list(group_id):
        from .models import Participant
        # Query the database for participants with valid credentials (name is not in the DB)
        return [str(u['uuid']) for u in Participant.objects.filter(
            group_id=group_id,
            webauthn_credential_id__isnull=False,
        ).exclude(
            webauthn_credential_id='',
        ).values('uuid')]

    async def handle_change_name(self, message: ChangeNameMessage):
        # A participant may only rename itself; the uuid on the wire is
        # advisory, the authenticated one from connect() is authoritative.
        uuid = self.participant_uuid
        group_data = cache.get(self.group_id, {'participants': {}})
        if uuid in group_data['participants']:
            group_data['participants'][uuid]['name'] = message.name
            cache.set(self.group_id, group_data)

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'name_changed',
                'uuid': uuid,
                'name': message.name
            }
        )

    async def handle_signaling_message(self, message: SignalingMessage):
        # Never let a client claim to be someone else's peer.
        message.source = self.participant_uuid
        group_data = cache.get(self.group_id, {'participants': {}})
        target_uuid = message.target
        if target_uuid in group_data['participants']:
            target_channel_name = group_data['participants'][target_uuid]['channel_name']
            if target_channel_name:
                await self.channel_layer.send(target_channel_name, {
                    'type': 'webrtc_message',
                    'message': message.model_dump()
                })

    async def webrtc_message(self, event):
        await self.send(text_data=json.dumps(event['message']))

    async def update_participants(self, event):
        await self.send(text_data=UpdateParticipantsMessage(
            participants=event['participants']
        ).model_dump_json())

    async def name_changed(self, event):
        await self.send(text_data=NameChangedMessage(
            uuid=event['uuid'],
            name=event['name']
        ).model_dump_json())
