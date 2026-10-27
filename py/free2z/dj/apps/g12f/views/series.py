from django.http import Http404, JsonResponse
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import (
    OpenApiExample, OpenApiParameter, OpenApiResponse, extend_schema,
    inline_serializer,
)
from rest_framework import serializers, viewsets, permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from dj.apps.g12f.serializers.series import (
    SeriesEditSerializer, SeriesSerializer
)
from dj.apps.g12f.identifiers import resolve_zpage_pk
from dj.apps.g12f.models import zPage, Series


class IsCreator(permissions.BasePermission):
    """
    Custom permission to only allow creators of a Series to edit it.
    """

    def has_object_permission(self, request, view, obj):
        return obj.creator == request.user


class MySeriesViewSet(viewsets.ModelViewSet):
    queryset = Series.objects.all()
    serializer_class = SeriesEditSerializer
    # IsCreator only implements has_object_permission; IsAuthenticated is
    # required so anonymous list/create requests are rejected with 401/403
    # instead of 500-ing on Series.objects.filter(creator=AnonymousUser).
    permission_classes = [permissions.IsAuthenticated, IsCreator]

    def get_paginated_response(self, data):
        return Response(data)

    def get_queryset(self):
        # GET all series for request.user
        if self.action == 'list':
            # search = self.request.query_params.get('search', None)
            # Keep the page-number response shape for the classic client, but
            # make page boundaries stable for clients that walk every page.
            queryset = (
                Series.objects
                .filter(creator=self.request.user)
                .order_by('created_at', 'id')
            )
            return queryset
            # if search is not None:
            #     queryset = queryset.filter(Q(name__icontains=search))
            # return queryset
        # GET series of zpages given zpage.id
        elif self.action == 'retrieve':
            zpage_id = self.request.query_params.get('zpage_id', None)
            if zpage_id:
                zpage = zPage.objects.get(pk=zpage_id)
                return Series.objects.filter(pages__in=[zpage], creator=self.request.user)
        return super().get_queryset()

    def perform_create(self, serializer):
        serializer.save(request=self.request)

    def perform_update(self, serializer):
        serializer.save(request=self.request)


#Shape of the success body. The classic React UI branches on
#`resp.data.status === 'success'`, so this stays a 200 with a body rather
#than becoming a bare 204.
CLEAR_ZPAGE_RESPONSE = inline_serializer(
    name='SeriesClearZPage',
    fields={'status': serializers.CharField()},
)

CLEAR_ZPAGE_RESPONSES = {
    200: OpenApiResponse(
        response=CLEAR_ZPAGE_RESPONSE,
        description='The page no longer belongs to any series.',
        examples=[OpenApiExample('success', value={'status': 'success'})],
    ),
    400: OpenApiResponse(description='No target page was supplied.'),
    404: OpenApiResponse(
        description=(
            'No page with that free2zaddr belongs to the authenticated '
            'creator. Another creator owning it is deliberately reported the '
            'same way as it not existing, so this endpoint cannot be used to '
            'probe for other creators\' pages.'
        ),
    ),
}


class zPageClearView(APIView):
    """
    Detach a zPage from every series it belongs to.

    Invoked when the series is x-ed out of the editor's series picker.
    """

    # Was a plain django.views.View, on which `permission_classes` is inert —
    # nothing enforced it, and an anonymous DELETE blew up in the queryset
    # filter on AnonymousUser instead of being refused.
    permission_classes = [permissions.IsAuthenticated]

    @transaction.atomic
    def _clear(self, request, free2zaddr):
        """Delete every PageOrder row for the caller's own page.

        `free2zaddr` identifies the target; `creator=request.user` scopes it,
        so a creator can only ever clear their own page (a hit on someone
        else's address is a 404, same as a nonexistent one).
        """
        free2zaddr = (free2zaddr or '').strip()
        if not free2zaddr:
            # Previously an absent target fell through to a lookup on '' and
            # 404-ed. A missing required identifier is a malformed request,
            # not a missing resource.
            raise serializers.ValidationError(
                {'free2zaddr': 'This field is required.'})
        zpage = get_object_or_404(
            zPage.objects.select_for_update(no_key=True),
            free2zaddr=free2zaddr, creator=request.user)
        # PageOrder is the only membership table, so dropping every row for
        # this page detaches it from all of its series. "One series per zPage"
        # is still not a schema-level rule —  added `unique(series, page)`
        # and made both serializer paths keep a page in at most one of its
        # *own creator's* series, but a cross-owner membership is legal — so
        # more than one row here is expected, not a bug.
        #
        # This is the one place where a creator's action reaches into another
        # creator's series, and deliberately so: it is the page's own author
        # explicitly withdrawing their content, not a silent side effect of an
        # unrelated write (which is what  / PR  ruled out).
        zpage.pageorder_set.all().delete()
        return JsonResponse({'status': 'success'})

    @extend_schema(
        operation_id='g12f_series_clear_zpage_destroy',
        summary='Remove a zPage from every series it belongs to',
        description=(
            'Detaches the identified zPage from all of its series. The page '
            'must belong to the authenticated creator. Idempotent: clearing a '
            'page that is in no series succeeds.'
        ),
        parameters=[
            OpenApiParameter(
                name='free2zaddr',
                type=str,
                location=OpenApiParameter.PATH,
                required=True,
                description="The target page's free2zaddr.",
            ),
        ],
        request=None,
        responses=CLEAR_ZPAGE_RESPONSES,
    )
    def delete(self, request, free2zaddr=None, *args, **kwargs):
        return self._clear(request, free2zaddr)


