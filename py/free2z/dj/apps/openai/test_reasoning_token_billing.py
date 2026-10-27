"""Reasoning / thinking tokens are billed at the output rate.

Until  the Django chat charge counted ``num_tokens_from_text(reply)``:
tiktoken over the VISIBLE text. Hidden reasoning -- xAI grok reasons on high
by default, OpenAI's reasoning families, Anthropic thinking -- never reaches
the text, so it was never charged, while every provider bills it as output.

The fix reads the provider's own usage report off the stream and charges its
billable output count, normalised across the two conventions:

* OpenAI and Anthropic put reasoning INSIDE the output count;
* xAI reports it BESIDE ``completion_tokens``.

So OpenAI/Anthropic must not be double-counted and xAI must not be
under-counted. The payloads are in ``testdata/provider_usage_streams.json``
and are validated against the pinned SDKs' own models. The same adapters
normalize total input with cached and cache-write tokens split into disjoint
classes. Only the SDK client is faked -- the real adapters and charge paths
run, and the money tests use real Postgres and the real ledger.
"""
from decimal import Decimal
import json
import pathlib
import uuid
from types import SimpleNamespace

import pytest
from rest_framework.test import APIClient

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from f2z.ai import providers

from .models import (
    AIModel, Conversation, GenerationInterrupted, generate_reply,
    num_tokens_from_messages,
    num_tokens_from_text,
)

RECORDINGS = json.loads(
    (pathlib.Path(__file__).parent / "testdata" / "provider_usage_streams.json")
    .read_text()
)


# --------------------------------------------------------------------------- #
# SDK-boundary fakes, fed with SDK-validated payloads
# --------------------------------------------------------------------------- #
def _openai_chunks(name):
    from openai.types.chat import ChatCompletionChunk

    return [ChatCompletionChunk.model_validate(c)
            for c in RECORDINGS[name]["chunks"]]


def _anthropic_events(name):
    from anthropic.types import (
        RawContentBlockDeltaEvent, RawContentBlockStartEvent,
        RawContentBlockStopEvent, RawMessageDeltaEvent, RawMessageStartEvent,
        RawMessageStopEvent,
    )

    by_type = {
        "message_start": RawMessageStartEvent,
        "content_block_start": RawContentBlockStartEvent,
        "content_block_delta": RawContentBlockDeltaEvent,
        "content_block_stop": RawContentBlockStopEvent,
        "message_delta": RawMessageDeltaEvent,
        "message_stop": RawMessageStopEvent,
    }
    return [by_type[e["type"]].model_validate(e)
            for e in RECORDINGS[name]["events"]]


class _UnsupportedParam(Exception):
    status_code = 400


class FakeOpenAIClient:
    """``client.chat.completions.create(**kw)`` -> an iterator of chunks."""

    def __init__(self, chunks, reject_stream_options=False):
        self._chunks = chunks
        self._reject = reject_stream_options
        self.calls = []
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create))

    def with_options(self, **_):
        return self

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._reject and "stream_options" in kwargs:
            raise _UnsupportedParam(
                "Error code: 400 - Unrecognized request argument supplied: "
                "stream_options")
        return iter(list(self._chunks))


class _AnthropicStream:
    def __init__(self, events):
        self._events = events

    def __enter__(self):
        return iter(list(self._events))

    def __exit__(self, *exc):
        return False


class FakeAnthropicClient:
    def __init__(self, events):
        self.calls = []
        self.messages = SimpleNamespace(stream=self._stream)
        self._events = events

    def with_options(self, **_):
        return self

    def _stream(self, **kwargs):
        self.calls.append(kwargs)
        return _AnthropicStream(self._events)


def _fake_client_for(name, **kwargs):
    rec = RECORDINGS[name]
    if rec["provider"] == "anthropic":
        return FakeAnthropicClient(_anthropic_events(name))
    return FakeOpenAIClient(_openai_chunks(name), **kwargs)


@pytest.fixture(autouse=True)
def _fresh_provider_memory():
    providers._stream_usage_unsupported.clear()
    providers._max_output_param_learned.clear()
    yield
    providers._stream_usage_unsupported.clear()
    providers._max_output_param_learned.clear()


@pytest.fixture(autouse=True)
def _mock_configured_provider_keys(monkeypatch):
    """Use explicitly configured fixture providers without ambient API keys."""
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers",
        lambda: {"openai", "anthropic", "xai"},
    )


@pytest.fixture
def fake_provider(monkeypatch):
    """Install a fake SDK client for one recording; returns the client."""
    def install(name, **kwargs):
        client = _fake_client_for(name, **kwargs)
        monkeypatch.setattr(providers, "get_client", lambda provider: client)
        return client
    return install


def _row(name, **overrides):
    rec = RECORDINGS[name]
    fields = dict(
        provider=rec["provider"], model=rec["model"], display_name=rec["model"],
        system_message="You are terse.", max_tokens=256000,
        max_output_tokens=8192, max_response_tokens=32000,
        # Dear on purpose: at list prices the documented xAI example (119
        # output tokens) rounds to the same whole 2Z as its 6 visible ones,
        # and a test that cannot tell the two apart proves nothing.
        input_price="0.0001", output_price="0.001", markup="1.5",
        is_ga=True,
    )
    fields.update(overrides)
    return fields


