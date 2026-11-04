from django.db import migrations


class Migration(migrations.Migration):
    """Scan under VALIDATE's write-compatible lock, after 0090 committed."""

    dependencies = [("g12f", "0091_add_zpage_source_language_check")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(
            "ALTER TABLE g12f_zpage VALIDATE CONSTRAINT "
            "g12f_zpage_source_language_not_null;",
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
