# Free2Z worker recovery contract

The Free2Z [lease middleware](../../../py/free2z/dj/apps/jobs/lease.py),
[reclaimer](../../../py/free2z/dj/apps/jobs/reclaim.py),
[task policy](../../../py/free2z/dj/apps/jobs/reclaim_policy.py), and
[health collector](../../../py/free2z/dj/apps/jobs/health.py) share this contract.
All durations are seconds. Defaults are source defaults, not evidence of a
particular deployment or supervisor configuration.

## Healing latency

The earlier roughly one-minute healing goal is not the runtime contract.
The nominal sweep cadence is one minute; eligibility normally takes longer.
For a reclaimable ordinary attempt, let `S` be its latest `started` event,
`B` its last lease beat, and `H` its worker's last heartbeat. Eligibility
requires all applicable gates:

| Gate | Earliest eligibility with current defaults |
| --- | --- |
| Ordinary task age | `S + max(120, task runtime + 300)` |
| Existing lease silence | Strictly after `B + 180` |
| Existing worker heartbeat silence | After `H + 60` |
| Missing worker/heartbeat | Does not bypass the ordinary task-age gate |
| Missing lease | No lease-silence gate; still requires ordinary task age and a stale/missing worker heartbeat |
| Matching durable abandonment proof | `S + 120` and strictly after `B + 180`; bypasses ordinary runtime and worker silence |

The latest applicable gate wins. For example, translation's 900-second runtime
plus 300-second margin means an ordinary orphan cannot be replayed before
1,200 seconds from start, even if its worker row and lease are absent. A matching
pre-body lease on a live worker can instead become eligible after the 120-second
age floor and 180-second silence threshold. Neither heals in one minute.

Eligibility precedes execution of a successful sweep. Pending ticks coalesce;
queue backlog, overlapping sweeps, advisory locks, row-operation deadlines,
database outages and the sweep's 240-second time budget can defer recovery
further. A one-minute schedule does not establish a one-minute upper bound on
that delay. There is no unconditional wall-clock recovery guarantee.

The 180-second lease threshold outlives the budgeted database failover plus a
missed beat and handoff. Ordinary runtime guards include estimates rather than
universal hard deadlines. Shortening them to meet a latency target would risk
repeating provider requests while the original task is still alive.

## Missing signals and body-entry proof

A missing `worker_id` does not establish worker death: Procrastinate can prune
a live worker row and set the foreign key to NULL. An unleased attempt with a
live heartbeat can also be between its exit DELETE and status persistence, or
be a legacy task still running. Age alone cannot prove either body stopped.
Such an attempt stays protected even past its estimated runtime. Health keeps
it visible as over-budget work rather than reporting a recovery opportunity.
Both the initial candidate query and the final transactions on the Django and
production pool connectors preserve that protection, including worker revival
between observation and mutation.

Modern failed acquisitions fail closed before entering the body. Cleanup writes
a token/attempt-scoped silent lease and abandonment marker. A durable matching
`before_body` phase also proves that this attempt never received permission to
enter user code; the middleware commits and verifies `body_started` before
calling the body. Only this pre-body proof permits a bounded infrastructure
retry of an otherwise `NEVER` task. `body_started`, `unknown`, mismatched proof,
or `after_body` evidence never permits replay of a `NEVER` body. Unknown tasks
and operator-excluded queues remain excluded.

A failed status write restores a silent lease with abandonment evidence for
eligible tasks. If cleanup cannot commit, it is retried and ultimately logged;
there is no claim that a missing lease becomes proof. A confirmed thread stall
also initiates the process exit below, so it cannot leave future acquisitions
stranded behind an indefinitely live worker heartbeat.

Ordinary tasks may be replayed after the conservative gates pass. This is not
exactly-once external execution: fencing cannot undo a billed request or stop
a synchronous call already sent. Task-specific idempotency and money guards
remain necessary. Hard deadlines use a separate abort-request sweep followed
by a fenced failure sweep; estimated runtime alone does not authorize aborting
live work.

## A lease thread that does not recover

A queued handoff timeout cancels the operation under the beater lock before it
starts. Any number of these timeouts alone is insufficient reason to kill the
process: another batch can still be progressing normally. A started operation
is awaited through its batch deadline plus the outcome margin. If the connection
cut fails to unblock that batch, the result is unknown and ownership fails
closed. An independent watchdog also covers stalls in beat or release batches
when no acquisition is waiting.

The confirmed-stall threshold is **one overdue active batch**, rather than an
unsafe count of queued timeouts. A successful acquisition resets the existing
stall-request latch for a future independent stall. Once shutdown is requested,
that shutdown is irreversible: later progress cannot extend or cancel its bound.
The process sends itself SIGTERM, giving cooperating unrelated bodies up to
30 seconds to drain. A daemon timer armed before SIGTERM calls `os._exit(75)`
after that grace period, even if cancellation, a signal handler or interpreter
cleanup is stuck. Repeated requests neither re-signal nor extend the grace.
The hard exit can interrupt remaining bodies; their replay policies still apply,
particularly `NEVER`. It enables an external supervisor to restart the process;
it does not configure or assert that such a supervisor exists.

The finite exit guarantee assumes the interpreter can schedule the timer thread.
A frozen OS process or a native extension holding the GIL indefinitely still
requires an external liveness mechanism.

## Verification boundary

The focused tests use a disposable PostgreSQL database and controlled persisted
start, beat and worker timestamps. They check the floor, runtime-plus-margin,
and lease-silence boundaries without waiting for production-length intervals.
They also cover both transaction connectors, lease/worker revival, body-entry
fencing, and the health clocks. A deterministic competing-hook installation
test pauses method capture while another thread attempts installation, then
invokes fenced and live persistence to catch nested-lock deadlocks.

A child process blocks a real PostgreSQL statement with the connection-cut seam
made ineffective. Cases that ignore SIGTERM or suppress async cancellation
require the finite exit; another drains during the grace period. Only the child
may receive the signal or hard exit. These children use custom signal handlers,
not Procrastinate's actual shutdown handler. They establish process behavior and
database decisions, not deployed supervisor behavior, acceptance of the real
Procrastinate shutdown handler, or end-to-end production healing latency.
