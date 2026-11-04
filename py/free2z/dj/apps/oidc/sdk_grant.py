"""A bearer token's own current AI grant; never an authorization to spend.

The policy and its projection are read from one read-only snapshot. Generation
is a revocation counter, NOT a cap version: a numerical limit edit can preserve
it. Clients must fetch again when showing consent, and the gateway must enforce
its own current policy on every call.
"""
from __future__ import annotations

import datetime

from django.conf import settings
from django.db import connection, models, transaction
from drf_spectacular.utils import extend_schema
from rest_framework import exceptions, serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from dj.apps.purchases.serializers import ErrorEnvelopeSerializer
from dj.free2z.sdk_api import SdkAPIView, envelope

from .authentication import OAuth2JWTAuthentication
from .models import AppAuthorization, CapPeriod
from .scopes import SCOPE_AI_INVOKE


class EnforcementReason(models.TextChoices):
    """Coarse, non-sensitive cause for ``enforced``; never a config detail.

    Evaluated in this order, first failing prerequisite wins:

    - ``platform_disabled``: the deployment has not asserted verified gateway
      activation (``SDK_AI_GRANTS_ENFORCED`` is off). Platform-wide; nothing
      the user or app can do.
    - ``ledger_cutover_pending``: the ledger is not ready to enforce any grant
      yet (L2 tables absent or the rollout self-heal still enabled).
      Platform-wide.
    - ``ledger_cap_pending``: the ledger holds no current, exact projection of
      THIS grant (not yet synced, mismatched, revoked, or the ledger has the
      account/app frozen). Specific to this app/user grant.
    - ``ok``: ``enforced`` is true.
    """

    OK = "ok"
    PLATFORM_DISABLED = "platform_disabled"
    LEDGER_CUTOVER_PENDING = "ledger_cutover_pending"
    LEDGER_CAP_PENDING = "ledger_cap_pending"


class SdkGrantSerializer(serializers.Serializer):
    sub = serializers.UUIDField()
    client_id = serializers.CharField()
    account_epoch = serializers.IntegerField(min_value=0)
    grant_generation = serializers.IntegerField(min_value=1)
    scopes = serializers.ListField(child=serializers.CharField())
    spend_cap_2z = serializers.IntegerField(
        min_value=0, allow_null=True,
        help_text="Original consented limit in whole 2Z, not remaining spend; null means uncapped.",
    )
    cap_period = serializers.ChoiceField(choices=CapPeriod.choices)
    enforced = serializers.BooleanField(help_text=(
        "True only after verified gateway activation and an exact current ledger policy projection. "
        "A fresh snapshot, not a cap version or authorization to spend."
    ))
    enforcement_reason = serializers.ChoiceField(
        choices=EnforcementReason.choices,
        help_text=(
            "Coarse reason for `enforced`: `ok` exactly when `enforced` is true; otherwise the first "
            "unmet prerequisite. `platform_disabled` and `ledger_cutover_pending` are platform-wide "
            "rollout states; `ledger_cap_pending` means the ledger has no current exact projection of "
            "this grant. Additive: clients must treat any unknown value as not enforced, and "
            "`enforced` stays authoritative."
        ),
    )
    as_of = serializers.DateTimeField(
        format="%Y-%m-%dT%H:%M:%SZ", default_timezone=datetime.timezone.utc,
    )


def _enforcement_reason(grant) -> str:
    # The deployment owner enables this ONLY after verifying the real gateway
    # uses L2. Tables alone, and even matching rows, cannot prove live routing.
    if not settings.SDK_AI_GRANTS_ENFORCED:
        return EnforcementReason.PLATFORM_DISABLED
    with connection.cursor() as cursor:
        tables = set(connection.introspection.table_names(cursor))
        if not {"ledger_app", "ledger_spend_cap", "ledger_account", "ledger_config"} <= tables:
            return EnforcementReason.LEDGER_CUTOVER_PENDING
        cursor.execute("SELECT EXISTS (SELECT 1 FROM ledger_config WHERE NOT heal_enabled)")
        if not cursor.fetchone()[0]:
            return EnforcementReason.LEDGER_CUTOVER_PENDING
        app = grant.application
        cap = None if grant.spend_cap_2z is None else grant.spend_cap_2z * 1000
        cursor.execute("""
            SELECT EXISTS (
                SELECT 1 FROM ledger_spend_cap cap
                JOIN ledger_account account ON account.id = cap.account_id
                JOIN ledger_app app ON app.id = cap.app_id
                WHERE cap.app_id = %s AND account.owner_id = %s
                  AND account.kind = 'user' AND NOT account.journal_only
                  AND NOT account.frozen AND NOT app.frozen
                  AND app.developer_creator_id IS NOT DISTINCT FROM %s
                  AND app.markup_bps = %s
                  AND app.approved_markup_bps IS NOT DISTINCT FROM %s
                  AND cap.cap_m2z IS NOT DISTINCT FROM %s
                  AND cap.period = %s AND cap.markup_bps = %s
                  AND cap.grant_generation = %s AND cap.revoked_at IS NULL
                  -- Repeated deliberately: `ok` must be proven by ONE statement,
                  -- never by two that only agree under REPEATABLE READ.
                  AND EXISTS (SELECT 1 FROM ledger_config WHERE NOT heal_enabled)
            )
        """, [str(app.pk), grant.user_id, app.user_id, app.markup_bps,
              app.approved_markup_bps, cap, grant.cap_period, grant.markup_bps,
              grant.generation])
        if not cursor.fetchone()[0]:
            return EnforcementReason.LEDGER_CAP_PENDING
    return EnforcementReason.OK


class SdkGrantView(SdkAPIView):
    """Read only the authenticated app/user grant; never a reusable spend authorization."""

    authentication_classes = [OAuth2JWTAuthentication]
    permission_classes = [IsAuthenticated]
    required_scopes = [SCOPE_AI_INVOKE]

    @extend_schema(
        operation_id="sdk_grant_retrieve",
        summary="Read the bearer token's current AI grant",
        responses={200: SdkGrantSerializer, 401: ErrorEnvelopeSerializer,
                   403: ErrorEnvelopeSerializer, 503: ErrorEnvelopeSerializer},
    )
    def get(self, request):
        owns = not connection.in_atomic_block
        with transaction.atomic():
            if owns:
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            # Authentication precedes get(), outside this snapshot. Repeat the
            # full validation here: deletion, epoch and generation can change
            # in between. Never use request.user's cached epoch as proof.
            user, token = OAuth2JWTAuthentication().authenticate(request)
            grant = AppAuthorization.objects.select_related("application").get(
                user_id=user.pk, application_id=token.application.pk,
            )
            if not set(token.scopes) <= set(grant.scope_list):
                raise exceptions.AuthenticationFailed("Invalid token.", code="token_revoked")
            if grant.cap_period not in CapPeriod.values:
                return envelope(503, "temporarily_unavailable", "The grant policy is unavailable.")
            with connection.cursor() as cursor:
                cursor.execute("SELECT transaction_timestamp()")
                as_of = cursor.fetchone()[0]
            reason = _enforcement_reason(grant)
            data = SdkGrantSerializer({
                "sub": user.public_id, "client_id": token.client_id,
                "account_epoch": user.kt_account_epoch, "grant_generation": grant.generation,
                "scopes": token.scopes, "spend_cap_2z": grant.spend_cap_2z,
                "cap_period": grant.cap_period, "enforced": reason == EnforcementReason.OK,
                "enforcement_reason": reason, "as_of": as_of,
            }).data
        return Response(data, headers={"Cache-Control": "no-store"})
