"""xAI reasoning is not bounded by any output cap we send.

xAI documents that ``max_completion_tokens`` "only applies to visible output
tokens (i.e. does not apply to tokens used for reasoning or function calls)",
that grok-4.5 reasoning "cannot be disabled", and that ``reasoning_effort``
defaults to ``"high"`` (https://docs.x.ai/docs/guides/reasoning). After
the chat paths bill xAI's real output (completion + reasoning) but clamp it to
the ceiling admitted for the visible cap. A requester naming 256 output
tokens was admitted at about 1 2Z, and every reasoning token past that was
paid by the platform.

The conservative fix tested here:

* (a) grok models are sent ``reasoning_effort="low"`` (accepted values
  checked against xAI's per-model catalogue), with a one-time fallback if a
  model rejects the parameter;
* (b) admission, the metered hold and the clamp all use the visible cap PLUS a
  per-model reasoning allowance (``AIModel.get_admission_price``), so typical
  reasoning is paid by the requester;
* (c) a clamp that still binds writes ONE structured ``ai_charge_clamped``
  line, which ``monitoring/log-metrics/ai-charge-clamped.json`` counts.

Payloads are the documented xAI usage shape from
``testdata/provider_usage_streams.json`` (validated against the pinned SDK's
own pydantic model), with the reasoning count raised. Only the SDK client is
faked. The real adapters, the real views, real Postgres and the real ledger
run. No provider is called.
"""
from decimal import Decimal
import json
import pathlib
import uuid
from types import SimpleNamespace

import pytest
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator
from f2z.ai import providers

from .management.commands.seed_ai_models import LINEUP
from .models import AIModel, Conversation, num_tokens_from_messages
from .models import AI_REASONING_UNMETERED_EVENT
from .views import AI_CHARGE_CLAMPED_EVENT, charge_clamped_payload

RECORDINGS = json.loads(
    (pathlib.Path(__file__).parent / "testdata" / "provider_usage_streams.json")
    .read_text()
)

# grok-4.5 at xAI's own price, as  /  charge it: $2 in / $6 out per
# 1M, x1.5. The numbers in  are computed from these.
GROK45 = dict(
    provider="xai", model="grok-4.5", display_name="Grok 4.5",
    system_message="You are terse.", max_tokens=172000,
    max_output_tokens=8192, max_response_tokens=8192,
    input_price="0.000002", output_price="0.000006", markup="1.5",
    is_ga=True,
)


def _xai_chunks(reasoning_tokens, completion_tokens=9):
    """The recorded xAI stream with ``reasoning_tokens`` of hidden reasoning.

    Same shape xAI documents: ``total = prompt + completion + reasoning``.
    """
    from openai.types.chat import ChatCompletionChunk

    raw = [dict(c) for c in RECORDINGS["xai_reasoning"]["chunks"]]
    usage = raw[-1]["usage"]
    raw[-1] = raw[-1] | {"usage": usage | {
        "completion_tokens": completion_tokens,
        "total_tokens": (usage["prompt_tokens"] + completion_tokens
                         + reasoning_tokens),
        "completion_tokens_details": usage["completion_tokens_details"] | {
            "reasoning_tokens": reasoning_tokens},
    }}
    return [ChatCompletionChunk.model_validate(c) for c in raw]


class _ParamRejected(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


class FakeOpenAIClient:
    """``client.chat.completions.create(**kw)`` -> the recorded chunks."""

    def __init__(self, chunks, reject=None):
        self._chunks = chunks
        self._reject = reject  # (param, exception) or None
        self.calls = []
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create))

    def with_options(self, **_):
        return self

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._reject is not None and self._reject[0] in kwargs:
            raise self._reject[1]
        return iter(list(self._chunks))


@pytest.fixture(autouse=True)
def _fresh_provider_memory():
    def clear():
        providers._stream_usage_unsupported.clear()
        providers._max_output_param_learned.clear()
        providers._reasoning_effort_unsupported.clear()
    clear()
    yield
    clear()


