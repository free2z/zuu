import math
import uuid
import logging
from decimal import Decimal, InvalidOperation
from datetime import datetime, time

from django import http
from django.db.utils import IntegrityError
from django.db import connection, models, transaction
from django.shortcuts import get_object_or_404
from django.contrib.contenttypes.models import ContentType

from django.utils import timezone
from django.utils.text import slugify

from drf_spectacular.utils import (
    OpenApiParameter, OpenApiResponse, extend_schema, extend_schema_view,
)
from pgvector.django import CosineDistance
from rest_framework import (
    generics, viewsets, filters, exceptions, permissions
)
from rest_framework import serializers as drf_serializers
from rest_framework import status
from django.db.models import Case, Q, FloatField, F, Count, When
from django.db.models.functions import Coalesce, Exp
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.views import APIView

from .exception_handler import RedirectWithModalException

from django.utils.cache import patch_vary_headers

from dj.apps.g12f.serializers import (
    zPageListSerializer, zPageUpdateSerializer,
    zPageDetailSerializer,
    zPageDestroySerializer,
)
from dj.apps.g12f.serializers.zpage import (
    ConflictDetailSerializer,
    ZPageCreateIdempotencyErrorSerializer,
    MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE,
    MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
    FundPageRequestSerializer, MAX_FUND_PAGE_AMOUNT,
    ZPageVariantSummarySerializer, lock_zpages_for_translation_write,
)
from dj.apps.g12f.models.creator import Subscription
from dj.apps.g12f.models import (
    Creator,
    PUBLICLY_VISIBLE,
    zPage,
    ZPageTranslation,
    ZPageVariant,
    ZPageMutationActor,
)
from dj.apps.g12f.blocks import exclude_blocked
from dj.apps.g12f.translation.actors import record_authenticated_write
from dj.apps.g12f.variants import content_digest, translation_digest
from dj.apps.g12f.identifiers import resolve_zpage_pk
from dj.apps.g12f.preconditions import (
    IF_MATCH_HEADER,
    IF_NONE_MATCH_HEADER,
    PreconditionFailedSerializer,
    canonical_etag,
    canonical_etag_from_db,
    canonical_precondition,
    check_if_match,
    check_if_none_match,
    keep_unseen_auto_tags,
    matched_auto_tags,
    variant_etag,
    variant_precondition,
)
from dj.apps.g12f.publication import emit_page_update
from dj.apps.g12f.mentions import process_page_mentions
from dj.apps.g12f.localization import (
    ContentExcerpt,
    is_content_language,
    localized_list_translation_prefetch,
    feed_variant_prefetch,
    localized_variant_prefetch,
    detail_translation_prefetch,
    viewer_id_from_request,
    normalize_zpage_language,
    variant_index_translation_prefetch,
    variant_reads_enabled,
    variant_summaries,
)
from dj.apps.events.models import Event
from dj.apps.tuzis import ledger
from dj.apps.tuzis import models as idempotency
from dj.apps.tuzis.ledger import InsufficientFunds


PAGE_FUND_IDEMPOTENCY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36},
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optional UUIDv4 key for retrying one boost. A completed keyed request "
        "is replayed rather than debiting 2Z again."
    ),
)

PAGE_VOTE_IDEMPOTENCY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={"type": "string", "format": "uuid", "minLength": 36, "maxLength": 36},
    location=OpenApiParameter.HEADER,
    required=False,
    description="Optional UUIDv4 retry key for one page vote; its fingerprint includes page, direction, and one 2Z charge.",
)


def _page_fund_key(request):
    return idempotency.request_key(request)


def _required_page_key(request):
    if request.headers.get("Idempotency-Key") is None:
        return None, None
    key = _page_fund_key(request)
    if key is None:
        return None, Response(
            {
                "code": "idempotency_key_required",
                "error": "A valid UUIDv4 Idempotency-Key header is required.",
            },
            status=status.HTTP_400_BAD_REQUEST,
        )
    return key, None


def _page_claim(request, scope, payload):
    key, error = _required_page_key(request)
    if error is not None:
        return None, error
    if key is None:
        return None, None
    try:
        return idempotency.claim(
            scope,
            request.user,
            key,
            request_hash=idempotency.fingerprint(payload),
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
        if duplicate.in_flight:
            return None, Response(
                {"code": "request_in_progress", "error": "The original request is still in progress."},
                status=status.HTTP_409_CONFLICT,
            )
        body = duplicate.record.response_body
        if not isinstance(body, dict):
            return None, Response(
                {"code": "invalid_idempotency_record", "error": "The original response could not be replayed safely."},
                status=status.HTTP_409_CONFLICT,
            )
        replay = {k: v for k, v in body.items() if not k.startswith("_")}
        replay["replayed"] = True
        return None, Response(replay, status=duplicate.record.response_status)


#IdempotencyKey scope for POST /api/zpage/. Listed in tuzis'
#cleanup_idempotency EXPIRING_SCOPES, so receipts expire on the shared
#published horizon.
ZPAGE_CREATE_SCOPE = "zpage-create"
#Set on a create answered from an earlier request's receipt.
IDEMPOTENT_REPLAY_HEADER = "Idempotent-Replayed"
#Capability signal on EVERY response from POST /api/zpage/ ( review).
#An older backend ignores the header and never sends this, so a client that
#has not seen it must not assume a retry under its key is safe.
IDEMPOTENCY_KEY_HONORED_HEADER = "Idempotency-Key-Honored"

ZPAGE_CREATE_RESPONSE_HEADERS = [
    OpenApiParameter(
        name=IDEMPOTENCY_KEY_HONORED_HEADER,
        type=str,
        enum=["true"],
        location=OpenApiParameter.HEADER,
        response=True,
        description=(
            "Always `true` on every response from this operation: "
            "this server honours `Idempotency-Key` on page creation. A "
            "backend that predates the key never sends it, and ignores the "
            "key -- so a client must not retry a timed-out create under its "
            "key until it has seen this header from the server it is talking "
            "to, and should stop trusting it the moment a keyed create is "
            "answered without it."
        ),
    ),
    OpenApiParameter(
        name=IDEMPOTENT_REPLAY_HEADER,
        type=str,
        enum=["true"],
        location=OpenApiParameter.HEADER,
        response=[201],
        description=(
            "Present (`true`) only when this 201 replays the page an earlier "
            "request under the same Idempotency-Key created; nothing new was "
            "created."
        ),
    ),
]

ZPAGE_CREATE_IDEMPOTENCY_PARAMETER = OpenApiParameter(
    name="Idempotency-Key",
    type={"type": "string", "format": "uuid"},
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optional UUIDv4 retry key for ONE page creation. Scoped to "
        "the authenticated user and to this operation: another account's "
        "identical key is a different key, and no other endpoint replays it. "
        "Parsed as a UUID and stored canonically, so spellings of one UUID "
        "are the same key. Semantics:\n\n"
        "* First use: the page is created and the key is bound to a "
        "fingerprint of the request body, atomically with the page.\n"
        "* Same key, same body: **no new page**. The response is `201` with "
        "the ORIGINAL page (same `free2zaddr`) as it is now and the response "
        "header `Idempotent-Replayed: true`. Its `ETag` is the validator the "
        "page had when this key CREATED it, so an `If-Match` update sent from "
        "the replaying client returns **412** if the page was changed since "
        "(the client only knows the body it created). A retry sent while "
        "the original is still running waits for it and then replays it.\n"
        "* Same key, different body: **409** `idempotency_mismatch`; nothing "
        "is created.\n"
        "* Same key, original page since deleted: **409** "
        "`idempotency_page_gone`; nothing is created.\n"
        "* A header that is present but not a UUIDv4: **400** "
        "`idempotency_key_required`; nothing is created.\n"
        "* A create that fails (400, 5xx) does not spend the key.\n\n"
        "Receipts expire "
        f"{idempotency.COMPLETED_CLAIM_RETENTION.days} days after the create, "
        "after which the key is unknown again and would create a new page. "
        "Without the header every POST creates a new page, so a client that "
        "abandons a create at a timeout cannot safely retry it."
    ),
)


class _CreateNotCommitted(Exception):
    """Carries a non-201 create response out of the claim's savepoint."""

    def __init__(self, response):
        super().__init__(response.status_code)
        self.response = response


def _fallback_zpage_vanity(title, free2zaddr):
    """Return a unique ASCII vanity when a title has no ASCII slug.

    Public pages need a vanity to participate in discovery surfaces. Keep the
    fallback tied to the page's immutable identity, while checking both
    identifier namespaces so it cannot shadow a vanity or another page's
    address. It is used on create and when a vanity-less draft is first
    published; already-published pages keep their existing URLs.
    """
    if slugify(title):
        return ""

    def taken(candidate):
        # The same namespaces `zPageUpdateSerializer.validate_vanity` refuses:
        # this value is passed straight to `serializer.save()`, so nothing else
        # checks it. A username matters because root routing resolves a
        # creator before a vanity.
        # The page itself is excluded, as `validate_vanity` excludes it: two
        # overlapping publishes of one draft must both pick the SAME value,
        # not have the second treat the first's commit as a collision and
        # replace a URL that was already handed out.
        return (
            zPage.objects.filter(
                Q(vanity__iexact=candidate) | Q(free2zaddr__iexact=candidate)
            ).exclude(free2zaddr=str(free2zaddr)).exists()
            or Creator.objects.filter(username__iexact=candidate).exists()
        )

    short_id = str(free2zaddr).replace("-", "").lower()
    for length in range(12, len(short_id) + 1, 2):
        candidate = f"p-{short_id[:length]}"
        if not taken(candidate):
            return candidate

    # Exhausting a UUID's prefixes requires every prefix to be claimed as a
    # vanity. Retain the stable page id and add entropy in that exceptional case.
    while True:
        candidate = f"p-{short_id}-{uuid.uuid4().hex[:8]}"
        if not taken(candidate):
            return candidate


def _publication_fallback_vanity(serializer, instance):
    """The fallback a canonical write must store, or ``""`` for none.

    Only when the write takes a draft public -- publishes it now or schedules
    it -- and leaves it with no vanity. Both canonical write paths (the page
    PUT/PATCH and a variant write addressed at the source language) call this,
    so neither can publish a non-Latin page that discovery surfaces exclude.
    """
    data = serializer.validated_data
    vanity = data.get("vanity", instance.vanity or "")
    if vanity or instance.is_published:
        return ""
    publish_at = data.get("publish_at", instance.publish_at)
    if not (data.get("is_published", False) or publish_at is not None):
        return ""
    return _fallback_zpage_vanity(
        data.get("title", instance.title), instance.free2zaddr,
    )


def _fingerprintable(data):
    """``request.data`` as JSON-compatible data for the request fingerprint."""
    if hasattr(data, "lists"):
        # QueryDict (form or multipart): keep every value of a repeated key.
        data = {key: values for key, values in data.lists()}
    try:
        idempotency.fingerprint(data)
    except (TypeError, ValueError):
        # An uploaded file or another non-JSON value: compare its text form,
        # which is stable for the same retry and never raises.
        if isinstance(data, dict):
            return repr(sorted((str(k), repr(v)) for k, v in data.items()))
        return repr(data)
    return data


def _page_fund_claim(request, address, amount):
    claim, response = _page_claim(
        request,
        "page_fund",
        {"action": "page_fund", "page": address, "amount": str(amount)},
    )
    if response is not None:
        if isinstance(getattr(response, "data", None), dict):
            score = response.data.get("score")
            if isinstance(score, str):
                return None, Response(
                    {
                        "score": score,
                        "replayed": response.data.get("replayed", False),
                    },
                    status=response.status_code,
                )
        return claim, response
    if claim is not None and claim.response_status is not None:
        body = claim.response_body
        return None, Response(
            {"score": body["score"], "replayed": True},
            status=claim.response_status,
        )
    return claim, None
from dj.apps.tuzis.serializers import InsufficientFundsErrorSerializer


class ZPageCreateNeeds2ZErrorSerializer(InsufficientFundsErrorSerializer):
    """402 from POST /api/zpage/: a second page needs a balance of 1 2Z.

    The ordinary ``insufficient_funds`` contract, so every client that already
    reads it (the composers, ZUULI's wallet) understands this refusal too.
    ``cost`` is the balance a second page requires; creating it debits
    nothing. ``detail`` is a sentence for a client that does not read
    ``code``.
    """

    detail = drf_serializers.CharField(read_only=True)
from dj.apps.search.drf_filters import VectorSearchFilter
from dj.apps.search.models import SearchIndex
from dj.apps.tagging.models import resolve_alias_terms
from dj.apps.tagging.slugs import tags_for_hub_slug
from dj.free2z.pagination import (
    Free2zPagination,
    ZPageFeedCursorPagination,
)

logger = logging.getLogger(__name__)


def _query_flag(request, name):
    return request.query_params.get(name, '').strip().lower() in {
        '1', 'true', 'yes', 'on',
    }


def _lock_zpage_for_variant_write(page: zPage) -> zPage:
    """Return the parent row locked for one variant write.

    The published-translation ceiling is a property of the whole page, not of
    one ``(zpage, language)`` row.  Locking only the target row would leave two
    different languages free to both observe 63 translations and publish a
    64th.  Every variant PUT/PATCH -- including the deprecated alias -- calls
    this inside ``_save_variant``'s transaction, so the count and subsequent
    write serialize on this one parent row.
    """
    try:
        return lock_zpages_for_translation_write(page.pk)[page.pk]
    except KeyError:
        raise http.Http404


class zPageListPagination(Free2zPagination):
    """Paginator for the zPage list that also reports per-publish-state totals.

    The owner's dashboard Published/Drafts badges need the *true* totals
    across all pages, not just the rows on the current page. We
    compute ``published_count`` / ``draft_count`` with a single grouped
    aggregate over the fully-filtered queryset *before* it is sliced into a
    page, so the counts honour the same search / tag filters that produced the
    list and never require fetching every page client-side.

    Cost containment: the only consumer of these totals is the owner's own
    profile (``?mine=true``), so the extra aggregate query runs *only* on that
    path. The high-traffic public list consumers — homepage feed, search,
    sitemap, public profiles — take the vanilla paginated response with no
    added query and no added fields (the counts are optional in the schema).
    """

    def paginate_queryset(self, queryset, request, view=None):
        # Gate the extra aggregate to the owner's-own-pages request; every
        # other zpage listing keeps the stock single count() + page query.
        self._include_counts = _query_flag(request, 'mine')
        if self._include_counts:
            # One extra COUNT query (grouped by is_published) over the same
            # filtered queryset DRF is about to paginate. distinct=True guards
            # against row multiplication from the tags join used by ?tags=.
            agg = queryset.aggregate(
                published_count=Count(
                    'pk', distinct=True, filter=Q(is_published=True)),
                draft_count=Count(
                    'pk', distinct=True, filter=Q(is_published=False)),
            )
            self._published_count = agg['published_count'] or 0
            self._draft_count = agg['draft_count'] or 0
        return super().paginate_queryset(queryset, request, view)

    def get_paginated_response(self, data):
        response = super().get_paginated_response(data)
        if getattr(self, '_include_counts', False):
            response.data['published_count'] = self._published_count
            response.data['draft_count'] = self._draft_count
        return response

    def get_paginated_response_schema(self, schema):
        result = super().get_paginated_response_schema(schema)
        # Optional (not in `required`): present only on ?mine=true responses.
        result['properties']['published_count'] = {
            'type': 'integer', 'example': 12}
        result['properties']['draft_count'] = {
            'type': 'integer', 'example': 3}
        return result

