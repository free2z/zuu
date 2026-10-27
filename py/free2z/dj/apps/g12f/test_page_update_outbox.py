""": the publication broadcast is promised once and fanned out once.

Two halves, one defect each, against real Postgres.

PRODUCER. `g12f.notify_published_zpage` used to gate on a read
(`published_and_active().first()`) that both copies of a duplicated run
pass, then publish to Pub/Sub with nothing recording that it had. It now
writes ONE row to the transactional outbox  under a UNIQUE
`dedup_key`, so the second run is a no-op INSERT resolved by an index --
which is why the task is reclaimable now instead of `NEVER`.

CONSUMER. `page_update_subscriber` dedups with a 6h `exists()` and then
creates one Event per fan. Nothing sat between the read and the writes, so
two deliveries in flight together both passed the check and both fanned
out. The check and the writes are now one transaction behind a
transaction-scoped advisory lock; `Event` has no key a UNIQUE constraint
could be hung on without a new column and a migration (see the subscriber's
module docstring).
"""
import threading
import uuid
from datetime import timedelta

import pytest
from django.db import OperationalError, connection, connections
from django.utils import timezone

from dj.apps.events.models import Event
from dj.apps.g12f.management.commands import page_update_subscriber as subscriber
from dj.apps.g12f.management.commands.page_update_subscriber import (
    _lock_key,
    fan_out_page_update,
)
from dj.apps.g12f.models import zPage
from dj.apps.g12f.models.creator import Subscription
from dj.apps.g12f.publication import (
    ENSURE_TOPIC,
    page_update_dedup_key,
    page_update_message,
)
from dj.apps.g12f.tasks import notify_published_zpage
from dj.apps.g12f.testing import job_context
from dj.apps.jobs.models import OutboxMessage


def _make_page(creator, **kwargs):
    defaults = dict(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        title="A published page",
        content="Content about a topic, long enough to be worth reading.",
        is_published=True,
        vanity=f"page-{uuid.uuid4().hex[:8]}",
    )
    defaults.update(kwargs)
    return zPage.objects.create(**defaults)


def _fan(creator_factory, star):
    fan = creator_factory()
    Subscription.objects.create(
        star=star, fan=fan, expires=timezone.now() + timedelta(days=30),
    )
    return fan


# ---------------------------------------------------------------------------
# producer: the promise is made once
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_two_runs_leave_one_outbox_row(creator_factory):
    """THE defect. A duplicated run must not promise a second broadcast.

    NEGATIVE CONTROL: drop the `dedup_key=` argument in
    `publication.enqueue_page_update` and this is 2 rows, which is 2
    messages, which is every follower notified twice.
    """
    page = _make_page(creator_factory())

    # ONE deferred job, executed twice: a procrastinate retry and the
    # reclaimer's requeue both UPDATE the same `procrastinate_jobs` row, so
    # both executions carry the same job id.
    notify_published_zpage(job_context(7), zpage_id=page.pk)
    notify_published_zpage(job_context(7), zpage_id=page.pk)

    rows = list(OutboxMessage.objects.all())
    assert len(rows) == 1
    assert rows[0].dedup_key == page_update_dedup_key(page, "job:7")


@pytest.mark.django_db
def test_the_promised_row_is_the_message_the_direct_publish_would_send(
    creator_factory,
):
    """Routing it through the relay must not change what goes out.

    The payload also has to survive a JSONField round trip through real
    Postgres -- the relay `json.dumps` it later, on a different process, so
    a value the serializer emits that JSON cannot hold would fail in the
    relay rather than here.
    """
    page = _make_page(creator_factory())
    topic, payload = page_update_message(page)

    notify_published_zpage(job_context(7), zpage_id=page.pk)

    row = OutboxMessage.objects.get()
    assert row.topic == topic
    assert row.payload == payload
    assert row.payload["free2zaddr"] == str(page.free2zaddr)
    # At most one PAGE_UPDATE per page in flight through the relay, in id
    # order.
    assert row.ordering_key == f"zpage:{page.pk}"
    # The direct publish relied on `PubSubClient.publish`'s ensure_topic
    # default (True); `OutboxMessage.ensure_topic` defaults to False, so a
    # namespace whose topic is created lazily depends on this being carried
    # over explicitly.
    assert row.ensure_topic is ENSURE_TOPIC is True
    assert row.published_at is None


