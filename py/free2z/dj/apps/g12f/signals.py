"""
zPage save-time side effects: cron sweeps become event-driven
Procrastinate jobs.

- Scheduled publishing: saving an unpublished page with publish_at set
  defers publish_zpage with schedule_at=publish_at — exact-time
  publishing instead of the up-to-5-minute publish_pages cron lag (that
  cron is demoted to a transitional hourly sweep). There is no
  cancellation machinery on purpose: if publish_at changes, we simply
  enqueue another job; obsolete jobs no-op because the task re-checks
  DB state at execution time (see tasks.py).

- Search indexing: saving a published source without variants defers
  index_zpage. A source with published translations uses the rollout-safe
  multilingual task, so an old worker cannot claim translation-aware work.
  Unpublishing a page that is still indexed defers index_zpage to remove it.

- Language detection ( M4): a zPage that has no real language, or
  whose text changed under a label the detector itself wrote, defers
  detect_zpage_language. This is what makes it impossible for ANY client
  — the classic React editor, the MCP server, mobile/ZUULI, a third
  party — to create an unlabelled zPage: no client has to know or declare
  anything. A human changing the label is stamped `creator` here too, in
  pre_save, because a rule enforced at one write path is not enforced.

- ZPageVariant dual write ( M3): every legacy content write mirrors
  into the variant table. Unlike everything else in this module this is
  NOT deferred — it is a plain DB write that must commit or roll back
  with the write it mirrors, because a mirror that can outlive its own
  transaction is not a mirror. See dj.apps.g12f.variants.

Enqueues run INSIDE the write's transaction, through
``dj.apps.jobs.transactional.defer_in_transaction``: the job row is
inserted on Django's own connection in a savepoint, so it commits or rolls
back with the save. This used to be ``transaction.on_commit``, which is NOT
transactional -- the callback is a separate statement after COMMIT, and a
process killed in between (or a failed INSERT) left a saved page with no
index/detection job and no trace of the loss.
"""
from datetime import timedelta

from django.db import transaction
from django.db.models.signals import post_delete, post_save, pre_delete, pre_save
from django.dispatch import receiver
from django.utils import timezone

from dj.apps.jobs.transactional import defer_in_transaction
from dj.apps.jobs.priorities import BACKGROUND
from dj.apps.search.tasks import index_multilingual_zpage, index_zpage

from .localization import is_content_language
from .models import Creator, Subscription, zPage, ZPageTranslation
from .models.zpage import (
    LANGUAGE_SOURCE_CREATOR,
    LANGUAGE_SOURCE_DETECTED,
)
from .tasks import (
    RENEWAL_LEAD,
    detect_zpage_language,
    publish_zpage,
    defer_renewal,
)
from .variants import (
    SOURCE_VARIANT_FIELDS,
    delete_translation_variant,
    sync_source_variant,
    sync_translation_variant,
)


MULTILINGUAL_INDEX_DELAY = timedelta(minutes=15)

# --- Language detection ( M4 / Part 5) --------------------------------- #
#
# The delay IS the coalescing mechanism, and it is the only thing standing
# between an editing session and one paid provider call per keystroke.
#
# A `queueing_lock` refuses a second enqueue only while the first job is still
# `todo`. With no delay a worker claims the job in about a second, the lock
# clears, and the next autosave enqueues again -- so the lock alone coalesces
# essentially nothing. The Svelte editor debounces autosave at 2.5s and forces
# one at least every 15s while you type (`edit/+page.svelte:103-104`), so five
# minutes is twenty forced autosaves wide: a continuous writing session bills
# ~12 detections an hour instead of ~240.
#
# The second reason for the size of it is rollout skew, the same hazard
# MULTILINGUAL_INDEX_DELAY exists for. Web and worker Deployments are applied
# together and `bin/prod-healthcheck.sh` allows the worker rollout 300 seconds.
# A new web pod that enqueues `g12f.detect_zpage_language` while an OLD worker
# is still consuming every queue gets the job claimed by a process that has
# never heard of that task name -- a terminal failure with NONE of the retry
# policy applied, because the retry policy lives in the task definition the old
# worker does not have. Five minutes clears that window.
#
# The user-visible cost is a language chip that reads "Detecting..." for a few
# minutes on a brand-new page. Nobody is blocked on it, and the failure mode is
# self-healing in both directions: a page whose job died stays in
# `unlabelled_zpages()`, so the corpus backfill picks it up, and so does the
# creator's next edit.
DETECTION_DELAY = timedelta(seconds=300)

