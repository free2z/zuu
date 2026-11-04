from dj.apps.economy.tests.test_integration import historical_note_observation
"""Prepared product boundaries on actual PostgreSQL; activation stays blocked."""
import json
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.economy import funding, products, services as money
from dj.apps.economy.contracts import CREATOR_CONTRACT_DIGEST, SERVICE_SCHEDULES
from dj.apps.economy.models import CompensationSchedule, CreatorPayable
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.g12f.models import Creator
from dj.apps.pricing.models import ZecPriceSnapshot
from dj.apps.purchases.models import Status, PurchaseIntent
from dj.apps.ztripe.economic_events import dispute_principal

pytestmark = pytest.mark.django_db


@pytest.fixture
def enabled():
    activate_for_test()


@pytest.fixture
def price():
    return ZecPriceSnapshot.objects.create(zec_usd=100, median_usd=100,
        spread=Decimal('.1'), tuzis_per_zec=9000, num_sources=2,
        sources={'coinbase': '100', 'kraken': '100'})


def supplier_contract(creator, schedules=None):
    payee = money.register_legal_payee(creator_id=creator.pk, legal_name='Actual Supplier LLC', jurisdiction='US-NY',
        verification={'identity_reference': 'actual:id', 'authority_reference': 'actual:authority'}, operator='staff:actual')
    accepted = schedules if schedules is not None else [
        {'service': resource['service'], 'version': resource['version'], 'digest': resource['digest']}
        for resource in SERVICE_SCHEDULES.values()]
    agreement = money.accept_agreement(creator_id=creator.pk, legal_payee_id=payee.pk,
        contract_digest=CREATOR_CONTRACT_DIGEST, acceptance_evidence={
            'document_reference': money.CONTRACT_VERSION, 'actor_authentication': 'actual:login',
            'authority_reference': 'actual:authority', 'schedules': accepted})
    return agreement


def publish(service):
    resource = SERVICE_SCHEDULES[service]
    return CompensationSchedule.objects.create(service=service, version=resource['version'],
        contract_version=resource['contract_version'], published_digest=resource['digest'],
        nusd_per_allocated_m2z=resource['rate_nusd_per_allocated_m2z'], effective_at=money._db_now())


def test_arbitrary_schedule_digest_not_published_resource(enabled):
    CompensationSchedule.objects.create(service='sdk_application', version='invented', contract_version=money.CONTRACT_VERSION,
        published_digest='a'*64, nusd_per_allocated_m2z=10000, effective_at=money._db_now())
    with pytest.raises(money.EconomicRefusal, match='compensation_schedule_unavailable'):
        products.get_effective_compensation_schedule('sdk_application')


def test_supplier_actual_schedule_consent_required_before_admission(creator_factory, enabled):
    supplier, buyer = creator_factory(tuzis=0), creator_factory(tuzis=0)
    supplier_contract(supplier, schedules=[])
    publish('sdk_application')
    with pytest.raises(money.EconomicRefusal, match='compensation_schedule_acceptance_required'):
        products.admit_product_service(creator_id=supplier.pk, subject_creator_id=buyer.pk,
            service='sdk_application', event_id='application:1', source={
                'source_kind': 'licensed-membership', 'source_id': 'offer:1',
                'authorization_reference': 'buyer:1', 'delivery_scope_reference': 'pages:1'})


def test_self_service_never_admits(creator_factory, enabled):
    supplier = creator_factory(tuzis=0)
    with pytest.raises(money.EconomicRefusal, match='compensated_self_service_unsupported'):
        products.admit_product_service(creator_id=supplier.pk, subject_creator_id=supplier.pk,
            service='sdk_application', event_id='self:1', source={
                'source_kind': 'app', 'source_id': 'app:1', 'authorization_reference': 'buyer:1',
                'delivery_scope_reference': 'contribution:1'})


@pytest.mark.parametrize('amount', [1, 9999, 10001, 10000001])
def test_usage_purchase_never_rounds_away_owed_fraction(amount):
    with pytest.raises(money.EconomicRefusal, match='usage_purchase_precision'):
        products._purchase_amount(amount)


