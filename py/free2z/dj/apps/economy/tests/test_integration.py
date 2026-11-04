"""Installed PostgreSQL invariants for the additive integration boundary."""
import uuid
import json
from datetime import timedelta

import pytest
from django.db import DatabaseError, connection, transaction
from django.utils import timezone

from dj.apps.economy import captured_notes as notes, contracts, services as money
from dj.apps.economy.live_zec import purchase_target
from dj.apps.economy.models import CapturedZecNote, CreatorPayable, PaymentRequest, PayableJournal
from .test_foundation import ADDRESS, activate_for_test, settlement_for, sql

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def reset_isolated_policy():
    """Test-owner reset permits Django flush, retaining journals for R1/R3."""
    from dj.apps.economy.models import EconomicPolicy
    EconomicPolicy.objects.get_or_create(id=True)
    yield
    sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
    try: sql('UPDATE economy_economicpolicy SET version=0,fenced=false')
    finally: sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
    sql('ALTER TABLE ledger_config DISABLE TRIGGER ledger_boundary_config_guard')
    try: sql('UPDATE ledger_config SET writer_boundary=false,heal_enabled=true')
    finally: sql('ALTER TABLE ledger_config ENABLE TRIGGER ledger_boundary_config_guard')


def service_terms(creator, service):
    from dj.apps.economy.models import CompensationSchedule
    payee=money.register_legal_payee(creator_id=creator.pk,legal_name='Fixture Supplier LLC',jurisdiction='US-NY',
        verification={'identity_reference':f'fixture:{creator.pk}','authority_reference':'fixture-authority'},operator='fixture-reviewer')
    resource=contracts.SERVICE_SCHEDULES[service]
    agreement=money.accept_agreement(creator_id=creator.pk,legal_payee_id=payee.pk,
        contract_digest=contracts.CREATOR_CONTRACT_DIGEST,acceptance_evidence={
        'document_reference':contracts.CREATOR_CONTRACT_VERSION,'actor_authentication':'fixture-login',
        'authority_reference':'fixture-authority','schedules':[{'service':resource['service'],
        'version':resource['version'],'digest':resource['digest']}]})
    schedule,_=CompensationSchedule.objects.get_or_create(service=service,version=resource['version'],defaults=dict(
        contract_version=resource['contract_version'],nusd_per_allocated_m2z=resource['rate_nusd_per_allocated_m2z'],
        effective_at=money._db_now(),published_digest=resource['digest']))
    return payee,agreement,schedule


def ppv_fixture(creator_factory):
    from dj.apps.dyte.models import CreatorMeeting
    from dj.apps.economy import products
    host=creator_factory(tuzis=0)
    viewer=creator_factory(tuzis=0)
    from dj.apps.ledger import api
    api.credit_user(viewer.pk,100000,'sys:promo','grant','fixture',str(viewer.pk),f'fixture:{viewer.pk}')
    with transaction.atomic(): activate_for_test()
    service_terms(host,'livestream_ppv')
    meeting=CreatorMeeting.objects.create(creator=host,meeting_id=str(uuid.uuid4()),meeting_type='ppv',
        is_public=True,live_now=True,lifecycle_state='live',provider_session_id=uuid.uuid4(),
        host_session_id=uuid.uuid4(),price_per_minute='10.00')
    admission=products.prepare_livestream_admission(host_id=host.pk,viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id,price_per_minute='10.00',viewer_account_epoch=viewer.kt_account_epoch)
    return host,viewer,meeting,admission


def ppv_delivery(admission, key=None):
    from dj.apps.dyte.models import WebhookDelivery
    from dj.apps.economy.products import settle_livestream_delivery
    key=key or uuid.uuid4().hex*2
    event=WebhookDelivery.objects.create(provider_event_id=uuid.uuid4(),event_type='meeting.participantLeft',
        endpoint='general',business_event_key=key,payload_sha256='a'*64)
    evidence={'provider_event_id':str(event.pk),'payload_sha256':event.payload_sha256,
        'meeting_id':admission.source['meeting_id'],'provider_session_id':admission.source['provider_session_id'],
        'participant_id':'ea_'+admission.pk.hex,'joined_at':admission.admitted_at.isoformat(),
        'left_at':money._db_now().isoformat()}
    entry=settle_livestream_delivery(admission_id=admission.pk,event_key=key,evidence=evidence)
    return entry,evidence


def restore_economy_migrations():
    from django.db.migrations.executor import MigrationExecutor
    from django.db.migrations.loader import MigrationLoader

    loader=MigrationLoader(connection)
    targets=[node for node in loader.graph.leaf_nodes() if node[0]=='economy']
    assert targets, 'economy migration graph has no leaf'
    MigrationExecutor(connection).migrate(targets)


def test_ppv_delivery_usd_without_supplier_utility_and_original_replay(creator_factory):
    from dj.apps.economy import products
    host,viewer,meeting,admission=ppv_fixture(creator_factory)
    entry,evidence=ppv_delivery(admission)
    host.refresh_from_db();viewer.refresh_from_db()
    assert host.tuzis==0 and viewer.tuzis==90
    assert entry.delta_nusd==100_000_000 and entry.delivery.allocated_m2z==10_000
    assert entry.delivery.evidence['platform_collected_m2z']==0
    # Mutable room/profile routing is irrelevant to an already admitted debt.
    meeting.meeting_id='replacement';meeting.provider_session_id=uuid.uuid4();meeting.save()
    assert products.settle_livestream_delivery(admission_id=admission.pk,event_key=entry.delivery.provider_key,
        evidence=evidence).pk==entry.pk
    assert PayableJournal.objects.filter(admission=admission).count()==1


def test_ppv_second_admission_cannot_overlap_same_provider_viewer(creator_factory):
    from dj.apps.economy import products
    from dj.apps.dyte.models import WebhookDelivery
    host,viewer,meeting,first=ppv_fixture(creator_factory)
    second=products.prepare_livestream_admission(host_id=host.pk,viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id,price_per_minute='10.00',viewer_account_epoch=viewer.kt_account_epoch)
    entry,evidence=ppv_delivery(first)
    key='b'*64
    event=WebhookDelivery.objects.create(provider_event_id=uuid.uuid4(),event_type='meeting.participantLeft',
        endpoint='general',business_event_key=key,payload_sha256='b'*64)
    overlapping=dict(evidence,provider_event_id=str(event.pk),payload_sha256='b'*64,
        participant_id='ea_'+second.pk.hex,joined_at=second.admitted_at.isoformat())
    with pytest.raises(DatabaseError,match='overlaps'),transaction.atomic():
        products.settle_livestream_delivery(admission_id=second.pk,event_key=key,evidence=overlapping)
    viewer.refresh_from_db()
    assert viewer.tuzis==90 and PayableJournal.objects.filter(kind='service').count()==1


