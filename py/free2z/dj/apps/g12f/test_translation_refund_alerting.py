"""A refunded translation must be VISIBLE to an operator.

``translate_zpage`` settles every failure it can observe -- a provider error,
an answer the safety checks refuse, a delivery precondition that no longer
holds -- by refunding the creator and returning normally. That is right for the
creator and it made the failure invisible: Procrastinate recorded the job as
succeeded, so the job-health sweep's terminal-failure count never moved. On
2026-09-18 six of thirteen runs were refunded inside thirteen minutes with
``failed_recent_total=0`` the whole time.

These tests drive the REAL task against real Postgres with a fake provider (no
network), then run the REAL health sweep, and assert on what it reports. The
refund itself is asserted too, because the fix must not trade the creator's
money for an alert.

Negative control, run by hand for the PR: stub
``health.collect_translation_refunds`` to return ``{}`` (i.e. the pre-
sweep, which only read ``procrastinate_jobs``) and every alerting assertion
below goes red while the refund assertions stay green.
"""
import json
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from dj.apps.g12f.translation import charges, service, settlement
from dj.apps.jobs import health
from dj.apps.jobs.tasks import report_job_health
from dj.apps.tuzis.models import IdempotencyKey

# The  harness: the real purchase view, the real task, a fake provider.
# Importing the fixtures registers them here, including the two autouse ones
# (every provider "has a key"; the failure ceilings are out of the way).
from dj.apps.g12f.test_translation_settlement import (  # noqa: F401
    BODY,
    Provider,
    ai_model,
    balance,
    buy,
    client_for,
    keyed_provider,
    make_page,
    record_for,
    roomy_ceilings,
    run_job,
)


def _translation_queue(**kwargs):
    queues = {q.queue: q for q in health.collect_queue_health(**kwargs)}
    return queues[health.TRANSLATION_QUEUE]


