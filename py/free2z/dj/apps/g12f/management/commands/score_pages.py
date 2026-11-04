"""
Go through all pages and set zscore (f2z_scores decline over time).

Memory: `zPage.objects.all()` materialises every page — including the
full markdown `content` of each — into the queryset result cache and
holds all of them for the length of the run. That is unbounded in the
size of the table, in a 512Mi container, and is the same anti-pattern
that OOM-looped create-thumbnails in prod on 2026-07-19.

The pages are walked with `keyset_iterator` -- one bounded
`WHERE pk > last ORDER BY pk LIMIT chunk_size` statement per page -- so peak
RSS is a function of chunk_size rather than of how many zPages exist. Not
`.iterator()`: DISABLE_SERVER_SIDE_CURSORS (PgBouncer transaction
pooling) makes that a client-side cursor that receives every row, bodies
included, on the first fetch.
"""
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.db.models import Sum

from dj.apps.g12f.models import Creator, zPage
from dj.util.keyset import keyset_iterator

# Rows fetched per keyset page.
CHUNK_SIZE = 200


class Command(BaseCommand):
    help = 'Cache total for all pages'

    def add_arguments(self, parser):
        parser.add_argument(
            '--chunk-size', type=int, default=CHUNK_SIZE,
            help=f'Rows streamed per fetch (default {CHUNK_SIZE})',
        )

    def handle(self, *args, **options):
        chunk_size = max(1, options['chunk_size'])

        scored = 0
        for p in keyset_iterator(zPage.objects.all(), chunk_size=chunk_size):
            p.cache_total()
            scored += 1

        self.stdout.write(self.style.SUCCESS(f"Scored {scored} page(s)"))

        # Creator.total is a projection of the page totals refreshed above.
        # Repair every row after the source pass so drift from a crashed writer,
        # an old pod during a rolling deploy, or historical code is bounded by
        # this command's 20-minute cron interval rather than lasting forever.
        repaired = 0
        creators = (
            Creator._base_manager
            .only('pk', 'total')
            .annotate(
                page_total=Sum('zpage__total'),
                page_tuzi_total=Sum('zpage__tuzi_total'),
            )
            .order_by('pk')
        )
        for creator in creators.iterator(chunk_size=chunk_size):
            calculated = (
                (creator.page_total or Decimal(0))
                + Decimal(creator.page_tuzi_total or 0) / Decimal(1000)
            )
            if calculated == creator.total:
                continue

            # The streaming aggregate is only a cheap drift detector. Re-read
            # and repair under cache_total()'s serialization protocol so this
            # cursor's older snapshot cannot overwrite a concurrent live
            # refresh—even when the new value happens to equal the stale cache.
            creator.cache_total()
            repaired += 1

        self.stdout.write(
            self.style.SUCCESS(f"Repaired {repaired} creator total(s)")
        )
