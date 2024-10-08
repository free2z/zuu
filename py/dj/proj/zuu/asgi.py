import os

from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack

from dj.apps.efm import routing as efm_routing

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'dj.proj.zuu.settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(
            efm_routing.websocket_urlpatterns
        )
    ),
})
