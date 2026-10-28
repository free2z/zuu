"""
Job-level leases: the liveness signal the reclaimer can trust.

WHY PROCRASTINATE'S OWN HEARTBEAT IS NOT ENOUGH
-----------------------------------------------
``procrastinate_workers.last_heartbeat`` answers "is this *process*
alive" and even that only ambiguously: ``prune_stalled_workers`` runs at
a PEER's startup and deletes the worker row (``sql/schema.sql:553-561``),
``procrastinate_jobs.worker_id`` is ``ON DELETE SET NULL``
(``schema.sql:77``), and ``update_heartbeat`` is a bare ``UPDATE`` that
never re-registers (``schema.sql:542-549``). So a live worker that lagged
once -- a Cloud SQL blip during a rolling deploy -- is "orphaned" for the
life of the process, and ``select_stalled_jobs_by_heartbeat`` counts a
``worker_id IS NULL`` row at any age. That ambiguity is the only reason
the merged reclaimer (``reclaim.py``) needs a 900-2100s *age* threshold,
and that age is the entire healing latency of.

WHAT THIS DOES INSTEAD
----------------------
A procrastinate **task middleware** (3.9: ``App.worker_defaults
["task_middleware"]``, ``procrastinate/app.py:47-48,337``) wraps every
job the worker runs with a **lease row** in our own table
``jobs_joblease``:

* on entry, ``INSERT`` the lease (``job_id``, a fresh ``token``, who is
  running it, when it started, and ``deadline_at = started +
  reclaim_policy.max_runtime_seconds`` -- ``NULL`` for a ``NEVER`` task),
  with durable ``phase = 'before_body'`` in that same commit. Before
  ``call_next`` can enter user code, middleware must commit the exact
  ``(job_id, token, attempt)`` transition to ``body_started`` and verify its
  response. A lost response fails closed; a persisted ``body_started`` phase
  is intentionally treated as possibly executed, even if this process died
  before calling the body;
* while the task runs, ONE daemon thread per worker process beats every
  lease this process holds, every ``JOB_LEASE_BEAT_SECONDS``, with
  ``UPDATE... SET last_beat_at = now() WHERE (job_id, token) IN (...)
  RETURNING job_id``. A lease that the UPDATE did NOT return has been
  **fenced**: someone (the reclaimer, ) deleted it because they
  decided this worker was dead and requeued the job. The middleware then
  asks the task to stop -- ``context.should_abort()`` for a sync task,
  ``asyncio.Task.cancel()`` for an async one -- and, whatever the task
  body does next, raises ``LeaseLost`` and makes sure THIS run writes no
  status at all: never ``succeeded``, and never anything over the
  attempt that replaced it (see "the fence is a handover" below);
* on exit, whatever the outcome, ``DELETE... WHERE job_id = %s AND
  token = %s``. That DELETE is itself the last ownership check: if it
  removes no row, the lease was taken away between the last beat and
  now, and the run is fenced exactly as if a beat had found it -- unless
  it was OUR OWN earlier DELETE that removed it (see ``release``: a
  DELETE that outlived its hand-off deadline still runs, and its late
  success is ownership proven, not a fence).

"Worker gone" then has a precise meaning for the reclaimer: a ``doing``
row whose lease is silent. Silence reclaims; ``deadline_at`` overrun
fails. That is 's half; this module only writes the signal and
honours the fence.

THE SILENCE THRESHOLD IS A NUMBER, AND IT OUTLIVES A FAILOVER
-------------------------------------------------------------
A lease is **silent** when ``last_beat_at < now() -
JOB_LEASE_STALE_SECONDS`` (``settings.py``; ``stale_seconds()`` here;
180s). The reclaimer must read that setting, not restate it, and it must
not go lower than it without reading this paragraph.

A beat that could not RUN is not evidence of anything, and this module
never treats it as a fence: only a beat that ran and did not return the
row is. But a beat failure is **whole-batch and process-wide** -- the
one thread, the one connection -- so a database that is unreachable for
``F`` seconds leaves EVERY lease in EVERY worker process un-beaten for
``F`` plus up to one beat interval plus one hand-off (``beat_seconds()
+ handoff_timeout_seconds()``; the connection is re-opened from scratch
on the next tick, and it is what ``_run`` logs as
``procrastinate_lease_beat_failed``). procrastinate's own worker
heartbeat is a database write too, so it goes silent at the same
moment: the two signals the reclaimer ANDs together fail together. A
threshold shorter than a Cloud SQL failover therefore turns a routine
maintenance event into the reclaimer fencing and requeueing every
in-flight job on every healthy worker at once -- one duplicate run per
job, of exactly the billed calls this epic exists not to repeat.

So ``JOB_LEASE_STALE_SECONDS`` must exceed ``CLOUD_SQL_FAILOVER_BUDGET_
SECONDS + beat_seconds() + handoff_timeout_seconds()`` (90 + 15 + 7 =
112 at the defaults) and ``RELEASE_ATTEMPTS`` hand-offs; the registry
test pins both inequalities. The price is healing latency after a real
crash -- 180s plus a sweep, instead of 60s -- and it is the right
price: a late heal is a slow queue, an early one is a double charge.
``procrastinate_lease_beat_failed`` (per process, per beat) and
``procrastinate_lease_fenced`` (per fence) are counted by
``monitoring/log-metrics/`` and alerted on, so a broken liveness signal
is visible before the reclaimer acts on it.

THE CONTRACT WITH THE RECLAIMER
---------------------------------------
Fencing is a compare-and-swap on the lease row, **and it is the fence
for LEASED rows only.** The reclaimer's last act before ``retry_job``
for a ``doing`` row that HAS a lease must be ``DELETE FROM
jobs_joblease WHERE job_id = %s AND last_beat_at < %s``, and for such a
row it may requeue **only if that DELETE removed a row**: a DELETE that
found nothing while a lease exists means the lease was revived (beaten,
or re-inserted by a run that started meanwhile) and the row belongs to
a live worker -- skip it. The two DELETEs race on one row and exactly
one wins; whoever loses has no standing to write. Join on ``status =
'doing'``: a lease row can outlive its job's ``doing`` state (a run whose
exit could not be verified leaves one behind on purpose, below; a
requeued job's row sits beside its ``todo`` row until the replacement's
INSERT upserts over it), and such a row says nothing about a job that
is not running. Acquisition itself is the freshness rule, and the JOB
ROW is its authority: the lease is written only while
``procrastinate_jobs`` says this attempt is current (``status =
'doing'`` and ``attempts`` equal to what this attempt fetched; every
``retry_job`` and ``finish_job`` increments it), and an existing lease
row is taken over only by an attempt at least as new. So a worker that
froze between fetching a job and inserting its lease, and resumes after
the fallback requeued the job -- whether the replacement is still
running (its newer lease refuses the take-over) or has already finished
(no lease row at all; the job row refuses the INSERT) -- is refused
(``detected=acquire``) and runs NO body: the one fence that lands
before the duplicate rather than after it.

A ``doing`` row with NO lease at all is a different case, and "no row
deleted" must NOT make it unreclaimable. It is not only "the run
finished and took its own lease away and is about to be terminal". It
is also every job that ran during the window before the table's
migration lands (``procrastinate_lease_disabled``: all of them), every
job on a worker that predates this middleware during a rolling deploy,
every job whose unverified acquisition's re-INSERT was given up on
(``procrastinate_lease_cleanup_failed``), and every job
SIGKILLed between its exit DELETE and its ``finish_job`` -- a window
this module CREATES, because the ownership check has to precede the
status write for the fence to mean anything. For all of those the
lease says nothing, and the reclaimer falls back to what it had before
this module existed: procrastinate's worker heartbeat (``worker_id IS
NULL`` or ``last_heartbeat`` stale) plus the age floor. A live worker
is never heartbeat-stale, so the SIGKILL window heals and the
finished-and-about-to-persist run is left alone.

THE FENCE IS A HANDOVER: A FENCED RUN WRITES NOTHING
----------------------------------------------------
procrastinate's own status procedures do not check ownership:
``procrastinate_finish_job_v1`` accepts a ``todo`` row (``schema.sql:
285``) and ``procrastinate_retry_job_v2`` any ``doing`` row -- including
the *replacement attempt* that the reclaimer requeued and another worker
has since started. So it is not enough for a fenced run to end
``failed``: if its task carries a retry strategy, procrastinate would
call ``retry_job`` and move the live replacement back to ``todo`` for a
THIRD worker to start, and ``finish_job`` would mark it terminal under
the replacement's feet. (The adversarial review of this module found
exactly that.) Once its lease is gone this run has no standing to write
the job's status at all, so it does not: the lease is attached to the
job's own ``JobContext`` (``additional_context``, one per attempt, so
two attempts of one job in one process cannot be confused), and the
worker's ``_persist_job_status`` for a run whose lease is lost is
skipped (``event=procrastinate_lease_persist_skipped``). The job row
belongs to whoever holds the lease now.

What the fence cannot do is stop the task BODY: a sync task keeps
running until it polls ``context.should_abort()`` or returns, and its
side effects up to that point are real. That is the epic's stated
trade-off, and why ``reclaim_policy`` records which tasks duplicate a
billed call. Every fence is logged as ``event=procrastinate_lease_fenced``
with ``detected`` = ``acquire``, ``beat``, ``exit`` or ``unverified``.

THE RESIDUAL, STATED: the status write comes AFTER the ownership check
--------------------------------------------------------------------
The exit DELETE proves ownership, and procrastinate writes the status
after the middleware returns; nothing makes the two one atomic step,
because ``finish_job`` / ``retry_job`` take no token. A status write
that RAISES (procrastinate's own connection failing at that instant)
would leave a ``doing`` row with no lease on a live worker, which no
reclaimer path reaches; so the persist wrapper puts the recovery
evidence back -- a job-row-checked, unbeaten lease, retried through
the outage, ``procrastinate_lease_persist_failed`` -- and re-raises.
The body's side effects stand and the reclaimer's requeue runs the
body again: the documented trade-off, and strictly better than a row
nobody finds. What remains is the PAUSE: a process that
is PAUSED between its exit DELETE and its status write -- for longer
than the reclaimer's worker-heartbeat threshold, so that its ``doing``
row (now unleased) is requeued through the fallback path above -- will,
on resuming, write its outcome over the replacement attempt. The window
is the few milliseconds between ``release`` and ``_persist_job_status``,
stretched only by a stop-the-world pause of the whole process for a
minute or more (SIGSTOP, a frozen VM); a crash in it is harmless (the
row is unleased and orphaned, and the fallback requeues it). It is also
strictly narrower than what the reclaimer has today, where the whole
body is that window. Closing it would need the lease to stay beating
through the status write (verify, persist, then delete) and, ideally, a
token on procrastinate's own status procedures;  should size the
fallback path's heartbeat threshold with this in mind.

CONNECTIONS -- the hard rule, and the count
-------------------------------------------
The worker's connections are budgeted to the unit against Cloud SQL's
``max_connections`` (``k8s/free2z/worker/BUILD.bazel``,
``bin/check-free2z-gunicorn.py``: the modelled cross-namespace peak is
within single digits of the ceiling). So the rule is stronger than "the
beat thread must not hold a Django ORM connection across beats":

**Every lease statement -- INSERT, beat, DELETE, the table probe -- runs
on the one beat thread, on one short-lived psycopg connection that is
opened when there is work and closed when the batch is done.** A worker
process therefore holds **at most ONE lease connection at any instant,
and none between beats**, whatever its task concurrency; the middleware
hands its INSERT/DELETE to the thread and waits (bounded, see below).
Nothing here touches ``django.db.connections`` except to read the
connection parameters once, in the calling thread. ``application_name``
is ``jobs-lease`` and ``test_lease.py`` proves the bound two ways.
``bin/check-free2z-gunicorn.py`` counts this connection per worker pod.

Every operation runs in its own transaction with local ``statement_timeout`` and
``lock_timeout`` (``JOB_LEASE_STATEMENT_TIMEOUT_SECONDS``): Django's
``connect_timeout`` bounds the handshake, not a query, and a lease row
locked by someone else's open transaction must fail the statement --
logged, retried next beat -- rather than wedge the one beat thread (and
with it every lease in the process) or the task slot waiting on its
INSERT. The hand-off itself is bounded too: a statement the thread has
not STARTED within the statement timeout plus a margin
(``handoff_timeout_seconds``) is cancelled -- an INSERT gives up and the
run is fenced at acquire, a DELETE is retried. A statement the thread is
already EXECUTING is a different thing: it cannot be cancelled, and
abandoning it means deciding without its outcome, so its waiter stays
with it until the batch's client-side deadline (below) plus a margin has
passed -- at which point the statement cannot still be running. And
because ``statement_timeout`` is delivered by the
server, a socket that has gone black would never deliver it: the
transport is bounded as well (libpq keepalives + ``tcp_user_timeout``,
``transport_bounds()``), so a dead peer fails the statement into the
thread's exception handler within seconds rather than wedging the one
thread until the kernel gives up on the connection. And because the
worker reaches Cloud SQL through the sql-proxy sidecar, whose TCP
session stays perfectly healthy while its upstream stalls, neither of
those is the last word: every batch also has a **client-side
deadline** (``batch_deadline_seconds``), a timer that closes the
connection from outside the stuck ``execute()`` and logs
``procrastinate_lease_batch_deadline``. The thread survives, the ops
in that batch fail back to their waiters, and the next tick starts on
a fresh connection.

BEFORE THE RECLAIMER READS LEASES, AND BEFORE THE TABLE EXISTS
---------------------------------------------------------------
Every fence this module can raise -- ``beat``, ``exit``, ``unverified``
-- ends in "the reclaimer will find it". Until the reclaimer READS
leases, nobody does: ``reclaim.py`` today requires a stale
worker heartbeat, which a live worker never has, so a run that failed
closed on a healthy worker would sit in ``doing`` until ``job_stuck``
paged, and a ``NEVER`` task past that. The signal would be written and
the fence enforced, with the recovery half absent -- all of the risk
and none of the benefit. So the middleware is **inert until
``dj.apps.jobs.reclaim.READS_LEASES`` is true** ( sets it in the
same PR that makes it true), logging ``procrastinate_lease_disabled
reason=reclaimer_not_lease_aware`` once. ``JOB_LEASE_WITHOUT_RECLAIMER``
= true overrides that for an operator who wants the beats visible
before  lands (and for the tests); ``JOB_LEASE_ENABLED`` = false
turns it all off. The gate is code, not an operator hold, so it cannot
be forgotten: it lifts itself the moment the reclaimer that makes it
safe is deployed.

The table is created by ``jobs/0004``, which shipped after this
module because the migration slot is serialised (AGENTS.md). A missing
table must therefore be a **no-op**, not an outage -- and still must,
because an image always runs ahead of its migrations for a while: the
first lease attempt probes ``to_regclass('jobs_joblease')`` and, if the
table is missing, logs ``event=procrastinate_lease_disabled`` once and
lets every job run unleased -- opening no connection at all until
``JOB_LEASE_TABLE_RECHECK_SECONDS`` have passed. ``LEASE_TABLE_DDL``
below is the schema every statement here is written against, and
``test_lease_migration.py`` holds the migration to it exactly.

An INSERT that FAILS is an acquisition that could not be verified, and
that is not permission to run. Earlier drafts ran the job unleased ("a
lease failure is not a job failure"); with acquisition doubling as the
freshness check that is wrong, because a stale attempt whose INSERT
happened to error would execute its body and persist over the
replacement -- exactly what the refused path exists to stop (codex,
round 8). So an INSERT that failed, was never started, or whose outcome
is unknown fences the run before it starts (``detected=acquire
reason=unverified``; ``LeaseLost`` instead of the body; no status
write), and -- because the INSERT may have committed anyway (autocommit,
response lost) or may still land -- queues behind it a job-row-checked
``INSERT... ON CONFLICT DO NOTHING`` so that, if this attempt IS the
job's current one, a row nobody beats exists for the reclaimer to find
silent and requeue. The cost of a transient lease failure is therefore
``JOB_LEASE_STALE_SECONDS`` plus a sweep of delay, never a duplicate;
and the cleanup is retried through the outage, and logged as
``procrastinate_lease_cleanup_failed`` only when it is given up on. A
job that must run NOW regardless is what ``JOB_LEASE_ENABLED=false``
is for.

The exit DELETE is different, because it is the ownership check. A
DELETE that ran and removed nothing is a fence. A DELETE that could not
run (timeout, connection error) is retried once; if that fails too the
run has proved neither ownership nor loss, and it **fails closed**: it
writes nothing (``detected=unverified``) and leaves the ``doing`` row to
the reclaimer. The alternative -- writing over a job somebody else may
own -- is the failure this module exists to prevent, and the two are
correlated: a worker whose DELETE times out is a worker whose beats
were probably already late.

Two things make "unverified" safe rather than merely honest. Both exist
because a DELETE that outlives its waiter is the case where being wrong
is expensive: a ``subscriptions.renew`` that charged the customer, its
own late DELETE removing its row after ``release`` had already decided,
left ``doing`` with no lease on a healthy worker -- which the heartbeat
fallback never touches, because a live worker is never heartbeat-stale
-- until ``job_stuck`` pages at 3600s and a human requeues it into a
second charge (the fresh reviewers' HIGH in round 1, MEDIUM in round 2).

* **A statement that has started is waited for, never abandoned.** The
  hand-off deadline cancels only a statement the thread has not begun:
  ``_Op.started`` is set under the registry lock, in the same critical
  section that reads ``_Op.cancelled``, so the cancel and the start
  cannot cross. A statement the thread is executing is waited for until
  its batch's client-side deadline plus ``OUTCOME_MARGIN_SECONDS``, by
  which time the watchdog has cut the connection and an outcome exists:
  it removed our row (ownership proven; ``release`` returns ``True``),
  removed nothing (a fence), or raised (retried). The decision is never
  taken while our own DELETE is in flight. The one way it still can be
  is a cut that failed to unblock the thread -- ``LeaseOutcomeUnknown``
  -- which is what the second point is for.
* **An unverified exit leaves a lease behind to go silent.** After the
  fence, a token-scoped ``INSERT... ON CONFLICT (job_id) DO NOTHING``
  is queued BEHIND the outstanding DELETEs on the one thread. If a late
  DELETE lands after all and removes our row, the re-INSERT recreates
  it; nobody beats it (``release`` unregistered it), so the reclaimer
  finds it silent and requeues through the leased path. If the row is
  still there (no DELETE ran) or is a replacement's, ``DO NOTHING``
  touches nothing. Either way a ``doing`` row this run could not verify
  is one the reclaimer WILL find, within ``JOB_LEASE_STALE_SECONDS``
  plus a sweep -- a ``NEVER`` task included, which the fallback path
  would not recover even after a restart. And because the outage that
  made the DELETE uncertain is usually still going on when the
  re-INSERT runs, a cleanup that fails is **retried one beat later**,
  up to ``CLEANUP_ATTEMPTS`` times (twelve beats: longer than a
  failover -- and it is beats of ELAPSED time, not wake-ups, because
  every unrelated INSERT/DELETE wakes the thread and a busy worker
  would otherwise spend the whole budget in under a second), and only
  then logged ``procrastinate_lease_cleanup_failed`` and dropped.
  Both cleanups are idempotent -- the DELETE is token-scoped, the
  INSERT is ``DO NOTHING`` -- so a retry can never do more than the
  first attempt would have. (A retry that lands after the job's
  replacement has finished can leave a lease row for a terminal job;
  the reclaimer joins on ``doing`` and may sweep such rows.)

``release`` also keeps every attempt's ``_Op`` and, before it fences on
"nothing removed", asks whether an earlier attempt eventually removed
the row itself (``procrastinate_lease_delete_landed_late``): the ops run
in order on the one thread, so by the time a later attempt has answered,
every earlier one is done. With started statements waited for, that
check only ever fires behind a ``LeaseOutcomeUnknown``; it stays because
it is cheap and it is the last line. And a DELETE that STARTED and then
RAISED is not evidence that nothing was removed: under autocommit it may
have committed and lost its response, exactly as the INSERT in
``acquire`` may. So "the retry removed nothing" behind such an attempt
is ``unverified`` (``procrastinate_lease_delete_outcome_uncertain``),
with the lease left behind as above -- never an ``exit`` fence, which
would leave nothing for anyone to find.

UNITS: every duration here is **seconds**.
"""
from __future__ import annotations

