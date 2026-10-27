"""Exact, replay-safe settlement for verified Stripe Checkout events."""

from __future__ import annotations

import hashlib
import re
import uuid
from decimal import Decimal
from dataclasses import dataclass

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.pricing.constants import (
    CARD_CURRENCY,
    historical_card_quantity,
)
from dj.apps.tuzis import ledger

from .models import CheckoutFulfillmentAudit, CheckoutIntent, StripeTransaction
from .stripe_identity import (
    StripeIdentity,
    StripeIdentityConfigurationError,
    configured_legacy_checkout_cutoff,
    configured_stripe_identity,
    stripe_boolean,
)

CHECKOUT_METADATA_KEYS = {
    'checkout_intent_id',
    'user_id',
    'tuzis',
    'amount_cents',
    'currency',
    'pricing_version',
    'stripe_account_id',
    'stripe_mode',
    'stripe_livemode',
}
_SAFE_EVENT_ID = re.compile(r'^evt_[A-Za-z0-9_]{3,251}$')
_SAFE_SESSION_ID = re.compile(r'^cs_[A-Za-z0-9_]{3,252}$')
_SAFE_PAYMENT_INTENT_ID = re.compile(r'^pi_[A-Za-z0-9_]{3,252}$')
_SAFE_VERSION = re.compile(r'^[a-z0-9][a-z0-9._-]{0,31}$')
_SAFE_ACCOUNT_ID = re.compile(r'^acct_[A-Za-z0-9]{8,64}$')
_MISSING = object()


@dataclass(frozen=True)
class FulfillmentResult:
    outcome: str
    reason: str
    http_status: int


def checkout_metadata(intent: CheckoutIntent) -> dict[str, str]:
    """The exact server-owned contract copied into Stripe's signed event."""
    return {
        'checkout_intent_id': str(intent.public_id),
        'user_id': str(intent.user_id),
        'tuzis': str(intent.tuzis),
        'amount_cents': str(intent.amount_cents),
        'currency': intent.currency,
        'pricing_version': intent.pricing_version,
        'stripe_account_id': intent.stripe_account_id,
        'stripe_mode': intent.stripe_mode,
        'stripe_livemode': 'true' if intent.stripe_livemode else 'false',
    }


def _value(container, key):
    try:
        return container[key]
    except (KeyError, TypeError):
        return _MISSING


def _positive_integer(value):
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


def _safe_string(value, pattern):
    return value if isinstance(value, str) and pattern.fullmatch(value) else ''


def _event_identity(event) -> tuple[str, str | None]:
    raw = _value(event, 'id')
    if isinstance(raw, str) and _SAFE_EVENT_ID.fullmatch(raw):
        return f'stripe-event:{raw}', raw
    digest = hashlib.sha256(
        repr(raw).encode('utf-8', errors='backslashreplace')
    ).hexdigest()
    return f'stripe-event-invalid:{digest}', None


