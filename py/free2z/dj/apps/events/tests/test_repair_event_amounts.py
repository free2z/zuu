"""``manage.py repair_event_amounts``: dry-run touches nothing,
``--apply`` fixes exactly the rows that are provably derivable, and says
what it cannot derive."""
from datetime import timedelta
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import CommandError, call_command
from django.utils import timezone

from dj.apps.events.management.commands.repair_event_amounts import (
    parse_cutoff,
    truncated_by_integer_column,
)
from dj.apps.events.models import Event
from dj.apps.tuzis.models import ZecCreditReceipt
from dj.apps.ztripe.models import StripeTransaction

RATE = Decimal("90000.0000")
LONG_AGO = timedelta(days=1)


def _run(*args):
    out = StringIO()
    call_command("repair_event_amounts", *args, stdout=out, no_color=True)
    return out.getvalue()


def _backdate(obj, delta=LONG_AGO):
    """Make ``obj`` predate the widening migration, which pytest-django
    applied moments ago when it built the test database."""
    type(obj).objects.filter(pk=obj.pk).update(
        created_at=timezone.now() - delta)
    obj.refresh_from_db()
    return obj


def _receipt(creator, txid, tuzis, **extra):
    return _backdate(ZecCreditReceipt.objects.create(
        txid=txid, output_index=0, pool="orchard", creator=creator,
        amount_zec=Decimal(tuzis) / RATE, tuzis_credited=Decimal(tuzis),
        tuzis_per_zec=RATE, **extra,
    ))


def _card_purchase(creator, tuzis: int):
    """What ztripe/fulfillment.py leaves behind next to its BOUGHT_TUZI."""
    row = StripeTransaction.objects.create(
        user=creator, amount=tuzis * 100, tuzis_credited=tuzis,
        stripe_charge_id=f"pi_{creator.pk}_{tuzis}",
    )
    StripeTransaction.objects.filter(pk=row.pk).update(
        timestamp=timezone.now() - LONG_AGO)
    row.refresh_from_db()
    return row


def _event(creator, amount, type="BOUGHT_TUZI", **extra):
    """What the integer column kept: an old truncated row."""
    return _backdate(Event.objects.create(
        type=type, amount=Decimal(amount), receiving_user=creator,
        payee=creator, **extra,
    ))


def test_truncation_matches_what_the_integer_column_did():
    """``IntegerField.get_prep_value`` is ``int()``: toward zero -- and the
    ZEC writer clamped to int32 on top of that."""
    assert truncated_by_integer_column(Decimal("36.900")) == Decimal("36")
    assert truncated_by_integer_column(Decimal("0.999")) == Decimal("0")
    assert truncated_by_integer_column(Decimal("-3.700")) == Decimal("-3")
    assert (truncated_by_integer_column(Decimal("2700000000.000"))
            == Decimal("2147483647"))
    assert (truncated_by_integer_column(Decimal("2147483647.500"))
            == Decimal("2147483647"))


@pytest.mark.django_db
def test_the_historical_int32_clamp_is_repaired_from_the_receipt(
        creator_factory):
    """A whale purchase's event said 2_147_483_647 for a 2.7e9 credit. That
    is a whole-number receipt, so a model of int() alone would call it
    "nothing to lose"; the clamp is modelled too and the row is recovered."""
    whale = creator_factory()
    _receipt(whale, "b1" * 32, "2700000000.000")
    event = _event(whale, "2147483647")

    out = _run("--apply")

    assert "amount 2147483647.000 -> 2700000000.000" in out
    assert "Changed 1 row(s)." in out
    assert Event.objects.get(pk=event.pk).amount == Decimal("2700000000.000")


