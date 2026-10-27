"""Real PostgreSQL capture/finance/outbox; only approved host/node IO is mocked."""
import copy
from contextlib import nullcontext
from decimal import Decimal
from types import SimpleNamespace
import pytest
from django.db import DatabaseError, transaction
from django.utils import timezone
from dj.apps.economy import services as money
from dj.apps.economy.models import CapturedZecNote, EconomicPolicy, ZecNoteDisposition
from dj.apps.economy.tests.test_integration import original_zec_intent, reset_isolated_policy  # noqa: F401
from dj.apps.economy.tests.test_foundation import activate_for_test, sql
from dj.apps.g12f import paymentd_credit as adapter
from dj.apps.g12f.paymentd_protocol import PaymentEvidenceError
from dj.apps.g12f.test_paymentd_protocol import event
from dj.apps.ledger.models import Transfer
from dj.apps.tuzis.models import ZecCreditReceipt
from dj.apps.g12f.management.commands.paymentd_credit_status import backend_status
pytestmark = pytest.mark.django_db(transaction=True)


class Verifier:
    def __init__(self, confirmations=3):
        self.confirmations=confirmations;self.calls=0;self.fail_at=None;self.record=None
    def verify(self,e):
        self.calls+=1
        if self.calls==self.fail_at: raise PaymentEvidenceError('changed chain')
        return SimpleNamespace(confirmations=0 if e['kind']=='payment.revoked' else self.confirmations,
            receiver_in_scope=True)
    def verify_payment(self,identity):
        self.calls+=1
        if self.calls==self.fail_at: raise PaymentEvidenceError('changed historical chain')
        assert identity==self.record['payment']['id']
        return {'record':copy.deepcopy(self.record),'confirmations':3}


@pytest.fixture(autouse=True)
def host_io(monkeypatch):
    from zcashrpc import paymentd_mode
    monkeypatch.setattr(adapter,'require_runtime',lambda **kw:None)
    # Native subprocess controls exercise the actual root lease separately.
    monkeypatch.setattr(paymentd_mode,'producer_lease',lambda *args,**kwargs:nullcontext())


@pytest.fixture
def purchase(creator_factory):
    buyer=creator_factory(tuzis=0)
    with transaction.atomic(): activate_for_test()
    intent=original_zec_intent(buyer);e=event()
    e['payment']['value_zatoshis']=int(Decimal(intent.quote['amount_zec'])*100_000_000)
    e['payment']['memo_hex']=intent.rail_data['memo'].encode().ljust(512,b'\0').hex()
    return buyer,intent,e


def phase(e,kind,revision=1):
    e=copy.deepcopy(e);e['kind']='payment.'+kind;e['revision']=revision
    e['event_id']=f"{e['payment']['id']}:{revision}:{kind}"
    return e


def wallet_note(event):
    payment=event['payment']
    return {'txid':payment['txid'],'pool':payment['pool'],'output_index':payment['output_index'],
        'amount':str(Decimal(payment['value_zatoshis'])/100_000_000),
        'amountZat':payment['value_zatoshis'],'memo':payment['memo_hex'],
        'confirmations':3,'memo_available':True,'output_index_reliable':True}


def test_early_capture_commits_original_first_seen_then_settles_once(purchase):
    buyer,intent,e=purchase;before=Transfer.objects.count()
    assert adapter.handle_event(phase(e,'observed'),Verifier(1),role='capture').status=='captured'
    first=CapturedZecNote.objects.get().first_seen_at
    assert Transfer.objects.count()==before and not ZecCreditReceipt.objects.exists()
    intent.refresh_from_db();assert intent.rail_data['payment_observed'] is False
    assert adapter.handle_event(e,Verifier(),role='settle').newly_issued
    assert not adapter.handle_event(e,Verifier(),role='settle').newly_issued
    buyer.refresh_from_db();assert buyer.tuzis==100
    assert CapturedZecNote.objects.get().first_seen_at==first
    assert ZecCreditReceipt.objects.count()==1 and backend_status()['issued_notes']==1
    assert backend_status()['oldest_captured_unsettled_at'] is None


def test_final_proof_rolls_back_ledger_receipt_paid_event_but_retains_capture(purchase):
    from dj.apps.events.models import Event
    buyer,_,e=purchase;before=Transfer.objects.count();v=Verifier();v.fail_at=2
    with pytest.raises(PaymentEvidenceError): adapter.handle_event(e,v,role='settle')
    assert CapturedZecNote.objects.count()==1 and ZecNoteDisposition.objects.filter(kind='observed').exists()
    assert not ZecCreditReceipt.objects.exists() and Transfer.objects.count()==before
    assert not Event.objects.filter(type='BOUGHT_TUZI').exists()
    buyer.refresh_from_db();assert buyer.tuzis==0
    assert adapter.handle_event(e,Verifier(),role='settle').newly_issued
    assert Event.objects.filter(type='BOUGHT_TUZI').count()==1
    adapter.handle_event(e,Verifier(),role='settle')
    assert Event.objects.filter(type='BOUGHT_TUZI').count()==1