#The balance a creator who already has a zPage needs to start another one.
#Creating it debits nothing; the first page is free.
NEW_PAGE_REQUIRED_BALANCE = Decimal("1")
#Every new account starts with the welcome 2Z, so this is shown to
#someone who has spent theirs; it must not say they start at 0.
NEW_PAGE_NEED_2Z_MESSAGE = (
    "Your first zPage is free. To start another one you need at least 1 2Z. "
    "Members can gift you 2Z, or you can buy 2Z."
)


def zpage_random(request):
    # `published_and_active()`, not `is_published=True`: this hands an
    # anonymous caller a URL to go read, so it is a discovery surface and a
    # deactivated creator's page must not be one of the answers.
    zpage = zPage.objects.published_and_active().filter(
        f2z_score__gte=1,
    ).order_by('?').first()
    if zpage is None:
        # Previously an AttributeError -> 500 whenever nothing qualified.
        raise http.Http404
    # This endpoint is itself a first-party discovery emitter. The legacy
    # get_url() shape remains an API compatibility field, but newly selected
    # links must point directly at the canonical public route.
    return http.HttpResponse(zpage.get_public_url())


# The crawler-prerender views that used to live here (find_social,
# zpage_social, zpage_social_new, converse_social, ai_social) moved to
# dj/apps/g12f/views/crawler.py in, which is where the URL-parity and
# visibility rules for that tier now live together. They are still exported
# from `dj.apps.g12f.views` via that module's star import.


@extend_schema(
    parameters=[PAGE_VOTE_IDEMPOTENCY_PARAMETER],
    request={
        "application/json": {
            "type": "object",
            "required": ["vote"],
            "properties": {
                "vote": {"type": "string", "enum": ["up", "down"]},
            },
        },
    },
    responses={
        200: OpenApiResponse(
            response={
                "type": "object",
                "properties": {
                    "success": {"type": "string"},
                    "f2z_score": {"type": "string", "format": "decimal"},
                    "replayed": {"type": "boolean"},
                },
                "required": ["success", "f2z_score", "replayed"],
            },
            description="The vote and the authoritative page score.",
        ),
        400: OpenApiResponse(description="Malformed vote or unavailable page."),
        402: InsufficientFundsErrorSerializer,
        409: OpenApiResponse(description="The key is in flight or mismatched."),
    }
)
@transaction.non_atomic_requests
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def vote_page(request, free2zaddr):
    # Get the comment object and the user object
    # Scoped to pages the caller could actually be looking at: a deactivated
    # creator's page is off the platform, and voting is a 2Z spend that moves
    # `f2z_score` on content nobody is allowed to read. 404, matching
    # every other route for the same page.
    # Check if the request is an upvote or a downvote. Use.get() so a missing
    # `vote` key is a 400, not a KeyError -> 500.
    vote = request.data.get('vote')
    if vote == 'up':
        delta = 1
    elif vote == 'down':
        delta = -1
    else:
        # Return an error if the request is not an upvote or downvote
        return Response({'error': 'Invalid vote type'}, status=400)

    claim, duplicate_response = _page_claim(
        request,
        "page_vote",
        {
            "action": "page_vote",
            "page": free2zaddr,
            "direction": vote,
            "amount": "1",
        },
    )
    if duplicate_response is not None:
        return duplicate_response

    try:
        page: zPage = get_object_or_404(
            zPage.objects.from_active_creators(), free2zaddr=free2zaddr,
        )
    except Exception:
        if claim is not None:
            idempotency.release(claim)
        raise
    user = request.user

    # Charge the vote atomically, then apply it. If the debit loses a race
    # against a concurrent spend the vote does not happen at all — previously
    # both votes landed and the balance went negative. The score
    # itself is an F() update for the same reason: two voters read-modify-write
    # of `tuzi_total` used to silently drop one of the votes.
    # The charge, the score and both accounting events are one transaction:
    # a failed event write must not leave the user charged for a vote whose
    # accounting never happened, since their retry would charge again.
    try:
        with transaction.atomic():
            # Lock order is global, not per view: Creator row first, page row
            # second (the ledger's order, see `lock_in_order`). This used to
            # take the page first and the voter's balance second, while
            # FundPageView took them the other way round, so the same user
            # voting while funding held one row each and waited on the other:
            # Postgres killed one side with `deadlock detected`, a 500 on a
            # money endpoint. Taking the voter's row here, before the
            # page, puts both paths on the one order.
            ledger.lock_in_order(user)
            # Serialize votes for one page so the aggregate Event rows cannot
            # lose increments while the score itself uses an F expression.
            page = zPage.objects.select_for_update(of=("self",)).select_related(
                "creator"
            ).get(pk=page.pk)
            if not page.creator.is_active:
                raise _PageWentAway
            ledger.debit(user, 1, action="page_vote")
            # Same time-of-check/time-of-use guard as FundPageView: re-assert
            # the creator's state as part of the write statement rather than
            # trusting the earlier read, so a ban committing in the gap rolls
            # the 2Z debit back instead of scoring a taken-down page.
            scored = zPage.objects.filter(
                pk=page.pk, creator__is_active=True,
            ).update(tuzi_total=F('tuzi_total') + delta)
            if not scored:
                raise _PageWentAway

            # Create event for the spender (and the page owner if different)
            voter_event, voter_event_created = Event.objects.get_or_create(
                read=True,
                type="PAGE_VOTE",
                receiving_user=user,
                contributor=user,
                object_id=page.id,
                content_type=ContentType.objects.get_for_model(zPage),
                defaults={
                    'amount': 1,
                }
            )
            if not voter_event_created:
                voter_event.amount += 1
                voter_event.updated_at = timezone.now()
                voter_event.save()

            if user != page.creator:
                page_owner_event, page_owner_event_created = Event.objects.get_or_create(
                    type="PAGE_VOTE",
                    receiving_user=page.creator,
                    contributor=user,
                    object_id=page.id,
                    content_type=ContentType.objects.get_for_model(zPage),
                    defaults={
                        'amount': 1,
                    }
                )
                if not page_owner_event_created:
                    page_owner_event.amount += 1
                    page_owner_event.read = False
                    page_owner_event.updated_at = timezone.now()
                    page_owner_event.save()
            page.refresh_from_db(fields=['tuzi_total'])
            # The receipt and live response must contain the score produced by
            # this vote, not the instance value loaded before the F() update.
            # Keep the recomputation inside the same transaction as the vote
            # so a replay cannot permanently freeze a pre-vote score.
            page.cache_total()
            response_body = {
                'success': 'Vote recorded',
                # The API contract is a decimal string with the same eight
                # fractional places as the stored score.  ``str(Decimal)``
                # drops trailing zeroes for integral scores (``10`` rather
                # than ``10.00000000``), which makes the live response differ
                # from the authoritative value returned by the page model.
                'f2z_score': f'{page.f2z_score:.8f}',
                'replayed': False,
            }
            if claim is not None:
                claim.finish(status.HTTP_200_OK, response_body)
    except InsufficientFunds as exc:
        if claim is not None:
            idempotency.release(claim)
        return Response(
            ledger.insufficient_funds_payload(exc, action="page_vote"),
            status=status.HTTP_402_PAYMENT_REQUIRED,
        )
    except _PageWentAway:
        # Identical to the answer for an id that never existed: the vote route
        # must not become an oracle for "this creator was just deactivated".
        if claim is not None:
            idempotency.release(claim)
        raise http.Http404
    except Exception:
        if claim is not None:
            idempotency.release(claim)
        raise

    # AtomicMiddleware owns the outer POST transaction. Run this derived-cache
    # repair only after that money transaction commits, and make it best-effort:
    # lock contention or a cache bug must not roll back or report failure for a
    # valid vote. ``nowait`` is essential because on_commit callbacks are still
    # synchronous: if the owner row is busy, skip this opportunistic refresh
    # immediately and let the scheduled score_pages pass be the durable backstop.
    owner_id = page.creator_id
    transaction.on_commit(
        lambda: Creator._base_manager.get(pk=owner_id).cache_total(nowait=True),
        robust=True,
    )

    # Return a success response
    return Response(response_body)


class MultipleFieldLookupMixin(object):
    @staticmethod
    def _get_by_identifier(queryset, identifier):
        """Resolve identity globally, then check the caller's visibility.

        The precedence itself lives in
        :func:`dj.apps.g12f.identifiers.resolve_zpage_pk`, shared with
        ``/api/get-type/`` so the two routes cannot disagree about which page
        a URL segment names ( §2).

        Returning ``None`` when the resolved page is outside ``queryset`` is
        the whole point of resolving identity first: a hidden, unpublished or
        subscriber-only page must NOT fall through to a public page whose
        vanity squats its identifier.
        """
        pk = resolve_zpage_pk(identifier)
        if pk is None:
            return None
        return queryset.filter(pk=pk).first()

    def get_object(self):
        queryset = self.get_queryset()
        queryset = self.filter_queryset(queryset)
        pk = self.kwargs.get('pk')
        page = self._get_by_identifier(queryset, pk)
        if page is not None:
            return page

        # TODO: could be made abstracter
        # `from_active_creators()` matters here as much as on the main
        # queryset: without it a deactivated creator's subscriber-only
        # page skips the 404 and raises the upsell modal instead, which both
        # confirms the page exists and invites the reader to pay a banned
        # account for access to it.
        subscriber_pages = zPage.objects.published_and_active().filter(
            is_subscriber_only=True,
        )
        page = self._get_by_identifier(subscriber_pages, pk)
        if page is not None:
            raise RedirectWithModalException(
                page=page,
                show_modal=True,
            )
        raise http.Http404


class _PageWentAway(Exception):
    """The target page stopped being fundable/votable mid-transaction.

    Raised inside the money `transaction.atomic()` blocks so the enclosing
    block rolls the 2Z debit back. Never leaves this module: both call sites
    catch it and answer exactly as they would have for an unknown id, so it
    is not an oracle for "this page was just banned" either.
    """


class _PageAtCapacity(Exception):
    """The page cannot represent another whole 2Z in its integer total."""


class FundPageView(APIView):

    permission_classes = [IsAuthenticated]
    # The claim must commit before the money transaction so a concurrent retry
    # cannot enter the charge path with an invisible claim.
    atomic_request = False

    @extend_schema(
        parameters=[PAGE_FUND_IDEMPOTENCY_PARAMETER],
        request=FundPageRequestSerializer,
        responses={
            status.HTTP_200_OK: OpenApiResponse(
                # A decimal STRING, matching every other f2z_score
                # serialization in this spec. DRF's JSON encoder renders a
                # bare Decimal as a float, which cannot round-trip a
                # DecimalField(max_digits=20, decimal_places=8) score.
                response={
                    "type": "object",
                    "required": ["score", "replayed"],
                    "properties": {
                        "score": {"type": "string", "format": "decimal"},
                        "replayed": {"type": "boolean"},
                    },
                },
                description='Authoritative score after the boost commits, plus whether this was a replay.',
            ),
            status.HTTP_402_PAYMENT_REQUIRED: InsufficientFundsErrorSerializer,
        },
    )
    def post(self, request: Request, format=None) -> Response:
        creator = request.user
        # print(dir(request.data.keys()))
        # print(request.user.tuzis)
        addr = request.data.get('id')
        amt = request.data.get('amount')
        # print(addr, amt)
        if not (addr and amt):
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="id and amount required"
            )

        try:
            raw_amt = Decimal(str(amt))
            if not raw_amt.is_finite():
                raise InvalidOperation
            if raw_amt != raw_amt.to_integral_value():
                raise ValueError("fractional")
            amt = ledger.to_tuzis(raw_amt)
        except (InvalidOperation, ValueError, TypeError):
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="amount must be a number",
            )
        # zPage.tuzi_total is an IntegerField. A fractional amount used to be
        # added to it in Python and handed to Postgres as a non-integer, so
        # reject it here instead of finding out at write time.
        if amt != amt.to_integral_value():
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="amount must be a whole number of 2Z",
            )
        if raw_amt < 1:
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="amount must be at least 1",
            )
        if raw_amt > MAX_FUND_PAGE_AMOUNT:
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="amount exceeds the maximum fundable amount",
            )

        # Claim before resolving mutable visibility. A completed receipt must
        # remain replayable after unpublish/deactivation; a new request that
        # cannot resolve the page is released below without charging.
        claim, duplicate_response = _page_fund_claim(request, addr, amt)
        if duplicate_response is not None:
            return duplicate_response

        try:
            # `from_active_creators()`: funding is a 2Z transfer to a
            # page, and the crawler tier already called out this endpoint as
            # the remaining hole. A deactivated account is off the platform,
            # so its pages must not be fundable -- and the caller gets the
            # same "does not exist" answer as for any other unreachable id,
            # rather than a distinguishable "banned" response.
            page = zPage.objects.from_active_creators().get(free2zaddr=addr)
        except zPage.DoesNotExist:
            if claim is not None:
                idempotency.release(claim)
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="page matching id does not exist",
            )

        # Debit and page credit in one transaction: a failure between them used
        # to leave the 2Z spent with the page never funded, or vice versa.
        response_score = None
        try:
            with transaction.atomic():
                # Lock order is global: the funder's Creator row FIRST, the
                # page row second -- the same order `vote_page` and the
                # ledger use, so a vote racing a fund on one page cannot
                # hold one row each and wait on the other. The debit
                # below would take the balance row first anyway; taking it
                # explicitly here keeps the invariant in one place instead
                # of depending on statement order.
                ledger.lock_in_order(creator)
                # Funding the page with 2Z does not bump the user's timestamp,
                # which the ledger's targeted UPDATE preserves.
                ledger.debit(creator, amt, action="page_fund")
                # The creator-state predicate is repeated INSIDE the write, as
                # part of the same statement, rather than trusted from the
                # read above. The read is a separate statement under READ
                # COMMITTED, so a ban committing in the gap between them would
                # otherwise let a debited 2Z land on an already-banned page --
                # money moved by a takedown's own race. Matching zero rows
                # rolls the debit back with the atomic block (codex
                # adversarial review, ).
                fund_amount = int(amt)
                credited = zPage.objects.filter(
                    pk=page.pk,
                    creator__is_active=True,
                    # Keep the addition inside PostgreSQL's signed integer
                    # range even when the page already has a large boost
                    # total. The predicate and update are one statement, so
                    # concurrent funders cannot race past the capacity.
                    tuzi_total__lte=MAX_FUND_PAGE_AMOUNT - fund_amount,
                ).update(tuzi_total=F('tuzi_total') + fund_amount)
                if not credited:
                    if zPage.objects.filter(
                        pk=page.pk, creator__is_active=True,
                    ).exists():
                        raise _PageAtCapacity
                    raise _PageWentAway
                page.refresh_from_db(fields=['tuzi_total'])
                page.cache_total()
                response_score = f'{page.f2z_score:.8f}'
                if claim is not None:
                    claim.finish(
                        status.HTTP_200_OK,
                        {"score": response_score, "replayed": False},
                    )
        except InsufficientFunds as exc:
            if claim is not None:
                idempotency.release(claim)
            return Response(
                status=status.HTTP_402_PAYMENT_REQUIRED,
                data=ledger.insufficient_funds_payload(exc, action="page_fund"),
            )
        except _PageWentAway:
            if claim is not None:
                idempotency.release(claim)
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="page matching id does not exist",
            )
        except _PageAtCapacity:
            if claim is not None:
                idempotency.release(claim)
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data="page has reached its maximum fundable total",
            )
        except Exception:
            if claim is not None:
                idempotency.release(claim)
            raise

        # Recompute the page owner, not the funder. AtomicMiddleware owns the
        # outer transaction, so on_commit is what actually keeps this derived
        # projection from undoing committed funding on failure. The callback is
        # synchronous, hence ``nowait``: a busy owner row cannot delay the HTTP
        # acknowledgement after the money transaction has already committed.
        owner_id = page.creator_id
        transaction.on_commit(
            lambda: Creator._base_manager.get(pk=owner_id).cache_total(nowait=True),
            robust=True,
        )
        return Response({"score": response_score, "replayed": False})


