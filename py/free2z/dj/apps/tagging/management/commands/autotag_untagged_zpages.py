"""Backfill: give every published zPage with ZERO tags AI tags, once.

The live path (the ``zpage-tag`` subscriber) only fires on a save, so pages
published under suggestion-first  and never touched again stay blank.
This walks them.

Per page, cheapest first:

1. **Reuse** -- the page already has pending suggestions proposed for its
   CURRENT content. They are paid for, so they are applied as they are
   (``services.apply_pending_suggestions``). No completion.
2. **New pass** -- no pending suggestions and no pass has run over the current
   content. One completion (``suggest_tags_for_zpage(force=True)``: the
   debounce and lifetime budget exist to bound *autosave churn*, which a
   one-shot backfill is not; the digest claim still holds, so nothing is
   bought twice). On a still-blank page it is applied.
3. **Skip** -- too short to tag, or a pass already ran over exactly this
   content (an abandoned claim does not count: see ``_is_orphaned_claim``)
   and left nothing pending (the model proposed nothing new, or the
   creator dismissed every suggestion). Re-asking would buy the same answer,
   or overrule a "no".

Every write goes through the service, which re-decides "blank" under the
zPage row lock inside ``transaction.atomic()`` -- a management command runs in
autocommit and gets none of ``AtomicMiddleware``'s wrapping, so the
transaction is explicit there. A page a creator tags mid-run keeps its tags.

Idempotent and resumable by construction: a page that got tags no longer
matches the query, and a skipped page costs nothing to re-examine. Kill it
and run it again.

Run on prod as a detached ``Job``, never ``kubectl exec`` (a deploy drains the
pod and the backfill dies with exit 137) -- see docs/agent-operations.md,
"Backfilling AI tags onto untagged zPages".
"""

import time
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from dj.apps.g12f.models import zPage
from dj.apps.tagging import services
from dj.apps.tagging.models import TagSuggestion, TagSuggestionRun

CHUNK = 200

#A claim older than this that recorded nothing is treated as ABANDONED.
#``suggest_tags_for_zpage`` commits its ``TagSuggestionRun`` claim before the
#completion and deletes it if the call raises -- but a process killed during
#the call (a Job deadline, an eviction, a deploy draining the subscriber)
#never reaches that handler, and the digest gate would then refuse the page
#forever. No completion takes an hour.
ORPHAN_CLAIM_AGE = timedelta(hours=1)


def _is_orphaned_claim(page, run):
    """A run row that looks like a claim whose completion never came back.

    The cost of guessing wrong is bounded: a pass that genuinely proposed
    nothing (``proposed_count`` 0, no suggestion rows) is indistinguishable,
    and gets ONE more completion per backfill invocation. That is rare -- the
    prompt asks for 6-10 tags and the page is past the length floor -- and
    far cheaper than a page the backfill can never tag.
    """
    if run.proposed_count or run.created_at > timezone.now() - ORPHAN_CLAIM_AGE:
        return False
    return not TagSuggestion.objects.filter(
        zpage=page, source_digest=run.source_digest).exists()


def untagged_published_pages():
    """Publicly visible zPages that carry no tag at all, in pk order."""
    return (
        zPage.objects.published_and_active()
        .filter(tags__isnull=True)
        .order_by("pk")
    )


