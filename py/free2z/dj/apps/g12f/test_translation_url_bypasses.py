"""The URL invariant has no "it is only code" exception ( security round).

A ``url_in_code_not_in_source`` warning was tried in  so that zPage
4966's translated placeholder address (inside an inline-code example of link
syntax) would be delivered instead of refunded. A verification review showed
the regex that decided "this is code" disagreed with the real renderer
(marked 16 + DOMPurify, ``processMarkdown``) wherever another construct
consumes a backtick first, and each disagreement delivered a RENDERED,
clickable phishing link as a mere warning. The owner's decision: security over
convenience. The downgrade is gone, and a new destination anywhere in the
output is fatal ``url_not_in_source`` again.

The same review found a gap that predates: marked autolinks
`` https://example.com`x`@evil.example/pay `` as ONE link to ``evil.example``,
while the bare-URL regex stopped at the backtick and saw only the source's
``https://example.com``. Quotes, ``)`` and ``]`` split it the same way, and a
bare e-mail address is autolinked to ``mailto:`` without ever being read as a
destination.

Every case lives in ``test_translation_url_bypasses.json``, which
``bin/check-translation-url-oracle.py`` also renders through the real
``processMarkdown`` to confirm which ones produce a link (the differential
oracle; not in CI -- it needs node and ``npm ci``).
"""
import json
import pathlib
from decimal import Decimal

import pytest

from dj.apps.g12f.models import ZPageTranslation
from dj.apps.g12f.serializers.translate import TranslationWarningSerializer
from dj.apps.g12f.translation import charges, safety, service, settlement

# The  harness: the real purchase view and the real task, against real
# Postgres, with a fake provider.
from dj.apps.g12f.test_translation_settlement import (  # noqa: F401
    Provider,
    ai_model,
    balance,
    buy,
    client_for,
    keyed_provider,
    make_page,
    record_for,
    roomy_ceilings,
    run_job,
    translate_url,
)

_FIXTURE = json.loads(
    (pathlib.Path(__file__).parent / "test_translation_url_bypasses.json").read_text()
)
_ZCASH_FIXTURE = json.loads(
    (pathlib.Path(__file__).parent / "test_translation_zcash_bypasses.json").read_text()
)
SOURCE = _FIXTURE["source"]
CASES = {case["name"]: case["output"] for case in _FIXTURE["cases"]}
BENIGN = {case["name"]: case["output"] for case in _FIXTURE["benign"]}


def _codes(source, translated):
    return [v.code for v in safety.find_violations(source, translated)]


def test_the_code_downgrade_is_gone_from_every_table():
    """``url_in_code_not_in_source`` exists nowhere a delivery could reach:
    not a warning, not a fault, not an API enum value.

    NEGATIVE CONTROL: put it back into ``settlement.DELIVER_WITH_WARNING_CODES``
    and this fails.
    """
    assert "url_in_code_not_in_source" not in settlement.DELIVER_WITH_WARNING_CODES
    assert "url_in_code_not_in_source" not in settlement.FAULT_BY_CODE
    choices = set(TranslationWarningSerializer().fields["code"].choices)
    assert "url_in_code_not_in_source" not in choices
    assert "url_not_in_source" not in choices
    assert not settlement.delivers_with_warning("url_not_in_source")
    assert not hasattr(safety, "outside_code")


@pytest.mark.parametrize("name", sorted(CASES))
def test_every_known_bypass_is_fatal(name):
    """Every case, appended to a source that links only ``example.com`` and
    shows ``the-address.com`` in code, is ``url_not_in_source``.

    The named cases are the review's bypasses (link titles, the math
    extension, raw HTML attributes, backtick userinfo in a link / autolink /
    image / bare URL, a fence closed by `` ```~ ``, a fence opener in an HTML
    block, a table cell whose code span crosses ``|``) plus the quote, paren,
    bracket and e-mail forms the oracle found, and the ``glued_*`` forms
    (a URL glued to a preceding word, digit, ``.`` or CJK text) codex found; ``review_corpus_*`` is the
    reviewer's whole probe corpus.

    NEGATIVE CONTROLS (each verified to go red): restore
    ``origin/fix/2347-translation-best-effort@b49347ccc``'s ``safety.py`` and
    the eleven named bypasses plus five corpus cases come back as
    ``url_in_code_not_in_source``; make ``extract_split_url_tokens`` return
    ``set()`` and the four ``bare_url_*_userinfo`` cases are clean; drop the
    ``_BARE_EMAIL`` loop from ``extract_destinations`` and
    ``bare_email_address`` is clean; restore ``ecc4c550b``'s ``safety.py``
    (no ``_GLUED_URL``, look-behind on ``_RENDERER_WIDTH_URL``) and four of
    the ``glued_*`` cases are clean.
    """
    codes = _codes(SOURCE, SOURCE + "\n" + CASES[name] + "\n")
    assert "url_not_in_source" in codes, codes


@pytest.mark.parametrize("name", sorted(BENIGN))
def test_a_faithful_translation_is_still_clean(name):
    """The other side: a translation that keeps every address -- including one
    repeated inside code and inside parentheses -- introduces nothing.
    Without this, "fatal" would be satisfiable by refusing everything."""
    assert _codes(SOURCE, BENIGN[name]) == []


