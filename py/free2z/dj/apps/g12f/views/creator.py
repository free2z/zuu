from datetime import datetime, timedelta, timezone as dt_timezone

# from django.core.exceptions import ValidationError
from django import forms
from django.conf import settings
from django.db import models
from django.db.models import (
    Count, Max, Q, Value, F, Case, When, IntegerField, Exists, OuterRef,
)
from django.db.models.functions import Greatest, Coalesce
from django.db.models.expressions import RawSQL
from django.utils import timezone

from rest_framework import status, viewsets, mixins, filters
from rest_framework.decorators import action
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny, IsAuthenticated

from dj.free2z.throttling import (
    AuthenticatedUserRateThrottle,
    LOGIN_PATH_THROTTLES,
    PASSWORD_LOGIN_THROTTLES,
)
from dj_rest_auth.views import LoginView, UserDetailsView
from django_filters.rest_framework import DjangoFilterBackend, FilterSet
from django_filters import NumberFilter
from drf_spectacular.utils import (
    OpenApiResponse, extend_schema, extend_schema_field,
)

from dj.apps.dyte.models import PUBLIC_MEETING_TYPES, CreatorMeeting
from dj.apps.tuzis.welcome import welcome_new_account
from dj.apps.identity.auth_context import AMR_PASSWORD, record_login
from dj.apps.g12f.captcha import (
    CAPTCHA_UNAVAILABLE_MESSAGE,
    CaptchaUnavailable,
    siteverify,
    verify_captcha_response,
)
from dj.apps.g12f.models import (
    Creator, CreatorBlock, CreatorFollow, CreatorMute, active_fans_count, zPage,
)
from dj.apps.g12f.identifiers import resolve_zpage_pk
from dj.apps.g12f.serializers.creator import (
    RegistrationSerializer,
    CreatorDetailSerializer,
    CreatorListSerializer,
)
from dj.apps.g12f.serializers.creator import (
    CreatorProfileDetailSerializer, CreatorProfileUpdateSerializer
)
from dj.apps.g12f.serializers.follow import (
    CreatorFollowStateSerializer, CreatorRelationshipStateSerializer,
)

# Privacy versus telling Google to protect us more?
# security or freedom?
# def get_client_ip(request):
#     x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
#     if x_forwarded_for:
#         ip = x_forwarded_for.split(',')[0]
#     else:
#         ip = request.META.get('REMOTE_ADDR')
#     return ip


# creator_social moved to dj/apps/g12f/views/crawler.py in  (it now also
# has to filter is_active and share the static-route precedence rules with the
# rest of the prerender tier). Still exported from `dj.apps.g12f.views`.


