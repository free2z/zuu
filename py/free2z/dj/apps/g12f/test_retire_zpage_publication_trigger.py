"""Behavioral coverage for the post-deploy publication-trigger retirement."""

from __future__ import annotations

import importlib
from io import StringIO

import pytest
from django.core.management import call_command
from django.db import DatabaseError, connection


pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        connection.vendor != "postgresql",
        reason="publication-trigger retirement uses PostgreSQL DDL",
    ),
]


COMMAND = importlib.import_module(
    "dj.apps.g12f.management.commands.retire_zpage_publication_trigger"
)
MIGRATION = importlib.import_module(
    "dj.apps.g12f.migrations.0104_remove_zpage_publication_trigger"
)
# Defined locally rather than read off the applied 0104 migration: a migration
# that is already applied in production must not be edited to hand a constant
# to a test. The command under test owns its own copy, and monkeypatching that
# copy is exactly what one of the tests below does.
DROP_FUNCTION_SQL = "DROP FUNCTION IF EXISTS g12f_set_zpage_published_at();"


def trigger_state():
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT EXISTS (
                SELECT 1
                FROM pg_trigger
                WHERE tgrelid = 'g12f_zpage'::regclass
                  AND tgname = 'g12f_zpage_publication_timestamp'
                  AND NOT tgisinternal
            )
            """
        )
        return cursor.fetchone()[0]


def function_state():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT EXISTS ("
            "SELECT 1 FROM pg_proc "
            "WHERE proname = 'g12f_set_zpage_published_at' "
            "AND pg_function_is_visible(oid)"
            ")"
        )
        return cursor.fetchone()[0]


@pytest.fixture
def installed_publication_trigger():
    with connection.cursor() as cursor:
        cursor.execute(MIGRATION.DROP_TRIGGER_SQL)
        cursor.execute(MIGRATION.PUBLICATION_FUNCTION_SQL)
        cursor.execute(MIGRATION.CREATE_TRIGGER_SQL)
    yield
    with connection.cursor() as cursor:
        cursor.execute(MIGRATION.DROP_TRIGGER_SQL)
        cursor.execute(DROP_FUNCTION_SQL)


def test_retirement_uses_local_lock_timeout_and_drops_trigger_and_function(
    installed_publication_trigger,
):
    statements = []

    def record_sql(execute, sql, params, many, context):
        statements.append(str(sql))
        return execute(sql, params, many, context)

    with connection.execute_wrapper(record_sql):
        call_command(
            "retire_zpage_publication_trigger",
            stdout=StringIO(),
            no_color=True,
        )

    assert any(
        statement.strip() == "SET LOCAL lock_timeout = '3s';"
        for statement in statements
    )
    assert not trigger_state()
    assert not function_state()


def test_failed_function_drop_rolls_back_trigger_drop(
    installed_publication_trigger, monkeypatch
):
    statements = []

    def record_sql(execute, sql, params, many, context):
        statements.append(str(sql))
        return execute(sql, params, many, context)

    monkeypatch.setattr(
        COMMAND,
        "DROP_FUNCTION_SQL",
        "SELECT missing_retirement_function_for_test();",
    )
    with pytest.raises(DatabaseError):
        with connection.execute_wrapper(record_sql):
            call_command(
                "retire_zpage_publication_trigger",
                stdout=StringIO(),
                no_color=True,
            )

    assert any(
        statement.strip() == "SET LOCAL lock_timeout = '3s';"
        for statement in statements
    )
    assert trigger_state(), "the failed transaction must preserve the trigger"
    assert function_state(), "the failed transaction must preserve its function"
