"""Reviewed manifest cutover. No deployment, drain or consent fabrication."""
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from dj.apps.economy.models import EconomicPolicy
from dj.apps.economy.services import activation_readiness
from dj.apps.g12f.models import Creator


class Command(BaseCommand):
    help = 'Dry-run a reviewed cutover manifest; --apply performs guarded irreversible 0→1 only.'

    def add_arguments(self, parser):
        parser.add_argument('manifest_file', type=Path)
        parser.add_argument('--operator-id', type=int, required=True)
        parser.add_argument('--apply', action='store_true')

    def handle(self, manifest_file, operator_id, apply, **options):
        try:
            manifest=json.loads(manifest_file.read_text())
        except (OSError,ValueError) as exc:
            raise CommandError('Manifest file must contain JSON.') from exc
        if not isinstance(manifest,dict) or manifest.get('operator')!=f'staff-creator:{operator_id}':
            raise CommandError('Manifest operator must identify the actual staff operator.')
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='5s'")
                cursor.execute("SET LOCAL statement_timeout='60s'")
            policy=EconomicPolicy.objects.select_for_update(nowait=True).get(id=True)
            operator=Creator.objects.select_for_update().filter(pk=operator_id,is_active=True,is_staff=True).first()
            if operator is None:
                raise CommandError('An existing active staff operator is required.')
            if policy.version==1:
                if policy.manifest!=manifest:
                    raise CommandError('Activated policy retains its original manifest; replacement is forbidden.')
                self.stdout.write('Original activation already committed. No policy or fence was changed.')
                return
            readiness=activation_readiness(manifest)
            self.stdout.write(json.dumps(readiness,sort_keys=True))
            if not apply:
                return
            if not readiness['ready']:
                raise CommandError('Activation blocked by actual readiness checks; nothing changed.')
            policy.version=1
            policy.manifest=manifest
            policy.save(update_fields=['version','manifest'])
        self.stdout.write('Reviewed activation committed. This command performed no deployment or financial transaction.')
