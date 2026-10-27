"""The dual-write release (docs/tuzis/ledger-v2.md §10 steps 2-3, ).

Every ``tuzis/ledger.py`` primitive now runs over the L1 SQL functions and
``Creator.tuzis`` is moved by ``post_transfer``'s projection. These tests
pin what that must mean, against REAL Postgres (repo rule):

* R1, R2 and R3 hold after every path -- debit, debit_up_to, credit (both
  the purchase and the user-credit shape), transfer, and the three
  reservation calls -- and the user-visible numbers are what they were.
* **Mixed fleet**: an "old pod" writes ``Creator.tuzis`` directly between
  two new-code calls; the next touch absorbs the drift under the creator
  lock as a ``legacy_adjustment`` row, in the right direction, and R2 holds
  again. A reservation an old pod made (no journal row) is released or
  settled by the new code through the pre-rollout branch.
* ``credit`` refuses a bare call, refuses an unknown ``ref_kind``, and
  replays on a repeated key instead of crediting twice.
* ``dual_write_since`` is stamped by the first ledger write.

``py/conftest.py`` additionally asserts R1 and R3 at the end of every test in
the suite that issued a ledger statement, so the existing money tests are
dual-write proofs too; R2 is asserted here explicitly because a test that
simulates an old pod legitimately leaves it drifted until the next touch.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import DatabaseError, connection, transaction
from django.utils import timezone

from dj.apps.g12f.models import Creator
from dj.apps.ledger import api, invariants
from dj.apps.ledger.models import Config, Transfer
from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import STALE_CLAIM, ProviderReservation

pytestmark = pytest.mark.django_db


def journaled_pod_reserves(creator, amount, *, scope, operation_key):
    """Emulate the pre-L2 dual-write image without a production bypass."""
    with transaction.atomic():
        locked = api.lock_creator(creator.pk)
        account = api.lock_account(locked.id, locked.balance)
        row = ProviderReservation.objects.create(user=creator, amount=amount, scope=scope,
                                                  operation_key=operation_key)
        posted = api.post_transfer(account.id, api.system_account_id('sys:reservation_clearing'),
                                   api.to_m2z(amount), 'spend', 'reservation', str(row.pk))
        assert posted.posted
        api.stamp_dual_write_since()
        return row


def balance(creator) -> Decimal:
    return Creator.objects.get(pk=creator.pk).tuzis


def account_balance(creator) -> int | None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT balance FROM ledger_account WHERE key = %s", [f"user:{creator.pk}"])
        row = cursor.fetchone()
    return None if row is None else int(row[0])


def journal(**where):
    return list(Transfer.objects.filter(**where).order_by("id").values_list(
        "code", "ref_kind", "ref_id", "amount", "debit_account_id", "credit_account_id"))


def sys_id(key: str) -> int:
    return api.system_account_id(key)


def old_pod_writes(creator, delta):
    """What a pod on the previous image does: moves the column and journals
    nothing. Same statement shape as the old ``debit``/``credit``."""
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE g12f_creator SET tuzis = tuzis + %s WHERE id = %s", [Decimal(delta), creator.pk],
        )


def old_pod_reserves(creator, amount, *, scope="ai_image", age=timedelta(0)) -> ProviderReservation:
    """A reservation made by the old code: the row exists, ``tuzis`` went
    down, and there is no ``spend / reservation / <pk>`` transfer."""
    old_pod_writes(creator, -Decimal(amount))
    row = ProviderReservation.objects.create(
        scope=scope, operation_key=uuid.uuid4(), user_id=creator.pk, amount=Decimal(amount),
    )
    if age:
        ProviderReservation.objects.filter(pk=row.pk).update(created_at=timezone.now() - age)
        row.refresh_from_db()
    return row


def assert_r123():
    invariants.assert_all()


def grant(creator, amount, ref="1"):
    return ledger.credit(
        creator, amount, source="sys:promo", ref_kind="tuzi_grant",
        ref_id=ref, idem=f"test-grant:{uuid.uuid4()}",
    )


# --------------------------------------------------------------- each path


def test_debit_dual_writes(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    assert account_balance(user) is None, "untouched creators have no account yet (§10 step 2)"
    assert ledger.debit(user, 3, action="comment_vote") == Decimal("7")
    assert user.tuzis == Decimal("7") and balance(user) == Decimal("7")
    assert account_balance(user) == 7000
    assert journal(code="spend") == [("spend", "comment_vote", "", 3000, api.user_account_id(user.pk),
                                      sys_id("sys:platform_revenue"))]
    assert journal(code="opening")[0][3] == 10000
    assert_r123()


def test_debit_refusal_moves_nothing_and_reports_the_authoritative_balance(creator_factory):
    user = creator_factory(tuzis=Decimal("2"))
    with pytest.raises(ledger.InsufficientFunds) as info:
        ledger.debit(user, 5, action="page_fund")
    assert info.value.balance == Decimal("2") and info.value.action == "page_fund"
    assert ledger.insufficient_funds_payload(info.value) == {
        "code": "insufficient_funds", "cost": "5.000", "balance": "2.000",
        "shortfall": "3.000", "action": "page_fund",
    }
    assert balance(user) == Decimal("2") and journal(code="spend") == []
    assert_r123()


def test_debit_up_to_clamps_and_journals_what_moved(creator_factory):
    user = creator_factory(tuzis=Decimal("1.5"))
    assert ledger.debit_up_to(user, 4, action="platform_fee") == Decimal("1.5")
    assert balance(user) == Decimal("0") and account_balance(user) == 0
    assert journal(code="spend_up_to")[0][:4] == ("spend_up_to", "platform_fee", "", 1500)
    assert ledger.debit_up_to(user, 4, action="platform_fee") == Decimal("0")
    assert len(journal(code="spend_up_to")) == 1
    assert_r123()


def test_credit_from_a_system_account_dual_writes(creator_factory):
    user = creator_factory(tuzis=Decimal("1"))
    assert grant(user, 4) == Decimal("5")
    assert balance(user) == Decimal("5") and account_balance(user) == 5000
    assert journal(code="grant")[0][:4] == ("grant", "tuzi_grant", "1", 4000)
    assert_r123()


def test_purchase_credit_uses_the_rail_and_writes_the_refund_cursor(creator_factory):
    user = creator_factory(tuzis=Decimal("0"))
    key = f"stripe:pi_{uuid.uuid4().hex}"
    assert ledger.credit(user, 21, source="sys:clearing_stripe", ref_kind="stripe_transaction",
                         ref_id="77", idem=key) == Decimal("21")
    assert journal(code="purchase") == [("purchase", "stripe_transaction", "77", 21000,
                                         sys_id("sys:clearing_stripe"), api.user_account_id(user.pk))]
    with connection.cursor() as cursor:
        cursor.execute("SELECT rail, credited_m2z, refunded_m2z FROM ledger_purchase_refund "
                       "WHERE ref_kind = 'stripe_transaction' AND ref_id = '77'")
        assert cursor.fetchone() == ("stripe", 21000, 0)
    assert_r123()


def test_credit_replays_on_the_same_key_instead_of_crediting_twice(creator_factory):
    user = creator_factory(tuzis=Decimal("0"))
    key = f"test-grant:{uuid.uuid4()}"
    kwargs = dict(source="sys:promo", ref_kind="tuzi_grant", ref_id="9", idem=key)
    assert ledger.credit(user, 4, **kwargs) == Decimal("4")
    assert ledger.credit(user, 4, **kwargs) == Decimal("4"), "a replay returns the balance"
    assert balance(user) == Decimal("4") and len(journal(code="grant")) == 1
    assert_r123()


def test_credit_refuses_a_bare_call_an_unknown_kind_and_a_wrong_source(creator_factory):
    user = creator_factory(tuzis=Decimal("0"))
    with pytest.raises(TypeError):
        ledger.credit(user, 4)
    with pytest.raises(ValueError, match="unknown credit ref_kind"):
        ledger.credit(user, 4, source="sys:promo", ref_kind="mystery", ref_id="1", idem="k1")
    with pytest.raises(ValueError, match="purchase rail"):
        ledger.credit(user, 4, source="sys:promo", ref_kind="stripe_transaction", ref_id="1", idem="k2")
    with pytest.raises(ValueError, match="is a rail"):
        ledger.credit(user, 4, source="sys:clearing_stripe", ref_kind="tuzi_grant", ref_id="1", idem="k3")
    with pytest.raises(ValueError, match="idempotency key"):
        ledger.credit(user, 4, source="sys:promo", ref_kind="tuzi_grant", ref_id="1", idem="")
    assert balance(user) == Decimal("0") and account_balance(user) is None


def test_transfer_dual_writes_both_sides(creator_factory):
    fan = creator_factory(tuzis=Decimal("10"))
    star = creator_factory(tuzis=Decimal("1"))
    assert ledger.transfer(fan, star, 4, action="donation") == Decimal("6")
    assert fan.tuzis == Decimal("6") and star.tuzis == Decimal("5"), "both instances refreshed"
    assert balance(fan) == Decimal("6") and balance(star) == Decimal("5")
    assert account_balance(fan) == 6000 and account_balance(star) == 5000
    assert journal(code="transfer")[0][:4] == ("transfer", "donation", "", 4000)
    assert_r123()


def test_transfer_to_an_inactive_recipient_and_a_short_sender_move_nothing(creator_factory):
    fan = creator_factory(tuzis=Decimal("3"))
    gone = creator_factory(tuzis=Decimal("0"), is_active=False)
    with pytest.raises(ledger.InactiveCreator):
        ledger.transfer(fan, gone, 1, action="donation")
    star = creator_factory(tuzis=Decimal("0"))
    with pytest.raises(ledger.InsufficientFunds) as info:
        ledger.transfer(fan, star, 5, action="donation")
    assert info.value.balance == Decimal("3")
    assert balance(fan) == Decimal("3") and balance(star) == Decimal("0")
    assert journal(code="transfer") == []
    assert_r123()


# --------------------------------------------------------------- reservations


def test_reserve_settle_is_journaled_through_reservation_clearing(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    row = journaled_pod_reserves(user, 6, scope="ai_image", operation_key=uuid.uuid4())
    assert balance(user) == Decimal("4") and account_balance(user) == 4000
    clearing = sys_id("sys:reservation_clearing")
    assert journal(ref_kind="reservation") == [
        ("spend", "reservation", str(row.pk), 6000, api.user_account_id(user.pk), clearing)]
    assert_r123()

    ledger.settle_reservation(row)
    assert balance(user) == Decimal("4"), "the credits were the charge"
    assert journal(ref_kind="reservation_settle") == [
        ("spend", "reservation_settle", str(row.pk), 6000, clearing, sys_id("sys:platform_revenue"))]
    assert ProviderReservation.objects.get(pk=row.pk).status == "settled"
    ledger.settle_reservation(row)
    assert len(journal(ref_kind="reservation_settle")) == 1, "exactly once"
    assert invariants.r3_all_accounts_sum_to_zero() == 0
    assert_r123()


def test_reserve_release_returns_the_credits_through_reservation_clearing(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    row = journaled_pod_reserves(user, 6, scope="ai_prompt", operation_key=uuid.uuid4())
    assert ledger.release_reservation(row) is True
    assert balance(user) == Decimal("10") and account_balance(user) == 10000
    clearing = sys_id("sys:reservation_clearing")
    assert journal(code="refund") == [
        ("refund", "reservation", str(row.pk), 6000, clearing, api.user_account_id(user.pk))]
    assert ledger.release_reservation(row) is False
    assert_r123()


def test_reserve_refuses_without_moving_anything(creator_factory):
    user = creator_factory(tuzis=Decimal("2"))
    with pytest.raises(ledger.InsufficientFunds) as info:
        ledger.reserve(user, 6, scope="ai_image", operation_key=uuid.uuid4())
    assert info.value.balance == Decimal("2") and info.value.action == "ai_image"
    assert not ProviderReservation.objects.filter(user_id=user.pk).exists()
    assert balance(user) == Decimal("2") and journal(ref_kind="reservation") == []
    assert_r123()


def test_a_pre_rollout_reservation_is_released_as_a_reservation_import(creator_factory):
    """§10 step 2: a reservation an OLD pod made subtracted `tuzis` with no
    journal row, so its amount is already absent from the opening balance.
    Releasing it must not debit reservation_clearing (which never received
    it); the credits re-enter from opening equity, code `reservation_import`."""
    user = creator_factory(tuzis=Decimal("10"))
    row = old_pod_reserves(user, "6")
    assert balance(user) == Decimal("4")
    assert ledger.release_reservation(row) is True
    assert balance(user) == Decimal("10") and account_balance(user) == 10000
    assert journal(code="reservation_import") == [
        ("reservation_import", "reservation", str(row.pk), 6000, sys_id("sys:opening_equity"),
         api.user_account_id(user.pk))]
    assert journal(code="refund") == []
    assert journal(code="opening")[0][3] == 4000, "opened at the post-reservation balance"
    assert_r123()


def test_a_pre_rollout_reservation_settles_without_a_journal_row(creator_factory):
    user = creator_factory(tuzis=Decimal("10"))
    row = old_pod_reserves(user, "6")
    ledger.settle_reservation(row)
    assert ProviderReservation.objects.get(pk=row.pk).status == "settled"
    assert journal(ref_kind="reservation_settle") == [], "the charge is already inside opening equity"
    assert balance(user) == Decimal("4")
    ledger.debit(user, 1, action="ai_image")   # the next touch opens the account
    assert account_balance(user) == 3000
    assert_r123()


def test_the_stale_sweep_inside_reserve_releases_both_shapes(creator_factory):
    """`reserve` releases holds older than STALE_CLAIM before admitting a
    new one: one journaled by the new code, one made by an old pod."""
    user = creator_factory(tuzis=Decimal("20"))
    new_style = journaled_pod_reserves(user, 5, scope="ai_image", operation_key=uuid.uuid4())
    ProviderReservation.objects.filter(pk=new_style.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(minutes=1))
    old_style = old_pod_reserves(user, "7", age=STALE_CLAIM + timedelta(minutes=1))
    assert balance(user) == Decimal("8")

    fresh = ledger.reserve(user, 3, scope="ai_image", operation_key=uuid.uuid4())
    assert balance(user) == Decimal("20"), "L2 holds keep total balance intact"
    assert account_balance(user) == 20000
    assert api.read_balance(user.pk).available == 17000
    statuses = dict(ProviderReservation.objects.filter(user_id=user.pk).values_list("pk", "status"))
    assert statuses == {new_style.pk: "released", old_style.pk: "released"}
    assert fresh.pk is not None
    assert [j[:3] for j in journal(code="refund")] == [("refund", "reservation", str(new_style.pk))]
    assert [j[:3] for j in journal(code="reservation_import")] == [
        ("reservation_import", "reservation", str(old_style.pk))]
    assert_r123()


def test_r13_holds_while_a_reservation_is_in_flight(creator_factory):
    from dj.apps.tuzis.ledger_audit import (
        r13_reservation_clearing_equals_active_journaled_holds,
    )
    user = creator_factory(tuzis=Decimal("10"))
    journaled_pod_reserves(user, 6, scope="ai_image", operation_key=uuid.uuid4())
    old_pod_reserves(user, "1")   # active, un-journaled: not counted by R13
    assert r13_reservation_clearing_equals_active_journaled_holds() == (6000, 6000)


# --------------------------------------------------------------- mixed fleet


def test_mixed_fleet_drift_is_healed_under_the_creator_lock(creator_factory):
    """During the rollout OLD pods write `Creator.tuzis` directly while NEW
    pods dual-write. Interleave the two: the next new-code touch finds
    balance <> tuzis*1000, writes a `legacy_adjustment` for exactly the
    difference, and R2 holds again -- in both directions."""
    user = creator_factory(tuzis=Decimal("10"))
    ledger.debit(user, 1, action="comment_vote")           # new pod: account opened at 10, now 9
    assert account_balance(user) == 9000
    old_pod_writes(user, "-3")                              # old pod: a debit the ledger never saw
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{user.pk}", 6000, 9000)]

    assert ledger.debit(user, 1, action="comment_vote") == Decimal("5")   # new pod again
    assert account_balance(user) == 5000 and balance(user) == Decimal("5")
    heals = journal(code="legacy_adjustment")
    assert heals == [("legacy_adjustment", "creator", str(user.pk), 3000,
                      api.user_account_id(user.pk), sys_id("sys:opening_equity"))], "downward: user -> opening_equity"
    assert_r123()

    old_pod_writes(user, "+4")                              # old pod: a credit the ledger never saw
    assert invariants.r2_tuzis_projection_equals_balance() != []
    assert grant(user, 1) == Decimal("10")                  # new pod: 5 + 4 healed + 1
    heals = journal(code="legacy_adjustment")
    assert len(heals) == 2 and heals[1][3:] == (4000, sys_id("sys:opening_equity"),
                                                api.user_account_id(user.pk)), "upward: opening_equity -> user"
    assert account_balance(user) == 10000
    assert_r123()


def test_mixed_fleet_drift_is_healed_on_a_transfer_and_a_reservation(creator_factory):
    fan = creator_factory(tuzis=Decimal("10"))
    star = creator_factory(tuzis=Decimal("0"))
    ledger.transfer(fan, star, 1, action="donation")
    old_pod_writes(fan, "-2")
    old_pod_writes(star, "+5")
    ledger.transfer(fan, star, 1, action="donation")
    assert balance(fan) == Decimal("6") and balance(star) == Decimal("7")
    assert account_balance(fan) == 6000 and account_balance(star) == 7000
    assert sorted(h[3] for h in journal(code="legacy_adjustment")) == [2000, 5000]
    assert_r123()

    old_pod_writes(fan, "-1")
    ledger.reserve(fan, 2, scope="ai_image", operation_key=uuid.uuid4())
    assert balance(fan) == Decimal("5") and account_balance(fan) == 5000
    assert api.read_balance(fan.pk).available == 3000
    assert len(journal(code="legacy_adjustment")) == 3
    assert_r123()


def test_a_debit_raced_by_an_old_pod_write_cannot_overspend(creator_factory):
    """The heal and the spend are one statement under one creator lock: an
    old-pod write that lands first is seen, one that lands after waits."""
    user = creator_factory(tuzis=Decimal("3"))
    ledger.debit(user, 1, action="comment_vote")
    old_pod_writes(user, "-2")                       # balance in the column: 0
    with pytest.raises(ledger.InsufficientFunds) as info:
        ledger.debit(user, 1, action="comment_vote")
    assert info.value.balance == Decimal("0")
    assert account_balance(user) == 0 and balance(user) == Decimal("0")
    assert journal(code="legacy_adjustment")[0][3] == 2000
    assert_r123()


# --------------------------------------------------------------- rollout config


def test_dual_write_since_is_stamped_after_the_first_ledger_write_commits(
    creator_factory, django_capture_on_commit_callbacks,
):
    """Stamped by the first write -- but AFTER its transaction commits, as
    its own statement (codex round 5 of ): inside the money transaction
    the singleton row's lock, held next to creator locks, is a deadlock
    between two processes in the first-write window."""
    api.forget_dual_write_since_stamp()
    Config.objects.update(dual_write_since=None)
    user = creator_factory(tuzis=Decimal("5"))
    before = timezone.now()
    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        with transaction.atomic():
            ledger.debit(user, 1, action="comment_vote")
            assert Config.objects.get().dual_write_since is None, "not inside the money transaction"
    assert len(callbacks) == 1
    stamped = Config.objects.get().dual_write_since
    assert stamped is not None and stamped >= before - timedelta(seconds=5)
    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        ledger.debit(user, 1, action="comment_vote")
    assert callbacks == [] and Config.objects.get().dual_write_since == stamped, "stamped once per process"


def test_a_failing_stamp_never_fails_the_committed_money_operation(
    creator_factory, django_capture_on_commit_callbacks, monkeypatch, caplog,
):
    """The stamp runs after the money committed; if IT fails, the caller
    must still see success -- a 500 on a committed donation invites a retry
    that charges twice (codex round 6). The next write stamps instead."""
    import logging

    api.forget_dual_write_since_stamp()
    Config.objects.update(dual_write_since=None)
    user = creator_factory(tuzis=Decimal("5"))
    real_cursor = connection.cursor

    class _Boom:
        def __enter__(self):
            raise DatabaseError("connection dropped after commit")

        def __exit__(self, *exc):
            return False

    try:
        with caplog.at_level(logging.ERROR):
            with django_capture_on_commit_callbacks(execute=True) as callbacks:
                with transaction.atomic():
                    balance = ledger.debit(user, 1, action="comment_vote")
                # The money committed; the connection dies before the
                # after-commit stamp runs (callbacks fire when the capture exits).
                monkeypatch.setattr(connection, "cursor", lambda *a, **k: _Boom())
    finally:
        monkeypatch.setattr(connection, "cursor", real_cursor)
    assert balance == Decimal("4") and len(callbacks) == 1, "the debit itself succeeded"
    assert "connection dropped after commit" in caplog.text
    assert Config.objects.get().dual_write_since is None
    with django_capture_on_commit_callbacks(execute=True):
        ledger.debit(user, 1, action="comment_vote")
    assert Config.objects.get().dual_write_since is not None, "the next write stamps"


def test_a_refused_write_does_not_stamp(creator_factory, django_capture_on_commit_callbacks):
    api.forget_dual_write_since_stamp()
    Config.objects.update(dual_write_since=None)
    user = creator_factory(tuzis=Decimal("0"))
    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        with pytest.raises(ledger.InsufficientFunds):
            ledger.debit(user, 1, action="comment_vote")
    assert callbacks == [] and Config.objects.get().dual_write_since is None


def test_the_heal_can_be_retired(creator_factory):
    """`heal_enabled = false` (an owner action after the rollout, §10 step
    5): drift is then R2's to report, and the wrappers keep working."""
    user = creator_factory(tuzis=Decimal("10"))
    ledger.debit(user, 1, action="comment_vote")
    Config.objects.update(heal_enabled=False)
    old_pod_writes(user, "-3")
    assert ledger.debit(user, 1, action="comment_vote") == Decimal("5")
    assert account_balance(user) == 8000, "no heal: the ledger did not see the old write"
    assert journal(code="legacy_adjustment") == []
    assert invariants.r2_tuzis_projection_equals_balance() == [(f"user:{user.pk}", 5000, 8000)]
    assert invariants.r1_maintained_balance_equals_journal() == []


def test_the_wrapper_can_be_called_inside_a_callers_transaction_holding_the_lock(creator_factory):
    """Every view takes lock_in_order first (§6); the SQL function re-takes
    the same lock and must not deadlock with itself."""
    user = creator_factory(tuzis=Decimal("4"))
    with transaction.atomic():
        ledger.lock_in_order(user)
        ledger.debit(user, 1, action="page_vote")
        grant(user, 2)
    assert balance(user) == Decimal("5")
    assert_r123()
