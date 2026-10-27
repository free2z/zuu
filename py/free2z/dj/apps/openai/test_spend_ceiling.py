"""A chat request must be refused before the provider is called ( §3.1/§3.2).

The hole these tests close, in the order it happened:

1. ``PromptResponseViewSet.create`` admitted anyone holding 100 2Z — a flat
   constant.
2. The provider was called and **we were billed**. On ``gpt-5.6-sol``, whose
   input trim ceiling is 400 000 tokens at $5/M, a single maximally-packed turn
   is ~$2.00 of provider input cost, priced at 300 2Z.
3. ``ledger.debit(user, 300)`` raised ``InsufficientFunds``.
4. The atomic block rolled back, so the ``PromptResponse`` vanished and **the
   user was debited nothing** — a 402 and a free generation, repeatable at the
   global 1200/min throttle because failing costs the attacker nothing.

Two independent things had to be true for that to work, and each gets its own
tests here:

* admission was a constant instead of the maximum charge the selected model can
  produce for the prompt actually assembled;
* ``Conversation.generate`` passed no ``max_output_tokens``, so for openai / xai
  / kimi the reply — and therefore the charge — had no ceiling to compute.
  Anthropic was bounded only by ``ANTHROPIC_MAX_OUTPUT``.

 fixed both, but with a fixed per-model output cap, which is not what the
owner wants: a requester holding the 2Z should get the full length they ask
for. The length of the reply is now named by the request (``max_output_tokens``
in the body) or defaulted to the longest reply the model can give for this
prompt that the requester's 2Z already cover — and admission prices whichever
number that is. Section 5 covers that half.

Real Postgres throughout; only the provider SDK boundary is faked. Nothing here
mocks ``ledger.debit`` — the debit was never the bug.
"""
from decimal import Decimal
import uuid
from io import StringIO

from django.core.management import call_command
from f2z.ai.providers import model_is_retired

import pytest

from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator

from .management.commands.seed_ai_models import (
    DEFAULT_MARKUP, DISABLED_PROVIDERS, LINEUP, django_lineup,
)
from .models import (
    DEFAULT_MAX_RESPONSE_TOKENS, DEFAULT_OUTPUT_TOKEN_RESERVE,
    MIN_REQUEST_OUTPUT_TOKENS, AIModel, Conversation, PromptResponse,
    num_tokens_from_messages,
)


# Historical pricing and context checks retain every originally GA lineup row,
# including retired models. django_lineup() includes the charge overrides used
# by the seed command; changing a price must update its pinned expectations.
# (provider, model, input_price, output_price, max_tokens, output_reserve,
#  max_response_tokens)
SEEDED_PRICED_GA = [
    (provider, model, input_price, output_price, max_tokens, reserve, limit)
    for (provider, model, _display, input_price, output_price, max_tokens,
         reserve, limit, _order, is_ga) in django_lineup()
    if is_ga and provider not in DISABLED_PROVIDERS
]
# Admission applies only to models the seed command makes available. Retired
# rows keep their historical prices but cannot purchase another generation.
SEEDED_AVAILABLE = [
    row for row in SEEDED_PRICED_GA if not model_is_retired(row[0], row[1])
]

# The 2Z a request costs at most when the prompt is EMPTY and the requester
# named no length, i.e. the part of the ceiling contributed by the reserve
# alone. Every seeded model must stay under the 100-2Z product minimum, or a
# user who could start a conversation before cannot now.
MAX_RESERVE_ONLY_CEILING = 100


def _model(provider="openai", model="gpt-5.6-sol", input_price="0.000005",
           output_price="0.00003", max_tokens=400000,
           max_output_tokens=16384, max_response_tokens=128000,
           markup=DEFAULT_MARKUP):
    return AIModel.objects.create(
        provider=provider, model=model, display_name=model,
        system_message="hi", max_tokens=max_tokens,
        max_output_tokens=max_output_tokens,
        max_response_tokens=max_response_tokens,
        input_price=input_price, output_price=output_price, markup=markup,
    )


def _setup(creator_factory, tuzis, ai_model):
    user = creator_factory(tuzis=Decimal(tuzis))
    conversation = Conversation.objects.create(
        user=user, ai_model=ai_model, display_name="c")
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return user, conversation, client


def _post(client, conversation, user_input="hello", max_output_tokens=None):
    body = {"user_input": user_input}
    if max_output_tokens is not None:
        body["max_output_tokens"] = max_output_tokens
    return client.post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        body, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


def balance(user):
    return Creator.objects.get(pk=user.pk).tuzis


@pytest.fixture(autouse=True)
def no_channel_layer(monkeypatch):
    """The live-token WebSocket push is a best-effort side-channel."""
    monkeypatch.setattr(
        "dj.apps.openai.models.get_channel_layer", lambda: None)


@pytest.fixture
def provider_calls(monkeypatch):
    """Record every ``stream_chat`` call and answer with a fixed reply."""
    calls = []

    def fake_stream(ai_model, messages, **kwargs):
        calls.append({"ai_model": ai_model, "messages": messages, **kwargs})
        yield "answer"

    monkeypatch.setattr("f2z.ai.providers.stream_chat", fake_stream)
    return calls


# --------------------------------------------------------------------------- #
# 1. The exploit: admitted, billed, then charged nothing.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_request_over_the_ceiling_is_refused_without_calling_the_provider(
        creator_factory, provider_calls):
    """The whole bug in one test.

    A user parked at exactly the old 100-2Z floor, on the priciest seeded
    model, with a prompt big enough that even a minimum-length reply costs more
    than they hold. Pre-fix: admitted, provider called (we pay), debit refuses,
    rollback, user charged 0. The assertion that matters is
    ``provider_calls == []`` — a 402 alone was never the problem, a 402 *after*
    the provider bill was.
    """
    ai_model = _model()
    user, conversation, client = _setup(creator_factory, "100", ai_model)

    # ~150k input tokens: ceil(150000*0.000005*150) = 113 2Z of prompt alone,
    # before a single token of reply.
    big = "hello " * 150000
    response = _post(client, conversation, user_input=big)

    assert response.status_code == 402, response.content
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert provider_calls == [], (
        "the provider was called for a request that could not be paid for — "
        "that call is billed to us whatever we return to the user (#1033)"
    )
    assert balance(user) == Decimal("100"), "balance moved on a refused request"
    assert not PromptResponse.objects.exists()
    assert Decimal(response.data["cost"]) > 100
    assert Decimal(response.data["balance"]) == Decimal("100")
    assert Decimal(response.data["shortfall"]) == (
        Decimal(response.data["cost"]) - Decimal("100")
    )
    assert response.data["action"] == "ai_chat"


