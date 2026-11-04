"""The one place every bound derived from the SELL LIST is asserted.

**Why this file exists at all.** Three separate times now, a constant derived
from `f2z.languages.TRANSLATABLE` failed to move when TRANSLATABLE moved, and
all three times a *reviewer* caught it rather than a test:

*  grew the sell list 39 -> 78 and `SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK`
  (then 50,000, derived as ~2.5x `500 x 39`) silently fell to 1.3x headroom.
*  re-derived the sitemap bounds after the sell list outgrew the 64-language
  publish cap and recorded that a creator could not buy every sellable language
  for one article -- correctly identifying it, and correctly leaving it to a
  product issue, so nothing went red.
*  is that product issue: the 65th language a creator bought was refused
  with a 409, for a language we advertised and priced.

Every such bound is asserted HERE, including the ones that live in TypeScript,
so the next expansion of the sell list fails in ONE place with a message that
names what to re-derive -- instead of in production, as a 503 on a sitemap
child that takes up to 499 unrelated articles offline with it.

Everything in this module is pure arithmetic over module constants and source
text. There is no database, no fixture and no network: an assertion that costs
milliseconds is one nobody is tempted to skip, and the failure it prevents is
a deploy-time one.

**Adding a bound here is cheap and is the point.** If you write a constant
whose correct value depends on `len(TRANSLATABLE)`, on
`MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE`, or on `SITEMAP_CHUNK_SIZE`,
assert the relationship in this file rather than writing the arithmetic into a
comment.
"""

import re
from pathlib import Path

import pytest

from dj.apps.g12f.serializers.zpage import (
    MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE,
    MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE,
)
from dj.apps.g12f.views.sitemap import (
    SITEMAP_CHUNK_SIZE,
    SITEMAP_LEGACY_VARIANT_CAP,
    SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK,
    SITEMAP_MAX_VARIANTS_PER_ZPAGE,
    SITEMAP_WIDE_VARIANTS_GENERATION_CAP,
)
from dj.apps.g12f.translation import evidence, service
from f2z import languages

REPO_ROOT = Path(__file__).resolve().parents[5]
SITEMAP_TS = (
    REPO_ROOT / "ts" / "svelte" / "free2z" / "src" / "lib" / "server"
    / "sitemap.ts"
)


def _ts_constant(name):
    """A top-level numeric `export const` read out of the SvelteKit source.

    Reading the literal rather than importing it is deliberate: these two
    tiers are separate Deployments in separate languages with no shared build
    step, and the ONLY thing that has ever kept their mirrored constants equal
    is that someone remembered. `1_000` and `1000` both parse, so the
    underscore is stripped the way both languages read it.
    """
    source = SITEMAP_TS.read_text()
    match = re.search(
        rf"^export const {re.escape(name)}\s*=\s*([0-9_]+);$",
        source,
        re.MULTILINE,
    )
    assert match, (
        f"{name} is not a plain numeric `export const` in "
        f"{SITEMAP_TS.relative_to(REPO_ROOT)}. If it became an expression, "
        "teach this helper to read it -- do not delete the assertion."
    )
    return int(match.group(1).replace("_", ""))


def test_a_creator_may_buy_every_language_we_sell():
    """The bug  is: the sell list outgrew the per-article publish cap.

    `TRANSLATABLE` is the set of languages we take 2Z for translating into.
    The publish cap counts TRANSLATIONS and excludes the page's canonical
    source language, and a source language need not itself be sellable -- a
    page written in `nan`, or a legacy `und` row -- so the worst case a
    creator can legitimately reach is the WHOLE sell list, not one less.

    If this fails, the sell list grew past the cap. Do not "fix" it by
    trimming TRANSLATABLE: raise the cap, within the bracket the next test
    asserts, and re-derive the sitemap mirrors below.
    """
    sellable = len(languages.TRANSLATABLE)
    assert MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE >= sellable, (
        f"TRANSLATABLE lists {sellable} languages but a zPage may publish only "
        f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} translations, so the "
        f"last {sellable - MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} "
        "language(s) we advertise and price cannot be published at all."
    )
    # An AI translation always lands as a DRAFT first, so a creator
    # buying the whole sell list for one article accumulates that many drafts
    # before publishing any of them. A draft cap below the sell list refuses
    # the purchase just as hard, one step earlier.
    assert MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE >= sellable, (
        f"TRANSLATABLE lists {sellable} languages but a zPage may hold only "
        f"{MAX_DRAFT_TRANSLATION_VARIANTS_PER_ZPAGE} draft translations, so "
        "buying every language we sell for one article is refused as drafts."
    )


