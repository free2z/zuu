"""g12f 0118 drops the inert ``authtoken_token`` table.

A fresh test database never has the table (``rest_framework.authtoken`` is not
installed), so each test builds it with the DDL the app produced on prod,
inside the test transaction, and calls the migration's own function -- the
same approach as the 0113 tests. Real Postgres; nothing here is mocked except,
in one test, the ownership pre-check, to prove the fallback behind it.

The three shapes the issue requires: table present and owned by the migrate
role (dropped), present but owned by another role (warn and skip, migrate
still succeeds), and absent (no-op).
"""

import importlib
import uuid
from types import SimpleNamespace

import pytest
from django.apps import apps as global_apps
from django.db import OperationalError, connection

pytestmark = pytest.mark.django_db

migration = importlib.import_module(
    "dj.apps.g12f.migrations.0118_drop_legacy_drf_authtoken_table"
)

FK_NAME = "authtoken_token_user_id_35299eff_fk_g12f_creator_id"

# Verbatim shape of the table rest_framework.authtoken 0001-0004 built.
LEGACY_DDL = """
    CREATE TABLE authtoken_token (
        key varchar(40) NOT NULL PRIMARY KEY,
        created timestamp with time zone NOT NULL,
        user_id bigint NOT NULL UNIQUE
    )
"""
LEGACY_FK = f"""
    ALTER TABLE authtoken_token ADD CONSTRAINT {FK_NAME}
    FOREIGN KEY (user_id) REFERENCES g12f_creator (id)
    DEFERRABLE INITIALLY DEFERRED
"""
AUTHTOKEN_MIGRATIONS = [
    "0001_initial",
    "0002_auto_20160226_1747",
    "0003_tokenproxy",
    "0004_alter_tokenproxy_options",
]

EDITOR = SimpleNamespace(connection=connection)


def _build_legacy_table(*, with_fk=False):
    """The table as prod has it after 0113 (detached), or before (with FK)."""
    with connection.cursor() as cursor:
        cursor.execute(LEGACY_DDL)
        if with_fk:
            cursor.execute(LEGACY_FK)
        for name in AUTHTOKEN_MIGRATIONS:
            cursor.execute(
                "INSERT INTO django_migrations (app, name, applied) "
                "VALUES ('authtoken', %s, now())",
                [name],
            )


def _run():
    migration.drop_legacy_table(global_apps, EDITOR)


def _table_exists():
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('authtoken_token') IS NOT NULL")
        return cursor.fetchone()[0]


def _recorded_authtoken_migrations():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT name FROM django_migrations WHERE app = 'authtoken' "
            "ORDER BY name"
        )
        return [name for (name,) in cursor.fetchall()]


# --------------------------------------------------------------- owned (prod)


def test_present_and_owned_drops_the_table_and_its_migration_rows(capsys):
    """Prod's shape: 0113 detached and purged it; migrate owns it."""
    _build_legacy_table()
    assert _table_exists()

    _run()

    assert not _table_exists()
    assert _recorded_authtoken_migrations() == []
    out = capsys.readouterr().out
    assert "dropped authtoken_token" in out
    assert "forgot 4 django_migrations row(s)" in out
    assert "WARNING" not in out


def test_the_drop_also_works_where_0113_could_not_detach(creator_factory):
    """A database where the FK is still attached (0113 skipped it).

    DROP TABLE removes the table's own FK with it; account deletion is then
    unblocked whatever was left in the table.
    """
    _build_legacy_table(with_fk=True)
    user = creator_factory(username="authtoken-0118-fk")
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        cursor.execute(
            "INSERT INTO authtoken_token (key, created, user_id) "
            "VALUES (%s, now(), %s)",
            ["f" * 40, user.pk],
        )
        cursor.execute("SET CONSTRAINTS ALL DEFERRED")

    _run()

    assert not _table_exists()
    user.delete()
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_running_twice_is_a_no_op_the_second_time(capsys):
    _build_legacy_table()
    _run()
    capsys.readouterr()

    _run()

    assert not _table_exists()
    assert "no authtoken_token table to drop; forgot 0" in capsys.readouterr().out


def test_reverse_is_a_no_op():
    _build_legacy_table()
    _run()

    migration.Migration.operations[0].reverse_code(global_apps, EDITOR)

    assert not _table_exists()
    assert migration.Migration.operations[0].reversible


# ------------------------------------------------------------------- absent


def test_absent_is_a_no_op_that_still_forgets_stale_migration_rows(capsys):
    """A fresh database never had the table; a hand-dropped one might still
    carry the app's ``django_migrations`` rows, which would lie about it."""
    assert not _table_exists()
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO django_migrations (app, name, applied) "
            "VALUES ('authtoken', '0001_initial', now())"
        )

    _run()

    assert not _table_exists()
    assert _recorded_authtoken_migrations() == []
    out = capsys.readouterr().out
    assert "no authtoken_token table to drop; forgot 1" in out
    assert "WARNING" not in out


# ------------------------------------------------- present but NOT owned


@pytest.fixture
def migrate_role_that_does_not_own_the_table():
    """The table owned by one role, ``migrate`` running as another.

    DROP TABLE needs ownership, which no GRANT gives. Both roles are created
    inside the test transaction and vanish with its rollback.
    """
    with connection.cursor() as cursor:
        cursor.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
        (superuser,) = cursor.fetchone()
    if not superuser:
        pytest.skip("needs a superuser test role to CREATE ROLE / SET ROLE")

    _build_legacy_table()
    qn = connection.ops.quote_name
    owner = f"authtoken_owner_{uuid.uuid4().hex[:12]}"
    runner = f"authtoken_migrate_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f"CREATE ROLE {qn(owner)} NOLOGIN")
        cursor.execute(f"CREATE ROLE {qn(runner)} NOLOGIN")
        cursor.execute(f"ALTER TABLE authtoken_token OWNER TO {qn(owner)}")
        # Everything short of ownership: it still may not DROP.
        cursor.execute(f"GRANT ALL ON authtoken_token TO {qn(runner)}")
        cursor.execute(f"GRANT ALL ON django_migrations TO {qn(runner)}")

    def become():
        with connection.cursor() as cursor:
            cursor.execute(f"SET LOCAL ROLE {qn(runner)}")

    def reset():
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")

    yield SimpleNamespace(owner=owner, runner=runner, become=become, reset=reset)
    reset()


