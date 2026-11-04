from django.urls import path

from .views import ZuuliCapabilitiesView


urlpatterns = [
    path("capabilities/", ZuuliCapabilitiesView.as_view(), name="zuuli_capabilities"),
]
