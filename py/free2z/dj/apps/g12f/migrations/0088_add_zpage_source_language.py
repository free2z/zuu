from django.db import migrations, models


LANGUAGE_CHOICES = [
    ("und", "Undetermined (legacy)"),
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("pt-BR", "Portuguese (Brazil)"),
]


class Migration(migrations.Migration):
    """Install the rolling-deploy compatibility column as one atomic step.

    This deliberately contains only fast DDL. If its three-second lock budget
    expires, PostgreSQL rolls the whole migration back, so the next deploy can
    retry it safely. The database default is installed before this migration is
    recorded so old application pods that omit the column create rows whose
    language is honestly undetermined while the later batched backfill runs.
    """

    dependencies = [("g12f", "0087_zpage_canonical_url")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="zpage",
            name="source_language",
            field=models.CharField(
                choices=LANGUAGE_CHOICES,
                help_text="Language of the canonical title, description and content.",
                max_length=10,
                null=True,
            ),
        ),
        migrations.RunSQL(
            "ALTER TABLE g12f_zpage ALTER COLUMN "
            "source_language SET DEFAULT 'und';",
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
