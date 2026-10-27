from django.urls import path
from . import views
from dj.free2z.routers import Free2zRouter

router = Free2zRouter()
router.register(r'transactions', views.TransactionViewSet,
                basename='transaction')

urlpatterns = [
    path('create-checkout-session/',
         views.create_checkout_session,
         name='stripe-create-checkout-session'),
    path('native-return/success/',
         views.native_checkout_success,
         name='stripe-native-return-success'),
    path('native-return/cancel/',
         views.native_checkout_cancel,
         name='stripe-native-return-cancel'),
    path('native-return/claim/',
         views.native_checkout_claim,
         name='stripe-native-return-claim'),
    path('native-return/status/',
         views.native_checkout_status,
         name='stripe-native-return-status'),
    path('webhook/',
         views.stripe_webhook,
         name='stripe-webhook'),
] + router.urls