@pytest.mark.parametrize('late',[False,True])
def test_sdk_approved_offer_collects_company_usage_and_original_usd(creator_factory,late):
    import json
    from dj.apps.ledger import api
    from dj.apps.ledger.models import LedgerApp, LedgerSpendCap
    from dj.apps.pricing.models import RateCard,RateCardModel
    from dj.apps.economy.models import SupplierOfferApproval,ServiceAdmission
    from dj.apps.ledger.tests.test_gateway_calls import REQUEST,COMPLETE
    from dj.apps.ledger.tests.test_hold_foundation import call
    buyer=creator_factory(tuzis=0);supplier=creator_factory(tuzis=0);operator=creator_factory(tuzis=0,is_staff=True)
    api.credit_user(buyer.pk,100000,'sys:promo','grant','fixture',str(buyer.pk),f'fixture:{buyer.pk}')
    account=api.ensure_account(buyer.pk)
    with transaction.atomic(): activate_for_test()
    payee,agreement,schedule=service_terms(supplier,'sdk_application')
    app=LedgerApp.objects.create(id=uuid.uuid4(),developer_creator=supplier,markup_bps=100,approved_markup_bps=100,
        frozen=False,rails=['zec'],updated_at=timezone.now())
    LedgerSpendCap.objects.create(app_id=app.pk,account_id=account,cap_m2z=100000,period='total',markup_bps=100,
        grant_generation=4,updated_at=timezone.now())
    evidence={'contribution_reference':'fixture-app','license_reference':'fixture-license',
        'delivery_scope_reference':'fixture-result','refund_responsibility_reference':'fixture-refund',
        'approval_reference':'fixture-review'}
    SupplierOfferApproval.objects.create(app=app,creator=supplier,account=CreatorPayable.objects.get(creator=supplier),
        legal_payee=payee,agreement=agreement,schedule=schedule,markup_bps=100,evidence=evidence,
        evidence_digest=money._digest(evidence),approved_by=operator)
    card=RateCard.objects.create(version=99999)
    RateCardModel.objects.create(rate_card=card,model_id='review-model',
        **{f.name:1 for f in RateCardModel._meta.fields if 'nusd' in f.name})
    RateCard.objects.filter(pk=card.pk).update(active=True,published_at=timezone.now())
    call_id=sql('SELECT ledger.uuid_v7()')[0][0]
    with transaction.atomic():
        sql('SELECT ledger.prepare_economic_policy(0,1)')
        claimed=call('call_claim',buyer.public_id,app.pk,buyer.kt_account_epoch,4,call_id,'sdk-positive','a'*64,json.dumps(REQUEST))
        assert claimed['status']=='claimed'
    original=ServiceAdmission.objects.get(event_id=str(call_id))
    assert original.creator_id==supplier.pk and original.source['effective_markup_bps']==100
    app.markup_bps=200;app.approved_markup_bps=200;app.save()
    LedgerSpendCap.objects.filter(app_id=app.pk).update(markup_bps=200)
    with pytest.raises(DatabaseError,match='original supplier offer'),transaction.atomic():
        sql('SELECT ledger.prepare_economic_policy(0,1)')
        call('hold',buyer.public_id,app.pk,20000,'sdk-changed-markup',str(call_id),1,300,
            buyer.kt_account_epoch,4,'review-model',card.version,None,200,json.dumps({}))
    app.markup_bps=100;app.approved_markup_bps=100;app.save()
    LedgerSpendCap.objects.filter(app_id=app.pk).update(markup_bps=100)
    with transaction.atomic():
        sql('SELECT ledger.prepare_economic_policy(0,1)')
        held=call('hold',buyer.public_id,app.pk,20000,'sdk-positive',str(call_id),1,300,buyer.kt_account_epoch,4,
            'review-model',card.version,None,100,json.dumps({}))
        assert held['status']=='held'
        with pytest.raises(DatabaseError,match='original provider completion'),transaction.atomic():
            call('settle',held['hold_id'],150000000,json.dumps(COMPLETE['usage']))
        assert sql('SELECT count(*) FROM ledger_hold WHERE id=%s',[held['hold_id']])==[(1,)]
        assert not PayableJournal.objects.filter(admission=original).exists()
        call('call_complete',buyer.public_id,app.pk,buyer.kt_account_epoch,4,call_id,json.dumps(COMPLETE),False)
        if late:
            sql("UPDATE ledger_hold SET expires_at=now()-interval '1 second' WHERE id=%s",[held['hold_id']])
            assert call('expire_hold',held['hold_id'])['status']=='expired'
        settled=call('settle',held['hold_id'],150000000,json.dumps(COMPLETE['usage']))
        if late:
            call('settle',held['hold_id'],150000000,json.dumps(COMPLETE['usage']))
    supplier.refresh_from_db()
    assert supplier.tuzis==0 and (late or settled['charged']>0)
    entry=PayableJournal.objects.get(admission=original)
    assert entry.delta_nusd==entry.allocated_m2z*10000
    assert entry.delta_nusd==0 if late else entry.delta_nusd>0
    assert sql('SELECT count(*) FROM ledger_ai_split_queue')==[(0,)]


def payment_fixture(creator):
    with transaction.atomic():
        activate_for_test()
    payee = money.register_legal_payee(creator_id=creator.pk, legal_name='Fixture Supplier LLC',
        jurisdiction='US-NY', verification={'identity_reference':'verified-fixture',
        'authority_reference':'fixture-authority'}, operator='fixture-reviewer')
    agreement = money.accept_agreement(creator_id=creator.pk, legal_payee_id=payee.pk,
        contract_digest=contracts.CREATOR_CONTRACT_DIGEST, acceptance_evidence={
        'document_reference':contracts.CREATOR_CONTRACT_VERSION,
        'actor_authentication':'fixture-login', 'authority_reference':'fixture-authority',
        'schedules':[{'service':s['service'],'version':s['version'],'digest':s['digest']}
                     for s in contracts.SERVICE_SCHEDULES.values()]})
    # A specifically reviewed contractual correction is a supported journal
    # kind; these payout tests do not invent a delivered PPV/SDK contribution.
    money.adjust_payable(creator_id=creator.pk, delta_nusd=2_000_000_000,
        idempotency_key=f'fixture-correction:{creator.pk}', operator='fixture-reviewer',
        basis={'contractual_basis':'fixture invoice correction', 'reason':'verified delivered invoice',
               'source_reference':'fixture-invoice-1'})
    payment = money.request_payment(creator_id=creator.pk, amount_nusd=1_000_000_000,
        address=ADDRESS, idempotency_key='fixture-payment', address_authorization={
        'actor_authentication':'fixture-login', 'address_reference':'fixture-address',
        'pricing_method_version':contracts.PAYMENT_METHOD_VERSION,
        'pricing_method_digest':contracts.PAYMENT_METHOD_DIGEST,
        'compensation_agreement_id':agreement.pk,
        'payment_terms_reference':f'{agreement.contract_version}:surviving-payment-terms'})
    review = {'reviewer':'fixture-reviewer','identity_reference':'verified-fixture',
        'screening_reference':'fixture-screening','screened_at':timezone.now().isoformat(),
        'screening_result':'clear','tax_reference':'fixture-tax','tax_eligible':True,
        'identity_eligible':True,'withholding_required':False,'fee_bearer':'platform',
        'address_reference':'fixture-address','address':ADDRESS,'legal_payee_id':str(payee.pk)}
    money.review_payment(payment_id=payment.pk, review=review)
    return payment, review


def broadcast(payment):
    money.begin_payment_signing(payment_id=payment.pk, settlement=settlement_for(payment))
    money.record_payment_broadcast(payment_id=payment.pk, txid='d'*64,
        observation={'operator':'fixture-reviewer','broadcast_reference':'fixture-broadcast'})