@pytest.mark.django_db
def test_the_task_does_not_touch_pubsub(creator_factory, mocker):
    """The producer's whole job is now one INSERT.

    This is what the reclaim budget rests on: no `get_topic`/`create_topic`
    round trip (unbounded before the future exists), no future nobody
    awaits, nothing outside the database at all.
    """
    page = _make_page(creator_factory())
    client = mocker.patch("dj.apps.g12f.publication.PubSubClient")

    notify_published_zpage(job_context(7), zpage_id=page.pk)

    client.assert_not_called()
    assert OutboxMessage.objects.count() == 1


def test_the_task_is_declared_pass_context():
    """The whole dedup rests on the worker handing the task its job id.

    `pass_context=False` (the default) would call the function with the job
    kwargs alone -- a TypeError on every execution rather than a silent
    wrong key, but the assertion is cheap and it names the dependency.
    That a REQUEUED job keeps its id is pinned separately, by
    `jobs/test_reclaim_stalled.py::test_a_stalled_publish_broadcast_is_reclaimed`
    (`reclaimed_ids == [job_id]`, and that id is then `todo`).
    """
    assert notify_published_zpage.pass_context is True


@pytest.mark.django_db
def test_the_dedup_key_names_the_broadcast(creator_factory):
    page = _make_page(creator_factory())

    key = page_update_dedup_key(page, "job:7")

    assert key == f"page_update:{page.pk}:job:7"
    assert len(key) <= 255


@pytest.mark.django_db
def test_the_key_does_not_move_when_the_page_does(creator_factory):
    """Codex round 2, P2. The identity must not be page state.

    The second cut of  keyed on `updated_at`. It is MUTABLE, and the
    gap between two executions of one job is not the 30s of PUBLISH_RETRY --
    the reclaimer requeues a stranded job ~15 minutes later, up to
    JOB_RECLAIM_MAX_RECLAIMS times. An autosave (or `detect_zpage_language`
    writing a language back) in that gap gave the second execution a
    different key and a SECOND promised message, which is precisely the
    double-notify the reclaim budget is only safe without.

    NEGATIVE CONTROL: key on `instance.updated_at` and this is 2 rows.
    """
    page = _make_page(creator_factory())

    notify_published_zpage(job_context(7), zpage_id=page.pk)

    # The page is edited between the two executions of the SAME job.
    zPage.objects.filter(pk=page.pk).update(updated_at=timezone.now())

    notify_published_zpage(job_context(7), zpage_id=page.pk)

    assert OutboxMessage.objects.count() == 1


@pytest.mark.django_db
def test_a_second_scheduled_publication_is_announced(creator_factory):
    """Codex round 1, P2. The FIRST cut keyed on `published_at`.

    `publish_zpage`'s compare-and-set PRESERVES `published_at` when a page
    that was published before is scheduled again -- so a key built from it
    is the key the first publication already used, `enqueue` returns that
    row, and the republication is never broadcast: no follower is told and
    the describe/tag consumers never see the new content. A second
    publication is a second `defer`, so it is a second job id.

    NEGATIVE CONTROL: key on `instance.published_at` instead and this is 1
    row -- the assertion below reads 2.
    """
    creator = creator_factory()
    first = timezone.now() - timedelta(days=3)
    page = _make_page(creator, published_at=first)

    notify_published_zpage(job_context(7), zpage_id=page.pk)

    # Unpublished, edited, and scheduled again -- what publish_zpage writes
    # on the second transition: a fresh `updated_at`, the ORIGINAL
    # `published_at`, and a brand new notify job.
    zPage.objects.filter(pk=page.pk).update(
        updated_at=timezone.now(), published_at=first,
    )
    page.refresh_from_db()

    notify_published_zpage(job_context(8), zpage_id=page.pk)

    assert page.published_at == first        # the premise, not an aside
    assert OutboxMessage.objects.count() == 2
    assert len({row.dedup_key for row in OutboxMessage.objects.all()}) == 2


@pytest.mark.django_db
def test_a_page_with_no_vanity_promises_nothing(creator_factory):
    """Unchanged from the direct publish: no vanity, no broadcast."""
    page = _make_page(creator_factory(), vanity="")

    notify_published_zpage(job_context(7), zpage_id=page.pk)

    assert not OutboxMessage.objects.exists()


@pytest.mark.django_db
def test_a_banned_creators_page_promises_nothing(creator_factory):
    """The existing takedown behaviour, kept: the gate is still the gate."""
    creator = creator_factory()
    page = _make_page(creator)
    creator.is_active = False
    creator.save(update_fields=["is_active"])

    notify_published_zpage(job_context(7), zpage_id=page.pk)

    assert not OutboxMessage.objects.exists()


