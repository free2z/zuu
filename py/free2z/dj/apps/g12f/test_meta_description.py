"""The zPage meta-description fallback, and its parity with SvelteKit.

``k8s/free2z/nginx.conf`` hands ``$seobot`` (googlebot, bingbot, gptbot,
claudebot, applebot, perplexity, …) to SvelteKit SSR and ``$prerender``
(twitter, facebook, slack, discord, telegram, whatsapp, …) to the Django
crawler tier. Both compute a fallback ``<meta name="description">`` for an
article whose creator left the field blank, in two different languages, and
until  they agreed on nothing: 200 characters vs 300, word-boundary vs
mid-word, markdown stripped vs untouched, whitespace collapsed vs a literal
newline sitting inside the HTML attribute. Measured live on one article at one
moment: Googlebot 194 characters, Twitterbot 310.

So the expected answer lives in ONE file --
``testdata/meta_description_parity.json`` -- and
``ts/svelte/free2z/tests/meta-description-parity.test.mjs`` asserts the
JavaScript implementation against the very same table. Change one side without
the other and both suites fail.

The second half of this module is the part a golden table cannot prove: that
the Django view actually *uses* the shared derivation, against a real Postgres
row, with the real template. A parity table over a pure function is worth
nothing if the caller still returns ``zpage.description`` raw.
"""

import json
import pathlib
import uuid

import pytest

from dj.apps.g12f.meta_description import (
    DESCRIPTION_SOURCE_CHARS,
    META_DESCRIPTION_CHARS,
    compact_text,
    strip_markdown,
    truncate,
)
from dj.apps.g12f.models import zPage
from dj.apps.g12f.views import crawler


HOST = "testserver"
PARITY = json.loads(
    (
        pathlib.Path(__file__).parent
        / "testdata"
        / "meta_description_parity.json"
    ).read_text()
)
CASES = PARITY["cases"]


def _meta(html, name):
    marker = f'<meta name="{name}" content="'
    start = html.index(marker) + len(marker)
    return html[start:html.index('"', start)]


def _page(creator, **kwargs):
    kwargs.setdefault("vanity", f"page-{uuid.uuid4().hex[:12]}")
    kwargs.setdefault("title", "A title")
    kwargs.setdefault("description", "")
    kwargs.setdefault("content", "Body copy.")
    kwargs.setdefault("is_published", True)
    return zPage.objects.create(
        creator=creator, free2zaddr=str(uuid.uuid4()), **kwargs,
    )


# --- the golden table ------------------------------------------------------


@pytest.mark.parametrize(
    "case", CASES, ids=[case["name"] for case in CASES],
)
def test_derivation_matches_the_golden_table(case):
    """Case by case, the Python half answers what the shared table says."""
    assert compact_text(
        case["value"],
        case.get("fallback", ""),
        case.get("max_length", META_DESCRIPTION_CHARS),
    ) == case["expected"]


def test_the_table_covers_heading_and_embed_regressions():
    """The table covers headings with embeds and underscore-bearing embed URLs."""
    values = [case["value"] for case in CASES]
    assert "# Maps\n\n\n\n::embed[/uploadz/public/example/clip.mp4]" in values
    assert (
        "::embed[https://youtu.be/abc_DEFgh12?si=sample_under_score]" in values
    )


@pytest.mark.parametrize(
    "case", CASES, ids=[case["name"] for case in CASES],
)
def test_no_expected_answer_can_break_an_html_attribute(case):
    """Description text must fit its HTML attribute and code-point budget."""
    expected = case["expected"]
    assert "\n" not in expected
    assert "\r" not in expected
    assert "\t" not in expected
    assert "  " not in expected
    assert expected == expected.strip()
    assert len(expected) <= case.get("max_length", META_DESCRIPTION_CHARS)


# --- the rules the table encodes, stated directly ---------------------------


def test_a_url_with_underscores_survives():
    """Underscores inside URLs are literal characters, not emphasis."""
    url = "https://youtu.be/abc_DEFgh12?si=sample_under_score"
    assert url in strip_markdown(f"Watch it here: {url} — bring questions.")
    assert strip_markdown("snake_case_name") == "snake_case_name"
    # Intraword `__` is not emphasis under CommonMark either.
    assert strip_markdown("a__b") == "a__b"


