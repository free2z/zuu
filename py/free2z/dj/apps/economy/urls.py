from django.urls import path

from . import views

urlpatterns = [
    path('capabilities/', views.CapabilitiesView.as_view(), name='economy-capabilities'),
    path('earnings/', views.EarningsView.as_view(), name='economy-earnings'),
    path('agreement/', views.AgreementView.as_view(), name='economy-agreement'),
    path('agreement/accept/', views.AcceptAgreementView.as_view(), name='economy-agreement-accept'),
    path('payments/', views.PaymentsView.as_view(), name='economy-payments'),
    path('payments/<uuid:payment_id>/', views.PaymentDetailView.as_view(), name='economy-payment-status'),
    path('usage-purchase-quote/', views.UsageQuoteView.as_view(), name='economy-usage-purchase-quote'),
    path('usage-purchases/', views.UsagePurchasesView.as_view(), name='economy-usage-purchases'),
    path('funding-resolutions/', views.FundingResolutionsView.as_view(), name='economy-funding-resolutions'),
]