def _observed(session, event, identity: StripeIdentity) -> dict:
    metadata = _value(session, 'metadata')
    if metadata is _MISSING or metadata is None:
        metadata = {}
    return {
        'received_checkout_session_id': _safe_string(
            _value(session, 'id'), _SAFE_SESSION_ID,
        ),
        'received_payment_intent_id': _safe_string(
            _value(session, 'payment_intent'), _SAFE_PAYMENT_INTENT_ID,
        ),
        'received_session_created_epoch': _positive_integer(
            _value(session, 'created'),
        ),
        'expected_legacy_session_created_at_or_before_epoch': None,
        'received_user_id': _positive_integer(
            _value(session, 'client_reference_id'),
        ),
        'received_tuzis': _positive_integer(_value(metadata, 'tuzis')),
        'received_amount_cents': _positive_integer(
            _value(session, 'amount_total'),
        ),
        'received_currency': (
            _value(session, 'currency')
            if isinstance(_value(session, 'currency'), str)
            and len(_value(session, 'currency')) <= 16
            else ''
        ),
        'received_pricing_version': _safe_string(
            _value(metadata, 'pricing_version'), _SAFE_VERSION,
        ),
        'expected_stripe_account_id': identity.account_id,
        'expected_stripe_mode': identity.mode,
        'expected_stripe_livemode': identity.livemode,
        'received_event_account_id': _safe_string(
            _value(event, 'account'), _SAFE_ACCOUNT_ID,
        ),
        'received_stripe_mode': (
            _value(session, 'mode')
            if isinstance(_value(session, 'mode'), str)
            and len(_value(session, 'mode')) <= 16
            else ''
        ),
        'received_stripe_livemode': stripe_boolean(
            _value(session, 'livemode')
        ),
        'received_event_livemode': stripe_boolean(
            _value(event, 'livemode')
        ),
        'received_metadata_account_id': _safe_string(
            _value(metadata, 'stripe_account_id'), _SAFE_ACCOUNT_ID,
        ),
        'received_metadata_mode': (
            _value(metadata, 'stripe_mode')
            if isinstance(_value(metadata, 'stripe_mode'), str)
            and len(_value(metadata, 'stripe_mode')) <= 16
            else ''
        ),
        'received_metadata_livemode': (
            _value(metadata, 'stripe_livemode') == 'true'
            if _value(metadata, 'stripe_livemode') in {'true', 'false'}
            else None
        ),
    }


def _provider_identity_matches(event, observed, identity: StripeIdentity):
    """Validate signed provider identity, allowing absent direct-account ID."""
    raw_event_account = _value(event, 'account')
    return (
        observed['received_stripe_mode'] == identity.mode
        and observed['received_stripe_livemode'] is identity.livemode
        and observed['received_event_livemode'] is identity.livemode
        and (
            raw_event_account in {_MISSING, None}
            or observed['received_event_account_id'] == identity.account_id
        )
    )


def _record_audit(
    *,
    idempotency_key: str,
    provider_event_id: str | None,
    outcome: str,
    reason: str,
    observed: dict,
    intent=None,
    stripe_transaction=None,
    adjustment_tuzis=0,
):
    if outcome in {
        CheckoutFulfillmentAudit.Outcome.CREDITED,
        CheckoutFulfillmentAudit.Outcome.DUPLICATE,
    }:
        decision = 'successful_fulfillment'
    else:
        decision = '|'.join([
            outcome,
            reason,
            observed['expected_stripe_account_id'],
            observed['expected_stripe_mode'],
            str(observed['expected_stripe_livemode']),
        ])
    decision_digest = hashlib.sha256(
        f'{idempotency_key}\0{decision}'.encode('utf-8')
    ).hexdigest()
    decision_key = f'stripe-decision:{decision_digest}'
    defaults = {
        'provider_event_id': provider_event_id,
        'intent': intent,
        'stripe_transaction': stripe_transaction,
        'outcome': outcome,
        'reason': reason,
        'adjustment_tuzis': adjustment_tuzis,
        **observed,
    }
    audit, created = CheckoutFulfillmentAudit.objects.get_or_create(
        idempotency_key=decision_key,
        defaults=defaults,
    )
    if not created:
        CheckoutFulfillmentAudit.objects.filter(pk=audit.pk).update(
            attempts=F('attempts') + 1,
            last_seen_at=timezone.now(),
        )
    return audit, created


def _reject(identity, event_id, reason, observed, intent=None):
    _record_audit(
        idempotency_key=identity,
        provider_event_id=event_id,
        outcome=CheckoutFulfillmentAudit.Outcome.REJECTED,
        reason=reason,
        observed=observed,
        intent=intent,
    )
    return FulfillmentResult('rejected', reason, 400)


def _metadata_values(metadata):
    return {key: _value(metadata, key) for key in CHECKOUT_METADATA_KEYS}


def _has_authoritative_metadata(metadata_values):
    return any(value is not _MISSING for value in metadata_values.values())


def _matching_transaction(stripe_transaction, *, user_id, amount, tuzis):
    return (
        stripe_transaction.user_id == user_id
        and stripe_transaction.amount == amount
        and stripe_transaction.tuzis_credited == tuzis
    )


