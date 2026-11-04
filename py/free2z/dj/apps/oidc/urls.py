"""Mounted at ``/api/oauth/`` (dj/free2z/urls.py). Discovery is also mounted
at the site root ``/.well-known/openid-configuration`` there, which the
nginx exact location forwards to Django in production."""
from django.urls import path

from .ai_reports import DeveloperAppReportsView
from .developer import (
    DeveloperAppDetailView,
    DeveloperAppListView,
    DeveloperAppRotateSecretView,
)
from .views import (
    AuthorizeView,
    DiscoveryView,
    GrantCapView,
    GrantListView,
    GrantRevokeView,
    InternalEpochView,
    IntrospectView,
    JwksView,
    RevokeView,
    TokenView,
    UserInfoView,
)

urlpatterns = [
    path("authorize", AuthorizeView.as_view(), name="oidc-authorize"),
    path("token", TokenView.as_view(), name="oidc-token"),
    path("revoke", RevokeView.as_view(), name="oidc-revoke"),
    path("introspect", IntrospectView.as_view(), name="oidc-introspect"),
    path("userinfo", UserInfoView.as_view(), name="oidc-userinfo"),
    path("jwks", JwksView.as_view(), name="oidc-jwks"),
    path(".well-known/openid-configuration", DiscoveryView.as_view(),
         name="oidc-discovery"),
    path("grants/", GrantListView.as_view(), name="oidc-grants"),
    path("grants/<uuid:application_id>/", GrantRevokeView.as_view(),
         name="oidc-grant-revoke"),
    path("grants/<uuid:application_id>/cap/", GrantCapView.as_view(),
         name="oidc-grant-cap"),
    # The developer console (spec §2): the requester's own apps only.
    path("apps/", DeveloperAppListView.as_view(), name="oidc-developer-apps"),
    path("apps/<uuid:app_id>/", DeveloperAppDetailView.as_view(),
         name="oidc-developer-app"),
    path("apps/<uuid:app_id>/rotate-secret/", DeveloperAppRotateSecretView.as_view(),
         name="oidc-developer-app-rotate-secret"),
    path("apps/<uuid:app_id>/reports/", DeveloperAppReportsView.as_view(),
         name="oidc-developer-app-reports"),
    path("internal/epoch/<uuid:subject>/", InternalEpochView.as_view(),
         name="oidc-internal-epoch"),
]
