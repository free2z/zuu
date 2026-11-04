"""Search-query embedding is bounded per caller, fleet-wide, and by length.

``VectorSearchFilter`` embeds the ``?search=`` query with a paid provider call
inside a public, anonymous-readable request. These pin the bounds on that:

* a repeated query reuses its cached embedding (one provider call);
* the query is normalized and capped before it is embedded;
* a fresh query needs admission from a per-caller budget (account, public
  client, or the one shared cluster-internal budget) AND a fleet-wide one;
* past a budget, or with the counter store unavailable, the search is
  answered from Postgres full text -- never a 429, never a provider call.

The fixture makes the two paths distinguishable by their results: the
"semantic" page has the query's exact vector but none of its words, and the
"text" page has the words but no vector.

Negative control, run while writing this: with the cache lookup and the
``SearchEmbeddingAdmission`` refusal removed from ``filter_queryset``, every
budget test here sees one provider call per request and fails.
"""

import uuid
from types import SimpleNamespace
from unittest import mock

import pytest
from django.contrib.contenttypes.models import ContentType
from django.test import override_settings
from rest_framework.throttling import SimpleRateThrottle

from dj.apps.g12f.models import zPage
from dj.apps.search import drf_filters
from dj.apps.search.models import SearchIndex
from dj.free2z.throttling import (
    SEARCH_EMBEDDING_REFUSED_EVENT,
    SearchEmbeddingAdmission,
)

DIMENSIONS = 1536

#Every query below is "privacy <word>" with a word from this list, so each is
#a distinct query (a fresh embedding) that full text still matches.
WORDS = [
    "article", "shielded", "memo", "wallet", "viewing", "orchard",
    "sapling", "transparent", "unified", "address", "receiver", "note",
]

#nginx's shape for a browser call (realip -> one XFF value) and for an
#in-cluster SSR fetch; see dj/apps/test_throttling.py.
CLIENT_A = {"REMOTE_ADDR": "127.0.0.1", "HTTP_X_FORWARDED_FOR": "203.0.113.7"}
CLIENT_B = {"REMOTE_ADDR": "127.0.0.1", "HTTP_X_FORWARDED_FOR": "198.51.100.4"}
SSR_POD_1 = {"REMOTE_ADDR": "127.0.0.1", "HTTP_X_FORWARDED_FOR": "10.52.3.17"}
SSR_POD_2 = {"REMOTE_ADDR": "127.0.0.1", "HTTP_X_FORWARDED_FOR": "10.52.9.4"}


def _unit_vector():
    vector = [0.0] * DIMENSIONS
    vector[0] = 1.0
    return vector


def _rates(**overrides):
    """Patched onto the class: DRF binds THROTTLE_RATES at import time."""
    return mock.patch.object(
        SimpleRateThrottle,
        "THROTTLE_RATES",
        {**SimpleRateThrottle.THROTTLE_RATES, **overrides},
    )


@pytest.fixture
def pages(creator_factory):
    author = creator_factory()
    semantic = zPage.objects.create(
        creator=author,
        free2zaddr=str(uuid.uuid4()),
        vanity="semantic-only",
        title="Shielded transactions",
        content="Nothing that shares a word with the query.",
        is_published=True,
    )
    SearchIndex.objects.create(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=semantic.pk,
        vector=_unit_vector(),
    )
    text = zPage.objects.create(
        creator=author,
        free2zaddr=str(uuid.uuid4()),
        vanity="text-only",
        title="Privacy notes",
        content=" ".join(["Privacy"] + WORDS),
        is_published=True,
    )
    return SimpleNamespace(semantic=semantic, text=text)


