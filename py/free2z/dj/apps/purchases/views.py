"""``POST /api/sdk/v1/purchases`` and ``GET /api/sdk/v1/purchases/{id}``.

zuu ``docs/free2z/sdk/spec/purchase.md`` §1-§3, card rail only (PU1).

Authentication is any of the three project credentials: a session, a Knox
token, or an OAuth access token from ``dj.apps.oidc`` carrying
``purchase:create`` (spec §1: that one scope covers creating an intent and
reading the intents the app created). ``required_scopes`` is what opens these
views to OAuth at all -- ``OAuth2JWTAuthentication`` is default-deny.

The card rail opens a Stripe Checkout Session the same way the web wallet
does (``ztripe.views.create_checkout_session``): the same server-owned
``CheckoutIntent``, the same signed metadata, the same identity proof before
the provider call, the same ``card_quote`` price. Policy1 uses reserved manual
capture; policy0 retains automatic capture through shared fulfillment helpers.
"""
from __future__ import annotations

from dj.apps.economy.services import EconomicRefusal

import json
import logging
import re
import time
import uuid
from datetime import timedelta
from urllib.parse import urlencode, urlsplit

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from dj.apps.oidc.authentication import OAuthAccessToken
from dj.apps.oidc.redirects import KIND_LOOPBACK, RedirectURIError, classify
from dj.apps.oidc.scopes import SCOPE_PURCHASE_CREATE
from dj.apps.pricing.constants import card_quote
from dj.apps.tuzis import models as idempotency
from dj.free2z.sdk_api import SdkAPIView, envelope
from dj.free2z.throttling import SdkPurchaseRateThrottle

from .models import PurchaseIntent, Rail, Status
from .serializers import (
    ErrorEnvelopeSerializer,
    PurchaseIntentCreateSerializer,
    PurchaseIntentSerializer,
    intent_payload,
)
from .services import heal_card_intent, project_expiry

logger = logging.getLogger(__name__)

#Spec §2 / §3.
CARD_MIN_2Z = 100
CARD_MAX_2Z = 10_000
CARD_INTENT_TTL = timedelta(minutes=30)
#Stripe refuses a Session ``expires_at`` less than 30 minutes after it
#creates the Session, and its clock starts after ours. One minute of slack;
#a payment in that minute is the spec's ``expired -> paid`` (§1.2).
_STRIPE_SESSION_TTL_SECONDS = 31 * 60

IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
#Spec §1: 1-128 ASCII characters. Printable, no whitespace, so the stored
#key is exactly what was sent.
_IDEMPOTENCY_KEY = re.compile(r"^[\x21-\x7e]{1,128}$")
IDEMPOTENCY_SCOPE_PREFIX = "purchase_intent:"

#The statuses a client keeps polling (spec §1.3), which get ``Retry-After``.
_POLLED_STATUSES = frozenset({Status.CREATED, Status.PENDING, Status.PAID})
_RETRY_AFTER_SECONDS = "2"

PURCHASE_IDEMPOTENCY_KEY_PARAMETER = OpenApiParameter(
    name=IDEMPOTENCY_KEY_HEADER,
    type=OpenApiTypes.STR,
    location=OpenApiParameter.HEADER,
    required=True,
    description=(
        "Required. 1-128 printable ASCII characters, scoped to (app, user); "
        "an OAuth app and a first-party session are separate scopes. A "
        "replay with the same body returns the original intent, as it is "
        "NOW, with the original status code, and opens no second checkout. "
        "The same key with a different body is 409 `idempotency_conflict`; "
        "while the original request is still running it is 409 "
        "`idempotency_conflict` with `details.in_flight: true`. Missing or "
        "malformed: 400 `invalid_request`. Keys are honoured for at least "
        "24 hours."
    ),
)


def _error(status: int, code: str, message: str, details: dict | None = None) -> Response:
    return envelope(status, code, message, details)


def _log(level, event, **fields):
    logger.log(level, json.dumps({"event": event, **fields}, separators=(",", ":"), sort_keys=True, default=str))


