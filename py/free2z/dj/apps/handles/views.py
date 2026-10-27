"""``/api/e2ee/handle/``, ``/api/e2ee/handle/claim/``, ``/api/e2ee/authority/``.

The signed assertion itself is ``POST /api/kt/handle-assertion/``
(``dj.apps.ktauth``), which reads the binding this app stores.

Nothing here reads a handle from the URL: the status is the caller's own, and
the one handle a caller can name travels in the claim's body.
"""

from django.contrib.auth import get_user_model
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.ktauth import signing
from dj.apps.ktauth.serializers import AuthorityUnavailableSerializer
from dj.free2z.throttling import HANDLE_CLAIM_THROTTLES

from . import claims, policy
from .reservation import handle_taken
from .serializers import (
    AuthorityInfoSerializer,
    HandleClaimErrorSerializer,
    HandleClaimRequestSerializer,
    HandleStatusSerializer,
)


def handle_status(user) -> dict:
    """The ``HandleStatusSerializer`` body for ``user``. Reads only."""
    from .models import MessagingHandle

    row = (
        MessagingHandle.objects.filter(user_id=user.pk)
        .values("handle", "status", "source")
        .first()
    )
    candidate, reason = policy.eligibility(user.get_username())
    if candidate is not None:
        if policy.is_reserved(candidate):
            reason = policy.REASON_RESERVED
        elif (row is None or row["handle"] != candidate) and (
            handle_taken(candidate)
            or get_user_model()._default_manager.filter(
                username__iexact=candidate
            ).exclude(pk=user.pk).exists()
        ):
            reason = policy.REASON_TAKEN

    bound = row is not None and row["status"] == "bound"
    return {
        "handle": row["handle"] if bound else None,
        "status": "bound" if bound else "unclaimed",
        "source": row["source"] if bound else None,
        "candidate": candidate,
        "eligible": candidate is not None and reason is None,
        "reason": reason,
        # A retired row (not reachable for a live account today) still blocks.
        "can_claim": row is None,
    }


class HandleStatusView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="e2ee_handle_retrieve",
        summary="The caller's E2EE messaging handle",
        description=(
            "Whether this account owns a messaging handle, the handle its "
            "username would give it, and whether it may claim one. Handles "
            "are permanent once bound."
        ),
        responses={200: HandleStatusSerializer},
    )
    def get(self, request):
        return Response(handle_status(request.user))


class HandleClaimView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = HANDLE_CLAIM_THROTTLES

    @extend_schema(
        operation_id="e2ee_handle_claim",
        summary="Claim an E2EE messaging handle, permanently",
        description=(
            "For an account with no handle: ineligible usernames, and the "
            "later accounts in a case-variant username group. The handle must "
            "be exactly ^[a-z0-9_]{1,30}$, not reserved, and not held by or "
            "folding to another account. It cannot be changed or released "
            "afterwards."
        ),
        request=HandleClaimRequestSerializer,
        responses={
            201: HandleStatusSerializer,
            400: HandleClaimErrorSerializer,
            409: HandleClaimErrorSerializer,
        },
    )
    def post(self, request):
        payload = HandleClaimRequestSerializer(data=request.data)
        if not payload.is_valid():
            return _claim_error(claims.ClaimRefused(claims.CLAIM_INVALID))
        try:
            claims.claim(request.user, payload.validated_data["handle"])
        except claims.ClaimRefused as exc:
            return _claim_error(exc)
        return Response(
            handle_status(request.user), status=status.HTTP_201_CREATED
        )


def _claim_error(exc):
    return Response({"detail": exc.detail, "code": exc.code}, status=exc.status)


class AuthorityInfoView(APIView):
    """The authority's public key, served from the key this process loaded.

    A deployment check, not a trust root: a client must pin the key it was
    built with (``DirectoryConfig``), never fetch it from the party it is
    checking. What this answers is "which key is the API actually signing
    with", so an operator can compare it to what the log and ZUULI pin.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    renderer_classes = [JSONRenderer]

    @extend_schema(
        operation_id="e2ee_authority_retrieve",
        summary="The handle authority's public key",
        description=(
            "Ed25519 public key, authority_id and log_id of the key this "
            "deployment signs HandleAssertions with. For operators comparing "
            "deployments; clients pin the key instead of fetching it."
        ),
        responses={
            200: AuthorityInfoSerializer,
            503: AuthorityUnavailableSerializer,
        },
    )
    def get(self, request):
        try:
            # peek, not load: an anonymous request never reaches Secret Manager.
            authority = signing.peek()
            log_id = signing.log_id()
        except signing.AuthorityUnavailable as exc:
            return Response(
                {
                    "detail": "The handle authority is not available.",
                    "reason": exc.reason,
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(
            {
                "public_key": authority.public_key.hex(),
                "authority_id": authority.authority_id.hex(),
                "log_id": log_id.hex(),
                "validity_ms": signing.ttl_ms(),
            }
        )
