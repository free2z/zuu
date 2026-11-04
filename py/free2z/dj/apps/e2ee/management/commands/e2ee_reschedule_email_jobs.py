"""Bring back chat-request email jobs parked by the first release's retry ladder.

The first release retried ``e2ee.send_chat_request_email`` with
``RetryStrategy(exponential_wait=60)``, which waits ``60 ** (attempt + 1)``
seconds: a job that had failed twice sat for 2.5 days, three times for 150
days. Changing the strategy only affects the NEXT failure; jobs already
parked keep their stored ``scheduled_at``.

Run this AFTER every worker runs the new code (``tasks.EMAIL_RETRY``). Run
earlier, an old worker could pick a rescheduled job up, fail again, and park
it with the old ladder. That is why this is a command and not a migration:
``migrate`` runs before the rollout, and a failed rollout can leave old
workers in place indefinitely.

Idempotent. Touches only this task's ``todo`` jobs scheduled more than an hour
out, which the new ladder never produces. ``--dry-run`` only counts them.

    python manage.py e2ee_reschedule_email_jobs --dry-run
"""
from django.core.management.base import BaseCommand
from django.db import connection

from dj.apps.e2ee.tasks import SEND_TASK_NAME

WHERE = (
    "task_name = %s AND status = 'todo' "
    "AND scheduled_at > now() + interval '1 hour'"
)


class Command(BaseCommand):
    help = "Reschedule chat-request email jobs parked by the old retry ladder."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, dry_run=False, **options):
        with connection.cursor() as cursor:
            if dry_run:
                cursor.execute(
                    f"SELECT count(*) FROM procrastinate_jobs WHERE {WHERE}",
                    [SEND_TASK_NAME],
                )
                count = cursor.fetchone()[0]
                self.stdout.write(f"{count} parked chat-request email job(s)")
                return
            cursor.execute(
                f"UPDATE procrastinate_jobs SET scheduled_at = now() "
                f"WHERE {WHERE}",
                [SEND_TASK_NAME],
            )
            self.stdout.write(
                f"rescheduled {cursor.rowcount} chat-request email job(s)"
            )