def _application(request):
    auth = request.auth
    return auth.application if isinstance(auth, OAuthAccessToken) else None


def _idempotency_scope(application) -> str:
    """Spec §1: keys are scoped to (app, user); a first-party caller is its
    own scope."""
    return IDEMPOTENCY_SCOPE_PREFIX + (str(application.pk) if application else "first_party")


def _first_party_origins() -> set[str]:
    origins = {o.rstrip("/") for o in getattr(settings, "CSRF_TRUSTED_ORIGINS", ())}
    origins.add(settings.CANONICAL_ORIGIN.rstrip("/"))
    return {o for o in origins if o.startswith("https://")}


def validate_return_url(value: str, application) -> str | None:
    """``None`` if ``value`` may receive the browser after checkout, else why not.

    Spec §2: one of the app's registered redirect URIs or a loopback URI.
    A first-party caller (no app) may instead name an https Free2Z origin.
    Never a private-use scheme: Stripe redirects only to web URLs.
    """
    if "?" in value or "#" in value:
        return "must not carry a query string or fragment"
    try:
        kind = classify(value)
    except RedirectURIError as exc:
        return str(exc)
    if kind == KIND_LOOPBACK:
        return None
    parts = urlsplit(value)
    if parts.scheme != "https":
        return "must be an https URL or a loopback http URL"
    if application is not None:
        if value in application.redirect_uri_list:
            return None
        return "must be one of the app's registered redirect URIs, or a loopback URI"
    origin = f"{parts.scheme}://{parts.netloc}".lower()
    if origin in _first_party_origins():
        return None
    return "must be a Free2Z https URL or a loopback URI"


#The Free2Z billing page (Zcash first, card second; tuzi#2705). It
#redirects a signed-out user through login.
BILLING_PATH = "/buy-2z"


def zcash_billing_url(application) -> str:
    """Where a ``rail: zcash`` refusal sends the user (tuzi#2705).

    Built on ``CANONICAL_ORIGIN``, never the request host. An OAuth caller's
    ``client_id`` rides along so the page can name the app that sent the
    user; a first-party caller gets the bare page. Nothing here is a return
    URL: Zcash credits after confirmations, and the app re-reads the balance.
    """
    url = settings.CANONICAL_ORIGIN.rstrip("/") + BILLING_PATH
    if application is not None:
        url = _with_query(url, client_id=application.client_id)
    return url


def _with_query(url: str, **params) -> str:
    return f"{url}?{urlencode(params)}"


