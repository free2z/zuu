"""Recipient-approved transfers of developer registrations.

The transfer row is also the audit record. Account ids are snapshots so the
record remains after either account is deleted. Every write locks both
accounts in id order, then the application, then the offer. The ledger hold
admission trigger shares an advisory lock with acceptance: an offer cannot be
accepted until all holds admitted under the old owner have settled or expired.
"""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core import signing
from django.utils.dateparse import parse_datetime
from django.db import OperationalError, connection, transaction
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import ledger_projection
from .developer import MAX_APPS_PER_DEVELOPER
from .models import AppOwnershipTransfer, F2ZApplication

OFFER_LIFETIME = timedelta(days=7)


class TransferOfferInput(serializers.Serializer):
    recipient = serializers.CharField(max_length=150, trim_whitespace=True)
    expected_actor_id = serializers.IntegerField(min_value=1)


class TransferResolveInput(serializers.Serializer):
    expected_actor_id = serializers.IntegerField(min_value=1)


class TransferOfferSerializer(serializers.ModelSerializer):
    sender = serializers.SerializerMethodField()
    recipient = serializers.SerializerMethodField()
    state = serializers.SerializerMethodField()
    role = serializers.SerializerMethodField()

    class Meta:
        model = AppOwnershipTransfer
        fields = ("id", "application_id", "application_name", "sender", "recipient",
                  "created_at", "expires_at", "resolved_at", "state", "role")

    def get_sender(self, obj) -> str:
        return self._names.get(obj.sender_id, "")

    def get_recipient(self, obj) -> str:
        return self._names.get(obj.recipient_id, "")

    @property
    def _names(self):
        return self.context.get("names", {})

    def get_role(self, obj) -> str:
        return "recipient" if self.context.get("actor") == obj.recipient_id else "sender"

    def get_state(self, obj) -> str:
        if obj.state == "pending" and obj.expires_at <= timezone.now():
            return "expired"
        return obj.state


def _locked_accounts(*ids):
    return {u.pk: u for u in get_user_model()._base_manager.select_for_update().filter(
        pk__in=sorted(set(ids)),
    ).order_by("pk")}


class AppBusy(Exception):
    pass


def _lock_app(**filters):
    # Old pods can hold the app while inserting a missing ledger projection
    # whose developer FK needs an account we already locked. Never wait here:
    # fail the offer operation cleanly instead of forming that lock cycle.
    try:
        with transaction.atomic():
            return F2ZApplication.objects.select_for_update(nowait=True).filter(**filters).first()
    except OperationalError as exc:
        if getattr(exc.__cause__, "sqlstate", None) != "55P03":
            raise
        raise AppBusy from exc


def _error(code, detail, http=409):
    return Response({"code": code, "detail": detail}, status=http)


def _usable(account, epoch):
    return account is not None and account.is_active and account.kt_account_epoch == epoch


class TransferPageSerializer(serializers.Serializer):
    results = TransferOfferSerializer(many=True)
    next_cursor = serializers.CharField(allow_null=True)


class TransferListView(APIView):
    permission_classes = [IsAuthenticated]
    PAGE_SIZE = 50

    @extend_schema(operation_id="oidc_app_transfers_list", summary="List app ownership offers",
                   parameters=[OpenApiParameter("cursor", str, required=False,
                       description="Opaque continuation from the previous page.")],
                   responses={200: TransferPageSerializer,
                              400: OpenApiResponse(description="Invalid cursor.")})
    def get(self, request):
        from django.db.models import Q
        queryset = AppOwnershipTransfer.objects.filter(
            Q(sender_id=request.user.pk) | Q(recipient_id=request.user.pk),
        )
        cursor = request.query_params.get("cursor")
        if cursor:
            try:
                payload = signing.loads(cursor, salt="oidc.app-transfer-page")
                timestamp = parse_datetime(payload["at"])
                import uuid
                pk = uuid.UUID(payload["id"])
                if payload["actor"] != request.user.pk or timestamp is None or timezone.is_naive(timestamp):
                    raise ValueError("invalid cursor")
            except (signing.BadSignature, KeyError, TypeError, ValueError):
                return _error("invalid_cursor", "Invalid continuation.", 400)
            queryset = queryset.filter(Q(created_at__lt=timestamp) | Q(created_at=timestamp, pk__lt=pk))
        offers = list(queryset.order_by("-created_at", "-pk")[:self.PAGE_SIZE + 1])
        more = len(offers) > self.PAGE_SIZE
        offers = offers[:self.PAGE_SIZE]
        next_cursor = None
        if more:
            last = offers[-1]
            next_cursor = signing.dumps({"at": last.created_at.isoformat(), "id": str(last.pk),
                                         "actor": request.user.pk}, salt="oidc.app-transfer-page")
        ids = {pk for offer in offers for pk in (offer.sender_id, offer.recipient_id)}
        names = dict(get_user_model()._base_manager.filter(pk__in=ids).values_list("pk", "username"))
        return Response({"results": TransferOfferSerializer(offers, many=True,
            context={"names": names, "actor": request.user.pk}).data, "next_cursor": next_cursor})


class TransferCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(operation_id="oidc_app_transfer_create", summary="Offer an app to a recipient",
                   request=TransferOfferInput, responses={201: TransferOfferSerializer,
                   400: OpenApiResponse(description="Invalid recipient."),
                   404: OpenApiResponse(description="App or recipient not found."),
                   409: OpenApiResponse(description="Offer cannot be made.")})
    def post(self, request, app_id):
        data = TransferOfferInput(data=request.data)
        data.is_valid(raise_exception=True)
        if data.validated_data["expected_actor_id"] != request.user.pk:
            return _error("actor_changed", "The signed-in account changed.")
        recipient_id = get_user_model()._base_manager.filter(
            username__iexact=data.validated_data["recipient"], is_active=True,
        ).values_list("pk", flat=True).first()
        if recipient_id is None or recipient_id == request.user.pk:
            return _error("recipient_unavailable", "Recipient is unavailable.", 404)
        with transaction.atomic():
            users = _locked_accounts(request.user.pk, recipient_id)
            sender, recipient = users.get(request.user.pk), users.get(recipient_id)
            if (not _usable(sender, request.user.kt_account_epoch) or not recipient or not recipient.is_active
                    or recipient.username.casefold() != data.validated_data["recipient"].casefold()):
                return _error("account_unavailable", "An account is unavailable.")
            try:
                app = _lock_app(pk=app_id, user_id=sender.pk)
            except AppBusy:
                return _error("app_busy", "The app is busy. Try again.")
            if app is None:
                return _error("not_found", "App not found.", 404)
            if app.first_party:
                return _error("not_transferable", "This app cannot be transferred.")
            now = timezone.now()
            AppOwnershipTransfer.objects.filter(application_id=app.pk, state="pending", expires_at__lte=now).update(
                state="expired", resolved_at=now,
            )
            if AppOwnershipTransfer.objects.filter(application_id=app.pk, state="pending").exists():
                return _error("offer_pending", "Cancel the existing offer first.")
            offer = AppOwnershipTransfer.objects.create(
                application_id=app.pk, application_name=app.name, sender_id=sender.pk,
                recipient_id=recipient.pk, sender_epoch=sender.kt_account_epoch,
                recipient_epoch=recipient.kt_account_epoch, created_at=now, expires_at=now + OFFER_LIFETIME,
            )
        return Response(TransferOfferSerializer(offer, context={"names": dict(get_user_model()._base_manager.filter(pk__in=[offer.sender_id, offer.recipient_id]).values_list("pk", "username")), "actor": request.user.pk}).data, status=status.HTTP_201_CREATED)


class TransferResolveView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(operation_id="oidc_app_transfer_resolve", summary="Accept or cancel an app offer",
                   request=TransferResolveInput, responses={200: TransferOfferSerializer,
                   404: OpenApiResponse(description="Offer not found."),
                   409: OpenApiResponse(description="Offer is no longer valid or work is in flight.")})
    def post(self, request, transfer_id, action):
        data = TransferResolveInput(data=request.data)
        data.is_valid(raise_exception=True)
        if data.validated_data["expected_actor_id"] != request.user.pk:
            return _error("actor_changed", "The signed-in account changed.")
        if action not in ("accept", "cancel"):
            return _error("not_found", "Offer not found.", 404)
        offer = AppOwnershipTransfer.objects.filter(pk=transfer_id).first()
        if offer is None or request.user.pk not in (offer.sender_id, offer.recipient_id):
            return _error("not_found", "Offer not found.", 404)
        if action == "accept" and request.user.pk != offer.recipient_id:
            return _error("not_found", "Offer not found.", 404)
        with transaction.atomic():
            users = _locked_accounts(offer.sender_id, offer.recipient_id)
            try:
                app = _lock_app(pk=offer.application_id)
            except AppBusy:
                return _error("app_busy", "The app is busy. Try again.")
            offer = AppOwnershipTransfer.objects.select_for_update().get(pk=offer.pk)
            now = timezone.now()
            if offer.state != "pending":
                return _error("offer_resolved", "Offer is no longer pending.")
            if offer.expires_at <= now:
                offer.state, offer.resolved_at = "expired", now
                offer.save(update_fields=["state", "resolved_at"])
                return _error("offer_expired", "Offer has expired.")
            actor = users.get(request.user.pk)
            if not _usable(actor, request.user.kt_account_epoch):
                return _error("account_unavailable", "Sign in again.")
            if action == "cancel":
                offer.state, offer.resolved_at = "cancelled", now
            else:
                sender, recipient = users.get(offer.sender_id), users.get(offer.recipient_id)
                if (not _usable(sender, offer.sender_epoch) or not _usable(recipient, offer.recipient_epoch)
                        or app is None or app.user_id != offer.sender_id or app.first_party):
                    return _error("offer_invalid", "Offer is no longer valid.")
                if F2ZApplication.objects.filter(user_id=recipient.pk).count() >= MAX_APPS_PER_DEVELOPER:
                    return _error("app_limit", "Recipient has reached the app limit.")
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 1303))", [str(app.pk)])
                    # The hold admission lock can wait past the offer deadline.
                    now = timezone.now()
                    if offer.expires_at <= now:
                        offer.state, offer.resolved_at = "expired", now
                        offer.save(update_fields=["state", "resolved_at"])
                        return _error("offer_expired", "Offer has expired.")
                    cursor.execute("SELECT EXISTS (SELECT 1 FROM ledger_hold WHERE app_id = %s)", [app.pk])
                    if cursor.fetchone()[0]:
                        return _error("usage_in_flight", "Wait for outstanding app usage to settle and try again.")
                app.user_id = recipient.pk
                app.save(update_fields=["user"])
                ledger_projection.sync_application(app)
                offer.state, offer.resolved_at = "accepted", now
            offer.save(update_fields=["state", "resolved_at"])
        return Response(TransferOfferSerializer(offer, context={"names": dict(get_user_model()._base_manager.filter(pk__in=[offer.sender_id, offer.recipient_id]).values_list("pk", "username")), "actor": request.user.pk}).data)