def test_fence_retries_finance_without_blocking_observation(purchase):
    from dj.apps.events.models import Event
    _,_,e=purchase;EconomicPolicy.objects.filter(id=True).update(fenced=True)
    assert adapter.handle_event(phase(e,'observed'),Verifier(1),role='capture').status=='captured'
    first_seen=CapturedZecNote.objects.get().first_seen_at
    with pytest.raises(DatabaseError,match='economic_writers_fenced'): adapter.handle_event(e,Verifier(),role='settle')
    status=backend_status()
    assert status['retryable_settlements']==1 and status['captured_unsettled']==1
    assert status['oldest_captured_unsettled_at'] is not None
    assert not Event.objects.filter(type='BOUGHT_TUZI').exists()
    other=copy.deepcopy(e);other['payment']['txid']='b'*64;other['payment']['id']=f"main:{'b'*64}:ironwood:0"
    assert adapter.handle_event(phase(other,'observed'),Verifier(1),role='capture').status=='captured'
    assert CapturedZecNote.objects.count()==2 and not ZecCreditReceipt.objects.exists()
    sql('ALTER TABLE economy_economicpolicy DISABLE TRIGGER economy_policy_guard')
    try: EconomicPolicy.objects.filter(id=True).update(fenced=False)
    finally: sql('ALTER TABLE economy_economicpolicy ENABLE TRIGGER economy_policy_guard')
    assert adapter.handle_event(e,Verifier(),role='settle').newly_issued
    assert not adapter.handle_event(e,Verifier(),role='settle').newly_issued
    assert CapturedZecNote.objects.get(txid=e['payment']['txid']).first_seen_at==first_seen
    assert backend_status()['retryable_settlements']==0
    assert ZecCreditReceipt.objects.count()==1 and Event.objects.filter(type='BOUGHT_TUZI').count()==1


@pytest.mark.parametrize('raw',[b'\xf6'+bytes(511),bytes(512),b'\xff'+bytes(511),
    b'{"act":"buy_2z","id":"nobody"}'.ljust(512,b'\0'),
    b'{"act":"buy_2z","id":"a","id":"b"}'.ljust(512,b'\0'),
    b'{"act":"buy_2z"}\0garbage'.ljust(512,b'\0')])
def test_bad_memos_durably_ack_not_fifo_poison(raw):
    with transaction.atomic(): activate_for_test()
    e=event();e['payment']['memo_hex']=raw.hex();r=adapter.handle_event(e,Verifier(),role='settle')
    assert r.status in {'pending_resolution','observed_nonpurchase'} and not r.newly_issued
    note=CapturedZecNote.objects.get();assert note.memo_hex==raw.hex()
    if b'\0garbage' in raw or raw[0]>=0xf5: assert note.memo_plain is None
    assert not ZecCreditReceipt.objects.exists()


def test_zero_capture_acks_when_policy_disabled_without_issuance():
    e=phase(event(),'observed');e['payment']['value_zatoshis']=0
    assert adapter.handle_event(e,Verifier(1),role='capture').status=='captured'
    assert ZecNoteDisposition.objects.filter(kind='ignored_zero').count()==1
    assert backend_status()['ignored_zero']==1 and not ZecCreditReceipt.objects.exists()


def test_observed_event_cannot_settle(purchase):
    with pytest.raises(PaymentEvidenceError): adapter.handle_event(phase(purchase[2],'observed'),Verifier(1),role='settle')
    assert not ZecCreditReceipt.objects.exists()


def test_larger_backend_floor_retries_then_issues(purchase,monkeypatch):
    e=purchase[2];monkeypatch.setenv('ZEC_MIN_CONFIRMATIONS','4')
    with pytest.raises(adapter.RetrySettlement): adapter.handle_event(e,Verifier(3),role='settle')
    assert ZecNoteDisposition.objects.filter(kind='pending_confirmation').exists()
    assert not ZecCreditReceipt.objects.exists()
    assert adapter.handle_event(e,Verifier(4),role='settle').newly_issued


def test_revoke_and_remine_never_debit_or_remint_and_retry_identity_stays_stable(purchase):
    buyer,_,e=purchase;adapter.handle_event(e,Verifier(),role='settle')
    original=ZecCreditReceipt.objects.get();count=Transfer.objects.count();revoked=phase(e,'revoked')
    assert adapter.handle_event(revoked,Verifier(),role='capture').status=='revoked'
    original.refresh_from_db();assert original.vanished_at and original.vanish_resolved_at is None
    n=ZecNoteDisposition.objects.filter(kind='revoked').count()
    adapter.handle_event(revoked,Verifier(),role='settle')
    assert ZecNoteDisposition.objects.filter(kind='revoked').count()==n
    result=adapter.handle_event(phase(e,'confirmed',2),Verifier(),role='settle')
    assert result.status=='issued_under_review' and not result.newly_issued
    assert Transfer.objects.count()==count and ZecCreditReceipt.objects.count()==1
    buyer.refresh_from_db();assert buyer.tuzis==100


def test_global_brake_retries_unaffected_note_until_resolution(purchase,creator_factory):
    e=purchase[2];actor=creator_factory(tuzis=0)
    brake=ZecCreditReceipt.objects.create(txid='f'*64,pool='sapling',output_index=0,
        creator=actor,amount_zec=Decimal('.01'),vanished_at=timezone.now())
    with pytest.raises(adapter.RetrySettlement): adapter.handle_event(e,Verifier(),role='settle')
    status=backend_status()
    assert status['pending_resolution']==0 and status['retryable_settlements']==1
    assert status['captured_unsettled']==1
    assert status['oldest_captured_unsettled_at'] is not None
    ZecCreditReceipt.objects.filter(pk=brake.pk).update(vanish_resolved_at=timezone.now())
    assert adapter.handle_event(e,Verifier(),role='settle').newly_issued
    assert backend_status()['pending_resolution']==0
    assert backend_status()['retryable_settlements']==0
    assert backend_status()['oldest_captured_unsettled_at'] is None


