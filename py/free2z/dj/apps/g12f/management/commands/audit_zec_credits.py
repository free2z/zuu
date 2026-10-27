"""Read-only reconciliation of observed ZEC notes and issued platform credits.

Historical backfilled receipts establish that a note was observed, not that a
credit was issued. The command distinguishes demonstrable discrepancies from
unverifiable historical state and reports evidence rather than inferring a debt
from an absent row alone. Inspect the command options for summary/listing limits.
It never writes balances or authorizes remediation.
"""
import re
from collections import Counter
from datetime import datetime, timezone

from django.core.management.base import BaseCommand
from django.db.models import Count

from dj.apps.events.models import Event
from dj.apps.g12f.models.creator import Creator
from dj.apps.g12f.models.transaction import Transaction
from dj.apps.tuzis.models import ZecCreditReceipt

# The earliest instant at which event-emitting code is KNOWN to have been
# running in production: 2023-07-05T01:38:05Z, the first `BOUGHT_TUZI` row
# there. A purchase credited before this may have had no event to emit, so its
# missing event evidences nothing.
#
# Deliberately NOT the author timestamp of the commit that added the event
# (`328fbc6e9` 2023-07-04 18:10:30 -0700, renamed by `bd0a3b314` at 18:33:03).
# Code cannot emit an event before it is deployed, and the deploy lag is
# unknown, so committing-time would classify anything credited during the
# rollout as datable and then call it a shortfall. The conservative direction
# is LATER, and the first observed event is the tightest bound that is an
# observation rather than a guess. (Found by the codex adversarial review.)
#
# It is a pinned constant, read off production once, NOT `min(Event
#.created_at)` evaluated at run time. A live query would be circular: if the
# events were ever lost, the epoch would slide forward to cover the loss and
# the audit would go quiet about exactly the thing it exists to find.
BOUGHT_TUZI_EPOCH = datetime(2023, 7, 5, 1, 38, 5, tzinfo=timezone.utc)


def schema_backfill_instants():
    """`Transaction.created_at` values that are a migration artefact.

    ``auto_now_add`` stamps each INSERT with ``timezone.now()`` at microsecond
    resolution, so two separately-inserted rows do not share a value — the
    loop does several round trips per row. A value carried by two or more rows
    is therefore not an insert time at all; it is the moment an ``AddField``
    with a one-off default rewrote the whole table (``g12f/0075``).

    Discovered from the data rather than hardcoded to that migration's date:
    the property being tested ("this timestamp cannot mean what the column
    claims") is what matters, and any future column backfill leaves the same
    fingerprint. In production this returns exactly one value, held by 809 of
    901 rows.

    Over-inclusion is safe in the direction that matters: it moves a purchase
    from "definite shortfall" to "cannot be verified", never to "fine".
    """
    return set(
        Transaction.objects
        .values("created_at")
        .annotate(n=Count("txid"))
        .filter(n__gt=1)
        .values_list("created_at", flat=True)
    )


# `{"act": "buy_2z", "id": "<username>"}` -- the username the BUYER put in the
# memo. Immutable, unlike `Transaction.creator_id`, and therefore the only
# durable statement of who the payment was for. It is not authoritative on its
# own (a memo can name an account that never existed, which is exactly what
# `credit_creators` pages about), so it is printed for a human to resolve, not
# joined on.
_MEMO_ID = re.compile(r'"id"\s*:\s*"([^"]*)"')


def memo_username(memo_plain: str):
    """The username a note's memo asked to be credited, or ``None``."""
    if not memo_plain:
        return None
    found = _MEMO_ID.search(memo_plain)
    return found.group(1) if found else None


