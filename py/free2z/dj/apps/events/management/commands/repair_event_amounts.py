"""Reconcile historical integer-truncated event amounts with authoritative receipts.

The command only derives a replacement where an independent receipt establishes
the precise amount. Event types without sufficient evidence are reported as
unverifiable. Applying repairs requires the documented command options and
operational preconditions; a website deployment alone does not stop separately
scheduled financial writers.
"""
import argparse
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
from django.db.models import Count
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from dj.apps.events.models import EVENT_TEMPLATES, Event
from dj.apps.tuzis.models import ZecCreditReceipt
from dj.apps.ztripe.models import StripeTransaction

DECIMAL_MIGRATION = ("events", "0014_event_amount_decimal")
DEFAULT_WINDOW_SECONDS = 5
# How far BEFORE a candidate event another purchase by the same creator may
# sit and still be considered its possible owner (its event insert waited on
# the creator row lock that long). See "unique from both sides" above.
DEFAULT_COMPETITOR_LOOKBACK_HOURS = 24
# What tuzis/zec.py clamped the notification to while the column was int32
# (found by codex on 's review): min(int(tuzis), LEGACY_INT32_MAX).
LEGACY_INT32_MAX = 2_147_483_647


def truncated_by_integer_column(value: Decimal) -> Decimal:
    """What the old ``IntegerField`` stored for ``value``.

    Django's ``IntegerField.get_prep_value`` is ``int(value)``, which for a
    Decimal truncates toward zero -- not ``floor``, not rounding. On top of
    that the ZEC writer clamped to int32 so a whale purchase would not fail
    the credit; both losses are modelled, because both are recoverable from
    the receipt.
    """
    return Decimal(min(int(value), LEGACY_INT32_MAX))


def parse_cutoff(raw: str):
    """A timezone-aware ISO-8601 instant, or an error that says why.

    This runs as an argparse ``type=`` callable, and argparse converts only
    ``ArgumentTypeError`` / ``ValueError`` / ``TypeError`` into its own usage
    error; ``run_from_argv`` parses *outside* its ``CommandError`` handler,
    so a ``CommandError`` raised here reached the terminal as a full
    traceback. ``ArgumentTypeError`` is a one-line usage error on the CLI and
    a ``CommandError`` under ``call_command``.
    """
    value = parse_datetime(raw)
    if value is None:
        raise argparse.ArgumentTypeError(
            f"{raw!r} is not an ISO-8601 datetime "
            "(e.g. 2026-09-08T12:00:00+00:00)")
    if timezone.is_naive(value):
        raise argparse.ArgumentTypeError(
            f"{raw!r} has no UTC offset; a naive time is ambiguous "
            "for a boundary that decides which rows may be rewritten")
    return value


@dataclass(frozen=True)
class Repair:
    event: Event
    stored: Decimal
    authoritative: Decimal
    receipt: ZecCreditReceipt


@dataclass
class Plan:
    cutoff: object
    receipts_examined: int = 0
    receipts_integral: int = 0
    already_exact: int = 0
    unmatched: list = field(default_factory=list)
    ambiguous: list = field(default_factory=list)
    repairs: list = field(default_factory=list)


def widening_cutoff():
    """When ``events.0014`` was applied: rows after it are exact by construction."""
    app, name = DECIMAL_MIGRATION
    row = (
        MigrationRecorder(connection)
        .migration_qs.filter(app=app, name=name)
        .first()
    )
    if row is None:
        raise CommandError(
            f"migration {app}.{name} is not applied on this database; "
            "there is nothing to repair yet (run `manage.py migrate` first)."
        )
    return row.applied


def competing_purchases(receipt, event, window, lookback):
    """Why some OTHER purchase by the same creator could own ``event``.

    Returns the reasons (empty means the association is unique from the
    event's side). Looks ``lookback`` before the event and ``window`` after
    it: a purchase's receipt always precedes its event, by however long its
    ``ledger.credit`` waited for the creator row lock, so a symmetric
    ``event ± window`` missed the true owner whenever that wait exceeded
    the window (codex round 3). Two writers emit ``BOUGHT_TUZI`` rows that
    look the same:

    * another ``ZecCreditReceipt`` -- whole-number ones count: a whole 36
      purchase and a delayed 36.900 receipt both map to a stored 36, and the
      delayed one must not take the whole one's row. ``tuzis_credited`` is
      required (backfilled receipts carry none and are not evidence);
    * a card purchase (``ztripe/fulfillment.py``): a ``StripeTransaction``
      for the same creator inside the window crediting exactly the stored
      amount. Card credits are whole and were stored exactly, so a delayed
      1000.900 receipt next to a 1000 card purchase must not rewrite the
      card's -- correct -- row (found by the codex round-2 review).
    """
    low, high = event.created_at - lookback, event.created_at + window
    reasons = []
    others = ZecCreditReceipt.objects.filter(
        creator_id=receipt.creator_id,
        tuzis_credited__isnull=False,
        created_at__gte=low,
        created_at__lte=high,
    ).exclude(pk=receipt.pk)
    if any(truncated_by_integer_column(other.tuzis_credited) == event.amount
           for other in others):
        reasons.append("another receipt in the window could own it")
    # ``event.amount`` is the truncated (integral) value here by
    # construction; ``tuzis_credited`` is a PositiveIntegerField.
    if StripeTransaction.objects.filter(
        user_id=receipt.creator_id,
        tuzis_credited=int(event.amount),
        timestamp__gte=low,
        timestamp__lte=high,
    ).exists():
        reasons.append(
            "a card purchase (StripeTransaction) in the window could own it")
    return reasons


