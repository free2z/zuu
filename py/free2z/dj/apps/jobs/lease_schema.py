"""Does ``jobs_joblease`` have the body-phase columns yet?

``jobs/0006`` and ``jobs/0007`` add ``phase``, ``phase_token`` and
``phase_attempt``. An image can run ahead of its migrations, so every reader
and writer of those columns asks this module first and falls back to the
0005 schema when they are missing. In that case leases are written exactly as
before the columns existed, no body-start handshake runs, and the reclaimer and
health query see no lease phase. Recovery then relies only on the older
quarantine-table markers. Ordering between ``migrate`` and a worker rollout
therefore cannot stop jobs from running.

A positive answer is permanent for the process. A negative one is re-checked
after ``JOB_LEASE_TABLE_RECHECK_SECONDS``, the same cadence as the lease
table probe, so a long-lived worker picks the columns up without a restart.
Lease decisions are made per lease at acquisition time. A lease acquired
before the columns appeared keeps the legacy behaviour for its whole life.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from django.conf import settings

from dj.apps.jobs.logs import emit_json_line

logger = logging.getLogger('dj.apps.jobs.lease')

LEASE_TABLE = 'jobs_joblease'
PHASE_COLUMNS = ('phase', 'phase_token', 'phase_attempt')

#Positional placeholders work for both a psycopg connection and a Django
#cursor. ``to_regclass`` resolves the table through the search path, the
#same way the table probe and every lease statement do.
_PROBE_SQL = (
    'SELECT count(*) FROM pg_attribute '
    'WHERE attrelid = to_regclass(%s) AND attnum > 0 '
    'AND NOT attisdropped AND attname = ANY(%s)'
)


def _recheck_seconds() -> float:
    return float(getattr(settings, 'JOB_LEASE_TABLE_RECHECK_SECONDS', 60))


class _PhaseColumnsProbe:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.available: bool | None = None
        self.checked_at = 0.0
        self.warned = False

    def reset(self) -> None:
        with self._lock:
            self.available = None
            self.checked_at = 0.0
            self.warned = False

    def check(self, fetchone: Callable[[str, Any], Any]) -> bool:
        with self._lock:
            if self.available:
                return True
            now = time.monotonic()
            if (self.available is False
                    and now - self.checked_at < _recheck_seconds()):
                return False
            row = fetchone(_PROBE_SQL, (LEASE_TABLE, list(PHASE_COLUMNS)))
            self.available = bool(row) and int(row[0]) == len(PHASE_COLUMNS)
            self.checked_at = now
            if not self.available and not self.warned:
                self.warned = True
                emit_json_line(
                    logger,
                    {
                        'event': 'procrastinate_lease_phase_disabled',
                        'reason': 'columns_missing',
                        'table': LEASE_TABLE,
                    },
                    'WARNING',
                    f'procrastinate lease body phase disabled: {LEASE_TABLE} '
                    'has no phase columns yet (jobs/0006-0007 not applied); '
                    'leases use the legacy schema',
                )
            return self.available


_probe = _PhaseColumnsProbe()


def reset() -> None:
    _probe.reset()


def known_available() -> bool:
    """The cached answer only; never queries. Unknown counts as missing."""
    return _probe.available is True


def available_on_connection(conn) -> bool:
    """Probe through a psycopg connection (the lease thread's)."""
    return _probe.check(lambda sql, params: conn.execute(sql, params).fetchone())


def available_on_cursor(cursor) -> bool:
    """Probe through a Django cursor."""
    def fetchone(sql, params):
        cursor.execute(sql, params)
        return cursor.fetchone()
    return _probe.check(fetchone)


def available(using: str = 'default') -> bool:
    """Probe through a Django connection alias."""
    if _probe.available:
        return True
    from django.db import connections

    with connections[using].cursor() as cursor:
        return available_on_cursor(cursor)
