"""Print the bounded, read-only queue for Stripe financial reconciliation."""
import json

from django.core.management.base import BaseCommand, CommandError

from dj.apps.tuzis.models import IdempotencyKey


class Command(BaseCommand):
    help = "Show saved Stripe refund/dispute evidence and plans without provider or ledger writes."

    def add_arguments(self, parser):
        parser.add_argument("--creator-id", type=int, required=True)
        parser.add_argument("--limit", type=int, default=50)
        parser.add_argument("--status", choices=("pending", "resolved", "all"), default="pending",
            help="Show pending cases first by default; select resolved or all for historical review.")
        parser.add_argument("--after-id", type=int, default=0,
            help="Continue stable keyset pagination after this event/evidence row id.")
        parser.add_argument("--event-id", help="Show immutable evidence history for one provider event id.")

    def handle(self, *args, **options):
        creator_id, limit = options["creator_id"], options["limit"]
        after_id, event_id, status = options["after_id"], options["event_id"], options["status"]
        if creator_id <= 0 or not 1 <= limit <= 100 or after_id < 0:
            raise CommandError("creator-id must be positive, limit 1..100, and after-id nonnegative")
        if event_id:
            rows = IdempotencyKey.objects.filter(user_id=creator_id,
                scope="stripe-financial-evidence",
                response_body__snapshot__signed_event__provider_event_id=event_id)
            rows = rows.filter(id__gt=after_id).order_by("id")[:limit + 1]
            page_rows = list(rows)
            has_more = len(page_rows) > limit
            page_rows = page_rows[:limit]
            for row in page_rows:
                self.stdout.write(json.dumps({"kind": "evidence",
                    "evidence_id": row.pk, "snapshot": row.response_body.get("snapshot"),
                    "outcomes": row.response_body.get("outcomes", []),
                    "next_after_id": page_rows[-1].pk if has_more and row is page_rows[-1] else None},
                    sort_keys=True, separators=(",", ":")))
            return
        rows = IdempotencyKey.objects.filter(user_id=creator_id,
            scope="stripe-financial-event", id__gt=after_id)
        if status == "pending":
            rows = rows.filter(response_body__status="pending_resolution")
        elif status == "resolved":
            rows = rows.exclude(response_body__status="pending_resolution")
        rows = rows.order_by("id")[:limit + 1]
        page_rows = list(rows)
        has_more = len(page_rows) > limit
        page_rows = page_rows[:limit]
        for row in page_rows:
            body = row.response_body if isinstance(row.response_body, dict) else {}
            observation = body.get("observation", {})
            payload = {
                "kind": "event",
                "resolution_id": f"stripe-event:{row.pk}",
                "provider_event_id": observation.get("provider_event_id"),
                "event_type": observation.get("event_type"),
                "status": body.get("status", "pending_resolution"),
                "reason": body.get("reason", "financial_reconciliation_requires_review"),
                "evidence_id": body.get("evidence_id"),
                "plan": body.get("plan"),
                "next_after_id": page_rows[-1].pk if has_more and row is page_rows[-1] else None,
            }
            self.stdout.write(json.dumps(payload, sort_keys=True, separators=(",", ":")))
