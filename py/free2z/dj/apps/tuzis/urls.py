from django.urls import path
from . import views

urlpatterns = [
    path('donate/<str:username>',
         views.Donate2Z.as_view(),
         name='donate2z'),
    # Explicit names are a rollout boundary, not aliases. On a pre-contract
    # deployment these paths fail without side effects, so a client can deploy
    # only after the backend and can never have an old server silently ignore
    # its Idempotency-Key/expected-price contract. Legacy routes remain for
    # already-deployed clients; never fall back to them after ambiguity.
    path('donate-idempotent/<str:username>',
         views.IdempotentDonate2Z.as_view(),
         name='donate2z_idempotent'),
    path('my-subscribers',
         views.MySubscribersListView.as_view(),
         name="tuzis_mysubscribers"),
    path('my-subscriptions',
         views.MySubscriptionsListView.as_view(),
         name="tuzis_mysubscriptions"),
    path('my-subscriptions-summary',
         views.MySubscriptionRenewalSummaryView.as_view(),
         name="tuzis_my_subscription_renewal_summary"),
    path('subscribe/<str:username>',
         views.CreatorSubscribeView.as_view(),
         name='tuzis_subscribe'),
    path('subscribe-confirmed/<str:username>',
         views.ConfirmedSubscribeView.as_view(),
         name='tuzis_subscribe_confirmed'),
    path('subscribe-recovery/<int:creator_id>',
         views.SubscriptionIntentRecoveryView.as_view(),
         name='tuzis_subscribe_recovery'),
    path('subscription-status/<str:username>',
         views.SubscriptionStatusView.as_view(),
         name='tuzis_subscription_status'),
]
