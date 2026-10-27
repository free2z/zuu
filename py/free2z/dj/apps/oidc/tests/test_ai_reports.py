"""In-app AI output reports: SDK intake, developer read, staff alert.

Real OAuth tokens and real Postgres; a gateway call is a real
``ledger_gateway_call`` row, so ownership is decided by the same tables the
gateway writes. What these guard, and why nothing else does:

* a report can only name a call the token's user made through the token's
  app -- otherwise a report could probe for, or pollute the queue with,
  another user's or another app's calls (privacy);
* one report per (call, user), a repeat replaces its reason (idempotency the
  SDK relies on for retries);
* ``unsafe`` writes the staff-alert line, and the line carries no user data
  (the store-policy requirement that a report reaches someone who can act);
* the stored row holds no AI content, and the developer read never names the
  reporter (child-directed posture);
* the hourly cap is enforced in Postgres.
"""
import json
import logging
import uuid
from datetime import timedelta

import pytest
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from dj.apps.ledger.api import ensure_account
from dj.apps.oidc import ai_reports
from dj.apps.oidc.models import AiOutputReport, F2ZApplication

from .conftest import WEB_REDIRECT, Flow

pytestmark = pytest.mark.django_db

REQUEST_META = {"model": "review-model", "requested_model": "review-model",
                "provider": "review-provider", "catalog_version": 99999,
                "metadata": {"lesson": "fractions"}}


def url(call_id):
    return f"/api/sdk/v1/calls/{call_id}/report"


def bearer(signed_in, user, app, scope="openid ai:invoke"):
    flow = Flow(signed_in, user, app, redirect_uri=WEB_REDIRECT, scope=scope)
    tokens = flow.run(spend_cap_2z=None) if "ai:invoke" in scope else flow.run()
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION="Bearer " + tokens["access_token"])
    return api


def gateway_call(user, app, *, age=timedelta(0), meta=REQUEST_META, completion=None):
    """A ``ledger_gateway_call`` row as ``ledger.call_claim`` (and, with
    ``completion``, ``ledger.call_complete``) leaves it."""
    account = ensure_account(user.pk)
    call_id = uuid.uuid4()
    created = timezone.now() - age
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO ledger_gateway_call(id, account_id, app_id, account_epoch, grant_generation,"
            " fingerprint, phase, request_meta, completion_meta, created_at, expires_at)"
            " VALUES (%s, %s, %s, 0, 1, %s, 'released', %s, %s, %s, %s)",
            [call_id, account, app.pk, "a" * 64, json.dumps(meta),
             None if completion is None else json.dumps(completion), created,
             created + timedelta(minutes=5)],
        )
    return call_id


@pytest.fixture
def reporter(signed_in, user, web_app):
    return bearer(signed_in, user, web_app)


def alert_lines(caplog):
    return [json.loads(r.getMessage()) for r in caplog.records
            if r.name == ai_reports.__name__ and ai_reports.AI_OUTPUT_REPORT_EVENT in r.getMessage()]


def test_report_is_stored_without_content_and_unsafe_alerts_staff(reporter, user, web_app, caplog):
    call_id = gateway_call(user, web_app)
    caplog.set_level(logging.WARNING, logger=ai_reports.__name__)
    response = reporter.post(url(call_id), {"reason": "unsafe", "detail": "scary_content"}, format="json")
    assert response.status_code == 201, response.content
    body = response.json()
    report = AiOutputReport.objects.get()
    assert body == {"report_id": str(report.pk), "call_id": str(call_id), "reason": "unsafe",
                    "created_at": body["created_at"]}
    assert body["created_at"].endswith("Z") and response["Cache-Control"] == "no-store"
    assert (report.application_id, report.reporter_id, report.call_id, report.model,
            report.reason, report.detail, report.status) == (
        web_app.pk, user.pk, call_id, "review-model", "unsafe", "scary_content", "open")
    # Nothing from the call's metadata but the model id is copied.
    stored = json.dumps([str(v) for v in AiOutputReport.objects.values().get().values()])
    assert "fractions" not in stored and "review-provider" not in stored
    [line] = alert_lines(caplog)
    assert line == {"severity": "ERROR", "event": "ai_output_report_received",
                    "report_id": str(report.pk), "reason": "unsafe",
                    "client_id": web_app.client_id, "message": line["message"]}
    assert str(call_id) not in line["message"] and "scary_content" not in line["message"]


