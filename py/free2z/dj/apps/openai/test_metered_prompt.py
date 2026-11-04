"""``POST /api/ai/prompt/`` -- the synchronous, model-aware, metered prompt.

The legacy ``/api/openai/prompt`` charges a flat 1 2Z on the one
``PROMPT_COMPLETION_MODEL`` (``gpt-3.5-turbo-instruct`` until its retirement,
); the only metered path was the conversation
endpoint, which needs a Conversation row. This endpoint takes a ``model`` from
``/api/ai/models/``, proxies one prompt to the provider, meters the real token
counts through the SAME ``AIModel`` pricing the conversation path uses, debits
``Creator.tuzis`` atomically and answers
``{response, tuzis_charged, input_tokens, output_tokens}``.

Money-path tests, in the order the money moves:

* the charge uses provider-reported input/output usage and cache categories,
  falling back to the model encoding for input when usage is unavailable;
* a balance that cannot cover the request's CEILING is refused with 402 BEFORE
  the provider is called (a 402 after the provider bill was the  hole);
* a provider failure charges nothing;
* the ceiling is HELD (``ledger.reserve``) while the provider generates, so a
  concurrent request cannot spend the same balance into a second provider
  bill, and the difference is returned once the reply is priced;
* the legacy endpoint keeps working, flat 1 2Z, untouched.

Real Postgres throughout; only the provider SDK boundary is faked. Nothing
here mocks ``ledger.debit`` -- the debit is the thing under test.
"""
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
import uuid

import pytest

from rest_framework.test import APIClient
from django.utils import timezone

from dj.apps.events.models import Event
from dj.apps.g12f.models import Creator
from dj.apps.tuzis.models import IdempotencyKey, STALE_CLAIM, fingerprint

from .models import (
    MIN_REQUEST_OUTPUT_TOKENS, AIModel, PromptResponse,
    num_tokens_from_messages, num_tokens_from_text,
)

URL = "/api/ai/prompt/"
LEGACY_URL = "/api/openai/prompt"
REPLY = "answer"


@pytest.fixture(autouse=True)
def _mock_provider_configuration(monkeypatch):
    """Selectable rows use fixture configuration, never ambient API keys."""
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: {"openai", "anthropic", "xai"},
    )


def _model(**overrides):
    fields = dict(
        provider="openai", model="gpt-5.6-sol", display_name="GPT-5.6 Sol",
        system_message="You are terse.", max_tokens=400000,
        max_output_tokens=16384, max_response_tokens=128000,
        input_price="0.000005", output_price="0.00003", markup="1.5",
        is_ga=True,
    )
    fields.update(overrides)
    return AIModel.objects.create(**fields)


def _client(user):
    client = APIClient()
    client.force_authenticate(user=Creator.objects.get(pk=user.pk))
    return client


def _post(client, ai_model, prompt="hello", **extra):
    body = {"model": str(ai_model.pk), "prompt": prompt}
    body.update({k: v for k, v in extra.items() if v is not None})
    return client.post(
        URL, body, format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )


def balance(user):
    return Creator.objects.get(pk=user.pk).tuzis


def _expected_messages(ai_model, prompt, system_message=None):
    system = ai_model.system_message if system_message is None else system_message
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return messages


@pytest.fixture
def provider_calls(monkeypatch):
    """Record every ``stream_chat`` call and answer with a fixed reply."""
    calls = []

    def fake_stream(ai_model, messages, **kwargs):
        calls.append({"ai_model": ai_model, "messages": messages, **kwargs})
        yield REPLY

    monkeypatch.setattr("f2z.ai.providers.stream_chat", fake_stream)
    return calls