@pytest.mark.django_db
def test_the_refusal_is_stable_under_repetition(creator_factory,
                                                provider_calls):
    """The exploit's value came from repeating it. Repetition must stay free
    for us, not for the attacker: still zero provider calls after ten tries."""
    ai_model = _model()
    user, conversation, client = _setup(creator_factory, "100", ai_model)
    big = "hello " * 150000

    for _ in range(10):
        assert _post(client, conversation, user_input=big).status_code == 402

    assert provider_calls == []
    assert balance(user) == Decimal("100")


# --------------------------------------------------------------------------- #
# 2. Users who can pay are unaffected.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_a_user_who_can_cover_the_ceiling_is_admitted_and_charged(
        creator_factory, provider_calls):
    ai_model = _model()
    user, conversation, client = _setup(creator_factory, "1000", ai_model)

    response = _post(client, conversation)

    assert response.status_code == 200, response.content
    assert len(provider_calls) == 1
    charged = Decimal("1000") - balance(user)
    assert charged > 0, "an admitted request must still be charged"
    # And no more than the ceiling we admitted it against.
    assert charged <= ai_model.get_max_tuzi_price(
        1, provider_calls[0]["max_output_tokens"])


@pytest.mark.django_db
def test_a_short_chat_on_every_seeded_model_still_admits_at_100(
        creator_factory, provider_calls):
    """The no-lockout guarantee, per GA model.

    The pre-existing product minimum is 100 2Z. A request that names no length
    is given the longest reply 100 2Z covers, so the entry bar cannot drift up
    with a price change — but a model whose RESERVE alone costs more than 100
    2Z would still lock a fresh conversation out (there would be no affordable
    length at all on a packed prompt), so pin that too.
    """
    for provider, name, in_p, out_p, max_tok, reserve, limit in SEEDED_AVAILABLE:
        ai_model = _model(provider, name, in_p, out_p, max_tok, reserve, limit)
        reserve_only_ceiling = ai_model.get_max_tuzi_price(0, reserve)
        assert reserve_only_ceiling < MAX_RESERVE_ONLY_CEILING, (
            f"{provider}/{name}: the reserve alone commits "
            f"{reserve_only_ceiling} 2Z, at or over the 100-2Z minimum"
        )
        user, conversation, client = _setup(creator_factory, "100", ai_model)
        assert _post(client, conversation).status_code == 200, (
            f"{provider}/{name} locked out a 100-2Z user on a short prompt")

    assert len(provider_calls) == len(SEEDED_AVAILABLE)


@pytest.mark.django_db
def test_admission_lineup_matches_seeded_availability():
    call_command("seed_ai_models", stdout=StringIO())
    available = {(row[0], row[1]) for row in SEEDED_AVAILABLE}
    assert available == set(AIModel.objects.filter(
        is_enabled=True, is_ga=True).values_list("provider", "model"))
    priced = {(row[0], row[1]) for row in SEEDED_PRICED_GA}
    assert priced - available == {
        ("openai", "gpt-4.1-nano"), ("openai", "o1"),
        ("openai", "o3-mini"), ("openai", "o4-mini"),
    }


@pytest.mark.django_db
@pytest.mark.parametrize("name", ["gpt-4.1-nano", "o1", "o3-mini", "o4-mini"])
@pytest.mark.parametrize("funds", ["100", "1000000"])
@pytest.mark.parametrize("requested", [None, 16384])
def test_retired_priced_models_refuse_even_when_the_user_can_pay(
        name, funds, requested, creator_factory, provider_calls):
    row = next(row for row in SEEDED_PRICED_GA if row[:2] == ("openai", name))
    ai_model = _model(*row)
    # Stale flags or a bulk operator write cannot reopen generation.
    AIModel.objects.filter(pk=ai_model.pk).update(is_enabled=True, is_ga=True)
    user, conversation, client = _setup(creator_factory, funds, ai_model)
    response = _post(client, conversation, max_output_tokens=requested)
    assert response.status_code == 409, response.content
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert provider_calls == []
    assert balance(user) == Decimal(funds)
    assert not PromptResponse.objects.filter(conversation=conversation).exists()


@pytest.mark.django_db
def test_full_context_thresholds_are_what_the_pr_claims(creator_factory):
    """Pin the worst-case admission threshold for every seeded GA model.

    This is the number a requester must hold to send a *maximally packed*
    conversation and still get the reserve's worth of reply. It is documented
    in the PR; pinning it here means a price change or a reserve change that
    moves a threshold has to move this table too, in the same commit, where a
    reviewer sees it.
    """
    # Rate card v3 lineup ( audit, 2026-10-05): official prices, 24 new
    # OpenAI rows, long-context caps (236000 / 172000) -- so a tiered model's
    # "maximally packed" prompt is the capped window, not the provider's.
    # Admission prices every input token at the model's highest cache rate,
    # including Anthropic's documented 1-hour write tier.
    expected = {
        "gpt-4o": 58,
        "gpt-6.1-sol": 107, "gpt-6-astra": 489,
        "gpt-6-sol": 107, "gpt-6-luna": 6,
        "gpt-5.5": 239, "gpt-5.4": 120,
        "gpt-5.6-sol": 280, "gpt-5.6-terra": 112, "gpt-5.6-luna": 12,
        "gpt-5.4-mini": 55, "gpt-5.4-nano": 15, "gpt-5.2": 136, "gpt-5.1": 97,
        "gpt-5": 97, "gpt-5-mini": 20, "gpt-5-nano": 4,
        # gpt-4.1: 128000 window since openai 0030 (gateway fence cap); was 322.
        "gpt-4.1": 46, "gpt-4.1-mini": 65, "gpt-4.1-nano": 17, "gpt-4o-mini": 4,
        "o3": 75, "o4-mini": 42, "o3-mini": 42, "o1": 506,
        "claude-opus-4-8": 319,
        "claude-sonnet-5": 128,  # $2 / $10 since v3; was 105
        "claude-haiku-4-5": 64,
        "grok-4.5": 57,
        "grok-4.3": 34,  # 172000 window since v3; was 50
        # Kimi is flagged off, so `SEEDED_PRICED_GA` no longer yields
        # these two and the loop below never reads them. Kept, not
        # deleted: the rows still exist with their (v3, list) prices.
        "kimi-k3": 130,
        "kimi-k2.6": 41,
    }
    for provider, name, in_p, out_p, max_tok, reserve, limit in SEEDED_PRICED_GA:
        ai_model = AIModel(
            provider=provider, model=name, display_name=name,
            system_message="hi", max_tokens=max_tok,
            max_output_tokens=reserve, max_response_tokens=limit,
            input_price=Decimal(in_p), output_price=Decimal(out_p),
            markup=Decimal(DEFAULT_MARKUP),
        )
        packed = ai_model.get_input_token_budget()
        assert ai_model.get_max_tuzi_price(packed) == expected[name], name


