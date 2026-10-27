"""Paymentd application adapter. Observation is durable; settlement can retry.

No private memo is executed or logged. New financial effects are exclusively
owned by the reserved-funding backend. A hook ACK means its phase committed,
not necessarily that money was issued. Capture and settlement have independent
consumer IDs so a financial outage cannot block later buyers' first observations.
"""
from dataclasses import dataclass
from django.db import DatabaseError, transaction
from dj.apps.economy import captured_notes, services as money
from dj.apps.economy.models import CapturedZecNote, ZecNoteDisposition
from .paymentd_protocol import PaymentEvidenceError
from .paymentd_memo import parse_memo
from .paymentd_runtime import require_runtime


class RetrySettlement(Exception):
    """The same confirmed event must remain queued; no automatic ACK."""


@dataclass(frozen=True)
class Outcome:
    phase: str
    status: str
    newly_issued: bool = False


def references(event):
    """Immutable lifecycle identity, never refreshed verification timestamps."""
    ref = 'paymentd:' + event['event_id']
    result = {'source_reference': ref, 'confirmation_reference': ref,
              'block_height': event['block_height'], 'block_hash': event['block_hash']}
    if event['kind'] == 'payment.revoked':
        result.update(revoked=True, revocation_revision_reference=ref)
    return result


def capture(payment, *, source_reference, source_kind='paymentd', adopt_existing=True):
    instruction = parse_memo(bytes.fromhex(payment['memo_hex']))
    return captured_notes.ingest_zec_note(adopt_existing=adopt_existing,
        txid=payment['txid'], pool=payment['pool'],
        output_index=payment['output_index'], amount_zatoshi=payment['value_zatoshis'],
        memo_hex=payment['memo_hex'], source={'source_kind':source_kind,
            'source_reference':source_reference, 'memo_available':True,
            # Diagnostic syntax only: the backend owns authentication, exact
            # stored instructions, original issuance adoption and settlement.
            'memo_classification':instruction.reason or 'purchase_syntax'})


def _observation(note, confirmations, evidence):
    row = captured_notes.record_note_observation(note_id=note.pk,
        confirmations=confirmations, evidence=evidence)
    # Fail closed if an API change stops returning actual persisted evidence.
    if not ZecNoteDisposition.objects.filter(pk=row.pk, note_id=note.pk).exists():
        raise PaymentEvidenceError('durable note observation is unavailable')
    return row


def handle_event(event, verifier, *, role):
    if role not in {'capture','settle'}:
        raise PaymentEvidenceError('unsupported adapter role')
    # This process owns its factual commits and final financial commit. A
    # caller-owned transaction would defer COMMIT beyond our producer lease.
    if not transaction.get_autocommit():
        raise PaymentEvidenceError('paymentd requires an independently owned transaction')
    require_runtime(writes=True)
    # The child executing Django holds the lease, independently of its daemon
    # or shell parent. It survives parent death until this process commits or
    # exits; the final transaction is completely owned inside this scope.
    from zcashrpc.paymentd_mode import producer_lease
    with producer_lease('paymentd'):
        return _handle_event(event, verifier, role=role)