# --------------------------------------------------------------------------- #
# 1. Exact charge.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_charges_exactly_the_metered_price_and_reports_it(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    response = _post(_client(user), ai_model, prompt="hello there")

    assert response.status_code == 200, response.content
    messages = _expected_messages(ai_model, "hello there")
    input_tokens = num_tokens_from_messages(messages, ai_model.model)
    output_tokens = num_tokens_from_text(REPLY, ai_model.model)
    price = ai_model.get_tuzi_price(input_tokens, output_tokens)
    assert price > 0, "a priced request must cost something"

    assert response.data == {
        "response": REPLY,
        "provider": ai_model.provider,
        "model": ai_model.model,
        "display_name": ai_model.display_name,
        "tuzis_charged": price,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
    assert Decimal("1000") - balance(user) == Decimal(price), (
        "the balance must move by exactly the reported charge")

    # The provider was called once, with the model named, the messages that
    # were priced, and a hard output cap.
    assert len(provider_calls) == 1
    call = provider_calls[0]
    assert call["ai_model"].pk == ai_model.pk
    assert call["messages"] == messages
    assert call["max_output_tokens"] >= MIN_REQUEST_OUTPUT_TOKENS
    assert call["max_output_tokens"] <= ai_model.get_request_output_cap(
        input_tokens)

    # A receipt, same event type the conversation path writes.
    receipt = Event.objects.get(type="CHAT2Z", receiving_user=user)
    assert receipt.amount == price
    # Nothing else was stored: this endpoint has no transcript.
    assert not PromptResponse.objects.exists()


@pytest.mark.django_db
def test_the_price_follows_the_model_named(creator_factory, provider_calls):
    """Two models, two prices, same prompt: the charge is the model's."""
    cheap = _model(model="gpt-4o", input_price="0.0000025",
                   output_price="0.00001", markup="1")
    dear = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)

    # ~20k prompt tokens, so the two prices do not both round up to 1 2Z.
    prompt = "hello " * 20000
    cheap_charge = _post(client, cheap, prompt=prompt).data["tuzis_charged"]
    dear_charge = _post(client, dear, prompt=prompt).data["tuzis_charged"]

    assert 1 < cheap_charge < dear_charge
    assert Decimal("1000") - balance(user) == Decimal(
        cheap_charge + dear_charge)


@pytest.mark.django_db
def test_max_output_tokens_caps_the_provider_request(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    response = _post(_client(user), ai_model, max_output_tokens=300)

    assert response.status_code == 200, response.content
    assert provider_calls[0]["max_output_tokens"] == 300


@pytest.mark.django_db
def test_system_message_is_the_requesters_when_given(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)

    _post(client, ai_model, system_message="Answer in French.")
    _post(client, ai_model, system_message="")

    assert provider_calls[0]["messages"] == [
        {"role": "system", "content": "Answer in French."},
        {"role": "user", "content": "hello"},
    ]
    assert provider_calls[1]["messages"] == [
        {"role": "user", "content": "hello"},
    ], "an empty system message means no system message"


# --------------------------------------------------------------------------- #
# 2. Insufficient balance refuses BEFORE the provider is called.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_insufficient_balance_is_refused_without_calling_the_provider(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1"))

    # ~150k input tokens: ceil(150000 * 0.000005 * 150) = 113 2Z of prompt
    # alone, before a single token of reply.
    response = _post(_client(user), ai_model, prompt="hello " * 150000)

    assert response.status_code == 402, response.content
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert provider_calls == [], (
        "the provider was called for a request that could not be paid for -- "
        "that call is billed to us whatever we return to the user (#1033)"
    )
    assert balance(user) == Decimal("1"), "balance moved on a refused request"
    assert response.data["action"] == "ai_prompt"
    assert Decimal(response.data["cost"]) > 1
    assert Decimal(response.data["balance"]) == Decimal("1")
    assert not Event.objects.filter(type="CHAT2Z").exists()


@pytest.mark.django_db
def test_a_named_length_the_balance_cannot_cover_is_refused(
        creator_factory, provider_calls):
    """Asking for a long reply with too few 2Z is a 402 naming the ceiling,
    not a silently shorter reply and not a provider call."""
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("5"))

    response = _post(_client(user), ai_model, max_output_tokens=100000)

    assert response.status_code == 402, response.content
    assert provider_calls == []
    assert Decimal(response.data["cost"]) == ai_model.get_admission_price(
        num_tokens_from_messages(
            _expected_messages(ai_model, "hello"), ai_model.model),
        100000,
    )
    assert balance(user) == Decimal("5")


@pytest.mark.django_db
def test_zero_balance_is_refused(creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("0"))

    response = _post(_client(user), ai_model)

    assert response.status_code == 402, response.content
    assert provider_calls == []
    assert balance(user) == Decimal("0")


# --------------------------------------------------------------------------- #
# 3. Provider failure charges nothing.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_provider_failure_charges_nothing(creator_factory, monkeypatch):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    def boom(ai_model, messages, **kwargs):
        raise RuntimeError("provider is down")
        yield  # pragma: no cover -- makes this a generator like the real one

    monkeypatch.setattr("f2z.ai.providers.stream_chat", boom)

    response = _post(_client(user), ai_model)

    assert response.status_code == 503, response.content
    assert balance(user) == Decimal("1000")
    assert not Event.objects.filter(type="CHAT2Z").exists()


