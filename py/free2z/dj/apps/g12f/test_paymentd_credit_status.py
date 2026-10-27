"""Actual backend queue counts remain distinct from hook acknowledgements."""
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.g12f.management.commands.paymentd_credit_status import backend_status
from dj.apps.tuzis.models import IdempotencyKey, ZecCreditReceipt, ZecMemoDisposition


@pytest.mark.django_db
def test_pending_and_reorg_counts_are_readonly_and_durable(creator_factory):
    empty = backend_status()
    assert empty['funding_adapter'] == 'captured-notes-v1'
    assert empty['pending_confirmations'] == 0
    assert empty['pending_resolution'] == 0
    assert empty['issued_notes'] == 0
    user=creator_factory()
    for index,status in enumerate(['pending_confirmation','pending_resolution','issued']):
        IdempotencyKey.objects.create(scope='zec-funding-note',key=str(index),user=user,
            response_status=200,response_body={'status':status,'reason':'test'})
    IdempotencyKey.objects.create(scope='other',key='other',user=user,
        response_body={'status':'pending_resolution'})
    ZecCreditReceipt.objects.create(txid='a'*64,pool='ironwood',output_index=0,
        creator=user,amount_zec=Decimal('.00909007'),vanished_at=timezone.now())
    ZecCreditReceipt.objects.create(txid='b'*64,pool='orchard',output_index=0,
        creator=user,amount_zec=Decimal('.00909007'),vanished_at=timezone.now(),vanish_resolved_at=timezone.now())
    ZecMemoDisposition.objects.create(txid='c'*64,pool='ironwood',output_index=0,amount_zec=Decimal('.00909007'))
    before=(IdempotencyKey.objects.count(),ZecCreditReceipt.objects.count(),ZecMemoDisposition.objects.count())
    expected={'schema_version':1,'funding_adapter':'captured-notes-v1',
        'pending_confirmations':0,'pending_resolution':0,'retryable_settlements':0,'captured_unsettled':0,'oldest_captured_unsettled_at':None,
        'issued_notes':0,'adopted_notes':0,'new_issuance_notes':0,'issued_under_review':0,'retracted_unissued':0,'ignored_zero':0,'completed_nonpurchase':0,'operator_resolved':0,'unresolved_memo_dispositions':1,'unresolved_unbacked_credits':1}
    assert backend_status()==expected
    assert backend_status()==expected
    assert (IdempotencyKey.objects.count(),ZecCreditReceipt.objects.count(),ZecMemoDisposition.objects.count())==before


@pytest.mark.django_db(transaction=True)
def test_oldest_unsettled_uses_backend_time_with_current_lifecycle_exclusions():
    from dj.apps.economy import captured_notes
    from dj.apps.economy.models import CapturedZecNote, ZecNoteDisposition
    from datetime import UTC
    def capture(tx):
        return captured_notes.ingest_zec_note(txid=tx*64,pool='ironwood',output_index=0,
            amount_zatoshi=1,memo_hex=b'ordinary donation'.ljust(512,b'\0').hex(),
            source={'source_kind':'status-fixture','source_reference':f'note:{tx}'})
    a=capture('a');b=capture('b')
    iso=lambda dt:dt.astimezone(UTC).isoformat().replace('+00:00','Z')
    assert backend_status()['oldest_captured_unsettled_at']==iso(a.first_seen_at)
    ZecNoteDisposition.objects.create(note=a,event_key='completed-nonpurchase',kind='observed',
        evidence={'paymentd_outcome':'observed_nonpurchase'})
    assert backend_status()['oldest_captured_unsettled_at']==iso(b.first_seen_at)
    ZecNoteDisposition.objects.create(note=b,event_key='manual-queue',kind='pending_resolution',evidence={'reason':'review'})
    assert backend_status()['oldest_captured_unsettled_at'] is None
    c=capture('c')
    ZecNoteDisposition.objects.create(note=c,event_key='resolved-operator',kind='observed',
        evidence={'paymentd_outcome':'resolved_observation'})
    assert backend_status()['oldest_captured_unsettled_at'] is None
    assert CapturedZecNote.objects.count()==3


@pytest.mark.django_db(transaction=True)
def test_terminal_manual_resolution_wins_over_previous_automatic_retry():
    from dj.apps.economy import captured_notes
    from dj.apps.economy.models import ZecNoteDisposition
    note=captured_notes.ingest_zec_note(txid='a'*64,pool='ironwood',output_index=0,
        amount_zatoshi=1,memo_hex=bytes(512).hex(),
        source={'source_kind':'status-fixture','source_reference':'retry-then-manual'})
    ZecNoteDisposition.objects.create(note=note,event_key='temporary-brake',kind='pending_resolution',
        evidence={'reason':'global_unbacked_credit_brake'})
    status=backend_status()
    assert status['captured_unsettled']==1 and status['retryable_settlements']==1
    assert status['oldest_captured_unsettled_at'] is not None
    ZecNoteDisposition.objects.create(note=note,event_key='terminal-manual',kind='pending_resolution',
        evidence={'reason':'purchase_observed_after_expiry'})
    status=backend_status()
    assert status['captured_unsettled']==0 and status['retryable_settlements']==0
    assert status['pending_resolution']==1 and status['oldest_captured_unsettled_at'] is None


def revoke_ref(txid='a'*64, pool='ironwood', index=0, revision=1):
    return {'network':'main','txid':txid,'pool':pool,'output_index':index,
        'event_id':f'main:{txid}:{pool}:{index}:{revision}:revoked',
        'revision':revision,'journal_sequence':2}


