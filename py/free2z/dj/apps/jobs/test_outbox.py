"""Real-Postgres regressions for the Pub/Sub transactional outbox.

Every test here mocks Pub/Sub at the CLIENT boundary
(``dj.apps.jobs.outbox.PubSubClient``) and uses the real database, because
every property under test is a database property: what a rollback undoes,
what a claim leases, what an ordering key blocks.

The four things  asked for, and the test that pins each:

1. the row is written in the producer's transaction and NOT published when
   that transaction rolls back -- ``test_rollback_leaves_no_promise``;
2. published exactly once on commit -- ``test_commit_publishes_exactly_once``
   (the "once" half is the second drain);
3. a Pub/Sub failure leaves the row unpublished with ``attempts``
   incremented, and a later drain retries it --
   ``test_publish_failure_records_the_attempt_and_retries``;
4. the ordering key is preserved -- ``test_ordering_key_blocks_its_own_successors``
   and ``test_ordering_key_round_trips_from_producer_to_relay``.

Plus the two the  rescue added, both of which pin a claim that the
production code makes in prose and nothing checked:

5. the relay killed between publish and settle republishes once its lease
   expires, and not before --
   ``test_a_relay_killed_between_publish_and_settle_republishes``;
6. a ``dedup_key`` collision is a no-op insert, so  can collapse a
   duplicate broadcast at the database rather than with an ``exists()``
   check two concurrent producers both pass --
   ``test_a_dedup_key_collision_is_a_no_op_insert``.
"""
import uuid

import pytest
from django.conf import settings
from django.db import DatabaseError, connection, transaction
from django.test import RequestFactory
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from dj.apps.jobs import outbox
from dj.apps.jobs.models import OutboxMessage
from gcp.pubsub import client as pubsub_client
# Bound at IMPORT time, before conftest's autouse fixture swaps the module
# attribute for a stub -- these tests are about the real client's own logic.
from gcp.pubsub.client import PubSubClient as _RealPubSubClient

TOPIC = 'projects/free2z/topics/outbox-test'


class _FakeFuture:
    def __init__(self, exc=None, message_id='mid-1'):
        self._exc = exc
        self._message_id = message_id
        self.waited_timeout = None

    def result(self, timeout=None):
        self.waited_timeout = timeout
        if self._exc is not None:
            raise self._exc
        return self._message_id


class FakePubSubClient:
    """Stands in for the real client at the ONLY external boundary.

    Records every call so a test can assert on the wire arguments, and can be
    told to fail a bounded number of times so a retry is observable rather
    than assumed.
    """

    def __init__(self, fail_times=0, exc=None, future_exc=None):
        self.calls = []
        self.fail_times = fail_times
        self.exc = exc or RuntimeError('pubsub unavailable')
        self.future_exc = future_exc
        self.futures = []
        self.timeouts = []

    def publish(self, topic, payload, *, ensure_topic=True, attributes=None,
                timeout=None, admin_timeout=None):
        self.calls.append({
            'topic': topic,
            'payload': payload,
            'ensure_topic': ensure_topic,
            'attributes': attributes,
        })
        self.timeouts.append(timeout)
        if self.fail_times > 0:
            self.fail_times -= 1
            raise self.exc
        future = _FakeFuture(exc=self.future_exc)
        self.futures.append(future)
        return future


class _FakeMonotonic:
    """A monotonic clock a test can advance by hand.

    ``outbox.drain`` measures its budget with ``time.monotonic``, so the
    module's ``time`` is what a test replaces. Sleeping for real would make
    the budget tests minute-long and flaky on a loaded runner, and -- worse
    -- would make the interesting case (a prologue that eats the budget)
    untestable at all.
    """

    def __init__(self):
        self.elapsed = 0.0

    def monotonic(self):
        return self.elapsed

    def advance(self, seconds):
        self.elapsed += seconds


@pytest.fixture
def client(monkeypatch):
    fake = FakePubSubClient()
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: fake)
    return fake


def _enqueue(**kwargs):
    kwargs.setdefault('ordering_key', '')
    return outbox.enqueue(TOPIC, {'n': 1}, **kwargs)


# ---------------------------------------------------------------------------
# 1. transactionality
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_rollback_leaves_no_promise(client):
    """A rolled-back producer publishes nothing AND promises nothing.

    This is the property the whole design exists for: the promise is a row in
    the same transaction, so undoing the domain change undoes the promise
    with it. No compensating action, no "did we already send it?" question.
    """
    with pytest.raises(RuntimeError, match='roll it back'):
        with transaction.atomic():
            outbox.enqueue(TOPIC, {'n': 1})
            assert OutboxMessage.objects.count() == 1, (
                'the row must exist INSIDE the transaction -- if it were '
                'written after commit this test would pass vacuously'
            )
            raise RuntimeError('roll it back')

    assert OutboxMessage.objects.count() == 0
    assert outbox.drain() == {
        'claimed': 0, 'attempted': 0, 'published': 0, 'failed': 0,
        'released': 0, 'more': False}
    assert client.calls == []


@pytest.mark.django_db(transaction=True)
def test_commit_publishes_exactly_once(client):
    with transaction.atomic():
        message = outbox.enqueue(
            TOPIC, {'n': 1}, attributes={'kind': 'test'}, ensure_topic=True)
        assert client.calls == [], 'nothing may reach Pub/Sub before COMMIT'

    result = outbox.drain()
    assert result['published'] == 1
    assert result['failed'] == 0
    assert len(client.calls) == 1
    assert client.calls[0] == {
        'topic': TOPIC,
        'payload': {'n': 1},
        'ensure_topic': True,
        'attributes': {'kind': 'test'},
    }
    # The wait is bounded -- an unbounded result() would wedge the worker.
    assert client.futures[0].waited_timeout == outbox.PUBLISH_TIMEOUT_SECONDS

    message.refresh_from_db()
    assert message.published_at is not None
    assert message.last_error == ''

    # EXACTLY once: a second pass must find nothing, even immediately.
    assert outbox.drain()['claimed'] == 0
    assert len(client.calls) == 1


@pytest.mark.django_db(transaction=True)
def test_a_publish_never_happens_inside_a_transaction(monkeypatch):
    """The  defect itself: no open transaction across the Pub/Sub call.

    A relay that simply held ``SELECT... FOR UPDATE`` while publishing would
    pass every other test in this file and still be the bug -- it would just
    hold a queue worker's connection instead of a web worker's.
    """
    from django.db import connection

    seen = []

    class _Watching(FakePubSubClient):
        def publish(self, *args, **kwargs):
            seen.append(connection.in_atomic_block)
            return super().publish(*args, **kwargs)

    watching = _Watching()
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: watching)

    with transaction.atomic():
        outbox.enqueue(TOPIC, {'n': 1})
    outbox.drain()

    assert seen == [False]


