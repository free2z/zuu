"""Detect the language of every unlabelled zPage ( M4, the corpus drain).

    python manage.py backfill_zpage_languages                 # dry run
    python manage.py backfill_zpage_languages --execute --max-usd 2.00

The owner's decision, verbatim: *"we can detect the language with a batched call
of just the first sentence or two and it should be super cheap to backfill."*
This is that command.

Why it is a management command and not a migration
--------------------------------------------------
A migration runs inside ``cloudbuild.yaml``'s ``migrate`` step, before the pods
roll. Putting thousands of paid provider calls there means a deploy that hangs
on a vendor's bad afternoon, a cost that nobody approved at the moment it is
incurred, and no way to stop it. This runs when an operator decides to run it,
with a ceiling they chose.

Safety properties, in the order they matter
-------------------------------------------
**Dry run by default.** ``--execute`` is required to make a single paid call.
A dry run builds the *real* primary-batch prompts and prices every output at
its cap, so its projection is a conservative upper-bound estimate for that
planned path. Runtime retries and isolated fallbacks cannot be known in a dry
run and are accounted conservatively during execution.

**A hard cost ceiling.** ``--max-usd`` (default $1.00, deliberately small) is
checked *before* every call, against the estimated cost of that call with the
output budget charged at its cap. The run stops the moment the next call would
cross it. The amount being small is not a reason to run an unbounded loop
against a paid API -- and a ceiling that assumes the cheap case is not a
ceiling.

**Resumable and idempotent**, like migration ``0100``. A page that gets a
language leaves the selection, so re-running picks up exactly where the ceiling,
the ``--limit`` or a Ctrl-C stopped it. Running it once more when the corpus is
clean does nothing and costs nothing.

**Never touches a human's label.** ``language_source='creator'`` is excluded
from the selection, re-checked under ``SELECT... FOR UPDATE`` at the write
(minutes pass in between, and a creator can relabel in that window), and
refused a third time inside ``apply_detection``. A page that already carries a
real language is not in scope at all -- this command exists to drain ``und``
and NULL, not to relabel the corpus.

**Controls the attacker cannot identify.** Batching means many creators' pages
share one context window, so the batch carries control documents whose language
is already known and whose answers, if wrong, discard the whole batch. The
static ``BATCH_CANARIES`` are in the source tree and can be recognised and
answered correctly by a hostile page; this command therefore prefers controls
drawn from **creator-labelled zPages** -- human-asserted ground truth that is
indistinguishable from the documents being classified.

**No re-index.** A search re-index is an OpenAI summary *plus* an embedding per
page; doing one per detection would cost one to two orders of magnitude more
than the detection itself, which is precisely the cost blowup  Part 12
names. The embedding text carries the language tag, so the index catches up on
each page's next real edit.

What it reports
---------------
Estimated upper-bound spend (from our own tokenizer and every request's output
cap -- see ``DetectionUsage``), in USD and in 2Z at the $0.01 anchor; how many
pages resolved; how many batches hit a canary failure and fell back to isolated
per-document calls; and **how many unlabelled pages remain**, which is the
number  M7 is waiting on before ``und`` can be deleted.
"""
import math
import time

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q

from f2z.ai import language as lang

from dj.apps.g12f.models.zpage import (
    LANGUAGE_SOURCE_CREATOR,
    LEGACY_UNDETERMINED_LANGUAGE,
    zPage,
)
from dj.apps.g12f.tasks import apply_detection

#Rows pulled from Postgres per round trip. Independent of the provider batch
#size: this bounds memory, that bounds one prompt.
DB_BATCH_SIZE = 200

#Default ceiling. Small on purpose -- an operator who wants to spend more says
#so, and the command is resumable, so ten $1 runs are a legitimate way to work.
DEFAULT_MAX_USD = 1.00

# A small sample is noisy: one fallback in a two-page smoke test says nothing
# useful about corpus-wide batching efficiency.  At a full provider batch,
# however, fallbacks at this rate erase enough of batching's savings that an
# operator needs to see them before relying on the summary's aggregate cost.
FALLBACK_WARNING_RATE = 0.10
FALLBACK_WARNING_MIN_CLASSIFIABLE_PAGES = lang.BATCH_MAX_DOCUMENTS


