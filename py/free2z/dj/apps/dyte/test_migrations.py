"""Online-safety and reversibility checks for the lifecycle schema squash."""
import uuid

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader

from dj.apps.dyte.models import CreatorMeeting


BEFORE = ("dyte", "0010_creatormeeting_host_session")
LIFECYCLE = ("dyte", "0011_stream_lifecycle_schema")
LEAF = ("dyte", "0013_recording_creator_id_snapshot")


def _migrate_to_leaves():
    MigrationExecutor(connection).migrate(
        MigrationLoader(connection).graph.leaf_nodes(),
    )


@pytest.mark.django_db(transaction=True)
def test_lifecycle_schema_migrates_both_ways_and_old_inserts_get_db_defaults(
    creator_factory,
):
    """Model old pods during rollout after the additive schema is installed."""
    creator = creator_factory(username=f"migration-{uuid.uuid4().hex[:8]}")
    try:
        executor = MigrationExecutor(connection)
        executor.migrate([BEFORE])
        old_apps = executor.loader.project_state([BEFORE]).apps
        OldCreatorMeeting = old_apps.get_model("dyte", "CreatorMeeting")
        before_id = OldCreatorMeeting.objects.create(
            creator_id=creator.pk,
            meeting_id=f"before-{uuid.uuid4()}",
        ).pk

        MigrationExecutor(connection).migrate([LIFECYCLE])

        # The prior release's model does not name any new columns. This insert
        # happens after AddField, while old and new pods overlap in rollout.
        OldCreatorMeeting.objects.create(
            creator_id=creator.pk,
            meeting_id=f"during-{uuid.uuid4()}",
            meeting_type="broadcast",
        )
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT lifecycle_state, handshake_managed, "
                "provider_room_cleanup_claimed, create_unknown_attempts "
                "FROM dyte_creatormeeting WHERE creator_id = %s "
                "ORDER BY id",
                [creator.pk],
            )
            rows = cursor.fetchall()
        assert len(rows) >= 2
        assert all(row == ("offline", False, False, 0) for row in rows)

        MigrationExecutor(connection).migrate([LEAF])
        assert CreatorMeeting.objects.filter(
            pk=before_id,
        ).exists()

        # Reverse all three schema/data migrations. Old rows survive and the
        # old model can still read them after its columns and target tables
        # have been removed.
        MigrationExecutor(connection).migrate([BEFORE])
        old_apps = MigrationExecutor(connection).loader.project_state([BEFORE]).apps
        OldCreatorMeeting = old_apps.get_model("dyte", "CreatorMeeting")
        assert OldCreatorMeeting.objects.filter(pk=before_id).exists()
    finally:
        _migrate_to_leaves()
