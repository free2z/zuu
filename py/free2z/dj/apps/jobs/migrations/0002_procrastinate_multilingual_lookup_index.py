"""Index the reconciliation command's latest multilingual-job lookup.

The reconciliation runs against the live database after successful deploys.
Keep the lookup on the task name, JSON zPage ID, and newest job ID so a page
does not scan the unbounded procrastinate job history. This deliberately uses
the same ordinary CREATE INDEX design as 0001: the table is small enough for a
sub-second lock, while a failed concurrent build could leave an INVALID index
that IF NOT EXISTS would silently preserve forever. The defensive catalog check
removes only that invalid leftover before the ordinary transactional build; a
valid existing index remains reusable.
"""
from django.db import migrations


FORWARD = """
DO $$
BEGIN
    -- A pre-migration attempt may have used CREATE INDEX CONCURRENTLY. If it
    -- was interrupted, PostgreSQL leaves an INVALID index behind and
    -- CREATE INDEX IF NOT EXISTS would otherwise accept it as "done".
    IF EXISTS (
        SELECT 1
        FROM pg_class AS index_class
        JOIN pg_index AS index_meta ON index_meta.indexrelid = index_class.oid
        WHERE index_class.relname = 'procrastinate_multilingual_zpage_lookup_idx'
          AND NOT index_meta.indisvalid
    ) THEN
        EXECUTE 'DROP INDEX procrastinate_multilingual_zpage_lookup_idx';
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS procrastinate_multilingual_zpage_lookup_idx
    ON procrastinate_jobs (task_name, (args ->> 'zpage_id'), id DESC)
    WHERE task_name = 'search.index_multilingual_zpage';
"""

REVERSE = """
DROP INDEX IF EXISTS procrastinate_multilingual_zpage_lookup_idx;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("jobs", "0001_procrastinate_status_index"),
    ]

    operations = [
        migrations.RunSQL(sql=FORWARD, reverse_sql=REVERSE),
    ]