import asyncio
import collections
import logging
import os
import signal
import socket
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone as dt_timezone
from typing import Any

import psycopg
from asgiref.sync import sync_to_async
from django.conf import settings
from procrastinate import exceptions

from dj.apps.jobs.logs import emit_json_line

logger = logging.getLogger(__name__)

#Our table. Written by raw SQL here, described by
#``jobs.models.JobLease`` (``jobs/0004``); the reclaimer reads it.
LEASE_TABLE = 'jobs_joblease'

#``application_name`` of the one lease connection. The connection-count
#test filters ``pg_stat_activity`` on it.
APPLICATION_NAME = 'jobs-lease'

#The name of the beat thread; every lease connection is opened on it.
THREAD_NAME = 'jobs-lease-beat'

#Where the middleware stores this attempt's lease on its
#``JobContext.additional_context`` (a per-job dict, ``worker.py:416``),
#so the persist wrapper finds THIS attempt's lease and no other.
LEASE_CONTEXT_KEY = 'jobs_lease'

#The schema the lease writes against, as a ``CREATE TABLE IF NOT
#EXISTS``. ``jobs/0004`` must produce exactly these columns, defaults
#and index -- ``test_lease_migration.py`` compares the two and fails on
#drift in either direction. Change one, change the other.
LEASE_TABLE_DDL = f"""
CREATE TABLE IF NOT EXISTS {LEASE_TABLE} (
    job_id bigint PRIMARY KEY,
    token uuid NOT NULL,
    worker_name varchar(255) NOT NULL DEFAULT '',
    pod varchar(255) NOT NULL DEFAULT '',
    task_name varchar(255) NOT NULL,
    queue varchar(255) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_beat_at timestamp with time zone NOT NULL,
    deadline_at timestamp with time zone NULL,
    attempt integer NOT NULL DEFAULT 0,
    phase varchar(24) NOT NULL DEFAULT 'unknown',
    phase_token uuid NULL,
    phase_attempt integer NULL
);
CREATE INDEX IF NOT EXISTS {LEASE_TABLE}_last_beat_at_idx
    ON {LEASE_TABLE} (last_beat_at);
"""

