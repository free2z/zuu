"""In-app reports of AI output: the SDK intake, the developer's read, the alert.

Google Play's AI-Generated Content policy requires an app that generates
content with AI to let users report or flag it **without leaving the app**,
and the report has to reach someone who can act on it; Apple 4.7 expects the
same. An SDK app is usually one developer with no backend, so Free2Z runs the
queue for every app:

* ``POST /api/sdk/v1/calls/{call_id}/report`` -- the SDK's ``reportCall``.
  The app's own OAuth token (``ai:invoke``, the scope the call was made
  with) names the app and the user; the call must be one THIS user made
  through THIS app. Anything else is the same ``404`` as an unknown id, so a
  report cannot probe whether someone else's call exists.
* ``GET /api/oauth/apps/{app_id}/reports/`` -- the app's developer reads
  their own app's reports in the developer console. Never the reporter.
* the Django admin -- Free2Z moderation's queue; ``unsafe`` sorts first and
  alerts staff (``AI_OUTPUT_REPORT_EVENT``).

Nothing here stores AI content: the gateway keeps none, and a report records
the call id, the resolved model id, an enum reason and an optional one-line
``detail`` of at most 200 characters. Nothing sensitive travels in the URL --
the call id is an opaque UUID and the reason and detail are body fields
(GCLB logs keep query strings, tuzi#1328).
"""
from __future__ import annotations

import datetime
import json
import logging
import unicodedata
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection, transaction
from django.db.models import Count, F
from django.utils import timezone
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import exceptions, serializers, status
from rest_framework.parsers import JSONParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.purchases.serializers import ErrorEnvelopeSerializer
from dj.free2z.sdk_api import SdkAPIView, envelope
from dj.free2z.throttling import AuthenticatedUserRateThrottle

from .authentication import OAuth2JWTAuthentication, OAuthAccessToken
from .models import AiOutputReport, F2ZApplication
from .scopes import SCOPE_AI_INVOKE

logger = logging.getLogger(__name__)

#``jsonPayload.event`` of the one-line staff notification written when a
#report is filed, or when a repeat first escalates it to ``unsafe``.
#``monitoring/log-metrics/ai-output-report-received.json`` counts it with a
#``reason`` label only; ``monitoring/alert-policies/ai-output-report-unsafe.json``
#is a TICKET-tier log-match policy on its unsafe lines. The reason is
#user-chosen, so one report never pages. ``report_id`` is never a metric
#label: one series per report would let ordinary report volume exhaust the
#metric's series limit (the same rule as ``content_report_received``, ).
AI_OUTPUT_REPORT_EVENT = "ai_output_report_received"

#``jsonPayload.event`` of the PAGE line::data:`SURGE_DISTINCT_REPORTERS`
#or more distinct accounts reported ``unsafe`` output from paid calls to one
#app within:data:`SURGE_WINDOW`. ``monitoring/alert-policies/
#ai-output-report-surge.json`` pages on it. Written at most once per app per
#window (deduplicated here, at intake, not only by the policy's rate limit).
AI_OUTPUT_REPORT_SURGE_EVENT = "ai_output_report_surge"

#Reports one account may file, or first escalate to ``unsafe``, per rolling
#hour across every app.
#Counted in Postgres under the reporter's row lock, so concurrent workers
#cannot both pass it (the cache throttle alone races).
HOURLY_REPORT_LIMIT = 30

#Of those, how many may be ``unsafe`` (filed so, or escalated).
UNSAFE_HOURLY_LIMIT = 5

#The page threshold: distinct reporting accounts, each with an unsafe
#report on a call of that app it PAID for (``_PAID_CALL``). Account
#creation is free and a call row is not proof of spend, so a page needs
#several funded accounts that each bought output from the app.
SURGE_DISTINCT_REPORTERS = 3
SURGE_WINDOW = timedelta(hours=1)

#The gateway's call-record retention (``ledger.cleanup_gateway_calls``).
#An older call is unknown to the gateway's own ``GET /v1/calls/{id}``, and
#is the same ``404`` here.
CALL_RETENTION = timedelta(days=90)

#How many of the newest reports the developer read returns.
DEVELOPER_PAGE = 100


