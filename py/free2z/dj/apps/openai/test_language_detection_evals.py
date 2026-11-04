"""Close-pair detection evals (issue, part of ).

``test_language_detection.py`` pins the *contract* of
:mod:`f2z.ai.language` — injection, cost, output validation. This file asks a
different question: **is the answer right**, for the pairs where getting it
right is a judgement call rather than a script lookup.

Three layers, and it matters which is which.

1. **Corpus integrity.** The samples are hand-authored in 20 languages. These
   tests are the reason you can believe them: every sample must carry at least
   two of its own language's separating markers and none of its sibling's. A
   mislabelled sample would otherwise sit in the corpus quietly making the
   score wrong in whichever direction it happened to fall.

2. **Evidence.** What the two detection paths actually put in front of a
   model. Offline, free, deterministic, and it already found something: the
   live path and the batch path have *complementary* blind spots, and each one
   goes blind on documents the other handles. That is a real measurement of
   our own code, and it is a necessary condition for any accuracy number.

3. **Answers.** Per-pair accuracy from a recorded provider run. Dormant until
   someone records one (``manage.py record_language_eval``) — the numbers
   cannot be conjured offline, and a CI job that pays a provider per run is
   not a gate we want.

**On tests that pass without testing anything.** An accuracy eval is a prime
candidate: pick easy samples, assert a low bar, ship a green tick that means
nothing. The guards against that here are explicit and are themselves tested —
the marker matcher has negative controls, the evidence assertions pin the
exact set of samples that FAIL rather than a count that a smaller corpus would
also satisfy, and the scorer is proved able to report a wrong answer before it
is trusted to report a right one.
"""

import dataclasses
import io
import re

import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError

from f2z import languages
from f2z.ai import language as lang
from f2z.ai import providers

from . import language_eval as ev
from . import language_eval_corpus as corp
from .management.commands import record_language_eval as recorder
from .models import AIModel


# --------------------------------------------------------------------------- #
# Measured baselines
# --------------------------------------------------------------------------- #
#Samples where the LIVE path (``detect_language``, the zPage save path) puts
#fewer than two of the document's own markers in front of the model.
#
#Both are documents whose opening code fence (~5.8 kB) exceeds BOTH of the
#live path's caps — ``MAX_SAMPLE_CHARS`` (4000) and ``MAX_SAMPLE_TOKENS``
#(500) — so all that survives is the title. Verified by mutation: lifting
#only one of the two caps does not change this set, lifting both does. The
#live path never de-noises; it does not have to for a normal article,
#because 4000 characters is a lot of article.
LIVE_BLIND_SAMPLES = frozenset({"yue-code-2", "es-code-1"})

#Samples where the BATCH path (``detect_languages_batch``, the corpus
#Samples where the BATCH path (``detect_languages_batch``, the corpus
#backfill) has fewer than two of the document's own markers. Three de-noised
#sentences clears all six blind spots pinned before  while keeping the
#320-character cap. Raising only the character cap was not the fix: sentence
#count bound the mixed and Serbian samples.
BATCH_BLIND_SAMPLES = frozenset()

#The exact blind set with the former two-sentence window. Keeping this
#control makes the new all-clear meaningful: it proves the third sentence
#removes the measured failures, rather than losing the marker regression.
PREVIOUS_BATCH_BLIND_SAMPLES = frozenset({
    "zh-hant-mixed-1",
    "id-code-1",
    "sr-latn-clean-1",
    "sr-cyrl-clean-1",
    "es-mixed-1",
    "pt-code-1",
})

#Accuracy floors as MEASURED — not as hoped. Keyed by ``(model, pair)``.
#
#Per MODEL, not per pair alone: a floor is a measurement of one model, and a
#shared floor gets dragged to whichever model scored worst. Record a cheaper
#model at 3/4 on Czech/Slovak and the 4/4 model's floor silently drops with
#it, so a later normalization regression from 4/4 to 3/4 passes unnoticed —
#the entry meant to catch exactly that.
#
#Empty because no run has been recorded: the agent that built this eval had
#no provider credentials, and inventing numbers for an accuracy table is
#worse than having none. ``test_recorded_run_meets_its_floors`` fails, rather
#than skips, if a recording exists without floors — so the first person to
#spend the cents is also the person who writes down what came back.
ACCURACY_FLOORS = {}

#The only samples allowed to score a second tag as correct.
#
#Pinned as a SET, so adding `accept` to a sample is a deliberate edit that
#has to come through here. `accept` is the obvious way to turn a failing
#eval green — "the answer was under-determined" is always available as an
#excuse — and the two cases below are the ones where it is actually true:
#romanized Hindi/Urdu (hi-Latn vs hi), and Serbian in its usual script
#(sr vs sr-Cyrl). Both differ from gold by a script subtag alone, and in
#both the BCP-47 convention and the more explicit tag are defensible
#answers that no instruction currently chooses between.
SAMPLES_WITH_ACCEPTED_ALTERNATIVES = frozenset({
    "hi-romanized-1",
    "ur-romanized-1",
    "sr-cyrl-clean-1",
    "sr-cyrl-short-1",
})


# --------------------------------------------------------------------------- #
# 1. Corpus integrity
# --------------------------------------------------------------------------- #
def test_every_sample_has_a_unique_id():
    ids = [s.id for s in corp.corpus()]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("sample", corp.corpus(), ids=lambda s: s.id)
def test_gold_tag_is_canonical_and_detectable(sample):
    """A gold label must be exactly what the registry would store.

    If gold were ``pt`` the corpus would be asserting an answer detection can
    never produce: ``normalize`` turns it into ``pt-BR``. Writing gold in
    canonical form is what makes ``tag == gold`` an honest comparison.
    """
    assert languages.normalize(sample.gold, allow_missing=False) == sample.gold
    assert languages.is_detectable(sample.gold)


@pytest.mark.parametrize("sample", corp.corpus(), ids=lambda s: s.id)
def test_sample_carries_its_own_evidence_and_none_of_its_siblings(sample):
    own = corp.markers_present(sample.text, corp.own_markers(sample))
    rivals = corp.markers_present(sample.text, corp.rival_markers(sample))
    assert len(own) >= 2, (
        f"{sample.id} is labelled {sample.gold} but carries {own} — either "
        f"the label is wrong or the sample is not separable"
    )
    assert not rivals, (
        f"{sample.id} is labelled {sample.gold} but contains {rivals}, which "
        f"belong to a sibling in pair {sample.pair}"
    )


