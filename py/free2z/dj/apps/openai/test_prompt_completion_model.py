"""The single-prompt OpenAI text calls run on a supported model.

OpenAI retired ``gpt-3.5-turbo-instruct`` on 2026-09-28. Three call sites
hard-coded it on the legacy Completions API -- search summaries
(``search.index_zpage``), storytime pages and the flat-priced
``/api/openai/prompt`` -- and every ``search.index_zpage`` job has failed with
``404 model_not_found`` since. They now share one setting
(``PROMPT_COMPLETION_MODEL``) and one helper (``complete_prompt``) on Chat
Completions.

No test here calls a real provider. The fakes expose ONLY
``client.chat.completions``: a fake that also answered ``client.completions``
would let a call site keep using the retired API and stay green.

``test_no_module_uses_the_legacy_completions_api`` is the tripwire for the
next copy-paste of the old call; ``test_the_scanner_flags_every_legacy_shape``
is its negative control.
"""
import ast
from decimal import Decimal
from pathlib import Path
import re
import uuid
import warnings

import pytest
import tiktoken
import tiktoken.model
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator
from dj.apps.storytime.models import Story
from f2z.ai import providers
from utils.warm_tiktoken_cache import REQUIRED_ENCODINGS

PY_DIR = Path(__file__).resolve().parents[3]
RETIRED_MODEL = "gpt-3.5-turbo-instruct"

#Every OpenAI model family that is retired or on OpenAI's deprecation list,
#matched against WHOLE string literals (a docstring that mentions one is
#prose, not a model id).  banned only ``gpt-3.5-turbo-instruct``, and
#``describe_zpage_listener`` kept calling ``gpt-3.5-turbo`` with nothing to
#notice. ``text-embedding-ada-002`` is not retired and does not match.
RETIRED_MODEL_RE = re.compile(
    r"(?i:gpt-3\.5-turbo.*"
    r"|(?:text|code)-(?:davinci|curie|babbage|ada)-.*"
    r"|gpt-4-32k.*|gpt-4-0314|gpt-4-vision-preview)"
)

#The ONLY sanctioned non-test uses of a retired model name, keyed by
#(module, symbol). For a function the name is exempt ONLY as one of its
#parameter defaults; for a module-level variable, ONLY inside the value
#assigned to it. ``test_the_retired_name_allowlist_is_not_stale`` fails when
#an entry stops matching, so an exemption cannot outlive its reason.
RETIRED_NAME_ALLOWLIST = {
    # Tokenizer defaults. ``tiktoken.encoding_for_model("gpt-3.5-turbo")`` is
    # a local table lookup (``cl100k_base``) that never reaches a provider,
    # and translation settlement is pinned to those token counts, so changing
    # them would be a pricing change, not a model migration.
    ("dj/apps/openai/models.py", "_get_encoding"),
    ("dj/apps/openai/models.py", "num_tokens_from_text"),
    ("dj/apps/openai/models.py", "num_tokens_from_messages"),
    # The list of models the seed command RETIRES from the picker
    # (is_ga=False). Naming the model is how it gets switched off.
    ("dj/apps/openai/management/commands/seed_ai_models.py", "RETIRED"),
}


class _Reply:
    def __init__(self, content):
        message = type("Message", (), {"content": content})()
        self.choices = [type("Choice", (), {"message": message})()]


def _chat_only_client(calls, content="generated"):
    class Completions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return _Reply(content)

    class Chat:
        completions = Completions()

    class Client:
        chat = Chat()

    return Client()


# --------------------------------------------------------------------------- #
# The helper and the setting
# --------------------------------------------------------------------------- #
def test_complete_prompt_sends_one_user_message_on_the_prompt_model(settings):
    settings.PROMPT_COMPLETION_MODEL = "gpt-4o-mini"
    calls = []

    text = providers.complete_prompt(
        _chat_only_client(calls), "Tell me a story.", max_tokens=42,
        temperature=0.5,
    )

    assert text == "generated"
    assert calls == [{
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Tell me a story."}],
        "max_completion_tokens": 42,
        "temperature": 0.5,
    }]


