"""``spend``, ``spend_up_to``, ``credit_user``, ``transfer_users`` (design §5.7).

Statuses are returned, never raised; debt gates spending; every credit
into a user account repays that user's debt first; compound operations
claim once and replay what they did.
"""
from decimal import Decimal

import pytest
from django.db import DatabaseError, transaction

from dj.apps.ledger import api

from .conftest import account, balance_of, key, sql, sys_id, transfers, tuzis_of

pytestmark = pytest.mark.django_db


def in_debt(creator, amount=3000):
    """Put ``creator`` exactly ``amount`` m2Z in debt: a clawback takes what
    is available first, so claw back available + amount."""
    api.ensure_account(creator.pk)
    _id, balance, held, _frozen = account(f"user:{creator.pk}")
    r = api.clawback(creator.pk, max(balance - held, 0) + amount, "sys:clearing_stripe", "clawback",
                     "dispute", "stripe_transaction", "d1", key())
    assert r.debt_added == amount, r
    return r


# ------------------------------------------------------------------ spend


def test_spend_posts_to_platform_revenue_with_the_action_as_ref_kind(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("10"))
    r = api.spend(creator.pk, 2500, "page_vote", "page-7")
    assert r == api.SpendResult("posted", 7500, 7500, r.transfer_id) and r.posted
    (t,) = transfers(id=r.transfer_id)
    assert t[1:] == (api.user_account_id(creator.pk), sys_id("sys:platform_revenue"), 2500, "spend", "page_vote", "page-7")
    assert tuzis_of(creator) == Decimal("7.5")
    assert_invariants()


def test_spend_opens_the_account_lazily(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("3"))
    assert api.user_account_id(creator.pk) is None
    assert api.spend(creator.pk, 1000, "comment").status == "posted"
    assert account(f"user:{creator.pk}")[1] == 2000
    assert [t[4] for t in transfers()] == ["opening", "spend"]
    assert_invariants()


def test_spend_statuses(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("1"))
    assert api.spend(creator.pk, 1001, "x") == api.SpendResult("insufficient", 1000, 1000, None)
    acct = api.user_account_id(creator.pk)
    sql("UPDATE ledger_account SET held = 400 WHERE id = %s", [acct])
    assert api.spend(creator.pk, 601, "x").status == "insufficient"
    assert api.spend(creator.pk, 600, "x").status == "posted"
    sql("UPDATE ledger_account SET frozen = true WHERE id = %s", [acct])
    assert api.spend(creator.pk, 1, "x") == api.SpendResult("frozen", 400, 0, None)
    sql("UPDATE ledger_account SET frozen = false, held = 0 WHERE id = %s", [acct])
    in_debt(creator, 100)
    assert api.spend(creator.pk, 1, "x") == api.SpendResult("in_debt", 0, 0, None)
    assert_invariants()
    for amount in (0, -1):
        with pytest.raises(DatabaseError), transaction.atomic():
            api.spend(creator.pk, amount, "x")
    with pytest.raises(DatabaseError), transaction.atomic():
        api.spend(999_999_999, 1, "x")


def test_keyed_spend_replays_even_when_it_could_not_afford_it_again(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("1"))
    k = key("spend")
    first = api.spend(creator.pk, 1000, "x", idem=k)
    assert first.status == "posted"
    again = api.spend(creator.pk, 1000, "x", idem=k)
    assert again == api.SpendResult("replayed", 0, 0, first.transfer_id)
    assert balance_of(f"user:{creator.pk}") == 0
    assert_invariants()


def test_an_empty_idempotency_key_is_refused_not_shared(creator_factory):
    """ review: '' would be ONE key for every caller -- user B's spend
    would replay user A's transfer. Refused at both layers."""
    a = creator_factory(tuzis=Decimal("10"))
    with pytest.raises(ValueError):
        api.spend(a.pk, 1000, "x", idem="")
    with pytest.raises(DatabaseError, match="must not be empty"), transaction.atomic():
        sql("SELECT * FROM ledger.spend(%s, 1000, 'x', '', '')", [a.pk])
    acct = api.ensure_account(a.pk)
    with pytest.raises(DatabaseError, match="must not be empty"), transaction.atomic():
        sql("SELECT * FROM ledger.post_transfer(%s, ledger.sys('sys:platform_revenue'), 1000, 'spend', 'x', '', '', NULL)",
            [acct])
    assert balance_of(f"user:{a.pk}") == 10000
    with pytest.raises(DatabaseError), transaction.atomic():   # compound functions already refused it via ledger.claim
        api.credit_user(a.pk, 5, "sys:promo", "grant", "x", "1", "")


def test_a_refused_keyed_spend_then_a_top_up_then_a_retry_posts(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("1"))
    k = key("spend")
    assert api.spend(creator.pk, 5000, "x", idem=k).status == "insufficient"
    api.credit_user(creator.pk, 10000, "sys:promo", "grant", "tuzi_grant", "1", key("grant"))
    assert api.spend(creator.pk, 5000, "x", idem=k).status == "posted"
    assert balance_of(f"user:{creator.pk}") == 6000
    assert_invariants()


