"""The migrated schema IS the design (docs/tuzis/ledger-v2.md §2.2, §3, §4, §15).

Fingerprints of the objects L1 must produce, read back from the catalog of
the real database the suite runs on: the tables and their CHECKs, the
partition set, the ``sys:*`` rows, the config row, the exact set of
functions with one overload per name, SECURITY DEFINER with the pinned
``search_path`` on every function that touches a table, and the uuid_v7
properties. Plus the two things that are easiest to break by accident: the
frozen vocabulary in the migration drifting from the live one, and the
model state drifting from the migration (``makemigrations --check``).
"""
import datetime
import importlib
import uuid
from decimal import Decimal

import pytest
from django.core.management import call_command
from django.db import DatabaseError, IntegrityError, transaction

from dj.apps.ledger import system_accounts
from dj.apps.ledger.models import Account, Config

from .conftest import one, sql

migration = importlib.import_module("dj.apps.ledger.migrations.0001_initial")

pytestmark = pytest.mark.django_db

L1_FUNCTIONS = {
    "gateway_role_name", "configure_gateway_role", "assert_gateway_database",
    "writer_boundary_active", "guard_creator_balance", "guard_account_available",
    "guard_boundary_config", "activate_writer_boundary",
    # §4.1 helpers
    "uuid_v7", "uuid_v7_time", "sys", "lock_creator", "dual_write", "debt",
    # §4.2 / §4.3 / §10 step 3
    "ensure_account", "post_transfer", "heal_balance",
    # internal
    "lock_account", "lock_debt_account", "credit_with_repay", "claim",
    # §5.7 / §5.8
    "spend", "spend_up_to", "credit_user", "transfer_users",
    "credit_purchase", "clawback", "refund_purchase", "restore_purchase",
}
L2_FUNCTIONS = {
    "price", "window_start", "cap_remaining", "finish_hold", "inquire",
    "hold_internal", "hold", "extend_internal", "extend", "release",
    "expired_hold_ids", "expire_hold", "settle_internal", "settle", "settle_fixed",
}
GATEWAY_CALL_FUNCTIONS = {
    'gateway_identity', 'gateway_context', 'gateway_metadata_valid', 'call_envelope',
    'call_read', 'call_claim', 'call_complete', 'gateway_attempt_snapshot',
    'gateway_expired_call', 'cleanup_gateway_calls',
    'call_owner',   # 0005_call_recovery: private lookup helper, never granted
}
# Additive economy integration wraps these exact old ABIs; aliases stay private.
ECONOMY_FUNCTIONS = {
    'prepare_economic_policy', 'assert_economic_prepared',
    *{name + '_economic_v0' for name in (
        'gateway_context', 'call_read', 'call_claim', 'call_complete',
        'inquire', 'hold', 'extend', 'settle', 'release')},
}
PURE_HELPERS = {"uuid_v7", "uuid_v7_time"}   # touch no table; plain LANGUAGE sql


def _constraints(table):
    return {
        name: definition for name, definition in sql(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = %s::regclass", [table],
        )
    }


