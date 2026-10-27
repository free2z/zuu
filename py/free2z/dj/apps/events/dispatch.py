"""Durable notification creation for producers outside the web deployment.

The node needs only the application database: GKE's existing outbox relay
publishes after commit, and its periodic sweep recovers a missed wake-up.
WebSocket and future mobile consumers share the ordinary persistent Event
identity. Delivery is at least once; clients deduplicate using that identity.
"""
from django.conf import settings
from django.db import transaction

from dj.apps.jobs import outbox

from .models import Event


def create_durable_event(*, wake_up=True, **fields) -> Event:
    """Commit a normal unread notification and its delivery promise together.

    Call inside the domain transaction (e.g. the ZEC credit transaction).
    The nested atomic block also protects standalone callers: a failed outbox
    insert must never leave an Event with no delivery promise. Only this
    instance bypasses the legacy signal; ordinary Stripe events keep their
    existing publication path.
    """
    using = Event.objects.db
    with transaction.atomic(using=using):
        event = Event(**fields)
        event._durable_publication = True
        event.save(using=using, force_insert=True)
        outbox.enqueue(
            settings.PUBSUB['NEW_EVENT']['topic'],
            event.to_dict(),
            ordering_key=f'event-user:{event.receiving_user_id}',
            dedup_key=f'event:{event.pk}',
            attributes={'event_id': str(event.pk), 'event_type': event.type},
            using=using,
            wake_up=wake_up,
        )
    return event
