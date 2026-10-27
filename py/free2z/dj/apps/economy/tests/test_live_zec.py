"""Real PostgreSQL confirmed-value purchases without UI purchase intents."""
import json
from decimal import Decimal
from datetime import timedelta
import pytest
from django.db import DatabaseError, transaction
from django.utils import timezone
from dj.apps.economy import captured_notes as notes, services as money
from dj.apps.economy.models import FundingReservation, ZecNoteDisposition
from dj.apps.economy.tests.test_integration import reset_isolated_policy, original_zec_intent  # noqa: F401
from dj.apps.economy.tests.test_foundation import activate_for_test
from dj.apps.events.models import Event
from dj.apps.pricing.models import ZecPriceSnapshot
from dj.apps.purchases.models import PurchaseIntent
from dj.apps.tuzis.models import ZecCreditReceipt
from dj.apps.ledger.models import Transfer
pytestmark=pytest.mark.django_db(transaction=True)
EVIDENCE={'source_reference':'verified-wallet','confirmation_reference':'verified-tip'}


def price(usd=100):
    usd=Decimal(str(usd))
    return ZecPriceSnapshot.objects.create(zec_usd=usd,median_usd=usd,spread=Decimal('.1'),
        tuzis_per_zec=usd*90,num_sources=2,sources={'coinbase':str(usd),'kraken':str(usd)})


def receive(creator,tx='a',zatoshis=1_000_000,memo=None):
    memo=memo if memo is not None else json.dumps({'act':'buy_2z','id':creator.username},separators=(',',':'))
    note=notes.ingest_zec_note(txid=tx*64,pool='orchard',output_index=0,amount_zatoshi=zatoshis,
        memo_hex=memo.encode().ljust(512,b'\0').hex(),source={'source_kind':'verified-wallet','source_reference':'verified-wallet'})
    notes.record_note_observation(note_id=note.pk,confirmations=0,evidence=EVIDENCE)
    return note


def process(note,confirmations=3,**kwargs):
    notes.record_note_observation(note_id=note.pk,confirmations=confirmations,evidence=EVIDENCE)
    return notes.process_captured_zec_note(note_id=note.pk,confirmations=confirmations,evidence=EVIDENCE,**kwargs)


@pytest.fixture
def buyer(creator_factory):
    creator=creator_factory(tuzis=0)
    with transaction.atomic(): activate_for_test()
    return creator


@pytest.mark.parametrize('amount',[500_000,1_000_000,2_000_000])
def test_actual_partial_or_extra_value_uses_processing_price_once(buyer,amount):
    price(100); note=receive(buyer,zatoshis=amount); before=Transfer.objects.count()
    for confirmations in [0,1,2]: assert not process(note,confirmations).credited
    assert Transfer.objects.count()==before and not FundingReservation.objects.exists()
    assert not PurchaseIntent.objects.exists() and not ZecCreditReceipt.objects.exists()
    current=price(200); result=process(note)
    assert result.credited and result.receipt.amount_zec==Decimal(amount)/100_000_000
    assert result.receipt.tuzis_per_zec==20000 and result.receipt.tuzis_credited==Decimal(amount)/100_000_000*20000
    provider=FundingReservation.objects.get().external_receipt
    assert provider['snapshot_id']==current.pk and provider['sources']==current.sources
    assert provider['sender_identity']=='shielded_sender_unknown' and provider['pricing_method_version']=='zec-funding-v3'
    price(400); assert process(note).receipt.pk==result.receipt.pk
    assert ZecCreditReceipt.objects.count()==1 and Event.objects.filter(type='BOUGHT_TUZI').count()==1
    buyer.refresh_from_db(); assert buyer.tuzis==result.receipt.tuzis_credited
    assert not PurchaseIntent.objects.exists()


@pytest.mark.parametrize('extra',[{}, {'ref':'historical'}, {'intent':'not-authority','proof':'not-authority'}])
def test_old_extra_fields_have_no_price_or_proof_authority(buyer,extra):
    price(); note=receive(buyer,memo=json.dumps(dict(act='buy_2z',id=buyer.username,**extra)))
    assert process(note).receipt.tuzis_credited==100


def test_expired_wrong_quantity_old_quote_does_not_reject_actual_payment(buyer):
    intent=original_zec_intent(buyer)
    PurchaseIntent.objects.filter(pk=intent.pk).update(created_at=timezone.now()-timedelta(days=1),expires_at=timezone.now()-timedelta(hours=1))
    note=receive(buyer,memo=intent.rail_data['memo'],zatoshis=2_000_000); price(200)
    assert process(note).receipt.tuzis_credited==400
    old=FundingReservation.objects.get(pk=intent.quote['funding_reservation_id'])
    assert old.state=='reserved' and old.external_receipt=={}
    assert FundingReservation.objects.filter(state='issued').count()==1 and PurchaseIntent.objects.count()==1


