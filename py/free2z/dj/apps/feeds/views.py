from django.contrib.syndication.views import Feed
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.contrib.auth import get_user_model
from django.db.models.functions import Coalesce

from dj.apps.g12f.models import zPage
from dj.apps.openai.models import Conversation
from dj.apps.openai.visibility import public_conversation_q
from dj.apps.comments.models import Comment
from dj.apps.comments.visibility import scope_comments_to_visible_parents

User = get_user_model()


PODCAST_MIME_TYPES = ['audio/mpeg', 'audio/mp4', 'video/mp4']


def _chronological_zpages(queryset):
    """Keep public zPage feeds in publication order after edits."""
    return queryset.annotate(
        publication_order=Coalesce('published_at', 'created_at'),
    ).order_by('-publication_order', '-id')[:100]


class ConverseFeed(Feed):
    title = "Latest Converse Comments"
    link = "/feeds/converse/recent.xml"
    description = "Recently added Converse Comments"

    def items(self):
        # Public, unauthenticated RSS: only comments whose parent is publicly
        # visible (or standalone converse posts by an ACTIVE author — ).
        # Previously Comment.objects.all() republished every comment on the
        # platform, including threads on unpublished/subscriber-only pages and
        # private conversations.
        return scope_comments_to_visible_parents(
            Comment.objects.all(), None
        ).order_by('-updated_at')[:100]

    def item_title(self, item):
        # NOT `item.headline`: comments have no headline any more, so
        # that returned "" and every item in this feed — and in the inheriting
        # UserConverseFeed — shipped an empty <title>. Same fallback the
        # social/OG card uses: the headline if a converse post has one,
        # otherwise an excerpt of the body.
        return item.social_description

    def item_description(self, item):
        return item.content

    def item_link(self, item):
        return item.get_url()

    def item_updateddate(self, item):
        return item.updated_at

    def item_pubdate(self, item):
        return item.created_at

    def ttl(self):
        return 60


class AIFeed(Feed):
    title = "Latest Public AI Conversations"
    link = "/feeds/ai/recent.xml"
    description = "Recently updated AI Conversations"

    def items(self):
        # Security: a syndication feed is anonymous and public by
        # nature, so subscriber-only conversations and conversations owned by
        # deactivated creators must never appear here -- `is_public=True`
        # alone would leak the paywalled transcript's first message (see
        # item_description) to every RSS reader.
        return Conversation.objects.filter(
            public_conversation_q(None),
            is_subscriber_only=False,
        ).order_by('-updated_at')[:100]

    def item_title(self, item):
        return item.display_name

    def item_description(self, item):
        # A public conversation can exist with no prompt-responses yet;
        # `.first()` is then None and dereferencing it 500s the whole feed.
        first = item.prompt_response_set.first()
        return first.user_input if first is not None else item.display_name

    def item_link(self, item):
        return item.get_url()

    def item_updateddate(self, item):
        return item.updated_at

    def item_pubdate(self, item):
        return item.created_at

    def ttl(self):
        return 60


class zPageFeed(Feed):
    title = "Latest zPages"
    link = "/feeds/zpages/recent.xml"
    description = "Recently updated zPages"

    def items(self):
        # Published AND from an active creator. An RSS feed republishes
        # `item_description` -- the page's own description -- to every
        # subscribed reader and aggregator, so a deactivated creator's article
        # kept being syndicated after the takedown, to caches we do not
        # control.
        return _chronological_zpages(zPage.objects.published_and_active())

    def item_title(self, item):
        return item.title

    def item_description(self, item):
        return item.description or 'No description available'

    def item_link(self, item):
        # Feeds are first-party public emitters. Keep get_url/get_absolute_url
        # backward-compatible for API consumers, but do not mint another
        # legacy /{username}/zpage/{slug} link after the Stage-4 cutover.
        return item.get_public_url()

    def item_enclosure_url(self, item):
        if item.enclosure and item.enclosure.file:
            return f"https://free2z.com{item.enclosure.get_url()}"
        return ''

    def item_enclosure_length(self, item):
        if item.enclosure and item.enclosure.file:
            return item.enclosure.file.size
        return 0

    def item_enclosure_mime_type(self, item):
        if item.enclosure:
            return item.enclosure.mime_type
        return ''

    def item_updateddate(self, item):
        # Assuming `updated_at` is the field representing the last update time
        return item.updated_at

    def item_pubdate(self, item):
        return getattr(item, 'published_at', None) or item.created_at

    def ttl(self):
        # one hour
        return 60

    def item_categories(self, item):
        """
        Takes an item, as returned by items(), and returns the item's
        categories.
        """
        return item.tags.all()


