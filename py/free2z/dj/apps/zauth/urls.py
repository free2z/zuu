from django.urls import path

from .views import ZcashChallengeView, ZcashLoginView

urlpatterns = [
    path('challenge/', ZcashChallengeView.as_view(), name='zcash_challenge'),
    path('login/', ZcashLoginView.as_view(), name='zcash_login'),
]