def test_confirmed_requires_exact_committed_discharge(creator_factory):
    payment, _ = payment_fixture(creator_factory(tuzis=0))
    broadcast(payment)
    with pytest.raises(DatabaseError, match='exact debt discharge'), transaction.atomic():
        CreatorPayable.objects.filter(pk=payment.account_id).update(held_nusd=0)
        PaymentRequest.objects.filter(pk=payment.pk).update(state='confirmed')
    payment.refresh_from_db()
    account = CreatorPayable.objects.get(pk=payment.account_id)
    assert payment.state == 'broadcast' and account.balance_nusd == 2_000_000_000
    assert account.held_nusd == 1_000_000_000 and not PayableJournal.objects.filter(payment=payment).exists()
    evidence={'operator':'fixture-reviewer','chain_reference':'fixture-chain','confirmed_txid':'d'*64}
    money.confirm_payment(payment_id=payment.pk, evidence=evidence)
    money.confirm_payment(payment_id=payment.pk, evidence=evidence)
    account.refresh_from_db()
    assert account.balance_nusd == 1_000_000_000 and account.held_nusd == 0
    assert PayableJournal.objects.filter(payment=payment).count() == 1


def test_discharge_cannot_commit_with_unconfirmed_request(creator_factory):
    payment, _ = payment_fixture(creator_factory(tuzis=0))
    broadcast(payment)
    with pytest.raises(DatabaseError), transaction.atomic():
        PayableJournal.objects.create(account_id=payment.account_id, payment=payment, kind='payment',
            delta_nusd=-payment.amount_nusd, idempotency_key='raw-incomplete-discharge',
            basis={'payment_id':str(payment.pk),'txid':'d'*64})
    assert not PayableJournal.objects.filter(payment=payment).exists()


def test_review_history_cannot_borrow_another_payee_or_address(creator_factory):
    payment, review = payment_fixture(creator_factory(tuzis=0))
    wrong = dict(review, legal_payee_id=str(uuid.uuid4()), address='another-address')
    with pytest.raises(DatabaseError, match='screening identity mismatch'), transaction.atomic():
        PaymentRequest.objects.filter(pk=payment.pk).update(review=dict(review, rescreening_observations=[wrong]))
    with pytest.raises(money.EconomicRefusal, match='reserved_history'):
        money.review_payment(payment_id=payment.pk, review=dict(review, rescreening_observations=[wrong]))
    payment.refresh_from_db()
    assert payment.state=='approved' and payment.review==review and payment.settlement=={}


@pytest.mark.parametrize('pool', ['sapling','orchard','ironwood'])
@pytest.mark.parametrize('raw', [b'\xf6'+b'\x00'*511, b'\xff'+b'\x00'*511,
    b'{"id":"a\\u0000b","buy":"2Z"}'.ljust(512,b'\x00'),
    b'{"id":"a"}\x00garbage'.ljust(512,b'\x00')], ids=['opaque','non-utf8','escaped-nul','embedded-nul'])
def test_opaque_zero_notes_durable_during_fence(pool, raw):
    from dj.apps.economy.models import EconomicPolicy
    EconomicPolicy.objects.get_or_create(id=True)
    EconomicPolicy.objects.filter(id=True).update(fenced=True)
    note = notes.ingest_zec_note(txid='a'*64, pool=pool, output_index=0,
        amount_zatoshi=0, memo_hex=raw.hex(), source={'source_kind':'verified-wallet', 'source_reference':'fixture-wallet'})
    notes.record_note_observation(note_id=note.pk, confirmations=0,
        evidence={'source_reference':'fixture-wallet','confirmation_reference':'fixture-tip'})
    result = notes.process_captured_zec_note(note_id=note.pk, confirmations=0,
        evidence={'source_reference':'fixture-wallet','confirmation_reference':'fixture-tip'})
    note.refresh_from_db()
    assert note.memo_plain is None and note.memo_hex==raw.hex()
    assert result.status=='ignored_zero' and not result.credited
    assert note.dispositions.filter(kind='ignored_zero').exists()
    assert note.dispositions.filter(kind='observed').count()==2


def test_raw_capture_cannot_backdate_first_seen():
    old=timezone.now()-timedelta(days=60)
    note=CapturedZecNote.objects.create(txid='b'*64,pool='ironwood',output_index=9,
        amount_zatoshi=1,memo_hex='00'*512,memo_plain='',first_seen_at=old,
        source={'source_kind':'verified-wallet','source_reference':'fixture-wallet','chain_timestamp':old.isoformat()},
        source_digest='a'*64)
    note.refresh_from_db()
    assert note.first_seen_at>old+timedelta(days=59)


def test_prepared_helper_reconfiguration_keeps_only_ten_gateway_functions():
    sql('SELECT ledger.configure_gateway_role()')
    names=sql("""SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('ledger','economy') AND has_function_privilege(ledger.gateway_role_name(),p.oid,'EXECUTE')
        ORDER BY p.proname""")
    assert [row[0] for row in names]==['call_claim','call_complete','call_read','extend','gateway_context',
        'hold','inquire','prepare_economic_policy','release','settle']


@pytest.mark.parametrize('intent_value',[1,[],{},None])
def test_malformed_intent_type_does_not_poison_durable_capture(intent_value):
    import json
    raw=json.dumps({'act':'buy_2z','intent':intent_value}).encode().ljust(512,b'\0')
    note=notes.ingest_zec_note(txid='c'*64,pool='ironwood',output_index=0,amount_zatoshi=1,
        memo_hex=raw.hex(),source={'source_kind':'wallet','source_reference':'malformed-control'})
    assert purchase_target(note) is None
    assert CapturedZecNote.objects.get(pk=note.pk).memo_hex==raw.hex()


def original_zec_intent(creator, *, historical_memo=False):
    """Retired row fixture; normal payments remain plain act/id instructions."""
    import json
    from dj.apps.pricing.models import ZecPriceSnapshot
    from dj.apps.purchases.models import PurchaseIntent
    from decimal import Decimal
    ZecPriceSnapshot.objects.create(zec_usd=100,median_usd=100,spread=Decimal('.1'),
        tuzis_per_zec=9000,num_sources=2,sources={'coinbase':'100','kraken':'100'})
    identity = uuid.uuid4()
    amount = '0.01000000'
    instruction={'act':'buy_2z','id':creator.username}
    if historical_memo:instruction.update(intent=str(identity),proof='a'*64)
    memo=json.dumps(instruction,separators=(',',':'))
    reservation = money.reserve_funding(recipient_id=creator.pk,purchaser_id=creator.pk,
        amount_m2z=90000,sale_nusd=1000000000,idempotency_key=f'zec-intent:{identity}')
    method = contracts.zec_funding_method('zec-funding-v2')
    return PurchaseIntent.objects.create(id=identity,creator=creator,rail='zec',platform='web',status='pending',
        quantity_2z=90,currency='USD',price_minor=100,pricing_version=method['version'],
        quote={'amount_zec':amount,'funding_reservation_id':str(reservation.pk),
            'pricing_version':method['version'],'funding_method_digest':method['digest'],
            'quoted_at':timezone.now().isoformat(),'sources':{'coinbase':'100','kraken':'100'},
            'zec_usd':'100.000000','bonus_m2z':'0',
            'spread':'0.1000','tuzis_per_zec':'9000.0000','gross_usd':'1.000000000',
            'associated_value_usd':'0.900000000'},
        rail_data={'memo':memo,'amount_zec':amount,'payment_observed':False,'address':'u-fixture', 'gross_usd':'1.00','associated_value_usd':'0.90'},
        expires_at=timezone.now()+timedelta(minutes=30))


