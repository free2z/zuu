import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.core.management import call_command
from django.db import DatabaseError, connection, transaction
from django.utils import timezone

from dj.apps.ledger import api as usage
from dj.apps.g12f.models import Creator
from dj.apps.tuzis import ledger
from dj.apps.economy import services as money
from dj.apps.economy.models import CompensationSchedule, CreatorPayable, EconomicPolicy, FundingDay, PayableJournal

pytestmark = pytest.mark.django_db
ADDRESS = 'zs12f4y80pjhy042rmxq339dr6885jqqvh9fc6j8pvxg3hyhc8hmsqurlkqtkzwp03quca27pt0f7k'


def sql(query, args=None):
    with connection.cursor() as cursor:
        cursor.execute(query, args)
        return cursor.fetchall() if cursor.description else None


@pytest.fixture(autouse=True)
def seed_policy():
    EconomicPolicy.objects.get_or_create(id=True)


def activate_for_test():
    """Isolated DB owner bypass ONLY; production activation is unimplemented."""
    for creator in Creator.objects.all():
        locked = usage.lock_creator(creator.pk)
        usage.lock_account(locked.id, locked.balance)
    sql('SELECT ledger.activate_writer_boundary()')
    sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
    try:
        EconomicPolicy.objects.filter(id=True).update(version=1, activated_at=timezone.now())
    finally:
        sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
    money.pin_policy()


@pytest.fixture
def active():
    activate_for_test()


def make_contract(creator):
    """Use the installed real PPV source/contract boundary, not nominal stubs."""
    from .test_integration import service_terms
    from dj.apps.dyte.models import CreatorMeeting,WebhookDelivery
    from dj.apps.economy import products
    payee,agreement,schedule=service_terms(creator,'livestream_ppv')
    viewer=Creator.objects.create(username='delivery_'+uuid.uuid4().hex,tuzis=0)
    meeting=CreatorMeeting.objects.create(creator=creator,meeting_id=str(uuid.uuid4()),meeting_type='ppv',
        is_public=True,live_now=True,lifecycle_state='live',provider_session_id=uuid.uuid4(),
        host_session_id=uuid.uuid4(),price_per_minute='100.00')
    admission=products.prepare_livestream_admission(host_id=creator.pk,viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id,price_per_minute='100.00',viewer_account_epoch=viewer.kt_account_epoch)
    key=uuid.uuid4().hex*2
    event=WebhookDelivery.objects.create(provider_event_id=uuid.uuid4(),event_type='meeting.participantLeft',
        endpoint='general',business_event_key=key,payload_sha256='a'*64)
    DELIVERY.clear()
    DELIVERY.update(delivery_reference=key,allocation_reference='fixture-exact-collection',
        provider_event_id=str(event.pk),payload_sha256=event.payload_sha256,meeting_id=meeting.meeting_id,
        provider_session_id=str(meeting.provider_session_id),participant_id='ea_'+admission.pk.hex,
        joined_at=admission.admitted_at.isoformat(),left_at=money._db_now().isoformat())
    return payee,agreement,schedule,admission


def settle_fixture(*,admission_id,allocated_m2z,delivery_evidence):
    from dj.apps.economy.models import ServiceAdmission
    admission=ServiceAdmission.objects.get(pk=admission_id)
    if not PayableJournal.objects.filter(admission_id=admission_id).exists() and allocated_m2z>0:
        usage.credit_user(int(admission.source['subject_creator_id']),allocated_m2z,'sys:promo',
            'grant','delivery-fixture',str(admission_id),f'delivery-funds:{admission_id}')
    return money.settle_service(admission_id=admission_id,allocated_m2z=allocated_m2z,delivery_evidence=delivery_evidence)


DELIVERY = {'delivery_reference': 'provider-left:1', 'allocation_reference': 'host-fee:1'}


def accrue(creator, amount=100_000):
    _, _, _, admission = make_contract(creator)
    entry = settle_fixture(admission_id=admission.pk, allocated_m2z=amount, delivery_evidence=DELIVERY)
    return admission, entry


def test_models_match_migration():
    call_command('makemigrations', 'economy', '--check', '--dry-run', verbosity=0)


def test_default_disabled_and_activation_hard_blocked(creator_factory):
    creator = creator_factory(tuzis=Decimal('500'))
    assert EconomicPolicy.objects.get().version == 0
    assert money.activation_readiness()['ready'] is False
    assert money.activation_readiness()['usage_projection_discrepancies'] > 0
    with pytest.raises(DatabaseError, match='activation unavailable'), transaction.atomic():
        EconomicPolicy.objects.filter(id=True).update(version=1)
    with pytest.raises(money.EconomicRefusal, match='disabled'):
        money.reserve_funding(recipient_id=creator.pk, purchaser_id=creator.pk,
            amount_m2z=1000, sale_nusd=10_000_000, idempotency_key='disabled')


