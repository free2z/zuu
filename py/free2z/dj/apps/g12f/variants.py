"""Keep:class:`ZPageVariant` in step with the legacy content shape ( M3).

The variant table is the target model ( §3.1): every language of a zPage
is a row, including the source. The legacy shape -- source content in columns
on ``zPage``, translations in ``ZPageTranslation`` -- is still the *only* read
path. This module is the bridge: every write to the legacy shape mirrors into
the variant table so that when M5 flips reads, the data is already there and
already correct.

Three properties everything here is built around:

**Idempotent.** Every function is an upsert keyed on something stable. Running
the M2 backfill twice, or running it against rows dual-write already created,
changes nothing. That is what makes the backfill safe to resume after an
interrupted deploy.

**Inside the caller's transaction.** ``AtomicMiddleware`` already wraps every
POST/PUT/PATCH in ``transaction.atomic``, so these calls commit or roll back
with the legacy write they mirror. There is deliberately no network I/O, no
task enqueue and no ``on_commit`` hook here -- a mirror write that can outlive
its own transaction is not a mirror.

**Fail-soft is NOT an option.** A swallowed exception here would let the two
shapes drift silently, and drift is only discovered at M5 when reads flip.
Exceptions propagate and roll the whole write back. The kill switch
(``settings.ZPAGE_VARIANT_DUAL_WRITE``) is the escape hatch instead: flipping
it off stops mirroring entirely, and nothing a reader can see changes --
**while the legacy shape is still what readers read.** flipped
``ZPAGE_VARIANT_READS`` on, that condition no longer holds in production, so
the switch is inert while reads are on. See:func:`dual_write_enabled`.

Known gaps, all of which M5 must close before it flips reads
------------------------------------------------------------
1. A queryset ``.update()`` fires no signal, so it does not mirror. The one
   such write that matters -- ``g12f.publish_zpage``'s compare-and-set --
   calls:func:`publish_source_variant` explicitly, in the same transaction.
   Any future bulk write must do the same.
2. The rolling-deploy window. Migrations run before the new pods roll out, so
   old pods write the legacy shape with no mirror at all for the length of the
   rollout. The M2 backfill fills in *missing* rows on a re-run but does not
   repair a variant whose content diverged, or delete one whose legacy row is
   gone.
3. Turning the kill switch off and on again leaves exactly the same kind of
   hole.

All three want the same thing, and it is deliberately not in this wave:

    **M5 is blocked on a drift reconciler** -- the management command
    §3.2 calls for -- that walks both shapes and repairs content, publication
    state and orphans. "We re-ran the backfill" is not evidence the shapes
    agree.

That command is ``manage.py reconcile_zpage_variants``, and the pre-flight is
``--fail-on-drift`` exiting 0 **against production**. Two things about reading
its verdict:

- It used to compare the two shapes against each other and nothing else, so it
  could only see a variant the legacy shape has. ``origin='ai'`` rows are the
  ones paid translation  writes, and the checks that would have caught a
  malformed one were all scoped to ``source`` or ``human`` -- so the class was
  skipped entirely while the run still exited 0. It now sweeps
  ``ZPageVariant`` itself and validates each row on its own origin's terms,
  which are genuinely different terms: ``source_digest`` is required on an
  ``ai`` row and meaningless on a ``human`` one, and ``ai_model`` is
  required on neither, because ``SET_NULL`` makes its absence expected and
  pre- legacy rows may retain it on a ``human`` row.
- **Read the coverage block, not just the exit code.** It prints how many rows
  of each ``origin`` it examined and what it deliberately did not compare.
  Exit 0 over an empty sweep and exit 0 over the whole corpus are the same
  sentence; only the counts tell them apart.
"""
import hashlib
import logging

from django.conf import settings

from dj.apps.g12f.models.zpage import ZPageVariant

logger = logging.getLogger(__name__)

#Legacy ``zPage`` columns whose value is mirrored onto the source variant.
#A save that touches none of these (a vote bumping ``f2z_score``, the
#``tuzi_total`` accounting, a vanity edit) needs no mirror write, and skipping
#it keeps the hot vote path at exactly the query count it has today.
SOURCE_VARIANT_FIELDS = frozenset(
    {"title", "description", "content", "is_published", "source_language"}
)


