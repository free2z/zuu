import uuid
from django.db import models
from django.utils import timezone

# Meeting type constants
BROADCAST = 'broadcast'
PAY_PER_VIEW = 'ppv'
SUBSCRIBERS_ONLY = 'subscribers-only'
PRIVATE = 'private'
MEETING_TYPE_CHOICES = [
    (PRIVATE, 'Private'),
    (BROADCAST, 'Broadcast'),
    (PAY_PER_VIEW, 'Pay Per View'),
    (SUBSCRIBERS_ONLY, 'Subscribers Only'),
]
# Every value the `meeting_type` column is allowed to hold. `choices` alone is
# only enforced by full_clean(), which the API never calls, so any code path
# that takes a meeting type from the outside world must check membership here
# BEFORE it writes a row.
MEETING_TYPES = tuple(value for value, _ in MEETING_TYPE_CHOICES)

# The subset reachable through the public create/join route
# `/<username>/<type>` (dyte.views.DyteMeeting), which only ever manages
# is_public=True rooms. PRIVATE is deliberately absent: private rooms are
# is_public=False and have their own dedicated routes
# (`/<username>/private` and `/<username>/private/<secret>`), which are
# matched ahead of `<type>` in urls.py, so `private` never reaches
# DyteMeeting anyway.
PUBLIC_MEETING_TYPES = (BROADCAST, PAY_PER_VIEW, SUBSCRIBERS_ONLY)

LIFECYCLE_OFFLINE = 'offline'
LIFECYCLE_STARTING = 'starting'
LIFECYCLE_LIVE = 'live'
LIFECYCLE_ENDING = 'ending'
LIFECYCLE_CREATE_UNKNOWN = 'create_unknown'
MEETING_LIFECYCLE_CHOICES = [
    (LIFECYCLE_OFFLINE, 'Offline'),
    (LIFECYCLE_STARTING, 'Starting'),
    (LIFECYCLE_LIVE, 'Live'),
    (LIFECYCLE_ENDING, 'Ending'),
    (LIFECYCLE_CREATE_UNKNOWN, 'Provider create outcome unknown'),
]

CLEANUP_PENDING = 'pending'
CLEANUP_IN_PROGRESS = 'in_progress'
CLEANUP_COMPLETE = 'complete'
CLEANUP_STATUS_CHOICES = [
    (CLEANUP_PENDING, 'Pending'),
    (CLEANUP_IN_PROGRESS, 'In progress'),
    (CLEANUP_COMPLETE, 'Complete'),
]


