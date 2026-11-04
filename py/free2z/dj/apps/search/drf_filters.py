import array
import hashlib
import math
import os
from django.contrib.contenttypes.models import ContentType
from django.db import models
from django.db.models import Subquery, OuterRef, FloatField, F, Value
from django.db.models.functions import Coalesce, Exp, Greatest
from pgvector.django import CosineDistance
from rest_framework import filters
from rest_framework.settings import api_settings
from django.contrib.postgres.search import SearchVector, SearchQuery, SearchRank
import logging

import openai
from django.conf import settings
from django.core.cache import cache

from dj.free2z.throttling import (
    CACHE_FAILURE_EXCEPTIONS,
    SearchEmbeddingAdmission,
    _raised_inside_the_cache,
)

from .helpers import EMBEDDING_MODEL, get_openai_client, reporting_retired_model
from .models import SearchIndex

logger = logging.getLogger(__name__)


def normalize_search_query(raw):
    """The query as it is embedded and full-text searched.

    NULs removed (Postgres rejects them), whitespace runs collapsed, and the
    result cut to ``settings.SEARCH_QUERY_MAX_CHARS``. Whitespace-only input
    normalizes to the empty string.
    """
    text = " ".join(raw.replace("\x00", "").split())
    return text[:settings.SEARCH_QUERY_MAX_CHARS].rstrip()


def _query_embedding_cache_key(query):
    digest = hashlib.sha256(
        f"{EMBEDDING_MODEL}\x00{query}".encode()
    ).hexdigest()
    return f"search-query-embedding:v1:{digest}"


def _cache_call(operation):
    """Run one cache operation; a counter-store fault reads as a miss."""
    try:
        return operation()
    except Exception as exc:
        if isinstance(exc, CACHE_FAILURE_EXCEPTIONS) or _raised_inside_the_cache(exc):
            return None
        raise


def cached_query_embedding(query):
    """The cached embedding for ``query`` (model-scoped), or None."""
    if settings.SEARCH_QUERY_EMBEDDING_CACHE_SECONDS <= 0:
        return None
    stored = _cache_call(lambda: cache.get(_query_embedding_cache_key(query)))
    if not isinstance(stored, bytes) or not stored or len(stored) % 4:
        return None
    return array.array("f", stored).tolist()


def store_query_embedding(query, vector):
    """Cache ``vector`` as float32 bytes -- the precision pgvector stores."""
    if settings.SEARCH_QUERY_EMBEDDING_CACHE_SECONDS <= 0:
        return
    payload = array.array("f", vector).tobytes()
    _cache_call(lambda: cache.set(
        _query_embedding_cache_key(query),
        payload,
        timeout=settings.SEARCH_QUERY_EMBEDDING_CACHE_SECONDS,
    ))


def query_embedding_client():
    """The indexing client, re-bound to a WEB-request budget.

    Embedding one search query is normally well under a second. (connect
    3.05s, read SEARCH_QUERY_EMBED_TIMEOUT_SECONDS) and no SDK retry: the
    fallback on failure is full-text search, which is a better answer to a
    slow provider than a second wait.
    """
    return get_openai_client().with_options(
        timeout=openai.Timeout(
            settings.SEARCH_QUERY_EMBED_TIMEOUT_SECONDS, connect=3.05,
        ),
        max_retries=0,
    )


SEARCH_RECENCY_HALF_LIFE_DAYS = 45.0
# Keep the maximum additive freshness advantage below the meaningful relevance
# gap. Relevance remains the primary sort key without a discontinuous band.
SEARCH_RECENCY_WEIGHT = 0.04
SEARCH_RELEVANCE_TIE_WIDTH = 0.05