def _credit_or_link_existing(
    *,
    identity,
    event_id,
    observed,
    user,
    tuzis,
    amount,
    payment_intent,
    intent=None,
    writer_available=True,
):
    from dj.apps.economy.models import EconomicPolicy, FundingReservation
    from dj.apps.economy import services as money
    existing = StripeTransaction.objects.filter(stripe_charge_id=payment_intent).first()
    funding_issued = False
    policy = EconomicPolicy.objects.get()
    if existing is None and (policy.version == 1 or policy.fenced or not writer_available):
        captured = {'provider_reference': payment_intent,
            'captured_at': timezone.now().isoformat(),
            'paid_session_reference': observed['received_checkout_session_id'],
            'amount_cents': amount, 'quantity_2z': tuzis,
            'gross_usd': str(Decimal(amount) / 100), 'prepaid_value_nusd': tuzis * 10_000_000,
            'purchaser_authorization_reference': f'checkout-intent:{intent.public_id}' if intent else 'verified-legacy-checkout'}
        reservation = FundingReservation.objects.filter(idempotency_key=f'stripe-intent:{intent.public_id}').first() if intent else None
        if reservation:
            if reservation.external_receipt.get('provider_reference') == payment_intent:
                captured = reservation.external_receipt
            reservation = money.issue_reserved_funding(reservation_id=reservation.pk, rail='stripe', receipt=captured)
        else:
            captured['resolution_reason'] = 'capture_without_pre_authorized_funding'
            original = FundingReservation.objects.filter(idempotency_key=f'stripe-captured:{payment_intent}').first()
            if original:
                captured = original.external_receipt
            reservation = money.record_unreserved_funding_receipt(recipient_id=user.pk, purchaser_id=user.pk,
                amount_m2z=tuzis * 1000, sale_nusd=amount * 10_000_000,
                idempotency_key=f'stripe-captured:{payment_intent}', receipt=captured)
        if reservation.state != 'issued':
            _record_audit(idempotency_key=identity, provider_event_id=event_id,
                outcome=CheckoutFulfillmentAudit.Outcome.REJECTED, reason='funding_pending_resolution',
                observed=observed, intent=intent)
            return FulfillmentResult('pending_resolution', 'funding_requires_resolution', 200)
        funding_issued = True
    stripe_transaction, created = StripeTransaction.objects.get_or_create(
        stripe_charge_id=payment_intent,
        defaults={
            'user': user,
            'amount': amount,
            'tuzis_credited': tuzis,
        },
    )
    if not _matching_transaction(
        stripe_transaction,
        user_id=user.id,
        amount=amount,
        tuzis=tuzis,
    ):
        return _reject(
            identity,
            event_id,
            'payment_intent_conflict',
            observed,
            intent=intent,
        )
    if created:
        # A purchase on the stripe rail: `sys:clearing_stripe -> user`, keyed
        # on the PaymentIntent (the same identity StripeTransaction is unique
        # on), with the receipt named so the refund cursor exists (§5.8).
        if not funding_issued:
            ledger.credit(
                user, tuzis,
                source='sys:clearing_stripe',
                ref_kind='stripe_transaction',
                ref_id=str(stripe_transaction.pk),
                idem=f'stripe:{payment_intent}',
            )
        issued_tuzis = tuzis
        if funding_issued:
            from dj.apps.economy.funding import issued_usage_m2z
            issued_tuzis = Decimal(issued_usage_m2z(reservation)) / 1000
        if issued_tuzis > 0:
            Event.objects.create(
                read=False, type='BOUGHT_TUZI', amount=issued_tuzis,
                receiving_user=user, payee=user,
            )
    if intent is not None:
        intent.stripe_checkout_session_id = observed[
            'received_checkout_session_id'
        ]
        intent.stripe_payment_intent_id = payment_intent
        intent.state = CheckoutIntent.State.FULFILLED
        intent.fulfilled_at = timezone.now()
        intent.save(update_fields=[
            'stripe_checkout_session_id',
            'stripe_payment_intent_id',
            'state',
            'fulfilled_at',
            'updated_at',
        ])
        if intent.purchase_intent_id is not None:
            # An SDK purchase: same credit as above, nothing more;
            # this links the receipt and moves the purchase intent to
            # `credited` inside this transaction. Web checkouts carry NULL
            # and never get here.
            from dj.apps.purchases.services import record_card_fulfillment

            record_card_fulfillment(intent, stripe_transaction)
    outcome = (
        CheckoutFulfillmentAudit.Outcome.CREDITED
        if created
        else CheckoutFulfillmentAudit.Outcome.DUPLICATE
    )
    _record_audit(
        idempotency_key=identity,
        provider_event_id=event_id,
        outcome=outcome,
        reason='exact_intent' if intent is not None else 'legacy_exact',
        observed=observed,
        intent=intent,
        stripe_transaction=stripe_transaction,
    )
    return FulfillmentResult(outcome, 'fulfilled', 200)


