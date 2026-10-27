"""The lease table's migration produces EXACTLY ``lease.LEASE_TABLE_DDL``.

WHY THIS TEST EXISTS AT ALL
---------------------------
``dj.apps.jobs.lease`` is written against ``LEASE_TABLE_DDL``: that
constant, not the model, is what the middleware's INSERT/UPDATE/DELETE
statements assume, and until ``jobs/0004`` shipped it was also what the
whole of ``test_lease.py`` built its table from. Now there are two
descriptions of one table, and every test in ``test_lease.py`` runs
against the MIGRATED one -- so a divergence between them is invisible to
all of them:

* the middleware always names all ten columns, so a column that migrated
  without its ``DEFAULT`` behaves identically in every test and
  differently only for a future writer that omits it;
* ``varchar(255)`` migrated as ``text`` accepts everything the tests
  insert and silently drops the length guard on ``pod``/``worker_name``,
  which come from the environment;
* ``PositiveIntegerField`` would have added a ``CHECK (attempt >= 0)``
  the DDL has not got -- fine until the day a caller passes -1;
* and an index Django auto-names is not
  ``jobs_joblease_last_beat_at_idx``, which is the name 's sweep,
  this DDL and every EXPLAIN plan refer to. Nothing about the index NAME
  changes any query's result, so no behavioural test can catch it: the
  planner uses the index whatever it is called.

Two independent checks, because they fail on different things.

1. ``test_sqlmigrate_matches_the_ddl`` parses the SQL Django WOULD emit
   and the SQL the DDL IS, and compares them structurally (type,
   nullability, primary key, DB default, per column; name and columns,
   per index). It runs without applying anything, and it names the
   offending column when it fails.
2. ``test_migrated_table_is_indistinguishable_from_the_ddl`` runs the
   migration's own SQL and the DDL into two scratch tables in the live
   test database and compares PostgreSQL's OWN catalog view of them.
   That one needs no parser and so cannot be fooled by a parser bug. It
   is only as wide as the catalog columns it selects, though: type,
   length, nullability, DEFAULT, position, identity, generated-ness and
   collation per column; every index definition; every constraint
   definition. A drift outside those (a storage parameter, a
   tablespace, a comment) is not caught by either check. Both
   sides are built by the test; it never reads the live
   ``jobs_joblease``, which ``test_lease.py``'s ``no_lease_table``
   fixture may have rebuilt from the DDL earlier in the session (that
   would make it DDL vs. DDL and unable to fail).
"""
from __future__ import annotations

import io
import re

import pytest
from django.core.management import call_command
from django.db import connection

from dj.apps.jobs import lease, models

#The two scratch copies the catalog comparison builds -- one by running
#the migration's OWN SQL, one from the DDL. Both end in the table name
#they are substituted for, so substituting back yields the real names
#for the PK index (``*_pkey``) and the beat index
#(``*_last_beat_at_idx``) alike. They are scratch tables rather than
#"the live ``jobs_joblease`` vs. a scratch DDL copy" on purpose: the
#live table is session state, and ``test_lease.py``'s ``no_lease_table``
#fixture rebuilds it FROM ``LEASE_TABLE_DDL``, so comparing against it
#would silently become DDL-vs-DDL -- an unconditional pass -- for any
#session in which that fixture has run first.
SCRATCH_FROM_DDL = 'joblease_ddl_check'
SCRATCH_FROM_MIGRATION = 'joblease_migration_check'


# ---------------------------------------------------------------------------
# a very small DDL parser -- enough for CREATE TABLE / CREATE INDEX
# ---------------------------------------------------------------------------

def _unquote(name: str) -> str:
    return name.strip().strip('"')


def _balanced(sql: str, open_at: int) -> str:
    """The text between ``sql[open_at] == '('`` and its matching ``)``."""
    assert sql[open_at] == '(', sql[open_at:open_at + 20]
    depth = 0
    for i in range(open_at, len(sql)):
        if sql[i] == '(':
            depth += 1
        elif sql[i] == ')':
            depth -= 1
            if depth == 0:
                return sql[open_at + 1:i]
    raise AssertionError(f'unbalanced parentheses from {open_at}')


