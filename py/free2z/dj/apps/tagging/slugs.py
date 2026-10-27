"""The ONE derivation of a tag's public URL slug, and the lookup back.

Read this before changing a single rule below.

Why it exists
=============

Until  a tag "page" was ``/search?tag=<name>``: a client-rendered search
screen that declares ``noindex, follow`` and ``<link rel=canonical
href="/search">``. Every topic hub on the platform was therefore invisible to
search engines *and* collapsed onto one canonical. ``/tag/<slug>`` replaces it
with a real, server-rendered, self-canonical URL.

That needs a URL-safe name for a value that is deliberately free-form:
``taggit.models.Tag.name`` is 100 characters of anything a creator can type --
spaces, mixed case, Unicode, emoji, ``/``, ``..``, ``%``.

The rule
========

1. NFC-normalize, so ``café`` typed as ``cafe`` + U+0301 and ``café``
   precomposed cannot produce two URLs.
2. Lowercase, then NFC again (lowercasing can decompose: ``İ`` becomes ``i`` +
   U+0307).
3. Replace **every** character that is not a Unicode letter, number or
   combining mark with ``-``.
4. Collapse runs of ``-`` and trim them from both ends.
5. Bound to:data:`TAG_SLUG_MAX_LENGTH` code points, pulling back to a ``-``
   boundary when there is one.

There is deliberately NO whitespace-collapse step, even though ``tag_key()``
has one. Whitespace is not a letter, number or mark, so step 3 already turns
every whitespace character into ``-`` and step 4 merges the run. Collapsing
first would change nothing and would import a real divergence: Python's
``str.split()`` treats U+0085 as whitespace and JavaScript's ``\\s`` does not,
while ``\\s`` treats U+FEFF as whitespace and Python does not (the same trap
``meta_description._EXOTIC_WHITESPACE_RE`` exists to defuse).

``lower()``, NOT ``casefold()`` -- and this is the one deviation from
:func:`dj.apps.tagging.models.tag_key`, which casefolds. A slug is produced in
*two* runtimes: Python here and ``slugifyTag()`` in
``ts/svelte/free2z/src/lib/tag-slug.js``, which is what renders every tag chip's
``href``. JavaScript has ``toLowerCase()`` and no ``casefold()`` at all, so
casefolding here would make the browser link to ``/tag/straße`` while the
server only answered ``/tag/strasse`` -- a dead link on a page we are asking
Google to index. ``str.lower()`` and ``String.prototype.toLowerCase()`` both
implement the Unicode default (non-locale) lowercase mapping, including the
Greek final-sigma context rule and the ``İ`` -> ``i`` + U+0307 expansion, so
they agree. The golden table
``py/dj/apps/tagging/testdata/tag_slug_parity.json`` pins that agreement and
both suites assert against it:

    py/dj/apps/tagging/test_tag_slugs.py
    ts/svelte/free2z/tests/tag-slug.test.mjs

Nothing is lost by not casefolding: *matching* stays case-insensitive
(``tags__name__iexact``), so ``STRASSE`` and ``strasse`` still land on one hub.

The mapping is LOSSY, on purpose
================================

``t-shirts``, ``t shirts`` and ``T/Shirts`` all slug to ``t-shirts``. Making
the slug reversible instead would mean percent-escaping the separator
(``t%2Dshirts``), which is a worse URL for the exact tag Google is already
crawling. So the collision is accepted and **owned**::func:`tags_for_slug`
returns *every* tag whose slug is the requested one, and the hub lists the
union of their pages under the most-used spelling. No tag is orphaned, and two
tags that slug alike browse together -- which is where 's normalization is
converging anyway.

Path traversal and route collisions fall out of the same rule rather than
needing a blocklist: ``..`` contains no letter, number or mark, so it slugs to
``""`` and there is no such URL. ``tag`` itself is reserved in
``dj/apps/g12f/usernames.py`` so no creator profile can shadow ``/tag/``.

An empty slug is a real answer
==============================

A tag of only emoji or only punctuation (``🔥``, ``!!!``) has no slug and
therefore no hub. ``tagHref()`` falls back to ``/search?tag=`` for those, and
:func:`sitemap_tag_queryset` excludes them in SQL. This is deliberate: an
emoji-only URL is not a topic hub anyone searches for, and inventing a
synthetic slug for it would put an unreadable URL in the sitemap.

The SQL half of that exclusion is ``name ~ '[[:alnum:]]'``, and the direction
of the inequality is load-bearing. PostgreSQL's ``alnum`` class over a UTF-8
database is ``alpha | digit``, and ``alpha`` is Unicode Alphabetic -- a
**subset** of the letters/numbers/marks this module keeps. So "SQL says the
name has an alnum character" implies "Python produces a non-empty slug", never
the reverse. That direction is what keeps the sitemap honest: the index counts
rows in SQL and the chunk renders them in Python, and a row that survived the
count but produced no URL would leave one sitemap child permanently answering
409. The reverse miss -- a name Python would slug but SQL calls alnum-less --
merely leaves a tag out of the sitemap, which is a shrug.
"""

