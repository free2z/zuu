"""
Add description for zpages that are published
and don't have a description.
"""
import sys
import json
import traceback

from django.core.management.base import BaseCommand
from django.conf import settings

from gcp.pubsub.client import PubSubClient

from dj.apps.g12f.models import zPage
from dj.apps.g12f.variants import sync_source_variant

from f2z.ai.providers import complete_prompt
from f2z.openai.util import get_openai_client

from django.db import close_old_connections, transaction

from dj.apps.search.helpers import (
    create_search_index_if_not_exists, truncate_text,
)

#Built on first use, not at import: importing this module (tests, a backfill
#from ``manage.py shell``) must not need an API key.
oai_client = None

#Reply budget. A description is cut to 250 characters on save, which is well
#under 100 tokens in any script; this only bounds a runaway reply.
DESCRIPTION_MAX_TOKENS = 256

#The page body is truncated to this many tokens before it is sent. The model
#this ran on until, gpt-3.5-turbo, had a 16k context, which bounded the
#cost of one call; PROMPT_COMPLETION_MODEL (gpt-4o-mini) accepts 128k, and
#this is an unmetered background call that fires on every publish. The same
#budget the search summary uses (``get_zpage_context``) -- a meta
#description does not need more than the first few pages of text.
DESCRIPTION_CONTENT_TOKENS = 3500


def _client():
    global oai_client
    if oai_client is None:
        oai_client = get_openai_client()
    return oai_client

SYSTEM = """
You are an expert at summarizing zPages with a succinct statement or two.
"""


def PROMPT(page): return f"""
Create a description for this zPage that is under 150 characters
suitable for use as a meta description tag in HTML.

```
{page.title}
{truncate_text(page.content, DESCRIPTION_CONTENT_TOKENS)}
```
by {page.creator.full_name or page.creator.username}

A complete description for this zPage in under 150 characters:
"""


def catch_errors(callback):
    def wrapper(message):
        try:
            close_old_connections()
            callback(message)
        except Exception:
            # log the traceback
            traceback.print_exc()
            # acknowledge the message
            message.ack()
    return wrapper


def needs_description(instance):
    """Published (or scheduled), long enough, and no description yet."""
    return not (
        instance.description
        or (not instance.is_published and not instance.publish_at)
        or len(instance.content) < 150
    )


def describe_zpage(instance):
    """Write a generated meta description onto ``instance`` if it needs one.

    Idempotent: a page that already has a description (or does not qualify)
    is left alone and no provider call is made, so re-running it -- the
    backfill in  -- is safe. Returns whether a description was written.

    Chat Completions on ``PROMPT_COMPLETION_MODEL`` via ``complete_prompt``
    with the same system + user messages as before. This hard-coded
    ``gpt-3.5-turbo`` until. A reply with no text raises
    ``EmptyCompletion`` and nothing is saved.
    """
    if not needs_description(instance):
        return False
    text = complete_prompt(
        _client(),
        PROMPT(instance),
        system=SYSTEM,
        max_tokens=DESCRIPTION_MAX_TOKENS,
    )
    description = text.strip()[:250]
    # The description may have been filled while the provider call was in
    # flight: by an author, or by another callback that passed the same
    # qualification check. Only the first writer to an empty description wins.
    with transaction.atomic():
        if not zPage.objects.filter(
                pk=instance.pk, description='').update(
                    description=description):
            return False
        # Query the winner's current page state inside this transaction before
        # mirroring it. The callback instance may be stale, and QuerySet.update
        # bypasses the post_save signal that normally maintains the mirror.
        fresh_instance = zPage.objects.get(pk=instance.pk)
        sync_source_variant(fresh_instance)
    instance.description = description
    return True


@catch_errors
def callback(message):
    sys.stdout.flush()
    data = json.loads(message.data.decode('utf-8'))
    print("callback page_update_subscriber", data)
    instance = zPage.objects.from_active_creators().get(
        free2zaddr=data['free2zaddr']
    )

    # if no SearchIndex, then create one.
    ### Vector summary - could be different listener...
    if instance.is_published:
        try:
            create_search_index_if_not_exists(instance)
        except Exception:
            # The description below must not depend on it. When the search
            # summary model was retired (2026-09-28, ) this raised on
            # every callback and the page never got a description either,
            # because the message is acked on any error and never redelivered
            #. search.index_zpage owns search indexing and retries on
            # its own.
            traceback.print_exc()
    ###

    # if it's published (or will be) and doesn't have a description, create one
    describe_zpage(instance)

    print("acknowledging message")
    sys.stdout.flush()
    message.ack()


class Command(BaseCommand):
    def handle(self, *args, **options):
        print("describe_zpage_listener ...")
        sys.stdout.flush()
        ps = PubSubClient()

        ps.subscribe(
            settings.PUBSUB["PAGE_UPDATE"]["topic"],
            settings.PUBSUB["PAGE_UPDATE"]["AIDESCRIBE"],
            callback,
        )
