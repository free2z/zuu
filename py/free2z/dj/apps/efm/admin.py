from django.contrib import admin
from .models import FrostGroup, Participant, WebAuthnChallenge


@admin.register(FrostGroup)
class FrostGroupAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'max_participants')
    search_fields = ('uuid',)
    readonly_fields = ('uuid',)


@admin.register(Participant)
class ParticipantAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'group', 'webauthn_credential_id')
    search_fields = ('uuid', 'group__uuid', 'webauthn_credential_id')
    readonly_fields = ('uuid',)
    autocomplete_fields = ('group',)


@admin.register(WebAuthnChallenge)
class WebAuthnChallengeAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'participant', 'challenge_type', 'created_at')
    search_fields = ('uuid', 'participant__uuid', 'participant__group__uuid')
    list_filter = ('challenge_type', 'created_at')
    ordering = ('-created_at',)
    readonly_fields = ('uuid', 'created_at')
    autocomplete_fields = ('participant',)