def _fulfill_exact_intent(
    *, identity, event_id, session, metadata_values, observed, writer_available=True,
):
    try:
        public_id = uuid.UUID(str(metadata_values['checkout_intent_id']))
    except (ValueError, TypeError, AttributeError):
        return _reject(identity, event_id, 'invalid_intent_id', observed)

    # Actual captured receipts pin/lock known purchaser identities before the
    # checkout row; select_related must not silently lock an actor afterward.
    from dj.apps.economy import services as money
    hint = CheckoutIntent.objects.filter(public_id=public_id).first()
    if hint is not None:
        for actor_id in sorted(money._known_purchaser_ids(hint.user_id)):
            money._receipt_creator(actor_id)

    intent = (
        CheckoutIntent.objects.select_for_update(of=('self',))
        .select_related('user')
        .filter(public_id=public_id)
        .first()
    )
    if intent is None:
        return _reject(identity, event_id, 'unknown_intent', observed)

    if (
        intent.stripe_account_id != observed['expected_stripe_account_id']
        or intent.stripe_mode != observed['expected_stripe_mode']
        or intent.stripe_livemode is not observed['expected_stripe_livemode']
    ):
        return _reject(
            identity, event_id, 'intent_provider_identity_mismatch', observed,
            intent=intent,
        )

    expected_metadata = checkout_metadata(intent)
    if any(
        metadata_values[key] != value
        for key, value in expected_metadata.items()
    ):
        return _reject(
            identity, event_id, 'metadata_mismatch', observed, intent=intent,
        )
    if _value(session, 'payment_status') != 'paid':
        return _reject(
            identity, event_id, 'payment_not_paid', observed, intent=intent,
        )
    session_id = observed['received_checkout_session_id']
    payment_intent = observed['received_payment_intent_id']
    if not session_id or not payment_intent:
        return _reject(
            identity, event_id, 'invalid_provider_ids', observed, intent=intent,
        )
    if (
        intent.stripe_checkout_session_id is not None
        and intent.stripe_checkout_session_id != session_id
    ):
        return _reject(
            identity, event_id, 'checkout_session_mismatch', observed,
            intent=intent,
        )
    if (
        observed['received_user_id'] != intent.user_id
        or observed['received_tuzis'] != intent.tuzis
        or observed['received_amount_cents'] != intent.amount_cents
        or observed['received_currency'] != intent.currency
        or observed['received_pricing_version'] != intent.pricing_version
    ):
        return _reject(
            identity, event_id, 'signed_event_mismatch', observed,
            intent=intent,
        )
    return _credit_or_link_existing(
        identity=identity,
        event_id=event_id,
        observed=observed,
        user=intent.user,
        tuzis=intent.tuzis,
        amount=intent.amount_cents,
        writer_available=writer_available,
        payment_intent=payment_intent,
        intent=intent,
    )