@pytest.mark.parametrize("sample", corp.corpus(), ids=lambda s: s.id)
def test_accept_cannot_be_used_to_make_the_eval_pass(sample):
    """``accept`` widens what counts as correct, so it needs a fence.

    Left open it is the obvious way to turn a failing eval green: add the
    wrong answer to the accepted set and call it under-determined. It is
    confined to the romanized pair — the one place where two answers really
    are both right — and an accepted tag must name the same language as gold,
    so it can only ever forgive a script or region difference.
    """
    used = sample.id in SAMPLES_WITH_ACCEPTED_ALTERNATIVES
    assert bool(sample.accept) == used, (
        f"{sample.id}: add it to SAMPLES_WITH_ACCEPTED_ALTERNATIVES (with a "
        f"reason) before giving it an `accept` list"
    )
    for tag in sample.accept:
        assert languages.normalize(tag, allow_missing=False) == tag
        assert tag != sample.gold
        assert tag.split("-")[0] == sample.gold.split("-")[0], (
            f"{sample.id} accepts {tag}, which is a different language from "
            f"{sample.gold}"
        )


@pytest.mark.parametrize("pair", sorted(corp.PAIRS), ids=str)
def test_pair_markers_are_pairwise_disjoint(pair):
    seen = {}
    for tag, markers in corp.PAIRS[pair]["members"].items():
        for marker in markers:
            assert marker not in seen, (
                f"{marker!r} is claimed by both {seen[marker]} and {tag} in "
                f"{pair}; a marker shared inside a pair separates nothing"
            )
            seen[marker] = tag


@pytest.mark.parametrize("pair", sorted(corp.PAIRS), ids=str)
def test_every_pair_member_is_sampled(pair):
    """Declaring a member and never sampling it is a silently empty eval."""
    declared = set(corp.PAIRS[pair]["members"])
    sampled = {s.gold for s in corp.corpus() if s.pair == pair}
    assert sampled == declared


def test_the_hard_kinds_are_actually_covered():
    """ names short, mixed and code-heavy as the known-hard inputs."""
    kinds = {s.kind for s in corp.corpus()}
    assert {corp.KIND_SHORT, corp.KIND_MIXED, corp.KIND_CODE} <= kinds
    for kind in (corp.KIND_MIXED, corp.KIND_CODE):
        assert sum(s.kind == kind for s in corp.corpus()) >= 2


def test_short_samples_are_actually_short():
    for sample in corp.corpus():
        if sample.kind != corp.KIND_SHORT:
            continue
        evidence = ev.live_evidence(sample)
        assert len(evidence) < lang.SHORT_SAMPLE_CHARS, sample.id


# --- negative controls for the marker matcher itself ----------------------- #
# The matcher is what makes every assertion above meaningful. A matcher that
# said True to everything would turn the integrity tests into decoration, so
# it gets its own failing cases.
@pytest.mark.parametrize("text,marker,expected", [
    # Combining marks join: Hindi है must not fire inside हैं. re's \w does not
    # cover Mn, so the obvious regex implementation of this gets it wrong.
    ("हैं", "है", False),
    ("यह सही नहीं है।", "है", True),
    # A virama-joined consonant is a word continuation: छ is not छन्.
    ("छन्", "छ", False),
    ("यो राम्रो छ।", "छ", True),
    # Latin: the ekavian/ijekavian reflex is a substring relationship.
    ("vrijeme", "vreme", False),
    ("Prošlo je vreme.", "vreme", True),
    ("meget", "eg", False),
    ("eg veit ikkje", "eg", True),
    ("kaffe", "af", False),
    ("et spørgsmål af den slags", "af", True),
    # Case: a marker at the start of a sentence is the same marker.
    ("Karena hujan", "karena", True),
    # CJK has no word boundaries, so a Cantonese morpheme matches anywhere.
    ("我唔知", "唔", True),
    ("我不知道", "唔", False),
])
def test_marker_matching_has_boundaries(text, marker, expected):
    assert corp.contains_marker(text, marker) is expected


# --------------------------------------------------------------------------- #
# 2. Evidence — what each detection path actually sends
# --------------------------------------------------------------------------- #
def test_live_path_blind_spots_are_exactly_the_pinned_ones():
    """The live path loses the evidence only where the code exceeds its window.

    Pinned as a SET of ids, not a count: a count would still pass if a
    different sample went blind, which is precisely the change worth catching.
    """
    blind = {r.sample_id for r in ev.retention_report() if r.live_blind}
    assert blind == LIVE_BLIND_SAMPLES


def test_batch_path_blind_spots_are_exactly_the_pinned_ones():
    blind = {r.sample_id for r in ev.retention_report() if r.batch_blind}
    assert blind == BATCH_BLIND_SAMPLES


def test_two_sentence_negative_control_reproduces_the_original_batch_blind_set():
    blind = {
        sample.id
        for sample in corp.corpus()
        if len(corp.markers_present(
            lang.first_sentences(
                sample.title, sample.content, max_sentences=2,
            ),
            corp.own_markers(sample),
        )) < 2
    }
    assert blind == PREVIOUS_BATCH_BLIND_SAMPLES


def test_the_batch_window_covers_the_pinned_eval_blind_spots():
    """Keep the larger batch sample tied to its measured marker coverage."""
    assert LIVE_BLIND_SAMPLES == {"yue-code-2", "es-code-1"}
    assert BATCH_BLIND_SAMPLES == set()


@pytest.mark.parametrize(
    "sample",
    [s for s in corp.corpus() if s.kind == corp.KIND_MIXED],
    ids=lambda s: s.id,
)
def test_a_mixed_sample_is_labelled_with_its_MAJORITY_language(sample):
    """Otherwise the eval scores a correct detector as wrong.

    The prompt tells the model to answer with the dominant language of a
    mixed document. A sample labelled with its minority language therefore
    punishes exactly the behaviour we asked for, and the resulting "the
    detector is bad at mixed documents" reading would be an artifact of the
    corpus. ``segments`` makes the majority a measurement rather than a claim.
    """
    counts = sample.segment_chars()
    assert counts, "a mixed sample must declare its segments"
    gold_chars = counts[sample.gold]
    assert gold_chars > sum(counts.values()) - gold_chars, (
        f"{sample.id} is labelled {sample.gold} but that is "
        f"{gold_chars} of {sum(counts.values())} characters"
    )
    # The head being the OTHER language is what makes the sample hard; a mixed
    # document that opens in its own language tests nothing.
    assert sample.segments[0][0] != sample.gold


def test_batch_window_reaches_the_majority_language_after_an_opening_quote():
    """An opening quote must not hide majority language evidence from backfill."""
    mixed = [s for s in corp.corpus() if s.kind == corp.KIND_MIXED]
    assert mixed
    for sample in mixed:
        retention = ev.marker_retention(sample)
        assert retention.in_document >= 2
        assert retention.in_live >= 2, "the live window still reaches it"
        assert retention.in_batch >= 2, (
            f"{sample.id}: batch evidence lacks markers for its majority "
            f"language {sample.gold}"
        )


