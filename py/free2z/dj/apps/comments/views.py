from django.http import Http404
from django.shortcuts import get_object_or_404
from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.db.models import Case, CharField, F, Q, Value, When
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.vary import vary_on_headers

from rest_framework import (
    generics, pagination, status, permissions, viewsets, mixins,
    serializers, exceptions
)
from rest_framework.response import Response
from rest_framework.filters import SearchFilter, OrderingFilter
from rest_framework.decorators import api_view, permission_classes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    extend_schema_view,
)
from rest_framework.permissions import (
    IsAuthenticated, IsAuthenticatedOrReadOnly
)

from django_filters import FilterSet, CharFilter, Filter
from django_filters.rest_framework import DjangoFilterBackend
from django_filters import rest_framework as filters

from dj.free2z.pagination import (
    CommentStreamCursorPagination,
    Free2zPagination,
)
from dj.apps.g12f.blocks import exclude_blocked
from dj.apps.g12f.models import zPage
from dj.apps.g12f.zpage_paths import CANONICAL_CONTENT_URL_HEADER
from dj.apps.events.models import Event
from dj.apps.openai.models import Conversation
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency
from dj.apps.tuzis.ledger import InsufficientFunds

from .serializers import CommentEditSerializer, CommentListSerializer
from dj.apps.tuzis.serializers import InsufficientFundsErrorSerializer
from .models import Comment
from .visibility import (
    comment_visible,
    scope_comments_to_visible_parents,
    pending_author_leaf,
    REDACTED_AUTHOR,
    zpage_visible,
    conversation_visible,
)


COMMENT_IDEMPOTENCY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36},
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optional UUIDv4 key for retrying one paid comment, reply, or vote. "
        "A completed keyed request is replayed rather than charged again."
    ),
)


def _request_idempotency_key(request):
    return idempotency.request_key(request)


def _required_comment_key(request):
    if request.headers.get("Idempotency-Key") is None:
        return None, None
    key = _request_idempotency_key(request)
    if key is None:
        return None, Response(
            {
                "code": "idempotency_key_required",
                "error": "A valid UUIDv4 Idempotency-Key header is required.",
            },
            status=status.HTTP_400_BAD_REQUEST,
        )
    return key, None


def _duplicate_response(duplicate):
    if duplicate.in_flight:
        return Response(
            {"code": "request_in_progress", "error": "The original request is still in progress."},
            status=status.HTTP_409_CONFLICT,
        )
    if not isinstance(duplicate.record.response_body, dict):
        return Response(
            {"code": "invalid_idempotency_record", "error": "The original response could not be replayed safely."},
            status=status.HTTP_409_CONFLICT,
        )
    return Response(
        {**duplicate.record.response_body, "replayed": True},
        status=duplicate.record.response_status,
    )


def _claim_paid_request(request, scope, payload):
    key, error = _required_comment_key(request)
    if error is not None:
        return None, error
    if key is None:
        return None, None
    request_hash = idempotency.fingerprint(payload)
    try:
        return idempotency.claim(
            scope, request.user, key, request_hash=request_hash
        ), None
    except idempotency.IdempotencyConflict:
        return None, Response(
            {
                "code": "idempotency_mismatch",
                "error": "This idempotency key was already used for a different request.",
            },
            status=status.HTTP_409_CONFLICT,
        )
    except idempotency.DuplicateRequest as duplicate:
        return None, _duplicate_response(duplicate)


def _create_paid_comment(
    request, serializer, *, scope, amount, payload, save_kwargs=None, claim=None
):
    if claim is None:
        claim, duplicate_response = _claim_paid_request(request, scope, payload)
        if duplicate_response is not None:
            return duplicate_response
    try:
        with transaction.atomic():
            ledger.debit(request.user, amount, action=scope)
            instance = serializer.save(**(save_kwargs or {}))
            body = {
                **CommentListSerializer(instance, context=serializer.context).data,
                "replayed": False,
            }
            if claim is not None:
                claim.finish(status.HTTP_201_CREATED, body)
    except InsufficientFunds as exc:
        if claim is not None:
            idempotency.release(claim)
        return Response(
            ledger.insufficient_funds_payload(exc, action=scope),
            status=status.HTTP_402_PAYMENT_REQUIRED,
        )
    except Exception:
        if claim is not None:
            idempotency.release(claim)
        raise
    return Response(body, status=status.HTTP_201_CREATED)