def dual_write_enabled():
    """Whether M3 mirroring runs. **Inert while variant reads are on.**

    ``ZPAGE_VARIANT_DUAL_WRITE`` was written as an operational kill switch for
    the M3/M5 overlap, and the settings comment said what was true at the time:
    *"nothing reads the variant table yet, so turning this off degrades nothing
    a user can see."*  flipped ``ZPAGE_VARIANT_READS`` on in production,
    and that sentence stopped being true the moment it did.

    With reads on the mirror is not a mirror any more -- it is the **only** path
    from a creator's write to a reader's screen. Turning it off does not stop a
    redundant copy, it disconnects the site from the database:

    * a creator edits their article, the ``zPage`` columns update, the source
      variant does not, and every reader keeps being served the pre-edit title,
      description and body;
    * a new translation is written and never appears in any language menu;
    * a deleted translation stays live, because ``delete_translation_variant``
      is a no-op too.

    Every one of those writes returns 200. Nothing logs. The M2 backfill does
    not repair them either -- it POPULATES, and the diverged rows already
    exist -- so the damage outlives the incident and is only found by
    ``reconcile_zpage_variants``, if someone thinks to run it.

    So the switch is honoured only while the LEGACY shape is what readers read,
    which is exactly the state it was designed for and the documented
    ``ZPAGE_VARIANT_READS=false`` rollback state. It is deliberately kept
    rather than deleted: that rollback has to stay reachable until  M6
    finishes and the legacy shape stops being written at all.

    **Ignored, not refused, and never silently.** Nothing here can refuse a
    ConfigMap value -- by the time this runs the pod is booted and the operator
    is somewhere else. What it can do is say so: a false value read while reads
    are on logs a WARNING here (once per process, on the first mirrored write)
    and is reported by ``dj.apps.g12f.checks.check_zpage_variant_flags`` under
    ``manage.py check``, which CI and every management command run. An operator
    who edits the ConfigMap, restarts, and sees no change must be able to find
    out why from the logs rather than from this docstring.

    **Recovery, if mirroring itself is what is failing.** The mirror runs
    synchronously inside the caller's transaction and its exceptions propagate
    (see the module docstring, and the ``post_save``/``post_delete`` receivers
    in ``signals.py``), so a mirror that RAISES is a 500 on every zPage and
    ZPageTranslation save. Turning ``ZPAGE_VARIANT_READS`` off **first** does
    not stop that: this function then falls through to
    ``ZPAGE_VARIANT_DUAL_WRITE``, so the same mirror runs and rolls back the
    same writes -- an entire extra api+worker rollout of write outage, spent
    discovering nothing changed.

    Turn **both** off in ONE ConfigMap edit and ONE rollout: set
    ``ZPAGE_VARIANT_READS`` and ``ZPAGE_VARIANT_DUAL_WRITE`` to "false" in
    ``k8s/free2z/config.yaml``. Both are keys there precisely so this is a
    two-word edit and not a schema change made under pressure. Before this
    guard existed it was one word instead of two; the second is the price of
    making "read variants, do not write them" unreachable, and it is worth
    paying because that state is silent while a write outage is not.

    The cost of the single edit, stated: during the rollout, pods that have not
    restarted yet still READ variants that the restarted pods no longer WRITE,
    so a page edited inside that window reads stale until the rollout finishes.
    ``reconcile_zpage_variants --repair`` is the cleanup for exactly those rows.
    That is bounded and repairable; the ordering it replaces is neither.
    (codex adversarial review.)
    """
    # Ask the SAME function every reader asks, not a second copy of its
    # current body. ``localization`` imports this module, so a module-level
    # import here would cycle -- a function-body import does not, and that is
    # already how ``translation/tasks.py`` reaches into this package. The
    # duplication it replaces was the whole hole in miniature: the day
    # ``variant_reads_enabled()`` grows a condition (a per-namespace value, a
    # percentage rollout, a per-page override), an open-coded ``getattr`` here
    # silently stops covering the pods that are actually reading variants.
    from dj.apps.g12f.localization import variant_reads_enabled

    configured = getattr(settings, "ZPAGE_VARIANT_DUAL_WRITE", True)
    if not variant_reads_enabled():
        return configured
    if not configured:
        _warn_dual_write_is_ignored()
    return True


#One process says it once. The alternative -- a WARNING per mirrored write --
#is a log flood during exactly the incident an operator is trying to read.
_dual_write_ignored_warned = False