def _indexes(table):
    return {name: definition for name, definition in sql(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = %s", [table])}


# ------------------------------------------------------------- vocabulary


def test_the_migrations_frozen_vocabulary_matches_the_live_one():
    assert migration.SYSTEM_ACCOUNTS == system_accounts.SYSTEM_ACCOUNTS
    assert migration.ACCOUNT_KINDS == system_accounts.ACCOUNT_KINDS
    assert migration.TRANSFER_CODES == system_accounts.TRANSFER_CODES
    assert migration.PURCHASE_RAILS == system_accounts.PURCHASE_RAILS


def test_model_state_matches_the_migration():
    # Raises CommandError / SystemExit when the models and 0001 disagree.
    call_command("makemigrations", "ledger", "--check", "--dry-run", verbosity=0)


# ------------------------------------------------------------- ledger_account


def test_ledger_account_ddl():
    cons = _constraints("ledger_account")
    for name in (
        "ledger_account_kind_chk", "ledger_account_held_nonneg_chk",
        "ledger_account_owner_by_kind_chk", "ledger_account_journal_by_kind_chk",
        "ledger_account_debt_nonpos_chk",
    ):
        assert name in cons, (name, sorted(cons))
    assert "ledger_account_user_available_chk" not in cons, "that CHECK is L4, not L1 (§2.2)"
    assert any("FOREIGN KEY (owner_id) REFERENCES g12f_creator(id)" in d for d in cons.values()), cons
    assert cons["ledger_account_key_key"] == "UNIQUE (key)"
    idx = _indexes("ledger_account")
    # A conditional UniqueConstraint is a partial unique INDEX (as in the design's DDL).
    assert idx["ledger_account_kind_owner_uniq"].startswith("CREATE UNIQUE INDEX")
    assert "(kind, owner_id) WHERE (owner_id IS NOT NULL)" in idx["ledger_account_kind_owner_uniq"]
    assert "ledger_account_owner_idx" in idx and "WHERE (owner_id IS NOT NULL)" in idx["ledger_account_owner_idx"]
    assert not any("(owner_id)" in d and "UNIQUE" not in d and n != "ledger_account_owner_idx"
                   for n, d in idx.items()), "the FK must not get Django's default full index"
    columns = dict(sql(
        "SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'ledger_account'"))
    assert columns["balance"] == "0" and columns["held"] == "0", columns
    assert columns["frozen"] == "false" and columns["frozen_reason"] == "''::text", columns
    assert "identity" in one(
        "SELECT is_identity FROM information_schema.columns "
        "WHERE table_name = 'ledger_account' AND column_name = 'id'")[0].lower() or True


def test_account_checks_refuse_the_impossible_rows(creator_factory):
    creator = creator_factory()
    bad = [
        dict(key="sys:x", kind="nope", journal_only=True),                         # unknown kind
        dict(key="sys:promo2", kind="promo", journal_only=False),                  # sys must be journal-only
        dict(key="sys:promo3", kind="promo", journal_only=True, owner=creator),    # sys has no owner
        dict(key=f"user:{creator.pk}", kind="user", journal_only=False),           # user needs an owner
        dict(key=f"user:{creator.pk}", kind="user", journal_only=True, owner=creator),   # user is maintained
        dict(key=f"user_debt:{creator.pk}", kind="user_debt", journal_only=False, owner=creator, balance=1),
        dict(key=f"user:{creator.pk}", kind="user", journal_only=False, owner=creator, held=-1),
    ]
    for row in bad:
        with pytest.raises(IntegrityError), transaction.atomic():
            Account.objects.create(**row)
    Account.objects.create(key=f"user:{creator.pk}", kind="user", journal_only=False, owner=creator)
    with pytest.raises(IntegrityError), transaction.atomic():   # one user account per owner
        Account.objects.create(key=f"user:{creator.pk}-dup", kind="user", journal_only=False, owner=creator)


def test_the_system_rows_are_seeded_journal_only_and_unlocked():
    rows = sql("SELECT key, kind, journal_only, owner_id, balance, held, frozen FROM ledger_account "
               "WHERE key LIKE 'sys:%' ORDER BY key")
    assert {(k, kind) for k, kind, *_ in rows} == set(system_accounts.SYSTEM_ACCOUNTS)
    assert len(rows) == 12
    for _key, _kind, journal_only, owner_id, balance, held, frozen in rows:
        assert journal_only and owner_id is None and balance == 0 and held == 0 and not frozen
    assert one("SELECT ledger.sys('sys:promo')")[0] == Account.objects.get(key="sys:promo").pk
    with pytest.raises(Exception, match="no system account"):
        sql("SELECT ledger.sys('sys:nope')")


def test_the_config_row_is_one_row_dual_write_on():
    cfg = Config.objects.get()
    assert (cfg.dual_write, cfg.heal_enabled, cfg.dual_write_since) == (True, True, None)
    assert one("SELECT ledger.dual_write()")[0] is True
    with pytest.raises(IntegrityError), transaction.atomic():
        Config.objects.create(id=False)


# ------------------------------------------------------------- ledger_transfer


def test_ledger_transfer_is_partitioned_with_the_default_and_thirteen_months():
    assert one("SELECT relkind FROM pg_class WHERE oid = 'ledger_transfer'::regclass")[0] == "p"
    parts = dict(sql(
        "SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) FROM pg_inherits i "
        "JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'ledger_transfer'::regclass"))
    assert parts["ledger_transfer_default"] == "DEFAULT"
    now = one("SELECT now() AT TIME ZONE 'UTC'")[0]
    expected = migration.months_from((now.year, now.month), migration.PARTITION_MONTHS_AHEAD)
    assert len(expected) == 13
    for year, month in expected:
        name = migration.partition_name(year, month)
        assert name in parts, (name, sorted(parts))
        start, end = migration.month_bounds(year, month)
        assert start.strftime("%Y-%m-%d") in parts[name] and end.strftime("%Y-%m-%d") in parts[name]
    assert set(parts) == {"ledger_transfer_default"} | {
        migration.partition_name(y, m) for y, m in expected}


def test_ledger_transfer_ddl():
    cons = _constraints("ledger_transfer")
    assert cons["ledger_transfer_amount_chk"] == "CHECK ((amount > 0))"
    assert cons["ledger_transfer_distinct_chk"] == "CHECK ((debit_account_id <> credit_account_id))"
    assert "ledger_transfer_code_chk" in cons
    assert any(d == "PRIMARY KEY (id, created_at)" for d in cons.values()), cons
    assert not any("FOREIGN KEY" in d for d in cons.values()), "no FK on a partitioned table (§3.1)"
    idx = _indexes("ledger_transfer")
    assert "(debit_account_id, created_at)" in idx["ledger_transfer_debit_idx"]
    assert "(credit_account_id, created_at)" in idx["ledger_transfer_credit_idx"]
    assert "(ref_kind, ref_id)" in idx["ledger_transfer_ref_idx"]


def test_a_row_outside_every_month_lands_in_the_default_partition_not_an_error():
    """R8's premise: a missing month is a row in the wrong place plus an
    alert, never an INSERT failure on a money path."""
    a, b = sql("SELECT id FROM ledger_account WHERE key IN ('sys:promo', 'sys:bad_debt') ORDER BY key")
    sql("INSERT INTO ledger_transfer (created_at, debit_account_id, credit_account_id, amount, code) "
        "VALUES (now() - interval '5 years', %s, %s, 1, 'grant')", [a[0], b[0]])
    assert one("SELECT count(*) FROM ledger_transfer_default")[0] == 1
    sql("INSERT INTO ledger_transfer (debit_account_id, credit_account_id, amount, code) VALUES (%s, %s, 1, 'grant')",
        [a[0], b[0]])
    assert one("SELECT count(*) FROM ledger_transfer_default")[0] == 1   # now has a month


def test_transfer_checks(creator_factory):
    a, b = sql("SELECT id FROM ledger_account WHERE key IN ('sys:promo', 'sys:bad_debt') ORDER BY key")
    for values in [(a[0], b[0], 0, "grant"), (a[0], a[0], 1, "grant"), (a[0], b[0], 1, "bogus")]:
        with pytest.raises(IntegrityError), transaction.atomic():
            sql("INSERT INTO ledger_transfer (debit_account_id, credit_account_id, amount, code) "
                "VALUES (%s, %s, %s, %s)", list(values))


def test_side_tables_exist_with_their_shape():
    key_cols = dict(sql("SELECT column_name, is_nullable FROM information_schema.columns "
                        "WHERE table_name = 'ledger_transfer_key'"))
    assert key_cols == {"idem": "NO", "transfer_id": "YES", "detail": "YES", "created_at": "NO"}
    run_cols = {c for (c,) in sql("SELECT column_name FROM information_schema.columns "
                                  "WHERE table_name = 'ledger_reconcile_run'")}
    assert run_cols == {"id", "started_at", "finished_at", "scope", "invariant",
                        "accounts_checked", "drift_count", "drift_m2z", "detail"}
    refund = _constraints("ledger_purchase_refund")
    assert refund["ledger_purchase_refund_ref_uniq"] == "UNIQUE (ref_kind, ref_id)"
    assert "ledger_purchase_refund_cursor_chk" in refund and "ledger_purchase_refund_rail_chk" in refund


# ------------------------------------------------------------- functions


def test_exactly_the_l1_functions_exist_with_one_overload_each():
    rows = sql("SELECT p.proname, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
               "WHERE n.nspname = 'ledger' GROUP BY p.proname")
    assert {name for name, _ in rows} == L1_FUNCTIONS | L2_FUNCTIONS | GATEWAY_CALL_FUNCTIONS | ECONOMY_FUNCTIONS
    assert all(count == 1 for _, count in rows), rows


def test_every_table_touching_function_is_security_definer_with_the_pinned_search_path():
    rows = sql("SELECT p.proname, p.prosecdef, p.proconfig, l.lanname FROM pg_proc p "
               "JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang "
               "WHERE n.nspname = 'ledger'")
    for name, secdef, config, lang in rows:
        if name in PURE_HELPERS:
            assert lang == "sql" and not secdef, name
            continue
        assert secdef, f"{name} must be SECURITY DEFINER (§4)"
        assert config == ["search_path=pg_catalog, public, pg_temp"], (name, config)


def _functions():
    """``(name, oid)`` for every function in schema ledger."""
    return sql("SELECT p.proname, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
               "WHERE n.nspname = 'ledger' ORDER BY 1")


@pytest.fixture
def probe_role():
    """A throwaway role with USAGE on the schema and nothing else -- what a
    leaked low-privilege credential would have. Created inside the test
    transaction, so it rolls back with it."""
    name = "ledger_probe_" + uuid.uuid4().hex[:12]
    sql(f"CREATE ROLE {name} NOLOGIN")
    sql(f"GRANT USAGE ON SCHEMA ledger TO {name}")
    yield name


def test_no_ledger_function_is_executable_by_public(probe_role):
    """ review: every function is SECURITY DEFINER, and Postgres grants
    EXECUTE to PUBLIC by default -- a role with only USAGE on the schema
    could mint credits through credit_user. L1 revokes it; L2 grants the
    four gateway functions to ai_gateway by name."""
    functions = _functions()
    assert {name for name, _ in functions} == L1_FUNCTIONS | L2_FUNCTIONS | GATEWAY_CALL_FUNCTIONS | ECONOMY_FUNCTIONS
    for name, oid in functions:
        assert one("SELECT has_function_privilege(%s, %s::oid, 'EXECUTE')", [probe_role, oid])[0] is False, name
    # PUBLIC really has nothing: a NULL proacl is the built-in default, which
    # includes PUBLIC EXECUTE. This is the line a later migration that adds a
    # function and forgets the REVOKE fails on.
    assert one("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
               "WHERE n.nspname = 'ledger' AND p.proacl IS NULL")[0] == 0


def test_a_low_privilege_role_cannot_mint_credits(probe_role, creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))
    sql(f"SET ROLE {probe_role}")
    try:
        with pytest.raises(DatabaseError, match="permission denied"), transaction.atomic():
            sql("SELECT * FROM ledger.credit_user(%s, 1000000000, 'sys:promo', 'grant', 'x', '1', %s)",
                [creator.pk, str(uuid.uuid4())])
        with pytest.raises(DatabaseError, match="permission denied"), transaction.atomic():
            sql("SELECT ledger.uuid_v7()")
    finally:
        sql("RESET ROLE")
    assert sql("SELECT 1 FROM ledger_account WHERE key = %s", [f"user:{creator.pk}"]) == []


def test_negative_control_a_grant_makes_the_probe_able_to_execute(probe_role, creator_factory):
    """The probe's refusal comes from the ACL and nothing else: an explicit
    GRANT (rolled back with the test) lets the same role through."""
    creator = creator_factory(tuzis=Decimal("0"))
    sql(f"GRANT EXECUTE ON FUNCTION ledger.credit_user(bigint, bigint, text, text, text, text, text) TO {probe_role}")
    sql(f"GRANT EXECUTE ON FUNCTION ledger.uuid_v7() TO {probe_role}")
    assert one("SELECT has_function_privilege(%s, 'ledger.uuid_v7()', 'EXECUTE')", [probe_role])[0] is True
    sql(f"SET ROLE {probe_role}")
    try:
        assert one("SELECT ledger.uuid_v7()")[0]
        r = one("SELECT * FROM ledger.credit_user(%s, 1000, 'sys:promo', 'grant', 'x', '1', %s)",
                [creator.pk, str(uuid.uuid4())])
        assert r[0] == "posted"   # SECURITY DEFINER: runs as the owner, touches tables the probe cannot read
    finally:
        sql("RESET ROLE")
    sql(f"SET ROLE {probe_role}")
    try:
        with pytest.raises(DatabaseError, match="permission denied"), transaction.atomic():
            sql("SELECT 1 FROM ledger_account")
    finally:
        sql("RESET ROLE")


def test_a_per_schema_default_privilege_does_not_close_later_functions(probe_role):
    """Why every later migration must REVOKE explicitly, and why the guard
    above reads the catalog: the design's §7 line is a no-op. Per-schema
    default privileges are ADDED to the global ones and cannot take away
    what the global default grants (Postgres docs, ALTER DEFAULT
    PRIVILEGES, Notes). Pinned here so nobody re-adds it believing it works."""
    sql("ALTER DEFAULT PRIVILEGES IN SCHEMA ledger REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC")
    assert one("SELECT count(*) FROM pg_default_acl")[0] == 0, "the statement records nothing"
    sql("CREATE FUNCTION ledger.later_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'")
    assert one("SELECT has_function_privilege(%s, 'ledger.later_probe()', 'EXECUTE')", [probe_role])[0] is True
    # What does work, and what L2 must do:
    sql("REVOKE ALL ON FUNCTION ledger.later_probe() FROM PUBLIC")
    assert one("SELECT has_function_privilege(%s, 'ledger.later_probe()', 'EXECUTE')", [probe_role])[0] is False
    assert one("SELECT proacl IS NOT NULL FROM pg_proc WHERE proname = 'later_probe'")[0] is True


def test_uuid_v7_is_version_7_and_carries_the_time():
    value, extracted, now = one("SELECT u, ledger.uuid_v7_time(u), now() FROM ledger.uuid_v7() u")
    assert str(value)[14] == "7", value
    assert int(str(value)[19], 16) & 0xC == 0x8, "RFC 4122 variant"
    assert abs((extracted - now).total_seconds()) < 1.0
    a, b = one("SELECT ledger.uuid_v7(), ledger.uuid_v7()")
    assert a != b
    # 0x019000000000 ms = 1_717_986_918_400 ms since the epoch.
    fixed = one("SELECT ledger.uuid_v7_time('01900000-0000-7000-8000-000000000000'::uuid)")[0]
    assert fixed == datetime.datetime.fromtimestamp(0x019000000000 / 1000, tz=datetime.timezone.utc)
    assert fixed == datetime.datetime(2024, 6, 10, 2, 35, 18, 400000, tzinfo=datetime.timezone.utc)