def test_present_but_not_owned_warns_skips_and_migrate_succeeds(
    migrate_role_that_does_not_own_the_table, capsys,
):
    """The deploy-wedge guard: an inert table must never abort a release."""
    roles = migrate_role_that_does_not_own_the_table
    roles.become()

    _run()  # no exception: migrate, and so the deploy, carries on

    out = capsys.readouterr().out
    roles.reset()
    assert "WARNING g12f.0118: SKIPPED dropping authtoken_token" in out
    assert repr(roles.owner) in out and repr(roles.runner) in out
    assert "cannot DROP it" in out, "refused by the pre-check"
    assert "DROP TABLE authtoken_token" in out, "the fix is spelled out"
    assert _table_exists()
    # Kept with the table, so the two still agree.
    assert _recorded_authtoken_migrations() == AUTHTOKEN_MIGRATIONS


def test_a_noinherit_member_of_the_owner_is_not_an_owner(
    migrate_role_that_does_not_own_the_table, capsys,
):
    """MEMBER without USAGE still gets 42501 on the DROP; the guard asks for
    USAGE (the same lesson as 0113's codex round 5)."""
    roles = migrate_role_that_does_not_own_the_table
    qn = connection.ops.quote_name
    with connection.cursor() as cursor:
        cursor.execute(f"ALTER ROLE {qn(roles.runner)} NOINHERIT")
        cursor.execute(f"GRANT {qn(roles.owner)} TO {qn(roles.runner)}")
    roles.become()

    _run()

    out = capsys.readouterr().out
    roles.reset()
    assert "cannot DROP it" in out
    assert _table_exists()


def test_an_actual_ownership_refusal_on_the_drop_is_caught_too(
    migrate_role_that_does_not_own_the_table, monkeypatch, capsys,
):
    """If the pre-check is ever wrong, the real 42501 still skips."""
    roles = migrate_role_that_does_not_own_the_table
    real = migration._ownership

    def lying(cursor):
        found = real(cursor)
        return None if found is None else (found[0], found[1], True)

    monkeypatch.setattr(migration, "_ownership", lying)
    roles.become()

    _run()

    out = capsys.readouterr().out
    roles.reset()
    assert "WARNING g12f.0118: SKIPPED dropping authtoken_token" in out
    assert "42501" in out and "must be owner" in out
    assert _table_exists()
    assert _recorded_authtoken_migrations() == AUTHTOKEN_MIGRATIONS


# ------------------------------------------------------- other refusals


def test_a_dependent_object_is_never_cascaded_into(capsys):
    """Someone's hand-made view on the table: skip, never DROP... CASCADE."""
    _build_legacy_table()
    with connection.cursor() as cursor:
        cursor.execute("CREATE VIEW authtoken_0118_probe AS SELECT key FROM authtoken_token")

    _run()

    out = capsys.readouterr().out
    assert "WARNING g12f.0118: SKIPPED dropping authtoken_token" in out
    assert "2BP01" in out
    assert _table_exists()
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('authtoken_0118_probe') IS NOT NULL")
        assert cursor.fetchone()[0], "the view must survive"
    assert _recorded_authtoken_migrations() == AUTHTOKEN_MIGRATIONS


@pytest.fixture
def table_held_by_another_session():
    """A second, real session holding ACCESS SHARE on ``authtoken_token``.

    The table is committed for real here (a test-transaction table is
    invisible to another session), and dropped again on teardown.
    """
    other = connection.copy()
    other.set_autocommit(True)
    with other.cursor() as cursor:
        cursor.execute(LEGACY_DDL)
    other.set_autocommit(False)
    with other.cursor() as cursor:
        cursor.execute("LOCK TABLE authtoken_token IN ACCESS SHARE MODE")
    try:
        yield other.rollback
    finally:
        other.rollback()
        other.set_autocommit(True)
        with other.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS authtoken_token")
        other.close()


def test_a_held_lock_is_retried_then_fails_the_deploy_safely(
    table_held_by_another_session, monkeypatch, capsys,
):
    """Each attempt queues at most LOCK_TIMEOUT, then the last failure
    propagates: ``migrate`` fails before any pod rolls, nothing half-applied."""
    monkeypatch.setattr(migration, "LOCK_TIMEOUT", "100ms")
    monkeypatch.setattr(migration, "LOCK_ATTEMPTS", 3)
    monkeypatch.setattr(migration, "LOCK_BACKOFF_SECONDS", (0, 0))

    with pytest.raises(OperationalError) as excinfo:
        _run()

    assert migration._is_lock_timeout(excinfo.value)
    assert capsys.readouterr().out.count("lock not available") == 2
    assert _table_exists()


def test_each_stall_is_at_most_a_second_and_the_whole_wait_under_thirty():
    assert migration.LOCK_TIMEOUT == "1s"
    low, high = migration.LOCK_BACKOFF_SECONDS
    worst = migration.LOCK_ATTEMPTS * 1.0 + (migration.LOCK_ATTEMPTS - 1) * high
    assert 0 < low < high and worst <= 30, worst
