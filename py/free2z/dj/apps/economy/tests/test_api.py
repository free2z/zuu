"""Real PostgreSQL authorization, canonical consent and debt visibility."""
import pytest
from django.utils import timezone

from dj.apps.economy import contracts, services, views
from dj.apps.economy.models import CompensationAgreement, CreatorPayable, EconomicPolicy, FundingReservation, LegacyClaim, LegacyClaimDecision, PaymentRequest
from dj.apps.economy.serializers import USDField
from dj.apps.economy.tests.test_foundation import activate_for_test
from rest_framework.exceptions import ValidationError


@pytest.fixture
def actor(api_client, creator_factory, monkeypatch):
    # Prepared current contract integration; main remains intentionally v1-only.
    monkeypatch.setattr(services, 'CONTRACT_VERSION', contracts.CREATOR_CONTRACT_VERSION)
    creator = creator_factory()
    api_client.force_authenticate(creator)
    EconomicPolicy.objects.get_or_create(pk=True)
    return creator


def bind(actor):
    return services.register_legal_payee(creator_id=actor.pk, legal_name='Example Creator LLC', jurisdiction='US-NY',
        verification={'identity_reference': 'verified:example', 'authority_reference': 'authority:example'}, operator='staff:example')


def consent(actor_id):
    return {'expected_actor_id': actor_id, 'version': contracts.CREATOR_CONTRACT_VERSION, 'digest': contracts.CREATOR_CONTRACT_DIGEST,
        'schedules': views.schedule_references(), 'acknowledged': True}


@pytest.mark.parametrize('value', [1, 1.0, True, 'NaN', '1e0', '1.0000000000', '-1.000000000', '0.000000000', '9223372036.854775808', '9'*5000 + '.000000000'])
def test_money_rejects_unsafe_or_inexact_input(value):
    with pytest.raises(ValidationError):
        USDField().run_validation(value)


@pytest.mark.django_db
def test_public_actual_document_and_schedules_no_personal_data(api_client):
    result = api_client.get('/api/economy/agreement/')
    assert result.status_code == 200
    assert result.data['text'] == contracts.CREATOR_CONTRACT_TEXT
    assert len(result.data['schedules']) == 2
    assert all(item['digest'] == contracts.text_digest(item['text']) for item in result.data['schedules'])
    assert result['Cache-Control'] == 'no-store'


@pytest.mark.django_db
def test_missing_account_is_not_fabricated_zero(api_client, actor):
    response = api_client.get('/api/economy/earnings/')
    assert response.status_code == 409
    assert response.data['code'] == 'earnings_onboarding_required'
    assert not CreatorPayable.objects.filter(creator=actor).exists()


@pytest.mark.django_db
def test_accept_requires_actual_staff_binding_and_exact_displayed_schedules(api_client, actor):
    assert api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json').status_code == 409
    bind(actor)
    wrong = consent(actor.pk)
    wrong['schedules'] = wrong['schedules'][:-1]
    assert api_client.post('/api/economy/agreement/accept/', wrong, format='json').status_code == 409
    assert not CompensationAgreement.objects.exists()
    response = api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json')
    assert response.status_code == 200
    agreement = CompensationAgreement.objects.get()
    assert agreement.acceptance_evidence['activation_required'] is True
    assert agreement.acceptance_evidence['schedules'] == views.schedule_references()
    original = agreement.acceptance_evidence
    retry = api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json')
    agreement.refresh_from_db()
    assert retry.data == response.data
    assert agreement.acceptance_evidence == original
    earnings = api_client.get('/api/economy/earnings/').data
    assert earnings['balance'] == '0.000000000'
    assert earnings['agreement_accepted'] is True
    assert earnings['compensation_eligible'] is False
    assert earnings['recovery'] is None and earnings['recovery_available'] is False
    assert earnings['legal_payee']['display_name'] == 'Example Creator LLC'


@pytest.mark.django_db
def test_delegated_header_cannot_upgrade_session(api_client, actor):
    result = api_client.get('/api/economy/earnings/', HTTP_AUTHORIZATION='Bearer sdk-delegation')
    assert result.status_code == 403


