"""
Django management command to write tags to disk and AI Pairs to disk
"""
import time
import json

from django.core.management.base import BaseCommand
from django.db.models import Count, Subquery, OuterRef, F, Value, Q
from django.db.models.functions import Coalesce

from taggit.models import Tag

from dj.apps.comments.models import UUIDTaggedItem

from f2z.openai.util import get_tag_combine_pairs


class Command(BaseCommand):
    def handle(self, **kwargs):
        print("find tags to delete")
        # Delete tags that are not used
        to_delete = Tag.objects.annotate(
            taggeditem_count=Count('taggit_taggeditem_items'),
            uuidtaggeditem_count=Count('comments_uuidtaggeditem_items')
        ).filter(
            Q(taggeditem_count=0) & Q(uuidtaggeditem_count=0)
        )
        print(f"Deleting {to_delete.count()} tags")
        to_delete.delete()

        print("get tags from db")
        TAGS = list(Tag.objects.annotate(
            taggeditem_count=Count('taggit_taggeditem_items'),
            uuidtaggeditem_count=Count('comments_uuidtaggeditem_items'),
            total_count=Coalesce(F('taggeditem_count'), 0) + Coalesce(F('uuidtaggeditem_count'), 0)
        ).values_list('name', 'total_count').order_by('name'))

        print("write tags to disk")
        with open('./tags.json', 'w') as file:
            json.dump(TAGS, file)

        # with open('./tags.json', 'r') as file:
        #     TAGS = json.load(file)

        # shouldn't be necessary, but just in case
        time.sleep(1)

        print("Get tag pairs from AI")
        PAIRS = get_tag_combine_pairs(tags=TAGS)
        print("write pairs to disk")
        with open('./tag_pairs.json', 'w') as file:
            json.dump(PAIRS, file)

        print("Goodbye")
