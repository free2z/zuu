"""The suggestion-first tagging pipeline.

Everything that decides *whether* to spend money on tagging, and everything
that turns a suggestion into a real tag, lives here rather than in the Pub/Sub
subscriber. The subscriber is a transport; this is the behaviour, and it is
testable without a message.

Cost, stated plainly because  asked for it:

* **This does not go through the metered ``AIModel``/spend-ceiling path in
  ``dj/apps/openai/``, and cannot today.** That path prices a request in 2Z
  against a *user's* balance (``Conversation``/``AIModel.get_max_response_tokens``)
  and refuses when the balance runs out. There is no user here -- the platform
  is tagging its own corpus on its own key -- so there is no balance to debit
  and no one to refuse. Wiring a platform-internal job into a per-user ledger
  would either charge creators for tagging they did not ask for or invent a
  synthetic account, neither of which belongs in this PR.
* What replaces it are four bounds that are real:
  1. **A cheap model.** ``TAGGING_MODEL`` (default ``gpt-4o-mini``) instead of
     the ``BEST_MODEL`` (``gpt-4o``) the old subscriber used.
  2. **A content digest.** Unchanged content is never re-tagged, at any
     frequency, so redeliveries and metadata-only saves cost nothing. This is
     the single biggest saving: ``PAGE_UPDATE`` fires on every save.
  3. **A bounded prompt.** ``TAGGING_MAX_CHARS`` caps the input; a 200KB
     article cannot buy a 200KB completion.
  4. **A floor.** Content under ``TAGGING_MIN_CHARS`` is not worth a
     completion and is skipped before the client is touched.

On the queue: the catch-all Procrastinate worker is one replica at concurrency 1
across every queue, so slow AI jobs share a lane with each other ( gave
``billing`` its own worker; the rest still queue). Nothing here runs on
Procrastinate -- the tagger is its own ``zpage-tag`` Deployment with its own
Pub/Sub subscription, so it does not contend with either. It is also **strictly
less frequent** than the code it replaces: the old gate (``tags.exists()``)
called OpenAI on every ``PAGE_UPDATE`` for an untagged page, including repeated
saves of the same draft; the digest gate calls it once per distinct content
version.

Blank pages are tagged, not just offered tags
-----------------------------------------------------
Suggestion-first  turned out to mean "untagged": almost nobody clicks a
chip, and tags are the discovery layer. So the rule is now split on one fact,
**does the page carry any tag at the moment we write**:

* **Zero tags** -> the pass's output is ADDED to ``zpage.tags`` and the rows
  are recorded as ``TagSuggestion.AUTO_APPLIED`` (provenance: a machine chose
  these, and ``decided_by`` stays NULL).
* **Any tag** -> exactly the  behaviour: pending suggestions, nothing
  written. A creator who chose tags is never overruled.

"Zero" is decided INSIDE the write transaction with the zPage row locked
(:func:`record_suggestions`), never from the snapshot the pass started with:
the completion takes seconds, and a creator who adds a tag in that window must
win. The zPage write path takes the same row (``_lock_and_check_precondition``
/ the ``UPDATE`` itself), so the two serialize and the re-read sees the
creator's committed tags. A page that has EVER been auto-tagged is never
auto-tagged again: if its tags are gone, someone removed them, and fighting
that is not our call.

Nothing here calls ``tags.remove()``.

Auto-applied tags change the article's ``ETag`` without touching
``updated_at``, which would otherwise 412 -- and latch -- an editor still open
on the page. ``g12f.preconditions`` recognises exactly that case; see
:func:`unseen_auto_applied_keys` and its callers there.
"""

import logging
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from f2z.openai.util import MAX_TAGS, tag_content

from .models import TagSuggestion, TagSuggestionRun, content_digest, tag_key

#How many already-paid-for pending suggestions:func:`apply_pending_suggestions`
#will turn into tags: the most one pass can propose. Pending rows accumulate
#across passes, and a page must not come out of the backfill carrying every
#tag eight passes ever proposed.
MAX_AUTO_APPLIED_TAGS = MAX_TAGS

logger = logging.getLogger(__name__)