@pytest.mark.django_db
def test_recorded_debt_visible_after_prospective_revocation_and_policy_fence(api_client, actor):
    bind(actor)
    api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json')
    agreement = CompensationAgreement.objects.get()
    agreement.revoked_at = services._db_now()
    agreement.save(update_fields=['revoked_at'])
    account = CreatorPayable.objects.get(creator=actor)
    # Actual attributable non-service adjustment, not a usage balance conversion.
    activate_for_test()
    services.adjust_payable(creator_id=actor.pk, delta_nusd=1234567890, idempotency_key='actual-adjustment',
        basis={'contractual_basis': 'owed:example', 'reason': 'test recorded debt', 'source_reference': 'source:example'}, operator='staff:example')
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    result = api_client.get('/api/economy/earnings/')
    assert result.status_code == 200
    assert result.data['balance'] == '1.234567890'
    assert result.data['available'] == '1.234567890'
    assert result.data['agreement_accepted'] is True
    assert result.data['compensation_eligible'] is False
    assert account.currency == 'USD'


@pytest.mark.django_db
def test_payment_replay_survives_fence_and_keeps_original_evidence(api_client, actor):
    bind(actor)
    api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json')
    activate_for_test()
    services.adjust_payable(creator_id=actor.pk, delta_nusd=2_000_000_000, idempotency_key='owed:2',
        basis={'contractual_basis': 'owed:2', 'reason': 'test', 'source_reference': 'source:2'}, operator='staff:example')
    from dj.apps.economy.tests.test_foundation import ADDRESS
    data = {'expected_actor_id': actor.pk, 'amount': '1.000000000', 'address': ADDRESS, 'idempotency_key': 'payment:one'}
    first = api_client.post('/api/economy/payments/', data, format='json')
    assert first.status_code == 200, first.data
    row = PaymentRequest.objects.get()
    original = row.address_authorization
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    retry = api_client.post('/api/economy/payments/', data, format='json')
    assert retry.status_code == 200 and retry.data == first.data
    row.refresh_from_db()
    assert row.address_authorization == original
    data['amount'] = '2.000000000'
    assert api_client.post('/api/economy/payments/', data, format='json').data['code'] == 'idempotency_conflict'
    earnings = api_client.get('/api/economy/earnings/').data
    assert earnings['held'] == '1.000000000'
    assert earnings['available'] == '1.000000000'
    assert earnings['payment_in_flight'] == '0.000000000'


@pytest.mark.django_db
def test_new_payment_during_database_fence_is_refused_without_hold(api_client, actor):
    bind(actor)
    api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json')
    activate_for_test()
    services.adjust_payable(creator_id=actor.pk, delta_nusd=1_000_000_000, idempotency_key='owed:fenced',
        basis={'contractual_basis': 'owed', 'reason': 'test', 'source_reference': 'source'}, operator='reviewer')
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    from dj.apps.economy.tests.test_foundation import ADDRESS
    result = api_client.post('/api/economy/payments/', {'expected_actor_id': actor.pk, 'amount': '1.000000000', 'address': ADDRESS, 'idempotency_key': 'new:fenced'}, format='json')
    assert result.status_code == 409 and result.data['code'] == 'economic_writers_fenced'
    assert not PaymentRequest.objects.exists()
    assert CreatorPayable.objects.get(creator=actor).held_nusd == 0


@pytest.mark.django_db(transaction=True)
@pytest.mark.ledger_drift_expected
def test_policy_row_lock_is_explicit_busy_refusal(api_client, actor, reset_isolated_policy):
    from django.db import connection, transaction
    from dj.apps.economy.tests.test_foundation import ADDRESS
    bind(actor)
    with transaction.atomic():
        activate_for_test()
    separate = connection.Database.connect(**connection.get_connection_params())
    try:
        with separate.cursor() as cursor:
            cursor.execute('SELECT id FROM economy_economicpolicy WHERE id FOR UPDATE')
        result = api_client.post('/api/economy/payments/', {'expected_actor_id': actor.pk, 'amount': '1.000000000', 'address': ADDRESS, 'idempotency_key': 'policy:busy'}, format='json')
        assert result.status_code == 503 and result.data['code'] == 'economic_writers_busy'
        assert not PaymentRequest.objects.exists()
    finally:
        separate.rollback()
        separate.close()