def staff_alert_payload(report, client_id: str) -> dict:
    """The staff-alert line for ``report``; it carries no user data.

    The report id, its reason and the app's public ``client_id`` only: no
    reporter, no call id, no detail text. Staff open the report by id in the
    Django admin. A builder of its own so
    ``gcp/tests/test_alert_policy_contract.py`` can check the metric's
    extracted fields against the keys this really writes.
    """
    return {
        "severity": "ERROR" if report.reason == AiOutputReport.Reason.UNSAFE else "WARNING",
        "message": (
            f"AI output report {report.pk} ({report.reason}) from app {client_id} "
            "is waiting in the staff queue."
        ),
        "event": AI_OUTPUT_REPORT_EVENT,
        "report_id": str(report.pk),
        "reason": report.reason,
        "client_id": client_id,
    }


def _notify_staff(report, client_id: str) -> None:
    # Written inside the intake transaction, not on_commit, for the reason
    # dj.apps.comments.reports gives: a worker lost between COMMIT and the
    # callback would store an unsafe report that never alerts, and a retry
    # finds the stored row and does not alert again. An alert for an intake
    # that then rolls back costs staff one look at an empty queue.
    logger.warning(json.dumps(staff_alert_payload(report, client_id), separators=(",", ":")))


#Bidi embeddings, overrides and isolates: they make the developer console
#or the admin show text in an order other than the one stored.
_BIDI_CONTROLS = frozenset("‪‫‬‭‮⁦⁧⁨⁩")


def _single_line(value: str) -> str:
    for char in value:
        # Cc: C0/C1 controls incl. newline and tab; Zl/Zp: line and paragraph
        # separators. Other format characters (ZWJ in emoji, ZWNJ in Persian)
        # are ordinary text and stay allowed.
        if unicodedata.category(char) in {"Cc", "Zl", "Zp"} or char in _BIDI_CONTROLS:
            raise serializers.ValidationError("detail must be one line of plain text")
    return value


class CallReportRequestSerializer(serializers.Serializer):
    reason = serializers.ChoiceField(
        choices=AiOutputReport.Reason.choices,
        help_text="Why the output is being reported.",
    )
    detail = serializers.CharField(
        required=False, allow_blank=True, max_length=AiOutputReport.DETAIL_MAX_LENGTH,
        validators=[_single_line],
        help_text="Optional, one line, at most 200 characters. Apps that children may "
                  "use should send a preset value rather than offer a free-text box. "
                  "Never AI output.",
    )


class CallReportSerializer(serializers.Serializer):
    report_id = serializers.UUIDField(source="pk")
    call_id = serializers.UUIDField()
    reason = serializers.ChoiceField(choices=AiOutputReport.Reason.choices)
    created_at = serializers.DateTimeField(
        format="%Y-%m-%dT%H:%M:%SZ", default_timezone=datetime.timezone.utc,
    )


