from django.contrib import admin

from dj.apps.ktauth.epoch import CredentialAdminMixin

from .models import ZcashChallengeClaim, ZcashIdentity


@admin.register(ZcashIdentity)
class ZcashIdentityAdmin(CredentialAdminMixin, admin.ModelAdmin):
    #The address itself is the credential; reassigning it revokes it.
    revoking_fields = frozenset({'zcash_address'})
    list_display = ("zcash_address", "creator", "created_at")
    search_fields = ("zcash_address", "creator__username")
    raw_id_fields = ("creator",)


@admin.register(ZcashChallengeClaim)
class ZcashChallengeClaimAdmin(admin.ModelAdmin):
    list_display = ("challenge_digest", "claimed_at", "expires")
    search_fields = ("challenge_digest",)
