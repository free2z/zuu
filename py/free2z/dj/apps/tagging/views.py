from django.contrib.contenttypes.models import ContentType
from django.http import JsonResponse
from django.db.models import Count, IntegerField, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404

from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotAuthenticated, NotFound
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from drf_spectacular.utils import (
    OpenApiParameter, OpenApiResponse, extend_schema,
)

from taggit.models import Tag, TaggedItem

from dj.apps.g12f.models import zPage
from dj.apps.comments.models import Comment
from dj.apps.comments.visibility import scope_comments_to_visible_parents

from . import breadth
from .hubs import TAG_HUB_INDEX_MIN_PAGES, hub_payload
from .models import resolve_alias_terms
from .slugs import tags_for_hub_slug
from .services import decide_suggestions, pending_suggestions

#Bound on how many names one accept/dismiss request may carry. A page's
#pending list is a handful of chips; anything larger is a client bug or an
#attempt to make the server do unbounded work, and it is cheaper to say no.
MAX_DECISION_NAMES = 100

#The corpora `GET /api/tagging/autocomplete` can count. Anything else is a
#client error, not a 500.
TAG_CORPUS_TYPES = frozenset({'zpage', 'comment'})

#Bound on `selected_tags`. Every entry costs two alias lookups and, on a
#typed request, another M2M join on the corpus queryset -- on an AllowAny
#endpoint that is deliberately un-throttled because the SSR pod calls it, so
#an 8KB query string of one-character tags is thousands of preliminary
#SELECTs per request (codex review). Blank and duplicate entries are dropped
#BEFORE the cap applies, so the cap bounds real work rather than slots.
#CLAMPED rather than rejected: this
#parameter is a hint about what the caller has already chosen, and a real
#page carries a handful, so a nonsense value should widen the suggestions
#rather than break the editor's category control.
MAX_SELECTED_TAGS = 50

LEVEL_HELP = (
    "`broad` or `narrow`, derived from how many published zPages carry the "
    "tag — NOT a stored attribute (#1208). The boundary is a percentile of "
    "the corpus, so it means the same thing as the platform grows. Broad tags "
    "are browse vocabulary; narrow tags are what makes long-tail discovery "
    "and “more like this” work. Treat it as a display hint: two tags either "
    "side of the boundary are near-identical in frequency, and the boundary "
    "itself moves as the corpus does."
)


class TagSuggestionSerializer(serializers.Serializer):
    """One row of the autocomplete response.

    Declared for the schema only — the view builds plain dicts and returns a
    `JsonResponse`, so this never validates anything. It exists because the
    endpoint is the only enumeration of the tag vocabulary, and a client that
    cannot see its shape ends up hardcoding a vocabulary instead.
    """

    name = serializers.CharField(help_text="The tag, exactly as stored.")
    count = serializers.IntegerField(
        help_text=(
            "How many objects of the requested `type` carry the tag, under "
            "the caller's own visibility rules. Ordering is by this count "
            "descending, which is what makes the first page of results the "
            "platform's de facto popular tags."
        )
    )
    level = serializers.ChoiceField(
        choices=[breadth.BROAD, breadth.NARROW], help_text=LEVEL_HELP
    )


def _tag_usage(scope):
    """How many objects in ``scope`` carry the outer tag, as one subquery.

    Grouping on the tag id after correlating with ``OuterRef('pk')`` keeps
    each corpus's aggregate self-contained, so summing two of them never
    joins the two relations to each other. See the call site for why that
    matters on a public endpoint.
    """
    return Subquery(
        scope.filter(tags__pk=OuterRef('pk'))
        .order_by()
        .values('tags__pk')
        .annotate(used=Count('pk', distinct=True))
        .values('used')[:1],
        output_field=IntegerField(),
    )


