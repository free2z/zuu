"""The Pub/Sub transactional outbox (follow-up to /).

WHAT WAS WRONG
--------------
Two producers published to Pub/Sub from inside a database transaction:

* ``dyte.views.publish_recording_ready`` blocked on
  ``future.result(timeout=DYTE_PUBSUB_PUBLISH_TIMEOUT_SECONDS)`` while the
  webhook's ``@transaction.atomic`` was still open, so a Pub/Sub slowdown
  held a *web worker's* database connection for the whole timeout; and
* the comments ``post_save`` receiver published from ``transaction.on_commit``,
  which is correctly ordered but is **not durable** -- the process can die
  between COMMIT and the callback, and nothing ever retries it.

Neither is fixable with better error handling: PostgreSQL cannot transact
with Pub/Sub, so the only way to make "the row exists" and "the message was
sent" agree is to write the intent to send into the SAME transaction as the
row, and let a separate relay do the sending.

WHAT THIS TABLE IS
------------------
One row = one message we have PROMISED to publish. It is written by the
producer inside its own transaction (so a rollback un-promises it for free)
and cleared by ``jobs.outbox.drain`` after Pub/Sub accepts the message.

Delivery is **at least once**, deliberately. A relay that crashes after
``publish()`` returned but before ``published_at`` is stamped will publish
again; the alternative (stamp first, publish after) loses messages instead,
which is strictly worse here because the message is a promise made by a
transaction that already charged somebody.

BE PRECISE ABOUT WHICH CONSUMERS SURVIVE THAT, because an earlier version of
this paragraph claimed all of them did. ``recording_idempotency_key``,
the comment UUID in ``aiscore_comments``, and the independent
``(comment UUID, consumer)`` claims in ``tweet_comments`` and ``tag_comments``
 are durable keys. Each comments subscriber claims its own key, so a
duplicate delivery cannot repeat that subscriber's paid or public side effect.

The comments claims are at-most-once boundaries, not a transactional bridge to
OpenAI, image generation, or Twitter. A process crash after a claim commits
but before the external call may leave the promised effect undone and require
operator reconciliation; taking over an ambiguous claim would instead risk a
second paid/public effect. This is the deliberate consumer trade against the
outbox's at-least-once delivery.

BE PRECISE ABOUT THE FREQUENCY TOO, because "it widens an existing window"
understates it. The comments producer published exactly once from
``on_commit``, with no retry: the only way to get a second delivery was
Pub/Sub's own redelivery. This table adds a retry ladder and a relay that
can be interrupted, so EVERY producer-side duplicate is new frequency, not
merely a wider window -- a transient publish failure that later succeeds, a
budget cut-off between publish and settle, a relay killed in that same gap.
The trade is deliberate: silent loss of a message a charged transaction
promised is worse than a duplicate tweet. The fix still belongs in the
consumers, and it is now a *more* load-bearing fix than it was: see.

A row that can NEVER publish -- a deleted topic, a dropped IAM binding, a
payload over Pub/Sub's 10MB limit -- has one sanctioned terminal state, and
it is ``manage.py outbox_abandon`` rather than SQL or the admin: it refuses
any row that still has a chance and prints and logs the entire row at ERROR
before deleting it, so the promise outlives the row. Which copy survives
depends on how it is run -- under the runbook's ``kubectl exec`` the
operator's terminal is the only one, because the logging agent collects the
container's main process, not an exec stream. That command's module
docstring says so at the point of use.

UNITS: ``attempts`` is a count of delivery attempts STARTED, not of failures.
Every duration in the relay is **seconds**.
"""
from django.db import models
from django.utils import timezone