# ---------------------------------------------------------------------------
# 2. failure, attempts, backoff, retry
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_publish_failure_records_the_attempt_and_retries(monkeypatch):
    fake = FakePubSubClient(fail_times=1)
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: fake)

    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})

    result = outbox.drain()
    assert result == {
        'claimed': 1, 'attempted': 1, 'published': 0, 'failed': 1,
        'released': 0, 'more': False}

    message.refresh_from_db()
    assert message.published_at is None
    assert message.attempts == 1
    assert 'pubsub unavailable' in message.last_error
    # 'more' is False because the row is now backing off, not because it is
    # done -- and that backoff is what stops a hot retry loop.
    assert message.next_attempt_at > timezone.now()

    # Still backing off: a drain right now must not touch it.
    assert outbox.drain()['claimed'] == 0
    assert len(fake.calls) == 1

    # Once due, it retries and succeeds. Nothing was lost.
    later = timezone.now() + timezone.timedelta(
        seconds=outbox.backoff_seconds(1) + 1)
    assert outbox.drain(now=later)['published'] == 1
    message.refresh_from_db()
    assert message.published_at is not None
    assert message.attempts == 2
    assert message.last_error == ''


@pytest.mark.django_db(transaction=True)
def test_a_failed_future_is_a_failure_not_a_success(monkeypatch):
    """`publish()` returning is not delivery; only the future's result is.

    Dropping the `future.result()` wait would make this the silent
    message-loss path -- the row would be stamped published on a message
    Pub/Sub rejected.
    """
    fake = FakePubSubClient(future_exc=RuntimeError('publish was rejected'))
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: fake)

    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})
    assert outbox.drain()['failed'] == 1

    message.refresh_from_db()
    assert message.published_at is None
    assert 'publish was rejected' in message.last_error


@pytest.mark.django_db(transaction=True)
def test_backoff_is_exponential_and_capped():
    assert outbox.backoff_seconds(1) == outbox.RETRY_BASE_SECONDS
    assert outbox.backoff_seconds(2) == outbox.RETRY_BASE_SECONDS * 2
    assert outbox.backoff_seconds(3) == outbox.RETRY_BASE_SECONDS * 4
    assert outbox.backoff_seconds(1000) == outbox.RETRY_MAX_SECONDS
    # The lease must outlast the publish wait, or a slow publish is retried
    # while it is still in flight.
    assert outbox.RETRY_BASE_SECONDS > outbox.PUBLISH_TIMEOUT_SECONDS


def test_every_second_a_row_can_block_for_is_bounded_and_in_the_lease():
    """The terms `future.result(timeout=)` does NOT bound.

    `ensure_topic=True` (the comments producer) runs `get_topic` and, if it
    is missing, `create_topic` -- synchronously, BEFORE the future exists.
    The SDK's own default there is a 600s retry deadline per operation, so a
    Pub/Sub outage could park one comment on the concurrency-1 worker for
    ~20 minutes inside a call whose caller believed it had a 30s cap, and
    outlive the claim's lease while doing it.
    """
    assert pubsub_client.ADMIN_TIMEOUT_SECONDS > 0
    # 2x, because api-core checks a retry deadline only BETWEEN attempts and
    # `TimeToDeadlineTimeout` hands a fresh full timeout to an attempt begun
    # with under a second left. Taking the configured value at face value
    # understates a pass and puts the lease back inside it.
    assert pubsub_client.ADMIN_CALL_WORST_CASE_SECONDS == (
        2 * pubsub_client.ADMIN_TIMEOUT_SECONDS)
    assert outbox.ROW_WORST_CASE_SECONDS == (
        outbox.PUBLISH_TIMEOUT_SECONDS
        + 2 * pubsub_client.ADMIN_CALL_WORST_CASE_SECONDS)
    assert outbox.LEASE_SETTLE_MARGIN_SECONDS > 0
    assert outbox.LEASE_SECONDS == (
        outbox.DRAIN_BUDGET_SECONDS
        + outbox.ROW_WORST_CASE_SECONDS
        + outbox.LEASE_SETTLE_MARGIN_SECONDS)
    assert outbox.LEASE_SECONDS >= (
        outbox.DRAIN_BUDGET_SECONDS + outbox.ROW_WORST_CASE_SECONDS)


@pytest.mark.django_db(transaction=True)
def test_the_relay_bounds_the_publish_rpc_not_only_its_own_wait(client):
    """A publisher future cannot be cancelled.

    `future.result(timeout=30)` only stops the CALLER waiting; the SDK keeps
    retrying underneath. Without a timeout on the publish itself, a message
    could be accepted minutes after the relay recorded the attempt as failed
    and rescheduled the row -- a duplicate produced by ordinary latency
    rather than by a crash. Bounding the RPC narrows that window; the
    residual is why delivery is documented as at-least-once.
    """
    with transaction.atomic():
        outbox.enqueue(TOPIC, {'n': 1})
    outbox.drain()
    assert client.timeouts == [outbox.PUBLISH_TIMEOUT_SECONDS]


def test_a_bounded_retry_bounds_the_whole_call_and_keeps_the_predicate():
    """Replacing the SDK's retry object must not narrow what it retries.

    api-core applies a float `timeout` per ATTEMPT and lets the retry loop
    keep its own deadline (600s on the Pub/Sub publisher transport), so the
    fix is a retry object with a total budget -- and a retry object whose
    predicate dropped, say, UNAVAILABLE would turn every ordinary blip into
    a hard failure while looking like a timeout fix.
    """
    from google.api_core import exceptions as gexc

    retry = pubsub_client.bounded_retry(7.0)
    assert retry.timeout == 7.0
    for exc in (gexc.ServiceUnavailable, gexc.DeadlineExceeded,
                gexc.InternalServerError, gexc.Aborted, gexc.Cancelled,
                gexc.Unknown, gexc.ResourceExhausted):
        assert retry._predicate(exc('x')), exc.__name__
    #...and does not retry things that will never succeed.
    for exc in (gexc.NotFound, gexc.PermissionDenied, gexc.InvalidArgument):
        assert not retry._predicate(exc('x')), exc.__name__


def test_ensure_topic_creates_only_on_not_found():
    """`except Exception: create_topic()` named the wrong problem twice.

    A permission error, a deadline or a transient UNAVAILABLE all used to
    trigger a create, which then failed with a second error about the wrong
    thing -- after a second full retry deadline. Only NotFound means
    missing, and AlreadyExists on the create is success (two producers can
    race into a fresh namespace).
    """
    from unittest import mock

    from google.api_core import exceptions as gexc

    def _client():
        c = _RealPubSubClient.__new__(_RealPubSubClient)
        c.publisher = mock.Mock()
        return c

    def _assert_bounded(call, **expected):
        assert call.kwargs.pop('timeout') == 7.0
        # The half that actually bounds it: `timeout` alone is a PER-ATTEMPT
        # deadline and the retry loop keeps the transport's own 600s one.
        retry = call.kwargs.pop('retry')
        assert retry.timeout == 7.0, (
            'the retry deadline must be bounded too, or `timeout=7` bounds '
            'one attempt of a call that can run for ten minutes')
        assert call.kwargs == expected

    # Present: no create, and the lookup is bounded.
    c = _client()
    c._ensure_topic('t', 7.0)
    _assert_bounded(c.publisher.get_topic.call_args, topic='t')
    c.publisher.create_topic.assert_not_called()

    # Missing: created, also bounded.
    c = _client()
    c.publisher.get_topic.side_effect = gexc.NotFound('nope')
    c._ensure_topic('t', 7.0)
    _assert_bounded(c.publisher.create_topic.call_args, name='t')

    # Raced: another producer created it first. Not an error.
    c = _client()
    c.publisher.get_topic.side_effect = gexc.NotFound('nope')
    c.publisher.create_topic.side_effect = gexc.AlreadyExists('raced')
    c._ensure_topic('t', 7.0)

    # Anything else propagates, and must NOT be answered with a create.
    c = _client()
    c.publisher.get_topic.side_effect = gexc.PermissionDenied('no')
    with pytest.raises(gexc.PermissionDenied):
        c._ensure_topic('t', 7.0)
    c.publisher.create_topic.assert_not_called()


