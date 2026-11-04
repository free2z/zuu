"""Receipt-first backend ingestion, independent of financial policy fences.

Only verified wallet/provider adapters call this internal interface. It does
not attest a shielded sender, execute a memo or accept an earlier observation
time from a daemon. Raw notes remain durable before any policy-bound effect.
"""
import json
import logging
import time
from contextlib import contextmanager
import re
from decimal import Decimal

from django.db import transaction

from . import services as money
from .models import CapturedZecNote, ZecNoteDisposition


def _storable(value):
    if isinstance(value, str):
        return '\x00' not in value and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _storable(k) and _storable(v) for k, v in value.items())
    if isinstance(value, list):
        return all(_storable(item) for item in value)
    return value is None or type(value) in (int, bool, float)


def text_memo(memo_hex):
    """Decode only canonical text+zero padding; never repair embedded bytes."""
    if memo_hex is None:
        return None
    raw = bytes.fromhex(memo_hex)
    if raw[0] >= 0xF5:
        return None
    end = raw.find(b'\0')
    if end >= 0:
        if any(raw[end:]):
            return None
        raw = raw[:end]
    try:
        plain = raw.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        return None
    if not _storable(plain):
        return None
    # JSON escapes can decode to NUL/surrogates even when raw ASCII is valid.
    try:
        decoded = json.loads(plain,object_pairs_hook=lambda pairs:[[key,value] for key,value in pairs])
    except (ValueError, RecursionError):
        return plain
    return plain if _storable(decoded) else None


def _legacy_issued(note):
    """Exact original receipt AND original journal; nominal backfills fail."""
    from dj.apps.tuzis.models import ZecCreditReceipt
    from dj.apps.ledger.models import PurchaseRefund
    from .funding import _cursor_issuance_status
    receipt = ZecCreditReceipt.objects.filter(txid=note.txid, pool=note.pool,
        output_index=note.output_index, amount_zec=Decimal(note.amount_zatoshi) / 100_000_000,
        creator__isnull=False, backfilled=False, tuzis_credited__gt=0).first()
    if receipt is None:
        return None
    cursor = PurchaseRefund.objects.filter(ref_kind='zec_receipt', ref_id=str(receipt.pk),
        rail='zec', account__owner_id=receipt.creator_id).first()
    proven = _cursor_issuance_status(cursor, creator_id=receipt.creator_id, rail='zec',
        expected_total=receipt.tuzis_credited * 1000)
    if not proven['credited']:
        return None
    return ZecNoteDisposition.objects.get_or_create(event_key=f'legacy-issued:{note.pk}', defaults={
        'note': note, 'kind': 'legacy_issued', 'actor_id': receipt.creator_id, 'receipt': receipt,
        'evidence': {'source_reference': f'zec-receipt:{receipt.pk}', 'original_issuance': proven}})[0]


