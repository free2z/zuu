"""Compare the legacy zPage shape against ZPageVariant, and repair it ( §3.2).

    python manage.py reconcile_zpage_variants                  # report only
    python manage.py reconcile_zpage_variants --repair
    python manage.py reconcile_zpage_variants --fail-on-drift  # an M5 gate

**This command is the stated blocker on M5.** Both ``variants.py`` and
migration ``0100`` say so in their docstrings, and they are right:

    ``0100`` only ever *creates missing rows*. It never updates a variant whose
    content diverged and never deletes one whose legacy row is gone. Deploys run
    ``migrate`` **before** the pods roll, so for the length of a rollout old
    pods -- which have no dual-write -- keep editing, unpublishing and deleting
    in the legacy shape with no mirror at all. Re-running the backfill does not
    notice any of it: the ``(zpage, language)`` pair is already taken, so it is
    skipped. "We re-ran the backfill" is a *populate* step, not a *repair* step,
    and it is not evidence the two shapes agree.

The same hole opens whenever ``settings.ZPAGE_VARIANT_DUAL_WRITE`` is turned off
and on again -- which, since, is possible only while
``ZPAGE_VARIANT_READS`` is off, because ``variants.dual_write_enabled()``
ignores that switch entirely whenever readers are resolving out of the variant
table -- and whenever a queryset ``.update()`` writes the legacy shape without
calling into ``variants.py``.

Until M5 flips reads, every difference this finds is invisible to readers. On
the day M5 flips, every one of them becomes a wrong page. Run it, get a clean
report, then flip.

What it checks
--------------
Two families. The first compares the two shapes against each other; the second
validates a variant against the model's own rules, which is the only thing you
can do for a row the legacy shape was never going to have.

=========================  ====================================================
``missing-source``         a zPage with no ``origin='source'`` variant
``diverged-source``        the source variant disagrees with the zPage's own
                           language / title / description / content /
                           publication state
``missing-translation``    a ``ZPageTranslation`` row with no variant
``diverged-translation``   the variant disagrees with its translation row
``orphan-variant``         an ``origin='human'`` variant with no translation
                           row behind it -- a deletion or a rename an old pod
                           performed with no mirror
``source-collision``       a translation and the page's own source language
                           claim the same tag. **Reported, never repaired**:
                           the source is the canonical content, and picking a
                           winner automatically is how you destroy an original.
-------------------------  ----------------------------------------------------
``orphan-page``            a variant whose ``zpage_id`` does not resolve. The
                           FK cascades, so this is a DB-integrity alarm, not
                           routine drift -- reported, never repaired.
``ai-missing-digest``      an ``origin='ai'`` variant with no ``source_digest``
``ai-malformed-digest``... or one that is not a SHA-256 hex digest
``ai-invalid-language``    an ``origin='ai'`` variant whose ``language`` is not
                           the **canonical** tag for a language anyone can
                           write in. Not "normalizable" -- canonical. The read
                           path normalizes the tag from the URL and then does
                           an exact match, so a stored ``pt`` (canonical
                           ``pt-BR``) or ``JA`` is a paid translation no reader
                           can reach.
``ai-no-legacy-row``       an ``origin='ai'`` variant with no
                           ``ZPageTranslation`` behind it. **Delete this check
                           in M6** -- see below.
``unreachable-language``   the same canonicality rule for ``source`` and
                           ``human`` variants, which are looked up the same
                           exact way. ``und`` is exempt on the **source**
                           variant only: it is the legacy
                           ``zPage.source_language`` sentinel  M7 deletes
                           and it is all over the pre- corpus. It was never
                           a legal ``ZPageTranslation.language``, so on a
                           ``human`` row it is not inherited data -- it is a
                           translation no reader can reach.
``source-provenance``      an ``origin='source'`` variant carrying a
                           ``source_digest`` or an ``ai_model``. The source has
                           no source and no model wrote it; both write paths
                           clear these unconditionally.
``unknown-origin``         an ``origin`` that is not one of the three declared
                           choices. ``choices=`` is a form/admin validator, not
                           a CHECK constraint, so the column accepts anything.
                           A typo would otherwise fail **open** everywhere:
                           ``_sweep_orphans`` is scoped to ``human`` and the
                           per-origin rules below are scoped to ``source`` and
                           ``ai``, so the row would be checked by nothing at all
                           while readers still resolve it as a translation.
-------------------------  ----------------------------------------------------
``charge-lost-provenance`` a **settled money charge** whose variant does not say
                           it is machine output. See the section below -- this
                           is the only check here that starts from the ledger
                           rather than from content.
``charge-unreadable``      a ``zpage-translate`` charge whose ``response_body``
                           does not carry the keys the sweep above reads --
                           including ``status`` itself. Red rather than counted:
                           an unauditable charge must not pass for an audited
                           one, and a sweep that ENTERS through the field it is
                           auditing can be silenced by the very schema change
                           it exists to survive.
=========================  ====================================================

The money oracle
------------------------
Every other check compares content against content. This one compares content
against a **payment**, and it exists because the failure it finds is otherwise
completely silent.

``translate_zpage`` used to write the legacy ``ZPageTranslation``, let the M3
dual-write signal mirror it as ``origin='human'``, correct that to
``origin='ai'`` with a queryset ``.update()``, and then settle the charge. With
``ZPAGE_VARIANT_DUAL_WRITE`` off the mirror is a no-op, the ``.update()`` matches
zero rows (a queryset update does not raise on an empty match), and the charge
settled anyway. The creator paid; the variant table says a human wrote it, or
says nothing at all. Every AI invariant above is keyed on the *stored* origin, so
``--fail-on-drift`` exited 0 over it, forever.

``translation/tasks.py`` now asserts that ``.update()`` matched exactly one row
and refunds if it did not, so this cannot happen again. This sweep is for what is
already on disk.

**The second oracle is ``IdempotencyKey.response_body``.** The
``zpage-translate`` charge record durably holds the zPage, the target language,
the model and the ``source_digest`` (``translation/charges.py``), so a delivered
charge is a witness that an AI variant is supposed to exist at that
``(zpage, language)`` and what digest it should carry.

**What is a finding, and what is deliberately not:**

**The digest is the evidence; ``origin`` is only the label.** The recorded
``source_digest`` is the one field that ties a variant to *this* charge rather
than to translation-by-machine in general, so it is checked first on every
origin. ``origin='ai'`` on its own would credit an older charge with a row a
LATER re-buy delivered.

*A finding* is a delivered charge whose variant exists but carries neither
``origin='ai'`` nor **any** ``source_digest``. That is the exact fingerprint of a
provenance write that never landed. Before, a creator edit could relabel
an AI variant as ``human`` while preserving its ``source_digest``; those legacy
rows do **not** match the finding. New creator edits retain ``origin='ai'``.

*Neither* is a variant carrying a digest that is **not this charge's own**.
the API stamps human writes too, so "some digest" no longer proves
anything: a wholly hand-written translation of a LATER source revision would
otherwise be counted as this charge's delivery surviving. Those rows are counted
as **unverifiable** rather than as provenanced -- a coverage number that admits
what it does not know, which is the only kind worth printing.

*Not a finding either*: a delivered charge with **no variant at all**. A creator
deleting a translation they did not like is a supported action and leaves exactly
this state, and nothing on disk distinguishes it from a delivery that wrote
nothing. It is counted in the coverage block instead of being reported. This is
not a hole: a delivery that wrote nothing still wrote its ``ZPageTranslation``,
so ``missing-translation`` above already reports it -- and repairing that lands
an ``origin='human'`` row with no digest, which is precisely the finding this
sweep then makes.

**Never repaired, even though the digest is recoverable.** This is the one place
where the "we cannot reconstruct the value" reasoning does not apply -- the
record has the digest. It is still not repaired, for a different reason: the
benign cause (the creator deleted the machine draft and hand-wrote that language
themselves) and the malignant one (the provenance write was lost) produce the
same row, and stamping ``origin='ai'`` on the benign one relabels a person's own
writing as machine output. Fabricating provenance in that direction is worse than
the defect. What a human can do about it *is* actionable, unlike the rest of the
unrepairable list: the record names the creator, the charge and the price.

Why ``origin='ai'`` needs its own rules
-----------------------------------------------
The first family is blind to a legacy-less row by construction: it walks
``zPage`` and ``ZPageTranslation`` and asks what the variant table says about
each. Before this, the *only* place an AI variant appeared in a sweep was
``orphan-variant``, which deliberately excludes it -- so the whole class could
be arbitrarily malformed and ``--fail-on-drift`` still exited 0. That is worse
than no check: it is a green pre-flight in front of the M5 read flip.

The fix is not to run the human rules over AI rows, which would manufacture
drift instead of finding it. The two origins genuinely differ:

``source_digest``
    **Required on ``ai``, meaningless on ``human``.** Delivery writes the
    digest of the exact source text the model translated
    (``translation/tasks.py``), so its absence on an AI row means the
    provenance was lost and staleness silently degrades to "unknown" forever.
    No human path has ever set it, so ``NULL`` there is the normal
    state and flagging it would fire on the whole corpus -- the  mistake.

``ai_model``
    **Not required, on any origin.** It is ``on_delete=SET_NULL`` precisely so
    retiring a model cannot delete a creator's content, so ``NULL`` on an AI
    row is an expected post-retirement state, not drift. A *non-NULL*
    ``ai_model`` on an ``origin='human'`` row can be valid legacy data: before
    , editing an AI variant changed its origin to ``human`` but left
    ``ai_model`` and ``source_digest`` in place. Checking either direction
    would report that history as a defect.

Text
    An AI variant has **no independent oracle of its own**. What it has today
    is a legacy counterpart, because ``translate_zpage`` writes the
    ``ZPageTranslation`` first and only then relabels the mirrored variant to
    ``ai``. So ``diverged-translation`` does compare AI text -- and an AI
    variant *without* that counterpart is a two-shape divergence over content
    a creator paid for, which is why ``ai-no-legacy-row`` is a finding rather
    than a footnote. Whether a reader sees the translation currently depends on
    which pod answers.

    That count is deliberately worded as "still has a legacy row", not "was
    compared". The sweeps run at different moments against a live corpus, so a
    translation edited between sweep 2 and sweep 4 is counted here and was
    compared against its *previous* text. That is inherent to a batched scan
    over a running system -- the same reason ``--repair --fail-on-drift`` does
    a read-only rescan -- and the honest thing is to not let a coverage number
    claim a guarantee the scan does not make.

.. warning::

   **M6 must delete the ``ai-no-legacy-row`` check.**  M6 stops
   dual-writing, at which point "an AI variant with no ``ZPageTranslation``"
   stops being drift and becomes the normal, correct shape -- and this check
   would fire on every paid translation in the corpus and hold the gate red
   forever. It is correct *only* while the legacy shape is still being
   maintained. When you delete it, the AI text genuinely loses its last
   oracle: the coverage line will read ``0 of N`` and that is the true answer,
   not a regression.

Where the coverage claim stops being exact
------------------------------------------
The sweeps walk a primary-key cursor, and Postgres sequences are **not**
transactional. A concurrent INSERT can take id 500, stay uncommitted while the
sweep passes 501, and commit afterwards -- so that row is never examined, and
the counts say nothing about it. This is true of every sweep here (it always
was, for sweeps 1-3), it is not fixable without quiescing writes or holding a
repeatable-read snapshot across the whole corpus, and it is bounded by the
number of writes in flight during the scan. It is a reason to run the gate
against a quiet corpus and to trust the counts as a *floor*, not a reason to
distrust a clean report.

Coverage
--------
Every run prints how many rows of each kind it examined, broken down by
``origin``, and a short list of what it did **not** compare. A drift check that
can silently examine zero rows is the bug  filed; the count is what makes
a future regression visible on the console instead of two milestones later.

Contract
--------
**Read-only unless ``--repair``.** Reporting is the default because the first
thing you want from a drift tool is the size of the problem.

**Repairs are upserts and deletes**, so it is idempotent: run it twice and the
second run finds nothing. It is resumable on a primary-key cursor in bounded
batches, like ``0100``, because it runs against the real production corpus.

**It ignores ``ZPAGE_VARIANT_DUAL_WRITE``.** The kill switch being off is one of
the reasons drift exists; a repair tool that honours it cannot repair the damage
the switch caused. It writes the variant table directly.

**It never touches the legacy shape.** The legacy columns are the source of
truth until M5. Every repair moves the variant toward the legacy row, never the
other way. If the *legacy* side is wrong, that is a content bug for a human.

**``origin`` and ``source_digest`` are preserved** on a diverged translation.
The legacy shape has no column for either, so "repairing" them from it would
mean fabricating provenance -- flattening an AI translation into a human one, or
claiming a translation tracks a source revision nobody verified.

**The variant-integrity findings are never repaired.** ``orphan-page``,
``ai-missing-digest``, ``ai-malformed-digest``, ``ai-invalid-language``,
``source-provenance``, ``unknown-origin``, ``unreachable-language`` and
``ai-no-legacy-row`` all describe a row whose correct value cannot be
reconstructed from anything on disk -- you cannot recover the digest of a source
revision a model saw minutes ago, and you cannot guess which language a
mislabelled translation is in. They are reported, they keep ``--fail-on-drift``
red, and a human fixes them.

The M5 pre-flight
-----------------
Run ``--fail-on-drift``, confirm exit 0, **read the coverage block**, then flip.
Exit 0 now means every zPage, every ``ZPageTranslation``, every ``ZPageVariant``
and every delivered translation charge was examined -- with the per-origin
counts printed so "it examined none of them" cannot pass for "it found nothing
wrong".

``--fail-on-drift`` **refuses** ``--limit`` and ``--start-after`` for exactly
that reason. A scoped run is a spot check: ``--limit 500`` over a 10,000-row
corpus prints "No drift" having looked at 5% of it, and no exit code can
express "clean, but only sort of" to the wrapper script reading it. Scoped runs
still work -- they just print a ``PARTIAL SCAN`` banner and do not offer a
verdict.
"""
import re

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from f2z import languages
from f2z.languages import LanguageError

