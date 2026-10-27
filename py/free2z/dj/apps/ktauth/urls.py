"""One route. Mounted at ``/api/kt/`` from ``dj/free2z/urls.py``.

The prefix is the log's namespace rather than the app's, because that is what a
client is talking to: ``/api/kt/handle-assertion/`` is the platform's half of
the key-transparency protocol, and if a second piece of it ever needs a Django
endpoint it belongs beside this one.
"""

from django.urls import path

from .views import HandleAssertionView

urlpatterns = [
    path(
        'handle-assertion/',
        HandleAssertionView.as_view(),
        name='kt_handle_assertion',
    ),
]
