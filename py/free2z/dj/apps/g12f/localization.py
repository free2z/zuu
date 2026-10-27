import logging
from dataclasses import dataclass

from django.conf import settings
from django.db import models
from django.db.models import Case, Prefetch, TextField, When
from rest_framework import serializers

from dj.apps.g12f.models.zpage import ZPageTranslation, ZPageVariant
from dj.apps.g12f.variants import content_digest

from f2z import languages
from f2z.languages import LanguageError

logger = logging.getLogger(__name__)

#Where a variant prefetch built for CONTENT resolution lands. Deliberately a
#``to_attr`` and not ``_prefetched_objects_cache["variants"]``: the cache is
#what:func:`variant_provenance` keys off, and populating it on a path that
#does not populate it today would change ``origin`` from ``null`` to
#``"human"`` in responses the flag is supposed to leave byte-identical.
#Provenance is answered from exactly the same rows in both flag states; only
#the content moves. (M6 collapses the two.)
RESOLUTION_VARIANTS_ATTR = "_m5_resolution_variants"


def variant_reads_enabled():
    """Whether  M5 is on: resolution reads ``ZPageVariant``, not the legacy shape.

    Default OFF, and the default is the point. Every read path in this module
    has two implementations that must produce identical bytes on a reconciled
    corpus, so the flag is a *source* switch, not a behaviour switch. See the
    settings comment on ``ZPAGE_VARIANT_READS`` for the pre-flight, and
    ``test_zpage_variant_reads.py`` for the parity suite that pins it.
    """
    return getattr(settings, "ZPAGE_VARIANT_READS", False)


class ContentExcerpt(models.Func):
    function = "SUBSTRING"
    template = "%(function)s(%(expressions)s FROM 1 FOR %(length)s)"


def visible_translations(queryset, viewer_id):
    """The:func:`visible_variants` rule, one table over.

    The legacy ``ZPageTranslation`` shape is still what the detail route renders
    while ``ZPAGE_VARIANT_READS`` is off -- which is the DEFAULT and the
    documented rollback state, so a memory bound that only holds with the flag
    on is a bound that vanishes exactly when an incident turns it off. Same
    100,000-character bodies, same absent ceiling on drafts, same anonymous
    route. (codex adversarial review.)

    No ``origin='source'`` carve-out here: the article's own content lives on
    the ``zPage`` row in this shape, so every row this queryset can return is a
    translation.
    """
    if viewer_id is None:
        return queryset.filter(is_published=True)
    return queryset.filter(
        models.Q(is_published=True) | models.Q(zpage__creator_id=viewer_id)
    )


def localized_list_translation_prefetch(prefix="", *, viewer_id=None):
    """Prefetch metadata and a DB-side excerpt, never full translation bodies.

    ``viewer_id`` drops drafts this caller could never be shown, same rule as
    everywhere else. Each row here is ~1 kB rather than ~100 kB -- the
    excerpt is computed in SQL -- so this is the small end of the amplifier. It
    is still worth closing: the row COUNT is just as unbounded, a feed fans out
    over a whole page of zPages, and the public series endpoint is unpaginated.
    (codex adversarial review.)
    """
    return Prefetch(
        f"{prefix}translations",
        queryset=visible_translations(
            ZPageTranslation.objects.annotate(
                truncated_content=ContentExcerpt(
                    models.F("content"), length=365
                )
            ).only(
                "zpage_id", "language", "title", "description", "is_published"
            ),
            viewer_id,
        ),
    )


def detail_translation_prefetch(prefix="", *, viewer_id=None):
    """Full legacy translation rows for the detail route -- minus the drafts.

    The detail route renders a BODY, so unlike
    :func:`variant_index_translation_prefetch` this cannot defer ``content``.
    What it can do is not load the bodies of rows this caller could never be
    shown, which is the whole of  applied to the pre-M5 read source.
    """
    return Prefetch(
        f"{prefix}translations",
        queryset=visible_translations(
            ZPageTranslation.objects.all(), viewer_id
        ),
    )


def variant_index_translation_prefetch(prefix="", *, viewer_id=None):
    """Translation *metadata* for the variants index. No bodies, not even excerpts.

    ``GET /api/zpage/{id}/variants/`` returns no content at all, so loading any
    is pure cost -- and the cost is not theoretical. A translation body may be
    100,000 characters, the endpoint is unpaginated and anonymous, and nothing
    bounds how many variants a page has. Reusing the plain ``"translations"``
    prefetch would let one small unauthenticated request pull every body of
    every language into ORM objects: hundreds of megabytes of heap on a page
    with enough translations, repeatable at will, ending in an OOMKilled pod
    rather than a slow response. A query-count test would call that clean,
    because the query count is identical -- only the bytes differ.

    Distinct from:func:`localized_list_translation_prefetch`, which annotates
    a 365-character excerpt because the *feed* renders one. This index renders
    none.
    """
    return Prefetch(
        f"{prefix}translations",
        queryset=visible_translations(
            ZPageTranslation.objects.only(
                "zpage_id", "language", "title", "description", "is_published",
                "updated_at",
            ),
            viewer_id,
        ),
    )


#Variant columns every read path needs. ``content`` is added separately and
#only where a body is actually rendered.
VARIANT_METADATA_FIELDS = (
    "zpage_id", "language", "origin", "source_digest", "is_published",
    "title", "description", "updated_at",
)