def test_emphasis_at_a_word_boundary_is_still_stripped():
    assert strip_markdown("_italic_") == "italic"
    assert strip_markdown("__bold__ text") == "bold text"
    assert strip_markdown("wrap _this_ up") == "wrap this up"


def test_an_embed_directive_is_never_description_text():
    assert strip_markdown("::embed[/uploadz/public/x/clip.mp4]") == ""
    assert strip_markdown(
        "Intro.\n::embed[/x.mp4]\nOutro."
    ) == "Intro. Outro."


def test_only_the_renderer_s_own_directive_shape_counts_as_markup():
    """Narrow on purpose: `std::vector` is text the article visibly renders.

    The one tokenizer that turns these into widgets is
    ``ts/svelte/free2z/src/lib/utils/markdown.ts``, and it is line-anchored
    with a closed set of three names. A broader "any ``::name``" rule would
    publish `Use std here` in every card for an article that shows
    `Use std::vector here` on the page.
    """
    assert strip_markdown("Use std::vector here.") == "Use std::vector here."
    assert strip_markdown("See https://ex.com/a::b now.") == (
        "See https://ex.com/a::b now."
    )
    # Mid-line, it is not a directive to the renderer either.
    assert strip_markdown("Look at ::embed[/x.mp4] inline.") == (
        "Look at ::embed[/x.mp4] inline."
    )


def test_the_two_runtimes_cannot_disagree_about_whitespace():
    """Python's ``\\s`` and ECMAScript's ``\\s`` are different sets.

    Python matches U+001C-U+001F and U+0085; JavaScript does not. JavaScript
    matches U+FEFF; Python does not. Left to a bare ``\\s+`` collapse that is a
    cross-tier divergence in the one function whose entire purpose is not to
    have one (codex adversarial review), so everything whitespace-ish except
    ``\\n`` is folded to U+0020 before any of it is consulted.
    """
    assert strip_markdown("alpha\u0085beta\u00a0gamma\ufeffdelta") == (
        "alpha beta gamma delta"
    )


def test_zero_width_joiners_are_meaning_not_noise():
    """Stripping ZWJ splits one emoji into two and reshapes Persian/Indic."""
    assert strip_markdown("Built by \U0001f469\u200d\U0001f4bb here.") == (
        "Built by \U0001f469\u200d\U0001f4bb here."
    )


def test_a_comparison_is_not_an_html_tag():
    """`<[^>]*>` -- and Django's ``strip_tags`` -- both ate this."""
    assert strip_markdown("latency < 200 and rate > 5") == (
        "latency < 200 and rate > 5"
    )
    # …but a tag spanning a newline still is one.
    assert strip_markdown('<img\n  src="/x.png">After.') == "After."
    assert strip_markdown("<!-- note -->Visible.") == "Visible."


def test_both_tiers_read_the_same_source_window():
    """The parity gap one layer ABOVE the rules (codex adversarial review).

    Django never holds more than ``CARD_BODY_CHARS`` of ``content``; the
    SvelteKit caller holds the whole article. Feeding the same function two
    different windows reproduces exactly the divergence this module removes,
    so the clamp lives inside the derivation and both callers are bounded by
    it. The assertion below is the one that would break if someone shrank the
    Django excerpt: a card built from LESS text than SSR reads is drift again.
    """
    assert crawler.CARD_BODY_CHARS >= DESCRIPTION_SOURCE_CHARS
    body = "```\n" + ("x" * 5000) + "\n```\n\nVisible prose after it."
    # The full article and the Django excerpt derive the same string.
    assert compact_text(body, "Fallback.") == compact_text(
        body[:crawler.CARD_BODY_CHARS], "Fallback.",
    ) == "Fallback."