def test_usage_and_creator_approval_never_create_usd(creator_factory, active):
    sender, host = creator_factory(tuzis=0), creator_factory(tuzis=0)
    ledger.credit(sender, 100, source='sys:promo', ref_kind='tuzi_grant', ref_id='1', idem='gift-funds')
    ledger.transfer(sender, host, 25, idem='gift')
    host.refresh_from_db()
    assert host.tuzis == 25
    assert not PayableJournal.objects.exists()
    assert CreatorPayable.objects.create(creator=host).balance_nusd == 0


def test_ppv_accrues_exact_subcent_usd_once_and_leaves_usage(creator_factory, active):
    creator = creator_factory(tuzis=0)
    admission, entry = accrue(creator, amount=1)
    assert settle_fixture(admission_id=admission.pk, allocated_m2z=1, delivery_evidence=DELIVERY).pk == entry.pk
    assert CreatorPayable.objects.get(creator=creator).balance_nusd == 10_000
    creator.refresh_from_db()
    assert creator.tuzis == 0
    with pytest.raises(money.IdempotencyConflict):
        settle_fixture(admission_id=admission.pk, allocated_m2z=2, delivery_evidence=DELIVERY)


def test_admission_preserves_payee_after_revocation_and_blocks_new(creator_factory, active):
    creator = creator_factory(tuzis=0)
    payee, agreement, schedule, admission = make_contract(creator)
    agreement.revoked_at = timezone.now()
    agreement.save(update_fields=['revoked_at'])
    settle_fixture(admission_id=admission.pk, allocated_m2z=500, delivery_evidence=DELIVERY)
    assert CreatorPayable.objects.get(creator=creator).legal_payee_id == payee.pk
    with pytest.raises(DatabaseError, match='mismatch'), transaction.atomic():
        money.admit_service(creator_id=creator.pk, service='livestream_ppv', event_id='new',
            agreement_id=agreement.pk, schedule_id=schedule.pk,
            source={'source_kind': 'livestream', 'source_id': 'meeting:2', 'authorization_reference': 'viewer:2'})


def test_immutable_ledger_and_payee_projection(creator_factory, active):
    creator = creator_factory(tuzis=0)
    admission, entry = accrue(creator)
    with pytest.raises(DatabaseError, match='immutable'), transaction.atomic():
        PayableJournal.objects.filter(pk=entry.pk).update(delta_nusd=1)
    with pytest.raises(DatabaseError, match='immutable'), transaction.atomic():
        CompensationSchedule.objects.filter(pk=admission.schedule_id).update(nusd_per_allocated_m2z=1)
    with pytest.raises(DatabaseError, match='projection'), transaction.atomic():
        CreatorPayable.objects.filter(creator=creator).update(balance_nusd=0)
        sql('SET CONSTRAINTS economy_payable_projection_check IMMEDIATE')


def test_payee_reassignment_refused_without_erasing_debt(creator_factory, active):
    creator = creator_factory(tuzis=0)
    accrue(creator)
    other = money.register_legal_payee(creator_id=creator_factory(tuzis=0).pk, legal_name='Other LLC', jurisdiction='US-CA',
        verification={'identity_reference': 'id:2', 'authority_reference': 'authority:2'}, operator='reviewer:2')
    with pytest.raises(money.EconomicRefusal, match='assignment'):
        money.accept_agreement(creator_id=creator.pk, legal_payee_id=other.pk, contract_digest='a'*64,
            acceptance_evidence={'document_reference': money.CONTRACT_VERSION, 'actor_authentication': 'login:2', 'authority_reference': 'authority:2'})
    assert CreatorPayable.objects.get(creator=creator).balance_nusd == 1_000_000_000


@pytest.mark.parametrize('opening', ['199999', '300000'])
def test_daily_opening_spending_never_replenishes_funding(creator_factory, opening):
    creator = creator_factory(tuzis=Decimal(opening))
    activate_for_test()
    ledger.debit(creator, Decimal(opening))
    if opening == '199999':
        ledger.credit(creator, 1, source='sys:promo', ref_kind='tuzi_grant', ref_id='cap', idem='cap-exact')
    with pytest.raises(DatabaseError, match='daily_funding_limit'), transaction.atomic():
        ledger.credit(creator, Decimal('.001'), source='sys:promo', ref_kind='tuzi_grant', ref_id='cap2', idem='cap-exceeded')
    assert FundingDay.objects.get().opening_m2z == int(opening)*1000


def test_gift_incoming_subject_to_same_cap(creator_factory):
    sender = creator_factory(tuzis=Decimal('100'))
    recipient = creator_factory(tuzis=Decimal('200000'))
    activate_for_test()
    with pytest.raises(DatabaseError, match='daily_funding_limit'), transaction.atomic():
        ledger.transfer(sender, recipient, 1, idem='over-gift')
    sender.refresh_from_db()
    assert sender.tuzis == 100


def test_purchase_requires_reservation_even_bypassing_python(creator_factory, active):
    creator = creator_factory(tuzis=0)
    with pytest.raises(DatabaseError, match='requires_funding_reservation'), transaction.atomic():
        usage.credit_purchase(creator.pk, 1000, 'stripe', 'checkout', 'unreserved', 'unreserved')


