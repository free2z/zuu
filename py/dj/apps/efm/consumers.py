import logging

import json
from typing import List
import jwt
from datetime import datetime, timezone
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


class SignalingConsumer(AsyncWebsocketConsumer):
    JWT_SECRET = settings.SECRET_KEY
    JWT_ALGORITHM = "HS256"

    async def connect(self):
        self.group_id = self.scope['url_route']['kwargs']['group_id']
        self.room_group_name = f'signaling_{self.group_id}'

        # Join the room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()
        print(f"Connected: {self.channel_name} joined group {self.group_id}")

    async def disconnect(self, close_code):
        print(f"Disconnecting: {self.channel_name} leaving group {self.group_id}")
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
            print(f"Received message of type {message_type}: {data}")

            if message_type == 'join':
                await self.handle_join(JoinMessage(**data))

            elif message_type == 'change_name':
                await self.handle_change_name(ChangeNameMessage(**data))

            elif message_type in ['offer', 'answer', 'ice_candidate']:
                await self.handle_signaling_message(SignalingMessage(**data))

        except ValidationError as e:
            print(f"Validation error: {e}")
            await self.send(text_data=ErrorResponse(
                type='error',
                error='Invalid message format',
                details=str(e)
            ).model_dump_json())

    async def handle_join(self, message: JoinMessage):
        print(f"Handling join for participant with UUID {message.uuid} and token {message.token}")
        self.participant_uuid = message.uuid
        token = message.token

        try:
            decoded_token = jwt.decode(token, self.JWT_SECRET, algorithms=[self.JWT_ALGORITHM])
            if decoded_token.get('participant_uuid') != self.participant_uuid:
                raise jwt.InvalidTokenError("Token participant UUID does not match")

            token_exp = datetime.fromtimestamp(decoded_token.get('exp'), tz=timezone.utc)
            if token_exp < datetime.now(timezone.utc):
                raise jwt.ExpiredSignatureError("Token has expired")

            print(f"Token verified successfully for participant {self.participant_uuid}")

            group_data = cache.get(self.group_id, {'participants': {}})
            group_data['participants'][self.participant_uuid] = {
                'uuid': self.participant_uuid,
                'name': message.name,
                'channel_name': self.channel_name,
                'websocketState': True,
            }
            cache.set(self.group_id, group_data)

            await self.broadcast_full_participant_list()

        except jwt.ExpiredSignatureError as e:
            await self.send(text_data=ErrorResponse(
                type='error',
                error='Token expired',
                details=str(e)
            ).model_dump_json())
            print(f"Expired token for participant {self.participant_uuid}: {e}")

        except jwt.InvalidTokenError as e:
            await self.send(text_data=ErrorResponse(
                type='error',
                error='Invalid token',
                details=str(e)
            ).model_dump_json())
            print(f"Invalid token for participant {self.participant_uuid}: {e}")

        except Exception as e:
            await self.send(text_data=ErrorResponse(
                type='error',
                error='Authentication failed',
                details=str(e),
            ).model_dump_json())
            print(f"Authentication failed for participant {self.participant_uuid}: {e}")
            logger.exception(e)

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
        group_data = cache.get(self.group_id, {'participants': {}})
        if message.uuid in group_data['participants']:
            group_data['participants'][message.uuid]['name'] = message.name
            cache.set(self.group_id, group_data)

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'name_changed',
                'uuid': message.uuid,
                'name': message.name
            }
        )

    async def handle_signaling_message(self, message: SignalingMessage):
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