def test_the_publish_cap_cannot_overflow_the_sitemap_protocol():
    """The HARD ceiling on the publish cap, and the reason it is a bracket.

    every published variant is its own `<loc>`, so one sitemap
    chunk of maximally-translated articles emits
    `SITEMAP_CHUNK_SIZE x (cap + 1)` URLs. `renderUrlset` THROWS past
    `MAX_SITEMAP_ENTRIES` (50,000, the sitemap 0.9 protocol bound) and that
    throw 503s the whole child, taking up to 499 unrelated articles out of the
    sitemap with it -- the "capacity guard that fires on success" failure
    's comment blocks are written about, reached from the write path.

     made the 503 half of that STRUCTURAL: `zpageSitemapEntries` cuts an
    article to `SITEMAP_MAX_URLS_PER_ZPAGE` URLs whatever its variant count,
    and that ceiling times `SITEMAP_CHUNK_SIZE` fits the protocol bound. So
    what this asserts now is two things:

    * the chunk product of the per-article URL ceiling fits 50,000 -- if this
      fails a full chunk can 503 again, whatever the publish cap is;
    * every URL a legitimately-published article produces fits UNDER that
      ceiling, so the ceiling never silently drops a variant a creator paid
      for. The widest legitimate article is `cap + 1` URLs (every named
      variant, or every named translation plus the clean URL when the source
      is `und`/NULL -- never both, because the source is one of the
      `cap + 1`).

    So the publish cap is bracketed on BOTH sides: at least the sell list, at
    most the URL ceiling minus one. If this fails, the answer is not a bigger
    number here -- it is a smaller `SITEMAP_CHUNK_SIZE`, which is a
    deliberate decision about how many sitemap children we advertise, not a
    constant bump.
    """
    max_entries = _ts_constant("MAX_SITEMAP_ENTRIES")
    max_urls_per_zpage = _ts_constant("SITEMAP_MAX_URLS_PER_ZPAGE")

    assert SITEMAP_CHUNK_SIZE * max_urls_per_zpage <= max_entries, (
        f"{SITEMAP_CHUNK_SIZE} articles x {max_urls_per_zpage} URLs "
        f"(SITEMAP_MAX_URLS_PER_ZPAGE) = "
        f"{SITEMAP_CHUNK_SIZE * max_urls_per_zpage}, past the {max_entries}-"
        "URL sitemap protocol bound renderUrlset throws on. It must be "
        "MAX_SITEMAP_ENTRIES // SITEMAP_CHUNK_SIZE or less."
    )
    assert SITEMAP_MAX_VARIANTS_PER_ZPAGE <= max_urls_per_zpage, (
        f"A zPage may publish {SITEMAP_MAX_VARIANTS_PER_ZPAGE} variants but "
        f"the sitemap keeps at most {max_urls_per_zpage} URLs per article, so "
        "a fully-translated article silently loses variants from the sitemap. "
        "Lower SITEMAP_CHUNK_SIZE or lower the publish cap."
    )
    # The bracket is real, not vacuous: the floor must actually be below the
    # ceiling, or there is no legal value and the product decision is forced.
    assert len(languages.TRANSLATABLE) <= max_urls_per_zpage - 1, (
        "The sell list is now larger than any publish cap the current "
        f"SITEMAP_CHUNK_SIZE ({SITEMAP_CHUNK_SIZE}) permits. "
        "SITEMAP_CHUNK_SIZE has to come down before another language ships."
    )


def test_the_sitemap_per_row_bound_tracks_the_publish_cap_in_both_tiers():
    """Django and SvelteKit must agree EXACTLY, and nothing else made them.

    `parseLanguages` rejects a row longer than the SvelteKit bound and throws,
    which 503s the whole child. The two constants have only ever been equal
    because a human kept them so -- there was no test, in either language,
    comparing them. This is that test.
    """
    assert SITEMAP_MAX_VARIANTS_PER_ZPAGE == (
        MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE + 1
    ), "the source is excluded from the publish cap but is always a variant"

    assert _ts_constant("MAX_SITEMAP_VARIANTS_PER_ZPAGE") == (
        SITEMAP_MAX_VARIANTS_PER_ZPAGE
    ), (
        "MAX_SITEMAP_VARIANTS_PER_ZPAGE in "
        f"{SITEMAP_TS.relative_to(REPO_ROOT)} has drifted from Django's "
        f"SITEMAP_MAX_VARIANTS_PER_ZPAGE ({SITEMAP_MAX_VARIANTS_PER_ZPAGE}). "
        "A row longer than the SvelteKit bound 503s an entire sitemap child."
    )
    assert _ts_constant("SITEMAP_CHUNK_SIZE") == SITEMAP_CHUNK_SIZE, (
        "SITEMAP_CHUNK_SIZE has drifted between the two tiers; every "
        "per-chunk bound in both of them is derived from it."
    )