class PurchaseIntentCreateView(SdkAPIView):
    """Create a purchase intent and open its rail's payment surface."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [SdkPurchaseRateThrottle]
    required_scopes = [SCOPE_PURCHASE_CREATE]
    # The Stripe call must not run inside a request-wide transaction (the
    # same reason /api/stripe/create-checkout-session is non-atomic), and
    # the idempotency claim must commit before the work it guards.
    atomic_request = False

    @extend_schema(
        operation_id="purchases_intents_create",
        summary="Create a purchase intent (buy 2Z)",
        parameters=[PURCHASE_IDEMPOTENCY_KEY_PARAMETER],
        request=PurchaseIntentCreateSerializer,
        responses={
            201: OpenApiResponse(PurchaseIntentSerializer, description="The intent, `pending`, with `rail_data.checkout_url`."),
            400: OpenApiResponse(
                ErrorEnvelopeSerializer,
                description=(
                    "`rail: zcash` is 400 `rail_unavailable` with `details.billing_url`: "
                    "the Free2Z billing page (`<origin>/buy-2z`, with `?client_id=<app>` "
                    "for an OAuth caller), where the user pays with Zcash."
                ),
            ),
            409: ErrorEnvelopeSerializer,
            500: ErrorEnvelopeSerializer,
            502: ErrorEnvelopeSerializer,
            503: ErrorEnvelopeSerializer,
        },
    )
    def post(self, request):
        key = request.headers.get(IDEMPOTENCY_KEY_HEADER)
        if key is None or not _IDEMPOTENCY_KEY.fullmatch(key):
            return _error(
                400, "invalid_request",
                "Idempotency-Key is required: 1-128 printable ASCII characters.",
                {"field": IDEMPOTENCY_KEY_HEADER, "reason": "missing" if key is None else "malformed"},
            )
        if not isinstance(request.data, dict):
            return _error(400, "invalid_request", "The body must be a JSON object.")
        unknown = sorted(set(request.data) - set(PurchaseIntentCreateSerializer().fields))
        if unknown:
            return _error(400, "invalid_request", "Unknown field.", {"field": unknown[0], "reason": "unknown"})
        serializer = PurchaseIntentCreateSerializer(data=request.data)
        if not serializer.is_valid():
            field = sorted(serializer.errors)[0]
            return _error(400, "invalid_request", "Invalid purchase request.", {"field": field, "reason": "invalid"})
        data = serializer.validated_data
        quantity = request.data.get("quantity_2z")
        if isinstance(quantity, bool) or not isinstance(quantity, int):
            # IntegerField accepts "500" and 500.0; the spec's field is a
            # whole-number JSON integer.
            return _error(400, "invalid_quantity", "quantity_2z must be a whole number of 2Z.",
                          {"min_2z": CARD_MIN_2Z, "max_2z": CARD_MAX_2Z})

        from dj.apps.economy.models import EconomicPolicy
        policy_version = EconomicPolicy.objects.get(pk=True).version
        asserted_actor = request.data.get('expected_actor_id')
        if (asserted_actor is not None and (type(asserted_actor) is not int or asserted_actor != request.user.pk)) or (
            policy_version == 1 and _application(request) is None and asserted_actor != request.user.pk):
            return _error(409, 'actor_identity_changed', 'The authenticated account changed. Review this purchase again.')
        rail = data["rail"]
        if rail == "zcash":
            billing_url = zcash_billing_url(_application(request))
            return _error(400, "rail_unavailable",
                'Zcash purchases use a shielded payment with the account memo, not a purchase intent. '
                f'Pay with Zcash (preferred) on the Free2Z billing page, {billing_url}, for the '
                'receiving address, the memo and the estimated amount; '
                'the actual received payment is credited at the live processing rate.',
                {"billing_url": billing_url})
        if rail != "card":
            # Zcash per-intent addresses are Z1; the in-app purchase rails are
            # first-party only and not built yet.
            return _error(400, "rail_unavailable", f"The {rail} rail is not available.", {"rail": rail})
        if data["embed"]:
            return _error(400, "invalid_request", "The embedded payment element is not available.",
                          {"field": "embed", "reason": "unsupported"})
        if not CARD_MIN_2Z <= data["quantity_2z"] <= CARD_MAX_2Z:
            return _error(400, "invalid_quantity",
                          f"Card purchases are {CARD_MIN_2Z} to {CARD_MAX_2Z} 2Z.",
                          {"min_2z": CARD_MIN_2Z, "max_2z": CARD_MAX_2Z})
        application = _application(request)
        return_url = data.get("return_url")
        if not return_url:
            return _error(400, "invalid_request", "return_url is required for card.",
                          {"field": "return_url", "reason": "missing"})
        refused = validate_return_url(return_url, application)
        if refused is not None:
            return _error(400, "invalid_request", f"return_url {refused}.",
                          {"field": "return_url", "reason": "not_allowed"})
        if not settings.STRIPE_CHECKOUT_ALLOWED_HOSTS:
            _log(logging.ERROR, "purchase_intent_host_policy_unavailable")
            return _error(500, "checkout_host_policy_unavailable", "Card checkout is temporarily unavailable.")

        request_hash = _request_fingerprint(rail, data["quantity_2z"], data["platform"], return_url)
        scope = _idempotency_scope(application)
        try:
            # No shared stale takeover: ``tuzis.claim`` would REBIND a stale
            # claim to the new request's fingerprint before we could check it
            # against the purchase the claim already names (codex round 5).
            # With it off, a different body is refused inside claim()'s own
            # row lock, and a same-body stale claim is taken over below.
            claim = idempotency.claim(
                scope, request.user, key, request_hash, allow_stale_takeover=False,
            )
        except idempotency.IdempotencyConflict:
            return _error(409, "idempotency_conflict",
                          "This Idempotency-Key was already used with a different body.",
                          {"in_flight": False})
        except idempotency.DuplicateRequest as duplicate:
            claim = _take_over_if_stale(duplicate.record) if duplicate.in_flight else None
            if claim is None:
                return self._replay(request, duplicate.record, application)

        recorded = _claimed_purchase(claim)
        if recorded:
            # A stale claim taken over: a previous request under this key
            # died after creating its intent. Recover THAT purchase rather
            # than open a second checkout for the same key.
            recovered = self._recover(request, claim, application, recorded, data, return_url)
            if recovered is not None:
                return recovered
        try:
            response, intent = self._open_card(request, application, data, return_url, claim)
        except EconomicRefusal as exc:
            idempotency.release(claim)
            return _error(409, str(exc), 'Funding is unavailable for this purchase.')
        except Exception:
            # Unexpected. Free the key only if nothing was created under it;
            # otherwise the claim already names the intent, and a retry after
            # STALE_CLAIM recovers it instead of opening a second checkout.
            if not _claimed_purchase(claim):
                idempotency.release(claim)
            raise
        if intent is None:
            # Refused before anything was created: the key stays usable.
            idempotency.release(claim)
            return response
        return self._finish(claim, response, intent)


    def is_finished_replay(self, request) -> bool:
        """For ``SdkPurchaseRateThrottle``: a key that already has a FINISHED
        receipt in this caller's scope does no provider work (it replays, or
        is a 409), so it spends no admission token."""
        key = request.headers.get(IDEMPOTENCY_KEY_HEADER)
        if key is None or not _IDEMPOTENCY_KEY.fullmatch(key):
            return False
        return idempotency.IdempotencyKey.objects.filter(
            scope=_idempotency_scope(_application(request)),
            user=request.user,
            key=key,
            response_status__isnull=False,
        ).exists()

    @staticmethod
    def _finish(claim, response, intent):
        receipt = {"purchase_id": str(intent.pk)}
        if response.status_code >= 400:
            # An error after the intent existed (the provider failed): the
            # replay answers the same error, not a second attempt.
            receipt["error"] = response.data["error"]
        try:
            claim.finish(response.status_code, receipt)
        except idempotency.DuplicateRequest:
            _log(logging.WARNING, "purchase_intent_claim_taken_over", purchase_id=str(intent.pk))
        return response

    def _recover(self, request, claim, application, purchase_id, data, return_url):
        """Answer a taken-over claim from the purchase it already names, or
        ``None`` to go on and create one.

        ``tuzis.claim``'s stale takeover accepts any body (its other callers
        commit their work and their receipt together, so a stale claim there
        provably did nothing). Here a stale claim may name a purchase whose
        checkout was already disclosed -- by a replay while it was in flight --
        and paid, so:

        * a DIFFERENT body is refused, whatever the claim's age, and the key's
          fingerprint is put back to the purchase's own;
        * a purchase that got as far as a checkout URL is the answer;
        * policy0 replaces a never-disclosed checkout using its legacy flow;
          policy1 recovers the original reserved checkout using its original
          provider key and persisted expiry, or replays a proven refusal.
        """
        from dj.apps.ztripe.models import CheckoutIntent

        intent = _owned_intents(request.user, application).filter(pk=purchase_id).first()
        if intent is None:
            return None
        if not _same_request(intent, data, return_url):
            # Unreachable while the fingerprint check above holds; refused
            # rather than trusted if it ever does not.
            return _error(409, "idempotency_conflict",
                          "This Idempotency-Key was already used with a different body.",
                          {"in_flight": False})
        if not intent.rail_data.get("checkout_url") and intent.status in (Status.CREATED, Status.FAILED):
            from dj.apps.economy.models import FundingReservation
            original = intent.checkout_intents.order_by('created_at').first()
            reservation = FundingReservation.objects.filter(
                idempotency_key=f'stripe-intent:{original.public_id}').first() if original else None
            if reservation is not None:
                from dj.apps.ztripe.economic_events import reconcile_creation_refusals
                reconcile_creation_refusals(creator_id=request.user.pk, checkout_id=original.public_id)
                reservation.refresh_from_db()
                if reservation.state == 'released':
                    return self._finish(claim, _error(502, 'stripe_unavailable',
                        'The original checkout was refused. Start a new purchase after reviewing its terms.'), intent)
                # Prepared authorization may exist at Stripe after a timeout.
                # Recover the exact creation/key/expiry, never replace it and
                # strand capacity or give a second PI the same authorization.
                identity, refusal = _checkout_identity()
                if refusal is not None:
                    return refusal
                CheckoutIntent.objects.filter(pk=original.pk, state=CheckoutIntent.State.PROVIDER_FAILED).update(
                    state=CheckoutIntent.State.CREATING, updated_at=timezone.now())
                original.refresh_from_db()
                response = self._open_session(intent, original, identity, recovering=True)
                return self._finish(claim, response, intent)

            # Never disclosed. `failed` is included because failing it and
            # creating its replacement are two commits: a worker that dies
            # between them leaves exactly this, and the next retry must
            # still get a checkout (codex review, round 3).
            # (The intent and its CheckoutIntent are created in one commit,
            # and the CheckoutIntent opens in the same commit that sets
            # `rail_data`, so here it is `creating` or already failed.)
            for checkout in intent.checkout_intents.filter(state=CheckoutIntent.State.CREATING):
                self._fail(intent, checkout)
            _log(logging.WARNING, "purchase_intent_replaced_after_crash", purchase_id=str(intent.pk))
            return None
        return self._finish(claim, _intent_response(_current(intent), 201), intent)

    def _replay(self, request, record, application):
        body = record.response_body if isinstance(record.response_body, dict) else {}
        if record.response_status is None:
            # Still running. If it already opened its checkout, the answer is
            # known; otherwise the client waits.
            intent = _claimed_intent(request, application, body)
            if intent is not None and intent.rail_data.get("checkout_url"):
                return _intent_response(_current(intent), 201)
            return _error(409, "idempotency_conflict",
                          "The original request with this Idempotency-Key is still in progress.",
                          {"in_flight": True})
        error = body.get("error")
        if isinstance(error, dict) and record.response_status >= 400:
            return _error(record.response_status, error.get("code", "idempotency_conflict"),
                          error.get("message", ""), error.get("details"))
        intent = _claimed_intent(request, application, body)
        if intent is None:
            return _error(409, "idempotency_conflict",
                          "The original response for this Idempotency-Key cannot be replayed.",
                          {"in_flight": False})
        # The intent as it is NOW (spec §1: "a replay returns the original
        # intent"), under the original status code.
        return _intent_response(_current(intent), record.response_status)

    def _open_card(self, request, application, data, return_url, claim):
        """Returns ``(response, intent)``; ``intent`` is None when nothing
        was created (a refusal before the provider was involved)."""
        from dj.apps.ztripe.models import CheckoutIntent

        quote = card_quote(data["quantity_2z"])
        identity, refusal = _checkout_identity()
        if refusal is not None:
            return refusal, None
        from dj.apps.economy.models import EconomicPolicy
        if EconomicPolicy.objects.get(pk=True).version == 1:
            from dj.apps.ztripe.economic_events import reconcile_expired_card_authorizations
            reconcile_expired_card_authorizations(creator_id=request.user.pk, identity=identity)

        now = timezone.now()
        with transaction.atomic():
            from dj.apps.economy.epoch import pin_supported_policy
            policy_version = pin_supported_policy()
            asserted = data.get('expected_actor_id')
            if (asserted is not None and (type(asserted) is not int or asserted != request.user.pk)) or (
                policy_version == 1 and application is None and asserted is None):
                raise EconomicRefusal('actor_identity_changed')
            if policy_version == 1:
                from dj.apps.economy.services import _funding_locks
                from dj.apps.g12f.models import Creator
                _funding_locks(request.user.pk, request.user.pk)
                locked_actor = Creator.objects.get(pk=request.user.pk)
                if not locked_actor.is_active or Creator.objects.values_list(
                    'kt_account_epoch', flat=True).get(pk=request.user.pk) != request.user.kt_account_epoch:
                    raise EconomicRefusal('actor_authentication_changed')
            intent = PurchaseIntent.objects.create(
                creator=request.user,
                application=application,
                rail=Rail.STRIPE,
                platform=data["platform"],
                quantity_2z=quote.tuzis,
                quote={
                    "tuzis": quote.tuzis,
                    "amount_cents": quote.amount_cents,
                    "currency": quote.currency,
                    "pricing_version": quote.pricing_version,
                    **({'stripe_session_expires_at': int(now.timestamp()) + 23 * 3600}
                        if policy_version == 1 else {}),
                },
                pricing_version=quote.pricing_version,
                price_minor=quote.amount_cents,
                currency=quote.currency.upper(),
                return_url=return_url,
                created_at=now,
                # Prepared manual capture discloses the exact same original
                # deadline used by Stripe and stale-worker recovery.
                expires_at=(now.replace(microsecond=0) + timedelta(hours=23)
                    if policy_version == 1 else now + CARD_INTENT_TTL),
            )
            checkout = CheckoutIntent.objects.create(
                user=request.user,
                tuzis=quote.tuzis,
                amount_cents=quote.amount_cents,
                currency=quote.currency,
                pricing_version=quote.pricing_version,
                stripe_account_id=identity.account_id,
                stripe_mode=identity.mode,
                stripe_livemode=identity.livemode,
                purchase_intent=intent,
            )
            if policy_version == 1:
                from dj.apps.economy.services import reserve_funding
                reserve_funding(recipient_id=request.user.pk, purchaser_id=request.user.pk,
                    amount_m2z=quote.tuzis * 1000, sale_nusd=quote.amount_cents * 10_000_000,
                    idempotency_key=f'stripe-intent:{checkout.public_id}')
            # Bind the key to the intent in the SAME commit, while the claim
            # is still unfinished: a crash from here on leaves a claim that
            # names its purchase, so a retry recovers it (``_recover``).
            bound = idempotency.IdempotencyKey.objects.filter(
                pk=claim.pk, owner=claim.owner, response_status__isnull=True,
            ).update(response_body={"purchase_id": str(intent.pk)})
            if bound != 1:
                raise idempotency.DuplicateRequest(
                    idempotency.IdempotencyKey.objects.get(pk=claim.pk)
                )
            claim.response_body = {"purchase_id": str(intent.pk)}
        # Committed before the provider call: a webhook that races the
        # response can always resolve the metadata.
        return self._open_session(intent, checkout, identity), intent

    def _open_session(self, intent, checkout, identity, *, recovering=False):
        """Open (or, with the same Stripe idempotency key, re-fetch) the
        hosted Session for ``checkout`` and move the intent to ``pending``."""
        from dj.apps.ztripe import views as ztripe_views
        from dj.apps.ztripe.fulfillment import checkout_metadata
        from dj.apps.ztripe.models import CheckoutIntent
        from dj.apps.ztripe.serializers import CheckoutSessionResponseSerializer
        from dj.apps.ztripe.stripe_identity import stripe_boolean

        from dj.apps.economy.models import FundingReservation
        manual_capture = FundingReservation.objects.filter(idempotency_key=f'stripe-intent:{checkout.public_id}').exists()
        metadata = checkout_metadata(checkout)
        stripe = ztripe_views.stripe
        purchase_id = str(intent.pk)
        return_url = intent.return_url
        try:
            session = stripe.checkout.Session.create(
                payment_method_types=["card"],
                line_items=[{
                    "price_data": {
                        "currency": checkout.currency,
                        "product_data": {"name": f"{checkout.tuzis} 2Z credits"},
                        "unit_amount": checkout.amount_cents,
                    },
                    "quantity": 1,
                }],
                mode="payment",
                adaptive_pricing={"enabled": False},
                client_reference_id=str(checkout.user_id),
                success_url=_with_query(return_url, purchase_id=purchase_id, status="success"),
                cancel_url=_with_query(return_url, purchase_id=purchase_id, status="cancel"),
                metadata=metadata,
                payment_intent_data={"metadata": metadata, **({"capture_method": "manual"} if manual_capture else {})},
                expires_at=(intent.quote.get('stripe_session_expires_at',
                    int(intent.created_at.timestamp()) + _STRIPE_SESSION_TTL_SECONDS)
                    if manual_capture else int(time.time()) + _STRIPE_SESSION_TTL_SECONDS),
                idempotency_key=f"free2z-checkout-intent-{checkout.public_id}",
                api_key=settings.STRIPE_SECRET_KEY,
                max_network_retries=0,
            )
        except stripe.error.StripeError as exc:
            self._fail(intent, checkout)
            from dj.apps.ztripe.economic_events import release_preexecution_creation_refusal
            release_preexecution_creation_refusal(checkout, exc, ambiguous=recovering)
            _log(logging.ERROR, "purchase_intent_session_create_failed",
                 purchase_id=purchase_id, error_type=type(exc).__name__)
            return _error(502, "stripe_unavailable", "Stripe checkout is temporarily unavailable.")

        value = ztripe_views._stripe_value
        response_account = value(session, "account")
        valid_identity = (
            value(session, "mode") == identity.mode
            and stripe_boolean(value(session, "livemode")) is identity.livemode
            and (response_account is None or response_account == identity.account_id)
        )
        contract = CheckoutSessionResponseSerializer(data={
            "id": getattr(session, "id", None),
            "url": getattr(session, "url", None),
            "quote": {
                "checkout_intent_id": checkout.public_id,
                "tuzis": checkout.tuzis,
                "amount_cents": checkout.amount_cents,
                "currency": checkout.currency,
                "pricing_version": checkout.pricing_version,
            },
        })
        if not valid_identity or not contract.is_valid():
            ztripe_views._expire_invalid_checkout_session(session)
            self._fail(intent, checkout)
            _log(logging.ERROR, "purchase_intent_session_invalid", purchase_id=purchase_id,
                 reason="identity" if not valid_identity else "contract")
            return _error(502, "stripe_invalid_session", "Stripe returned an invalid checkout session.")

        session_id = contract.validated_data["id"]
        checkout_url = contract.validated_data["url"]
        with transaction.atomic():
            opened = CheckoutIntent.objects.filter(
                pk=checkout.pk,
                state=CheckoutIntent.State.CREATING,
                stripe_checkout_session_id=None,
            ).update(
                stripe_checkout_session_id=session_id,
                state=CheckoutIntent.State.OPEN,
                updated_at=timezone.now(),
            )
            if opened != 1:
                checkout.refresh_from_db()
                # Already opened with THIS Session (a recovering retry raced
                # the original request) or already paid: both fine.
                if not (
                    checkout.state in (CheckoutIntent.State.OPEN, CheckoutIntent.State.FULFILLED)
                    and checkout.stripe_checkout_session_id == session_id
                ):
                    ztripe_views._expire_invalid_checkout_session(session)
                    _log(logging.ERROR, "purchase_intent_checkout_open_conflict", purchase_id=purchase_id)
                    return _error(502, "checkout_state_conflict", "Checkout state changed unexpectedly.")
            intent = PurchaseIntent.objects.select_for_update().get(pk=intent.pk)
            PurchaseIntent.objects.filter(pk=intent.pk).update(rail_data={"checkout_url": checkout_url})
            intent.rail_data = {"checkout_url": checkout_url}
            if intent.status == Status.CREATED:
                intent.transition(Status.PENDING)
        return _intent_response(intent, 201)

    @staticmethod
    def _fail(intent, checkout):
        from dj.apps.ztripe.models import CheckoutIntent

        with transaction.atomic():
            CheckoutIntent.objects.filter(pk=checkout.pk, state=CheckoutIntent.State.CREATING).update(
                state=CheckoutIntent.State.PROVIDER_FAILED, updated_at=timezone.now(),
            )
            locked = PurchaseIntent.objects.select_for_update().get(pk=intent.pk)
            if locked.status == Status.CREATED:
                locked.transition(Status.FAILED)
            intent.status = locked.status


def _checkout_identity():
    """ztripe's pre-provider identity proof, its refusal in the envelope."""
    from dj.apps.ztripe import views as ztripe_views

    identity, refusal = ztripe_views._prove_checkout_identity()
    if refusal is None:
        return identity, None
    refused = json.loads(refusal.content)
    return None, _error(
        refusal.status_code,
        refused.get("code", "checkout_not_configured"),
        refused.get("error", "Card checkout is unavailable."),
    )