def test_complete_prompt_omits_temperature_it_was_not_given():
    calls = []
    providers.complete_prompt(_chat_only_client(calls), "p", max_tokens=1)
    assert "temperature" not in calls[0]


@pytest.mark.parametrize("content", [None, "", "  \n"])
def test_complete_prompt_refuses_a_reply_with_no_text(content):
    """A refusal (``content=None``) or a reasoning model that spent the whole
    budget must not come back as a deliverable: two callers charge 2Z on it
    and search would embed it (codex review, )."""
    with pytest.raises(providers.EmptyCompletion):
        providers.complete_prompt(
            _chat_only_client([], content=content), "p", max_tokens=1)


def test_prompt_model_default_is_supported_and_not_the_retired_one(settings):
    del settings.PROMPT_COMPLETION_MODEL
    assert providers.prompt_completion_model() == "gpt-4o-mini"
    assert providers.DEFAULT_PROMPT_COMPLETION_MODEL != RETIRED_MODEL


def test_prompt_model_follows_the_setting(settings):
    settings.PROMPT_COMPLETION_MODEL = "gpt-5.6-luna"
    assert providers.prompt_completion_model() == "gpt-5.6-luna"


def test_a_blank_prompt_model_setting_falls_back_to_the_default(settings):
    settings.PROMPT_COMPLETION_MODEL = "  "
    assert providers.prompt_completion_model() == "gpt-4o-mini"


def test_truncation_encoding_is_the_default_models_and_is_baked_in():
    """``truncate_text`` counts in ``PROMPT_COMPLETION_ENCODING``: it must be
    what the default model actually uses, and a vocabulary the image bakes in
     -- otherwise the first index job on a fresh pod downloads it."""
    assert tiktoken.model.encoding_name_for_model(
        providers.DEFAULT_PROMPT_COMPLETION_MODEL
    ) == providers.PROMPT_COMPLETION_ENCODING
    assert providers.PROMPT_COMPLETION_ENCODING in REQUIRED_ENCODINGS


def test_truncate_text_counts_in_the_prompt_encoding():
    from dj.apps.search.helpers import truncate_text

    encoding = tiktoken.get_encoding(providers.PROMPT_COMPLETION_ENCODING)
    text = "search indexing works again " * 50
    out = truncate_text(text, 10)
    assert len(encoding.encode(out)) == 10
    assert text.startswith(out)


