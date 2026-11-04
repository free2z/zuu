"""The claim flow: an account without a handle chooses one, once.

Refusal codes are bounded and enumerated (:data:`CLAIM_ERRORS`) so a client can
branch on them. ``taken`` deliberately covers both "another row holds it" and
"another account's username folds to it": the second is protected so a claim
cannot take the handle an eligible account is about to be given, and saying
which of the two applies would only tell the caller something about another
account.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction

from . import policy
from .reservation import SOURCE_CLAIMED, STATUS_BOUND, handle_taken

#: 400 — not ``^[a-z0-9_]{1,30}$`` exactly (no folding, no trimming).
CLAIM_INVALID = "invalid"
#: 400 — on ``policy.RESERVED_HANDLES``.
CLAIM_RESERVED = "reserved"
#: 409 — held by another row, or another account's username folds to it.
CLAIM_TAKEN = "taken"
#: 409 — this account already has a handle (bound or retired). Permanent.
CLAIM_ALREADY_BOUND = "already_bound"

CLAIM_ERRORS = (CLAIM_INVALID, CLAIM_RESERVED, CLAIM_TAKEN, CLAIM_ALREADY_BOUND)

CLAIM_STATUS = {
    CLAIM_INVALID: 400,
    CLAIM_RESERVED: 400,
    CLAIM_TAKEN: 409,
    CLAIM_ALREADY_BOUND: 409,
}

CLAIM_DETAIL = {
    CLAIM_INVALID: (
        "A messaging handle is 1 to 30 characters: lowercase a-z, digits and "
        "underscore."
    ),
    CLAIM_RESERVED: "That messaging handle is reserved.",
    CLAIM_TAKEN: "That messaging handle is taken.",
    CLAIM_ALREADY_BOUND: (
        "This account already has a messaging handle. Handles are permanent."
    ),
}


class ClaimRefused(Exception):
    def __init__(self, code: str):
        assert code in CLAIM_ERRORS, code
        super().__init__(code)
        self.code = code
        self.status = CLAIM_STATUS[code]
        self.detail = CLAIM_DETAIL[code]


def claim(user, handle) -> str:
    """Bind ``handle`` to ``user`` permanently, or raise :class:`ClaimRefused`.

    The checks before the insert produce the right error message; the database
    constraints are what make the answer correct under concurrency. Two
    accounts racing for one handle: one insert commits, the other raises
    ``IntegrityError`` on ``messaging_handle_ci_unique`` and is reported as
    ``taken``. One account racing itself for two handles: the one-to-one on
    ``user`` refuses the second, reported as ``already_bound``.
    """
    from .models import MessagingHandle

    if MessagingHandle.objects.filter(user_id=user.pk).exists():
        raise ClaimRefused(CLAIM_ALREADY_BOUND)

    if not policy.is_handle(handle):
        raise ClaimRefused(CLAIM_INVALID)

    # Absolute, including for an account whose own username is the reserved
    # word: it is not given the handle automatically, and it cannot take it by
    # claiming. An operator binds such a handle by hand, if at all.
    if policy.is_reserved(handle):
        raise ClaimRefused(CLAIM_RESERVED)

    if handle_taken(handle):
        raise ClaimRefused(CLAIM_TAKEN)
    if (
        get_user_model()._default_manager.filter(username__iexact=handle)
        .exclude(pk=user.pk)
        .exists()
    ):
        raise ClaimRefused(CLAIM_TAKEN)

    try:
        with transaction.atomic():
            MessagingHandle.objects.create(
                handle=handle,
                user=user,
                status=STATUS_BOUND,
                source=SOURCE_CLAIMED,
            )
    except IntegrityError:
        if MessagingHandle.objects.filter(user_id=user.pk).exists():
            raise ClaimRefused(CLAIM_ALREADY_BOUND) from None
        raise ClaimRefused(CLAIM_TAKEN) from None
    return handle
