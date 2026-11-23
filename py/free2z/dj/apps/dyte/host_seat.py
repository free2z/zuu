"""Shared lease boundary for broadcaster ownership and paid admission."""
from datetime import timedelta

# Four missed heartbeats. A broadcasting tab holds a live WebRTC connection,
# which exempts it from Chrome's intensive background-timer throttling, but a
# network blip or a slow mobile radio should not hand the seat to nobody.
HOST_SESSION_TTL = timedelta(seconds=60)


def host_seat_is_fresh(cm, now):
    return bool(
        cm is not None
        and cm.host_session_id is not None
        and cm.host_session_seen_at is not None
        and now - cm.host_session_seen_at < HOST_SESSION_TTL
    )
