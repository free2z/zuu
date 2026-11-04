"""Backfill ZPageVariant from the legacy shape (#980 M2, step 4 of 4).

Two forward sweeps over the corpus:

1. every ``zPage`` gets a variant carrying its own title/description/content
   with ``origin="source"``;
2. every ``ZPageTranslation`` row is copied to a variant with ``origin="human"``.

Nothing reads these rows. M3 dual-write (in application code, shipping in the
same PR) keeps them in step from here on; M5 flips reads over later, behind a
flag, in a separate change.

Runtime characteristics — this runs against the real production corpus
--------------------------------------------------------------------
**Non-atomic, so no long-lived lock and no giant transaction.** ``atomic =
False`` means each ``bulk_create`` commits on its own. The longest lock this
migration takes is the row-level lock of a single 500-row INSERT into a table
nothing else reads. It never locks ``g12f_zpage`` or ``g12f_zpagetranslation``
at all — it only SELECTs from them.

**Bounded memory.** Each iteration holds at most ``BATCH_SIZE`` rows. zPage
content is capped at 100,000 characters, so the theoretical worst case per
batch is ~50 MB of Python strings if every page in a batch were at the cap;
the realistic figure is one to two orders of magnitude below that. It is a
constant either way — the peak does not grow with the size of the corpus,
which is the property that matters.

**Resumable and idempotent.** A pk cursor walks forward; each batch first asks
which of its rows already have a variant and only inserts the rest, and the
INSERT itself is ``ON CONFLICT DO NOTHING`` so a concurrent dual-write that
created the same row between the SELECT and the INSERT is a no-op rather than
a crash. Kill this migration mid-batch and re-run it: the committed batches are
skipped, the interrupted batch is redone from scratch, and the result is
identical. Run it a third time and it writes nothing at all.

**No pk ceiling, deliberately** (unlike ``0089``, which needed one to avoid
sweeping new rows into the ``und`` set). Here a brand-new page arriving mid-run
*should* get a source variant, and creating one for it is correct.

**What re-running does NOT do — read this before M5.**
This sweep only ever *creates missing rows*. It never updates a variant whose
content has diverged and never deletes a variant whose legacy row is gone. That
matters because of the deploy order: ``cloudbuild.yaml`` runs ``migrate``
*before* the new pods roll out, so old pods — which have no dual-write — keep
serving during and after this sweep. An old pod that edits, unpublishes or
deletes a translation after this migration's cursor has passed its page leaves
a variant that is stale or orphaned, and re-running this migration will not
notice: the ``(zpage, language)`` pair is already taken, so it is skipped.

That drift is invisible today, because nothing reads variants. It is **not**
invisible at M5.

    M5 (flipping reads to variants) is BLOCKED on a drift reconciler — the
    management command #980 §3.2 already calls for — that compares the two
    shapes row by row and repairs content, publication state and orphans. Do
    not flip reads on the strength of "the backfill was re-run"; re-running
    this migration is a *populate* step, not a *repair* step.

**Cost.** One INSERT per zPage plus one per translation — a full copy of the
content, so expect the database to grow by roughly the size of
``g12f_zpage``'s text plus ``g12f_zpagetranslation``. That is the price of
having both shapes live at once, and M8 reclaims it by dropping the legacy
columns.

Rows deliberately skipped, each of which is a data anomaly rather than a case
to guess at:

* a zPage whose ``source_language`` is NULL (only reachable if a future wave
  writes NULL before this migration is re-run) — a variant needs a language;
* a translation whose language is already taken for that page, which after
  sweep 1 means it collides with the page's own source language. The source is
  the canonical content and wins; overwriting it with a translation would
  destroy the original.
"""
from django.db import migrations


BATCH_SIZE = 500

# Progress goes to the Cloud Build `migrate` step's log. A backfill over the
# whole corpus that prints nothing is indistinguishable from a hung one.
LOG_EVERY = 20


def _log(label, created, scanned):
    print(
        f"[0100_backfill_zpage_variants] {label}: "
        f"scanned={scanned} created={created}",
        flush=True,
    )


