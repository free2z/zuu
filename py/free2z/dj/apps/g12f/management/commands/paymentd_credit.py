"""Private stdin interface; output contains no memo, token, address or username."""
import json
import sys
from django.core.management.base import BaseCommand, CommandError
from dj.apps.g12f.paymentd_credit import handle_event
from dj.apps.g12f.paymentd_protocol import LocalEvidence, decode_event


class Command(BaseCommand):
    help = 'Capture or settle one authenticated local paymentd event.'

    def add_arguments(self, parser):
        parser.add_argument('--role', required=True, choices=['capture','settle'])
        for name in ['config','receivers','binary']:
            parser.add_argument('--'+name, required=True)

    def handle(self, *args, **options):
        try:
            event = decode_event(sys.stdin.buffer.read(16385))
            verifier = LocalEvidence(options['config'],options['receivers'],options['binary'])
            result = handle_event(event,verifier,role=options['role'])
        except Exception:
            # Django exception messages can contain memo/SQL values. Keep the
            # process boundary generic, including when --traceback was supplied.
            raise CommandError('paymentd phase failed; inspect private queue and backend health') from None
        self.stdout.write(json.dumps({'phase':result.phase,'status':result.status,
                                    'newly_issued':result.newly_issued}))
