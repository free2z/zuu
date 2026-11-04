"""``manage.py heal_ledger_drift``: the two cases the lazy self-heal
cannot reach, found by the codex adversarial review -- a dormant drifted
account, and the REVERSE mixed fleet (a reservation the new code journaled
and a pod on the previous image then finalized)."""
from __future__ import annotations

import json
import uuid
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import call_command
from django.db import connection
from django.utils import timezone

from dj.apps.ledger import api, invariants
from dj.apps.ledger.models import Transfer
from dj.apps.tuzis.test_ledger_dual_write import journaled_pod_reserves
from dj.apps.tuzis import ledger, ledger_audit
from dj.apps.tuzis.models import ProviderReservation

pytestmark = pytest.mark.django_db


def run(*args):
    out = StringIO()
    call_command("heal_ledger_drift", *args, stdout=out)
    return [json.loads(line) for line in out.getvalue().splitlines() if line.startswith("{")]


def reconcile():
    out = StringIO()
    call_command("reconcile_ledger", stdout=out)
    lines = [json.loads(line) for line in out.getvalue().splitlines() if line.startswith("{")]
    return [line for line in lines if line["event"] == "ledger_reconcile"][0], \
        {line["invariant"]: line for line in lines if line["event"] == "ledger_reconcile_drift"}


def old_pod_writes(creator, delta):
    with connection.cursor() as cursor:
        cursor.execute("UPDATE g12f_creator SET tuzis = tuzis + %s WHERE id = %s", [Decimal(delta), creator.pk])


def old_pod_releases(row):
    """The previous image's release: tuzis back, row terminal, no journal leg."""
    old_pod_writes(row.user, row.amount)
    ProviderReservation.objects.filter(pk=row.pk).update(status="released", finished_at=timezone.now())


def old_pod_settles(row):
    ProviderReservation.objects.filter(pk=row.pk).update(status="settled", finished_at=timezone.now())


def journal(**where):
    return list(Transfer.objects.filter(**where).order_by("id").values_list(
        "code", "ref_kind", "ref_id", "amount", "debit_account_id", "credit_account_id"))


def test_dormant_r2_drift_is_healed_only_with_apply(creator_factory):
    dormant = creator_factory(tuzis=Decimal("10"))
    ledger.debit(dormant, 1, action="comment_vote")      # new pod opens the account at 10, now 9
    old_pod_writes(dormant, "-4")                        # old pod; the user never comes back
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{dormant.pk}", 5000, 9000)]

    [dry] = run()
    assert dry["status"] == "dry_run" and dry["r2_drifted_accounts"] == 1 and dry["r2_drift_m2z"] == 4000
    assert invariants.r2_tuzis_projection_equals_balance() != [], "a dry run touches nothing"
    assert journal(code="legacy_adjustment") == []

    _, done = run("--apply")
    assert done["status"] == "completed" and done["healed_accounts"] == 1 and done["healed_m2z"] == 4000
    assert done["remaining_r2_drifted_accounts"] == 0
    heals = journal(code="legacy_adjustment")
    assert len(heals) == 1 and heals[0][3] == 4000 and heals[0][5] == api.system_account_id("sys:opening_equity")
    invariants.assert_all()


@pytest.mark.ledger_drift_expected
def test_a_reservation_released_by_the_old_code_is_closed(creator_factory):
    """New code reserves (journaled into reservation_clearing); the request
    dies; a pod on the previous image releases it (tuzis back, no leg). The
    user side heals on the next touch, the clearing side cannot -- until
    heal_ledger_drift posts the closing leg. R3 holds throughout."""
    user = creator_factory(tuzis=Decimal("10"))
    row = journaled_pod_reserves(user, 6, scope="ai_image", operation_key=uuid.uuid4())
    old_pod_releases(row)
    row.refresh_from_db()
    assert row.status == "released" and user.__class__.objects.get(pk=user.pk).tuzis == Decimal("10")
    assert ledger_audit.legacy_finalized_reservations() == [(row.pk, "released", 6000)]
    assert ledger_audit.r13_reservation_clearing_equals_active_journaled_holds() == (6000, 0)
    beat, drift = reconcile()
    assert beat["legacy_finalized_reservations"] == 1 and beat["legacy_finalized_m2z"] == 6000
    assert drift["R13"]["detail"][0]["legacy_finalized_reservations"] == 1
    assert invariants.r3_all_accounts_sum_to_zero() == 0

    ledger.debit(user, 1, action="comment_vote")        # the user side heals on the next touch
    assert invariants.r2_tuzis_projection_equals_balance() == []
    assert ledger_audit.r13_reservation_clearing_equals_active_journaled_holds() == (6000, 0), "clearing still holds it"

    _, done = run("--apply")
    assert done["closed_reservations"] == 1 and done["closed_m2z"] == 6000
    assert done["remaining_legacy_finalized_reservations"] == 0
    closing = journal(ref_kind="reservation", ref_id=str(row.pk), code="legacy_adjustment")
    assert closing == [("legacy_adjustment", "reservation", str(row.pk), 6000,
                        api.system_account_id("sys:reservation_clearing"), api.system_account_id("sys:opening_equity"))]
    assert ledger_audit.r13_reservation_clearing_equals_active_journaled_holds() == (0, 0)
    beat, drift = reconcile()
    assert beat["drift_total"] == 0 and beat["legacy_finalized_reservations"] == 0
    invariants.assert_all()
    assert run("--apply")[1]["closed_reservations"] == 0, "idempotent"


@pytest.mark.ledger_drift_expected
def test_a_reservation_settled_by_the_old_code_is_closed_into_revenue(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    row = journaled_pod_reserves(user, 6, scope="ai_image", operation_key=uuid.uuid4())
    old_pod_settles(row)
    assert ledger_audit.legacy_finalized_reservations() == [(row.pk, "settled", 6000)]
    _, done = run("--apply")
    assert done["closed_reservations"] == 1
    assert journal(ref_kind="reservation_settle", ref_id=str(row.pk)) == [
        ("spend", "reservation_settle", str(row.pk), 6000,
         api.system_account_id("sys:reservation_clearing"), api.system_account_id("sys:platform_revenue"))]
    assert ledger_audit.r13_reservation_clearing_equals_active_journaled_holds() == (0, 0)
    invariants.assert_all()


def test_new_code_finalizations_and_pre_rollout_rows_are_not_legacy_finalized(creator_factory):
    user = creator_factory(tuzis=Decimal("20"))
    settled = journaled_pod_reserves(user, 2, scope="ai_image", operation_key=uuid.uuid4())
    ledger.settle_reservation(settled)
    released = journaled_pod_reserves(user, 3, scope="ai_prompt", operation_key=uuid.uuid4())
    ledger.release_reservation(released)
    old_pod_writes(user, "-4")                             # a pre-rollout reservation, released by old code too
    old_row = ProviderReservation.objects.create(scope="ai_image", operation_key=uuid.uuid4(), user_id=user.pk,
                                                 amount=Decimal("4"), status="released")
    assert ledger_audit.legacy_finalized_reservations() == []
    assert run() == [{"event": "ledger_heal", "status": "dry_run", "r2_drifted_accounts": 1,
                      "r2_drift_m2z": 4000, "legacy_finalized_reservations": 0, "legacy_finalized_m2z": 0}]
    assert old_row.pk  # the un-journaled row is nobody's to close