class Command(BaseCommand):
    help = "Report buy_2z notes with no matching BOUGHT_TUZI event (read-only)"

    def add_arguments(self, parser):
        parser.add_argument(
            "--limit", type=int, default=200,
            help="maximum suspect creators to list (default 200)")
        parser.add_argument(
            "--show-unverified", action="store_true",
            help=("list every RECORDED purchase with no receipt this code "
                  "wrote. Wider than the per-creator listings, which a "
                  "balanced count can hide a note behind -- but still bounded "
                  "by what g12f.Transaction can hold. See the module "
                  "docstring: only the wallet is complete."))

    def handle(self, *args, **options):
        limit = options["limit"]

        purchases = list(
            Transaction.objects.filter(action="buy_2z")
            .values_list("txid", "creator_id", "amount", "created_at",
                         "memo_plain")
        )

        backfilled_at = schema_backfill_instants()
        owners = {cid for _, cid, _, _, _ in purchases if cid}
        joined = dict(
            Creator.objects.filter(pk__in=owners)
            .values_list("pk", "date_joined"))
        usernames = dict(
            Creator.objects.filter(pk__in=owners)
            .values_list("pk", "username"))

        def is_datable(seen) -> bool:
            """Does this row carry a timestamp that means what it says?"""
            return seen not in backfilled_at and seen > BOUGHT_TUZI_EPOCH

        # A row should not predate the account it is charged to: the loop
        # resolves the Creator before writing the row. `created_at` is a lower
        # bound on the row's existence even when it is the migration instant,
        # so the comparison holds for undatable rows too.
        #
        # THE STRONGEST SIGNAL THIS TABLE CARRIES, NOT A PROOF. `date_joined`
        # is editable -- `CreatorAdmin` exposes it and does not mark it
        # read-only -- so an administrative correction or an import can
        # manufacture this shape without any FK ever moving. That is exactly
        # why a row flagged here is withheld from the definite claim and from
        # nothing else: it is still counted, still listed, still reconciled.
        # (Third codex pass.)
        #
        # PER ROW, NOT PER CREATOR. Exempting the whole creator would let one
        # inherited 2023 note hide a genuine 2026 loss on the same account --
        # the account appears in the exempt set and its real shortfall is
        # never counted. (Found by the codex adversarial review.)
        #
        # This is a repair, not a cure. A re-point moves the ROW and leaves
        # the event behind, so the account the note came FROM keeps an event
        # it no longer owns a note for -- and that stale event can cover a
        # genuine later loss on that same account. This table cannot say who
        # the note came from, so the mitigation is the EXCESS-EVENTS listing
        # below: every account holding more BOUGHT_TUZI events than notes is
        # named, because a shortfall on one of them can be masked.
        # (Second codex pass.)
        repointed = [
            row for row in purchases
            if row[1] in joined and row[3] < joined[row[1]]
        ]
        repointed_txids = {row[0] for row in repointed}

        # A re-pointed row is withheld from the EXIT-1 arithmetic and from
        # nothing else. It stays in `all_by_creator`, so the creator still
        # appears in the undecidable listing with every one of its notes
        # printed. That matters because `date_joined` is not immutable --
        # `CreatorAdmin` exposes it -- so an administrative correction can
        # make a perfectly legitimate purchase look re-pointed. Dropping such
        # a row outright would delete a real loss from the report; withholding
        # only the definite claim costs nothing. (Third codex pass.)
        datable = [
            p for p in purchases
            if is_datable(p[3]) and p[0] not in repointed_txids
        ]

        # COUNTS, not presence. An earlier revision only flagged creators with
        # ZERO BOUGHT_TUZI events, which meant a buyer whose FIRST purchase
        # credited and whose SECOND was eaten by the crash looked clean and
        # the command exited 0 -- an operator could run the reconciliation
        # this audit asked for, get a green result, and leave real missing
        # credits in place. Found by the codex adversarial review.
        datable_by_creator = Counter(c for _, c, _, _, _ in datable)
        all_by_creator = Counter(c for _, c, _, _, _ in purchases)
        events_by_creator = Counter(
            Event.objects.filter(type="BOUGHT_TUZI")
            .values_list("receiving_user_id", flat=True)
        )

        # DEFINITE. Every datable purchase postdates the epoch, so each one
        # owes an event. Events are only ever over-counted here (Stripe emits
        # the same type, and an undatable purchase may have produced one), so
        # `datable > events` can miss a shortfall but cannot invent one --
        # which is the only asymmetry acceptable for a claim an operator may
        # act on with money.
        suspects = sorted(
            (
                (creator_id, n, events_by_creator.get(creator_id, 0))
                for creator_id, n in datable_by_creator.items()
                if events_by_creator.get(creator_id, 0) < n
            ),
            key=lambda row: row[1] - row[2],
            reverse=True,
        )
        suspect_creators = {row[0] for row in suspects}

        # UNDECIDABLE, AND STILL WORTH SEEING. The pre- command reported
        # these as definite; this one must not simply drop them, or a real
        # loss hidden behind an undatable sibling's event disappears from the
        # output entirely. Concretely: one credited 2023 purchase carrying the
        # schema-backfill timestamp plus one later purchase lost in the crash
        # window is one datable purchase and one event -- balanced, and the
        # buyer is short. Which of the two is short cannot be decided without
        # the note's real date. (Found by the codex adversarial review.)
        possible = sorted(
            (
                (creator_id, n, events_by_creator.get(creator_id, 0))
                for creator_id, n in all_by_creator.items()
                if creator_id not in suspect_creators
                and events_by_creator.get(creator_id, 0) < n
            ),
            key=lambda row: row[1] - row[2],
            reverse=True,
        )

        # ACCOUNTS HOLDING MORE EVENTS THAN NOTES. Two ways to get here, and
        # only one of them is innocent: a Stripe purchase (same event type, no
        # txid), or a note that was re-pointed AWAY from this account and left
        # its event behind. The second is not hypothetical -- it is how
        # creator 570 was found holding seven events and no notes at all --
        # and a stale event of that kind can silently cover a genuine later
        # loss on the same account, which is why these are named rather than
        # left implicit. (Second codex pass.)
        excess_events = sorted(
            (
                (creator_id, all_by_creator.get(creator_id, 0), n)
                for creator_id, n in events_by_creator.items()
                if n > all_by_creator.get(creator_id, 0)
            ),
            key=lambda row: row[2] - row[1],
            reverse=True,
        )

        # An account can hold events and own no note at all (creator 570 does),
        # so the name lookup has to reach past the purchase owners.
        usernames.update(
            Creator.objects
            .filter(pk__in={row[0] for row in excess_events} - set(usernames))
            .values_list("pk", "username"))

        receipts = ZecCreditReceipt.objects.count()
        backfilled = ZecCreditReceipt.objects.filter(backfilled=True).count()

        # EXIT 0 MUST MEAN SOMETHING. Counting BOUGHT_TUZI events cannot prove
        # a specific ZEC purchase was credited: the Stripe path emits the same
        # event type, so a creator with two ZEC purchases (one lost), one
        # Stripe purchase and two events looks balanced and `suspects` is
        # empty. Automation would read exit 0 as "history reconciled". It is
        # not. (Found by the codex adversarial review.)
        #
        # Only a receipt this code wrote -- `backfilled=False`, with a
        # recorded `tuzis_credited` -- proves 2Z were actually issued for a
        # specific note. Everything older is UNVERIFIABLE from the database
        # alone and gets its own exit code.
        confirmed_txids = set(
            ZecCreditReceipt.objects
            .filter(backfilled=False, tuzis_credited__isnull=False)
            .values_list("txid", flat=True)
        )
        unverifiable = [
            txid for txid, _, _, _, _ in purchases
            if txid not in confirmed_txids
        ]

        self.stdout.write(
            f"buy_2z transactions: {len(purchases)} across "
            f"{len(Counter(c for _, c, _, _, _ in purchases))} creators\n"
            f"  charged to an account younger than the row (the creator FK "
            f"was re-pointed, so this row says nothing about either "
            f"account): {len(repointed)}\n"
            f"  with a usable purchase date: {len(datable)}\n"
            f"  undatable (schema-backfilled timestamp, or before the "
            f"{BOUGHT_TUZI_EPOCH.date()} event epoch): "
            f"{len(purchases) - len(datable) - len(repointed)}\n"
            f"credit receipts: {receipts} ({backfilled} backfilled -- the old "
            f"code saw the note; that is NOT proof 2Z were issued)\n"
            f"purchases with a receipt this code wrote: "
            f"{len(purchases) - len(unverifiable)}\n"
            f"purchases that cannot be verified from the database: "
            f"{len(unverifiable)}\n"
            f"creators with fewer BOUGHT_TUZI events than DATABLE ZEC "
            f"purchases: {len(suspects)}\n"
            f"creators short only once undatable purchases are counted "
            f"(undecidable here): {len(possible)}"
        )

        def note_lines(creator_id, rows=None):
            """Every note still attributed to this creator.

            ALL of them, datable and undatable alike. Printing only the
            datable ones under a definite shortfall, or only the undatable
            ones under an undecidable one, hides the very note that may be
            unpaid: an event carries no txid, so the command cannot know
            which of a creator's purchases any event covers, and the text
            calls these lines "the set to reconcile". (Second codex pass.)
            """
            for txid, owner, amount, seen, memo_plain in (
                    rows if rows is not None else purchases):
                if owner != creator_id:
                    continue
                claimed = memo_username(memo_plain)
                # The memo is immutable and names who the BUYER asked to be
                # credited; the FK is not. An operator resolving ownership by
                # hand needs both.
                mismatch = (
                    "" if claimed is None
                    or claimed.lower() == (usernames.get(owner) or "").lower()
                    else f" MEMO-NAMES='{claimed}' (not this account)")
                when = ("seen" if is_datable(seen)
                        else "row existed by")
                self.stdout.write(
                    f"      {txid} {amount} ZEC {when}={seen.isoformat()}"
                    f"{mismatch}")

        for creator_id, bought, credited in suspects[:limit]:
            self.stdout.write(
                f"  SUSPECT creator={creator_id} zec_purchases={bought} "
                f"bought_tuzi_events={credited} "
                f"missing>={bought - credited}"
            )
            note_lines(creator_id)
        if len(suspects) > limit:
            self.stdout.write(f"  ... {len(suspects) - limit} more")

        for creator_id, bought, credited in possible[:limit]:
            self.stdout.write(
                f"  POSSIBLE creator={creator_id} zec_purchases={bought} "
                f"bought_tuzi_events={credited} "
                f"(undatable purchases counted; not evidence of a shortfall)"
            )
            note_lines(creator_id)
        if len(possible) > limit:
            self.stdout.write(f"  ... {len(possible) - limit} more")

        for txid, creator_id, amount, seen, _memo in repointed:
            self.stdout.write(
                f"  RE-POINTED {txid} {amount} ZEC is charged to creator "
                f"{creator_id} ('{usernames.get(creator_id)}', joined "
                f"{joined[creator_id].isoformat()}) but the row already "
                f"existed at {seen.isoformat()}. The pre-#1132 loop rewrote "
                f"Transaction.creator from the memo's username on every "
                f"cycle, so whoever was actually credited holds the "
                f"BOUGHT_TUZI event under a different account."
            )

        for creator_id, notes, events in excess_events:
            self.stdout.write(
                f"  EXCESS-EVENTS creator={creator_id} "
                f"('{usernames.get(creator_id, '?')}') holds {events} "
                f"BOUGHT_TUZI event(s) against {notes} buy_2z note(s). Either "
                f"Stripe purchases (same event type, no txid) or notes that "
                f"were re-pointed away and left their events behind. A "
                f"shortfall on this account can be masked by the surplus."
            )

        if unverifiable:
            # THE PER-CREATOR LISTINGS ARE TRIAGE, NOT THE RECONCILIATION SET.
            # A creator whose counts happen to balance -- one stale event left
            # behind by a re-point, one purchase lost -- appears in none of
            # them, and the buyer is never named. Events carry no txid, so no
            # arrangement of counts can close that hole. (Third codex pass.)
            #
            # AND THIS LISTING IS STILL NOT COMPLETE. `g12f.Transaction`'s
            # primary key was the bare txid until, so a transaction
            # paying several outputs to us could only ever store ONE of them:
            # a second uncredited note of such a transaction may have left no
            # row, no receipt and no event anywhere in this database, and
            # nothing here can print what was never written. Saying
            # "complete" would be the same overclaim this whole command is
            # about. Only the wallet, keyed on (txid, pool, output_index),
            # closes it. (Fourth codex pass.)
            self.stdout.write(
                f"\n{len(unverifiable)} recorded purchase(s) have no receipt "
                f"written by this code. A balanced event count can hide any "
                f"one of them, so the listings above are triage: re-run with "
                f"--show-unverified for all of them. That is still not every "
                f"NOTE -- until #1132 this table was keyed on the bare txid "
                f"and could hold only one note per transaction, so a second "
                f"output may have left no row at all. Only the wallet is "
                f"complete.")
            if options["show_unverified"]:
                unconfirmed = [
                    row for row in purchases if row[0] in set(unverifiable)]
                for txid, owner, amount, seen, memo_plain in unconfirmed:
                    claimed = memo_username(memo_plain)
                    self.stdout.write(
                        f"  UNVERIFIED {txid} {amount} ZEC creator={owner} "
                        f"('{usernames.get(owner, '?')}') memo-names="
                        f"'{claimed}' "
                        f"{'seen' if is_datable(seen) else 'row existed by'}="
                        f"{seen.isoformat()}")

        self.stdout.write(
            "\nEXIT CODES\n"
            "  0  every ZEC purchase has a receipt written by the current "
            "code with a recorded 2Z amount. Nothing to reconcile.\n"
            "  1  at least one creator has strictly fewer BOUGHT_TUZI events "
            "than ZEC purchases THIS COMMAND CAN DATE, none of them "
            "re-pointed. Something happened to a specific, named note -- but "
            "see below: it is a reason to investigate, never on its own a "
            "reason to credit.\n"
            "  2  no definite shortfall, but some purchases predate the "
            "receipt table and cannot be verified from the database at all. "
            "Reconcile those against the wallet by hand.\n"
            "\nWHAT A MISSING EVENT IS NOT. It is not proof the 2Z were "
            "never issued. Before #1132 `ledger.credit` and "
            "`Event.objects.create` were separate autocommit statements, so "
            "a crash BETWEEN them leaves a buyer who was paid and has no "
            "event -- indistinguishable, in this table, from a buyer who was "
            "not paid. Crediting on that evidence alone creates 2Z and pays "
            "the same purchase twice. The event is a notification; it was "
            "never a ledger. (Found by the codex adversarial review.)\n"
            "\nWHY 2 EXISTS. BOUGHT_TUZI events are also emitted by the "
            "Stripe purchase path and carry no txid, so a balanced count "
            "proves nothing about a particular note. Never read a clean "
            "count as 'history is fine'.\n"
            "\nThe second listing above is the undecidable middle: short "
            "only once undatable purchases are counted, so the database "
            "cannot say whether the missing event belongs to a purchase that "
            "predates the event stream or to one that was really lost. Those "
            "lines are NOT evidence of a shortfall and NOT a clean bill of "
            "health; they are the set to reconcile against the wallet.\n"
            "\nWHY 1 IS NARROW (#1410). BOUGHT_TUZI events did not exist "
            "before the epoch above, `created_at` is a migration artefact on "
            "every row written before g12f/0075, and the pre-#1132 loop "
            "rewrote Transaction.creator from the memo on every cycle. A "
            "shortfall counted across any of those is not a shortfall. Read "
            "this module's docstring before widening it again.\n"
            "\nWHAT THE RE-POINT DETECTION CANNOT DO. `created_at < "
            "date_joined` is the strongest signal this table carries, not a "
            "proof -- `date_joined` is editable in the admin, so a "
            "correction can manufacture the same shape. And its ABSENCE "
            "proves nothing at all: an "
            "account older than the note it inherited leaves no trace at all "
            "in this table, so a definite-shortfall line is a reason to read "
            "the memo and the account history -- shown above as MEMO-NAMES "
            "wherever it disagrees with the creator FK -- and never, on its "
            "own, a reason to credit anybody. (codex adversarial review.)\n"
            "\nNOTE: the payment-host wallet cannot settle the unverifiable set. "
            "Its accounts were re-created with a 2026-07 birthday, so it "
            "holds no record of any note received before then; reconciling "
            "the legacy notes needs a rescan from the original birthday, "
            "which is a deliberate operator action."
        )

        if suspects:
            # Not a CommandError: this is a report, and the non-zero exit is
            # the useful part. Raising would bury the listing in a traceback.
            raise SystemExit(1)
        # A re-pointed row only forces exit 2 while it is also unverifiable.
        # Once a note has a receipt THIS code wrote, with a recorded 2Z
        # amount, it is positively verified and an administrative edit to
        # `date_joined` afterwards must not reopen it -- otherwise exit 0
        # becomes unreachable and the command generates permanent false work.
        # (Fourth codex pass.)
        if unverifiable or possible:
            raise SystemExit(2)