# Popularity recency decay: a page's popularity weight halves every
# POPULAR_HALF_LIFE_DAYS. Keeps evergreen high-score pages ranking well while
# stopping stale all-time high scorers from permanently owning the front page.
POPULAR_HALF_LIFE_DAYS = 45.0


class AgeInDays(models.Func):
    """Age of a datetime field, in days, as a float (Postgres)."""
    template = "EXTRACT(EPOCH FROM (NOW() - %(expressions)s)) / 86400.0"
    output_field = FloatField()


class ZPagePublicationOrderingFilter(filters.OrderingFilter):
    """Order public chronological lists by the immutable publication time.

    ``published_at`` is nullable for drafts and for rows created during the
    rolling migration.  The list queryset annotates ``publication_order`` as
    ``published_at`` with a ``created_at`` fallback, so the public default and
    the new published_at ordering work for both populations.  Explicit
    ``mine``, ``homeSort``, and search/relevance requests retain their existing
    ordering semantics.
    """

    def get_ordering(self, request, queryset, view):
        ordering = super().get_ordering(request, queryset, view)
        if ordering is None:
            return None

        # `homeSort` selects a score/activity/random ranking and vector search
        # owns relevance; neither is a chronological publication feed, and
        # neither is guaranteed to carry the `publication_order` annotation.
        #
        # `mine` is deliberately NOT exempt. Its default ordering is
        # `-updated_at` and stays that way (no `ordering` param means
        # `super().get_ordering()` returns None and we never reach here), but
        # an *explicit* `?mine=1&ordering=-published_at` is a request for
        # publication order and must get the same COALESCE fallback as every
        # other feed. Ordering by the raw column instead sorts drafts --
        # `published_at IS NULL` -- to the very top, because PostgreSQL DESC
        # is NULLS FIRST. The annotation is applied to the `mine` queryset too,
        # so the rewrite is always resolvable here.
        if (
            request.query_params.get("homeSort")
            or request.query_params.get("search")
        ):
            return ordering

        return [
            (
                f"{'-' if field.startswith('-') else ''}publication_order"
                if field.lstrip("-") == "published_at"
                else field
            )
            for field in ordering
        ]



ZPAGE_LANGUAGE_PARAMETER = OpenApiParameter(
    name="lang",
    type=str,
    location=OpenApiParameter.QUERY,
    description=(
        "Which language variant to render. Any real BCP-47 language tag "
        "(`en`, `de`, `ja`, `pt-PT`); bare `pt` is accepted as `pt-BR`. A tag "
        "that is not a language at all is a 400. Omit to negotiate: the "
        "`Accept-Language` header is consulted next, and the article's source "
        "variant last."
    ),
)

# Declared so a generated client can see that this header shapes the response
# ( §4.3). It is a *representation* input on safe methods only -- the write
# paths ignore it entirely, exactly as they ignore `?lang=`.
ZPAGE_ACCEPT_LANGUAGE_PARAMETER = OpenApiParameter(
    name="Accept-Language",
    type=str,
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Standard weighted preference list, used when `lang` is absent. The "
        "full list is honoured in `q` order; an exact tag match beats a "
        "primary-subtag match (`en-GB` finds the `en` variant), `q=0` refuses "
        "a language, and a preference for a language this page does not have "
        "falls through to the source variant rather than failing. Responses "
        "carry `Vary: Accept-Language, Cookie`."
    ),
)

ZPAGE_PAGINATION_PARAMETER = OpenApiParameter(
    name="pagination",
    type=str,
    location=OpenApiParameter.QUERY,
    enum=["cursor"],
    description=(
        "Opt into stable keyset pagination for infinite feeds. Omit this "
        "parameter to retain the default page-number contract."
    ),
)

ZPAGE_CURSOR_PARAMETER = OpenApiParameter(
    name="cursor",
    type=str,
    location=OpenApiParameter.QUERY,
    description=(
        "Opaque continuation token returned in `next`; use only with "
        "`pagination=cursor`."
    ),
)

# Same selector on a write, documented so generated clients can see that it is
# response-shaping only. A URL never dictates what goes in the database:
# on a write `lang` picks which variant the response body renders and cannot
# change what is stored, so an unusable value degrades to the canonical variant
# instead of failing a write that has already committed.
ZPAGE_WRITE_LANGUAGE_PARAMETER = OpenApiParameter(
    name="lang",
    type=str,
    location=OpenApiParameter.QUERY,
    required=False,
    description=(
        "Which language variant to render in the response body. Affects the "
        "representation only: it never sets or changes what is persisted. The "
        "source language comes from the `source_language` body field, on "
        "create and on update alike — it is mutable, and changing "
        "it to a language that already has a translation is a 409. An "
        "unsupported `lang` value here is ignored rather than failing the "
        "write. `Accept-Language` is NOT negotiated on a write: the response "
        "describes the variant that was written."
    ),
)

# The zPage identifier, declared explicitly on every route that takes one.
#
# `MultipleFieldLookupMixin.get_object` looks this segment up as
# `free2zaddr` OR `vanity` -- both strings, never a primary key. Left to
# infer, drf-spectacular reads the model's pk and publishes `type: integer`,
# so the generated client took a `number` for a value every caller has as a
# UUID string.  corrected the new variant operations only;  §2
# finishes the job on `zpage_retrieve`, which was the last one left claiming
# `integer`. `update`, `partial_update` and `destroy` on the same path were
# already `string`, so the spec was internally inconsistent about a single URL
# segment -- one operation on `/api/zpage/{id}/` describing a different type
# than the other three is not a documentation nit, it is a contract that
# cannot all be true.
ZPAGE_ID_PATH_PARAMETER = OpenApiParameter(
    name="id",
    type=str,
    location=OpenApiParameter.PATH,
    required=True,
    description=(
        "The zPage's `free2zaddr` (a UUID) or its `vanity` slug. Not the "
        "database primary key -- this route never looks one up."
    ),
)

# The variant path segment. Declared so the generated client documents what a
# caller may put there -- a path segment identifies a resource, and this one
# has real rules (registry-validated, `pt` canonicalizes to `pt-BR`).
VARIANT_LANGUAGE_PATH_PARAMETER = OpenApiParameter(
    name="language",
    type=str,
    location=OpenApiParameter.PATH,
    required=True,
    description=(
        "BCP-47 tag of the variant to address — any real human language "
        "(`en`, `de`, `ja`, `pt-PT`). Bare `pt` canonicalizes to `pt-BR`, so "
        "`.../variants/pt/` and `.../variants/pt-BR/` are the same resource. "
        "A tag that is not a language is a 400, not a 404. The variant whose "
        "tag equals the page's `source_language` is the article itself."
    ),
)

# Request metadata that legitimately shapes a write, and therefore has to be in
# the contract (see CLAUDE.md, "A URL never dictates what goes in the
# database"). It cannot supply a value to persist -- it can only decide whether
# the write happens at all -- and a generated client that cannot see it cannot
# implement optimistic concurrency, which is the whole feature.
#
# orval emits no code for `in: header` parameters, so declaring it here does
# NOT make the browser send it; the call site passes it explicitly
# (`ts/svelte/free2z/src/lib/api/preconditions.ts`). The declaration is the
# contract, not the wiring.
IF_MATCH_PARAMETER = OpenApiParameter(
    name=IF_MATCH_HEADER,
    type=str,
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "Optimistic-concurrency precondition. Send the strong `ETag` "
        "returned by the corresponding read; the write is applied only if the "
        "resource still has that exact state, and otherwise fails with **412** "
        "and changes nothing. `*` asserts only that the resource exists. "
        "Optional: omitting it keeps the historical last-write-wins behaviour, "
        "so existing clients are unaffected — but two editors of the same "
        "article will then silently overwrite each other. Weak (`W/\"...\"`) "
        "tags never match, per RFC 9110 strong comparison."
    ),
)

# The create-only half of the same contract. `If-Match` protects a write
# against a version that already exists; it says nothing about a CREATE, so two
# tabs that both saw "no French yet" both PUT `/variants/fr/` and the second
# silently replaced the first one's new translation. Like `If-Match`, it cannot
# supply a value to persist -- it only decides whether the write happens -- and
# like `If-Match` the editor sends it by hand: orval emits nothing for it.
#
# Declared only on the variant writes. The canonical `POST /api/zpage/` mints a
# fresh id per create, so "this already exists" is unrepresentable there (a
# retried create is what `Idempotency-Key` is for), and the canonical `PUT`
# always addresses an article that exists. Neither route reads the header.
IF_NONE_MATCH_PARAMETER = OpenApiParameter(
    name=IF_NONE_MATCH_HEADER,
    type=str,
    location=OpenApiParameter.HEADER,
    required=False,
    enum=["*"],
    description=(
        "Create-only precondition. `*` means \"apply this write only "
        "if this language has no version yet\": if one exists -- including "
        "the page's own `source_language`, which is the article itself -- the "
        "write fails with **412** and changes nothing, so two clients starting "
        "the same new translation cannot silently overwrite each other. "
        "Checked under the same lock as the write, so it holds under a real "
        "race. Only `*` is supported; any other value, including an empty "
        "one, is a **400**. Optional: omitting it keeps the historical "
        "create-or-replace behaviour. Evaluated after `If-Match` "
        "(RFC 9110 §13.2.2)."
    ),
)

def _write_sets_label(request, page) -> bool:
    """Does this write's body set ``source_language`` to something new?

    Decides whether a detector relabel the client has not seen may be
    overlooked by the precondition (``preconditions.canonical_precondition``).
    Anything we cannot compare with confidence -- an unnormalizable value, a
    non-string -- counts as "sets the label", which only ever makes the
    precondition stricter. A body that omits the field, or repeats the current
    value, does not set it: that is every autosave the Svelte editor sends.
    """
    data = getattr(request, "data", None)
    if not hasattr(data, "get"):
        return False
    requested = data.get("source_language")
    if requested is None:
        return False
    try:
        requested = normalize_zpage_language(requested, allow_missing=False)
    except Exception:  # noqa: BLE001 -- the serializer reports the 400
        return True
    return requested != page.source_language


def _claimed_source_language(request):
    """The label the client says it last saw, from ``X-Free2Z-Source-Language``.

    Raw, not normalized: it is compared against the stored value the client
    was handed (which may be the legacy ``und``), inside a digest.
    """
    value = request.headers.get(TRANSLATION_SOURCE_LANGUAGE_HEADER)
    return value.strip() if value and value.strip() else None


TRANSLATION_SOURCE_LANGUAGE_HEADER = "X-Free2Z-Source-Language"
TRANSLATION_SOURCE_LANGUAGE_PARAMETER = OpenApiParameter(
    name=TRANSLATION_SOURCE_LANGUAGE_HEADER,
    type=str,
    location=OpenApiParameter.HEADER,
    required=False,
    description=(
        "The article's `source_language` as this client last read it. Two "
        "uses. (1) Required for translation writes when the canonical source "
        "language is unsupported/undetermined; the value must then exactly "
        "match the article's current source_language, so stale editors fail "
        "closed with 409. (2) With `If-Match`, on the canonical article and "
        "on translation writes: if the only change since the client's "
        "read is the background language detector relabelling the article "
        "(`language_source` is `detected`), and this write does not itself "
        "set `source_language`, the precondition passes instead of returning "
        "412. The response then carries the new `source_language`, and a "
        "client that sends this header is declaring that it will adopt it -- "
        "a client that does not follow the label should not send it on a "
        "canonical write. Omitted, `If-Match` is compared exactly. A write "
        "that sets a different `source_language` never gets this allowance."
    ),
)


# The tag filter has worked since taggit was added and has never been in the
# schema, so no generated client could express it and the new UI grew a
# twenty-item hardcoded picker in its place. Declaring it is what makes
# a tag chip a link to a documented capability rather than a hand-built URL.
#
# Read-only by construction: it selects which zPages the response describes and
# cannot reach persistence. Matching is `iexact`, which is also the reason the
# folksonomy tolerates `zcash` and `ZCASh` pointing at one browse page.
ZPAGE_TAGS_PARAMETER = OpenApiParameter(
    name="tags",
    type=str,
    location=OpenApiParameter.QUERY,
    required=False,
    description=(
        "Comma-separated tag names. A zPage matches only if it carries **all** "
        "of them (AND, not OR). Matching is case-insensitive, so `zcash` and "
        "`ZCASh` select the same pages. Tags are a free-form vocabulary "
        "(`django-taggit`) — there is no fixed list to choose from; "
        "`GET /api/tagging/autocomplete` enumerates the ones in use."
    ),
)

def _tag_group_condition(term, live_cache=None):
    """Match ``term`` OR any other spelling in its alias group.

    Factored out because two filters now need it -- `?tags=` and the
    `?any_tags=` group added for general callers  -- and a second
    copy is how the two would drift into disagreeing about which pages a tag
    reaches. The single-name fast path keeps the overwhelmingly common case at
    exactly one `iexact` predicate.

    `live_cache` is the per-request memo that makes N spellings of one alias
    group cost one scan instead of N, and that carries the per-request scan
    budget (`LIVE_WIDENING_MAX_SCANS`) with it -- pass ONE dict through every
    term of a request.
    """
    group = resolve_alias_terms(term, live_cache=live_cache)
    if len(group) == 1:
        return Q(tags__name__iexact=term)
    condition = Q()
    for name in group:
        condition |= Q(tags__name__iexact=name)
    return condition


#Compatibility bound on how many names one `any_tags` group may carry. Each
#one costs an
#alias lookup plus an OR'd branch in the tag join, on an endpoint anonymous
#callers reach, so the ceiling is explicit. It is also comfortably above what
#the caller this exists for asks: `TAG_SLUG_MAX_CANDIDATES` in
#`dj/apps/tagging/slugs.py` keeps the hub's display representation bounded.
#CLAMPED, not rejected -- an over-long group widens the result set rather
#than 400ing a browse request.
ZPAGE_ANY_TAGS_MAX = 50

# The OR half of tag filtering. `tags` alone cannot express a tag hub:
# `/tag/t-shirts` is the union of every spelling that slugs to `t-shirts`, and
# `?tags=t-shirts,t shirts` would demand a page carry BOTH.
ZPAGE_ANY_TAGS_PARAMETER = OpenApiParameter(
    name="any_tags",
    type=str,
    many=True,
    location=OpenApiParameter.QUERY,
    required=False,
    style="form",
    explode=True,
    description=(
        "Tag names, **repeated** (`?any_tags=a&any_tags=b`) rather than "
        "comma-joined. A zPage matches if it carries **any** of them (OR). "
        "Matching is case-insensitive and alias-resolved, exactly like "
        "`tags`. Combining the two ANDs the groups: `?tags=zcash&"
        "any_tags=t-shirts&any_tags=t shirts` means *zcash* AND (*t-shirts* "
        "OR *t shirts*). Repeated rather than comma-separated because a tag "
        "name may itself contain a comma, and this parameter's reason to "
        "exist — the `/tag/<slug>` hub — is precisely the set of spellings "
        f"that collide on one slug. At most {ZPAGE_ANY_TAGS_MAX} names are "
        "read; the rest are ignored rather than rejected."
    ),
)

