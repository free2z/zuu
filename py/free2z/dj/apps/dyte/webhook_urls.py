"""The isolated reader exposes only the two existing provider callbacks."""
from django.urls import path

from .views import webhook, webhook_recording_status_update

urlpatterns = [
    path('api/dyte/webhook', webhook),
    path('api/dyte/webhook-recording-status-update/', webhook_recording_status_update),
]
# /api/healthz is served before URL resolution by HealthCheckMiddleware.