#Procrastinate fetches ``ORDER BY priority DESC, id ASC``, so a negative
#priority puts every default-priority job ahead of detection **regardless of
#insertion order**.
#
#This bounds how much detection work can get in front of anything else on
#the CATCH-ALL worker, which still runs one replica at concurrency 1 across
#every queue: without it, an account creating pages at the 1200/minute
#throttle ceiling would put thousands of paid 10-30s detections *in front of*
#every job enqueued after them. With it, they queue behind.
#
#It bounds latency, not throughput, and it can do nothing about the job
#ALREADY IN FLIGHT -- which can be a ``g12f.translate_zpage``
#holding the lane for minutes. So it is no longer what protects the money
#path: ``k8s/free2z/worker:billing_worker``  consumes ``billing``
#exclusively, so ``renew_subscription`` and ``reap_translation_charges`` now
#have a lane no AI job can enter at all. This priority still earns its keep
#for every OTHER queue on the shared lane -- ``images``, ``search``,
#``default`` -- which have no dedicated worker.
#
#See ``tasks.DETECTION_JOB_BUDGET_SECONDS`` for the other half of the bound.
DETECTION_PRIORITY = BACKGROUND

#Saves that cannot possibly change the answer skip every query below. A vote
#bumping `f2z_score`, `cache_total()`'s accounting write and every other
#targeted save costs exactly what it costs today.
DETECTION_TRIGGER_FIELDS = frozenset(
    {"title", "content", "source_language", "language_source"}
)


def _defer_language_detection(zpage_id):
    """Enqueue detection for one zPage, coalescing an autosave burst into one.

    Two properties, each of which this codebase has been burned by the absence
    of:

    * **Enqueued inside the write's transaction**, never a provider
      call. `AtomicMiddleware` wraps every POST/PUT/PATCH in
      `transaction.atomic`, so a provider call reached from a view would hold a
      database transaction open across a network round trip; the job INSERT
      is a local statement on the same connection, so it commits or rolls back
      with the save. `on_commit` (what this used to be) is a separate
      statement after COMMIT and could lose the job without trace.
    * **A `queueing_lock`**, so a burst of autosaves collapses onto one pending
      job rather than one paid request each -- the same protection
      `_defer_multilingual_index` gives the multilingual reindex.
    * **A negative `priority`**, so a backlog of detections can never sit in
      front of a subscription renewal on the single shared worker. See
      `DETECTION_PRIORITY`.

    Deliberately NO enqueue-time content digest. It looks like the right way to
    reject a stale job, and it is a trap: the pending job would carry the
    digest of the FIRST save in a burst, every later save is refused by the
    lock, and the job would then stand down against content it does not
    recognise -- leaving a page that was actively edited permanently
    unlabelled. The job reads the row when it runs, so it always classifies
    current text; the only window that needs guarding is between that read and
    its write, and the task closes that one itself under `SELECT... FOR
    UPDATE`.
    """
    run_at = timezone.now() + DETECTION_DELAY

    # AlreadyEnqueued is swallowed by the helper: the pending job observes
    # the latest committed content.
    defer_in_transaction(
        detect_zpage_language.configure(
            schedule_at=run_at,
            queueing_lock=f"detect-zpage-{zpage_id}",
            priority=DETECTION_PRIORITY,
        ),
        zpage_id=zpage_id,
    )


