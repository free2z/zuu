"""Read-only backend queues: an acknowledged hook does not necessarily mean paid."""
import json
import hashlib
import os
import re
import sqlite3
import sys
import tempfile
import time
from datetime import UTC

from django.core.management.base import BaseCommand, CommandError

from dj.apps.g12f.paymentd_protocol import PaymentEvidenceError
from dj.apps.g12f.paymentd_runtime import require_runtime
from django.db import DatabaseError, connection, transaction
from django.db.models import Count, Exists, Min, OuterRef, Q
from dj.apps.economy.models import CapturedZecNote, ZecNoteDisposition
from dj.apps.tuzis.models import ZecCreditReceipt, ZecMemoDisposition
from dj.apps.tuzis.zec import unresolved_unbacked_credits


def backend_status():
    facts = ZecNoteDisposition.objects.filter(note_id=OuterRef('pk'))
    retry_reasons = ['global_unbacked_credit_brake','economic_writers_fenced']
    pending = facts.filter(kind='pending_resolution')
    notes = CapturedZecNote.objects.annotate(
        issued=Exists(facts.filter(kind__in=['issued','legacy_issued'])),
        adopted=Exists(facts.filter(kind='legacy_issued')),
        revoked=Exists(facts.filter(kind='revoked')),
        manual=Exists(pending.filter(Q(evidence__reason__isnull=True)
            | ~Q(evidence__reason__in=retry_reasons))),
        retryable=Exists(pending.filter(evidence__reason__in=retry_reasons)),
        waiting=Exists(facts.filter(kind='pending_confirmation')),
        nonpurchase=Exists(facts.filter(kind='observed',evidence__paymentd_outcome='observed_nonpurchase')),
        resolved=Exists(facts.filter(kind='observed',evidence__paymentd_outcome='resolved_observation')),
        zero=Exists(facts.filter(kind='ignored_zero')))
    unsettled=Q(issued=False,revoked=False,manual=False,zero=False,nonpurchase=False,resolved=False)
    # One statement gives these lifecycle counters one PostgreSQL snapshot.
    counts=notes.aggregate(
        captured_unsettled=Count('pk',filter=unsettled),
        oldest_captured_unsettled_at=Min('first_seen_at',filter=unsettled),
        pending_confirmations=Count('pk',filter=unsettled & Q(waiting=True)),
        retryable_settlements=Count('pk',filter=unsettled & Q(retryable=True)),
        pending_resolution=Count('pk',filter=Q(issued=False,revoked=False,manual=True,nonpurchase=False,resolved=False)),
        issued_notes=Count('pk',filter=Q(issued=True)),
        adopted_notes=Count('pk',filter=Q(adopted=True)),
        new_issuance_notes=Count('pk',filter=Q(issued=True,adopted=False)),
        issued_under_review=Count('pk',filter=Q(issued=True,revoked=True)),
        retracted_unissued=Count('pk',filter=Q(issued=False,revoked=True)),
        ignored_zero=Count('pk',filter=Q(zero=True)),
        completed_nonpurchase=Count('pk',filter=Q(issued=False,revoked=False,zero=False,nonpurchase=True)),
        operator_resolved=Count('pk',filter=Q(issued=False,revoked=False,zero=False,resolved=True)))
    oldest=counts['oldest_captured_unsettled_at']
    counts['oldest_captured_unsettled_at']=oldest.astimezone(UTC).isoformat().replace('+00:00','Z') if oldest else None
    return {
        'schema_version':1,
        'funding_adapter':'captured-notes-v1',
        # Observed-but-unsettled includes confirmed work awaiting retry. Do not
        # pretend this is a chain-depth metric or infer paid from hook ACKs.
        **counts,
        'unresolved_memo_dispositions':ZecMemoDisposition.objects.filter(decision__isnull=True).count(),
        'unresolved_unbacked_credits':unresolved_unbacked_credits().count(),
    }


HANDOFF_INPUT_LIMIT = 512 * 1024
HANDOFF_REF_LIMIT = 1000
HANDOFF_STREAM_INPUT_LIMIT = 4 * 1024 * 1024 * 1024
HANDOFF_STREAM_LINE_LIMIT = 4096
HANDOFF_STREAM_SECONDS = 120


