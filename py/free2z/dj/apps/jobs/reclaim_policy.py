"""
Per-task reclaim policy: how long each task may legitimately run, and
which tasks must never be requeued at all (round 4 review).

WHY THIS FILE EXISTS
--------------------
The first cut of ``jobs.reclaim_stalled_jobs`` had ONE age threshold for
every task (900s) and ONE exclusion, expressed as a queue name
(``exports``). Both were wrong in the same way: they encoded an
assumption about *other people's tasks* in a place those tasks' authors
never look.

The adversarial review found the live counter-example.
``dyte.retry_recording_delivery`` runs on ``recordings``, which was not
excluded, and the codebase already states its own model of that task's
duration: ``DYTE_RECORDING_LEASE_SECONDS = max(1800, TOTAL_TIMEOUT + 900)``
= **1800s**, twice the reclaim threshold. It also takes an
application-level claim, so a requeued duplicate renews the claim, returns
early, and procrastinate records the job **SUCCEEDED** -- the ``doing``
row disappears, ``job_stuck`` goes quiet and no give-up alert ever fires.
That is strictly worse than the stall it was trying to fix, and nothing
anywhere would have said so.

So the sweep no longer guesses. Every registered task is classified HERE,
with the number and its source, and:

* a task with a declared runtime gets its OWN reclaim threshold --
  ``max_runtime_seconds`` plus ``JOB_RECLAIM_BUDGET_MARGIN_SECONDS`` --
  never the global floor alone;
* a task that must never be requeued says so, with the reason;
* **a task that is not in this table is never reclaimed.** That is the
  point: ``test_every_registered_task_has_a_reclaim_policy`` fails the
  build for an unclassified task, and if one ever reaches production
  anyway the sweep leaves it alone rather than guessing. Fail closed in
  both directions.

``NEVER`` governs an attempt whose body may have run. The reclaimer has one
narrow infrastructure exception: a matching durable lease marker for the
same attempt's failed acquisition proves its body never began, so that
attempt may be retried within the normal reclaim bound. A task's claim,
provider or other external effects are still never replayed from an
``after_body`` marker.

HOW TO ADD A TASK
-----------------
Read the task. Find its wall clock: an explicit timeout or deadline, a
lease it renews, the size cap on anything it downloads or uploads, the
per-request timeout of its provider SDK times that SDK's retry count. Put
the WORST CASE in ``max_runtime_seconds`` and cite where it comes from in
``reason``. If you cannot bound it, that is not a reason to guess a
number -- use ``NEVER`` and say "unbounded", which is a real, honest
answer that keeps the row visible to ``job_stuck``.

If the task takes an application-level claim, a lease, or a
database-level "already running" flag, it is ``NEVER`` regardless of how
fast it is: a duplicate returns early and gets recorded as a SUCCESS.

BUDGETS THAT ARE ESTIMATES
--------------------------
Some numbers here are read straight off a timeout the task enforces on
itself (``g12f.translate_zpage`` is ``DOCUMENT_TIMEOUT_SECONDS``, and
``translate_document`` really does clamp every request to the remaining
deadline). Others are an ESTIMATE over an I/O path with no total
deadline at all: ``uploads.generate_video_poster`` streams up to 1 GiB
out of GCS with no wall clock on the transfer, so its budget is a
throughput assumption, and no test can prove it -- the registry tests
can only check that a number and a rationale exist.

Those are marked ESTIMATED and set an order of magnitude beyond what the
path is expected to take, rather than at the expected value. It is the
right trade for exactly one reason: ``generate_video_poster`` is the task
of, the one this whole mechanism exists to rescue, so "cannot bound
it, therefore NEVER" would delete the feature. The real fix is a deadline
on the transfer in ``uploads/tasks.py``; until then the generous number
and the label are the honest version. A task that is BOTH unbounded and
not worth rescuing (``dyte.sweep_live_meetings``,
``exports.cleanup_expired_exports``) is ``NEVER`` instead.

UNITS: every duration here is **seconds**.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import ceil

from django.conf import settings
from procrastinate.contrib.django import app

#``max_runtime_seconds`` for a task that must never be requeued.
NEVER = None

# Two sequential OpenAI requests (completion and embedding), each with one
# initial attempt plus SEARCH_OPENAI_MAX_RETRIES. Keep four minutes for page
# loading, tokenization, database work, and client retry backoff beyond the
# provider-call ceiling; the common reclaim margin is added separately.
SEARCH_INDEX_TASK_OVERHEAD_SECONDS = 240
SEARCH_INDEX_MAX_RUNTIME_SECONDS = ceil(
    2 * settings.SEARCH_OPENAI_TIMEOUT_SECONDS
    * (1 + settings.SEARCH_OPENAI_MAX_RETRIES)
) + SEARCH_INDEX_TASK_OVERHEAD_SECONDS


@dataclass(frozen=True)
class TaskPolicy:
    """One task's reclaim classification."""

    #Worst-case wall clock of ONE healthy run, in seconds -- or ``NEVER``
    #if the task must not be requeued at all.
    max_runtime_seconds: int | None
    #Where that number comes from, or why the task is never reclaimed.
    #Read by humans only; the registry test asserts it is non-empty.
    reason: str
    #An enforced wall-clock deadline, if the task has one. Estimated
    #runtimes still delay orphan recovery but must not abort a live run.
    hard_deadline_seconds: int | None = None
    #Alert-only runtime threshold for a live attempt. This never makes a
    #task reclaimable; None uses JOB_HEALTH_STUCK_DOING_SECONDS.
    health_alert_after_seconds: int | None = None

    @property
    def reclaimable(self) -> bool:
        return self.max_runtime_seconds is not None


