"""
Procrastinate tasks for the search app (autodiscovered via
procrastinate.contrib.django, module name "tasks").

index_zpage makes pgvector indexing event-driven: before this,
index_public_zpages had no CronJob at all — the SearchIndex only
updated when someone ran the management command by hand. Now the zPage
post_save signal (g12f/signals.py) and the publish_zpage task enqueue a
per-page job whenever a page is published, edited while published, or
unpublished.

Queue isolation: these jobs call OpenAI (summary completion + embedding)
and can be slow or rate-limited, so they run on a dedicated "search"
queue and never starve the fast local "images" queue. The worker
Deployment (k8s/free2z/worker/) consumes all queues.
"""
import logging

from procrastinate import RetryStrategy
from procrastinate.contrib.django import app

from dj.apps.jobs.priorities import BACKGROUND

logger = logging.getLogger(__name__)

# Retry policy . This queue's failures are dominated by
# OpenAI timeouts and 429s, which are transient by definition. Total
# attempts 4, exponential backoff of 3s: retries land at +3s, +9s, +27s,
# so a job survives ~40s of provider trouble and only reaches the
# terminal `failed` status -- the thing the alert policy pages on --
# once the provider has been unhappy for longer than that.
INDEX_RETRY = RetryStrategy(max_attempts=4, exponential_wait=3)


def _index_zpage(zpage_id: int):
    """
    Create/update the SearchIndex entry for one zPage — or remove it when the
    page is gone, unpublished, or owned by a deactivated creator, so stale
    pages cannot remain in search.

    Idempotent (upsert on (content_type, object_id)): duplicate or
    stale jobs converge on the state of the page at execution time.
    """
    from django.contrib.contenttypes.models import ContentType

    from dj.apps.g12f.models.zpage import zPage
    from dj.apps.search.helpers import build_zpage_index
    from dj.apps.search.models import SearchIndex

    page = zPage.objects.published_and_active().filter(pk=zpage_id).first()
    if page is None:
        deleted, _ = SearchIndex.objects.filter(
            content_type=ContentType.objects.get_for_model(zPage),
            object_id=zpage_id,
        ).delete()
        logger.info(
            "index_zpage: zPage %s missing/unpublished/inactive, "
            "removed %s index row(s)",
            zpage_id, deleted,
            extra={"zpage_id": zpage_id, "outcome": "removed"},
        )
        return

    build_zpage_index(page)
    # One JSON line at INFO (settings.LOGGING routes this module through
    # RawLoggerJSONFormatter, ): as plain stderr GKE graded every one of
    # these successes ERROR.
    logger.info(
        "index_zpage: indexed zPage %s", zpage_id,
        extra={"zpage_id": zpage_id, "outcome": "indexed"},
    )


@app.task(
    name="search.index_zpage", queue="search", retry=INDEX_RETRY,
    priority=BACKGROUND,
)
def index_zpage(zpage_id: int):
    """Index canonical saves using the stable, pre-multilingual contract."""
    return _index_zpage(zpage_id)


@app.task(
    name="search.index_multilingual_zpage",
    queue="search-multilingual",
    retry=INDEX_RETRY,
    priority=BACKGROUND,
)
def index_multilingual_zpage(zpage_id: int):
    """Index translations through a rollout-safe task contract.

    Old workers do not know this task name and cannot silently mark this work
    successful after indexing canonical content only. Its dedicated queue is
    monitored as critical, so one terminal failure alerts and can be retried.
    """
    return _index_zpage(zpage_id)
