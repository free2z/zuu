from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.core.exceptions import PermissionDenied
from django.utils.decorators import method_decorator
from django.db import transaction
from django.views.decorators.vary import vary_on_headers
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.decorators import api_view, permission_classes
from rest_framework.views import APIView

from django.contrib.contenttypes.prefetch import GenericPrefetch

from .models import Event, SOCIAL_EVENTS
from .recovery import EventPagination
from .serializers import EventSerializer
from .serializers import (MentionPreferenceSerializer, LowBalancePreferenceSerializer,
                          LowBalancePreferenceConflictSerializer, LowBalancePreferenceWriteSerializer)
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

    @extend_schema(request=MentionPreferenceSerializer, responses={200: MentionPreferenceSerializer})
    def patch(self, request):
        enabled = request.data.get('enabled')
        if not isinstance(enabled, bool):
            return Response({'enabled': ['A boolean is required.']}, status=status.HTTP_400_BAD_REQUEST)
        request.user.mention_notifications_enabled = enabled
        request.user.save(update_fields=['mention_notifications_enabled', 'updated_at'])
        return Response({'enabled': request.user.mention_notifications_enabled})


class LowBalancePreferenceView(APIView):
    """First-party account preference; no OAuth scope grants access."""

    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(request=None, parameters=[OpenApiParameter('expected_actor_id', int, required=True)],
                   responses={200: LowBalancePreferenceSerializer, 409: LowBalancePreferenceConflictSerializer})
    def get(self, request):
        if request.query_params.get('expected_actor_id') != str(request.user.pk):
            return self.account_changed()
        return Response({'enabled': request.user.low_balance_notice_enabled, 'actor_id': request.user.pk})

    @staticmethod
    def account_changed():
        return Response({'code': 'account_changed', 'detail': 'The signed-in account or session changed.'}, status=409)

    @extend_schema(request=LowBalancePreferenceWriteSerializer,
                   responses={200: LowBalancePreferenceSerializer, 409: LowBalancePreferenceConflictSerializer})
    def patch(self, request):
        expected_actor = request.data.get('expected_actor_id')
        if type(expected_actor) is not int or expected_actor < 1:
            return Response({'expected_actor_id': ['A positive integer is required.']}, status=400)
        if expected_actor != request.user.pk:
            return self.account_changed()
        snapshot_epoch = request.user.kt_account_epoch
        enabled = request.data.get('enabled')
        if not isinstance(enabled, bool):
            return Response({'enabled': ['A boolean is required.']}, status=status.HTTP_400_BAD_REQUEST)
        locale = request.data.get('locale')
        if locale is not None and locale not in ('en', 'es', 'fr', 'pt-BR'):
            return Response({'locale': ['Unsupported language.']}, status=status.HTTP_400_BAD_REQUEST)
        from dj.apps.g12f.models import Creator
        with transaction.atomic():
            creator = Creator.objects.select_for_update().filter(pk=expected_actor).first()
            if creator is None or not creator.is_active or creator.kt_account_epoch != snapshot_epoch:
                return self.account_changed()
            if creator.low_balance_notice_enabled != enabled:
                creator.low_balance_notice_enabled = enabled
                creator.low_balance_notice_generation += 1
                creator.low_balance_notice_pending = False
                creator.low_balance_notice_pending_epoch = None
                if enabled and locale is not None:
                    creator.low_balance_notice_locale = locale
                creator.save(update_fields=['low_balance_notice_enabled', 'low_balance_notice_generation',
                                            'low_balance_notice_pending', 'low_balance_notice_pending_epoch',
                                            'low_balance_notice_locale', 'updated_at'])
        return Response({'enabled': enabled, 'actor_id': expected_actor})
