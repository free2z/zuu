"""Add ``Creator.public_id``: an opaque, stable, per-account UUID (#2215).

It becomes the OIDC ``sub`` and the subject ``ledger.hold`` resolves to an
account (``docs/tuzis/ledger-v2.md``, §4.1). The end state is exactly what
that document names::

    public_id uuid NOT NULL DEFAULT gen_random_uuid()
    CONSTRAINT g12f_creator_public_id_key UNIQUE

plus a trigger that refuses any UPDATE changing a non-NULL value, because an
identifier handed to a third party as a token subject must never move.

**Why not a plain ``AddField``.** Django would emit ``ADD COLUMN ... DEFAULT
GEN_RANDOM_UUID() NOT NULL UNIQUE``: a volatile default rewrites the whole of
``g12f_creator`` and builds the unique index while holding ACCESS EXCLUSIVE,
so every account query on the platform (every authenticated request) queues
behind it for the duration. The state change IS a plain ``AddField``; the
database side is the online sequence below, and ``makemigrations --check``
stays clean because the two describe the same column.

**The phases**, each its own short transaction (``atomic = False``), every
lock wait bounded by ``LOCK_TIMEOUT`` and retried -- the #2214 / 0113 pattern:

1. ``ADD COLUMN public_id uuid`` (nullable, no default: catalog-only, no
   rewrite) and, in the same transaction, ``SET DEFAULT gen_random_uuid()``.
   Setting a default on an existing column never rewrites; it applies to rows
   inserted from then on. **This is what makes old pods safe**: ``migrate``
   runs before the new pods roll, so the previous release keeps creating
   Creators for the rest of the rollout (and after a code-only rollback). Its
   INSERTs do not name the column, so they get the DB default -- no Python
   default, no trigger. ``gen_random_uuid()`` is built into ``pg_catalog``
   since PG13; prod is PG14, so no ``pgcrypto``.
2. Backfill the rows that predate phase 1, ``BACKFILL_BATCH`` at a time in
   primary-key order. Each batch is its own transaction, so it holds its row
   locks for milliseconds; a row an old pod has locked makes that batch wait
   at most ``LOCK_TIMEOUT`` and retry.
3. ``CREATE UNIQUE INDEX CONCURRENTLY`` -- no lock that blocks reads or
   writes. A failed build leaves an INVALID index behind; it is dropped
   (``CONCURRENTLY``) before the error propagates, and before any rebuild.
4. ``CHECK (public_id IS NOT NULL) NOT VALID`` (catalog-only), then
   ``VALIDATE CONSTRAINT`` (a scan under SHARE UPDATE EXCLUSIVE, which does
   not block DML), then one short transaction that ``SET NOT NULL`` -- PG12+
   proves it from the validated CHECK instead of scanning under ACCESS
   EXCLUSIVE -- drops the now-redundant CHECK, promotes the index to the
   ``UNIQUE`` constraint a fresh ``AddField`` would have created, and installs
   the immutability trigger.

Every phase is idempotent, so a ``migrate`` that dies part way (lock never
obtained, deploy cancelled) is simply re-run.

**Failure is safe and loud.** A lock not obtained within ~28s, or anything
else, fails ``migrate``, which fails the deploy before any pod rolls. The old
release is untouched by any intermediate state: it never reads the column,
and each phase leaves a schema it runs against.

**Ownership preflight.** ALTER TABLE needs ownership of ``g12f_creator``
(usable without SET ROLE). Unlike 0113's dead table, skipping is not an
option -- the new code needs the column -- so the preflight fails the deploy
BEFORE any DDL, naming the owner, rather than half way through.

**Reverse** drops the trigger, its function and the column. It is lossless
for the schema but NOT for the values: re-applying mints NEW UUIDs. That is
harmless until something outside this database has recorded one (an OIDC
``sub`` handed to a relying party, a ledger row); from then on, do not roll
this back.
"""
import random
import time

from django.contrib.postgres.functions import RandomUUID
from django.db import OperationalError, migrations, models, transaction

TABLE = "g12f_creator"
COLUMN = "public_id"
# What Postgres names an inline `UNIQUE` column constraint, which is what
# Django's AddField emits for `unique=True` -- so this database is
# indistinguishable from one built from scratch.
UNIQUE_NAME = "g12f_creator_public_id_key"
NOT_NULL_CHECK = "g12f_creator_public_id_not_null"
TRIGGER = "g12f_creator_public_id_immutable"
FUNCTION = "g12f_creator_public_id_immutable"