NAMES = ["openai_reasoning", "xai_reasoning", "anthropic_thinking"]


def test_cache_input_categories_use_their_own_prices_once():
    ai_model = AIModel(**_row("openai_reasoning"))
    # 700k ordinary + 100k cached at 0.1x + 200k writes at 1.25x
    # = 960k ordinary-input equivalents. The disjoint sum remains 1m.
    charged = ai_model.get_tuzi_price(
        1_000_000, 0,
        cached_input_tokens=100_000,
        cache_write_tokens=200_000,
    )
    assert charged == 14_400
    # An overlapping/malformed breakdown is ignored, never double counted.
    assert ai_model.get_tuzi_price(
        1_000_000, 0,
        cached_input_tokens=900_000,
        cache_write_tokens=200_000,
    ) == ai_model.get_tuzi_price(1_000_000, 0)
    # Admission holds against the most expensive input class, so a later
    # provider report cannot exceed the input allowance held up front.
    assert ai_model.get_admission_price(1_000_000, 0) == 18_750


def test_anthropic_cache_ttl_categories_keep_their_distinct_rates():
    ai_model = AIModel(**_row("anthropic_thinking"))
    # 200k ordinary + 100k reads at 0.1x + 500k 5m writes at 1.25x
    # + 200k 1h writes at 2x = 1.235m ordinary-input equivalents.
    assert ai_model.get_tuzi_price(
        1_000_000, 0,
        cached_input_tokens=100_000,
        cache_write_tokens=500_000,
        cache_write_1h_tokens=200_000,
    ) == 18_525


def test_admission_uses_the_actual_highest_anthropic_cache_rate():
    ai_model = AIModel(**_row(
        "anthropic_thinking", input_price="0.000003",
        output_price="0.000015", markup="1.5"))

    admitted = ai_model.get_admission_price(1_000_000, 0)
    one_hour_write = ai_model.get_tuzi_price(
        1_000_000, 0, cache_write_1h_tokens=1_000_000)

    assert one_hour_write == 900
    assert admitted >= one_hour_write


# --------------------------------------------------------------------------- #
# 1. Normalisation: exactly what each provider bills, never twice.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name", ["openai_reasoning", "xai_reasoning"])
def test_openai_compatible_usage_is_the_billed_output(name):
    rec = RECORDINGS[name]
    usage = _openai_chunks(name)[-1].usage

    normalized = providers._openai_compatible_usage(rec["provider"], usage)

    assert normalized.output_tokens == rec["expected_output_tokens"]
    assert normalized.reasoning_tokens == rec["expected_reasoning_tokens"]
    assert normalized.input_tokens == rec["expected_input_tokens"]
    assert normalized.cached_input_tokens == rec.get(
        "expected_cached_input_tokens", 0)
    assert normalized.cache_write_tokens == rec.get(
        "expected_cache_write_tokens", 0)
    assert normalized.cache_write_1h_tokens == rec.get(
        "expected_cache_write_1h_tokens", 0)


def test_openai_reasoning_is_not_double_counted():
    # 1186 already contains the 1024 reasoning tokens (total = 75 + 1186).
    usage = _openai_chunks("openai_reasoning")[-1].usage
    assert providers._openai_compatible_usage("openai", usage).output_tokens \
        == usage.completion_tokens


def test_xai_reasoning_is_added_to_completion():
    # 9 visible + 110 reasoning; total 151 = 32 + 9 + 110 says so.
    usage = _openai_chunks("xai_reasoning")[-1].usage
    assert providers._openai_compatible_usage("xai", usage).output_tokens \
        == usage.completion_tokens + usage.completion_tokens_details.reasoning_tokens


def test_payload_arithmetic_wins_over_the_provider_label():
    """``total_tokens`` settles where reasoning sits, whoever reports it."""
    xai_shape = {"prompt_tokens": 32, "completion_tokens": 9,
                 "total_tokens": 151,
                 "completion_tokens_details": {"reasoning_tokens": 110}}
    openai_shape = {"prompt_tokens": 75, "completion_tokens": 1186,
                    "total_tokens": 1261,
                    "completion_tokens_details": {"reasoning_tokens": 1024}}
    assert providers._openai_compatible_usage("openai", xai_shape).output_tokens == 119
    assert providers._openai_compatible_usage("xai", openai_shape).output_tokens == 1186


def test_unsettled_payload_falls_back_to_the_documented_convention():
    no_total = {"prompt_tokens": 32, "completion_tokens": 200,
                "completion_tokens_details": {"reasoning_tokens": 110}}
    assert providers._openai_compatible_usage("xai", no_total).output_tokens == 310
    assert providers._openai_compatible_usage("openai", no_total).output_tokens == 200
    # Reasoning larger than the completion cannot be inside it.
    bigger = {"prompt_tokens": 32, "completion_tokens": 9,
              "completion_tokens_details": {"reasoning_tokens": 110}}
    assert providers._openai_compatible_usage("openai", bigger).output_tokens == 119


