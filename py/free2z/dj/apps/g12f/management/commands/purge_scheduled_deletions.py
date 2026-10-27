"""Purge accounts whose self-service deletion grace period has ended.

Run hourly by the ``purge-scheduled-deletions`` CronJob
(``k8s/free2z/cron/BUILD.bazel``). A management command rather than a
Procrastinate task on purpose: the purge is an ownership event
(``bump_account_epoch``), whose session-sweep enqueue must join the account
write's transaction, which the app's Django connector does in a one-shot
``manage.py`` process and a worker's psycopg pool does not. Idempotent and
bounded; safe to run any number of times. ``--dry-run`` lists what is due
without touching it.

``--end-grace-now USERNAME`` is for proving the purge on STAGE: it
ends one pending account's grace period now, so the next run of the CronJob
purges it, through the same code as any other purge. It purges nothing
itself, and it refuses to run anywhere but the stage namespace.
"""
import os

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone


class Command(BaseCommand):
    help = "Purge accounts whose 30-day deletion grace period has ended."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=50)
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument(
            "--end-grace-now", metavar="USERNAME",
            help="STAGE ONLY: end this pending account's grace period now "
                 "(the next purge run purges it). Purges nothing itself.")

    def handle(self, *args, limit, dry_run, end_grace_now=None, **options):
        from dj.apps.g12f.account_deletion import end_grace_now as end_grace
        from dj.apps.g12f.account_deletion import purge_due_deletions
        from dj.apps.g12f.models import Creator

        if end_grace_now is not None:
            if dry_run:
                raise CommandError("--end-grace-now writes; it has no --dry-run.")
            # Read live, like the smoke-test captcha bypass: the shared
            # ConfigMap gives every pod its own namespace, and anything but
            # stage (prod, a laptop with no NAMESPACE) refuses.
            if os.environ.get("NAMESPACE") != "stage":
                raise CommandError("--end-grace-now runs on stage only.")
            try:
                purge_after = end_grace(end_grace_now)
            except ValueError as exc:
                raise CommandError(str(exc)) from None
            self.stdout.write(f"grace ended: {end_grace_now} purge_after={purge_after.isoformat()}")
            return

        if dry_run:
            due = Creator.objects.filter(
                is_active=False, deleted_at__isnull=True,
                deletion_requested_at__isnull=False,
                purge_after__lte=timezone.now(),
            ).order_by("purge_after").values_list("pk", "purge_after")[:limit]
            for pk, purge_after in due:
                self.stdout.write(f"due: user={pk} purge_after={purge_after.isoformat()}")
            return
        result = purge_due_deletions(limit=limit)
        # Exit 0 even when an account failed: that account is already logged
        # with its traceback and alerted (`purge_failed`, ticket tier), and
        # moved behind the others. A nonzero exit would fail every hourly Job
        # until it is fixed and page through the job-failure alert, for one
        # account whose purge is already waiting on an engineer.
        self.stdout.write(f"purged={result['purged']} blocked={result['blocked']} "
                          f"skipped={result['skipped']} failed={result['failed']}")
