from django.db import models


class ViewedTransaction(models.Model):
    """
    Viewed transactions for zPage
    """
    txid = models.CharField(max_length=64, default="", unique=True)

    # for now, always tied to a zPage
    zpage = models.ForeignKey(
        'g12f.zPage', blank=True, null=True,
        on_delete=models.CASCADE,
        related_name="viewedtxs",
    )

    # These are theoretically redundant; but, what about someone
    # changing the address/viewing_key after starting the campaign/poll?
    # that validation on frontend and API is kinda' a lot of work.
    # So, this way we can maybe just record the inconsistency and
    # invalidate or something?
    viewing_key = models.CharField(max_length=512, blank=True)
    address = models.CharField(max_length=128, blank=True)

    amount = models.DecimalField(decimal_places=8, max_digits=11, null=True)
    memo = models.TextField(max_length=255, blank=True)
    block_height = models.IntegerField(default=0, null=True)
    # datetime.fromtimestamp(1646783796) to get datetime.datetime
    block_time = models.IntegerField(default=0, null=True)

    class Meta:
        ordering = ['-block_height']

    def __str__(self):
        return f"{self.amount} - {self.zpage}"