def _split_top_level(body: str) -> list[str]:
    parts, depth, current = [], 0, []
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(''.join(current))
            current = []
        else:
            current.append(ch)
    if ''.join(current).strip():
        parts.append(''.join(current))
    return [p.strip() for p in parts if p.strip()]


def _normalise_type(raw: str) -> str:
    """``timestamp with time zone`` and ``timestamptz`` are one type."""
    text = ' '.join(raw.lower().split())
    text = text.replace('timestamp with time zone', 'timestamptz')
    text = text.replace('character varying', 'varchar')
    return re.sub(r'\s*\(\s*(\d+)\s*\)', r'(\1)', text)


def _parse_column(definition: str) -> tuple[str, dict]:
    """``"pod" varchar(255) DEFAULT '' NOT NULL`` -> structured facts.

    Constraint clauses are stripped in an order that matters: ``DEFAULT``
    first (its value may contain anything), then ``PRIMARY KEY``, then
    ``NOT NULL`` -- only then is a bare ``NULL`` an explicit nullability
    marker rather than the tail of ``NOT NULL``.
    """
    name, _, rest = definition.strip().partition(' ')
    default = None
    match = re.search(
        r'\bDEFAULT\s+(.+?)(?=\s+(?:NOT\s+NULL|NULL|PRIMARY\s+KEY)\b|$)',
        rest, re.IGNORECASE)
    if match:
        default = match.group(1).strip()
        rest = rest[:match.start()] + rest[match.end():]
    primary_key = bool(re.search(r'\bPRIMARY\s+KEY\b', rest, re.IGNORECASE))
    rest = re.sub(r'\bPRIMARY\s+KEY\b', ' ', rest, flags=re.IGNORECASE)
    not_null = bool(re.search(r'\bNOT\s+NULL\b', rest, re.IGNORECASE))
    rest = re.sub(r'\bNOT\s+NULL\b', ' ', rest, flags=re.IGNORECASE)
    rest = re.sub(r'\bNULL\b', ' ', rest, flags=re.IGNORECASE)
    return _unquote(name), {
        'type': _normalise_type(rest),
        # A PRIMARY KEY column is NOT NULL whether or not it says so.
        'not_null': not_null or primary_key,
        'primary_key': primary_key,
        'default': default,
    }


def _parse_create_table(sql: str, table: str) -> dict[str, dict]:
    match = re.search(
        r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?' + re.escape(table)
        + r'"?\s*\(', sql, re.IGNORECASE)
    assert match, f'no CREATE TABLE for {table} in:\n{sql}'
    body = _balanced(sql, match.end() - 1)
    return dict(_parse_column(part) for part in _split_top_level(body))


def _parse_indexes(sql: str, table: str) -> dict[str, list[str]]:
    found = {}
    pattern = (
        r'CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?'
        r'([^\s"]+)"?\s+ON\s+"?' + re.escape(table) + r'"?\s*\(([^)]*)\)')
    for name, cols in re.findall(pattern, sql, re.IGNORECASE):
        found[_unquote(name)] = [_unquote(c) for c in cols.split(',')]
    return found


# ---------------------------------------------------------------------------
# 1. what Django would emit vs. what the middleware was written against
# ---------------------------------------------------------------------------

def _sqlmigrate() -> str:
    """The SQL ``migrate`` would run for ``jobs/0004``, applying nothing."""
    out = io.StringIO()
    call_command('sqlmigrate', 'jobs', '0004', stdout=out)
    return out.getvalue()


def _statements(sql: str) -> list[str]:
    """``sql`` split into statements, with SQL comments stripped first.

    ``sqlmigrate`` prefixes its output with a ``--`` comment naming the
    operation, and that comment contains semicolons.
    """
    uncommented = '\n'.join(
        line for line in sql.splitlines()
        if not line.strip().startswith('--'))
    return [s.strip() for s in uncommented.split(';') if s.strip()]