def _warn_dual_write_is_ignored():
    """Say out loud that a deliberately-set operational switch is being ignored.

    An operator who sets ``ZPAGE_VARIANT_DUAL_WRITE=false`` did so on purpose,
    almost certainly at 3am with writes failing, and this function is where
    that intent is discarded. Discarding it silently reintroduces one layer up
    the exact failure this guard exists to prevent: a change is made, nothing
    behaves differently, and nothing anywhere says why.

    Startup gets the same message from ``dj.apps.g12f.checks`` -- but system
    checks do not run under gunicorn or daphne, so this is the layer that fires
    in a live api pod. WARNING, not an exception: the ignored value is safe
    (mirroring stays on, which is the state that keeps readers current), so
    refusing to boot over it would turn a config nit into an outage.
    """
    global _dual_write_ignored_warned
    if _dual_write_ignored_warned:
        return
    _dual_write_ignored_warned = True
    logger.warning(
        "ZPAGE_VARIANT_DUAL_WRITE is set to false and is being IGNORED: "
        "ZPAGE_VARIANT_READS is on, so readers resolve content out of "
        "ZPageVariant and the mirror is the only path from a creator's write "
        "to a reader's screen. Mirroring stays ON. To actually stop it, set "
        "BOTH keys to \"false\" in k8s/free2z/config.yaml in ONE edit and "
        "restart api + worker -- see dual_write_enabled() (#980 M6, #1100)."
    )


def content_digest(content):
    """SHA-256 of a variant's content, used for ``source_digest`` staleness.

    Deliberately over the raw content only. It has to agree with whatever the
    translation job hashed when it wrote the variant, so it must not depend on
    the title (which a creator can retitle without invalidating a translation)
    or on any normalization that could change between releases.
    """
    return hashlib.sha256((content or "").encode("utf-8")).hexdigest()


def staleness(variant, source_variant):
    """Tri-state: ``True`` stale, ``False`` fresh, ``None`` unknown.

    ``None`` is not a decorative third case, it is the common one right after
    the M2 backfill: a translation copied out of ``ZPageTranslation`` has no
    recorded provenance, so we genuinely do not know which revision of the
    source it tracks. Collapsing that into ``True`` would label essentially
    every pre- translation "Stale" the day this ships -- the  failure,
    where a banner that fires on everything teaches people to ignore it.

    The source variant is never stale (it is what everything else is measured
    against), so it returns ``None`` too.
    """
    if variant.origin == ZPageVariant.SOURCE:
        return None
    if not variant.source_digest:
        return None
    if source_variant is None:
        return None
    return variant.source_digest != content_digest(source_variant.content)


def sync_source_variant(page):
    """Mirror a zPage's own content onto its ``origin="source"`` variant.

    Keyed on ``(zpage, origin="source")`` rather than on ``(zpage, language)``
    so that relabelling the article -- now that ``source_language`` is mutable
    -- *renames* the existing source row instead of minting a second one and
    tripping ``uniq_zpage_source_variant``.

    Returns the variant, or ``None`` when mirroring is disabled or when a
    translation variant already holds the target language. That collision is
    refused at the serializer boundary (see ``validate_source_language``), so
    reaching it here means a write path that bypassed validation; the source
    of truth this wave is still the legacy column, so we log and leave the
    variant table untouched rather than raise on a write that is otherwise
    correct.
    """
    if not dual_write_enabled():
        return None

    language = page.source_language
    if not language:
        # NULL is the  §3.2 representation of "detection has not run yet",
        # and `ZPageVariant.language` is NOT NULL -- a variant needs a language.
        # Migration 0100 skips these rows for exactly this reason; without the
        # same guard here, saving such a page raises IntegrityError from a
        # signal, which turns "we do not know the language" into "you cannot
        # save your article". The reconciler skips them too, so the row is
        # created the moment a language lands.
        logger.debug(
            "zpage %s: no source language yet, nothing to mirror", page.pk
        )
        return None

    conflict = (
        ZPageVariant.objects.filter(zpage_id=page.pk, language=language)
        .exclude(origin=ZPageVariant.SOURCE)
        .exists()
    )
    if conflict:
        # error, not warning: the legacy write has already happened (or is
        # about to commit) and the two shapes are now permanently out of step
        # for this page until a reconciler fixes it. Both validated write paths
        # -- the serializer and the admin form -- refuse this, so reaching here
        # means a direct ORM write, and it needs to be visible in the logs
        # rather than filed under routine noise.
        logger.error(
            "zpage %s: cannot mirror source variant, language %r is already "
            "held by a translation variant; the legacy and variant shapes now "
            "disagree for this page",
            page.pk, language,
        )
        return None

    variant, _ = ZPageVariant.objects.update_or_create(
        zpage_id=page.pk,
        origin=ZPageVariant.SOURCE,
        defaults={
            "language": language,
            "title": page.title,
            "description": page.description,
            "content": page.content,
            "is_published": page.is_published,
            # The source has nothing to be stale against, and no model wrote
            # it. Both are cleared unconditionally so a row that was somehow
            # promoted to source cannot keep a misleading provenance.
            "source_digest": None,
            "ai_model": None,
        },
    )
    return variant