def viewer_id_from_request(request):
    """The pk a draft variant must belong to for this request to see it.

    ``None`` for anonymous, for a missing request, and for anything that does
    not look like an authenticated user -- all three mean "published rows only",
    which is the safe answer and the one that loads the least.
    """
    user = getattr(request, "user", None)
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    return user.pk


def visible_variants(queryset, viewer_id):
    """Restrict a ``ZPageVariant`` queryset to what ``viewer_id`` may be shown.

    The **draft filter, moved to the database boundary**. Every read
    path already drops unpublished variants in Python -- ``include_drafts`` is
    the owner check, and it is applied in ``_variant_candidates`` and in
    ``variant_summaries``. That filtering is correct and stays exactly where it
    is; this is about the *bytes* that had to be dragged into the process before
    it could run.

    A variant body is up to 100,000 characters, drafts have **no ceiling at all**
    (published ones are capped at 64 by ), the detail route is anonymous and
    unauthenticated, and the amplification factor is chosen by the page owner
    rather than by us. So an anonymous ``GET`` on a zPage with a large draft
    corpus used to materialize the entire draft corpus in order to throw it away
    -- on the same tier that heap-OOMs 3-7x a day as a baseline. A
    query-count test cannot see any of this; only the bytes differ.

    ``origin='source'`` rows are kept **unconditionally**, and that is not an
    oversight. ``_variant_candidates`` treats "the page is published but its
    source variant says draft" as a *disclosure* case with its own ERROR log and
    its own fallback; filtering the row out here would silently turn that into
    the "no source variant" case, which logs something else and is a different
    bug to debug. The source row is one row and it is the one the reader is
    almost certainly going to be handed.
    """
    if viewer_id is None:
        return queryset.filter(
            models.Q(is_published=True)
            | models.Q(origin=ZPageVariant.SOURCE)
        )
    return queryset.filter(
        models.Q(is_published=True)
        | models.Q(origin=ZPageVariant.SOURCE)
        | models.Q(zpage__creator_id=viewer_id)
    )


def localized_variant_prefetch(prefix="", *, with_content=False,
                               viewer_id=None):
    """Prefetch variant *provenance* only -- origin and digest, never bodies.

    ``origin`` and ``source_digest`` are the two things the legacy shape cannot
    answer ( §4.4), so resolution reads them from ``ZPageVariant`` while
    content still comes from the legacy columns until M5 flips reads.

    ``content`` is the one column deferred, and it is the only one that
    matters: a body may be 100,000 characters, so a page with forty
    translations would drag four megabytes into memory to render metadata.
    ``title``, ``description`` and ``updated_at`` are bounded and small, and
    :func:`variant_summaries` needs them to render a mirror-only row.

    Not applied to the zPage *list* queryset on purpose. That path defers
    ``content`` too, so staleness is unanswerable there anyway (see
    :func:`_source_content_digest`), and an extra query on the homepage feed to
    populate one nullable field nobody renders is not a trade worth making.

    ``with_content`` is the M5 exception, and it is narrow on purpose. The
    detail routes already populate this cache, so when reads are flipped they
    can resolve the body out of the same rows instead of issuing a second
    variant query -- and because the cache is populated in BOTH flag states on
    those routes, ``variant_provenance`` keeps answering identically. It must
    stay ``False`` on ``GET /api/zpage/{id}/variants/``, which renders no body
    at all and whose whole cost story is that it never loads one.

    ``viewer_id`` is the requesting creator's pk, or ``None`` for an anonymous
    request; it drops draft rows this caller could never be shown before they
    are read. See:func:`visible_variants`. Callers that genuinely need every
    row -- a write path, the reconciler -- do not go through this prefetch at
    all, so there is no "give me everything" mode to get wrong.
    """
    fields = list(VARIANT_METADATA_FIELDS)
    if with_content:
        fields.append("content")
    return Prefetch(
        f"{prefix}variants",
        queryset=visible_variants(
            ZPageVariant.objects.only(*fields), viewer_id
        ),
    )


def resolution_variant_prefetch(prefix="", *, source_length=None,
                                translation_length=365, viewer_id=None):
    """Variant rows to resolve CONTENT from, on paths that render an excerpt.

    Only used when:func:`variant_reads_enabled`. Lands in
    :data:`RESOLUTION_VARIANTS_ATTR` rather than the prefetch cache, for the
    reason spelled out on that constant.

    The two lengths are not a knob, they are a parity requirement. On the list
    and related feeds the legacy shape hands ``resolve_zpage_variant`` a
    255-character DB-side excerpt for the SOURCE (annotated on the zPage
    queryset) and a 365-character one for a TRANSLATION
    (:func:`localized_list_translation_prefetch`). The serializer then does
    ``content[:365] + "..."``, so the source excerpt really is shorter in the
    rendered feed -- an inconsistency that predates  and that a flip must
    reproduce exactly rather than quietly "fix". ``source_length=None`` means
    the caller loads the full body for the source today (the series endpoint),
    so the source row carries the full body here too.
    """
    if source_length is None:
        source_excerpt = models.F("content")
    else:
        source_excerpt = ContentExcerpt(
            models.F("content"), length=source_length
        )
    queryset = ZPageVariant.objects.annotate(
        truncated_content=Case(
            When(origin=ZPageVariant.SOURCE, then=source_excerpt),
            default=ContentExcerpt(
                models.F("content"), length=translation_length
            ),
            output_field=TextField(),
        )
    ).only(*VARIANT_METADATA_FIELDS)
    return Prefetch(
        f"{prefix}variants",
        queryset=visible_variants(queryset, viewer_id),
        to_attr=RESOLUTION_VARIANTS_ATTR,
    )


