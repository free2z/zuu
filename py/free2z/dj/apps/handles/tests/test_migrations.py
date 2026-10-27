"""g12f 0109/0110 and handles 0001/0002, forward and back, over production-shaped
data: case-variant duplicate usernames (including one where the lowercase
spelling is the *earliest*, and one tied on ``date_joined``), ineligible
usernames of every kind, and a reserved word.

The property that matters most is the first one below: the migration builds a
case-insensitive unique index over a table that already violates it, without
editing or deleting a single username. The unfixed alternative -- a plain
``UniqueConstraint(Lower("username"))`` -- fails to build on this fixture,
which ``test_a_plain_case_insensitive_index_cannot_be_built_over_this_fixture``
demonstrates, so the fixture really does reproduce the production condition.
"""

from datetime import datetime, timedelta, timezone

import pytest
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor

BEFORE = [
    ("g12f", "0108_creatorfollow"),
    ("handles", None),
]
AFTER = [
    ("g12f", "0110_creator_username_ci_unique"),
    ("handles", "0002_reserve_username_handles"),
]

T0 = datetime(2021, 1, 1, tzinfo=timezone.utc)

#: (username, days after T0). Order of insertion (and so pk) is list order.
FIXTURE = [
    ("Carol", 0),
    ("carol", 1),
    ("CAROL", 2),
    ("Eve", 5),       # joined AFTER "eve" below, despite the lower pk
    ("eve", 3),
    ("Tie", 7),       # same date_joined as "tie"; lower pk wins
    ("tie", 7),
    ("dave", 1),
    ("has.dot", 1),
    ("user@example.com", 1),
    ("ünicode", 1),
    ("x" * 31, 1),
    ("Support", 1),   # reserved word: no automatic handle
    ("k", 1),
    ("\u212a", 9),    # KELVIN SIGN, later than "k"
]


def _migrate(targets):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(targets)
    return executor


def _creator_model(executor, targets):
    nodes = [t for t in targets if t[1] is not None]
    return executor.loader.project_state(nodes).apps.get_model(
        "g12f", "Creator"
    )


def _seed(Creator):
    ids = {}
    for username, days in FIXTURE:
        row = Creator._default_manager.create(
            username=username,
            password="",
            date_joined=T0 + timedelta(days=days),
        )
        ids[username] = row.pk
    return ids


def _column_exists():
    with connection.cursor() as cursor:
        cols = connection.introspection.get_table_description(
            cursor, "g12f_creator"
        )
    return any(c.name == "username_ci_legacy" for c in cols)


def _constraints():
    with connection.cursor() as cursor:
        return connection.introspection.get_constraints(cursor, "g12f_creator")


def _handle_table_exists():
    return "handles_messaginghandle" in connection.introspection.table_names()


def _state():
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT username FROM g12f_creator WHERE username_ci_legacy = username "
            "ORDER BY username"
        )
        exempt = [r[0] for r in cursor.fetchall()]
        cursor.execute(
            "SELECT h.handle, c.username, h.source, h.status "
            "FROM handles_messaginghandle h JOIN g12f_creator c "
            "ON c.id = h.user_id ORDER BY h.handle"
        )
        handles = cursor.fetchall()
        cursor.execute("SELECT username FROM g12f_creator ORDER BY id")
        usernames = [r[0] for r in cursor.fetchall()]
    return exempt, handles, usernames


@pytest.fixture
def at_before():
    executor = _migrate(BEFORE)
    yield _creator_model(executor, BEFORE)
    # Leave the database at the full graph for whatever runs next.
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())