def _handle_event(event, verifier, *, role):
    initial = verifier.verify(event)
    evidence = references(event)
    payment = event['payment']
    receiver_held = CapturedZecNote.objects.filter(txid=payment['txid'],pool=payment['pool'],
        output_index=payment['output_index'],dispositions__kind='pending_resolution',
        dispositions__evidence__reason='receiver_scope_unconfigured').exists()
    if not initial.receiver_in_scope or receiver_held:
        # Canonical/private proof authenticated the note, but this receiver
        # cannot authorize settlement. Persist raw bytes and manual work, then
        # ACK so the next buyer is not held behind a configuration omission.
        note = capture(event['payment'], source_reference=evidence['source_reference'],
            adopt_existing=event['kind'] == 'payment.revoked'
                or initial.receiver_in_scope and role == 'settle')
        _observation(note, initial.confirmations, evidence)
        with transaction.atomic():
            # Serialize this hold with the same note's financial scope check;
            # unrelated factual captures do not need a global financial lock.
            CapturedZecNote.objects.select_for_update(no_key=True).get(pk=note.pk)
            ZecNoteDisposition.objects.get_or_create(
                event_key=f"paymentd-receiver-scope:{note.pk}:{event['event_id']}", defaults={
                    'note':note,'kind':'pending_resolution',
                    'evidence':dict(evidence,reason='receiver_scope_unconfigured')})
            require_runtime(writes=True)
            verifier.verify(event)
        return Outcome(role, 'receiver_scope_quarantined')
    note = capture(event['payment'], source_reference=evidence['source_reference'],
        adopt_existing=role != 'capture' or event['kind'] == 'payment.revoked')
    _observation(note, initial.confirmations, evidence)
    # No process call for capture: a policy fence must not prevent factual ACK.
    # Zero has no financial effect and can acquire a durable zero disposition
    # without pinning a financial policy. It still requires the journal proof.
    if role == 'capture':
        if event['kind'] != 'payment.revoked':
            with transaction.atomic():
                captured_notes.prepare_payment_notice(note_id=note.pk,
                    confirmations=initial.confirmations)
                require_runtime(writes=True)
                verifier.verify(event)
            captured_notes.deliver_payment_notice(note_id=note.pk)
        if note.amount_zatoshi == 0:
            captured_notes.process_captured_zec_note(note_id=note.pk,
                confirmations=initial.confirmations, evidence=evidence)
        return Outcome(role, 'revoked' if event['kind']=='payment.revoked' else 'captured')
    if event['kind'] == 'payment.observed':
        raise PaymentEvidenceError('early observations cannot enter settlement')
    if event['kind'] == 'payment.revoked':
        # record_note_observation durably arms the shared global brake for an
        # issued receipt. No policy pin, debit, remint, or memo interpretation.
        return Outcome(role, 'revoked')
    try:
        return _settle(event, verifier, role, note, initial, evidence)
    except (DatabaseError, money.EconomicRefusal) as exc:
        cause = exc.__cause__ or exc
        primary = getattr(getattr(cause,'diag',None),'message_primary',None)
        state = getattr(cause,'sqlstate',None) or getattr(cause,'pgcode',None)
        fenced = isinstance(exc,money.EconomicRefusal) and str(exc)=='economic_writers_fenced'
        inactive = isinstance(exc,money.EconomicRefusal) and str(exc)=='inactive_funding_actor'
        if inactive or fenced or state == '23514' and primary == 'economic_writers_fenced':
            # The owned failed financial transaction has already rolled back.
            # A separate nonfinancial commit records the actual refusal while
            # the event remains queued. Runtime and canonical proof still gate it.
            with transaction.atomic():
                CapturedZecNote.objects.select_for_update(no_key=True).get(pk=note.pk)
                reason = 'inactive_funding_actor' if inactive else 'economic_writers_fenced'
                ZecNoteDisposition.objects.get_or_create(
                    event_key=f"paymentd-refusal:{reason}:{note.pk}:{event['event_id']}", defaults={
                        'note':note,'kind':'pending_resolution',
                        'evidence':dict(evidence,reason=reason)})
                require_runtime(writes=True)
                verifier.verify(event)
            if inactive:
                return Outcome(role,'pending_resolution')
        raise


