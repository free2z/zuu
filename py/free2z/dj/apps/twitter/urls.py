from django.urls import path
from .views import (
    TwitterCallbackView, TwitterCallback1View, AuthorizeView,
    RequestTokenView, PublicStatusView, TwitterDeleteView
)

urlpatterns = [
    path('start', AuthorizeView.as_view(),
         name='twitter_start'),
    path('callback', TwitterCallbackView.as_view(),
         name="twitter_callback"),
    path('v1/request-token', RequestTokenView.as_view(),
         name="twitter1_request_token"),
    path('v1/access-token', TwitterCallback1View.as_view(),
         name="twitter1_access_token"),
    path('public-status/', PublicStatusView.as_view(),
         name="public_status"),
    path('delete', TwitterDeleteView.as_view(), name='delete-twitter'),
]
