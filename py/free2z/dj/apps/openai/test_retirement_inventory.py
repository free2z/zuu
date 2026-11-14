"""No provider I/O: lifecycle policy is independent of mutable listing/flags."""
import importlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from django.apps import apps
from django.core.management import call_command
from django.db import connection

from f2z.ai import providers, retirements
from .discovery import DiscoveredModel, record_listing
from .models import AIModel
from .provider_inventory import provider_inventory
from .test_model_availability import _make_model

NOW = datetime(2026, 11, 10, tzinfo=timezone.utc)
CASES = [(p, m) for p in {e.provider for e in retirements.RETIREMENTS}
         for m in sorted(retirements.retired_model_ids(p, at=NOW))]
CASES += [('openai', 'ft:gpt-4.1-nano-2025-04-14:org:custom:id')]


@pytest.mark.django_db
@pytest.mark.parametrize('provider,model', CASES)
@pytest.mark.parametrize('pinned', [False, True])
def test_retired_identity_survives_admin_bulk_enable_and_discovery(provider, model, pinned, settings, monkeypatch):
    settings.OPENAI_API_KEY = settings.ANTHROPIC_API_KEY = settings.XAI_API_KEY = 'unused'
    row = _make_model(provider=provider, model='operator-choice' if pinned else model,
                      provider_model_id=model if pinned else '')
    assert not row.is_enabled and not row.is_ga
    # Admin edits preserve a retired public identity even with a live pin.
    if not pinned:
        row.provider_model_id = 'live-other-id'
    row.is_enabled = row.is_ga = True
    row.save()
    row.refresh_from_db()
    assert not row.is_enabled and not row.is_ga
    AIModel.objects.filter(pk=row.pk).update(is_enabled=True, is_ga=True)
    record_listing(provider, [DiscoveredModel(id=model), DiscoveredModel(id=row.upstream_model_id)])
    assert not AIModel.objects.enabled().filter(pk=row.pk).exists()
    assert not AIModel.objects.selectable().filter(pk=row.pk).exists()
    listing = next(r for r in provider_inventory() if r['provider'] == provider and r['model'] == row.model)
    assert listing['unavailable_reason'] == 'provider_retired'
    client = Mock(side_effect=AssertionError('unexpected provider I/O'))
    monkeypatch.setattr(providers, 'get_client', client)
    with pytest.raises(providers.ModelDisabled):
        list(providers.stream_chat(SimpleNamespace(provider=provider, model=row.model,
             provider_model_id=row.provider_model_id, is_enabled=True), []))
    client.assert_not_called()


@pytest.mark.parametrize('entry', retirements.RETIREMENTS)
def test_cutoff_is_exact_and_provider_scoped(entry):
    for model in entry.ids:
        assert model not in retirements.retired_model_ids(entry.provider, at=entry.cutoff-timedelta(microseconds=1))
        assert model in retirements.retired_model_ids(entry.provider, at=entry.cutoff)
        assert not retirements.model_is_retired('unknown-provider', model)
    assert entry.source.startswith('https://')


@pytest.mark.django_db
def test_clock_transition_applies_without_reseed(monkeypatch):
    AIModel.objects.filter(provider='openai', model='gpt-5').delete()
    row = _make_model(model='gpt-5')
    assert AIModel.objects.enabled().filter(pk=row.pk).exists()
    real_datetime = datetime
    class AfterShutdown(datetime):
        @classmethod
        def now(cls, tz=None):
            return real_datetime(2026, 12, 11, tzinfo=timezone.utc)
    monkeypatch.setattr(retirements, 'datetime', AfterShutdown)
    assert not AIModel.objects.enabled().filter(pk=row.pk).exists()
    with pytest.raises(providers.ModelDisabled):
        providers.refuse_retired_model('openai', 'gpt-5')
    call_command('seed_ai_models', stdout=StringIO())
    row.refresh_from_db()
    assert not row.is_enabled and not row.is_ga


@pytest.mark.django_db
def test_frozen_migration_preserves_prices_and_rows():
    migration = importlib.import_module('dj.apps.openai.migrations.0037_retirement_inventory')
    from dj.apps.pricing.models import RateCardModel
    row = _make_model(model='gpt-4-turbo', input_price='0.00001')
    AIModel.objects.filter(pk=row.pk).update(is_enabled=True, is_ga=True)
    cards = list(RateCardModel.objects.order_by('pk').values())
    with connection.schema_editor() as editor:
        migration.retire(apps, editor)
    row.refresh_from_db()
    assert row.input_price == Decimal("0.00001")
    assert not row.is_enabled and not row.is_ga
    assert list(RateCardModel.objects.order_by('pk').values()) == cards
    for provider, ids in migration.RETIRED_IDS.items():
        assert set(ids) == retirements.retired_model_ids(provider, at=NOW)