@pytest.mark.parametrize('role',['capture','settle'])
def test_receiver_quarantine_requires_canonical_proof_and_never_settles(purchase,role):
    buyer,_,e=purchase
    class Outside(Verifier):
        def verify(self,e):
            result=super().verify(e);result.receiver_in_scope=False;return result
    failed=Outside();failed.fail_at=1
    with pytest.raises(PaymentEvidenceError):
        adapter.handle_event(e,failed,role=role)
    assert not CapturedZecNote.objects.exists()
    assert adapter.handle_event(e,Outside(),role=role).status=='receiver_scope_quarantined'
    assert not ZecCreditReceipt.objects.exists()
    buyer.refresh_from_db();assert buyer.tuzis==0
    status=backend_status()
    assert status['pending_resolution']==1 and status['captured_unsettled']==0
    assert status['oldest_captured_unsettled_at'] is None


def test_receiver_hold_survives_observation_ack_allowlist_change_and_redelivery(purchase):
    from dj.apps.events.models import Event
    buyer,_,e=purchase
    class Outside(Verifier):
        def verify(self,e):
            result=super().verify(e);result.receiver_in_scope=False;return result
    observed=phase(e,'observed')
    assert adapter.handle_event(observed,Outside(1),role='capture').status=='receiver_scope_quarantined'
    first_seen=CapturedZecNote.objects.get().first_seen_at
    # This also models a crash before daemon ACK: the exact old event retries
    # after the private allowlist is expanded. Later confirmations remain held.
    for received,role in [(observed,'capture'),(e,'capture'),(e,'settle'),(e,'settle')]:
        assert adapter.handle_event(received,Verifier(),role=role).status=='receiver_scope_quarantined'
    buyer.refresh_from_db();assert buyer.tuzis==0
    assert CapturedZecNote.objects.get().first_seen_at==first_seen
    assert not ZecCreditReceipt.objects.exists() and not Event.objects.filter(type='BOUGHT_TUZI').exists()
    assert backend_status()['pending_resolution']==1


def test_legacy_wallet_rollback_cannot_release_native_receiver_quarantine(purchase):
    from dj.apps.economy.captured_notes import capture_wallet_note
    from dj.apps.events.models import Event
    buyer,_,e=purchase
    class Outside(Verifier):
        def verify(self,event):
            value=super().verify(event);value.receiver_in_scope=False;return value
    adapter.handle_event(phase(e,'observed'),Outside(1),role='capture')
    for _ in range(2):
        result=capture_wallet_note(wallet_note(e))
        assert result.status=='pending_resolution' and result.reason=='receiver_scope_unconfigured'
    buyer.refresh_from_db();assert buyer.tuzis==0
    assert not ZecCreditReceipt.objects.exists() and not Event.objects.filter(type='BOUGHT_TUZI').exists()


def test_inactive_purchaser_is_manual_after_rollback_and_stays_held_when_reactivated(purchase):
    from dj.apps.economy.captured_notes import capture_wallet_note
    from dj.apps.events.models import Event
    buyer,_,e=purchase
    adapter.handle_event(phase(e,'observed'),Verifier(1),role='capture')
    buyer.is_active=False;buyer.save(update_fields=['is_active'])
    assert adapter.handle_event(e,Verifier(),role='settle').status=='pending_resolution'
    assert ZecNoteDisposition.objects.filter(evidence__reason='inactive_funding_actor').count()==1
    assert backend_status()['captured_unsettled']==0 and backend_status()['pending_resolution']==1
    buyer.is_active=True;buyer.save(update_fields=['is_active'])
    assert adapter.handle_event(e,Verifier(),role='settle').status=='pending_resolution'
    result=capture_wallet_note(wallet_note(e))
    assert result.status=='pending_resolution' and result.reason=='inactive_funding_actor'
    buyer.refresh_from_db();assert buyer.tuzis==0
    assert not ZecCreditReceipt.objects.exists() and not Event.objects.filter(type='BOUGHT_TUZI').exists()


def test_inactive_manual_ack_requires_fresh_proof_after_failed_financial_transaction(purchase):
    buyer,_,e=purchase;buyer.is_active=False;buyer.save(update_fields=['is_active'])
    verifier=Verifier();verifier.fail_at=2
    with pytest.raises(PaymentEvidenceError): adapter.handle_event(e,verifier,role='settle')
    assert CapturedZecNote.objects.count()==1
    assert not ZecNoteDisposition.objects.filter(evidence__reason='inactive_funding_actor').exists()
    assert not ZecCreditReceipt.objects.exists()


def test_unknown_financial_refusal_remains_retryable_without_manual_ack(purchase,monkeypatch):
    def refuse(*args,**kwargs): raise money.EconomicRefusal('unexpected_systemic_refusal')
    monkeypatch.setattr(adapter,'_settle',refuse)
    with pytest.raises(money.EconomicRefusal,match='unexpected_systemic_refusal'):
        adapter.handle_event(purchase[2],Verifier(),role='settle')
    assert not ZecNoteDisposition.objects.filter(kind='pending_resolution').exists()


@pytest.mark.parametrize('reason',['receiver_scope_unconfigured','inactive_funding_actor'])
def test_shared_financial_guard_checks_hold_after_adapter_preflight(purchase,monkeypatch,reason):
    buyer,_,e=purchase;process=adapter.captured_notes.process_captured_zec_note
    def hold_then_process(**kwargs):
        note=CapturedZecNote.objects.get(pk=kwargs['note_id'])
        ZecNoteDisposition.objects.create(note=note,event_key='hold-after-preflight',
            kind='pending_resolution',evidence={'reason':reason})
        return process(**kwargs)
    monkeypatch.setattr(adapter.captured_notes,'process_captured_zec_note',hold_then_process)
    assert adapter.handle_event(e,Verifier(),role='settle').status=='pending_resolution'
    buyer.refresh_from_db();assert buyer.tuzis==0 and not ZecCreditReceipt.objects.exists()


