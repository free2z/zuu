"""Read ``timestamptz`` correctly whatever the session ``TimeZone`` is.

Django's psycopg 3 backend loads ``timestamptz`` with
``django.db.backends.postgresql.psycopg_any.BaseTzLoader``, which does::

    return super().load(data).replace(tzinfo=self.timezone)

``replace`` RELABELS the value psycopg parsed -- it does not convert it. That
is only right when the session's ``TimeZone`` already equals Django's (UTC
here), which Django arranges with a ``SET TIME ZONE`` at connect time whenever
the server reports a different zone. Measured on PostgreSQL 16 with the
session in Pacific/Chatham: a row stored as ``2026-01-01 11:30 UTC`` came back
as ``2026-01-02 01:15 UTC`` -- the Chatham wall clock labelled UTC, 13h45m
wrong -- while every date lookup (which Django writes with an explicit
``AT TIME ZONE 'UTC'``) stayed right.

That connect-time SET is SESSION state. Behind PgBouncer in transaction mode
(ledger-v2 §12) it is the pooler, not Django, that decides which backend and
therefore which session zone a query runs in. So this module swaps the loader
for one that CONVERTS (``astimezone``) the instant psycopg already parsed
correctly from the offset on the wire. With the session in UTC -- today, and
after the owner pins the Cloud SQL ``timezone`` flag -- the two are identical
(offset zero), so nothing changes except that the ORM no longer depends on it.

The class keeps ``BaseTzLoader``'s ``timezone`` attribute set to the
connection's zone, so Django's ``create_cursor`` (which re-registers its own
loader when ``self.timezone != loader.timezone``) leaves it in place.
"""

from __future__ import annotations

from functools import lru_cache


@lru_cache
def converting_tz_loader(tz):
    from django.db.backends.postgresql.psycopg_any import BaseTzLoader
    from psycopg.types.datetime import TimestamptzLoader

    class ConvertingTzLoader(BaseTzLoader):
        timezone = tz

        def load(self, data):
            return TimestamptzLoader.load(self, data).astimezone(self.timezone)

    return ConvertingTzLoader


def install_converting_tz_loader(sender, connection, **kwargs) -> None:
    """``connection_created`` receiver: register the converting loader."""
    if connection.vendor != "postgresql":
        return
    from django.db.backends.postgresql.psycopg_any import is_psycopg3

    tz = connection.timezone
    if not is_psycopg3 or tz is None:
        return
    connection.connection.adapters.register_loader(
        "timestamptz", converting_tz_loader(tz)
    )
