from django.urls import path
from .views import (
    UserProfileBasicInfoView, TaxFormUploadView, TaxFormDeleteView,
    GetTaxFormFileView, TaxFormSignatureView,
    IdentityDocumentsView, ChangeApplicationStatusView
)

urlpatterns = [
    path('change-status', ChangeApplicationStatusView.as_view(), name='change-application-status'),
    path('identity-documents', IdentityDocumentsView.as_view(), name='identity_documents'),
    path('tax-form-signature', TaxFormSignatureView.as_view(), name='tax_form_signature'),
    path('get-tax-form-file', GetTaxFormFileView.as_view(), name='get-tax-form-file'),
    path('upload-tax-form', TaxFormUploadView.as_view(), name='tax_form_upload'),
    path('delete-tax-form', TaxFormDeleteView.as_view(), name='tax_form_delete'),
    path('user-profile', UserProfileBasicInfoView.as_view(), name='user_profile'),
]
