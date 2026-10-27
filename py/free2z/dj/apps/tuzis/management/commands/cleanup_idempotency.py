"""Prune completed retry receipts beyond the documented replay horizon."""

from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q
from django.utils import timezone

from dj.apps.tuzis import ledger
from dj.apps.tuzis.models import (
    COMPLETED_CLAIM_RETENTION,
    IdempotencyKey,
    ProviderReservation,
    STALE_CLAIM,
    SubscriptionIntentAbandonment,
    SubscriptionIntentEvidence,
)

BATCH_SIZE = 1000
# Only the HTTP money contracts publish a finite replay horizon. The legacy
# subscription route target-scopes receipts as ``subscribe:<creator_pk>``;
# the explicit contracts use the exact scope names below.
# Other users of this shared table, notably ``aiscore_comment``, are permanent
# exactly-once markers whose deletion could repeat a credit/debit or strike.
EXPIRING_SCOPES = (
    "donate-idempotent",
    "subscribe-confirmed",
    # dj.apps.e2ee's paid chat request publishes the same 365-day horizon.
    "e2ee-chat-request",
    # dj.apps.g12f's POST /api/zpage/ create receipt. Deleting one only
    # means a retry older than the horizon creates a new page; no 2Z moves.
    "zpage-create",
)
EXPIRING_SCOPE_FILTER = (
    Q(scope__in=EXPIRING_SCOPES)
    | Q(scope__startswith="subscribe:")
    | Q(scope__startswith="subscribe-intent:")
    | Q(
        scope="ai_image",
        response_body__contains={
            "_image_operation": {"key_source": "server_generated"},
        },
    )
    | Q(
        scope="ai_image",
        response_body__contains={"_server_generated_ai_image_key": True},
    )
)


class Command(BaseCommand):
    help = "Delete completed idempotency receipts outside their replay horizon"

    def add_arguments(self, parser):
        parser.add_argument(
            "--retention-days",
            type=int,
            default=COMPLETED_CLAIM_RETENTION.days,
        )
        parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)

    def handle(self, *args, **options):
        retention_days = options["retention_days"]
        batch_size = options["batch_size"]
        if retention_days < 1:
            raise CommandError("--retention-days must be at least one day")
        if batch_size < 1:
            raise CommandError("--batch-size must be at least one row")

        # IdempotencyKey.finish() advances created_at to completion time. For
        # completed rows this therefore measures the full advertised replay
        # horizon, even when the original claim spent minutes in flight.
        cutoff = timezone.now() - timedelta(days=retention_days)
        deleted = 0
        while True:
            ids = list(
                IdempotencyKey.objects.filter(
                    EXPIRING_SCOPE_FILTER,
                    response_status__isnull=False,
                    created_at__lt=cutoff,
                )
                .order_by("pk")
                .values_list("pk", flat=True)[:batch_size]
            )
            if not ids:
                break
            count, _ = IdempotencyKey.objects.filter(
                pk__in=ids,
                response_status__isnull=False,
                created_at__lt=cutoff,
            ).filter(
                EXPIRING_SCOPE_FILTER,
            ).delete()
            deleted += count

        abandoned_deleted = 0
        while True:
            ids = list(
                SubscriptionIntentAbandonment.objects.filter(
                    created_at__lt=cutoff,
                )
                .order_by("pk")
                .values_list("pk", flat=True)[:batch_size]
            )
            if not ids:
                break
            count, _ = SubscriptionIntentAbandonment.objects.filter(
                pk__in=ids,
                created_at__lt=cutoff,
            ).delete()
            abandoned_deleted += count

        evidence_deleted = 0
        terminal_evidence = Q(
            resolved_at__isnull=False,
        ) | Q(abandoned_at__isnull=False)
        while True:
            ids = list(
                SubscriptionIntentEvidence.objects.filter(
                    terminal_evidence,
                    created_at__lt=cutoff,
                )
                .order_by("pk")
                .values_list("pk", flat=True)[:batch_size]
            )
            if not ids:
                break
            count, _ = SubscriptionIntentEvidence.objects.filter(
                terminal_evidence,
                pk__in=ids,
                created_at__lt=cutoff,
            ).delete()
            evidence_deleted += count

        # A killed provider request can leave a fixed-cost authorization hold
        # without a live request to release it. Reuse the same stale bound as
        # idempotency claims; release_reservation locks Creator first, matching
        # the reservation path and avoiding a cleanup-vs-request deadlock.
        stale_cutoff = timezone.now() - STALE_CLAIM
        released = 0
        while True:
            rows = list(
                ProviderReservation.objects.filter(
                    status=ProviderReservation.ACTIVE,
                    created_at__lt=stale_cutoff,
                ).order_by("pk")[:batch_size]
            )
            if not rows:
                break
            for row in rows:
                if ledger.release_reservation(row):
                    released += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Deleted {deleted} completed idempotency receipt(s); "
                f"deleted {abandoned_deleted} abandonment fence(s) and "
                f"{evidence_deleted} terminal recovery evidence row(s); "
                f"released {released} stale provider reservation(s)"
            )
        )