# Same budget as 0113, for the same reason: ACCESS EXCLUSIVE on the hottest
# table queues every account query behind the WAITER, so each attempt waits at
# most a second and gives up; ~28s in total before the deploy fails safely.
LOCK_TIMEOUT = "1s"
LOCK_ATTEMPTS = 12
LOCK_BACKOFF_SECONDS = (0.5, 1.5)
LOCK_NOT_AVAILABLE = "55P03"
DEADLOCK_DETECTED = "40P01"

# The concurrent index build holds SHARE UPDATE EXCLUSIVE, which conflicts
# with no DML, so waiting is cheap for users; it waits for every transaction
# that could see the table, e.g. a DBCOPY pg_dump. Bounded so a deploy never
# hangs forever behind one.
CONCURRENT_INDEX_LOCK_TIMEOUT = "5min"

BACKFILL_BATCH = 1000

IMMUTABLE_FUNCTION_SQL = f"""
CREATE OR REPLACE FUNCTION {FUNCTION}()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'g12f_creator.public_id is immutable (creator %)', OLD.id
        USING ERRCODE = 'check_violation';
END;
$$;
"""
# `UPDATE OF public_id` fires only when the statement names the column, so a
# normal profile save never pays for it. NULL -> value stays allowed: that is
# the backfill, and only the backfill (the column is NOT NULL once this exists).
IMMUTABLE_TRIGGER_SQL = f"""
CREATE TRIGGER {TRIGGER}
BEFORE UPDATE OF {COLUMN} ON {TABLE}
FOR EACH ROW
WHEN (OLD.{COLUMN} IS NOT NULL AND NEW.{COLUMN} IS DISTINCT FROM OLD.{COLUMN})
EXECUTE FUNCTION {FUNCTION}();
"""


def _log(message):
    # stdout is the audit trail in the Cloud Build `migrate` step log.
    print(f"g12f.0114: {message}")


def _sqlstate(exc):
    # psycopg 3 names it `sqlstate`, psycopg2 `pgcode`; read both (0113).
    cause = exc.__cause__
    return getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)


def _is_lock_timeout(exc):
    return _sqlstate(exc) in (LOCK_NOT_AVAILABLE, DEADLOCK_DETECTED)


def _with_lock_retries(connection, statement_fn, what):
    """Run ``statement_fn(cursor)`` in its own short transaction, retrying on
    lock timeout or deadlock."""
    for attempt in range(1, LOCK_ATTEMPTS + 1):
        try:
            with transaction.atomic(using=connection.alias):
                with connection.cursor() as cursor:
                    cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
                    return statement_fn(cursor)
        except OperationalError as exc:
            if not _is_lock_timeout(exc) or attempt == LOCK_ATTEMPTS:
                raise
            pause = random.uniform(*LOCK_BACKOFF_SECONDS)
            _log(
                f"{what}: lock not available (attempt {attempt}/"
                f"{LOCK_ATTEMPTS}); retrying in {pause:.1f}s"
            )
            time.sleep(pause)


def _one(cursor, sql, params=None):
    cursor.execute(sql, params or [])
    row = cursor.fetchone()
    return row[0] if row else None


def _column(cursor):
    """``(exists, is_not_null)`` for ``public_id``."""
    cursor.execute(
        "SELECT attnotnull FROM pg_attribute "
        "WHERE attrelid = %s::regclass AND attname = %s AND NOT attisdropped",
        [TABLE, COLUMN],
    )
    row = cursor.fetchone()
    return (row is not None, bool(row and row[0]))


def _constraint_exists(cursor, name):
    return bool(_one(
        cursor,
        "SELECT 1 FROM pg_constraint WHERE conrelid = %s::regclass "
        "AND conname = %s",
        [TABLE, name],
    ))


def _index_state(cursor):
    """``None`` if there is no index named UNIQUE_NAME, else its validity."""
    cursor.execute(
        "SELECT i.indisvalid FROM pg_index i "
        "JOIN pg_class c ON c.oid = i.indexrelid "
        "WHERE i.indrelid = %s::regclass AND c.relname = %s",
        [TABLE, UNIQUE_NAME],
    )
    row = cursor.fetchone()
    return None if row is None else bool(row[0])