def test_stale_price_retries_without_financial_writes(buyer):
    old=price(); ZecPriceSnapshot.objects.filter(pk=old.pk).update(created_at=timezone.now()-timedelta(minutes=3))
    note=receive(buyer); before=Transfer.objects.count()
    with pytest.raises(money.EconomicRefusal,match='zec_pricing_unavailable'): process(note)
    assert Transfer.objects.count()==before and not FundingReservation.objects.exists() and not ZecCreditReceipt.objects.exists()
    assert note.dispositions.filter(kind='observed').exists()
    price(250); assert process(note).receipt.tuzis_per_zec==25000


@pytest.mark.parametrize('memo',['','{"act":"buy_2z","id":"unknown"}','{"act":"buy_2z","id":"a","id":"b"}',
    '{"act":"buy_2z","id":false}','{"act":"buy_2z","id":"a\\u0000b"}'])
def test_invalid_or_unknown_memo_retains_capture_without_credit(buyer,memo):
    price(); note=receive(buyer,memo=memo)
    assert not process(note).credited and not FundingReservation.objects.exists() and not ZecCreditReceipt.objects.exists()


def test_owned_server_note_identity_correlates_detection_and_credit(buyer,creator_factory):
    from dj.apps.events.serializers import EventSerializer
    price(); note=receive(buyer); notes.prepare_payment_notice(note_id=note.pk,confirmations=0)
    assert notes.deliver_payment_notice(note_id=note.pk)
    pending=Event.objects.get(type='ZEC_PENDING')
    assert EventSerializer(pending).data['payment_reference']=={'payment_id':str(note.pk),'status':'pending'}
    assert EventSerializer(pending,context={'recipient':creator_factory(tuzis=0)}).data['payment_reference'] is None
    assert process(note).credited
    credit=Event.objects.get(type='BOUGHT_TUZI')
    assert EventSerializer(credit).data['payment_reference']=={'payment_id':str(note.pk),'status':'credited'}
    assert EventSerializer(pending).data['payment_reference']['status']=='credited'
    wire=str(EventSerializer(credit).data)
    assert note.txid not in wire and note.memo_plain not in wire and 'proof' not in wire


def test_revocation_blocks_credit(buyer):
    price(); note=receive(buyer)
    ZecNoteDisposition.objects.create(note=note,event_key=f'revoked:{note.pk}',kind='revoked',evidence={'reason':'chain_changed'})
    assert not process(note).credited and not ZecCreditReceipt.objects.exists()


def test_outbox_failure_rolls_back_credit_but_retains_raw_capture(buyer,mocker):
    price(); note=receive(buyer); before=Transfer.objects.count()
    mocker.patch('dj.apps.events.dispatch.create_durable_event',side_effect=RuntimeError('outbox unavailable'))
    with pytest.raises(RuntimeError,match='outbox unavailable'): process(note)
    assert Transfer.objects.count()==before and not FundingReservation.objects.exists() and not ZecCreditReceipt.objects.exists()
    assert note.dispositions.filter(kind='observed').exists()


def test_sql_guard_rejects_receipt_without_funding_or_journal(buyer):
    price(); note=receive(buyer)
    receipt=ZecCreditReceipt.objects.create(txid=note.txid,pool=note.pool,output_index=0,creator=buyer,
        amount_zec='.01',tuzis_credited=90,tuzis_per_zec=9000,confirmations_at_credit=3)
    with pytest.raises(DatabaseError,match='original funding proof'),transaction.atomic():
        ZecNoteDisposition.objects.create(note=note,actor=buyer,receipt=receipt,kind='issued',event_key='forged',evidence=EVIDENCE)


@pytest.mark.parametrize('confirmations',[True,-1])
def test_invalid_confirmation_never_credits(buyer,confirmations):
    price(); note=receive(buyer)
    with pytest.raises(money.EconomicRefusal,match='invalid_note_confirmations'):
        notes.process_captured_zec_note(note_id=note.pk,confirmations=confirmations,evidence=EVIDENCE)
    assert not ZecCreditReceipt.objects.exists()


def test_fixed_zcash_creation_endpoint_refuses_without_intent_or_reservation(buyer,api_client):
    api_client.force_authenticate(user=buyer)
    response=api_client.post('/api/sdk/v1/purchases',dict(rail='zcash',quantity_2z=100,platform='web',expected_actor_id=buyer.pk),
        format='json',HTTP_IDEMPOTENCY_KEY='no-zec-intent')
    assert response.status_code==400 and response.json()['error']['code']=='rail_unavailable'
    assert not PurchaseIntent.objects.exists() and not FundingReservation.objects.exists()



