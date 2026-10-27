"""Verified manual instruction for accrued debt when self-service is unavailable."""
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from dj.apps.economy import contracts, services
from dj.apps.economy.models import CreatorPayable, PaymentRequest
from dj.apps.economy.serializers import PaymentCreateSerializer
from dj.apps.economy.views import agreement_for
from dj.apps.g12f.models import Creator
from dj.apps.g12f.validators import validate_zcash_address
from django.core.exceptions import ValidationError


class Command(BaseCommand):
    help = 'Validate an attributable claimant payment instruction; --apply reserves debt. No signing or broadcasting.'

    def add_arguments(self, parser):
        parser.add_argument('review_file', type=Path)
        parser.add_argument('--reviewer-id', type=int, required=True)
        parser.add_argument('--apply', action='store_true')

    def handle(self, review_file, reviewer_id, apply, **options):
        try:
            data = json.loads(review_file.read_text())
        except (OSError, ValueError) as exc:
            raise CommandError('Cannot read claimant instruction JSON.') from exc
        if not isinstance(data, dict) or type(data.get('creator_id')) is not int:
            raise CommandError('An integer original creator_id is required.')
        for key in ('claimant_identity_reference', 'claimant_authority_reference', 'address_authorization_reference', 'payment_method_authorization_reference', 'decision_reference'):
            if not isinstance(data.get(key), str) or not data[key].strip():
                raise CommandError(f'Reviewed instruction requires {key}.')
        serializer = PaymentCreateSerializer(data=dict(data, expected_actor_id=data['creator_id']))
        if not serializer.is_valid():
            raise CommandError('Exact positive USD amount, valid address and stable key are required.')
        amount = int(serializer.validated_data['amount'].replace('.', ''))
        address = serializer.validated_data['address']
        try:
            validate_zcash_address(address)
        except ValidationError as exc:
            raise CommandError('Invalid Zcash address.') from exc
        if not address.startswith(('u1', 'zs')):
            raise CommandError('Supported mainnet shielded address required.')
        with transaction.atomic():
            if apply:
                services.pin_policy()  # before any actor/account lock
            ids = sorted(set((reviewer_id, data['creator_id'])))
            actors = {actor.pk: actor for actor in Creator.objects.select_for_update().filter(pk__in=ids).order_by('pk')}
            reviewer = actors.get(reviewer_id)
            actor = actors.get(data['creator_id'])
            if reviewer is None or not reviewer.is_staff or not reviewer.is_active or actor is None:
                raise CommandError('An existing active staff reviewer and original claimant account are required.')
            account = CreatorPayable.objects.select_for_update().filter(creator=actor).first()
            agreement = agreement_for(account) if account else None
            if agreement is None:
                raise CommandError('Actual prior accepted surviving payment terms and bound payee are required. This command cannot fabricate consent.')
            document = contracts.creator_contract(agreement.contract_version, agreement.contract_digest)
            if (data.get('payment_method_version'), data.get('payment_method_digest')) != (document['payment_method_version'], document['payment_method_digest']):
                raise CommandError('Instruction must reference the exact previously accepted payment method version and digest.')
            existing = PaymentRequest.objects.filter(account=account, idempotency_key=data['idempotency_key']).first()
            if existing and (existing.amount_nusd, existing.address) != (amount, address):
                raise CommandError('Idempotency key conflict; inspect the original request.')
            if not existing and amount > max(account.balance_nusd-account.held_nusd, 0):
                raise CommandError('Insufficient actual available USD obligation.')
            if not apply:
                self.stdout.write('Validated dry run. No payment request, signature or broadcast was performed.')
                return
            if existing is None:
                try:
                    services.request_payment(creator_id=actor.pk, amount_nusd=amount, address=address, idempotency_key=data['idempotency_key'],
                        address_authorization={'actor_authentication': {
                            'credential_kind': 'verified-operator-instruction', 'operator_id': reviewer.pk, 'actor_id': actor.pk,
                            'account_epoch': actor.kt_account_epoch, 'reviewed_at': timezone.now().isoformat(),
                            **{key: data[key] for key in ('claimant_identity_reference', 'claimant_authority_reference', 'payment_method_authorization_reference', 'decision_reference')}},
                            'address_reference': data['address_authorization_reference'],
                            'pricing_method_version': document['payment_method_version'], 'pricing_method_digest': document['payment_method_digest'],
                            'compensation_agreement_id': agreement.pk, 'payment_terms_reference': f'{agreement.contract_version}:surviving-payment-terms'})
                except services.EconomicRefusal as exc:
                    raise CommandError(str(exc)) from exc
        self.stdout.write('Payment instruction recorded. Separate screening, tax review, signing and confirmation remain required.')
