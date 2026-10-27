"""``manage.py ledger_backfill`` (; docs/tuzis/ledger-v2.md §10 step 4).

REAL Postgres, like every ledger test. A creator made by ``creator_factory``
has a ``tuzis`` balance and NO ledger account, and a receipt created straight
through the ORM has no refund cursor: exactly the pre-rollout state the
backfill exists for.

What is pinned here:

* dry run by default -- SELECTs only, counts right, units exact;
* ``--apply`` opens every creator (inactive ones too) with ``tuzis * 1000``,
  heals R2 drift, writes one cursor per eligible receipt with the exact m2Z,
  skips (and reports) what it must, and the result is refundable;
* a re-run is a no-op; a partial run resumes from its checkpoint, and the
  straggler sweep reaches below the checkpoint;
* under live dual-writes, lock contention and an overlapping second run,
  R1-R3 hold afterwards;

with a NEGATIVE CONTROL for each claim that can fail silently: the checkpoint
(``--from-start`` picks differently), the creator lock (without it a racing
debit mints credits and R2 breaks), the retry budget (``--max-retries 0``
stops, with the checkpoint intact), and the unit conversion (a float path
would be off by one m2Z on the largest amount the column holds).
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.apps.g12f.models import Creator
from dj.apps.ledger import api, invariants
from dj.apps.ledger.models import PurchaseRefund, ReconcileRun
from dj.apps.tuzis import ledger
from dj.apps.tuzis.management.commands import ledger_backfill as cmd
from dj.apps.tuzis.models import ZecCreditReceipt
from dj.apps.ztripe.models import StripeTransaction


def run(*args):
    out = StringIO()
    call_command("ledger_backfill", *args, stdout=out)
    return [json.loads(line) for line in out.getvalue().splitlines() if line.startswith("{")]


def last(lines):
    return [line for line in lines if line.get("status") in ("completed", "partial", "dry_run")][-1]


def reconcile_beat():
    out = StringIO()
    call_command("reconcile_ledger", stdout=out)
    return [json.loads(line) for line in out.getvalue().splitlines()
            if line.startswith("{") and json.loads(line)["event"] == "ledger_reconcile"][0]


def sql(query, params=None):
    with connection.cursor() as cursor:
        cursor.execute(query, params)
        return cursor.fetchall() if cursor.description else None


def account(creator):
    rows = sql("SELECT id, balance FROM ledger_account WHERE kind = 'user' AND owner_id = %s", [creator.pk])
    return rows[0] if rows else None


def tuzis(creator) -> Decimal:
    return Creator.objects.get(pk=creator.pk).tuzis


def cursor_of(ref_kind, pk):
    return PurchaseRefund.objects.filter(ref_kind=ref_kind, ref_id=str(pk)).values_list(
        "rail", "account_id", "credited_m2z", "refunded_m2z").first()


def stripe_receipt(creator, whole_2z: int) -> StripeTransaction:
    """A pre-rollout card purchase: the receipt row, and nothing in the ledger."""
    return StripeTransaction.objects.create(
        user=creator, amount=whole_2z, tuzis_credited=whole_2z, stripe_charge_id=f"pi_{uuid.uuid4().hex}",
    )


def zec_receipt(creator, credited, *, backfilled=False) -> ZecCreditReceipt:
    return ZecCreditReceipt.objects.create(
        txid=uuid.uuid4().hex + uuid.uuid4().hex, output_index=0, pool="orchard", creator=creator,
        amount_zec=Decimal("0.10000000"), tuzis_credited=credited, backfilled=backfilled,
    )


def old_pod_writes(creator, delta):
    sql("UPDATE g12f_creator SET tuzis = tuzis + %s WHERE id = %s", [Decimal(delta), creator.pk])


def needing_work_pks():
    return [pk for (pk,) in sql(f"SELECT c.id {cmd._CREATORS_NEEDING_WORK} ORDER BY c.id")]


def snapshot():
    return (
        sql("SELECT key, balance, held FROM ledger_account ORDER BY key"),
        sql("SELECT count(*), coalesce(sum(amount), 0) FROM ledger_transfer"),
        sql("SELECT ref_kind, ref_id, account_id, credited_m2z, refunded_m2z FROM ledger_purchase_refund ORDER BY 1, 2"),
        sql("SELECT id, tuzis FROM g12f_creator ORDER BY id"),
    )


# ======================================================================= dry run


@pytest.mark.django_db
def test_dry_run_is_the_default_reports_exact_counts_and_writes_nothing(creator_factory):
    buyer = creator_factory(tuzis=Decimal("12.5"))
    gone_quiet = creator_factory(tuzis=Decimal("0"), is_active=False)
    stripe_receipt(buyer, 25)
    stripe_receipt(gone_quiet, 0)                        # credited nothing: nothing to refund
    zec_receipt(buyer, Decimal("12.345"))
    zec_receipt(None, Decimal("5"))                       # nobody to claw back from
    zec_receipt(buyer, None, backfilled=True)             # "the old code saw it", not "2Z were issued"
    creators = Creator.objects.count()
    before = snapshot()

    with CaptureQueriesContext(connection) as queries:
        lines = run()

    [report] = lines
    assert report["status"] == "dry_run"
    assert report["creators"] == creators and report["creators_without_account"] == creators
    assert report["inactive_creators_without_account"] >= 1
    assert report["stripe_transaction_without_cursor"] == 1
    assert report["stripe_transaction_without_cursor_m2z"] == 25_000          # whole 2Z x 1000
    assert report["stripe_transaction_skipped_zero_credit"] == 1
    assert report["zec_receipt_without_cursor"] == 1
    assert report["zec_receipt_without_cursor_m2z"] == 12_345                  # NUMERIC(17,3) x 1000, exact
    assert report["zec_receipt_skipped_no_creator"] == 1
    assert report["zec_receipt_skipped_backfilled_unverified"] == 1
    assert report["checkpoints"] == {"accounts": 0, "refunds:stripe_transaction": 0, "refunds:zec_receipt": 0}
    assert all(q["sql"].lstrip().upper().startswith("SELECT") for q in queries.captured_queries), \
        [q["sql"] for q in queries.captured_queries if not q["sql"].lstrip().upper().startswith("SELECT")]
    assert snapshot() == before
    assert not ReconcileRun.objects.exists()
    assert run("--dry-run") == lines, "--dry-run is the same as no flag"


# ======================================================================= apply


@pytest.mark.django_db
def test_apply_opens_every_creator_writes_exact_cursors_and_the_purchase_becomes_refundable(creator_factory):
    buyer = creator_factory(tuzis=Decimal("112.5"))
    inactive = creator_factory(tuzis=Decimal("40.001"), is_active=False)
    broke = creator_factory(tuzis=Decimal("0"))
    card = stripe_receipt(buyer, 100)
    card_inactive = stripe_receipt(inactive, 40)
    zec = zec_receipt(buyer, Decimal("12.345"))
    orphan = zec_receipt(None, Decimal("5"))
    adopted = zec_receipt(buyer, None, backfilled=True)
    zero = stripe_receipt(broke, 0)

    lines = run("--apply", "--batch-size", "2", "--pause", "0")

    done = last(lines)
    assert done["status"] == "completed" and done["remaining"] == 0
    assert done["accounts_opened"] == Creator.objects.count()
    assert done["stripe_transaction_cursors_written"] == 2
    assert done["stripe_transaction_cursors_written_m2z"] == 140_000
    assert done["zec_receipt_cursors_written"] == 1 and done["zec_receipt_cursors_written_m2z"] == 12_345
    assert done["after_creators_without_account"] == 0 and done["r2_drift_after"] == 0

    # Every creator has an account at exactly tuzis x 1000 -- inactive ones too --
    # and the opening transfer is exempt from the projection: tuzis did not move.
    for creator, expected in ((buyer, 112_500), (inactive, 40_001), (broke, 0)):
        assert account(creator)[1] == expected
    assert tuzis(buyer) == Decimal("112.5") and tuzis(inactive) == Decimal("40.001")
    assert sql("SELECT count(*) FROM ledger_transfer WHERE code = 'opening' AND ref_id = %s",
               [str(broke.pk)])[0][0] == 0, "a zero balance opens with no transfer"

    assert cursor_of("stripe_transaction", card.pk) == ("stripe", account(buyer)[0], 100_000, 0)
    assert cursor_of("stripe_transaction", card_inactive.pk) == ("stripe", account(inactive)[0], 40_000, 0)
    assert cursor_of("zec_receipt", zec.pk) == ("zec", account(buyer)[0], 12_345, 0)
    for skipped_kind, skipped in (("zec_receipt", orphan), ("zec_receipt", adopted), ("stripe_transaction", zero)):
        assert cursor_of(skipped_kind, skipped.pk) is None
    invariants.assert_all()
    beat = reconcile_beat()
    assert beat["creators_without_account"] == 0 and beat["drift_total"] == 0

    # The point of step 4: a pre-rollout purchase is refundable, attributed to
    # its buyer, with the cumulative cursor (§5.8) -- 30 % then 20 % claws 30.
    first = api.refund_purchase(buyer.pk, "stripe_transaction", str(card.pk), 30_000, "refund", f"refund:{uuid.uuid4()}")
    again = api.refund_purchase(buyer.pk, "stripe_transaction", str(card.pk), 20_000, "refund", f"refund:{uuid.uuid4()}")
    assert (first.clawed, again.clawed, again.refunded_m2z) == (30_000, 0, 30_000)
    assert tuzis(buyer) == Decimal("82.5")
    invariants.assert_all()


@pytest.mark.django_db
def test_rerun_is_a_no_op(creator_factory):
    buyer = creator_factory(tuzis=Decimal("9"))
    stripe_receipt(buyer, 9)
    zec_receipt(buyer, Decimal("0.001"))
    run("--apply", "--pause", "0")
    before = snapshot()
    checkpoints = ReconcileRun.objects.count()

    with CaptureQueriesContext(connection) as queries:
        lines = run("--apply", "--pause", "0")

    done = last(lines)
    assert done["batches"] == 0 and done["remaining"] == 0
    assert {k: v for k, v in done.items() if k.endswith(("_opened", "_healed", "_written", "_written_m2z"))} == {
        "accounts_opened": 0, "accounts_healed": 0,
        "stripe_transaction_cursors_written": 0, "stripe_transaction_cursors_written_m2z": 0,
        "zec_receipt_cursors_written": 0, "zec_receipt_cursors_written_m2z": 0,
    }
    assert snapshot() == before
    assert ReconcileRun.objects.count() == checkpoints, "no batch, no checkpoint row"
    writes = [q["sql"] for q in queries.captured_queries
              if not q["sql"].lstrip().upper().startswith(("SELECT", "SAVEPOINT", "RELEASE SAVEPOINT", "SET LOCAL"))]
    assert writes == []


@pytest.mark.django_db
def test_r2_drift_on_an_existing_account_is_healed(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    ledger.debit(user, 1, action="comment_vote")        # new code opens it at 10; now 9
    old_pod_writes(user, "-4")                           # a pod on the previous image; user never returns
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{user.pk}", 5000, 9000)]

    done = last(run("--apply", "--pause", "0"))

    assert done["accounts_healed"] == 1 and done["r2_drift_after"] == 0
    assert sql("SELECT amount FROM ledger_transfer WHERE code = 'legacy_adjustment' AND ref_id = %s",
               [str(user.pk)]) == [(4000,)]
    invariants.assert_all()


@pytest.mark.django_db
def test_a_cursor_written_by_the_live_path_is_left_exactly_as_it_is(creator_factory):
    """A purchase fulfilled by the dual-write code already has its cursor
    (credit_purchase writes it), maybe already partly refunded. The backfill
    must neither duplicate nor reset it -- a reset would let the next refund
    event claw back the same credits twice (§5.8)."""
    buyer = creator_factory(tuzis=Decimal("0"))
    receipt = StripeTransaction.objects.create(user=buyer, amount=700, tuzis_credited=7,
                                               stripe_charge_id=f"pi_{uuid.uuid4().hex}")
    ledger.credit(buyer, 7, source="sys:clearing_stripe", ref_kind="stripe_transaction",
                  ref_id=str(receipt.pk), idem=f"stripe:{receipt.stripe_charge_id}")
    api.refund_purchase(buyer.pk, "stripe_transaction", str(receipt.pk), 3000, "refund", f"refund:{uuid.uuid4()}")
    live = cursor_of("stripe_transaction", receipt.pk)
    assert live[2:] == (7000, 3000)

    done = last(run("--apply", "--pause", "0"))

    assert done["stripe_transaction_cursors_written"] == 0
    assert cursor_of("stripe_transaction", receipt.pk) == live
    invariants.assert_all()


@pytest.mark.django_db
def test_units_are_exact_at_the_top_of_the_column(creator_factory):
    """NUMERIC(17,3)'s largest value, to the m2Z. The NEGATIVE CONTROL is the
    arithmetic below: the float path the design forbids is off by one m2Z
    here, so an implementation that took it would fail this test."""
    buyer = creator_factory(tuzis=Decimal("1"))
    top = Decimal("99999999999999.999")
    assert int(float(top) * 1000) != 99_999_999_999_999_999
    receipt = zec_receipt(buyer, top)

    run("--apply", "--pause", "0")

    assert cursor_of("zec_receipt", receipt.pk)[2] == 99_999_999_999_999_999
    with pytest.raises(TypeError):
        cmd.SOURCES[0].credited_m2z(Decimal("1.5"))      # a Stripe receipt is whole 2Z, never fractional
    with pytest.raises(ValueError):
        cmd.SOURCES[1].credited_m2z(Decimal("0.0001"))   # a fourth decimal is refused, not rounded


# ======================================================================= resume


@pytest.mark.django_db
def test_a_partial_run_resumes_from_its_checkpoint_and_the_sweep_reaches_below_it(creator_factory):
    made = [creator_factory(tuzis=Decimal(n + 1)) for n in range(6)]
    queue = needing_work_pks()
    assert [c.pk for c in made] == queue[-6:]

    partial = last(run("--apply", "--batch-size", "2", "--max-batches", "1", "--pause", "0"))

    assert partial["status"] == "partial"
    opened = [pk for pk in queue if sql("SELECT 1 FROM ledger_account WHERE key = %s", [f"user:{pk}"])]
    assert opened == queue[:2]
    assert cmd.stored_checkpoint("accounts") == queue[1]

    # Something BELOW the checkpoint needs work again (an old pod drifted it).
    # A resumed run starts after the checkpoint, so it does not see it...
    below = Creator.objects.get(pk=queue[0])
    old_pod_writes(below, "1")
    run("--apply", "--batch-size", "2", "--max-batches", "1", "--pause", "0")
    assert cmd.stored_checkpoint("accounts") == queue[3]
    assert invariants.r2_tuzis_projection_equals_balance() == [
        (f"user:{below.pk}", int(tuzis(below) * 1000), int((tuzis(below) - 1) * 1000))]
    #...NEGATIVE CONTROL: --from-start ignores the checkpoint and goes there first.
    control = run("--apply", "--batch-size", "1", "--max-batches", "1", "--pause", "0", "--from-start")
    assert [line["checkpoint_pk"] for line in control if line.get("status") == "batch"] == [queue[0]]
    assert invariants.r2_tuzis_projection_equals_balance() == []

    # A full run finishes the keyset pass, then sweeps from the start.
    done = last(run("--apply", "--batch-size", "2", "--pause", "0"))
    assert done["status"] == "completed" and done["remaining"] == 0
    invariants.assert_all()


@pytest.mark.django_db
def test_the_straggler_sweep_finishes_what_the_checkpoint_would_skip(creator_factory):
    """A creator row can commit AFTER the keyset pass went by its pk (the
    identity value is allocated before its transaction commits). Simulate it
    with a checkpoint past every row: the keyset pass finds nothing, the sweep
    from the start does the work."""
    made = [creator_factory(tuzis=Decimal("3")) for _ in range(3)]
    receipt = stripe_receipt(made[0], 3)
    top = sql("SELECT max(id) FROM g12f_creator")[0][0] + 1000
    for phase in ("accounts", "refunds:stripe_transaction"):
        ReconcileRun.objects.create(scope=cmd.CHECKPOINT_SCOPE, invariant=phase, detail={"last_pk": top})

    done = last(run("--apply", "--pause", "0"))

    assert done["remaining"] == 0 and all(account(c) for c in made)
    assert cursor_of("stripe_transaction", receipt.pk)[2] == 3000
    invariants.assert_all()


# ======================================================================= concurrency
#
# transaction=True: the default test transaction never commits, so a second
# connection could not see the fixtures. Each worker thread closes its own
# connection. The journal is unmanaged and survives the flush between
# autocommit tests, so these start from an empty one (as ledger/tests do).


@pytest.fixture
def empty_journal():
    sql("TRUNCATE ledger_transfer, ledger_transfer_key, ledger_purchase_refund, ledger_reconcile_run")


def in_thread(fn):
    box = {}

    def target():
        try:
            box["result"] = fn()
        except Exception as exc:   # asserted on by the caller
            box["error"] = exc
        finally:
            connection.close()

    thread = threading.Thread(target=target)
    thread.start()
    return thread, box


@pytest.mark.django_db(transaction=True)
def test_live_dual_writes_during_the_backfill_leave_r1_r3_and_every_balance_exact(creator_factory, empty_journal):
    users = [creator_factory(tuzis=Decimal("100")) for _ in range(12)]
    historical = [stripe_receipt(u, 5) for u in users[:6]] + [zec_receipt(u, Decimal("2.5")) for u in users[6:]]
    expected = {u.pk: Decimal("100") for u in users}
    lock = threading.Lock()
    stop = threading.Event()
    errors = []
    live_receipts = []

    def live(worker):
        i = 0
        try:
            while not stop.is_set() and i < 60:
                a, b = users[(worker * 7 + i) % 12], users[(worker * 5 + i + 1) % 12]
                kind = i % 4
                if kind == 0:
                    ledger.debit(a, 1, action="comment_vote")
                    delta = {a.pk: Decimal("-1")}
                elif kind == 1:
                    ledger.credit(a, 2, source="sys:promo", ref_kind="tuzi_grant", ref_id=str(i),
                                  idem=f"grant:{uuid.uuid4()}")
                    delta = {a.pk: Decimal("2")}
                elif kind == 2 and a.pk != b.pk:
                    ledger.transfer(a, b, 1, action="donation")
                    delta = {a.pk: Decimal("-1"), b.pk: Decimal("1")}
                else:
                    # A live card purchase: receipt + credit_purchase (which writes
                    # the cursor) in one transaction, racing the refunds phase.
                    from django.db import transaction
                    with transaction.atomic():
                        receipt = stripe_receipt(a, 3)
                        ledger.credit(a, 3, source="sys:clearing_stripe", ref_kind="stripe_transaction",
                                      ref_id=str(receipt.pk), idem=f"stripe:{receipt.stripe_charge_id}")
                    live_receipts.append(receipt.pk)
                    delta = {a.pk: Decimal("3")}
                with lock:
                    for pk, d in delta.items():
                        expected[pk] += d
                i += 1
        except Exception as exc:
            errors.append(exc)
        finally:
            connection.close()

    workers = [threading.Thread(target=live, args=(w,)) for w in range(3)]
    for w in workers:
        w.start()
    backfill, box = in_thread(lambda: run("--apply", "--batch-size", "3", "--pause", "0.01"))
    backfill.join(timeout=120)
    stop.set()
    for w in workers:
        w.join(timeout=60)
    assert not backfill.is_alive() and not any(w.is_alive() for w in workers), "wedged"
    assert errors == [] and "error" not in box, (errors, box.get("error"))

    assert last(box["result"])["status"] == "completed"
    for u in users:
        assert tuzis(u) == expected[u.pk]
        assert account(u)[1] == int(expected[u.pk] * 1000)
    invariants.assert_all()                                   # R1, R2, R3
    for r in historical:
        kind = "stripe_transaction" if isinstance(r, StripeTransaction) else "zec_receipt"
        assert cursor_of(kind, r.pk)[2] == (5000 if kind == "stripe_transaction" else 2500)
    for pk in live_receipts:
        assert cursor_of("stripe_transaction", pk)[2:] == (3000, 0)
    assert last(run("--apply", "--pause", "0"))["batches"] == 0, "and a re-run afterwards is a no-op"


@pytest.mark.django_db(transaction=True)
def test_two_overlapping_runs_double_nothing(creator_factory, empty_journal):
    users = [creator_factory(tuzis=Decimal(n + 1)) for n in range(15)]
    receipts = [stripe_receipt(u, 4) for u in users]

    runs = [in_thread(lambda: run("--apply", "--batch-size", "2", "--pause", "0")) for _ in range(2)]
    for thread, _ in runs:
        thread.join(timeout=120)
    assert all("error" not in box for _, box in runs), [box.get("error") for _, box in runs]

    assert sum(last(box["result"])["accounts_opened"] for _, box in runs) == len(users)
    assert sum(last(box["result"])["stripe_transaction_cursors_written"] for _, box in runs) == len(receipts)
    assert sql("SELECT count(*) FROM ledger_transfer WHERE code = 'opening'")[0][0] == len(users)
    assert PurchaseRefund.objects.count() == len(receipts)
    invariants.assert_all()


@pytest.mark.django_db(transaction=True)
def test_a_held_creator_lock_is_waited_out_with_retries(creator_factory, empty_journal):
    users = [creator_factory(tuzis=Decimal("5")) for _ in range(3)]
    holder, _ = in_thread(lambda: _hold_creator_lock(users[1], seconds=1.5))
    time.sleep(0.3)

    lines = run("--apply", "--batch-size", "1", "--lock-timeout-ms", "100", "--max-retries", "10", "--pause", "0")

    holder.join(timeout=10)
    retries = [line for line in lines if line.get("status") == "retry"]
    assert retries and {line["sqlstate"] for line in retries} == {"55P03"}
    assert last(lines)["status"] == "completed" and all(account(u) for u in users)
    invariants.assert_all()


@pytest.mark.django_db(transaction=True)
def test_negative_control_without_retries_it_stops_and_the_checkpoint_survives(creator_factory, empty_journal):
    users = [creator_factory(tuzis=Decimal("5")) for _ in range(3)]
    holder, _ = in_thread(lambda: _hold_creator_lock(users[1], seconds=1.5))
    time.sleep(0.3)

    with pytest.raises(CommandError, match="could not get its locks"):
        run("--apply", "--batch-size", "1", "--lock-timeout-ms", "100", "--max-retries", "0", "--pause", "0")

    holder.join(timeout=10)
    assert account(users[0]) and not account(users[1]) and not account(users[2])
    assert cmd.stored_checkpoint("accounts") == users[0].pk, "the committed batch kept its checkpoint"
    assert last(run("--apply", "--pause", "0"))["remaining"] == 0
    invariants.assert_all()


def _hold_creator_lock(creator, *, seconds):
    from django.db import transaction
    with transaction.atomic():
        ledger.lock_in_order(creator)
        time.sleep(seconds)


def _race_a_debit_into_the_batch(target):
    """The test seam: inside the backfill's batch, right after its creator
    rows are locked, a live request debits one of them. With the lock the
    debit blocks until the batch commits; without it, it lands first."""
    state = {}

    def hook(locked_ids):
        if target.pk not in locked_ids or state:
            return
        thread, box = in_thread(lambda: ledger.debit(Creator.objects.get(pk=target.pk), 1, action="comment_vote"))
        thread.join(timeout=1.0)
        state.update(thread=thread, box=box, finished_inside_batch=not thread.is_alive())

    return hook, state


@pytest.mark.django_db(transaction=True)
def test_the_creator_lock_orders_a_racing_debit_after_the_batch(creator_factory, empty_journal, monkeypatch):
    target = creator_factory(tuzis=Decimal("10"))
    hook, state = _race_a_debit_into_the_batch(target)
    monkeypatch.setattr(cmd.Backfill, "after_creators_locked", staticmethod(hook))

    # One batch and no straggler sweep, so the batch's own outcome is what is
    # measured (the sweep would re-heal the control's damage from fresh tuzis).
    run("--apply", "--phase", "accounts", "--max-batches", "1", "--pause", "0")
    state["thread"].join(timeout=10)

    assert state["finished_inside_batch"] is False, "the debit waited for the batch's creator lock"
    assert "error" not in state["box"]
    assert tuzis(target) == Decimal("9") and account(target)[1] == 9000
    assert sql("SELECT count(*) FROM ledger_transfer WHERE code = 'legacy_adjustment'")[0][0] == 0
    invariants.assert_all()


@pytest.mark.django_db(transaction=True)
@pytest.mark.ledger_drift_expected
def test_negative_control_without_the_creator_lock_a_racing_debit_mints_credits(creator_factory, empty_journal,
                                                                                monkeypatch):
    """The same race with ``FOR NO KEY UPDATE`` removed from the batch's
    creator select: the debit opens the account itself (10 -> 9) and commits
    inside the batch, and the batch then "heals" the account from the stale
    10 it read -- a credit nobody bought, and R2 drift. This is what the
    lock in ``LOCK_CREATORS_SQL`` is for."""
    assert cmd.LOCK_CREATORS_SQL.count(" FOR NO KEY UPDATE") == 1, "the lock clause moved; update this control"
    monkeypatch.setattr(cmd, "LOCK_CREATORS_SQL", cmd.LOCK_CREATORS_SQL.replace(" FOR NO KEY UPDATE", ""))
    target = creator_factory(tuzis=Decimal("10"))
    hook, state = _race_a_debit_into_the_batch(target)
    monkeypatch.setattr(cmd.Backfill, "after_creators_locked", staticmethod(hook))

    run("--apply", "--phase", "accounts", "--max-batches", "1", "--pause", "0")
    state["thread"].join(timeout=10)

    assert state["finished_inside_batch"] is True
    assert tuzis(target) == Decimal("9") and account(target)[1] == 10_000
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{target.pk}", 9000, 10_000)]
    assert sql("SELECT amount FROM ledger_transfer WHERE code = 'legacy_adjustment'") == [(1000,)], \
        "the stale read journaled 1 2Z nobody bought"
