from django.contrib import admin

from .models import CreatorMeeting, RecordingDelivery, WebhookDelivery


@admin.register(CreatorMeeting)
class CreatorMeetingAdmin(admin.ModelAdmin):
    list_display = ('meeting_id', 'creator', 'meeting_type', 'is_public', 'live_now', 'created_at', 'price_per_minute')
    list_filter = ('meeting_type', 'is_public', 'live_now')
    search_fields = ('creator__username', 'meeting_id')
    ordering = ('-created_at',)
    readonly_fields = ('meeting_id', 'creator', 'created_at')


@admin.register(WebhookDelivery)
class WebhookDeliveryAdmin(admin.ModelAdmin):
    list_display = (
        'provider_event_id', 'event_type', 'endpoint', 'processed_at',
    )
    list_filter = ('event_type', 'endpoint')
    search_fields = (
        'provider_event_id', 'payload_sha256', 'business_event_key',
    )
    ordering = ('-processed_at',)
    readonly_fields = (
        'provider_event_id', 'event_type', 'endpoint', 'payload_sha256',
        'business_event_key', 'processed_at',
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(RecordingDelivery)
class RecordingDeliveryAdmin(admin.ModelAdmin):
    list_display = (
        'idempotency_key', 'creator', 'legacy_fallback', 'generic_file',
        'retry_count', 'next_retry_at', 'retry_exhausted_at', 'completed_at',
        'lease_token', 'lease_expires_at', 'processed_at',
    )
    list_select_related = ('creator', 'generic_file__owner')
    search_fields = (
        'idempotency_key', 'source_url_key', 'creator__username',
        'generic_file__owner__username',
    )
    ordering = ('-processed_at',)
    readonly_fields = (
        'idempotency_key', 'source_url_key', 'legacy_fallback', 'generic_file',
        'creator', 'meeting_pk', 'retry_count', 'first_failure_at',
        'next_retry_at', 'recovery_started_at', 'recovery_queued_at',
        'last_failure_status', 'retry_exhausted_at', 'stuck_alerted_at',
        'completed_at', 'lease_token', 'lease_expires_at', 'processed_at',
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
