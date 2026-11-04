from django.urls import path, include
from dj.apps.pricing.views import AICatalogView
from dj.free2z.routers import Free2zRouter
from .views import (
    AIModelViewSet, ConversationViewSet, CreatorAIOptionsView, MeteredPromptView,
    PromptResponseViewSet, PublicConversationViewSet,
    PublicPromptResponseViewSet, AIPersonalityViewSet,
)

router = Free2zRouter()
# Public endpoints
router.register('models', AIModelViewSet, basename='models')
router.register('personalities', AIPersonalityViewSet, basename='personalities')
router.register(
    'public-conversations', PublicConversationViewSet,
    basename='public-conversations')
router.register(
    'public-conversations/(?P<conversation_id>[0-9a-f-]+)/promptresponses',
    PublicPromptResponseViewSet, basename='public-promptresponses')
# Private endpoints
router.register('conversations', ConversationViewSet, basename='conversations')
router.register(
    'conversations/(?P<conversation_id>[0-9a-f-]+)/promptresponses',
    PromptResponseViewSet, basename='promptresponses')

urlpatterns = [
    path('', include(router.urls)),
    # Synchronous metered prompt: one prompt to a catalogue model,
    # priced on real tokens, no conversation row. The legacy flat-rate
    # `/api/openai/prompt` stays where it is.
    path('prompt/', MeteredPromptView.as_view(), name='ai-prompt'),
    # Creator cover/text choices and a text maximum-hold quote. Both are
    # resolved against the same live policy/configuration as generation.
    path('creator-options/', CreatorAIOptionsView.as_view(), name='ai-creator-options'),
    # The signed model catalogue the f2z-ai gateway prices from. No
    # trailing slash: the path is the contract zuu docs/free2z/ai-gateway names, and
    # `v1` is the catalogue's signing-label version, not a DRF route.
    path('catalog/v1', AICatalogView.as_view(), name='ai-catalog-v1'),
]