def test_fence_retry_evidence_requires_fresh_proof_after_financial_rollback(purchase):
    _,_,e=purchase;EconomicPolicy.objects.filter(id=True).update(fenced=True)
    failed=Verifier();failed.fail_at=2
    with pytest.raises(PaymentEvidenceError): adapter.handle_event(e,failed,role='settle')
    assert CapturedZecNote.objects.count()==1
    assert not ZecNoteDisposition.objects.filter(evidence__reason='economic_writers_fenced').exists()
    assert not ZecCreditReceipt.objects.exists()


def test_quarantine_committing_after_preflight_fences_financial_issuance(purchase,monkeypatch):
    buyer,_,e=purchase
    settle=adapter._settle
    def hold_then_settle(event,verifier,role,note,initial,evidence):
        # Another fact worker can commit the hold between preflight and the
        # financial lock. The real PostgreSQL row is visible to settlement.
        with transaction.atomic():
            CapturedZecNote.objects.select_for_update(no_key=True).get(pk=note.pk)
            ZecNoteDisposition.objects.create(note=note,event_key='concurrent-receiver-hold',
                kind='pending_resolution',evidence={'reason':'receiver_scope_unconfigured'})
        return settle(event,verifier,role,note,initial,evidence)
    monkeypatch.setattr(adapter,'_settle',hold_then_settle)
    assert adapter.handle_event(e,Verifier(),role='settle').status=='receiver_scope_quarantined'
    buyer.refresh_from_db();assert buyer.tuzis==0
    assert not ZecCreditReceipt.objects.exists()


def test_runtime_failure_prevents_raw_capture(purchase,monkeypatch):
    def fail(**kw): raise PaymentEvidenceError('wrong mode')
    monkeypatch.setattr(adapter,'require_runtime',fail)
    with pytest.raises(PaymentEvidenceError): adapter.handle_event(purchase[2],Verifier(),role='capture')
    assert not CapturedZecNote.objects.exists()


@pytest.mark.parametrize('role',['capture','settle'])
def test_caller_owned_transaction_cannot_outlive_the_hook_lease(purchase,role):
    verifier=Verifier()
    with transaction.atomic(),pytest.raises(PaymentEvidenceError,match='independently owned transaction'):
        adapter.handle_event(purchase[2],verifier,role=role)
    assert verifier.calls==0
    assert not CapturedZecNote.objects.exists() and not ZecCreditReceipt.objects.exists()


def historical(e):
    v=Verifier();v.record={key:e[key] for key in ['network','payment','block_height','block_hash','revision']}
    v.record['confirmed']=True;return v


def test_historical_valid_intent_never_issues(purchase):
    buyer,_,e=purchase;v=historical(e)
    assert adapter.reconcile_payment(e['payment']['id'],v).status=='verified'
    assert not CapturedZecNote.objects.exists()
    assert adapter.reconcile_payment(e['payment']['id'],v,apply=True).status=='pending_resolution'
    assert not ZecCreditReceipt.objects.exists()
    buyer.refresh_from_db();assert buyer.tuzis==0


def test_historical_corpora_shape_adopts_existing_exact_credit(creator_factory):
    from dj.apps.ledger import api
    actor=creator_factory(tuzis=0);e=event()
    receipt=ZecCreditReceipt.objects.create(txid=e['payment']['txid'],pool='ironwood',output_index=0,
        creator=actor,amount_zec=Decimal('.00909007'),tuzis_credited=Decimal('998.493'),tuzis_per_zec=Decimal('109844.35'))
    api.credit_purchase(actor.pk,998493,'zec','zec_receipt',str(receipt.pk),'original-corpora-shape')
    count=Transfer.objects.count()
    assert adapter.reconcile_payment(e['payment']['id'],historical(e),apply=True).status=='adopted_existing'
    assert CapturedZecNote.objects.get().dispositions.get(kind='legacy_issued').receipt_id==receipt.pk
    assert Transfer.objects.count()==count and ZecCreditReceipt.objects.count()==1


def test_forward_corpora_shape_capture_then_settle_adopts_without_paid_event(creator_factory):
    from dj.apps.ledger import api
    from dj.apps.events.models import Event
    actor=creator_factory(tuzis=0);e=event()
    receipt=ZecCreditReceipt.objects.create(txid=e['payment']['txid'],pool='ironwood',output_index=0,
        creator=actor,amount_zec=Decimal('.00909007'),tuzis_credited=Decimal('998.493'),tuzis_per_zec=Decimal('109844.35'))
    api.credit_purchase(actor.pk,998493,'zec','zec_receipt',str(receipt.pk),'forward-corpora-original')
    transfers,events=Transfer.objects.count(),Event.objects.filter(type='BOUGHT_TUZI').count()
    with transaction.atomic(): activate_for_test()
    assert adapter.handle_event(phase(e,'observed'),Verifier(1),role='capture').status=='captured'
    assert not ZecNoteDisposition.objects.filter(kind='legacy_issued').exists()
    outcome=adapter.handle_event(e,Verifier(),role='settle')
    assert outcome.status=='issued' and not outcome.newly_issued
    note=CapturedZecNote.objects.get()
    assert note.dispositions.get(kind='legacy_issued').receipt_id==receipt.pk
    assert backend_status()['captured_unsettled']==0 and backend_status()['adopted_notes']==1
    assert Transfer.objects.count()==transfers and Event.objects.filter(type='BOUGHT_TUZI').count()==events
    assert ZecCreditReceipt.objects.count()==1
    actor.refresh_from_db();assert actor.tuzis==Decimal('998.493')


