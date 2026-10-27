"""Record a real detection run over the close-pair eval corpus.

This is the only thing in the eval that spends money. It runs by hand, on a
developer machine with a provider key, and its output is committed so CI can
replay it for free:

    python dj/free2z/manage.py record_language_eval --spend 0.25

The whole corpus is ~65 short documents at ~900 input tokens each, so a run
costs single-digit US cents on a cheap GA model. ``--spend`` is still
mandatory: an unattended command that calls a paid API in a loop needs a
ceiling it cannot talk its way past, and "it is only cents" is exactly what
every runaway loop was before it ran.

The recording is scored by ``test_language_detection_evals.py``. Re-recording
is expected whenever the model lineup changes or the corpus does — the
fingerprint in the file makes a stale pairing loud.
"""

import decimal

from django.core.management.base import BaseCommand, CommandError

from f2z.ai import language as lang

from ... import language_eval, language_eval_corpus


#Flush the recording to disk every this many samples.
#
#These replies are paid for. Saving only at the end means a slow provider
#plus an impatient ^C loses every call made so far, and the re-run pays for
#them again. Ten is small enough that an interruption costs pennies and
#large enough that the file is not rewritten 67 times.
CHECKPOINT_EVERY = 10


class _RawCapture(lang.DetectionUsage):
    """A usage accumulator that also keeps what the model actually said.

    The recording stores the model's **raw reply**, not the tag detection
    derived from it, and this is the seam that makes that possible without
    changing a production signature: ``DetectionUsage.record`` is already
    handed the raw text of every attempt, for pricing.

    Storing the normalized tag instead would quietly bake today's
    normalization policy into the recording. A model that replied ``pt``
    would be stored as ``pt-BR``; if the regional default later moved, live
    detection would change and the replay would not, so the eval would keep
    reporting a result nothing produces any more — and partial recordings
    made either side of the change would merge into one another. The raw
    reply is the only thing about a run that is a fact rather than a policy.
    """

    def __init__(self):
        super().__init__()
        self.raw_replies = []

    def record(self, ai_model, messages, raw, output_tokens=None):
        self.raw_replies.append(raw)
        return super().record(ai_model, messages, raw, output_tokens=output_tokens)

    def take_attempts(self):
        """EVERY attempt for this sample, in order, then reset.

        Not just the accepted one. Detection takes the first attempt that
        normalizes, so a validation change can move the acceptance decision
        backwards onto an attempt that used to be rejected. A recording that
        kept only the winner would replay the old decision forever while live
        detection made a new one — the specific way a recording silently
        stops describing the pipeline it is supposed to pin.
        """
        attempts = list(self.raw_replies)
        self.raw_replies = []
        return attempts


