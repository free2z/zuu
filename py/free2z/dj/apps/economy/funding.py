"""Historical funding receipt projections; live ZEC purchases use live_zec.

Retained records preserve old financial rights. No fixed ZEC quotation writer
or memo proof authorization remains in this module.
"""
from dataclasses import dataclass

from django.db import transaction

from dj.apps.tuzis.models import IdempotencyKey, ZecCreditReceipt


ZEC_NOTE_SCOPE = 'zec-funding-note'


@dataclass(frozen=True)
class CapturedFundingResult:
    status: str
    resolution_id: str | None
    credited: bool
    reason: str
    receipt: object = None


def funding_note_recipient(*, memo_plain, username):
    """Legacy wallet parser already extracted act/id; username names recipient."""
    from dj.apps.g12f.models import Creator
    return Creator.objects.filter(username=username).first() if isinstance(username, str) else None


def receipt_result(reservation):
    return CapturedFundingResult('issued' if reservation.state == 'issued' else 'pending_resolution',
        None if reservation.state == 'issued' else f'funding:{reservation.pk}', reservation.state == 'issued',
        '' if reservation.state == 'issued' else 'funding_requires_resolution')


def transaction_issuance_status(purchase):
    """Historical nominal amount alone is not proof that usage was issued."""
    from dj.apps.ledger.models import PurchaseRefund
    from .models import FundingReservation
    cursor = PurchaseRefund.objects.filter(ref_kind='stripe_transaction', ref_id=str(purchase.pk),
        rail='stripe', account__owner_id=purchase.user_id).first()
    if cursor is None:
        reservation = FundingReservation.objects.filter(state='issued', recipient_id=purchase.user_id,
            external_receipt__provider_reference=purchase.stripe_charge_id).first()
        if reservation:
            cursor = PurchaseRefund.objects.filter(ref_kind='funding_reservation', ref_id=str(reservation.pk),
                rail='stripe', account__owner_id=purchase.user_id).first()
    return _cursor_issuance_status(cursor, creator_id=purchase.user_id,
        rail='stripe', expected_total=purchase.tuzis_credited * 1000)


def _unavailable_issuance():
    return {'status': 'unavailable', 'credited': False, 'credited_m2z': None,
        'usage_credited_m2z': None, 'usage_debt_repaid_m2z': None}


def _cursor_issuance_status(cursor, *, creator_id, rail, expected_total):
    if cursor is None or expected_total <= 0 or cursor.credited_m2z != expected_total:
        return _unavailable_issuance()
    from django.db.models import Sum
    from dj.apps.ledger.models import Account, Transfer
    clearing_id = Account.objects.filter(key=f'sys:clearing_{rail}').values_list('id', flat=True).first()
    debt_id = Account.objects.filter(kind='user_debt', owner_id=creator_id).values_list('id', flat=True).first()
    source = Transfer.objects.filter(ref_kind=cursor.ref_kind, ref_id=cursor.ref_id,
        debit_account_id=clearing_id)
    credited = source.filter(credit_account_id=cursor.account_id, code='purchase').aggregate(n=Sum('amount'))['n'] or 0
    repaid = source.filter(code='debt_repay', meta__origin='purchase',
        credit_account_id=debt_id
    ).aggregate(n=Sum('amount'))['n'] or 0
    if credited + repaid != cursor.credited_m2z:
        return _unavailable_issuance()
    return {'status': 'credited', 'credited': True, 'credited_m2z': str(credited + repaid),
        'usage_credited_m2z': str(credited), 'usage_debt_repaid_m2z': str(repaid)}