ORDINARY_SAMPLES = tuple(
    s for s in corp.corpus() if s.kind in (corp.KIND_CLEAN, corp.KIND_SHORT)
)


@pytest.mark.parametrize("sample", ORDINARY_SAMPLES, ids=lambda s: s.id)
def test_a_clean_sample_reaches_the_live_model_intact(sample):
    """Ordinary prose must never lose evidence to sampling.

    The interesting failures are all in the hard kinds; if a plain paragraph
    starts going blind, the window shrank and every number in this file is
    suspect.
    """
    retention = ev.marker_retention(sample)
    assert retention.in_live == retention.in_document


def test_a_short_sample_can_never_be_displayed_as_confident():
    """A guess off 30 characters must not reach a reader as a fact.

    This is the product half of "short samples are hard": we cannot make the
    answer better, but we can stop it being presented as certain.
    """
    for sample in corp.corpus():
        if sample.kind != corp.KIND_SHORT:
            continue
        confidence = lang._confidence_for(ev.live_evidence(sample), retried=False)
        assert confidence < lang.CONFIDENCE_DISPLAY_THRESHOLD, sample.id


# --------------------------------------------------------------------------- #
# 3. The bare-macrolanguage question — "zh, zh-Hans, or cmn?"
# --------------------------------------------------------------------------- #
def test_script_refinements_are_derived_from_the_registry():
    assert lang.script_refinements("zh") == ("zh-Hans", "zh-Hant")
    assert lang.LanguageDetection("zh", 0.9).script_is_ambiguous
    assert not lang.LanguageDetection("zh-TW", 0.9).script_is_ambiguous
    assert lang.LanguageDetection("zh-TW", 0.9).needs_script
    # Region-bearing but script-less is under-specified, not ambiguous: CLDR
    # likely-subtags answers it, and there is exactly one right answer.
    assert lang.script_refinements("zh-TW") == ("zh-Hant",)
    assert lang.script_refinements("zh-CN") == ("zh-Hans",)
    # Already names a script / already sellable / not sellable in any script.
    assert lang.script_refinements("zh-Hant") == ()
    assert lang.script_refinements("en") == ()
    assert lang.script_refinements("gl") == ()
    assert lang.script_refinements(lang.UNKNOWN) == ()


def test_the_bare_macrolanguages_1904_names_are_pinned_against_the_registry():
    """A tripwire on, not a restatement of the implementation.

    The tempting version of this test — "a bare macrolanguage that has a
    sellable scripted form is flagged" — is tautological: that IS the
    definition of ``needs_script``, so it would pass no matter what the
    registry said. What is worth pinning is the registry's *current* answer
    for each tag  item 6 names, because  is about to change several
    of them and the change must be looked at rather than absorbed.

    Read the table as: ``bare -> (stored tag, sellable?, flagged?)``.

    **This test has already done its job once.** It was written against the
    pre- registry, where all six were unsellable and only ``zh`` had a
    scripted sibling to point at.  landed while this branch was open, it
    went red, and the answers below are the re-checked ones:

    * ``zh`` is unchanged and is still the live case: stored as ``zh``, not
      sellable, flagged, with ``zh-Hans``/``zh-Hant`` to choose between. It is
      the one bare macrolanguage  did not resolve, which is why the
      surfacing in ``language.py`` is not dead code.
    * ``yue`` is resolved by normalization, the ``pt`` -> ``pt-BR`` way:
      ``yue`` -> ``yue-Hant``, sellable, nothing to flag. Cantonese in
      simplified characters is still reachable by writing ``yue-Hans``
      explicitly.
    * ``sr``, ``pa``, ``az`` and ``uz`` were made sellable **as the bare
      tag**, so a detector answering ``sr`` produces something the product can
      act on and there is nothing to refine. Note the direction: ``sr-Cyrl``
      and ``sr-Latn`` are NOT in ``TRANSLATABLE``, so the specific tag is the
      unsellable one. That is a deliberate  decision, not an oversight,
      and it is the reason this file's Serbian gold labels are what they are.

    The correct response to this test going red again is the same: check what
    the flag now does for each bare tag, then update the table — never delete
    a row.
    """
    state = {}
    for bare in ("zh", "sr", "pa", "az", "uz", "yue"):
        tag = lang.normalize_tag(bare)
        detection = lang.LanguageDetection(tag, lang.CONFIDENCE_STRONG)
        state[bare] = (tag, languages.is_translatable(tag), detection.needs_script)

    assert state == {
        "zh": ("zh", False, True),
        "sr": ("sr", True, False),
        "pa": ("pa", True, False),
        "az": ("az", True, False),
        "uz": ("uz", True, False),
        "yue": ("yue-Hant", True, False),
    }


def test_the_third_possible_answer_for_simplified_chinese_is_unsellable():
    """``cmn`` is a real language code and a useless answer.

    A model asked what language Simplified-script content is written in can
    say ``zh-Hans`` (usable), ``zh`` (storable, not sellable — flagged above)
    or ``cmn`` (Mandarin as an individual language, which the registry accepts
    and nothing downstream can do anything with). The prompt now tells the
    model not to; this pins the consequence if one does anyway, so nobody
    concludes from a green suite that ``cmn`` is handled.
    """
    tag = lang.normalize_tag("cmn")
    assert tag == "cmn"
    assert languages.is_detectable(tag)
    assert not languages.is_translatable(tag)
    # It is not caught by the script surfacing either: its primary subtag is
    # not `zh`, so there is no scripted sibling to point at. Surfacing it
    # properly needs macrolanguage membership, which is 's to decide.
    assert lang.script_refinements(tag) == ()


def test_a_japanese_document_is_a_close_pair_case_of_its_own():
    """Kanji-heavy Japanese against traditional-script Chinese.

    It is here because it is the pair a *prompt* about Chinese would put at
    risk: any rule the system turn carries about Han characters is read on a
    Japanese document too. No such rule ships today (see the PR for why the
    one drafted here was held back until it can be measured), so this is the
    baseline that a future prompt change has to not move.
    """
    japanese = [s for s in corp.corpus() if s.gold == "ja"]
    assert len(japanese) >= 2
    for sample in japanese:
        retention = ev.marker_retention(sample)
        assert retention.in_live >= 2, sample.id


