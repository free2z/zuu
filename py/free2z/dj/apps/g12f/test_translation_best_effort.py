"""Best-effort delivery of a paid translation.

zPage 4966 -- a Markdown tutorial -- was translated into Bulgarian and
refunded as ``code_identifier_not_preserved`` over
``['**bold**', '**flexibility**', '*really*']``: eleven provider calls and
~28k tokens of a finished translation thrown away, and the creator given
nothing, because a correct translation had translated the English word inside
an emphasis EXAMPLE.

Two fixes are pinned here:

1. **The false positive.** A backticked span that is only a word wrapped in
   emphasis markers is an example of the syntax, not a code identifier --
   while ``**kwargs``, ``*args`` and ``__init__`` stay protected.
2. **The design.** A content-preservation miss is a WARNING on a delivered,
   unpublished draft, billed normally. Only unusable output still fails the
   job, and then a bounded copy of what the model produced is kept on the
   charge record for operators; the creator gets the diagnosis, not the text.

These drive the REAL purchase view and the REAL task against real Postgres with
a fake provider (the  harness), plus the pure ``safety`` functions.
"""
from decimal import Decimal

import pytest

from dj.apps.g12f.models import ZPageTranslation
from dj.apps.g12f.serializers.translate import TranslationWarningSerializer
from dj.apps.g12f.translation import charges, safety, service, settlement

# The  harness. Importing the fixtures registers them here, including the
# two autouse ones (every provider "has a key"; the failure ceilings are out of
# the way).
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


def _terminal_stream(text, model, *, reason=None, token_limit=False):
    """Single-delta test stream with explicit provider terminal metadata."""
    if token_limit:
        reason = "max_tokens" if model.provider == "anthropic" else "length"
    if reason is None:
        reason = "end_turn" if model.provider == "anthropic" else "stop"

    class Stream:
        termination_reason = reason

        def __iter__(self):
            yield text

    return Stream()


# --------------------------------------------------------------------------- #
# 1. The false positive
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "span",
    ["**flexibility**", "*really*", "**bold**", "***x***", "_word_",
     "*don't*", "**well-known**"],
)
def test_a_word_wrapped_in_emphasis_is_an_example_not_an_identifier(span):
    """NEGATIVE CONTROL: make ``is_emphasis_example`` return ``False`` and
    every case here is classified as an identifier again."""
    assert safety.is_emphasis_example(span)
    assert safety.extract_code_identifiers(f"Write `{span}` here.") == set()


@pytest.mark.parametrize(
    "span",
    ["**kwargs", "*args", "__init__", "__dunder__", "*foo_bar*", "**x2**",
     "*get()*", "**bold*", "get_balance()"],
)
def test_code_shaped_spans_stay_identifiers(span):
    """The other side of the line. ``**kwargs``/``*args`` are not wrapped on
    both sides; ``__init__`` is a dunder however much it looks like
    ``__bold__``; anything but letters inside is code-shaped.

    NEGATIVE CONTROL: widen the pattern to ``_{1,3}`` and ``__init__`` and
    ``__dunder__`` go red here.
    """
    assert not safety.is_emphasis_example(span)
    assert safety.extract_code_identifiers(f"Use `{span}` here.") == {span}


def test_the_zpage_4966_spans_no_longer_fail_and_real_code_still_does():
    """The production failure, as a pure function of two strings."""
    source = (
        "Wrap a word in two asterisks, like `**flexibility**`, and it renders "
        "bold; `**bold**` is the classic. One asterisk, like `*really*`, gives "
        "italics. Then call `get_balance()` with `**kwargs`.\n"
    )
    translated = (
        "Envuelve una palabra en dos asteriscos, como `**flexibilidad**`, y se "
        "ve en negrita; `**negrita**` es el clasico. Un asterisco, como "
        "`*realmente*`, da cursiva. Luego llama a `get_balance()` con "
        "`**kwargs`.\n"
    )
    assert safety.find_violations(source, translated) == []
    safety.check_translation(source, translated)

    # Real code in the same document is still protected.
    renamed = translated.replace("`get_balance()`", "`obtener_saldo()`")
    [violation] = safety.find_violations(source, renamed)
    assert violation.code == "code_identifier_not_preserved"
    assert violation.items == ("get_balance()",)


def test_find_violations_reports_every_rule_and_check_translation_the_first():
    """Best effort needs ALL of them: a draft delivered over the first warning
    alone would hide the other two from the creator."""
    source = "Call `get_balance()`. It costs $5. See [^n].\n\n[^n]: Note.\n"
    translated = (
        "Llama a `obtener_saldo()`. Cuesta $6. Ver [^nota].\n\n"
        "[^nota]: Nota. [x](https://new.example/)\n"
    )
    codes = [v.code for v in safety.find_violations(source, translated)]
    assert codes == [
        "url_not_in_source",
        "amount_not_in_source",
        "reference_not_in_source",
        "code_identifier_not_preserved",
    ]
    with pytest.raises(safety.UnsafeTranslation) as exc:
        safety.check_translation(source, translated)
    assert exc.value.code == "url_not_in_source"