#Acquisition, and the freshness rule. The row is written only if the
#JOB ROW says this attempt is the current one -- ``status = 'doing'``
#and ``attempts`` equal to what this attempt fetched (every
#``retry_job`` and ``finish_job`` increments it) -- and an existing
#lease row is taken over only by an attempt at least as new as the one
#that holds it. The job row is the authority, because the lease row is
#temporary: a stale attempt resuming from a freeze after its job was
#requeued finds a replacement's lease (the conflict rule refuses it)
#OR no lease at all because the replacement already finished (the job
#row refuses it -- codex rounds 6 and 7 on the fix round). Either way
#0 rows = refused, and the caller runs nothing. ``FOR SHARE`` makes the
#read serialise with a concurrent requeue: a fallback reclaimer's
#uncommitted ``UPDATE... SET status = 'todo', attempts = attempts + 1``
#holds the row lock, this waits for it (bounded by ``lock_timeout``) and
#READ COMMITTED re-evaluates the WHERE against the committed row --
#refused. A plain SELECT would read its snapshot and lease a job that
#was already requeued (codex, round 8). Parameters are cast because in
#INSERT... SELECT the target column types do not reach them.
_INSERT_SQL = f"""
INSERT INTO {LEASE_TABLE}
    (job_id, token, worker_name, pod, task_name, queue,
     started_at, last_beat_at, deadline_at, attempt, phase,
     phase_token, phase_attempt)
SELECT %(job_id)s::bigint, %(token)s::uuid, %(worker_name)s::varchar,
       %(pod)s::varchar, %(task_name)s::varchar, %(queue)s::varchar,
       %(started_at)s::timestamptz, now(), %(deadline_at)s::timestamptz,
       %(attempt)s::integer, 'before_body', %(phase_token)s::uuid,
       %(phase_attempt)s::integer
FROM procrastinate_jobs
WHERE id = %(job_id)s AND status = 'doing' AND attempts = %(attempt)s
FOR SHARE
ON CONFLICT (job_id) DO UPDATE SET
    token = EXCLUDED.token,
    worker_name = EXCLUDED.worker_name,
    pod = EXCLUDED.pod,
    task_name = EXCLUDED.task_name,
    queue = EXCLUDED.queue,
    started_at = EXCLUDED.started_at,
    last_beat_at = now(),
    deadline_at = EXCLUDED.deadline_at,
    attempt = EXCLUDED.attempt,
    phase = CASE WHEN EXCLUDED.attempt > {LEASE_TABLE}.attempt
                 THEN EXCLUDED.phase ELSE {LEASE_TABLE}.phase END,
    phase_token = CASE
        WHEN EXCLUDED.attempt > {LEASE_TABLE}.attempt
          OR ({LEASE_TABLE}.phase = 'before_body'
              AND {LEASE_TABLE}.phase_token = {LEASE_TABLE}.token
              AND {LEASE_TABLE}.phase_attempt = {LEASE_TABLE}.attempt
              AND EXCLUDED.attempt = {LEASE_TABLE}.attempt)
        THEN EXCLUDED.phase_token ELSE {LEASE_TABLE}.phase_token END,
    phase_attempt = CASE
        WHEN EXCLUDED.attempt > {LEASE_TABLE}.attempt
          OR ({LEASE_TABLE}.phase = 'before_body'
              AND {LEASE_TABLE}.phase_token = {LEASE_TABLE}.token
              AND {LEASE_TABLE}.phase_attempt = {LEASE_TABLE}.attempt
              AND EXCLUDED.attempt = {LEASE_TABLE}.attempt)
        THEN EXCLUDED.phase_attempt ELSE {LEASE_TABLE}.phase_attempt END
WHERE EXCLUDED.attempt >= {LEASE_TABLE}.attempt
"""

#Acquisition is not permission to execute the task. The durable phase
#transition is a second attempt/token-fenced handshake, and middleware only
#calls user code after receiving its committed result. A lost response leaves
#the row conservative (`body_started`) while the process still fails closed.
_BODY_STARTED_SQL = f"""
WITH current_job AS (
    SELECT id FROM procrastinate_jobs
    WHERE id=%(job_id)s AND status='doing'
      AND attempts=%(attempt)s::integer
    FOR SHARE
)
UPDATE {LEASE_TABLE} AS lease SET phase='body_started'
FROM current_job
WHERE lease.job_id=%(job_id)s AND lease.token=%(token)s::uuid
  AND lease.attempt=%(attempt)s::integer AND lease.phase='before_body'
  AND lease.phase_token=lease.token
  AND lease.phase_token=%(token)s::uuid
  AND lease.phase_attempt=lease.attempt
  AND lease.phase_attempt=%(attempt)s::integer
  AND current_job.id=lease.job_id
RETURNING lease.job_id
"""

#The beat is a compare-and-swap on ``(job_id, token)``: a row the
#reclaimer deleted (or replaced with another worker's token) is not
#returned, and NOT being returned is the fence.
_BEAT_SQL = f"""
UPDATE {LEASE_TABLE} SET last_beat_at = now()
WHERE (job_id, token) IN (
    SELECT * FROM unnest(%(job_ids)s::bigint[], %(tokens)s::uuid[])
)
RETURNING job_id, token
"""

#Same compare-and-swap on exit: 0 rows means the lease was taken away.
_DELETE_SQL = f"""
DELETE FROM {LEASE_TABLE} WHERE job_id = %(job_id)s AND token = %(token)s
"""

#After an UNVERIFIED exit or acquisition: put our row back only if
#nobody has one AND the job row still says this attempt is current.
#``DO NOTHING`` so a replacement's lease -- or our own, if the statement
#whose outcome we lost did land -- is never overwritten. Nobody beats
#the row it creates: that is the point (see "the exit DELETE is
#different").
_REINSERT_IF_ABSENT_SQL = f"""
INSERT INTO {LEASE_TABLE}
    (job_id, token, worker_name, pod, task_name, queue,
     started_at, last_beat_at, deadline_at, attempt, phase,
     phase_token, phase_attempt)
SELECT %(job_id)s::bigint, %(token)s::uuid, %(worker_name)s::varchar,
       %(pod)s::varchar, %(task_name)s::varchar, %(queue)s::varchar,
       %(started_at)s::timestamptz, now(), %(deadline_at)s::timestamptz,
       %(attempt)s::integer, %(phase)s::varchar, %(token)s::uuid,
       %(attempt)s::integer
FROM procrastinate_jobs
WHERE id = %(job_id)s AND status = 'doing' AND attempts = %(attempt)s
ON CONFLICT (job_id) DO NOTHING
"""

_PROBE_SQL = 'SELECT to_regclass(%(table)s) IS NOT NULL'

#The two structured events ``monitoring/log-metrics/`` counts. Each has a
#proof-of-life fixture under ``monitoring/measurements/log-entries/`` that
#names the constant, so a reword here without one there is a red
#``governance`` job rather than a metric that is applied and un-fireable.
FENCED_EVENT = 'procrastinate_lease_fenced'
BEAT_FAILED_EVENT = 'procrastinate_lease_beat_failed'

# A stuck lease thread cannot recover by queuing more work behind a statement
# whose connection cut failed. Any active batch that remains unfinished beyond
# its deadline plus outcome margin is evidence of a stall, including beats and
# releases with no acquisition running. Queued handoff timeouts alone do not
# establish that: an earlier batch may still be making valid progress. Restart
# requests are bounded to once until an acquisition later succeeds. Reclaimer eligibility still requires a stale/missing worker
# heartbeat.
_acquire_stall_lock = threading.Lock()
_acquire_stall_restart_sent = False


class LeaseLost(Exception):
    """
    Raised by the middleware, after the task body returns or raises, when
    this run's lease was fenced while it ran. The run can never be
    recorded ``succeeded`` -- and, because the job now belongs to whoever
    fenced it, this worker writes NO status for it at all (see the
    module docstring, "the fence is a handover").
    """


class LeaseHandoffTimeout(Exception):
    """The beat thread did not START a lease statement in time. The
    statement was cancelled before it could start, so it never runs."""


class LeaseOutcomeUnknown(Exception):
    """
    The beat thread STARTED a lease statement and it was still running
    past its batch's client-side deadline plus ``OUTCOME_MARGIN_SECONDS``
    -- the watchdog's cut did not unblock it. It may still land later;
    the caller must treat its outcome as unknown, not as absent.
    """


# ---------------------------------------------------------------------------
# settings, read per call so a test override and an env var both take effect
# ---------------------------------------------------------------------------

def beat_seconds() -> float:
    return float(getattr(settings, 'JOB_LEASE_BEAT_SECONDS', 15))


def table_recheck_seconds() -> float:
    return float(getattr(settings, 'JOB_LEASE_TABLE_RECHECK_SECONDS', 60))


def statement_timeout_seconds() -> float:
    return float(getattr(settings, 'JOB_LEASE_STATEMENT_TIMEOUT_SECONDS', 5))


def handoff_timeout_seconds() -> float:
    """How long a middleware waits for the thread to START its statement."""
    return statement_timeout_seconds() + 2.0


def _request_worker_restart() -> None:
    """Ask the worker process supervisor to restart this wedged process."""
    os.kill(os.getpid(), signal.SIGTERM)


def _record_acquire_outcome(exc: BaseException | None, *, beater=None) -> None:
    """Restart on an unknown acquire or a handoff queued behind a wedged batch."""
    global _acquire_stall_restart_sent
    beater = _beater if beater is None else beater
    restart = False
    with _acquire_stall_lock:
        unknown_outcome = isinstance(exc, LeaseOutcomeUnknown)
        queued_behind_stall = (
            isinstance(exc, LeaseHandoffTimeout)
            and beater.active_batch_is_stalled())
        if unknown_outcome or queued_behind_stall:
            if not _acquire_stall_restart_sent:
                _acquire_stall_restart_sent = True
                restart = True
        elif exc is None:
            # A completed acquisition proves the thread progressed again and
            # allows a later independent stall to request one restart.
            _acquire_stall_restart_sent = False
    if restart:
        emit_json_line(
            logger,
            {'event': 'procrastinate_lease_batch_stall_restart'},
            'ERROR',
            'procrastinate lease thread remained blocked beyond its active '
            'batch deadline; sending SIGTERM so the worker supervisor '
            'restarts this process',
        )
        _request_worker_restart()


