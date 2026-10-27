"""Creator choices are a live server policy, not identifiers trusted from UI."""
from decimal import Decimal
import uuid

import pytest
from rest_framework.test import APIClient

from dj.apps.g12f.models import Creator

from .models import AIModel, num_tokens_from_messages


OPTIONS_URL = "/api/ai/creator-options/"
PROMPT_URL = "/api/ai/prompt/"


def _model(**overrides):
    fields = dict(
        provider="openai", model="gpt-5.6-sol", display_name="GPT-5.6 Sol",
        system_message="Be concise.", max_tokens=400000,
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


@pytest.mark.django_db
def test_creator_options_exclude_unconfigured_disabled_and_unpriced_models(
        creator_factory, monkeypatch, settings):
    available = _model()
    _model(provider="anthropic", model="claude-test", is_enabled=True)
    _model(model="disabled-test", is_enabled=False)
    _model(model="unpriced-test", input_price="0", output_price="0")
    user = creator_factory(tuzis=Decimal("1000"))
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: {"openai"})
    monkeypatch.setattr("dj.apps.openai.views.oai_client", object())
    settings.OPENAI_IMAGE_MODEL = "gpt-image-fixture"

    response = _client(user).get(OPTIONS_URL)

    assert response.status_code == 200
    selected_ids = {row["id"] for row in response.data["completion"]}
    assert str(available.pk) in selected_ids
    assert str(AIModel.objects.get(model="claude-test").pk) not in selected_ids
    assert str(AIModel.objects.get(model="disabled-test").pk) not in selected_ids
    assert str(AIModel.objects.get(model="unpriced-test").pk) not in selected_ids
    assert all(row["provider"] == "openai" for row in response.data["completion"])
    image, = response.data["cover"]
    assert (image["provider"], image["model"], image["price_2z"]) == (
        "openai", "gpt-image-fixture", 6,
    )
    assert image["privacy_policy_url"]
    assert "synchronously" in image["queue"]


@pytest.mark.django_db
def test_quote_is_prompt_specific_and_returns_the_admission_maximum(
        creator_factory, monkeypatch):
    model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: {"openai"})
    prompt = "A prompt with a price."

    response = _client(user).post(OPTIONS_URL, {
        "model": str(model.pk), "prompt": prompt, "max_output_tokens": 256,
    }, format="json")

    input_tokens = num_tokens_from_messages([
        {"role": "system", "content": model.system_message},
        {"role": "user", "content": prompt},
    ])
    assert response.status_code == 200, response.content
    assert response.data["model"] == str(model.pk)
    assert response.data["max_output_tokens"] == 256
    assert response.data["max_charge_2z"] == model.get_admission_price(
        input_tokens, 256,
    )


@pytest.mark.django_db
def test_quote_uses_the_generation_context_tokenizer(
        creator_factory, monkeypatch):
    model = _model(max_tokens=100, max_output_tokens=10)
    user = creator_factory(tuzis=Decimal("1000"))
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: {"openai"})
    monkeypatch.setattr(
        "dj.apps.openai.views.num_tokens_from_messages", lambda messages, model_name=None: 10)
    monkeypatch.setattr(
        "dj.apps.openai.views.count_prompt_tokens",
        lambda messages, model_name: 95,
    )
    calls = []
    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    client = _client(user)
    request_body = {
        "model": str(model.pk), "prompt": "Tokenizer boundary",
        "max_output_tokens": 256,
    }

    quote = client.post(OPTIONS_URL, request_body, format="json")
    generation = client.post(
        PROMPT_URL, request_body, format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert quote.status_code == 400
    assert generation.status_code == 400
    assert calls == []


@pytest.mark.django_db
def test_quote_refuses_model_removed_from_current_configuration(
        creator_factory, monkeypatch):
    model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: set())

    response = _client(user).post(OPTIONS_URL, {
        "model": str(model.pk), "prompt": "hello",
    }, format="json")

    assert response.status_code == 409