class SdkReportThrottle(AuthenticatedUserRateThrottle):
    """A cache brake per (app, user), scope ``sdk-report``: a runaway app
    cannot 429 the same user in another app. The binding limit on stored
    rows is:data:`HOURLY_REPORT_LIMIT`, enforced in Postgres."""

    scope = "sdk-report"

    def get_cache_key(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return None
        auth = getattr(request, "auth", None)
        app = auth.application.pk if isinstance(auth, OAuthAccessToken) else "session"
        return self.cache_format % {"scope": self.scope, "ident": f"{app}:{request.user.pk}"}


#The call produced output its user paid for: the ledger settled an attempt
#of it and collected 2Z. Evaluated when it is needed, never stored, so the
#ledger stays the only authority. A call row alone is not this -- the
#gateway claims a call before it holds 2Z, so an account with no balance
#still leaves refused, unpaid call rows -- and neither is a released hold or
#an uncharged settlement. (``ledger_ai_usage`` outcomes are immutable today
#and there is no per-call refund; if one is added, it belongs here.)
#``c`` is ``ledger_gateway_call``.
_PAID_CALL = """
    EXISTS (
        SELECT 1 FROM ledger_gateway_attempt t
        JOIN ledger_ai_usage x ON x.hold_id = t.hold_id
        WHERE t.call_id = c.id AND x.account_id = c.account_id AND x.app_id = c.app_id
          AND x.outcome = 'settled' AND x.charged > 0
          -- the same bound ledger.call_envelope uses. It narrows each index
          -- probe but does NOT prune partitions: the bound is correlated with
          -- the outer row, so every ledger_ai_usage partition is probed (one
          -- index lookup each).
          AND x.created_at >= c.created_at - interval '1 hour'
    )
"""


def _owned_call(call_id, app_id, user_id) -> tuple[str, bool] | None:
    """``(model, paid)`` for ``call_id`` if this user made it through this
    app within retention; ``None`` otherwise. Reads non-content metadata only.

    ``model``: the settled attempt's model (the one billed for the output),
    else the completion's (a failed attempt can fall back to another model),
    else the claim's resolved model."""
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT coalesce(
                       (SELECT nullif(x.model_id, '')
                        FROM ledger_gateway_attempt t
                        JOIN ledger_ai_usage x ON x.hold_id = t.hold_id
                        WHERE t.call_id = c.id AND x.account_id = c.account_id
                          AND x.app_id = c.app_id AND x.outcome = 'settled'
                          AND x.created_at >= c.created_at - interval '1 hour'
                        ORDER BY x.created_at DESC, x.id DESC LIMIT 1),
                       nullif(c.completion_meta->>'model', ''),
                       c.request_meta->>'model', ''),
                   {_PAID_CALL}
            FROM ledger_gateway_call c
            JOIN ledger_account a ON a.id = c.account_id
            WHERE c.id = %s AND c.app_id = %s
              AND a.owner_id = %s AND a.kind = 'user'
              AND c.created_at >= now() - %s
            """,
            [call_id, app_id, user_id, CALL_RETENTION],
        )
        row = cursor.fetchone()
    return None if row is None else (row[0][:128], bool(row[1]))


def _paid_unsafe_reporters(app_id) -> int:
    """Distinct accounts with an ``unsafe`` report in:data:`SURGE_WINDOW`
    on a call of this app that they paid for -- judged against the ledger
    now, not when the report was filed."""
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT count(DISTINCT r.reporter_id)
            FROM oidc_aioutputreport r
            JOIN ledger_gateway_call c ON c.id = r.call_id AND c.app_id = r.application_id
            JOIN ledger_account a ON a.id = c.account_id
                AND a.owner_id = r.reporter_id AND a.kind = 'user'
            WHERE r.application_id = %s AND r.reason = 'unsafe'
              AND r.unsafe_at >= now() - %s
              AND {_PAID_CALL}
            """,
            [app_id, SURGE_WINDOW],
        )
        return cursor.fetchone()[0]


def surge_alert_payload(client_id: str, reporters: int) -> dict:
    """The page line; no user data -- the app and a count only."""
    return {
        "severity": "CRITICAL",
        "message": (
            f"{reporters} accounts reported unsafe AI output from paid calls to app "
            f"{client_id} within an hour."
        ),
        "event": AI_OUTPUT_REPORT_SURGE_EVENT,
        "client_id": client_id,
        "reporters": reporters,
    }


def _surge_key(app) -> str:
    return f"oidc:ai-report-surge:{app.pk}"


def _already_paged(app) -> bool:
    """Whether this app's surge line was written within the window. Only an
    explicit hit counts: production's cache swallows Redis errors
    (``IGNORE_EXCEPTIONS``) and answers ``None``, which must read as "not
    paged" -- a duplicate page is the cheap failure, a missing one is not."""
    try:
        return cache.get(_surge_key(app)) is not None
    except Exception:
        logger.exception("ai report surge: dedupe store unavailable; evaluating anyway")
        return False


