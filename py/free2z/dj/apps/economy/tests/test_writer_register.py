"""Runtime model completeness and separately declared finance dispositions."""
import json
from pathlib import Path

from django.apps import apps


def test_register_includes_indirect_runtime_models_without_claiming_financial_review():
    from dj.apps.jobs.ops import ProcrastinateEvent
    register = json.loads((Path(__file__).parents[1] / 'writer-register.json').read_text())
    model_labels = [row['model'] for row in register['models']]
    assert model_labels
    assert len(model_labels) == len(set(model_labels))
    assert model_labels == sorted(model_labels)
    assert {model._meta.label for model in apps.get_models(include_auto_created=False)} == set(model_labels)
    event = next(row for row in register['models'] if row['model'] == ProcrastinateEvent._meta.label)
    assert not ProcrastinateEvent._meta.managed
    assert event['table'] == 'procrastinate_events'
    assert event['review_scope'] == 'bounded source triage only'
    from oauth2_provider.models import get_application_model
    assert get_application_model()._meta.label in {row['model'] for row in register['models']}
    assert all(row['review_scope'] in {'financial writer inventory', 'bounded source triage only'} for row in register['models'])


def test_every_source_writer_has_a_financial_disposition_or_bounded_caller_review():
    register = json.loads((Path(__file__).parents[1] / 'writer-register.json').read_text())
    scopes = json.loads((Path(__file__).parents[1] / 'writer-scopes.json').read_text())
    assert scopes['remaining_activation_blockers']
    for row in register['writer_calls']:
        assert row['source'] in register['source_sha256']
        assert row['disposition'] == 'source writer identified; outer transaction order requires per-path review'