# ------------------------------------------------------------------ spend_up_to


def test_spend_up_to_clamps_to_available_and_is_zero_in_debt_or_frozen(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("1"))
    acct = api.ensure_account(creator.pk)
    sql("UPDATE ledger_account SET held = 250 WHERE id = %s", [acct])
    r = api.spend_up_to(creator.pk, 5000, "ppv")
    assert r == api.SpendUpToResult(750, 250, 0, r.transfer_id)
    assert transfers(id=r.transfer_id)[0][4] == "spend_up_to"
    assert api.spend_up_to(creator.pk, 5000, "ppv") == api.SpendUpToResult(0, 250, 0, None)
    assert api.spend_up_to(creator.pk, 0, "ppv") == api.SpendUpToResult(0, 250, 0, None)
    sql("UPDATE ledger_account SET held = 0, frozen = true WHERE id = %s", [acct])
    assert api.spend_up_to(creator.pk, 100, "ppv").charged == 0
    sql("UPDATE ledger_account SET frozen = false WHERE id = %s", [acct])
    in_debt(creator, 100)
    assert api.spend_up_to(creator.pk, 100, "ppv").charged == 0, "0 while in debt (§5.9)"
    assert_invariants()


# ------------------------------------------------------------------ credit_user


def test_credit_user_repays_debt_first_and_replays_its_split(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("0"))
    in_debt(creator, 3000)
    k = key("grant")
    r = api.credit_user(creator.pk, 5000, "sys:promo", "grant", "tuzi_grant", "9", k)
    assert (r.status, r.credited, r.debt_repaid, r.balance) == ("posted", 2000, 3000, 2000)
    assert balance_of(f"user_debt:{creator.pk}") == 0 and tuzis_of(creator) == Decimal("2")
    repay, grant = transfers(id=r.repay_transfer_id)[0], transfers(id=r.transfer_id)[0]
    assert repay[1:5] == (sys_id("sys:promo"), account(f"user_debt:{creator.pk}")[0], 3000, "debt_repay")
    assert grant[1:5] == (sys_id("sys:promo"), account(f"user:{creator.pk}")[0], 2000, "grant")
    assert_invariants()
    again = api.credit_user(creator.pk, 5000, "sys:promo", "grant", "tuzi_grant", "9", k)
    assert again == api.CreditResult("replayed", 2000, 3000, 2000, r.transfer_id, r.repay_transfer_id)
    assert balance_of(f"user:{creator.pk}") == 2000, "credited once"
    assert_invariants()


def test_credit_user_entirely_to_debt_replays_without_minting(creator_factory, assert_invariants):
    """The §4.3 case: a credit that only repaid debt must not, on replay,
    post the base leg because it now sees no debt."""
    creator = creator_factory(tuzis=Decimal("0"))
    in_debt(creator, 5000)
    k = key("grant")
    r = api.credit_user(creator.pk, 5000, "sys:promo", "grant", "tuzi_grant", "1", k)
    assert (r.credited, r.debt_repaid, r.transfer_id is None) == (0, 5000, True)
    again = api.credit_user(creator.pk, 5000, "sys:promo", "grant", "tuzi_grant", "1", k)
    assert again.status == "replayed" and again.credited == 0 and again.debt_repaid == 5000
    assert balance_of(f"user:{creator.pk}") == 0
    assert_invariants()