def _require_postgres_outside_a_transaction(connection):
    if connection.vendor != "postgresql":
        raise RuntimeError("g12f.0114 needs PostgreSQL (gen_random_uuid, CONCURRENTLY)")
    if connection.in_atomic_block:
        # CREATE INDEX CONCURRENTLY cannot run in one, and a wrapping
        # transaction would also turn every "short" phase into one long lock.
        raise RuntimeError("g12f.0114 must run outside a transaction")


def preflight_ownership(connection):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_get_userbyid(c.relowner), current_user, "
            "pg_has_role(current_user, c.relowner, 'USAGE') "
            "FROM pg_class c WHERE c.oid = %s::regclass",
            [TABLE],
        )
        owner, me, may_alter = cursor.fetchone()
    if not may_alter:
        raise RuntimeError(
            f"g12f.0114: {TABLE} is owned by {owner!r} and migrate runs as "
            f"{me!r}, which cannot ALTER it. Nothing was changed. Fix: "
            f"`ALTER TABLE {TABLE} OWNER TO {me}` as {owner!r} (or grant "
            f"{owner!r} to {me!r} WITH INHERIT), then re-run the deploy."
        )


# ------------------------------------------------------------------- phases


def add_column(connection):
    """Phase 1: nullable column + DB default; catalog-only, no rewrite."""
    def run(cursor):
        cursor.execute(
            f"ALTER TABLE {TABLE} ADD COLUMN IF NOT EXISTS {COLUMN} uuid NULL"
        )
        cursor.execute(
            f"ALTER TABLE {TABLE} ALTER COLUMN {COLUMN} "
            "SET DEFAULT gen_random_uuid()"
        )

    _with_lock_retries(connection, run, "add column")


def backfill(connection, batch=None):
    """Phase 2: give every pre-existing row a UUID, one short batch at a time.

    Rows inserted after phase 1 already have one (the default), so this walks
    the primary key once and then re-checks. Returns the number of rows set.
    """
    batch = batch or BACKFILL_BATCH
    total = 0

    def one_batch(after):
        def run(cursor):
            # The outer `public_id IS NULL` is re-evaluated against the latest
            # row version if a concurrent writer committed first, so a value
            # can never be overwritten.
            cursor.execute(
                f"UPDATE {TABLE} SET {COLUMN} = gen_random_uuid() "
                f"WHERE {COLUMN} IS NULL AND id IN ("
                f"  SELECT id FROM {TABLE} WHERE id > %s AND {COLUMN} IS NULL"
                "   ORDER BY id LIMIT %s"
                ") RETURNING id",
                [after, batch],
            )
            return [pk for (pk,) in cursor.fetchall()]

        return _with_lock_retries(connection, run, "backfill")

    # Two passes at most in practice: the second only finds something if a
    # row became NULL behind the cursor, which nothing does -- but VALIDATE
    # would fail the deploy on one, so check rather than assume.
    for _pass in range(3):
        after = 0
        while True:
            ids = one_batch(after)
            if not ids:
                break
            total += len(ids)
            after = max(ids)
        with connection.cursor() as cursor:
            if not _one(
                cursor, f"SELECT 1 FROM {TABLE} WHERE {COLUMN} IS NULL LIMIT 1"
            ):
                break
    _log(f"backfilled {total} row(s)")
    return total


def build_unique_index(connection):
    """Phase 3: CREATE UNIQUE INDEX CONCURRENTLY, cleaning up a failed one."""
    with connection.cursor() as cursor:
        if _constraint_exists(cursor, UNIQUE_NAME):
            return
        state = _index_state(cursor)
        if state is True:
            return
        # Set BEFORE the cleanup drop too: DROP INDEX CONCURRENTLY also waits
        # for conflicting transactions, and prod sets no lock_timeout of its
        # own, so an unbounded wait here would stall the deploy (codex).
        cursor.execute(
            f"SET lock_timeout = '{CONCURRENT_INDEX_LOCK_TIMEOUT}'"
        )
        try:
            if state is False:
                _log(f"dropping INVALID index {UNIQUE_NAME} left by a failed build")
                cursor.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {UNIQUE_NAME}")
            cursor.execute(
                f"CREATE UNIQUE INDEX CONCURRENTLY {UNIQUE_NAME} "
                f"ON {TABLE} ({COLUMN})"
            )
        except Exception:
            # A failed concurrent build leaves an INVALID index that every
            # write still maintains. Never leave it behind; if even the drop
            # fails, the next run's cleanup above removes it -- and the
            # original error is the one worth reporting.
            try:
                cursor.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {UNIQUE_NAME}")
            except Exception as cleanup:
                _log(f"could not drop {UNIQUE_NAME} after a failed build: {cleanup}")
            raise
        finally:
            cursor.execute("RESET lock_timeout")
    _log(f"built unique index {UNIQUE_NAME}")