def build_plan(window: timedelta, cutoff=None,
               lookback: timedelta = timedelta(
                   hours=DEFAULT_COMPETITOR_LOOKBACK_HOURS)) -> Plan:
    applied = widening_cutoff()
    if cutoff is None:
        cutoff = applied
    elif cutoff < applied:
        raise CommandError(
            f"--cutoff {cutoff.isoformat()} is before the widening migration "
            f"was applied ({applied.isoformat()}); it can only move forward")
    plan = Plan(cutoff=cutoff)
    receipts = (
        ZecCreditReceipt.objects
        .filter(
            tuzis_credited__isnull=False,
            creator__isnull=False,
            backfilled=False,
            created_at__lt=plan.cutoff,
        )
        .select_related("creator")
        .order_by("created_at", "pk")
    )
    for receipt in receipts.iterator():
        plan.receipts_examined += 1
        exact = receipt.tuzis_credited
        truncated = truncated_by_integer_column(exact)
        if exact == truncated:
            plan.receipts_integral += 1
            continue
        candidates = list(
            Event.objects.filter(
                type="BOUGHT_TUZI",
                receiving_user_id=receipt.creator_id,
                created_at__gte=receipt.created_at - window,
                created_at__lte=receipt.created_at + window,
                created_at__lt=plan.cutoff,
            ).order_by("created_at", "pk")
        )
        exact_matches = [event for event in candidates if event.amount == exact]
        matches = [event for event in candidates if event.amount == truncated]
        if exact_matches and matches:
            # Writer-transition shape: which purchase the exact row belongs
            # to is unproven, and "already exact" would hide the truncated
            # row forever (found by the codex round-2 review).
            plan.ambiguous.append((
                receipt, exact_matches + matches,
                "an exact-amount event shares the window with a truncated "
                "one, so which purchase is already repaired is unproven"))
            continue
        if exact_matches:
            plan.already_exact += 1
            continue
        if not matches:
            plan.unmatched.append(receipt)
            continue
        if len(matches) > 1:
            plan.ambiguous.append((
                receipt, matches, "more than one truncated candidate event"))
            continue
        event = matches[0]
        reasons = competing_purchases(receipt, event, window, lookback)
        if reasons:
            plan.ambiguous.append((receipt, matches, "; ".join(reasons)))
            continue
        plan.repairs.append(Repair(
            event=event,
            stored=event.amount,
            authoritative=exact,
            receipt=receipt,
        ))
    return plan


def not_derivable_counts(cutoff):
    """Pre-widening rows per type. Whole at the column level; unknowable beyond."""
    rows = (
        Event.objects
        .filter(created_at__lt=cutoff, amount__isnull=False)
        .values("type")
        .annotate(n=Count("id"))
    )
    counts = {row["type"]: row["n"] for row in rows}
    return [(t, counts.get(t, 0)) for t in EVENT_TEMPLATES]


def _receipt_label(receipt: ZecCreditReceipt) -> str:
    return f"{receipt.txid}:{receipt.pool or '-'}:{receipt.output_index}"