@transaction.atomic(durable=True)
def _ingest_raw(*, txid, pool, output_index, amount_zatoshi, memo_hex, source):
    """Commit an actor-null actual note; financial processing is a later TX."""
    if (not isinstance(txid, str) or re.fullmatch('[0-9a-f]{64}', txid) is None or
        pool not in {'sapling', 'orchard', 'ironwood'} or type(output_index) is not int or
        not 0 <= output_index <= 4_294_967_295 or type(amount_zatoshi) is not int or
        not 0 <= amount_zatoshi <= 2_100_000_000_000_000 or
        (memo_hex is not None and (not isinstance(memo_hex,str) or re.fullmatch('[0-9a-f]{1024}',memo_hex) is None))):
        raise money.EconomicRefusal('invalid_captured_note_coordinates')
    money._evidence(source, 'source_kind', 'source_reference')
    if memo_hex is None and source.get('memo_available') is not False:
        raise money.EconomicRefusal('unavailable_memo_source_required')
    if not _storable(source):
        raise money.EconomicRefusal('invalid_captured_note_source')
    source = dict(source)
    # This internal reference is derived solely from proved backend rows.
    # A daemon may supply observation facts, never a historical clock handle.
    source.pop('backend_observation_id',None)
    # Preserve ONLY an actual previous backend observation. The DB guard
    # validates these coordinates/time against the original stored row.
    from dj.apps.tuzis.models import IdempotencyKey
    for prior in IdempotencyKey.objects.filter(scope='zec-funding-note', key=f'{txid}:{pool}:{output_index}'):
        identity = prior.response_body.get('note', {})
        if (identity.get('txid'), identity.get('pool'), identity.get('output_index'), identity.get('memo_plain')) != (
            txid, pool, output_index, text_memo(memo_hex)):
            continue
        try:
            exact = Decimal(identity['amount_zec']) * 100_000_000 == amount_zatoshi
        except (KeyError, ValueError, ArithmeticError):
            exact = False
        if exact and prior.request_hash == money._digest(identity):
            source['backend_observation_id'] = str(prior.pk)
            break
    # Immutable retries do not need the original instruction lock. In particular,
    # the fact lane must not wait behind settlement's final network proof.
    existing = CapturedZecNote.objects.filter(txid=txid, pool=pool, output_index=output_index).first()
    if existing is not None:
        if existing.amount_zatoshi != amount_zatoshi or (existing.memo_hex is not None and
                memo_hex is not None and existing.memo_hex != memo_hex):
            raise money.IdempotencyConflict('captured_note_identity_changed')
        if existing.memo_hex is not None or memo_hex is None:
            return existing
        hydration = existing.dispositions.filter(event_key=f'memo-hydration:{existing.pk}').first()
        if hydration is not None:
            if hydration.evidence['memo_hex'] != memo_hex:
                raise money.IdempotencyConflict('captured_note_hydration_changed')
            return existing
    digest = money._digest(source)
    note, created = CapturedZecNote.objects.get_or_create(txid=txid, pool=pool, output_index=output_index,
        defaults={'amount_zatoshi': amount_zatoshi, 'memo_hex': memo_hex,
            'memo_plain': text_memo(memo_hex), 'source': source, 'source_digest': digest})
    if note.amount_zatoshi != amount_zatoshi or (note.memo_hex is not None and memo_hex is not None and note.memo_hex != memo_hex):
        raise money.IdempotencyConflict('captured_note_identity_changed')
    if not created and note.memo_hex is None and memo_hex is not None:
        hydration,first=ZecNoteDisposition.objects.get_or_create(event_key=f'memo-hydration:{note.pk}',defaults={
            'note':note,'kind':'observed','evidence':{'memo_hex':memo_hex,'memo_plain':text_memo(memo_hex),
                'source_kind':source['source_kind'],'source_reference':source['source_reference']}})
        if hydration.evidence['memo_hex'] != memo_hex:
            raise money.IdempotencyConflict('captured_note_hydration_changed')
    if created:
        ZecNoteDisposition.objects.create(note=note, event_key=f'observed:{note.pk}', kind='observed',
            evidence={'source_reference': source['source_reference'], 'source_digest': digest})
    return note


@transaction.atomic(durable=True)
def adopt_existing_issuance(*, note_id):
    from dj.apps.tuzis.zec import _take_instant_credit_lock
    from dj.apps.tuzis.models import ZecCreditReceipt
    from django.utils import timezone
    _take_instant_credit_lock()
    note = CapturedZecNote.objects.select_for_update(no_key=True).get(pk=note_id)
    issuance = _legacy_issued(note)
    revoked=_latest_revocation_lineage(note)
    if issuance and revoked:
        receipt=ZecCreditReceipt.objects.select_for_update().get(pk=issuance.receipt_id)
        if receipt.vanished_at is None or (receipt.vanish_resolved_at is not None and
                revoked.created_at>receipt.vanish_resolved_at and revoked.evidence.get('revocation_revision_reference')):
            receipt.vanished_at=timezone.now()
            receipt.vanish_resolved_at=None
            receipt.save(update_fields=['vanished_at','vanish_resolved_at'])
    return issuance