def test_only_a_line_anchored_fence_opens_a_code_block():
    """An inline run of backticks is prose the renderer shows.

    Unanchored, `Type ``` to open a block` reads as an unterminated fence and
    deletes everything after it -- and in a 4,000-character excerpt that is
    the whole rest of the description (codex adversarial review).
    """
    assert strip_markdown("Type ``` to open a block, then continue.") == (
        "Type to open a block, then continue."
    )
    assert strip_markdown("Intro.\n\n```js\nconst x = 1;") == "Intro."


def test_a_closing_fence_must_be_at_least_as_long_as_its_opener():
    """CommonMark's rule, and ``markdown.ts``'s.

    With a fixed ``` pattern the literal ``` line inside a four-backtick block
    reads as the close and the real close reads as a fresh unterminated opener
    -- so the card publishes code from inside the block and deletes the prose
    after it, while the rendered article shows the opposite.
    """
    body = (
        "````md\ninside\n```\nstill inside\n````\n\nThe real prose."
    )
    assert strip_markdown(body) == "The real prose."
    # And an UNTERMINATED four-backtick block is not closed by the ``` inside
    # it either -- the info string must exclude backticks or the capture
    # backtracks to three (codex adversarial review).
    assert strip_markdown(
        "Intro sentence.\n\n````md\ncode\n```\nmore code, no close"
    ) == "Intro sentence."


def test_case_insensitivity_is_ascii_only_in_both_runtimes():
    """Python's Unicode IGNORECASE folds U+0130 onto `i`; JS's `/i` does not.

    Without `re.A` the Django tier would treat `::\u0130frame[x]` as markup and
    fall back, while SvelteKit rendered the literal line -- one more version of
    the same split (codex adversarial review).
    """
    assert strip_markdown("::\u0130frame[/x.mp4] here.") == (
        "::\u0130frame[/x.mp4] here."
    )
    assert strip_markdown("::IFRAME[/x.mp4]") == ""


def test_digit_classes_are_ascii_only_in_both_runtimes():
    """Python's ``\\d`` matches Unicode digits; JavaScript's does not.

    An Arabic article opening ``\u0661....`` would lose its numbering on this
    tier and keep it on SvelteKit (codex adversarial review), so both spell the
    class ``[0-9]``.
    """
    assert strip_markdown("\u0661. \u0645\u0642\u062f\u0645\u0629") == (
        "\u0661. \u0645\u0642\u062f\u0645\u0629"
    )
    assert strip_markdown("1. ASCII item") == "ASCII item"


def test_headings_are_line_anchored_so_hashtags_survive():
    assert strip_markdown("# Maps") == "Maps"
    assert strip_markdown("Filed under #zcash") == "Filed under #zcash"


def test_truncation_counts_code_points_not_utf16_units():
    """An astral emoji costs one, matching Python's own ``len``.

    ``String.prototype.length`` in JavaScript would call this 305 and truncate;
    the JS implementation works over ``Array.from`` for exactly this reason. If
    the two disagreed here, the two tiers would cut the same string in
    different places.
    """
    text = "\U0001f642" * 150 + " tail"
    assert len(text) == 155
    assert truncate(text) == text


def test_truncation_keeps_the_ellipsis_inside_the_budget():
    text = "word " * 200
    result = truncate(strip_markdown(text))
    assert len(result) <= META_DESCRIPTION_CHARS
    assert result.endswith("…")
    assert not result.endswith(" …")


def test_a_single_oversized_token_is_cut_rather_than_erased():
    """Without the word-boundary floor this would return just an ellipsis."""
    result = truncate("x" * 400)
    assert len(result) == META_DESCRIPTION_CHARS
    assert result == "x" * (META_DESCRIPTION_CHARS - 1) + "…"


def test_an_empty_derivation_falls_back():
    assert compact_text("   \n\n  ", "Fallback.") == "Fallback."
    # `value ?? fallback` on the JS side skipped this: an empty string is not
    # nullish, so a creator with no bio got an EMPTY meta description.
    assert compact_text("", "Fallback.") == "Fallback."
    assert compact_text(None, "Fallback.") == "Fallback."


# --- the view actually uses it ---------------------------------------------