import re
import unicodedata
from collections import defaultdict

from django.db import OperationalError, ProgrammingError
from django.db.models import Q
from rest_framework.exceptions import APIException

from taggit.models import Tag

from .models import (
    TagAlias,
    TagIdentity,
    _tag_key_source_pattern,
    tag_key,
)


#Bound on a slug, in code points -- and it is deliberately set ABOVE the
#longest slug any storable tag can produce, so the truncation branch below is
#unreachable for real data.
#
#An earlier draft used 80, for readable URLs, and the codex adversarial
#review found what that costs::func:`slugify_tag` truncates but
#:func:`tags_for_slug` matches an ANCHORED regex, so an 81-character tag
#produced a slug its own name could never match. Every chip pointed at a
#404, and `sitemap_tag_queryset` -- which does not truncate anything --
#published that broken URL. Correctness beats a prettier URL.
#
#200 is a real upper bound, not a guess. ``taggit.models.Tag.name`` is
#``max_length=100``, and the only Unicode DEFAULT lowercase mapping that
#lengthens a string is ``İ`` (U+0130) -> ``i`` + U+0307, one code point to
#two; NFC afterwards can only shrink. So 100 characters produce at most 200,
#and no storable tag can reach the truncation branch.
#
#The branch stays anyway. This function is also called on values that did not
#come from the database -- a slug typed into the URL bar -- and an unbounded
#one has no business becoming a database predicate.
TAG_SLUG_MAX_LENGTH = 200

#Kept as a compatibility constant for callers that imported the old lookup
#budget. Slug lookup now uses the indexed projection and does not need a
#regex candidate cap.
TAG_SLUG_MAX_CANDIDATES = 50

# Source fallback is authoritative and therefore may not silently truncate a
# collision set.  It is still bounded well above the current production
# corpus: a genuinely pathological set fails closed with 503 instead of
# turning a public URL into an arbitrary partial hub.
TAG_SLUG_MAX_SOURCE_CANDIDATES = 100_000
TAG_ALIAS_MAX_SOURCE_CANDIDATES = 100_000

# A hub request is anonymous and intentionally unthrottled for SSR.  These
# bounds are the safety valve for corrupted/imported alias graphs.  We never
# return the first N rows: exceeding any bound is an error, so both directions
# of a hub remain symmetric.
TAG_HUB_MAX_COMPONENT_ALIASES = 20_000
TAG_HUB_MAX_COMPONENT_TAGS = 20_000
TAG_HUB_MAX_COMPONENT_QUERIES = 32


class TagGraphTooLarge(APIException):
    """A public hub cannot be resolved without serving a partial graph."""

    status_code = 503
    default_detail = "Tag hub is temporarily unavailable."
    default_code = "tag_graph_too_large"


class TagGraphConflict(APIException):
    """A conflicting alias graph is unsafe to canonicalize implicitly."""

    status_code = 503
    default_detail = "Tag hub is temporarily unavailable."
    default_code = "tag_graph_conflict"

# A hub can only expose this many alias rows in its bounded discovery sample.
# Complete component resolution is separate and follows exact indexed
# frontiers so a late live edge cannot be hidden by this display cap.
TAG_HUB_MAX_ALIAS_ROWS = 50

#Characters kept verbatim: Unicode letters, numbers and combining marks.
#The JavaScript twin spells this `/[\p{L}\p{N}\p{M}]/u`.
_KEEP_CATEGORIES = frozenset("LNM")