def _maybe_page(app) -> None:
    """Write the surge line when this app is over the threshold, at most once
    per app per window. Call after an ``unsafe`` report is written, inside its
    transaction.

    * **Cheap when already paged:** an app paged this window returns before
      taking any lock or counting.
    * **Serialized per app.** A transaction-scoped advisory lock keyed on the
      app is taken before counting, so two reports committing at once cannot
      each count only the other's absence: the second waits for the first to
      commit and its count (a fresh READ COMMITTED snapshot) includes it. The
      same lock makes the check-then-mark below race-free.
    * **Every unsafe report re-evaluates**, paid or not, because ``paid`` is
      judged against the ledger at count time.
    * **Emit, then mark.** The line is written before the dedupe key is set,
      so a worker that dies in between leaves no key and the next unsafe
      submission pages; the opposite order could silence a page that was
      never written. The worst case is a duplicate page."""
    if _already_paged(app):
        return
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [_surge_key(app)])
    if _already_paged(app):
        return
    reporters = _paid_unsafe_reporters(app.pk)
    if reporters < SURGE_DISTINCT_REPORTERS:
        return
    logger.critical(json.dumps(surge_alert_payload(app.client_id, reporters),
                               separators=(",", ":")))
    try:
        cache.set(_surge_key(app), 1, timeout=int(SURGE_WINDOW.total_seconds()))
    except Exception:
        logger.exception("ai report surge: could not record the page; it may repeat")


def _refuse_over_cap(user, *, unsafe: bool) -> None:
    """429 once this account has, in the last hour, made
    :data:`HOURLY_REPORT_LIMIT` alert-writing submissions: new reports, plus
    first escalations of an existing report to ``unsafe``. Each is counted
    once -- a report FILED as unsafe has ``unsafe_at == created_at`` and is
    one event, not two -- so the cap bounds the alert lines one account can
    write an hour. An ``unsafe`` submission must also fit under
    :data:`UNSAFE_HOURLY_LIMIT`. Call under the reporter's row lock."""
    since = timezone.now() - timedelta(hours=1)
    mine = AiOutputReport.objects.filter(reporter=user)
    filed = mine.filter(created_at__gte=since).count()
    escalated = mine.filter(unsafe_at__gte=since, unsafe_at__gt=F("created_at")).count()
    if filed + escalated >= HOURLY_REPORT_LIMIT or (
            unsafe and mine.filter(unsafe_at__gte=since).count() >= UNSAFE_HOURLY_LIMIT):
        raise exceptions.Throttled(wait=3600, detail="Report limit reached. Try again later.")


def _child_directed(app) -> bool:
    """The registration's ``child_directed`` declaration (tuzi#2633). Read
    defensively so this intake ships independently of that column: until it
    exists every app reads as not child-directed, which is today's behaviour."""
    return bool(getattr(app, "child_directed", False))


def _invalid(serializer) -> Response:
    field = next(iter(serializer.errors), "body")
    errors = serializer.errors.get(field)
    message = str(errors[0]) if isinstance(errors, list) and errors else "Invalid report."
    return envelope(status.HTTP_400_BAD_REQUEST, "invalid_request", message, {"field": field})


