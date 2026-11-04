"""
Subscribes to new comments and tags them


Bootstrap:

from dj.apps.comments.models import Comment
from f2z.openai.util import tag_content

comments_without_tags = Comment.objects.filter(tags__isnull=True)

for comment in comments_without_tags:
    print(comment)
    tags = tag_content(comment.get_content_for_ai_tagging())
    print(tags)
    shortened = [tag for tag in tags if len(tag) < 20]
    comment.tags.add(*shortened)
    comment.save()

"""
import sys
import json
import os
import logging
import traceback

from django.core.management.base import BaseCommand
from django.conf import settings

from gcp.pubsub.client import PubSubClient
from f2z.openai.util import tag_content

from dj.apps.comments.models import Comment, claim_comment_consumer

import openai

from django.db import DatabaseError, close_old_connections


CONSUMER = "tag_comments"
logger = logging.getLogger(__name__)


class RetryableCommentConsumerFailure(Exception):
    """A database failure happened before this delivery claimed its effect."""


def catch_errors(callback):
    def wrapper(message):
        try:
            close_old_connections()
            callback(message)
        except RetryableCommentConsumerFailure:
            traceback.print_exc()
            # No claim or external effect exists yet, so redelivery is safe.
            message.nack()
        except Exception:
            # log the traceback
            traceback.print_exc()
            # acknowledge the message
            message.ack()
    return wrapper


@catch_errors
def callback(message):
    """
    Message for new comment looks like this:

    data = {
        'uuid': str(instance.uuid),
        'headline': instance.headline,
        'content': instance.content,
        'tuzis': instance.tuzis,
        'author': instance.author.username,
        'created_at': str(instance.created_at),
        'updated_at': str(instance.updated_at),
        'parent_id': str(instance.parent_id) if instance.parent else None,
        'content_type': instance.content_type.id if instance.content_type else None,
        'object_id': instance.object_id,
    }
    """

    # take the message data and convert it to a dictionary
    data = json.loads(message.data.decode('utf-8'))

    try:
        comment = Comment.objects.get(uuid=data['uuid'])
        claimed = claim_comment_consumer(comment, CONSUMER)
    except DatabaseError as exc:
        # A transient database failure before the claim commits must not be
        # treated like a poison message: no provider call has begun and a
        # redelivery can safely try to acquire the claim again.
        raise RetryableCommentConsumerFailure() from exc
    sys.stdout.flush()

    if not claimed:
        # The claim is committed before the paid provider call.  A duplicate
        # delivery must not buy another tagging request or add tags again.
        message.ack()
        return

    try:
        tags = tag_content(comment.get_content_for_ai_tagging())
        comment.tags.add(*tags)
    except Exception:
        # The provider call and the database tag write are outside the claim
        # transaction. Keep the permanent claim because either may have
        # succeeded, and make the ambiguous outcome searchable for repair.
        logger.exception(
            "comment consumer external effect ambiguous comment_uuid=%s "
            "consumer=%s",
            comment.uuid,
            CONSUMER,
            extra={"comment_uuid": str(comment.uuid), "consumer": CONSUMER},
        )
        message.ack()
        return
    sys.stdout.flush()

    message.ack()


class Command(BaseCommand):
    def handle(self, *args, **options):
        print("tag_comments Listening for new comments...")
        sys.stdout.flush()
        ps = PubSubClient()

        ps.subscribe(
            settings.PUBSUB["NEW_COMMENT"]["topic"],
            settings.PUBSUB["NEW_COMMENT"]["TAG_COMMENTS"],
            callback,
        )


print("tag_comments loaded")
