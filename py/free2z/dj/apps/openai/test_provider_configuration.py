"""Model availability is DERIVED from configuration.

Prod's public catalogue advertised nine GA, enabled models. Five of them --
three Claude, two Grok -- belonged to providers with no API key anywhere, so
every prompt to them was a 503, and translation silently ran ``gpt-4o``
instead of its documented first choice. Nothing was red: the rows were
correct, the fallback worked, and no test ever asked whether the process
holding the catalogue could actually call what it listed.

Each test that asserts a row is hidden is paired with the same row, same
flags, becoming visible when its key appears. That pairing is the negative
control: a catalogue that hid Anthropic for some other reason (a stale flag,
a broken fixture) would fail the second half.
"""
import json
import logging
from pathlib import Path

import pytest
from django.apps import apps

from dj.apps.openai.models import AIModel
from f2z.ai import providers

MODELS_URL = "/api/ai/models/"
_REPO_ROOT = Path(__file__).resolve().parents[5]


@pytest.fixture
def prod_like_keys(settings):
    """Prod as of 2026-09-23: an OpenAI key and nothing else."""
    settings.OPENAI_API_KEY = "sk-test-openai"
    settings.ANTHROPIC_API_KEY = ""
    settings.XAI_API_KEY = ""
    settings.MOONSHOT_API_KEY = ""
    return settings


def _row(provider, model):
    return AIModel.objects.create(
        provider=provider, model=model, display_name=model,
        system_message="", max_tokens=4096, max_output_tokens=1024,
        is_ga=True, is_enabled=True,
        # Above every seeded row: the public list is paginated (PAGE_SIZE 12).
        order=1000,
    )


def _catalogue_ids(api_client):
    resp = api_client.get(MODELS_URL)
    assert resp.status_code == 200
    return {row["id"] for row in resp.data["results"]}


@pytest.mark.django_db
def test_catalogue_hides_a_model_whose_provider_has_no_key(
    api_client, prod_like_keys,
):
    gpt = _row("openai", "cfg-test-gpt")
    claude = _row("anthropic", "cfg-test-claude")
    grok = _row("xai", "cfg-test-grok")

    ids = _catalogue_ids(api_client)
    assert str(gpt.id) in ids
    assert str(claude.id) not in ids
    assert str(grok.id) not in ids
    # Not just the list: the price card of an uncallable model is not
    # published either.
    assert api_client.get(f"{MODELS_URL}{claude.id}/").status_code == 404

    # Negative control: same rows, same flags, the key appears -> listed.
    prod_like_keys.ANTHROPIC_API_KEY = "sk-ant-test"
    ids = _catalogue_ids(api_client)
    assert str(claude.id) in ids
    assert str(grok.id) not in ids
    assert api_client.get(f"{MODELS_URL}{claude.id}/").status_code == 200


@pytest.mark.django_db
def test_selectable_is_enabled_and_ga_and_configured(prod_like_keys):
    claude = _row("anthropic", "cfg-test-claude-2")
    assert claude not in AIModel.objects.selectable()
    # enabled() is deliberately NOT narrowed: an existing conversation on a
    # model whose key went away still loads, and says so on its next prompt.
    assert claude in AIModel.objects.enabled()

    prod_like_keys.ANTHROPIC_API_KEY = "sk-ant-test"
    assert claude in AIModel.objects.selectable()


def test_configured_matches_what_get_client_will_build(prod_like_keys):
    """The catalogue and the client agree about what 'configured' means."""
    for provider in providers.API_KEY_NAMES:
        providers._clients.pop(provider, None)
        configured = providers.provider_is_configured(provider)
        if provider == providers.OPENAI:
            assert configured
            continue
        assert not configured
        with pytest.raises(RuntimeError, match="No API key configured"):
            providers.get_client(provider)


def test_unconfigured_excludes_policy_disabled_providers(prod_like_keys):
    """Kimi is off by policy; reporting it as a missing key would mislead."""
    assert providers.unconfigured_providers() == ["anthropic", "xai"]


def test_report_names_the_effective_translation_choice(prod_like_keys):
    report = providers.availability_report((
        "kimi:kimi-k3",
        "anthropic:claude-haiku-4-5",
        "openai:gpt-4o",
    ))
    assert report["translation_first_choice"] == "openai:gpt-4o"
    assert report["translation_skipped"] == [
        {"model": "kimi:kimi-k3", "why": "policy_disabled"},
        {"model": "anthropic:claude-haiku-4-5", "why": "no ANTHROPIC_API_KEY"},
    ]
    assert report["missing_keys"] == ["ANTHROPIC_API_KEY", "XAI_API_KEY"]

    prod_like_keys.ANTHROPIC_API_KEY = "sk-ant-test"
    report = providers.availability_report((
        "kimi:kimi-k3",
        "anthropic:claude-haiku-4-5",
        "openai:gpt-4o",
    ))
    assert report["translation_first_choice"] == "anthropic:claude-haiku-4-5"


def test_startup_line_is_one_countable_json_record(prod_like_keys, caplog):
    caplog.set_level(logging.INFO)
    providers.log_availability(("openai:gpt-4o",))

    records = [r for r in caplog.records if "ai_providers" in r.getMessage()]
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.WARNING
    line = record.getMessage()
    assert "\n" not in line
    payload = json.loads(line)
    assert payload["event"] == providers.AI_PROVIDERS_UNCONFIGURED_EVENT
    assert payload["unconfigured_providers"] == ["anthropic", "xai"]
    assert "anthropic, xai" in payload["message"]
    # Key NAMES only -- never a value.
    assert "sk-test-openai" not in line


def test_fully_configured_is_not_counted(prod_like_keys, caplog):
    prod_like_keys.ANTHROPIC_API_KEY = "sk-ant-test"
    prod_like_keys.XAI_API_KEY = "xai-test"
    caplog.set_level(logging.INFO)
    providers.log_availability(())

    lines = [r.getMessage() for r in caplog.records]
    assert not any(
        providers.AI_PROVIDERS_UNCONFIGURED_EVENT + '"' in line
        for line in lines
    ), lines
    assert any('"event":"ai_providers_configured"' in line for line in lines)


def test_app_startup_emits_the_report(prod_like_keys, caplog):
    """Wired, not just written: AppConfig.ready is what runs in the pod."""
    caplog.set_level(logging.INFO)
    apps.get_app_config("openai").ready()
    assert any(
        f'"event":"{providers.AI_PROVIDERS_UNCONFIGURED_EVENT}"'
        in r.getMessage()
        for r in caplog.records
    )


