"""``GET /api/sdk/v1/balance`` -- zuu ``docs/free2z/sdk/spec/purchase.md`` §1.1.

The caller's own balance, and only ever the caller's: there is no user in
the URL, the query string or anywhere else in the request -- the account is
``request.user``, the one the credential names. Authentication is a session,
a Knox token, or an OAuth access token carrying ``balance:read``
(``required_scopes`` is what opens the view to OAuth at all;
``OAuth2JWTAuthentication`` is default-deny).

The numbers come from:func:`dj.apps.ledger.api.read_balance`: one read-only
statement that reports what the next spend would act on, without opening,
locking or healing the ledger account. A GET that called ``ensure_account``
would INSERT the account (and an ``opening`` transfer) as a side effect of
reading -- exactly what the URL-write guard's Rule B forbids, and invisible
to that guard because the write hides inside a SQL function. The spec asks
for no such side effect, so none happens: an account nobody has opened yet
is reported as ``tuzis * 1000`` with nothing held and no debt, which is the
balance ``ensure_account`` would open it at.

**Held across the L2 rollout.** Legacy ``tuzis.ProviderReservation`` rows:
pre-L2 reservation code moved credits OUT of the account (into
``sys:reservation_clearing``) rather than raising ``ledger_account.held``,
which new L2 reservations use. Reported naively that would make a user's
balance dip for the length of every AI call and jump back if it failed. So
the open reservations are reported as what they are -- held credits: added
to ``held_milli_2z`` and to the holds-inclusive ``balance_milli_2z``, never
to ``available_milli_2z`` (the ledger's own ``balance - held`` already
excludes them). Both kinds are summed without a contract change. An existing legacy
operation stays in its original representation; it is never copied to L2.

The ledger read and the reservation sum run in one ``REPEATABLE READ, READ
ONLY`` transaction when this view owns it (a GET is not wrapped by
``AtomicMiddleware``): one snapshot, so a reservation made between the two
reads is neither lost nor counted twice, and Postgres itself refuses a write.
"""
from __future__ import annotations

from django.db import connection, transaction
from django.db.models import Sum
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from dj.apps.ledger import api as ledger
from dj.apps.oidc.scopes import SCOPE_BALANCE_READ
from dj.apps.tuzis.ledger import RESERVATION_ACTIVE
from dj.apps.tuzis.models import ProviderReservation
from dj.free2z.sdk_api import SdkAPIView, envelope

from .serializers import BalanceSerializer, ErrorEnvelopeSerializer


class BalanceView(SdkAPIView):
    """Read the caller's 2Z balance."""

    permission_classes = [IsAuthenticated]
    required_scopes = [SCOPE_BALANCE_READ]

    @extend_schema(
        operation_id="sdk_balance_retrieve",
        summary="Read the caller's 2Z balance",
        responses={
            200: OpenApiResponse(
                BalanceSerializer,
                description="The balance in milli-2Z. Apps show `available_milli_2z`, and a debt as its own line.",
            ),
            401: ErrorEnvelopeSerializer,
            403: ErrorEnvelopeSerializer,
        },
    )
    def get(self, request):
        # Outermost only: SET TRANSACTION must be a transaction's first
        # statement, and inside a caller's transaction (a test, a future
        # middleware) the snapshot is theirs to choose.
        owns = not connection.in_atomic_block
        with transaction.atomic():
            if owns:
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            view = ledger.read_balance(request.user.pk)
            reserved = _open_reservations_m2z(request.user.pk)
        if view is None:
            # Authenticated as a creator whose row is gone: nothing to read.
            return envelope(404, "not_found", "No such account.")
        data = BalanceSerializer({
            "available_milli_2z": view.available,
            "held_milli_2z": view.held + reserved,
            "balance_milli_2z": view.balance + reserved,
            "debt_milli_2z": view.debt,
            "as_of": view.as_of,
        }).data
        response = Response(data)
        # A balance is per-user and changes with every spend: never cached.
        response["Cache-Control"] = "no-store"
        return response


def _open_reservations_m2z(creator_id: int) -> int:
    """The creator's open AI-call reservations, in m2Z (see the module doc)."""
    total = ProviderReservation.objects.filter(
        user_id=creator_id, status=RESERVATION_ACTIVE,
    ).aggregate(total=Sum("amount"))["total"]
    return ledger.to_m2z(total) if total else 0
