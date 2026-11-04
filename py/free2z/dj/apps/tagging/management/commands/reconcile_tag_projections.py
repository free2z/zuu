"""Repair derived tag projections after imports or legacy application writes.

The taggit API intentionally permits bulk and raw writes, so ``post_save`` is
only an acceleration hook.  This command is safe to run repeatedly and is
useful during the rolling window around tagging migration 0003::

    python manage.py reconcile_tag_projections
"""

from django.core.management.base import BaseCommand
from django.db import transaction
from taggit.models import Tag

from dj.apps.tagging.models import TagAlias, TagIdentity, tag_key
from dj.apps.tagging.slugs import slugify_tag


BATCH_SIZE = 1000


class Command(BaseCommand):
    help = "Repair TagIdentity and TagAlias derived fields from source names."

    def handle(self, *args, **options):
        identities = 0
        aliases = 0

        last_tag_id = 0
        while True:
            with transaction.atomic():
                tags = list(
                    Tag.objects.filter(pk__gt=last_tag_id)
                    .order_by("pk")[:BATCH_SIZE]
                )
                if not tags:
                    break
                desired = {
                    tag.pk: (tag_key(tag.name), slugify_tag(tag.name))
                    for tag in tags
                }
                TagIdentity.objects.bulk_create(
                    [
                        TagIdentity(
                            tag_id=tag_id,
                            name_key=name_key,
                            slug=slug,
                        )
                        for tag_id, (name_key, slug) in desired.items()
                    ],
                    ignore_conflicts=True,
                    batch_size=BATCH_SIZE,
                )
                rows = list(
                    TagIdentity.objects.filter(tag_id__in=desired)
                )
                for row in rows:
                    row.name_key, row.slug = desired[row.tag_id]
                TagIdentity.objects.bulk_update(
                    rows, ["name_key", "slug"], batch_size=BATCH_SIZE
                )
                identities += len(rows)
                last_tag_id = tags[-1].pk

        last_alias_id = 0
        while True:
            with transaction.atomic():
                rows = list(
                    TagAlias.objects.filter(pk__gt=last_alias_id)
                    .order_by("pk")[:BATCH_SIZE]
                )
                if not rows:
                    break
                for row in rows:
                    row.slug = slugify_tag(row.name)
                    row.name_key = tag_key(row.name)
                TagAlias.objects.bulk_update(
                    rows, ["name_key", "slug"], batch_size=BATCH_SIZE
                )
                aliases += len(rows)
                last_alias_id = rows[-1].pk

        self.stdout.write(
            self.style.SUCCESS(
                f"Reconciled {identities} tag identities and {aliases} aliases."
            )
        )