def sync_translation_variant(translation):
    """Mirror one ``ZPageTranslation`` row onto its variant.

    Existing provenance belongs to the variant and survives content edits.
    A legacy translation with no variant has no provenance to preserve, so the
    model's ``human`` default applies when the mirror creates it.
    """
    if not dual_write_enabled():
        return None

    existing = ZPageVariant.objects.filter(
        zpage_id=translation.zpage_id, language=translation.language
    ).first()
    if existing is not None and existing.origin == ZPageVariant.SOURCE:
        # A translation row in the page's own source language. The API cannot
        # produce this (the serializer routes a same-language write to the
        # canonical path and DELETE refuses it), so it means hand-edited or
        # legacy data. The source variant is the canonical content; refusing
        # to overwrite it with a translation is the safe half of the choice.
        logger.warning(
            "zpage %s: translation %r collides with the source variant; "
            "not mirroring",
            translation.zpage_id, translation.language,
        )
        return None

    variant, _ = ZPageVariant.objects.update_or_create(
        zpage_id=translation.zpage_id,
        language=translation.language,
        defaults={
            "title": translation.title,
            "description": translation.description,
            "content": translation.content,
            "is_published": translation.is_published,
        },
    )
    return variant


def stamp_translation_source_digest(page, language):
    """Record the source revision a human translation was saved against.

    Called by the variant write path right after the legacy
    ``ZPageTranslation`` upsert, so the M3 mirror has already run and the row
    exists. AI variants keep the generation digest recorded at paid delivery:
    a creator edit does not prove the generated text incorporated a newer
    source. Returns how many human variants were stamped (0 when mirroring is
    off, no human variant exists, or the language is the page's own source).

    **Why this is not in**:func:`sync_translation_variant`. That runs from a
    ``post_save`` signal on ``ZPageTranslation`` and would have to fetch the
    parent zPage to hash its content -- an extra query and a full 100,000-
    character body on every translation save, including the ones that do not
    have the page in hand. The API write path already holds the parent, locked.

    **Why "the current source" is the honest answer for human work.**
    ``source_digest`` means "the revision of the source this translation was
    saved against". A creator saving a human translation is working
    from the article as it stands, so stamping the current digest asserts what
    happened -- unlike
    retro-stamping the backfilled corpus, which would claim a freshness nobody
    verified. That is why  leaves the ~4,300 backfilled rows ``NULL``: this
    only ever fires on a write we watched.

    **It does not rewrite AI generation provenance.** ``origin`` is untouched,
    and only ``human`` rows are stamped. Paid AI rows retain the digest and
    model recorded for the generated text, so later edits remain stale relative
    to that generation when the source has changed.

    **Known residual: the stale-tab window.** ``page.content`` here is the
    committed source under the parent lock ``_lock_zpage_for_variant_write``
    holds, so the read is not torn. What it cannot know is which revision the
    creator's EDITOR was showing: open a translation while the article reads A,
    change the article to B in another tab, save the translation, and this
    stamps B over a translation of A. ``is_stale`` then says ``false`` about
    text that is not current. Closing it means the write declaring the source
    revision it was made from -- an ``If-Match``-style precondition, which under
    the repo's own rule has to be a declared ``OpenApiParameter`` with its
    failure mode spelled out, plus an editor that sends it. That is its own
    change; it is named here so the gap is on the record rather than implied by
    silence. (codex adversarial review.)
    """
    if not dual_write_enabled():
        return 0
    if not language or language == page.source_language:
        return 0
    return ZPageVariant.objects.filter(
        zpage_id=page.pk,
        language=language,
        origin=ZPageVariant.HUMAN,
    ).update(source_digest=content_digest(page.content))


