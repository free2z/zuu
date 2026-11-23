"""Inspect retained PPV delivery evidence or explicitly retry one observation."""
import json
import re

from django.core.management.base import BaseCommand, CommandError

from dj.apps.dyte.credit_recovery import attempt_observation
from dj.apps.dyte.recovery_db import recovery_database
from dj.apps.dyte.models import PpvCreditObservation
from dj.apps.jobs.models import OperatorAction
from dj.apps.jobs.ops import actor_name


class Command(BaseCommand):
    help = 'List pending credit observations; --key selects one for an audited explicit retry.'

    def add_arguments(self, parser):
        parser.add_argument('--key')
        parser.add_argument('--execute', action='store_true')
        parser.add_argument('--money', action='store_true')
        parser.add_argument('--reason')

    def handle(self, *args, **options):
        key = options['key']
        if key is not None and not re.fullmatch('[0-9a-f]{64}', key):
            raise CommandError('--key must be an exact observation key')
        rows = PpvCreditObservation.objects.all()
        if key is not None:
            rows = rows.filter(pk=key)
            with recovery_database():
                if not rows.exists():
                    raise CommandError('observation not found')
        else:
            rows = rows.filter(completed_at__isnull=True)
        if options['execute']:
            if key is None or not options['money'] or not (options['reason'] or '').strip():
                raise CommandError('execution requires --key, --money and a nonempty --reason')
            with recovery_database():
                OperatorAction.objects.create(actor=actor_name(), verb='ppv_credit_retry',
                    job_ids=[], reason=f'observation={key}; {options["reason"].strip()}', dry_run=False)
                attempt_observation(key, force=True)
        with recovery_database():
            observations = list(rows.order_by('created_at','provider_key').values(
                'provider_key','attempts','next_retry_at','completed_at','review_required_at','last_error')[:50])
        # Emit only after the audited attempt and readback have committed.
        self.stdout.write(json.dumps({'executed':options['execute'], 'limit':50,
            'observations':observations}, default=str))