@pytest.mark.django_db
def test_sqlmigrate_matches_the_ddl():
    migrated_sql = _sqlmigrate()

    table = lease.LEASE_TABLE
    ddl_columns = _parse_create_table(lease.LEASE_TABLE_DDL, table)
    migrated_columns = _parse_create_table(migrated_sql, table)

    # Names AND order: the DDL is a CREATE TABLE and so is the migration,
    # so ordinal position is part of the schema they must agree on.
    assert list(migrated_columns) == list(ddl_columns)
    for column, expected in ddl_columns.items():
        assert migrated_columns[column] == expected, (
            f'{table}.{column} drifted from lease.LEASE_TABLE_DDL')

    ddl_indexes = _parse_indexes(lease.LEASE_TABLE_DDL, table)
    assert ddl_indexes == {f'{table}_last_beat_at_idx': ['last_beat_at']}, (
        'the DDL itself changed; update this test with it')
    assert _parse_indexes(migrated_sql, table) == ddl_indexes

    # The migration must not smuggle in anything else -- a CHECK from a
    # PositiveIntegerField, a foreign key into procrastinate's table, a
    # second index. Everything the migration emits is one of these.
    statements = _statements(migrated_sql)
    assert [s.split()[0].upper() for s in statements] == [
        'BEGIN', 'CREATE', 'CREATE', 'COMMIT'], migrated_sql
    assert 'CHECK' not in migrated_sql.upper()
    assert 'REFERENCES' not in migrated_sql.upper()


@pytest.mark.django_db
def test_model_pins_the_table_and_index_names():
    """The two names nothing else can catch.

    ``db_table`` is what every raw statement in ``lease.py`` names, and
    the index name is what 's sweep and the DDL name. A model that
    let Django choose either would still pass every behavioural test.
    """
    meta = models.JobLease._meta
    assert meta.db_table == lease.LEASE_TABLE
    assert [(i.name, i.fields) for i in meta.indexes] == [
        (f'{lease.LEASE_TABLE}_last_beat_at_idx', ['last_beat_at'])]
    assert meta.pk.name == 'job_id'


# ---------------------------------------------------------------------------
# 2. PostgreSQL's own opinion, with no parser in the loop
# ---------------------------------------------------------------------------

def _catalog_columns(cursor, table: str) -> list[tuple]:
    cursor.execute(
        """
        SELECT column_name, data_type, character_maximum_length,
               is_nullable, column_default, ordinal_position,
               is_identity, identity_generation,
               is_generated, generation_expression,
               collation_name
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = %s
        ORDER BY ordinal_position
        """,
        (table,),
    )
    return cursor.fetchall()


def _catalog_indexes(cursor, table: str) -> list[str]:
    cursor.execute(
        'SELECT indexdef FROM pg_indexes '
        'WHERE schemaname = current_schema() AND tablename = %s '
        'ORDER BY indexname',
        (table,),
    )
    return [row[0] for row in cursor.fetchall()]


def _catalog_constraints(cursor, table: str) -> list[tuple[str, str, str]]:
    """PK, UNIQUE, CHECK, FK and EXCLUDE constraints -- none of which
    ``information_schema.columns`` or ``pg_indexes`` shows in full."""
    cursor.execute(
        'SELECT conname, contype::text, pg_get_constraintdef(oid) '
        'FROM pg_constraint WHERE conrelid = to_regclass(%s) '
        'ORDER BY conname',
        (table,),
    )
    return cursor.fetchall()


def _migration_recorded(cursor) -> bool:
    """Whether ``jobs/0004`` is in the test database's migration history.

    Asked of ``django_migrations``, NOT of the live table: ``test_lease``'s
    ``no_lease_table`` fixture rebuilds ``jobs_joblease`` from the DDL, so
    the table existing proves nothing about the graph.
    """
    cursor.execute(
        'SELECT 1 FROM django_migrations WHERE app = %s AND name = %s',
        ('jobs', '0004_joblease'),
    )
    return cursor.fetchone() is not None


