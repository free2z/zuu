"""g12f 0113 purges ``authtoken_token`` and detaches it from Creator.

A fresh test database never has the table -- ``rest_framework.authtoken`` is
no longer installed -- so each test builds it with the exact DDL the app
produced on prod (read off a database migrated by the previous release with
``\\d authtoken_token``), inside the test transaction, and runs the
migration's own functions against it.

The first test is the negative control for the whole change: with the table
as prod has it, a row Django no longer knows about makes deleting its account
an IntegrityError. That is the failure uninstalling the app without this
migration would ship, and the reason the FK is dropped rather than only the
rows purged (an old pod can still mint a row during the rollout).

Real Postgres, per the project rule; nothing here is mocked.
"""

import importlib
from types import SimpleNamespace

import pytest
from django.apps import apps as global_apps
from django.db import IntegrityError, connection

pytestmark = pytest.mark.django_db

migration = importlib.import_module(
    "dj.apps.g12f.migrations.0113_purge_legacy_drf_authtoken"
)

# Verbatim shape of the table rest_framework.authtoken 0001-0004 built.
PROD_DDL = [
    """
    CREATE TABLE authtoken_token (
        key varchar(40) NOT NULL PRIMARY KEY,
        created timestamp with time zone NOT NULL,
        user_id bigint NOT NULL UNIQUE
    )
    """,
    """
    ALTER TABLE authtoken_token
    ADD CONSTRAINT authtoken_token_user_id_35299eff_fk_g12f_creator_id
    FOREIGN KEY (user_id) REFERENCES g12f_creator (id)
    DEFERRABLE INITIALLY DEFERRED
    """,
]

EDITOR = SimpleNamespace(connection=connection)


def _build_legacy_table():
    with connection.cursor() as cursor:
        for statement in PROD_DDL:
            cursor.execute(statement)


def _mint_legacy_row(user, key):
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO authtoken_token (key, created, user_id) "
            "VALUES (%s, now(), %s)",
            [key, user.pk],
        )


def _run(direction):
    """Call a migration function the way ``migrate`` would see the database.

    ``migrate`` runs 0113 in a transaction of its own, so no deferred FK check
    is pending when it ALTERs the table. The test transaction has just
    inserted rows under a DEFERRABLE INITIALLY DEFERRED constraint, and
    Postgres refuses to ALTER a table with pending trigger events -- so fire
    them first, exactly as the COMMIT that would have preceded the migration.
    """
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        cursor.execute("SET CONSTRAINTS ALL DEFERRED")
    direction(global_apps, EDITOR)


def _rows():
    with connection.cursor() as cursor:
        cursor.execute("SELECT key FROM authtoken_token ORDER BY key")
        return [key for (key,) in cursor.fetchall()]


def _foreign_keys():
    with connection.cursor() as cursor:
        return migration._foreign_keys(cursor)


def _delete_account_and_check_constraints(user):
    """Delete ``user`` and force the deferred FK check a COMMIT would run."""
    user.delete()
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_a_row_django_does_not_know_about_blocks_account_deletion(
    creator_factory,
):
    """Negative control: the hazard is real on the pre-migration schema."""
    _build_legacy_table()
    user = creator_factory()
    _mint_legacy_row(user, "a" * 40)

    with pytest.raises(IntegrityError):
        _delete_account_and_check_constraints(user)


def test_forward_purges_every_row_and_drops_the_foreign_key(
    creator_factory, capsys,
):
    _build_legacy_table()
    alice = creator_factory(username="authtoken-alice")
    bob = creator_factory(username="authtoken-bob")
    _mint_legacy_row(alice, "a" * 40)
    _mint_legacy_row(bob, "b" * 40)
    assert _foreign_keys() == [migration.FK_NAME]

    _run(migration.purge_and_detach)

    assert _rows() == []
    assert _foreign_keys() == []
    out = capsys.readouterr().out
    assert "purged 2 legacy rest_framework.authtoken row(s)" in out
    assert migration.FK_NAME in out

    # Account deletion works even for a row that lands AFTER the purge, which
    # is what an old pod still serving during the rollout could write.
    _mint_legacy_row(alice, "c" * 40)
    _delete_account_and_check_constraints(alice)
    _delete_account_and_check_constraints(bob)


def test_reverse_restores_the_foreign_key_the_old_release_expects(
    creator_factory,
):
    _build_legacy_table()
    survivor = creator_factory(username="authtoken-survivor")
    doomed = creator_factory(username="authtoken-doomed")
    _run(migration.purge_and_detach)

    # While detached: one row whose account is later deleted (an orphan the
    # constraint would refuse) and one that is still valid.
    _mint_legacy_row(doomed, "d" * 40)
    _mint_legacy_row(survivor, "e" * 40)
    _delete_account_and_check_constraints(doomed)

    _run(migration.reattach)

    assert _foreign_keys() == [migration.FK_NAME]
    assert _rows() == ["e" * 40], "only the orphan is removed on reverse"
    with pytest.raises(IntegrityError):
        _delete_account_and_check_constraints(survivor)


