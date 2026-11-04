"""``Creator.member_price``: NULL -> 0 (free membership), then NOT NULL default 10 (#2510).

Owner decision (Skylar, 2026-10-06): ``0`` is a FREE membership (a free
follow that still grants member access and moves no 2Z), new creators default
to 10 2Z / 30 days, and every creator whose price was NULL ("no membership
offered") becomes free. The owner accepted that this makes those creators'
members-only content reachable by anyone who follows them for free.

Two steps, ONE transaction:

1. ``backfill_null_to_zero`` -- ``UPDATE ... SET member_price = 0 WHERE
   member_price IS NULL``.
2. ``AlterField`` to ``NOT NULL`` (``ALTER COLUMN ... SET NOT NULL``; a scan
   of ``g12f_creator``, ~1.8k rows in prod, i.e. milliseconds).

They share a transaction, and the table's ACCESS EXCLUSIVE lock is taken
BEFORE the UPDATE. Otherwise a pre-#2510 pod still serving during the rollout
could PATCH ``member_price: null`` onto some other row between the two, and
Django's ``AlterField`` null -> NOT NULL fills remaining NULLs with the field
default -- that creator would come out charging **10**, not free.

Accepted rollout cost (codex review, recorded in the PR): after this commits,
a pre-#2510 pod that saves ``member_price: null`` (old Settings with the price
field emptied) gets an IntegrityError 500 until its pod is replaced -- and
for as long as an image older than this one serves, e.g. after a rollback.
Nothing is charged by that failure; the save is simply refused.

The UPDATE touches only a non-key column, so PostgreSQL queues no deferred
FK trigger events and the ALTER cannot hit "pending trigger events".

The UPDATE fires ``0116``'s trigger, so backfilled creators get a fresh
``public_profile_updated_at``: their public profile genuinely changed
(membership became free).

``g12f_creator`` is read by every authenticated request, so both the lock
waits and the statements are bounded (``bound``, the ``events/0014`` pattern):
hitting a bound aborts this migration and fails the deploy at Cloud Build's
``migrate`` step, before anything is applied. Re-run the deploy; do not remove
the bound.

Reverse: the column becomes nullable again (default 10); the backfill is not
undone -- which creators were NULL is not recorded, and 0 is a valid price
under both schemas.
"""

import django.core.validators
from django.db import migrations, models

LOCK_TIMEOUT = "5s"
STATEMENT_TIMEOUT = "60s"


def bound(apps, schema_editor):
    """Bound lock waits and statements for this migration's transaction."""
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
    schema_editor.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")


def backfill_null_to_zero(apps, schema_editor):
    # Take the ALTER's ACCESS EXCLUSIVE lock FIRST (codex review). Row locks
    # from the UPDATE alone would not stop an old pod from writing a NEW NULL
    # into an unlocked row before the ALTER, which Django's AlterField would
    # then fill with the default -- 10, not free. The ALTER needs this lock
    # anyway, so taking it earlier adds no new kind of stall; it is bounded
    # by LOCK_TIMEOUT and held for milliseconds (~1.8k rows).
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute(
            "LOCK TABLE g12f_creator IN ACCESS EXCLUSIVE MODE")
    Creator = apps.get_model("g12f", "Creator")
    Creator.objects.filter(member_price__isnull=True).update(member_price=0)


class Migration(migrations.Migration):

    atomic = True

    dependencies = [
        ('g12f', '0118_drop_legacy_drf_authtoken_table'),
    ]

    operations = [
        migrations.RunPython(bound, bound),
        migrations.RunPython(
            backfill_null_to_zero, migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name='creator',
            name='member_price',
            field=models.DecimalField(
                decimal_places=0,
                default=10,
                help_text=(
                    '2Z for 30 days of membership, livestream access, etc. '
                    '0 means a free membership (a free follow).'
                ),
                max_digits=6,
                validators=[django.core.validators.MinValueValidator(0)],
            ),
        ),
        migrations.RunPython(bound, bound),
    ]
