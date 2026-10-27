"""A structured, alertable signal for procrastinate's own `TaskNotFound`
.

No DB needed: this module only attaches a `logging.Handler` and reacts to
the `extra` fields Python's `logging` module already sets on a `LogRecord`
-- exactly what `Worker._process_job` passes when it hits `TaskNotFound`
(`action="task_not_found"`, `job={...}` from `JobContext.job.log_context()`,
`worker={...}`). Fed directly rather than run against a real procrastinate
worker, because the thing under test is the re-emission, not procrastinate's
own dispatch -- that half is `dj.apps.jobs.unknown_task`'s job before it was
reverted (see 's PR history) and 's job now.
"""
from __future__ import annotations

import json
import logging

import pytest

from dj.apps.jobs import task_not_found_alert

TARGET_LOGGER = "procrastinate.worker"
OWN_LOGGER = "dj.apps.jobs.task_not_found_alert"


@pytest.fixture(autouse=True)
def clean_handlers():
    """`install()` is meant to be idempotent process-wide, but a test that
    leaves its own handler attached would make every OTHER test's
    `caplog` see it too. Remove anything this module attached, before and
    after each test.
    """
    def _strip():
        target = logging.getLogger(TARGET_LOGGER)
        target.handlers = [
            h for h in target.handlers
            if not getattr(h, task_not_found_alert._INSTALLED_MARKER, False)
        ]
    _strip()
    yield
    _strip()


def _make_record(**extra) -> logging.LogRecord:
    record = logging.LogRecord(
        name=TARGET_LOGGER, level=logging.ERROR, pathname=__file__,
        lineno=1, msg="Task was not found: boom", args=(), exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_install_attaches_exactly_one_handler():
    target = logging.getLogger(TARGET_LOGGER)
    before = len(target.handlers)
    task_not_found_alert.install()
    assert len(target.handlers) == before + 1
    task_not_found_alert.install()
    assert len(target.handlers) == before + 1, "a second install must not duplicate"


def test_a_task_not_found_record_is_reemitted_structured(caplog):
    caplog.set_level("INFO", logger=OWN_LOGGER)
    handler = task_not_found_alert._TaskNotFoundHandler()
    record = _make_record(
        action="task_not_found",
        job={"id": 618421, "task_name": "jobs.a_brand_new_task", "queue": "images"},
        worker={"name": "image-variant-worker", "job_id": 618421},
    )

    handler.emit(record)

    lines = [r for r in caplog.records if r.name == OWN_LOGGER]
    assert len(lines) == 1
    payload = json.loads(lines[0].getMessage())
    assert payload["event"] == task_not_found_alert.EVENT
    assert payload["task_name"] == "jobs.a_brand_new_task"
    assert payload["queue"] == "images"
    assert payload["job_id"] == 618421
    assert payload["worker_name"] == "image-variant-worker"


def test_NEGATIVE_CONTROL_a_record_without_the_action_is_not_reemitted(caplog):
    """Pins that the handler is selective, not a firehose on every
    procrastinate.worker log line -- without the `action` check this
    passes for the wrong reason (everything gets re-emitted).
    """
    caplog.set_level("INFO", logger=OWN_LOGGER)
    handler = task_not_found_alert._TaskNotFoundHandler()
    record = _make_record(action="start_job", job={"id": 1, "task_name": "x"})

    handler.emit(record)

    assert not [r for r in caplog.records if r.name == OWN_LOGGER]


def test_missing_job_or_worker_extras_do_not_raise(caplog):
    """`emit()` must degrade, never propagate: a malformed or missing
    `extra` on a future procrastinate version must not turn observability
    into a worker crash.
    """
    caplog.set_level("INFO", logger=OWN_LOGGER)
    handler = task_not_found_alert._TaskNotFoundHandler()
    record = _make_record(action="task_not_found")  # no job, no worker

    handler.emit(record)  # must not raise

    lines = [r for r in caplog.records if r.name == OWN_LOGGER]
    assert len(lines) == 1


def test_installed_handler_reacts_to_a_child_worker_logger(caplog):
    """`Worker.__init__` uses `logger.getChild(worker_name)` when a name is
    set (`procrastinate/worker.py`); a handler attached to the bare
    `procrastinate.worker` logger must still see it via propagation, or
    every NAMED worker -- which is all of them in production
    (`k8s/free2z/worker/*.yaml` sets `--name`) -- goes unwatched.
    """
    caplog.set_level("INFO", logger=OWN_LOGGER)
    task_not_found_alert.install()
    child = logging.getLogger(f"{TARGET_LOGGER}.image-variant-worker-abc123")

    child.error(
        "Task was not found: boom",
        extra={
            "action": "task_not_found",
            "job": {"id": 1, "task_name": "jobs.new_task", "queue": "default"},
            "worker": {"name": "image-variant-worker-abc123"},
        },
    )

    lines = [r for r in caplog.records if r.name == OWN_LOGGER]
    assert len(lines) == 1