def test_earliest_cutoff_wins_for_cross_cohort_pin():
    assert retirements.retirement_for('openai', 'gpt-image-2', 'gpt-5').cutoff == datetime(2026, 12, 11, tzinfo=timezone.utc)


def test_retired_image_choice_and_announcement_never_reach_client(settings, monkeypatch):
    from . import views
    from dj.apps.twitter import announcement_content
    settings.OPENAI_IMAGE_MODEL = 'gpt-image-1'
    client = Mock()
    monkeypatch.setattr(views, 'oai_client', client)
    assert views._cover_choice_snapshot() is None
    monkeypatch.setattr(providers, 'get_client', client)
    with pytest.raises(providers.ModelDisabled):
        announcement_content.generate_image('theme', 'key')
    client.assert_not_called()
    client.images.generate.assert_not_called()
    settings.F2ZP2P_COPY_MODEL = 'claude-opus-4-1-20250805'
    with pytest.raises(providers.ModelDisabled):
        announcement_content._call_claude(Mock())
    client.assert_not_called()


def test_finetune_inherits_exact_base_without_prefix_or_provider_overreach():
    assert retirements.model_is_retired('openai', 'ft:o1-2024-12-17:org:custom:id')
    assert not retirements.model_is_retired('openai', 'ft:o1-newer:org:custom:id')
    assert not retirements.model_is_retired('xai', 'ft:o1-2024-12-17:org:custom:id')
    notice = retirements.retirement_for('openai', 'custom', 'ft:gpt-5:org:custom:id')
    assert notice.cutoff == datetime(2026, 12, 11, tzinfo=timezone.utc)


@pytest.mark.parametrize('invalid', [None, 123, [], {}, True, '', '   '])
def test_invalid_image_configuration_is_unavailable_without_outbound(invalid, settings, monkeypatch):
    from . import views
    from dj.apps.twitter import announcement_content
    settings.OPENAI_IMAGE_MODEL = invalid
    client = Mock()
    monkeypatch.setattr(views, 'oai_client', client)
    monkeypatch.setattr(providers, 'get_client', client)
    assert views._cover_choice_snapshot() is None
    assert retirements.retirement_for('openai', invalid, invalid) is None
    assert not retirements.model_is_retired('openai', invalid, invalid)
    with pytest.raises(providers.ModelDisabled, match='Invalid AI model identity'):
        announcement_content.generate_image('theme', 'key')
    client.assert_not_called()
    client.images.generate.assert_not_called()


@pytest.mark.parametrize('retired', ['dall-e-2', 'dall-e-3', 'gpt-4-0125-preview',
                                   'gpt-4-turbo-preview', 'gpt-4-turbo-preview-completions'])
def test_newly_audited_overrides_are_refused_before_provider_io(retired, settings, monkeypatch):
    from . import views
    from dj.apps.twitter import announcement_content
    from f2z.openai import util
    settings.OPENAI_IMAGE_MODEL = retired
    settings.PROMPT_COMPLETION_MODEL = retired
    client = Mock()
    monkeypatch.setattr(views, 'oai_client', client)
    monkeypatch.setattr(util, 'oai_client', client)
    monkeypatch.setattr(providers, 'get_client', client)
    assert views._cover_choice_snapshot() is None
    for invoke in (lambda: announcement_content.generate_image('theme', 'key'),
                   lambda: providers.complete_prompt(client, 'prompt', max_tokens=8),
                   lambda: util.tag_content('content', model=retired)):
        with pytest.raises(providers.ModelDisabled):
            invoke()
    client.assert_not_called()
    client.images.generate.assert_not_called()
    client.chat.completions.create.assert_not_called()


@pytest.mark.parametrize('model', ['gpt-image-1-mini', 'gpt-image-1.5',
                                 'gpt-image-1.5-2025-12-16', 'chatgpt-image-latest'])
def test_december_image_shutdown_closes_choices_and_dispatch(model, settings, monkeypatch):
    from . import views
    from dj.apps.twitter import announcement_content
    settings.OPENAI_IMAGE_MODEL = model
    client = Mock()
    monkeypatch.setattr(views, 'oai_client', client)
    monkeypatch.setattr(providers, 'get_client', client)
    class Clock(datetime):
        instant = datetime(2026, 11, 30, 23, 59, 59, tzinfo=timezone.utc)
        @classmethod
        def now(cls, tz=None):
            return cls.instant
    monkeypatch.setattr(retirements, 'datetime', Clock)
    assert views._cover_choice_snapshot()['model'] == model
    providers.refuse_retired_model('openai', model)
    Clock.instant = datetime(2026, 12, 1, tzinfo=timezone.utc)
    assert views._cover_choice_snapshot() is None
    with pytest.raises(providers.ModelDisabled):
        announcement_content.generate_image('theme', 'key')
    client.assert_not_called()