def occupied_translation(zpage_id, language, *, lock=False):
    """What actually occupies ``language`` on this page, in EITHER shape.

    ``(is_published, origin, digest)``, or ``None`` when the language is free.

    This exists because "is there already a translation here?" has two answers
    during the M3/M5 overlap and only one of them was ever being asked. A
    normal write mirrors into both tables, so for almost every row the legacy
    ``ZPageTranslation`` and the ``ZPageVariant`` agree and either lookup does.
    A **variant-only** row is not hypothetical, though:

    * old pods write the legacy shape unmirrored for the length of every
      rolling deploy, and the M2 backfill populates rather than repairs
      (see ``k8s/free2z/config.yaml`` on ``ZPAGE_VARIANT_READS``);
    * ``reconcile_zpage_variants`` cannot see ``origin='ai'`` rows at all
      , so drift in exactly this direction is the least likely to be
      caught;
    * and since reads flipped to variants, such a row is what a **reader**
      sees.

    Asking only the legacy table therefore reports "nothing here" about a
    translation that is live on the site. Every caller of this is a guard
    protecting live content from machine output, and a guard that cannot see
    the thing it guards is not a guard. (codex adversarial review,  P8:
    charged destruction of a published translation.)

    The legacy row wins when both exist: it is the shape the writer is about
    to modify, and the mirror is derived from it.

    ``digest`` covers **title, description and content**, not content alone.
    Delivery overwrites all three, so a digest over one of them lets a creator
    who polished only their translated title lose it silently: the check passes,
    the job delivers, and no refund is owed because nothing failed. The digest
    has to span exactly what the write touches. (codex adversarial review.)

    ``lock=True`` takes ``SELECT... FOR UPDATE`` on whichever rows exist, for
    the delivery path that re-checks under the parent's lock.
    """
    from dj.apps.g12f.models.zpage import ZPageTranslation

    translations = ZPageTranslation.objects.filter(
        zpage_id=zpage_id, language=language
    )
    variants = ZPageVariant.objects.filter(
        zpage_id=zpage_id, language=language
    ).exclude(origin=ZPageVariant.SOURCE)
    if lock:
        translations = translations.select_for_update()
        variants = variants.select_for_update()

    translation = translations.first()
    variant = variants.first()

    if translation is None and variant is None:
        return None

    if translation is not None:
        return (
            # Published in EITHER shape means reader-visible somewhere, and
            # "somewhere" is enough to refuse an overwrite. A mirror that says
            # published while its legacy row says draft is drift, and drift
            # resolves toward not destroying anything.
            translation.is_published
            or (variant is not None and variant.is_published),
            variant.origin if variant is not None else None,
            translation_digest(translation),
        )

    return (variant.is_published, variant.origin, translation_digest(variant))


def translation_digest(row):
    """Digest of everything a delivery would overwrite on ``row``.

    ``ZPageTranslation`` and ``ZPageVariant`` share these three field names, so
    one function covers both shapes -- which is the point: the purchase records
    this digest and the worker re-computes it, and they must be computing the
    same thing about the same fields.
    """
    # Length-prefixed, not joined by a separator. A plain join is ambiguous:
    # `("A", "", "B\n\nC")` and `("A", "B", "C")` are different drafts that
    # hash the same, and a creator who made exactly that edit while a paid job
    # ran would pass the guard and lose all three fields. Prefixing each field
    # with its length makes the encoding injective. (codex adversarial review.)
    parts = (row.title or "", row.description or "", row.content or "")
    return content_digest("".join(f"{len(part)}:{part}" for part in parts))


def delete_translation_variant(zpage_id, language):
    """Drop the mirrored variant for a deleted translation.

    Excludes the source variant so a legacy same-language row (see
    :func:`sync_translation_variant`) cannot delete the article's own content
    on its way out.
    """
    if not dual_write_enabled():
        return 0

    deleted, _ = (
        ZPageVariant.objects.filter(zpage_id=zpage_id, language=language)
        .exclude(origin=ZPageVariant.SOURCE)
        .delete()
    )
    return deleted


def publish_source_variant(zpage_id, when):
    """Mirror the scheduled-publish compare-and-set onto the source variant.

    ``g12f.publish_zpage`` flips ``is_published`` with a filtered queryset
    ``.update()`` -- deliberately, because that single statement is the
    atomic guard against a double publish -- and a queryset update fires no
    ``post_save``. Without this call, every scheduled publication would leave
    the source variant claiming the page is still a draft.

    A queryset update here too, for the same reason it is one there: the page
    row is already locked by the caller's UPDATE, and loading a whole zPage to
    save one boolean would be a second full-content round trip. ``updated_at``
    is set explicitly because ``.update()`` bypasses ``auto_now``.
    """
    if not dual_write_enabled():
        return 0

    return ZPageVariant.objects.filter(
        zpage_id=zpage_id, origin=ZPageVariant.SOURCE
    ).update(is_published=True, updated_at=when)