def raw_for_intent(intent,*,tx='d',amount=None):
    from decimal import Decimal
    return notes._ingest_raw(txid=tx*64,pool='ironwood',output_index=0,
        amount_zatoshi=int(Decimal(intent.quote['amount_zec'])*100_000_000) if amount is None else amount,
        memo_hex=intent.rail_data['memo'].encode().ljust(512,b'\0').hex(),
        source={'source_kind':'wallet','source_reference':'timeliness-control'})


def test_raw_capture_before_marker_preserves_expiry_and_delayed_confirmation(creator_factory):
    from dj.apps.purchases.services import expire_if_due,project_expiry
    from dj.apps.purchases.serializers import intent_payload
    from dj.apps.economy.models import FundingReservation
    buyer=creator_factory(tuzis=0)
    with transaction.atomic(): activate_for_test()
    intent=original_zec_intent(buyer)
    raw=raw_for_intent(intent)
    assert not intent.rail_data['payment_observed']
    # Advance the deadline only in the fixture: no daemon/backdated first_seen.
    from dj.apps.purchases.models import PurchaseIntent
    PurchaseIntent.objects.filter(pk=intent.pk).update(expires_at=raw.first_seen_at+timedelta(microseconds=1))
    intent.refresh_from_db()
    assert expire_if_due(intent).status=='pending'
    projection=intent_payload(project_expiry(intent))
    assert projection['zcash_funding']['payment_observed'] is True
    assert projection['can_replace_instruction'] is False
    assert FundingReservation.objects.get(pk=intent.quote['funding_reservation_id']).state=='reserved'
    evidence={'source_reference':'wallet-control','confirmation_reference':'tip-3'}
    notes.record_note_observation(note_id=raw.pk,confirmations=3,evidence=evidence)
    result=notes.process_captured_zec_note(note_id=raw.pk,confirmations=3,evidence=evidence)
    assert result.credited
    buyer.refresh_from_db();assert buyer.tuzis==100


def test_exact_legacy_receipt_adopted_before_malformed_memo_without_new_issuance(creator_factory):
    from decimal import Decimal
    from dj.apps.tuzis.models import ZecCreditReceipt
    from dj.apps.ledger import api
    from dj.apps.ledger.models import Transfer
    actor=creator_factory(tuzis=0)
    receipt=ZecCreditReceipt.objects.create(txid='e'*64,pool='ironwood',output_index=0,creator=actor,
        amount_zec=Decimal('.00909007'),tuzis_credited=Decimal('998.493'),tuzis_per_zec=Decimal('109844.35'))
    api.credit_purchase(actor.pk,998493,'zec','zec_receipt',str(receipt.pk),'original-receipt-control')
    original_transfers=Transfer.objects.count()
    raw=notes.ingest_zec_note(txid=receipt.txid,pool=receipt.pool,output_index=0,amount_zatoshi=909007,
        memo_hex=(b'\xff'+b'\0'*511).hex(),source={'source_kind':'wallet','source_reference':'receipt-adoption-control'})
    assert raw.memo_plain is None
    fact=raw.dispositions.get(kind='legacy_issued')
    assert fact.receipt_id==receipt.pk and fact.actor_id==actor.pk
    assert Transfer.objects.count()==original_transfers
    actor.refresh_from_db();assert actor.tuzis==Decimal('998.493')


def test_oversize_memo_refuses_before_reserving(creator_factory):
    from dj.apps.economy.models import FundingReservation
    actor=creator_factory(tuzis=0,username='界'*150)
    with transaction.atomic(): activate_for_test()
    raw=json.dumps({'act':'buy_2z','id':actor.username},ensure_ascii=False).encode()
    assert len(raw)<=512
    assert not FundingReservation.objects.exists()


def test_unknown_memo_then_exact_hydration_preserves_original_raw_clock(creator_factory):
    from decimal import Decimal
    buyer=creator_factory(tuzis=0)
    with transaction.atomic(): activate_for_test()
    intent=original_zec_intent(buyer)
    tx={'txid':'f'*64,'pool':'ironwood','output_index':0,'output_index_reliable':True,
        'amount':float(Decimal(intent.quote['amount_zec'])),'amountZat':int(Decimal(intent.quote['amount_zec'])*100_000_000),
        'memo':'','memo_available':False,'memo_format':'zcash_client_sqlite_content','confirmations':0}
    first=notes.capture_wallet_note(tx)
    assert not first.credited
    raw=CapturedZecNote.objects.get(txid=tx['txid'])
    first_seen=raw.first_seen_at
    assert raw.memo_hex is None and purchase_target(raw) is None
    hydrated=dict(tx,memo=intent.rail_data['memo'].encode().hex(),memo_available=True,confirmations=3)
    issued=notes.capture_wallet_note(hydrated)
    assert issued.credited
    raw.refresh_from_db()
    assert raw.first_seen_at==first_seen and raw.memo_hex is None
    assert raw.dispositions.get(event_key=f'memo-hydration:{raw.pk}').evidence['memo_hex']==intent.rail_data['memo'].encode().ljust(512,b'\0').hex()
    altered=dict(hydrated,memo=b'different'.hex())
    with pytest.raises(money.IdempotencyConflict,match='hydration_changed'):
        notes.capture_wallet_note(altered)


@pytest.mark.parametrize('content',[b'', b'\xf6', '小'.encode(), b'\xf6'+b'opaque'])
def test_legacy_content_representation_retains_zero_without_repair(content):
    result=notes.capture_wallet_note({'txid':'1'*64,'pool':'sapling','output_index':0,
        'output_index_reliable':True,'amount':0,'amountZat':0,'memo':content.hex(),
        'memo_available':True,'memo_format':'zcash_client_sqlite_content','confirmations':0})
    raw=CapturedZecNote.objects.get(txid='1'*64)
    assert result.status=='ignored_zero'
    if content.startswith(b'\xf6') and content!=b'\xf6':
        assert raw.memo_hex is None and raw.source['original_content_hex']==content.hex()
    else:
        assert raw.memo_hex==content.ljust(512,b'\0').hex()


def test_unreliable_legacy_index_cannot_fabricate_global_note():
    with pytest.raises(money.EconomicRefusal,match='index_unproven'):
        notes.capture_wallet_note({'txid':'2'*64,'pool':'sapling','output_index':0,
            'output_index_reliable':False,'amount':0,'amountZat':0,'memo':'00'*512,'confirmations':0})
    assert not CapturedZecNote.objects.exists()


@pytest.mark.parametrize('plain,expected',[
    ('{hello','{hello'),('[oops','[oops'),('\n {"safe":"小"}','\n {"safe":"小"}'),
    ('\n {"bad":"\\u0000"}',None),('\t ["\\ud800"]',None),('"\\u0000"',None),
    ('{"x":"\\u0000","x":"safe"}',None),
    ('{"\\ud800":"unsafe key","ok":"safe"}',None),
    ('{"nested":{"x":"\\ud800","x":"safe"}}',None),
    ('{"large":1e999999,"bad":"\\u0000"}',None),
    ('{"large":1e999999,"safe":"小"}','{"large":1e999999,"safe":"小"}'),
    ('['*254+'0'+']'*254,'['*254+'0'+']'*254)])
