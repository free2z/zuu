"""
Subscribe to pubsub events and push them out to user channels
"""
import asyncio
import logging
import sys
import json
import time
import uuid
from django.core.management.base import BaseCommand
from django.conf import settings

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from google.cloud.pubsub_v1.subscriber.message import Message

from gcp.pubsub.client import PubSubClient
from dj.apps.events.models import Event

from django.db import close_old_connections

logger = logging.getLogger(__name__)
CHANNEL_SEND_TIMEOUT_SECONDS = 5


async def send_event(channel_layer, group, data):
    # A wedged Redis connection must return control to Pub/Sub so the message
    # can be retried. The persistent Event remains available to offline users.
    await asyncio.wait_for(
        channel_layer.group_send(
            group, {'type': 'events_message', 'content': data},
        ),
        timeout=CHANNEL_SEND_TIMEOUT_SECONDS,
    )


def catch_errors(callback):
    def wrapper(message):
        try:
            close_old_connections()
            callback(message)
        except Exception:
            logger.exception('Event push failed; requesting redelivery')
            # Database, serialization or Redis failures are retryable. ACKing
            # them permanently discarded a committed buyer notification.
            message.nack()
        finally:
            close_old_connections()
    return wrapper


@catch_errors
def callback(message: Message):
    time.sleep(1)
    sys.stdout.flush()
    try:
        data = json.loads(message.data.decode('utf-8'))
        event_id = uuid.UUID(data['id'])
    except (ValueError, TypeError, KeyError, AttributeError):
        # An invalid envelope can never resolve to an Event. Do not log its
        # body: notification payloads can contain private user content.
        logger.warning('Discarding malformed Event push envelope')
        message.ack()
        return
    try:
        ev = Event.objects.get(id=event_id)
    except Event.DoesNotExist:
        # A notification/user deleted while the message waited is terminal.
        message.ack()
        return
    # The realtime push must not deliver what the event list hides:
    # a reply, mention, vote or page-update ping from an account the receiver
    # blocked. Money receipts (chat requests already paid for included) are
    # pushed as before -- see BLOCK_HIDDEN_EVENT_TYPES.
    from dj.apps.g12f.blocks import event_hidden_by_block
    if event_hidden_by_block(ev):
        message.ack()
        return
    channel_layer = get_channel_layer()
    # Re-read the committed row, including current read state and recipient
    # redactions. A delayed/retried Pub/Sub snapshot must not revive private
    # content or stale counterparty names. The original Event id is stable
    # across retries, so browser/mobile clients can deduplicate deliveries.
    async_to_sync(send_event)(
        channel_layer, f"user_{ev.receiving_user_id}", ev.to_dict(),
    )
    message.ack()


class Command(BaseCommand):
    def handle(self, *args, **options):
        print("push_events")
        sys.stdout.flush()
        # openai.api_key = os.getenv("OPENAI_API_KEY")
        ps = PubSubClient()
        ps.subscribe(
            settings.PUBSUB["NEW_EVENT"]["topic"],
            settings.PUBSUB["NEW_EVENT"]["SOCKET"],
            callback,
        )