def test_the_lease_covers_a_whole_pass_not_one_publish():
    """The arithmetic that stops a batch republishing underneath itself.

    Only the FIRST row of a batch starts publishing at the claim timestamp.
    The last one can start an instant before the pass runs out of budget and
    then wait the full publish timeout, so a lease of RETRY_BASE_SECONDS
    alone (60s, against a 120s budget) left rows claimable by the periodic
    sweep -- which runs every 2 minutes -- while this pass was still
    publishing them.
    """
    assert outbox.LEASE_SECONDS >= (
        outbox.DRAIN_BUDGET_SECONDS + outbox.ROW_WORST_CASE_SECONDS)
    # And the budget itself has to be the bound, not the batch: 100 rows x a
    # 30s timeout is 3000s of the ONE worker slot that also carries images,
    # search, translation, the health sweep and the reclaimer.
    assert outbox.DRAIN_BUDGET_SECONDS < (
        outbox.BATCH_SIZE * outbox.PUBLISH_TIMEOUT_SECONDS)


@pytest.mark.django_db(transaction=True)
def test_a_claimed_row_is_not_reclaimable_while_the_pass_is_still_running(
        client):
    """The lease, observed on the row rather than asserted as arithmetic."""
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})
    before = timezone.now()
    rows, _lease_until = outbox._claim(10, before)

    assert [r.pk for r in rows] == [message.pk]
    message.refresh_from_db()
    held_for = (message.next_attempt_at - before).total_seconds()
    assert held_for == pytest.approx(outbox.LEASE_SECONDS, abs=1)

    # A concurrent relay -- the periodic sweep is every 2 minutes -- must
    # find nothing at any point a slow pass could still be publishing.
    concurrent = before + timezone.timedelta(
        seconds=outbox.DRAIN_BUDGET_SECONDS + outbox.ROW_WORST_CASE_SECONDS
        - 1)
    assert not outbox.due_messages(concurrent).exists()


@pytest.mark.django_db(transaction=True)
def test_a_pass_that_runs_out_of_budget_hands_back_what_it_never_tried(
        monkeypatch):
    """P1/P2: one pass may not hold the shared worker slot indefinitely.

    `image-variant-worker` runs concurrency 1 across billing, default,
    detect, images, search, search-multilingual and translation. A pass that
    published 100 rows at the 30s timeout would occupy that lane for 3000s,
    stalling every other background job including the health sweep and the
    stalled-job reclaimer. So the pass stops, and -- this is the half that
    keeps it correct -- gives back the attempts it burned on rows it never
    touched, because `attempts` drives the backoff.
    """
    fake = FakePubSubClient()
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: fake)
    # Budget spent by the first publish.
    monkeypatch.setattr(outbox, 'DRAIN_BUDGET_SECONDS', 0.0)

    with transaction.atomic():
        for n in range(3):
            outbox.enqueue(TOPIC, {'n': n})

    result = outbox.drain()

    assert result['published'] == 0
    assert result['released'] == 3
    assert result['more'] is True, (
        'the caller re-defers on `more`; without it the batch waits for the '
        'periodic sweep')
    assert fake.calls == []

    for row in OutboxMessage.objects.all():
        assert row.attempts == 0, (
            'a row nobody attempted must not have burned an attempt -- '
            'attempts is what backoff_seconds() reads')
        assert row.published_at is None
        assert row.next_attempt_at <= timezone.now(), (
            'and it must be due immediately for the pass this one re-defers')

    # Nothing was lost: the next pass, with a real budget, sends all three.
    monkeypatch.setattr(outbox, 'DRAIN_BUDGET_SECONDS', 120.0)
    assert outbox.drain()['published'] == 3


@pytest.mark.django_db(transaction=True)
def test_the_budget_clock_starts_with_the_lease_not_after_the_prologue(
        monkeypatch):
    """The pass's OWN prologue is inside its budget, or the lease is a lie.

    ``LEASE_SECONDS = DRAIN_BUDGET_SECONDS + ROW_WORST_CASE_SECONDS`` is
    measured from the claim timestamp. Anchoring the budget deadline any
    later makes the pass's real worst case
    ``t_prologue + BUDGET + ROW_WORST_CASE`` and the lease covers only
    ``BUDGET + ROW_WORST_CASE`` -- so the tail of a batch is publishing
    ``t_prologue`` seconds after the row became claimable again, and the
    periodic sweep (every 2 minutes) publishes it a SECOND time.

    The prologue is not hypothetical: ``PubSubClient()`` builds a
    PublisherClient *and* a SubscriberClient, which is two ADC/metadata-server
    credential fetches and two gRPC channels. On a degraded metadata server
    that is seconds to tens of seconds, and nothing in this module bounds it.
    A duplicate here is a second tweet from ``tweet_comments`` and a second
    billed tagging call from ``tag_comments`` -- the two comments consumers
    with no durable claim  -- with no crash and no deployment.

    Production shape, scaled down: BUDGET 10, ROW_WORST_CASE 5, LEASE 15,
    an 8s client construction and a 1s publish.
    """
    clock = _FakeMonotonic()
    monkeypatch.setattr(outbox, 'time', clock)
    monkeypatch.setattr(outbox, 'DRAIN_BUDGET_SECONDS', 10.0)
    monkeypatch.setattr(outbox, 'ROW_WORST_CASE_SECONDS', 5.0)
    monkeypatch.setattr(outbox, 'LEASE_SECONDS', 15.0)

    #Every publish that STARTED late enough that its own worst case runs
    #past the lease this pass holds. One entry is one possible duplicate.
    overruns = []

    class _SlowToConstruct(FakePubSubClient):
        def __init__(self):
            super().__init__()
            clock.advance(8.0)

        def publish(self, *args, **kwargs):
            started = clock.elapsed
            if started + outbox.ROW_WORST_CASE_SECONDS > outbox.LEASE_SECONDS:
                overruns.append(started)
            clock.advance(1.0)
            return super().publish(*args, **kwargs)

    monkeypatch.setattr(outbox, 'PubSubClient', _SlowToConstruct)

    with transaction.atomic():
        for n in range(12):
            outbox.enqueue(TOPIC, {'n': n})

    result = outbox.drain()

    assert overruns == [], (
        'a publish started at t={} of a {}s lease: by the time it can '
        'finish, another relay has already been able to claim and publish '
        'the same row'.format(overruns[:1], outbox.LEASE_SECONDS))
    # The 8s prologue leaves 2s of a 10s budget, so exactly two rows are
    # attempted and the other ten are handed straight back, un-attempted.
    assert result['attempted'] == 2
    assert result['published'] == 2
    assert result['released'] == 10
    assert result['claimed'] == 12, (
        '`claimed` is rows this pass took the lease on, in every return '
        'path -- an operator reading the budget-exhausted summary during a '
        'backlog must not get a different question answered')
    assert result['more'] is True

    for row in OutboxMessage.objects.filter(published_at__isnull=True):
        assert row.attempts == 0
        assert row.next_attempt_at <= timezone.now()