# Public tag search behind the site-wide search box; also called by the
# SvelteKit SSR pod, so no anon throttle here.
@extend_schema(
    parameters=[
        OpenApiParameter(
            "query", str,
            description="Substring match on the tag name, case-insensitive.",
        ),
        OpenApiParameter(
            "type", str, enum=["zpage", "comment"],
            description=(
                "Which corpus the counts describe. Omit to count both — "
                "visible zPages plus visible comments — which is a rough "
                "popularity signal across the platform. Every mode applies "
                "the caller's own visibility rules: drafts, pages by "
                "deactivated creators, and comments on parents the caller "
                "cannot see are never counted. Any other value is a 400."
            ),
        ),
        OpenApiParameter(
            "username", str,
            description=(
                "Restrict to tags used by one creator. Requires `type`; "
                "without it the filter is ignored."
            ),
        ),
        OpenApiParameter(
            "mine", bool,
            description=(
                "For `type=zpage`, restrict counts to the authenticated "
                "caller's own zPages, including drafts. Anonymous callers "
                "are refused. When `username` is supplied too, it must "
                "match the caller's username (case-insensitive); a mismatch "
                "returns no rows."
            ),
        ),
        OpenApiParameter(
            "search", str,
            description=(
                "Free-text filter applied to the *tagged objects* before "
                "counting, so counts describe a search result rather than the "
                "whole corpus. Requires `type`."
            ),
        ),
        OpenApiParameter(
            "selected_tags", str,
            description=(
                "Comma-separated tags already chosen. They are excluded from "
                "the results, and — when `type` is given — the remaining "
                "counts are narrowed to objects carrying all of them, i.e. "
                "what can still be added. Without `type` the names are "
                "excluded but the counts are not narrowed. At most 50 entries "
                "are read; the rest are ignored."
            ),
        ),
        OpenApiParameter(
            "num_results", int,
            description=(
                "How many tags to return. Clamped to 1-100; a non-integer "
                "falls back to the default of 10."
            ),
        ),
    ],
    responses={200: TagSuggestionSerializer(many=True)},
    description=(
        "Tags in use on the platform, most-used first. The tag vocabulary is "
        "open (`django-taggit`): this endpoint enumerates what exists, it does "
        "not define what is allowed. Tags with a zero count are omitted. "
        "Public zPage counts include only published pages from active creators. "
        "For an authenticated owner's vocabulary, pass `type=zpage&mine=true`; "
        "that mode includes the caller's drafts."
    ),
)
@api_view(['GET'])
@permission_classes([AllowAny])
def autocomplete(request):
    query = request.query_params.get('query', '').strip()
    username = request.query_params.get('username', '').strip()
    search = request.query_params.get('search', '').strip()
    type = request.query_params.get('type', '').strip()
    mine = request.query_params.get('mine', '').strip().lower() == 'true'
    if type and type not in TAG_CORPUS_TYPES:
        # `?type=bogus` used to 500 on this AllowAny endpoint: no branch
        # annotated `count`, and the `count__gt=0` filter below then raised
        # FieldError. Say 400 and name the values, the way `mine` already does.
        return JsonResponse(
            {'detail': '`type` must be one of: '
                       + ', '.join(sorted(TAG_CORPUS_TYPES)) + '.'},
            status=400,
        )
    if mine and not request.user.is_authenticated:
        raise NotAuthenticated
    if mine and type != 'zpage':
        return JsonResponse(
            {'detail': '`mine` requires `type=zpage`.'},
            status=400,
        )
    # num_results becomes a queryset slice bound below. It arrives as a string
    # from the query string, and `queryset[:'5']` is a TypeError -> 500, so
    # coerce it and clamp to a sane range (a huge value would be an unbounded
    # public scan).
    try:
        num_results = int(request.query_params.get('num_results', 10))
    except (TypeError, ValueError):
        num_results = 10
    num_results = max(1, min(num_results, 100))
    selected_tags = request.query_params.get('selected_tags', '').strip()
    if selected_tags:
        # Discard blanks and duplicates BEFORE the cap, or the cap is worth
        # less than it looks: `selected_tags=,,,,...` filled all 50 slots with
        # empty strings, each still costing two alias lookups and an M2M join
        # (codex review). `dict.fromkeys` keeps the caller's order so the
        # narrowing below is deterministic.
        selected_tags = list(dict.fromkeys(
            name for name in (
                value.strip() for value in selected_tags.split(',')
            ) if name
        ))[:MAX_SELECTED_TAGS]

    tags = Tag.objects.all()

    if query:
        tags = tags.filter(name__icontains=query)

    if username and type == "comment":
        tags = tags.filter(comment__author__username__iexact=username)

    # zPages the caller may see. `mine=true` is an owner-only vocabulary;
    # combining it with a username is deliberately an intersection, so a
    # mismatched profile neither reads somebody else's pages nor returns the
    # caller's tags under another username. Otherwise: public autocomplete is
    # a discovery surface, and drafts or pages by deactivated creators must
    # never keep a tag alive here.
    if mine:
        zpage_scope = zPage.objects.filter(creator=request.user)
    else:
        zpage_scope = zPage.objects.published_and_active()
    # Only comments whose parent is visible to the caller — else tag
    # names/counts belonging solely to private conversations or hidden pages
    # leak through this public endpoint.
    comment_scope = scope_comments_to_visible_parents(
        Comment.objects.all(), request.user)

    # `username` and `search` narrow the OBJECTS, and both are documented as
    # requiring `type`; applying them to the untyped corpus below would be a
    # silent contract change on top of the visibility fix.
    if type == 'zpage':
        if username:
            zpage_scope = zpage_scope.filter(
                creator__username__iexact=username
            )
        if search:
            zpage_scope = zpage_scope.filter(
                Q(title__icontains=search) | Q(content__icontains=search)
            )
    if type == 'comment' and search:
        comment_scope = comment_scope.filter(
            Q(headline__icontains=search) | Q(content__icontains=search)
        )

    if selected_tags:
        # Excluding only the raw spellings contradicted the alias-resolved
        # narrowing below: selecting a variant spelling narrowed to
        # the canonical's corpus yet left that canonical listed as addable.
        # Exclude each selected term AND the canonical name it resolves to.
        # ONE memo across both loops below: each selected term is resolved once,
        # including any authoritative live-spelling scan.
        live_cache = {}
        selected_groups = [
            resolve_alias_terms(name, live_cache=live_cache)
            for name in selected_tags
        ]
        exclude_names = []
        for group in selected_groups:
            # Same widening as the corpus filter below: exclude EVERY
            # spelling of the group so a variant's rows can't resurface.
            exclude_names.extend(group)
        exclude_names = list(dict.fromkeys(exclude_names))
        # `iexact`, not `name__in`. An exact `IN` disagrees with the very
        # filter three lines down -- and with `?tags=` -- both of which match
        # case-insensitively, so a case-only spelling the alias table never
        # recorded (`pyThon` beside `Python` and `PYTHON`: one group, one
        # alias row) survived the exclusion and came back as an addable tag
        # that is already selected. Adding it writes a second spelling of a
        # tag the page already carries. Found by the codex adversarial review
        # of, which is also why `resolve_alias_terms` may take its
        # single-token fast path: every consumer now matches the way the
        # database groups these, rather than by string equality.
        exclusion = Q()
        for name in exclude_names:
            exclusion |= Q(name__iexact=name)
        tags = tags.exclude(exclusion)

        # Narrow the requested corpus to the objects carrying ALL selected
        # tags, so the remaining counts answer "what can still be added". Each
        # selected term resolves through its alias first  and narrows
        # with `__iexact`: exact matching here was a leak between the two read
        # paths — the zPage list has always filtered `?tags=`
        # case-insensitively, so autocomplete counts narrowed by "ZCASh"
        # described a smaller (or empty) corpus than the very list a click on
        # them would open.
        #
        # ONLY when a `type` was given, which is not tidiness. The untyped
        # branch has never narrowed -- it counted every tagged row -- and the
        # classic editor's category control
        # (ts/react/free2z/src/components/TagFilterMultiSelect.tsx, used by
        # EditPage.tsx with no `type` prop) sends `type=` empty WITH the page's
        # current tags. Narrowing there under public visibility would return an
        # empty corpus for anyone editing a DRAFT, and that MUI Autocomplete is
        # not `freeSolo`, so the creator could no longer add a category at all.
        # Classic is still the default UI for signed-in users. Caught by the
        # codex adversarial review, which also caught the claim that every
        # caller passes `type=zpage` being false. The selected names are still
        # EXCLUDED from the results on every branch, exactly as before.
        if type:
            # Each selected term WIDENS through its alias group ( and
            # its follow-up) with `__iexact`: redirecting to the canonical
            # made variant-carrying pages unreachable by ANY term and
            # desynced these counts from the zPage list endpoint.
            for group in selected_groups:
                if len(group) == 1:
                    condition = Q(tags__name__iexact=group[0])
                else:
                    condition = Q()
                    for name in group:
                        condition |= Q(tags__name__iexact=name)
                if type == 'zpage':
                    zpage_scope = zpage_scope.filter(condition)
                else:
                    comment_scope = comment_scope.filter(condition)

    if type == 'zpage':
        tags = tags.annotate(
            count=Count('zpage', distinct=True, filter=Q(zpage__in=zpage_scope))
        )
    elif type == 'comment':
        tags = tags.annotate(
            count=Count(
                'comment', distinct=True, filter=Q(comment__in=comment_scope)
            )
        )
    else:
        # No `type`: the union of the two corpora the caller may see, NOT a
        # raw `Count('taggit_taggeditem_items')` .
        #
        # That raw count was documented as ignoring visibility, and the doc
        # made it sound like a rounding error: a tag used only on a DRAFT or
        # only on a deactivated creator's page still appeared here — on an
        # AllowAny endpoint — with a non-zero count. Tag names are
        # author-written free text, so "a tag exists and is used twice" is a
        # real disclosure when the only objects carrying it are ones the
        # caller may not see. 's property is that deactivation takes a
        # creator's zPages off EVERY read path, and this was one.
        #
        # `taggit_taggeditem_items` also spans `openai.Conversation`, which
        # would have been a third corpus with its own `is_public` rule — but
        # that model declares a bare `TaggableManager()` whose `object_id` is
        # an INTEGER while its own primary key is a UUID, so `tags.add()`
        # there raises `integer out of range` and no such row can exist.
        # Reported separately rather than papered over here.
        #
        # Two counts summed rather than one over `taggit_taggeditem_items`
        # because the taggit through-table has no visibility to filter on;
        # each concrete relation does. A tag on both a zPage and a comment is
        # counted once per corpus, which is what "how many objects carry this
        # tag" means.
        #
        # CORRELATED SUBQUERIES, not two `Count(..., distinct=True)`
        # annotations on the same queryset (codex review). Those are two
        # reverse-relation JOINs in ONE query, so PostgreSQL builds the cross
        # product of each tag's zPages and its comments before the DISTINCT
        # counts collapse it: a tag on 3,000 pages and 20,000 comments is
        # ~60M intermediate rows for one request. This endpoint is public and
        # deliberately un-throttled (the SSR pod calls it), so that is a
        # handful of anonymous requests away from saturating the database.
        # Each subquery aggregates its own relation independently and returns
        # one number. `Coalesce(..., 0)` because a tag absent from a corpus
        # yields NULL, and NULL + n is NULL.
        tags = tags.annotate(
            count=(
                Coalesce(_tag_usage(zpage_scope), 0)
                + Coalesce(_tag_usage(comment_scope), 0)
            )
        )

    tags = tags.filter(count__gt=0)
    # `name` breaks count ties. Without it the ORDER BY is not a total order,
    # so PostgreSQL may return any of the tied rows for the `[:num_results]`
    # slice and two identical requests can disagree about which long-tail tag
    # made the cut — the classic unstable-sort-plus-LIMIT bug, and it bites
    # hardest exactly where every count is 1.
    tags = tags.order_by('-count', 'name')[:num_results]

    # One threshold lookup for the whole response, not one per row.
    # It is cached, and it is read AFTER the slice so an empty page costs
    # nothing extra.
    tag_list = []
    threshold = breadth.breadth_threshold() if tags else None
    for tag in tags:
        tag_list.append({
            'name': tag.name,
            'count': tag.count,
            'level': breadth.classify(tag.count, threshold),
        })
    return JsonResponse(tag_list, safe=False)


