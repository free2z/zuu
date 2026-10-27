"""g12f 0114: ``Creator.public_id`` added online, and immutable.

Two halves.

**The migration**, on a real database rolled back to 0113 with Django's own
``MigrationExecutor`` (``transaction=True``: CREATE INDEX CONCURRENTLY cannot
run inside the test transaction, and every phase has to commit for another
session to see it). "Old code" is the 0113 historical ``Creator`` -- a model
that does not know the column exists, which is exactly what the previous
release is while ``migrate`` runs before its pods are replaced.

**The model**: nothing in Django, and nothing that bypasses Django, can
change a value once assigned.

Negative controls: without the DB default, a row an old pod inserts after the
backfill fails VALIDATE, which fails the deploy; without the trigger, a
``QuerySet.update`` silently rewrites the id.

Real Postgres, per the project rule; nothing here is mocked. Locally this
ran against PG14 (prod's version) and CI runs PG16.
"""

import importlib
import threading
import time
import uuid
from types import SimpleNamespace

import pytest
from django.db import IntegrityError, OperationalError, connection, connections, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader

from dj.apps.g12f.models import Creator

migration = importlib.import_module("dj.apps.g12f.migrations.0114_creator_public_id")

BEFORE = ("g12f", "0113_purge_legacy_drf_authtoken")
EDITOR = SimpleNamespace(connection=connection)


def _migrate_to_leaves():
    MigrationExecutor(connection).migrate(MigrationLoader(connection).graph.leaf_nodes())


@pytest.fixture
def old_code(transactional_db):
    """The database at 0113; yields the 0113 ``Creator`` (the old release).

    Teardown always migrates forward again, which also exercises re-running
    the migration over whatever state a test left behind.
    """
    executor = MigrationExecutor(connection)
    executor.migrate([BEFORE])
    try:
        yield executor.loader.project_state([BEFORE]).apps.get_model("g12f", "Creator")
    finally:
        _migrate_to_leaves()


def _fast_locks(monkeypatch, attempts=3):
    monkeypatch.setattr(migration, "LOCK_TIMEOUT", "100ms")
    monkeypatch.setattr(migration, "LOCK_ATTEMPTS", attempts)
    monkeypatch.setattr(migration, "LOCK_BACKOFF_SECONDS", (0.02, 0.05))


def _column_exists():
    with connection.cursor() as cursor:
        return migration._column(cursor)[0]


def _public_ids():
    with connection.cursor() as cursor:
        cursor.execute("SELECT id, public_id FROM g12f_creator ORDER BY id")
        return dict(cursor.fetchall())


def _triggers():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT tgname FROM pg_trigger WHERE tgrelid = 'g12f_creator'::regclass "
            "AND NOT tgisinternal"
        )
        return {name for (name,) in cursor.fetchall()}


def _schema():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid) "
            "FROM pg_attribute a LEFT JOIN pg_attrdef d "
            "  ON d.adrelid = a.attrelid AND d.adnum = a.attnum "
            "WHERE a.attrelid = 'g12f_creator'::regclass AND a.attname = 'public_id'"
        )
        not_null, default = cursor.fetchone()
        cursor.execute(
            "SELECT conname, contype FROM pg_constraint "
            "WHERE conrelid = 'g12f_creator'::regclass AND conname LIKE %s",
            ["%public_id%"],
        )
        constraints = dict(cursor.fetchall())
    return SimpleNamespace(
        not_null=not_null, default=default, constraints=constraints, triggers=_triggers()
    )


# ------------------------------------------------------------- the migration


def test_forward_backfills_every_existing_row_in_batches(old_code, monkeypatch, capsys):
    monkeypatch.setattr(migration, "BACKFILL_BATCH", 7)
    pks = [old_code.objects.create(username=f"pre-{i}").pk for i in range(25)]
    assert not _column_exists()

    MigrationExecutor(connection).migrate([("g12f", "0114_creator_public_id")])

    ids = _public_ids()
    assert set(pks) <= set(ids)
    values = [ids[pk] for pk in pks]
    assert all(isinstance(v, uuid.UUID) and v.version == 4 for v in values)
    assert len(set(values)) == len(values)
    assert "g12f.0114: backfilled 25 row(s)" in capsys.readouterr().out

    schema = _schema()
    assert schema.not_null
    assert schema.default == "gen_random_uuid()"
    # The helper CHECK is gone; the index became the UNIQUE constraint a
    # fresh AddField(unique=True) would have made.
    assert schema.constraints == {migration.UNIQUE_NAME: "u"}
    assert migration.TRIGGER in schema.triggers


