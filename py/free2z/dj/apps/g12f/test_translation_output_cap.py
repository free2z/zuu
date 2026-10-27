"""The output cap must fit a correct translation into every language we sell.

. ``service._output_cap`` was flat -- ``OUTPUT_CEILING_RATIO`` (2.5) times
the fragment's source tokens, with a 1.6x retry -- and its docstring justified
that as *"~26% over the worst language we sell"* against the ten languages
measured.  then took ``TRANSLATABLE`` from 39 to 78 and  measured what
those languages actually cost, and **nothing failed**: the constant and the sell
list drifted silently apart until a correct, complete translation into five
sellable languages could not fit the cap on either attempt (Lao, Amharic,
Sinhala, Khmer, Burmese) and six more only fit on the paid retry (Punjabi,
Telugu, Tamil, Malayalam, Japanese, Greek).

So the tests here are about the DRIFT, not about those eleven languages. Two of
them enumerate the whole sell list against the whole ratio table, so the next
language expansion cannot repeat this: growing ``TRANSLATABLE`` past what the
cap can deliver now fails a test instead of selling a refund.

Everything here is DB-free: the cap is a pure function of a token count, a
model row's own ceiling and a language pair.

WHY THE REPLIES ARE REAL TEXT. The expansion under test is a property of real
script, and a synthetic reply of N repeated ASCII words measured with a stubbed
tokenizer would be a test of arithmetic we wrote. So a "correct translation" here
is ``evidence``'s own parallel sample for the target language, counted with the
live tokenizer -- the same text and the same counter the price is derived from.
"""
import logging
import math
from decimal import Decimal
from types import SimpleNamespace

import pytest

from dj.apps.g12f.translation import evidence, service
from f2z import languages

GPT4O = "gpt-4o"

#How many copies of the English reference sentence make one test fragment.
#Big enough that the ratio dominates the flat ``+64`` slack, small enough that
#even Lao's translation of it fits a 64,000-token reply ceiling.
SOURCE_COPIES = 10

#Copies of the TARGET sample in the reply. ``13/10`` is not a fudge factor: it
#is ``service.CORPUS_EXPANSION_UNDERSTATEMENT`` expressed as real text, i.e.
#the worst observed divergence between this one-sentence corpus and a real
#document (German, 1.49x against 1.15x, measured in ``o200k_base`` on the
#article in ). A test that replied at exactly the corpus ratio would
#prove the cap covers the corpus, which is not what anyone buys.
REPLY_COPIES = 13


class CapModel:
    """The surface the cap, the plan and the quote touch. No database."""

    provider = "openai"
    display_name = "GPT-4o"
    input_price = Decimal("0.0000025")
    output_price = Decimal("0.00001")
    markup = Decimal("1.5")
    max_output_tokens = 8192
    max_tokens = 128000

    def __init__(self, max_response_tokens=64000, model=GPT4O):
        self.max_response_tokens = max_response_tokens
        self.model = model

    def get_max_response_tokens(self):
        from dj.apps.openai.models import AIModel

        return AIModel.get_max_response_tokens(self)

    def get_tuzi_price(self, input_tokens, output_tokens):
        from dj.apps.openai.models import AIModel

        return AIModel.get_tuzi_price(self, input_tokens, output_tokens)


