"""``Creator.deleted_at`` / ``username_released_at``: when the holder deleted
the account (self-service account deletion, ``dj.apps.g12f.account_deletion``),
and when its reserved username was freed.

Nullable, no default, no backfill: PostgreSQL adds the columns as a catalog
change without rewriting ``g12f_creator``. It still needs the table's ACCESS
EXCLUSIVE lock for that instant, so ``lock_timeout`` bounds the wait behind a
long transaction: the migration fails and the deploy retries rather than
queueing every request on the table behind it.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("g12f", "0119_creator_member_price_free_not_null"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="creator",
            name="deleted_at",
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name="creator",
            name="username_released_at",
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
    ]
