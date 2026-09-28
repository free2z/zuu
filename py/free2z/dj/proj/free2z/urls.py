from django.urls import path, include


urlpatterns = [
    path("api/efm/", include('dj.apps.efm.urls')),
]
