"""Bind Stripe webhook delivery to the credential used for checkout."""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

import stripe

from .models import StripeWebhookReadiness
from .stripe_identity import StripeIdentity


_EVENT_ID = re.compile(r'^evt_[A-Za-z0-9_]{3,251}$')
_ENDPOINT_ID = re.compile(r'^we_[A-Za-z0-9_]{3,252}$')
_MISSING = object()
READINESS_MAX_AGE = timedelta(hours=24)
READINESS_CANARY_EVENT_TYPE = 'customer.created'
# Manual capture is driven by the exact stored Checkout completion. Extra
# PI/refund/dispute subscriptions are optional observations, not core gates.
CORE_REQUIRED_EVENT_TYPES = ('checkout.session.completed', READINESS_CANARY_EVENT_TYPE)
_SESSION_FIELDS = (
    'id',
    'created',
    'client_reference_id',
    'payment_status',
    'mode',
    'livemode',
    'amount_total',
    'currency',
    'payment_intent',
)
_METADATA_FIELDS = (
    'checkout_intent_id',
    'user_id',
    'tuzis',
    'amount_cents',
    'currency',
    'pricing_version',
    'stripe_account_id',
    'stripe_mode',
    'stripe_livemode',
)


class StripeWebhookReadinessError(ValueError):
    """The webhook/account binding is absent, stale, or unprovable."""


def _value(container, key):
    attribute = getattr(container, key, _MISSING)
    if attribute is not _MISSING:
        return attribute
    try:
        return container[key]
    except (KeyError, TypeError):
        return _MISSING


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def configured_webhook_endpoint_id() -> str:
    value = settings.STRIPE_WEBHOOK_ENDPOINT_ID
    if not isinstance(value, str) or _ENDPOINT_ID.fullmatch(value) is None:
        raise StripeWebhookReadinessError(
            'STRIPE_WEBHOOK_ENDPOINT_ID is not canonical'
        )
    return value


class StripeWebhookEndpointMismatch(StripeWebhookReadinessError):
    """The endpoint was retrieved and one or more contract clauses failed.

    A separate class from a *retrieval* failure on purpose: a timeout or a
    Stripe 5xx is transient and the next tick may succeed, whereas a mismatch
    is a configuration fact every tick will find again until somebody edits a
    setting or the endpoint. A caller that pages immediately must only do so
    for this class.

    ``clauses`` names EVERY failed clause with its observed and expected
    values. Nothing here is secret: an endpoint's id, status, mode, URL and
    event list are shown in the Stripe dashboard to anyone who can see the
    endpoint, and none of them authenticates anything. Before  all five
    collapsed into one generic sentence, so an operator could not tell a
    disabled endpoint from a URL change or a dropped subscription without
    reproducing the call by hand.

    ``reason`` is a short machine-readable code; ``diagnosis`` is the one
    sentence an operator should read first, or ``None``.
    """

    def __init__(self, clauses, *, reason, diagnosis=None):
        self.clauses = list(clauses)
        self.reason = reason
        self.diagnosis = diagnosis
        detail = '; '.join(self.clauses)
        if diagnosis:
            detail = f'{diagnosis} ({detail})'
        super().__init__(f'webhook endpoint contract is unexpected: {detail}')


def _origin(url):
    """``scheme://host[:port]`` of ``url``, lower-cased, or ``None``."""
    if not isinstance(url, str):
        return None
    match = re.match(r'^([a-z][a-z0-9+.-]*://[^/?#\s]+)', url, re.IGNORECASE)
    return match.group(1).lower() if match else None