from dj.apps.g12f.models.zpage import (
    ZPageTranslation,
    ZPageVariant,
    zPage,
)

BATCH_SIZE = 500

#The variant columns that must equal their legacy counterpart.
MIRRORED = ("title", "description", "content", "is_published")

#``source_digest`` is ``hashlib.sha256(...).hexdigest()`` -- see
#``variants.content_digest``. Anything else in that column is a truncated or
#hand-written value that ``staleness()`` will silently compare and always
#call stale, so it is worth naming separately from "not set at all".
SHA256_HEX = re.compile(r"\A[0-9a-f]{64}\Z")

#Findings ``--repair`` deliberately cannot fix, so the report never tells an
#operator to re-run with a write flag that would change nothing.
UNREPAIRABLE = frozenset({
    "source-collision",
    "orphan-page",
    "source-provenance",
    "unknown-origin",
    "ai-missing-digest",
    "ai-malformed-digest",
    "ai-invalid-language",
    "ai-no-legacy-row",
    "unreachable-language",
    # Recoverable in principle -- the charge record holds the digest -- and
    # still never repaired, because the benign cause and the malignant one
    # produce the same row. See the module docstring.
    "charge-lost-provenance",
    # A charge record whose body this sweep cannot read. Repairing it would
    # mean inventing the purchase it describes.
    "charge-unreadable",
})