def test_the_system_prompt_is_a_constant_no_document_can_steer():
    """The prompt is the same two messages for every document.

    A conditional rule — "append this paragraph when the sample contains X" —
    is a real option and was drafted for Chinese, but it makes what we ask the
    model a function of creator-controlled bytes, and it cannot be evaluated
    offline. Until a recorded run exists, the prompt stays a constant, and
    this says so in a way a future change has to come and edit.
    """
    for sample in (corp.by_id("es-clean-1"), corp.by_id("yue-clean-1"),
                   corp.by_id("ja-clean-1")):
        messages = lang.build_detection_messages(ev.live_evidence(sample))
        assert messages[0]["content"] == lang._SYSTEM_PROMPT, sample.id


# --------------------------------------------------------------------------- #
# 4. The scorer — proved able to fail before it is trusted to pass
# --------------------------------------------------------------------------- #
def _perfect_replies():
    return {s.id: s.gold for s in corp.corpus()}


def test_scorer_reports_a_perfect_run_as_perfect():
    report = ev.score(_perfect_replies())
    assert report.accuracy == 1.0
    assert report.failures() == ()


def test_scorer_reports_wrong_answers():
    """The positive control for the harness: it must be able to go red.

    Two deliberate errors — a near miss (``zh`` where ``zh-Hans`` is wanted,
    the exact shape of the bare-macrolanguage problem) and a flat miss.
    """
    replies = _perfect_replies()
    replies["zh-hans-clean-1"] = "zh"
    replies["nn-clean-1"] = "nb"

    report = ev.score(replies)
    failed = {o.sample_id for o in report.failures()}
    assert failed == {"zh-hans-clean-1", "nn-clean-1"}
    assert {o.sample_id for o in report.near_misses()} == {"zh-hans-clean-1"}
    assert report.by_pair()["nb-vs-nn"][0] < report.by_pair()["nb-vs-nn"][1]
    assert report.accuracy < 1.0
    assert "zh-hans-clean-1" in report.as_text()


def test_scorer_collapses_when_every_answer_is_the_same():
    """The corpus is not trivially satisfiable by a constant.

    If answering ``en`` to everything scored well, the corpus would be
    measuring nothing at all.
    """
    report = ev.score({s.id: "en" for s in corp.corpus()})
    assert report.accuracy == 0.0


def test_scorer_replays_the_acceptance_decision_over_the_attempts():
    """The first attempt that validates wins — exactly as detection does."""
    assert ev.tag_for_reply(["not a tag", "es"]) == "es"
    assert ev.tag_for_reply(["es", "fr"]) == "es"
    assert ev.tag_for_reply(["", ""]) == lang.UNKNOWN


def test_scorer_re_runs_the_registry_rather_than_trusting_the_recording():
    """A recorded tag is re-validated, so a registry change moves the score."""
    assert ev.tag_for_reply("  zh-hant \n") == "zh-Hant"
    assert ev.tag_for_reply("Portuguese") == lang.UNKNOWN
    assert ev.tag_for_reply("und") == lang.UNKNOWN
    # The regional default is applied, which is why gold is written pt-PT.
    assert ev.tag_for_reply("pt") == "pt-BR"


def test_accept_forgives_a_less_specific_but_correct_answer():
    """The romanized pair is the only place two answers are both right."""
    replies = _perfect_replies()
    replies["hi-romanized-1"] = "hi"          # accepted: same language
    replies["ur-romanized-1"] = "ur-Latn"     # the gold itself
    assert ev.score(replies).failures() == ()

    replies["hi-romanized-1"] = "ur"          # a different language: wrong
    assert {o.sample_id for o in ev.score(replies).failures()} == {
        "hi-romanized-1"
    }


def test_a_missing_reply_is_skipped_not_scored_wrong():
    report = ev.score({"es-clean-1": "es"})
    assert len(report.outcomes) == 1
    assert report.accuracy == 1.0


# --------------------------------------------------------------------------- #
# 5. The recorded run
# --------------------------------------------------------------------------- #
def test_recording_file_is_well_formed():
    recording = ev.load_recording()
    assert isinstance(recording.get("runs", []), list)
    for run in ev.runs(recording):
        assert run["model"]
        assert run["corpus_fingerprint"]
        assert run["detector_fingerprint"]
        assert isinstance(run.get("silent", []), list)
        assert isinstance(run["replies"], dict)
        assert set(run["replies"]) <= {s.id for s in corp.corpus()}


def test_a_missing_recording_is_an_empty_one_not_an_error(tmp_path):
    """A fresh clone has no recording, and that is not a broken test run."""
    assert ev.runs(ev.load_recording(tmp_path / "nope.json")) == ()


def test_a_partial_recording_is_topped_up_not_truncated(tmp_path):
    """``--pair`` and the spend ceiling both produce partial runs.

    If a later partial run replaced the earlier one, recording pair by pair
    could never reach the full-corpus coverage the accuracy test requires —
    and each run would report success while destroying the last one's work.
    """
    path = tmp_path / "rec.json"
    ev.save_run(ev.new_run("openai/fake", {"es-clean-1": "es"}, 0.001), path=path)
    ev.save_run(ev.new_run("openai/fake", {"nn-clean-1": "nn"}, 0.002), path=path)

    stored = ev.runs(ev.load_recording(path))
    assert len(stored) == 1, "one run per model"
    assert stored[0]["replies"] == {"es-clean-1": "es", "nn-clean-1": "nn"}
    assert stored[0]["cost_usd"] == pytest.approx(0.003)
    assert stored[0]["corpus_fingerprint"] == ev.corpus_fingerprint()

    # A re-record of the same sample overwrites that sample.
    ev.save_run(ev.new_run("openai/fake", {"es-clean-1": "en"}), path=path)
    stored = ev.runs(ev.load_recording(path))
    assert stored[0]["replies"]["es-clean-1"] == "en"
    assert stored[0]["replies"]["nn-clean-1"] == "nn"


def test_a_recording_made_against_a_different_corpus_is_dropped_not_blended(
    tmp_path, monkeypatch,
):
    """A mixed-vintage recording is worse than a short one."""
    path = tmp_path / "rec.json"
    ev.save_run(ev.new_run("openai/fake", {"es-clean-1": "es"}), path=path)

    original = corp.corpus()
    edited = (dataclasses.replace(original[0], content=original[0].content + "!"),)
    monkeypatch.setattr(corp, "corpus", lambda: edited + original[1:])
    ev.save_run(ev.new_run("openai/fake", {"nn-clean-1": "nn"}), path=path)

    stored = ev.runs(ev.load_recording(path))
    assert stored[0]["replies"] == {"nn-clean-1": "nn"}