def enforce_not_null_and_finish(connection):
    """Phase 4: NOT VALID check -> VALIDATE -> SET NOT NULL + constraint + trigger."""
    with connection.cursor() as cursor:
        _exists, not_null = _column(cursor)

    if not not_null:
        def add_check(cursor):
            if not _constraint_exists(cursor, NOT_NULL_CHECK):
                cursor.execute(
                    f"ALTER TABLE {TABLE} ADD CONSTRAINT {NOT_NULL_CHECK} "
                    f"CHECK ({COLUMN} IS NOT NULL) NOT VALID"
                )

        _with_lock_retries(connection, add_check, "add NOT VALID check")
        _with_lock_retries(
            connection,
            lambda cursor: cursor.execute(
                f"ALTER TABLE {TABLE} VALIDATE CONSTRAINT {NOT_NULL_CHECK}"
            ),
            "validate check",
        )

    def finish(cursor):
        # With the CHECK validated, SET NOT NULL skips the table scan, so this
        # transaction's ACCESS EXCLUSIVE lasts milliseconds.
        cursor.execute(f"ALTER TABLE {TABLE} ALTER COLUMN {COLUMN} SET NOT NULL")
        cursor.execute(
            f"ALTER TABLE {TABLE} DROP CONSTRAINT IF EXISTS {NOT_NULL_CHECK}"
        )
        if not _constraint_exists(cursor, UNIQUE_NAME):
            cursor.execute(
                f"ALTER TABLE {TABLE} ADD CONSTRAINT {UNIQUE_NAME} "
                f"UNIQUE USING INDEX {UNIQUE_NAME}"
            )
        cursor.execute(IMMUTABLE_FUNCTION_SQL)
        cursor.execute(f"DROP TRIGGER IF EXISTS {TRIGGER} ON {TABLE}")
        cursor.execute(IMMUTABLE_TRIGGER_SQL)

    _with_lock_retries(connection, finish, "set not null")
    _log("public_id is NOT NULL, UNIQUE and immutable")


def forwards(apps, schema_editor):
    connection = schema_editor.connection
    _require_postgres_outside_a_transaction(connection)
    preflight_ownership(connection)
    add_column(connection)
    backfill(connection)
    build_unique_index(connection)
    enforce_not_null_and_finish(connection)


def backwards(apps, schema_editor):
    connection = schema_editor.connection
    _require_postgres_outside_a_transaction(connection)

    def run(cursor):
        cursor.execute(f"DROP TRIGGER IF EXISTS {TRIGGER} ON {TABLE}")
        cursor.execute(f"DROP FUNCTION IF EXISTS {FUNCTION}()")
        # Drops the unique constraint and its index with it.
        cursor.execute(f"ALTER TABLE {TABLE} DROP COLUMN IF EXISTS {COLUMN}")

    _with_lock_retries(connection, run, "drop column")


class Migration(migrations.Migration):
    # Each phase commits on its own, and CREATE INDEX CONCURRENTLY cannot run
    # inside a transaction at all.
    atomic = False

    dependencies = [
        ("g12f", "0113_purge_legacy_drf_authtoken"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddField(
                    model_name="creator",
                    name="public_id",
                    field=models.UUIDField(
                        db_default=RandomUUID(),
                        editable=False,
                        unique=True,
                        help_text=(
                            "Opaque, stable per-account id: the OIDC subject "
                            "and the ledger's account key. Assigned by the "
                            "database; never changes."
                        ),
                    ),
                ),
            ],
            database_operations=[
                migrations.RunPython(forwards, backwards),
            ],
        ),
    ]