class Command(BaseCommand):
    help = "Run language detection over the #1934 eval corpus and record it."

    def add_arguments(self, parser):
        parser.add_argument(
            "--spend",
            type=decimal.Decimal,
            required=True,
            help="Hard ceiling in USD. The run stops when the estimate "
                 "reaches it, and reports what it did not cover.",
        )
        parser.add_argument(
            "--pair",
            action="append",
            default=None,
            help="Only record this pair (repeatable). Default: all of them.",
        )
        parser.add_argument(
            "--note",
            default="",
            help="Free text stored with the run (e.g. why it was re-recorded).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Price the run and print the plan without calling anything.",
        )

    def handle(self, *args, **options):
        ceiling = options["spend"]
        if ceiling <= 0:
            raise CommandError("--spend must be positive")

        samples = language_eval_corpus.corpus()
        if options["pair"]:
            wanted = set(options["pair"])
            unknown = wanted - set(language_eval_corpus.PAIRS)
            if unknown:
                raise CommandError(f"unknown pair(s): {sorted(unknown)}")
            samples = tuple(s for s in samples if s.pair in wanted)
        if not samples:
            raise CommandError("no samples selected")

        ai_model = lang.select_detection_model()
        if ai_model is None:
            raise CommandError(
                "no callable GA AIModel is configured; detection cannot run"
            )
        model_id = f"{ai_model.provider}/{ai_model.model}"

        # Price the WORST case, per document, over the exact prompts that will
        # be sent -- not `estimated_cost_usd`, whose 800-token/8-output budget
        # exists to rank models and understates a real call by roughly half
        # (two attempts, each billed at the full 32-token output cap). An
        # up-front number that is lower than what the run can spend is not a
        # ceiling, it is an invitation to discover the difference afterwards.
        plan = []
        for sample in samples:
            text = lang.truncate_for_detection(sample.title, sample.content)
            attempts = lang._isolated_attempt_messages(text)
            quote = decimal.Decimal(
                str(lang._isolated_detection_upper_bound_usd([ai_model], attempts))
            )
            plan.append((sample, text, attempts, quote))
        worst_case = sum(q for _s, _t, _a, q in plan)

        self.stdout.write(
            f"{len(samples)} samples, model {model_id}, "
            f"worst case ${worst_case:.6f} total "
            f"(${worst_case / len(samples):.6f} each, ceiling ${ceiling})"
        )
        if options["dry_run"]:
            return
        if worst_case > ceiling:
            raise CommandError(
                f"worst case ${worst_case:.4f} exceeds --spend ${ceiling}; "
                f"raise the ceiling to at least that, or narrow with --pair"
            )

        usage = _RawCapture()
        replies = {}
        skipped = []
        silent = []
        # Checkpoints merge into the same run, and `save_run` ADDS cost_usd —
        # so each one carries only what it spent since the last, or the total
        # would compound.
        pending = {}
        charged_usd = 0.0

        def checkpoint():
            nonlocal pending, charged_usd
            if not pending:
                return None
            path = language_eval.save_run(language_eval.new_run(
                model=model_id,
                replies=pending,
                cost_usd=usage.usd - charged_usd,
                note=options["note"],
                silent=silent,
            ))
            charged_usd = usage.usd
            pending = {}
            return path

        for index, (sample, text, attempts, quote) in enumerate(plan):
            # The plan is frozen per document: ONE model, and the exact two
            # prompts that model may be asked. That buys two things at once.
            #
            # * The ceiling becomes prospective rather than retrospective.
            #   "We have not spent it yet" is not the same question as "the
            #   next document fits" -- a detection may make a normal and a
            #   strict attempt, each billed at the full MAX_OUTPUT_TOKENS cap,
            #   so a run sitting just under the ceiling can cross it before
            #   control comes back here. Same shape as `_fallback_each`.
            # * The recording's `model` field becomes true by construction.
            #   Left to itself `detect_language` falls back to a second
            #   candidate when the first returns nothing, and the answers
            #   would then be filed under a model that never produced them --
            #   which is exactly the provenance a per-model accuracy floor
            #   rests on.
            if decimal.Decimal(str(usage.usd)) + quote > ceiling:
                skipped = [s.id for s, _t, _a, _q in plan[index:]]
                self.stderr.write(
                    self.style.WARNING(
                        f"stopping at ${usage.usd:.4f}: the next document "
                        f"would need ${quote:.6f} and the ceiling is "
                        f"${ceiling}. {len(skipped)} samples not recorded; "
                        f"re-run to top the recording up."
                    )
                )
                break
            # `use_cache=False` because the point is to observe the model, and
            # a warm digest cache would replay an answer from a previous run
            # under a new run's name.
            detection = lang.detect_language(
                sample.title,
                sample.content,
                use_cache=False,
                usage=usage,
                _prepared_sample=text,
                _prepared_models=[ai_model],
                _prepared_attempt_messages=attempts,
            )
            attempts = usage.take_attempts()
            if language_eval.is_silence(attempts):
                # No text in any attempt. Ambiguous: a 429, a dropped
                # connection, or a reasoning model that spent its whole output
                # cap on hidden tokens -- and this layer cannot tell which.
                # So it is reported, not interpreted, from both ends:
                # `save_run` will not let the silence overwrite a reply an
                # earlier run paid for, AND the sample is listed in the run's
                # `silent` field, which makes the accuracy test refuse to
                # score the recording until a clean run clears it. Dropping
                # either half gets one of the two failure modes: an outage
                # that deletes the baseline, or a refreshed recording that
                # hides the failure the operator just watched happen.
                silent.append(sample.id)
                self.stderr.write(self.style.WARNING(
                    f"  {sample.id:22s} no text from the provider "
                    f"(recorded as no answer; an earlier reply is kept)"
                ))
            replies[sample.id] = attempts
            pending[sample.id] = attempts
            if len(pending) >= CHECKPOINT_EVERY:
                checkpoint()
            outcome = language_eval.score({sample.id: attempts}, samples=[sample])
            flag = "" if outcome.accuracy == 1.0 else "  <-- wrong"
            self.stdout.write(
                f"  {sample.id:22s} gold={sample.gold:9s} "
                f"got={detection.tag:9s} attempts={attempts!r}{flag}"
            )

        path = checkpoint() or language_eval.RECORDING_PATH

        report = language_eval.score(replies, samples=samples)
        self.stdout.write("")
        self.stdout.write(report.as_text())
        self.stdout.write("")

        merged = next(
            (r for r in language_eval.runs(language_eval.load_recording(path))
             if r["model"] == model_id),
            None,
        )
        covered = set(merged["replies"]) if merged else set()
        missing = {s.id for s in language_eval_corpus.corpus()} - covered
        self.stdout.write(
            self.style.SUCCESS(
                f"recorded {len(replies)} replies to {path} "
                f"(${usage.usd:.4f} spent). {model_id} now covers "
                f"{len(covered)}/{len(language_eval_corpus.corpus())} samples."
            )
        )
        if silent:
            self.stderr.write(
                self.style.WARNING(
                    f"{len(silent)} sample(s) got no text from the provider "
                    f"and count as no answer: {sorted(silent)[:5]}"
                )
            )
        if missing:
            self.stderr.write(
                self.style.WARNING(
                    f"{len(missing)} still unrecorded -- the accuracy test "
                    f"needs the whole corpus. Re-run (optionally with "
                    f"--pair) to top it up: {sorted(missing)[:5]}..."
                )
            )
        self.stdout.write(
            "Now put the measured per-pair numbers in ACCURACY_FLOORS in "
            "dj/apps/openai/test_language_detection_evals.py and commit both."
        )