#Cheap by default. The old subscriber used ``BEST_MODEL`` -- ``gpt-4o`` -- for
#a job whose output is a dozen words. Settings-driven so it can be bumped or
#rolled back without a deploy.
DEFAULT_TAGGING_MODEL = "gpt-4o-mini"
#Prompt bound. The old code used 2048; tags describe the whole piece, so a bit
#more context is worth it, but it must stay a hard number.
DEFAULT_MAX_CHARS = 4000
#Below this there is nothing to tag and the completion is wasted money. A
#three-word page gets no suggestions, which is the correct answer.
DEFAULT_MIN_CHARS = 120
#THE DEBOUNCE, and it is the bound that actually matters. The content digest
#alone does NOT cap spend on a published page: the editor autosaves every few
#seconds while someone types, every keystroke batch is a different digest and
#another ``PAGE_UPDATE``, so a digest-only gate buys a completion per autosave
#-- worse than the code it replaces, which stopped after one. A page gets at
#most one tagging pass per this many seconds no matter how it is edited.
#15 minutes: long enough that a writing session is one pass, short enough that
#a creator who finishes, walks away and comes back sees fresh suggestions.
DEFAULT_MIN_INTERVAL_SECONDS = 900
#THE LIFETIME CAP. The debounce bounds the *rate*; this bounds the *total*, so
#an article edited daily for a year cannot quietly become the platform's
#largest OpenAI line item. Past this, suggestions for that page are done --
#which is fine, because by then the creator has answered them.
DEFAULT_MAX_RUNS_PER_PAGE = 8


def _setting(name, default):
    value = getattr(settings, name, None)
    return default if value is None else value


def auto_apply_enabled() -> bool:
    """Kill switch for. Off -> every pass is suggestion-only again."""
    return bool(_setting("TAGGING_AUTO_APPLY_BLANK", True))


def tagging_model() -> str:
    return _setting("TAGGING_MODEL", DEFAULT_TAGGING_MODEL)


def build_tagging_prompt(zpage) -> str:
    """The exact text a tagging pass reads. Must agree with:func:`page_digest`."""
    limit = int(_setting("TAGGING_MAX_CHARS", DEFAULT_MAX_CHARS))
    return f"{zpage.title}: {(zpage.content or '')[:limit]}"


def page_digest(zpage) -> str:
    """Digest of the *truncated* content the model will actually see.

    Hashing the full body instead would re-tag on an edit past the truncation
    point -- a change the model provably cannot observe -- and buy a completion
    guaranteed to return what it returned last time.
    """
    limit = int(_setting("TAGGING_MAX_CHARS", DEFAULT_MAX_CHARS))
    return content_digest(zpage.title, (zpage.content or "")[:limit])


def should_suggest(zpage):
    """``(bool, reason)`` -- may we spend a completion on this page?

    Note what is NOT here: ``zpage.tags.exists()``. That was the entire gate
    before, and  turned it into a trap -- a creator adding one tag of
    their own switched AI tagging off for that page forever. Engagement should
    *improve* suggestions, not disable them. What replaces it is "have we
    already suggested for this exact content", which is the question the old
    gate was a bad proxy for.
    """
    if not zpage.is_published:
        # Unpublished drafts are edited constantly; tagging them is the most
        # expensive possible moment to do it, and  notes drafts are not
        # browsable anyway.
        return False, "not published"

    body = zpage.content or ""
    if len(body) < int(_setting("TAGGING_MIN_CHARS", DEFAULT_MIN_CHARS)):
        return False, "content too short"

    digest = page_digest(zpage)
    runs = TagSuggestionRun.objects.filter(zpage=zpage)
    if runs.filter(source_digest=digest).exists():
        return False, "already suggested for this content"

    # Lifetime cap, checked before the debounce so a page that has had its
    # eight passes says so rather than "too soon" forever.
    max_runs = int(_setting("TAGGING_MAX_RUNS_PER_PAGE",
                            DEFAULT_MAX_RUNS_PER_PAGE))
    if max_runs > 0 and runs.count() >= max_runs:
        return False, "run budget exhausted for this page"

    # The debounce. Note it is keyed on the LAST RUN, not on the digest: the
    # whole point is that a burst of distinct digests -- which is exactly what
    # autosave produces -- collapses to one completion.
    interval = int(_setting("TAGGING_MIN_INTERVAL_SECONDS",
                            DEFAULT_MIN_INTERVAL_SECONDS))
    if interval > 0:
        cutoff = timezone.now() - timedelta(seconds=interval)
        if runs.filter(created_at__gt=cutoff).exists():
            return False, "debounced: a pass ran recently"

    return True, ""