def _latest_revocation_lineage(note):
    # An actual revision's FIRST backend observation owns its clock. Changed
    # confirmation counts or incidental evidence never create a new lineage.
    first_by_revision={}
    for observation in note.dispositions.filter(kind='revoked').order_by('created_at','pk'):
        revision=observation.evidence.get('revocation_revision_reference')
        if revision:
            first_by_revision.setdefault(revision,observation)
        else:
            first_by_revision.setdefault(None,observation)
    return max(first_by_revision.values(),key=lambda row:row.created_at,default=None)


def ingest_zec_note(*, adopt_existing=True, **coordinates):
    """Capture facts; the settlement lane owns optional legacy adoption.

    ``adopt_existing=False`` avoids financial locks in an independent fact
    consumer. It never authorizes new issuance or skips original-intent expiry
    protection. The default preserves the legacy wallet caller's behavior.
    """
    note = _ingest_raw(**coordinates)
    # A proof/adoption failure can never undo the already committed raw fact.
    if adopt_existing:
        adopt_existing_issuance(note_id=note.pk)
    return note



def effective_note(note):
    if note.memo_hex is not None:
        return note
    hydration=note.dispositions.filter(event_key=f'memo-hydration:{note.pk}',kind='observed').first()
    if hydration is None:
        return note
    from copy import copy
    effective=copy(note)
    effective.memo_hex=hydration.evidence['memo_hex']
    effective.memo_plain=text_memo(effective.memo_hex)
    return effective


@transaction.atomic(durable=True)
def record_note_observation(*, note_id, confirmations, evidence):
    if type(confirmations) is not int or confirmations < 0:
        raise money.EconomicRefusal('invalid_note_confirmations')
    money._evidence(evidence, 'source_reference', 'confirmation_reference')
    if not _storable(evidence):
        raise money.EconomicRefusal('invalid_note_observation')
    from dj.apps.tuzis.zec import _take_instant_credit_lock
    from dj.apps.tuzis.models import ZecCreditReceipt
    from django.utils import timezone
    revoked = evidence.get('revoked') is True
    if revoked:
        # Revocation and issuance must still serialize on the financial brake.
        _take_instant_credit_lock()
        note = CapturedZecNote.objects.select_for_update(no_key=True).get(pk=note_id)
    else:
        # The immutable parent needs no write lock. PostgreSQL's FK KEY SHARE
        # is compatible with settlement's NO KEY UPDATE during final proof.
        note = CapturedZecNote.objects.get(pk=note_id)
    observation,created=ZecNoteDisposition.objects.get_or_create(
        event_key=f'observation:{note_id}:{money._digest(evidence)}:{confirmations}', defaults={
            'note_id': note_id, 'kind': 'revoked' if evidence.get('revoked') is True else 'observed',
            'evidence': dict(evidence, confirmations=confirmations)})
    if evidence.get('revoked') is True:
        issued=note.dispositions.filter(kind__in=['issued','legacy_issued']).first()
        if issued and issued.receipt_id:
            # Reuse the existing attributable, manually resolved global
            # unbacked-credit brake. Never automatically debit or remint.
            receipt=ZecCreditReceipt.objects.select_for_update().get(pk=issued.receipt_id)
            lineage=_latest_revocation_lineage(note)
            if receipt.vanished_at is None or (receipt.vanish_resolved_at is not None and
                    lineage and lineage.evidence.get('revocation_revision_reference') and
                    lineage.created_at>receipt.vanish_resolved_at):
                receipt.vanished_at=timezone.now()
                receipt.vanish_resolved_at=None
                receipt.save(update_fields=['vanished_at','vanish_resolved_at'])
    return observation


def _notice_target(note):
    from dj.apps.tuzis.models import ZecCreditReceipt
    if note.amount_zatoshi <= 0 or note.dispositions.filter(
            kind__in=['issued', 'legacy_issued', 'revoked']).exists():
        return None
    if note.dispositions.filter(kind='pending_resolution',
            evidence__reason__in=['receiver_scope_unconfigured', 'inactive_funding_actor']).exists():
        return None
    if ZecCreditReceipt.objects.filter(txid=note.txid, pool=note.pool,
            output_index=note.output_index, tuzis_credited__gt=0).exists():
        return None
    from .live_zec import purchase_target
    creator = purchase_target(note)
    return creator if creator is not None and creator.is_active else None