def test_the_frozen_rollout_caps_are_never_re_derived():
    """A generation's width is a historical fact, not a current judgement.

    `SITEMAP_LEGACY_VARIANT_CAP` (32) and
    `SITEMAP_WIDE_VARIANTS_GENERATION_CAP` (65) are the numbers two earlier
    SvelteKit parsers were COMPILED with. Django rolls before the frontend
    does, so both are live callers during a rollout, and answering either of
    them with today's wider list makes `parseLanguages` throw. Re-deriving
    them from the current cap -- which is precisely what the boolean
    `X-Free2Z-Sitemap-Wide-Variants: 1` header did implicitly before  --
    is the bug, not the fix.

    They may only ever be at or below the current bound; a frozen number that
    exceeded it would be a promise this backend cannot keep.
    """
    assert SITEMAP_LEGACY_VARIANT_CAP == 32
    assert SITEMAP_WIDE_VARIANTS_GENERATION_CAP == 65
    assert SITEMAP_LEGACY_VARIANT_CAP <= SITEMAP_MAX_VARIANTS_PER_ZPAGE
    assert (
        SITEMAP_WIDE_VARIANTS_GENERATION_CAP <= SITEMAP_MAX_VARIANTS_PER_ZPAGE
    )


def test_the_chunk_row_budget_holds_against_both_moving_terms():
    """`SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK` has two independent inputs.

    It bounds the QUERY, not the payload, and tripping it 503s the child. Both
    terms that can reach it move: the publish cap (bounded per article) and
    the sell list (what a normally-operating product actually produces). The
    2x is the headroom  settled on, asserted so it cannot decay into a
    rounding accident the way it did between  and.
    """
    fully_published = (
        SITEMAP_CHUNK_SIZE * MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE
    )
    fully_translated = SITEMAP_CHUNK_SIZE * len(languages.TRANSLATABLE)

    assert SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK >= 2 * fully_published, (
        f"{SITEMAP_CHUNK_SIZE} articles x "
        f"{MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE} published "
        f"translations = {fully_published} rows; "
        f"SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK is "
        f"{SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK}, under the 2x headroom #1931 "
        "derived. Re-derive it (the read is ~0.39 us/row against a 1,000 ms "
        "statement timeout)."
    )
    assert SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK >= 2 * fully_translated, (
        f"{SITEMAP_CHUNK_SIZE} articles x {len(languages.TRANSLATABLE)} "
        f"sellable languages = {fully_translated} rows; "
        f"SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK is "
        f"{SITEMAP_MAX_VARIANT_ROWS_PER_CHUNK}, under the 2x headroom."
    )


# ---------------------------------------------------------------------------
# The translation clock: a bound in TOKENS meets a bound in SECONDS
# ---------------------------------------------------------------------------
# These two are per sellable language, because the quantity that moves is each
# language's measured expansion -- the same table the price is made of. Unlike
# everything above they tokenize text (the evidence corpus, with the tokenizer
# each model is priced in), so they are milliseconds rather than microseconds;
# still no database and no fixture.


class _Row:
    """The two things the planner reads off a catalogue row. No database."""

    provider = "ledger"

    def __init__(self, model, ceiling):
        self.model = model
        self.ceiling = ceiling

    def get_max_response_tokens(self):
        return self.ceiling


def _catalogue():
    """``(name, reply ceiling)`` for every seeded row -- see
    ``test_translation_output_cap._translation_models`` for why it is every
    row and not the compiled-in preference."""
    from dj.apps.openai.management.commands.seed_ai_models import LINEUP

    return [(row[1], row[7]) for row in LINEUP]


def _sold_targets():
    """Every sellable target with real text to measure, ``en`` excepted
    (``en -> en`` is refused upstream as ``same_language``)."""
    return sorted(
        tag for tag in languages.TRANSLATABLE
        if tag != "en"
        and (evidence.sample_for(tag) or evidence.samples_for_script(tag))
    )