def test_repeat_is_one_report_and_a_changed_reason_replaces_it(reporter, user, web_app, caplog):
    call_id = gateway_call(user, web_app)
    caplog.set_level(logging.WARNING, logger=ai_reports.__name__)
    first = reporter.post(url(call_id), {"reason": "incorrect"}, format="json")
    again = reporter.post(url(call_id), {"reason": "incorrect"}, format="json")
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json() == first.json()
    assert len(alert_lines(caplog)) == 1          # a pure retry does not re-alert
    escalated = reporter.post(url(call_id), {"reason": "unsafe", "detail": "x"}, format="json")
    assert escalated.status_code == 200
    assert escalated.json()["report_id"] == first.json()["report_id"]
    assert AiOutputReport.objects.values_list("reason", "detail").get() == ("unsafe", "x")
    assert [line["reason"] for line in alert_lines(caplog)] == ["incorrect", "unsafe"]


def test_a_report_alerts_as_unsafe_once_however_its_reason_is_toggled(reporter, user, web_app, caplog):
    """The reason is user-chosen; toggling it must not mint a stream of alerts."""
    call_id = gateway_call(user, web_app)
    caplog.set_level(logging.WARNING, logger=ai_reports.__name__)
    for reason in ("unsafe", "other", "unsafe", "incorrect", "unsafe"):
        assert reporter.post(url(call_id), {"reason": reason}, format="json").status_code in (200, 201)
    assert [line["reason"] for line in alert_lines(caplog)] == ["unsafe"]


def test_one_report_per_call_and_user_is_a_database_constraint(reporter, user, web_app):
    from django.db import IntegrityError, transaction

    call_id = gateway_call(user, web_app)
    assert reporter.post(url(call_id), {"reason": "other"}, format="json").status_code == 201
    with pytest.raises(IntegrityError), transaction.atomic():
        AiOutputReport.objects.create(application=web_app, reporter=user, call_id=call_id,
                                      reason="unsafe")


def test_no_detail_or_call_metadata_reaches_any_log(reporter, user, web_app, caplog):
    """The alert line is not the only log line a request writes: nothing the
    user typed and nothing from the call's metadata may reach ANY logger."""
    call_id = gateway_call(user, web_app, completion={"model": "fallback-model"})
    caplog.set_level(logging.DEBUG)
    assert reporter.post(url(call_id), {"reason": "unsafe", "detail": "sentinel-detail-7c1"},
                         format="json").status_code == 201
    assert reporter.post(url(call_id), {"reason": "rude", "detail": "sentinel-detail-7c1"},
                         format="json").status_code == 400
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert logged and ai_reports.AI_OUTPUT_REPORT_EVENT in logged
    # The call id itself is an opaque UUID in the request path, which the
    # request logs carry like any path; it is not content.
    for secret in ("sentinel-detail-7c1", "fractions", "review-provider"):
        assert secret not in logged, secret


def test_escalating_a_resolved_report_reopens_it(reporter, user, web_app):
    call_id = gateway_call(user, web_app)
    assert reporter.post(url(call_id), {"reason": "incorrect"}, format="json").status_code == 201
    AiOutputReport.objects.update(status="resolved")
    assert reporter.post(url(call_id), {"reason": "incorrect", "detail": "again"},
                         format="json").status_code == 200
    assert AiOutputReport.objects.get().status == "resolved"   # same complaint, still resolved
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 200
    assert AiOutputReport.objects.get().status == "open"


def test_report_names_the_model_that_produced_the_output(reporter, user, web_app):
    """A failed attempt can fall back to another model: the completion's model
    is the one whose output was reported, not the claim's."""
    call_id = gateway_call(user, web_app, completion={"model": "fallback-model", "partial": False})
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 201
    assert AiOutputReport.objects.get().model == "fallback-model"


