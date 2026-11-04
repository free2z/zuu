"""URLconf for the EFM router. **Not included by any project URLconf.**

The app is OFFLINE (see ``dj/apps/efm/__init__.py``). This module is kept so
re-enabling is one line -- but re-adding that line re-opens. Only
``dj/apps/efm/tests/urls.py`` mounts it, so the WebAuthn ceremony tests keep
exercising ``views.py`` while nothing serves it.
"""

from django.urls import path
from ninja import NinjaAPI
from .views import router as efm_router

api = NinjaAPI()

api.add_router("/", efm_router)

urlpatterns = [
    path("", api.urls),
]
