#!/usr/bin/env bash
# Compile immutable released SDK sources and decode actual gateway producer
# output captured by the conformance integration test.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
response_dir=${F2Z_RELEASED_SDK_RESPONSE_DIR:-}
target_root=${F2Z_RELEASED_SDK_TARGET_ROOT:-}
if [[ -z "$response_dir" || ! -d "$response_dir" ]]; then
  echo "F2Z_RELEASED_SDK_RESPONSE_DIR must name the producer conformance output" >&2
  exit 1
fi

node "$root/scripts/free2z/released-sdk-register.mjs" --self-test
register=$(node "$root/scripts/free2z/released-sdk-register.mjs" "$root/docs/free2z/sdk/RELEASES.md")
scratch=$(mktemp -d "${TMPDIR:-/tmp}/f2z-released-sdk-compat.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

chat_count=$(find "$response_dir" -maxdepth 1 -type f -name '*.json' ! -name 'models-response.json' ! -name 'long-context-catalog.json' | wc -l)
stream_count=$(find "$response_dir" -maxdepth 1 -type f -name 'stream-*.jsonl' | wc -l)
for required in models-response.json long-context-catalog.json; do
  [[ -s "$response_dir/$required" ]] || { echo "missing producer catalogue artifact $required" >&2; exit 1; }
done
(( chat_count >= 20 )) || { echo "expected >=20 conformance ChatResponse bodies, found $chat_count" >&2; exit 1; }
(( stream_count >= 20 )) || { echo "expected >=20 conformance SSE transcripts, found $stream_count" >&2; exit 1; }

while IFS=$'\t' read -r release_id sha features; do
  source="$scratch/$sha"
  mkdir -p "$source"
  # The full commit URL is immutable. No caller-provided source archive can
  # relabel arbitrary code as a released revision.
  curl --fail --silent --show-error --location \
    "https://github.com/free2z/zuu/archive/${sha}.tar.gz" \
    | tar -xz --strip-components=1 -C "$source"

  sdk_manifest="$source/rs/crates/f2z-sdk/Cargo.toml"
  proto_manifest="$source/rs/crates/f2z-ai-proto/Cargo.toml"
  [[ -f "$sdk_manifest" && -f "$proto_manifest" ]] || { echo "$sha: SDK/proto source archive is incomplete" >&2; exit 1; }
  mkdir -p "$source/rs/crates/f2z-sdk/tests"
  cat > "$source/rs/crates/f2z-sdk/tests/released_response_compat.rs" <<'RUST'
#![allow(missing_docs, clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

use f2z_sdk::ai::{ModelInfo, Models};
use f2z_sdk::proto::catalog_v2::CatalogV2;
use f2z_sdk::proto::chat::ChatResponse;
use f2z_sdk::proto::Event;
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn json_files() -> Vec<std::path::PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(std::env::var("F2Z_RELEASED_SDK_RESPONSE_DIR").unwrap())
        .unwrap().map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json")
            && path.file_name().unwrap() != "models-response.json"
            && path.file_name().unwrap() != "long-context-catalog.json")
        .collect();
    paths.sort();
    paths
}

#[test]
fn actual_chat_and_catalogue_producer_bodies_decode() {
    let root = std::path::PathBuf::from(std::env::var("F2Z_RELEASED_SDK_RESPONSE_DIR").unwrap());
    let paths = json_files();
    assert!(paths.len() >= 20, "missing or vacuous ChatResponse corpus");
    let mut ordinary = 0;
    let mut tools = 0;
    for path in paths {
        let bytes = std::fs::read(&path).unwrap();
        let response: ChatResponse = serde_json::from_slice(&bytes)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        assert!(!response.call_id.is_empty());
        if response.message.tool_calls.is_empty() { ordinary += 1; } else { tools += 1; }
        let mut extended: Value = serde_json::from_slice(&bytes).unwrap();
        extended["gateway_extension"] = json!({"revision": 2});
        extended["message"]["future_message_member"] = json!(true);
        extended["usage"]["future_usage_member"] = json!(7);
        if let Some(part) = extended["message"].get_mut("content")
            .and_then(Value::as_array_mut).and_then(|parts| parts.first_mut()) {
            part["future_part_member"] = json!("ignored");
        }
        serde_json::from_value::<ChatResponse>(extended)
            .unwrap_or_else(|error| panic!("{} additive response member: {error}", path.display()));
        let mut malformed: Value = serde_json::from_slice(&bytes).unwrap();
        malformed.as_object_mut().unwrap().remove("message");
        assert!(serde_json::from_value::<ChatResponse>(malformed).is_err(), "accepted missing message");
    }
    assert!(ordinary > 0, "no ordinary assistant response decoded");
    assert!(tools > 0, "no complete tool-call response decoded");

    let models_bytes = std::fs::read(root.join("models-response.json")).unwrap();
    let models: Models = serde_json::from_slice(&models_bytes).expect("current GET /v1/models response");
    assert!(!models.models.is_empty(), "empty producer models catalogue");
    let first: ModelInfo = models.models[0].clone();
    assert!(!first.id.is_empty());
    let mut extended: Value = serde_json::from_slice(&models_bytes).unwrap();
    extended["future_catalogue_member"] = json!(true);
    extended["models"][0]["future_model_member"] = json!(true);
    serde_json::from_value::<Models>(extended).expect("additive response metadata");
    let mut malformed: Value = serde_json::from_slice(&models_bytes).unwrap();
    malformed["models"][0].as_object_mut().unwrap().remove("id");
    assert!(serde_json::from_value::<Models>(malformed).is_err(), "accepted a model without its required id");

    let catalog_bytes = std::fs::read(root.join("long-context-catalog.json")).unwrap();
    let catalog: CatalogV2 = serde_json::from_slice(&catalog_bytes).expect("current typed long-context catalogue");
    assert_eq!(catalog.schema, 2);
    assert!(!catalog.models.is_empty());
    let model = &catalog.models[0];
    let tier = model.long_context_pricing.as_ref().expect("producer long-context tier");
    assert!(tier.input_tokens_gt > 0);
    assert!(tier.prices.input_nusd_per_mtok > model.base.prices.input_nusd_per_mtok);
    let mut malformed: Value = serde_json::from_slice(&catalog_bytes).unwrap();
    malformed["models"][0]["long_context_pricing"]["prices"].as_object_mut().unwrap().remove("output_nusd_per_mtok");
    assert!(serde_json::from_value::<CatalogV2>(malformed).is_err(), "accepted a long-context table missing output price");
}