def test_warning_entries_are_bounded():
    violation = safety.UnsafeTranslation(
        "code_identifier_not_preserved", "lost some",
        [f"name_{i:03d}" + "x" * 500 for i in range(50)],
    )
    [entry] = charges.warning_entries([violation])
    assert entry["code"] == "code_identifier_not_preserved"
    assert entry["detail"] == "lost some"
    assert len(entry["items"]) == charges.MAX_WARNING_ITEMS
    assert all(
        len(item) == charges.MAX_WARNING_ITEM_CHARS for item in entry["items"]
    )


def test_the_api_contract_names_exactly_the_codes_delivered_as_warnings():
    """``f2z.yaml`` (and so the generated client) enumerates the warning
    codes. A code added to the policy and not to the serializer would reach
    clients as a value their types say cannot happen."""
    choices = set(TranslationWarningSerializer().fields["code"].choices)
    assert choices == set(settlement.DELIVER_WITH_WARNING_CODES)


def test_every_warning_code_still_has_a_failure_classification():
    """Removing a code from ``DELIVER_WITH_WARNING_CODES`` must restore a
    fully specified failure: classified, and never carrying its fragments."""
    for code in settlement.DELIVER_WITH_WARNING_CODES:
        assert code in settlement.FAULT_BY_CODE, code
        assert not settlement.may_carry_fragments(code), code


# --------------------------------------------------------------------------- #
# 2. Delivered with warnings, end to end
# --------------------------------------------------------------------------- #
#The shape of zPage 4966: a tutorial ABOUT Markdown, whose examples are
#backticked emphasis around English words -- and one real identifier.
TUTORIAL = """\
# Plain text won

Markdown is plain text with a few conventions, and that is its whole
`**flexibility**`: wrap a word in two asterisks and it renders strong, so
`**bold**` is the classic example. One asterisk, as in `*really*`, gives you
emphasis instead.

You can still talk about code in the same article: `get_balance()` is a name,
and so is `**kwargs`.

```python
def render(text):
    return text
```
"""

_SPANISH = {
    "flexibility": "flexibilidad",
    "really": "realmente",
    "bold": "negrita",
}


