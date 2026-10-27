"""``/api/sdk/v1/`` -- the SDK contract root (zuu docs/free2z/sdk/spec).

Every view here subclasses ``dj.free2z.sdk_api.SdkAPIView`` so every non-2xx
is the errors.md §1 envelope. The catch-all MUST stay last.
"""
from django.urls import include, path, re_path

from dj.free2z.sdk_api import SdkNotFoundView
from dj.apps.oidc.ai_reports import SdkCallReportView
from dj.apps.oidc.sdk_grant import SdkGrantView

urlpatterns = [
    path("grant", SdkGrantView.as_view(), name="sdk-grant"),
    path("calls/<uuid:call_id>/report", SdkCallReportView.as_view(), name="sdk-call-report"),
    path("", include("dj.apps.purchases.urls")),
    re_path(r"^.*$", SdkNotFoundView.as_view(), name="sdk-not-found"),
]