def test_a_repeat_after_completion_corrects_the_model(reporter, user, web_app):
    call_id = gateway_call(user, web_app)
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 201
    assert AiOutputReport.objects.get().model == "review-model"
    with connection.cursor() as cursor:
        cursor.execute("UPDATE ledger_gateway_call SET completion_meta=%s WHERE id=%s",
                       [json.dumps({"model": "fallback-model"}), call_id])
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 200
    assert AiOutputReport.objects.get().model == "fallback-model"


def test_a_stale_moderator_page_cannot_resolve_an_unreviewed_escalation(reporter, user, web_app):
    """Staff open an `incorrect` report; the user escalates it to `unsafe`;
    staff press save on the page they had: refused, and the report stays
    open and unsafe. A page loaded after the change saves normally."""
    from django.contrib.admin.sites import site
    from dj.apps.oidc.admin import AiOutputReportAdminForm

    call_id = gateway_call(user, web_app)
    assert reporter.post(url(call_id), {"reason": "incorrect"}, format="json").status_code == 201
    seen = AiOutputReportAdminForm(instance=AiOutputReport.objects.get())["seen_version"].initial
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 200

    stale = AiOutputReportAdminForm(
        data={"status": "resolved", "staff_notes": "ok", "seen_version": seen},
        instance=AiOutputReport.objects.get())
    assert not stale.is_valid()
    # The lock-time re-check refuses too (the race after the form's read).
    model_admin = site._registry[AiOutputReport]
    report = AiOutputReport.objects.get()
    report.status = "resolved"
    model_admin.save_model(None, report, stale, True)
    assert AiOutputReport.objects.values_list("reason", "status").get() == ("unsafe", "open")

    fresh_seen = AiOutputReportAdminForm(instance=AiOutputReport.objects.get())["seen_version"].initial
    fresh = AiOutputReportAdminForm(
        data={"status": "resolved", "staff_notes": "reviewed", "seen_version": fresh_seen},
        instance=AiOutputReport.objects.get())
    assert fresh.is_valid(), fresh.errors
    model_admin.save_model(None, fresh.save(commit=False), fresh, True)
    assert AiOutputReport.objects.values_list("reason", "status", "staff_notes").get() == (
        "unsafe", "resolved", "reviewed")


def test_cap_counts_filings_and_escalations_as_separate_events(reporter, user, web_app, monkeypatch):
    """Two filings + two escalations are four alert lines: the fourth event is
    refused at a cap of 4, while a report filed unsafe is one event."""
    monkeypatch.setattr(ai_reports, "HOURLY_REPORT_LIMIT", 4)
    a, b, c, d = (gateway_call(user, web_app) for _ in range(4))
    post = lambda call, reason: reporter.post(url(call), {"reason": reason}, format="json").status_code  # noqa: E731
    assert [post(a, "other"), post(b, "other"), post(a, "unsafe")] == [201, 201, 200]
    assert post(c, "unsafe") == 201          # filed unsafe: one event (4 of 4)
    assert post(b, "unsafe") == 429          # a fifth event
    assert post(d, "other") == 429


def test_only_the_users_own_call_through_this_app_is_reportable(
        signed_in, reporter, user, web_app, loopback_app, creator_factory):
    """Another user's call, another app's call, an expired call and an unknown
    id are one indistinguishable 404 -- and nothing is stored."""
    other_user = creator_factory(username="bob")
    candidates = [
        gateway_call(other_user, web_app),
        gateway_call(user, loopback_app),
        gateway_call(user, web_app, age=timedelta(days=91)),
        uuid.uuid4(),
    ]
    for call_id in candidates:
        response = reporter.post(url(call_id), {"reason": "unsafe"}, format="json")
        assert response.status_code == 404, call_id
        assert response.json() == {"error": {"code": "not_found", "message": "No such call."}}
    assert reporter.post(url("not-a-uuid"), {"reason": "unsafe"}, format="json").status_code == 404
    assert not AiOutputReport.objects.exists()


@pytest.mark.parametrize("body,field", [
    ({}, "reason"),
    ({"reason": "rude"}, "reason"),
    ({"reason": "other", "detail": "x" * 201}, "detail"),
    ({"reason": "other", "detail": "two\nlines"}, "detail"),
    ({"reason": "other", "detail": "abc‮dcba"}, "detail"),
])
def test_invalid_report_is_an_envelope_400(reporter, user, web_app, body, field):
    call_id = gateway_call(user, web_app)
    response = reporter.post(url(call_id), body, format="json")
    assert response.status_code == 400
    error = response.json()["error"]
    assert (error["code"], error["details"]) == ("invalid_request", {"field": field})
    assert not AiOutputReport.objects.exists()


