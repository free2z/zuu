"""Read-only backend queues: an acknowledged hook does not necessarily mean paid."""
import json
import re
import sys
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



class Command(BaseCommand):
    help = 'Read paymentd funding queue counts without changing receipts or balances.'

    def add_arguments(self, parser):
        parser.add_argument('--json', action='store_true')
        parser.add_argument('--check-handoff-revocations', action='store_true')

    def handle(self, *args, **options):
        try:
            require_runtime(writes=False)
            if options.get('check_handoff_revocations'):
                source = getattr(sys.stdin, 'buffer', sys.stdin)
                raw = source.read(HANDOFF_INPUT_LIMIT + 1)
                if isinstance(raw, str):
                    raw = raw.encode('utf-8')
                refs = parse_handoff_revocations(raw)
                result = handoff_revocation_status(refs)
            else:
                result = backend_status()
        except (OSError, PaymentEvidenceError, ValueError, TypeError, UnicodeError, DatabaseError, RecursionError) as exc:
            raise CommandError('paymentd backend status is unavailable') from exc
        self.stdout.write(json.dumps(result, sort_keys=True))
        if result.get('ready') is False:
            raise CommandError('paymentd handoff requires explicit legacy reorg lineage reconciliation')