class CreatorMeeting(models.Model):
    creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.CASCADE, related_name="meetings"
    )
    meeting_id = models.CharField(max_length=64, unique=True)
    meeting_type = models.CharField(
        max_length=20, choices=MEETING_TYPE_CHOICES, default=SUBSCRIBERS_ONLY)
    is_public = models.BooleanField(default=True)
    live_now = models.BooleanField(default=False)
    # ``live_now`` is the deliberately small public projection. These private
    # fields make start/confirm/end operations compare-and-set operations, so a
    # delayed browser request cannot publish or end a newer start.
    lifecycle_state = models.CharField(
        max_length=16,
        choices=MEETING_LIFECYCLE_CHOICES,
        default=LIFECYCLE_OFFLINE,
        db_default=LIFECYCLE_OFFLINE,
        db_index=True,
    )
    # Provider create reconciliation must keep searching for the exact title
    # sent by the ambiguous create, even if the creator renames their account.
    create_unknown_title = models.CharField(
        max_length=255, null=True, blank=True, editable=False,
    )
    create_unknown_attempts = models.PositiveSmallIntegerField(
        default=0, db_default=0, editable=False,
    )
    create_unknown_next_attempt_at = models.DateTimeField(
        null=True, blank=True, editable=False, db_index=True,
    )
    start_id = models.UUIDField(null=True, blank=True, editable=False)
    provider_session_id = models.UUIDField(null=True, blank=True, editable=False)
    provider_session_started_at = models.DateTimeField(
        null=True, blank=True, editable=False,
    )
    # Private room creation is a lease: the provider room can be attached
    # before the HTTP response reaches the browser.  These fields let the
    # server distinguish an unadopted response-loss lease from a room that a
    # browser or provider webhook has actually started using.
    private_lease_id = models.UUIDField(null=True, blank=True, editable=False)
    private_lease_created_at = models.DateTimeField(
        null=True, blank=True, editable=False,
    )
    private_lease_adopted_at = models.DateTimeField(
        null=True, blank=True, editable=False,
    )
    # Rows created before the start/confirm handshake remain explicitly
    # legacy.  Once a row is managed by the handshake this never goes back to
    # false, so an offline handshake row cannot fall through to legacy webhook
    # adoption after a terminal transition.
    handshake_managed = models.BooleanField(
        default=False, db_default=False, editable=False,
    )
    provider_room_cleanup_claimed = models.BooleanField(
        default=False, db_default=False, editable=False,
    )
    last_seen_at = models.DateTimeField(
        null=True, blank=True,
        help_text=(
            "Last time real presence was confirmed for this meeting: set at "
            "go-live and refreshed by the dyte.sweep_live_meetings worker "
            "whenever the provider reports live_participants > 0. Used as a "
            "belt-and-suspenders time bound on the public live list so a "
            "stalled worker cannot leave stale rooms visible forever."
        ),
    )
    created_at = models.DateTimeField(default=timezone.now)
    price_per_minute = models.DecimalField(
        max_digits=6, decimal_places=2, default=0,
        help_text="Optional fee set by Creator",
    )
    secret = models.UUIDField(
        unique=True, null=True, editable=False,
        help_text="Secret UUID used to join private"
    )
    e2ee = models.BooleanField(default=False)
    # The broadcaster seat. A creator publishes from exactly ONE
    # browser tab at a time: the tab that started (or deliberately took over)
    # the stream holds this lease and renews it with a heartbeat. Any other
    # tab, window or device that asks to go live while the lease is fresh is
    # refused with 409 `already_live_elsewhere` instead of silently joining
    # the room as a second host (or, before, rotating the room out from
    # under the live broadcast). The partial unique constraint below makes
    # "one seat per creator" a database fact across every meeting type, not
    # a convention the view happens to follow.
    host_session_id = models.UUIDField(null=True, blank=True, editable=False)
    host_session_seen_at = models.DateTimeField(
        null=True, blank=True, editable=False,
        help_text=(
            "Last heartbeat from the tab holding host_session_id. The seat "
            "is free once this is older than HOST_SESSION_TTL."
        ),
    )

    # The provider participant the seat holder joined with. When the seat
    # passes to another tab this participant is kicked from the room, so a
    # device that lost the Django API but kept its WebRTC connection cannot
    # keep publishing after someone else took over.
    # db_default, not just default: during a rollout (and after any
    # rollback) pods running the previous release still INSERT rows without
    # these columns, and a Python-only default would make those NOT NULL
    # violations (PR  review).
    host_participant_id = models.CharField(
        max_length=128, blank=True, default='', db_default='',
        editable=False)
    # Previous hosts whose retirement the provider has not confirmed yet:
    # [{"meeting_id", "participant_id", "attempts"}]. Retried on every
    # heartbeat of the current holder, so a failed kick is never forgotten
    # (a dropped entry would leave a publisher nobody tracks any more).
    host_evictions = models.JSONField(
        default=list, db_default=[], blank=True, editable=False)

    class Meta:
        # Exactly one private meeting of each type per creator
        # Exactly one public meeting of each type per creator
        # Total of 6 possible meetings per creator
        unique_together = ('creator', 'meeting_type', 'is_public')
        constraints = [
            models.UniqueConstraint(
                fields=['creator'],
                condition=models.Q(host_session_id__isnull=False),
                name='dyte_one_host_session_per_creator',
            ),
        ]
        indexes = [
            # Supports the single-query public "live now" list
            # (PublicMeetingViewSet) filtering is_public/live_now and, as a
            # belt-and-suspenders guard, bounding on last_seen_at.
            models.Index(
                fields=['is_public', 'live_now', 'last_seen_at'],
                name='dyte_live_now_idx',
            ),
        ]

    def __str__(self):
        return f"{self.get_meeting_type_display()} Room for {self.creator.username}"

    def recycle_secret(self):
        self.secret = uuid.uuid4()
        self.save()
        return self.secret


class ProviderRoomCleanup(models.Model):
    """Durable disable work for a provider room we no longer use.

    The provider room ID and start generation are immutable here.  A newer
    start may reuse the CreatorMeeting row, but it can never cause this record
    to point at (or disable) the newer room.
    """

    creator_meeting = models.ForeignKey(
        CreatorMeeting,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='provider_room_cleanups',
    )
    # These are immutable snapshots of the generation being cleaned up. The
    # CreatorMeeting row is reusable and may already describe a newer room
    # when a delayed participantLeft webhook arrives.
    creator = models.ForeignKey(
        'g12f.Creator',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='dyte_provider_room_cleanups',
    )
    meeting_type = models.CharField(
        max_length=20, choices=MEETING_TYPE_CHOICES, null=True, blank=True,
    )
    price_per_minute = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True,
    )
    provider_meeting_id = models.CharField(max_length=64, unique=True)
    provider_session_id = models.UUIDField(null=True, blank=True)
    start_id = models.UUIDField(null=True, blank=True, editable=False)
    status = models.CharField(
        max_length=16,
        choices=CLEANUP_STATUS_CHOICES,
        default=CLEANUP_PENDING,
        db_index=True,
    )
    attempts = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField(
        null=True, blank=True, default=timezone.now, db_index=True,
    )
    lease_until = models.DateTimeField(null=True, blank=True)
    lease_token = models.UUIDField(null=True, blank=True, editable=False)
    last_error = models.CharField(max_length=255, blank=True, default='')
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [
            models.Index(
                fields=['status', 'next_attempt_at'],
                name='dyte_cleanup_retry_idx',
            ),
        ]


