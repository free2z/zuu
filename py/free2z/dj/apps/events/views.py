from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.core.exceptions import PermissionDenied
from django.utils.decorators import method_decorator
from django.views.decorators.vary import vary_on_headers
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.decorators import api_view, permission_classes
from rest_framework.views import APIView

from django.contrib.contenttypes.prefetch import GenericPrefetch

from .models import Event, SOCIAL_EVENTS
from .recovery import EventPagination
from .serializers import EventSerializer
from .serializers import MentionPreferenceSerializer
from drf_spectacular.utils import extend_schema, OpenApiParameter
from dj.apps.g12f.zpage_paths import CANONICAL_CONTENT_URL_HEADER


@method_decorator(
    vary_on_headers(CANONICAL_CONTENT_URL_HEADER),
    name="dispatch",
)
class EventAPIView(generics.ListAPIView):
    serializer_class = EventSerializer
    pagination_class = EventPagination
    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(parameters=[
        OpenApiParameter(
            'recovery', type=str, enum=['payments'],
            description='Opt-in full receipt recovery ordered by immutable creation '
                        'time and UUID; restart from the beginning on every recovery.',
        ),
        OpenApiParameter(
            'recovery_cursor', type=str,
            description='Signed current-scan continuation from next. Bound to the '
                        'authenticated recipient; expires after two hours.',
        ),
    ])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)

    def get_queryset(self):
        user = self.request.user
        # we can't prefetch the generic content_object;/
        # we may have to someday create real FKs to each model
        base = Event.objects.filter(
            receiving_user=user
        ).select_related('receiving_user', 'contributor', 'payee')
        # One query per content type for the whole page instead of one per
        # row. Only chat requests get a custom queryset (their link check
        # reads `sender`); every other content type keeps Django's default
        # fetch through its base manager, exactly as row-by-row access did.
        from dj.apps.e2ee.models import ChatRequest
        base = base.prefetch_related(GenericPrefetch(
            'content_object',
            [ChatRequest.objects.select_related('sender')],
        ))
        if self.request.query_params.get('type') == "social":
            base = base.filter(type__in=SOCIAL_EVENTS)
        # Replies, mentions, chat requests etc. from an account the reader
        # blocked are not served; money receipts are (g12f/blocks.py).
        from dj.apps.g12f.blocks import exclude_blocked_events
        return exclude_blocked_events(base, user)


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def mark_event_as_read(request, event_id):
    # This shouldn't be required but it is:|
    if not request.user.is_authenticated:
        raise PermissionDenied
    event = get_object_or_404(
        Event, id=event_id, receiving_user=request.user)
    event.read = True
    event.save(update_fields=['read'])
    return Response({"message": "Event marked as read"})


@api_view(['POST'])
@permission_classes([permissions.IsAuthenticated])
def mark_all_events_as_read(request):
    # This shouldn't be required but it is:|
    if not request.user.is_authenticated:
        raise PermissionDenied
    Event.objects.filter(receiving_user=request.user).update(read=True)
    return Response({"message": "All events marked as read"})


# @api_view is required for @permission_classes to do anything at all:
# on a plain function view the decorator only sets an unread attribute.
@extend_schema(
    parameters=[OpenApiParameter(
        'include_recipient', type=str, location=OpenApiParameter.QUERY,
        required=False, enum=['1'],
        description='Return the count with its recipient username.',
    )],
    responses={200: {'oneOf': [
        {'type': 'integer', 'minimum': 0},
        {
            'type': 'object',
            'required': ['unread_count', 'recipient_username'],
            'properties': {
                'unread_count': {'type': 'integer', 'minimum': 0},
                'recipient_username': {'type': 'string'},
            },
        },
    ]}},
)
@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def unread_count(request):
    # This shouldn't be required but it is:|
    if not request.user.is_authenticated:
        raise PermissionDenied
    # The badge must count exactly what the list will show.
    from dj.apps.g12f.blocks import exclude_blocked_events
    count = exclude_blocked_events(
        Event.objects.filter(receiving_user=request.user, read=False),
        request.user,
    ).count()
    # Keep the long-standing numeric response for clients that render the
    # value directly (including the retained React application). The Svelte
    # notification store opts into the recipient envelope so a count from a
    # new session cannot be applied to an older account's in-memory feed.
    if request.query_params.get('include_recipient') == '1':
        return JsonResponse({
            'unread_count': count,
            'recipient_username': request.user.username,
        })
    return JsonResponse(count, safe=False)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def has_events(request):
    if not request.user.is_authenticated:
        raise PermissionDenied
    exists = Event.objects.filter(receiving_user=request.user).exists()
    return JsonResponse(exists, safe=False)


class MentionPreferenceView(APIView):
    """Read or update the authenticated creator's in-app mention opt-out."""

    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(
        request=None,
        responses={200: MentionPreferenceSerializer},
    )
    def get(self, request):
        return Response({
            'enabled': request.user.mention_notifications_enabled,
        })

    @extend_schema(
        request=MentionPreferenceSerializer,
        responses={200: MentionPreferenceSerializer},
    )
    def patch(self, request):
        enabled = request.data.get('enabled')
        if not isinstance(enabled, bool):
            return Response(
                {'enabled': ['A boolean is required.']},
                status=status.HTTP_400_BAD_REQUEST,
            )
        request.user.mention_notifications_enabled = enabled
        request.user.save(update_fields=[
            'mention_notifications_enabled', 'updated_at',
        ])
        return Response({
            'enabled': request.user.mention_notifications_enabled,
        })