def test_the_detector_fingerprint_moves_when_the_prompt_does(monkeypatch):
    """A recording is a claim about one detector, not just one corpus.

    The corpus fingerprint does not move when the prompt changes, so without
    this a partial run recorded after a prompt edit would merge into replies
    produced by the old prompt and the result would read as one measurement.
    """
    before = ev.detector_fingerprint()
    corpus_before = ev.corpus_fingerprint()

    monkeypatch.setattr(lang, "_SYSTEM_PROMPT", lang._SYSTEM_PROMPT + " also.")
    assert ev.detector_fingerprint() != before
    #...and the corpus fingerprint does NOT move, which is the whole reason
    # a second fingerprint has to exist.
    assert ev.corpus_fingerprint() == corpus_before


def test_the_detector_fingerprint_is_stable_across_calls():
    """It renders the prompts, and those carry a fresh nonce per call."""
    assert ev.detector_fingerprint() == ev.detector_fingerprint()


def test_the_detector_fingerprint_sees_a_rule_that_fires_on_some_documents():
    """A fixed probe would not, which is why every sample is rendered.

    A prompt rule conditional on the document — one appended for Han
    characters, say — changes the request for a handful of samples and leaves
    any single probe untouched. That is the shape that would let a recording
    made before the rule merge with one made after it.
    """
    before = ev.detector_fingerprint()
    original = lang.build_detection_messages

    def only_for_han(sample, strict=False):
        messages = original(sample, strict)
        if any("\u4e00" <= ch <= "\u9fff" for ch in sample or ""):
            messages[0]["content"] += "\n- a rule about Chinese"
        return messages

    monkeypatch_target = lang
    monkeypatch_target.build_detection_messages = only_for_han
    try:
        assert ev.detector_fingerprint() != before
    finally:
        monkeypatch_target.build_detection_messages = original
    assert ev.detector_fingerprint() == before


@pytest.mark.parametrize("cap", [
    "MAX_SAMPLE_TOKENS",
    "MAX_SAMPLE_CHARS",
    "MAX_OUTPUT_TOKENS",
    # MAX_OUTPUT_CHARS truncates the reply, so it can change the ANSWER
    # without changing the prompt: cut it to two characters and a live
    # `zh-Hans` arrives as an accepted `zh`, while a recorded `zh-Hans`
    # replays as itself forever.
    "MAX_OUTPUT_CHARS",
])
def test_the_detector_fingerprint_moves_when_a_cap_does(cap, monkeypatch):
    """The caps change the request or the reply, not the prompt text.

    Rendering the prompts cannot see them, so each one is named explicitly —
    and each one is parametrized here rather than covered by a single case,
    because the failure of a list like this is always the entry nobody added.
    """
    before = ev.detector_fingerprint()
    monkeypatch.setattr(lang, cap, getattr(lang, cap) - 1)
    assert ev.detector_fingerprint() != before


def test_a_recording_made_by_a_different_detector_is_dropped_not_blended(
    tmp_path, monkeypatch,
):
    path = tmp_path / "rec.json"
    ev.save_run(ev.new_run("openai/fake", {"es-clean-1": "es"}), path=path)
    monkeypatch.setattr(lang, "_SYSTEM_PROMPT", lang._SYSTEM_PROMPT + " also.")
    ev.save_run(ev.new_run("openai/fake", {"nn-clean-1": "nn"}), path=path)

    stored = ev.runs(ev.load_recording(path))
    assert stored[0]["replies"] == {"nn-clean-1": "nn"}


def test_the_fingerprint_moves_when_the_corpus_does(monkeypatch):
    """Otherwise a recording silently keeps scoring against edited samples.

    The failure this prevents is quiet and confusing: someone fixes a typo in
    a sample, the recorded replies no longer correspond to the text the model
    saw, and the eval reports an accuracy change nobody caused.
    """
    before = ev.corpus_fingerprint()
    original = corp.corpus()
    edited = (dataclasses.replace(original[0], content=original[0].content + "!"),)
    monkeypatch.setattr(corp, "corpus", lambda: edited + original[1:])
    assert ev.corpus_fingerprint() != before


@pytest.mark.skipif(not ev.runs(), reason=(
    "no provider run has been recorded. Accuracy against a real model cannot "
    "be measured offline. Record one with: "
    "python dj/free2z/manage.py record_language_eval --spend 0.25"
))
def test_recorded_run_meets_its_floors():
    for run in ev.runs():
        assert run["corpus_fingerprint"] == ev.corpus_fingerprint(), (
            f"the recording for {run['model']} was made against a different "
            f"corpus; re-record it"
        )
        assert run["detector_fingerprint"] == ev.detector_fingerprint(), (
            f"the recording for {run['model']} was made by a different "
            f"detector configuration (prompt or sampling window); re-record it"
        )
        missing = {s.id for s in corp.corpus()} - set(run["replies"])
        assert not missing, f"{run['model']} did not cover {sorted(missing)}"

        assert not run.get("silent"), (
            f"the last refresh of {run['model']} got no text at all for "
            f"{run['silent']}. That is a rate limit, an outage, or a model "
            f"that stopped answering — and this refuses to score a baseline "
            f"until you know which. Re-run the recorder; a clean run clears "
            f"the field. Earlier replies for those samples were kept, so "
            f"nothing was lost."
        )

        report = ev.score(run["replies"])
        print(f"\n=== {run['model']} ===\n{report.as_text()}")
        for pair, (correct, total) in sorted(report.by_pair().items()):
            floor = ACCURACY_FLOORS.get((run["model"], pair))
            assert floor is not None, (
                f"{run['model']} scored {correct}/{total} on {pair} and there "
                f"is no floor for it. Put the MEASURED number in "
                f"ACCURACY_FLOORS under ('{run['model']}', '{pair}') — that "
                f"is the deliverable, not a green tick."
            )
            assert correct / total >= floor, (
                f"{run['model']} regressed on {pair}: {correct}/{total} "
                f"({correct / total:.0%}) is below the recorded {floor:.0%}"
            )


# --------------------------------------------------------------------------- #
# 6. The scorer's shortcut IS the real pipeline
# --------------------------------------------------------------------------- #
# Everything above scores replies through `normalize_tag` directly rather than
# through `detect_language`, because `detect_language` needs a database, a
# model catalogue and a provider. That shortcut is only legitimate if the two
# agree, so here it is with real Postgres and a fake provider, on the samples
# where the pipeline has something to do.
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _clean_state(settings):
    settings.OPENAI_API_KEY = "test-key-not-used"
    settings.ANTHROPIC_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.MOONSHOT_API_KEY = ""
    settings.LANGUAGE_DETECTION_PROVIDERS = None
    providers._clients.clear()
    cache.clear()
    yield
    providers._clients.clear()
    cache.clear()


@pytest.fixture
def cheap_model(db):
    AIModel.objects.all().delete()
    return AIModel.objects.create(
        provider="openai", model="cheap-test", display_name="Cheap",
        system_message="x", max_tokens=100000, is_ga=True,
        input_price="0.000001", output_price="0.000002",
    )