class OneReply:
    """A ``stream_chat`` that answers each call from a list, recording calls."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, ai_model, messages, **kwargs):
        self.calls.append(kwargs)
        reply = self.replies.pop(0) if self.replies else ""
        if isinstance(reply, tuple):
            reply, reason = reply
        else:
            reason = "end_turn" if ai_model.provider == "anthropic" else "stop"

        class Stream:
            termination_reason = reason

            def __iter__(self):
                yield reply

        return Stream()


def _translation_models():
    """``(name, reply ceiling)`` for **every** row in the seeded catalogue.

    Read off ``LINEUP`` rather than hardcoded, and deliberately not filtered to
    ``DEFAULT_MODEL_PREFERENCE``. The preference is a SETTING
    (``ZPAGE_TRANSLATION_MODELS``), and ``select_translation_model`` takes the
    first entry whose row is ``is_enabled`` and whose provider we hold a key
    for -- ``is_ga`` is explicitly not required. So any catalogue row is
    reachable without a deploy, and filtering to the compiled-in default tests
    a list production does not use.

    That is not hypothetical. 30 days of production logs show translation
    running ``openai/gpt-5.6-luna`` (5 jobs) and ``openai/gpt-4o`` (4), zero
    Anthropic and zero Kimi -- and ``gpt-5.6-luna`` is **not in**
    ``DEFAULT_MODEL_PREFERENCE`` at all. An earlier version of this file
    filtered to that tuple and therefore never exercised the model production
    uses most, while exercising two it has never called.
    """
    from dj.apps.openai.management.commands.seed_ai_models import LINEUP

    return [(row[1], row[7]) for row in LINEUP]


#Resolved once, at import: ``parametrize`` needs it at collection time.
_TRANSLATION_MODELS = _translation_models()


def _sample_for(tag):
    """This language's parallel sample, or one from its script.

    A tag with no sample of its own is PRICED from the mean of its script
    (``evidence.samples_for_script``), so the honest reply for it is a real text
    in that script. Its ratio is near the mean rather than equal to it, and that
    is the point: the cap has to cover the language, not the average.
    """
    own = evidence.sample_for(tag)
    if own:
        return own
    script = evidence.samples_for_script(tag)
    return script[0] if script else ""


def _fragment(copies=SOURCE_COPIES):
    return " ".join([evidence.sample_for("en")] * copies) + "\n"


def _unit(text, model):
    return service.Unit(
        kind=service.TRANSLATE, text=text, context="body",
        tokens=service.provider_tokens(model, text),
    )


def _deliverable_tags():
    """Every sellable target that has real text to answer in.

    English is skipped: ``en`` -> ``en`` is refused upstream as
    ``same_language``, so a cap for it is not a thing anyone buys.
    """
    return sorted(
        tag for tag in languages.TRANSLATABLE
        if tag != "en" and _sample_for(tag)
    )


# ---------------------------------------------------------------------------
# The headline case, end to end: `am` was sellable and undeliverable
# ---------------------------------------------------------------------------
def test_a_correct_amharic_translation_is_delivered_not_truncated(monkeypatch):
    """'s own example, through ``translate_document``.

    Amharic expands 5.49x against English in ``o200k_base``, so the correct,
    complete translation of a 330-token fragment is ~1,800 tokens against a flat
    cap of 889 and a retry cap of 1,423. Both attempts truncate,
    ``translate_unit`` raises ``output_truncated``, ``tasks.py`` refunds, and the
    creator is told the translation "could not be completed" -- forever, for
    every article, because the arithmetic cannot come out any other way. `am` has
    been in ``TRANSLATABLE`` since.

    The reply here is the real Ethiopic UDHR sample, so it also passes
    ``_require_target_script``: this is the whole delivery path, not the cap in
    isolation.

    FAILS ON MAIN with ``TranslationFailed: output_truncated``.

    NEGATIVE CONTROL: put the flat ratio back --
    ``return max(OUTPUT_CEILING_RATIO,...)`` -> ``return
    OUTPUT_CEILING_RATIO`` in ``output_cap_ratio`` -- and this raises
    ``output_truncated`` again.
    """
    model = CapModel()
    source = _fragment()
    reply = " ".join([evidence.sample_for("am")] * SOURCE_COPIES)
    provider = OneReply(reply)
    monkeypatch.setattr(service, "stream_chat", provider)

    result = service.translate_document(
        title="", description="", content=source,
        source_language="en", target_language="am", ai_model=model,
    )

    assert result.content.strip() == reply
    assert len(provider.calls) == 1, (
        "a correct Amharic translation must fit the FIRST attempt's cap; "
        "needing the retry means every sale pays for two generations"
    )


def test_the_amharic_cap_is_what_makes_that_work_and_main_would_not(
    monkeypatch,
):
    """The same case stated as arithmetic, so a failure names the cause.

    Not a substitute for the behavioural test above -- a companion to it. When
    that one goes red this says whether the cap or something else moved.
    """
    model = CapModel()
    source = _fragment()
    source_tokens = service.provider_tokens(model, source)
    correct = service.provider_tokens(
        model, " ".join([evidence.sample_for("am")] * SOURCE_COPIES)
    )

    flat = math.ceil(source_tokens * service.OUTPUT_CEILING_RATIO) + 64
    retry = math.ceil(flat * service.CAP_RETRY_MULTIPLIER)
    assert correct > retry, (
        "the premise of #1967: a correct Amharic translation exceeded even the "
        "retry cap"
    )

    cap = service._output_cap(model, source_tokens, "en", "am")
    # Keep the historical cap headroom as an arithmetic guard. Completion no
    # longer infers provider truncation from this reconstructed count.
    cap_margin = max(4, cap // 200)
    assert correct < cap - cap_margin


# ---------------------------------------------------------------------------
# The property: every language we SELL is deliverable at ITS OWN expansion
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("model_name,ceiling", _TRANSLATION_MODELS)
@pytest.mark.parametrize("tag", _deliverable_tags())
def test_every_sellable_language_is_deliverable_on_the_first_attempt(
    tag, model_name, ceiling, monkeypatch
):
    """The guard that stops the next language expansion recreating.

    For every tag in ``TRANSLATABLE``, on every model
    ``DEFAULT_MODEL_PREFERENCE`` can pick: translate a fragment, answer it with
    real text in that language at ``13/10`` of the corpus expansion (see
    ``REPLY_COPIES``), and require that it is DELIVERED and that it took ONE
    provider call. One call is the load-bearing half -- a second call is a second
    full generation we pay for on a sale that looks healthy in the logs, which is
    what Burmese and Khmer did on every success.

    **Every row in the catalogue, not just gpt-4o**, and not just the compiled-in
    preference -- see ``_translation_models`` for why that list is not the one
    production uses. ``provider_tokens`` degrades to ``cl100k_base`` for any
    model tiktoken has no mapping for (Anthropic, Kimi, xAI), and in that
    encoding the ratios are 3-4x larger. Running this against gpt-4o alone
    passed while ``en -> my`` was undeliverable on every unmappable row:
    ``cl100k_base`` measures it at 12.12x, ``MAX_OUTPUT_TOKEN_RATIO`` was 12.0,
    and the measurement was discarded as implausible in favour of 1.15. See that
    constant's docstring -- including the price that raising it moves, and why
    that is latent rather than live.

    This is deliberately behavioural. Asserting ``needed < cap`` would restate
    the formula in ``_output_cap``; asserting the fragment comes back exercises
    the cap, the retry and the read cap together.

    FAILS ON MAIN for 11 of the 77 on gpt-4o -- Lao, Amharic, Sinhala, Khmer and
    Burmese raise ``output_truncated``; Punjabi, Telugu, Tamil, Malayalam,
    Japanese and Greek deliver only on the second call -- and for a different,
    larger set on the ``cl100k_base`` models.

    NEGATIVE CONTROL: drop the ``max(...)`` in ``output_cap_ratio`` for the flat
    ratio and they go red, most with an exception.
    """
    model = CapModel(max_response_tokens=ceiling, model=model_name)
    source = _fragment()
    reply = " ".join([_sample_for(tag)] * REPLY_COPIES)
    provider = OneReply(reply)
    monkeypatch.setattr(service, "stream_chat", provider)

    text, _used_in, _used_out = service.translate_unit(
        model, _unit(source, model), "en", tag, deadline=None
    )

    assert text.strip() == reply.strip()
    assert len(provider.calls) == 1, (
        f"{tag} on {model_name}: a correct translation hit the first attempt's "
        f"cap, so every sale pays for two generations"
    )


@pytest.mark.parametrize("model_name,_ceiling", _TRANSLATION_MODELS)
@pytest.mark.parametrize("tag", _deliverable_tags())
def test_no_sellable_pair_is_rejected_as_an_implausible_measurement(
    tag, model_name, _ceiling
):
    """``MAX_OUTPUT_TOKEN_RATIO`` is a corruption guard, not a sell-list bound.

    A real measurement it rejects becomes ``DEFAULT_OUTPUT_TOKEN_RATIO`` (1.15),
    which under-quotes the language AND hands it the floor cap --  arriving
    through a completely different constant. It was 12.0 against a corpus whose
    real maximum is 12.12x (``en -> my`` in ``cl100k_base``), so Burmese was
    exactly that case on the production model, and the only trace was an INFO
    line blaming the sample.

    This is the test that makes the drift impossible rather than merely fixed:
    adding a language whose measured expansion exceeds the guard now fails here.
    """
    weight = service._reference_weight(model_name, tag)
    english = service._reference_weight(model_name, "en")
    if not weight or not english:
        pytest.skip(f"{tag}: no sample and no script mean")
    measured = weight / english
    assert measured <= evidence.MAX_OUTPUT_TOKEN_RATIO, (
        f"{tag} on {model_name}: the corpus measures {measured:.2f}x, over the "
        f"{evidence.MAX_OUTPUT_TOKEN_RATIO}x plausibility guard, so the "
        f"measurement is discarded for 1.15 and the cap falls to its floor"
    )
    # And the guard really is what would have been hit -- not a tautology
    # against a ratio that happens to be small.
    assert service.output_token_ratio(model_name, "en", tag) == pytest.approx(
        measured
    )


@pytest.mark.parametrize("tag", _deliverable_tags())
def test_no_language_gets_a_smaller_cap_than_the_flat_ratio_gave_it(tag):
    """A per-language cap must not be a per-language SQUEEZE.

    The obvious way to write 's fix is ``ratio x headroom``, and that hands
    Spanish 1.15 x 1.64 = 1.89x where it has 2.5x today.  was a *Spanish*
    translation refunded for hitting a cap, so tightening 67 languages to loosen
    11 trades one refund storm for another. ``OUTPUT_CEILING_RATIO`` is
    therefore a FLOOR, and this is the test that says so for every tag rather
    than for the three anyone would think to check.
    """
    model = CapModel()
    assert service.output_cap_ratio(model, "en", tag) >= (
        service.OUTPUT_CEILING_RATIO
    )


def test_the_cap_ratio_comes_from_the_same_table_as_the_price(monkeypatch):
    """One source of truth, or they drift again.

    The quote and the cap are two statements about the same unknown.  is
    what it costs when one is measured and the other is a constant, so this
    pins that the cap is a function OF the measurement -- move the measurement
    and the cap moves with it.
    """
    model = CapModel()
    monkeypatch.setattr(
        service, "output_token_ratio", lambda *a, **k: 4.0
    )
    assert service.output_cap_ratio(model, "en", "am") == pytest.approx(
        4.0 * service.OUTPUT_CAP_HEADROOM
    )


@pytest.mark.parametrize("bad", ["gpt-4o", "", 4, object()])
def test_a_model_name_where_a_model_row_belongs_raises(bad):
    """The  shape, inside the  fix. Caught by adversarial review.

    ``output_token_ratio`` is keyed on a model NAME; ``output_cap_ratio`` takes a
    model ROW because it also needs the reply ceiling. The bridge was
    ``getattr(ai_model, "model", None) or ""``, which turns a string passed by
    mistake into ``""`` -- measuring nothing, returning
    ``DEFAULT_OUTPUT_TOKEN_RATIO`` and handing back the FLOOR cap. Silently. That
    is the defect this PR exists to fix, spelled with a ``getattr`` default, and
    the same PR rightly refuses it for the language pair.
    """
    with pytest.raises(TypeError):
        service.output_cap_ratio(bad, "en", "am")
    with pytest.raises(TypeError):
        service.chunk_token_budget(bad, "en", "am")


def test_no_model_is_legal_and_measures_in_the_unit_it_counts_in():
    """``None`` is a real state, not a mistake: no model resolved yet.

    And it must not silently become the floor either. With no model,
    ``_counter_for`` counts in ``cl100k_base``, so the ratio is measured in
    ``cl100k_base`` too -- a ratio taken in one encoding against a count taken in
    another is, the mistake this module may not make twice. Amharic is
    7.30x in that unit against 5.48x in ``o200k_base``, so the two answers are
    visibly different and this pins which one comes back.
    """
    assert service.output_cap_ratio(None, "en", "am") == pytest.approx(
        max(
            service.OUTPUT_CEILING_RATIO,
            service.output_token_ratio("", "en", "am")
            * service.OUTPUT_CAP_HEADROOM,
        )
    )
    assert service.output_cap_ratio(None, "en", "am") > (
        service.output_cap_ratio(CapModel(), "en", "am")
    ), "cl100k over-counts Ethiopic against o200k; that is #1912's whole point"


def test_an_unmeasured_pair_keeps_exactly_todays_flat_cap(monkeypatch):
    """The fallback direction, which is the same one ```` chose.

    ``output_token_ratio`` answers ``DEFAULT_OUTPUT_TOKEN_RATIO`` (1.15) for a
    pair with no sample anywhere, and 1.15 x 1.64 is under 2.5 -- so an
    unmeasured language behaves exactly as it does today rather than being
    quietly squeezed by a change that cannot know anything about it.
    """
    model = CapModel()
    monkeypatch.setattr(
        service, "output_token_ratio",
        lambda *a, **k: evidence.DEFAULT_OUTPUT_TOKEN_RATIO,
    )
    source_tokens = 1000
    assert service._output_cap(model, source_tokens, "en", "xx-Zzzz") == (
        math.ceil(source_tokens * service.OUTPUT_CEILING_RATIO) + 64
    )


def test_no_evidence_row_claims_a_sellable_language_is_not_sold():
    """Seven rows said "Not in TRANSLATABLE" about languages we sell.

    Including `am`, `si`, `km` and `my` -- four of the five that could not be
    delivered. Anyone auditing the cap against the sell list would have read
    those notes and concluded the expensive languages were not on sale, which is
    how a drift stays invisible: the documentation agreed with the constant and
    both were wrong. ``checked`` is mechanically verified; a free-text note is
    not, so this asserts the one claim in it that a test CAN check.
    """
    lying = [
        tag for tag, row in evidence.EVIDENCE.items()
        if tag in languages.TRANSLATABLE
        and "not in translatable" in (row.note or "").lower()
    ]
    assert not lying, (
        f"these rows say they are not sellable and are: {sorted(lying)}"
    )


def test_the_headroom_is_derived_from_its_two_measured_factors():
    """The ledger, not a remembered number.

    "2.5 is ~26% over the worst language we sell" was true when it was written
    and false two issues later, and nothing noticed because the number had no
    derivation attached. This asserts the replacement is an expression over two
    stated measurements, so changing either one moves the cap.
    """
    assert service.OUTPUT_CAP_HEADROOM == (
        service.CORPUS_EXPANSION_UNDERSTATEMENT
        * service.MODEL_VERBOSITY_HEADROOM
    )
    # The corpus factor must be at least the worst divergence its own source
    # data shows (German, 1.49/1.15), or the cap is under-sized for a real
    # document by construction.
    assert service.CORPUS_EXPANSION_UNDERSTATEMENT >= 1.49 / 1.15


# ---------------------------------------------------------------------------
# The model's own reply ceiling: the silent `min` one layer down
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("model_name,ceiling", _TRANSLATION_MODELS)
@pytest.mark.parametrize("tag", _deliverable_tags())
def test_a_planned_fragment_is_never_larger_than_the_model_can_answer(
    tag, model_name, ceiling
):
    """``_output_cap`` ends in a ``min`` against the model's ceiling, silently.

    A cap computed correctly and then clipped is  one layer down and harder
    to see, because the per-language arithmetic is right. ``chunk_token_budget``
    inverts the cap so a fragment is never PLANNED bigger than the model can
    answer for this target; this asserts the two agree for every sellable
    language on every model translation may pick.

    It binds in exactly one place today -- Lao on a 16,384-token model, where
    the budget falls 1500 -> 1199 -- and it is the thing that would go red if
    someone raised ``MAX_CHUNK_TOKENS``, added a high-expansion language, or
    lowered a model's ``max_response_tokens`` in the catalogue.
    """
    model = CapModel(max_response_tokens=ceiling, model=model_name)
    budget = service.chunk_token_budget(model, "en", tag)
    assert budget >= service.MIN_CHUNK_TOKENS
    wanted = math.ceil(
        budget * service.output_cap_ratio(model, "en", tag)
    ) + service.OUTPUT_CAP_SLACK_TOKENS
    assert wanted <= ceiling, (
        f"{tag} on {model_name}: a fragment at the planning budget ({budget}) "
        f"wants a {wanted}-token cap against a {ceiling}-token reply ceiling, "
        f"so the ceiling -- not the cap -- decides whether a correct "
        f"translation is truncated"
    )
    assert service._output_cap(model, budget, "en", tag) == wanted


def test_the_ceiling_clipping_a_cap_is_logged_rather_than_silent(caplog):
    """The residual `chunk_token_budget` cannot remove, made findable.

    ``split_units`` never cuts inside a markdown block, so one indivisible
    paragraph bigger than the planning budget still reaches ``_output_cap`` and
    still gets clipped. Nothing can fix that here -- it needs either a refusal
    at quote time or splitting within a block -- so the requirement is that it
    is NAMED. A truncation whose cause is the model's ceiling and not our ratio
    is a different bug report.
    """
    model = CapModel(max_response_tokens=4096)
    with caplog.at_level(logging.WARNING, logger=service.logger.name):
        service._output_cap(model, 4000, "en", "am")
    assert any(
        "reply ceiling" in record.getMessage() and "#1967" in record.getMessage()
        for record in caplog.records
    ), caplog.text


def test_a_cap_well_inside_the_ceiling_says_nothing(caplog):
    """The negative half: the warning must not fire on every ordinary request.

    A log line that is always there is not a signal. Without this the test
    above passes against an unconditional ``logger.warning``.
    """
    model = CapModel()
    with caplog.at_level(logging.WARNING, logger=service.logger.name):
        service._output_cap(model, 400, "en", "am")
    assert "reply ceiling" not in caplog.text


# ---------------------------------------------------------------------------
# A token bound does not buy wall clock: the clock half
# ---------------------------------------------------------------------------
#The English reference sentence every test document here is made of, and
#what:class:`ClockedTranslator` swaps for the target's own sentence.
EN = evidence.sample_for("en")


class FakeClock:
    """A monotonic clock we move by hand."""

    def __init__(self):
        self.now = 1000.0

    def advance(self, seconds):
        self.now += seconds

    def __call__(self):
        return self.now


def _use_clock(monkeypatch):
    """Hand ``service`` a fake clock, and only ``service``.

    Replace the MODULE REFERENCE, not ``time.monotonic`` itself. Patching the
    stdlib attribute would hand a fake clock to every other thing in the
    process for the duration of the test -- a latent flake in a suite that
    runs in random order. ``service`` uses exactly one name from ``time``, so a
    namespace with that one name is a complete stand-in.
    """
    clock = FakeClock()
    monkeypatch.setattr(
        service, "time", SimpleNamespace(monotonic=clock), raising=True
    )
    return clock


class ClockedTranslator:
    """A ``stream_chat`` that translates for real and costs wall clock.

    ``OneReply`` hands back a whole answer instantly and nothing advances a
    clock, which is exactly why the deliverability tests above cannot see a
    timeout. This answers EACH fragment with its own correct translation --
    every English reference sentence in it swapped for the target's parallel
    sentence, so the reply is exactly the measured expansion of exactly that
    fragment -- and streams it in pieces, charging the fake clock
    ``provider tokens / rate`` seconds for each, the way a provider generating
    at ``rate`` tok/s would.
    """

    def __init__(self, tag, rate, clock, pieces=40, setup=0.0):
        self.target = _sample_for(tag)
        self.rate = rate
        self.clock = clock
        self.pieces = pieces
        #Seconds each call spends before its first token.
        self.setup = setup
        self.calls = []

    def __call__(self, ai_model, messages, **kwargs):
        self.calls.append(kwargs)
        user = messages[1]["content"]
        fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]
        words = fragment.replace(EN, self.target).split(" ")
        step = max(1, len(words) // self.pieces)

        translator = self

        class Stream:
            # A clean finish in the provider's own vocabulary: a
            # drained stream without a known termination reason is a
            # provider_error, not a delivered fragment.
            termination_reason = (
                "end_turn" if ai_model.provider == "anthropic" else "stop"
            )

            def __iter__(stream_self):
                translator.clock.advance(translator.setup)
                for start in range(0, len(words), step):
                    piece = " ".join(words[start:start + step])
                    if start + step < len(words):
                        piece += " "
                    translator.clock.advance(
                        service.provider_tokens(ai_model, piece)
                        / translator.rate
                    )
                    yield piece

        return Stream()


def _paragraphs(count, sentences=1):
    """``count`` paragraphs of ``sentences`` reference sentences each."""
    return "\n\n".join([" ".join([EN] * sentences)] * count) + "\n"


def _seconds_needed(model, text, tag):
    """What ``translate_unit`` will say ``text`` needs, at the floor rate."""
    unit = _unit(text, model)
    return service.fragment_seconds(service._expected_output_tokens(
        model, unit, service._pair_ratio(model, "en", tag),
    ))


#gpt-4o's own reply ceiling, the model production actually runs: the one on
#which Lao's chunk budget was 1,199 before.
GPT4O_CEILING = 16384

#A realistic sustained rate: above the planning floor
#(``MIN_OUTPUT_TOKENS_PER_SECOND``, 40) and inside gpt-4o's observed ~40-110,
#but BELOW the ~55 tok/s a 1,199-token Lao fragment needs to stream its
#correct translation inside one 180s request window.
REALISTIC_RATE = 45.0

#A rate under half the floor. Nothing we plan can promise to finish at it.
SLOW_RATE = 20.0


@pytest.mark.parametrize("rate,expect", [
    (REALISTIC_RATE, "delivered"),
    (SLOW_RATE, "timeout"),
])
def test_a_lao_article_fits_the_request_window_at_a_realistic_rate(
    rate, expect, monkeypatch
):
    """'s headline, end to end through the PLAN, on gpt-4o's ceiling.

    This replaces ``test_a_high_expansion_target_can_still_run_out_of_wall_
    clock``, which pinned the residual  left: at 60 tok/s a Lao fragment
    raised ``timeout``. That test handed ``translate_unit`` a fragment directly,
    and the fix is in what the planner is allowed to hand it --
    ``chunk_token_budget`` now sizes every fragment so its whole cap streams
    inside ``REQUEST_TIMEOUT_SECONDS`` at the floor rate -- so the replacement
    goes through ``translate_document``.

    * At a realistic 45 tok/s the article is DELIVERED. On main it was planned
      as ~1,199-token fragments whose correct Lao translation (~10,000 tokens)
      needs ~220s at that rate, and the first one timed out at 180s.
    * At 20 tok/s -- under half the floor -- it still fails as ``timeout``, but
      on the FIRST call, not late in the document after paying for the rest.

    NEGATIVE CONTROL: drop the ``request_window_tokens()`` bound from
    ``chunk_token_budget`` and the delivered case raises ``timeout``
    (``a translation fragment exceeded 180s``).
    """
    clock = _use_clock(monkeypatch)
    model = CapModel(max_response_tokens=GPT4O_CEILING)
    provider = ClockedTranslator("lo", rate, clock)
    monkeypatch.setattr(service, "stream_chat", provider)
    content = _paragraphs(40)

    if expect == "timeout":
        with pytest.raises(service.TranslationFailed) as caught:
            service.translate_document(
                title="", description="", content=content,
                source_language="en", target_language="lo", ai_model=model,
            )
        assert caught.value.code == "timeout", (
            "a correct translation that is simply SLOW must be reported as a "
            "timeout, not as output_truncated -- they point at different fixes"
        )
        assert len(provider.calls) == 1, "it must fail first, not late"
        return

    started = clock()
    result = service.translate_document(
        title="", description="", content=content,
        source_language="en", target_language="lo", ai_model=model,
    )
    assert result.content.count(_sample_for("lo")) == 40
    assert EN not in result.content
    assert len(provider.calls) > 1, "it was split, which is the fix"
    assert clock() - started < service.DOCUMENT_TIMEOUT_SECONDS


def test_a_fragment_that_cannot_finish_in_what_is_left_is_not_started(
    monkeypatch,
):
    """The expensive half of: do not START the fragment that runs out.

    ``_complete`` clamps each call to ``min(REQUEST_TIMEOUT_SECONDS, deadline -
    now)``, so late in a long document a fragment is handed whatever is left --
    and on main it was started anyway, generated by the provider up to the cut,
    billed to us, and thrown away. A Lao article failed that way around
    fragment 7, after we had paid for six.

    When what is left cannot hold this fragment's expected reply even at the
    floor rate, the call is never made: the same refund, with nothing bought.

    NEGATIVE CONTROL: delete the ``if left < needed`` block in
    ``translate_unit`` and the provider is called (and the fragment is then cut
    off at the remaining budget instead) -- ``provider.calls`` is not empty.
    """
    clock = _use_clock(monkeypatch)
    model = CapModel()
    source = _fragment(copies=40)
    needed = _seconds_needed(model, source, "lo")
    provider = ClockedTranslator("lo", REALISTIC_RATE, clock)
    monkeypatch.setattr(service, "stream_chat", provider)

    with pytest.raises(service.TranslationFailed) as caught:
        service.translate_unit(
            model, _unit(source, model), "en", "lo",
            deadline=clock() + needed / 2,
        )

    assert caught.value.code == "timeout"
    assert "not started" in str(caught.value), str(caught.value)
    assert provider.calls == [], "nothing may be bought for a doomed fragment"


class SlowThenDies:
    """A provider whose first call burns ``seconds`` and then drops."""

    def __init__(self, clock, seconds):
        self.clock = clock
        self.seconds = seconds
        self.calls = []

    def __call__(self, ai_model, messages, **kwargs):
        self.calls.append(kwargs)

        def stream():
            self.clock.advance(self.seconds)
            raise RuntimeError("connection reset by peer")
            yield ""  # pragma: no cover - makes this a generator

        return stream()


def test_a_retry_that_cannot_finish_in_what_is_left_is_not_bought(monkeypatch):
    """The not-started rule holds for the RETRY too (codex review, round 3).

    A late fragment that fits what is left starts, burns most of the window and
    then loses its connection. On the first cut of this fix the rule ran once,
    before the attempt loop, so the generic retry immediately bought a second
    call with seconds left -- which the clamp then cut off. Now the retry is
    not started and the fragment fails with the reason it actually failed for.

    NEGATIVE CONTROL: check the remaining budget only before the loop and the
    provider is called twice.
    """
    clock = _use_clock(monkeypatch)
    model = CapModel()
    source = _fragment(copies=2)
    needed = _seconds_needed(model, source, "lo")
    left = 3 * needed
    provider = SlowThenDies(clock, left - needed / 2)
    monkeypatch.setattr(service, "stream_chat", provider)

    with pytest.raises(service.TranslationFailed) as caught:
        service.translate_unit(
            model, _unit(source, model), "en", "lo", deadline=clock() + left,
        )

    assert len(provider.calls) == 1, "the doomed retry must not be bought"
    assert caught.value.code == "provider_error", caught.value.code


#Seconds left in the document when the started-fragment case below begins.
#Comfortably more than its small fragment needs at the floor rate, so the
#not-started rule lets it through; comfortably less than the stream below.
STARTED_FRAGMENT_LEFT_SECONDS = 40.0

#How long that fragment's reply takes to stream: longer than what is left,
#shorter than a full ``REQUEST_TIMEOUT_SECONDS`` -- so the two cases below
#differ ONLY in the deadline.
STARTED_FRAGMENT_STREAM_SECONDS = 120.0


def test_a_started_fragment_still_gets_only_the_remaining_document_budget(
    monkeypatch,
):
    """The clamp itself, which the not-started rule does not replace.

    A fragment that fits what is left AT THE FLOOR can still be started and
    then stream slower than the floor. It must still be cut at what is left of
    the document, not handed a fresh 180s: the document budget is what keeps a
    worker slot from being held past the reclaim policy's 900s.

    NEGATIVE CONTROL: delete ``remaining = min(remaining, deadline -
    time.monotonic())`` in ``_complete``. ``remaining`` is then always 180, the
    120s stream finishes, and the short-deadline case DELIVERS -- red.
    """
    model = CapModel()
    source = _fragment(copies=2)
    assert _seconds_needed(model, source, "lo") < (
        STARTED_FRAGMENT_LEFT_SECONDS
    ), "the not-started rule must let this one through"
    assert STARTED_FRAGMENT_LEFT_SECONDS < STARTED_FRAGMENT_STREAM_SECONDS < (
        service.REQUEST_TIMEOUT_SECONDS
    ), "the two cases must differ only in the deadline"
    reply = source.replace(EN, _sample_for("lo"))
    rate = service.provider_tokens(model, reply) / STARTED_FRAGMENT_STREAM_SECONDS

    clock = _use_clock(monkeypatch)
    monkeypatch.setattr(
        service, "stream_chat", ClockedTranslator("lo", rate, clock)
    )
    with pytest.raises(service.TranslationFailed) as caught:
        service.translate_unit(
            model, _unit(source, model), "en", "lo",
            deadline=clock() + STARTED_FRAGMENT_LEFT_SECONDS,
        )
    assert caught.value.code == "timeout"
    # The message carries the budget that was enforced: what was LEFT, not 180.
    assert f"exceeded {STARTED_FRAGMENT_LEFT_SECONDS:.0f}s" in str(
        caught.value
    ), str(caught.value)

    clock = _use_clock(monkeypatch)
    monkeypatch.setattr(
        service, "stream_chat", ClockedTranslator("lo", rate, clock)
    )
    text, _in, _out = service.translate_unit(
        model, _unit(source, model), "en", "lo",
        deadline=clock() + service.DOCUMENT_TIMEOUT_SECONDS,
    )
    assert text.strip(), "the same fragment at the same rate fits a full budget"


#Equal fragments in the falling-behind document below.
BEHIND_FRAGMENTS = 8

#How much slower than the floor that provider runs: each fragment takes 1.5x
#what the plan allowed it.
BEHIND_SLOWDOWN = 1.5


def test_a_document_that_falls_behind_stops_before_the_fragment_it_cannot_finish(
    monkeypatch,
):
    """The late-document collapse, over a whole document.

    Eight equal Lao fragments, a document budget of exactly what the plan
    needs at the floor rate (so the pre-flight accepts it), and a provider at
    two thirds of the floor. Each fragment takes 1.5x its allowance, so after
    five of them half a fragment's worth of time is left. The sixth is NOT
    started: on main it was, it ran into the clamp, and we paid for the part
    of it the provider generated before the cut.

    Five calls, all of them complete; then a ``timeout`` that bought nothing.

    NEGATIVE CONTROL: delete the ``if left < needed`` block in
    ``translate_unit`` and a sixth call is made and cut off mid-stream.
    """
    clock = _use_clock(monkeypatch)
    model = CapModel(max_response_tokens=GPT4O_CEILING)
    # 12 sentences is one fragment on its own and two do not fit one budget,
    # so the plan is exactly BEHIND_FRAGMENTS equal fragments.
    content = _paragraphs(BEHIND_FRAGMENTS, sentences=12)
    units = service.plan_document(
        "", "", content, ai_model=model,
        source_language="en", target_language="lo",
    )
    translate = [unit for unit in units if unit.kind == service.TRANSLATE]
    assert len(translate) == BEHIND_FRAGMENTS
    budget = service.estimate_wall_clock(
        units, model, "en", "lo"
    ).total_seconds
    # A rate at which each (corpus-length) reply takes BEHIND_SLOWDOWN times
    # the allowance the plan gave its fragment.
    expected = service._expected_output_tokens(
        model, translate[0], service._pair_ratio(model, "en", "lo"),
    )
    allowance = service.fragment_seconds(expected)
    provider = ClockedTranslator(
        "lo", expected / (BEHIND_SLOWDOWN * allowance), clock,
    )
    monkeypatch.setattr(service, "stream_chat", provider)

    with pytest.raises(service.TranslationFailed) as caught:
        service.translate_document(
            title="", description="", content=content,
            source_language="en", target_language="lo", ai_model=model,
            timeout=budget,
        )

    assert caught.value.code == "timeout"
    assert "not started" in str(caught.value), str(caught.value)
    assert len(provider.calls) == 5, (
        "five fragments fit 8 allowances at 1.5x each; the sixth must not be "
        "bought"
    )


def test_an_admitted_document_delivers_at_the_floor_with_per_call_setup(
    monkeypatch,
):
    """Admission must count the setup every call spends (codex review, ).

    The first cut summed output time only. A Lao document admitted at ~897s
    across nine fragments then failed at fragment 9 when each call took five
    seconds to start -- eight fragments paid for, then a refund: the
    shape, rebuilt inside the fix.

    The second round of that review found the same shape one factor along: an
    estimate that trusts the one-sentence corpus admits a document whose
    correct reply runs 30% long -- still well inside its cap -- and fails it
    after six paid calls.

    Here each reply streams as a document running the full
    ``CORPUS_EXPANSION_UNDERSTATEMENT`` past the corpus would at EXACTLY the
    floor rate (the corpus reply, streamed 1.3x slower: the same clock), after
    exactly ``REQUEST_SETUP_SECONDS`` of setup. The document budget is what
    admission said the plan needs (1% slack for the streamed pieces
    re-tokenizing a hair longer than the estimate). It must deliver.

    NEGATIVE CONTROL: drop ``REQUEST_SETUP_SECONDS``, or the
    ``CORPUS_EXPANSION_UNDERSTATEMENT`` factor, from ``fragment_seconds``: the
    budget comes out short and the document runs out before its last
    fragment -- ``timeout``.
    """
    clock = _use_clock(monkeypatch)
    model = CapModel(max_response_tokens=GPT4O_CEILING)
    content = _paragraphs(BEHIND_FRAGMENTS, sentences=12)
    units = service.plan_document(
        "", "", content, ai_model=model,
        source_language="en", target_language="lo",
    )
    assert len(
        [unit for unit in units if unit.kind == service.TRANSLATE]
    ) == BEHIND_FRAGMENTS
    budget = service.estimate_wall_clock(
        units, model, "en", "lo"
    ).total_seconds * 1.01
    provider = ClockedTranslator(
        "lo",
        service.MIN_OUTPUT_TOKENS_PER_SECOND
        / service.CORPUS_EXPANSION_UNDERSTATEMENT,
        clock,
        setup=service.REQUEST_SETUP_SECONDS,
    )
    monkeypatch.setattr(service, "stream_chat", provider)

    result = service.translate_document(
        title="", description="", content=content,
        source_language="en", target_language="lo", ai_model=model,
        timeout=budget,
    )

    assert result.content.count(_sample_for("lo")) == 12 * BEHIND_FRAGMENTS
    assert len(provider.calls) == BEHIND_FRAGMENTS


def test_a_document_that_cannot_fit_the_clock_is_refused_before_any_call(
    monkeypatch,
):
    """The worker's pre-flight: the quote's rule, before the first call.

    The purchase refuses this document (``translation_too_long``), so with
    unchanged constants the worker never sees one. It exists for the job sold
    before the floor or the plan moved -- which must fail with NO provider
    spend, not six fragments in. The same article into Spanish is untouched:
    only a high-expansion target is too long for the clock.

    NEGATIVE CONTROL: delete the pre-flight block in ``translate_document`` and
    the Lao case makes provider calls.
    """
    clock = _use_clock(monkeypatch)
    model = CapModel(max_response_tokens=GPT4O_CEILING)
    content = _paragraphs(150)

    lao = ClockedTranslator("lo", 1000.0, clock)
    monkeypatch.setattr(service, "stream_chat", lao)
    with pytest.raises(service.TranslationFailed) as caught:
        service.translate_document(
            title="", description="", content=content,
            source_language="en", target_language="lo", ai_model=model,
        )
    assert caught.value.code == "timeout"
    assert "not started" in str(caught.value), str(caught.value)
    assert lao.calls == []

    spanish = ClockedTranslator("es", 1000.0, clock)
    monkeypatch.setattr(service, "stream_chat", spanish)
    result = service.translate_document(
        title="", description="", content=content,
        source_language="en", target_language="es", ai_model=model,
    )
    assert spanish.calls and result.content.strip()


def test_the_quote_clock_is_the_price_estimate_streamed_at_the_floor():
    """One table for the price, the cap AND the clock.

    The refusal sits on the same screen as the price, so they must be about the
    same reply: ``wall_clock.total_seconds`` is exactly the quote's own
    ``output_tokens``, scaled by ``CORPUS_EXPANSION_UNDERSTATEMENT`` (a real
    document runs up to 30% past the corpus) and streamed at
    ``MIN_OUTPUT_TOKENS_PER_SECOND``, plus one ``REQUEST_SETUP_SECONDS`` per
    chunk. A clock computed from the cap (1.64x the estimate) would refuse
    articles the price says are ordinary.
    """
    model = CapModel(max_response_tokens=GPT4O_CEILING)
    for tag in ("lo", "am", "es"):
        quote = service.quote_document(
            title="A title", description="A description.",
            content=_paragraphs(30), source_language="en",
            target_language=tag, ai_model=model, source_digest="d",
        )
        assert quote.wall_clock.total_seconds == pytest.approx(
            quote.output_tokens * service.CORPUS_EXPANSION_UNDERSTATEMENT
            / service.MIN_OUTPUT_TOKENS_PER_SECOND
            + quote.chunks * service.REQUEST_SETUP_SECONDS
        ), tag


@pytest.mark.parametrize("content,lao,spanish", [
    # Long, but cut into fragments that each fit: the WHOLE is too long for Lao.
    (_paragraphs(150), service.TOO_LONG_DOCUMENT, None),
    # One unbroken paragraph `split_units` may not cut: too long for one
    # request window in Lao, which no amount of planning can fix.
    (" ".join([EN] * 40) + "\n", service.TOO_LONG_FRAGMENT, None),
    # An ordinary article fits both.
    (_paragraphs(20), None, None),
], ids=["long-document", "one-huge-paragraph", "ordinary"])
def test_the_quote_says_which_clock_a_document_cannot_fit(
    content, lao, spanish
):
    """``wall_clock_shortfall`` over real quotes, in both directions.

    Spanish is never refused here: it expands 1.15x, and the clock only bites
    the targets  unblocked. If this starts refusing Spanish the floor or
    the estimate has moved somewhere it should not have.
    """
    model = CapModel(max_response_tokens=GPT4O_CEILING)
    for tag, expected in (("lo", lao), ("es", spanish)):
        quote = service.quote_document(
            title="", description="", content=content,
            source_language="en", target_language=tag, ai_model=model,
            source_digest="d",
        )
        assert service.wall_clock_shortfall(quote.wall_clock) == expected, tag


# ---------------------------------------------------------------------------
# The cap is still a MONEY bound
# ---------------------------------------------------------------------------
def test_a_runaway_generation_is_still_cut_off(monkeypatch):
    """Raising a cap must not be the same as removing it.

    ``_output_cap`` is what stops content engineered to make the model write an
    essay from billing us without limit. The provider receives this per-language
    token ceiling, and the local read cap bounds how much text we accept. This
    runaway reaches the read cap, which cannot be fixed by raising the provider
    token ceiling, so the document fails on the first call rather than being
    retried with permission to generate more.
    """
    model = CapModel()
    source = _fragment()
    runaway = " ".join([evidence.sample_for("es")] * 400)
    provider = OneReply((runaway, "length"), (runaway, "length"))
    monkeypatch.setattr(service, "stream_chat", provider)

    with pytest.raises(service.TranslationFailed) as caught:
        service.translate_unit(
            model, _unit(source, model), "en", "es", deadline=None
        )

    assert caught.value.code == "output_truncated"
    assert len(provider.calls) == 1
    assert provider.calls[0]["max_output_tokens"] == service._output_cap(
        model, service.provider_tokens(model, source), "en", "es"
    )


#The worst case per 2Z taken that the FLAT cap already granted, and therefore
#the bound this change is not allowed to exceed. ``2.5 + 2.5 x 1.6 = 6.5``
#multiples of the fragment's source tokens, against a quote of ``ratio x``
#source -- so for a target that does not expand at all the two attempts could
#cost 6.5x the output we charged for, and that has been true since.
MAX_EXPOSURE_TO_QUOTE = 6.5


@pytest.mark.parametrize("tag", _deliverable_tags())
def test_both_attempts_stay_inside_the_exposure_the_flat_cap_already_allowed(
    tag
):
    """The money statement, per language, over ``ATTEMPTS_PER_FRAGMENT``.

    The cap is a multiple of the SOURCE; the quote is the measured ratio times
    the source. So the number that decides whether a sale can lose money is
    ``(cap + retry cap) / quoted output``, and raising caps per language moves
    it in a way a per-language table has to be checked against rather than
    argued about.

    Above the floor it is ``2.6 x OUTPUT_CAP_HEADROOM`` = 4.26x, identically for
    every measured language -- LOWER than the 4.29x-6.13x the flat 2.5 already
    grants the 67 languages that sit at the floor. So the fix does not widen our
    exposure per 2Z taken anywhere; it removes the case where it was 0.78x, i.e.
    where we had sold something we had forbidden ourselves to buy.

    NEGATIVE CONTROL: raise ``MODEL_VERBOSITY_HEADROOM`` to 2.0 (headroom 2.6,
    exposure 6.76x) and this goes red for every measured language.
    """
    # A deliberately unreachable reply ceiling and a large fragment, so this
    # measures the RATIO and not the flat `OUTPUT_CAP_SLACK_TOKENS` (which is
    # 6% of the exposure on a 1,000-token fragment and 0.3% on this one) or a
    # clip that `chunk_token_budget` exists to prevent.
    model = CapModel(max_response_tokens=10_000_000)
    source_tokens = 20_000
    cap = service._output_cap(model, source_tokens, "en", tag)
    retry = min(
        model.get_max_response_tokens(),
        math.ceil(cap * service.CAP_RETRY_MULTIPLIER),
    )
    ratio = service.output_token_ratio(GPT4O, "en", tag)
    quoted = source_tokens * ratio
    exposure = (cap + retry) / quoted
    assert exposure <= MAX_EXPOSURE_TO_QUOTE, (
        f"{tag}: two attempts could cost {exposure:.2f}x the output we quote, "
        f"over the {MAX_EXPOSURE_TO_QUOTE}x the flat cap already allowed"
    )
    if service.output_cap_ratio(model, "en", tag) > service.OUTPUT_CEILING_RATIO:
        # Above the floor the bound is exact and language-independent.
        expected = (1 + service.CAP_RETRY_MULTIPLIER) * (
            service.OUTPUT_CAP_HEADROOM
        )
        assert exposure == pytest.approx(expected, abs=0.02), tag


# ---------------------------------------------------------------------------
# Quote and worker must still plan identically
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("tag", ["lo", "am", "es"])
def test_the_quote_and_the_worker_plan_the_same_chunks(tag):
    """``chunk_token_budget`` is now an input to the plan, so both sides need it.

    A quote that planned 4 chunks and a worker that planned 5 is a purchase that
    recomputes a different price and answers 409 ``price_changed`` for no reason
    a creator can act on. Both call ``plan_document`` with the same model AND the
    same pair; this is the test that fails if one of them stops.
    """
    model = CapModel(max_response_tokens=16384)
    body = "\n\n".join([evidence.sample_for("en")] * 200)
    planned = service.plan_document(
        "", "", body, ai_model=model,
        source_language="en", target_language=tag,
    )
    quote = service.quote_document(
        title="", description="", content=body,
        source_language="en", target_language=tag,
        ai_model=model, source_digest="d",
    )
    assert quote.chunks == len(
        [u for u in planned if u.kind == service.TRANSLATE]
    )


def test_a_high_expansion_target_is_planned_in_smaller_chunks(monkeypatch):
    """The budget really does move, and only where it has to -- per bound.

    Two bounds, checked separately so neither can hide behind the other.

    THE MODEL'S CEILING. Lao expands 8.30x, so a 1,500-token fragment
    wants a 20,400-token cap and a 16,384-token model cannot answer it: 1,199
    on that model, ``MAX_CHUNK_TOKENS`` on a 64,000-token one and for Spanish.
    Isolated by making the clock bound unreachable.

    THE CLOCK. A Lao fragment's cap must also stream inside one 180s
    request window at the floor rate, which binds harder than any ceiling --
    510 on every model -- and still leaves Spanish alone.

    NEGATIVE CONTROL: make ``plan_document`` ignore the languages and the
    inequalities collapse; drop either ``min`` in ``chunk_token_budget`` and its
    half goes red.
    """
    small = CapModel(max_response_tokens=GPT4O_CEILING)
    big = CapModel(max_response_tokens=64000)

    with monkeypatch.context() as patched:
        patched.setattr(service, "MIN_OUTPUT_TOKENS_PER_SECOND", 1e9)
        ceiling_bound = service.chunk_token_budget(small, "en", "lo")
        assert ceiling_bound < service.MAX_CHUNK_TOKENS
        assert service.chunk_token_budget(big, "en", "lo") == (
            service.MAX_CHUNK_TOKENS
        )
        assert service.chunk_token_budget(small, "en", "es") == (
            service.MAX_CHUNK_TOKENS
        )

    clock_bound = service.chunk_token_budget(big, "en", "lo")
    assert clock_bound < ceiling_bound
    assert service.chunk_token_budget(small, "en", "lo") == clock_bound
    assert service.chunk_token_budget(small, "en", "es") == (
        service.MAX_CHUNK_TOKENS
    )
    assert service._output_cap(big, clock_bound, "en", "lo") <= (
        service.request_window_tokens()
    )


def test_no_model_means_the_flat_budget():
    """Callers with no model resolved keep exactly today's chunking.

    ``plan_document`` is called without a model by everything that does not care
    about the price, and an unmeasurable pair must not change their plan.
    """
    assert service.chunk_token_budget(None, "en", "am") == (
        service.MAX_CHUNK_TOKENS
    )
    assert len(service.plan_document("", "", "A paragraph.\n")) == 1
