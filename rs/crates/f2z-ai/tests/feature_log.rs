//! The `response` log line of `route=chat` and `route=estimate` names which
//! request features the call asked for — `response_format` and its
//! strictness, the schema's name and size, tool and fallback counts,
//! `max_output_tokens_strict`, `stream` — and the call id once known. Never
//! the schema, a prompt or a tool definition (the 2026-10-05 incident:
//! "did the client send `response_format`?" had no answer after the fact).
//!
//! One test per file: it installs the process-global subscriber.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::io::Write;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use f2z_ai::admission::CallHandle;
use f2z_ai::call::Upstream;
use f2z_ai::catalog::VerifiedCatalog;
use f2z_ai::chat::ChatBackend;
use f2z_ai::config::LogLevel;
use f2z_ai::settle::LogSettler;
use f2z_ai::{ApiFailure, Deps, telemetry};
use f2z_ai_proto::Event;
use f2z_ai_proto::chat::ChatRequest;
use serde_json::{Value, json};
use support::*;
use tracing_subscriber::layer::SubscriberExt as _;

const CANARY: &str = "CANARY7b2ddonotlog";
const CALL_ID: &str = "0199b5a0-0000-7000-8000-00000000c0de";
const REFUSED_ID: &str = "0199b5a0-0000-7000-8000-0000000bad00";

#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// One finished stream with a durable call id.
struct Finished;
#[async_trait]
impl Upstream for Finished {
    fn call_id(&self) -> Option<String> {
        Some(CALL_ID.to_owned())
    }
    async fn next(&mut self) -> Option<Event> {
        None
    }
}

struct Backend;
#[async_trait]
impl ChatBackend for Backend {
    async fn start(
        &self,
        request: ChatRequest,
        _catalog: Arc<VerifiedCatalog>,
        call: &CallHandle,
    ) -> Result<Box<dyn Upstream>, ApiFailure> {
        if request.response_format.is_some() && request.tools.is_empty() {
            // A refusal after the durable claim whose body names no call id
            // (as `Metered`'s response_format_unsupported refusal does).
            call.set_durable_call_id(REFUSED_ID.parse().unwrap());
            return Err(ApiFailure::new(
                f2z_ai_proto::ErrorCode::InvalidRequest,
                "refused after claim",
            ));
        }
        Ok(Box::new(Finished))
    }
}

fn response_lines(log: &str) -> Vec<Value> {
    log.lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v["fields"]["message"] == "response")
        .map(|v| v["fields"].clone())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn response_log_lines_carry_request_features_and_call_id_never_content() {
    let buffer = Buffer::default();
    let writer = buffer.clone();
    let subscriber = tracing_subscriber::registry()
        .with(telemetry::json_layer(LogLevel::Info, move || {
            writer.clone()
        }));
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let deps = Deps {
        gate: support::open_gate(),
        catalog: fixed_catalog(),
        backend: Arc::new(Backend),
        settler: Arc::new(LogSettler),
    };
    let running = start(&config(&[]), deps).await;
    wait_readyz(running.admin, StatusCode::OK).await;

    let schema = json!({"type":"object","additionalProperties":false,
        "properties":{CANARY:{"type":"string","description":CANARY}},"required":[CANARY]});
    let structured = json!({
        "model": "example-large",
        "messages": [{"role": "user", "content": [{"type": "text", "text": CANARY}]}],
        "response_format": {"type": "json_schema", "json_schema":
            {"name": CANARY, "strict": true, "schema": schema}},
        "tools": [{"name": "f", "description": CANARY, "parameters": {"type": "object"}}],
        "fallback": ["example-small"],
        "max_output_tokens": 100, "max_output_tokens_strict": true,
        "metadata": {"lesson": CANARY},
    });
    let response = post_chat(running.public, &structured).await;
    assert_eq!(response.status(), StatusCode::OK);
    let _ = text(response).await;

    let plain = json!({"model": "example-large", "stream": false,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]});
    let estimate = Request::post("/v1/chat/estimate")
        .header("host", "g")
        .header("content-type", "application/json")
        .body(Body::from(plain.to_string()))
        .unwrap();
    let estimated = send(running.public, estimate).await;
    let estimated_status = estimated.status().as_u16();
    let _ = text(estimated).await;

    // A request that never decoded has no features to log.
    let bad = post_chat(running.public, &json!({"model": "m", "messages": 1})).await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let _ = text(bad).await;

    // Refused after the claim, with no call id in the body: still joinable.
    let object = json!({"model": "example-large",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "JSON"}]}],
        "response_format": {"type": "json_object"}});
    let refused_after_claim = post_chat(running.public, &object).await;
    assert_eq!(refused_after_claim.status(), StatusCode::BAD_REQUEST);
    let _ = text(refused_after_claim).await;

    let log = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    assert!(!log.contains(CANARY), "content reached the log:\n{log}");
    let lines = response_lines(&log);
    assert_eq!(lines.len(), 4, "{log}");

    let chat = &lines[0];
    assert_eq!(chat["route"], "chat");
    assert_eq!(chat["status"], 200);
    assert_eq!(chat["call_id"], CALL_ID);
    assert_eq!(chat["response_format"], "json_schema");
    assert_eq!(chat["response_format_strict"], true);
    // Client-chosen text, like metadata: never logged (the CANARY check above).
    assert!(chat.get("response_format_schema_name").is_none(), "{chat}");
    assert_eq!(
        chat["response_format_schema_bytes"],
        serde_json::to_vec(&schema).unwrap().len()
    );
    assert_eq!(chat["tools"], 1);
    assert_eq!(chat["fallback"], 1);
    assert_eq!(chat["max_output_tokens_strict"], true);
    assert_eq!(chat["stream"], true);

    let est = &lines[1];
    assert_eq!(est["route"], "estimate");
    assert_eq!(est["status"], estimated_status);
    assert!(
        est.get("response_format").is_none(),
        "absent is absent: {est}"
    );
    assert!(
        est.get("call_id").is_none(),
        "an estimate has no call: {est}"
    );
    assert_eq!(est["stream"], false);
    assert_eq!(est["tools"], 0);
    assert_eq!(est["response_format_schema_bytes"], 0);

    let refused = &lines[2];
    assert_eq!(refused["route"], "chat");
    assert_eq!(refused["status"], 400);
    assert!(refused.get("stream").is_none(), "{refused}");

    let after_claim = &lines[3];
    assert_eq!(after_claim["status"], 400);
    assert_eq!(after_claim["call_id"], REFUSED_ID);
    assert_eq!(after_claim["response_format"], "json_object");
}