#EVERY task registered with procrastinate. The registry test asserts
#this set equals ``app.tasks``, so a new task cannot ship unclassified.
#
#The numbers were read out of the tasks in September 2026; each one
#names its source so the next person can re-check it rather than trust
#it.
TASK_POLICIES: dict[str, TaskPolicy] = {
    # -- never reclaimed: an application-level claim or lease ---------------
    'exports.export_publication': TaskPolicy(
        NEVER,
        'once its body may have started, it takes its own claim '
        '(PublicationExportJob -> RUNNING) and is declared retry=False; a '
        'duplicate then sees "not QUEUED", returns, and procrastinate '
        'records it SUCCEEDED -- the doing row vanishes. Only a matching '
        'durable before_body lease marker may bypass NEVER, because that '
        'attempt never reached the claim. Alert after the existing exports '
        'doing-age budget because legitimate exports can run for two hours.',
        health_alert_after_seconds=7200,
    ),
    'dyte.retry_recording_delivery': TaskPolicy(
        NEVER,
        'holds an application lease of DYTE_RECORDING_LEASE_SECONDS '
        '(= max(1800, DYTE_RECORDING_TOTAL_TIMEOUT_SECONDS + 900), so 1800 '
        'by default) and renews it; a duplicate hits renew_recording_claim '
        '/ next_retry_at, returns early, and is recorded SUCCEEDED. The '
        'download alone is budgeted at 900s and the upload of up to '
        'DYTE_RECORDING_MAX_BYTES (2 GiB) happens after that clock.',
    ),

    # -- never reclaimed: no derivable wall clock ---------------------------
    'dyte.sweep_live_meetings': TaskPolicy(
        NEVER,
        'unbounded: DyteClient.get_participants_count issues a bare '
        'requests.get with NO timeout, once per live CreatorMeeting, so '
        'there is no number to derive a threshold from. Periodic every '
        'DYTE_LIVE_SWEEP_CRON, so the next tick is its retry and a requeue '
        'would buy nothing -- and a duplicate of a run hung on a socket '
        'with no timeout would simply hang too.',
    ),
    'dyte.reconcile_create_unknowns': TaskPolicy(
        5,
        'the additive schema release body is a constant-time return with no '
        'database, network, or application-lease work, and that release '
        'schedules nothing; it only runs ticks the lifecycle release defers '
        'onto a not-yet-rolled default worker. Five seconds leaves room for '
        'worker dispatch while making a lost no-op safe to reclaim on the '
        'default queue. The lifecycle release must replace this budget when '
        'it adds provider I/O.',
    ),
    'exports.cleanup_expired_exports': TaskPolicy(
        NEVER,
        'unbounded: one storage delete per expired archive plus one per '
        'stray file, with no cap on either loop. Periodic (retry=False), '
        'so the next sweep is its retry.',
    ),
    'oidc.reevaluate_ai_report_surges': TaskPolicy(
        NEVER,
        'unbounded: one advisory-locked count per app with an unsafe AI '
        'output report in the trailing hour, no cap on the app count. '
        'Periodic every 5 minutes (OIDC_AI_REPORT_SURGE_CRON, retry=False), so '
        'the next tick is its retry; a duplicate run is harmless (the page '
        'is deduplicated per app per hour).',
    ),
    'oidc.sweep_tokens': TaskPolicy(
        NEVER,
        'unbounded: oauth2_provider.models.clear_expired deletes expired '
        'codes and tokens in batches with no wall-clock bound. Periodic '
        '(OIDC_TOKEN_SWEEP_CRON, retry=False), so the next tick is its '
        'retry; every row it removes is already refused at use time.',
    ),

    # -- never reclaimed: a re-run duplicates something visible outside ------
    'jobs.report_job_health': TaskPolicy(
        NEVER,
        'periodic (@app.periodic on JOB_HEALTH_SWEEP_CRON) and deliberately '
        'retry-less: its own docstring at jobs/tasks.py:91-96 says a retried '
        'observability sweep "would only duplicate log lines (and therefore '
        'duplicate alerts)". A reclaim IS that retry, so the same rationale '
        'that makes it retry=False makes it NEVER -- the sweep would re-emit '
        'every per-(queue, alert) ERROR line the alert policies match on '
        'jsonPayload.alert, long after the next tick already produced the '
        'reading. Same call as dyte.sweep_live_meetings: the next tick is '
        'its retry and a requeue buys nothing.',
    ),
    # -- never reclaimed: procrastinate's own builtin -------------------------
    # Registered under two names by procrastinate itself (the plain name and
    # the ``builtin:`` alias), and both are in ``app.tasks``, so both are
    # classified: a lookup miss on either would be a fail-closed skip whose
    # ERROR line nobody can act on.
    'procrastinate.builtin_tasks.remove_old_jobs': TaskPolicy(
        NEVER,
        "procrastinate's own maintenance task: one unbounded DELETE over "
        'procrastinate_jobs, with no cap and no timeout. Nothing in this '
        'repo schedules it, so a stalled copy was started by a human who '
        'can start it again.',
    ),
    'builtin:procrastinate.builtin_tasks.remove_old_jobs': TaskPolicy(
        NEVER,
        "the ``builtin:`` alias procrastinate registers for the same "
        'function as the entry above; classified so neither spelling can '
        'fall through to the unclassified branch.',
    ),

    # -- never reclaimed: the outbox row IS the retry state  ----------
    # Both relay tasks are declared `retry=False` for the same reason they
    # are NEVER here: durability lives in `jobs_outbox_message`
    # (`attempts` / `next_attempt_at`), which survives a worker restart,
    # whereas a requeued procrastinate job is a SECOND retry ladder over the
    # same rows. Neither task loses work when its job is abandoned.
    'jobs.publish_outbox': TaskPolicy(
        NEVER,
        'the relay pass. Nothing is lost when its job dies: the rows it '
        'claimed keep their lease (next_attempt_at) and become due again on '
        'their own, and the periodic jobs.sweep_outbox picks them up within '
        'PUBSUB_OUTBOX_SWEEP_CRON (2 minutes) regardless. A reclaim would '
        'add a second, uncoordinated retry ladder on top of the row-level '
        'one and could republish a message whose publish is still in flight '
        'inside the original run -- the outbox is at-least-once by design, '
        'but not gratuitously so. It also has no derivable wall clock: one '
        'pass is up to PUBSUB_OUTBOX_BATCH_SIZE (100) publishes of '
        'PUBSUB_OUTBOX_PUBLISH_TIMEOUT_SECONDS (30) each, so the worst case '
        'is 3000s -- above every budget here and not worth rescuing when '
        'the sweep already is the rescue.',
    ),
    'jobs.sweep_outbox': TaskPolicy(
        NEVER,
        'periodic (@app.periodic on PUBSUB_OUTBOX_SWEEP_CRON) and '
        'retry-less: the next tick IS its retry, exactly as for '
        'jobs.report_job_health. It also emits the outbox backlog health '
        'line that monitoring/alert-policies/pubsub-outbox-backlog.json '
        'matches on jsonPayload.alert, so a reclaimed re-run would re-emit '
        'a reading long after a later tick produced the current one. Same '
        'unbounded batch as jobs.publish_outbox above.',
    ),

    'e2ee.send_chat_request_email': TaskPolicy(
        NEVER,
        'takes an application-level claim (ChatRequest.email_status '
        'pending -> sending) before calling the mail provider, so a requeued '
        'duplicate finds nothing pending, returns, and is recorded '
        'SUCCEEDED. The provider call is bounded '
        '(tasks.EMAIL_SEND_TIMEOUT_SECONDS = 30s per request, set on the '
        'sendgrid client), but the claim alone makes a requeue pointless. '
        'A lost job loses one notification email, never the request '
        '(dj/apps/e2ee/tasks.py); the request is also in the feed and the '
        'WebSocket push.',
    ),

    # -- never reclaimed: the announcement ROW is the retry state  ---
    'twitter.announce': TaskPolicy(
        NEVER,
        'takes an application-level claim (Announcement pending -> '
        'generating compare-and-set), so a requeued duplicate claims nothing, '
        'returns "noop" and is recorded SUCCEEDED. Its retry ladder lives in '
        'the row (attempts / next_attempt_at), and twitter.sweep_announcements '
        're-defers due rows and moves rows stuck in generating back to '
        'pending, so an abandoned job loses no work. A reclaim of a job that '
        'died inside the X create would be the blind duplicate post #1503 '
        'forbids; the sweep instead moves such a row to '
        'needs_reconciliation.',
    ),
    'twitter.sweep_announcements': TaskPolicy(
        NEVER,
        'periodic (@app.periodic on F2ZP2P_SWEEP_CRON, every 10 minutes) and '
        'retry-less: the next tick is its retry, as for jobs.sweep_outbox. It '
        'emits the f2zp2p health line an alert policy matches, so a '
        'reclaimed re-run would re-emit a stale reading.',
    ),

    # -- never reclaimed: it IS the reclaimer --------------------------------
    'jobs.reclaim_stalled_jobs': TaskPolicy(
        NEVER,
        'the sweep itself. Requeueing its own rows would be an unbounded '
        'self-restart, and its queueing_lock makes the requeue fail anyway '
        'once a later tick holds the lock in todo. A stalled reclaimer is '
        'exactly what job_stuck now means.',
    ),
    'ktauth.sweep_sessions': TaskPolicy(
        NEVER,
        'unbounded wall-clock: each task reads at most one session keyset '
        'page and queues a continuation behind existing work, but database '
        'statements have no hard deadline. Bounded RetryStrategy handles '
        'database failures; a reclaimer duplicate could overlap a stalled pass. The '
        'account epoch and session auth hash revoke at use time, while a '
        'failed or stalled cleanup remains visible to job health.',
    ),

    # -- reclaimable, with their own budgets ---------------------------------
    'g12f.translate_zpage': TaskPolicy(
        900,
        'service.DOCUMENT_TIMEOUT_SECONDS. It is a real wall clock: '
        '_complete() clamps every per-unit REQUEST_TIMEOUT_SECONDS (180) '
        'to the remaining deadline, so the document cannot overrun it. A '
        'duplicate is ledger-safe (_AlreadySettled / mark_delivered only '
        'from QUEUED) but DUPLICATES A PAID CALL -- a second set of billed '
        'provider calls -- which is why the margin matters here more than '
        'elsewhere. The 900s provider deadline starts after task preparation, '
        'so it is not a hard deadline for the whole Procrastinate attempt.',
    ),
    'search.index_zpage': TaskPolicy(
        SEARCH_INDEX_MAX_RUNTIME_SECONDS,
        'two sequential OpenAI calls (completion + embedding), each using '
        'SEARCH_OPENAI_TIMEOUT_SECONDS with one initial attempt plus '
        'SEARCH_OPENAI_MAX_RETRIES, plus 240s for loading, tokenization, '
        'database work, and retry backoff. The request bound is configured '
        'by the same settings used in search/helpers.py. A duplicate is '
        'state-safe (the row is overwritten, not appended) but DUPLICATES '
        'A PAID CALL: two billed OpenAI requests per re-run.',
    ),
    'search.index_multilingual_zpage': TaskPolicy(
        SEARCH_INDEX_MAX_RUNTIME_SECONDS,
        'same two bounded OpenAI calls and 240s task overhead as '
        'search.index_zpage. A duplicate is state-safe, but it DUPLICATES '
        'A PAID CALL.',
    ),
    'uploads.sweep_video_posters': TaskPolicy(
        NEVER,
        'VIDEO_POSTER_SWEEP_BUDGET limits enqueues. Candidate selection and '
        'per-owner admission have statement/lock timeouts, but multiple '
        'transactions and connection/commit I/O have no whole-pass deadline. '
        'The next periodic tick retries '
        'unattempted videos; admitted jobs remain durable independently. '
        'Do not overlap a stalled sweep by inventing a wall-clock budget.',
    ),
    'uploads.generate_video_poster': TaskPolicy(
        1800,
        'ESTIMATED, not enforced -- see "budgets that are estimates" '
        'above. One poster subprocess capped at '
        'POSTER_SUBPROCESS_TIMEOUT_SECONDS (75) plus a 10s kill grace, '
        'around a GCS read of up to video_utils.MAX_SOURCE_BYTES (1 GiB) '
        'and one small WebP upload, NEITHER of which has a total '
        'deadline. 1800s is the whole 1 GiB cap at ~600 KiB/s -- an order '
        'of magnitude below what the cluster gets from GCS, and still '
        'inside JOB_HEALTH_STUCK_DOING_SECONDS. What makes a duplicate '
        'state-safe is NOT the task\'s parent_id guard (both copies pass '
        'it) but models.ImageVariant\'s UniqueConstraint on '
        '(parent, width, format) -- which only fires because the poster '
        'width is deterministic (the POSTER_MAX_WIDTH fit in '
        'video_utils.py). Non-deterministic sizing would leave two poster '
        'variants and nothing would catch it.',
    ),
    'uploads.generate_image_variants': TaskPolicy(
        1200,
        'ESTIMATED, not enforced. One source read bounded in PIXELS by '
        'image_utils.MAX_DECODE_PIXELS -- which bounds the decode, not '
        'the storage time -- then five WebP encodes and five uploads '
        '(models.VARIANT_WIDTHS). Same undeadlined storage I/O as '
        'generate_video_poster, with a much smaller source and no '
        'subprocess.',
    ),
    'uploads.delete_pending_blob': TaskPolicy(
        120,
        'at most two GCS calls, each bounded by '
        'BLOB_DELETE_REQUEST_TIMEOUT_SECONDS (10) inside '
        'BLOB_DELETE_RETRY_TIMEOUT_SECONDS (30).',
    ),
    'uploads.enqueue_pending_blob_deletions': TaskPolicy(
        120,
        'database-only: one capped query (100 rows) and one defer per row.',
    ),
    'dyte.recover_recording_deliveries': TaskPolicy(
        300,
        'database-only: at most DYTE_RECORDING_RECOVERY_BATCH_SIZE defers '
        'plus two bounded queries. It enqueues the download work rather '
        'than doing it.',
    ),
    'g12f.release_deleted_usernames': TaskPolicy(
        60,
        'ESTIMATED: at most 500 single-row transactions (one SELECT FOR '
        'UPDATE and two UPDATEs each, no network) per run; idempotent, so a '
        'requeued copy finds nothing left to release.',
    ),
    'g12f.detect_zpage_language': TaskPolicy(
        120,
        'DETECTION_JOB_BUDGET_SECONDS (10) plus, per its own comment, one '
        'outstanding provider request timeout (~30s) that the budget '
        'cannot cut short. State-safe on a re-run, but it DUPLICATES A PAID '
        'CALL: one more billed detection request.',
    ),
    'g12f.publish_zpage': TaskPolicy(
        120,
        'a filtered UPDATE compare-and-set plus the defers it triggers; '
        'database-only.',
    ),
    'g12f.notify_published_zpage': TaskPolicy(
        120,
        'DATABASE-ONLY since #1691: one published_and_active() read and one '
        'outbox INSERT (dj.apps.jobs.outbox.enqueue). It no longer touches '
        'Pub/Sub at all -- the relay does -- so the unbounded get_topic / '
        'create_topic round trip and the un-awaited publish future that made '
        'this NEVER are both gone, and the budget is the same one '
        'g12f.publish_zpage carries for the same shape of work. A duplicate '
        'run is collapsed in PostgreSQL, not in application code: the second '
        'enqueue reuses the UNIQUE dedup_key '
        '"page_update:<zpage_id>:job:<procrastinate job id>" -- the task is '
        'pass_context=True and both a retry and a reclaim UPDATE the same '
        'job row, so every execution of one deferred job builds the same '
        'key (g12f/publication.py:page_update_dedup_key) -- and writes '
        'nothing, so two executions leave ONE outbox row and send ONE '
        'message, unconditionally rather than "unless the page changed in '
        'between". Downstream, '
        'page_update_subscriber.fan_out_page_update now makes its 6h '
        'exists() check and its create-per-fan loop atomic under a '
        'transaction-scoped advisory lock, so a redelivery cannot double-'
        'notify either. Contract test: '
        'dj/apps/g12f/test_page_update_outbox.py.',
    ),
    'purchases.expire_zec_intent': TaskPolicy(
        NEVER,
        'Database-only unused funding cleanup with 12 bounded retries. '
        'No total wall-clock deadline bounds the existing release transaction; '
        'do not guess a runtime for generic reclaim. Failed cleanup remains '
        'visible; purchases.reconcile_zec_expiry repairs original rows each minute, '
        'including missing, killed and exhausted deadline jobs.',
    ),
    'purchases.reconcile_zec_expiry': TaskPolicy(
        NEVER,
        'Periodic every minute, database-only maximum 50 original instructions '
        'per tick, 30s cooperative tick budget, built-in pending-only queueing dedupe, '
        'and per-row 1s lock and 5s statement timeouts. No total '
        'wall-clock deadline: the next tick repairs the same durable rows.',
    ),
    'g12f.renew_subscription': TaskPolicy(
        120,
        'database-only money path: select_for_update on one subscription '
        'plus ledger.lock_in_order. No network call.',
    ),
    'g12f.reap_translation_charges': TaskPolicy(
        300,
        'database-only refund sweep over charges.abandoned_records(), '
        'which takes an explicit row limit.',
    ),

    # Dedicated ledger periodics retry on the next tick. Claims and bounded
    # database waits belong to the task, never the generic lease reclaimer.
    'ledger.expire_holds': TaskPolicy(
        NEVER,
        'Returns at once while to_regclass(ledger_hold) is '
        'NULL; otherwise runs every '
        'minute with a 55 s deadline (design §11), so the next tick is its '
        'retry and a requeued copy would only race the live one over the '
        'same expired holds.',
    ),
    'ledger.maintain_partitions': TaskPolicy(
        NEVER,
        'Hourly idempotent partition maintenance on the dedicated ledger queue; '
        'bounded transaction-local waits and a NOWAIT row claim. Next tick retries.',
    ),
    'ledger.ai_rollup': TaskPolicy(
        NEVER,
        'Returns at once while to_regclass(ledger_hold) is '
        'NULL; otherwise runs every minute and is '
        'single-flight by design (the rollup state row is taken NOWAIT, '
        'design §11): a requeued duplicate would find the lock held, return, '
        'and be recorded SUCCEEDED while the real drain is still running.',
    ),

    # -- reclaimable: the two probes of  --------------------------------
    # Neither is ever deferred by production code. They are classified so
    # the registry test holds and so the sweep treats a stranded probe the
    # way it treats any other short task -- the chaos tests depend on
    # exactly that: a chaos row must be reclaimed by the SAME path a poster
    # row is, not by a special case.
    'jobs.chaos_probe': TaskPolicy(
        5,
        'chaos_tasks.CHAOS_PROBE_MAX_SECONDS: the sleep mode clamps its '
        'argument to it, the other modes return (or kill the process) at '
        'once, and there is no I/O of any kind. The number is deliberately '
        'tiny so a CI chaos case can wait out the whole threshold '
        '(budget + JOB_RECLAIM_BUDGET_MARGIN_SECONDS at 0) inside its own '
        '15s budget. STATE_IDEMPOTENT: the body writes nothing but an '
        'optional marker file the test owns. Refuses to run unless '
        'JOBS_CHAOS_PROBE_ALLOWED=1, and lives on the unserved `chaos` '
        'queue, so it cannot reach a production lane.',
    ),
    'jobs.smoke_probe': TaskPolicy(
        30,
        'smoke.SMOKE_PROBE_MAX_SECONDS: database-free. It compares the '
        'commit it was deferred with against the BUILD_SHA the worker '
        'process was started with and returns; no network, no storage. '
        'Deferred only by `manage.py jobs_smoke`, once per queue in the '
        'worker manifest union, so a lane nobody serves fails the smoke '
        'instead of a customer. STATE_IDEMPOTENT: a re-run proves the same '
        'thing twice. The generous number is for a cold worker pod fetching '
        'it during a rollout, not for the body.',
    ),
}