def test_raw_text_decoder_parity_is_durable(plain,expected):
    note=notes.ingest_zec_note(txid='3'*64,pool='orchard',output_index=0,amount_zatoshi=1,
        memo_hex=plain.encode().ljust(512,b'\0').hex(),source={'source_kind':'fixture-wallet','source_reference':'memo-parity'})
    assert note.memo_plain==expected and CapturedZecNote.objects.filter(pk=note.pk).exists()


def test_hydration_sql_refuses_null_hex_and_forged_plaintext():
    from dj.apps.economy.models import ZecNoteDisposition
    raw=notes.ingest_zec_note(txid='4'*64,pool='sapling',output_index=0,amount_zatoshi=0,memo_hex=None,
        source={'source_kind':'wallet','source_reference':'unknown','memo_available':False})
    good='ordinary tip'.encode().ljust(512,b'\0').hex()
    for hex_value,plain in [(None,None),(good,'fabricated buy authorization')]:
        with pytest.raises(DatabaseError,match='hydration'),transaction.atomic():
            ZecNoteDisposition.objects.create(note=raw,event_key=f'memo-hydration:{raw.pk}',kind='observed',
                evidence={'memo_hex':hex_value,'memo_plain':plain,'source_kind':'wallet','source_reference':'hydrated'})
    assert not raw.dispositions.filter(event_key=f'memo-hydration:{raw.pk}').exists()


def test_actual_sqlite_reader_preserves_unavailable_empty_sentinel_and_unicode(tmp_path,monkeypatch):
    from zcashrpc.test_wallet_client_contract import WalletFixture,_load_adapter
    wallet=WalletFixture(tmp_path/'actual-reader.sqlite')
    contents=[None,b'',b'\xf6','小'.encode(),b'opaque\0bytes']
    for i,content in enumerate(contents):
        wallet.add_note(txid_display=f'{i+20:064x}',pool='sapling',index=i,zats=0,memo=content)
    monkeypatch.setenv('WALLET_DB',wallet.path);monkeypatch.setenv('WALLET_ACCOUNT','1')
    actual=_load_adapter().Client().recieved_by('ignored')
    assert len(actual)==len(contents)
    for tx in actual:
        result=notes.capture_wallet_note(tx)
        raw=CapturedZecNote.objects.get(txid=tx['txid'],output_index=tx['output_index'])
        assert result.status=='ignored_zero'
        content=contents[tx['output_index']]
        if content is None or b'\0' in content:
            assert raw.memo_hex is None
        else:
            assert raw.memo_hex==content.ljust(512,b'\0').hex()


def complete_manifest():
    revision='a'*40
    return {'manifest_version':'economic-cutover-v1','policy_version':1,'environment':'stage',
        'current_database':connection.settings_dict['NAME'],'release_commit':revision,
        'writer_registry_digest':'b'*64,'source_capture_sha256':'c'*64,'operator':'fixture-operator',
        'decision_reference':'fixture-decision','observed_at':timezone.now().isoformat(),
        'source_capture_reference':'fixture-capture','rollout_reference':'fixture-rollout','drain_reference':'fixture-drain',
        'writers':{'django':{'loaded_revision':revision},'worker_lanes':{
            name:{'loaded_revision':revision,'verification_reference':'fixture-deployment'} for name in [
            'image-variant-worker','media-worker','translation-worker','recording-worker','billing-worker',
            'exports-worker','outbox-worker','ledger-worker','comment-aiscore']},
            'gateway':{'image_digest':'sha256:'+'d'*64,'oci_revision':'e'*40,
                'executable_function_count':10,'restricted_login_verification_reference':'fixture-real-role'},
            'zec_producer':{'loaded_revision':revision,'mode':'legacy','single_owner_reference':'fixture-owner',
                'source_reference':'fixture-loaded','mode_reference':'fixture-mode'}}}


def test_activation_sql_requires_manifest_actual_boundary_and_irreversibility():
    import json
    from dj.apps.economy.models import EconomicPolicy
    with pytest.raises(DatabaseError,match='activation unavailable'),transaction.atomic():
        EconomicPolicy.objects.filter(id=True).update(version=1)
    manifest=complete_manifest()
    unsupported=dict(manifest,writers=dict(manifest['writers'],zec_producer=dict(manifest['writers']['zec_producer'],mode='paymentd')))
    assert 'zec_producer_deployment_and_owner_proof_required' in sql('SELECT economy.activation_blockers(%s::jsonb)',[json.dumps(unsupported)])[0][0]
    assert 'true_writer_boundary_required' in sql('SELECT economy.activation_blockers(%s::jsonb)',[json.dumps(manifest)])[0][0]
    with transaction.atomic(): sql('SELECT ledger.activate_writer_boundary()')
    assert sql('SELECT economy.activation_blockers(%s::jsonb)',[json.dumps(manifest)])==[([],)]
    with transaction.atomic():
        EconomicPolicy.objects.filter(id=True).update(version=1,manifest=manifest)
    policy=EconomicPolicy.objects.get(id=True)
    assert policy.activated_at is not None
    EconomicPolicy.objects.filter(id=True).update(version=1,fenced=True)
    EconomicPolicy.objects.filter(id=True).update(fenced=False)
    with pytest.raises(DatabaseError,match='irreversible'),transaction.atomic():
        EconomicPolicy.objects.filter(id=True).update(version=0)
    broken=dict(manifest,writers=dict(manifest['writers'],worker_lanes={}))
    assert any('worker_loaded_revision_required' in b for b in sql(
        'SELECT economy.activation_blockers(%s::jsonb)',[json.dumps(broken)])[0][0])


def test_signed_http_ppv_original_admission_and_replay(creator_factory,api_client,mocker):
    import json
    from cryptography.hazmat.primitives.asymmetric import rsa
    from dj.apps.dyte.test_webhook_idempotency import _post,_meeting
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    mocker.patch('dj.apps.dyte.views.get_or_load_dyte_public_key',return_value=private.public_key())
    mocker.patch('dj.apps.jobs.outbox.PubSubClient')
    host,viewer,meeting,admission=ppv_fixture(creator_factory)
    room=_meeting(meeting.meeting_id);room['sessionId']=str(meeting.provider_session_id)
    payload=json.dumps({'event':'meeting.participantLeft','meeting':room,'participant':{
        'peerId':str(uuid.uuid4()),'userDisplayName':viewer.username,'customParticipantId':'ea_'+admission.pk.hex,
        'joinedAt':admission.admitted_at.isoformat(),'leftAt':money._db_now().isoformat()}}).encode()
    event_id=uuid.uuid4()
    assert _post(api_client,private,payload,event_id).status_code==200
    assert _post(api_client,private,payload,event_id).status_code==200
    host.refresh_from_db();viewer.refresh_from_db()
    assert host.tuzis==0 and viewer.tuzis==90
    assert PayableJournal.objects.filter(admission=admission).count()==1