def reserve(creator, key='checkout:1', amount=200_000_000):
    return money.reserve_funding(recipient_id=creator.pk, purchaser_id=creator.pk,
        amount_m2z=amount, sale_nusd=amount*10_000, idempotency_key=key)


def test_reserved_capture_once_and_other_reservations_reduce_allowance(creator_factory, active):
    creator = creator_factory(tuzis=0)
    reservation = reserve(creator)
    with pytest.raises(money.EconomicRefusal, match='funding_limit'):
        reserve(creator, 'checkout:2', 1)
    receipt = {'provider_reference': 'stripe:1', 'captured_at': timezone.now().isoformat()}
    assert money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=receipt).state == 'issued'
    assert money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=receipt).state == 'issued'
    creator.refresh_from_db()
    assert creator.tuzis == 200000
    assert not PayableJournal.objects.exists()


def test_late_overcap_capture_retains_receipt_and_no_partial_credit(creator_factory, active):
    creator = creator_factory(tuzis=0)
    reservation = reserve(creator)
    EconomicPolicy.objects.filter(id=True).update(account_daily_limit_m2z=1000)
    receipt = {'provider_reference': 'stripe:late', 'captured_at': timezone.now().isoformat()}
    resolution = money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=receipt)
    assert resolution.state == 'resolution' and resolution.external_receipt == receipt
    creator.refresh_from_db()
    assert creator.tuzis == 0 and FundingDay.objects.get().incoming_m2z == 0


def test_purchaser_cap_aggregates_directed_gifts(creator_factory, active):
    purchaser = creator_factory(tuzis=0)
    recipient1, recipient2 = creator_factory(tuzis=0), creator_factory(tuzis=0)
    money.reserve_funding(recipient_id=recipient1.pk, purchaser_id=purchaser.pk,
        amount_m2z=1000, sale_nusd=10_000_000_000_000, idempotency_key='first-gift')
    with pytest.raises(money.EconomicRefusal, match='sales_limit'):
        money.reserve_funding(recipient_id=recipient2.pk, purchaser_id=purchaser.pk,
            amount_m2z=1000, sale_nusd=1, idempotency_key='second-gift')


def test_reserved_values_carry_into_next_utc_day(creator_factory, active, monkeypatch):
    creator = creator_factory(tuzis=0)
    today = money._today()
    monkeypatch.setattr(money, '_today', lambda: today-timedelta(days=1))
    reserve(creator, 'yesterday')
    monkeypatch.setattr(money, '_today', lambda: today)
    with pytest.raises(money.EconomicRefusal, match='funding_limit'):
        reserve(creator, 'today', 1)


def test_unversioned_and_fenced_usage_writers_refused(creator_factory, active):
    creator = creator_factory(tuzis=0)
    sql("SELECT set_config('free2z.economic_policy_version','',true)")
    with pytest.raises(DatabaseError, match='version_mismatch'), transaction.atomic():
        sql("SELECT * FROM ledger.credit_user(%s,1000,'sys:promo','grant','tuzi_grant','old','stale-writer')", [creator.pk])
    money.pin_policy()
    EconomicPolicy.objects.filter(id=True).update(fenced=True)
    with pytest.raises(DatabaseError, match='fenced'), transaction.atomic():
        ledger.credit(creator, 1, source='sys:promo', ref_kind='tuzi_grant', ref_id='fence', idem='fenced-writer')


def approved_payment(creator):
    accrue(creator)
    from dj.apps.economy.models import CompensationAgreement
    agreement = CompensationAgreement.objects.get(creator=creator)
    payment = money.request_payment(creator_id=creator.pk, amount_nusd=1_000_000_000,
        address=ADDRESS, idempotency_key='request:1',
        address_authorization={'actor_authentication': 'recent-login:1', 'address_reference': 'signed-address:1',
            'pricing_method_version':'market-spot-v1', 'pricing_method_digest':'c'*64, 'compensation_agreement_id':agreement.pk,
            'payment_terms_reference':f'{agreement.contract_version}:surviving-payment-terms'})
    review = {'reviewer': 'staff:1', 'identity_reference': 'id:1', 'screening_reference': 'screen:1',
        'screened_at': timezone.now().isoformat(), 'screening_result': 'clear',
        'tax_reference': 'tax:1', 'tax_eligible': True, 'identity_eligible': True,
        'withholding_required': False, 'fee_bearer': 'platform',
        'address_reference': 'signed-address:1', 'address': ADDRESS, 'legal_payee_id': str(payment.legal_payee_id)}
    money.review_payment(payment_id=payment.pk, review=review)
    return payment


SETTLEMENT = {'operator': 'staff:2', 'rate_reference': 'fx:1', 'usd_per_zec': '100',
              'amount_zec': '0.01', 'fee_zec': '0.00001', 'signing_reference': 'sign:1',
              'usd_satisfaction_nusd': '1000000000', 'rounding_nusd': '0'}


