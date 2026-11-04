"""Object-level permissions for the AI conversation endpoints.

Queryset scoping alone is not a security boundary: a future ``get_object``
override, a custom ``@action``, or a serializer that resolves an object by id
bypasses ``get_queryset`` entirely. Every private conversation endpoint
therefore carries a real ``BasePermission`` in addition to a scoped queryset,
so the two have to fail together for data to leak.
"""
import uuid

from rest_framework import permissions

from .models import Conversation


def valid_uuid(value):
    """Return ``value`` as a ``uuid.UUID``, or ``None`` if it isn't one.

    The nested router matches ``[0-9a-f-]+``, which accepts plenty of strings
    that are not UUIDs (``"a"``, ``"---"``, ...). Passing one of those to a
    ``UUIDField`` lookup raises ``ValidationError`` from deep inside the ORM and
    surfaces as a 500. Callers use this to fail closed with a 403/404 instead.
    """
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


class IsConversationOwner(permissions.BasePermission):
    """Guards ``/conversations/<conversation_id>/promptresponses/...``.

    ``has_permission`` requires the requester to own the conversation named in
    the URL, so an unowned ``conversation_id`` is rejected before any handler
    runs (including custom actions that never touch ``get_queryset``).

    ``has_object_permission`` re-checks ownership on the resolved object.
    ``PromptResponse`` is attached to conversations through a *many-to-many*
    (``Conversation.prompt_response_set``), and ``fork`` deliberately shares the
    same rows between the original conversation and the forked copy. So owning a
    fork must not confer the right to rewrite or delete the original author's
    messages: unsafe methods additionally require that the requester authored
    the ``PromptResponse``.
    """

    message = "You do not have access to this conversation."

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False

        conversation_id = valid_uuid(view.kwargs.get("conversation_id"))
        if conversation_id is None:
            return False

        return Conversation.objects.filter(
            id=conversation_id, user=user
        ).exists()

    def has_object_permission(self, request, view, obj):
        user = request.user
        if not user or not user.is_authenticated:
            return False

        # The row must be reachable through a conversation this user owns.
        if not obj.conversations.filter(user=user).exists():
            return False

        if request.method in permissions.SAFE_METHODS:
            return True

        # Mutating a shared (forked) row would edit someone else's transcript.
        return obj.user_id == user.id