def _lock_page(zpage):
    """Re-read ``zpage`` under ``FOR UPDATE``, or ``None`` if it is gone.

    A plain pk read with no join, so the lock is on the zPage row alone -- the
    row the zPage write path locks (explicitly under ``If-Match``, implicitly
    by its ``UPDATE`` otherwise). That is what gives "is this page blank" one
    answer at a time.
    """
    from dj.apps.g12f.models import zPage

    return zPage.objects.select_for_update().filter(pk=zpage.pk).first()


def _reindex(zpage):
    """Tags are in the search document and ``tags.add()`` fires no
    ``post_save``, so the re-index a save would have queued is queued here.

    Best-effort, in its own savepoint: a failed enqueue must not roll back
    the tags (the next save of the page re-indexes it anyway), and must not
    leave the caller's transaction unusable.
    """
    from dj.apps.g12f.signals import reindex_published_zpage

    try:
        with transaction.atomic():
            reindex_published_zpage(zpage)
    except Exception:
        logger.exception(
            "search re-index enqueue failed after tagging zpage %s; the "
            "tags stand", zpage.pk)


def _may_auto_apply(locked, carried) -> bool:
    """May a machine write tags to this (locked) page right now?"""
    if not auto_apply_enabled():
        return False
    if locked is None or not locked.is_published:
        return False
    if carried:
        # The creator chose tags. Hands off -- suggestions only.
        return False
    # Auto-tagged once already and now blank again: somebody removed them.
    return not TagSuggestion.objects.filter(
        zpage_id=locked.pk, status=TagSuggestion.AUTO_APPLIED
    ).exists()


def record_suggestions(zpage, names, digest, run=None, model="",
                       auto_apply=True):
    """Persist a pass's output; on a blank published page, apply it.

    Returns the ``TagSuggestion`` rows this call created or auto-applied.

    Whether the page is blank is decided HERE, under the zPage row lock, from
    a fresh read -- not from the instance the pass started with. That is the
    whole race: the completion ran outside any transaction for seconds, and a
    creator who added a tag meanwhile has committed it by the time this lock is
    granted. Their tag wins and this pass degrades to suggestions.

    Existing rows keep their decision: an accepted tag is not re-proposed, and
    -- the load-bearing one -- a **dismissed tag is never resurrected**, not
    even onto a blank page. The creator said no once.

    Tags the creator already carries are skipped outright, so the editor never
    shows "would you like to add a tag you already have".
    """
    created = []
    applied = []

    with transaction.atomic():
        locked = _lock_page(zpage)
        if locked is None:
            # Deleted while the completion was in flight; the CASCADE took
            # the run row with it, so there is nothing to record against.
            return []
        carried = list(locked.tags.names())
        existing_keys = {tag_key(name) for name in carried}
        # The output describes the content the pass READ. If the creator
        # replaced it meanwhile, publishing these tags would label the new
        # text with the old text's subject -- and, once tagged, nothing would
        # ever correct it. Suggestions only; the next pass (a new digest)
        # gets its own chance.
        blank = (
            auto_apply
            and page_digest(locked) == digest
            and _may_auto_apply(locked, carried)
        )

        if run is not None and run.proposed_count != len(names):
            run.proposed_count = len(names)
            run.save(update_fields=["proposed_count"])

        for name in names:
            key = tag_key(name)
            if not key or key in existing_keys:
                continue
            existing_keys.add(key)
            suggestion, is_new = TagSuggestion.objects.get_or_create(
                zpage=locked,
                name_key=key,
                defaults={
                    "name": name,
                    "status": (
                        TagSuggestion.AUTO_APPLIED if blank
                        else TagSuggestion.PENDING
                    ),
                    "decided_at": timezone.now() if blank else None,
                    "source_digest": digest,
                    "ai_model": model,
                },
            )
            if (
                not is_new
                and suggestion.status == TagSuggestion.PENDING
                and suggestion.source_digest != digest
            ):
                # Still pending and proposed again for THIS content: it is a
                # current suggestion, which is what the backfill's reuse path
                # keys on (`apply_pending_suggestions`).
                suggestion.source_digest = digest
                suggestion.save(update_fields=["source_digest", "name_key"])
            if not is_new and blank and suggestion.status == TagSuggestion.PENDING:
                # Proposed by an earlier pass and never answered: the page is
                # blank, so it is applied like the rest of this pass.
                suggestion.decide(TagSuggestion.AUTO_APPLIED)
                is_new = True
            if is_new:
                created.append(suggestion)
                if suggestion.status == TagSuggestion.AUTO_APPLIED:
                    applied.append(suggestion.name)

        if applied:
            # `add()` never removes; the page had no tags to remove anyway.
            locked.tags.add(*applied)
            _reindex(locked)
            logger.info(
                "auto-applied %d AI tag(s) to blank zpage %s",
                len(applied), locked.pk)

    return created


