"""Scoring for the close-pair detection eval.

Two things are measured, and they are not the same thing.

**Evidence** (offline, free, deterministic, runs on every CI job.)
Detection sends the model a bounded head of the document. Whether the
discriminating markers survive into that head is a property of *our* code, not
of any provider —:func:`live_evidence` and:func:`batch_evidence` are the two
samples the two detection paths actually build, and
:func:`marker_retention` says what is left of the evidence in each. A sample
whose markers do not survive cannot be classified correctly by any model, so
this is a **necessary condition** for accuracy and a genuine measurement in its
own right.

**Answers** (needs a real provider, so: recorded.)
:func:`score` replays a recorded set of raw model replies through the real
validation pipeline (:func:`f2z.ai.language.normalize_tag` on the first line)
and reports per-pair accuracy. What it pins is the **pipeline**: given these
replies, these are the tags we store. A model change needs a new recording;
a change to ``normalize_tag``, to the registry, or to the regional defaults
shows up immediately as a score change against the existing one.

Keeping the answers recorded rather than live is not a compromise, it is the
requirement: detection calls a paid API, and a CI job that spends money per run
and goes red when a provider has a bad afternoon is a worse gate than no gate.
``manage.py record_language_eval`` is the one thing that spends, it is run by
hand, and its output is committed.
"""

import dataclasses
import datetime
import hashlib
import json
import os
import pathlib
import re

from f2z.ai import language as lang

from . import language_eval_corpus as corpus_mod


RECORDING_PATH = (
    pathlib.Path(__file__).resolve().parent
    / "testdata"
    / "language_eval_recording.json"
)

#Bumped when the shape of a recording file changes.
#
#v2: ``replies[id]`` became a LIST of raw attempts rather than one string.
RECORDING_VERSION = 2


#Envelope nonces are per-call and must not reach the fingerprint, or every
#call would look like a different detector.
_NONCE = re.compile(r"[0-9a-f]{16}")