def test_report_needs_an_ai_invoke_token(signed_in, user, web_app):
    call_id = gateway_call(user, web_app)
    balance_only = bearer(signed_in, user, web_app, scope="openid balance:read")
    response = balance_only.post(url(call_id), {"reason": "unsafe"}, format="json")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "insufficient_scope"
    session = APIClient()
    session.force_login(user)
    assert session.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 401
    assert not AiOutputReport.objects.exists()


def test_hourly_cap_is_enforced_in_postgres(reporter, user, web_app, monkeypatch):
    monkeypatch.setattr(ai_reports, "HOURLY_REPORT_LIMIT", 2)
    calls = [gateway_call(user, web_app) for _ in range(3)]
    assert [reporter.post(url(c), {"reason": "other"}, format="json").status_code
            for c in calls] == [201, 201, 429]
    refused = reporter.post(url(calls[2]), {"reason": "other"}, format="json")
    assert refused.json()["error"]["code"] == "rate_limited" and refused["Retry-After"]
    # Changing an existing report is not a new report and is not capped...
    assert reporter.post(url(calls[0]), {"reason": "inappropriate"}, format="json").status_code == 200
    #...but its first escalation to unsafe writes an alert line, so it is.
    assert reporter.post(url(calls[0]), {"reason": "unsafe"}, format="json").status_code == 429
    assert AiOutputReport.objects.get(call_id=calls[0]).reason == "inappropriate"
    AiOutputReport.objects.update(created_at=timezone.now() - timedelta(hours=2))
    assert reporter.post(url(calls[2]), {"reason": "other"}, format="json").status_code == 201


def test_developer_reads_own_apps_reports_without_the_reporter(
        reporter, user, developer, web_app, signed_in, creator_factory):
    for reason in ("unsafe", "incorrect", "incorrect"):
        call_id = gateway_call(user, web_app)
        assert reporter.post(url(call_id), {"reason": reason}, format="json").status_code == 201
    console = APIClient()
    console.force_login(developer)
    response = console.get(f"/api/oauth/apps/{web_app.pk}/reports/")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["total"] == 3
    assert body["by_reason"] == {"incorrect": 2, "inappropriate": 0, "unsafe": 1, "other": 0}
    assert len(body["results"]) == 3
    assert set(body["results"][0]) == {"id", "call_id", "reason", "detail", "model",
                                       "status", "created_at", "updated_at"}
    assert str(user.public_id) not in json.dumps(body) and user.username not in json.dumps(body)

    stranger = APIClient()
    stranger.force_login(creator_factory(username="mallory"))
    assert stranger.get(f"/api/oauth/apps/{web_app.pk}/reports/").status_code == 404
    # The app's own OAuth token can never read its users' reports.
    assert reporter.get(f"/api/oauth/apps/{web_app.pk}/reports/").status_code == 403


# ---- follow-up: unsafe cap, paid-only page, child-directed detail, delete --

from dj.apps.ledger.tests import test_gateway_calls as ledger_calls  # noqa: E402
from dj.apps.ledger.tests import test_hold_foundation  # noqa: E402

ledger_third_party = test_hold_foundation.third_party   # the rate card fixture
holder = test_hold_foundation.holder


def ledger_call(creator, app, *, outcome):
    """A call through the REAL ledger functions: ``claimed`` (what an account
    with no balance still leaves behind), ``released`` (the hold handed back,
    nothing collected) or ``settled`` (output its user paid for)."""
    account = ensure_account(creator.pk)
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_app(id) VALUES (%s) ON CONFLICT DO NOTHING", [app.pk])
        cursor.execute("INSERT INTO ledger_spend_cap(app_id, account_id, cap_m2z, period, grant_generation)"
                       " VALUES (%s, %s, 20000, 'total', 4) ON CONFLICT DO NOTHING", [app.pk, account])
    call_id = ledger_calls.claim(creator, app.pk, key=None)["call_id"]   # a distinct call each time
    if outcome == "claimed":
        return call_id
    held = ledger_calls.hold(creator, app.pk, call_id)
    ledger_calls.complete(creator, app.pk, call_id)
    if outcome == "released":
        ledger_calls.call("release", held["hold_id"])
    else:
        ledger_calls.call("settle", held["hold_id"], 10_000_000, json.dumps(ledger_calls.COMPLETE))
    return call_id


