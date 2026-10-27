"""free2z/zuu#1022, step 2 of 2: case-insensitive usernames, in the database.

What it does
------------

1. Takes ``SHARE ROW EXCLUSIVE`` on ``g12f_creator``: reads carry on, writes
   wait. Without it, an account created between step 2 and step 3 whose
   username case-collides with an existing one (the serializers check first,
   but cannot stop two concurrent requests) would make step 3 fail, and a
   failed ``migrate`` aborts the whole deploy. ``lock_timeout`` bounds the wait
   for the lock itself, so the migration fails fast rather than queueing every
   writer on the site behind a long-running transaction; re-running the deploy
   is the remedy. ``statement_timeout`` (30s per statement, so ~60s for the two
   statements that run under the lock) bounds the UPDATE and the index build
   the same way, so a slow database aborts the migration instead of pausing
   account writes indefinitely. ``CREATE INDEX`` would take a SHARE lock anyway, so this
   extends the write pause by the duration of one UPDATE, not by the index
   build.
2. Records, on every account **except the earliest** (``date_joined``, then
   ``id``) in each group of usernames equal under ``LOWER()``, its current
   username in ``username_ci_legacy``. No username is edited, nothing is
   deleted.
3. Builds ``creator_username_ci_unique``: ``UNIQUE (LOWER(username)) WHERE
   username_ci_legacy IS NULL OR username_ci_legacy <> username``. Exactly one
   account per group is inside the index, so it builds over the existing
   duplicates. Every account created from now on is inside it, and so is an
   exempt account the moment it renames.

What the index does NOT guarantee, stated exactly. Inside a legacy group only
the winner is in the index, so the group's name is protected by the database
only while the winner holds it:

* If the winner renames away (or is deleted), the database accepts **one** new
  account, or rename, into that folded name alongside the remaining exempt
  rows. Only the ``username__iexact`` checks in the serializers and the admin
  form stop it, and those cannot stop two concurrent requests.
* An exempt account that renames away and later back to its exact legacy
  name is exempt again, with the same caveat.

Both are bounded to the handful of legacy groups and disappear once the
exemptions are retired (``docs/e2ee/handles.md``). Everywhere else -- every
name that is not a legacy group's -- the database refuses duplicates from any
code path.

Why not a plain ``UniqueConstraint(Lower("username"))``: PostgreSQL has no
``NOT VALID`` form of a unique index, and the plain index cannot be built while
production holds duplicates. Resolving those means renaming real accounts,
which is the owner's call, not a migration's. When they are resolved,
``docs/e2ee/handles.md`` has the follow-up that drops the condition.

Reversible: the reverse drops the index and clears the column (0109's reverse
then drops the column).

The earliest account keeping the name is the same rule messaging handles use
(``dj.apps.handles`` migration 0002), so the account inside this index is the
one that holds the lowercase handle.
"""

from django.db import migrations, models
from django.db.models.functions import Lower

LOCK_TIMEOUT = '10s'
#: Per statement. The lock is held across exactly two statements (the UPDATE
#: and the index build), so account writes pause for at most ~60s plus the
#: 10s lock wait before the migration aborts, rolls back and releases the
#: lock. Both take seconds at production table size.
STATEMENT_TIMEOUT = '30s'


def set_timeouts(apps, schema_editor):
    if schema_editor.connection.vendor != 'postgresql':
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
        cursor.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")


def mark_legacy_duplicates(apps, schema_editor):
    connection = schema_editor.connection
    if connection.vendor != 'postgresql':
        return
    table = schema_editor.quote_name(
        apps.get_model('g12f', 'Creator')._meta.db_table
    )
    set_timeouts(apps, schema_editor)
    with connection.cursor() as cursor:
        cursor.execute(f'LOCK TABLE {table} IN SHARE ROW EXCLUSIVE MODE')
        cursor.execute(
            f"""
            UPDATE {table} AS c
               SET username_ci_legacy = c.username
              FROM (
                    SELECT id,
                           row_number() OVER (
                               PARTITION BY lower(username)
                               ORDER BY date_joined, id
                           ) AS rn
                      FROM {table}
                   ) AS ranked
             WHERE c.id = ranked.id
               AND ranked.rn > 1
               AND c.username_ci_legacy IS NULL
            """
        )


def clear_legacy_duplicates(apps, schema_editor):
    Creator = apps.get_model('g12f', 'Creator')
    Creator._default_manager.using(schema_editor.connection.alias).filter(
        username_ci_legacy__isnull=False
    ).update(username_ci_legacy=None)


class Migration(migrations.Migration):

    dependencies = [
        ('g12f', '0109_creator_username_ci_legacy'),
    ]

    operations = [
        migrations.RunPython(mark_legacy_duplicates, clear_legacy_duplicates),
        migrations.AddConstraint(
            model_name='creator',
            constraint=models.UniqueConstraint(
                Lower('username'),
                condition=(
                    models.Q(username_ci_legacy__isnull=True)
                    | ~models.Q(username_ci_legacy=models.F('username'))
                ),
                name='creator_username_ci_unique',
                violation_error_message=(
                    'A user with that username already exists!'
                ),
            ),
        ),
        # Last, so on reverse it runs FIRST: timeouts before the index drop.
        migrations.RunPython(migrations.RunPython.noop, set_timeouts),
    ]
