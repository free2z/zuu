"""
Go through zPages with tags and create training data for auto-tagging model.
"""
import jsonlines

from django.db import models
from django.core.management.base import BaseCommand

from dj.apps.g12f.models import zPage


class Command(BaseCommand):
    help = 'Creates JSONL training file for OpenAI autotagging'

    def handle(self, *args, **kwargs):
        # Query your zPage model to get a list of all zPages
        zpages = zPage.objects.annotate(
            tag_count=models.Count('tags')
        ).filter(tag_count__gt=0)

        # Prepare a list of training examples
        training_data = []
        for zpage in zpages:
            prompt = f"{zpage.title}\n{zpage.content[:1024]}"
            ideal_tags = ",".join(zpage.tags.names()[:5])
            training_data.append({"prompt": prompt, "completion": ideal_tags})

        # Write the training data to a JSONL file
        with jsonlines.open("training_data.jsonl", mode="w") as writer:
            writer.write_all(training_data)