@pytest.mark.django_db
def test_migrated_table_is_indistinguishable_from_the_ddl():
    """Build BOTH tables side by side and diff PostgreSQL's own catalog.

    This is the check that needs no parser: if the migration's own SQL
    and the DDL produce the same rows in ``information_schema.columns``
    and ``pg_indexes``, then every statement in ``lease.py`` means the
    same thing against either.

    Both sides are built here, from ``sqlmigrate`` and from the DDL, and
    NEITHER is the live ``jobs_joblease``. Comparing the live table
    against a DDL copy would have been the same check only for as long
    as the live table is the migrated one -- and ``test_lease.py``'s
    ``no_lease_table`` fixture drops it and rebuilds it from
    ``LEASE_TABLE_DDL``, which would quietly turn this into DDL vs. DDL,
    an assertion that cannot fail, for the rest of the session.
    """
    table = lease.LEASE_TABLE

    ddl_sql = lease.LEASE_TABLE_DDL.replace(table, SCRATCH_FROM_DDL)
    assert SCRATCH_FROM_DDL in ddl_sql and table not in ddl_sql

    # BEGIN/COMMIT are the transaction the test is already inside.
    migration_sql = [
        statement.replace(table, SCRATCH_FROM_MIGRATION)
        for statement in _statements(_sqlmigrate())
        if statement.split()[0].upper() not in ('BEGIN', 'COMMIT')
    ]
    assert migration_sql and all(table not in s for s in migration_sql)

    with connection.cursor() as cursor:
        # jobs/0004 must also be in the graph: without it the migration
        # ships nothing, however well its SQL matches the DDL. Asked of the
        # migration history, not of the live table (see _migration_recorded).
        assert _migration_recorded(cursor), (
            'jobs/0004_joblease was not applied to the test database -- '
            'it is missing from the migration graph')

        try:
            for statement in migration_sql:
                cursor.execute(statement)
            cursor.execute(ddl_sql)
            migrated_columns = _catalog_columns(cursor, SCRATCH_FROM_MIGRATION)
            migrated_indexes = _catalog_indexes(cursor, SCRATCH_FROM_MIGRATION)
            migrated_constraints = _catalog_constraints(
                cursor, SCRATCH_FROM_MIGRATION)
            ddl_columns = _catalog_columns(cursor, SCRATCH_FROM_DDL)
            ddl_indexes = _catalog_indexes(cursor, SCRATCH_FROM_DDL)
            ddl_constraints = _catalog_constraints(cursor, SCRATCH_FROM_DDL)
        finally:
            cursor.execute(f'DROP TABLE IF EXISTS {SCRATCH_FROM_MIGRATION}')
            cursor.execute(f'DROP TABLE IF EXISTS {SCRATCH_FROM_DDL}')

    assert migrated_columns, "the migration's SQL created no table"
    assert migrated_columns == ddl_columns

    # Index definitions carry the table and index names; substitute the
    # scratch prefixes back so only the SHAPE is compared.
    assert [d.replace(SCRATCH_FROM_MIGRATION, table)
            for d in migrated_indexes] == [
        d.replace(SCRATCH_FROM_DDL, table) for d in ddl_indexes]

    assert migrated_constraints, "the migration's SQL created no primary key"
    assert [(name.replace(SCRATCH_FROM_MIGRATION, table), kind, definition)
            for name, kind, definition in migrated_constraints] == [
        (name.replace(SCRATCH_FROM_DDL, table), kind, definition)
        for name, kind, definition in ddl_constraints]


@pytest.mark.django_db
def test_the_middleware_probe_now_finds_the_table():
    """The PRECONDITION this migration removes -- not a behaviour change.

    When ``to_regclass`` returns NULL, ``lease.py`` runs jobs unleased
    and re-probes every ``JOB_LEASE_TABLE_RECHECK_SECONDS`` (60s by
    default), picking the table up with no restart. It only gets as far
    as that probe once ``enabled()`` is true, and today it is not: no
    deployed setting
    turns leases on before  (``test_lease.py``'s
    ``test_leases_are_inert_until_the_reclaimer_reads_them``). So this
    migration writes no lease row and sends no beat. What it buys is
    that when  lifts the gate, the table is already here.
    """
    with connection.cursor() as cursor:
        # The migration history first: the live table alone could have been
        # rebuilt from the DDL by test_lease.py's no_lease_table fixture.
        assert _migration_recorded(cursor), (
            'jobs/0004_joblease was not applied to the test database')
        cursor.execute('SELECT to_regclass(%s) IS NOT NULL',
                       (lease.LEASE_TABLE,))
        assert cursor.fetchone()[0] is True