def _endpoint_mismatch(endpoint, endpoint_id, identity, expected_url):
    """Every failed contract clause, as observed-vs-expected text."""
    observed = {
        key: _value(endpoint, key)
        for key in ('id', 'status', 'livemode', 'url')
    }
    # `!r` wherever a provider value is interpolated: it quotes the value and
    # escapes any newline, so a surprising field cannot forge a second log
    # line out of the one the canary prints.
    shown = {
        key: '<absent>' if value is _MISSING else repr(value)
        for key, value in observed.items()
    }
    clauses = []
    if observed['id'] != endpoint_id:
        clauses.append(
            f'id={shown["id"]} does not match STRIPE_WEBHOOK_ENDPOINT_ID')
    if observed['status'] != 'enabled':
        clauses.append(f"status={shown['status']} (expected 'enabled')")
    if observed['livemode'] is not identity.livemode:
        clauses.append(
            f'livemode={shown["livemode"]} (expected {identity.livemode!r} '
            f'from STRIPE_EXPECTED_LIVEMODE)')
    if observed['url'] != expected_url:
        clauses.append(f'url={shown["url"]} (expected {expected_url!r})')
    enabled_events = _value(endpoint, 'enabled_events')
    if not isinstance(enabled_events, (list, tuple)):
        clauses.append('enabled_events is not a list')
    elif '*' not in enabled_events:
        missing = [
            event_type
            for event_type in CORE_REQUIRED_EVENT_TYPES
            if event_type not in enabled_events
        ]
        if missing:
            clauses.append(f'missing events: {missing!r}')
    if not clauses:
        return None

    reason = 'webhook_endpoint_mismatch'
    diagnosis = None
    ours = _origin(settings.CANONICAL_ORIGIN)
    theirs = _origin(observed['url'])
    if ours is not None and theirs is not None and theirs != ours:
        # The endpoint exists on this credential's account and delivers to a
        # DIFFERENT deployment. That is not a typo in a URL: this environment
        # is running on another environment's Stripe credentials. Stage on
        # prod's live key is the case that exists today, and naming it
        # is the point -- the generic "contract is unexpected" failed 180
        # times in 30 days on stage without anyone reading it.
        reason = 'endpoint_belongs_to_another_origin'
        mode = 'LIVE-MODE' if identity.livemode else 'test-mode'
        diagnosis = (
            f'this deployment ({ours}) is using {mode} Stripe credentials '
            f'whose webhook endpoint delivers to {theirs}, i.e. it shares '
            f"another environment's Stripe credentials and endpoint"
        )
        if identity.livemode:
            diagnosis += (
                " (stage using production's live-mode Stripe credentials is "
                'the known case, #2089); give this environment its own '
                'test-mode key, signing secret and webhook endpoint'
            )
    return StripeWebhookEndpointMismatch(
        clauses, reason=reason, diagnosis=diagnosis)


def prove_webhook_endpoint(identity: StripeIdentity) -> None:
    """Prove the configured endpoint belongs to the key and receives checkout.

    Raises:class:`StripeWebhookEndpointMismatch`, naming every failed clause,
    when the endpoint was retrieved and does not satisfy the contract; plain
    :class:`StripeWebhookReadinessError` when it could not be retrieved.
    """
    endpoint_id = configured_webhook_endpoint_id()
    try:
        endpoint = stripe.WebhookEndpoint.retrieve(
            endpoint_id,
            api_key=settings.STRIPE_SECRET_KEY,
            max_network_retries=0,
        )
    except stripe.error.StripeError as exc:
        raise StripeWebhookReadinessError(
            'webhook endpoint could not be retrieved'
        ) from exc
    expected_url = f"{settings.CANONICAL_ORIGIN.rstrip('/')}/api/stripe/webhook/"
    mismatch = _endpoint_mismatch(
        endpoint, endpoint_id, identity, expected_url)
    if mismatch is not None:
        raise mismatch


def _same_provider_event(received, retrieved) -> bool:
    """Compare every signed field used by checkout fulfillment."""
    if any(
        _value(received, key) != _value(retrieved, key)
        for key in ('id', 'type', 'livemode', 'account')
    ):
        return False
    received_session = _value(_value(received, 'data'), 'object')
    retrieved_session = _value(_value(retrieved, 'data'), 'object')
    if received_session is _MISSING or retrieved_session is _MISSING:
        return False
    if any(
        _value(received_session, key) != _value(retrieved_session, key)
        for key in _SESSION_FIELDS
    ):
        return False
    received_metadata = _value(received_session, 'metadata')
    retrieved_metadata = _value(retrieved_session, 'metadata')
    if received_metadata is _MISSING or received_metadata is None:
        received_metadata = {}
    if retrieved_metadata is _MISSING or retrieved_metadata is None:
        retrieved_metadata = {}
    return all(
        _value(received_metadata, key) == _value(retrieved_metadata, key)
        for key in _METADATA_FIELDS
    )


def verify_checkout_event(event, identity: StripeIdentity) -> str:
    """Prove one signed checkout event is retrievable by the checkout key."""
    event_id = _value(event, 'id')
    if not isinstance(event_id, str) or _EVENT_ID.fullmatch(event_id) is None:
        raise StripeWebhookReadinessError('provider event ID is not canonical')
    try:
        retrieved = stripe.Event.retrieve(
            event_id,
            api_key=settings.STRIPE_SECRET_KEY,
            max_network_retries=0,
        )
    except stripe.error.StripeError as exc:
        raise StripeWebhookReadinessError(
            'provider event could not be bound to the checkout account'
        ) from exc
    if not _same_provider_event(event, retrieved):
        raise StripeWebhookReadinessError(
            'provider event differs from the signed delivery'
        )
    if _value(retrieved, 'type') != 'checkout.session.completed':
        raise StripeWebhookReadinessError(
            'readiness requires checkout.session.completed'
        )
    if _value(retrieved, 'livemode') is not identity.livemode:
        raise StripeWebhookReadinessError('provider event mode is unexpected')
    event_account = _value(retrieved, 'account')
    if event_account not in {_MISSING, None, identity.account_id}:
        raise StripeWebhookReadinessError('provider event account is unexpected')
    return event_id


