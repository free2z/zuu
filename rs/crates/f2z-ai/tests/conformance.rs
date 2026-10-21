//! The cross-provider conformance runner (free2z/zuu#1147, ai-api-design
//! §3.4, slice S10a). Every fixture in `tests/fixtures/conformance/` runs
//! through the real gateway — HTTP server, metering layer, the real provider
//! adapter for its `api_style` — against the `f2z-ai-testkit` loopback mock
//! replaying the fixture's provider stream, with `stream` on and off. No
//! real provider is ever called. The schema and its rules are in the
//! corpus's README.
//!
//! What runs here:
//!
//! * every success fixture: the exact provider request (order-sensitive,
//!   from the bytes the mock received), the client's events, finish reason,
//!   usage, one hold and the expected number of extensions, a settlement;
//! * every refusal fixture: the typed `4xx` on `/v1/chat` (streamed and not)
//!   and `/v1/chat/estimate`, with no hold and no provider request;
//! * for every capability a success fixture exercises, the same request on a
//!   catalogue that withdraws it is refused before any hold or I/O — the
//!   gating really is the signed catalogue's;
//! * every feature's `mutations.json`: each negative control, applied to what
//!   the gateway really sent and produced, must be caught by the comparator.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod adapter_support;
mod conformance_support;
mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

use axum::http::StatusCode;
use conformance_support::{
    Fixture, J, Observed, Op, Target, client_events, content_events, events_mismatch, load, mutate,
    provider_request_mismatches, reply_events, request_text, required_capabilities, ser,
    usage_mismatches, validate,
};
use f2z_ai_proto::Event;
use f2z_ai_proto::catalog_v2::{CatalogModelV2, CatalogV2, ContextPriceTier};
use f2z_ai_proto::chat::ChatResponse;
use f2z_ai_proto::pricing::Bps;
use f2z_ai_proto::pricing::ModelPrices;
use serde_json::{Value, json};

use conformance_support::Harness;

fn expected_events(fixture: &Fixture, stream: bool) -> Vec<Value> {
    fixture
        .expect
        .events
        .clone()
        .unwrap()
        .into_iter()
        // Fragments of a call still being generated are a streaming-only
        // convenience (zuu#1142): a `stream: false` reply has the whole call.
        .filter(|e| stream || e["type"] != "tool_call_delta")
        .collect()
}

/// The `stream: false` equivalent of the expected events: all text as one
/// delta, then the complete calls in order.
fn expected_reply_events(fixture: &Fixture) -> J {
    let events = expected_events(fixture, false);
    let text: String = events
        .iter()
        .filter(|e| e["type"] == "delta")
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    let mut out = Vec::new();
    if !text.is_empty() {
        out.push(json!({"type": "delta", "text": text}));
    }
    out.extend(events.into_iter().filter(|e| e["type"] == "tool_call"));
    J::of(&Value::Array(out))
}

fn save_artifact(directory: &std::path::Path, name: &str, bytes: &[u8]) {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(name))
        .unwrap()
        .write_all(bytes)
        .unwrap();
}

async fn capture_catalogues(fixture: &Fixture, directory: Option<&std::path::Path>) {
    let Some(directory) = directory else {
        return;
    };
    let harness = Harness::start(fixture, &fixture.catalog_model.capabilities).await;
    let (status, body) = harness.get("/v1/models").await;
    assert_eq!(status, StatusCode::OK, "GET /v1/models: {body}");
    let models: Value = serde_json::from_str(&body).unwrap();
    assert!(!models["models"].as_array().unwrap().is_empty());
    save_artifact(directory, "models-response.json", body.as_bytes());

    // The schema-2 type is an opt-in producer contract today. Build it from
    // the same signed catalogue model used by the production route, then let
    // the current proto serializer produce the bytes the released decoder
    // consumes. Its tier is deliberately above the model's base rates.
    let verified = conformance_support::catalog_for(fixture, &fixture.catalog_model.capabilities);
    let base = verified.catalog().models[0].clone();
    let tier_prices = ModelPrices {
        input_nusd_per_mtok: base.prices.input_nusd_per_mtok + 1,
        cached_input_nusd_per_mtok: base.prices.cached_input_nusd_per_mtok + 1,
        cache_write_nusd_per_mtok: base.prices.cache_write_nusd_per_mtok + 1,
        output_nusd_per_mtok: base.prices.output_nusd_per_mtok + 1,
        ..base.prices
    };
    let catalog = CatalogV2 {
        schema: 2,
        version: verified.catalog().version,
        issued_at: verified.catalog().issued_at,
        expires_at: verified.catalog().expires_at,
        rate_card_version: verified.catalog().rate_card_version,
        platform_margin_bps: Bps(verified.catalog().platform_margin_bps.0),
        disabled_providers: verified.catalog().disabled_providers.clone(),
        models: vec![CatalogModelV2 {
            base,
            long_context_pricing: Some(ContextPriceTier {
                input_tokens_gt: 100_000,
                prices: tier_prices,
            }),
        }],
    };
    save_artifact(
        directory,
        "long-context-catalog.json",
        &serde_json::to_vec(&catalog).unwrap(),
    );
    harness.stop().await;
}

