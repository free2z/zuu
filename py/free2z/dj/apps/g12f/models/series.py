"""
A Series is an ordered collection of zPages.
"""

from django.db import models
from dj.apps.g12f.models import zPage, Creator
import uuid


class Series(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    pages = models.ManyToManyField(zPage, through='PageOrder')
    creator = models.ForeignKey(Creator, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = "Series'"

    def __str__(self):
        return self.name


class PageOrder(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    page = models.ForeignKey(zPage, on_delete=models.CASCADE)
    series = models.ForeignKey(Series, on_delete=models.CASCADE)
    order = models.PositiveIntegerField()

    class Meta:
        ordering = ['order']
        constraints = [
            # A Series is an *ordered list* of zPages; the same page appearing
            # in it twice is meaningless data, and it is what made
            # `GET /api/g12f/zpage/<addr>/series/` raise
            # MultipleObjectsReturned -> 500: the reverse-relation JOIN
            # emitted one row per PageOrder, so a single Series came back
            # twice. `.distinct()` in the view hid the symptom; this removes
            # the state.
            #
            # NOTE: deliberately NOT `unique(page)`. A global
            # one-series-per-page constraint cannot be satisfied without
            # deleting PageOrder rows out of *other creators'* series, and a
            # creator may never modify another creator's series. The stronger
            # invariant we actually want -- one series per creator per page --
            # spans a join (`series__creator`) and is therefore not expressible
            # as a UniqueConstraint; it is enforced in SeriesEditSerializer,
            # which detaches only within the acting creator's own series.
            models.UniqueConstraint(
                fields=['series', 'page'],
                name='g12f_pageorder_unique_series_page',
            ),
        ]

    def __str__(self):
        return f"{self.page} in {self.series} at position {self.order}"
