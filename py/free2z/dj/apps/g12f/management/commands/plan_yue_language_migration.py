"""Read-only preflight for g12f 0122; never applies changes."""
from importlib import import_module

from django.core.management.base import BaseCommand, CommandError
from django.db import connections, transaction
from django.db.migrations.loader import MigrationLoader


class Command(BaseCommand):
    help = "Dry-run Cantonese language repair (no writes); fail on collisions."

    def add_arguments(self, parser):
        parser.add_argument("--database", default="default")

    def handle(self, *args, **options):
        alias = options["database"]
        connection = connections[alias]
        migration = import_module("dj.apps.g12f.migrations.0122_canonicalize_yue_languages")
        # Historical models: do not couple the preflight to future live ORM.
        apps = MigrationLoader(connection).project_state(
            [("g12f", "0121_creator_deletion_schedule")]
        ).apps
        with transaction.atomic(using=alias):
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            changes, collisions = migration.plan(apps, alias)
        for name, field, old, new, count in changes:
            self.stdout.write(f"{name}.{field}: {old!r} -> {new!r}: {count} rows")
        self.stdout.write(f"Dry-run: {sum(row[4] for row in changes)} field updates; {len(collisions)} collisions")
        if collisions:
            raise CommandError("No rows changed. Resolve collisions explicitly before migrating:\n" + "\n".join(collisions))
