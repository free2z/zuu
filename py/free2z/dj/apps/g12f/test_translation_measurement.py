"""Offline accounting tests; no result here is provider evidence."""
import json
from io import StringIO
from types import SimpleNamespace

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from dj.apps.g12f.management.commands import measure_translation_throughput as harness


@pytest.fixture
def setup_measure(monkeypatch):
    model = SimpleNamespace(provider="openai", model="example", provider_model_id="")
    clock = iter(range(10, 1000))
    monkeypatch.setattr(harness.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(harness.secrets, "token_hex", lambda n: "nonce")
    monkeypatch.setattr(harness.service, "provider_tokens", lambda model, text: len(text))
    monkeypatch.setattr(harness.service, "_output_cap", lambda *args: 4000)
    monkeypatch.setattr(harness.service, "build_messages", lambda *args, **kwargs: [])
    return model


class Stream:
    def __init__(self, pieces, reason="stop", error=None):
        self.pieces = pieces
        self.termination_reason = reason
        self.error = error
        self.usage = SimpleNamespace(output_tokens=15, reasoning_tokens=3)
        self.closed = False

    def __iter__(self):
        yield from self.pieces
        if self.error:
            raise self.error

    def close(self):
        self.closed = True


def run_stream(monkeypatch, model, stream):
    calls = []

    def fake_stream(model, messages, **kwargs):
        calls.append(kwargs)
        return stream

    monkeypatch.setattr(harness, "stream_chat", fake_stream)
    result = harness.measure(model, "lo")
    assert stream.closed
    assert calls[0]["max_retries"] == 0
    assert calls[0]["max_output_tokens"] == 4000
    return result


def test_wrappers_are_normalized_but_rate_is_raw(setup_measure, monkeypatch):
    stream = Stream(['<fragment id="nonce">\n```markdown\n',
                     'hello world\n```\n</fragment>'])
    result = run_stream(monkeypatch, setup_measure, stream)
    assert result["raw_ttft_seconds"] == 1
    assert result["raw_stream_seconds"] == 1
    assert result["translated_output_tokens"] == len("hello world")
    assert result["raw_output_tokens"] > result["translated_output_tokens"]
    assert result["sustained_raw_tokens_per_second"] == len(stream.pieces[1])
    assert result["output_expansion"] == 11 / len(harness.SOURCE)
    assert result["provider_output_tokens"] == 15
    assert result["calibration_eligible"]
    assert result["quality_review"] == "required"


def test_timeout_keeps_partial_diagnostics_and_redacts_error(setup_measure, monkeypatch):
    stream = Stream(["one", "two"], reason=None, error=TimeoutError("secret"))
    result = run_stream(monkeypatch, setup_measure, stream)
    assert result["status"] == "failed"
    assert result["classification"] == "timeout"
    assert result["raw_output_tokens"] == 6
    assert result["raw_ttft_seconds"] == 1
    assert result["elapsed_seconds"] == 3
    assert result["output_cap"] == 4000
    assert not result["calibration_eligible"]
    assert "secret" not in json.dumps(result)


@pytest.mark.parametrize("pieces,reason,expected", [
    ([], "stop", "empty_output"),
    (["one"], "stop", "single_delta"),
    (["one", "two"], None, "unknown_termination"),
    (["one", "two"], "unexpected", "unknown_termination"),
    (["one", "two"], "length", "output_cap"),
    (["one", "two"], "refusal", "refused"),
    (['<fragment id="nonce">', 'unfinished'], "stop", "invalid_envelope"),
    (["preface <fragment>", "text</fragment>"], "stop", "invalid_envelope"),
])
def test_ineligible_results(setup_measure, monkeypatch, pieces, reason, expected):
    result = run_stream(monkeypatch, setup_measure, Stream(pieces, reason))
    assert result["classification"] == expected
    assert not result["calibration_eligible"]


def test_read_cap_keeps_partial_result(setup_measure, monkeypatch):
    monkeypatch.setattr(harness.service, "_read_cap", lambda source: 3)
    result = run_stream(monkeypatch, setup_measure, Stream(["abc", "never"]))
    assert result["classification"] == "read_cap"
    assert result["raw_characters"] == 3
    assert result["status"] == "failed"


def test_unavailable_matrix_is_reported_and_fails(monkeypatch):
    monkeypatch.setattr(harness.service, "model_preference", lambda: ["openai:missing"])
    monkeypatch.setattr(harness.AIModel.objects, "filter", lambda **kwargs: SimpleNamespace(first=lambda: None))
    out = StringIO()
    with pytest.raises(CommandError, match="matrix is incomplete"):
        call_command("measure_translation_throughput", run_paid=True, stdout=out)
    records = [json.loads(line) for line in out.getvalue().splitlines()]
    assert len(records) == 6
    summary = records[-1]
    assert summary["full_matrix_requested"]
    assert len(summary["requested_pairs"]) == len(summary["excluded_pairs"]) == 5
    assert all(row["classification"] == "missing_catalogue_row" for row in records[:-1])
    assert not summary["ineligible_pairs"]
    assert not summary["matrix_complete_pending_quality_review"]


def test_partial_selection_reports_missing_coverage(monkeypatch):
    monkeypatch.setattr(harness.service, "model_preference", lambda: ["openai:a", "openai:b"])
    model = SimpleNamespace(is_enabled=True)
    monkeypatch.setattr(harness.AIModel.objects, "filter", lambda **kwargs: SimpleNamespace(first=lambda: model))
    monkeypatch.setattr(harness, "provider_is_configured", lambda provider: True)
    monkeypatch.setattr(harness.service, "is_callable_model", lambda model: True)
    monkeypatch.setattr(harness, "measure", lambda model, lang: {"status": "measured", "calibration_eligible": True})
    out = StringIO()
    with pytest.raises(CommandError):
        call_command("measure_translation_throughput", run_paid=True, model=["openai:a"], language=["lo"], stdout=out)
    summary = json.loads(out.getvalue().splitlines()[-1])
    assert summary["configured_models"] == ["openai:a", "openai:b"]
    assert summary["measured_pairs"] == [{"model": "openai:a", "language": "lo"}]
    assert not summary["full_matrix_requested"]


def test_wrong_script_is_not_eligible(setup_measure, monkeypatch):
    result = run_stream(monkeypatch, setup_measure, Stream(["English " * 20, "words " * 20]))
    assert result["classification"] == "wrong_script"
    assert result["transport_complete"]
    assert not result["calibration_eligible"]


def test_failed_pair_is_reported_in_summary(monkeypatch):
    monkeypatch.setattr(harness.service, "model_preference", lambda: ["openai:a"])
    model = SimpleNamespace(is_enabled=True)
    monkeypatch.setattr(harness.AIModel.objects, "filter", lambda **kwargs: SimpleNamespace(first=lambda: model))
    monkeypatch.setattr(harness, "provider_is_configured", lambda provider: True)
    monkeypatch.setattr(harness.service, "is_callable_model", lambda model: True)
    monkeypatch.setattr(harness, "measure", lambda model, lang: {"status": "failed", "classification": "timeout", "calibration_eligible": False})
    out = StringIO()
    with pytest.raises(CommandError):
        call_command("measure_translation_throughput", run_paid=True, language=["lo"], stdout=out)
    summary = json.loads(out.getvalue().splitlines()[-1])
    assert summary["failed_pairs"] == summary["ineligible_pairs"] == [{"model": "openai:a", "language": "lo"}]
    assert not summary["measured_pairs"]


def test_outer_fence_and_envelope_are_normalized(setup_measure, monkeypatch):
    result = run_stream(monkeypatch, setup_measure, Stream([
        '```markdown\n<fragment id="nonce">\n', 'hello world\n</fragment>\n```',
    ]))
    assert result["translated_output_tokens"] == len("hello world")
    assert result["calibration_eligible"]


def test_provider_failure_keeps_partial_output(setup_measure, monkeypatch):
    result = run_stream(monkeypatch, setup_measure, Stream(
        ["partial"], reason=None, error=RuntimeError("credential or content"),
    ))
    assert result["classification"] == "provider_error"
    assert result["raw_characters"] == 7
    assert result["raw_ttft_seconds"] == 1
    assert "credential or content" not in json.dumps(result)


@pytest.mark.parametrize("first,enabled,reason", [
    ("kimi:kimi-k3", True, "policy_disabled"),
    ("anthropic:disabled", False, "model_disabled"),
])
def test_disabled_preference_is_visible_but_does_not_block_enabled_matrix(monkeypatch, first, enabled, reason):
    monkeypatch.setattr(harness.service, "model_preference", lambda: [first, "openai:a"])
    # Even an erroneously enabled row must not bypass the provider policy.
    models = {first.split(":")[0]: SimpleNamespace(is_enabled=enabled), "openai": SimpleNamespace(is_enabled=True)}
    monkeypatch.setattr(harness.AIModel.objects, "filter", lambda **kwargs: SimpleNamespace(first=lambda: models[kwargs["provider"]]))
    monkeypatch.setattr(harness, "provider_is_configured", lambda provider: True)
    monkeypatch.setattr(harness.service, "is_callable_model", lambda model: True)
    calls = []
    def measure(model, language):
        calls.append((model, language))
        return {"status": "measured", "calibration_eligible": True}
    monkeypatch.setattr(harness, "measure", measure)
    out = StringIO()
    call_command("measure_translation_throughput", run_paid=True, stdout=out)
    records = [json.loads(line) for line in out.getvalue().splitlines()]
    summary = records[-1]
    assert all(row["classification"] == reason for row in records[:5])
    assert summary["required_models"] == ["openai:a"]
    assert len(summary["excluded_pairs"]) == len(summary["measured_pairs"]) == 5
    assert summary["matrix_complete_pending_quality_review"]
    assert len(calls) == 5 and all(model is models["openai"] for model, _ in calls)
    subset_out = StringIO()
    call_command("measure_translation_throughput", run_paid=True,
                 model=["openai:a"], stdout=subset_out)
    subset_summary = json.loads(subset_out.getvalue().splitlines()[-1])
    assert subset_summary["full_matrix_requested"]
    assert subset_summary["matrix_complete_pending_quality_review"]
    assert len(subset_summary["excluded_pairs"]) == 5


def test_enabled_model_without_credentials_is_an_evidence_gap(monkeypatch):
    monkeypatch.setattr(harness.service, "model_preference", lambda: ["openai:a"])
    model = SimpleNamespace(is_enabled=True)
    monkeypatch.setattr(harness.AIModel.objects, "filter", lambda **kwargs: SimpleNamespace(first=lambda: model))
    monkeypatch.setattr(harness, "provider_is_configured", lambda provider: False)
    monkeypatch.setattr(harness, "measure", lambda *args: pytest.fail("must not call provider"))
    out = StringIO()
    with pytest.raises(CommandError, match="matrix is incomplete"):
        call_command("measure_translation_throughput", run_paid=True, stdout=out)
    records = [json.loads(line) for line in out.getvalue().splitlines()]
    summary = records[-1]
    assert all(row["classification"] == "missing_credentials" for row in records[:-1])
    assert summary["required_models"] == ["openai:a"]
    assert len(summary["unavailable_pairs"]) == len(summary["ineligible_pairs"]) == 5
    assert not summary["matrix_complete_pending_quality_review"]
