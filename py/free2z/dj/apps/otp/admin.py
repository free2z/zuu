from django.contrib import admin
from .models import OTPSecret


@admin.register(OTPSecret)
class OTPSecretAdmin(admin.ModelAdmin):
    exclude = ("secret",)
    readonly_fields = ("user", "created_at", "last_used_at")
    list_display = ["user", "is_active", "created_at", "last_used_at"]
    search_fields = ['user__username']

    def lookup_allowed(self, lookup, value, request=None):
        # Excluding the seed from the form and list does not stop Django from
        # filtering on local model fields. Secret predicates are an oracle for
        # view-only staff, so reject exact and transformed lookups alike.
        if lookup.split("__", 1)[0] == "secret":
            return False
        return super().lookup_allowed(lookup, value, request)

    def has_add_permission(self, request):
        # The seed is required to create a usable OTPSecret, but it must never
        # be rendered by the admin form.
        return False
