"""Confirmed, note-keyed live-rate purchases; estimates never fix issuance.

The wallet proves receipt. A memo chooses the credit recipient, never the
shielded sender. Economic limits, original receipts and the ledger remain the
financial boundary; the durable server note identity correlates account notifications.
"""
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import os

from django.db import transaction
from django.utils import timezone

from . import contracts, services as money
from .funding import CapturedFundingResult


def retained_zec_claim(note):
    """An exact outstanding historical instruction is a retained legal claim.

    It requires manual resolution, never token authorization or repricing.
    Arbitrary unknown/mismatched reference fields remain ordinary memo data.
    """
    import json
    import uuid
    from dj.apps.g12f.paymentd_memo import parse_memo
    from dj.apps.purchases.models import PurchaseIntent,Rail,Status
    from .captured_notes import effective_note
    note=effective_note(note)
    if note.memo_hex is None:return None
    instruction=parse_memo(bytes.fromhex(note.memo_hex))
    if not instruction.buy:return None
    raw=json.loads(instruction.memo_plain)
    try:identifier=uuid.UUID(raw.get('intent'))
    except (TypeError,ValueError,AttributeError):return None
    intent=PurchaseIntent.objects.filter(pk=identifier,rail=Rail.ZEC).exclude(status=Status.CREDITED).first()
    return intent if intent and intent.rail_data.get('memo')==instruction.memo_plain else None


def purchase_target(note):
    """The original act/id memo names only a recipient, never a sender identity.

    Already-generated four-field memos remain routable by their act/id. Their
    old intent/proof fields are not purchase authority, amount or rate locks.
    """
    from dj.apps.g12f.paymentd_memo import parse_memo
    from dj.apps.g12f.models import Creator
    from .captured_notes import effective_note
    note = effective_note(note)
    if note.memo_hex is None:
        return None
    instruction = parse_memo(bytes.fromhex(note.memo_hex))
    if retained_zec_claim(note) is not None:
        return None
    if not instruction.buy:
        return None
    from django.db.models import Q
    binding = note.dispositions.filter(Q(event_key=f'payment-notice:{note.pk}') | Q(kind='pending_confirmation'), actor_id__isnull=False).order_by('created_at','pk').first()
    if binding is not None:
        return Creator.objects.filter(pk=binding.actor_id, username=instruction.username).first()
    return Creator.objects.filter(username=instruction.username).first()


def processing_snapshot(*, at=None):
    """Read a fresh, cross-checked shared price; never poll exchanges under locks."""
    from dj.apps.pricing.models import ZecPriceSnapshot
    from dj.apps.pricing.constants import SNAPSHOT_MAX_AGE_SECONDS, tuzis_per_zec
    from dj.apps.pricing.sources import SOURCES
    snapshot = ZecPriceSnapshot.objects.order_by('-created_at').first()
    try:
        valid = (snapshot is not None and isinstance(snapshot.sources, dict) and len(snapshot.sources) >= 2
            and snapshot.num_sources == len(snapshot.sources)
            and all(name in SOURCES and Decimal(str(value)).is_finite() and Decimal(str(value)) > 0
                for name, value in snapshot.sources.items())
            and snapshot.zec_usd.is_finite() and snapshot.zec_usd > 0
            and 0 <= snapshot.spread < 1
            and snapshot.tuzis_per_zec == tuzis_per_zec(snapshot.zec_usd, snapshot.spread)
            and 0 <= ((at or timezone.now()) - snapshot.created_at).total_seconds() <= SNAPSHOT_MAX_AGE_SECONDS)
    except (InvalidOperation, TypeError, ValueError):
        valid = False
    if not valid:
        raise money.EconomicRefusal('zec_pricing_unavailable')
    return snapshot


def confirmation_floor():
    try:
        value = int(os.environ.get('ZEC_MIN_CONFIRMATIONS', '3'))
        return max(3, value) if 0 <= value <= 1000 else 3
    except (TypeError, ValueError):
        return 3


