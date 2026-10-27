"""PAGE_UPDATE consumer: one notification Event per fan, at most once.

WHY THE FAN-OUT IS LOCKED
---------------------------------
Delivery here is at-least-once and always has been -- Pub/Sub redelivers on
any expired ack deadline, and the outbox relay can republish a
message whose publish was in flight when it died. The dedup was an
`Event.objects.filter(...).exists()` over a 6-hour window followed by a
create-per-fan loop, with nothing between them: two deliveries in flight at
the same time BOTH read "no event yet" and BOTH fan out, so every follower
is notified twice and the AI describe/tag consumers pay twice. It is the
same read-both-copies-pass shape as the producer-side gate  replaced,
and it is why `g12f.notify_published_zpage` was NEVER reclaimable.

`Event` has no key this could be made unique on. Its natural key for this
event -- (receiving_user, type, content_type, object_id) -- is NOT unique by
design: a page legitimately produces a new PAGE_UPDATE for the same fan
every time it is edited more than six hours after the last one, and prod
holds many such rows, so a UNIQUE constraint would both be wrong and fail to
apply. Making one possible means a `dedup_key` column on `Event` and a
migration, which  explicitly defers.

So the check and the writes are made ATOMIC instead, with a
transaction-scoped Postgres advisory lock keyed on the zPage. The lock costs
nothing in the common case (no contention, no row, released by COMMIT or by
the connection dying), it serialises exactly the two deliveries that race,
and the second one then SEES the first one's events and no-ops. Without it
the window is the whole fan-out loop: one `create()` per follower.

WHAT THE TRANSACTION COSTS (codex rounds 1-3)
---------------------------------------------
The fan-out is all-or-nothing now. A database failure part-way through used
to leave the fans it had already reached notified; it rolls the whole thing
back instead, and `catch_errors` acks the message either way, so without
something else the failure would lose the announcement entirely rather than
half of it.

The transaction is not optional -- it is what makes the lock mean anything:
a check and a write in separate transactions are not serialised by holding a
lock across them. So the retry goes where it can go, in
`deliver_page_update`: `FAN_OUT_ATTEMPTS` bounded attempts on `DatabaseError`
alone, with the connection closed in between, which covers the failure that
actually produces this (a Cloud SQL failover, a pooler restart, a killed
connection) without touching the ack.

`catch_errors` itself still acknowledges every exception, and it is
copy-pasted into eight subscriber commands, so a failure that outlives the
retries
is still a lost announcement. Fixing that properly is a `nack` plus a
dead-letter policy -- an unconditional `nack` alone is an unbounded
redelivery loop for a message that can never succeed -- and that is a change
to the shared subscriber contract with its own blast radius. It is not
, and it is called out in this PR rather than smuggled in.
"""
import sys
import json
import time
import traceback
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.conf import settings
from django.utils import timezone
from django.contrib.contenttypes.models import ContentType

from google.cloud.pubsub_v1.subscriber.message import Message
from gcp.pubsub.client import PubSubClient

# from dj.apps.g12f.serializers import zPageListSerializer
from dj.apps.g12f.models import zPage, Creator
from dj.apps.events.models import Event

from django.db import (
    DatabaseError, close_old_connections, connection, transaction,
)


#How recently a PAGE_UPDATE for this page must have been sent for a new
#delivery to be a duplicate rather than a fresh update worth announcing.
DEDUP_WINDOW = timedelta(hours=6)

#Namespace for the advisory lock, so the key means "the PAGE_UPDATE
#fan-out for zPage N" and not merely "the number N". `hashtext` returns an
#int4, which resolves to the single-argument `pg_advisory_xact_lock(bigint)`
#overload. A hash collision with another advisory-lock holder in this
#codebase costs a little extra serialisation and nothing else -- the lock
#guards a correctness invariant, it is not a resource allocator.
LOCK_KEY_PREFIX = "page_update_fanout:"

