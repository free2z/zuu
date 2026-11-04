"""What a `/tag/<slug>` hub is made of.

Two consumers read this module and they must not disagree:

* ``dj.apps.tagging.views.tag_hub`` -- the resolver the SSR route calls to
  render one hub.
* ``dj.apps.g12f.views.sitemap`` -- the ``tags`` sitemap kind, which enumerates
  the hubs worth submitting to a search engine.

Splitting it out of ``views.py`` is not tidiness. If the sitemap decided
"indexable" with its own copy of the rule, the two would drift, and the failure
mode is the expensive one: a URL in the sitemap that renders ``noindex``, which
Search Console reports forever as a submitted-but-excluded page.

Everything here counts pages through:func:`hub_visible_zpages`, whose only job
is to be ``published_and_active()`` and nothing else.  found seven of eight
read paths remembering ``is_published`` and forgetting ``creator__is_active``,
so a moderation ban took the profile down and left every article serving;
closed the rest. A brand-new read path is exactly where that gets forgotten
again, which is why there is one function and every count goes through it.
"""

from django.contrib.contenttypes.models import ContentType
from django.db.models import Count

from taggit.models import Tag, TaggedItem

from dj.apps.g12f.models import zPage


#How many published zPages a tag needs before its hub is indexable and worth
#a sitemap entry. Below this the page still renders for humans, and still
#links out, but declares `noindex, follow`.
#
#3, from the corpus: the live tag distribution runs from `technology` (1,913
#pages) down a very long tail of tags used exactly once. A one-page hub is a
#near-duplicate of the single article it links to -- the classic
#thin-content signal -- and a two-page hub is not much better. Three is the
#smallest number at which the page is a genuine list rather than a wrapper.
TAG_HUB_INDEX_MIN_PAGES = 3

#How many spellings of one hub are included in the bounded display payload.
#The list endpoint receives the hub slug and resolves the complete set on
#the server, so this is not a content or count limit.
TAG_HUB_MAX_NAMES = 50


def hub_visible_zpages():
    """The pages a tag hub counts, lists and is indexed for.

    ``published_and_active()`` is the / vocabulary: published AND
    authored by an account that has not been deactivated. The title/vanity
    exclusions match ``zPageView.get_queryset``'s public browse arm, because a
    row without a vanity has no canonical URL to link to and the list endpoint
    will not return it either -- a count that included those would promise
    results the list cannot deliver.
    """
    return (
        zPage.objects.published_and_active()
        .exclude(title='')
        .exclude(vanity='')
        .exclude(vanity__isnull=True)
    )


def hub_payload(slug, tags):
    """Resolve one slug's tags into the hub contract, or ``None`` if empty.

    ``None`` means "no live content under this slug", which the view turns
    into a 404. That is the same answer a slug nobody has ever used gets, and
    deliberately so: a tag whose every page belongs to a deactivated creator
    must be indistinguishable from a tag that never existed.
    """
    visible = hub_visible_zpages()
    tag_ids = [tag.pk for tag in tags]

    # One grouped query, not one per tag: it both orders the spellings and
    # tells us whether there is any live content at all.
    usage = {
        row['tags__pk']: row['used']
        for row in (
            visible.filter(tags__pk__in=tag_ids)
            .values('tags__pk')
            .annotate(used=Count('pk', distinct=True))
        )
    }
    ranked = sorted(
        (tag for tag in tags if usage.get(tag.pk)),
        key=lambda tag: (-usage[tag.pk], tag.name),
    )
    if not ranked:
        return None

    # The response is intentionally bounded, but the count is not: the list
    # endpoint uses `hub_slug` to resolve the complete component server-side.
    # Counting only the serialized names would make a 51st live spelling's
    # pages disappear from the pager and could incorrectly make an indexable
    # hub look thin.
    listed = ranked[:TAG_HUB_MAX_NAMES]
    if len(ranked) == 1:
        # The overwhelmingly common case: one spelling, so the grouped count
        # above already IS the answer and a second query would be waste.
        count = usage[ranked[0].pk]
    else:
        # NOT the sum of `usage`: a page carrying two colliding spellings is
        # still one page, and summing would over-count it -- which would then
        # disagree with the `count` the list endpoint reports for the very same
        # `any_tags` group and paginate past the end.
        count = (
            visible.filter(tags__pk__in=[tag.pk for tag in ranked])
            .distinct()
            .count()
        )

    return {
        'slug': slug,
        'name': ranked[0].name,
        'names': [tag.name for tag in listed],
        'count': count,
        'indexable': count >= TAG_HUB_INDEX_MIN_PAGES,
    }


