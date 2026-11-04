"""Drop the empty, unreferenced ``authtoken_token`` table (#2213).

#2209 uninstalled ``rest_framework.authtoken``; g12f ``0113`` purged every row
and dropped the table's foreign key to ``g12f_creator``, but deliberately left
the TABLE, because the release before it still had the app installed and
could be rolled back to (its Creator delete and ``ktauth.epoch`` both touch the
table). That release is gone from every rollout and rollback path now, so
nothing in any code that can run reads or writes this table, and it is
dropped here.

Prod as of 2026-10-04 (read-only probe, recorded in the PR): 0113 ran clean
(no ``WARNING g12f.0113`` in its migrate log; it purged 1211 rows and dropped
the FK), the table holds 0 rows, has no foreign key in either direction, and
is owned by the same role ``migrate`` runs as. So in prod this is a plain
``DROP TABLE``. The guards below are for every other database this runs on.

**Never wedges the deploy on an inert table.** ``DROP TABLE`` needs
OWNERSHIP privileges usable without ``SET ROLE`` (``pg_has_role(...,
'USAGE')``; a superuser qualifies), which no GRANT confers. If the migrate
role lacks it, or a view/rule/foreign key someone added by hand still depends
on the table (``DROP ... RESTRICT`` refuses; this never CASCADEs into an object
it did not create), the drop is SKIPPED with a ``WARNING g12f.0118:`` line
naming the owner and the exact statement to run, and ``migrate`` succeeds:
leaving an empty table nobody reads behind is harmless, aborting the whole
release over it is not. Anything else -- a lock not obtained in ~28s, an
unexpected error -- still fails ``migrate``, which fails the deploy before any
pod rolls (retriable: the migration is idempotent).

**Locks.** ``DROP TABLE`` takes ACCESS EXCLUSIVE on ``authtoken_token``, and,
on a database where 0113 skipped the detach, on ``g12f_creator`` as well (it
drops the FK's triggers there). Each attempt therefore waits at most
LOCK_TIMEOUT and is retried with a jittered backoff, exactly like 0113.

**The ``django_migrations`` rows for app ``authtoken`` go with the table**, in
the same transaction. Left behind, they claim the app's schema exists when it
does not, so re-installing the app (or running ``migrate`` from a release that
still had it) would skip creating the table and then fail on first use. Gone,
that same ``migrate`` recreates the table from the app's own migrations. They
are kept whenever the drop is skipped, so the two always agree.

Stale ``django_content_type`` / ``auth_permission`` rows for ``authtoken`` are
NOT touched: deleting them raw would trip whatever FK references them, and
they are inert. ``manage.py remove_stale_contenttypes --include-stale-apps``
is the purpose-built tool if anyone wants them gone.

Portable: a fresh database (CI, a new dev box) never had the table, and there
the forward only deletes ``django_migrations`` rows that do not exist.

Reverse: a no-op. No code that can run against this schema uses the table,
and a release that did would recreate it by migrating ``authtoken`` (see
above), so ``migrate g12f 0117`` needs nothing from it.
"""
import random
import time

from django.db import DatabaseError, OperationalError, migrations, transaction

TABLE = "authtoken_token"
APP_LABEL = "authtoken"

# Same bound as 0113: at most 1s of queueing per attempt on the tables the
# DROP locks, ~28s in all before failing the deploy safely.
LOCK_TIMEOUT = "1s"
LOCK_ATTEMPTS = 12
LOCK_BACKOFF_SECONDS = (0.5, 1.5)
LOCK_NOT_AVAILABLE = "55P03"
DEADLOCK_DETECTED = "40P01"
INSUFFICIENT_PRIVILEGE = "42501"
DEPENDENT_OBJECTS_STILL_EXIST = "2BP01"


def _sqlstate(exc):
    # psycopg 3 names it `sqlstate`, psycopg2 `pgcode`; read both.
    cause = exc.__cause__
    return getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)


def _is_lock_timeout(exc):
    return _sqlstate(exc) in (LOCK_NOT_AVAILABLE, DEADLOCK_DETECTED)


def _ownership(cursor):
    """``(owner, current_user, may_drop)``, or ``None`` if there is no table.

    ``to_regclass`` resolves through ``search_path`` exactly as the unqualified
    ``DROP TABLE`` below does, so both always mean the same relation.
    """
    cursor.execute(
        "SELECT pg_get_userbyid(c.relowner), current_user, "
        "pg_has_role(current_user, c.relowner, 'USAGE') "
        "FROM pg_class c WHERE c.oid = to_regclass(%s)",
        [TABLE],
    )
    return cursor.fetchone()


def _warn(message):
    # stdout is the audit trail in the Cloud Build `migrate` step log; the
    # prefix is what to grep for.
    print(f"WARNING g12f.0118: {message}")


def _with_lock_retries(connection, statement_fn):
    """Run ``statement_fn(cursor)`` in its own transaction, retrying on lock
    timeout or deadlock. (A savepoint when already inside one, as in tests.)
    """
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
            print(
                f"g12f.0118: lock not available (attempt {attempt}/"
                f"{LOCK_ATTEMPTS}); retrying in {pause:.1f}s"
            )
            time.sleep(pause)


def _forget_app_migrations(cursor):
    cursor.execute("DELETE FROM django_migrations WHERE app = %s", [APP_LABEL])
    return cursor.rowcount


def drop_legacy_table(apps, schema_editor):
    connection = schema_editor.connection
    if connection.vendor != "postgresql":
        return
    qn = connection.ops.quote_name

    with connection.cursor() as cursor:
        found = _ownership(cursor)

    if found is not None:
        owner, me, may_drop = found
        statement = f"DROP TABLE {TABLE}"
        if not may_drop:
            _warn(
                f"SKIPPED dropping {TABLE}: it is owned by {owner!r} and "
                f"migrate runs as {me!r}, which cannot DROP it. The table is "
                f"inert (nothing reads it), so the deploy continues. Fix: as "
                f"{owner!r} run `{statement}; DELETE FROM django_migrations "
                f"WHERE app = '{APP_LABEL}'`."
            )
            return

    def drop(cursor):
        # IF EXISTS: another session may have dropped it since the check.
        # RESTRICT (the default, spelled out): never cascade into an object
        # this migration did not create.
        cursor.execute(f"DROP TABLE IF EXISTS {qn(TABLE)} RESTRICT")
        return _forget_app_migrations(cursor)

    try:
        forgotten = _with_lock_retries(connection, drop)
    except DatabaseError as exc:
        state = _sqlstate(exc)
        if state not in (INSUFFICIENT_PRIVILEGE, DEPENDENT_OBJECTS_STILL_EXIST):
            raise
        _warn(
            f"SKIPPED dropping {TABLE}: {exc.__cause__} (SQLSTATE {state}). "
            "The table is inert, so the deploy continues. Fix by hand (drop "
            f"the dependent object or run as the owner): `DROP TABLE {TABLE}; "
            f"DELETE FROM django_migrations WHERE app = '{APP_LABEL}'`."
        )
        return

    print(
        f"g12f.0118: {'dropped' if found else 'no'} {TABLE} table"
        f"{'' if found else ' to drop'}; forgot {forgotten} django_migrations "
        f"row(s) for app {APP_LABEL!r}"
    )


class Migration(migrations.Migration):
    # The drop commits in its own short, lock-bounded transaction.
    atomic = False

    dependencies = [
        ("g12f", "0117_actor_evidence_retention_and_unpublish"),
    ]

    operations = [
        migrations.RunPython(drop_legacy_table, migrations.RunPython.noop),
    ]
