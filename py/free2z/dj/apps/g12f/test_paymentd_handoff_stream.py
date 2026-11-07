"""Complete streaming handoff verification, including legacy receipt overlap."""
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.tuzis.models import ZecCreditReceipt
from dj.apps.g12f.test_paymentd_credit_status import assert_readonly, revoke_ref


def test_handoff_capabilities_describe_the_readonly_stream_guard(monkeypatch):
    import io
    import json
    from django.core.management import call_command
    from dj.apps.g12f.management.commands import paymentd_credit_status as command

    monkeypatch.setattr(command, 'require_runtime', lambda *, writes: assert_readonly(writes))
    output = io.StringIO()
    call_command('paymentd_credit_status', '--handoff-capabilities', stdout=output)
    assert json.loads(output.getvalue()) == {'schema': 1, 'stream_protocol': 1, 'guard_schema': 2}


def _native_handoff_stream(*, omit_record=False, corrupt_digest=False, boundary_delta=0,
                            omit_footer=False, reorder=False, bool_protocol=False,
                            omit_complete=False, duplicate_complete=False,
                            trailing_bytes=False, truncate_complete=False):
    import hashlib
    import json
    ref_a=revoke_ref('a'*64,'ironwood',0)
    ref_b=revoke_ref('b'*64,'orchard',1)
    refs=[ref_b,ref_a] if reorder else [ref_a,ref_b]
    if omit_record: refs=[]
    lines=[]
    for profile in ('current','legacy'):
        marker={'type':'profile','profile':profile}
        proof={'schema':1,'identity_sha256':'1'*64,'inventory_sha256':'2'*64,
            'boundary_sequence':20,'receipt_count':2,'event_count':4,'inventory_bytes':4096,
            'configured_consumers':2,'eligible_deliveries':2,'existing_deliveries':0,
            'existing_acked':0,'existing_pending':0,'missing_deliveries':2,'subscription_count':0}
        header={'type':'header','protocol':True if bool_protocol else 1,'proof':proof,'revocation_count':2}
        record_lines=[(json.dumps({'type':'revocation',**ref},sort_keys=True,separators=(',',':'))+'\n').encode() for ref in refs]
        digest=hashlib.sha256(b''.join(record_lines)).hexdigest()
        if corrupt_digest: digest='0'*64
        footer={'type':'footer','protocol':1,'revocation_count':2,'revocation_sha256':digest,
            'boundary_sequence':proof['boundary_sequence']+boundary_delta,
            'inventory_sha256':proof['inventory_sha256'],'identity_sha256':proof['identity_sha256']}
        stream=[(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode() for value in (header,)]
        stream.extend(record_lines)
        if not omit_footer: stream.append((json.dumps(footer,sort_keys=True,separators=(',',':'))+'\n').encode())
        lines.append((json.dumps(marker,sort_keys=True,separators=(',',':'))+'\n').encode()+b''.join(stream))
    aggregate=b''.join(lines)
    complete={'type':'complete','profiles':2,'source_stream_sha256':hashlib.sha256(aggregate).hexdigest()}
    encoded=(json.dumps(complete,sort_keys=True,separators=(',',':'))+'\n').encode()
    if truncate_complete: encoded=encoded[:-2]
    result=aggregate+(b'' if omit_complete else encoded)
    if duplicate_complete: result+=encoded
    if trailing_bytes: result+=b'{}\n'
    return result


def test_stream_guard_accepts_complete_coverage_and_rejects_partial_or_changed_boundary():
    import io
    import os
    from dj.apps.g12f.management.commands.paymentd_credit_status import stage_handoff_stream
    path,db,total=stage_handoff_stream(io.BytesIO(_native_handoff_stream()))
    try:
        assert total==4
        assert db.execute('SELECT count(*) FROM refs').fetchone()[0]==2
        txid_plan=' '.join(row[3] for row in db.execute('EXPLAIN QUERY PLAN SELECT txid FROM refs WHERE txid>? GROUP BY txid ORDER BY txid LIMIT 300',('',)))
        coordinate_plan=' '.join(row[3] for row in db.execute('EXPLAIN QUERY PLAN SELECT 1 FROM refs WHERE txid=? AND pool=? AND output_index=? LIMIT 1',('a'*64,'ironwood',0)))
        assert 'refs_txid' in txid_plan
        assert 'refs_coordinate' in coordinate_plan
        wildcard_plan=' '.join(row[3] for row in db.execute('EXPLAIN QUERY PLAN SELECT 1 FROM refs INDEXED BY refs_txid WHERE txid=? LIMIT 1',('a'*64,)))
        assert 'refs_txid' in wildcard_plan
    finally:
        db.close();os.unlink(path)
    for options in ({'omit_record':True},{'corrupt_digest':True},{'boundary_delta':1},
                    {'omit_footer':True},{'reorder':True},{'bool_protocol':True},
                    {'omit_complete':True},{'truncate_complete':True},
                    {'duplicate_complete':True},{'trailing_bytes':True}):
        with pytest.raises(ValueError):
            stage_handoff_stream(io.BytesIO(_native_handoff_stream(**options)))


def _stream_with_profile_refs(profile_refs):
    import hashlib, json
    lines=[]
    proof={'schema':1,'identity_sha256':'1'*64,'inventory_sha256':'2'*64,
        'boundary_sequence':20,'receipt_count':2,'event_count':4,'inventory_bytes':4096,
        'configured_consumers':2,'eligible_deliveries':2,'existing_deliveries':0,
        'existing_acked':0,'existing_pending':0,'missing_deliveries':2,'subscription_count':0}
    for profile,refs in zip(('current','legacy'),profile_refs):
        marker={'type':'profile','profile':profile}
        encoded_refs=[(json.dumps({'type':'revocation',**ref},sort_keys=True,separators=(',',':'))+'\n').encode() for ref in refs]
        header={'type':'header','protocol':1,'proof':proof,'revocation_count':len(refs)}
        footer={'type':'footer','protocol':1,'revocation_count':len(refs),
            'revocation_sha256':hashlib.sha256(b''.join(encoded_refs)).hexdigest(),
            'boundary_sequence':20,'inventory_sha256':proof['inventory_sha256'],'identity_sha256':proof['identity_sha256']}
        section=[marker,header]
        lines.append(b''.join((json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode() for value in section)
            +b''.join(encoded_refs)+(json.dumps(footer,sort_keys=True,separators=(',',':'))+'\n').encode())
    aggregate=b''.join(lines)
    complete={'type':'complete','profiles':2,'source_stream_sha256':hashlib.sha256(aggregate).hexdigest()}
    return aggregate+(json.dumps(complete,sort_keys=True,separators=(',',':'))+'\n').encode()


@pytest.mark.django_db(transaction=True)
def test_stream_command_keeps_blank_pool_conservative_across_profiles_and_coordinates(creator_factory, monkeypatch):
    import io, json
    from django.core.management import call_command
    from django.core.management.base import CommandError
    from dj.apps.g12f.management.commands import paymentd_credit_status as command
    user=creator_factory(); now=timezone.now()
    receipt_rows=[('a'*64,'',42),('b'*64,'orchard',3),('c'*64,'sapling',7)]
    for txid,pool,index in receipt_rows:
        ZecCreditReceipt.objects.create(txid=txid,pool=pool,output_index=index,creator=user,
            amount_zec=Decimal('.00909007'),vanished_at=now,vanish_resolved_at=now)
    refs=[revoke_ref('a'*64,'ironwood',0),revoke_ref('b'*64,'orchard',3),revoke_ref('c'*64,'orchard',4)]
    stream=_stream_with_profile_refs(([refs[0],refs[2]],[refs[1]]))
    monkeypatch.setattr(command,'require_runtime',lambda *,writes:assert_readonly(writes))
    monkeypatch.setattr(command.sys,'stdin',io.BytesIO(stream))
    output=io.StringIO()
    with pytest.raises(CommandError,match='explicit legacy reorg lineage reconciliation'):
        call_command('paymentd_credit_status',check_handoff_stream=True,stdout=output)
    result=json.loads(output.getvalue())
    assert result['already_resolved_legacy_receipts']==2
    assert result['source_revocation_records']==3
    assert result['checked_revocations']==3

    # With only a populated pool and a different output coordinate, a native
    # revocation is not a match for the legacy receipt.
    monkeypatch.setattr(command.sys,'stdin',io.BytesIO(_stream_with_profile_refs(([refs[2]],[]))))
    output=io.StringIO()
    call_command('paymentd_credit_status',check_handoff_stream=True,stdout=output)
    assert json.loads(output.getvalue())['ready'] is True


@pytest.mark.django_db(transaction=True)
def test_indexed_stream_guard_traverses_multiple_large_txid_batches(creator_factory):
    import io, os
    from dj.apps.g12f.management.commands.paymentd_credit_status import (
        handoff_revocation_status_stream, stage_handoff_stream,
    )
    user=creator_factory(); now=timezone.now(); refs=[]; receipts=[]
    for index in range(1_200):
        txid=f'{index+1:064x}'
        refs.append(revoke_ref(txid,'ironwood',0))
        if index<300:
            pool,output_index='',42  # blank legacy pool matches any output
        elif index<600:
            pool,output_index='ironwood',0  # exact indexed coordinate
        elif index<900:
            pool,output_index='orchard',7  # populated coordinate does not match
        else:
            continue
        receipts.append(ZecCreditReceipt(txid=txid,pool=pool,output_index=output_index,
            creator=user,amount_zec=Decimal('.00909007'),vanished_at=now,vanish_resolved_at=now))
    ZecCreditReceipt.objects.bulk_create(receipts)
    path,db,total=stage_handoff_stream(io.BytesIO(_stream_with_profile_refs((refs,refs))))
    try:
        result=handoff_revocation_status_stream(path,db,total)
        assert result=={'schema':2,'checked_revocations':1_200,'source_revocation_records':2_400,
            'already_resolved_legacy_receipts':600,'ready':False}
    finally:
        db.close();os.unlink(path)


@pytest.mark.parametrize('input_kind', ['partial-line', 'complete-without-eof', 'oversized-line'])
def test_stream_pipe_deadline_and_line_bound_without_waiting_for_writer_close(input_kind, monkeypatch):
    import os
    import threading
    import time
    from dj.apps.g12f.management.commands import paymentd_credit_status as command

    if input_kind == 'partial-line':
        payload = b'{"type":"profile"'
    elif input_kind == 'complete-without-eof':
        payload = _native_handoff_stream()
    else:
        payload = b'x' * (command.HANDOFF_STREAM_LINE_LIMIT + 1)
    monkeypatch.setattr(command, 'HANDOFF_STREAM_SECONDS', 0.15)
    read_fd, write_fd = os.pipe()
    release_writer = threading.Event()

    def writer():
        try:
            pending = memoryview(payload)
            while pending:
                pending = pending[os.write(write_fd, pending):]
            # Bound a broken implementation too: the old blocking readline
            # completes only when this guard expires and must fail the test.
            release_writer.wait(2)
        except BrokenPipeError:
            pass
        finally:
            os.close(write_fd)

    producer = threading.Thread(target=writer, daemon=True)
    producer.start()
    started = time.monotonic()
    try:
        with os.fdopen(read_fd, 'rb') as source:
            expected = 'line bound' if input_kind == 'oversized-line' else 'deadline exceeded'
            with pytest.raises(ValueError, match=expected):
                command.stage_handoff_stream(source)
        assert time.monotonic() - started < 1.5
        assert not release_writer.is_set()
    finally:
        release_writer.set()
        producer.join(timeout=3)
        assert not producer.is_alive()