class zPageClearLegacyView(zPageClearView):
    """
    Deprecated `?free2zaddr=` form of:class:`zPageClearView`.

    Kept as an alias for one release because the classic React bundle is
    cached in browsers and is not deployed atomically with this backend — an
    already-loaded tab would otherwise 404 on every clear. Remove once the
    classic UI is retired.
    """

    @extend_schema(
        operation_id='g12f_series_clear_zpage_query_destroy',
        summary='Deprecated: remove a zPage from every series (query form)',
        description=(
            'Deprecated alias kept for already-deployed clients. Use '
            '`DELETE /api/g12f/series/clear-zpage/{free2zaddr}/` instead: the '
            'resource being mutated belongs in the path, and this form was '
            'undocumented — the spec carried no `parameters:` block, so the '
            'only documented way to call it could never succeed (#985).'
        ),
        deprecated=True,
        parameters=[
            OpenApiParameter(
                name='free2zaddr',
                type=str,
                location=OpenApiParameter.QUERY,
                required=True,
                description="The target page's free2zaddr.",
            ),
        ],
        request=None,
        responses=CLEAR_ZPAGE_RESPONSES,
    )
    def delete(self, request, *args, **kwargs):
        return self._clear(request, request.query_params.get('free2zaddr', ''))


class ZPageSeriesViewSet(viewsets.ViewSet):
    """
    Retrieve series by zpage
    """

    # Public: the series strip renders on anonymous zPage views.
    permission_classes = [permissions.AllowAny]

    @staticmethod
    def _first_series(page_filter):
        """Oldest Series containing a page matching `page_filter`, or None.

        `.distinct()` because `pageorder` is a multi-valued reverse relation:
        the JOIN emits one row per matching PageOrder, so the same Series can
        come back more than once. `.order_by()` because a bare `.first()` on an
        unordered queryset is a non-deterministic LIMIT 1 -- the strip could
        show a different series on refresh, or per replica.
        """
        return (
            Series.objects
            .filter(page_filter)
            .order_by('created_at', 'id')
            .distinct()
            .first()
        )

    def retrieve(self, request, free2zaddr=None):
        # This was `get_object_or_404(Series, Q(free2zaddr) | Q(vanity))`, which
        # raised MultipleObjectsReturned -> 500. Three separate things
        # produce more than one row, and none is the caller's fault:
        #
        #  1. Join fan-out, one real series: the same zPage listed twice in the
        #     SAME series, so the identical Series came back twice.
        #     `.distinct()` collapses that to the single series it always was.
        #     FIXED at the source in  -- PageOrder now carries
        #     `unique(series, page)` -- but `.distinct()` stays, because (2)
        #     below still fans the JOIN out.
        #  2. Genuinely two series. There is deliberately NO unique constraint
        #     on PageOrder.page alone: enforcing one would mean deleting rows
        #     out of *other creators'* series, and a creator may never modify
        #     another creator's series.  made `create` detach like
        #     `update` does, so the API no longer mints this state within one
        #     creator's own series -- but legacy rows and genuine cross-owner
        #     memberships remain legal, and this endpoint must resolve them.
        #  3. Two DIFFERENT zPages: `vanity` and `free2zaddr` are each unique
        #     on their own column, but nothing enforces uniqueness across them
        #     -- a UUID string is a valid slug, and zPageSerializer.validate_
        #     vanity only checks vanity against other vanities. So anyone can
        #     point their vanity at someone else's public free2zaddr.
        #
        # (3) is why this is two queries instead of one OR: the free2zaddr is
        # the identity of the page, the vanity is a nickname, so an exact
        # free2zaddr match MUST win. Under a single OR + "oldest wins", the
        # squatter's older series would be served for the victim's own address.
        #
        #...which is why the creator-state gate for  is applied AFTER
        # identity resolution rather than inside it. Filtering
        # `creator__is_active` into the two lookups above -- the obvious way to
        # write it, and how this landed at first -- reopens exactly the hijack
        # (3) describes: a deactivated victim's `free2zaddr` stops matching the
        # first query, execution falls through to the vanity query, and the
        # squatter whose vanity equals that address is served under the
        # victim's own stable identifier. Resolve first, THEN fail closed
        # (codex adversarial review,; same rule as  and
        # `MultipleFieldLookupMixin`).
        #
        # `resolve_zpage_pk` rather than the two hand-written queries this
        # method used to run: it IS the address-then-vanity precedence
        # described above, it is what `/api/zpage/{id}/` and `/api/get-type/`
        # resolve with, and the SSR article page calls this endpoint
        # with the identifier it just used on the detail route -- so any
        # disagreement between them is a series strip attached to a different
        # article than the one being read.
        pk = resolve_zpage_pk(free2zaddr)
        if pk is None:
            raise Http404("No Series matches the given query.")
        # This is a public series strip, so identifying a page must not
        # reveal memberships for drafts. Resolve the identifier first (the
        # address/vanity precedence above is security-sensitive), then apply
        # the shared public-visibility predicate.
        if not zPage.objects.published_and_active().filter(pk=pk).exists():
            raise Http404("No Series matches the given query.")

        # A legacy series can hold other creators' pages: its OWNER must be
        # active too, or a deactivated (or deletion-pending) account's series
        # name keeps being served under someone else's live page.
        series = self._first_series(
            Q(pageorder__page_id=pk) & Q(creator__is_active=True))
        if series is None:
            raise Http404("No Series matches the given query.")
        serializer = SeriesSerializer(series, context={"request": request})
        return Response(serializer.data)