#[test]
fn supported_real_sse_events_decode_and_cover_stream_contract() {
    let root = std::path::PathBuf::from(std::env::var("F2Z_RELEASED_SDK_RESPONSE_DIR").unwrap());
    let mut transcripts: Vec<_> = std::fs::read_dir(root).unwrap().map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with("stream-")
            && path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect();
    transcripts.sort();
    assert!(transcripts.len() >= 20, "missing or vacuous stream corpus");
    let supported = std::env::var("F2Z_RELEASED_SDK_FEATURES").unwrap();
    let preview = supported.contains("aha-preview");
    let mut coverage = BTreeSet::new();
    let mut complete_tool_call = false;
    let mut ordinary_streams = 0;
    let mut tool_streams = 0;
    for transcript in transcripts {
        let mut transcript_has_delta = false;
        let mut transcript_has_tool = false;
        for line in std::fs::read_to_string(&transcript).unwrap().lines() {
            let frame: Value = serde_json::from_str(line).unwrap();
            let name = frame["name"].as_str().unwrap();
            if preview && name == "tool_call_delta" { continue; }
            let event = Event::from_sse(name, frame["data"].as_str().unwrap())
                .unwrap_or_else(|error| panic!("{} {name}: {error}", transcript.display()));
            if name == "tool_call_delta" {
                assert!(!preview, "preview inventory unexpectedly supports tool_call_delta");
                coverage.insert("stream-tool-call-delta");
                continue;
            }
            match event {
                Event::Meta(_) => { coverage.insert("stream-meta"); }
                Event::Delta(_) => { transcript_has_delta = true; coverage.insert("stream-delta"); }
                Event::ToolCall(call) => {
                    assert!(!call.id.is_empty());
                    assert!(!call.name.is_empty());
                    complete_tool_call = true;
                    transcript_has_tool = true;
                    coverage.insert("stream-tool-call");
                }
                Event::Usage(usage) => {
                    assert!(usage.usage.input_tokens + usage.usage.output_tokens > 0);
                    coverage.insert("stream-usage");
                }
                Event::Done(_) => { coverage.insert("stream-done"); }
                Event::Error(_) => panic!("successful conformance stream ended in error"),
                _ => panic!("released SDK returned an unsupported event variant"),
            }
        }
        if transcript_has_tool { tool_streams += 1; }
        if transcript_has_delta && !transcript_has_tool { ordinary_streams += 1; }
    }
    for required in ["stream-meta", "stream-delta", "stream-tool-call", "stream-usage", "stream-done"] {
        assert!(coverage.contains(required), "missing non-vacuous supported event {required}");
    }
    assert!(complete_tool_call, "no complete streamed tool call decoded");
    assert!(ordinary_streams > 0, "no ordinary streamed response decoded");
    assert!(tool_streams > 0, "no streamed tool response decoded");
    if !preview { assert!(coverage.contains("stream-tool-call-delta"), "release inventory requires tool_call_delta"); }
}
RUST

  F2Z_RELEASED_SDK_RESPONSE_DIR="$response_dir" F2Z_RELEASED_SDK_FEATURES="$release_id:$features" \
    CARGO_TARGET_DIR="${target_root:-$scratch}/$release_id" \
    cargo test --locked --no-default-features --manifest-path "$sdk_manifest" --test released_response_compat
done <<< "$register"