class SdkCallReportView(SdkAPIView):
    """Report one AI call's output for review."""

    authentication_classes = [OAuth2JWTAuthentication]
    permission_classes = [IsAuthenticated]
    required_scopes = [SCOPE_AI_INVOKE]
    parser_classes = [JSONParser]
    throttle_classes = [SdkReportThrottle]

    @extend_schema(
        operation_id="sdk_call_report_create",
        summary="Report an AI call's output",
        description=(
            "Files the signed-in user's report of one AI call's output, for the app's "
            "developer and Free2Z moderation. The call must be one this user made "
            "through this app in the last 90 days; any other id is `404 not_found`. "
            "One report per call and user: a repeat answers `200` with the same "
            "report, its reason and detail replaced by the latest. No AI content is "
            "stored. `unsafe` alerts Free2Z staff. At most 30 reports filed, or escalated to "
            "`unsafe`, per account per rolling hour, of which at most 5 unsafe "
            "(`429 rate_limited`). A child-directed app may not send `detail` "
            "(`400 invalid_request`, field `detail`)."
        ),
        request=CallReportRequestSerializer,
        responses={
            200: OpenApiResponse(CallReportSerializer, description="Already reported; updated."),
            201: OpenApiResponse(CallReportSerializer, description="Reported."),
            400: ErrorEnvelopeSerializer, 401: ErrorEnvelopeSerializer,
            403: ErrorEnvelopeSerializer, 404: ErrorEnvelopeSerializer,
            429: ErrorEnvelopeSerializer,
        },
    )
    def post(self, request, call_id):
        serializer = CallReportRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return _invalid(serializer)
        reason = serializer.validated_data["reason"]
        detail = serializer.validated_data.get("detail", "")
        user = request.user
        app = request.auth.application
        if detail and _child_directed(app):
            # Enums only: an app directed to children keeps no text its user
            # typed, the same rule the gateway applies to a call's metadata.
            return envelope(status.HTTP_400_BAD_REQUEST, "invalid_request",
                            "detail is not accepted for a child-directed app; send the reason only.",
                            {"field": "detail"})
        with transaction.atomic():
            # One writer per reporter across workers: the hourly count and
            # the (reporter, call) row cannot race.
            get_user_model()._default_manager.select_for_update().filter(pk=user.pk).first()
            owned = _owned_call(call_id, app.pk, user.pk)
            if owned is None:
                raise exceptions.NotFound("No such call.")
            model, _paid = owned   # paid is judged again when counting
            # Row-locked: the admin's status save takes the same lock
            # (AiOutputReportAdmin.save_model), so an escalation and a staff
            # "resolved" cannot interleave.
            report = AiOutputReport.objects.select_for_update().filter(
                reporter=user, call_id=call_id,
            ).first()
            if report is not None:
                fields = []
                escalated = reason == AiOutputReport.Reason.UNSAFE and report.unsafe_at is None
                if escalated:
                    # The first time a report becomes unsafe is an alert, so
                    # it spends the hourly cap like a new report. Every other
                    # change is neither: a report alerts as unsafe at most
                    # once, however its reason is toggled.
                    _refuse_over_cap(user, unsafe=True)
                    report.unsafe_at = timezone.now()
                    fields.append("unsafe_at")
                if (report.reason, report.detail) != (reason, detail):
                    if report.reason != reason and report.status != AiOutputReport.Status.OPEN:
                        # A new reason is a new complaint: back into the
                        # open queue staff work from.
                        report.status = AiOutputReport.Status.OPEN
                        fields.append("status")
                    report.reason, report.detail = reason, detail
                    fields += ["reason", "detail"]
                if model and model != report.model:
                    # The call completed (on a fallback model, perhaps) after
                    # the first report: name the model that produced it.
                    report.model = model
                    fields.append("model")
                if fields:
                    report.save(update_fields=fields + ["updated_at"])
                if escalated:
                    _notify_staff(report, app.client_id)
                if reason == AiOutputReport.Reason.UNSAFE:
                    # Any unsafe submission re-evaluates, a retry included:
                    # a call that settled after its report was filed counts
                    # now (paid is judged at count time).
                    _maybe_page(app)
                return Response(CallReportSerializer(report).data, status=status.HTTP_200_OK,
                                headers={"Cache-Control": "no-store"})
            _refuse_over_cap(user, unsafe=reason == AiOutputReport.Reason.UNSAFE)
            report = AiOutputReport.objects.create(
                application=app, reporter=user, call_id=call_id, model=model,
                reason=reason, detail=detail,
            )
            if reason == AiOutputReport.Reason.UNSAFE:
                # Exactly created_at: filed unsafe is one capped event, not a
                # filing plus an escalation (_refuse_over_cap).
                report.unsafe_at = report.created_at
                report.save(update_fields=["unsafe_at"])
            _notify_staff(report, app.client_id)
            if report.reason == AiOutputReport.Reason.UNSAFE:
                _maybe_page(app)
        return Response(CallReportSerializer(report).data, status=status.HTTP_201_CREATED,
                        headers={"Cache-Control": "no-store"})


class DeveloperReportSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    call_id = serializers.UUIDField()
    reason = serializers.ChoiceField(choices=AiOutputReport.Reason.choices)
    detail = serializers.CharField()
    model = serializers.CharField(help_text="The model that produced the reported output.")
    status = serializers.ChoiceField(
        choices=AiOutputReport.Status.choices,
        help_text="Free2Z moderation's progress on the report.",
    )
    created_at = serializers.DateTimeField()
    updated_at = serializers.DateTimeField()


