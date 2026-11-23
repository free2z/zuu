"""Original PPV offers and delivery receipts denominated only in platform credits."""
import json
import uuid
from decimal import Decimal

from django.db import connection, transaction
from django.utils import timezone

from dj.apps.economy.epoch import pin_supported_policy
from dj.apps.economy.models import ServiceAdmission
from dj.apps.economy.services import EconomicRefusal
from dj.apps.g12f.models import Creator
from .host_presence import host_is_present
from .host_seat import host_seat_is_fresh
from .models import CreatorMeeting, PpvCreditAdmission, PpvCreditDelivery
from .participant_binding import current_provider_app_id


def require_credit_integration():
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regprocedure('economy.settle_ppv_credit_delivery(uuid,text,jsonb)')")
        if cursor.fetchone()[0] is None:
            raise EconomicRefusal('livestream_credit_integration_unavailable')


@transaction.atomic
def prepare_credit_admission(*, host_id, viewer_id, meeting_id, price_per_minute,
        idempotency_key, viewer_account_epoch):
    pin_supported_policy()
    require_credit_integration()
    price = Decimal(str(price_per_minute))
    if (not price.is_finite() or not 0 < price <= Decimal('9999.99')
            or price != price.quantize(Decimal('.01'))):
        raise EconomicRefusal('livestream_price_invalid')
    try:
        key = uuid.UUID(str(idempotency_key))
    except (ValueError, TypeError, AttributeError) as exc:
        raise EconomicRefusal('livestream_admission_identity_required') from exc
    actors = list(Creator.objects.select_for_update().filter(
        pk__in=sorted({host_id, viewer_id})).order_by('pk'))
    if len(actors) != 2 or any(not actor.is_active for actor in actors):
        raise EconomicRefusal('livestream_actor_unavailable')
    viewer = next(actor for actor in actors if actor.pk == viewer_id)
    if viewer.kt_account_epoch != viewer_account_epoch:
        raise EconomicRefusal('actor_authentication_changed')
    meeting = CreatorMeeting.objects.select_for_update(of=('self',)).filter(
        meeting_id=meeting_id, creator_id=host_id, meeting_type='ppv',
        is_public=True, live_now=True, lifecycle_state='live').first()
    if (meeting is None or not host_is_present(meeting)
            or not host_seat_is_fresh(meeting, timezone.now())):
        raise EconomicRefusal('livestream_offer_unavailable')
    if meeting.price_per_minute != price:
        raise EconomicRefusal('livestream_price_changed')
    captured = dict(host_id=host_id, viewer_account_epoch=viewer_account_epoch,
        app_id=current_provider_app_id(), meeting_id=str(meeting_id),
        creator_meeting_id=meeting.pk, provider_session_id=meeting.provider_session_id,
        provider_session_started_at=meeting.provider_session_started_at,
        host_session_id=meeting.host_session_id, price_per_minute=price, pricing_version=1)
    historical = ServiceAdmission.objects.filter(service='livestream_ppv',
        event_id=f'ppv-viewer:{viewer_id}:join:{key}').first()
    if historical is not None:
        original = historical.source
        expected = dict(meeting_id=str(meeting_id), creator_meeting_id=meeting.pk,
            provider_session_id=str(meeting.provider_session_id),
            host_session_id=str(meeting.host_session_id), subject_creator_id=viewer_id,
            price_per_minute_2z=str(price))
        if historical.creator_id != host_id or any(
                original.get(name) != value for name, value in expected.items()):
            raise EconomicRefusal('livestream_admission_identity_conflict')
        # The same key retains its original possibly minted participant across
        # the receipt-format transition; it cannot authorize another POST.
        raise EconomicRefusal('livestream_provider_outcome_unknown')
    existing = PpvCreditAdmission.objects.filter(viewer_id=viewer_id, idempotency_key=key).first()
    if existing is not None:
        if any(getattr(existing, name) != value for name, value in captured.items()):
            raise EconomicRefusal('livestream_admission_identity_conflict')
        # Add Participant has no proven idempotency or missing-result guarantee.
        # Never issue another participant after an ambiguous original POST.
        raise EconomicRefusal('livestream_provider_outcome_unknown')
    return PpvCreditAdmission.objects.create(viewer_id=viewer_id,
        idempotency_key=key, **captured)


@transaction.atomic
def settle_credit_delivery(*, admission_id, event_key, evidence):
    pin_supported_policy()
    with connection.cursor() as cursor:
        cursor.execute('SELECT economy.settle_ppv_credit_delivery(%s,%s,%s::jsonb)',
            [admission_id, event_key, json.dumps(evidence)])
        return PpvCreditDelivery.objects.get(pk=cursor.fetchone()[0])