def test_the_prompt_budget_reserves_room_for_an_answer():
    """prompt + reply must fit the model's context window.

    ``max_tokens`` is the TOTAL window on every seeded row, and OpenAI answers
    a 400 when ``prompt + max_completion_tokens`` exceeds it. Packing the
    prompt to the whole window and then requesting more tokens of output would
    503 exactly the conversations mature enough to fill the context — found by
    the codex adversarial review of.

    Note what is reserved: ``max_output_tokens``, NOT the model's full
    output ceiling. Reserving the ceiling would take 112k tokens of memory away
    from every gpt-5.6 conversation to guarantee a length almost nobody asks
    for; the reply is clamped to the remaining window instead.
    """
    for provider, name, in_p, out_p, max_tok, reserve, limit in SEEDED_PRICED_GA:
        ai_model = AIModel(
            provider=provider, model=name, display_name=name,
            system_message="hi", max_tokens=max_tok,
            max_output_tokens=reserve, max_response_tokens=limit,
        )
        budget = ai_model.get_input_token_budget()
        assert budget + ai_model.get_output_token_reserve() <= max_tok, name
        assert budget > 0, name
        # And whatever the prompt actually turns out to be, the request we
        # send fits the window — including the untrimmable-turn case, and
        # including a caller who asks for far more than the model can give.
        for prompt in (0, budget, max_tok - 1, max_tok):
            for requested in (None, 1, 10 ** 6):
                cap = ai_model.get_request_output_cap(prompt, requested)
                assert cap > 0, name
                assert prompt + cap <= max(
                    max_tok, prompt + MIN_REQUEST_OUTPUT_TOKENS), name


@pytest.mark.django_db
def test_a_single_prompt_larger_than_the_budget_does_not_crash(
        creator_factory, provider_calls):
    """The trim loop must terminate on an oversized first turn -- and the
    turn is then REFUSED, not sent.

    ``build_messages`` pops the oldest exchange PAIR each round; with no
    history to drop it used to pop the current turn and then IndexError on the
    next pop, which `_ai_error_response` turned into "this model isn't
    available right now". The loop now stops at the system message plus the
    turn being asked, and the view answers a 400 naming the budget: sending
    the turn with a squeezed output cap (what this test used to pin) would
    bill a long-context-tiered model at the higher tier against the row's
    short-context price ( decision (b); codex review of ).
    """
    ai_model = _model(max_tokens=5000, max_output_tokens=4096,
                      max_response_tokens=4096)
    user, conversation, client = _setup(creator_factory, "1000", ai_model)

    # ~2000 tokens against a budget of 5000 - 4096 = 904, and nothing to trim.
    response = _post(client, conversation, user_input="hello " * 2000)

    assert response.status_code == 400, response.content
    assert "accepts at most 904" in response.data["detail"]
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_the_priced_cap_is_the_cap_that_is_sent(creator_factory,
                                                provider_calls):
    """Admission and the provider request must use the SAME output cap.

    Pricing a longer reply than we ask for over-charges the entry bar; pricing
    a shorter one puts back exactly the gap this whole change closes. Checked
    in the clamped regime, where the two could most easily drift: a prompt
    that FITS the budget (reserve 1024) but leaves less room than the 4096
    ceiling, so the cap is the window's remainder.
    """
    ai_model = _model(max_tokens=5000, max_output_tokens=1024,
                      max_response_tokens=4096)
    _, conversation, client = _setup(creator_factory, "1000", ai_model)

    assert _post(client, conversation,
                 user_input="hello " * 2000).status_code == 200

    call = provider_calls[0]
    prompt_tokens = num_tokens_from_messages(call["messages"])
    assert call["max_output_tokens"] < 4096, "the clamped regime"
    assert prompt_tokens + call["max_output_tokens"] <= 5000
    assert (ai_model.get_request_output_cap(prompt_tokens)
            == call["max_output_tokens"])
    assert (ai_model.get_max_tuzi_price(prompt_tokens)
            >= ai_model.get_tuzi_price(
                prompt_tokens, call["max_output_tokens"]))


# --------------------------------------------------------------------------- #
# 3. The output cap reaches every provider.
# --------------------------------------------------------------------------- #
class _FakeCompletions:
    def __init__(self, sink):
        self.sink = sink

    def create(self, **kwargs):
        self.sink.append(kwargs)

        class _Delta:
            content = "answer"

        class _Choice:
            delta = _Delta()
            finish_reason = "stop"

        class _Chunk:
            choices = [_Choice()]

        return iter([_Chunk()])


class _FakeOpenAICompatibleClient:
    def __init__(self, sink):
        self.chat = type("Chat", (), {"completions": _FakeCompletions(sink)})()


class _FakeAnthropicEvent:
    def __init__(self, type_, text=None, thinking=None, stop_reason=None):
        self.type = type_
        if text is not None:
            self.delta = type(
                "Delta", (), {"type": "text_delta", "text": text})()
        elif thinking is not None:
            # A thinking delta carries no `.text` — it is reasoning, not the
            # answer, and must never be accumulated into the reply.
            self.delta = type(
                "Delta", (), {"type": "thinking_delta", "thinking": thinking})()
        elif stop_reason is not None:
            self.delta = type("Delta", (), {"stop_reason": stop_reason})()
        else:
            self.delta = None