#How many times one delivery may attempt the fan-out before giving up.
#The fan-out is atomic now, so a database failure part-way through rolls
#the whole announcement back -- and `catch_errors` acks, so Pub/Sub will
#not bring it round again. A bounded retry HERE is what keeps one dropped
#connection (a Cloud SQL failover, a pooler restart) from silently costing
#every follower their notification, without touching the ack contract the
#other four subscribers share or opening an unbounded redelivery loop on a
#message that can never succeed.
#
#Only `DatabaseError` is retried. A bug in the fan-out, or a page that does
#not deserialise, fails on the first attempt exactly as before -- retrying
#those would just cost 3 seconds of a callback slot on the way to the same
#traceback.
FAN_OUT_ATTEMPTS = 3

#Linear backoff between fan-out attempts, in SECONDS. Deliberately small:
#this sleeps a Pub/Sub callback thread, and `CALLBACK_WORKERS` is 2, so the
#worst case for the subscriber is both slots parked for
#(1 + 2) x this. It is sized for "the connection died, open a new one",
#not for riding out an outage -- the outage case is the message being
#acked and lost, which is what the outbox backlog alert and this
#subscriber's own logs are for.
FAN_OUT_RETRY_SECONDS = 1.0


def _lock_key(zpage_id) -> str:
    return f"{LOCK_KEY_PREFIX}{zpage_id}"


# TODO: move this to a utils file
def catch_errors(callback):
    def wrapper(message):
        try:
            close_old_connections()
            callback(message)
        except Exception:
            # log the traceback
            traceback.print_exc()
            sys.stdout.flush()
            message.ack()
    return wrapper


def fan_out_page_update(instance: zPage) -> int:
    """Create one PAGE_UPDATE Event per fan, at most once per window.

    Returns the number of events created -- 0 when this delivery was a
    duplicate. The whole decision runs inside ONE transaction behind the
    advisory lock, so a concurrent delivery for the same page waits here and
    then reads the events this one wrote.

    The events are created one at a time on purpose, not with
    `bulk_create()`: `events.signals.send_to_pubsub` is a `post_save`
    receiver that pushes the fan's websocket, and `bulk_create` does not send
    `post_save`. It publishes from `transaction.on_commit(robust=True)`, so
    nothing goes out for a fan-out that rolls back.
    """
    creator: Creator = instance.creator
    content_type = ContentType.objects.get_for_model(instance)

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                [_lock_key(instance.pk)],
            )

        if Event.objects.filter(
            type="PAGE_UPDATE",
            contributor=creator,
            updated_at__gte=timezone.now() - DEDUP_WINDOW,
            # content_object=instance,
            content_type=content_type,
            object_id=instance.pk,
        ).exists():
            return 0

        created = 0
        for fan in creator.get_fans():
            Event.objects.create(
                type="PAGE_UPDATE",
                contributor=creator,
                receiving_user=fan,
                content_object=instance,
            )
            created += 1
        return created


def deliver_page_update(instance: zPage) -> int:
    """`fan_out_page_update`, with a bounded retry on database failure.

    See `FAN_OUT_ATTEMPTS`. The connection is closed between attempts
    because the failure this exists for IS the connection: Django marks a
    connection unusable after an operational error and would hand the same
    dead one back, so a retry without this is three failures in a row.
    """
    for attempt in range(1, FAN_OUT_ATTEMPTS + 1):
        try:
            return fan_out_page_update(instance)
        except DatabaseError:
            traceback.print_exc()
            sys.stdout.flush()
            close_old_connections()
            if attempt == FAN_OUT_ATTEMPTS:
                raise
            time.sleep(FAN_OUT_RETRY_SECONDS * attempt)


@catch_errors
def callback(message: Message):
    sys.stdout.flush()
    data = json.loads(message.data.decode('utf-8'))
    print("callback page_update_subscriber", data)
    instance = zPage.objects.published_and_active().get(
        free2zaddr=data['free2zaddr']
    )

    created = deliver_page_update(instance)
    if not created:
        print("already sent within last 6 hours", instance.creator, instance)

    sys.stdout.flush()
    message.ack()


class Command(BaseCommand):
    def handle(self, *args, **options):
        print("page_update_subscribers")
        sys.stdout.flush()
        ps = PubSubClient()
        ps.subscribe(
            settings.PUBSUB["PAGE_UPDATE"]["topic"],
            settings.PUBSUB["PAGE_UPDATE"]["NOTIFY"],
            callback,
        )
