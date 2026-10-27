"""Broad vs narrow is derived from corpus frequency, not stored.

The owner asked for tags that are broad AND narrow. These tests pin the two
halves of that answer:

* the AI prompt no longer forbids the narrow half (it used to say "avoid tags
  that are too specific" and cap tags at 16 characters, which made
  `halo2 recursion` unreachable by construction);
* the distinction is computed from how many published zPages carry a tag, so it
  needs no ``level`` column, no taxonomy, and no creator doing classification
  work while trying to publish.
"""

import uuid

import pytest

from f2z.openai.util import TAGS_SYSTEM_MESSAGE, sanitize_tags

from dj.apps.g12f.models import zPage
from dj.apps.tagging import breadth


def _pages(creator, count, tag, published=True):
    for _ in range(count):
        page = zPage.objects.create(
            creator=creator,
            free2zaddr=str(uuid.uuid4()),
            vanity=f"article-{uuid.uuid4()}",
            title="Tagged",
            content="Body",
            is_published=published,
        )
        page.tags.add(tag)


@pytest.fixture(autouse=True)
def _clear_threshold_cache():
    """Both layers. The per-process memo outlives a test the shared cache does."""
    from django.core.cache import cache
    cache.delete(breadth.CACHE_KEY)
    breadth.reset_local_cache()
    yield
    cache.delete(breadth.CACHE_KEY)
    breadth.reset_local_cache()


# ---------------------------------------------------------------------------
# The prompt
# ---------------------------------------------------------------------------

def test_the_prompt_no_longer_forbids_narrow_tags():
    """These three rules are why the corpus had no narrow tags to work with."""
    assert "under 16 characters" not in TAGS_SYSTEM_MESSAGE
    assert "too specific" not in TAGS_SYSTEM_MESSAGE
    assert "Avoid tags" not in TAGS_SYSTEM_MESSAGE


def test_the_prompt_asks_for_both_breadths_explicitly():
    assert "BROAD" in TAGS_SYSTEM_MESSAGE
    assert "NARROW" in TAGS_SYSTEM_MESSAGE
    # The exact example from the issue, which the old prompt could not produce.
    assert "halo2 recursion" in TAGS_SYSTEM_MESSAGE
    # And it must not re-import the twenty-category taxonomy  removed as
    # its worked examples.
    assert "'technology', 'art', 'fitness'" not in TAGS_SYSTEM_MESSAGE


def test_the_prompt_asks_for_the_content_s_own_language():
    """A tag translated into English hides the piece from its readers."""
    assert "SAME LANGUAGE" in TAGS_SYSTEM_MESSAGE


# ---------------------------------------------------------------------------
# Model output is untrusted input
# ---------------------------------------------------------------------------

def test_sanitize_drops_what_the_database_would_refuse():
    raw = [
        "  halo2   recursion ",     # collapsed and trimmed
        "halo2 recursion",          # duplicate after collapsing
        "HALO2 RECURSION",          # duplicate case-insensitively
        "x" * 101,                  # longer than Tag.name
        "",
        None,                       # not a string at all
        42,
        {"nested": "object"},
        "Zcash",
    ]

    assert sanitize_tags(raw) == ["halo2 recursion", "Zcash"]


def test_sanitize_survives_a_non_list():
    assert sanitize_tags(None) == []
    assert sanitize_tags("just one tag") == ["just one tag"]


def test_sanitize_preserves_case_and_multi_word_tags():
    """No destructive case-folding here — that is, and it needs aliases."""
    assert sanitize_tags(["Sapling shielded pool"]) == [
        "Sapling shielded pool"]


def test_sanitize_bounds_the_count():
    assert len(sanitize_tags([f"tag {n}" for n in range(200)])) <= 12


# ---------------------------------------------------------------------------
# The frequency classifier
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_an_empty_corpus_does_not_divide_by_anything(creator_factory):
    assert breadth.compute_threshold() >= breadth.MIN_BROAD_COUNT
    assert breadth.classify(0) == breadth.NARROW


