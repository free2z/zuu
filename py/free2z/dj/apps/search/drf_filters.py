import os
from django.contrib.contenttypes.models import ContentType
from django.db.models import Subquery, OuterRef, FloatField
from django.db.models.functions import Coalesce
from pgvector.django import CosineDistance
from rest_framework import filters
from rest_framework.settings import api_settings
from django.contrib.postgres.search import SearchVector, SearchQuery, SearchRank
import openai

from .models import SearchIndex


class VectorSearchFilter(filters.BaseFilterBackend):
    """Hybrid search filter: semantic (OpenAI + pgvector) or plain Postgres FTS.

    Behavior:
      * If an environment variable `OPENAI_API_KEY` is present, perform semantic
        similarity ranking:
          1. Generate an embedding for the user query with OpenAI (model: text-embedding-3-small).
          2. Use pgvector's CosineDistance against stored embeddings in `SearchIndex`.
          3. Filter by a max similarity threshold (`max_score`). Lower distance = closer match.

      * If `OPENAI_API_KEY` is NOT set, fall back to PostgreSQL full text search over
        the `title` and `content` fields (adjust fields here if model changes). Results
        are ranked using `SearchRank` and ordered by descending rank.

    Rationale:
      - Avoids 500 errors / external costs in local development without a key.
      - Provides reasonable text search without embeddings.

    To tune:
      - Add weights: e.g. `SearchVector('title', weight='A') + SearchVector('content', weight='B')`.
      - Add a GIN index for performance (suggested):
          CREATE INDEX CONCURRENTLY IF NOT EXISTS zpage_searchvec_idx
          ON dj_apps_g12f_zpage USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')));
      - Adjust `max_score` if embedding distance distribution changes.

    NOTE: This class intentionally keeps logic minimal; higher-level toggles or
    caching can be layered later if needed.
    """
    search_param = api_settings.SEARCH_PARAM
    # lower score is more similar
    max_score = 0.8

    def filter_queryset(self, request, queryset, view):
        query = request.query_params.get(self.search_param, '').replace('\x00', '')
        if not query:
            return queryset

        # If no OpenAI API key, use PostgreSQL full text search
        if not os.getenv('OPENAI_API_KEY'):
            search_query = SearchQuery(query)
            queryset = queryset.annotate(
                search_vector=SearchVector('title', 'content')
            ).annotate(
                rank=SearchRank('search_vector', search_query)
            ).filter(
                search_vector=search_query
            ).order_by('-rank')
            return queryset

        # Vector (semantic) path
        response = openai.embeddings.create(
            input=[query],
            model="text-embedding-3-small",
        )
        query_vector = response.data[0].embedding

        content_type = ContentType.objects.get_for_model(queryset.model)
        search_results = SearchIndex.objects.filter(
            content_type=content_type,
            object_id=OuterRef('pk')
        ).annotate(
            similarity=CosineDistance('vector', query_vector)
        ).values('similarity')

        queryset = queryset.annotate(
            similarity=Coalesce(Subquery(search_results, output_field=FloatField()), 1.0)
        ).filter(
            similarity__lte=self.max_score
        ).order_by('similarity')
        return queryset
