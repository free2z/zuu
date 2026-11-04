"""``ledger.post_transfer`` and ``ledger.ensure_account`` (design §4.2–§4.4).

Every write is followed by the L1 reconciliation invariants (R1–R3, §11).
"""
from decimal import Decimal

import pytest
from django.db import DatabaseError, transaction

from dj.apps.ledger import api
from dj.apps.ledger.models import Config

from .conftest import (
    account, balance_of, function_def, key, one, post, sql, sys_id, transfers,
    tuzis_of,
)

pytestmark = pytest.mark.django_db


def open_account(creator):
    acct = api.ensure_account(creator.pk)
    return acct


# ------------------------------------------------------------ ensure_account


def test_ensure_account_opens_from_creator_tuzis_without_touching_tuzis(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("123.456"))
    acct = open_account(creator)
    assert account(f"user:{creator.pk}") == (acct, 123456, 0, False)
    (opening,) = transfers(credit_account_id=acct)
    assert opening[1:] == (sys_id("sys:opening_equity"), acct, 123456, "opening", "creator", str(creator.pk))
    assert tuzis_of(creator) == Decimal("123.456"), "opening is derived from tuzis; not applied back (§4.4)"
    assert_invariants()
    assert api.ensure_account(creator.pk) == acct, "idempotent"
    assert len(transfers(credit_account_id=acct)) == 1
    assert_invariants()


def test_ensure_account_with_zero_balance_posts_nothing(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("0"))
    acct = open_account(creator)
    assert account(f"user:{creator.pk}")[1] == 0
    assert transfers(credit_account_id=acct) == []
    assert_invariants()


def test_ensure_account_needs_a_creator():
    with pytest.raises(LookupError):
        api.ensure_account(999_999_999)
    with pytest.raises(DatabaseError), transaction.atomic():
        sql("SELECT ledger.ensure_account(999999999)")


def test_negative_control_without_the_opening_exemption_the_balance_doubles(creator_factory):
    """§4.4: `opening` is exempt from the dual-write projection. Remove the
    exemption (in this test's transaction only) and opening a 100-2Z account
    puts 200 on Creator.tuzis -- the bug the exemption exists to prevent."""
    defn = function_def("post_transfer")
    needle = "p_code NOT IN ('opening', 'legacy_adjustment')"
    assert defn.count(needle) == 2, "the projection is guarded on both sides"
    sql(defn.replace(needle, "TRUE"))
    creator = creator_factory(tuzis=Decimal("100"))
    open_account(creator)
    assert tuzis_of(creator) == Decimal("200")
    # R2 is the invariant that catches it.
    from dj.apps.ledger import invariants
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{creator.pk}", 200000, 100000)]


# ------------------------------------------------------------ post_transfer


