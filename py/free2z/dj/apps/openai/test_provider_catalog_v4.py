"""Price validity, strict discovery and honest inventory availability."""
from datetime import date, timedelta

import pytest
from django.utils import timezone

from .models import AIModel, ProviderModel
from .provider_inventory import provider_inventory, unreviewed_reason
from .management.commands.seed_ai_models import LINEUP
from f2z.ai.providers import ModelDisabled, _stream_chat


def _model(**kwargs):
    return AIModel.objects.create(max_tokens=128000, **kwargs)


def _listing(**kwargs):
    now = timezone.now()
    return ProviderModel.objects.create(first_seen_at=now, last_seen_at=now,
                                        availability_changed_at=now, **kwargs)


@pytest.mark.django_db
def test_strict_discovery_requires_the_exact_current_upstream_id():
    AIModel.objects.all().delete()
    ProviderModel.objects.all().delete()
    model = _model(provider="anthropic", model="claude-test", provider_model_id="claude-pinned")
    assert AIModel.objects.discovered().filter(pk=model.pk).exists()
    assert not AIModel.objects.discovered(require_snapshot=True).exists()
    listing = _listing(provider="anthropic", provider_model_id="claude-test")
    assert AIModel.objects.discovered(upstream=False, require_snapshot=True).exists()
    assert not AIModel.objects.discovered(require_snapshot=True).exists()
    listing.metadata = {"lifecycle": "deprecated"}
    listing.save()
    assert not AIModel.objects.discovered(upstream=False, require_snapshot=True).exists()
    listing.metadata = {}
    listing.missing_since = timezone.now()
    listing.save()
    assert not AIModel.objects.discovered(upstream=False, require_snapshot=True).exists()


@pytest.mark.django_db
def test_expired_price_cannot_be_selected_or_sent(monkeypatch):
    row = _model(provider="openai", model="promo", price_valid_until=timezone.now()-timedelta(seconds=1))
    assert not AIModel.objects.enabled().filter(pk=row.pk).exists()
    with pytest.raises(ModelDisabled, match="price review"):
        list(_stream_chat(row, [{"role": "user", "content": "never send"}]))
    row.price_valid_until = timezone.now()+timedelta(days=1)
    row.save()
    assert AIModel.objects.enabled().filter(pk=row.pk).exists()


@pytest.mark.django_db
def test_inventory_requires_review_listing_and_key(settings):
    AIModel.objects.all().delete()
    ProviderModel.objects.all().delete()
    settings.OPENAI_API_KEY = "test-key"
    row = _model(provider="openai", model="test-text", is_ga=True)
    def entry():
        return next(r for r in provider_inventory() if r["model"] == row.model)
    assert entry()["unavailable_reason"] == "price_and_capabilities_not_reviewed"
    row.price_checked_at = date(2026, 11, 7)
    row.save()
    assert entry()["unavailable_reason"] == "not_discovered"
    _listing(provider="openai", provider_model_id=row.model)
    assert entry()["available"]
    settings.OPENAI_API_KEY = ""
    assert entry()["unavailable_reason"] == "provider_not_configured"
    _listing(provider="openai", provider_model_id="gpt-image-future")
    unknown = next(r for r in provider_inventory() if r["model"] == "gpt-image-future")
    assert not unknown["available"]
    assert unknown["unavailable_reason"] == "unsupported_modality_or_endpoint"


def test_haiku_service_cap_excludes_its_higher_price_tier():
    row = next(row for row in LINEUP if row[1] == "claude-haiku-5-5")
    assert row[5] * 115 < 100_000 * 100
    assert row[7] <= row[5]


@pytest.mark.parametrize("provider,model,reason", [
    ("openai", "gpt-5.5-pro", "requires_unimplemented_endpoint_or_tool_billing"),
    ("openai", "gpt-4o-2024-05-13", "snapshot_requires_separate_price_and_capability_review"),
    ("anthropic", "claude-mythos-5-1", "restricted_access_requires_separate_review"),
    ("openai", "future-model", "price_and_capabilities_not_reviewed"),
])
def test_unknown_models_are_explained_without_price_guesses(provider, model, reason):
    assert unreviewed_reason(provider, model) == reason


@pytest.mark.django_db
def test_seed_and_migration_preserve_operator_markup():
    import importlib
    from django.apps import apps
    from django.core.management import call_command
    from decimal import Decimal
    from io import StringIO
    row, _ = AIModel.objects.update_or_create(provider="openai", model="gpt-4o",
        defaults={"max_tokens": 128000, "markup": Decimal("1.23")})
    importlib.import_module("dj.apps.openai.migrations.0036_seed_lineup_v4").seed(apps, None)
    row.refresh_from_db()
    assert row.markup == Decimal("1.23")
    call_command("seed_ai_models", stdout=StringIO())
    row.refresh_from_db()
    assert row.markup == Decimal("1.23")


def test_derived_anthropic_alias_preserves_deprecation():
    from .discovery import DiscoveredModel, _anthropic_aliases
    alias = _anthropic_aliases([DiscoveredModel(
        id="claude-test-20260101", metadata={"lifecycle": "deprecated"})])[0]
    assert alias.id == "claude-test"
    assert alias.metadata["lifecycle"] == "deprecated"


@pytest.mark.parametrize("text", ["hello " * 17000, "🦀" * 25000])
def test_haiku_tier_budget_rejects_prompts_an_openai_tokenizer_underestimates(text):
    from .models import count_prompt_tokens, num_tokens_from_messages
    messages = [{"role": "user", "content": text}]
    row = next(row for row in LINEUP if row[1] == "claude-haiku-5-5")
    assert num_tokens_from_messages(messages, "claude-haiku-5-5") < row[5]
    budget = count_prompt_tokens(messages, "claude-haiku-5-5")
    assert budget >= len(text.encode("utf-8")) + 256
    assert budget > row[5]  # shared quote/dispatch context admission refuses it


@pytest.mark.django_db
def test_v4_migration_preserves_gpt41_fence_without_reapplying_older_migration():
    import importlib
    from django.apps import apps
    migration = importlib.import_module("dj.apps.openai.migrations.0036_seed_lineup_v4")
    AIModel.objects.filter(model="gpt-4.1").delete()
    migration.seed(apps, None)
    row = AIModel.objects.get(model="gpt-4.1")
    assert (row.max_tokens, row.max_response_tokens) == (128000, 16384)
    row.max_tokens = 50000
    row.save()
    migration.seed(apps, None)
    row.refresh_from_db()
    assert (row.max_tokens, row.max_response_tokens) == (50000, 16384)
