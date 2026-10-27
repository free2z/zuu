from django.urls import path

from .views import (
    SocialStartView,
    SocialLoginView,
    SocialIdentityListView,
    SocialUnlinkView,
    SocialProvidersView,
    ZuuliMobileSocialProvidersView,
    ZuuliMobileOAuthRelayView,
)

urlpatterns = [
    # Literals first so they win over the '<provider>' captures below.
    path('', SocialIdentityListView.as_view(), name='social_list'),
    path('providers/', SocialProvidersView.as_view(), name='social_providers'),
    path('mobile/providers/', ZuuliMobileSocialProvidersView.as_view(),
         name='zuuli_mobile_social_providers'),
    path('mobile/callback', ZuuliMobileOAuthRelayView.as_view(),
         name='zuuli_mobile_oauth_relay'),
    path('<str:provider>/start', SocialStartView.as_view(), name='social_start'),
    path('<str:provider>/', SocialLoginView.as_view(), name='social_login'),
    path('<str:provider>/<str:uid>/', SocialUnlinkView.as_view(),
         name='social_unlink'),
]
