"""Crediting a ZEC note BEFORE it reaches the confirmation floor.

The product problem this is about is silence, not money. PR  gave the
credit path a three-block confirmation floor, which at Zcash's 75-second
target is roughly four minutes -- four minutes during which a buyer who has
just sent real ZEC into a shielded address is told **nothing at all**. From
where they sit that is indistinguishable from having lost it.

Two answers, and they carry completely different risk:

* **Always announce a held note.** Moves no 2Z, assumes nothing about the
  chain, and cannot lose money. The only way to get it wrong is to send it
  more than once -- and the loop re-reads every held note every ~90 seconds,
  so "more than once" is the DEFAULT unless something stops it.
* **Credit small ones immediately.** This does move money, on the strength of
  a transaction that is not yet buried. Off unless somebody sets two caps.

Everything here is a money test, so every assertion below is one that goes
red when its production line is removed -- the controls are recorded in the
PR. The database is real Postgres (project rule); the daily-aggregate window
and the advisory lock are database behaviour and cannot be mocked.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.events.models import EVENT_TEMPLATES, Event
from dj.apps.tuzis import zec
from dj.apps.tuzis.models import ZecCreditReceipt, ZecPendingNotice

RATE = Decimal("90000.0000")
ZATS = 100_000_000


def _credit_instantly(creator, *, zats, policy, txid, now=None,
                      output_index=0, pool="orchard"):
    return zec.credit_zec_purchase_instantly(
        amount_zat=zats,
        policy=policy,
        now=now,
        creator=creator,
        txid=txid,
        output_index=output_index,
        pool=pool,
        amount_zec=Decimal(zats) / Decimal(ZATS),
        tuzis_per_zec=RATE,
        confirmations=0,
    )


# --------------------------------------------------------------------------
# The switch. Default OFF, and every wrong value lands on OFF too.
# --------------------------------------------------------------------------

def test_instant_credit_is_off_by_default(monkeypatch):
    """Merging this changes nothing until somebody turns it on."""
    monkeypatch.delenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, raising=False)
    monkeypatch.delenv(zec.INSTANT_CREDIT_DAILY_ZATOSHI_ENV, raising=False)
    policy = zec.instant_credit_policy(log=lambda _m: None)
    assert policy.per_note_zat == 0
    assert policy.daily_zat == 0
    assert not policy.enabled


def test_a_per_note_cap_with_no_daily_cap_does_not_enable_anything(monkeypatch):
    """A per-note cap alone is the same trick 960 times a day.

    The credit loop runs every 90 seconds. A 0.05 ZEC per-note cap with no
    daily cap is not a small blast radius -- it is a 48 ZEC/day blast radius
    with a small-sounding number on it.
    """
    monkeypatch.setenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, "5000000")
    monkeypatch.delenv(zec.INSTANT_CREDIT_DAILY_ZATOSHI_ENV, raising=False)
    assert not zec.instant_credit_policy(log=lambda _m: None).enabled


def test_a_daily_cap_with_no_per_note_cap_does_not_enable_anything(monkeypatch):
    monkeypatch.delenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, raising=False)
    monkeypatch.setenv(zec.INSTANT_CREDIT_DAILY_ZATOSHI_ENV, "50000000")
    assert not zec.instant_credit_policy(log=lambda _m: None).enabled


@pytest.mark.parametrize("value", ["0.05", "five", "5_000_000 zats", ""])
def test_an_unparseable_cap_disables_rather_than_guessing(monkeypatch, value):
    """`0.05` is the ZEC-shaped typo, and it must not become "0.05 zatoshi".

    Note the direction is the OPPOSITE of ZEC_MIN_CONFIRMATIONS, which falls
    back to its default. There, the default is the safe value; here, the safe
    value is off.
    """
    monkeypatch.setenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, value)
    monkeypatch.setenv(zec.INSTANT_CREDIT_DAILY_ZATOSHI_ENV, "50000000")
    assert not zec.instant_credit_policy(log=lambda _m: None).enabled


def test_a_negative_cap_is_refused(monkeypatch):
    monkeypatch.setenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, "-1")
    monkeypatch.setenv(zec.INSTANT_CREDIT_DAILY_ZATOSHI_ENV, "50000000")
    assert not zec.instant_credit_policy(log=lambda _m: None).enabled


def test_a_cap_above_one_zec_is_refused_and_says_why(monkeypatch):
    """The factor-1000 fat-finger: 0.5 ZEC typed as 50000000000.

    Refusing outright rather than clamping is the point. Clamping to a
    maximum nobody chose is how the confirmation floor came to be zero.
    """
    lines = []
    monkeypatch.setenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, "50000000000")
    monkeypatch.setenv(zec.INSTANT_CREDIT_DAILY_ZATOSHI_ENV, "50000000")
    assert not zec.instant_credit_policy(log=lines.append).enabled
    assert any("ZATOSHI, not ZEC" in line for line in lines), lines


def test_the_caps_are_read_per_call_not_at_import(monkeypatch):
    """The loop is a long-lived unit; a cap change must not need a deploy."""
    monkeypatch.setenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, "5000000")
    monkeypatch.setenv(zec.INSTANT_CREDIT_DAILY_ZATOSHI_ENV, "50000000")
    assert zec.instant_credit_policy(log=lambda _m: None).enabled
    monkeypatch.setenv(zec.INSTANT_CREDIT_ZATOSHI_ENV, "0")
    assert not zec.instant_credit_policy(log=lambda _m: None).enabled


# --------------------------------------------------------------------------
# Zatoshi, not floats. The boundary is the only case that matters and it is
# the one a float rounds.
# --------------------------------------------------------------------------

def test_note_zatoshi_prefers_the_backends_own_integer():
    assert zec.note_zatoshi({"amountZat": 4999999}, Decimal("0.05")) == 4999999


def test_note_zatoshi_is_exact_without_one():
    """A backend with no `amountZat` must still land on the exact integer."""
    assert zec.note_zatoshi({}, Decimal("0.04999999")) == 4_999_999
    assert zec.note_zatoshi({}, Decimal("0.05000000")) == 5_000_000
    # The classic float trap: 0.1 + 0.2 as a float is 0.30000000000000004.
    assert zec.note_zatoshi({}, Decimal("0.30000000")) == 30_000_000


def test_note_zatoshi_ignores_an_unusable_backend_integer():
    assert zec.note_zatoshi({"amountZat": "nope"}, Decimal("0.05")) == 5_000_000


# --------------------------------------------------------------------------
# The per-note cap, at the boundary, in both directions.
# --------------------------------------------------------------------------

@pytest.mark.django_db
@pytest.mark.parametrize("delta,credited", [(-1, True), (0, False), (1, False)])
def test_the_per_note_cap_holds_at_the_boundary(
        creator_factory, delta, credited):
    """cap-1 credits, cap does not, cap+1 does not.

    The convention is stated once and pinned here: the per-note cap is the
    first amount that is TOO BIG to trust, so the comparison is strict.
    """
    cap = 5_000_000
    policy = zec.InstantCreditPolicy(per_note_zat=cap, daily_zat=50_000_000)
    buyer = creator_factory(username="edge", tuzis=Decimal("0"))

    if credited:
        receipt = _credit_instantly(
            buyer, zats=cap + delta, policy=policy, txid="a1" * 32)
        assert receipt.instant is True
        buyer.refresh_from_db(fields=["tuzis"])
        assert buyer.tuzis > Decimal("0")
    else:
        with pytest.raises(zec.InstantCreditRefused):
            _credit_instantly(
                buyer, zats=cap + delta, policy=policy, txid="a1" * 32)
        buyer.refresh_from_db(fields=["tuzis"])
        assert buyer.tuzis == Decimal("0")
        assert ZecCreditReceipt.objects.count() == 0


@pytest.mark.django_db
def test_a_refused_note_writes_absolutely_nothing(creator_factory):
    """A refusal is not a partial credit. No receipt, no event, no balance."""
    policy = zec.InstantCreditPolicy(per_note_zat=1_000, daily_zat=50_000_000)
    buyer = creator_factory(username="toobig", tuzis=Decimal("0"))
    with pytest.raises(zec.InstantCreditRefused):
        _credit_instantly(buyer, zats=9_999_999, policy=policy,
                          txid="a2" * 32)
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0")
    assert ZecCreditReceipt.objects.count() == 0
    assert Event.objects.count() == 0


# --------------------------------------------------------------------------
# The daily aggregate cap -- the thing that stops a repeat.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_daily_aggregate_cap_holds_at_the_boundary(creator_factory):
    """Three notes fit exactly; the fourth zatoshi over the line does not.

    Without this, a per-note cap is a rate, not a limit: the loop runs 960
    times a day and an attacker who can win one race can win the next one.
    """
    policy = zec.InstantCreditPolicy(
        per_note_zat=5_000_000, daily_zat=9_000_000)
    buyer = creator_factory(username="repeat", tuzis=Decimal("0"))

    _credit_instantly(buyer, zats=4_500_000, policy=policy, txid="b1" * 32)
    _credit_instantly(buyer, zats=4_500_000, policy=policy, txid="b2" * 32)
    assert zec.daily_instant_zatoshi() == 9_000_000

    # Exactly at the cap is spent; one more zatoshi is over it.
    with pytest.raises(zec.InstantCreditRefused) as refused:
        _credit_instantly(buyer, zats=1, policy=policy, txid="b3" * 32)
    assert "daily cap" in refused.value.reason
    assert ZecCreditReceipt.objects.count() == 2


@pytest.mark.django_db
def test_the_daily_cap_admits_a_note_that_lands_exactly_on_it(
        creator_factory):
    """The daily cap IS spendable -- it is a budget, not a fence.

    Deliberately the opposite convention to the per-note cap, and the reason
    is that they answer different questions: "is this note too big to trust?"
    versus "how much may leave on trust in a day?".
    """
    policy = zec.InstantCreditPolicy(
        per_note_zat=5_000_000, daily_zat=9_000_000)
    buyer = creator_factory(username="exact", tuzis=Decimal("0"))
    _credit_instantly(buyer, zats=4_500_000, policy=policy, txid="b4" * 32)
    receipt = _credit_instantly(
        buyer, zats=4_500_000, policy=policy, txid="b5" * 32)
    assert receipt.instant is True


@pytest.mark.django_db
def test_the_daily_window_rolls_rather_than_resetting_at_midnight(
        creator_factory):
    """A calendar day hands an attacker two budgets a few minutes apart."""
    policy = zec.InstantCreditPolicy(
        per_note_zat=5_000_000, daily_zat=5_000_000)
    buyer = creator_factory(username="rolling", tuzis=Decimal("0"))

    old = _credit_instantly(
        buyer, zats=4_000_000, policy=policy, txid="c1" * 32)
    ZecCreditReceipt.objects.filter(pk=old.pk).update(
        created_at=timezone.now() - timedelta(hours=25))

    # 25 hours later it is out of the window and the budget is free again.
    assert zec.daily_instant_zatoshi() == 0
    assert _credit_instantly(
        buyer, zats=4_000_000, policy=policy, txid="c2" * 32).instant

    #...but 23 hours is still inside it.
    ZecCreditReceipt.objects.filter(txid="c2" * 32).update(
        created_at=timezone.now() - timedelta(hours=23))
    assert zec.daily_instant_zatoshi() == 4_000_000
    with pytest.raises(zec.InstantCreditRefused):
        _credit_instantly(buyer, zats=4_000_000, policy=policy,
                          txid="c3" * 32)


@pytest.mark.django_db
def test_a_confirmed_credit_does_not_consume_the_instant_budget(
        creator_factory):
    """Only credits taken ON TRUST count against the daily trust budget.

    Getting this wrong would make a busy, entirely legitimate day of
    confirmed purchases silently switch instant crediting off.
    """
    buyer = creator_factory(username="normal", tuzis=Decimal("0"))
    zec.credit_zec_purchase(
        creator=buyer, txid="d1" * 32, output_index=0, pool="orchard",
        amount_zec=Decimal("9.00000000"), tuzis_per_zec=RATE,
        confirmations=6,
    )
    assert zec.daily_instant_zatoshi() == 0


# --------------------------------------------------------------------------
# The circuit breaker. The half of the reorg response that is automatic.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_an_unbacked_credit_halts_instant_crediting_platform_wide(
        creator_factory):
    """One successful attack, not one per 90-second cycle.

    This is the entire reason auto-reversal is not needed: the bound on what
    an attacker collects does not depend on anybody being awake.
    """
    policy = zec.InstantCreditPolicy(
        per_note_zat=5_000_000, daily_zat=50_000_000)
    attacker = creator_factory(username="finney", tuzis=Decimal("0"))
    victimless = creator_factory(username="innocent", tuzis=Decimal("0"))

    first = _credit_instantly(
        attacker, zats=4_000_000, policy=policy, txid="e1" * 32)
    first.vanished_at = timezone.now()
    first.save(update_fields=["vanished_at"])

    with pytest.raises(zec.InstantCreditRefused) as refused:
        _credit_instantly(victimless, zats=1_000, policy=policy,
                          txid="e2" * 32)
    assert "halted" in refused.value.reason

    # A human decides, and only then does it resume.
    ZecCreditReceipt.objects.filter(pk=first.pk).update(
        vanish_resolved_at=timezone.now())
    assert _credit_instantly(
        victimless, zats=1_000, policy=policy, txid="e3" * 32).instant


@pytest.mark.django_db
def test_the_halt_does_not_touch_the_normal_confirmed_path(creator_factory):
    """Refusing to take NEW risk must not stop crediting real payments.

    A brake that also stops the ordinary confirmed credit path would convert
    one unbacked credit into a platform-wide crediting outage -- which is the
    ~11-month gap, self-inflicted.
    """
    buyer = creator_factory(username="unaffected", tuzis=Decimal("0"))
    stuck = _credit_instantly(
        buyer, zats=1_000,
        policy=zec.InstantCreditPolicy(per_note_zat=5_000, daily_zat=50_000),
        txid="f1" * 32)
    ZecCreditReceipt.objects.filter(pk=stuck.pk).update(
        vanished_at=timezone.now())

    receipt = zec.credit_zec_purchase(
        creator=buyer, txid="f2" * 32, output_index=0, pool="orchard",
        amount_zec=Decimal("1.00000000"), tuzis_per_zec=RATE,
        confirmations=6,
    )
    assert receipt.tuzis_credited == Decimal("90000.000")


# --------------------------------------------------------------------------
# Reorg / vanish detection.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_a_note_that_reaches_the_floor_comes_off_the_watch_list(
        creator_factory):
    buyer = creator_factory(username="matured", tuzis=Decimal("0"))
    receipt = _credit_instantly(
        buyer, zats=1_000,
        policy=zec.InstantCreditPolicy(per_note_zat=5_000, daily_zat=50_000),
        txid="11" * 32)

    settled, vanished, unverifiable = zec.watch_instant_credits(
        confirmed_keys={("11" * 32, "orchard", 0)}, pending_keys=set())
    assert [r.pk for r in settled] == [receipt.pk]
    assert vanished == [] and unverifiable == []

    receipt.refresh_from_db()
    assert receipt.settled_at is not None
    # And it is not re-examined forever afterwards.
    assert zec.watch_instant_credits(
        confirmed_keys=set(), pending_keys={("x", "y", 0)}) == ([], [], [])


@pytest.mark.django_db
def test_a_still_young_note_is_neither_settled_nor_accused(creator_factory):
    buyer = creator_factory(username="young", tuzis=Decimal("0"))
    _credit_instantly(
        buyer, zats=1_000,
        policy=zec.InstantCreditPolicy(per_note_zat=5_000, daily_zat=50_000),
        txid="12" * 32)
    settled, vanished, unverifiable = zec.watch_instant_credits(
        confirmed_keys=set(), pending_keys={("12" * 32, "orchard", 0)})
    assert (settled, vanished, unverifiable) == ([], [], [])


@pytest.mark.django_db
def test_a_note_in_neither_set_is_marked_vanished(creator_factory):
    """2Z issued, ZEC gone. The incident this whole feature has to survive."""
    buyer = creator_factory(username="doublespender", tuzis=Decimal("0"))
    receipt = _credit_instantly(
        buyer, zats=1_000,
        policy=zec.InstantCreditPolicy(per_note_zat=5_000, daily_zat=50_000),
        txid="13" * 32)

    settled, vanished, unverifiable = zec.watch_instant_credits(
        confirmed_keys={("aa" * 32, "orchard", 0)}, pending_keys=set())
    assert [r.pk for r in vanished] == [receipt.pk]
    assert settled == [] and unverifiable == []

    receipt.refresh_from_db()
    assert receipt.vanished_at is not None
    assert receipt.vanish_resolved_at is None
    # NOTHING IS AUTO-REVERSED. The balance is untouched on purpose.
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0.900")


@pytest.mark.django_db
def test_an_empty_wallet_read_accuses_nobody_but_is_still_reported(
        creator_factory):
    """A restored or resyncing wallet is not N simultaneous double-spends.

    Marking every outstanding credit vanished here would be the single most
    damaging thing this code could do, and the trigger is an ordinary ops
    event. It still has to page -- "we cannot tell whether our credits are
    backed" is not a quiet state.
    """
    buyer = creator_factory(username="resync", tuzis=Decimal("0"))
    receipt = _credit_instantly(
        buyer, zats=1_000,
        policy=zec.InstantCreditPolicy(per_note_zat=5_000, daily_zat=50_000),
        txid="14" * 32)

    settled, vanished, unverifiable = zec.watch_instant_credits(
        confirmed_keys=set(), pending_keys=set())
    assert vanished == [] and settled == []
    assert [r.pk for r in unverifiable] == [receipt.pk]
    receipt.refresh_from_db()
    assert receipt.vanished_at is None


@pytest.mark.django_db
def test_a_confirmed_credit_is_never_on_the_watch_list(creator_factory):
    """Only credits taken on trust are at risk, so only they are watched."""
    buyer = creator_factory(username="deep", tuzis=Decimal("0"))
    zec.credit_zec_purchase(
        creator=buyer, txid="15" * 32, output_index=0, pool="orchard",
        amount_zec=Decimal("1.00000000"), tuzis_per_zec=RATE,
        confirmations=6,
    )
    assert zec.watch_instant_credits(
        confirmed_keys=set(), pending_keys=set()) == ([], [], [])


# --------------------------------------------------------------------------
# The notification. Idempotent, or it is spam.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_buyer_is_told_once_and_only_once(creator_factory):
    """The loop re-reads the same held note every ~90 seconds.

    `events.Event` has NO uniqueness constraint of any kind, so without the
    `ZecPendingNotice` row this sends one notification per cycle for as long
    as the note is young -- three for a normal purchase and dozens if the
    chain is slow.
    """
    buyer = creator_factory(username="patient", tuzis=Decimal("0"))
    kwargs = dict(
        creator=buyer, txid="21" * 32, output_index=0, pool="orchard",
        amount_zec=Decimal("0.05000000"), confirmations=1,
        tuzis_per_zec=RATE,
    )
    assert zec.notify_pending_note(**kwargs) is not None
    for _ in range(9):
        assert zec.notify_pending_note(**kwargs) is None

    assert ZecPendingNotice.objects.count() == 1
    assert Event.objects.filter(type="ZEC_PENDING").count() == 1
    # And it moved no money.
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == Decimal("0")


@pytest.mark.django_db
def test_two_notes_of_one_transaction_are_announced_separately(
        creator_factory):
    """The notice key is the NOTE, not the transaction -- same as the receipt.

    Keying on the txid alone would silently swallow the announcement for the
    second output, which is the shape of (b).
    """
    buyer = creator_factory(username="multi", tuzis=Decimal("0"))
    base = dict(creator=buyer, txid="22" * 32, amount_zec=Decimal("0.01"),
                tuzis_per_zec=RATE)
    assert zec.notify_pending_note(output_index=0, pool="sapling", **base)
    assert zec.notify_pending_note(output_index=1, pool="sapling", **base)
    assert zec.notify_pending_note(output_index=0, pool="orchard", **base)
    assert Event.objects.filter(type="ZEC_PENDING").count() == 3


@pytest.mark.django_db
def test_the_notice_and_the_event_cannot_come_apart(creator_factory, mocker):
    """A notice row claiming a notification that was never written.

    They are created in one transaction, so a failure to write the Event
    must roll the notice back -- otherwise the unique constraint permanently
    blocks the buyer from ever being told.
    """
    buyer = creator_factory(username="atomic", tuzis=Decimal("0"))
    mocker.patch(
        "dj.apps.events.dispatch.create_durable_event",
        side_effect=RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        zec.notify_pending_note(
            creator=buyer, txid="23" * 32, output_index=0, pool="orchard",
            amount_zec=Decimal("0.01"), tuzis_per_zec=RATE)
    assert ZecPendingNotice.objects.count() == 0


@pytest.mark.django_db
def test_the_pending_event_renders_instead_of_500ing_the_feed(
        creator_factory):
    """`Event.message()` is an UNGUARDED dict lookup on `type`.

    A type with no `EVENT_TEMPLATES` entry does not degrade -- it raises
    KeyError inside `EventSerializer`, which 500s the whole `/api/events/`
    page for that user AND the `push_events` websocket worker. The frontend
    copes with an unknown type; the backend does not.
    """
    assert "ZEC_PENDING" in EVENT_TEMPLATES
    buyer = creator_factory(username="renders", tuzis=Decimal("0"))
    zec.notify_pending_note(
        creator=buyer, txid="24" * 32, output_index=0, pool="orchard",
        amount_zec=Decimal("0.05000000"), tuzis_per_zec=RATE)
    event = Event.objects.get(type="ZEC_PENDING")
    assert "payment was detected" in event.message()
    assert "4500" not in event.message()
    # to_dict() is what the post_save signal serializes for the websocket.
    assert event.to_dict()["type"] == "ZEC_PENDING"


@pytest.mark.django_db
def test_the_announced_amount_is_an_estimate_at_the_current_rate(
        creator_factory):
    buyer = creator_factory(username="estimate", tuzis=Decimal("0"))
    zec.notify_pending_note(
        creator=buyer, txid="25" * 32, output_index=0, pool="orchard",
        amount_zec=Decimal("0.10000000"), tuzis_per_zec=RATE)
    assert Event.objects.get(type="ZEC_PENDING").amount == 9000


@pytest.mark.django_db
def test_a_huge_pending_amount_is_recorded_exactly(creator_factory):
    """`Event.amount` is no longer int32: 9e9 2Z is written verbatim.

    Before the column was widened this amount was clamped to 2_147_483_647;
    a notification that quietly says the wrong number is the bug this guards.
    """
    buyer = creator_factory(username="whale", tuzis=Decimal("0"))
    assert zec.notify_pending_note(
        creator=buyer, txid="26" * 32, output_index=0, pool="orchard",
        amount_zec=Decimal("100000.00000000"), tuzis_per_zec=RATE)
    assert (Event.objects.get(type="ZEC_PENDING").amount
            == Decimal("9000000000.000"))


@pytest.mark.django_db
def test_a_pending_amount_beyond_the_column_does_not_fail_the_notice(
        creator_factory):
    """The clamp survives, at the column's ceiling, not int32's.

    ZEC_PENDING is a projection (rate x amount_zec), not a ledger value, so
    nothing upstream bounds it to what `Creator.tuzis` can hold. A
    notification is never worth failing over: past the column it is clamped,
    and the notice row is still written.
    """
    buyer = creator_factory(username="whale2", tuzis=Decimal("0"))
    assert zec.notify_pending_note(
        creator=buyer, txid="27" * 32, output_index=0, pool="orchard",
        # 9,999,999,999 ZEC * 90,000 2Z/ZEC = 9e14 2Z, past the column's
        # 99,999,999,999,999.999.
        amount_zec=Decimal("9999999999.00000000"), tuzis_per_zec=RATE)
    event = Event.objects.get(type="ZEC_PENDING")
    assert event.amount == zec.EVENT_AMOUNT_MAX
    assert event.amount == Decimal("99999999999999.999")


# --------------------------------------------------------------------------
# Releasing the brake. A halt with no release is an outage waiting to happen.
# --------------------------------------------------------------------------

@pytest.mark.django_db
def test_the_halt_can_be_released_by_a_human_and_moves_no_money(
        creator_factory, capsys):
    """`ZecCreditReceiptAdmin` is read-only, so this is the only release.

    Without it, one unbacked credit switches instant crediting off
    permanently and the only way back is a hand-written UPDATE against prod.
    """
    from django.core.management import call_command

    policy = zec.InstantCreditPolicy(per_note_zat=5_000, daily_zat=50_000)
    buyer = creator_factory(username="halted", tuzis=Decimal("0"))
    receipt = _credit_instantly(
        buyer, zats=1_000, policy=policy, txid="71" * 32)
    ZecCreditReceipt.objects.filter(pk=receipt.pk).update(
        vanished_at=timezone.now())
    balance_before = Decimal(buyer.tuzis)

    # With no argument it reports rather than acts.
    call_command("resolve_unbacked_zec_credit")
    assert "71" * 32 in capsys.readouterr().out
    assert zec.unresolved_unbacked_credits().count() == 1

    call_command("resolve_unbacked_zec_credit", "71" * 32, note="tested")
    out = capsys.readouterr().out
    assert "no 2Z were moved" in out
    assert "will resume" in out
    assert zec.unresolved_unbacked_credits().count() == 0

    # Explicitly: releasing the brake is NOT a reversal.
    buyer.refresh_from_db(fields=["tuzis"])
    assert buyer.tuzis == balance_before
    assert _credit_instantly(
        buyer, zats=1_000, policy=policy, txid="72" * 32).instant


@pytest.mark.django_db
def test_releasing_an_unknown_txid_is_an_error_not_a_silent_no_op(
        creator_factory):
    from django.core.management import call_command
    from django.core.management.base import CommandError

    with pytest.raises(CommandError):
        call_command("resolve_unbacked_zec_credit", "99" * 32)
