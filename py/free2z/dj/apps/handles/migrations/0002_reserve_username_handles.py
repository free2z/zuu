"""Reserve ``lowercase(username)`` for every eligible existing account.

The collision policy is ``dj.apps.handles.reservation.reserve_username_handles``
-- oldest account first (``date_joined``, then ``id``), so in a case-variant
group the earliest-created account gets the handle and the rest are left
unclaimed. Ineligible usernames and reserved words get nothing. No username is
read for anything but this, and none is changed.

Imports ``policy``/``reservation`` rather than copying them, which is safe here
only because both modules are ORM-free and take the (historical) models as
arguments. ``manage.py handle_census`` reports what this will do before it
runs, and ``handle_census --apply`` repeats it idempotently.

Reverse: **a no-op. No row is ever deleted by a rollback.** Once the handle
authority is live, any binding may already be published in the
key-transparency log, and a retired row is the only thing stopping its handle
from being issued to somebody else. Deleting the username-sourced rows and
re-applying would re-derive handles from *current* usernames: a retired
handle, or one whose owner has since renamed, would go to a new account
(adversarial review of #1874). ``handles`` 0001's reverse refuses to drop a
non-empty table for the same reason; see ``docs/e2ee/handles.md``.
"""

from django.db import migrations

from dj.apps.handles.reservation import reserve_username_handles

LOCK_TIMEOUT = '5s'
#: One pass over g12f_creator plus batched inserts; seconds at production size.
STATEMENT_TIMEOUT = '60s'


def reserve(apps, schema_editor):
    if schema_editor.connection.vendor == 'postgresql':
        with schema_editor.connection.cursor() as cursor:
            cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
            cursor.execute(
                f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'"
            )
    reserve_username_handles(
        apps.get_model('g12f', 'Creator'),
        apps.get_model('handles', 'MessagingHandle'),
        using=schema_editor.connection.alias,
    )


class Migration(migrations.Migration):

    dependencies = [
        ('handles', '0001_initial'),
        # Not needed for correctness; it orders the plan so the username
        # index (same "earliest account wins" rule) lands first.
        ('g12f', '0110_creator_username_ci_unique'),
    ]

    operations = [
        migrations.RunPython(reserve, migrations.RunPython.noop),
    ]