@pytest.mark.django_db(transaction=True)
def test_a_prologue_that_eats_the_whole_budget_publishes_nothing(monkeypatch):
    """The degenerate case, and it is deliberately NOT a special case.

    If building the client alone outruns the budget, the batch is handed
    back un-attempted and the pass re-defers. Publishing anyway would be
    publishing outside the lease, which is the duplicate this design is
    meant to prevent rather than absorb; and a prologue that long is itself
    the incident the backlog alert pages on.
    """
    clock = _FakeMonotonic()
    monkeypatch.setattr(outbox, 'time', clock)
    monkeypatch.setattr(outbox, 'DRAIN_BUDGET_SECONDS', 10.0)

    class _NeverConstructsInTime(FakePubSubClient):
        def __init__(self):
            super().__init__()
            clock.advance(30.0)

    monkeypatch.setattr(outbox, 'PubSubClient', _NeverConstructsInTime)

    with transaction.atomic():
        for n in range(3):
            outbox.enqueue(TOPIC, {'n': n})

    result = outbox.drain()

    assert result['attempted'] == 0
    assert result['published'] == 0
    assert result['released'] == 3
    assert result['more'] is True
    assert OutboxMessage.objects.filter(attempts=0).count() == 3


@pytest.mark.django_db(transaction=True)
def test_a_prologue_failure_lands_in_last_error_and_backs_off(monkeypatch):
    """A client that cannot be BUILT must settle the batch it already claimed.

    The claim commits before ``PubSubClient()`` is constructed, so an
    exception there is not a no-op: every row carries a burned attempt and
    this pass's lease. Left unsettled -- broken ADC, a wedged metadata
    server, a revoked workload-identity binding -- the batch sat with
    ``attempts`` climbing and ``last_error`` permanently EMPTY, which is:

    * a state the backlog runbook's triage table does not describe (it reads
      exactly those two columns, and empty-error means "nothing has tried");
    * a state ``outbox_abandon`` refuses forever, with no override flag, so
      the terminal state was unreachable for this failure mode; and
    * a bypass of the whole retry ladder -- the flat LEASE_SECONDS every
      pass instead of RETRY_BASE -> RETRY_MAX -- so the relay rewrote the
      full batch every 115s for the duration of the outage rather than
      backing off to the one-hour ceiling.
    """
    class _Unbuildable:
        def __init__(self):
            raise RuntimeError('metadata server: connection refused')

    monkeypatch.setattr(outbox, 'PubSubClient', _Unbuildable)

    with transaction.atomic():
        for n in range(3):
            outbox.enqueue(TOPIC, {'n': n})

    before = timezone.now()
    with pytest.raises(RuntimeError):
        # Re-raised on purpose: the pass DID fail, and a failed
        # Procrastinate job is what `procrastinate-jobs-failed` pages on.
        outbox.drain()

    rows = list(OutboxMessage.objects.order_by('id'))
    assert [row.attempts for row in rows] == [1, 1, 1]
    for row in rows:
        assert row.last_error.startswith(outbox.PROLOGUE_ERROR_PREFIX), (
            'the row must say the relay never reached the wire -- "Pub/Sub '
            'refused this message" and "the relay could not build a client" '
            'are opposite diagnoses and the operator reads this column')
        assert 'connection refused' in row.last_error
        delay = (row.next_attempt_at - before).total_seconds()
        assert abs(delay - outbox.backoff_seconds(1)) < 5, (
            'the row backs off on its OWN ladder; the flat lease is for a '
            'row that might still be in flight, and nothing is in flight '
            'when the client could not even be constructed')
        assert delay < outbox.LEASE_SECONDS

    # And the ladder actually CLIMBS across passes, which is the thing that
    # stops the relay rewriting the batch every lease for a whole outage.
    later = timezone.now() + timezone.timedelta(
        seconds=outbox.backoff_seconds(1) + 1)
    with pytest.raises(RuntimeError):
        outbox.drain(now=later)

    resumed = timezone.now()
    rows = list(OutboxMessage.objects.order_by('id'))
    assert [row.attempts for row in rows] == [2, 2, 2]
    for row in rows:
        delay = (row.next_attempt_at - resumed).total_seconds()
        assert abs(delay - outbox.backoff_seconds(2)) < 5
        assert outbox.backoff_seconds(2) > outbox.backoff_seconds(1)

@pytest.mark.django_db(transaction=True)
def test_a_stale_owner_cannot_release_a_row_another_relay_now_holds():
    """The bug the release path introduced, fenced.

    A pass that stalls past its own lease -- a paused container, a long GC,
    a rolling deployment -- can resume, hit its drain deadline, and try to
    hand back rows a LATER relay has since claimed and is actively
    publishing. Unfenced, that decrements the new owner's attempt count and
    makes its in-flight rows immediately claimable, producing exactly the
    concurrent publish the lease exists to prevent.
    """
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})

    stale_at = timezone.now()
    stale_rows, stale_lease = outbox._claim(10, stale_at)
    assert [r.pk for r in stale_rows] == [message.pk]

    # Time passes; the stale pass's lease expires and relay B claims it.
    fresh_at = stale_at + timezone.timedelta(seconds=outbox.LEASE_SECONDS + 1)
    fresh_rows, fresh_lease = outbox._claim(10, fresh_at)
    assert [r.pk for r in fresh_rows] == [message.pk]

    message.refresh_from_db()
    assert message.attempts == 2
    assert message.next_attempt_at == fresh_lease

    # Relay A wakes up and tries to hand the row back. It must not.
    assert outbox._release(stale_rows, stale_at, stale_lease) == 0

    message.refresh_from_db()
    assert message.attempts == 2, "the new owner's attempt was not stolen"
    assert message.next_attempt_at == fresh_lease, (
        "the new owner's lease still stands")

    #...whereas the relay that DOES hold the lease may release it.
    assert outbox._release(fresh_rows, fresh_at, fresh_lease) == 1
    message.refresh_from_db()
    assert message.attempts == 1
    assert message.next_attempt_at == fresh_at


