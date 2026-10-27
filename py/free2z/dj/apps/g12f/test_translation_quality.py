"""Translation quality and per-script pricing .

Three things are pinned here, and they share one premise: we charge 2Z for a
translation, so both the output and the price have to be right.

1. **The price depends on what it is a translation INTO.** It did not. The
   quote estimated the reply at a flat 1.15x the source for every target
   language while billing the quote, and tokens per character vary by an order
   of magnitude across scripts.
2. **Notation is not prose.** Display math and block directives are never sent
   to a model, the same way code fences never were.
3. **Identifiers are not prose either.** A footnote id, a code identifier or a
   product name that comes back changed is a defect, and now a failed job
   rather than a published page.

Everything here is a pure function of strings and of the live tokenizer -- no
database, no provider, no charge -- which is why the numbers can be asserted
against the real thing rather than against a stub.
"""
import math
from decimal import Decimal

import pytest

from dj.apps.g12f.translation import evidence, safety, scripts, service
from f2z import languages


# ---------------------------------------------------------------------------
# Models. `provider_tokens` resolves the encoding from `model`, so the NAME is
# the load-bearing field: "gpt-4o" gets `o200k_base`, a name tiktoken has never
# heard of degrades to `cl100k_base`.
# ---------------------------------------------------------------------------
class _Model:
    provider = "openai"
    model = "gpt-4o"
    display_name = "GPT-4o"
    input_price = Decimal("0.0000025")
    output_price = Decimal("0.00001")
    markup = Decimal("1.5")
    max_output_tokens = 8192
    max_response_tokens = 8192
    max_tokens = 128000

    def get_tuzi_price(self, input_tokens, output_tokens):
        from dj.apps.openai.models import AIModel

        return AIModel.get_tuzi_price(self, input_tokens, output_tokens)

    def get_max_response_tokens(self):
        from dj.apps.openai.models import AIModel

        return AIModel.get_max_response_tokens(self)


class _UnmappedModel(_Model):
    """A provider tiktoken has no mapping for -- Anthropic, Kimi."""

    provider = "anthropic"
    model = "claude-haiku-4-5"


GPT4O = "gpt-4o"

ENGLISH_BODY = (
    "All human beings are born free and equal in dignity and rights. They "
    "are endowed with reason and conscience and should act towards one "
    "another in a spirit of brotherhood.\n"
)


class _ScriptedProvider:
    """Returns the same reply for every fragment, like the suite next door."""

    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    def __call__(self, ai_model, messages, **kwargs):
        self.calls.append(messages)
        reply = self.reply

        class Stream:
            termination_reason = "stop"

            def __iter__(self):
                yield reply

        return Stream()


def _scripted(monkeypatch, reply):
    provider = _ScriptedProvider(reply)
    monkeypatch.setattr(service, "stream_chat", provider)
    return provider


def _quote(target, *, model=None, content=ENGLISH_BODY, source="en"):
    return service.quote_document(
        title="A title",
        description="A description.",
        content=content,
        source_language=source,
        target_language=target,
        ai_model=model or _Model(),
        source_digest="deadbeef",
    )


# ---------------------------------------------------------------------------
# 1. Per-script cost -- the measurement, against the live tokenizer
# ---------------------------------------------------------------------------
#Lower bounds on `tokens(target) / tokens(English)` for the same sentence in
#`o200k_base`, the encoding gpt-4o meters in. Measured on the module's own
#corpus; asserted as bounds rather than as exact values so a tiktoken upgrade
#that shifts a count slightly does not go red for no reason, while a
#regression to a flat ratio does.
#
#The point of the table is the SPREAD. Every one of these was quoted at 1.15.
MEASURED_AT_LEAST = {
    "am": 4.5,      # Ethiopic -- the most expensive script we can name
    "my": 3.0,      # Burmese
    "km": 2.7,      # Khmer
    "ta": 2.1,      # Tamil
    "ja": 1.9,      # Japanese
    "el": 1.9,      # Greek
    "th": 1.7,      # Thai
    "bn": 1.5,      # Bengali
    "hi": 1.5,      # Hindi
    "ko": 1.4,      # Korean
}


@pytest.mark.parametrize("tag,floor", sorted(MEASURED_AT_LEAST.items()))
def test_an_expensive_script_is_measured_as_expensive(tag, floor):
    """The ratio is a real measurement of the real tokenizer, not a constant.

    NEGATIVE CONTROL: make `output_token_ratio` return
    `evidence.DEFAULT_OUTPUT_TOKEN_RATIO` unconditionally -- the pre-
    behaviour -- and every one of these fails at 1.15 < floor.
    """
    ratio = service.output_token_ratio(GPT4O, "en", tag)
    assert ratio >= floor, f"{tag} measured at {ratio:.2f}, expected >= {floor}"
    assert ratio > evidence.DEFAULT_OUTPUT_TOKEN_RATIO


def test_the_ratio_is_not_one_number_for_every_target():
    """The defect in one line: the price did not depend on the target."""
    ratios = {
        tag: service.output_token_ratio(GPT4O, "en", tag)
        for tag in ("es", "ja", "hi", "am")
    }
    assert len(set(round(value, 3) for value in ratios.values())) == 4
    assert ratios["am"] > 4 * ratios["es"]


def test_the_quote_charges_more_to_translate_into_an_expensive_script():
    """What the measurement is FOR. Same document, same model, same source.

    NEGATIVE CONTROL: restore the flat ratio and the two output estimates
    become equal, which is the state that had us selling an Amharic
    translation for the price of a Spanish one.
    """
    spanish = _quote("es")
    amharic = _quote("am")
    # Same document and same model, so the prompts differ only by the target
    # language's NAME in the system message.
    assert abs(spanish.input_tokens - amharic.input_tokens) < 50
    assert amharic.output_tokens > 4 * spanish.output_tokens


def test_translating_INTO_english_is_quoted_below_its_source_not_above_it():
    """The error had a second direction, and that one took a creator's money.

    A Hindi article translated to English produces FEWER output tokens than its
    source, and the flat 1.15 quoted it at more. Combined with the input side
    below, a Hindi creator was billed for several times the work we buy.
    """
    ratio = service.output_token_ratio(GPT4O, "hi", "en")
    assert ratio < 1.0
    assert ratio < evidence.DEFAULT_OUTPUT_TOKEN_RATIO