class DeveloperReportCountsSerializer(serializers.Serializer):
    incorrect = serializers.IntegerField()
    inappropriate = serializers.IntegerField()
    unsafe = serializers.IntegerField()
    other = serializers.IntegerField()


class DeveloperReportListSerializer(serializers.Serializer):
    total = serializers.IntegerField(help_text="Every report on this app, not just those listed.")
    by_reason = DeveloperReportCountsSerializer()
    results = DeveloperReportSerializer(many=True, help_text="The newest 100, newest first.")


class DeveloperAppReportsView(APIView):
    """The AI output reports users filed on one of the developer's apps.

    Session (or Knox) only: an OAuth token is refused by the default-deny
    ``OAuth2JWTAuthentication`` because this view declares no scope, so an
    app can never read its users' reports. The reporter is never returned.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="oidc_developer_app_reports_list",
        summary="AI output reports users filed on one of the developer's apps",
        responses={200: DeveloperReportListSerializer,
                   404: OpenApiResponse(description="No such app.")},
    )
    def get(self, request, app_id):
        app = F2ZApplication.objects.filter(pk=app_id, user=request.user).first()
        if app is None:
            raise exceptions.NotFound("no such app")
        reports = AiOutputReport.objects.filter(application=app)
        counts = {reason: 0 for reason in AiOutputReport.Reason.values}
        for row in reports.values("reason").annotate(n=Count("id")):
            counts[row["reason"]] = row["n"]
        return Response(DeveloperReportListSerializer({
            "total": sum(counts.values()),
            "by_reason": counts,
            "results": reports.order_by("-created_at", "-id")[:DEVELOPER_PAGE],
        }).data, headers={"Cache-Control": "no-store"})


class SurgeSweepFailed(RuntimeError):
    """At least one app's surge re-evaluation failed (each is logged)."""


#Per-app budgets inside the sweep (transaction-local).
SWEEP_APP_LOCK_TIMEOUT = "5s"
SWEEP_APP_STATEMENT_TIMEOUT = "15s"


def reevaluate_surges() -> int:
    """Evaluate the page for every app with an ``unsafe`` report in the
    window; return how many apps were evaluated. A failing app is logged and
    skipped so the others are still evaluated, and then:class:`SurgeSweepFailed`
    is raised so the job fails visibly.

    ``paid`` is judged at count time, so a report filed while its call was
    still settling counts once the ledger settles it -- but only when
    something evaluates again. The intake re-evaluates on every unsafe
    submission; this is the sweep for the case where none arrives
    (tuzi#2654). Each app is evaluated in its own transaction (the advisory
    lock is transaction-scoped), and an app already paged this window is
    skipped before any lock."""
    since = timezone.now() - SURGE_WINDOW
    app_ids = (AiOutputReport.objects
               .filter(reason=AiOutputReport.Reason.UNSAFE, unsafe_at__gte=since)
               .values_list("application_id", flat=True).distinct())
    evaluated = 0
    failed: list[str] = []
    for app in F2ZApplication.objects.filter(pk__in=list(app_ids)):
        try:
            with transaction.atomic():
                # Bounded: a blocked app (a held lock, a slow ledger probe)
                # fails fast into the handler below instead of holding the
                # shared worker and starving the apps after it.
                with connection.cursor() as cursor:
                    cursor.execute(f"SET LOCAL lock_timeout = '{SWEEP_APP_LOCK_TIMEOUT}'")
                    cursor.execute(f"SET LOCAL statement_timeout = '{SWEEP_APP_STATEMENT_TIMEOUT}'")
                _maybe_page(app)
        except Exception:
            # One app's failure must not cost every other app its page: log
            # it with its traceback and carry on; the raise below fails the
            # job once every app has had its turn.
            logger.exception("ai report surge: re-evaluation failed for app %s", app.client_id)
            failed.append(app.client_id)
            continue
        evaluated += 1
    if failed:
        # Fail the job, so procrastinate's failed-job alerting sees a sweep
        # that is not doing its work. The task is NEVER reclaimed and
        # retry=False, so this cannot retry-storm; the next tick retries.
        raise SurgeSweepFailed(
            f"surge re-evaluation failed for {len(failed)} of {len(failed) + evaluated} "
            f"app(s): {', '.join(sorted(failed))}")
    return evaluated