_DASH_RUN_RE = re.compile(r"-{2,}")


def slugify_tag(name):
    """Return the canonical URL slug for ``name``, or ``""`` if it has none."""
    text = unicodedata.normalize("NFC", name or "")
    text = unicodedata.normalize("NFC", text.lower())

    slug = "".join(
        character
        if unicodedata.category(character)[0] in _KEEP_CATEGORIES
        else "-"
        for character in text
    )
    slug = _DASH_RUN_RE.sub("-", slug).strip("-")

    if len(slug) > TAG_SLUG_MAX_LENGTH:
        slug = slug[:TAG_SLUG_MAX_LENGTH]
        boundary = slug.rfind("-")
        if boundary > 0:
            slug = slug[:boundary]
        slug = slug.strip("-")
    return slug


def is_canonical_slug(value):
    """Whether ``value`` is a slug this module could have produced.

    Cheap, allocation-free rejection of the URLs a crawler invents:
    ``/tag/Zcash``, ``/tag/a--b``, ``/tag/-x``, ``/tag/..``. Checked before any
    query so a hostile path never reaches the regex scan below.
    """
    if not value or len(value) > TAG_SLUG_MAX_LENGTH:
        return False
    # `slugify_tag` IS the predicate: it is idempotent, so a value it does not
    # reproduce exactly was not one it could have produced. That covers upper
    # case, `/`, `%2e%2e`, a leading or doubled `-`, and a bare `..` in one
    # comparison, with no second spelling of the rule to drift.
    return slugify_tag(value) == value


def _candidate_regex(slug):
    """A PostgreSQL regex matching every name that *could* slug to ``slug``.

    A deliberate SUPERSET: every ``-`` becomes "one or more non-alphanumeric
    characters", which is what the forward rule collapsed. The result is
    verified in Python by:func:`tags_for_slug`, so the only thing this has to
    get right is not missing a match.

    Returns ``None`` for a single-segment slug, and that is a real optimisation
    rather than a special case. ``^abc$`` under ``~*`` selects exactly the rows
    ``name__iexact="abc"`` already selects -- so for the overwhelmingly common
    slug shape the regex adds nothing but a sequential scan of the tag table on
    an endpoint anonymous callers reach. Skipping it removes that scan from
    every ordinary lookup AND from the cheapest abuse shape (a flood of random
    single-token slugs), which is the mitigation the codex adversarial review
    asked for.

    No escaping is needed and none is done: a canonical slug contains only
    Unicode letters, numbers and marks plus ``-``, and none of those is a
    POSIX regex metacharacter.:func:`is_canonical_slug` is the gate that makes
    that true, so call it first.
    """
    segments = slug.split("-")
    if len(segments) < 2:
        return None
    return "^" + "[^[:alnum:]]+".join(segments) + "$"