class PodcastFeed(zPageFeed):
    title = "Latest Podcasts"
    link = "/feeds/podcasts/recent.xml"  # URL to the feed
    description = "Recently updated Podcasts"

    def items(self):
        return _chronological_zpages(zPage.objects.published_and_active().filter(
            enclosure__mime_type__in=PODCAST_MIME_TYPES,
        ))


class UserZpagesFeed(zPageFeed):
    def get_object(self, request, username):
        # Retrieve the user based on the username from the URL
        # A bad username in the URL must be a 404, not an unhandled
        # DoesNotExist -> 500.
        #
        # `is_active=True`: a per-user feed is that creator's own
        # syndication surface. After a deactivation the item queryset is empty
        # anyway, but without this the route still answers 200 with a
        # `<title>{username}'s Latest zPages</title>` -- a live, indexable
        # document naming a banned account. `/{username}` already 404s; so
        # does this now.
        return get_object_or_404(User, username=username, is_active=True)

    def items(self, obj):
        # Override items method to filter zPages by user
        return _chronological_zpages(zPage.objects.published_and_active().filter(
            creator=obj,
        ))

    def title(self, obj):
        # Optionally customize the feed title for the user
        return f"{obj.username}'s Latest zPages"

    def link(self, obj):
        # Optionally customize the link for the user's feed
        return f"/feeds/{obj.username}/zpages/recent.xml"

    def description(self, obj):
        # Optionally customize the feed description for the user
        return f"Recently updated zPages by {obj.username}"


class UserPodcastsFeed(UserZpagesFeed):
    def items(self, obj):
        # Override items method to filter zPages by user
        return _chronological_zpages(zPage.objects.published_and_active().filter(
            creator=obj,
            enclosure__mime_type__in=PODCAST_MIME_TYPES,
        ))

    def title(self, obj):
        # Optionally customize the feed title for the user
        return f"{obj.username}'s Latest Podcasts"

    def link(self, obj):
        # Optionally customize the link for the user's feed
        return f"/feeds/{obj.username}/podcasts/recent.xml"

    def description(self, obj):
        # Optionally customize the feed description for the user
        return f"Recently updated Podcasts by {obj.username}"


class UserAIFeed(AIFeed):

    def get_object(self, request, username):
        # Retrieve the user based on the username from the URL
        # A bad username in the URL must be a 404, not an unhandled
        # DoesNotExist -> 500.
        #
        # `is_active=True`: a per-user feed is that creator's own
        # syndication surface. After a deactivation the item queryset is empty
        # anyway, but without this the route still answers 200 with a
        # `<title>{username}'s Latest AI Conversations</title>` -- a live,
        # indexable
        # document naming a banned account. `/{username}` already 404s; so
        # does this now.
        return get_object_or_404(User, username=username, is_active=True)

    def items(self, obj):
        # Override items method to filter zPages by user
        # Security: as with AIFeed, a per-user feed is still an
        # anonymous public feed -- exclude subscriber-only conversations.
        return Conversation.objects.filter(
            user=obj,
            is_public=True,
            user__is_active=True,
            is_subscriber_only=False,
        ).order_by('-updated_at')[:100]

    def title(self, obj):
        # Optionally customize the feed title for the user
        return f"{obj.username}'s Latest AI Conversations"

    def link(self, obj):
        # Optionally customize the link for the user's feed
        return f"/feeds/{obj.username}/ai/recent.xml"

    def description(self, obj):
        # Optionally customize the feed description for the user
        return f"Recently updated AI Conversations by {obj.username}"


class UserConverseFeed(ConverseFeed):

    def get_object(self, request, username):
        # Retrieve the user based on the username from the URL
        # A bad username in the URL must be a 404, not an unhandled
        # DoesNotExist -> 500.
        #
        # `is_active=True`: a per-user feed is that creator's own
        # syndication surface. After a deactivation the item queryset is empty
        # anyway, but without this the route still answers 200 with a
        # `<title>{username}'s Latest Converse Comments</title>` -- a live,
        # indexable
        # document naming a banned account. `/{username}` already 404s; so
        # does this now.
        return get_object_or_404(User, username=username, is_active=True)

    def items(self, obj):
        # Public RSS of one user's converse posts — same parent-visibility gate
        # as ConverseFeed so a user's replies on hidden threads don't leak.
        return scope_comments_to_visible_parents(
            Comment.objects.filter(author=obj), None
        ).order_by('-updated_at')[:100]

    def title(self, obj):
        # Optionally customize the feed title for the user
        return f"{obj.username}'s Latest Converse Comments"

    def link(self, obj):
        # Optionally customize the link for the user's feed
        return f"/feeds/{obj.username}/converse/recent.xml"

    def description(self, obj):
        # Optionally customize the feed description for the user
        return f"Recently updated Converse Comments by {obj.username}"
