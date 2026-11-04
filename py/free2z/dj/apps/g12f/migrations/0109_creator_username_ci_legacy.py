"""free2z/zuu#1022, step 1 of 2: the exemption column, on its own.

A separate migration from the index that uses it, so the ``ALTER TABLE`` --
which takes an ACCESS EXCLUSIVE lock and holds it to the end of the
transaction -- commits immediately instead of blocking every read of
``g12f_creator`` while 0110 computes duplicates and builds an index.

A nullable column with no default is metadata-only (no table rewrite), and a
pod still running the previous release, which does not know the column, keeps
inserting accounts with NULL there -- which is inside the new index, as it
should be.

``lock_timeout`` bounds the wait for that ACCESS EXCLUSIVE lock. Without it, a
long-running transaction touching ``g12f_creator`` would make this migration
wait, and every read of the table would queue behind the waiting migration
(codex adversarial review). If the timeout fires, ``migrate`` fails and the
deploy aborts; re-running it is the remedy.
"""

from django.db import migrations, models

LOCK_TIMEOUT = '5s'


def bound_lock_wait(apps, schema_editor):
    if schema_editor.connection.vendor != 'postgresql':
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


class Migration(migrations.Migration):

    dependencies = [
        ('g12f', '0108_creatorfollow'),
    ]

    operations = [
        migrations.RunPython(bound_lock_wait, migrations.RunPython.noop),
        migrations.AddField(
            model_name='creator',
            name='username_ci_legacy',
            field=models.CharField(
                blank=True,
                editable=False,
                max_length=150,
                null=True,
                help_text=(
                    'Legacy case-variant duplicate username this account held '
                    'when case-insensitive uniqueness was enforced. Exempt '
                    'from the index only while the username is unchanged. Set '
                    'only by migration.'
                ),
            ),
        ),
        # Last, so on reverse it runs FIRST, before RemoveField.
        migrations.RunPython(migrations.RunPython.noop, bound_lock_wait),
    ]