def apply_pending_suggestions(zpage):
    """Turn already-paid-for pending suggestions into tags on a blank page.

    The backfill's no-completion path: most untagged published pages
    already had a pass under, so the digest gate would refuse them and
    their suggestions are sitting there, paid for and unanswered. Same lock,
    same blank test, same provenance as:func:`record_suggestions`. Newest
    first, capped at:data:`MAX_AUTO_APPLIED_TAGS`.

    Only suggestions proposed for the page's CURRENT content qualify
    (``source_digest`` equal to:func:`page_digest` under the lock). A page
    rewritten since its last pass must not be published under its old
    subject; with nothing current to reuse, the backfill buys a fresh pass.

    Returns the names applied (``[]`` if the page is not eligible).
    """
    with transaction.atomic():
        locked = _lock_page(zpage)
        if locked is None:
            return []
        carried = list(locked.tags.names())
        if not _may_auto_apply(locked, carried):
            return []
        rows = list(
            TagSuggestion.objects.select_for_update()
            .filter(
                zpage_id=locked.pk,
                status=TagSuggestion.PENDING,
                source_digest=page_digest(locked),
            )
            .order_by("-created_at", "name")[:MAX_AUTO_APPLIED_TAGS]
        )
        for row in rows:
            row.decide(TagSuggestion.AUTO_APPLIED)
        names = [row.name for row in rows]
        if names:
            locked.tags.add(*names)
            _reindex(locked)
            logger.info(
                "auto-applied %d pending AI tag(s) to blank zpage %s",
                len(names), locked.pk)
        return names


def unseen_auto_applied_keys(page) -> frozenset:
    """``tag_key``s of carried tags a machine added.

    For ``g12f.preconditions``: an editor that loaded the page before the
    pass finished holds a validator without these, and nothing else changed.
    """
    auto_keys = set(
        TagSuggestion.objects.filter(
            zpage_id=page.pk, status=TagSuggestion.AUTO_APPLIED
        ).values_list("name_key", flat=True)
    )
    if not auto_keys:
        return frozenset()
    return frozenset(
        tag_key(tag.name) for tag in page.tags.all()
        if tag_key(tag.name) in auto_keys
    )