/// Run one success fixture in one stream mode and assert all of it.
async fn run(
    fixture: &Fixture,
    stream: bool,
    artifact_directory: Option<&std::path::Path>,
) -> Observed {
    let name = format!("{} (stream: {stream})", fixture.name);
    let harness = Harness::start(fixture, &fixture.catalog_model.capabilities).await;
    let (status, body) = harness
        .post("/v1/chat", &request_text(fixture, stream))
        .await;
    assert_eq!(status, StatusCode::OK, "{name}: {body}");
    let e = &fixture.expect;

    // What the provider received, as bytes, in order.
    let recorded = harness.mock.recorded_requests();
    assert_eq!(recorded.len(), 1, "{name}: one provider request");
    let sent = J::parse(
        recorded[0]
            .body_text
            .as_deref()
            .unwrap_or_else(|| panic!("{name}: the request body was not recorded as text")),
    );
    let mismatches = provider_request_mismatches(
        e.provider_request.as_ref().unwrap(),
        &sent,
        &fixture.api_style,
    );
    assert!(
        mismatches.is_empty(),
        "{name}: provider request\n  {}",
        mismatches.join("\n  ")
    );

    let (events, usage, finish_reason) = if stream {
        let events = client_events(&body);
        if let Some(directory) = artifact_directory {
            let mut event_json = Vec::new();
            for frame in body.split("\n\n") {
                let mut name = None;
                let mut data = String::new();
                for line in frame.lines() {
                    if let Some(value) = line.strip_prefix("event: ") {
                        name = Some(value);
                    } else if let Some(value) = line.strip_prefix("data: ") {
                        data.push_str(value);
                    }
                }
                if let Some(name) = name {
                    event_json.push(json!({"name": name, "data": data}));
                }
            }
            assert!(
                !event_json.is_empty(),
                "stream emitted no JSON events: {body}"
            );
            let safe_name = fixture.name.replace(['/', '\\'], "_");
            let artifact = event_json
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            save_artifact(
                directory,
                &format!("stream-{safe_name}.jsonl"),
                artifact.as_bytes(),
            );
        }
        assert!(
            matches!(events.first(), Some(Event::Meta(_))),
            "{name}: meta first: {body}"
        );
        let Some(Event::Done(done)) = events.last() else {
            panic!("{name}: done last: {body}");
        };
        assert!(
            !events.iter().any(|e| matches!(e, Event::Error(_))),
            "{name}: {body}"
        );
        let usages: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                Event::Usage(u) => Some(u.usage),
                _ => None,
            })
            .collect();
        assert_eq!(usages.len(), 1, "{name}: one usage event: {body}");
        assert!(
            matches!(events[events.len() - 2], Event::Usage(_)),
            "{name}: usage just before done"
        );
        (
            content_events(&events),
            ser(&usages[0]),
            ser(&done.finish_reason),
        )
    } else {
        let reply: ChatResponse =
            serde_json::from_str(&body).unwrap_or_else(|e| panic!("{name}: {e}: {body}"));
        reply.check().unwrap();

        // This is the actual typed route body, also consumed by the required
        // historical SDK decoder check after the producer corpus has run.
        if let Some(directory) = artifact_directory {
            std::fs::create_dir_all(directory).unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join(format!("{}.json", fixture.name)))
                .unwrap()
                .write_all(body.as_bytes())
                .unwrap();
        }
        (
            reply_events(&reply),
            ser(&reply.usage),
            ser(&reply.finish_reason),
        )
    };

    if e.provider_stream.is_some() {
        if stream {
            if let Some(m) = events_mismatch(&expected_events(fixture, true), &events) {
                panic!("{name}: {m}");
            }
        } else {
            assert_eq!(
                events.sorted(),
                expected_reply_events(fixture).sorted(),
                "{name}: the reply's content"
            );
        }
        for call in events.to_value().as_array().unwrap() {
            if call["type"] == "tool_call" {
                serde_json::from_str::<Value>(call["arguments"].as_str().unwrap())
                    .unwrap_or_else(|_| panic!("{name}: tool call arguments are JSON text"));
            }
        }
        let mismatches = usage_mismatches(e.usage.as_ref().unwrap(), &usage);
        assert!(mismatches.is_empty(), "{name}: {}", mismatches.join("; "));
        assert_eq!(
            finish_reason,
            J::String(e.finish_reason.clone().unwrap()),
            "{name}: finish_reason"
        );
    }

    // Billing: one hold, the expected heartbeats, settled on provider usage.
    assert_eq!(harness.settled().await, Some("settled"), "{name}: settled");
    {
        let ledger = harness.ledger.0.lock().unwrap();
        assert_eq!(ledger.holds, 1, "{name}: one hold");
        // The settlement is the usage the client was shown, priced at the
        // signed prices — never a re-derived or re-scaled number.
        assert_eq!(ledger.settles.len(), 1, "{name}: one settle");
        let (cost, settled) = &ledger.settles[0];
        assert_eq!(
            J::of(settled).sorted(),
            usage.sorted(),
            "{name}: settled usage"
        );
        let want = conformance_support::PRICES.cost_nusd(settled);
        assert!(want > 0, "{name}: a priced call costs something");
        assert_eq!(
            u128::try_from(*cost).unwrap(),
            want,
            "{name}: settled cost_nusd"
        );
        assert_eq!(
            ledger.extends,
            e.hold_extends.unwrap(),
            "{name}: hold extensions"
        );
    }
    harness.stop().await;
    Observed {
        provider_request: sent,
        events,
        usage,
        finish_reason,
    }
}

