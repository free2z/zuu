from decimal import Decimal as D
from datetime import datetime
from copy import deepcopy

from django.test import TestCase
from django.utils.timezone import make_aware

from .models import Currency, TaxEvent, CostBasis


# Define a list of tax event data with chronological ordering
TAX_EVENTS = [
    # 0
    {
        "currency_in_code": "ZEC",
        "amount_in": 10,
        "usd_value": 1000,
        "date_time": "2023-01-01T00:00:00",
        "description": "Income in ZEC - $100 each"
    },
    # 1
    {
        "currency_out_code": "ZEC",
        "amount_out": 5,
        "currency_in_code": "USD",
        "amount_in": 600,
        "usd_value": 600,
        "date_time": "2023-02-01T00:00:00",
        "description": "Sell ZEC for USD with gain, $100 gain"
    },
    # 2
    {
        "currency_out_code": "ZEC",
        "amount_out": 2,
        "currency_in_code": "USD",
        "amount_in": 150,
        "usd_value": 150,
        "date_time": "2023-03-01T00:00:00",
        "description": "Sell ZEC for USD with loss, $50 loss"
    },
    # 3
    {
        "currency_in_code": "ZEC",
        "amount_in": 10,
        "usd_value": 2000,
        "date_time": "2023-04-01T00:00:00",
        "description": "Income in ZEC - $200 each"
    },
    # 4
    {
        "currency_out_code": "ZEC",
        "amount_out": 2,
        "currency_in_code": "USD",
        "amount_in": 400,
        "usd_value": 400,
        "date_time": "2023-05-01T00:00:00",
        "description": "Sell ZEC for USD with gain"
    },
    # 5 - One more income event that will change the average basis
    {
        "currency_in_code": "ZEC",
        "amount_in": 10,
        "usd_value": 3000,
        "date_time": "2023-06-01T00:00:00",
        "description": "Income in ZEC - $300 each"
    },
    # 6 - Expense in ZEC
    {
        "currency_out_code": "ZEC",
        "amount_out": 1,
        "usd_value": 100,
        "date_time": "2023-07-01T00:00:00",
        "description": "Expense in ZEC - $100 expense and $135.53 loss",
    },
]


class GainLossCalculationTest(TestCase):
    def setUp(self):
        self.currencies = {}
        events = deepcopy(TAX_EVENTS)
        for event in events:
            # Ensure correct currency instances are used or created
            for code_key in ['currency_in_code', 'currency_out_code']:
                code = event.get(code_key)
                if code and code not in self.currencies:
                    self.currencies[code] = Currency.objects.create(code=code)

            # Assign currency instances to the event dictionary
            if 'currency_in_code' in event:
                event['currency_in'] = self.currencies[event.pop('currency_in_code')]
            if 'currency_out_code' in event:
                event['currency_out'] = self.currencies[event.pop('currency_out_code')]

            # Convert date_time string to datetime object and make it timezone aware
            event['date_time'] = make_aware(datetime.fromisoformat(event.pop('date_time')))

            TaxEvent.objects.create(**event)

        # Ensure a CostBasis instance is created for ZEC
        CostBasis.objects.create(currency=self.currencies['ZEC'])

        # Apply gain/loss calculations after all TaxEvents have been created
        TaxEvent.add_gain_loss_to_all_events()

        # Refresh the list of all TaxEvents for use in tests
        self.tax_events = list(TaxEvent.objects.order_by('date_time'))


    def test_gain_loss_calculation(self):
        # Check gain for sell_zec_for_usd_gain event
        gain_for_sell_gain_event = self.tax_events[1].gain_loss
        print("1a", gain_for_sell_gain_event)
        self.assertAlmostEquals(gain_for_sell_gain_event, D(100), 2, "Gain should be $100 for a profitable sell.")

        # Check loss for sell_zec_for_usd_loss event
        loss_for_sell_loss_event = self.tax_events[2].gain_loss
        print("2a", loss_for_sell_loss_event)
        self.assertAlmostEquals(loss_for_sell_loss_event, D(-50), 2, "Loss should be -$50 for a unprofitable sell.")

        # Check gain for mixed_income_trade event
        gain_for_mixed_income_trade = self.tax_events[4].gain_loss
        print("3a", gain_for_mixed_income_trade)
        self.assertAlmostEquals(gain_for_mixed_income_trade, D(46.15), 2, "Gain should be $100 for a profitable trade.")

        loss_on_mixed_income_expense = self.tax_events[6].gain_loss
        print("4a", loss_on_mixed_income_expense)
        self.assertAlmostEquals(loss_on_mixed_income_expense, D(-135.53), 2, "Loss should be -$135.53 for a unprofitable expense.")

    def test_cost_basis_calculation(self):
        # Check average cost basis for ZEC
        zec_cost_basis = CostBasis.objects.get(currency__code="ZEC")
        # ((11 * 176.9227272727272727272727273) + 3000) / 21 == 235.530952381
        print("1b", zec_cost_basis.average_cost_basis)
        # ((11 * 176.9227272727272727272727273) + 3000)
        print("2b", zec_cost_basis.total_cost)
        # 21
        print("3b", zec_cost_basis.quantity)
        self.assertAlmostEqual(
            zec_cost_basis.average_cost_basis, D(235.53),
            2, "Average cost basis should be approximately $235.53"
        )