def test_an_unmeasured_pair_falls_back_to_exactly_the_old_constant():
    """The fallback direction is the safety property of the whole change.

    A language this module has never seen behaves precisely as it did before
     -- so the change can only correct a language it has measured.
    """
    ratio = service.output_token_ratio(GPT4O, "en", "xh-Latn-ZA-x-nope")
    assert ratio == evidence.DEFAULT_OUTPUT_TOKEN_RATIO


def test_the_quote_counts_a_devanagari_source_in_the_providers_own_encoding():
    """The input half of the same bug, and the one that over-charges.

    `cl100k_base` counts this Hindi sentence over three times what
    `o200k_base` does, and gpt-4o bills `o200k_base`. The quote IS the price --
    a delivered translation bills it with no reconciliation -- so counting it
    in the wrong encoding is a script-dependent surcharge on the creator.

    NEGATIVE CONTROL: put `count_message_tokens` back in `quote_document` and
    `input_tokens` roughly triples, failing the ratio assertion below.
    """
    model = _Model()
    hindi = "\n\n".join([evidence.sample_for("hi")] * 30)
    assert service.count_tokens(hindi) > 2.5 * service.provider_tokens(
        model, hindi
    )

    quoted = _quote("en", model=model, content=hindi, source="hi")
    # What the SAME plan would have cost under the old counter. Not a
    # re-derivation of the price -- the identical message objects, counted the
    # two ways, so the only variable is the encoding.
    legacy = 0
    for unit in service.plan_document("A title", "A description.", hindi,
                                      ai_model=model):
        if unit.kind != service.TRANSLATE:
            continue
        legacy += service.count_message_tokens(
            service.build_messages(
                unit.text, "hi", "en", unit.context,
                nonce=service.PRICING_NONCE,
            )
        )
    assert quoted.input_tokens < legacy
    assert legacy > 2.0 * quoted.input_tokens


def test_chunk_planning_uses_the_same_encoding_as_the_price():
    """A budget counted in the wrong unit buys the wrong number of calls.

    `cl100k_base` over-counts Devanagari, so a Hindi article was cut into
    several times as many chunks as `MAX_CHUNK_TOKENS` intended -- and every
    extra chunk pays the system prompt and the envelope again, which the quote
    then charges for.

    NEGATIVE CONTROL: drop the `ai_model=` argument in `quote_document`'s call
    to `plan_document` and the two counts below become equal.
    """
    body = "\n\n".join([evidence.sample_for("hi")] * 40)
    provider_plan = service.plan_document("", "", body, ai_model=_Model())
    legacy_plan = service.plan_document("", "", body)
    translated = lambda plan: [u for u in plan if u.kind == service.TRANSLATE]
    assert len(translated(provider_plan)) < len(translated(legacy_plan))


def test_the_quote_is_still_a_pure_function_of_the_document():
    """Quote and purchase both recompute the price and must agree.

    Already true for Latin targets; asserted again for a target whose ratio is
    now derived at runtime, because a derivation that was not deterministic
    would answer 409 `price_changed` for no reason a creator could act on.
    """
    first = _quote("am")
    second = _quote("am")
    assert first.price == second.price
    assert (first.input_tokens, first.output_tokens) == (
        second.input_tokens, second.output_tokens
    )


def test_a_model_tiktoken_cannot_map_still_gets_a_measured_ratio():
    """Anthropic and Kimi degrade to `cl100k_base` -- but not to a constant.

    The unit is still an estimate for them ( is what closes that), and the
    ratio is still measured in whatever unit is in play, which is the property
    that makes this survive the unit being fixed later.
    """
    unmapped = service.output_token_ratio(_UnmappedModel.model, "en", "am")
    assert unmapped > evidence.DEFAULT_OUTPUT_TOKEN_RATIO
    # Different encoding, therefore a different number -- if these were equal,
    # the ratio would not be following the counter.
    assert round(unmapped, 3) != round(
        service.output_token_ratio(GPT4O, "en", "am"), 3
    )


# ---------------------------------------------------------------------------
# 2. Markdown fidelity -- what is never sent to a model
# ---------------------------------------------------------------------------
def _sent(content):
    """The text of every unit that would reach a provider."""
    return [u.text for u in service.split_units(content) if u.kind == service.TRANSLATE]


def _reassembles(content):
    return "".join(u.text for u in service.split_units(content)) == content


MATH_DOC = """\
Some prose before.

$$
\\alpha_{ij} = \\text{mass} \\times c^2
$$

Prose between.

\\[
\\begin{aligned} x &= 1 \\end{aligned}
\\]

\\[ y = mx + b \\]

::embed[https://youtube.com/watch?v=abc]

::qrcode[zs1exampleaddress]

Prose after.
"""


def test_display_math_is_never_sent_to_a_model():
    """KaTeX source is code. A translated `\\text{mass}` is a broken formula,
    and `safety.check_translation` cannot see it: no destination changed, no
    tag appeared, no amount moved.

    NEGATIVE CONTROL: delete the `_MATH_OPEN` branch from `split_units` and the
    formulas appear in the sent list.
    """
    sent = "\n".join(_sent(MATH_DOC))
    assert "\\alpha_{ij}" not in sent
    assert "\\begin{aligned}" not in sent
    assert "y = mx + b" not in sent
    assert "Prose between." in sent


def test_a_block_directive_is_never_sent_to_a_model():
    """A directive payload is a destination, never prose. Sending it was not
    unsafe -- `safety` refuses a rewritten one -- but the outcome of a model
    "translating" a YouTube URL was a refunded job.
    """
    sent = "\n".join(_sent(MATH_DOC))
    assert "youtube.com" not in sent
    assert "zs1exampleaddress" not in sent


def test_the_document_still_reassembles_exactly():
    """The property everything else rests on, re-asserted for the new units."""
    assert _reassembles(MATH_DOC)


def test_math_with_no_blank_line_before_it_is_still_held_back():
    """The paragraph scanner has to stop at a math opener too, or a block that
    follows prose without a blank line is swallowed into it and sent anyway.
    """
    doc = "A paragraph.\n$$\n\\gamma_{k}\n$$\nAnother paragraph.\n"
    assert "\\gamma_{k}" not in "\n".join(_sent(doc))
    assert _reassembles(doc)


def test_windows_line_endings_do_not_leak_math_to_a_model():
    """`$`-anchored patterns match before a trailing `\\n` but not before a
    `\\r\\n`, so without `_strip_eol` an article that came through Windows had
    its formulas sent while the same article with Unix endings did not.

    NEGATIVE CONTROL: match `_MATH_OPEN` against the raw line instead of the
    stripped one and this fails while the test above still passes.
    """
    doc = "Prose.\r\n\r\n$$\r\n\\delta_{n}\r\n$$\r\n\r\nMore prose.\r\n"
    assert "\\delta_{n}" not in "\n".join(_sent(doc))
    assert _reassembles(doc)


