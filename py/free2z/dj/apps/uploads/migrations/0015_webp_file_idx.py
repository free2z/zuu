# #2115: index `uploads_webp.file`.
#
# Every upload now asks `tasks._has_live_file_reference` whether its storage
# key is referenced by ANY FileField on the upload storage (#2105), and the
# nginx auth subrequest (`views._get_generic_file`) resolves a served name
# through `Webp.objects.get(file=...)` whenever it is not a GenericFile. Both
# were a sequential scan of this table; GenericFile and ImageVariant already
# index `file`.
#
# The table is bounded by GenericFile (one legacy thumbnail per parent,
# OneToOne): ~23k rows when 0014 was written. Small enough that a plain
# CREATE INDEX would take its SHARE lock for well under a second -- but
# CONCURRENTLY costs nothing here and never blocks the thumbnail writers,
# and it is this repo's established pattern (g12f 0094/0095).
#
# PostgreSQL forbids CONCURRENTLY inside a transaction, hence atomic=False.
# A failed concurrent build leaves an INVALID index behind; the leading
# DROP ... IF EXISTS makes a re-run of the deploy clean that up and retry,
# including the narrow window where the DDL committed but Django's
# migration record did not.

from django.db import migrations, models


INDEX_NAME = "uploads_webp_file_idx"


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("uploads", "0014_genericfile_file_unique"),
    ]

    operations = [
        migrations.RunSQL(
            "SET lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME};",
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    f"CREATE INDEX CONCURRENTLY {INDEX_NAME} "
                    "ON uploads_webp (file);",
                    reverse_sql=(
                        f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME};"
                    ),
                ),
            ],
            state_operations=[
                migrations.AddIndex(
                    model_name="webp",
                    index=models.Index(fields=["file"], name=INDEX_NAME),
                ),
            ],
        ),
        migrations.RunSQL(
            "RESET lock_timeout;",
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
