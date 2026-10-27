"""Optimistic concurrency for zPage writes: strong ETags + `If-Match`.

Every zPage write used to be last-write-wins. Two tabs, or a tab plus the API,
or a tab plus an AI translation landing, could all read the same article and
each save the whole body over the top of the others. Nothing was reported to
anybody; the loser's paragraphs simply stopped existing. That is content a
creator cannot get back, so the fix is a real precondition rather than a
warning banner.

This module is the whole mechanism: derive a validator from the state a write
would replace, hand it to the client on the read, and refuse the write with
**412** if the validator no longer matches.

Three decisions are worth stating, because each of them is a place a
plausible-looking implementation goes wrong.

**The validator covers *editable state*, not the rendered bytes.**
``updated_at`` alone is not enough ( says so explicitly), so the digest
also covers the columns a write can change. It deliberately does **not** cover
the denormalized counters the serializer renders — ``total``, ``tuzi_total``,
``f2z_score``. Those move when a *reader* tips the article, and a validator
that moved with them would fail a creator's autosave because somebody sent
them money mid-sentence. That is a worse bug than the one being fixed.

Emitting a validator narrower than the representation is only safe because
nothing here turns it into a conditional GET: ``ConditionalGetMiddleware`` is
not installed (``dj/free2z/settings.py``), these responses carry no
``Cache-Control``, and no proxy in ``k8s/`` caches ``/api/``. The server
therefore always answers a GET with a full 200 — an ``If-None-Match`` can
never produce a 304 that withholds a fresh ``total``. If any of that changes,
this docstring is the thing that has to change with it.

**A translation's validator covers both shapes of the row.**  is
mid-rollout: ``ZPageTranslation`` is the legacy shape, ``ZPageVariant`` is the
new one, ``ZPAGE_VARIANT_READS`` decides which one *reads* answer from, and
writes dual-write both. Digesting only the read authority would make every
in-flight editor's validator go stale the moment that flag flipped. Digesting
both is authority-independent, and if the two shapes ever drift the digest
says so instead of hiding it.

**The check happens under the row lock, or it is theatre.** Read the current
digest, compare, then write, with nothing holding the row still, and two
requests both pass the comparison and both write — the exact race being
fixed, one round-trip narrower. Every caller here evaluates the precondition
against a ``SELECT... FOR UPDATE`` of the parent ``zPage`` inside the write's
own transaction.

The precondition is **optional**: a request with no ``If-Match`` behaves
exactly as it did before, which is what keeps every deployed client and every
third-party API consumer working. Making it required is a separate, staged
decision  that wants a measured 412 rate first.

**What the canonical validator deliberately does NOT cover: the article's
translations.** ``DELETE /api/zpage/{id}/`` cascades to every variant, so an
``If-Match`` that only signs the parent row cannot promise "nothing under this
article changed". Widening it was considered and rejected, because the cost
lands on the common path rather than the rare one: the editor itself buys AI
translations, so a draft variant landing minutes after the creator started
writing would invalidate their canonical validator and turn their own autosave
into "someone else saved this article" — a false accusation, on the exact
workflow  P8 built. The narrower promise is the honest one: `If-Match` on a
zPage write says *this article's own fields are unchanged*, and deleting an
article is still an explicit, confirmed act on the whole aggregate.
``test_delete_precondition_does_not_cover_translations`` pins that as a
decision rather than leaving it as an oversight. (codex adversarial review.)

**The language detector is not a second editor.** ``source_language``
is in the validator, and ``tasks.apply_detection`` rewrites it in the
background a few minutes after a save -- without touching ``updated_at`` or
anything else here. Before  that alone refused the creator's next
autosave: 7 of the 8 production 412s in one week came 3-67 s after a
detection, with nobody else editing.:func:`canonical_precondition` now
accepts a validator that differs from the current one **only** by a
detector-owned label, when the client says which label it saw
(``X-Free2Z-Source-Language``) and the write does not set the label itself.
The ETag format did not change, so a rolling deploy mixes old and new pods
safely; and a client that does not send the header -- including every editor
bundle older than, which cannot follow a relabel -- keeps the strict
comparison.

**Neither is the blank-page auto-tagger.** The ``zpage-tag``
subscriber adds AI tags to a published page that has none, a few seconds after
the save that published it -- with a bare ``tags.add()`` that moves no column.
Tags are in the validator, so without an allowance the editor still open on
that page would 412 on its next autosave and latch. The allowance is the same
shape as the relabel one and needs no header: a validator that equals the
current one with exactly the carried ``TagSuggestion.AUTO_APPLIED`` tags taken
out. When a write matches only that way the client provably never saw those
tags, so a ``tags`` list equal to what it did see means "unchanged" and is
dropped from the write (:func:`keep_unseen_auto_tags`) rather than replacing
the tag set and silently erasing them. A ``tags`` list that differs is the
creator choosing, and it replaces the set as it always has -- the creator wins.
"""