@pytest.mark.django_db
def test_a_started_stream_that_dies_charges_the_observed_estimate(
        creator_factory, monkeypatch):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    def dying(ai_model, messages, **kwargs):
        yield "partial "
        raise ConnectionError("stream reset")

    monkeypatch.setattr("f2z.ai.providers.stream_chat", dying)

    response = _post(_client(user), ai_model, max_output_tokens=512)

    assert response.status_code == 503, response.content
    input_tokens = num_tokens_from_messages(
        _expected_messages(ai_model, "hello"))
    ceiling = ai_model.get_admission_price(input_tokens, 512)
    observed = ai_model.get_tuzi_price(
        input_tokens, num_tokens_from_text("partial "))
    assert observed < ceiling
    assert balance(user) == Decimal("1000") - Decimal(observed)
    receipt = Event.objects.get(type="CHAT2Z", receiving_user=user)
    assert receipt.amount == observed
    from dj.apps.ledger import api
    assert api.read_balance(user.pk).held == 0


@pytest.mark.django_db
def test_interrupted_reasoning_without_visible_text_is_not_assumed_consumed(
        creator_factory, monkeypatch):
    ai_model = _model(provider="xai", model="grok-4.5",
                      display_name="Grok 4.5")
    user = creator_factory(tuzis=Decimal("1000"))

    def thinking_then_disconnect(ai_model, messages, **kwargs):
        yield ""  # provider activity with no user-visible text
        raise TimeoutError("read timed out")

    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat", thinking_then_disconnect)

    response = _post(_client(user), ai_model, max_output_tokens=512)

    assert response.status_code == 503, response.content
    input_tokens = num_tokens_from_messages(
        _expected_messages(ai_model, "hello"))
    observed = ai_model.get_tuzi_price(input_tokens, 0)
    ceiling = ai_model.get_admission_price(input_tokens, 512)
    assert ceiling > ai_model.get_tuzi_price(input_tokens, 0)
    assert Decimal("1000") - balance(user) == Decimal(observed)
    assert Event.objects.get(type="CHAT2Z", receiving_user=user).amount == observed
    assert response.data["charge_status"] == "settled"
    assert response.data["tuzis_charged"] == observed


