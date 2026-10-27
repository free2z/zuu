"""Channels routing for the FROST signalling socket. **Not in any ASGI router.**

The app is OFFLINE (see ``dj/apps/efm/__init__.py``). Kept so re-enabling is
one line; only ``tests/test_signaling_consumer.py`` builds a ``URLRouter``
from this list, so the handshake-auth regression tests still run.
"""

from django.urls import path
from .consumers import SignalingConsumer

websocket_urlpatterns = [
    path('ws/signaling/<str:group_id>/', SignalingConsumer.as_asgi()),
]
