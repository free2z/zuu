from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("g12f", "0116_creator_public_profile_updated_at"),
    ]

    operations = [
        # Every authenticated page/translation write inserts into this table,
        # and a plain CREATE INDEX blocks those inserts while it waits for its
        # lock. Bound the wait so a long transaction fails the deploy (which
        # can be retried) instead of queueing creator writes behind it.
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '5s'",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AlterField(
            model_name="zpagemutationactor",
            name="action",
            field=models.CharField(
                choices=[
                    ("source_content", "Canonical content changed"),
                    ("source_language", "Source language changed"),
                    ("variant_content", "Translation content changed"),
                    ("variant_published", "Translation published"),
                    ("variant_unpublished", "Translation unpublished"),
                    ("variant_deleted", "Translation deleted"),
                    ("page_deleted", "Page deleted"),
                    ("ownership_changed", "Page ownership changed"),
                ],
                max_length=32,
            ),
        ),
        migrations.AddIndex(
            model_name="zpagemutationactor",
            index=models.Index(
                fields=["occurred_at"],
                name="g12f_zp_actor_time_idx",
            ),
        ),
        # Reverse runs last-to-first; bound the DROP INDEX the same way.
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout = '5s'",
        ),
    ]