@pytest.fixture
def reset_isolated_policy():
    yield
    # Isolated test-owner reset for Django flush; no production reset exists.
    from dj.apps.economy.tests.test_foundation import sql
    sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
    try:
        sql('UPDATE economy_economicpolicy SET version=0,fenced=false')
    finally:
        sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
    sql('ALTER TABLE ledger_config DISABLE TRIGGER ledger_boundary_config_guard')
    try:
        sql('UPDATE ledger_config SET writer_boundary=false,heal_enabled=true')
    finally:
        sql('ALTER TABLE ledger_config ENABLE TRIGGER ledger_boundary_config_guard')
    sql('TRUNCATE ledger_transfer,ledger_ai_usage')


@pytest.mark.django_db
def test_other_person_payment_is_hidden(api_client, actor, creator_factory):
    other = creator_factory()
    bind(other)
    assert api_client.get('/api/economy/payments/').data == {'actor_id': actor.pk, 'results': []}
    assert api_client.get('/api/economy/payments/00000000-0000-0000-0000-000000000001/').status_code == 404


@pytest.mark.django_db
def test_legacy_flag_only_source_backed_and_final_attributed_decision(actor):
    ordinary = LegacyClaim.objects.create(creator=actor, snapshot_key='ordinary', snapshot_at=timezone.now(), usage_snapshot_m2z=1000, evidence={'purchased': True})
    assert views.legacy_pending(actor.pk) is None
    claim = LegacyClaim.objects.create(creator=actor, snapshot_key='possible', snapshot_at=timezone.now(), usage_snapshot_m2z=0, evidence={'possible_redeemability': True})
    assert views.legacy_pending(actor.pk) is True
    LegacyClaimDecision.objects.create(claim=claim, classification='reviewed', basis={'legal_basis': 'basis', 'source_reference': 'source', 'decision_reference': 'decision'}, operator='reviewer')
    assert views.legacy_pending(actor.pk) is True
    LegacyClaimDecision.objects.create(claim=claim, classification='reviewed', basis={'final': True, 'legal_basis': 'basis', 'source_reference': 'source', 'decision_reference': 'decision'}, operator='reviewer')
    assert views.legacy_pending(actor.pk) is False
    assert ordinary.liability_nusd is None


@pytest.mark.django_db
def test_funding_resolution_is_opaque_owned_and_not_credit(api_client, actor, creator_factory):
    other = creator_factory()
    for user in (actor, other):
        FundingReservation.objects.create(recipient=user, purchaser=user, idempotency_key=f'captured:{user.pk}', day=timezone.now().date(), amount_m2z=1000, sale_nusd=0, state='resolution', external_receipt={'private': 'not exposed'})
    result = api_client.get('/api/economy/funding-resolutions/').data['results']
    assert len(result) == 1
    assert result[0]['resolution_id'].startswith('funding:')
    assert result[0]['credited'] is False
    assert 'private' not in str(result)


@pytest.mark.django_db
@pytest.mark.parametrize('header', ['Bearer delegated', ' bearer\tdelegated', 'bEaReR delegated'])
def test_real_session_cannot_upgrade_delegated_auth(api_client, creator_factory, header):
    actor = creator_factory()
    api_client.force_login(actor)
    assert api_client.get('/api/economy/earnings/', HTTP_AUTHORIZATION=header).status_code == 403


@pytest.mark.django_db
def test_real_knox_epoch_revoke_and_session_csrf(creator_factory):
    from django.db.models import F
    from knox.models import AuthToken
    from rest_framework.test import APIClient
    actor = creator_factory()
    EconomicPolicy.objects.get_or_create(pk=True)
    bind(actor)
    _, token = AuthToken.objects.create(actor)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f'Token {token}')
    assert client.get('/api/economy/earnings/').status_code == 200
    type(actor).objects.filter(pk=actor.pk).update(kt_account_epoch=F('kt_account_epoch')+1)
    assert client.get('/api/economy/earnings/').status_code == 401
    actor.refresh_from_db()
    session = APIClient(enforce_csrf_checks=True)
    session.force_login(actor)
    assert session.get('/api/economy/earnings/').status_code == 200
    assert session.post('/api/economy/agreement/accept/', consent(actor.pk), format='json').status_code == 403
    assert not CompensationAgreement.objects.exists()