@pytest.fixture
def scripted_provider(monkeypatch):
    def install(reply):
        def stream(ai_model, messages, **kwargs):
            yield reply
        monkeypatch.setattr(lang, "stream_chat", stream)
    return install


@pytest.mark.parametrize("sample_id,reply", [
    ("yue-clean-1", "yue-Hant"),
    ("zh-hant-clean-1", "zh-Hant"),
    ("pt-short-1", "pt"),          # regional default: stored as pt-BR, wrong
    ("sr-latn-clean-1", '"sr-Latn".'),   # a model's punctuation
])
def test_detect_language_stores_what_the_scorer_predicts(
    sample_id, reply, cheap_model, scripted_provider,
):
    sample = corp.by_id(sample_id)
    scripted_provider(reply)
    detection = lang.detect_language(sample.title, sample.content)
    assert detection.tag == ev.tag_for_reply(reply)
    assert detection.is_known


def test_a_bare_macrolanguage_detection_is_logged_not_swallowed(
    cheap_model, scripted_provider, caplog,
):
    """The surfacing  asks for, at the only layer that can see it.

    The write path in ``g12f.tasks`` decides what to *do* about it ( owns
    the registry policy); this module's job is to make sure it is not silent.
    """
    sample = corp.by_id("zh-hans-clean-1")
    scripted_provider("zh")
    with caplog.at_level("WARNING", logger="f2z.ai.language"):
        detection = lang.detect_language(sample.title, sample.content)

    assert detection.tag == "zh"
    assert detection.needs_script
    assert detection.script_candidates == ("zh-Hans", "zh-Hant")
    assert any("script-less tag that is not translatable" in r.message for r in caplog.records)


def test_a_normal_detection_logs_no_such_warning(
    cheap_model, scripted_provider, caplog,
):
    """Negative control for the warning above: it must not fire on zh-Hans."""
    sample = corp.by_id("zh-hans-clean-1")
    scripted_provider("zh-Hans")
    with caplog.at_level("WARNING", logger="f2z.ai.language"):
        detection = lang.detect_language(sample.title, sample.content)

    assert detection.tag == "zh-Hans"
    assert not detection.needs_script
    assert not any("script-less tag that is not translatable" in r.message for r in caplog.records)


# --------------------------------------------------------------------------- #
# 7. The recorder — the one thing here that spends money
# --------------------------------------------------------------------------- #
# It is run by hand and rarely, which is exactly the kind of code that rots.
# All three of these cases were found by adversarial review, not by use.
# --------------------------------------------------------------------------- #
@pytest.fixture
def recording_path(tmp_path, monkeypatch):
    path = tmp_path / "rec.json"
    monkeypatch.setattr(ev, "RECORDING_PATH", path)
    return path


def _ranking_quote(ai_model, pair):
    """What ``estimated_cost_usd`` — the model-RANKING budget — would say."""
    samples = [s for s in corp.corpus() if s.pair == pair]
    return lang.estimated_cost_usd(ai_model) * len(samples)


def _record(*args):
    out, err = io.StringIO(), io.StringIO()
    call_command("record_language_eval", *args, stdout=out, stderr=err)
    return out.getvalue(), err.getvalue()


def test_the_recorder_prices_the_worst_case_not_the_ranking_budget(
    cheap_model, recording_path, monkeypatch,
):
    """``--dry-run`` must quote what the run can actually cost.

    ``estimated_cost_usd`` exists to ORDER models by price: 800 input tokens
    and 8 output tokens. A real detection may make two attempts and is billed
    at the 32-token output cap for each, so quoting the ranking budget
    understates the run — and an up-front number lower than what the loop can
    spend is not a ceiling.
    """
    def explode(*a, **kw):
        raise AssertionError("--dry-run must not call a provider")
        yield  # pragma: no cover
    monkeypatch.setattr(lang, "stream_chat", explode)

    out, _ = _record("--spend", "1", "--pair", "cs-vs-sk", "--dry-run")
    quoted = float(out.split("worst case $")[1].split(" ")[0])

    # The 1% margin is not slack, it is the difference between "greater" and
    # "greater after both were rounded to six decimal places" — without it
    # this assertion passes when the two numbers are the same.
    assert quoted > _ranking_quote(cheap_model, "cs-vs-sk") * 1.01, quoted
    assert not recording_path.exists()


def test_the_recorder_refuses_a_run_it_cannot_afford(cheap_model, recording_path):
    """And the ceiling is compared against the worst case, not the ranking one.

    The ceiling used here sits strictly between the two numbers, so it is
    affordable on the ranking estimate and not on a real run. A command that
    quoted the ranking budget would accept it, start calling a paid API, and
    discover the difference afterwards.
    """
    out, _ = _record("--spend", "1", "--pair", "cs-vs-sk", "--dry-run")
    quoted = float(out.split("worst case $")[1].split(" ")[0])
    ranking = _ranking_quote(cheap_model, "cs-vs-sk")
    assert ranking < quoted, "nothing to test if the two agree"

    with pytest.raises(CommandError, match="exceeds --spend"):
        _record("--spend", f"{(ranking + quoted) / 2:.10f}", "--pair", "cs-vs-sk")
    assert not recording_path.exists()


def test_the_recorder_pins_one_model_so_the_attribution_is_true(
    cheap_model, recording_path, monkeypatch, db,
):
    """``detect_language`` falls back to a second candidate on its own.

    If it did that here, answers produced by the fallback would be filed under
    the model named in the recording — and a per-model accuracy floor rests
    entirely on that name being right.
    """
    AIModel.objects.create(
        provider="openai", model="second-test", display_name="Second",
        system_message="x", max_tokens=100000, is_ga=True,
        input_price="0.000002", output_price="0.000004",
    )
    seen = []

    def stream(ai_model, messages, **kwargs):
        seen.append(ai_model.model)
        # The cheapest model answers nothing at all — which is what a
        # reasoning model exhausting its 32-token output cap looks like, and
        # the exact condition that makes detect_language reach for the next
        # candidate. Unpinned, `second-test` would answer and `cheap-test`
        # would be credited.
        yield "" if ai_model.model == "cheap-test" else "cs"
    monkeypatch.setattr(lang, "stream_chat", stream)

    _record("--spend", "1", "--pair", "cs-vs-sk")

    assert set(seen) == {"cheap-test"}, (
        "the recorder must not let detect_language fall back to a model the "
        "recording will not name"
    )
    run = ev.runs(ev.load_recording(recording_path))[0]
    assert run["model"] == "openai/cheap-test"
    # A model that produces no text is a real finding about that model, so it
    # is recorded, and it replays as UNKNOWN rather than as a right answer.
    assert set(map(tuple, run["replies"].values())) == {("", "")}
    assert {o.tag for o in ev.score(run["replies"]).outcomes} == {lang.UNKNOWN}