#SECONDS past a batch's client-side deadline that a waiter stays with a
#statement the thread had already started: the watchdog cuts the
#connection AT the deadline and psycopg raises in the blocked thread
#within milliseconds, so this is slack for the raise to propagate. A
#statement still un-answered after it is ``LeaseOutcomeUnknown``.
OUTCOME_MARGIN_SECONDS = 2.0


#SECONDS a Cloud SQL failover or maintenance restart is budgeted to keep
#the database unreachable. HA failover is documented at "typically under
#60s"; planned maintenance has been observed up to 90s. A lease cannot be
#beaten -- and procrastinate's own heartbeat cannot be written -- for that
#long, and neither silence may be read as death (see the module docstring,
#"the silence threshold is a number").
CLOUD_SQL_FAILOVER_BUDGET_SECONDS = 90.0


def stale_seconds() -> float:
    """
    The silence threshold the reclaimer  must apply to
    ``last_beat_at``. Read from settings so the two sides cannot drift;
    the registry test pins it above a failover plus one missed beat and
    one hand-off.
    """
    return float(getattr(settings, 'JOB_LEASE_STALE_SECONDS', 180))


def enabled() -> bool:
    """
    Leases are on when ``JOB_LEASE_ENABLED`` is true AND a reclaimer
    that reads them exists (``reclaim.READS_LEASES``, set by ) --
    or ``JOB_LEASE_WITHOUT_RECLAIMER`` says to run without one. See the
    module docstring, "before the reclaimer reads leases".
    """
    if not getattr(settings, 'JOB_LEASE_ENABLED', True):
        return False
    if getattr(settings, 'JOB_LEASE_WITHOUT_RECLAIMER', False):
        return True
    if reclaimer_reads_leases():
        return True
    _warn_reclaimer_not_lease_aware()
    return False


def reclaimer_reads_leases() -> bool:
    """Does the deployed reclaimer fence and requeue by lease silence?"""
    from dj.apps.jobs import reclaim

    return bool(getattr(reclaim, 'READS_LEASES', False))


_gate_warned = threading.Event()


def _warn_reclaimer_not_lease_aware() -> None:
    if _gate_warned.is_set():
        return
    _gate_warned.set()
    emit_json_line(
        logger,
        {
            'event': 'procrastinate_lease_disabled',
            'reason': 'reclaimer_not_lease_aware',
        },
        'WARNING',
        'procrastinate leases disabled: dj.apps.jobs.reclaim does not '
        'read leases yet (#1689); jobs run unleased until it does, or '
        'until JOB_LEASE_WITHOUT_RECLAIMER=true',
    )


def _pod() -> str:
    return (os.environ.get('HOSTNAME') or socket.gethostname() or '')[:255]


# ---------------------------------------------------------------------------
# the lease held by one running attempt, and the per-process beat thread
# ---------------------------------------------------------------------------

@dataclass(eq=False)
class Lease:
    """One running attempt's lease, as this process knows it. Identity,
    not value: two attempts of one job are two distinct leases."""

    job_id: int
    token: uuid.UUID
    task_name: str
    queue: str
    #The procrastinate ``Worker`` running the job; the fence sets its
    #abort flag for the job so ``context.should_abort()`` goes True.
    worker: Any
    #For an async task: the loop and ``asyncio.Task`` running it, so the
    #fence can cancel it thread-safely. ``None`` for a sync task.
    loop: asyncio.AbstractEventLoop | None = None
    async_task: asyncio.Task | None = None
    #Set when the lease was fenced -- by a beat, or by the exit DELETE.
    lost: threading.Event = field(default_factory=threading.Event)
    #How many beats this lease has had. Tests read it.
    beats: int = 0
    #The INSERT's parameters, kept so an unverified exit can put the row
    #back (``_REINSERT_IF_ABSENT_SQL``) exactly as it was.
    values: dict[str, Any] | None = None


class _Op:
    """One statement handed to the beat thread, and its outcome."""

    __slots__ = ('fn', 'done', 'result', 'exc', 'cancelled', 'started',
                 'batch_deadline', 'outlived_handoff', 'submitted_at',
                 'cleanup', 'attempts', 'not_before')

    def __init__(self, fn: Callable[[Any], Any],
                 cleanup: dict[str, Any] | None = None) -> None:
        self.fn = fn
        self.done = threading.Event()
        self.result: Any = None
        self.exc: BaseException | None = None
        #Set by a waiter that gave up BEFORE the thread started this;
        #the thread then skips it. Read and written only under
        #``_Beater._lock``, together with ``started``.
        self.cancelled = False
        #Set by the thread, under the lock, the moment it commits to
        #running ``fn``. A started op is waited for, never cancelled.
        self.started = False
        #``time.monotonic()`` at which the batch running this op is cut
        #by its watchdog; set with ``started``. A waiter stays with a
        #started op until then plus ``OUTCOME_MARGIN_SECONDS``.
        self.batch_deadline: float | None = None
        #The waiter outlived its hand-off deadline and stayed: the
        #statement was merely slow. Callers log it.
        self.outlived_handoff = False
        self.submitted_at = time.monotonic()
        #For a fire-and-forget cleanup nobody waits on: what it was for,
        #so its failure is logged rather than lost with the op.
        self.cleanup = cleanup
        #How many times this cleanup has been tried (retries re-queue a
        #fresh op carrying the count).
        self.attempts = 0
        #``time.monotonic()`` before which the thread must not run this.
        #A retry is due one beat after its failure, so the retry budget
        #is ELAPSED TIME, not a count of wake-ups: every unrelated
        #INSERT/DELETE wakes the thread, and a busy worker would
        #otherwise burn twelve attempts in a fraction of a second
        #(codex, round 5 on the fix round).
        self.not_before = 0.0