class CommaSeparatedCharFilter(Filter):
    def filter(self, qs, value):
        if not value:
            return qs

        # Split the comma separated values
        values = value.split(',')

        # Filter the queryset for any of the values
        for v in values:
            qs = qs.filter(**{f"{self.field_name}__iexact": v})

        return qs


#Query parameters that select no rows by content (pagination, ordering).
_UNFILTERED_LIST_PARAMS = frozenset({'page', 'page_size', 'limit', 'offset', 'ordering', 'format'})


class CommentFilter(filters.FilterSet):
    subscribed_to = filters.BooleanFilter(method='filter_subscribed_to')
    tags = CommaSeparatedCharFilter(field_name='tags__name', lookup_expr='in')
    # "Microblog only": standalone converse posts, i.e. anything that
    # is NOT a reply. Until now the firehose necessarily interleaved standalone
    # posts with replies on zPages and there was no way to ask for just the
    # posts -- `parent__isnull` existed only on the scoped
    # AuthorParentCommentFilter. A plain BooleanFilter so django-filter's
    # coercion (1/true/yes/on) applies, the same as `subscribed_to`.
    parent__isnull = filters.BooleanFilter(
        field_name='parent', lookup_expr='isnull')
    #...and the OTHER half of "microblog only". `parent IS NULL` alone is not
    # a standalone converse post: a FIRST-level comment on a zPage or on an AI
    # conversation also has no parent, and differs only in carrying a
    # `content_type`. `visibility.py` is explicit that microblog content is
    # `content_type IS NULL`; a posts-only stream built on `parent__isnull`
    # alone therefore still interleaves article comments, which is the exact
    # thing the filter exists to remove. Both filters are literal -- each does
    # what its name says -- and "microblog only" is the documented
    # composition of the two, so neither name lies about its own behaviour.
    content_type__isnull = filters.BooleanFilter(
        field_name='content_type', lookup_expr='isnull')
    # The per-creator surface: a profile's Posts tab. `iexact`
    # deliberately -- profile links are built from the displayed username and
    # must not break on case. Narrows the already-scoped queryset only; a
    # deactivated author's corpus stays hidden through this parameter exactly
    # as through every other.
    author = filters.CharFilter(
        field_name='author__username', lookup_expr='iexact')

    class Meta:
        model = Comment
        fields = [
            'subscribed_to', 'parent__isnull', 'content_type__isnull',
            'author',
        ]

    # here filter_subscribed_to will return a queryset of comments
    # where the Comment__author is the request.user.get_stars
    def filter_subscribed_to(self, queryset, name, value):
        # According to GPT
        # In Django Filters, when using a BooleanFilter,
        # the value that you get from the query string is
        # first passed through a normalization process.
        # This means that:
        # - 1, true, True will all be treated as True.
        # - 0, false, False will all be treated as False.

        user = getattr(self.request, 'user', None)

        # If the user wants to filter by subscriptions and is authenticated
        if value and user and user.is_authenticated:
            return queryset.filter(author__in=user.get_stars())
        return queryset


class IsAuthorOrReadOnly(permissions.BasePermission):
    """
    Custom permission to only allow authors of an object to edit or delete it.
    """

    def has_object_permission(self, request, view, obj):
        # print("has_object_permission")
        # Read permissions are allowed for any request
        if request.method in permissions.SAFE_METHODS:
            return True

        if not request.user.is_authenticated:
            return False

        # Write permissions are only allowed to the author of the comment
        return obj.author == request.user