@pytest.mark.django_db
def test_a_delayed_receipt_cannot_steal_a_whole_purchases_event(
        creator_factory):
    """Receipt A (36.900) has no event in its window -- its insert was
    delayed. The same creator bought a whole 36 (receipt B, event 36) inside
    A's window. A must not claim B's row: uniqueness is checked from the
    event's side too, and whole receipts count as competitors."""
    buyer = creator_factory()
    delayed = _receipt(buyer, "b2" * 32, "36.900")
    _receipt(buyer, "b3" * 32, "36.000")
    whole_event = _event(buyer, "36")

    out = _run("--apply")

    assert f"AMBIGUOUS receipt {delayed.txid}:orchard:0" in out
    assert "another receipt in the window could own it" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=whole_event.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_a_delayed_receipt_cannot_rewrite_a_card_purchases_event(
        creator_factory):
    """The card path (ztripe/fulfillment.py) writes an indistinguishable
    BOUGHT_TUZI row with no ZecCreditReceipt. A receipt for 1000.900 whose
    own event landed outside the window, next to a card purchase of exactly
    1000, must not "repair" the card's correct row to 1000.900."""
    buyer = creator_factory()
    delayed = _receipt(buyer, "b7" * 32, "1000.900")
    _card_purchase(buyer, 1000)
    card_event = _event(buyer, "1000")

    out = _run("--apply")

    assert f"AMBIGUOUS receipt {delayed.txid}:orchard:0" in out
    assert "a card purchase (StripeTransaction) in the window could own it" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=card_event.pk).amount == Decimal("1000.000")


