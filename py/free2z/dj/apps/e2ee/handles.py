"""The ONE place that answers "what is this account's messaging handle?".

THIS IS A SEAM. Keep it one function.
------------------------------------
``resolve_messaging_handle`` is the only lookup the chat-request flow uses,
for the sender (whose handle goes into the notification link) and for the
recipient (whose handle goes into the API response). Nothing else in
``dj.apps.e2ee`` may derive a handle from a username.

What it does
------------
It reads the stored binding in ``dj.apps.handles`` (free2z/zuu#1022,
workstream 7) -- the same row the key-transparency authority signs for, via
``dj.apps.handles.reservation.bound_handle``:

* An eligible account owns ``lowercase(username)``, reserved when the account
  was created (or by the data migration, oldest account first, so in a
  case-variant group only the earliest-created account owns it).
* An ineligible or collision-losing account owns nothing until it claims one.
* **A bound handle is permanent and never reused.** A username rename does not
  move it, and a deleted account's handle is retired, not freed. So a link
  that names a sender's handle keeps naming that sender.

One indexed read; writes nothing.
"""
from __future__ import annotations

from typing import Literal

HandleStatus = Literal["bound", "unclaimed"]

BOUND: HandleStatus = "bound"
UNCLAIMED: HandleStatus = "unclaimed"


def resolve_messaging_handle(user) -> tuple[str | None, HandleStatus]:
    """Return ``(handle, "bound")`` or ``(None, "unclaimed")`` for ``user``.

    ``handle``, when present, always matches ``^[a-z0-9_]{1,30}$``, which is
    the pattern Contract B requires of the ``peer`` fragment.
    """
    from dj.apps.handles.reservation import bound_handle

    handle = bound_handle(user)
    if handle is None:
        return None, UNCLAIMED
    return handle, BOUND
