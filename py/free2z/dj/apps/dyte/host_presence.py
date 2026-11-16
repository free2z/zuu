"""Ordered provider evidence, separate from the dashboard's HTTP seat lease."""
from enum import Enum

from django.utils import timezone

HOST_PRESENCE_FIELDS = ('host_peer_id', 'host_joined_at', 'host_left_at')


class PresenceUpdate(Enum):
    IGNORED = 'ignored'
    APPLIED = 'applied'
    AMBIGUOUS = 'ambiguous'


def clear_host_presence(meeting):
    for field in HOST_PRESENCE_FIELDS:
        setattr(meeting, field, None)


def host_is_present(meeting):
    return (meeting.host_peer_id is not None and meeting.host_joined_at is not None
        and meeting.host_left_at is None and meeting.host_start_claim is None)


def record_host_presence(meeting, participant, *, departed):
    """Apply one peer generation; a leave is terminal for that exact join.

    Call only after locking the meeting and verifying owner, start claim and
    provider session. Provider join time orders reconnects, not delivery time or
    leave time: an older peer can finish leaving after its replacement joined.
    Equal join times from different peers cannot establish a newer generation.
    """
    joined_at = participant.joinedAt
    left_at = participant.leftAt
    if joined_at is None or not timezone.is_aware(joined_at):
        return PresenceUpdate.IGNORED
    if departed:
        if left_at is None or not timezone.is_aware(left_at) or left_at < joined_at:
            return PresenceUpdate.IGNORED
    elif left_at is not None:
        return PresenceUpdate.IGNORED
    if meeting.host_joined_at is not None:
        if joined_at < meeting.host_joined_at:
            return PresenceUpdate.IGNORED
        if joined_at == meeting.host_joined_at:
            if participant.peerId != meeting.host_peer_id:
                # Neither peer can be proved newer. Preserve the timestamp
                # high-water mark but make presence explicitly unknown; do
                # not manufacture a leave time for a join-only conflict.
                meeting.host_peer_id = None
                meeting.host_left_at = None
                return PresenceUpdate.AMBIGUOUS
            if not departed and meeting.host_left_at is not None:
                return PresenceUpdate.IGNORED
            if departed and meeting.host_left_at is not None:
                left_at = max(left_at, meeting.host_left_at)
    meeting.host_peer_id = participant.peerId
    meeting.host_joined_at = joined_at
    meeting.host_left_at = left_at if departed else None
    return PresenceUpdate.APPLIED
