import logging

from .models import Event

from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.conf import settings

from gcp.pubsub.client import PubSubClient


logger = logging.getLogger(__name__)


@receiver(post_save, sender=Event)
def send_to_pubsub(sender, instance, created, **kwargs):
    if not created or getattr(instance, '_durable_publication', False):
        return

    topic_name = settings.PUBSUB['NEW_EVENT']['topic']
    data = instance.to_dict()

    def publish_committed_event():
        future = PubSubClient().publish(
            topic_name,
            data,
            ensure_topic=False,
        )
        if future is not None:
            future.add_done_callback(log_publish_failure)

    def log_publish_failure(future):
        try:
            future.result()
        except Exception:
            logger.exception(
                'Failed to publish committed Event %s', instance.pk)

    transaction.on_commit(
        publish_committed_event,
        using=kwargs.get('using'),
        robust=True,
    )