def _settle(event, verifier, role, note, initial, evidence):
    # The financial transaction is separate from raw capture/observation commits.
    # On final proof failure all ledger/receipt/outbox changes roll back, while
    # first_seen and observed facts remain committed.
    with transaction.atomic():
        if note.amount_zatoshi > 0:
            # Use the backend lock order before observing new-versus-replayed.
            money.pin_policy()
            from dj.apps.tuzis.zec import _take_instant_credit_lock
            _take_instant_credit_lock()
            CapturedZecNote.objects.select_for_update(no_key=True).get(pk=note.pk)
        # A quarantine may have committed after the earlier preflight. Check
        # under the same row lock that its writer uses before any new issuance.
        if note.dispositions.filter(kind='pending_resolution',
                evidence__reason='receiver_scope_unconfigured').exists():
            require_runtime(writes=True)
            verifier.verify(event)
            return Outcome(role,'receiver_scope_quarantined')
        before = note.dispositions.filter(kind__in=['issued','legacy_issued']).exists()
        result = captured_notes.process_captured_zec_note(note_id=note.pk,
            confirmations=initial.confirmations, evidence=evidence)
        require_runtime(writes=True)
        final = verifier.verify(event)
        if final.confirmations < initial.confirmations:
            raise PaymentEvidenceError('payment lost settlement depth during transaction')
        if result.status == 'pending_confirmation' or result.reason in {
            'economic_writers_fenced','global_unbacked_credit_brake'}:
            # Commit durable queue evidence, then raise OUTSIDE this transaction.
            retry = True
        else:
            retry = False
        if result.status not in {'issued','issued_under_review','pending_resolution',
                'pending_confirmation','ignored_zero','resolved_observation','observed_nonpurchase'}:
            raise RetrySettlement('unsupported funding outcome')
        if result.status in {'issued','issued_under_review'}:
            if result.receipt is None or not note.dispositions.filter(
                    kind__in=['issued','legacy_issued'],receipt_id=result.receipt.pk).exists():
                raise PaymentEvidenceError('issued outcome lacks persisted issuance evidence')
        if result.status == 'pending_resolution' and not note.dispositions.filter(kind='pending_resolution').exists():
            raise PaymentEvidenceError('resolution outcome lacks durable queue evidence')
        if result.status in {'resolved_observation','observed_nonpurchase'}:
            ZecNoteDisposition.objects.get_or_create(
                event_key=f"paymentd-terminal:{note.pk}:{event['event_id']}", defaults={
                    'note':note,'kind':'observed',
                    'evidence':dict(evidence,paymentd_outcome=result.status)})
        outcome = Outcome(role, result.status, result.status == 'issued' and not before)
    if retry:
        raise RetrySettlement('financial settlement is temporarily unavailable')
    return outcome


def reconcile_payment(payment_id, verifier, *, apply=False):
    """Historical raw/adoption only; deliberately no settlement API call."""
    require_runtime(writes=False)  # approved host/PostgreSQL; no producer activation
    proof = verifier.verify_payment(payment_id)
    if not apply:
        return Outcome('history', 'verified')
    record = proof['record']
    ref = f"paymentd-history:{payment_id}:{record['revision']}"
    note = capture(record['payment'], source_reference=ref, source_kind='paymentd-history')
    evidence = {'source_reference':ref, 'confirmation_reference':ref,
                'block_height':record['block_height'], 'block_hash':record['block_hash']}
    _observation(note, proof['confirmations'], evidence)
    # Existing issuance is adopted by ingest before any new authorization is
    # considered. An unadopted historical note is an explicit manual queue;
    # this command can never mint it, even with a currently valid intent memo.
    with transaction.atomic():
        issued = note.dispositions.filter(kind__in=['issued','legacy_issued']).exists()
        if not issued:
            ZecNoteDisposition.objects.get_or_create(event_key=f'history-review:{note.pk}',defaults={
                'note':note,'kind':'pending_resolution',
                'evidence':dict(evidence,reason='historical_reconciliation_no_issuance')})
        require_runtime(writes=False)
        final = verifier.verify_payment(payment_id)
        if final['record'] != record:
            raise PaymentEvidenceError('historical receipt changed during reconciliation')
    return Outcome('history','adopted_existing' if issued else 'pending_resolution')
