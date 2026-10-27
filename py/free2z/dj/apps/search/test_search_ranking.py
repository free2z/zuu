"""Search ranking regressions for freshness weighting.

These tests exercise both production ranking paths against real Postgres. The
semantic path only mocks the external embedding request; its cosine distances
and result ordering still come from pgvector.
"""

import math
import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.contrib.contenttypes.models import ContentType
from django.db.models import F
from django.utils import timezone

from dj.apps.g12f.models import zPage
from dj.apps.search.drf_filters import (
    SEARCH_RECENCY_WEIGHT,
    SEARCH_RELEVANCE_TIE_WIDTH,
    VectorSearchFilter,
)
from dj.apps.search.models import SearchIndex


def _make_page(creator, vanity, *, title, content):
    return zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=vanity,
        title=title,
        content=content,
        is_published=True,
    )


def _set_searchable_content_days_ago(page, days):
    searchable_content_updated_at = timezone.now() - timedelta(days=days)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=searchable_content_updated_at,
    )


def _vanities(response):
    return [item["vanity"] for item in response.json()["results"]]


def test_freshness_weight_is_smaller_than_the_relevance_band():
    assert SEARCH_RECENCY_WEIGHT == 0.04
    assert SEARCH_RELEVANCE_TIE_WIDTH == 0.05
    assert SEARCH_RECENCY_WEIGHT < SEARCH_RELEVANCE_TIE_WIDTH


@pytest.mark.django_db
def test_full_text_search_prefers_fresh_equal_matches(
    api_client, creator_factory, monkeypatch,
):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    author = creator_factory()
    fresh = _make_page(
        author,
        "fresh-privacy",
        title="Privacy",
        content="privacy",
    )
    stale = _make_page(
        author,
        "stale-privacy",
        title="Privacy",
        content="privacy",
    )
    _set_searchable_content_days_ago(stale, 365)
    _set_searchable_content_days_ago(fresh, 1)

    response = api_client.get("/api/zpage/?search=privacy")

    assert response.status_code == 200
    assert _vanities(response)[:2] == [fresh.vanity, stale.vanity]

    with monkeypatch.context() as disabled:
        disabled.setattr(VectorSearchFilter, "recency_weight", 0.0)
        disabled_response = api_client.get("/api/zpage/?search=privacy")

    assert _vanities(disabled_response)[:2] == [stale.vanity, fresh.vanity]


@pytest.mark.django_db
def test_full_text_search_keeps_stronger_match_ahead_of_freshness(
    api_client, creator_factory, monkeypatch,
):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    author = creator_factory()
    strong_stale = _make_page(
        author,
        "strong-stale-privacy",
        title="Privacy privacy privacy privacy",
        content="privacy privacy privacy",
    )
    weak_fresh = _make_page(
        author,
        "weak-fresh-privacy",
        title="Privacy",
        content="A guide to publishing online.",
    )
    _set_searchable_content_days_ago(strong_stale, 365)
    _set_searchable_content_days_ago(weak_fresh, 1)

    response = api_client.get("/api/zpage/?search=privacy")

    assert response.status_code == 200
    assert _vanities(response)[:2] == [strong_stale.vanity, weak_fresh.vanity]


@pytest.mark.django_db
def test_semantic_search_prefers_fresh_equal_matches(
    api_client, creator_factory, monkeypatch, mocker,
):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    author = creator_factory()
    fresh = _make_page(
        author,
        "fresh-semantic",
        title="Privacy",
        content="An article about privacy.",
    )
    stale = _make_page(
        author,
        "stale-semantic",
        title="Privacy",
        content="An article about privacy.",
    )
    vector = [0.0] * 1536
    vector[0] = 1.0
    for page in (stale, fresh):
        SearchIndex.objects.create(
            content_type=ContentType.objects.get_for_model(zPage),
            object_id=page.pk,
            vector=vector,
        )
    _set_searchable_content_days_ago(stale, 365)
    _set_searchable_content_days_ago(fresh, 1)
    embeddings = mocker.Mock(
        return_value=SimpleNamespace(
            data=[SimpleNamespace(embedding=vector)],
        ),
    )
    #the query embedding goes through the bounded client.
    mocker.patch(
        "dj.apps.search.drf_filters.query_embedding_client",
        return_value=SimpleNamespace(
            embeddings=SimpleNamespace(create=embeddings),
        ),
    )

    response = api_client.get("/api/zpage/?search=privacy")

    assert response.status_code == 200
    assert _vanities(response)[:2] == [fresh.vanity, stale.vanity]

    with monkeypatch.context() as disabled:
        disabled.setattr(VectorSearchFilter, "recency_weight", 0.0)
        disabled_response = api_client.get("/api/zpage/?search=privacy")

    assert _vanities(disabled_response)[:2] == [stale.vanity, fresh.vanity]
    assert embeddings.call_count == 2