def _fulfill_legacy(*, identity, event_id, session, observed, writer_available=True):
    """Settle only a cent amount the pre-v2 forward formula exactly produced."""
    try:
        legacy_cutoff = configured_legacy_checkout_cutoff()
    except StripeIdentityConfigurationError:
        return FulfillmentResult(
            'rejected', 'legacy_cutoff_not_configured', 503,
        )
    observed = {
        **observed,
        'expected_legacy_session_created_at_or_before_epoch': legacy_cutoff,
    }
    session_created = observed['received_session_created_epoch']
    if session_created > legacy_cutoff:
        return _reject(
            identity, event_id, 'legacy_session_after_cutoff', observed,
        )
    if _value(session, 'payment_status') != 'paid':
        return _reject(identity, event_id, 'legacy_payment_not_paid', observed)
    if observed['received_currency'] != CARD_CURRENCY:
        return _reject(identity, event_id, 'legacy_currency_mismatch', observed)
    amount = observed['received_amount_cents']
    tuzis = historical_card_quantity(amount) if amount is not None else None
    if tuzis is None:
        return _reject(identity, event_id, 'legacy_amount_not_exact', observed)
    session_id = observed['received_checkout_session_id']
    payment_intent = observed['received_payment_intent_id']
    user_id = observed['received_user_id']
    if not session_id or not payment_intent or user_id is None:
        return _reject(identity, event_id, 'legacy_invalid_provider_fields', observed)
    user = Creator.objects.select_for_update().filter(pk=user_id).first()
    if user is None:
        return _reject(identity, event_id, 'legacy_unknown_user', observed)
    legacy_observed = {**observed, 'received_tuzis': tuzis}
    return _credit_or_link_existing(
        identity=identity,
        event_id=event_id,
        observed=legacy_observed,
        user=user,
        tuzis=tuzis,
        amount=amount,
        writer_available=writer_available,
        payment_intent=payment_intent,
    )


def fulfill_checkout_completed(
    event, *, provider_identity: StripeIdentity | None = None,
) -> FulfillmentResult:
    """Fulfill one already-signature-verified ``checkout.session.completed``."""
    if provider_identity is None:
        try:
            provider_identity = configured_stripe_identity()
        except StripeIdentityConfigurationError:
            return FulfillmentResult('rejected', 'identity_not_configured', 503)
    identity, event_id = _event_identity(event)
    if event_id is None:
        observed = _observed({}, event, provider_identity)
        with transaction.atomic():
            return _reject(
                identity, event_id, 'invalid_provider_event_id', observed,
            )
    session = _value(_value(event, 'data'), 'object')
    if session is _MISSING:
        observed = _observed({}, event, provider_identity)
        with transaction.atomic():
            return _reject(identity, event_id, 'missing_session', observed)

    observed = _observed(session, event, provider_identity)
    metadata = _value(session, 'metadata')
    if metadata is _MISSING or metadata is None:
        metadata = {}
    metadata_values = _metadata_values(metadata)

    with transaction.atomic():
        from django.db import DatabaseError
        from dj.apps.economy.epoch import pin_supported_policy, is_explicit_policy_refusal
        from dj.apps.economy.services import EconomicRefusal
        writer_available = True
        try:
            with transaction.atomic():
                pin_supported_policy()
        except DatabaseError as exc:
            if not is_explicit_policy_refusal(exc):
                # Stripe retains the actual captured receipt and redelivers.
                # A brief lock/connection failure must not permanently consume
                # the funding reservation as manual resolution.
                raise
            writer_available = False
        except EconomicRefusal:
            # Already captured money remains recordable during a fence. The
            # policy lock is attempted before checkout or creator locks.
            writer_available = False
        if not _provider_identity_matches(
            event, observed, provider_identity,
        ):
            return _reject(
                identity, event_id, 'provider_identity_mismatch', observed,
            )
        if observed['received_session_created_epoch'] is None:
            return _reject(
                identity, event_id, 'session_created_invalid', observed,
            )
        if _has_authoritative_metadata(metadata_values):
            if any(value is _MISSING for value in metadata_values.values()):
                return _reject(
                    identity, event_id, 'partial_authoritative_metadata', observed,
                )
            return _fulfill_exact_intent(
                identity=identity,
                event_id=event_id,
                session=session,
                metadata_values=metadata_values,
                observed=observed,
                writer_available=writer_available,
            )
        return _fulfill_legacy(
            identity=identity,
            event_id=event_id,
            session=session,
            observed=observed,
            writer_available=writer_available,
        )
