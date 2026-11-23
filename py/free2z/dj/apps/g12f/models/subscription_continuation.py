"""Non-financial audit of membership terms granted after funding refusal."""
from django.db import models
from django.db.models import F, Q
from django.utils import timezone


class SubscriptionContinuation(models.Model):
    subscription = models.ForeignKey(
        "g12f.Subscription", on_delete=models.CASCADE,
        related_name="zero_charge_continuations",
    )
    period_start = models.DateTimeField()
    period_end = models.DateTimeField()
    recorded_at = models.DateTimeField(default=timezone.now)
    reason = models.CharField(
        max_length=40, default="usage_daily_funding_limit", editable=False,
    )
    # These are the refused price and existing consent, never amounts owed.
    refused_price = models.DecimalField(max_digits=7, decimal_places=0)
    recurring_ceiling = models.DecimalField(max_digits=7, decimal_places=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["subscription", "period_start"],
                name="g12f_continuation_cycle_uniq",
            ),
            models.CheckConstraint(
                condition=Q(period_end__gt=F("period_start")),
                name="g12f_continuation_positive_term",
            ),
            models.CheckConstraint(
                condition=Q(
                    reason="usage_daily_funding_limit", refused_price__gt=0,
                    recurring_ceiling__gte=F("refused_price"),
                ),
                name="g12f_continuation_valid_refusal",
            ),
        ]