def test_actual_aggregate_precision_survives_storage_and_credits(buyer):
    from dj.apps.pricing.aggregation import AggregateResult
    from dj.apps.economy.live_zec import processing_snapshot
    raw=Decimal('100.00000149')
    aggregate=AggregateResult(zec_usd=raw,median=raw,used={'coinbase':raw,'kraken':raw},rejected={})
    snapshot=ZecPriceSnapshot.from_aggregate(aggregate);snapshot.save();snapshot.refresh_from_db()
    assert snapshot.zec_usd==Decimal('100.000001') and snapshot.tuzis_per_zec==Decimal('9000.0000')
    assert processing_snapshot().pk==snapshot.pk
    assert process(receive(buyer)).credited


def offer(code='',multiplier='2',**kwargs):
    from dj.apps.economy.models import ZecPromotion
    campaign,_=ZecPromotion.objects.update_or_create(code=code,defaults={
        'title':code or 'Launch', 'multiplier':Decimal(multiplier),'enabled':True,
        'starts_at':timezone.now()-timedelta(minutes=1), 'ends_at':timezone.now()+timedelta(minutes=5), **kwargs})
    return campaign


def test_disabled_seeds_never_launch_implicitly(buyer):
    from dj.apps.economy.models import ZecPromotion
    import importlib
    from django.apps import apps
    from django.db import connection
    seed=importlib.import_module('dj.apps.economy.migrations.0003_live_zec_note_funding').seed_disabled_offers
    with connection.schema_editor() as editor: seed(apps,editor);seed(apps,editor)
    assert set(ZecPromotion.objects.values_list('code','enabled'))=={('',False),('ZODL',False)}
    price(); assert process(receive(buyer)).receipt.tuzis_credited==100


@pytest.mark.parametrize('global_mult,code_mult,expected_code,multiplier',[
    ('2','2',None,2),('2','3','ZODL',3),('3','2',None,3)])
def test_highest_offer_once_global_wins_ties(buyer,global_mult,code_mult,expected_code,multiplier):
    global_offer=offer(multiplier=global_mult); code_offer=offer('ZODL',code_mult)
    price(); note=receive(buyer,memo=json.dumps({'act':'buy_2z','id':buyer.username,'promo':' zodl '}))
    result=process(note); assert result.receipt.tuzis_credited==100*multiplier
    reservation=FundingReservation.objects.get(state='issued')
    assert reservation.sale_nusd==1_000_000_000 and reservation.amount_m2z==100_000*multiplier
    stored=reservation.external_receipt
    assert stored['promotion']['code']==expected_code
    assert stored['promotion']['id']==str((code_offer if expected_code else global_offer).pk)
    assert Decimal(stored['base_tuzis_per_zec'])==10000
    assert Decimal(stored['promotion']['multiplier'])==multiplier
    offer(multiplier='4'); offer('ZODL','5');price(400)
    assert process(note).receipt.pk==result.receipt.pk
    reservation.refresh_from_db(); assert reservation.external_receipt==stored
    assert ZecCreditReceipt.objects.count()==1 and Event.objects.filter(type='BOUGHT_TUZI').count()==1


@pytest.mark.parametrize('promo',['UNKNOWN','ſ','ß','a'*65,'bad/code',12,False,None,'x\u0000y','x\ud800y'])
def test_invalid_unknown_code_does_not_block_global_credit(buyer,promo):
    offer();price()
    note=receive(buyer,memo=json.dumps({'act':'buy_2z','id':buyer.username,'promo':promo}))
    assert process(note).receipt.tuzis_credited==200


@pytest.mark.parametrize('code_state',['expired','disabled','future'])
def test_code_ineligible_at_processing_falls_back_to_global(buyer,code_state):
    offer(); campaign=offer('ZODL','3')
    price(); note=receive(buyer,memo=json.dumps({'act':'buy_2z','id':buyer.username,'promo':'ZODL'}))
    assert not process(note,2).credited
    if code_state=='expired': campaign.ends_at=timezone.now()-timedelta(seconds=1)
    elif code_state=='disabled':campaign.enabled=False
    else:campaign.starts_at=timezone.now()+timedelta(minutes=1)
    campaign.save()
    assert process(note).receipt.tuzis_credited==200