@pytest.mark.parametrize(
    "separator",
    ["\u0085", "\u2028", "\u2029", "\u000b", "\u000c"],
    ids=["next-line", "line-separator", "paragraph-separator", "vertical-tab", "form-feed"],
)
def test_unicode_separators_do_not_create_markdown_fence_exemptions(separator):
    address = _ZCASH_FIXTURE["address"]
    uri = f"zcash:{address}?amount=1**00**"
    fake_fence = f"~~~text{separator}{uri}{separator}~~~"
    fake_indented_block = f"    example\n{separator}\n    {uri}"

    assert safety._stable_zip321_code_ranges(fake_fence) == []
    uri_start = fake_indented_block.index(uri)
    assert all(
        not start <= uri_start < end
        for start, end in safety._stable_zip321_code_ranges(fake_indented_block)
    )


def test_zip321_code_scanner_skips_documents_without_zip_uris(monkeypatch):
    def unexpected_scan(_value):
        pytest.fail("URI-free content should skip literal-code range parsing")

    monkeypatch.setattr(safety, "_stable_literal_code_ranges", unexpected_scan)
    content = ("```text\nexample\n```\n\n" * 6000)

    assert safety._stable_zip321_code_ranges(content) == []
    assert safety._mask_unchanged_code_zip321_uris(content, "translated") == "translated"


def test_the_zpage_4966_placeholder_inside_code_is_fatal_again():
    """zPage 4966's own line: a translated placeholder address inside an
    inline-code example of link syntax. It used to be the reason for the
    downgrade; it is now refunded like any other new destination, because
    "inside code" cannot be decided without the renderer .
    """
    source = "- **Links** look like `[the words you click](https://the-address.com)`.\n"
    translated = (
        "- Los **enlaces** se ven así: "
        "`[las palabras en las que haces clic](https://la-direccion.com)`.\n"
    )
    violations = safety.find_violations(source, translated)
    assert [v.code for v in violations] == ["url_not_in_source"]
    assert list(violations[0].items) == ["https://la-direccion.com"]


@pytest.mark.parametrize(
    "source, translated",
    [
        # A path `@` is not userinfo.
        ("See https://medium.com/@team.", "Mira https://medium.com/@team."),
        # A token the article already contains verbatim may stay.
        (
            "Clone https://user`x`@git.example/repo.",
            "Clona https://user`x`@git.example/repo.",
        ),
        # An address the article already contains may stay, linked or not.
        ("Mail ops@free2z.cash.", "Escribe a [ops](mailto:ops@free2z.cash)."),
    ],
)
def test_the_split_token_and_email_rules_are_output_minus_source(source, translated):
    """The new rules compare output against source like every destination
    rule: what the article already contains, verbatim, may stay."""
    assert "url_not_in_source" not in _codes(source, translated)


def test_a_split_token_is_read_whole():
    assert safety.extract_split_url_tokens(
        "go https://example.com`x`@evil.example/pay now"
    ) == {"https://example.com`x`@evil.example/pay"}
    assert safety.extract_split_url_tokens(
        'go https://example.com"x"@evil.example/pay'
    ) == {'https://example.com"x"@evil.example/pay'}
    # Narrow patterns already read these whole; nothing to add.
    assert safety.extract_split_url_tokens("https://example.com/a?b=c") == set()


# --------------------------------------------------------------------------- #
# Through the worker: refunded, nothing charged, nothing written
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
@pytest.mark.parametrize(
    "name",
    [
        "link_title_backticks",
        "math_display_backticks",
        "userinfo_in_link_destination",
        "bare_url_backtick_userinfo",
    ],
)
def test_a_bypass_is_refunded_by_the_worker(name, creator_factory, monkeypatch):
    """The real purchase and the real task: the provider appends the bypass
    to its translation, and the job is refunded in full with no draft.

    NEGATIVE CONTROL: add ``url_not_in_source`` to
    ``settlement.DELIVER_WITH_WARNING_CODES`` and every case is delivered and
    charged.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=SOURCE)
    before = balance(creator)
    response = buy(client_for(creator), page)
    payload = CASES[name]
    monkeypatch.setattr(
        service, "stream_chat",
        Provider(transform=lambda fragment: f"[tr] {fragment}\n\n{payload}"),
    )

    assert run_job(response) is False

    body = record_for(response)
    assert body["status"] == charges.REFUNDED
    assert body["error"] == "url_not_in_source"
    assert not body.get("warnings")
    assert balance(creator) == before
    assert not ZPageTranslation.objects.filter(zpage=page).exists()


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
@pytest.mark.parametrize(
    "definition",
    [
        '# Example\n[a]: #x "hidden {uri} "',
        '[a]:\n #x "hidden {uri}"',
        '<pre-example>example</pre-example>\n\n[a]: #x "hidden {uri}"',
    ],
    ids=["after-heading", "multiline-destination", "pre-prefix-custom-tag"],
)
def test_hidden_zip321_reference_amount_is_refunded_by_the_worker(
    definition, creator_factory, monkeypatch,
):
    address = _ZCASH_FIXTURE["address"]
    uri = f"zcash:{address}?amount=1**00**"
    prefix = f"Donate {address}.\n\n"
    hidden = definition.format(uri=uri)
    source = prefix + hidden
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=source)
    before = balance(creator)
    response = buy(client_for(creator), page)
    # The body's translation drops the non-rendered definition and shows the
    # same URI as visible text; the title and description are translated
    # unchanged. The source's non-rendered copy is not authority for it.
    monkeypatch.setattr(
        service, "stream_chat",
        Provider(
            transform=lambda fragment: (
                f"[tr] {fragment.replace(hidden, '').rstrip()}\n\n{uri}"
                if hidden in fragment else f"[tr] {fragment}"
            ),
        ),
    )

    assert run_job(response) is False

    body = record_for(response)
    assert body["status"] == charges.REFUNDED
    assert body["error"] == "zip321_amount_not_in_source"
    assert not body.get("warnings")
    assert balance(creator) == before
    assert not ZPageTranslation.objects.filter(zpage=page).exists()