@pytest.mark.django_db(transaction=True)
def test_a_stale_owner_cannot_shorten_a_lease_it_no_longer_holds():
    """Same fence on the failure path.

    A stale pass's exception is not news about the attempt that is running
    now, and applying its backoff would pull the row out from under the
    relay that owns it.
    """
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})

    stale_at = timezone.now()
    stale_rows, stale_lease = outbox._claim(10, stale_at)
    fresh_at = stale_at + timezone.timedelta(seconds=outbox.LEASE_SECONDS + 1)
    _fresh_rows, fresh_lease = outbox._claim(10, fresh_at)

    outbox._settle_failure(stale_rows[0], RuntimeError('stale'), stale_lease)

    message.refresh_from_db()
    assert message.last_error == ''
    assert message.next_attempt_at == fresh_lease


@pytest.mark.django_db(transaction=True)
def test_a_stale_owner_that_published_anyway_still_records_it(client):
    """The one write that is deliberately NOT fenced.

    If a pass lost its lease and published regardless, the message went out.
    Recording that is what stops the new owner sending a second copy, so
    refusing the write because the lease moved would throw away the only
    fact worth keeping.
    """
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})

    stale_at = timezone.now()
    stale_rows, _stale_lease = outbox._claim(10, stale_at)
    outbox._claim(
        10, stale_at + timezone.timedelta(seconds=outbox.LEASE_SECONDS + 1))

    outbox._settle_success(stale_rows[0], timezone.now())

    message.refresh_from_db()
    assert message.published_at is not None
    assert not outbox.due_messages(
        timezone.now() + timezone.timedelta(days=1)).exists()


@pytest.mark.django_db(transaction=True)
def test_a_failure_shortens_the_lease_to_the_rows_own_backoff(monkeypatch):
    """The lease covers a batch; a failed row is not in that batch any more.

    Without this the first retry of a transient failure waits out
    LEASE_SECONDS (BUDGET + ROW_WORST_CASE = 115s with the defaults) instead
    of RETRY_BASE_SECONDS (60s), which is the kind of quiet
    over-conservatism that turns a blip into a page.
    """
    fake = FakePubSubClient(fail_times=1)
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: fake)

    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})

    before = timezone.now()
    assert outbox.drain()['failed'] == 1

    message.refresh_from_db()
    waits = (message.next_attempt_at - before).total_seconds()
    assert waits == pytest.approx(outbox.backoff_seconds(1), abs=2)
    assert waits < outbox.LEASE_SECONDS


@pytest.mark.django_db(transaction=True)
def test_a_relay_killed_between_publish_and_settle_republishes(monkeypatch):
    """The at-least-once claim in ``outbox.__doc__``, pinned.

    The module docstring asserts that "a relay killed between 2 and 3
    republishes after the lease expires". Nothing tested it, and the two
    ways to get that wrong are opposite and both silent:

    * stamp ``published_at`` BEFORE publishing and the message is lost with
      no trace (at-most-once), and
    * leave ``next_attempt_at`` where it was and a second relay republishes
      immediately, underneath a publish that may still be in flight.

    So this kills the relay in exactly that window -- ``_settle_success``
    raises after ``publish()`` returned, which is what a SIGKILL there looks
    like from the row's point of view -- and asserts both halves: the lease
    holds now, and the row goes out again once it expires.
    """
    fake = FakePubSubClient()
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: fake)
    settle_success = outbox._settle_success

    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})

    def _killed(row, now):
        raise SystemExit('killed between publish and settle')

    monkeypatch.setattr(outbox, '_settle_success', _killed)
    with pytest.raises(SystemExit):
        outbox.drain()

    message.refresh_from_db()
    assert len(fake.calls) == 1, 'Pub/Sub did accept the message'
    assert message.published_at is None, (
        'the relay died before it could record that -- the row is the only '
        'durable state and it says the message is still owed')
    assert message.attempts == 1, (
        'the attempt is burned at CLAIM time, not on success: a relay that '
        'dies mid-publish must still back off')

    monkeypatch.setattr(outbox, '_settle_success', settle_success)

    # The lease. Until next_attempt_at passes, no relay may touch this row --
    # and the lease here is LEASE_SECONDS, not backoff_seconds(1): the row
    # never reached `_settle_failure`, which is the only thing that knows a
    # row is no longer in flight and may therefore shorten it.
    assert outbox.drain()['claimed'] == 0
    assert outbox.drain(
        now=timezone.now() + timezone.timedelta(
            seconds=outbox.backoff_seconds(1) + 1),
    )['claimed'] == 0
    assert len(fake.calls) == 1

    later = timezone.now() + timezone.timedelta(
        seconds=outbox.LEASE_SECONDS + 1)
    assert outbox.drain(now=later)['published'] == 1

    message.refresh_from_db()
    assert message.published_at is not None
    assert message.attempts == 2
    assert len(fake.calls) == 2, (
        'the SAME message went out twice -- at-least-once by construction, '
        'and NOT every consumer needs to repeat it. `recording_idempotency_key` '
        '(#778), the comment UUID in `aiscore_comments` (#776), and the '
        'independent comment-consumer claims in #1701 protect their own '
        'side effects. The trade is still right -- silently losing a '
        'message a charged transaction promised is worse -- but read #1701 '
        'before widening replay on the strength of this test.')


# ---------------------------------------------------------------------------
# 3. the dedup key ( point 4;  is the consumer)
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_a_dedup_key_collision_is_a_no_op_insert(client):
    """Two promises with one key are one row, and therefore one message.

    The collapse must be the UNIQUE INDEX, not a read-then-write: the
    producers that need this (``g12f.notify_published_zpage``, ) are
    concurrent, and a check-then-act is a read both copies pass.
    """
    key = 'zpage-published:42'

    with transaction.atomic():
        first = outbox.enqueue(TOPIC, {'n': 1}, dedup_key=key)
    with transaction.atomic():
        second = outbox.enqueue(TOPIC, {'n': 2}, dedup_key=key)

    assert second.pk == first.pk
    assert OutboxMessage.objects.count() == 1
    second.refresh_from_db()
    assert second.payload == {'n': 1}, (
        'the FIRST promise wins and the duplicate writes NOTHING -- an '
        'upsert here would silently change a message already claimed by a '
        'relay, which is a different bug wearing the same test')

    assert outbox.drain()['published'] == 1
    assert [c['payload'] for c in client.calls] == [{'n': 1}]

    # And it still collapses AFTER the message went out. The key is scoped
    # to the life of the row (see models.OutboxMessage.dedup_key), which is
    # the whole point: a re-run of the producer must not re-broadcast.
    with transaction.atomic():
        third = outbox.enqueue(TOPIC, {'n': 3}, dedup_key=key)
    assert third.pk == first.pk
    assert OutboxMessage.objects.count() == 1
    assert outbox.drain()['claimed'] == 0
    assert len(client.calls) == 1


