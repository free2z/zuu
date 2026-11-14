from decimal import Decimal
from io import StringIO
from types import SimpleNamespace

import pytest

from dj.apps.g12f.translation import management_eval as evaluation
from django.core.management import call_command


def test_script_rejection_and_brand_loss_are_separate(monkeypatch):
    Rejected = evaluation.service.TranslationFailed

    monkeypatch.setattr(evaluation.service, "_require_target_script",
                        lambda *_: (_ for _ in ()).throw(Rejected("wrong_script", "mock")))
    monkeypatch.setattr(evaluation.scripts, "script_mismatch", lambda *_: (1, 100))
    row = evaluation.score_reply("Free2Z ZEC", "sr")
    assert row["require_target_script"] == "rejected"
    assert row["script_conformance"] == (1, 100)
    assert row["brand_terms_survived"] == {"Free2Z": True, "2Z": False, "Zcash": False, "ZEC": True}


def test_chinese_variants_explicitly_need_human_review():
    for code in ("zh-Hans", "zh-Hant"):
        assert evaluation.score_reply("Free2Z", code)["human_review_needed"] is True


def test_default_run_only_prices_and_binds_real_production_prompt(monkeypatch):
    quote = SimpleNamespace(price=Decimal("2"))
    monkeypatch.setattr(evaluation.service, "quote_document", lambda **_: quote)
    monkeypatch.setattr(evaluation.service, "translate_document",
                        lambda **_: pytest.fail("provider called without execute"))
    printed = []
    record = evaluation.run(model=SimpleNamespace(provider="mock", model="x", input_price=Decimal("0.01"), output_price=Decimal("0.02"), get_max_response_tokens=lambda: 4096),
                            languages_to_run=["fr"], on_estimate=printed.append)
    assert printed == [Decimal("2")]
    assert record["prompt_source"].endswith("service.build_messages")
    assert record["languages"]["fr"]["status"] == "planned"
    assert record["provider_calls_enabled"] is False


def test_budget_rejects_before_any_provider_call(monkeypatch):
    monkeypatch.setattr(evaluation.service, "quote_document",
                        lambda **_: SimpleNamespace(price=Decimal("3")))
    called = []
    monkeypatch.setattr(evaluation, "maximum_provider_usd", lambda *_: Decimal("3"))
    monkeypatch.setattr(evaluation.service, "translate_document", lambda **_: called.append(1))
    with pytest.raises(ValueError, match="exceeds cap"):
        evaluation.run(model=object(), languages_to_run=["fr"], call_provider=True,
                       spend_cap=Decimal("2"))
    assert called == []


def test_language_selection_is_nonempty_and_sell_list_bounded():
    with pytest.raises(ValueError, match="at least one"):
        evaluation.validate_languages([])
    with pytest.raises(ValueError, match="not TRANSLATABLE"):
        evaluation.validate_languages(["zz-invalid"])
    assert evaluation.validate_languages(["fr"]) == ("fr",)


def test_provider_error_and_missing_usage_are_not_successful_records(monkeypatch):
    monkeypatch.setattr(evaluation.service, "quote_document",
                        lambda **_: SimpleNamespace(price=Decimal("1")))
    monkeypatch.setattr(evaluation, "maximum_provider_usd", lambda *_: Decimal("0.01"))
    monkeypatch.setattr(evaluation.service, "translate_document",
                        lambda **_: (_ for _ in ()).throw(evaluation.service.TranslationFailed("timeout", "mock")))
    error_record = evaluation.run(model=SimpleNamespace(provider="p", model="m", input_price=Decimal("0.01"), output_price=Decimal("0.02"), get_max_response_tokens=lambda: 4096),
                                  languages_to_run=["fr"], call_provider=True, spend_cap=Decimal("1"))
    assert error_record["languages"]["fr"]["status"] == "error"
    assert "script_conformance" not in error_record["languages"]["fr"]

    monkeypatch.setattr(evaluation.service, "translate_document", lambda **_: SimpleNamespace(
        input_tokens=0, output_tokens=4, raw_title="", raw_description="", content=""))
    usage_record = evaluation.run(model=SimpleNamespace(provider="p", model="m", input_price=Decimal("0.01"), output_price=Decimal("0.02"), get_max_response_tokens=lambda: 4096),
                                  languages_to_run=["fr"], call_provider=True, spend_cap=Decimal("1"))
    assert usage_record["languages"]["fr"]["error_type"] == "MissingProviderUsage"


def test_duplicate_languages_are_deduplicated_before_quotes_or_calls(monkeypatch):
    quotes = []
    monkeypatch.setattr(evaluation.service, "quote_document", lambda **_: (
        quotes.append(1) or SimpleNamespace(price=Decimal("1"))))
    record = evaluation.run(model=SimpleNamespace(provider="p", model="m", input_price=Decimal("0.01"), output_price=Decimal("0.02"), get_max_response_tokens=lambda: 4096),
                            languages_to_run=["fr", "fr"])
    assert len(quotes) == 1
    assert list(record["languages"]) == ["fr"]


