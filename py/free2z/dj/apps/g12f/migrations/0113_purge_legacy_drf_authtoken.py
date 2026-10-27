"""Purge ``authtoken_token`` and detach it from ``g12f_creator`` (#2209).

``rest_framework.authtoken`` is uninstalled in the same change. Its table is
left behind -- uninstalling an app never drops its tables or its
``django_migrations`` rows -- and until #2203 every password login minted a
permanent, never-rotated row in it. Those rows authenticate nothing (no DRF
``TokenAuthentication`` is configured anywhere), but two things still made
them load-bearing, and this migration removes both:

1. **The rows.** They are dead credentials that would become a skeleton key
   the day anyone wired DRF ``TokenAuthentication`` back in. With the app gone,
   ``ktauth.epoch`` no longer deletes them on an ownership event, so they are
   deleted here instead, all at once.
2. **The foreign key** ``authtoken_token.user_id -> g12f_creator.id``. Django,
   not Postgres, cascaded a Creator delete into this table. Once the app is
   uninstalled Django no longer knows the table exists, so any row left in it
   -- including one minted AFTER this purge by an old pod still serving during
   the rollout (see below) -- would turn deleting that account into an FK
   IntegrityError at commit. Dropping the constraint makes that impossible,
   whatever lands in the table later.

**Why the table itself is NOT dropped here.** ``migrate`` runs before the new
pods roll, so the old release serves against this schema for the rest of the
rollout -- and after a code-only rollback (``bin/prod-healthcheck.sh``), for as
long as that lasts. The old release still has ``rest_framework.authtoken``
installed: its Creator delete collects ``authtoken_token`` rows and its
``ktauth.epoch`` deletes from the table on every password change. Both need the
TABLE to exist; neither needs the FK or the rows. So this release purges and
detaches, and ``DROP TABLE authtoken_token`` ships in a LATER release, once no
code that can be rolled back to still references it (#2213).

**This migration never wedges the deploy on privileges.** Dropping the FK
needs OWNERSHIP of the table, which no GRANT confers; if prod's table belongs
to a role other than the one running ``migrate``, the detach is SKIPPED with a
``WARNING g12f.0113:`` line naming the owner and the exact statement to run as
it, and the purge still runs. A purge that is not permitted is skipped the
same way. Anything else -- a lock never obtained in ~28s, an unexpected error
-- still fails ``migrate``, which fails the deploy before any pod rolls.

Portable by construction: the table exists only on databases that once had
the app installed (prod, stage, old dev copies). A fresh database -- CI, a new
dev box -- never creates it, and both directions are then a no-op.

Reversible for the schema only: the reverse re-attaches the foreign key (after
deleting any row whose account is gone, which the constraint would refuse), so
``migrate g12f 0112`` hands the old code exactly the schema it expects. The
purged rows are NOT restored; they were credentials, and nothing should ever
bring one back.
"""
import random
import time

from django.db import DatabaseError, OperationalError, migrations, transaction

TABLE = "authtoken_token"

# The name Django's schema editor generated for the constraint when
# `rest_framework.authtoken` created the table (it is a hash of the table and
# column names, so it is the same on every database). The reverse restores it
# under that exact name, so the table is indistinguishable from one the app
# built itself.
FK_NAME = "authtoken_token_user_id_35299eff_fk_g12f_creator_id"

# Detaching the FK drops its triggers on `g12f_creator`, which takes an
# ACCESS EXCLUSIVE lock on the hottest table on the platform (measured on
# pg16: `pg_locks` shows it on both tables). Held only for a transaction that
# does nothing else, but WAITING for it queues every new query on
# `g12f_creator` behind us. So each attempt waits at most LOCK_TIMEOUT -- one
# second, the longest stall a single attempt can impose on account queries --
# then sleeps a jittered backoff and retries. Worst case before giving up is
# about 12 x 1s + 11 x 1.5s ~= 28s; then the migration fails, which fails the
# deploy before any pod rolls (retriable: both phases are idempotent).
#
# What trips it in practice: anything holding a lock on `g12f_creator` for
# ~30s straight -- a DBCOPY `pg_dump` of prod (ACCESS SHARE for the whole
# dump) or a long-running procrastinate job transaction that touched the
# table. Both fail the deploy SAFELY; re-run it when they finish.
LOCK_TIMEOUT = "1s"
LOCK_ATTEMPTS = 12
LOCK_BACKOFF_SECONDS = (0.5, 1.5)
LOCK_NOT_AVAILABLE = "55P03"
DEADLOCK_DETECTED = "40P01"
INSUFFICIENT_PRIVILEGE = "42501"


