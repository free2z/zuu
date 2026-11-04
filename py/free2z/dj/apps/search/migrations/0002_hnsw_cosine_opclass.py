"""Build a `vector_cosine_ops` HNSW index on SearchIndex.vector (#1557).

The existing index is `vector_l2_ops`, which answers only the `<->` (L2)
operator. Every query we actually run sorts by `CosineDistance` -- `<=>` -- so
the planner could never use it, and `/api/zpage/<addr>/related/` sequentially
scanned every published zPage computing a 1536-dimension cosine per row on
each article view. Measured plan before this change: `Seq Scan on g12f_zpage`,
3,999 correlated SubPlan executions, ~25k buffers, 16.7 ms median.

This changes no ranking. text-embedding-3-small returns unit vectors, and for
unit vectors ||a-b||^2 == 2 - 2*cos(a,b) is monotone in cosine distance, so
the two operator classes order identically. Only the planner's ability to see
that changes.

**Adding is one migration and dropping the old index is the next one**
(`0003_drop_l2_hnsw_index`), on purpose. Doing both in one migration means
doing both in one transaction, and that is a lock-upgrade deadlock waiting to
happen: this migration holds `SHARE` for the ~3 second build, a concurrent
`search.index_zpage` write queues its `ROW EXCLUSIVE` behind that `SHARE`, and
the `DROP`'s `ACCESS EXCLUSIVE` then queues behind the writer. Each waits on
the other, the deadlock detector fires after a second, and it may well pick
the migration -- failing `manage.py migrate` and, with it, the whole release.
Two transactions, most-restrictive-lock-last-and-alone, has no such cycle.

It also gives the better failure mode: if 0003 fails, 0002 is already recorded
and the retry starts from the drop rather than replaying a `CREATE INDEX` that
would now collide with itself.

Not CONCURRENTLY, following the reasoning already recorded in
`jobs/0001_procrastinate_status_index`: `search_searchindex` holds ~3.9k rows,
and a full HNSW build at that cardinality measured **3.1 seconds** on a local
pgvector 0.8.5 / PG16 fixture at 4,000 rows (allow a few times that on Cloud
SQL's smaller CPU). `CREATE INDEX` takes `SHARE`, which conflicts with writes
but NOT with reads: `/related/` and `?search=` keep answering throughout,
served by the old L2 index. So CONCURRENTLY would buy only the write lock on a
table written by one background task -- and it costs a non-atomic migration
whose failure leaves an INVALID index behind. Revisit if this table ever
reaches millions of rows.

`lock_timeout = 5s` bounds the wait for `SHARE` rather than convoying behind a
slow transaction: a lock request queues *ahead* of later readers, so an
unbounded wait blocks them too. `statement_timeout = 60s` is ~20x the measured
build; slower than that means the instance is unwell, not the plan. Either
firing aborts this migration, which fails the Cloud Build APPLY step -- a
loud, retryable red deploy that leaves the old index exactly as it was.
"""

import pgvector.django.indexes
from django.db import migrations

# `SET LOCAL` scopes these to this migration's transaction (Django wraps each
# migration in one on PostgreSQL), so nothing leaks into later migrations or
# into the connection. Listed first and last so the reverse migration, which
# replays operations backwards, is guarded too.
BOUNDS = """
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
"""


class Migration(migrations.Migration):

    dependencies = [
        ('contenttypes', '0002_remove_content_type_name'),
        ('search', '0001_initial'),
    ]

    operations = [
        migrations.RunSQL(sql=BOUNDS, reverse_sql=migrations.RunSQL.noop),
        migrations.AddIndex(
            model_name='searchindex',
            index=pgvector.django.indexes.HnswIndex(
                ef_construction=64,
                fields=['vector'],
                m=16,
                name='searchindex_vector_cos_idx',
                opclasses=['vector_cosine_ops'],
            ),
        ),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=BOUNDS),
    ]