def detector_fingerprint():
    """SHA-256 over the exact requests this corpus would produce.

    A recording is a claim about one *detector configuration*, not just one
    corpus. Change the prompt or the sampling window and the old replies
    describe a detector that no longer exists — but the corpus fingerprint
    would not move, so a later partial run would merge into them and the
    coverage check would pass on answers no single configuration produced.

    Two decisions here, and both were wrong in an earlier draft.

    * It fingerprints **rendered messages**, not a list of constants. Listing
      constants is the version that looks right and drifts: it misses
      anything that changes what is sent without changing a name on the list.
    * It renders **every sample**, not one fixed probe. A prompt rule that
      fires on some inputs and not others — a paragraph appended for Han
      characters, say — changes the request for a handful of documents and
      leaves a single probe untouched. Sixty-seven renders cost microseconds
      and remove the question.

    Not covered, deliberately: the model catalogue (that is the run's
    ``model`` field) and the registry (a registry change shows up as a score
    change on replay, which is what we want — the recording stays a true
    record of what the model said).
    """
    digest = hashlib.sha256()
    for sample in corpus_mod.corpus():
        digest.update(sample.id.encode("utf-8"))
        text = live_evidence(sample)
        for strict in (False, True):
            for message in lang.build_detection_messages(text, strict):
                digest.update(message["role"].encode("utf-8"))
                digest.update(
                    _NONCE.sub("NONCE", message["content"]).encode("utf-8")
                )
                digest.update(b"\x00")
    for cap in (
        lang.MAX_SAMPLE_TOKENS, lang.MAX_SAMPLE_CHARS, lang.MAX_OUTPUT_TOKENS,
        # MAX_OUTPUT_CHARS truncates the reply stream, so it can change the
        # answer without changing the prompt: cut it to two characters and a
        # live `zh-Hans` becomes an accepted `zh`, while a stored `zh-Hans`
        # replays as itself forever.
        lang.MAX_OUTPUT_CHARS,
    ):
        digest.update(str(cap).encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()


def corpus_fingerprint():
    """SHA-256 over every sample's identity, label and text.

    A recording is only meaningful for the corpus it was made against. Editing
    one sentence in one sample invalidates every number in the file, and
    without this the test would keep scoring the old replies against the new
    text and report a drop that no model produced.
    """
    digest = hashlib.sha256()
    for sample in corpus_mod.corpus():
        digest.update(
            f"{sample.id}\x00{sample.gold}\x00{sample.title}\x00"
            f"{sample.content}\x00".encode("utf-8")
        )
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# Evidence: what the two detection paths actually put in front of the model
# --------------------------------------------------------------------------- #
def live_evidence(sample):
    """The sample:func:`f2z.ai.language.detect_language` sends (the save path).

    A bounded head of ``title + content``, capped at ``MAX_SAMPLE_CHARS`` and
    then at ``MAX_SAMPLE_TOKENS``. **Not de-noised** — a code fence at the top
    of the body is sent verbatim.
    """
    return lang.truncate_for_detection(sample.title, sample.content)


def batch_evidence(sample):
    """The sample:func:`f2z.ai.language.detect_languages_batch` sends.

    Title plus the first three sentences of the *de-noised* body, capped at
    ``BATCH_SAMPLE_CHARS`` (320). This is the path the corpus backfill uses,
    so it is the one that labelled the existing zPages.
    """
    return lang.first_sentences(sample.title, sample.content)


@dataclasses.dataclass(frozen=True)
class Retention:
    sample_id: str
    gold: str
    pair: str
    kind: str
    in_document: int
    in_live: int
    in_batch: int
    live_chars: int
    batch_chars: int

    @property
    def live_blind(self):
        """Fewer than two of the sample's own markers reach the live path."""
        return self.in_live < 2

    @property
    def batch_blind(self):
        return self.in_batch < 2


def marker_retention(sample):
    own = corpus_mod.own_markers(sample)
    live = live_evidence(sample)
    batch = batch_evidence(sample)
    return Retention(
        sample_id=sample.id,
        gold=sample.gold,
        pair=sample.pair,
        kind=sample.kind,
        in_document=len(corpus_mod.markers_present(sample.text, own)),
        in_live=len(corpus_mod.markers_present(live, own)),
        in_batch=len(corpus_mod.markers_present(batch, own)),
        live_chars=len(live),
        batch_chars=len(batch),
    )


def retention_report():
    return tuple(marker_retention(s) for s in corpus_mod.corpus())


# --------------------------------------------------------------------------- #
# Answers: replaying recorded replies through the real validation pipeline
# --------------------------------------------------------------------------- #
@dataclasses.dataclass(frozen=True)
class Outcome:
    sample_id: str
    gold: str
    pair: str
    kind: str
    #Every raw attempt, in order — not just the one that was accepted.
    raw: tuple
    tag: str
    accept: tuple = ()

    @property
    def correct(self):
        return self.tag == self.gold or self.tag in self.accept

    @property
    def near_miss(self):
        """Right language, wrong script or region — ``zh`` for ``zh-Hans``.

        Called out separately because it is a different bug with a different
        fix: the model identified the language and we cannot use the answer.
        A near miss is NOT counted as correct anywhere.
        """
        if self.correct or self.tag == lang.UNKNOWN:
            return False
        return self.tag.split("-")[0].casefold() == self.gold.split("-")[0].casefold()


def tag_for_reply(attempts):
    """Exactly what detection would store, given the model's raw attempts.

    ``attempts`` is the ordered list of raw replies from one detection — the
    first attempt and, if that one was not a usable tag, the strict retry.
    A bare string is accepted as a one-attempt list.

    Replaying the *acceptance decision* rather than the accepted answer is
    what makes the recording robust to a validation change. Detection takes
    the FIRST attempt that normalizes; if a later ``normalize_tag`` starts
    accepting something it used to reject — parenthesised output, a new
    deprecated-tag alias — then a run whose first attempt was rejected at
    record time would be accepted now, and live detection would return a
    different answer from a recording that had kept only the winner. Keeping
    every attempt means the replay moves when the real pipeline moves.
    """
    if isinstance(attempts, str):
        attempts = [attempts]
    for raw in attempts:
        tag = lang.normalize_tag(lang._first_line(raw))
        if tag:
            return tag
    return lang.UNKNOWN


@dataclasses.dataclass(frozen=True)
class Report:
    outcomes: tuple

    @property
    def accuracy(self):
        if not self.outcomes:
            return 0.0
        return sum(o.correct for o in self.outcomes) / len(self.outcomes)

    def _group(self, key):
        groups = {}
        for outcome in self.outcomes:
            bucket = groups.setdefault(key(outcome), [0, 0])
            bucket[0] += bool(outcome.correct)
            bucket[1] += 1
        return {k: (c, n) for k, (c, n) in groups.items()}

    def by_pair(self):
        return self._group(lambda o: o.pair)

    def by_kind(self):
        return self._group(lambda o: o.kind)

    def failures(self):
        return tuple(o for o in self.outcomes if not o.correct)

    def near_misses(self):
        return tuple(o for o in self.outcomes if o.near_miss)

    def as_text(self):
        lines = [
            f"{len(self.outcomes)} samples, "
            f"{sum(o.correct for o in self.outcomes)} correct "
            f"({self.accuracy:.0%})",
            "",
            "by pair:",
        ]
        for pair, (correct, total) in sorted(self.by_pair().items()):
            lines.append(f"  {pair:22s} {correct:3d}/{total:<3d} {correct / total:.0%}")
        lines += ["", "by kind:"]
        for kind, (correct, total) in sorted(self.by_kind().items()):
            lines.append(f"  {kind:22s} {correct:3d}/{total:<3d} {correct / total:.0%}")
        if self.failures():
            lines += ["", "wrong:"]
            for outcome in self.failures():
                flag = " (near miss)" if outcome.near_miss else ""
                lines.append(
                    f"  {outcome.sample_id:20s} gold={outcome.gold:9s} "
                    f"got={outcome.tag:9s} raw={outcome.raw!r}{flag}"
                )
        return "\n".join(lines)


def score(replies, samples=None):
    """Turn ``{sample_id: model_reply}`` into a:class:`Report`.

    A reply is whatever the model said. ``record_language_eval`` stores the
    already-normalized tag rather than the raw stream, because
    :func:`~f2z.ai.language.detect_language` does not hand the raw text back;
    normalization is idempotent, so replaying it here still re-runs the
    registry (a tag the registry stops accepting becomes ``UNKNOWN`` and the
    score drops). What a recording cannot pin is the model's *formatting*
    quirks — quotes, trailing full stops — and those are covered directly by
    ``test_language_detection.py``.

    Samples with no reply are skipped rather than counted wrong: a missing
    reply means the recording is incomplete, which the caller checks for
    explicitly. Silently scoring it as a failure would report a detection
    problem where there is a data problem.
    """
    samples = samples if samples is not None else corpus_mod.corpus()
    outcomes = []
    for sample in samples:
        if sample.id not in replies:
            continue
        raw = replies[sample.id]
        if isinstance(raw, str):
            raw = [raw]
        outcomes.append(
            Outcome(
                sample_id=sample.id,
                gold=sample.gold,
                pair=sample.pair,
                kind=sample.kind,
                raw=tuple(raw),
                tag=tag_for_reply(raw),
                accept=sample.accept,
            )
        )
    return Report(outcomes=tuple(outcomes))


# --------------------------------------------------------------------------- #
# The recording file
# --------------------------------------------------------------------------- #
def load_recording(path=None):
    """The committed recording, or an empty one when nothing has been recorded.

    Never raises for a missing file — an absent recording is the normal state
    of a fresh clone, and the test reports it as a skip with instructions
    rather than as an error.
    """
    path = pathlib.Path(path) if path else RECORDING_PATH
    if not path.exists():
        return {"version": RECORDING_VERSION, "runs": []}
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def runs(recording=None):
    recording = recording if recording is not None else load_recording()
    return tuple(recording.get("runs", ()))


def is_silence(attempts):
    """Whether a recorded entry says the provider produced no text at all."""
    if isinstance(attempts, str):
        attempts = [attempts]
    return not any((a or "").strip() for a in attempts)


def save_run(run, path=None):
    """Store ``run``, MERGING into an earlier run of the same model.

    Merging, not replacing, because a run is routinely partial: the recorder
    takes ``--pair`` to record one pair at a time, and it stops early when the
    spend ceiling is reached. Replacing would mean a top-up run silently threw
    away every reply it did not itself produce — and since the accuracy test
    demands full corpus coverage, recording pair by pair could never converge.

    The merge is conditional on BOTH fingerprints — the corpus and the
    detector configuration. When the corpus has changed, the older replies
    were produced against text that no longer exists; when the prompt or the
    sampling window has changed, they were produced by a detector that no
    longer exists. Either way they are dropped rather than blended: a
    mixed-vintage recording is worse than a short one, and it is worse in the
    particular way that looks like data. ``cost_usd`` accumulates and
    ``first_recorded_at`` remembers when the oldest surviving reply was taken,
    so the provenance of a merged run is still readable.
    """
    path = pathlib.Path(path) if path else RECORDING_PATH
    recording = load_recording(path)
    recording["version"] = RECORDING_VERSION
    previous = next(
        (r for r in recording.get("runs", []) if r.get("model") == run["model"]),
        None,
    )
    mergeable = (
        previous is not None
        and previous.get("corpus_fingerprint") == run.get("corpus_fingerprint")
        and previous.get("detector_fingerprint") == run.get("detector_fingerprint")
    )
    if mergeable:
        run = dict(run)
        # Silence never replaces speech. An entry with no text in any attempt
        # is ambiguous — a rate limit, a dropped connection, or a reasoning
        # model that spent its whole output cap on hidden tokens. The last of
        # those is real evidence and must be recordable, so silence is stored;
        # but it must never be allowed to destroy a reply an earlier run paid
        # for, because an outage during a re-record would then quietly delete
        # the baseline it was meant to refresh.
        merged = dict(previous.get("replies", {}))
        # `silent` is carried forward PER SAMPLE, and cleared only by that
        # sample producing text. Neither simpler rule works. Dropping it
        # wholesale lets an unrelated partial run — record Cantonese during an
        # outage, then successfully record Czech — clear a flag nothing
        # resolved, and the Cantonese failure disappears behind its own stale
        # answers. Keeping the union makes one bad afternoon permanent.
        #
        # Between the two fields: `replies` is what the model last SAID, and
        # `silent` is what has not been successfully observed since. That is
        # what lets the recording protect paid evidence without concealing a
        # failure the operator just watched happen.
        answered = {
            sample_id for sample_id, attempts in run["replies"].items()
            if not is_silence(attempts)
        }
        run["silent"] = sorted(
            (set(previous.get("silent", ())) - answered)
            | set(run.get("silent", ()))
        )
        for sample_id, attempts in run["replies"].items():
            if is_silence(attempts) and sample_id in merged and not is_silence(
                merged[sample_id]
            ):
                continue
            merged[sample_id] = attempts
        run["replies"] = merged
        run["cost_usd"] = (previous.get("cost_usd") or 0.0) + (
            run.get("cost_usd") or 0.0
        )
        run["first_recorded_at"] = previous.get(
            "first_recorded_at", previous.get("recorded_at")
        )
    kept = [r for r in recording.get("runs", []) if r.get("model") != run["model"]]
    kept.append(run)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename. The replies in this file were paid for; truncating it
    # and then failing part way through serialization would lose both the run
    # being written and every earlier one merged into it, and would leave
    # behind half a JSON document that the next run cannot even load to resume
    # from. os.replace is atomic within a filesystem, and the temporary file
    # carries the pid so two writers cannot share one.
    #
    # It is NOT a lock. Two recorders running at once still read-merge-write
    # independently and the later rename wins, so the earlier one's replies
    # are lost. That is left alone deliberately: this is a hand-run developer
    # command against a file in the repo, one recorder at a time is the only
    # sensible way to use it, and a lock here would be more machinery than the
    # failure it prevents. Run one at a time.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump({"version": RECORDING_VERSION, "runs": kept}, handle,
                  ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)
    return path


def new_run(model, replies, cost_usd=None, note="", silent=()):
    return {
        "model": model,
        #Samples that produced no text at all on THIS run. Ambiguous by
        #nature — a 429, a dropped connection, or a model that spent its
        #whole output cap on hidden tokens — so it is reported rather than
        #interpreted, and the accuracy test refuses to score a recording
        #whose last refresh hit any.
        "silent": sorted(silent),
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="seconds"
        ),
        "corpus_fingerprint": corpus_fingerprint(),
        "detector_fingerprint": detector_fingerprint(),
        "cost_usd": cost_usd,
        "note": note,
        "replies": dict(replies),
    }