def test_invalid_overlapping_cache_breakdown_uses_total_prompt_once():
    usage = providers._openai_compatible_usage("openai", {
        "prompt_tokens": 10,
        "completion_tokens": 2,
        "prompt_tokens_details": {
            "cached_tokens": 6,
            "cache_write_tokens": 5,
        },
    })
    assert usage.input_tokens == 10
    assert usage.cached_input_tokens == 0
    assert usage.cache_write_tokens == 0


@pytest.mark.parametrize("bogus", [None, "9", True, -1, 1.5])
def test_a_non_count_is_not_usage(bogus):
    assert providers._openai_compatible_usage(
        "openai", {"prompt_tokens": 1, "completion_tokens": bogus}) is None


def test_anthropic_output_tokens_already_include_thinking():
    events = _anthropic_events("anthropic_thinking")
    start = events[0].message.usage
    delta = events[-2].usage

    normalized = providers._anthropic_usage(start, delta)

    assert normalized.output_tokens == 3120  # NOT 3120 + 2900
    assert normalized.reasoning_tokens == 2900
    assert normalized.input_tokens == 872
    assert normalized.cached_input_tokens == 200
    assert normalized.cache_write_tokens == 100
    assert normalized.cache_write_1h_tokens == 100


# --------------------------------------------------------------------------- #
# 2. The real adapters surface it on the stream -- and only once it ended.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name", NAMES)
def test_stream_chat_reports_provider_usage_after_the_stream_ends(
        name, fake_provider):
    rec = RECORDINGS[name]
    client = fake_provider(name)
    ai_model = SimpleNamespace(provider=rec["provider"], model=rec["model"])

    stream = providers.stream_chat(
        ai_model, [{"role": "user", "content": "q"}], max_output_tokens=4096,
        emit_keepalive=True)
    text = "".join(stream)

    # Reasoning never becomes visible text.
    assert text == rec["visible_text"]
    assert stream.usage.input_tokens == rec["expected_input_tokens"]
    assert stream.usage.output_tokens == rec["expected_output_tokens"]
    assert stream.usage.reasoning_tokens == rec["expected_reasoning_tokens"]
    assert stream.usage.cached_input_tokens == rec.get(
        "expected_cached_input_tokens", 0)
    assert stream.usage.cache_write_tokens == rec.get(
        "expected_cache_write_tokens", 0)
    assert stream.usage.cache_write_1h_tokens == rec.get(
        "expected_cache_write_1h_tokens", 0)
    if rec["provider"] != "anthropic":
        # Without this a Chat Completions stream reports no usage at all.
        assert client.calls[-1]["stream_options"] == {"include_usage": True}


def _items_through_final_usage(name):
    """How many items (one per chunk/event, with ``emit_keepalive``) a caller
    reads to have consumed the provider's FINAL usage report: the usage-only
    chunk is the last OpenAI-shaped chunk; Anthropic's is ``message_delta``,
    one before ``message_stop``."""
    rec = RECORDINGS[name]
    if rec["provider"] == "anthropic":
        return [e["type"] for e in rec["events"]].index("message_delta") + 1
    return len(rec["chunks"])


def _open(name):
    rec = RECORDINGS[name]
    return providers.stream_chat(
        SimpleNamespace(provider=rec["provider"], model=rec["model"]),
        [{"role": "user", "content": "q"}], max_output_tokens=4096,
        emit_keepalive=True)


def test_stream_marks_provider_started_only_after_create_returns(fake_provider):
    fake_provider("openai_reasoning")
    stream = _open("openai_reasoning")

    assert stream.provider_started is False
    next(stream)
    assert stream.provider_started is True


def test_provider_creation_failure_does_not_mark_stream_started(monkeypatch):
    def missing_key(provider):
        raise RuntimeError("No API key configured for openai")

    monkeypatch.setattr(providers, "get_client", missing_key)
    stream = _open("openai_reasoning")

    with pytest.raises(RuntimeError, match="No API key configured"):
        next(stream)
    assert stream.provider_started is False


@pytest.mark.parametrize("name", NAMES)
def test_an_abandoned_stream_reports_no_usage(name, fake_provider):
    """A partial count must never stand in for the whole: Anthropic's
    ``message_start`` already says ``output_tokens: 1``."""
    fake_provider(name)
    stream = _open(name)

    for _ in range(_items_through_final_usage(name) - 1):
        next(stream)
    stream.close()

    assert stream.usage is None


def test_running_usage_before_the_finish_is_not_final(monkeypatch):
    """A provider that attaches a running ``usage`` to every chunk must not
    have a mid-generation count billed as the whole when the caller stops
    reading early: only usage seen at or after ``finish_reason`` is final."""
    from openai.types.chat import ChatCompletionChunk

    raw = [dict(c) for c in RECORDINGS["xai_reasoning"]["chunks"]]
    raw[0]["usage"] = {"prompt_tokens": 32, "completion_tokens": 1,
                       "total_tokens": 33}
    client = FakeOpenAIClient(
        [ChatCompletionChunk.model_validate(c) for c in raw])
    monkeypatch.setattr(providers, "get_client", lambda provider: client)
    stream = _open("xai_reasoning")

    next(stream)
    stream.close()

    assert stream.usage is None


