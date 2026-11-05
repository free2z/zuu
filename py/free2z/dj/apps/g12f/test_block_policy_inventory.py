"""Every registered DRF list must receive an explicit block-policy decision.

The URL walker, not the inventory, decides which list endpoints exist. See
 docs/free2z/backend/block-visibility.md for the corresponding contract.
"""
from django.urls import URLPattern, URLResolver, get_resolver, path
from django.contrib.syndication.views import Feed
from rest_framework import generics
from rest_framework.decorators import action
from rest_framework.mixins import ListModelMixin
from rest_framework.viewsets import ViewSet

# Qualified class names avoid importing every app just to enumerate routes.
# Content lists are covered by API behaviour tests in test_block_filtering.
POLICIES = {
    'dj.apps.comments.views.CommentViewSet': ('author', 'comment-list-create'),
    'dj.apps.comments.views.CommentListCreateAPIView': ('author', 'comments-for-content'),
    'dj.apps.comments.views.ParentCommentListCreateAPIView': ('author', 'comment-replies'),
    'dj.apps.events.views.EventAPIView': ('contact events; retain receipts', 'events'),
    'dj.apps.g12f.views.series.MySeriesViewSet': ('owner; nested pages filtered', 'series_mine-list'),
    'dj.apps.g12f.views.follow.MyCreatorFollowViewSet': ('creator', 'follows_mine-list'),
    'dj.apps.g12f.views.follow.MyCreatorBlockViewSet': ('owner block management', 'blocks_mine-list'),
    'dj.apps.g12f.views.zpage.zPageView': ('creator', 'zpage-list'),
    'dj.apps.g12f.views.creator.CreatorView': ('creator', 'creator-list'),
    'dj.apps.openai.views.AIModelViewSet': ('system catalogue', 'models-list'),
    'dj.apps.openai.views.AIPersonalityViewSet': ('creator', 'personalities-list'),
    'dj.apps.openai.views.PublicConversationViewSet': ('user', 'public-conversations-list'),
    'dj.apps.openai.views.PublicPromptResponseViewSet': ('user and conversation owner', 'public-promptresponses-list'),
    'dj.apps.openai.views.ConversationViewSet': ('owner', 'conversations-list'),
    'dj.apps.openai.views.PromptResponseViewSet': ('owner conversation', 'promptresponses-list'),
    'dj.apps.tuzis.views.MySubscribersListView': ('financial relationships', 'tuzis_mysubscribers'),
    'dj.apps.tuzis.views.MySubscriptionsListView': ('financial relationships', 'tuzis_mysubscriptions'),
    'dj.apps.ztripe.views.TransactionViewSet': ('financial receipts', 'transaction-list'),
    'dj.apps.dyte.views.PublicMeetingViewSet': ('creator', 'public-meeting-list'),
    'dj.apps.storytime.views.MyStories': ('owner', 'storytime_mystories'),
    'dj.apps.uploads.views.MyUploadsViewSet': ('owner', 'myuploads-list'),
}

# All custom GET actions, including detail actions, are reviewed: a newly
# routed action cannot silently serve a list behind an existing view class.
EXTRA_POLICIES = {
    ('conversations-public', 'public'): 'public conversations: filter owner',
    ('public-meeting-discovery', 'discovery'): 'filter creator before limits',
    ('zpage-related', 'related'): 'filter recommended page creator',
    ('zpage-variant-list', 'variant_list'): 'variants of directly requested page',
    ('zpage-variant-retrieve', 'variant_retrieve'): 'variant of directly requested page',
    ('creator-block', 'block'): 'caller-owned block state',
    ('creator-follow', 'follow'): 'caller-owned follow state and counts',
    ('creator-mute', 'mute'): 'caller-owned mute state',
    ('ai_feed', 'AIFeed'): 'filter conversation and transcript author',
    ('converse_feed', 'ConverseFeed'): 'filter comment author',
    ('zpages_feed', 'zPageFeed'): 'filter creator',
    ('podcasts_feed', 'PodcastFeed'): 'filter creator',
    ('user_ai_feed', 'UserAIFeed'): 'filter conversation and transcript author',
    ('user_converse_feed', 'UserConverseFeed'): 'filter comment author',
    ('user_zpages_feed', 'UserZpagesFeed'): 'filter creator',
    ('user_podcasts_feed', 'UserPodcastsFeed'): 'filter creator',
}


def unclassified_lists(patterns, prefix=''):
    missing = set()
    for pattern in patterns:
        route = prefix + str(pattern.pattern)
        if isinstance(pattern, URLResolver):
            missing.update(unclassified_lists(pattern.url_patterns, route))
        elif isinstance(pattern, URLPattern):
            callback = pattern.callback
            if isinstance(callback, Feed):
                key = (pattern.name, type(callback).__name__)
                if key not in EXTRA_POLICIES:
                    missing.add(f'{route}: feed {type(callback).__name__}')
                continue
            cls = getattr(callback, 'cls', None) or getattr(callback, 'view_class', None)
            actions = getattr(callback, 'actions', {})
            if not cls:
                continue
            method = actions.get('get')
            if method and method not in ('list', 'retrieve'):
                if (pattern.name, method) not in EXTRA_POLICIES:
                    missing.add(f'{route}: action {cls.__name__}.{method}')
            is_list = actions.get('get') == 'list' or (
                not actions and issubclass(cls, ListModelMixin)
            )
            if is_list:
                name = f'{cls.__module__}.{cls.__qualname__}'
                if name not in POLICIES or POLICIES[name][1] != pattern.name:
                    missing.add(f'{route}: {name}')
    return missing


def test_registered_lists_have_a_policy():
    assert not unclassified_lists(get_resolver().url_patterns)


def test_new_registered_list_without_policy_is_rejected():
    class NewContentList(generics.ListAPIView):
        pass

    missing = unclassified_lists([path('new-content/', NewContentList.as_view())])
    assert len(missing) == 1
    assert 'NewContentList' in missing.pop()


def test_new_route_to_existing_list_also_needs_a_policy():
    from dj.apps.g12f.views.follow import MyCreatorFollowViewSet

    missing = unclassified_lists([
        path('new-follow-list/', MyCreatorFollowViewSet.as_view({'get': 'list'}),
             name='new-follow-list'),
    ])
    assert len(missing) == 1


def test_new_custom_action_and_feed_need_policies():
    class NewActions(ViewSet):
        @action(detail=False)
        def content(self, request):
            pass

    class NewFeed(Feed):
        pass

    missing = unclassified_lists([
        path('action/', NewActions.as_view({'get': 'content'}), name='new-action'),
        path('feed/', NewFeed(), name='new-feed'),
    ])
    assert len(missing) == 2