# --------------------------------------------------------------------------- #
# Storytime -- the call site with no other coverage
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_storytime_page_uses_chat_completions_and_charges_1_2z(
        creator_factory, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "dj.apps.storytime.views.oai_client",
        _chat_only_client(calls, content="Once upon a time."),
    )
    user = creator_factory(tuzis=Decimal("5"))
    story = Story.objects.create(creator=user, title="A tale")
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))

    response = client.post(
        f"/api/storytime/{story.slug}/text", {"prompt": "Begin."},
        format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 200, response.content
    assert calls == [{
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Begin."}],
        "max_completion_tokens": 3072,
        "temperature": 0.5,
    }]
    page = story.pages.get()
    assert page.content == "Once upon a time."
    assert Creator.objects.get(pk=user.pk).tuzis == Decimal("4")


class _Scripted:
    """A chat-only client answering from a script: empty first, then text."""

    def __init__(self, *contents):
        self.contents = list(contents)
        outer = self

        class Completions:
            def create(self, **kwargs):
                return _Reply(outer.contents.pop(0))

        self.chat = type("Chat", (), {"completions": Completions()})()


@pytest.mark.django_db
def test_storytime_empty_reply_charges_nothing_and_releases_the_key(
        creator_factory, monkeypatch, caplog, settings):
    settings.PROMPT_COMPLETION_MODEL = "gpt-4o-mini"
    monkeypatch.setattr(
        "dj.apps.storytime.views.oai_client", _Scripted(None, "Later."))
    user = creator_factory(tuzis=Decimal("5"))
    story = Story.objects.create(creator=user, title="A tale")
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    key = str(uuid.uuid4())

    def post():
        return client.post(
            f"/api/storytime/{story.slug}/text", {"prompt": "Begin."},
            format="json", HTTP_IDEMPOTENCY_KEY=key,
        )

    with caplog.at_level("ERROR", logger="dj.apps.storytime.views"):
        first = post()
    assert first.status_code == 503, first.content
    assert not story.pages.exists()
    assert Creator.objects.get(pk=user.pk).tuzis == Decimal("5")
    # Logged like /api/openai/prompt's empty reply, not a silent 503.
    [record] = [r for r in caplog.records
                if r.name == "dj.apps.storytime.views"]
    assert record.getMessage() == "AI generation failed for gpt-4o-mini"
    assert record.exc_info and record.exc_info[0] is providers.EmptyCompletion

    # The same key is usable again: the claim was released, not kept pending.
    second = post()
    assert second.status_code == 200, second.content
    assert story.pages.get().content == "Later."
    assert Creator.objects.get(pk=user.pk).tuzis == Decimal("4")


@pytest.mark.django_db
def test_legacy_prompt_empty_reply_charges_nothing_and_releases_the_key(
        creator_factory, monkeypatch):
    monkeypatch.setattr(
        "dj.apps.openai.views.oai_client", _Scripted("", "answer"))
    user = creator_factory(tuzis=Decimal("5"))
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    key = str(uuid.uuid4())

    def post():
        return client.post(
            "/api/openai/prompt", {"prompt": "hi"}, format="json",
            HTTP_IDEMPOTENCY_KEY=key,
        )

    first = post()
    assert first.status_code == 503, first.content
    assert Creator.objects.get(pk=user.pk).tuzis == Decimal("5")

    second = post()
    assert second.status_code == 200, second.content
    assert second.data == "answer"
    assert Creator.objects.get(pk=user.pk).tuzis == Decimal("4")


def test_search_summary_refuses_to_embed_an_empty_reply(mocker):
    """The job must fail (and retry) rather than index an empty summary."""
    from dj.apps.search import helpers
    from dj.apps.search.models import PageContext

    mocker.patch.object(
        helpers, "get_openai_client", return_value=_Scripted(None))
    with pytest.raises(providers.EmptyCompletion):
        helpers.generate_summary(PageContext(
            title="t", content="c", author="a", tags=[]))


# --------------------------------------------------------------------------- #
# Flat-priced callers bound their INPUT before any provider spend
# --------------------------------------------------------------------------- #
# gpt-4o-mini accepts 128k tokens; gpt-3.5-turbo-instruct accepted 4,096, which
# is what used to bound a 1 2Z call's provider cost (codex review, round 2).
def _tokens(n):
    """A prompt of exactly ``n`` tokens in the prompt encoding."""
    encoding = tiktoken.get_encoding(providers.PROMPT_COMPLETION_ENCODING)
    text = encoding.decode(encoding.encode(" hello" * (n + 10))[:n])
    assert providers.prompt_token_count(text) == n
    return text


@pytest.mark.parametrize("path, budget", [
    ("/api/openai/prompt", 200),
    ("/api/storytime/{slug}/text", 1024),
])
@pytest.mark.django_db
def test_flat_priced_prompt_over_the_old_context_is_refused_free(
        creator_factory, monkeypatch, path, budget):
    calls = []
    fake = _chat_only_client(calls, content="ok")
    monkeypatch.setattr("dj.apps.openai.views.oai_client", fake)
    monkeypatch.setattr("dj.apps.storytime.views.oai_client", fake)
    user = creator_factory(tuzis=Decimal("5"))
    story = Story.objects.create(creator=user, title="A tale")
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    url = path.format(slug=story.slug)

    def post(prompt):
        return client.post(url, {"prompt": prompt}, format="json",
                           HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))

    if path == "/api/openai/prompt":
        over_budget = _tokens(budget + 1)
    else:
        # Storytime refuses a prompt longer than its 512-char column first,
        # so reach the token check with characters that cost three tokens
        # each: 342 characters, 1,026 tokens.
        over_budget = "\ua66e" * 342
        assert len(over_budget) <= 512
        assert providers.prompt_token_count(over_budget) > budget
    over = post(over_budget)
    assert over.status_code == 400, over.content
    assert "too long" in str(over.data)
    assert calls == []
    assert Creator.objects.get(pk=user.pk).tuzis == Decimal("5")

    # Storytime also persists the prompt in a 512-char column, so its
    # at-the-limit case is exercised with the legacy endpoint only.
    if path == "/api/openai/prompt":
        at = post(_tokens(budget))
        assert at.status_code == 200, at.content
        assert len(calls) == 1


