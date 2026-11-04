"""Attach manually exported, attributable provider charges to image receipts."""
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

from dj.apps.openai import hosted_image
from dj.apps.tuzis.models import IdempotencyKey, STALE_CLAIM


_RECORD_REFERENCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")
_MAX_MANIFEST_BYTES = 10 * 1024 * 1024


class Command(BaseCommand):
    help = "Reconcile actual USD charges from a local provider billing JSONL export."

    def add_arguments(self, parser):
        parser.add_argument("billing_jsonl", help="Local JSONL export with request_id, actual_usd and record_ref")

    def handle(self, *args, **options):
        path = options["billing_jsonl"]
        try:
            with open(path, "rb") as source:
                raw = source.read(_MAX_MANIFEST_BYTES + 1)
            if len(raw) > _MAX_MANIFEST_BYTES:
                raise CommandError("billing evidence manifest exceeds 10 MiB")
            digest = hashlib.sha256(raw).hexdigest()
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise CommandError("billing evidence file could not be read as UTF-8") from exc

        rows = []
        seen = set()
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CommandError(f"invalid JSONL billing evidence at line {line_number}") from exc
            if not isinstance(row, dict):
                raise CommandError(f"billing evidence at line {line_number} must be an object")
            request_id = row.get("request_id")
            record_ref = row.get("record_ref")
            raw_amount = row.get("actual_usd")
            if (
                not isinstance(request_id, str)
                or not request_id
                or len(request_id) > 200
                or request_id in seen
                or not isinstance(record_ref, str)
                or not _RECORD_REFERENCE.fullmatch(record_ref)
                or isinstance(raw_amount, bool)
                or not isinstance(raw_amount, (str, int, float))
            ):
                raise CommandError(f"invalid or duplicate billing evidence fields at line {line_number}")
            try:
                amount = Decimal(str(raw_amount))
            except (InvalidOperation, TypeError, ValueError) as exc:
                raise CommandError(f"invalid actual USD amount at line {line_number}") from exc
            if not amount.is_finite() or amount < 0:
                raise CommandError(f"invalid actual USD amount at line {line_number}")
            rows.append((request_id, amount, record_ref.strip()))
            seen.add(request_id)
        if not rows:
            raise CommandError("billing evidence file contains no charge rows")

        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(%s)",
                    [hosted_image.BUDGET_ADVISORY_LOCK],
                )
            matches = []
            for request_id, amount, record_ref in rows:
                receipts = list(
                    IdempotencyKey.objects.select_for_update().filter(
                        scope="ai_image",
                        response_body__contains={"_image_operation": {"request_id": request_id}},
                    )[:2]
                )
                if len(receipts) != 1:
                    raise CommandError("billing request ID did not match exactly one image operation")
                receipt = receipts[0]
                stale_unfinished = (
                    receipt.response_status is None
                    and receipt.created_at < timezone.now() - STALE_CLAIM
                )
                if receipt.response_status is None and not stale_unfinished:
                    raise CommandError(
                        "image operation is still in flight; retry reconciliation after it finishes"
                    )
                body = receipt.response_body
                operation = body.get("_image_operation") if isinstance(body, dict) else None
                if (
                    not isinstance(operation, dict)
                    or operation.get("provider") != "fal"
                    or operation.get("model") != hosted_image.MODEL
                    or operation.get("model_version") != hosted_image.MODEL_VERSION
                    or operation.get("billing_state") == "reconciled"
                    or operation.get("billed_usd") is not None
                ):
                    raise CommandError("image operation is not eligible for cost reconciliation")
                matches.append((receipt, body, operation, amount, record_ref))

            for receipt, body, operation, amount, record_ref in matches:
                terminalized_stale = receipt.response_status is None
                operation["billed_usd"] = str(amount)
                operation["billing_state"] = "reconciled"
                operation["budget_state"] = "billed"
                try:
                    reserved = Decimal(str(operation.get("budget_reserved_usd", "0")))
                except (InvalidOperation, TypeError, ValueError) as exc:
                    raise CommandError("image receipt has invalid reserved budget metadata") from exc
                if not reserved.is_finite() or reserved < 0:
                    raise CommandError("image receipt has invalid reserved budget metadata")
                operation["budget_reserved_usd"] = str(max(reserved, amount))
                operation["billing_evidence"] = {
                    "source_file_sha256": digest,
                    "record_ref": record_ref,
                    "reconciled_at": timezone.now().isoformat(),
                }
                body["_image_operation"] = operation
                if terminalized_stale:
                    # The idempotency row outlived both the request deadline
                    # and its stale-claim window. Its worker is gone; retaining
                    # a terminal replay now lets reconciliation settle billing
                    # without ever resubmitting this provider operation.
                    body.update({
                        "code": "image_generation_outcome_uncertain",
                        "key_resolved": True,
                        "detail": "Image generation could not be confirmed after the request stopped.",
                    })
                    receipt.response_status = 503
                    receipt.created_at = timezone.now()
                receipt.response_body = body
                update_fields = ["response_body"]
                if terminalized_stale:
                    update_fields.extend(["response_status", "created_at"])
                receipt.save(update_fields=update_fields)

        self.stdout.write(f"Reconciled {len(matches)} image operation(s); source SHA-256 {digest}.")