def tags_for_slug(slug):
    """Every ``taggit`` tag whose canonical slug is ``slug``.

    ``TagIdentity`` is a fast repair cache, not the correctness source.  Taggit
    permits ``bulk_create``, ``bulk_update``, queryset updates, and raw fixture
    loads without signals.  The source query below therefore always verifies
    the current ``Tag.name``. Projection repair is deliberately left to
    write-side hooks and maintenance commands: this function is reached by
    anonymous GET /tag/ requests and must remain read-only.
    This costs a bounded candidate lookup, but prevents a stale projection from
    turning a public hub into a 404 or redirecting it to the wrong slug.
    """
    if not is_canonical_slug(slug):
        return []

    # A live tag saved through the application has an indexed projection. Use
    # it for the common path so a multi-segment slug does not pay for a
    # case-insensitive regex scan on every public request. The source row is
    # still verified in Python; a stale projection falls through to the
    # authoritative bounded lookup below.
    try:
        projected_ids = list(
            TagIdentity.objects.filter(slug=slug).values_list(
                "tag_id", flat=True
            ).order_by("tag_id")[: TAG_SLUG_MAX_SOURCE_CANDIDATES + 1]
        )
    except (OperationalError, ProgrammingError) as exc:
        # New application code can serve during the add-table half of the
        # migration. Fall back to the bounded source lookup until the
        # projection exists.
        if "tagging_tagidentity" not in str(exc).lower():
            raise
        projected_ids = []
    if len(projected_ids) > TAG_SLUG_MAX_SOURCE_CANDIDATES:
        raise TagGraphTooLarge
    resolved_by_id = {}
    exact_candidates = list(
        Tag.objects.filter(
            Q(pk__in=projected_ids)
            | Q(name__iexact=slug)
            | Q(name__iexact=slug.replace("-", " "))
        )
        .only("pk", "name")
        .order_by("pk")[: TAG_SLUG_MAX_SOURCE_CANDIDATES + 1]
    )
    if len(exact_candidates) > TAG_SLUG_MAX_SOURCE_CANDIDATES:
        raise TagGraphTooLarge
    # The projection is an accelerator, never a completeness shortcut. A
    # projected exact hit can coexist with a bulk/raw-created spelling that is
    # only discoverable through the authoritative regex matcher.
    resolved_by_id |= {
        tag.pk: tag for tag in exact_candidates
        if slugify_tag(tag.name) == slug
    }

    pattern = _candidate_regex(slug)
    if pattern is None:
        return [resolved_by_id[tag_id] for tag_id in sorted(resolved_by_id)]
    candidates = list(
        Tag.objects.filter(name__iregex=pattern)
        .only("pk", "name")
        .order_by("pk")[: TAG_SLUG_MAX_SOURCE_CANDIDATES + 1]
    )
    if len(candidates) > TAG_SLUG_MAX_SOURCE_CANDIDATES:
        raise TagGraphTooLarge
    resolved_by_id |= {
        tag.pk: tag for tag in candidates
        if slugify_tag(tag.name) == slug
    }
    return [resolved_by_id[tag_id] for tag_id in sorted(resolved_by_id)]


def _hub_aliases(tags, slug=None):
    """Return a SQL-bounded sample of aliases for one live hub.

    This is deliberately only a sample. Callers that need correctness use
    :func:`_alias_component` as well; that walk reads the bounded source table
    and derives ``name_key`` from each source name, so a live edge at row 51
    cannot be hidden by this response-size cap or a stale projection.
    """
    tags = list(tags)
    tag_ids = {tag.pk for tag in tags}
    tag_keys = {tag_key(tag.name) for tag in tags}
    source_matches = Q()
    for tag in tags:
        source_matches |= Q(name__iexact=tag.name)
    if slug is not None:
        source_matches |= Q(name__iexact=slug)
        source_matches |= Q(name__iexact=slug.replace("-", " "))
        pattern = _candidate_regex(slug)
        if pattern is not None:
            source_matches |= Q(name__iregex=pattern)
    for key in tag_keys:
        source_matches |= Q(name__iregex=_tag_key_source_pattern(key))
    return list(
        TagAlias.objects.filter(
            Q(name_key__in=tag_keys)
            | Q(canonical_id__in=tag_ids)
            | source_matches
        )
        .select_related("canonical")
        .order_by("pk")[:TAG_HUB_MAX_ALIAS_ROWS]
    )


def _alias_component(tags, initial_aliases=None):
    """Load a complete directed alias component from bounded source rows.

    ``name_key`` and ``canonical_id`` are indexed source fields. A missing or
    stale projection is still safe when the row points at a tag already in the
    frontier, because the canonical-id arm finds it and the source ``name`` is
    normalized below before it expands the next frontier.
    """
    tags = list(tags)
    if len(tags) > TAG_HUB_MAX_COMPONENT_TAGS:
        raise TagGraphTooLarge
    aliases_by_id = {alias.pk: alias for alias in (initial_aliases or [])}
    pending_ids = {tag.pk for tag in tags}
    pending_keys = {tag_key(tag.name) for tag in tags}
    queried_ids = set()
    queried_keys = set()

    query_count = 0
    while pending_ids or pending_keys:
        query_count += 1
        if query_count > TAG_HUB_MAX_COMPONENT_QUERIES:
            raise TagGraphTooLarge
        ids = pending_ids - queried_ids
        keys = pending_keys - queried_keys
        if not ids and not keys:
            break
        queried_ids = queried_ids | ids
        queried_keys = queried_keys | keys
        source_matches = Q()
        for key in keys:
            source_matches |= Q(
                name__iregex=_tag_key_source_pattern(key)
            )
        rows = list(
            TagAlias.objects.filter(
                Q(canonical_id__in=ids)
                | Q(name_key__in=keys)
                | source_matches
            )
            .select_related("canonical")
            .order_by("pk")[: TAG_HUB_MAX_COMPONENT_ALIASES + 1]
        )
        if len(rows) > TAG_HUB_MAX_COMPONENT_ALIASES:
            raise TagGraphTooLarge
        next_ids = set()
        next_keys = set()
        for alias in rows:
            aliases_by_id[alias.pk] = alias
            alias_key = tag_key(alias.name)
            if alias_key not in queried_keys:
                next_keys.add(alias_key)
            if alias.canonical_id not in queried_ids:
                next_ids.add(alias.canonical_id)
            canonical_key = tag_key(alias.canonical.name)
            if canonical_key not in queried_keys:
                next_keys.add(canonical_key)
        pending_ids = next_ids
        pending_keys = next_keys

    return [aliases_by_id[pk] for pk in sorted(aliases_by_id)]


