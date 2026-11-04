"""
A partial index on procrastinate_jobs.status for the health sweep (#633).

Procrastinate ships indexes for the paths the worker uses (fetch a `todo`
job by priority, the `doing` lock), but nothing that answers "everything
not succeeded". The health sweep asks exactly that, every 5 minutes,
forever -- and `procrastinate_jobs` grows without bound because nothing
prunes succeeded jobs today. Without this index the sweep degrades into a
sequential scan of the whole history table.

Partial rather than full: succeeded rows are the overwhelming majority
and are never selected, so indexing them would cost write amplification on
every single job completion for no read benefit.

Not CONCURRENTLY, and that is deliberate: at this project's job volume the
table is small enough that the ACCESS EXCLUSIVE lock lasts well under a
second, whereas a failed CONCURRENTLY build leaves behind an INVALID index
that `IF NOT EXISTS` would then silently skip on every subsequent run --
a much worse 3am state than a sub-second lock during a deploy. Revisit if
procrastinate_jobs ever reaches millions of rows (at which point job
retention is the real fix).

The table belongs to procrastinate.contrib.django, not to this app, so
this is RunSQL: an index this app owns on a table it does not, guarded by
IF NOT EXISTS so it is safe to re-run and safe if procrastinate ever adds
an equivalent index upstream.
"""
from django.db import migrations

FORWARD = """
CREATE INDEX IF NOT EXISTS procrastinate_jobs_working_set_idx
    ON procrastinate_jobs (status, queue_name)
    WHERE status <> 'succeeded';
"""

REVERSE = """
DROP INDEX IF EXISTS procrastinate_jobs_working_set_idx;
"""


class Migration(migrations.Migration):

    dependencies = [
        ('procrastinate', '0001_initial'),
    ]

    operations = [
        migrations.RunSQL(sql=FORWARD, reverse_sql=REVERSE),
    ]