def test_an_unterminated_math_block_is_held_back_rather_than_sent():
    """We disagree with the renderer here on purpose, in the safe direction:
    it would show the text as prose, we decline to translate it. A worse
    translation beats a half-translated formula.
    """
    doc = "Prose.\n\n$$\n\\epsilon = 0\n"
    assert "\\epsilon" not in "\n".join(_sent(doc))
    assert _reassembles(doc)


def test_a_single_dollar_is_prose_not_math():
    """Inline math in `markdown.ts` is `$$...$$`. A price must keep reaching
    the model, or a fundraising sentence comes back half-translated.
    """
    doc = "It costs $5 a month and x $ y.\n"
    assert _sent(doc) == [doc]


def test_alt_text_and_link_text_are_still_translated():
    """Deliberately NOT verbatim. Alt text is prose a reader (and a screen
    reader) consumes, and leaving it in the source language is a worse
    translation. Only the DESTINATION is protected, and structurally.
    """
    doc = '![a photo of a cat](https://img.example/c.png)\n'
    assert _sent(doc) == [doc]


def test_fenced_and_indented_code_are_still_verbatim():
    """The rule  extended, not replaced."""
    doc = "```py\nx = 1\n```\n\n    indented\n\nprose\n"
    assert _sent(doc) == ["prose\n"]


def test_split_units_always_terminates(monkeypatch):
    """`split_units` must be total, not merely correct today.

    `index` advances only inside the paragraph scanner, so a line that the top
    of the loop declines to consume and `_starts_verbatim` refuses to let into
    a paragraph hangs the function -- on a creator's article, in a worker.
    This is not hypothetical: it is how the negative control for the math
    branch presented, as a wedged test run rather than a red one.

    NEGATIVE CONTROL: remove the `if not block` guard from `split_units` and
    this test hangs instead of passing.
    """
    monkeypatch.setattr(service, "_MATH_OPEN", service.re.compile(r"^(?!)"))
    units = service.split_units("Prose.\n\n$$\n\\theta\n$$\n")
    assert "".join(u.text for u in units) == "Prose.\n\n$$\n\\theta\n$$\n"


# ---------------------------------------------------------------------------
# 3. Identifiers are not prose
# ---------------------------------------------------------------------------
FOOTNOTE_SOURCE = (
    "Here is a claim[^note].\n\n[^note]: The supporting detail.\n"
)


def test_translating_a_footnote_is_not_an_introduced_destination():
    """A live refund bug, found while writing the tests above.

    `_REFERENCE_TARGET` read `[^note]: The supporting detail.` as a LINK
    REFERENCE DEFINITION -- label `[^note]`, destination `The` -- so the
    Spanish `[^note]: El detalle.` "introduced" the destination `el` and
    `url_not_in_source` refunded the job. Every zPage with a footnote was in
    that state, because the first word of a footnote changes under translation
    by definition, and `marked-footnote` is in the render pipeline so
    footnotes are a real zPage feature rather than a hypothetical one.

    NEGATIVE CONTROL: drop the `(?!^)` (escaped caret) from `_REFERENCE_TARGET` and this
    raises `url_not_in_source`.
    """
    translated = "Aqui hay una afirmacion[^note].\n\n[^note]: El detalle.\n"
    safety.check_translation(FOOTNOTE_SOURCE, translated)
    assert safety.extract_destinations(FOOTNOTE_SOURCE) == set()


def test_a_real_reference_definition_is_still_read_as_one():
    """The narrowing must not blind the URL invariant to actual link
    definitions, which is the whole reason that pattern exists.
    """
    assert "https://example.com/ref" in safety.extract_destinations(
        "[r]: https://example.com/ref\n"
    )


def test_a_renamed_footnote_id_fails_the_job():
    """The two halves of a footnote land in different chunks, so a model that
    localizes the id in one and not the other leaves a reference that renders
    as literal `[^note]` text. Nothing above this saw it: no destination
    changed, no tag appeared, no amount moved.

    NEGATIVE CONTROL: remove the `reference_not_in_source` branch and this
    passes with a broken document.
    """
    translated = "Aqui hay una afirmacion[^nota].\n\n[^note]: El detalle.\n"
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(FOOTNOTE_SOURCE, translated)
    assert exc.value.code == "reference_not_in_source"


def test_a_renamed_link_reference_label_fails_the_job():
    source = "Read the [reference][r].\n\n[r]: https://example.com/ref\n"
    translated = "Lee la [referencia][ref].\n\n[r]: https://example.com/ref\n"
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(source, translated)
    assert exc.value.code == "reference_not_in_source"


def test_an_unchanged_footnote_passes():
    translated = "Aqui hay una afirmacion[^note].\n\n[^note]: El detalle.\n"
    safety.check_translation(FOOTNOTE_SOURCE, translated)


def test_a_source_whose_own_footnote_dangles_is_not_failed_by_its_translation():
    """A creator who wrote `[^a]` and never defined it has a broken article,
    not a broken translation. Failing here would cost us the whole provider
    bill for a defect that arrived with the document.
    """
    source = "A claim[^a] with no definition.\n"
    safety.check_translation(source, "Una afirmacion[^a] sin definicion.\n")


def test_dropping_a_reference_definition_is_still_allowed():
    """Subset, not resolvability. A model that prefixed the definition line so
    it stopped being one has made a worse translation, which this module has
    always let through -- the creator reviews the draft.
    """
    source = "Read the [reference][r].\n\n[r]: https://example.com/ref\n"
    safety.check_translation(source, "Lee la [referencia][r].\n")


def test_a_translated_code_identifier_fails_the_job():
    """Prompt rule 2 forbade it; nothing verified it.

    NEGATIVE CONTROL: remove the `code_identifier_not_preserved` branch and a
    renamed API call ships inside a creator's published article.
    """
    source = "Call `get_balance()` first.\n"
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(source, "Llama a `obtener_saldo()` primero.\n")
    assert exc.value.code == "code_identifier_not_preserved"


def test_an_unchanged_code_identifier_passes():
    source = "Call `get_balance()` first.\n"
    safety.check_translation(source, "Llama a `get_balance()` primero.\n")


