"""October retirement: durable refusal, migration history, and no provider I/O."""
import importlib
import time
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import psycopg
from django.core.management import call_command
from django.db import connection, OperationalError
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

from dj.apps.openai.discovery import DiscoveredModel, record_listing
from dj.apps.openai.models import AIModel
from dj.apps.openai.test_model_availability import _conversation, _make_model
from dj.apps.pricing.catalog import catalogue_models
from dj.apps.pricing.models import RateCardModel
from f2z.ai import providers

ALIASES = ("gpt-4.1-nano", "o1", "o3-mini", "o4-mini")
SNAPSHOTS = ("gpt-4.1-nano-2025-04-14", "o1-2024-12-17",
             "o3-mini-2025-01-31", "o4-mini-2025-04-16", "gpt-4o-2024-05-13")
MIGRATION = "0031_retire_october_2026_models"


@pytest.mark.django_db(transaction=True)
def test_actual_migration_disables_aliases_and_pins_preserving_history():
    call_command("seed_ai_models", stdout=StringIO())
    executor = MigrationExecutor(connection)
    before = [("openai", "0030_cap_gpt41_window")]
    after = [("openai", MIGRATION)]
    executor.migrate(before)
    try:
        historical = executor.loader.project_state(before).apps.get_model("openai", "AIModel")
        old = timezone.now()
        rows = []
        for model in ALIASES + SNAPSHOTS:
            row, _ = historical.objects.update_or_create(provider="openai", model=model,
                defaults={"is_enabled": True, "is_ga": True, "updated_at": old, "max_tokens": 4096})
            rows.append(row.pk)
        for i, model in enumerate(SNAPSHOTS):
            row = historical.objects.create(provider="openai", model=f"operator-pin-{i}",
                provider_model_id=model, is_enabled=True, is_ga=True, max_tokens=4096)
            rows.append(row.pk)
        january, _ = historical.objects.update_or_create(provider="openai", model="gpt-4o",
            defaults={"is_enabled": True, "is_ga": True, "max_tokens": 4096})
        foreign = historical.objects.create(provider="xai", model="o1", is_enabled=True, is_ga=True, max_tokens=4096)
        cards = list(RateCardModel.objects.order_by("pk").values())
        assert cards
        # A contended row must abort before changing any availability flags.
        config = connection.settings_dict
        with psycopg.connect(host=config["HOST"], port=config["PORT"],
                             dbname=config["NAME"], user=config["USER"],
                             password=config["PASSWORD"]) as locker:
            locker.execute("SELECT id FROM openai_aimodel WHERE id=%s FOR UPDATE", [rows[0]])
            started = time.monotonic()
            with pytest.raises(OperationalError, match="lock timeout"):
                MigrationExecutor(connection).migrate(after)
            assert time.monotonic() - started < 12
            assert historical.objects.filter(pk__in=rows, is_enabled=True).count() == len(rows)
            locker.rollback()
        executor = MigrationExecutor(connection)
        executor.migrate(after)
        assert AIModel.objects.filter(pk__in=rows).count() == len(rows)
        assert not AIModel.objects.filter(pk__in=rows, is_enabled=True).exists()
        assert not AIModel.objects.filter(pk__in=rows, is_ga=True).exists()
        assert all(r.updated_at > old for r in AIModel.objects.filter(pk__in=rows))
        assert AIModel.objects.get(pk=january.pk).is_enabled
        assert AIModel.objects.get(pk=foreign.pk).is_enabled
        assert list(RateCardModel.objects.order_by("pk").values()) == cards
        # A code rollback must not turn an unavailable provider back on.
        MigrationExecutor(connection).migrate(before)
        assert not AIModel.objects.filter(pk__in=rows, is_enabled=True).exists()
    finally:
        MigrationExecutor(connection).migrate(after)


@pytest.mark.django_db
@pytest.mark.parametrize("fresh", [False, True])
def test_seed_cannot_reactivate_october_models_or_change_cards(fresh):
    call_command("seed_ai_models", stdout=StringIO())
    if fresh:
        AIModel.objects.filter(provider="openai", model__in=ALIASES).delete()
    else:
        AIModel.objects.filter(provider="openai", model__in=ALIASES).update(is_enabled=True, is_ga=True)
    cards = list(RateCardModel.objects.order_by("pk").values())
    assert cards
    call_command("seed_ai_models", stdout=StringIO())
    rows = AIModel.objects.filter(provider="openai", model__in=ALIASES)
    assert rows.count() == 4
    assert all(not row.is_enabled and not row.is_ga for row in rows)
    assert list(RateCardModel.objects.order_by("pk").values()) == cards


