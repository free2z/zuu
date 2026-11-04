import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def _isolated_search_cache():
    """Query embeddings and admission counters live in the process-local
    cache; without this a vector cached by one test answers the next one's
    search without calling its provider double."""
    cache.clear()
    yield
    cache.clear()