def _defer_multilingual_index(zpage_id):
    # A distinct task name prevents old workers from falsely completing
    # translation-aware work. The queueing lock coalesces an autosave burst
    # into one paid OpenAI request, which reads current state when it runs. A
    # short delay gives the deployment gate time to confirm the new worker.
    run_at = timezone.now() + MULTILINGUAL_INDEX_DELAY

    # AlreadyEnqueued is swallowed by the helper: the pending job observes
    # the latest committed variants.
    defer_in_transaction(
        index_multilingual_zpage.configure(
            schedule_at=run_at,
            queueing_lock=f"multilingual-zpage-{zpage_id}",
        ),
        zpage_id=zpage_id,
    )


def _zpage_in_search_index(instance) -> bool:
    from django.contrib.contenttypes.models import ContentType

    from dj.apps.search.models import SearchIndex

    return SearchIndex.objects.filter(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id=instance.pk,
    ).exists()


@receiver(post_save, sender=Creator,
          dispatch_uid="g12f.creator_deactivation_search_cleanup")
def creator_deactivation_search_cleanup(sender, instance, **kwargs):
    """Delete vectors owned by a creator as soon as they are deactivated.

    Public search reads already join through ``published_and_active()``, but
    the vector is still creator content and must not outlive a takedown. This
    is a local database delete: it cannot make moderation depend on a cloud
    API, and it also covers the Django-admin path that only flips
    ``Creator.is_active`` rather than calling ``ban_and_soft_delete()``.
    """
    if kwargs.get("raw") or instance.is_active:
        return

    from django.contrib.contenttypes.models import ContentType

    from dj.apps.search.models import SearchIndex

    SearchIndex.objects.filter(
        content_type=ContentType.objects.get_for_model(zPage),
        object_id__in=zPage.objects.filter(
            creator_id=instance.pk,
        ).values("pk"),
    ).delete()


def reindex_published_zpage(instance):
    """Queue the search re-index a published page's save queues.

    Public because not every change to the search document is a ``save()``:
    tags are in it (``search.helpers``), and a bare ``tags.add()`` -- an
    accepted AI suggestion, or the blank-page auto-apply  -- fires no
    ``post_save``. Transactional, like every caller here.
    """
    if instance.translations.filter(is_published=True).exists():
        _defer_multilingual_index(instance.pk)
    else:
        defer_in_transaction(index_zpage.configure(), zpage_id=instance.pk)


@receiver(post_save, sender=zPage,
          dispatch_uid="g12f.zpage_async_side_effects")
def zpage_async_side_effects(sender, instance, created, **kwargs):
    if kwargs.get("raw") or getattr(
        instance, "_skip_zpage_async_side_effects", False
    ):
        # fixtures/loaddata: don't enqueue side effects
        return

    zpage_id = instance.pk

    if not instance.is_published and instance.publish_at is not None:
        defer_in_transaction(
            publish_zpage.configure(schedule_at=instance.publish_at),
            zpage_id=zpage_id,
        )

    if instance.is_published:
        reindex_published_zpage(instance)
    elif _zpage_in_search_index(instance):
        # Page went (or stayed) unpublished but is still indexed: the
        # task deletes the stale row so it drops out of search.
        defer_in_transaction(index_zpage.configure(), zpage_id=zpage_id)


@receiver(pre_save, sender=zPage,
          dispatch_uid="g12f.zpage_language_provenance")
