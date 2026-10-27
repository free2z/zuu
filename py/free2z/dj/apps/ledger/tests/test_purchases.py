"""``credit_purchase``, ``clawback``, ``refund_purchase``, ``restore_purchase`` (design §5.8, §5.9).

The refund cursor is the thing to get right: Stripe's ``amount_refunded`` is
cumulative and monotone, events arrive out of order and are retried, and the
total clawed back for a purchase must equal the latest target -- never the
sum of the events.
"""
from decimal import Decimal

import pytest
from django.db import DatabaseError, transaction

from dj.apps.ledger import api
from dj.apps.ledger.models import PurchaseRefund

from .conftest import account, balance_of, key, one, sql, sys_id, transfers, tuzis_of

pytestmark = pytest.mark.django_db

RECEIPT = ("stripe_transaction", "pi_1")


def buy(creator, amount=10000, rail="stripe", ref=RECEIPT, idem=None):
    return api.credit_purchase(creator.pk, amount, rail, ref[0], ref[1], idem or key("stripe"))


# ------------------------------------------------------------------ credit_purchase


def test_credit_purchase_debits_the_rail_clearing_account_and_writes_the_cursor(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("1"))
    r = buy(creator, 10000)
    assert (r.status, r.credited, r.debt_repaid, r.balance) == ("posted", 10000, 0, 11000)
    (t,) = transfers(id=r.transfer_id)
    assert t[1:] == (sys_id("sys:clearing_stripe"), account(f"user:{creator.pk}")[0], 10000, "purchase", *RECEIPT)
    assert tuzis_of(creator) == Decimal("11")
    cursor = PurchaseRefund.objects.get(ref_kind=RECEIPT[0], ref_id=RECEIPT[1])
    assert (cursor.rail, cursor.credited_m2z, cursor.refunded_m2z) == ("stripe", 10000, 0)
    assert_invariants()


def test_credit_purchase_replays_and_a_second_fulfilment_of_one_receipt_is_refused(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("0"))
    k = key("stripe")
    r = buy(creator, 10000, idem=k)
    again = buy(creator, 10000, idem=k)
    assert again == api.CreditResult("replayed", 10000, 0, 10000, r.transfer_id, None)
    assert balance_of(f"user:{creator.pk}") == 10000
    with pytest.raises(DatabaseError), transaction.atomic():   # same receipt, different key: loud
        buy(creator, 10000, idem=key("stripe"))
    assert_invariants()


def test_credit_purchase_against_debt_replays_without_minting(creator_factory, assert_invariants):
    """§4.3's example: a 100-2Z purchase against 100 2Z of debt posts only
    the repay leg; the replay must not post the base leg."""
    creator = creator_factory(tuzis=Decimal("0"))
    api.clawback(creator.pk, 100000, "sys:clearing_stripe", "clawback", "dispute", "stripe_transaction", "old", key())
    assert balance_of(f"user_debt:{creator.pk}") == -100000
    k = key("stripe")
    r = buy(creator, 100000, idem=k)
    assert (r.credited, r.debt_repaid, r.transfer_id, r.repay_transfer_id is not None) == (0, 100000, None, True)
    assert balance_of(f"user_debt:{creator.pk}") == 0 and balance_of(f"user:{creator.pk}") == 0
    again = buy(creator, 100000, idem=k)
    assert (again.status, again.credited, again.debt_repaid) == ("replayed", 0, 100000)
    assert balance_of(f"user:{creator.pk}") == 0, "nothing minted on replay"
    assert tuzis_of(creator) == Decimal("0")
    assert_invariants()


def test_credit_purchase_validation(creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))
    with pytest.raises(ValueError):
        api.credit_purchase(creator.pk, 1, "paypal", "x", "1", key())
    for args in [(creator.pk, 1, "stripe", "", "1", key()), (creator.pk, 1, "stripe", "x", "", key()),
                 (creator.pk, 0, "stripe", "x", "1", key()), (creator.pk, 1, "stripe", "x", "1", None)]:
        with pytest.raises(DatabaseError), transaction.atomic():
            api.credit_purchase(*args)


# ------------------------------------------------------------------ clawback