def unsafe_report(creator, app, call_id):
    return AiOutputReport.objects.create(application=app, reporter=creator, call_id=call_id,
                                         reason="unsafe", unsafe_at=timezone.now())


def surge_lines(caplog):
    return [json.loads(r.getMessage()) for r in caplog.records
            if ai_reports.AI_OUTPUT_REPORT_SURGE_EVENT in r.getMessage()]


def test_paid_is_a_settled_charged_attempt_and_names_the_billed_model(
        ledger_third_party, web_app, creator_factory):
    payer = creator_factory(tuzis=100)
    claimed = ledger_call(payer, web_app, outcome="claimed")
    released = ledger_call(payer, web_app, outcome="released")
    settled = ledger_call(payer, web_app, outcome="settled")
    assert ai_reports._owned_call(claimed, web_app.pk, payer.pk) == ("review-model", False)
    assert ai_reports._owned_call(released, web_app.pk, payer.pk)[1] is False
    assert ai_reports._owned_call(settled, web_app.pk, payer.pk) == ("review-model", True)
    assert ai_reports._owned_call(settled, web_app.pk, payer.pk + 999) is None


def test_page_needs_three_distinct_paying_reporters_and_fires_once_per_app_hour(
        ledger_third_party, web_app, creator_factory, caplog):
    caplog.set_level(logging.INFO)
    payers = [creator_factory(tuzis=100) for _ in range(4)]
    # Unpaid reporters never count: a free account's refused call, and a
    # call whose hold was released (nothing collected).
    for outcome in ("claimed", "released"):
        freeloader = creator_factory(tuzis=100)
        unsafe_report(freeloader, web_app, ledger_call(freeloader, web_app, outcome=outcome))
    # One payer reporting many paid calls is still one account.
    for _ in range(3):
        unsafe_report(payers[0], web_app, ledger_call(payers[0], web_app, outcome="settled"))
    unsafe_report(payers[1], web_app, ledger_call(payers[1], web_app, outcome="settled"))
    assert ai_reports._paid_unsafe_reporters(web_app.pk) == 2
    ai_reports._maybe_page(web_app)
    assert surge_lines(caplog) == []

    unsafe_report(payers[2], web_app, ledger_call(payers[2], web_app, outcome="settled"))
    ai_reports._maybe_page(web_app)
    [line] = surge_lines(caplog)
    assert line == {"severity": "CRITICAL", "event": "ai_output_report_surge",
                    "client_id": web_app.client_id, "reporters": 3, "message": line["message"]}
    # A fourth paying reporter in the same hour does not page again.
    unsafe_report(payers[3], web_app, ledger_call(payers[3], web_app, outcome="settled"))
    ai_reports._maybe_page(web_app)
    assert len(surge_lines(caplog)) == 1
    # Reports older than the window stop counting.
    AiOutputReport.objects.update(unsafe_at=timezone.now() - timedelta(hours=2))
    assert ai_reports._paid_unsafe_reporters(web_app.pk) == 0


def test_unsafe_cap_is_five_an_hour_inside_the_overall_cap(reporter, user, web_app):
    calls = [gateway_call(user, web_app) for _ in range(7)]
    statuses = [reporter.post(url(c), {"reason": "unsafe"}, format="json").status_code
                for c in calls[:6]]
    assert statuses == [201] * 5 + [429]
    # Other reasons are still accepted, and an escalation is an unsafe event.
    assert reporter.post(url(calls[6]), {"reason": "incorrect"}, format="json").status_code == 201
    assert reporter.post(url(calls[6]), {"reason": "unsafe"}, format="json").status_code == 429


