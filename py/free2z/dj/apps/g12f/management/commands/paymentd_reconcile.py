"""Explicit bounded historical reconciliation; no issuance option exists."""
import json
from django.core.management.base import BaseCommand, CommandError
from dj.apps.g12f.paymentd_credit import reconcile_payment
from dj.apps.g12f.paymentd_protocol import LocalEvidence


class Command(BaseCommand):
    help = 'Verify historical receipt IDs; --apply retains raw notes and adopts proven existing credits only.'

    def add_arguments(self, parser):
        parser.add_argument('payment_ids', nargs='+')
        parser.add_argument('--apply', action='store_true')
        for name in ['config','receivers','binary']:
            parser.add_argument('--'+name,required=True)

    def handle(self,*args,**options):
        if len(options['payment_ids'])>100:
            raise CommandError('historical batch exceeds 100 receipts')
        try:
            verifier=LocalEvidence(options['config'],options['receivers'],options['binary'])
            counts={}
            for identity in options['payment_ids']:
                result=reconcile_payment(identity,verifier,apply=options['apply'])
                counts[result.status]=counts.get(result.status,0)+1
        except Exception:
            raise CommandError('historical reconciliation incomplete; retry explicit IDs after inspecting private evidence') from None
        self.stdout.write(json.dumps({'schema_version':1,'results':counts,'newly_issued':0}))
