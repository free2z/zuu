"""One place that decides which zPage a URL segment names.

A zPage is addressable by two different strings — its immutable
``free2zaddr`` and its user-chosen ``vanity`` — and neither column is unique
*against the other*. Every route that accepts ``/{identifier}/`` therefore
needs the same precedence, or the same URL resolves to different pages
depending on which endpoint the caller hit.  fixed the detail route;
found ``/api/get-type/`` still disagreeing with it, so the rules live here now
and every caller shares them.

Precedence, highest first (see:func:`resolve_zpage_pk`):

1. ``free2zaddr`` exact
2. ``vanity`` exact
3. ``vanity`` == ``slugify(identifier)``
4. ``vanity__iexact``, lowest ``pk``
"""

import logging

from django.db.models import Case, IntegerField, Q, Value, When
from django.utils.text import slugify

from dj.apps.g12f.models import zPage

logger = logging.getLogger(__name__)


def resolve_zpage_pk(identifier):
    """Return the pk of the zPage that owns ``identifier``, or ``None``.

    Resolution is deliberately **identity-first and visibility-blind**: it
    answers "whose identifier is this?", never "may this caller see it?".
    Callers apply their own queryset to the returned pk and MUST fail closed
    when the pk is not in it — falling through to the next tier would let a
    public page whose vanity squats a hidden page's identifier win, which is
    the hijack  closed.

    The order is exact -> canonical -> case-insensitive:

    1. ``free2zaddr`` exact. The address is the page's identity and cannot be
       edited; a vanity is a nickname. Identity always wins, otherwise anyone
       could point their own vanity at another page's address and take over
       its URL. Exact only: the column is unique exactly, not
       case-insensitively, and this is the hot path (``UPPER(col) = UPPER(%s)``
       cannot use the unique index and seq-scans).
    2. ``vanity`` exact. What the row literally stores is its own canonical
       URL, so it must beat any normalized *reinterpretation* of the segment.
       ``vanity`` is a ``SlugField``, so legacy rows hold values that do not
       survive ``slugify`` (``-foo``, ``CoolStuff``) and are still perfectly
       legal, linked-to identifiers. Skipping this tier is  §1: with
       canonical-first, ``/-foo/`` served the unrelated ``foo`` page, and 404'd
       outright when ``foo`` was hidden.
    3. ``vanity`` == ``slugify(identifier)``. Every vanity written through the
       API is normalized, so this is what a mixed-case *link* to a modern page
       means. Preferring it over tier 4 is 's fix: ``/COOLSTUFF/`` resolves
       to the canonical ``coolstuff`` row rather than to whichever legacy
       case-variant happens to have the lower pk. Skipped when it would repeat
       tier 2's query.
    4. ``vanity__iexact``, lowest pk. The legacy fallback for links to
       mixed-case-only rows (``/COOLSTUFF/`` when only ``CoolStuff`` exists).
       Deterministic by pk so the answer never depends on row order, and loud
       when the data is ambiguous.
    """
    if not identifier:
        return None

    # The two exact tiers are one indexed query.  They remain ordered
    # explicitly because the columns are each unique but not unique against
    # each other: an attacker may put another page's address in their vanity,
    # and the immutable address must still win.  Keeping this query free of
    # ``vanity__iexact`` preserves the indexed hot path for normal links.
    pk = (
        zPage.objects.filter(
            Q(free2zaddr=identifier) | Q(vanity=identifier)
        )
        .annotate(
            _identifier_rank=Case(
                When(free2zaddr=identifier, then=Value(0)),
                When(vanity=identifier, then=Value(1)),
                output_field=IntegerField(),
            )
        )
        .order_by("_identifier_rank", "pk")
        .values_list("pk", flat=True)
        .first()
    )
    if pk is not None:
        return pk

    normalized = slugify(identifier)
    if normalized and normalized != identifier:
        pk = zPage.objects.filter(
            vanity=normalized
        ).values_list("pk", flat=True).first()
        if pk is not None:
            return pk

    legacy_pks = list(
        zPage.objects.filter(vanity__iexact=identifier)
        .order_by("pk")
        .values_list("pk", flat=True)[:2]
    )
    if not legacy_pks:
        return None
    if len(legacy_pks) > 1:
        # Two rows differing only by case: an operator has to look, because
        # one of those pages is unreachable by its own canonical URL.
        logger.critical(
            "Multiple zPage objects returned for vanity %s",
            identifier,
        )
    return legacy_pks[0]
