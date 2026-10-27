"""The sitemap lanes are transaction-scoped, so they survive PgBouncer.

Transaction-mode pooling gives a client a server connection for ONE
transaction. The old lane took a *session* advisory lock
(``pg_try_advisory_lock``) in one statement and released it with
``pg_advisory_unlock`` in another; behind a pooler those two statements can
reach two different backends, so the unlock fails on the second and the lock
stays on the first -- held by a pooled backend that nobody will ever unlock,
and every later request for that child is answered 503 ``lane_busy``.

``pg_try_advisory_xact_lock`` has no unlock: PostgreSQL releases it when the
owning transaction ends. These tests pin the three properties that make that a
drop-in replacement, each with two real database sessions:

* contention is unchanged -- a second session holding the lane makes this one
  refuse immediately with ``SitemapDatabaseBusy`` (non-blocking), and the body
  never runs;
* the lane IS held for the whole body -- another session cannot take it
  while the body runs;
* the lane is gone the instant the ``with`` exits, on success AND on an
  exception, with nothing left in ``pg_locks`` for this backend -- the
  property the session lock lacked.

NEGATIVE CONTROLS (run by hand when this was written):

* swap ``pg_try_advisory_xact_lock`` back to the session-scoped
  ``pg_try_advisory_lock`` in ``_acquire_database_lock``: 3 of 5 fail (held for
  the whole body, released on success, released on raise) -- the lock is still
  in ``pg_locks`` after the lane closes, because nothing unlocks it any more;
* run the lane in autocommit (replace the ``transaction.atomic()`` in
  ``_database_lane`` with a null context and disable the in-atomic guard): 4 of
  5 fail -- the lock is taken and dropped by the same one-statement implicit
  transaction, so another session is never refused.
"""

import contextlib
import threading

import pytest
from django.db import connection, connections, transaction

from dj.apps.g12f.views.sitemap import (
    _acquire_database_lock,
    _database_lane,
    SitemapDatabaseBusy,
)

pytestmark = pytest.mark.skipif(
    connection.vendor != "postgresql",
    reason="advisory lanes are only exercised on PostgreSQL",
)

# Arbitrary, and different from every real lane (the chunk lanes are negative
# and the index lane is the ASCII of "sitemap2").
_LANE = 0x7032323231


def _advisory_locks_held_by_this_session():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_locks "
            "WHERE locktype = 'advisory' AND pid = pg_backend_pid()"
        )
        return cursor.fetchone()[0]


def _other_session_can_take(lock_id):
    """Try the lane from a SEPARATE backend, then give it straight back."""
    result = {}

    def probe():
        try:
            with transaction.atomic(using="default"):
                with connections["default"].cursor() as cursor:
                    cursor.execute(
                        "SELECT pg_try_advisory_xact_lock(%s)", [lock_id]
                    )
                    result["acquired"] = cursor.fetchone()[0]
        except Exception as exc:  # pragma: no cover - surfaced below
            result["error"] = repr(exc)
        finally:
            connections["default"].close()

    worker = threading.Thread(target=probe, daemon=True)
    worker.start()
    worker.join(30)
    assert "error" not in result, result
    return result["acquired"]


@contextlib.contextmanager
def _lane_held_elsewhere(lock_id):
    """Hold the lane through ``_database_lane`` itself, on another backend."""
    entered = threading.Event()
    leave = threading.Event()
    problems = []

    def hold():
        try:
            with _database_lane(lock_id):
                entered.set()
                leave.wait(30)
        except Exception as exc:  # pragma: no cover - surfaced below
            problems.append(repr(exc))
            entered.set()
        finally:
            connections["default"].close()

    worker = threading.Thread(target=hold, daemon=True)
    worker.start()
    assert entered.wait(30)
    try:
        assert not problems, problems
        yield
    finally:
        leave.set()
        worker.join(30)
    assert not problems, problems


@pytest.mark.django_db(transaction=True)
def test_a_lane_held_by_another_session_refuses_without_waiting():
    ran = []
    with _lane_held_elsewhere(_LANE):
        with pytest.raises(SitemapDatabaseBusy):
            with _database_lane(_LANE):
                ran.append(True)
    assert ran == []
    # The refused attempt must not leave anything behind either.
    assert not connection.in_atomic_block
    assert _advisory_locks_held_by_this_session() == 0

    # Once the holder's transaction ends, the lane is free again.
    with _database_lane(_LANE):
        ran.append(True)
    assert ran == [True]


@pytest.mark.django_db(transaction=True)
def test_the_lane_is_held_for_the_whole_body():
    with _database_lane(_LANE):
        # First statement of the body and after further work: still held.
        assert _other_session_can_take(_LANE) is False
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        assert _other_session_can_take(_LANE) is False
    assert _other_session_can_take(_LANE) is True


@pytest.mark.django_db(transaction=True)
def test_the_lane_is_released_at_transaction_end_without_an_unlock():
    with _database_lane(_LANE):
        assert _advisory_locks_held_by_this_session() == 1
    # No pg_advisory_unlock anywhere: COMMIT released it, so the SAME
    # backend -- the one a pooler would hand the next client -- holds nothing.
    assert not connection.in_atomic_block
    assert _advisory_locks_held_by_this_session() == 0
    assert _other_session_can_take(_LANE) is True


@pytest.mark.django_db(transaction=True)
def test_the_lane_is_released_when_the_body_raises():
    class Boom(Exception):
        pass

    with pytest.raises(Boom):
        with _database_lane(_LANE):
            raise Boom

    assert not connection.in_atomic_block
    assert _advisory_locks_held_by_this_session() == 0
    assert _other_session_can_take(_LANE) is True


@pytest.mark.django_db(transaction=True)
def test_acquiring_in_autocommit_is_refused_rather_than_silently_useless():
    # In autocommit the xact lock would be taken and released by the same
    # one-statement implicit transaction: a lane that coordinates nothing.
    assert not connection.in_atomic_block
    with pytest.raises(AssertionError, match="transaction-scoped"):
        _acquire_database_lock(_LANE)