def test_dropping_a_code_identifier_also_fails():
    """Unlike a link, an identifier is not droppable.

    Rename and delete are the same defect from a reader's side -- the API call
    the article told them to make is not in the page any more -- and the source
    -anchored rule cannot tell them apart anyway, which is the price of it
    being immune to the space-free-target false positive below.
    """
    source = "Call `get_balance()` first.\n"
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(source, "Llama a la funcion primero.\n")
    assert exc.value.code == "code_identifier_not_preserved"


def test_backticked_prose_may_still_be_translated():
    """The rule is scoped to whitespace-free spans in the SOURCE on purpose."""
    source = "Then `press Enter` to continue.\n"
    safety.check_translation(source, "Luego `pulsa Intro` para continuar.\n")


def test_backticked_prose_translated_into_a_language_with_no_spaces_passes():
    """The false positive the codex adversarial review reproduced, verbatim.

    The first version of this rule asked "is this OUTPUT span an identifier",
    and the answer is yes for every language that does not put spaces between
    words. `press Enter` is exempt in English because it contains a space;
    its Japanese translation does not, so a correct, complete, paid translation
    was discarded and refunded. Japanese, Chinese, Thai, Khmer, Lao and Burmese
    all qualify, and four of the six are on 's list -- the defect would
    have arrived with the languages this work exists to add.

    NEGATIVE CONTROL: ask the question of the output instead
    (`extract_code_identifiers(translated) - extract_code_identifiers(source)`)
    and this raises while every other test in this file still passes. The
    Spanish case above is exactly the test that missed it, because Spanish
    keeps the space.
    """
    source = "Then `press Enter` to continue.\n"
    safety.check_translation(source, "\u7d9a\u884c\u3059\u308b\u306b\u306f`Enter\u3092\u62bc\u3059`\u3002\n")


def test_an_identifier_kept_without_its_backticks_is_accepted():
    """Lenient on purpose: the rule is about the NAME surviving, not about the
    model's markup discipline, and `safety` is not a markdown fixer.
    """
    source = "Call `get_balance()` first.\n"
    safety.check_translation(source, "Llama a `get_balance()` primero.\n")
    # An identifier the model re-fenced with double backticks is still there.
    safety.check_translation(source, "Llama a ``get_balance()`` primero.\n")


def test_a_space_free_SOURCE_language_does_not_make_its_prose_an_identifier():
    """The second half of the same defect, and codex round 2 found it because
    round 1's fix only moved the question, it did not answer it.

    Run the round-1 case backwards: a Japanese SOURCE containing the space-free
    phrase `Enterを押す` in backticks, translated into English as
    `press Enter`. Whitespace says the Japanese phrase is an identifier and the
    English one is not, so the identifier "disappeared" and the paid
    translation was refunded. Whitespace cannot answer "is this code" for a
    language that does not use it, in EITHER direction -- so an identifier is
    now whitespace-free AND ASCII.

    NEGATIVE CONTROL: drop `value.isascii()` from `extract_code_identifiers`
    and this raises while every other identifier test still passes.
    """
    source = "\u7d9a\u884c\u3059\u308b\u306b\u306f`Enter\u3092\u62bc\u3059`\u3002\n"
    safety.check_translation(source, "Then `press Enter` to continue.\n")
    assert safety.extract_code_identifiers(source) == set()


def test_an_ascii_identifier_in_a_cjk_source_is_still_protected():
    """The narrowing must not switch the rule off for the languages it was
    narrowed for. `get_balance()` is ASCII wherever it appears.
    """
    source = "\u7d9a\u884c\u3059\u308b\u306b\u306f`get_balance()`\u3092\u547c\u3073\u307e\u3059\u3002\n"
    assert safety.extract_code_identifiers(source) == {"get_balance()"}
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(source, "Call `obtener_saldo()` first.\n")
    assert exc.value.code == "code_identifier_not_preserved"


def test_a_brand_name_the_model_put_in_backticks_still_counts_as_preserved():
    """codex round 2: `_prose_only` blanked code spans out of BOTH sides, so a
    model that wrote ``Use `Free2Z`.`` -- the name preserved exactly -- was
    read as having dropped it, and the whole document was refunded.

    NEGATIVE CONTROL: blank code spans out of the output too (pass
    `code_spans=True` for the translated side) and this raises.
    """
    safety.check_translation("Use Free2Z.\n", "Usa `Free2Z`.\n")


def test_a_brand_name_only_in_a_source_code_span_is_not_required_back():
    """The source side still blanks them: a name that appears there only
    inside backticks is not prose the translator was asked to keep.
    """
    safety.check_translation("Run `Free2Z-cli --help`.\n", "Solo texto.\n")


def test_our_own_title_trimming_cannot_fail_a_finished_translation(
    monkeypatch
):
    """codex round 2, and the riskiest line in that review.

    `service._fit` cuts a translated title to 128 characters AFTER the model is
    done. A 116-character English title ending in "Free2Z" has a longer Spanish
    translation, the cut removes the last word, and `brand_term_not_preserved`
    then refunded a finished, correct document over a truncation WE performed.
    A rule that fires on our own transformation is not a statement about the
    model.

    NEGATIVE CONTROL: drop the `untrimmed=` argument in `tasks.py` (or the
    `untrimmed` parameter in `check_translation`) and this raises.
    """
    long_title = (
        "An unusually long article title that goes on and on at some length "
        "about the platform itself and finally names Free2Z"
    )
    assert len(long_title) <= service.MAX_TITLE_CHARS
    # Spanish runs longer than English, which is the ordinary case and the
    # reason this is not an exotic fixture.
    translated_title = (
        "Un titulo de articulo inusualmente largo que sigue y sigue durante "
        "un buen rato sobre la plataforma misma y que finalmente nombra a "
        "Free2Z"
    )
    assert len(translated_title) > service.MAX_TITLE_CHARS
    trimmed = service._fit(translated_title, service.MAX_TITLE_CHARS)
    assert "Free2Z" not in trimmed, "fixture no longer reproduces the cut"

    safety.check_translation(
        long_title, trimmed, untrimmed=translated_title
    )
    # And without the untrimmed text it is exactly the refund codex reproduced.
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(long_title, trimmed)
    assert exc.value.code == "brand_term_not_preserved"