def _alias_root_ids(tags, aliases, *, conflicts=None):
    """Return the stable root for each known tag in an alias component.

    Normal rows are directed (variant -> canonical), so they preserve the
    declared canonical tag. A directed cycle is unsafe, so choosing the
    lowest known tag id for that connected component makes every spelling
    converge without redirect loops. A conflicting key is different: the
    write path refuses it and reads fail closed rather than silently deleting
    one live hub. The graph is built from the complete exact-frontier
    component, not the bounded display sample.
    """
    known = {tag.pk: tag for tag in tags}
    for alias in aliases:
        known[alias.canonical_id] = alias.canonical

    ids_by_key = defaultdict(set)
    for tag in known.values():
        ids_by_key[tag_key(tag.name)].add(tag.pk)

    targets_by_key = defaultdict(set)
    for alias in aliases:
        # Derive from the source name: ``name_key`` is only a repairable index.
        targets_by_key[tag_key(alias.name)].add(alias.canonical_id)

    parent = {tag_id: tag_id for tag_id in known}

    def find(tag_id):
        while parent[tag_id] != tag_id:
            parent[tag_id] = parent[parent[tag_id]]
            tag_id = parent[tag_id]
        return tag_id

    def union(left, right):
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    unsafe = set()
    conflict_ids = set()
    edges = defaultdict(set)
    for name_key, targets in targets_by_key.items():
        sources = ids_by_key.get(name_key, set())
        if len(targets) > 1:
            # The write path refuses this exact state. A single-hub read fails
            # closed, while bulk sitemap resolution records the affected
            # component and lets unrelated resources proceed.
            if conflicts is None:
                raise TagGraphConflict
            conflict_ids |= targets
            conflict_ids |= sources
            continue
        for source in sources:
            for target in targets:
                if target in known:
                    union(source, target)
                    # A casefold-equivalent canonical spelling can be in the
                    # same identity set as the alias source. Its derived
                    # edge is therefore a self-edge (for example,
                    # ``STRASSE -> straße`` has ``tag_key == "strasse"``).
                    # Self-edges are no-op aliases, not directed cycles; only
                    # retain edges that actually move to another tag.
                    if source != target:
                        edges[source].add(target)

    # Mark directed cycles unsafe. Use an explicit DFS stack: the public bound
    # is deliberately much larger than Python's recursion limit, and a long
    # imported chain must fail closed rather than turn into an unhandled 500.
    visiting = set()
    visited = set()
    for start in known:
        if start in visited:
            continue
        path = []
        path_index = {}
        stack = [(start, iter(edges[start]))]
        visiting.add(start)
        path_index[start] = 0
        path.append(start)
        while stack:
            node, targets = stack[-1]
            try:
                target = next(targets)
            except StopIteration:
                stack.pop()
                visiting.remove(node)
                visited.add(node)
                path_index.pop(node, None)
                path.pop()
                continue
            if target in visiting:
                unsafe |= set(path[path_index[target]:])
                continue
            if target in visited:
                continue
            visiting.add(target)
            path_index[target] = len(path)
            path.append(target)
            stack.append((target, iter(edges[target])))

    unsafe_components = defaultdict(set)
    for tag_id in known:
        unsafe_components[find(tag_id)].add(tag_id)
    unsafe_roots = {
        component_root: min(component)
        for component_root, component in unsafe_components.items()
        if component & unsafe
    }

    if conflicts is not None and conflict_ids:
        conflict_roots = {
            find(tag_id) for tag_id in conflict_ids if tag_id in parent
        }
        conflicts |= {
            tag_id for tag_id in known
            if find(tag_id) in conflict_roots
        }

    roots = {}
    for tag_id, tag in known.items():
        component_root = find(tag_id)
        if component_root in unsafe_roots:
            roots[tag_id] = unsafe_roots[component_root]
            continue

        current = tag_id
        seen = set()
        while current not in seen:
            seen.add(current)
            current_tag = known[current]
            targets = targets_by_key.get(tag_key(current_tag.name), set())
            if len(targets) != 1:
                break
            target = next(iter(targets))
            if target == current or target not in known:
                break
            current = target
        roots[tag_id] = current
    return roots, known


