from django.db import migrations, models


LANGUAGE_CHOICES = [
    ("und", "Undetermined (legacy)"),
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("pt-BR", "Portuguese (Brazil)"),
]

INDEX_NAME = "g12f_zpage_source_language_3551cc99"


class Migration(migrations.Migration):
    # PostgreSQL forbids CONCURRENTLY inside a transaction. A retry first drops
    # any complete or invalid leftover index, so even the narrow crash window
    # between committed DDL and Django's migration record is recoverable.
    atomic = False

    dependencies = [("g12f", "0093_require_zpage_source_language")]

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
                    "ON g12f_zpage (source_language);",
                    reverse_sql=(
                        f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME};"
                    ),
                ),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="zpage",
                    name="source_language",
                    field=models.CharField(
                        choices=LANGUAGE_CHOICES,
                        db_default="und",
                        db_index=True,
                        default="und",
                        help_text="Language of the canonical title, description and content.",
                        max_length=10,
                    ),
                ),
            ],
        ),
        migrations.RunSQL(
            "RESET lock_timeout;",
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