/// Run one refusal fixture: the typed 4xx before any hold or provider I/O,
/// on every route that takes a chat request.
async fn refuse(fixture: &Fixture, capabilities: &BTreeMap<String, Value>, at: &str) -> Value {
    let mut last = Value::Null;
    for (path, stream) in [
        ("/v1/chat", true),
        ("/v1/chat", false),
        ("/v1/chat/estimate", true),
    ] {
        let name = format!("{} {at} {path} stream={stream}", fixture.name);
        let harness = Harness::start(fixture, capabilities).await;
        let (status, body) = harness.post(path, &request_text(fixture, stream)).await;
        let error: Value =
            serde_json::from_str(&body).unwrap_or_else(|e| panic!("{name}: {e}: {body}"));
        assert!(status.is_client_error(), "{name}: {status} {body}");
        assert_eq!(harness.ledger.0.lock().unwrap().holds, 0, "{name}: no hold");
        assert_eq!(
            harness.mock.request_count(),
            0,
            "{name}: no provider request"
        );
        if let Some(refusal) = &fixture.expect.refusal {
            assert_eq!(status.as_u16(), refusal.status, "{name}: {body}");
            assert_eq!(error["error"]["code"], refusal.code, "{name}: {body}");
            for (member, want) in &refusal.details {
                assert_eq!(
                    &error["error"]["details"][member], want,
                    "{name}: details.{member}: {body}"
                );
            }
        }
        last = error;
        harness.stop().await;
    }
    last
}