def settlement_for(payment, **changes):
    payment.refresh_from_db()
    payload = dict(SETTLEMENT, quoted_at=timezone.now().isoformat(),
        **{key:payment.address_authorization[key] for key in ('pricing_method_version','pricing_method_digest','compensation_agreement_id')})
    return dict(payload, **changes)


def test_payment_unknown_cannot_resend_or_erase_debt(creator_factory, active):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    money.record_payment_broadcast(payment_id=payment.pk, observation={'operator': 'staff:2', 'broadcast_reference': 'unknown:1'})
    with pytest.raises(money.EconomicRefusal, match='already_started'):
        money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    with pytest.raises(money.EconomicRefusal, match='after_signing'):
        money.reject_payment(payment_id=payment.pk, operator='staff:2', reason='retry')
    account = CreatorPayable.objects.get(creator=creator)
    assert account.balance_nusd == account.held_nusd == 1_000_000_000
    money.record_payment_broadcast(payment_id=payment.pk, txid='d'*64,
        observation={'operator': 'staff:2', 'broadcast_reference': 'found-original:1'})
    evidence = {'operator': 'staff:2', 'chain_reference': 'chain:1', 'confirmed_txid': 'd'*64}
    money.confirm_payment(payment_id=payment.pk, evidence=evidence)
    money.confirm_payment(payment_id=payment.pk, evidence=evidence)
    account.refresh_from_db()
    assert account.balance_nusd == account.held_nusd == 0
    assert PayableJournal.objects.filter(kind='payment').count() == 1
    sql('SET CONSTRAINTS economy_payable_projection_check IMMEDIATE')


def test_stale_screening_blocks_signing_preserving_obligation(creator_factory, active, monkeypatch):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    payment.refresh_from_db()
    future = timezone.now()+timedelta(days=2)
    monkeypatch.setattr(money.timezone, 'now', lambda: future)
    with pytest.raises(money.EconomicRefusal, match='stale'):
        money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    assert CreatorPayable.objects.get(creator=creator).balance_nusd == 1_000_000_000


def test_legacy_snapshot_preserves_rights_without_new_debt(creator_factory):
    creator = creator_factory(tuzis=Decimal('54321'))
    claim = money.snapshot_legacy_claim(creator_id=creator.pk, snapshot_key='cutover:1',
        evidence={'operator': 'finance:1', 'snapshot_reference': 'backup:1', 'earned_event_reference': 'archive:events'})
    assert claim.usage_snapshot_m2z == 54_321_000
    assert claim.liability_nusd is None and claim.classification == 'unclassified'
    assert not PayableJournal.objects.exists() and not CreatorPayable.objects.exists()


def test_zero_service_allocation_has_durable_replay_receipt(creator_factory, active):
    creator = creator_factory(tuzis=0)
    admission, entry = accrue(creator, amount=0)
    assert entry.delta_nusd == 0
    assert settle_fixture(admission_id=admission.pk, allocated_m2z=0, delivery_evidence=DELIVERY).pk == entry.pk
    assert CreatorPayable.objects.get(creator=creator).balance_nusd == 0


def test_verified_legacy_reservation_return_is_not_fresh_funding(creator_factory):
    from dj.apps.tuzis.models import ProviderReservation
    creator = creator_factory(tuzis=Decimal('200000'))
    # Capture the historical debit and its durable reservation before cutover.
    locked = usage.lock_creator(creator.pk)
    account = usage.lock_account(locked.id, locked.balance)
    reservation = ProviderReservation.objects.create(user=creator, amount=1,
        scope='legacy-test', operation_key=uuid.uuid4())
    usage.post_transfer(account.id, usage.system_account_id('sys:reservation_clearing'),
        1000, 'spend', 'reservation', str(reservation.pk))
    activate_for_test()
    # The daily opening is already at the cap. Restoring that original debit
    # must still preserve the account's rights instead of being new issuance.
    FundingDay.objects.create(account_id=account.id, day=money._today(), opening_m2z=200_000_000)
    usage.credit_with_repay(usage.system_account_id('sys:reservation_clearing'), creator.pk,
        1000, 'refund', 'reservation', str(reservation.pk))
    creator.refresh_from_db()
    assert creator.tuzis == 200000
    assert FundingDay.objects.get().incoming_m2z == 0
    with pytest.raises(DatabaseError, match='unbacked'), transaction.atomic():
        usage.credit_with_repay(usage.system_account_id('sys:reservation_clearing'), creator.pk,
            1000, 'refund', 'reservation', str(reservation.pk))


def test_payout_bad_fx_cannot_satisfy_usd_obligation(creator_factory, active):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    with pytest.raises(money.EconomicRefusal, match='fx_evidence'):
        money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment, amount_zec='1.0'))
    assert CreatorPayable.objects.get(creator=creator).balance_nusd == 1_000_000_000


def test_recovery_is_not_negative_creator_owed(creator_factory, active):
    creator = creator_factory(tuzis=0)
    accrue(creator)
    with pytest.raises(money.EconomicRefusal, match='separate_recovery'):
        money.adjust_payable(creator_id=creator.pk, delta_nusd=-1_000_000_001,
            idempotency_key='excess-adjustment', operator='finance:1',
            basis={'contractual_basis': 'refund-clause', 'reason': 'verified reversal', 'source_reference': 'receipt:1'})
    assert CreatorPayable.objects.get(creator=creator).balance_nusd == 1_000_000_000