def _translate_words(fragment):
    for english, spanish in _SPANISH.items():
        fragment = fragment.replace(english, spanish)
    return f"[tr] {fragment}"


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_the_zpage_4966_tutorial_is_delivered_with_no_warning(
    creator_factory, monkeypatch
):
    """The production shape: emphasis examples with the word translated.

    NEGATIVE CONTROL: make ``safety.is_emphasis_example`` return ``False`` and
    the job is still delivered (that is the other half of ) but carries a
    ``code_identifier_not_preserved`` warning naming the three spans, so the
    ``warnings == []`` assertion fails.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    before = balance(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(
        service, "stream_chat", Provider(transform=_translate_words)
    )

    assert run_job(response) is True

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert body["warnings"] == []
    assert before - balance(creator) == Decimal(response.data["price"])
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    assert "`**flexibilidad**`" in live.content
    assert "`*realmente*`" in live.content
    assert "`get_balance()`" in live.content
    assert live.is_published is False


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_delivery_with_warnings_is_charged_the_full_quote(
    creator_factory, monkeypatch
):
    """A renamed identifier no longer costs the creator their draft or us the
    provider bill. It is delivered, flagged, and billed like any delivery --
    ``settlement.CHARGE_DELIVERED_WITH_WARNINGS_IN_FULL``.

    NEGATIVE CONTROL: put ``code_identifier_not_preserved`` back into the
    failing set (remove it from ``DELIVER_WITH_WARNING_CODES``) and this job is
    refunded with nothing written.
    """
    assert settlement.CHARGE_DELIVERED_WITH_WARNINGS_IN_FULL is True
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    before = balance(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(
        service, "stream_chat",
        Provider(transform=lambda f: _translate_words(
            f.replace("get_balance()", "obtener_saldo()")
        )),
    )

    assert run_job(response) is True

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert body["refunded"] == "0.000"
    assert body["warnings"] == [{
        "code": "code_identifier_not_preserved",
        "detail": (
            "The translation rewrote or dropped a code identifier: "
            "['get_balance()']"
        ),
        "items": ["get_balance()"],
    }]
    assert before - balance(creator) == Decimal(response.data["price"])
    assert "obtener_saldo()" in ZPageTranslation.objects.get(
        zpage=page, language="es"
    ).content

    # The creator sees it on the status endpoint they already poll.
    status = client_for(creator).get(translate_url(page))
    assert status.status_code == 200
    assert status.data["status"] == "delivered"
    assert status.data["warnings"][0]["items"] == ["get_balance()"]


# --------------------------------------------------------------------------- #
# 3. A hard failure keeps a bounded copy of the output -- for operators. The
#    creator gets the diagnosis, never the text (it could be the product).
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_reply_in_the_wrong_script_refunds_and_keeps_its_output_privately(
    creator_factory, monkeypatch
):
    """Unusable output still fails ( keeps ``wrong_script`` fatal). What
    came back is kept on the record for operators, and the creator is told
    WHY -- never handed the text, which a refund would make free.

    NEGATIVE CONTROL: stop passing ``attempted_output`` from the
    ``TranslationFailed`` branch of ``translate_zpage`` and the
    ``_attempted_output`` assertions fail while the refund assertions stay
    green. Put ``wrong_script`` into ``SHOW_ATTEMPTED_OUTPUT_CODES`` and the
    status endpoint serves it.
    """
    assert settlement.SHOW_ATTEMPTED_OUTPUT_CODES == frozenset()
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    before = balance(creator)
    response = buy(client_for(creator), page, language="ru")
    # Latin text for a Cyrillic target: not a usable Russian draft.
    monkeypatch.setattr(service, "stream_chat", Provider())

    assert run_job(response) is False

    body = record_for(response)
    assert body["status"] == charges.REFUNDED
    assert body["error"] == "wrong_script"
    assert balance(creator) == before
    assert not ZPageTranslation.objects.filter(zpage=page).exists()
    assert body["_attempted_output"].startswith("[tr]")
    assert body["attempted_output_chars"] >= len(body["_attempted_output"])
    assert "attempted_output_preview" not in body

    status = client_for(creator).get(translate_url(page, "ru"))
    assert status.status_code == 200
    assert "_attempted_output" not in status.data
    assert "attempted_output_preview" not in status.data
    assert status.data["attempted_output_chars"] > 0
    assert "Cyrillic" in status.data["error_detail"]


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_code_on_the_allowlist_is_served_to_the_owner_only(
    creator_factory, monkeypatch
):
    """The plumbing that would serve ``attempted_output_preview``, exercised
    by putting a code on the (deliberately empty) allowlist."""
    monkeypatch.setattr(
        settlement, "SHOW_ATTEMPTED_OUTPUT_CODES", frozenset({"wrong_script"})
    )
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    response = buy(client_for(creator), page, language="ru")
    monkeypatch.setattr(service, "stream_chat", Provider())

    run_job(response)

    status = client_for(creator).get(translate_url(page, "ru"))
    assert status.data["attempted_output_preview"].startswith("[tr]")
    assert "_attempted_output" not in status.data
    stranger = creator_factory()
    assert client_for(stranger).get(
        translate_url(page, "ru")
    ).status_code == 404


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_wrong_script_failure_keeps_only_the_wrong_script_replies(
    creator_factory, monkeypatch
):
    """``wrong_script`` judges the replies TOGETHER, so a document can fail it
    while one fragment is a correct Russian translation. What is kept is the
    evidence -- the replies that are themselves in the wrong script.

    NEGATIVE CONTROL: drop ``attempted=...`` from ``_require_target_script``
    (so ``translate_document`` falls back to the assembled document) and the
    Russian sentence appears in the kept output.
    """
    russian = (
        "Это правильный русский перевод первого фрагмента статьи, и он "
        "достаточно длинный, чтобы о нём можно было судить."
    )
    calls = []

    def first_russian_then_english(fragment):
        calls.append(fragment)
        return russian if len(calls) == 1 else f"[tr] {fragment}"

    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    response = buy(client_for(creator), page, language="ru")
    monkeypatch.setattr(
        service, "stream_chat",
        Provider(transform=first_russian_then_english),
    )

    run_job(response)

    body = record_for(response)
    assert body["error"] == "wrong_script"
    assert len(calls) > 1, "the document must have had several fragments"
    assert "[tr]" in body["_attempted_output"]
    assert russian not in body["_attempted_output"]


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_the_kept_output_is_bounded(creator_factory, monkeypatch):
    monkeypatch.setattr(settlement, "ATTEMPTED_OUTPUT_PREVIEW_CHARS", 12)
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    response = buy(client_for(creator), page, language="ru")
    monkeypatch.setattr(service, "stream_chat", Provider())

    run_job(response)

    body = record_for(response)
    assert len(body["_attempted_output"]) == 12
    assert body["attempted_output_chars"] > 12


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_delivery_time_abort_keeps_no_preview(
    creator_factory, monkeypatch
):
    """The output was FINE -- the creator edited the article while it ran.
    Handing it over with the refund would make "edit mid-job" a way to get a
    translation both refunded and delivered."""
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    response = buy(client_for(creator), page)

    def edit_the_article():
        page.content = TUTORIAL + "\n\nA paragraph added mid-job.\n"
        page.save()

    monkeypatch.setattr(
        service, "stream_chat",
        Provider(transform=_translate_words, mutate=edit_the_article),
    )

    assert run_job(response) is False

    body = record_for(response)
    assert body["error"] == "source_changed"
    assert "attempted_output_preview" not in body
    assert "_attempted_output" not in body
    assert "attempted_output_chars" not in body


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_truncation_keeps_the_failing_reply_for_operators_only(
    creator_factory, monkeypatch
):
    """codex adversarial review of this change, findings 3 and 4.

    A refund whose preview is a correct translation is a free translation: an
    article followed by a paragraph engineered to blow the cap translates the
    article, fails late and refunds in full. So a truncation's output is never
    served to the creator. What IS kept, privately, is the reply that hit the
    cap -- the part that went wrong -- rather than the completed fragments
    before it.

    NEGATIVE CONTROL: add ``output_truncated`` to
    ``settlement.SHOW_ATTEMPTED_OUTPUT_CODES`` and the status endpoint serves
    the preview; drop ``attempted=capped_raw`` from ``translate_unit`` and the
    private copy holds the completed prefix, not the runaway reply.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content=TUTORIAL)
    before = balance(creator)
    response = buy(client_for(creator), page)
    # The first fragment translates normally; the next one runs away.
    monkeypatch.setattr(service, "stream_chat", Provider(fail_after=1))

    run_job(response)

    body = record_for(response)
    assert body["error"] == "output_truncated"
    assert balance(creator) == before
    assert "padding padding" in body["_attempted_output"]
    assert not body["_attempted_output"].startswith("[tr]")
    assert "attempted_output_preview" not in body

    status = client_for(creator).get(translate_url(page))
    assert status.status_code == 200
    assert "attempted_output_preview" not in status.data
    assert "_attempted_output" not in status.data