def _table_exists(connection):
    return TABLE in connection.introspection.table_names()


def _foreign_keys(cursor):
    cursor.execute(
        "SELECT conname FROM pg_constraint "
        "WHERE conrelid = %s::regclass AND contype = 'f' ORDER BY conname",
        [TABLE],
    )
    return [name for (name,) in cursor.fetchall()]


def _sqlstate(exc):
    # psycopg 3 (what Django uses here) names it `sqlstate`; psycopg2
    # `pgcode`. Reading only one would silently turn every retry into an
    # immediate failure.
    cause = exc.__cause__
    return getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)


def _is_lock_timeout(exc):
    return _sqlstate(exc) in (LOCK_NOT_AVAILABLE, DEADLOCK_DETECTED)


def _ownership(cursor):
    """``(owner, current_user, may_alter)`` for the table.

    ALTER TABLE needs OWNERSHIP privileges usable WITHOUT a SET ROLE: being
    the owner, or inheriting its privileges (``USAGE``, not ``MEMBER`` --
    a NOINHERIT member would pass MEMBER and still get 42501; codex round 5).
    A superuser qualifies. An actual 42501 on the ALTER is also caught. If prod's table was created by a different role
    than the one running ``migrate`` now, the ALTER would fail with 42501 on
    every deploy, forever -- and a stage DBCOPY restore need not reproduce it.
    """
    cursor.execute(
        "SELECT pg_get_userbyid(c.relowner), current_user, "
        "pg_has_role(current_user, c.relowner, 'USAGE') "
        "FROM pg_class c WHERE c.oid = %s::regclass",
        [TABLE],
    )
    return cursor.fetchone()


def _warn(message):
    # stdout is the audit trail in the Cloud Build `migrate` step log; the
    # prefix is what to grep for.
    print(f"WARNING g12f.0113: {message}")


def _with_lock_retries(connection, statement_fn):
    """Run ``statement_fn(cursor)`` in its own transaction, retrying on lock
    timeout or deadlock. (A savepoint when already inside one, as in tests.)
    """
    for attempt in range(1, LOCK_ATTEMPTS + 1):
        try:
            with transaction.atomic(using=connection.alias):
                with connection.cursor() as cursor:
                    if connection.vendor == "postgresql":
                        cursor.execute(
                            f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"
                        )
                    return statement_fn(cursor)
        except OperationalError as exc:
            if not _is_lock_timeout(exc) or attempt == LOCK_ATTEMPTS:
                raise
            pause = random.uniform(*LOCK_BACKOFF_SECONDS)
            print(
                f"g12f.0113: lock not available (attempt {attempt}/"
                f"{LOCK_ATTEMPTS}); retrying in {pause:.1f}s"
            )
            time.sleep(pause)


def _detach(connection):
    """Phase 1: drop the FK(s) to Creator, or say loudly why not."""
    if connection.vendor != "postgresql":
        return []
    qn = connection.ops.quote_name
    with connection.cursor() as cursor:
        owner, me, may_alter = _ownership(cursor)
        names = _foreign_keys(cursor)
    if not names:
        return []
    if not may_alter:
        statements = "; ".join(
            f"ALTER TABLE {TABLE} DROP CONSTRAINT {name}" for name in names
        )
        _warn(
            f"SKIPPED dropping {', '.join(names)}: {TABLE} is owned by "
            f"{owner!r} and migrate runs as {me!r}, which cannot ALTER it. "
            "Until it is dropped, a row an old pod mints after the purge can "
            "block deleting that account. Fix: as "
            f"{owner!r} run `{statements}` (or `ALTER TABLE {TABLE} OWNER TO "
            f"{me}`). #2213 must handle this before it can DROP the table."
        )
        return []

    def detach(cursor):
        dropped = _foreign_keys(cursor)
        for name in dropped:
            cursor.execute(
                f"ALTER TABLE {qn(TABLE)} DROP CONSTRAINT {qn(name)}"
            )
        return dropped

    try:
        return _with_lock_retries(connection, detach)
    except DatabaseError as exc:
        if _sqlstate(exc) != INSUFFICIENT_PRIVILEGE:
            raise
        _warn(
            f"SKIPPED dropping {', '.join(names)}: {exc.__cause__} (running as "
            f"{me!r}, owner {owner!r}). Fix: as {owner!r} run "
            + "; ".join(
                f"ALTER TABLE {TABLE} DROP CONSTRAINT {name}" for name in names
            )
            + ". #2213 must handle this before it can DROP the table."
        )
        return []