def _take_over_if_stale(record):
    """Take over an UNFINISHED claim older than ``STALE_CLAIM`` whose request
    fingerprint already matched this request (claim() checked it under the
    row lock). Ownership rotates so the dead holder can never finish or
    release it; the fingerprint is never touched. ``None`` if the claim is
    still live, or finished meanwhile (the caller replays it)."""
    with transaction.atomic():
        locked = (
            idempotency.IdempotencyKey.objects.select_for_update()
            .filter(pk=record.pk).first()
        )
        if (
            locked is None
            or locked.response_status is not None
            or timezone.now() - locked.created_at <= idempotency.STALE_CLAIM
        ):
            return None
        locked.created_at = timezone.now()
        locked.owner = uuid.uuid4()
        locked.save(update_fields=["created_at", "owner"])
        return locked


def _claimed_purchase(claim):
    body = claim.response_body
    return body.get("purchase_id") if isinstance(body, dict) else None


def _claimed_intent(request, application, body):
    purchase_id = body.get("purchase_id") if isinstance(body, dict) else None
    if not purchase_id:
        return None
    return _owned_intents(request.user, application).filter(pk=purchase_id).first()


def _request_fingerprint(rail, quantity_2z, platform, return_url) -> str:
    return idempotency.fingerprint({
        "rail": rail,
        "quantity_2z": quantity_2z,
        "platform": platform,
        "return_url": return_url,
        "embed": False,
    })