def purchase_intent_issuance_status(intent):
    """Exact original fulfillment split, independent of today's balance."""
    from dj.apps.ledger.models import PurchaseRefund
    from dj.apps.purchases.models import CREDITED_STATUSES, PurchaseReceipt, Rail
    from .models import FundingReservation
    if intent.status not in CREDITED_STATUSES or intent.credited_milli_2z != intent.quantity_2z * 1000:
        return _unavailable_issuance()
    if intent.rail == Rail.STRIPE:
        from dj.apps.ztripe.models import StripeTransaction
        receipt = PurchaseReceipt.objects.filter(intent=intent, rail=Rail.STRIPE).first()
        if receipt is None or receipt.ledger_ref_kind != 'stripe_transaction':
            return _unavailable_issuance()
        purchase = StripeTransaction.objects.filter(pk=receipt.ledger_ref_id, user_id=intent.creator_id,
            stripe_charge_id=receipt.provider_event_id, tuzis_credited=intent.quantity_2z).first()
        return transaction_issuance_status(purchase) if purchase else _unavailable_issuance()
    if intent.rail != Rail.ZEC:
        return _unavailable_issuance()
    reservation_id = intent.quote.get('funding_reservation_id')
    receipt_id = intent.rail_data.get('receipt_id')
    if not str(reservation_id).isdigit() or not str(receipt_id).isdigit():
        return _unavailable_issuance()
    reservation = FundingReservation.objects.filter(pk=reservation_id, state='issued', recipient_id=intent.creator_id,
        amount_m2z=intent.quantity_2z * 1000).first()
    receipt = ZecCreditReceipt.objects.filter(pk=receipt_id, creator_id=intent.creator_id,
        tuzis_credited=intent.quantity_2z).first()
    if reservation is None or receipt is None or reservation.external_receipt.get('provider_reference') != (
        f'zec:{receipt.txid}:{receipt.pool}:{receipt.output_index}'
    ):
        return _unavailable_issuance()
    cursor = PurchaseRefund.objects.filter(ref_kind='funding_reservation', ref_id=str(reservation.pk),
        rail='zec', account__owner_id=intent.creator_id).first()
    return _cursor_issuance_status(cursor, creator_id=intent.creator_id, rail='zec',
        expected_total=intent.credited_milli_2z)


def funding_resolution_statuses(*, creator_id, limit=50):
    """Bounded own-actor projection, without private provider/memo payloads."""
    from .models import FundingReservation
    limit = min(max(int(limit), 1), 100)
    rows = [{'status': 'pending_resolution', 'credited': False,
        'resolution_id': f'funding:{row.pk}', 'reason': 'funding_requires_resolution',
        'created_at': row.created_at}
        for row in FundingReservation.objects.filter(recipient_id=creator_id, state='resolution').order_by('-created_at')[:limit]]
    safe_reasons = {'purchaser_authorization_unproven', 'purchase_intent_unproven',
        'purchase_amount_mismatch', 'purchase_observed_after_expiry',
        'purchase_intent_already_received_a_different_note', 'funding_requires_resolution'}
    for row in _unissued_note_resolutions(creator_id).order_by('-created_at')[:limit]:
        body = row.response_body
        # A corresponding funding resolution is already represented above.
        if body.get('funding_reservation_id'):
            continue
        reason = body.get('reason')
        rows.append({'status': 'pending_resolution', 'credited': False,
            'resolution_id': f'zec-note:{row.pk}',
            'reason': reason if reason in safe_reasons else 'funding_requires_resolution',
            'created_at': row.created_at})
    for row in IdempotencyKey.objects.filter(user_id=creator_id, scope='stripe-financial-event',
        response_body__status='pending_resolution').order_by('-created_at')[:limit]:
        rows.append({'status': 'pending_resolution', 'credited': False,
            'resolution_id': f'stripe-event:{row.pk}', 'reason': 'financial_reconciliation_requires_review',
            'created_at': row.created_at})
    from .models import ZecNoteDisposition
    from django.db.models import Exists, OuterRef
    issued=ZecNoteDisposition.objects.filter(note_id=OuterRef('note_id'),kind__in=['issued','legacy_issued'])
    for row in ZecNoteDisposition.objects.filter(actor_id=creator_id,kind='pending_resolution').annotate(
            already_issued=Exists(issued)).filter(already_issued=False).order_by('-created_at')[:limit]:
        reason=row.evidence.get('reason')
        rows.append({'status':'pending_resolution','credited':False,
            'resolution_id':f'captured-note:{row.note_id}',
            'reason':reason if reason in safe_reasons else 'funding_requires_resolution', 'created_at':row.created_at})
    return sorted(rows, key=lambda row: row['created_at'], reverse=True)[:limit]


