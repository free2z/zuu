"""Tests for the "Creators to watch" discovery ranking on GET /api/creator/.

The list must (a) EXCLUDE creators who have done nothing / nothing recent,
(b) rank recently-active creators above long-dormant ones, and (c) NEVER expose
the private 2Z balance (`tuzis`) in the serialized output.

`zPage.updated_at` is auto_now and `created_at` is auto_now_add, so we backdate
them with `.update()` (which bypasses the auto fields) to simulate age.
"""
import uuid
from datetime import timedelta

import pytest
from django.utils import timezone

from dj.apps.g12f.models import zPage
from dj.apps.uploads.models import GenericFile


def _image(creator):
    return GenericFile.objects.create(
        owner=creator,
        file=f"uploads/test-{uuid.uuid4().hex}.png",  # one key, one row
        mime_type="image/png",
    )


def _make_creator(creator_factory, **kwargs):
    """A creator with the avatar + banner the discovery list requires."""
    creator = creator_factory(**kwargs)
    creator.avatar_image = _image(creator)
    creator.banner_image = _image(creator)
    creator.save()
    return creator


def _publish_page(creator, *, days_old=0, published=True):
    page = zPage.objects.create(
        creator=creator,
        free2zaddr=str(uuid.uuid4()),
        vanity=str(uuid.uuid4())[:12],
        title="A page",
        content="Some content about a topic.",
        is_published=published,
    )
    if days_old:
        when = timezone.now() - timedelta(days=days_old)
        zPage.objects.filter(pk=page.pk).update(
            created_at=when, updated_at=when, publish_at=when,
        )
    return page


def _usernames(response):
    return [item["username"] for item in response.json()["results"]]


@pytest.mark.django_db
def test_creator_with_zero_activity_is_excluded(api_client, creator_factory):
    """An account that uploaded images but never published anything is not
    'worth watching' and must not appear in the discovery list."""
    active = _make_creator(creator_factory, username="active")
    _publish_page(active, days_old=1)

    idle = _make_creator(creator_factory, username="idle")  # images only, no page

    response = api_client.get("/api/creator/")
    assert response.status_code == 200

    names = _usernames(response)
    assert "active" in names
    assert "idle" not in names


@pytest.mark.django_db
def test_long_dormant_creator_is_excluded(api_client, creator_factory):
    """A creator whose only activity predates the recency window is dropped."""
    fresh = _make_creator(creator_factory, username="fresh")
    _publish_page(fresh, days_old=3)

    dormant = _make_creator(creator_factory, username="dormant")
    _publish_page(dormant, days_old=800)  # well beyond the 365-day window

    names = _usernames(api_client.get("/api/creator/"))
    assert "fresh" in names
    assert "dormant" not in names


@pytest.mark.django_db
def test_recently_active_ranks_above_dormant(api_client, creator_factory):
    """Two otherwise-identical qualified creators: the more recently active one
    ranks higher under the default (weighted) ordering."""
    recent = _make_creator(creator_factory, username="recent")
    _publish_page(recent, days_old=2)

    stale = _make_creator(creator_factory, username="stale")
    _publish_page(stale, days_old=200)  # still within the window, so qualifies

    names = _usernames(api_client.get("/api/creator/"))
    assert "recent" in names and "stale" in names
    assert names.index("recent") < names.index("stale")


# ---------------------------------------------------------------------------
# Regression coverage for PR: the "Creators to watch" qualification filter
# (published page AND recent activity) must apply ONLY to the discovery branches
# (homeSort=random and the default -watch_score ranking) — NOT to search /
# ordering / updated.  accidentally built every list branch on the filtered
# queryset, so global creator search, @mention autocomplete, the command palette
# and the /creators directory all silently returned [] for perfectly legitimate
# creators who simply had no published page or were dormant.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_search_finds_creator_with_no_published_page(api_client, creator_factory):
    """REGRESSION: `?search=` must find a creator with an avatar+banner
    but NO published zPage. Before the fix the discovery exclusion leaked onto
    the search path and this returned []."""
    _make_creator(creator_factory, username="zzsearchnopage")  # images only

    resp = api_client.get("/api/creator/?search=zzsearchnopage")
    assert resp.status_code == 200
    assert "zzsearchnopage" in _usernames(resp)


@pytest.mark.django_db
def test_search_finds_creator_with_only_ancient_page(api_client, creator_factory):
    """REGRESSION: `?search=` must find a creator whose only page was
    published 900 days ago (far outside the 365-day recency window)."""
    old = _make_creator(creator_factory, username="zzsearchancient")
    _publish_page(old, days_old=900)

    resp = api_client.get("/api/creator/?search=zzsearchancient")
    assert resp.status_code == 200
    assert "zzsearchancient" in _usernames(resp)


@pytest.mark.django_db
def test_search_with_ordering_finds_dormant(api_client, creator_factory):
    """The real ZUULI search path (`?search=&ordering=-total`, used by
    discover.searchCreators) must also surface a page-less creator."""
    _make_creator(creator_factory, username="zzsearchordering")  # no page

    resp = api_client.get(
        "/api/creator/?search=zzsearchordering&ordering=-total"
    )
    assert resp.status_code == 200
    assert "zzsearchordering" in _usernames(resp)


@pytest.mark.django_db
def test_discovery_still_excludes_dormant_and_pageless(api_client, creator_factory):
    """The discovery branches — both the default weighted ranking AND
    `homeSort=random` — must STILL hide creators with no published page or no
    recent activity. The fix only scopes the filter off the search/ordering
    paths; discovery keeps qualifying its results."""
    active = _make_creator(creator_factory, username="zzdiscactive")
    _publish_page(active, days_old=1)

    nopage = _make_creator(creator_factory, username="zzdiscnopage")  # no page
    ancient = _make_creator(creator_factory, username="zzdiscancient")
    _publish_page(ancient, days_old=900)

    default_names = _usernames(api_client.get("/api/creator/"))
    assert "zzdiscactive" in default_names
    assert "zzdiscnopage" not in default_names
    assert "zzdiscancient" not in default_names

    random_names = _usernames(api_client.get("/api/creator/?homeSort=random"))
    assert "zzdiscactive" in random_names
    assert "zzdiscnopage" not in random_names
    assert "zzdiscancient" not in random_names


@pytest.mark.django_db
def test_search_path_never_serializes_balance(api_client, creator_factory):
    """The private 2Z balance (`tuzis`) must never leak on the search path
    either, even for a page-less creator now included in results."""
    rich = _make_creator(creator_factory, username="zzsearchrich")
    rich.tuzis = 987654
    # Explicit update_fields: a full save() deliberately refuses to write the
    # ledger-owned balance, which would quietly leave this at the
    # factory default and make the test prove nothing.
    rich.save(update_fields=["tuzis"])

    resp = api_client.get("/api/creator/?search=zzsearchrich")
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert results, "expected the page-less creator to be found via search"
    for item in results:
        assert "tuzis" not in item
        assert "total" in item


@pytest.mark.django_db
def test_balance_is_never_serialized(api_client, creator_factory):
    """The private 2Z balance (`tuzis`) may influence ranking but must NEVER be
    present in the API response."""
    creator = _make_creator(creator_factory, username="rich")
    creator.tuzis = 999999
    # See: only an explicit update_fields writes the balance.
    creator.save(update_fields=["tuzis"])
    _publish_page(creator, days_old=1)

    response = api_client.get("/api/creator/")
    assert response.status_code == 200
    results = response.json()["results"]
    assert results, "expected the qualified creator in the list"
    for item in results:
        assert "tuzis" not in item
        # backward-compatible shape: the public `total` is still present
        assert "total" in item