def test_external_receipt_durable_even_fenced_inactive_and_no_usage_account(creator_factory, active):
    creator = creator_factory(tuzis=0, is_active=False)
    EconomicPolicy.objects.filter(id=True).update(fenced=True)
    receipt = {'provider_reference': 'zec:unreserved', 'captured_at': timezone.now().isoformat(),
               'resolution_reason': 'received_without_authorization'}
    record = money.record_unreserved_funding_receipt(recipient_id=creator.pk, purchaser_id=creator.pk,
        amount_m2z=1000, sale_nusd=10_000_000, idempotency_key='unreserved:1', receipt=receipt)
    assert record.account_id is None and record.recipient_id == creator.pk
    assert record.state == 'resolution' and record.external_receipt == receipt
    assert not PayableJournal.objects.exists()



def test_purchaser_outstanding_authorizations_carry_across_midnight(creator_factory, active, monkeypatch):
    purchaser, first, second = [creator_factory(tuzis=0) for _ in range(3)]
    today = money._today()
    monkeypatch.setattr(money, '_today', lambda: today-timedelta(days=1))
    old = money.reserve_funding(recipient_id=first.pk, purchaser_id=purchaser.pk,
        amount_m2z=1000, sale_nusd=10_000_000_000_000, idempotency_key='old-day-sale')
    monkeypatch.setattr(money, '_today', lambda: today)
    with pytest.raises(money.EconomicRefusal, match='sales_limit'):
        money.reserve_funding(recipient_id=second.pk, purchaser_id=purchaser.pk,
            amount_m2z=1000, sale_nusd=1, idempotency_key='new-day-sale')
    assert money.validate_reserved_funding_for_capture(reservation_id=old.pk).pk == old.pk



def test_legacy_snapshot_immutable_and_adjudication_append_only(creator_factory):
    from dj.apps.economy.models import LegacyClaim, LegacyClaimDecision
    creator = creator_factory(tuzis=100)
    claim = money.snapshot_legacy_claim(creator_id=creator.pk, snapshot_key='snapshot:1',
        evidence={'operator': 'finance:1', 'snapshot_reference': 'backup:1'})
    with pytest.raises(DatabaseError, match='immutable'), transaction.atomic():
        LegacyClaim.objects.filter(pk=claim.pk).update(usage_snapshot_m2z=0, evidence={})
    decision = money.adjudicate_legacy_claim(claim_id=claim.pk, classification='valid_contractual_debt',
        liability_nusd=1_000_000_000, operator='finance:1',
        basis={'legal_basis': 'old-agreement:1', 'source_reference': 'old-earnings:1', 'decision_reference': 'review:1'})
    with pytest.raises(DatabaseError, match='immutable'), transaction.atomic():
        LegacyClaimDecision.objects.filter(pk=decision.pk).update(liability_nusd=0)
    claim.refresh_from_db()
    assert claim.liability_nusd is None and claim.evidence['snapshot_reference']=='backup:1'
    assert claim.decisions.get().liability_nusd==1_000_000_000


def test_signed_payment_fx_and_observation_history_immutable(creator_factory, active):
    from dj.apps.economy.models import PaymentRequest
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    with pytest.raises(DatabaseError, match='evidence immutable'), transaction.atomic():
        PaymentRequest.objects.filter(pk=payment.pk).update(settlement=dict(SETTLEMENT, amount_zec='1'))
    money.record_payment_broadcast(payment_id=payment.pk, observation={'operator': 'staff:2', 'broadcast_reference': 'unknown:1'})
    money.record_payment_broadcast(payment_id=payment.pk, txid='d'*64,
        observation={'operator': 'staff:2', 'broadcast_reference': 'found-original:1'})
    payment.refresh_from_db()
    assert len(payment.settlement['broadcast_observations'])==2
    with pytest.raises(DatabaseError, match='evidence immutable'), transaction.atomic():
        PaymentRequest.objects.filter(pk=payment.pk).update(settlement=dict(SETTLEMENT, broadcast_observations=[]))
    with pytest.raises(DatabaseError, match='evidence immutable'), transaction.atomic():
        PaymentRequest.objects.filter(pk=payment.pk).update(settlement=dict(SETTLEMENT, usd_per_zec='1'))


def test_database_rejects_second_payment_discharge_for_same_broadcast(creator_factory, active):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    money.adjust_payable(creator_id=creator.pk, delta_nusd=2_000_000_000, idempotency_key='more-owed',
        basis={'contractual_basis':'additional-service', 'reason':'verified service', 'source_reference':'receipt:2'}, operator='finance:1')
    money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    money.record_payment_broadcast(payment_id=payment.pk, txid='d'*64,
        observation={'operator':'staff:2', 'broadcast_reference':'broadcast:1'})
    money.confirm_payment(payment_id=payment.pk,evidence={'operator':'fixture-reviewer',
        'chain_reference':'fixture-block','confirmed_txid':'d'*64})
    with pytest.raises(DatabaseError), transaction.atomic():
        PayableJournal.objects.create(account_id=payment.account_id, payment=payment, kind='payment',
            delta_nusd=-payment.amount_nusd, idempotency_key='second-discharge',
            basis={'payment_id':str(payment.pk), 'txid':'d'*64})
    assert PayableJournal.objects.filter(payment=payment).count()==1


