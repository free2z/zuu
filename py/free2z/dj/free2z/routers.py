"""Router with an explicitly-public API root.

``rest_framework.routers.APIRootView`` does not declare ``permission_classes``,
so it inherits ``DEFAULT_PERMISSION_CLASSES`` — which is now
``IsAuthenticated``. The root is just a listing of route names, all of
which are already published anonymously by ``/api/schema/``, so locking it
would be a behaviour change with no security value.

Use ``Free2zRouter`` instead of ``DefaultRouter`` everywhere, so the
"every DRF view declares its permissions explicitly" invariant enforced by
``dj/tests/test_permission_inventory.py`` holds with no allowlist.
"""

from rest_framework import routers
from rest_framework.permissions import AllowAny


class PublicAPIRootView(routers.APIRootView):
    """The browsable route index — public, as it has always been."""

    permission_classes = [AllowAny]


class Free2zRouter(routers.DefaultRouter):
    APIRootView = PublicAPIRootView