class _FakeAnthropicStream:
    text_stream = ["answer"]

    # What `text_stream` hides and `MessageStream.__iter__` does NOT: the
    # structural events, and above all `thinking_delta` — the reason an
    # Anthropic stream goes quiet for minutes. `ping` is deliberately absent:
    # `anthropic._streaming.Stream.__stream__` drops it before this iterator
    # sees it, and an earlier version of this fake emitted one and produced a
    # false positive (codex adversarial review).
    _events = [
        _FakeAnthropicEvent("message_start"),
        _FakeAnthropicEvent("content_block_start"),
        _FakeAnthropicEvent("content_block_delta", thinking="hmm"),
        _FakeAnthropicEvent("content_block_delta", thinking="still hmm"),
        _FakeAnthropicEvent("content_block_delta", text="answer"),
        _FakeAnthropicEvent("message_delta", stop_reason="end_turn"),
        _FakeAnthropicEvent("message_stop"),
    ]

    def __iter__(self):
        return iter(self._events)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeAnthropicMessages:
    def __init__(self, sink):
        self.sink = sink

    def stream(self, **kwargs):
        self.sink.append(kwargs)
        return _FakeAnthropicStream()


class _FakeAnthropicClient:
    def __init__(self, sink):
        self.messages = _FakeAnthropicMessages(sink)


@pytest.mark.django_db
@pytest.mark.parametrize("provider,model_name,limit,param_names", [
    # OpenAI's current Chat Completions models take `max_completion_tokens`;
    # the other OpenAI-compatible providers still take `max_tokens`.
    # `_create_capped` learns which one works, so accept either — what must
    # never happen is neither.
    ("openai", "gpt-5.6-sol", 16384,
     ("max_completion_tokens", "max_tokens")),
    ("xai", "grok-4.5", 8192, ("max_tokens", "max_completion_tokens")),
    # Kimi is deliberately absent: it is flagged off  and the chat
    # endpoint refuses it with a 409 before the SDK is reached, so this
    # view-level test cannot exercise it. Its transport half -- that Kimi is
    # sent `max_tokens` rather than `max_completion_tokens` -- still has
    # direct coverage in `test_language_detection.py`'s `_create_capped`
    # tests. Restore this row when the flag flips back.
    ("anthropic", "claude-opus-4-8", 8192, ("max_tokens",)),
])
def test_every_provider_receives_the_output_cap(
        creator_factory, monkeypatch, provider, model_name, limit,
        param_names):
    """Asserted per provider, at the SDK boundary, through the real view.

    Before  ``Conversation.generate`` called ``stream_chat`` with no
    ``max_output_tokens`` at all, which for the three OpenAI-compatible
    providers meant the provider generated (and billed) without any ceiling —
    closing the stream on our side only stops us reading. A per-provider test
    is the point: an aggregate one passes while three of four are uncapped,
    which is exactly the state this repo was in. Letting the requester name the
    length must not quietly reintroduce "no length".
    """
    sink = []
    if provider == "anthropic":
        fake = _FakeAnthropicClient(sink)
    else:
        fake = _FakeOpenAICompatibleClient(sink)
    monkeypatch.setattr(
        "f2z.ai.providers.get_client", lambda p: fake)

    ai_model = _model(provider=provider, model=model_name,
                      max_output_tokens=min(limit, 8192),
                      max_response_tokens=limit)
    _, conversation, client = _setup(creator_factory, "100000", ai_model)

    assert _post(client, conversation).status_code == 200

    assert len(sink) == 1, f"{provider}: the SDK was not called exactly once"
    kwargs = sink[0]
    present = [n for n in param_names if n in kwargs]
    assert present, (
        f"{provider}/{model_name}: no output cap reached the SDK — expected "
        f"one of {param_names}, got {sorted(kwargs)}"
    )
    for name in present:
        assert kwargs[name] == limit, (
            f"{provider}/{model_name}: {name}={kwargs[name]!r}, expected "
            f"{limit}"
        )


# --------------------------------------------------------------------------- #
# 4. The cap can never be absent.
# --------------------------------------------------------------------------- #
def test_a_null_limit_never_becomes_no_limit():
    """The column is NOT NULL, so this is belt and braces — deliberately.

    ``stream_chat(max_output_tokens=None)`` IS the pre- behaviour: no
    provider-side ceiling for openai / xai / kimi. The one value that must
    never reach it is ``None``, so assert the guard directly rather than
    relying on a schema constraint staying put.
    """
    ai_model = AIModel(
        provider="openai", model="x", display_name="x", system_message="hi",
        max_tokens=1000000, max_output_tokens=None,
        max_response_tokens=None,
    )
    assert ai_model.get_output_token_reserve() == DEFAULT_OUTPUT_TOKEN_RESERVE
    assert ai_model.get_max_response_tokens() == DEFAULT_MAX_RESPONSE_TOKENS


@pytest.mark.django_db
@pytest.mark.parametrize("stored", [0, -1])
def test_a_missing_limit_falls_back_to_the_conservative_default(
        creator_factory, provider_calls, stored):
    """0 or a negative limit must mean "use the default", never "no limit".

    An operator can type either into the admin. Neither may be allowed to
    reintroduce an uncapped completion, which is what a falsy value passed
    straight through to ``stream_chat`` would do.
    """
    ai_model = _model()
    AIModel.objects.filter(pk=ai_model.pk).update(
        max_output_tokens=stored, max_response_tokens=stored)
    ai_model.refresh_from_db()

    assert ai_model.get_output_token_reserve() == DEFAULT_OUTPUT_TOKEN_RESERVE
    assert ai_model.get_max_response_tokens() == DEFAULT_MAX_RESPONSE_TOKENS

    _, conversation, client = _setup(creator_factory, "100000", ai_model)
    assert _post(client, conversation).status_code == 200
    assert (provider_calls[0]["max_output_tokens"]
            == DEFAULT_MAX_RESPONSE_TOKENS)