ZPAGE_HUB_SLUG_PARAMETER = OpenApiParameter(
    name="hub_slug",
    type=str,
    location=OpenApiParameter.QUERY,
    required=False,
    description=(
        "A public tag-hub slug. The server resolves the complete canonical "
        "component and filters by it, so the bounded `names` display list "
        "cannot strand pages from a hub with more than 50 spellings. This "
        "is the list counterpart to `GET /api/tagging/hub/{slug}`."
    ),
)

ZPAGE_MINE_PARAMETER = OpenApiParameter(
    name="mine",
    type=bool,
    location=OpenApiParameter.QUERY,
    required=False,
    description=(
        "Owner-only draft access. Set this explicitly from the dashboard or "
        "editor; ordinary public profile and article reads are published-only "
        "and use the public paywall representation even for the owner. An "
        "anonymous request with `mine=true` is rejected with 403."
    ),
)


@extend_schema_view(
    list=extend_schema(parameters=[
        ZPAGE_LANGUAGE_PARAMETER,
        ZPAGE_ACCEPT_LANGUAGE_PARAMETER,
        ZPAGE_PAGINATION_PARAMETER,
        ZPAGE_CURSOR_PARAMETER,
        ZPAGE_TAGS_PARAMETER,
        ZPAGE_ANY_TAGS_PARAMETER,
        ZPAGE_HUB_SLUG_PARAMETER,
        ZPAGE_MINE_PARAMETER,
    ]),
    retrieve=extend_schema(
        parameters=[
            ZPAGE_ID_PATH_PARAMETER,
            ZPAGE_LANGUAGE_PARAMETER,
            ZPAGE_ACCEPT_LANGUAGE_PARAMETER,
            ZPAGE_MINE_PARAMETER,
        ],
        description=(
            "One zPage. The response carries a strong `ETag` for the "
            "**canonical** article — send it back as `If-Match` on a later "
            "PUT/PATCH/DELETE to make that write conditional. It "
            "describes the canonical article even when `?lang=` rendered a "
            "translation, because the write on this URL always writes the "
            "canonical article; a translation's own validator comes "
            "from `GET /api/zpage/{id}/variants/{language}/`."
        ),
    ),
    create=extend_schema(
        parameters=[
            ZPAGE_WRITE_LANGUAGE_PARAMETER,
            ZPAGE_CREATE_IDEMPOTENCY_PARAMETER,
            *ZPAGE_CREATE_RESPONSE_HEADERS,
        ],
        request=zPageUpdateSerializer,
        responses={
            201: zPageDetailSerializer,
            402: OpenApiResponse(
                response=ZPageCreateNeeds2ZErrorSerializer,
                description=(
                    "The creator already has a zPage and a balance below "
                    "`cost` (1 2Z). The first page is free; another needs "
                    "that balance, and creating it debits nothing. Nothing "
                    "was created, and an `Idempotency-Key` sent with this "
                    "request is not spent."
                ),
            ),
            409: OpenApiResponse(
                response=ZPageCreateIdempotencyErrorSerializer,
                description=(
                    "The Idempotency-Key cannot be honoured: "
                    "`idempotency_mismatch` (it created a page from a "
                    "different body) or `idempotency_page_gone` (the page "
                    "it created was deleted). Nothing was created."
                ),
            ),
        },
        description=(
            "Create a zPage. Send an `Idempotency-Key` to make a retry of "
            "this create safe; the header documents the exact replay "
            "and refusal semantics."
        ),
    ),
    update=extend_schema(
        parameters=[
            ZPAGE_WRITE_LANGUAGE_PARAMETER,
            IF_MATCH_PARAMETER,
            TRANSLATION_SOURCE_LANGUAGE_PARAMETER,
        ],
        request=zPageUpdateSerializer,
        responses={
            200: zPageDetailSerializer,
            409: ConflictDetailSerializer,
            412: PreconditionFailedSerializer,
        },
        description=(
            "Update a zPage. `source_language` is the article's language "
            "*label* and is mutable: changing it renames the "
            "source variant and the denormalized column in one transaction. "
            "If another variant already holds the target language the change "
            "is refused with **409** and an actionable message — never a "
            "silent overwrite of the creator's translation.\n\n"
            "Send `If-Match` with the `ETag` from the article read to make "
            "this write conditional: a second tab that saved in the "
            "meantime turns this into a **412** instead of silently discarding "
            "their edit. Without the header the write is last-write-wins, as "
            "it has always been."
        ),
    ),
    partial_update=extend_schema(
        parameters=[
            ZPAGE_WRITE_LANGUAGE_PARAMETER,
            IF_MATCH_PARAMETER,
            TRANSLATION_SOURCE_LANGUAGE_PARAMETER,
        ],
        request=zPageUpdateSerializer,
        responses={
            200: zPageDetailSerializer,
            409: ConflictDetailSerializer,
            412: PreconditionFailedSerializer,
        },
        description=(
            "Partially update a zPage. `source_language` is mutable and "
            "owner-only; a target language already held by another variant "
            "is refused with **409**. Honours the optional "
            "`If-Match` precondition, returning **412** if the article "
            "changed since the `ETag` the client is holding."
        ),
    ),
    destroy=extend_schema(
        parameters=[ZPAGE_ID_PATH_PARAMETER, IF_MATCH_PARAMETER],
        responses={
            204: None,
            409: ConflictDetailSerializer,
            412: PreconditionFailedSerializer,
        },
        description=(
            "Delete a zPage. Owner only. Honours the optional `If-Match` "
            "precondition: a delete issued from a stale editor — one "
            "that never saw somebody else's newer draft — returns **412** and "
            "deletes nothing.\n\n"
            "The validator describes **this article's own fields**. Deleting "
            "an article also deletes its translations, and a concurrent write "
            "to one of those does *not* invalidate it — deliberately, because "
            "an AI translation landing while the creator edits the source "
            "would otherwise fail their own autosave and blame someone else "
            "for it.\n\n"
            "An article that still carries legacy on-chain records -- a ZEC "
            "payment (`Transaction`) or an on-chain comment (`PageComment`) "
            "addressed to it -- is refused with **409** and nothing is "
            "deleted: those rows are other people's payment records and are "
            "`PROTECT`ed, so the article cannot be removed from under them."
        ),
    ),
)
class zPageView(
    MultipleFieldLookupMixin,
    viewsets.ModelViewSet,
    # viewsets.GenericViewSet,
    # generics.GenericAPIView,
    generics.ListAPIView,
):
    """
    API endpoint that allows zpages to be viewed or edited.
    This is the workhorse.
    """
    # Custom paginator adds per-publish-state totals to the list response so
    # the profile Published/Drafts tab badges reflect true totals.
    pagination_class = zPageListPagination
    filter_backends = [
        ZPagePublicationOrderingFilter,
        VectorSearchFilter,
    ]
    ordering_fields = [
        'id',
        'created_at',
        'updated_at',
        'published_at',
        'total',
        'f2z_score',
    ]

    lookup_fields = ('free2zaddr', 'vanity')
    #Variant reads see exactly what `retrieve` sees -- same paywall, same
    #subscriber carve-out, same owner-sees-drafts rule. Listed rather than
    #reimplemented so a future change to article visibility cannot leave the
    #variant routes behind as a read-around.
    VARIANT_READ_ACTIONS = ('variant_list', 'variant_retrieve')
    #Variant writes are owner-only, like every other zPage write. A non-owner
    #gets a 404 (not a 403) from the owner-scoped queryset, which is also
    #what the deprecated /translations/ route does: whether someone else's
    #draft translation exists is not a fact we hand out.
    VARIANT_WRITE_ACTIONS = (
        'variant_update', 'variant_partial_update', 'variant_destroy',
    )
    serializers = {
        'list': zPageListSerializer,
        'retrieve': zPageDetailSerializer,
        'create': zPageUpdateSerializer,
        'update': zPageUpdateSerializer,
        'partial_update': zPageUpdateSerializer,
        'translation': zPageUpdateSerializer,
        # DELETE on the translation route has no request or response body.
        'destroy_translation': zPageDestroySerializer,
        'destroy': zPageDestroySerializer,
        'related': zPageListSerializer,
        'variant_list': ZPageVariantSummarySerializer,
        'variant_retrieve': zPageDetailSerializer,
        'variant_update': zPageUpdateSerializer,
        'variant_partial_update': zPageUpdateSerializer,
        'variant_destroy': zPageDestroySerializer,
    }
    # Related pages: same cosine-distance ceiling the search filter uses
    # (lower distance = more similar).
    related_max_distance = VectorSearchFilter.max_score
    related_limit = 6
    #How many nearest neighbours to pull off the HNSW index before applying
    #the visibility filters. 4x `related_limit`: `SearchIndex` rows are
    #deleted when a page stops being publicly visible
    #(`search.helpers.create_search_index_if_not_exists`, `search.tasks`),
    #so nearly every neighbour survives `_related_candidates` -- but
    #"nearly" is not "all", and under-fetching degrades quietly into the
    #author fallback rather than failing.
    #
    #Also chosen so the plan does not depend on the `enable_seqscan` pin
    #below. Measured against a 3,901-row fixture (production cardinality):
    #the planner picks the HNSW index unassisted at `LIMIT 24` and flips to
    #a sequential scan at `LIMIT 60`. Raising this past ~40 puts the whole
    #fix back on the wrong side of a cost-model knife edge.
    related_ann_fetch = 24
    #Second-chance fetch, used only when the distance ceiling rejected
    #nothing from the first pass -- so that list ended where the index
    #stopped handing rows over, not where the neighbours stopped being close
    #enough -- and it still yielded fewer than `related_limit` *visible*
    #pages. Ranking the index before the
    #visibility filters is what makes the query fast, and the price is that
    #an unlucky run of ineligible neighbours can push a good one past the
    #cut-off -- where the old exact query, which ranked every visible page,
    #would have found it. Widening once to 10x covers that; beyond it the
    #endpoint does what it already does when nothing is close enough, and
    #falls back to the author's recent pages.
    #
    #The ineligible rows that matter are index entries for pages
    #`_related_candidates` rejects. Creator deactivation deletes those
    #synchronously, but **unpublishing does not** -- it enqueues
    #`search.index_zpage` on the slow `search` queue -- so a stalled worker
    #is the way to accumulate them. See
    #`test_related_falls_back_when_the_widened_fetch_is_also_all_ineligible`
    #for the bound and the reasoning.
    #
    #60 and not more because that is the largest `LIMIT` still measured to
    #run as an HNSW index scan under the `enable_seqscan` pin (1.1 ms at
    #3,901 rows); at 96 the planner switches to a `content_type_id` btree
    #scan and reads every vector anyway (11 ms), which defeats the point.
    related_ann_fetch_max = 60
    #`hnsw.ef_search` for the neighbour query. pgvector does NOT raise
    #`ef_search` to meet `LIMIT`: measured on pgvector 0.8.5, a `LIMIT 90`
    #at the default `ef_search = 40` returns exactly 40 rows, silently. Must
    #therefore stay >= `related_ann_fetch_max` (asserted in the tests); the
    #rest is recall headroom. At 3,901 rows the ANN top-6 was identical --
    #same pages, same order -- to exact search on all 60 probes.
    related_ef_search = 64
    # NOTE: this was `permissions = [...]` — a typo for a setting DRF
    # has never read, so the viewset silently ran wide open.
    # Public browse/detail; create/update/destroy already scope to
    # request.user and reject anonymous callers.
    permission_classes = [permissions.IsAuthenticatedOrReadOnly]
    search_fields = [
        "title", "vanity", "content", "free2zaddr", "p2paddr",
        "creator__username", "description",
    ]

    @property
    def paginator(self):
        """Use stable keyset pagination only for opted-in feed requests."""
        if not hasattr(self, '_paginator'):
            pagination_mode = self.request.query_params.get('pagination')
            cursor = self.request.query_params.get('cursor')
            if pagination_mode not in (None, '', 'cursor'):
                raise exceptions.ValidationError({
                    'pagination': 'Unsupported pagination mode.',
                })
            if cursor and pagination_mode != 'cursor':
                raise exceptions.ValidationError({
                    'cursor': 'Set pagination=cursor when supplying a cursor.',
                })
            pagination_class = self.pagination_class
            if (
                self.action == 'list'
                and pagination_mode == 'cursor'
            ):
                pagination_class = ZPageFeedCursorPagination
            self._paginator = (
                pagination_class() if pagination_class is not None else None
            )
        return self._paginator

    def get_queryset(self):
        """
        Get queryset of zpages based on the filter parameters
        and the requesting user
        """
        request = self.request
        if request.method in permissions.SAFE_METHODS:
            # `lang` is the reader's variant selector: an unusable value is a
            # real client error on a read. On a write it is at most a hint for
            # the response body and must never fail the write, so the
            # serializer degrades it to the canonical variant instead.
            normalize_zpage_language(
                request.query_params.get("lang"), allow_missing=True
            )
        is_owner = Q(creator=request.user)
        # "Public" means published AND authored by an account that is still
        # active. `ACTIVE_CREATOR` is ANDed onto the public arm only:
        # `is_owner` remains unqualified for the explicit `mine=true` arm,
        # because a deactivated account cannot authenticate at all (Django's
        # ModelBackend rejects `is_active=False`).
        published = PUBLICLY_VISIBLE

        if self.action == "create":
            return zPage.objects.none()

        if self.action == 'list':
            is_mine = _query_flag(self.request, 'mine')
            if is_mine and request.user.is_anonymous:
                raise exceptions.NotAuthenticated
            username = self.request.query_params.get('username')

            # Keep the owner-only arm out of list paths where it cannot
            # possibly match. Besides making the predicate reflect the actual
            # requested creator, this lets another creator's public profile
            # use the partial published chronological index rather than
            # forcing PostgreSQL to plan a global OR condition.
            if is_mine:
                visibility = is_owner
            else:
                # A profile, feed, search, tag, or homepage request is a
                # public surface even when the reader is the page owner.
                # Drafts belong behind the explicit `mine=true` dashboard /
                # editor contract only; otherwise pagination counts hidden
                # rows and creates short pages with blank client slots.
                visibility = published

            tags = self.request.query_params.get('tags')
            hub_slug = self.request.query_params.get('hub_slug')
            # `any_tags` is REPEATED, never comma-joined, and that is not
            # gratuitous inconsistency with `tags` above. Its whole
            # reason to exist is the tag hub, whose members are the spellings
            # that share one URL slug -- and `t,shirts` is one of the names
            # that slugs to `t-shirts`. Splitting on a comma would take the
            # exact input this parameter was added for and turn it into two
            # different tags. `tags` keeps its comma form because changing a
            # live parameter's parsing is a breaking change; a new one gets to
            # be unambiguous from the start.
            # De-duplicated BEFORE the cap, so a repeated name cannot spend
            # one of the 50 slots a distinct name could have used. An OR group
            # is unchanged by removing a repeat.
            any_tags = list(dict.fromkeys(
                name for name in self.request.query_params.getlist('any_tags')
                if name.strip()
            ))[:ZPAGE_ANY_TAGS_MAX]
            if hub_slug:
                _, hub_tags = tags_for_hub_slug(hub_slug)
                if hub_tags:
                    q = zPage.objects.filter(
                        # `hub_tags` came from the authoritative Tag source
                        # resolver.  Filtering through TagIdentity here would
                        # reintroduce the bulk/raw-write projection gap and
                        # could make the hub count disagree with its list.
                        tags__pk__in=[tag.pk for tag in hub_tags]
                    ).distinct()
                else:
                    q = zPage.objects.none()
            else:
                q = zPage.objects.all()
            if tags or any_tags:
                # AND across `tags`, OR within `any_tags`, AND between the two
                # groups. Every term WIDENS through its alias group ( and
                # its follow-up ): a caller filtering on "ZCASh" reaches
                # pages carrying "zcash" AND pages still carrying the old
                # spelling -- redirecting instead of widening made
                # variant-carrying pages unreachable by ANY term.
                # ONE memo for the whole request, shared by both filters: the
                # scan is keyed on `tag_key`, so every spelling of a group --
                # and every repeat across `tags` AND `any_tags` -- asks the
                # same question and pays for it once.
                live_cache = {}
                if tags:
                    # `dict.fromkeys`, not `set`: order is what makes the
                    # widening budget deterministic, and an AND filter is
                    # unchanged by removing a repeat.
                    terms = list(dict.fromkeys(tags.split(',')))
                    for tag in terms:
                        q = q.filter(
                            _tag_group_condition(tag, live_cache=live_cache))
                if any_tags:
                    # OR within the group, in ONE `filter()`. Chaining would
                    # demand a page carry all of them, which is the semantics
                    # `tags` already has and the reason this parameter exists.
                    matches = Q()
                    for name in any_tags:
                        matches |= _tag_group_condition(
                            name, live_cache=live_cache)
                    q = q.filter(matches)
                q = q.distinct()
            else:
                # Keep the complete server-side hub filter when there are no
                # additional tag predicates.
                if not hub_slug:
                    q = zPage.objects.all()

            q = q.filter(visibility).annotate(
                publication_order=Coalesce(
                    F('published_at'), F('created_at')
                )
            )

            if is_mine:
                if self.request.user.is_anonymous:
                    raise exceptions.NotAuthenticated
                q = q.filter(is_owner)
                q = q.order_by('-updated_at')
            else:
                q = q.exclude(
                    title=""
                ).exclude(
                    vanity=""
                ).exclude(
                    vanity__isnull=True
                )

            if username:
                q = q.filter(creator__username=username)

            if not is_mine:
                # A reader who blocked an account stops being served its
                # pages on every public list -- feed, search, tag, profile
                #. A reader with no blocks gets the unchanged query.
                q = exclude_blocked(q, request.user, 'creator')

            if self.request.query_params.get('unverified') == "0":
                q = q.exclude(is_verified=False)

            # Date-range filtering on created_at. These params were silently
            # ignored before: the view has no DjangoFilterBackend, so
            # field-lookup query params fell through. Parse + validate here.
            for param in ('created_at__gte', 'created_at__lte'):
                raw = self.request.query_params.get(param)
                if not raw:
                    continue
                parsed = parse_datetime(raw)
                if parsed is None:
                    date_only = parse_date(raw)
                    if date_only is not None:
                        parsed = datetime.combine(date_only, time.min)
                if parsed is None:
                    raise exceptions.ValidationError(
                        {param: 'Enter a valid ISO 8601 date or datetime.'}
                    )
                if timezone.is_naive(parsed):
                    parsed = timezone.make_aware(parsed)
                q = q.filter(**{param: parsed})

            homesort = self.request.query_params.get('homeSort')
            if homesort:
                q = q.exclude(featured_image__isnull=True)
            if homesort == "score":
                q = q.order_by('-f2z_score')
            elif homesort == "updated":
                q = q.order_by('-updated_at', '-id')
            elif homesort == "random":
                q = q.order_by('?')
            elif homesort == "popular":
                # Recency-decayed popularity: f2z_score scaled by an
                # exponential decay on age, so recent well-scored pages rank
                # above stale all-time high scorers. Done in the DB so it
                # stays orderable/paginatable.
                q = q.annotate(
                    popularity=models.ExpressionWrapper(
                        models.F('f2z_score') * Exp(
                            models.Value(math.log(0.5) / POPULAR_HALF_LIFE_DAYS)
                            * AgeInDays(models.F('created_at'))
                        ),
                        output_field=FloatField(),
                    )
                ).order_by('-popularity')

            # Keep the public browse default immutable across edits.  Do this
            # on the queryset rather than ``view.ordering`` so mine/homeSort
            # and search-specific orderings are not overwritten by DRF's
            # ordering backend when no explicit ordering parameter is sent.
            if not (
                _query_flag(self.request, 'mine')
                or homesort
                or self.request.query_params.get('search')
            ):
                q = q.order_by('-publication_order', '-id')

            q = q.select_related(
                "creator", "featured_image"
            ).prefetch_related(
                'tags', 'featured_image__webp',
                'creator__avatar_image__webp',
                'featured_image__variants',
                'creator__avatar_image__variants',
                localized_list_translation_prefetch(
                    viewer_id=(
                        viewer_id_from_request(self.request)
                        if is_mine else None
                    ),
                ),
                # 255 for the source because that is the length the zPage
                # annotation below uses; a flip that widened the feed excerpt
                # would be a visible change, and M5 makes none.
                *feed_variant_prefetch(
                    source_length=255,
                    viewer_id=(
                        viewer_id_from_request(self.request)
                        if is_mine else None
                    ),
                ),
            )
            # Annotate the queryset with truncated content
            q = q.annotate(
                truncated_content=ContentExcerpt(
                    models.F('content'), length=255
                )
            ).only(
            # ).values(
                'id', 'free2zaddr', 'vanity', 'p2paddr', 'title', 'category',
                'is_published', 'is_subscriber_only', 'publish_at',
                'featured_image',
                'description', 'source_language',
                # Serialized by zPageListSerializer §3.2. Deferring
                # a field the serializer reads is an N+1 disguised as a
                # micro-optimization: one extra query per row on the homepage
                # feed.
                'detected_language', 'detection_confidence', 'language_source',
                'is_verified', 'total', 'f2z_score',
                # `published_at` is read by the serializer and drives the
                # chronological ordering annotation, so it is loaded for the
                # same reason as the detection columns above.
                'created_at', 'updated_at', 'published_at', 'creator',
                # 'truncated_content',
                'tags'
            )
            return q

        if self.action == 'retrieve' or self.action in self.VARIANT_READ_ACTIONS:
            user = request.user

            # The variants index renders no content at all, so it must not
            # load any. `"translations"` pulls every body -- up to 100,000
            # characters each, on an unpaginated anonymous route with nothing
            # bounding how many languages a page has -- and a query-count test
            # cannot see the difference, because the query count is the same.
            # Only the bytes differ, and the bytes are the blast radius.
            # `"translations"` loads every legacy body. That is only worth
            # paying for while the legacy shape is what renders the article:
            #
            #   * `variant_list` renders no body at all.
            #   * with  M5 on, the body comes from `ZPageVariant`, and
            #     keeping the legacy prefetch as well would materialize BOTH
            #     copies of every translation into one gunicorn process --
            #     100,000 characters each, unbounded in count, on an anonymous
            #     route. Doubling an existing memory amplifier is not a
            #     rounding error; it is the difference between a slow response
            #     and an OOMKill that also takes checkout down. Nothing on
            #     these routes reads a legacy body once reads are flipped, so
            #     the metadata prefetch is both cheaper and sufficient.
            #
            # `viewer_id` on BOTH branches, and the `else` branch is the one
            # that matters most: `ZPAGE_VARIANT_READS` defaults to false and is
            # the documented rollback, so a draft-body bound that only exists
            # while the flag is on is a bound that disappears exactly when an
            # incident turns it off. The plain `"translations"` string used to
            # sit there and loaded every legacy draft body on an anonymous read.
            # (codex adversarial review.)
            # Variant routes are also the rolling-deploy compatibility path:
            # an old editor omits `mine`, but an authenticated owner still
            # needs their draft rows in the prefetch cache. Scope that cache
            # to the authenticated viewer for variant actions only; ordinary
            # article reads remain published-only unless they explicitly opt
            # into `mine`.
            viewer_id = (
                viewer_id_from_request(request)
                if (
                    _query_flag(request, 'mine')
                    or (
                        self.action in self.VARIANT_READ_ACTIONS
                        and user.is_authenticated
                    )
                )
                else None
            )
            translation_prefetch = (
                variant_index_translation_prefetch(viewer_id=viewer_id)
                if self.action == 'variant_list' or variant_reads_enabled()
                else detail_translation_prefetch(viewer_id=viewer_id)
            )
            # Same rule, one table over ( M5). When reads are flipped the
            # detail routes resolve the BODY out of these rows, so they must
            # carry one -- and `variant_list`, which renders no body, must
            # still never load one. Populating the same prefetch cache in both
            # flag states is also what keeps `origin` / `is_stale` byte-
            # identical: `variant_provenance` reads that cache, so a route
            # that fills it today fills it either way, and a route that does
            # not, still does not.
            #
            # `viewer_id` is the  half: unpublished variants this caller
            # can never be shown are dropped in SQL rather than materialized
            # and then filtered in Python. Drafts have no ceiling (only
            # published variants are capped, ) and a body is up to 100,000
            # characters, so on an anonymous route that is an owner-controlled
            # memory multiplier pointed at a process that already OOMs several
            # times a day. The Python-side `include_drafts` filtering
            # is unchanged and is still the security boundary; this only stops
            # the bytes arriving.
            variant_prefetch = localized_variant_prefetch(
                with_content=(
                    variant_reads_enabled() and self.action != 'variant_list'
                ),
                viewer_id=viewer_id,
            )

            include_drafts = bool(
                _query_flag(request, 'mine')
                and user.is_authenticated
            )
            if _query_flag(request, 'mine') and user.is_anonymous:
                raise exceptions.NotAuthenticated
            if include_drafts:
                return zPage.objects.filter(creator=user).select_related(
                    "creator", "featured_image"
                ).prefetch_related(
                    translation_prefetch, "tags", "featured_image__webp",
                    "featured_image__variants", "creator__avatar_image__webp",
                    "creator__avatar_image__variants",
                    variant_prefetch,
                )
            if user.is_anonymous:
                return zPage.objects.filter(
                    published & Q(is_subscriber_only=False)).select_related(
                        "creator", "featured_image"
                    ).prefetch_related(
                        translation_prefetch, "tags", "featured_image__webp",
                        "featured_image__variants", "creator__avatar_image__webp",
                        "creator__avatar_image__variants",
                        variant_prefetch,
                    )
            else:
                # TODO: this might be a little expensive
                # to do on each retrieve for a page...
                # get all the creators that user has subscribed to
                star_ids = Subscription.objects.filter(
                    fan=user, expires__gte=timezone.now(),
                ).values_list(
                    "star_id", flat=True
                )
                # The owner may always ADDRESS their own page, published or
                # not, on retrieve and on the exact variant routes. Three
                # callers depend on it: first-party `::embed[]` cards, which
                # call this route with the reader's cookie and must show the
                # owner their own draft ('s matrix pins it); editor
                # bundles already open during a rolling deploy, which read
                # without `mine`; and the owner's own article preview. What
                # stays published-only without `mine=true` is the
                # REPRESENTATION: `include_drafts` in the serializer context
                # is False, so draft translations are neither prefetched
                # (`viewer_id` is None) nor rendered. Every non-owner arm is
                # still gated by `published`, so nobody else sees a draft.
                public_visibility = (
                    published & (
                        Q(is_subscriber_only=False) |
                        Q(creator__id__in=star_ids)
                    )
                ) | Q(creator=user)
                return zPage.objects.filter(
                    public_visibility
                ).select_related("creator", "featured_image").prefetch_related(
                    translation_prefetch, "tags", "featured_image__webp",
                    "featured_image__variants", "creator__avatar_image__webp",
                    "creator__avatar_image__variants",
                    variant_prefetch,
                )

        if self.action in [
            'update', 'partial_update', 'destroy', 'translation',
            'destroy_translation',
        ] or self.action in self.VARIANT_WRITE_ACTIONS:
            if request.user.is_anonymous:
                raise exceptions.NotAuthenticated
            # No variant prefetch here, on purpose. It would be loaded *before*
            # the write and then rendered *after* it, so `origin` / `is_stale`
            # in a write response would describe the row as it was a moment
            # ago. Both are nullable and null means unknown, which is the
            # truthful answer on a write; the list endpoint is where a client
            # reads provenance. It also keeps the autosave path at exactly the
            # query count it has today.
            return zPage.objects.filter(creator=request.user)

    def get_serializer_class(self):
        return self.serializers.get(self.action)

    def get_serializer_context(self):
        context = super().get_serializer_context()
        request = self.request
        # Public reads must never inherit draft visibility merely because the
        # caller owns the page. Private reads opt in with `mine=true`; write
        # responses retain their historical owner-visible draft semantics.
        context['include_drafts'] = bool(
            request.method not in permissions.SAFE_METHODS
            or _query_flag(request, 'mine')
        )
        return context

    def finalize_response(self, request, response, *args, **kwargs):
        """`Vary: Accept-Language, Cookie` on every zPage response ( §4.3).

        Both halves matter and both are load-bearing. `Accept-Language`,
        because the body genuinely differs by it now — without the header a
        shared cache would serve one reader's Spanish article to the next
        reader who asked for English. `Cookie`, because the same URL returns
        drafts to the owner and not to anyone else, and a cache that missed
        that would leak an unpublished draft to the public. `Cookie` is what
        `hooks.server.ts:24-38` already sets on the SvelteKit side; this makes
        the API agree with it.

        Patched rather than assigned, so DRF's own `Vary: Accept` (content
        negotiation) survives.
        """
        response = super().finalize_response(request, response, *args, **kwargs)
        patch_vary_headers(response, ("Accept-Language", "Cookie"))
        if getattr(self, "action", None) == "create":
            # Every create answer, success or refusal, including a DRF
            # exception rendered here: the editor learns from ANY of them
            # that this backend honours the key.
            response[IDEMPOTENCY_KEY_HONORED_HEADER] = "true"
        return response

    def _related_candidates(self, page: zPage):
        """
        Public zpages that may appear as related items. Mirrors the
        queryset constraints the anonymous list endpoint applies
        (published, active creator, non-empty title and vanity), minus the
        page itself.
        """
        candidates = zPage.objects.published_and_active().exclude(
            title=""
        ).exclude(
            vanity=""
        ).exclude(
            vanity__isnull=True
        ).exclude(
            pk=page.pk
        )
        # Recommendations are a list surface: a reader who blocked a creator
        # is not recommended that creator's pages either.
        return exclude_blocked(candidates, self.request.user, 'creator')

    def _related_neighbor_queryset(self, content_type, vector, exclude_pk,
                                   fetch=None):
        """The ANN query itself: ``ORDER BY vector <=> $1 LIMIT n``.

        Split out from `_related_neighbors` so the regression test can EXPLAIN
        the *actual* queryset the view runs rather than a copy of it.
        """
        distance = CosineDistance('vector', vector)
        return SearchIndex.objects.filter(
            content_type=content_type,
        ).exclude(
            object_id=exclude_pk,
        ).annotate(
            distance=distance,
        ).order_by(
            distance,
        ).values_list(
            'object_id', 'distance',
        )[:fetch or self.related_ann_fetch]

    def _apply_ann_session_settings(self):
        """`SET LOCAL` the two GUCs the ANN query needs; return the old values.

        Caller must be in a transaction -- `SET LOCAL` outside one is a no-op
        with a warning. `current_setting(..., true)` rather than `SHOW`
        because `hnsw.ef_search` is a placeholder GUC until pgvector's library
        is loaded into the backend, and `SHOW` on a placeholder that has never
        been set raises `unrecognized configuration parameter`.
        """
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT current_setting('enable_seqscan', true), "
                "       current_setting('hnsw.ef_search', true)"
            )
            previous = cursor.fetchone()
            # `set_config(..., is_local => true)` IS `SET LOCAL`, but it takes
            # bound parameters and both settings fit in one round trip. Round
            # trips are the whole overhead this helper adds to a GET.
            cursor.execute(
                "SELECT set_config('enable_seqscan', 'off', true), "
                "       set_config('hnsw.ef_search', %s, true)",
                [str(self.related_ef_search)],
            )
        return previous

    def _restore_ann_session_settings(self, previous):
        """Undo `_apply_ann_session_settings` explicitly.

        A COMMIT discards `SET LOCAL` on its own, and in production this *is*
        the outermost transaction (`AtomicMiddleware` wraps write methods
        only, `ATOMIC_REQUESTS` is off), so the settings would not escape
        anyway. Nested inside an existing transaction they would: releasing a
        savepoint does not roll back a `SET LOCAL` made after it, so under
        `TestCase` -- or under a future `ATOMIC_REQUESTS` -- `enable_seqscan =
        off` would silently reprice every later query in the request. Restore
        rather than rely on the shape of the caller.

        Only the success path needs this: `ROLLBACK`/`ROLLBACK TO SAVEPOINT`
        does roll `SET LOCAL` back, so an exception inside `atomic()` is
        already covered (and a restore there would fail on the aborted
        transaction and mask the original error).
        """
        seqscan, ef_search = previous
        with connection.cursor() as cursor:
            # A NULL restores the default, which is the right answer for
            # `hnsw.ef_search` on a connection that had not touched pgvector
            # yet: `current_setting` reads it as NULL while it is still an
            # unloaded placeholder GUC, and by the time we put it back the
            # extension is loaded and NULL resolves to pgvector's own 40.
            cursor.execute(
                "SELECT set_config('enable_seqscan', %s, true), "
                "       set_config('hnsw.ef_search', %s, true)",
                [seqscan, ef_search],
            )

    def _related_neighbors(self, content_type, vector, exclude_pk, fetch=None):
        """Nearest `SearchIndex` rows to `vector`, straight off the HNSW index.

        Returns ``([(object_id, distance)], rows_examined)`` -- the neighbours
        within `related_max_distance`, ordered nearest-first, plus how many
        rows the index actually handed back before that cut. The caller needs
        both to tell "the ceiling truncated this list" (nothing further out
        can qualify) from "the LIMIT truncated it" (more may). The shape here
        is load-bearing:

        * A direct ``ORDER BY vector <=> $1 LIMIT n`` against the indexed
          column is the *only* shape pgvector's ANN path can serve. The
          previous implementation annotated a correlated `Subquery` onto the
          zPage queryset and then filtered and sorted on that annotation,
          which Postgres can serve with neither an index filter nor an index
          sort -- so it sequentially scanned every published zPage computing a
          1536-dimension cosine per row, on every article view.

        * `enable_seqscan = off` is belt to `related_ann_fetch`'s braces.
          PostgreSQL's cost model does not account for TOAST access, and a
          1536-`float4` vector is always out of line, so it prices a full scan
          of this table at its 137-page *main* heap when the scan actually
          touches ~12,000 buffers. On a 3,901-row fixture that mis-pricing put
          the flip point between "uses the index" and "reads every vector" at
          `LIMIT` 40-vs-60 -- a 12x difference in latency (1.2 ms / 486
          buffers against 15 ms / 12,067) decided by an estimate that is wrong
          by two orders of magnitude. `related_ann_fetch` is set below the
          flip so the plan is right without this, and this is set so it stays
          right if the estimate drifts.

          It is a cost penalty, not a prohibition: if the index is ever
          missing or invalid the planner still falls back to a scan rather
          than failing. Note it also does not *guarantee* an index scan -- at
          a few hundred rows the planner answers with a bitmap scan on the
          `content_type_id` btree instead -- which is why the fetch size, not
          this, is the primary lever.

        The `atomic()` is not decoration: `SET LOCAL` outside a transaction is
        a no-op with a warning, and `CONN_MAX_AGE` keeps connections alive
        across requests, so a plain `SET` would follow this connection into
        every later request it serves.
        """
        neighbors = self._related_neighbor_queryset(
            content_type, vector, exclude_pk, fetch=fetch,
        )
        with transaction.atomic():
            previous = self._apply_ann_session_settings()
            rows = list(neighbors)
            self._restore_ann_session_settings(previous)

        within_ceiling = [
            (object_id, dist) for object_id, dist in rows
            if dist is not None and dist <= self.related_max_distance
        ]
        return within_ceiling, len(rows)

    def _visible_related(self, page, neighbors):
        """The ANN neighbours that a reader may actually see, in ANN order.

        `neighbors` is ordered nearest-first; re-impose that order in SQL with
        a `CASE` so the `LIMIT` -- and therefore `_decorate_related`'s
        prefetches -- still touch only `related_limit` rows.
        """
        if not neighbors:
            return []
        rank = Case(*[
            When(pk=object_id, then=position)
            for position, (object_id, _) in enumerate(neighbors)
        ], output_field=models.IntegerField())
        return list(self._decorate_related(
            self._related_candidates(page).filter(
                pk__in=[object_id for object_id, _ in neighbors]
            ).annotate(rank=rank).order_by('rank')
        )[:self.related_limit])

    def _decorate_related(self, q):
        # Same select/prefetch/annotate treatment as the list action so
        # zPageListSerializer stays cheap and serves truncated content.
        return q.select_related(
            "creator", "featured_image"
        ).prefetch_related(
            'tags', 'featured_image__webp',
            'creator__avatar_image__webp',
            'featured_image__variants',
            'creator__avatar_image__variants',
            localized_list_translation_prefetch(viewer_id=None),
            *feed_variant_prefetch(source_length=255, viewer_id=None),
        ).annotate(
            truncated_content=ContentExcerpt(
                models.F('content'), length=255
            ),
            publication_order=Coalesce(
                F('published_at'), F('created_at')
            ),
        )

    @extend_schema(
        operation_id='zpage_related_list',
        parameters=[ZPAGE_LANGUAGE_PARAMETER, ZPAGE_MINE_PARAMETER],
        responses=zPageListSerializer(many=True),
        description=(
            "Up to 6 published, public zPages related to this page, "
            "ranked by pgvector cosine similarity over the stored "
            "search-index embeddings (no OpenAI call at request time). "
            "If the page has no embedding, or no neighbors are within "
            "the similarity ceiling, falls back to the author's most "
            "recent published pages. Unpaginated array; no auth required. "
            "An authenticated owner may set `mine=true` to receive the same "
            "owner-only representation used by private reads; it never adds "
            "draft pages to the related set. Anonymous `mine=true` is 403."
        ),
    )
    @action(detail=True, methods=['get'], url_path='related',
            permission_classes=[AllowAny],
            filter_backends=[], pagination_class=None)
    def related(self, request: Request, pk=None) -> Response:
        if _query_flag(request, 'mine') and request.user.is_anonymous:
            raise exceptions.NotAuthenticated
        normalize_zpage_language(
            request.query_params.get("lang"), allow_missing=True
        )
        page = self._get_by_identifier(
            zPage.objects.published_and_active(), pk
        )
        if page is None:
            raise http.Http404

        content_type = ContentType.objects.get_for_model(zPage)
        index = SearchIndex.objects.filter(
            content_type=content_type, object_id=page.pk,
        ).first()

        pages = []
        if index is not None:
            # Ask the ANN index for the nearest embeddings first, then apply
            # the visibility filters to that short list — not the other way
            # round. Ordering by distance and cutting at
            # `related_max_distance` are the same two operations as before, so
            # the ceiling still means what it meant: the best `related_limit`
            # neighbours that are within it. Pages with no `SearchIndex` row
            # were excluded before by `Coalesce(..., 1.0) > 0.8`; now they are
            # simply absent from the index, which is the same outcome.
            neighbors, examined = self._related_neighbors(
                content_type, index.vector, page.pk,
            )
            pages = self._visible_related(page, neighbors)

            # Ranking the index before applying the visibility filters is
            # what makes this fast, and the price is that a run of ineligible
            # neighbours -- a published page with no title, an index row the
            # unpublish sweep has not caught up with -- can push a good one
            # past the cut-off. Widen once when that is possible.
            #
            # "Possible" is `len(neighbors) == examined`: the distance ceiling
            # rejected nothing, so the list ended where the index stopped
            # handing rows over rather than where the neighbours stopped being
            # close enough. If the ceiling DID cut it, everything further out
            # is further away still and a wider fetch cannot contain anything
            # eligible. Deliberately not "the first pass returned exactly
            # `related_ann_fetch` rows": an HNSW scan can hand back fewer than
            # its LIMIT (rows its post-filter or MVCC drops), and that is a
            # case where widening helps rather than one where it is pointless.
            if (
                len(pages) < self.related_limit
                and examined
                and len(neighbors) == examined
            ):
                neighbors, _examined = self._related_neighbors(
                    content_type, index.vector, page.pk,
                    fetch=self.related_ann_fetch_max,
                )
                pages = self._visible_related(page, neighbors)

        if not pages:
            # Fallback: page has no embedding yet (or no neighbors
            # within the ceiling) — most recent published pages by
            # the same author.
            pages = list(self._decorate_related(
                self._related_candidates(page).filter(
                    creator=page.creator
                )
            ).order_by('-publication_order', '-id')[:self.related_limit])

        serializer = self.get_serializer(pages, many=True)
        return Response(serializer.data)

    @staticmethod
    def _write_response_data(serializer):
        """A write answers with the representation a read does.

        ``zPageUpdateSerializer`` has to take ``featured_image`` as an upload
        PRIMARY KEY -- that is how a client points an article at its cover --
        but rendering the response with that same serializer answered
        ``"featured_image": 123`` (and the page's raw ``p2paddr``) where every
        read answers ``{"id": 123, "url":...}`` (and the effective address,
        falling back to the creator's). The editor stores the write response
        as the article and later compares it with a fresh read to decide
        whether shared settings "changed elsewhere", so every covered article
        reported a conflict that did not exist and paused saving.

        Same serializer the read routes use, same context the write already
        resolved (``?lang=`` / the variant path language, owner-visible
        drafts), so the body is a drop-in replacement for the matching GET --
        the contract  pinned for ``/api/auth/user/``. The request
        contract is unchanged: ids in, ownership enforced by the update
        serializer.
        """
        return zPageDetailSerializer(
            serializer.instance, context=serializer.context,
        ).data

    def create(self, request: Request) -> Response:
        if request.user.is_anonymous:
            raise exceptions.PermissionDenied

        #an optional Idempotency-Key makes a timed-out create
        # reconcilable instead of duplicable. Absent header = the historical
        # behaviour exactly (every POST mints a page).
        key, key_error = _required_page_key(request)
        if key_error is not None:
            return key_error
        if key is None:
            return self._create_page(request)
        return self._create_page_idempotently(request, key)

    def _create_page_idempotently(self, request: Request, key: str) -> Response:
        """Claim, create and record the receipt in ONE savepoint.

        There is no money to bracket, so -- unlike the 2Z routes, which commit
        the claim first -- the claim lives in the same transaction as the page
        it describes (AtomicMiddleware's request transaction; this block is a
        savepoint inside it). Two consequences, both deliberate:

        * An unfinished claim is never visible to anyone. A concurrent retry
          under the same key blocks on the unique index until the original
          commits (then replays it) or rolls back (then creates). So a create
          can neither duplicate nor answer ``request_in_progress``.
        * Any failure -- a 400, the second-page 402, a vanity collision, a
          500 -- rolls the claim
          back with the page. A refused create does not spend the key.

        Checked BEFORE the "need 1 2Z for another page" rule, on purpose:
        the replay of a committed create must not be refused because that
        very create now counts as the creator's first page.
        """
        request_hash = idempotency.fingerprint(
            {"action": ZPAGE_CREATE_SCOPE, "body": _fingerprintable(request.data)}
        )
        try:
            with transaction.atomic():
                claim = idempotency.claim(
                    ZPAGE_CREATE_SCOPE,
                    request.user,
                    key,
                    request_hash=request_hash,
                )
                response = self._create_page(request)
                if response.status_code != status.HTTP_201_CREATED:
                    # Leave the savepoint by exception so the claim (and a
                    # half-written page, e.g. a vanity IntegrityError) rolls
                    # back; the response itself is returned unchanged below.
                    raise _CreateNotCommitted(response)
                # The page's public, immutable identity -- not a snapshot of
                # its body, so a replay answers with the page as it is now --
                # plus the validator it was CREATED with (see the replay).
                claim.finish(
                    status.HTTP_201_CREATED,
                    {
                        "free2zaddr": response.data["free2zaddr"],
                        "etag": response["ETag"],
                    },
                )
        except _CreateNotCommitted as refused:
            return refused.response
        except idempotency.IdempotencyConflict as conflict:
            return Response(
                {
                    "code": "idempotency_mismatch",
                    "error": (
                        "This Idempotency-Key was already used to create a "
                        "page from a different request body. Nothing was "
                        "created; use a new key for a new page."
                    ),
                    "key_resolved": (
                        conflict.record.response_status is not None
                    ),
                },
                status=status.HTTP_409_CONFLICT,
            )
        except idempotency.DuplicateRequest as duplicate:
            return self._replay_created_page(request, duplicate.record)
        return response

    def _replay_created_page(self, request: Request, record) -> Response:
        """The page an earlier request under this key created, as it is NOW."""
        if record.response_status is None:
            # Unreachable for this scope (claims only ever commit finished),
            # kept so a future change there cannot become a second page.
            return Response(
                {
                    "code": "request_in_progress",
                    "error": "The original request is still in progress.",
                    "key_resolved": False,
                },
                status=status.HTTP_409_CONFLICT,
            )
        body = record.response_body
        address = body.get("free2zaddr") if isinstance(body, dict) else None
        instance = (
            zPage.objects.filter(
                free2zaddr=address, creator=request.user,
            ).first()
            if isinstance(address, str) else None
        )
        if instance is None:
            # The key DID create a page, which has since been deleted. A retry
            # must not quietly resurrect it as a new one.
            return Response(
                {
                    "code": "idempotency_page_gone",
                    "error": (
                        "This page was already created once and has since "
                        "been deleted, so it was not created again. Save "
                        "again to create it as a new page."
                    ),
                    "key_resolved": True,
                },
                status=status.HTTP_409_CONFLICT,
            )
        serializer = self.get_serializer(instance)
        response = Response(
            self._write_response_data(serializer),
            status=record.response_status,
        )
        # The validator of the page AS THIS KEY CREATED IT, not its current
        # one. The client replaying holds only the body it sent, so a later
        # `If-Match` with this value must 412 if anyone changed the page in
        # the meantime -- handing out the current validator would authorize
        # the stale draft to overwrite that change (codex review). Unchanged
        # since creation, the two are equal.
        stored_etag = body.get("etag") if isinstance(body, dict) else None
        response["ETag"] = (
            stored_etag if isinstance(stored_etag, str) and stored_etag
            else canonical_etag_from_db(zPage, instance.pk)
        )
        response[IDEMPOTENT_REPLAY_HEADER] = "true"
        return response

    def _create_page(self, request: Request) -> Response:
        # The first page is free; another one needs a balance of 1 2Z. This
        # is the platform's ordinary "not enough 2Z" answer: a 402 in
        # the `insufficient_funds` shape every client already reads. It used
        # to be a bare-string 400 that said "tuzi", a word no screen uses, and
        # offered no way forward -- a new creator retried it six times in two
        # minutes and left (alert, 2026-10-07).
        if (
            request.user.tuzis < NEW_PAGE_REQUIRED_BALANCE
            and request.user.zpage_set.count() > 0
        ):
            return Response(
                {
                    **ledger.insufficient_funds_payload(
                        request.user,
                        NEW_PAGE_REQUIRED_BALANCE,
                        action="page_create",
                    ),
                    "detail": NEW_PAGE_NEED_2Z_MESSAGE,
                },
                status=status.HTTP_402_PAYMENT_REQUIRED,
            )

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        free2zaddr = str(uuid.uuid4())
        vanity = serializer.validated_data.get("vanity", "")
        if not vanity:
            vanity = _fallback_zpage_vanity(
                serializer.validated_data.get("title", ""), free2zaddr,
            )

        try:
            instance = serializer.save(
                creator=self.request.user,
                free2zaddr=free2zaddr,
                vanity=vanity,
                is_verified=self.request.user.is_verified,
            )
        except IntegrityError as e:
            print(e)
            print("CREATE PAGE", request.data)
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data={"vanity": "The vanity URL must be unique!"}
            )

        # Side effects follow the state that was written, never the rendered
        # representation: `serializer.data` resolves a variant from the
        # `?lang=` query parameter, and a representation selector must not
        # decide whether fans are notified. A create writes canonical content
        # and a brand-new page has no translations, so the canonical publish
        # flag *is* the variant that was written.
        publish = instance.is_published
        response_data = self._write_response_data(serializer)
        if publish:
            self.publish_page(instance)

        response = Response(response_data, status=status.HTTP_201_CREATED)
        # The new article's validator. Without it, the editor that
        # just created a draft holds nothing for it and every save for the
        # rest of that session is unconditional -- so a second tab can open
        # that draft, edit it, and be overwritten in exactly the way this
        # feature exists to prevent. (codex adversarial review.)
        response["ETag"] = canonical_etag_from_db(zPage, instance.pk)
        return response

    def _stale_translation_editor_response(self, request, instance):
        """409 unless the caller can prove it knows the real source language.

        A capability check, not an optimistic-concurrency guard: it proves the
        client read this article's `source_language` from a backend that
        reports one, nothing about how long ago. A legacy article's source
        language is unknowable to an older client, so it cannot tell canonical
        content from a translation, and both writes on this route are
        destructive in that state — a PUT can overwrite the original as a
        "translation", a DELETE can throw one away. So both verbs fail closed
        rather than only the one that existed when the check was written. The
        cost is a page reload; the cost of skipping it is content nobody can
        get back. (Two concurrent up-to-date editors can still race each other
        on this route, exactly as they can on the PUT today; that wants a real
        `If-Match`/ETag precondition, which is its own change.)
        """
        if (
            not is_content_language(instance.source_language)
            and request.headers.get(TRANSLATION_SOURCE_LANGUAGE_HEADER)
            != instance.source_language
        ):
            return Response(
                {
                    "source_language": (
                        "Reload the editor before saving a translation for "
                        "this legacy article."
                    )
                },
                status=status.HTTP_409_CONFLICT,
            )
        return None

    def _variant_etag(self, page: zPage, language: str):
        """This language's validator, or ``None`` when it has no saved version."""
        return variant_etag(
            page,
            language,
            translation_model=ZPageTranslation,
            variant_model=ZPageVariant,
        )

    @transaction.atomic
    def _save_variant(
        self, request: Request, instance: zPage, language: str, *, partial: bool
    ) -> Response:
        """Write one language of a zPage. Shared by both routes.

        The variant routes ( §4.2) and the deprecated `/translations/`
        alias run *exactly* this code. An alias whose behavior has drifted from
        the thing it aliases is worse than no alias, because the client that
        migrates finds out in production.

        A write whose `language` equals the page's own `source_language` is a
        canonical write, not a translation: the serializer routes it to the
        `zPage` columns. That is what makes the source a variant like any other
        (§3.1) instead of a special case the client has to know about.
        """
        # The serializer's cap check is intentionally after validation: a bad
        # new PUT still reports its missing title/content as a 400, not a
        # misleading capacity conflict.  It must nevertheless receive the
        # locked, freshly-read parent, so a concurrent boundary write cannot
        # pass its count on a stale instance.
        instance = _lock_zpage_for_variant_write(instance)
        old_source_content = instance.content
        old_source_language = instance.source_language
        old_creator_id = instance.creator_id
        old_variant = None
        if language != instance.source_language:
            old_variant = ZPageTranslation.objects.filter(
                zpage=instance, language=language
            ).values("title", "description", "content", "is_published").first()
        match = None
        if (
            IF_MATCH_HEADER in request.headers
            or IF_NONE_MATCH_HEADER in request.headers
        ):
            # Under the parent lock, which is what serializes every variant
            # write for this page -- AI translation delivery takes the same
            # row lock -- so the state this compares against cannot move
            # between here and the save below. Gated on the headers so
            # an unconditional write does not pay for the two queries the
            # validator costs.
            current_etag, also_matches = variant_precondition(
                instance,
                language,
                translation_model=ZPageTranslation,
                variant_model=ZPageVariant,
                claimed_label=_claimed_source_language(request),
                writes_label=_write_sets_label(request, instance),
            )
            if IF_MATCH_HEADER in request.headers:
                match = check_if_match(request, current_etag, also_matches)
            # Create-only: `None` means no version of this language
            # exists in either row shape. RFC 9110 §13.2.2 evaluates it after
            # `If-Match`.
            check_if_none_match(request, current_etag)
        serializer = zPageUpdateSerializer(
            instance,
            data=request.data,
            partial=partial,
            context={
                "request": request,
                "translation_language": language,
                "include_drafts": True,
            },
        )
        serializer.is_valid(raise_exception=True)
        if matched_auto_tags(match):
            # A translation PUT writes `tags` onto the parent too; the same
            # stale echo must not erase AI tags it never saw.
            keep_unseen_auto_tags(serializer, instance)
        save_kwargs = {
            "creator": request.user,
            "is_verified": request.user.is_verified,
        }
        if language == instance.source_language:
            # A canonical write, so it can publish the page: same fallback as
            # the page PUT/PATCH.
            generated_vanity = _publication_fallback_vanity(
                serializer, instance,
            )
            if generated_vanity:
                save_kwargs["vanity"] = generated_vanity
        try:
            instance = serializer.save(**save_kwargs)
        except IntegrityError:
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data={"vanity": "The vanity URL must be unique!"},
            )

        if instance.content != old_source_content:
            record_authenticated_write(
                zpage_id=instance.pk,
                actor=request.user,
                action=ZPageMutationActor.SOURCE_CONTENT,
                state_digest=content_digest(instance.content),
            )
        if instance.source_language != old_source_language:
            record_authenticated_write(
                zpage_id=instance.pk,
                actor=request.user,
                action=ZPageMutationActor.SOURCE_LANGUAGE,
                language=instance.source_language or "",
                state_digest=instance.source_language or "",
            )
        if instance.creator_id != old_creator_id:
            record_authenticated_write(
                zpage_id=instance.pk,
                actor=request.user,
                action=ZPageMutationActor.OWNERSHIP_CHANGED,
                state_digest=instance.creator_id,
            )
        if language != instance.source_language:
            new_variant = ZPageTranslation.objects.filter(
                zpage=instance, language=language
            ).first()
            content_fields = ("title", "description", "content")
            old_content = tuple(
                old_variant.get(field) if old_variant else None
                for field in content_fields
            )
            new_content = tuple(
                getattr(new_variant, field) if new_variant else None
                for field in content_fields
            )
            if new_variant is not None and old_content != new_content:
                record_authenticated_write(
                    zpage_id=instance.pk,
                    actor=request.user,
                    action=ZPageMutationActor.VARIANT_CONTENT,
                    language=language,
                    state_digest=translation_digest(new_variant),
                )
            was_published = bool(old_variant and old_variant["is_published"])
            if (
                new_variant is not None
                and new_variant.is_published
                and (not was_published or old_content != new_content)
            ):
                # An edit to a translation that STAYS published also puts a
                # new state live, so it is recorded as a publication of that
                # state. A plain content row cannot vouch for publication: it
                # may be a draft edit that something untracked republished
                # afterwards (independent review of ).
                record_authenticated_write(
                    zpage_id=instance.pk,
                    actor=request.user,
                    action=ZPageMutationActor.VARIANT_PUBLISHED,
                    language=language,
                    state_digest=translation_digest(new_variant),
                )
            if (
                new_variant is not None
                and not new_variant.is_published
                and was_published
            ):
                record_authenticated_write(
                    zpage_id=instance.pk,
                    actor=request.user,
                    action=ZPageMutationActor.VARIANT_UNPUBLISHED,
                    language=language,
                    state_digest=translation_digest(new_variant),
                )

        # The written variant is the one named by the URL *path*, so read its
        # publish state back from the database rather than from the rendered
        # representation.
        if language == instance.source_language:
            variant_published = instance.is_published
        else:
            variant_published = ZPageTranslation.objects.filter(
                zpage=instance, language=language, is_published=True
            ).exists()
        response_data = self._write_response_data(serializer)
        if instance.is_published and variant_published:
            self.publish_page(instance)
        response = Response(response_data)
        response["ETag"] = self._variant_etag(instance, language)
        return response

    # DELETE is outside `AtomicMiddleware`'s verb set, so this opens its own
    # transaction: `select_for_update()` in autocommit raises rather than
    # locking, and an unlocked precondition guarantees nothing.
    @transaction.atomic
    def _delete_variant(self, instance: zPage, language: str) -> Response:
        """Remove one translation. Refuses the source variant ( §4.2).

        The source is the article. Deleting it through a variant route would
        mean "empty this page's title, description and body" -- a destructive
        act wearing the label of a cleanup, and unrecoverable. Delete the
        article itself, or relabel it, but this route will not do it.

        400 rather than 409 deliberately, and it matches the deprecated alias:
        there is no state in which `DELETE /variants/{source}/` becomes
        correct, so nothing about it is a conflict to be retried.
        """
        if IF_MATCH_HEADER in self.request.headers:
            # Only under a precondition, so an unconditional delete keeps the
            # exact lock profile it had before.
            instance = _lock_zpage_for_variant_write(instance)
            check_if_match(self.request, self._variant_etag(instance, language))
        if language == instance.source_language or ZPageVariant.objects.filter(
            zpage=instance, language=language, origin=ZPageVariant.SOURCE
        ).exists():
            return Response(
                {
                    "language": (
                        "This is the article's source language, not a "
                        "translation. Edit or delete the article itself."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        translation = ZPageTranslation.objects.filter(
            zpage=instance, language=language
        ).first()
        if translation is not None:
            # Instance delete (not queryset delete) so the post_delete receiver
            # in signals.py fires and re-indexes the page, dropping the removed
            # variant from search the same way unpublishing it does. The
            # receiver also removes the mirrored ZPageVariant row.
            translation.delete()
            record_authenticated_write(
                zpage_id=instance.pk,
                actor=self.request.user,
                action=ZPageMutationActor.VARIANT_DELETED,
                language=language,
            )
            return Response(status=status.HTTP_204_NO_CONTENT)

        # No legacy row, but possibly a mirror-only variant. That pairing
        # should not exist -- dual write always creates both -- yet a
        # hand-edited database, a half-applied M2 backfill, or (from P8) an AI
        # draft written straight into the variant table can produce one. It is
        # not an academic case: `validate_source_language` refuses a relabel
        # that collides with such a row, and its 409 tells the creator to
        # delete it. A remedy the API cannot perform is not a remedy.
        orphans = ZPageVariant.objects.filter(
            zpage=instance, language=language
        ).exclude(origin=ZPageVariant.SOURCE)
        if not orphans.exists():
            raise http.Http404
        orphans.delete()
        record_authenticated_write(
            zpage_id=instance.pk,
            actor=self.request.user,
            action=ZPageMutationActor.VARIANT_DELETED,
            language=language,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def _variant_include_drafts(self, request: Request, page: zPage) -> bool:
        # Keep this route compatible with editor bundles already open during
        # a rolling deploy. Before the published-only contract, those bundles
        # fetched an exact variant without `mine`; returning the owner's
        # existing draft here gives them its ETag instead of making the draft
        # look missing and allowing an unconditional replacement. The
        # per-instance owner check remains the authorization boundary, so the
        # compatibility path cannot expose another creator's draft.
        return bool(
            request.user.is_authenticated and request.user == page.creator
        )

    def _variant_exists(self, page: zPage, language: str, include_drafts: bool):
        """Whether this exact variant is visible to this caller.

        `GET /variants/{lang}/` is an *exact* addressing route, unlike
        `GET /api/zpage/{id}/?lang=`, which falls back to the source when the
        language is missing. A resource that silently returns some other
        resource cannot be used to answer "does this translation exist yet?",
        which is the question the translation manager asks before offering
        "Write" versus "Edit".

        Asks whichever table is the read authority ( M5). It has to be the
        same one ``resolve_zpage_variant`` will answer from a moment later: a
        404 gate that consults one shape while the renderer reads the other is
        how a route starts 404ing content it can see, or -- worse -- returns
        200 and renders the source under a language that has no variant.
        """
        if variant_reads_enabled():
            row = ZPageVariant.objects.filter(
                zpage=page, language=language
            ).first()
            if row is not None:
                return include_drafts or row.is_published
            if language != page.source_language:
                return False
            # No source variant, but the legacy columns still hold the
            # article -- a NULL `source_language` never gets one, and drift can
            # lose one. `resolve_zpage_variant` falls back to those columns
            # rather than blanking the page, so this gate has to agree, or the
            # route would 404 an article the very next request renders.
        if language == page.source_language:
            return include_drafts or page.is_published
        translation = ZPageTranslation.objects.filter(
            zpage=page, language=language
        ).first()
        if translation is None:
            return False
        return include_drafts or translation.is_published

    @extend_schema(
        operation_id="zpage_variants_list",
        parameters=[ZPAGE_ID_PATH_PARAMETER, ZPAGE_MINE_PARAMETER],
        responses=ZPageVariantSummarySerializer(many=True),
        description=(
            "Every language variant of this zPage with its real status"
            ". The source variant is first and carries "
            "`origin: \"source\"`; translations follow, sorted by tag. The "
            "owner sees their unpublished drafts, everyone else sees only "
            "published variants. Unpaginated array, no body content — fetch "
            "one variant to get its text."
        ),
    )
    @action(detail=True, methods=["get"], url_path="variants",
            filter_backends=[], pagination_class=None)
    def variant_list(self, request: Request, pk=None) -> Response:
        page = self.get_object()
        summaries = variant_summaries(
            page, include_drafts=self._variant_include_drafts(request, page)
        )
        return Response(self.get_serializer(summaries, many=True).data)

    @extend_schema(
        operation_id="zpage_variants_retrieve",
        parameters=[
            ZPAGE_ID_PATH_PARAMETER,
            VARIANT_LANGUAGE_PATH_PARAMETER,
            ZPAGE_MINE_PARAMETER,
        ],
        description=(
            "One language variant of a zPage. Unlike "
            "`GET /api/zpage/{id}/?lang=`, this does **not** fall back to the "
            "source variant: a language with no variant is a 404, so a client "
            "can use it to tell 'not translated yet' from 'translated'. A "
            "draft variant is visible to its owner only."
            " The response carries this variant's strong `ETag`; send it back "
            "as `If-Match` to make a write to this variant conditional"
            "."
        ),
    )
    # No `permission_classes` override, and that is the point. DRF applies one
    # set of `@action` initkwargs to the whole route, so an `AllowAny` here
    # would silently cover the PUT/PATCH/DELETE mapped onto this same path --
    # leaving anonymous writes rejected only incidentally, by `get_queryset`
    # raising NotAuthenticated. The viewset default,
    # `IsAuthenticatedOrReadOnly`, already means exactly what this route wants:
    # anyone may read, only an authenticated user may write.
    @action(detail=True, methods=["get"],
            url_path=r"variants/(?P<language>[^/.]+)",
            filter_backends=[], pagination_class=None)
    @transaction.atomic
    def variant_retrieve(
        self, request: Request, pk=None, language=None
    ) -> Response:
        language = normalize_zpage_language(language, allow_missing=False)
        page = self.get_object()
        # Variant writers (including AI delivery and admin) lock this parent.
        # Hold the same lock until BOTH the body and its validator are read:
        # otherwise an intervening save can pair old content with a new ETag,
        # authorizing a stale editor to overwrite content it has never seen.
        locked = _lock_zpage_for_variant_write(page)
        # The first lookup prefetched content before acquiring the lock. Repeat
        # visibility checks and all prefetches against the now-stable page.
        page = self.get_object()
        if page.pk != locked.pk:
            # A vanity can move while we wait; never serve an unlocked page.
            raise http.Http404
        include_drafts = self._variant_include_drafts(request, page)
        if not self._variant_exists(page, language, include_drafts):
            raise http.Http404
        serializer = zPageDetailSerializer(
            page,
            context={
                "request": request,
                "translation_language": language,
                "include_drafts": include_drafts,
            },
        )
        response = Response(serializer.data)
        response["ETag"] = self._variant_etag(page, language)
        return response

    @extend_schema(
        operation_id="zpage_variants_update",
        parameters=[
            ZPAGE_ID_PATH_PARAMETER,
            VARIANT_LANGUAGE_PATH_PARAMETER,
            IF_MATCH_PARAMETER,
            IF_NONE_MATCH_PARAMETER,
            TRANSLATION_SOURCE_LANGUAGE_PARAMETER,
        ],
        request=zPageUpdateSerializer,
        responses={
            200: zPageDetailSerializer,
            409: ConflictDetailSerializer,
            412: PreconditionFailedSerializer,
        },
        description=(
            "Create or replace one language variant. Owner only; "
            "a non-owner gets 404. Writing the page's own `source_language` "
            "updates the canonical article, so the source really is a variant "
            "like any other. Creating a variant requires `title` and "
            "`content`; send `If-None-Match: *` to create it only if nobody "
            "else has meanwhile (412 otherwise). Publishing a "
            f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE + 1}th translation "
            "returns 409; creating a "
            f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE + 1}th draft translation "
            "returns 409; edit an existing published translation, save a draft, "
            "or unpublish one instead."
        ),
    )
    @variant_retrieve.mapping.put
    def variant_update(
        self, request: Request, pk=None, language=None
    ) -> Response:
        language = normalize_zpage_language(language, allow_missing=False)
        return self._save_variant(
            request, self.get_object(), language, partial=False
        )

    @extend_schema(
        operation_id="zpage_variants_partial_update",
        parameters=[
            ZPAGE_ID_PATH_PARAMETER,
            VARIANT_LANGUAGE_PATH_PARAMETER,
            IF_MATCH_PARAMETER,
            IF_NONE_MATCH_PARAMETER,
            TRANSLATION_SOURCE_LANGUAGE_PARAMETER,
        ],
        request=zPageUpdateSerializer,
        responses={
            200: zPageDetailSerializer,
            409: ConflictDetailSerializer,
            412: PreconditionFailedSerializer,
        },
        description=(
            "Update part of one language variant — publish a draft, fix a "
            "title — without resending the body. Owner only. A "
            "PATCH cannot *create* a variant: title and content are required "
            "for that, so use PUT. Publishing a "
            f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE + 1}th translation "
            "returns 409; existing published translations, drafts and "
            "unpublishes remain valid."
        ),
    )
    @variant_retrieve.mapping.patch
    def variant_partial_update(
        self, request: Request, pk=None, language=None
    ) -> Response:
        language = normalize_zpage_language(language, allow_missing=False)
        return self._save_variant(
            request, self.get_object(), language, partial=True
        )

    @extend_schema(
        operation_id="zpage_variants_destroy",
        parameters=[
            ZPAGE_ID_PATH_PARAMETER,
            VARIANT_LANGUAGE_PATH_PARAMETER,
            IF_MATCH_PARAMETER,
        ],
        request=None,
        responses={204: None, 412: PreconditionFailedSerializer},
        description=(
            "Delete one translation variant. Owner only; a "
            "non-owner gets 404. The variant with `origin: \"source\"` is the "
            "article itself and is refused with 400 — delete or relabel the "
            "article instead. Deleting a variant that does not exist is 404."
        ),
    )
    @variant_retrieve.mapping.delete
    def variant_destroy(
        self, request: Request, pk=None, language=None
    ) -> Response:
        language = normalize_zpage_language(language, allow_missing=False)
        return self._delete_variant(self.get_object(), language)

    @extend_schema(
        parameters=[
            TRANSLATION_SOURCE_LANGUAGE_PARAMETER,
            IF_MATCH_PARAMETER,
            IF_NONE_MATCH_PARAMETER,
        ],
        request=zPageUpdateSerializer,
        responses={
            200: zPageDetailSerializer,
            409: ConflictDetailSerializer,
            412: PreconditionFailedSerializer,
        },
        deprecated=True,
        description=(
            "**Deprecated** — use `PUT /api/zpage/{id}/variants/{language}/`, "
            "which runs the same code and additionally accepts PATCH. Kept "
            "for one release because the deployed editor calls this path"
            ". It has the same "
            f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE}-published- and "
            f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE}-draft-"
            "translation ceilings."
        ),
    )
    @action(
        detail=True,
        methods=["put"],
        url_path=r"translations/(?P<language>[^/.]+)",
        permission_classes=[IsAuthenticated],
    )
    def translation(
        self, request: Request, pk=None, language=None
    ) -> Response:
        language = normalize_zpage_language(language, allow_missing=False)
        instance = self.get_object()
        conflict = self._stale_translation_editor_response(request, instance)
        if conflict is not None:
            return conflict
        return self._save_variant(request, instance, language, partial=False)

    @extend_schema(
        parameters=[TRANSLATION_SOURCE_LANGUAGE_PARAMETER, IF_MATCH_PARAMETER],
        request=None,
        responses={204: None, 412: PreconditionFailedSerializer},
        deprecated=True,
        description=(
            "**Deprecated** — use "
            "`DELETE /api/zpage/{id}/variants/{language}/`. Delete one "
            "translation variant of a zPage. Owner only. The page's own "
            "`source_language` is canonical content, not a translation, and "
            "is refused. Deleting a translation that does not exist is a 404. "
            "Like the PUT on this route, a legacy article whose source "
            "language is unsupported/undetermined requires the "
            "`X-Free2Z-Source-Language` precondition header so a stale editor "
            "cannot destroy a variant it may have mislabelled."
        ),
    )
    @translation.mapping.delete
    def destroy_translation(
        self, request: Request, pk=None, language=None
    ) -> Response:
        language = normalize_zpage_language(language, allow_missing=False)
        instance = self.get_object()
        conflict = self._stale_translation_editor_response(request, instance)
        if conflict is not None:
            return conflict
        return self._delete_variant(instance, language)

    def retrieve(self, request, *args, **kwargs):
        """The article, with the `ETag` a conditional write needs.

        The validator describes the *canonical* article even when `?lang=`
        rendered a translation into the body, and that is deliberate: the write
        on this URL always writes the canonical article (`?lang=` is a
        representation selector, ), so a validator for anything else would
        be a precondition on state this route cannot change. A translation
        editor reads and writes `/variants/{language}/`, which carries that
        language's own validator.
        """
        response = super().retrieve(request, *args, **kwargs)
        page = getattr(self, "_precondition_instance", None)
        if page is not None:
            response["ETag"] = canonical_etag(page)
        return response

    def get_object(self):
        # `retrieve` has no other handle on the instance super() resolved, and
        # resolving it twice would double the identifier lookup on the hottest
        # read path in the app.
        instance = super().get_object()
        self._precondition_instance = instance
        return instance

    def _lock_and_check_precondition(
        self, instance: zPage, claimed_label: str | None = None,
        *, write: bool = False,
    ) -> zPage:
        """Re-read the row under `FOR UPDATE`, then evaluate `If-Match`.

        Order matters and is the entire point. Comparing against the instance
        already in hand -- read before the lock -- leaves the window this issue
        is about: two requests both compare against the same pre-lock snapshot,
        both pass, and the second still overwrites the first.

        **Nothing happens at all without the header**, and that is deliberate:
        a request with no precondition takes exactly the queries and exactly
        the locks it took before, so no deployed client and no
        third-party API consumer changes behaviour or contention profile on
        the day this ships. The guarantee survives it -- a conditional writer
        holds the row lock across its own check and write, so an
        unconditional writer racing it blocks on that lock rather than
        slipping between the two.

        ``write=True`` (PUT/PATCH) also tolerates background changes the
        client cannot have seen and the write leaves alone -- a detector
        relabel  and auto-applied AI tags  -- and records which
        one matched on ``self._precondition_match``. A DELETE stays strict.
        """
        self._precondition_match = None
        if IF_MATCH_HEADER not in self.request.headers:
            return instance
        locked = lock_zpages_for_translation_write(instance.pk).get(instance.pk)
        if locked is None:
            raise http.Http404
        if not write:
            self._precondition_match = check_if_match(
                self.request, canonical_etag(locked))
            return locked
        # A detector relabel the client has not seen does not fail a write
        # that leaves the label alone, when the client says which label it
        # saw; a write that sets the label still needs an exact match.
        # `claimed_label` comes from the caller so a DELETE never reads it.
        self._precondition_match = check_if_match(
            self.request,
            *canonical_precondition(
                locked,
                claimed_label=claimed_label,
                writes_label=_write_sets_label(self.request, locked),
            ),
        )
        return locked

    # Before  `AtomicMiddleware` did not wrap DELETE, so this arrived in
    # autocommit and `select_for_update()` would have raised
    # `TransactionManagementError` rather than take a lock. The middleware
    # covers DELETE now; the decorator stays so the lock does not depend on
    # it. An unlocked precondition is worse than none: it reads as a
    # guarantee and is not one.
    # Wrapping the whole method rather than only the conditional branch also
    # puts a cascading delete and its `post_delete` receivers in one
    # transaction, which is where they belonged already.
    @transaction.atomic
    def destroy(self, request, *args, **kwargs):
        instance = self._lock_and_check_precondition(self.get_object())
        deleted_page_id = instance.pk
        try:
            # A savepoint, so a refusal leaves the outer transaction usable
            # whatever the collector had already issued.
            with transaction.atomic():
                self.perform_destroy(instance)
        except models.ProtectedError:
            # Legacy on-chain `Transaction`/`PageComment` rows `PROTECT` the
            # article. Before this, that was an unhandled 500 -- which the
            # creator's UI can only describe as "check your connection", and
            # which pages the site-wide 5xx alert -- for a refusal that is
            # correct and permanent.
            return Response(
                status=status.HTTP_409_CONFLICT,
                data={
                    "detail": (
                        "This page has on-chain payments or comments recorded "
                        "against it, so it cannot be deleted. You can "
                        "unpublish it instead."
                    ),
                },
            )
        record_authenticated_write(
            zpage_id=deleted_page_id,
            actor=request.user,
            action=ZPageMutationActor.PAGE_DELETED,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop('partial', False)
        instance = self._lock_and_check_precondition(
            self.get_object(),
            claimed_label=_claimed_source_language(request),
            write=True,
        )
        old_content = instance.content
        old_source_language = instance.source_language
        old_creator_id = instance.creator_id
        serializer = self.get_serializer(
            instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        if matched_auto_tags(self._precondition_match):
            # The client loaded the page before the blank-page tagger added
            # tags to it. Its `tags` echo its stale copy; saving them
            # would silently erase the AI tags. See `keep_unseen_auto_tags`.
            keep_unseen_auto_tags(serializer, instance)

        generated_vanity = _publication_fallback_vanity(serializer, instance)

        try:
            # instance = self.perform_update(serializer)
            save_kwargs = {
                "creator": self.request.user,
                "is_verified": self.request.user.is_verified,
            }
            if generated_vanity:
                save_kwargs["vanity"] = generated_vanity
            instance = serializer.save(**save_kwargs)
        except IntegrityError:
            print("UPDATE PAGE", request.data)
            return Response(
                status=status.HTTP_400_BAD_REQUEST,
                data={"vanity": "The vanity URL must be unique!"}
            )

        if instance.content != old_content:
            record_authenticated_write(
                zpage_id=instance.pk,
                actor=request.user,
                action=ZPageMutationActor.SOURCE_CONTENT,
                state_digest=content_digest(instance.content),
            )
        if instance.source_language != old_source_language:
            record_authenticated_write(
                zpage_id=instance.pk,
                actor=request.user,
                action=ZPageMutationActor.SOURCE_LANGUAGE,
                language=instance.source_language or "",
                state_digest=instance.source_language or "",
            )
        if instance.creator_id != old_creator_id:
            record_authenticated_write(
                zpage_id=instance.pk,
                actor=request.user,
                action=ZPageMutationActor.OWNERSHIP_CHANGED,
                state_digest=instance.creator_id,
            )

        # A canonical PUT/PATCH always writes the canonical page — the write
        # path deliberately ignores `?lang=` — so the publish side effect is
        # decided by the canonical publish flag alone. Reading it off
        # `serializer.data` instead let `?lang=fr` on an unpublished French
        # translation silently suppress fan events, describe/tag and the
        # PAGE_UPDATE broadcast (and the inverse force an unwanted republish).
        # See.
        publish = instance.is_published
        response_data = self._write_response_data(serializer)
        if publish:
            self.publish_page(instance)

        response = Response(response_data)
        # After every side effect, not before: `publish_page` and the
        # `post_save` receivers can still touch the row, and a validator that
        # described the row mid-save would 412 the client's *next* autosave
        # against a page nobody else edited.
        response["ETag"] = canonical_etag_from_db(zPage, instance.pk)
        return response

    def publish_page(self, instance: zPage):
        # Mention delivery is idempotent behind the first-publication marker;
        # calling it from every published save also covers direct publish and
        # keeps later edits/translations harmless. It reads the persisted
        # canonical page while holding its row lock.
        process_page_mentions(instance.pk)
        # Create Events for fans, describe, tag
        emit_page_update(instance)
