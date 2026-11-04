"""The authenticated caller's own follow list.

The per-creator state/toggle routes live on ``CreatorView`` because they are
addressed by the creator being followed. This one is addressed by the caller,
so it is its own viewset: there is no username in the path at all, and none is
accepted — a request cannot ask for somebody else's follow list, because the
only identity this endpoint reads is ``request.user``.
"""

from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import mixins, viewsets
from rest_framework.permissions import IsAuthenticated

from dj.apps.g12f.models import CreatorBlock, CreatorFollow
from dj.apps.g12f.serializers.follow import (
    CreatorBlockSerializer, CreatorFollowSerializer,
)


@extend_schema(
    summary="Creators I follow",
    description=(
        "Every creator the authenticated caller follows, newest first, with "
        "the project's standard page-number pagination (`?page=`, "
        "`?page_size=`). This is the FREE follow graph — it is not the paid "
        "subscription list and reflects nothing about 2Z, entitlement or "
        "`member_price`. Follows of accounts that have since been deactivated "
        "are omitted, so `count` here always matches the `following_count` "
        "reported by `GET /api/creator/{my-own-username}/follow/`."
    ),
    responses={
        200: CreatorFollowSerializer(many=True),
        401: OpenApiResponse(description="Authentication required."),
    },
)
class MyCreatorFollowViewSet(
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    """``GET /api/g12f/follows/mine/``"""

    permission_classes = [IsAuthenticated]
    serializer_class = CreatorFollowSerializer
    # Declared for drf-spectacular and for `get_queryset()`'s super(); the
    # real scoping happens below and is never optional.
    queryset = CreatorFollow.objects.none()

    def get_queryset(self):
        # `follower=self.request.user` is the whole authorization model here.
        # `creator__is_active=True` keeps this list consistent with
        # `following_count` on the state endpoint; without it a takedown would
        # leave a row in the list that resolves to a 404 profile.
        #
        # The Meta ordering ('-created_at', '-id') is restated because page
        # numbers over an unstable order silently drop rows across a boundary,
        # and a future edit to Meta must not be able to do that here.
        return CreatorFollow.objects.filter(
            follower=self.request.user,
            creator__is_active=True,
        ).select_related('creator').order_by('-created_at', '-id')


@extend_schema(
    summary="Accounts I blocked",
    description=(
        "Every active account the authenticated caller has blocked, newest "
        "first, with the project's standard page-number pagination "
        "(`?page=`, `?page_size=`, at most 48 per page). Block and unblock "
        "with `PUT`/`DELETE /api/creator/{username}/block/`. A client uses "
        "this to offer unblocking and to hide the blocked accounts' content "
        "in lists the server rendered without the caller's session (cached "
        "or server-side-rendered feeds)."
    ),
    responses={
        200: CreatorBlockSerializer(many=True),
        401: OpenApiResponse(description="Authentication required."),
    },
)
class MyCreatorBlockViewSet(
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    """``GET /api/g12f/blocks/mine/`` """

    permission_classes = [IsAuthenticated]
    serializer_class = CreatorBlockSerializer
    queryset = CreatorBlock.objects.none()

    def get_queryset(self):
        # `blocker=self.request.user` is the whole authorization model: a
        # block list is private to the account that made it.
        return CreatorBlock.objects.filter(
            blocker=self.request.user,
            blocked__is_active=True,
        ).select_related('blocked').order_by('-created_at', '-id')