def test_child_directed_app_accepts_the_reason_but_never_text(reporter, user, web_app, monkeypatch):
    monkeypatch.setattr(ai_reports, "_child_directed", lambda app: app.pk == web_app.pk)
    call_id = gateway_call(user, web_app)
    refused = reporter.post(url(call_id), {"reason": "unsafe", "detail": "my name is"}, format="json")
    assert refused.status_code == 400
    assert (refused.json()["error"]["code"], refused.json()["error"]["details"]) == (
        "invalid_request", {"field": "detail"})
    assert not AiOutputReport.objects.exists()
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 201


def test_an_app_with_reports_but_no_grants_is_a_409_not_a_500(
        reporter, user, developer, web_app, client, creator_factory):
    from dj.apps.oidc.models import AppAuthorization
    from django.urls import reverse

    assert reporter.post(url(gateway_call(user, web_app)), {"reason": "unsafe"},
                         format="json").status_code == 201
    # The reporter deleted their account: the grant cascades away, the report stays.
    AppAuthorization.objects.filter(application=web_app).delete()
    console = APIClient()
    console.force_login(developer)
    response = console.delete(f"/api/oauth/apps/{web_app.pk}/")
    assert response.status_code == 409
    assert response.json()["code"] == "app_has_reports"
    # The admin explains the protected reports instead of erroring.
    client.force_login(creator_factory(username="staff", is_staff=True, is_superuser=True))
    page = client.post(reverse("admin:oidc_f2zapplication_delete", args=[web_app.pk]), {"post": "yes"})
    assert page.status_code == 200
    assert b"Cannot delete" in page.content and b"AI output report" in page.content
    assert type(web_app).objects.filter(pk=web_app.pk).exists()


@pytest.mark.skipif(not hasattr(F2ZApplication, "child_directed"),
                    reason="F2ZApplication.child_directed lands with tuzi#2633")
def test_child_directed_reads_the_registration(web_app):
    assert ai_reports._child_directed(web_app) is False
    type(web_app).objects.filter(pk=web_app.pk).update(child_directed=True)
    web_app.refresh_from_db()
    assert ai_reports._child_directed(web_app) is True


def test_a_dedupe_store_that_swallows_errors_still_pages(
        ledger_third_party, web_app, creator_factory, caplog, monkeypatch):
    """Production's Redis cache has IGNORE_EXCEPTIONS: a failed get returns
    None and a failed set does nothing. Both must still page (a duplicate is
    the cheap failure); a real hit suppresses."""
    caplog.set_level(logging.INFO)
    for _ in range(3):
        payer = creator_factory(tuzis=100)
        unsafe_report(payer, web_app, ledger_call(payer, web_app, outcome="settled"))
    monkeypatch.setattr(ai_reports.cache, "get", lambda *a, **k: None)
    monkeypatch.setattr(ai_reports.cache, "set", lambda *a, **k: None)
    ai_reports._maybe_page(web_app)
    ai_reports._maybe_page(web_app)
    assert len(surge_lines(caplog)) == 2
    monkeypatch.setattr(ai_reports.cache, "get", lambda *a, **k: 1)
    ai_reports._maybe_page(web_app)
    assert len(surge_lines(caplog)) == 2


def test_the_page_is_marked_only_after_it_is_written(
        ledger_third_party, web_app, creator_factory, caplog, monkeypatch):
    """A worker that dies between deciding to page and writing the line must
    not leave the app marked as paged."""
    caplog.set_level(logging.INFO)
    for _ in range(3):
        payer = creator_factory(tuzis=100)
        unsafe_report(payer, web_app, ledger_call(payer, web_app, outcome="settled"))

    def die(*args, **kwargs):
        raise SystemExit("worker killed")
    monkeypatch.setattr(ai_reports.logger, "critical", die)
    with pytest.raises(SystemExit):
        ai_reports._maybe_page(web_app)
    monkeypatch.undo()
    caplog.set_level(logging.INFO)
    ai_reports._maybe_page(web_app)
    assert [line["reporters"] for line in surge_lines(caplog)] == [3]