# ---------------------------------------------------------------------------
# AI tag suggestions for a zPage
#
# AI proposes; the creator disposes. The `zpage-tag` Deployment writes
# `TagSuggestion` rows instead of writing tags -- except onto a published page
# with zero tags, which it tags directly  -- and these two endpoints are
# how the editor sees and answers them. Nothing here can remove a creator's own
# tag: accept calls `tags.add()`, dismiss touches only the suggestion row.
# ---------------------------------------------------------------------------

class ZPageTagSuggestionSerializer(serializers.Serializer):
    """One pending AI suggestion, with the breadth signal  defines."""

    name = serializers.CharField(
        help_text="The proposed tag, exactly as it would be added."
    )
    count = serializers.IntegerField(
        help_text=(
            "How many published zPages already carry this tag. `0` means the "
            "suggestion would introduce it to the platform."
        )
    )
    level = serializers.ChoiceField(
        choices=[breadth.BROAD, breadth.NARROW], help_text=LEVEL_HELP
    )


class ZPageTagDecisionSerializer(serializers.Serializer):
    """Accept and/or dismiss pending suggestions.

    Both lists are optional and an empty request is a valid no-op. Names are
    matched case-insensitively against pending suggestions; a name with no
    pending match is ignored rather than rejected, because the alternative is
    failing a whole request over one chip the creator already answered in
    another tab.

    A name in both lists is **accepted** — the constructive outcome, and the
    only one that cannot silently lose a tag the creator asked for.
    """

    accept = serializers.ListField(
        child=serializers.CharField(max_length=100),
        required=False,
        allow_empty=True,
        max_length=MAX_DECISION_NAMES,
        help_text="Suggestions to add to the page's tags.",
    )
    dismiss = serializers.ListField(
        child=serializers.CharField(max_length=100),
        required=False,
        allow_empty=True,
        max_length=MAX_DECISION_NAMES,
        help_text=(
            "Suggestions to reject. A dismissal is permanent for that page: "
            "later AI passes will not propose the tag again."
        ),
    )


