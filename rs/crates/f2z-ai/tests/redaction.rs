//! A prompt never reaches a log line — at `trace`, the most verbose level an
//! operator can configure, through the production JSON layer.
//!
//! A canary is planted everywhere a client controls: message text, metadata,
//! tool arguments, a mistyped field (whose `serde_json` error would quote
//! it), an unknown role, the URL path, and request headers. The test then
//! asserts the canary appears in no log line and no response body — and, as
//! the positive control, that the log is not simply empty: the lines that
//! *should* be there are.
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
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use f2z_ai::config::LogLevel;
use f2z_ai::settle::LogSettler;
use f2z_ai::{Deps, telemetry};
use serde_json::json;
use support::*;
use tokio::sync::oneshot;
use tracing_subscriber::layer::SubscriberExt as _;

const CANARY: &str = "CANARY-e41d-do-not-log";

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_prompt_reaches_a_log_line_or_an_error_body_at_trace() {
    let buffer = Buffer::default();
    let writer = buffer.clone();
    let subscriber = tracing_subscriber::registry()
        .with(telemetry::json_layer(LogLevel::Trace, move || {
            writer.clone()
        }));
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let (backend, mut streams) = ControlledBackend::new();
    let config = config(&[
        ("F2Z_AI_DRAIN_TIMEOUT_SECS", "1"),
        ("F2Z_AI_ABORT_GRACE_SECS", "1"),
        ("F2Z_AI_LOG_LEVEL", "trace"),
    ]);
    let deps = Deps {
        catalog: fixed_catalog(),
        backend,
        settler: Arc::new(LogSettler),
    };
    let running = start(&config, deps).await;
    let (public, admin) = (running.public, running.admin);
    wait_readyz(admin, StatusCode::OK).await;

    let mut bodies = Vec::new();

    // Every client-controlled place.
    let full = json!({
        "model": "example-large",
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": CANARY}]},
            {"role": "user", "content": [{"type": "text", "text": CANARY}]},
            {"role": "assistant", "content": [], "tool_calls": [
                {"id": "t1", "name": "f", "arguments": CANARY}]},
            {"role": "tool", "tool_call_id": "t1", "content": [{"type": "text", "text": CANARY}]}
        ],
        "metadata": {"lesson": CANARY},
        "tools": [{"name": "f", "description": CANARY, "parameters": {"type": "object"}}]
    });
    let request = Request::post("/v1/chat")
        .header("host", "g")
        .header("content-type", "application/json")
        .header("idempotency-key", CANARY)
        .header("x-debug", CANARY)
        .body(Body::from(full.to_string()))
        .unwrap();
    let mut streamed = send(public, request).await.into_body();
    let stream = streams.recv().await.unwrap();
    stream.send(delta("hello")).await.unwrap();
    assert!(next_frame(&mut streamed).await.unwrap().is_some());

    // Decode errors whose serde_json message would quote the canary.
    for bad in [
        json!({"model": "m", "max_output_tokens": CANARY, "messages": []}),
        json!({"model": "m", "messages": [{"role": CANARY, "content": []}]}),
        json!({"model": "m", "messages": [{"role": "user", "content": [{"type": CANARY}]}]}),
        json!({"model": "m", CANARY: 1, "messages": []}),
    ] {
        let response = post_chat(public, &bad).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        bodies.push(text(response).await);
    }
    let (_, body) = get(public, &format!("/v1/{CANARY}")).await;
    bodies.push(body);
    // An extension method is any token a client likes.
    bodies.push(
        raw(
            public,
            format!("{CANARY} /v1/chat HTTP/1.1\r\nHost: g\r\nContent-Length: 0\r\n\r\n")
                .as_bytes(),
            Duration::from_secs(1),
        )
        .await,
    );

    // A drain that aborts the open stream, so the settler's warn line runs.
    let (signal, fired) = oneshot::channel::<()>();
    let run = tokio::spawn(running.gateway.run_until(async move {
        let _ = fired.await;
    }));
    signal.send(()).unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .unwrap();
    drop(stream);

    let log = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
    // Positive control: this is a real log, at trace, with the lines that
    // must be there.
    for expected in [
        "\"message\":\"response\"",
        "\"message\":\"chat request admitted\"",
        "call aborted by drain",
        "\"message\":\"drain finished\"",
        "\"level\":\"DEBUG\"",
    ] {
        assert!(log.contains(expected), "missing {expected:?} in:\n{log}");
    }
    for line in log.lines() {
        serde_json::from_str::<serde_json::Value>(line)
            .unwrap_or_else(|_| panic!("not one JSON object per line: {line}"));
    }
    assert!(!log.contains(CANARY), "the canary reached the log:\n{log}");
    for body in bodies {
        assert!(!body.contains(CANARY), "the canary came back: {body}");
    }
}