@pytest.mark.django_db
def test_the_provider_ceiling_wins_over_a_larger_reserve(
        creator_factory, provider_calls):
    """The ceiling is a fact about the provider; the reserve is our policy.

    An operator setting ``max_response_tokens=4096`` for a model whose real
    output limit is 4096, while the legacy reserve still says 8192, must not
    have 8192 sent to the provider — that is a 400 on every ordinary request,
    surfaced as "this model isn't available right now". Reserving context we
    then decline to use is harmless; exceeding the provider's limit is not.
    Found by the codex adversarial review.
    """
    ai_model = _model(max_output_tokens=8192, max_response_tokens=4096)

    assert ai_model.get_max_response_tokens() == 4096
    assert ai_model.get_output_token_reserve() == 4096

    _, conversation, client = _setup(creator_factory, "1000000", ai_model)
    assert _post(client, conversation).status_code == 200
    assert provider_calls[0]["max_output_tokens"] == 4096


@pytest.mark.django_db
def test_a_fractional_balance_is_floored_not_rounded_into_a_402(
        creator_factory, provider_calls):
    """``Creator.tuzis`` has three decimal places; prices are whole 2Z.

    Solving the affordable length against 100.500 picks a reply whose raw
    price is 100.4985, which ``get_tuzi_price`` ceils to 101 — over the line,
    and the request 402s even though a slightly shorter reply was there for
    the taking. Since the live callers name no length, that is a user who
    simply cannot chat. Found by the codex adversarial review.
    """
    ai_model = _model()
    user, conversation, client = _setup(creator_factory, "100.500", ai_model)

    response = _post(client, conversation)

    assert response.status_code == 200, response.content
    cap = provider_calls[0]["max_output_tokens"]
    prompt_tokens = num_tokens_from_messages(provider_calls[0]["messages"])
    assert ai_model.get_max_tuzi_price(prompt_tokens, cap) <= Decimal("100.500")
    assert balance(user) < Decimal("100.500")


def test_seed_command_and_migration_agree():
    """The two copies of the catalogue are documented as mirrors. Enforce it.

    The migrations seed stage/prod on deploy; the management command is what an
    operator runs by hand. A value that exists in one and not the other is a
    model whose admission threshold differs between environments.
    """
    import importlib

    # A module whose name starts with a digit cannot be imported with `from`.
    limits = importlib.import_module(
        "dj.apps.openai.migrations.0018_user_specified_output_length"
    ).RESPONSE_LIMITS
    reserves = importlib.import_module(
        "dj.apps.openai.migrations.0017_aimodel_max_output_tokens").OUTPUT_CAPS

    # 0018 must not touch `max_output_tokens`: an old pod reads it during the
    # rollout window and after a code rollback, and it means something else
    # there. The values the seed command writes therefore have to still be
    # 0017's, or the two disagree about what an old pod sees.
    lineup_reserves = {
        (provider, model): reserve
        for (provider, model, _display, _in, _out, _max_tokens, reserve,
             _limit, _order, _is_ga) in LINEUP
    }
    lineup_limits = {
        (provider, model): limit
        for (provider, model, _display, _in, _out, _max_tokens, _reserve,
             limit, _order, _is_ga) in LINEUP
    }
    # 0017 / 0018 are the frozen record for the rows that existed then; the
    # rows rate card v3 added (openai.0026) are mirrored by
    # test_lineup_v3_migration.py instead.
    assert reserves == {key: lineup_reserves[key] for key in reserves}
    assert limits == {key: lineup_limits[key] for key in limits}
    assert set(reserves) == set(limits) < set(lineup_reserves)


def test_the_migration_is_add_only_so_a_rolling_deploy_is_safe():
    """Migration 0018 must be INVISIBLE to a pod running the old image.

    Cloud Build runs ``manage.py migrate`` BEFORE the new pods roll, and
    ``prod-healthcheck.sh`` rolls back the image without reversing the data. So
    0018 may add a column the old image never selects, and must not rename or
    rewrite ``max_output_tokens`` -- which the old image reads as BOTH the
    prompt reserve and the mandatory admission ceiling.

    Two earlier drafts of this migration failed exactly here, one by renaming
    and one by raising the value in place (codex adversarial review, rounds 1
    and 2). Assert the shape so a third cannot.
    """
    import importlib

    from django.db import migrations as dj_migrations

    m18 = importlib.import_module(
        "dj.apps.openai.migrations.0018_user_specified_output_length")

    for op in m18.Migration.operations:
        assert not isinstance(
            op, (dj_migrations.RenameField, dj_migrations.RemoveField)
        ), f"{type(op).__name__} is not survivable by a pod on the old image"
        if isinstance(op, dj_migrations.AddField):
            assert op.name == "max_response_tokens"

    # And the data function writes the NEW column only.
    writes = []

    class _Manager:
        def filter(self, **kwargs):
            return self

        def update(self, **kwargs):
            writes.append(set(kwargs))
            return 0

    class _Model:
        objects = _Manager()

    class _Apps:
        def get_model(self, *args, **kwargs):
            return _Model

    m18.set_limits(_Apps(), None)

    assert writes, "the data migration wrote nothing at all"
    for written in writes:
        assert written == {"max_response_tokens"}, (
            f"0018 wrote {sorted(written)}; anything but the new column is "
            f"read by pods still on the old image"
        )


# --------------------------------------------------------------------------- #
# 5. The requester names the length — and pre-covers it (this PR).
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_a_long_reply_is_admitted_only_when_the_2z_cover_it(
        creator_factory, provider_calls):
    """The point of the whole change, in one test.

    64 000 tokens of reply on gpt-5.6-sol is
    ceil(64000 * 0.00003 * 100 * 1.5) = 288 2Z exactly. Ask for it one 2Z
    short and the provider is never called; hold it and the request goes
    through with the full 64 000 asked of the provider.
    """
    ai_model = _model()
    price_of_64k = ai_model.get_tuzi_price(0, 64000)
    assert price_of_64k == 288

    _, poor_conversation, poor_client = _setup(
        creator_factory, str(price_of_64k - 1), ai_model)
    refused = _post(poor_client, poor_conversation, max_output_tokens=64000)
    assert refused.status_code == 402, refused.content
    assert provider_calls == [], "billed for a reply that was not covered"
    assert Decimal(refused.data["cost"]) >= price_of_64k
    assert Decimal(refused.data["shortfall"]) == (
        Decimal(refused.data["cost"]) - Decimal(price_of_64k - 1)
    )
    assert refused.data["action"] == "ai_chat"

    user, conversation, client = _setup(
        creator_factory, str(price_of_64k + 100), ai_model)
    ok = _post(client, conversation, max_output_tokens=64000)
    assert ok.status_code == 200, ok.content
    assert provider_calls[0]["max_output_tokens"] == 64000
    #...and the charge is for what was actually produced, not the ceiling.
    assert balance(user) > Decimal(price_of_64k)


