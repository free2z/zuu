"""Drop the superseded `vector_l2_ops` HNSW index (#1557).

Second half of the operator-class swap; `0002_hnsw_cosine_opclass` explains
why the build and the drop are two migrations rather than two operations in
one. By the time this runs, `searchindex_vector_cos_idx` is committed and
serving, so the L2 index answers nothing: no query in this codebase uses the
`<->` operator.

This is the read-blocking half. `DROP INDEX` takes `ACCESS EXCLUSIVE` on
`search_searchindex`, held until this transaction commits -- but this
transaction does nothing else, so the window is the drop itself rather than a
multi-second index build. `lock_timeout = 5s` keeps a slow transaction from
convoying `/related/` and `?search=` behind the migration's queued lock
request; nothing writes this table but the indexing task, so waiting five
seconds is already anomalous, and failing is better than stalling the API.

Failure here is recoverable by re-running: 0002 stays recorded, so a retry
resumes at the drop instead of rebuilding. The interim state -- both indexes
present -- is correct, just 31MB and some write amplification more expensive
than it needs to be.
"""

from django.db import migrations

BOUNDS = """
SET LOCAL lock_timeout = '5s';
"""


class Migration(migrations.Migration):

    dependencies = [
        ('search', '0002_hnsw_cosine_opclass'),
    ]

    operations = [
        migrations.RunSQL(sql=BOUNDS, reverse_sql=migrations.RunSQL.noop),
        migrations.RemoveIndex(
            model_name='searchindex',
            name='searchindex_vector_hnsw_idx',
        ),
        migrations.RunSQL(sql=migrations.RunSQL.noop, reverse_sql=BOUNDS),
    ]