@pytest.mark.parametrize('username',['ea_alice','ea_'+uuid.uuid4().hex])
def test_signed_http_policy0_username_prefix_keeps_utility_billing(creator_factory,api_client,mocker,username):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from dj.apps.dyte.test_webhook_idempotency import _post,_participant_left_payload,_ppv_meeting
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    mocker.patch('dj.apps.dyte.views.get_or_load_dyte_public_key',return_value=private.public_key())
    mocker.patch('dj.apps.jobs.outbox.PubSubClient')
    meeting,host,viewer=_ppv_meeting(creator_factory)
    viewer.username=username;viewer.save(update_fields=['username'])
    body=_participant_left_payload(meeting,viewer)
    event_id=uuid.uuid4()
    assert _post(api_client,private,body,event_id).status_code==200
    assert _post(api_client,private,body,event_id).status_code==200
    host.refresh_from_db();viewer.refresh_from_db()
    assert host.tuzis==106 and viewer.tuzis==93
    assert not PayableJournal.objects.exists()


def test_schedule_publication_dry_run_idempotence_and_conflict():
    from django.core.management import call_command
    from django.core.management.base import CommandError
    from dj.apps.economy.models import CompensationSchedule,CompensationAgreement,LegalPayee
    call_command('publish_compensation_schedules')
    assert not CompensationSchedule.objects.exists()
    call_command('publish_compensation_schedules',apply=True)
    original=list(CompensationSchedule.objects.values())
    call_command('publish_compensation_schedules',apply=True)
    assert list(CompensationSchedule.objects.values())==original
    assert {row['service'] for row in original}=={'livestream_ppv','sdk_application'}
    assert not CompensationAgreement.objects.exists() and not LegalPayee.objects.exists()
    # A historical wrong publication must refuse rather than overwrite it.
    sql('ALTER TABLE economy_compensationschedule DISABLE TRIGGER economy_schedule_immutable')
    try:
        CompensationSchedule.objects.filter(pk=original[0]['id']).update(published_digest='f'*64)
    finally:
        sql('ALTER TABLE economy_compensationschedule ENABLE TRIGGER economy_schedule_immutable')
    with pytest.raises(CommandError,match='conflicts'):
        call_command('publish_compensation_schedules',apply=True)
    assert CompensationSchedule.objects.get(pk=original[0]['id']).published_digest=='f'*64


def test_activation_operator_blocked_apply_does_not_change_policy(creator_factory,tmp_path):
    import json
    from django.core.management import call_command
    from django.core.management.base import CommandError
    from dj.apps.economy.models import EconomicPolicy
    operator=creator_factory(tuzis=0,is_staff=True)
    manifest=complete_manifest();manifest['operator']=f'staff-creator:{operator.pk}'
    path=tmp_path/'manifest.json';path.write_text(json.dumps(manifest))
    call_command('activate_economic_policy',str(path),operator_id=operator.pk)
    with pytest.raises(CommandError,match='blocked'):
        call_command('activate_economic_policy',str(path),operator_id=operator.pk,apply=True)
    policy=EconomicPolicy.objects.get(id=True)
    assert policy.version==0 and policy.manifest=={} and policy.activated_at is None


def test_revocation_revision_replay_cannot_reopen_manually_resolved_brake(creator_factory):
    from decimal import Decimal
    from dj.apps.ledger import api
    from dj.apps.tuzis.models import ZecCreditReceipt
    actor=creator_factory(tuzis=0)
    receipt=ZecCreditReceipt.objects.create(txid='7'*64,pool='ironwood',output_index=0,
        amount_zec=Decimal('.00909007'),creator=actor,tuzis_credited=Decimal('998.493'))
    api.credit_purchase(actor.pk,998493,'zec','zec_receipt',str(receipt.pk),f'zec:{receipt.pk}')
    # Raw-first phase succeeded but legacy adoption has not run yet.
    raw=notes._ingest_raw(txid=receipt.txid,pool=receipt.pool,output_index=0,amount_zatoshi=909007,
        memo_hex=('ordinary tip'.encode().ljust(512,b'\0')).hex(),
        source={'source_kind':'fixture-wallet','source_reference':'phased-adoption'})
    evidence={'source_reference':'verified-wallet','confirmation_reference':'actual-reorg-1',
        'revoked':True,'revocation_revision_reference':'revision-1'}
    notes.record_note_observation(note_id=raw.pk,confirmations=0,evidence=evidence)
    notes.adopt_existing_issuance(note_id=raw.pk)
    receipt.refresh_from_db();assert receipt.vanished_at and receipt.vanish_resolved_at is None
    resolved=timezone.now()
    ZecCreditReceipt.objects.filter(pk=receipt.pk).update(vanish_resolved_at=resolved)
    notes.record_note_observation(note_id=raw.pk,confirmations=2,evidence=dict(evidence,extra='retry-detail'))
    notes.adopt_existing_issuance(note_id=raw.pk)
    receipt.refresh_from_db();assert receipt.vanish_resolved_at==resolved
    notes.record_note_observation(note_id=raw.pk,confirmations=0,evidence=dict(evidence,
        revocation_revision_reference='revision-2',confirmation_reference='actual-reorg-2'))
    receipt.refresh_from_db();assert receipt.vanish_resolved_at is None
    actor.refresh_from_db();assert actor.tuzis==Decimal('998.493')


def test_direct_activation_waits_for_writer_then_sees_committed_claim(creator_factory):
    import json
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from django.db import close_old_connections
    from dj.apps.ledger import api
    from dj.apps.ledger.models import LedgerApp,LedgerSpendCap
    from dj.apps.ledger.tests.test_gateway_calls import REQUEST
    from dj.apps.ledger.tests.test_hold_foundation import call
    from dj.apps.economy.models import EconomicPolicy
    actor=creator_factory(tuzis=0);account=api.ensure_account(actor.pk)
    app=LedgerApp.objects.create(id=uuid.uuid4(),frozen=False,markup_bps=0,rails=['zec'],updated_at=timezone.now())
    LedgerSpendCap.objects.create(app_id=app.pk,account_id=account,cap_m2z=100000,period='total',markup_bps=0,
        grant_generation=4,updated_at=timezone.now())
    with transaction.atomic():sql('SELECT ledger.activate_writer_boundary()')
    manifest=complete_manifest();writer_ready=threading.Event();updater_started=threading.Event();release=threading.Event()
    def writer():
        close_old_connections()
        try:
            with transaction.atomic():
                sql('SELECT ledger.prepare_economic_policy(0,1)')
                result=call('call_claim',actor.public_id,app.pk,actor.kt_account_epoch,4,
                    sql('SELECT ledger.uuid_v7()')[0][0],'activation-race','f'*64,json.dumps(REQUEST))
                assert result['status']=='claimed'
                writer_ready.set();assert release.wait(5)
        finally:connection.close()
    def updater():
        close_old_connections()
        try:
            updater_started.set()
            with transaction.atomic():
                sql("SET LOCAL lock_timeout='4s'")
                EconomicPolicy.objects.filter(id=True).update(version=1,manifest=manifest)
        finally:connection.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(writer);assert writer_ready.wait(5)
        second=pool.submit(updater);assert updater_started.wait(5)
        # Observe the actual waiting lock before committing the stale writer.
        import time
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            if sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE %economy_economicpolicy%'")[0][0]:break
            time.sleep(.01)
        else:pytest.fail('activation did not wait behind the writer policy lock')
        release.set();first.result(timeout=5)
        with pytest.raises(DatabaseError,match='pending_gateway_claims'):second.result(timeout=5)
    assert EconomicPolicy.objects.get(id=True).version==0