def feed_variant_prefetch(prefix="", *, source_length=None, viewer_id=None):
    """Splat into ``prefetch_related``: the M5 prefetch, or nothing at all.

    Returns a tuple so a call site reads ``*feed_variant_prefetch(...)`` and
    adds exactly zero queries while the flag is off. The alternative -- always
    prefetching and only using the rows when flipped -- would make every
    homepage request pay for a table nobody reads yet, which is the cost the
    staged rollout exists to avoid.

    ``viewer_id`` scopes out drafts nobody on this request may see.
    Cheaper here than on the detail route in bytes -- these rows carry a DB-side
    excerpt, not a body -- but the *row count* is just as unbounded, and a feed
    fans out over a whole page of zPages rather than one.
    """
    if not variant_reads_enabled():
        return ()
    return (
        resolution_variant_prefetch(
            prefix, source_length=source_length, viewer_id=viewer_id
        ),
    )


def is_content_language(value):
    """True if ``value`` names a real language someone can write in.

    The one predicate that replaces every ``code in SUPPORTED_LANGUAGE_CODES``
    test in this codebase. Those tests never actually meant "is one of our four
    locales" -- they meant "is this a language at all, or is it the ``und``
    sentinel", which is the question that survives the enum. It is False for
    ``und`` (and for ``mul``/``zxx``/a language family/private use), so the
    legacy carve-outs below keep behaving exactly as they do today while
    becoming true for German, Japanese and everything else.
    """
    return languages.is_detectable(value)


def normalize_zpage_language(value, *, allow_missing=True):
    """Canonicalize an API language tag, or raise a DRF ``ValidationError``.

    The Django-facing wrapper around:func:`f2z.languages.normalize`: same
    normalization (case-insensitive, CLDR-canonical, bare ``pt`` -> ``pt-BR``),
    but the registry's plain ``LanguageError`` is re-raised in DRF's vocabulary
    so callers keep producing 400s instead of 500s.

    What changed with the registry ( §3.3): a content language is now any
    real human language, not one of four. ``de``, ``ja`` and ``pt-PT`` are
    accepted. ``und`` is still rejected here, exactly as before -- it is a
    stored legacy value, never something a client may send.
    """
    try:
        return languages.normalize(value, allow_missing=allow_missing)
    except LanguageError as exc:
        raise serializers.ValidationError(str(exc)) from exc


#Hard bound on how much of an ``Accept-Language`` header we will parse. The
#header is attacker-controlled free text on an unauthenticated route; a
#64KB one must cost the same as a 40-byte one. Ten is far more than any real
#browser sends.
ACCEPT_LANGUAGE_MAX_TAGS = 10


def parse_accept_language(header):
    """The full weighted ``Accept-Language`` list, best match first ( §4.3).

    Returns raw tags in preference order -- highest ``q`` first, ties broken by
    the order they appeared, ``q=0`` dropped because RFC 9110 makes that an
    explicit *refusal* of a language, not a weak preference.

    Never raises. This parses a header, and a header from any client on the
    internet is soup: a missing ``q``, a non-numeric ``q``, empty elements and
    unparseable tags are all normal and all mean "ignore this element", never
    "fail the request".
    """
    if not header:
        return []
    entries = []
    for index, element in enumerate(header.split(",")[:ACCEPT_LANGUAGE_MAX_TAGS]):
        tag, _, parameters = element.strip().partition(";")
        tag = tag.strip()
        if not tag:
            continue
        quality = 1.0
        for parameter in parameters.split(";"):
            key, _, value = parameter.partition("=")
            if key.strip().lower() != "q":
                continue
            try:
                quality = float(value.strip())
            except ValueError:
                # A malformed q is not a preference we can honour, and
                # defaulting it to 1.0 would promote junk above a real
                # weighted choice. Drop the element.
                quality = 0.0
        if quality <= 0:
            continue
        # -index so that, at equal q, the tag written first wins -- and so the
        # ordering is total, which keeps the result deterministic.
        entries.append((quality, -index, tag))
    entries.sort(reverse=True)
    return [tag for _quality, _order, tag in entries]