# Declared so a generated client can opt into keyset pagination at all: an
# undeclared query parameter is invisible to orval and therefore to every
# caller that builds requests from the spec. Same wording as the
# zPage feed's parameters so the two cursor contracts read as one.
COMMENT_PAGINATION_PARAMETER = OpenApiParameter(
    name="pagination",
    type=str,
    location=OpenApiParameter.QUERY,
    enum=["cursor"],
    description=(
        "Opt into stable keyset pagination for the live stream, ordered on "
        "(-created_at, -uuid). Omit this parameter to retain the default "
        "page-number contract. Only `ordering=-created_at` (the default) is "
        "accepted in this mode: the Hot sort (`-tuzis`) is mutable and stays "
        "on page numbers."
    ),
)

COMMENT_CURSOR_PARAMETER = OpenApiParameter(
    name="cursor",
    type=str,
    location=OpenApiParameter.QUERY,
    description=(
        "Opaque continuation token returned in `next`; use only with "
        "`pagination=cursor`."
    ),
)


@extend_schema_view(
    list=extend_schema(
        parameters=[
            COMMENT_PAGINATION_PARAMETER,
            COMMENT_CURSOR_PARAMETER,
        ],
    ),
    create=extend_schema(
        parameters=[COMMENT_IDEMPOTENCY_PARAMETER],
        responses={
            201: CommentListSerializer,
            402: InsufficientFundsErrorSerializer,
        }
    ),
    update=extend_schema(
        request=CommentEditSerializer,
        responses={200: CommentListSerializer},
    ),
    partial_update=extend_schema(
        request=CommentEditSerializer,
        responses={200: CommentListSerializer},
    ),
)
@method_decorator(
    vary_on_headers(CANONICAL_CONTENT_URL_HEADER),
    name="dispatch",
)
class CommentViewSet(mixins.CreateModelMixin,
                     mixins.RetrieveModelMixin,
                     mixins.ListModelMixin,
                     mixins.UpdateModelMixin,
                     mixins.DestroyModelMixin,
                     viewsets.GenericViewSet):
    queryset = Comment.objects.all().prefetch_related(
        'tags',
        'author__avatar_image__webp',
        'author__avatar_image__variants',
    ).select_related('author', 'author__avatar_image')
    serializer_class = CommentListSerializer
    # IsAuthorOrReadOnly defines only has_object_permission, so has_permission
    # falls back to True and POST /api/comments/ was anonymous at the
    # permission layer — the last write the fail-closed default did not reach
    #. It was saved only by an inline check in perform_create(), which
    # passes a `status=` kwarg ValidationError does not accept and so returned
    # 400 rather than a refusal. IsAuthenticatedOrReadOnly closes it at the
    # layer that is actually audited; IsAuthorOrReadOnly still owns per-object
    # ownership on edit/delete. Anonymous GET is unaffected (SSR only ever
    # GETs /api/comments/{uuid}/).
    permission_classes = [permissions.IsAuthenticatedOrReadOnly,
                          IsAuthorOrReadOnly]
    # The claim must commit before the money transaction so a concurrent retry
    # cannot enter the charge path with an invisible claim.
    atomic_request = False
    lookup_field = 'uuid'

    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class = CommentFilter
    search_fields = [
        'headline',
        'content',
        'author__username',
        'searchable_author_full_name',
    ]
    ordering_fields = ['created_at', 'tuzis']
    ordering = ['-created_at']

    @property
    def paginator(self):
        """Use stable keyset pagination only for opted-in stream requests.

        Same shape as zPageView's: the default stays the page-number
        paginator so every existing consumer keeps its contract, and the
        cursor paginator is reachable only through ``?pagination=cursor``. A
        bare ``cursor=`` without the mode parameter is a client error rather
        than a silently-ignored token -- an ignored cursor would serve page
        one of the stream under a UI that believes it is showing page five
        . An unknown mode is a 400 for the same reason: a typo must not
        quietly degrade to numbered pages.
        """
        if not hasattr(self, '_paginator'):
            pagination_mode = self.request.query_params.get('pagination')
            cursor = self.request.query_params.get('cursor')
            if pagination_mode not in (None, '', 'cursor'):
                raise exceptions.ValidationError({
                    'pagination': 'Unsupported pagination mode.',
                })
            if cursor and pagination_mode != 'cursor':
                raise exceptions.ValidationError({
                    'cursor': (
                        'Set pagination=cursor when supplying a cursor.'
                    ),
                })
            pagination_class = self.pagination_class
            if self.action == 'list' and pagination_mode == 'cursor':
                pagination_class = CommentStreamCursorPagination
            self._paginator = (
                pagination_class() if pagination_class is not None else None
            )
        return self._paginator

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        response = _create_paid_comment(
            request,
            serializer,
            scope="comment",
            amount=serializer.validated_data["tuzis"],
            payload={
                "action": "comment",
                "intent": "create",
                "kind": "comment",
                "body": request.data,
            },
            save_kwargs={"author": request.user},
        )
        if response.status_code == status.HTTP_201_CREATED:
            for header, value in self.get_success_headers(response.data).items():
                response[header] = value
        return response

    def filter_queryset(self, queryset):
        filtered = super().filter_queryset(queryset)
        if self.action != 'retrieve':
            # Listed, a placeholder (a purged author's kept comment) shows
            # only unfiltered: a search or filter could match the username,
            # text or tags it hides (visibility.REDACTED_AUTHOR).
            if set(self.request.query_params) - _UNFILTERED_LIST_PARAMS:
                filtered = filtered.exclude(REDACTED_AUTHOR)
            return filtered
        # A placeholder opens by its uuid whatever the query string says:
        # matching it against its hidden text, author or tags (?search=,
        # ?author=) would answer what it hides (visibility.REDACTED_AUTHOR).
        return queryset.filter(
            Q(pk__in=filtered.exclude(REDACTED_AUTHOR).values('pk'))
            | REDACTED_AUTHOR
        )

    def get_queryset(self):
        # A comment is only as visible as the thing it is attached to. Without
        # this, GET /api/comments/ bulk-returned every comment on the platform
        # including threads on unpublished drafts, subscriber-only pages and
        # private AI conversations — to anonymous callers, and retrieve/update/
        # destroy of a single comment ran off the same unscoped set.
        # Standalone converse posts (no parent) stay public while their author's
        # account is active; a comment on a zPage/Conversation is shown
        # only when that parent is visible to the requester. Object-level
        # requests (retrieve/update/destroy) therefore 404 on a hidden parent
        # rather than leaking its existence.
        visible = scope_comments_to_visible_parents(
            super().get_queryset(), self.request.user,
            # A pending-deletion author's replied-to comment opens as its
            # thread placeholder (a "N replies" link, a shared thread URL);
            # lists and writes never see it (visibility.DELETION_PENDING_AUTHOR).
            placeholders=self.action == 'retrieve',
        )
        if self.action == 'list':
            # A blocker stops being served the blocked account's comments
            #. Lists only: retrieve/update/destroy keep resolving so
            # a link opened on purpose still works (see g12f/blocks.py).
            visible = exclude_blocked(visible, self.request.user, 'author')
        # Attached comments remain visible when their own author is
        # deactivated: the active zPage/conversation parent governs that
        # historical thread. The serialized comment still carries the
        # public username, but every public creator endpoint stops exposing the
        # now-inactive account's full_name. Searching the raw relationship here
        # used to leave that redacted value queryable as an existence oracle
        #. Keep active full names searchable -- they are intentionally
        # published on profiles and in the creator directory -- and turn only
        # the inactive value into an empty search document.
        return visible.annotate(
            searchable_author_full_name=Case(
                When(author__is_active=True, then=F('author__full_name')),
                default=Value(''),
                output_field=CharField(),
            )
        )

    def perform_create(self, serializer):
        # create() owns the transaction and request-idempotency claim. Keep
        # this method only for mixin compatibility; direct callers should use
        # create() so a retry cannot charge twice.
        serializer.save(author=self.request.user)
        # # Create a 'MADE_COMMENT' event for the user
        # Event.objects.create(
        #     type='MADE_COMMENT',
        #     receiving_user=self.request.user,
        #     contributor=self.request.user,
        #     content_object=instance,
        # )


