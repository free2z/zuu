"""Zcash-auth test isolation."""

import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def clear_zauth_throttle_history():
    """Do not leak per-client/address counters between endpoint tests."""
    cache.clear()
    yield
    cache.clear()
