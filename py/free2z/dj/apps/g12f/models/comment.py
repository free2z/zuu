from django.db import models


class PageComment(models.Model):
    """
    An onchain comment cached in the database
    """
    created_at = models.DateTimeField(auto_now_add=True)
    zpage = models.ForeignKey(
        'g12f.zPage', on_delete=models.PROTECT,
        related_name="comments")
    tx = models.ForeignKey('g12f.Transaction', on_delete=models.PROTECT)
    comment = models.TextField(max_length=256)

    class Meta:
        ordering = ['-tx__amount', '-created_at']

    def __str__(self) -> str:
        return f"{self.zpage.title} - {self.tx.txid}"