def _expand_hub_alias_group(tags, aliases=None):
    """Return the live ``Tag`` rows in the aliases' public hub groups.

    ``TagAlias`` is deliberately unique on ``(name_key, canonical)``. A
    normalization run therefore records one alias row for a whole
    case/whitespace group, not one row for every still-live ``Tag`` spelling.
    Walking alias rows and treating their names as an exhaustive list would
    silently strand any other spelling left live by a non-consolidating run.

    Use aliases only to identify the canonical roots and their identity keys;
    enumerate the actual ``Tag`` rows and group them with the same
    ``tag_key()`` used by normalization. ``TagIdentity.name_key`` makes this
    component lookup exact and indexed. The result can still contain many live
    spellings, but that is the data the hub must count; only the serialized
    ``names`` list is capped later.
    """
    if not tags:
        return []

    tags = list(tags)
    if aliases is None:
        aliases = _hub_aliases(tags)
    if not aliases:
        return tags

    # Include the direct collision spellings as well as every identity key
    # represented by an alias of one of the roots. This covers an arbitrary
    # alias and the case/whitespace group that caused the lower-vs-casefold
    # slug divergence in.
    group_keys = {tag_key(tag.name) for tag in tags}
    for alias in aliases:
        group_keys.add(alias.name_key)
        group_keys.add(tag_key(alias.name))
        group_keys.add(tag_key(alias.canonical.name))

    # The projection is an indexed accelerator. The direct source lookup in
    # `tags_for_slug()` remains authoritative for every spelling that can
    # produce the requested slug. Also query the exact source spellings named
    # by the alias component: this catches a live raw/bulk-imported tag whose
    # `TagIdentity` row is missing, including casefold spellings such as
    # `STRASSE` alongside `straße`, without scanning unrelated tag rows.
    source_names = {
        name
        for alias in aliases
        for name in (alias.name, alias.canonical.name)
        if name
    }
    source_matches = Q()
    for name in source_names:
        source_matches |= Q(name__iexact=name)
    source_tags = list(
        Tag.objects.filter(source_matches)
        .only("pk", "name")
        .order_by("pk")[: TAG_HUB_MAX_COMPONENT_TAGS + 1]
    )
    if len(source_tags) > TAG_HUB_MAX_COMPONENT_TAGS:
        raise TagGraphTooLarge
    source_tags = [
        tag for tag in source_tags if tag_key(tag.name) in group_keys
    ]
    try:
        identities = list(
            TagIdentity.objects.filter(name_key__in=group_keys)
            .select_related("tag")
            .order_by("tag_id")[: TAG_HUB_MAX_COMPONENT_TAGS + 1]
        )
    except (OperationalError, ProgrammingError) as exc:
        if "tagging_tagidentity" not in str(exc).lower():
            raise
        # During the add-table half of migration 0003, the direct source rows
        # and alias canonicals above still provide a complete answer for this
        # request. The next maintenance pass will populate the accelerator.
        identities = []
    if len(identities) > TAG_HUB_MAX_COMPONENT_TAGS:
        raise TagGraphTooLarge
    expanded = [identity.tag for identity in identities] + source_tags

    # A manually-created alias may point at a live spelling whose key was not
    # selected by the normalized group above. Preserve the originally
    # resolved tags in that case; they are still part of the requested hub.
    by_id = {tag.pk: tag for tag in expanded}
    by_id = {**by_id, **{tag.pk: tag for tag in tags}}
    return [by_id[tag_id] for tag_id in sorted(by_id)]