class Command(BaseCommand):
    help = (
        "Reconcile Event.amount rows truncated by the old integer column "
        "(#1603). Dry run by default; --apply writes, atomically."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply", action="store_true",
            help="Write the repairs. Without it, print the plan and change "
                 "nothing.",
        )
        parser.add_argument(
            "--cutoff", type=parse_cutoff, default=None,
            help="ISO-8601 instant (with offset) after which every writer is "
                 "known to run the widened code. Defaults to when "
                 "events.0014 was applied, which is only a LOWER bound: the "
                 "separate payment-host credit loop deploys separately. Can only move "
                 "forward.",
        )
        parser.add_argument(
            "--competitor-lookback-hours", type=float,
            default=DEFAULT_COMPETITOR_LOOKBACK_HOURS,
            help="How far BEFORE a candidate event another purchase by the "
                 "same creator may sit and still be treated as its possible "
                 "owner (a receipt precedes its event by however long the "
                 "credit waited on the creator row lock). Must be >= "
                 f"--window-seconds (default {DEFAULT_COMPETITOR_LOOKBACK_HOURS}).",
        )
        parser.add_argument(
            "--window-seconds", type=float, default=DEFAULT_WINDOW_SECONDS,
            help="How far apart a receipt and its BOUGHT_TUZI event may be "
                 "and still count as the same transaction "
                 f"(default {DEFAULT_WINDOW_SECONDS}).",
        )

    def handle(self, *args, **options):
        apply_changes = options["apply"]
        if options["window_seconds"] <= 0:
            raise CommandError("--window-seconds must be > 0")
        window = timedelta(seconds=options["window_seconds"])
        lookback = timedelta(hours=options["competitor_lookback_hours"])
        if lookback < window:
            raise CommandError(
                "--competitor-lookback-hours must cover --window-seconds")
        out = self.stdout.write

        out("repair_event_amounts: "
            + ("APPLY -- writing" if apply_changes
               else "DRY RUN -- nothing will be written (pass --apply)"))
        plan = build_plan(window, options["cutoff"], lookback)
        if options["cutoff"] is None:
            out(f"cutoff: {plan.cutoff.isoformat()} "
                f"(when {'.'.join(DECIMAL_MIGRATION)} was applied). Rows "
                "after it are outside the claim. This is a LOWER bound on "
                "when truncating writers stopped: the separate payment-host credit loop is "
                "deployed by hand -- once it is confirmed on the new code, "
                "re-run with --cutoff <that time>.")
        else:
            out(f"cutoff: {plan.cutoff.isoformat()} (--cutoff). Rows after "
                "it are outside the claim.")
        out("")
        out("ZEC purchases -- BOUGHT_TUZI reconciled against "
            "tuzis.ZecCreditReceipt.tuzis_credited (same transaction, "
            f"window {options['window_seconds']:g}s, competitor lookback "
            f"{options['competitor_lookback_hours']:g}h):")
        out(f"  receipts examined:                     {plan.receipts_examined}")
        out(f"  old column kept it exactly:            {plan.receipts_integral}")
        out(f"  already exact:                         {plan.already_exact}")
        out(f"  REPAIRABLE (one truncated match):      {len(plan.repairs)}")
        out(f"  ambiguous (either side, skipped):      {len(plan.ambiguous)}")
        out(f"  no truncated event in window:          {len(plan.unmatched)}")
        for repair in plan.repairs:
            out(f"  REPAIR event={repair.event.pk} "
                f"user={repair.event.receiving_user_id} "
                f"created={repair.event.created_at.isoformat()} "
                f"amount {repair.stored} -> {repair.authoritative} "
                f"(receipt {_receipt_label(repair.receipt)})")
        for receipt, matches, why in plan.ambiguous:
            ids = ", ".join(str(event.pk) for event in matches)
            out(f"  AMBIGUOUS receipt {_receipt_label(receipt)} "
                f"tuzis_credited={receipt.tuzis_credited}: "
                f"{len(matches)} candidate event(s) [{ids}]; {why} "
                "-- skipped")
        for receipt in plan.unmatched:
            out(f"  UNMATCHED receipt {_receipt_label(receipt)} "
                f"tuzis_credited={receipt.tuzis_credited}: no BOUGHT_TUZI "
                "event with the truncated amount in the window (see "
                "`audit_zec_credits` for events that never existed)")
        out("")
        out("Not derivable -- the ledger keeps no per-movement record "
            "(ledger.transfer/debit/credit mutate Creator.tuzis in place), "
            "so a truncated fraction on these paths is unrecoverable. "
            "Pre-cutoff rows with an amount, per type; whole at the column "
            "level, error bounded below 1 2Z ($0.01) per row. Recorded so a "
            "reconciliation reads this as historical, not as a live leak:")
        for event_type, count in not_derivable_counts(plan.cutoff):
            note = ""
            if event_type == "BOUGHT_TUZI":
                note = "  (ZEC-path rows are reconciled above; card purchases are whole by construction)"
            elif event_type.startswith("PAY_PER_VIEW_"):
                note = ("  (no link to the CreatorMeeting and the price at "
                        "purchase time is not stored, so a fractional "
                        "price_per_minute today identifies no row)")
            out(f"  {event_type:<24}{count:>8}{note}")
        out("")

        if not plan.repairs:
            out("Nothing to repair.")
            return
        if not apply_changes:
            out(f"Would change {len(plan.repairs)} row(s). Nothing written.")
            return

        with transaction.atomic():
            for repair in plan.repairs:
                changed = Event.objects.filter(
                    pk=repair.event.pk, amount=repair.stored,
                ).update(amount=repair.authoritative)
                if changed != 1:
                    raise CommandError(
                        f"event {repair.event.pk} no longer holds "
                        f"{repair.stored}; it moved after the plan was made. "
                        "Nothing written -- re-run."
                    )
        out(f"Changed {len(plan.repairs)} row(s).")