@pytest.mark.parametrize('reason',['receiver_scope_unconfigured','inactive_funding_actor'])
def test_shared_hold_preserves_exact_original_issuance_adoption_and_revocation(creator_factory,reason):
    from dj.apps.ledger import api
    from dj.apps.events.models import Event
    from dj.apps.economy.captured_notes import capture_wallet_note,record_note_observation
    actor=creator_factory(tuzis=0);e=event()
    receipt=ZecCreditReceipt.objects.create(txid=e['payment']['txid'],pool='ironwood',output_index=0,
        creator=actor,amount_zec=Decimal('.00909007'),tuzis_credited=Decimal('998.493'),tuzis_per_zec=Decimal('109844.35'))
    api.credit_purchase(actor.pk,998493,'zec','zec_receipt',str(receipt.pk),'held-corpora-original')
    with transaction.atomic(): activate_for_test()
    note=adapter.capture(e['payment'],source_reference='test-prior-hold',adopt_existing=False)
    ZecNoteDisposition.objects.create(note=note,event_key='prior-hold',kind='pending_resolution',evidence={'reason':reason})
    count=Transfer.objects.count()
    result=capture_wallet_note(wallet_note(e))
    assert result.status=='issued' and result.receipt.pk==receipt.pk
    assert note.dispositions.get(kind='legacy_issued').receipt_id==receipt.pk
    record_note_observation(note_id=note.pk,confirmations=0,evidence={
        'source_reference':'test-revoke','confirmation_reference':'test-revoke',
        'revoked':True,'revocation_revision_reference':'test-revoke'})
    assert capture_wallet_note(wallet_note(e)).status=='issued_under_review'
    receipt.refresh_from_db();assert receipt.vanished_at
    assert Transfer.objects.count()==count and ZecCreditReceipt.objects.count()==1
    assert not Event.objects.filter(type='BOUGHT_TUZI').exists()
    actor.refresh_from_db();assert actor.tuzis==Decimal('998.493')


@pytest.mark.parametrize('changes',[{'backfilled':True},{'pool':''},{'amount_zec':Decimal('.02')}])
def test_ambiguous_history_never_adopts_or_issues(creator_factory,changes):
    actor=creator_factory(tuzis=0);e=event()
    values=dict(txid=e['payment']['txid'],pool='ironwood',output_index=0,creator=actor,
        amount_zec=Decimal('.00909007'),tuzis_credited=Decimal('998.493'))
    values.update(changes);ZecCreditReceipt.objects.create(**values)
    assert adapter.reconcile_payment(e['payment']['id'],historical(e),apply=True).status=='pending_resolution'
    assert not ZecNoteDisposition.objects.filter(kind='legacy_issued').exists()


def test_historical_owner_tamper_cannot_adopt_wrong_clearing_owner(creator_factory):
    from dj.apps.ledger import api
    original=creator_factory(tuzis=0);other=creator_factory(tuzis=0);e=event()
    receipt=ZecCreditReceipt.objects.create(txid=e['payment']['txid'],pool='ironwood',output_index=0,
        creator=original,amount_zec=Decimal('.00909007'),tuzis_credited=Decimal('998.493'))
    api.credit_purchase(original.pk,998493,'zec','zec_receipt',str(receipt.pk),'original-owner-proof')
    ZecCreditReceipt.objects.filter(pk=receipt.pk).update(creator=other)
    count=Transfer.objects.count()
    assert adapter.reconcile_payment(e['payment']['id'],historical(e),apply=True).status=='pending_resolution'
    assert not ZecNoteDisposition.objects.filter(kind='legacy_issued').exists()
    assert Transfer.objects.count()==count


def test_historical_final_proof_failure_keeps_raw_but_rolls_back_manual_tag(purchase):
    e=purchase[2];v=historical(e);v.fail_at=2
    with pytest.raises(PaymentEvidenceError): adapter.reconcile_payment(e['payment']['id'],v,apply=True)
    assert CapturedZecNote.objects.count()==1
    assert not ZecNoteDisposition.objects.filter(kind='pending_resolution').exists()
    assert not ZecCreditReceipt.objects.exists()


def test_changed_market_price_changes_actual_confirmed_credit(purchase):
    from dj.apps.pricing.models import ZecPriceSnapshot
    buyer,_,e=purchase
    adapter.handle_event(phase(e,'observed'),Verifier(1),role='capture')
    ZecPriceSnapshot.objects.create(zec_usd=900,median_usd=900,spread='.1',tuzis_per_zec=81000,
        num_sources=2,sources={'coinbase':'900','kraken':'900'})
    assert adapter.handle_event(e,Verifier(),role='settle').newly_issued
    buyer.refresh_from_db();assert buyer.tuzis==900


def test_changed_amount_or_memo_on_same_identity_is_never_an_already_paid_success(purchase):
    _,_,e=purchase
    adapter.handle_event(e,Verifier(),role='settle')
    before=Transfer.objects.count()
    for mutate in [lambda p:p.update(value_zatoshis=p['value_zatoshis']+1),
                   lambda p:p.update(memo_hex=b'{"act":"buy_2z","id":"other"}'.ljust(512,b'\0').hex())]:
        changed=copy.deepcopy(e);mutate(changed['payment'])
        with pytest.raises(money.IdempotencyConflict): adapter.handle_event(changed,Verifier(),role='settle')
    assert Transfer.objects.count()==before and ZecCreditReceipt.objects.count()==1


def test_final_confirmation_depth_decrease_rolls_back_issuance(purchase):
    class Shrink(Verifier):
        def verify(self,e):
            result=super().verify(e)
            if self.calls==2: result.confirmations=2
            return result
    with pytest.raises(PaymentEvidenceError): adapter.handle_event(purchase[2],Shrink(),role='settle')
    assert CapturedZecNote.objects.count()==1 and not ZecCreditReceipt.objects.exists()