@pytest.mark.django_db
def test_an_interrupted_idempotent_call_cannot_be_charged_twice(
        creator_factory, monkeypatch):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    calls = []

    def dying(ai_model, messages, **kwargs):
        calls.append(1)
        yield "partial"
        raise ConnectionError("stream reset")

    monkeypatch.setattr("f2z.ai.providers.stream_chat", dying)
    body = {"model": str(ai_model.pk), "prompt": "hello",
            "max_output_tokens": 512}
    first = client.post(
        URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    after_first = balance(user)
    replay = client.post(
        URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert first.status_code == replay.status_code == 503
    assert balance(user) == after_first
    assert calls == [1]
    assert Event.objects.filter(type="CHAT2Z", receiving_user=user).count() == 1


# --------------------------------------------------------------------------- #
# 4. The ceiling is HELD while the provider generates.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_the_ceiling_is_held_during_generation_and_the_rest_returned(
        creator_factory, monkeypatch):
    """Admission reserves the most the request can cost; settlement charges
    the actual price and returns the difference."""
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    seen = {}

    def observe_mid_stream(ai_model, messages, **kwargs):
        from dj.apps.ledger import api
        seen["balance_mid_stream"] = api.from_m2z(api.read_balance(user.pk).available)
        seen["max_output_tokens"] = kwargs["max_output_tokens"]
        yield REPLY

    monkeypatch.setattr("f2z.ai.providers.stream_chat", observe_mid_stream)

    response = _post(_client(user), ai_model, max_output_tokens=1000)

    assert response.status_code == 200, response.content
    input_tokens = num_tokens_from_messages(
        _expected_messages(ai_model, "hello"), ai_model.model)
    ceiling = ai_model.get_admission_price(input_tokens, 1000)
    assert seen["max_output_tokens"] == 1000
    assert seen["balance_mid_stream"] == Decimal("1000") - Decimal(ceiling), (
        "the ceiling must be out of the spendable balance while the "
        "provider is generating")
    price = response.data["tuzis_charged"]
    assert 0 < price < ceiling
    assert balance(user) == Decimal("1000") - Decimal(price), (
        "only the actual price stays charged")


@pytest.mark.django_db
def test_a_concurrent_request_cannot_spend_the_held_balance(
        creator_factory, monkeypatch):
    """Two requests, one balance that covers exactly one ceiling. The second
    arrives while the first is still generating. Pre-hold, both passed a
    balance-only read and BOTH reached the provider -- two provider bills,
    one debit. With the hold the second is refused before the provider and
    the first settles normally."""
    ai_model = _model()
    input_tokens = num_tokens_from_messages(
        _expected_messages(ai_model, "hello"), ai_model.model)
    ceiling = ai_model.get_admission_price(input_tokens, 1000)
    user = creator_factory(tuzis=Decimal(ceiling + 1))
    client = _client(user)
    calls = []
    inner = {}

    def first_generation(ai_model, messages, **kwargs):
        calls.append("first")
        # A second request lands while the first is mid-generation.
        inner["response"] = client.post(
            URL, {"model": str(ai_model.pk), "prompt": "hello",
                  "max_output_tokens": 1000},
            format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
        yield REPLY

    monkeypatch.setattr("f2z.ai.providers.stream_chat", first_generation)

    response = _post(client, ai_model, max_output_tokens=1000)

    assert response.status_code == 200, response.content
    assert inner["response"].status_code == 402, inner["response"].content
    assert calls == ["first"], (
        "the concurrent request reached the provider -- that call is billed "
        "to us and could never have been paid for")
    assert Decimal(inner["response"].data["balance"]) == Decimal("1")
    assert balance(user) == Decimal(ceiling + 1) - Decimal(
        response.data["tuzis_charged"])
    assert Event.objects.filter(type="CHAT2Z").count() == 1


@pytest.mark.django_db
def test_a_stale_swept_hold_cannot_be_double_spent(
        creator_factory, monkeypatch):
    """If the hold has already been returned (a killed worker's hold swept
    by a later reserve) AND the balance was then spent, settlement must
    refuse rather than charge a balance that is not there or hand out the
    reply for free."""
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    def sweep_and_spend_mid_stream(ai_model, messages, **kwargs):
        from dj.apps.tuzis.models import ProviderReservation
        for row in ProviderReservation.objects.filter(user_id=user.pk):
            from dj.apps.tuzis import ledger
            ledger.release_reservation(row)
        Creator.objects.filter(pk=user.pk).update(tuzis=Decimal("0"))
        yield "the answer is forty-two"

    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat", sweep_and_spend_mid_stream)

    response = _post(_client(user), ai_model)

    assert response.status_code == 402, response.content
    assert "forty-two" not in response.content.decode()
    assert balance(user) == Decimal("0")
    assert not Event.objects.filter(type="CHAT2Z").exists()


@pytest.mark.django_db
def test_the_charge_never_exceeds_the_admitted_ceiling(
        creator_factory, monkeypatch):
    """The provider caps the reply in ITS tokens; we price it in tiktoken's.
    A reply that retokenizes locally to more than the cap must still cost no
    more than the ceiling the requester was admitted against."""
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    def over_long(ai_model, messages, **kwargs):
        assert kwargs["max_output_tokens"] == 1
        yield "word " * 5000

    monkeypatch.setattr("f2z.ai.providers.stream_chat", over_long)

    response = _post(_client(user), ai_model, max_output_tokens=1)

    assert response.status_code == 200, response.content
    input_tokens = num_tokens_from_messages(
        _expected_messages(ai_model, "hello"), ai_model.model)
    ceiling = ai_model.get_admission_price(input_tokens, 1)
    assert response.data["output_tokens"] > 1, "reported as counted"
    assert ai_model.get_tuzi_price(input_tokens, response.data["output_tokens"]) > ceiling
    assert response.data["tuzis_charged"] == ceiling
    assert balance(user) == Decimal("1000") - Decimal(ceiling)


@pytest.mark.django_db
def test_a_failed_settlement_returns_the_hold(creator_factory, monkeypatch):
    """If settlement dies after the provider answered (the receipt write
    fails), the error surfaces AND the hold is returned -- the user is not
    left with a depleted balance until the stale sweep."""
    from dj.apps.tuzis.models import ProviderReservation
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    def fake_stream(ai_model, messages, **kwargs):
        yield REPLY

    monkeypatch.setattr("f2z.ai.providers.stream_chat", fake_stream)

    def boom(*args, **kwargs):
        raise RuntimeError("receipt write failed")

    monkeypatch.setattr(Event.objects, "create", boom)

    with pytest.raises(RuntimeError, match="receipt write failed"):
        _post(_client(user), ai_model)

    assert balance(user) == Decimal("1000")
    assert not ProviderReservation.objects.filter(
        user_id=user.pk, status="active").exists()


# --------------------------------------------------------------------------- #
# 5. Model resolution.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_an_unknown_model_is_404_and_free(creator_factory, provider_calls):
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)

    response = client.post(
        URL, {"model": str(uuid.uuid4()), "prompt": "hi"}, format="json")

    assert response.status_code == 404, response.content
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_unknown_model_with_idempotency_key_releases_fresh_claim(
        creator_factory, provider_calls):
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())

    response = client.post(
        URL,
        {"model": str(uuid.uuid4()), "prompt": "hi"},
        format="json",
        HTTP_IDEMPOTENCY_KEY=key,
    )

    assert response.status_code == 404, response.content
    assert not IdempotencyKey.objects.filter(
        scope="ai_prompt", user=user, key=key
    ).exists()
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_expected_actor_mismatch_refuses_before_claim_or_provider(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))

    response = _client(user).post(
        URL,
        {"model": str(ai_model.pk), "prompt": "hi"},
        format="json",
        HTTP_X_EXPECTED_ACTOR=str(user.pk + 1),
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 409
    assert response.data["code"] == "account_changed"
    assert not IdempotencyKey.objects.filter(user=user, scope="ai_prompt").exists()
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_a_model_outside_the_catalogue_is_404(creator_factory, provider_calls):
    """Not GA means not in GET /api/ai/models/, so not nameable here."""
    ai_model = _model(is_ga=False)
    user = creator_factory(tuzis=Decimal("1000"))

    response = _post(_client(user), ai_model)

    assert response.status_code == 404, response.content
    assert provider_calls == []


@pytest.mark.django_db
def test_a_disabled_model_is_409_and_free(creator_factory, provider_calls):
    ai_model = _model(is_enabled=False)
    user = creator_factory(tuzis=Decimal("1000"))

    response = _post(_client(user), ai_model)

    assert response.status_code == 409, response.content
    assert ai_model.display_name in response.data["detail"]
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_a_prompt_that_cannot_fit_the_window_is_400_and_free(
        creator_factory, provider_calls):
    ai_model = _model(max_tokens=2000, max_output_tokens=1000,
                      max_response_tokens=1000)
    user = creator_factory(tuzis=Decimal("1000"))

    response = _post(_client(user), ai_model, prompt="hello " * 2000)

    assert response.status_code == 400, response.content
    assert response.data["charge_status"] == "not_charged"
    assert response.data["tuzis_charged"] == 0
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_body_is_validated(creator_factory, provider_calls):
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    ai_model = _model()

    invalid = client.post(URL, {"prompt": "hi"}, format="json")
    assert invalid.status_code == 400
    assert invalid.data["charge_status"] == "not_charged"
    assert invalid.data["tuzis_charged"] == 0
    assert client.post(
        URL, {"model": "not-a-uuid", "prompt": "hi"}, format="json",
    ).status_code == 400
    assert client.post(
        URL, {"model": str(ai_model.pk)}, format="json").status_code == 400
    assert client.post(
        URL, {"model": str(ai_model.pk), "prompt": ""}, format="json",
    ).status_code == 400
    assert provider_calls == []


@pytest.mark.django_db
def test_malformed_json_is_a_detail_only_free_parser_error(
        creator_factory, provider_calls):
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)

    response = client.post(
        URL, data='{"prompt":', content_type="application/json",
    )

    assert response.status_code == 400, response.content
    assert set(response.data) == {"detail"}
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_anonymous_is_refused(provider_calls):
    ai_model = _model()
    response = APIClient().post(
        URL, {"model": str(ai_model.pk), "prompt": "hi"}, format="json")
    assert response.status_code in (401, 403), response.content
    assert provider_calls == []


