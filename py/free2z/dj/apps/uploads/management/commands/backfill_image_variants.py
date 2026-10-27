"""
One-shot backfill: enqueue generate_image_variants for every existing
raster image that has no variants yet — including private and
members-only uploads, which the old create_thumbnails cron always
skipped (it filtered access="public").

Run after the procrastinate worker Deployment is live:

    python dj/free2z/manage.py backfill_image_variants
    python dj/free2z/manage.py backfill_image_variants --batch-size 200 --limit 1000  # dry-run-ish first slice

The task itself is idempotent (skips existing rungs), so re-running the
command is safe.
"""
from django.core.management.base import BaseCommand
from django.db.models import Exists, OuterRef

from dj.apps.uploads.models import (
    NON_RASTER_IMAGE_MIME_TYPES,
    GenericFile,
    ImageVariant,
)
from dj.apps.uploads.tasks import generate_image_variants


class Command(BaseCommand):
    help = (
        "Enqueue image-variant generation for raster images without "
        "variants (all access levels, unlike the legacy thumbnail cron)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--batch-size", type=int, default=500,
            help="IDs fetched per DB batch (default 500)",
        )
        parser.add_argument(
            "--limit", type=int, default=None,
            help="Max number of jobs to enqueue (default: no limit)",
        )

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        limit = options["limit"]

        queryset = GenericFile.objects.filter(
            mime_type__startswith="image",
        ).exclude(
            mime_type__in=NON_RASTER_IMAGE_MIME_TYPES,
        ).filter(
            # skip_thumbnail marks animated images and known-bad files
            # from the legacy pipeline; the task would skip them anyway.
            skip_thumbnail=False,
        ).annotate(
            has_variants=Exists(
                ImageVariant.objects.filter(parent=OuterRef("pk"))
            ),
        ).filter(
            has_variants=False,
        ).order_by("pk").values_list("pk", flat=True)

        missing = queryset.count()
        total = missing if limit is None else min(missing, limit)
        self.stdout.write(f"Images lacking variants: {missing}")
        if limit is not None:
            self.stdout.write(f"Limiting to {total}")

        enqueued = 0
        last_pk = None
        while enqueued < total:
            page = queryset
            if last_pk is not None:
                page = page.filter(pk__gt=last_pk)
            batch = list(page[:min(batch_size, total - enqueued)])
            if not batch:
                break
            for pk in batch:
                generate_image_variants.defer(generic_file_id=pk)
                enqueued += 1
            last_pk = batch[-1]
            self.stdout.write(f"  enqueued {enqueued}/{total}")

        self.stdout.write(self.style.SUCCESS(
            f"Enqueued {enqueued} generate_image_variants jobs"
        ))
