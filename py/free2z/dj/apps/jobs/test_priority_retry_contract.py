"""Contracts for queue priority and the poster retry ladder."""
import ast
from datetime import datetime, timezone
import errno
from pathlib import Path

from procrastinate.jobs import Job
from procrastinate.contrib.django import app
import pytest
import requests
from google.api_core.exceptions import from_http_status

from dj.apps.jobs.priorities import (
    BACKFILL,
    BACKGROUND,
    DEFAULT,
    INTERACTIVE,
    MAINTENANCE,
    PRIORITY_LADDER,
    RECOVERY,
)
from dj.apps.jobs.retry import JitteredRetryStrategy
from dj.apps.uploads import tasks as upload_tasks
from dj.apps.uploads.video_utils import PosterRetryable


def test_priority_ladder_is_strict_and_interactive_outranks_maintenance():
    assert PRIORITY_LADDER == (
        INTERACTIVE, RECOVERY, DEFAULT, BACKGROUND, MAINTENANCE, BACKFILL,
    )
    assert all(a > b for a, b in zip(PRIORITY_LADDER, PRIORITY_LADDER[1:]))
    assert INTERACTIVE > MAINTENANCE
    assert app.tasks["g12f.publish_zpage"].priority == INTERACTIVE
    assert app.tasks["g12f.notify_published_zpage"].priority == INTERACTIVE
    assert app.tasks["uploads.generate_image_variants"].priority == INTERACTIVE
    assert app.tasks["exports.cleanup_expired_exports"].priority == RECOVERY
    assert (
        app.tasks["g12f.publish_zpage"].priority
        > app.tasks["exports.cleanup_expired_exports"].priority
    )


def _numeric_priority_arguments(source, filename="<source>"):
    tree = ast.parse(source, filename=filename)
    offending = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg != "priority":
                continue
            try:
                value = ast.literal_eval(keyword.value)
            except (ValueError, TypeError):
                continue
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                offending.append(node.lineno)
    return offending


def test_registered_task_and_configure_priorities_are_named():
    apps = Path(__file__).parent.parent
    offending = []
    for path in apps.rglob("*.py"):
        if "migrations" in path.parts:
            continue
        offending.extend(
            f"{path}:{line}"
            for line in _numeric_priority_arguments(path.read_text(), str(path))
        )
    assert not offending, "literal priority values: " + ", ".join(offending)


def test_priority_guard_rejects_a_literal_negative_control():
    source = "task.configure(" + "priority" + "=" + "5)"
    assert _numeric_priority_arguments(source) == [1]


def _job(attempts):
    return Job(
        id=42, queue="images", task_name="uploads.generate_video_poster",
        task_kwargs={"generic_file_id": 1}, lock=None, queueing_lock=None,
        attempts=attempts,
    )


def test_split_strategy_keeps_retrying_infrastructure_failure_at_attempt_3():
    decision = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=PosterRetryable("decoder unavailable"), job=_job(3),
    )
    assert decision is not None


def test_split_strategy_classifies_requests_transport_errors_as_infrastructure():
    decision = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=requests.exceptions.ConnectionError("storage unavailable"),
        job=_job(3),
    )
    assert decision is not None


def test_split_strategy_does_not_retry_http_response_errors_as_transport():
    decision = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=requests.exceptions.HTTPError("not a transport failure"),
        job=_job(3),
    )
    assert decision is None


@pytest.mark.parametrize("pressure_errno", [
    errno.EMFILE, errno.EAGAIN, errno.ENOSPC,
])
def test_split_strategy_retries_node_pressure_oserrors_at_attempt_3(
    pressure_errno,
):
    decision = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=OSError(pressure_errno, "node resource pressure"),
        job=_job(3),
    )
    assert decision is not None


def test_split_strategy_does_not_retry_nonpressure_oserror_at_attempt_3():
    decision = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=OSError(errno.EINVAL, "invalid local operation"),
        job=_job(3),
    )
    assert decision is None


def test_split_strategy_retries_gcs_retryable_status_but_not_forbidden():
    retryable = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=from_http_status(408, "request timeout"), job=_job(3),
    )
    forbidden = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=from_http_status(403, "forbidden"), job=_job(3),
    )
    assert retryable is not None
    assert forbidden is None


def test_split_strategy_stops_retrying_media_failure_at_attempt_3():
    decision = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=ValueError("invalid image"), job=_job(3),
    )
    assert decision is None


def test_split_strategy_stops_infrastructure_retries_after_eight_retries():
    decision = upload_tasks.VARIANT_RETRY.get_retry_decision(
        exception=PosterRetryable("decoder unavailable"), job=_job(8),
    )
    assert decision is None


def test_full_jitter_stays_within_the_attempt_7_cap_for_1000_draws():
    strategy = JitteredRetryStrategy(max_attempts=8, base=15, cap=300)
    for _ in range(1000):
        before = datetime.now(timezone.utc)
        decision = strategy.get_retry_decision(
            exception=RuntimeError("infra"), job=_job(7),
        )
        delay = (decision.retry_at - before).total_seconds()
        assert -0.01 <= delay <= 300.01