def verify_readiness_canary_event(event, identity: StripeIdentity) -> str:
    """Prove a nonfinancial live/test Customer delivery through this secret."""
    event_id = _value(event, 'id')
    if not isinstance(event_id, str) or _EVENT_ID.fullmatch(event_id) is None:
        raise StripeWebhookReadinessError('provider event ID is not canonical')
    if _value(event, 'type') != READINESS_CANARY_EVENT_TYPE:
        raise StripeWebhookReadinessError('readiness canary type is unexpected')
    try:
        retrieved = stripe.Event.retrieve(
            event_id,
            api_key=settings.STRIPE_SECRET_KEY,
            max_network_retries=0,
        )
    except stripe.error.StripeError as exc:
        raise StripeWebhookReadinessError(
            'provider event could not be bound to the checkout account'
        ) from exc
    if any(
        _value(event, key) != _value(retrieved, key)
        for key in ('id', 'type', 'livemode', 'account')
    ):
        raise StripeWebhookReadinessError(
            'provider event differs from the signed delivery'
        )
    received_object = _value(_value(event, 'data'), 'object')
    retrieved_object = _value(_value(retrieved, 'data'), 'object')
    if received_object is _MISSING or retrieved_object is _MISSING:
        raise StripeWebhookReadinessError('readiness canary object is missing')
    if any(
        _value(received_object, key) != _value(retrieved_object, key)
        for key in ('id', 'object', 'livemode')
    ):
        raise StripeWebhookReadinessError(
            'provider event differs from the signed delivery'
        )
    if _value(retrieved, 'livemode') is not identity.livemode:
        raise StripeWebhookReadinessError('provider event mode is unexpected')
    event_account = _value(retrieved, 'account')
    if event_account not in {_MISSING, None, identity.account_id}:
        raise StripeWebhookReadinessError('provider event account is unexpected')
    return event_id


def _record_readiness(event_id: str, identity: StripeIdentity) -> None:
    StripeWebhookReadiness.objects.update_or_create(
        singleton=1,
        defaults={
            'stripe_account_id': identity.account_id,
            'stripe_livemode': identity.livemode,
            'webhook_endpoint_id': configured_webhook_endpoint_id(),
            'secret_key_fingerprint': _fingerprint(settings.STRIPE_SECRET_KEY),
            'signing_secret_fingerprint': _fingerprint(
                settings.STRIPE_SIGNING_SECRET
            ),
            'provider_event_id': event_id,
        },
    )


def verify_and_record_checkout_event(event, identity: StripeIdentity) -> None:
    """Prove a signed event and record readiness for exact checkout."""
    event_id = verify_checkout_event(event, identity)

    _record_readiness(event_id, identity)


def verify_and_record_readiness_canary(event, identity: StripeIdentity) -> None:
    """Record a current nonfinancial provider-to-app delivery proof."""
    _record_readiness(verify_readiness_canary_event(event, identity), identity)


def _matching_readiness(identity: StripeIdentity):
    """Rows whose account AND current credential fingerprints all match.

    Deliberately age-agnostic. ``webhook_is_ready`` adds the freshness bound;
    ``current_readiness_proof`` does not, because an *expired* proof and a
    *missing* proof are different operational facts and the readiness canary
    has to be able to tell them apart to report an age.
    """
    endpoint_id = configured_webhook_endpoint_id()
    return StripeWebhookReadiness.objects.filter(
        singleton=1,
        stripe_account_id=identity.account_id,
        stripe_livemode=identity.livemode,
        webhook_endpoint_id=endpoint_id,
        secret_key_fingerprint=_fingerprint(settings.STRIPE_SECRET_KEY),
        signing_secret_fingerprint=_fingerprint(settings.STRIPE_SIGNING_SECRET),
    )


def current_readiness_proof(identity: StripeIdentity):
    """The account-bound proof row for this credential, or ``None``.

    Read-only. Returns the row even when it is older than
    ``READINESS_MAX_AGE`` so a caller can measure how far past expiry it is.
    """
    try:
        return _matching_readiness(identity).first()
    except StripeWebhookReadinessError:
        return None


def webhook_is_ready(identity: StripeIdentity) -> bool:
    """Return whether current key material has an account-bound delivery."""
    try:
        matching = _matching_readiness(identity)
    except StripeWebhookReadinessError:
        return False
    return matching.filter(
        verified_at__gte=timezone.now() - READINESS_MAX_AGE,
    ).exists()
