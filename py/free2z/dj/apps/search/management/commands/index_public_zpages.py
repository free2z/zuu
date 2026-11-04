from django.core.management.base import BaseCommand
from django.contrib.contenttypes.models import ContentType

from dj.apps.g12f.models.zpage import zPage

from dj.apps.search.models import SearchIndex
from dj.apps.search.helpers import build_zpage_index


class Command(BaseCommand):
    """
    Backfill sweep: index published zPages that have no SearchIndex row
    yet. Steady-state indexing is event-driven (search.index_zpage task,
    enqueued on publish/edit — see ); this command shares the same
    per-page code path (build_zpage_index).
    """
    help = 'Indexes all public zPages into the SearchIndex.'

    def handle(self, *args, **options):
        zpage_content_type = ContentType.objects.get_for_model(zPage)

        public_zpages = zPage.objects.filter(
            is_published=True,
            creator__is_active=True,
        ).exclude(
            pk__in=SearchIndex.objects.filter(content_type=zpage_content_type).values_list('object_id', flat=True)
        )
        total_zpages = public_zpages.count()
        self.stdout.write(f"Found {total_zpages} public zPages to index.")

        for page in public_zpages:
            try:
                summary = build_zpage_index(page)
                self.stderr.write(self.style.WARNING(f"{summary.text}"))
                self.stdout.write(self.style.SUCCESS(f"Indexed zPage {page}"))
            except Exception as e:
                self.stderr.write(self.style.ERROR(f"Failed to index zPage {page}: {e}"))

        self.stdout.write(self.style.SUCCESS("Finished indexing all public zPages."))
