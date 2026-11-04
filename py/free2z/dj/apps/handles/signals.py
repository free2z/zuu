"""Reserve a new account's handle, and retire a deleted account's.

Connected in ``HandlesConfig.ready`` against ``AUTH_USER_MODEL``.
"""

import logging

from .reservation import STATUS_RETIRED, ensure_username_handle

logger = logging.getLogger(__name__)


def reserve_on_create(sender, instance, created, raw=False, **kwargs):
    """Every account-creation path (signup, Zcash login, OAuth, admin) saves a
    new ``Creator``; this is the one place that sees all of them.

    Only on creation. A username rename does not move or add a handle: a bound
    handle is permanent, and an account without one claims it explicitly (or
    gets it from :func:`ensure_username_handle` on a POST path). ``raw`` is a
    fixture load, which must not grow rows it did not ask for.
    """
    if not created or raw:
        return
    try:
        ensure_username_handle(instance)
    except Exception:
        # Never fail a signup over a messaging handle. The savepoint inside
        # ensure_username_handle keeps the caller's transaction usable, and the
        # account can still claim, or be picked up by `handle_census --apply`.
        logger.exception("messaging handle reservation failed on signup")


def retire_on_delete(sender, instance, **kwargs):
    """Keep the handle reserved forever when its account is deleted.

    Runs before the collector's ``SET_NULL``, so the row goes ``bound`` ->
    ``retired`` -> ``user = NULL`` and ``messaging_handle_bound_has_user``
    holds throughout.
    """
    from .models import MessagingHandle

    MessagingHandle.objects.filter(user_id=instance.pk).update(
        status=STATUS_RETIRED
    )
