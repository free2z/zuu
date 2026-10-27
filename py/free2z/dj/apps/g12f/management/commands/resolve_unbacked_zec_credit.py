"""Close out an instant ZEC credit whose note vanished from the wallet.

WHY THIS EXISTS AS A COMMAND AND NOT AS AN ADMIN CHECKBOX
--------------------------------------------------------
When `credit_creators` finds that 2Z were issued for a note the wallet no
longer holds, it marks the receipt `vanished_at`, pages, and **halts instant
crediting platform-wide** until somebody decides what happened. That halt is
the whole safety argument for not auto-reversing anybody's balance, so it has
to be releasable — a brake with no release is an outage waiting to happen.

`ZecCreditReceiptAdmin` is deliberately read-only (deleting a receipt
re-credits that purchase on the next cycle), so the release cannot live
there. It lives here, where it takes an explicit txid, prints exactly what is
being released, and leaves the reasoning in the shell history and the log.

**This command does not move any 2Z.** Reversing a credit is a separate,
deliberate act with its own consequences — the recipient may have spent it,
and a `ledger.debit` that fails with `InsufficientFunds` halfway through a
"cleanup" is worse than doing nothing. Decide about the balance first, using
the receipt this prints; then release the brake.
"""
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from dj.apps.tuzis.zec import unresolved_unbacked_credits


class Command(BaseCommand):
    help = ("Release the instant-credit halt for an unbacked ZEC credit "
            "(does NOT move any 2Z)")

    def add_arguments(self, parser):
        parser.add_argument(
            "txid", nargs="?",
            help="The txid to resolve. Omit to list what is outstanding.")
        parser.add_argument(
            "--output-index", type=int, default=None,
            help="Narrow to one note of a multi-output transaction.")
        parser.add_argument(
            "--note", default="",
            help="What was decided, recorded in the log line.")

    def handle(self, *args, **options):
        outstanding = unresolved_unbacked_credits()
        if not options["txid"]:
            if not outstanding.exists():
                print("No unbacked instant credits. Instant crediting is not "
                      "halted.")
                return
            print(f"{outstanding.count()} unbacked instant credit(s) are "
                  f"halting instant crediting:")
            for receipt in outstanding:
                print(f"  {receipt}  creator={receipt.creator_id}  "
                      f"{receipt.amount_zec} ZEC -> "
                      f"{receipt.tuzis_credited} 2Z  "
                      f"credited_at={receipt.created_at.isoformat()}  "
                      f"confirmations_at_credit="
                      f"{receipt.confirmations_at_credit}  "
                      f"vanished_at={receipt.vanished_at.isoformat()}")
            print("\nDecide about the balance FIRST. This command only "
                  "releases the halt; it moves no 2Z.")
            return

        matching = outstanding.filter(txid=options["txid"])
        if options["output_index"] is not None:
            matching = matching.filter(output_index=options["output_index"])
        found = list(matching)
        if not found:
            raise CommandError(
                f"no unresolved unbacked credit for txid "
                f"{options['txid']!r}; `manage.py "
                f"resolve_unbacked_zec_credit` with no argument lists them")

        now = timezone.now()
        for receipt in found:
            matching.filter(pk=receipt.pk).update(vanish_resolved_at=now)
            print(f"released {receipt} ({receipt.amount_zec} ZEC / "
                  f"{receipt.tuzis_credited} 2Z to creator "
                  f"{receipt.creator_id}); no 2Z were moved"
                  + (f"; note: {options['note']}" if options["note"] else ""))

        still = unresolved_unbacked_credits().count()
        if still:
            print(f"{still} unbacked credit(s) still outstanding; instant "
                  f"crediting remains halted")
        else:
            print("no unbacked credits outstanding; instant crediting will "
                  "resume on the next cycle")
