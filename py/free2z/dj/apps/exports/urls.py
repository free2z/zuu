from django.urls import path
from . import views

urlpatterns = [
    path('account/', views.AccountExportCreateView.as_view(), name='account_export_create'),
    path('account/latest/', views.AccountExportLatestView.as_view(), name='account_export_latest'),
    path('account/<uuid:id>/', views.AccountExportDetailView.as_view(), name='account_export_detail'),
    path('account/<uuid:id>/download/', views.AccountExportDownloadView.as_view(), name='account_export_download'),
    path('publications/', views.PublicationExportListCreateView.as_view(), name='publication_exports_list_create'),
    path('publications/<uuid:id>/', views.PublicationExportDetailView.as_view(), name='publication_exports_detail'),
    path('publications/<uuid:id>/download/', views.PublicationExportDownloadView.as_view(), name='publication_exports_download'),
]