@pytest.mark.parametrize("name", NAMES)
def test_final_usage_survives_a_break_before_stop_iteration(
        name, fake_provider):
    """The wall clock in ``generate_reply`` can fire AFTER the final usage
    arrived and before the iterator reports exhaustion. That count is the
    whole one and must still be billed (codex adversarial review)."""
    fake_provider(name)
    stream = _open(name)

    for _ in range(_items_through_final_usage(name)):
        next(stream)
    stream.close()

    assert stream.usage is not None
    assert stream.usage.output_tokens == \
        RECORDINGS[name]["expected_output_tokens"]


def test_a_provider_that_rejects_stream_options_still_streams(fake_provider):
    client = fake_provider("xai_reasoning", reject_stream_options=True)
    ai_model = SimpleNamespace(provider="xai", model="grok-4.5")

    stream = providers.stream_chat(
        ai_model, [{"role": "user", "content": "q"}], max_output_tokens=64)
    assert "".join(stream) == "The answer is 42."
    assert "stream_options" in client.calls[0]
    assert "stream_options" not in client.calls[-1]
    assert client.calls[-1]["max_tokens"] == 64

    # Asked once per (provider, model), not on every request.
    client.calls.clear()
    "".join(providers.stream_chat(
        ai_model, [{"role": "user", "content": "q"}], max_output_tokens=64))
    assert len(client.calls) == 1
    assert "stream_options" not in client.calls[0]


# --------------------------------------------------------------------------- #
# 3. generate_reply -- the one loop both chat endpoints charge from.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name", NAMES)
def test_generate_reply_counts_reasoning_as_output(name, fake_provider):
    rec = RECORDINGS[name]
    fake_provider(name)
    ai_model = AIModel(**_row(name))

    text, input_tokens, output_tokens, usage = generate_reply(
        ai_model, [{"role": "user", "content": "q"}], 10, 4096)

    assert text == rec["visible_text"]
    assert input_tokens == rec["expected_input_tokens"]
    assert output_tokens == rec["expected_output_tokens"]
    assert usage.input_tokens == rec["expected_input_tokens"]
    assert output_tokens > num_tokens_from_text(text, ai_model.model)


def test_generate_reply_without_usage_keeps_the_visible_estimate(monkeypatch):
    """A stream with no usage report (wall-clock cut, a stand-in) is charged
    exactly what it was before  -- never zero."""
    def bare(*_a, **_k):
        yield "plain words"
    monkeypatch.setattr("f2z.ai.providers.stream_chat", bare)

    _, input_tokens, output_tokens, usage = generate_reply(
        AIModel(**_row("openai_reasoning")),
        [{"role": "user", "content": "q"}], 10, 4096)

    assert input_tokens == 10
    assert usage is None
    assert output_tokens == num_tokens_from_text(
        "plain words", "gpt-5.6-sol")


def test_generate_reply_tags_websocket_deltas_with_stream_id(monkeypatch):
    sent = []

    class ChannelLayer:
        async def group_send(self, group, message):
            sent.append((group, message))

    def bare(*_a, **_k):
        yield "plain words"

    monkeypatch.setattr("f2z.ai.providers.stream_chat", bare)
    monkeypatch.setattr(
        "dj.apps.openai.models.get_channel_layer", lambda: ChannelLayer())

    generate_reply(
        AIModel(**_row("openai_reasoning")),
        [{"role": "user", "content": "q"}], 10, 4096,
        channel_group="conversation_123", stream_id="generation-123",
    )

    assert sent == [(
        "conversation_123",
        {
            "type": "send_word",
            "message": "plain words",
            "stream_id": "generation-123",
        },
    )]


@pytest.mark.parametrize("chunk_count", [3])
def test_adapter_eof_before_terminal_event_is_interrupted(
        chunk_count, monkeypatch):
    """An accepted stream ending without finish_reason is never a full reply."""
    client = FakeOpenAIClient(_openai_chunks("openai_reasoning")[:chunk_count])
    monkeypatch.setattr(providers, "get_client", lambda provider: client)
    ai_model = AIModel(**_row("openai_reasoning"))

    with pytest.raises(GenerationInterrupted) as interrupted:
        generate_reply(
            ai_model, [{"role": "user", "content": "q"}], 10, 4096)

    assert interrupted.value.provider_started is True
    assert interrupted.value.settlement_output_tokens == num_tokens_from_text(
        "" if chunk_count == 0 else "The answer is 42.")
    assert interrupted.value.usage is None
    assert interrupted.value.response_text == (
        "" if chunk_count == 0 else "The answer is 42.")