class OutboxMessage(models.Model):
    """A Pub/Sub message that a committed transaction promised to publish."""

    #Fully-qualified Pub/Sub topic path (``projects/<p>/topics/<t>``).
    #Stored per row rather than as an enum because ``settings.PUBSUB``
    #interpolates ``NAMESPACE``: a row written by a prod pod must publish
    #to the topic that pod meant, even if the relay's settings change.
    topic = models.TextField()

    #The JSON message body, exactly as ``PubSubClient.publish`` will encode
    #it. Anything not JSON-serialisable must be converted by the producer,
    #which is where the domain knowledge is.
    #
    #RETENTION AND SENSITIVITY, decided rather than overlooked. A payload
    #can carry a credential: ``dyte.views.publish_recording_ready`` puts
    #the provider's presigned ``downloadUrl`` in ``payload['url']``, and
    #the webhook that receives it deliberately never logs that value.
    #Here it is stored, and an unpublished row is kept until it is delivered
    #or explicitly abandoned, so the row outlives the message; the admin
    #renders it on the change page (the whole model is readonly there); and
    #``outbox_abandon`` prints it, and logs it where the process's stdout is
    #collected. Unkeyed published rows are pruned after the documented
    #``PUBSUB_OUTBOX_PUBLISHED_RETENTION_DAYS`` horizon; keyed published
    #rows remain so the unique deduplication promise does not expire.
    #
    #We keep it, on purpose, for three reasons: the payload IS the
    #promise, so a row without it cannot be re-enqueued by hand after an
    #abandon and cannot answer "what did we actually send"; scrubbing
    #would have to live in the relay, which is the one place with no
    #per-topic domain knowledge; and the exposure is not new -- the same
    #URL is already persisted by ``dyte.RecordingDelivery.download_url``.
    #The credential also expires on its own, which is precisely why an
    #undelivered recording message is an incident.
    #
    #What that costs, stated so a future change can weigh it: this is a
    #second persisted copy, and it rides any database copy into a lower-trust
    #environment. Unkeyed published rows have the documented retention
    #horizon; keyed rows intentionally have no expiry for idempotency. A
    #producer with a secret that does NOT expire should put a reference in
    #the payload and leave the secret where it already lives.
    payload = models.JSONField()

    #Optional Pub/Sub message attributes. Always passed through so a
    #reader never has to know whether an empty dict means "none declared"
    #or "not supported".
    attributes = models.JSONField(default=dict, blank=True)

    #The OUTBOX ordering key. Rows that share a non-empty key are published
    #strictly in ``id`` order, and a failing row blocks its own successors
    #(see ``jobs.outbox.due_messages``). Empty string means "unordered".
    #
    #This is deliberately NOT forwarded to Pub/Sub. ``publisher.publish()``
    #raises ``ValueError`` for a message with an ordering key unless the
    #PublisherClient was constructed with
    #``publisher_options=PublisherOptions(enable_message_ordering=True)``,
    #AND ordered delivery additionally requires the *subscription* to have
    #been created with message ordering enabled -- ours were not
    #(``gcp/pubsub/client.py`` creates them with defaults). Passing the key
    #through today would turn every ordered publish into a hard failure.
    #Ordering the relay is the guarantee this table can actually keep.
    ordering_key = models.CharField(max_length=255, blank=True, default='')

    #Whether the relay may create the topic if it does not exist. The
    #recording producer sets this False (: a missing topic must fail
    #the publish rather than run synchronous admin RPCs); the comments
    #producer has always relied on auto-creation, and losing that would
    #break every namespace whose topic is created lazily.
    ensure_topic = models.BooleanField(default=False)

    created_at = models.DateTimeField(default=timezone.now)

    #Non-null once Pub/Sub has accepted the message. This is the only
    #"done" signal; there is no status enum to fall out of sync with it.
    published_at = models.DateTimeField(null=True, blank=True)

    #Delivery attempts STARTED. Incremented when the relay claims the row,
    #not when it fails, so a relay that is killed mid-publish still burns
    #an attempt and still backs off.
    attempts = models.PositiveIntegerField(default=0)

    #When the row next becomes eligible. Claiming a row pushes this into
    #the future, which doubles as the relay's lease: a crashed relay's row
    #becomes claimable again after the backoff, and no second relay can
    #pick it up before then.
    next_attempt_at = models.DateTimeField(default=timezone.now)

    last_error = models.TextField(blank=True, default='')

    #Optional caller-supplied collapse key, UNIQUE across the table.
    #
    #A producer that can be driven twice for the same real-world event --
    #'s ``g12f.notify_published_zpage`` is the motivating case: an
    #unguarded broadcast whose only gate is a read both copies pass -- sets
    #this, and the SECOND enqueue is a no-op instead of a second message.
    #The collapse therefore happens in PostgreSQL, under the producer's own
    #transaction, which is the only place two concurrent producers can be
    #made to agree; an application-level ``exists()`` check cannot.
    #
    #NULL, not ``''``, for "no dedup wanted". PostgreSQL treats every NULL
    #as distinct in a UNIQUE index, so unlimited un-keyed rows coexist,
    #while an empty string would collapse the entire table into one row.
    #``enqueue()`` refuses an empty string for exactly that reason.
    #
    #SCOPE, stated so nobody expects more than it gives: the key collapses
    #for the LIFE OF THE ROW. Keyed published rows are intentionally outside
    #the outbox retention sweep, so this is effectively permanent. A caller
    #that wants "at most one per hour" must put the window into the key
    #itself.
    dedup_key = models.CharField(
        max_length=255, null=True, blank=True, default=None, unique=True)

    class Meta:
        db_table = 'jobs_outbox_message'
        indexes = [
            # The relay's only hot query: unpublished rows, oldest first.
            # PARTIAL on published_at IS NULL because published rows
            # accumulate forever and are never read by the relay again.
            models.Index(
                fields=['next_attempt_at', 'id'],
                condition=models.Q(published_at__isnull=True),
                name='jobs_outbox_due_idx',
            ),
            # Serves the "does this ordering key have an earlier unpublished
            # row?" correlated subquery, and the backlog-age health query.
            models.Index(
                fields=['ordering_key', 'id'],
                condition=models.Q(published_at__isnull=True),
                name='jobs_outbox_ordering_idx',
            ),
        ]

    def __str__(self):
        state = 'published' if self.published_at else 'pending'
        return f'OutboxMessage(id={self.pk}, {state}, topic={self.topic})'


