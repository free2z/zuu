"""
Quickie to run to reduce a bunch of nonsense tags.
"""
import json

from django.core.management.base import BaseCommand

from taggit.models import Tag, TaggedItem

from dj.apps.comments.models import UUIDTaggedItem
from dj.apps.openai.models import combine_tags


class Command(BaseCommand):
    def handle(self, **kwargs):
        print("Load tag pairs from disk")
        with open('./tag_pairs.json', 'r') as file:
            PAIRS = json.load(file)

        print("Combine tags")
        for pair in PAIRS:
            combine_tags(pair['preferred'], pair['redundant'])