@pytest.mark.django_db(transaction=True)
def test_forward_resolves_collisions_without_touching_a_username(at_before):
    ids = _seed(at_before)
    assert not _column_exists()
    assert not _handle_table_exists()

    _migrate(AFTER)
    exempt, handles, usernames = _state()

    # Nothing renamed, nothing deleted.
    assert usernames == [u for u, _ in FIXTURE]

    # Everyone but the earliest account in each LOWER() group.
    assert "carol" in exempt and "CAROL" in exempt and "Carol" not in exempt
    assert "Eve" in exempt and "eve" not in exempt
    assert "tie" in exempt and "Tie" not in exempt
    assert "dave" not in exempt and "k" not in exempt

    assert [h for h in handles if h[0] != "k"] == [
        ("carol", "Carol", "username", "bound"),
        ("dave", "dave", "username", "bound"),
        ("eve", "eve", "username", "bound"),
        ("tie", "Tie", "username", "bound"),
    ]
    # The ASCII account owns "k"; the Kelvin-sign account owns nothing.
    assert ("k", "k", "username", "bound") in handles
    assert not any(h[1] == "\u212a" for h in handles)
    assert len(handles) == 5
    assert ids  # the fixture really seeded


@pytest.mark.django_db(transaction=True)
def test_after_forward_the_database_refuses_new_case_duplicates(at_before):
    _seed(at_before)
    executor = _migrate(AFTER)
    Current = _creator_model(executor, AFTER)
    for username in ("cArOl", "DAVE", "eVe", "SUPPORT", "Tie"):
        with pytest.raises(IntegrityError), transaction.atomic():
            Current._default_manager.create(
                username=username, password="", date_joined=T0
            )

    # An exempt account is exempt only under its legacy name. Renamed, it is
    # back inside the index, so the new name cannot be duplicated either.
    Current._default_manager.filter(username="CAROL").update(username="Renamed")
    with pytest.raises(IntegrityError), transaction.atomic():
        Current._default_manager.create(
            username="renamed", password="", date_joined=T0
        )

    # A pod still on the previous release knows nothing about the column. Its
    # INSERT omits it; the database default fills it in, so a new name works
    # and a duplicate is still refused.
    Old = at_before
    Old._default_manager.create(username="brand_new", password="")
    with pytest.raises(IntegrityError), transaction.atomic():
        Old._default_manager.create(username="BRAND_NEW", password="")


@pytest.mark.django_db(transaction=True)
def test_rollback_refuses_to_drop_bindings(at_before):
    """A rollback must never delete a binding: it may already be published."""
    _seed(at_before)
    _migrate(AFTER)
    before = _state()

    with pytest.raises(Exception, match="refusing to drop messaging handle"):
        _migrate(BEFORE)

    # Nothing was dropped or deleted: the refusing migration's transaction
    # rolled back, and every binding is still there. (g12f may have been
    # rolled back independently; it does not depend on this app.)
    assert _handle_table_exists()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT h.handle, h.user_id FROM handles_messaginghandle h "
            "ORDER BY h.handle"
        )
        assert [h for h, _ in cursor.fetchall()] == [h[0] for h in before[1]]


@pytest.mark.django_db(transaction=True)
def test_rolling_back_the_reservation_keeps_every_row(at_before):
    """F1 (adversarial review): the reverse of 0002 deletes nothing.

    The dangerous sequence was: roll back 0002 (deleting username-sourced
    rows, including RETIRED ones), re-apply it, and a new account whose
    username folds to a retired handle is given that already-published handle.
    """
    ids = _seed(at_before)
    _migrate(AFTER)
    with connection.cursor() as cursor:
        # dave's account was deleted after the handle was published: retired.
        cursor.execute(
            "UPDATE handles_messaginghandle SET status = 'retired', "
            "user_id = NULL WHERE handle = 'dave'"
        )
        cursor.execute("DELETE FROM g12f_creator WHERE id = %s", [ids["dave"]])
        cursor.execute(
            "INSERT INTO handles_messaginghandle (handle, user_id, status,"
            " source, created_at, updated_at) VALUES"
            " ('dotted', %s, 'bound', 'claimed', now(), now())",
            [ids["has.dot"]],
        )
        cursor.execute(
            "SELECT handle, user_id, status, source FROM "
            "handles_messaginghandle ORDER BY handle"
        )
        rows = cursor.fetchall()

    _migrate([("handles", "0001_initial")])
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT handle, user_id, status, source FROM "
            "handles_messaginghandle ORDER BY handle"
        )
        assert cursor.fetchall() == rows

    # A new "Dave" signs up, and 0002 is re-applied: the retired handle stays
    # retired and unowned.
    executor = _migrate(AFTER)
    Creator = _creator_model(executor, AFTER)
    newcomer = Creator._default_manager.create(username="Dave", password="")
    _migrate([("handles", "0001_initial")])
    _migrate(AFTER)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT user_id, status FROM handles_messaginghandle "
            "WHERE handle = 'dave'"
        )
        assert cursor.fetchall() == [(None, "retired")]
        cursor.execute(
            "SELECT count(*) FROM handles_messaginghandle WHERE user_id = %s",
            [newcomer.pk],
        )
        assert cursor.fetchone() == (0,)


