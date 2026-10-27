import json
import hmac
import logging
import re
import time
from html import escape
from urllib.parse import urlencode, urlsplit

from django.http import HttpResponse, JsonResponse
from django.conf import settings
from django.utils import timezone
from django.db import transaction
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers, viewsets
from rest_framework.decorators import (
    api_view,
    permission_classes,
    renderer_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.renderers import StaticHTMLRenderer

import stripe
from stripe._http_client import RequestsClient

from dj.apps.pricing.constants import card_quote
from dj.free2z.throttling import (
    NATIVE_CHECKOUT_RETURN_THROTTLES,
    StripeCheckoutUserRateThrottle,
)

from .fulfillment import checkout_metadata, fulfill_checkout_completed
from .models import CheckoutIntent, StripeTransaction
from .serializers import (
    CheckoutSessionErrorSerializer,
    CheckoutSessionRequestSerializer,
    CheckoutSessionResponseSerializer,
    TransactionSerializer,
)
from .stripe_identity import (
    STRIPE_API_VERSION,
    StripeIdentityConfigurationError,
    configured_stripe_identity,
    provider_proven_legacy_identity,
    stripe_checkout_enabled,
    stripe_boolean,
)
from .webhook_readiness import (
    StripeWebhookReadinessError,
    verify_checkout_event,
    verify_and_record_checkout_event,
    verify_and_record_readiness_canary,
    webhook_is_ready,
)
from .native_return import (
    APP_RETURN_URI,
    NativeReturnStripeDeadlineExceeded,
    NativeReturnUnavailable,
    NativeReturnUserMismatch,
    bridge_token_digest,
    checkout_session_digest,
    ensure_native_return_admission_ready,
    ensure_native_return_endpoint_ready,
    make_app_claim_token,
    make_bridge_token,
    make_processing_status_token,
    make_status_token,
    native_return_stripe_deadline,
    read_app_claim,
    read_bridge_token,
    read_status_resolution,
    read_status_token,
    record_status_resolution,
    release_native_return_provider_slot,
    valid_checkout_session_id,
    valid_payment_intent_id,
)
from .return_origin import (
    NativeReturnOriginInvalid,
    validated_native_return_origin,
)

logger = logging.getLogger(__name__)

stripe.api_key = settings.STRIPE_SECRET_KEY
stripe.max_network_retries = 0
# A credential check that can occupy a request worker for 80 seconds is not a
# fail-closed preflight in practice. Keep both account proof and Session
# creation bounded, with no SDK retry hidden behind our idempotency boundary.
stripe.default_http_client = RequestsClient(timeout=(3.05, 5))

#The Stripe API version every outbound request from this module declares.
#
#Pinned deliberately. stripe-python sends its OWN bundled version in
#the ``Stripe-Version`` header when this is unset, which makes the wire
#contract a side effect of whatever Dependabot installed:  moved it from
#``2023-10-16`` to ``2026-07-29.dahlia`` -- across four breaking API releases
#(Acacia, Basil, Clover, Dahlia) -- in a one-line requirements diff. That was
#safe only because someone read all four changelogs by hand; Dahlia removed
#the ``ui_mode`` values ``hosted``/``embedded``/``custom``, and every checkout
#would have started failing if ``create_checkout_session`` below had ever set
#one.
#
#The value is the version prod is already running (stripe-python 15.5.0's
#default), so pinning changes nothing today. From here on, moving the wire
#contract is its own PR with its own changelog review --
#``test_api_version_pin.py`` fails the gate when an SDK bump moves the
#default out from under this constant.
#
#NOT the webhook's version. The payload Stripe POSTs to ``stripe_webhook`` is
#rendered at the API version configured for the endpoint in the Stripe
#Dashboard, which no code here can set or read. An account/endpoint version
#upgrade in the Dashboard changes the events we parse with no code change, no
#PR and no CI signal -- track it wherever prod config is tracked.
stripe.api_version = STRIPE_API_VERSION

_SAFE_STRIPE_EVENT_TYPE = re.compile(r"^[a-z0-9._-]{1,100}$")
_SAFE_STRIPE_SESSION_ID = re.compile(r"^cs_[A-Za-z0-9_]{3,252}$")
_SAFE_STRIPE_EVENT_ID = re.compile(r"^evt_[A-Za-z0-9_]{3,251}$")
_SAFE_NOT_CREDITED_REASON = re.compile(r"^[a-z0-9_]{1,64}$")

#The ONE log event every charged-but-not-credited checkout outcome emits
#. ``stripe_checkout_rejected_<reason>`` and
#``stripe_checkout_provider_event_unproven`` still name the precise cause,
#but they are an open-ended family of names and no log metric could count
#all of them without being rewritten every time a reason is added. This name
#is fixed; ``monitoring/log-metrics/stripe-checkout-fulfillment-not-credited``
#counts it and a page-tier policy fires on the first one. A verified
#``checkout.session.completed`` that we answer with anything but 200 is, by
#construction, a Stripe payment we did not credit (yet): Stripe retries it
#for about three days and then stops, and the buyer is left charged with no
#2Z. The event carries only ``reason``, ``outcome``, ``http_status`` and the
#regex-validated ``evt_`` id an operator needs to resend it.
CHECKOUT_NOT_CREDITED_EVENT = "stripe_checkout_fulfillment_not_credited"
_MISSING = object()
_NATIVE_RETURN_PATH = "/api/stripe/native-return"
_NATIVE_RETURN_STRIPE_TIMEOUT_SECONDS = 5
_NATIVE_RETURN_STRIPE_DEADLINE_SECONDS = 6
_NATIVE_CHECKOUT_SESSION_MAX_AGE_SECONDS = 23 * 60 * 60
_native_return_stripe = stripe.StripeClient(
    settings.STRIPE_SECRET_KEY,
    stripe_version=STRIPE_API_VERSION,
    max_network_retries=0,
    http_client=stripe.RequestsClient(
        timeout=_NATIVE_RETURN_STRIPE_TIMEOUT_SECONDS,
    ),
)


def _log_native_status_correlation_failure():
    """Emit a fixed operational signal without provider identifiers.

    This deliberately lives outside the webhook handler: exception tracebacks
    from the provider call can contain credential-shaped values, while this
    best-effort index is not financial authority and needs no request detail to
    diagnose its availability.
    """
    logger.error("native checkout status correlation write failed")


def _safe_integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else "?"


def _log_stripe_webhook_event(
    event_name,
    level,
    *,
    stripe_transaction=None,
    received_amount_cents=None,
    received_tuzis=None,
    provider_event_type=None,
):
    """Log only typed local identifiers and amounts, never Stripe secrets."""
    payload = {"event": event_name}
    if stripe_transaction is not None:
        payload.update({
            "transaction_db_id": _safe_integer(stripe_transaction.pk),
            "user_db_id": _safe_integer(stripe_transaction.user_id),
            "stored_amount_cents": _safe_integer(stripe_transaction.amount),
            "stored_tuzis": _safe_integer(stripe_transaction.tuzis_credited),
            "received_amount_cents": _safe_integer(received_amount_cents),
            "received_tuzis": _safe_integer(received_tuzis),
        })
    if provider_event_type is not None:
        payload["provider_event_type"] = (
            provider_event_type
            if isinstance(provider_event_type, str)
            and _SAFE_STRIPE_EVENT_TYPE.fullmatch(provider_event_type)
            else "other"
        )
    logger.log(level, json.dumps(payload, separators=(",", ":"), sort_keys=True))


def _log_checkout_not_credited(event, *, outcome, reason, http_status):
    """Emit the fixed, countable charged-but-not-credited event."""
    try:
        raw_event_id = event['id']
    except (KeyError, TypeError):
        raw_event_id = None
    payload = {
        "event": CHECKOUT_NOT_CREDITED_EVENT,
        "outcome": (
            outcome if _SAFE_NOT_CREDITED_REASON.fullmatch(outcome) else "other"
        ),
        "reason": (
            reason if _SAFE_NOT_CREDITED_REASON.fullmatch(reason) else "other"
        ),
        "http_status": _safe_integer(http_status),
        "provider_event_id": (
            raw_event_id
            if isinstance(raw_event_id, str)
            and _SAFE_STRIPE_EVENT_ID.fullmatch(raw_event_id)
            else None
        ),
    }
    logger.error(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def _checkout_return_origin(request):
    """Use a CSRF-trusted public Origin, never the internal routing host."""
    origin = (request.headers.get('Origin') or '').rstrip('/')
    if origin in settings.CSRF_TRUSTED_ORIGINS:
        return origin
    return settings.CANONICAL_ORIGIN


def _valid_checkout_return_path(value):
    if not isinstance(value, str) or not value.startswith('/'):
        return False
    parsed = urlsplit(value)
    return not (
        value.startswith('//')
        or parsed.scheme
        or parsed.netloc
        or parsed.fragment
    )


def _stripe_value(value, key):
    attribute = getattr(value, key, _MISSING)
    if attribute is not _MISSING:
        return attribute
    try:
        return value[key]
    except (KeyError, TypeError):
        return None


#The response header on the DESIGNED 503 from ``create_checkout_session``
#, and its only value. See ``_designed_native_fallback``.
DESIGNED_FALLBACK_HEADER = 'X-Free2Z-Designed-Fallback'
DESIGNED_FALLBACK_NATIVE_CHECKOUT = 'native-checkout'

def _log_checkout_event(level, event, **fields):
    logger.log(level, json.dumps(
        {'event': event, **fields},
        separators=(',', ':'),
        sort_keys=True,
    ))


def _checkout_error(status, code, message):
    return JsonResponse({'error': message, 'code': code}, status=status)


def _designed_native_fallback(reason):
    """ZUULI's native return is unavailable: tell the app to use ``web``.

    This is a DESIGNED refusal, not a failure. It stays a **503** because
    that is the only thing the currently shipped ZUULI build understands:
    ``createNativeOrWebCheckout`` (zuu ``wallet/zuuli/src/features/wallet/
    funding/card-checkout.ts``) retries once as ``web`` on exactly
    ``error.status === 503`` and throws on anything else, so any other status
    would turn every mobile card purchase into an error screen.

    So the designed case is MARKED instead, three ways, none of which a
    genuine outage carries: the ``X-Free2Z-Designed-Fallback: native-checkout``
    header, ``code: native_checkout_unavailable`` in the body, and the
    ``stripe_checkout_native_fallback`` log event. Every genuine failure on
    this endpoint answers 500 or 502 instead (``CHECKOUT_ERROR_CODES``).

    The path off the 503, once installed apps can take it: ship a ZUULI build
    that falls back on ``code == native_checkout_unavailable`` (or the header)
    whatever the status, wait until the pre-``code`` builds are gone, then
    answer this with a 409 and drop the 503 exclusion from the alerts.
    """
    _log_checkout_event(
        logging.INFO if reason == 'disabled' else logging.WARNING,
        'stripe_checkout_native_fallback',
        reason=reason,
    )
    response = _checkout_error(
        503,
        'native_checkout_unavailable',
        'Native checkout return is not enabled.'
        if reason == 'disabled'
        else 'Native checkout return is temporarily unavailable.',
    )
    response[DESIGNED_FALLBACK_HEADER] = DESIGNED_FALLBACK_NATIVE_CHECKOUT
    return response


def _prove_checkout_identity():
    """Use a recent account-bound delivery proof before Session.create.

    Returns ``(identity, None)``, or ``(None, response)`` with the refusal.
    """
    try:
        if not stripe_checkout_enabled():
            # The operator's deliberate switch: designed, so it keeps its 503.
            _log_checkout_event(
                logging.WARNING, 'stripe_checkout_not_activated',
            )
            return None, _checkout_error(
                503, 'checkout_not_activated',
                'Card checkout is not enabled.',
            )
        identity = configured_stripe_identity()
    except (StripeIdentityConfigurationError, StripeWebhookReadinessError):
        _log_checkout_event(
            logging.ERROR, 'stripe_checkout_identity_not_configured',
        )
        return None, _checkout_error(
            500, 'checkout_not_configured',
            'Stripe checkout is not safely configured.',
        )
    if not webhook_is_ready(identity):
        _log_checkout_event(logging.ERROR, 'stripe_checkout_webhook_not_ready')
        return None, _checkout_error(
            500, 'checkout_not_configured',
            'Stripe checkout is not safely configured.',
        )
    return identity, None


def _prove_staged_webhook_identity():
    """Prove the current provider account while new checkout is staged off."""
    try:
        account = stripe.Account.retrieve(
            api_key=settings.STRIPE_SECRET_KEY,
            max_network_retries=0,
        )
        return provider_proven_legacy_identity(_stripe_value(account, 'id'))
    except (stripe.error.StripeError, StripeIdentityConfigurationError) as exc:
        raise StripeWebhookReadinessError(
            'staged webhook account could not be proven'
        ) from exc


def _expire_invalid_checkout_session(checkout_session):
    """Best-effort containment for a provider response outside our contract."""
    session_id = _stripe_value(checkout_session, 'id')
    if (
        not isinstance(session_id, str)
        or not _SAFE_STRIPE_SESSION_ID.fullmatch(session_id)
    ):
        return
    try:
        stripe.checkout.Session.expire(
            session_id,
            api_key=settings.STRIPE_SECRET_KEY,
            max_network_retries=0,
        )
    except stripe.error.StripeError:
        logger.error(json.dumps(
            {'event': 'stripe_checkout_invalid_session_expiry_failed'},
            separators=(',', ':'),
            sort_keys=True,
        ))


@extend_schema(
    request=CheckoutSessionRequestSerializer,
    responses={
        200: CheckoutSessionResponseSerializer,
        400: CheckoutSessionErrorSerializer,
        409: CheckoutSessionErrorSerializer,
        500: CheckoutSessionErrorSerializer,
        502: CheckoutSessionErrorSerializer,
        503: CheckoutSessionErrorSerializer,
    },
    parameters=[
        OpenApiParameter(
            name=DESIGNED_FALLBACK_HEADER,
            type=str,
            location=OpenApiParameter.HEADER,
            response=[503],
            enum=[DESIGNED_FALLBACK_NATIVE_CHECKOUT],
            description=(
                'Present, with the value `native-checkout`, only on the '
                'DESIGNED 503 that refuses `returnMode: zuuli_mobile` because '
                'the native return is gated off or not ready (body `code`: '
                '`native_checkout_unavailable`). The client should retry the '
                'same request once with `returnMode: web`. A 503 without it is '
                '`checkout_not_activated` (the operator switch). Genuine '
                'outages are 500 (our configuration or infrastructure) or 502 '
                '(Stripe), never 503.'
            ),
        ),
    ],
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([StripeCheckoutUserRateThrottle])
def create_checkout_session(request):
    # Fail closed BEFORE anything is created. An empty host policy means
    # STRIPE_CHECKOUT_ALLOWED_HOSTS was set to something malformed (see
    # dj.free2z.settings._parse_stripe_checkout_allowed_hosts), so every URL
    # Stripe could return would be rejected downstream by
    # CheckoutSessionResponseSerializer. Refusing here keeps that from costing
    # a real provider Session, a CheckoutIntent row and a Stripe-side hold
    # that we would then have to expire.
    if not settings.STRIPE_CHECKOUT_ALLOWED_HOSTS:
        _log_checkout_event(
            logging.ERROR, 'stripe_checkout_host_policy_unavailable',
        )
        # 500, not 503: a broken host policy is a real outage.
        return _checkout_error(
            500, 'checkout_host_policy_unavailable',
            'Card checkout is temporarily unavailable.',
        )

    return_mode = _mapping_body(request).get('returnMode', 'web')
    if return_mode not in ('web', 'zuuli_mobile'):
        return _checkout_error(
            400, 'invalid_return_mode', 'Invalid return mode',
        )
    if (
        return_mode == 'zuuli_mobile'
        and not settings.ZUULI_NATIVE_CHECKOUT_ENABLED
    ):
        return _designed_native_fallback('disabled')
    native_return_origin = None
    if return_mode == 'zuuli_mobile':
        try:
            native_return_origin, _parts = validated_native_return_origin()
            ensure_native_return_endpoint_ready(_parts)
            ensure_native_return_admission_ready()
        except (NativeReturnUnavailable, NativeReturnOriginInvalid):
            # Enabled but not ready: still the designed fallback (web checkout
            # works), logged at WARNING with its own reason.
            return _designed_native_fallback('not_ready')

    domain_url = (
        native_return_origin
        if return_mode == 'zuuli_mobile'
        else _checkout_return_origin(request)
    )
    request_serializer = CheckoutSessionRequestSerializer(data=request.data)
    if not request_serializer.is_valid():
        return _checkout_error(
            400, 'invalid_request', 'Invalid checkout request.',
        )
    currentPath = request_serializer.validated_data['currentPath']
    # Get currentPath from the request data. Native callers cannot influence
    # any return URL; their mode selects server-owned endpoints below.
    if return_mode == 'web' and not _valid_checkout_return_path(currentPath):
        return _checkout_error(
            400, 'invalid_return_path', 'Invalid return path',
        )

    # Define specific paths/routes for success and cancel
    # You can also add query parameters if needed
    # success_path = f"{currentPath}?payment=success"
    # we can just use the webhook/events/snackbar to show success
    success_state = None
    if return_mode == 'zuuli_mobile':
        # Mobile always returns to the dedicated HTTPS host whose whole GCLB
        # backend has request logging disabled. Browser input cannot select it.
        success_state = make_bridge_token(request.user.id, 'success')
        cancel_state = make_bridge_token(request.user.id, 'cancel')
        success_path = (
            f"{_NATIVE_RETURN_PATH}/success/?"
            + urlencode({'state': success_state})
            + '&session_id={CHECKOUT_SESSION_ID}'
        )
        cancel_path = (
            f"{_NATIVE_RETURN_PATH}/cancel/?"
            + urlencode({'state': cancel_state})
        )
    else:
        success_path = currentPath
        cancel_path = currentPath

    quantity = request_serializer.validated_data['quantity']

    from dj.apps.economy.models import EconomicPolicy
    expected_actor = _mapping_body(request).get('expected_actor_id')
    if (expected_actor is not None and (type(expected_actor) is not int or expected_actor != request.user.pk)) or (
        EconomicPolicy.objects.get(pk=True).version == 1 and expected_actor != request.user.pk
    ):
        return _checkout_error(409, 'actor_changed', 'The authenticated account changed. Review this purchase again.')

    # 2Z are priced at $0.01 each; card adds max($0.50, 10% of base).
    # Formula lives in dj.apps.pricing.constants so it stays consistent with
    # the live ZEC pricing.
    quote = card_quote(quantity)
    identity, refusal = _prove_checkout_identity()
    if refusal is not None:
        return refusal
    if EconomicPolicy.objects.get(pk=True).version == 1:
        from .economic_events import reconcile_expired_card_authorizations
        reconcile_expired_card_authorizations(creator_id=request.user.pk, identity=identity)
    try:
        with transaction.atomic():
            from dj.apps.economy.epoch import pin_supported_policy
            from dj.apps.economy.services import reserve_funding
            policy_version = pin_supported_policy()
            expected_actor = _mapping_body(request).get('expected_actor_id')
            if (expected_actor is not None and (type(expected_actor) is not int or expected_actor != request.user.pk)) or (
                policy_version == 1 and expected_actor != request.user.pk
            ):
                from dj.apps.economy.services import EconomicRefusal
                raise EconomicRefusal('actor_changed')
            if policy_version == 1:
                from dj.apps.economy.services import _funding_locks
                from dj.apps.g12f.models import Creator
                _funding_locks(request.user.pk, request.user.pk)
                actor = Creator.objects.get(pk=request.user.pk)
                # A transport failure may have created a provider Session whose
                # ID we never received. Do not create another purchase while
                # that original reserved instruction remains unresolved.
                from dj.apps.economy.models import FundingReservation
                ambiguous = CheckoutIntent.objects.filter(user_id=request.user.pk,
                    stripe_checkout_session_id__isnull=True,
                    state__in=(CheckoutIntent.State.CREATING, CheckoutIntent.State.PROVIDER_FAILED))
                if FundingReservation.objects.filter(purchaser_id=request.user.pk, state__in=('reserved', 'issuing', 'resolution'),
                    idempotency_key__in=[f'stripe-intent:{row.public_id}' for row in ambiguous]).exists():
                    from dj.apps.economy.services import EconomicRefusal
                    raise EconomicRefusal('checkout_original_instruction_unresolved')
                if not actor.is_active or Creator.objects.values_list(
                    'kt_account_epoch', flat=True).get(pk=request.user.pk) != request.user.kt_account_epoch:
                    from dj.apps.economy.services import EconomicRefusal
                    raise EconomicRefusal('actor_authentication_changed')
            intent = CheckoutIntent.objects.create(
                user=request.user,
                tuzis=quote.tuzis,
                amount_cents=quote.amount_cents,
                currency=quote.currency,
                pricing_version=quote.pricing_version,
                stripe_account_id=identity.account_id,
                stripe_mode=identity.mode,
                stripe_livemode=identity.livemode,
            )
            if policy_version == 1:
                reserve_funding(recipient_id=request.user.pk, purchaser_id=request.user.pk,
                    amount_m2z=quote.tuzis * 1000, sale_nusd=quote.amount_cents * 10_000_000,
                    idempotency_key=f'stripe-intent:{intent.public_id}')
    except Exception as exc:
        from dj.apps.economy.services import EconomicRefusal
        if not isinstance(exc, EconomicRefusal):
            raise
        return _checkout_error(409, str(exc), 'Funding cannot be authorized with these terms.')
    metadata = checkout_metadata(intent)
    create_kwargs = dict(
        payment_method_types=['card'],
        line_items=[{
            'price_data': {
                'currency': quote.currency,
                'product_data': {
                    'name': f'{quote.tuzis} 2Z credits',
                },
                'unit_amount': quote.amount_cents,
            },
            'quantity': 1,
        }],
        mode='payment',
        adaptive_pricing={'enabled': False},
        client_reference_id=str(request.user.id),
        success_url=f"{domain_url}{success_path}",
        cancel_url=f"{domain_url}{cancel_path}",
        metadata=metadata,
        payment_intent_data={'metadata': metadata},
        idempotency_key=f'free2z-checkout-intent-{intent.public_id}',
        api_key=settings.STRIPE_SECRET_KEY,
        max_network_retries=0,
    )
    if policy_version == 1:
        create_kwargs['payment_intent_data']['capture_method'] = 'manual'
    if return_mode == 'zuuli_mobile':
        create_kwargs['origin_context'] = 'mobile_app'
        # Stripe permits 30 minutes through 24 hours. Expiring the Session at
        # 23 hours leaves a one-hour margin inside the signed bridge's 24-hour
        # lifetime even though the bridge is minted before this API call.
        create_kwargs['expires_at'] = (
            int(time.time()) + _NATIVE_CHECKOUT_SESSION_MAX_AGE_SECONDS
        )
        create_kwargs['metadata'] = {
            **metadata,
            # Bind the signed return state to this exact Stripe Session. A
            # payer cannot pair one return token with another of their own
            # Session IDs to make the app report the wrong purchase.
            'native_return_state_sha256': bridge_token_digest(success_state),
        }
    creation_ambiguous = False
    try:
        # Reuse the exact original parameters and provider key. Only a
        # connection failure is ambiguous; one bounded retry may recover its
        # original Session. Exhausted ambiguity retains the original capacity
        # for manual resolution and never authorizes a new caller purchase.
        try:
            checkout_session = stripe.checkout.Session.create(**create_kwargs)
        except stripe.error.APIConnectionError:
            creation_ambiguous = True
            checkout_session = stripe.checkout.Session.create(**create_kwargs)
    except stripe.error.StripeError as exc:
        intent.state = CheckoutIntent.State.PROVIDER_FAILED
        intent.save(update_fields=['state', 'updated_at'])
        from .economic_events import release_preexecution_creation_refusal
        release_preexecution_creation_refusal(intent, exc, ambiguous=creation_ambiguous)
        # The class name only: a provider message can echo request detail.
        _log_checkout_event(
            logging.ERROR, 'stripe_checkout_session_create_failed',
            error_type=type(exc).__name__,
        )
        return _checkout_error(
            502, 'stripe_unavailable',
            'The original checkout could not be confirmed. Preserve this instruction and contact support before starting another purchase.',
        )

    response_mode = _stripe_value(checkout_session, 'mode')
    response_livemode = stripe_boolean(
        _stripe_value(checkout_session, 'livemode')
    )
    response_account = _stripe_value(checkout_session, 'account')
    if (
        response_mode != identity.mode
        or response_livemode is not identity.livemode
        or (
            response_account is not None
            and response_account != identity.account_id
        )
    ):
        _expire_invalid_checkout_session(checkout_session)
        intent.state = CheckoutIntent.State.PROVIDER_FAILED
        intent.save(update_fields=['state', 'updated_at'])
        logger.error(json.dumps(
            {'event': 'stripe_checkout_session_identity_invalid'},
            separators=(',', ':'),
            sort_keys=True,
        ))
        return _checkout_error(
            502, 'stripe_invalid_session',
            'Stripe returned an invalid checkout session.',
        )

    payload = {
        'id': getattr(checkout_session, 'id', None),
        'url': getattr(checkout_session, 'url', None),
        'quote': {
            'checkout_intent_id': intent.public_id,
            'tuzis': quote.tuzis,
            'amount_cents': quote.amount_cents,
            'currency': quote.currency,
            'pricing_version': quote.pricing_version,
        },
    }
    response_serializer = CheckoutSessionResponseSerializer(data=payload)
    if not response_serializer.is_valid():
        _expire_invalid_checkout_session(checkout_session)
        intent.state = CheckoutIntent.State.PROVIDER_FAILED
        intent.save(update_fields=['state', 'updated_at'])
        logger.error(json.dumps(
            {'event': 'stripe_checkout_session_contract_invalid'},
            separators=(',', ':'),
            sort_keys=True,
        ))
        return _checkout_error(
            502, 'stripe_invalid_session',
            'Stripe returned an invalid checkout session.',
        )

    session_id = response_serializer.validated_data['id']
    opened = CheckoutIntent.objects.filter(
        pk=intent.pk,
        state=CheckoutIntent.State.CREATING,
        stripe_checkout_session_id=None,
    ).update(
        stripe_checkout_session_id=session_id,
        state=CheckoutIntent.State.OPEN,
        updated_at=timezone.now(),
    )
    if opened != 1:
        intent.refresh_from_db()
        if not (
            intent.state == CheckoutIntent.State.FULFILLED
            and intent.stripe_checkout_session_id == session_id
        ):
            _expire_invalid_checkout_session(checkout_session)
            logger.error(json.dumps(
                {'event': 'stripe_checkout_intent_open_conflict'},
                separators=(',', ':'),
                sort_keys=True,
            ))
            return _checkout_error(
                502, 'checkout_state_conflict',
                'Checkout state changed unexpectedly.',
            )
    # Include the hosted checkout URL so clients that can't use Stripe.js
    # (e.g. the ZUULI desktop client) can redirect straight to it.
    return JsonResponse(response_serializer.data)


def _mapping_body(request):
    """The parsed request body, but only when it is actually a mapping.

    ``request.data`` is whatever the configured parser produced. Perfectly
    valid JSON can be an array, a string, a number or ``null``, none of which
    have ``.get()`` or ``.keys()``. Reading those off the body directly turned
    a malformed client request into an AttributeError -> 500. Every caller
    here wants "the object the client should have sent", so a non-mapping body
    degrades to empty and falls through to that view's normal bounded 400.
    """
    return request.data if isinstance(request.data, dict) else {}


def _one_query(request, names):
    if set(request.GET.keys()) != set(names):
        return None
    values = {}
    for name in names:
        items = request.GET.getlist(name)
        if len(items) != 1 or not items[0]:
            return None
        values[name] = items[0]
    return values


def _payment_intent_id(value):
    if isinstance(value, str):
        return value
    return _stripe_value(value, 'id')


def _retrieve_native_checkout_session(session_id):
    return _native_return_stripe.v1.checkout.sessions.retrieve(session_id)


def _private_html(
    title,
    message,
    app_url=None,
    status_code=200,
    retry_after_seconds=None,
):
    link = ""
    refresh = ""
    if app_url is not None:
        safe_url = escape(app_url, quote=True)
        refresh = f'<meta http-equiv="refresh" content="0;url={safe_url}">'
        link = f'<p><a href="{safe_url}">Return to ZUULI</a></p>'
    if retry_after_seconds is not None:
        retry_after_seconds = max(1, int(retry_after_seconds))
        # Empty href repeats the exact current HTTPS request without reflecting
        # its signed query into the body. This is deliberately explicit rather
        # than an unbounded meta-refresh loop.
        link += '<p><a href="">Retry verification</a></p>'
    response = HttpResponse(
        (
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'{refresh}<title>{escape(title)}</title></head><body><main>'
            f'<h1>{escape(title)}</h1><p>{escape(message)}</p>{link}'
            '</main></body></html>'
        ),
        status=status_code,
        content_type='text/html; charset=utf-8',
    )
    response['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response['Pragma'] = 'no-cache'
    response['Content-Security-Policy'] = (
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    response['Referrer-Policy'] = 'no-referrer'
    response['X-Content-Type-Options'] = 'nosniff'
    if retry_after_seconds is not None:
        response['Retry-After'] = str(retry_after_seconds)
    return response


def _return_error(message, status_code=400):
    return _private_html('Checkout return unavailable', message, status_code=status_code)


def _native_return_admission_response(
    request,
    *,
    state_token,
    state_payload,
    session_id,
):
    """Render an admitted return's recoverable fail-closed state, if any."""
    if getattr(request, '_native_checkout_admission_unavailable', False):
        return _native_return_dependency_failure(
            state_token,
            state_payload,
            'Checkout verification is temporarily unavailable.',
            session_id=session_id,
            retry_after_seconds=2,
        )
    retry_after = getattr(request, '_native_checkout_retry_seconds', None)
    if retry_after is not None:
        # Capacity denial proves only that this signed success return belongs
        # to the user. It does NOT query Stripe, assert payment, or mint a
        # payment-intent status token. The bounded claim merely returns to
        # Wallet funding for an authoritative balance refresh.
        return _native_return_processing_handoff(
            state_token,
            state_payload,
            'Verification is busy. Return to ZUULI to refresh your '
            'authoritative balance, or retry verification here.',
            session_id=session_id,
            status_code=429,
            retry_after_seconds=retry_after,
        )
    return None


def _native_return_processing_handoff(
    state_token,
    state_payload,
    message,
    *,
    session_id=None,
    status_code,
    retry_after_seconds,
):
    """Return to the app without asserting payment or credit."""
    payload = {
        'v': 1,
        'uid': state_payload['uid'],
        'outcome': 'processing',
    }
    if session_id is not None:
        # This one-way digest correlates a future verified webhook without
        # exposing the provider identifier or asserting payment/credit.
        payload['session_digest'] = checkout_session_digest(session_id)
    code = make_app_claim_token(state_token, payload)
    app_url = f"{APP_RETURN_URI}?{urlencode({'code': code})}"
    return _private_html(
        'Finishing checkout',
        message + ' Do not start another purchase.',
        app_url=app_url,
        status_code=status_code,
        retry_after_seconds=retry_after_seconds,
    )


def _native_return_dependency_failure(
    state_token,
    state_payload,
    message,
    *,
    session_id=None,
    retry_after_seconds=5,
):
    return _native_return_processing_handoff(
        state_token,
        state_payload,
        message + ' Return to ZUULI to refresh your authoritative balance.',
        session_id=session_id,
        status_code=503,
        retry_after_seconds=retry_after_seconds,
    )


def _native_return_handoff(state_token, payload):
    code = make_app_claim_token(state_token, payload)
    app_url = f"{APP_RETURN_URI}?{urlencode({'code': code})}"
    outcome = payload['outcome']
    title = 'Payment submitted' if outcome == 'success' else 'Checkout cancelled'
    message = (
        'Return to ZUULI to check the verified payment status.'
        if outcome == 'success'
        else 'No payment success is implied by this cancellation.'
    )
    return _private_html(title, message, app_url=app_url)


@extend_schema(
    parameters=[
        OpenApiParameter(
            "state", OpenApiTypes.STR, OpenApiParameter.QUERY, required=True
        ),
        OpenApiParameter(
            "session_id", OpenApiTypes.STR, OpenApiParameter.QUERY, required=True
        ),
    ],
    responses={
        (200, "text/html"): OpenApiTypes.STR,
        (400, "text/html"): OpenApiTypes.STR,
        (404, "text/html"): OpenApiTypes.STR,
        (410, "text/html"): OpenApiTypes.STR,
        (429, "text/html"): OpenApiTypes.STR,
        (503, "text/html"): OpenApiTypes.STR,
    },
)
@api_view(['GET'])
@permission_classes([AllowAny])
@throttle_classes(NATIVE_CHECKOUT_RETURN_THROTTLES)
@renderer_classes([StaticHTMLRenderer])
def native_checkout_success(request):
    query = _one_query(request, ('state', 'session_id'))
    if query is None or not valid_checkout_session_id(query['session_id']):
        return _return_error('The checkout return was malformed.')
    state_payload = read_bridge_token(query['state'], 'success')
    if state_payload is None:
        return _return_error('The checkout return was invalid or expired.', 410)
    admission_response = _native_return_admission_response(
        request,
        state_token=query['state'],
        state_payload=state_payload,
        session_id=query['session_id'],
    )
    if admission_response is not None:
        return admission_response
    provider_lease_token = getattr(
        request, '_native_checkout_provider_lease_token', None
    )
    try:
        try:
            with native_return_stripe_deadline(
                _NATIVE_RETURN_STRIPE_DEADLINE_SECONDS
            ):
                checkout_session = _retrieve_native_checkout_session(
                    query['session_id']
                )
        except (
            stripe.error.StripeError,
            NativeReturnStripeDeadlineExceeded,
            NativeReturnUnavailable,
        ):
            return _native_return_dependency_failure(
                query['state'],
                state_payload,
                'Stripe status is temporarily unavailable.',
                session_id=query['session_id'],
            )
    finally:
        release_native_return_provider_slot(provider_lease_token)
    payment_intent = _payment_intent_id(
        _stripe_value(checkout_session, 'payment_intent')
    )
    if (
        _stripe_value(checkout_session, 'id') != query['session_id']
        or _stripe_value(checkout_session, 'client_reference_id')
        != str(state_payload['uid'])
        or not hmac.compare_digest(
            str(_stripe_value(
                _stripe_value(checkout_session, 'metadata'),
                'native_return_state_sha256',
            ) or ''),
            bridge_token_digest(query['state']),
        )
        or not valid_payment_intent_id(payment_intent)
    ):
        return _return_error('The checkout session did not match this return.', 400)
    if (
        _stripe_value(checkout_session, 'status') != 'complete'
        or _stripe_value(checkout_session, 'payment_status') != 'paid'
    ):
        # A valid user/session binding proves whose Checkout this is, not that
        # Stripe completed or paid it. Keep the handoff non-authoritative and
        # let the app refresh its balance instead of claiming success.
        return _native_return_processing_handoff(
            query['state'],
            state_payload,
            'Stripe has not confirmed this checkout as paid yet.',
            session_id=query['session_id'],
            status_code=200,
            retry_after_seconds=2,
        )
    return _native_return_handoff(query['state'], {
        'v': 1,
        'uid': state_payload['uid'],
        'outcome': 'success',
        'session_id': query['session_id'],
        'payment_intent': payment_intent,
    })


@extend_schema(
    parameters=[
        OpenApiParameter(
            "state", OpenApiTypes.STR, OpenApiParameter.QUERY, required=True
        ),
    ],
    responses={
        (200, "text/html"): OpenApiTypes.STR,
        (400, "text/html"): OpenApiTypes.STR,
        (404, "text/html"): OpenApiTypes.STR,
        (410, "text/html"): OpenApiTypes.STR,
        (429, "text/html"): OpenApiTypes.STR,
        (503, "text/html"): OpenApiTypes.STR,
    },
)
@api_view(['GET'])
@permission_classes([AllowAny])
@throttle_classes(NATIVE_CHECKOUT_RETURN_THROTTLES)
@renderer_classes([StaticHTMLRenderer])
def native_checkout_cancel(request):
    query = _one_query(request, ('state',))
    if query is None:
        return _return_error('The checkout return was malformed.')
    state_payload = read_bridge_token(query['state'], 'cancel')
    if state_payload is None:
        return _return_error('The checkout return was invalid or expired.', 410)
    cancel_payload = {
        'v': 1,
        'uid': state_payload['uid'],
        'outcome': 'cancel',
    }
    # Cancellation never queries Stripe or reserves provider capacity. Apply
    # its separate signed-owner budget while Redis is healthy; if Redis itself
    # is unavailable, fail open to this truthful local-only handoff so the user
    # is not stranded. A healthy rate denial still returns the bounded cancel
    # claim while bounding owner replay and identifying the retry interval.
    retry_after = getattr(request, '_native_checkout_retry_seconds', None)
    if (
        not getattr(request, '_native_checkout_admission_unavailable', False)
        and retry_after is not None
    ):
        code = make_app_claim_token(query['state'], cancel_payload)
        app_url = f"{APP_RETURN_URI}?{urlencode({'code': code})}"
        return _private_html(
            'Checkout cancelled',
            'No payment success is implied by this cancellation. Return to '
            'ZUULI, or retry this page after the signed-owner limit resets.',
            app_url=app_url,
            status_code=429,
            retry_after_seconds=retry_after,
        )
    return _native_return_handoff(query['state'], cancel_payload)


@extend_schema(
    request=inline_serializer(
        name="StripeNativeReturnClaimRequest",
        fields={"code": serializers.CharField()},
    ),
    responses={
        200: inline_serializer(
            name="StripeNativeReturnClaimResponse",
            fields={
                "outcome": serializers.ChoiceField(
                    choices=["success", "cancel", "processing"]
                ),
                "status": serializers.ChoiceField(
                    choices=["processing", "cancelled"]
                ),
                "status_token": serializers.CharField(required=False),
            },
        ),
        410: OpenApiResponse(description="Claim expired or invalid."),
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def native_checkout_claim(request):
    body = _mapping_body(request)
    if set(body.keys()) != {'code'}:
        return JsonResponse({'detail': 'Invalid checkout return claim.'}, status=400)
    try:
        payload = read_app_claim(body.get('code'), request.user.id)
    except NativeReturnUserMismatch:
        return JsonResponse(
            {'detail': 'Checkout return claim did not match user.'},
            status=403,
        )
    if payload is None:
        return JsonResponse(
            {'detail': 'Checkout return claim is invalid or expired.'},
            status=410,
        )
    if payload.get('v') != 1 or payload.get('uid') != request.user.id:
        return JsonResponse({'detail': 'Checkout return claim was malformed.'}, status=400)
    if payload.get('outcome') == 'cancel':
        return JsonResponse({'outcome': 'cancel', 'status': 'cancelled'})
    if payload.get('outcome') == 'processing':
        # The optional one-way Session digest is correlation only. It carries
        # no provider status or payment assertion; only the verified webhook
        # can resolve it to the PaymentIntent-backed ledger row.
        response = {'outcome': 'processing', 'status': 'processing'}
        session_digest = payload.get('session_digest')
        if session_digest is not None:
            response['status_token'] = make_processing_status_token(
                request.user.id,
                session_digest,
            )
        return JsonResponse(response)
    session_id = payload.get('session_id')
    payment_intent = payload.get('payment_intent')
    if (
        payload.get('outcome') != 'success'
        or not isinstance(session_id, str)
        or not valid_checkout_session_id(session_id)
        or not valid_payment_intent_id(payment_intent)
    ):
        return JsonResponse({'detail': 'Checkout return claim was malformed.'}, status=400)
    return JsonResponse({
        'outcome': 'success',
        'status': 'processing',
        'status_token': make_status_token(request.user.id, payment_intent),
    })


@extend_schema(
    request=inline_serializer(
        name="StripeNativeReturnStatusRequest",
        fields={"status_token": serializers.CharField()},
    ),
    responses={
        200: inline_serializer(
            name="StripeNativeReturnStatusResponse",
            fields={
                "status": serializers.ChoiceField(choices=["processing", "credited"]),
                "tuzis_credited": serializers.IntegerField(required=False),
            },
        ),
        410: OpenApiResponse(description="Status token invalid or expired."),
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def native_checkout_status(request):
    body = _mapping_body(request)
    if set(body.keys()) != {'status_token'}:
        return JsonResponse({'detail': 'Invalid checkout status request.'}, status=400)
    payload = read_status_token(body.get('status_token'), request.user.id)
    if payload is None:
        return JsonResponse({'detail': 'Checkout status token is invalid or expired.'}, status=410)
    payment_intent = payload.get('payment_intent')
    if payload.get('v') == 2:
        try:
            payment_intent = read_status_resolution(
                request.user.id,
                payload['session_digest'],
            )
        except NativeReturnUnavailable:
            # Correlation is an availability aid, never financial authority.
            # A cache outage cannot promote the return or suppress the app's
            # authoritative session/balance refresh.
            return JsonResponse({'status': 'processing'})
        if payment_intent is None:
            return JsonResponse({'status': 'processing'})
    credited = StripeTransaction.objects.filter(
        user=request.user,
        stripe_charge_id=payment_intent,
    ).first()
    if credited is None:
        # The browser return never fulfills money. Only the verified webhook
        # creates this row and credits the ledger, so this remains processing.
        return JsonResponse({'status': 'processing'})
    return JsonResponse({
        'status': 'credited',
        'tuzis_credited': credited.tuzis_credited,
    })


# Decorator order matters. `csrf_exempt` is outermost so the attribute
# CsrfViewMiddleware looks for is set on the view the URLconf actually
# resolves to; `require_POST` then runs first inside it, before any
# request body is read.
#
# What the method guard buys, and what it does not:
# it does NOT add authentication -- signature verification against
# STRIPE_SIGNING_SECRET is, and remains, the only thing that decides
# whether this endpoint credits anyone. What it buys is that a GET/HEAD
# is refused with 405 by Django's URL layer instead of being handed to
# stripe.Webhook.construct_event, which today answers a bare GET with a
# 400 JSON body. That answer is a free oracle ("yes, a Stripe webhook
# lives here") for anyone crawling for one, every crawler hit becomes an
# exception-shaped 400 in the logs that looks like a delivery failure,
# and the endpoint's whole safety story rests on a single check. It also
# states the intent in the code, where 's AST guard (which flags
# GET-with-side-effect views) can see it.
@transaction.non_atomic_requests
@csrf_exempt  # Disable CSRF protection for this view
@require_POST
def stripe_webhook(request):
    payload = request.body
    sig_header = request.headers.get('STRIPE_SIGNATURE')

    # FAIL CLOSED ON A MISSING SECRET (from the codex review).
    #
    # `STRIPE_SIGNING_SECRET` defaults to '' when the env var is absent, and an
    # empty HMAC key is a perfectly usable HMAC key -- one that anybody can
    # compute with. So a namespace created without the secret, or a rotation
    # that lands the Deployment before the Secret, would not break this
    # endpoint: it would silently turn it into "POST JSON, receive 2Z", with no
    # error anywhere to say so. Refuse instead.
    #
    # 503, not 400: the delivery is presumably genuine and it is our
    # configuration that is broken, so Stripe should retry it (they retry 5xx)
    # and credit the customer once the secret is in place, rather than record a
    # permanent failure for a payment that really happened.
    if not settings.STRIPE_SIGNING_SECRET:
        logger.error(json.dumps(
            {"event": "stripe_signing_secret_missing"}, sort_keys=True,
        ))
        return JsonResponse({'detail': 'Webhook not configured.'}, status=503)

    # Never dump the raw webhook payload: it carries customer PII (email,
    # name, address) and is attacker-controlled before the signature is
    # verified below. The verified event type is logged after construction.
    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.STRIPE_SIGNING_SECRET
        )
    except ValueError:
        # Invalid payload
        return JsonResponse({'detail': 'Invalid payload.'}, status=400)
    except stripe.error.SignatureVerificationError:
        # Invalid signature
        return JsonResponse({'detail': 'Invalid signature.'}, status=400)

    # Handle the event. ``construct_event`` above is the only signature trust
    # boundary; fulfillment below accepts no request-body fields directly.
    from .economic_events import (CAPTURE_EVENT_TYPES, FINANCIAL_EVENT_TYPES,
        FINANCIAL_PROVIDER_READ_LIMIT, FinancialProviderReadBudget, ProviderReadUnavailable, handle_capture_event,
        handle_financial_event, record_financial_event_retrieval_failure, verified_financial_event)
    if event['type'] in CAPTURE_EVENT_TYPES | FINANCIAL_EVENT_TYPES:
        # The signed Event.retrieve call shares the same 24-second deadline
        # and gets one slot in addition to the bounded reconciliation reads.
        read_budget = FinancialProviderReadBudget(max_calls=FINANCIAL_PROVIDER_READ_LIMIT + 1)
        try:
            canonical, identity = verified_financial_event(event, read_budget=read_budget)
        except ProviderReadUnavailable as exc:
            if event['type'] in FINANCIAL_EVENT_TYPES:
                try:
                    result = record_financial_event_retrieval_failure(event, exc.identity, exc)
                except (StripeIdentityConfigurationError, StripeWebhookReadinessError):
                    return JsonResponse({'detail': 'Financial provider event could not be proven.'}, status=503)
                return JsonResponse({'status': result.status, 'reason': result.reason,
                    'resolution_id': result.resolution_id, 'credited': False}, status=503)
            return JsonResponse({'detail': 'Financial provider event could not be proven.'}, status=503)
        except (StripeIdentityConfigurationError, StripeWebhookReadinessError):
            return JsonResponse({'detail': 'Financial provider event could not be proven.'}, status=503)
        result = (handle_capture_event(canonical, identity) if event['type'] in CAPTURE_EVENT_TYPES
            else handle_financial_event(canonical, identity, read_budget=read_budget))
        return JsonResponse({'status': result.status, 'reason': result.reason,
            'resolution_id': result.resolution_id, 'credited': result.status in {'credited', 'duplicate'}},
            status=503 if result.status == 'retry' else 200)
    if event['type'] == 'checkout.session.completed':
        try:
            if stripe_checkout_enabled():
                identity = configured_stripe_identity()
                verify_and_record_checkout_event(event, identity)
            else:
                try:
                    identity = configured_stripe_identity()
                except StripeIdentityConfigurationError:
                    # A rolling deployment must keep settling already-paid
                    # legacy Sessions before the new identity settings exist.
                    # This narrower path proves the account/event but cannot
                    # establish readiness for new Session creation.
                    identity = _prove_staged_webhook_identity()
                    verify_checkout_event(event, identity)
                else:
                    # Provisioning and provider test delivery happen while the
                    # UI remains staged off. Record that proof now so the later
                    # externally controlled activation cannot deadlock waiting
                    # for a post-activation payment.
                    verify_and_record_checkout_event(event, identity)
        except (
            StripeIdentityConfigurationError,
            StripeWebhookReadinessError,
        ):
            _log_stripe_webhook_event(
                'stripe_checkout_provider_event_unproven',
                logging.ERROR,
            )
            _log_checkout_not_credited(
                event,
                outcome='unproven',
                reason='provider_event_unproven',
                http_status=503,
            )
            return JsonResponse(
                {'detail': 'Checkout provider event could not be proven.'},
                status=503,
            )
        except Exception:
            # A Stripe API outage or a bug here is a 500 that Stripe retries,
            # and until it succeeds the buyer is charged with no 2Z. The
            # generic write-failure alerts need more than one failure an hour
            # to fire, and Stripe's backoff is slower than that.
            _log_checkout_not_credited(
                event, outcome='error', reason='verification_exception',
                http_status=500,
            )
            raise
        session_object = event['data']['object']
        if isinstance(session_object, stripe.StripeObject):
            session_object = session_object.to_dict()
        from dj.apps.economy.models import FundingReservation
        checkout_id = session_object.get('metadata', {}).get('checkout_intent_id')
        if checkout_id and FundingReservation.objects.filter(
            idempotency_key=f'stripe-intent:{checkout_id}').exists():
            from .economic_events import handle_checkout_capture
            capture = handle_checkout_capture(event, identity)
            return JsonResponse({'status': capture.status, 'reason': capture.reason,
                'credited': capture.status in {'credited', 'duplicate'}},
                status=503 if capture.status == 'retry' else 200)
        try:
            result = fulfill_checkout_completed(
                event, provider_identity=identity,
            )
        except Exception:
            _log_checkout_not_credited(
                event, outcome='error', reason='fulfillment_exception',
                http_status=500,
            )
            raise
        _log_stripe_webhook_event(
            f'stripe_checkout_{result.outcome}_{result.reason}',
            logging.INFO if result.http_status == 200 else logging.ERROR,
        )
        if result.http_status != 200:
            _log_checkout_not_credited(
                event,
                outcome=result.outcome,
                reason=result.reason,
                http_status=result.http_status,
            )
            return JsonResponse(
                {'detail': 'Checkout fulfillment contract rejected.'},
                status=result.http_status,
            )
        if result.outcome == 'pending_resolution':
            return JsonResponse({'status': 'pending_resolution', 'credited': False, 'reason': result.reason})
        # Native-return correlation is written only after webhook-
        # authoritative credit. It is an availability aid for the app's
        # status polling, never financial authority; failure is logged and
        # swallowed so it cannot turn a settled payment into a redelivery.
        session_object = event['data']['object']
        if isinstance(session_object, stripe.StripeObject):
            session_object = session_object.to_dict()
        try:
            record_status_resolution(
                int(_stripe_value(session_object, 'client_reference_id')),
                _stripe_value(session_object, 'id'),
                _stripe_value(session_object, 'payment_intent'),
            )
        except (NativeReturnUnavailable, TypeError, ValueError):
            _log_native_status_correlation_failure()

    elif event['type'] == 'customer.created':
        try:
            identity = configured_stripe_identity()
        except StripeIdentityConfigurationError:
            _log_stripe_webhook_event(
                'stripe_checkout_readiness_canary_not_configured',
                logging.WARNING,
            )
        else:
            try:
                verify_and_record_readiness_canary(event, identity)
            except StripeWebhookReadinessError:
                _log_stripe_webhook_event(
                    'stripe_checkout_readiness_canary_unproven',
                    logging.ERROR,
                )
                return JsonResponse(
                    {'detail': 'Checkout readiness event could not be proven.'},
                    status=503,
                )

    #... handle other event types
    else:
        _log_stripe_webhook_event(
            "stripe_event_unhandled",
            logging.WARNING,
            provider_event_type=event['type'],
        )

    return JsonResponse({'success': True})


class TransactionViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = StripeTransaction.objects.all()
    serializer_class = TransactionSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return self.queryset.filter(user=self.request.user)
