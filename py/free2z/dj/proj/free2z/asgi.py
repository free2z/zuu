import os

from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'dj.proj.free2z.settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    # This project used to route `dj.apps.efm`'s ws/signaling/<group_id>/
    # consumer here. The EFM/FROST experiment is OFFLINE -- see the module
    # docstring in dj/apps/efm/__init__.py before re-adding it.
    "websocket": AuthMiddlewareStack(URLRouter([])),
})
