"""What a ``CreatorBlock`` hides from the account that made it.

``CreatorBlock`` (``models/follow.py``, added with page mentions in ) is a
directional row: ``blocker`` no longer wants ``blocked``'s content or contact.
Until  the only thing that read it was mention delivery. This module is
the one place every *read* surface asks, so "blocked" means the same thing on
the comment lists, the zPage lists, the notification list and the realtime
notification push.

The rule is deliberately one-directional and viewer-side:

* It filters what the **blocker** is served. The blocked account is told
  nothing and its own reads are unchanged -- a block is not a takedown, and
  telling the blocked account would turn the control into a harassment
  signal. Staff takedown remains ``Bannable`` / ``is_active``.
* It hides **content and contact** (comments, pages, replies, mentions,
  votes on the blocker's comments and pages, page-update pings, NEW chat
  requests) and
  never **money records**. A donation or subscription payment from a blocked
  account already moved 2Z; hiding its receipt would make the blocker's own
  ledger history disagree with their balance.
* Direct object reads (one zPage by URL, one comment by UUID) are not
  filtered. A block stops content *reaching* the blocker through lists and
  notifications; a link the blocker opens on purpose still resolves, which is
  also how they reach the profile to undo the block.

Every filter first asks whether the viewer has blocked anyone at all and, if
not, returns the queryset untouched. Almost nobody has a block, and the zPage
list's query plan is tuned (partial indexes, /): a reader with no
blocks must get exactly the query they got before this module existed.
"""
from __future__ import annotations

from django.db.models import Q

from .models import CreatorBlock


#Notification types a block suppresses for the blocker. Every other type --
#in particular DONATION_RECEIVED, SUBSCRIPTION_RECEIVED,
#PAY_PER_VIEW_REVENUE and ENCRYPTED_CHAT_REQUEST -- is a record of money
#that already moved and stays visible regardless of who sent it. (A chat
#request is the recipient's only receipt for the 2Z it credited; a NEW one
#from a blocked account is refused before anything is charged, so only
#pre-block requests can still be listed.)
BLOCK_HIDDEN_EVENT_TYPES = frozenset({
    'NEW_REPLY',
    'PAGE_MENTION',
    'PAGE_UPDATE',
    # The page owner's row only: a page vote debits the voter and credits
    # the owner nothing, so the owner's row is contact, not a receipt. The
    # voter's own spend row has contributor == receiver and is never matched.
    'PAGE_VOTE',
    'VOTE_COMMENT_RECEIVED',
})


def _viewer_id(user):
    if user is not None and getattr(user, 'is_authenticated', False):
        return user.pk
    return None


def blocked_ids_subquery(user):
    """Creator ids ``user`` has blocked, as a subquery -- or ``None``.

    ``None`` means "nothing to filter": an anonymous reader, or an account
    with no blocks. Callers must leave their queryset untouched in that case
    (see the module docstring for why that matters).
    """
    viewer_id = _viewer_id(user)
    if viewer_id is None:
        return None
    blocks = CreatorBlock.objects.filter(blocker_id=viewer_id)
    if not blocks.exists():
        return None
    return blocks.values('blocked_id')


def exclude_blocked(queryset, user, field):
    """Drop rows whose ``field`` (a Creator FK path) ``user`` has blocked."""
    blocked = blocked_ids_subquery(user)
    if blocked is None:
        return queryset
    return queryset.exclude(**{f'{field}__in': blocked})


def exclude_blocked_events(queryset, user):
    """Drop content/contact notifications whose contributor ``user`` blocked.

    Money receipts are kept whoever sent them (``BLOCK_HIDDEN_EVENT_TYPES``).
    A NULL contributor (an anonymous donation) is never matched.
    """
    blocked = blocked_ids_subquery(user)
    if blocked is None:
        return queryset
    return queryset.exclude(
        Q(type__in=BLOCK_HIDDEN_EVENT_TYPES) & Q(contributor_id__in=blocked)
    )


def has_blocked(blocker_id, blocked_id) -> bool:
    """Has ``blocker_id`` blocked ``blocked_id``? Either may be ``None``."""
    if blocker_id is None or blocked_id is None or blocker_id == blocked_id:
        return False
    return CreatorBlock.objects.filter(
        blocker_id=blocker_id, blocked_id=blocked_id,
    ).exists()


def event_hidden_by_block(event) -> bool:
    """Would the event list hide ``event`` from its own receiver?

    The single-row twin of:func:`exclude_blocked_events`, for the realtime
    push, which must not deliver what the list would not show.
    """
    if event.type not in BLOCK_HIDDEN_EVENT_TYPES:
        return False
    return has_blocked(event.receiving_user_id, event.contributor_id)
