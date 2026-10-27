"""Django's database settings are transaction-pooling safe.

ledger-v2 §12 puts Django behind PgBouncer in transaction mode. That PR is
infrastructure (owner-gated); this file pins the Django half, which is in force
on today's direct connections too:

* ``DISABLE_SERVER_SIDE_CURSORS`` -- ``QuerySet.iterator()`` must not DECLARE a
  cursor that a later fetch, on another pooled backend, cannot find. Checked
  in both settings modules and by watching ``pg_cursors`` mid-iteration, with
  the negative control flipping the setting back and seeing the cursor.
* ``prepare_threshold=None`` in both settings modules (the worker-pool side,
  and a real pool connection, are in ``jobs/test_procrastinate_pgbouncer.py``).
* The ORM does not depend on the session ``TimeZone``. Django issues
  ``SET TIME ZONE`` at connect only when the server's zone differs from UTC,
  and that SET is session state a pooler owns. Stock Django DID depend on it:
  its psycopg 3 ``timestamptz`` loader relabels rather than converts, so under
  a non-UTC session a stored instant came back hours off (measured: 11:30 UTC
  read as 01:15 UTC the next day). ``dj.util.db_timezone`` swaps in a
  converting loader; Django's date functions already say
  ``AT TIME ZONE 'UTC'`` themselves. The test puts the session in
  Pacific/Chatham (+13:45 in January, so the local calendar day differs from
  UTC's); one negative control proves that zone really is in effect for SQL
  that does not pin its zone, and another re-installs Django's stock loader
  and sees the wrong read come back. The remaining owner action -- set the
  Cloud SQL ``timezone`` flag to ``UTC`` so the connect-time SET never fires
  -- is in the  PR body.
"""

import datetime
import os

import pytest
from django.conf import Settings, settings
from django.db import connection
from django.db.models.functions import ExtractHour, TruncDate


def _prod_settings(monkeypatch):
    # prod_settings reads DBPASS while building DATABASES; nothing connects.
    monkeypatch.setenv("DBPASS", os.environ.get("DBPASS", "unused"))
    return Settings("dj.free2z.prod_settings")


def test_both_settings_modules_disable_server_side_cursors(monkeypatch):
    prod = _prod_settings(monkeypatch)
    for label, databases in (
        ("settings", settings.DATABASES),
        ("prod_settings", prod.DATABASES),
    ):
        default = databases["default"]
        if "postgresql" not in default["ENGINE"]:
            continue
        assert default.get("DISABLE_SERVER_SIDE_CURSORS") is True, label
        options = default.get("OPTIONS", {})
        assert "prepare_threshold" in options, label
        assert options["prepare_threshold"] is None, label
        # The pre-existing option must survive the edit.
        assert options.get("connect_timeout"), label
    assert prod.DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] is True


@pytest.mark.django_db
def test_the_live_connection_does_not_prepare():
    if connection.vendor != "postgresql":
        pytest.skip("psycopg 3 only")
    connection.ensure_connection()
    assert connection.connection.prepare_threshold is None


def _open_cursors_while_iterating(creator_factory):
    for index in range(3):
        creator_factory(username=f"cursor-probe-{index}")
    from django.contrib.auth import get_user_model

    seen = []
    rows = get_user_model().objects.filter(
        username__startswith="cursor-probe-"
    ).order_by("pk")
    for _row in rows.iterator(chunk_size=1):
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM pg_cursors")
            seen.append(cursor.fetchone()[0])
    return seen


@pytest.mark.django_db(transaction=True)
def test_iterator_declares_no_server_side_cursor(creator_factory):
    if connection.vendor != "postgresql":
        pytest.skip("server-side cursors are PostgreSQL-only")
    assert connection.get_autocommit()  # the WITH HOLD case, i.e. the cron jobs
    seen = _open_cursors_while_iterating(creator_factory)
    assert seen == [0, 0, 0]


@pytest.mark.django_db(transaction=True)
def test_negative_control_the_probe_sees_a_server_side_cursor(
    creator_factory, monkeypatch
):
    if connection.vendor != "postgresql":
        pytest.skip("server-side cursors are PostgreSQL-only")
    monkeypatch.setitem(
        connection.settings_dict, "DISABLE_SERVER_SIDE_CURSORS", False
    )
    seen = _open_cursors_while_iterating(creator_factory)
    assert seen and all(count >= 1 for count in seen), seen


# 11:30 UTC on Jan 1 is 01:15 on Jan 2 in Pacific/Chatham (+13:45).
_INSTANT = datetime.datetime(2026, 1, 1, 11, 30, tzinfo=datetime.timezone.utc)


def _creator_in_a_chatham_session(creator_factory):
    from django.contrib.auth import get_user_model

    Creator = get_user_model()
    creator = creator_factory(username="tz-probe")
    Creator.objects.filter(pk=creator.pk).update(date_joined=_INSTANT)
    with connection.cursor() as cursor:
        # LOCAL: the test's own transaction, never the pooled session.
        cursor.execute("SET LOCAL TIME ZONE 'Pacific/Chatham'")
    return Creator.objects.filter(pk=creator.pk)


@pytest.mark.django_db
def test_negative_control_stock_django_misreads_under_a_non_utc_session(
    creator_factory,
):
    if connection.vendor != "postgresql":
        pytest.skip("session TimeZone is PostgreSQL state")
    from django.db.backends.postgresql.psycopg_any import register_tzloader

    from psycopg.postgres import types
    from psycopg.pq import Format

    qs = _creator_in_a_chatham_session(creator_factory)
    adapters = connection.connection.adapters
    previous = adapters.get_loader(types["timestamptz"].oid, Format.TEXT)
    register_tzloader(connection.timezone, connection.connection)
    try:
        read_back = qs.values_list("date_joined", flat=True).get()
    finally:
        # Put back exactly what was there, so this control cannot make the
        # real test below pass by installing the fix itself.
        adapters.register_loader("timestamptz", previous)
    assert read_back == datetime.datetime(
        2026, 1, 2, 1, 15, tzinfo=datetime.timezone.utc
    )
    assert read_back != _INSTANT


@pytest.mark.django_db
def test_the_orm_is_utc_whatever_the_session_time_zone(creator_factory):
    if connection.vendor != "postgresql":
        pytest.skip("session TimeZone is PostgreSQL state")
    assert settings.USE_TZ is True
    assert settings.TIME_ZONE == "UTC"

    qs = _creator_in_a_chatham_session(creator_factory)
    creator = qs.get()
    instant = _INSTANT

    with connection.cursor() as cursor:
        cursor.execute("SHOW TimeZone")
        assert cursor.fetchone()[0] == "Pacific/Chatham"
        # NEGATIVE CONTROL: SQL that does not pin its zone sees Jan 2 here,
        # so the assertions below are not passing because the zone is UTC.
        cursor.execute(
            "SELECT date_joined::date FROM g12f_creator WHERE id = %s",
            [creator.pk],
        )
        assert cursor.fetchone()[0] == datetime.date(2026, 1, 2)

    read_back = qs.values_list("date_joined", flat=True).get()
    assert read_back == instant
    assert creator.date_joined == instant
    assert read_back.utcoffset() == datetime.timedelta(0)
    assert qs.filter(date_joined__date=datetime.date(2026, 1, 1)).exists()
    assert not qs.filter(date_joined__date=datetime.date(2026, 1, 2)).exists()
    annotated = qs.annotate(
        day=TruncDate("date_joined"), hour=ExtractHour("date_joined")
    ).values("day", "hour").get()
    assert annotated == {"day": datetime.date(2026, 1, 1), "hour": 11}