def zpage_language_provenance(sender, instance, **kwargs):
    """Decide, before the write, what this save means for the page's language.

    Two decisions, both of which need the value the row held *before* this
    save, so they cannot be made in ``post_save``:

    **1. Did a human just relabel the article?** Any write path that changes
    ``source_language`` to a different real language -- the API, the MCP server,
    a third-party client, the Django admin -- is a human asserting a language,
    so ``language_source`` becomes ``creator`` and the detector will never
    touch that page's label again. This is the *only* thing that mints
    ``creator``, which is why it lives here rather than in one serializer: a
    rule enforced at one write path is not enforced.

    Deliberately **not** on create. The Svelte editor sends the language picker's
    value on create (`edit/+page.svelte:519`), and that value starts life as the
    UI locale -- exactly the "content language is not a product locale" confusion
     exists to end. Treating it as a considered human assertion would mean
    every new page from the main editor is auto-labelled by browser locale and
    never detected. A create is a client's *guess*; changing the label later is
    a human's *decision*.

    **2. Does the language need (re-)detecting?** Recorded on the instance and
    acted on after commit:

    * **every create**, whatever the client sent. A create-time
      ``source_language`` is a client's *guess* -- the Svelte editor's picker
      starts at the browser's UI locale and sends it
      (`edit/+page.svelte:519-520`), so honouring it would auto-label a Spanish
      article `en` forever, permanently and invisibly, and the backfill would
      never see the page because it looks labelled. Detection wins on create;
      the creator wins the moment they actually touch the control.
    * the page has no real language (NULL, or the legacy ``und``) -- the case
      that produces "Original (language unknown)" in today's editor;
    * or the detector owns the label already and the text changed materially.

    An *existing* page carrying a human-asserted language is never re-detected,
    which is what keeps the corpus bill proportional to unresolved content
    rather than to all content -- and is why ``apply_detection`` can safely
    relabel anything that does reach it.
    """
    instance._detect_language_after_commit = False
    if kwargs.get("raw"):
        return
    if getattr(instance, "_language_write_is_detection", False):
        # Our own write. Re-deriving provenance from it would either stamp the
        # detector's answer as a creator override or enqueue an endless chain
        # of detections.
        return

    update_fields = kwargs.get("update_fields")
    if update_fields is not None and DETECTION_TRIGGER_FIELDS.isdisjoint(
        update_fields
    ):
        # cache_total()'s score/total write and every other targeted save.
        return

    previous = None
    if instance.pk:
        previous = (
            zPage.objects.filter(pk=instance.pk)
            .values("source_language", "language_source", "title", "content")
            .first()
        )

    if previous is not None:
        relabelled = (
            instance.source_language != previous["source_language"]
            and is_content_language(instance.source_language)
            and instance.language_source == previous["language_source"]
        )
        if relabelled:
            instance.language_source = LANGUAGE_SOURCE_CREATOR
            instance._language_relabelled_by_writer = True

    if instance.language_source == LANGUAGE_SOURCE_CREATOR:
        return

    if previous is None or not is_content_language(instance.source_language):
        # A create (whatever language the client guessed at), or a page with no
        # real language at all.
        instance._detect_language_after_commit = True
        return

    if instance.language_source == LANGUAGE_SOURCE_DETECTED and (
        previous is None
        or _text_digest(previous["title"], previous["content"])
        != _text_digest(instance.title, instance.content)
    ):
        # The detector put the current label there and the text it was
        # describing has changed. Whitespace-only edits do not reach here --
        # the digest normalizes them away -- and neither does a re-save of
        # identical text.
        instance._detect_language_after_commit = True


def _text_digest(title, content):
    from f2z.ai.language import content_digest

    return content_digest(title, content)


@receiver(post_save, sender=zPage,
          dispatch_uid="g12f.zpage_language_detection")
def zpage_language_detection(sender, instance, created, **kwargs):
    """Persist a creator relabel and enqueue detection, after the write."""
    if kwargs.get("raw"):
        return

    if getattr(instance, "_language_relabelled_by_writer", False):
        instance._language_relabelled_by_writer = False
        update_fields = kwargs.get("update_fields")
        if update_fields is not None and (
            "language_source" not in update_fields
        ):
            # `update_fields` is a frozenset by the time a signal sees it, so
            # the value set in pre_save would silently not be written. A
            # targeted UPDATE is the only way to make the provenance stick --
            # and it fires no signals, so it cannot recurse.
            zPage.objects.filter(pk=instance.pk).update(
                language_source=LANGUAGE_SOURCE_CREATOR
            )

    if getattr(instance, "_detect_language_after_commit", False):
        instance._detect_language_after_commit = False
        _defer_language_detection(instance.pk)