@transaction.atomic
def prepare_payment_notice(*, note_id, confirmations):
    """Durable retry eligibility; native callers finish proof before commit."""
    note = CapturedZecNote.objects.get(pk=note_id)
    creator = _notice_target(note)
    if creator is None:
        return None
    return ZecNoteDisposition.objects.get_or_create(event_key=f'payment-notice:{note.pk}',
        defaults={'note': note, 'kind': 'observed', 'actor_id': creator.pk,
            'evidence': {'payment_notice_eligible': True, 'confirmations': confirmations}})[0]


@contextmanager
def _notification_budget():
    from django.db import connection
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_setting('lock_timeout'), current_setting('statement_timeout')")
            previous = cursor.fetchone()
            cursor.execute("SELECT set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '2000ms', true)")
        yield
        # An exception rolls back the savepoint, including the local settings.
        # Successful nested callers must not change their financial DB budget.
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('lock_timeout', %s, true), set_config('statement_timeout', %s, true)", previous)


def _wake_payment_notice():
    """Optional fast wake, bounded on the actual queue insertion connection.

    Worker apps use a separate pool: do not enqueue there under a Django-only
    budget. Their current/periodic sweep drains the durable promise instead.
    """
    try:
        from django.db import connections
        from procrastinate.contrib.django.django_connector import DjangoConnector
        from procrastinate.exceptions import AlreadyEnqueued
        from dj.apps.jobs import outbox, tasks
    except Exception as exc:
        logging.getLogger(__name__).warning('Payment detection wake unavailable (%s)', type(exc).__name__)
        return
    try:
        deferred = tasks.publish_outbox_task.configure(queueing_lock=outbox.RELAY_QUEUEING_LOCK)
        connector = deferred.job_manager.connector
        if (not isinstance(connector, DjangoConnector) or
                connector.connection is not connections['default']):
            return
        # on_commit runs AFTER the notice transaction: establish a fresh
        # transaction-local budget that also covers the actual job INSERT.
        with _notification_budget():
            deferred.defer()
    except AlreadyEnqueued:
        pass
    except Exception as exc:
        logging.getLogger(__name__).warning('Payment detection wake deferred (%s)', type(exc).__name__)


def deliver_payment_notice(*, note_id):
    """Best-effort publication must never hold up later buyers' raw capture."""
    from dj.apps.tuzis.zec import notify_pending_note
    try:
        with _notification_budget():
            marker = ZecNoteDisposition.objects.filter(
                event_key=f'payment-notice:{note_id}', evidence__payment_notice_eligible=True).first()
            if marker is None:
                return False
            note = CapturedZecNote.objects.get(pk=note_id)
            creator = _notice_target(note)
            if creator is not None:
                notice = notify_pending_note(creator=creator,
                    txid=note.txid, pool=note.pool, output_index=note.output_index,
                    amount_zec=Decimal(note.amount_zatoshi) / 100_000_000,
                    confirmations=marker.evidence['confirmations'], captured_note=note, wake_up=False)
                if notice is not None:
                    transaction.on_commit(_wake_payment_notice)
            else:
                ZecNoteDisposition.objects.get_or_create(event_key=f'payment-notice-finished:{note.pk}',
                    defaults={'note':note, 'kind':'observed', 'evidence':{'payment_notice_finished':True}})
        return True
    except Exception as exc:
        # Eligibility remains committed. Never log private note or memo data.
        logging.getLogger(__name__).warning('Payment detection notification deferred (%s)', type(exc).__name__)
        return False