def test_preactivation_signed_agreement_prevents_migration_reversal(creator_factory):
    creator = creator_factory(tuzis=0)
    payee = money.register_legal_payee(creator_id=creator.pk, legal_name='Creator LLC', jurisdiction='US-NY',
        verification={'identity_reference':'id:1','authority_reference':'authority:1'}, operator='staff:1')
    agreement = money.accept_agreement(creator_id=creator.pk, legal_payee_id=payee.pk, contract_digest='a'*64,
        acceptance_evidence={'document_reference':money.CONTRACT_VERSION, 'actor_authentication':'login:1','authority_reference':'authority:1'})
    sql('SET CONSTRAINTS ALL IMMEDIATE')
    with pytest.raises(DatabaseError, match='economic history'), transaction.atomic():
        call_command('migrate', 'economy', 'zero', verbosity=0)
    from dj.apps.economy.models import CompensationAgreement
    assert CompensationAgreement.objects.filter(pk=agreement.pk).exists()


def test_signing_refuses_enclosing_application_transaction(creator_factory, active):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    with pytest.raises(RuntimeError, match='durable atomic block'), transaction.atomic():
        money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    payment.refresh_from_db()
    assert payment.state == 'approved' and payment.settlement == {}


def test_adjustments_cannot_consume_held_payment_debt(creator_factory, active):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    basis = {'contractual_basis':'recovery:1', 'reason':'verified correction', 'source_reference':'receipt:1'}
    with pytest.raises(money.EconomicRefusal, match='separate_recovery'):
        money.adjust_payable(creator_id=creator.pk, delta_nusd=-1, idempotency_key='recovery:1', basis=basis, operator='staff:1')
    with pytest.raises(DatabaseError, match='committed payment holds'), transaction.atomic():
        PayableJournal.objects.create(account_id=payment.account_id, kind='adjustment', delta_nusd=-1,
            idempotency_key='sql-recovery', basis=dict(basis, operator='staff:1'))
    account = CreatorPayable.objects.get(pk=payment.account_id)
    assert account.balance_nusd == account.held_nusd == 1_000_000_000


@pytest.mark.parametrize('refusal', ['fence','inactive'])
def test_existing_capture_persists_when_issuance_gates_refuse(creator_factory, active, refusal):
    creator = creator_factory(tuzis=0)
    reservation = money.reserve_funding(recipient_id=creator.pk, purchaser_id=creator.pk,
        amount_m2z=1000, sale_nusd=10_000_000, idempotency_key='late-capture:1')
    if refusal=='fence':
        EconomicPolicy.objects.filter(id=True).update(fenced=True)
    else:
        Creator.objects.filter(pk=creator.pk).update(is_active=False)
    receipt = {'provider_reference':'stripe:captured', 'captured_at':timezone.now().isoformat()}
    result = money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=receipt)
    assert result.state=='resolution' and result.external_receipt==receipt
    assert money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=receipt).pk==result.pk
    from dj.apps.economy.models import PurchaserDay
    assert PurchaserDay.objects.get(purchaser=creator).sold_nusd==10_000_000
    creator.refresh_from_db()
    assert creator.tuzis==0


def test_dispute_debt_restore_preserves_cursor_bounded_rights(creator_factory):
    creator = creator_factory(tuzis=0)
    usage.credit_purchase(creator.pk, 100000, 'stripe', 'stripe_transaction', 'historical-receipt', 'original-purchase')
    usage.spend(creator.pk, 70000, 'ai_chat', idem='historical-spend')
    usage.refund_purchase(creator.pk, 'stripe_transaction', 'historical-receipt', 100000, 'dispute', 'dispute:1')
    activate_for_test()
    # The receipt predates cutover; restorative credits remain attributable.
    from dj.apps.ledger.models import Account
    account = Account.objects.get(owner=creator, kind='user')
    money._funding_day(account, money._today())
    result = usage.restore_purchase(creator.pk, 'stripe_transaction', 'historical-receipt', 0, 'won:1')
    assert (result.restored, result.debt_repaid, result.refunded_m2z)==(30000,70000,0)
    assert usage.restore_purchase(creator.pk, 'stripe_transaction', 'historical-receipt', 0, 'won:1').status=='replayed'
    with pytest.raises(DatabaseError, match='unbacked purchase restoration'), transaction.atomic():
        sql("SELECT * FROM ledger.post_transfer(ledger.sys('sys:clearing_stripe'),%s,1,'restore','stripe_transaction','historical-receipt',NULL,NULL)",[account.pk])