def test_posted_updates_maintained_sides_only_and_projects_tuzis(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = open_account(creator)
    promo = sys_id("sys:promo")
    tid, status = post(promo, acct, 2500, "grant", "test", "1")
    assert status == "posted" and tid
    assert balance_of(f"user:{creator.pk}") == 12500
    assert balance_of("sys:promo") == 0, "journal-only: no UPDATE on the hot path (§2.1)"
    assert tuzis_of(creator) == Decimal("12.5"), "dual-write projection (§4.4)"
    assert_invariants()
    tid2, status = post(acct, sys_id("sys:platform_revenue"), 500, "spend", "page_vote", "7")
    assert status == "posted" and tid2 > tid
    assert balance_of(f"user:{creator.pk}") == 12000 and tuzis_of(creator) == Decimal("12")
    assert_invariants()


def test_insufficient_is_a_status_and_the_cas_counts_held_credits(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = open_account(creator)
    sink = sys_id("sys:platform_revenue")
    assert post(acct, sink, 10001, "spend")[1] == "insufficient"
    sql("UPDATE ledger_account SET held = 4000 WHERE id = %s", [acct])
    assert post(acct, sink, 6001, "spend")[1] == "insufficient"
    assert post(acct, sink, 6000, "spend")[1] == "posted"
    assert account(f"user:{creator.pk}")[1:3] == (4000, 4000)
    assert tuzis_of(creator) == Decimal("4"), "a hold does not reduce tuzis; a spend does (§4.4)"
    assert_invariants()


def test_frozen_refuses_spends_but_not_the_allowlisted_codes(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = open_account(creator)
    sql("UPDATE ledger_account SET frozen = true, frozen_reason = 'dispute' WHERE id = %s", [acct])
    assert post(acct, sys_id("sys:platform_revenue"), 1000, "spend")[1] == "frozen"
    assert post(acct, sys_id("sys:ai_clearing"), 1000, "ai_settle", "hold", "x")[1] == "posted"
    assert post(acct, sys_id("sys:clearing_stripe"), 1000, "clawback", "stripe_transaction", "1")[1] == "posted"
    assert post(sys_id("sys:promo"), acct, 1000, "grant")[1] == "posted", "credits into a frozen account are fine"
    assert balance_of(f"user:{creator.pk}") == 9000
    assert_invariants()


def test_programming_errors_raise(creator_factory):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = open_account(creator)
    for args in [(acct, sys_id("sys:promo"), 0, "spend"), (acct, sys_id("sys:promo"), -5, "spend"),
                 (acct, acct, 5, "spend"), (acct, 999_999_999, 5, "spend"), (acct, sys_id("sys:promo"), 5, "bogus")]:
        with pytest.raises(DatabaseError), transaction.atomic():
            post(*args)


def test_a_user_debt_account_can_only_be_debited_by_the_two_debt_codes(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("0"))
    open_account(creator)
    debt = one("INSERT INTO ledger_account (key, kind, owner_id, journal_only) VALUES (%s, 'user_debt', %s, false) "
               "RETURNING id", [f"user_debt:{creator.pk}", creator.pk])[0]
    clearing = sys_id("sys:clearing_stripe")
    assert post(debt, clearing, 300, "spend")[1] == "insufficient"
    assert post(debt, clearing, 300, "clawback_debt", "stripe_transaction", "1")[1] == "posted"
    assert balance_of(f"user_debt:{creator.pk}") == -300
    assert tuzis_of(creator) == Decimal("0"), "debt is not projected onto tuzis"
    assert post(clearing, debt, 300, "debt_repay")[1] == "posted"
    assert balance_of(f"user_debt:{creator.pk}") == 0
    with pytest.raises(DatabaseError), transaction.atomic():   # ledger_account_debt_nonpos_chk
        post(clearing, debt, 1, "debt_repay")
    assert_invariants()


# ------------------------------------------------------------ idempotency


def test_keyed_post_replays_with_the_winners_transfer_id(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = open_account(creator)
    k = key("grant")
    tid, status = post(sys_id("sys:promo"), acct, 1000, "grant", "tuzi_grant", "1", idem=k)
    assert status == "posted"
    assert post(sys_id("sys:promo"), acct, 1000, "grant", "tuzi_grant", "1", idem=k) == (tid, "replayed")
    assert post(sys_id("sys:promo"), acct, 999999, "grant", "tuzi_grant", "1", idem=k) == (tid, "replayed")
    assert balance_of(f"user:{creator.pk}") == 11000, "credited once"
    assert one("SELECT transfer_id FROM ledger_transfer_key WHERE idem = %s", [k])[0] == tid
    assert_invariants()


def test_a_refusal_returns_the_claim_so_the_retry_after_a_top_up_posts(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("1"))
    acct = open_account(creator)
    sink = sys_id("sys:platform_revenue")
    k = key("spend")
    assert post(acct, sink, 5000, "spend", "page_vote", "1", idem=k)[1] == "insufficient"
    assert sql("SELECT 1 FROM ledger_transfer_key WHERE idem = %s", [k]) == [], "the claim was deleted"
    post(sys_id("sys:promo"), acct, 10000, "grant")
    assert post(acct, sink, 5000, "spend", "page_vote", "1", idem=k)[1] == "posted"
    assert_invariants()
    # frozen, likewise
    sql("UPDATE ledger_account SET frozen = true WHERE id = %s", [acct])
    k2 = key("spend")
    assert post(acct, sink, 100, "spend", idem=k2)[1] == "frozen"
    assert sql("SELECT 1 FROM ledger_transfer_key WHERE idem = %s", [k2]) == []


def test_negative_control_an_unkeyed_post_is_posted_twice(creator_factory):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = open_account(creator)
    post(sys_id("sys:promo"), acct, 1000, "grant", "tuzi_grant", "1")
    post(sys_id("sys:promo"), acct, 1000, "grant", "tuzi_grant", "1")
    assert balance_of(f"user:{creator.pk}") == 12000


# ------------------------------------------------------------ dual_write off


def test_with_dual_write_off_tuzis_is_not_projected(creator_factory):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = open_account(creator)
    Config.objects.update(dual_write=False)
    assert one("SELECT ledger.dual_write()")[0] is False
    post(sys_id("sys:promo"), acct, 1000, "grant")
    assert balance_of(f"user:{creator.pk}") == 11000 and tuzis_of(creator) == Decimal("10")


def test_a_missing_config_row_is_loud_not_a_silent_false(creator_factory):
    Config.objects.all().delete()
    with pytest.raises(DatabaseError), transaction.atomic():
        sql("SELECT ledger.dual_write()")