#``origin`` is a ``CharField`` with ``choices``, and ``choices`` is a
#form-layer validator -- Postgres has no CHECK behind it and ``.update()``
#never runs ``full_clean``. So the set of values on disk is open, and a value
#outside it must be a *finding*, never a row that quietly falls through every
#origin-scoped rule below.
KNOWN_ORIGINS = frozenset(value for value, _ in ZPageVariant.ORIGIN_CHOICES)


def _canonical(tag):
    """The canonical BCP-47 form of ``tag``, or ``None`` if it is not one.

    ``language`` is an exact-match lookup key: the read path normalizes the tag
    out of the URL and then queries for it verbatim. So "is this a language at
    all" is the wrong question -- a stored ``pt`` (canonical ``pt-BR``) or
    ``JA`` normalizes fine and is still a row no reader can ever reach.
    """
    try:
        return languages.normalize(tag, allow_missing=False)
    except LanguageError:
        return None


class Command(BaseCommand):
    help = (
        "Report (and optionally repair) divergence between the legacy zPage / "
        "ZPageTranslation shape and ZPageVariant. Blocks #980 M5."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--repair",
            action="store_true",
            help="Fix what is fixable. Without it the command only reports.",
        )
        parser.add_argument(
            "--fail-on-drift",
            action="store_true",
            help="Exit non-zero if anything is still wrong at the end. Use "
                 "this as the gate in front of M5.",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=0,
            help="Stop after this many zPages / translations / variants per "
                 "sweep (0 = the whole corpus).",
        )
        parser.add_argument(
            "--start-after",
            type=int,
            default=0,
            help="Resume each sweep from this primary key.",
        )
        parser.add_argument(
            "--show",
            type=int,
            default=20,
            help="How many example ids to print per finding (0 = none).",
        )

    def handle(self, *args, **options):
        self.repair = options["repair"]
        self.limit = options["limit"] or None
        self.show = options["show"]
        start = options["start_after"]
        self.scoped_from = start

        if options["fail_on_drift"] and (self.limit or start):
            # A gate has to be a statement about the whole corpus. `--limit
            # 500 --fail-on-drift` over 10,000 variants prints "No drift" and
            # exits 0 having looked at 5% of them, and neither the operator
            # nor a wrapper script can tell that from a clean full run --
            # which is the  failure mode with a different first cause.
            # Refuse rather than annotate: an exit code is what automation
            # reads, and there is no exit code for "clean, but only sort of".
            raise CommandError(
                "--fail-on-drift is a gate over the whole corpus and cannot "
                "be combined with --limit or --start-after. Drop them for the "
                "gate run, or drop --fail-on-drift for a scoped spot check."
            )

        self._reset()
        self._run_pass(start)
        self._report()

        if not options["fail_on_drift"]:
            return

        if self.repair:
            # A repair pass cannot be its own evidence. It counts *attempted*
            # repairs, and it runs against a live corpus -- a write that landed
            # while a sweep was in flight can leave drift the pass never looked
            # at. Gating M5 on "we tried to fix N things" instead of on "a
            # clean read-only scan found nothing" is exactly the mistake
            # `0100`'s docstring warns about with "we re-ran the backfill".
            self.stdout.write("")
            self.stdout.write("verifying with a read-only rescan...")
            self.repair = False
            self._reset()
            self._run_pass(start)
            self._report()

        if self._outstanding():
            raise SystemExit(1)

    def _reset(self):
        self.findings = {}
        self.examples = {}
        self.repaired = {}
        # Coverage, not statistics. A sweep that matched nothing and a sweep
        # that never ran produce the same (empty) findings dict, and  is
        # what that ambiguity costs.
        self.examined = {
            "zpage": 0, "translation": 0, "variant": 0, "charge": 0,
        }
        self.by_origin = {}
        self.ai_with_legacy = 0
        self.ai_without_legacy = 0
        #  money-oracle coverage. `charges_unreadable` counts records whose
        # `response_body` does not carry the keys this sweep assumes -- a schema
        # change in `charges.initial_body` would otherwise silently reduce this
        # sweep to examining nothing while still printing a count.
        self.charges_provenanced = 0
        self.charges_unverifiable = 0
        self.charges_no_variant = 0
        self.charges_page_gone = 0
        self.charges_unreadable = 0
        self.charges_superseded = 0
        self.charges_unsettled = 0

    def _run_pass(self, start):
        self._sweep_sources(start)
        self._sweep_translations(start)
        self._sweep_orphans(start)
        self._sweep_variants(start)
        self._sweep_charges(start)

    def _take(self, seen):
        """Rows to fetch next, honouring ``--limit`` BEFORE the batch, not after.

        Checking the limit only at the end of a 500-row batch means
        ``--limit 1 --repair`` mutates up to 500 rows per sweep. An operator
        asking for a one-record production trial must get a one-record trial.
        """
        if self.limit is None:
            return BATCH_SIZE
        return max(0, min(BATCH_SIZE, self.limit - seen))

    # -- bookkeeping ------------------------------------------------------- #
    def _note(self, kind, key):
        self.findings[kind] = self.findings.get(kind, 0) + 1
        if self.show:
            bucket = self.examples.setdefault(kind, [])
            if len(bucket) < self.show:
                bucket.append(key)

    def _fixed(self, kind):
        self.repaired[kind] = self.repaired.get(kind, 0) + 1

    def _outstanding(self):
        return sum(
            count - self.repaired.get(kind, 0)
            for kind, count in self.findings.items()
        )

    # -- sweep 1: sources -------------------------------------------------- #
    def _sweep_sources(self, cursor):
        seen = 0
        while True:
            take = self._take(seen)
            if take == 0:
                return
            rows = list(
                zPage.objects.filter(pk__gt=cursor)
                .order_by("pk")
                .values("pk", "source_language", "title", "description",
                        "content", "is_published")[:take]
            )
            if not rows:
                return
            cursor = rows[-1]["pk"]
            seen += len(rows)
            self.examined["zpage"] += len(rows)

            page_ids = [row["pk"] for row in rows]
            variants = {}
            for variant in ZPageVariant.objects.filter(zpage_id__in=page_ids):
                variants.setdefault(variant.zpage_id, []).append(variant)

            for row in rows:
                self._check_source(row, variants.get(row["pk"], []))

    def _check_source(self, row, page_variants):
        page_id = row["pk"]
        source = next(
            (v for v in page_variants if v.origin == ZPageVariant.SOURCE), None
        )
        language = row["source_language"]
        if not language:
            # A variant needs a language. A NULL source_language is the
            # detection wave's "not determined yet", not drift -- there is
            # nothing to mirror until it resolves.
            return

        collision = any(
            v.language == language and v.origin != ZPageVariant.SOURCE
            for v in page_variants
        )
        if collision:
            self._note("source-collision", page_id)
            return

        if source is None:
            self._note("missing-source", page_id)
            if self.repair and self._repair_source(page_id):
                self._fixed("missing-source")
            return

        wrong = [
            field for field in MIRRORED if getattr(source, field) != row[field]
        ]
        if source.language != language:
            wrong.append("language")
        if not wrong:
            return

        self._note("diverged-source", (page_id, tuple(sorted(wrong))))
        if self.repair and self._repair_source(page_id):
            self._fixed("diverged-source")

    def _repair_source(self, page_id):
        """Upsert the source variant from a FRESHLY LOCKED zPage row.

        Never from the snapshot the sweep read. Minutes can pass between the
        scan and the repair, and dual-write mirrors inside the request
        transaction that UPDATEs this same zPage row -- so taking the row lock
        serialises us against it. Without this, the repair can overwrite a
        correct, newer mirror with the stale content the sweep happened to see,
        i.e. the tool creates the drift it exists to remove.
        """
        with transaction.atomic():
            page = (
                zPage.objects.select_for_update()
                .filter(pk=page_id)
                .values("pk", "source_language", "title", "description",
                        "content", "is_published")
                .first()
            )
            if page is None or not page["source_language"]:
                return False
            language = page["source_language"]
            if ZPageVariant.objects.filter(
                zpage_id=page_id, language=language
            ).exclude(origin=ZPageVariant.SOURCE).exists():
                return False
            ZPageVariant.objects.update_or_create(
                zpage_id=page_id,
                origin=ZPageVariant.SOURCE,
                defaults={
                    "language": language,
                    "title": page["title"],
                    "description": page["description"],
                    "content": page["content"],
                    "is_published": page["is_published"],
                    # The source has nothing to be stale against and no model
                    # wrote it.
                    "source_digest": None,
                    "ai_model": None,
                },
            )
            return True

    # -- sweep 2: translations --------------------------------------------- #
    def _sweep_translations(self, cursor):
        seen = 0
        while True:
            take = self._take(seen)
            if take == 0:
                return
            rows = list(
                ZPageTranslation.objects.filter(pk__gt=cursor)
                .order_by("pk")
                .values("pk", "zpage_id", "language", "title", "description",
                        "content", "is_published")[:take]
            )
            if not rows:
                return
            cursor = rows[-1]["pk"]
            seen += len(rows)
            self.examined["translation"] += len(rows)

            page_ids = {row["zpage_id"] for row in rows}
            variants = {
                (v.zpage_id, v.language): v
                for v in ZPageVariant.objects.filter(zpage_id__in=page_ids)
            }
            for row in rows:
                self._check_translation(row, variants)

    def _check_translation(self, row, variants):
        key = (row["zpage_id"], row["language"])
        variant = variants.get(key)

        if variant is not None and variant.origin == ZPageVariant.SOURCE:
            # A translation row in the page's own source language. Already
            # reported from the source side; never overwrite the original.
            return

        if variant is None:
            self._note("missing-translation", key)
            if self.repair and self._repair_translation(row["pk"]):
                self._fixed("missing-translation")
            return

        wrong = [
            field for field in MIRRORED
            if getattr(variant, field) != row[field]
        ]
        if not wrong:
            return

        self._note("diverged-translation", (key, tuple(sorted(wrong))))
        if self.repair and self._repair_translation(row["pk"]):
            self._fixed("diverged-translation")

    def _repair_translation(self, translation_pk):
        """Upsert one variant from a FRESHLY LOCKED ZPageTranslation row.

        Same reason as:meth:`_repair_source`: the translation write path
        UPDATEs this row and mirrors in the same transaction, so locking it is
        what stops a stale snapshot from clobbering a newer mirror.

        ``origin`` and ``source_digest`` are set only when the row is created.
        The legacy shape stores neither, so writing them on an update would
        fabricate provenance -- flattening an AI translation into a human one.
        """
        with transaction.atomic():
            row = (
                ZPageTranslation.objects.select_for_update()
                .filter(pk=translation_pk)
                .values("zpage_id", "language", "title", "description",
                        "content", "is_published")
                .first()
            )
            if row is None:
                return False
            existing = ZPageVariant.objects.filter(
                zpage_id=row["zpage_id"], language=row["language"]
            ).first()
            if existing is not None and existing.origin == ZPageVariant.SOURCE:
                return False
            mirrored = {field: row[field] for field in MIRRORED}
            ZPageVariant.objects.update_or_create(
                zpage_id=row["zpage_id"],
                language=row["language"],
                defaults=mirrored,
                create_defaults={**mirrored, "origin": ZPageVariant.HUMAN},
            )
            return True

    def _delete_orphan(self, row):
        """Delete one orphaned variant, re-checking under its own row lock.

        A translation created between the sweep's SELECT and this delete would
        have upserted THIS variant row -- so locking it and re-asking whether a
        translation exists turns "delete a row I saw a while ago" into a
        decision made against current state.
        """
        with transaction.atomic():
            variant = (
                ZPageVariant.objects.select_for_update()
                .filter(pk=row["pk"], origin=ZPageVariant.HUMAN)
                .first()
            )
            if variant is None:
                return False
            if ZPageTranslation.objects.filter(
                zpage_id=variant.zpage_id, language=variant.language
            ).exists():
                return False
            variant.delete()
            return True

    # -- sweep 3: orphans -------------------------------------------------- #
    def _sweep_orphans(self, cursor):
        """Variants left behind by a legacy write that had no mirror.

        Scoped to ``origin='human'`` on purpose. That is the only origin
        dual-write ever produces from a ``ZPageTranslation``, so it is the only
        one whose absence from the legacy shape proves the variant is stale.
        An ``origin='ai'`` variant ( P8) is authored in the variant table
        and has no legacy counterpart *by design* -- deleting it because the old
        table does not know about it would be this command destroying the
        future shape to defend the past one.
        """
        seen = 0
        while True:
            take = self._take(seen)
            if take == 0:
                return
            rows = list(
                ZPageVariant.objects.filter(
                    pk__gt=cursor, origin=ZPageVariant.HUMAN
                )
                .order_by("pk")
                .values("pk", "zpage_id", "language")[:take]
            )
            if not rows:
                return
            cursor = rows[-1]["pk"]
            seen += len(rows)

            page_ids = {row["zpage_id"] for row in rows}
            live = set(
                ZPageTranslation.objects.filter(zpage_id__in=page_ids)
                .values_list("zpage_id", "language")
            )
            orphans = [
                row for row in rows
                if (row["zpage_id"], row["language"]) not in live
            ]
            for row in orphans:
                self._note("orphan-variant", (row["zpage_id"], row["language"]))
                if self.repair and self._delete_orphan(row):
                    self._fixed("orphan-variant")

    # -- sweep 4: variant integrity ---------------------------------------- #
    def _sweep_variants(self, cursor):
        """Every variant, on the variant table's OWN terms.

        Sweeps 1-3 all start from the legacy shape, so a row the legacy shape
        was never going to have -- ``origin='ai'``, written straight into this
        table by paid translation  -- appeared in none of them. This one
        starts from ``ZPageVariant`` instead, so no origin can be skipped by
        construction, and it counts what it saw so a future regression to zero
        is visible on the console.

        **Read-only.** Nothing here is repairable: see the module docstring.
        """
        seen = 0
        while True:
            take = self._take(seen)
            if take == 0:
                return
            rows = list(
                ZPageVariant.objects.filter(pk__gt=cursor)
                .order_by("pk")
                .values("pk", "zpage_id", "language", "origin",
                        "source_digest", "ai_model_id")[:take]
            )
            if not rows:
                return
            cursor = rows[-1]["pk"]
            seen += len(rows)
            self.examined["variant"] += len(rows)

            page_ids = {row["zpage_id"] for row in rows}
            live_pages = set(
                zPage.objects.filter(pk__in=page_ids)
                .values_list("pk", flat=True)
            )
            ai_pages = {
                row["zpage_id"] for row in rows
                if row["origin"] == ZPageVariant.AI
            }
            legacy = set()
            if ai_pages:
                legacy = set(
                    ZPageTranslation.objects.filter(zpage_id__in=ai_pages)
                    .values_list("zpage_id", "language")
                )

            for row in rows:
                self._check_variant(row, live_pages, legacy)

    def _check_variant(self, row, live_pages, legacy):
        origin = row["origin"]
        self.by_origin[origin] = self.by_origin.get(origin, 0) + 1
        key = (row["zpage_id"], row["language"])

        if row["zpage_id"] not in live_pages:
            # The FK is CASCADE, so this cannot happen through the ORM. If it
            # ever does, every other question about the row is moot -- the
            # answer is a DBA, not a repair flag.
            self._note("orphan-page", key)
            return

        if origin not in KNOWN_ORIGINS:
            # Fails open otherwise, and loudly: `_sweep_orphans` is scoped to
            # `human` and every rule below is scoped to `source` or `ai`, so a
            # single-character typo would land a row that NOTHING checks --
            # while the read path still resolves it as a translation and hands
            # a reader an origin no client contract knows.
            self._note("unknown-origin", (key, origin))
            return

        canonical = _canonical(row["language"])

        if origin != ZPageVariant.AI:
            # `language` is an exact-match lookup key for EVERY origin, so a
            # non-canonical tag is unreachable whoever wrote it. `und` is the
            # one exemption, and only on the SOURCE variant: it is the legacy
            # `zPage.source_language` sentinel that  M7 deletes, it is all
            # over the pre- corpus, and holding the gate red on a state
            # that already has an owner just teaches people to override it. It
            # was never a legal `ZPageTranslation.language`, so on a `human`
            # row it is not inherited data -- it is an unreachable translation.
            exempt = origin == ZPageVariant.SOURCE and row["language"] == "und"
            if canonical != row["language"] and not exempt:
                self._note("unreachable-language", (key, origin, canonical))

            if origin == ZPageVariant.SOURCE and (
                row["source_digest"] or row["ai_model_id"]
            ):
                # Both write paths (`variants.sync_source_variant` and
                # `_repair_source`) clear these unconditionally, and the M2
                # backfill wrote NULL. Nothing legitimate produces a source
                # variant that claims a provenance.
                self._note("source-provenance", key)

            # `origin='human'` deliberately gets no provenance rules. A legacy
            # row may carry `ai_model` and `source_digest` because pre-
            # writes relabelled edited AI variants as human; new writes leave
            # the AI origin intact. A normal human row may carry neither.
            return

        if key in legacy:
            self.ai_with_legacy += 1
        else:
            self.ai_without_legacy += 1
            # DELETE THIS CHECK IN M6, and the counter with it. It is true
            # only while dual-write is the contract: today `translate_zpage`
            # writes the ZPageTranslation FIRST and then relabels the mirrored
            # variant, so an AI variant with no legacy row means the
            # translation was deleted (or never mirrored) and the two shapes
            # now disagree about a page a creator PAID for. Which content a
            # reader gets depends on which pod answers. M6 makes the same
            # state the normal one, at which point this fires on the whole
            # corpus -- see the module docstring.
            self._note("ai-no-legacy-row", key)

        digest = row["source_digest"]
        if not digest:
            self._note("ai-missing-digest", key)
        elif not SHA256_HEX.match(digest):
            self._note("ai-malformed-digest", key)

        # No `und` exemption here, unlike the legacy origins above: no paid
        # translation can target the sentinel, so an AI row carrying it is not
        # inherited legacy data, it is a write nobody sanctioned.
        if canonical != row["language"]:
            self._note("ai-invalid-language", (key, canonical))

    # -- sweep 5: settled charges  ---------------------------------- #
    def _sweep_charges(self, cursor):
        """Delivered money against the variant it was supposed to buy.

        The only sweep whose starting point is the ledger. See the module
        docstring for why a payment is a legitimate oracle and why exactly one
        of the two states it can find is a finding.

        **Read-only, always.** Not even ``--repair`` writes here.
        """
        from dj.apps.tuzis.models import IdempotencyKey

        from dj.apps.g12f.translation import charges

        # `charges.FAILED` rather than a literal `{"refunded"}`:  added
        # `settled` (a failure that kept the metered cost of provider work
        # already done), and a status this sweep does not recognize is a
        # FINDING -- so a new terminal state that nobody wired in here would
        # turn every settlement into drift and fail `--fail-on-drift`.
        terminal = {charges.QUEUED, charges.DELIVERED, *charges.FAILED}
        seen = 0
        while True:
            take = self._take(seen)
            if take == 0:
                return
            # EVERY `zpage-translate` record, not just the delivered ones. The
            # obvious query is `response_body__status="delivered"`, and it is a
            # trap: it makes the JSON blob being audited the prerequisite for
            # entering the audit. Rename or corrupt `status` and every charge
            # silently leaves the sweep, the console prints "examined 0", and
            # `--fail-on-drift` exits 0 over the whole corpus --  rebuilt
            # out of a different first cause. Status is classified in Python
            # below so an unrecognized one is a FINDING instead of a filter
            # miss. (codex adversarial review.)
            rows = list(
                IdempotencyKey.objects.filter(
                    pk__gt=cursor, scope=charges.SCOPE,
                )
                .order_by("pk")
                .values("pk", "response_body")[:take]
            )
            if not rows:
                return
            cursor = rows[-1]["pk"]
            seen += len(rows)

            claims = []
            for row in rows:
                body = row["response_body"]
                status = body.get("status") if isinstance(body, dict) else None
                if status == charges.QUEUED or status in charges.FAILED:
                    # In flight, or it delivered nothing. Neither asserts
                    # anything about the variant table -- and `settled`
                    # is a failure too: part of the charge covers provider work
                    # that was done, but no variant was ever written, so
                    # expecting one here would be drift by construction.
                    self.charges_unsettled += 1
                    continue
                if status not in terminal:
                    self.charges_unreadable += 1
                    self._note("charge-unreadable", (row["pk"], "status"))
                    continue

                self.examined["charge"] += 1
                zpage_id = body.get("zpage_id")
                language = body.get("language")
                digest = body.get("source_digest")
                if zpage_id is None or not language:
                    # Same rule one field over: the body schema this sweep reads
                    # is `charges.initial_body`, owned by another app, and a
                    # delivered charge whose target cannot be identified is an
                    # unaudited charge, not a footnote.
                    self.charges_unreadable += 1
                    self._note("charge-unreadable", (row["pk"], "target"))
                    continue
                claims.append((row["pk"], zpage_id, language, digest))

            if not claims:
                continue

            page_ids = {claim[1] for claim in claims}
            live_pages = set(
                zPage.objects.filter(pk__in=page_ids)
                .values_list("pk", flat=True)
            )
            variants = {
                (v.zpage_id, v.language): v
                for v in ZPageVariant.objects.filter(
                    zpage_id__in=page_ids
                ).only("zpage_id", "language", "origin", "source_digest")
            }
            for record_pk, zpage_id, language, digest in claims:
                self._check_charge(
                    record_pk, zpage_id, language, digest, live_pages, variants
                )

    def _check_charge(self, record_pk, zpage_id, language, digest, live_pages,
                      variants):
        if zpage_id not in live_pages:
            # The article was deleted after delivery. `zPage` CASCADEs to its
            # variants, so there is nothing left to check and nothing wrong.
            self.charges_page_gone += 1
            return

        variant = variants.get((zpage_id, language))
        if variant is None:
            # Not a finding. Deleting a translation is a supported action and
            # leaves exactly this state; see the module docstring.
            self.charges_no_variant += 1
            return

        # THE DIGEST FIRST, on every origin. It is the only field that ties a
        # row to THIS charge rather than to translation-by-machine in general.
        #
        # `origin='ai'` alone is not that tie, and reading it as one was the
        # symmetric half of the bug fixed one branch down: a re-buy delivers a
        # second AI variant over the same language, and the FIRST charge would
        # then be reported as having kept its own provenance by looking at a row
        # that belongs to the second. Equally, `origin='human'` with the
        # recorded digest IS the tie for a legacy variant relabelled by
        # pre- edit behavior. Origin is the label; the digest is the
        # evidence. (codex adversarial review.)
        if digest and variant.source_digest == digest:
            self.charges_provenanced += 1
            return

        if variant.origin == ZPageVariant.AI or variant.source_digest:
            # Machine output, or some digest -- but not this charge's. Several
            # innocent histories reach it: a re-buy of the same language, a
            # legacy relabel followed by a body re-edit (which restamps to the
            # current source, ), a hand-written replacement after the
            # machine draft was deleted. And one guilty one. Nothing on disk
            # separates them,
            # so this is neither "provenanced" nor a finding -- it is
            # UNVERIFIABLE, and the coverage block says so rather than letting a
            # count claim an audit that did not happen. The digest's own
            # validity remains `ai-missing-digest` / `ai-malformed-digest`'s job.
            if self._superseded(record_pk, zpage_id, language):
                self.charges_superseded += 1
            else:
                self.charges_unverifiable += 1
            return

        if self._superseded(record_pk, zpage_id, language):
            # A later delivered charge for the same language owns this row now;
            # judging it against an older purchase's expectations would report
            # the same row twice and blame the wrong charge.
            self.charges_superseded += 1
            return

        self._note(
            "charge-lost-provenance", (zpage_id, language, variant.origin)
        )

    def _superseded(self, record_pk, zpage_id, language):
        """Is there a newer delivered charge for the same (zpage, language)?

        Deliberately a per-finding query rather than a global "latest per key"
        pass. Findings are rare by construction -- this only runs for a row that
        already looks wrong -- so the cost is bounded by the damage, while
        holding a corpus-wide map would not be.

        Ordered on the primary key, not ``created_at``: ``IdempotencyKey.finish``
        *advances* ``created_at`` to the completion time, so a long job can
        finish after a shorter one that started later. Insertion order is the
        order the purchases were made in, which is the question being asked.
        """
        from dj.apps.tuzis.models import IdempotencyKey

        from dj.apps.g12f.translation import charges

        return IdempotencyKey.objects.filter(
            pk__gt=record_pk,
            scope=charges.SCOPE,
            response_body__status=charges.DELIVERED,
            response_body__zpage_id=zpage_id,
            response_body__language=language,
        ).exists()



    # -- reporting --------------------------------------------------------- #
    def _report_coverage(self):
        """What was examined, and what was deliberately not compared.

        Printed on every run, clean or not. "No drift" over an empty sweep and
        "no drift" over the whole corpus are the same sentence; only these
        numbers tell them apart, and the second one is the only one that gates
        M5.
        """
        origins = ZPageVariant.ORIGIN_CHOICES
        breakdown = " ".join(
            f"{value}={self.by_origin.get(value, 0)}" for value, _ in origins
        )
        unknown = sorted(
            set(self.by_origin) - {value for value, _ in origins}
        )
        if unknown:
            breakdown += " " + " ".join(
                f"{value}={self.by_origin[value]}" for value in unknown
            )

        if self.limit or self.scoped_from:
            self.stdout.write(self.style.WARNING(
                "PARTIAL SCAN -- --limit/--start-after are in effect, so the "
                "counts below are a slice, not the corpus. This run is a spot "
                "check and is not M5 evidence."
            ))
        self.stdout.write("coverage")
        self.stdout.write(
            f"    zPages examined              {self.examined['zpage']}"
        )
        self.stdout.write(
            f"    ZPageTranslations examined   {self.examined['translation']}"
        )
        self.stdout.write(
            f"    ZPageVariants examined       {self.examined['variant']}"
            f"    ({breakdown})"
        )
        ai_total = self.ai_with_legacy + self.ai_without_legacy
        self.stdout.write(
            f"    origin='ai' variants that still have a legacy translation "
            f"row: {self.ai_with_legacy} of {ai_total}"
        )
        self.stdout.write(
            f"    delivered translation charges examined "
            f"{self.examined['charge']}"
        )
        self.stdout.write(
            f"        {self.charges_provenanced} bought a variant that still "
            "carries THIS charge's own recorded source digest -- usually as "
            "origin='ai', or on a legacy human-origin variant"
        )
        self.stdout.write(
            f"        {self.charges_unverifiable} bought a variant that is "
            "machine output, or carries some digest, but NOT this charge's "
            "(for example, a legacy relabel followed by a re-edit, or a "
            "hand-written replacement after the machine draft was deleted). "
            "Not a finding and NOT counted as "
            "provenanced: nothing on disk separates those from a lost delivery"
        )
        self.stdout.write(
            f"        {self.charges_no_variant} have no variant at that "
            "language at all -- NOT a finding: deleting a translation is a "
            "supported action and leaves the same state. A delivery that wrote "
            "nothing still wrote its ZPageTranslation, so missing-translation "
            "reports it, and repairing that produces the finding below"
        )
        self.stdout.write(
            f"        {self.charges_page_gone} bought a zPage that has since "
            f"been deleted; {self.charges_superseded} were superseded by a "
            f"later purchase of the same language; {self.charges_unreadable} "
            "carry a response_body this sweep could not read and are reported "
            "as charge-unreadable (a schema change in charges.initial_body "
            "shows up here, and holds the gate red rather than passing over "
            f"money it could not audit); {self.charges_unsettled} are still "
            "queued or were refunded and assert nothing about the variant table"
        )
        self.stdout.write("not compared -- a clean run does NOT assert these")
        self.stdout.write(
            f"    the TEXT of the {self.ai_without_legacy} origin='ai' "
            "variant(s) with no ZPageTranslation behind them: there is no "
            "second copy to compare against. Today that is itself a finding "
            "(ai-no-legacy-row); after M6 it is the normal shape and the "
            "text becomes uncheckable by definition"
        )
        if self.ai_with_legacy:
            self.stdout.write(
                f"    the text of the other {self.ai_with_legacy} as of THIS "
                "instant: that comparison happened in an earlier sweep of the "
                "same run, so an edit landing between the two sweeps is "
                "counted above but was checked against the previous text"
            )
        self.stdout.write(
            "    ai_model, on any origin: NULL on an AI row is the expected "
            "state after a model is retired (SET_NULL), and a non-NULL one on "
            "a human row with a model is legacy provenance from pre-#1911 "
            "edit behavior, so neither direction is drift"
        )
        self.stdout.write(
            "    source_digest on origin='human': NULL there is 'unknown', not "
            "'stale'. The API write path stamps it from #1104 onward, but the "
            "M2-backfilled corpus and every pre-#1104 hand-written translation "
            "carry NULL and always will"
        )
        self.stdout.write(
            "    the TEXT a delivered charge bought: the charge record holds "
            "the source digest, the model and the price, but never the "
            "delivered translation itself, so a row that says 'ai' is taken at "
            "its word"
        )
        self.stdout.write("")

    def _report(self):
        self._report_coverage()

        if not self.findings:
            self.stdout.write(self.style.SUCCESS(
                "No drift: every zPage and ZPageTranslation matches its "
                "ZPageVariant, and every variant satisfies its own origin's "
                "rules. This is the evidence #980 M5 asks for -- read it "
                "together with the coverage counts above."
            ))
            return

        for kind in sorted(self.findings):
            found = self.findings[kind]
            fixed = self.repaired.get(kind, 0)
            style = self.style.SUCCESS if fixed == found else self.style.ERROR
            self.stdout.write(style(
                f"{kind:<24} found={found:<8} repaired={fixed}"
            ))
            for example in self.examples.get(kind, []):
                self.stdout.write(f"    {example}")

        outstanding = self._outstanding()
        self.stdout.write("")
        if not outstanding:
            self.stdout.write(self.style.SUCCESS("All drift repaired."))
            return

        # "Re-run with --repair" is only ever true advice when something
        # outstanding is actually repairable. Printing it under a report that
        # is entirely `ai-missing-digest` sends an operator to run a write
        # command that will change nothing, and then to distrust the tool.
        repairable = sorted(set(self.findings) - UNREPAIRABLE)
        self.stdout.write(self.style.ERROR(
            f"{outstanding} finding(s) still outstanding."
            + (" Re-run with --repair." if repairable and not self.repair
               else "")
        ))
        stuck = sorted(set(self.findings) & UNREPAIRABLE)
        if stuck:
            self.stdout.write(
                f"{', '.join(stuck)}: never repaired automatically, because "
                "the correct value is not recoverable from anything on disk. "
                "Nothing records which of two rows claiming the same tag is "
                "the original, nor which source revision a model was shown, "
                "nor what a mislabelled row's real language is -- and "
                "guessing would replace a visible defect with an invisible "
                "one. These need a human, and they hold --fail-on-drift red "
                "until one looks."
            )
        if "charge-lost-provenance" in self.findings:
            # This one is unrepairable for a DIFFERENT reason than the rest,
            # and lumping it under the sentence above would send an operator
            # looking for a missing value that is, in fact, right there.
            self.stdout.write(
                "charge-lost-provenance is the exception to that sentence: the "
                "digest IS recoverable, from the zpage-translate "
                "IdempotencyKey.response_body. It is still not repaired "
                "automatically because a creator who deleted the machine draft "
                "and hand-wrote that language themselves leaves the identical "
                "row, and stamping origin='ai' on that relabels a person's own "
                "writing as machine output. Each id above names a settled "
                "charge -- look at the record, then decide: stamp it, or refund "
                "the creator."
            )
