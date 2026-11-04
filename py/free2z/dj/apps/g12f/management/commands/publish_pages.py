"""
Transition backstop sweep for scheduled publishing.

Real publishing is event-based: the zPage save signal defers a
g12f.publish_zpage job with schedule_at=publish_at. This hourly sweep
exists only to catch a page whose job was never deferred or was lost.

It also emits the evidence  needs before it can be deleted: one
structured JSON line per run with how many pages it actually had to
publish. A durable run of `published: 0` is what proves the backstop is
redundant. Do NOT delete this command on the strength of "it looks fine"
— look at that number in Cloud Logging first.
"""
import json
import logging

from django.core.management.base import BaseCommand
from django.utils import timezone

from dj.apps.g12f.models import zPage
from dj.apps.g12f.tasks import publish_zpage

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Publish pages that need publishing (transition backstop)'

    def handle(self, *args, **kwargs):
        published = 0
        #.iterator(): if publishing ever backs up (worker outage), this
        # set can be large, and zPage rows carry full markdown content.
        # Streaming keeps the sweep's memory bounded by chunk_size
        # rather than by the size of the backlog.
        for p in zPage.objects.filter(
            publish_at__lte=timezone.now(),
            is_published=False,
        ).only('pk').order_by('pk').iterator(chunk_size=100):
            # Use the same atomic transition and downstream indexing /
            # notification path as the scheduled worker. A concurrent worker
            # may win between this sweep's SELECT and compare-and-set UPDATE.
            if not publish_zpage(zpage_id=p.pk):
                continue
            published += 1
            logger.info(json.dumps({
                'severity': 'WARNING',
                'message': (
                    f'publish_pages backstop published zPage {p.pk} that '
                    f'the scheduled job did not'),
                'event': 'publish_pages_backstop_hit',
                'zpage_id': p.pk,
            }))

        # One line per run, always -- including the (expected) zero case,
        # because "no log line" and "nothing to do" must not look alike.
        logger.info(json.dumps({
            'severity': 'INFO',
            'message': f'publish_pages backstop sweep: published={published}',
            'event': 'publish_pages_backstop_sweep',
            'published': published,
        }))
