from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver

from dj.apps.events.models import Event
from dj.apps.jobs import outbox
from .models import Comment


@receiver(post_save, sender=Comment)
def send_comment_to_pubsub(sender, instance: Comment, created, **kwargs):
    print("send_comment_to_pubsub", instance, created)
    if not created:
        return

    # send event for author spend
    Event.objects.create(
        type="MADE_COMMENT",
        receiving_user=instance.author,
        contributor=instance.author,
        amount=instance.tuzis,
        content_object=instance,
        read=True,
    )

    sent = False
    if instance.parent:
        if instance.parent.author != instance.author:
            Event.objects.create(
                type='NEW_REPLY',
                receiving_user=instance.parent.author,
                contributor=instance.author,
                content_object=instance,
            )
            sent = True

    content_object = instance.content_object
    if hasattr(content_object, 'author'):
        if content_object.author != instance.author and not sent:
            Event.objects.create(
                type='NEW_REPLY',
                receiving_user=content_object.author,
                contributor=instance.author,
                content_object=instance,
            )
    elif hasattr(content_object, 'creator'):
        if content_object.creator != instance.author and not sent:
            Event.objects.create(
                type='NEW_REPLY',
                # amount=instance.tuzis,
                receiving_user=content_object.creator,
                contributor=instance.author,
                content_object=instance,
            )

    # Send comment topic for AI score and tagging
    topic_name = settings.PUBSUB['NEW_COMMENT']['topic']
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

    # post_save runs inside the transaction that created the Comment, so the
    # publish must not happen here: a subscriber that resolves the UUID from
    # the database would get an event for an invisible (or subsequently
    # rolled-back) row.
    #
    # This used to be a bare `transaction.on_commit(... publish...)`. That is
    # correctly ORDERED but not DURABLE: a process killed between COMMIT and
    # the callback -- a rollout, an eviction, an SSR OOM -- commits the
    # comment and never publishes it, and nothing anywhere retries. The
    # comment is then never AI-scored and never tweeted, silently, forever.
    #
    #write the promise into the same transaction as the Comment and
    # let the relay publish it. Rollback un-promises it for free, and a crash
    # only delays the message.
    # @F2ZP2P announcement: a durable ledger row in THIS transaction,
    # so a rollback un-announces it and a crash cannot lose it. No-op while
    # F2ZP2P_ANNOUNCEMENTS is "off". Replaces the lossy `tweet_comments`
    # Pub/Sub listener, which ACKed every failed event away.
    from dj.apps.twitter.announcements import (
        fence_comment_for_retired_tweeter,
        on_comment_created,
    )

    # Always, whatever the kill switch says: the retired `tweet_comments`
    # listener acks a pre-claimed comment without posting, so a revert or a
    # scale-up of `comment-tweeter` cannot replay its subscription backlog.
    fence_comment_for_retired_tweeter(
        instance, using=kwargs.get('using') or 'default',
    )
    on_comment_created(instance, using=kwargs.get('using') or 'default')

    outbox.enqueue(
        topic_name,
        data,
        # Ordered per comment so an edit-driven republish (should one ever be
        # added) cannot overtake the creation event that the AI scorer needs
        # to see first.
        ordering_key=f'comment:{instance.uuid}',
        # Unchanged: this producer has always relied on the client creating
        # the topic when it is missing. Namespaced dev/test topics are
        # created lazily, so flipping this to False would break them.
        ensure_topic=True,
        using=kwargs.get('using'),
    )