# --------------------------------------------------------------------------- #
# 6. Idempotency: a retry with the same key replays, and charges once.
# --------------------------------------------------------------------------- #
@pytest.mark.django_db
def test_a_retry_with_the_same_key_replays_and_charges_once(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    body = {"model": str(ai_model.pk), "prompt": "hello"}

    first = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    second = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert first.status_code == 200, first.content
    assert second.status_code == 200, second.content
    assert second.data == first.data
    assert len(provider_calls) == 1, "a replay must not call the provider"
    assert Decimal("1000") - balance(user) == Decimal(
        first.data["tuzis_charged"])


@pytest.mark.django_db
@pytest.mark.parametrize("retirement", [False, True])
def test_a_paid_receipt_replays_even_after_the_model_is_disabled(
        creator_factory, provider_calls, retirement):
    """The retry of a request that already paid must get its reply back
    even if the model was flagged off (or dropped from GA) in between --
    there is no transcript to recover it from otherwise."""
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    body = {"model": str(ai_model.pk), "prompt": "hello"}

    first = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    assert first.status_code == 200, first.content
    AIModel.objects.filter(pk=ai_model.pk).update(
        is_enabled=False, is_ga=False,
        model="o1" if retirement else "gpt-5.6-sol-retired", display_name="Retired display name",
    )

    replay = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert replay.status_code == 200, replay.content
    assert replay.data == first.data
    assert len(provider_calls) == 1
    assert Decimal("1000") - balance(user) == Decimal(
        first.data["tuzis_charged"])
    # And a NEW key on the now-delisted model is still refused, free (404:
    # it is out of the catalogue; a row still in GA but disabled is the 409
    # pinned above).
    fresh = _post(client, ai_model)
    assert fresh.status_code == 404, fresh.content
    assert len(provider_calls) == 1


@pytest.mark.django_db
def test_new_paid_receipt_replays_after_catalogue_row_is_deleted(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    body = {"model": str(ai_model.pk), "prompt": "delete after payment"}

    first = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    assert first.status_code == 200, first.content
    ai_model.delete()

    replay = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert replay.status_code == 200
    assert replay.data == first.data
    assert len(provider_calls) == 1
    assert Decimal("1000") - balance(user) == Decimal(
        first.data["tuzis_charged"])


@pytest.mark.django_db
def test_legacy_fingerprint_receipt_replays_after_catalog_row_is_deleted(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    body = {"model": str(ai_model.pk), "prompt": "legacy prompt"}
    old_payload = {
        "action": "ai_prompt",
        "intent": "ai_prompt",
        "model": str(ai_model.pk),
        "prompt": "legacy prompt",
        "system_message": None,
        "max_output_tokens": None,
    }
    old_response = {
        "response": "old paid reply",
        "tuzis_charged": 3,
        "input_tokens": 12,
        "output_tokens": 8,
    }
    IdempotencyKey.objects.create(
        scope="ai_prompt", user=user, key=key,
        request_hash=fingerprint(old_payload),
        response_status=200, response_body=old_response,
    )
    ai_model.delete()

    replay = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert replay.status_code == 200
    assert replay.data == old_response
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_stale_prompt_claim_cannot_be_taken_over_for_different_prompt(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    old_payload = {
        "action": "ai_prompt", "intent": "ai_prompt",
        "model": str(ai_model.pk), "prompt": "original prompt",
        "system_message": None, "max_output_tokens": None,
    }
    record = IdempotencyKey.objects.create(
        scope="ai_prompt", user=user, key=key,
        request_hash=fingerprint(old_payload),
        response_body={"operation": "ai_prompt", "state": "provider_pending"},
    )
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )

    response = client.post(
        URL,
        {"model": str(ai_model.pk), "prompt": "different paid prompt"},
        format="json", HTTP_IDEMPOTENCY_KEY=key,
    )

    assert response.status_code == 409
    assert response.data["code"] == "idempotency_mismatch"
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_pre_disclosure_stale_prompt_claim_becomes_a_terminal_unknown_outcome(
        creator_factory, provider_calls):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    body = {"model": str(ai_model.pk), "prompt": "original prompt"}
    payload = {
        "action": "ai_prompt", "intent": "ai_prompt",
        "model": str(ai_model.pk), "prompt": "original prompt",
        "system_message": None, "max_output_tokens": None,
    }
    record = IdempotencyKey.objects.create(
        scope="ai_prompt", user=user, key=key,
        request_hash=fingerprint(payload),
        response_body={"operation": "ai_prompt", "state": "provider_pending"},
    )
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )

    first = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    replay = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert first.status_code == replay.status_code == 409
    assert first.data == replay.data
    assert first.data["code"] == "provider_outcome_unknown"
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_disclosed_stale_prompt_claim_never_dispatches_again(
        creator_factory, provider_calls):
    from .views import _creator_model_intent_snapshot
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    body = {"model": str(ai_model.pk), "prompt": "original prompt", "max_output_tokens": 256}
    quote = client.post("/api/ai/creator-options/", body, format="json")
    assert quote.status_code == 200
    payload = {
        "action": "ai_prompt", "intent": "ai_prompt", **body,
        "system_message": None,
    }
    record = IdempotencyKey.objects.create(
        scope="ai_prompt", user=user, key=key, request_hash=fingerprint(payload),
        response_body={"operation": "ai_prompt", "state": "provider_pending",
                       "_provider_intent_snapshot": _creator_model_intent_snapshot(ai_model)},
    )
    IdempotencyKey.objects.filter(pk=record.pk).update(
        created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
    )
    body["quote_token"] = quote.data["quote_token"]
    first = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    replay = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    assert first.status_code == replay.status_code == 409
    assert first.data == replay.data
    assert first.data["code"] == "provider_outcome_unknown"
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


# --------------------------------------------------------------------------- #
# 7. The legacy endpoint is untouched.
# --------------------------------------------------------------------------- #
class _LegacyCompletion:
    """A Chat Completions reply: the legacy endpoint's wire shape since."""

    def __init__(self, text):
        message = type("Message", (), {"content": text})()
        self.choices = [type("Choice", (), {"message": message})()]


def _legacy_fake_client(calls):
    """Exposes ONLY ``chat.completions`` -- the retired ``client.completions``
    (gpt-3.5-turbo-instruct, ) is an AttributeError, not a silent pass."""

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return _LegacyCompletion("legacy reply")

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    return FakeClient()


@pytest.mark.django_db
def test_legacy_prompt_endpoint_still_charges_a_flat_1_2z(
        creator_factory, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "dj.apps.openai.views.oai_client", _legacy_fake_client(calls))
    user = creator_factory(tuzis=Decimal("5"))

    response = _client(user).post(
        LEGACY_URL, {"prompt": "hi"}, format="json")

    assert response.status_code == 200, response.content
    assert response.data == "legacy reply"
    # Chat Completions on the supported prompt model, the prompt as
    # the single user message, and the SAME flat 1 2Z price below.
    assert calls[0]["model"] == "gpt-4o-mini"
    assert calls[0]["messages"] == [{"role": "user", "content": "hi"}]
    assert calls[0]["max_completion_tokens"] == 2048 * 2 - 200
    assert calls[0]["temperature"] == 0.5
    assert balance(user) == Decimal("4")


@pytest.mark.django_db
def test_legacy_prompt_endpoint_refuses_an_empty_balance(
        creator_factory, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "dj.apps.openai.views.oai_client", _legacy_fake_client(calls))
    user = creator_factory(tuzis=Decimal("0"))

    response = _client(user).post(
        LEGACY_URL, {"prompt": "hi"}, format="json")

    assert response.status_code == 402, response.content
    assert calls == []
    assert balance(user) == Decimal("0")


@pytest.mark.django_db
def test_a_prompt_that_fits_cl100k_but_not_the_models_tokenizer_is_400_and_free(
        creator_factory, provider_calls):
    """Twin of the conversation test (independent review of ): the
    one-shot endpoint checks the budget with the conservative count too."""
    ai_model = _model(model="gpt-5.4", max_tokens=3000, max_output_tokens=256,
                      max_response_tokens=256)
    user = creator_factory(tuzis=Decimal("1000"))
    response = _post(_client(user), ai_model, prompt=" className " * 1000)
    assert response.status_code == 400, response.content
    assert provider_calls == []
    assert balance(user) == Decimal("1000")


@pytest.mark.django_db
def test_provider_rate_limit_releases_claim_for_same_key_retry(
        creator_factory, monkeypatch):
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    calls = []

    class RateLimited(Exception):
        status_code = 429

    def rate_limited(*args, **kwargs):
        calls.append("refused")
        raise RateLimited("rate limited")

    monkeypatch.setattr("f2z.ai.providers.stream_chat", rate_limited)
    body = {"model": str(ai_model.pk), "prompt": "retry after rate limit"}
    first = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert first.status_code == 503
    assert not IdempotencyKey.objects.filter(
        scope="ai_prompt", user=user, key=key,
    ).exists()

    def success(*args, **kwargs):
        calls.append("accepted")
        yield REPLY

    monkeypatch.setattr("f2z.ai.providers.stream_chat", success)
    retry = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)

    assert retry.status_code == 200, retry.content
    assert calls == ["refused", "accepted"]


@pytest.mark.django_db
def test_the_output_cap_is_sized_from_the_models_tokenizer_on_the_prompt_endpoint(
        creator_factory, provider_calls):
    """Twin of the conversation test: prompt + cap fits the window on the
    tokenizer the provider uses, not on the legacy count."""
    import tiktoken

    ai_model = _model(model="gpt-5.4", max_tokens=3000, max_output_tokens=256,
                      max_response_tokens=2500)
    user = creator_factory(tuzis=Decimal("100000"))
    response = _post(_client(user), ai_model, prompt=" className " * 700)
    assert response.status_code == 200, response.content
    sent = provider_calls[0]
    o200k = sum(len(tiktoken.get_encoding("o200k_base").encode(m["content"])) + 4
                for m in sent["messages"]) + 2
    assert o200k + sent["max_output_tokens"] <= 3000
    assert sent["max_output_tokens"] < 3000 - num_tokens_from_messages(sent["messages"])


@pytest.mark.django_db
def test_settlement_preserves_provider_cache_usage(creator_factory, monkeypatch):
    ai_model = _model(model="gpt-6.1-sol", input_price="0.0001")
    user = creator_factory(tuzis=Decimal("1000"))
    prompt = "hello " * 8_000
    input_tokens = num_tokens_from_messages(
        _expected_messages(ai_model, prompt), ai_model.model)
    usage = SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=2,
        cached_input_tokens=input_tokens * 9 // 10,
        cache_write_tokens=0,
        cache_write_1h_tokens=0,
    )

    class CachedStream:
        def __init__(self):
            self.usage = usage

        def __iter__(self):
            yield REPLY

        def close(self):
            pass

    monkeypatch.setattr("f2z.ai.providers.stream_chat", lambda *a, **kw: CachedStream())

    response = _post(
        _client(user), ai_model, prompt=prompt, max_output_tokens=256)

    expected = ai_model.get_tuzi_price(
        input_tokens, 2, cached_input_tokens=usage.cached_input_tokens,
    )
    ordinary_price = ai_model.get_tuzi_price(input_tokens, 2)
    assert response.status_code == 200, response.content
    assert expected < ordinary_price
    assert response.data["input_tokens"] == input_tokens
    assert response.data["output_tokens"] == 2
    assert response.data["tuzis_charged"] == expected
    assert Decimal("1000") - balance(user) == Decimal(expected)


