from django.urls import path
from .views import (
    EventAPIView, mark_event_as_read, mark_all_events_as_read,
    unread_count, has_events, MentionPreferenceView
)

urlpatterns = [
    path('', EventAPIView.as_view(), name='events'),
    path('unread_count/', unread_count, name='events_unread_count'),
    path('has/', has_events, name='events_has'),
    path('mention-preference/', MentionPreferenceView.as_view(), name='mention_preference'),
    path('read/all/', mark_all_events_as_read, name="events_read"),
    path('read/<str:event_id>/', mark_event_as_read, name="event_read"),
]