def test_clawback_takes_what_is_available_and_puts_the_rest_on_debt(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("6"))
    acct = api.ensure_account(creator.pk)
    sql("UPDATE ledger_account SET held = 2000 WHERE id = %s", [acct])   # held credits are not ours to take
    k = key("clawback")
    r = api.clawback(creator.pk, 10000, "sys:clearing_stripe", "clawback", "refund", *RECEIPT, k)
    assert r == api.ClawbackResult("posted", 4000, 6000, 2000)
    assert balance_of(f"user_debt:{creator.pk}") == -6000 and tuzis_of(creator) == Decimal("2")
    legs = transfers(credit_account_id=sys_id("sys:clearing_stripe"))
    assert [(t[3], t[4]) for t in legs] == [(4000, "clawback"), (6000, "clawback_debt")]
    assert account(f"user:{creator.pk}")[3] is False
    assert api.clawback(creator.pk, 10000, "sys:clearing_stripe", "clawback", "refund", *RECEIPT, k) == \
        api.ClawbackResult("replayed", 4000, 6000, 2000)
    assert_invariants()


def test_clawback_with_freeze_freezes_and_a_markup_reversal_needs_its_counter_account(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("1"))
    r = api.clawback(creator.pk, 500, "sys:markup_reversal", "markup_reversal", "op:skylar", "dev", "1", key(), freeze=True)
    assert r == api.ClawbackResult("posted", 500, 0, 500)
    assert account(f"user:{creator.pk}")[3] is True
    assert sql("SELECT frozen_reason FROM ledger_account WHERE key = %s", [f"user:{creator.pk}"]) == [("op:skylar",)]
    assert api.spend(creator.pk, 1, "x").status == "frozen"
    assert transfers(code="markup_reversal")[0][2] == sys_id("sys:markup_reversal")
    assert_invariants()
    for args in [
        (creator.pk, 1, "sys:markup_reversal", "clawback", "r", "x", "1", key()),        # wrong counter for the code
        (creator.pk, 1, "sys:clearing_zec", "markup_reversal", "r", "x", "1", key()),
        (creator.pk, 1, "sys:promo", "clawback", "r", "x", "1", key()),
        (creator.pk, 1, "sys:clearing_zec", "spend", "r", "x", "1", key()),
        (creator.pk, 0, "sys:clearing_zec", "clawback", "r", "x", "1", key()),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            api.clawback(*args)
    with pytest.raises(ValueError):
        api.clawback(creator.pk, 1, "sys:clearing_zec", "clawback", "r", "x", "1", "")


# ------------------------------------------------------------------ refund cursor


def test_reordered_and_repeated_refund_events_claw_back_the_target_not_the_sum(creator_factory, assert_invariants):
    """Targets 30, 20, 40 (of a 100-credit purchase) must claw 30, 0, 10; a
    replayed 40 claws nothing more; the cursor never moves backwards."""
    creator = creator_factory(tuzis=Decimal("0"))
    buy(creator, 100000)
    outcomes = []
    for i, target in enumerate((30000, 20000, 40000)):
        r = api.refund_purchase(creator.pk, *RECEIPT, target, f"charge.refunded {i}", key("refund"))
        outcomes.append((r.status, r.clawed, r.debt_added, r.refunded_m2z))
    assert outcomes == [("posted", 30000, 0, 30000), ("posted", 0, 0, 30000), ("posted", 10000, 0, 40000)]
    assert balance_of(f"user:{creator.pk}") == 60000 and tuzis_of(creator) == Decimal("60")
    k = key("refund")
    first = api.refund_purchase(creator.pk, *RECEIPT, 40000, "retry", k)
    again = api.refund_purchase(creator.pk, *RECEIPT, 40000, "retry", k)
    assert first == api.RefundResult("posted", 0, 0, 60000, 40000)
    assert again == api.RefundResult("replayed", 0, 0, 60000, 40000)
    assert balance_of(f"user:{creator.pk}") == 60000
    assert_invariants()


def test_a_refund_beyond_what_is_available_becomes_debt_and_a_dispute_freezes(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("0"))
    buy(creator, 100000)
    assert api.spend(creator.pk, 90000, "ai_chat").status == "posted"
    r = api.refund_purchase(creator.pk, *RECEIPT, 100000, "charge.dispute.created", key("dispute"), freeze=True)
    assert (r.clawed, r.debt_added, r.balance, r.refunded_m2z) == (10000, 90000, 0, 100000)
    assert balance_of(f"user_debt:{creator.pk}") == -90000
    assert account(f"user:{creator.pk}")[3] is True
    assert api.spend(creator.pk, 1, "x").status == "frozen"
    assert_invariants()
    # A target above the purchase is clamped to it; a later smaller target is a no-op.
    assert api.refund_purchase(creator.pk, *RECEIPT, 999999, "again", key()).clawed == 0
    assert api.refund_purchase(creator.pk, *RECEIPT, 1, "late", key()).refunded_m2z == 100000
    assert_invariants()


def test_a_dispute_on_a_fully_refunded_purchase_still_freezes(creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))
    buy(creator, 1000)
    api.refund_purchase(creator.pk, *RECEIPT, 1000, "refund", key())
    assert account(f"user:{creator.pk}")[3] is False
    r = api.refund_purchase(creator.pk, *RECEIPT, 1000, "dispute", key(), freeze=True)
    assert r.clawed == 0 and account(f"user:{creator.pk}")[3] is True