class _Beater:
    """
    The one lease thread per worker process.

    Everything that talks to ``jobs_joblease`` goes through here: the
    middleware's INSERT and DELETE are queued as ``_Op``s and the thread
    runs them, together with the periodic beat, on ONE connection per
    wake-up that is closed when the batch is done. Holds no connection
    between wake-ups.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        #Keyed by token: two attempts of one job in one process (a
        #fenced run still finishing while the replacement starts on
        #another slot) are two leases, and releasing one must not
        #unregister the other.
        self._leases: dict[uuid.UUID, Lease] = {}
        #Job ids whose ``_job_ids_to_abort`` flag OUR fence set, so a
        #replacement attempt of the same job starting in this process
        #can clear it -- procrastinate's abort flag is job-scoped, and
        #the replacement is not the run that was fenced.
        self.flagged_job_ids: set[int] = set()
        self._ops: collections.deque[_Op] = collections.deque()
        self._thread: threading.Thread | None = None
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._params: dict[str, Any] | None = None
        self._active_batch_deadline: float | None = None

    def active_batch_is_stalled(self) -> bool:
        """Has the current SQL batch outlived its watchdog and grace period?"""
        with self._lock:
            deadline = self._active_batch_deadline
        return (deadline is not None
                and time.monotonic() > deadline + OUTCOME_MARGIN_SECONDS)

    # -- registry ----------------------------------------------------------

    def register(self, lease: Lease) -> None:
        with self._lock:
            self._leases[lease.token] = lease
            if lease.job_id in self.flagged_job_ids:
                # A fenced earlier attempt of this job set the job-scoped
                # abort flag; this attempt holds the valid lease and must
                # not inherit it. Cleared INSIDE the lock, in the same
                # critical section that registers this attempt, so it is
                # atomic with ``_request_abort``'s check-and-set: either
                # the fence sees this attempt and sets nothing, or it set
                # the flag before and this clears it. Nothing in between.
                self.flagged_job_ids.discard(lease.job_id)
                abort_flags = getattr(lease.worker, '_job_ids_to_abort', None)
                if isinstance(abort_flags, dict):
                    abort_flags.pop(lease.job_id, None)

    def other_attempt_held(self, lease: Lease) -> bool:
        """Is another attempt of the same job leased in this process?"""
        with self._lock:
            return self._other_attempt_held_locked(lease)

    def _other_attempt_held_locked(self, lease: Lease) -> bool:
        return any(
            other.job_id == lease.job_id and other is not lease
            for other in self._leases.values())

    def unregister(self, lease: Lease) -> None:
        with self._lock:
            if self._leases.get(lease.token) is lease:
                del self._leases[lease.token]

    def still_held(self, lease: Lease) -> bool:
        with self._lock:
            return self._leases.get(lease.token) is lease

    def snapshot(self) -> list[Lease]:
        with self._lock:
            return list(self._leases.values())

    # -- hand-off ----------------------------------------------------------

    def submit(self, fn: Callable[[Any], Any],
               params: dict[str, Any]) -> _Op:
        """Queue ``fn(conn)`` for the thread; ``wait`` for its outcome."""
        op = _Op(fn)
        with self._lock:
            self._params = params
            self._ops.append(op)
            self._ensure_thread_locked()
        self._wake.set()
        return op

    def wait(self, op: _Op, timeout: float) -> Any:
        """
        Wait for a submitted op and return its result, or raise what it
        raised.

        If the thread has not STARTED it within ``timeout`` the op is
        cancelled -- under the lock, so the thread cannot start it a
        moment later -- and ``LeaseHandoffTimeout`` is raised: the
        statement never runs. If the thread HAS started it, the op is
        waited for until its batch's client-side deadline plus
        ``OUTCOME_MARGIN_SECONDS`` (``op.outlived_handoff`` is set so the
        caller can log a slow statement); a statement still un-answered
        after that raises ``LeaseOutcomeUnknown``, and the caller must
        treat it as possibly landing later. A started statement is never
        abandoned while an outcome is still coming: the decision it feeds
        (``release``: fence or not) must not be taken without it.
        """
        if not op.done.wait(timeout):
            with self._lock:
                started = op.started
                if not started:
                    op.cancelled = True
                batch_deadline = op.batch_deadline
            if not started:
                if not op.done.is_set():
                    raise LeaseHandoffTimeout(
                        f'lease thread did not start the statement within '
                        f'{timeout:.1f}s')
            else:
                op.outlived_handoff = True
                if batch_deadline is None:
                    batch_deadline = (time.monotonic()
                                      + batch_deadline_seconds(1))
                remaining = (batch_deadline + OUTCOME_MARGIN_SECONDS
                             - time.monotonic())
                if not op.done.wait(max(0.0, remaining)):
                    raise LeaseOutcomeUnknown(
                        f'lease statement was started but still not '
                        f'answered {time.monotonic() - op.submitted_at:.1f}s '
                        f'after it was handed to the thread (its batch '
                        f'deadline passed and the cut did not unblock it); '
                        f'it may still land')
        if op.exc is not None:
            raise op.exc
        return op.result

    def run(self, fn: Callable[[Any], Any], params: dict[str, Any],
            timeout: float) -> Any:
        """``submit`` then ``wait``."""
        return self.wait(self.submit(fn, params), timeout)

    def run_later(self, fn: Callable[[Any], Any], params: dict[str, Any],
                  cleanup: dict[str, Any] | None = None) -> None:
        """
        Queue ``fn(conn)`` for the thread and do not wait for it. With
        ``cleanup`` (what the statement is for), a failure -- the batch
        never connecting, or ``fn`` raising -- is logged as
        ``procrastinate_lease_cleanup_failed`` instead of vanishing.
        """
        with self._lock:
            self._params = params
            self._ops.append(_Op(fn, cleanup=cleanup))
            self._ensure_thread_locked()
        self._wake.set()

    def _ensure_thread_locked(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run, name=THREAD_NAME, daemon=True)
            self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Stop the thread and forget every lease. Tests only."""
        with self._lock:
            thread = self._thread
            self._leases.clear()
            self.flagged_job_ids.clear()
            pending = list(self._ops)
            self._ops.clear()
        for op in pending:
            op.exc = LeaseHandoffTimeout('lease thread stopped')
            op.done.set()
        self._stop.set()
        self._wake.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout)
        with self._lock:
            self._thread = None
        self._stop.clear()
        self._wake.clear()

    # -- the loop ------------------------------------------------------------

    def _run(self) -> None:
        next_beat_at = time.monotonic() + beat_seconds()
        wake_at = next_beat_at
        while not self._stop.is_set():
            self._wake.wait(max(0.0, wake_at - time.monotonic()))
            self._wake.clear()
            if self._stop.is_set():
                return
            now = time.monotonic()
            with self._lock:
                # Due ops run now; a retry that is not due yet stays
                # queued (in order) and sets the next wake-up.
                ops = [op for op in self._ops
                       if not op.cancelled and op.not_before <= now]
                pending = [op for op in self._ops
                           if not op.cancelled and op.not_before > now]
                self._ops.clear()
                self._ops.extend(pending)
                params = self._params
            wake_at = min([next_beat_at] + [op.not_before for op in pending])
            beat_due = now >= next_beat_at
            if beat_due:
                next_beat_at = time.monotonic() + beat_seconds()
                wake_at = min([next_beat_at]
                              + [op.not_before for op in pending])
            leases = ([lease for lease in self.snapshot()
                       if not lease.lost.is_set()] if beat_due else [])
            if not ops and not leases:
                continue
            batch_finished = threading.Event()
            restart_watchdog = None
            try:
                with _connect(params, APPLICATION_NAME) as conn:
                    # The client-side deadline for this batch: a server
                    # that never answers (a stalled sql-proxy keeps the
                    # TCP session alive, so neither statement_timeout
                    # nor the transport bounds fire) would otherwise
                    # hold the one thread -- and every lease in the
                    # process -- for good. Closing the connection from
                    # another thread makes the blocked execute() raise.
                    budget = batch_deadline_seconds(len(ops))
                    batch_deadline = time.monotonic() + budget
                    with self._lock:
                        self._active_batch_deadline = batch_deadline
                    watchdog = threading.Timer(
                        budget, _cut_batch, args=(conn, ops, leases))
                    watchdog.daemon = True
                    watchdog.start()
                    # A failed connection cut can wedge a beat or release,
                    # leaving every subsequent acquisition queued. Observe
                    # batch completion independently of those acquisitions.
                    restart_watchdog = threading.Timer(
                        budget + OUTCOME_MARGIN_SECONDS,
                        _restart_unfinished_batch, args=(batch_finished,))
                    restart_watchdog.daemon = True
                    restart_watchdog.start()
                    try:
                        for op in ops:
                            self._run_op(conn, op, batch_deadline)
                        if leases:
                            # Re-snapshot: an op above may have released
                            # one.
                            leases = [lease for lease in self.snapshot()
                                      if not lease.lost.is_set()]
                            if leases:
                                self.beat(conn, leases)
                    finally:
                        watchdog.cancel()
                        with self._lock:
                            self._active_batch_deadline = None
            except Exception as exc:  # noqa: BLE001 -- the thread must live
                # Connecting failed, or the beat did. A beat that could
                # not run is NOT a fence: only a statement that ran and
                # did not return the row is. Ops that never ran are
                # failed back to their waiters below.
                for op in ops:
                    if not op.done.is_set():
                        op.exc = exc
                        op.done.set()
                        if op.cleanup is not None:
                            self._retry_or_drop_cleanup(op, exc)
                if leases:
                    emit_json_line(
                        logger,
                        {
                            'event': BEAT_FAILED_EVENT,
                            'error': repr(exc),
                            'pod': _pod(),
                            'job_ids': [lease.job_id for lease in leases],
                        },
                        'WARNING',
                        f'procrastinate lease beat failed: {exc!r}',
                    )
            finally:
                batch_finished.set()
                if restart_watchdog is not None:
                    restart_watchdog.cancel()

    def _run_op(self, conn, op: _Op,
                batch_deadline: float | None = None) -> None:
        with self._lock:
            # The cancel/start decision is one critical section: a waiter
            # that gives up sees either "not started" (and cancels, so
            # this returns) or "started" (and stays for the outcome).
            if op.cancelled:
                op.done.set()
                return
            op.started = True
            op.batch_deadline = batch_deadline
        try:
            op.result = op.fn(conn)
        except Exception as exc:  # noqa: BLE001 -- handed back to the waiter
            op.exc = exc
            if op.cleanup is not None:
                self._retry_or_drop_cleanup(op, exc)
        finally:
            op.done.set()

    def _retry_or_drop_cleanup(self, op: _Op, exc: BaseException) -> None:
        """
        A cleanup failed. It is idempotent and the outage that made it
        necessary is probably still going on, so re-queue it for the next
        tick -- up to ``CLEANUP_ATTEMPTS`` -- and only then log it as
        failed and drop it (codex, round 4 on the fix round: a recovery
        that dies on the outage it exists for is not a recovery).
        """
        attempt = op.attempts + 1
        if attempt < CLEANUP_ATTEMPTS:
            emit_json_line(
                logger,
                {
                    'event': 'procrastinate_lease_cleanup_retry',
                    **(op.cleanup or {}),
                    'attempt': attempt,
                    'error': repr(exc),
                },
                'WARNING',
                f'procrastinate lease cleanup '
                f'({(op.cleanup or {}).get("reason", "?")}, job='
                f'{(op.cleanup or {}).get("job_id", "?")}) failed on '
                f'attempt {attempt} of {CLEANUP_ATTEMPTS}: {exc!r}; '
                'retrying next tick',
            )
            retry = _Op(op.fn, cleanup=op.cleanup)
            retry.attempts = attempt
            retry.not_before = time.monotonic() + beat_seconds()
            with self._lock:
                self._ops.append(retry)
            return
        op.attempts = attempt
        _cleanup_failed(op, exc)

    def beat(self, conn, leases: list[Lease]) -> set[int]:
        """
        Beat ``leases`` in one statement on ``conn``; fence the ones the
        UPDATE did not return and that are STILL HELD. Returns the fenced
        job ids. Called by the thread, and directly by tests.
        """
        rows = conn.execute(
            _BEAT_SQL,
            {
                'job_ids': [lease.job_id for lease in leases],
                'tokens': [lease.token for lease in leases],
            },
        ).fetchall()
        alive = {(row[0], row[1]) for row in rows}
        fenced: set[int] = set()
        for lease in leases:
            if (lease.job_id, lease.token) in alive:
                lease.beats += 1
            elif not self.still_held(lease):
                # Released normally between the snapshot and the UPDATE
                # (the task finished and deleted its own row while this
                # thread was busy). Not a fence: fencing it would cancel
                # a job that is already in its own cleanup and hand
                # procrastinate a bare CancelledError to record.
                continue
            else:
                fenced.add(lease.job_id)
                _fence(lease, detected='beat')
        return fenced


_beater = _Beater()


def batch_deadline_seconds(n_ops: int) -> float:
    """
    How long one batch on the beat thread may take before its connection
    is cut from outside: one hand-off, plus every statement in the batch
    (``n_ops`` plus the beat) at ``statement_timeout``, plus a margin.
    Generous on purpose, and ALWAYS longer than a hand-off: a statement
    that outlives its waiter must still be allowed to land -- that is
    the ordinary slow-server case ``release`` and ``acquire`` handle --
    and the server's own timeout fires first whenever the server can
    answer at all. This is only for the server that cannot.
    """
    return (handoff_timeout_seconds()
            + statement_timeout_seconds() * (n_ops + 1) + 2.0)


def _restart_unfinished_batch(finished: threading.Event) -> None:
    if not finished.is_set():
        _record_acquire_outcome(LeaseOutcomeUnknown(
            'lease batch remained blocked after its connection cut'))


def _cut_batch(conn, ops: list[_Op], leases: list[Lease]) -> None:
    """The batch deadline: close the connection under the stuck batch."""
    emit_json_line(
        logger,
        {
            'event': 'procrastinate_lease_batch_deadline',
            'pod': _pod(),
            'ops': len(ops),
            'job_ids': [lease.job_id for lease in leases],
        },
        'ERROR',
        f'procrastinate lease batch exceeded its client-side deadline '
        f'({len(ops)} ops, {len(leases)} leases): the server stopped '
        'answering; closing the connection so the beat thread lives',
    )
    try:
        conn.close()
    except Exception:  # noqa: BLE001 -- already closing is fine
        pass


def _cleanup_failed(op: _Op, exc: BaseException) -> None:
    """A fire-and-forget cleanup did not run; say so, with what it was."""
    emit_json_line(
        logger,
        {
            'event': 'procrastinate_lease_cleanup_failed',
            **(op.cleanup or {}),
            'attempts': op.attempts,
            'error': repr(exc),
        },
        'ERROR',
        f'procrastinate lease cleanup failed '
        f'({(op.cleanup or {}).get("reason", "?")}, job='
        f'{(op.cleanup or {}).get("job_id", "?")}) after {op.attempts} '
        f'attempts: {exc!r} -- the job may be a doing row with no lease, '
        'or a row nobody beats, until a human looks',
    )


def _fence(lease: Lease, *, detected: str, reason: str | None = None) -> None:
    """
    The lease is gone: ask the task to stop, and remember that this run
    must write nothing. The abort flag is what ``context.should_abort()``
    reads (``procrastinate/worker.py:421``); it is exactly what
    ``Worker._abort_job`` sets for a user-requested abort, and
    ``_persist_job_status`` pops it when the run is recorded.
    """
    if lease.lost.is_set():
        return
    lease.lost.set()
    emit_json_line(
        logger,
        {
            'event': FENCED_EVENT,
            'job_id': lease.job_id,
            'task': lease.task_name,
            'queue': lease.queue,
            'pod': _pod(),
            'detected': detected,
            **({'reason': reason} if reason else {}),
        },
        'ERROR',
        f'procrastinate lease fenced ({detected}'
        f'{", " + reason if reason else ""}): job={lease.job_id} '
        f'task={lease.task_name} -- this run records no status',
    )
    if detected == 'beat':
        _request_abort(lease)