# --------------------------------------------------------------------------- #
# Independent review of
# --------------------------------------------------------------------------- #
def _envelope_cut_off_on(marker):
    """A provider that echoes the envelope and is cut off on ``marker``.

    Every other fragment translates normally. The cut-off reply is the shape a
    dropped stream or an unreported token limit leaves: our own
    ``<fragment id="NONCE">`` opened, a few words, and nothing closing it.
    """
    def stub(model, messages, **kwargs):
        user = messages[1]["content"]
        nonce = user.split('<fragment id="', 1)[1].split('"', 1)[0]
        fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]
        if marker in fragment:
            text = f'<fragment id="{nonce}">\nHola mun'
            token_limit = True
        else:
            text = f"[tr] {fragment}"
            token_limit = False
        return _terminal_stream(text, model, token_limit=token_limit)

    return stub


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_an_unclosed_envelope_is_refunded_as_truncated_not_delivered(
    creator_factory, monkeypatch
):
    """Finding 1 (HIGH): a truncated reply was delivered AND charged.

    ``service._strip_envelope`` leaves an unclosed envelope in place as the
    evidence of truncation, and used to rely on ``markup_not_in_source`` being
    fatal to refuse it.  made that a warning, so the half-translated
    article reached the creator's drafts and was billed in full.
    ``translate_unit`` now asks ``_envelope_unclosed`` itself.

    NEGATIVE CONTROL: make ``service._envelope_unclosed`` return ``False`` and
    this delivers with a ``markup_not_in_source`` warning and charges the full
    price.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(
        creator, content="Hello world. This is the whole article body.\n"
    )
    before = balance(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(service, "stream_chat", _envelope_cut_off_on("Hello world"))

    run_job(response)

    body = record_for(response)
    assert body["status"] != charges.DELIVERED
    assert body["error"] == "output_truncated"
    assert balance(creator) == before, "a truncated reply was charged"
    assert not ZPageTranslation.objects.filter(zpage=page, language="es").exists()


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_closed_envelope_still_delivers_clean(creator_factory, monkeypatch):
    """The control for the test above: same harness, envelope CLOSED.

    Proves the refund above is the missing closing tag and nothing else about
    the stub -- an echoed, closed envelope is our prompt coming back and is
    unwrapped, delivered without a warning, and charged.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(
        creator, content="Hello world. This is the whole article body.\n"
    )
    before = balance(creator)
    response = buy(client_for(creator), page)

    def closed(model, messages, **kwargs):
        user = messages[1]["content"]
        nonce = user.split('<fragment id="', 1)[1].split('"', 1)[0]
        fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]
        return _terminal_stream(
            f'<fragment id="{nonce}">\n[tr] {fragment}\n'
            f'</fragment id="{nonce}">', model,
        )

    monkeypatch.setattr(service, "stream_chat", closed)

    assert run_job(response) is True

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert body["warnings"] == []
    assert before - balance(creator) == Decimal(response.data["price"])
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    assert "fragment" not in live.content


#zPage 4966's own line, verbatim: a tutorial SHOWING link syntax, inside
#inline code, with a placeholder address.
_LINK_EXAMPLE_4966 = (
    "- **Links** look like `[the words you click](https://the-address.com)`.\n"
)
_LINK_EXAMPLE_4966_ES = (
    "- Los **enlaces** se ven así: "
    "`[las palabras en las que haces clic](https://la-direccion.com)`.\n"
)