@pytest.mark.django_db
def test_prepared_but_hardblocked_writer_capability(actor, monkeypatch):
    from types import SimpleNamespace
    real_find = views.find_spec
    monkeypatch.setattr(views, 'find_spec', lambda name: object() if name == 'dj.apps.economy.epoch' else real_find(name))
    monkeypatch.setattr(views, 'import_module', lambda name: SimpleNamespace(product_integration_available=lambda: False))
    assert views.capabilities() == {'policy_version': 0, 'active': False, 'creator_compensation_available': False,
        'zec_funding_method': dict(contracts.zec_funding_method(contracts.ZEC_FUNDING_VERSION))}


@pytest.mark.django_db
def test_real_session_account_switch_refuses_original_instruction(api_client, creator_factory):
    original = creator_factory()
    current = creator_factory()
    EconomicPolicy.objects.get_or_create(pk=True)
    bind(original)
    bind(current)
    api_client.force_login(current)
    response = api_client.post('/api/economy/agreement/accept/', consent(original.pk), format='json')
    assert response.status_code == 409 and response.data['code'] == 'actor_changed'
    from dj.apps.economy.tests.test_foundation import ADDRESS
    response = api_client.post('/api/economy/payments/', {'expected_actor_id': original.pk, 'amount': '1.000000000', 'address': ADDRESS, 'idempotency_key': 'original-account'}, format='json')
    assert response.status_code == 409 and response.data['code'] == 'actor_changed'
    assert not CompensationAgreement.objects.exists()
    assert not PaymentRequest.objects.exists()
    assert CreatorPayable.objects.get(creator=current).held_nusd == 0


@pytest.mark.django_db
def test_expired_real_knox_cannot_accept(creator_factory):
    from datetime import timedelta
    from knox.models import AuthToken
    from rest_framework.test import APIClient
    actor = creator_factory()
    bind(actor)
    instance, token = AuthToken.objects.create(actor)
    AuthToken.objects.filter(pk=instance.pk).update(expiry=timezone.now()-timedelta(seconds=1))
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f'Token {token}')
    assert client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json').status_code == 401
    assert not CompensationAgreement.objects.exists()


def test_legal_mirrors_have_exact_canonical_resources():
    from pathlib import Path
    root = Path(__file__).resolve().parents[6]
    for relative in ('docs/about-free2z/docs/legal/06-revenue-share-agreement.md', 'new-docs/legal/creator-compensation.md'):
        document = (root/relative).read_text()
        if '(https://free2z.cash/api/economy/agreement/)' not in document:
            assert '```text\n'+contracts.CREATOR_CONTRACT_TEXT+'```' in document
            for schedule in contracts.SERVICE_SCHEDULES.values():
                assert '```text\n'+schedule['text']+'```' in document


@pytest.mark.django_db
def test_unprepared_contract_writer_refuses_current_acceptance(api_client, actor, monkeypatch):
    bind(actor)
    monkeypatch.setattr(services, 'CONTRACT_VERSION', 'cc-2026-10-v1')
    response = api_client.post('/api/economy/agreement/accept/', consent(actor.pk), format='json')
    assert response.status_code == 503
    assert response.data['code'] == 'agreement_integration_unavailable'
    assert not CompensationAgreement.objects.exists()


