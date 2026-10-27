from django.urls import path
from .views import (
    zPageFeed, UserZpagesFeed, PodcastFeed, UserPodcastsFeed,
    UserAIFeed, UserConverseFeed, AIFeed, ConverseFeed
)


urlpatterns = [
    path('<str:username>/ai/recent.xml', UserAIFeed(), name='user_ai_feed'),
    path('<str:username>/converse/recent.xml', UserConverseFeed(), name='user_converse_feed'),
    path('<str:username>/podcasts/recent.xml', UserPodcastsFeed(), name='user_podcasts_feed'),
    path('<str:username>/zpages/recent.xml', UserZpagesFeed(), name='user_zpages_feed'),
    path('zpages/recent.xml', zPageFeed(), name='zpages_feed'),
    path('podcasts/recent.xml', PodcastFeed(), name='podcasts_feed'),
    path('converse/recent.xml', ConverseFeed(), name='converse_feed'),
    path('ai/recent.xml', AIFeed(), name='ai_feed'),
]
