from django.db import migrations, models


LANGUAGE_CHOICES = [
    ("und", "Undetermined (legacy)"),
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("pt-BR", "Portuguese (Brazil)"),
]


class Migration(migrations.Migration):
    """Use 0091's committed proof for a momentary SET NOT NULL lock."""

    dependencies = [("g12f", "0092_validate_zpage_source_language")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE g12f_zpage ALTER COLUMN "
                    "source_language SET NOT NULL;",
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    "ALTER TABLE g12f_zpage DROP CONSTRAINT "
                    "g12f_zpage_source_language_not_null;",
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="zpage",
                    name="source_language",
                    field=models.CharField(
                        choices=LANGUAGE_CHOICES,
                        db_default="und",
                        default="und",
                        help_text="Language of the canonical title, description and content.",
                        max_length=10,
                    ),
                ),
            ],
        ),
    ]
