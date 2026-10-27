from datetime import UTC, datetime

import pandas as pd

from dj.apps.tax.models import TaxEvent, Currency


EXPENSE_TYPES = [
    'DEBIT_CARD',
    'ACH_DEBIT',
    'ACH_PAYMENT',
    'BASIC_PAYROLL',
    'DEBIT_CARD',
    'FEE_TRANSACTION',
    'LOAN_PMT',
]

INCOME_TYPES = [
    'ACH_CREDIT',
    'DEPOSIT',
    'ACCT_XFER',
]


class ChaseCSV(object):
    def __init__(self, path):
        self.path = path

    def ingest(self):
        print("Ingesting from {}".format(self.path))
        df = pd.read_csv(
            self.path, delimiter=',', quotechar='"',
            escapechar='\\', encoding='utf-8', skipinitialspace=True,
            header=0, index_col=False,
        )

        for i, row in df.iterrows():
            if row['Type'] in EXPENSE_TYPES:
                out_currency_code = 'USD'
                out_currency = Currency.objects.get(code=out_currency_code)

                amount = abs(row['Amount'])

                tax_event, _ = TaxEvent.objects.get_or_create(
                    # date_time=row['Posting Date'],
                    date_time=datetime.strptime(row['Posting Date'], '%m/%d/%Y').replace(tzinfo=UTC),
                    description=row['Description'],
                    # category=row['Type'],
                    currency_out=out_currency,
                    amount_out=amount,
                    usd_value=amount,
                )
                print(tax_event)
            elif row['Type'] in INCOME_TYPES:
                in_currency_code = 'USD'
                in_currency = Currency.objects.get(code=in_currency_code)

                amount = abs(row['Amount'])

                tax_event, _ = TaxEvent.objects.get_or_create(
                    date_time=datetime.strptime(row['Posting Date'], '%m/%d/%Y').replace(tzinfo=UTC),
                    description=row['Description'],
                    currency_in=in_currency,
                    amount_in=amount,
                    usd_value=amount,
                )
                print(tax_event)

            elif row['Type'] == 'MISC_CREDIT':
                pass

            else:
                raise ValueError(f"Unknown type: {row['Type']}")
