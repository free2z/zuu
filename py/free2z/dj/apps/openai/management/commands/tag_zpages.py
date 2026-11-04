"""`zpage-tag` Deployment: tag or propose tags for updated zPages.

This subscriber used to write straight to the article:

    if instance.tags.exists() or not instance.is_published:
        return
    tags = tag_content(...)
    instance.tags.add(*tags)

Two things were wrong with that and both are fixed here.

**It wrote silently.** Machine-generated tags appeared on someone else's
article with no consent and no review, and until  the editor could not
even display the ones outside its twenty-item picker, let alone remove them.
Now the output goes to ``TagSuggestion`` rows and the creator accepts or
dismisses them in the publish sheet. Nothing in this process writes to
``zpage.tags`` any more.

**``tags.exists()`` was the entire gate**, which  turned into a trap: the
moment a creator added one tag of their own, AI tagging switched off for that
page forever. Backwards -- engagement should improve suggestions, not disable
them. The gate is now a content digest ("have we already suggested for THIS
version of the text"), which is both the correct question and strictly cheaper:
``PAGE_UPDATE`` fires on every save, and the old gate bought a ``gpt-4o``
completion on each one for an untagged page.

** amends the first point for one case.** Suggestion-first left almost
every page with no tags at all, so a published page that carries ZERO tags when
the pass finishes gets the output applied to ``zpage.tags`` (recorded as
``TagSuggestion.AUTO_APPLIED``). Any creator tag -- including one added while
the completion was in flight -- keeps the page suggestion-only. The decision is
made under the zPage row lock in ``services.record_suggestions``, not here.

See ``dj/apps/tagging/services.py`` for the cost story in full, including why
this is not on the metered ``AIModel`` path.
"""
import sys
import json
import traceback

from django.core.management.base import BaseCommand
from django.conf import settings

from django.db import close_old_connections

from gcp.pubsub.client import PubSubClient
from dj.apps.g12f.models.zpage import zPage
from dj.apps.tagging.services import suggest_tags_for_zpage


def catch_errors(callback):
    def wrapper(message):
        try:
            close_old_connections()
            callback(message)
        except Exception:
            # ACK on failure, deliberately. The subscription has no
            # dead-letter or max-delivery policy, so a NACK on a poison message
            # loops it forever and every redelivery buys another OpenAI call.
            # ACK-and-log bounds the damage to one lost suggestion pass, and a
            # later edit re-triggers it with a fresh digest.
            traceback.print_exc()
            message.ack()
    return wrapper


@catch_errors
def callback(message):
    data = json.loads(message.data.decode('utf-8'))
    print("callback tag_zpages", data)
    try:
        instance = zPage.objects.published_and_active().get(
            free2zaddr=data['free2zaddr']
        )
    except zPage.DoesNotExist:
        # Deleted between publish and delivery. Nothing to suggest for, and
        # redelivering cannot make the page reappear.
        print(f"zpage gone: {data.get('free2zaddr')}")
        sys.stdout.flush()
        message.ack()
        return

    suggestions = suggest_tags_for_zpage(instance)
    print(
        f"proposed {len(suggestions)} tag(s) for {instance.free2zaddr}: "
        f"{[(s.name, s.status) for s in suggestions]}"
    )
    sys.stdout.flush()
    message.ack()


class Command(BaseCommand):
    def handle(self, *args, **options):
        print("tag_zpages Listening for updates....")
        sys.stdout.flush()
        ps = PubSubClient()
        ps.subscribe(
            settings.PUBSUB["PAGE_UPDATE"]["topic"],
            settings.PUBSUB["PAGE_UPDATE"]["TAG_ZPAGE"],
            callback,
        )