def test_a_url_changed_only_inside_inline_code_is_fatal():
    """zPage 4966's ``es`` job: the model translated the placeholder address
    inside an inline-code example of link syntax. It is REFUNDED, not
    delivered.

    WHY, since it looks harmless: a ``url_in_code_not_in_source`` warning was
    tried for exactly this line during  and removed in the same PR. The
    regex that decided "inside code" disagreed with the renderer (marked 16 +
    DOMPurify) in at least seven ways -- link titles, the math extension, raw
    HTML, backtick userinfo, a ```` ```~ ```` fence close, a fence in an HTML
    block, a table cell -- and each delivered a RENDERED phishing link as a
    warning . Owner decision: security over
    convenience. ``test_translation_url_bypasses.py`` pins every bypass.

    NEGATIVE CONTROL: add ``url_not_in_source`` to
    ``settlement.DELIVER_WITH_WARNING_CODES`` and the last assertion fails.
    """
    violations = safety.find_violations(
        _LINK_EXAMPLE_4966, _LINK_EXAMPLE_4966_ES
    )
    assert [v.code for v in violations] == ["url_not_in_source"]
    assert list(violations[0].items) == ["https://la-direccion.com"]
    assert not settlement.delivers_with_warning("url_not_in_source")


def test_a_url_changed_only_inside_a_fenced_block_is_fatal():
    """Same rule for a fenced block nested in a list item -- the shape that
    travels inside a translated unit. No code exception, anywhere."""
    source = (
        "1. Configure it:\n\n"
        "   ```yaml\n"
        "   endpoint: https://your-server.example/api\n"
        "   ```\n"
    )
    translated = (
        "1. Configúralo:\n\n"
        "   ```yaml\n"
        "   endpoint: https://tu-servidor.example/api\n"
        "   ```\n"
    )
    violations = safety.find_violations(source, translated)
    assert [v.code for v in violations] == ["url_not_in_source"]
    assert list(violations[0].items) == ["https://tu-servidor.example/api"]


