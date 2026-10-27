from django.urls import path, include
from dj.free2z.routers import Free2zRouter

from dj.apps.g12f.views.follow import (
    MyCreatorBlockViewSet, MyCreatorFollowViewSet,
)
from dj.apps.g12f.views.series import (
    MySeriesViewSet, zPageClearLegacyView, zPageClearView, ZPageSeriesViewSet
)

router = Free2zRouter()
router.register(r'series/mine', MySeriesViewSet, basename='series_mine')
# "creators I follow". The per-creator toggle is a detail action on
# CreatorView (/api/creator/{username}/follow/) because it is addressed by the
# creator; this one is addressed by the caller and takes no username at all.
router.register(
    r'follows/mine', MyCreatorFollowViewSet, basename='follows_mine',
)
# "accounts I blocked", addressed by the caller like follows/mine.
router.register(
    r'blocks/mine', MyCreatorBlockViewSet, basename='blocks_mine',
)

urlpatterns = [
    path('', include(router.urls)),
    # The deletion target is a path segment, not a query parameter: a path
    # segment identifies the resource being mutated, which is exactly what
    # this DELETE does. (The path is logged too — nginx records the full
    # request line either way — so this is a contract fix, not a secrecy one:
    # the old form was undocumented and 404-ed on an absent target.) See.
    path('series/clear-zpage/<str:free2zaddr>/', zPageClearView.as_view(),
         name='series_clear_zpage'),
    # Deprecated `?free2zaddr=` alias, kept for one release so cached classic
    # bundles keep working. Remove with the classic UI.
    path('series/clear-zpage/', zPageClearLegacyView.as_view(),
         name='series_clear_zpage_legacy'),
    path('zpage/<str:free2zaddr>/series/',
         ZPageSeriesViewSet.as_view({'get': 'retrieve'}),
         name='zpage_series'),

]