@pytest.mark.django_db
def test_stale_price_quote_is_refused_before_provider_and_charge(
        creator_factory, monkeypatch):
    model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: {"openai"})
    calls = []
    monkeypatch.setattr(
        "f2z.ai.providers.stream_chat",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    client = _client(user)
    prompt = "Review this exact quote."
    quote = client.post(OPTIONS_URL, {
        "model": str(model.pk), "prompt": prompt, "max_output_tokens": 256,
    }, format="json")
    assert quote.status_code == 200

    AIModel.objects.filter(pk=model.pk).update(input_price="0.000006")
    response = client.post(
        PROMPT_URL,
        {
            "model": str(model.pk), "prompt": prompt,
            "max_output_tokens": 256, "quote_token": quote.data["quote_token"],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 409
    assert "price or settings changed" in response.data["detail"]
    assert calls == []
    user.refresh_from_db()
    assert user.tuzis == Decimal("1000")


@pytest.mark.django_db
def test_completed_prompt_replays_after_price_and_quote_change(
        creator_factory, monkeypatch):
    model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: {"openai"})
    calls = []

    def fake_stream(*args, **kwargs):
        calls.append((args, kwargs))
        yield "one paid reply"

    monkeypatch.setattr("f2z.ai.providers.stream_chat", fake_stream)
    client = _client(user)
    prompt = "Lost response, then the catalogue price changed."
    key = str(uuid.uuid4())
    quote_body = {
        "model": str(model.pk), "prompt": prompt, "max_output_tokens": 256,
    }
    first_quote = client.post(OPTIONS_URL, quote_body, format="json")
    first = client.post(
        PROMPT_URL,
        {**quote_body, "quote_token": first_quote.data["quote_token"]},
        format="json", HTTP_IDEMPOTENCY_KEY=key,
    )
    assert first.status_code == 200, first.content

    AIModel.objects.filter(pk=model.pk).update(
        input_price="0.000007", output_price="0.00004",
    )
    refreshed_quote = client.post(OPTIONS_URL, quote_body, format="json")
    assert refreshed_quote.status_code == 200
    assert refreshed_quote.data["quote_token"] != first_quote.data["quote_token"]
    replay = client.post(
        PROMPT_URL,
        {**quote_body, "quote_token": refreshed_quote.data["quote_token"]},
        format="json", HTTP_IDEMPOTENCY_KEY=key,
    )

    assert replay.status_code == 200
    assert replay.data == first.data
    assert len(calls) == 1
    user.refresh_from_db()
    assert user.tuzis == Decimal("1000") - Decimal(first.data["tuzis_charged"])


@pytest.mark.django_db
def test_metered_generation_rechecks_live_configuration_and_choice_intent(
        creator_factory, monkeypatch):
    model = _model()
    user = creator_factory(tuzis=Decimal("1000"))
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: set())

    response = _client(user).post(
        PROMPT_URL,
        {"model": str(model.pk), "prompt": "hello", "max_output_tokens": 20},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )

    assert response.status_code == 409
    user.refresh_from_db()
    assert user.tuzis == Decimal("1000")


@pytest.mark.django_db
def test_creator_options_preserve_catalogue_order(creator_factory, monkeypatch):
    preferred = _model(model="preferred", display_name="Z preferred", order=1000)
    expensive = _model(model="expensive", display_name="A expensive", order=1)
    monkeypatch.setattr(
        "dj.apps.openai.models.configured_providers", lambda: {"openai"})
    response = _client(creator_factory()).get(OPTIONS_URL)
    assert response.status_code == 200
    ids = [row["id"] for row in response.data["completion"]]
    assert ids.index(str(preferred.pk)) < ids.index(str(expensive.pk))


@pytest.mark.django_db
def test_quote_discloses_provider_changed_since_catalogue(creator_factory, monkeypatch):
    model = _model()
    monkeypatch.setattr("dj.apps.openai.models.configured_providers", lambda: {"openai", "anthropic"})
    client = _client(creator_factory())
    before = client.get(OPTIONS_URL)
    assert next(row for row in before.data["completion"] if row["id"] == str(model.pk))["provider"] == "openai"
    AIModel.objects.filter(pk=model.pk).update(provider="anthropic", model="claude-fixture", display_name="Claude fixture")
    response = client.post(OPTIONS_URL, {"model": str(model.pk), "prompt": "Test exact provider", "max_output_tokens": 256}, format="json")
    assert response.status_code == 200
    assert response.data["choice"]["provider"] == "anthropic"
    assert response.data["choice"]["model"] == "claude-fixture"
    assert response.data["choice"]["destination"] == "Anthropic"
    assert response.data["choice"]["privacy_policy_url"] == "https://www.anthropic.com/legal/privacy"


@pytest.mark.django_db
def test_fal_choice_is_explicit_signed_and_only_advertised_when_configured(creator_factory, settings):
    from django.core.signing import Signer
    settings.FAL_API_KEY = "test-key"
    settings.FAL_IMAGE_ENABLED = True
    settings.FAL_IMAGE_MODEL_VERSION = "FLUX.1 [schnell]"
    settings.FAL_IMAGE_APPROVED_PRICE_USD = "0.006"
    settings.FAL_IMAGE_DAILY_BUDGET_USD = "1.00"
    client = _client(creator_factory())
    response = client.get(OPTIONS_URL)
    fal, = [choice for choice in response.data["cover"] if choice["provider"] == "fal"]
    assert fal["id"] == "fal-flux-schnell"
    assert fal["model"] == "fal-ai/flux/schnell"
    assert fal["price_2z"] == 6
    assert fal["destination"] == "fal"
    assert fal["privacy_policy_url"] == "https://fal.ai/legal/privacy-policy"
    snapshot = Signer(salt="free2z.creator-ai-cover-disclosure.v1").unsign_object(fal["snapshot_token"])
    assert snapshot["provider"] == "fal"
    assert snapshot["price_2z"] == 6
    settings.FAL_IMAGE_ENABLED = False
    assert all(choice["provider"] != "fal" for choice in client.get(OPTIONS_URL).data["cover"])
