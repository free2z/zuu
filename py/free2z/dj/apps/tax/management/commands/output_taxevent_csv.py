import csv

from django.core.management.base import BaseCommand, CommandError
from django.utils.dateparse import parse_date

from dj.apps.tax.models import TaxEvent


class Command(BaseCommand):
    help = 'Export TaxEvent data to a CSV file'

    def add_arguments(self, parser):
        # Optional start date argument
        parser.add_argument('--start-date', type=str, help='Start date (YYYY-MM-DD)')
        # Optional end date argument
        parser.add_argument('--end-date', type=str, help='End date (YYYY-MM-DD)')
        # Mandatory file path argument
        parser.add_argument('path', type=str, help='Path to the output CSV file')

    def handle(self, *args, **options):
        start_date = options['start_date']
        end_date = options['end_date']
        path = options['path']

        if start_date:
            start_date = parse_date(start_date)
            if not start_date:
                raise CommandError('Start date is invalid.')

        if end_date:
            end_date = parse_date(end_date)
            if not end_date:
                raise CommandError('End date is invalid.')

        # Assuming the static method on TaxEvent class is named 'get_filtered_events'
        events = TaxEvent.get_filtered_events(start_date=start_date, end_date=end_date)

        # Define CSV headers
        headers = [
            'unique_id', 'date_time', 'description', 'category',
            'currency_out_id', 'amount_out', 'currency_in_id', 'amount_in',
            'usd_value', 'type', 'gain_loss',
        ]

        # Write to CSV
        with open(path, 'w', newline='') as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=headers)
            writer.writeheader()
            for event in events:
                writer.writerow({
                    'unique_id': event.unique_id,
                    'date_time': event.date_time,
                    'description': event.description,
                    'category': event.category,
                    'currency_out_id': event.currency_out_id,
                    'amount_out': event.amount_out,
                    'currency_in_id': event.currency_in_id,
                    'amount_in': event.amount_in,
                    'usd_value': event.usd_value,
                    'type': event.get_type(),
                    'gain_loss': event.gain_loss,
                })

        self.stdout.write(self.style.SUCCESS(f'Successfully exported TaxEvent data to {path}'))