@pytest.mark.django_db
def test_deferred_usage_purchase_never_invokes_installed_helpers(api_client, actor, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Deferred usage purchase called a financial helper')
    monkeypatch.setattr(views, 'product_module', forbidden)
    for response in (
        api_client.get('/api/economy/usage-purchase-quote/?amount=1.000000000'),
        api_client.post('/api/economy/usage-purchases/', {'expected_actor_id': actor.pk}, format='json'),
    ):
        assert response.status_code == 503
        assert response.data['code'] == 'usage_purchase_unavailable'
    assert not CreatorPayable.objects.filter(creator=actor).exists()


@pytest.mark.django_db
def test_activity_uses_actual_own_service_journal_and_omits_private_evidence(api_client, actor, creator_factory, monkeypatch):
    from dj.apps.economy.tests.test_foundation import make_contract, DELIVERY, settle_fixture
    other = creator_factory()
    activate_for_test()
    _, _, _, admission = make_contract(actor)
    entry = settle_fixture(admission_id=admission.pk, allocated_m2z=123, delivery_evidence=DELIVERY)
    _, _, _, other_admission = make_contract(other)
    settle_fixture(admission_id=other_admission.pk, allocated_m2z=999, delivery_evidence=DELIVERY)
    services.adjust_payable(creator_id=actor.pk, delta_nusd=1, idempotency_key='activity-adjustment',
        basis={'contractual_basis': 'owed', 'reason': 'private', 'source_reference': 'secret:source'}, operator='staff:example')
    response = api_client.get('/api/economy/earnings/')
    assert response.status_code == 200
    assert response.data['recent_activity'] == [{'id': f'payable:{entry.pk}', 'service': 'livestream_ppv',
        'currency': 'USD', 'amount': '0.001230000', 'created_at': entry.created_at}]
    assert 'secret:source' not in str(response.data)
    assert 'basis' not in str(response.data) and 'delivery_evidence' not in str(response.data)


@pytest.mark.django_db
def test_retained_v1_payment_method_remains_usable_after_current_v2_publication(api_client, actor, monkeypatch):
    previous = contracts.creator_contract('cc-2026-10-v1', '6d4d6ad368ad9971be9b5a714ed25ab028c5a40caeb6b7ad47880bfd2efc3478')
    payee = bind(actor)
    monkeypatch.setattr(services, 'CONTRACT_VERSION', 'cc-2026-10-v1')
    agreement = services.accept_agreement(creator_id=actor.pk, legal_payee_id=payee.pk,
        contract_version=previous['version'], contract_digest=previous['digest'], acceptance_evidence={
            'document_reference': previous['version'], 'actor_authentication': 'actual-self:test', 'authority_reference': 'actual:test'})
    agreement.revoked_at = services._db_now()
    agreement.save(update_fields=['revoked_at'])
    monkeypatch.setattr(services, 'CONTRACT_VERSION', contracts.CREATOR_CONTRACT_VERSION)
    activate_for_test()
    services.adjust_payable(creator_id=actor.pk, delta_nusd=1_000_000_000, idempotency_key='retained:owed',
        basis={'contractual_basis': 'owed', 'source_reference': 'actual:old', 'reason': 'test owed'}, operator='staff:example')
    from dj.apps.economy.tests.test_foundation import ADDRESS
    response = api_client.post('/api/economy/payments/', {'expected_actor_id': actor.pk,
        'amount': '1.000000000', 'address': ADDRESS, 'idempotency_key': 'retained:payment'}, format='json')
    assert response.status_code == 200, response.data
    request = PaymentRequest.objects.get()
    assert request.address_authorization['compensation_agreement_id'] == agreement.pk
    assert request.address_authorization['payment_terms_reference'] == 'cc-2026-10-v1:surviving-payment-terms'
    assert api_client.get('/api/economy/earnings/').data['compensation_eligible'] is False


@pytest.mark.parametrize('route', ['earnings', 'payments', 'funding-resolutions'])
@pytest.mark.django_db
def test_private_reads_bind_original_actor_before_loading_other_accounts(api_client, actor, creator_factory, route):
    bind(actor)
    own = api_client.get(f'/api/economy/{route}/', {'expected_actor_id': actor.pk})
    assert own.status_code == 200 and own.data['actor_id'] == actor.pk
    other = creator_factory()
    api_client.force_authenticate(other)
    switched = api_client.get(f'/api/economy/{route}/', {'expected_actor_id': actor.pk})
    assert switched.status_code == 409 and switched.data['code'] == 'actor_changed'
    assert 'balance' not in switched.data and 'results' not in switched.data
    bind(other)
    response_b = api_client.get(f'/api/economy/{route}/', {'expected_actor_id': other.pk})
    api_client.force_authenticate(actor)
    assert response_b.data['actor_id'] == other.pk


@pytest.mark.parametrize('query', ['0', '-1', '1.0', 'true', '9223372036854775808', '1&expected_actor_id=1'])
@pytest.mark.django_db
def test_private_actor_query_rejects_ambiguous_or_noninteger_values(api_client, actor, query):
    response = api_client.get(f'/api/economy/payments/?expected_actor_id={query}')
    assert response.status_code == 400 and response.data['code'] == 'invalid_request'


@pytest.mark.django_db
def test_zec_capacity_read_counts_existing_daily_exposure_and_never_writes(api_client,actor,creator_factory):
    from django.db import connection,transaction
    from django.test.utils import CaptureQueriesContext
    from dj.apps.economy.models import FundingDay,PurchaserDay
    from dj.apps.ledger.models import Account
    with transaction.atomic():
        activate_for_test()
        services.reserve_funding(recipient_id=actor.pk,purchaser_id=actor.pk,
            amount_m2z=20000,sale_nusd=500000000,idempotency_key='capacity:reserved')
    account=Account.objects.get(owner=actor,kind='user')
    FundingDay.objects.filter(account=account).update(opening_m2z=10000,incoming_m2z=40000)
    PurchaserDay.objects.filter(purchaser=actor).update(sold_nusd=300000000)
    EconomicPolicy.objects.filter(pk=True).update(account_daily_limit_m2z=100000,purchaser_daily_limit_nusd=1000000000)
    other=creator_factory(tuzis=0)
    with CaptureQueriesContext(connection) as queries:
        response=api_client.get(f'/api/economy/funding-resolutions/?expected_actor_id={actor.pk}')
    assert response.status_code==200
    assert response.data['actor_id']==actor.pk
    capacity=response.data['zec_funding_capacity']
    assert capacity['remaining_m2z']=='30000'
    assert capacity['remaining_sale_nusd']=='200000000'
    assert capacity['as_of'].utcoffset().total_seconds()==0
    assert not any(query['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for query in queries)
    assert api_client.get(f'/api/economy/funding-resolutions/?expected_actor_id={other.pk}').status_code==409
    assert 'zec_funding_capacity' not in api_client.get('/api/economy/capabilities/').data


@pytest.mark.django_db
def test_zec_capacity_read_without_account_does_not_create_financial_state(api_client,actor):
    from django.db import transaction
    from dj.apps.ledger.models import Account
    from dj.apps.economy.models import FundingDay,PurchaserDay
    with transaction.atomic():activate_for_test()
    before=(Account.objects.count(),FundingDay.objects.count(),PurchaserDay.objects.count(),FundingReservation.objects.count())
    response=api_client.get(f'/api/economy/funding-resolutions/?expected_actor_id={actor.pk}')
    assert response.status_code==200
    assert int(response.data['zec_funding_capacity']['remaining_m2z'])==200000000-int(actor.tuzis*1000)
    assert before==(Account.objects.count(),FundingDay.objects.count(),PurchaserDay.objects.count(),FundingReservation.objects.count())
    EconomicPolicy.objects.filter(pk=True).update(fenced=True)
    assert api_client.get('/api/economy/funding-resolutions/').data['zec_funding_capacity']['remaining_m2z']=='0'


@pytest.mark.django_db
def test_zec_capacity_read_uses_actual_verified_purchaser_group(api_client,actor,creator_factory):
    from django.db import transaction
    with transaction.atomic():activate_for_test()
    sibling=creator_factory(tuzis=0)
    for user in (actor,sibling):
        services.register_legal_payee(creator_id=user.pk,legal_name='Verified Same Person',jurisdiction='US-NY',
            verification={'identity_reference':f'id:{user.pk}','authority_reference':f'authority:{user.pk}',
                'legal_person_reference':'verified:shared-person'},operator='staff:test')
    with transaction.atomic():
        services.reserve_funding(recipient_id=sibling.pk,purchaser_id=sibling.pk,
            amount_m2z=1000,sale_nusd=500000000,idempotency_key='capacity:sibling')
    EconomicPolicy.objects.filter(pk=True).update(purchaser_daily_limit_nusd=1000000000)
    assert api_client.get('/api/economy/funding-resolutions/').data['zec_funding_capacity']['remaining_sale_nusd']=='500000000'


@pytest.mark.django_db
def test_policy_zero_has_no_supported_zec_capacity_preview(api_client,actor):
    assert api_client.get('/api/economy/funding-resolutions/').data['zec_funding_capacity'] is None