def test_refusal_delta_without_finish_event_is_still_incomplete(monkeypatch):
    from openai.types.chat import ChatCompletionChunk

    raw = dict(RECORDINGS["openai_reasoning"]["chunks"][0])
    raw["choices"] = [{"index": 0, "delta": {"refusal": "I cannot help"},
                       "finish_reason": None}]
    client = FakeOpenAIClient([ChatCompletionChunk.model_validate(raw)])
    monkeypatch.setattr(providers, "get_client", lambda provider: client)

    with pytest.raises(GenerationInterrupted):
        generate_reply(
            AIModel(**_row("openai_reasoning")),
            [{"role": "user", "content": "q"}], 10, 4096)


def test_adapter_first_delta_failure_is_not_billable(monkeypatch):
    """An HTTP connection alone does not prove provider consumption."""
    def failed_body():
        raise TimeoutError("body timed out before first delta")
        yield  # pragma: no cover - make this a generator

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(
            create=lambda **kwargs: failed_body())),
        with_options=lambda **kwargs: client,
    )
    monkeypatch.setattr(providers, "get_client", lambda provider: client)
    ai_model = AIModel(**_row("openai_reasoning"))

    with pytest.raises(TimeoutError, match="before first delta"):
        generate_reply(
            ai_model, [{"role": "user", "content": "q"}], 10, 4096)


def test_terminal_adapter_stream_without_usage_remains_successful(monkeypatch):
    """A terminal finish_reason is complete even when usage is omitted."""
    client = FakeOpenAIClient(_openai_chunks("openai_reasoning")[:4])
    monkeypatch.setattr(providers, "get_client", lambda provider: client)

    result = generate_reply(
        AIModel(**_row("openai_reasoning")),
        [{"role": "user", "content": "q"}], 10, 4096)

    assert result.response_text == "The answer is 42."
    assert result.output_tokens == num_tokens_from_text("The answer is 42.")
    assert result.settlement_output_tokens == result.output_tokens


def test_deadline_during_hidden_reasoning_uses_visible_estimate(
        monkeypatch):
    """Empty adapter deltas keep the deadline live while reasoning is hidden."""
    client = FakeOpenAIClient([_openai_chunks("openai_reasoning")[0]] * 3)
    monkeypatch.setattr(providers, "get_client", lambda provider: client)
    readings = iter((0, 0, 171))
    monkeypatch.setattr(
        "dj.apps.openai.models.time",
        SimpleNamespace(monotonic=lambda: next(readings)))
    ai_model = AIModel(**_row("openai_reasoning"))

    result = generate_reply(
        ai_model, [{"role": "user", "content": "q"}], 10, 4096)

    assert result.response_text == ""
    assert result.output_tokens == 0
    assert result.settlement_output_tokens == 0


@pytest.mark.django_db
@pytest.mark.parametrize("endpoint", ["conversation", "metered_prompt"])
def test_final_usage_received_at_deadline_is_charged_on_both_paths(
        endpoint, creator_factory, fake_provider, monkeypatch):
    """Final usage consumed at the local deadline outranks the bound."""
    rec = RECORDINGS["openai_reasoning"]
    fake_provider("openai_reasoning")
    readings = iter((0, 0, 0, 0, 0, 171))
    monkeypatch.setattr(
        "dj.apps.openai.models.time",
        SimpleNamespace(monotonic=lambda: next(readings)))
    ai_model = AIModel.objects.create(**_row("openai_reasoning"))
    user = creator_factory(tuzis=Decimal("10000"))

    if endpoint == "conversation":
        conversation = Conversation.objects.create(
            user=user, ai_model=ai_model, display_name="c")
        response = _converse(user, conversation, max_output_tokens=4096)
    else:
        response = _client(user).post(
            "/api/ai/prompt/",
            {"model": str(ai_model.pk), "prompt": "q",
             "max_output_tokens": 4096},
            format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))

    price = ai_model.get_tuzi_price(
        rec["expected_input_tokens"], rec["expected_output_tokens"],
        cached_input_tokens=rec["expected_cached_input_tokens"],
    )
    assert response.status_code == 200, response.content
    assert balance(user) == Decimal("10000") - price
    if endpoint == "metered_prompt":
        assert response.data["output_tokens"] == rec["expected_output_tokens"]


# --------------------------------------------------------------------------- #
# 4. Money: both endpoints debit the reasoning, and never above the ceiling.
# --------------------------------------------------------------------------- #
def _client(user):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return client


def balance(user):
    return Creator.objects.get(pk=user.pk).tuzis


