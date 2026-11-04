from django.urls import path
from .views import SetupOTPView, RetrieveOTPStatusView, EnableOTPView, DisableOTPView, LoginWithOTPView


urlpatterns = [
    path('status/', RetrieveOTPStatusView.as_view(), name='mfa_status'),
    path('setup/', SetupOTPView.as_view(), name='setup_mfa'),
    path('enable/', EnableOTPView.as_view(), name='enable_mfa'),
    path('disable/', DisableOTPView.as_view(), name='disable_mfa'),
    path('login/', LoginWithOTPView.as_view(), name='login_with_mfa'),
]
