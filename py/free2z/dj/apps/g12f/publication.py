"""Shared downstream publication side effects for zPages.

There are TWO producers of a ``PAGE_UPDATE`` message and they are not the
same kind of event, which is why this module has two functions rather than
one:

*func:`emit_page_update` is the REQUEST path (``zPageViewSet.publish_page``,
  called on every save of an already-published page). It is one broadcast per
  edit, decided by a human who is sitting there, and it publishes directly.
*func:`enqueue_page_update` is the QUEUE path
  (``g12f.notify_published_zpage``, deferred once by ``g12f.publish_zpage``
  when a scheduled page becomes public). Nobody is waiting on it, it can be
  retried by procrastinate, and it can be RECLAIMED -- so it must
  survive being run twice, and it does not publish at all: it writes the
  promise to the transactional outbox (``dj.apps.jobs.outbox``) under a
  dedup key and lets the relay publish.

WHY THE QUEUE PATH IS THE ONE THAT CHANGED
--------------------------------------------------
``notify_published_zpage``'s only gate was a read -- ``published_and_active()
.first()`` -- which BOTH copies of a duplicated run pass, followed by a bare
``PubSubClient().publish``. Nothing recorded that a broadcast had happened,
so a second run was a second broadcast: a second notification for every
follower and a second billed describe/tag call downstream. That is why the
task was ``NEVER`` in ``jobs.reclaim_policy`` and a stranded copy was never
healed.

The outbox row IS the record. ``dedup_key`` is UNIQUE in PostgreSQL, so the
second ``enqueue`` for the same broadcast is a no-op INSERT rather
than a second promise -- the collapse happens in the database, under the
producer's own transaction, which is the only place two concurrent producers
can be made to agree. An application-level ``exists()`` check cannot: it is
the same read-both-copies-pass shape as the gate that failed.

WHY THE REQUEST PATH DID NOT
-----------------------------
It is not a duplicate-run problem (there is no duplicate: one PATCH, one
call), and routing it through the outbox would persist EVERY autosave of a
published page -- a serialised zPage body, up to 100,000 characters -- into a
table whose rows are never deleted (``jobs.models.OutboxMessage``). That is a
storage decision with its own blast radius, and it is not what  asks
for. There is also nothing there to collapse: one PATCH is one broadcast, so
a dedup key would deduplicate nothing that is duplicated.
"""

import logging

from django.conf import settings
from django.db import transaction
from django.dispatch import Signal

from gcp.pubsub.client import PubSubClient

from dj.apps.g12f.serializers.zpage import zPageListSerializer
from dj.apps.jobs import outbox

#At most one PAGE_UPDATE per zPage in flight through the relay at a time,
#published in ``id`` order. Not forwarded to Pub/Sub (see
#``jobs.models.OutboxMessage.ordering_key``); it orders the RELAY, which is
#the guarantee the table can actually keep.
ORDERING_KEY_PREFIX = "zpage:"

logger = logging.getLogger(__name__)

#The dedup key's namespace. Keys are global across the whole outbox table.
DEDUP_KEY_PREFIX = "page_update:"

#``PubSubClient.publish`` defaults ``ensure_topic=True`` and this producer
#has always relied on it, while ``OutboxMessage.ensure_topic`` defaults to
#False. Passing it explicitly is what keeps the relay's behaviour identical
#to the direct publish in a namespace whose topic is created lazily -- a
#fresh stage/dev namespace, where the topic does not exist until the first
#publish makes it.
ENSURE_TOPIC = True


#Sent exactly when a zPage makes its FIRST draft -> public transition
#, from BOTH publication paths: ``zPage.save`` (immediate publish,
#admin, scripts) and ``g12f.publish_zpage`` (scheduled publish and the
#``publish_pages`` backstop, which calls it).
#
#"First" means ``published_at`` was NULL before this transition.
#``published_at`` is captured once and preserved across edit, unpublish and
#republish, so a later republish, an edit of a published page, a
#translation write or a score update never sends it. PAGE_UPDATE above is
#the wrong hook for this: it fires on every edit of a published page.
#
#CONTRACT FOR RECEIVERS
#
#* It is sent INSIDE the transaction that commits the transition, after the
#row is written. A receiver that records durable state (a unique ledger
#row, an outbox promise) gets rollback for free; anything with an
#external effect must be deferred with ``transaction.on_commit``.
#* ``zpage_id`` and ``using`` are the only arguments. Re-read the page;
#the sender may hold a stale instance or none at all.
#* It is a notification, not a guarantee of uniqueness. A receiver that must
#act at most once keys its own record on the page id under a UNIQUE
#constraint (the @F2ZP2P announcement ledger does:
#``zpage:first-published:{id}``), because two racing first transitions
#are serialized by the row lock but a legacy row with a NULL
#``published_at`` can still be "first-published" twice.
#* A receiver must not raise for a reason that should block publishing;
#Django's ``send`` propagates exceptions into the publish transaction.
#
#First-publication mention notifications  can connect here instead
#of running on every published save.
zpage_first_published = Signal()