def _purge(connection, fk_still_attached):
    """Phase 2: delete every row; skip with a warning if not permitted."""
    qn = connection.ops.quote_name

    def purge(cursor):
        cursor.execute(f"DELETE FROM {qn(TABLE)}")
        return cursor.rowcount

    try:
        return _with_lock_retries(connection, purge)
    except DatabaseError as exc:
        if _sqlstate(exc) != INSUFFICIENT_PRIVILEGE:
            raise
        consequence = (
            "ACCOUNT DELETION NOW FAILS (FK IntegrityError at commit) for every "
            "account still holding a row, because the FK is also still "
            "attached and Django no longer cascades into this table"
            if fk_still_attached
            else "the rows authenticate nothing and no longer block anything"
        )
        _warn(
            f"SKIPPED purging {TABLE}: {exc.__cause__}. {consequence}. Fix: "
            f"run `DELETE FROM {TABLE}` as a role that may (re-running this "
            "migration will NOT happen: it is recorded as applied). #2213 must "
            "handle this too."
        )
        return None


def purge_and_detach(apps, schema_editor):
    connection = schema_editor.connection
    if not _table_exists(connection):
        return

    # Two phases, each its own short transaction (the migration is
    # non-atomic), so the purge never holds token-row locks while waiting for
    # `g12f_creator` -- codex round 2 found that deadlock when both ran in
    # one. The detach ALONE can still deadlock with an OLD pod's credential
    # transaction: the pod holds its Creator row and reaches for
    # authtoken_token while our ALTER holds authtoken_token and waits for
    # g12f_creator. Postgres kills one side. If it is ours, we retry; if it is
    # the old pod's, that one password change or account delete 500s once and
    # can simply be repeated. That is the accepted cost.
    #
    # Detach FIRST: from its COMMIT on, whatever is still in the table can
    # no longer block an account delete, so the purge is pure hygiene. Both
    # phases are idempotent -- a re-run finds no FK and just purges.
    dropped = _detach(connection)
    with connection.cursor() as cursor:
        fk_still_attached = (
            connection.vendor == "postgresql" and bool(_foreign_keys(cursor))
        )
    purged = _purge(connection, fk_still_attached)

    count = "SKIPPED" if purged is None else purged
    print(
        f"g12f.0113: purged {count} legacy rest_framework.authtoken row(s); "
        f"dropped foreign key(s): {', '.join(dropped) or 'none'}"
    )


def reattach(apps, schema_editor):
    connection = schema_editor.connection
    if not _table_exists(connection) or connection.vendor != "postgresql":
        return
    qn = connection.ops.quote_name
    creator_table = apps.get_model("g12f", "Creator")._meta.db_table
    with connection.cursor() as cursor:
        owner, me, may_alter = _ownership(cursor)
    if not may_alter:
        _warn(
            f"SKIPPED re-adding {FK_NAME}: {TABLE} is owned by {owner!r} and "
            f"this runs as {me!r}."
        )
        return

    def attach(cursor):
        if _foreign_keys(cursor):
            return
        # A row whose account was deleted while the table was detached would
        # make ADD CONSTRAINT fail; it is an orphaned dead credential anyway.
        cursor.execute(
            f"DELETE FROM {qn(TABLE)} t WHERE NOT EXISTS "
            f"(SELECT 1 FROM {qn(creator_table)} c WHERE c.id = t.user_id)"
        )
        cursor.execute(
            f"ALTER TABLE {qn(TABLE)} ADD CONSTRAINT {qn(FK_NAME)} "
            f"FOREIGN KEY (user_id) REFERENCES {qn(creator_table)} (id) "
            "DEFERRABLE INITIALLY DEFERRED"
        )

    _with_lock_retries(connection, attach)


class Migration(migrations.Migration):
    # Each phase commits on its own; see purge_and_detach.
    atomic = False

    dependencies = [
        ("g12f", "0112_backfill_mention_notifications_processed"),
    ]

    operations = [
        migrations.RunPython(purge_and_detach, reattach),
    ]