@pytest.mark.django_db
def test_semantic_search_keeps_stronger_match_ahead_of_freshness(
    api_client, creator_factory, monkeypatch, mocker,
):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    author = creator_factory()
    strong_stale = _make_page(
        author,
        "strong-stale-semantic",
        title="Privacy",
        content="An article about privacy.",
    )
    weak_fresh = _make_page(
        author,
        "weak-fresh-semantic",
        title="Privacy",
        content="A guide to publishing online.",
    )
    query_vector = [0.0] * 1536
    query_vector[0] = 1.0
    # Raw relevance is approximately.749 vs.701. The fresh page's former
    # 25% boost would reverse these results, while the bounded.04-point boost
    # remains below the meaningful relevance gap.
    strong_vector = [0.0] * 1536
    strong_vector[0] = 0.749
    strong_vector[1] = math.sqrt(1 - 0.749 ** 2)
    weak_vector = [0.0] * 1536
    weak_vector[0] = 0.701
    weak_vector[1] = math.sqrt(1 - 0.701 ** 2)
    content_type = ContentType.objects.get_for_model(zPage)
    SearchIndex.objects.create(
        content_type=content_type,
        object_id=strong_stale.pk,
        vector=strong_vector,
    )
    SearchIndex.objects.create(
        content_type=content_type,
        object_id=weak_fresh.pk,
        vector=weak_vector,
    )
    _set_searchable_content_days_ago(strong_stale, 365)
    _set_searchable_content_days_ago(weak_fresh, 1)
    embeddings = mocker.Mock(
        return_value=SimpleNamespace(
            data=[SimpleNamespace(embedding=query_vector)],
        ),
    )
    mocker.patch(
        "dj.apps.search.drf_filters.query_embedding_client",
        return_value=SimpleNamespace(
            embeddings=SimpleNamespace(create=embeddings),
        ),
    )

    response = api_client.get("/api/zpage/?search=privacy")

    assert response.status_code == 200
    assert _vanities(response)[:2] == [strong_stale.vanity, weak_fresh.vanity]
    embeddings.assert_called_once()

    # The in-band control is deliberately freshness-sensitive: a boost equal
    # to the relevance-gap contract is large enough to reverse this pair.
    with monkeypatch.context() as too_large:
        too_large.setattr(
            VectorSearchFilter,
            "recency_weight",
            SEARCH_RELEVANCE_TIE_WIDTH,
        )
        too_large_response = api_client.get("/api/zpage/?search=privacy")

    assert _vanities(too_large_response)[:2] == [
        weak_fresh.vanity,
        strong_stale.vanity,
    ]


@pytest.mark.django_db
def test_noop_bulk_content_write_cannot_refresh_searchable_content_age(
    creator_factory,
):
    page = _make_page(
        creator_factory(),
        "bulk-content-freshness",
        title="Privacy",
        content="privacy",
    )
    old = timezone.now() - timedelta(days=365)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=old,
    )

    # The unrelated field must still update for every matched row, while the
    # equal title assignment must not manufacture content recency.
    zPage.objects.filter(pk=page.pk).update(
        title=page.title,
        category="TECHNOLOGY",
    )
    zPage.objects.filter(pk=page.pk).update(title=F("title"))

    page.refresh_from_db()
    assert page.category == "TECHNOLOGY"
    assert page.searchable_content_updated_at == old


@pytest.mark.django_db
def test_expression_bulk_content_write_requires_explicit_freshness(
    creator_factory,
):
    page = _make_page(
        creator_factory(),
        "expression-content-freshness",
        title="Privacy",
        content="privacy",
    )

    with pytest.raises(ValueError, match="searchable_content_updated_at"):
        zPage.objects.filter(pk=page.pk).update(title=F("content"))

    page.title = "bulk title"
    with pytest.raises(ValueError, match="searchable_content_updated_at"):
        zPage.objects.bulk_update([page], ["title"])


@pytest.mark.django_db
def test_unrelated_save_cannot_refresh_searchable_content_age(
    creator_factory,
):
    page = _make_page(
        creator_factory(),
        "content-freshness",
        title="Privacy",
        content="privacy",
    )
    old = timezone.now() - timedelta(days=365)
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=old,
        updated_at=old,
    )
    page.refresh_from_db()

    # A full settings save still refreshes the public activity timestamp, but
    # it must not manufacture a fresh search boost for unchanged text.
    page.category = "TECHNOLOGY"
    page.save()
    page.refresh_from_db()
    assert page.updated_at > old
    assert page.searchable_content_updated_at == old

    # A stale full save must not erase a newer freshness update that landed
    # after this instance was loaded.
    newer = timezone.now()
    zPage.objects.filter(pk=page.pk).update(
        searchable_content_updated_at=newer,
    )
    page.category = "SCIENCE"
    page.save()
    page.refresh_from_db()
    assert page.searchable_content_updated_at == newer

    # An actual title/body change is the qualifying write and receives a new
    # content timestamp independently of the general activity timestamp.
    page.content = "privacy revised"
    page.save()
    page.refresh_from_db()
    assert page.searchable_content_updated_at > old
