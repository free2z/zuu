from django.urls import path
from .views import (
    ConfirmEmailView, AddEmailView, EmailStatusView, ResendEmailView,
    ToggleEmailPublicView, ToggleEmailNotificationsView,
    DeleteEmailView, OptOutEmailView, ChangePasswordView, RequestResetPasswordView,
    ResetPasswordAPIView, PasswordIsSetView, RecoveryStatusView,
)

urlpatterns = [
    path('password-is-set', PasswordIsSetView.as_view(), name='password-is-set'),
    #. One authoritative answer to "can this account be recovered",
    # about the caller and nobody else. See RecoveryStatusView's docstring for
    # why a confirmed, mailable address is the whole definition.
    path(
        'recovery-status',
        RecoveryStatusView.as_view(),
        name='recovery-status',
    ),
    path('do-reset-password', ResetPasswordAPIView.as_view(), name='reset-password-api'),
    path('reset-password', RequestResetPasswordView.as_view(), name='reset-password'),
    path('change-password', ChangePasswordView.as_view(), name='change-password'),
    path('status', EmailStatusView.as_view(), name='email-status'),
    path('add', AddEmailView.as_view(), name='add-email'),
    path('resend', ResendEmailView.as_view(), name='resend-email'),
    path('confirm', ConfirmEmailView.as_view(), name='confirm-email'),
    path('public', ToggleEmailPublicView.as_view(), name='public-email'),
    path('notifications', ToggleEmailNotificationsView.as_view(), name='notifications-email'),
    path('delete', DeleteEmailView.as_view(), name='delete-email'),
    # ONE route, two shapes. `<link>` is normally the opaque signed
    # token `build_opt_out_url` now emits; it is also whatever an
    # already-delivered message put there, which is the URL-encoded email
    # address with `?token=` alongside. The view tells them apart by trying the
    # signature first -- see `resolve_opt_out_link`.
    #
    # Two `path()` entries could not express this: `opt-out/<link>` and
    # `opt-out/<email>` are the same pattern, so the first would shadow the
    # second and the distinction has to be made in the view regardless.
    path('opt-out/<link>', OptOutEmailView.as_view(), name='optout-email'),
]