def _request_abort(lease: Lease) -> None:
    """
    Ask the fenced run to stop. procrastinate's abort flag is keyed by
    JOB id (``worker.py:100``), not by attempt, so it is set only when
    no other attempt of the same job is leased in this process -- the
    replacement holds the valid lease and ``context.should_abort()``
    must stay False for it. (The residual: procrastinate offers no
    per-attempt abort handle, so a cooperative sync task that was fenced
    while its replacement runs on the other slot is asked to stop only
    through ``LeaseLost`` after it returns.) Cancelling the asyncio
    task IS per attempt and is always done.
    """
    from procrastinate import job_context

    abort_flags = getattr(lease.worker, '_job_ids_to_abort', None)
    if isinstance(abort_flags, dict):
        # One critical section for "is another attempt leased here", the
        # flag write and the marker that lets a replacement clear it.
        # Split, a replacement registering between the check and the
        # write sees no marker, clears nothing, and inherits the fence
        # (fresh reviewer, round 2). An operator's own abort, already
        # present, is left alone and NOT marked as ours.
        with _beater._lock:
            if (not _beater._other_attempt_held_locked(lease)
                    and lease.job_id not in abort_flags):
                abort_flags[lease.job_id] = (
                    job_context.AbortReason.USER_REQUEST)
                _beater.flagged_job_ids.add(lease.job_id)
    if lease.loop is not None and lease.async_task is not None:
        try:
            lease.loop.call_soon_threadsafe(lease.async_task.cancel)
        except RuntimeError:
            # The loop is already closed: the job is over anyway.
            pass


# ---------------------------------------------------------------------------
# connections and the table probe
# ---------------------------------------------------------------------------

class _LeaseConnection(psycopg.Connection):
    """Each lease operation owns its deadlines in one short transaction.

    Startup timeout options are rejected by transaction-mode PgBouncer; a
    session SET would leak into an unrelated client's next transaction.
    Return the buffered cursor only after commit, preserving the existing
    response-loss ambiguity and conservative lease recovery semantics.
    """

    def execute(self, query, params=None, *, prepare=None, binary=False):
        millis = max(1, int(statement_timeout_seconds() * 1000))
        with self.transaction():
            super().execute(f"SET LOCAL statement_timeout = '{millis}ms'")
            super().execute(f"SET LOCAL lock_timeout = '{millis}ms'")
            return super().execute(query, params, prepare=prepare, binary=binary)


def _connect(params: dict[str, Any], application_name: str):
    """One short-lived psycopg connection; each execute commits independently."""
    return _LeaseConnection.connect(
        **params, application_name=application_name, autocommit=True,
    )


def _connection_params() -> dict[str, Any] | None:
    """
    psycopg kwargs for the worker's database, read from Django's settings
    in the CALLING thread (this is the only place the module looks at
    ``django.db.connections``, and it only reads the settings dict --
    ``get_connection_params`` opens nothing).
    """
    from django.db import connections
    from procrastinate.contrib.django import settings as proc_settings

    alias = proc_settings.settings.DATABASE_ALIAS
    wrapper = connections[alias]
    if wrapper.vendor != 'postgresql':
        return None
    params = dict(wrapper.get_connection_params())
    params.pop('cursor_factory', None)
    params.pop('context', None)
    # statement_timeout is enforced by the SERVER: a socket that has gone
    # black (a Cloud SQL failover mid-statement, a dropped NAT mapping)
    # never delivers the error, and the one beat thread would sit in
    # execute() until the kernel gave up on the TCP connection -- every
    # lease in the process un-beaten, every exit unverified, and the
    # beat-failure line never emitted because the handler is never
    # reached. So the transport is bounded too: libpq keepalives detect a
    # dead peer within idle + interval * count, and tcp_user_timeout caps
    # how long unacknowledged data may sit in flight. Both are ignored by
    # libpq where the platform lacks them; the worker runs on Linux.
    # setdefault: an operator's DATABASES OPTIONS win.
    for key, value in transport_bounds().items():
        params.setdefault(key, value)
    return params


def transport_bounds() -> dict[str, int]:
    """
    libpq keepalive / TCP timeout parameters for the lease connection.
    Sized to the statement timeout: a peer that has said nothing for
    ``keepalives_idle + keepalives_interval * keepalives_count`` seconds
    (11 at the defaults), or unacknowledged data older than
    ``tcp_user_timeout`` (2 x statement_timeout), fails the statement in
    the beat thread's exception handler instead of wedging it.
    """
    millis = max(1, int(statement_timeout_seconds() * 1000))
    return {
        'keepalives': 1,
        'keepalives_idle': 5,
        'keepalives_interval': 2,
        'keepalives_count': 3,
        'tcp_user_timeout': 2 * millis,
    }


class _TableProbe:
    """
    Remembers whether ``jobs_joblease`` exists. A positive answer is
    permanent; a negative one is re-checked after
    ``JOB_LEASE_TABLE_RECHECK_SECONDS`` so a worker that outlives the
    migration picks the table up without a restart -- and, until then,
    costs no connection at all.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.available: bool | None = None
        self.checked_at: float = 0.0
        self.warned = False

    def reset(self) -> None:
        with self._lock:
            self.available = None
            self.checked_at = 0.0
            self.warned = False

    def known_missing(self) -> bool:
        with self._lock:
            return (self.available is False and
                    time.monotonic() - self.checked_at
                    < table_recheck_seconds())

    def check(self, conn) -> bool:
        with self._lock:
            if self.available:
                return True
            now = time.monotonic()
            if (self.available is False
                    and now - self.checked_at < table_recheck_seconds()):
                return False
            row = conn.execute(_PROBE_SQL, {'table': LEASE_TABLE}).fetchone()
            self.available = bool(row and row[0])
            self.checked_at = now
            if not self.available and not self.warned:
                self.warned = True
                emit_json_line(
                    logger,
                    {
                        'event': 'procrastinate_lease_disabled',
                        'reason': 'table_missing',
                        'table': LEASE_TABLE,
                    },
                    'WARNING',
                    f'procrastinate leases disabled: {LEASE_TABLE} does '
                    'not exist yet (its migration has not been applied); '
                    'jobs run unleased',
                )
            return self.available


_table = _TableProbe()


def reset_for_tests() -> None:
    """Forget the table probe and the gate warning; stop the beat thread."""
    global _acquire_stall_restart_sent
    _beater.stop()
    _table.reset()
    _gate_warned.clear()
    with _acquire_stall_lock:
        _acquire_stall_restart_sent = False


# ---------------------------------------------------------------------------
# acquire / release
# ---------------------------------------------------------------------------

def _deadline(task_name: str, started_at: datetime) -> datetime | None:
    from dj.apps.jobs import reclaim_policy

    policy = reclaim_policy.policy_for(task_name)
    if policy is None or policy.hard_deadline_seconds is None:
        return None
    return started_at + timedelta(seconds=int(policy.hard_deadline_seconds))


def _lease_of(context: Any) -> Lease | None:
    extra = getattr(context, 'additional_context', None)
    if isinstance(extra, dict):
        lease = extra.get(LEASE_CONTEXT_KEY)
        if isinstance(lease, Lease):
            return lease
    return None


def acquire(
    context: Any,
    worker: Any,
    *,
    loop: asyncio.AbstractEventLoop | None = None,
    async_task: asyncio.Task | None = None,
) -> Lease | None:
    """
    Insert the lease for ``context.job`` and start beating it. Returns
    ``None`` -- and the job runs unleased -- only when leases are
    disabled, the database is not Postgres, or the table does not exist
    yet. Returns a lease that is already ``lost`` (the caller must run
    nothing) when the INSERT was REFUSED -- a newer attempt owns the job
    (``detected=acquire reason=stale``) -- or when it could not be
    VERIFIED: it failed, timed out, or its outcome is unknown
    (``reason=unverified``); in that case a lease is left behind to go
    silent so the reclaimer requeues the job. Never raises.
    """
    job = context.job
    if job.id is None or not enabled():
        return None
    if _table.known_missing():
        return None
    params = _connection_params()
    if params is None:
        return None
    started_at = datetime.fromtimestamp(context.start_timestamp, tz=dt_timezone.utc)
    lease = Lease(
        job_id=job.id,
        token=uuid.uuid4(),
        task_name=job.task_name,
        queue=job.queue,
        worker=worker,
        loop=loop,
        async_task=async_task,
    )
    lease.values = {
        'job_id': lease.job_id,
        'token': lease.token,
        'worker_name': (context.worker_name or '')[:255],
        'pod': _pod(),
        'task_name': lease.task_name[:255],
        'queue': lease.queue[:255],
        'started_at': started_at,
        'deadline_at': _deadline(lease.task_name, started_at),
        'attempt': int(getattr(job, 'attempts', 0) or 0),
        'phase': 'before_body',
        'phase_token': lease.token,
        'phase_attempt': int(getattr(job, 'attempts', 0) or 0),
    }

    def insert(conn) -> int | None:
        """``None``: no table. ``1``: leased. ``0``: refused -- the job
        is no longer this attempt's, or a newer attempt holds the row."""
        if not _table.check(conn):
            return None
        return conn.execute(_INSERT_SQL, lease.values).rowcount

    try:
        op = _beater.submit(insert, params)
        inserted = _beater.wait(op, handoff_timeout_seconds())
    except Exception as exc:  # noqa: BLE001 -- fail closed, never raise
        _record_acquire_outcome(exc)
        # Ownership could not be VERIFIED: the INSERT failed, was never
        # started, or its outcome is unknown. That is not permission to
        # run -- a stale attempt whose INSERT errored would otherwise
        # execute and persist over its replacement (codex, round 8). The
        # run is fenced before it starts and writes nothing; and because
        # the INSERT may have committed (autocommit, response lost) or
        # may still land, a job-row-checked DO-NOTHING re-INSERT is
        # queued behind it so that -- if this attempt IS the current one
        # -- a row nobody beats exists for the reclaimer to find silent.
        emit_json_line(
            logger,
            {
                'event': 'procrastinate_lease_insert_failed',
                'job_id': job.id,
                'task': job.task_name,
                'error': repr(exc),
            },
            'ERROR',
            f'procrastinate lease insert failed for job={job.id} '
            f'task={job.task_name}: {exc!r} -- ownership unverified; this '
            'run is fenced before it starts and a lease is left to go silent',
        )
        _install_fence_aware_persist(worker)
        _attach(context, lease)
        _fence(lease, detected='acquire', reason='unverified')
        _leave_a_lease_to_go_silent(
            lease, params, reason='acquire_unverified',
            extra={'insert_error': repr(exc)})
        return lease
    _record_acquire_outcome(None)
    if inserted is None:
        return None
    if op.outlived_handoff:
        _statement_slow(op, 'insert', lease)
    _install_fence_aware_persist(worker)
    _attach(context, lease)
    if not inserted:
        # This attempt is stale: the job row is no longer `doing` at
        # this attempt number (it froze after fetching, the fallback
        # requeued it, and a replacement ran -- or is running and holds
        # a newer lease). It is fenced before it runs anything, and it
        # writes nothing; the middleware raises LeaseLost instead of
        # calling the body.
        _fence(lease, detected='acquire', reason='stale')
        return lease
    _beater.register(lease)
    return lease


