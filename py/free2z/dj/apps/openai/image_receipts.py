"""Image accounting retained after deletion, without replayable content."""
from django.db import transaction

ACCOUNT_DELETION_SCRUB_MARKER = "_account_deletion_scrubbed"
FINANCIAL_FIELDS = frozenset({
    "provider", "model", "model_version", "model_revision_status", "request_id",
    "provider_status", "billing_state", "billed_usd", "estimated_usd",
    "billing_source", "latency_seconds", "budget_reserved_usd", "budget_state",
    "budget_day", "result_state",
})
EVIDENCE_FIELDS = frozenset({"source_file_sha256", "record_ref", "reconciled_at"})


def scrub_image_receipt(body):
    """Allowlist accounting fields; discard prompts, output URLs and raw results."""
    clean = {ACCOUNT_DELETION_SCRUB_MARKER: True}
    operation = body.get("_image_operation") if isinstance(body, dict) else None
    if isinstance(operation, dict) and operation.get("key_source") == "server_generated":
        # This non-content marker lets bounded cleanup expire private
        # headerless OpenAI receipts after the normal replay horizon.
        clean["_server_generated_ai_image_key"] = True
    if isinstance(operation, dict) and operation.get("provider") == "fal":
        retained = {key: value for key, value in operation.items()
                    if key in FINANCIAL_FIELDS and not isinstance(value, (dict, list))}
        evidence = operation.get("billing_evidence")
        if isinstance(evidence, dict):
            retained["billing_evidence"] = {
                key: value for key, value in evidence.items()
                if key in EVIDENCE_FIELDS and isinstance(value, str)
            }
        clean["_image_operation"] = retained
    return clean


def update_image_receipt(queryset, body, **updates):
    """Serialize writers with deletion and honor its durable privacy fence.

    The queryset retains the caller's ownership/status predicates. Locking the
    receipt does not acquire a Creator lock, preserving the deletion lock order.
    """
    with transaction.atomic():
        receipt = queryset.select_for_update().first()
        if receipt is None:
            return False, body
        previous = receipt.response_body
        if isinstance(previous, dict) and previous.get(ACCOUNT_DELETION_SCRUB_MARKER):
            body = scrub_image_receipt(body)
        queryset.update(response_body=body, **updates)
    return True, body