@pytest.mark.django_db(transaction=True)
def test_stale_prompt_takeover_releases_hold_and_fences_late_worker(
        creator_factory, monkeypatch):
    """A real Postgres takeover terminalizes the receipt before the old
    worker reaches settlement; the old worker must not charge or deliver."""
    from dj.apps.ledger.models import LedgerHold
    from dj.apps.tuzis import ledger
    ai_model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    client = _client(user)
    key = str(uuid.uuid4())
    other_operation_key = uuid.uuid4()
    other_reservation = ledger.reserve(
        user, 1, scope="ai_prompt", operation_key=other_operation_key,
    )
    body = {"model": str(ai_model.pk), "prompt": "original prompt"}
    calls = []
    takeover = {}

    def provider_paused_at_completion(model, messages, **kwargs):
        calls.append((model, messages))
        record = IdempotencyKey.objects.get(
            scope="ai_prompt", user=user, key=key,
        )
        IdempotencyKey.objects.filter(pk=record.pk).update(
            created_at=timezone.now() - STALE_CLAIM - timedelta(seconds=1),
        )
        takeover["response"] = client.post(
            URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key,
        )
        takeover["hold_exists"] = LedgerHold.objects.filter(
            logical_key=f"ai_prompt:{key}",
        ).exists()
        takeover["other_hold_exists"] = LedgerHold.objects.filter(
            logical_key=f"ai_prompt:{other_operation_key}",
        ).exists()
        takeover["receipt"] = IdempotencyKey.objects.get(pk=record.pk)
        yield REPLY

    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat", provider_paused_at_completion,
    )

    late_worker = client.post(
        URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key,
    )

    assert takeover["response"].status_code == 409
    assert takeover["response"].data["code"] == "provider_outcome_unknown"
    assert takeover["hold_exists"] is False
    assert takeover["other_hold_exists"] is True
    assert calls and len(calls) == 1
    assert late_worker.status_code == 402
    assert "response" not in late_worker.data
    assert not Event.objects.filter(type="CHAT2Z").exists()
    replay = client.post(URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)
    assert replay.status_code == 409
    assert replay.data == takeover["response"].data
    assert len(calls) == 1

    receipt = takeover["receipt"]
    operation = receipt.response_body["_prompt_operation"]
    snapshot = receipt.response_body["_provider_intent_snapshot"]
    assert snapshot["provider"] == "openai"
    assert snapshot["model"] == ai_model.model
    assert operation == {
        "provider": "openai",
        "model": ai_model.model,
        "billing_state": "unknown",
        "billed_usd": None,
        "budget_state": "uncertain",
        "reserved_2z": operation["reserved_2z"],
        "reservation_released": True,
    }
    assert Decimal(operation["reserved_2z"]) > 0
    assert receipt.response_status == 409
    assert not LedgerHold.objects.filter(logical_key=f"ai_prompt:{key}").exists()
    assert balance(user) == Decimal("1000")
    assert ledger.release_reservation(other_reservation) is True