def test_an_earlier_report_whose_call_settles_later_counts_on_the_next_report(
        ledger_third_party, web_app, creator_factory, caplog):
    """paid is judged at count time: a report filed while its call was still
    unsettled counts once the ledger settles it, at the next evaluation."""
    caplog.set_level(logging.INFO)
    payers = [creator_factory(tuzis=100) for _ in range(3)]
    for payer in payers[:2]:
        unsafe_report(payer, web_app, ledger_call(payer, web_app, outcome="settled"))
    pending = ledger_call(payers[2], web_app, outcome="claimed")
    unsafe_report(payers[2], web_app, pending)
    ai_reports._maybe_page(web_app)
    assert surge_lines(caplog) == []
    held = ledger_calls.hold(payers[2], web_app.pk, pending)
    ledger_calls.complete(payers[2], web_app.pk, pending)
    ledger_calls.call("settle", held["hold_id"], 10_000_000, json.dumps(ledger_calls.COMPLETE))
    ai_reports._maybe_page(web_app)
    assert [line["reporters"] for line in surge_lines(caplog)] == [3]


def test_every_unsafe_submission_re_evaluates_the_page_a_retry_included(
        reporter, user, web_app, monkeypatch):
    """The endpoint wiring for the settled-later case: a retry of an unsafe
    report (the only signal after a late settlement) reaches the evaluator."""
    seen = []
    monkeypatch.setattr(ai_reports, "_maybe_page", lambda app: seen.append(app.pk))
    call_id = gateway_call(user, web_app)
    assert reporter.post(url(call_id), {"reason": "incorrect"}, format="json").status_code == 201
    assert seen == []
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 200
    assert reporter.post(url(call_id), {"reason": "unsafe"}, format="json").status_code == 200
    assert seen == [web_app.pk, web_app.pk]


# ----: pins for the paid predicate and the billed model; the sweep ----

def test_a_settled_but_uncharged_call_is_not_paid(ledger_third_party, web_app, creator_factory):
    """`charged > 0`, not just `settled`: an attempt the ledger settled for
    nothing (the provider failed before producing output) bought nothing."""
    payer = creator_factory(tuzis=100)
    account = ensure_account(payer.pk)
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_app(id) VALUES (%s) ON CONFLICT DO NOTHING", [web_app.pk])
        cursor.execute("INSERT INTO ledger_spend_cap(app_id, account_id, cap_m2z, period, grant_generation)"
                       " VALUES (%s, %s, 20000, 'total', 4) ON CONFLICT DO NOTHING", [web_app.pk, account])
    call_id = ledger_calls.claim(payer, web_app.pk, key=None)["call_id"]
    held = ledger_calls.hold(payer, web_app.pk, call_id)
    ledger_calls.complete(payer, web_app.pk, call_id)
    settled = ledger_calls.call("settle_fixed", held["hold_id"], 0)
    assert (settled["status"], settled["charged"]) == ("settled", 0)
    assert ai_reports._owned_call(call_id, web_app.pk, payer.pk)[1] is False


def test_the_report_names_the_billed_model_over_completion_and_claim(
        ledger_third_party, web_app, creator_factory):
    """Claim, completion and billed attempt can each name a model (fallback):
    the billed attempt's wins."""
    payer = creator_factory(tuzis=100)
    account = ensure_account(payer.pk)
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO ledger_app(id) VALUES (%s) ON CONFLICT DO NOTHING", [web_app.pk])
        cursor.execute("INSERT INTO ledger_spend_cap(app_id, account_id, cap_m2z, period, grant_generation)"
                       " VALUES (%s, %s, 20000, 'total', 4) ON CONFLICT DO NOTHING", [web_app.pk, account])
    claim_meta = dict(ledger_calls.REQUEST, model="claim-model", requested_model="claim-model")
    call_id = ledger_calls.claim(payer, web_app.pk, key=None, request=claim_meta)["call_id"]
    held = ledger_calls.hold(payer, web_app.pk, call_id)   # holds and bills review-model
    ledger_calls.complete(payer, web_app.pk, call_id,
                          completion=dict(ledger_calls.COMPLETE, model="completion-model"))
    assert ai_reports._owned_call(call_id, web_app.pk, payer.pk)[0] == "completion-model"
    ledger_calls.call("settle", held["hold_id"], 10_000_000, json.dumps(ledger_calls.COMPLETE))
    assert ai_reports._owned_call(call_id, web_app.pk, payer.pk) == ("review-model", True)