@pytest.mark.django_db
@pytest.mark.parametrize("name", NAMES)
def test_metered_prompt_charges_reasoning(name, creator_factory, fake_provider):
    rec = RECORDINGS[name]
    fake_provider(name)
    ai_model = AIModel.objects.create(**_row(name))
    # Enough to hold the xAI row's reasoning allowance at this dear price
    #16384 x 0.15 2Z is about 2.5k 2Z on top of the reply.
    user = creator_factory(tuzis=Decimal("10000"))

    response = _client(user).post(
        "/api/ai/prompt/", {"model": str(ai_model.pk), "prompt": "q"},
        format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))

    assert response.status_code == 200, response.content
    estimated_input_tokens = num_tokens_from_messages([
        {"role": "system", "content": ai_model.system_message},
        {"role": "user", "content": "q"},
    ], ai_model.model)
    usage = providers._openai_compatible_usage(
        rec["provider"], _openai_chunks(name)[-1].usage
    ) if rec["provider"] != "anthropic" else providers._anthropic_usage(
        _anthropic_events(name)[0].message.usage,
        _anthropic_events(name)[-2].usage,
    )
    input_tokens = rec["expected_input_tokens"]
    price = ai_model.get_tuzi_price(
        input_tokens, rec["expected_output_tokens"],
        cached_input_tokens=usage.cached_input_tokens,
        cache_write_tokens=usage.cache_write_tokens,
        cache_write_1h_tokens=usage.cache_write_1h_tokens,
    )
    visible_only = ai_model.get_tuzi_price(
        input_tokens, num_tokens_from_text(rec["visible_text"], ai_model.model))
    assert response.data["input_tokens"] == rec.get(
        "expected_input_tokens", estimated_input_tokens)
    assert price > visible_only, "fixture must make reasoning cost something"
    assert response.data["input_tokens"] == input_tokens
    assert response.data["output_tokens"] == rec["expected_output_tokens"]
    assert response.data["tuzis_charged"] == price
    assert balance(user) == Decimal("10000") - price


def _conversation(creator_factory, ai_model, tuzis="1000"):
    user = creator_factory(tuzis=Decimal(tuzis))
    conversation = Conversation.objects.create(
        user=user, ai_model=ai_model, display_name="c")
    return user, conversation


class _UsageStream:
    def __init__(self, usage):
        self.usage = usage

    def __iter__(self):
        yield "answer"

    def close(self):
        pass


@pytest.mark.django_db
@pytest.mark.parametrize("endpoint", ["conversation", "prompt"])
@pytest.mark.parametrize("interrupted", [False, True])
def test_chat_endpoints_charge_provider_input_and_cache_categories(
        endpoint, interrupted, creator_factory, monkeypatch):
    ai_model = AIModel.objects.create(**_row("openai_reasoning"))
    prompt = "className " * 25000
    if endpoint == "conversation":
        user, conversation = _conversation(
            creator_factory, ai_model, tuzis="10000")
        messages, estimated_input = conversation.build_messages(prompt)
        post = lambda: _converse(user, conversation, user_input=prompt)
    else:
        user = creator_factory(tuzis=Decimal("10000"))
        messages = [
            {"role": "system", "content": ai_model.system_message},
            {"role": "user", "content": prompt},
        ]
        estimated_input = num_tokens_from_messages(messages, ai_model.model)
        post = lambda: _client(user).post(
            "/api/ai/prompt/",
            {"model": str(ai_model.pk), "prompt": prompt,
             "max_output_tokens": 256},
            format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )

    reported_input = estimated_input // 2 if interrupted else estimated_input
    usage = providers.ProviderUsage(
        input_tokens=reported_input,
        output_tokens=2,
        cached_input_tokens=reported_input // 10,
        cache_write_tokens=(reported_input * 7) // 10,
    )
    class ReportedStream(_UsageStream):
        def __iter__(self):
            yield "answer"
            if interrupted:
                raise TimeoutError("transport lost after final usage")

    monkeypatch.setattr(
        providers, "stream_chat", lambda *_args, **_kwargs: ReportedStream(usage))

    response = post()

    assert response.status_code == 200, response.content
    expected = ai_model.get_tuzi_price(
        reported_input, 2,
        cached_input_tokens=usage.cached_input_tokens,
        cache_write_tokens=usage.cache_write_tokens,
    )
    assert expected > ai_model.get_tuzi_price(reported_input, 2)
    if endpoint == "prompt":
        assert response.data["input_tokens"] == reported_input
        assert response.data["tuzis_charged"] == expected
    assert balance(user) == Decimal("10000") - expected
    assert Event.objects.get(type="CHAT2Z", receiving_user=user).amount == expected