def test_promotion_sql_proof_rejects_forged_rate_and_rolls_back(buyer,monkeypatch):
    from dj.apps.pricing import promotions
    offer(); price();note=receive(buyer)
    monkeypatch.setattr(promotions,'rates',lambda price,multiplier:(Decimal(10000),Decimal(99999),Decimal(89999)))
    with pytest.raises(DatabaseError): process(note)
    assert not ZecCreditReceipt.objects.exists() and not FundingReservation.objects.exists()
    assert not ZecNoteDisposition.objects.filter(note=note,kind='issued').exists()


def test_promotion_usage_cap_counts_bonus_not_inflated_sales(buyer):
    from dj.apps.economy.models import EconomicPolicy
    offer();price(); EconomicPolicy.objects.filter(pk=True).update(account_daily_limit_m2z=150_000)
    result=process(receive(buyer))
    assert not result.credited and result.status=='pending_resolution'
    funding=FundingReservation.objects.get()
    assert funding.amount_m2z==200_000 and funding.sale_nusd==1_000_000_000
    assert not ZecCreditReceipt.objects.exists()


def test_future_price_cannot_issue_even_with_promotion(buyer):
    offer(); snapshot=price();ZecPriceSnapshot.objects.filter(pk=snapshot.pk).update(created_at=timezone.now()+timedelta(seconds=10))
    with pytest.raises(money.EconomicRefusal,match='zec_pricing_unavailable'):process(receive(buyer))


def test_campaign_validation_and_database_constraints(buyer):
    from django.core.exceptions import ValidationError
    from dj.apps.economy.models import ZecPromotion
    campaign=offer('ZODL',enabled=False);campaign.enabled=True;campaign.ends_at=None
    with pytest.raises(ValidationError):campaign.full_clean()
    with transaction.atomic(),pytest.raises(DatabaseError):ZecPromotion.objects.filter(pk=campaign.pk).update(enabled=True,ends_at=None)
    campaign.ends_at=timezone.now()+timedelta(days=1);campaign.code=' zodl ';campaign.full_clean();assert campaign.code=='ZODL'
    for value in ['NaN','Infinity','0.9']:
        campaign.multiplier=Decimal(value)
        with pytest.raises(ValidationError):campaign.full_clean()


def test_adjustable_server_spread_records_actual_policy_without_sql_change(buyer,monkeypatch):
    from dj.apps.pricing import constants
    monkeypatch.setattr(constants,'ZEC_SETTLEMENT_SPREAD',Decimal('.01'))
    monkeypatch.setattr(constants,'ZEC_ESTIMATE_BUFFER',Decimal('.15'))
    price();receipt=process(receive(buyer)).receipt
    assert receipt.tuzis_per_zec==9900 and receipt.tuzis_credited==99
    provenance=FundingReservation.objects.get().external_receipt
    assert provenance['spread']=='0.01' and provenance['estimate_buffer']=='0.15'
    assert Decimal(provenance['estimated_tuzis_per_zec'])==8415


def test_detected_recipient_cannot_silently_change_on_username_reuse(buyer,creator_factory):
    from dj.apps.g12f.models import Creator
    price();note=receive(buyer);notes.prepare_payment_notice(note_id=note.pk,confirmations=0)
    original=buyer.username;Creator.objects.filter(pk=buyer.pk).update(username='renamed-buyer')
    successor=creator_factory(tuzis=0,username=original)
    assert not process(note).credited
    assert notes.deliver_payment_notice(note_id=note.pk)  # finishes without publishing a misattributed notice
    assert not Event.objects.filter(type='ZEC_PENDING').exists()
    assert not ZecCreditReceipt.objects.exists() and not FundingReservation.objects.exists()
    assert not Event.objects.filter(type='BOUGHT_TUZI').exists()
    buyer.refresh_from_db();successor.refresh_from_db();assert buyer.tuzis==successor.tuzis==0


