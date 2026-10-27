import uuid

from django.db import models
from django.db.models import Sum
from django.utils.timezone import now

from .constants import CATEGORY_CHOICES, FIAT


class Currency(models.Model):
    code = models.CharField(max_length=10, primary_key=True)

    class Meta:
        verbose_name_plural = "currencies"
        ordering = ["code"]

    def __str__(self):
        return self.code

    @property
    def is_crypto(self):
        return self.code not in FIAT


class CostBasis(models.Model):
    currency = models.OneToOneField(Currency, on_delete=models.CASCADE)
    quantity = models.DecimalField(max_digits=19, decimal_places=8, default=0)
    total_cost = models.DecimalField(max_digits=19, decimal_places=2, default=0)
    last_updated = models.DateTimeField(
        null=True, blank=True, help_text="Last time the cost basis was updated"
    )

    class Meta:
        verbose_name_plural = "cost bases"
        ordering = ["currency"]

    def __str__(self):
        return f"{self.currency}"

    def reset(self):
        self.quantity = 0
        self.total_cost = 0
        self.last_updated = None
        self.save()

    @property
    def average_cost_basis(self):
        if self.quantity != 0:
            return self.total_cost / self.quantity
        raise ZeroDivisionError("Quantity is 0")


class TaxEvent(models.Model):
    unique_id = models.CharField(max_length=100, unique=True, default=uuid.uuid4)
    date_time = models.DateTimeField(default=now)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=12, choices=CATEGORY_CHOICES, blank=True)

    currency_out = models.ForeignKey(
        Currency, related_name='out_events', on_delete=models.CASCADE, null=True, blank=True)
    amount_out = models.DecimalField(
        max_digits=19, decimal_places=8, null=True, blank=True)
    currency_in = models.ForeignKey(
        Currency, related_name='in_events', on_delete=models.CASCADE, null=True, blank=True)
    amount_in = models.DecimalField(
        max_digits=19, decimal_places=8, null=True, blank=True)
    usd_value = models.DecimalField(
        max_digits=19, decimal_places=2)

    # These are calculated and cached
    type = models.CharField(max_length=10, editable=False, blank=True)
    gain_loss = models.DecimalField(
        max_digits=19, decimal_places=2, null=True, blank=True, editable=False)

    class Meta:
        ordering = ["-date_time"]

    def __str__(self):
        currency_out_str = f"{self.amount_out} {self.currency_out.code}" if self.currency_out and self.amount_out is not None else "N/A"
        currency_in_str = f"{self.amount_in} {self.currency_in.code}" if self.currency_in and self.amount_in is not None else "N/A"
        return f"{self.get_type()} on {self.date_time}: {currency_out_str} for {currency_in_str}"

    def get_type(self):
        """
        Cache the type of the event.
        """
        if self.type:
            return self.type
        if self.currency_out and self.currency_in:
            t = "Trade"
        elif self.currency_out:
            t = "Expense"
        elif self.currency_in:
            t = "Income"
        self.type = t
        self.save()
        return t

    @staticmethod
    def total_income(start_date=None, end_date=None):
        """Calculate total income by summing the usd_value of events with currency_in and no currency_out."""
        income_events = TaxEvent.get_filtered_events(start_date, end_date).filter(
            currency_in__isnull=False,
            currency_out__isnull=True,
        )
        total = income_events.aggregate(Sum('usd_value'))['usd_value__sum'] or 0
        return total

    @staticmethod
    def total_expense(start_date=None, end_date=None):
        """Calculate total expenses by summing the usd_value of events with currency_out and no currency_in."""
        expense_events = TaxEvent.get_filtered_events(start_date, end_date).filter(
            currency_in__isnull=True,
            currency_out__isnull=False,
        )
        total = expense_events.aggregate(Sum('usd_value'))['usd_value__sum'] or 0
        return total

    @staticmethod
    def total_gain_loss(start_date=None, end_date=None):
        """Calculate total gain/loss by summing the gain_loss of all events."""
        # TODO: if we know we have everything cached, we sum the gain_loss field
        gain_loss_events = TaxEvent.get_filtered_events(start_date, end_date)
        return gain_loss_events.aggregate(Sum('gain_loss'))['gain_loss__sum'] or 0

    def add_gain_loss_and_update_cost_bases(self):
        if self.currency_in and self.currency_in.code not in FIAT:
            cb_in = CostBasis.objects.get(currency=self.currency_in)
            if cb_in.last_updated and cb_in.last_updated > self.date_time:
                raise ValueError("Cost basis is already updated after this event")
            cb_in.quantity += self.amount_in
            cb_in.total_cost += self.usd_value
            cb_in.last_updated = self.date_time
            cb_in.save()

        if self.currency_out and self.currency_out.code not in FIAT:
            cb_out = CostBasis.objects.get(currency=self.currency_out)
            if cb_out.last_updated and cb_out.last_updated > self.date_time:
                raise ValueError("Cost basis is already updated after this event")
            current_cost_basis = cb_out.average_cost_basis
            cb_out.quantity -= self.amount_out
            cb_out.total_cost -= self.amount_out * current_cost_basis
            cb_out.last_updated = self.date_time
            self.gain_loss = self.usd_value - (self.amount_out * current_cost_basis)
            cb_out.save()
            self.save()

    @staticmethod
    def add_new_gain_loss_and_update_cost_bases():
        """
        Run after importing new events to add gain/loss and update cost basis.

        This uses an average cost basis method
        """
        # Get the most recent CostBasis.last_updated
        last_updated = CostBasis.objects.all().order_by('last_updated').last().last_updated
        # Get all events after the most recent CostBasis.last_updated
        events = TaxEvent.objects.filter(date_time__gt=last_updated).order_by('date_time')
        for event in events:
            event.add_gain_loss_and_update_cost_bases()

    @staticmethod
    def add_gain_loss_to_all_events():
        """Bootstrap gain/loss for all events and update cost basis"""
        for event in TaxEvent.objects.all().order_by('date_time'):
            event.add_gain_loss_and_update_cost_bases()

    @staticmethod
    def get_asset_status(currency_code):
        # Aggregate the total quantity acquired and total USD spent for acquisitions
        acquisitions = TaxEvent.objects.filter(currency_in__code=currency_code).aggregate(
            total_acquired=Sum('amount_in'),
            total_usd_spent=Sum('usd_value')
        )

        # Aggregate the total quantity disposed
        dispositions = TaxEvent.objects.filter(currency_out__code=currency_code).aggregate(
            total_disposed=Sum('amount_out'),
        )

        # Calculate net quantity and net USD spent
        total_acquired = acquisitions['total_acquired'] or 0
        total_usd_spent = acquisitions['total_usd_spent'] or 0
        total_disposed = dispositions['total_disposed'] or 0
        net_quantity = total_acquired - total_disposed

        average_cost_basis = CostBasis.objects.get(currency=currency_code).average_cost_basis

        return {
            'currency_code': currency_code,
            'total_acquired': total_acquired,
            'total_usd_spent': total_usd_spent,
            'total_disposed': total_disposed,
            'net_quantity': round(net_quantity, 8),
            'average_cost_basis': round(average_cost_basis, 2),
        }

    @staticmethod
    def get_filtered_events(start_date=None, end_date=None):
        events = TaxEvent.objects.all()
        if start_date:
            events = events.filter(date_time__gte=start_date)
        if end_date:
            events = events.filter(date_time__lte=end_date)
        return events