def test_the_recorder_stores_the_raw_reply_not_the_normalized_tag(
    cheap_model, recording_path, monkeypatch,
):
    """Normalization is a policy; the model's words are a fact.

    Storing ``pt-BR`` for a model that said ``pt`` bakes today's regional
    default into the recording: if that default moved, live detection would
    change and the replay would not, and the eval would keep reporting a
    result nothing produces any more.
    """
    def stream(ai_model, messages, **kwargs):
        yield '"pt".\n'
    monkeypatch.setattr(lang, "stream_chat", stream)

    _record("--spend", "1", "--pair", "cs-vs-sk")

    run = ev.runs(ev.load_recording(recording_path))[0]
    assert set(map(tuple, run["replies"].values())) == {('"pt".\n',)}
    #...and the replay still applies the pipeline to it, quotes and all.
    assert ev.tag_for_reply(['"pt".\n']) == "pt-BR"


def test_the_recorder_keeps_every_attempt_not_just_the_accepted_one(
    cheap_model, recording_path, monkeypatch,
):
    """A rejected first attempt is evidence, and a later policy may accept it.

    ``normalize_tag`` takes the FIRST attempt that validates. If it ever
    starts accepting a shape it rejects today, live detection would take the
    earlier answer while a recording that kept only the winner would keep
    replaying the later one — the recording would stop describing the
    pipeline without anything looking wrong.
    """
    replies = iter(["Czech (cs)", "cs"] * 100)

    def stream(ai_model, messages, **kwargs):
        yield next(replies)
    monkeypatch.setattr(lang, "stream_chat", stream)

    _record("--spend", "1", "--pair", "cs-vs-sk")

    run = ev.runs(ev.load_recording(recording_path))[0]
    assert set(map(tuple, run["replies"].values())) == {("Czech (cs)", "cs")}
    # Today the parenthesised first attempt is rejected and the retry wins.
    assert ev.tag_for_reply(["Czech (cs)", "cs"]) == "cs"
    # The recording holds enough to answer differently under a new policy.
    assert ev.tag_for_reply(["Czech (cs)"]) == lang.UNKNOWN


def test_recording_one_pair_at_a_time_converges_on_the_whole_corpus(
    cheap_model, recording_path, monkeypatch,
):
    """The shape ``--pair`` exists for, and the one a replacing save breaks."""
    def stream(ai_model, messages, **kwargs):
        yield "en"
    monkeypatch.setattr(lang, "stream_chat", stream)

    _record("--spend", "1", "--pair", "cs-vs-sk")
    first = set(ev.runs(ev.load_recording(recording_path))[0]["replies"])

    _record("--spend", "1", "--pair", "nb-vs-nn")
    both = set(ev.runs(ev.load_recording(recording_path))[0]["replies"])

    assert first < both
    assert both == {
        s.id for s in corp.corpus() if s.pair in ("cs-vs-sk", "nb-vs-nn")
    }


def test_the_recorder_rejects_an_unknown_pair(cheap_model, recording_path):
    with pytest.raises(CommandError, match="unknown pair"):
        _record("--spend", "1", "--pair", "no-such-pair")


# --------------------------------------------------------------------------- #
# 8. The batch path surfaces it too
# --------------------------------------------------------------------------- #
# The isolated path is what a creator's save uses; the BATCH path is what
# labelled the existing corpus. A warning that only one of them emits is the
# less useful half — a bare macrolanguage arriving during a backfill is not one
# page, it is a shape across a whole run.
# --------------------------------------------------------------------------- #
_DOC = re.compile(r'<document id="([0-9a-f]{12})">\n(.*?)\n</document', re.DOTALL)


def _batch_answers(tag_for_real_documents):
    """A provider that answers the canaries truthfully and the rest as given."""
    canaries = {text: tag for tag, text in lang.BATCH_CANARIES}

    def stream(ai_model, messages, **kwargs):
        prompt = messages[-1]["content"]
        lines = []
        for doc_id, body in _DOC.findall(prompt):
            tag = tag_for_real_documents
            for text, canary_tag in canaries.items():
                if text[:30] in body:
                    tag = canary_tag
                    break
            lines.append(f"{doc_id} {tag}")
        yield "\n".join(lines)
    return stream


def test_the_batch_path_surfaces_a_bare_macrolanguage_too(
    cheap_model, monkeypatch, caplog,
):
    monkeypatch.setattr(lang, "stream_chat", _batch_answers("zh"))
    sample = corp.by_id("zh-hans-clean-1")

    with caplog.at_level("WARNING", logger="f2z.ai.language"):
        results = lang.detect_languages_batch(
            [(1, sample.title, sample.content)], use_cache=False,
        )

    assert results[1].tag == "zh"
    assert results[1].needs_script
    assert any(
        "script-less tag that is not translatable" in r.message
        for r in caplog.records
    )


def test_the_batch_path_stays_quiet_on_a_usable_answer(
    cheap_model, monkeypatch, caplog,
):
    """Negative control: the warning must not fire on every batch."""
    monkeypatch.setattr(lang, "stream_chat", _batch_answers("zh-Hans"))
    sample = corp.by_id("zh-hans-clean-1")

    with caplog.at_level("WARNING", logger="f2z.ai.language"):
        results = lang.detect_languages_batch(
            [(1, sample.title, sample.content)], use_cache=False,
        )

    assert results[1].tag == "zh-Hans"
    assert not any(
        "script-less tag that is not translatable" in r.message
        for r in caplog.records
    )


def test_an_interrupted_recording_keeps_what_it_already_paid_for(
    cheap_model, recording_path, monkeypatch,
):
    """A slow provider plus a ^C must not throw away completed calls.

    ``detect_language`` swallows provider exceptions, so the realistic way a
    run stops early is the operator, and the whole point of the recording is
    that its contents were bought.
    """
    monkeypatch.setattr(recorder, "CHECKPOINT_EVERY", 2)
    calls = {"n": 0}

    def stream(ai_model, messages, **kwargs):
        calls["n"] += 1
        if calls["n"] > 2:
            raise KeyboardInterrupt
        yield "cs"
    monkeypatch.setattr(lang, "stream_chat", stream)

    with pytest.raises(KeyboardInterrupt):
        _record("--spend", "1", "--pair", "cs-vs-sk")

    run = ev.runs(ev.load_recording(recording_path))[0]
    assert len(run["replies"]) == 2