#[test]
fn the_corpus_is_well_formed_and_covers_every_adapter() {
    let corpus = load();
    let mut styles = BTreeSet::new();
    for fixture in corpus
        .fixtures
        .iter()
        .filter(|f| f.expect.refusal.is_none())
    {
        if fixture.expect.provider_stream.is_some() {
            styles.insert((fixture.api_style.clone(), fixture.provider.clone()));
        }
    }
    for want in [
        ("openai_chat", "openai"),
        ("openai_chat", "xai"),
        ("openai_responses", "openai"),
        ("anthropic_messages", "anthropic"),
    ] {
        assert!(
            styles.contains(&(want.0.to_owned(), want.1.to_owned())),
            "no streamed fixture for {want:?}"
        );
    }
    for (feature, _) in conformance_support::FEATURES {
        assert!(
            corpus.fixtures.iter().any(|f| f.feature == feature),
            "feature {feature} has no fixtures"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_success_fixture_conforms_streamed_and_not() {
    let corpus = load();
    let artifact_directory =
        std::env::var_os("F2Z_RELEASED_SDK_RESPONSE_DIR").map(std::path::PathBuf::from);
    if let Some(directory) = artifact_directory.as_ref() {
        if directory.exists() {
            std::fs::remove_dir_all(directory).unwrap();
        }
        std::fs::create_dir_all(directory).unwrap();
    }
    let mut ran = 0;
    let mut tool_replies = 0;
    let mut ordinary_replies = 0;
    let mut catalogues_captured = false;
    for fixture in corpus
        .fixtures
        .iter()
        .filter(|f| f.expect.refusal.is_none())
    {
        if !catalogues_captured {
            capture_catalogues(fixture, artifact_directory.as_deref()).await;
            catalogues_captured = true;
        }
        for stream in [true, false] {
            let observed = run(fixture, stream, artifact_directory.as_deref()).await;
            if !stream {
                if observed
                    .events
                    .to_value()
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["type"] == "tool_call")
                {
                    tool_replies += 1;
                } else {
                    ordinary_replies += 1;
                }
            }
        }
        ran += 1;
    }
    assert!(ran >= 20, "only {ran} success fixtures ran");
    assert!(
        ordinary_replies > 0,
        "no ordinary released-SDK response decodes ran"
    );
    assert!(
        tool_replies > 0,
        "no tool-call released-SDK response decodes ran"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_refusal_fixture_is_refused_before_any_hold_or_provider_io() {
    let corpus = load();
    let mut ran = 0;
    for fixture in corpus
        .fixtures
        .iter()
        .filter(|f| f.expect.refusal.is_some())
    {
        refuse(fixture, &fixture.catalog_model.capabilities, "as written").await;
        ran += 1;
    }
    assert!(ran >= 5, "only {ran} refusal fixtures ran");
}

/// The gating a success fixture relies on is the signed catalogue's: the
/// same request against the same model with one exercised capability
/// withdrawn (`false`) is refused, before any hold or provider request.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn withdrawing_an_exercised_capability_is_refused_before_any_hold() {
    let corpus = load();
    let mut ran = 0;
    for fixture in corpus
        .fixtures
        .iter()
        .filter(|f| f.expect.refusal.is_none())
    {
        for cap in required_capabilities(&fixture.request) {
            let mut capabilities = fixture.catalog_model.capabilities.clone();
            capabilities.insert(cap.to_owned(), json!(false));
            let error = refuse(fixture, &capabilities, &format!("without {cap}")).await;
            assert_eq!(
                error["error"]["code"], "invalid_request",
                "{}: {error}",
                fixture.name
            );
            ran += 1;
        }
    }
    assert!(ran >= 15, "only {ran} withdrawals ran");
}

/// The corpus cannot lie about gating: a success fixture whose request
/// exercises a capability its `catalog_model` does not carry is refused by
/// the runner, whatever the gateway would have done with it.
#[test]
fn a_fixture_that_claims_an_undeclared_capability_is_refused_by_the_runner() {
    let corpus = load();
    let mut checked = 0;
    for fixture in corpus
        .fixtures
        .iter()
        .filter(|f| f.expect.refusal.is_none())
    {
        let path = conformance_support::corpus_dir()
            .join(&fixture.feature)
            .join(format!("{}.json", fixture.name));
        let text = std::fs::read_to_string(path).unwrap();
        for cap in required_capabilities(&fixture.request) {
            for lie in [Value::Null, json!(false)] {
                let mut value: Value = serde_json::from_str(&text).unwrap();
                let caps = value["catalog_model"]["capabilities"]
                    .as_object_mut()
                    .unwrap();
                if lie.is_null() {
                    caps.remove(cap);
                } else {
                    caps.insert(cap.to_owned(), lie);
                }
                let lying: Fixture = serde_json::from_value(value).unwrap();
                let refused = validate(&lying).expect_err(&format!(
                    "{}: claims {cap} without declaring it, and the runner accepted it",
                    fixture.name
                ));
                assert!(refused.contains(cap), "{}: {refused}", fixture.name);
                checked += 1;
            }
        }
        // Negative control: the fixture as written is accepted.
        validate(fixture).unwrap();
    }
    assert!(checked >= 30, "only {checked} lies checked");

    // A feature label is a claim too: a structured_output success fixture
    // must carry structured_output even if someone strips its request down.
    let fixture = corpus
        .fixtures
        .iter()
        .find(|f| f.feature == "structured_output" && f.expect.refusal.is_none())
        .unwrap();
    let path = conformance_support::corpus_dir()
        .join(&fixture.feature)
        .join(format!("{}.json", fixture.name));
    let mut value: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    value["request"]
        .as_object_mut()
        .unwrap()
        .remove("response_format");
    value["catalog_model"]["capabilities"]
        .as_object_mut()
        .unwrap()
        .remove("structured_output");
    let lying: Fixture = serde_json::from_value(value).unwrap();
    assert!(validate(&lying).unwrap_err().contains("structured_output"));
}

/// What a run produced for `target`, when the fixture pins it.
fn target_of<'a>(seen: &'a Observed, fixture: &Fixture, target: Target) -> Option<&'a J> {
    let pinned = fixture.expect.provider_stream.is_some();
    match target {
        Target::ProviderRequest => Some(&seen.provider_request),
        Target::Events if pinned => Some(&seen.events),
        Target::Usage if pinned => Some(&seen.usage),
        Target::FinishReason if pinned => Some(&seen.finish_reason),
        _ => None,
    }
}

/// Whether the runner's comparator for `target` rejects `value`.
fn caught_by_comparator(fixture: &Fixture, target: Target, value: &J) -> bool {
    let e = &fixture.expect;
    match target {
        Target::ProviderRequest => !provider_request_mismatches(
            e.provider_request.as_ref().unwrap(),
            value,
            &fixture.api_style,
        )
        .is_empty(),
        Target::Events => events_mismatch(&expected_events(fixture, true), value).is_some(),
        Target::Usage => !usage_mismatches(e.usage.as_ref().unwrap(), value).is_empty(),
        Target::FinishReason => *value != J::String(e.finish_reason.clone().unwrap()),
    }
}

/// Negative controls in the corpus: each mutation in a feature's
/// `mutations.json`, applied to what the gateway really sent and produced,
/// must be caught. A mutation that touches no fixture is itself a failure —
/// it would be a control that controls nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_mutation_in_the_corpus_is_caught() {
    let corpus = load();
    let mut observed = BTreeMap::new();
    for fixture in corpus
        .fixtures
        .iter()
        .filter(|f| f.expect.refusal.is_none())
    {
        observed.insert(fixture.name.clone(), run(fixture, true, None).await);
    }
    let mut caught = 0;
    for (feature, mutations) in &corpus.mutations {
        for mutation in mutations {
            if mutation.op == Op::Add || mutation.op == Op::Replace {
                assert!(
                    mutation.value.is_some(),
                    "{feature}/{}: needs a value",
                    mutation.name
                );
            }
            let mut applied = Vec::new();
            for fixture in corpus
                .fixtures
                .iter()
                .filter(|f| &f.feature == feature && f.expect.refusal.is_none())
            {
                let explicit = mutation
                    .fixtures
                    .as_ref()
                    .map(|names| names.contains(&fixture.name));
                if explicit == Some(false) {
                    continue;
                }
                let Some(value) = target_of(&observed[&fixture.name], fixture, mutation.target)
                else {
                    assert!(
                        explicit.is_none(),
                        "{feature}/{}: {} pins no {:?}",
                        mutation.name,
                        fixture.name,
                        mutation.target
                    );
                    continue;
                };
                let detect = |m: &J| caught_by_comparator(fixture, mutation.target, m);
                // Sanity: unmutated, the comparator is satisfied.
                assert!(
                    !detect(value),
                    "{}: comparator rejects the real result",
                    fixture.name
                );
                let Some(mutated) = mutate(value, mutation) else {
                    assert!(
                        explicit.is_none(),
                        "{feature}/{}: does not change {}",
                        mutation.name,
                        fixture.name
                    );
                    continue;
                };
                assert!(
                    detect(&mutated),
                    "{feature}/{}: NOT caught on {} — the comparator would pass a gateway \
                     that did this",
                    mutation.name,
                    fixture.name
                );
                applied.push(fixture.name.clone());
                caught += 1;
            }
            assert!(
                !applied.is_empty(),
                "{feature}/{}: applies to no fixture; a control that controls nothing",
                mutation.name
            );
        }
    }
    assert!(caught >= 60, "only {caught} mutations caught");
}

/// Issue #1147's acceptance: a dropped `tool_choice`, `response_format` or
/// `strict` is in the corpus's negative controls, so removing one of those
/// controls is itself a red test.
#[test]
fn the_corpus_controls_dropping_tool_choice_response_format_and_strict() {
    let corpus = load();
    let all: Vec<_> = corpus.mutations.values().flatten().collect();
    for (pointer_suffix, why) in [
        ("/tool_choice", "a dropped tool_choice"),
        ("/response_format", "a dropped response_format"),
        (
            "/response_format/json_schema/strict",
            "a dropped json_schema strict",
        ),
        ("/tools/0/strict", "a dropped tool strict"),
        ("/reasoning_effort", "a dropped reasoning_effort"),
        ("/reasoning", "a dropped Responses reasoning.effort"),
    ] {
        assert!(
            all.iter().any(|m| m.target == Target::ProviderRequest
                && m.op == Op::Remove
                && m.path == pointer_suffix),
            "no mutation controls {why}"
        );
    }
}
