"""``manage.py ledger_preflight``: the deploy fence for the ledger's
REVOKE-from-PUBLIC. Real Postgres; the negative control is a real non-owner
role, not a mock."""
from __future__ import annotations

import re
import uuid
from io import StringIO
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection, transaction

from dj.apps.ledger import api
from dj.apps.tuzis.management.commands import ledger_preflight as cmd

pytestmark = pytest.mark.django_db


def sql(query, params=None):
    with connection.cursor() as cursor:
        cursor.execute(query, params)
        return cursor.fetchall() if cursor.description else None


def run():
    out = StringIO()
    call_command("ledger_preflight", stdout=out)
    return out.getvalue()


def test_passes_as_the_migration_role():
    out = run()
    assert "ledger_preflight: OK" in out and f"{len(cmd.WRAPPER_FUNCTIONS)} ledger functions" in out


def test_the_function_list_is_exactly_what_the_wrappers_call():
    """A function api.py starts calling must be added here, or the fence
    proves the wrong set."""
    source = (Path(api.__file__)).read_text()
    called = set(re.findall(r'_(?:call|scalar)\("([a-z_]+)"', source))
    called |= set(re.findall(r'FROM ledger\.([a-z_]+)\(', source))
    assert called == set(cmd.WRAPPER_FUNCTIONS), (sorted(called), sorted(cmd.WRAPPER_FUNCTIONS))


def test_negative_control_a_non_owner_role_is_refused():
    """What a wrong DBUSER in prod would look like: a role that can log in
    and use the schema but does not own the functions."""
    probe = "ledger_preflight_probe_" + uuid.uuid4().hex[:10]
    sql(f"CREATE ROLE {probe} NOLOGIN")
    sql(f"GRANT USAGE ON SCHEMA ledger TO {probe}")
    sql(f"GRANT SELECT ON ledger_account, ledger_config TO {probe}")
    sql(f"SET ROLE {probe}")
    try:
        with pytest.raises(CommandError, match=r"cannot EXECUTE ledger\.spend") as info:
            run()
        assert "refusing to roll pods" in str(info.value)
        assert probe in str(info.value)
        assert str(info.value).count("cannot EXECUTE") == len(cmd.WRAPPER_FUNCTIONS)
    finally:
        sql("RESET ROLE")
    #...and an explicit GRANT is what makes the same role pass: the refusal
    # comes from the ACL and nothing else.
    sql(f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ledger TO {probe}")
    sql(f"SET ROLE {probe}")
    try:
        assert "ledger_preflight: OK" in run()
    finally:
        sql("RESET ROLE")


def test_negative_control_a_missing_seed_row_is_refused():
    with transaction.atomic():
        sql("DELETE FROM ledger_account WHERE key = 'sys:reservation_clearing'")
        with pytest.raises(CommandError, match="sys:reservation_clearing is missing"):
            run()
        sql("DELETE FROM ledger_config")
        with pytest.raises(CommandError, match="ledger_config does not have exactly one row"):
            run()
        transaction.set_rollback(True)


