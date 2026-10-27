"""Broad vs narrow tags, derived from corpus frequency.

The owner asked for tags that are "broad and narrow". The obvious implementation
is a ``level`` column on ``Tag``, and it is the wrong one: somebody has to set
it, nobody will, and it is wrong the moment usage shifts. `zcash` was a narrow
tag on this platform once.

So breadth is not stored. It is **measured**: a tag on 5,000 published zPages is
broad, a tag on 3 is narrow. That definition costs no migration, no taxonomy and
no creator effort, it self-maintains, and it degrades gracefully -- a brand-new
tag simply starts narrow and becomes broad if the corpus agrees.

The boundary is a **percentile of the corpus**, not an absolute count, so it
survives the platform growing. "Broad" means "in the top ``TAG_BREADTH_PERCENTILE``
of tags by use", which means the same thing at 500 tags and at 500,000; a
hardcoded `count >= 50` would silently reclassify the entire vocabulary every
time the site doubled in size.

What this is NOT:

* Not a ranking. Two tags either side of the boundary are near-identical in
  frequency; the classification is a display hint for grouping, and nothing
  that moves money or permissions may key off it.
* Not stable to the row. The threshold moves as the corpus moves, and it is
  cached, so two requests seconds apart can disagree about a tag sitting
  exactly on the line. That is acceptable for "render broad tags first" and
  would not be for anything with a memory.
"""

import logging
import math
import time

from django.conf import settings
from django.contrib.contenttypes.models import ContentType
from django.core.cache import cache
from django.db.models import Count

from taggit.models import TaggedItem

logger = logging.getLogger(__name__)

BROAD = "broad"
NARROW = "narrow"

CACHE_KEY = "tagging:breadth_threshold:zpage:v1"

#Per-process memo, and it is not belt-and-braces. `/api/tagging/autocomplete`
#is public, deliberately unthrottled (the SSR pod calls it), and now asks for
#this number on every request. With only the shared cache in front of
#:func:`compute_threshold`, a Redis outage turns each of those requests into
#two grouped scans of the whole tagged-zPage corpus -- i.e. an ordinary
#traffic level becomes a Postgres load spike, on the same database the auth
#and money paths use. This bounds a total cache outage to one scan per pod per
#TTL. Module-level rather than per-request: a worker is one process and the
#value is not user-specific.
_local_threshold = None          # (value, expires_at) or None
_LOCAL_TTL_SECONDS = 60

#Fraction of the tag vocabulary that counts as broad. 0.10 = the top 10% of
#tags by number of published zPages carrying them.
DEFAULT_PERCENTILE = 0.10
DEFAULT_CACHE_SECONDS = 3600
#A tag used on a single page is narrow by definition, whatever the percentile
#says. Without this floor a young or heavily-long-tailed corpus -- where the
#90th percentile count is 1 -- would classify *every* tag as broad, which is
#the same as having no distinction at all.
MIN_BROAD_COUNT = 2


def _setting(name, default):
    value = getattr(settings, name, None)
    return default if value is None else value


def compute_threshold() -> int:
    """Smallest zPage-count that still counts as broad. Two grouped queries.

    Counts come from ``taggit``'s own join table filtered to published zPages,
    which is the same population ``/api/tagging/autocomplete?type=zpage``
    counts. Deriving the threshold from a *different* population than the
    counts it is compared against is the subtle way to get a classifier that
    disagrees with itself, so both sides read the same rows.

    Note this counts ``TaggedItem`` rows, not distinct pages: taggit's own
    unique constraint on ``(content_type, object_id, tag)`` makes those the
    same number, and skipping the DISTINCT keeps this a plain index-only
    group-by.
    """
    percentile = float(_setting("TAG_BREADTH_PERCENTILE", DEFAULT_PERCENTILE))
    percentile = min(max(percentile, 0.0), 1.0)

    # Imported here rather than at module scope: this module is imported by
    # `views.py`, and g12f imports tagging in places -- a top-level import is a
    # circular-import risk for no benefit.
    from dj.apps.g12f.models import zPage

    content_type = ContentType.objects.get_for_model(zPage)
    counts = (
        TaggedItem.objects
        .filter(
            content_type=content_type,
            object_id__in=zPage.objects.published_and_active().values("pk"),
        )
        .values("tag_id")
        .annotate(uses=Count("id"))
        .order_by("-uses")
    )

    total = counts.count()
    if not total:
        return MIN_BROAD_COUNT

    # The count at the percentile boundary. CEIL then minus one, not a plain
    # truncation: with 10 tags and a 10% setting, `int(10 * 0.10)` is 1, which
    # is the SECOND row and makes 20% of the vocabulary broad. `ceil(1) - 1` is
    # row 0 -- one tag, which is what "the top 10%" means. Clamped into range so
    # a percentile of 0 or 1 cannot index off the end.
    offset = min(max(math.ceil(total * percentile) - 1, 0), total - 1)
    page = list(counts[offset:offset + 1])
    boundary = page[0]["uses"] if page else MIN_BROAD_COUNT
    return max(int(boundary), MIN_BROAD_COUNT)


def breadth_threshold(force: bool = False) -> int:
    """Cached:func:`compute_threshold`, behind two layers.

    Cache failures are swallowed and the threshold recomputed. The shared cache
    is Redis in prod and is shared with DRF's throttles; a display hint about
    tag grouping must never be the reason an article page 500s -- the same
    fail-open direction ``dj/free2z/throttling.py`` argues for at length. The
    per-process memo above is what keeps failing open from being expensive.
    """
    global _local_threshold

    now = time.monotonic()
    if not force and _local_threshold is not None:
        value, expires_at = _local_threshold
        if now < expires_at:
            return value

    if not force:
        try:
            cached = cache.get(CACHE_KEY)
        except Exception:
            logger.warning("tag breadth: cache read failed", exc_info=True)
            cached = None
        if isinstance(cached, int):
            _local_threshold = (cached, now + _LOCAL_TTL_SECONDS)
            return cached

    threshold = compute_threshold()
    _local_threshold = (threshold, now + _LOCAL_TTL_SECONDS)
    try:
        cache.set(
            CACHE_KEY,
            threshold,
            int(_setting("TAG_BREADTH_CACHE_SECONDS", DEFAULT_CACHE_SECONDS)),
        )
    except Exception:
        logger.warning("tag breadth: cache write failed", exc_info=True)
    return threshold


def reset_local_cache():
    """Drop the per-process memo. For tests and for the admin, not the hot path."""
    global _local_threshold
    _local_threshold = None


def classify(count, threshold=None) -> str:
    """``"broad"`` or ``"narrow"`` for a tag used on ``count`` pages.

    ``threshold`` is passed in when classifying a list, so one lookup serves
    the whole response rather than one per row.
    """
    if threshold is None:
        threshold = breadth_threshold()
    try:
        count = int(count)
    except (TypeError, ValueError):
        # An unknown count is a tag nobody has used yet, which is the most
        # narrow thing there is.
        return NARROW
    return BROAD if count >= threshold else NARROW
