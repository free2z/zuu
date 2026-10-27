from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("g12f", "0095_zpage_pub_latest_idx"),
    ]

    operations = [
        # ALTER COLUMN needs an ACCESS EXCLUSIVE lock. Fail this deploy attempt
        # instead of waiting behind live traffic indefinitely; Cloud Build can
        # retry once the brief contention clears.
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AlterField(
            model_name="creator",
            name="total",
            field=models.DecimalField(
                decimal_places=8,
                default=0,
                max_digits=20,
            ),
        ),
        # Reverse operations run bottom-up. Set the same bound before Django
        # attempts the narrowing ALTER during an emergency rollback.
        migrations.RunSQL(
            migrations.RunSQL.noop,
            reverse_sql="SET LOCAL lock_timeout = '3s';",
        ),
    ]
