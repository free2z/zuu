"""The rollout-window self-heal, ``ledger.heal_balance`` (design §10 step 3).

An old pod writing ``Creator.tuzis`` directly during the minutes of the
dual-write rollout leaves ``balance <> tuzis*1000``; the next ledger touch
absorbs the difference into the journal as a ``legacy_adjustment`` from or
to ``sys:opening_equity``, under the creator lock. An upward heal meets an
outstanding debt first (R14). ``heal_enabled = false`` retires it.
"""
from decimal import Decimal

import pytest

from dj.apps.ledger import api
from dj.apps.ledger.models import Config

from .conftest import account, balance_of, key, one, sql, sys_id, transfers, tuzis_of

pytestmark = pytest.mark.django_db


def legacy_write(creator, delta):
    """What an old pod does: moves tuzis behind the ledger's back."""
    sql("UPDATE g12f_creator SET tuzis = tuzis + %s WHERE id = %s", [Decimal(delta), creator.pk])


def test_upward_drift_is_absorbed_on_the_next_touch(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("10"))
    acct = api.ensure_account(creator.pk)
    legacy_write(creator, "5")
    assert balance_of(f"user:{creator.pk}") == 10000 and tuzis_of(creator) == Decimal("15")
    result = api.spend(creator.pk, 1000, "page_vote")
    assert result.status == "posted" and result.balance == 14000
    adj = transfers(code="legacy_adjustment")
    assert len(adj) == 1 and adj[0][1:4] == (sys_id("sys:opening_equity"), acct, 5000)
    assert tuzis_of(creator) == Decimal("14")
    assert_invariants()


def test_downward_drift_is_absorbed_even_under_a_hold(creator_factory, assert_invariants):
    """The one writer allowed to leave balance < held: it writes directly,
    because post_transfer's CAS would refuse a downward heal."""
    creator = creator_factory(tuzis=Decimal("10"))
    acct = api.ensure_account(creator.pk)
    sql("UPDATE ledger_account SET held = 8000 WHERE id = %s", [acct])
    legacy_write(creator, "-6")
    result = api.spend(creator.pk, 1000, "page_vote")
    assert result.status == "insufficient" and result.balance == 4000 and result.available == -4000
    adj = transfers(code="legacy_adjustment")
    assert len(adj) == 1 and adj[0][1:4] == (acct, sys_id("sys:opening_equity"), 6000)
    assert account(f"user:{creator.pk}")[1:3] == (4000, 8000)
    assert_invariants()


def test_an_upward_heal_repays_debt_first_bounded_by_availability(creator_factory, assert_invariants):
    creator = creator_factory(tuzis=Decimal("0"))
    api.ensure_account(creator.pk)
    api.clawback(creator.pk, 3000, "sys:clearing_stripe", "clawback", "refund", "stripe_transaction", "1", key())
    assert balance_of(f"user_debt:{creator.pk}") == -3000
    legacy_write(creator, "5")
    result = api.spend_up_to(creator.pk, 100, "page_vote")
    assert result.charged == 100, "after the heal repaid the debt, the rest is spendable"
    assert balance_of(f"user_debt:{creator.pk}") == 0
    assert balance_of(f"user:{creator.pk}") == 1900 and tuzis_of(creator) == Decimal("1.9")
    repay = transfers(code="debt_repay")
    assert len(repay) == 1 and repay[0][3] == 3000
    assert_invariants()


def test_an_upward_heal_never_repays_more_than_is_available_under_a_hold(creator_factory, assert_invariants):
    """Deviation #5: repay = least(debt, delta, target - held). With a hold
    outstanding the doc's least(debt, delta) would ask post_transfer for
    more than balance - held and RAISE inside every touch of the account."""
    creator = creator_factory(tuzis=Decimal("0"))
    acct = api.ensure_account(creator.pk)
    api.clawback(creator.pk, 5000, "sys:clearing_stripe", "clawback", "refund", "stripe_transaction", "1", key())
    sql("UPDATE ledger_account SET held = 2000 WHERE id = %s", [acct])   # a hold from the rollout window
    legacy_write(creator, "4")                                            # target 4000, delta 4000
    result = api.spend_up_to(creator.pk, 100, "page_vote")
    assert result.charged == 0, "still in debt after the bounded repayment"
    assert account(f"user:{creator.pk}")[1:3] == (2000, 2000)            # repaid 2000 = least(5000, 4000, 4000 - 2000)
    assert balance_of(f"user_debt:{creator.pk}") == -3000
    assert tuzis_of(creator) == Decimal("2")
    assert_invariants()


def test_negative_control_the_unbounded_repayment_raises(creator_factory):
    from .conftest import function_def
    defn = function_def("heal_balance")
    needle = "greatest(least(v_debt, v_delta, v_target - a.held), 0)"
    assert defn.count(needle) == 1
    sql(defn.replace(needle, "greatest(least(v_debt, v_delta), 0)"))
    creator = creator_factory(tuzis=Decimal("0"))
    acct = api.ensure_account(creator.pk)
    api.clawback(creator.pk, 5000, "sys:clearing_stripe", "clawback", "refund", "stripe_transaction", "1", key())
    sql("UPDATE ledger_account SET held = 2000 WHERE id = %s", [acct])
    legacy_write(creator, "4")
    with pytest.raises(Exception, match="debt repayment refused"):
        api.spend_up_to(creator.pk, 100, "page_vote")


def test_a_frozen_account_in_debt_still_repays_from_an_upward_heal(creator_factory, assert_invariants):
    """A dispute freezes AND creates debt (§4.3): debt_repay is on the
    frozen allow-list, so the heal's repayment posts on a frozen account
    while the spend itself is still refused as frozen."""
    creator = creator_factory(tuzis=Decimal("0"))
    api.ensure_account(creator.pk)
    api.clawback(creator.pk, 3000, "sys:clearing_stripe", "clawback", "dispute", "stripe_transaction", "1", key(),
                 freeze=True)
    assert account(f"user:{creator.pk}")[3] is True
    legacy_write(creator, "5")
    result = api.spend(creator.pk, 100, "page_vote")
    assert result.status == "frozen" and result.balance == 2000
    assert balance_of(f"user_debt:{creator.pk}") == 0 and tuzis_of(creator) == Decimal("2")
    assert [t[4] for t in transfers()] == ["clawback_debt", "legacy_adjustment", "debt_repay"]
    assert_invariants()


def test_heal_is_off_when_heal_enabled_is_false(creator_factory):
    creator = creator_factory(tuzis=Decimal("10"))
    api.ensure_account(creator.pk)
    Config.objects.update(heal_enabled=False)
    legacy_write(creator, "5")
    result = api.spend(creator.pk, 1000, "page_vote")
    assert result.status == "posted" and result.balance == 9000
    assert transfers(code="legacy_adjustment") == []
    assert tuzis_of(creator) == Decimal("14"), "the drift is now R2's to report"
    from dj.apps.ledger import invariants
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{creator.pk}", 14000, 9000)]


def test_heal_refuses_a_non_user_account():
    with pytest.raises(Exception, match="not a user account"):
        one("SELECT ledger.heal_balance(%s, 0)", [sys_id("sys:promo")])
