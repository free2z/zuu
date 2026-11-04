import io
import json

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from dj.apps.economy import contracts, services
from dj.apps.economy.models import CompensationAgreement, CreatorPayable, EconomicPolicy, PaymentRequest
from dj.apps.economy.tests.test_api import bind, consent
from dj.apps.economy.tests.test_foundation import ADDRESS, activate_for_test


@pytest.mark.django_db
def test_binding_dry_run_staff_and_stable_person_evidence(creator_factory, tmp_path):
    actor = creator_factory()
    reviewer = creator_factory(is_staff=True)
    data = {'creator_id': actor.pk, 'legal_name': 'Reviewed Person', 'jurisdiction': 'US-NY',
        **{key: f'evidence:{key}' for key in ('identity_reference', 'authority_reference', 'legal_person_reference', 'linked_account_review', 'decision_reference')}}
    path = tmp_path/'binding.json'
    path.write_text(json.dumps(data))
    call_command('bind_economic_payee', str(path), reviewer_id=reviewer.pk, stdout=io.StringIO())
    assert not CreatorPayable.objects.filter(creator=actor).exists()
    with pytest.raises(CommandError, match='staff reviewer'):
        call_command('bind_economic_payee', str(path), reviewer_id=actor.pk, apply=True)
    call_command('bind_economic_payee', str(path), reviewer_id=reviewer.pk, apply=True, stdout=io.StringIO())
    account = CreatorPayable.objects.get(creator=actor)
    assert account.balance_nusd == 0
    assert account.legal_payee.verification['legal_person_reference'] == data['legal_person_reference']
    assert not CompensationAgreement.objects.exists()
    with pytest.raises(CommandError, match='assignment review'):
        call_command('bind_economic_payee', str(path), reviewer_id=reviewer.pk, apply=True)


@pytest.mark.django_db
def test_inactive_verified_claimant_instruction_preserves_surviving_method(api_client, creator_factory, tmp_path, monkeypatch):
    monkeypatch.setattr(services, 'CONTRACT_VERSION', contracts.CREATOR_CONTRACT_VERSION)
    actor = creator_factory()
    reviewer = creator_factory(is_staff=True)
    EconomicPolicy.objects.get_or_create(pk=True)
    bind(actor)
    api_client.force_authenticate(actor)
    assert api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json').status_code == 200
    activate_for_test()
    services.adjust_payable(creator_id=actor.pk, delta_nusd=1_000_000_000, idempotency_key='owed:operator',
        basis={'contractual_basis': 'owed', 'source_reference': 'source', 'reason': 'test owed'}, operator='staff:example')
    actor.is_active = False
    actor.save(update_fields=['is_active'])
    data = {'creator_id': actor.pk, 'amount': '1.000000000', 'address': ADDRESS, 'idempotency_key': 'manual:one',
        'payment_method_version': contracts.PAYMENT_METHOD_VERSION, 'payment_method_digest': contracts.PAYMENT_METHOD_DIGEST,
        **{key: f'evidence:{key}' for key in ('claimant_identity_reference', 'claimant_authority_reference', 'address_authorization_reference', 'payment_method_authorization_reference', 'decision_reference')}}
    path = tmp_path/'claim.json'
    path.write_text(json.dumps(data))
    call_command('request_economic_payment', str(path), reviewer_id=reviewer.pk, stdout=io.StringIO())
    assert not PaymentRequest.objects.exists()
    with pytest.raises(CommandError, match='staff reviewer'):
        call_command('request_economic_payment', str(path), reviewer_id=actor.pk, apply=True)
    call_command('request_economic_payment', str(path), reviewer_id=reviewer.pk, apply=True, stdout=io.StringIO())
    row = PaymentRequest.objects.get()
    original = row.address_authorization
    assert row.state == 'requested' and row.txid is None
    account = CreatorPayable.objects.get(creator=actor)
    assert account.balance_nusd == account.held_nusd == 1_000_000_000
    call_command('request_economic_payment', str(path), reviewer_id=reviewer.pk, apply=True, stdout=io.StringIO())
    row.refresh_from_db()
    assert row.address_authorization == original
    actor.refresh_from_db()
    assert actor.is_active is False
    data.pop('payment_method_authorization_reference')
    path.write_text(json.dumps(data))
    with pytest.raises(CommandError, match='payment_method_authorization_reference'):
        call_command('request_economic_payment', str(path), reviewer_id=reviewer.pk, apply=True)
