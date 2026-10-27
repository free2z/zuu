"""Token-only unsubscribe URLs (#1154).

`OptOutEmail.link_token` records the unsubscribe token that was spent to create
the row. Unsubscribing deletes the `Email` row, so without it the token-only
link stops resolving the instant it is used -- and the endpoint has to keep
answering afterwards, for the post-unsubscribe redirect and for the RFC 8058
one-click POST that mail providers replay.

`Email.token` gains an index because both link landings look it up by token
alone, which was already true of `/api/emails/confirm` and is now true of
unsubscribe too.

LOCKING, honestly (two rounds of codex review corrected comfier versions of
this note). Both operations take an ACCESS EXCLUSIVE lock, held until this
atomic migration commits, and neither index is built CONCURRENTLY. That lock
conflicts with everything, **reads included** -- while this runs, confirm,
unsubscribe, address change and password recovery all queue behind it. A
NULL-defaulted `ADD COLUMN` needs no table rewrite on PostgreSQL 11+, but both
index builds still scan every existing row, including the ones whose new value
is NULL.

Accepted rather than engineered around, because of table size: `emails_email`
holds at most one row per account and `emails_optoutemail` one per unsubscribed
address, so this is a scan of tens of thousands of narrow rows -- milliseconds.
`AddIndexConcurrently` would need `atomic = False` and a migration that cannot
roll back as a unit, which is the wrong trade here.

The `lock_timeout` below is the part that does not depend on that estimate
being right. `migrate` is a Cloud Build step the deploy waits on, so a
migration that blocks on a lock does not just run slowly -- it holds the whole
release, potentially to the build timeout, while requests pile up behind it.
`SET LOCAL` scopes the timeout to this transaction (so no later migration
inherits it), and 10s turns "the deploy is wedged and nobody knows why" into a
fast, loud, retryable failure. If it ever fires, look for a long-running
transaction on these tables, not at this migration.
"""
from django.db import migrations, models

#: Long enough that no healthy system notices, short enough that an unhealthy
#: one fails while a human is still watching the build.
LOCK_TIMEOUT = '10s'


def set_lock_timeout(apps, schema_editor):
    """Bound how long the DDL below may wait for its ACCESS EXCLUSIVE lock.

    Postgres only: `lock_timeout` does not exist on sqlite, which is what a
    developer who forgets to export DBHOST is running against.
    """
    if schema_editor.connection.vendor != 'postgresql':
        return
    schema_editor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


class Migration(migrations.Migration):

    dependencies = [
        ('emails', '0006_passwordresettoken'),
    ]

    operations = [
        # Fail fast instead of wedging the deploy behind a lock. See above.
        migrations.RunPython(set_lock_timeout, migrations.RunPython.noop),
        migrations.AddField(
            model_name='optoutemail',
            name='link_token',
            field=models.CharField(blank=True, max_length=100, null=True, unique=True),
        ),
        migrations.AlterField(
            model_name='email',
            name='token',
            field=models.CharField(db_index=True, max_length=100),
        ),
    ]