@pytest.mark.parametrize(
    "translated",
    [
        # The example un-backticked: now it IS a link.
        "- Los **enlaces**: [haz clic](https://la-direccion.com).\n",
        # Code example kept, plus a rendered link to the same new address.
        "- `[x](https://la-direccion.com)` y https://la-direccion.com\n",
        # A code span in the DESTINATION position is the href, not code.
        "- [haz clic](`https://la-direccion.com`)\n",
        # An unclosed fence is not code we can vouch for.
        "```\n[haz clic](https://la-direccion.com)\n",
        # codex, on the first version of this fix: ESCAPED backticks are
        # literal characters, so Marked renders the link between them.
        "- \\`[haz clic](https://la-direccion.com)\\`\n",
        # A backtick run is maximal: `` opens a two-backtick span, and one
        # backtick cannot close it -- so this is not code either.
        "- ``[haz clic](https://la-direccion.com)`\n",
        # codex: a fence inside a blockquote ends at the blank line that ends
        # the quote; the link after it is live markdown.
        "> ```\n\n[haz clic](https://la-direccion.com)\n```\n",
        # A fence inside a list item ends when the item does: the unindented
        # link line is a paragraph, not code.
        "- a\n\n  ```\n[haz clic](https://la-direccion.com)\n  ```\n",
        # A backtick fence's info string may not contain a backtick, so this
        # line is not a fence and the next one is not inside one.
        "``` a`b\n[haz clic](https://la-direccion.com)\n```\n",
        # A reference definition's destination is a destination, backticks
        # or not.
        "[r]: `https://la-direccion.com`\n\n[x][r]\n",
    ],
)
def test_a_rewritten_rendered_link_is_still_fatal(translated):
    """Shapes where a regex could think "code" while the renderer makes a
    link. Kept from the removed code-masking round: with no code
    exception they are fatal by construction, and stay pinned so one is never
    reintroduced. The full bypass set is ``test_translation_url_bypasses.py``.
    """
    codes = [
        v.code for v in safety.find_violations(_LINK_EXAMPLE_4966, translated)
    ]
    assert "url_not_in_source" in codes
    assert not settlement.delivers_with_warning("url_not_in_source")


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_the_zpage_4966_link_example_is_refunded(creator_factory, monkeypatch):
    """The live 4966 shape through the worker: refunded in full, nothing
    written, nothing charged. See
    ``test_a_url_changed_only_inside_inline_code_is_fatal`` for why a
    placeholder inside code is not let through .

    NEGATIVE CONTROL: add ``url_not_in_source`` to
    ``settlement.DELIVER_WITH_WARNING_CODES`` and the job is delivered and
    charged.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content="Formatting basics.\n\n" + _LINK_EXAMPLE_4966)
    before = balance(creator)
    response = buy(client_for(creator), page)

    def placeholder_translated(fragment):
        return "[tr] " + fragment.replace(
            "https://the-address.com", "https://la-direccion.com"
        )

    monkeypatch.setattr(
        service, "stream_chat", Provider(transform=placeholder_translated)
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
def test_changed_zip321_amount_is_refunded_without_delivering_a_draft(
    creator_factory, monkeypatch,
):
    """A payment URI amount controls real money and cannot be a warning."""
    creator = creator_factory(tuzis=Decimal("100"))
    address = "u1fugcwe8xceuyvp7t8m3rpk22e0u8m3dyzdh9hdv40zsqpyvac7lxkx5t49nmp4p4w793ngh7fdc0zg7ws7w6gfdcx2rjthss0vhfdwrh"
    second_address = "zs12f4y80pjhy042rmxq339dr6885jqqvh9fc6j8pvxg3hyhc8hmsqurlkqtkzwp03quca27pt0f7k"
    page = make_page(
        creator,
        content=(
            f"Donate: zcash:?address={address}&amount=1.25&"
            f"address.1={second_address}&amount.1=2.5"
        ),
    )
    before = balance(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(
        service,
        "stream_chat",
        Provider(transform=lambda fragment: fragment.replace(
            "amount.1=2.5", "amount.1=250"
        )),
    )

    assert run_job(response) is False

    body = record_for(response)
    assert body["status"] == charges.REFUNDED
    assert body["error"] == "zip321_amount_not_in_source"
    assert not body.get("warnings")
    assert balance(creator) == before
    assert not ZPageTranslation.objects.filter(zpage=page).exists()


# --------------------------------------------------------------------------- #
# Final round of: an envelope in ANY spelling is not a round trip
# --------------------------------------------------------------------------- #
def _nonce_and_fragment(messages):
    user = messages[1]["content"]
    nonce = user.split('<fragment id="', 1)[1].split('"', 1)[0]
    fragment = user.split(">\n", 1)[1].rsplit("\n</fragment", 1)[0]
    return nonce, fragment


#Every one of these is a reply our exact-nonce check (`_envelope_unclosed`)
#cannot see, and every one used to land as a mere `markup_not_in_source`
#WARNING -- a truncated, or unprovably whole, draft delivered and charged.
#The variant is a function of (nonce, fragment) so it carries the real nonce.
_RETYPED_ENVELOPES = {
    "single_quoted_unclosed": lambda n, f: f"<fragment id='{n}'>\nHola mun",
    "bare_unclosed": lambda n, f: "<fragment>\nHola mun",
    "upper_case_unclosed": lambda n, f: f'<FRAGMENT ID="{n}">\nHola mun',
    "spaced_unclosed": lambda n, f: f'< fragment  id = "{n}" >\nHola mun',
    "prefaced_single_quoted": lambda n, f: (
        f"Here is the translation:\n<fragment id='{n}'>\nHola mun"
    ),
    "cut_off_mid_tag": lambda n, f: f'<fragment id="{n[:5]}',
    "single_quoted_closed": lambda n, f: (
        f"<fragment id='{n}'>\n[tr] {f}\n</fragment>"
    ),
    "bare_close_only": lambda n, f: f"[tr] {f[: len(f) // 2]}\n</Fragment>",
}


def _retyped_on(marker, variant):
    """Every attempt at the fragment containing ``marker`` replies ``variant``."""
    def stub(model, messages, **kwargs):
        nonce, fragment = _nonce_and_fragment(messages)
        if marker in fragment:
            text = variant(nonce, fragment)
        else:
            text = f"[tr] {fragment}"
        return _terminal_stream(text, model)

    return stub


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
@pytest.mark.parametrize("shape", sorted(_RETYPED_ENVELOPES))
def test_a_retyped_envelope_is_refunded_never_delivered(
    creator_factory, monkeypatch, shape
):
    """codex review of the security round of, finding 1 (HIGH).

    Through the worker: refunded as ``output_truncated``, nothing charged,
    nothing in the creator's drafts -- for each spelling of the envelope.

    NEGATIVE CONTROL: ``test_the_retyped_envelope_control_delivers_without_the_check``
    below disables ``service._residual_envelope`` and the same reply is
    delivered and charged.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(
        creator, content="Hello world. This is the whole article body.\n"
    )
    before = balance(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(
        service, "stream_chat",
        _retyped_on("Hello world", _RETYPED_ENVELOPES[shape]),
    )

    run_job(response)

    body = record_for(response)
    assert body["status"] == charges.REFUNDED, body
    assert body["error"] == "output_truncated"
    assert balance(creator) == before, "a reply that did not round-trip was charged"
    assert not ZPageTranslation.objects.filter(zpage=page, language="es").exists()


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_the_retyped_envelope_control_delivers_without_the_check(
    creator_factory, monkeypatch
):
    """The negative control, run every time rather than described.

    With ``_residual_envelope`` disabled the single-quoted, cut-off envelope is
    DELIVERED and CHARGED -- the bug. This proves the harness above would see
    the bug if the check went away, so a green parametrized test is the check
    working and not a stub that cannot deliver.
    """
    monkeypatch.setattr(service, "_residual_envelope", lambda *args: False)
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(
        creator, content="Hello world. This is the whole article body.\n"
    )
    before = balance(creator)
    response = buy(client_for(creator), page)
    monkeypatch.setattr(
        service, "stream_chat",
        _retyped_on(
            "Hello world", _RETYPED_ENVELOPES["single_quoted_unclosed"]
        ),
    )

    run_job(response)

    body = record_for(response)
    assert body["status"] == charges.DELIVERED
    assert before - balance(creator) == Decimal(response.data["price"])
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    assert "Hola mun" in live.content


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_an_article_that_contains_a_fragment_tag_still_delivers(
    creator_factory, monkeypatch
):
    """The positive control for the source-relative count.

    An article ABOUT markup may contain ``<fragment>`` itself; its translation
    keeps it, and that is not an echo of our envelope. A rule that counted
    against zero would refund every translation of this page forever. The
    exact-nonce, closed envelope (our prompt coming back) is unwrapped too.
    """
    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(
        creator,
        content="Hello world. Wrap the part in a `<fragment>` element.\n",
    )
    before = balance(creator)
    response = buy(client_for(creator), page)

    def closed(model, messages, **kwargs):
        nonce, fragment = _nonce_and_fragment(messages)
        return _terminal_stream(
            f'<fragment id="{nonce}">\n[tr] {fragment}\n'
            f'</fragment id="{nonce}">', model,
        )

    monkeypatch.setattr(service, "stream_chat", closed)

    assert run_job(response) is True

    body = record_for(response)
    assert body["status"] == charges.DELIVERED, body
    assert before - balance(creator) == Decimal(response.data["price"])
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    assert live.content.count("<fragment>") == 1
    assert "<fragment id=" not in live.content


@pytest.mark.parametrize("token", [
    "<fragment>", "</fragment>", "<fragment id='x'>", "<FRAGMENT>",
    "< fragment", "</ Fragment id=\"x\">", "<fragment/>", "<fragment",
    "<fragment\nid=x>",
])
def test_every_spelling_of_the_envelope_counts(token):
    assert service._residual_envelope(f"text {token} more", "text more")


@pytest.mark.parametrize("token", [
    "<fragments>", "<fragment-list>", "<fragmentary>", "fragment", "&lt;fragment&gt;",
])
def test_other_elements_and_prose_do_not_count(token):
    assert not service._residual_envelope(f"text {token} more", "text more")


# --------------------------------------------------------------------------- #
# Finding 2 (MEDIUM): GENERATION_POLICY_VERSION
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
def test_a_fragment_cached_under_the_previous_policy_is_not_reused(
    creator_factory, monkeypatch
):
    """A fragment carried from BEFORE this deploy never passed the truncation
    rules -- ``translate_unit`` returns a recalled fragment before they run.

    Attempt 1 runs the PREVIOUS pipeline (policy 3, no ``_residual_envelope``):
    paragraph 0 comes back as a cut-off, re-quoted envelope and is cached as
    paid-for work; paragraph 2 then trips the cap and the job is refunded,
    carrying that fragment forward. Attempt 2 runs THIS pipeline and must ask
    the provider for paragraph 0 again rather than recall the half-answer.

    NEGATIVE CONTROL: put ``settlement.GENERATION_POLICY_VERSION`` back to 3
    and paragraph 0 is recalled -- the provider is never asked for it, and the
    document-level round-trip check refunds the purchase instead of delivering.
    """
    from dj.apps.g12f.test_translation_settlement import CHAINED_BODY

    assert settlement.GENERATION_POLICY_VERSION >= 4
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator, content=CHAINED_BODY)
    client = client_for(creator)

    def old_pipeline(model, messages, **kwargs):
        nonce, fragment = _nonce_and_fragment(messages)
        if "Paragraph 0" in fragment:
            text = f"<fragment id='{nonce}'>\nPárrafo 0 cortad"
        elif "Paragraph 2" in fragment:
            text = fragment + ("padding " * 20000)
        else:
            text = f"[tr] {fragment}"
        # Paragraph 0 is deliberately a malformed but normally completed
        # answer: the old policy cached it. Paragraph 2 is the physical
        # runaway response that represents a provider token-limit stop.
        token_limit = "Paragraph 2" in fragment
        return _terminal_stream(text, model, token_limit=token_limit)

    with monkeypatch.context() as before_deploy:
        before_deploy.setattr(settlement, "GENERATION_POLICY_VERSION", 3)
        before_deploy.setattr(service, "_residual_envelope", lambda *a: False)
        before_deploy.setattr(service, "stream_chat", old_pipeline)
        first = buy(client, page)
        run_job(first)
    first_body = record_for(first)
    assert first_body["status"] == charges.REFUNDED
    assert any(
        "Párrafo 0 cortad" in text
        for text in first_body.get("_fragments", {}).values()
    ), "attempt 1 must have cached the half-answer for this test to mean much"

    after_deploy = Provider()
    monkeypatch.setattr(service, "stream_chat", after_deploy)
    second = buy(client, page)

    assert run_job(second) is True

    assert any("Paragraph 0" in f for f in after_deploy.fragments), (
        "a fragment cached under the previous generation policy was recalled"
    )
    assert record_for(second)["status"] == charges.DELIVERED
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    assert "cortad" not in live.content
    assert "fragment" not in live.content


