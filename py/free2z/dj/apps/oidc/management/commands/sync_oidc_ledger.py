"""Backfill app/grant projections after all pre-L2 pods have drained."""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from dj.apps.oidc import ledger_projection
from dj.apps.oidc.models import AppAuthorization, F2ZApplication


class Command(BaseCommand):
    help = "Backfill L2 app and grant projections; dry-run unless --apply."

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')

    def handle(self, *args, **options):
        for table in (ledger_projection.LEDGER_APP_TABLE, ledger_projection.LEDGER_SPEND_CAP_TABLE):
            if not ledger_projection._table_exists(table):
                raise CommandError(f'{table} is absent; apply L2 first')
        if not options['apply']:
            self.stdout.write(f"dry-run: apps={F2ZApplication.objects.count()} grants={AppAuthorization.objects.count()}")
            return
        apps, grants = 0, 0
        # Each transaction re-reads its object under the same registry/grant
        # lock normal writes use; never overwrite a newer revoke with an old
        # iterator snapshot. Keep one user's ledger locks per transaction.
        for pk in F2ZApplication.objects.order_by('pk').values_list('pk', flat=True).iterator():
            with transaction.atomic():
                app = F2ZApplication.objects.select_for_update().filter(pk=pk).first()
                if app is not None:
                    ledger_projection.sync_application(app)
                    apps += 1
        for pk in AppAuthorization.objects.order_by('pk').values_list('pk', flat=True).iterator():
            with transaction.atomic():
                grant = AppAuthorization.objects.select_for_update().filter(pk=pk).first()
                if grant is not None:
                    ledger_projection.sync_grant(grant)
                    grants += 1
        self.stdout.write(f'applied: apps={apps} grants={grants}')
