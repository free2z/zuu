from django.contrib import admin

from dj.apps.ktauth.epoch import CredentialAdminMixin

from .models import Email, OptOutEmail, PasswordResetToken

@admin.register(Email)
class EmailAdmin(CredentialAdminMixin, admin.ModelAdmin):
    #. A CONFIRMED address is a recovery credential: it can spend a
    # password-reset token and take the account. Staff reassigning it,
    # repointing it, un-confirming it or deleting it is a revocation that
    # reaches none of the HTTP routes (codex adversarial review).
    creator_field = 'user'
    #The address IS the credential; changing it retires the old one.
    revoking_fields = frozenset({'email'})
    #Un-confirming withdraws the ability to spend a reset token.
    revoking_switches = frozenset({'confirmed_at'})

    list_display = ('user', 'email', 'token', 'created_at', 'expires_at', 'confirmed_at')
    # list_filter = ('created_at', 'expires_at', 'confirmed_at')
    search_fields = ('user__username', 'email', 'token')
    ordering = ('-created_at',)
    readonly_fields = ('token',)
    autocomplete_fields = ('user',)

    def grants_access(self, values):
        # An unconfirmed address cannot spend a password-reset token, so it is
        # not a credential and removing it revokes nothing.
        return values['confirmed_at'] is not None


@admin.register(OptOutEmail)
class OptOutEmailAdmin(admin.ModelAdmin):
    list_display = ('email', 'opted_out_at')
    search_fields = ('email',)
    ordering = ('-opted_out_at',)
    readonly_fields = ('opted_out_at', 'email')


@admin.register(PasswordResetToken)
class PasswordResetTokenAdmin(admin.ModelAdmin):
    list_display = ('email', 'token', 'created_at', 'used')
    search_fields = ('email__email', 'token')
    ordering = ('-created_at',)
    readonly_fields = ('token', 'created_at')
    autocomplete_fields = ('email',)
