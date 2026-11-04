"""Refund AI-translation charges whose job never delivered ( Part 6).

The cron task ``g12f.reap_translation_charges`` does this every ten minutes.
This command exists for the case the cron cannot cover: an operator who needs
to see, right now, whether any creator is holding a charge with nothing to
show for it -- during an incident, or after a deploy in which the worker rolled
late.

    ./manage.py reap_translation_charges --dry-run
    ./manage.py reap_translation_charges
"""
from django.core.management.base import BaseCommand

from dj.apps.g12f.translation import charges


class Command(BaseCommand):
    help = (
        "Refund every paid AI translation whose job never completed. "
        "Use --dry-run to report without moving 2Z."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be refunded and move no 2Z.",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=500,
            help="Maximum records to process in one run (default 500).",
        )

    def handle(self, *args, **options):
        outstanding = charges.total_outstanding()
        self.stdout.write(
            f"{outstanding} 2Z currently queued (paid, not yet settled); "
            f"abandonment deadline is {charges.abandoned_after()}."
        )

        stale = charges.abandoned_records(limit=options["limit"])
        if not stale:
            self.stdout.write(self.style.SUCCESS("Nothing to refund."))
            return

        for record in stale:
            body = record.response_body or {}
            self.stdout.write(
                f"  job={body.get('job_id')} user={record.user_id} "
                f"zpage={body.get('zpage_id')} lang={body.get('language')} "
                f"charged={body.get('charged')} since={record.created_at}"
            )

        if options["dry_run"]:
            self.stdout.write(
                self.style.WARNING(
                    f"--dry-run: {len(stale)} charge(s) would be refunded."
                )
            )
            return

        refunded = charges.reap_abandoned(limit=options["limit"])
        self.stdout.write(
            self.style.SUCCESS(f"Refunded {refunded} abandoned charge(s).")
        )