def test_reverse_is_idempotent_when_the_constraint_already_exists():
    _build_legacy_table()

    _run(migration.reattach)

    assert _foreign_keys() == [migration.FK_NAME]


def test_both_directions_are_a_no_op_without_the_table(capsys):
    """A fresh database (CI, a new dev box) never had the app installed."""
    assert "authtoken_token" not in connection.introspection.table_names()

    _run(migration.purge_and_detach)
    _run(migration.reattach)

    assert "authtoken_token" not in connection.introspection.table_names()
    assert capsys.readouterr().out == ""


@pytest.fixture
def creator_table_held_by_another_session():
    """A second, real session holding ACCESS SHARE on ``g12f_creator``.

    Any open transaction that has read the table holds exactly this, which is
    what the DROP CONSTRAINT's ACCESS EXCLUSIVE lock has to queue behind in
    prod. Calling the fixture's value releases it early; teardown always does.
    """
    other = connection.copy()
    other.set_autocommit(False)
    with other.cursor() as cursor:
        cursor.execute("LOCK TABLE g12f_creator IN ACCESS SHARE MODE")
    try:
        yield other.rollback
    finally:
        other.rollback()
        other.close()


def test_a_held_creator_lock_is_retried_then_fails_without_half_applying(
    creator_factory, creator_table_held_by_another_session, monkeypatch, capsys,
):
    """Waiting on ``g12f_creator`` is bounded, retried, and then refused.

    Every attempt gives up after LOCK_TIMEOUT instead of queueing the whole
    site behind the ALTER, and the last failure propagates -- which fails the
    ``migrate`` step, and so the deploy, before any pod rolls. The foreign
    key is still there afterwards: the savepoint rolled the attempt back.
    """
    from django.db import OperationalError

    monkeypatch.setattr(migration, "LOCK_TIMEOUT", "100ms")
    monkeypatch.setattr(migration, "LOCK_ATTEMPTS", 3)
    monkeypatch.setattr(migration, "LOCK_BACKOFF_SECONDS", (0, 0))
    _build_legacy_table()
    _mint_legacy_row(creator_factory(username="authtoken-held"), "h" * 40)

    with pytest.raises(OperationalError) as excinfo:
        _run(migration.purge_and_detach)

    assert migration._is_lock_timeout(excinfo.value)
    assert capsys.readouterr().out.count("lock not available") == 2
    assert _foreign_keys() == [migration.FK_NAME]
    assert _rows() == ["h" * 40], "the purge must not run before the detach"

    # Once the other session lets go, the same call goes through.
    creator_table_held_by_another_session()
    _run(migration.purge_and_detach)
    assert _foreign_keys() == []
    assert _rows() == []


@pytest.mark.parametrize(
    ("sqlstate", "retried"),
    [("55P03", True), ("40P01", True), ("23503", False)],
)
def test_lock_timeouts_and_deadlocks_are_retried_nothing_else(sqlstate, retried):
    """psycopg 3 reports ``sqlstate`` (psycopg2 ``pgcode``); both count."""
    from django.db import OperationalError

    for attribute in ("sqlstate", "pgcode"):
        exc = OperationalError("x")
        cause = Exception("driver error")
        setattr(cause, attribute, sqlstate)
        exc.__cause__ = cause
        assert migration._is_lock_timeout(exc) is retried


def test_each_stall_is_at_most_a_second_and_the_whole_wait_under_thirty():
    """Per-attempt stall on `g12f_creator` <= 1s; total give-up bound ~25-30s.

    The per-attempt number is what a user request can queue behind; the total
    is how long a deploy waits before failing safely.
    """
    assert migration.LOCK_TIMEOUT == "1s"
    low, high = migration.LOCK_BACKOFF_SECONDS
    worst = migration.LOCK_ATTEMPTS * 1.0 + (migration.LOCK_ATTEMPTS - 1) * high
    best = migration.LOCK_ATTEMPTS * 1.0 + (migration.LOCK_ATTEMPTS - 1) * low
    assert 0 < low < high
    assert 15 <= best and worst <= 30, (best, worst)


# ---------------------------------------------- a migrate role that is not owner


@pytest.fixture
def running_as_a_non_owner():
    """Switch this transaction to a fresh role that does NOT own the table.

    ALTER TABLE needs ownership, which no GRANT gives, so this is the prod
    shape where the table was created by a different role than the one that
    runs ``migrate`` today. The role is created inside the test transaction
    and vanishes with its rollback. Returns a ``grant(privilege)`` helper.
    """
    import uuid

    with connection.cursor() as cursor:
        cursor.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
        (superuser,) = cursor.fetchone()
    if not superuser:
        pytest.skip("needs a superuser test role to CREATE ROLE / SET ROLE")

    _build_legacy_table()
    role = f"authtoken_nonowner_{uuid.uuid4().hex[:12]}"
    qn = connection.ops.quote_name
    with connection.cursor() as cursor:
        cursor.execute(f"CREATE ROLE {qn(role)} NOLOGIN")

    def grant(privilege):
        with connection.cursor() as cursor:
            cursor.execute(f"GRANT {privilege} ON authtoken_token TO {qn(role)}")

    def become():
        with connection.cursor() as cursor:
            cursor.execute(f"SET LOCAL ROLE {qn(role)}")

    yield SimpleNamespace(role=role, grant=grant, become=become)
    with connection.cursor() as cursor:
        cursor.execute("RESET ROLE")