class ZPageTagDecisionResultSerializer(serializers.Serializer):
    accepted = serializers.ListField(
        child=serializers.CharField(),
        help_text="Suggestions that were added to the page.",
    )
    dismissed = serializers.ListField(
        child=serializers.CharField(),
        help_text="Suggestions that were rejected.",
    )
    tags = serializers.ListField(
        child=serializers.CharField(),
        help_text=(
            "The page's complete tag list after the decision — authoritative, "
            "so the editor never has to guess what it now holds."
        ),
    )
    suggestions = ZPageTagSuggestionSerializer(
        many=True, help_text="Whatever is still pending."
    )


def _owned_zpage(request, free2zaddr):
    """The caller's own page, or 404.

    404 and not 403, matching every other owner-scoped zPage route: whether
    somebody else's draft exists is not a fact this API hands out.
    """
    return get_object_or_404(
        zPage, free2zaddr=free2zaddr, creator=request.user
    )


def _suggestion_payload(zpage):
    """Pending suggestions decorated with corpus frequency and breadth.

    The counts are fetched in ONE grouped query for the whole list rather than
    per row — a page can carry a dozen suggestions and this endpoint is hit on
    every editor open.
    """
    suggestions = pending_suggestions(zpage)
    if not suggestions:
        return []

    names = [suggestion.name for suggestion in suggestions]
    content_type = ContentType.objects.get_for_model(zPage)
    counts = {
        row["tag__name"].casefold(): row["uses"]
        for row in (
            TaggedItem.objects
            .filter(
                content_type=content_type,
                tag__name__in=names,
                object_id__in=zPage.objects.published_and_active().values("pk"),
            )
            .values("tag__name")
            .annotate(uses=Count("id"))
        )
    }
    threshold = breadth.breadth_threshold()
    return [
        {
            "name": suggestion.name,
            "count": counts.get(suggestion.name_key, 0),
            "level": breadth.classify(
                counts.get(suggestion.name_key, 0), threshold),
        }
        for suggestion in suggestions
    ]