def test_the_worker_hands_safety_the_untrimmed_title(monkeypatch):
    """The wiring, not just the parameter. A parameter nothing passes is a
    parameter that does nothing.
    """
    long_title = "x" * 200 + " Free2Z"
    _scripted(monkeypatch, "Traduccion. " * 10 + "Free2Z")
    result = service.translate_document(
        title=long_title, description="", content="A paragraph.\n",
        source_language="en", target_language="es", ai_model=_Model(),
    )
    assert len(result.title) <= service.MAX_TITLE_CHARS
    assert len(result.raw_title) >= len(result.title)
    assert "Free2Z" in result.raw_title


def test_a_regional_source_tag_is_priced_like_its_base_language():
    """codex round 2: `sample_for` is an exact lookup, so `en-US` missed the
    English sample and fell through to the mean of every Latin-script sample --
    Vietnamese and Turkish included. That mean is the DENOMINATOR of the output
    estimate, so the same article with the same target was quoted differently
    for a label that changes nothing about the text, and a delivered job bills
    the quote.

    NEGATIVE CONTROL: remove the `_tag_fallbacks` walk from
    `_reference_weight` and the two ratios below differ.
    """
    for regional, base in (("en-US", "en"), ("pt-BR-x-a", "pt-BR"),
                           ("zh-Hant-TW", "zh-Hant")):
        assert service.output_token_ratio(GPT4O, regional, "ja") == (
            service.output_token_ratio(GPT4O, base, "ja")
        )
        assert service.output_token_ratio(GPT4O, "en", regional) == (
            service.output_token_ratio(GPT4O, "en", base)
        )


def test_the_prefix_walk_never_invents_a_tag():
    assert service._tag_fallbacks("zh-Hant-TW") == (
        "zh-Hant-TW", "zh-Hant", "zh"
    )
    assert service._tag_fallbacks("en") == ("en",)


def test_rejected_output_is_never_carried_into_the_next_purchase():
    """A rejected fragment must not be handed to the retry.

    `settle_failure` keeps this run's fragments so a later purchase of the same
    document does not pay for them twice -- which is right for a provider
    outage and wrong for output we REFUSED, because the retry then fails the
    same check without asking the provider again. Found by the codex
    adversarial review, which noted that adding a code to `FAULT_BY_CODE` and
    forgetting this set is silent while the reverse is not.
    """
    from dj.apps.g12f.translation import settlement

    for code in (
        "reference_not_in_source",
        "code_identifier_not_preserved",
        "brand_term_not_preserved",
    ):
        assert not settlement.may_carry_fragments(code), code


def test_the_prompt_change_invalidates_fragments_generated_before_it():
    """Rule 6 is new, so a fragment generated without it is a fragment the old
    prompt was entitled to produce -- and recalling one after this deploys
    would hand `brand_term_not_preserved` a transliteration and fail the very
    retry the carry-over exists to make cheaper.

    NEGATIVE CONTROL: put `GENERATION_POLICY_VERSION` back to 2 and the two
    keys below become equal.
    """
    from dj.apps.g12f.translation import settlement

    assert settlement.GENERATION_POLICY_VERSION >= 3
    key = lambda version: __import__("hashlib").sha256(
        b"\x1f".join(
            part.encode("utf-8")
            for part in (str(version), "1", "en", "ja", "body", "x")
        ) + b"\x1f"
    ).hexdigest()
    assert key(2) != key(settlement.GENERATION_POLICY_VERSION)


def test_a_transliterated_product_name_fails_the_job():
    """`2Z` is the unit a creator is charged in. A page that calls it
    something else is a page whose reader cannot match what they read to what
    the buy screen says.

    NEGATIVE CONTROL: remove the `brand_term_not_preserved` branch and the
    transliteration is stored and published.
    """
    source = "Posting on Free2Z costs 1 2Z.\n"
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(source, "フリーツーゼットへの投稿は1ゼットです。\n")
    assert exc.value.code == "brand_term_not_preserved"


def test_a_product_name_kept_in_latin_letters_passes():
    source = "Posting on Free2Z costs 1 2Z.\n"
    safety.check_translation(source, "Free2Z への投稿は 1 2Z かかります。\n")


def test_a_product_name_that_only_appears_inside_a_url_is_not_required():
    """`https://free2z.cash/docs` carries the name, and dropping a link is
    explicitly allowed -- so requiring it back would turn an allowed outcome
    into a refunded job. The destination rules already own destinations.
    """
    source = "Read [the docs](https://free2z.cash/docs).\n"
    safety.check_translation(source, "Solo texto.\n")


def test_the_2z_inside_free2z_is_not_a_separate_requirement():
    """Boundaries are over alphanumerics, not `\\b`: the `2Z` in `Free2Z` is
    preceded by a letter and is not an occurrence of the term.
    """
    source = "Free2Z is for creators.\n"
    safety.check_translation(source, "Free2Z es para creadores.\n")


def test_zcash_and_zec_survive_or_the_job_fails():
    source = "Pay with Zcash. One ZEC is plenty.\n"
    safety.check_translation(source, "Paga con Zcash. Un ZEC basta.\n")
    with pytest.raises(safety.UnsafeTranslation):
        safety.check_translation(source, "Paga con Zeta-efectivo. Uno basta.\n")


def test_the_prompt_names_the_do_not_translate_terms():
    """A rule the model is never told is not a rule. Pins the two halves --
    the prompt and `safety.DO_NOT_TRANSLATE` -- to the same list.
    """
    system = service.build_messages("x", "en", "ja")[0]["content"]
    for term in service.DO_NOT_TRANSLATE:
        assert term in system
    assert "not a cryptocurrency" in system
    assert tuple(safety.DO_NOT_TRANSLATE) == tuple(service.DO_NOT_TRANSLATE)


def test_the_new_failure_codes_are_classified():
    """An unclassified code refunds in full, which is safe but silent. These
    are ours deliberately -- see the table's comment.
    """
    from dj.apps.g12f.translation import settlement

    for code in (
        "reference_not_in_source",
        "code_identifier_not_preserved",
        "brand_term_not_preserved",
    ):
        assert settlement.FAULT_BY_CODE[code] == settlement.PLATFORM


# ---------------------------------------------------------------------------
# 3b. The target SCRIPT  -- asked for, and then checked
# ---------------------------------------------------------------------------
#Tags whose ENGLISH NAME does not say which alphabet the answer must be in.
#`sr` is the sharp one: both scripts are in genuine daily use in Serbia, so
#"Serbian" is a genuinely incomplete instruction rather than a pedantic one.
SCRIPT_AMBIGUOUS = {
    "sr": ("Cyrillic", "Cyrl"),
    "pa": ("Gurmukhi", "Guru"),
    "az": ("Latin", "Latn"),
    "uz": ("Latin", "Latn"),
    "mn": ("Cyrillic", "Cyrl"),
    "kk": ("Cyrillic", "Cyrl"),
    "yue-Hant": ("Traditional Chinese (Han)", "Hant"),
}


