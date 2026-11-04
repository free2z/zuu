import unicodedata

import markdown2

from django.db import transaction
from django.utils import timezone
from django.utils.html import strip_tags
from django.utils.text import slugify

from drf_spectacular.utils import extend_schema_field
from rest_framework import exceptions, serializers, status
from rest_framework.permissions import SAFE_METHODS
from taggit.serializers import (TagListSerializerField,
                                TaggitSerializer)

from dj.apps.g12f.embedded_media import (
    EmbeddedMediaSerializer,
    embedded_media,
)
from dj.apps.g12f.models.comment import PageComment

from dj.apps.g12f.models import zPage, Creator, ZPageTranslation, ZPageVariant
from dj.apps.g12f.localization import (
    normalize_zpage_language, resolve_zpage_variant, variant_provenance,
)
from dj.apps.g12f.variants import stamp_translation_source_digest
from f2z import languages
from dj.apps.uploads.serializers import (
    FeaturedImageSerializer
)
from dj.apps.uploads.models import GenericFile


# Reserved sub-route names: a vanity equal to one of these would shadow a real
# page at /{username}/{vanity}. The site is mid-transition with BOTH UIs live, so
# this is the UNION of the direct sub-routes under /{username}/ in both:
#   * new SvelteKit UI: ts/svelte/free2z/src/routes/[username]/{dashboard,private,zpage}
#     (the dashboard sub-pages live at /{username}/dashboard/*, two segments deep,
#     so settings/billing/media/etc. can NOT be shadowed by a one-segment vanity)
#   * classic React UI (App.tsx): /{username}/zpage/:id, /{username}/private/:uuid,
#     and the live-stream types matched by /:username/:type
#     (broadcast, ppv, subscribers-only).
# New/changed vanities must not use these. Be conservative: when unsure, keep.
# TODO: once the classic React UI is retired, prune the classic-only live-stream
# entries (broadcast, ppv, subscribers-only). See.
RESERVED_VANITIES = [
    # Direct sub-routes in the new SvelteKit UI
    "dashboard",
    "private",
    "zpage",
    # Classic React live-stream types matched by /:username/:type
    "broadcast",
    "ppv",
    "subscribers-only",
    # Not routes -- stringified nothings. SvelteKit's
    # `[username]/[vanity]` answers 404 for these up front rather than asking
    # the API to resolve a value that is obviously a bug at the caller, and
    # `isNullishSlug` in ts/svelte/free2z/src/lib/zpage-slug.ts is the other
    # half of this pair. Reserving them on the WRITE path is what keeps the
    # two halves honest: the editor derives a vanity by slugifying the title,
    # so an article titled "Null" would otherwise mint a page whose only URL
    # the reader tier refuses to serve. Nothing live is affected -- verified
    # against production that `/api/zpage/null/` and `/api/zpage/undefined/`
    # both 404, so no existing page holds either.
    "null",
    "undefined",
]

VANITY_ASCII_ONLY_MESSAGE = (
    "Vanity URLs can only use the letters a-z, numbers and hyphens."
)


def _has_non_ascii_alphanumeric(value):
    """True when ``value`` holds a letter or digit ``slugify`` would DROP.

    Vanities are ASCII (owner decision;  is the history of
    non-Latin URLs breaking redirects). ``slugify`` without ``allow_unicode``
    silently deletes every non-ASCII character, so ``"مرحبا-hello"`` would
    become ``"hello"`` -- a URL the creator never typed. Accents are not that:
    NFKD splits ``é`` into ``e`` plus a combining mark, and the ``e`` survives,
    so ``café`` -> ``cafe`` is the normalization the field has always done.
    """
    return any(
        char.isalnum() and not char.isascii()
        for char in unicodedata.normalize("NFKD", value)
        if not unicodedata.combining(char)
    )


class SourceLanguageConflict(exceptions.APIException):
    """409 when relabelling the source would collide with a variant (§3.2).

    A 409 rather than a 400 because nothing about the *request* is malformed:
    ``source_language: "es"`` is a perfectly valid thing to ask for, and it
    will succeed the moment the Spanish translation is gone. That is the
    definition of a conflict with the current state of the resource, and it is
    what tells a client "retry after fixing the other resource" instead of
    "you sent garbage".

    Deliberately NOT a ``ValidationError``: DRF turns those into a 400 whatever
    the message says. Raised from a field validator, which DRF only intercepts
    for ``ValidationError``, so this propagates to the exception handler intact.
    Nothing has been written at validation time, so no ``ATOMIC_REQUESTS``
    transaction is left half-applied.
    """

    status_code = status.HTTP_409_CONFLICT
    default_detail = "That language already has a variant on this page."
    default_code = "source_language_conflict"