def test_status_adopted_then_revoked_has_one_current_review_state(creator_factory):
    from dj.apps.ledger import api
    actor=creator_factory(tuzis=0);e=event()
    receipt=ZecCreditReceipt.objects.create(txid=e['payment']['txid'],pool='ironwood',output_index=0,
        creator=actor,amount_zec=Decimal('.00909007'),tuzis_credited=Decimal('998.493'))
    api.credit_purchase(actor.pk,998493,'zec','zec_receipt',str(receipt.pk),'status-adoption')
    adapter.reconcile_payment(e['payment']['id'],historical(e),apply=True)
    note=CapturedZecNote.objects.get()
    ZecNoteDisposition.objects.create(note=note,event_key='past-manual',kind='pending_resolution',evidence={'reason':'past'})
    status=backend_status()
    assert status['adopted_notes']==1 and status['new_issuance_notes']==0 and status['pending_resolution']==0
    assert status['oldest_captured_unsettled_at'] is None
    adapter.handle_event(phase(e,'revoked'),Verifier(),role='capture')
    status=backend_status()
    assert status['issued_under_review']==1 and status['unresolved_unbacked_credits']==1
    assert status['pending_resolution']==0
    assert status['oldest_captured_unsettled_at'] is None


def test_concurrent_settlement_reports_only_actual_new_issuance(purchase):
    from dj.apps.economy.tests.test_concurrency import race
    e=purchase[2]
    results=race(lambda:adapter.handle_event(e,Verifier(),role='settle'),
                 lambda:adapter.handle_event(e,Verifier(),role='settle'))
    assert all(isinstance(r,adapter.Outcome) for r in results),results
    assert sum(r.newly_issued for r in results)==1
    assert ZecCreditReceipt.objects.count()==1


@pytest.mark.parametrize('resolved',[False,True])
def test_completed_nonfinancial_notes_are_not_permanently_unsettled(resolved):
    from dj.apps.events.models import Event
    from dj.apps.tuzis.models import ZecMemoDisposition
    with transaction.atomic(): activate_for_test()
    e=event()
    if resolved:
        ZecMemoDisposition.objects.create(txid=e['payment']['txid'],pool='ironwood',output_index=0,
            amount_zec=Decimal('.00909007'),decision='ignore',disposed_at=timezone.now(),reason='operator-reviewed')
    else:
        e['payment']['memo_hex']=b'ordinary donation'.ljust(512,b'\0').hex()
    result=adapter.handle_event(e,Verifier(),role='settle')
    assert result.status==('resolved_observation' if resolved else 'observed_nonpurchase')
    status=backend_status()
    assert status['captured_unsettled']==0 and status['pending_resolution']==0
    assert status['oldest_captured_unsettled_at'] is None
    assert status['operator_resolved' if resolved else 'completed_nonpurchase']==1
    assert not ZecCreditReceipt.objects.exists() and not Event.objects.filter(type='BOUGHT_TUZI').exists()
    adapter.handle_event(phase(e,'revoked'),Verifier(),role='capture')
    assert backend_status()['retracted_unissued']==1
    assert backend_status()['operator_resolved' if resolved else 'completed_nonpurchase']==0


def test_capture_announces_detection_once_without_credit_or_private_memo(purchase):
    from dj.apps.events.models import Event
    from dj.apps.jobs.models import OutboxMessage
    from dj.apps.tuzis.models import ZecPendingNotice
    buyer, intent, e = purchase
    before = Transfer.objects.count()
    for _ in range(2):
        adapter.handle_event(phase(e, 'observed'), Verifier(1), role='capture')
    notice = ZecPendingNotice.objects.get()
    pending = Event.objects.get(type='ZEC_PENDING')
    promise = OutboxMessage.objects.get(payload__type='ZEC_PENDING')
    assert notice.creator_id == buyer.pk and pending.receiving_user_id == buyer.pk
    assert pending.amount is None and promise.payload['amount'] is None
    assert intent.rail_data['memo'] not in str(promise.payload)
    assert e['payment']['txid'] not in str(promise.payload)
    assert 'credited once' not in pending.message()
    assert Transfer.objects.count() == before and not ZecCreditReceipt.objects.exists()
    from django.db import connection
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM procrastinate_jobs WHERE task_name = 'jobs.publish_outbox'")
        assert cursor.fetchone()[0] == 1
    adapter.handle_event(e, Verifier(), role='settle')
    adapter.handle_event(phase(e, 'confirmed'), Verifier(), role='capture')
    assert Event.objects.filter(type='ZEC_PENDING').count() == 1
    assert Event.objects.filter(type='BOUGHT_TUZI').count() == 1
    buyer.refresh_from_db()
    assert buyer.tuzis == 100