def test_dispute_principal_partial_and_company_fee_excluded():
    charge = {'amount': 1000, 'currency': 'usd'}
    dispute = {'id': 'du_actual', 'amount': 250, 'balance_transactions': [
        {'id': 'txn_withdraw', 'source': 'du_actual', 'currency': 'usd', 'amount': -250, 'fee': 1500, 'net': -1750}]}
    principal, evidence = dispute_principal(dispute, charge)
    assert principal == 250 and evidence[0]['fee_cents'] == 1500
    dispute['balance_transactions'].append({'id': 'txn_return', 'source': 'du_actual', 'currency': 'usd',
        'amount': 250, 'fee': 0, 'net': 250})
    assert dispute_principal(dispute, charge)[0] == 0


def test_closed_dispute_status_without_movement_does_not_establish_loss():
    assert dispute_principal({'id': 'du_actual', 'amount': 250, 'status': 'lost', 'balance_transactions': []},
        {'amount': 1000, 'currency': 'usd'}) == (0, [])


def test_unproven_dispute_movement_refused():
    with pytest.raises(money.EconomicRefusal, match='dispute_movement_unproven'):
        dispute_principal({'id': 'du_actual', 'amount': 250, 'balance_transactions': [
            {'id': 'txn_unknown', 'source': 'another-dispute', 'currency': 'usd', 'amount': -250}]},
            {'amount': 1000, 'currency': 'usd'})


def test_subscription_remains_utility_sharing_without_usd_or_supplier_onboarding(creator_factory, enabled):
    from dj.apps.events.models import Event
    from dj.apps.g12f.models import Subscription
    from dj.apps.tuzis import ledger
    supplier, buyer = creator_factory(tuzis=0), creator_factory(tuzis=0)
    ledger.credit(buyer, 100, source='sys:promo', ref_kind='tuzi_grant', ref_id='service-funding', idem='service-funding')
    subscription = Subscription.objects.create(star=supplier, fan=buyer, max_price=10)
    assert subscription.extend(expected_price=Decimal('10')) is True
    supplier.refresh_from_db()
    buyer.refresh_from_db()
    assert supplier.tuzis == 10 and buyer.tuzis == 90
    assert not CreatorPayable.objects.filter(creator=supplier, balance_nusd__gt=0).exists()
    assert subscription.expires > timezone.now() + timedelta(days=29)
    assert Event.objects.filter(type='SUBSCRIPTION_RECEIVED', receiving_user=supplier, amount=10).exists()
    assert subscription.extend(expected_price=Decimal('10')) is False
    buyer.refresh_from_db()
    assert buyer.tuzis == 90


def test_membership_historical_schedule_is_not_new_compensation(enabled):
    with pytest.raises(money.EconomicRefusal, match='compensation_schedule_unavailable'):
        products.get_effective_compensation_schedule('subscription_access')


def test_known_own_note_resolution_projection_is_bounded_and_private(creator_factory, enabled):
    owner, other = creator_factory(tuzis=0), creator_factory(tuzis=0)
    own = historical_note_observation(creator_id=owner.pk, txid='e'*64, pool='sapling',
        output_index=0, amount_zec='.2', memo_plain=json.dumps({'act': 'buy_2z', 'id': owner.username}))
    historical_note_observation(creator_id=other.pk, txid='f'*64, pool='sapling',
        output_index=0, amount_zec='.2', memo_plain=json.dumps({'act': 'buy_2z', 'id': other.username}))
    rows = funding.funding_resolution_statuses(creator_id=owner.pk)
    assert len(rows) == 1 and rows[0]['resolution_id'] == f'zec-note:{own.pk}'
    assert set(rows[0]) == {'status', 'credited', 'resolution_id', 'reason', 'created_at'}


def test_known_linked_purchasers_share_actual_day_allowance(creator_factory, enabled):
    from dj.apps.economy.models import EconomicPolicy
    one, two = creator_factory(tuzis=0), creator_factory(tuzis=0)
    for buyer in (one, two):
        money.register_legal_payee(creator_id=buyer.pk, legal_name='Same Actual Entity LLC', jurisdiction='US-NY',
            verification={'identity_reference': f'identity:{buyer.pk}', 'authority_reference': f'authority:{buyer.pk}',
                'legal_person_reference': 'verified-person:one'}, operator='actual:staff')
    EconomicPolicy.objects.filter(pk=True).update(purchaser_daily_limit_nusd=100_000_000_000)
    money.reserve_funding(recipient_id=one.pk, purchaser_id=one.pk, amount_m2z=6_000_000,
        sale_nusd=60_000_000_000, idempotency_key='linked:one')
    with pytest.raises(money.EconomicRefusal, match='purchaser_daily_sales_limit'):
        money.reserve_funding(recipient_id=two.pk, purchaser_id=two.pk, amount_m2z=6_000_000,
            sale_nusd=60_000_000_000, idempotency_key='linked:two')


