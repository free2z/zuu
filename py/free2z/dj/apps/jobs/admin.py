"""Read-only triage view of the Pub/Sub outbox.

Deliberately read-only, including no delete. Every row here is a message the
platform PROMISED to publish inside a committed transaction; deleting one is
exactly the silent data loss the table exists to prevent -- an unsent
recording-ready message means a creator's recording is never downloaded and
its presigned URL expires. There is no attempt cap, so the correct response
to a stuck row is always to fix the publish path and let the relay drain it.

The alert runbook (monitoring/alert-policies/pubsub-outbox-backlog.json)
sends responders here, so the list must show what distinguishes "the relay is
down" (attempts 0, no error) from "Pub/Sub is refusing" (attempts climbing,
last_error set) without opening a row.

The CHANGE PAGE renders every field, `payload` included, and a payload can
hold a live credential -- the Dyte recording message carries the provider's
presigned `downloadUrl`. That is the documented trade on
`OutboxMessage.payload`, not an oversight; it is called out here because
this is the surface that shows it to a human.
"""
from django.contrib import admin

from .models import OutboxMessage


class PublishedStateFilter(admin.SimpleListFilter):
    """Narrow the changelist without DISTINCT or date-hierarchy queries."""

    title = 'delivery state'
    parameter_name = 'published'

    def lookups(self, request, model_admin):
        return (
            ('pending', 'Pending / retrying'),
            ('published', 'Published'),
        )

    def queryset(self, request, queryset):
        if self.value() == 'pending':
            return queryset.filter(published_at__isnull=True)
        if self.value() == 'published':
            return queryset.filter(published_at__isnull=False)
        return queryset


@admin.register(OutboxMessage)
class OutboxMessageAdmin(admin.ModelAdmin):
    list_display = (
        'id', 'topic', 'ordering_key', 'dedup_key', 'created_at',
        'published_at', 'attempts', 'next_attempt_at', 'short_error',
    )
    # `topic` is a TextField and Django's list filter asks for DISTINCT topic
    # values. `last_error` and the other free-text fields become wildcard
    # ILIKE searches. Keep only simple state/boolean predicates and typed
    # searches backed by the primary/unique indexes so this incident surface
    # does not become the incident itself.
    list_filter = (PublishedStateFilter, 'ensure_topic')
    # The search box is retained, but get_search_results below deliberately
    # does not use Django's `=` prefix: it still implements iexact, which is
    # not a case-sensitive indexed equality lookup on PostgreSQL.
    search_fields = ('id', 'dedup_key')
    show_full_result_count = False
    # Only the primary-key ordering is indexed and useful for this triage
    # surface. Other list columns remain visible but cannot trigger a sort.
    sortable_by = ('id',)
    ordering = ('-id',)

    def get_search_results(self, request, queryset, search_term):
        """Search an ID numerically or a dedup key case-sensitively."""
        term = search_term.strip()
        if not term:
            return queryset, False
        if term.isascii() and term.isdecimal():
            # Convert before constructing the query. Passing arbitrary text
            # to an integer PK lookup can make PostgreSQL reject the request.
            value = int(term)
            if value.bit_length() > 63:
                return queryset.none(), False
            return queryset.filter(pk=value), False
        # `exact` is PostgreSQL's case-sensitive `=` lookup and can use the
        # unique dedup_key index. No wildcard or case-folding is involved.
        return queryset.filter(dedup_key__exact=term), False

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields]

    def has_add_permission(self, request):
        # A message is a promise made by a transaction. There is no such
        # thing as one an operator should hand-write.
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        # Deleting a promise is data loss, and a click is not the interface
        # for it. The sanctioned terminal state for a row that can never
        # publish is `manage.py outbox_abandon`, which refuses any row that
        # still has a chance and logs the entire row at ERROR before
        # deleting it.
        return False

    @admin.display(description='last error')
    def short_error(self, obj):
        if not obj.last_error:
            return ''
        return obj.last_error[:120]
