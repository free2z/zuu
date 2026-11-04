"""Ledger workers, activated with the dedicated pooled ledger lane.

The money task names shipped before L2. New partition maintenance runs only
on the new ledger queue, which old workers do not consume. Deployment must
verify pooling and roll this consumer before any new API/worker producers.
"""
from __future__ import annotations

from time import monotonic

from django.db import OperationalError, connection, transaction
from procrastinate.contrib.django import app

from dj.apps.jobs.priorities import MAINTENANCE

EXPIRE_HOLDS_TASK_NAME = "ledger.expire_holds"
AI_ROLLUP_TASK_NAME = "ledger.ai_rollup"
PARTITIONS_TASK_NAME = "ledger.maintain_partitions"

#: The L2 table whose absence means "not yet": the doc's own guard.
_L2_SENTINEL_TABLE = "public.ledger_hold"


def l2_tables_exist() -> bool:
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass(%s) IS NOT NULL", [_L2_SENTINEL_TABLE])
        return bool(cursor.fetchone()[0])


@app.periodic(cron="* * * * *")
@app.task(name=EXPIRE_HOLDS_TASK_NAME, queue="ledger", retry=False)
def expire_holds(timestamp: int | None = None) -> dict:
    """§11: ``expired_hold_ids(100)`` then ``expire_hold(id)`` each in
    autocommit until empty or the tick budget is exhausted."""
    if not l2_tables_exist():
        return {"status": "skipped", "reason": f"{_L2_SENTINEL_TABLE} does not exist yet (L2)"}
    from .rollup import contention_error, set_worker_timeouts

    deadline = monotonic() + 50
    expired, deferred = 0, 0
    attempted = []
    while monotonic() < deadline:
        with transaction.atomic(), connection.cursor() as cursor:
            set_worker_timeouts(cursor)
            # Skip contended rows already tried this tick, allowing later
            # accounts to progress even when the oldest hundred are locked.
            cursor.execute('SELECT id FROM ledger_hold WHERE expires_at<now() '
                           'AND NOT (id=ANY(%s::uuid[])) ORDER BY expires_at LIMIT 100', [attempted])
            ids = [row[0] for row in cursor.fetchall()]
        if not ids:
            break
        for hold_id in ids:
            if monotonic() >= deadline:
                break
            attempted.append(hold_id)
            try:
                with transaction.atomic(), connection.cursor() as cursor:
                    set_worker_timeouts(cursor)
                    from dj.apps.economy.epoch import pin_supported_policy
                    pin_supported_policy()
                    cursor.execute('SELECT status FROM ledger.expire_hold(%s)', [hold_id])
                    expired += int(cursor.fetchone()[0] == 'expired')
            except OperationalError as exc:
                if not contention_error(exc):
                    raise
                deferred += 1
    cleaned, cleanup_deferred = cleanup_gateway_metadata(deadline=monotonic() + 5)
    return {"status": "completed", "expired": expired, "deferred": deferred,
            "calls_cleaned": cleaned, "calls_deferred": cleanup_deferred}


def cleanup_gateway_metadata(*, deadline: float) -> tuple[int, int]:
    """Use the existing expiry lane, bounded to five seconds after hold work.

    A preceding L2 worker/migration rollout can legitimately lack this later
    schema. No metadata cleanup can delete financial usage or transfer rows.
    """
    from .rollup import contention_error, set_worker_timeouts
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('public.ledger_gateway_call') IS NOT NULL")
        if not cursor.fetchone()[0]:
            return 0, 0
    cleaned = 0
    while monotonic() < deadline:
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                set_worker_timeouts(cursor)
                from dj.apps.economy.epoch import pin_supported_policy
                pin_supported_policy()
                cursor.execute('SELECT ledger.cleanup_gateway_calls(1000)')
                count = cursor.fetchone()[0]
                cleaned += count
        except OperationalError as exc:
            if not contention_error(exc):
                raise
            return cleaned, 1
        if count < 1000:
            break
    return cleaned, 0


@app.periodic(cron="* * * * *")
@app.task(name=AI_ROLLUP_TASK_NAME, queue="ledger", retry=False)
def ai_rollup(timestamp: int | None = None) -> dict:
    """§8, §11: drain ``ledger_ai_split_queue`` in 10 000-row batches.
    Each batch and developer credit is a separate transaction."""
    if not l2_tables_exist():
        return {"status": "skipped", "reason": f"{_L2_SENTINEL_TABLE} does not exist yet (L2)"}
    from .rollup import consume_split_batch, contention_error, credit_developer

    deadline = monotonic() + 50
    rows, credited, deferred = 0, 0, 0
    while monotonic() < deadline:
        try:
            consumed = consume_split_batch()
        except OperationalError as exc:
            if not contention_error(exc):
                raise
            consumed = 0
            deferred += 1
        rows += consumed
        # Every credit has its own creator-first transaction after the batch
        # committed. Interleaving phases prevents a busy queue from starving
        # already durable developer credits for an entire tick.
        with connection.cursor() as cursor:
            cursor.execute('SELECT developer_creator_id FROM ledger_dev_markup_pending ORDER BY 1')
            developers = [row[0] for row in cursor.fetchall()]
        for developer_id in developers:
            if monotonic() >= deadline:
                break
            try:
                credited += credit_developer(developer_id)
            except OperationalError as exc:
                if not contention_error(exc):
                    raise
                deferred += 1
        if not consumed:
            break
    return {"status": "completed", "rows": rows, "credited": credited, "deferred": deferred}


@app.periodic(cron="0 * * * *", priority=MAINTENANCE)
@app.task(
    name=PARTITIONS_TASK_NAME, queue="ledger", retry=False,
    priority=MAINTENANCE,
)
def maintain_partitions(timestamp: int | None = None) -> dict:
    from .partitions import maintain_partitions as maintain
    from .rollup import contention_error
    if not l2_tables_exist():
        return {"status": "skipped", "reason": "L2 tables missing"}
    try:
        created = maintain()
    except OperationalError as exc:
        if not contention_error(exc):
            raise
        return {"status": "deferred"}
    return {"status": "completed", "created": created}