# ---------------------------------------------------------------------------
# consumer: the fan-out happens once
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_second_delivery_creates_no_second_event(creator_factory):
    """At-least-once delivery, exactly-once notification."""
    creator = creator_factory()
    fans = [_fan(creator_factory, creator) for _ in range(3)]
    page = _make_page(creator)

    assert fan_out_page_update(page) == 3
    assert fan_out_page_update(page) == 0

    assert Event.objects.filter(type="PAGE_UPDATE").count() == 3
    assert set(
        Event.objects.filter(type="PAGE_UPDATE")
        .values_list("receiving_user_id", flat=True)
    ) == {fan.pk for fan in fans}


@pytest.mark.django_db(transaction=True)
def test_the_fan_out_serialises_on_the_advisory_lock(creator_factory):
    """The half a sequential test cannot see.

    Two deliveries in flight TOGETHER both used to pass the 6h `exists()`
    check and both fan out; the window was the whole create-per-fan loop.
    Here a second connection holds the fan-out's advisory lock, so a
    delivery must block until it is released rather than read past it.

    NEGATIVE CONTROL: remove the `pg_advisory_xact_lock` from
    `fan_out_page_update` and the call completes while the lock is held --
    `finished.wait(2)` returns True and the assertion below goes red.
    """
    creator = creator_factory()
    _fan(creator_factory, creator)
    page = _make_page(creator)

    # Session-level lock on a connection of our own. `hashtext` of the same
    # string is the same key the fan-out takes.
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_lock(hashtext(%s))", [_lock_key(page.pk)])

    finished = threading.Event()
    created = []
    errors = []

    def deliver():
        try:
            created.append(fan_out_page_update(page))
        except Exception as exc:      # pragma: no cover - surfaced below
            errors.append(exc)
        finally:
            finished.set()
            connections.close_all()

    worker = threading.Thread(target=deliver, daemon=True)
    worker.start()
    try:
        assert not finished.wait(2), (
            "the fan-out ran while its advisory lock was held by another "
            "session -- the exists() check and the create loop are not "
            "serialised, so two concurrent deliveries both fan out"
        )
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_unlock(hashtext(%s))",
                [_lock_key(page.pk)],
            )

    worker.join(timeout=15)
    assert not worker.is_alive()
    assert errors == []
    assert created == [1]
    assert Event.objects.filter(type="PAGE_UPDATE").count() == 1


@pytest.mark.django_db
def test_a_dropped_connection_does_not_lose_the_whole_announcement(
    creator_factory, mocker,
):
    """Codex rounds 1-3, P2. The transaction made failure all-or-nothing.

    `catch_errors` acks every exception, so a fan-out that rolls back is
    never redelivered -- before the transaction a blip left the followers it
    had already reached notified, and after it nobody is. The retry is what
    pays for the atomicity.

    NEGATIVE CONTROL: call `fan_out_page_update` from the callback instead
    of `deliver_page_update` and the first failure propagates -- `attempts`
    is 1 and the announcement is gone.
    """
    creator = creator_factory()
    _fan(creator_factory, creator)
    page = _make_page(creator)
    mocker.patch.object(subscriber.time, "sleep")
    attempts = []

    def flaky(instance):
        attempts.append(instance)
        if len(attempts) < 3:
            raise OperationalError("server closed the connection unexpectedly")
        return 1

    mocker.patch.object(subscriber, "fan_out_page_update", flaky)

    assert subscriber.deliver_page_update(page) == 1
    assert len(attempts) == 3


@pytest.mark.django_db
def test_the_retry_is_bounded_and_only_covers_database_failure(
    creator_factory, mocker,
):
    """Two bounds, because an unbounded one parks a callback slot.

    A `DatabaseError` that never clears gives up after `FAN_OUT_ATTEMPTS`
    and raises, which `catch_errors` turns into the same acked traceback as
    before. Anything else -- a bug in the fan-out, a page that will never
    deserialise -- is not retried at all: three attempts would cost three
    seconds of a callback slot on the way to the identical traceback.
    """
    page = _make_page(creator_factory())
    mocker.patch.object(subscriber.time, "sleep")

    calls = []

    def always_db_error(instance):
        calls.append(instance)
        raise OperationalError("still down")

    mocker.patch.object(subscriber, "fan_out_page_update", always_db_error)
    with pytest.raises(OperationalError):
        subscriber.deliver_page_update(page)
    assert len(calls) == subscriber.FAN_OUT_ATTEMPTS

    calls.clear()

    def always_value_error(instance):
        calls.append(instance)
        raise ValueError("not a database problem")

    mocker.patch.object(subscriber, "fan_out_page_update", always_value_error)
    with pytest.raises(ValueError):
        subscriber.deliver_page_update(page)
    assert len(calls) == 1