def match_available_language(candidates, available):
    """First candidate that this page can actually serve, or ``None``.

    Two passes on purpose. An exact tag match wins over every less-exact one
    (``pt-PT`` prefers a real ``pt-PT`` variant to the ``pt-BR`` one), and only
    when nothing matches exactly do we fall back to the primary subtag, which
    is what makes an ``en-GB`` reader land on the ``en`` article instead of on
    the source variant.
    """
    normalized = []
    for tag in candidates:
        if tag == "*":
            # "anything" is the absence of a preference, not a preference for
            # the first thing in our list.
            continue
        try:
            normalized.append(languages.normalize(tag, allow_missing=False))
        except LanguageError:
            continue

    # `available` can legitimately contain a non-language: a zPage whose
    # `source_language` is still NULL ( §3.2, "detection has not run") puts
    # `None` in this set, and `None.casefold()` is an AttributeError -- i.e. a
    # 500 on `GET /api/zpage/{id}/` for any published page in that state, on
    # any request that does not pass an explicit `?lang=`. That is a live bug
    # this parity corpus found rather than one M5 introduces (it reproduces
    # with the flag off), and it is fixed here because M7 makes NULL the normal
    # state for an unlabelled page. A non-language is simply not a candidate.
    available = [code for code in available if isinstance(code, str) and code]
    exact = {code.casefold(): code for code in available}
    # `sorted`, because `available` is a set and the *first* code claiming a
    # primary subtag wins. Iterating the set directly made `pt-AO` resolve to
    # `pt-BR` or `pt-PT` depending on the process hash seed -- so two pods
    # would answer the same request differently, and whichever one a shared
    # cache reached first would pin the answer. Deterministic beats clever.
    primary = {}
    for code in sorted(available):
        primary.setdefault(code.split("-")[0].casefold(), code)

    for tag in normalized:
        hit = exact.get(tag.casefold())
        if hit is not None:
            return hit
    for tag in normalized:
        hit = primary.get(tag.split("-")[0].casefold())
        if hit is not None:
            return hit
    return None


@dataclass(frozen=True)
class ResolvedVariant:
    requested_language: str
    actual_language: str
    fallback_used: bool
    available_languages: list[str]
    title: str
    description: str
    content: str
    is_published: bool
    #``source`` / ``human`` / ``ai``, or ``None`` when the variant rows were
    #not loaded (see:func:`localized_variant_prefetch`). ``None`` is
    #"not loaded", never "guessed" -- inferring ``human`` from "it is not the
    #source language" is right only until P8 writes the first AI variant.
    origin: str | None = None
    #Tri-state, and every caller must honour all three. ``None`` is
    #*unknown*, which is what every pre- translation is, and rendering it
    #as "Stale" is the  mistake. See:func:`variant_provenance`.
    is_stale: bool | None = None


def _loaded_translations(page):
    cache = getattr(page, "_prefetched_objects_cache", {})
    if "translations" in cache:
        return list(cache["translations"])
    return list(page.translations.all())


def _loaded_variants(page):
    """Prefetched variant rows by language, or ``None`` if they were not loaded.

    Deliberately never falls back to ``page.variants.all()``: this runs once
    per serialized page, so a lazy fetch here is an N+1 on the homepage feed.
    Callers that need provenance ask for it with
    :func:`localized_variant_prefetch`; everyone else gets ``None`` and reports
    provenance as unknown.
    """
    cache = getattr(page, "_prefetched_objects_cache", {})
    if "variants" not in cache:
        return None
    return {row.language: row for row in cache["variants"]}


def _row_has_content(row):
    """Whether this variant row can answer for a body without a second query."""
    if hasattr(row, "truncated_content"):
        return True
    return "content" not in row.get_deferred_fields()


def m5_variant_rows(page, *, need_content):
    """Every ``ZPageVariant`` of ``page``, however it was loaded.

    Three sources, in order, and the order is the whole safety argument:

    1.:data:`RESOLUTION_VARIANTS_ATTR`, set by
       :func:`resolution_variant_prefetch` on the feed paths.
    2. ``_prefetched_objects_cache["variants"]``, which the detail routes
       populate -- but only if those rows actually carry a body when a body is
       what is being asked for. ``GET /variants/`` deliberately loads rows with
       ``content`` deferred, and resolving a body out of those would either
       fire a deferred-field query per row (an N+1) or, if the guard were
       missing, render an empty article. The check is cheap and it is the
       difference between "someone added a resolve() call to a metadata route"
       being a slow request and being an outage.
    3. A plain query. The write routes prefetch nothing today -- exactly as
       they load ``page.translations.all()`` lazily today -- so this keeps the
       flip from needing a prefetch on every call site in the codebase.
       Deliberately ``ZPageVariant.objects.filter(...)`` and not
       ``page.variants.all()``: a reverse manager RETURNS THE PREFETCH CACHE,
       so the "fetch it properly then" fallback would hand back the very rows
       whose missing body sent us here, and the guard above would be decorative.

    Never returns ``None``: an empty list is a real answer (a page whose
    ``source_language`` is still NULL has no variant rows by design, see
    ``variants.sync_source_variant``), and the caller handles it.
    """
    rows = getattr(page, RESOLUTION_VARIANTS_ATTR, None)
    if rows is not None and (
        not need_content or all(_row_has_content(row) for row in rows)
    ):
        return list(rows)

    cache = getattr(page, "_prefetched_objects_cache", {})
    cached = cache.get("variants")
    if cached is not None and (
        not need_content or all(_row_has_content(row) for row in cached)
    ):
        return list(cached)

    return list(ZPageVariant.objects.filter(zpage_id=page.pk))