def policy_for(task_name: str) -> TaskPolicy | None:
    """The task's policy, or ``None`` if it is not classified at all."""
    return TASK_POLICIES.get(task_name)


def reclaim_after_seconds(policy: TaskPolicy, *, floor: int,
                          margin: int) -> int | None:
    """
    How old a job of this task must be before the sweep may requeue it.

    ``None`` for a task that is never reclaimed. Otherwise the task's own
    budget plus ``margin``, but never below ``floor``: the floor is the
    global setting, and the per-task value only ever RAISES the bar. A
    task can therefore never be made reclaimable-sooner-than-safe by an
    env var.
    """
    if not policy.reclaimable:
        return None
    return max(int(floor), int(policy.max_runtime_seconds) + int(margin))


def retry_allowance(task_name: str) -> int | None:
    """
    The largest ``attempts`` a job of this task can carry PURELY from its
    own retry strategy, while still sitting in ``doing``.

    This is the correction the review asked for. ``procrastinate_jobs
    .attempts`` counts every requeue, whoever did it, so comparing it
    against a reclaim bound terminalizes jobs that were never reclaimed
    once: ``uploads.delete_pending_blob`` carries
    ``RetryStrategy(max_attempts=5)``, so three transient GCS failures
    followed by one lost worker used to be marked ``failed`` on its FIRST
    stall with two retries still owed to it.

    ``RetryStrategy.get_retry_decision`` refuses once
    ``job.attempts >= max_attempts``, and the increment happens in
    ``retry_job`` afterwards, so ``attempts`` reaches exactly
    ``max_attempts`` on the last run the strategy allows. Subtracting this
    from ``attempts`` gives a LOWER bound on the number of reclaims --
    strategy retries can only be fewer than the allowance once reclaims
    have inflated ``attempts`` past it -- so the sweep gives up late, never
    early.

    Returns ``None`` for a strategy with no ``max_attempts`` (retry=True):
    reclaims cannot be separated from retries at all there, and the caller
    must refuse to reclaim rather than loop forever.
    """
    task = app.tasks.get(task_name)
    if task is None:
        return None
    strategy = getattr(task, 'retry_strategy', None)
    if strategy is None:
        return 0
    max_attempts = getattr(strategy, 'max_attempts', None)
    if not max_attempts:
        return None
    return int(max_attempts)