def parse_handoff_revocations(raw):
    """Validate private coordinates without including input in diagnostics."""
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate field')
            result[key] = value
        return result
    if len(raw) > HANDOFF_INPUT_LIMIT:
        raise ValueError('input bound exceeded')
    value = json.loads(raw, object_pairs_hook=pairs)
    if not isinstance(value, dict) or set(value) != {'schema', 'revocations'}:
        raise ValueError('invalid envelope')
    if type(value['schema']) is not int or value['schema'] != 1:
        raise ValueError('invalid schema')
    refs = value['revocations']
    if not isinstance(refs, list) or len(refs) > HANDOFF_REF_LIMIT:
        raise ValueError('invalid reference count')
    seen = set()
    fields = {'network', 'txid', 'pool', 'output_index', 'event_id', 'revision', 'journal_sequence'}
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) != fields:
            raise ValueError('invalid reference fields')
        if ref['network'] not in ('main', 'test') or ref['pool'] not in ('sapling', 'orchard', 'ironwood'):
            raise ValueError('invalid network or pool')
        if not isinstance(ref['txid'], str) or re.fullmatch('[0-9a-f]{64}', ref['txid']) is None:
            raise ValueError('invalid transaction identity')
        for field, low, high in [('output_index', 0, 2**32-1), ('revision', 1, 2**32-1), ('journal_sequence', 1, 2**63-1)]:
            if type(ref[field]) is not int or not low <= ref[field] <= high:
                raise ValueError('invalid coordinate integer')
        expected = f"{ref['network']}:{ref['txid']}:{ref['pool']}:{ref['output_index']}:{ref['revision']}:revoked"
        if ref['event_id'] != expected or expected in seen:
            raise ValueError('invalid or duplicate event identity')
        seen.add(expected)
    return refs


def handoff_revocation_status(refs):
    """Read-only refusal: timestamps cannot establish immutable reorg lineage.

    Legacy receipts have no network field. Matching either network is therefore
    conservative. A blank pool cannot prove which output coordinates were used.
    This does not waive, adopt or resolve any receipt or native event.
    """
    matches = set()
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION READ ONLY')
            cursor.execute("SET LOCAL statement_timeout = '5000ms'")
        # Bound each indexed transaction lookup; avoid a 1000-term OR tree.
        by_tx = {}
        for ref in refs:
            by_tx.setdefault(ref['txid'], set()).add((ref['pool'], ref['output_index']))
        rows = ZecCreditReceipt.objects.filter(
            txid__in=list(by_tx), vanish_resolved_at__isnull=False
        ).values_list('pk', 'txid', 'pool', 'output_index')
        # A bounded result prevents an unexpected legacy table shape becoming
        # an unbounded preactivation scan. Too many matches refuse, never waive.
        bounded_rows = list(rows[:HANDOFF_REF_LIMIT + 1])
        if len(bounded_rows) > HANDOFF_REF_LIMIT:
            raise ValueError('matching receipt bound exceeded')
        for pk, txid, pool, index in bounded_rows:
            if not pool or (pool, index) in by_tx[txid]:
                matches.add(pk)
    return {'schema': 1, 'checked_revocations': len(refs),
        'already_resolved_legacy_receipts': len(matches), 'ready': not matches}


def _strict_json(line):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result: raise ValueError('duplicate field')
            result[key]=value
        return result
    value=json.loads(line,object_pairs_hook=pairs)
    if not isinstance(value,dict): raise ValueError('expected object')
    return value


