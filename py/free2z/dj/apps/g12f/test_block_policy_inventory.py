"""Every registered DRF list must receive an explicit block-policy decision.

The URL walker, not the inventory, decides which list endpoints exist. See
 docs/free2z/backend/block-visibility.md for the corresponding contract.
"""
from django.urls import URLPattern, URLResolver, get_resolver, path
from django.contrib.syndication.views import Feed
from django.test import Client
from django.urls import resolve
import pytest
from rest_framework import generics
from rest_framework.decorators import action
from rest_framework.mixins import ListModelMixin
from rest_framework.viewsets import ViewSet
from rest_framework.test import APIClient
from .test_block_filtering import trio as trio

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

# Every content policy must execute a database-backed behavioral test that
# actually requests that route. Exemptions are limited to ownership,
# relationship management, financial records, and the system catalogue.
CONTENT_PROBES = {
    'comment-list-create': 'test_reply_list_and_bulk_list_hide_the_blocked_author',
    'comments-for-content': 'test_comment_thread_hides_the_blocked_author_from_the_blocker_only',
    'comment-replies': 'test_reply_list_and_bulk_list_hide_the_blocked_author',
    'events': 'test_notifications_hide_contact_but_keep_money_receipts',
    'series_mine-list': 'test_owned_series_editor_hides_blocked_members_without_deleting_them',
    'follows_mine-list': 'test_creator_directory_and_follow_list_hide_blocked_accounts',
    'zpage-list': 'test_zpage_lists_hide_the_blocked_creator_from_the_blocker',
    'creator-list': 'test_creator_directory_and_follow_list_hide_blocked_accounts',
    'personalities-list': 'test_personality_list_filters_blocked_creator_but_keeps_system_personalities',
    'public-conversations-list': 'test_public_ai_lists_filter_conversation_and_transcript_authors',
    'public-promptresponses-list': 'test_public_ai_lists_filter_conversation_and_transcript_authors',
    'promptresponses-list': 'test_owned_conversation_hides_blocked_transcript_authors',
    'public-meeting-list': 'test_live_list_and_discovery_filter_before_counting',
    'conversations-public': 'test_public_ai_lists_filter_conversation_and_transcript_authors',
    'public-meeting-discovery': 'test_live_list_and_discovery_filter_before_counting',
    'zpage-related': 'test_related_pages_do_not_recommend_a_blocked_creator',
    **{name: 'test_all_feeds_use_session_block_and_preserve_public_visibility' for name in (
        'ai_feed', 'converse_feed', 'zpages_feed', 'podcasts_feed',
        'user_ai_feed', 'user_converse_feed', 'user_zpages_feed', 'user_podcasts_feed',
    )},
}

EXEMPT_ROUTES = {
    'blocks_mine-list', 'models-list', 'conversations-list',
    'tuzis_mysubscribers', 'tuzis_mysubscriptions', 'transaction-list',
    'storytime_mystories', 'myuploads-list', 'zpage-variant-list',
    'zpage-variant-retrieve', 'creator-block', 'creator-follow', 'creator-mute',
}


def run_probe(route, probe, arguments, monkeypatch):
    seen = set()
    original_api_get = APIClient.get
    original_client_get = Client.get

    def record(original):
        def get(client, url, *args, **kwargs):
            seen.add(resolve(url.split('?', 1)[0]).url_name)
            return original(client, url, *args, **kwargs)
        return get

    monkeypatch.setattr(APIClient, 'get', record(original_api_get))
    monkeypatch.setattr(Client, 'get', record(original_client_get))
    probe(**arguments)
    assert route in seen, f'{route} was not exercised by its behavioral probe'


@pytest.mark.django_db
@pytest.mark.parametrize('route,probe_name', CONTENT_PROBES.items())
def test_content_policy_executes_on_its_registered_route(route, probe_name, trio, creator_factory, monkeypatch):
    from . import test_block_filtering
    from dj.apps.feeds import test_block_visibility

    probe = getattr(test_block_visibility if route.endswith('_feed') else test_block_filtering, probe_name)
    if route.endswith('_feed'):
        arguments = {'creator_factory': creator_factory, 'monkeypatch': monkeypatch}
    else:
        arguments = {'trio': trio}
    run_probe(route, probe, arguments, monkeypatch)


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
                elif pattern.name not in CONTENT_PROBES and pattern.name not in EXEMPT_ROUTES:
                    missing.add(f'{route}: feed lacks executable policy')
                continue
            cls = getattr(callback, 'cls', None) or getattr(callback, 'view_class', None)
            actions = getattr(callback, 'actions', {})
            if not cls:
                continue
            method = actions.get('get')
            if method and method not in ('list', 'retrieve'):
                if (pattern.name, method) not in EXTRA_POLICIES:
                    missing.add(f'{route}: action {cls.__name__}.{method}')
                elif pattern.name not in CONTENT_PROBES and pattern.name not in EXEMPT_ROUTES:
                    missing.add(f'{route}: action lacks executable policy')
            is_list = actions.get('get') == 'list' or (
                not actions and issubclass(cls, ListModelMixin)
            )
            if is_list:
                name = f'{cls.__module__}.{cls.__qualname__}'
                if name not in POLICIES or POLICIES[name][1] != pattern.name:
                    missing.add(f'{route}: {name}')
                elif pattern.name not in CONTENT_PROBES and pattern.name not in EXEMPT_ROUTES:
                    missing.add(f'{route}: list lacks executable policy')
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


@pytest.mark.django_db
def test_classified_new_content_route_without_filter_fails_behavior(trio, monkeypatch, settings):
    from types import ModuleType
    from rest_framework.response import Response
    from dj.apps.g12f.models import Creator

    class UnfilteredContent(generics.ListAPIView):
        def list(self, request, *args, **kwargs):
            return Response(list(Creator.objects.values_list('username', flat=True)))

    module = ModuleType('synthetic_block_policy_urls')
    module.urlpatterns = [path('content/', UnfilteredContent.as_view(), name='synthetic-content')]
    settings.ROOT_URLCONF = module
    name = f'{UnfilteredContent.__module__}.{UnfilteredContent.__qualname__}'
    monkeypatch.setitem(POLICIES, name, ('creator', 'synthetic-content'))
    monkeypatch.setitem(CONTENT_PROBES, 'synthetic-content', 'synthetic_probe')
    assert not unclassified_lists(module.urlpatterns)
    blocker, blocked, bystander = trio

    def synthetic_probe():
        from .test_block_filtering import client_for
        assert blocked.username in client_for(bystander).get('/content/').json()
        assert blocked.username in APIClient().get('/content/').json()
        assert blocked.username not in client_for(blocker).get('/content/').json()

    with pytest.raises(AssertionError):
        run_probe('synthetic-content', synthetic_probe, {}, monkeypatch)


@pytest.mark.django_db
def test_removing_existing_filter_breaks_its_behavioral_probe(trio, monkeypatch):
    from .test_block_filtering import test_zpage_lists_hide_the_blocked_creator_from_the_blocker
    from dj.apps.g12f.views import zpage

    monkeypatch.setattr(zpage, 'exclude_blocked', lambda queryset, user, field: queryset)
    with pytest.raises(AssertionError):
        run_probe('zpage-list', test_zpage_lists_hide_the_blocked_creator_from_the_blocker,
                  {'trio': trio}, monkeypatch)