def test_the_sweep_pages_when_a_reported_call_settles_later(
        ledger_third_party, web_app, creator_factory, caplog):
    """The case the intake cannot see: the third paying reporter's call
    settles after the report and no unsafe submission follows."""
    from dj.apps.oidc.tasks import reevaluate_ai_report_surges

    caplog.set_level(logging.INFO)
    payers = [creator_factory(tuzis=100) for _ in range(3)]
    for payer in payers[:2]:
        unsafe_report(payer, web_app, ledger_call(payer, web_app, outcome="settled"))
    pending = ledger_call(payers[2], web_app, outcome="claimed")
    unsafe_report(payers[2], web_app, pending)
    assert ai_reports.reevaluate_surges() == 1
    assert surge_lines(caplog) == []
    held = ledger_calls.hold(payers[2], web_app.pk, pending)
    ledger_calls.complete(payers[2], web_app.pk, pending)
    ledger_calls.call("settle", held["hold_id"], 10_000_000, json.dumps(ledger_calls.COMPLETE))
    reevaluate_ai_report_surges(timestamp=0)
    assert [line["reporters"] for line in surge_lines(caplog)] == [3]
    reevaluate_ai_report_surges(timestamp=0)
    assert len(surge_lines(caplog)) == 1


def test_the_sweep_survives_one_failing_app(
        ledger_third_party, web_app, loopback_app, creator_factory, monkeypatch, caplog):
    """One app's failure is logged and skipped; every other app is still
    evaluated (and the next tick retries the failed one)."""
    for app in (web_app, loopback_app):
        payer = creator_factory(tuzis=100)
        unsafe_report(payer, app, ledger_call(payer, app, outcome="settled"))
    evaluated = []

    def flaky(app):
        if app.pk == web_app.pk:
            raise RuntimeError("boom")
        evaluated.append(app.pk)
    monkeypatch.setattr(ai_reports, "_maybe_page", flaky)
    caplog.set_level(logging.ERROR)
    # Every app is still evaluated, and then the job FAILS (so procrastinate's
    # failed-job alerting sees it), naming the app that failed.
    with pytest.raises(ai_reports.SurgeSweepFailed, match=web_app.client_id):
        ai_reports.reevaluate_surges()
    assert evaluated == [loopback_app.pk]
    assert any("re-evaluation failed" in r.getMessage() and r.exc_info for r in caplog.records)


def test_the_partial_unsafe_index_matches_the_readers_predicate():
    """The index holds exactly the rows the surge count reads: unsafe reports,
    keyed by app then unsafe_at. If either side's predicate drifts, the
    planner can no longer use it (tuzi#2654; EXPLAIN in the PR)."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'oidc_aireport_app_unsafe'")
        [(indexdef,)] = cursor.fetchall()
    assert "(application_id, unsafe_at)" in indexdef, indexdef
    assert indexdef.endswith("WHERE ((reason)::text = 'unsafe'::text)"), indexdef
    import inspect
    for reader in (ai_reports._paid_unsafe_reporters, ai_reports.reevaluate_surges):
        source = inspect.getsource(reader)
        assert "r.reason = 'unsafe'" in source or "reason=AiOutputReport.Reason.UNSAFE" in source, reader


def test_a_blocked_app_times_out_into_the_handler_and_the_sweep_moves_on(
        ledger_third_party, web_app, loopback_app, creator_factory, monkeypatch, caplog):
    """A database wait (here: a statement that outlives the budget) becomes a
    logged, skipped app -- not a worker stuck for as long as the wait lasts."""
    for app in (web_app, loopback_app):
        payer = creator_factory(tuzis=100)
        unsafe_report(payer, app, ledger_call(payer, app, outcome="settled"))
    monkeypatch.setattr(ai_reports, "SWEEP_APP_STATEMENT_TIMEOUT", "50ms")
    real = ai_reports._maybe_page

    def slow_for_web_app(app):
        if app.pk == web_app.pk:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_sleep(5)")
        return real(app)
    monkeypatch.setattr(ai_reports, "_maybe_page", slow_for_web_app)
    caplog.set_level(logging.ERROR)
    with pytest.raises(ai_reports.SurgeSweepFailed):
        ai_reports.reevaluate_surges()
    assert any("re-evaluation failed" in r.getMessage() for r in caplog.records)