@pytest.mark.django_db
def test_a_prompt_containing_a_special_token_string_is_ordinary_text(
        creator_factory, monkeypatch):
    """``<|endoftext|>`` typed by a user must not 500 the token count."""
    calls = []
    monkeypatch.setattr(
        "dj.apps.openai.views.oai_client", _chat_only_client(calls, "ok"))
    user = creator_factory(tuzis=Decimal("5"))
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))

    response = client.post(
        "/api/openai/prompt", {"prompt": "Explain <|endoftext|>"},
        format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 200, response.content
    assert calls[0]["messages"][0]["content"] == "Explain <|endoftext|>"


def test_truncate_text_accepts_a_special_token_string():
    from dj.apps.search.helpers import truncate_text

    assert truncate_text("about <|endoftext|> markers", 100) == (
        "about <|endoftext|> markers")


def test_flat_price_budgets_match_the_retired_models_context():
    from dj.apps.openai.views import LEGACY_MAX_TOKENS
    from dj.apps.storytime.views import STORYTIME_MAX_TOKENS

    assert providers.FLAT_PRICE_CONTEXT_TOKENS - LEGACY_MAX_TOKENS == 200
    assert providers.FLAT_PRICE_CONTEXT_TOKENS - STORYTIME_MAX_TOKENS == 1024



# --------------------------------------------------------------------------- #
# Tripwire: nothing under py/ may go back to the legacy Completions API or
# name a retired model
# --------------------------------------------------------------------------- #
def _exempt_nodes(tree, exempt_symbols):
    """``id()`` of each constant a symbol in ``exempt_symbols`` may hold: a
    named function's parameter defaults, or anything inside the value of a
    MODULE-LEVEL assignment to a named variable. Nothing else -- a call inside
    an exempt function is still scanned."""
    exempt = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name in exempt_symbols
        ):
            for default in (*node.args.defaults, *node.args.kw_defaults):
                if isinstance(default, ast.Constant):
                    exempt.add(id(default))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in exempt_symbols
            for target in node.targets
        ):
            exempt.update(id(sub) for sub in ast.walk(node.value))
    return exempt


def _legacy_uses(source, exempt_symbols=()):
    """``(lineno, what)`` for every legacy-Completions use in ``source``.

    Flags any ``<x>.completions.create(...)`` whose ``<x>`` is not ``chat``
    (``client.chat.completions.create`` is the supported API), and any string
    literal that IS a retired model name (:data:`RETIRED_MODEL_RE`) -- except
    where:func:`_exempt_nodes` allows it for a symbol in ``exempt_symbols``.
    """
    found = []
    with warnings.catch_warnings():
        # Pre-existing invalid escapes elsewhere in the tree are not this
        # test's business.
        warnings.simplefilter("ignore", SyntaxWarning)
        tree = ast.parse(source)
    exempt = _exempt_nodes(tree, exempt_symbols)
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "create"
            and isinstance(node.func.value, ast.Attribute)
            and node.func.value.attr == "completions"
        ):
            owner = node.func.value.value
            owner_name = (
                owner.attr if isinstance(owner, ast.Attribute)
                else owner.id if isinstance(owner, ast.Name) else None
            )
            if owner_name != "chat":
                found.append((node.lineno, "legacy completions.create"))
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and RETIRED_MODEL_RE.fullmatch(node.value.strip())
            and id(node) not in exempt
        ):
            found.append((node.lineno, node.value))
    return sorted(found)


