from django.core.management.base import BaseCommand


GRANTS = [{
    # 546.737213 ZEC at $56.70 USD/ZEC for a total of $31,000
    'unique_id': 'grant1milestone1',
    'date_time': '2022-07-24 00:00:00',
    'description': 'Grant 1 Milestone 1',
    'currency_in': 'ZEC',
    "amount_in": "546.73721300",
    "usd_value": "31000.00",
}, {
    # 836.12 ZEC at $65.78 USD/ZEC for a total of $55,000
    'unique_id': 'grant1milestone2',
    'date_time': '2022-08-24 00:00:00',
    'description': 'Grant 1 Milestone 2',
    'currency_in': 'ZEC',
    "amount_in": "836.12000000",
    "usd_value": "55000.00",
}, {
    # 808.39 ZEC at $45.77 USD/ZEC for a total of $37,000
    'unique_id': 'grant1milestone3',
    'date_time': '2022-12-05 00:00:00',
    'description': 'Grant 1 Milestone 3',
    'currency_in': 'ZEC',
    "amount_in": "808.39",
    "usd_value": "37000.00",
}, {
    'unique_id': 'grant2milestone1',
    'date_time': '2023-03-08 00:00:00',
    'description': 'Grant 2 Milestone 1',
    'currency_in': 'ZEC',
    "amount_in": "3049.45000000",
    "usd_value": "111000.00",
}, {
    'unique_id': 'grant2milestone2',
    'date_time': '2023-05-10 00:00:00',
    'description': 'Grant 2 Milestone 2',
    'currency_in': 'ZEC',
    "amount_in": "3320.37000000",
    "usd_value": "111000.00",
}, {
    'unique_id': 'grant2milestone3',
    'date_time': '2024-02-06 00:00:00',
    'description': 'Grant 2 Milestone 3',
    'currency_in': 'ZEC',
    "amount_in": "5401.46000000",
    "usd_value": "111000.00",
}]


class Command(BaseCommand):

    def handle(self, *args, **options):
        from dj.apps.tax.models import TaxEvent, Currency
        for grant in GRANTS:
            grant['currency_in'] = Currency.objects.get(code=grant['currency_in'])
            TaxEvent.objects.get_or_create(**grant)
