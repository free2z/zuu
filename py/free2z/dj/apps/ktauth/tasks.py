"""Asynchronous cleanup for ownership-event session revocation.

The account epoch and the session auth hash are the revocation boundary. This
task is only hygiene: it retires rows that are already refused at use time. It
is a normal Procrastinate task so its job row can be inserted in the ownership
transaction and survive a web-process restart after that transaction commits.
"""

import logging

from procrastinate import RetryStrategy
from procrastinate.contrib.django import app
from procrastinate.exceptions import AlreadyEnqueued
from django.db import transaction

logger = logging.getLogger(__name__)

# A failed database pass is safe to retry: _retire_matching uses the payload
# it read as a compare-and-swap, and the current account hash is checked again
# immediately before each write. This is task retry state, not reclaimer
# state; each pass has a row bound, but remains NEVER in reclaim_policy because
# a database statement still has no honest wall-clock bound.
SESSION_SWEEP_RETRY = RetryStrategy(max_attempts=3, exponential_wait=30)
SESSION_SWEEP_QUEUEING_LOCK_PREFIX = "ktauth-session-sweep"


def enqueue_session_sweep(user_id, using, generation, *, after_key=""):
    """Queue a first page or continuation in the current Django transaction."""
    lock = f"{SESSION_SWEEP_QUEUEING_LOCK_PREFIX}-{using}-{user_id}-{generation}"
    try:
        with transaction.atomic(using=using):
            sweep_sessions.configure(
                lock=lock, queueing_lock=f"{lock}-page-{after_key or 'start'}",
            ).defer(
                user_id=user_id, using=using, generation=generation,
                after_key=after_key,
            )
    except AlreadyEnqueued:
        # A retry can find the same cursor it already committed. Parent and
        # child must use different queueing locks: retrying the parent makes
        # it `todo` again while its committed child is already `todo`.
        logger.info("session sweep already queued: user=%s epoch=%s", user_id, generation)


@app.task(
    name="ktauth.sweep_sessions",
    queue="default",
    retry=SESSION_SWEEP_RETRY,
)
def sweep_sessions(user_id: int, generation: int, using: str = "default", after_key: str = ""):
    """Retire stale session rows for one account outside the request thread.

    The epoch check remains authoritative while this job is queued, delayed,
    retried, or never completed. A worker outage therefore leaves stale rows
    behind but cannot leave the old owner authenticated; job health exposes a
    failed or stalled cleanup for operators.
    """
    from django.contrib.auth import get_user_model
    from .epoch import _sweep_sessions_page

    try:
        current = get_user_model().objects.using(using).filter(pk=user_id).values_list(
            "kt_account_epoch", flat=True,
        ).first()
        if current != generation:
            # A newer epoch's full scan was durably queued with its bump.
            return 0
        # Different epochs may overlap: the page rechecks current auth hashes
        # and retires with payload CAS. Epoch-scoped execution locks prevent a
        # dead worker's permanent `doing` row from blocking all future events.
        # A killed pass can still strand its own epoch until an operator acts
        # or a later ownership event starts a new scan; NEVER is intentional.
        retired, next_key = _sweep_sessions_page(user_id, using, after_key=after_key)
        if next_key is not None:
            enqueue_session_sweep(user_id, using, generation, after_key=next_key)
        return retired
    except Exception:
        logger.exception(
            "kt ownership-event session sweep job for user %s failed; "
            "stale rows remain refused at use time by the session auth hash",
            user_id,
        )
        raise