@extend_schema(
    parameters=[COMMENT_IDEMPOTENCY_PARAMETER],
    responses={
        200: OpenApiResponse(
            response={
                "type": "object",
                "required": ["success", "tuzis", "replayed"],
                "properties": {
                    "success": {"type": "string"},
                    "tuzis": {"type": "string", "format": "decimal"},
                    "replayed": {"type": "boolean"},
                },
            },
            description="The vote and the authoritative comment score.",
        ),
        402: InsufficientFundsErrorSerializer,
    }
)
@transaction.non_atomic_requests
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def vote_comment(request, uuid):
    key, key_error = _required_comment_key(request)
    if key_error is not None:
        return key_error
    # Check if the request is an upvote or a downvote
    vote = request.data.get('vote')
    if vote == 'up':
        delta = 1
    elif vote == 'down':
        delta = -1
    else:
        # Return an error if the request is not an upvote or downvote
        return Response({'error': 'Invalid vote type'}, status=400)

    claim, duplicate_response = _claim_paid_request(
        request,
        "comment_vote",
        {
            "action": "comment_vote",
            "intent": "vote",
            "comment": str(uuid),
            "direction": vote,
            "amount": "1",
        },
    )
    if duplicate_response is not None:
        return duplicate_response

    # Replay is deliberately before visibility lookup. A completed receipt is
    # scoped to this authenticated actor and stable comment UUID, so it remains
    # reachable after the parent is unpublished without exposing it to anyone
    # else. New claims still pass the visibility gate before any debit.
    try:
        comment = get_object_or_404(Comment, uuid=uuid)
    except Exception:
        idempotency.release(claim)
        raise
    if not comment_visible(comment, request.user):
        idempotency.release(claim)
        raise Http404
    user = request.user

    # TODO: process the events asynchronously
    #
    # It IS threadsafe now. The old code read the balance, checked
    # it, decremented in Python and saved — two concurrent votes both passed
    # the check and the last write won, so one 2Z bought two votes and the
    # balance could go negative. Both the charge and the score are now single
    # conditional UPDATE statements inside one transaction.
    # The charge, the score and BOTH accounting events are one transaction.
    # Leaving the events outside it means a failed event write returns a 500
    # to a user who has already been charged and whose vote has already
    # landed — and their retry charges again.
    try:
        with transaction.atomic():
            # Taking the voter's balance before the Comment closes the cycle
            # with aiscore_comments, which locks the comment author's balance
            # before that same Comment.
            ledger.lock_in_order(user)
            comment = Comment.objects.select_for_update(of=("self",)).select_related(
                "author"
            ).get(pk=comment.pk)
            ledger.debit(user, 1, action="comment_vote")
            # Comment.tuzis is the comment's vote SCORE, not a balance; the
            # money moved on the line above. Allowlisted in
            # tuzis/test_ledger_only_balance_writers.py.
            Comment.objects.filter(pk=comment.pk).update(
                tuzis=F('tuzis') + delta)

            # Create event for user accounting
            ev, created = Event.objects.get_or_create(
                read=True,
                type='VOTE_COMMENT_SENT',
                receiving_user=user,
                contributor=user,
                # content_object=comment,
                object_id=comment.uuid,
                content_type=ContentType.objects.get_for_model(comment),
                defaults={
                    'amount': 1,
                },
            )
            if not created:
                ev.amount += 1
                ev.updated_at = timezone.now()
                ev.save()

            # create event for the comment author if different
            if comment.author != user:
                author_ev, created = Event.objects.get_or_create(
                    type='VOTE_COMMENT_RECEIVED',
                    receiving_user=comment.author,
                    contributor=user,
                    object_id=comment.uuid,
                    content_type=ContentType.objects.get_for_model(comment),
                    defaults={
                        'amount': 1,
                    },
                )
                if not created:
                    author_ev.read = False
                    author_ev.amount += 1
                    author_ev.updated_at = timezone.now()
                    author_ev.save()
            comment.refresh_from_db(fields=['tuzis'])
            if claim is not None:
                claim.finish(
                    status.HTTP_200_OK,
                    {
                        'success': 'Vote recorded',
                        'tuzis': str(comment.tuzis),
                        'replayed': False,
                    },
                )
    except InsufficientFunds as exc:
        if claim is not None:
            idempotency.release(claim)
        return Response(
            ledger.insufficient_funds_payload(exc, action="comment_vote"),
            status=status.HTTP_402_PAYMENT_REQUIRED,
        )
    except Exception:
        if claim is not None:
            idempotency.release(claim)
        raise

    comment.refresh_from_db(fields=['tuzis'])

    # Return a success response
    return Response({
        'success': 'Vote recorded',
        # Keep the first response byte-for-byte compatible with the replay
        # receipt. DRF would otherwise leave this Decimal in the live response
        # and the idempotent retry would return the stored string.
        'tuzis': str(comment.tuzis),
        'replayed': False,
    })