@pytest.mark.django_db
def test_seed_preserves_but_disables_gpt4o_retired_upstream_pin():
    call_command("seed_ai_models", stdout=StringIO())
    row = AIModel.objects.get(provider="openai", model="gpt-4o")
    AIModel.objects.filter(pk=row.pk).update(
        provider_model_id="gpt-4o-2024-05-13", is_enabled=True, is_ga=True)
    call_command("seed_ai_models", stdout=StringIO())
    row.refresh_from_db()
    assert row.provider_model_id == "gpt-4o-2024-05-13"
    assert not row.is_enabled and not row.is_ga


@pytest.mark.django_db
@pytest.mark.parametrize("retired", ALIASES + SNAPSHOTS)
@pytest.mark.parametrize("pinned", [False, True])
def test_policy_survives_bulk_enable_and_provider_discovery(retired, pinned, settings):
    settings.OPENAI_API_KEY = "test-not-used"
    row = _make_model(model="operator-alias" if pinned else retired,
                      provider_model_id=retired if pinned else "")
    assert not row.is_enabled and not row.is_ga
    # Bulk writes bypass save: neither discovery nor stale flags authorize use.
    AIModel.objects.filter(pk=row.pk).update(is_enabled=True, is_ga=True)
    record_listing("openai", [DiscoveredModel(id=retired), DiscoveredModel(id=row.model)])
    assert not AIModel.objects.enabled().filter(pk=row.pk).exists()
    assert not AIModel.objects.selectable().filter(pk=row.pk).exists()
    assert row.pk not in {candidate.pk for candidate in catalogue_models()}
    row.is_enabled = row.is_ga = True
    row.save(update_fields=["display_name"])
    row.refresh_from_db()
    assert not row.is_enabled and not row.is_ga


@pytest.mark.django_db
def test_history_readable_but_new_calls_and_forks_refused(api_client, creator_factory, monkeypatch, settings):
    settings.OPENAI_API_KEY = "test-not-used"
    user = creator_factory()
    row = _make_model(model="historical-choice")
    conversation = _conversation(user, row)
    AIModel.objects.filter(pk=row.pk).update(model="o1", is_enabled=True, is_ga=True, max_tokens=4096)
    provider = Mock(side_effect=AssertionError("retired model reached provider"))
    monkeypatch.setattr(providers, "stream_chat", provider)
    api_client.force_authenticate(user=user)
    read = api_client.get(f"/api/ai/conversations/{conversation.pk}/")
    assert read.status_code == 200
    assert conversation.prompt_response_set.count() == 2
    before = user.tuzis
    reply = api_client.post(f"/api/ai/conversations/{conversation.pk}/promptresponses/",
                            {"user_input": "new work"}, format="json")
    assert reply.status_code == 409
    fork = api_client.post("/api/ai/conversations/fork/", {
        "conversation": str(conversation.pk),
        "prompt_response": conversation.prompt_response_set.first().pk,
    }, format="json")
    assert fork.status_code == 409
    user.refresh_from_db()
    assert user.tuzis == before
    assert conversation.prompt_response_set.count() == 2
    provider.assert_not_called()


@pytest.mark.parametrize("retired", ALIASES + SNAPSHOTS)
def test_every_text_dispatch_boundary_refuses_retired_ids(retired, monkeypatch, settings):
    from f2z.openai import util
    client = Mock()
    monkeypatch.setattr(util, "oai_client", client)
    monkeypatch.setattr(util, "DEFAULT_UTILITY_MODEL", retired)
    monkeypatch.setattr(providers, "get_client", Mock(return_value=client))
    settings.PROMPT_COMPLETION_MODEL = retired
    calls = (
        lambda: providers.complete_prompt(client, "prompt", max_tokens=8),
        lambda: providers._create_with_cap(client, "openai", retired, {}, 8),
        lambda: list(providers.stream_chat(SimpleNamespace(
            provider="openai", model="safe-alias", provider_model_id=retired, is_enabled=True), [])),
        lambda: list(providers.stream_openai_compatible("openai", retired, [])),
        lambda: util.score_content("content"),
        lambda: util.tag_content("content", model=retired),
        lambda: util.get_tag_combine_pairs(model=retired, tags=[]),
    )
    for invoke in calls:
        with pytest.raises(providers.ModelDisabled):
            invoke()
    client.chat.completions.create.assert_not_called()


def test_exact_provider_scope_and_supported_models_are_not_retired():
    for model in ALIASES + SNAPSHOTS:
        assert not providers.model_is_retired("xai", model)
    for model in ("gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20",
                  "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3",
                  "o1-not-a-retired-snapshot"):
        assert not providers.model_is_retired("openai", model)
    frozen = importlib.import_module(f"dj.apps.openai.migrations.{MIGRATION}")
    assert set(frozen.RETIRED_IDS) == set(ALIASES + SNAPSHOTS)
    assert providers.RETIRED_OPENAI_MODEL_IDS == set(ALIASES + SNAPSHOTS)


def test_retired_models_do_not_appear_in_gateway_fence():
    from dj.apps.openai.test_lineup_v3_migration import _allowed_models
    assert not set(ALIASES + SNAPSHOTS) & set(_allowed_models())
