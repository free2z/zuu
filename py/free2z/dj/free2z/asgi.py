import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application

from channels.auth import AuthMiddlewareStack

from dj.apps.events import routing as events_routing
from dj.apps.openai import routing as ai_routing


os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'dj.free2z.prod_settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(
            # `dj.apps.efm`'s ws/signaling/<group_id>/ route is intentionally
            # absent: the EFM/FROST experiment is OFFLINE. See the module
            # docstring in dj/apps/efm/__init__.py before re-adding it.
            ai_routing.websocket_urlpatterns +
            events_routing.websocket_urlpatterns
        )
    ),
})