# How many distinct PUBLISHED translation languages one zPage may carry, its
# canonical source language excluded from the count.
#
# DERIVATION. This number is BRACKETED, not chosen. It has a floor and
# a ceiling, they are 21 apart, and both of them move -- which is exactly the
# structural bug  exists to close: a constant derived from the size of the
# sell list that does not move when the sell list moves. It was 64, sized in
#  as "above `TRANSLATABLE` (39 today) with headroom".  took
# TRANSLATABLE to 78 and nothing moved this, so a creator buying every language
# we advertise and price got a 409 on the 65th.
#
# FLOOR -- `len(f2z.languages.TRANSLATABLE)`, 79 today. A creator may buy every
# language we sell for one article. The source is excluded from this count and
# a source language need not itself be sellable (a page written in `nan`, or a
# legacy `und` row), so the worst case is the whole sell list, not one less.
#
# CEILING -- 99, and it is a HARD one. The sitemap renderer throws past
# `MAX_SITEMAP_ENTRIES` (50,000 URLs, the sitemap 0.9 protocol bound) and that
# throw 503s a whole sitemap child, taking up to 499 unrelated articles out of
# the sitemap with it. a published variant is its own `<loc>`, so
# one chunk of maximally-translated articles emits
# `SITEMAP_CHUNK_SIZE x (this + 1)` URLs -- 500 x 100 = 50,000 is the last
# value that fits, so this must stay <= 99. Past that it is `SITEMAP_CHUNK_SIZE`
# that has to come down, and that is a deliberate decision, not a constant bump.
#
# 96 sits inside that bracket with room for 17 more sellable languages. The
# whole bracket, including the cross-tier mirrors in
# `ts/svelte/free2z/src/lib/server/sitemap.ts`, is asserted in
# `dj/apps/g12f/test_language_derived_bounds.py` -- ONE place that goes red,
# naming what to re-derive, the next time the sell list grows.
MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE = 96
# The DRAFT working set. Same floor for the same reason: an AI
# translation always lands as a draft, so a creator buying the whole sell list
# for one article accumulates `len(TRANSLATABLE)` drafts before publishing any
# of them. Drafts never reach the sitemap, so the ceiling above does not bind
# them; it is held equal to the published cap because a draft the creator
# cannot publish is not a useful thing to have sold them.
MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE = 96
MAX_FUND_PAGE_AMOUNT = 2_147_483_647


class FundPageRequestSerializer(serializers.Serializer):
    """The request body for the zPage 2Z boost endpoint."""

    id = serializers.CharField(max_length=128)
    amount = serializers.IntegerField(
        min_value=1,
        max_value=MAX_FUND_PAGE_AMOUNT,
        help_text="Whole 2Z amount to transfer (maximum 2147483647).",
    )


class PublishedTranslationVariantLimitConflict(exceptions.APIException):
    """409 when publishing one more translation would exceed 's cap.

    This is a conflict with the page's current collection of published
    translations, not a malformed request: the same payload becomes valid
    after the creator unpublishes or deletes another translation.  Keep this
    an ``APIException`` rather than a ``ValidationError`` so DRF preserves the
    actionable 409 response instead of coercing it to a 400.
    """

    status_code = status.HTTP_409_CONFLICT
    default_detail = (
        "This page already has "
        f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} published translations. "
        "Unpublish or delete a published translation before publishing another."
    )
    default_code = "published_translation_variant_limit"


class DraftTranslationVariantLimitConflict(exceptions.APIException):
    """409 when creating one more draft translation would exceed 's cap.

    This is a conflict with the page's current working set of draft
    translations, not a malformed request: the same payload becomes valid
    after the creator deletes or publishes an existing draft translation.
    Keep this an ``APIException`` rather than a ``ValidationError`` so DRF
    preserves the actionable 409 response instead of coercing it to a 400.
    """

    status_code = status.HTTP_409_CONFLICT
    default_detail = (
        "This page already has "
        f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations. "
        "Delete or publish an existing draft translation before creating another."
    )
    default_code = "draft_translation_variant_limit"


def lock_zpages_for_translation_write(*page_ids):
    """Lock parent pages in one deterministic order for a translation write.

    The ceiling belongs to a whole page, so all managed writers must serialize
    on its parent row rather than on the individual translation they happen to
    touch.  Callers own the surrounding transaction: the API has its explicit
    ``@transaction.atomic`` block, while Django admin's ``changeform_view``
    opens one before form validation and keeps it through ``save_model()``.

    Admin can move a translation between pages, so it locks both its original
    and destination parents.  Ordering by primary key keeps reciprocal moves
    from acquiring the two locks in opposite orders.
    """
    ids = sorted({page_id for page_id in page_ids if page_id is not None})
    return {
        page.pk: page
        for page in (
            zPage.objects.select_for_update()
            .filter(pk__in=ids)
            .order_by("pk")
        )
    }


def published_translation_variant_count(page):
    """Count distinct published *translation* languages for ``page``.

    The source is deliberately excluded:  caps the variable number of
    translations that readers must fan out over, not the one canonical source
    variant every article has.  M5 reads ``ZPageVariant`` now, but the legacy
    ``ZPageTranslation`` shape still exists during the rollout.  A normal
    dual-write produces one row in each table for the same language, so SQL
    ``UNION`` (rather than adding two counts) is essential.  Conversely, an
    orphaned published row in either shape counts: it is reader-visible now or
    may be visible to a legacy reader during a rolling deploy.

    Call this only while the parent ``zPage`` row is locked.  The lock makes
    the count and the following translation write one serialization point for
    competing boundary publishes.
    """
    legacy_languages = (
        ZPageTranslation.objects.filter(
            zpage_id=page.pk, is_published=True,
        )
        .exclude(language=page.source_language)
        .order_by()
        .values_list("language", flat=True)
    )
    variant_languages = (
        ZPageVariant.objects.filter(
            zpage_id=page.pk, is_published=True,
        )
        .exclude(origin=ZPageVariant.SOURCE)
        .order_by()
        .values_list("language", flat=True)
    )
    return legacy_languages.union(variant_languages).count()