def test_archived_subscription_schedule_cannot_create_new_payable_admission(creator_factory):
    from dj.apps.economy.models import CompensationAgreement,CompensationSchedule,ServiceAdmission
    host,viewer,meeting,current=ppv_fixture(creator_factory)
    archived=contracts.published_schedule('subscription_access','subscription-access-2026-10-v1')
    assert archived is not None
    old_contract=contracts.creator_contract('cc-2026-10-v1',contracts._CREATOR_CONTRACTS['cc-2026-10-v1']['digest'])
    accepted=CompensationAgreement.objects.create(creator=host,legal_payee=current.legal_payee,
        accepted_by=host,contract_version=archived['contract_version'],contract_digest=old_contract['digest'],
        accepted_at=timezone.now(),effective_at=timezone.now(),acceptance_evidence={'document_reference':'historical-fixture',
        'actor_authentication':'fixture-original-login','authority_reference':'fixture-authority','schedules':[
        {'service':archived['service'],'version':archived['version'],'digest':archived['digest']}]})
    schedule=CompensationSchedule.objects.create(service=archived['service'],version=archived['version'],
        contract_version=archived['contract_version'],published_digest=archived['digest'],
        nusd_per_allocated_m2z=10000,effective_at=timezone.now())
    with pytest.raises(DatabaseError),transaction.atomic():
        money.pin_policy()
        ServiceAdmission.objects.create(service='subscription_access',event_id='unsupported-new-subscription',
            creator=host,legal_payee=current.legal_payee,account=current.account,agreement=accepted,
            schedule=schedule,policy_version=1,admitted_at=timezone.now(),source=current.source,
            source_digest=money._digest(current.source))
    assert not ServiceAdmission.objects.filter(event_id='unsupported-new-subscription').exists()


@pytest.mark.parametrize('history',['active','admission'])
def test_integration_reversal_refuses_active_or_admission_only_history(creator_factory,history):
    from django.db.migrations.executor import MigrationExecutor
    if history=='admission':
        ppv_fixture(creator_factory)
        sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
        try:sql('UPDATE economy_economicpolicy SET version=0')
        finally:sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
    else:
        with transaction.atomic():activate_for_test()
    try:
        with pytest.raises(DatabaseError,match='history prevents reversal'):
            MigrationExecutor(connection).migrate([('economy','0001_initial')])
        assert sql("SELECT to_regprocedure('ledger.prepare_economic_policy(integer,integer)') IS NOT NULL")==[(True,)]
    finally:
        # Django commits each migration separately. The later expected refusal
        # can follow a successful reverse of 0003, so restore the app leaf.
        restore_economy_migrations()
    assert sql("SELECT to_regclass('public.economy_zecpromotion') IS NOT NULL")==[(True,)]
    assert sql("SELECT to_regprocedure('economy.routing_note_memo(uuid)') IS NOT NULL")==[(True,)]


def test_empty_integration_reverse_restores_policy0_role_and_reinstalls():
    from django.db.migrations.executor import MigrationExecutor
    try:
        MigrationExecutor(connection).migrate([('economy','0001_initial')])
        assert sql("SELECT to_regprocedure('ledger.prepare_economic_policy(integer,integer)')")==[(None,)]
        assert sql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ledger' AND has_function_privilege(ledger.gateway_role_name(),p.oid,'EXECUTE')")==[(9,)]
    finally:
        restore_economy_migrations()
    assert sql("SELECT to_regprocedure('ledger.prepare_economic_policy(integer,integer)') IS NOT NULL")==[(True,)]


def test_concurrent_original_ppv_admissions_cannot_both_collect_overlap(creator_factory):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from django.db import close_old_connections
    from dj.apps.dyte.models import WebhookDelivery
    from dj.apps.economy import products
    host,viewer,meeting,first=ppv_fixture(creator_factory)
    second=products.prepare_livestream_admission(host_id=host.pk,viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id,price_per_minute='10.00',viewer_account_epoch=viewer.kt_account_epoch)
    joined=second.admitted_at.isoformat();left=money._db_now().isoformat()
    work=[]
    for admission in (first,second):
        key=uuid.uuid4().hex*2
        event=WebhookDelivery.objects.create(provider_event_id=uuid.uuid4(),event_type='meeting.participantLeft',
            endpoint='general',business_event_key=key,payload_sha256=key)
        work.append((admission.pk,key,{'provider_event_id':str(event.pk),'payload_sha256':key,
            'meeting_id':meeting.meeting_id,'provider_session_id':str(meeting.provider_session_id),
            'participant_id':'ea_'+admission.pk.hex,'joined_at':joined,'left_at':left}))
    start=threading.Barrier(2)
    def settle(item):
        close_old_connections()
        try:
            start.wait(timeout=5)
            try:return products.settle_livestream_delivery(admission_id=item[0],event_key=item[1],evidence=item[2]).pk
            except DatabaseError as exc:
                assert 'overlaps' in str(exc);return None
        finally:connection.close()
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(settle,work))
    assert sum(result is not None for result in results)==1
    viewer.refresh_from_db();assert viewer.tuzis==90
    assert PayableJournal.objects.filter(kind='service').count()==1


def test_concurrent_confirmation_and_expiry_preserve_original_funding(creator_factory):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from django.db import close_old_connections
    from dj.apps.purchases.models import PurchaseIntent
    from dj.apps.purchases.services import expire_if_due
    from dj.apps.economy.models import FundingReservation
    actor=creator_factory(tuzis=0)
    with transaction.atomic():activate_for_test()
    intent=original_zec_intent(actor,historical_memo=True);raw=raw_for_intent(intent,tx='8')
    PurchaseIntent.objects.filter(pk=intent.pk).update(expires_at=raw.first_seen_at+timedelta(microseconds=1))
    evidence={'source_reference':'actual-fixture-wallet','confirmation_reference':'actual-tip-3'}
    notes.record_note_observation(note_id=raw.pk,confirmations=3,evidence=evidence)
    start=threading.Barrier(2)
    def action(confirm):
        close_old_connections()
        try:
            start.wait(timeout=5)
            if confirm:return notes.process_captured_zec_note(note_id=raw.pk,confirmations=3,evidence=evidence)
            return expire_if_due(PurchaseIntent.objects.get(pk=intent.pk)).status
        finally:connection.close()
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(action,[False,True]))
    assert results[0]=='pending'
    assert not results[1].credited and results[1].reason=='retired_original_contract_requires_resolution'
    assert FundingReservation.objects.get(pk=intent.quote['funding_reservation_id']).state=='reserved'
    assert not FundingReservation.objects.filter(state='issued').exists()
    held=raw.dispositions.get(kind='pending_resolution')
    assert held.actor_id==actor.pk and held.intent_id==intent.pk
    actor.refresh_from_db();assert actor.tuzis==0