@receiver(post_save, sender=zPage,
          dispatch_uid="g12f.zpage_dual_write_source_variant")
def zpage_dual_write_source_variant(sender, instance, created, **kwargs):
    """Mirror canonical content onto the source variant ( M3).

    A separate receiver from ``zpage_async_side_effects`` on purpose: that one
    honours ``_skip_zpage_async_side_effects``, which the translation write
    path sets to suppress a *duplicate search reindex*. Suppressing a reindex
    must never suppress a mirror write, or the two shapes drift precisely on
    the writes that touch both.
    """
    if kwargs.get("raw"):
        # loaddata: the fixture is the authority on what rows exist, and a
        # fixture that carries variants would fight this write.
        return
    update_fields = kwargs.get("update_fields")
    if update_fields is not None and not (
        SOURCE_VARIANT_FIELDS & set(update_fields)
    ):
        # cache_total()'s score/total write, and every other targeted save
        # that cannot change what a variant stores.
        return
    sync_source_variant(instance)


@receiver(post_delete, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_dual_write_delete")
def zpage_translation_dual_write_delete(sender, instance, **kwargs):
    """Drop the mirrored variant when a translation is deleted ( M3)."""
    delete_translation_variant(instance.zpage_id, instance.language)


@receiver(pre_save, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_capture_language")
def zpage_translation_capture_language(sender, instance, **kwargs):
    """Remember the language a translation row is moving away from.

    ``language`` is the variant's lookup key, and it is editable in the Django
    admin. Without this, renaming a translation from `es` to `fr` upserts an
    `fr` variant and leaves the `es` one behind forever — a ghost translation
    that exists in no authoritative table and that M5 would publish to readers.
    """
    if kwargs.get("raw") or not instance.pk:
        instance._previous_language = None
        return
    instance._previous_language = ZPageTranslation.objects.filter(
        pk=instance.pk
    ).values_list("language", flat=True).first()


@receiver(post_save, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_dual_write")
def zpage_translation_dual_write(sender, instance, **kwargs):
    """Mirror a translation onto its variant ( M3)."""
    if kwargs.get("raw"):
        return
    previous = getattr(instance, "_previous_language", None)
    if previous and previous != instance.language:
        delete_translation_variant(instance.zpage_id, previous)
    sync_translation_variant(instance)


@receiver(post_save, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_search_index")
def zpage_translation_search_index(sender, instance, **kwargs):
    searchable_is_published = _translation_is_published_after_save(
        instance, kwargs.get("update_fields")
    )
    if (
        kwargs.get("raw")
        or not instance.zpage.is_published
        or not (
            searchable_is_published
            or getattr(instance, "_was_published", False)
        )
        or not (
            getattr(instance, "_searchable_content_changed", False)
            or (
                searchable_is_published
                and getattr(instance, "_searchable_fields_changed", False)
            )
        )
    ):
        return
    _defer_multilingual_index(instance.zpage_id)


def _translation_is_published_after_save(instance, update_fields):
    """Read publication state after a targeted save's possible race."""
    if update_fields is None or "is_published" in set(update_fields):
        return instance.is_published
    return ZPageTranslation.objects.filter(
        pk=instance.pk
    ).values_list("is_published", flat=True).first() is True


@receiver(pre_save, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_capture_publish_state")
def zpage_translation_capture_publish_state(sender, instance, **kwargs):
    """Capture the persisted searchable state before a translation save.

    The semantic index contains published translation title/body blocks, so
    the parent page's freshness timestamp must move when one of those blocks
    enters, changes, or leaves the index.  Compare only fields that this save
    actually writes: a stale in-memory value on a targeted save must not make
    an unrelated write look like content activity.
    """
    if kwargs.get("raw") or not instance.pk:
        instance._was_published = False
        instance._searchable_is_published = bool(instance.is_published)
        instance._searchable_content_changed = instance._searchable_is_published
        return
    persisted = ZPageTranslation.objects.filter(pk=instance.pk).values(
        "language", "title", "content", "is_published"
    ).first()
    if persisted is None:
        instance._was_published = False
        instance._searchable_is_published = False
        instance._searchable_content_changed = False
        return

    instance._was_published = persisted["is_published"]
    update_fields = kwargs.get("update_fields")
    written_fields = (
        {"language", "title", "content", "is_published"}
        if update_fields is None
        else set(update_fields)
    )
    # A targeted save may carry a stale in-memory publication flag. If the
    # flag is not part of the UPDATE, the persisted row determines whether
    # the written text is searchable.
    searchable_is_published = (
        instance.is_published
        if "is_published" in written_fields
        else persisted["is_published"]
    )
    instance._searchable_is_published = searchable_is_published
    publication_changed = (
        "is_published" in written_fields
        and persisted["is_published"] != instance.is_published
    )
    instance._searchable_fields_changed = any(
        field in written_fields
        and persisted[field] != getattr(instance, field)
        for field in ("language", "title", "content")
    )
    instance._searchable_publication_changed = publication_changed
    published_text_changed = (
        searchable_is_published
        and instance._searchable_fields_changed
    )
    instance._searchable_content_changed = (
        publication_changed or published_text_changed
    )


@receiver(post_save, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_search_freshness")
def zpage_translation_search_freshness(sender, instance, **kwargs):
    """Refresh parent search freshness when published translation content moves.

    Use a targeted parent update so this cannot trigger page side effects or
    turn a translation metadata save into canonical page activity.  The
    publication predicate matches the semantic index: translations on an
    unpublished page are not searchable yet and therefore do not age its
    search result until a relevant published write occurs.
    """
    if kwargs.get("raw"):
        return
    if not getattr(instance, "_searchable_content_changed", False):
        return
    if (
        not getattr(instance, "_searchable_publication_changed", False)
        and not _translation_is_published_after_save(
            instance, kwargs.get("update_fields")
        )
    ):
        return
    zPage.objects.filter(
        pk=instance.zpage_id, is_published=True
    ).update(searchable_content_updated_at=timezone.now())


@receiver(pre_delete, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_capture_delete_publish_state")
def zpage_translation_capture_delete_publish_state(sender, instance, **kwargs):
    """Capture the persisted publication state before a translation delete."""
    if kwargs.get("raw"):
        instance._was_published_before_delete = False
        return
    instance._was_published_before_delete = bool(
        ZPageTranslation.objects.filter(pk=instance.pk).values_list(
            "is_published", flat=True
        ).first()
    )


@receiver(post_delete, sender=ZPageTranslation,
          dispatch_uid="g12f.zpage_translation_search_index_delete")
def zpage_translation_search_index_delete(sender, instance, **kwargs):
    parent = zPage.objects.filter(pk=instance.zpage_id, is_published=True)
    if getattr(instance, "_was_published_before_delete", False):
        if not parent.update(searchable_content_updated_at=timezone.now()):
            return
    elif not parent.exists():
        return
    _defer_multilingual_index(instance.zpage_id)


def _defer_committed_renewal(sub_id):
    """Schedule the renewal at the moment the COMMITTED row says (see
    ``subscription_schedule_renewal``). A row that was deleted or cancelled
    between the save and the commit schedules nothing, exactly as the
    pre-commit check would have."""
    row = (
        Subscription.objects.filter(pk=sub_id)
        .values_list("expires", "max_price")
        .first()
    )
    if row is None:
        return
    expires, max_price = row
    if not max_price or max_price <= 0:
        return
    defer_renewal(
        sub_id, expires, schedule_at=expires - RENEWAL_LEAD,
        # A save is an immediate look (see the receiver's docstring): a
        # pending RETRY for this cycle is moved up to this moment rather
        # than left to its hourly cadence.
        pull_forward=True,
    )


@receiver(post_save, sender=Subscription,
          dispatch_uid="g12f.subscription_schedule_renewal")
def subscription_schedule_renewal(sender, instance, created, **kwargs):
    """
    Single enqueue point for subscription renewals ( phase 3).

    Every mutation of a Subscription goes through save() — creation and
    manual renew (CreatorSubscribeView.post -> extend()), cancellation
    (DELETE sets max_price=0), cap changes (PATCH), admin edits, the
    daily backstop sweep, and renew_subscription's own extend(). So a
    post_save hook is the one place that keeps the renewal chain alive:
    whenever a renewable sub is saved, schedule g12f.renew_subscription
    at expires - RENEWAL_LEAD — the exact moment the legacy hourly
    sweep's 24h window would have opened.

    max_price == 0 is how cancellation is modeled (see
    CreatorSubscribeView.delete): a cancel save schedules nothing, and
    any already-queued job for the sub no-ops via the task's
    eligibility/window guards (no cancellation machinery, same design
    as publish_zpage). If the fan re-raises max_price before expiry,
    that PATCH save re-arms the chain right here -- and for a sub that is
    already inside its window, "re-arms" means LOOKS NOW: the requested
    moment, ``expires - RENEWAL_LEAD``, is in the past, so the job runs at
    once. ``CreatorSubscribeView.patch`` only accepts a cap that makes the
    sub chargeable right now (``max_price >= member_price`` and
    ``<= fan.tuzis``), so the save that fixes an ineligible renewal is
    the save that charges it; a fan is not left waiting for the hourly
    retry after they have already fixed the problem.

    Duplicate jobs from repeated saves are harmless: the task's
    idempotency guard (expires > now + RENEWAL_LEAD after a renewal)
    means at most one extension/charge per cycle. they are
    also impossible within a cycle: ``defer_renewal`` carries a
    ``queueing_lock`` keyed by subscription and ``expires``, so a save that
    leaves ``expires`` alone while a renewal job is pending enqueues
    nothing NEW. It still gets its immediate look: the hook passes
    ``pull_forward=True``, so a pending job for this cycle scheduled later
    than ``expires - RENEWAL_LEAD`` (an hourly retry, or the last look) is
    moved up to that moment instead -- one pending job, running now --
    and a pending job already at that moment (the chain job) is left
    exactly where it is. A save that moves ``expires`` enqueues the job
    for the new moment alongside the old one (which then runs, finds
    ``expires`` moved, and does nothing).

    The callback reads the COMMITTED row instead of closing over
    ``instance.expires``. The subscribe endpoint saves twice in one
    transaction -- ``get_or_create`` (``expires`` defaults to now) and then
    ``extend()`` -- so two callbacks fire from the same commit; closing
    over each save's own ``expires``, the first would enqueue a throwaway
    job for a moment 24h in the past (it runs at once, not-due, and no-ops)
    before the second enqueues the real one. Reading the row at commit time
    makes every callback of one commit ask for the same moment, so the
    first wins and the rest are refused. See the block comment above
    ``RENEWAL_LEAD`` in tasks.py.
    """
    if kwargs.get("raw"):
        return

    if not instance.max_price or instance.max_price <= 0:
        return

    sub_id = instance.pk
    transaction.on_commit(
        lambda: _defer_committed_renewal(sub_id),
        # Queue insertion happens after the Subscription and any charge have
        # committed. A transient queue/DB failure must not turn that durable
        # success into a 500 that invites another purchase. Django logs robust
        # callback failures, and the daily renew_subs sweep repairs a missing
        # chain job before the renewal window closes.
        robust=True,
    )
