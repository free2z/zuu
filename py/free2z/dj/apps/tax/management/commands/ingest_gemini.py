from django.core.management.base import BaseCommand

from dj.apps.tax.lib.gemini import GeminiCSV


class Command(BaseCommand):

    # add options for path to csv
    def add_arguments(self, parser):
        parser.add_argument('path', type=str)

    def handle(self, *args, **options):
        # instantiate GeminiCSV with path
        g = GeminiCSV(options['path'])
        # ingest
        g.ingest()