def test_inactive_other_linked_account_does_not_refuse_active_buyers_capture(creator_factory, enabled):
    one, archived = creator_factory(tuzis=0), creator_factory(tuzis=0)
    for buyer in (one, archived):
        money.register_legal_payee(creator_id=buyer.pk, legal_name='Actual Same Entity', jurisdiction='US-NY',
            verification={'identity_reference': f'id:{buyer.pk}', 'authority_reference': f'authority:{buyer.pk}',
                'legal_person_reference': 'verified-person:two'}, operator='actual:staff')
    Creator.objects.filter(pk=archived.pk).update(is_active=False)
    reservation = money.reserve_funding(recipient_id=one.pk, purchaser_id=one.pk, amount_m2z=100_000,
        sale_nusd=1_500_000_000, idempotency_key='active-buyer:captured')
    assert money.validate_reserved_funding_for_capture(reservation_id=reservation.pk).pk == reservation.pk
    result = money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe',
        receipt={'provider_reference': 'pi_active_buyer', 'captured_at': timezone.now().isoformat(), 'amount_cents': 150})
    assert result.state == 'issued'


def test_nominal_historical_refund_cursor_does_not_prove_issuance(creator_factory, enabled):
    from dj.apps.ledger.models import Account, PurchaseRefund
    from dj.apps.ledger import api as usage
    from dj.apps.ztripe.models import StripeTransaction
    buyer = creator_factory(tuzis=0)
    usage.ensure_account(buyer.pk)
    purchase = StripeTransaction.objects.create(user=buyer, amount=100, tuzis_credited=100, stripe_charge_id='pi_nominal')
    PurchaseRefund.objects.create(ref_kind='stripe_transaction', ref_id=str(purchase.pk), rail='stripe',
        account=Account.objects.get(owner_id=buyer.pk, kind='user'), credited_m2z=100_000)
    assert funding.transaction_issuance_status(purchase) == {'status': 'unavailable', 'credited': False, 'credited_m2z': None,
        'usage_credited_m2z': None, 'usage_debt_repaid_m2z': None}


def test_debt_only_purchase_is_proven_fulfillment_with_zero_new_usage(creator_factory):
    from dj.apps.ledger import api as usage
    from dj.apps.ztripe.models import StripeTransaction
    buyer = creator_factory(tuzis=0)
    usage.credit_purchase(buyer.pk, 100_000, 'stripe', 'stripe_transaction', 'before-debt', 'before-debt')
    usage.spend(buyer.pk, 100_000, 'used', 'used', 'used')
    usage.refund_purchase(buyer.pk, 'stripe_transaction', 'before-debt', 100_000, 'dispute', 'dispute')
    purchase = StripeTransaction.objects.create(user=buyer, amount=100, tuzis_credited=100, stripe_charge_id='pi_repay')
    usage.credit_purchase(buyer.pk, 100_000, 'stripe', 'stripe_transaction', str(purchase.pk), 'new-repay')
    assert funding.transaction_issuance_status(purchase) == {'status': 'credited', 'credited': True, 'credited_m2z': '100000',
        'usage_credited_m2z': '0', 'usage_debt_repaid_m2z': '100000'}


