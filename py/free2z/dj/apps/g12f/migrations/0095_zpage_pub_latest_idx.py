from django.db import migrations, models


INDEX_NAME = "g12f_zpage_pub_latest_idx"


class Migration(migrations.Migration):
    # PostgreSQL forbids CONCURRENTLY inside a transaction. A retry first drops
    # any complete or invalid leftover index, so a deploy can safely resume
    # after dying between committed DDL and Django's migration record.
    atomic = False

    dependencies = [
        ("g12f", "0094_index_zpage_source_language"),
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
                    "ON g12f_zpage (created_at DESC, id DESC) "
                    "WHERE is_published;",
                    reverse_sql=(
                        f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME};"
                    ),
                ),
            ],
            state_operations=[
                migrations.AddIndex(
                    model_name="zpage",
                    index=models.Index(
                        condition=models.Q(is_published=True),
                        fields=["-created_at", "-id"],
                        name=INDEX_NAME,
                    ),
                ),
            ],
        ),
        migrations.RunSQL(
            "RESET lock_timeout;",
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
