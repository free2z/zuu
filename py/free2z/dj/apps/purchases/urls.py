"""Mounted under ``/api/sdk/v1/`` by ``dj.free2z.sdk_urls`` (spec purchase.md
§1: base URL ``https://free2z.cash/api/sdk/v1``)."""
from django.urls import path

from . import balance, views

urlpatterns = [
    path("balance", balance.BalanceView.as_view(), name="sdk-balance"),
    path("purchases", views.PurchaseIntentCreateView.as_view(), name="sdk-purchase-create"),
    path(
        "purchases/<uuid:purchase_id>",
        views.PurchaseIntentDetailView.as_view(),
        name="sdk-purchase-detail",
    ),
]