class JobLease(models.Model):
    """
    One row = one job a worker process is RUNNING RIGHT NOW and beating.

    The table is written and read exclusively by raw SQL in
    ``dj.apps.jobs.lease`` (and, once  lands, by the reclaimer's
    sweep). This model exists so the table is in the migration graph and
    so `manage.py inspectdb`-style tooling, the admin and future ORM
    readers see the same schema; nothing on the hot path goes through
    it. The lease is beaten from a bare psycopg connection on one daemon
    thread precisely so it costs no Django ORM connection per running
    job (``BUILD.bazel:159-184``: the connection budget), so routing the
    beat through this model would undo the property  was built for.

    THE SCHEMA IS PINNED, NOT MERELY DESCRIBED. ``lease.LEASE_TABLE_DDL``
    is the schema the middleware's SQL is written against, and until this
    migration existed the tests created the table from it directly. The
    two must agree column for column, default for default, index for
    index -- a ``varchar(255)`` that migrated as ``text`` or an
    ``attempt`` that migrated without its ``DEFAULT 0`` is a difference
    no test of the middleware can see, because the middleware always
    names every column. ``test_lease_migration.py`` compares the parsed
    ``sqlmigrate`` output against the parsed DDL and fails on any drift
    in either direction.

    WHY THE DB-LEVEL DEFAULTS ARE ``db_default`` AND NOT ``default``.
    Django's ``default=`` lives in Python and is deliberately dropped
    from the column after a migration; ``db_default`` (Django 5.0+) is
    kept in the DDL. The DDL has three (``worker_name``, ``pod``,
    ``attempt``), so ``db_default`` is what reproduces it. No writer
    relies on them today -- every INSERT in ``lease.py`` names all ten
    columns -- and that is exactly why they have to be pinned here: a
    future writer that omits a column would silently get a different
    answer against a table built by the migration than against one built
    by the DDL.

    NO FOREIGN KEY to ``procrastinate_jobs``, on purpose. A FK would make
    our table a participant in procrastinate's own schema migrations and
    would take a lock on the queue table on every lease INSERT; more
    importantly, a lease is allowed to outlive the row it names (that is
    the "unverified exit" recovery path in ``lease.py``), which a
    ``CASCADE`` would delete and a ``PROTECT`` would wedge.
    """

    #``procrastinate_jobs.id``. The PRIMARY KEY, so one job has at most
    #one lease and the middleware's ``ON CONFLICT (job_id)`` take-over
    #rule has an index to arbitrate on.
    job_id = models.BigIntegerField(primary_key=True)

    #The fencing token. A beat and the exit DELETE are compare-and-swaps
    #on ``(job_id, token)``: a row the reclaimer removed, or one a newer
    #attempt took over, is not matched, and not matching IS the fence.
    token = models.UUIDField()

    #``Worker.name`` -- which worker process, for the operator.
    worker_name = models.CharField(
        max_length=255, blank=True, default='', db_default='')

    #``HOSTNAME`` -- which pod, for correlating with a container restart.
    pod = models.CharField(
        max_length=255, blank=True, default='', db_default='')

    task_name = models.CharField(max_length=255)
    queue = models.CharField(max_length=255)

    #When this attempt started running. Not when the job was deferred.
    #CLOCK DOMAIN: the WORKER PROCESS's clock (procrastinate's
    #``start_timestamp``, passed in as a parameter) -- unlike
    #``last_beat_at``, which is always the database's ``now()``.
    started_at = models.DateTimeField()

    #The liveness signal itself: refreshed every
    #``JOB_LEASE_BEAT_SECONDS``.  reads exactly this column, which
    #is why it is the one indexed field.
    last_beat_at = models.DateTimeField()

    #``started_at + policy.max_runtime_seconds``, or NULL for a task the
    #registry marks ``NEVER`` (a deadline on such a task would make
    #fail a job it must never requeue). Process clock, like
    #``started_at``: comparing it with the database's ``now()`` is
    #cross-domain, so any reclaim margin must absorb node clock skew
    #(sub-second under NTP today, against 1800-7200s runtimes). Keep that
    #in mind before tightening ``JOB_RECLAIM_BUDGET_MARGIN_SECONDS``.
    deadline_at = models.DateTimeField(null=True, blank=True)

    #``procrastinate_jobs.attempts`` as this attempt fetched it. Plain
    #``IntegerField``: ``PositiveIntegerField`` would add a CHECK
    #constraint the DDL does not have.
    attempt = models.IntegerField(default=0, db_default=0)

    class Meta:
        db_table = 'jobs_joblease'
        indexes = [
            # NAMED EXPLICITLY. Django would otherwise generate a hashed
            # name, and 's sweep, the DDL the tests build from, and
            # anyone reading EXPLAIN output all refer to it by this name.
            models.Index(
                fields=['last_beat_at'],
                name='jobs_joblease_last_beat_at_idx',
            ),
        ]

    def __str__(self):
        return f'JobLease(job_id={self.job_id}, task={self.task_name})'


