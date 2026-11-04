"""The single source of truth for the conversation subscriber-only read gate.

``Conversation.is_subscriber_only`` is a real, enforced access
tier: a conversation that is ``is_public=True`` **and** ``is_subscriber_only``
is readable ONLY by its owner and by an active subscriber of the conversation's
creator. Everyone else (anonymous or a merely-logged-in non-subscriber) is
denied.

Two different call shapes need that exact same rule:

* the conversation endpoints scope a queryset — they need it as a ``Q``
  (:func:`subscriber_visibility_q`);
* the comment-thread gate holds a single ``Conversation`` object — it needs it
  as a boolean (:func:`conversation_subscriber_visible`).

They MUST agree. When they didn't, the transcript was paywalled but the comment
thread under it stayed world-readable (issue, a regression from the
/ merge window). Both forms below are built on the SAME
:func:`_active_subscriptions` definition of "an active subscription", so the two
gates cannot drift apart again — that drift was the root cause of.

"Active subscriber of creator Y" is the same notion already used by the zPage
retrieve gate and ``Creator.has_fan``: an unexpired ``Subscription`` row
(``fan=viewer``, ``star=creator``) — not a new definition of subscriber.
"""
from django.db.models import Q
from django.utils import timezone

from dj.apps.g12f.models.creator import Subscription


def public_conversation_q(user, prefix=""):
    """Conversations whose public transcript may be served to ``user``.

    The conversation owner is the creator for this content type.  A
    deactivated owner therefore takes the public transcript down even when an
    old subscriber row still exists.
    """
    return (
        Q(**{f"{prefix}is_public": True})
        & Q(**{f"{prefix}user__is_active": True})
        & subscriber_visibility_q(user, prefix=prefix)
    )


def public_personality_q(prefix=""):
    """Publicly usable personalities: system rows or active owners."""
    return (
        Q(**{f"{prefix}creator__isnull": True})
        | Q(**{f"{prefix}creator__is_active": True})
    )


def _active_subscriptions(user):
    """Unexpired ``Subscription`` rows where ``user`` is the fan.

    The single definition of "an active subscription" that both gates below
    build on, so the queryset ``Q`` and the single-object boolean can never
    disagree about who counts as a current subscriber.
    """
    return Subscription.objects.filter(fan=user, expires__gte=timezone.now())


def subscriber_visibility_q(user, prefix=""):
    """Q matching conversations ``user`` may read once ``is_public`` is satisfied.

    Enforces ``Conversation.is_subscriber_only``: a subscriber-only
    conversation is readable ONLY by its owner and by an active subscriber of
    the conversation's creator.

    ``prefix`` lets the same predicate be applied across a relation, e.g.
    ``prefix="conversations__"`` to reach a ``Conversation`` from a
    ``PromptResponse``. Every lookup shares the given prefix so, when composed
    inside a SINGLE ``filter()`` over a multi-valued relation, they all bind to
    the same related conversation row (see the PromptResponse querysets).

    Note: this is only the subscriber gate. Callers MUST still AND it with the
    public/ownership predicate appropriate to their endpoint (``is_public=True``,
    ``user=request.user``,...); on its own it would expose non-public
    conversations that merely happen not to be subscriber-only.
    """
    not_gated = Q(**{f"{prefix}is_subscriber_only": False})
    if not getattr(user, "is_authenticated", False):
        # Anonymous: only conversations that are not subscriber-gated at all.
        return not_gated
    star_ids = _active_subscriptions(user).values_list("star_id", flat=True)
    return (
        not_gated
        | Q(**{f"{prefix}user__id__in": star_ids})
        | Q(**{f"{prefix}user": user})
    )


def conversation_subscriber_visible(conversation, user) -> bool:
    """Single-object mirror of:func:`subscriber_visibility_q` for ONE object.

    Answers the subscriber-only half of "may ``user`` read ``conversation``":
    not gated at all, OR the owner, OR an active subscriber of the creator.
    Callers that also care about ``is_public`` must AND that in themselves
    (exactly as:func:`subscriber_visibility_q` callers do).
    """
    if not conversation.is_subscriber_only:
        return True
    if not getattr(user, "is_authenticated", False):
        return False
    if conversation.user_id == user.id:
        return True
    return _active_subscriptions(user).filter(
        star_id=conversation.user_id
    ).exists()