def test_notification_outage_does_not_block_later_buyers_and_idle_sweep_recovers(purchase, creator_factory, monkeypatch):
    from dj.apps.jobs import outbox, tasks
    from dj.apps.events.models import Event
    from dj.apps.tuzis.models import ZecPendingNotice
    buyer, _, e = purchase
    other = creator_factory(tuzis=0)
    other_intent = original_zec_intent(other)
    second = copy.deepcopy(e)
    second['payment']['txid'] = 'cd' * 32
    second['payment']['id'] = f"main:{second['payment']['txid']}:ironwood:0"
    second['payment']['memo_hex'] = other_intent.rail_data['memo'].encode().ljust(512, b'\0').hex()
    original = outbox.enqueue
    def fail(*args, **kwargs):
        raise DatabaseError('outbox unavailable')
    monkeypatch.setattr(outbox, 'enqueue', fail)
    for payment in [e, second]:
        assert adapter.handle_event(phase(payment, 'observed'), Verifier(1), role='capture').status == 'captured'
    first_seen = dict(CapturedZecNote.objects.values_list('pk', 'first_seen_at'))
    assert len(first_seen) == 2 and max(first_seen.values()) <= other_intent.expires_at
    assert ZecNoteDisposition.objects.filter(evidence__payment_notice_eligible=True).count() == 2
    assert not Event.objects.exists() and not ZecPendingNotice.objects.exists()
    assert not ZecCreditReceipt.objects.exists()
    monkeypatch.setattr(outbox, 'enqueue', original)
    monkeypatch.setattr(outbox, 'drain', lambda: {'more': False})
    # Invoke the actual existing periodic sweep: no new wallet event is needed.
    tasks.sweep_outbox_task(timestamp=0)
    tasks.sweep_outbox_task(timestamp=0)
    assert dict(CapturedZecNote.objects.values_list('pk', 'first_seen_at')) == first_seen
    assert set(Event.objects.filter(type='ZEC_PENDING').values_list('receiving_user_id', flat=True)) == {buyer.pk, other.pk}
    assert Event.objects.filter(type='ZEC_PENDING').count() == ZecPendingNotice.objects.count() == 2


@pytest.mark.parametrize('case', ['memo', 'zero', 'revoked', 'receiver', 'credited'])
def test_capture_does_not_announce_unauthorized_or_old_payment(purchase, case):
    from dj.apps.events.models import Event
    _, _, e = purchase
    e = phase(e, 'observed')
    verifier = Verifier(1)
    if case == 'memo':
        e['payment']['memo_hex'] = b'{"act":"buy_2z","id":"other"}'.ljust(512, b'\0').hex()
    elif case == 'amount':
        e['payment']['value_zatoshis'] += 1
    elif case == 'zero':
        e['payment']['value_zatoshis'] = 0
    elif case == 'revoked':
        e = phase(e, 'revoked')
    elif case == 'receiver':
        verifier.verify = lambda event: SimpleNamespace(confirmations=1, receiver_in_scope=False)
    elif case == 'credited':
        adapter.handle_event(phase(e, 'confirmed'), Verifier(), role='settle')
    adapter.handle_event(e, verifier, role='capture')
    assert not Event.objects.filter(type='ZEC_PENDING').exists()


def test_capture_final_proof_failure_rolls_back_notice_only(purchase):
    from dj.apps.events.models import Event
    _, _, e = purchase
    verifier = Verifier(1)
    verifier.fail_at = 2
    with pytest.raises(PaymentEvidenceError):
        adapter.handle_event(phase(e, 'observed'), verifier, role='capture')
    assert CapturedZecNote.objects.count() == 1
    assert ZecNoteDisposition.objects.filter(kind='observed').exists()
    assert not Event.objects.exists()
    assert not ZecNoteDisposition.objects.filter(evidence__payment_notice_eligible=True).exists()


def test_legacy_capture_notice_failure_preserves_first_seen(purchase, monkeypatch):
    from dj.apps.economy.captured_notes import capture_wallet_note
    from dj.apps.jobs import outbox
    from dj.apps.events.models import Event
    buyer, _, e = purchase
    tx = wallet_note(e)
    tx['confirmations'] = 1
    original = outbox.enqueue
    def fail(*args, **kwargs):
        raise DatabaseError('outbox unavailable')
    monkeypatch.setattr(outbox, 'enqueue', fail)
    assert capture_wallet_note(tx).status == 'pending_confirmation'
    first = CapturedZecNote.objects.get().first_seen_at
    assert not Event.objects.exists()
    monkeypatch.setattr(outbox, 'enqueue', original)
    assert capture_wallet_note(tx).status == 'pending_confirmation'
    assert CapturedZecNote.objects.get().first_seen_at == first
    capture_wallet_note(tx)
    assert Event.objects.filter(type='ZEC_PENDING', receiving_user=buyer, amount__isnull=True).count() == 1
    assert not ZecCreditReceipt.objects.exists()


def test_payment_reference_is_buyer_scoped_and_recovers_fresh_status(purchase, creator_factory):
    from dj.apps.events.models import Event
    from dj.apps.events.serializers import EventSerializer
    from dj.apps.jobs.models import OutboxMessage
    buyer, intent, e = purchase
    adapter.handle_event(phase(e, 'observed'), Verifier(1), role='capture')
    pending = Event.objects.get(type='ZEC_PENDING')
    reference = OutboxMessage.objects.get(payload__type='ZEC_PENDING').payload['payment_reference']
    assert reference == {'payment_id': str(CapturedZecNote.objects.get().pk), 'status': 'pending'}
    other = creator_factory(tuzis=0)
    assert EventSerializer(pending, context={'recipient': other}).data['payment_reference'] is None
    adapter.handle_event(e, Verifier(), role='settle')
    # Even a previously materialized GFK must not return a stale status.
    assert pending.content_object.pk == CapturedZecNote.objects.get().pk  # previously cached immutable note
    assert pending.to_dict()['payment_reference'] == {'payment_id': str(CapturedZecNote.objects.get().pk), 'status': 'credited'}
    credited = OutboxMessage.objects.get(payload__type='BOUGHT_TUZI').payload
    assert credited['payment_reference'] == {'payment_id': str(CapturedZecNote.objects.get().pk), 'status': 'credited'}
    assert set(credited['payment_reference']) == {'payment_id', 'status'}