def unlabelled_zpages():
    """Every zPage that has no real language and no human saying otherwise.

    ``und`` and NULL are the same thing here: "nobody ever determined this".
    NULL is the honest representation  §3.2 replaces the sentinel with;
    ``und`` is what the create path still mints until M7. Both are in scope.
    """
    return (
        zPage.objects.filter(
            Q(source_language__isnull=True)
            | Q(source_language="")
            | Q(source_language=LEGACY_UNDETERMINED_LANGUAGE)
        )
        .exclude(language_source=LANGUAGE_SOURCE_CREATOR)
    )


class Command(BaseCommand):
    help = (
        "Detect the language of every unlabelled zPage with batched provider "
        "calls. Dry run unless --execute is passed."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--execute",
            action="store_true",
            help=(
                "Actually call the provider and write the results. Without "
                "this the command projects the primary batched path and "
                "writes nothing."
            ),
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Explicit no-op alias for the default. Cannot be combined "
                 "with --execute.",
        )
        parser.add_argument(
            "--max-usd",
            type=float,
            default=DEFAULT_MAX_USD,
            help=f"Hard spend ceiling in USD (default {DEFAULT_MAX_USD:.2f}). "
                 f"Checked before every call.",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=lang.BATCH_MAX_DOCUMENTS,
            help=f"Documents per provider call "
                 f"(default {lang.BATCH_MAX_DOCUMENTS}).",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=0,
            help="Stop after considering this many pages (0 = no limit).",
        )
        parser.add_argument(
            "--start-after",
            type=int,
            default=0,
            help="Resume from this primary key. Rarely needed -- a labelled "
                 "page leaves the selection, so a plain re-run resumes.",
        )
        parser.add_argument(
            "--sleep",
            type=float,
            default=0.0,
            help="Seconds to sleep between provider calls, to be polite to a "
                 "rate limit.",
        )

    def handle(self, *args, **options):
        execute = options["execute"]
        if options["dry_run"] and execute:
            self.stderr.write(
                self.style.ERROR("--dry-run and --execute are contradictory.")
            )
            return
        budget = float(options["max_usd"])
        if not math.isfinite(budget) or budget <= 0:
            # `float("nan")` parses fine and then makes EVERY ceiling
            # comparison false, so a typo would turn the ceiling off entirely
            # rather than reject the run. `inf` is the same hazard spelled out
            # loud.
            self.stderr.write(self.style.ERROR(
                "--max-usd must be a positive, finite number."
            ))
            return
        batch_size = max(1, min(options["batch_size"],
                                lang.BATCH_MAX_DOCUMENTS))
        limit = options["limit"] or None
        cursor = options["start_after"]

        usage = lang.DetectionUsage()
        outcome = lang.BatchOutcome()
        # Keep the quote and the paid path on the same batch-specific selector.
        # Single-document detection intentionally keeps its usual cheapest
        # selection; this command is the multi-document path.
        model = lang.select_batch_detection_model()
        if model is None:
            self.stderr.write(self.style.ERROR(
                "No callable GA AIModel is configured (no API key for any "
                "seeded provider). Nothing to do."
            ))
            return
        # The command calls `detect_languages_batch` once per provider-sized
        # row slice. Share this mutable list across those calls so a transport
        # or empty-response circuit break persists for the whole command, not
        # just the first slice that observed the unhealthy candidate.
        batch_candidates = (
            list(lang.callable_batch_detection_models()) if execute else None
        )

        controls = self._corpus_controls()
        self.stdout.write(
            f"controls: "
            f"{'corpus (' + str(len(controls)) + ')' if controls else 'static canaries'}"
        )
        self.stdout.write(
            f"model: {model.provider}/{model.model}   "
            f"mode: {'EXECUTE' if execute else 'DRY RUN'}   "
            f"ceiling: ${budget:.2f}   batch: {batch_size}"
        )

        scanned = detected = 0
        fallback_warning_emitted = False

        while not outcome.budget_exhausted:
            remaining_slots = None
            if limit is not None:
                remaining_slots = limit - scanned
                if remaining_slots <= 0:
                    break
            rows = list(
                unlabelled_zpages()
                .filter(pk__gt=cursor)
                .order_by("pk")
                .values("pk", "title", "content")[:DB_BATCH_SIZE]
            )
            if not rows:
                break
            cursor = rows[-1]["pk"]
            if remaining_slots is not None:
                rows = rows[:remaining_slots]

            for start in range(0, len(rows), batch_size):
                chunk = rows[start:start + batch_size]
                scanned += len(chunk)
                documents = [
                    (row["pk"], row["title"], row["content"]) for row in chunk
                ]

                if not execute:
                    self._price_only(
                        documents, model, usage, outcome, budget, controls,
                    )
                    if outcome.budget_exhausted:
                        break
                    continue

                results = lang.detect_languages_batch(
                    documents,
                    usage=usage,
                    outcome=outcome,
                    budget_usd=budget,
                    controls=controls,
                    batch_candidates=batch_candidates,
                )
                if not fallback_warning_emitted:
                    warning = self._fallback_warning(outcome)
                    if warning is not None:
                        self.stderr.write(self.style.WARNING(warning))
                        fallback_warning_emitted = True
                detected += self._write(results)
                if outcome.budget_exhausted:
                    break
                if options["sleep"]:
                    time.sleep(options["sleep"])

        self._report(
            execute, scanned, detected, usage, outcome, budget,
        )

    # -- dry run ----------------------------------------------------------- #
    def _price_only(self, documents, model, usage, outcome, budget, controls):
        """Price the batches we *would* send, without sending them.

        ``controls`` is threaded through because the quote has to price the
        prompt ``--execute`` will actually build. Corpus-drawn controls are
        real zPage text and are longer than the static canaries, so pricing the
        canaries and then sending the corpus ones would make the operator-facing
        number wrong in a direction that depends on the corpus.
        """
        for keys, usd, input_tokens, output_tokens in lang.price_documents(
            model, documents, controls=controls
        ):
            if usage.usd + usd > budget:
                outcome.budget_exhausted = True
                return
            outcome.batches += 1
            usage.calls += 1
            usage.usd += usd
            usage.input_tokens += input_tokens
            usage.output_tokens += output_tokens
        outcome.no_text += sum(
            1 for _pk, title, content in documents
            if not lang.first_sentences(title, content)
        )

    # -- writes ------------------------------------------------------------ #
    def _write(self, results):
        """Persist the detections. One page at a time, under a row lock.

        **One page at a time on purpose.** ``apply_detection`` runs the  M3
        dual-write receiver, which renames the page's source variant to match
        its new language. A ``bulk_update`` fires no signals and would leave
        every backfilled page's variant still claiming ``und`` -- exactly the
        divergence the reconciler exists to find, manufactured by the tool that
        was supposed to fix things.

        **Under ``SELECT... FOR UPDATE`` on purpose.** Minutes pass between the
        SELECT that chose these pages and this write, and a creator can relabel
        one of them in that window. Checking ``language_source`` on a stale
        in-memory row and then writing unconditionally would erase the override
        it just checked for. The lock makes the check and the write one
        decision, the same way the interactive task does it.
        """
        written = 0
        for pk, detection in results.items():
            if detection is None or not detection.is_known:
                continue
            with transaction.atomic():
                page = (
                    zPage.objects.select_for_update().filter(pk=pk).first()
                )
                if page is None:
                    continue
                if page.language_source == LANGUAGE_SOURCE_CREATOR:
                    continue
                apply_detection(page, detection, reindex=False)
                written += 1
        return written

    # -- controls ---------------------------------------------------------- #
    def _corpus_controls(self):
        """Ground-truth control documents drawn from our own corpus.

        The static:data:`f2z.ai.language.BATCH_CANARIES` are in the source
        tree, so a hostile page can name them and instruct the model to answer
        them correctly while steering every *other* document in the batch.
        Creator-labelled zPages are human-asserted ground truth and are
        indistinguishable from the documents being classified, so an attacker
        cannot tell which envelope is the control.

        Falls back to the static canaries when the corpus has no creator labels
        yet -- which is the state on the day this ships.
        """
        controls = []
        seen = set()
        rows = (
            zPage.objects.filter(language_source=LANGUAGE_SOURCE_CREATOR)
            .exclude(source_language__isnull=True)
            .order_by("?")
            .values("source_language", "title", "content")[:20]
        )
        for row in rows:
            if row["source_language"] in seen:
                continue
            sample = lang.first_sentences(row["title"], row["content"])
            if len(sample) < lang.SPARSE_SAMPLE_CHARS:
                continue
            seen.add(row["source_language"])
            controls.append((row["source_language"], sample))
            if len(controls) >= len(lang.BATCH_CANARIES):
                break
        return controls or None

    # -- reporting --------------------------------------------------------- #
    @staticmethod
    def _fallback_warning(outcome):
        """Return an efficiency warning once the sample is meaningful."""
        classifiable_pages = (
            outcome.batch_attempted_documents
            + outcome.fallback_direct_documents
        )
        if classifiable_pages < FALLBACK_WARNING_MIN_CLASSIFIABLE_PAGES:
            return None
        # Routed documents are the honest numerator: a cost ceiling can defer
        # their isolated calls, but it must not turn a discarded batch into a
        # deceptively healthy 0% fallback rate. Direct routes after an open
        # circuit join the denominator too, so the warning cannot exceed 100%.
        fallback_rate = (
            outcome.fallback_routed_documents / classifiable_pages
        )
        if fallback_rate < FALLBACK_WARNING_RATE:
            return None
        return (
            "WARNING: batch fallback rate is "
            f"{outcome.fallback_routed_documents}/{classifiable_pages} "
            f"({fallback_rate:.1%}); isolated re-detection is reducing "
            "batching efficiency."
        )

    def _report(self, execute, scanned, detected, usage, outcome, budget):
        remaining = unlabelled_zpages().count()
        label = (
            "estimated upper-bound spend"
            if execute else "projected upper-bound spend"
        )

        self.stdout.write("")
        self.stdout.write(f"pages considered      {scanned}")
        self.stdout.write(
            f"  no classifiable text{outcome.no_text:>8}  (skipped, "
            f"cost nothing)")
        if execute:
            self.stdout.write(f"  labelled            {detected:>8}")
        self.stdout.write(f"provider calls        {usage.calls}")
        self.stdout.write(f"  batches             {outcome.batches:>8}")
        self.stdout.write(
            f"  canary failures     {outcome.canary_failures:>8}  "
            f"(batch discarded, documents re-detected in isolation)"
        )
        self.stdout.write(
            f"  fallback routed     {outcome.fallback_routed_documents:>8}  "
            "(documents sent to isolated detection)"
        )
        self.stdout.write(
            f"  fallback direct     {outcome.fallback_direct_documents:>8}  "
            "(no healthy shared batch candidate)"
        )
        self.stdout.write(
            f"  isolated started   {outcome.fallback_documents:>8}  "
            "(documents whose isolated detection started)"
        )
        self.stdout.write(
            "  fallback deferred  "
            f"{outcome.fallback_budget_deferred_documents:>8}  "
            "(held for a later run by the cost ceiling)"
        )
        self.stdout.write(f"  unresolved          {outcome.unresolved:>8}")
        self.stdout.write(
            f"tokens                in={usage.input_tokens} "
            f"out={usage.output_tokens}"
        )
        self.stdout.write(self.style.WARNING(
            f"{label} ${usage.usd:.4f}  (~{usage.tuzis} 2Z equivalent; "
            "estimated from our tokenizer with full output caps per attempt, "
            "not a provider usage block)"
        ))
        if scanned:
            self.stdout.write(
                f"  upper-bound/page    ${usage.usd / scanned:.6f}")
            if remaining:
                self.stdout.write(
                    f"  projected upper bound for the remaining {remaining} "
                    "pages: "
                    f"${usage.usd / scanned * remaining:.2f}"
                )
        if outcome.budget_exhausted:
            self.stdout.write(self.style.WARNING(
                f"STOPPED at the ${budget:.2f} ceiling. Re-run to continue -- "
                f"this command is resumable."
            ))

        self.stdout.write("")
        self.stdout.write(
            f"unlabelled zPages remaining: {remaining}   "
            f"(#980 M7 deletes `und` once this reaches 0 and #953 has landed)"
        )
        if not execute:
            self.stdout.write(self.style.NOTICE(
                "DRY RUN -- nothing was sent to a provider and nothing was "
                "written. Re-run with --execute to use the estimated "
                "upper-bound amount above."
            ))