def _exempt_symbols_for(rel):
    return {
        symbol for module, symbol in RETIRED_NAME_ALLOWLIST
        if module == rel.as_posix()
    }


def _non_test_modules():
    for path in sorted(PY_DIR.rglob("*.py")):
        rel = path.relative_to(PY_DIR)
        if any(part in {"migrations", ".venv", "node_modules"}
               for part in rel.parts):
            continue
        if path.name.startswith("test_") or path.name in {"tests.py",
                                                         "conftest.py"}:
            continue
        yield rel, path


def test_no_module_uses_the_legacy_completions_api():
    offenders = [
        f"{rel}:{lineno}: {what}"
        for rel, path in _non_test_modules()
        for lineno, what in _legacy_uses(
            path.read_text(encoding="utf-8"), _exempt_symbols_for(rel))
    ]
    assert not offenders, (
        "legacy Completions API / retired model (#2294, #2314) -- use "
        "f2z.ai.providers.complete_prompt and PROMPT_COMPLETION_MODEL:\n"
        + "\n".join(offenders)
    )


def test_the_retired_name_allowlist_is_not_stale():
    """Each exemption must still exempt something: an entry that matches
    nothing reads as live to whoever adds theirs next to it."""
    for module, symbol in sorted(RETIRED_NAME_ALLOWLIST):
        source = (PY_DIR / module).read_text(encoding="utf-8")
        assert _legacy_uses(source) != _legacy_uses(source, {symbol}), (
            f"{module}:{symbol} no longer holds a retired model name; "
            "delete it from RETIRED_NAME_ALLOWLIST"
        )


def test_the_scanner_flags_every_legacy_shape():
    """Negative control: a clean tree proves nothing unless these are caught."""
    source = '''
oai_client.completions.create(model="x", prompt="p")
get_client().completions.create(model="x", prompt="p")
openai.completions.create(model="x", prompt="p")
self.client.completions.create(prompt="p")
MODEL = "gpt-3.5-turbo-instruct"
client.chat.completions.create(model="ok", messages=[])
openai.chat.completions.create(model="ok", messages=[])
client.chat.completions.create(model="gpt-3.5-turbo", messages=[])
M = {"model": "gpt-3.5-turbo-16k"}
def f(model="text-davinci-003"): pass
X = ("code-davinci-002", "GPT-3.5-Turbo-0613", "gpt-4-32k-0613")
ok = ("text-embedding-ada-002", "gpt-4o-mini", "gpt-4-turbo", "davinci")
"""Prose that mentions gpt-3.5-turbo is not a model id."""
def num_tokens(text, model="gpt-3.5-turbo"): pass
'''
    assert _legacy_uses(source) == [
        (2, "legacy completions.create"),
        (3, "legacy completions.create"),
        (4, "legacy completions.create"),
        (5, "legacy completions.create"),
        (6, "gpt-3.5-turbo-instruct"),
        (9, "gpt-3.5-turbo"),
        (10, "gpt-3.5-turbo-16k"),
        (11, "text-davinci-003"),
        (12, "GPT-3.5-Turbo-0613"),
        (12, "code-davinci-002"),
        (12, "gpt-4-32k-0613"),
        (15, "gpt-3.5-turbo"),
    ]


def test_the_tokenizer_exemption_covers_only_that_functions_default():
    """Negative control for the allowlist: it exempts the named function's
    parameter default and nothing else -- not a call inside that function,
    not another function's default."""
    source = '''
def num_tokens(text, model="gpt-3.5-turbo"):
    client.chat.completions.create(model="gpt-3.5-turbo", messages=[])
def other(model="gpt-3.5-turbo"): pass
RETIRED = [("openai", "gpt-3.5-turbo")]
LINEUP = [("openai", "gpt-3.5-turbo")]
def seed():
    RETIRED = "gpt-3.5-turbo"
'''
    assert _legacy_uses(source, {"num_tokens", "RETIRED"}) == [
        (3, "gpt-3.5-turbo"),
        (4, "gpt-3.5-turbo"),
        (6, "gpt-3.5-turbo"),
        (8, "gpt-3.5-turbo"),
    ]