def recover_payment_notices(*, limit=50, time_budget=5):
    """One bounded pass from the existing periodic notification outbox sweep."""
    from django.db.models import Exists, OuterRef
    from dj.apps.tuzis.models import ZecPendingNotice
    notified = ZecPendingNotice.objects.filter(txid=OuterRef('note__txid'),
        pool=OuterRef('note__pool'), output_index=OuterRef('note__output_index'))
    finished = ZecNoteDisposition.objects.filter(note_id=OuterRef('note_id'),
        evidence__payment_notice_finished=True)
    markers = ZecNoteDisposition.objects.filter(evidence__payment_notice_eligible=True,
        kind='observed').annotate(notified=Exists(notified), finished=Exists(finished)).filter(
        notified=False, finished=False).order_by('created_at', 'pk')[:limit]
    deadline = time.monotonic() + time_budget
    try:
        with _notification_budget():
            batch = list(markers)
    except Exception as exc:
        logging.getLogger(__name__).warning('Payment detection recovery deferred (%s)', type(exc).__name__)
        return 0
    completed = 0
    for marker in batch:
        if time.monotonic() >= deadline:
            break
        completed += bool(deliver_payment_notice(note_id=marker.note_id))
    return completed


def _names_purchase(note):
    if note.memo_plain is None:
        return None  # Opaque/unavailable bytes cannot prove a non-purchase.
    try:
        decoded=json.loads(note.memo_plain)
    except (ValueError,RecursionError):
        if 'buy_2z' in note.memo_plain:
            return None  # Preserve the full original marker, not just its fragment.
        # Legacy surrounding text can contain escaped action characters. This
        # classifies possible claims only; it never authenticates the payer.
        from dj.apps.g12f.management.commands.credit_creators import extract_json
        try:
            decoded=json.loads(extract_json(note.memo_plain))
        except (ValueError,RecursionError):
            names_action=re.search(r'\{[^{}]*"act"\s*:',note.memo_plain) is not None
            return None if names_action else False
    if not _storable(decoded):
        return None
    return isinstance(decoded,dict) and decoded.get('act')=='buy_2z'