def enforce_published_translation_variant_limit(
    page, language, will_publish, *, replacing_translation=None,
):
    """Raise 409 only when this write adds a 65th published language.

    Editing an already-published translation is cardinality-neutral, as are
    draft writes and unpublishes.  Test membership across both tables for the
    same reason:func:`published_translation_variant_count` uses a union: a
    mirrored pair is one translation, while a published orphan must still
    prevent a new reader-visible language from being added.

    ``replacing_translation`` is the persisted legacy row an admin edit is
    about to replace.  A published row renamed within the same page frees its
    old counted language as it gains the new one, so it receives one count
    credit.  A move to another page receives no such credit: it is a new
    published language for the destination and must fit that page's ceiling.

    This is intentionally a guard for managed API/admin writes, not a claim
    that every ORM mutation is constrained.  A cross-row cardinality cannot be
    expressed by this change's ordinary database constraints; direct and bulk
    ORM writes remain trusted maintenance/drift paths that must be audited or
    reconciled separately.
    """
    if not will_publish or language == page.source_language:
        return

    already_published = (
        ZPageTranslation.objects.filter(
            zpage_id=page.pk, language=language, is_published=True,
        ).exists()
        or ZPageVariant.objects.filter(
            zpage_id=page.pk, language=language, is_published=True,
        ).exclude(origin=ZPageVariant.SOURCE).exists()
    )
    if already_published:
        return

    count = published_translation_variant_count(page)
    if (
        replacing_translation is not None
        and replacing_translation.zpage_id == page.pk
        and replacing_translation.is_published
        and replacing_translation.language != page.source_language
    ):
        # The old row is part of the union above and the legacy post-save
        # signal removes its mirror during this same transaction.  Credit it
        # only for an in-page rename; moving between pages cannot make room on
        # the destination.
        count -= 1

    if count >= MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE:
        raise PublishedTranslationVariantLimitConflict()


def draft_translation_variant_count(page):
    """Count distinct draft *translation* languages for ``page``.

    The source is deliberately excluded:  caps the working set of
    translations, not the canonical source variant.  Mirrored rows across
    ``ZPageTranslation`` and ``ZPageVariant`` are unified with SQL ``UNION``
    so dual-written rows count as one language.  An orphan draft row in
    either table counts.

    Call this only while the parent ``zPage`` row is locked.  The lock makes
    the count and the following translation write one serialization point for
    competing boundary draft writes.
    """
    legacy_languages = (
        ZPageTranslation.objects.filter(
            zpage_id=page.pk, is_published=False,
        )
        .exclude(language=page.source_language)
        .order_by()
        .values_list("language", flat=True)
    )
    variant_languages = (
        ZPageVariant.objects.filter(
            zpage_id=page.pk, is_published=False,
        )
        .exclude(origin=ZPageVariant.SOURCE)
        .order_by()
        .values_list("language", flat=True)
    )
    return legacy_languages.union(variant_languages).count()


def enforce_draft_translation_variant_limit(
    page, language, will_publish, *, replacing_translation=None,
):
    """Raise 409 only when this write adds a 65th draft translation language.

    Editing an already-existing draft translation is cardinality-neutral, as
    are published writes. Unpublishing an existing published translation adds
    a draft translation to the working set and must fit within the draft
    ceiling. Test membership across both tables so mirrored rows count as one
    translation, while a draft orphan still counts against the ceiling.

    ``replacing_translation`` is the persisted legacy row an admin edit is
    about to replace.  A draft row renamed within the same page frees its old
    counted language as it gains the new one, so it receives one count credit.
    A move to another page receives no such credit: it is a new draft language
    for the destination and must fit that page's ceiling.
    """
    if will_publish or language == page.source_language:
        return

    already_draft = (
        ZPageTranslation.objects.filter(
            zpage_id=page.pk, language=language, is_published=False,
        ).exists()
        or ZPageVariant.objects.filter(
            zpage_id=page.pk, language=language, is_published=False,
        ).exclude(origin=ZPageVariant.SOURCE).exists()
    )
    if already_draft:
        return

    count = draft_translation_variant_count(page)
    if (
        replacing_translation is not None
        and replacing_translation.zpage_id == page.pk
        and not replacing_translation.is_published
        and replacing_translation.language != page.source_language
    ):
        count -= 1

    if count >= MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE:
        raise DraftTranslationVariantLimitConflict()


def source_language_collision(page, language):
    """The variant already holding ``language``, or ``None``.

    Checks both shapes. ``ZPageTranslation`` is still the read authority until
    M5, but a variant row can exist without one (a future AI translation, or a
    legacy row a reconciler repaired), and silently overwriting either is the
    outcome §3.2 exists to prevent.
    """
    if ZPageTranslation.objects.filter(zpage=page, language=language).exists():
        return True
    return ZPageVariant.objects.filter(
        zpage=page, language=language
    ).exclude(origin=ZPageVariant.SOURCE).exists()


def source_language_conflict_detail(language):
    """The actionable message §3.2 asks for, in the creator's words.

    A localized language *name*, never a raw subtag: "A Spanish translation
    already exists" is a sentence a creator can act on; "a pt-BR variant
    conflicts" is a database error wearing a coat (finding 3).
    """
    name = languages.display_name(language, default=language)
    return (
        f"A {name} translation already exists on this page. Delete or merge "
        f"it before making {name} the source language."
    )