import hashlib

from rest_framework import serializers, status
from rest_framework.exceptions import APIException, ValidationError

IF_MATCH_HEADER = "If-Match"
IF_NONE_MATCH_HEADER = "If-None-Match"

#Columns of ``zPage`` that a canonical write can change, plus ``updated_at``.
#
#``updated_at`` is ``auto_now``, so it moves on every ``save()``. It is not
#enough on its own: it has finite resolution, and — the reason tags are
#digested separately in:func:`canonical_etag` — not every writer goes
#through ``save()``. The content columns are named explicitly because a
#digest that says which fields it covers is auditable in a way a bare
#timestamp is not.
CANONICAL_ETAG_FIELDS = (
    "title",
    "description",
    "content",
    "source_language",
    "vanity",
    "canonical_url",
    "category",
    "is_published",
    "is_subscriber_only",
    "publish_at",
    "p2paddr",
    "goal",
    "featured_image_id",
    "enclosure_id",
    "updated_at",
)

#Columns of one translation row, in both shapes. ``ZPageVariant`` carries two
#extra columns (``origin``, ``source_digest``); a row that lacks them digests
#them as absent, which is exactly how ``ZPageTranslation`` differs from it.
TRANSLATION_ETAG_FIELDS = (
    "language",
    "title",
    "description",
    "content",
    "is_published",
    "updated_at",
)
VARIANT_ETAG_FIELDS = TRANSLATION_ETAG_FIELDS + ("origin", "source_digest")


class PreconditionFailed(APIException):
    """412 — the client's ``If-Match`` does not describe the current state.

    Not a 409. A 409 on these routes means "this write can never be right as
    written" (a language already taken, a translation ceiling reached). A 412
    means "this exact write was right a moment ago and is not any more" — the
    remedy is to re-read and re-apply, which is a different thing for a client
    to do and must therefore be a different status code.
    """

    status_code = status.HTTP_412_PRECONDITION_FAILED
    default_detail = (
        "This page changed since you loaded it. Reload before saving so you "
        "do not overwrite the newer version."
    )
    default_code = "precondition_failed"


class CreateConflict(PreconditionFailed):
    """412 -- ``If-None-Match: *`` on a write whose target already exists.

    The create-only twin of:class:`PreconditionFailed`. Two tabs that both saw
    "no French yet" both PUT ``/variants/fr/``; without this the serializer's
    upsert made the second one silently replace the first one's brand-new
    translation. Same status, because the remedy is the same -- re-read, then
    decide -- but a different sentence, because "somebody changed what you
    loaded" is false here: there was nothing loaded to change.

    The sentence does not accuse a second person. A retried save whose first
    attempt committed (a proxy 502, a timeout) and an AI translation delivered
    into that language both produce this too.
    """

    default_detail = (
        "A version in this language already exists -- another tab, an AI "
        "translation or an earlier save created it. Reload to see it before "
        "saving over it."
    )
    default_code = "create_conflict"


class PreconditionFailedSerializer(serializers.Serializer):
    """The body a 412 actually returns.

    Declared for the same reason ``ConflictDetailSerializer`` is: ``412: None``
    generates ``void`` in the orval client, and then the editor has nothing to
    show but "Failed to save article" — the withholding-the-useful-fact
    failure  explicitly asks not to repeat.
    """

    detail = serializers.CharField(
        read_only=True,
        help_text=(
            "Human-readable and actionable — show it to the creator verbatim. "
            "A 412 is recoverable: reload the article and re-apply the edit."
        ),
    )