def _fail_one(creator_factory, monkeypatch, fake):
    """Buy one translation and run it against ``fake``. Returns the record."""
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    before = balance(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(service, "stream_chat", fake)
    run_job(response)
    body = record_for(response)
    # The fix must not cost the creator anything: every failure below is ours
    # or the provider's, so every 2Z comes back.
    assert body["status"] == charges.REFUNDED, body
    assert balance(creator) == before
    return body


def _json_lines(caplog, logger_name):
    out = []
    for rec in caplog.records:
        if rec.name != logger_name:
            continue
        try:
            out.append(json.loads(rec.getMessage()))
        except ValueError:
            continue
    return out


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_provider_error_is_refunded_AND_alerts_at_one(
    creator_factory, monkeypatch, caplog
):
    """A revoked key / an outage: one is enough, the next one fails the same."""
    caplog.set_level("INFO", logger="dj.apps.g12f.translation.charges")
    body = _fail_one(
        creator_factory, monkeypatch,
        Provider(error=ConnectionError("401 invalid api key")),
    )
    assert body["error"] == "provider_error"

    # The per-event line: one structured JSON record of the refund.
    events = [
        p for p in _json_lines(caplog, "dj.apps.g12f.translation.charges")
        if p.get("event") == charges.REFUND_EVENT
    ]
    assert len(events) == 1, events
    event = events[0]
    assert event["code"] == "provider_error"
    assert event["fault"] == settlement.PROVIDER
    assert event["severity"] == "ERROR"
    assert event["job_id"] == body["job_id"]
    assert event["ai_model"] == body["ai_model"]
    assert event["message"]

    # The count the alert is decided on, read from the charge rows.
    translation = _translation_queue()
    assert translation.failed_recent == 0, (
        "the job did not fail in Procrastinate's terms -- if this is non-zero "
        "the test is no longer exercising the refund path"
    )
    assert translation.refunded_codes == {"provider_error": 1}
    assert "translation_refunds" in translation.alerts()


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_one_rejected_answer_is_reported_but_does_not_alert(
    creator_factory, monkeypatch
):
    """One bad generation is a hard article, not an incident.

    An EMPTY answer, since: a safety violation such as injected markup is
    now delivered with a warning rather than refunded, so it no longer reaches
    this sweep at all. Unusable output is what still refunds.
    """
    body = _fail_one(creator_factory, monkeypatch, Provider(empty=True))
    assert body["error"] == "empty_output"

    translation = _translation_queue()
    assert translation.refunded_codes == {"empty_output": 1}
    assert translation.alerts() == []
    payload = translation.as_payload(3600)
    assert payload["refunded_recent"] == 1
    assert payload["refunded_codes"] == {"empty_output": 1}


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_three_rejected_answers_in_the_window_alert(
    creator_factory, monkeypatch, caplog
):
    """The 2026-09-18 shape: a run of model-output rejections, all refunded."""
    for _ in range(3):
        _fail_one(creator_factory, monkeypatch, Provider(empty=True))

    caplog.set_level("INFO", logger="dj.apps.jobs.tasks")
    summary = report_job_health()

    assert summary["alerts"] == ["translation_refunds"]
    assert summary["refunded_recent_total"] == 3
    alerting = [
        p for p in _json_lines(caplog, "dj.apps.jobs.tasks")
        if p.get("alert") == "translation_refunds"
    ]
    assert len(alerting) == 1, alerting
    line = alerting[0]
    # Exactly the fields monitoring/alert-policies/translation-refunds.json
    # filters on, plus what the responder reads first.
    assert line["event"] == "procrastinate_job_health"
    assert line["queue"] == health.TRANSLATION_QUEUE
    assert line["severity"] == "ERROR"
    assert line["refunded_recent"] == 3
    assert line["refunded_codes"] == {"empty_output": 3}
    assert "refunded_recent=3" in line["message"]


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_refund_the_buyer_caused_is_not_counted(
    creator_factory, monkeypatch
):
    """Editing your own article under a paid job is expected, not an incident.

    It is still refunded (the first ones are forgiven, ) -- it just must
    not page anybody, or the alert is noise by the end of the first week.
    """
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    response = buy(client_for(creator), page)

    def edit():
        mutation = client_for(creator).patch(
            f"/api/zpage/{page.free2zaddr}/",
            {"content": BODY + "\n\nA typo fixed while the model was working.\n"},
            format="json",
        )
        assert mutation.status_code == 200, mutation.data

    monkeypatch.setattr(service, "stream_chat", Provider(mutate=edit))
    run_job(response)
    body = record_for(response)
    assert body["error"] == "source_changed"
    assert body["requester_caused"] is True

    assert _translation_queue().refunded_codes == {}


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_refund_outside_the_window_is_not_counted(
    creator_factory, monkeypatch
):
    body = _fail_one(
        creator_factory, monkeypatch, Provider(error=ConnectionError("down")),
    )
    assert _translation_queue().refunded_codes == {"provider_error": 1}

    # The sweep two hours from now no longer sees it -- the alert clears on
    # its own, exactly like a terminal job failure does.
    later = timezone.now() + timedelta(hours=2)
    assert _translation_queue(now=later).refunded_codes == {}
    assert body["settled_at"]


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_reaped_abandoned_charge_is_counted(creator_factory):
    """The worker died and the reaper refunded it: ours, and worth hearing."""
    creator = creator_factory(tuzis=Decimal("500"))
    page = make_page(creator)
    response = buy(client_for(creator), page)
    IdempotencyKey.objects.filter(
        scope=charges.SCOPE, response_body__job_id=response.data["job_id"]
    # Past the OUTER deadline: `buy` enqueued a real job that is still
    # `todo`, and the reaper waits for a job still in the queue
    # until `abandoned_hard_after()` rather than refunding it at 90 minutes.
    ).update(
        created_at=timezone.now() - charges.abandoned_hard_after()
        - timedelta(hours=1)
    )

    assert charges.reap_abandoned() == 1
    assert _translation_queue().refunded_codes == {"abandoned": 1}


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_late_reaper_run_after_a_long_outage_is_still_counted(
    creator_factory,
):
    """The window is when it FAILED, not when it was bought.

    Workers down for hours, then the reaper catches up and refunds
    three-hour-old purchases in one tick. A purchase-time filter drops every
    one of them -- the outage this alert most needs to report. (codex
    adversarial review of.)
    """
    for _ in range(3):
        creator = creator_factory(tuzis=Decimal("500"))
        response = buy(client_for(creator), make_page(creator))
        IdempotencyKey.objects.filter(
            scope=charges.SCOPE,
            response_body__job_id=response.data["job_id"],
        # An outage longer than the reaper's OUTER deadline: their jobs are
        # still `todo`, so nothing is refunded before it.
        ).update(
            created_at=timezone.now() - charges.abandoned_hard_after()
            - timedelta(hours=1)
        )

    assert charges.reap_abandoned() == 3
    translation = _translation_queue()
    assert translation.refunded_codes == {"abandoned": 3}
    assert "translation_refunds" in translation.alerts()


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_legacy_refund_with_no_settlement_stamp_cannot_hold_the_alert_on(
    creator_factory, monkeypatch
):
    """Rows settled before `settled_at` existed age out by purchase time."""
    _fail_one(
        creator_factory, monkeypatch, Provider(error=ConnectionError("down")),
    )
    row = IdempotencyKey.objects.get(scope=charges.SCOPE)
    body = dict(row.response_body)
    body.pop("settled_at")
    IdempotencyKey.objects.filter(pk=row.pk).update(response_body=body)
    # Recent purchase, no stamp: counted -- it may have failed just now.
    assert _translation_queue().refunded_codes == {"provider_error": 1}

    IdempotencyKey.objects.filter(pk=row.pk).update(
        created_at=timezone.now() - timedelta(days=2)
    )
    assert _translation_queue().refunded_codes == {}


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_the_translation_queue_is_reported_even_with_no_jobs(db):
    """"No refunds" must be a line that says 0, not a missing line."""
    translation = _translation_queue()
    assert translation.refunded_recent == 0
    assert translation.alerts() == []
