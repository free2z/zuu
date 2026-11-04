from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r'ws/conversations/(?P<conversation_id>[A-Fa-f0-9\-]{36})/$',
            consumers.ConversationConsumer.as_asgi()),
]