def test_approved_rescreening_appends_before_signing(creator_factory, active, monkeypatch):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    payment.refresh_from_db()
    original = dict(payment.review)
    future = timezone.now()+timedelta(days=2)
    monkeypatch.setattr(money.timezone, 'now', lambda: future)
    fresh = dict(original, reviewer='staff:3', screening_reference='screen:2', screened_at=future.isoformat())
    money.review_payment(payment_id=payment.pk, review=fresh)
    payment.refresh_from_db()
    assert payment.review['rescreening_observations']==[fresh]
    assert {k:v for k,v in payment.review.items() if k!='rescreening_observations'}==original
    money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    with pytest.raises(money.EconomicRefusal, match='not_reviewable'):
        money.review_payment(payment_id=payment.pk, review=dict(fresh, screening_reference='screen:3'))


def test_signing_requires_fresh_quote_and_actual_accepted_method(creator_factory, active):
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    with pytest.raises(money.EconomicRefusal, match='quote_stale'):
        money.begin_payment_signing(payment_id=payment.pk,
            settlement=settlement_for(payment, quoted_at=(timezone.now()-timedelta(minutes=6)).isoformat()))
    with pytest.raises(money.EconomicRefusal, match='authorization_mismatch'):
        money.begin_payment_signing(payment_id=payment.pk,
            settlement=settlement_for(payment, pricing_method_digest='d'*64))


def test_tiny_debt_rounds_up_with_company_expense(creator_factory, active):
    creator = creator_factory(tuzis=0)
    original = approved_payment(creator)
    original.refresh_from_db()
    money.reject_payment(payment_id=original.pk, operator='staff:2', reason='creator chooses smaller amount')
    payment = money.request_payment(creator_id=creator.pk, amount_nusd=100,
        address=ADDRESS, idempotency_key='tiny:1', address_authorization=original.address_authorization)
    money.review_payment(payment_id=payment.pk, review=original.review)
    settlement = settlement_for(payment, amount_zec='0.00000001', usd_satisfaction_nusd='100', rounding_nusd='900')
    money.begin_payment_signing(payment_id=payment.pk, settlement=settlement)
    money.record_payment_broadcast(payment_id=payment.pk, txid='e'*64,
        observation={'operator':'staff:2','broadcast_reference':'tiny-broadcast'})
    money.confirm_payment(payment_id=payment.pk,
        evidence={'operator':'staff:2','chain_reference':'tiny-confirm','confirmed_txid':'e'*64})
    account = CreatorPayable.objects.get(creator=creator)
    assert account.balance_nusd==999_999_900 and account.held_nusd==0
    assert PayableJournal.objects.get(payment=payment).delta_nusd==-100


def test_rejection_evidence_freezes_and_cannot_be_invented_after_signing(creator_factory, active):
    from dj.apps.economy.models import PaymentRequest
    creator = creator_factory(tuzis=0)
    payment = approved_payment(creator)
    money.reject_payment(payment_id=payment.pk, operator='staff:2', reason='actual reason')
    payment.refresh_from_db()
    with pytest.raises(DatabaseError, match='rejection evidence immutable'), transaction.atomic():
        PaymentRequest.objects.filter(pk=payment.pk).update(review=dict(payment.review, rejection={'operator':'staff:3','reason':'rewrite'}))
    with pytest.raises(DatabaseError, match='rejection evidence immutable'), transaction.atomic():
        PaymentRequest.objects.filter(pk=payment.pk).update(review={k:v for k,v in payment.review.items() if k!='rejection'})


@pytest.mark.parametrize('spent,expected_debt', [(70000,70000),(100000,100000)])
def test_historical_dispute_restore_cap_preserves_cursor_or_only_repays_debt(creator_factory, spent, expected_debt):
    from dj.apps.ledger.models import Account, Transfer, PurchaseRefund
    creator = creator_factory(tuzis=0)
    usage.credit_purchase(creator.pk, 100000, 'stripe', 'stripe_transaction', 'prior-day', 'old-purchase')
    usage.spend(creator.pk, spent, 'ai_chat', idem='old-spend')
    usage.refund_purchase(creator.pk, 'stripe_transaction', 'prior-day', 100000, 'dispute', 'old-dispute')
    # Owner-only fixture backdating: emulate persisted previous-UTC-day evidence.
    Transfer.objects.filter(ref_id='prior-day').update(created_at=timezone.now()-timedelta(days=1))
    activate_for_test()
    account = Account.objects.get(owner=creator, kind='user')
    money._funding_day(account, money._today())
    FundingDay.objects.filter(account=account).update(opening_m2z=200_000_000)
    if spent==100000:
        result = usage.restore_purchase(creator.pk, 'stripe_transaction', 'prior-day', 0, 'won-old')
        assert result.debt_repaid==100000 and result.restored==0
    else:
        with pytest.raises(DatabaseError, match='daily_funding_limit'), transaction.atomic():
            usage.restore_purchase(creator.pk, 'stripe_transaction', 'prior-day', 0, 'won-old')
        assert PurchaseRefund.objects.get(ref_id='prior-day').refunded_m2z==100000
        assert Account.objects.get(owner=creator, kind='user_debt').balance==-expected_debt
        resolution = money.record_unreserved_funding_receipt(recipient_id=creator.pk, purchaser_id=creator.pk,
            amount_m2z=100000, sale_nusd=0, idempotency_key='resolution:won-old',
            receipt={'provider_reference':'won-old', 'captured_at':timezone.now().isoformat(),
                'resolution_reason':'usage_daily_funding_limit', 'intent':'dispute_restoration',
                'original_receipt':{'ref_kind':'stripe_transaction','ref_id':'prior-day'}, 'refunded_m2z':100000})
        assert resolution.state=='resolution' and resolution.external_receipt['refunded_m2z']==100000