@pytest.fixture(autouse=True)
def _mock_configured_provider_key(monkeypatch):
    """Only provider adapters mocked in this module are selectable."""
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers",
        lambda: {"openai", "xai"},
    )


@pytest.fixture
def xai(monkeypatch):
    """Install a fake xAI client streaming ``reasoning`` hidden tokens."""
    def install(reasoning=110, **kwargs):
        client = FakeOpenAIClient(_xai_chunks(reasoning), **kwargs)
        monkeypatch.setattr(providers, "get_client", lambda provider: client)
        return client
    return install


def _client(user):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return client


def balance(user):
    return Creator.objects.get(pk=user.pk).tuzis


def _prompt(user, ai_model, **body):
    return _client(user).post(
        "/api/ai/prompt/",
        {"model": str(ai_model.pk), "prompt": "q", **body},
        format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))


def _prompt_input_tokens(ai_model):
    return num_tokens_from_messages([
        {"role": "system", "content": ai_model.system_message},
        {"role": "user", "content": "q"},
    ])


def _converse(user, conversation, **body):
    return _client(user).post(
        f"/api/ai/conversations/{conversation.id}/promptresponses/",
        {"user_input": "q", **body}, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))


def _event_records(caplog, event):
    out = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get("event") == event:
            out.append(payload)
    return out


def _clamp_records(caplog):
    return _event_records(caplog, AI_CHARGE_CLAMPED_EVENT)




# --------------------------------------------------------------------------- #
# (a) reasoning_effort on the wire
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
@pytest.mark.parametrize("model", ["grok-4.5", "grok-4.3"])
def test_grok_chat_is_sent_low_reasoning_effort(model, creator_factory, xai):
    """grok-4.5 defaults to "high" and cannot turn reasoning off. "low" is
    one of its documented ``supportedEfforts``. grok-4.3 already defaults to
    "low", and it is pinned so a change to xAI's default cannot move costs."""
    client = xai()
    ai_model = AIModel.objects.create(**(GROK45 | {"model": model}))
    user = creator_factory(tuzis=Decimal("1000"))
    conversation = Conversation.objects.create(
        user=user, ai_model=ai_model, display_name="c")

    response = _converse(user, conversation)

    assert response.status_code == 200, response.content
    assert len(client.calls) == 1
    assert client.calls[0]["reasoning_effort"] == "low"
    # And the visible cap is still sent; the effort does not replace it.
    assert ("max_tokens" in client.calls[0]
            or "max_completion_tokens" in client.calls[0])


@pytest.mark.parametrize("provider,model", [
    ("openai", "gpt-5.6-sol"),
    ("openai", "gpt-4o"),
    ("xai", "grok-operator-added"),
])
def test_no_effort_is_sent_where_none_is_declared(provider, model, monkeypatch):
    """OpenAI's cap already bounds reasoning, and an xAI model nobody has
    checked against xAI's catalogue gets no guessed effort value."""
    client = FakeOpenAIClient(_xai_chunks(0))
    list(providers._create_capped(
        client, provider, model, [{"role": "user", "content": "q"}], 256))
    assert "reasoning_effort" not in client.calls[0]


@pytest.mark.django_db
def test_a_model_that_rejects_reasoning_effort_still_chats(
        creator_factory, xai, caplog):
    """A 400 ABOUT the parameter is retried once without it and remembered.
    Losing the effort costs a longer tail, which the allowance and the clamp
    alert still bound. Losing chat would cost everything."""
    client = xai(reject=("reasoning_effort", _ParamRejected(
        "Error code: 400 - Argument not supported on this model: "
        "reasoning_effort")))
    ai_model = AIModel.objects.create(**GROK45)
    user = creator_factory(tuzis=Decimal("1000"))
    conversation = Conversation.objects.create(
        user=user, ai_model=ai_model, display_name="c")

    with caplog.at_level("WARNING", logger="f2z.ai.providers"):
        first = _converse(user, conversation)
        second = _converse(user, conversation)

    assert first.status_code == 200, first.content
    assert second.status_code == 200, second.content
    sent = ["reasoning_effort" in call for call in client.calls]
    # rejected, retried without it, then never asked again
    assert sent == [True, False, False]
    # stream_options (usage, i.e. the reasoning charge) survived the retry
    assert all("stream_options" in call for call in client.calls)
    assert any("rejected reasoning_effort" in r.getMessage()
               for r in caplog.records)


