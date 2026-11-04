"""
Backfill the legacy public WebP thumbnail for images that lack one.

Superseded for new uploads by the ImageVariant pipeline; this
sweep only covers the historical backlog.

Memory (2026-07-19 prod incident): the previous implementation did

    images = GenericFile.objects.filter(...)[:1000]
    for image in images:
        create_thumbnail(image)

which materialises all 1000 model instances into the queryset's result
cache and keeps every one of them alive for the whole loop, while
create_thumbnail simultaneously holds the raw bytes, the decoded raster
and the encoded WebP for the current image. RSS ratcheted up until the
512Mi container was OOMKilled ~19s in, every single time.

This version is keyset-paginated (`pk__gt`), so at any instant only
--batch-size rows are in memory, no result cache spans the run, and peak
RSS is independent of how many images are pending. `del` + gc between
batches returns Pillow's large allocations promptly rather than letting
them accumulate across the run.

Keyset paging (rather than LIMIT/OFFSET) is also the correct choice
here because processing a row removes it from the filtered set — every
image either gains a Webp or is marked skip_thumbnail — so OFFSET would
silently skip rows as the set shrank underneath it.
"""
import gc

from django.core.management.base import BaseCommand
from django.db.models import Q

from dj.apps.uploads.models import GenericFile
from dj.apps.uploads.image_utils import create_thumbnail

# Rows held in memory at once. Small on purpose: the per-image cost is
# dominated by Pillow buffers, not by the model rows, and there is no
# throughput benefit to a wider window.
DEFAULT_BATCH_SIZE = 25

# Images per run. The schedule is the loop — a run that ends with work
# left simply picks up where it left off next tick, which bounds
# wall-clock time and keeps the job well inside activeDeadlineSeconds.
DEFAULT_LIMIT = 500


def pending_queryset():
    """GenericFiles still needing a legacy WebP thumbnail, pk-ordered."""
    return GenericFile.objects.filter(
        Q(webp__isnull=True)
        & Q(access="public")
        & Q(mime_type__startswith="image")
        & Q(skip_thumbnail=False)
    ).exclude(
        mime_type__in=['image/gif', 'image/svg+xml']
    ).order_by('pk')


class Command(BaseCommand):
    help = 'Create thumbnails for public images that have none (batched)'

    def add_arguments(self, parser):
        parser.add_argument(
            '--batch-size', type=int, default=DEFAULT_BATCH_SIZE,
            help=(
                'Rows fetched (and held in memory) per DB batch '
                f'(default {DEFAULT_BATCH_SIZE})'
            ),
        )
        parser.add_argument(
            '--limit', type=int, default=DEFAULT_LIMIT,
            help=(
                'Maximum images to process in one run; 0 means no limit '
                f'(default {DEFAULT_LIMIT})'
            ),
        )

    def handle(self, *args, **options):
        batch_size = max(1, options['batch_size'])
        limit = max(0, options['limit'])

        queryset = pending_queryset()
        processed = 0
        last_pk = None

        while limit == 0 or processed < limit:
            page = queryset
            if last_pk is not None:
                page = page.filter(pk__gt=last_pk)

            take = batch_size if limit == 0 else min(
                batch_size, limit - processed)
            batch = list(page[:take])
            if not batch:
                break

            last_pk = batch[-1].pk
            for image in batch:
                try:
                    create_thumbnail(image)
                except Exception as exc:  # pragma: no cover - defensive
                    # create_thumbnail already swallows per-image errors;
                    # this is a last resort so one pathological file can
                    # never abort the whole sweep.
                    self.stderr.write(self.style.ERROR(
                        f"create_thumbnail failed for {image.pk}: {exc}"))
                processed += 1

            # Drop the batch's model instances (and everything Pillow
            # touched through them) before fetching the next page.
            del batch
            gc.collect()
            self.stdout.write(f"  processed {processed}")

        self.stdout.write(self.style.SUCCESS(
            f"Processed {processed} image(s)"))
