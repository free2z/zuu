"""Actual PostgreSQL migration: legacy preservation and safe new defaults."""
import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor


@pytest.mark.django_db(transaction=True)
def test_forced_tool_choice_migration_preserves_legacy_rows_and_defaults_new_rows():
    before = [("openai", "0032_tools_require_effort_none")]
    after = [("openai", "0033_aimodel_forced_tool_choice")]
    executor = MigrationExecutor(connection)
    leaves = executor.loader.graph.leaf_nodes()
    try:
        executor.migrate(before)
        old_model = executor.loader.project_state(before).apps.get_model("openai", "AIModel")
        old = old_model.objects.create(model="legacy-tools", provider="openai", supports_tools=True, max_tokens=4096)
        old_stamp = old.updated_at
        executor = MigrationExecutor(connection)
        executor.migrate(after)
        model = executor.loader.project_state(after).apps.get_model("openai", "AIModel")
        legacy = model.objects.get(pk=old.pk)
        assert legacy.supports_forced_tool_choice is None
        assert legacy.updated_at == old_stamp
        assert legacy.supports_tools is True
        assert model.objects.create(model="new-tools", provider="openai", max_tokens=4096).supports_forced_tool_choice is False
        with connection.cursor() as cursor:
            cursor.execute("SELECT column_default FROM information_schema.columns WHERE table_name='openai_aimodel' AND column_name='supports_forced_tool_choice'")
            assert cursor.fetchone()[0] == "false"
        legacy.supports_forced_tool_choice = False
        legacy.save()
        legacy.refresh_from_db()
        assert legacy.supports_forced_tool_choice is False
        MigrationExecutor(connection).migrate(before)
        executor = MigrationExecutor(connection)
        executor.migrate(after)
        model = executor.loader.project_state(after).apps.get_model("openai", "AIModel")
        assert model.objects.get(pk=old.pk).supports_forced_tool_choice is None
    finally:
        MigrationExecutor(connection).migrate(leaves)