def _source_content_digest(page):
    """Digest of the canonical content, or ``None`` when it is not loaded.

    The list queryset defers ``content`` (it serves a DB-side excerpt instead),
    and touching it here would fire one extra query per row. Returning ``None``
    makes staleness *unknown* on those paths, which is the safe half of the
    tri-state.
    """
    if "content" in page.get_deferred_fields():
        return None
    # Memoized on the instance: `variant_summaries` asks once per translation,
    # and a zPage body is up to 100,000 characters. Hashing that forty times to
    # render one table is work nobody asked for. Safe because provenance is
    # only ever computed while rendering, after any write in the request, and
    # the instance does not outlive the request.
    cached = getattr(page, "_source_content_digest_cache", None)
    if cached is None:
        cached = content_digest(page.content)
        page._source_content_digest_cache = cached
    return cached


def _content_value(variant):
    """Use a DB-side excerpt on list querysets without fetching deferred bodies."""
    if hasattr(variant, "truncated_content"):
        return variant.truncated_content
    return variant.content


@dataclass(frozen=True)
class _Candidates:
    """The rows resolution chooses between, whichever shape they came from.

    ``source`` is an object exposing ``title`` / ``description`` /
    ``content`` / ``is_published`` -- the ``zPage`` itself in legacy mode, the
    ``origin="source"`` variant when reads are flipped. Keeping the two modes
    behind one struct is what stops the flip from becoming a second resolution
    path: ``resolve_zpage_variant`` below has exactly one body.
    """

    source: object
    source_language: str | None
    by_language: dict
    available: set


def _legacy_candidates(page, include_drafts):
    """The pre-M5 shape: content on the zPage row, translations beside it."""
    translations = _loaded_translations(page)
    visible = [item for item in translations if include_drafts or item.is_published]
    available = {item.language for item in visible}
    if include_drafts or page.is_published:
        available.add(page.source_language)
    return _Candidates(
        source=page,
        source_language=page.source_language,
        by_language={item.language: item for item in visible},
        available=available,
    )


def _variant_candidates(page, include_drafts):
    """The M5 shape: every language is a ``ZPageVariant`` row.

    **A missing source variant falls back to the legacy columns and logs.**
    That is not defensive padding, it is the single most important line in the
    flip. ``ZPageVariant.language`` is NOT NULL, so a zPage whose
    ``source_language`` is still NULL (detection has not run -- the  §3.2
    representation of "we do not know yet") has no source row *by design*, and
    every zPage in that state is a live article someone can read right now.
    Resolving it out of an empty row set would render a blank title and a blank
    body. A row that is missing because of DRIFT is the same shape and the same
    answer -- serve what the legacy shape says, which is what the reader saw
    yesterday -- but it gets an ERROR log, because that one the reconciler was
    supposed to have fixed before the flag was turned on.

    **An unpublished source variant on a published page is the same case, and
    it is a DISCLOSURE case.** Every caller has already been authorized against
    ``zPage.is_published`` -- that is what the viewset's queryset filters on --
    so by the time resolution runs, "this page is public" is settled. If the
    mirror then says its source variant is a draft, the two shapes disagree
    about publication state, and the mirror row is by definition text that was
    written while the shapes were out of step: a stale revision, possibly the
    private draft the creator edited before publishing a sanitized version.
    Rendering it would turn drift into a leak. So it is refused the same way a
    missing row is: fall back to the legacy columns, which are the ones the
    authorization decision was made from, and log.
    """
    rows = m5_variant_rows(page, need_content=True)
    source = next(
        (row for row in rows if row.origin == ZPageVariant.SOURCE), None
    )
    if source is None:
        if page.source_language:
            logger.error(
                "zpage %s: variant reads are on but the page has no "
                "origin='source' variant; falling back to the legacy columns. "
                "Run reconcile_zpage_variants --repair.",
                page.pk,
            )
    elif page.is_published and not (include_drafts or source.is_published):
        logger.error(
            "zpage %s: variant reads are on and the page is published, but its "
            "origin='source' variant says unpublished; refusing to render it "
            "and falling back to the legacy columns. "
            "Run reconcile_zpage_variants --repair.",
            page.pk,
        )
        source = None

    visible = [
        row for row in rows
        if row.origin != ZPageVariant.SOURCE
        and (include_drafts or row.is_published)
    ]
    available = {row.language for row in visible}

    if source is None:
        if include_drafts or page.is_published:
            available.add(page.source_language)
        return _Candidates(
            source=page,
            source_language=page.source_language,
            by_language={row.language: row for row in visible},
            available=available,
        )

    if include_drafts or source.is_published:
        available.add(source.language)
    return _Candidates(
        source=source,
        source_language=source.language,
        by_language={row.language: row for row in visible},
        available=available,
    )


