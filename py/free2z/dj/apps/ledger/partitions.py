"""Bounded, non-destructive maintenance for the two journal parents."""
from datetime import datetime, timezone

from django.db import connection, transaction

PARENTS = ('ledger_transfer', 'ledger_ai_usage')


def expected_partitions(now=None):
    current = now or datetime.now(timezone.utc)
    first = current.year * 12 + current.month - 1
    for parent in PARENTS:
        for offset in range(4):
            year, month = divmod(first + offset, 12)
            next_year, next_month = divmod(first + offset + 1, 12)
            start = f'{year:04d}-{month+1:02d}-01 00:00:00+00'
            end = f'{next_year:04d}-{next_month+1:02d}-01 00:00:00+00'
            yield parent, f'{parent}_y{year:04d}m{month+1:02d}', start, end


def _attached(cursor, parent, child, start, end):
    cursor.execute('SELECT p.relname,pg_get_expr(c.relpartbound,c.oid) '
                   'FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace '
                   'LEFT JOIN pg_inherits i ON i.inhrelid=c.oid LEFT JOIN pg_class p ON p.oid=i.inhparent '
                   "WHERE n.nspname='public' AND c.relname=%s", [child])
    row = cursor.fetchone()
    if row is None:
        return False
    if row != (parent, f"FOR VALUES FROM ('{start}') TO ('{end}')"):
        raise RuntimeError(f'ledger partition {child} has unexpected parent or bounds')
    return True


@transaction.atomic
def maintain_partitions():
    """Create only missing empty ranges; existing default rows are never moved."""
    created = []
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL TIME ZONE 'UTC'")
        cursor.execute("SET LOCAL lock_timeout='250ms'")
        cursor.execute("SET LOCAL statement_timeout='2s'")
        # A row claim serializes competing maintenance without session locks.
        cursor.execute("INSERT INTO ledger_rollup_state(name) VALUES('partitions') ON CONFLICT DO NOTHING")
        cursor.execute("SELECT name FROM ledger_rollup_state WHERE name='partitions' FOR UPDATE NOWAIT")
        for parent, child, start, end in expected_partitions():
            if _attached(cursor, parent, child, start, end):
                continue
            # Names and dates above are generated solely from fixed parents
            # and UTC calendar arithmetic, never from a request or config.
            cursor.execute(f"CREATE TABLE public.{child} PARTITION OF public.{parent} "
                           f"FOR VALUES FROM ('{start}') TO ('{end}')")
            created.append(child)
        cursor.execute("UPDATE ledger_rollup_state SET last_run_at=now() WHERE name='partitions'")
    return created


@transaction.atomic
def partition_drift():
    problems = []
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL TIME ZONE 'UTC'")
        for parent in PARENTS:
            cursor.execute(f'SELECT count(*) FROM public.{parent}_default')
            count = cursor.fetchone()[0]
            if count:
                problems.append(dict(table=parent+'_default', rows=count))
        for parent, child, start, end in expected_partitions():
            try:
                valid = _attached(cursor, parent, child, start, end)
            except RuntimeError:
                valid = False
            if not valid:
                problems.append(dict(table=child, missing_or_invalid=True))
    return problems
