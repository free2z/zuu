"""Pure handle policy: no models, no database, importable from a migration.

Kept free of ORM imports on purpose. Migration ``0002`` and the census command
both call these functions with historical or live models, and a data
migration must never import the app's *current* models.
"""

from __future__ import annotations

import re

#: ``[a-z0-9_]{1,30}``, ASCII. ``\Z`` rather than ``$`` so a trailing newline
#: is not accepted, and matched only after an explicit ``isascii()`` check,
#: because ``re``'s ``[a-z]`` is ASCII but ``str.lower`` is not.
HANDLE_PATTERN = r"^[a-z0-9_]{1,30}\Z"
HANDLE_RE = re.compile(HANDLE_PATTERN)

#: The same pattern as a PostgreSQL regex, for the ``CheckConstraint``.
HANDLE_DB_REGEX = r"^[a-z0-9_]{1,30}$"

MAX_HANDLE_LENGTH = 30

# Ineligibility reasons. The first three are the strings
# ``tauri-plugin-f2zmsg``'s ``IneligibilityReason`` serializes to
# (kebab-case), so the client and the server name the same cause the same way.
# ``reserved`` and ``taken`` exist only here: they depend on server state.
REASON_PUNCTUATION = "punctuation"
REASON_NON_ASCII = "non-ascii"
REASON_TOO_LONG = "too-long"
#: The candidate is well-formed but on :data:`RESERVED_HANDLES`.
REASON_RESERVED = "reserved"
#: The candidate is well-formed but another account holds it (the case-
#: collision loser, or a handle kept by an account that renamed away).
REASON_TAKEN = "taken"

REASONS = (
    REASON_PUNCTUATION,
    REASON_NON_ASCII,
    REASON_TOO_LONG,
    REASON_RESERVED,
    REASON_TAKEN,
)

#: Handles nobody gets automatically and nobody can claim.
#:
#: The route-shadowing list ``g12f.usernames.FORBIDDEN_USERNAMES`` answers a
#: different question (what would hide a page at ``/<name>``) and is not reused.
#: This one is about **impersonation inside an encrypted chat**, where there is
#: no profile page, no avatar and no verified badge next to the name: a message
#: from ``@support`` has to be the platform or nobody. Conservative and easy to
#: extend. Adding a word never revokes an existing binding; the census reports
#: accounts whose username is on this list so an operator can decide by hand.
RESERVED_HANDLES = frozenset({
    # Platform and brand names.
    "free2z", "free2z_app", "free2z_support", "free2zsupport", "f2z",
    "zuuli", "zuuallet", "e2e2z", "tuzi", "twoz", "zcash", "zec", "ecc",
    "zfnd", "electriccoin",
    # Operators and staff.
    "admin", "admins", "administrator", "root", "sysadmin", "system",
    "staff", "team", "official", "moderator", "moderators", "mod", "mods",
    "owner", "ceo", "founder",
    # Channels a user would trust by name.
    "support", "help", "helpdesk", "security", "abuse", "trust",
    "trust_and_safety", "safety", "billing", "payments", "legal", "privacy",
    "info", "contact", "notifications", "notification", "alerts", "verify",
    "verified", "verification", "postmaster", "hostmaster", "webmaster",
    "noreply", "no_reply", "donotreply", "mailer_daemon", "bot",
    # Values a client might render as something other than a person.
    "api", "www", "null", "undefined", "none", "nil", "nobody", "anonymous",
    "everyone", "here", "me", "you", "unknown", "deleted", "system_message",
})


def eligibility(username: str) -> tuple[str | None, str | None]:
    """``(candidate, reason)`` for a username, as a pure string function.

    Exactly one of the two is ``None``. Mirrors ``handle.rs::eligibility``,
    including its ordering: a name that is both too long and punctuated is
    reported as punctuation. This says whether the string *could* be a handle;
    whether the account *owns* it is the database's answer, not this one.
    """
    if not username:
        return None, REASON_PUNCTUATION
    # ASCII first. ``str.lower`` is Unicode-aware (U+212A KELVIN SIGN lowers to
    # ASCII ``k``), so a non-ASCII username could otherwise fold into the
    # charset and onto someone else's handle.
    if not username.isascii():
        return None, REASON_NON_ASCII
    candidate = username.lower()
    if not re.fullmatch(r"[a-z0-9_]*", candidate):
        return None, REASON_PUNCTUATION
    if len(candidate) > MAX_HANDLE_LENGTH:
        return None, REASON_TOO_LONG
    return candidate, None


def is_handle(value) -> bool:
    """Whether ``value`` is already a valid handle, byte for byte. No folding."""
    return (
        isinstance(value, str)
        and value.isascii()
        and HANDLE_RE.match(value) is not None
    )


def is_reserved(handle: str) -> bool:
    return handle in RESERVED_HANDLES


def auto_reservable(username: str) -> str | None:
    """The handle to reserve automatically for ``username``, or ``None``.

    Eligible and not reserved. Whether it is still *free* is the caller's
    question, answered by the database.
    """
    candidate, _reason = eligibility(username)
    if candidate is None or is_reserved(candidate):
        return None
    return candidate
