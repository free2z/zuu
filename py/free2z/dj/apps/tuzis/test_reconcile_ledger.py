"""``manage.py reconcile_ledger``: reports, records, never fixes."""
from __future__ import annotations

import json
import uuid
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.apps.ledger.models import ReconcileRun
from dj.apps.tuzis.test_ledger_dual_write import journaled_pod_reserves
from dj.apps.tuzis import ledger
from dj.apps.tuzis.management.commands import reconcile_ledger as cmd

pytestmark = pytest.mark.django_db


def run(*args):
    out = StringIO()
    call_command("reconcile_ledger", *args, stdout=out)
    return out.getvalue()


def lines(output, event):
    found = []
    for line in output.splitlines():
        if line.startswith("{"):
            payload = json.loads(line)
            if payload.get("event") == event:
                found.append(payload)
    return found


def heartbeat(output):
    [beat] = lines(output, cmd.RECONCILE_EVENT)
    return beat


def test_a_clean_ledger_reports_zero_drift_and_records_one_run_per_invariant(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    ledger.debit(user, 1, action="comment_vote")
    journaled_pod_reserves(user, 2, scope="ai_image", operation_key=uuid.uuid4())

    out = run()

    beat = heartbeat(out)
    assert beat["status"] == "completed" and beat["scope"] == "full"
    assert beat["drift_total"] == 0
    assert {beat[f"{n.lower()}_drift"] for n in cmd.INVARIANTS} == {0}
    assert beat["user_accounts"] == 1 and beat["active_reservations"] == 1
    assert beat["dual_write"] is True and beat["heal_enabled"] is True
    assert beat["legacy_adjustments_1h"] == 0
    assert lines(out, cmd.DRIFT_EVENT) == []
    runs = {r.invariant: r for r in ReconcileRun.objects.all()}
    assert set(runs) == set(cmd.INVARIANTS)
    assert all(r.drift_count == 0 and r.finished_at is not None and r.scope == "full" for r in runs.values())
    assert runs["R2"].accounts_checked == 1 and runs["R13"].accounts_checked == 1


@pytest.mark.ledger_drift_expected
def test_drift_is_reported_per_invariant_and_never_repaired(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    ledger.debit(user, 1, action="comment_vote")
    # An old pod's write: R2 drift the heal would absorb on the next touch --
    # the reconciler must report it, not touch it.
    with connection.cursor() as cursor:
        cursor.execute("UPDATE g12f_creator SET tuzis = tuzis - 3 WHERE id = %s", [user.pk])
    # Corrupt a maintained balance behind the journal's back: R1 (and R3).
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_account SET balance = balance + 500 WHERE key = %s", [f"user:{user.pk}"])

    out = run()

    drift = {d["invariant"]: d for d in lines(out, cmd.DRIFT_EVENT)}
    assert set(drift) == {"R1", "R2", "R3"}
    assert drift["R1"]["drift_count"] == 1 and drift["R1"]["drift_m2z"] == 500
    assert drift["R1"]["detail"] == [{"account": f"user:{user.pk}", "journal": 9000, "balance": 9500}]
    assert drift["R2"]["detail"] == [{"account": f"user:{user.pk}", "tuzis_m2z": 6000, "balance": 9500}]
    assert drift["R3"]["drift_m2z"] == 500
    beat = heartbeat(out)
    assert beat["drift_total"] == 3 and beat["r13_drift"] == 0
    assert ReconcileRun.objects.get(invariant="R1").drift_m2z == 500
    # Nothing was repaired.
    with connection.cursor() as cursor:
        cursor.execute("SELECT balance FROM ledger_account WHERE key = %s", [f"user:{user.pk}"])
        assert cursor.fetchone()[0] == 9500
    user.refresh_from_db()
    assert user.tuzis == Decimal("6")
    assert not any(l.get("code") == "legacy_adjustment" for l in [])  # no heal row is written by a read
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM ledger_transfer WHERE code = 'legacy_adjustment'")
        assert cursor.fetchone()[0] == 0

    with pytest.raises(CommandError, match="3 ledger invariant"):
        run("--fail-on-drift")


def test_r13_reports_a_reservation_clearing_mismatch(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    row = journaled_pod_reserves(user, 4, scope="ai_image", operation_key=uuid.uuid4())
    # A reservation released behind the ledger's back (what the OLD release
    # did): the row is terminal but the clearing account still holds 4.
    row.status = "released"
    row.save(update_fields=["status"])

    out = run()
    [drift] = lines(out, cmd.DRIFT_EVENT)
    assert drift["invariant"] == "R13" and drift["drift_m2z"] == 4000
    #...and the detail says the drift is entirely a legacy-finalized row
    # (the old code's release), which is what heal_ledger_drift closes.
    assert drift["detail"] == [{
        "reservation_clearing_journal_m2z": 4000, "active_journaled_m2z": 0,
        "legacy_finalized_reservations": 1, "legacy_finalized_m2z": 4000,
    }]
    assert heartbeat(out)["legacy_finalized_reservations"] == 1


def test_the_scheduled_run_is_read_only_over_money_tables_and_repeatable(creator_factory):
    """The CronJob runs it bare every ten minutes and may overlap a manual
    run: two back-to-back runs must issue no statement that writes a money
    table (only their own run-log rows) and report the same thing twice."""
    user = creator_factory(tuzis=Decimal("10"))
    ledger.debit(user, 1, action="comment_vote")
    other = creator_factory(tuzis=Decimal("3"))
    ledger.transfer(other, user, 1, action="donation")
    journaled_pod_reserves(user, 2, scope="ai_image", operation_key=uuid.uuid4())
    with connection.cursor() as cursor:
        cursor.execute("UPDATE g12f_creator SET tuzis = tuzis - 1 WHERE id = %s", [user.pk])
    with connection.cursor() as cursor:
        cursor.execute("SELECT key, balance FROM ledger_account ORDER BY key")
        before_accounts = cursor.fetchall()
        cursor.execute("SELECT id, tuzis FROM g12f_creator ORDER BY id")
        before_tuzis = cursor.fetchall()
        cursor.execute("SELECT count(*) FROM ledger_transfer")
        before_transfers = cursor.fetchone()[0]

    with CaptureQueriesContext(connection) as queries:
        first = run()
        second = run()

    writes = [
        q["sql"] for q in queries.captured_queries
        if not q["sql"].lstrip().upper().startswith("SELECT")
        and not q["sql"].lstrip().upper().startswith("SAVEPOINT")
        and not q["sql"].lstrip().upper().startswith("RELEASE SAVEPOINT")
        and q["sql"].strip().upper() != "SET LOCAL TIME ZONE 'UTC'"
    ]
    assert all('INSERT INTO "ledger_reconcile_run"' in w for w in writes), writes
    assert len(writes) == 2 * len(cmd.INVARIANTS)
    with connection.cursor() as cursor:
        cursor.execute("SELECT key, balance FROM ledger_account ORDER BY key")
        assert cursor.fetchall() == before_accounts
        cursor.execute("SELECT id, tuzis FROM g12f_creator ORDER BY id")
        assert cursor.fetchall() == before_tuzis
        cursor.execute("SELECT count(*) FROM ledger_transfer")
        assert cursor.fetchone()[0] == before_transfers
    strip = lambda beat: {k: v for k, v in beat.items() if k != "duration_ms"}  # noqa: E731
    assert strip(heartbeat(first)) == strip(heartbeat(second))
    assert lines(first, cmd.DRIFT_EVENT) == lines(second, cmd.DRIFT_EVENT)
    assert heartbeat(first)["r2_drift"] == 1, "the old-pod write is reported, not healed"


def test_the_heartbeat_is_the_last_line_and_counts_legacy_adjustments(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    ledger.debit(user, 1, action="comment_vote")
    with connection.cursor() as cursor:
        cursor.execute("UPDATE g12f_creator SET tuzis = tuzis - 3 WHERE id = %s", [user.pk])
    ledger.debit(user, 1, action="comment_vote")   # heals: one legacy_adjustment of 3000
    out = run()
    last = json.loads(out.strip().splitlines()[-1])
    assert last["event"] == cmd.RECONCILE_EVENT and last["status"] == "completed"
    assert last["legacy_adjustments_1h"] == 1 and last["legacy_adjustments_m2z_1h"] == 3000
    assert last["legacy_adjustments_24h"] == 1


def test_refuses_a_bad_detail_limit():
    with pytest.raises(CommandError):
        run("--detail-limit", "0")


@pytest.mark.ledger_drift_expected
@pytest.mark.parametrize('pending_phase', [False, True])
def test_l2_backlog_emits_page_event_even_when_clearing_still_balances(creator_factory, pending_phase):
    from dj.apps.ledger import rollup
    from dj.apps.ledger.tests.test_rollup import fixed_settlement
    from django.db import connection
    user = creator_factory(tuzis=100)
    fixed_settlement(user)
    with connection.cursor() as cursor:
        if pending_phase:
            developer = creator_factory(tuzis=0)
            cursor.execute('UPDATE ledger_ai_split_queue SET developer_creator_id=%s,developer_m2z=2000,platform_m2z=5000', [developer.pk])
            rollup.consume_split_batch()
            cursor.execute("UPDATE ledger_dev_markup_pending SET created_at=now()-interval '6 minutes'")
        else:
            cursor.execute("UPDATE ledger_ai_split_queue SET created_at=now()-interval '6 minutes'")
    out = StringIO()
    with pytest.raises(CommandError):
        call_command('reconcile_ledger', '--fail-on-drift', stdout=out)
    lines = [json.loads(line) for line in out.getvalue().splitlines() if line.startswith('{')]
    alert = next(line for line in lines if line['event'] == 'ledger_reconcile_drift' and line['invariant'] == 'R7')
    assert alert['drift_count'] == 1 and alert['drift_m2z'] == 0
    assert lines[-1]['r7_drift'] == 1


@pytest.mark.django_db(transaction=True)
def test_reconciliation_uses_one_snapshot_across_invariants(creator_factory, monkeypatch):
    """A committed change after R1 must not leak into this run's R4 view."""
    import psycopg
    from dj.apps.ledger import api
    user = creator_factory(tuzis=0)
    api.ensure_account(user.pk)
    with connection.cursor() as cursor:
        cursor.execute("SELECT key FROM ledger_account WHERE owner_id=%s AND kind='user'", [user.pk])
        account = cursor.fetchone()[0]
    other = psycopg.connect(**connection.get_connection_params(), autocommit=True)
    original = cmd.invariants.r1_maintained_balance_equals_journal

    def change_after_r1():
        result = original()
        other.execute('UPDATE ledger_account SET held=held+1 WHERE key=%s', [account])
        return result

    monkeypatch.setattr(cmd.invariants, 'r1_maintained_balance_equals_journal', change_after_r1)
    try:
        beat = heartbeat(run())
        assert beat['r4_drift'] == 0
        assert other.execute('SELECT held FROM ledger_account WHERE key=%s', [account]).fetchone()[0] == 1
    finally:
        monkeypatch.setattr(cmd.invariants, 'r1_maintained_balance_equals_journal', original)
        other.execute('UPDATE ledger_account SET held=held-1 WHERE key=%s', [account])
        other.close()
