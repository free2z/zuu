"""Enforce that a zPage appears at most once inside a given Series (#841).

Two operations, in this order, because `AddConstraint` on dirty data fails:

1. `dedupe_series_page` deletes surplus `PageOrder` rows for the same
   `(series, page)` pair, keeping the one with the lowest `order` (ties broken
   by `id`, which is a UUID, so the choice is deterministic and repeatable).
2. `AddConstraint` installs `g12f_pageorder_unique_series_page`.

**Blast radius, measured rather than assumed** (read-only `SELECT`s against
the Cloud SQL instance `free2z:us-east1:free2z` on 2026-08-18):

    database   pageorder rows   duplicate (series, page) pairs   rows deleted
    prod                 1153                                0              0
    stage                1150                                0              0
    test                 1150                                0              0

So step 1 is a **no-op on every deployed database today** and step 2 adds a
unique index to a 1153-row table. The dedupe is kept anyway because the API
could still mint a duplicate between that measurement and the moment this
migration runs, and because a migration that only works on data someone
eyeballed once is not a migration.

What this migration deliberately does NOT do: it never removes a page from a
series, and it never touches a row belonging to another creator's series. The
only rows it can delete are *exact repeats of a page inside one and the same
series* -- after it runs, every series still contains exactly the same set of
pages it did before. That is why the "a creator can never modify another
creator's series" rule is not in play here (see the ruling on PR #894).

There is intentionally no `unique(page)` constraint. See the note on
`PageOrder.Meta.constraints`.

Rollout window: Cloud Build migrates before the new pods roll, and an
automatic rollback replaces code without reversing schema, so old serializer
code can run against this constraint. Old code is compatible with it in every
way that matters -- it never wrote the same page twice into one series in
practice (0 such rows have ever existed across prod/stage/test) -- with one
theoretical exception: a payload that names the same page twice would 500 on
an old pod instead of silently writing a duplicate. Accepted rather than
bridged: the only mechanisms that could bridge it (a DB trigger, a deferred
constraint) are precisely the invisible cross-cutting machinery #841 was
reopened to remove.
"""
from django.db import migrations, models


# `AddConstraint` (and, on the way back, `DROP CONSTRAINT`) needs ACCESS
# EXCLUSIVE on g12f_pageorder. The table is tiny (~1.2k rows), so the lock is
# held for milliseconds -- but an ACCESS EXCLUSIVE *request* queues in front
# of every subsequent reader, and `g12f_pageorder` is read on the series strip
# of every zPage view. Bounding the wait means a stuck lock fails this
# migration (retry the deploy) instead of stalling reads site-wide for as long
# as whatever is holding the table. `SET LOCAL` is scoped to the migration's
# own transaction (migrations are atomic on Postgres), so it cannot leak.
# Applied on BOTH directions -- see the trailing RunSQL below.
LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s';"

# Keep the lowest `order`; tie-break on `id` so two runs (or two replicas of
# a rollback/re-apply) delete exactly the same rows.
DEDUPE_SQL = """
DELETE FROM g12f_pageorder po
USING (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY series_id, page_id
            ORDER BY "order" ASC, id ASC
        ) AS rn
    FROM g12f_pageorder
) ranked
WHERE po.id = ranked.id
  AND ranked.rn > 1;
"""


def dedupe_series_page(apps, schema_editor):
    """Delete repeats of one page within one series, keeping the first."""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(DEDUPE_SQL)
        deleted = cursor.rowcount
    # Printed rather than logged: this runs as a Cloud Build step, where
    # stdout is the audit trail. Expected to be 0 everywhere (see docstring);
    # anything else is worth reading.
    print(
        f"g12f.0103: removed {deleted} duplicate PageOrder row(s) "
        "(same page listed twice in the same series)"
    )


class Migration(migrations.Migration):

    dependencies = [
        ('g12f', '0102_backfill_zpage_published_at'),
    ]

    operations = [
        # Forward: bound the wait before anything takes a lock.
        migrations.RunSQL(
            sql=LOCK_TIMEOUT_SQL,
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunPython(
            dedupe_series_page,
            # Irreversible by nature -- the deleted rows were duplicates and
            # are not reconstructable. Reversing the migration only needs to
            # drop the constraint, which `AddConstraint` handles.
            migrations.RunPython.noop,
            elidable=False,
        ),
        migrations.AddConstraint(
            model_name='pageorder',
            constraint=models.UniqueConstraint(
                fields=('series', 'page'),
                name='g12f_pageorder_unique_series_page',
            ),
        ),
        # Reverse: Django replays operations back-to-front, so this LAST
        # operation is the FIRST thing a `migrate g12f 0102` runs -- which is
        # the only way to get the timeout in place before
        # `AddConstraint.database_backwards()` asks for ACCESS EXCLUSIVE to
        # DROP the constraint. Without it the rollback path is exactly the
        # unbounded lock wait the forward path was written to avoid.
        migrations.RunSQL(
            sql=migrations.RunSQL.noop,
            reverse_sql=LOCK_TIMEOUT_SQL,
        ),
    ]
