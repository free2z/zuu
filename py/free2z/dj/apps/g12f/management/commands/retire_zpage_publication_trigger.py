"""Retire the publication trigger after a healthy application rollout."""

from django.core.management.base import BaseCommand
from django.db import connection, transaction


LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '3s';"
DROP_TRIGGER_SQL = (
    "DROP TRIGGER IF EXISTS g12f_zpage_publication_timestamp "
    "ON g12f_zpage;"
)
DROP_FUNCTION_SQL = "DROP FUNCTION IF EXISTS g12f_set_zpage_published_at();"


class Command(BaseCommand):
    help = "Remove the obsolete zPage publication timestamp trigger."

    def handle(self, *args, **options):
        # Keep both drops in one bounded transaction. If the lock budget is
        # exceeded, PostgreSQL aborts the transaction and the trigger remains
        # installed for the next deployment attempt.
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(LOCK_TIMEOUT_SQL)
                cursor.execute(DROP_TRIGGER_SQL)
                cursor.execute(DROP_FUNCTION_SQL)

        self.stdout.write(self.style.SUCCESS(
            "zPage publication trigger retired."
        ))
