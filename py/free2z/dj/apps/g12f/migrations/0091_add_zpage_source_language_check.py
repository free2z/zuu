from django.db import migrations


class Migration(migrations.Migration):
    """Install an unvalidated proof constraint in a short transaction."""

    dependencies = [("g12f", "0090_zpage_translation")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(
            "ALTER TABLE g12f_zpage ADD CONSTRAINT "
            "g12f_zpage_source_language_not_null "
            "CHECK (source_language IS NOT NULL) NOT VALID;",
            reverse_sql=(
                "ALTER TABLE g12f_zpage DROP CONSTRAINT IF EXISTS "
                "g12f_zpage_source_language_not_null;"
            ),
        ),
    ]