class OperatorAction(models.Model):
    """Durable audit record for an explicitly executed job operation."""

    actor = models.CharField(max_length=255)
    verb = models.CharField(max_length=32)
    job_ids = models.JSONField(default=list)
    reason = models.TextField()
    dry_run = models.BooleanField(default=False)
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = 'jobs_operator_action'
        ordering = ['-at', '-id']


class QueueControl(models.Model):
    """Pause and drain state read by worker fetch gates and task middleware."""

    queue = models.CharField(max_length=255, primary_key=True)
    paused_at = models.DateTimeField(null=True, blank=True)
    reason = models.TextField(blank=True, default='')
    actor = models.CharField(max_length=255, blank=True, default='')
    draining = models.BooleanField(default=False)

    class Meta:
        db_table = 'jobs_queue_control'

    @property
    def paused(self) -> bool:
        return self.paused_at is not None


class ParkedJob(models.Model):
    """Original job properties needed to reverse a queue drain safely."""

    source_job_id = models.BigIntegerField(primary_key=True)
    parked_job_id = models.BigIntegerField(unique=True)
    task_name = models.CharField(max_length=255)
    queue = models.CharField(max_length=255)
    priority = models.IntegerField()
    lock = models.CharField(max_length=255, null=True, blank=True)
    queueing_lock = models.CharField(max_length=255, null=True, blank=True)
    scheduled_at = models.DateTimeField(null=True, blank=True)
    args = models.JSONField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = 'jobs_parked_job'


class QuarantinedJob(models.Model):
    """Durable identity for a job the stalled-job reclaimer gave up on."""

    job_id = models.BigIntegerField(primary_key=True)
    task_name = models.CharField(max_length=255)
    queue = models.CharField(max_length=255)
    reason = models.TextField()
    attempts = models.IntegerField(default=0)
    quarantined_at = models.DateTimeField(default=timezone.now)
    requeued_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'jobs_quarantined_job'