@pytest.mark.django_db
def test_the_default_is_at_least_what_the_fixed_cap_used_to_be(
        creator_factory, provider_calls):
    """'s admission bar was the price of the fixed per-model cap.

    So for every request  would have admitted, the length this branch
    hands the provider by default must be at least that cap — otherwise
    "uncapping" made replies shorter. Checked on every seeded GA model, at the
    2Z  required.
    """
    for provider, name, in_p, out_p, max_tok, reserve, limit in SEEDED_AVAILABLE:
        ai_model = _model(provider, name, in_p, out_p, max_tok, reserve, limit)
        # What  demanded of a user on a short prompt: the price of its
        # fixed cap, which was this model's reserve.
        old_bar = max(100, ai_model.get_max_tuzi_price(0, reserve))
        _, conversation, client = _setup(
            creator_factory, str(old_bar), ai_model)

        assert _post(client, conversation).status_code == 200, name
        sent = provider_calls[-1]["max_output_tokens"]
        assert sent >= reserve, (
            f"{provider}/{name}: default reply length {sent} is SHORTER than "
            f"#1034's fixed cap of {reserve} for a user holding {old_bar} 2Z"
        )


def test_what_it_costs_to_demand_the_maximum_is_what_the_pr_claims():
    """Pin the 2Z a requester must hold to ask for a model's longest reply.

    These are the exact 2Z amounts a requester must hold. Nobody is locked out
    by them — a request that names
    no length gets whatever their 2Z cover instead of being refused — but it is
    the price of demanding the maximum, and a reprice or a raised ceiling has
    to move this table in the same commit.
    """
    expected = {
        "gpt-4o": 25,
        "gpt-6.1-sol": 192, "gpt-6-astra": 960, "gpt-6-sol": 192, "gpt-6-luna": 10,
        "gpt-5.5": 576, "gpt-5.4": 288,
        "gpt-5.6-sol": 576, "gpt-5.6-terra": 231, "gpt-5.6-luna": 24,
        "gpt-5.4-mini": 87, "gpt-5.4-nano": 24, "gpt-5.2": 269, "gpt-5.1": 192,
        "gpt-5": 192, "gpt-5-mini": 39, "gpt-5-nano": 8,
        # gpt-4.1: 16384 ceiling since openai 0030 (gateway fence cap); was 40.
        "gpt-4.1": 20, "gpt-4.1-mini": 8, "gpt-4.1-nano": 2, "gpt-4o-mini": 2,
        "o3": 120, "o4-mini": 66, "o3-mini": 66, "o1": 900,
        "claude-opus-4-8": 120,
        "claude-sonnet-5": 96,  # $10 output since v3; was 144
        "claude-haiku-4-5": 48,
        "grok-4.5": 8,  # xAI's $6/1M output; was 4
        "grok-4.3": 4,
        # Kimi is flagged off, so `SEEDED_PRICED_GA` no longer yields
        # these two and the loop below never reads them. Kept, not
        # deleted: the rows still exist with their (v3, list) prices.
        "kimi-k3": 37,
        "kimi-k2.6": 10,
    }
    for provider, name, in_p, out_p, max_tok, reserve, limit in SEEDED_PRICED_GA:
        ai_model = AIModel(
            provider=provider, model=name, display_name=name,
            system_message="hi", max_tokens=max_tok,
            max_output_tokens=reserve, max_response_tokens=limit,
            input_price=Decimal(in_p), output_price=Decimal(out_p),
            markup=Decimal(DEFAULT_MARKUP),
        )
        assert ai_model.get_max_tuzi_price(0, limit) == expected[name], name


@pytest.mark.django_db
def test_the_default_reaches_the_model_ceiling_when_the_2z_are_there(
        creator_factory, provider_calls):
    """A requester who holds plenty gets the model's full length, not a
    constant. This is the "if a user has the 2Z, give them the full power"
    requirement, and it is what a fixed cap can never satisfy."""
    for provider, name, in_p, out_p, max_tok, reserve, limit in SEEDED_AVAILABLE:
        ai_model = _model(provider, name, in_p, out_p, max_tok, reserve, limit)
        _, conversation, client = _setup(creator_factory, "1000000", ai_model)

        assert _post(client, conversation).status_code == 200, name
        assert provider_calls[-1]["max_output_tokens"] == limit, name


@pytest.mark.django_db
def test_the_default_scales_with_what_the_requester_holds(
        creator_factory, provider_calls):
    """Same model, same prompt, three balances, three lengths — and each one
    is the largest reply that balance covers, never more."""
    ai_model = _model()  # 2Z per output token = 0.00003 * 100 * 1.5 = 0.0045
    lengths = []
    for tuzis in ("100", "450", "900"):
        _, conversation, client = _setup(creator_factory, tuzis, ai_model)
        assert _post(client, conversation).status_code == 200
        cap = provider_calls[-1]["max_output_tokens"]
        lengths.append(cap)
        assert ai_model.get_max_tuzi_price(
            num_tokens_from_messages(provider_calls[-1]["messages"]), cap
        ) <= Decimal(tuzis), (
            "the default length must be one the requester already covers")

    assert lengths[0] < lengths[1] < lengths[2], lengths


@pytest.mark.django_db
def test_asking_for_more_than_the_model_can_give_is_clamped_not_rejected(
        creator_factory, provider_calls):
    """A provider 400 reaches the user as "this model isn't available right
    now", which is a lie about the model. Clamp instead."""
    ai_model = _model(max_response_tokens=16384)
    _, conversation, client = _setup(creator_factory, "1000000", ai_model)

    response = _post(client, conversation, max_output_tokens=999999)

    assert response.status_code == 200, response.content
    assert provider_calls[0]["max_output_tokens"] == 16384


