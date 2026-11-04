"""Publish current canonical compensation metadata; never records consent."""
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from dj.apps.economy import contracts, services
from dj.apps.economy.models import CompensationSchedule, EconomicPolicy


class Command(BaseCommand):
    help = 'Validate current canonical PPV/SDK schedules. --apply publishes missing metadata only.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')

    def handle(self, apply, **options):
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='5s'")
                cursor.execute("SET LOCAL statement_timeout='60s'")
            EconomicPolicy.objects.select_for_update(nowait=True).get(id=True)
            now=services._db_now()
            missing=[]
            for resource in contracts.SERVICE_SCHEDULES.values():
                row=CompensationSchedule.objects.filter(service=resource['service'],version=resource['version']).first()
                expected=(resource['contract_version'],resource['rate_nusd_per_allocated_m2z'],resource['digest'])
                if row is not None:
                    if (row.contract_version,row.nusd_per_allocated_m2z,row.published_digest)!=expected or row.ends_at is not None:
                        raise CommandError('Existing canonical schedule conflicts; historical publication cannot be overwritten.')
                else:
                    missing.append(resource)
            if apply:
                for resource in missing:
                    CompensationSchedule.objects.create(service=resource['service'],version=resource['version'],
                        contract_version=resource['contract_version'],nusd_per_allocated_m2z=resource['rate_nusd_per_allocated_m2z'],
                        published_digest=resource['digest'],effective_at=now)
        self.stdout.write(f'{"Published" if apply else "Dry run: missing"} {len(missing)} current schedules. No supplier identity, consent or offer approval was recorded.')