def test_real_legacy_command_held_note_announces_detection(purchase, monkeypatch):
    from dj.apps.g12f.management.commands import credit_creators
    from dj.apps.events.models import Event
    from zcashrpc import paymentd_mode
    buyer, _, e = purchase
    tx = wallet_note(e)
    tx['confirmations'] = 1
    monkeypatch.setattr(paymentd_mode, 'require_legacy_producer', lambda: None)
    monkeypatch.setattr(credit_creators, 'Client', lambda: SimpleNamespace(
        dummy=False, pending_notes=[tx], recieved_by=lambda address: [], unreadable_pools=lambda: []))
    credit_creators.Command().handle()
    assert Event.objects.filter(type='ZEC_PENDING', receiving_user=buyer, amount__isnull=True).count() == 1
    assert not ZecCreditReceipt.objects.exists()


def test_notification_table_lock_is_bounded_and_capture_keeps_progress(purchase):
    import psycopg
    import time
    from django.db import connection
    from dj.apps.events.models import Event
    _, _, e = purchase
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
        previous = cursor.fetchone()
    with psycopg.connect(**connection.get_connection_params()) as blocker:
        blocker.execute('LOCK TABLE events_event IN ACCESS EXCLUSIVE MODE')
        started = time.monotonic()
        assert adapter.handle_event(phase(e, 'observed'), Verifier(1), role='capture').status == 'captured'
        assert time.monotonic() - started < 3
    assert not Event.objects.exists()
    assert ZecNoteDisposition.objects.filter(evidence__payment_notice_eligible=True).exists()
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
        assert cursor.fetchone() == previous
    assert adapter.captured_notes.recover_payment_notices() == 1
    assert Event.objects.filter(type='ZEC_PENDING').count() == 1


def test_queue_table_lock_does_not_block_capture_after_notice_commit(purchase):
    import psycopg
    import time
    from django.db import connection
    from dj.apps.events.models import Event
    from dj.apps.jobs.models import OutboxMessage
    from dj.apps.tuzis.models import ZecPendingNotice
    from procrastinate.contrib.django.django_connector import DjangoConnector
    from dj.apps.jobs import tasks
    _, _, e = purchase
    assert isinstance(tasks.publish_outbox_task.blueprint.job_manager.connector, DjangoConnector)
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
        previous = cursor.fetchone()
    with psycopg.connect(**connection.get_connection_params()) as blocker:
        blocker.execute('LOCK TABLE procrastinate_jobs IN ACCESS EXCLUSIVE MODE')
        started = time.monotonic()
        assert adapter.handle_event(phase(e, 'observed'), Verifier(1), role='capture').status == 'captured'
        assert .8 < time.monotonic() - started < 3
        # A's notice/outbox committed before optional queue wake failed; B's
        # raw first_seen can advance while the same queue table is still held.
        second = copy.deepcopy(e)
        second['payment']['txid'] = 'de' * 32
        second['payment']['id'] = f"main:{second['payment']['txid']}:ironwood:0"
        assert adapter.handle_event(phase(second, 'observed'), Verifier(1), role='capture').status == 'captured'
        assert CapturedZecNote.objects.count() == 2
        assert CapturedZecNote.objects.order_by('first_seen_at').last().first_seen_at > CapturedZecNote.objects.order_by('first_seen_at').first().first_seen_at
    assert Event.objects.filter(type='ZEC_PENDING').count() == ZecPendingNotice.objects.count() == 2
    assert OutboxMessage.objects.filter(payload__type='ZEC_PENDING', published_at__isnull=True).count() == 2
    assert not ZecCreditReceipt.objects.exists()
    with connection.cursor() as cursor:
        cursor.execute("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
        assert cursor.fetchone() == previous
    # The existing sweep recovers durable messages even with no next event.
    assert tasks.sweep_outbox_task(timestamp=0)['drained']['published'] == 1
    assert tasks.sweep_outbox_task(timestamp=0)['drained']['published'] == 1
    assert not OutboxMessage.objects.filter(payload__type='ZEC_PENDING', published_at__isnull=True).exists()


def test_worker_pool_connector_skips_unbounded_optional_wake(purchase, monkeypatch):
    from dj.apps.jobs import tasks
    from dj.apps.jobs.models import OutboxMessage
    from dj.apps.events.models import Event
    app = tasks.publish_outbox_task.blueprint
    pool = app.connector.get_worker_connector()
    assert pool.__class__.__name__ == 'PsycopgConnector'
    calls = []
    def unexpected(*args, **kwargs):
        calls.append(1)
        raise AssertionError('payment wake must not access an unbudgeted worker pool')
    monkeypatch.setattr(app.job_manager, 'defer_job', unexpected)
    with app.replace_connector(pool):
        _, _, e = purchase
        assert adapter.handle_event(phase(e, 'observed'), Verifier(1), role='capture').status == 'captured'
        assert Event.objects.filter(type='ZEC_PENDING').count() == 1
        assert OutboxMessage.objects.filter(payload__type='ZEC_PENDING', published_at__isnull=True).count() == 1
        assert tasks.sweep_outbox_task(timestamp=0)['drained']['published'] == 1
    assert calls == []


def test_queue_connector_wrong_django_alias_skips_optional_wake(purchase, monkeypatch):
    from procrastinate.contrib.django.django_connector import DjangoConnector
    from django.db import connections
    from dj.apps.jobs import tasks
    app = tasks.publish_outbox_task.blueprint
    monkeypatch.setitem(connections.databases, 'payment-wake-other', dict(connections.databases['default']))
    calls = []
    def unexpected(*args, **kwargs):
        calls.append(1)
        raise AssertionError('payment wake must use the budgeted Django alias')
    monkeypatch.setattr(app.job_manager, 'defer_job', unexpected)
    with app.replace_connector(DjangoConnector(alias='payment-wake-other')):
        _, _, e = purchase
        assert adapter.handle_event(phase(e, 'observed'), Verifier(1), role='capture').status == 'captured'
    assert calls == []
    connections['payment-wake-other'].close()
