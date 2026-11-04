"""A structured, alertable signal for procrastinate's own `TaskNotFound`
.

WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
-----------------------------------------------
During a rolling deploy, a worker still on the old image can fetch a job for
a task name it doesn't know -- `Worker._process_job` (`procrastinate/
worker.py`) has no `Task` object in that case, so there is no retry decision
to make, and the job fails on its very first attempt. An earlier version of
this fix (see the PR history on ) monkeypatched `app.tasks` to hand
such a job to a self-managed retry loop. Adversarial review found that
mechanism riskier than the problem it solved: it could record a job
`succeeded` when nothing ran (fooling `jobs/smoke.py`'s promotion gate, the
poster admission cap, and the health sweep), hide a task that was never
imported at all or was retired while future-scheduled rows still existed,
and mint a fresh job id that defeats `context.job.id`-based dedup on the one
task that relies on it (`g12f.notify_published_zpage`). `bazel-apply.sh`
also rolls every procrastinate worker lane before the web tier, so the
benefit was smaller than described: a job deferred by NEW code essentially
never meets an OLD worker; the remaining exposure is one worker lane handing
a NEW one-off task to another lane that has not rolled yet.

This module does none of that. It is alert-only: a human sees the rare loss
and re-defers the job by hand (`manage.py procrastinate defer <task>...`),
which is the honest, low-risk answer to a LOW-severity, mostly self-healing
rollout edge case. The convention note in this app's README ("a new task
ships one release before anything enqueues it") is the other half -- it
turns the common case (a NEW task, not a renamed/retired one) into something
that cannot happen at all, rather than something that is merely retried.

WHY THIS RE-EMITS RATHER THAN WATCHING PROCRASTINATE'S OWN LOG LINE DIRECTLY
-------------------------------------------------------------------------------
`Worker._process_job` logs `self.logger.exception(f"Task was not found: {e}",
extra={"action": "task_not_found",...})`. The obvious move is a log-based
metric filtering on that text. Two things rule it out:

* `py/gcp/tests/test_alert_policy_contract.py` requires every `textPayload`/
  `jsonPayload` literal a filter names to appear verbatim in this repo's own
  source under `py/` (or a declared cross-repo exemption for code that
  genuinely lives in another repository, like the Rust E2EE binaries).
  procrastinate is a pip dependency (`py/requirements/main.txt`), not
  vendored here, so "Task was not found" appears nowhere in `py/` and the
  contract test would refuse the filter outright.
* Even if it didn't: the default `LOGGING` config (`py/dj/free2z/settings.py`)
  gives the root logger a plain `StreamHandler` with no JSON formatter, so
  procrastinate's own `logger.exception(...)` line reaches Cloud Logging as
  unstructured `textPayload`, not `jsonPayload` -- `extra={"action":...}`
  never renders into the text a `%(message)s` formatter produces. A filter
  would have to match procrastinate's exact wording, which is upstream's to
  reword on any release with no compile error and no failing test on our
  side -- precisely the drift `test_alert_policy_contract.py` exists to
  catch for OUR OWN log lines, and a dependency's wording is outside what
  that test (or anything else here) can pin.

So `_TaskNotFoundHandler` reads the STRUCTURED `extra` fields Python's
`logging` module already attached to the `LogRecord` object -- `record.
action`, `record.job` (from `JobContext.job.log_context()`), `record.
worker` -- regardless of how the text renders, and re-emits ONE line through
`dj.apps.jobs.logs.emit_json_line`, the same structured-JSON path every
other procrastinate signal in this app uses. The literal
`monitoring/log-metrics/` watches (`procrastinate_task_not_found`) is
therefore OUR OWN string, live in `py/`, and exactly as honest a target as
every other log-based metric in this repo.
"""
from __future__ import annotations

import logging

from dj.apps.jobs.logs import emit_json_line

logger = logging.getLogger(__name__)

#`Worker._process_job`'s logger: `logging.getLogger(__name__)` in
#`procrastinate/worker.py`, optionally `.getChild(worker_name)` per
#instance. A handler attached HERE sees both, because a named worker's
#child logger propagates up to this exact node -- going all the way up to
#the bare `"procrastinate"` logger would also catch unrelated submodules
#(`procrastinate.periodic`, `procrastinate.manager`,...).
_TARGET_LOGGER_NAME = "procrastinate.worker"

#Guards against attaching a second handler if `configure()` (or a test)
#calls `install()` more than once in the same process.
_INSTALLED_MARKER = "_f2z_task_not_found_alert"


#Kept as a name every emitted line uses, and reused by both the metric
#filter (`monitoring/log-metrics/procrastinate-task-not-found.json`) and
#`py/gcp/tests/test_alert_policy_contract.py`'s
#`_emitted_payload_keys()`, which calls `_payload_for` directly so the
#label extractors it checks cannot drift from the real payload shape.
EVENT = "procrastinate_task_not_found"


def _payload_for(task_name, queue, job_id, worker_name) -> dict:
    """The exact structured payload `emit_json_line` is handed. Pulled out
    of `_TaskNotFoundHandler.emit` so the contract test can call it with
    synthetic values instead of asserting against a hand-copied field list.
    """
    return {
        "event": EVENT,
        "task_name": task_name,
        "queue": queue,
        "job_id": job_id,
        "worker_name": worker_name,
    }


class _TaskNotFoundHandler(logging.Handler):
    """Re-emits procrastinate's `action="task_not_found"` signal as a
    structured line, and touches nothing else -- no retry, no job row, no
    task registry. See the module docstring for why this exists as a
    re-emission rather than a filter on procrastinate's own log text.
    """

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(record, "action", None) != "task_not_found":
            return
        job = getattr(record, "job", None)
        job = job if isinstance(job, dict) else {}
        worker = getattr(record, "worker", None)
        worker = worker if isinstance(worker, dict) else {}
        task_name = job.get("task_name")
        job_id = job.get("id", worker.get("job_id"))
        try:
            payload = _payload_for(
                task_name, job.get("queue"), job_id, worker.get("name"))
            emit_json_line(
                logger,
                payload,
                "WARNING",
                f"procrastinate: a worker fetched a job for a task it does "
                f"not know ({task_name!r}, job {job_id!r}) -- likely a "
                "rolling deploy (see this app's README) or a task that was "
                "renamed/retired while a future-scheduled row still existed",
            )
        except Exception:  # noqa: BLE001 - observability must never break a worker
            logger.debug(
                "task_not_found re-emit failed", exc_info=True,
                extra={"event": "procrastinate_task_not_found_reemit_failed"},
            )


def install() -> None:
    """Attach the handler to procrastinate's worker logger, once per
    process. Safe to call from a non-worker process (web, a management
    command): the target logger only ever receives records from an actual
    `procrastinate.worker.Worker`, so the handler is inert everywhere else.
    """
    target = logging.getLogger(_TARGET_LOGGER_NAME)
    if any(getattr(existing, _INSTALLED_MARKER, False)
           for existing in target.handlers):
        return
    handler = _TaskNotFoundHandler()
    setattr(handler, _INSTALLED_MARKER, True)
    target.addHandler(handler)
