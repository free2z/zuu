from django.db import models
from pgvector.django import VectorField, HnswIndex

from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from pydantic import BaseModel
from typing import List


class SearchIndex(models.Model):
    content_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    object_id = models.PositiveIntegerField()
    content_object = GenericForeignKey('content_type', 'object_id')
    vector = VectorField(
        dimensions=1536,
        help_text='The vector representation of the object'
    )

    # Classic problem for the future if we try to add eg Comment model
    # object_id = models.PositiveIntegerField(null=True, blank=True)
    # uuid_object_id = models.UUIDField(null=True, blank=True)
    # content_object = GenericForeignKey(ct_field='content_type', fk_field='object_id')
    # uuid_content_object = GenericForeignKey(ct_field='content_type', fk_field='uuid_object_id')

    class Meta:
        unique_together = ('content_type', 'object_id')
        indexes = [
            # `vector_cosine_ops`, NOT `vector_l2_ops`.
            #
            # Every reader of this column sorts by `CosineDistance` (the `<=>`
            # operator): the `/related/` endpoint and `VectorSearchFilter`
            # both do. An HNSW index built for `vector_l2_ops` answers `<->`
            # and nothing else, so the planner could not use it for a single
            # query we actually run -- `/related/` sequentially scanned all
            # ~3.9k published zPages, computing one 1536-dimension cosine per
            # row, on every article view.
            #
            # OpenAI's text-embedding-3-small returns unit vectors, for which
            # L2 and cosine rank identically (||a-b||^2 == 2 - 2*cos for unit
            # a, b). So this is not a change of ranking semantics -- it is the
            # operator class that lets the planner see that. Keeping the L2
            # index alongside would cost a second HNSW structure (31MB at 4k
            # rows) and write amplification on every re-index, for a query
            # nobody makes.
            #
            # The name changed with the operator class (was
            # `searchindex_vector_hnsw_idx`) so the replacement can be built
            # BEFORE the old one is dropped -- see 0002 for why that ordering
            # is what keeps the endpoint answering during the deploy.
            HnswIndex(
                name='searchindex_vector_cos_idx',
                fields=['vector'],
                m=16,
                ef_construction=64,
                opclasses=['vector_cosine_ops']
            )
        ]

    def __str__(self) -> str:
        return f'{self.content_object}'


class PageContext(BaseModel):
    title: str
    content: str
    author: str
    tags: List[str]


class Summary(BaseModel):
    text: str
