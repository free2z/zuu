"""Attributable manual binding. Dry run by default; never implies consent."""
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from dj.apps.economy.models import CreatorPayable
from dj.apps.economy.services import EconomicRefusal, register_legal_payee
from dj.apps.g12f.models import Creator


class Command(BaseCommand):
    help = 'Validate reviewed legal-payee binding JSON; --apply records the decision. Never accepts an agreement.'

    def add_arguments(self, parser):
        parser.add_argument('review_file', type=Path)
        parser.add_argument('--reviewer-id', type=int, required=True)
        parser.add_argument('--apply', action='store_true')

    def handle(self, review_file, reviewer_id, apply, **options):
        try:
            data = json.loads(review_file.read_text())
        except (OSError, ValueError) as exc:
            raise CommandError('Review file cannot be read as JSON.') from exc
        if not isinstance(data, dict) or type(data.get('creator_id')) is not int:
            raise CommandError('Review requires an integer creator_id.')
        for key in ('legal_name', 'jurisdiction', 'identity_reference', 'authority_reference', 'legal_person_reference', 'linked_account_review', 'decision_reference'):
            if not isinstance(data.get(key), str) or not data[key].strip():
                raise CommandError(f'Review requires {key}. Use evidence references, not raw identity/tax documents.')
        with transaction.atomic():
            ids = sorted(set((reviewer_id, data['creator_id'])))
            actors = {actor.pk: actor for actor in Creator.objects.select_for_update().filter(pk__in=ids).order_by('pk')}
            reviewer = actors.get(reviewer_id)
            if reviewer is None or not reviewer.is_active or not reviewer.is_staff:
                raise CommandError('An existing active staff reviewer must be attributable to this decision.')
            actor = actors.get(data['creator_id'])
            if actor is None or not actor.is_active:
                raise CommandError('Target creator must be active and exist.')
            if CreatorPayable.objects.filter(creator=actor, legal_payee__isnull=False).exists():
                raise CommandError('An existing bound payee requires separate assignment review; it cannot be overwritten.')
            if not apply:
                self.stdout.write('Validated dry run. No binding, account creation or agreement acceptance was performed.')
                return
            try:
                register_legal_payee(creator_id=actor.pk, legal_name=data['legal_name'], jurisdiction=data['jurisdiction'],
                    verification={key: data[key] for key in ('identity_reference', 'authority_reference', 'legal_person_reference', 'linked_account_review', 'decision_reference')},
                    operator=f'staff-creator:{reviewer.pk}')
            except EconomicRefusal as exc:
                raise CommandError(str(exc)) from exc
        self.stdout.write('Verified payee binding recorded. Creator agreement acceptance remains a separate authenticated action.')