def resolve_zpage_variant(
    page, requested_language=None, *, include_drafts=False, accept_language=None
):
    """Pick the variant to render, and describe what was picked.

    Resolution order ( §4.3): an explicit ``?lang=`` (passed in as
    ``requested_language``) -> the weighted ``Accept-Language`` list -> the
    account's content-language preference -> the source variant.

    The third step is a documented no-op today: there is no per-account
    *content*-language preference in the data model. The only language on an
    account is the product-UI locale, which  owns and  §2 principle 8
    says must stay a separate knob -- reading an article in Spanish is not a
    request to translate the navbar, and the reverse inference is just as
    wrong. When  lands a stored content preference, it slots in here,
    between the header and the source variant.

    **One resolution point, two row sources.** ``ZPAGE_VARIANT_READS`` (
    M5) decides whether the candidate rows come from ``ZPageVariant`` or from
    the legacy ``zPage`` columns plus ``ZPageTranslation``; everything after
    that -- negotiation, fallback, ``available_languages`` ordering, the
    ``und`` carve-out, provenance -- is one body of code shared by both. A
    second code path is precisely what would make the two states drift, so
    there is not one.
    """
    candidates = (
        _variant_candidates(page, include_drafts)
        if variant_reads_enabled()
        else _legacy_candidates(page, include_drafts)
    )
    source = candidates.source
    source_language = candidates.source_language
    by_language = candidates.by_language
    available = candidates.available

    if requested_language:
        requested = requested_language
    else:
        # Only what this page can actually serve is a candidate, so a header
        # preference for a language we do not have falls through to the source
        # variant rather than 404ing or inventing an empty variant.
        requested = match_available_language(
            parse_accept_language(accept_language), available
        ) or source_language

    selected = None if requested == source_language else by_language.get(requested)
    if selected is None:
        actual = source_language
        title = source.title
        description = source.description
        content = _content_value(source)
        published = source.is_published
    else:
        actual = selected.language
        title = selected.title
        description = selected.description
        content = _content_value(selected)
        published = selected.is_published

    # Sorted by tag so the order is total and stable for any language, not just
    # the four that used to be hardcoded. For en/es/fr/pt-BR this is byte-for-
    # byte the order the old `SUPPORTED_LANGUAGE_CODES` filter produced, so no
    # client sees a reshuffle.
    ordered_available = sorted(
        code for code in available if is_content_language(code)
    )
    if source_language and not is_content_language(source_language):
        # `und` is intentionally exposed for legacy rows: pretending that
        # unknown source material is English corrupts language metadata.
        #
        # `source_language and` guards the OTHER non-language: NULL, which
        # means "detection has not run", not "a language called null". Without
        # it `available_languages` becomes `[null]`, a non-string in an array
        # every client (and the SvelteKit sitemap parser) requires to hold
        # strings. The sitemap's `_available_languages` already refuses it for
        # exactly this reason; the API did not.
        ordered_available.insert(0, source_language)

    origin, is_stale = variant_provenance(page, actual)

    return ResolvedVariant(
        requested_language=requested,
        actual_language=actual,
        fallback_used=(
            requested != actual and is_content_language(actual)
        ),
        available_languages=ordered_available,
        title=title,
        description=description,
        content=content,
        is_published=published,
        origin=origin,
        is_stale=is_stale,
    )


@dataclass(frozen=True)
class VariantSummary:
    language: str
    origin: str | None
    is_published: bool
    is_stale: bool | None
    title: str
    description: str
    updated_at: object


def variant_summaries(page, *, include_drafts=False):
    """Every language of ``page`` with its real status, source variant first.

    Content is deliberately absent: this is the translation manager's index
    ( Part 7), and shipping ten full article bodies to render a table of
    ten rows is how a list endpoint becomes a timeout.

    ``include_drafts`` is the owner check. An unpublished translation is
    unfinished work, not content -- a non-owner must not learn it exists, so
    it is filtered here rather than flagged in the response.

    **Mirror-only rows are listed too.** A ``ZPageVariant`` with no
    ``ZPageTranslation`` behind it should not exist -- dual write always
    creates the pair -- but one can arrive from a hand-edited database, a
    partially-applied M2 backfill, or (from P8) an AI draft written straight
    into the variant table. It matters because
    ``validate_source_language`` refuses a relabel that collides with one, and
    a blocker the creator cannot see is a blocker they cannot clear. The 409
    says "delete or merge it"; this is what makes that sentence true.

    **``updated_at`` is not part of what M5 flips**, in either mode. Dual write
    does not mirror timestamps -- ``ZPageVariant.updated_at`` is ``auto_now``,
    so it records when the MIRROR was written, and for the whole pre-
    corpus that is the date migration ``0100`` ran. Sourcing it from the
    variant would tell every creator their 2024 Spanish translation was edited
    on the day of a backfill. So the legacy row's timestamp wins wherever one
    exists, and only a mirror-only row (which has no legacy counterpart at all)
    reports its own -- exactly as it does today. M6/M8 own moving it.
    """
    if variant_reads_enabled():
        return _variant_summaries_from_variants(page, include_drafts)

    summaries = []
    if include_drafts or page.is_published:
        summaries.append(
            VariantSummary(
                language=page.source_language,
                origin=ZPageVariant.SOURCE,
                is_published=page.is_published,
                # The source is what staleness is measured against, so it can
                # never be stale. Not False -- there is no question to answer.
                is_stale=None,
                title=page.title,
                description=page.description,
                updated_at=page.updated_at,
            )
        )

    seen = {page.source_language}
    for translation in sorted(
        _loaded_translations(page), key=lambda item: item.language
    ):
        if translation.language in seen:
            # A legacy row in the page's own source language. The API cannot
            # create one (a same-language write routes to the canonical path),
            # and listing it twice would show the creator two rows they cannot
            # tell apart. The canonical entry above already represents it.
            continue
        seen.add(translation.language)
        if not (include_drafts or translation.is_published):
            continue
        origin, is_stale = variant_provenance(page, translation.language)
        summaries.append(
            VariantSummary(
                language=translation.language,
                origin=origin,
                is_published=translation.is_published,
                is_stale=is_stale,
                title=translation.title,
                description=translation.description,
                updated_at=translation.updated_at,
            )
        )

    rows = _loaded_variants(page) or {}
    for language in sorted(rows):
        if language in seen:
            continue
        row = rows[language]
        if not (include_drafts or row.is_published):
            # Same rule as a legacy draft, and it has to be applied here too:
            # a mirror-only row still carries a title and a description, so
            # listing an unpublished one would hand a stranger the existence
            # and the headline of work the creator has not published. This is
            # the one hole the independent review found (RISKIEST LINE), and
            # it is the shape to expect whenever a list endpoint grows a
            # SECOND source of rows: the visibility rule gets written once,
            # for the first source, and quietly not for the second.
            continue
        if row.origin == ZPageVariant.SOURCE:
            # A source-origin row whose language disagrees with
            # `zPage.source_language`: the two shapes have drifted. The
            # canonical entry above is the article; showing this one as a
            # second, deletable "variant" would invite someone to delete the
            # page's own content. The drift reconciler ( §3.2) owns it.
            continue
        _origin, is_stale = variant_provenance(page, language)
        summaries.append(
            VariantSummary(
                language=language,
                origin=row.origin,
                is_published=row.is_published,
                is_stale=is_stale,
                title=row.title,
                description=row.description,
                updated_at=row.updated_at,
            )
        )
    return summaries