def test_refund_and_restore_validation(creator_factory):
    a = creator_factory(tuzis=Decimal("0"))
    b = creator_factory(tuzis=Decimal("0"))
    buy(a, 1000)
    for fn, args in [
        (api.refund_purchase, (a.pk, "stripe_transaction", "nope", 1, "r", key())),   # no such purchase
        (api.refund_purchase, (b.pk, *RECEIPT, 1, "r", key())),                         # someone else's purchase
        (api.refund_purchase, (a.pk, *RECEIPT, -1, "r", key())),
        (api.refund_purchase, (a.pk, *RECEIPT, 1, "r", None)),
        (api.restore_purchase, (b.pk, *RECEIPT, 0, key())),
        (api.restore_purchase, (a.pk, "stripe_transaction", "nope", 0, key())),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            fn(*args)


# ------------------------------------------------------------------ restore


def test_a_dispute_won_restores_through_credit_with_repay_and_lowers_the_cursor(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("0"))
    buy(creator, 100000)
    api.spend(creator.pk, 70000, "ai_chat")
    api.refund_purchase(creator.pk, *RECEIPT, 100000, "dispute", key(), freeze=True)
    assert balance_of(f"user_debt:{creator.pk}") == -70000
    k = key("restore")
    r = api.restore_purchase(creator.pk, *RECEIPT, 0, k)
    assert (r.status, r.restored, r.debt_repaid, r.balance, r.refunded_m2z) == ("posted", 30000, 70000, 30000, 0)
    assert balance_of(f"user_debt:{creator.pk}") == 0 and tuzis_of(creator) == Decimal("30")
    assert [t[4] for t in transfers(id=r.repay_transfer_id) + transfers(id=r.transfer_id)] == ["debt_repay", "restore"]
    assert transfers(id=r.transfer_id)[0][1] == sys_id("sys:clearing_stripe")
    assert account(f"user:{creator.pk}")[3] is True, "restore does not unfreeze (§5.8)"
    assert_invariants()
    again = api.restore_purchase(creator.pk, *RECEIPT, 0, k)
    assert again == api.RestoreResult("replayed", 30000, 70000, 30000, r.transfer_id, r.repay_transfer_id, 0)
    nothing = api.restore_purchase(creator.pk, *RECEIPT, 0, key())
    assert (nothing.status, nothing.restored) == ("nothing_to_restore", 0), "nothing left to restore"
    # A partial restore (target 40 of a fully clawed 100) re-credits 60 and the cursor reads 40.
    api.refund_purchase(creator.pk, *RECEIPT, 100000, "dispute", key())
    r2 = api.restore_purchase(creator.pk, *RECEIPT, 40000, key())
    assert (r2.restored + r2.debt_repaid, r2.refunded_m2z) == (60000, 40000)
    assert_invariants()


def test_a_repay_leg_records_which_credit_it_came_from(creator_factory, assert_invariants):
    """Codex finding on: a restore that repays dispute debt posts a
    `debt_repay` naming the receipt; without an origin R11(a) would count
    it as a second fulfilment of the purchase. The origin is on the row."""
    creator = creator_factory(tuzis=Decimal("0"))
    buy(creator, 10000)
    api.spend(creator.pk, 10000, "ai_chat")
    api.refund_purchase(creator.pk, *RECEIPT, 10000, "dispute", key(), freeze=True)
    assert balance_of(f"user_debt:{creator.pk}") == -10000
    r = api.restore_purchase(creator.pk, *RECEIPT, 0, key())
    assert (r.restored, r.debt_repaid, r.transfer_id) == (0, 10000, None)
    rows = sql("SELECT code, meta->>'origin' FROM ledger_transfer WHERE ref_kind = %s AND ref_id = %s ORDER BY id",
               list(RECEIPT))
    assert rows == [("purchase", None), ("clawback_debt", None), ("debt_repay", "restore")]
    # R11(a): fulfilment for the receipt = purchase + debt_repay rows whose origin is a purchase.
    fulfilment = sum(t[3] for t in transfers(ref_kind=RECEIPT[0], ref_id=RECEIPT[1])
                     if t[4] == "purchase")
    fulfilment += one("SELECT coalesce(sum(amount), 0) FROM ledger_transfer WHERE ref_kind = %s AND ref_id = %s "
                      "AND code = 'debt_repay' AND meta->>'origin' = 'purchase'", list(RECEIPT))[0]
    assert fulfilment == 10000
    assert_invariants()
    # A purchase against debt marks its repay leg 'purchase'.
    api.refund_purchase(creator.pk, *RECEIPT, 10000, "dispute again", key())
    api.credit_purchase(creator.pk, 3000, "stripe", "stripe_transaction", "pi_2", key())
    assert sql("SELECT meta->>'origin' FROM ledger_transfer WHERE ref_id = 'pi_2'") == [("purchase",)]


def test_a_dispute_won_that_arrives_before_its_clawback_keeps_its_key(creator_factory, assert_invariants):
    """Codex finding on: webhooks are not ordered. `dispute won`
    processed before `dispute created` has nothing to restore; it must not
    consume its key, or the retry after the clawback lands replays
    'restored 0' forever and the user stays clawed back."""
    creator = creator_factory(tuzis=Decimal("0"))
    buy(creator, 100000)
    k = key("won")
    early = api.restore_purchase(creator.pk, *RECEIPT, 0, k)
    assert early == api.RestoreResult("nothing_to_restore", 0, 0, 100000, None, None, 0)
    assert sql("SELECT 1 FROM ledger_transfer_key WHERE idem = %s", [k]) == [], "the key is not consumed"
    api.refund_purchase(creator.pk, *RECEIPT, 100000, "dispute", key(), freeze=True)
    assert balance_of(f"user:{creator.pk}") == 0
    late = api.restore_purchase(creator.pk, *RECEIPT, 0, k)
    assert (late.status, late.restored, late.balance, late.refunded_m2z) == ("posted", 100000, 100000, 0)
    assert api.restore_purchase(creator.pk, *RECEIPT, 0, k).status == "replayed"
    assert_invariants()


def test_r11_shape_purchase_and_restore_are_attributable_to_the_receipt(creator_factory, assert_invariants):
    """Every purchase / debt_repay / clawback / restore row names the receipt
    (ref_kind, ref_id), which is what the per-rail reconciliation joins on."""
    creator = creator_factory(tuzis=Decimal("0"))
    buy(creator, 5000)
    api.refund_purchase(creator.pk, *RECEIPT, 2000, "refund", key())
    api.restore_purchase(creator.pk, *RECEIPT, 1000, key())
    rows = transfers(ref_kind=RECEIPT[0], ref_id=RECEIPT[1])
    assert [(t[3], t[4]) for t in rows] == [(5000, "purchase"), (2000, "clawback"), (1000, "restore")]
    clearing = sys_id("sys:clearing_stripe")
    # The §1 sign rule: a purchase DEBITS the clearing account, so its
    # journal runs negative; R11(b) reads -journal == purchases - clawbacks + restores.
    journal = sum(t[3] if t[2] == clearing else -t[3] for t in rows)
    assert journal == -4000 == -(5000 - 2000 + 1000)
    assert balance_of(f"user:{creator.pk}") == 4000
    assert_invariants()