@transaction.atomic
def process_captured_zec_note(*, note_id, confirmations, evidence, instant=False):
    """Credit confirmed received value to the memo recipient; retain unknown money."""
    from .funding import CapturedFundingResult
    from .live_zec import purchase_target, retained_zec_claim, settle_live_zec_note
    if type(confirmations) is not int or confirmations < 0:
        raise money.EconomicRefusal('invalid_note_confirmations')
    money._evidence(evidence, 'source_reference', 'confirmation_reference')
    raw_note=CapturedZecNote.objects.get(pk=note_id)
    if raw_note.amount_zatoshi==0:
        ZecNoteDisposition.objects.get_or_create(event_key=f'zero:{raw_note.pk}',defaults={
            'note':raw_note,'kind':'ignored_zero','evidence':evidence})
        return CapturedFundingResult('ignored_zero',None,False,'zero_value_note')
    # The same note/global locks serialize an actual revocation with issuance.
    # Financial lock order is policy -> global ZEC brake -> note -> actors.
    money.pin_policy()
    from dj.apps.tuzis.zec import _take_instant_credit_lock,unresolved_unbacked_credits
    _take_instant_credit_lock()
    note = effective_note(CapturedZecNote.objects.select_for_update(no_key=True).get(pk=note_id))
    event_key=f'observation:{note_id}:{money._digest(evidence)}:{confirmations}'
    if not note.dispositions.filter(event_key=event_key).exists():
        raise money.EconomicRefusal('durable_note_observation_required')
    prior = note.dispositions.filter(kind__in=['issued', 'legacy_issued']).select_related('receipt').first()
    if note.dispositions.filter(kind='revoked').exists():
        ZecNoteDisposition.objects.get_or_create(event_key=f'revocation-review:{note.pk}',defaults={
            'note':note,'kind':'pending_resolution','actor_id':prior.actor_id if prior else None,
            'evidence':{'reason':'issued_note_revoked' if prior else 'note_revoked',**evidence}})
        return CapturedFundingResult('issued_under_review' if prior else 'pending_resolution',
            f'captured-note:{note.pk}',bool(prior),'note_revoked',prior.receipt if prior else None)
    if prior:
        return CapturedFundingResult('issued', None, True, '', prior.receipt)
    # These durable buyer/note-specific holds survive producer rollback and
    # account reactivation. They never erase an exact existing issuance or
    # revocation, and cannot be released merely by replaying the wallet note.
    held = note.dispositions.filter(kind='pending_resolution', evidence__reason__in=[
        'receiver_scope_unconfigured', 'inactive_funding_actor']).order_by('pk').first()
    if held:
        return CapturedFundingResult('pending_resolution', f'captured-note:{note.pk}',
            False, held.evidence['reason'])
    if unresolved_unbacked_credits().exists():
        recipient=purchase_target(note)
        ZecNoteDisposition.objects.get_or_create(event_key=f'global-brake:{note.pk}',defaults={
            'note':note,'kind':'pending_resolution','actor_id':recipient.pk if recipient else None,
            'evidence':dict(evidence,reason='global_unbacked_credit_brake')})
        return CapturedFundingResult('pending_resolution',f'captured-note:{note.pk}',False,'global_unbacked_credit_brake')
    if note.amount_zatoshi == 0:
        ZecNoteDisposition.objects.get_or_create(event_key=f'zero:{note.pk}', defaults={
            'note': note, 'kind': 'ignored_zero', 'evidence': evidence})
        return CapturedFundingResult('ignored_zero', None, False, 'zero_value_note')
    creator = purchase_target(note)
    from dj.apps.tuzis.models import ZecCreditReceipt,ZecMemoDisposition
    from dj.apps.g12f.models.transaction import Transaction
    disposition=ZecMemoDisposition.objects.filter(txid=note.txid,pool=note.pool,output_index=note.output_index,decision__isnull=False).first()
    from django.db.models import Q
    legacy=(ZecCreditReceipt.objects.filter(txid=note.txid).filter(Q(backfilled=True)|Q(pool='')).exists()
        or ZecCreditReceipt.objects.filter(txid=note.txid,pool=note.pool,output_index=note.output_index).exists()
        or Transaction.objects.filter(txid=note.txid,action='buy_2z').exists()
           and not ZecCreditReceipt.objects.filter(txid=note.txid).exists())
    historical_claim=retained_zec_claim(note)
    if historical_claim is not None:
        ZecNoteDisposition.objects.get_or_create(event_key=f'resolution:{note.pk}:retired_original_contract',defaults={
            'note':note,'kind':'pending_resolution','actor_id':historical_claim.creator_id,'intent':historical_claim,
            'evidence':dict(evidence,reason='retired_original_contract_requires_resolution')})
        return CapturedFundingResult('pending_resolution',f'captured-note:{note.pk}',False,'retired_original_contract_requires_resolution')
    reason = 'unattributed_purchase' if creator is None else None
    if disposition is not None:
        ZecNoteDisposition.objects.get_or_create(event_key=f'operator-disposition:{note.pk}:{disposition.pk}',defaults={
            'note':note,'kind':'observed','evidence':{'source_reference':f'zec-memo-disposition:{disposition.pk}',
                'decision':disposition.decision}})
        return CapturedFundingResult('resolved_observation',None,False,'existing_memo_disposition')
    elif legacy:
        reason='ambiguous_existing_issuance'
    if reason=='unattributed_purchase' and _names_purchase(note) is False:
        return CapturedFundingResult('observed_nonpurchase',None,False,'no_purchase_authorization_named')
    if reason:
        ZecNoteDisposition.objects.get_or_create(event_key=f'resolution:{note.pk}:{reason}', defaults={
            'note': note, 'kind': 'pending_resolution', 'actor_id': creator.pk if creator else None, 'evidence': {'reason': reason, **evidence}})
        return CapturedFundingResult('pending_resolution', f'captured-note:{note.pk}', False, reason)
    # Confirmation and current processing price determine actual issuance.
    # UI estimates never authorize a fixed amount, rate or send deadline.
    result = settle_live_zec_note(note=note, creator=creator,
        confirmations=confirmations, instant=instant)
    kind = 'issued' if result.credited else result.status
    fields = {'note': note, 'kind': kind, 'actor_id': creator.pk,
        'evidence': dict(evidence, reason=result.reason)}
    if result.credited:
        from .models import FundingReservation
        fields['receipt'] = result.receipt
        fields['funding'] = FundingReservation.objects.get(idempotency_key=f'live-zec:{note.pk}')
    ZecNoteDisposition.objects.get_or_create(event_key=f'{kind}:{note.pk}', defaults=fields)
    if result.credited:
        from .funding import issued_usage_m2z
        from dj.apps.events.dispatch import create_durable_event
        from dj.apps.events.models import AMOUNT_MAX
        usage_m2z=issued_usage_m2z(fields['funding'])
        create_durable_event(type='BOUGHT_TUZI',receiving_user_id=creator.pk,payee_id=creator.pk,
            read=False,amount=min(Decimal(usage_m2z)/1000,AMOUNT_MAX),content_object=note)
    return result