def _variant_summaries_from_variants(page, include_drafts):
    """:func:`variant_summaries` with ``ZPageVariant`` as the row authority (M5).

    Same output, different table. Every rule the legacy branch applies applies
    here and for the same reasons -- the source row first and never stale, a
    draft hidden from a non-owner (title and description are content, and the
    existence of unpublished work is itself information), a row whose language
    duplicates the source's collapsed into the canonical entry.

    Two things are deliberately still read from the legacy shape:
    ``updated_at`` (see the caller's docstring) and staleness, which
    :func:`variant_provenance` measures against ``zPage.content``. Both stay
    put so the flag cannot change a byte of the response on a reconciled
    corpus; M6 moves them when the legacy columns stop being written.
    """
    rows = m5_variant_rows(page, need_content=False)
    source = next(
        (row for row in rows if row.origin == ZPageVariant.SOURCE), None
    )
    legacy_updated = {
        item.language: item.updated_at for item in _loaded_translations(page)
    }

    summaries = []
    if source is None:
        if page.source_language:
            logger.error(
                "zpage %s: variant reads are on but the page has no "
                "origin='source' variant; listing the legacy columns instead. "
                "Run reconcile_zpage_variants --repair.",
                page.pk,
            )
        source_language = page.source_language
        if include_drafts or page.is_published:
            summaries.append(
                VariantSummary(
                    language=page.source_language,
                    origin=ZPageVariant.SOURCE,
                    is_published=page.is_published,
                    is_stale=None,
                    title=page.title,
                    description=page.description,
                    updated_at=page.updated_at,
                )
            )
    else:
        source_language = source.language
        if include_drafts or source.is_published:
            summaries.append(
                VariantSummary(
                    language=source.language,
                    origin=ZPageVariant.SOURCE,
                    is_published=source.is_published,
                    # The source is what staleness is measured against, so it
                    # can never be stale. Not False -- there is no question.
                    is_stale=None,
                    title=source.title,
                    description=source.description,
                    updated_at=page.updated_at,
                )
            )

    for row in sorted(rows, key=lambda item: item.language):
        if row.origin == ZPageVariant.SOURCE:
            continue
        if row.language == source_language:
            # A variant sharing the source's tag. `uniq_zpage_variant_language`
            # makes this impossible while the shapes agree, so it means drift;
            # the canonical entry above already represents the language, and a
            # second, deletable row for it invites deleting the article.
            continue
        if not (include_drafts or row.is_published):
            continue
        # `variant_provenance`, not `row.origin`, and the difference is not
        # cosmetic: provenance answers `None` -- *unknown* -- on a route that
        # did not prefetch the variant cache, and a route that reports `null`
        # today has to keep reporting `null`. Reading it off the row here would
        # promote it to "human" on exactly those routes, which is a response
        # change the flag is not allowed to make. (It is the same value
        # wherever the cache IS loaded, which is every route that renders it.)
        origin, is_stale = variant_provenance(page, row.language)
        summaries.append(
            VariantSummary(
                language=row.language,
                origin=origin,
                is_published=row.is_published,
                is_stale=is_stale,
                title=row.title,
                description=row.description,
                updated_at=legacy_updated.get(row.language, row.updated_at),
            )
        )
    return summaries