@pytest.mark.django_db(transaction=True)
def test_an_emptied_table_rolls_back_and_forward_again_identically(at_before):
    """The deliberate manual path: empty the table, then roll back."""
    _seed(at_before)
    _migrate(AFTER)
    first = _state()
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM handles_messaginghandle")

    _migrate(BEFORE)
    assert not _column_exists()
    assert not _handle_table_exists()
    assert "creator_username_ci_unique" not in _constraints()
    with connection.cursor() as cursor:
        cursor.execute("SELECT username FROM g12f_creator ORDER BY id")
        assert [r[0] for r in cursor.fetchall()] == [u for u, _ in FIXTURE]

    _migrate(AFTER)
    assert _state() == first


@pytest.mark.django_db(transaction=True)
def test_the_documented_residuals_of_the_username_index(at_before):
    """Pins the two gaps 0110's docstring states, so the doc stays true.

    In a legacy group the database protects the name only while the winner
    holds it. Outside a race, the serializer's ``username__iexact`` check is
    what refuses these; the database does not.
    """
    from dj.apps.g12f.serializers.creator import RegistrationSerializer

    _seed(at_before)
    executor = _migrate(AFTER)
    Creator = _creator_model(executor, AFTER)
    rows = Creator._default_manager

    # 1. The winner renames away: the DB accepts one new "carol" variant
    #    beside the two exempt rows. The serializer still refuses it.
    assert not RegistrationSerializer(
        data={"username": "cARol", "password": "x" * 12}
    ).is_valid()
    rows.filter(username="Carol").update(username="Caroline")
    rows.create(username="cARol", password="")
    with pytest.raises(IntegrityError), transaction.atomic():
        rows.create(username="caROL", password="")  # but only one

    # 2. Rename-back: an exempt account leaves (re-entering the index) and
    #    returns to its exact legacy name, which exempts it again -- even
    #    though "tie" is now held by a new, indexed account.
    rows.filter(username="tie").update(username="tie_away")
    rows.filter(username="Tie").update(username="winner_moved")
    rows.create(username="TIE", password="")
    assert not RegistrationSerializer(
        data={"username": "tie", "password": "x" * 12}
    ).is_valid()
    rows.filter(username="tie_away").update(username="tie")
    assert rows.filter(username__iexact="tie").count() == 2


@pytest.mark.django_db(transaction=True)
def test_the_reservation_is_idempotent(at_before):
    """``handle_census --apply`` re-runs it; a second pass changes nothing."""
    from dj.apps.handles.reservation import reserve_username_handles

    _seed(at_before)
    executor = _migrate(AFTER)
    before = _state()
    apps = executor.loader.project_state(AFTER).apps
    stats = reserve_username_handles(
        apps.get_model("g12f", "Creator"),
        apps.get_model("handles", "MessagingHandle"),
    )
    assert stats.reserved == 0
    assert stats.already_bound == 5
    assert _state() == before


@pytest.mark.django_db(transaction=True)
def test_a_plain_case_insensitive_index_cannot_be_built_over_this_fixture(
    at_before,
):
    """Negative control: the fixture reproduces production's duplicates."""
    _seed(at_before)
    with pytest.raises(IntegrityError), transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "CREATE UNIQUE INDEX ws7_plain_ci ON g12f_creator "
                "(LOWER(username))"
            )