@pytest.mark.django_db
@pytest.mark.parametrize("endpoint", ["conversation", "prompt"])
def test_provider_input_overage_is_clamped_to_the_admitted_balance(
        endpoint, creator_factory, monkeypatch):
    ai_model = AIModel.objects.create(**_row("openai_reasoning"))
    if endpoint == "conversation":
        user, conversation = _conversation(
            creator_factory, ai_model, tuzis="1000")
        _messages, estimated_input = conversation.build_messages("q")
        post = lambda: _converse(
            user, conversation, max_output_tokens=256)
    else:
        user = creator_factory(tuzis=Decimal("1000"))
        estimated_input = num_tokens_from_messages([
            {"role": "system", "content": ai_model.system_message},
            {"role": "user", "content": "q"},
        ], ai_model.model)
        post = lambda: _client(user).post(
            "/api/ai/prompt/", {"model": str(ai_model.pk), "prompt": "q",
                                  "max_output_tokens": 256},
            format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
    ceiling = ai_model.get_admission_price(estimated_input, 256)
    usage = providers.ProviderUsage(
        input_tokens=1_000_000,
        output_tokens=2,
        cache_write_tokens=1_000_000,
    )
    monkeypatch.setattr(
        providers, "stream_chat", lambda *_args, **_kwargs: _UsageStream(usage))

    response = post()

    assert response.status_code == 200, response.content
    assert balance(user) == Decimal("1000") - ceiling
    assert balance(user) >= 0
    assert Event.objects.get(type="CHAT2Z", receiving_user=user).amount == ceiling


@pytest.mark.django_db
@pytest.mark.parametrize("endpoint", ["conversation", "prompt"])
@pytest.mark.parametrize("model", ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"])
def test_missing_usage_fallback_uses_o200k_for_new_gpt_models(
        endpoint, model, creator_factory, monkeypatch):
    ai_model = AIModel.objects.create(**_row(
        "openai_reasoning", model=model, input_price="0.0001",
        output_price="0.001"))
    prompt = " className " * 1000
    messages = [
        {"role": "system", "content": ai_model.system_message},
        {"role": "user", "content": prompt},
    ]
    estimated_input = num_tokens_from_messages(messages, ai_model.model)
    # This prompt diverges: cl100k counts 2000 content tokens; o200k counts
    # 3000. The full message count includes framing.
    assert num_tokens_from_text(prompt, ai_model.model) == 3000
    assert num_tokens_from_text(prompt, "gpt-3.5-turbo") == 2000
    assert estimated_input >= 3000
    user = creator_factory(tuzis=Decimal("10000"))
    if endpoint == "conversation":
        conversation = Conversation.objects.create(
            user=user, ai_model=ai_model, display_name="c")
        post = lambda: _converse(
            user, conversation, user_input=prompt, max_output_tokens=256)
    else:
        post = lambda: _client(user).post(
            "/api/ai/prompt/",
            {"model": str(ai_model.pk), "prompt": prompt,
             "max_output_tokens": 256},
            format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
    monkeypatch.setattr(
        providers, "stream_chat", lambda *_args, **_kwargs: _UsageStream(None))

    response = post()

    assert response.status_code == 200, response.content
    output_tokens = num_tokens_from_text("answer", ai_model.model)
    expected = ai_model.get_tuzi_price(estimated_input, output_tokens)
    assert balance(user) == Decimal("10000") - expected
    assert Event.objects.get(type="CHAT2Z", receiving_user=user).amount == expected
    if endpoint == "prompt":
        assert response.data["input_tokens"] == estimated_input


def _converse(user, conversation, **body):
    return _client(user).post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {"user_input": "q", **body}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))


@pytest.mark.django_db
@pytest.mark.parametrize("name", NAMES)
def test_conversation_charges_reasoning(name, creator_factory, fake_provider):
    rec = RECORDINGS[name]
    fake_provider(name)
    ai_model = AIModel.objects.create(**_row(name))
    user, conversation = _conversation(
        creator_factory, ai_model, tuzis="10000")
    _, input_tokens = conversation.build_messages("q")

    response = _converse(user, conversation)

    assert response.status_code == 200, response.content
    usage = providers._openai_compatible_usage(
        rec["provider"], _openai_chunks(name)[-1].usage
    ) if rec["provider"] != "anthropic" else providers._anthropic_usage(
        _anthropic_events(name)[0].message.usage,
        _anthropic_events(name)[-2].usage,
    )
    input_tokens = rec["expected_input_tokens"]
    price = ai_model.get_tuzi_price(
        input_tokens, rec["expected_output_tokens"],
        cached_input_tokens=usage.cached_input_tokens,
        cache_write_tokens=usage.cache_write_tokens,
        cache_write_1h_tokens=usage.cache_write_1h_tokens,
    )
    assert price > ai_model.get_tuzi_price(
        input_tokens, num_tokens_from_text(rec["visible_text"], ai_model.model))
    assert balance(user) == Decimal("10000") - price


@pytest.mark.django_db
def test_conversation_charge_never_exceeds_the_admitted_ceiling(
        creator_factory, monkeypatch, caplog):
    """xAI counts reasoning beside ``completion_tokens``, so the provider's
    output cap need not bound it. The debit stays at the ceiling the
    requester was admitted for instead of exceeding it (or 402ing after the
    provider bill)."""
    chunks = _openai_chunks("xai_reasoning")
    from openai.types.chat import ChatCompletionChunk
    runaway = RECORDINGS["xai_reasoning"]["chunks"][-1] | {"usage": {
        "prompt_tokens": 32, "completion_tokens": 9, "total_tokens": 200041,
        "completion_tokens_details": {"reasoning_tokens": 200000}}}
    chunks[-1] = ChatCompletionChunk.model_validate(runaway)
    client = FakeOpenAIClient(chunks)
    monkeypatch.setattr(providers, "get_client", lambda provider: client)

    ai_model = AIModel.objects.create(**_row("xai_reasoning"))
    user, conversation = _conversation(
        creator_factory, ai_model, tuzis="5000")
    _, input_tokens = conversation.build_messages("q")
    output_cap = ai_model.get_request_output_cap(input_tokens, 50)
    # The ceiling includes the reasoning allowance since; 200000
    # reasoning tokens still outrun it.
    ceiling = ai_model.get_admission_price(input_tokens, output_cap)
    assert ai_model.get_tuzi_price(input_tokens, 200009) > 5000 > ceiling

    with caplog.at_level("WARNING", logger="dj.apps.openai.views"):
        response = _converse(user, conversation, max_output_tokens=50)

    assert response.status_code == 200, response.content
    assert balance(user) == Decimal("5000") - ceiling
    # The platform absorbed the rest; that must be visible, not silent.
    assert any("clamped to the admitted ceiling" in r.getMessage()
               for r in caplog.records)


@pytest.mark.django_db
@pytest.mark.parametrize("endpoint", ["conversation", "prompt"])
@pytest.mark.parametrize("provider_name", ["openai_reasoning", "anthropic_thinking"])
def test_stream_rejected_before_first_event_releases_charge(
        endpoint, provider_name, creator_factory, monkeypatch):
    """Exercise real adapters and both ledger paths after HTTP acceptance."""
    import httpx2
    import anthropic

    def rejected():
        if provider_name == "anthropic_thinking":
            raise anthropic.APIStatusError(
                "overloaded_error", response=httpx2.Response(
                    529, request=httpx2.Request("POST", "https://api.anthropic.com")),
                body={"type": "error", "error": {"type": "overloaded_error"}})
        # An empty successful HTTP stream is equally not processing evidence.
        return
        yield  # pragma: no cover

    class RejectedAnthropicStream:
        def __enter__(self):
            return rejected()

        def __exit__(self, *_):
            return False

    sdk = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(
            create=lambda **_: rejected())),
        messages=SimpleNamespace(stream=lambda **_: RejectedAnthropicStream()),
    )
    sdk.with_options = lambda **_: sdk
    monkeypatch.setattr(providers, "get_client", lambda _: sdk)
    ai_model = AIModel.objects.create(**_row(provider_name))
    user, conversation = _conversation(creator_factory, ai_model)
    if endpoint == "conversation":
        response = _converse(user, conversation)
    else:
        response = _client(user).post(
            "/api/ai/prompt/", {"model": str(ai_model.pk), "prompt": "q"},
            format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
    assert response.status_code == 503
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert balance(user) == Decimal("1000")
    from dj.apps.ledger import api
    assert api.read_balance(user.pk).held == 0
    assert not Event.objects.filter(type="CHAT2Z", receiving_user=user).exists()


@pytest.mark.parametrize("provider_name", ["openai_reasoning", "anthropic_thinking"])
def test_real_adapter_final_usage_survives_trailing_transport_failure(
        provider_name, monkeypatch):
    def completed_then_failed():
        if provider_name == "anthropic_thinking":
            yield from _anthropic_events(provider_name)
        else:
            yield from _openai_chunks(provider_name)
        raise TimeoutError("connection lost after terminal usage")

    class TrailingFailureStream:
        def __enter__(self):
            return completed_then_failed()

        def __exit__(self, *_):
            return False

    sdk = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(
            create=lambda **_: completed_then_failed())),
        messages=SimpleNamespace(stream=lambda **_: TrailingFailureStream()),
    )
    sdk.with_options = lambda **_: sdk
    monkeypatch.setattr(providers, "get_client", lambda _: sdk)
    result = generate_reply(
        AIModel(**_row(provider_name)), [{"role": "user", "content": "q"}],
        10, 4096)
    rec = RECORDINGS[provider_name]
    assert result.response_text == rec["visible_text"]
    assert result.output_tokens == rec["expected_output_tokens"]
    assert result.usage.input_tokens == rec["expected_input_tokens"]