def backfill_source_variants(ZPage, ZPageVariant):
    """Sweep 1: one ``origin='source'`` variant per zPage."""
    cursor = 0
    created = scanned = batches = 0
    while True:
        rows = list(
            ZPage.objects.filter(pk__gt=cursor)
            .order_by("pk")
            .values(
                "pk",
                "source_language",
                "title",
                "description",
                "content",
                "is_published",
            )[:BATCH_SIZE]
        )
        if not rows:
            break
        cursor = rows[-1]["pk"]
        scanned += len(rows)
        batches += 1

        page_ids = [row["pk"] for row in rows]
        already = set(
            ZPageVariant.objects.filter(
                zpage_id__in=page_ids, origin="source"
            ).values_list("zpage_id", flat=True)
        )
        pending = [
            ZPageVariant(
                zpage_id=row["pk"],
                language=row["source_language"],
                title=row["title"],
                description=row["description"],
                content=row["content"],
                is_published=row["is_published"],
                origin="source",
                # The source has nothing to be stale against.
                source_digest=None,
            )
            for row in rows
            if row["pk"] not in already and row["source_language"]
        ]
        if pending:
            ZPageVariant.objects.bulk_create(pending, ignore_conflicts=True)
            created += len(pending)
        if batches % LOG_EVERY == 0:
            _log("source variants", created, scanned)

    _log("source variants complete", created, scanned)


def backfill_translation_variants(ZPageTranslation, ZPageVariant):
    """Sweep 2: one ``origin='human'`` variant per ZPageTranslation row."""
    cursor = 0
    created = scanned = batches = 0
    while True:
        rows = list(
            ZPageTranslation.objects.filter(pk__gt=cursor)
            .order_by("pk")
            .values(
                "pk",
                "zpage_id",
                "language",
                "title",
                "description",
                "content",
                "is_published",
            )[:BATCH_SIZE]
        )
        if not rows:
            break
        cursor = rows[-1]["pk"]
        scanned += len(rows)
        batches += 1

        page_ids = {row["zpage_id"] for row in rows}
        # Every (page, language) pair that already exists, whatever its origin.
        # A pair held by the source variant is the collision case: skipping it
        # here is what stops a stray same-language translation row from
        # overwriting the article's own content.
        taken = set(
            ZPageVariant.objects.filter(
                zpage_id__in=page_ids
            ).values_list("zpage_id", "language")
        )
        pending = [
            ZPageVariant(
                zpage_id=row["zpage_id"],
                language=row["language"],
                title=row["title"],
                description=row["description"],
                content=row["content"],
                is_published=row["is_published"],
                origin="human",
                # NULL, not "the current source digest": we do not know which
                # revision of the source this translation was made from, and
                # claiming it is current would be a fabrication. NULL means
                # *unknown* -- see the three-state contract on the field.
                source_digest=None,
            )
            for row in rows
            if (row["zpage_id"], row["language"]) not in taken
        ]
        if pending:
            ZPageVariant.objects.bulk_create(pending, ignore_conflicts=True)
            created += len(pending)
        if batches % LOG_EVERY == 0:
            _log("translation variants", created, scanned)

    _log("translation variants complete", created, scanned)


def backfill(apps, schema_editor):
    ZPage = apps.get_model("g12f", "zPage")
    ZPageTranslation = apps.get_model("g12f", "ZPageTranslation")
    ZPageVariant = apps.get_model("g12f", "ZPageVariant")

    # Order matters: sources first, so a translation that shares the page's
    # source language finds the pair already taken and is skipped rather than
    # winning the slot.
    backfill_source_variants(ZPage, ZPageVariant)
    backfill_translation_variants(ZPageTranslation, ZPageVariant)


class Migration(migrations.Migration):
    # Small, independently-committed batches. A failed process re-runs the data
    # operation harmlessly, and 0099 has already been durably recorded.
    atomic = False

    dependencies = [("g12f", "0099_zpagevariant")]

    operations = [
        # No reverse. Reversing past 0099 drops the whole table, which is the
        # only correct undo; a reverse that deleted rows here could not tell a
        # backfilled variant from one dual-write created afterwards, and would
        # destroy real writes to undo a copy.
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