def test_credit_user_validation(creator_factory):
    creator = creator_factory(tuzis=Decimal("0"))
    for args in [
        (creator.pk, 0, "sys:promo", "grant", "x", "1", key()),
        (creator.pk, 5, "sys:promo", "purchase", "x", "1", key()),       # purchases go through credit_purchase
        (creator.pk, 5, "sys:nope", "grant", "x", "1", key()),
        (creator.pk, 5, f"user:{creator.pk}", "grant", "x", "1", key()),   # source must be a system account
        (creator.pk, 5, "sys:clearing_stripe", "refund", "x", "1", key()),  # a rail: credit_purchase only ( review)
        (creator.pk, 5, "sys:clearing_zec", "grant", "x", "1", key()),
        (creator.pk, 5, "sys:promo", "grant", "x", "1", None),           # idem required
        (creator.pk, 5, "sys:promo", "grant", "x", "1", ""),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            api.credit_user(*args)


# ------------------------------------------------------------------ transfer_users


def test_transfer_users_moves_credits_and_repays_the_recipients_debt_first(creator_factory, assert_invariants):
    a = creator_factory(tuzis=Decimal("10"))
    b = creator_factory(tuzis=Decimal("0"))
    in_debt(b, 3000)
    k = key("donation")
    r = api.transfer_users(a.pk, b.pk, 5000, "donation", "intent-1", k)
    assert (r.status, r.from_balance) == ("posted", 5000)
    assert balance_of(f"user:{b.pk}") == 2000 and balance_of(f"user_debt:{b.pk}") == 0
    assert tuzis_of(a) == Decimal("5") and tuzis_of(b) == Decimal("2")
    legs = transfers(debit_account_id=account(f"user:{a.pk}")[0])
    assert [(t[3], t[4], t[5]) for t in legs] == [(3000, "debt_repay", "donation"), (2000, "transfer", "donation")]
    assert_invariants()
    again = api.transfer_users(a.pk, b.pk, 5000, "donation", "intent-1", k)
    assert again == api.TransferResult("replayed", 5000, r.transfer_id, r.repay_transfer_id)
    assert_invariants()
    #  review: the replay's from_balance is read after the sender's
    # account is locked and healed, so a legacy drift in between is absorbed.
    sql("UPDATE g12f_creator SET tuzis = tuzis + 3 WHERE id = %s", [a.pk])
    healed = api.transfer_users(a.pk, b.pk, 5000, "donation", "intent-1", k)
    assert healed == api.TransferResult("replayed", 8000, r.transfer_id, r.repay_transfer_id)
    assert len(transfers(code="legacy_adjustment")) == 1
    assert_invariants()


def test_a_transfer_that_only_repays_debt_replays_with_the_same_two_ids(creator_factory, assert_invariants):
    """Codex finding on: the replay must not report the repay leg's id
    as the transfer id too, or a consumer counts one journal row twice."""
    a = creator_factory(tuzis=Decimal("10"))
    b = creator_factory(tuzis=Decimal("0"))
    in_debt(b, 5000)
    k = key("donation")
    r = api.transfer_users(a.pk, b.pk, 5000, "donation", "", k)
    assert (r.status, r.transfer_id, r.repay_transfer_id is not None) == ("posted", None, True)
    again = api.transfer_users(a.pk, b.pk, 5000, "donation", "", k)
    assert again == api.TransferResult("replayed", 5000, None, r.repay_transfer_id)
    assert balance_of(f"user:{b.pk}") == 0 and balance_of(f"user_debt:{b.pk}") == 0
    assert_invariants()


def test_transfer_users_refusals_return_the_claim(creator_factory, assert_invariants):
    a = creator_factory(tuzis=Decimal("1"))
    b = creator_factory(tuzis=Decimal("0"))
    k = key("donation")
    assert api.transfer_users(a.pk, b.pk, 1001, "donation", "", k) == api.TransferResult("insufficient", 1000, None, None)
    assert sql("SELECT 1 FROM ledger_transfer_key WHERE idem = %s", [k]) == []
    b.is_active = False
    b.save(update_fields=["is_active"])
    assert api.transfer_users(a.pk, b.pk, 100, "donation", "", k) == api.TransferResult("inactive", 1000, None, None)
    # Codex round 3: a sender with no account yet, or a stale one, still gets
    # the authoritative balance -- the account is opened and healed first.
    fresh = creator_factory(tuzis=Decimal("7"))
    assert api.transfer_users(fresh.pk, b.pk, 100, "donation", "", key()) == api.TransferResult("inactive", 7000, None, None)
    sql("UPDATE g12f_creator SET tuzis = tuzis + 2 WHERE id = %s", [fresh.pk])
    assert api.transfer_users(fresh.pk, b.pk, 100, "donation", "", key()).from_balance == 9000
    b.is_active = True
    b.save(update_fields=["is_active"])
    sql("UPDATE ledger_account SET frozen = true WHERE key = %s", [f"user:{a.pk}"])
    assert api.transfer_users(a.pk, b.pk, 100, "donation", "", k).status == "frozen"
    sql("UPDATE ledger_account SET frozen = false WHERE key = %s", [f"user:{a.pk}"])
    in_debt(a, 10)
    assert api.transfer_users(a.pk, b.pk, 100, "donation", "", k).status == "in_debt", "the clawback escape (§5.9)"
    assert sql("SELECT 1 FROM ledger_transfer_key WHERE idem = %s", [k]) == []
    assert balance_of(f"user:{b.pk}") == 0
    assert_invariants()
    for args in [(a.pk, a.pk, 1, "donation", "", key()), (a.pk, b.pk, 0, "donation", "", key()),
                 (a.pk, b.pk, 1, "donation", "", None), (a.pk, 999_999_999, 1, "donation", "", key())]:
        with pytest.raises(DatabaseError), transaction.atomic():
            api.transfer_users(*args)


def test_transfer_users_in_either_pk_order(creator_factory, assert_invariants):
    a = creator_factory(tuzis=Decimal("5"))
    b = creator_factory(tuzis=Decimal("5"))
    assert a.pk < b.pk
    assert api.transfer_users(b.pk, a.pk, 2000, "donation", "", key()).status == "posted"
    assert api.transfer_users(a.pk, b.pk, 500, "donation", "", key()).status == "posted"
    assert balance_of(f"user:{a.pk}") == 6500 and balance_of(f"user:{b.pk}") == 3500
    assert_invariants()


def test_units_convert_exactly_at_the_boundary():
    assert api.to_m2z(Decimal("123.456")) == 123456
    assert api.to_m2z("0.001") == 1 and api.to_m2z(7) == 7000
    assert api.from_m2z(123456) == Decimal("123.456") and api.from_m2z(None) is None
    for bad in ("0.0005", "nan", "x"):
        with pytest.raises(ValueError):
            api.to_m2z(bad)
    with pytest.raises(TypeError):
        api.to_m2z(0.1)