@pytest.mark.django_db
def test_the_request_never_exceeds_the_context_window(
        creator_factory, provider_calls):
    """prompt + requested reply must fit ``max_tokens`` — the provider-400
    case, for an explicitly requested length this time."""
    ai_model = _model(max_tokens=5000, max_output_tokens=1000,
                      max_response_tokens=4096)
    _, conversation, client = _setup(creator_factory, "1000000", ai_model)

    assert _post(client, conversation, user_input="hello " * 1000,
                 max_output_tokens=4096).status_code == 200

    call = provider_calls[0]
    prompt_tokens = num_tokens_from_messages(call["messages"])
    assert prompt_tokens + call["max_output_tokens"] <= 5000
    assert call["max_output_tokens"] < 4096


@pytest.mark.django_db
def test_asking_for_a_short_reply_is_honoured_exactly(
        creator_factory, provider_calls):
    """Someone who wants two sentences pays for two sentences."""
    ai_model = _model()
    _, conversation, client = _setup(creator_factory, "1000000", ai_model)

    assert _post(client, conversation, max_output_tokens=50).status_code == 200
    assert provider_calls[0]["max_output_tokens"] == 50


@pytest.mark.django_db
@pytest.mark.parametrize("bad", [0, -1, "lots", 10 ** 9])
def test_a_nonsense_output_length_is_a_400_not_a_provider_call(
        creator_factory, provider_calls, bad):
    ai_model = _model()
    _, conversation, client = _setup(creator_factory, "1000000", ai_model)

    response = _post(client, conversation, max_output_tokens=bad)

    assert response.status_code == 400, response.content
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert provider_calls == []


@pytest.mark.django_db
def test_a_missing_prompt_is_a_400_not_a_503(creator_factory, provider_calls):
    """`user_input` was read straight off `request.data`, so omitting it died
    inside the tokenizer and surfaced as "this model isn't available right
    now". Declaring the body makes it the 400 it always was."""
    ai_model = _model()
    _, conversation, client = _setup(creator_factory, "1000000", ai_model)

    response = client.post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {}, format="json",
    )

    assert response.status_code == 400, response.content
    assert provider_calls == []


@pytest.mark.django_db
def test_the_provider_call_is_bounded_in_time(creator_factory,
                                              provider_calls):
    """ §3.2: `timeout` and `max_retries` were unset on the interactive
    path, so a provider that accepted the connection and went quiet held one
    sync gunicorn worker on the SDK's own multi-minute default. Not an output
    cap — a hung connection is not a long answer."""
    from .models import AI_CHAT_MAX_RETRIES, AI_CHAT_TIMEOUT_SECONDS

    ai_model = _model()
    _, conversation, client = _setup(creator_factory, "1000000", ai_model)

    assert _post(client, conversation).status_code == 200

    call = provider_calls[0]
    assert call["timeout"] == AI_CHAT_TIMEOUT_SECONDS
    assert call["max_retries"] == AI_CHAT_MAX_RETRIES
    # Needed for the wall clock to run while the provider sends only
    # heartbeats: without it, a text-less stream blocks inside the for loop.
    assert call["emit_keepalive"] is True


def test_anthropic_hands_control_back_while_the_model_is_thinking():
    """A wall clock the provider can starve is not a wall clock.

    Anthropic's ``text_stream`` yields TEXT ONLY, so an extended-thinking
    phase — minutes of ``thinking_delta`` before the first visible token —
    never returns control to ``Conversation.generate``'s deadline check.
    ``emit_keepalive`` therefore has to reach the Anthropic adapter, not just
    the OpenAI-compatible one.

    HOW FAR IT REACHES, honestly: not to ``ping``. The pinned
    ``anthropic==0.120.2`` drops ping events inside
    ``_streaming.Stream.__stream__`` before ``MessageStream`` can see them, so
    a stream of nothing but pings still blocks here and still resets the SDK's
    inactivity timeout. That is unchanged from `main` rather than introduced,
    and it is the kind of thing SSE ( §3.2) removes rather than patches.
    The first version of this test asserted the ping case against a fake that
    invented it — a false positive the codex adversarial review caught.
    """
    from f2z.ai import providers

    sink = []
    fake = _FakeAnthropicClient(sink)
    original = providers.get_client
    providers.get_client = lambda p: fake
    try:
        keepalive_stream = providers.stream_chat(
            type("M", (), {"provider": "anthropic", "model": "claude-x"})(),
            [{"role": "user", "content": "hi"}],
            max_output_tokens=8192, emit_keepalive=True,
        )
        with_keepalive = list(keepalive_stream)
        termination_reason = keepalive_stream.termination_reason
        text_only = list(providers.stream_chat(
            type("M", (), {"provider": "anthropic", "model": "claude-x"})(),
            [{"role": "user", "content": "hi"}],
            max_output_tokens=8192,
        ))
    finally:
        providers.get_client = original

    # Every event yields something, so the caller's clock gets a turn while
    # the model is thinking...
    assert with_keepalive == ["", "", "", "", "answer", "", ""], with_keepalive
    #...the reasoning is NOT accumulated into the reply, and the answer is
    # exactly the same text either way.
    assert "".join(with_keepalive) == "".join(text_only) == "answer"
    assert termination_reason == "end_turn"


def test_anthropic_stream_exposes_a_provider_token_limit_stop():
    from f2z.ai import providers

    class EventStream(_FakeAnthropicStream):
        _events = [
            _FakeAnthropicEvent("content_block_delta", text="partial"),
            _FakeAnthropicEvent("message_delta", stop_reason="max_tokens"),
        ]

    class Messages:
        def stream(self, **kwargs):
            del kwargs
            return EventStream()

    client = type("Client", (), {"messages": Messages()})()
    original = providers.get_client
    providers.get_client = lambda _provider: client
    try:
        stream = providers.stream_chat(
            type("M", (), {"provider": "anthropic", "model": "claude-x"})(),
            [{"role": "user", "content": "hi"}],
            max_output_tokens=12,
        )
        assert list(stream) == ["partial"]
        assert stream.termination_reason == "max_tokens"
    finally:
        providers.get_client = original