def _same_request(intent, data, return_url) -> bool:
    return (
        intent.rail == Rail.STRIPE
        and intent.quantity_2z == data["quantity_2z"]
        and intent.platform == data["platform"]
        and intent.return_url == return_url
    )


def _owned_intents(user, application):
    """An OAuth app sees the intents IT created for this user; a first-party
    session or Knox token sees every intent of its own user."""
    queryset = PurchaseIntent.objects.filter(creator=user)
    if application is not None:
        queryset = queryset.filter(application=application)
    return queryset


def _current(intent):
    """Catch up prior fulfillment and project expiry without funding writes."""
    return project_expiry(heal_card_intent(intent))


def _intent_response(intent, status: int) -> Response:
    response = Response(intent_payload(intent), status=status)
    response["Cache-Control"] = "no-store"
    if intent.status in _POLLED_STATUSES:
        response["Retry-After"] = _RETRY_AFTER_SECONDS
    return response


class PurchaseIntentDetailView(SdkAPIView):
    """Read one purchase intent; clients poll this until it settles (§1.3)."""

    permission_classes = [IsAuthenticated]
    required_scopes = [SCOPE_PURCHASE_CREATE]

    @extend_schema(
        operation_id="purchases_intents_retrieve",
        summary="Read a purchase intent",
        responses={
            200: OpenApiResponse(
                PurchaseIntentSerializer,
                description="The intent. `Retry-After` is a polling hint while it is `created`, `pending` or `paid`.",
            ),
            404: ErrorEnvelopeSerializer,
        },
    )
    def get(self, request, purchase_id):
        intent = _owned_intents(request.user, _application(request)).filter(pk=purchase_id).first()
        if intent is None:
            return _error(404, "purchase_not_found", "No such purchase.")
        return _intent_response(_current(intent), 200)

