# routing.py
from django.urls import path
from .consumers import SignalingConsumer

websocket_urlpatterns = [
    path('ws/signaling/<str:group_id>/', SignalingConsumer.as_asgi()),
]
