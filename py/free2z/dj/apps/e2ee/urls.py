"""Mounted at ``/api/e2ee/`` from ``dj/free2z/urls.py``."""
from django.urls import path

from . import views

urlpatterns = [
    # `price/` is matched first, so it is never read as a username. The one
    # consequence, accepted by Contract A's choice of paths: an account whose
    # username is literally `price` cannot be sent a chat request here (the
    # POST answers 405 and charges nothing).
    path(
        'chat-requests/price/',
        views.ChatRequestPriceView.as_view(),
        name='e2ee_chat_request_price',
    ),
    path(
        'chat-requests/<str:username>/',
        views.ChatRequestView.as_view(),
        name='e2ee_chat_request',
    ),
]