def test_checkpointing_does_not_compound_the_recorded_cost(
    cheap_model, tmp_path, monkeypatch,
):
    """``save_run`` ADDS cost_usd on merge, so a checkpoint carries a delta.

    Carrying the running total instead would make a 67-sample run report
    roughly seven times what it spent — a number that reads as real and is
    not.
    """
    def stream(ai_model, messages, **kwargs):
        yield "cs"
    monkeypatch.setattr(lang, "stream_chat", stream)

    costs = []
    for index, every in enumerate((1, 1000)):
        monkeypatch.setattr(ev, "RECORDING_PATH", tmp_path / f"rec{index}.json")
        monkeypatch.setattr(recorder, "CHECKPOINT_EVERY", every)
        _record("--spend", "1", "--pair", "cs-vs-sk")
        costs.append(ev.runs(ev.load_recording(tmp_path / f"rec{index}.json"))[0]["cost_usd"])

    # 5% because the envelope nonce is fresh per call and tokenizes to a
    # slightly different length each time — a real, irreducible wobble of a
    # fraction of a percent. Compounding four checkpoints would report ~2.5x.
    assert costs[0] == pytest.approx(costs[1], rel=0.05)
    assert costs[0] > 0


def test_a_silent_provider_does_not_overwrite_a_paid_reply(
    cheap_model, recording_path, monkeypatch,
):
    """A 429 is not an answer, and must not be filed as one.

    Every attempt coming back empty is a transport failure, a rate limit or a
    reasoning model that spent its cap on hidden tokens. ``detect_language``
    reports all three the same way — ``unknown`` — so the recorder has to look
    at the attempts rather than the verdict. Recording the silence would mark
    the sample covered, overwrite a reply an earlier run paid for, and put a
    row that says "this model answers nothing to Czech" into a table that
    reads as a measurement of the model.
    """
    ev.save_run(ev.new_run("openai/cheap-test", {"cs-clean-1": ["cs"]}, 0.001))

    def dead(ai_model, messages, **kwargs):
        raise ConnectionError("provider is down")
        yield  # pragma: no cover - makes this a generator function
    monkeypatch.setattr(lang, "stream_chat", dead)

    _, err = _record("--spend", "1", "--pair", "cs-vs-sk")

    run = ev.runs(ev.load_recording(recording_path))[0]
    assert run["replies"]["cs-clean-1"] == ["cs"], (
        "the outage must not have touched what the earlier run bought"
    )
    # The samples that had nothing to lose ARE recorded, as no answer.
    assert ev.is_silence(run["replies"]["sk-clean-1"])
    assert "no text from the provider" in err
    #...and the run says so, which is what stops the refreshed recording
    # from reading as a clean baseline.
    assert set(run["silent"]) == {
        s.id for s in corp.corpus() if s.pair == "cs-vs-sk"
    }


def test_a_clean_rerun_clears_the_silent_field(tmp_path):
    """Otherwise one bad afternoon marks a recording unusable forever."""
    path = tmp_path / "rec.json"
    ev.save_run(ev.new_run("m", {"a": ["", ""]}, silent=["a"]), path=path)
    assert ev.runs(ev.load_recording(path))[0]["silent"] == ["a"]

    ev.save_run(ev.new_run("m", {"a": ["es"]}), path=path)
    stored = ev.runs(ev.load_recording(path))[0]
    assert stored["silent"] == []
    assert stored["replies"] == {"a": ["es"]}


def test_an_unrelated_partial_run_does_not_clear_someone_elses_silence(tmp_path):
    """`silent` is per sample, and only that sample's own text clears it.

    The sequence that breaks the simpler rule: a full recording, then a
    Cantonese refresh during an outage (answers kept, ids flagged), then a
    successful `--pair cs-vs-sk` run. Replacing `silent` wholesale would let
    the Czech run clear a Cantonese flag it never touched, and the stale
    Cantonese answers would read as a healthy baseline again.
    """
    path = tmp_path / "rec.json"
    ev.save_run(ev.new_run("m", {"yue": ["yue-Hant"], "cs": ["cs"]}), path=path)
    ev.save_run(ev.new_run("m", {"yue": ["", ""]}, silent=["yue"]), path=path)
    assert ev.runs(ev.load_recording(path))[0]["silent"] == ["yue"]

    ev.save_run(ev.new_run("m", {"cs": ["cs"]}), path=path)

    stored = ev.runs(ev.load_recording(path))[0]
    assert stored["silent"] == ["yue"], "the Czech run cleared a Czech flag only"
    assert stored["replies"]["yue"] == ["yue-Hant"], "the old answer is kept"


def test_silence_never_replaces_speech(tmp_path):
    """The rule that makes recording an outage safe.

    An empty entry is stored — a model that answers nothing is a real result —
    but it may not overwrite a non-empty one. Without this, re-recording
    during a rate limit would quietly delete the baseline it was refreshing,
    and the file would still look complete.
    """
    path = tmp_path / "rec.json"
    ev.save_run(ev.new_run("m", {"a": ["es"], "b": ["", ""]}), path=path)
    ev.save_run(ev.new_run("m", {"a": ["", ""], "b": ["nn"]}), path=path)

    replies = ev.runs(ev.load_recording(path))[0]["replies"]
    assert replies["a"] == ["es"], "silence must not overwrite an answer"
    assert replies["b"] == ["nn"], "an answer must overwrite silence"


def test_a_cached_bare_macrolanguage_still_says_so(
    cheap_model, scripted_provider, caplog,
):
    """A week-long cache is how a problem persists after the fix ships.

    The digest cache holds a detection for seven days. If the warning only
    fired on a cold cache, every bare `zh` recorded before this landed would
    keep being served and stored for a week without a word — the warning would
    report the problem's arrival and never its persistence.
    """
    sample = corp.by_id("zh-hans-clean-1")
    scripted_provider("zh")
    first = lang.detect_language(sample.title, sample.content)
    assert first.tag == "zh"

    caplog.clear()
    with caplog.at_level("WARNING", logger="f2z.ai.language"):
        again = lang.detect_language(sample.title, sample.content)

    assert again.tag == "zh"
    warnings = [
        r.message for r in caplog.records
        if "script-less tag that is not translatable" in r.message
    ]
    assert warnings, "the cache hit went quiet"
    assert all("(cached)" in message for message in warnings), warnings


def test_the_batch_cache_hit_says_so_too(cheap_model, monkeypatch, caplog):
    monkeypatch.setattr(lang, "stream_chat", _batch_answers("zh"))
    sample = corp.by_id("zh-hans-clean-1")
    documents = [(1, sample.title, sample.content)]

    lang.detect_languages_batch(documents)

    with caplog.at_level("WARNING", logger="f2z.ai.language"):
        results = lang.detect_languages_batch(documents)

    assert results[1].tag == "zh"
    assert any(
        "batch cache" in r.message for r in caplog.records
    ), "the batch cache hit went quiet"