@pytest.mark.django_db
@pytest.mark.parametrize("endpoint", ["conversation", "prompt"])
def test_terminal_answer_without_usage_survives_disconnect_and_replays(
        endpoint, creator_factory, monkeypatch):
    calls = []

    def completed_then_failed(**_):
        calls.append(1)
        # Includes finish_reason=stop, but omits the later usage-only chunk.
        yield from _openai_chunks("openai_reasoning")[:4]
        raise TimeoutError("connection lost before usage")

    sdk = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
        create=completed_then_failed)))
    sdk.with_options = lambda **_: sdk
    monkeypatch.setattr(providers, "get_client", lambda _: sdk)
    ai_model = AIModel.objects.create(**_row("openai_reasoning"))
    user, conversation = _conversation(creator_factory, ai_model)
    client = _client(user)
    key = str(uuid.uuid4())
    if endpoint == "conversation":
        path = f"/api/ai/conversations/{conversation.pk}/promptresponses/"
        body = {"user_input": "q"}
    else:
        path = "/api/ai/prompt/"
        body = {"model": str(ai_model.pk), "prompt": "q"}
    response = client.post(path, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    assert response.status_code == 200, response.content
    assert response.data["response"] == RECORDINGS["openai_reasoning"]["visible_text"]
    charged_balance = balance(user)
    replay = client.post(path, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    assert replay.status_code == 200
    assert replay.data == response.data
    assert balance(user) == charged_balance
    assert calls == [1]