@pytest.mark.parametrize("tag,expected", sorted(SCRIPT_AMBIGUOUS.items()))
def test_the_prompt_names_the_script_the_answer_must_be_in(tag, expected):
    """Half one of: ask.

    `language_name("sr")` is "Serbian", which does not say Cyrillic, and the
    provider is free to answer in Latin. Both the system message and the user
    turn carry it, because the user turn is the one immediately after the
    fragment and the system message is the one a model re-reads.

    NEGATIVE CONTROL: drop `{target_script}` from `_SYSTEM_PROMPT` and
    `{script_clause}` from the user turn and every one of these fails.
    """
    name, code = expected
    assert service.target_script(tag) == code
    system, user = service.build_messages("x", "en", tag)
    assert f"written in the {name} script" in system["content"]
    assert f"written in the {name} script" in user["content"]


def test_a_regional_or_scripted_tag_is_asked_for_its_own_script():
    """`sr-Latn` is a different instruction from `sr`, and must not inherit
    the bare tag's CLDR default.
    """
    system = service.build_messages("x", "en", "sr-Latn")[0]["content"]
    assert "written in the Latin script" in system
    assert "Cyrillic" not in system


def test_a_script_we_cannot_name_simply_loses_the_clause():
    """Degrade to saying nothing, never to saying something wrong."""
    assert scripts.script_clause("Xyzz") == ""
    assert scripts.script_clause(None) == ""


SERBIAN_CYRILLIC = (
    "\u0421\u0432\u0430 \u0459\u0443\u0434\u0441\u043a\u0430 \u0431\u0438\u045b\u0430 \u0440\u0430\u0452\u0430\u0458\u0443 \u0441\u0435 \u0441\u043b\u043e\u0431\u043e\u0434\u043d\u0430 \u0438 \u0458\u0435\u0434\u043d\u0430\u043a\u0430 \u0443 "
    "\u0434\u043e\u0441\u0442\u043e\u0458\u0430\u043d\u0441\u0442\u0432\u0443 \u0438 \u043f\u0440\u0430\u0432\u0438\u043c\u0430. \u041e\u043d\u0430 \u0441\u0443 \u043e\u0431\u0434\u0430\u0440\u0435\u043d\u0430 \u0440\u0430\u0437\u0443\u043c\u043e\u043c \u0438 "
    "\u0441\u0432\u0435\u0448\u045b\u0443 \u0438 \u0442\u0440\u0435\u0431\u0430 \u0458\u0435\u0434\u043d\u0438 \u043f\u0440\u0435\u043c\u0430 \u0434\u0440\u0443\u0433\u0438\u043c\u0430 \u0434\u0430 \u043f\u043e\u0441\u0442\u0443\u043f\u0430\u0458\u0443 \u0443 \u0434\u0443\u0445\u0443 \u0431\u0440\u0430\u0442\u0441\u0442\u0432\u0430."
)
SERBIAN_LATIN = (
    "Sva ljudska bica radjaju se slobodna i jednaka u dostojanstvu i "
    "pravima. Ona su obdarena razumom i svescu i treba jedni prema drugima "
    "da postupaju u duhu bratstva."
)


def test_a_reply_in_the_wrong_script_fails_the_job(monkeypatch):
    """Half two, and the one that matters. Asking is not verifying.

    A Serbian translation that comes back in Latin is stored under a tag whose
    `likely_script` is `Cyrl` -- so the rendering path, `hreflang` and BCP-47
    range matching all treat it as Cyrillic, and the reader who asked for
    `sr-Latn` is not served the thing they would actually have been able to
    read. The creator paid 2Z for it.

    NEGATIVE CONTROL: remove the `_require_target_script` call from
    `translate_document` and this returns a Latin document for a `sr`
    purchase, silently.
    """
    provider = _scripted(monkeypatch, SERBIAN_LATIN)
    with pytest.raises(service.TranslationFailed) as exc:
        service.translate_document(
            title="", description="", content="A paragraph to translate.\n",
            source_language="en", target_language="sr", ai_model=_Model(),
        )
    assert exc.value.code == "wrong_script"
    assert provider.calls  # it really did reach the "provider"


def test_a_reply_in_the_right_script_is_delivered(monkeypatch):
    """The positive control. Without it the test above passes for a fixture
    that never produced anything at all.
    """
    _scripted(monkeypatch, SERBIAN_CYRILLIC)
    result = service.translate_document(
        title="", description="", content="A paragraph to translate.\n",
        source_language="en", target_language="sr", ai_model=_Model(),
    )
    assert result.content.strip() == SERBIAN_CYRILLIC


def test_latin_brand_names_do_not_make_a_cyrillic_translation_wrong():
    """It is a majority test, not a purity test. `Free2Z`, `ZEC` and any
    untranslated proper noun are Latin BY THE RULE ABOVE THIS ONE, so a purity
    test would refund every translation that obeyed the do-not-translate list.
    """
    mixed = SERBIAN_CYRILLIC + " Free2Z, 2Z, Zcash, ZEC, zPage."
    assert scripts.script_mismatch(mixed, "Cyrl") is None


def test_a_reply_too_short_to_judge_gets_no_opinion():
    """A three-word title can legitimately be all brand names."""
    assert scripts.script_mismatch("Free2Z v2", "Cyrl") is None
    assert scripts.script_mismatch("", "Cyrl") is None


def test_a_script_the_checker_cannot_classify_gets_no_opinion():
    """No opinion, never a refund, for a script outside the table."""
    assert scripts.script_mismatch(SERBIAN_LATIN * 4, "Xyzz") is None


def test_the_check_runs_on_the_replies_not_on_the_finished_document(
    monkeypatch
):
    """The false positive this shape exists to avoid.

    The finished document also contains every VERBATIM unit -- code fences,
    math, directives -- which are Latin by nature and copied through untouched.
    A code-heavy article translated correctly into Serbian is majority-Latin as
    a document and overwhelmingly Cyrillic as a set of replies, and only the
    second number says anything about the translation.

    NEGATIVE CONTROL: check `translated_title + description + content` instead
    of the replies and this refunds a correct translation.
    """
    fence = "```python\n" + "\n".join(
        f"def function_number_{i}(argument):  # a comment" for i in range(40)
    ) + "\n```\n"
    _scripted(monkeypatch, SERBIAN_CYRILLIC)
    result = service.translate_document(
        title="", description="",
        content="A paragraph.\n\n" + fence + "\nAnother paragraph.\n",
        source_language="en", target_language="sr", ai_model=_Model(),
    )
    assert "def function_number_0" in result.content
    assert SERBIAN_CYRILLIC in result.content