class AgeInDays(models.Func):
    """Age of a datetime field, in days, as a float (Postgres)."""

    template = "EXTRACT(EPOCH FROM (NOW() - %(expressions)s)) / 86400.0"
    output_field = FloatField()


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
        are ranked using `SearchRank` and ordered by a relevance score with a
        bounded freshness boost.

    Rationale:
      - Avoids 500 errors / external costs in local development without a key.
      - Provides reasonable text search without embeddings.

    Bounds on the semantic path (it runs inside a public, anonymous-readable
    request): the query is normalized and capped at
    ``SEARCH_QUERY_MAX_CHARS``; its embedding is cached for
    ``SEARCH_QUERY_EMBEDDING_CACHE_SECONDS``; and a cache miss must pass
    ``SearchEmbeddingAdmission`` (per caller and fleet-wide budgets) or the
    request is answered from full text. This also applies to a detail read
    carrying ``?search=``, since ``get_object`` runs the filter backends.

    To tune:
      - Add weights: e.g. `SearchVector('title', weight='A') + SearchVector('content', weight='B')`.
      - Add a GIN index for performance (suggested):
          CREATE INDEX CONCURRENTLY IF NOT EXISTS zpage_searchvec_idx
          ON dj_apps_g12f_zpage USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')));
      - Adjust `max_score` if embedding distance distribution changes.

    Freshness is based on the zPage title/body content signal, not the
    reader-facing ``updated_at`` activity timestamp. The boost is bounded and
    additive: a page can receive at most 0.04 relevance points
    when its searchable content changed just now, and the boost decays by half
    every 45 days. The maximum boost is below the 0.05-point meaningful
    relevance gap, so freshness can break near-ties but cannot overcome it.
    """
    search_param = api_settings.SEARCH_PARAM
    # lower score is more similar
    max_score = 0.8
    recency_half_life_days = SEARCH_RECENCY_HALF_LIFE_DAYS
    recency_weight = SEARCH_RECENCY_WEIGHT
    relevance_tie_width = SEARCH_RELEVANCE_TIE_WIDTH

    @classmethod
    def _freshness_boost(cls, content_age=None):
        """Return a bounded additive boost for a page's content age."""
        if content_age is None:
            content_age = Coalesce(
                F("searchable_content_updated_at"),
                F("created_at"),
            )
        age_in_days = Greatest(
            Value(0.0),
            AgeInDays(content_age),
        )
        freshness = Exp(
            Value(-math.log(2) / cls.recency_half_life_days) * age_in_days
        )
        return Value(cls.recency_weight) * freshness

    @classmethod
    def _blended_score(cls, relevance, content_age=None):
        return models.ExpressionWrapper(
            relevance + cls._freshness_boost(content_age),
            output_field=FloatField(),
        )

    def filter_queryset(self, request, queryset, view):
        raw = request.query_params.get(self.search_param, '')
        if not raw.replace('\x00', ''):
            return queryset
        query = normalize_search_query(raw)
        if not query:
            # Whitespace only: there is nothing to search for, and nothing
            # worth a provider call.
            return queryset.none()

        # If no OpenAI API key, use PostgreSQL full text search
        if not os.getenv('OPENAI_API_KEY'):
            return self._full_text(queryset, query)

        # A repeated query (the next page of results, the same search again,
        # an SSR render and the browser's own fetch) reuses its embedding and
        # spends neither a provider call nor an admission unit.
        query_vector = cached_query_embedding(query)
        if query_vector is not None:
            return self._semantic(queryset, query_vector)

        # A fresh query is a paid provider call made while holding this
        # pod's worker. Admission bounds it per caller and fleet-wide; past
        # either budget the search is answered from full text, never a 429.
        if SearchEmbeddingAdmission().refusal(request) is not None:
            return self._full_text(queryset, query)

        # Vector (semantic) path. This runs INSIDE a web request, on a pod
        # with one sync gunicorn worker, so the embedding call is
        # bounded tightly  -- it used to go through the SDK's implicit
        # module-level client at 600s x 3 attempts -- and a provider that is
        # slow or down degrades search to full text instead of failing it.
        try:
            # Same model as the stored vectors, by construction: a query
            # embedded in another model's space ranks nonsense.
            # A retired model is reported (ai_model_unavailable) and still
            # degrades to full text below.
            with reporting_retired_model(
                EMBEDDING_MODEL,
                "search query embedding",
                "Not a ConfigMap change: the query and every stored "
                "SearchIndex vector must move to a new embedding model "
                "together (EMBEDDING_MODEL in dj/apps/search/helpers.py, "
                "then a full re-embed).",
            ):
                response = query_embedding_client().embeddings.create(
                    input=[query],
                    model=EMBEDDING_MODEL,
                )
            query_vector = response.data[0].embedding
        except openai.OpenAIError as exc:
            logger.warning(
                "search_query_embedding_unavailable: %s; using full text",
                type(exc).__name__,
            )
            return self._full_text(queryset, query)
        store_query_embedding(query, query_vector)
        return self._semantic(queryset, query_vector)

    def _full_text(self, queryset, query):
        search_query = SearchQuery(query)
        search_vector = (
            SearchVector('title', weight='A')
            + SearchVector('content', weight='B')
        )
        queryset = queryset.annotate(
            search_vector=search_vector
        ).annotate(
            # Pass the expression, not its annotation name. Passing the
            # name makes Django re-tokenize the rendered tsvector text,
            # flattening rank to the same value for every matching row.
            rank=SearchRank(search_vector, search_query),
        ).filter(
            search_vector=search_query
        ).annotate(
            search_score=self._blended_score(F('rank')),
        ).order_by(
            '-search_score', '-rank', '-pk'
        )
        return queryset

    def _semantic(self, queryset, query_vector):
        content_type = ContentType.objects.get_for_model(queryset.model)
        search_results = SearchIndex.objects.filter(
            content_type=content_type,
            object_id=OuterRef('pk')
        ).annotate(
            similarity=CosineDistance('vector', query_vector)
        )
        eligible_results = search_results.filter(similarity__lte=self.max_score)
        search_score = search_results.annotate(
            search_score=self._blended_score(
                Value(1.0) - F('similarity'),
                content_age=Coalesce(
                    OuterRef('searchable_content_updated_at'),
                    OuterRef('created_at'),
                ),
            )
        ).values('search_score')[:1]

        # Keep eligibility and ranking in separate scalar subqueries. Reusing
        # an annotation on the outer queryset makes Django inline the
        # correlated pgvector distance once for every derived sort key.
        queryset = queryset.filter(
            models.Exists(eligible_results)
        ).annotate(
            search_score=Subquery(search_score, output_field=FloatField())
        ).order_by('-search_score', '-pk')
        return queryset
