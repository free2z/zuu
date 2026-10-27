"""Regression coverage for the rollout-sensitive 0003 data operation."""

import importlib

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from taggit.models import Tag

from dj.apps.tagging.models import TagAlias, tag_key


@pytest.mark.django_db(transaction=True)
def test_0003_backfill_is_idempotent_and_repairs_legacy_empty_aliases():
    migration = importlib.import_module(
        "dj.apps.tagging.migrations.0003_tag_identity_and_alias_slug"
    )
    # Other migration integration tests temporarily move one app backwards.
    # Restore the complete graph before using the live models; targeting only
    # the tagging leaf can leave its dependency-created TagAlias table absent
    # when this test runs after one of those dances.
    executor = MigrationExecutor(connection)
    executor.migrate(MigrationLoader(connection).graph.leaf_nodes())
    historical_apps = executor.loader.project_state(
        [("tagging", "0003_tag_identity_and_alias_slug")],
        at_end=True,
    ).apps
    HistoricalTagAlias = historical_apps.get_model("tagging", "TagAlias")
    HistoricalTagIdentity = historical_apps.get_model(
        "tagging", "TagIdentity"
    )
    tag = Tag.objects.bulk_create([Tag(name="Migration Source")])[0]
    TagAlias.objects.bulk_create([
        TagAlias(
            name="Legacy Alias",
            name_key="stale legacy key",
            slug="",
            canonical=tag,
        ),
        TagAlias(
            name="!!!",
            name_key=tag_key("!!!"),
            slug="",
            canonical=tag,
        ),
    ])

    with connection.schema_editor() as schema_editor:
        migration.populate_tag_identity(historical_apps, schema_editor)
    first = list(
        HistoricalTagIdentity.objects.values_list(
            "tag_id", "name_key", "slug"
        )
    )
    first_alias = list(
        HistoricalTagAlias.objects.values_list("name", "name_key", "slug")
    )

    # A retry after a killed deploy must not hit the one-to-one identity
    # constraint or leave a different projection on the second pass.
    with connection.schema_editor() as schema_editor:
        migration.populate_tag_identity(historical_apps, schema_editor)

    assert list(
        HistoricalTagIdentity.objects.values_list("tag_id", "name_key", "slug")
    ) == first
    assert list(
        HistoricalTagAlias.objects.values_list("name", "name_key", "slug")
    ) == first_alias
    assert first_alias == [
        ("!!!", tag_key("!!!"), ""),
        ("Legacy Alias", tag_key("Legacy Alias"), "legacy-alias"),
    ]


@pytest.mark.django_db(transaction=True)
def test_0003_schema_operations_are_retryable_after_ddl_commits():
    """A failed non-atomic backfill must not wedge the next deploy."""
    migration = importlib.import_module(
        "dj.apps.tagging.migrations.0003_tag_identity_and_alias_slug"
    )
    executor = MigrationExecutor(connection)
    before = executor.loader.project_state(
        [("tagging", "0002_tagalias_normalization_run")],
        at_end=True,
    )
    after = executor.loader.project_state(
        [("tagging", "0003_tag_identity_and_alias_slug")],
        at_end=True,
    )

    # Simulate the second invocation after AddField and CreateModel committed
    # but before the migration was recorded. Both operations must be harmless
    # when the executor replays them from the 0002 state.
    with connection.schema_editor() as schema_editor:
        for operation in migration.Migration.operations[:2]:
            operation.database_forwards(
                "tagging", schema_editor, before, after
            )