def original_intent_has_captured_payment(intent):
    """Pure exact original-memo fact, including capture/enrichment gaps.

    A matching positive note is observable even when its amount or observation
    time needs manual resolution. Zero-value memos retain no funding capacity.
    """
    memo = intent.rail_data.get('memo')
    from django.db import connection
    if not isinstance(memo,str):
        return False
    with connection.cursor() as cursor:
        cursor.execute('SELECT EXISTS(SELECT 1 FROM economy_capturedzecnote n WHERE n.amount_zatoshi>0 '
            'AND economy.effective_note_memo(n.id)=%s)',[memo])
        return cursor.fetchone()[0]


def capture_wallet_note(tx, *, instant=False):
    """Legacy wallet loop handoff to the same durable raw-note boundary.

    Source references identify the trusted wallet observation; they do not
    authorize a buyer or supply the backend ingestion clock.
    """
    from dj.apps.tuzis.zec import note_pool, note_output_index, note_zatoshi
    amount = Decimal(str(tx['amount']))
    memo_hex=tx['memo']
    source={'source_kind':'wallet_credit_loop',
        'source_reference':f"wallet-note:{tx['txid']}:{note_pool(tx)}:{note_output_index(tx)}"}
    if tx.get('output_index_reliable') is False:
        raise money.EconomicRefusal('wallet_note_index_unproven')
    if tx.get('memo_available') is False:
        memo_hex=None
        source['memo_available']=False
    elif tx.get('memo_format')=='zcash_client_sqlite_content' and len(memo_hex)<1024:
        raw=bytes.fromhex(memo_hex)
        # Only declared hydrated text content has a lossless protocol padding.
        # Opaque/invalid partial bytes remain unavailable with their actual bytes retained.
        try:
            safe=raw==b'\xf6' or ((not raw or raw[0]<0xF5) and b'\0' not in raw and _storable(raw.decode('utf-8')))
        except UnicodeDecodeError:
            safe=False
        if safe and tx.get('memo_available') is True:
            memo_hex=raw.ljust(512,b'\0').hex()
            source['memo_representation']='verified_text_content_zero_padding'
        else:
            source.update(memo_available=False,original_content_hex=memo_hex)
            memo_hex=None
    note = ingest_zec_note(txid=tx['txid'], pool=note_pool(tx),
        output_index=note_output_index(tx), amount_zatoshi=note_zatoshi(tx, amount),
        memo_hex=memo_hex,source=source)
    confirmations=tx.get('confirmations') or 0
    evidence={'source_reference':note.source['source_reference'],
        'confirmation_reference':f'wallet-confirmations:{confirmations}'}
    record_note_observation(note_id=note.pk,confirmations=confirmations,evidence=evidence)
    # This live wallet boundary commits raw facts before announcing detection.
    # Outbox failure retries without erasing first-seen or entering settlement.
    prepare_payment_notice(note_id=note.pk, confirmations=confirmations)
    deliver_payment_notice(note_id=note.pk)
    from .epoch import is_explicit_policy_refusal
    from django.db import DatabaseError
    try:
        return process_captured_zec_note(note_id=note.pk,confirmations=confirmations,evidence=evidence,instant=instant)
    except DatabaseError as exc:
        if not is_explicit_policy_refusal(exc):
            raise
        from .funding import CapturedFundingResult
        return CapturedFundingResult('pending_resolution',f'captured-note:{note.pk}',False,'economic_writers_fenced')