def test_brand_occurrences_do_not_count_embedded_2z(monkeypatch):
    monkeypatch.setattr(evaluation.service, "_require_target_script", lambda *_: None)
    row = evaluation.score_reply("Free2Z and ZECoin", "fr")
    assert row["brand_terms_survived"]["Free2Z"] is True
    assert row["brand_terms_survived"]["2Z"] is False
    assert row["brand_terms_survived"]["ZEC"] is False


def test_management_command_dry_run_prints_estimate_and_never_calls_provider(monkeypatch, tmp_path):
    model = SimpleNamespace(provider="p", model="m", input_price=Decimal("0.01"), output_price=Decimal("0.02"), get_max_response_tokens=lambda: 4096)
    monkeypatch.setattr("dj.apps.g12f.management.commands.eval_translation_output.select_translation_model", lambda: model)
    monkeypatch.setattr(evaluation, "maximum_provider_usd", lambda *_: Decimal("0.01"))
    monkeypatch.setattr(evaluation.service, "quote_document", lambda **_: SimpleNamespace(price=Decimal("1")))
    monkeypatch.setattr(evaluation.service, "translate_document", lambda **_: pytest.fail("provider called"))
    out = StringIO()
    call_command("eval_translation_output", "--language", "fr", stdout=out,
                 output=str(tmp_path / "plan.json"))
    assert "1 2Z" in out.getvalue()
    assert "No provider calls" in out.getvalue()
    assert not (tmp_path / "plan.json").exists()


def test_management_command_rejects_invalid_budget_and_unwritable_output_before_call(monkeypatch, tmp_path):
    model = SimpleNamespace(provider="p", model="m", input_price=Decimal("0.01"), output_price=Decimal("0.02"), get_max_response_tokens=lambda: 4096)
    monkeypatch.setattr("dj.apps.g12f.management.commands.eval_translation_output.select_translation_model", lambda: model)
    with pytest.raises(Exception, match="finite positive"):
        call_command("eval_translation_output", "--language", "fr", "--execute",
                     "--max-provider-usd", "NaN", output=str(tmp_path / "x"))
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    with pytest.raises(Exception, match="cannot reserve output"):
        call_command("eval_translation_output", "--language", "fr", "--execute",
                     "--max-provider-usd", "1", output=str(blocker / "x"))


def test_provider_estimate_precedes_mocked_call_and_cap_is_enforced(monkeypatch):
    model = SimpleNamespace(provider="p", model="m", input_price=Decimal("0.01"), output_price=Decimal("0.02"), get_max_response_tokens=lambda: 4096)
    monkeypatch.setattr(evaluation.service, "quote_document", lambda **_: SimpleNamespace(price=1))
    monkeypatch.setattr(evaluation, "maximum_provider_usd", lambda *_: Decimal("0.03"))
    events = []

    class Result:
        raw_title = ""
        raw_description = ""
        content = "translated"
        input_tokens = 4
        output_tokens = 2

    monkeypatch.setattr(evaluation.service, "translate_document",
                        lambda **_: (events.append("call") or Result()))
    record = evaluation.run(model=model, languages_to_run=["fr"], call_provider=True,
                            spend_cap=Decimal("0.04"), on_estimate=lambda _: events.append("estimate"))
    assert events == ["estimate", "call"]
    assert record["maximum_provider_cost_usd"] == "0.03"
    with pytest.raises(ValueError, match="exceeds cap"):
        evaluation.run(model=model, languages_to_run=["fr"], call_provider=True,
                       spend_cap=Decimal("0.02"))


def test_production_document_gate_observes_raw_wrong_script_reply(monkeypatch):
    unit = SimpleNamespace(kind=evaluation.service.TRANSLATE, text="source", context="body")
    monkeypatch.setattr(evaluation.service, "plan_document", lambda *a, **k: [unit])
    monkeypatch.setattr(evaluation.service, "estimate_wall_clock", lambda *a, **k: SimpleNamespace(total_seconds=0, longest_fragment_seconds=0))
    monkeypatch.setattr(evaluation.service, "wall_clock_shortfall", lambda *a: None)
    raw = "this is a sufficiently long latin script sentence " * 3

    def translate_unit(*args, observer=None, **kwargs):
        observer(raw, 10, 20, [{"role": "user", "content": "synthetic"}])
        return raw, 10, 20

    monkeypatch.setattr(evaluation.service, "translate_unit", translate_unit)
    observed = []
    with pytest.raises(evaluation.service.TranslationFailed) as caught:
        evaluation.service.translate_document(
            title="", description="", content="source", source_language="en",
            target_language="sr", ai_model=object(), output_observer=lambda *x: observed.append(x),
        )
    assert caught.value.code == "wrong_script"
    assert observed == [(raw, 10, 20, [{"role": "user", "content": "synthetic"}])]