def test_old_code_keeps_working_against_the_new_schema(old_code):
    """The rollout window: the previous release inserts and saves Creators."""
    before = old_code.objects.create(username="rollout-before")
    _migrate_to_leaves()

    during = old_code.objects.create(username="rollout-during")
    ids = _public_ids()
    assert isinstance(ids[during.pk], uuid.UUID), "old INSERT got the DB default"
    assert ids[during.pk] != ids[before.pk]

    # An old full save writes every column IT knows -- not this one.
    stale = old_code.objects.get(pk=before.pk)
    stale.full_name = "edited by an old pod"
    stale.save()
    assert _public_ids()[before.pk] == ids[before.pk]


def test_rows_an_old_pod_inserts_while_the_migration_runs_all_get_one(old_code):
    """A real concurrent writer on its own connection, for the whole run."""
    stop = threading.Event()
    inserted, errors = [], []

    def old_pod():
        try:
            i = 0
            while not stop.is_set():
                inserted.append(old_code.objects.create(username=f"pod-{i}").pk)
                i += 1
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            connections.close_all()

    writer = threading.Thread(target=old_pod)
    writer.start()
    try:
        deadline = time.monotonic() + 10
        while len(inserted) < 20 and time.monotonic() < deadline:
            time.sleep(0.01)
        at_start = len(inserted)
        _migrate_to_leaves()
        time.sleep(0.1)
    finally:
        stop.set()
        writer.join(10)

    assert not errors, errors
    assert len(inserted) > at_start, "the writer kept inserting during the run"
    ids = _public_ids()
    assert all(isinstance(ids[pk], uuid.UUID) for pk in inserted)
    assert len(set(ids.values())) == len(ids)


def test_negative_control_without_the_db_default_an_old_pod_breaks_the_deploy(old_code):
    """Why phase 1 sets a DB default: a backfill alone races the old release.

    Same phases, but the column is added bare. The one row an old pod inserts
    between the backfill and VALIDATE stays NULL, VALIDATE refuses it, and
    ``migrate`` -- so the deploy -- fails.
    """
    old_code.objects.create(username="nc-before")
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE g12f_creator ADD COLUMN public_id uuid NULL")
    migration.backfill(connection)
    straggler = old_code.objects.create(username="nc-old-pod-after-backfill")
    migration.build_unique_index(connection)

    with pytest.raises(IntegrityError, match="g12f_creator_public_id_not_null"):
        migration.enforce_not_null_and_finish(connection)
    assert _public_ids()[straggler.pk] is None


def test_the_same_interleaving_with_the_real_phase_one_succeeds(old_code):
    old_code.objects.create(username="pc-before")
    migration.add_column(connection)
    migration.backfill(connection)
    straggler = old_code.objects.create(username="pc-old-pod-after-backfill")
    migration.build_unique_index(connection)

    migration.enforce_not_null_and_finish(connection)

    assert isinstance(_public_ids()[straggler.pk], uuid.UUID)
    assert _schema().not_null


@pytest.fixture
def creator_table_held_by_another_session():
    """A second, real session with an open transaction that read the table.

    Its ACCESS SHARE is what an ALTER's ACCESS EXCLUSIVE queues behind in
    prod (0113's fixture). Calling the value releases it early.
    """
    other = connection.copy()
    other.set_autocommit(False)
    with other.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM g12f_creator")
    try:
        yield other.rollback
    finally:
        other.rollback()
        other.close()


def test_a_held_table_lock_is_retried_then_fails_without_half_applying(
    old_code, creator_table_held_by_another_session, monkeypatch, capsys,
):
    _fast_locks(monkeypatch, attempts=3)
    old_code.objects.create(username="held")

    with pytest.raises(OperationalError) as excinfo:
        migration.forwards(None, EDITOR)

    assert migration._is_lock_timeout(excinfo.value)
    assert capsys.readouterr().out.count("add column: lock not available") == 2
    assert not _column_exists(), "nothing may be half applied"

    creator_table_held_by_another_session()
    migration.forwards(None, EDITOR)
    assert _schema().not_null