def test_a_throttle_that_names_reasoning_effort_is_not_retried():
    """Only a 400 earns the retry. A 429 is never a parameter complaint, and
    retrying into a throttled provider doubles the pressure."""
    throttled = _ParamRejected(
        "rate limited; reasoning_effort requests unsupported right now",
        status_code=429)
    client = FakeOpenAIClient(
        _xai_chunks(0), reject=("reasoning_effort", throttled))
    with pytest.raises(_ParamRejected):
        providers._create_capped(
            client, "xai", "grok-4.5", [{"role": "user", "content": "q"}], 256)
    assert len(client.calls) == 1
    assert ("xai", "grok-4.5") not in providers._reasoning_effort_unsupported


# --------------------------------------------------------------------------- #
# (b) the admitted ceiling covers typical reasoning
# --------------------------------------------------------------------------- #
def test_only_xai_rows_carry_a_reasoning_allowance():
    """OpenAI and Anthropic caps bound reasoning, so their admission price is
    unchanged. Every seeded xAI row gets an allowance."""
    for (provider, model, _d, in_p, out_p, max_tok, reserve, limit, _o,
         _ga) in LINEUP:
        ai_model = AIModel(
            provider=provider, model=model, display_name=model,
            system_message="", max_tokens=max_tok, max_output_tokens=reserve,
            max_response_tokens=limit, input_price=Decimal(in_p),
            output_price=Decimal(out_p), markup=Decimal("1.5"))
        allowance = ai_model.get_reasoning_allowance()
        if provider == "xai":
            assert allowance > 0, model
            assert ai_model.get_admission_price(1000, 256) == \
                ai_model.get_tuzi_price(1000, 256 + allowance), model
            assert ai_model.get_admission_price(1000, 256) > \
                ai_model.get_max_tuzi_price(1000, 256), model
        else:
            assert allowance == 0, model
            assert ai_model.get_admission_price(1000, 256) == \
                ai_model.get_max_tuzi_price(1000, 256), model


def test_an_operator_added_xai_model_fails_closed():
    """A row added in the admin that the code table does not name still
    reasons unbounded on xAI. Admitting it as if it reasons only raises the
    entry bar; the charge is still metered."""
    ai_model = AIModel(**(GROK45 | {"model": "grok-9-preview"}))
    assert ai_model.get_reasoning_allowance() == \
        providers.XAI_DEFAULT_REASONING_ALLOWANCE > 0


@pytest.mark.django_db
def test_the_issue_exploit_is_refused_at_admission(creator_factory, xai):
    """'s exploit: name ``max_output_tokens=256`` on grok-4.5. That
    ceiling is about 1 2Z, and before this fix a requester holding a few 2Z
    was admitted for a reasoning bill 18x that. The ceiling now includes the
    reasoning allowance, so they are refused BEFORE the provider is called,
    and told the real ceiling."""
    client = xai(reasoning=12000)
    ai_model = AIModel.objects.create(**GROK45)
    user = creator_factory(tuzis=Decimal("5"))
    input_tokens = _prompt_input_tokens(ai_model)
    assert ai_model.get_max_tuzi_price(input_tokens, 256) <= 1, \
        "fixture must reproduce the issue's ~1 2Z ceiling"

    response = _prompt(user, ai_model, max_output_tokens=256)

    assert response.status_code == 402, response.content
    assert Decimal(response.data["cost"]) == \
        ai_model.get_admission_price(input_tokens, 256) > 5
    assert client.calls == [], "refused before the provider is billed"
    assert balance(user) == Decimal("5")