def test_admin_lock_wait_uses_new_offer_and_price_when_processing_resumes(buyer):
    """An admin transaction can delay selection, never pin an earlier price."""
    from concurrent.futures import ThreadPoolExecutor
    import time
    import psycopg
    from django.db import connection,connections
    campaign=offer();price(100);note=receive(buyer)
    settings=connection.settings_dict
    def settle():
        try:return process(note)
        finally:connections.close_all()
    with psycopg.connect(host=settings['HOST'],port=settings['PORT'],dbname=settings['NAME'],user=settings['USER'],password=settings['PASSWORD']) as admin_connection:
        with admin_connection.cursor() as cursor:
            cursor.execute('SELECT id FROM economy_zecpromotion WHERE id=%s FOR UPDATE',(campaign.pk,))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future=executor.submit(settle)
            deadline=time.monotonic()+5
            blocked=False
            while time.monotonic()<deadline:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE %s)",('%economy_zecpromotion%',))
                    blocked=cursor.fetchone()[0]
                if blocked:break
                time.sleep(.02)
            try:
                assert blocked,'settlement must reach the actual promotion row lock'
                price(200)
                with admin_connection.cursor() as cursor:
                    cursor.execute('UPDATE economy_zecpromotion SET multiplier=3 WHERE id=%s',(campaign.pk,))
            finally:admin_connection.commit()
            receipt=future.result(timeout=10).receipt
    assert receipt.tuzis_per_zec==60000 and receipt.tuzis_credited==600
    funding=FundingReservation.objects.get(state='issued')
    assert funding.sale_nusd==2_000_000_000 and funding.external_receipt['promotion']['multiplier']=='3.0000'


@pytest.mark.parametrize('username',['x\u0000y','x\ud800y','x\udc00y','x\u0001y'])
def test_sql_routing_projection_cannot_rewrite_invalid_required_recipient(buyer,username):
    from django.db import connection
    note=receive(buyer,memo=json.dumps({'act':'buy_2z','id':username,'promo':'ZODL'}))
    with connection.cursor() as cursor:
        cursor.execute('SELECT economy.routing_note_memo(%s)',(note.pk,))
        assert cursor.fetchone()[0] is None


def test_sql_projection_preserves_escaped_literal_and_valid_unicode_recipient(buyer):
    from django.db import connection
    for index,username in enumerate([r'\u0000',r'\ud800','👩']):
        note=receive(buyer,tx=str(index),memo=json.dumps({'act':'buy_2z','id':username,'promo':'x\u0000y'}))
        with connection.cursor() as cursor:
            cursor.execute("SELECT economy.routing_note_memo(%s)->>'id'",(note.pk,))
            assert cursor.fetchone()[0]==username


@pytest.mark.parametrize('pending_notice',[False,True])
def test_durable_credit_payload_is_already_credited_before_publication(buyer,pending_notice):
    from dj.apps.jobs.models import OutboxMessage
    price();note=receive(buyer)
    if pending_notice:
        notes.prepare_payment_notice(note_id=note.pk,confirmations=0);notes.deliver_payment_notice(note_id=note.pk)
    assert process(note).credited
    payload=OutboxMessage.objects.get(payload__type='BOUGHT_TUZI').payload
    assert payload['payment_reference']=={'payment_id':str(note.pk),'status':'credited'}


@pytest.mark.parametrize('rename',[False,True])
def test_real_outstanding_original_contract_is_preserved_for_manual_resolution(buyer,creator_factory,rename):
    from dj.apps.g12f.models import Creator
    intent=original_zec_intent(buyer,historical_memo=True)
    original_name=buyer.username
    if rename:
        Creator.objects.filter(pk=buyer.pk).update(username='renamed-original-buyer')
        successor=creator_factory(username=original_name,tuzis=0)
    note=receive(buyer,memo=intent.rail_data['memo']);price(50)
    result=process(note)
    assert not result.credited and result.reason=='retired_original_contract_requires_resolution'
    assert not ZecCreditReceipt.objects.exists() and not Event.objects.filter(type='BOUGHT_TUZI').exists()
    reserve=FundingReservation.objects.get(pk=intent.quote['funding_reservation_id'])
    assert reserve.state=='reserved' and reserve.amount_m2z==90000
    held=ZecNoteDisposition.objects.get(note=note,kind='pending_resolution')
    assert held.actor_id==buyer.pk and held.intent_id==intent.pk
    if rename:successor.refresh_from_db();assert successor.tuzis==0


def test_arbitrary_existing_intent_reference_has_no_quote_authority(buyer):
    intent=original_zec_intent(buyer,historical_memo=True)
    note=receive(buyer,memo=json.dumps({'act':'buy_2z','id':buyer.username,'intent':str(intent.pk),'proof':'different-extra'}))
    assert process(note).receipt.tuzis_credited==100


def test_ordinary_payment_never_releases_capacity_backing_captured_old_claim(buyer):
    intent=original_zec_intent(buyer,historical_memo=True)
    historical=receive(buyer,memo=intent.rail_data['memo'])
    assert not process(historical,1).credited
    price()
    ordinary=receive(buyer,tx='c')
    assert process(ordinary).receipt.tuzis_credited==100
    old=FundingReservation.objects.get(pk=intent.quote['funding_reservation_id'])
    assert old.state=='reserved' and old.external_receipt=={}
    assert not process(historical).credited
    assert ZecCreditReceipt.objects.count()==1
