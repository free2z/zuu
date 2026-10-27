from django.urls import include, path, register_converter
from dj.free2z.routers import Free2zRouter

from . import views
from .recording_control import (RecordingControl, RecordingStopControl,
                                PrivateRecordingControl, PrivateRecordingStopControl)
from .converters import PublicMeetingTypeConverter

# The public meeting type is an enum, not free text — see converters.py and
# issue. Registering it here means an unknown type never resolves to a
# view, so it can never reach the database or the paid provider API.
register_converter(PublicMeetingTypeConverter, 'meeting_type')

router = Free2zRouter()
router.register(r'public', views.PublicMeetingViewSet, basename='public-meeting')

urlpatterns = [
    path('<str:username>/private/<uuid:secret>/recording/stop', PrivateRecordingStopControl.as_view(), name='private_recording_stop'),
    path('<str:username>/private/<uuid:secret>/recording', PrivateRecordingControl.as_view(), name='private_recording_control'),
    path('<str:username>/recording/stop', RecordingStopControl.as_view(), name='recording_stop'),
    path('<str:username>/recording', RecordingControl.as_view(), name='recording_control'),
    path(
        'webhook',
        views.webhook,
        name="webhook"
    ),
    # Legacy recording-only webhook. Kept alive (the provider may still call
    # it) but now signature-verified like `webhook` — see the note in views.py.
    path(
        'webhook-recording-status-update/',
        views.webhook_recording_status_update,
        name="webhook_recording_status_update"
    ),
    path('', include(router.urls)),
    path(
        '<str:username>/live-status',
        views.live_meeting_status,
        name='live_meeting_status'
    ),
    # Ahead of `<meeting_type:type>`, although that converter could never
    # match `host-session` anyway (closed enum).
    path(
        '<str:username>/host-session',
        views.HostSession.as_view(),
        name='host_session'
    ),
    path('<str:username>/private',
        views.PrivateMeetingManage.as_view(),
        name='private_meeting'),
    path('<str:username>/private/<uuid:secret>',
        views.PrivateMeeting.as_view(),
        name='private_meeting'),
    path(
        '<str:username>/<meeting_type:type>',
        views.DyteMeeting.as_view(),
        name='dyte_meeting'
    ),

]
