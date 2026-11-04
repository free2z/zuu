"""g12f 0119: NULL member_price -> 0 (free), then NOT NULL default 10.

Real Postgres, Django's own ``MigrationExecutor``, rolled back to 0118 and
forward again. The rows are written through the 0118 historical model -- the
old release -- including one with an avatar FK set, so the single-transaction
UPDATE + ALTER is proven not to hit "pending trigger events".
"""

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader

BEFORE = ("g12f", "0118_drop_legacy_drf_authtoken_table")
AFTER = ("g12f", "0119_creator_member_price_free_not_null")


def _migrate(target):
    executor = MigrationExecutor(connection)
    executor.migrate([target])
    return executor.loader.project_state([target]).apps


def _migrate_to_leaves():
    MigrationExecutor(connection).migrate(
        MigrationLoader(connection).graph.leaf_nodes())


def _column():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_name = 'g12f_creator' AND column_name = 'member_price'"
        )
        return cursor.fetchone()[0]


@pytest.mark.django_db(transaction=True)
def test_backfill_null_to_zero_then_not_null_and_back():
    try:
        old = _migrate(BEFORE)
        Creator = old.get_model("g12f", "Creator")
        GenericFile = old.get_model("uploads", "GenericFile")
        unpriced = Creator.objects.create(
            username="unpriced-2510", member_price=None)
        priced = Creator.objects.create(
            username="priced-2510", member_price=25)
        with_fk = Creator.objects.create(
            username="fk-2510", member_price=None)
        avatar = GenericFile.objects.create(owner=with_fk)
        Creator.objects.filter(pk=with_fk.pk).update(avatar_image=avatar)
        assert _column() == "YES"

        new = _migrate(AFTER)
        assert _column() == "NO"
        NewCreator = new.get_model("g12f", "Creator")
        prices = dict(
            NewCreator.objects.filter(
                pk__in=[unpriced.pk, priced.pk, with_fk.pk]
            ).values_list("username", "member_price"))
        assert prices == {
            "unpriced-2510": 0, "priced-2510": 25, "fk-2510": 0}
        # NOT NULL is real at the database level.
        with pytest.raises(IntegrityError), transaction.atomic():
            NewCreator.objects.filter(pk=priced.pk).update(member_price=None)

        # Reverse: nullable again, the backfilled 0s stay (a valid price
        # under both schemas).
        old = _migrate(BEFORE)
        assert _column() == "YES"
        OldCreator = old.get_model("g12f", "Creator")
        assert OldCreator.objects.get(pk=unpriced.pk).member_price == 0
        OldCreator.objects.filter(pk=priced.pk).update(member_price=None)
    finally:
        _migrate_to_leaves()
    # Forward again over a NULL written after the rollback.
    from dj.apps.g12f.models import Creator as LiveCreator
    assert LiveCreator.objects.get(pk=priced.pk).member_price == 0