@pytest.mark.django_db
@pytest.mark.parametrize("retry_policy", [4, 5])
def test_policy_four_carried_partial_bypasses_metadata_only_without_policy_bump(
    creator_factory, request, monkeypatch, retry_policy
):
    """Policy 4 can carry a count-only partial; policy 5 must not recall it.

    The old adapter exposed text deltas without the provider's finish reason.
    This stands in for the resulting accepted, below-count partial answer and
    then fails a later fragment so the paid fragment is carried through the
    real charge-record path. The retry is run once with each cache identity:
    policy 4 is the negative control that reuses and delivers the partial,
    while policy 5 asks the provider again and delivers the complete reply.
    """
    from dj.apps.g12f.test_translation_settlement import CHAINED_BODY

    model_row = request.getfixturevalue("ai_model")
    partial = "Párrafo 0 cortado"
    assert settlement.GENERATION_POLICY_VERSION == 5
    creator = creator_factory(tuzis=Decimal("2000"))
    page = make_page(creator, content=CHAINED_BODY)
    client = client_for(creator)
    first_unit = next(
        unit for unit in service.split_units(CHAINED_BODY)
        if unit.kind == service.TRANSLATE
    )

    def policy_four_pipeline(model, messages, **kwargs):
        _nonce, fragment = _nonce_and_fragment(messages)
        if "Paragraph 0" in fragment:
            text = partial
            cap = kwargs["max_output_tokens"]
            # Simulate the provider's actual token-limit stop. The policy-4
            # adapter dropped this reason, and the consumer only saw the text.
            assert service.provider_tokens(model, text) < cap - max(4, cap // 200)
            return _terminal_stream(text, model, token_limit=True)
        elif "Paragraph 2" in fragment:
            text = fragment + ("padding " * 20000)
            return _terminal_stream(text, model, token_limit=True)
        else:
            text = f"[tr] {fragment}"
        return _terminal_stream(text, model)

    with monkeypatch.context() as policy_four:
        policy_four.setattr(settlement, "GENERATION_POLICY_VERSION", 4)
        policy_four.setattr(service, "stream_chat", policy_four_pipeline)
        policy_four.setattr(
            service, "_hit_output_token_limit", lambda *_args: False
        )
        completed = service._completed_termination_reason
        policy_four.setattr(
            service,
            "_completed_termination_reason",
            lambda provider, reason: reason in {
                "length", "max_tokens", "model_context_window_exceeded",
            } or completed(provider, reason),
        )
        first = buy(client, page)
        run_job(first)

    first_body = record_for(first)
    assert first_body["status"] == charges.REFUNDED
    assert partial in first_body["_fragments"].values(), (
        "the policy-4 negative control needs a real carried partial fragment"
    )
    with monkeypatch.context() as policy_four:
        policy_four.setattr(settlement, "GENERATION_POLICY_VERSION", 4)
        old_key = settlement.fragment_key(
            ai_model_id=model_row.pk,
            source_language="en",
            target_language="es",
            context=first_unit.context,
            text=first_unit.text,
        )
    assert first_body["_fragments"].get(old_key) == partial

    with monkeypatch.context() as current_pipeline:
        current_pipeline.setattr(
            settlement, "GENERATION_POLICY_VERSION", retry_policy
        )
        new_key = settlement.fragment_key(
            ai_model_id=model_row.pk,
            source_language="en",
            target_language="es",
            context=first_unit.context,
            text=first_unit.text,
        )
        if retry_policy == 5:
            assert new_key != old_key, "policy 5 must invalidate policy-4 keys"
        provider = Provider()
        current_pipeline.setattr(service, "stream_chat", provider)
        second = buy(client, page)
        assert run_job(second) is True

    assert record_for(second)["status"] == charges.DELIVERED
    live = ZPageTranslation.objects.get(zpage=page, language="es")
    if retry_policy == 4:
        assert not any("Paragraph 0" in fragment for fragment in provider.fragments), (
            "negative control: policy 4 should recall its carried partial fragment"
        )
        assert partial in live.content, (
            "without the policy bump the stale partial should reproduce the bug"
        )
    else:
        assert any("Paragraph 0" in fragment for fragment in provider.fragments), (
            "policy 5 must regenerate rather than reuse a policy-4 fragment"
        )
        assert partial not in live.content


@pytest.mark.django_db
@pytest.mark.usefixtures("ai_model")
@pytest.mark.parametrize("code", ["payment_math_not_verified", "payment_scan_limit"])
def test_unverified_payment_output_is_refunded_without_a_draft(
    creator_factory, monkeypatch, code,
):
    from dj.apps.g12f.test_translation_service import _checksum_prefix_chain

    creator = creator_factory(tuzis=Decimal("100"))
    page = make_page(creator, content="A factual paragraph for translation. " * 100)
    before = balance(creator)
    response = buy(client_for(creator), page)
    payload = (
        r"\(\def\x{nt}\x\)" if code == "payment_math_not_verified"
        else _checksum_prefix_chain(400)
    )
    monkeypatch.setattr(service, "stream_chat", Provider(
        transform=lambda fragment: fragment + "\n\n" + payload,
    ))
    assert run_job(response) is False
    body = record_for(response)
    assert body["status"] == charges.REFUNDED
    assert body["error"] == code
    assert not body.get("warnings")
    assert balance(creator) == before
    assert not ZPageTranslation.objects.filter(zpage=page).exists()
    assert code in settlement.UNTRUSTWORTHY_OUTPUT_CODES
    assert not settlement.delivers_with_warning(code)