def _begin_body(lease: Lease) -> bool:
    """Durably fence replay before entering task code.

    The acquisition INSERT itself committed ``before_body``. This compare and
    swap advances only the same still-current lease and queue attempt. A
    response loss may leave ``body_started`` committed even though this worker
    never reaches user code; that false positive is deliberate because it can
    never authorize replay of a body that might have started.
    """
    params = _beater._params or _connection_params()
    if params is None or lease.values is None:
        return False

    def mark(conn) -> int:
        if not _table.check(conn):
            return 0
        return conn.execute(_BODY_STARTED_SQL, lease.values).rowcount

    try:
        op = _beater.submit(mark, params)
        marked = _beater.wait(op, handoff_timeout_seconds())
    except Exception as exc:  # noqa: BLE001 -- fail closed before task body
        _record_acquire_outcome(exc)
        emit_json_line(
            logger,
            {
                'event': 'procrastinate_lease_body_start_unverified',
                'job_id': lease.job_id,
                'task': lease.task_name,
                'error': repr(exc),
            },
            'ERROR',
            f'procrastinate lease body-start evidence was not verified for '
            f'job={lease.job_id} task={lease.task_name}: {exc!r} -- '
            'task body is fenced',
        )
        _fence(lease, detected='acquire', reason='body_start_unverified')
        _beater.unregister(lease)
        return False
    _record_acquire_outcome(None)
    if marked != 1:
        _fence(lease, detected='acquire', reason='body_start_stale')
        _beater.unregister(lease)
        return False
    lease.values['phase'] = 'body_started'
    return True


def _attach(context: Any, lease: Lease) -> None:
    """Put THIS attempt's lease on its own ``JobContext``."""
    extra = getattr(context, 'additional_context', None)
    if isinstance(extra, dict):
        extra[LEASE_CONTEXT_KEY] = lease


_PERSIST_INSTALLED = '_jobs_lease_persist_installed'


def _install_fence_aware_persist(worker: Any) -> None:
    """
    Make THIS worker skip ``_persist_job_status`` for a run whose lease
    was fenced (see "the fence is a handover" above). Installed once per
    ``Worker`` instance, on the first lease it acquires; idempotent.

    ``Worker._persist_job_status`` is procrastinate's private seam
    (``worker.py:165-190``, called by keyword from ``_process_job`` with
    the job's own ``context``); the registry test pins its existence so
    an upstream rename is a red test, not a zombie that silently writes
    again. The lease is read off ``context.additional_context``, so it is
    this attempt's and not another attempt of the same job.
    """
    if worker is None:
        return
    # Sync middleware runs concurrently on procrastinate's executor. Serialize
    # the check/capture/install trio with lease registration so every attempt
    # sees the same wrapper. The wrapper takes this lock only after the
    # installer has released it, so persistence cannot recurse into the lock.
    with _beater._lock:
        if getattr(worker, _PERSIST_INSTALLED, False):
            return
        original = getattr(worker, '_persist_job_status', None)
        if original is None:
            return

        async def persist_unless_fenced(**kwargs: Any) -> None:
            lease = _lease_of(kwargs.get('context'))
            if lease is not None and lease.lost.is_set():
                # Pop the abort flag only if OUR fence set it (the marker says
                # so): an operator's abort that was already there is theirs,
                # and a replacement of this job in this process must still
                # see it (fresh reviewer, round 2). Either way the marker is
                # discarded, or a fence whose replacement lands on another
                # pod leaves the id in the set for the life of the process.
                with _beater._lock:
                    ours = lease.job_id in _beater.flagged_job_ids
                    _beater.flagged_job_ids.discard(lease.job_id)
                    if ours:
                        abort_flags = getattr(worker, '_job_ids_to_abort', None)
                        if isinstance(abort_flags, dict):
                            abort_flags.pop(lease.job_id, None)
                status = kwargs.get('status')
                emit_json_line(
                    logger,
                    {
                        'event': 'procrastinate_lease_persist_skipped',
                        'job_id': lease.job_id,
                        'task': lease.task_name,
                        'would_have_written': getattr(status, 'value', status),
                        'would_have_retried': kwargs.get('retry_decision')
                        is not None,
                    },
                    'ERROR',
                    f'procrastinate lease: job={lease.job_id} was fenced; not '
                    f'writing {getattr(status, "value", status)} over the '
                    'attempt that replaced this run',
                )
                return None
            try:
                return await original(**kwargs)
            except Exception as exc:
                # The status write comes AFTER the ownership check, and it
                # runs on procrastinate's own connection: a write that raises
                # here leaves a `doing` row with no lease on a worker that is
                # alive and heartbeating -- which neither reclaimer path
                # reaches (codex, round 9). So the recovery evidence is put
                # back: a job-row-checked, unbeaten lease, retried through
                # the outage, for the reclaimer to find silent. The body's
                # side effects stand and the replacement runs the body again
                # -- the documented trade-off, and strictly better than a
                # row nobody ever finds.
                if lease is not None and lease.values is not None:
                    params = _beater._params or _connection_params()
                    emit_json_line(
                        logger,
                        {
                            'event': 'procrastinate_lease_persist_failed',
                            'job_id': lease.job_id,
                            'task': lease.task_name,
                            'would_have_written': getattr(
                                kwargs.get('status'), 'value',
                                kwargs.get('status')),
                            'error': repr(exc),
                        },
                        'ERROR',
                        f'procrastinate lease: the status write for '
                        f'job={lease.job_id} raised after its lease was '
                        f'released: {exc!r} -- leaving a lease behind for the '
                        'reclaimer to find silent',
                    )
                    if params is not None:
                        _leave_a_lease_to_go_silent(
                            lease, params, reason='persist_failed',
                            extra={'error': repr(exc)})
                raise

        setattr(worker, '_persist_job_status', persist_unless_fenced)
        setattr(worker, _PERSIST_INSTALLED, True)


#How many times the exit DELETE is attempted before the run gives up
#on proving ownership and fails closed.
RELEASE_ATTEMPTS = 2

#How many ticks a fire-and-forget cleanup (the token-scoped DELETE after
#an uncertain INSERT, the DO-NOTHING re-INSERT after an unverified exit)
#is attempted before it is logged as failed and dropped. Twelve beats at
#the production 15s is 180s: longer than a Cloud SQL failover, which is
#the outage that makes these cleanups necessary in the first place. The
#registry test pins the inequality.
CLEANUP_ATTEMPTS = 12


def release(lease: Lease) -> bool:
    """
    Stop beating and DELETE the lease by ``(job_id, token)``. Returns
    ``True`` only if the DELETE ran and removed OUR row -- ownership
    proven, the run may persist its status. ``False`` if the lease was
    already fenced, if the DELETE ran and found nothing (the exit-time
    fence), or if it could not run ``RELEASE_ATTEMPTS`` times (ownership
    unverified: the run writes nothing, and a lease row is left behind
    to go silent -- ``_leave_a_lease_to_go_silent``). A DELETE the
    thread has started is waited for until its batch deadline, so the
    decision is not taken while our own DELETE is in flight. Never
    raises.
    """
    _beater.unregister(lease)
    if lease.lost.is_set():
        # A beat already fenced it: the row is gone or is someone else's.
        return False
    params = _beater._params or _connection_params()
    if params is None:
        return True

    def delete(conn) -> int:
        return conn.execute(
            _DELETE_SQL, {'job_id': lease.job_id, 'token': lease.token},
        ).rowcount

    deleted = None
    attempts: list[_Op] = []
    for attempt in range(1, RELEASE_ATTEMPTS + 1):
        op = _beater.submit(delete, params)
        attempts.append(op)
        try:
            deleted = _beater.wait(op, handoff_timeout_seconds())
            if op.outlived_handoff:
                _statement_slow(op, 'delete', lease, attempt=attempt)
            break
        except Exception as exc:  # noqa: BLE001
            emit_json_line(
                logger,
                {
                    'event': 'procrastinate_lease_delete_failed',
                    'job_id': lease.job_id,
                    'task': lease.task_name,
                    'attempt': attempt,
                    'error': repr(exc),
                },
                'ERROR',
                f'procrastinate lease delete failed for job={lease.job_id} '
                f'(attempt {attempt} of {RELEASE_ATTEMPTS}): {exc!r}',
            )
    if not deleted:
        # "Nothing removed" is a fence ONLY if nobody here removed it. A
        # hand-off that timed out does not stop a DELETE the thread was
        # already executing; the ops ran in order on the one thread, so
        # an earlier attempt that landed late has finished by now and its
        # rowcount says whether OUR row was there when it ran.
        landed_late = [
            index for index, op in enumerate(attempts, start=1)
            if _removed_a_row(op)]
        if landed_late:
            emit_json_line(
                logger,
                {
                    'event': 'procrastinate_lease_delete_landed_late',
                    'job_id': lease.job_id,
                    'task': lease.task_name,
                    'attempt': landed_late[0],
                },
                'WARNING',
                f'procrastinate lease delete for job={lease.job_id} landed '
                f'after its hand-off deadline (attempt {landed_late[0]}); '
                'ownership proven, not a fence',
            )
            return True
    # "Nothing removed" is a fence only if no earlier attempt could have
    # removed it. A DELETE the thread STARTED and that then raised is not
    # "did not run": under autocommit it may have committed and lost its
    # response (the INSERT twin of this is handled in ``acquire``), and
    # the retry behind it then finds nothing -- our doing, not a fence.
    # That outcome is uncertain, and uncertain fails closed WITH a lease
    # left behind, so the reclaimer finds the job rather than a live
    # worker's heartbeat hiding it (codex, round 3 on the fix round).
    uncertain = [
        index for index, op in enumerate(attempts, start=1)
        if op.started and op.exc is not None]
    if deleted == 0 and uncertain:
        emit_json_line(
            logger,
            {
                'event': 'procrastinate_lease_delete_outcome_uncertain',
                'job_id': lease.job_id,
                'task': lease.task_name,
                'attempts': uncertain,
            },
            'WARNING',
            f'procrastinate lease delete for job={lease.job_id}: attempt '
            f'{uncertain[0]} ran and raised, and the retry removed nothing '
            '-- it may have been ours; ownership unverified, not a fence',
        )
    if deleted is None or (deleted == 0 and uncertain):
        _fence(lease, detected='unverified')
        _leave_a_lease_to_go_silent(lease, params)
        return False
    if deleted == 0:
        _fence(lease, detected='exit')
        return False
    return True


def _removed_a_row(op: _Op) -> bool:
    """Did this (possibly late) DELETE run, succeed, and remove our row?"""
    return (op.done.is_set() and op.exc is None
            and isinstance(op.result, int) and op.result >= 1)


