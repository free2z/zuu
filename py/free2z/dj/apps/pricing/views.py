import json
from decimal import Decimal, ROUND_CEILING

from django.http import HttpResponse, HttpResponseNotModified
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.free2z.throttling import POLLING_THROTTLES

from . import catalog, constants
from .serializers import PricingSerializer, QuoteSerializer, SignedCatalogSerializer
from .service import PricingUnavailable, get_current_snapshot, get_pricing


class PricingView(APIView):
    """Current live 2Z pricing for ZEC and card payments.

    Public: both UIs poll this to show a live conversion rate. A 2Z is worth
    $0.01; ZEC purchases are priced off an aggregated, spread-adjusted ZEC/USD.
    """

    permission_classes = [AllowAny]

    @extend_schema(parameters=[OpenApiParameter(name="promo", type=str, required=False, description="Optional promotion code preview; does not lock payment pricing.")], responses=PricingSerializer, operation_id="pricing_current")
    def get(self, request, *args, **kwargs):
        try:
            payload = get_pricing(request.query_params.get("promo"))
        except PricingUnavailable:
            return Response(
                {"detail": "Pricing temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(payload)


class PricingQuoteView(APIView):
    """Estimated Zcash amount and exact card price for a quantity of 2Z."""

    permission_classes = [AllowAny]

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="tuzis", type=int, required=True,
                description="Number of 2Z to price.",
            ),
            OpenApiParameter(name='promo', type=str, required=False, description='Optional current promotion preview; never locks pricing.'),
        ],
        responses=QuoteSerializer,
        operation_id="pricing_quote",
    )
    def get(self, request, *args, **kwargs):
        raw = request.query_params.get("tuzis")
        try:
            tuzis = int(raw)
        except (TypeError, ValueError):
            return Response(
                {"detail": "Query param `tuzis` (integer) is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if raw != str(tuzis) or not 1 <= tuzis <= 1_000_000:
            return Response(
                {"detail": "`tuzis` must be an integer from 1 to 1000000."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        card = constants.card_quote(tuzis)

        try:
            snapshot = get_current_snapshot(allow_bootstrap=True)
        except PricingUnavailable:
            return Response(
                {"detail": "Pricing temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        from .promotions import select_promotion, rates
        _, offer, _ = select_promotion(request.query_params.get('promo'))
        _, _, estimated_rate = rates(snapshot.zec_usd, Decimal(offer['multiplier']))
        zec_amount = (Decimal(tuzis) / estimated_rate).quantize(Decimal('.00000001'), rounding=ROUND_CEILING)
        from django.utils import timezone
        # An unsaved snapshot is a cold-start bootstrap estimate; never present
        # its ZEC amount as fresh (a buyer could grossly over/underpay).
        bootstrap = snapshot.pk is None
        age = (timezone.now() - snapshot.created_at).total_seconds()
        stale = bootstrap or not 0 <= age <= constants.SNAPSHOT_MAX_AGE_SECONDS
        return Response({
            "tuzis": tuzis,
            "zec_amount": str(zec_amount),
            "card_cents": card.amount_cents,
            "card_currency": card.currency,
            "card_pricing_version": card.pricing_version,
            "tuzis_per_zec": str(estimated_rate),
            "zec_usd": str(snapshot.zec_usd),
            "updated_at": snapshot.created_at.isoformat(),
            "stale": stale,
            "bootstrap": bootstrap,
        })


def _etag_matches(if_none_match: str, etag: str) -> bool:
    """RFC 9110 section 13.1.2: If-None-Match uses the WEAK comparison."""
    from django.utils.http import parse_etags

    tags = parse_etags(if_none_match)
    if "*" in tags:
        return True
    strip = lambda tag: tag[2:] if tag.startswith("W/") else tag  # noqa: E731
    return strip(etag) in {strip(tag) for tag in tags}


class AICatalogView(APIView):
    """The signed AI model catalogue the f2z-ai gateway prices from.

    PUBLIC, deliberately. Everything in it is already public -- per-model
    provider prices and limits are on ``GET /api/ai/models/`` and the gateway's
    ``/v1/models``, and the platform margin is a published policy -- and the
    response is authenticated by its Ed25519 signature, not by who fetched it:
    the gateway trusts a key from its own configuration, never from here.
    Gating it behind internal auth would add a credential to the one path
    the gateway cannot price without, and protect nothing.

    Stateless: built from the active rate card and ``AIModel`` rows and
    signed on every request (see ``dj.apps.pricing.catalog``). ``ETag`` is a
    hash of the exact body; ``If-None-Match`` answers 304.

    No refusal is a 5xx: this is a public URL, and a 5xx here would feed the
    site-wide page-tier LB alerts.

    * key not provisioned -> 404 ``catalog_not_provisioned``, logged, NOT
      alerted (the expected state until the owner provisions it);
    * a whole-document refusal -- a malformed or test key, no active rate
      card, a revision stamped in the future -> 409 ``catalog_refused`` with
      the ``reason``, plus the alerted ``ai_catalog_refused`` line;
    * a bad MODEL (no rate row, bad limits, all-zero prices, a duplicate id,
      a per-image price on a provider that bills images as tokens) is left
      OUT of an otherwise published catalogue, with an alerted
      ``ai_catalog_model_excluded`` line -- it never blocks the document.

    A genuinely unexpected error still surfaces as a 500.
    """

    permission_classes = [AllowAny]
    # No session/CSRF processing: the response does not depend on who asks.
    authentication_classes: list = []
    # Machine-paced (the gateway polls every 30 s): the anon-poll bucket. See
    # ANON_SCOPE_INVENTORY in dj/apps/test_throttling.py.
    throttle_classes = POLLING_THROTTLES

    @extend_schema(
        operation_id="ai_catalog_v1",
        parameters=[
            OpenApiParameter(
                name="If-None-Match",
                type=str,
                location=OpenApiParameter.HEADER,
                required=False,
                description=(
                    "An ETag from a previous response. When it matches the "
                    "current catalogue the answer is 304 with no body. Selects "
                    "a representation only; this endpoint writes nothing."
                ),
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=SignedCatalogSerializer,
                description=(
                    "The signed catalogue. Verify with f2z-ai-proto "
                    "verify_catalog(<bytes of `catalog`>, signature, trusted "
                    "keys, now). Headers: ETag, Cache-Control: no-cache."
                ),
            ),
            304: OpenApiResponse(description="Not modified (If-None-Match matched)."),
            404: OpenApiResponse(
                description=(
                    "No signing key is provisioned on this deployment. Body: "
                    "{code: catalog_not_provisioned}."
                ),
            ),
            409: OpenApiResponse(
                description=(
                    "Refused to sign the whole document. Body: {code: "
                    "catalog_refused, reason}; reason is one of "
                    "signing_key_malformed, test_key_not_allowed, "
                    "no_active_rate_card, future_revision, invalid_catalog. "
                    "Per-model problems never refuse the document: the model "
                    "is omitted instead."
                ),
            ),
        },
    )
    def get(self, request, *args, **kwargs):
        now = catalog.now_unix()
        try:
            signed = catalog.signed_catalog(now)
        except catalog.CatalogRefused as exc:
            if exc.reason in catalog.NOT_PROVISIONED_REASONS:
                catalog.log_not_provisioned(exc)
                body, code = {"code": "catalog_not_provisioned"}, 404
            else:
                catalog.log_refused(exc)
                body, code = {"code": "catalog_refused", "reason": exc.reason}, 409
            response = HttpResponse(
                json.dumps(body), status=code, content_type="application/json")
            response["Cache-Control"] = "no-store"
            return response
        catalog.log_served_once(
            signed, now, catalog.served_client(request.headers.get("User-Agent")))
        if _etag_matches(request.headers.get("If-None-Match", ""), signed.etag):
            response = HttpResponseNotModified()
        else:
            response = HttpResponse(signed.body, content_type="application/json")
        response["ETag"] = signed.etag
        # Revalidate every time: a cached copy must never outlive the window
        # it was issued in.
        response["Cache-Control"] = "no-cache"
        return response