class Command(BaseCommand):
    help = (
        "Apply AI tags to every published zPage that has zero tags (#2194). "
        "Reuses pending suggestions before buying a completion."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Report what would happen. Writes nothing, calls no provider.",
        )
        parser.add_argument(
            "--limit", type=int, default=0,
            help="Stop after examining this many pages (0 = all).",
        )
        parser.add_argument(
            "--sleep", type=float, default=1.0,
            help="Seconds to wait after each provider completion (throttle).",
        )
        parser.add_argument(
            "--max-failures", type=int, default=5,
            help=(
                "Abort after this many CONSECUTIVE provider failures: a down "
                "provider should stop the run, not be hammered page by page."
            ),
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        limit = options["limit"]
        pause = options["sleep"]
        max_failures = options["max_failures"]
        if limit < 0 or pause < 0 or max_failures < 1:
            raise CommandError(
                "--limit and --sleep must be >= 0, --max-failures >= 1")
        if not dry_run and not services.auto_apply_enabled():
            raise CommandError(
                "TAGGING_AUTO_APPLY_BLANK is off; nothing would be applied.")

        min_chars = int(services._setting(
            "TAGGING_MIN_CHARS", services.DEFAULT_MIN_CHARS))
        counts = {
            "examined": 0,
            "reused_pending": 0,
            "new_pass": 0,
            "nothing_applied": 0,
            "skipped_too_short": 0,
            "skipped_already_suggested": 0,
            "skipped_previously_auto_tagged": 0,
            "provider_failed": 0,
            "reclaimed_orphan_claim": 0,
        }
        applied_tags = 0
        consecutive_failures = 0
        last_pk = 0
        prefix = "[dry-run] " if dry_run else ""

        while True:
            chunk = list(untagged_published_pages().filter(pk__gt=last_pk)[:CHUNK])
            if not chunk:
                break
            for page in chunk:
                if limit and counts["examined"] >= limit:
                    break
                last_pk = page.pk
                counts["examined"] += 1

                if TagSuggestion.objects.filter(
                    zpage=page, status=TagSuggestion.AUTO_APPLIED
                ).exists():
                    # Auto-tagged once and blank again: someone removed them.
                    counts["skipped_previously_auto_tagged"] += 1
                    continue

                digest = services.page_digest(page)
                pending = TagSuggestion.objects.filter(
                    zpage=page, status=TagSuggestion.PENDING,
                    source_digest=digest,
                ).count()
                if pending:
                    if dry_run:
                        counts["reused_pending"] += 1
                        applied_tags += min(pending, services.MAX_AUTO_APPLIED_TAGS)
                        continue
                    names = services.apply_pending_suggestions(page)
                    if names:
                        counts["reused_pending"] += 1
                        applied_tags += len(names)
                        self.stdout.write(
                            f"reused  {page.pk} {page.free2zaddr}: {names}")
                    else:
                        # Tagged by its creator (or unpublished) meanwhile.
                        counts["nothing_applied"] += 1
                    continue

                if len(page.content or "") < min_chars:
                    counts["skipped_too_short"] += 1
                    continue
                run = TagSuggestionRun.objects.filter(
                    zpage=page, source_digest=digest).first()
                orphan = run is not None and _is_orphaned_claim(page, run)
                if run is not None and not orphan:
                    counts["skipped_already_suggested"] += 1
                    continue

                if dry_run:
                    counts["new_pass"] += 1
                    counts["reclaimed_orphan_claim"] += int(orphan)
                    continue
                if orphan:
                    # Only if it is still the same orphan: a live subscriber
                    # delivery may have finished it since we read it.
                    deleted, _ = TagSuggestionRun.objects.filter(
                        pk=run.pk, proposed_count=0).delete()
                    counts["reclaimed_orphan_claim"] += int(bool(deleted))
                try:
                    rows = services.suggest_tags_for_zpage(page, force=True)
                except Exception as exc:  # noqa: BLE001 -- counted, run goes on
                    counts["provider_failed"] += 1
                    consecutive_failures += 1
                    self.stderr.write(
                        f"failed  {page.pk} {page.free2zaddr}: {exc!r}")
                    if consecutive_failures >= max_failures:
                        self._report(counts, applied_tags, prefix)
                        raise CommandError(
                            f"{consecutive_failures} consecutive provider "
                            "failures; stopping. Re-run to resume.")
                    time.sleep(pause)
                    continue
                consecutive_failures = 0
                names = [
                    row.name for row in rows
                    if row.status == TagSuggestion.AUTO_APPLIED
                ]
                if names:
                    counts["new_pass"] += 1
                    applied_tags += len(names)
                    self.stdout.write(
                        f"tagged  {page.pk} {page.free2zaddr}: {names}")
                else:
                    # Claimed by a concurrent subscriber delivery, proposed
                    # nothing, or the creator tagged it mid-completion.
                    counts["nothing_applied"] += 1
                time.sleep(pause)
            if limit and counts["examined"] >= limit:
                break

        self._report(counts, applied_tags, prefix)

    def _report(self, counts, applied_tags, prefix):
        summary = " ".join(f"{key}={value}" for key, value in counts.items())
        self.stdout.write(f"{prefix}{summary} tags_applied={applied_tags}")