@pytest.mark.django_db
def test_the_card_view_derives_the_description_through_the_shared_rules(
    client, creator_factory,
):
    """A heading and embed render a plain description through the database view."""
    creator = creator_factory()
    page = _page(
        creator,
        title="Maps",
        description="",
        content="# Maps\n\n\n\n::embed[/uploadz/public/example/clip.mp4]",
    )

    html = client.get(
        f"/{creator.username}/{page.vanity}", HTTP_HOST=HOST,
    ).content.decode()

    description = _meta(html, "description")
    assert description == "Maps"
    assert "::embed" not in html.split("<body>")[0]
    assert "#" not in description


@pytest.mark.django_db
def test_the_card_view_compacts_a_creator_written_description(
    client, creator_factory,
):
    """A stored description is not exempt.

    It is a 255-character free-text field; it can hold newlines and markdown,
    and a newline inside an HTML attribute is a defect whoever typed it. SSR
    has always compacted it, so returning it raw here was itself drift.
    """
    creator = creator_factory()
    page = _page(
        creator,
        description="**Bold** intro.\n\nSecond paragraph.",
        content="Body copy that must not be used.",
    )

    html = client.get(
        f"/{creator.username}/{page.vanity}", HTTP_HOST=HOST,
    ).content.decode()

    assert _meta(html, "description") == "Bold intro. Second paragraph."


@pytest.mark.django_db
def test_the_card_view_never_exceeds_the_shared_bound(
    client, creator_factory,
):
    """300 characters used to reach the attribute; 200 is the shared bound."""
    creator = creator_factory()
    page = _page(creator, description="", content="banana " * 400)

    html = client.get(
        f"/{creator.username}/{page.vanity}", HTTP_HOST=HOST,
    ).content.decode()

    description = _meta(html, "description")
    assert len(description) <= META_DESCRIPTION_CHARS
    assert description.endswith("…")


@pytest.mark.django_db
def test_a_subscriber_only_card_still_refuses_the_body(
    client, creator_factory,
):
    """The paywall rule is untouched by the derivation change."""
    creator = creator_factory()
    page = _page(
        creator,
        description="",
        content="Paywalled body copy that must never be published.",
        is_subscriber_only=True,
    )

    html = client.get(
        f"/{creator.username}/{page.vanity}", HTTP_HOST=HOST,
    ).content.decode()

    assert "Paywalled" not in html
    assert _meta(html, "description") == (
        "This page is available to subscribers on Free2Z."
    )


@pytest.mark.django_db
def test_a_body_that_is_only_an_embed_falls_back(client, creator_factory):
    """An embed-only page uses the fallback description."""
    creator = creator_factory()
    page = _page(
        creator,
        title="Zcash 9th birthday call",
        description="",
        content="::embed[https://youtu.be/abc_DEFgh12?si=sample_under_score]",
    )

    html = client.get(
        f"/{creator.username}/{page.vanity}", HTTP_HOST=HOST,
    ).content.decode()

    description = _meta(html, "description")
    assert description == crawler.ARTICLE_DESCRIPTION_FALLBACK
    assert "::embed" not in description
    # And the URL is not silently corrupted anywhere it IS kept.
    assert strip_markdown(
        "Watch https://youtu.be/abc_DEFgh12?si=sample_under_score now."
    ) == "Watch https://youtu.be/abc_DEFgh12?si=sample_under_score now."


def test_the_two_tiers_state_the_same_fallback_copy():
    """This tier cannot translate, so it mirrors the SvelteKit SOURCE string.

    Reads the TypeScript file rather than trusting a comment: the identical
    guarantee for `NOINDEX_FOLLOW` is pinned from the JS side by
    ts/svelte/free2z/tests/live-route-seo.test.mjs, and a copy change on one
    tier that silently diverges the two cards is exactly the  shape.
    """
    meta_ts = (
        pathlib.Path(__file__).parents[5]
        / "ts/svelte/free2z/src/lib/meta.ts"
    ).read_text()
    assert f'"{crawler.ARTICLE_DESCRIPTION_FALLBACK}"' in meta_ts
    assert f'"{crawler.SUBSCRIBER_ONLY_DESCRIPTION}"' in meta_ts
