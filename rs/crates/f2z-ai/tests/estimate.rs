//! The input estimate against **recorded provider usage** (free2z/zuu#1164,
//! the ¡AHA! field report): what the gateway reserves must never be below
//! what OpenAI billed, and must be close to it.
//!
//! `tests/fixtures/estimate/`:
//!
//! * `aha_cases.json` + `aha_response_format.json` — 27 real ¡AHA! requests
//!   (synthetic learner states, no learner data) against gpt-4o and
//!   gpt-4o-mini, each with the usage the provider reported through the
//!   gateway and the estimate the byte bound produced for it. The
//!   `response_format` is the ~28 KB strict schema, stored once.
//! * `openai_prompt_probes.json` — 27 shapes measured against
//!   `usage.prompt_tokens` on 2026-10-05: schema features (terse, described,
//!   enums, constraints, patterns, nested, nullable/anyOf), tool definitions,
//!   tool-call history, `tool_choice`, and a request with no schema.
//! * `tokenizer_oracle.json` — texts with their counts from the reference
//!   `tiktoken` (Python 0.14.0), for both encodings.
#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_ai::estimate::{Encoding, input_tokens};
use f2z_ai_proto::{catalog::CatalogModel, chat::ChatRequest};
use serde_json::{Value, json};
use std::path::PathBuf;

fn fixture(name: &str) -> Value {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests/fixtures/estimate", name]
        .iter()
        .collect();
    serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture readable"))
        .expect("fixture is JSON")
}

fn model(provider: &str, upstream: &str) -> CatalogModel {
    serde_json::from_value(json!({
        "id": upstream, "provider": provider, "provider_model_id": upstream,
        "api_style": "openai_chat",
        "prices": {"input_nusd_per_mtok": 1000, "cached_input_nusd_per_mtok": 100,
                   "cache_write_nusd_per_mtok": 1250, "output_nusd_per_mtok": 4000,
                   "image_nusd": 0, "tool_call_nusd": 0},
        "min_charge_2z": 1, "safety_factor_bps": 10000, "context_window": 128000,
        "max_output_tokens": 16384, "ttfb_timeout_ms": 10000, "enabled": true
    }))
    .unwrap()
}

/// The recorded prompt: the uncached and cached input buckets together.
fn billed_input(usage: &Value) -> u64 {
    usage["input_tokens"].as_u64().unwrap() + usage["cached_input_tokens"].as_u64().unwrap()
}

#[test]
fn the_aha_corpus_is_never_under_estimated_and_lands_within_fifteen_percent() {
    let format = fixture("aha_response_format.json");
    let cases = fixture("aha_cases.json");
    let cases = cases.as_array().unwrap();
    assert_eq!(cases.len(), 27);
    let (mut worst_over, mut legacy_min) = (0u64, u64::MAX);
    for case in cases {
        let mut request = json!({
            "model": case["model"], "messages": case["messages"],
            "max_output_tokens": case["max_output_tokens"],
            "response_format": format,
        });
        let request: ChatRequest = serde_json::from_value(request.take()).unwrap();
        let actual = billed_input(&case["usage"]);
        let catalog_model = model("openai", case["model"].as_str().unwrap());
        let estimate = input_tokens(&request, &catalog_model).unwrap();
        let name = case["name"].as_str().unwrap();
        assert!(estimate.exact, "{name}");
        assert!(
            estimate.tokens >= actual,
            "{name}: estimated {} below the {actual} the provider billed",
            estimate.tokens
        );
        // Measured 1.077–1.079 on this corpus; the bound leaves room for a
        // tokeniser-data bump without admitting a regression to the bound.
        assert!(
            estimate.tokens * 100 <= actual * 115,
            "{name}: estimated {} is more than 15% over the {actual} billed",
            estimate.tokens
        );
        worst_over = worst_over.max(estimate.tokens * 1000 / actual);
        // The field report: the byte bound reserved ~6× the billed input.
        let legacy = case["legacy_gateway_estimate"].as_u64().unwrap();
        assert!(legacy > actual * 5, "{name}: legacy {legacy} vs {actual}");
        legacy_min = legacy_min.min(legacy * 1000 / actual);
        // Negative control for the bound above: the byte bound this
        // estimate replaces — still what a provider without a tokeniser
        // gets — fails it by a wide margin, so the assertion has teeth.
        let bound = input_tokens(&request, &model("anthropic", "claude-sonnet-5")).unwrap();
        assert!(!bound.exact);
        assert!(
            bound.tokens * 100 > actual * 400,
            "{name}: {}",
            bound.tokens
        );
    }
    eprintln!("aha corpus: worst over-estimate {worst_over}‰, legacy at least {legacy_min}‰");
}

#[test]
fn every_measured_prompt_shape_is_covered_and_bounded() {
    let probes = fixture("openai_prompt_probes.json");
    let probes = probes.as_array().unwrap();
    assert!(probes.len() >= 24, "{}", probes.len());
    for probe in probes {
        let name = probe["name"].as_str().unwrap();
        let request: ChatRequest = serde_json::from_value(probe["request"].clone())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let actual = probe["prompt_tokens"].as_u64().unwrap();
        let catalog_model = model("openai", probe["request"]["model"].as_str().unwrap());
        let estimate = input_tokens(&request, &catalog_model).unwrap();
        assert!(estimate.exact, "{name}");
        assert!(
            estimate.tokens >= actual,
            "{name}: estimated {} below the {actual} measured",
            estimate.tokens
        );
        // The framing constants are measured values rounded up, so small
        // shapes carry the rounding: a schema that is nothing but enum
        // values measures 33% over. Real prompts (the corpus above) are
        // within 8%.
        assert!(
            estimate.tokens * 100 <= actual * 135,
            "{name}: estimated {} is more than 35% over the {actual} measured",
            estimate.tokens
        );
        if name == "no_schema" || name == "developer_role" || name == "multipart_text" {
            // Plain messages are exact.
            assert_eq!(estimate.tokens, actual, "{name}");
        }
    }
}

#[test]
fn the_vendored_tokeniser_agrees_with_the_reference_implementation() {
    let oracle = fixture("tokenizer_oracle.json");
    for case in oracle.as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        assert_eq!(
            Encoding::O200kBase.count(text),
            case["o200k_base"].as_u64().unwrap(),
            "o200k: {text:?}"
        );
        assert_eq!(
            Encoding::Cl100kBase.count(text),
            case["cl100k_base"].as_u64().unwrap(),
            "cl100k: {text:?}"
        );
    }
}
