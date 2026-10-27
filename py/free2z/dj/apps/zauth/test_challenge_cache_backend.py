"""The default cache alias is declared, and zauth's mirror uses that alias.

 asked for a shared ``CACHES`` backend for the Zcash challenge store and
recorded the answer as "there is none, so it falls back to the database". Both
halves of that are now wrong, and the only reason the question was open is that
``dj/free2z/settings.py`` said nothing at all: Django synthesizes a
``LocMemCache`` when ``CACHES`` is unset, so the base module had a cache and no
statement of what it was, while ``prod_settings`` had pointed the alias at the
shared Redis all along.

These tests pin the two halves that a silent default cannot express:

1. the project's own base settings module *declares* ``CACHES`` (Django's
   ``global_settings`` fallback does not count -- that is the silence
   read), and

2. the zauth legacy-compatibility mirror -- the only part of the challenge
   store that is in a cache at all -- round-trips through **that declared
   alias**, ``caches["default"]``, rather than some private store of its own.

The v2 token itself is stateless and its replay claim is a PostgreSQL row on
purpose (see ``challenges.py``); the mirror is the rollout-only cache path, so
it is what a cache-topology test can actually observe.
"""

import importlib

import pytest
from django.conf import settings
from django.core.cache import caches

from dj.apps.zauth import challenges


TADDR = "t1WnCauSV6fbHzWBHtSrK2qvFRyU6J121nH"


@pytest.fixture
def mirror_writes_enabled(settings):
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_WRITES_ENABLED = True
    settings.ZCASH_CHALLENGE_LEGACY_MIRROR_REQUIRED = True
    return settings


def test_base_settings_declare_the_default_cache_alias():
    """`dj.free2z.settings` must name the backend, not inherit Django's."""
    base = importlib.import_module("dj.free2z.settings")
    declared = vars(base).get("CACHES")
    assert declared is not None, (
        "dj/free2z/settings.py does not declare CACHES. Django then "
        "synthesizes a LocMemCache from global_settings, which is the right "
        "backend for local development reached by silence -- exactly the gap "
        "#642 recorded as 'no shared cache is configured'. Declare it."
    )
    default = declared["default"]
    assert default["BACKEND"] == (
        "django.core.cache.backends.locmem.LocMemCache"
    )
    # A named LOCATION is the observable difference between "we chose the
    # process-local store" and "nobody chose anything": Django's implicit
    # default leaves it empty.
    assert default.get("LOCATION")


def test_declared_alias_is_the_cache_django_actually_serves():
    """The declaration is live, not shadowed by another settings module."""
    default = settings.CACHES["default"]
    assert default["BACKEND"] == (
        "django.core.cache.backends.locmem.LocMemCache"
    )
    # The named LOCATION survived into the live settings, so what
    # `pytest_settings`/`prod_settings` serve is the base declaration and not
    # `global_settings`' anonymous fallback re-appearing under another module.
    assert default.get("LOCATION")
    assert caches["default"]._cache is not None


def test_zauth_compatibility_store_uses_the_declared_default_alias():
    """zauth must not open a cache of its own behind the alias's back."""
    assert challenges._compatibility_cache_backend() is caches["default"]


def test_challenge_mirror_round_trips_through_the_declared_cache(
    mirror_writes_enabled,
):
    """Store -> read via `caches["default"]` -> consume -> gone from it."""
    cache = caches["default"]
    key = challenges._legacy_challenge_key(TADDR)
    cache.delete(key)

    challenge = challenges.issue_challenge(TADDR)
    challenges.store_legacy_compatible_challenge(TADDR, challenge)

    # Read through the configured alias, not through zauth's own helper: this
    # is what proves the write landed in the cache the project declared.
    assert cache.get(key) == challenge

    assert challenges.consume_v2_legacy_mirror(TADDR, challenge) is True
    assert cache.get(key) is None
    # One winner: the second consume finds nothing left in that same alias.
    assert challenges.consume_v2_legacy_mirror(TADDR, challenge) is False


def test_mirror_consume_reads_only_the_declared_cache(mirror_writes_enabled):
    """Evicting the entry from the declared alias must lose the mirror."""
    cache = caches["default"]
    key = challenges._legacy_challenge_key(TADDR)

    challenge = challenges.issue_challenge(TADDR)
    challenges.store_legacy_compatible_challenge(TADDR, challenge)
    assert cache.get(key) == challenge

    cache.delete(key)

    assert challenges.consume_v2_legacy_mirror(TADDR, challenge) is False