def suggest_tags_for_zpage(zpage, force: bool = False):
    """Run one tagging pass if it is warranted. Returns the new suggestions.

    The OpenAI call is deliberately OUTSIDE the transaction in
    :func:`record_suggestions`: it is a 1-10s third-party network call, and
    holding a Postgres transaction open across it is the shape  and
    are about.
    """
    if not force:
        allowed, reason = should_suggest(zpage)
        if not allowed:
            logger.info(
                "tag suggestions skipped for zpage %s: %s", zpage.pk, reason)
            return []

    digest = page_digest(zpage)
    model = tagging_model()

    # CLAIM THE DIGEST BEFORE PAYING FOR IT. `should_suggest` is a read, so two
    # concurrent Pub/Sub deliveries of the same message both pass it and both
    # buy a completion if the row is only written afterwards. The unique
    # constraint on (zpage, source_digest) is the only thing that can settle
    # that race, so it has to be taken first.
    run, claimed = TagSuggestionRun.objects.get_or_create(
        zpage=zpage, source_digest=digest, defaults={"ai_model": model},
    )
    if not claimed:
        logger.info(
            "tag suggestions for zpage %s already claimed by another "
            "delivery", zpage.pk)
        return []

    try:
        names = tag_content(build_tagging_prompt(zpage), model=model)
    except Exception:
        # Release the claim. A failed completion must not leave a run row
        # behind, or the digest gate would permanently suppress retries for
        # this content version. Raising lets the caller decide (the subscriber
        # acks and logs; see its own note on redelivery cost).
        logger.exception("tag suggestion call failed for zpage %s", zpage.pk)
        run.delete()
        raise

    try:
        return record_suggestions(zpage, names, digest, run=run, model=model)
    except Exception:
        # The recording rolled back, but the claim above was committed before
        # the completion. Left behind, it would make the digest gate treat
        # this content as done. Same release as a failed completion.
        logger.exception("recording tags failed for zpage %s", zpage.pk)
        TagSuggestionRun.objects.filter(pk=run.pk).delete()
        raise


def pending_suggestions(zpage):
    """Pending suggestions for a page, minus anything the creator already has.

    The filter is not redundant with:func:`record_suggestions`: a creator can
    type a tag by hand *after* it was suggested, and showing them a chip
    offering a tag already on the page is a bug the API should not make the
    client work around.
    """
    carried = {tag_key(name) for name in zpage.tags.names()}
    return [
        suggestion
        for suggestion in zpage.tag_suggestions.filter(
            status=TagSuggestion.PENDING
        ).order_by("-created_at", "name")
        if suggestion.name_key not in carried
    ]


def decide_suggestions(zpage, accept=(), dismiss=(), user=None):
    """Apply creator decisions. The only CREATOR path that writes ``zpage.tags``
    here (the other is the blank-page auto-apply, ).

    Additive by construction: accepting calls ``tags.add()`` and nothing here
    calls ``tags.remove()``. A creator's own tags cannot be touched by this API
    even if a caller sends their names in ``dismiss`` -- dismissing marks the
    *suggestion* row, never the tag.

    Names are matched case-insensitively against the suggestion rows so a
    client echoing back a differently-cased name still resolves. A name with no
    matching pending suggestion is ignored rather than 400'd: the creator may
    have accepted it in another tab, and failing the whole request over a
    stale chip is worse than doing the part that still makes sense.
    """
    accept_keys = {tag_key(name) for name in accept if tag_key(name)}
    dismiss_keys = {tag_key(name) for name in dismiss if tag_key(name)}
    # Accept wins a name sent in both -- it is the constructive outcome, and
    # the alternative silently discards a tag the creator asked for.
    dismiss_keys -= accept_keys

    accepted, dismissed = [], []

    with transaction.atomic():
        # The zPage row first, like every other writer of this page's tags
        #an auto-apply racing this accept must see either none of it
        # or all of it, never a page that is "blank" between the two.
        _lock_page(zpage)
        rows = list(
            zpage.tag_suggestions
            .select_for_update()
            .filter(
                status=TagSuggestion.PENDING,
                name_key__in=accept_keys | dismiss_keys,
            )
        )
        for row in rows:
            if row.name_key in accept_keys:
                row.decide(TagSuggestion.ACCEPTED, user=user)
                accepted.append(row.name)
            else:
                row.decide(TagSuggestion.DISMISSED, user=user)
                dismissed.append(row.name)

        if accepted:
            # `add()` on a TaggableManager is idempotent and never removes.
            zpage.tags.add(*accepted)
            if zpage.is_published:
                _reindex(zpage)

    return accepted, dismissed