@pytest.mark.parametrize('field,value', [
    ('output_index',True), ('output_index',-1), ('output_index',2**32),
    ('revision',False), ('revision',0), ('journal_sequence',True),
    ('journal_sequence',2**63), ('txid','A'*64), ('network','other'),
    ('pool','transparent'), ('event_id','private-invalid-event')])
def test_handoff_guard_rejects_malformed_private_coordinates(field, value):
    import json
    from dj.apps.g12f.management.commands.paymentd_credit_status import parse_handoff_revocations
    ref=revoke_ref();ref[field]=value
    with pytest.raises(ValueError):
        parse_handoff_revocations(json.dumps({'schema':1,'revocations':[ref]}).encode())


def test_handoff_guard_rejects_caps_duplicates_extra_fields_and_boolean_schema():
    import json
    from dj.apps.g12f.management.commands.paymentd_credit_status import parse_handoff_revocations
    ref=revoke_ref()
    bad=[{'schema':True,'revocations':[]}, {'schema':1,'revocations':[ref,ref]},
        {'schema':1,'revocations':[ref]*1001}, {'schema':1,'revocations':[], 'extra':None},
        {'schema':1,'revocations':[{**ref,'memo':'private'}]}]
    for value in bad:
        with pytest.raises(ValueError):
            parse_handoff_revocations(json.dumps(value).encode())
    with pytest.raises(ValueError):
        parse_handoff_revocations(b' '*(512*1024+1))
    with pytest.raises(ValueError):
        parse_handoff_revocations(b'{"schema":1,"schema":1,"revocations":[]}')
    assert parse_handoff_revocations(b'{"schema":1,"revocations":[]}')==[]


@pytest.mark.django_db(transaction=True)
def test_handoff_guard_blocks_resolved_exact_and_unknown_pool_without_writes(creator_factory):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    from dj.apps.g12f.management.commands.paymentd_credit_status import handoff_revocation_status
    user=creator_factory()
    resolved=timezone.now()
    for txid,pool,index,at in [('a'*64,'ironwood',0,resolved),
        ('b'*64,'',42,resolved), ('c'*64,'orchard',0,None),
        ('d'*64,'orchard',9,resolved)]:
        ZecCreditReceipt.objects.create(txid=txid,pool=pool,output_index=index,
            creator=user,amount_zec=Decimal('.00909007'),
            vanished_at=resolved,vanish_resolved_at=at)
    before=list(ZecCreditReceipt.objects.order_by('pk').values())
    refs=[revoke_ref(),revoke_ref('b'*64,'orchard',7),revoke_ref('c'*64,'orchard'),
        revoke_ref('d'*64,'orchard',0),revoke_ref('e'*64)]
    with CaptureQueriesContext(connection) as queries:
        result=handoff_revocation_status(refs)
    assert result=={'schema':1,'checked_revocations':5,'already_resolved_legacy_receipts':2,'ready':False}
    assert all(q['sql'].split()[0] in ('BEGIN','SELECT','SET','COMMIT') for q in queries)
    assert list(ZecCreditReceipt.objects.order_by('pk').values())==before
    # Fresh unmatched coordinates, unresolved incidents and genuinely new
    # reorgs remain deliverable. No resolved timestamp is waived or rewritten.
    assert handoff_revocation_status(refs[2:])=={
        'schema':1,'checked_revocations':3,'already_resolved_legacy_receipts':0,'ready':True}
    assert list(ZecCreditReceipt.objects.order_by('pk').values())==before


@pytest.mark.django_db(transaction=True)
def test_handoff_command_refuses_resolved_legacy_with_sanitized_proof(creator_factory, monkeypatch):
    import io
    import json
    from django.core.management import call_command
    from django.core.management.base import CommandError
    from dj.apps.g12f.management.commands import paymentd_credit_status as command
    user=creator_factory()
    receipt=ZecCreditReceipt.objects.create(txid='a'*64,pool='ironwood',output_index=0,
        creator=user,amount_zec=Decimal('.00909007'),vanished_at=timezone.now(),
        vanish_resolved_at=timezone.now())
    before=dict(ZecCreditReceipt.objects.get(pk=receipt.pk).__dict__)
    monkeypatch.setattr(command,'require_runtime',lambda *,writes:assert_readonly(writes))
    monkeypatch.setattr(command.sys,'stdin',io.StringIO(json.dumps({'schema':1,'revocations':[revoke_ref()]})))
    output=io.StringIO()
    with pytest.raises(CommandError,match='explicit legacy reorg lineage reconciliation'):
        call_command('paymentd_credit_status',check_handoff_revocations=True,stdout=output)
    assert json.loads(output.getvalue())=={
        'schema':1,'checked_revocations':1,'already_resolved_legacy_receipts':1,'ready':False}
    assert 'a'*64 not in output.getvalue() and 'memo' not in output.getvalue()
    after=dict(ZecCreditReceipt.objects.get(pk=receipt.pk).__dict__)
    before.pop('_state');after.pop('_state');assert after==before
    monkeypatch.setattr(command.sys,'stdin',io.StringIO('{"schema":true,"revocations":[]}'))
    bad_output=io.StringIO()
    with pytest.raises(CommandError,match='backend status is unavailable'):
        call_command('paymentd_credit_status',check_handoff_revocations=True,stdout=bad_output)
    assert bad_output.getvalue()==''
    monkeypatch.setattr(command.sys,'stdin',io.StringIO('['*2000+'0'+']'*2000))
    deep_output=io.StringIO()
    with pytest.raises(CommandError,match='backend status is unavailable'):
        call_command('paymentd_credit_status',check_handoff_revocations=True,stdout=deep_output)
    assert deep_output.getvalue()==''



def assert_readonly(writes):
    assert writes is False