@pytest.mark.django_db
def test_two_delayed_purchases_cannot_swap_rows_past_the_window(
        creator_factory):
    """The writer inserts the receipt, waits on the creator row lock in
    ledger.credit, then inserts the event -- the delay is unbounded.
    Purchase A: receipt at 0, whole 36, event at 6. Purchase B: receipt at
    5, 36.9, event at 12. B's window finds only A's event, and a competitor
    check of event +/- window (1..11) missed A's receipt at 0 -- so --apply
    rewrote A's correct 36 to 36.9 (codex, round 3). The event-side check
    now looks back --competitor-lookback-hours, so A competes."""
    buyer = creator_factory()
    second = timedelta(seconds=1)
    _backdate(_receipt(buyer, "c1" * 32, "36.000"), LONG_AGO)
    a_event = _backdate(_event(buyer, "36"), LONG_AGO - 6 * second)
    delayed = _backdate(_receipt(buyer, "c2" * 32, "36.900"),
                        LONG_AGO - 5 * second)
    b_event = _backdate(_event(buyer, "36"), LONG_AGO - 12 * second)

    out = _run("--apply")

    assert f"AMBIGUOUS receipt {delayed.txid}:orchard:0" in out
    assert "another receipt in the window could own it" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=a_event.pk).amount == Decimal("36.000")
    assert Event.objects.get(pk=b_event.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_lookback_must_cover_the_window():
    with pytest.raises(CommandError, match="must cover --window-seconds"):
        _run("--window-seconds=7200", "--competitor-lookback-hours=1")


@pytest.mark.django_db
def test_an_exact_event_beside_a_truncated_one_is_not_already_exact(
        creator_factory):
    """Writer transition: two 36.900 purchases by one creator in one window,
    one recorded by the old loop (36) and one by the new (36.900). "Any
    exact candidate means done" would count both receipts as exact and the
    truncated row would never surface on any run; it is reported instead."""
    buyer = creator_factory()
    _receipt(buyer, "b8" * 32, "36.900")
    _receipt(buyer, "b9" * 32, "36.900")
    truncated = _event(buyer, "36")
    _event(buyer, "36.900")

    out = _run("--apply")

    assert "already exact:                         0" in out
    assert out.count("AMBIGUOUS receipt") == 2
    assert "an exact-amount event shares the window with a truncated one" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=truncated.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_two_fractional_receipts_for_one_event_are_ambiguous_both_ways(
        creator_factory):
    buyer = creator_factory()
    _receipt(buyer, "b4" * 32, "36.900")
    _receipt(buyer, "b5" * 32, "36.100")
    event = _event(buyer, "36")

    out = _run("--apply")

    assert out.count("AMBIGUOUS receipt") == 2
    assert Event.objects.get(pk=event.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_cutoff_moves_the_claim_forward_over_the_writer_transition_gap(
        creator_factory):
    """After the migration the the payment host credit loop kept writing truncated
    rows until it was redeployed. Those are outside the default claim and
    inside an explicit --cutoff placed after the redeploy."""
    buyer = creator_factory()
    ZecCreditReceipt.objects.create(
        txid="b6" * 32, output_index=0, pool="orchard", creator=buyer,
        amount_zec=Decimal("0.00041000"), tuzis_credited=Decimal("36.900"),
        tuzis_per_zec=RATE,
    )
    event = Event.objects.create(
        type="BOUGHT_TUZI", amount=Decimal("36"), receiving_user=buyer,
    )
    assert "Nothing to repair." in _run("--apply")
    assert Event.objects.get(pk=event.pk).amount == Decimal("36.000")

    later = (timezone.now() + timedelta(hours=1)).isoformat()
    out = _run("--apply", f"--cutoff={later}")

    assert "(--cutoff)" in out and "Changed 1 row(s)." in out
    assert Event.objects.get(pk=event.pk).amount == Decimal("36.900")


@pytest.mark.django_db
@pytest.mark.parametrize("raw, complaint", [
    ("2026-09-08T12:00:00", "no UTC offset"),
    ("yesterday", "not an ISO-8601"),
    ("2000-01-01T00:00:00+00:00", "before the widening migration"),
])
def test_cutoff_refuses_ambiguous_or_backwards_values(raw, complaint):
    with pytest.raises(CommandError, match=complaint):
        _run(f"--cutoff={raw}")


@pytest.mark.parametrize("raw", ["yesterday", "2026-09-08T12:00:00"])
def test_parse_cutoff_raises_what_argparse_converts(raw):
    """``parse_cutoff`` is an argparse ``type=``. argparse turns only
    ``ArgumentTypeError``/``ValueError``/``TypeError`` into a usage error;
    a ``CommandError`` raised in there escaped ``run_from_argv`` as a full
    traceback on ``manage.py repair_event_amounts --cutoff yesterday``."""
    import argparse

    with pytest.raises(argparse.ArgumentTypeError):
        parse_cutoff(raw)


@pytest.mark.django_db
def test_dry_run_prints_the_repair_and_changes_nothing(creator_factory):
    buyer = creator_factory()
    receipt = _receipt(buyer, "aa" * 32, "36.900")
    event = _event(buyer, "36")
    before = Event.objects.get(pk=event.pk)

    out = _run()

    assert "DRY RUN" in out
    assert f"REPAIR event={event.pk}" in out
    assert "amount 36.000 -> 36.900" in out
    assert f"receipt {receipt.txid}:orchard:0" in out
    assert "Would change 1 row(s). Nothing written." in out
    after = Event.objects.get(pk=event.pk)
    assert after.amount == Decimal("36.000")
    assert after.updated_at == before.updated_at


@pytest.mark.django_db
def test_apply_fixes_the_seeded_truncated_row(creator_factory):
    buyer = creator_factory()
    _receipt(buyer, "ab" * 32, "36.900")
    event = _event(buyer, "36")
    before = Event.objects.get(pk=event.pk)

    out = _run("--apply")

    assert "APPLY" in out and "Changed 1 row(s)." in out
    after = Event.objects.get(pk=event.pk)
    assert after.amount == Decimal("36.900")
    # Not a re-notification: the feed orders by updated_at and post_save is
    # what publishes to pubsub, so the write must go through update().
    assert after.updated_at == before.updated_at
    assert after.created_at == before.created_at

    # Idempotent: a second pass finds the row exact and has nothing to do.
    again = _run("--apply")
    assert "already exact:                         1" in again
    assert "Nothing to repair." in again
    assert Event.objects.get(pk=event.pk).amount == Decimal("36.900")


@pytest.mark.django_db
def test_a_whole_number_receipt_had_nothing_to_lose(creator_factory):
    buyer = creator_factory()
    _receipt(buyer, "ac" * 32, "40.000")
    event = _event(buyer, "40")

    out = _run("--apply")

    assert "old column kept it exactly:            1" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=event.pk).amount == Decimal("40.000")


@pytest.mark.django_db
def test_two_candidate_events_are_ambiguous_and_both_are_left_alone(
        creator_factory):
    buyer = creator_factory()
    receipt = _receipt(buyer, "ad" * 32, "36.900")
    first = _event(buyer, "36")
    second = _event(buyer, "36")

    out = _run("--apply")

    assert f"AMBIGUOUS receipt {receipt.txid}:orchard:0" in out
    assert "2 candidate event(s)" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=first.pk).amount == Decimal("36.000")
    assert Event.objects.get(pk=second.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_an_event_outside_the_window_is_not_matched(creator_factory):
    """A different purchase that happens to have the same whole amount an
    hour earlier is not this receipt's event."""
    buyer = creator_factory()
    receipt = _receipt(buyer, "ae" * 32, "36.900")
    stray = _event(buyer, "36")
    _backdate(stray, LONG_AGO + timedelta(hours=1))

    out = _run("--apply")

    assert f"UNMATCHED receipt {receipt.txid}:orchard:0" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=stray.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_rows_written_after_the_widening_are_never_touched(creator_factory):
    """Post-migration rows are exact by construction. A pair that LOOKS
    truncated but postdates the cutoff is outside the command's claim."""
    buyer = creator_factory()
    ZecCreditReceipt.objects.create(
        txid="af" * 32, output_index=0, pool="orchard", creator=buyer,
        amount_zec=Decimal("0.00041000"), tuzis_credited=Decimal("36.900"),
        tuzis_per_zec=RATE,
    )
    event = Event.objects.create(
        type="BOUGHT_TUZI", amount=Decimal("36"), receiving_user=buyer,
    )

    out = _run("--apply")

    assert "receipts examined:                     0" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=event.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_a_backfilled_receipt_is_not_evidence(creator_factory):
    """``backfilled=True`` rows assert only that the old code saw the note;
    they carry no ``tuzis_credited`` and must not drive a repair."""
    buyer = creator_factory()
    _backdate(ZecCreditReceipt.objects.create(
        txid="b0" * 32, output_index=0, pool="orchard", creator=buyer,
        amount_zec=Decimal("0.00041000"), tuzis_credited=None,
        tuzis_per_zec=None, backfilled=True,
    ))
    event = _event(buyer, "36")

    out = _run("--apply")

    assert "receipts examined:                     0" in out
    assert Event.objects.get(pk=event.pk).amount == Decimal("36.000")


@pytest.mark.django_db
def test_the_non_derivable_population_is_reported_not_guessed(
        creator_factory):
    """A donation's fraction is gone: the ledger kept no per-movement row.
    The command counts those, per type, and does not invent a value."""
    fan = creator_factory()
    star = creator_factory()
    sent = _event(fan, "1", type="DONATION_SENT", contributor=fan)
    _event(star, "1", type="DONATION_RECEIVED", contributor=fan)
    _event(star, "3", type="PAY_PER_VIEW_REVENUE", contributor=fan)

    out = _run("--apply")

    assert "Not derivable" in out
    assert "DONATION_SENT                  1" in out
    assert "DONATION_RECEIVED              1" in out
    assert "PAY_PER_VIEW_REVENUE           1" in out
    assert "PAY_PER_VIEW_SPEND             0" in out
    assert "Nothing to repair." in out
    assert Event.objects.get(pk=sent.pk).amount == Decimal("1.000")