@pytest.mark.django_db
@pytest.mark.parametrize("path", ["metered", "conversation"])
def test_reasoning_within_the_allowance_is_charged_in_full(
        path, creator_factory, xai, caplog):
    """12000 reasoning tokens behind a 256-token cap: the requester pays all
    of it (about 11 2Z), not the ~1 2Z the visible cap priced. Nothing is
    clamped, so nothing is absorbed."""
    xai(reasoning=12000)
    ai_model = AIModel.objects.create(**GROK45)
    user = creator_factory(tuzis=Decimal("1000"))

    with caplog.at_level("WARNING", logger="dj.apps.openai.views"):
        if path == "metered":
            input_tokens = _prompt_input_tokens(ai_model)
            response = _prompt(user, ai_model, max_output_tokens=256)
        else:
            conversation = Conversation.objects.create(
                user=user, ai_model=ai_model, display_name="c")
            _, input_tokens = conversation.build_messages("q")
            response = _converse(user, conversation, max_output_tokens=256)

    assert response.status_code == 200, response.content
    metered = ai_model.get_tuzi_price(input_tokens, 12009)
    assert metered > ai_model.get_max_tuzi_price(input_tokens, 256) * 5
    assert balance(user) == Decimal("1000") - metered
    assert _clamp_records(caplog) == []


@pytest.mark.django_db
def test_the_named_nothing_length_fits_the_admission_price(
        creator_factory, xai):
    """With no ``max_output_tokens``, the reply length is the longest the
    requester's 2Z cover. It must leave room for the allowance, or a
    requester who could afford a shorter reply is 402'd for the model's full
    length."""
    client = xai()
    ai_model = AIModel.objects.create(**GROK45)
    input_tokens = _prompt_input_tokens(ai_model)
    holding = Decimal("20")
    assert ai_model.get_admission_price(input_tokens, 8192) > holding, \
        "fixture must make the full length unaffordable"

    user = creator_factory(tuzis=holding)
    response = _prompt(user, ai_model)

    assert response.status_code == 200, response.content
    sent = client.calls[0].get("max_tokens") or \
        client.calls[0].get("max_completion_tokens")
    assert 256 <= sent < 8192
    assert ai_model.get_admission_price(input_tokens, sent) <= holding
    for tuzis in ("16", "20", "57", "100.999"):
        out = ai_model.get_affordable_output_tokens(
            input_tokens, Decimal(tuzis))
        assert ai_model.get_admission_price(input_tokens, out) <= \
            Decimal(tuzis), tuzis


# --------------------------------------------------------------------------- #
# (c) a clamp that still binds is one structured, counted line
# --------------------------------------------------------------------------- #


def test_a_clamp_that_binds_only_the_markup_absorbs_nothing():
    """18009 output tokens: the metered retail price is over the ceiling, but
    xAI's bill (the cost columns) is not. Nothing came out of our pocket, and
    the line must not say otherwise, or the runbook sum overstates the loss
    and someone raises the allowance for nothing."""
    ai_model = AIModel(**GROK45)
    ceiling = ai_model.get_admission_price(17, 256)
    metered = ai_model.get_tuzi_price(17, 18009)
    assert metered > ceiling, "fixture must make the clamp bind"
    line = charge_clamped_payload(
        ai_model, 17, 18009, metered, ceiling, endpoint="ai_prompt",
        user_id=1)
    assert line["uncharged_2z"] > 0
    assert line["provider_cost_2z"] < ceiling
    assert line["absorbed_2z"] == 0




@pytest.mark.django_db
def test_a_capped_provider_without_usage_is_not_reported(
        creator_factory, monkeypatch, caplog):
    """OpenAI's cap bounds its reasoning, so a missing usage report there is
    the old, already-logged estimate, not a reasoning loss to count."""
    client = FakeOpenAIClient(_xai_chunks(0)[:-1])
    monkeypatch.setattr(providers, "get_client", lambda provider: client)
    ai_model = AIModel.objects.create(
        **(GROK45 | {"provider": "openai", "model": "gpt-4o"}))
    user = creator_factory(tuzis=Decimal("1000"))

    with caplog.at_level("INFO", logger="dj.apps.openai.models"):
        response = _prompt(user, ai_model, max_output_tokens=256)

    assert response.status_code == 200, response.content
    assert _event_records(caplog, AI_REASONING_UNMETERED_EVENT) == []
