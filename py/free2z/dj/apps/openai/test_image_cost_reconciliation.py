import hashlib
import json

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test.utils import CaptureQueriesContext

from dj.apps.tuzis.models import IdempotencyKey


@pytest.mark.django_db
def test_cost_reconciliation_attaches_actual_amount_and_source_digest(creator_factory, tmp_path):
    creator = creator_factory()
    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key="hosted-cost-receipt",
        response_status=503,
        response_body={"detail": "unavailable", "_image_operation": {
            "provider": "fal",
            "model": "fal-ai/flux/schnell",
            "model_version": "FLUX.1 [schnell]",
            "request_id": "synthetic-request-123",
            "estimated_usd": "0.006",
            "billed_usd": None,
            "billing_state": "unreconciled",
            "budget_state": "uncertain",
            "budget_reserved_usd": "0.006",
        }},
    )
    content = json.dumps({
        "request_id": "synthetic-request-123",
        "actual_usd": "0.0055",
        "record_ref": "synthetic-row-1",
    }) + "\n"
    source = tmp_path / "synthetic-billing.jsonl"
    source.write_text(content, encoding="utf-8")

    with CaptureQueriesContext(connection) as queries:
        call_command("reconcile_image_provider_costs", str(source))

    assert any("pg_advisory_xact_lock" in query["sql"] for query in queries)

    receipt.refresh_from_db()
    operation = receipt.response_body["_image_operation"]
    assert operation["estimated_usd"] == "0.006"
    assert operation["billed_usd"] == "0.0055"
    assert operation["billing_state"] == "reconciled"
    assert operation["budget_reserved_usd"] == "0.006"
    evidence = operation["billing_evidence"]
    assert evidence["source_file_sha256"] == hashlib.sha256(content.encode()).hexdigest()
    assert evidence["record_ref"] == "synthetic-row-1"
    assert evidence["reconciled_at"]


@pytest.mark.django_db
def test_cost_reconciliation_refuses_an_inflight_image_receipt(
    creator_factory, tmp_path,
):
    creator = creator_factory()
    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key="active-hosted-cost-receipt",
        response_body={"operation": "ai_image", "_image_operation": {
            "provider": "fal",
            "model": "fal-ai/flux/schnell",
            "model_version": "FLUX.1 [schnell]",
            "request_id": "active-synthetic-request",
            "estimated_usd": "0.006",
            "billed_usd": None,
            "billing_state": "unreconciled",
            "budget_state": "uncertain",
            "budget_reserved_usd": "0.006",
        }},
    )
    source = tmp_path / "active-billing.jsonl"
    source.write_text(json.dumps({
        "request_id": "active-synthetic-request",
        "actual_usd": "0.0055",
        "record_ref": "synthetic-row-active",
    }) + "\n", encoding="utf-8")

    with pytest.raises(CommandError, match="still in flight"):
        call_command("reconcile_image_provider_costs", str(source))

    receipt.refresh_from_db()
    operation = receipt.response_body["_image_operation"]
    assert operation["billing_state"] == "unreconciled"
    assert operation["billed_usd"] is None
    assert "billing_evidence" not in operation


@pytest.mark.django_db
def test_cost_reconciliation_terminalizes_a_stale_accepted_image(
    creator_factory, tmp_path,
):
    from datetime import timedelta
    from django.utils import timezone
    from dj.apps.tuzis.models import STALE_CLAIM

    creator = creator_factory()
    receipt = IdempotencyKey.objects.create(
        scope="ai_image", user=creator, key="stale-hosted-cost-receipt",
        response_body={"operation": "ai_image", "_image_operation": {
            "provider": "fal",
            "model": "fal-ai/flux/schnell",
            "model_version": "FLUX.1 [schnell]",
            "request_id": "stale-synthetic-request",
            "estimated_usd": "0.006",
            "billed_usd": None,
            "billing_state": "unknown",
            "budget_state": "uncertain",
            "budget_reserved_usd": "0.006",
            "budget_day": timezone.localdate().isoformat(),
        }},
    )
    IdempotencyKey.objects.filter(pk=receipt.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )
    source = tmp_path / "stale-billing.jsonl"
    source.write_text(json.dumps({
        "request_id": "stale-synthetic-request",
        "actual_usd": "0.007",
        "record_ref": "synthetic-row-stale",
    }) + "\n", encoding="utf-8")

    call_command("reconcile_image_provider_costs", str(source))

    receipt.refresh_from_db()
    assert receipt.response_status == 503
    assert receipt.response_body["key_resolved"] is True
    operation = receipt.response_body["_image_operation"]
    assert operation["billing_state"] == "reconciled"
    assert operation["budget_reserved_usd"] == "0.007"
    assert operation["billing_evidence"]["record_ref"] == "synthetic-row-stale"


@pytest.mark.django_db
@pytest.mark.parametrize("amount", [True, "NaN", "Infinity", "-0.01"])
def test_cost_reconciliation_rejects_invalid_actual_amount(tmp_path, amount):
    source = tmp_path / "synthetic-billing.jsonl"
    source.write_text(json.dumps({
        "request_id": "missing-request",
        "actual_usd": amount,
        "record_ref": "synthetic-row-1",
    }), encoding="utf-8")

    with pytest.raises(CommandError):
        call_command("reconcile_image_provider_costs", str(source))
