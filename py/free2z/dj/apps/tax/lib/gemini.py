from datetime import datetime

import pandas as pd
import requests

from dj.apps.tax.models import TaxEvent, Currency

def get_zec_price_on_date(date_str):
    date_obj = datetime.strptime(date_str, '%Y-%m-%d %H:%M:%S.%f')
    formatted_date = date_obj.strftime('%d-%m-%Y')

    # CoinGecko API endpoint for historical data
    url = f'https://api.coingecko.com/api/v3/coins/zcash/history?date={formatted_date}&localization=false'
    # Bounded. An operator-run ingest, not a web path, but `requests`
    # has no default timeout and a stalled CoinGecko would hang it silently.
    response = requests.get(url, timeout=(3.05, 15))
    data = response.json()

    # Accessing the price in USD
    price = data['market_data']['current_price']['usd']
    return price


class GeminiCSV(object):
    def __init__(self, path):
        self.path = path

    def ingest(self):
        print("Ingesting from {}".format(self.path))
        # Take the Sell and the Buy rows and create a TaxEvent
        df = pd.read_csv(self.path)
        for i, row in df.iterrows():
            # IDK what a BUY actually look like
            # I don't think we want to BUY on Gemini, this CSV is not great
            # Maybe Coinbase or Binance once we get these books sorted
            # For now, every trade is a SELL to USD
            if row['Type'] == 'Sell':
                # print(row)
                out_currency_code = row['Symbol'][:3]
                in_currency_code = row['Symbol'][3:]
                out_currency = Currency.objects.get(code=out_currency_code)
                in_currency = Currency.objects.get(code=in_currency_code)

                amount = row['USD Amount USD'] + row['Fee (USD) USD']

                tax_event, created = TaxEvent.objects.get_or_create(
                    unique_id=row['Trade ID'],
                    date_time=row['Date'],
                    description=f"Gemini {row['Type']} {row['Symbol']}",
                    currency_in=in_currency,
                    amount_in=amount,
                    currency_out=out_currency,
                    amount_out=abs(row[f'{out_currency_code} Amount {out_currency_code}']),
                    # this CSV kinda sucks. Not sure now ZECBTC would behave for example.
                    # let's get over this hump and then get off Gemini
                    usd_value=amount,
                )
                # print(tax_event)

            if row['Type'] == 'Debit' and row['Symbol'] == 'ZEC':
                # print(row)
                out_currency = Currency.objects.get(code='ZEC')
                amount = abs(row['ZEC Amount ZEC'])
                date = row['Date']
                # get ZEC price for this exact datetime
                price = get_zec_price_on_date(date)
                usd_value = amount * price

                # won't run twice, uuid is generated
                tax_event, created = TaxEvent.objects.get_or_create(
                    date_time=date,
                    description=f"Gemini {row['Type']} {row['Symbol']}",
                    currency_out=out_currency,
                    amount_out=amount,
                    usd_value=usd_value,
                )
                print(tax_event)
                import time; time.sleep(15)