@pytest.mark.parametrize("model_name,ceiling", _catalogue())
def test_every_planned_fragment_cap_streams_inside_one_request_window(
    model_name, ceiling
):
    """ item 2: the per-fragment budget is ``cap / floor tok/s``.

    For EVERY language we sell, on every catalogue model, the largest fragment
    the planner will cut has a cap that streams inside
    ``REQUEST_TIMEOUT_SECONDS`` at ``MIN_OUTPUT_TOKENS_PER_SECOND``. So a
    correct translation that is merely slow -- down to the floor -- is never cut
    off by the per-call clock before the cap would have stopped it.

    The way this goes red is a new language (or a re-measured one) whose
    expansion is so large that ``MIN_CHUNK_TOKENS`` overrides the clock bound:
    the planner then hands out a fragment whose cap cannot stream in time at
    any rate we plan for. At 79 languages the tightest pair is Burmese on the
    ``cl100k_base``-degraded rows (12.12x, a 359-token budget against the
    256 floor). Fix it by lowering ``MIN_CHUNK_TOKENS`` deliberately or by not
    selling the language on that model -- never by raising the floor rate to
    make the arithmetic pass; that number is an assumption about providers,
    not a dial.
    """
    row = _Row(model_name, ceiling)
    window = service.request_window_tokens()
    over = []
    for tag in _sold_targets():
        budget = service.chunk_token_budget(row, "en", tag)
        cap = service._output_cap(row, budget, "en", tag)
        if cap > window:
            over.append(f"{tag} (budget {budget}, cap {cap})")
    assert not over, (
        f"on {model_name}, a planned fragment's cap cannot stream inside "
        f"{service.REQUEST_TIMEOUT_SECONDS:.0f}s at "
        f"{service.MIN_OUTPUT_TOKENS_PER_SECOND:.0f} tok/s ({window} tokens) "
        f"for: {', '.join(over)}"
    )


@pytest.mark.parametrize("model_name,ceiling", _catalogue())
def test_every_language_we_sell_can_deliver_a_standard_sized_article(
    model_name, ceiling
):
    """The refusal must not quietly unsell a language.

    ``wall_clock_shortfall`` refuses a document whose expected reply cannot
    stream inside ``DOCUMENT_TIMEOUT_SECONDS`` at the floor rate. For the
    high-expansion targets that is a real ceiling on article length -- about
    3,200 source tokens for Lao on gpt-4o -- and that is the point. What it must
    never become is a language we list, price and then refuse for every
    article anyone writes.

    The bar is not a number chosen here: an article of ``MAX_CHUNK_TOKENS``
    source tokens -- one standard fragment, a few paragraphs -- must be
    deliverable into every language we sell, on every catalogue model. A
    language that fails this is one whose expansion the document clock cannot
    carry, and selling it is a product decision to take on purpose, with the
    clock, not by drift.
    """
    row = _Row(model_name, ceiling)
    sentence = evidence.sample_for("en")
    per_sentence = service.provider_tokens(row, sentence)
    sentences = -(-service.MAX_CHUNK_TOKENS // per_sentence)
    # One paragraph per sentence, so the planner is free to cut it wherever
    # this language's budget says -- the plan the worker would really run.
    article = "\n\n".join([sentence] * sentences) + "\n"
    refused = []
    for tag in _sold_targets():
        units = service.plan_document(
            "", "", article, ai_model=row,
            source_language="en", target_language=tag,
        )
        clock = service.estimate_wall_clock(units, row, "en", tag)
        if service.wall_clock_shortfall(clock) is not None:
            refused.append(f"{tag} (~{clock.total_seconds:.0f}s)")
    assert not refused, (
        f"on {model_name} these sellable languages refuse even a "
        f"{service.MAX_CHUNK_TOKENS}-token article: {', '.join(refused)}"
    )


def test_the_document_clock_holds_more_than_one_request_window():
    """The two clocks must stay in the order the not-started rule assumes.

    ``translate_unit`` refuses to start a fragment the REMAINING document
    budget cannot hold, and ``wall_clock_shortfall`` refuses a single fragment
    longer than one request window. Both only make sense while a document has
    room for several windows; if ``DOCUMENT_TIMEOUT_SECONDS`` were ever cut to
    one window, every multi-fragment document would be refused and the
    reclaim policy (which is aligned to the 900s, see
    ``dj/apps/jobs/reclaim_policy.py``) would want re-deriving too.
    """
    assert service.DOCUMENT_TIMEOUT_SECONDS >= (
        2 * service.REQUEST_TIMEOUT_SECONDS
    )
    assert service.request_window_tokens() > (
        service.MIN_CHUNK_TOKENS + service.OUTPUT_CAP_SLACK_TOKENS
    )