class AuthorParentCommentFilter(FilterSet):
    # comments/12/61/?author=s
    author = CharFilter(field_name='author__username')
    # special;/
    # comments/12/61/?parent__isnull=1
    parent__isnull = CharFilter(
        field_name='parent', lookup_expr='isnull')
    # /api/comments/12/61/?author=s&parent=1

    # Custom method to handle isnull filtering
    def filter_parent_isnull(self, queryset, name, value):
        if value in ['1', 'True', 'true']:
            return queryset.filter(parent__isnull=True)
        elif value in ['0', 'False', 'false']:
            return queryset.filter(parent__isnull=False)
        else:
            return queryset

    parent__isnull = filters.CharFilter(method='filter_parent_isnull')

    class Meta:
        model = Comment
        fields = ['author', 'parent']


@extend_schema_view(
    post=extend_schema(
        parameters=[COMMENT_IDEMPOTENCY_PARAMETER],
        responses={
            201: CommentListSerializer,
            402: InsufficientFundsErrorSerializer,
        }
    ),
)
@method_decorator(
    vary_on_headers(CANONICAL_CONTENT_URL_HEADER),
    name="dispatch",
)
class CommentListCreateAPIView(generics.ListCreateAPIView):
    """
    Comments under a content object identified by UUID and type
    """
    # Reading comments is public (they render on public zPages and on the
    # crawler-facing prerender); creating one spends 2Z and is already
    # rejected for anonymous users inside create().
    permission_classes = [IsAuthenticatedOrReadOnly]
    atomic_request = False
    serializer_class = CommentListSerializer
    pagination_class = Free2zPagination
    filter_backends = [DjangoFilterBackend]
    filterset_class = AuthorParentCommentFilter

    def get_parent_object(self, uuid):
        # A comment thread is only as visible as its parent, for both reading
        # (get_queryset) and writing (create) — a hidden parent 404s here so it
        # never becomes an existence oracle and never accepts a write (
        # ). Anonymous writes are still refused later in create() with a 403
        # once the parent has been confirmed publicly visible.
        if self.kwargs["type"] == "zpage":
            # Identify the model by ContentType framework based on UUID
            try:
                content_type = ContentType.objects.get_for_model(zPage)
                parent_object: zPage = content_type.get_object_for_this_type(free2zaddr=uuid)
                if not parent_object.vanity:
                    raise Http404
            except (ContentType.DoesNotExist, zPage.DoesNotExist):
                raise Http404
            # Publication + paywall gate: unpublished drafts and subscriber-only
            # pages must not expose (or accept) comments to non-owners, mirroring
            # zPageView.get_queryset for the page itself.
            if not zpage_visible(parent_object, self.request.user):
                raise Http404

        elif self.kwargs["type"] == "ai_conversation":
            # Identify the model by ContentType framework based on UUID
            try:
                content_type = ContentType.objects.get_for_model(Conversation)
                parent_object = content_type.get_object_for_this_type(id=uuid)
            except (ContentType.DoesNotExist, Conversation.DoesNotExist):
                raise Http404
            #previously checked nothing — a private conversation's thread
            # was world-readable/writable to anyone holding the UUID. Mirror
            # 's read access: owner OR is_public.
            if not conversation_visible(parent_object, self.request.user):
                raise Http404

        else:
            # Unknown parent type: fail closed rather than leaving
            # parent_object unbound (it would have raised UnboundLocalError).
            raise Http404

        return parent_object

    def filter_queryset(self, queryset):
        filtered = super().filter_queryset(queryset)
        # A placeholder has no author to filter by: ?author= must not find
        # it by the account it hides (visibility.REDACTED_AUTHOR).
        if self.request.query_params.get('author'):
            filtered = filtered.exclude(REDACTED_AUTHOR)
        return filtered

    def get_queryset(self):
        uuid = self.kwargs['uuid']
        parent_object = self.get_parent_object(uuid)
        # Filter the comments to only include those associated with the parent object
        return exclude_blocked(
            Comment.objects.filter(
                content_type=ContentType.objects.get_for_model(parent_object),
                object_id=parent_object.id,
            ).exclude(pending_author_leaf()),
            self.request.user,
            'author',
        )

    def create(self, request, *args, **kwargs):
        _, key_error = _required_comment_key(request)
        if key_error is not None:
            return key_error
        uuid = self.kwargs['uuid']

        # Create a serializer instance with the request data
        serializer = self.get_serializer(data=request.data)

        # Validate the data
        serializer.is_valid(raise_exception=True)
        # Check if the user has enough tuzis to make the comment
        user = request.user
        if user.is_anonymous:
            return Response(
                {'error': 'You must be logged in to make a comment'},
                status=status.HTTP_403_FORBIDDEN,
            )
        tuzis = serializer.validated_data['tuzis']
        if tuzis < 1:
            return Response(
                {'error': 'Tuzis must be positive'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # The route UUID and submitted amount/body are enough to reconstruct a
        # completed receipt. Claim before resolving the mutable parent so a
        # retry after unpublish/deactivation can still replay its charge.
        claim, duplicate_response = _claim_paid_request(
            request,
            "comment",
            {
                "action": "comment",
                "intent": "create",
                "kind": "comment",
                "parent_type": self.kwargs["type"],
                "parent": str(uuid),
                "amount": str(tuzis),
                "body": request.data,
            },
        )
        if duplicate_response is not None:
            return duplicate_response
        try:
            parent_object = self.get_parent_object(uuid)
        except Exception:
            idempotency.release(claim)
            raise

        # Get the content type and object ID of the parent object.
        content_type = ContentType.objects.get_for_model(parent_object)
        object_id = str(parent_object.id)
        serializer.validated_data['content_type'] = content_type
        serializer.validated_data['object_id'] = object_id
        serializer.validated_data['author'] = request.user
        return _create_paid_comment(
            request,
            serializer,
            scope="comment",
            amount=tuzis,
            payload={
                "kind": "comment",
                "parent_type": self.kwargs["type"],
                "parent": str(uuid),
                "amount": str(tuzis),
                "body": request.data,
            },
            claim=claim,
        )


@extend_schema_view(
    post=extend_schema(
        parameters=[COMMENT_IDEMPOTENCY_PARAMETER],
        responses={
            status.HTTP_201_CREATED: CommentListSerializer,
            status.HTTP_402_PAYMENT_REQUIRED: InsufficientFundsErrorSerializer,
        },
    ),
)
@method_decorator(
    vary_on_headers(CANONICAL_CONTENT_URL_HEADER),
    name="dispatch",
)
class ParentCommentListCreateAPIView(generics.ListCreateAPIView):
    """
    These are the child comments for a parent comment identified by UUID.

    NEW - not tied to zpage
    """
    # Same split as the parent list: public read, authenticated create.
    permission_classes = [IsAuthenticatedOrReadOnly]
    atomic_request = False
    serializer_class = CommentListSerializer
    pagination_class = Free2zPagination
    filter_backends = [DjangoFilterBackend]
    filterset_class = AuthorParentCommentFilter
    # queryset = Comment.objects.all()

    def get_parent_comment(self):
        # A reply is only as visible as the thread it hangs under: create()
        # copies the parent's content_type/object_id onto the new comment, so
        # without this a reply could be read from — or injected into — the
        # thread of an unpublished/subscriber-only zPage or a private AI
        # conversation, bypassing the paywall the parent content enforces.
        # A standalone converse post has no content_object and stays public
        # while its author's account is active.
        parent_comment = get_object_or_404(Comment, uuid=self.kwargs['uuid'])
        # placeholder_ok: a pending-deletion author's comment that others
        # replied to still holds their replies (visibility.DELETION_PENDING_AUTHOR).
        if not comment_visible(parent_comment, self.request.user, placeholder_ok=True):
            raise Http404
        return parent_comment

    def filter_queryset(self, queryset):
        filtered = super().filter_queryset(queryset)
        # A placeholder has no author to filter by: ?author= must not find
        # it by the account it hides (visibility.REDACTED_AUTHOR).
        if self.request.query_params.get('author'):
            filtered = filtered.exclude(REDACTED_AUTHOR)
        return filtered

    def get_queryset(self):
        # Get the parent comment object based on the provided UUID (scoped).
        parent_comment = self.get_parent_comment()

        # Filter the comments to only include those that are associated with the parent comment object
        # and scope each reply itself: a reply under a standalone converse
        # post has content_type IS NULL (create() copies the parent's), so by
        # 's own definition it IS a standalone post and serves only while
        # its author is active. Replies on a visible zPage/Conversation stay
        # parent-governed, exactly as everywhere else this helper is used.
        return exclude_blocked(
            scope_comments_to_visible_parents(
                Comment.objects.filter(parent=parent_comment),
                self.request.user, placeholders=True,
            ),
            self.request.user,
            'author',
        )

    def create(self, request, *args, **kwargs):
        _, key_error = _required_comment_key(request)
        if key_error is not None:
            return key_error
        # print(parent_comment)
        # Create a serializer instance with the request data
        serializer = self.get_serializer(data=request.data)
        # print(serializer)
        # Validate the data
        serializer.is_valid(raise_exception=True)
        # print("is_valid")

        # print(serializer.validated_data)
        # Check if the user has enough tuzis to make the comment
        user = request.user
        if user.is_anonymous:
            return Response(
                {'error': 'You must be logged in to make a comment'},
                status=status.HTTP_403_FORBIDDEN,
            )
        tuzis = serializer.validated_data['tuzis']
        if tuzis < 1:
            return Response(
                {'error': 'Tuzis must be positive'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Claim from the stable route UUID before the visibility lookup. This
        # keeps a committed reply receipt replayable after its parent becomes
        # private or its author is deactivated.
        claim, duplicate_response = _claim_paid_request(
            request,
            "comment_reply",
            {
                "action": "comment_reply",
                "intent": "create",
                "kind": "comment_reply",
                "parent": str(self.kwargs['uuid']),
                "amount": str(tuzis),
                "body": request.data,
            },
        )
        if duplicate_response is not None:
            return duplicate_response
        try:
            parent_comment = self.get_parent_comment()
        except Exception:
            idempotency.release(claim)
            raise
        serializer.validated_data['parent'] = parent_comment
        serializer.validated_data['content_type'] = parent_comment.content_type
        serializer.validated_data['object_id'] = parent_comment.object_id
        serializer.validated_data['author'] = request.user
        return _create_paid_comment(
            request,
            serializer,
            scope="comment_reply",
            amount=tuzis,
            payload={
                "action": "comment_reply",
                "intent": "create",
                "kind": "comment_reply",
                "parent": str(parent_comment.uuid),
                "amount": str(tuzis),
                "body": request.data,
            },
            claim=claim,
        )
