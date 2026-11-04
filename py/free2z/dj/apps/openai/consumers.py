from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
import json

from dj.apps.events.revocation import (
    REVOCATION_CLOSE_CODE,
    revocation_group,
    session_still_authenticates,
)


class ConversationConsumer(AsyncWebsocketConsumer):
    # Security: this used to `group_add` + `accept()` with NO auth and NO
    # ownership check, so anyone who knew a conversation UUID could subscribe to
    # `conversation_<uuid>` and watch another user's private AI response stream
    # token-by-token as it was generated (Conversation.generate group_sends
    # to exactly that group). Same disclosure as the REST IDOR, over a different
    # transport -- fixing only the viewset would have left this wide open.
    # `EventConsumer` in dj.apps.events is the pattern being mirrored here.

    room_group_name = None
    #Set once the connection is authenticated, so `disconnect` knows whether
    #there is a revocation-group membership to give back.
    revocation_group_name = None

    @database_sync_to_async
    def _owns_conversation(self, conversation_id):
        from .models import Conversation

        return Conversation.objects.filter(
            id=conversation_id, user=self.user
        ).exists()

    async def connect(self):
        from .permissions import valid_uuid

        self.user = self.scope.get("user")
        self.room_name = self.scope['url_route']['kwargs']['conversation_id']

        if self.user is None or self.user.is_anonymous:
            await self.close()
            return

        # Normalize to the canonical UUID BEFORE building the group name. The
        # route regex is `[A-Fa-f0-9\-]{36}` -- it accepts UPPERCASE -- while
        # `Conversation.generate` group_sends to `f'conversation_{self.id}'`,
        # i.e. str(UUID), which is always lowercase. Joining the raw URL string
        # would let an owner who connected with an uppercase id authenticate
        # fine and then silently receive nothing, because the producer publishes
        # to a differently-cased group. (Caught by the codex review.)
        conversation_id = valid_uuid(self.room_name)
        if conversation_id is None:
            await self.close()
            return

        if not await self._owns_conversation(conversation_id):
            await self.close()
            return

        self.room_group_name = f'conversation_{conversation_id}'

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        #...and the revocation group, so an account-ownership event can hang
        # up on this socket. `scope["user"]` came from the session at
        # CONNECT time and is never re-read, so deleting that session row does
        # not by itself stop this stream -- and what it streams is the owner's
        # private AI output token by token, which is the same disclosure
        # closed over the ownership check. A DEDICATED group, not `user_<id>`:
        # that one carries `events_message` traffic this consumer has no
        # handler for, and channels kills a consumer that receives a message
        # type it cannot dispatch. See dj/apps/events/revocation.py.
        self.revocation_group_name = revocation_group(self.user.id)
        await self.channel_layer.group_add(
            self.revocation_group_name,
            self.channel_name
        )

        # AFTER group_add, before accept -- the handshake race. See
        # `dj.apps.events.revocation.session_still_authenticates`.
        if not await session_still_authenticates(self.scope):
            await self.close(code=REVOCATION_CLOSE_CODE)
            return

        await self.accept()

    async def disconnect(self, close_code):
        # A rejected connection never joined a group; discarding a None group
        # name would raise during teardown.
        if self.revocation_group_name:
            await self.channel_layer.group_discard(
                self.revocation_group_name,
                self.channel_name
            )
        if not self.room_group_name:
            return
        # Leave room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def credentials_revoked(self, event):
        """The account's credentials were revoked: stop streaming to it.

        Named for `revocation.REVOCATION_MESSAGE_TYPE`. See the identically
        named handler on `dj.apps.events.consumers.EventConsumer`.
        """
        await self.close(code=REVOCATION_CLOSE_CODE)

    # # Receive message from WebSocket
    # async def receive(self, text_data):
    #     text_data_json = json.loads(text_data)
    #     message = text_data_json['message']

    #     # Send message to room group
    #     await self.channel_layer.group_send(
    #         self.room_group_name,
    #         {
    #             'type': 'chat_message',
    #             'message': message
    #         }
    #     )

    async def send_word(self, event):
        message = event['message']

        # Preserve the legacy payload for streams without an id. Correlated
        # generations add the id so clients can ignore late deltas from an
        # earlier request.
        payload = {'message': message}
        stream_id = event.get('stream_id')
        if stream_id is not None:
            payload['stream_id'] = stream_id

        # Send message to WebSocket
        await self.send(text_data=json.dumps(payload))