class RecordingDeliveryTarget(models.Model):
    """Immutable owner routing for recordings from a provider session.

    ``CreatorMeeting`` is a reusable current-state row.  Its provider room,
    session, and secret are intentionally detached when a stream ends or is
    recycled, but recording callbacks can arrive after that transition.  This
    row preserves the historical room/session identity and owner without
    allowing a later generation to retarget an old recording.
    """

    provider_meeting_id = models.CharField(max_length=64)
    # A NULL session identifies a room that existed before the lifecycle
    # generation was introduced.  It is still an immutable room target; a
    # session-qualified callback must not be guessed onto it for public access
    # or lifecycle state. Private recording delivery can use its immutable
    # room owner when no contradictory session target exists; it grants no
    # public access and does not replay participant or lifecycle events.
    provider_session_id = models.UUIDField(null=True, blank=True)
    creator = models.ForeignKey(
        'g12f.Creator',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='dyte_recording_targets',
    )
    # The FK is only a live routing convenience. Keep the historical owner
    # even if the Creator is later deleted, so delayed recording callbacks and
    # recovery diagnostics cannot be retargeted or lose attribution.
    creator_id_snapshot = models.PositiveBigIntegerField(
        null=True, blank=True, editable=False,
    )
    creator_meeting = models.ForeignKey(
        CreatorMeeting,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='recording_delivery_targets',
    )
    meeting_type = models.CharField(max_length=20, choices=MEETING_TYPE_CHOICES)
    is_public = models.BooleanField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['provider_meeting_id', 'provider_session_id'],
                name='dyte_recording_target_room_session_uniq',
            ),
            models.UniqueConstraint(
                fields=['provider_meeting_id'],
                condition=models.Q(provider_session_id__isnull=True),
                name='dyte_recording_target_legacy_room_uniq',
            ),
        ]


class WebhookDelivery(models.Model):
    """A successfully processed provider webhook delivery.

    Cloudflare RealtimeKit (and legacy Dyte) keeps the UUID stable when it
    retries an event.  The UUID is the primary key so concurrent deliveries
    race at the database constraint instead of both applying their effects.

    This row must be created in the same transaction as the webhook's database
    effects.  A processing exception then rolls back the claim as well, which
    lets a genuine provider retry try the work again.

    The UUID identifies a delivery, not the underlying business event, and the
    provider signature does not cover that header. ``business_event_key`` is a
    normalized, unique identity for the effect, so alias/JSON-order changes or
    a fresh UUID cannot settle the same business event twice.
    """

    provider_event_id = models.UUIDField(primary_key=True, editable=False)
    event_type = models.CharField(max_length=100)
    endpoint = models.CharField(max_length=32)
    payload_sha256 = models.CharField(max_length=64, editable=False)
    business_event_key = models.CharField(
        max_length=64, editable=False, unique=True)
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-processed_at']

    def __str__(self):
        return f"{self.event_type}:{self.provider_event_id}"


class RecordingDelivery(models.Model):
    """Processing lease, recovery state, and result for one recording.

    ``download_url`` is a short-lived provider capability. It is retained only
    while bounded recovery is pending and is cleared when the recording is
    complete or recovery is terminal, so a missed callback cannot silently
    discard the only durable work item without leaving an operational signal.
    """

    idempotency_key = models.UUIDField(primary_key=True, editable=False)
    source_url_key = models.CharField(
        max_length=64, default='', db_index=True, editable=False)
    legacy_fallback = models.BooleanField(default=False, editable=False)
    generic_file = models.OneToOneField(
        'uploads.GenericFile', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='dyte_recording_delivery',
    )
    creator = models.ForeignKey(
        'g12f.Creator', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='dyte_recording_deliveries', editable=False,
    )
    # Unlike creator_id, this value is immutable recording identity rather
    # than a live relationship that can be nulled by Creator deletion.
    creator_id_snapshot = models.PositiveBigIntegerField(
        null=True, blank=True, editable=False,
    )
    meeting_pk = models.PositiveBigIntegerField(null=True, blank=True, editable=False)
    download_url = models.TextField(default='', editable=False)
    retry_count = models.PositiveIntegerField(default=0, editable=False)
    first_failure_at = models.DateTimeField(null=True, blank=True, editable=False)
    next_retry_at = models.DateTimeField(null=True, blank=True, editable=False)
    recovery_started_at = models.DateTimeField(
        null=True, blank=True, editable=False)
    recovery_queued_at = models.DateTimeField(
        null=True, blank=True, editable=False)
    last_failure_status = models.PositiveSmallIntegerField(
        null=True, blank=True, editable=False,
    )
    retry_exhausted_at = models.DateTimeField(null=True, blank=True, editable=False)
    stuck_alerted_at = models.DateTimeField(
        null=True, blank=True, editable=False)
    processed_at = models.DateTimeField(auto_now_add=True)
    lease_token = models.UUIDField(null=True, blank=True, editable=False)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-processed_at']

    def __str__(self):
        return str(self.idempotency_key)
