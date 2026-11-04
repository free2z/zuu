import logging

from django.utils.cache import patch_cache_control
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.negotiation import BaseContentNegotiation
from rest_framework.permissions import AllowAny
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from .policy import (
    ClientQueryError,
    PolicyConfigurationError,
    build_contract,
    cache_max_age_seconds,
    parse_client_query,
)
from .serializers import ZuuliCapabilitiesSerializer, ZuuliErrorSerializer


logger = logging.getLogger(__name__)


def _no_store(response):
    response["Cache-Control"] = "no-store"
    return response


class ZuuliJSONOnlyNegotiation(BaseContentNegotiation):
    """Always select the sole JSON renderer, independent of browser headers."""

    def select_renderer(self, request, renderers, format_suffix=None):
        renderer = renderers[0]
        return renderer, renderer.media_type


class ZuuliCapabilitiesView(APIView):
    """Public release compatibility and backend capability discovery."""

    authentication_classes = []
    permission_classes = [AllowAny]
    # Cloud CDN caches this public response. A single renderer prevents an HTML
    # browsable-API representation from sharing a cache key with mobile JSON.
    renderer_classes = [JSONRenderer]
    content_negotiation_class = ZuuliJSONOnlyNegotiation

    @extend_schema(
        parameters=[
            OpenApiParameter(
                name="platform",
                type=str,
                required=False,
                enum=("ios", "android", "macos", "linux"),
                description="Client platform; must be paired with version.",
            ),
            OpenApiParameter(
                name="version",
                type=str,
                required=False,
                pattern=(
                    r"^(0|[1-9][0-9]{0,8})\."
                    r"(0|[1-9][0-9]{0,8})\."
                    r"(0|[1-9][0-9]{0,8})$"
                ),
                description=(
                    "Canonical MAJOR.MINOR.PATCH app version; must be paired "
                    "with platform."
                ),
            ),
        ],
        responses={
            200: ZuuliCapabilitiesSerializer,
            400: ZuuliErrorSerializer,
            503: ZuuliErrorSerializer,
        },
        operation_id="zuuli_capabilities",
    )
    def get(self, request):
        try:
            platform, version = parse_client_query(request.query_params)
            payload = build_contract(platform, version)
            serializer = ZuuliCapabilitiesSerializer(data=payload)
            if not serializer.is_valid():
                raise PolicyConfigurationError(
                    f"release policy does not match its public schema: "
                    f"{serializer.errors}"
                )
            payload = serializer.validated_data
            max_age = (
                cache_max_age_seconds() if platform is None else None
            )
        except ClientQueryError as exc:
            return _no_store(
                Response(
                    {"detail": str(exc)},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            )
        except PolicyConfigurationError:
            logger.exception("invalid ZUULI release policy")
            return _no_store(
                Response(
                    {"detail": "Release policy temporarily unavailable."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            )

        response = Response(payload)
        if platform is not None:
            # Version values have unbounded cardinality. Never let caller-
            # specific decisions occupy CDN cache keys or survive a rollback.
            return _no_store(response)

        # Cloud CDN can serve ordinary max-age responses stale during an origin
        # outage. s-maxage + proxy-revalidate retain edge caching while forcing
        # release/maintenance decisions to be revalidated after this TTL.
        patch_cache_control(
            response,
            public=True,
            max_age=max_age,
            s_maxage=max_age,
            proxy_revalidate=True,
        )
        return response