def sitemap_tag_queryset(start_pk=None, end_pk=None):
    """Canonical representative tags whose hubs are indexable.

    Two filters, and the second one is subtle enough to deserve its own
    paragraph.

    ``used >= TAG_HUB_INDEX_MIN_PAGES`` is the quality gate: it is the same
    constant:func:`hub_payload` renders ``indexable`` from, so a URL cannot be
    submitted and then arrive declaring ``noindex``.

    The gate counts pages **per stored tag** before the Python
    canonicalization pass. This is intentionally conservative: a hub spread
    across several unrelated slug collisions may be discovered through its
    inbound tag chips instead of this sitemap, but a submitted URL must never
    answer ``noindex``. ``TagIdentity.slug`` is an indexed repair cache, not
    the correctness source for the request path; the bulk helper resolves the
    candidate set in one alias-frontier pass and returns canonical
    representatives without a per-slug query loop.

    The invariant that actually matters holds, and holds in the safe
    direction — **everything in the sitemap is indexable**. A hub that is
    indexable but unlisted is merely discovered through its inbound tag chips
    instead of the sitemap; the converse, a submitted URL that answers
    ``noindex``, is the one Search Console reports forever. Pinned by
    ``test_every_sitemapped_tag_is_indexable_on_its_hub``.

    ``name__regex=r'[[:alnum:]]'`` is the "has a slug at all" filter, and it
    has to live in SQL rather than in Python. The sitemap index COUNTS rows
    with an aggregate and the sitemap chunk RENDERS them one by one; if the
    chunk silently dropped a row whose slug came out empty, its length would
    stop matching the count the index signed and that one child would answer
    409 forever. PostgreSQL's ``alnum`` over a UTF-8 database is Unicode
    Alphabetic plus digits -- a strict subset of the letters/numbers/marks
    ``slugify_tag`` keeps -- so "SQL says alnum" implies "Python produces a
    slug", never the reverse. The reverse miss just leaves a tag out of the
    sitemap.

    Also note the ``pk__in`` subquery rather than a join: ``_page_manifest``
    counts representative tags with ``Count('pk')``, and a join to the
    tagged-items table would multiply every tag row by its usage and hand the
    index a wrong count.
    """
    if (start_pk is None) != (end_pk is None):
        raise ValueError("sitemap tag bounds must be supplied together")

    content_type = ContentType.objects.get_for_model(zPage)
    tagged = (
        TaggedItem.objects.filter(
            content_type=content_type,
            object_id__in=hub_visible_zpages().values('pk'),
        )
        .values('tag_id')
        .annotate(used=Count('object_id', distinct=True))
        .filter(used__gte=TAG_HUB_INDEX_MIN_PAGES)
    )
    candidates = list(Tag.objects.filter(
        pk__in=tagged.values('tag_id'),
        name__regex=r'[[:alnum:]]',
    ).only('pk', 'name').order_by('pk'))

    # Keep the resolver import local: `slugs` imports the TagAlias model and
    # this module is itself imported by the sitemap view. The bulk helper
    # resolves representatives with local component bounds; the same global
    # representative set is used by both the index and every chunk.
    from .slugs import bulk_canonical_representatives

    representative_slugs = bulk_canonical_representatives(candidates)
    representative_ids = set(representative_slugs.values())
    if not representative_ids:
        return Tag.objects.none()

    # The queryset contains the canonical root rows. The chunk serializer
    # derives each root's slug from its source name in Python, avoiding a
    # giant per-corpus SQL CASE expression while preserving the globally
    # resolved representative set for every PK page.
    queryset = Tag.objects.filter(
        pk__in=representative_ids,
        name__regex=r'[[:alnum:]]',
    )
    if start_pk is not None:
        queryset = queryset.filter(pk__gte=start_pk, pk__lt=end_pk)
    return queryset