@pytest.mark.parametrize('debt', [0, 60_000, 100_000])
def test_card_intent_split_requires_original_ledger_evidence(creator_factory, debt):
    from dj.apps.ledger import api as usage
    from dj.apps.purchases.models import PurchaseReceipt, Rail
    from dj.apps.ztripe.models import StripeTransaction
    buyer = creator_factory(tuzis=0)
    if debt:
        usage.credit_purchase(buyer.pk, debt, 'stripe', 'stripe_transaction', 'earlier', 'earlier-funding')
        usage.spend(buyer.pk, debt, 'earlier', 'earlier', 'earlier-spend')
        usage.refund_purchase(buyer.pk, 'stripe_transaction', 'earlier', debt, 'earlier', 'earlier-refund')
    now = timezone.now()
    intent = PurchaseIntent.objects.create(creator=buyer, rail=Rail.STRIPE, platform='web',
        quantity_2z=100, quote={}, pricing_version='card-v3', price_minor=150, currency='USD',
        status=Status.CREDITED, credited_at=now, credited_milli_2z=100_000,
        expires_at=now + timedelta(minutes=30))
    purchase = StripeTransaction.objects.create(user=buyer, amount=150, tuzis_credited=100, stripe_charge_id='pi_card_split')
    receipt = PurchaseReceipt.objects.create(intent=intent, rail=Rail.STRIPE, provider_event_id='pi_card_split',
        amount_minor=150, currency='USD', credited_milli_2z=100_000,
        ledger_ref_kind='stripe_transaction', ledger_ref_id=str(purchase.pk))
    # Even nominal CREDITED + a provider receipt is insufficient without the
    # actual original clearing-account issuance/debt repayment legs.
    assert funding.purchase_intent_issuance_status(intent)['usage_credited_m2z'] is None
    usage.credit_purchase(buyer.pk, 100_000, 'stripe', 'stripe_transaction', str(purchase.pk), 'card-split')
    expected = {'status': 'credited', 'credited': True, 'credited_m2z': '100000',
        'usage_credited_m2z': str(100_000 - debt), 'usage_debt_repaid_m2z': str(debt)}
    assert funding.purchase_intent_issuance_status(intent) == expected
    if debt < 100_000:
        usage.spend(buyer.pk, 100_000 - debt, 'later', 'later', 'later-spend')
    assert funding.purchase_intent_issuance_status(intent) == expected
    receipt.provider_event_id = 'pi_unrelated'
    receipt.save(update_fields=['provider_event_id'])
    assert funding.purchase_intent_issuance_status(intent)['usage_credited_m2z'] is None


def test_installed_ppv_still_refuses_unknown_offer_before_delivery(creator_factory, enabled):
    host, viewer = creator_factory(tuzis=0), creator_factory(tuzis=0)
    with pytest.raises(money.EconomicRefusal, match='livestream_offer_unavailable'):
        products.prepare_livestream_admission(host_id=host.pk, viewer_id=viewer.pk,
            meeting_id='actual-provider-room', price_per_minute=Decimal('1.23'),viewer_account_epoch=viewer.kt_account_epoch)


def test_prepared_ppv_captures_real_original_offer_and_refuses_changed_price(creator_factory, enabled, mocker):
    import uuid
    from dj.apps.dyte.models import CreatorMeeting, PAY_PER_VIEW, LIFECYCLE_LIVE
    host, viewer = creator_factory(tuzis=0), creator_factory(tuzis=0)
    meeting = CreatorMeeting.objects.create(creator=host, meeting_id='real-offer',
        meeting_type=PAY_PER_VIEW, live_now=True, lifecycle_state=LIFECYCLE_LIVE,
        price_per_minute=Decimal('1.23'), host_session_id=uuid.uuid4(), provider_session_id=uuid.uuid4())
    # Only the not-yet-installed delivery ABI availability is simulated; the
    # host, offer, price and their locks are real PostgreSQL records.
    cursor = mocker.patch.object(products, 'connection').cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = ('economy.settle_service_delivery',)
    admission = mocker.patch.object(products, 'admit_product_service')
    products.prepare_livestream_admission(host_id=host.pk, viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id, price_per_minute=Decimal('1.23'), viewer_account_epoch=viewer.kt_account_epoch)
    source = admission.call_args.kwargs['source']
    assert source['creator_meeting_id'] == meeting.pk
    assert source['provider_session_id'] == str(meeting.provider_session_id)
    assert source['host_session_id'] == str(meeting.host_session_id)
    admission.reset_mock()
    CreatorMeeting.objects.filter(pk=meeting.pk).update(price_per_minute=Decimal('2.34'))
    with pytest.raises(money.EconomicRefusal, match='livestream_price_changed'):
        products.prepare_livestream_admission(host_id=host.pk, viewer_id=viewer.pk,
            meeting_id=meeting.meeting_id, price_per_minute=Decimal('1.23'), viewer_account_epoch=viewer.kt_account_epoch)
    admission.assert_not_called()