@pytest.mark.django_db
def test_a_tag_on_one_page_is_never_broad(creator_factory):
    """The floor. Without it a long-tailed corpus classifies everything broad."""
    creator = creator_factory()
    _pages(creator, 1, "halo2 recursion")

    assert breadth.classify(1, breadth.breadth_threshold()) == breadth.NARROW


@pytest.mark.django_db
def test_the_popular_tag_is_broad_and_the_long_tail_is_narrow(creator_factory):
    creator = creator_factory()
    _pages(creator, 20, "crypto")
    for name in ("halo2 recursion", "Sapling shielded pool", "agorism"):
        _pages(creator, 1, name)

    threshold = breadth.breadth_threshold()

    assert breadth.classify(20, threshold) == breadth.BROAD
    assert breadth.classify(1, threshold) == breadth.NARROW


@pytest.mark.django_db
def test_unpublished_pages_do_not_make_a_tag_broad(creator_factory):
    """Drafts are not browsable, so they cannot vote on the browse vocabulary."""
    creator = creator_factory()
    _pages(creator, 30, "secret project", published=False)
    _pages(creator, 4, "crypto")

    threshold = breadth.breadth_threshold()

    assert breadth.classify(0, threshold) == breadth.NARROW
    assert breadth.classify(4, threshold) == breadth.BROAD


@pytest.mark.django_db
def test_autocomplete_exposes_the_level(api_client, creator_factory):
    creator = creator_factory()
    _pages(creator, 5, "crypto")
    _pages(creator, 1, "halo2 recursion")

    response = api_client.get("/api/tagging/autocomplete?type=zpage")

    assert response.status_code == 200
    rows = {row["name"]: row for row in response.json()}
    assert rows["crypto"]["level"] == breadth.BROAD
    assert rows["halo2 recursion"]["level"] == breadth.NARROW


@pytest.mark.django_db
def test_a_cache_failure_degrades_to_a_recompute(creator_factory, mocker):
    """Redis is shared with DRF's throttles. A display hint must never 500."""
    creator = creator_factory()
    _pages(creator, 3, "crypto")
    mocker.patch(
        "dj.apps.tagging.breadth.cache.get", side_effect=RuntimeError("boom"))
    mocker.patch(
        "dj.apps.tagging.breadth.cache.set", side_effect=RuntimeError("boom"))

    assert breadth.breadth_threshold() >= breadth.MIN_BROAD_COUNT


@pytest.mark.django_db
def test_the_percentile_boundary_is_not_off_by_one(creator_factory, settings):
    """"Top 10% of 10 tags" is ONE tag, not two.

    `int(10 * 0.10)` is 1, which indexes the SECOND row and quietly makes 20%
    of the vocabulary broad. Caught by the codex adversarial review; this pins
    the fix with a corpus whose ranks are all distinct so there is exactly one
    right answer.
    """
    settings.TAG_BREADTH_PERCENTILE = 0.10
    creator = creator_factory()
    # Ten tags with strictly decreasing use counts: 11, 10, 9,... 2.
    for index, uses in enumerate(range(11, 1, -1)):
        _pages(creator, uses, f"tag-{index}")

    threshold = breadth.breadth_threshold()

    # Only the single most-used tag (11 pages) is broad; the runner-up (10) is
    # not. An off-by-one puts the boundary at 10 and makes two tags broad.
    assert threshold == 11
    assert breadth.classify(11, threshold) == breadth.BROAD
    assert breadth.classify(10, threshold) == breadth.NARROW


@pytest.mark.django_db
def test_the_threshold_is_memoized_per_process(creator_factory, mocker):
    """A total cache outage must not mean a corpus scan per public request.

    `/api/tagging/autocomplete` is public and deliberately unthrottled, and it
    now asks for this number on every request.
    """
    creator = creator_factory()
    _pages(creator, 3, "crypto")
    mocker.patch(
        "dj.apps.tagging.breadth.cache.get", side_effect=RuntimeError("down"))
    mocker.patch(
        "dj.apps.tagging.breadth.cache.set", side_effect=RuntimeError("down"))
    spy = mocker.spy(breadth, "compute_threshold")

    for _ in range(5):
        breadth.breadth_threshold()

    assert spy.call_count == 1