def test_a_row_an_old_pod_has_locked_makes_one_batch_retry(old_code, monkeypatch, capsys):
    """Backfill vs a writer holding a row lock: bounded wait, retry, finish."""
    _fast_locks(monkeypatch, attempts=20)
    pks = [old_code.objects.create(username=f"row-{i}").pk for i in range(5)]
    migration.add_column(connection)

    other = connection.copy()
    other.set_autocommit(False)
    with other.cursor() as cursor:
        cursor.execute("SELECT id FROM g12f_creator WHERE id = %s FOR UPDATE", [pks[2]])
    raw = other.connection  # psycopg connection: safe to release from a timer
    release = threading.Timer(0.4, raw.rollback)
    release.start()
    try:
        started = time.monotonic()
        migration.backfill(connection)
        waited = time.monotonic() - started
    finally:
        release.cancel()
        raw.rollback()
        other.close()

    out = capsys.readouterr().out
    assert "backfill: lock not available" in out
    assert waited >= 0.3
    ids = _public_ids()
    assert all(isinstance(ids[pk], uuid.UUID) for pk in pks)


def test_a_duplicate_fails_the_index_build_and_leaves_no_invalid_index(old_code):
    """Uniqueness is enforced by the build, and a failed build cleans up.

    CREATE UNIQUE INDEX CONCURRENTLY that fails leaves an INVALID index that
    every write keeps maintaining; the phase drops it before re-raising.
    """
    a = old_code.objects.create(username="dup-a")
    b = old_code.objects.create(username="dup-b")
    migration.add_column(connection)
    migration.backfill(connection)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE g12f_creator SET public_id = "
            "(SELECT public_id FROM g12f_creator WHERE id = %s) WHERE id = %s",
            [a.pk, b.pk],
        )

    with pytest.raises(IntegrityError):
        migration.build_unique_index(connection)
    with connection.cursor() as cursor:
        assert migration._index_state(cursor) is None

    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE g12f_creator SET public_id = gen_random_uuid() WHERE id = %s",
            [b.pk],
        )
    migration.build_unique_index(connection)
    with connection.cursor() as cursor:
        assert migration._index_state(cursor) is True


def test_an_invalid_index_left_by_an_earlier_run_is_rebuilt(old_code, capsys):
    old_code.objects.create(username="invalid-idx")
    migration.add_column(connection)
    migration.backfill(connection)
    migration.build_unique_index(connection)
    with connection.cursor() as cursor:
        # What a build killed half way (deploy cancelled) leaves behind.
        cursor.execute(
            "UPDATE pg_index SET indisvalid = false "
            "WHERE indexrelid = %s::regclass",
            [migration.UNIQUE_NAME],
        )

    migration.build_unique_index(connection)

    assert "dropping INVALID index" in capsys.readouterr().out
    with connection.cursor() as cursor:
        assert migration._index_state(cursor) is True


def test_set_not_null_is_proven_by_the_validated_check_not_a_scan(old_code):
    """The whole point of phase 4: the ACCESS EXCLUSIVE step does not scan.

    Postgres says so at DEBUG1 when it skips the scan (PG12+). Without the
    validated CHECK the same ALTER scans g12f_creator under the lock.
    """
    old_code.objects.create(username="no-scan")
    migration.add_column(connection)
    migration.backfill(connection)
    migration.build_unique_index(connection)

    connection.ensure_connection()
    notices = []
    raw = connection.connection

    def handler(diag):
        # A Diagnostic is only readable inside the callback.
        notices.append(diag.message_primary or "")

    raw.add_notice_handler(handler)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET client_min_messages = debug1")
        migration.enforce_not_null_and_finish(connection)
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET client_min_messages")
        raw.remove_notice_handler(handler)

    assert any(
        "sufficient to prove that it does not contain nulls" in n for n in notices
    ), notices


def test_forwards_is_idempotent(old_code):
    old_code.objects.create(username="twice")
    migration.forwards(None, EDITOR)
    first = _public_ids()

    migration.forwards(None, EDITOR)

    assert _public_ids() == first
    assert _schema().constraints == {migration.UNIQUE_NAME: "u"}


def test_reverse_drops_the_column_trigger_and_function(old_code):
    """``old_code`` already reversed it; check nothing is left behind."""
    assert not _column_exists()
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_proc WHERE proname = %s", [migration.FUNCTION])
        assert cursor.fetchone() is None
    assert migration.TRIGGER not in _triggers()