def _leave_a_lease_to_go_silent(
    lease: Lease, params: dict[str, Any], *,
    reason: str = 'unverified_exit',
    extra: dict[str, Any] | None = None,
) -> None:
    """
    After an UNVERIFIED exit or acquisition, queue -- behind the
    statements that may still land -- a token-scoped re-INSERT that
    creates our row only if no row exists and the job row still says
    this attempt is current. Nobody beats it, so the reclaimer finds it
    silent and requeues through the leased path, instead of a ``doing``
    row with no lease on a live worker that the heartbeat fallback never
    reaches (see the module docstring, "the exit DELETE is different").
    Retried through an outage (``_retry_or_drop_cleanup``).
    """
    values = lease.values
    if values is None:
        return

    def reinsert_if_absent(conn) -> int:
        if not _table.check(conn):
            return 0
        # The reclaimer must distinguish this deliberately abandoned attempt
        # from an ordinary stale lease. Persist that evidence in the existing
        # quarantine table in the SAME transaction as the lease. A lease that
        # was replaced, or a job whose attempt changed, cannot acquire this
        # marker. Acquisition failure is known to be pre-body; exit/status
        # persistence failures happen after the body returned and remain
        # subject to the task's normal retry policy.
        with conn.transaction():
            inserted = conn.execute(
                _REINSERT_IF_ABSENT_SQL, values).rowcount
            phase = (
                'before_body' if reason == 'acquire_unverified'
                else 'after_body')
            conn.execute(
                "INSERT INTO jobs_quarantined_job "
                "(job_id, task_name, queue, reason, attempts, "
                "quarantined_at, requeued_at) "
                "SELECT l.job_id, l.task_name, l.queue, %s, l.attempt, "
                "now(), NULL FROM jobs_joblease l "
                "JOIN procrastinate_jobs j ON j.id=l.job_id "
                "WHERE l.job_id=%s AND l.token=%s::uuid "
                "AND l.attempt=%s AND j.status='doing' "
                "AND j.attempts=%s "
                "ON CONFLICT (job_id) DO UPDATE SET "
                "task_name=EXCLUDED.task_name, queue=EXCLUDED.queue, "
                "reason=EXCLUDED.reason, attempts=EXCLUDED.attempts, "
                "quarantined_at=EXCLUDED.quarantined_at, requeued_at=NULL "
                "WHERE jobs_quarantined_job.requeued_at IS NOT NULL "
                "OR jobs_quarantined_job.attempts < EXCLUDED.attempts "
                "OR jobs_quarantined_job.reason LIKE "
                "'recovery abandoned attempt %%'",
                (f'recovery abandoned attempt {phase}:{values["token"]}',
                 values['job_id'], values['token'], values['attempt'],
                 values['attempt']),
            )
            return inserted

    _beater.run_later(
        reinsert_if_absent, params,
        cleanup={
            'reason': reason,
            'job_id': lease.job_id,
            'task': lease.task_name,
            **(extra or {}),
        },
    )


def _statement_slow(op: _Op, statement: str, lease: Lease, *,
                    attempt: int | None = None) -> None:
    """A lease statement outlived its hand-off deadline and still landed."""
    waited = round(time.monotonic() - op.submitted_at, 1)
    emit_json_line(
        logger,
        {
            'event': 'procrastinate_lease_statement_slow',
            'statement': statement,
            'job_id': lease.job_id,
            'task': lease.task_name,
            'attempt': attempt,
            'waited_seconds': waited,
            'handoff_seconds': handoff_timeout_seconds(),
        },
        'WARNING',
        f'procrastinate lease {statement} for job={lease.job_id} outlived '
        f'its hand-off deadline ({handoff_timeout_seconds():.1f}s) and '
        f'landed after {waited:.1f}s; waited for, not abandoned',
    )


# ---------------------------------------------------------------------------
# the middlewares -- one per task kind; procrastinate picks by kind
# ---------------------------------------------------------------------------

def _lease_lost(lease: Lease) -> LeaseLost:
    return LeaseLost(
        f'lease for job {lease.job_id} ({lease.task_name}) was fenced '
        'while it ran; the job belongs to whoever fenced it now, so '
        'this run records no status'
    )


def queue_is_paused(queue: str) -> bool:
    """Read the operator pause row without touching the job tables."""
    from dj.apps.jobs.models import QueueControl
    return QueueControl.objects.filter(queue=queue, paused_at__isnull=False).exists()


def _operator_abort_requested(context) -> bool:
    """True only for an operator abort, never for a worker shutdown.

    ``JobContext.should_abort()`` is ``bool(abort_reason())`` in procrastinate
    3.9, so it cannot tell the two apart; the reason has to be read from
    ``abort_reason()`` itself.
    """
    from procrastinate import job_context

    reason = getattr(context, 'abort_reason', None)
    return callable(reason) and reason() is job_context.AbortReason.USER_REQUEST


def _reject_paused_queue(context) -> None:
    # Procrastinate 3.9 routes JobRetry through the task retry strategy; tasks
    # with retry=False fail, and retrying tasks burn an attempt. Wait at this
    # fetch/middleware boundary instead. The fetch gate normally leaves paused
    # jobs todo; this wait only closes the race where pause commits after the
    # fetch snapshot but before middleware starts.
    import time

    while queue_is_paused(context.job.queue):
        # A rolling worker shutdown must leave retry=False work pending at
        # this boundary. Only a deliberate operator abort authorizes turning
        # the fetched-but-not-started job into an aborted terminal state.
        if _operator_abort_requested(context):
            raise exceptions.JobAborted('operator abort while queue paused')
        time.sleep(1)


def queue_pause_middleware(call_next, context, worker):
    """Do not enter user code for work fetched from a paused lane."""
    _reject_paused_queue(context)
    return call_next()


async def queue_pause_middleware_async(call_next, context, worker):
    """Async counterpart; paused fetch races wait without retry attempts."""
    import asyncio

    while await sync_to_async(queue_is_paused)(context.job.queue):
        if _operator_abort_requested(context):
            raise exceptions.JobAborted('operator abort while queue paused')
        await asyncio.sleep(1)
    return await call_next()


def install_queue_fetch_gate(manager) -> None:
    """Keep paused and parked queues out of public JobManager.fetch_job calls.

    A pause racing a fetch is closed by queue_pause_middleware after fetch.
    Neither path transitions job status or consumes a retry attempt.
    """
    original = manager.fetch_job
    if getattr(original, '_f2z_queue_fetch_gate', False):
        return

    async def fetch_job(*, queues, worker_id):
        from asgiref.sync import sync_to_async
        from dj.apps.jobs.models import QueueControl
        if queues is None:
            available = await sync_to_async(manager.list_queues)()
            candidate_queues = [row['name'] for row in available]
        else:
            candidate_queues = list(queues)
        candidate_queues = [queue for queue in candidate_queues
                            if not queue.startswith('paused.')]
        paused = await sync_to_async(list)(QueueControl.objects.filter(
            paused_at__isnull=False).values_list('queue', flat=True))
        candidate_queues = [queue for queue in candidate_queues
                            if queue not in paused]
        if not candidate_queues:
            return None
        job = await original(queues=candidate_queues, worker_id=worker_id)
        # The Django psycopg adapter on the private local Postgres test stack
        # can return JSONB as its wire string. Procrastinate's Job.call_string
        # and worker invocation both require the decoded mapping.
        if job is not None and isinstance(job.task_kwargs, str):
            import json
            from attrs import evolve
            job = evolve(job, task_kwargs=json.loads(job.task_kwargs))
        return job

    fetch_job._f2z_queue_fetch_gate = True
    manager.fetch_job = fetch_job


def lease_middleware(call_next, context, worker):
    """
    Sync task middleware. Runs in the worker's ``sync_to_async`` pool
    thread, inside ``close_db_connections`` (procrastinate's own Django
    cleanup, which the contrib puts outermost). The lease is released --
    the exit-time ownership check -- BEFORE the outcome is decided, so a
    fence found by that DELETE still turns the outcome into ``LeaseLost``.
    """
    lease = acquire(context, worker)
    if lease is None:
        return call_next()
    if lease.lost.is_set():
        raise _lease_lost(lease)            # a newer attempt owns the job
    if not _begin_body(lease):
        raise _lease_lost(lease)
    try:
        result = call_next()
    except BaseException as exc:
        release(lease)
        if lease.lost.is_set():
            raise _lease_lost(lease) from exc
        raise
    release(lease)
    if lease.lost.is_set():
        raise _lease_lost(lease)
    return result


async def lease_middleware_async(call_next, context, worker):
    """
    Async task middleware. Runs on the worker loop inside the job's own
    ``asyncio.Task`` (``worker.py:296-305`` awaits the composed chain
    in-line), so ``asyncio.current_task()`` IS the task a fence cancels.
    The hand-offs to the lease thread go through a pool thread so the
    loop -- which is also running procrastinate's heartbeat -- never
    blocks on them, and the release is shielded so a second
    cancellation cannot orphan the row.
    """
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    # Acquisition is awaited THROUGH cancellation, like the release: a
    # shutdown that lands during the INSERT must not let procrastinate
    # persist `aborted` while the row is still being written, nor leave
    # the row for a late cleanup to delete from under a replacement.
    lease, cancelled = await _await_uncancellable(
        asyncio.to_thread(acquire, context, worker, loop=loop, async_task=task)
    )
    if cancelled:
        if lease is not None:
            await _release_uncancellable(lease)
        raise asyncio.CancelledError()
    if lease is None:
        return await call_next()
    if lease.lost.is_set():
        raise _lease_lost(lease)            # a newer attempt owns the job
    began, cancelled = await _await_uncancellable(
        asyncio.to_thread(_begin_body, lease))
    if cancelled:
        await _release_uncancellable(lease)
        raise asyncio.CancelledError()
    if not began:
        raise _lease_lost(lease)
    try:
        result = await call_next()
    except BaseException as exc:
        await _release_uncancellable(lease)
        if lease.lost.is_set():
            raise _lease_lost(lease) from exc
        raise
    await _release_uncancellable(lease)
    if lease.lost.is_set():
        raise _lease_lost(lease)
    return result


async def _await_uncancellable(aw) -> tuple[Any, bool]:
    """
    Await ``aw`` to completion even through cancellation; return its
    result and whether a cancellation arrived meanwhile (the caller
    re-raises it once it has done its own cleanup).
    """
    future = asyncio.ensure_future(aw)
    cancelled = False
    while not future.done():
        try:
            await asyncio.shield(future)
        except asyncio.CancelledError:
            cancelled = True
    return future.result(), cancelled


async def _release_uncancellable(lease: Lease) -> None:
    """
    Run ``release`` in a thread and WAIT for it, even through
    cancellation. A bare ``shield`` would let a shutdown's
    ``CancelledError`` reach procrastinate while the ownership check is
    still running, and procrastinate would persist ``aborted`` (or
    retry) before ``lease.lost`` could be set. So the cancellation is
    remembered and re-raised only once the release has finished.
    """
    _, cancelled = await _await_uncancellable(
        asyncio.to_thread(release, lease))
    if cancelled:
        raise asyncio.CancelledError()


#What ``settings.PROCRASTINATE_WORKER_DEFAULTS["task_middleware"]`` must
#contain, in this order. procrastinate kind-filters them per task
#(``worker.py:242-259``), so every task gets exactly one.
LEASE_MIDDLEWARE = [lease_middleware, lease_middleware_async]
QUEUE_PAUSE_MIDDLEWARE = [queue_pause_middleware,
                          queue_pause_middleware_async]