def test_a_non_owner_skips_the_detach_with_a_warning_and_still_purges(
    creator_factory, running_as_a_non_owner, capsys,
):
    """The deploy-wedge guard: ownership mismatch must not fail ``migrate``.

    Without the guard the ALTER raises 42501 on every deploy, forever. Here it
    is skipped with a WARNING naming the owner and the exact fix, and the
    purge -- which a plain DELETE grant allows -- still runs.
    """
    _mint_legacy_row(creator_factory(username="authtoken-nonowner"), "n" * 40)
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_user")
        (owner,) = cursor.fetchone()
    running_as_a_non_owner.grant("DELETE")
    running_as_a_non_owner.become()

    _run(migration.purge_and_detach)

    out = capsys.readouterr().out
    assert "WARNING g12f.0113: SKIPPED dropping" in out
    assert repr(owner) in out and repr(running_as_a_non_owner.role) in out
    assert f"ALTER TABLE authtoken_token DROP CONSTRAINT {migration.FK_NAME}" in out
    assert "purged 1 legacy" in out
    with connection.cursor() as cursor:
        cursor.execute("RESET ROLE")
    assert _foreign_keys() == [migration.FK_NAME], "a non-owner cannot drop it"
    assert _rows() == []


def test_a_non_owner_without_delete_skips_both_and_migrate_still_succeeds(
    creator_factory, running_as_a_non_owner, capsys,
):
    _mint_legacy_row(creator_factory(username="authtoken-nodelete"), "q" * 40)
    running_as_a_non_owner.become()

    _run(migration.purge_and_detach)

    out = capsys.readouterr().out
    assert "SKIPPED dropping" in out
    assert "WARNING g12f.0113: SKIPPED purging authtoken_token" in out
    assert "purged SKIPPED" in out
    # The one state the guard cannot make safe is named, not hidden.
    assert "ACCOUNT DELETION NOW FAILS" in out
    with connection.cursor() as cursor:
        cursor.execute("RESET ROLE")
    assert _rows() == ["q" * 40]


def test_a_non_owner_reverse_is_skipped_with_a_warning(
    running_as_a_non_owner, capsys,
):
    with connection.cursor() as cursor:
        cursor.execute(f"ALTER TABLE authtoken_token DROP CONSTRAINT {migration.FK_NAME}")
    running_as_a_non_owner.become()

    _run(migration.reattach)

    assert "WARNING g12f.0113: SKIPPED re-adding" in capsys.readouterr().out


def test_a_noinherit_member_of_the_owner_is_treated_as_a_non_owner(
    creator_factory, running_as_a_non_owner, capsys,
):
    """Membership is not usable privilege (codex round 5).

    A NOINHERIT member of the owning role passes ``pg_has_role(..., 'MEMBER')``
    but its ALTER still fails with 42501 unless it SET ROLEs first -- which
    ``migrate`` never does. The guard asks for ``USAGE``.
    """
    import uuid

    qn = connection.ops.quote_name
    owner_role = f"authtoken_owner_{uuid.uuid4().hex[:12]}"
    member = running_as_a_non_owner.role
    with connection.cursor() as cursor:
        cursor.execute(f"CREATE ROLE {qn(owner_role)} NOLOGIN")
        cursor.execute(f"ALTER TABLE authtoken_token OWNER TO {qn(owner_role)}")
        cursor.execute(f"ALTER ROLE {qn(member)} NOINHERIT")
        cursor.execute(f"GRANT {qn(owner_role)} TO {qn(member)}")
        cursor.execute(
            "SELECT pg_has_role(%s, %s, 'MEMBER'), pg_has_role(%s, %s, 'USAGE')",
            [member, owner_role, member, owner_role],
        )
        assert cursor.fetchone() == (True, False), "fixture is not the NOINHERIT shape"
    _mint_legacy_row(creator_factory(username="authtoken-noinherit"), "m" * 40)
    running_as_a_non_owner.grant("DELETE")
    running_as_a_non_owner.become()

    _run(migration.purge_and_detach)

    out = capsys.readouterr().out
    assert "SKIPPED dropping" in out and repr(owner_role) in out
    # Refused by the pre-check, not by tripping over the 42501 fallback.
    assert "cannot ALTER it" in out
    assert "purged 1 legacy" in out


def test_an_actual_ownership_refusal_on_the_alter_is_caught_too(
    running_as_a_non_owner, monkeypatch, capsys,
):
    """Belt and braces: if the pre-check is ever wrong, 42501 still skips."""
    real = migration._ownership

    def lying(cursor):
        owner, me, _may_alter = real(cursor)
        return owner, me, True

    monkeypatch.setattr(migration, "_ownership", lying)
    running_as_a_non_owner.grant("DELETE")
    running_as_a_non_owner.become()

    _run(migration.purge_and_detach)

    out = capsys.readouterr().out
    assert "WARNING g12f.0113: SKIPPED dropping" in out
    assert "must be owner" in out