@extend_schema(
    responses={200: ZPageTagSuggestionSerializer(many=True)},
    description=(
        "Pending AI tag suggestions for one of your own zPages (#1207).\n\n"
        "Suggestions are produced asynchronously by the `zpage-tag` "
        "subscriber when a published page's content changes. On a page that "
        "already carries at least one tag they are **never** applied on their "
        "own — this endpoint plus a `POST` to the same path is the only way "
        "one becomes a tag. A published page with **zero** tags when the pass "
        "finishes has the pass's tags applied directly instead (#2194), so "
        "nothing is left pending for it. Tags the page already carries are "
        "filtered out, and a suggestion the creator has previously dismissed "
        "never reappears.\n\n"
        "Owner-only; any other caller gets **404**."
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def zpage_tag_suggestions(request, free2zaddr):
    zpage = _owned_zpage(request, free2zaddr)
    return Response(_suggestion_payload(zpage))


@extend_schema(
    request=ZPageTagDecisionSerializer,
    responses={200: ZPageTagDecisionResultSerializer},
    description=(
        "Accept or dismiss pending AI tag suggestions on your own zPage "
        "(#1207).\n\n"
        "Strictly additive: accepting adds tags, and **nothing on this route "
        "can remove a tag you wrote yourself** — dismissing marks the "
        "suggestion, never the tag. Dismissal is remembered per page, so a "
        "later AI pass will not propose the same tag again.\n\n"
        "The response carries the page's full tag list afterwards and "
        "whatever is still pending, so a client needs no follow-up read."
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def decide_zpage_tag_suggestions(request, free2zaddr):
    zpage = _owned_zpage(request, free2zaddr)
    serializer = ZPageTagDecisionSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    accepted, dismissed = decide_suggestions(
        zpage,
        accept=serializer.validated_data.get("accept", []),
        dismiss=serializer.validated_data.get("dismiss", []),
        user=request.user,
    )
    return Response(
        {
            "accepted": accepted,
            "dismissed": dismissed,
            "tags": list(zpage.tags.names()),
            "suggestions": _suggestion_payload(zpage),
        },
        status=status.HTTP_200_OK,
    )


# --- the tag hub -----------------------------------------------------------
#
# `/tag/<slug>`. Google reported a batch of `/search?tag=…` URLs under
# "Excluded by noindex tag", which is not a defect -- it is Google confirming
# it read a directive we set on purpose. The loss is that topic hubs that
# should rank do not exist at all: `/search` has no server-rendered results and
# declares `<link rel=canonical href="/search">` on every one of them, so
# dropping the `noindex` would have indexed nine copies of an empty search box.
#
# This endpoint owns only the part that needs the database's opinion: which
# tags a slug names, how much live content they cover, and whether that is
# enough to be worth indexing. The RESULTS come from `GET /api/zpage/` via
# `?hub_slug=`, so the hub inherits the list endpoint's visibility rules
# instead of re-deriving them -- which is the whole lesson of /,
# where seven of eight read paths each remembered `is_published` and forgot
# `creator__is_active`.


class TagHubSerializer(serializers.Serializer):
    """What `GET /api/tagging/hub/{slug}` answers.

    Declared for the schema and used to build the response, so a client can
    see the contract instead of guessing it. Deliberately carries no zPage
    rows: the hub's list is `GET /api/zpage/?hub_slug=…`, one paginated,
    already-audited surface rather than a second one that drifts. The slug
    filter resolves the complete hub component server-side; the serialized
    names list is only a bounded display sample.
    """

    slug = serializers.CharField(
        help_text=(
            "The canonical slug for this hub. When it differs from the slug "
            "in the request path, the request named an ALIASED spelling — "
            "including a still-live alias — and the caller should redirect "
            "(301) to this one. The response's `names` and `count` already "
            "cover the union, so the redirect does not strand alias pages."
        )
    )
    name = serializers.CharField(
        help_text=(
            "The spelling to display, exactly as stored: whichever of `names` "
            "the most published zPages actually carry."
        )
    )
    names = serializers.ListField(
        child=serializers.CharField(),
        help_text=(
            "Every tag name in this public hub, most-used first. Usually one. "
            "More than one means distinct tags collided on the slug, or a "
            "still-live alias belongs to the canonical tag — `t-shirts`, "
            "`t shirts` and `T/Shirts` all slug to `t-shirts`, while a "
            "casefold alias can slug differently. The hub browses their "
            "union. Use `GET /api/zpage/?hub_slug=` with the response's "
            "canonical `slug` to get the complete page set this `count` "
            "counts; `names` is display-only and bounded."
        )
    )
    count = serializers.IntegerField(
        help_text=(
            "Published zPages carrying any of `names`, from creators who have "
            "not been deactivated, counted across the WHOLE result set rather "
            "than one page of it."
        )
    )
    indexable = serializers.BooleanField(
        help_text=(
            "Whether this hub carries enough content to be worth indexing "
            f"(at least {TAG_HUB_INDEX_MIN_PAGES} pages). A false value is "
            "not an error: render the page, but declare `noindex, follow` and "
            "keep it out of the sitemap."
        )
    )


@extend_schema(
    operation_id='tagging_hub_retrieve',
    responses={
        200: TagHubSerializer,
        404: OpenApiResponse(
            description=(
                "No live content under this slug. Deliberately a 404 rather "
                "than a 200 with an empty list: an indexable URL with nothing "
                "on it is a soft-404 that costs sitewide quality, and a tag "
                "whose every page belongs to a deactivated creator must look "
                "exactly like a tag that never existed (#931, #1246). Also "
                "returned for a slug that is not in canonical form at all — "
                "`/tag/Zcash`, `/tag/a--b`, `/tag/..` — since none of those "
                "is a URL this platform emits."
            )
        ),
        503: OpenApiResponse(
            description=(
                "The alias graph exceeded the fixed public traversal bound; "
                "retry after reconciliation. No partial hub is returned."
            )
        ),
    },
    description=(
        "Resolve a `/tag/<slug>` hub: which tag names share the slug, how "
        "much published content they cover, and whether that is enough to be "
        "worth indexing. The pages themselves come from "
        "`GET /api/zpage/?hub_slug=`, which resolves the complete component "
        "server-side.\n\n"
        "The slug is lowercase, with every character that is not a Unicode "
        "letter, number or mark folded to `-`. The mapping is deliberately "
        "lossy, so distinct tags can share a slug; the hub browses their "
        "union rather than picking a winner, which is why `names` is a list."
    ),
)
@api_view(['GET'])
@permission_classes([AllowAny])
def tag_hub(request, slug):
    canonical_slug, tags = tags_for_hub_slug(slug)
    payload = hub_payload(canonical_slug, tags) if tags else None

    if payload is None:
        raise NotFound('No published pages carry this tag.')

    return Response(TagHubSerializer(payload).data, status=status.HTTP_200_OK)