@pytest.fixture
def provider(monkeypatch, mocker):
    """The paid embedding call, counted. Everything else is real."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-used")
    create = mocker.Mock(
        return_value=SimpleNamespace(
            data=[SimpleNamespace(embedding=_unit_vector())],
        ),
    )
    monkeypatch.setattr(
        drf_filters,
        "query_embedding_client",
        lambda: SimpleNamespace(embeddings=SimpleNamespace(create=create)),
    )
    return create


def _search(api_client, query, origin, path="/api/zpage/"):
    response = api_client.get(path, {"search": query}, **origin)
    assert response.status_code == 200, response.content[:300]
    return [item["vanity"] for item in response.json()["results"]]


@pytest.mark.django_db
def test_a_repeated_query_is_embedded_once(api_client, pages, provider):
    for origin in (CLIENT_A, CLIENT_B, SSR_POD_1, CLIENT_A):
        assert _search(api_client, "privacy", origin) == ["semantic-only"]
    assert provider.call_count == 1


@pytest.mark.django_db
def test_whitespace_variants_share_one_embedding(api_client, pages, provider):
    _search(api_client, "privacy  coins", CLIENT_A)
    _search(api_client, "  privacy\tcoins ", CLIENT_A)
    assert provider.call_count == 1
    assert provider.call_args.kwargs["input"] == ["privacy coins"]


@pytest.mark.django_db
def test_the_query_is_capped_before_it_is_embedded(api_client, pages, provider):
    with override_settings(SEARCH_QUERY_MAX_CHARS=256):
        _search(api_client, "privacy " * 2000, CLIENT_A)
    (embedded,) = provider.call_args.kwargs["input"]
    assert len(embedded) <= 256
    assert embedded.startswith("privacy privacy")


@pytest.mark.django_db
def test_a_whitespace_only_query_spends_nothing(api_client, pages, provider):
    assert _search(api_client, "   \t ", CLIENT_A) == []
    assert provider.call_count == 0


@pytest.mark.django_db
def test_an_anonymous_client_past_its_budget_gets_full_text(
    api_client, pages, provider,
):
    with _rates(**{"search-embed-anon": "2/minute"}):
        answers = [
            _search(api_client, f"privacy {WORDS[n]}", CLIENT_A) for n in range(5)
        ]
        # A different client still has its own budget.
        assert _search(api_client, "privacy receiver", CLIENT_B) == ["semantic-only"]
    assert answers[:2] == [["semantic-only"]] * 2
    assert answers[2:] == [["text-only"]] * 3
    assert provider.call_count == 3


@pytest.mark.django_db
def test_ipv6_clients_share_a_budget_per_slash_64(api_client, pages, provider):
    one = {"REMOTE_ADDR": "127.0.0.1", "HTTP_X_FORWARDED_FOR": "2001:db8:1:2::a"}
    two = {"REMOTE_ADDR": "127.0.0.1", "HTTP_X_FORWARDED_FOR": "2001:db8:1:2::b"}
    with _rates(**{"search-embed-anon": "1/minute"}):
        assert _search(api_client, "privacy note", one) == ["semantic-only"]
        assert _search(api_client, "privacy unified", two) == ["text-only"]
    assert provider.call_count == 1


@pytest.mark.django_db
def test_cluster_internal_callers_share_one_budget(api_client, pages, provider):
    """SSR renders carry no per-visitor identity, so every in-cluster address
    spends the one internal budget -- and degrades, never 429s, past it."""
    with _rates(**{"search-embed-internal": "2/minute"}):
        answers = [
            _search(api_client, f"privacy {WORDS[n]}", origin)
            for n, origin in enumerate([SSR_POD_1, SSR_POD_2, SSR_POD_1, SSR_POD_2])
        ]
    assert answers == [["semantic-only"]] * 2 + [["text-only"]] * 2
    assert provider.call_count == 2


@pytest.mark.django_db
def test_the_fleet_wide_budget_caps_every_caller(
    api_client, pages, provider, creator_factory,
):
    with _rates(**{"search-embed-global": "3/minute"}):
        for n, origin in enumerate([CLIENT_A, CLIENT_B, SSR_POD_1]):
            assert _search(api_client, f"privacy {WORDS[n]}", origin) == ["semantic-only"]
        api_client.force_authenticate(user=creator_factory())
        assert _search(api_client, "privacy sapling", {}) == ["text-only"]
        api_client.force_authenticate(user=None)
        assert _search(
            api_client,
            "privacy orchard",
            {"REMOTE_ADDR": "127.0.0.1", "HTTP_X_FORWARDED_FOR": "192.0.2.55"},
        ) == ["text-only"]
    assert provider.call_count == 3


@pytest.mark.django_db
def test_a_logged_in_account_has_its_own_budget(
    api_client, pages, provider, creator_factory,
):
    with _rates(**{"search-embed-user": "1/minute"}):
        api_client.force_authenticate(user=creator_factory())
        assert _search(api_client, "privacy note", CLIENT_A) == ["semantic-only"]
        assert _search(api_client, "privacy unified", CLIENT_A) == ["text-only"]
        api_client.force_authenticate(user=creator_factory())
        assert _search(api_client, "privacy address", CLIENT_A) == ["semantic-only"]
    assert provider.call_count == 2


@pytest.mark.django_db
def test_a_cached_query_is_served_past_the_budget(api_client, pages, provider):
    """A cache hit costs nothing, so it is not refused."""
    with _rates(**{"search-embed-anon": "1/minute"}):
        assert _search(api_client, "privacy", CLIENT_A) == ["semantic-only"]
        assert _search(api_client, "privacy transparent", CLIENT_A) == ["text-only"]
        assert _search(api_client, "privacy", CLIENT_A) == ["semantic-only"]
    assert provider.call_count == 1


@pytest.mark.django_db
def test_an_unavailable_counter_store_spends_nothing(
    api_client, pages, provider, caplog,
):
    """prod's default cache swallows a Redis outage (incr returns None).
    Uncountable means unspent: full text, no provider call."""
    with mock.patch(
        "django.core.cache.backends.locmem.LocMemCache.incr", return_value=None,
    ), caplog.at_level("WARNING", logger="dj.free2z.throttling"):
        assert _search(api_client, "privacy", CLIENT_A) == ["text-only"]
    assert provider.call_count == 0
    assert any(
        SEARCH_EMBEDDING_REFUSED_EVENT in message
        and "counter-unavailable" in message
        for message in caplog.messages
    )


@pytest.mark.django_db
def test_a_detail_read_with_search_is_bounded_too(api_client, pages, provider):
    """``get_object`` runs the filter backends, so a detail URL carrying
    ``?search=`` reaches the same embedding path."""
    path = f"/api/zpage/{pages.semantic.free2zaddr}/"
    with _rates(**{"search-embed-anon": "1/minute"}):
        for n in range(3):
            response = api_client.get(path, {"search": f"q{n}"}, **CLIENT_A)
            assert response.status_code in (200, 404), response.status_code
    assert provider.call_count <= 1


def test_every_admission_budget_has_a_rate():
    rates = SimpleRateThrottle.THROTTLE_RATES
    for scope in (
        SearchEmbeddingAdmission.USER_SCOPE,
        SearchEmbeddingAdmission.ANON_SCOPE,
        SearchEmbeddingAdmission.INTERNAL_SCOPE,
        SearchEmbeddingAdmission.GLOBAL_SCOPE,
    ):
        num, period = SimpleRateThrottle.parse_rate(None, rates[scope])
        assert num > 0 and period > 0, scope
