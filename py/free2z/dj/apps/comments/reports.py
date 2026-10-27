"""Private, authenticated moderation intake; no public report read API."""
import json
import logging
from datetime import timedelta
from uuid import UUID

from django.db import transaction
from django.http import Http404
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, permissions, serializers
from rest_framework.exceptions import Throttled
from rest_framework.response import Response
from drf_spectacular.utils import extend_schema, extend_schema_view

from dj.apps.g12f.models import Creator, zPage
from dj.free2z.throttling import AuthenticatedUserRateThrottle
from .models import Comment, ContentReport
from .visibility import comment_visible, zpage_visible


logger = logging.getLogger(__name__)

#``jsonPayload.event`` of the one-line staff notification written for every
#NEW report. ``monitoring/log-metrics/content-report-received.json``
#counts it and two alert policies page staff from it: CSAE immediately on
#the ``page`` tier, every other reason on the ``email`` tier. A duplicate
#(same reporter/target/reason) returns the original receipt and does NOT
#re-notify -- that is the same at-most-once rule the queue itself follows.
#``report_id`` is deliberately NOT a metric label: one series per report
#would let ordinary report volume exhaust the metric's series limit before
#a CSAE report arrives. Reports inside one alert window share an incident,
#so an alert means "the queue has new reports", not "this one report".
CONTENT_REPORT_RECEIVED_EVENT = "content_report_received"


def staff_alert_payload(report):
    """The staff-alert line for ``report``; it carries no user data.

    Only the report id, reason and target kind: no reporter, no target id,
    no free-text details. The log is readable by more people than the admin
    queue, and a CSAE report's target is exactly what must not be spread
    further. Staff open the report by id in the Django admin. A builder of
    its own so ``gcp/tests/test_alert_policy_contract.py`` can check the
    metric's extracted fields against the keys this really writes.
    """
    return {
        "severity": "WARNING",
        "message": (
            f"New content report {report.pk} ({report.reason}, "
            f"{report.target_kind}) is waiting in the staff queue."
        ),
        "event": CONTENT_REPORT_RECEIVED_EVENT,
        "report_id": str(report.pk),
        "reason": report.reason,
        "target_kind": report.target_kind,
    }


def _notify_staff(report):
    logger.warning(json.dumps(staff_alert_payload(report), separators=(",", ":")))


class ContentReportSerializer(serializers.ModelSerializer):
    class Meta:
        model = ContentReport
        fields = ['target_kind', 'target_id', 'reason', 'details']
        # Ownership and duplicate handling are server-controlled.
        validators = []

    def validate(self, attrs):
        user = self.context['request'].user
        kind, target_id = attrs['target_kind'], attrs['target_id']
        if kind == 'creator':
            target = get_object_or_404(Creator, username=target_id, is_active=True)
            attrs['target_id'] = str(target.pk)
        elif kind == 'zpage':
            target = get_object_or_404(zPage, free2zaddr=target_id)
            if not zpage_visible(target, user):
                raise Http404
        else:
            try:
                target_id = UUID(target_id)
            except ValueError:
                raise Http404
            target = get_object_or_404(Comment, pk=target_id)
            if not comment_visible(target, user):
                raise Http404
            attrs['target_id'] = str(target.pk)
        return attrs


class ContentReportReceiptSerializer(serializers.ModelSerializer):
    class Meta:
        model = ContentReport
        fields = ['id', 'created_at']
        read_only_fields = fields


class ReportIntakeThrottle(AuthenticatedUserRateThrottle):
    scope = 'report_intake'


@extend_schema_view(post=extend_schema(responses={201: ContentReportReceiptSerializer}))
class ContentReportCreate(generics.CreateAPIView):
    """Report visible content. Creator target_id is the public username;
    zPage target_id is free2zaddr; comment target_id is its UUID.

    Reports are private to moderation staff. A duplicate reporter/target/reason
    returns the original receipt without replacing its details. At most 20 new
    reports per account per rolling hour are accepted, serialized in Postgres.
    Receipts expose only report ID and creation time.
    CSAE reports sort first in the staff queue and alert staff immediately;
    other reasons alert staff by email. This is not an emergency service.
    """
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = ContentReportSerializer
    throttle_classes = [ReportIntakeThrottle]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        with transaction.atomic():
            # One writer per reporter across workers; cache throttles alone race.
            Creator.objects.select_for_update().get(pk=request.user.pk)
            identity = dict(reporter=request.user, **{
                key: data[key] for key in ('target_kind', 'target_id', 'reason')
            })
            report = ContentReport.objects.filter(**identity).first()
            if report is None:
                recent = ContentReport.objects.filter(
                    reporter=request.user,
                    created_at__gte=timezone.now() - timedelta(hours=1),
                )
                if recent.count() >= 20:
                    raise Throttled(wait=3600, detail='Report limit reached. Please try again later.')
                report = ContentReport.objects.create(**identity, details=data.get('details', ''))
                # Written now, not on_commit: a worker killed between COMMIT
                # and the callback would leave a stored CSAE report that never
                # alerts, and a retry returns the existing receipt without a
                # second chance. The opposite failure -- an alert for an
                # intake that then rolls back -- costs staff one look at the
                # queue. A missed child-safety alert is the worse of the two.
                _notify_staff(report)
        return Response(ContentReportReceiptSerializer(report).data, status=201)