class ConflictDetailSerializer(serializers.Serializer):
    """The body DRF actually returns for a 409 on these routes.

    Declared because `409: None` -- "a 409 exists, with no body" -- is what
    the schema said first, and orval faithfully generated the error type as
    `void`. The message is the whole point of this status code: it names the
    language and tells the creator what to delete. A contract that hides it
    guarantees the UI shows "something went wrong" instead.
    """

    detail = serializers.CharField(
        read_only=True,
        help_text=(
            "Human-readable and actionable — show it to the creator verbatim "
            "rather than substituting a generic failure message."
        ),
    )


class ZPageCreateIdempotencyErrorSerializer(serializers.Serializer):
    """409 from POST /api/zpage/ when its Idempotency-Key cannot be honoured.

    ``code`` is the stable, machine-readable part; ``error`` is the
    sentence to show. Nothing was created in either case.
    """

    code = serializers.ChoiceField(
        choices=["idempotency_mismatch", "idempotency_page_gone"],
        read_only=True,
    )
    error = serializers.CharField(read_only=True)
    key_resolved = serializers.BooleanField(
        read_only=True,
        help_text=(
            "True when the request that spent this key has finished, so a "
            "fresh key is the right next step for a genuinely new page."
        ),
    )


class zPageDestroySerializer(serializers.ModelSerializer):
    class Meta:
        model = zPage
        fields = ['free2zaddr']
        read_only_fields = ['free2zaddr']


def representation_language(request):
    """Resolve the `?lang=` *representation* selector for a response body.

    `?lang=` never decides what is written  — it only picks which variant
    the response renders back. On a safe request an unusable value is a genuine
    client error, and the read endpoints reject it up front. On a write the row
    is already saved by the time the response is rendered, so a bad
    representation hint must degrade to the canonical variant rather than fail
    (or, worse, 400 while the write stays committed) a completed write.
    """
    if request is None:
        return None
    try:
        return normalize_zpage_language(
            request.query_params.get("lang"), allow_missing=True
        )
    except serializers.ValidationError:
        if request.method in SAFE_METHODS:
            raise
        return None


def negotiable_accept_language(request):
    """The ``Accept-Language`` header, but only where it may shape a response.

    Restricted to safe methods, and it is a real restriction rather than
    caution. On a write the response body describes the row that was just
    written; letting a header silently render some *other* language back is the
    same confusion `?lang=` on a write caused, one header further from
    the URL. A write answers with what it wrote, always.

    Negotiation never touches persistence on any method -- see
    :func:`representation_language` and ``_requested_language`` below, which are
    the only inputs to what gets stored.
    """
    if request is None or request.method not in SAFE_METHODS:
        return None
    return request.headers.get("Accept-Language")


class LocalizedZPageSerializerMixin(serializers.Serializer):
    """Overlay content fields and append language-resolution metadata."""

    requested_language = serializers.CharField(read_only=True)
    actual_language = serializers.CharField(read_only=True)
    fallback_used = serializers.BooleanField(read_only=True)
    available_languages = serializers.ListField(
        child=serializers.CharField(), read_only=True
    )
    variant_is_published = serializers.BooleanField(read_only=True)
    origin = serializers.ChoiceField(
        choices=ZPageVariant.ORIGIN_CHOICES,
        read_only=True,
        allow_null=True,
        help_text=(
            "Provenance of the variant this response rendered: `source` (the "
            "article itself), `human`, or `ai`. `null` means the variant rows "
            "were not loaded on this route -- unknown, never assume `human`."
        ),
    )
    is_stale = serializers.BooleanField(
        read_only=True,
        allow_null=True,
        help_text=(
            "Whether this translation was made from content the source has "
            "since changed. THREE states: `true` stale, `false` current, "
            "`null` unknown. `null` is the common case -- the source variant "
            "has nothing to be stale against, and no legacy translation "
            "recorded which revision it was made from. Render `null` as "
            "nothing at all: unknown source history cannot prove staleness."
        ),
    )

    def to_representation(self, instance):
        result = super().to_representation(instance)
        request = self.context.get("request") if hasattr(self, "context") else None
        requested = self.context.get("translation_language")
        if requested is None:
            requested = representation_language(request)
        include_drafts = bool(
            self.context.get("include_drafts")
            and request is not None
            and request.user.is_authenticated
            and request.user == instance.creator
        )
        variant = resolve_zpage_variant(
            instance, requested,
            include_drafts=include_drafts,
            accept_language=(
                None if requested else negotiable_accept_language(request)
            ),
        )
        localized_content = variant.content
        if getattr(self, "localized_content_summary", False):
            localized_content = variant.description or f"{variant.content[:365]}..."
            # Public list representations stay public even when the owner is
            # authenticated. The owner can opt into the private representation
            # with `mine=true`; otherwise a subscriber-only excerpt must not
            # change merely because the viewer owns the page.
            if instance.is_subscriber_only and not include_drafts:
                localized_content = "Subscribe for exclusive content"
        result.update({
            "title": variant.title,
            "description": variant.description,
            "content": (
                "Subscribe for exclusive content"
                if getattr(instance, "_redact_content", False)
                else localized_content
            ),
            "source_language": instance.source_language,
            "requested_language": variant.requested_language,
            "actual_language": variant.actual_language,
            "fallback_used": variant.fallback_used,
            "available_languages": variant.available_languages,
            "variant_is_published": variant.is_published,
            "origin": variant.origin,
            "is_stale": variant.is_stale,
        })
        return result