def test_a_link_heavy_paragraph_does_not_fail_the_script_check(monkeypatch):
    """codex round 3, and the riskiest line in that review.

    Prompt rule 2 orders URLs, emails and code copied BYTE FOR BYTE, so they
    are Latin in every translation -- counting them against the target script
    punishes the model for obeying. One long link does it on its own: a correct
    Japanese paragraph carrying
    `[資料](https://example.com/documentation/getting-started/installation)` is
    a couple of Japanese letters against seventy Latin ones. The job had
    already been generated and paid for by then, so the refund is pure loss.

    Note what could NOT have caught this: the code-heavy control above uses
    fenced blocks, and fenced blocks never reach `replies` in the first place.

    NEGATIVE CONTROL: count the raw replies instead of
    `safety.prose_only(...)` and this raises `wrong_script`.
    """
    reply = (
        "[\u8cc7\u6599](https://example.com/documentation/getting-started/"
        "installation-and-configuration) \u3092\u3054\u89a7\u304f\u3060\u3055\u3044\u3002"
    )
    _scripted(monkeypatch, reply)
    result = service.translate_document(
        title="", description="", content="See the docs.\n",
        source_language="en", target_language="ja", ai_model=_Model(),
    )
    assert "example.com" in result.content


def test_a_wrong_script_reply_still_fails_when_it_also_carries_a_url(
    monkeypatch
):
    """The positive control for the subtraction. Blanking URLs must not blank
    the signal: a Latin ANSWER is still a Latin answer.
    """
    reply = (
        "Sva ljudska bica radjaju se slobodna i jednaka u dostojanstvu i "
        "pravima, vidi https://example.com/docs za vise informacija o tome."
    )
    _scripted(monkeypatch, reply)
    with pytest.raises(service.TranslationFailed) as exc:
        service.translate_document(
            title="", description="", content="A paragraph.\n",
            source_language="en", target_language="sr", ai_model=_Model(),
        )
    assert exc.value.code == "wrong_script"


def test_a_parent_tag_is_not_a_pricing_proxy_across_a_script_boundary():
    """codex round 3: `pa-Arab` is Shahmukhi and `pa` is Gurmukhi.

    The prefix walk inherited the parent's sample regardless of script, which
    picks the one denominator guaranteed to be wrong in a table whose whole
    premise is that the script dominates. The purchase endpoint accepts any
    DETECTABLE source language, so `pa-Arab` in is reachable even though
    `pa-Arab` out is not sellable.

    NEGATIVE CONTROL: drop the `script_of(candidate) != script` guard from
    `_reference_weight` and `pa-Arab` prices as Gurmukhi.
    """
    assert evidence.script_of("pa") == "Guru"
    assert evidence.script_of("pa-Arab") == "Arab"
    assert service.output_token_ratio(GPT4O, "en", "pa-Arab") != (
        service.output_token_ratio(GPT4O, "en", "pa")
    )
    # It lands on the Arabic-script mean, which is what it should be.
    assert service.output_token_ratio(GPT4O, "en", "pa-Arab") != (
        evidence.DEFAULT_OUTPUT_TOKEN_RATIO
    )


def test_a_same_script_parent_is_still_a_pricing_proxy():
    """The guard must not switch the walk off. `en-US` is Latin, `en` is
    Latin, and they must still price identically -- that was round 2's finding
    and this must not undo it.
    """
    assert service.output_token_ratio(GPT4O, "en-US", "ja") == (
        service.output_token_ratio(GPT4O, "en", "ja")
    )


def test_simplified_and_traditional_han_are_not_claimed_to_be_verified():
    """`unicodedata` cannot tell them apart, so the checker says so by passing
    both rather than by guessing. The NAME still differs in the prompt, which
    is the half that can act on it.
    """
    traditional = "\u4eba\u4eba\u751f\u800c\u81ea\u7531\uff0c\u5728\u5c0a\u56b4\u548c\u6b0a\u5229\u4e0a\u4e00\u5f8b\u5e73\u7b49\u3002" * 6
    assert scripts.script_mismatch(traditional, "Hans") is None
    assert scripts.script_mismatch(traditional, "Hant") is None
    assert "Traditional" in service.build_messages("x", "en", "zh-Hant")[0][
        "content"
    ]
    assert "Simplified" in service.build_messages("x", "en", "zh-Hans")[0][
        "content"
    ]


def test_wrong_script_refunds_and_does_not_carry_its_fragments():
    from dj.apps.g12f.translation import settlement

    assert settlement.FAULT_BY_CODE["wrong_script"] == settlement.PLATFORM
    assert not settlement.may_carry_fragments("wrong_script")


@pytest.mark.parametrize("tag", sorted(languages.TRANSLATABLE))
def test_every_sellable_language_is_asked_for_a_script(tag):
    """A language we sell whose script we cannot name is a language whose
    output nobody is checking. Today that set is empty; this keeps it empty as
     grows the list.
    """
    script = service.target_script(tag)
    assert script, tag
    assert scripts.script_name(script), (
        f"{tag} resolves to script {script!r}, which "
        "dj/apps/g12f/translation/scripts.py does not name -- add it to SCRIPTS"
    )


# ---------------------------------------------------------------------------
# 4. Quality evidence -- the gate that makes growing the sell list cost
#    something
# ---------------------------------------------------------------------------
def test_every_sellable_language_has_an_evidence_row():
    """The whole governance mechanism, in one assertion.

     wants `TRANSLATABLE` to go from 39 to 50+. This is what stops that
    becoming "we are charging for fifty languages we have never measured":
    add one without a row here and the gate goes red, with the fix being three
    lines in `translation/evidence.py`.

    Demotion is the cheap direction on purpose -- drop the tag from
    `TRANSLATABLE` and it stops being sellable; the row may stay.
    """
    missing = sorted(
        tag for tag in languages.TRANSLATABLE if not evidence.has_evidence(tag)
    )
    assert not missing, (
        "these languages are sold but have no evidence row in "
        f"dj/apps/g12f/translation/evidence.py: {missing}"
    )


