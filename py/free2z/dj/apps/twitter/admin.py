from django.contrib import admin
from django.db.models import Q
from django.utils import timezone

from dj.apps.ktauth.epoch import CredentialAdminMixin

from .models import Announcement, TwitterProfile


@admin.register(TwitterProfile)
class TwitterProfileAdmin(CredentialAdminMixin, admin.ModelAdmin):
    #`allow_login` is the switch that lets this identity sign in;
    #turning it OFF revokes, turning it on only adds.
    revoking_switches = frozenset({'allow_login'})
    #The provider id IS the credential; changing it retires the old one.
    revoking_fields = frozenset({'twitter_id'})
    list_display = ('twitter_id', 'name', 'username',
                    'profile_image_url', 'creator')
    search_fields = ('twitter_id', 'name', 'username', 'creator__username')
    ordering = ('username',)
    autocomplete_fields = ['creator']


@admin.register(Announcement)
class AnnouncementAdmin(admin.ModelAdmin):
    """Inspect, retry, suppress and reconcile @F2ZP2P announcements.

    RECONCILING a ``needs_reconciliation`` row: wait 15 minutes (a late X
    answer is recorded automatically), then look at https://x.com/F2ZP2P for
    a post with this row's text.

    * found it  -> paste its id into ``x_post_id`` and run "mark posted";
    * not there -> run "retry" (you are asserting nothing was created).
    """

    list_display = (
        'event_key', 'status', 'reason', 'attempts', 'x_post_id',
        'copy_source', 'image_source', 'last_status_code', 'created_at',
    )
    list_filter = ('status', 'kind', 'reason', 'copy_source', 'image_source')
    search_fields = ('event_key', 'x_post_id', 'text')
    ordering = ('-created_at',)
    readonly_fields = (
        'event_key', 'kind', 'zpage', 'comment', 'subject_user', 'status',
        'reason', 'attempts', 'next_attempt_at', 'text', 'url',
        'copy_source', 'image_source', 'media_id', 'media_expires_at',
        'last_status_code', 'last_error', 'created_at', 'updated_at',
        'budget_reserved_at', 'posting_started_at', 'posted_at',
    )
    actions = ('retry_announcements', 'suppress_announcements',
               'mark_posted')

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        # The row is the evidence reconciliation relies on; suppress instead.
        return False

    def save_model(self, request, obj, form, change):
        """Never a full ``obj.save()`` (codex review).

        The change form holds a snapshot; a full save would write stale
        status/lease/x_post_id over whatever the worker committed since --
        e.g. turn a POSTED row back into ``generating`` with no post id.
        The ONE thing an operator edits here is ``x_post_id`` while the row
        needs reconciliation, and that is written conditionally.
        """
        if not change or "x_post_id" not in form.changed_data:
            return
        Announcement.objects.filter(
            pk=obj.pk, status=Announcement.NEEDS_RECONCILIATION,
        ).update(
            x_post_id=form.cleaned_data.get("x_post_id") or None,
            updated_at=timezone.now(),
        )

    # Admin actions are plain methods with `short_description`, not
    # `@admin.action`: Django only ever runs them from the changelist POST,
    # and dj/apps/test_url_write_guard.py reads a bare `@...action(...)`
    # decorator as DRF's GET-by-default route.
    RETRYABLE_STATUSES = (
        Announcement.FAILED, Announcement.NEEDS_RECONCILIATION,
        Announcement.SUPPRESSED, Announcement.DRY_RUN,
    )

    def retry_announcements(self, request, queryset):
        from .announcements import defer_announcement

        from .announcements import RECONCILE_COOLDOWN

        now = timezone.now()
        queued = 0
        # A row flagged for reconciliation moments ago may still have its
        # create in flight in an abandoned thread; wait it out first.
        eligible = Q(status__in=self.RETRYABLE_STATUSES) & ~Q(
            status=Announcement.NEEDS_RECONCILIATION,
            updated_at__gt=now - RECONCILE_COOLDOWN,
        ) & (
            # An operator already pasted the id of the post they FOUND on X:
            # that row is resolved ("mark posted"), and a retry would post it
            # a second time.
            Q(x_post_id__isnull=True) | Q(x_post_id="")
        )
        for pk in queryset.values_list('pk', flat=True):
            # Conditional per row, in the UPDATE itself: a concurrent Retry
            # may already have queued it and a worker may be posting it now
            # (codex review). created_at is reset so an explicit operator
            # retry is not suppressed as "stale" -- this IS the backfill
            # decision; budget_reserved_at and lease are cleared so it is
            # re-checked against the CURRENT caps under a fresh claim.
            if Announcement.objects.filter(eligible, pk=pk).update(
                status=Announcement.PENDING, reason='operator_retry',
                attempts=0, next_attempt_at=now, created_at=now,
                updated_at=now, budget_reserved_at=None, lease=None,
            ):
                defer_announcement(pk)
                queued += 1
        self.message_user(
            request,
            f"Queued {queued} announcement(s). Rows with an x_post_id, and "
            f"reconciliation rows flagged in the last 15 minutes, are "
            f"skipped.",
        )

    retry_announcements.short_description = (
        "Retry (I checked: nothing was posted on X)"
    )

    def suppress_announcements(self, request, queryset):
        # Not POSTING (in flight) and not NEEDS_RECONCILIATION: an
        # unresolved create must stay visible as such, behind the retry
        # cooldown, not become a freely restartable "suppressed" row.
        count = queryset.exclude(status__in=(
            Announcement.POSTED, Announcement.POSTING,
            Announcement.NEEDS_RECONCILIATION,
        )).update(
            status=Announcement.SUPPRESSED, reason='operator_suppressed',
            updated_at=timezone.now(),
        )
        self.message_user(request, f"Suppressed {count} announcement(s).")

    suppress_announcements.short_description = "Suppress (never post)"

    def mark_posted(self, request, queryset):
        count = queryset.filter(
            status=Announcement.NEEDS_RECONCILIATION,
            x_post_id__isnull=False,
        ).exclude(x_post_id='').update(
            status=Announcement.POSTED, reason='operator_reconciled',
            posted_at=timezone.now(), updated_at=timezone.now(),
        )
        self.message_user(request, f"Marked {count} announcement(s) posted.")

    mark_posted.short_description = "Mark posted (x_post_id already filled in)"

    def get_readonly_fields(self, request, obj=None):
        fields = list(super().get_readonly_fields(request, obj))
        # x_post_id stays editable only while a human is reconciling.
        if obj is None or obj.status != Announcement.NEEDS_RECONCILIATION:
            fields.append('x_post_id')
        return fields
