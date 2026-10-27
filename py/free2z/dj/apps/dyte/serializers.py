from rest_framework import serializers
from dj.apps.economy.serializers import ActorIDField
from .models import CreatorMeeting, PUBLIC_MEETING_TYPES

from dj.apps.g12f.serializers.creator import CreatorDetailSerializer


# NOTE: deliberately a comment, not a docstring -- drf-spectacular publishes a
# serializer docstring as the schema `description` in f2z.yaml, and this
# reasoning is for maintainers, not for the public API contract.
#
# The field list below is enumerated on purpose and must stay that way.
# `fields = '__all__'` meant every column added to CreatorMeeting from then on
# was published by an AllowAny endpoint the moment it was migrated, with nobody
# reviewing the decision.
#
# That was not hypothetical. `secret` -- the bearer credential accepted by
# /api/dyte/<username>/private/<secret> -- is `editable=False`, which DRF turns
# into `read_only=True`. Read-only means "not writable", NOT "not serialized",
# so it was in the public response schema and in the generated TypeScript
# client. It is omitted here.
#
# Anything added to this list is a deliberate choice to publish that value to
# anonymous callers.
class CreatorMeetingSerializer(serializers.ModelSerializer):
    creator = CreatorDetailSerializer(read_only=True)

    class Meta:
        model = CreatorMeeting
        fields = [
            'id',
            'creator',
            'meeting_id',
            'meeting_type',
            'is_public',
            'live_now',
            'last_seen_at',
            'created_at',
            'price_per_minute',
            'e2ee',
        ]


class PublicMeetingListSerializer(serializers.ModelSerializer):
    # The list is anonymous and intentionally smaller than the detail
    # serializer. In particular, it must not expose meeting_id or secret.

    username = serializers.CharField(source='creator.username', read_only=True)
    avatar = serializers.SerializerMethodField()
    meeting_type = serializers.ChoiceField(
        choices=PUBLIC_MEETING_TYPES, read_only=True,
    )

    class Meta:
        model = CreatorMeeting
        fields = [
            'username',
            'avatar',
            'meeting_type',
            'price_per_minute',
        ]

    def get_avatar(self, obj) -> str:
        return obj.creator.get_avatar_thumbnail_url_safe()


class PublicMeetingDiscoverySerializer(serializers.Serializer):
    """Bounded discovery metadata plus the unchanged public meeting rows."""

    results = PublicMeetingListSerializer(many=True)
    selected_creators = serializers.ListField(
        child=serializers.CharField(),
        help_text=(
            "Usernames whose current public live modes are complete in "
            "results."
        ),
    )
    complete = serializers.BooleanField(
        help_text=(
            "Whether every currently-live public creator is represented; "
            "false means unselected creators remain unknown."
        ),
    )


HOST_ROLE = 'host'
VIEWER_ROLE = 'viewer'


class MeetingJoinRequestSerializer(serializers.Serializer):
    """Body of a start/join POST to a public meeting."""

    expected_actor_id = ActorIDField(required=False, help_text='Original viewer account ID; required for a first-party paid PPV join under the active economic policy.')
    role = serializers.ChoiceField(
        choices=[HOST_ROLE, VIEWER_ROLE],
        required=False,
        help_text=(
            "`host` starts (or resumes) the caller's own broadcast from this "
            "tab. `viewer` joins as an audience member, which is what the "
            "creator's own public stream page sends so it can never publish "
            "or claim the broadcaster seat. Omitted: legacy inference -- the "
            "creator is a host, anyone else a viewer. Only meaningful for "
            "the creator; everyone else is always a viewer."
        ),
    )
    host_session = serializers.UUIDField(
        required=False,
        help_text=(
            "Host only. A random id the broadcasting tab generates once per "
            "page load. Re-sending the same id (a retry, a double click) "
            "resumes that tab's seat instead of starting a second broadcast. "
            "Omitted by a legacy client: the server mints one, which simply "
            "expires if nothing renews it."
        ),
    )
    takeover = serializers.BooleanField(
        required=False,
        default=False,
        help_text=(
            "Host only. Deliberately move the broadcaster seat to this tab "
            "when another tab or device holds it. The other tab is told on "
            "its next heartbeat and leaves the room. The live room is kept, "
            "so viewers stay connected."
        ),
    )


class MeetingJoinRequestSchemaSerializer(MeetingJoinRequestSerializer):
    # Documentation only: price_per_minute keeps its long-standing parsing
    # and validation (ppv_join_threshold) in the view.
    price_per_minute = serializers.DecimalField(
        max_digits=6, decimal_places=2, required=False,
        help_text=(
            "Host only, PPV only. Ignored when resuming or taking over a live "
            "session: a live stream's price never changes mid-session."
        ),
    )


class MeetingJoinResponseSerializer(serializers.Serializer):
    meeting_id = serializers.CharField()
    auth_token = serializers.CharField()
    host_session = serializers.UUIDField(
        required=False,
        help_text="Host only. The seat this tab now holds; renew it with "
                  "`POST /api/dyte/{username}/host-session`.",
    )
    meeting_type = serializers.ChoiceField(
        choices=PUBLIC_MEETING_TYPES, required=False,
    )
    resumed = serializers.BooleanField(
        required=False,
        help_text="Host only. True when an already-live session was resumed "
                  "or taken over instead of a new one being started.",
    )


class HostSeatConflictSerializer(serializers.Serializer):
    code = serializers.ChoiceField(
        choices=['already_live_elsewhere', 'host_session_superseded'])
    error = serializers.CharField()
    meeting_type = serializers.ChoiceField(
        choices=PUBLIC_MEETING_TYPES, allow_null=True)
    last_seen_at = serializers.DateTimeField(allow_null=True)


class HostSessionActionSerializer(serializers.Serializer):
    host_session = serializers.UUIDField()
    action = serializers.ChoiceField(
        choices=['heartbeat', 'release'],
        help_text=(
            "`heartbeat` renews this tab's seat (409 "
            "`host_session_superseded` once another tab took it over). "
            "`release` frees it when the broadcast ends; releasing a seat "
            "this tab no longer holds is a no-op."
        ),
    )


class HostSessionStatusSerializer(serializers.Serializer):
    active = serializers.BooleanField(
        help_text="Whether some tab or device currently holds the seat.")
    host_session = serializers.UUIDField(allow_null=True)
    meeting_type = serializers.ChoiceField(
        choices=PUBLIC_MEETING_TYPES, allow_null=True)
    last_seen_at = serializers.DateTimeField(allow_null=True)
    ttl_seconds = serializers.IntegerField(
        help_text="How long a seat survives without a heartbeat.")
