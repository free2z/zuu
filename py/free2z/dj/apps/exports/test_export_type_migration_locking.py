"""PostgreSQL lock-timeout and rollback coverage for exports migration 0003."""
from __future__ import annotations

import uuid

import psycopg
import pytest
from django.db import connection
from django.db.migrations.recorder import MigrationRecorder
from psycopg import sql

pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        connection.vendor != "postgresql",
        reason="the migration lock contract requires PostgreSQL",
    ),
]


def _connect_independent():
    config = connection.settings_dict
    return psycopg.connect(
        dbname=config["NAME"],
        user=config["USER"],
        password=config["PASSWORD"],
        host=config["HOST"],
        port=config["PORT"],
    )


def _set_search_path(schema_name):
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("SET search_path TO {}, public").format(
                sql.Identifier(schema_name),
            ),
        )


def _run_migration(migration, state, *, reverse=False):
    with connection.schema_editor(atomic=True) as editor:
        if reverse:
            migration.unapply(state, editor)
        else:
            return migration.apply(state, editor)


def _column_exists(schema_name):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema=%s AND table_name=%s AND column_name=%s",
            [schema_name, "exports_publicationexportjob", "export_type"],
        )
        return cursor.fetchone() is not None


def _export_type_indexes(schema_name):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT indexname FROM pg_indexes "
            "WHERE schemaname=%s AND tablename=%s AND indexdef ILIKE %s",
            [schema_name, "exports_publicationexportjob", "%export_type%"],
        )
        return {row[0] for row in cursor.fetchall()}


def _active_index_definition(schema_name):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT indexdef FROM pg_indexes "
            "WHERE schemaname=%s AND tablename=%s "
            "AND indexname='unique_active_publication_export_job'",
            [schema_name, "exports_publicationexportjob"],
        )
        row = cursor.fetchone()
        return row[0] if row else None


def _hold_table_lock(schema_name):
    blocker = _connect_independent()
    cursor = blocker.cursor()
    cursor.execute(
        sql.SQL("SET search_path TO {}, public").format(
            sql.Identifier(schema_name),
        ),
    )
    cursor.execute(
        sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(
            sql.Identifier("exports_publicationexportjob"),
        ),
    )
    return blocker, cursor


def test_export_type_migration_lock_refusal_rolls_back_and_retries():
    from django.db.migrations.loader import MigrationLoader

    migration_key = ("exports", "0003_publicationexportjob_export_type")
    loader = MigrationLoader(connection)
    migration = loader.disk_migrations[migration_key]
    source_state = loader.project_state(
        [("exports", "0002_preserve_archive_on_creator_delete")],
    )
    schema_name = f"exports_mig_lock_{uuid.uuid4().hex}"
    blocker = None
    recorder_before = MigrationRecorder(connection).applied_migrations()
    with connection.cursor() as cursor:
        cursor.execute("SHOW lock_timeout")
        original_lock_timeout = cursor.fetchone()[0]
        cursor.execute("SHOW statement_timeout")
        original_statement_timeout = cursor.fetchone()[0]
        cursor.execute("SHOW search_path")
        original_search_path = cursor.fetchone()[0]
        cursor.execute(
            sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)),
        )

    try:
        _set_search_path(schema_name)
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL(
                    "CREATE TABLE {} ("
                    "id uuid PRIMARY KEY, "
                    "creator_id bigint NULL, "
                    "status varchar(16) NOT NULL DEFAULT 'failed'"
                    ")"
                ).format(sql.Identifier("exports_publicationexportjob")),
            )
            cursor.execute(
                sql.SQL(
                    "CREATE UNIQUE INDEX unique_active_publication_export_job "
                    "ON {} (creator_id) WHERE status IN ('queued', 'running')"
                ).format(sql.Identifier("exports_publicationexportjob")),
            )

        blocker, _ = _hold_table_lock(schema_name)
        with pytest.raises(Exception, match="lock timeout"):
            _run_migration(migration, source_state.clone())
        blocker.rollback()
        blocker.close()
        blocker = None

        assert not _column_exists(schema_name)
        assert not _export_type_indexes(schema_name)
        assert MigrationRecorder(connection).applied_migrations() == recorder_before
        with connection.cursor() as cursor:
            cursor.execute("SHOW lock_timeout")
            assert cursor.fetchone()[0] == original_lock_timeout
            cursor.execute("SHOW statement_timeout")
            assert cursor.fetchone()[0] == original_statement_timeout

        # Retry after the independent lock-holder releases the table.
        applied_state = _run_migration(migration, source_state.clone())
        assert _column_exists(schema_name)
        indexes = _export_type_indexes(schema_name)
        # Django creates a normal and pattern-ops column index plus the
        # type-scoped active-job uniqueness index.
        assert len(indexes) == 3
        assert len([name for name in indexes if not name.endswith("_like")]) == 2
        assert "export_type" in (_active_index_definition(schema_name) or "")
        assert "publications" in (_active_index_definition(schema_name) or "")
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL(
                    "INSERT INTO {} (id, creator_id, status) "
                    "VALUES (%s, 42, 'queued') RETURNING export_type"
                ).format(sql.Identifier("exports_publicationexportjob")),
                [uuid.uuid4()],
            )
            assert cursor.fetchone()[0] == "publications"
            cursor.execute(
                sql.SQL(
                    "INSERT INTO {} (id, creator_id, status, export_type) "
                    "VALUES (%s, 42, 'queued', 'account')"
                ).format(sql.Identifier("exports_publicationexportjob")),
                [uuid.uuid4()],
            )
            cursor.execute("SHOW lock_timeout")
            assert cursor.fetchone()[0] == original_lock_timeout
            cursor.execute("SHOW statement_timeout")
            assert cursor.fetchone()[0] == original_statement_timeout
        assert MigrationRecorder(connection).applied_migrations() == recorder_before

        # The reverse path sets its own local timeout before DROP INDEX / DROP
        # COLUMN. Make the two deliberately coexisting active job types
        # inactive so restoring the legacy cross-type index is valid.
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("UPDATE {} SET status='failed'").format(
                    sql.Identifier("exports_publicationexportjob"),
                ),
            )

        # A refusal preserves both indexes, and the retry removes both.
        blocker, _ = _hold_table_lock(schema_name)
        with pytest.raises(Exception, match="lock timeout"):
            _run_migration(migration, applied_state, reverse=True)
        blocker.rollback()
        blocker.close()
        blocker = None

        assert _column_exists(schema_name)
        assert _export_type_indexes(schema_name) == indexes
        assert MigrationRecorder(connection).applied_migrations() == recorder_before
        with connection.cursor() as cursor:
            cursor.execute("SHOW lock_timeout")
            assert cursor.fetchone()[0] == original_lock_timeout
            cursor.execute("SHOW statement_timeout")
            assert cursor.fetchone()[0] == original_statement_timeout

        _run_migration(migration, applied_state, reverse=True)
        assert not _column_exists(schema_name)
        assert not _export_type_indexes(schema_name)
        assert MigrationRecorder(connection).applied_migrations() == recorder_before
        with connection.cursor() as cursor:
            cursor.execute("SHOW lock_timeout")
            assert cursor.fetchone()[0] == original_lock_timeout
            cursor.execute("SHOW statement_timeout")
            assert cursor.fetchone()[0] == original_statement_timeout
    finally:
        if blocker is not None:
            blocker.rollback()
            blocker.close()
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('search_path', %s, false)",
                [original_search_path],
            )
            cursor.execute(
                sql.SQL("DROP SCHEMA {} CASCADE").format(
                    sql.Identifier(schema_name),
                ),
            )
