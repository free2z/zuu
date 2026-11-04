

from django.db import models


class Poll(models.Model):
    """
    Starting as a 1to1 with zPage but possibly stand-alone.

    viewing_key is redundant/cached with zPage
    """
    created_at = models.DateTimeField(auto_now_add=True)
    question = models.CharField(max_length=255, blank=True)
    option1 = models.CharField(max_length=64, blank=True)
    option2 = models.CharField(max_length=64, blank=True)
    option3 = models.CharField(max_length=64, blank=True)
    option4 = models.CharField(max_length=64, blank=True)
    option5 = models.CharField(max_length=64, blank=True)
    # https://forum.zcashcommunity.com/t/zcash-regexes/41381
    viewing_key = models.CharField(max_length=512, blank=True)

    # Cache the number of votes
    option1_votes = models.IntegerField(null=True, default=0, blank=True)
    option2_votes = models.IntegerField(null=True, default=0, blank=True)
    option3_votes = models.IntegerField(null=True, default=0, blank=True)
    option4_votes = models.IntegerField(null=True, default=0, blank=True)
    option5_votes = models.IntegerField(null=True, default=0, blank=True)

    # Cache the amounts
    option1_total = models.DecimalField(
        max_digits=11, decimal_places=8, default=0, blank=True, null=True)
    option2_total = models.DecimalField(
        max_digits=11, decimal_places=8, default=0, blank=True, null=True)
    option3_total = models.DecimalField(
        max_digits=11, decimal_places=8, default=0, blank=True, null=True)
    option4_total = models.DecimalField(
        max_digits=11, decimal_places=8, default=0, blank=True, null=True)
    option5_total = models.DecimalField(
        max_digits=11, decimal_places=8, default=0, blank=True, null=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self) -> str:
        return self.question