def variant_provenance(page, language):
    """``(origin, is_stale)`` for one language of ``page``. Both may be ``None``.

    ``is_stale`` is the field  §4.4 adds and the one most likely to be got
    wrong, so it is worth spelling out. ``ZPageVariant.source_digest`` has
    **three** states, not two:

    * ``NULL`` on the source variant -- it is what everything else is measured
      against.
    * ``NULL`` on a translation whose provenance was never recorded. Every row
      the M2 backfill copied out of ``ZPageTranslation`` is in this state, as is
      every hand-written translation, because nothing records a digest yet.
    * A digest, which either matches the current source content or does not.

    Only the last state can produce ``True``/``False``. Treating ``NULL`` as
    stale would light up "Stale" on essentially the entire existing corpus --
    which is exactly the false-positive rate that made  rip the fallback
    banner out. A badge that fires on everything teaches people to ignore it,
    and then it is worth less than nothing.

    Deliberately not a call to:func:`dj.apps.g12f.variants.staleness`, which
    encodes the same rule for the variant-native shape. That one measures
    against the *source variant's* content; this one measures against the
    legacy ``zPage`` columns, which are still the read authority until M5, and
    it has to answer "not loaded" for querysets that defer ``content``. The two
    must agree, and M5 deletes this one when reads flip.
    """
    rows = _loaded_variants(page)
    if language == page.source_language:
        return ZPageVariant.SOURCE, None
    if rows is None:
        return None, None
    row = rows.get(language)
    if row is None:
        return None, None
    if not row.source_digest:
        return row.origin, None
    digest = _source_content_digest(page)
    if digest is None:
        return row.origin, None
    return row.origin, row.source_digest != digest


@dataclass(frozen=True)
class OwnerVisibleVariant:
    """A canonical owner-visible article variant representing source or translation.

    Returned by get_owner_visible_variants() to provide a uniform, drift-resilient
    view across both ZPAGE_VARIANT_READS rollout modes.
    """

    language: str
    is_source: bool
    title: str
    description: str
    content: str
    is_published: bool
    origin: str  # "source", "human", "ai"
    is_stale: bool | None
    updated_at: object
    created_at: object


def get_owner_visible_variants(page) -> list[OwnerVisibleVariant]:
    """Return every stored language variant for an article once, for owner-visible contexts.

    Canonical and rollout-independent (identical output regardless of ZPAGE_VARIANT_READS).
    - Works correctly whether variants were prefetched or queried on-demand.
    - ZPageVariant is the production read authority whenever its row exists;
      legacy rows are a compatibility fallback for missing variants during rollout drift.
    - The source language and text use the source variant when it exists, with
      the zPage columns as the safe fallback for an undetected or missing source.
    - Variant rows provide both the exported text and provenance (source/human/ai).
    - Mirror-only ZPageVariant rows (not in ZPageTranslation and not the source language) are included once.
    - Variants are returned with source first, followed by non-source variants sorted alphabetically by language.
    """
    variants: list[OwnerVisibleVariant] = []
    seen_languages: set[str] = set()

    # Load both shapes. The export is intentionally pinned to the production
    # read authority (ZPageVariant); legacy rows only fill holes left by a
    # partial backfill or a rollout-time write from an old pod.
    translations = _loaded_translations(page)
    cached_variants = _loaded_variants(page)
    if cached_variants is not None:
        variants_map = cached_variants
    else:
        try:
            variants_map = {v.language: v for v in page.variants.all()}
        except Exception:
            variants_map = {}

    source_row = next(
        (row for row in variants_map.values() if row.origin == ZPageVariant.SOURCE),
        None,
    )
    source = source_row or page
    source_lang = getattr(source, "language", None) or page.source_language or "und"
    seen_languages.add(source_lang)
    variants.append(
        OwnerVisibleVariant(
            language=source_lang,
            is_source=True,
            title=source.title or "",
            description=source.description or "",
            content=_content_value(source) or "",
            is_published=source.is_published,
            origin=ZPageVariant.SOURCE,
            is_stale=None,
            updated_at=source.updated_at,
            created_at=source.created_at,
        )
    )

    source_digest = content_digest(_content_value(source))

    # Legacy rows are only a language inventory and compatibility fallback.
    for trans in sorted(translations, key=lambda t: t.language):
        if trans.language in seen_languages:
            continue
        seen_languages.add(trans.language)

        v_row = variants_map.get(trans.language)
        row = v_row or trans
        origin = v_row.origin if (v_row and v_row.origin) else ZPageVariant.HUMAN
        if v_row and v_row.source_digest:
            is_stale = (v_row.source_digest != source_digest)
        else:
            is_stale = None

        variants.append(
            OwnerVisibleVariant(
                language=trans.language,
                is_source=False,
                title=row.title or "",
                description=row.description or "",
                content=_content_value(row) or "",
                is_published=row.is_published,
                origin=origin,
                is_stale=is_stale,
                updated_at=getattr(row, "updated_at", page.updated_at),
                created_at=getattr(row, "created_at", page.created_at),
            )
        )

    # 4. Mirror-only ZPageVariant rows
    for lang in sorted(variants_map):
        if lang in seen_languages:
            continue
        row = variants_map[lang]
        if row.origin == ZPageVariant.SOURCE:
            continue
        seen_languages.add(lang)

        if row.source_digest:
            is_stale = (row.source_digest != source_digest)
        else:
            is_stale = None

        variants.append(
            OwnerVisibleVariant(
                language=lang,
                is_source=False,
                title=row.title or "",
                description=row.description or "",
                content=_content_value(row) or "",
                is_published=row.is_published,
                origin=row.origin or ZPageVariant.HUMAN,
                is_stale=is_stale,
                updated_at=row.updated_at or page.updated_at,
                created_at=getattr(row, "created_at", page.created_at),
            )
        )

    return variants
