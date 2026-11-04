from django.urls import path
from . import views

urlpatterns = [
    path('publications/', views.PublicationExportListCreateView.as_view(), name='publication_exports_list_create'),
    path('publications/<uuid:id>/', views.PublicationExportDetailView.as_view(), name='publication_exports_detail'),
    path('publications/<uuid:id>/download/', views.PublicationExportDownloadView.as_view(), name='publication_exports_download'),
]