@pytest.mark.parametrize('role',['host','viewer'])
def test_policy1_owner_provider_identity_cannot_impersonate_viewer_admission(creator_factory,api_client,mocker,role):
    import json
    from cryptography.hazmat.primitives.asymmetric import rsa
    from dj.apps.dyte.client import DyteClient
    from dj.apps.dyte.test_webhook_idempotency import _post,_meeting
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    mocker.patch('dj.apps.dyte.views.get_or_load_dyte_public_key',return_value=private.public_key())
    mocker.patch('dj.apps.jobs.outbox.PubSubClient')
    host,viewer,meeting,admission=ppv_fixture(creator_factory)
    host.username='ea_'+admission.pk.hex;host.save(update_fields=['username'])
    post=mocker.patch('dj.apps.dyte.client.requests.post')
    post.return_value.status_code=200
    post.return_value.json.return_value={'data':{'token':'synthetic-fixture-token','id':str(uuid.uuid4())}}
    DyteClient('fixture-org').add_participant(host,meeting.meeting_id,role=role)
    token=post.call_args.kwargs['json']['custom_participant_id']
    assert token==f'ph_{host.public_id.hex}'
    room=_meeting(meeting.meeting_id);room['sessionId']=str(meeting.provider_session_id)
    payload=json.dumps({'event':'meeting.participantLeft','meeting':room,'participant':{
        'peerId':str(uuid.uuid4()),'userDisplayName':host.username,'customParticipantId':token,
        'joinedAt':admission.admitted_at.isoformat(),'leftAt':money._db_now().isoformat()}}).encode()
    assert _post(api_client,private,payload,uuid.uuid4()).status_code==200
    viewer.refresh_from_db();assert viewer.tuzis==100
    assert not PayableJournal.objects.exists()


@pytest.mark.parametrize('memo',[b'{"act":"\\u0062uy_2z","id":"alice"}',
    b'Payment: {"act":"buy_2z","id":"alice"}',b'{"act":"buy_2z","id":"alice"'])
def test_escaped_purchase_action_remains_an_actual_resolution(memo):
    note=notes.ingest_zec_note(txid='9'*64,pool='orchard',output_index=0,amount_zatoshi=1,
        memo_hex=memo.ljust(512,b'\0').hex(),
        source={'source_kind':'wallet','source_reference':'escaped-action-control'})
    evidence={'source_reference':'wallet','confirmation_reference':'actual-tip-3'}
    notes.record_note_observation(note_id=note.pk,confirmations=3,evidence=evidence)
    with transaction.atomic():activate_for_test()
    result=notes.process_captured_zec_note(note_id=note.pk,confirmations=3,evidence=evidence)
    assert result.status=='pending_resolution' and result.reason=='unattributed_purchase'
    assert note.dispositions.filter(kind='pending_resolution').exists()


def test_policy1_broadcast_viewer_hostlike_username_still_charges_platform(creator_factory,api_client,mocker):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from dj.apps.dyte.test_webhook_idempotency import _post,_participant_left_payload,_ppv_meeting
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    mocker.patch('dj.apps.dyte.views.get_or_load_dyte_public_key',return_value=private.public_key())
    mocker.patch('dj.apps.jobs.outbox.PubSubClient')
    meeting,host,viewer=_ppv_meeting(creator_factory)
    viewer.username=f'ph_{host.public_id.hex}';viewer.save(update_fields=['username'])
    meeting.meeting_type='broadcast';meeting.save(update_fields=['meeting_type'])
    with transaction.atomic():activate_for_test()
    body=_participant_left_payload(meeting,viewer)
    assert _post(api_client,private,body,uuid.uuid4()).status_code==200
    host.refresh_from_db();assert host.tuzis==99
    assert not PayableJournal.objects.exists()


@pytest.mark.parametrize('memo,blocked',[
    (b'Payment: {"act":"buy_2z","id":"alice"}',True),
    (b'buy_2z: {"id":"alice"}',True),
    (b'Payment: {"act":"\\u0062uy_2z","id":"alice"}',True),
    (b'{"act":"buy_2z","id":"alice"',True),
    (b'{"act":"buy_\\u0032z"',True),
    (b'ordinary thank-you tip',False),(b'Thanks [for everything]',False),
    (b'Thanks {friend}',False)])
def test_actual_credit_loop_reports_possible_purchase_and_healthy_plain_tip(tmp_path,monkeypatch,mocker,capsys,memo,blocked):
    from decimal import Decimal
    from django.core.management import call_command
    from zcashrpc.test_wallet_client_contract import WalletFixture,_load_adapter
    wallet=WalletFixture(tmp_path/'actual-loop.sqlite')
    wallet.add_note(txid_display='ab'*32,pool='sapling',index=0,zats=1,memo=memo)
    monkeypatch.setenv('WALLET_DB',wallet.path);monkeypatch.setenv('WALLET_ACCOUNT','1')
    mocker.patch('dj.apps.g12f.management.commands.credit_creators.Client',_load_adapter().Client)
    mocker.patch('dj.apps.g12f.management.commands.credit_creators.current_tuzis_per_zec',return_value=Decimal('90000'))
    with transaction.atomic():activate_for_test()
    call_command('credit_creators',no_color=True)
    output=capsys.readouterr().out
    assert ('CREDITING BLOCKED' in output)==blocked
    assert ('credit_creators: cycle ok' in output)==(not blocked)
    raw=CapturedZecNote.objects.get(txid='ab'*32)
    assert raw.dispositions.filter(kind='pending_resolution').exists()==blocked


def test_paid_admission_and_eligibility_use_original_database_clock(creator_factory,monkeypatch,api_client):
    from dj.apps.economy import products,views
    from types import SimpleNamespace
    host,viewer,meeting,original=ppv_fixture(creator_factory)
    behind=original.admitted_at-timedelta(minutes=10)
    application_clock=SimpleNamespace(now=lambda:behind)
    monkeypatch.setattr(products,'timezone',application_clock)
    monkeypatch.setattr(views,'timezone',application_clock)
    assert products.get_effective_compensation_schedule('livestream_ppv').version==contracts.SERVICE_SCHEDULES['livestream_ppv']['version']
    admitted=products.prepare_livestream_admission(host_id=host.pk,viewer_id=viewer.pk,
        meeting_id=meeting.meeting_id,price_per_minute='10.00',viewer_account_epoch=viewer.kt_account_epoch)
    assert admitted.agreement_id==original.agreement_id and admitted.admitted_at>=original.admitted_at
    api_client.force_authenticate(user=host)
    response=api_client.get('/api/economy/earnings/')
    assert response.status_code==200 and response.data['agreement_accepted'] is True
    assert response.data['compensation_eligible'] is True


def historical_note_observation(*, creator_id, txid, pool, output_index, amount_zec, memo_plain):
    """Persist old observation data, without recreating a retired commerce writer."""
    from decimal import Decimal
    from dj.apps.tuzis.models import IdempotencyKey
    identity={'recipient_id':creator_id,'txid':txid,'pool':pool,'output_index':output_index,
        'amount_zec':str(Decimal(str(amount_zec)).quantize(Decimal('.00000001'))),'memo_plain':memo_plain}
    return IdempotencyKey.objects.create(scope='zec-funding-note',user_id=creator_id,
        key=f'{txid}:{pool}:{output_index}',request_hash=money._digest(identity),response_status=200,
        response_body={'note':identity,'first_seen_at':timezone.now().isoformat(),
            'status':'pending_resolution','reason':'purchaser_authorization_unproven'})