def send_first_publication(zpage_id, using="default"):
    """Emit:data:`zpage_first_published`. Call inside the publish txn."""
    zpage_first_published.send(
        sender=send_first_publication, zpage_id=zpage_id, using=using,
    )


def page_update_message(instance):
    """``(topic, payload)`` for one page-update broadcast."""
    return (
        settings.PUBSUB["PAGE_UPDATE"]["topic"],
        zPageListSerializer(instance).data,
    )


def page_update_dedup_key(instance, broadcast_id: str) -> str:
    """The key that collapses a duplicated publication broadcast.

    ``broadcast_id`` identifies the BROADCAST, not the page and not the
    page's current contents, and the caller owns it. The task passes
    ``"job:<procrastinate job id>"``: procrastinate's retry
    (``procrastinate_retry_job_v1``) and the reclaimer's requeue
    (``JobManager.retry_job``) both UPDATE the same job row rather than
    inserting a new one, so every execution of one deferred job carries the
    same id -- and a genuinely new publication is a new ``defer`` from
    ``g12f.publish_zpage``, so it gets a new id and IS announced.

    Two page columns were tried first and both are wrong, each caught by a
    round of adversarial review:

    * ``published_at`` is "the first time this page became public", and
      ``publish_zpage``'s compare-and-set deliberately preserves it
      (``Case(When(published_at__isnull=True,...))``). A page that is
      unpublished, edited and SCHEDULED AGAIN days later therefore reuses
      the first publication's key, and its broadcast is dropped for ever.
    * ``updated_at`` fixes that and breaks the guarantee the reclaim budget
      rests on. It is MUTABLE: an autosave, or ``detect_zpage_language``
      writing a language back, moves it between two executions of ONE job,
      and the second execution then promises a SECOND message. The window
      is not the 30s of ``PUBLISH_RETRY`` -- a reclaim requeues a stranded
      job ~15 minutes later, and up to ``JOB_RECLAIM_MAX_RECLAIMS`` times,
      so it is minutes to hours wide.

    Nothing the page can do changes a job id, which is the property the
    ``EXTERNAL_EFFECT`` contract needs: "two executions of this job promise
    one message", unconditionally, rather than "unless the page changed in
    between".
    """
    return f"{DEDUP_KEY_PREFIX}{instance.pk}:{broadcast_id}"


def emit_page_update(instance):
    """Notify page-update consumers after a page is publicly available.

    The REQUEST path. Publishes directly; see the module docstring for why
    this one is not routed through the outbox.
    """
    if not instance.vanity:
        return

    topic, payload = page_update_message(instance)

    def publish():
        # BEST-EFFORT, after commit. The broadcast is a consequence of
        # the author's save, never a precondition of it: a Pub/Sub outage (or
        # `_ensure_topic`'s admin RPC timing out) used to 500 the save, and
        # since AtomicMiddleware rolls back on a raise it would now also
        # DISCARD the author's edit. And after commit, so a save that is
        # rolled back for any other reason is never announced.
        try:
            PubSubClient().publish(topic, payload)
        except Exception:
            logger.exception(
                "PAGE_UPDATE broadcast failed for zPage %s; the save stands",
                instance.pk,
            )

    transaction.on_commit(publish)


def enqueue_page_update(instance, broadcast_id: str):
    """Promise the same broadcast, transactionally and exactly once.

    The QUEUE path. ``broadcast_id`` is the identity of the broadcast (see
    :func:`page_update_dedup_key`). Returns the ``OutboxMessage`` -- which
    may be one an earlier execution already wrote, that being the point --
    or ``None`` for a page with no vanity, matching
    :func:`emit_page_update`'s no-op.
    """
    if not instance.vanity:
        return None

    topic, payload = page_update_message(instance)
    return outbox.enqueue(
        topic,
        payload,
        ordering_key=f"{ORDERING_KEY_PREFIX}{instance.pk}",
        dedup_key=page_update_dedup_key(instance, broadcast_id),
        ensure_topic=ENSURE_TOPIC,
    )