def _digest(*parts) -> str:
    """SHA-256 over an unambiguous rendering of ``parts``.

    ``repr`` rather than ``str``, and a separator that cannot occur in a
    rendered value, so ``("a", "b")`` and ``("ab",)`` cannot collide into the
    same validator — a collision here is a silently permitted clobber.
    """
    payload = "\x1f".join(repr(part) for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _normalize(value):
    """Render one column value identically whichever way the row was loaded.

    The read path digests a loaded ORM instance and the write path digests a
    fresh ``.values()`` row; if those two renderings ever disagree, every save
    that follows a save returns 412 on a page nobody else touched. Django hands
    back the same Python types either way, so this only has to make ``None``
    distinguishable from the string ``"None"`` and pin datetimes to a stable
    textual form. ``test_zpage_preconditions.py`` pins the equality directly
    rather than trusting this note.
    """
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _row_digest(row, fields) -> str:
    return _digest(*(_normalize(row.get(field)) for field in fields))


def quote_etag(digest: str) -> str:
    """Wrap a digest as a **strong** entity-tag.

    Strong, not weak (``W/``): the validator is exact, and ``If-Match``
    requires strong comparison anyway (RFC 9110 §13.1.1), so a ``W/`` prefix
    would make every precondition unusable.
    """
    return f'"{digest}"'


def canonical_etag(page) -> str:
    """Validator for the canonical article — the state a zPage write replaces.

    Tags are digested explicitly rather than trusted to ``updated_at``. An
    earlier draft of this file claimed they were covered transitively, because
    an API write goes through the serializer, which saves the row. That claim
    was false: ``dj.apps.tagging.services`` accepts an AI tag suggestion with a
    bare ``zpage.tags.add(...)``, which touches no column on ``zPage`` at all.
    A creator could accept a suggested tag on one surface and have their next
    conditional autosave pass its precondition and silently remove it again.
    (codex adversarial review.)

    ``page.tags.all()`` rather than ``page.tags.names()``: ``names()`` always
    issues its own query, while ``all()`` uses the prefetch cache the read path
    has already paid for.
    """
    return _canonical_etag_labelled(page, page.source_language)


def _canonical_etag_labelled(page, label, without_tag_keys=frozenset()) -> str:
    """:func:`canonical_etag` as it would be if ``source_language`` were ``label``
    and the tags whose ``tag_key`` is in ``without_tag_keys`` were absent.

    With both at their defaults this is byte-identical to the historical
    validator, so no deployed client or mixed-version pod sees a new format.
    """
    row = {field: getattr(page, field) for field in CANONICAL_ETAG_FIELDS}
    row["source_language"] = label
    names = [tag.name for tag in page.tags.all()]
    if without_tag_keys:
        from dj.apps.tagging.models import tag_key

        names = [name for name in names if tag_key(name) not in without_tag_keys]
    return quote_etag(
        _digest(
            _row_digest(row, CANONICAL_ETAG_FIELDS),
            sorted(names),
        )
    )


#``check_if_match`` return values naming WHICH validator matched.
MATCH_EXACT = "exact"
MATCH_ANY = "*"
MATCH_RELABEL = "relabel"
MATCH_AUTO_TAGS = "auto_tags"
MATCH_RELABEL_AUTO_TAGS = "relabel+auto_tags"


def matched_auto_tags(match) -> bool:
    """Did the precondition pass only by overlooking auto-applied tags?"""
    return match in (MATCH_AUTO_TAGS, MATCH_RELABEL_AUTO_TAGS)


def _unseen_auto_tag_keys(page) -> frozenset:
    from dj.apps.tagging.services import unseen_auto_applied_keys

    return unseen_auto_applied_keys(page)


def _canonical_alternates(page, claimed_label, *, writes_label) -> dict:
    """``{etag: MATCH_*}`` a client may hold besides the current validator.

    Each is "the page exactly as it is now, minus one background change the
    client has not seen": a detector relabel, auto-applied tags
    , or both. Any other difference still fails.
    """
    alternates = {}
    relabel = _detector_relabel_etag(
        page, claimed_label, writes_label=writes_label
    )
    if relabel is not None:
        alternates[relabel] = MATCH_RELABEL
    auto_keys = _unseen_auto_tag_keys(page)
    if auto_keys:
        alternates.setdefault(
            _canonical_etag_labelled(page, page.source_language, auto_keys),
            MATCH_AUTO_TAGS,
        )
        if relabel is not None:
            alternates.setdefault(
                _canonical_etag_labelled(page, claimed_label, auto_keys),
                MATCH_RELABEL_AUTO_TAGS,
            )
    return alternates


def keep_unseen_auto_tags(serializer, page) -> bool:
    """Drop ``tags`` from a validated write that would only erase unseen AI tags.

    Call ONLY when:func:`matched_auto_tags` is true for this request, after
    ``is_valid()`` and before ``save()``, with the locked page. The client's
    validator proves it never saw the auto-applied tags, so if the ``tags`` it
    sent equal the tags it DID see, it is not asking to remove anything -- it
    is echoing its stale copy, as every Svelte autosave does. Returns whether
    the field was dropped. A different list is the creator choosing and is
    left alone.
    """
    from dj.apps.tagging.models import tag_key

    data = serializer.validated_data
    if "tags" not in data:
        return False
    unseen = _unseen_auto_tag_keys(page)
    if not unseen:
        return False
    seen = {tag_key(name) for name in page.tags.names()} - unseen
    sent = {tag_key(name) for name in (data["tags"] or [])}
    if sent != seen:
        return False
    data.pop("tags")
    return True


def _detector_relabel_etag(page, claimed_label, *, writes_label):
    """The validator a client held before a detector relabel, or ``None``.

    ``None`` -- no allowance, strict comparison only -- unless every one of
    these holds:

    * the client said which label it last saw (``claimed_label``, from the
      ``X-Free2Z-Source-Language`` header). A client that does not say is
      treated as one that cannot follow a relabel. That is not hypothetical:
      an editor bundle from before  that was let through here would
      adopt the new label from the save response, stop recognising the page
      as canonical, and PUT the article body to ``/translations/<old>/`` as
      a brand-new translation on its next autosave;
    * that label is not the current one;
    * the current label is the **detector's** (``language_source='detected'``).
      A human relabel mints ``creator`` (``signals.zpage_language_provenance``)
      and goes through ``save()``, which moves ``updated_at`` -- so it could
      never match below anyway; this makes the intent explicit;
    * the write does not set the label (``writes_label=False``). A client
      that last saw ``en`` sending ``source_language: "en"`` after the detector
      moved it to ``es`` is indistinguishable from a full-object client
      echoing back a stale read. Letting that through would mint
      ``language_source='creator'`` on a stale value and lock the detector out
      of the page for good. It 412s, the reload shows the new label, and the
      creator decides again.

    Then the allowance is exact: the tag must equal the digest of the page *as
    it is now* with only the label swapped back. Any other change since the
    client read it -- a second editor's paragraph, a tag, anything that moved
    ``updated_at`` -- still fails.
    """
    from dj.apps.g12f.models.zpage import LANGUAGE_SOURCE_DETECTED

    if writes_label or not claimed_label:
        return None
    if claimed_label == page.source_language:
        return None
    if page.language_source != LANGUAGE_SOURCE_DETECTED:
        return None
    return _canonical_etag_labelled(page, claimed_label)


def canonical_precondition(page, *, claimed_label=None, writes_label=False):
    """``(current_etag, also_matches)`` for:func:`check_if_match`.

    ``current_etag`` is:func:`canonical_etag`. ``also_matches`` is ``None``,
    or maps exactly the extra tags:func:`_canonical_alternates` describes to
    the ``MATCH_*`` reason: this page, unchanged since the client read it
    except for a background relabel the write does not touch and/or
    auto-applied tags.
    """
    alternates = _canonical_alternates(
        page, claimed_label, writes_label=writes_label
    )
    if not alternates:
        return canonical_etag(page), None
    return canonical_etag(page), alternates.get


def canonical_etag_from_db(page_model, pk):
    """The same validator, recomputed from a fresh row.

    A write response must carry the validator the *next* GET will emit, or the
    client's following autosave 412s against a page nobody else touched.
    ``post_save`` receivers here do targeted ``.update()`` calls that the saved
    instance never sees (``g12f.zpage_language_detection`` writes
    ``language_source``), and the in-memory instance's tag cache is whatever it
    was before the write. So the row is re-read.

    Deliberately ``canonical_etag`` of a freshly loaded instance rather than a
    second digest implementation over ``.values()``: two code paths that must
    produce byte-identical digests are two chances to diverge, and the symptom
    of divergence — every save after a save returning 412 — looks exactly like
    the bug this feature is supposed to prevent.
    """
    page = page_model.objects.filter(pk=pk).first()
    if page is None:
        return None
    return canonical_etag(page)


def variant_etag(page, language, *, translation_model, variant_model):
    """Validator for one language of a zPage, or ``None`` if it does not exist.

    A write to the page's own ``source_language`` is a canonical write — the
    serializer routes it to the ``zPage`` columns — so its validator is the
    canonical one. That is not a special case bolted on; it is the same
    statement  §3.1 makes, that the source is a variant like any other.

    For a translation, both shapes of the translation row are digested (see the
    module docstring) **and so is the canonical article**. That last part is
    not belt-and-braces. A PUT to ``/variants/fr/`` runs
    ``zPageUpdateSerializer``, which routes the localized title/description/
    content to the translation row *and* writes ``vanity``, ``p2paddr``,
    ``canonical_url``, ``category``, ``featured_image``, ``is_subscriber_only``
    and ``tags`` straight onto the parent ``zPage``. A validator that signed
    only the translation row would let a stale French editor pass its
    precondition and restore a payout address the creator had just rotated
    away from — a conditional write quietly undoing the change it exists to
    protect. (codex adversarial review.)

    ``None`` means no row in either shape, which makes any ``If-Match`` on that
    resource fail — including ``*``, whose RFC 9110 meaning is "a
    representation exists".
    """
    return variant_precondition(
        page, language,
        translation_model=translation_model, variant_model=variant_model,
    )[0]


def variant_etags(page, languages, *, translation_model, variant_model):
    """Batch the exact variant validators for several languages.

    The translation tray calls this while holding the parent row lock. A
    per-language ``variant_etag`` re-reads the parent, canonical tags, legacy
    row and mirror row each time; this batches those reads so draft count does
    not multiply lock hold time.
    """
    languages = tuple(dict.fromkeys(languages))
    if not languages:
        return {}
    fresh = (
        type(page).objects.prefetch_related("tags")
        .filter(pk=page.pk)
        .first()
    )
    if fresh is None:
        return dict.fromkeys(languages)
    canonical = canonical_etag(fresh)
    legacy_rows = {
        row["language"]: row
        for row in translation_model.objects.filter(
            zpage_id=page.pk, language__in=languages
        ).values(*TRANSLATION_ETAG_FIELDS)
    }
    mirror_rows = {
        row["language"]: row
        for row in variant_model.objects.filter(
            zpage_id=page.pk, language__in=languages
        ).values(*VARIANT_ETAG_FIELDS)
    }
    result = {}
    for language in languages:
        if language == fresh.source_language:
            result[language] = canonical
            continue
        legacy = legacy_rows.get(language)
        mirror = mirror_rows.get(language)
        if legacy is None and mirror is None:
            result[language] = None
            continue
        rows = (
            _row_digest(legacy, TRANSLATION_ETAG_FIELDS) if legacy else None,
            _row_digest(mirror, VARIANT_ETAG_FIELDS) if mirror else None,
        )
        result[language] = quote_etag(_digest(canonical, *rows))
    return result


def variant_precondition(page, language, *, translation_model, variant_model,
                         claimed_label=None, writes_label=False):
    """``(current_etag, also_matches)`` for one language (see
    :func:`canonical_precondition`). ``current_etag`` is:func:`variant_etag`.

    A translation's validator embeds the canonical one, so a detector relabel
    of the source moved it too -- a translator's autosave was refused as well.
    The same allowance applies, with the canonical part swapped back. A
    translation write never sets the label (the serializer drops
    ``source_language`` on that path) and cannot re-route itself as the
    canonical article after one, so nothing is at stake there that the
    canonical allowance guards against.
    """
    fresh = type(page).objects.filter(pk=page.pk).first()
    if fresh is None:
        return None, None
    if language == fresh.source_language:
        return canonical_precondition(
            fresh, claimed_label=claimed_label, writes_label=writes_label
        )
    canonical = canonical_etag(fresh)

    legacy = (
        translation_model.objects.filter(zpage=page, language=language)
        .values(*TRANSLATION_ETAG_FIELDS)
        .first()
    )
    mirror = (
        variant_model.objects.filter(zpage=page, language=language)
        .values(*VARIANT_ETAG_FIELDS)
        .first()
    )
    if legacy is None and mirror is None:
        return None, None
    rows = (
        _row_digest(legacy, TRANSLATION_ETAG_FIELDS) if legacy else None,
        _row_digest(mirror, VARIANT_ETAG_FIELDS) if mirror else None,
    )
    current = quote_etag(_digest(canonical, *rows))
    alternates = {
        quote_etag(_digest(alternate, *rows)): reason
        for alternate, reason in _canonical_alternates(
            fresh, claimed_label, writes_label=False
        ).items()
    }
    if not alternates:
        return current, None
    return current, alternates.get


def parse_if_match(raw):
    """Split an ``If-Match`` field value into comparable entity-tags.

    Returns ``None`` when the header is absent (the precondition does not
    apply) and ``[]`` when it is present but contains nothing usable — which
    is *not* the same thing, and must fail rather than be waved through.
    ``W/`` tags are kept and will simply never match, which is the RFC 9110
    §13.1.1 outcome for a weak validator under strong comparison.
    """
    if raw is None:
        return None
    candidates = [tag.strip() for tag in raw.split(",")]
    return [tag for tag in candidates if tag]


def check_if_match(request, current_etag, also_matches=None):
    """Raise:class:`PreconditionFailed` unless the client saw current state.

    Call this **after** the row is locked and re-read, never before: the whole
    value of the check is that no other write can slip between the comparison
    and the update.

    Returns which validator matched: ``None`` (no header -- nothing was
    checked),:data:`MATCH_ANY`,:data:`MATCH_EXACT`, or whatever truthy
    reason ``also_matches`` returned for the tag. A caller that must know
    what the client did NOT see  reads it; the rest ignore it.
    """
    tags = parse_if_match(request.headers.get(IF_MATCH_HEADER))
    if tags is None:
        return None
    if not tags:
        raise PreconditionFailed(
            "The If-Match header was empty. Send the ETag returned by the "
            "article read, or omit the header entirely."
        )
    if "*" in tags:
        # RFC 9110 §13.1.1: `*` asserts only that a representation exists.
        if current_etag is None:
            raise PreconditionFailed(
                "This language has no saved version yet, so there is nothing "
                "to overwrite. Reload the editor."
            )
        return MATCH_ANY
    if current_etag is None:
        raise PreconditionFailed()
    if current_etag in tags:
        return MATCH_EXACT
    if also_matches is not None:
        for tag in tags:
            # Only a background change the client has not seen: a detector
            # relabel this write does not touch  and/or auto-applied
            # tags  -- see `canonical_precondition`.
            reason = also_matches(tag)
            if reason:
                return reason
    raise PreconditionFailed()


def check_if_none_match(request, current_etag):
    """Honour ``If-None-Match: *`` on a write -- "only if it does not exist yet".

    RFC 9110 §13.1.2: ``*`` is false when a current representation exists, and
    a false ``If-None-Match`` on an unsafe method is a 412. ``current_etag`` is
    the resource's validator, or ``None`` when it has no representation (the
    same convention:func:`check_if_match` uses). Call it under the same row
    lock as the write, after:func:`check_if_match` (RFC 9110 §13.2.2 order).

    Only ``*`` is supported. An entity-tag list on a write would mean "refuse
    if it is still in one of these states", which no client here needs; a value
    we do not implement is a **400**, never silently ignored -- a client that
    believes it is protected and is not is the failure this exists to remove.
    Presence, not truthiness, decides whether it applies: an empty value is a
    400 rather than a precondition that evaporated.

    Returns ``True`` when the precondition was evaluated (and held), ``None``
    when the header was absent.
    """
    if IF_NONE_MATCH_HEADER not in request.headers:
        return None
    raw = request.headers.get(IF_NONE_MATCH_HEADER) or ""
    if raw.strip() != "*":
        raise ValidationError({
            IF_NONE_MATCH_HEADER: (
                "Only `If-None-Match: *` (create only if it does not exist "
                "yet) is supported on writes. Omit the header, or send `*`."
            )
        })
    if current_etag is not None:
        raise CreateConflict()
    return True