class SignUpView(
    # viewsets.ModelViewSet,
    # mixins.ListModelMixin, mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    """
    /api/start - create new user with POST
    """

    # Registration: the caller has no account yet. Guarded by reCAPTCHA in
    # create(); anon-throttled here so a solved captcha can't be replayed at
    # machine speed.
    #
    # 'anon-login', not a signup bucket, because this is not only a signup
    # endpoint in practice: both front ends POST /api/start/ FIRST on every
    # authentication attempt and only fall through to /api/auth/login/ when it
    # reports the user already exists. So its real traffic is every sign-in on
    # the site plus every mistyped-password retry, and a 429 here blocks
    # sign-in for existing accounts (429 is not in the clients' fallback
    # status list, so they never reach /api/auth/login/). Nothing
    # machine-paced may share this bucket, or a busy office egress 429s
    # sign-in for everyone behind it; see dj/free2z/throttling.py.
    permission_classes = [AllowAny]
    throttle_classes = LOGIN_PATH_THROTTLES
    serializer_class = RegistrationSerializer

    def create(self, request, *args, **kwargs):
        if 'captcha_result' not in request.data:
            return Response(
                data={'error': 'ReCAPTCHA not supplied.'},
                status=status.HTTP_406_NOT_ACCEPTABLE
            )
        # Pop the captcha result out of request.data so we don't keep it around
        captcha_result = request.data.pop('captcha_result', '')

        # Allow a dev stub token for local development to avoid requiring a
        # real reCAPTCHA flow. Only accept this bypass when DEBUG is True and
        # the token is exactly 'test'. In production a real verification
        # against Google's siteverify API is performed.
        if settings.DEBUG and captcha_result == 'test':
            verified = True
        else:
            # Bounded, and fail-closed on no answer: see
            # dj.apps.g12f.captcha.siteverify. 503, not the 406 below: the
            # user's solve was never judged, so blaming it would be wrong.
            try:
                payload = siteverify(captcha_result)
            except CaptchaUnavailable:
                return Response(
                    data={'error': CAPTCHA_UNAVAILABLE_MESSAGE},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            #`verified = r.json().get('success')` also, but routed
            # through the grant store so that the FIRST leg of the sign-in
            # dance records the token. Both front ends POST here with the same
            # captcha_result they are about to POST to /api/auth/login/, and
            # that second leg is only allowed to replay a duplicate while this
            # grant is live. Without this line the login leg would find no
            # grant and refuse every existing user's sign-in.
            #
            # allow_replay=False: this endpoint is always leg 1, never a
            # replay, so a `timeout-or-duplicate` here stays a rejection
            # exactly as it was before.
            verified = verify_captcha_response(
                payload, captcha_result, allow_replay=False
            )

        if not verified:
            return Response(
                data={'error': 'ReCAPTCHA not verified.'},
                status=status.HTTP_406_NOT_ACCEPTABLE
            )

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        username = serializer.data['username']
        password = serializer.data['password']

        # validate in serializer
        # if Creator.objects.filter(username__iexact=username).count():
        #     raise ValidationError("Not a good username")
        c = Creator.objects.create(username=username)
        c.set_password(password)
        # Initial login
        c.save(update_fields=['password', 'password_set', 'updated_at'])
        #every new account starts with the welcome 2Z. Same
        # transaction as the account (AtomicMiddleware); never fails sign-up.
        welcome_new_account(c, path="password")

        # self.perform_create(serializer)
        # headers = self.get_success_headers(serializer.data)
        return Response(serializer.data['username'], status=status.HTTP_201_CREATED)


class CreatorLoginView(LoginView):
    """``/api/auth/login/`` with the sign-in path's per-IP throttle.

    dj-rest-auth's ``LoginView`` carries no ``throttle_classes``, so it fell
    through to ``DEFAULT_THROTTLE_CLASSES`` -- which is
    ``AuthenticatedUserRateThrottle`` alone, and that returns ``None`` for an
    anonymous caller. Every request to this endpoint is anonymous by
    definition, so password login was the one credential endpoint on the site
    with **no** rate limit of any kind. This subclass exists only to attach
    one; every behaviour, serializer and response shape stays upstream's.

    ``LOGIN_PATH_THROTTLES`` (scope ``anon-login``) is the SAME bucket
    ``/api/start/`` uses, and that is deliberate rather than lazy. Both front
    ends POST ``/api/start/`` immediately before this endpoint on every
    authentication attempt, so ``anon-login`` is already the production
    sign-in bucket; giving this view a second scope would leave the real
    per-IP sign-in ceiling at ``min()`` of the two rates -- a carefully sized
    number silently overridden by a bucket nobody tuned. One dance, one
    budget. The rate was raised to cover the two requests an attempt now
    spends; see ``anon-login`` in settings.py.

    ``PASSWORD_LOGIN_THROTTLES``, not ``LOGIN_PATH_THROTTLES``, and the
    difference matters: ``AnonRateThrottle`` exempts an authenticated caller,
    DRF authenticates BEFORE it throttles, and this view keeps the project's
    authentication classes even though its permission is ``AllowAny``. So a
    plain anon throttle here is bypassed by anyone who logs in to an account
    they control first. Same scope and same budget; nobody is exempt. Found by
    the codex adversarial review of this PR.

    The pairing with ``AuthenticatedUserRateThrottle`` is not optional:
    setting ``throttle_classes`` REPLACES the defaults rather than adding to
    them, so listing the anon class alone would exempt authenticated callers
    from the global ceiling. ``_public()`` in dj/free2z/throttling.py is what
    keeps that from being a thing anyone has to remember.

    THE SCHEMA IS NOT FREE, and this is the part a subclass silently breaks.
    drf-spectacular ships an ``OpenApiViewExtension`` for dj-rest-auth keyed on
    the exact string ``'dj_rest_auth.views.LoginView'``
    (``drf_spectacular/contrib/rest_auth.py``). Subclassing does not inherit an
    extension match, so without the ``@extend_schema`` below the generated
    ``f2z.yaml`` silently documents the REQUEST serializer as the response
    . The backend CI job cannot notice -- it only checks the committed
    spec MATCHES the code -- so
    ``test_login_schema_documents_the_session_only_response`` does.

    **Session only, since.** ``REST_AUTH['TOKEN_MODEL'] = None``: the
    upstream view used to mint a ``rest_framework.authtoken`` key on every
    login (permanent, never rotated, authenticating nothing) and document it
    as the 200 body. It now establishes the Django session and answers 204
    with no body. No client read the key -- the SPA uses the cookie, bearer
    clients use Knox via ``/api/token/login/``.
    """

    throttle_classes = PASSWORD_LOGIN_THROTTLES

    @extend_schema(
        # Written for a client author, not the class docstring above: the
        # upstream text ("return the REST Token") stopped being true in.
        description=(
            "Check the credentials and, if they are valid, log the user in "
            "by establishing a Django session (the `sessionid` cookie).\n\n"
            "Accepts `username`, `password`, `captcha_result` and, for an "
            "account with MFA enabled, `otp_token`. Returns 204 with no body. "
            "No bearer token is issued here; a session-authenticated client "
            "that needs one exchanges the session at `/api/token/login/`.\n\n"
            "Rate limited per client address. 503 means the rate limiter's "
            "store is unavailable and sign-in is refused until it recovers; "
            "retry after the `Retry-After` interval."
        ),
        responses={
            204: OpenApiResponse(
                description="Logged in; the session cookie is set.",
            ),
            503: OpenApiResponse(
                description=(
                    "Sign-in is temporarily unavailable (the rate limiter "
                    "cannot count this attempt). Retry after `Retry-After`."
                ),
            ),
        },
    )
    def post(self, request, *args, **kwargs):
        from dj.apps.g12f import account_deletion

        try:
            return super().post(request, *args, **kwargs)
        except account_deletion.DeletionPending as pending:
            # Returned, not raised: the serializer burned the TOTP code, and
            # a raised error would roll that back (AtomicMiddleware).
            return account_deletion.deletion_pending_response(pending)

    def process_login(self):
        # Upstream's `django_login`, then the session's AuthContext,
        # keyed to the session key `login()` just cycled to.
        super().process_login()
        record_login(
            self.request, self.user,
            methods=[AMR_PASSWORD],
            second_factor=self.serializer.validated_data.get('second_factor'),
        )


class CustomUserDetailsView(UserDetailsView):
    """
    This is only for the owner
    """

    def get_object(self):
        """Serve reads off a queryset annotated with ``fans_count``.

        ``UserDetailsView.get_object`` returns ``request.user``, an instance
        that authentication loaded with no annotations, so the serializer would
        have to issue its own ``COUNT`` per read. Re-selecting the row here
        folds the subscriber count into the query that this endpoint runs
        anyway: one row, one correlated subquery on the indexed
        ``g12f_subscription.star_id``, no join and no GROUP BY ( changed
        ``active_fans_count()`` from a joined ``Count`` to a subquery -- see
        its docstring for why).

        Deliberately GET-only. On PUT/PATCH the instance returned here is the
        one the update path saves and the one whose staleness  is about;
        that flow keeps using ``request.user`` untouched, and its response
        falls back to the serializer's ``COUNT(*)``. Writes are rare, so the
        one extra cheap query there is not worth widening the blast radius of
        a security-sensitive write path.
        """
        if self.request.method not in ('GET', 'HEAD'):
            return super().get_object()

        user = super().get_object()
        pk = getattr(user, 'pk', None)
        if pk is None:
            return user
        annotated = Creator.objects.filter(pk=pk).annotate(
            fans_count=active_fans_count(),
            # Both parts describe the active snapshot that reads tuzis, not
            # command receipt time or serialization time. On read-only reads
            # from one primary, xmax can only increase; at fixed xmax, the
            # in-progress set below it can only shrink. A completed balance
            # writer therefore advances (xmax, -xip_count), even when its XID
            # was allocated before a later transaction that already finished.
            # Do not reuse this token for reads of a transaction's own writes.
            balance_snapshot=RawSQL(
                "pg_snapshot_xmax(pg_current_snapshot())::text || ':' || "
                "(SELECT COUNT(*) FROM "
                "pg_snapshot_xip(pg_current_snapshot()))::text",
                (), output_field=models.CharField(),
            ),
        ).first()
        # Never turn a readable profile into a 404 over an optimisation: if the
        # row cannot be re-selected for any reason, serve request.user and let
        # the serializer count the fans itself.
        return annotated or user

    def get_serializer_class(self):
        if self.request.method == 'GET':
            return CreatorProfileDetailSerializer
        elif self.request.method in ('PUT', 'PATCH'):
            return CreatorProfileUpdateSerializer
        return super().get_serializer_class()

    # A write answers with the SAME representation a read does.
    #
    # The update serializer has to take ``avatar_image``/``banner_image`` as
    # primary keys -- that is how a client points its profile at an upload --
    # but DRF's stock ``UpdateModelMixin.update`` serializes the response with
    # that same serializer, so the PATCH answered ``"avatar_image": 123`` while
    # GET answers ``{"id": 123, "url":..., "thumbnail":...}``. The settings
    # page stores the PATCH body as the creator (and hands it to the auth
    # store behind the header avatar), so every Save blanked both images until
    # a reload re-read them through GET. Pinning the response to the read
    # serializer makes the PATCH body a drop-in replacement for a GET body,
    # which is what every caller already assumed it was.
    @extend_schema(
        request=CreatorProfileUpdateSerializer,
        responses=CreatorProfileDetailSerializer,
    )
    def put(self, request, *args, **kwargs):
        return super().put(request, *args, **kwargs)

    @extend_schema(
        request=CreatorProfileUpdateSerializer,
        responses=CreatorProfileDetailSerializer,
    )
    def patch(self, request, *args, **kwargs):
        return super().patch(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop('partial', False)
        instance = self.get_object()
        serializer = self.get_serializer(
            instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        return Response(CreatorProfileDetailSerializer(
            serializer.instance, context=self.get_serializer_context(),
        ).data)


# ---------------------------------------------------------------------------
# "Creators to watch" ranking (see get_queryset below)
#
# The discovery list ("Creators to watch" on the ZUULI home screen) must only
# surface creators who are genuinely worth watching. Previously the list only
# required an avatar + banner, so brand-new accounts that uploaded two images
# and then did NOTHING — and long-dormant accounts — leaked into the feed.
#
# We now (a) EXCLUDE creators with no published zPage and no recent activity,
# and (b) rank the survivors by a weighted `watch_score` in which recent
# activity dominates. All scoring is done as DB-level annotations (no
# Python-side sorting, no N+1).
#
# Signals & weighting (recent activity dominates; the rest are tie-breakers):
#   * Recent activity (x10, dominant) — how recently the creator logged in OR
#     published/edited a published zPage, bucketed 100/70/40/20/5.
#   * Published pages (popularity) — count of published zPages, capped.
#   * Funding/engagement (`total`, the cached ZEC+2Z page value) — small bonus.
#   * Tenure (`date_joined`) — a small, established-member bonus.
#   * 2Z balance (`tuzis`) — a PRIVATE quality signal: it nudges ranking but is
#     NEVER serialized (CreatorListSerializer does not expose it).
#
# Qualification (exclusion) filter — a creator must have BOTH:
#   * at least one published zPage, and
#   * some activity within WATCH_RECENT_WINDOW_DAYS.
# ---------------------------------------------------------------------------

# Activity older than this (and no published page) => not "to watch".
WATCH_RECENT_WINDOW_DAYS = 365

# Sentinel "very old" timestamp so Coalesce over a NULL last_login /
# page-activity never poisons Greatest() (Postgres GREATEST returns NULL if any
# argument is NULL). Any fixed date far in the past works.
_EPOCH = datetime(1970, 1, 1, tzinfo=dt_timezone.utc)


class CreatorFilter(FilterSet):
    """Query filters for the public creator directory.

    ``min_followers`` exists because the ``/creators`` directory's "at least N
    followers" control used to filter client-side on the serialized ``total``
    field. ``Creator.total`` is ``cache_total()``'s output --
    ``Sum(zpage.total) + tuzis/1000``, a cached ZEC-denominated *page-support*
    score counting spend by anyone, including the creator themselves. It has
    nothing to do with subscribers, so "at least 5 followers" was really "at
    least 5 ZEC of page support" and silently returned the wrong creators.

    It filters on the ``fans_count`` annotation instead -- the number of
    unexpired ``Subscription`` rows, which is exactly the roster length the
    profile used to render.

    Server-side, not client-side: the old filter could only reject rows from
    the pages already fetched, so "at least 10 followers" showed whatever
    survived from page 1 and the page kept auto-fetching to refill the grid.
    Filtering in the database means the paginated ``count`` is the real number
    of matching creators.
    """

    class _IntegerFilter(NumberFilter):
        # django-filter has no IntegerFilter; NumberFilter is a DecimalField,
        # so `min_followers=2.5` would be accepted for a quantity that is
        # integral by construction.
        field_class = forms.IntegerField

    # `extend_schema_field` because drf-spectacular maps every NumberFilter
    # subclass to `type: number` from the class, not the field_class -- and a
    # spec that advertises `number` while the server 400s on 2.5 is a contract
    # that lies to every generated client. Injecting the raw schema replaces
    # the label-derived description, so it is restated here.
    min_followers = extend_schema_field({
        'type': 'integer',
        'minimum': 0,
        'description': (
            'Only return creators with at least this many currently-active '
            'subscribers. Counted from unexpired Subscription rows -- NOT '
            'from `total`, which is a cached ZEC page-support value.'
        ),
    })(
        _IntegerFilter(
            field_name='fans_count',
            lookup_expr='gte',
            # `min_followers=-1` would compile to `fans_count >= -1`, which
            # matches every creator -- i.e. a hand-built or mangled link
            # silently turns the filter off while the UI still shows an
            # active "At least -1 followers" tag. A follower count cannot be
            # negative, so refuse it rather than answer a question that has
            # no meaning. The `min="0"` on the input protects the app, not
            # the API.
            min_value=0,
        )
    )

    class Meta:
        model = Creator
        # Keep the pre-existing ``filterset_fields = ['is_verified']``
        # behaviour: declaring filterset_class replaces it entirely.
        fields = ['is_verified']


class StableOrderingFilter(filters.OrderingFilter):
    """``OrderingFilter`` that always ends in a unique tie-breaker.

    The creator directory is page-number paginated and infinite-scrolled, so
    every ordering it offers must be a TOTAL order. Postgres is free to return
    tied rows in a different order for each page, and a creator that moves
    between page 1 and page 2 is either shown twice or never shown at all --
    the /creators page de-duplicates by username, so the visible symptom is
    simply a directory that is quietly missing people.

    The follower sorts added in  make this acute (every creator with no
    subscribers ties at 0, and that is most of them), but it was already true
    of ``-total``, which the default "Most Popular" sort uses and which is 0
    for the same long tail. Appending ``pk`` is free -- it only decides
    between rows the requested ordering says are equal -- and it makes the
    ordering deterministic across pages.
    """

    TIE_BREAKER = 'pk'

    def get_ordering(self, request, queryset, view):
        ordering = super().get_ordering(request, queryset, view)
        if ordering:
            if any(f.lstrip('-') in ('pk', 'id') for f in ordering):
                return ordering
            return list(ordering) + [self.TIE_BREAKER]

        # No usable ordering came back. That is fine when the client asked
        # for none -- `get_queryset` has already ordered the queryset itself
        # and must not be overridden here. But when the client DID send
        # `ordering=` and every field in it was rejected (a stale client, a
        # renamed field, a typo), `get_queryset` took its "explicit ordering,
        # don't force a default" branch and returned the queryset UNORDERED,
        # and DRF's base class silently returns None. Paginating an unordered
        # queryset by page number is the duplicate-and-skip bug above with no
        # ordering at all to blame it on, so fall back to the tie-breaker.
        if request.query_params.get(self.ordering_param):
            return [self.TIE_BREAKER]
        return ordering


class CreatorView(
    mixins.RetrieveModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    """
    List Creators on Free2z
    """
    # Public, read-only creator directory and profiles. Rendered anonymously
    # by the SvelteKit SSR pod, so no anon throttle (see dj/free2z/throttling).
    permission_classes = [AllowAny]
    queryset = Creator.objects.filter(is_active=True)
    lookup_field = "username__iexact"
    # Django's `UnicodeUsernameValidator` allows `.` (and `@ + - _`), and
    # nothing in this project narrows that, so `alice.smith` is a real account.
    # A DRF router's detail regex defaults to `[^/.]+`, which does NOT match
    # one -- so every router-generated detail route silently served a strictly
    # smaller set of usernames than the accounts that exist. The plain profile
    # route survived only by accident: the explicit `creator_dumbass` path in
    # dj/free2z/urls.py is registered ahead of the router and uses `<str:...>`,
    # which does match. Nothing shadowed the `follow/` route, so a creator with
    # a dotted username had a working profile page and an unfollowable follow
    # button. Widening it here fixes the whole viewset rather than bolting a
    # second hand-written path next to the first (codex round 2).
    #
    # `[^/]+` still cannot cross a path segment, and the value is only ever used
    # as `username__iexact=<value>` against the ORM.
    lookup_value_regex = "[^/]+"

    serializers = {
        'list': CreatorListSerializer,
        'retrieve': CreatorDetailSerializer,
        # The three method handlers mapped onto `{username}/follow/`. DRF sets
        # `self.action` to the handler's own name, so all three need an entry
        # or `get_serializer_class()` returns None and drf-spectacular
        # publishes an untyped response for a route ZUULI has to code against.
        'follow': CreatorFollowStateSerializer,
        'follow_create': CreatorFollowStateSerializer,
        'follow_destroy': CreatorFollowStateSerializer,
        'block': CreatorRelationshipStateSerializer,
        'block_create': CreatorRelationshipStateSerializer,
        'block_destroy': CreatorRelationshipStateSerializer,
        'mute': CreatorRelationshipStateSerializer,
        'mute_create': CreatorRelationshipStateSerializer,
        'mute_destroy': CreatorRelationshipStateSerializer,
    }

    filter_backends = [
        DjangoFilterBackend, filters.SearchFilter, StableOrderingFilter,
    ]
    filterset_class = CreatorFilter
    search_fields = ['username', 'full_name']
    # `fans_count` is the real subscriber count backing the directory's
    # "Most/Fewest Followers" sort. `total` stays orderable -- it is a genuine
    # funding/popularity signal and still backs "Most Popular" -- it is just
    # not a follower count.
    ordering_fields = [
        'date_joined', 'total', 'updated_at', 'username', 'fans_count',
    ]

    def get_serializer_class(self):
        return self.serializers.get(self.action)

    @staticmethod
    def _is_live_subquery():
        """`Exists()` subquery mirroring the dyte live-status predicate.

        A creator is "live" iff they have a PUBLIC ``CreatorMeeting`` of a
        public meeting type, flagged ``live_now``, whose presence was confirmed
        within ``DYTE_LIVE_LAST_SEEN_TTL_SECONDS`` (the same time bound
        ``PublicMeetingViewSet._live_queryset`` uses), so ``is_live`` is always
        consistent with the public live-status endpoint. ``live_now`` is kept
        truthful instantly by Dyte webhooks and reconciled by the
        ``dyte.sweep_live_meetings`` worker; the ``last_seen_at`` TTL is the
        belt-and-suspenders guard that drops stale rooms if the sweep stalls.

        The ``meeting_type`` bound matches the filter  added to
        ``PublicMeetingViewSet._live_queryset`` and ``live_meeting_status``.
        Rows written before the create/join route was constrained
        can hold a ``meeting_type`` outside the enum, and those rows are still
        in the production database. Without this clause a creator whose ONLY
        live room is such a legacy row would be advertised as ``is_live: true``
        while every endpoint that could name or join the stream filters it out
        — a "LIVE" badge that resolves to nothing. The predicate must be the
        same on both sides or the badge lies.

        This is a *correlated subquery*, NOT a JOIN, so it cannot fan out rows
        and leaves the existing ``watch_score``/``Count``/``Max`` aggregates and
        the ``count`` untouched. It hits ``dyte_live_now_idx`` — a single
        indexed lookup with no provider/network call. ``meeting_type`` is not
        in that index, so it is an extra filter on the (already tiny) set of
        rows the index returns for one creator, not a new scan.
        """
        cutoff = timezone.now() - timedelta(
            seconds=settings.DYTE_LIVE_LAST_SEEN_TTL_SECONDS)
        return Exists(
            CreatorMeeting.objects.filter(
                creator=OuterRef('pk'),
                is_public=True,
                live_now=True,
                last_seen_at__gte=cutoff,
                meeting_type__in=PUBLIC_MEETING_TYPES,
            )
        )

    def _annotated_list_queryset(self):
        """Annotate-only base queryset for the list action.

        Adds the `published_pages`, `last_activity` and `watch_score`
        annotations (so any branch can rank by them) but applies NO
        qualification/exclusion filter — page-less and long-dormant creators
        stay in the result set. This is the PRE- behavior and is what the
        non-discovery branches (explicit ``search=``, ``ordering=``,
        ``updated``, plain pagination) build on, so global creator search,
        @mention autocomplete, the command palette and the ``/creators``
        directory keep finding every legitimate creator.

        The desirable ``is_active=True`` filter and the avatar+banner
        requirement (both pre-existing on the list) are preserved here; only
        the  "must have a published page AND recent activity" exclusion is
        withheld — see ``_watch_list_queryset`` for that.
        """
        now = timezone.now()
        d7 = now - timedelta(days=7)
        d30 = now - timedelta(days=30)
        d90 = now - timedelta(days=90)
        d180 = now - timedelta(days=180)
        y2 = now - timedelta(days=730)
        y1 = now - timedelta(days=365)
        m3 = now - timedelta(days=90)

        base = Creator.objects.select_related(
            'avatar_image', 'banner_image'
        ).prefetch_related(
            'avatar_image__webp',
            'banner_image__webp',
            'avatar_image__variants',
            'banner_image__variants',
        ).filter(is_active=True).exclude(
            Q(banner_image__isnull=True) | Q(avatar_image__isnull=True),
        )

        # Aggregate signals (single GROUP-BY query — no N+1).
        #
        # `fans_count` is the currently-active subscriber count and backs the
        # directory's "at least N followers" filter and Most/Fewest Followers
        # sort. It is `active_fans_count()` from the model
        # module, NOT a fresh Count written here — this is the one queryset in
        # the codebase where a hand-rolled Count is most likely to be wrong,
        # because the zpage LEFT JOIN two lines up makes any second
        # one-to-many join both fan out (cost) and, without DISTINCT,
        # over-count (5 fans x 3 pages = 15). The helper is a correlated
        # subquery precisely so neither can happen here; see its docstring for
        # the measurements. `test_min_followers_filter.py` pins both the
        # composed count and the absence of fan-out.
        base = base.annotate(
            published_pages=Count(
                'zpage', filter=Q(
                    zpage__is_published=True,
                ), distinct=True,
            ),
            last_page_activity=Max(
                'zpage__updated_at', filter=Q(
                    zpage__is_published=True,
                ),
            ),
            fans_count=active_fans_count(now),
        )

        # Most recent genuine creator action: a login or a published-page edit.
        base = base.annotate(
            last_activity=Greatest(
                Coalesce('last_login', Value(_EPOCH)),
                Coalesce('last_page_activity', Value(_EPOCH)),
            ),
        )

        # Recent activity — the dominant signal (scaled x10 below).
        activity_score = Case(
            When(last_activity__gte=d7, then=Value(100)),
            When(last_activity__gte=d30, then=Value(70)),
            When(last_activity__gte=d90, then=Value(40)),
            When(last_activity__gte=d180, then=Value(20)),
            default=Value(5),
            output_field=IntegerField(),
        )
        # Popular pages — how many published zPages (capped).
        pages_score = Case(
            When(published_pages__gte=10, then=Value(30)),
            When(published_pages__gte=5, then=Value(20)),
            When(published_pages__gte=2, then=Value(10)),
            default=Value(5),
            output_field=IntegerField(),
        )
        # Funding / engagement — the cached ZEC+2Z page value.
        total_score = Case(
            When(total__gte=1, then=Value(10)),
            When(total__gt=0, then=Value(5)),
            default=Value(0),
            output_field=IntegerField(),
        )
        # Tenure — established members get a small bump.
        tenure_score = Case(
            When(date_joined__lte=y2, then=Value(15)),
            When(date_joined__lte=y1, then=Value(10)),
            When(date_joined__lte=m3, then=Value(5)),
            default=Value(0),
            output_field=IntegerField(),
        )
        # 2Z balance — PRIVATE quality signal (never serialized). 150 is the
        # can_stream threshold, so it doubles as a "real, funded creator" hint.
        balance_score = Case(
            When(tuzis__gte=1000, then=Value(10)),
            When(tuzis__gte=150, then=Value(6)),
            When(tuzis__gt=0, then=Value(3)),
            default=Value(0),
            output_field=IntegerField(),
        )

        base = base.annotate(
            watch_score=(
                activity_score * Value(10)
                + pages_score
                + total_score
                + tenure_score
                + balance_score
            ),
        )

        # `is_live` — a correlated Exists() subquery (single indexed lookup, no
        # provider call). It never fans out rows, so counts/scores/ordering are
        # unaffected; it just lets list clients show a "LIVE" badge cheaply.
        base = base.annotate(is_live=self._is_live_subquery())

        return base

    def _watch_list_queryset(self):
        """The qualified base queryset for the "Creators to watch" discovery.

        Starts from the annotate-only base and adds the qualification
        (exclusion) filter: a creator must have at least one published zPage
        AND some activity within ``WATCH_RECENT_WINDOW_DAYS``. This is applied
        ONLY on the discovery branches (``homeSort=random`` and the default
        ``-watch_score`` ranking) — never on search / ordering / updated —
        so dormant and page-less creators are hidden from discovery but remain
        fully findable everywhere else.
        """
        window_start = timezone.now() - timedelta(days=WATCH_RECENT_WINDOW_DAYS)
        return self._annotated_list_queryset().filter(
            published_pages__gt=0,
            last_activity__gte=window_start,
        )

    def get_queryset(self):
        if self.action != 'list':
            # Detail/retrieve path: carry the same `is_live` annotation so
            # GET /api/creator/<username>/ exposes it too (the "Watch live"
            # button reads this). Same indexed correlated subquery.
            #
            # `fans_count` rides along because DRF's `get_object()` runs
            # `filter_queryset()` too, so `CreatorFilter` is active on the
            # detail route as well: without the annotation here,
            # `/api/creator/<username>/?min_followers=1` — a URL any client
            # can produce just by keeping a stray query param — resolves
            # `fans_count` against a queryset that has none and 500s on a
            # public, anonymously-cached page. It costs one indexed subquery
            # on a single-row select.
            return super().get_queryset().annotate(
                is_live=self._is_live_subquery(),
                fans_count=active_fans_count(),
                published_pages=Count(
                    'zpage',
                    filter=Q(
                        zpage__is_published=True,
                    ),
                    distinct=True,
                ),
            )

        params = self.request.query_params
        home_sort = params.get('homeSort', None)

        # --- Discovery: "Creators to watch" -----------------------------
        # `homeSort=random` gives variety on the home strip, drawing only
        # from qualified (published + recently-active) creators.
        if home_sort == "random":
            return self._watch_list_queryset().order_by('?')

        # --- Non-discovery: must NOT exclude dormant/page-less creators --
        # (pre- behavior). These power global creator search, the
        # @mention autocomplete, the command palette, and the /creators
        # directory browse+sort — all of which must find every legitimate
        # creator, not just discovery-qualified ones.
        # `pk` closes every ordering below for the same reason
        # StableOrderingFilter appends it: these lists are page-number
        # paginated and infinite-scrolled, and Postgres may order tied rows
        # differently per page, so a tie without a tie-breaker silently drops
        # creators out of the directory. `?` is excluded -- random is
        # deliberately not stable, and it is only used for the unpaginated
        # home strip.
        if home_sort == "updated":
            return self._annotated_list_queryset().order_by('-updated_at', 'pk')
        if params.get('ordering'):
            # Explicit ordering= (e.g. search uses ordering=-total); let the
            # OrderingFilter apply it, don't force a default here.
            return self._annotated_list_queryset()
        if params.get('search'):
            # Plain search with no explicit ordering: rank matches by the
            # weighted score (active creators first) but include everyone
            # who matches — dormant/page-less creators must still surface.
            return self._annotated_list_queryset().order_by(
                '-watch_score', '-total', 'pk',
            )

        # --- Default: the weighted "Creators to watch" discovery ranking -
        return self._watch_list_queryset().order_by(
            '-watch_score', '-total', 'pk')

    # ---- Free creator follow  -----------------------------------
    #
    # A viewer-specific answer on its own authenticated route, NOT a field on
    # the public creator serializer: `/api/creator/{username}/` is fetched
    # anonymously by the SSR pod and is publicly cacheable, so varying it by
    # authentication state would poison that cache with one visitor's answer.
    #
    # The relationship is fully identified by (authenticated caller, username
    # in the path) and has no other state, so PUT and DELETE take no body and
    # read nothing at all out of the query string. The path segment identifies
    # the resource; it does not supply a value that gets persisted.
    #
    # `permission_classes` on the @action overrides the viewset's `AllowAny`
    # for this route and every method mapped onto it. It is invisible to the
    # class-level fallthrough audit, so it is pinned by name in
    # dj/apps/test_permission_inventory.py::
    # EXPECTED_ACTION_PERMISSION_OVERRIDES.
    #
    # Throttling is the global `AuthenticatedUserRateThrottle` ('user' scope),
    # the same ceiling every other authenticated write in the API sits under.
    # No anon scope is added because the route is not anonymously reachable at
    # all: the permission check runs before the target is resolved, so an
    # anonymous caller is refused without touching the database.

    def _follow_target(self) -> Creator:
        """The creator in the path, resolved WITHOUT the directory filters.

        Not ``self.get_object()``. That runs ``filter_queryset()``, and this
        viewset's filter backends are the public creator *directory's*:
        ``CreatorFilter`` (``min_followers``, which counts PAID subscribers),
        the search filter and the ordering filter. They apply to a detail route
        too, so ``DELETE /api/creator/bob/follow/?min_followers=1`` answered 404
        and left the free follow in place -- an unrelated query parameter,
        describing a paid relationship this endpoint is not allowed to read,
        deciding whether a free write lands. A query parameter selects a
        representation; it never steers persistence, and it must never
        turn a write that happened into a 4xx. Caught by the codex adversarial
        review of.

        `is_active=True` is the same bound `CreatorView.queryset` carries, so
        a deactivated account and a nonexistent one stay indistinguishable.
        No `check_object_permissions()` call is missing here: the only
        permission on this route is `IsAuthenticated`, which has no object-level
        half, and the authorization that matters ("which follower row is
        this?") comes from `request.user`, never from the object.
        """
        return get_object_or_404(
            Creator.objects.filter(is_active=True),
            **{
                self.lookup_field: self.kwargs[
                    self.lookup_url_kwarg or self.lookup_field
                ],
            },
        )

    def _follow_state(self, target: Creator) -> Response:
        """The one response body all three methods return.

        Counts are read AFTER the write so a client never has to guess whether
        its own action is included, and both sides are restricted to active
        accounts so a banned or deactivated account cannot keep inflating
        somebody's follower count.
        """
        return Response({
            # The canonical casing, not whatever the caller typed: the lookup
            # is `username__iexact`, so echoing the path segment back would
            # hand the client a key that does not match the profile route.
            'username': target.username,
            'following': CreatorFollow.objects.filter(
                follower=self.request.user, creator=target,
            ).exists(),
            'follower_count': CreatorFollow.objects.filter(
                creator=target, follower__is_active=True,
            ).count(),
            'following_count': CreatorFollow.objects.filter(
                follower=target, creator__is_active=True,
            ).count(),
        })

    @extend_schema(
        summary="Am I following this creator?",
        description=(
            "The authenticated caller's follow state for one creator, plus "
            "the creator's public follow counts. This is the FREE follow "
            "graph: it never reads or writes 2Z, a Subscription, subscriber "
            "entitlement or `member_price`. A creator who does not exist and "
            "a creator who is deactivated are deliberately indistinguishable "
            "(both 404)."
        ),
        responses={
            200: CreatorFollowStateSerializer,
            401: OpenApiResponse(description="Authentication required."),
            404: OpenApiResponse(
                description="No such active creator.",
            ),
        },
    )
    @action(
        detail=True, methods=['get'], url_path='follow',
        permission_classes=[IsAuthenticated],
    )
    def follow(self, request, **kwargs):
        return self._follow_state(self._follow_target())

    @extend_schema(
        summary="Follow a creator",
        description=(
            "Idempotent. The first call creates the relationship; every "
            "later call is a no-op that reports the same state. Takes no "
            "request body -- the pair is the entire state, and it is "
            "identified by the authenticated caller and the path segment. "
            "Following yourself is refused with 400 and creates no row."
        ),
        request=None,
        responses={
            200: CreatorFollowStateSerializer,
            400: OpenApiResponse(
                description="A creator cannot follow themselves.",
            ),
            401: OpenApiResponse(description="Authentication required."),
            404: OpenApiResponse(description="No such active creator."),
        },
    )
    @follow.mapping.put
    def follow_create(self, request, **kwargs):
        target = self._follow_target()
        if target.pk == request.user.pk:
            return Response(
                {'detail': "A creator cannot follow themselves."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # `get_or_create` and not `create`: the unique constraint is what makes
        # this idempotent under concurrency, and get_or_create resolves the
        # IntegrityError inside its own savepoint instead of 500-ing on a
        # double-click.
        CreatorFollow.objects.get_or_create(
            follower=request.user, creator=target,
        )
        return self._follow_state(target)

    @extend_schema(
        summary="Unfollow a creator",
        description=(
            "Idempotent. Removes the relationship if it exists and reports "
            "`following: false` either way. Unlike cancelling a paid "
            "Subscription, this leaves nothing behind: there is no entitlement "
            "to run out and no renewal ceiling to zero. Returns 200 with the "
            "resulting state rather than 204 so a client can render the new "
            "counts without a second round trip."
        ),
        request=None,
        responses={
            200: CreatorFollowStateSerializer,
            401: OpenApiResponse(description="Authentication required."),
            404: OpenApiResponse(description="No such active creator."),
        },
    )
    @follow.mapping.delete
    def follow_destroy(self, request, **kwargs):
        target = self._follow_target()
        CreatorFollow.objects.filter(
            follower=request.user, creator=target,
        ).delete()
        return self._follow_state(target)

    def _relationship_state(self, target, *, model, source, target_field):
        return Response({
            'username': target.username,
            'active': model.objects.filter(
                **{source: self.request.user, target_field: target}
            ).exists(),
        })

    def _relationship_target(self):
        return self._follow_target()

    def _relationship_write(self, request, *, model, source, target_field,
                            active, label):
        target = self._relationship_target()
        if target.pk == request.user.pk:
            return Response(
                {'detail': f'A creator cannot {label} themselves.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        relation = model.objects.filter(
            **{source: request.user, target_field: target}
        )
        if active:
            relation.get_or_create(
                **{source: request.user, target_field: target},
            )
        else:
            relation.delete()
        return self._relationship_state(
            target, model=model, source=source, target_field=target_field,
        )

    @action(
        detail=True, methods=['get'], url_path='block',
        permission_classes=[IsAuthenticated],
    )
    @extend_schema(
        request=None,
        responses={200: CreatorRelationshipStateSerializer},
    )
    def block(self, request, **kwargs):
        target = self._relationship_target()
        return self._relationship_state(
            target, model=CreatorBlock, source='blocker', target_field='blocked',
        )

    @extend_schema(
        summary="Block a creator",
        description=(
            "Idempotent. Takes no request body. While the block exists the "
            "caller is no longer served the blocked account's comments "
            "(thread, reply and comment lists), zPages (every public zPage "
            "list, including search and that account's profile list), "
            "reply/mention/comment-vote/page-vote/page-update notifications, or realtime "
            "notification pushes, and a new chat request from the blocked "
            "account to the caller answers 404 `recipient_not_found` and "
            "charges nothing (nor is a queued one emailed). Money receipts "
            "(donations, subscription and pay-per-view revenue, chat requests "
            "already paid for) stay listed. A zPage or comment opened "
            "directly by its identifier still resolves. The blocked account "
            "is not notified and its own reads are unchanged. Blocking "
            "yourself is refused with 400."
        ),
        request=None,
        responses={200: CreatorRelationshipStateSerializer},
    )
    @block.mapping.put
    def block_create(self, request, **kwargs):
        return self._relationship_write(
            request, model=CreatorBlock, source='blocker', target_field='blocked',
            active=True, label='block',
        )

    @extend_schema(
        summary="Unblock a creator",
        description=(
            "Idempotent. Removes the block if it exists and reports "
            "`active: false` either way; everything the block hid is served "
            "again."
        ),
        request=None,
        responses={200: CreatorRelationshipStateSerializer},
    )
    @block.mapping.delete
    def block_destroy(self, request, **kwargs):
        return self._relationship_write(
            request, model=CreatorBlock, source='blocker', target_field='blocked',
            active=False, label='block',
        )

    @action(
        detail=True, methods=['get'], url_path='mute',
        permission_classes=[IsAuthenticated],
    )
    @extend_schema(
        request=None,
        responses={200: CreatorRelationshipStateSerializer},
    )
    def mute(self, request, **kwargs):
        target = self._relationship_target()
        return self._relationship_state(
            target, model=CreatorMute, source='muter', target_field='muted',
        )

    @extend_schema(
        request=None,
        responses={200: CreatorRelationshipStateSerializer},
    )
    @mute.mapping.put
    def mute_create(self, request, **kwargs):
        return self._relationship_write(
            request, model=CreatorMute, source='muter', target_field='muted',
            active=True, label='mute',
        )

    @extend_schema(
        request=None,
        responses={200: CreatorRelationshipStateSerializer},
    )
    @mute.mapping.delete
    def mute_destroy(self, request, **kwargs):
        return self._relationship_write(
            request, model=CreatorMute, source='muter', target_field='muted',
            active=False, label='mute',
        )


# TODO: this is a stopgap that may last a while:
# returns either "zpage" or "creator" based on id
# this allows us to serve pages and creators at the root
# over time we will remove the pages at the root
class GetTypeAPI(APIView):
    # Root-URL routing lookup ('is /foo a creator or a zPage?'),
    # resolved before any login on every anonymous visit.
    permission_classes = [AllowAny]
    # SvelteKit calls this server-to-server for historic root URLs. A stock
    # UserRateThrottle or any anonymous IP throttle here would put every
    # signed-out visitor into the SSR pod's shared bucket. Its caller instead
    # admits anonymous root routes after the creator lookup has returned 404
    # and before this additional resolver, using an ingress-keyed token bucket;
    # this endpoint keeps the authenticated ceiling without re-bucketing
    # anonymous SSR traffic on the pod address. Direct public callers are
    # separately bounded at the exact nginx route before reaching Django.
    throttle_classes = [AuthenticatedUserRateThrottle]

    def get(self, request, *args, **kwargs):
        id = kwargs.get('id')

        try:
            # `is_active=True`. The zPage half below is deliberately
            # visibility-blind so an owner previewing a draft still gets
            # routed to the zPage view; the creator half had no such reason,
            # it was simply the only creator lookup on the platform that did
            # not filter -- `CreatorView.queryset` and
            # `crawler._active_creator_or_404` both do. Answering "creator"
            # for a banned username routes the browser to a profile that then
            # 404s, which is a worse answer than 404-ing here.
            Creator.objects.get(username__iexact=id, is_active=True)
            return Response("creator")
        except Creator.DoesNotExist:
            pass

        # Answer with the SAME precedence the detail route resolves with, by
        # sharing its resolver. This endpoint only decides which client route
        # to render, so any disagreement with `/api/zpage/{id}/` is a broken
        # page: before  this half matched `free2zaddr__iexact`, so a
        # differently-cased address answered "zpage" and then the detail call
        # 404'd inside the page that answer had just opened.
        #
        # PUBLICATION visibility is deliberately NOT applied: the owner
        # previewing an unpublished page at its root URL must still be routed
        # to the zPage view, which then does its own authorization. Only the
        # publish-state type leaks — exactly as before.
        #
        # CREATOR state is a different question and IS applied (codex
        # adversarial review). Nobody previews a deactivated account's page —
        # the account cannot log in — so this exemption buys that case nothing,
        # while leaving it in place kept an existence oracle the rest of the
        # takedown closed: `/api/get-type/{banned-page-address}` answering
        # `"zpage"` next to a detail route that 404s. Applied AFTER
        # `resolve_zpage_pk`, never inside it: the resolver is
        # identity-first and visibility-blind on purpose, and filtering
        # within it would let a squatting vanity win a hidden page's
        # identifier.
        pk = resolve_zpage_pk(id)
        if pk is not None and zPage.objects.filter(
            pk=pk, creator__is_active=True,
        ).exists():
            return Response("zpage")
        return Response(status=status.HTTP_404_NOT_FOUND)