def test_revoked_prospective_agreement_still_authorizes_vested_debt_payment(creator_factory, active):
    creator = creator_factory(tuzis=0)
    _, agreement, _, admission = make_contract(creator)
    agreement.revoked_at=money._db_now()
    agreement.save(update_fields=['revoked_at'])
    settle_fixture(admission_id=admission.pk, allocated_m2z=100000, delivery_evidence=DELIVERY)
    payment=money.request_payment(creator_id=creator.pk, amount_nusd=1_000_000_000, address=ADDRESS,
        idempotency_key='surviving-debt', address_authorization={'actor_authentication':'recent-login:1',
            'address_reference':'signed-address:1', 'pricing_method_version':'market-spot-v1',
            'pricing_method_digest':'c'*64, 'compensation_agreement_id':agreement.pk,
            'payment_terms_reference':f'{agreement.contract_version}:surviving-payment-terms'})
    assert payment.amount_nusd==1_000_000_000 and payment.state=='requested'


def test_late_capture_after_release_is_preserved_once(creator_factory, active):
    from dj.apps.economy.models import PurchaserDay
    creator=creator_factory(tuzis=0)
    reservation=money.reserve_funding(recipient_id=creator.pk, purchaser_id=creator.pk,
        amount_m2z=1000, sale_nusd=10_000_000, idempotency_key='release-race')
    money.release_funding(reservation_id=reservation.pk, reason='provider timeout')
    receipt={'provider_reference':'captured-after-timeout','captured_at':timezone.now().isoformat()}
    result=money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=receipt)
    assert result.state=='resolution' and result.external_receipt['prior_release']=={'release_reason':'provider timeout'}
    assert result.external_receipt['provider_reference']==receipt['provider_reference']
    assert money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=receipt).pk==result.pk
    day=PurchaserDay.objects.get(purchaser=creator)
    assert day.reserved_nusd==0 and day.sold_nusd==10_000_000
    assert not FundingDay.objects.filter(reserved_m2z__lt=0).exists()


def test_null_allocation_cannot_book_arbitrary_service_debt(creator_factory, active):
    creator=creator_factory(tuzis=0)
    _, _, _, admission=make_contract(creator)
    with pytest.raises(DatabaseError, match='service'), transaction.atomic():
        PayableJournal.objects.create(account_id=admission.account_id, admission=admission,
            idempotency_key='null-allocation', kind='service', allocated_m2z=None, delta_nusd=99999999, basis=DELIVERY)
    assert CreatorPayable.objects.get(creator=creator).balance_nusd==0


def test_legacy_reservation_return_counts_both_debt_and_spendable_legs(creator_factory):
    creator=creator_factory(tuzis=Decimal('1'))
    locked=usage.lock_creator(creator.pk)
    account=usage.lock_account(locked.id, locked.balance)
    usage.post_transfer(account.id, usage.system_account_id('sys:reservation_clearing'),
        1000,'spend','reservation','legacy-mixed')
    usage.clawback(creator.pk,700,'sys:clearing_stripe','clawback','dispute','old','dispute','old-clawback')
    activate_for_test()
    result=usage.credit_user(creator.pk,1000,'sys:reservation_clearing','refund','reservation','legacy-mixed','return-mixed')
    assert result.credited==300 and result.debt_repaid==700
    with pytest.raises(DatabaseError, match='unbacked reservation restoration'), transaction.atomic():
        usage.credit_user(creator.pk,700,'sys:reservation_clearing','refund','reservation','legacy-mixed','duplicate-return')


def test_inactive_creator_cannot_admit_new_work_but_old_debt_survives(creator_factory, active):
    creator=creator_factory(tuzis=0)
    _, agreement, schedule, admission=make_contract(creator)
    Creator.objects.filter(pk=creator.pk).update(is_active=False)
    settle_fixture(admission_id=admission.pk,allocated_m2z=1000,delivery_evidence=DELIVERY)
    with pytest.raises(DatabaseError, match='inactive creator'), transaction.atomic():
        money.admit_service(creator_id=creator.pk,service='livestream_ppv',event_id='inactive-new',
            agreement_id=agreement.pk,schedule_id=schedule.pk,
            source={'source_kind':'livestream','source_id':'meeting:2','authorization_reference':'viewer:2'})
    assert CreatorPayable.objects.get(creator=creator).balance_nusd==10_000_000