@pytest.mark.django_db(transaction=True)
def test_unkeyed_rows_are_never_collapsed_by_the_dedup_index(client):
    """NULL, not '', is what "no deduplication" means.

    Every NULL is distinct in a PostgreSQL UNIQUE index; a single empty
    string is not, so defaulting the column to `''` would have collapsed the
    entire table into one row the first time two producers ran.
    """
    with transaction.atomic():
        for n in range(3):
            outbox.enqueue(TOPIC, {'n': n})

    assert OutboxMessage.objects.count() == 3
    assert set(
        OutboxMessage.objects.values_list('dedup_key', flat=True)) == {None}
    assert outbox.drain()['published'] == 3


@pytest.mark.django_db(transaction=True)
def test_an_empty_dedup_key_is_refused_rather_than_stored():
    with pytest.raises(ValueError, match='non-empty'):
        outbox.enqueue(TOPIC, {'n': 1}, dedup_key='')
    assert OutboxMessage.objects.count() == 0


def test_the_relay_tasks_are_classified_in_the_reclaim_registry():
    """A reclaimed relay pass is a second retry ladder over the same rows.

    ``test_every_registered_task_has_a_reclaim_policy`` already fails on an
    unclassified task; this pins the CLASSIFICATION, because the failure
    mode of getting it wrong (reclaimable) is a duplicate publish rather
    than a red build.
    """
    from dj.apps.jobs import reclaim_policy

    for name in ('jobs.publish_outbox', 'jobs.sweep_outbox'):
        policy = reclaim_policy.TASK_POLICIES[name]
        assert not policy.reclaimable, name
        assert policy.reason


# ---------------------------------------------------------------------------
# 4. ordering
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_ordering_key_blocks_its_own_successors(monkeypatch):
    """A failing message holds the line for its key, and nothing else."""
    fake = FakePubSubClient(fail_times=1)
    monkeypatch.setattr(outbox, 'PubSubClient', lambda: fake)

    with transaction.atomic():
        first = outbox.enqueue(TOPIC, {'n': 1}, ordering_key='k')
        second = outbox.enqueue(TOPIC, {'n': 2}, ordering_key='k')
        unrelated = outbox.enqueue(TOPIC, {'n': 3}, ordering_key='other')

    # Pass 1: only the head of key 'k' is even eligible; it fails.
    result = outbox.drain()
    assert result['claimed'] == 2, (
        'exactly one row per ordering key, plus the unrelated key')
    assert [c['payload']['n'] for c in fake.calls] == [1, 3]

    second.refresh_from_db()
    assert second.attempts == 0, (
        'the blocked successor must not even be claimed -- claiming it would '
        'burn an attempt and start its backoff for a failure that is not its')

    # Pass 2, after the head's backoff: head first, then its successor.
    later = timezone.now() + timezone.timedelta(
        seconds=outbox.backoff_seconds(1) + 1)
    outbox.drain(now=later)
    first.refresh_from_db()
    assert first.published_at is not None
    second.refresh_from_db()
    assert second.published_at is None, (
        'the successor became eligible only once the head was published, so '
        'it cannot have gone out in the same pass')

    outbox.drain(now=later)
    second.refresh_from_db()
    assert second.published_at is not None
    unrelated.refresh_from_db()
    assert unrelated.published_at is not None
    assert [c['payload']['n'] for c in fake.calls] == [1, 3, 1, 2]


@pytest.mark.django_db(transaction=True)
def test_unordered_rows_are_all_eligible_at_once(client):
    with transaction.atomic():
        for n in range(3):
            outbox.enqueue(TOPIC, {'n': n})
    assert outbox.drain()['published'] == 3


@pytest.mark.django_db(transaction=True)
def test_ordering_key_round_trips_from_producer_to_relay(client):
    key = f'dyte-recording:{uuid.uuid4()}'
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1}, ordering_key=key)
    message.refresh_from_db()
    assert message.ordering_key == key
    outbox.drain()
    # It is NOT sent to Pub/Sub as a message ordering key: the publisher is
    # not built with enable_message_ordering and the subscriptions are not
    # ordering-enabled, so passing one would raise. See jobs/models.py.
    assert client.calls[0]['attributes'] == {}


# ---------------------------------------------------------------------------
# 5. batching and observability
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_the_batch_is_bounded_and_reports_that_more_remain(client):
    with transaction.atomic():
        for n in range(5):
            outbox.enqueue(TOPIC, {'n': n})

    result = outbox.drain(limit=2)
    assert result['claimed'] == 2
    assert result['published'] == 2
    assert result['more'] is True
    assert outbox.drain(limit=2)['more'] is True
    assert outbox.drain(limit=2)['more'] is False
    assert OutboxMessage.objects.filter(published_at__isnull=True).count() == 0


@pytest.mark.django_db(transaction=True)
def test_health_is_quiet_while_the_backlog_is_fresh(client):
    with transaction.atomic():
        outbox.enqueue(TOPIC, {'n': 1})
    payload = outbox.health_snapshot()
    assert payload['unpublished'] == 1
    assert payload['stale'] == 0
    assert payload['alert'] is None


@pytest.mark.django_db(transaction=True)
def test_health_alerts_once_a_row_is_older_than_the_stale_threshold(caplog):
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})
    OutboxMessage.objects.filter(pk=message.pk).update(
        created_at=timezone.now() - timezone.timedelta(
            seconds=outbox.STALE_SECONDS + 60),
    )

    with caplog.at_level('INFO', logger='dj.apps.jobs.outbox'):
        payload = outbox.log_health()

    assert payload['alert'] == outbox.OUTBOX_BACKLOG_ALERT
    assert payload['stale'] == 1
    assert payload['oldest_unpublished_seconds'] >= outbox.STALE_SECONDS

    # The line must be ONE bare JSON object with a top-level severity, or
    # GKE will not lift it into jsonPayload and the alert policy's filter
    # matches nothing.
    import json
    lines = [json.loads(r.message) for r in caplog.records
             if r.name == 'dj.apps.jobs.outbox']
    assert lines, caplog.text
    body = lines[-1]
    assert body['severity'] == 'ERROR'
    assert body['event'] == outbox.OUTBOX_HEALTH_EVENT
    assert body['alert'] == outbox.OUTBOX_BACKLOG_ALERT
    assert body['message']


@pytest.mark.django_db(transaction=True)
def test_published_rows_never_reappear_in_the_health_backlog(client):
    with transaction.atomic():
        message = outbox.enqueue(TOPIC, {'n': 1})
    OutboxMessage.objects.filter(pk=message.pk).update(
        created_at=timezone.now() - timezone.timedelta(days=1))
    outbox.drain()
    payload = outbox.health_snapshot()
    assert payload == {
        'event': outbox.OUTBOX_HEALTH_EVENT,
        'unpublished': 0,
        'stale': 0,
        'stale_threshold_seconds': outbox.STALE_SECONDS,
        'oldest_unpublished_seconds': 0,
        'alert': None,
    }


# ---------------------------------------------------------------------------
# 6. published retention is bounded without touching durable promises
# ---------------------------------------------------------------------------