def tags_for_hub_slug(slug):
    """Resolve one public hub to ``(canonical_slug, live_tag_rows)``.

    A live alias normally looks like an ordinary tag to ``tags_for_slug``.
    When its ``tag_key`` maps to a different canonical tag, the canonical tag
    owns the public URL even if the alias ``Tag`` row still has memberships.
    The returned rows include both sides, so redirecting the URL cannot make
    the alias-only pages unreachable.

    A purely historical alias has no live ``Tag`` row to find directly; keep
    the existing alias-slug fallback for that URL shape. The caller can then
    issue the same canonical hub response and redirect exactly once.
    """
    direct = tags_for_slug(slug)
    if not direct:
        canonical = canonical_slug_for_alias(slug)
        if not canonical:
            return slug, []
        direct = tags_for_slug(canonical)
        if not direct:
            return canonical, []
        aliases = _alias_component(direct)
        return canonical, _expand_hub_alias_group(direct, aliases)

    sample_aliases = _hub_aliases(direct, slug)
    group_aliases = _alias_component(direct, sample_aliases)
    expanded = _expand_hub_alias_group(direct, group_aliases)
    roots, known = _alias_root_ids(expanded, group_aliases)
    root_ids = {roots[tag.pk] for tag in expanded if tag.pk in roots}
    canonical_ids = {
        root_id for root_id in root_ids
        if root_id in known and slugify_tag(known[root_id].name) != slug
    }
    requested_slug_roots = {
        root_id for root_id in root_ids
        if root_id in known and slugify_tag(known[root_id].name) == slug
    }
    if canonical_ids and requested_slug_roots:
        # The requested URL contains both an alias component and an unrelated
        # live tag that owns this same lossy slug. Redirecting to the alias
        # root would strand the unrelated tag's pages from the public URL.
        raise TagGraphConflict
    if len(canonical_ids) > 1:
        # A lossy URL cannot safely choose between distinct canonical roots.
        # Fail closed rather than making insertion order decide which live hub
        # owns the shared URL.
        raise TagGraphConflict
    canonical_slug = (
        slugify_tag(known[next(iter(canonical_ids))].name)
        if canonical_ids else slug
    )

    return canonical_slug, expanded


def bulk_canonical_representatives(tags):
    """Map candidate live tags to canonical public slugs in bulk.

    Sitemap generation must not call the hub resolver once per candidate slug.
    This identifies alias-bearing candidates in bulk, then resolves each
    candidate's component with the same root algorithm used by the request
    path. Component bounds are local to a candidate's hub: an oversized or
    conflicting history cannot abort unrelated sitemap resources. The common
    no-alias path remains a fixed-query bulk operation.

    The returned value is ``canonical_slug -> canonical root id``. A canonical
    root whose own usage is below the sitemap quality gate may still be the
    representative for a qualifying live variant, which preserves the existing
    conservative gate without serializing the variant's spelling.
    """
    candidates = list(tags)
    if not candidates:
        return {}
    representatives = {}
    candidate_ids = {tag.pk for tag in candidates}
    candidate_keys = {tag_key(tag.name) for tag in candidates}

    # Do not seed one alias-component walk with the entire sitemap corpus: a
    # single historical canonical with a large alias history must not trip the
    # component bound for every otherwise-clean sitemap resource. These two
    # indexed DISTINCT probes identify the small subset that needs a local
    # walk; the no-alias path remains a fixed-query bulk operation.
    aliased_canonical_ids = set(
        TagAlias.objects.filter(canonical_id__in=candidate_ids)
        .values_list("canonical_id", flat=True)
        .distinct()
    )
    # `name_key` is repaired from `name` by migration 0003 and by the write
    # path. The complete component walk still derives every edge from the
    # source name, so a bulk/raw stale row is safe once its canonical candidate
    # has been identified through the indexed arms above.
    aliased_name_keys = set(
        TagAlias.objects.filter(name_key__in=candidate_keys)
        .values_list("name_key", flat=True)
        .distinct()
    )
    aliased_ids = {
        tag.pk for tag in candidates
        if tag.pk in aliased_canonical_ids
        or tag_key(tag.name) in aliased_name_keys
    }

    for tag in candidates:
        if tag.pk not in aliased_ids:
            root = tag
            root_id = tag.pk
        else:
            try:
                component = _alias_component([tag])
            except TagGraphTooLarge:
                # Fail closed for this tag's hub only. The index can still
                # publish all unrelated representatives.
                continue
            conflicted = set()
            roots, known = _alias_root_ids(
                [tag], component, conflicts=conflicted
            )
            if tag.pk in conflicted:
                continue
            root_id = roots.get(tag.pk, tag.pk)
            if root_id in conflicted:
                continue
            root = known.get(root_id, tag)
        slug = slugify_tag(root.name)
        if not slug:
            continue
        representatives[slug] = min(
            representatives.get(slug, root_id), root_id
        )
    return representatives


