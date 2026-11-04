from django.db import migrations, models


class Migration(migrations.Migration):
    """Add the rollout-safe nullable publication timestamp column.

    PostgreSQL can add this nullable column without rewriting the table, but
    it still needs an ACCESS EXCLUSIVE lock. Keep the migration atomic and
    bound that wait: if live traffic holds an incompatible lock, this deploy
    rolls back cleanly and can retry rather than queueing every later zPage
    query behind a pending ALTER TABLE.
    """

    dependencies = [("g12f", "0100_backfill_zpage_variants")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="zpage",
            name="published_at",
            field=models.DateTimeField(
                blank=True,
                null=True,
            ),
        ),
        # Reverse operations run bottom-up. Apply the same bound before an
        # emergency rollback tries to take ACCESS EXCLUSIVE to drop the
        # column. Because this migration is atomic, SET LOCAL never leaks to
        # a later migration or a pooled test connection.
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout = '3s';",
        ),
    ]