@pytest.mark.django_db(transaction=True)
def test_prune_published_is_bounded_and_preserves_retry_and_dedup_rows():
    now = timezone.now()
    expired = now - timezone.timedelta(
        days=outbox.PUBLISHED_RETENTION_DAYS + 2)
    recent = now - timezone.timedelta(
        days=outbox.PUBLISHED_RETENTION_DAYS - 1)

    oldest = OutboxMessage.objects.create(
        topic=TOPIC, payload={'n': 1}, published_at=expired)
    second = OutboxMessage.objects.create(
        topic=TOPIC, payload={'n': 2}, published_at=expired)
    fresh = OutboxMessage.objects.create(
        topic=TOPIC, payload={'n': 3}, published_at=recent)
    keyed = OutboxMessage.objects.create(
        topic=TOPIC, payload={'n': 4}, published_at=expired,
        dedup_key='permanent-idempotency-key')
    pending = OutboxMessage.objects.create(
        topic=TOPIC, payload={'n': 5}, created_at=expired, attempts=4,
        next_attempt_at=now + timezone.timedelta(hours=1),
        last_error='temporary failure')

    # One sweep takes one bounded batch, and order makes the result stable.
    assert outbox.prune_published(now=now, limit=1) == 1
    assert not OutboxMessage.objects.filter(pk=oldest.pk).exists()
    assert OutboxMessage.objects.filter(pk=second.pk).exists()

    assert outbox.prune_published(now=now) == 1
    assert not OutboxMessage.objects.filter(pk=second.pk).exists()
    assert OutboxMessage.objects.filter(pk=fresh.pk).exists()
    assert OutboxMessage.objects.filter(pk=keyed.pk).exists()
    assert OutboxMessage.objects.filter(pk=pending.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_periodic_sweep_runs_published_retention_cleanup(client):
    from dj.apps.jobs import tasks

    now = timezone.now()
    message = OutboxMessage.objects.create(
        topic=TOPIC,
        payload={'n': 1},
        published_at=now - timezone.timedelta(
            days=outbox.PUBLISHED_RETENTION_DAYS + 1),
    )

    result = tasks.sweep_outbox_task(timestamp=0)

    assert result['pruned'] == 1
    assert not OutboxMessage.objects.filter(pk=message.pk).exists()


@pytest.mark.django_db(transaction=True)
def test_prune_published_uses_short_postgres_timeouts():
    if connection.vendor != 'postgresql':
        pytest.skip('the production retention guard is PostgreSQL-specific')

    with CaptureQueriesContext(connection) as queries:
        assert outbox.prune_published() == 0

    sql = '\n'.join(query['sql'].lower() for query in queries)
    assert "set_config('statement_timeout'" in sql
    assert "set_config('lock_timeout'" in sql


@pytest.mark.django_db(transaction=True)
def test_prune_published_database_failure_is_isolated(monkeypatch, caplog):
    def fail(*args, **kwargs):
        raise DatabaseError('simulated retention timeout')

    monkeypatch.setattr(OutboxMessage.objects, 'filter', fail)

    with caplog.at_level('ERROR', logger='dj.apps.jobs.outbox'):
        assert outbox.prune_published() == 0
    assert 'retention prune skipped' in caplog.text


def test_sweep_delivers_and_emits_health_when_retention_raises(monkeypatch):
    from dj.apps.jobs import tasks

    def fail():
        raise RuntimeError('simulated retention bug')

    health = {'unpublished': 0}
    drained = {'more': False}
    monkeypatch.setattr(outbox, 'prune_published', fail)
    monkeypatch.setattr(outbox, 'log_health', lambda: health)
    monkeypatch.setattr(outbox, 'drain', lambda: drained)

    result = tasks.sweep_outbox_task(timestamp=0)

    assert result == {'health': health, 'pruned': 0, 'drained': drained}


@pytest.mark.django_db(transaction=True)
def test_outbox_admin_search_is_typed_case_sensitive_and_bounded():
    from django.contrib import admin
    from dj.apps.jobs.admin import OutboxMessageAdmin

    lower = OutboxMessage.objects.create(
        topic=TOPIC, payload={'n': 1}, dedup_key='case-sensitive')
    _ = OutboxMessage.objects.create(
        topic=TOPIC, payload={'n': 2}, dedup_key='CASE-SENSITIVE')
    admin_view = OutboxMessageAdmin(OutboxMessage, admin.site)
    request = RequestFactory().get('/admin/jobs/jobs_outboxmessage/')

    by_id, duplicate = admin_view.get_search_results(
        request, OutboxMessage.objects.all(), str(lower.pk))
    assert list(by_id.values_list('pk', flat=True)) == [lower.pk]
    assert duplicate is False

    by_key, duplicate = admin_view.get_search_results(
        request, OutboxMessage.objects.all(), 'case-sensitive')
    assert list(by_key.values_list('pk', flat=True)) == [lower.pk]
    assert duplicate is False

    with CaptureQueriesContext(connection) as queries:
        invalid, duplicate = admin_view.get_search_results(
            request, OutboxMessage.objects.all(), '9' * 100)
        assert list(invalid) == []
    assert duplicate is False
    sql = '\n'.join(query['sql'].upper() for query in queries)
    assert 'UPPER(' not in sql
    assert 'LIKE' not in sql

    assert admin_view.show_full_result_count is False
    assert admin_view.sortable_by == ('id',)


def test_outbox_admin_uses_only_bounded_controls():
    from dj.apps.jobs.admin import OutboxMessageAdmin, PublishedStateFilter

    assert PublishedStateFilter in OutboxMessageAdmin.list_filter
    assert 'topic' not in OutboxMessageAdmin.list_filter
    assert 'last_error' not in OutboxMessageAdmin.search_fields
    assert OutboxMessageAdmin.search_fields == ('id', 'dedup_key')
    assert OutboxMessageAdmin.show_full_result_count is False
    assert OutboxMessageAdmin.sortable_by == ('id',)
    assert OutboxMessageAdmin.date_hierarchy is None


# ---------------------------------------------------------------------------
# 7. the relay is wired to the queue the workers actually consume
# ---------------------------------------------------------------------------

def test_the_relay_tasks_are_registered_on_the_pubsub_queue():
    from procrastinate.contrib.django import app

    assert app.tasks['jobs.publish_outbox'].queue == 'pubsub'
    assert app.tasks['jobs.sweep_outbox'].queue == 'pubsub'


def test_the_periodic_sweep_cannot_stack_up_on_the_shared_worker():
    """Two independent bounds, because the arithmetic one is settings-shaped.

    A pass may run for DRAIN_BUDGET_SECONDS plus one row's worst case. Under
    the defaults that total is under the sweep's cron period, so ticks never
    overlap -- but an operator can raise the budget by env var, and the
    the dedicated `pubsub` worker runs concurrency 1, so the queueing lock
    prevents stacked sweeps without putting them behind image/search work.
    """
    from procrastinate.contrib.django import app

    sweep = app.tasks['jobs.sweep_outbox']
    assert sweep.queueing_lock == outbox.SWEEP_QUEUEING_LOCK
    assert sweep.queueing_lock != outbox.RELAY_QUEUEING_LOCK, (
        'sharing the relay lock would let a pending relay suppress the '
        'sweep -- and the sweep is what emits the backlog health line, so a '
        'backlog would silence its own alert')

    period = _cron_period_seconds(settings.PUBSUB_OUTBOX_SWEEP_CRON)
    assert outbox.DRAIN_BUDGET_SECONDS + outbox.ROW_WORST_CASE_SECONDS <= (
        period), (
        'the default budget must leave a whole pass inside one tick; raise '
        'the cron period or lower the budget, do not just widen this')


def _cron_period_seconds(expression: str) -> float:
    """Seconds between ticks of a `*/N * * * *` expression."""
    minute = expression.split()[0]
    assert minute.startswith('*/'), expression
    return int(minute[2:]) * 60


@pytest.mark.django_db(transaction=True)
def test_the_periodic_sweep_continues_a_backlog_instead_of_waiting_a_tick(
        client, monkeypatch):
    """After an outage the sweep is the ONLY thing left to keep going.

    The producers have all finished by then, so nothing else defers a relay.
    A sweep that dropped `more` drained one bounded batch per
    PUBSUB_OUTBOX_SWEEP_CRON tick -- twenty minutes for a 1000-row backlog,
    with recording download URLs expiring behind it -- even though
    publishing had become fast again.
    """
    from dj.apps.jobs import tasks

    deferred = []
    monkeypatch.setattr(
        outbox, 'defer_relay', lambda: deferred.append(1))
    monkeypatch.setattr(outbox, 'BATCH_SIZE', 1)

    with transaction.atomic():
        for n in range(3):
            outbox.enqueue(TOPIC, {'n': n})
    deferred.clear()

    result = tasks.sweep_outbox_task(timestamp=0)
    assert result['drained']['published'] == 1
    assert result['drained']['more'] is True
    assert deferred == [1], 'the sweep must hand the rest straight on'

    #...and stops asking once the backlog is gone.
    tasks.sweep_outbox_task(timestamp=0)
    tasks.sweep_outbox_task(timestamp=0)
    deferred.clear()
    result = tasks.sweep_outbox_task(timestamp=0)
    assert result['drained']['more'] is False
    assert deferred == []


@pytest.mark.django_db(transaction=True)
def test_a_committed_producer_defers_the_relay(monkeypatch):
    """on_commit must actually queue a relay pass, and only after COMMIT."""
    deferred = []
    monkeypatch.setattr(
        outbox, 'defer_relay', lambda: deferred.append(timezone.now()))

    with transaction.atomic():
        outbox.enqueue(TOPIC, {'n': 1})
        assert deferred == []
    assert len(deferred) == 1


@pytest.mark.django_db(transaction=True)
def test_a_queue_outage_cannot_fail_a_committed_producer(monkeypatch, caplog):
    """The defer is a latency optimisation; the sweep is the guarantee.

    Raising here would roll back a comment or a webhook claim because the
    Procrastinate table was unavailable -- trading a delayed message for a
    lost domain write, which is backwards.
    """
    from dj.apps.jobs import tasks

    class _Exploding:
        def configure(self, **kwargs):
            raise RuntimeError('procrastinate is down')

    monkeypatch.setattr(tasks, 'publish_outbox_task', _Exploding())

    with caplog.at_level('ERROR', logger='dj.apps.jobs.outbox'):
        with transaction.atomic():
            message = outbox.enqueue(TOPIC, {'n': 1})

    message.refresh_from_db()
    assert message.published_at is None
    assert 'could not defer' in caplog.text


@pytest.fixture
def clean_relay_admission_jobs(transactional_db):
    # Procrastinate models are unmanaged and Django flush does not remove
    # their rows. Earlier producer tests legitimately leave queued kicks.
    def clear():
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM procrastinate_jobs WHERE task_name IN (%s, %s)",
                ['jobs.publish_outbox', 'jobs.sweep_outbox'],
            )
    clear()
    yield
    clear()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('task_name,legacy_key,new_key', [
    ('jobs.publish_outbox', 'jobs-outbox-publish', outbox.RELAY_QUEUEING_LOCK),
    ('jobs.sweep_outbox', 'jobs-outbox-sweep', outbox.SWEEP_QUEUEING_LOCK),
])
@pytest.mark.parametrize('first_queue', ['default', 'pubsub'])
def test_rolling_and_rollback_relay_admission_stays_independent(
        task_name, legacy_key, new_key, first_queue, clean_relay_admission_jobs):
    """Pending work in an unserved version's queue cannot block the other.

    No worker consumes these jobs: the pubsub-first case is the rollback of
    a failed new worker with its jobs still pending. The default-first case
    is an upgrade while the older catch-all is busy. Same-version duplicates
    must still coalesce through the real PostgreSQL unique index.
    """
    from procrastinate.contrib.django import app
    from procrastinate.exceptions import AlreadyEnqueued

    task = app.tasks[task_name]
    kwargs = {'timestamp': 1} if task_name == 'jobs.sweep_outbox' else {}
    keys = {'default': legacy_key, 'pubsub': new_key}
    queues = [first_queue, 'pubsub' if first_queue == 'default' else 'default']
    ids = [task.configure(queue=queue, queueing_lock=keys[queue]).defer(**kwargs)
           for queue in queues]
    with connection.cursor() as cursor:
        cursor.execute('SELECT queue_name, status FROM procrastinate_jobs WHERE id IN (%s, %s)', ids)
        assert set(cursor.fetchall()) == {('default', 'todo'), ('pubsub', 'todo')}
    for queue in queues:
        with pytest.raises(AlreadyEnqueued):
            task.configure(queue=queue, queueing_lock=keys[queue]).defer(**kwargs)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('task_name,legacy_key', [
    ('jobs.publish_outbox', 'jobs-outbox-publish'),
    ('jobs.sweep_outbox', 'jobs-outbox-sweep'),
])
def test_shared_legacy_keys_block_cross_queue_admission_negative_control(
        task_name, legacy_key, clean_relay_admission_jobs):
    """Reproduce the old rollback deadlock in the actual Procrastinate schema."""
    from procrastinate.contrib.django import app
    from procrastinate.exceptions import AlreadyEnqueued

    task = app.tasks[task_name]
    kwargs = {'timestamp': 1} if task_name == 'jobs.sweep_outbox' else {}
    task.configure(queue='pubsub', queueing_lock=legacy_key).defer(**kwargs)
    with pytest.raises(AlreadyEnqueued):
        task.configure(queue='default', queueing_lock=legacy_key).defer(**kwargs)


@pytest.mark.django_db(transaction=True)
def test_optional_wake_can_be_skipped_without_losing_the_durable_promise(monkeypatch):
    deferred = []
    monkeypatch.setattr(outbox, 'defer_relay', lambda: deferred.append(1))
    with transaction.atomic():
        quiet = outbox.enqueue(TOPIC, {'quiet': True}, wake_up=False)
    assert OutboxMessage.objects.filter(pk=quiet.pk).exists() and deferred == []
    with transaction.atomic():
        outbox.enqueue(TOPIC, {'default': True})
    assert deferred == [1]
