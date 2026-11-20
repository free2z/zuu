from django.urls import path

from .views import ZcashChallengeView, ZcashLoginView, UsernameAvailabilityView

urlpatterns = [
    path('username-available/', UsernameAvailabilityView.as_view(), name='zcash_username_available'),
    path('challenge/', ZcashChallengeView.as_view(), name='zcash_challenge'),
    path('login/', ZcashLoginView.as_view(), name='zcash_login'),
]