def _unissued_note_resolutions(creator_id):
    """Apply original ledger proof before limiting the pending owner queue."""
    from django.db.models import BooleanField
    from django.db.models.expressions import RawSQL
    # Decimal's validated8dp representation can use scientific notation.
    # Bound digits/exponent before conversion so malformed JSON cannot cause
    # an overflow or abort the private resolution queue.
    proof = RawSQL("""EXISTS (
      SELECT 1 FROM tuzis_zeccreditreceipt r
      JOIN ledger_purchase_refund p ON p.ref_kind='zec_receipt' AND p.ref_id=r.id::text AND p.rail='zec'
      JOIN ledger_account u ON u.id=p.account_id AND u.owner_id=r.creator_id
      WHERE r.creator_id=tuzis_idempotencykey.user_id
        AND r.txid=tuzis_idempotencykey.response_body->'note'->>'txid'
        AND r.pool=tuzis_idempotencykey.response_body->'note'->>'pool'
        AND r.output_index::text=tuzis_idempotencykey.response_body->'note'->>'output_index'
        AND r.amount_zec=CASE WHEN
          tuzis_idempotencykey.response_body->'note'->>'amount_zec' ~ %s THEN
          (tuzis_idempotencykey.response_body->'note'->>'amount_zec')::numeric END
        AND p.credited_m2z=r.tuzis_credited*1000 AND p.credited_m2z>0
        AND p.credited_m2z=(SELECT COALESCE(SUM(t.amount),0) FROM ledger_transfer t
          JOIN ledger_account c ON c.id=t.debit_account_id AND c.key='sys:clearing_zec'
          JOIN ledger_account d ON d.id=t.credit_account_id
          WHERE t.ref_kind=p.ref_kind AND t.ref_id=p.ref_id AND (
            (t.code='purchase' AND t.credit_account_id=p.account_id) OR
            (t.code='debt_repay' AND t.meta->>'origin'='purchase'
              AND d.kind='user_debt' AND d.owner_id=r.creator_id)))
    )""", [r'^[0-9]{1,20}(\.[0-9]{1,8})?([eE][+-]?[0-9]{1,2})?$'], output_field=BooleanField())
    return IdempotencyKey.objects.filter(user_id=creator_id, scope=ZEC_NOTE_SCOPE,
        response_body__status='pending_resolution').exclude(
            response_body__has_key='funding_reservation_id').alias(legacy_issued=proof).filter(legacy_issued=False)


def _legacy_note_issuance(observation):
    from dj.apps.ledger.models import PurchaseRefund
    note = observation.response_body.get('note', {})
    receipt = ZecCreditReceipt.objects.filter(creator_id=observation.user_id,
        txid=note.get('txid'), pool=note.get('pool'), output_index=note.get('output_index'),
        amount_zec=note.get('amount_zec')).first()
    if receipt is None:
        return False
    cursor = PurchaseRefund.objects.filter(ref_kind='zec_receipt', ref_id=str(receipt.pk),
        rail='zec', account__owner_id=observation.user_id).first()
    return _cursor_issuance_status(cursor, creator_id=observation.user_id,
        rail='zec', expected_total=receipt.tuzis_credited * 1000)['credited']


@transaction.atomic
def mark_original_zec_note_issued(receipt):
    observation = IdempotencyKey.objects.select_for_update().filter(scope=ZEC_NOTE_SCOPE,
        user_id=receipt.creator_id, key=f'{receipt.txid}:{receipt.pool}:{receipt.output_index}').first()
    if observation is not None and _legacy_note_issuance(observation):
        observation.response_body = dict(observation.response_body, status='issued', reason='',
            receipt_id=receipt.pk, issuance_basis='legacy-clearing-ledger')
        observation.save(update_fields=['response_body'])


def issued_usage_m2z(reservation):
    from django.db.models import Sum
    from dj.apps.ledger.models import Transfer
    return Transfer.objects.filter(ref_kind='funding_reservation', ref_id=str(reservation.pk),
        credit_account_id=reservation.account_id, code='purchase').aggregate(n=Sum('amount'))['n'] or 0
