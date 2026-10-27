"""procrastinate's worker pool behind PgBouncer transaction pooling.

Two things, both about the connections procrastinate opens ITSELF rather than
through Django's ORM:

* **No server-side prepared statements.** ``BoundedDjangoConnector`` builds the
  worker pool from ``connector_params()`` -- Django's own
  ``get_connection_params()`` -- so ``DATABASES OPTIONS prepare_threshold=None``
  must reach every pool connection. psycopg 3's own default is 5: after five
  executions a statement is PREPAREd on one backend and the sixth, routed to
  another by the pooler, fails with ``prepared statement "_pg3_0" does not
  exist``. The negative control opens a connection WITHOUT the inherited
  parameter and sees that default, so the inherited ``None`` is doing work.

* **LISTEN is session state.** ``PROCRASTINATE_LISTEN_NOTIFY=false`` makes the
  billing lane -- the only one started with ``--listen-notify`` -- poll
  instead, without a manifest change. Unset, nothing changes.
"""

import asyncio

import psycopg
import pytest
from django.db import connection
from procrastinate import psycopg_connector
from procrastinate.contrib.django import utils as procrastinate_django_utils

from dj.apps.jobs import procrastinate_pool


def _worker_connector():
    return procrastinate_pool.BoundedDjangoConnector(
        alias="default", pool_size=1
    ).get_worker_connector()


# --- prepare_threshold ------------------------------------------------------


def test_the_worker_pool_is_built_with_prepare_threshold_none():
    params = procrastinate_django_utils.connector_params("default")
    assert "prepare_threshold" in params
    assert params["prepare_threshold"] is None
    assert _worker_connector()._pool_args["kwargs"]["prepare_threshold"] is None


@pytest.mark.django_db
def test_a_real_worker_pool_connection_never_prepares():
    if connection.vendor != "postgresql":
        pytest.skip("psycopg pool connections need PostgreSQL")

    async def inspect():
        connector = _worker_connector()
        await connector.open_async()
        try:
            async with connector.pool.connection() as conn:
                threshold = conn.prepare_threshold
                # Run one statement well past psycopg's default threshold
                # and confirm this backend holds no prepared statement.
                for _ in range(8):
                    await conn.execute("SELECT 1 WHERE %s::int = 1", [1])
                cur = await conn.execute(
                    "SELECT count(*) FROM pg_prepared_statements"
                )
                prepared = (await cur.fetchone())[0]
        finally:
            await connector.close_async()
        return threshold, prepared

    threshold, prepared = asyncio.run(inspect())
    assert threshold is None
    assert prepared == 0


@pytest.mark.django_db
def test_negative_control_psycopg_prepares_without_the_inherited_option():
    """Without ``prepare_threshold`` in the kwargs psycopg DOES prepare."""
    if connection.vendor != "postgresql":
        pytest.skip("psycopg connections need PostgreSQL")

    params = procrastinate_django_utils.connector_params("default")
    params.pop("prepare_threshold")
    with psycopg.connect(**params, autocommit=True) as conn:
        assert conn.prepare_threshold == 5
        for _ in range(8):
            conn.execute("SELECT 1 WHERE %s::int = 1", [1])
        prepared = conn.execute(
            "SELECT count(*) FROM pg_prepared_statements"
        ).fetchone()[0]
    assert prepared >= 1


# --- PROCRASTINATE_LISTEN_NOTIFY --------------------------------------------


def test_listen_notify_defaults_to_todays_behaviour(monkeypatch):
    monkeypatch.delenv("PROCRASTINATE_LISTEN_NOTIFY", raising=False)
    assert procrastinate_pool.listen_notify_enabled() is True
    assert type(_worker_connector()) is psycopg_connector.PsycopgConnector


@pytest.mark.parametrize("value", ["true", "1", "yes", "on", "TRUE", "garbage"])
def test_anything_but_an_explicit_false_keeps_listening(monkeypatch, value):
    monkeypatch.setenv("PROCRASTINATE_LISTEN_NOTIFY", value)
    assert procrastinate_pool.listen_notify_enabled() is True
    assert type(_worker_connector()) is psycopg_connector.PsycopgConnector


@pytest.mark.parametrize("value", ["false", "0", "no", "off", " False "])
def test_false_makes_the_worker_connector_poll(monkeypatch, value):
    monkeypatch.setenv("PROCRASTINATE_LISTEN_NOTIFY", value)
    assert procrastinate_pool.listen_notify_enabled() is False
    connector = _worker_connector()
    assert isinstance(connector, psycopg_connector.PsycopgConnector)
    assert type(connector) is not psycopg_connector.PsycopgConnector
    # Everything but LISTEN is the stock connector, pool sizing included.
    assert connector._pool_args["min_size"] == 1
    assert connector._pool_args["max_size"] == 1


def test_the_disabled_listener_parks_without_opening_a_connection(monkeypatch):
    """It must neither LISTEN nor RETURN.

    Returning would complete procrastinate's side-task monitor
    (``asyncio.wait(..., FIRST_COMPLETED)``), after which a failing heartbeat
    would no longer stop the worker.
    """
    monkeypatch.setenv("PROCRASTINATE_LISTEN_NOTIFY", "false")
    connector = _worker_connector()

    def no_connection(*args, **kwargs):
        raise AssertionError("the disabled listener opened a connection")

    monkeypatch.setattr(connector, "_get_standalone_connection", no_connection)

    async def run():
        async def on_notification(**kwargs):
            raise AssertionError("no notification can arrive")

        task = asyncio.ensure_future(
            connector.listen_notify(on_notification, ["procrastinate_any_queue"])
        )
        done, _pending = await asyncio.wait({task}, timeout=0.2)
        assert not done, "the disabled listener returned"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
