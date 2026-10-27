"""Mounted at ``/api/e2ee/`` from ``dj/free2z/urls.py``.

``/api/e2ee/`` is shared with other E2EE routes (the chat-request API lives
beside these), so every name here is specific to handles or the authority.
"""

from django.urls import path

from .views import AuthorityInfoView, HandleClaimView, HandleStatusView

urlpatterns = [
    path("handle/", HandleStatusView.as_view(), name="e2ee_handle"),
    path("handle/claim/", HandleClaimView.as_view(), name="e2ee_handle_claim"),
    path("authority/", AuthorityInfoView.as_view(), name="e2ee_authority"),
]