def test_a_non_owner_is_refused_before_any_ddl(old_code):
    """No half-migrated table: the ownership check runs first."""
    role = f"public_id_nonowner_{uuid.uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
        if not cursor.fetchone()[0]:
            pytest.skip("needs a superuser test role to CREATE ROLE / SET ROLE")
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN')
    try:
        with connection.cursor() as cursor:
            cursor.execute(f'SET ROLE "{role}"')
        with pytest.raises(RuntimeError, match="cannot ALTER it. Nothing was changed"):
            migration.forwards(None, EDITOR)
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP ROLE "{role}"')
    assert not _column_exists()


def test_the_lock_budget_matches_0113():
    """Per-attempt stall on g12f_creator <= 1s; total give-up ~28s."""
    assert migration.LOCK_TIMEOUT == "1s"
    low, high = migration.LOCK_BACKOFF_SECONDS
    worst = migration.LOCK_ATTEMPTS * 1.0 + (migration.LOCK_ATTEMPTS - 1) * high
    assert 0 < low < high and worst <= 30


# ------------------------------------------------------------------ the model


@pytest.mark.django_db
def test_a_new_creator_gets_a_distinct_public_id_back_from_the_insert(creator_factory):
    a, b = creator_factory(username="pid-a"), creator_factory(username="pid-b")
    assert isinstance(a.public_id, uuid.UUID) and a.public_id.version == 4
    assert a.public_id != b.public_id
    assert Creator.objects.get(pk=a.pk).public_id == a.public_id


@pytest.mark.django_db
def test_full_clean_on_an_unsaved_creator_does_not_trip_on_the_db_default():
    Creator(username="pid-unsaved", password="x").full_clean(exclude=["password"])


@pytest.mark.django_db
def test_naming_public_id_in_update_fields_raises(creator_factory):
    creator = creator_factory(username="pid-explicit")
    creator.public_id = uuid.uuid4()
    with pytest.raises(ValueError, match="never changes"):
        creator.save(update_fields=["public_id"])


@pytest.mark.django_db
def test_the_guard_does_not_exhaust_an_iterator_of_update_fields(creator_factory):
    """Django accepts any iterable; checking it must not consume it (codex)."""
    creator = creator_factory(username="pid-iter")
    creator.full_name = "via generator"
    creator.save(update_fields=(name for name in ["full_name"]))
    assert Creator.objects.get(pk=creator.pk).full_name == "via generator"


@pytest.mark.django_db
def test_a_full_save_never_writes_it_and_resyncs_the_instance(creator_factory):
    creator = creator_factory(username="pid-full")
    original = creator.public_id
    creator.public_id = uuid.uuid4()
    creator.full_name = "renamed"

    creator.save()

    assert creator.public_id == original
    row = Creator.objects.get(pk=creator.pk)
    assert (row.public_id, row.full_name) == (original, "renamed")


@pytest.mark.django_db
def test_a_hand_built_instance_does_not_mint_a_new_id(creator_factory):
    """``Creator(pk=existing)`` holds a DatabaseDefault, i.e. ``SET = DEFAULT``."""
    existing = creator_factory(username="pid-handbuilt")
    Creator(pk=existing.pk, username="pid-handbuilt", password="!").save()
    assert Creator.objects.get(pk=existing.pk).public_id == existing.public_id


@pytest.mark.django_db
def test_the_database_refuses_any_update_that_changes_it(creator_factory):
    creator = creator_factory(username="pid-trigger")
    with pytest.raises(IntegrityError, match="immutable"):
        with transaction.atomic():
            Creator.objects.filter(pk=creator.pk).update(public_id=uuid.uuid4())
    with pytest.raises(IntegrityError, match="immutable"):
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(
                "UPDATE g12f_creator SET public_id = DEFAULT WHERE id = %s", [creator.pk]
            )
    # Naming the column without changing it is not a change.
    Creator.objects.filter(pk=creator.pk).update(public_id=creator.public_id)
    assert Creator.objects.get(pk=creator.pk).public_id == creator.public_id


@pytest.mark.django_db
def test_negative_control_without_the_trigger_an_update_rewrites_it(creator_factory):
    creator = creator_factory(username="pid-no-trigger")
    replacement = uuid.uuid4()
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(f"DROP TRIGGER {migration.TRIGGER} ON g12f_creator")
        Creator.objects.filter(pk=creator.pk).update(public_id=replacement)
        assert Creator.objects.get(pk=creator.pk).public_id == replacement
        transaction.set_rollback(True)
    assert migration.TRIGGER in _triggers()