@transaction.atomic
def settle_live_zec_note(*, note, creator, confirmations, instant=False):
    """One actual confirmed note, one processing rate and one atomic issuance."""
    from dj.apps.economy.models import FundingReservation
    from dj.apps.tuzis.models import ZecCreditReceipt
    from dj.apps.tuzis.ledger import to_tuzis
    if instant or confirmations < confirmation_floor():
        return CapturedFundingResult('pending_confirmation', f'captured-note:{note.pk}', False, 'waiting_for_confirmations')
    money._funding_locks(creator.pk, creator.pk)
    key = f'live-zec:{note.pk}'
    existing = FundingReservation.objects.filter(idempotency_key=key).first()
    if existing is not None:
        return CapturedFundingResult('pending_resolution', f'funding:{existing.pk}', False, 'funding_requires_resolution')
    from dj.apps.pricing import promotions
    from dj.apps.g12f.paymentd_memo import parse_memo
    instruction = parse_memo(bytes.fromhex(note.memo_hex))
    promotion, preview, processed_at = promotions.select_promotion(instruction.promo, lock=True)
    snapshot = processing_snapshot(at=processed_at)
    amount = Decimal(note.amount_zatoshi) / 100_000_000
    from dj.apps.pricing.constants import ZEC_SETTLEMENT_SPREAD, ZEC_ESTIMATE_BUFFER
    base_rate, rate, estimate_rate = promotions.rates(snapshot.zec_usd, Decimal(preview['multiplier']))
    credited = to_tuzis(amount * rate)
    m2z = int(credited * 1000)
    gross_nusd = int((amount * snapshot.zec_usd * 1_000_000_000).to_integral_value(rounding=ROUND_CEILING))
    provider = {'provider_reference': f'zec:{note.txid}:{note.pool}:{note.output_index}',
        'captured_at': note.first_seen_at.isoformat(), 'processed_at': processed_at.isoformat(),
        'captured_note_id': str(note.pk), 'amount_zec': str(amount),
        'pricing_method_version': contracts.ZEC_LIVE_FUNDING_VERSION,
        'pricing_method_digest': contracts.ZEC_LIVE_FUNDING_DIGEST,
        'snapshot_id': snapshot.pk, 'quoted_at': snapshot.created_at.isoformat(),
        'sources': snapshot.sources, 'zec_usd': str(snapshot.zec_usd), 'spread': str(ZEC_SETTLEMENT_SPREAD),
        'estimate_buffer': str(ZEC_ESTIMATE_BUFFER),
        'estimated_tuzis_per_zec': str(estimate_rate), 'base_tuzis_per_zec': str(base_rate),
        'promotion': dict(preview, id=str(promotion.pk) if promotion else None,
            starts_at=promotion.starts_at.isoformat() if promotion and promotion.starts_at else None),
        'tuzis_per_zec': str(rate), 'credited_m2z': str(m2z),
        'recipient_reference': f'free2z-account:{creator.pk}', 'sender_identity': 'shielded_sender_unknown'}
    # Raw funds remain recorded when a nominal amount cannot fit financial
    # storage. Never silently clamp, drop precision, or create a phantom credit.
    if m2z <= 0 or m2z > 99_999_999_999_999_999 or gross_nusd > 9_223_372_036_854_775_807:
        return CapturedFundingResult('pending_resolution', f'captured-note:{note.pk}', False, 'funding_amount_out_of_range')
    try:
        with transaction.atomic():
            reservation = money.reserve_funding(recipient_id=creator.pk, purchaser_id=creator.pk,
                amount_m2z=m2z, sale_nusd=gross_nusd, idempotency_key=key)
    except money.EconomicRefusal as exc:
        if str(exc) not in {'usage_daily_funding_limit', 'purchaser_daily_sales_limit'}:
            raise
        reservation = money.record_unreserved_funding_receipt(recipient_id=creator.pk, purchaser_id=creator.pk,
            amount_m2z=m2z, sale_nusd=gross_nusd, idempotency_key=key,
            receipt=dict(provider, resolution_reason=str(exc)))
        return CapturedFundingResult('pending_resolution', f'funding:{reservation.pk}', False, str(exc))
    reservation = money.issue_reserved_funding(reservation_id=reservation.pk, rail='zec', receipt=provider)
    if reservation.state != 'issued':
        return CapturedFundingResult('pending_resolution', f'funding:{reservation.pk}', False, 'funding_requires_resolution')
    receipt = ZecCreditReceipt.objects.create(txid=note.txid, pool=note.pool, output_index=note.output_index,
        creator=creator, amount_zec=amount, tuzis_credited=credited, tuzis_per_zec=rate,
        confirmations_at_credit=confirmations, instant=False)
    return CapturedFundingResult('issued', None, True, '', receipt)