def stage_handoff_stream(source):
    """Verify both native streams completely into a private disk-backed index."""
    fd,path=tempfile.mkstemp(prefix='paymentd-handoff-',suffix='.sqlite')
    os.fchmod(fd,0o600);os.close(fd)
    db=sqlite3.connect(path)
    db.execute('PRAGMA temp_store=FILE')
    db.execute('PRAGMA cache_size=-2048')
    db.execute('CREATE TABLE refs(event_id TEXT PRIMARY KEY,network TEXT NOT NULL,txid TEXT NOT NULL,pool TEXT NOT NULL,output_index INTEGER NOT NULL,revision INTEGER NOT NULL,journal_sequence INTEGER NOT NULL)')
    db.execute('CREATE INDEX refs_txid ON refs(txid)')
    db.execute('CREATE INDEX refs_coordinate ON refs(txid,pool,output_index)')
    aggregate=hashlib.sha256(); total_bytes=0; total_records=0
    expected_profiles=('current','legacy'); profile_index=0; phase='profile'
    current=None; stream_hash=None; stream_count=0; previous_key=None; completed=False
    deadline=time.monotonic()+HANDOFF_STREAM_SECONDS
    try:
        while True:
            if time.monotonic()>=deadline: raise ValueError('handoff stream deadline exceeded')
            line=source.readline(HANDOFF_STREAM_LINE_LIMIT+1)
            if not line: break
            if isinstance(line,str): line=line.encode('utf-8')
            if len(line)>HANDOFF_STREAM_LINE_LIMIT or not line.endswith(b'\n'):
                raise ValueError('handoff stream line bound or framing invalid')
            total_bytes+=len(line)
            if total_bytes>HANDOFF_STREAM_INPUT_LIMIT: raise ValueError('handoff stream resource bound exceeded')
            value=_strict_json(line)
            kind=value.get('type')
            if kind=='complete':
                if completed or phase!='profile' or profile_index!=2 or set(value)!={'type','profiles','source_stream_sha256'}:
                    raise ValueError('incomplete profile stream')
                if type(value['profiles']) is not int or value['profiles']!=2 or value['source_stream_sha256']!=aggregate.hexdigest():
                    raise ValueError('aggregate handoff stream proof mismatch')
                if source.readline(1): raise ValueError('trailing handoff stream bytes')
                completed=True
                break
            aggregate.update(line)
            if kind=='profile':
                if phase!='profile' or set(value)!={'type','profile'} or profile_index>=2:
                    raise ValueError('profile marker order invalid')
                if value['profile']!=expected_profiles[profile_index]: raise ValueError('profile marker identity invalid')
                current=value['profile'];phase='header';stream_hash=hashlib.sha256();stream_count=0;previous_key=None
            elif kind=='header':
                fields={'schema','identity_sha256','inventory_sha256','boundary_sequence','receipt_count','event_count',
                    'inventory_bytes','configured_consumers','eligible_deliveries','existing_deliveries','existing_acked',
                    'existing_pending','missing_deliveries','subscription_count'}
                if (phase!='header' or set(value)!={'type','protocol','proof','revocation_count'}
                    or type(value['protocol']) is not int or value['protocol']!=1):
                    raise ValueError('native stream header invalid')
                proof=value['proof']
                if not isinstance(proof,dict) or set(proof)!=fields or type(proof['schema']) is not int or proof['schema']!=1:
                    raise ValueError('native coverage proof schema invalid')
                if any(type(proof[k]) is not int or proof[k]<0 for k in fields-{'schema','identity_sha256','inventory_sha256'}):
                    raise ValueError('native coverage counts invalid')
                if not re.fullmatch('[0-9a-f]{64}',proof['identity_sha256']) or not re.fullmatch('[0-9a-f]{64}',proof['inventory_sha256']):
                    raise ValueError('native coverage digest invalid')
                if (proof['configured_consumers']!=2 or proof['existing_deliveries']!=proof['existing_acked']+proof['existing_pending']
                    or proof['existing_deliveries']+proof['missing_deliveries']!=proof['eligible_deliveries']
                    or proof['eligible_deliveries']>2*proof['event_count']
                    or proof['inventory_bytes']>4*1024*1024*1024
                    or type(value['revocation_count']) is not int or not 0<=value['revocation_count']<=2**63-1):
                    raise ValueError('native coverage accounting invalid')
                current={'profile':current,'proof':proof,'count':value['revocation_count']}
                phase='records'
            elif kind=='revocation':
                fields={'type','network','txid','pool','output_index','event_id','revision','journal_sequence'}
                if phase!='records' or set(value)!=fields: raise ValueError('revocation record outside stream')
                if (value['network'] not in ('main','test') or value['pool'] not in ('sapling','orchard','ironwood')
                    or not isinstance(value['txid'],str) or not re.fullmatch('[0-9a-f]{64}',value['txid'])
                    or type(value['output_index']) is not int or not 0<=value['output_index']<=2**32-1
                    or type(value['revision']) is not int or not 1<=value['revision']<=2**32-1
                    or type(value['journal_sequence']) is not int
                    or not 1<=value['journal_sequence']<=current['proof']['boundary_sequence']):
                    raise ValueError('revocation coordinates invalid')
                expected=f"{value['network']}:{value['txid']}:{value['pool']}:{value['output_index']}:{value['revision']}:revoked"
                key=(value['journal_sequence'],value['event_id'])
                if value['event_id']!=expected or (previous_key is not None and key<=previous_key):
                    raise ValueError('revocation identity or order invalid')
                previous_key=key; stream_hash.update(line);stream_count+=1;total_records+=1
                prior=db.execute('SELECT network,txid,pool,output_index,revision,journal_sequence FROM refs WHERE event_id=?',(value['event_id'],)).fetchone()
                if prior is None:
                    db.execute('INSERT INTO refs VALUES(?,?,?,?,?,?,?)',(value['event_id'],value['network'],value['txid'],value['pool'],value['output_index'],value['revision'],value['journal_sequence']))
                else:
                    if prior[:5]!=(value['network'],value['txid'],value['pool'],value['output_index'],value['revision']):
                        raise ValueError('duplicate event identity conflicts across profiles')
                    db.execute('UPDATE refs SET journal_sequence=min(journal_sequence,?) WHERE event_id=?',(value['journal_sequence'],value['event_id']))
            elif kind=='footer':
                if phase!='records' or set(value)!={'type','protocol','revocation_count','revocation_sha256','boundary_sequence','inventory_sha256','identity_sha256'}:
                    raise ValueError('native stream footer invalid')
                proof=current['proof']
                if (type(value['protocol']) is not int or value['protocol']!=1 or type(value['revocation_count']) is not int
                    or value['revocation_count']!=current['count'] or stream_count!=current['count']
                    or value['revocation_sha256']!=stream_hash.hexdigest()
                    or type(value['boundary_sequence']) is not int or value['boundary_sequence']!=proof['boundary_sequence']
                    or not isinstance(value['inventory_sha256'],str) or not isinstance(value['identity_sha256'],str)
                    or value['inventory_sha256']!=proof['inventory_sha256']
                    or value['identity_sha256']!=proof['identity_sha256']):
                    raise ValueError('native stream footer does not prove full coverage')
                phase='profile';profile_index+=1;current=None
            else:
                raise ValueError('unknown handoff stream record')
        if not completed or profile_index!=2 or phase!='profile': raise ValueError('handoff stream ended before aggregate completion')
        db.commit()
        return path,db,total_records
    except BaseException:
        db.close();os.unlink(path);raise