@pytest.mark.django_db
def test_a_generation_that_outruns_the_worker_still_returns_and_charges(
        creator_factory, monkeypatch):
    """gunicorn runs `--timeout 600` on a single sync worker.

    A generation that runs past it is SIGKILLed: the user gets nothing, is
    charged nothing, and we owe the provider for every token produced —
    a free burn that uncapping the reply length would otherwise make reachable
    by anyone holding enough 2Z. Stopping at the deadline instead returns and
    charges for the partial reply.
    """
    from . import models as ai_models

    ai_model = _model()
    user, conversation, client = _setup(creator_factory, "1000000", ai_model)

    clock = {"now": 0.0}

    # Replace the NAME `time` in this module's namespace, not `monotonic` on
    # the real time module -- patching the stdlib globally would hand a fake
    # clock to psycopg, the test client and everything else running inside
    # this request.
    class _Clock:
        @staticmethod
        def monotonic():
            return clock["now"]

    monkeypatch.setattr(ai_models, "time", _Clock)

    closed = []

    def endless(ai_model, messages, **kwargs):
        try:
            while True:
                clock["now"] += 60.0
                yield "word "
        finally:
            closed.append(True)

    monkeypatch.setattr("f2z.ai.providers.stream_chat", endless)

    response = _post(client, conversation)

    assert response.status_code == 200, response.content
    assert response.data["response"], "the partial reply must be returned"
    assert balance(user) < Decimal("1000000"), "and charged for"
    assert closed, "the provider stream must be closed, not left to the GC"


@pytest.mark.django_db
def test_a_single_turn_over_the_input_budget_is_refused_before_the_provider(
        creator_factory, provider_calls):
    """The long-context cap ( decision (b)) only holds if nothing above
    the window is ever sent. A turn build_messages cannot trim is a 400 with
    no provider call and no charge -- the conversation-less prompt endpoint
    already behaved this way; codex found the conversation path did not."""
    ai_model = _model(max_tokens=600, max_output_tokens=256, max_response_tokens=256)
    user, conversation, client = _setup(creator_factory, "1000", ai_model)
    oversized = " ".join(["token"] * 2000)
    response = _post(client, conversation, user_input=oversized)
    assert response.status_code == 400, response.content
    assert "accepts at most" in response.data["detail"]
    assert provider_calls == []
    assert balance(user) == Decimal("1000")
    # Negative control: the same conversation takes a turn that fits.
    assert _post(client, conversation, user_input="hello").status_code == 200
    assert len(provider_calls) == 1


# " className " is 2 tokens in cl100k_base and 3 in o200k_base: a 1000-copy
# turn fits a 2744-token budget by the legacy count and not by the model's.
TOKENIZER_TRAP = " className " * 1000


@pytest.mark.django_db
def test_a_turn_that_fits_cl100k_but_not_the_models_tokenizer_is_refused(
        creator_factory, provider_calls):
    """The budget check must use the conservative count at the CALL SITE, not
    only in the helper (independent review of: reverting build_messages
    to the legacy count left every test green while ~327K real tokens went
    out at long-context rates)."""
    ai_model = _model(model="gpt-5.4", max_tokens=3000, max_output_tokens=256,
                      max_response_tokens=256)
    user, conversation, client = _setup(creator_factory, "1000", ai_model)
    response = _post(client, conversation, user_input=TOKENIZER_TRAP)
    assert response.status_code == 400, response.content
    assert provider_calls == [] and balance(user) == Decimal("1000")
    # The same text at half the length fits both counts and goes through,
    # charged on the legacy count (the charge did not move to the max).
    response = _post(client, conversation, user_input=" className " * 500)
    assert response.status_code == 200, response.content
    assert len(provider_calls) == 1
    prompt_tokens = num_tokens_from_messages(provider_calls[0]["messages"])
    assert Decimal("1000") - balance(user) <= ai_model.get_max_tuzi_price(
        prompt_tokens, provider_calls[0]["max_output_tokens"])


@pytest.mark.django_db
def test_the_output_cap_is_sized_from_the_models_tokenizer_not_the_legacy_count(
        creator_factory, provider_calls):
    """prompt + cap must fit the window on the tokenizer the provider uses
   : a prompt that is 1400 legacy tokens but 2100
    model tokens in a 3000 window gets a cap of at most ~900, not ~1600."""
    import tiktoken

    ai_model = _model(model="gpt-5.4", max_tokens=3000, max_output_tokens=256,
                      max_response_tokens=2500)
    user, conversation, client = _setup(creator_factory, "100000", ai_model)
    prompt = " className " * 700
    response = _post(client, conversation, user_input=prompt)
    assert response.status_code == 200, response.content
    sent = provider_calls[0]
    o200k = sum(len(tiktoken.get_encoding("o200k_base").encode(m["content"])) + 4
                for m in sent["messages"]) + 2
    assert o200k + sent["max_output_tokens"] <= 3000
    assert sent["max_output_tokens"] < 3000 - num_tokens_from_messages(sent["messages"]), (
        "the cap was sized from the legacy count")


@pytest.mark.django_db
def test_history_is_trimmed_on_the_conservative_count_not_refused(
        creator_factory, provider_calls):
    """A long conversation whose history fits by the legacy count but not by
    the model's is TRIMMED (older exchanges dropped), never 400'd
    (independent review of )."""
    from dj.apps.openai.models import PromptResponse

    ai_model = _model(model="gpt-5.4", max_tokens=3000, max_output_tokens=256,
                      max_response_tokens=256)
    user, conversation, client = _setup(creator_factory, "100000", ai_model)
    for _ in range(3):
        pr = PromptResponse.objects.create(
            user_input=" className " * 300, response="ok", user=user)
        conversation.prompt_response_set.add(pr)
    response = _post(client, conversation, user_input="and now?")
    assert response.status_code == 200, response.content
    messages = provider_calls[0]["messages"]
    assert len(messages) < 2 + 2 * 3 + 0, "history was trimmed"
    assert messages[-1]["content"] == "and now?"