def canonical_slug_for_alias(slug):
    """The slug a purely-aliased spelling should redirect to, or ``None``.

     records ``ZCASh -> zcash`` as a:class:`TagAlias` rather than
    destroying the variant. A hub for the alias would be duplicate content, so
    ``/tag/<alias slug>`` sends a 301 to the canonical tag's own slug.

    THIS IS NOT THE THING  REVERSED, and the distinction is worth being
    precise about because the words look identical.  is about FILTERS:
    ``?tags=`` used to swap the caller's spelling for the canonical one, which
    narrowed the query and made variant-carrying pages unreachable by any term,
    so read paths now WIDEN through the whole alias group. That is still true
    here -- ``_tag_group_condition`` in ``g12f/views/zpage.py`` is what lists
    the hub's pages, and it widens. What redirects is the URL, and it must:
    two indexable URLs over one result set is the duplicate-content shape this
    whole route exists to remove. Widening loses no page; redirecting the URL
    loses no page either, because the canonical hub's filter reaches the same
    corpus.

    Only consulted when:func:`tags_for_slug` found nothing: a spelling that is
    still a live tag is resolved by:func:`tags_for_hub_slug`, which first
    widens the live alias group and then chooses the canonical slug.
    """
    if not is_canonical_slug(slug):
        return None
    indexed = list(
        TagAlias.objects.filter(slug=slug)
        .select_related("canonical")
        .order_by("pk")[: TAG_ALIAS_MAX_SOURCE_CANDIDATES + 1]
    )
    if len(indexed) > TAG_ALIAS_MAX_SOURCE_CANDIDATES:
        raise TagGraphTooLarge
    matched = Q(name__iexact=slug) | Q(name__iexact=slug.replace("-", " "))
    pattern = _candidate_regex(slug)
    if pattern is not None:
        matched |= Q(name__iregex=pattern)
    source_matches = list(
        TagAlias.objects.filter(matched)
        .select_related("canonical")
        .order_by("pk")[: TAG_ALIAS_MAX_SOURCE_CANDIDATES + 1]
    )
    if len(source_matches) > TAG_ALIAS_MAX_SOURCE_CANDIDATES:
        raise TagGraphTooLarge
    candidates = {alias.pk: alias for alias in indexed + source_matches}
    candidates = {
        alias_id: alias
        for alias_id, alias in candidates.items()
        if slugify_tag(alias.name) == slug
    }
    if not candidates:
        return None
    # The component walk uses indexed frontiers. In particular, it does not
    # reload the full alias table once per candidate spelling.
    for alias in candidates.values():
        try:
            component = _alias_component([alias.canonical], [alias])
        except TagGraphTooLarge:
            # A pathological historical alias component must not turn an
            # otherwise unknown URL into a global 503. The bounded redirect
            # lookup fails closed to the normal 404 for this spelling.
            continue
        roots, known = _alias_root_ids([alias.canonical], component)
        root_id = roots.get(alias.canonical_id, alias.canonical_id)
        canonical_tag = known.get(root_id, alias.canonical)
        canonical = slugify_tag(canonical_tag.name)
        if canonical and canonical != slug:
            return canonical
    return None