class zPageUpdateSerializer(
    LocalizedZPageSerializerMixin, TaggitSerializer, serializers.ModelSerializer
):

    featured_image = serializers.PrimaryKeyRelatedField(
        queryset=GenericFile.objects.none(), required=False, allow_null=True
    )
    tags = TagListSerializerField()
    # A plain CharField, NOT the model's SlugField. DRF runs a field's
    # own validators before `validate_vanity`, and the SlugField regex refused
    # `zebra6.4.1` or `Cool Stuff` with a generic "Enter a valid slug" before
    # the normalization below (which has always meant to turn them into
    # `zebra641` / `cool-stuff`) ever ran. `validate_vanity` is the one gate:
    # it normalizes what normalizes losslessly and refuses the rest with a
    # message that says why. It also re-implements the model's uniqueness
    # check (case-insensitively), so dropping the auto UniqueValidator loses
    # nothing; the column's unique constraint still closes the race.
    vanity = serializers.CharField(
        max_length=256,
        required=False,
        allow_blank=True,
        allow_null=True,
        help_text=(
            "Optional vanity URL segment. Normalized on write: lowercased, "
            "spaces become hyphens, punctuation and accents are dropped "
            "(`Café 6.4` becomes `cafe-64`). Letters or digits outside a-z/0-9 "
            "(Arabic, Korean, ...) are refused rather than silently dropped. "
            "At most 128 characters after normalization."
        ),
    )
    # Keep this a string in the combined request/response OpenAPI component.
    # The response may truthfully contain legacy-only `und`, while writes are
    # normalized by validate_source_language below. It was never an enum in
    # the schema and is even less of one now: §3.3 the accepted set
    # is "any real human language", which is ~8000 tags and not something to
    # publish as a list.
    source_language = serializers.CharField(
        required=False,
        help_text=(
            "BCP-47 language tag of the canonical title, description and "
            "content — any real human language (`en`, `de`, `ja`, `pt-PT`). "
            "Normalized on write (`pt` becomes `pt-BR`). Mutable. The "
            "legacy-only value `und` may appear in a response but cannot be "
            "written."
        ),
    )

    class Meta:
        model = zPage
        fields = (
            'free2zaddr',
            'vanity',
            'p2paddr',
            'title',
            'content',
            'is_published',
            'is_subscriber_only',
            'category',
            'f2z_score',
            'get_url',
            'featured_image',
            'tags',
            'publish_at',
            'description',
            'canonical_url',
            'source_language',
            'detected_language',
            'detection_confidence',
            'language_source',
            'requested_language',
            'actual_language',
            'fallback_used',
            'available_languages',
            'variant_is_published',
            'origin',
            'is_stale',
        )
        read_only_fields = [
            'free2zaddr', 'f2z_score', 'get_url',
            # Detector output, not client input ( §3.2). A creator changes
            # the *label* through `source_language`; what the model guessed and
            # how sure it was are ours to report, and letting a client write
            # them would let it forge the provenance that decides whether the
            # detector may overwrite the label later.
            'detected_language', 'detection_confidence', 'language_source',
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if hasattr(self, 'context') and 'request' in self.context:
            request = self.context['request']

            if request.user.is_anonymous:
                return
                # for some reason, this is called when listing
                # raise PermissionDenied(
                #     "Anonymous users cannot update this page.")

            self.fields['featured_image'].queryset = GenericFile.objects.filter(
                owner=request.user
            )

    def validate_featured_image(self, value):
        if value:
            if not value.mime_type.startswith('image/'):
                raise serializers.ValidationError(
                    "The featured image must have image mime_type")

            if value.access != "public":
                raise serializers.ValidationError(
                    "The featured image must have access set to 'public'")

        return value

    def validate_source_language(self, value):
        """The article's language label. Mutable §3.2.

        It used to be write-once, which is the root of the §1.1 trap: the
        dropdown could not mean "this article is English", so it could only
        mean "start a new, empty English translation", and the editor blanked
        itself. Nothing about a *label* should be irreversible.

        The one thing that is still refused is a collision. Relabelling the
        source into a language that already has a translation would leave two
        rows claiming the same language for the same page -- the source would
        shadow the translation in resolution, and after M5 it violates
        ``uniq_zpage_variant_language`` outright.  §3.2 specifies a **409**
        with an actionable message, and P6 gives it one: see
        :class:`SourceLanguageConflict`. Never a silent overwrite, on any path.

        The relabel itself -- the source variant's ``language`` and the
        denormalized ``zPage.source_language`` -- lands in one transaction:
        ``update()`` below is ``@transaction.atomic``, and the dual-write
        receiver that renames the source variant runs inside the same
        ``save()``.
        """
        value = normalize_zpage_language(value, allow_missing=False)
        if self.instance and value != self.instance.source_language:
            if source_language_collision(self.instance, value):
                raise SourceLanguageConflict(
                    source_language_conflict_detail(value)
                )
        return value

    def _requested_language(self, attrs):
        translation_language = self.context.get("translation_language")
        if translation_language is not None:
            return normalize_zpage_language(
                translation_language, allow_missing=False
            )
        if self.instance is None:
            # A URL never dictates what goes in the database. `?lang=`
            # is the reader's representation selector on every other route, so
            # it must not brand a new article with a permanently immutable
            # source_language — nor fail the create when the caller's UI locale
            # is outside our four content languages. The language of new
            # content comes from the request body alone, and stays optional:
            # clients predating language support cannot truthfully tell us what
            # they wrote, so preserve that uncertainty as `und` rather than
            # invent an answer from the query string.
            return attrs.get("source_language")
        # Canonical writes never infer translation intent from a query string.
        # Translation writes use the owner-only nested endpoint, which supplies
        # translation_language in serializer context. Old backends therefore
        # 404 that route instead of accepting translated text as canonical.
        return None

    def create(self, validated_data):
        requested = self._requested_language(validated_data)
        validated_data["source_language"] = requested or "und"
        return super().create(validated_data)

    def validate(self, attrs):
        """Keep a page's publication state and schedule consistent.

        ``publish_at`` is a schedule for an unpublished canonical page, not a
        second publication timestamp. The editor sends both fields on every
        save, so an immediate publish clears any stale schedule. Translation
        writes are excluded because only the canonical page owns a schedule.
        """
        attrs = super().validate(attrs)

        if self.context.get("translation_language") is not None:
            return attrs

        is_published = attrs.get(
            "is_published",
            self.instance.is_published if self.instance is not None else False,
        )
        publish_at = attrs.get(
            "publish_at",
            self.instance.publish_at if self.instance is not None else None,
        )

        if is_published:
            # Publishing early (or publishing a page sent with a stale
            # schedule) always wins and removes the pending schedule.
            attrs["publish_at"] = None
        elif publish_at is not None and publish_at <= timezone.now():
            raise serializers.ValidationError({
                "publish_at": "Choose a future time to schedule this page.",
            })

        return attrs

    @transaction.atomic
    def update(self, instance, validated_data):
        requested = self._requested_language(validated_data)
        if requested is None or requested == instance.source_language:
            # Omitted lang is the legacy canonical update path.
            return super().update(instance, validated_data)

        if "source_language" in validated_data:
            validated_data.pop("source_language")

        # Scheduling belongs to the canonical page. Translation variants have
        # independent draft/published state but no scheduling column, so never
        # let a translated PUT mutate (or accidentally re-arm) the source page.
        validated_data.pop("publish_at", None)

        localized = {
            field: validated_data.pop(field)
            for field in ("title", "content", "description", "is_published")
            if field in validated_data
        }
        existing = ZPageTranslation.objects.filter(
            zpage=instance, language=requested
        ).first()
        if "title" not in localized or "content" not in localized:
            if existing is None:
                raise serializers.ValidationError({
                    "lang": "A new translation requires title and content."
                })
        tags = validated_data.get("tags", serializers.empty)
        parent_changed = tags is not serializers.empty and set(tags) != set(
            instance.tags.names()
        )
        for field, value in validated_data.items():
            if field == "tags":
                continue
            if field == "featured_image":
                current_value = instance.featured_image_id
                value = value.pk if value is not None else None
            else:
                current_value = getattr(instance, field)
            if current_value != value:
                parent_changed = True
                break

        translation_will_publish = localized.get(
            "is_published", existing.is_published if existing else False
        )
        enforce_published_translation_variant_limit(
            instance, requested, translation_will_publish
        )
        enforce_draft_translation_variant_limit(
            instance, requested, translation_will_publish
        )
        if parent_changed:
            # A published translation's signal is the single reindex enqueue.
            # For a draft, leave the parent signal enabled so a genuine shared
            # metadata change still refreshes the canonical search document.
            if translation_will_publish:
                instance._skip_zpage_async_side_effects = True
            try:
                instance = super().update(instance, validated_data)
            finally:
                if translation_will_publish:
                    del instance._skip_zpage_async_side_effects
        written, _ = ZPageTranslation.objects.update_or_create(
            zpage=instance,
            language=requested,
            defaults=localized,
        )
        #record WHICH source revision a human translation was saved
        # against. The paid AI delivery already records the generation digest;
        # a later creator edit cannot prove that the generated text absorbed
        # newer source changes, so the stamper only updates human-origin rows.
        # It runs after the upsert because the M3 mirror fires from the
        # upsert's `post_save` signal.
        #
        # ONLY when the translated BODY actually changed, and that condition is
        # the whole correctness of the feature. Two findings shaped it, both
        # from the codex adversarial review:
        #
        # 1. A save that changes no text at all is not evidence of anything. A
        #    creator publishing an untouched Spanish draft -- a PATCH carrying
        #    nothing but `is_published` -- would otherwise stamp the CURRENT
        #    English digest onto a translation of the PREVIOUS English, and
        #    genuinely stale text would go public labelled fresh. Autosave makes
        #    that the common case, not the exotic one: the editor resends the
        #    whole object on every pause.
        # 2. `content`, not title or description, and it is the same asymmetry
        #    `variants.content_digest` already encodes on the other side --
        #    `source_digest` hashes the article's BODY only, so that retitling
        #    an article does not stale every translation of it. The mirror image
        #    has to hold: fixing a typo in the translated TITLE is not evidence
        #    that a rewritten source body was incorporated, and clearing a true
        #    "Stale" on that basis is a false negative on a badge whose entire
        #     design rule is that it must not lie.
        #
        # For human-origin rows, this still cannot know whether a body edit
        # ACTUALLY absorbed the source's changes -- nothing on disk can. The
        # current digest is the strongest claim available;  §1 asks for
        # the capability, not for a proof. AI rows keep the delivery digest.
        if existing is None or existing.content != written.content:
            stamp_translation_source_digest(instance, requested)
        # Ensure response resolution sees the newly saved row.
        getattr(instance, "_prefetched_objects_cache", {}).pop(
            "translations", None
        )
        return instance

    def validate_vanity(self, value):
        # empty is a choice
        if not value:
            return value

        # Untouched: a save that does not change the vanity must not rewrite
        # it ( §3). Clients PUT/PATCH the whole object back, so without
        # this an edit to the TITLE of a legacy `CoolStuff` page would
        # normalize it to `coolstuff` and move the page's canonical URL — a
        # persisted change nobody asked for, as a side effect of an unrelated
        # write. Same principle as "a URL never dictates what goes in the
        # database": only what the user actually changed gets written.
        # This comparison must happen BEFORE slugify, because after it a
        # legacy value never equals the value the client echoed back.
        if self.instance and value == self.instance.vanity:
            return value

        # Refuse, don't rewrite: slugify would delete these characters and
        # store a URL the creator never typed. The editor no longer
        # derives such a vanity from a non-Latin title, so this only fires for
        # a value somebody actually typed -- and they need to be told.
        if _has_non_ascii_alphanumeric(value):
            raise serializers.ValidationError(VANITY_ASCII_ONLY_MESSAGE)

        value = slugify(value)
        if not value:
            raise serializers.ValidationError(
                "Vanity must contain letters or numbers."
            )
        # Already canonical and unchanged (e.g. `CoolStuff` echoed at a page
        # whose stored vanity is already `coolstuff`): nothing to validate.
        if self.instance and value == self.instance.vanity:
            return value

        # it would shadow a real sub-route under /{username}/ in the new UI
        if value in RESERVED_VANITIES:
            raise serializers.ValidationError(
                "Vanity is a system reserved name, please choose another!")

        # TODO: later when zPage is always under creator,
        # maybe vanity doesn't need to be unique?;()

        # URL lookup uses ``iexact`` and slugification lowercases new values,
        # so validate against legacy mixed-case rows as well as new rows. The
        # field's existing exact unique constraint then closes the concurrent
        # create race because every API write reaches it in normalized form.
        vanity_rows = zPage.objects.filter(vanity__iexact=value)
        if self.instance:
            vanity_rows = vanity_rows.exclude(pk=self.instance.pk)
        if vanity_rows.exists():
            raise serializers.ValidationError("Vanity is not unique!")

        # ``free2zaddr`` is the page's immutable identity and is a supported
        # lookup key. A vanity must not squat another page's address, or the
        # two identifiers would resolve to different pages. Compare without
        # case because the vanity lookup is case-insensitive and addresses are
        # UUIDs in normal operation.
        address_rows = zPage.objects.filter(free2zaddr__iexact=value)
        if self.instance:
            address_rows = address_rows.exclude(pk=self.instance.pk)
        if address_rows.exists():
            raise serializers.ValidationError(
                "Vanity cannot match another page's free2zaddr!"
            )

        if Creator.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("Vanity can not be username")

        # TODO: general model validation?
        if len(value) > 128:
            raise serializers.ValidationError(
                "Vanity is too long! Less than 128 please"
            )

        return value


class SimpleCreatorSerializer(serializers.ModelSerializer):
    avatar_image = FeaturedImageSerializer()

    class Meta:
        model = Creator
        fields = [
            'id',
            'username',
            'avatar_image',
            'p2paddr',
            'member_price',
            'full_name',
        ]


class zPageListSerializer(
    LocalizedZPageSerializerMixin,
    TaggitSerializer,
    serializers.ModelSerializer
):
    localized_content_summary = True
    p2paddr = serializers.CharField(source='get_p2paddr')
    creator = SimpleCreatorSerializer()
    content = serializers.SerializerMethodField()
    tags = TagListSerializerField()
    featured_image = FeaturedImageSerializer()

    class Meta:
        model = zPage
        fields = (
            'free2zaddr',
            # User controlled #######
            'vanity',
            'p2paddr',
            'title',
            # 'content',
            'category',
            'is_published',
            'is_subscriber_only',
            'publish_at',
            'featured_image',
            'description',
            # #####################
            'is_verified',
            'total',
            'f2z_score',
            'created_at',
            'updated_at',
            'published_at',
            'get_url',
            'creator',
            'content',
            'tags',
            'source_language',
            'detected_language',
            'detection_confidence',
            'language_source',
            'requested_language',
            'actual_language',
            'fallback_used',
            'available_languages',
            'variant_is_published',
            'origin',
            'is_stale',
        )
        read_only_fields = [
            'free2zaddr',
            'is_verified',
            'total',
            'f2z_score',
            'updated_at',
            'created_at',
            'published_at',
            'get_url',
            'creator',
            'featured_image',
            'publish_at',
            'detected_language',
            'detection_confidence',
            'language_source',
        ]

    def get_content(self, instance: zPage):
        if instance.description:
            return instance.description

        if hasattr(instance, 'truncated_content'):
            truncated_content = instance.truncated_content
            html = markdown2.markdown(truncated_content)
            text = strip_tags(html)
            return f"{text[:365]}..."

        return instance.content


class PageCommentSerializer(serializers.ModelSerializer):
    class Meta:
        model = PageComment
        fields = ['created_at', 'comment']


class zPageDetailSerializer(
    LocalizedZPageSerializerMixin,
    TaggitSerializer,
    serializers.ModelSerializer
):
    """
    Only for retrieval
    """
    creator = SimpleCreatorSerializer()
    p2paddr = serializers.CharField(
        source='get_p2paddr',
        help_text=(
            "The EFFECTIVE Zcash support address: this page's own address, "
            "else its creator's profile address. Pay this. Do not write it "
            "back as the page's address -- see `p2paddr_override`."
        ),
    )
    p2paddr_override = serializers.CharField(
        read_only=True,
        allow_null=True,
        help_text=(
            "The page's OWN Zcash address, or `null` when the page inherits "
            "its creator's profile address. This is the value an "
            "editor round-trips as `p2paddr`: sending the effective "
            "`p2paddr` back instead pins the creator's current address onto "
            "the page, and a later profile address change never reaches it."
        ),
    )
    comments = PageCommentSerializer(many=True, read_only=True)
    tags = TagListSerializerField()
    featured_image = FeaturedImageSerializer()
    media = serializers.SerializerMethodField()

    @extend_schema_field(EmbeddedMediaSerializer(many=True))
    def get_media(self, obj):
        # Deliberately empty here. `content` is the LOCALIZED body, and
        # LocalizedZPageSerializerMixin overlays it in `to_representation`
        # *after* every declared field has been serialized -- so the
        # authoritative body does not exist yet at this point, and a media
        # list built from `obj.content` would describe the source language's
        # article on a translated response. `to_representation` below fills
        # this in from the body that was actually rendered.
        return []

    def to_representation(self, instance):
        result = super().to_representation(instance)
        # `instance.creator` scopes upload resolution -- see
        # embedded_media(): without it, an author could probe another
        # creator's PRIVATE uploads by writing their URL into a page.
        result["media"] = embedded_media(
            result.get("content") or "", instance.creator,
        )
        return result

    class Meta:
        model = zPage
        fields = (
            'free2zaddr',
            # User controlled #######
            'vanity',
            'p2paddr',
            'p2paddr_override',
            'title',
            'content',
            'category',
            'is_published',
            'is_subscriber_only',
            'total_raised',
            'featured_image',
            'description',
            # #####################
            'is_verified',
            'total',
            'f2z_score',
            'comments',
            'creator',
            'created_at',
            'updated_at',
            'published_at',
            'get_url',
            'tags',
            'publish_at',
            'canonical_url',
            'source_language',
            'detected_language',
            'detection_confidence',
            'language_source',
            'requested_language',
            'actual_language',
            'fallback_used',
            'available_languages',
            'variant_is_published',
            'origin',
            'is_stale',
            'media',
        )
        read_only_fields = [
            'free2zaddr',
            'detected_language',
            'detection_confidence',
            'language_source',
            # Was `'is_verified' 'total'` — adjacent string literals silently
            # concatenate to 'is_verifiedtotal', so neither field was actually
            # marked read-only. Harmless today (this serializer is retrieval
            # only), but a latent footgun if it ever gains a write path.
            'is_verified',
            'total',
            'f2z_score',
            'comments',
            'created_at',
            'updated_at',
            'published_at',
            'creator',
            'get_url',
            'featured_image',
        ]


class ZPageVariantSummarySerializer(serializers.Serializer):
    """One row of `GET /api/zpage/{id}/variants/` — the translation manager's index.

    Not a `ModelSerializer` over `ZPageVariant` on purpose. Until  M5 flips
    reads, the legacy shape (`zPage` columns + `ZPageTranslation`) is the
    authority for *content* and publication state, while `ZPageVariant` is the
    only place that knows *provenance*. This serializer renders the join of the
    two, so a bug in the not-yet-read variant table can never make a variant's
    text or draft state wrong in a response.
    """

    language = serializers.CharField(
        read_only=True,
        help_text="BCP-47 tag. Address this variant at "
                  "`/api/zpage/{id}/variants/{language}/`.",
    )
    origin = serializers.ChoiceField(
        choices=ZPageVariant.ORIGIN_CHOICES,
        read_only=True,
        allow_null=True,
        help_text=(
            "`source` is the article itself and cannot be deleted; `human` "
            "and `ai` are translations. `null` means the variant row has not "
            "been mirrored yet — unknown provenance, not `human`."
        ),
    )
    is_published = serializers.BooleanField(
        read_only=True,
        help_text="This variant's own publication state. Drafts appear only "
                  "for the owner.",
    )
    is_stale = serializers.BooleanField(
        read_only=True,
        allow_null=True,
        help_text=(
            "`true` the source changed after this translation was made, "
            "`false` it is current, `null` unknown. Render `null` as nothing: "
            "translations without source-revision metadata are `null`; "
            "labeling them stale would give a false result."
        ),
    )
    title = serializers.CharField(read_only=True)
    description = serializers.CharField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)
