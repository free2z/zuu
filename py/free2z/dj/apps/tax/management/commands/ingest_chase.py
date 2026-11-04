from django.core.management.base import BaseCommand

from dj.apps.tax.lib.chase import ChaseCSV


class Command(BaseCommand):

    # add options for path to csv
    def add_arguments(self, parser):
        parser.add_argument('path', type=str)

    def handle(self, *args, **options):
        g = ChaseCSV(options['path'])
        g.ingest()