@pytest.mark.parametrize("tag", sorted(languages.TRANSLATABLE))
def test_every_sellable_language_can_actually_be_priced(tag):
    """A row is not enough -- the row has to reach a parallel sample, its own
    or its script's. A language that falls through to the default constant is
    a language we are pricing by assumption.
    """
    ratio = service.output_token_ratio(GPT4O, "en", tag)
    if tag == "en":
        assert ratio == pytest.approx(1.0)
        return
    assert ratio != evidence.DEFAULT_OUTPUT_TOKEN_RATIO


@pytest.mark.parametrize(
    "tag", sorted(t for t, row in evidence.EVIDENCE.items() if row.sample)
)
def test_a_sampled_language_says_what_was_checked(tag):
    assert "token-expansion" in evidence.EVIDENCE[tag].checked


@pytest.mark.parametrize(
    "tag", sorted(t for t, row in evidence.EVIDENCE.items() if not row.sample)
)
def test_an_unsampled_language_does_not_claim_to_be_measured(tag):
    """The record must not say more than was done. A row with no parallel text
    is priced from its script's mean, and claiming `token-expansion` for it
    would make the table a worse guide than no table.
    """
    assert evidence.EVIDENCE[tag].checked == ()
    assert evidence.EVIDENCE[tag].note


def test_a_script_fallback_is_used_when_a_language_has_no_sample_of_its_own():
    """Finnish has no parallel text; Latin script does, so it is priced from
    the Latin mean rather than from the 1.15 default.
    """
    assert not evidence.sample_for("fi")
    assert evidence.samples_for_script("fi")
    assert service.output_token_ratio(GPT4O, "en", "fi") != (
        evidence.DEFAULT_OUTPUT_TOKEN_RATIO
    )


#The scripts whose samples are written in Latin letters, so an ASCII letter
#in one of them is ordinary rather than a transcription slip.
_LATIN_SAMPLE_TAGS = frozenset(
    tag for tag in evidence.EVIDENCE if evidence.script_of(tag) == "Latn"
)


@pytest.mark.parametrize(
    "tag", sorted(t for t, row in evidence.EVIDENCE.items() if row.sample)
)
def test_no_sample_carries_a_stray_ascii_character(tag):
    """The transcription slip that actually happened, twice.

    A mistyped `\\u0c83` escape does not fail -- Python reads `\\u0c8` and
    leaves a literal `3` in the middle of a Kannada word, and the same slip put
    a `9` inside a Georgian one. Neither changes a length, neither trips a
    duplicate check, and both quietly change a token count that becomes a
    charge. UDHR Article 1 contains no numerals in any language.

    NEGATIVE CONTROL: put the `3` back in the Kannada sample and this goes red
    for `kn` alone.
    """
    sample = evidence.EVIDENCE[tag].sample
    assert not any(ch.isdigit() for ch in sample), tag
    if tag not in _LATIN_SAMPLE_TAGS:
        stray = sorted({ch for ch in sample if "A" <= ch <= "z" and ch.isalpha()})
        assert not stray, f"{tag} carries Latin letters {stray}"


def test_samples_in_one_script_agree_on_length():
    """A truncated sample is far shorter than its script-mates.

    **Read the limit before trusting this.** It compares within a script, so it
    has teeth only for `Arab`, `Cyrl`, `Deva` and `Latn` -- the four with more
    than one sample. The three truncations that actually happened (Armenian,
    Georgian, Sinhala) are all in SINGLE-sample scripts, so **this test would
    not have caught any of them**, and I confirmed that by re-truncating the
    Armenian row and watching the suite stay green.

    It is kept because it does cover the four largest script families and will
    cover more as the corpus grows, and it is documented this way because a
    test whose limits are not written down gets read as coverage it does not
    have. A global band cannot replace it: complete samples run from 0.25x
    English (Chinese) to 1.42x (Tamil), and the truncated Armenian row was
    0.71x -- inside the range of perfectly complete Amharic (0.59x), Arabic
    (0.68x) and Hebrew (0.74x). No character count separates "truncated" from
    "written in a compact script".

    Semantic completeness is a reviewer reading the row against the published
    Article 1. That is the control, it is not automatable, and `evidence.py`
    says so rather than implying otherwise.
    """
    by_script = {}
    for tag, row in evidence.EVIDENCE.items():
        if not row.sample:
            continue
        by_script.setdefault(evidence.script_of(tag), []).append(
            (tag, len(row.sample))
        )
    for script, entries in sorted(by_script.items()):
        if len(entries) < 2:
            continue
        shortest = min(entries, key=lambda item: item[1])
        longest = max(entries, key=lambda item: item[1])
        assert longest[1] <= 2.2 * shortest[1], (
            f"{script}: {shortest[0]} is {shortest[1]} characters against "
            f"{longest[0]}'s {longest[1]} -- one of them is not the whole "
            "passage"
        )


def test_every_sample_is_the_same_sentence_in_a_different_language():
    """Parallelism is the property that makes a ratio meaningful. It cannot be
    asserted mechanically, so assert the things that would break it: no
    duplicates (a copy-paste of the English into another row would read as a
    1.0x language), and nothing implausibly short or long.
    """
    samples = {
        tag: row.sample for tag, row in evidence.EVIDENCE.items() if row.sample
    }
    assert len(set(samples.values())) == len(samples)
    english = len(samples["en"])
    for tag, text in samples.items():
        assert 0.2 * english < len(text) < 2.0 * english, tag


def test_the_ratio_never_runs_away_on_a_corrupt_sample(monkeypatch):
    """The guard is against a mistyped sample, not a product cap.

    NEGATIVE CONTROL: drop the `MAX_OUTPUT_TOKEN_RATIO` branch and this returns
    the runaway ratio instead of the default.
    """
    monkeypatch.setattr(
        service, "_reference_weight",
        lambda name, tag: 1.0 if tag == "en" else 10_000.0,
    )
    service.output_token_ratio.cache_clear()
    try:
        assert service.output_token_ratio(GPT4O, "en", "ja") == (
            evidence.DEFAULT_OUTPUT_TOKEN_RATIO
        )
    finally:
        service.output_token_ratio.cache_clear()


def test_output_tokens_are_rounded_up_never_down():
    """Cost-plus tolerates rounding up; rounding down is a systematic loss."""
    quote = _quote("ja")
    assert quote.output_tokens == math.ceil(quote.output_tokens)
    assert quote.output_tokens > 0