def handoff_revocation_status_stream(path, db, total_records):
    """Check a complete staged revocation set using bounded indexed batches."""
    matched=0;last_tx='';deadline=time.monotonic()+HANDOFF_STREAM_SECONDS
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION READ ONLY')
            cursor.execute("SET LOCAL statement_timeout = '5000ms'")
        while True:
            if time.monotonic()>=deadline: raise ValueError('legacy guard deadline exceeded')
            txids=[row[0] for row in db.execute('SELECT txid FROM refs WHERE txid>? GROUP BY txid ORDER BY txid LIMIT 300',(last_tx,))]
            if not txids: break
            last_tx=txids[-1]
            rows=ZecCreditReceipt.objects.filter(txid__in=txids,vanish_resolved_at__isnull=False).values_list('txid','pool','output_index').iterator(chunk_size=300)
            for txid,pool,index in rows:
                if time.monotonic()>=deadline: raise ValueError('legacy guard deadline exceeded')
                # A legacy receipt with no pool has no trustworthy output
                # coordinate. Conservatively match every native revocation
                # for its txid, as the pre-stream guard did.
                if not pool:
                    found=db.execute('SELECT 1 FROM refs INDEXED BY refs_txid WHERE txid=? LIMIT 1',(txid,)).fetchone()
                else:
                    found=db.execute('SELECT 1 FROM refs INDEXED BY refs_coordinate WHERE txid=? AND pool=? AND output_index=? LIMIT 1',
                        (txid,pool,index)).fetchone()
                if found: matched+=1
    unique=db.execute('SELECT count(*) FROM refs').fetchone()[0]
    return {'schema':2,'checked_revocations':unique,'source_revocation_records':total_records,
            'already_resolved_legacy_receipts':matched,'ready':matched==0}



class Command(BaseCommand):
    help = 'Read paymentd funding queue counts without changing receipts or balances.'

    def add_arguments(self, parser):
        parser.add_argument('--json', action='store_true')
        parser.add_argument('--check-handoff-revocations', action='store_true')
        parser.add_argument('--check-handoff-stream', action='store_true')
        parser.add_argument('--handoff-capabilities', action='store_true')

    def handle(self, *args, **options):
        try:
            require_runtime(writes=False)
            if options.get('handoff_capabilities'):
                result = {'schema': 1, 'stream_protocol': 1, 'guard_schema': 2}
            elif options.get('check_handoff_revocations'):
                source = getattr(sys.stdin, 'buffer', sys.stdin)
                raw = source.read(HANDOFF_INPUT_LIMIT + 1)
                if isinstance(raw, str):
                    raw = raw.encode('utf-8')
                refs = parse_handoff_revocations(raw)
                result = handoff_revocation_status(refs)
            elif options.get('check_handoff_stream'):
                source=getattr(sys.stdin,'buffer',sys.stdin)
                path,staged,total=stage_handoff_stream(source)
                try:
                    result=handoff_revocation_status_stream(path,staged,total)
                finally:
                    staged.close();os.unlink(path)
            else:
                result = backend_status()
        except (OSError, PaymentEvidenceError, ValueError, TypeError, UnicodeError, DatabaseError, RecursionError) as exc:
            raise CommandError('paymentd backend status is unavailable') from exc
        self.stdout.write(json.dumps(result, sort_keys=True))
        if result.get('ready') is False:
            raise CommandError('paymentd handoff requires explicit legacy reorg lineage reconciliation')
